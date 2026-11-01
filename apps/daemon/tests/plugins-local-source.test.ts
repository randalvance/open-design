import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import {
  resolveLocalPluginBySource,
  resolvePluginFolder,
  resolvePluginSnapshot,
  upsertInstalledPlugin,
} from '../src/plugins/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

async function pluginManifest(folder: string, title: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, 'open-design.json'),
    JSON.stringify({ name: 'shared-id', title, version: '1.0.0' }),
  );
}

describe('resolveLocalPluginBySource', () => {
  it('selects the installed record only for its exact source and snapshots it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-local-plugin-source-'));
    roots.push(root);
    const db = openDatabase(root, { dataDir: path.join(root, 'data') });

    const folder = path.join(root, 'local-plugin');
    await pluginManifest(folder, 'Local copy');
    const resolved = await resolvePluginFolder({
      folder,
      folderId: 'shared-id',
      sourceKind: 'local',
      source: 'local:personal:shared-id',
    });
    if (!resolved.ok) throw new Error(resolved.errors.join('; '));
    upsertInstalledPlugin(db, resolved.record);

    const exact = await resolveLocalPluginBySource({
      db,
      id: 'shared-id',
      source: 'local:personal:shared-id',
    });
    expect(exact).toMatchObject({ id: 'shared-id', title: 'Local copy' });

    await expect(resolveLocalPluginBySource({
      db,
      id: 'shared-id',
      source: 'local:other:shared-id',
    })).resolves.toBeNull();

    db.prepare(`
      INSERT INTO projects (id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run('local-project', 'Local project', 1, 1);
    const snapshot = resolvePluginSnapshot({
      db,
      body: { pluginId: 'shared-id' },
      projectId: 'local-project',
      registry: { skills: [], designSystems: [], craft: [], atoms: [] },
      plugin: exact ?? undefined,
    });
    expect(snapshot?.ok).toBe(true);
    if (snapshot?.ok) expect(snapshot.snapshot.pluginTitle).toBe('Local copy');
  });

  it('returns null for an id that was never installed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-local-plugin-source-'));
    roots.push(root);
    const db = openDatabase(root, { dataDir: path.join(root, 'data') });

    await expect(resolveLocalPluginBySource({
      db,
      id: 'shared-id',
      source: 'local:personal:shared-id',
    })).resolves.toBeNull();
  });
});
