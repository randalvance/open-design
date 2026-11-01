import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToolsDevSuite } from '../../lib/tools-dev/runtime.ts';
import { runToolsDevJson } from '../../lib/tools-dev/cli.ts';
import { captureUntrackedSourceIdentity, loadReplayFixtures, replayCaseVerdict, runSyntaxAcceptance } from '../../scripts/syntax-acceptance.ts';

const { runtime } = vi.hoisted(() => ({ runtime: {
  startWeb: vi.fn(), logs: vi.fn(async () => ({})), stopWeb: vi.fn(async () => ({ stopped: true })),
  status: vi.fn(async () => ({ apps: { daemon: { state: 'stopped', pid: null }, web: { state: 'stopped', pid: null } } })),
} }));
vi.mock('../../lib/tools-dev/runtime.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/tools-dev/runtime.ts')>(),
  createToolsDevSuite: vi.fn(() => runtime),
}));
vi.mock('../../lib/tools-dev/cli.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/tools-dev/cli.ts')>(),
  runToolsDevJson: vi.fn(async () => ({})),
}));

const scratchRoots: string[] = [];
const scratch = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'syntax-acceptance-contract-'));
  scratchRoots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const metrics = { strategyRoute: 'od-next', agent: 'open-design:claude', model: 'fixed-fixture', deliverableSyntax: {
  status: 'pass', terminalRunStatus: 'succeeded', recoveredDeliveryCount: 0,
  finalization: { action: 'allow', summaryVersion: 1, repairEngine: 'host-safe-fixer@2', initialStatus: 'pass', stagedPatchCount: 0, committedPatchCount: 0, committedRepairRules: [] },
} };
const warningFinalization = {
  action: 'warn', reason: 'no_safe_fix', refusal: 'unsupported_syntax_error', summaryVersion: 1,
  repairEngine: 'host-safe-fixer@2', initialStatus: 'repairable', stagedPatchCount: 0,
  committedPatchCount: 0, committedRepairRules: [],
};

describe('syntax acceptance evidence contract', () => {
  it('[P1] includes sorted untracked source paths and detects helper content changes outside git diff', async () => {
    const root = await scratch();
    const exec = promisify(execFile);
    await exec('git', ['init', '--quiet', root]);
    await mkdir(path.join(root, 'apps/daemon'), { recursive: true });
    await mkdir(path.join(root, 'packages/contracts'), { recursive: true });
    await writeFile(path.join(root, '.gitignore'), 'ignored.ts\n');
    await writeFile(path.join(root, 'apps/daemon/ignored.ts'), 'ignored');
    await writeFile(path.join(root, 'apps/daemon/tracked.ts'), 'tracked');
    await exec('git', ['add', 'apps/daemon/tracked.ts'], { cwd: root });
    await writeFile(path.join(root, 'packages/contracts/z.ts'), 'contract');
    await writeFile(path.join(root, 'apps/daemon/quote-helper.ts'), 'before');
    await writeFile(path.join(root, 'outside.ts'), 'outside scope');
    const before = await captureUntrackedSourceIdentity(root);
    expect(before.untrackedFiles.map(entry => entry.path)).toEqual(['apps/daemon/quote-helper.ts', 'packages/contracts/z.ts']);
    expect(before.untrackedFiles.every(entry => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
    await writeFile(path.join(root, 'apps/daemon/quote-helper.ts'), 'after');
    const after = await captureUntrackedSourceIdentity(root);
    expect(after.untrackedFilesSha256).not.toBe(before.untrackedFilesSha256);
    expect(after.untrackedFiles[1]).toEqual(before.untrackedFiles[1]);
  });

  it('[P1] loads complete external HTML and requires an exact expected artifact for delivery', async () => {
    const root = await scratch();
    const before = '<!doctype html><p>untouched</p><script>const x = [1;</script>';
    const after = '<!doctype html><p>untouched</p><script>const x = [1];</script>';
    await writeFile(path.join(root, 'before.html'), before);
    await writeFile(path.join(root, 'after.html'), after);
    await writeFile(path.join(root, 'fixtures.json'), JSON.stringify({ fixtures: [
      { id: 'whole-page', before: 'before.html', after: 'after.html', action: 'allow', attempts: 1 },
    ] }));
    const [fixture] = await loadReplayFixtures(path.join(root, 'fixtures.json'));
    if (!fixture) throw new Error('Missing loaded fixture');
    expect(fixture.source).toBe(before);
    expect(fixture.expected).toBe(after);
    const run = { status: 'succeeded', deliverableSyntaxValidation: { status: 'pass', repairState: { attempt: 1 }, metrics: { appliedRepairRules: ['insert_missing_closing_delimiter'] }, finalization: { action: 'allow', summaryVersion: 1, repairEngine: 'host-safe-fixer@2', initialStatus: 'repairable', stagedPatchCount: 1, committedPatchCount: 1, committedRepairRules: ['insert_missing_closing_delimiter'] } } };
    expect(replayCaseVerdict(fixture, run, after).passed).toBe(true);
    expect(replayCaseVerdict(fixture, run, after.replace('untouched', 'wrong'))).toMatchObject({ passed: false, repairVerified: false });
    expect(await readFile(path.join(root, 'before.html'), 'utf8')).toBe(before);
  });

  it('[P1] rejects an allow fixture without an expected artifact and unsafe fixture IDs', async () => {
    const root = await scratch();
    await writeFile(path.join(root, 'before.html'), '<script>const x = ;</script>');
    for (const fixture of [
      { id: 'no-oracle', before: 'before.html', action: 'allow' },
      { id: '../escape', before: 'before.html', action: 'fail' },
    ]) {
      await writeFile(path.join(root, 'fixtures.json'), JSON.stringify({ fixtures: [fixture] }));
      await expect(loadReplayFixtures(path.join(root, 'fixtures.json'))).rejects.toThrow();
    }
  });

  it('[P1] requires committed terminal evidence, not just a passing staged candidate', () => {
    const fixture = { id: 'summary', source: 'broken', expected: 'fixed', action: 'allow' as const, attempts: 1 };
    const finalization = { action: 'allow', summaryVersion: 1, initialStatus: 'repairable', repairEngine: 'host-safe-fixer@2', stagedPatchCount: 1, committedPatchCount: 1, committedRepairRules: ['close_unterminated_string'] };
    const run = { status: 'succeeded', deliverableSyntaxValidation: { status: 'pass', repairState: { attempt: 1 }, metrics: { appliedRepairRules: ['close_unterminated_string'] }, finalization } };
    expect(replayCaseVerdict(fixture, run, 'fixed').passed).toBe(true);
    for (const invalid of [
      { ...finalization, committedPatchCount: 0 },
      { ...finalization, summaryVersion: undefined },
      { ...finalization, committedRepairRules: [] },
      { ...finalization, initialStatus: 'pass' },
    ]) {
      expect(replayCaseVerdict(fixture, { ...run, deliverableSyntaxValidation: { ...run.deliverableSyntaxValidation, finalization: invalid } }, 'fixed').passed).toBe(false);
    }
  });

  it('[P1] delivers unrepaired original bytes with a warning without claiming a repair', () => {
    const fixture = { id: 'rejected', source: '<script>const x = ;</script>', expected: '<script>const x = ;</script>', action: 'warn' as const, status: 'repairable' as const, refusal: 'unsupported_syntax_error' };
    const run = { status: 'succeeded', deliverableSyntaxValidation: { status: 'repairable', metrics: { repairToDeliveryDurationMs: 194 }, finalization: warningFinalization } };
    expect(replayCaseVerdict(fixture, run, fixture.source)).toMatchObject({ passed: true, deliveredWithWarning: true, repairVerified: false, beforeAfterEqual: true, expectedAfterEqual: true, discoveryToDeliveryMs: 194, discoveryToWarningDeliveryMs: 194, discoveryToRepairedDeliveryMs: null });
    expect(replayCaseVerdict(fixture, run, 'changed')).toMatchObject({ passed: false, deliveredWithWarning: false });
    expect(replayCaseVerdict(fixture, { ...run, status: 'failed', errorCode: 'HTML_VERSION_SNAPSHOT_FAILED' }, fixture.source)).toMatchObject({ passed: false, deliveredWithWarning: false, repairVerified: false, discoveryToDeliveryMs: null });
    expect(replayCaseVerdict(fixture, { ...run, status: 'canceled' }, fixture.source).passed).toBe(false);
  });

  it('[P1] loads warning fixtures only with an unchanged byte oracle and rejects the retired syntax fail policy', async () => {
    const root = await scratch();
    await writeFile(path.join(root, 'before.html'), '<script>const x = ;</script>');
    await writeFile(path.join(root, 'after.html'), '<script>const x = 1;</script>');
    const manifest = path.join(root, 'fixtures.json');
    await writeFile(manifest, JSON.stringify({ fixtures: [{ id: 'ambiguous', before: 'before.html', action: 'warn', status: 'repairable', attempts: 0 }] }));
    const [fixture] = await loadReplayFixtures(manifest);
    expect(fixture).toMatchObject({ action: 'warn', status: 'repairable', expected: '<script>const x = ;</script>' });
    for (const entry of [
      { id: 'modified-warning', before: 'before.html', after: 'after.html', action: 'warn' },
      { id: 'old-policy', before: 'before.html', action: 'fail' },
    ]) {
      await writeFile(manifest, JSON.stringify({ fixtures: [entry] }));
      await expect(loadReplayFixtures(manifest)).rejects.toThrow();
    }
  });

  it('[P1] warning acceptance requires complete terminal evidence and retains the checker status', () => {
    const fixture = { id: 'warning', source: 'original', expected: 'original', action: 'warn' as const, status: 'repairable' as const };
    const run = { status: 'succeeded', deliverableSyntaxValidation: { status: 'repairable', finalization: warningFinalization } };
    for (const finalization of [
      undefined, { ...warningFinalization, summaryVersion: undefined },
      { ...warningFinalization, repairEngine: undefined }, { ...warningFinalization, initialStatus: undefined },
      { ...warningFinalization, reason: undefined }, { ...warningFinalization, committedPatchCount: 1 },
      { ...warningFinalization, stagedPatchCount: 9 }, { ...warningFinalization, committedRepairRules: undefined },
    ]) {
      expect(replayCaseVerdict(fixture, { ...run, deliverableSyntaxValidation: { ...run.deliverableSyntaxValidation, finalization } }, fixture.source)).toMatchObject({ passed: false, deliveredWithWarning: false, repairVerified: false });
    }
    expect(replayCaseVerdict(fixture, { ...run, deliverableSyntaxValidation: { ...run.deliverableSyntaxValidation, status: 'pass' } }, fixture.source).passed).toBe(false);
    const incomplete = { ...run, deliverableSyntaxValidation: { status: 'incomplete', finalization: { ...warningFinalization, initialStatus: 'incomplete', reason: 'check_incomplete', refusal: undefined } } };
    expect(replayCaseVerdict({ ...fixture, status: 'incomplete' }, incomplete, fixture.source)).toMatchObject({ passed: true, deliveredWithWarning: true, repairVerified: false });
  });

  it('[P1] a staged passing candidate with a commit conflict is warning delivery, not recovered delivery', () => {
    const fixture = { id: 'commit-conflict', source: 'original', expected: 'original', action: 'warn' as const, status: 'pass' as const, attempts: 1 };
    const run = { status: 'succeeded', deliverableSyntaxValidation: { status: 'pass', repairState: { attempt: 1 }, metrics: { appliedRepairRules: ['close_unterminated_string'] }, finalization: { ...warningFinalization, stagedPatchCount: 1, reason: 'commit_conflict', refusal: undefined } } };
    expect(replayCaseVerdict(fixture, run, fixture.source)).toMatchObject({ passed: true, deliveredWithWarning: true, repairVerified: false });
  });

  it('[P1] failed preflight still persists sourceAfter and confirmed cleanup without starting a runtime', async () => {
    const previousExitCode = process.exitCode;
    try {
      // A missing fixture manifest fails before build/start; all lifecycle operations below are mocked.
      const result = await runSyntaxAcceptance(['--mode', 'replay', '--fixture-manifest', path.join(os.tmpdir(), 'od-syntax-acceptance-missing.json')]);
      scratchRoots.push(result.root);
      expect(result.status).toBe('BLOCKED');
      expect(result.error).toContain('od-syntax-acceptance-missing.json');
      expect(runtime.startWeb).not.toHaveBeenCalled();
      const [spec, dependencies] = vi.mocked(createToolsDevSuite).mock.calls.at(-1)!;
      expect(dependencies?.runJson).toBeTypeOf('function');
      await dependencies!.runJson!('workspace', spec, ['status', '--json'], {}, {});
      expect(runToolsDevJson).toHaveBeenLastCalledWith('workspace', spec, ['status', '--json', '--no-env-file'], {}, {});
      expect(result.sourceAfter).toMatchObject({ branch: expect.any(String), commit: expect.any(String), harnessSha256: expect.any(String) });
      expect(result.cleanup).toMatchObject({ attempted: true, stopped: true });
      expect(runtime.stopWeb).toHaveBeenLastCalledWith(expect.objectContaining({ OD_INSTALLATION_DIR: '', OD_LEGACY_DATA_DIR: '' }));
      const persisted = JSON.parse(await readFile(path.join(result.root, 'report.json'), 'utf8'));
      expect(persisted.sourceAfter).toEqual(result.sourceAfter);
      expect(persisted.cleanup.stopped).toBe(true);
    } finally { process.exitCode = previousExitCode; }
  });
});
