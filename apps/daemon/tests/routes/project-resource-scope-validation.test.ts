import type http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerProjectRoutes } from '../../src/routes/project/index.js';

const PROJECT_ID = 'project-scope-target';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

function noop() {}

function functionProxy(overrides: Record<string, unknown> = {}) {
  return new Proxy(overrides, {
    get(target, property) {
      return property in target ? target[property as string] : noop;
    },
  });
}

function buildDeps(input: {
  validateDesignSystem?: ReturnType<typeof vi.fn>;
  validateSkill?: ReturnType<typeof vi.fn>;
  getPlugin?: ReturnType<typeof vi.fn>;
  getLocalPluginBySource?: ReturnType<typeof vi.fn>;
  loadRegistry?: ReturnType<typeof vi.fn>;
  insertProject?: ReturnType<typeof vi.fn>;
  insertConversation?: ReturnType<typeof vi.fn>;
} = {}) {
  const insertProject = input.insertProject ?? vi.fn();
  const insertConversation = input.insertConversation ?? vi.fn();
  return {
    db: {
      transaction: (fn: (...args: any[]) => unknown) => (...args: any[]) => fn(...args),
    },
    design: {},
    http: {
      createSseResponse: noop,
      sendApiError: (
        res: express.Response,
        status: number,
        code: string,
        message: string,
      ) => res.status(status).json({ error: { code, message } }),
    },
    paths: {
      DESIGN_SYSTEMS_DIR: '',
      PROJECTS_DIR: '',
      SKILLS_DIR: '',
      BRANDS_DIR: '',
      USER_DESIGN_SYSTEMS_DIR: '',
    },
    projectStore: functionProxy({
      insertProject,
      validateLinkedDirs: () => ({ dirs: [] }),
      getProject: () => ({
        id: PROJECT_ID,
        name: 'Scope target',
        skillId: null,
        designSystemId: null,
        metadata: null,
        createdAt: 1,
        updatedAt: 1,
      }),
      updateProject: vi.fn(),
      listProjects: () => [],
    }),
    projectFiles: functionProxy({
      listFiles: () => [],
      listTabs: () => [],
      resolveProjectDir: () => '',
    }),
    conversations: functionProxy({ insertConversation }),
    templates: functionProxy({ listTemplates: () => [] }),
    status: functionProxy({
      listLatestProjectRunStatuses: () => new Map(),
      listProjectsAwaitingInput: () => new Set(),
      listProjects: () => [],
    }),
    events: functionProxy({ activeProjectEventSinks: new Map() }),
    ids: { randomId: () => 'conversation-id' },
    telemetry: { reportFinalizedMessage: noop },
    appConfig: { readAppConfig: async () => ({}), writeAppConfig: noop },
    agents: {},
    validation: {
      validateProjectDesignSystemId: input.validateDesignSystem
        ?? vi.fn(async (id) => ({ ok: true, id })),
      validateProjectSkillId: input.validateSkill
        ?? vi.fn(async (id) => ({ ok: true, id })),
    },
    pluginScope: {
      loadRegistry: input.loadRegistry ?? vi.fn(async () => ({
        skills: [],
        designSystems: [],
        craft: [],
        atoms: [],
        scenarios: [],
      })),
      getPlugin: input.getPlugin ?? vi.fn(async () => ({})),
      ...(input.getLocalPluginBySource
        ? { getLocalPluginBySource: input.getLocalPluginBySource }
        : {}),
    },
  } as unknown as Parameters<typeof registerProjectRoutes>[1];
}

async function start(deps: Parameters<typeof registerProjectRoutes>[1]) {
  const app = express();
  app.use(express.json());
  registerProjectRoutes(app, deps);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

function headers() {
  return { 'content-type': 'application/json' };
}

describe('project resource selection validation', () => {

  it('creates a project with no resource selection', async () => {
    const insertProject = vi.fn((_: unknown, input: Record<string, unknown>) => input);
    const baseUrl = await start(buildDeps({
      insertProject,
    }));

    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        id: 'plain-create',
        name: 'Plain create',
      }),
    });

    expect(response.status).toBe(200);
    expect(insertProject).toHaveBeenCalledOnce();
  });

  it('passes the selected ids to both create validators', async () => {
    const validateDesignSystem = vi.fn(async (id) => ({ ok: true, id }));
    const validateSkill = vi.fn(async () => ({
      ok: false,
      code: 'SKILL_NOT_FOUND',
      message: 'skill not found',
    }));
    const baseUrl = await start(buildDeps({ validateDesignSystem, validateSkill }));

    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        id: 'new-project',
        name: 'New project',
        designSystemId: 'user:brand',
        skillId: 'skill',
      }),
    });

    expect(response.status).toBe(400);
    expect(validateDesignSystem).toHaveBeenCalledWith('user:brand');
    expect(validateSkill).toHaveBeenCalledWith('skill');
  });

  it('passes the selected ids to both patch validators', async () => {
    const validateDesignSystem = vi.fn(async (id) => ({ ok: true, id }));
    const validateSkill = vi.fn(async () => ({
      ok: false,
      code: 'SKILL_NOT_FOUND',
      message: 'skill not found',
    }));
    const baseUrl = await start(buildDeps({ validateDesignSystem, validateSkill }));

    const response = await fetch(`${baseUrl}/api/projects/${PROJECT_ID}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({
        designSystemId: 'user:brand',
        skillId: 'skill',
      }),
    });

    expect(response.status).toBe(400);
    expect(validateDesignSystem).toHaveBeenCalledWith('user:brand');
    expect(validateSkill).toHaveBeenCalledWith('skill');
  });

  it('rejects an unknown direct plugin before project, conversation, or registry writes', async () => {
    const insertProject = vi.fn();
    const insertConversation = vi.fn();
    const loadRegistry = vi.fn();
    const getPlugin = vi.fn(async () => null);
    const baseUrl = await start(buildDeps({
      insertProject,
      insertConversation,
      loadRegistry,
      getPlugin,
    }));

    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        id: 'unknown-plugin-project',
        name: 'Unknown plugin project',
        pluginId: 'unknown-plugin',
      }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PLUGIN_NOT_FOUND' },
    });
    expect(getPlugin).toHaveBeenCalledWith('unknown-plugin');
    expect(insertProject).not.toHaveBeenCalled();
    expect(insertConversation).not.toHaveBeenCalled();
    expect(loadRegistry).not.toHaveBeenCalled();
  });

  it('resolves an exact local plugin source and writes the project', async () => {
    const insertProject = vi.fn((_: unknown, input: Record<string, unknown>) => input);
    const source = '/plugins/shared-id';
    const loadRegistry = vi.fn(async () => ({
      skills: [],
      designSystems: [],
      craft: [],
      atoms: [],
      scenarios: [],
    }));
    const getLocalPluginBySource = vi.fn(async () => ({
      id: 'shared-id',
      source,
    }));
    const baseUrl = await start(buildDeps({
      insertProject,
      getLocalPluginBySource,
      loadRegistry,
    }));

    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        id: 'exact-local-plugin',
        name: 'Exact local plugin',
        pluginId: 'shared-id',
        pluginSource: source,
      }),
    });

    // This narrow route fixture does not implement snapshot persistence, so the
    // handler later returns BAD_REQUEST. The boundary under test is that exact
    // source resolution and the local project write both occur.
    expect(response.status).toBe(400);
    expect(getLocalPluginBySource).toHaveBeenCalledWith('shared-id', source);
    expect(loadRegistry).toHaveBeenCalled();
    expect(insertProject).toHaveBeenCalledOnce();
  });

  it('rejects a plugin source missing from the reconciled local catalog', async () => {
    const insertProject = vi.fn();
    const source = '/plugins/shared-id';
    const getLocalPluginBySource = vi.fn(async () => null);
    const baseUrl = await start(buildDeps({ insertProject, getLocalPluginBySource }));

    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        id: 'locally-retired-plugin',
        name: 'Locally retired plugin',
        pluginId: 'shared-id',
        pluginSource: source,
      }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PLUGIN_NOT_FOUND' },
    });
    expect(getLocalPluginBySource).toHaveBeenCalledWith('shared-id', source);
    expect(insertProject).not.toHaveBeenCalled();
  });

  it('does not create a project when an exact source retires during registry loading', async () => {
    const insertProject = vi.fn();
    const insertConversation = vi.fn();
    const source = '/plugins/shared-id';
    let bindingLive = true;
    const getLocalPluginBySource = vi.fn(async () =>
      bindingLive ? { id: 'shared-id', source } : null,
    );
    const loadRegistry = vi.fn(async () => {
      bindingLive = false;
      return { skills: [], designSystems: [], craft: [], atoms: [], scenarios: [] };
    });
    const baseUrl = await start(buildDeps({
      insertProject,
      insertConversation,
      getLocalPluginBySource,
      loadRegistry,
    }));

    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        id: 'retired-during-registry-load',
        name: 'Retired during registry load',
        pluginId: 'shared-id',
        pluginSource: source,
      }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PLUGIN_NOT_FOUND' },
    });
    expect(getLocalPluginBySource).toHaveBeenCalledTimes(2);
    expect(insertProject).not.toHaveBeenCalled();
    expect(insertConversation).not.toHaveBeenCalled();
  });
});
