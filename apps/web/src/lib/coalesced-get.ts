// Client-side GET coalescer: collapse a burst of identical reads into one
// network request.
//
// Why this exists: many workspace surfaces independently fetch the same read
// endpoint on mount/navigation — the project grid, the recents strip, the
// design-files panel. Returning to the home view fired ~118 concurrent requests, of which
// the same 8 projects' `/files` appeared 4-6× each and every project's
// `/live-artifacts` twice. With the browser's ~6-connections-per-host cap the
// tail of that burst sat in the connection queue for seconds — measured as
// Σblocked (≈330-494s) an order of magnitude larger than Σserver-wait (≈27-36s).
// The server was not slow; the client simply asked too many times at once.
//
// This helper keys identical in-flight GETs to a single shared promise
// (single-flight, no matter how long the request is queued) and briefly shares
// the settled result, so a mount burst that used to cost N requests costs one.
// It changes no server behavior and is safe only for idempotent display reads
// where sub-second staleness is invisible (covers, thumbnails, the nav shell).

type Entry<T> = { value: Promise<T>; settledAt: number | null };

const entries = new Map<string, Entry<unknown>>();

const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

// Long enough to absorb a mount/navigation burst (observed ~300-500ms of
// staggered mounts plus multi-second connection queuing), short enough that an
// explicit reload a second later still hits the network.
const DEFAULT_TTL_MS = 1000;

/**
 * Run `run()` at most once per `key` per burst. While a call is in flight, every
 * identical `key` joins the same promise regardless of how long it is queued.
 * After it settles successfully, callers within `ttlMs` share the cached result;
 * after that window (or on failure) the next caller refetches.
 */
export function coalescedGet<T>(
  key: string,
  run: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T> {
  const existing = entries.get(key) as Entry<T> | undefined;
  if (existing) {
    // Still in flight → always join, so a slow/queued request never spawns a
    // duplicate. Settled recently → serve the shared result.
    if (existing.settledAt === null) return existing.value;
    if (nowMs() - existing.settledAt < ttlMs) return existing.value;
  }

  const entry: Entry<T> = { value: run(), settledAt: null };
  entries.set(key, entry as Entry<unknown>);
  entry.value.then(
    () => {
      entry.settledAt = nowMs();
      // Evict once the share window passes so long-lived reads stay fresh. Guard
      // against evicting a newer entry that replaced this one.
      setTimeout(() => {
        if (entries.get(key) === (entry as Entry<unknown>)) entries.delete(key);
      }, ttlMs);
    },
    () => {
      // Never cache a failure — the next caller/poll should retry immediately.
      if (entries.get(key) === (entry as Entry<unknown>)) entries.delete(key);
    },
  );
  return entry.value;
}

/**
 * Drop one key's in-flight/settled entry so the next call goes to the network.
 *
 * For callers that KNOW the cached answer is void, not a routine revalidation.
 *
 * Evicting an IN-FLIGHT entry is deliberate too — that request may have been
 * issued before the change and cannot see it.
 */
export function evictCoalescedGet(key: string): void {
  entries.delete(key);
}

/**
 * Drop every in-flight/settled entry. The module-level cache would otherwise
 * leak a settled result from one test into the next same-key call within the
 * share window; a global test `beforeEach` calls this so each test starts clean.
 */
export function resetCoalescedGet(): void {
  entries.clear();
}
