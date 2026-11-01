import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ATTRIBUTION_CLAIM_PATH } from '@open-design/contracts';

import { registerAttributionRoutes } from '../src/routes/attribution.js';

describe('download attribution routes', () => {
  let server: Server;
  let base: string;
  let allowLocal: boolean;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    allowLocal = true;
    const app = express();
    registerAttributionRoutes(app, {
      http: { isLocalSameOrigin: () => allowLocal, resolvedPortRef: { current: 1 } },
    });
    server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (route: string, body: unknown) => realFetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('answers a valid claim locally without any outbound request', async () => {
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    const response = await post(ATTRIBUTION_CLAIM_PATH, { source: 'manual', token: 'odtoken_123456' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true, status: 'pending_consent', found: true, pending: true, merged: false,
    });
    expect(outbound).not.toHaveBeenCalled();
  });

  it('rejects a malformed claim', async () => {
    expect((await post(ATTRIBUTION_CLAIM_PATH, { source: 'nope', token: 'odtoken_123456' })).status).toBe(400);
    const badToken = await post(ATTRIBUTION_CLAIM_PATH, { source: 'manual', token: 'bad token' });
    expect(await badToken.json()).toMatchObject({ status: 'invalid', found: false });
  });

  it('never mints a tracked link, so the web client opens the original URL', async () => {
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    const response = await post('/api/attribution/bridge-url', { url: 'https://open-design.ai/pricing' });
    expect(await response.json()).toEqual({ url: null });
    expect(outbound).not.toHaveBeenCalled();
    expect((await post('/api/attribution/bridge-url', {})).status).toBe(400);
  });

  it('keeps the same-origin gate', async () => {
    allowLocal = false;
    expect((await post(ATTRIBUTION_CLAIM_PATH, { source: 'manual', token: 'odtoken_123456' })).status).toBe(403);
    expect((await post('/api/attribution/bridge-url', { url: 'https://open-design.ai/' })).status).toBe(403);
  });
});
