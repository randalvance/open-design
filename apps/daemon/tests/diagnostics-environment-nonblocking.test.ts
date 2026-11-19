import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { resolveSystemProxyEnv } from '@open-design/platform';
import { createDiagnosticsExportHandler } from '../src/diagnostics-export.js';
import { createDiagnosticsEvidence } from '../src/services/diagnostics-evidence.js';
import { collectSystemEnvironment } from '../src/services/diagnostics-environment.js';

vi.mock('@open-design/platform', async importOriginal => ({
  ...await importOriginal<typeof import('@open-design/platform')>(),
  resolveSystemProxyEnv: vi.fn(() => ({})),
}));

afterEach(() => vi.clearAllMocks());

it('locates diagnostic log homes without synchronous OS proxy discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'od-diag-nonblocking-'));
  const codexHome = join(root, 'configured-codex');
  await mkdir(join(codexHome, 'log'), { recursive: true });
  await writeFile(join(codexHome, 'log', 'codex-tui.log'), '{"type":"event"}\n');
  await writeFile(join(root, 'app-config.json'), JSON.stringify({
    agentCliEnv: { codex: { CODEX_HOME: codexHome } },
  }));
  const evidence = createDiagnosticsEvidence({
    collect: () => collectSystemEnvironment({ platform: 'linux', env: {}, interfaces: () => ({}) }),
    write: async () => undefined,
  });
  try {
    // Drive the export handler: it is the consumer of the resolved agent log
    // homes, so the configured CODEX_HOME must be found without an OS query.
    const handler = createDiagnosticsExportHandler({ runtime: null, projectRoot: root, dataDir: root, evidence });
    let status = 0;
    let payload: Buffer | undefined;
    const res = {
      status(code: number) { status = code; return res; },
      setHeader() { return res; },
      end(body: Buffer) { payload = body; },
      json() { /* error path; asserted through status below */ },
    };
    await handler({} as never, res as never, () => undefined);
    expect(status).toBe(200);
    const zip = await JSZip.loadAsync(payload!);
    expect(Object.keys(zip.files).some(name => name.includes('codex-tui.log'))).toBe(true);
    expect(resolveSystemProxyEnv).not.toHaveBeenCalled();
  } finally { evidence.close(); await rm(root, { recursive: true, force: true }); }
});
