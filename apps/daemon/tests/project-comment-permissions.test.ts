import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  closeDatabase,
  deletePreviewComment,
  ensureProjectCommentAnchorConversation,
  getProject,
  getProjectPreviewComment,
  listProjectPreviewComments,
  mergeSyncedPreviewComment,
  getConversation,
  getPreviewComment,
  insertConversation,
  insertProject,
  listPreviewComments,
  openDatabase,
  reorderPreviewComment,
  updatePreviewCommentAnchor,
  updatePreviewCommentStatus,
  updateProject,
  upsertPreviewComment,
} from '../src/db.js';
import { registerProjectCommentRoutes } from '../src/routes/project/comments.js';

// Preview-comment mutation routes on the single-user local daemon: the local user
// may change or delete any comment. The one remaining refusal is a POST body edit
// of a comment whose stored author is an external account, which the local user
// did not write. Author fields are never client-supplied.

let server: http.Server | null = null;
let tempDir: string | null = null;

afterEach(async () => {
  if (server) {
    const toClose = server;
    server = null;
    await new Promise<void>((resolve) => toClose.close(() => resolve()));
  }
  closeDatabase();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

const PROJECT = 'p1';
const CONVERSATION = 'conv-1';

async function startServer({
  metadata = { kind: 'prototype' },
  measurement = 'recording',
}: {
  metadata?: Record<string, unknown>;
  measurement?: 'noop' | 'recording' | 'throwing' | 'rejecting' | 'pending';
} = {}) {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-comment-perms-'));
  const db = openDatabase(tempDir);
  insertProject(db, {
    id: PROJECT,
    name: 'Project',
    metadata,
    createdAt: 1,
    updatedAt: 1,
  });
  insertConversation(db, { id: CONVERSATION, projectId: PROJECT, title: 'Chat', createdAt: 1, updatedAt: 1 });

  const productEvents: Array<{
    eventName: string;
    properties: Record<string, unknown>;
  }> = [];

  const app = express();
  app.use(express.json());
  registerProjectCommentRoutes(app, {
    db,
    projectStore: { updateProject } as any,
    conversations: {
      getConversation,
      getProjectPreviewComment,
      listProjectPreviewComments,
      listPreviewComments,
      upsertPreviewComment,
      getPreviewComment,
      updatePreviewCommentStatus,
      updatePreviewCommentAnchor,
      deletePreviewComment,
      reorderPreviewComment,
    } as any,
    telemetry: {
      captureProductEvent: (_req: unknown, eventName: string, properties: Record<string, unknown>) => {
        if (measurement === 'noop') return;
        productEvents.push({ eventName, properties });
        if (measurement === 'throwing') throw new Error('telemetry unavailable');
        if (measurement === 'rejecting') return Promise.reject(new Error('telemetry unavailable'));
        if (measurement === 'pending') return new Promise(() => {});
      },
    } as any,
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  const base = `http://127.0.0.1:${address.port}`;

  async function json(
    route: string,
    options: { method?: string; body?: unknown } = {},
  ) {
    const init: RequestInit = { method: options.method ?? 'GET', headers: {} };
    const headers: Record<string, string> = {};
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    init.headers = headers;
    const response = await fetch(`${base}${route}`, init);
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as any) : {} };
  }

  const commentTarget = {
    filePath: 'index.html',
    elementId: 'hero',
    selector: '[data-od-id="hero"]',
    label: 'h1.hero',
    text: 'Hero',
    htmlHint: '<h1>',
    position: { x: 0, y: 0, width: 0, height: 0 },
  };

  async function createComment(note = 'a note') {
    const res = await json(`/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments`, {
      method: 'POST',
      body: { target: commentTarget, note },
    });
    return res.body.comment as {
      id: string;
      authorMemberId?: string;
      note: string;
      pinSeq?: number;
      sortKey?: number;
    };
  }

  const listComments = () =>
    listPreviewComments(db, PROJECT, CONVERSATION) as Array<{
      id: string;
      authorMemberId?: string;
      note: string;
    }>;

  return {
    db,
    json,
    createComment,
    listComments,
    productEvents,
    commentTarget,
  };
}

describe('preview comment routes on the local daemon', () => {
  it.each(['noop', 'recording', 'throwing', 'rejecting', 'pending'] as const)('keeps successful creation and storage unchanged with %s measurement', async (measurement) => {
    const api = await startServer({ measurement });
    const route = `/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments`;
    const response = await api.json(route, {
      method: 'POST', body: { target: api.commentTarget, note: 'saved note' },
    });
    expect(response.status).toBe(200);
    const comment = response.body.comment;
    expect(comment).toMatchObject({ note: 'saved note', status: 'open' });
    expect(api.listComments()).toEqual([comment]);
    if (measurement !== 'noop') expect(api.productEvents).toEqual([{
      eventName: 'project_comment_create_result',
      properties: expect.objectContaining({ comment_id: comment.id, project_id: PROJECT, result: 'success' }),
    }]);
    const edited = await api.json(route, {
      method: 'POST', body: { id: comment.id, target: api.commentTarget, note: 'edited' },
    });
    expect(edited.status).toBe(200);
    expect(api.productEvents).toHaveLength(measurement === 'noop' ? 0 : 1);
  });

  it('rejects stored external body edits without effects', async () => {
    const api = await startServer();
    const anchor = ensureProjectCommentAnchorConversation(api.db, PROJECT)!.conversationId;
    const route = `/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments`;
    for (const shape of ['user', 'mixed-member', 'missing-kind', 'kind-only']) {
      const id = `external-${shape}`;
      mergeSyncedPreviewComment(api.db, PROJECT, anchor, {
        ...api.commentTarget, id, projectId: PROJECT, conversationId: 'remote',
        memberId: '', seq: 1, note: 'original external note', status: 'open',
        authorKind: 'user', authorAppUserId: 'external-account', createdAt: 10, updatedAt: 10,
      });
      // Historical incomplete/mixed identities cannot be produced by the modern
      // merger; retain them verbatim as fixtures, never repair them on rejection.
      if (shape === 'mixed-member') api.db.prepare('UPDATE preview_comments SET author_member_id = ? WHERE id = ?').run('m-local', id);
      if (shape === 'missing-kind') api.db.prepare('UPDATE preview_comments SET author_kind = NULL WHERE id = ?').run(id);
      if (shape === 'kind-only') api.db.prepare('UPDATE preview_comments SET author_app_user_id = NULL WHERE id = ?').run(id);
      const before = api.db.prepare('SELECT * FROM preview_comments WHERE id = ?').get(id);
      const projectBefore = getProject(api.db, PROJECT);
      const rejected = await api.json(route, {
        method: 'POST',
        body: { id, target: api.commentTarget, note: 'stolen edit',
          authorKind: 'member', authorMemberId: 'm-local', authorAppUserId: '', authorDisplayName: 'spoofed' },
      });
      expect(rejected.status).toBe(403);
      expect(api.db.prepare('SELECT * FROM preview_comments WHERE id = ?').get(id)).toEqual(before);
      expect(getProject(api.db, PROJECT)).toEqual(projectBefore);
      expect(api.productEvents).toEqual([]);
    }
    // Editing the body is not handling: the status endpoint remains usable.
    expect((await api.json(route)).body.comments).toHaveLength(4);
    const handled = await api.json(`${route}/external-user`, {
      method: 'PATCH', body: { status: 'attached' },
    });
    expect(handled.status).toBe(200);
    expect(handled.body.comment.note).toBe('original external note');
    expect(handled.body.comment.authorKind).toBe('user');
  });

  it('preserves the existing authorless POST compatibility branch', async () => {
    const api = await startServer();
    const legacy = upsertPreviewComment(api.db, PROJECT, CONVERSATION, { target: api.commentTarget, note: 'legacy' });
    const edited = await api.json(`/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments`, {
      method: 'POST', body: { id: legacy!.id, target: api.commentTarget, note: 'legacy edited' },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.comment).toMatchObject({ note: 'legacy edited' });
    expect(edited.body.comment).not.toHaveProperty('authorMemberId');
  });

  it('reads and handling include only the current conversation plus the internal project anchor', async () => {
    const api = await startServer();
    const own = await api.createComment('current note');
    insertConversation(api.db, { id: 'private-other', projectId: PROJECT, title: 'Other', createdAt: 2, updatedAt: 2 });
    const hidden = upsertPreviewComment(api.db, PROJECT, 'private-other', {
      target: api.commentTarget, note: 'other conversation note',
    });
    const route = `/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments`;
    expect((await api.json(route)).body.comments.map((c: { id: string }) => c.id)).toEqual([own.id]);
    const anchor = ensureProjectCommentAnchorConversation(api.db, PROJECT)!.conversationId;
    mergeSyncedPreviewComment(api.db, PROJECT, anchor, {
      ...api.commentTarget, id: 'external-user', projectId: PROJECT, conversationId: 'remote',
      memberId: '', seq: 1, note: 'shared incoming note', status: 'open',
      authorKind: 'user', authorAppUserId: 'account-external', createdAt: 10, updatedAt: 10,
    });
    insertProject(api.db, { id: 'other-project', name: 'Other', createdAt: 1, updatedAt: 1 });
    const foreignAnchor = ensureProjectCommentAnchorConversation(api.db, 'other-project')!.conversationId;
    upsertPreviewComment(api.db, 'other-project', foreignAnchor, { target: api.commentTarget, note: 'foreign anchor' });
    const listed = await api.json(route);
    expect(listed.status).toBe(200);
    expect(listed.body.comments.map((c: { id: string }) => c.id).sort()).toEqual([own.id, 'external-user'].sort());
    const handled = await api.json(`${route}/external-user`, { method: 'PATCH', body: { status: 'attached' } });
    expect(handled.status).toBe(200);
    expect(getPreviewComment(api.db, PROJECT, anchor, 'external-user')).toMatchObject({ status: 'attached', conversationId: anchor });
    expect((await api.json(`${route}/${hidden!.id}`, { method: 'PATCH', body: { status: 'attached' } })).status).toBe(404);
    expect((await api.json(`/api/projects/${PROJECT}/conversations/${anchor}/comments`)).status).toBe(404);
  });

  it('records one create event per new comment and does not count edits', async () => {
    const api = await startServer();
    const first = await api.createComment('first note');
    const second = await api.createComment('second note');

    const createEvent = {
      eventName: 'project_comment_create_result',
      properties: expect.objectContaining({
        result: 'success',
        target_project_relation: 'self',
        comment_level: 'top_level',
        project_id: PROJECT,
        project_kind: 'prototype',
      }),
    };
    expect(api.productEvents).toEqual([createEvent, createEvent]);

    const edit = await api.json(
      `/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments`,
      {
        method: 'POST',
        body: { id: second.id, target: api.commentTarget, note: 'edited note' },
      },
    );
    expect(edit.status).toBe(200);
    expect(first.id).not.toBe(second.id);
    expect(api.productEvents).toHaveLength(2);
  });

  it('uses the canonical prototype kind for a legacy project without metadata.kind', async () => {
    const api = await startServer({ metadata: {} });

    await api.createComment('legacy project note');

    expect(api.productEvents).toEqual([
      {
        eventName: 'project_comment_create_result',
        properties: expect.objectContaining({
          project_id: PROJECT,
          project_kind: 'prototype',
        }),
      },
    ]);
  });

  it('deletes an authorless legacy comment', async () => {
    const api = await startServer();
    const legacy = upsertPreviewComment(
      api.db,
      PROJECT,
      CONVERSATION,
      { target: api.commentTarget, note: 'legacy note' },
    );
    expect(legacy?.authorMemberId).toBeUndefined();

    const deleted = await api.json(
      `/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments/${legacy!.id}`,
      { method: 'DELETE' },
    );
    expect(deleted.status).toBe(200);
    expect(api.listComments()).toHaveLength(0);
  });

  it('a comment carrying a historical member author is editable, changeable and deletable', async () => {
    const api = await startServer();
    const authored = upsertPreviewComment(api.db, PROJECT, CONVERSATION, {
      target: api.commentTarget, note: 'older build note', authorMemberId: 'm-history',
    });
    const route = `/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments`;

    const edit = await api.json(route, {
      method: 'POST',
      body: { id: authored!.id, target: api.commentTarget, note: 'local edit' },
    });
    expect(edit.status).toBe(200);
    // The stored author is history: the edit keeps it rather than claiming it.
    expect(edit.body.comment).toMatchObject({ note: 'local edit', authorMemberId: 'm-history' });

    const patch = await api.json(`${route}/${authored!.id}`, {
      method: 'PATCH', body: { status: 'applying' },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.comment.status).toBe('applying');

    const del = await api.json(`${route}/${authored!.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(api.listComments()).toHaveLength(0);
  });

  it('ignores spoofed request authors on create and edit', async () => {
    const api = await startServer();
    const route = `/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments`;
    const created = await api.json(route, {
      method: 'POST',
      body: {
        target: api.commentTarget,
        note: 'trusted note',
        authorMemberId: 'm-spoofed',
        authorKind: 'user',
        authorAppUserId: 'app-spoofed',
        authorDisplayName: 'Spoofed',
        authorKey: 'd'.repeat(64),
      },
    });
    expect(created.status).toBe(200);
    expect(created.body.comment).not.toHaveProperty('authorMemberId');
    expect(created.body.comment).not.toHaveProperty('authorKind');
    expect(created.body.comment).not.toHaveProperty('authorAppUserId');
    expect(created.body.comment).not.toHaveProperty('authorDisplayName');
    expect(created.body.comment).not.toHaveProperty('authorKey');

    const edited = await api.json(route, {
      method: 'POST',
      body: {
        id: created.body.comment.id,
        target: api.commentTarget,
        note: 'trusted edit',
        authorMemberId: 'm-spoofed-edit',
        authorKind: 'user',
        authorAppUserId: 'app-spoofed-edit',
        authorDisplayName: 'Spoofed edit',
        authorKey: 'e'.repeat(64),
      },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.comment).toMatchObject({ note: 'trusted edit' });
    expect(edited.body.comment).not.toHaveProperty('authorMemberId');
    expect(edited.body.comment).not.toHaveProperty('authorKind');
    expect(edited.body.comment).not.toHaveProperty('authorAppUserId');
    expect(edited.body.comment).not.toHaveProperty('authorDisplayName');
    expect(edited.body.comment).not.toHaveProperty('authorKey');
  });

  it('POST creates another row unless an existing id is sent', async () => {
    const api = await startServer();
    const first = await api.createComment('first note');
    const second = await api.createComment('second note');

    expect(second.id).not.toBe(first.id);
    expect(api.listComments()).toHaveLength(2);

    const edit = await api.json(
      `/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments`,
      {
        method: 'POST',
        body: { id: first.id, target: api.commentTarget, note: 'edited first' },
      },
    );

    expect(edit.status).toBe(200);
    expect(edit.body.comment.id).toBe(first.id);
    expect(api.listComments()).toHaveLength(2);
    expect(api.listComments().find((c) => c.id === first.id)?.note).toBe('edited first');
    expect(api.listComments().find((c) => c.id === second.id)?.note).toBe('second note');
  });

  it('POST with an unknown id is treated as a missing edit target', async () => {
    const api = await startServer();
    const edit = await api.json(
      `/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments`,
      {
        method: 'POST',
        body: { id: 'missing-comment', target: api.commentTarget, note: 'edit nothing' },
      },
    );

    expect(edit.status).toBe(404);
    expect(api.listComments()).toHaveLength(0);
  });

  // —— reorder (sidebar sort_key) — recvq5BVsolIxi Phase 2 ————————————————————

  it('reorder updates the display order of a comment', async () => {
    const api = await startServer();
    const comment = await api.createComment();

    const patch = await api.json(
      `/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments/${comment.id}/reorder`,
      { method: 'PATCH', body: { sortKey: 42 } },
    );
    expect(patch.status).toBe(200);
    expect(patch.body.comment.sortKey).toBe(42);
  });

  it('reorder writes only sort_key — pin_seq stays exactly what creation assigned', async () => {
    const api = await startServer();
    const first = await api.createComment('first');
    const second = await api.createComment('second');
    expect(first.pinSeq).toBe(1);
    expect(second.pinSeq).toBe(2);

    const patch = await api.json(
      `/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments/${first.id}/reorder`,
      { method: 'PATCH', body: { sortKey: 99 } },
    );
    expect(patch.status).toBe(200);
    expect(patch.body.comment.sortKey).toBe(99);
    expect(patch.body.comment.pinSeq).toBe(1);
    // The untouched sibling is unaffected.
    const rows = api.listComments() as unknown as Array<{ id: string; pinSeq?: number; sortKey?: number }>;
    expect(rows.find((c) => c.id === second.id)?.pinSeq).toBe(2);
  });

  it('reorder rejects a non-finite sortKey and 404s for an unknown comment', async () => {
    const api = await startServer();
    const comment = await api.createComment();

    const bad = await api.json(
      `/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments/${comment.id}/reorder`,
      { method: 'PATCH', body: { sortKey: 'not-a-number' } },
    );
    expect(bad.status).toBe(400);

    const missing = await api.json(
      `/api/projects/${PROJECT}/conversations/${CONVERSATION}/comments/missing-comment/reorder`,
      { method: 'PATCH', body: { sortKey: 1 } },
    );
    expect(missing.status).toBe(404);
  });
});
