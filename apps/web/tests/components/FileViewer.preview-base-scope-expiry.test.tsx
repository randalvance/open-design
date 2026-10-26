// @vitest-environment jsdom
//
// Regression: the URL-load preview base is a SHORT-LIVED capability, but the
// viewer treats it as permanent.
//
// The daemon-served preview document announces its minted scope through
// `od:preview-base-scope`; that scope expires after PROJECT_PREVIEW_SCOPE_TTL_MS
// (1 hour) and dies outright when the daemon restarts. EVERY relative asset in
// the artifact (`./assets/qr.png`, component chunks, media) resolves through
// that scope, so once it expires the preview comes back with its images and
// components broken while the HTML body itself renders fine.
//
// The user-visible shape: leave a preview open past the TTL (or restart the
// app), let the agent write a new revision, and every relative-path image
// 404s while inline `data:` images still render.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import type { ProjectFile } from '../../src/types';

const START_TIME = new Date('2026-08-20T10:00:00Z').getTime();
// Daemon-side PROJECT_PREVIEW_SCOPE_TTL_MS (apps/daemon/src/server.ts).
const PREVIEW_SCOPE_TTL_MS = 60 * 60 * 1000;
const PREVIEW_SCOPE_RENEW_MARGIN_MS = 5 * 60 * 1000;

function renderViewer(ui: ReactElement) {
  return render(ui);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(START_TIME);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deckFile(overrides: Partial<ProjectFile> = {}): ProjectFile {
  return {
    name: 'deck.html',
    path: 'deck.html',
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    kind: 'html',
    mime: 'text/html',
    artifactManifest: {
      version: 1,
      kind: 'deck',
      title: 'Deck',
      entry: 'deck.html',
      renderer: 'deck-html',
      exports: ['html'],
    },
    ...overrides,
  };
}

function htmlFile(overrides: Partial<ProjectFile> = {}): ProjectFile {
  return {
    name: 'deck.html',
    path: 'deck.html',
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    kind: 'html',
    mime: 'text/html',
    artifactManifest: {
      version: 1,
      kind: 'html',
      title: 'Page',
      entry: 'deck.html',
      renderer: 'html',
      exports: ['html'],
    },
    ...overrides,
  };
}

const DECK_RAW_URL = '/api/projects/project-1/raw/deck.html';
const PREVIEW_URL_ROUTE = '/api/projects/project-1/preview-url';

// A deck slide that references a project asset by relative path — the exact
// shape that depends on the minted base resolving.
function deckHtml(label: string): string {
  return `<html><body><section class="slide">`
    + `<h1>${label}</h1><img src="./assets/qr.png" alt="qr">`
    + `</section><section class="slide"><p>two</p></section></body></html>`;
}

/**
 * Fetch stub that mints a fresh scope id per `/preview-url` call, so the test
 * can tell a re-mint (scope-2) apart from a reused stale base (scope-1).
 */
function stubFetch(html: () => string) {
  const state = { mintCount: 0, renewCount: 0, failRenewal: false };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof Request ? input.url : String(input);
    if (url.startsWith(PREVIEW_URL_ROUTE)) {
      state.mintCount += 1;
      return new Response(
        JSON.stringify({
          url: `/api/projects/project-1/preview/scope-000${state.mintCount}/deck.html`,
          file: 'deck.html',
          csp: '',
          iframeSandbox: 'allow-scripts allow-forms',
          opaqueOrigin: true,
          expiresAt: Date.now() + PREVIEW_SCOPE_TTL_MS,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (/\/preview\/scope-\d+\/renew$/u.test(url)) {
      state.renewCount += 1;
      if (state.failRenewal) return new Response('', { status: 404 });
      return new Response(
        JSON.stringify({ expiresAt: Date.now() + PREVIEW_SCOPE_TTL_MS }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.startsWith(DECK_RAW_URL)) return new Response(html(), { status: 200 });
    return new Response('', { status: 404 });
  }));
  return state;
}

function srcDocBaseHref(): string | null {
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  return (frame.getAttribute('srcDoc') ?? '').match(/<base href="([^"]*)"/i)?.[1] ?? null;
}

function verifySrcDocTransport(frame: HTMLIFrameElement) {
  const generation = frame.srcdoc.match(
    /data-od-srcdoc-transport-activation>[\s\S]*?var generation = "([^"]+)";/,
  )?.[1];
  expect(generation).toBeTruthy();
  const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
  fireEvent.load(frame);
  const probe = postMessage.mock.calls.find(
    ([message]) => (message as { type?: unknown }).type === 'od:srcdoc-transport-ready-probe',
  )?.[0] as { probeId?: string } | undefined;
  expect(probe?.probeId).toBeTruthy();
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      data: {
        type: 'od:srcdoc-transport-activated',
        generation,
        probeId: probe!.probeId,
        bodyComplete: true,
      },
    }));
  });
  postMessage.mockClear();
  return postMessage;
}

describe('FileViewer URL-load preview base expiry', () => {

  it('renews the daemon-injected URL-load scope without navigating the iframe', async () => {
    const fetchState = stubFetch(() => '<html><body><main>URL loaded</main></body></html>');

    renderViewer(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlFile()}
        liveHtml="<html><body><main>URL loaded</main></body></html>"
      />,
    );

    const frame = await waitFor(() => {
      const current = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
      expect(current.getAttribute('data-od-render-mode')).toBe('url-load');
      return current;
    });
    const initialSrc = frame.getAttribute('src');
    fireEvent.load(frame);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          type: 'od:preview-base-scope',
          href: '/api/projects/project-1/preview/scope-0999/',
          expiresAt: Date.now() + PREVIEW_SCOPE_TTL_MS,
        },
      }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        PREVIEW_SCOPE_TTL_MS - PREVIEW_SCOPE_RENEW_MARGIN_MS,
      );
    });

    expect(fetchState.renewCount).toBe(1);
    expect(fetchState.mintCount).toBe(0);
    expect(screen.getByTestId('artifact-preview-frame')).toBe(frame);
    expect(frame.getAttribute('src')).toBe(initialSrc);
  });

  it('replaces a lost URL-load scope by messaging the live document', async () => {
    const fetchState = stubFetch(() => '<html><body><main>URL loaded</main></body></html>');

    renderViewer(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlFile()}
        liveHtml="<html><body><main>URL loaded</main></body></html>"
      />,
    );

    const frame = await waitFor(() => {
      const current = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
      expect(current.getAttribute('data-od-render-mode')).toBe('url-load');
      return current;
    });
    const initialSrc = frame.getAttribute('src');
    fireEvent.load(frame);
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          type: 'od:preview-base-scope',
          href: '/api/projects/project-1/preview/scope-0999/',
          expiresAt: Date.now() + PREVIEW_SCOPE_TTL_MS,
        },
      }));
    });
    fetchState.failRenewal = true;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        PREVIEW_SCOPE_TTL_MS - PREVIEW_SCOPE_RENEW_MARGIN_MS,
      );
    });

    expect(fetchState.renewCount).toBe(1);
    expect(fetchState.mintCount).toBe(1);
    expect(screen.getByTestId('artifact-preview-frame')).toBe(frame);
    expect(frame.getAttribute('src')).toBe(initialSrc);
    expect(postMessage.mock.calls.some(([message]) => {
      const data = message as { type?: unknown; href?: unknown };
      return data.type === 'od:preview-base-update'
        && data.href === 'http://localhost:3000/api/projects/project-1/preview/scope-0001/';
    })).toBe(true);
  });

});
