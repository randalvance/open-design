import { SIDECAR_DEFAULTS } from '@open-design/sidecar-proto';
import { createAnalyticsService } from '../analytics.js';
import { readCurrentAppVersionInfo, UNKNOWN_APP_VERSION, type AppVersionInfo } from '../app-version.js';
import { observePendingInstallerApplyAttempts } from '../migration/index.js';

export interface DaemonTelemetry {
  analyticsService: ReturnType<typeof createAnalyticsService>;
  disposeFatalHandlers: () => void;
  getCachedAppVersion: () => any;
  resolveAppVersion: () => Promise<any>;
}

export interface CreateDaemonTelemetryDeps {
  dataDir: string;
  namespace?: string;
}

export function resolveInstallerObservationNamespace(namespace: string | undefined): string {
  return namespace ?? SIDECAR_DEFAULTS.namespace;
}

/**
 * Daemon process facts that older call sites reach through the telemetry object:
 * the no-op analytics service, the app version, and the fatal-exit handlers.
 * It registers no routes and sends nothing off the machine.
 */
export function createDaemonTelemetry(deps: CreateDaemonTelemetryDeps): DaemonTelemetry {
  const { dataDir } = deps;
  const analyticsService = createAnalyticsService({ dataDir });
  let cachedAppVersion: AppVersionInfo | null = null;

  const disposeFatalHandlers = installFatalHandlers({
    analyticsService,
    getAppVersion: () => cachedAppVersion,
  });

  const appVersionPromise = (async () => {
    try {
      cachedAppVersion = await readCurrentAppVersionInfo();
      void observePendingInstallerApplyAttempts({
        currentChannel: cachedAppVersion.channel,
        currentVersion: cachedAppVersion.version,
        dataRoot: dataDir,
        namespace: resolveInstallerObservationNamespace(deps.namespace),
      }).catch(() => {
        // Local update classification must not delay daemon version readiness.
      });
      return cachedAppVersion;
    } catch {
      return null;
    }
  })();

  return {
    analyticsService,
    disposeFatalHandlers,
    getCachedAppVersion: () => cachedAppVersion,
    resolveAppVersion: () => appVersionPromise,
  };
}

function installFatalHandlers({
  analyticsService,
  getAppVersion,
}: {
  analyticsService: ReturnType<typeof createAnalyticsService>;
  getAppVersion: () => any;
}): () => void {
  const FATAL_FLUSH_TIMEOUT_MS = 1000;
  let fatalShuttingDown = false;
  const triggerFatalShutdown = (
    eventName: string,
    properties: Record<string, unknown>,
  ): void => {
    if (fatalShuttingDown) return;
    fatalShuttingDown = true;
    const flushSequence = (async () => {
      try {
        await analyticsService.captureSafety({
          eventName,
          appVersion: getAppVersion()?.version ?? UNKNOWN_APP_VERSION,
          properties,
        });
      } catch {
        // capture must never block the exit path
      }
      await analyticsService.shutdown();
    })();
    void Promise.race([
      flushSequence,
      new Promise<void>((resolve) => {
        const handle = setTimeout(resolve, FATAL_FLUSH_TIMEOUT_MS);
        handle.unref?.();
      }),
    ]).finally(() => {
      process.exitCode = 1;
      process.exit(1);
    });
  };
  const onUncaughtException = (error: Error) => {
    console.error('[daemon] uncaught exception', error);
    triggerFatalShutdown('daemon_uncaught_exception', {
      error_message: error?.message ?? String(error),
      error_name: error?.name ?? 'Error',
      error_stack: typeof error?.stack === 'string' ? error.stack.slice(0, 8192) : undefined,
    });
  };
  const onUnhandledRejection = (reason: unknown) => {
    console.error('[daemon] unhandled rejection', reason);
    const asError = reason instanceof Error ? reason : null;
    triggerFatalShutdown('daemon_unhandled_rejection', {
      error_message: asError?.message ?? (typeof reason === 'string' ? reason : String(reason)),
      error_name: asError?.name ?? 'NonErrorRejection',
      error_stack: typeof asError?.stack === 'string' ? asError.stack.slice(0, 8192) : undefined,
    });
  };
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    process.off('uncaughtException', onUncaughtException);
    process.off('unhandledRejection', onUnhandledRejection);
  };
}
