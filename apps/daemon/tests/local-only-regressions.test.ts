/**
 * Regressions for an install that used cloud features before they were removed:
 * saved prefs, project bindings and legacy tables must keep working locally.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readAppConfig } from '../src/app-config.js';
import { openDatabase } from '../src/db.js';
import { startServer, type StartServerResult } from '../src/server.js';

// Loosely typed on purpose: these assert on the wire shape, not on contracts.
const json = async (response: Response): Promise<any> => response.json();

describe('saved agent preferences', () => {
  it('drops the retired amr agent, its model and its CLI env', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-retired-amr-'));
    try {
      fs.writeFileSync(
        path.join(dataDir, 'app-config.json'),
        JSON.stringify({
          agentId: 'amr',
          agentModels: { amr: { model: 'vela/opus' }, claude: { model: 'sonnet' } },
          agentCliEnv: { amr: { VELA_PROFILE: 'prod' }, claude: { CLAUDE_CONFIG_DIR: '/x' } },
        }),
      );
      const config = await readAppConfig(dataDir);
      expect(config.agentId ?? null).toBeNull();
      expect(config.agentModels).toEqual({ claude: { model: 'sonnet' } });
      expect(config.agentCliEnv).toEqual({ claude: { CLAUDE_CONFIG_DIR: '/x' } });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('legacy workspace tables', () => {
  it('still exist, with rows kept, on every open', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-legacy-schema-'));
    try {
      const first = openDatabase(dataDir, { dataDir });
      const tables = new Set(
        (first.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
          .map((row) => row.name),
      );
      for (const table of [
        'workspace_projects',
        'workspace_resources',
        'team_project_materializations',
        'collab_sync_snapshots',
        'comment_relay_outbox',
        'public_file_publications',
        'public_file_stop_queue',
        'owned_content_sync',
        'amr_terminal_report_outbox',
        'comment_file_retirements',
      ]) {
        expect(tables, table).toContain(table);
      }
      first.close();
      // Idempotent: a second open runs the same additive migrations.
      openDatabase(dataDir, { dataDir }).close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('a project left bound to a team workspace', () => {
  const PROJECT_ID = 'legacy-team-project';
  const PLACEHOLDER_ID = 'legacy-revoked-mirror';
  let baseUrl = '';
  let server: http.Server;
  let shutdown: (() => Promise<void> | void) | undefined;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as StartServerResult;
    baseUrl = started.url;
    server = started.server;
    shutdown = started.shutdown;
    const dataDir = process.env.OD_DATA_DIR;
    expect(dataDir, 'vitest setup must isolate OD_DATA_DIR').toBeTruthy();
    const db = openDatabase(dataDir as string, { dataDir: dataDir as string });
    const now = Date.now();
    const insertProject = db.prepare(
      'INSERT INTO projects (id, name, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    const bind = db.prepare(
      `INSERT INTO workspace_projects (project_id, workspace_id, visibility, resource_state,
         created_by_workspace_member_id, updated_by_workspace_member_id, created_at, updated_at)
       VALUES (?, 'team-1', 'team', ?, ?, ?, ?, ?)`,
    );
    insertProject.run(PROJECT_ID, 'Team project', JSON.stringify({ kind: 'prototype' }), now, now);
    // A member mirror: no local creator, which used to mean permanently read-only.
    bind.run(PROJECT_ID, 'active', null, null, now, now);
    insertProject.run(
      PLACEHOLDER_ID,
      'Revoked mirror',
      JSON.stringify({ kind: 'prototype', teamMirrorRevokedAt: now }),
      now,
      now,
    );
    bind.run(PLACEHOLDER_ID, 'frozen', 'member-2', 'member-2', now, now);
  });

  afterAll(async () => {
    await shutdown?.();
    await new Promise((resolve) => server.close(resolve));
  });

  it('is listed and readable with no workspace identity', async () => {
    const list = await json(await fetch(`${baseUrl}/api/projects`));
    const ids = list.projects.map((project: { id: string }) => project.id);
    expect(ids).toEqual(expect.arrayContaining([PROJECT_ID, PLACEHOLDER_ID]));
    for (const id of [PROJECT_ID, PLACEHOLDER_ID]) {
      const detail = await fetch(`${baseUrl}/api/projects/${id}`);
      expect(detail.status).toBe(200);
      expect((await json(detail)).project.workspaceId).toBeNull();
      expect((await fetch(`${baseUrl}/api/projects/${id}/files`)).status).toBe(200);
    }
  });

  it('accepts writes that a team mirror used to refuse', async () => {
    const write = await fetch(`${baseUrl}/api/projects/${PLACEHOLDER_ID}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'index.html', content: '<h1>local</h1>' }),
    });
    expect(write.status).toBe(200);
    const rename = await fetch(`${baseUrl}/api/projects/${PROJECT_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed locally' }),
    });
    expect(rename.status).toBe(200);
  });

  it('ignores a stale workspace header rather than failing', async () => {
    const response = await fetch(`${baseUrl}/api/projects/${PROJECT_ID}`, {
      headers: { 'x-od-workspace-id': 'some-other-team' },
    });
    expect(response.status).toBe(200);
  });

  it('starts a run: the agent is spawned and nothing refuses it for lack of a workspace', async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-fake-hermes-'));
    const marker = path.join(binDir, 'spawned');
    const previous = { PATH: process.env.PATH, OD_AGENT_HOME: process.env.OD_AGENT_HOME };
    try {
      // A CLI that records its agent spawn, then dies. Failing is fine here: the
      // assertion is that the run got as far as launching the agent.
      fs.writeFileSync(
        path.join(binDir, 'hermes'),
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "hermes 1.0.0"; exit 0; fi\ntouch "${marker}"\nexit 1\n`,
        { mode: 0o755 },
      );
      process.env.OD_AGENT_HOME = binDir;
      process.env.PATH = [binDir, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
      await json(await fetch(`${baseUrl}/api/agents`));

      const conversation = await fetch(`${baseUrl}/api/projects/${PROJECT_ID}/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'local' }),
      });
      expect(conversation.status).toBeLessThan(300);
      const conversationId = (await json(conversation)).conversation.id;

      const created = await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId: 'hermes',
          projectId: PROJECT_ID,
          conversationId,
          assistantMessageId: 'assistant-legacy-binding',
          clientRequestId: 'client-legacy-binding',
          message: 'hello',
          currentPrompt: 'hello',
        }),
      });
      const body = await json(created);
      expect(created.status, JSON.stringify(body)).toBe(202);

      const deadline = Date.now() + 15_000;
      let run: { status: string; errorCode?: string | null } = { status: 'queued' };
      while (Date.now() < deadline && !['failed', 'succeeded', 'canceled'].includes(run.status)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        run = await json(await fetch(`${baseUrl}/api/runs/${body.runId}`));
      }
      expect(fs.existsSync(marker), `run ended ${JSON.stringify(run)}`).toBe(true);
      expect(JSON.stringify(run)).not.toMatch(/WORKSPACE_|AMR_/);

      const listed = await json(await fetch(`${baseUrl}/api/runs?projectId=${PROJECT_ID}`));
      expect(listed.runs.map((item: { id: string }) => item.id)).toContain(body.runId);
    } finally {
      process.env.PATH = previous.PATH;
      if (previous.OD_AGENT_HOME === undefined) delete process.env.OD_AGENT_HOME;
      else process.env.OD_AGENT_HOME = previous.OD_AGENT_HOME;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('no longer offers amr as an agent', async () => {
    const agents = await json(await fetch(`${baseUrl}/api/agents`));
    expect(agents.agents.map((agent: { id: string }) => agent.id)).not.toContain('amr');
  });

  it('keeps the local share routes the web app calls', async () => {
    const social = await fetch(`${baseUrl}/api/social-share`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(social.status).toBe(200);
    const shareProject = await fetch(`${baseUrl}/api/plugins/not-installed/share-project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'publish-github' }),
    });
    expect(shareProject.status).toBe(404);
    expect((await json(shareProject)).error).toBe('plugin not found');
    // A bound project is not refused: it reaches folder validation.
    const shareTask = await fetch(`${baseUrl}/api/projects/${PROJECT_ID}/plugins/share-tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ action: 'publish-github', path: 'no-such-folder' }),
    });
    const shareTaskBody = await shareTask.text();
    expect(shareTask.status, shareTaskBody).toBe(404);
    expect(shareTaskBody).toContain('PLUGIN_FOLDER_NOT_FOUND');
  });

  it('serves no cloud routes', async () => {
    for (const route of [
      '/api/integrations/vela/status',
      '/api/amr/models',
      '/api/diagnostics/amr-terminal-reports',
      `/api/projects/${PROJECT_ID}/workspace-scope`,
      '/api/workspaces/team-1/projects',
    ]) {
      expect((await fetch(`${baseUrl}${route}`)).status, route).toBe(404);
    }
    const health = await json(await fetch(`${baseUrl}/api/health`));
    expect(health.ok).toBe(true);
    expect(health).not.toHaveProperty('amrTerminalReporter');
  });
});
