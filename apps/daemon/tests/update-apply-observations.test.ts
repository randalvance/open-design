import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  classifyInstallerObservation,
  installerObservationRoot,
  normalizeUpdateObservationChannel,
  observePendingInstallerApplyAttempts,
  type InstallerObservationSummary,
} from '../src/migration/index.js';

function pendingSummary(overrides: Partial<InstallerObservationSummary> = {}): InstallerObservationSummary {
  return {
    arch: 'x64',
    artifactType: 'installer',
    attemptedAt: '2026-05-20T00:00:00.000Z',
    channel: 'beta',
    flowId: 'flow-1',
    fromVersion: '0.8.0-beta.5',
    kind: 'installer_apply_observation',
    namespace: 'release-beta-win',
    platform: 'win32',
    reason: 'installer_open_requested',
    result: 'pending',
    schemaVersion: 1,
    toVersion: '0.8.0-beta.6',
    updatedAt: '2026-05-20T00:00:00.000Z',
    ...overrides,
  };
}

async function writeSummary(dataRoot: string, summary: InstallerObservationSummary): Promise<string> {
  const filePath = path.join(installerObservationRoot(dataRoot), summary.flowId, 'summary.json');
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return filePath;
}

describe('update apply observations', () => {
  it('classifies next-launch version matches and unchanged versions', () => {
    const now = new Date('2026-05-20T00:03:00.000Z');
    expect(classifyInstallerObservation(pendingSummary(), {
      currentChannel: 'beta',
      currentVersion: '0.8.0-beta.6',
      namespace: 'release-beta-win',
      now,
    })).toMatchObject({
      elapsedBucket: 'lt_5m',
      reason: 'app_version_matches',
      result: 'success',
    });

    expect(classifyInstallerObservation(pendingSummary(), {
      currentChannel: 'beta',
      currentVersion: '0.8.0-beta.5',
      namespace: 'release-beta-win',
      now,
    })).toMatchObject({
      reason: 'app_version_unchanged',
      result: 'not_applied',
    });
  });

  it('classifies mismatched runtime identity without using raw paths or errors', () => {
    expect(classifyInstallerObservation(pendingSummary(), {
      currentChannel: 'stable',
      currentVersion: '0.8.0-beta.6',
      namespace: 'release-beta-win',
      now: new Date('2026-05-20T00:03:00.000Z'),
    })).toMatchObject({
      reason: 'identity_mismatch',
      result: 'unknown',
    });
  });

  it('normalizes prerelease and preview observation channels without collapsing them to beta', () => {
    expect(normalizeUpdateObservationChannel('0.8.0-prerelease.2')).toBe('prerelease');
    expect(normalizeUpdateObservationChannel('0.8.0-preview.2')).toBe('preview');
    expect(normalizeUpdateObservationChannel('0.8.0', 'prerelease')).toBe('prerelease');
  });

  it.each(['installer', 'payload'] as const)(
    'classifies a %s attempt locally and records that nothing was submitted',
    async (artifactType) => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'od-update-observe-'));
    try {
      const summaryPath = await writeSummary(dataRoot, pendingSummary({ artifactType }));

      await expect(observePendingInstallerApplyAttempts({
        currentChannel: 'beta',
        currentVersion: '0.8.0-beta.6',
        dataRoot,
        namespace: 'release-beta-win',
        now: () => new Date('2026-05-20T00:03:00.000Z'),
      })).resolves.toEqual({ observed: 1 });

      const updated = JSON.parse(await readFile(summaryPath, 'utf8')) as Record<string, unknown>;
      expect(updated).toMatchObject({
        delivery: {
          eventName: 'update_apply_observed',
          status: 'skipped_analytics_disabled',
        },
        elapsedBucket: 'lt_5m',
        reason: 'app_version_matches',
        result: 'success',
      });

      // Already-classified attempts are not reprocessed on a later boot.
      await expect(observePendingInstallerApplyAttempts({
        currentVersion: '0.8.0-beta.6',
        dataRoot,
        namespace: 'release-beta-win',
      })).resolves.toEqual({ observed: 0 });
    } finally {
      await rm(dataRoot, { force: true, recursive: true });
    }
  });
});
