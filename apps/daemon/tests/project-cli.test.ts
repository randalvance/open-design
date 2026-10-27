import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface StubServer {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

let stub: StubServer | null = null;
let tempRoot = '';

afterEach(async () => {
  if (stub) await stub.close();
  stub = null;
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = '';
});

async function startProjectStubServer(deleteResponse: unknown = { ok: true }): Promise<StubServer> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: raw,
      };
      requests.push(captured);

      res.setHeader('content-type', 'application/json');
      if (captured.method === 'DELETE' && captured.url === '/api/projects/project-1/files/nested%2Findex.html') {
        res.end(JSON.stringify(deleteResponse));
        return;
      }
      if (captured.method === 'DELETE' && captured.url === '/api/projects/project-1') {
        res.end(JSON.stringify(deleteResponse));
        return;
      }
      if (captured.method === 'POST' && captured.url === '/api/projects') {
        res.statusCode = 201;
        res.end(JSON.stringify({ project: { id: 'created-project' } }));
        return;
      }
      if (captured.method === 'POST' && captured.url === '/api/projects/source-project/design-system-copy') {
        res.statusCode = 201;
        res.end(JSON.stringify({
          project: { id: 'design-copy-1', name: 'Design Copy' },
          designSystemId: 'user:design-copy-1',
          conversationId: 'conversation-design-copy',
        }));
        return;
      }
      if (captured.method === 'POST' && captured.url === '/api/projects/source-project/duplicate') {
        res.statusCode = 201;
        res.end(JSON.stringify({
          project: { id: 'duplicate-1', name: 'Duplicate Copy' },
          conversationId: 'conversation-duplicate',
        }));
        return;
      }
      if (captured.method === 'GET' && captured.url === '/api/projects/project-1') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          project: { id: 'project-1', name: 'Project One' },
          resolvedDir: '/tmp/projects/project-1',
        }));
        return;
      }
      if (captured.method === 'GET' && captured.url === '/api/projects/project-1/files') {
        res.statusCode = 200;
        res.end(JSON.stringify({ files: [] }));
        return;
      }
      if (captured.method === 'GET' && captured.url === '/api/projects') {
        res.statusCode = 200;
        res.end(JSON.stringify({ projects: [{ id: 'project-1', name: 'Project One', skillId: null }] }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 'unexpected-request', message: captured.url } }));
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('stub server has no address');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [TSX_CLI, CLI_SRC, ...args], {
      cwd: DAEMON_ROOT,
      env,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
      code: failed.code ?? 1,
    };
  }
}

describe('od project CLI', () => {
  it.each([false, true])('files delete preserves the HTTP response or human output, json=%s', async json => {
    const body = { ok: true };
    stub = await startProjectStubServer(body);
    const result = await runCli(['files', 'delete', 'project-1', 'nested/index.html', '--daemon-url', stub.baseUrl, ...(json ? ['--json'] : [])]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    if (json) expect(JSON.parse(result.stdout)).toEqual(body);
    else expect(result.stdout).toBe('[files] deleted nested/index.html\n');
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({ method: 'DELETE', url: '/api/projects/project-1/files/nested%2Findex.html' });
  });
  it.each([false, true])('delete reports unchanged no-residual success, json=%s', async json => {
    stub = await startProjectStubServer();
    const result = await runCli(['project', 'delete', 'project-1', '--daemon-url', stub.baseUrl, ...(json ? ['--json'] : [])]);
    expect(result.code).toBe(0); expect(result.stderr).toBe('');
    if (json) expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    else expect(result.stdout).toBe('[project] deleted project-1\n');
    expect(stub.requests).toHaveLength(1);
  });


  it('creates a motion design task with the same automatic OD Next route as Home', async () => {
    stub = await startProjectStubServer();
    tempRoot = mkdtempSync(join(tmpdir(), 'od-motion-cli-'));
    const promptPath = join(tempRoot, 'prompt.md');
    writeFileSync(promptPath, 'Create a 12-second motion film.\n', 'utf8');
    const result = await runCli([
      'project', 'create', '--task-type', 'motion-design',
      '--prompt-file', promptPath, '--json', '--daemon-url', stub.baseUrl,
    ]);
    expect(result.code).toBe(0);
    const request = stub.requests.find((item) => item.method === 'POST' && item.url === '/api/projects');
    expect(request).toBeDefined();
    expect(JSON.parse(request!.body)).toMatchObject({
      conversationMode: 'design',
      automaticStrategyTaskProfile: 'motion-design',
      metadata: { kind: 'video', intent: 'motion-design', videoModel: 'hyperframes-html' },
      pendingPrompt: 'Create a 12-second motion film.\n',
    });
    expect(JSON.parse(request!.body).pluginId).toBeUndefined();
  });

  it.each([['--plugin', 'example-hyperframes'], ['--mode', 'chat']])(
    'rejects an incompatible motion route option %s', async (flag, value) => {
      stub = await startProjectStubServer();
      const result = await runCli(['project', 'create', '--task-type', 'motion-design', flag, value, '--daemon-url', stub.baseUrl]);
      expect(result.code).toBe(2);
      expect(stub.requests.some((item) => item.method === 'POST')).toBe(false);
    },
  );

  it('creates a design-system project with prompt-file content and JSON output', async () => {
    stub = await startProjectStubServer();
    tempRoot = mkdtempSync(join(tmpdir(), 'od-project-cli-'));
    const promptPath = join(tempRoot, 'prompt.md');
    writeFileSync(promptPath, 'Use this workspace as the brand source.\n', 'utf8');

    const result = await runCli([
      'project',
      'create-design-system',
      'source-project',
      '--name',
      'Design Copy',
      '--prompt-file',
      promptPath,
      '--json',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      project: { id: 'design-copy-1', name: 'Design Copy' },
      designSystemId: 'user:design-copy-1',
      conversationId: 'conversation-design-copy',
    });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({
      method: 'POST',
      url: '/api/projects/source-project/design-system-copy',
    });
    expect(JSON.parse(stub.requests[0]!.body)).toEqual({
      name: 'Design Copy',
      pendingPrompt: 'Use this workspace as the brand source.\n',
    });
  });

  it('duplicates a project and prints the human-readable result', async () => {
    stub = await startProjectStubServer();

    const result = await runCli([
      'project',
      'duplicate',
      'source-project',
      '--name',
      'Duplicate Copy',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      '[project] duplicated source-project as duplicate-1 (conversation conversation-duplicate)\n',
    );
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({
      method: 'POST',
      url: '/api/projects/source-project/duplicate',
    });
    expect(JSON.parse(stub.requests[0]!.body)).toEqual({ name: 'Duplicate Copy' });
  });

  it('lists projects through the local catalog', async () => {
    stub = await startProjectStubServer();

    const result = await runCli(['project', 'list', '--json', '--daemon-url', stub.baseUrl]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({ method: 'GET', url: '/api/projects' });
    expect(stub.requests[0]!.headers['x-od-workspace-id']).toBeUndefined();
  });

});
