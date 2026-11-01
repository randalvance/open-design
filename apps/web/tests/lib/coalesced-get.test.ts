import { describe, expect, it } from 'vitest';
import { coalescedGet } from '../../src/lib/coalesced-get';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('coalescedGet', () => {
  it('joins concurrent identical calls into one run (single-flight)', async () => {
    let runs = 0;
    let release!: (v: number) => void;
    const gate = new Promise<number>((r) => {
      release = r;
    });
    const run = () => {
      runs += 1;
      return gate;
    };

    // Both callers arrive while the request is in flight → one run, shared value.
    const a = coalescedGet('k-inflight', run);
    const b = coalescedGet('k-inflight', run);
    release(42);
    expect(await a).toBe(42);
    expect(await b).toBe(42);
    expect(runs).toBe(1);
  });

  it('shares the settled result within the TTL window', async () => {
    let runs = 0;
    const run = () => {
      runs += 1;
      return Promise.resolve(runs);
    };

    const first = await coalescedGet('k-ttl', run, 1000);
    const second = await coalescedGet('k-ttl', run, 1000);
    expect(first).toBe(1);
    expect(second).toBe(1); // served from the shared window, not a second run
    expect(runs).toBe(1);
  });

  it('refetches after the TTL window elapses', async () => {
    let runs = 0;
    const run = () => {
      runs += 1;
      return Promise.resolve(runs);
    };

    expect(await coalescedGet('k-expire', run, 20)).toBe(1);
    await tick(40);
    expect(await coalescedGet('k-expire', run, 20)).toBe(2);
    expect(runs).toBe(2);
  });

  it('never caches a rejection — the next caller retries', async () => {
    let runs = 0;
    const run = () => {
      runs += 1;
      return runs === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok');
    };

    await expect(coalescedGet('k-reject', run)).rejects.toThrow('boom');
    // Immediately after the failure the entry is gone, so this re-runs.
    expect(await coalescedGet('k-reject', run)).toBe('ok');
    expect(runs).toBe(2);
  });

  it('keys independently — different keys do not share results', async () => {
    const a = await coalescedGet('k-a', () => Promise.resolve('a'));
    const b = await coalescedGet('k-b', () => Promise.resolve('b'));
    expect(a).toBe('a');
    expect(b).toBe('b');
  });
});

