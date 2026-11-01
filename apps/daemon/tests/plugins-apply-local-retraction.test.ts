import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerPluginRoutes } from '../src/routes/plugins/index.js';

const servers: Array<ReturnType<express.Express['listen']>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })),
  );
});

describe('local plugin apply retraction gate', () => {

  it('applies a selected local record', async () => {
    const app = express();
    app.use(express.json());
    const loadPluginRegistryView = vi.fn(async () => ({}));
    const applyPlugin = vi.fn((input: { plugin: { source?: string } }) => ({
      result: {
        query: input.plugin.source,
        capabilitiesGranted: [],
        appliedPlugin: { capabilitiesGranted: [] },
      },
      warnings: [],
      manifestSourceDigest: 'local-digest',
    }));
    const middleware: express.RequestHandler = (_req, _res, next) => next();

    registerPluginRoutes(app, {
      db: {
        prepare: () => ({ all: () => [], get: () => null, run: () => undefined }),
        transaction: (run: () => unknown) => () => run(),
      },
      paths: { PROJECTS_DIR: '', PLUGIN_REGISTRY_ROOTS: [], PLUGIN_LOCKFILE_PATH: '' },
      ids: { randomId: () => 'unused' },
      projectStore: {},
      conversations: {},
      plugins: {
        getInstalledPlugin: () => null,
        getLocalPluginBySource: async (_db: unknown, id: string, source: string) => ({ id, source }),
        listInstalledPlugins: () => [],
        applyPlugin,
        MissingInputError: class MissingInputError extends Error { fields: string[] = []; },
      },
      helpers: {
        requireLocalDaemonRequest: middleware,
        pluginUpload: { single: () => middleware, array: () => middleware },
        loadPluginRegistryView,
        buildConnectorProbe: () => ({}),
        connectorService: {},
        sendApiError: (res: express.Response, status: number, code: string, message: string) =>
          res.status(status).json({ error: { code, message } }),
      },
    } as unknown as Parameters<typeof registerPluginRoutes>[1]);

    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/plugins/shared-id/apply-local`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: '/plugins/shared-id' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ query: '/plugins/shared-id' });
    expect(loadPluginRegistryView).toHaveBeenCalledTimes(1);
    expect(applyPlugin).toHaveBeenCalledTimes(1);
  });

  it('does not apply an exact local source retired while registry loading is pending', async () => {
    const app = express();
    app.use(express.json());
    let bindingLive = true;
    let finishRegistryLoad!: (value: Record<string, never>) => void;
    const registryGate = new Promise<Record<string, never>>((resolve) => {
      finishRegistryLoad = resolve;
    });
    let registryLoadStarted!: () => void;
    const registryStarted = new Promise<void>((resolve) => {
      registryLoadStarted = resolve;
    });
    const applyPlugin = vi.fn(() => ({
      result: { capabilitiesGranted: [], appliedPlugin: { capabilitiesGranted: [] } },
      warnings: [],
    }));
    const getLocalPluginBySource = vi.fn(async (_db: unknown, id: string, source: string) =>
      bindingLive ? { id, source } : null,
    );
    const middleware: express.RequestHandler = (_req, _res, next) => next();

    registerPluginRoutes(app, {
      db: {
        prepare: () => ({ all: () => [], get: () => null, run: () => undefined }),
        transaction: (run: () => unknown) => () => run(),
      },
      paths: { PROJECTS_DIR: '', PLUGIN_REGISTRY_ROOTS: [], PLUGIN_LOCKFILE_PATH: '' },
      ids: { randomId: () => 'unused' },
      projectStore: {},
      conversations: {},
      plugins: {
        getInstalledPlugin: () => null,
        getLocalPluginBySource,
        listInstalledPlugins: () => [],
        applyPlugin,
        MissingInputError: class MissingInputError extends Error { fields: string[] = []; },
      },
      helpers: {
        requireLocalDaemonRequest: middleware,
        pluginUpload: { single: () => middleware, array: () => middleware },
        loadPluginRegistryView: async () => {
          registryLoadStarted();
          return registryGate;
        },
        buildConnectorProbe: () => ({}),
        connectorService: {},
        sendApiError: (res: express.Response, status: number, code: string, message: string) =>
          res.status(status).json({ error: { code, message } }),
      },
    } as unknown as Parameters<typeof registerPluginRoutes>[1]);

    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const responsePromise = fetch(`http://127.0.0.1:${port}/api/plugins/shared-id/apply-local`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: '/plugins/shared-id' }),
    });
    await registryStarted;
    bindingLive = false;
    finishRegistryLoad({});

    const response = await responsePromise;
    expect(response.status).toBe(404);
    expect(getLocalPluginBySource).toHaveBeenCalledTimes(2);
    expect(applyPlugin).not.toHaveBeenCalled();
  });

});
