import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureWorkspaceArtifactForPath,
  renameWorkspaceArtifactPath,
} from '../src/chat-artifacts/store.js';
import {
  closeDatabase,
  insertConversation,
  insertProject,
  listPreviewComments,
  openDatabase,
  renamePreviewCommentFilePath,
  upsertPreviewComment,
} from '../src/db.js';

let tempDir: string | null = null;

afterEach(() => {
  closeDatabase();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function seededDb() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-comment-rename-'));
  const db = openDatabase(tempDir);
  const now = Date.now();
  insertProject(db, { id: 'project-1', name: 'Rename fixture', createdAt: now, updatedAt: now });
  insertConversation(db, { id: 'conversation-1', projectId: 'project-1', title: 'Chat', createdAt: now, updatedAt: now });
  return db;
}

function target(filePath: string, elementId: string) {
  return {
    filePath,
    elementId,
    selector: `[data-od-id="${elementId}"]`,
    label: 'h1',
    text: 'Hero',
    htmlHint: '<h1>',
    position: { x: 0, y: 0, width: 10, height: 10 },
  };
}

describe('preview comments follow a file rename', () => {
  it('keeps a comment bound to the file identity visible after the file moves', () => {
    const db = seededDb();
    const artifact = ensureWorkspaceArtifactForPath(db, { projectId: 'project-1', path: 'index.html', kind: 'html' });
    const saved = upsertPreviewComment(db, 'project-1', 'conversation-1', {
      target: target('index.html', 'hero'),
      note: 'Bound to the file',
      sourceFileId: artifact.id,
    });
    if (!saved) throw new Error('comment upsert failed');
    expect(listPreviewComments(db, 'project-1', 'conversation-1')).toHaveLength(1);

    db.transaction(() => {
      renameWorkspaceArtifactPath(db, 'project-1', 'index.html', 'pages/home.html');
      renamePreviewCommentFilePath(db, 'project-1', 'index.html', 'pages/home.html');
    })();

    const listed = listPreviewComments(db, 'project-1', 'conversation-1');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(saved.id);
    expect(listed[0]?.filePath).toBe('pages/home.html');
    expect(listed[0]?.sourceFileId).toBe(artifact.id);
  });

  it('moves every comment under a renamed folder and leaves sibling folders alone', () => {
    const db = seededDb();
    upsertPreviewComment(db, 'project-1', 'conversation-1', { target: target('pages/a.html', 'a'), note: 'A' });
    upsertPreviewComment(db, 'project-1', 'conversation-1', { target: target('pages/deep/b.html', 'b'), note: 'B' });
    upsertPreviewComment(db, 'project-1', 'conversation-1', { target: target('pages-old/c.html', 'c'), note: 'C' });

    expect(renamePreviewCommentFilePath(db, 'project-1', 'pages', 'site')).toBe(2);

    const byNote = new Map(listPreviewComments(db, 'project-1', 'conversation-1').map((c) => [c.note, c.filePath]));
    expect(byNote.get('A')).toBe('site/a.html');
    expect(byNote.get('B')).toBe('site/deep/b.html');
    expect(byNote.get('C')).toBe('pages-old/c.html');
  });
});
