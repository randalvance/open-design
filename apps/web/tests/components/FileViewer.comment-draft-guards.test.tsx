// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { FileViewer } from '../../src/components/FileViewer';
import { invalidateHtmlSourceSnapshotProject } from '../../src/components/html-source-snapshot-cache';
import type { PreviewComment } from '../../src/types';
vi.mock('../../src/components/BoardComposerPopover', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/components/BoardComposerPopover')>();
  return { ...original, BoardComposerPopover: (props: { draft: string; onDraft: (value: string) => void; onSaveComment: () => void; onSendBatch: () => void;
    onAddDraft: () => void; onAttachImages: (files: File[]) => void; onRemoveImage: (index: number) => void }) => <div>
    <button data-testid="probe-queue" onClick={props.onAddDraft}>Queue</button>
    <button data-testid="probe-attach" onClick={() => props.onAttachImages([new File(['image'], 'new.png', { type: 'image/png' })])}>Attach</button>
    <button data-testid="probe-remove-image" onClick={() => props.onRemoveImage(0)}>Remove image</button>
    <input data-testid="probe-draft" value={props.draft} onChange={event => props.onDraft(event.target.value)} />
    <button data-testid="probe-send" onClick={props.onSendBatch}>Send</button>
    <button data-testid="probe-save" onClick={props.onSaveComment}>Save</button>
  </div> };
});
const uuid = '12345678-1234-4234-8234-123456789abc';
const original = '<html><body><h2 data-od-id="tool">Target</h2></body></html>';
const prepared = original.replace('<h2 ', `<h2 data-od-comment-id="${uuid}" `);
const target = { elementId: 'tool', selector: '[data-od-id="tool"]', label: 'h2', text: 'Target', htmlHint: '<h2>', position: { x: 20, y: 30, width: 100, height: 40 } };
let projectSequence = 0;
let currentProjectId = '';
function setup(options: { history?: PreviewComment[]; currentPrepared?: boolean; srcdoc?: boolean } = {}) {
  const projectId = currentProjectId = `barrier-project-${++projectSequence}`;
  let editedSource: string | null = null;
  let mtime = 1;
  let filesRefreshKey = 0;
  const currentSource = () => editedSource ?? (options.currentPrepared ? prepared : original);
  const writes = vi.fn();
  const saveComment = vi.fn();
  const sendComments = vi.fn().mockResolvedValue({ status: 'rejected', commentIds: [] });
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    if (init?.method === 'POST') writes(path);
    if (path.endsWith('/raw/index.html') || path.endsWith('/files/index.html')) return new Response(currentSource());
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetcher); vi.stubGlobal('crypto', webcrypto);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const tree = () => <FileViewer projectId={projectId} projectKind="prototype" isDeck={options.srcdoc} liveHtml={options.srcdoc ? currentSource() : undefined} filesRefreshKey={filesRefreshKey} file={{ name: 'index.html', path: 'index.html', type: 'file', kind: 'html', mime: 'text/html', size: 100, mtime }} previewComments={options.history?.map(comment => ({ ...comment, projectId }))} onSendBoardCommentAttachments={sendComments} onSavePreviewComment={saveComment} />;
  const view = render(tree());
  const saveB = () => { editedSource = prepared.replace('Target', 'Edited B'); mtime++; view.rerender(tree()); };
  return { writes, saveComment, sendComments, fetcher, saveB, refreshFiles: () => { filesRefreshKey++; saveB(); } };
}
async function acknowledge() {
  const frame = await screen.findByTestId('artifact-preview-frame') as HTMLIFrameElement;
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow,
      data: { type: 'od:url-selection-bridge-ready', href: frame.src } }));
  });
  return frame;
}
async function selectLegacy(override: Partial<typeof target> = {}) {
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  Object.defineProperty(frame, 'clientHeight', { configurable: true, value: 800 });
  Object.defineProperty(frame, 'clientWidth', { configurable: true, value: 1000 });
  await act(async () => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'od:comment-target', ...target, ...override } })));
  return frame;
}
afterEach(() => { cleanup(); invalidateHtmlSourceSnapshotProject(currentProjectId); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each(['present', 'missing'] as const)('validates the current selector at save, retaining the draft when %s', async state => {
  const route = setup({ currentPrepared: true });
  await acknowledge();
  fireEvent.click(screen.getByTestId('comment-panel-toggle'));
  const frame = await selectLegacy();
  fireEvent.change(screen.getByTestId('probe-draft'), { target: { value: 'Keep my draft' } });
  const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((data: unknown) => {
    const request = data as { validateForSave?: boolean; requestId?: string };
    if (!request.validateForSave) return;
    queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: state === 'missing'
      ? { type: 'od:comment-location-missing', documentVersion: `url:${frame.src}`, requestId: request.requestId }
      : { ...target, requestedSelector: target.selector, elementId: 'replacement', text: 'Changed text', type: 'od:comment-active-target-update', documentVersion: `url:${frame.src}`, requestId: request.requestId } })));
  });
  await act(async () => fireEvent.click(screen.getByTestId('probe-save')));
  if (state === 'present') {
    expect(route.saveComment).toHaveBeenCalledWith(expect.objectContaining({ elementId: 'replacement', text: 'Changed text', selector: target.selector }), 'Keep my draft', false, [], undefined);
  } else {
    expect(route.saveComment).not.toHaveBeenCalled();
    expect(screen.getByTestId('probe-draft')).toHaveValue('Keep my draft');
    expect(await screen.findByText(/comment target no longer exists/i)).toBeInTheDocument();
    await selectLegacy({ elementId: 'another', selector: '[data-od-id="another"]' });
    expect(screen.getByTestId('probe-draft')).toHaveValue('Keep my draft');
  }
  post.mockRestore();
});

it('refreshes srcdoc while the comment panel is open and retains typed feedback', async () => {
  const route = setup({ currentPrepared: true, srcdoc: true });
  const frame = await screen.findByTestId('artifact-preview-frame') as HTMLIFrameElement;
  expect(frame.getAttribute('data-od-render-mode')).toBe('srcdoc');
  fireEvent.click(screen.getByTestId('comment-panel-toggle'));
  await selectLegacy();
  fireEvent.change(screen.getByTestId('probe-draft'), { target: { value: 'Draft during source refresh' } });
  await act(async () => route.refreshFiles());
  await waitFor(() => expect((screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement).srcdoc).toContain('Edited B'));
  expect(screen.getByTestId('probe-draft')).toHaveValue('Draft during source refresh');
});

it('retains the comment draft across an active URL-frame reload with unchanged content', async () => {
  setup({ currentPrepared: true });
  await acknowledge();
  fireEvent.click(screen.getByTestId('comment-panel-toggle'));
  const frame = await selectLegacy();
  fireEvent.change(screen.getByTestId('probe-draft'), { target: { value: 'Draft survives reload' } });
  await act(async () => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow,
    data: { type: 'od:pod-stroke', points: [{ x: 10, y: 10 }, { x: 40, y: 40 }] } })));
  fireEvent.load(frame);
  await acknowledge();
  expect(screen.getByTestId('probe-draft')).toHaveValue('Draft survives reload');
});

it.each(['present', 'missing'] as const)('validates the live target before sending a draft to chat (%s)', async state => {
  const route = setup({ currentPrepared: true });
  await acknowledge();
  fireEvent.click(screen.getByTestId('comment-panel-toggle'));
  const frame = await selectLegacy();
  fireEvent.change(screen.getByTestId('probe-draft'), { target: { value: 'Keep draft' } });
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((data: unknown) => {
    const request = data as { validateForSave?: boolean; requestId: string };
    if (!request.validateForSave) return;
    queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow,
      data: state === 'missing' ? { type: 'od:comment-location-missing', documentVersion: `url:${frame.src}`, requestId: request.requestId }
        : { ...target, text: 'Current replacement', style: { color: 'blue' }, slideIndex: 3,
          requestedSelector: target.selector, type: 'od:comment-active-target-update', documentVersion: `url:${frame.src}`, requestId: request.requestId } })));
  });
  await act(async () => fireEvent.click(screen.getByTestId('probe-send')));
  if (state === 'missing') {
    expect(route.sendComments).not.toHaveBeenCalled();
    expect(await screen.findByText(/comment target no longer exists/i)).toBeInTheDocument();
  } else {
    expect(route.sendComments).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(route.sendComments.mock.calls[0])).toContain('Current replacement');
    expect(JSON.stringify(route.sendComments.mock.calls[0])).toContain('blue');
  }
  expect(screen.getByTestId('probe-draft')).toHaveValue('Keep draft');
});

it.each(['save', 'send'] as const)('keeps file-level comment %s independent of DOM validation', async action => {
  const route = setup({ currentPrepared: true });
  await acknowledge();
  fireEvent.click(screen.getByTestId('comment-panel-toggle'));
  const frame = await selectLegacy({ elementId: 'file-comment-existing', selector: 'html' });
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  fireEvent.change(screen.getByTestId('probe-draft'), { target: { value: 'File feedback' } });
  await act(async () => fireEvent.click(screen.getByTestId(action === 'save' ? 'probe-save' : 'probe-send')));
  expect(action === 'save' ? route.saveComment : route.sendComments).toHaveBeenCalledTimes(1);
  expect(post.mock.calls.some(([message]) => message?.validateForSave)).toBe(false);
});
