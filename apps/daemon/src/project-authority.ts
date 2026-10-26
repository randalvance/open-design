import type { Response } from 'express';

/**
 * Project data-plane authority for a local-only daemon.
 *
 * Every project the daemon knows about lives on this machine and belongs to
 * whoever is running the daemon, so there is no remote principal to check a
 * request against. Route modules still thread one gate so a future policy has
 * a single seam, but today the invariant is simply: a local project request is
 * always authorized.
 */
export type ProjectRequestCapability =
  | 'rename'
  | 'delete'
  | 'duplicate'
  | 'writeFiles'
  | 'comment';

export type AuthorizeProjectRequestOptions =
  | {
      mode: 'read';
      /** EventSource, iframe, and direct asset navigation cannot set headers. */
      allowNavigationQuery?: boolean;
    }
  | {
      mode: 'write';
      capability: ProjectRequestCapability;
    };

export type AuthorizeProjectRequest = (
  req: any,
  res: Response,
  projectId: string,
  options: AuthorizeProjectRequestOptions,
) => Promise<boolean>;

export type AuthorizedProjectToolRequest = {
  readonly workspace: null;
};

export type AuthorizeProjectToolRequest = (
  res: Response,
  projectId: string,
  options: AuthorizeProjectRequestOptions,
) => Promise<AuthorizedProjectToolRequest | null>;

/** A local project request is always authorized; see the module docblock. */
export const authorizeLocalProjectRequest: AuthorizeProjectRequest = async () => true;

/** Tool-side mirror of {@link authorizeLocalProjectRequest}: no workspace principal. */
export const authorizeLocalProjectToolRequest: AuthorizeProjectToolRequest = async () => ({
  workspace: null,
});
