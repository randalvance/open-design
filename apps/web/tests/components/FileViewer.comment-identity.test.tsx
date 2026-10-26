// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FileViewer, commentAuthorAvatarColor } from '../../src/components/FileViewer';
import type { PreviewComment, ProjectFile } from '../../src/types';

const file: ProjectFile = { name: 'index.html', path: 'index.html', type: 'file', size: 100, mtime: 1, kind: 'html', mime: 'text/html' };
const comment: PreviewComment = {
  id: 'public', projectId: 'p', conversationId: 'c', filePath: file.name,
  elementId: 'pin', selector: 'h2', label: 'h2', text: '', htmlHint: '',
  position: { x: 0, y: 0, width: 1, height: 1 }, note: 'Public feedback',
  status: 'open', createdAt: 200, updatedAt: 200, authorKind: 'user',
  authorAppUserId: 'self', authorDisplayName: 'Same Name', authorKey: 'same-color',
};
const tree = (comments: PreviewComment[]) => <FileViewer projectId="p" projectKind="prototype"
  file={file} liveHtml="<html><body><h2>Fixture</h2></body></html>" previewComments={comments} />;
// There is no account any more: every comment belongs to the local owner, so
// the viewer identity the old cloud session supplied is simply absent.
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/comments/read')) return Response.json({ projectId: 'p', lastReadAt: 100 });
    return Response.json({});
  }));
}
async function savedPin() {
  const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: {
      type: 'od:comment-targets', targets: [{
        elementId: comment.elementId, selector: comment.selector, label: 'h2', text: '', htmlHint: '',
        position: { x: 20, y: 40, width: 200, height: 40 },
      }],
    } }));
  });
  return (await screen.findByTestId('comment-saved-marker-pin')).querySelector('.comment-saved-pin');
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([
  ['👩🏽‍💻 Engineer', '👩🏽‍💻'], ['👍🏽 Visitor', '👍🏽'], ['🇨🇳 Visitor', '🇨🇳'],
  ['e\u0301mile', 'E\u0301'], ['alice', 'A'], ['琼 Visitor', '琼'], ['', '?'], ['  ', '?'],
].flatMap(([name, initial]) => (['user', 'member'] as const).map(authorKind => ({ name: name!, initial: initial!, authorKind }))))(
  'matches saved and active pins to the sidebar avatar grapheme for $authorKind $name', async ({ name, initial, authorKind }) => {
  stubFetch();
  render(tree([{ ...comment, authorKind, authorMemberId: 'member-author', authorDisplayName: name }]));
  fireEvent.click(screen.getByTestId('comment-panel-toggle'));
  const row = await screen.findByTestId('comment-side-item');
  expect(row.querySelector('.comment-side-avatar')).toHaveTextContent(initial);
  const swatch = commentAuthorAvatarColor(comment.authorKey!);
  const pin = await savedPin();
  expect(row.querySelector('.comment-side-avatar')).toHaveStyle({ background: swatch.bg, color: swatch.fg });
  expect(pin).toHaveStyle({ background: swatch.bg, color: swatch.fg });
  expect(pin).toHaveTextContent(initial);
  fireEvent.click(pin!);
  const activePin = await screen.findByTestId('comment-active-pin');
  expect(activePin).toHaveTextContent(initial);
  expect(activePin).toHaveStyle({ background: swatch.bg, color: swatch.fg });
  if (name.trim()) expect(row).toHaveTextContent(name);
});

for (const authorKind of ['user', 'member'] as const) {
  it(`keeps ${authorKind} pins and avatars on the shared fallback when authorKey is missing`, async () => {
    stubFetch();
    render(tree([{ ...comment, authorKind, authorKey: undefined, authorMemberId: 'not-a-color-key' }]));
    fireEvent.click(screen.getByTestId('comment-panel-toggle'));
    const row = await screen.findByTestId('comment-side-item');
    const swatch = commentAuthorAvatarColor('');
    expect(row.querySelector('.comment-side-avatar')).toHaveStyle({ background: swatch.bg, color: swatch.fg });
    expect(await savedPin()).toHaveStyle({ background: swatch.bg, color: swatch.fg });
    expect(row).toHaveTextContent(comment.note);
  });
}

it('3650: keeps self public feedback visible but excludes it from external unread', async () => {
  stubFetch();
  render(tree([comment]));
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByTestId('comment-unread-dot')).toBeNull();
  expect(screen.getByTestId('comment-panel-toggle')).toHaveAttribute('aria-label', 'Comments (1)');
  fireEvent.click(screen.getByTestId('comment-panel-toggle'));
  expect(await screen.findByTestId('comment-side-item')).toHaveTextContent(comment.note);
});
