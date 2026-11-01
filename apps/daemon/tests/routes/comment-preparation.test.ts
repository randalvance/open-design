import type { PrepareCommentIdentityResponse, ProjectFileVersionResponse, ProjectFileResponse } from '@open-design/contracts';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { expect, it, vi } from 'vitest';
import { openDatabase, closeDatabase, insertProject, getProject } from '../../src/db.js';
import * as projectFiles from '../../src/projects.js';
import { registerProjectFileRoutes } from '../../src/routes/project/index.js';
import { listProjectFileVersions } from '../../src/project-file-versions.js';

it('explicit HTTP/CLI preparation uses real source save/readback, conflict and retry', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-comment-source-http-'));
  const projects = path.join(root, 'projects');
  const db = openDatabase(root);
  let server: http.Server | undefined;
  let busy = false;
  try {
    for (const id of ['project', 'other']) {
      insertProject(db, { id, name: id, createdAt: 1, updatedAt: 1 });
      await projectFiles.ensureProject(projects, id);
      await projectFiles.writeProjectFile(projects, id, 'index.html', Buffer.from('<h2 data-od-id="tool">A</h2><p>C</p>'));
    }
    const app = express(); app.use(express.json());
    // SAFETY: only routes exercised below use these supplied production dependencies.
    registerProjectFileRoutes(app, {
      db, paths: { PROJECTS_DIR: projects },
      http: { sendApiError: (res: express.Response, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } }) },
      projectStore: { getProject },
      projectFiles: {
        ...projectFiles,
        // A passthrough preserves real saves while letting the test interpose
        // after route registration (the registrar otherwise captures a reference).
        writeProjectFile: (...args: Parameters<typeof projectFiles.writeProjectFile>) => projectFiles.writeProjectFile(...args),
      },
      node: { fs: nodeFs }, uploads: { upload: multer() }, documents: {}, artifacts: {}, projectPreviewScopes: {},
      isProjectEditingBusy: () => busy,
    } as unknown as Parameters<typeof registerProjectFileRoutes>[1]);
    server = app.listen(0); await new Promise<void>((resolve) => server!.once('listening', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
    const base = `http://127.0.0.1:${address.port}`;
    const requestHttp = (url: string, options: RequestInit) => fetch(url, { ...options, signal: AbortSignal.timeout(5_000) });
    const endpoint = `${base}/api/projects/project/files/index.html/comment-identities/prepare`;
    const headers = () => ({ 'content-type': 'application/json' });
    const source = await fs.readFile(path.join(projects, 'project/index.html'), 'utf8');
    const prepare = (body: unknown) => requestHttp(endpoint, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    const request = { expectedSource: source, editingSettled: true };
    // Ordinary raw preview does not prepare or create history.
    expect((await requestHttp(`${base}/api/projects/project/raw/index.html`, { headers: headers() })).status).toBe(200);
    expect(await listProjectFileVersions(projects, 'project', 'index.html')).toHaveLength(0);
    const beforeProbe = await fs.readdir(path.join(projects, 'project'), { recursive: true });
    const passive = await requestHttp(`${base}/api/projects/project/files/index.html/versions?bootstrap=0`, { headers: headers() });
    expect(passive.status).toBe(200);
    expect((await passive.json() as { versions: unknown[] }).versions).toEqual([]);
    expect(await listProjectFileVersions(projects, 'project', 'index.html')).toHaveLength(0);
    expect(await fs.readdir(path.join(projects, 'project'), { recursive: true })).toEqual(beforeProbe);
    expect(await fs.readFile(path.join(projects, 'project/index.html'), 'utf8')).toBe(source);
    // The existing explicit history workflow keeps its default bootstrap behavior.
    await projectFiles.writeProjectFile(projects, 'project', 'default.html', Buffer.from('<p>Baseline</p>'));
    const defaultHistory = await requestHttp(`${base}/api/projects/project/files/default.html/versions`, { headers: headers() });
    expect(defaultHistory.status).toBe(200);
    expect((await defaultHistory.json() as { versions: unknown[] }).versions).toHaveLength(1);
    busy = true;
    expect((await prepare(request)).status).toBe(409);
    busy = false;
    expect((await prepare({ ...request, editingSettled: false })).status).toBe(409);
    expect((await prepare({ ...request, expectedSource: 'stale' })).status).toBe(409);
    expect(await fs.readFile(path.join(projects, 'project/index.html'), 'utf8')).toBe(source);
    const success = await prepare(request);
    expect(success.status).toBe(200);
    const result = await success.json() as PrepareCommentIdentityResponse;
    expect(result.changed).toBe(true);
    expect(result.source.replace(/ data-od-comment-id="[^"]+"/g, '')).toBe(source);
    expect(await fs.readFile(path.join(projects, 'project/index.html'), 'utf8')).toBe(result.source);
    const version = await requestHttp(`${base}/api/projects/project/files/index.html/versions/${result.version.id}`, { headers: headers() });
    expect((await version.json() as ProjectFileVersionResponse).content).toBe(result.source);
    const expectedPath = path.join(root, 'expected.html'); await fs.writeFile(expectedPath, result.source);
    const cli = await promisify(execFile)(process.execPath, [path.resolve('dist/cli.js'), 'files', 'prepare-comments', 'project', 'index.html', '--daemon-url', base, '--prompt-file', expectedPath, '--json'], { timeout: 5_000 });
    expect(JSON.parse(cli.stdout)).toMatchObject({ changed: false, version: { id: result.version.id } });
    expect(await listProjectFileVersions(projects, 'project', 'index.html')).toHaveLength(1);
    const edited = result.source.replace('>A<', '>Later edit<');
    // D2: hold the actual JSON source save inside its version lock, then allow
    // preparation to read the old source and queue on that same real boundary.
    const realSave = projectFiles.writeProjectFile; const realRead = projectFiles.readProjectFile;
    let releaseSave!: () => void; let signalSave!: () => void; let signalRead!: () => void;
    const saveGate = new Promise<void>((r) => { releaseSave = r; });
    const saveEntered = new Promise<void>((r) => { signalSave = r; });
    const prepareRead = new Promise<void>((r) => { signalRead = r; });
    vi.spyOn(projectFiles, 'writeProjectFile').mockImplementationOnce(async (...args) => {
      signalSave(); await saveGate; return realSave(...args);
    });
    const saving = requestHttp(`${base}/api/projects/project/files`, { method: 'POST', headers: headers(), body: JSON.stringify({ name: 'index.html', content: edited, versionSource: 'manual' }) });
    await saveEntered;
    vi.spyOn(projectFiles, 'readProjectFile').mockImplementation(async (...args) => {
      const file = await realRead(...args); signalRead(); return file;
    });
    const stalePrepare = prepare({ editingSettled: true, expectedSource: result.source });
    await prepareRead;
    releaseSave();
    const save = await saving;
    expect((await stalePrepare).status).toBe(409);
    vi.restoreAllMocks();
    expect(save.status).toBe(200);
    expect((await save.json() as ProjectFileResponse).version?.id).not.toBe(result.version.id);
    expect(await fs.readFile(path.join(projects, 'project/index.html'), 'utf8')).toBe(edited);
    const retry = await prepare({ editingSettled: true, expectedSource: edited });
    expect((await retry.json() as PrepareCommentIdentityResponse).changed).toBe(false);
    expect(await listProjectFileVersions(projects, 'project', 'index.html')).toHaveLength(2);
  } finally {
    vi.restoreAllMocks();
    if (server) await new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeAllConnections(); });
    closeDatabase(); await fs.rm(root, { recursive: true, force: true });
  }
});
