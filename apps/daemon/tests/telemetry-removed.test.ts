// "Nothing can leave": no config can re-enable telemetry, no environment can
// produce an analytics client, and a Run's terminal checkpoint never waits on a
// sink that no longer exists.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAnalyticsService } from '../src/analytics.js';
import { readAppConfig, readAppConfigSync, writeAppConfig } from '../src/app-config.js';
import {
  beginRunTelemetryDelivery,
  finalizeRunTelemetryDelivery,
  reportNoRunTelemetry,
} from '../src/observability/delivery-state.js';
import { createFinalizedMessageTelemetryReporter } from '../src/server.js';

const OFF = { metrics: false, content: false };

describe('telemetry is removed', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-telemetry-removed-'));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('reads an existing install saved with metrics:true as off', async () => {
    await writeFile(
      path.join(dataDir, 'app-config.json'),
      JSON.stringify({
        installationId: 'install-1',
        telemetry: { metrics: true, content: true, artifactManifest: true },
      }),
    );
    expect((await readAppConfig(dataDir)).telemetry).toEqual(OFF);
    expect(readAppConfigSync(dataDir).telemetry).toEqual(OFF);
    // Identity handling is untouched; only the telemetry prefs are forced.
    expect((await readAppConfig(dataDir)).installationId).toBe('install-1');
  });

  it('reads a fresh install as off', async () => {
    expect((await readAppConfig(dataDir)).telemetry).toEqual(OFF);
  });

  it('does not let a config write turn telemetry on, and heals the saved file', async () => {
    const written = await writeAppConfig(dataDir, { telemetry: { metrics: true, content: true } });
    expect(written.telemetry).toEqual(OFF);
    const onDisk = JSON.parse(await readFile(path.join(dataDir, 'app-config.json'), 'utf8'));
    expect(onDisk.telemetry).toEqual(OFF);
  });

  it('createAnalyticsService with POSTHOG_KEY set builds no client and sends nothing', async () => {
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    const withKey = createAnalyticsService({
      dataDir,
      env: { POSTHOG_KEY: 'phc_should_be_ignored', POSTHOG_HOST: 'https://example.invalid' },
    });
    // Same shared service object as a keyless environment: no per-key client.
    expect(withKey).toBe(createAnalyticsService({ dataDir, env: {} }));

    const context = { deviceId: 'd', sessionId: 's', clientType: 'web' as const, locale: 'en', requestId: null };
    await expect(withKey.capture({
      eventName: 'run_finished', context, appVersion: '1', properties: {}, insertId: 'i',
    })).resolves.toEqual({ status: 'not_expected', acknowledgement: 'none', errorType: 'not_configured' });
    await withKey.captureSafety({ eventName: 'daemon_uncaught_exception', appVersion: '1', properties: {} });
    await withKey.mergeAnonymousPerson({ anonymousDistinctId: 'a', distinctId: 'b' });
    await withKey.identifyGroup({ context, groupType: 'workspace', groupKey: 'w', properties: { a: 1 } });
    await withKey.shutdown();
    expect(outbound).not.toHaveBeenCalled();
  });

  it('settles a Run terminal checkpoint immediately, so restart reconciliation will not replay it', () => {
    const started = beginRunTelemetryDelivery(null, 'run-1');
    const settled = finalizeRunTelemetryDelivery(started, 'run-1', reportNoRunTelemetry());
    expect(settled).toMatchObject({ status: 'not_expected', crashWindow: false, attemptCount: 0 });
    expect(typeof settled.finalizedAt).toBe('number');
  });

  it('finalized-message reporting settles the Run with the default reporter', async () => {
    const run = { id: 'run-1', projectId: 'p', conversationId: 'c' };
    const finalize = vi.fn();
    const reportFinalized = createFinalizedMessageTelemetryReporter({
      design: {
        runs: {
          get: () => run,
          beginTelemetryDelivery: vi.fn(),
          finalizeTelemetryDelivery: finalize,
        },
      },
      db: null,
      dataDir,
      reportedRuns: new Set(),
    });
    reportFinalized(
      { id: 'm', role: 'assistant', runId: 'run-1', runStatus: 'succeeded', endedAt: 1, conversationId: 'c' },
      { telemetryFinalized: true },
    );
    await vi.waitFor(() => expect(finalize).toHaveBeenCalledTimes(1));
    expect(finalize.mock.calls[0]?.[1]).toMatchObject({
      langfuse_expected: false,
      langfuse_delivery_status: 'not_expected',
    });
  });
});
