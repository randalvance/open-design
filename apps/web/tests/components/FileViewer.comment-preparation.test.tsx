// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import { invalidateHtmlSourceSnapshotProject } from '../../src/components/html-source-snapshot-cache';
const source = '<html><body><h2>Authored target</h2></body></html>';
function setup(options: { readonly?: boolean; streaming?: boolean; fail?: boolean; success?: boolean; bom?: boolean; proofUnavailable?: boolean } = {}) {
  const writes = vi.fn();
  let serverSource = (options.bom ? '\uFEFF' : '') + source;
  const preparedSource = serverSource.replace('<h2>', '<h2 data-od-comment-id="12345678-1234-4234-8234-123456789abc">');
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && !url.endsWith('/share-plan')) writes(url, init);
    if (url.includes('comment-identities/prepare')) {
      if (!options.success) return Response.json({ error: { code: 'COMMENT_VERSION_UNCONFIRMED' } }, { status: 500 });
      serverSource = preparedSource;
      return Response.json({ source: preparedSource, changed: true, preparedTargets: 1, version: { id: 'source-version-2', version: 2 } });
    }
    const pathname = new URL(url, 'http://localhost').pathname;
    if (pathname.endsWith('/versions')) return options.proofUnavailable
      ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json({ versions: [] });
    if (pathname.endsWith('/raw/index.html') || pathname.endsWith('/files/index.html')) return new Response(serverSource);
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetcher);
  const tree = (streaming = Boolean(options.streaming)) => <>
    <FileViewer projectId="prep-project" projectKind="prototype" file={{ name: 'index.html', path: 'index.html', type: 'file', kind: 'html', mime: 'text/html', size: 100, mtime: 1 }} streaming={streaming} />
  </>;
  const view = render(tree());
  return { writes, fetcher, setStreaming: (value: boolean) => view.rerender(tree(value)) };
}

afterEach(() => { cleanup(); invalidateHtmlSourceSnapshotProject('prep-project'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([false, true])('viewing and enabling comments has no preparation dialog, status, retry or version reads (readonly=%s)', async readonly => {
  const { writes, fetcher } = setup({ readonly, proofUnavailable: true });
  await waitFor(() => expect((screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement).src).toContain('index.html'));
  expect(screen.queryByTestId('comment-identity-preparation')).toBeNull();
  expect(screen.queryByTestId('comment-identity-revalidate')).toBeNull();
  expect(screen.queryByRole('button', { name: /Prepare static comments/ })).toBeNull();
  fireEvent.click(screen.getByTestId('comment-panel-toggle'));
  expect(screen.getByTestId('comment-panel-toggle')).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(writes).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('/versions'))).toBe(false);
});
