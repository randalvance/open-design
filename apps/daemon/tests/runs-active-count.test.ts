// `GET /api/runs/active-count` is the desktop updater's restart-safety probe.
//
// A host-level caller only needs "is anything still running?". The count route
// answers exactly that: it is loopback-only and never names a run, project or
// conversation.

import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  insertProject,
  openDatabase,
} from '../src/db.js';
import { registerRunRoutes } from '../src/routes/runs.js';
import { connectorService } from '../src/connectors/service.js';

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

const FIRST_PROJECT = 'p-first-active-count';
const SECOND_PROJECT = 'p-second-active-count';
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

function sendApiError(
  res: any,
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return res.status(status).json({ error: { code, message, ...details } });
}

async function startServer() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-runs-active-count-'));
  const db = openDatabase(tempDir);
  const now = Date.now();
  for (const id of [FIRST_PROJECT, SECOND_PROJECT]) {
    insertProject(db, { id, name: id, createdAt: now, updatedAt: now });
  }

  const runs = new Map<string, any>();
  const seed = (id: string, projectId: string, agentId: string, status: string) =>
    runs.set(id, { id, projectId, agentId, status, conversationId: `conv-${id}`, events: [], clients: new Set() });
  seed('run-first-hermes-running', FIRST_PROJECT, 'hermes', 'running');
  seed('run-second-queued', SECOND_PROJECT, 'claude', 'queued');
  seed('run-second-done', SECOND_PROJECT, 'claude', 'succeeded');

  const runsService = {
    get: (id: string) => runs.get(id) ?? null,
    list: (filters: { projectId?: unknown; status?: unknown } = {}) =>
      Array.from(runs.values()).filter(
        (run) =>
          (typeof filters.projectId !== 'string' || run.projectId === filters.projectId)
          && (filters.status !== 'active' || !TERMINAL.has(run.status)),
      ),
    statusBody: (run: any) => ({ ...run }),
    isTerminal: (status: string) => TERMINAL.has(status),
  };

  const app = express();
  app.use(express.json());
  registerRunRoutes(app, {
    db,
    design: {
      runs: runsService,
      analytics: { capture: () => {} },
      getAppVersion: () => 'test',
    },
    http: {
      createSseResponse: () => ({ send() {}, end() {}, cleanup() {} }),
      sendApiError,
    },
    paths: { PROJECTS_DIR: tempDir, RUNTIME_DATA_DIR: tempDir },
    agents: { detectAgents: async () => [], getAgentDef: () => null },
    chat: { startChatRun: async () => undefined },
    byokCredentials: { has: async () => false },
    lifecycle: { isDaemonShuttingDown: () => false },
    plugins: {
      connectorService,
      detectSkillPluginCandidateOnRunSuccess: () => {},
      firePipelineForRun: () => {},
      loadPluginRegistryView: async () => ({} as any),
      renderPluginBriefTemplate: (template: string) => template,
    },
    telemetry: {
      reportRunCompletionTelemetryFallback: () => {},
      resolveRunProjectKindForAnalytics: () => null,
      runArtifactBaselines: { take: () => undefined },
      runRetryEventsForAnalytics: () => [],
    },
    messages: {
      pinAssistantMessageOnRunCreate: () => ({ ok: true }),
      reconcileAssistantMessageOnRunEnd: () => {},
    },
  } as any);
  const created = http.createServer(app);
  server = created;
  await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve));
  const address = created.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, port };
}

// `fetch` cannot override Host, so spoofed-authority cases go through
// `http.request`, which sends the header verbatim.
function rawGet(port: number, pathname: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('GET /api/runs/active-count', () => {
  it('counts active runs across projects', async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(`${baseUrl}/api/runs/active-count`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ activeRunCount: 2 });
  });

  it('reveals no run, project or conversation identifiers', async () => {
    const { baseUrl } = await startServer();
    const text = await (await fetch(`${baseUrl}/api/runs/active-count`)).text();
    for (const leaked of ['run-', FIRST_PROJECT, SECOND_PROJECT, 'conv-', 'hermes']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('refuses a non-loopback Host (DNS rebinding) or a foreign Origin', async () => {
    const { port } = await startServer();

    const rebound = await rawGet(port, '/api/runs/active-count', { host: `attacker.example:${port}` });
    expect(rebound.status).toBe(403);
    expect(rebound.body).not.toContain('activeRunCount');

    const crossOrigin = await rawGet(port, '/api/runs/active-count', {
      host: `127.0.0.1:${port}`,
      origin: 'https://attacker.example',
    });
    expect(crossOrigin.status).toBe(403);

    const local = await rawGet(port, '/api/runs/active-count', {
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
    });
    expect(local.status).toBe(200);
    expect(JSON.parse(local.body)).toEqual({ activeRunCount: 2 });
  });
});
