import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppPath: () => '/app', getPath: () => '/user-data' },
}));

import {
  PACKAGED_CONFIG_PATH_ENV,
  PACKAGED_NAMESPACE_BASE_ROOT_ENV,
  readPackagedConfig,
  resolvePackagedNamespaceBaseRoot,
} from '../src/config.js';

describe('resolvePackagedNamespaceBaseRoot', () => {
  it('lets a historical handoff preserve the already-resolved namespace base root', () => {
    const inheritedRoot = join('C:', 'tools-pack', 'runtime', 'namespaces');
    const bakedRoot = join('C:', 'Users', 'Nexu', 'AppData', 'Roaming', 'Open Design', 'namespaces');

    expect(resolvePackagedNamespaceBaseRoot(bakedRoot, join('C:', 'fallback'), {
      [PACKAGED_NAMESPACE_BASE_ROOT_ENV]: inheritedRoot,
    })).toBe(resolve(inheritedRoot));
  });

  it('falls back to the payload config and then Electron userData', () => {
    const bakedRoot = join('C:', 'packaged', 'namespaces');
    const userDataRoot = join('C:', 'user-data');

    expect(resolvePackagedNamespaceBaseRoot(bakedRoot, userDataRoot, {})).toBe(resolve(bakedRoot));
    expect(resolvePackagedNamespaceBaseRoot(undefined, userDataRoot, {})).toBe(
      join(userDataRoot, 'namespaces'),
    );
  });
});

describe('readPackagedConfig', () => {
  it('still loads a config file that carries retired keys, and ignores them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'od-packaged-legacy-config-'));
    const configPath = join(root, 'open-design-config.json');
    const savedResourcesPath = process.resourcesPath;
    vi.stubEnv(PACKAGED_CONFIG_PATH_ENV, configPath);
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: root });
    try {
      await writeFile(configPath, JSON.stringify({
        amrProfile: 'not-a-known-profile',
        appVersion: '1.2.3',
        namespace: 'legacy',
        posthogHost: 'https://ingest.example',
        posthogKey: 'legacy-key',
        telemetryRelayUrl: 'https://relay.example/v1',
        updateMetadataUrl: 'https://updates.example/latest.json',
        velaWebUrl: 'https://vela.example',
        velaWebUrls: { prod: 'https://vela.example' },
      }));

      const config = await readPackagedConfig();

      expect(config).toMatchObject({
        appVersion: '1.2.3',
        namespace: 'legacy',
        updateMetadataUrl: 'https://updates.example/latest.json',
      });
      expect(config).not.toHaveProperty('telemetryRelayUrl');
      expect(config).not.toHaveProperty('posthogKey');
      expect(config).not.toHaveProperty('posthogHost');
      expect(config).not.toHaveProperty('amrProfile');
      expect(config).not.toHaveProperty('velaWebUrl');
      expect(config).not.toHaveProperty('velaWebUrls');
    } finally {
      vi.unstubAllEnvs();
      Object.defineProperty(process, 'resourcesPath', { configurable: true, value: savedResourcesPath });
      await rm(root, { force: true, recursive: true });
    }
  });
});
