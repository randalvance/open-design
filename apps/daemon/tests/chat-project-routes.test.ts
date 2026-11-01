import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerChatRoutes } from '../src/routes/chat.js';

let server: http.Server | null = null;

afterEach(async () => {
  if (!server) return;
  const toClose = server;
  server = null;
  await new Promise<void>((resolve) => toClose.close(() => resolve()));
});

async function startChatServer(options: {
  run?: {
    id: string;
    projectId: string | null;
    conversationId: string | null;
    assistantMessageId: string | null;
  } | null;
  onArtifact?: any;
  onInterrupt?: any;
}) {
  const app = express();
  app.use(express.json());
  const onArtifact = options.onArtifact ?? vi.fn();
  const onInterrupt = options.onInterrupt ?? vi.fn();
  registerChatRoutes(app, {
    db: {},
    design: {
      runs: {
        get: () => options.run ?? null,
      },
    },
    http: {
      createSseResponse: () => ({
        send: () => true,
        end: () => undefined,
      }),
      sendApiError: (
        res: express.Response,
        status: number,
        code: string,
        message: string,
        details?: Record<string, unknown>,
      ) => res.status(status).json({ error: code, message, ...details }),
    },
    paths: {},
    chat: {},
    agents: {},
    critique: {
      critiqueArtifactsRoot: '/tmp/unused',
      critiqueResponseCapBytes: 1024,
      critiqueRunRegistry: {},
      handleCritiqueArtifact: () => (_req: express.Request, res: express.Response) => {
        onArtifact();
        res.status(200).send('artifact');
      },
      handleCritiqueInterrupt: () => (_req: express.Request, res: express.Response) => {
        onInterrupt();
        res.status(202).json({ accepted: true });
      },
    },
    appConfig: { readAppConfig: async () => ({}) },
    validation: {},
    lifecycle: { isDaemonShuttingDown: () => false },
    telemetry: {},
  } as any);

  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    onArtifact,
    onInterrupt,
  };
}

const RUN_A = {
  id: 'run-a',
  projectId: 'project-a',
  conversationId: 'conversation-a',
  assistantMessageId: 'message-a',
};

describe('chat-owned project routes', () => {
  it.each([
    {
      label: 'SenseAudio',
      path: '/api/proxy/senseaudio/stream',
    },
    {
      label: 'AIHubMix',
      path: '/api/proxy/aihubmix/stream',
    },
  ])('rejects an invalid provider URL on the $label BYOK tool loop before provider work', async ({
    path,
  }) => {
    const api = await startChatServer({});

    const response = await fetch(`${api.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'test-key',
        model: 'test-model',
        projectId: 'legacy-project',
        baseUrl: 'not-a-url',
        messages: [],
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'BAD_REQUEST' });
  });

  it('serves artifact navigation through the critique handler', async () => {
    const api = await startChatServer({});

    const response = await fetch(
      `${api.baseUrl}/api/projects/project-a/critique/run-a/artifact`,
    );

    expect(response.status).toBe(200);
    expect(api.onArtifact).toHaveBeenCalledOnce();
  });

  it('accepts interrupts through the critique handler', async () => {
    const api = await startChatServer({});

    const response = await fetch(
      `${api.baseUrl}/api/projects/project-a/critique/run-a/interrupt`,
      { method: 'POST' },
    );

    expect(response.status).toBe(202);
    expect(api.onInterrupt).toHaveBeenCalledOnce();
  });

  it('rejects caller-owned feedback identity fields instead of accepting spoofed metadata', async () => {
    const api = await startChatServer({ run: RUN_A });

    const response = await fetch(`${api.baseUrl}/api/runs/run-a/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'project-b',
        conversationId: 'conversation-b',
        assistantMessageId: 'message-b',
        rating: 'negative',
        reasonCodes: ['missed_request'],
        hasCustomReason: false,
        customReason: '',
      }),
    });

    expect(response.status).toBe(400);
  });

  it('accepts feedback and relays it nowhere', async () => {
    const api = await startChatServer({ run: RUN_A });

    const response = await fetch(`${api.baseUrl}/api/runs/run-a/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rating: 'positive',
        reasonCodes: ['matched_request'],
        hasCustomReason: true,
        customReason: 'clear result',
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'skipped_no_sink' });
  });
});
