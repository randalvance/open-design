import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import {
  resolveLocalPluginBySource,
  resolvePluginFolder,
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
  it('returns the installed record only when its source matches the one the caller saw', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-local-plugin-source-'));
    roots.push(root);
    const dataDir = path.join(root, 'data');
    const pluginsRoot = path.join(dataDir, 'plugins');
    const db = openDatabase(root, { dataDir });

    const folder = path.join(root, 'personal-plugin');
    await pluginManifest(folder, 'Personal copy');
    const personal = await resolvePluginFolder({
      folder,
      folderId: 'shared-id',
      sourceKind: 'local',
      source: 'local:personal:shared-id',
    });
    if (!personal.ok) throw new Error(personal.errors.join('; '));
    upsertInstalledPlugin(db, personal.record);

    await expect(resolveLocalPluginBySource({
      db,
      id: 'shared-id',
      source: 'local:personal:shared-id',
      userPluginsRoot: pluginsRoot,
    })).resolves.toMatchObject({ title: 'Personal copy' });
    await expect(resolveLocalPluginBySource({
      db,
      id: 'shared-id',
      source: 'local:other:shared-id',
      userPluginsRoot: pluginsRoot,
    })).resolves.toBeNull();
    await expect(resolveLocalPluginBySource({
      db,
      id: 'missing-id',
      source: 'local:personal:missing-id',
      userPluginsRoot: pluginsRoot,
    })).resolves.toBeNull();
  });
});
