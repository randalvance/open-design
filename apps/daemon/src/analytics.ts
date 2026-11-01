// Daemon-side analytics surface. Nothing here can leave the machine: there is no
// analytics client and no outbound request. Call sites stay in place, and
// `createAnalyticsService` always returns the no-op service.
//
// `readAnalyticsContext` still reads the x-od-analytics-* request headers because
// local Run bookkeeping and login correlation consume that shape.

import crypto from 'node:crypto';
import type { Request } from 'express';
import {
  ANALYTICS_HEADER_DEVICE_ID,
  ANALYTICS_HEADER_CLIENT_TYPE,
  ANALYTICS_HEADER_ATTRIBUTION_QUALITY,
  ANALYTICS_HEADER_DISTRIBUTION_MECHANISM,
  ANALYTICS_HEADER_ENTRY_SURFACE,
  ANALYTICS_HEADER_EXTERNAL_PLUGIN_ID,
  ANALYTICS_HEADER_EXTERNAL_PLUGIN_VERSION,
  ANALYTICS_HEADER_HOST_PRODUCT,
  ANALYTICS_HEADER_LOCALE,
  ANALYTICS_HEADER_MCP_SESSION_ID,
  ANALYTICS_HEADER_PUBLISHER_CLASS,
  ANALYTICS_HEADER_REQUEST_ID,
  ANALYTICS_HEADER_SESSION_ID,
  anonymizeArtifactId as anonymizeArtifactIdShared,
  type AnalyticsClientType,
  type AnalyticsAttributionQuality,
  type AnalyticsDistributionMechanism,
  type AnalyticsEntrySurface,
  type AnalyticsHostProduct,
  type AnalyticsPublisherClass,
} from '@open-design/contracts/analytics';

export interface AnalyticsContext {
  deviceId: string;
  sessionId: string;
  clientType: AnalyticsClientType;
  locale: string;
  requestId: string | null;
  entrySurface?: AnalyticsEntrySurface;
  hostProduct?: AnalyticsHostProduct;
  externalPluginId?: string;
  externalPluginVersion?: string;
  distributionMechanism?: AnalyticsDistributionMechanism;
  publisherClass?: AnalyticsPublisherClass;
  attributionQuality?: AnalyticsAttributionQuality;
  mcpSessionId?: string;
}

// Read context from an incoming request. Returns null when the web client did
// not include analytics headers (likely because analytics is disabled on the
// web side too). Daemon-internal capture sites (e.g. background sweeps with
// no request) should not invoke this path.
export function readAnalyticsContext(req: Request): AnalyticsContext | null {
  const deviceId = headerString(req, ANALYTICS_HEADER_DEVICE_ID);
  if (!deviceId) return null;
  const sessionId = headerString(req, ANALYTICS_HEADER_SESSION_ID) ?? deviceId;
  const clientHeader = headerString(req, ANALYTICS_HEADER_CLIENT_TYPE);
  const clientType: AnalyticsClientType =
    clientHeader === 'desktop'
      ? 'desktop'
      : clientHeader === 'external_mcp'
        ? 'external_mcp'
        : 'web';
  const locale = headerString(req, ANALYTICS_HEADER_LOCALE) ?? 'en';
  const requestId = headerString(req, ANALYTICS_HEADER_REQUEST_ID);
  const entrySurface = boundedHeader(
    req,
    ANALYTICS_HEADER_ENTRY_SURFACE,
    ['open_design_ui', 'od_cli', 'external_mcp'] as const,
  );
  const hostProduct = boundedHeader(
    req,
    ANALYTICS_HEADER_HOST_PRODUCT,
    ['codex_desktop', 'codex_cli', 'codex_unknown', 'claude_code', 'unknown'] as const,
  );
  const distributionMechanism = boundedHeader(
    req,
    ANALYTICS_HEADER_DISTRIBUTION_MECHANISM,
    ['git_marketplace', 'local_repo', 'manual', 'unknown'] as const,
  );
  const publisherClass = boundedHeader(
    req,
    ANALYTICS_HEADER_PUBLISHER_CLASS,
    ['open_design_first_party', 'third_party', 'unknown'] as const,
  );
  const attributionQuality = boundedHeader(
    req,
    ANALYTICS_HEADER_ATTRIBUTION_QUALITY,
    ['self_reported', 'session_correlated'] as const,
  );
  const externalPluginId = boundedFreeTextHeader(
    req,
    ANALYTICS_HEADER_EXTERNAL_PLUGIN_ID,
  );
  const externalPluginVersion = boundedFreeTextHeader(
    req,
    ANALYTICS_HEADER_EXTERNAL_PLUGIN_VERSION,
  );
  const mcpSessionId = boundedFreeTextHeader(
    req,
    ANALYTICS_HEADER_MCP_SESSION_ID,
  );
  return {
    deviceId,
    sessionId,
    clientType,
    locale,
    requestId,
    ...(entrySurface ? { entrySurface } : {}),
    ...(hostProduct ? { hostProduct } : {}),
    ...(externalPluginId ? { externalPluginId } : {}),
    ...(externalPluginVersion ? { externalPluginVersion } : {}),
    ...(distributionMechanism ? { distributionMechanism } : {}),
    ...(publisherClass ? { publisherClass } : {}),
    ...(attributionQuality ? { attributionQuality } : {}),
    ...(mcpSessionId ? { mcpSessionId } : {}),
  };
}

function headerString(req: Request, name: string): string | null {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0]?.trim() || null;
  if (typeof raw === 'string') return raw.trim() || null;
  return null;
}

function boundedHeader<const Values extends readonly string[]>(
  req: Request,
  name: string,
  values: Values,
): Values[number] | undefined {
  const value = headerString(req, name);
  return value && values.includes(value) ? value : undefined;
}

function boundedFreeTextHeader(req: Request, name: string): string | undefined {
  const value = headerString(req, name);
  if (!value || value.length > 128 || !/^[A-Za-z0-9._:@/-]+$/u.test(value)) {
    return undefined;
  }
  return value;
}

export type AnalyticsCaptureErrorType =
  | 'not_configured'
  | 'metrics_consent_disabled'
  | 'config_read_failed'
  | 'enqueue_failed';

export interface AnalyticsCaptureResult {
  status: 'queued' | 'not_expected' | 'failed';
  acknowledgement: 'local_buffer' | 'none';
  errorType: AnalyticsCaptureErrorType | null;
}

export function normalizeAnalyticsCaptureResult(value: unknown): AnalyticsCaptureResult {
  if (value && typeof value === 'object') {
    const candidate = value as Partial<AnalyticsCaptureResult>;
    if (
      (candidate.status === 'queued'
        || candidate.status === 'not_expected'
        || candidate.status === 'failed')
      && (candidate.acknowledgement === 'local_buffer'
        || candidate.acknowledgement === 'none')
    ) {
      return {
        status: candidate.status,
        acknowledgement: candidate.acknowledgement,
        errorType: candidate.errorType ?? null,
      };
    }
  }
  // Compatibility for injected capture implementations that return nothing.
  return {
    status: 'queued',
    acknowledgement: 'local_buffer',
    errorType: null,
  };
}

export interface AnalyticsService {
  capture(args: {
    eventName: string;
    context: AnalyticsContext;
    appVersion: string;
    properties: Record<string, unknown>;
    insertId: string;
  }): Promise<AnalyticsCaptureResult>;
  captureSafety(args: {
    eventName: string;
    distinctId?: string;
    appVersion: string;
    properties: Record<string, unknown>;
    insertId?: string;
  }): Promise<void>;
  mergeAnonymousPerson(args: {
    anonymousDistinctId: string;
    distinctId: string;
    properties?: Record<string, unknown>;
    insertId?: string;
  }): Promise<void>;
  identifyGroup(args: {
    context: AnalyticsContext;
    groupType: 'workspace';
    groupKey: string;
    properties: Record<string, unknown>;
  }): Promise<void>;
  shutdown(): Promise<void>;
}

const NOOP_SERVICE: AnalyticsService = {
  capture: async () => ({
    status: 'not_expected',
    acknowledgement: 'none',
    errorType: 'not_configured',
  }),
  captureSafety: async () => undefined,
  mergeAnonymousPerson: async () => undefined,
  identifyGroup: async () => undefined,
  shutdown: async () => undefined,
};

/** Always the no-op service: no analytics client exists, whatever the environment holds. */
export function createAnalyticsService(_args: {
  env?: NodeJS.ProcessEnv;
  packagedRuntime?: boolean;
  dataDir: string;
}): AnalyticsService {
  return NOOP_SERVICE;
}

// Re-export so server.ts and route handlers don't need a second import
// path; the canonical hash lives in @open-design/contracts/analytics so
// the web bundle produces the same id for the same (projectId, fileName).
export const anonymizeArtifactId = anonymizeArtifactIdShared;

// Generate a fresh insert_id when the request didn't carry one. Used for
// daemon-internal events where there is no matching web emission.
export function newInsertId(): string {
  return crypto.randomUUID();
}
