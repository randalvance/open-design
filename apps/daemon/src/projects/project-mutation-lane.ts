import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, RequestHandler, Response } from 'express';

export interface ProjectMutationLane {
  /** A nested operation may join its caller's still-active lane. */
  run<T>(projectId: string | readonly string[], operation: () => Promise<T>, options?: { joinCurrent?: true }): Promise<T>;
}

/**
 * One lane per project for destructive file and project operations. Held until
 * the operation settles, not until its HTTP connection closes. Independent
 * projects never block each other.
 */
export function createProjectMutationLane(): ProjectMutationLane {
  const tails = new Map<string, Promise<void>>();
  const ownership = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();
  async function run<T>(projectId: string | readonly string[], operation: () => Promise<T>, options?: { joinCurrent?: true }): Promise<T> {
    const keys = [...new Set(typeof projectId === 'string' ? [projectId] : projectId)].sort();
    const inherited = ownership.getStore();
    if (options?.joinCurrent && keys.every(key => inherited?.get(key)?.active)) return operation();
    async function acquire(index: number): Promise<T> {
      const key = keys[index];
      if (key === undefined) {
        const lease = { active: true };
        const owned = new Map(inherited);
        for (const heldKey of keys) owned.set(heldKey, lease);
        try {
          return await ownership.run(owned, operation);
        } finally {
          // Async descendants may outlive the caller; expired ownership is
          // never permission to bypass a later request's queued mutation.
          lease.active = false;
        }
      }
      const previous = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => { release = resolve; });
      tails.set(key, current);
      await previous;
      try {
        return await acquire(index + 1);
      } finally {
        release();
        if (tails.get(key) === current) tails.delete(key);
      }
    }
    return acquire(0);
  }
  return { run };
}

/** Serialize the entire handler, including post-request cleanup. */
export function projectMutationHandler(
  lane: ProjectMutationLane | undefined,
  handler: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
  return async (req, res) => {
    const projectId = String(req.params.id ?? req.params[0] ?? '');
    if (lane) await lane.run(projectId, () => handler(req, res));
    else await handler(req, res);
  };
}
