// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the safety-transport assertions separate from the independently tested diagnostic bridge.
// Shared setup imports analytics transitively; reload it after registering this mock.
vi.hoisted(() => vi.resetModules());
vi.mock('../../src/observability/experience-diagnostics', () => ({ reportExperienceEvent: vi.fn() }));

import { installResourceErrorObserver } from '../../src/observability/resource-error';
import { reportedSafetyEvents, watchSafetyEvents } from '../helpers/safety-events';



let uninstall: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  watchSafetyEvents();
  window.history.replaceState(
    {},
    '',
    '/projects/project-secret/conversations/conversation-secret/files/Customer%20Plan.pdf?auth=page-secret#slide-4',
  );
  uninstall = installResourceErrorObserver();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  vi.useRealTimers();
});

function dispatchResourceError(tag: string, url: string): void {
  const element = document.createElement(tag);
  if (element instanceof HTMLLinkElement) {
    element.href = url;
    element.rel = 'stylesheet';
  } else {
    element.setAttribute('src', url);
  }
  document.body.append(element);
  element.dispatchEvent(new Event('error'));
  element.remove();
}

describe('resource error privacy and volume boundary', () => {
  it('classifies resources without sending user paths, URL secrets, or external locations', () => {
    const origin = window.location.origin;
    const cases = [
      {
        tag: 'script',
        url: `${origin}/_next/static/chunks/app/projects/%5Bid%5D/page-a1b2c3.js?build=chunk-secret#runtime`,
        expected: {
          category: 'next_chunk',
          resource_route: '/_next/static/chunks/:chunk',
          normalized_resource: 'next:a1b2c3.js',
          resource_type: 'script',
          resource_extension: 'js',
          origin_relation: 'same_origin',
        },
      },
      {
        tag: 'link',
        url: `${origin}/fonts/remixicon.woff2?v=font-secret#font`,
        expected: {
          category: 'product_asset',
          resource_route: '/fonts/:asset',
          normalized_resource: '/fonts/:asset:style.woff2',
          resource_type: 'style',
          resource_extension: 'woff2',
          origin_relation: 'same_origin',
        },
      },
      {
        tag: 'iframe',
        url: `${origin}/api/projects/prj-private-123/raw/Finance/Customer%20Board.pdf?downloadToken=file-secret#page=9`,
        expected: {
          category: 'user_artifact',
          resource_route: '/api/projects/:project_id/raw/:file',
          normalized_resource: '/api/projects/:project_id/raw/:file.pdf',
          resource_type: 'frame',
          resource_extension: 'pdf',
          origin_relation: 'same_origin',
        },
      },
      {
        tag: 'video',
        url: 'https://viewer:password@media.customer.example/private/Alice%20Interview.mp4?X-Amz-Credential=external-secret#clip',
        expected: {
          category: 'external_media',
          resource_route: 'external',
          normalized_resource: 'external:video.mp4',
          resource_type: 'video',
          resource_extension: 'mp4',
          origin_relation: 'cross_origin',
        },
      },
    ] as const;

    for (const item of cases) dispatchResourceError(item.tag, item.url);

    expect(reportedSafetyEvents()).toHaveLength(cases.length);
    for (const [index, item] of cases.entries()) {
      expect(reportedSafetyEvents()[index]!.properties).toMatchObject({
        ...item.expected,
        monitoring_kind: `${item.expected.category}|first`,
        tag: item.tag,
        event_kind: 'first',
        repeat_count: 0,
      });
    }

    const serialized = reportedSafetyEvents()
      .map((reported) => JSON.stringify(reported))
      .join('\n');
    for (const secret of [
      'project-secret',
      'conversation-secret',
      'Customer%20Plan.pdf',
      'prj-private-123',
      'Customer%20Board.pdf',
      'chunk-secret',
      'font-secret',
      'file-secret',
      'Alice%20Interview.mp4',
      'external-secret',
      'viewer:password',
      'media.customer.example',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('does not serialize private names hidden by product prefixes or custom schemes', () => {
    const productLookingPrivateUrl =
      `${window.location.origin}/fonts/Customer%20Contract.pdf`;
    const customSchemeUrl = 'customer-project-123:payload';

    dispatchResourceError('link', productLookingPrivateUrl);
    dispatchResourceError('img', customSchemeUrl);

    expect(reportedSafetyEvents()[0]!.properties).toMatchObject({
      category: 'product_asset',
      resource_route: '/fonts/:asset',
      resource_extension: 'pdf',
    });
    expect(reportedSafetyEvents()[1]!.properties).toMatchObject({
      category: 'user_artifact',
      resource_route: 'opaque',
      normalized_resource: 'opaque:image',
    });

    const serialized = reportedSafetyEvents()
      .map((reported) => JSON.stringify(reported))
      .join('\n');
    expect(serialized).not.toContain('Customer%20Contract.pdf');
    expect(serialized).not.toContain('customer-project-123');
    expect(serialized).not.toContain('payload');
  });

  it('retains only a restrictive bundler identifier from chunk filenames', () => {
    dispatchResourceError(
      'script',
      `${window.location.origin}/_next/static/chunks/Customer%20Contract-a1b2c3.js`,
    );

    expect(reportedSafetyEvents()[0]!.properties).toMatchObject({
      category: 'next_chunk',
      normalized_resource: 'next:a1b2c3.js',
      resource_route: '/_next/static/chunks/:chunk',
    });
    expect(JSON.stringify(reportedSafetyEvents()[0]!.properties)).not.toContain('Customer');
    expect(JSON.stringify(reportedSafetyEvents()[0]!.properties)).not.toContain('Contract');
  });

  it('emits one immediate event and one bounded repeat summary per resource window', () => {
    const resource =
      `${window.location.origin}/api/projects/private-project/raw/Private%20deck.pdf?token=private-token`;

    for (let count = 0; count < 5; count += 1) {
      dispatchResourceError('iframe', resource);
    }

    expect(reportedSafetyEvents()).toHaveLength(1);
    expect(reportedSafetyEvents()[0]!.properties).toMatchObject({
      category: 'user_artifact',
      event_kind: 'first',
      repeat_count: 0,
    });

    vi.advanceTimersByTime(60_000);

    expect(reportedSafetyEvents()).toHaveLength(2);
    expect(reportedSafetyEvents()[1]!.properties).toMatchObject({
      category: 'user_artifact',
      monitoring_kind: 'user_artifact|repeat_summary',
      event_kind: 'repeat_summary',
      repeat_count: 4,
    });
    expect(JSON.stringify(reportedSafetyEvents()[1]!.properties)).not.toContain('private-project');
    expect(JSON.stringify(reportedSafetyEvents()[1]!.properties)).not.toContain('Private%20deck.pdf');
    expect(JSON.stringify(reportedSafetyEvents()[1]!.properties)).not.toContain('private-token');
  });

  it('closes a repeat window once the resource loads and starts fresh after recovery', () => {
    const resource = document.createElement('img');
    resource.src = `${window.location.origin}/api/projects/private/raw/Recovered%20image.png?token=secret`;
    document.body.append(resource);

    resource.dispatchEvent(new Event('error'));
    resource.dispatchEvent(new Event('error'));
    resource.dispatchEvent(new Event('load'));

    expect(reportedSafetyEvents()).toHaveLength(2);
    expect(reportedSafetyEvents()[1]!.properties).toMatchObject({
      event_kind: 'repeat_summary',
      repeat_count: 1,
    });

    resource.dispatchEvent(new Event('error'));
    expect(reportedSafetyEvents()).toHaveLength(3);
    expect(reportedSafetyEvents()[2]!.properties).toMatchObject({
      event_kind: 'first',
      repeat_count: 0,
    });
    resource.remove();
  });

  it('tracks private resources independently when their telemetry classifications collide', () => {
    const first = document.createElement('iframe');
    first.src = `${window.location.origin}/api/projects/private/raw/First%20deck.pdf`;
    const second = document.createElement('iframe');
    second.src = `${window.location.origin}/api/projects/private/raw/Second%20deck.pdf`;
    document.body.append(first, second);

    first.dispatchEvent(new Event('error'));
    first.dispatchEvent(new Event('error'));
    second.dispatchEvent(new Event('error'));
    second.dispatchEvent(new Event('error'));

    expect(reportedSafetyEvents()).toHaveLength(2);
    expect(reportedSafetyEvents()[0]!.properties.normalized_resource).toBe(
      reportedSafetyEvents()[1]!.properties.normalized_resource,
    );

    first.dispatchEvent(new Event('load'));
    expect(reportedSafetyEvents()).toHaveLength(3);
    expect(reportedSafetyEvents()[2]!.properties).toMatchObject({
      event_kind: 'repeat_summary',
      repeat_count: 1,
    });

    vi.advanceTimersByTime(60_000);
    expect(reportedSafetyEvents()).toHaveLength(4);
    expect(reportedSafetyEvents()[3]!.properties).toMatchObject({
      event_kind: 'repeat_summary',
      repeat_count: 1,
    });

    first.remove();
    second.remove();
  });

  it('flushes the repeat count when the page session ends before the window expires', () => {
    const resource =
      `${window.location.origin}/api/projects/private/raw/Leaving%20page.pdf?token=secret`;
    dispatchResourceError('iframe', resource);
    dispatchResourceError('iframe', resource);

    expect(reportedSafetyEvents()).toHaveLength(1);
    window.dispatchEvent(new Event('pagehide'));

    expect(reportedSafetyEvents()).toHaveLength(2);
    expect(reportedSafetyEvents()[1]!.properties).toMatchObject({
      event_kind: 'repeat_summary',
      repeat_count: 1,
    });
  });

  it('bounds tracked resource windows and allows an evicted chunk to report again', () => {
    const origin = window.location.origin;
    for (let index = 0; index < 129; index += 1) {
      const chunkId = index.toString(16).padStart(6, '0');
      dispatchResourceError(
        'script',
        `${origin}/_next/static/chunks/chunk-${chunkId}.js`,
      );
    }
    expect(reportedSafetyEvents()).toHaveLength(129);

    dispatchResourceError(
      'script',
      `${origin}/_next/static/chunks/chunk-000000.js`,
    );
    expect(reportedSafetyEvents()).toHaveLength(130);
    expect(reportedSafetyEvents()[129]!.properties).toMatchObject({
      category: 'next_chunk',
      normalized_resource: 'next:000000.js',
      event_kind: 'first',
    });
  });
});
