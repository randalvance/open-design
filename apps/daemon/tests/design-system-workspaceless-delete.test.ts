import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

type StartedServer = {
  url: string;
  server: Server;
  shutdown?: () => Promise<void> | void;
};

const originalDataDir = process.env.OD_DATA_DIR;
let dataDir: string | null = null;
let started: StartedServer | null = null;

afterEach(async () => {
  const current = started;
  started = null;
  if (current) {
    await Promise.resolve(current.shutdown?.());
    current.server.closeAllConnections?.();
    current.server.closeIdleConnections?.();
    if (current.server.listening) {
      await new Promise<void>((resolve) => current.server.close(() => resolve()));
    }
  }
  const { closeDatabase } = await import('../src/db.js');
  closeDatabase();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  dataDir = null;
  if (originalDataDir === undefined) delete process.env.OD_DATA_DIR;
  else process.env.OD_DATA_DIR = originalDataDir;
  vi.resetModules();
}, 30_000);

it('deletes a user design system without any workspace identity', async () => {
  // Given a local daemon with a user-created design system
  dataDir = await mkdtemp(join(tmpdir(), 'od-design-system-workspaceless-delete-'));
  process.env.OD_DATA_DIR = dataDir;
  vi.resetModules();
  const { startServer } = await import('../src/server.js');
  started = await startServer({ port: 0, returnServer: true }) as StartedServer;

  const createResponse = await fetch(`${started.url}/api/design-systems`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Workspace-less Delete' }),
  });
  expect(createResponse.status).toBe(201);
  const created = await createResponse.json() as {
    designSystem: { id: string };
  };
  const designSystemUrl = `${started.url}/api/design-systems/${encodeURIComponent(created.designSystem.id)}`;

  const getResponse = await fetch(designSystemUrl);
  expect(getResponse.status).toBe(200);
  await expect(getResponse.json()).resolves.toMatchObject({ canMutate: true });

  // When the mutable design system is deleted without workspace headers
  const deleteResponse = await fetch(designSystemUrl, { method: 'DELETE' });
  const deleteBody: unknown = deleteResponse.status === 204
    ? null
    : await deleteResponse.json();

  // Then the local delete proceeds without any workspace context
  expect({ status: deleteResponse.status, body: deleteBody }).toEqual({
    status: 204,
    body: null,
  });
}, 60_000);
