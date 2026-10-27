import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';
import { rewriteOutsideExecutableHtmlRanges } from '../src/routes/project/index.js';

describe('project preview containment routes', () => {
  let server: http.Server;
  let baseUrl: string;
  const projectsToClean: string[] = [];

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    for (const id of projectsToClean.splice(0)) {
      await fetch(`${baseUrl}/api/projects/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function createProject(metadata: Record<string, unknown> = {}): Promise<string> {
    const id = `preview-containment-${randomUUID()}`;
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        name: 'Preview containment project',
        metadata,
      }),
    });
    expect(response.ok).toBe(true);
    projectsToClean.push(id);
    return id;
  }

  async function writeProjectFile(projectId: string, name: string, content: string): Promise<void> {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, content }),
    });
    expect(response.ok).toBe(true);
  }

  // OPEND-2283. The web client builds its srcDoc preview from this response.
  // Minting a fresh scope per request makes the SAME artifact serve different
  // bytes every time, so any refetch produces a different srcDoc string, React
  // assigns it, and the iframe reloads -- the artifact visibly disappears and
  // comes back. Measured 1-4 reloads on a single project entry.
  it('serves the same preview base for repeated reads of one artifact', async () => {
    const projectId = await createProject();
    await writeProjectFile(projectId, 'index.html', '<html><head></head><body>hi</body></html>');

    const read = async () => {
      // `odPreviewBridge` is what marks this as the FileViewer preview transport;
      // a plain raw read deliberately returns the untouched bytes.
      const res = await fetch(
        `${baseUrl}/api/projects/${projectId}/raw/index.html?odPreviewBridge=scroll`,
      );
      expect(res.ok).toBe(true);
      return await res.text();
    };

    const first = await read();
    const second = await read();

    // Compare the WHOLE document, not just the `<base href>`. What React
    // assigns to `srcDoc` is this entire string, so any byte that moves per
    // request reloads the iframe just as surely as a fresh scope id would --
    // the bridge script serializes the scope's expiry, so renewing that expiry
    // on a read is enough to defeat a stable scope id. Asserting only on the
    // base href cannot see that.
    expect(first).toContain('<base');
    expect(second).toBe(first);
  });

  // Renewal keeps a scope alive; it must not change what the document SAYS.
  // The bridge script serializes the expiry, so letting an explicit renewal
  // move that value makes the next read of the same artifact return different
  // bytes -- one more srcDoc assignment, one more iframe reload. The client
  // renews on a timer while a preview is open, so this is the steady-state
  // path, not an edge case.
  it('keeps the bridged document identical across an explicit renewal', async () => {
    const projectId = await createProject();
    await writeProjectFile(projectId, 'index.html', '<html><head></head><body>hi</body></html>');

    const read = async () => {
      const res = await fetch(
        `${baseUrl}/api/projects/${projectId}/raw/index.html?odPreviewBridge=scroll`,
      );
      expect(res.ok).toBe(true);
      return await res.text();
    };

    const first = await read();
    const scope = /\/preview\/([^/]+)\//.exec(
      /<base\b[^>]*href="([^"]+)"/i.exec(first)?.[1] ?? '',
    )?.[1];
    expect(scope).toBeTruthy();

    const renewed = await fetch(
      `${baseUrl}/api/projects/${projectId}/preview/${scope}/renew`,
      { method: 'POST', headers: { 'x-od-preview-scope-renewal': '1' } },
    );
    expect(renewed.ok).toBe(true);

    expect(await read()).toBe(first);
  });

  // A scope minted for a one-shot job must never be handed to a live preview.
  // Screenshot/PDF export mints a scope for the render and `revoke`s it in its
  // `finally`; if a preview were allowed to adopt that scope, the export's
  // teardown would revoke the very base the preview still serves its assets
  // from -- blanking the artifact, which is the symptom this whole area exists
  // to prevent. `preview-url` mints exactly the way an export does, so it
  // stands in for one here without needing a renderer.
  it('never reuses a one-shot minted scope for a live preview read', async () => {
    const projectId = await createProject();
    await writeProjectFile(projectId, 'index.html', '<html><head></head><body>hi</body></html>');

    const mintResponse = await fetch(
      `${baseUrl}/api/projects/${projectId}/preview-url?file=index.html`,
    );
    expect(mintResponse.ok).toBe(true);
    const mintedUrl = (await mintResponse.json() as { url: string }).url;
    const mintedScope = /\/preview\/([^/]+)\//.exec(mintedUrl)?.[1];
    expect(mintedScope).toBeTruthy();

    const previewResponse = await fetch(
      `${baseUrl}/api/projects/${projectId}/raw/index.html?odPreviewBridge=scroll`,
    );
    expect(previewResponse.ok).toBe(true);
    const previewScope = /<base\b[^>]*href="[^"]*\/preview\/([^/]+)\//i
      .exec(await previewResponse.text())?.[1];

    expect(previewScope).toBeTruthy();
    expect(previewScope).not.toBe(mintedScope);
  });

  it('returns a scoped preview URL with sandbox guidance and serves it with an opaque-origin CSP', async () => {
    const projectId = await createProject({ entryFile: 'pages/index.html' });
    await writeProjectFile(
      projectId,
      'pages/index.html',
      '<!doctype html><title>Preview</title><link rel="stylesheet" href="../styles/app.css">',
    );
    await writeProjectFile(projectId, 'styles/app.css', 'body { color: black; }');

    const urlResponse = await fetch(
      `${baseUrl}/api/projects/${projectId}/preview-url?file=${encodeURIComponent('pages/index.html')}`,
    );
    expect(urlResponse.ok).toBe(true);
    expect(urlResponse.headers.get('cache-control')).toBe('no-store');
    const body = await urlResponse.json() as {
      url: string;
      file: string;
      csp: string;
      iframeSandbox: string;
      opaqueOrigin: true;
      expiresAt: number;
    };

    expect(body.file).toBe('pages/index.html');
    expect(body.url).toContain(`/api/projects/${projectId}/preview/`);
    expect(body.url).toMatch(/\/preview\/[A-Za-z0-9_-]{8,128}\/pages\/index\.html$/u);
    expect(body.iframeSandbox).toBe('allow-scripts allow-forms');
    expect(body.iframeSandbox).not.toContain('allow-same-origin');
    expect(body.csp).toContain('sandbox allow-scripts allow-forms');
    expect(body.csp).toContain("connect-src 'none'");
    expect(body.csp).not.toContain('allow-same-origin');
    expect(body.opaqueOrigin).toBe(true);
    expect(body.expiresAt).toBeGreaterThan(Date.now());

    const renewalScope = /\/preview\/([^/]+)\//u.exec(body.url)?.[1];
    expect(renewalScope).toBeTruthy();
    const rejectedRenewal = await fetch(
      `${baseUrl}/api/projects/${projectId}/preview/${renewalScope}/renew`,
      { method: 'POST' },
    );
    expect(rejectedRenewal.status).toBe(403);
    const renewal = await fetch(
      `${baseUrl}/api/projects/${projectId}/preview/${renewalScope}/renew`,
      {
        method: 'POST',
        headers: { 'x-od-preview-scope-renewal': '1' },
      },
    );
    expect(renewal.status).toBe(200);
    const renewed = await renewal.json() as { expiresAt: number };
    expect(renewed.expiresAt).toBeGreaterThanOrEqual(body.expiresAt);

    const previewResponse = await fetch(`${baseUrl}${body.url}`, {
      headers: { Origin: 'null' },
    });
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.headers.get('access-control-allow-origin')).toBe('*');
    expect(previewResponse.headers.get('cache-control')).toBe('no-store');
    expect(previewResponse.headers.get('x-content-type-options')).toBe('nosniff');
    const csp = previewResponse.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('sandbox allow-scripts allow-forms');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain('allow-same-origin');
    expect(await previewResponse.text()).toContain('<title>Preview</title>');

    const scope = body.url.match(/\/preview\/([^/]+)\//u)?.[1];
    expect(scope).toBeTruthy();
    const assetResponse = await fetch(
      `${baseUrl}/api/projects/${projectId}/preview/${scope}/styles/app.css`,
      { headers: { Origin: 'null' } },
    );
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('access-control-allow-origin')).toBe('*');
    expect(assetResponse.headers.get('content-type')).toContain('text/css');
    expect(await assetResponse.text()).toContain('color: black');
  });


  it('serves generated PNG assets through preview scopes and clearly 404s missing image references', async () => {
    const projectId = await createProject({ entryFile: 'index.html' });
    await writeProjectFile(
      projectId,
      'index.html',
      '<!doctype html><title>PNG Preview</title><img src="assets/hero.png"><img src="assets/missing.png">',
    );
    await writeProjectFile(projectId, 'assets/hero.png', 'png-bytes');

    const urlResponse = await fetch(
      `${baseUrl}/api/projects/${projectId}/preview-url?file=${encodeURIComponent('index.html')}`,
    );
    expect(urlResponse.ok).toBe(true);
    const body = await urlResponse.json() as { url: string };
    const scope = body.url.match(/\/preview\/([^/]+)\//u)?.[1];
    expect(scope).toBeTruthy();

    const existingAsset = await fetch(
      `${baseUrl}/api/projects/${projectId}/preview/${scope}/assets/hero.png`,
      { headers: { Origin: 'null' } },
    );
    expect(existingAsset.status).toBe(200);
    expect(existingAsset.headers.get('access-control-allow-origin')).toBe('*');
    expect(existingAsset.headers.get('content-type')).toContain('image/png');
    expect(await existingAsset.text()).toBe('png-bytes');

    const missingAsset = await fetch(
      `${baseUrl}/api/projects/${projectId}/preview/${scope}/assets/missing.png`,
      { headers: { Origin: 'null' } },
    );
    expect(missingAsset.status).toBe(404);
    expect(missingAsset.headers.get('access-control-allow-origin')).toBe('*');
    expect(missingAsset.headers.get('content-type')).toContain('application/json');
    const missingBody = await missingAsset.json() as { error?: { message?: string } };
    expect(missingBody.error?.message).toContain('ENOENT');
    expect(missingBody.error?.message).toContain('assets/missing.png');
  });

  it('serves minted preview HTML and assets without bearer headers when API token auth is enabled', async () => {
    const previousToken = process.env.OD_API_TOKEN;
    const token = `preview-token-${randomUUID()}`;
    process.env.OD_API_TOKEN = token;
    let tokenServer: http.Server | undefined;
    let shutdown: (() => Promise<void> | void) | undefined;
    let tokenBaseUrl = '';
    const projectId = `preview-token-${randomUUID()}`;

    try {
      const started = (await startServer({ port: 0, returnServer: true })) as {
        url: string;
        server: http.Server;
        shutdown?: () => Promise<void> | void;
      };
      tokenBaseUrl = started.url;
      tokenServer = started.server;
      shutdown = started.shutdown;
      const authHeaders = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      };

      const createResponse = await fetch(`${tokenBaseUrl}/api/projects`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          id: projectId,
          name: 'Token preview containment project',
          metadata: { entryFile: 'pages/index.html' },
        }),
      });
      expect(createResponse.ok).toBe(true);

      const writeIndex = await fetch(`${tokenBaseUrl}/api/projects/${projectId}/files`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          name: 'pages/index.html',
          content: '<!doctype html><title>Hosted Preview</title><link rel="stylesheet" href="../styles/app.css">',
        }),
      });
      expect(writeIndex.ok).toBe(true);

      const writeAsset = await fetch(`${tokenBaseUrl}/api/projects/${projectId}/files`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          name: 'styles/app.css',
          content: 'body { color: rebeccapurple; }',
        }),
      });
      expect(writeAsset.ok).toBe(true);

      const urlResponse = await fetch(
        `${tokenBaseUrl}/api/projects/${projectId}/preview-url?file=${encodeURIComponent('pages/index.html')}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(urlResponse.ok).toBe(true);
      const body = await urlResponse.json() as { url: string };
      const scope = body.url.match(/\/preview\/([^/]+)\//u)?.[1];
      expect(scope).toBeTruthy();

      const previewResponse = await fetch(`${tokenBaseUrl}${body.url}`, {
        headers: { Origin: 'null' },
      });
      expect(previewResponse.status).toBe(200);
      expect(previewResponse.headers.get('access-control-allow-origin')).toBe('*');
      expect(await previewResponse.text()).toContain('<title>Hosted Preview</title>');

      const assetResponse = await fetch(
        `${tokenBaseUrl}/api/projects/${projectId}/preview/${scope}/styles/app.css`,
        { headers: { Origin: 'null' } },
      );
      expect(assetResponse.status).toBe(200);
      expect(await assetResponse.text()).toContain('rebeccapurple');

      const forgedResponse = await fetch(
        `${tokenBaseUrl}/api/projects/${projectId}/preview/${randomUUID()}/pages/index.html`,
        { headers: { Origin: 'null' } },
      );
      expect(forgedResponse.status).toBe(404);
    } finally {
      if (tokenBaseUrl) {
        await fetch(`${tokenBaseUrl}/api/projects/${projectId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
      if (shutdown) await Promise.resolve(shutdown());
      if (tokenServer) await new Promise<void>((resolve) => tokenServer!.close(() => resolve()));
      if (previousToken === undefined) delete process.env.OD_API_TOKEN;
      else process.env.OD_API_TOKEN = previousToken;
    }
  });

  // The build-focus bridge is what lets the Design Files pane park a cursor on
  // the part of a page the agent is writing right now. It rides the same
  // `odPreviewBridge` query as the other bridges and must stay opt-in: a
  // preview that did not ask for it gets a clean document.
  it('injects the build-focus bridge only when asked, and only once', async () => {
    const projectId = await createProject();
    await writeProjectFile(
      projectId,
      'index.html',
      '<!doctype html><html><body><h1>Studio Nine</h1></body></html>',
    );

    const plain = await fetch(`${baseUrl}/api/projects/${projectId}/raw/index.html`);
    expect(await plain.text()).not.toContain('data-od-preview-build-focus');

    const bridged = await fetch(
      `${baseUrl}/api/projects/${projectId}/raw/index.html?odPreviewBridge=buildfocus`,
    );
    expect(bridged.status).toBe(200);
    const html = await bridged.text();
    expect(html.split('data-od-preview-build-focus').length - 1).toBe(1);
    expect(html).toContain('od:preview-build-focus');
    // Asking for one bridge must not hand out the others — the observability
    // bridge in particular reports page errors into a host-wide buffer.
    expect(html).not.toContain('data-od-preview-observability');
    expect(html).not.toContain('data-od-url-scroll-bridge');

    // A non-HTML file has nothing to inject into.
    await writeProjectFile(projectId, 'notes.txt', 'plain text');
    const text = await fetch(
      `${baseUrl}/api/projects/${projectId}/raw/notes.txt?odPreviewBridge=buildfocus`,
    );
    expect(await text.text()).not.toContain('data-od-preview-build-focus');
  });

  it('hosts only video motion in building previews without changing raw sources or legacy playback', async () => {
    const projectId = await createProject();
    for (const mode of ['video', 'interactive', 'legacy', 'prototype', 'ppt', 'marketing']) {
      const source = `<!doctype html><html><head>${mode === 'video' || mode === 'interactive' ? `<meta name="od-motion-output" content="${mode}">` : ''}</head><body><main data-composition-id="main"></main></body></html>`;
      await writeProjectFile(projectId, `${mode}.html`, source);
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/raw/${mode}.html?odPreviewBridge=buildfocus`);
      const html = await response.text();
      expect(html.includes('window.__odMotionPreview=true')).toBe(mode === 'video');
      expect(html.includes('data-od-motion-source-player')).toBe(mode === 'video');
      if (mode === 'video') expect(html.indexOf('window.__odMotionPreview=true')).toBeLessThan(html.indexOf('data-od-motion-source-player'));
      expect(await (await fetch(`${baseUrl}/api/projects/${projectId}/raw/${mode}.html`)).text()).toBe(source);
    }
  });

  it('upgrades a persisted Motion player for thumbnail previews while raw source bytes remain unchanged', async () => {
    const projectId = await createProject({ kind: 'video', intent: 'motion-design' });
    const source = '<!doctype html><html><head><meta name="od-motion-output" content="video"></head><body><main data-composition-id="main"></main><script data-od-motion-source-player="5">oldPlayer();</script></body></html>';
    await writeProjectFile(projectId, 'index.html', source);
    const plain = await fetch(`${baseUrl}/api/projects/${projectId}/raw/index.html`);
    expect(await plain.text()).toBe(source);
    const thumbnail = await fetch(`${baseUrl}/api/projects/${projectId}/raw/index.html?odMotionPreview=1&odMotionThumbnail=1`);
    expect(thumbnail.status).toBe(200);
    const html = await thumbnail.text();
    expect(html).not.toContain('oldPlayer();');
    expect(html).toContain('data-od-motion-source-player="8"');
    expect(html).toContain("searchParams.get('odMotionThumbnail')");
    expect(html.match(/<script data-od-motion-source-player/g)).toHaveLength(1);
    expect(html).not.toContain('data-od-url-scroll-bridge');
  });

  it('rejects invalid preview scopes and escaping preview-url paths', async () => {
    const projectId = await createProject();
    await writeProjectFile(projectId, 'index.html', '<!doctype html>');

    const invalidScope = await fetch(`${baseUrl}/api/projects/${projectId}/preview/bad/index.html`);
    expect(invalidScope.status).toBe(400);

    const escapingPath = await fetch(
      `${baseUrl}/api/projects/${projectId}/preview-url?file=${encodeURIComponent('../index.html')}`,
    );
    expect(escapingPath.status).toBe(400);
  });
});

describe('project preview HTML rewriting', () => {
  const rewriteReference = (reference: string): string => `/preview/${reference}`;

  it('preserves scripts while rewriting CSS URLs elsewhere in the document', () => {
    const script = "const css = 'url(\"assets/runtime.png\")'; "
      + "const url = 'blob:preview'; URL.revokeObjectURL(url);";
    const html = [
      '<!doctype html><html><head>',
      '<!-- code sample: <script> -->',
      '<textarea><script></textarea>',
      `<script>${script}</script>`,
      '</head><body>',
      '<style>.hero { background: url("assets/hero.png"); }</style>',
      '</body></html>',
    ].join('');

    const rewritten = rewriteOutsideExecutableHtmlRanges(html, (chunk) =>
      chunk.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote: string, reference: string) => {
        const rewrittenReference = rewriteReference(reference);
        return rewrittenReference === reference
          ? match
          : `url(${quote}${rewrittenReference}${quote})`;
      }));

    expect(rewritten).toContain(`<script>${script}</script>`);
    expect(rewritten).toContain('url("/preview/assets/hero.png")');
  });

  it('preserves executable HTML attributes while rewriting CSS URLs', () => {
    const html = [
      '<button onclick="URL.revokeObjectURL(url)" style="background: url(assets/hero.png)">Revoke</button>',
      '<a href="javascript:URL.revokeObjectURL(url)">Revoke</a>',
      '<iframe srcdoc="<script>URL.revokeObjectURL(url)</script>"></iframe>',
    ].join('');

    const rewritten = rewriteOutsideExecutableHtmlRanges(html, (chunk) =>
      chunk.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_match, quote: string, reference: string) =>
        `url(${quote}${rewriteReference(reference)}${quote})`));

    expect(rewritten).toContain(
      'onclick="URL.revokeObjectURL(url)" style="background: url(/preview/assets/hero.png)"',
    );
    expect(rewritten).toContain('href="javascript:URL.revokeObjectURL(url)"');
    expect(rewritten).toContain('srcdoc="<script>URL.revokeObjectURL(url)</script>"');
  });

  it('preserves an unclosed script through the end of the document', () => {
    const html = '<script>const url = "blob:preview"; URL.revokeObjectURL(url)';

    expect(rewriteOutsideExecutableHtmlRanges(html, (chunk) =>
      chunk.replace('blob:preview', rewriteReference('blob:preview')))).toBe(html);
  });

  it('treats a self-closing slash on an HTML script as unclosed', () => {
    const html = '<script/>const url = "blob:preview"; URL.revokeObjectURL(url)';

    expect(rewriteOutsideExecutableHtmlRanges(html, (chunk) =>
      chunk.replace('blob:preview', rewriteReference('blob:preview')))).toBe(html);
  });

  it('continues rewriting after a self-closing SVG script', () => {
    const html = '<svg><script src="runtime.js" /></svg>'
      + '<style>body { background: url(assets/hero.png); }</style>';

    expect(rewriteOutsideExecutableHtmlRanges(html, (chunk) =>
      chunk.replace('assets/hero.png', rewriteReference('assets/hero.png'))))
      .toContain('url(/preview/assets/hero.png)');
  });

  it('avoids collisions with protected range markers already in the document', () => {
    const script = 'const marker = "__OD_PROTECTED_HTML_RANGE_";';
    const html = `<style>.__OD_PROTECTED_HTML_RANGE_ { background: url(assets/hero.png); }</style>`
      + `<script>${script}</script>`;

    const rewritten = rewriteOutsideExecutableHtmlRanges(html, (chunk) =>
      chunk.replace('assets/hero.png', rewriteReference('assets/hero.png')));

    expect(rewritten).toContain('.__OD_PROTECTED_HTML_RANGE_');
    expect(rewritten).toContain('url(/preview/assets/hero.png)');
    expect(rewritten).toContain(`<script>${script}</script>`);
  });

  it('bounds marker allocation for long prefix-like input', () => {
    const script = 'const url = "blob:preview"; URL.revokeObjectURL(url);';
    const html = `${'_'.repeat(100_000)}__OD_PROTECTED_HTML_RANGE_`
      + `<style>body { background: url(assets/hero.png); }</style>`
      + `<script>${script}</script>`;
    const startedAt = performance.now();

    const rewritten = rewriteOutsideExecutableHtmlRanges(html, (chunk) =>
      chunk.replace('assets/hero.png', rewriteReference('assets/hero.png')));

    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(rewritten).toContain('url(/preview/assets/hero.png)');
    expect(rewritten).toContain(`<script>${script}</script>`);
  }, 15_000);
});
