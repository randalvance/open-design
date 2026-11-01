// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsProvider, useAnalytics, useAppVersion } from '../../src/analytics/provider';
import { observeAnalytics } from '../../src/analytics/observe';

vi.mock('../../src/i18n', () => ({ useI18n: () => ({ locale: 'en' }) }));
vi.mock('../../src/analytics/identity', () => ({
  getAnonymousId: () => 'device-test', getSessionId: () => 'session-test',
  detectClientType: () => 'web', isFirstSession: () => false,
}));

function Action() {
  const analytics = useAnalytics();
  const version = useAppVersion();
  const [status, setStatus] = useState('idle');
  return <button onClick={() => {
    observeAnalytics(() => analytics.track('surface_view', { area: 'share_guide' }));
    void fetch('/api/business', { method: 'POST', headers: { 'x-product': 'kept' }, body: 'payload' })
      .then(() => setStatus('done'));
  }}>{version}:{status}</button>;
}

const request = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.clearAllMocks();
  request.mockImplementation(async input => String(input) === '/api/version'
    ? Response.json({ version: { version: '1.2.3' } }) : Response.json({ ok: true }));
  vi.stubGlobal('fetch', request);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('real provider passive track task', () => {
  it('does not change or delay a business request', async () => {
    render(<AnalyticsProvider><Action /></AnalyticsProvider>);
    await screen.findByRole('button', { name: '1.2.3:idle' });
    await act(async () => { await Promise.resolve(); });
    const originalFetch = window.fetch;
    fireEvent.click(screen.getByRole('button', { name: '1.2.3:idle' }));
    await screen.findByRole('button', { name: '1.2.3:done' });
    expect(window.fetch).toBe(originalFetch);
    expect(request.mock.calls.filter(([url]) => url === '/api/business')).toEqual([
      ['/api/business', { method: 'POST', headers: { 'x-product': 'kept' }, body: 'payload' }],
    ]);
  });
});
