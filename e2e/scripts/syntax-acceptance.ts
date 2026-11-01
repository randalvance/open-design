/** Explicit local acceptance, NOT a hermetic CI test or remote batch creator. */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { DELIVERABLE_SYNTAX_FINALIZATION_REASONS, DELIVERABLE_SYNTAX_SAFE_FIX_RULES } from '@open-design/contracts';
import { createToolsDevSuite, e2eWorkspaceRoot } from '../lib/tools-dev/runtime.ts';
import { runToolsDevJson } from '../lib/tools-dev/cli.ts';

type Json = Record<string, any>;
type ReplayFixture = {
  id: string; source: string; expected?: string; action: 'allow' | 'warn'; attempts?: number;
  status?: 'pass' | 'repairable' | 'incomplete';
  appliedRepairRules?: string[]; finalizationReason?: string; refusal?: string;
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sourceScopes = ['apps/daemon', 'packages/contracts', 'pnpm-lock.yaml'];

/** git diff excludes new files: record their scoped paths and bytes alongside the tracked diff. */
export async function captureUntrackedSourceIdentity(workspace: string) {
  const { stdout } = await promisify(execFile)('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', ...sourceScopes], { cwd: workspace });
  const paths = stdout.split('\0').filter(Boolean).sort();
  const untrackedFiles = await Promise.all(paths.map(async relativePath => ({
    path: relativePath, sha256: hash(await readFile(path.join(workspace, relativePath))),
  })));
  return { untrackedFiles, untrackedFilesSha256: hash(JSON.stringify(untrackedFiles)) };
}

/** File-only fixture input: never imports daemon implementation or executes fixture JavaScript. */
export async function loadReplayFixtures(manifestPath: string): Promise<ReplayFixture[]> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Json;
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) throw new Error('Fixture manifest must have a nonempty fixtures array');
  const seen = new Set<string>();
  return await Promise.all(manifest.fixtures.map(async (entry: Json) => {
    if (typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(entry.id) || seen.has(entry.id)) throw new Error('Fixture IDs must be unique and path-safe');
    seen.add(entry.id);
    if (entry.action !== 'allow' && entry.action !== 'warn') throw new Error(`${entry.id}: invalid fixture action (syntax-only failure must warn)`);
    if (entry.status !== undefined && !['pass', 'repairable', 'incomplete'].includes(entry.status)) throw new Error(`${entry.id}: invalid expected checker status`);
    if (typeof entry.before !== 'string' || (entry.action === 'allow' && typeof entry.after !== 'string')) throw new Error(`${entry.id}: before and exact expected after are required for allow`);
    if (entry.attempts !== undefined && (!Number.isInteger(entry.attempts) || entry.attempts < 0)) throw new Error(`${entry.id}: invalid attempts`);
    const source = await readFile(path.resolve(path.dirname(manifestPath), entry.before), 'utf8');
    const expected = typeof entry.after === 'string' ? await readFile(path.resolve(path.dirname(manifestPath), entry.after), 'utf8') : source;
    if (entry.action === 'warn' && expected !== source) throw new Error(`${entry.id}: warning fixture must preserve original bytes`);
    return { id: entry.id, source, expected, action: entry.action, status: entry.status, attempts: entry.attempts,
      appliedRepairRules: entry.appliedRepairRules, finalizationReason: entry.finalizationReason, refusal: entry.refusal };
  }));
}

/** Evidence oracle only: no syntax parsing or repair logic is implemented by the harness. */
function hostTerminalOutcome(runStatus: unknown, validation: Json) {
  const finalization = validation.finalization;
  const summaryComplete = finalization?.summaryVersion === 1
    && finalization.repairEngine === 'host-safe-fixer@2'
    && ['pass', 'repairable', 'incomplete', 'skipped'].includes(finalization.initialStatus)
    && Number.isInteger(finalization.stagedPatchCount)
    && finalization.stagedPatchCount >= 0 && finalization.stagedPatchCount <= 8
    && Number.isInteger(finalization.committedPatchCount)
    && finalization.committedPatchCount >= 0 && finalization.committedPatchCount <= finalization.stagedPatchCount
    && Array.isArray(finalization.committedRepairRules)
    && finalization.committedRepairRules.every((rule: any) => DELIVERABLE_SYNTAX_SAFE_FIX_RULES.includes(rule))
    && (finalization.committedPatchCount > 0 ? finalization.committedRepairRules.length > 0 : finalization.committedRepairRules.length === 0);
  const deliveredWithWarning = summaryComplete && runStatus === 'succeeded'
    && finalization.action === 'warn' && finalization.committedPatchCount === 0
    && ['pass', 'repairable', 'incomplete'].includes(validation.status)
    && DELIVERABLE_SYNTAX_FINALIZATION_REASONS.includes(finalization.reason);
  const repairVerified = summaryComplete && runStatus === 'succeeded'
    && finalization.initialStatus === 'repairable' && finalization.committedPatchCount > 0
    && validation.status === 'pass' && finalization.action === 'allow';
  return { summaryComplete, deliveredWithWarning, repairVerified };
}

export function replayCaseVerdict(fixture: ReplayFixture, run: Json, content: string) {
  const validation = run.deliverableSyntaxValidation ?? {};
  const beforeAfterEqual = content === fixture.source;
  const expectedAfterEqual = fixture.expected === undefined ? null : content === fixture.expected;
  const artifactMatches = fixture.expected !== undefined ? expectedAfterEqual === true
    : fixture.action === 'warn' || fixture.attempts === 0 ? beforeAfterEqual : !beforeAfterEqual;
  const appliedRepairRules = validation.metrics?.appliedRepairRules ?? [];
  const finalization = validation.finalization;
  const outcome = hostTerminalOutcome(run.status, validation);
  const expectedCommitted = fixture.action === 'allow' ? (fixture.attempts ?? 0) : 0;
  const terminalSummaryValid = outcome.summaryComplete
    && finalization.committedPatchCount === expectedCommitted
    && (fixture.attempts === undefined || finalization.stagedPatchCount === fixture.attempts)
    && (fixture.action !== 'allow' || finalization.initialStatus === (expectedCommitted > 0 ? 'repairable' : 'pass'))
    && JSON.stringify(finalization.committedRepairRules) === JSON.stringify(expectedCommitted > 0 ? appliedRepairRules : [])
    && (fixture.action !== 'warn' || outcome.deliveredWithWarning);
  const deliveredWithWarning = terminalSummaryValid && outcome.deliveredWithWarning && beforeAfterEqual && artifactMatches;
  const repairVerified = terminalSummaryValid && outcome.repairVerified && artifactMatches;
  const terminalDurationMs = validation.metrics?.repairToTerminalDurationMs ?? validation.metrics?.repairToDeliveryDurationMs ?? null;
  return {
    passed: run.status === 'succeeded'
      && terminalSummaryValid
      && validation.finalization?.action === fixture.action
      && (fixture.attempts === undefined || (validation.repairState?.attempt ?? 0) === fixture.attempts)
      && (fixture.action !== 'allow' || validation.status === 'pass')
      && (fixture.status === undefined || validation.status === fixture.status)
      && (fixture.action !== 'warn' || beforeAfterEqual)
      && artifactMatches
      && (fixture.appliedRepairRules === undefined || JSON.stringify(appliedRepairRules) === JSON.stringify(fixture.appliedRepairRules))
      && (fixture.finalizationReason === undefined || validation.finalization?.reason === fixture.finalizationReason)
      && (fixture.refusal === undefined || validation.finalization?.refusal === fixture.refusal),
    terminalSummaryValid, deliveredWithWarning, repairVerified,
    beforeAfterEqual, expectedAfterEqual, beforeSha256: hash(fixture.source), afterSha256: hash(content),
    expectedAfterSha256: fixture.expected === undefined ? null : hash(fixture.expected), appliedRepairRules,
    // Historical repairToDeliveryDurationMs also contains failed terminal time; keep outcomes distinct.
    discoveryToDeliveryMs: run.status === 'succeeded' ? terminalDurationMs : null,
    discoveryToWarningDeliveryMs: deliveredWithWarning ? terminalDurationMs : null,
    discoveryToRepairedDeliveryMs: repairVerified ? terminalDurationMs : null,
    discoveryToFailedTerminalMs: run.status === 'failed' ? terminalDurationMs : null,
  };
}

export async function runSyntaxAcceptance(args = process.argv.slice(2)) {
const exec = promisify(execFile);
const workspace = e2eWorkspaceRoot();
const { values } = parseArgs({ args, options: {
  mode: { type: 'string' }, repeat: { type: 'string' },
  'fixture-manifest': { type: 'string' },
} });
if (values.mode !== 'replay') throw new Error('Choose --mode replay.');
const mode = values.mode;
const root = await mkdtemp(path.join(os.tmpdir(), 'od-syntax-acceptance-'));
await chmod(root, 0o700);
const runtime = createToolsDevSuite({
  root, namespace: `syntax-${randomUUID().slice(0, 8)}`, ownerPid: process.pid,
  toolsDevRoot: path.join(root, 'runtime'), dataDir: path.join(root, 'data'),
  codexHomeDir: path.join(root, 'codex'),
}, {
  // Repository dotenv files must not override this harness's isolated data root.
  runJson: (workspace, suite, args, env, options) =>
    runToolsDevJson(workspace, suite, [...args, '--no-env-file'], env, options),
});
const env: Record<string, string | undefined> = {
  OD_INSTALLATION_DIR: '', OD_LEGACY_DATA_DIR: '',
  OD_NEXT_STRATEGY_ROLLOUT: 'off',
  OD_DELIVERABLE_SYNTAX_FINALIZER: '1',
};
const report: Json = {
  mode, status: 'RUNNING', startedAt: new Date().toISOString(), root,
  boundary: 'fake CLI / real deployed daemon terminal chain; NOT real-model acceptance',
  cases: [],
};
async function save(name: string, data: unknown) {
  await writeFile(path.join(root, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}
async function command(command: string, args: string[], logName: string, timeout = 180_000) {
  const log = await open(path.join(root, logName), 'w', 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: workspace, env: { ...process.env, ...env }, stdio: ['ignore', log.fd, log.fd],
        timeout,
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${logName}: exit=${code}, signal=${signal}`)));
    });
  } finally { await log.close(); }
}
async function request(url: string, method = 'GET', body?: unknown): Promise<Json> {
  let response: Response;
  try {
    response = await fetch(url, {
      method, signal: AbortSignal.timeout(30_000),
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new Error(`${method} ${new URL(url).pathname}: ${error instanceof Error ? error.message : 'request failed'}`);
  }
  if (!response.ok) throw new Error(`${method} ${new URL(url).pathname}: HTTP ${response.status}`);
  return await response.json() as Json;
}
async function sourceIdentity() {
  const git = async (...args: string[]) => (await exec('git', args, { cwd: workspace, maxBuffer: 256 * 1024 * 1024 })).stdout.trim();
  return {
    branch: await git('branch', '--show-current'), commit: await git('rev-parse', 'HEAD'),
    diffSha256: hash(await git('diff', 'HEAD', '--', ...sourceScopes)),
    ...await captureUntrackedSourceIdentity(workspace),
    harnessSha256: hash(await readFile(new URL(import.meta.url))),
    node: process.version,
  };
}
const fixtures = [
  { id: 'valid', script: 'const items = [1, 2];', action: 'allow', attempts: 0 },
  { id: 'array', script: 'const items = [1, 2;', action: 'allow', attempts: 1 },
  { id: 'division', script: 'const ratio = 10 / 2; const items = [1, 2;', action: 'allow', attempts: 1 },
  { id: 'regex', script: 'const re = /[{}()]/; const items = [1, 2;', action: 'allow', attempts: 1 },
  { id: 'three', script: 'function f() { if (true) { const items = [1, 2;', action: 'allow', attempts: 3 },
  { id: 'budget', script: 'function f() { if (true) { const items = [[[[[[[1, 2;', action: 'warn', status: 'repairable', attempts: 8 },
  { id: 'expression-hole', script: 'const value = ;', action: 'warn', status: 'repairable', attempts: 0 },
  { id: 'comment', script: 'const ready = true; /* unfinished', action: 'allow', attempts: 1 },
  { id: 'string', script: 'const label = "hello', action: 'allow', attempts: 1 },
  { id: 'oversize', script: ' '.repeat(2 * 1024 * 1024), action: 'warn', status: 'incomplete', attempts: 0 },
] as const;
let activeFixtures: ReplayFixture[] = fixtures.map(fixture => ({ ...fixture, source: `<!doctype html><script>${fixture.script}</script>` }));

async function replay() {
  const repeat = Number(values.repeat ?? '3');
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) throw new Error('--repeat must be 1..10');
  for (let round = 1; round <= repeat; round++) {
    for (const fixture of activeFixtures) {
      const id = `${fixture.id}-${round}`;
      const source = fixture.source;
      // The fake CLI supplies fixed output; it does not pretend to be a real model.
      const bin = path.join(root, `fixture-${id}.cjs`);
      await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('claude-code 1.0.0-acceptance'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('Usage: claude -p [--add-dir DIR]'); process.exit(0); }
const content = ${JSON.stringify(source)};
fs.writeFileSync('index.html', content);
const emit = value => fs.writeSync(1, JSON.stringify(value) + '\\n');
emit({ type:'system', subtype:'init', model:'fixed-fixture', session_id:'${id}' });
emit({ type:'assistant', message:{ id:'write', content:[{type:'tool_use',id:'write-index',name:'Write',input:{file_path:'index.html'}}],stop_reason:'tool_use' } });
emit({ type:'user', message:{content:[{type:'tool_result',tool_use_id:'write-index',content:'File written',is_error:false}]} });
emit({ type:'assistant',message:{id:'final',content:[{type:'text',text:'Done'}],stop_reason:'end_turn'} });
emit({ type:'result',subtype:'success',is_error:false,session_id:'${id}',stop_reason:'end_turn',usage:{input_tokens:2,output_tokens:1},duration_ms:1 });
`, { mode: 0o700 });
      await request(runtime.url.api('/api/app-config'), 'PUT', {
        agentId: 'claude', agentCliEnv: { claude: { CLAUDE_BIN: bin } },
        privacyDecisionAt: Date.now(),
      });
      const projectId = `acceptance_${randomUUID()}`;
      const project = await request(runtime.url.api('/api/projects'), 'POST', {
        id: projectId, name: id, metadata: { kind: 'prototype', entryFile: 'index.html' }, skipDiscoveryBrief: true,
      });
      const started = await request(runtime.url.api('/api/runs'), 'POST', {
        projectId, conversationId: project.conversationId, agentId: 'claude',
        assistantMessageId: randomUUID(), clientRequestId: randomUUID(),
        message: 'Create the page', currentPrompt: 'Create the page',
      });
      const start = Date.now();
      let run: Json;
      do {
        run = await request(runtime.url.api(`/api/runs/${started.runId}`));
        if (['succeeded', 'failed', 'canceled'].includes(run.status)) break;
        if (Date.now() - start > 60_000) throw new Error(`${id}: Run ${started.runId} timeout`);
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (true);
      await save(`${id}-run.json`, run);
      const response = await fetch(runtime.url.api(`/api/projects/${projectId}/raw/index.html`), { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`${id}: cannot read artifact`);
      const content = await response.text();
      await writeFile(path.join(root, `${id}-before.html`), source, { mode: 0o600 });
      await writeFile(path.join(root, `${id}-after.html`), content, { mode: 0o600 });
      const validation = run.deliverableSyntaxValidation ?? {};
      if (fixture.expected !== undefined) await writeFile(path.join(root, `${id}-expected.html`), fixture.expected, { mode: 0o600 });
      const verdict = replayCaseVerdict(fixture, run, content);
      const passed = verdict.passed;
      report.cases.push({
        id, ...verdict, passed,
        runId: run.id, projectId, status: run.status, validation,
        elapsedMs: Date.now() - start,
      });
      await save('report.json', report);
      console.log(`[replay] ${id}: ${passed ? 'PASS' : 'FAIL'} (${run.status})`);
    }
  }
}

try {
  report.sourceBefore = await sourceIdentity();
  await save('report.json', report);
  console.log(`Local evidence: ${root}`);
  if (values['fixture-manifest']) {
    const manifestPath = path.resolve(values['fixture-manifest']);
    activeFixtures = await loadReplayFixtures(manifestPath);
    report.fixtures = { manifestPath, manifestSha256: hash(await readFile(manifestPath)),
      entries: activeFixtures.map(fixture => ({ id: fixture.id, beforeSha256: hash(fixture.source), expectedSha256: hash(fixture.expected!), action: fixture.action })) };
  }
  console.log('Building current worktree and dependencies (no --skip-build).');
  await command('pnpm', ['--filter', '@open-design/daemon...', '--workspace-concurrency=4', 'build'], 'build.log', 600_000);
  report.build = {
    serverSha256: hash(await readFile(path.join(workspace, 'apps/daemon/dist/server.js'))),
    finalizerSha256: hash(await readFile(path.join(workspace, 'apps/daemon/dist/artifacts/deliverable-syntax-finalization.js'))),
    fixerSha256: hash(await readFile(path.join(workspace, 'apps/daemon/dist/artifacts/deliverable-syntax-safe-fix.js'))),
    quotesSha256: hash(await readFile(path.join(workspace, 'apps/daemon/dist/artifacts/deliverable-syntax-quotes.js'))),
  };
  report.runtime = await runtime.startWeb(env);
  report.runtimeCheck = await runtime.check(env);
  await request(runtime.url.api('/api/app-config'), 'PUT', {
    agentId: 'claude', privacyDecisionAt: Date.now(),
  });
  await replay();
  report.status = report.cases.length > 0 && report.cases.every((entry: Json) => entry.passed) ? 'PASS' : 'FAIL';
  report.note = 'Replay PASS is not real-model acceptance.';
} catch (error) {
  report.status = 'BLOCKED';
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  try {
    report.sourceAfter = await sourceIdentity();
    report.sourceStable = JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter);
    if (!report.sourceStable) report.status = 'BLOCKED';
  } catch (error) { report.sourceAfterError = String(error); report.status = 'BLOCKED'; }
  // Preserve local evidence, but never leave a temporary background runtime running.
  try { await save('runtime-logs.json', await runtime.logs(env)); } catch { /* startup may not have happened */ }
  report.cleanup = { attempted: true, stopped: false };
  try {
    report.cleanup.stopResult = await runtime.stopWeb(env);
    report.cleanup.status = await runtime.status(env);
    report.cleanup.stopped = ['daemon', 'web'].every(app => {
      const state = report.cleanup.status.apps?.[app];
      return state && state.state !== 'running' && state.pid == null;
    });
    if (!report.cleanup.stopped) { report.status = 'BLOCKED'; report.cleanupError = 'Runtime stop was not confirmed by status'; }
  } catch (error) {
    report.cleanupError = String(error); report.status = 'BLOCKED';
  }
  report.finishedAt = new Date().toISOString();
  await save('report.json', report);
  console.log(`${report.status}: ${path.join(root, 'report.json')}`);
  if (report.error) console.log(report.error);
  if (report.status !== 'PASS') process.exitCode = 1;
}
return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runSyntaxAcceptance();
