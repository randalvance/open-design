import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  TrackingUpdateApplyElapsedBucket,
  TrackingUpdateApplyReason,
  TrackingUpdateApplyResult,
} from '@open-design/contracts/analytics';
import {
  isReleaseChannel,
  releaseChannelFromVersion,
  type ReleaseChannel,
} from '@open-design/release';


const INSTALLER_OBSERVATION_SCHEMA_VERSION = 1;
const INSTALLER_OBSERVATION_KIND = 'installer_apply_observation';
const INSTALLER_OBSERVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type InstallerObservationArtifactType = 'dmg' | 'installer' | 'payload';
type InstallerObservationChannel = ReleaseChannel;
type InstallerObservationDeliveryStatus =
  | 'submitted'
  | 'skipped_analytics_disabled'
  | 'skipped_missing_identity'
  | 'skipped_no_consent'
  | 'failed';

export type InstallerObservationSummary = {
  arch: string;
  artifactType: InstallerObservationArtifactType;
  attemptedAt: string;
  channel: InstallerObservationChannel;
  delivery?: {
    eventName: 'update_apply_observed';
    insertId?: string;
    status: InstallerObservationDeliveryStatus;
    updatedAt: string;
  };
  elapsedBucket?: TrackingUpdateApplyElapsedBucket;
  flowId: string;
  fromVersion: string;
  kind: typeof INSTALLER_OBSERVATION_KIND;
  namespace: string;
  observedAt?: string;
  platform: string;
  reason: 'installer_open_requested' | 'installer_open_failed' | TrackingUpdateApplyReason;
  result: 'pending' | TrackingUpdateApplyResult;
  schemaVersion: typeof INSTALLER_OBSERVATION_SCHEMA_VERSION;
  toVersion: string;
  updatedAt: string;
};

export type InstallerObservationClassification = {
  elapsedBucket: TrackingUpdateApplyElapsedBucket;
  reason: TrackingUpdateApplyReason;
  result: TrackingUpdateApplyResult;
};

export type ObservePendingInstallerApplyAttemptsOptions = {
  currentChannel?: string | null;
  currentVersion: string;
  dataRoot: string;
  namespace: string;
  now?: () => Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function isSafeFlowId(flowId: string): boolean {
  return (
    flowId.length > 0 &&
    flowId.length <= 128 &&
    flowId !== '.' &&
    flowId !== '..' &&
    /^[A-Za-z0-9._-]+$/.test(flowId)
  );
}

function isInstallerObservationSummary(value: unknown): value is InstallerObservationSummary {
  if (!isRecord(value)) return false;
  const artifactType = value.artifactType;
  const channel = value.channel;
  const result = value.result;
  return (
    value.schemaVersion === INSTALLER_OBSERVATION_SCHEMA_VERSION &&
    value.kind === INSTALLER_OBSERVATION_KIND &&
    typeof value.flowId === 'string' &&
    isSafeFlowId(value.flowId) &&
    typeof value.namespace === 'string' &&
    isReleaseChannel(channel) &&
    typeof value.platform === 'string' &&
    typeof value.arch === 'string' &&
    (artifactType === 'dmg' || artifactType === 'installer' || artifactType === 'payload') &&
    typeof value.fromVersion === 'string' &&
    typeof value.toVersion === 'string' &&
    typeof value.attemptedAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (result === 'pending' || result === 'success' || result === 'not_applied' || result === 'unknown') &&
    typeof value.reason === 'string'
  );
}

export function installerObservationRoot(dataRoot: string): string {
  return path.join(dataRoot, 'observations', 'installer');
}

function summaryPath(root: string, flowId: string): string {
  if (!isSafeFlowId(flowId)) throw new Error(`unsafe installer observation flow_id: ${flowId}`);
  return path.join(root, flowId, 'summary.json');
}

async function readSummary(filePath: string): Promise<InstallerObservationSummary | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    return isInstallerObservationSummary(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeSummary(filePath: string, summary: InstallerObservationSummary): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await rename(tmpPath, filePath);
}

export function normalizeUpdateObservationChannel(version: string, explicit?: string | null): InstallerObservationChannel {
  if (explicit != null && explicit.startsWith('beta')) return 'beta';
  if (explicit != null && explicit.startsWith('preview')) return 'preview';
  if (explicit != null && explicit.startsWith('prerelease')) return 'prerelease';
  if (isReleaseChannel(explicit)) return explicit;
  const cleaned = version.trim().replace(/^v/i, '');
  const prerelease = cleaned.split('-', 2)[1] ?? '';
  const channel = releaseChannelFromVersion(version);
  if (channel != null) return channel;
  if (prerelease.length > 0 && /\.[0-9]+$/.test(prerelease)) return 'beta';
  return 'stable';
}

export function elapsedBucket(elapsedMs: number): TrackingUpdateApplyElapsedBucket {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 'unknown';
  if (elapsedMs < 5 * 60 * 1000) return 'lt_5m';
  if (elapsedMs < 60 * 60 * 1000) return '5m_1h';
  if (elapsedMs < 6 * 60 * 60 * 1000) return '1h_6h';
  if (elapsedMs < 24 * 60 * 60 * 1000) return '6h_24h';
  if (elapsedMs < INSTALLER_OBSERVATION_TTL_MS) return '1d_7d';
  return 'gt_7d';
}

export function classifyInstallerObservation(
  summary: InstallerObservationSummary,
  options: {
    currentChannel: InstallerObservationChannel;
    currentVersion: string;
    namespace: string;
    now: Date;
    ttlMs?: number;
  },
): InstallerObservationClassification {
  const attemptedAtMs = Date.parse(summary.attemptedAt);
  const elapsedMs = Number.isFinite(attemptedAtMs) ? options.now.getTime() - attemptedAtMs : Number.NaN;
  const bucket = elapsedBucket(elapsedMs);
  if (summary.namespace !== options.namespace || summary.channel !== options.currentChannel) {
    return { elapsedBucket: bucket, result: 'unknown', reason: 'identity_mismatch' };
  }
  if (options.currentVersion === summary.toVersion) {
    return { elapsedBucket: bucket, result: 'success', reason: 'app_version_matches' };
  }
  if (options.currentVersion === summary.fromVersion) {
    return { elapsedBucket: bucket, result: 'not_applied', reason: 'app_version_unchanged' };
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs >= (options.ttlMs ?? INSTALLER_OBSERVATION_TTL_MS)) {
    return { elapsedBucket: bucket, result: 'unknown', reason: 'expired' };
  }
  return { elapsedBucket: bucket, result: 'unknown', reason: 'identity_mismatch' };
}

export async function observePendingInstallerApplyAttempts(
  options: ObservePendingInstallerApplyAttemptsOptions,
): Promise<{ observed: number }> {
  const now = options.now?.() ?? new Date();
  const observedAt = now.toISOString();
  const root = installerObservationRoot(options.dataRoot);
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { observed: 0 };
  }

  const summaries: Array<{ filePath: string; summary: InstallerObservationSummary }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeFlowId(entry.name)) continue;
    const filePath = summaryPath(root, entry.name);
    const summary = await readSummary(filePath);
    if (summary == null || summary.result !== 'pending' || summary.delivery != null) continue;
    if (summary.flowId !== entry.name) continue;
    summaries.push({ filePath, summary });
  }
  if (summaries.length === 0) return { observed: 0 };

  const currentChannel = normalizeUpdateObservationChannel(options.currentVersion, options.currentChannel);
  let observed = 0;
  for (const { filePath, summary } of summaries) {
    const classification = classifyInstallerObservation(summary, {
      currentChannel,
      currentVersion: options.currentVersion,
      namespace: options.namespace,
      now,
    });
    const next: InstallerObservationSummary = {
      ...summary,
      delivery: { eventName: 'update_apply_observed', status: 'skipped_analytics_disabled', updatedAt: observedAt },
      elapsedBucket: classification.elapsedBucket,
      observedAt,
      reason: classification.reason,
      result: classification.result,
      updatedAt: observedAt,
    };
    await writeSummary(filePath, next);
    observed += 1;
  }
  return { observed };
}
