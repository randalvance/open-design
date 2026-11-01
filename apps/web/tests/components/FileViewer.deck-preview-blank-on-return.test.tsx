// @vitest-environment jsdom
// An empty deck file must not pin the loading cover: `previewSource` uses ''
// for "loaded, zero bytes" and null for "not ready yet".

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { resetSharedCancellableGet } from '../../src/lib/shared-cancellable-get';
import type { ProjectFile } from '../../src/types';
function deckFile(overrides: Partial<ProjectFile> = {}): ProjectFile {
  return {
    name: 'deck.html',
    path: 'deck.html',
    type: 'file',
    size: 2048,
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

/**
 * Fetch mock for a project whose deck HTML file is a legitimate ZERO-BYTE
 * file: `GET .../raw/deck.html` resolves 200 with an empty body, the project
 * file list resolves immediately (no stall, no relative assets),
 * everything else 404s.
 */
function installEmptyFileFetchMock(projectId: string) {
  const filesUrl = `/api/projects/${encodeURIComponent(projectId)}/files`;
  const rawUrl = `/api/projects/${encodeURIComponent(projectId)}/raw/deck.html`;
  const isFilesListUrl = (url: string) => url.split('?')[0] === filesUrl;
  const rawRequests: { url: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    if (isFilesListUrl(url)) {
      return new Response(
        JSON.stringify({ files: [deckFile({ size: 0 })] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.startsWith(rawUrl)) {
      rawRequests.push({ url });
      return new Response('', { status: 200 });
    }
    return new Response('', { status: 404 });
  }));
  return rawRequests;
}

function srcDocFrame(): HTMLIFrameElement {
  return screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
}

beforeEach(() => {
  resetSharedCancellableGet();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('deck preview loading cover', () => {
  it('drops the loading cover once a legitimately empty file has loaded, instead of pinning it forever', async () => {
    // Guards the other side of the cover condition: `previewSource` uses ''
    // for "loaded, zero bytes" and null for "not ready yet". A cover keyed on
    // srcDoc emptiness cannot tell those apart and would announce a permanent
    // `role="status"` / aria-busy loader over a file that finished loading
    // with no request in flight.
    const projectId = 'proj-deck-empty-file';
    const rawRequests = installEmptyFileFetchMock(projectId);

    render(
      <FileViewer projectId={projectId} projectKind="prototype" file={deckFile({ size: 0 })} isDeck />
    );

    // The zero-byte source load resolves on the srcDoc path…
    await waitFor(() => {
      expect(srcDocFrame().getAttribute('data-od-render-mode')).toBe('srcdoc');
      expect(rawRequests.length).toBeGreaterThanOrEqual(1);
    });

    // …and the loading cover must clear: the file IS loaded, nothing is in
    // flight, and the truthful render of an empty file is an empty document.
    await waitFor(() => {
      expect(screen.queryByTestId('artifact-preview-first-load')).toBeNull();
    });
    expect(srcDocFrame().getAttribute('srcdoc') ?? '').toBe('');
  });
});
