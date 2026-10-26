/**
 * Classify a failed publish/unpublish error into a stable, queryable analytics
 * code for `artifact_publish_result.error_code`.
 *
 * Only FIXED codes are emitted — no message text can leak into analytics.
 * With the cloud share relay gone there is no workspace-identity failure
 * class left to single out, so every failure buckets to `publish_failed`.
 *
 * Mirrors apps/web/src/analytics/deploy-error-code.ts (issue-#5220 pattern).
 */

import type { TrackingPublishErrorCode } from '@open-design/contracts/analytics';

export function publishErrorCode(_err: unknown): TrackingPublishErrorCode {
  return 'publish_failed';
}
