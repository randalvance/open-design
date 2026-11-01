import express, { type Express, type Request } from 'express';
import {
  ATTRIBUTION_CLAIM_PATH,
  type AttributionClaimResponse,
  type AttributionClaimSource,
} from '@open-design/contracts';

export interface RegisterAttributionRoutesDeps {
  http: {
    isLocalSameOrigin: (req: Request, port: number) => boolean;
    resolvedPortRef: { current: number };
  };
}

/**
 * Download attribution used to consume its token against a remote ledger and
 * mint tracked links there. Both routes stay so existing callers keep getting a
 * valid answer, but neither reads local identity nor makes a network request.
 * `{ url: null }` tells the web client to open the original URL unchanged.
 */
export function registerAttributionRoutes(app: Express, deps: RegisterAttributionRoutesDeps): void {
  app.post(ATTRIBUTION_CLAIM_PATH, express.json({ limit: '16kb' }), (req, res) => {
    if (!deps.http.isLocalSameOrigin(req, deps.http.resolvedPortRef.current)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const claim = req.body;
    if (claim == null || typeof claim !== 'object' || Array.isArray(claim) || !isSource(claim.source)) {
      return res.status(400).json(response('invalid'));
    }
    res.json(response(isValidToken(claim.token) ? 'pending_consent' : 'invalid'));
  });
  app.post('/api/attribution/bridge-url', express.json({ limit: '8kb' }), (req, res) => {
    if (!deps.http.isLocalSameOrigin(req, deps.http.resolvedPortRef.current)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const url = req.body && typeof req.body === 'object' && typeof req.body.url === 'string'
      ? req.body.url
      : null;
    if (!url) return res.status(400).json({ error: 'invalid_url' });
    res.json({ url: null });
  });
}

function isSource(value: unknown): value is AttributionClaimSource {
  return value === 'mac_where_froms'
    || value === 'windows_zone_identifier'
    || value === 'installer_observation_file'
    || value === 'manual';
}

function isValidToken(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(value.trim());
}

function response(status: AttributionClaimResponse['status']): AttributionClaimResponse {
  return { ok: true, status, found: status === 'pending_consent', pending: status === 'pending_consent', merged: false };
}
