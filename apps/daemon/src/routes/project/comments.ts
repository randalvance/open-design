import { jsonBodyByteLength } from '../../http/json-body-size.js';
import type { Express, Request } from 'express';
import type { PreviewComment } from '@open-design/contracts';
import { projectKindFromMetadataToTrackingOrLegacyDefault } from '@open-design/contracts/analytics';
import type { RouteDeps } from '../../server-context.js';
import type { AuthorizeProjectRequest } from '../../project-authority.js';
import {
  getProject,
  getProjectCommentReadState,
  getFileCommentReadState,
  markFileCommentsSeen,
  isProjectCommentAnchorConversationId,
  markProjectCommentsRead,
} from '../../db.js';

/**
 * Transport anti-abuse ceiling for one comment request body. This is not a
 * product character limit: CLI and UI send the body unchanged and let the
 * route reject a pathological UTF-8 payload without creating a row.
 */
export const COMMENT_REQUEST_MAX_BYTES = 64 * 1024;

/**
 * Read-state viewer scope. Comments are local to this daemon, so there is a
 * single viewer; the column stays keyed so historical rows keep resolving.
 */
const LOCAL_COMMENT_VIEWER_SCOPE = 'local';

export interface RegisterProjectCommentRoutesDeps extends RouteDeps<'db' | 'projectStore' | 'conversations'> {
  /** Optional in focused CRUD fixtures; production supplies request-scoped analytics. */
  telemetry?: RouteDeps<'telemetry'>['telemetry'];
  /**
   * Project data-plane gate shared with the parent project routes. A comment
   * has no binding of its own, so it borrows the project's `comment`
   * capability. Optional so focused CRUD fixtures need not supply it.
   */
  authorizeProjectRequest?: AuthorizeProjectRequest;
  /** Paired with `authorizeProjectRequest` above — formats denials and payload errors. */
  sendApiError?: (res: any, status: number, code: string, message: string) => unknown;
}

export function registerProjectCommentRoutes(app: Express, ctx: RegisterProjectCommentRoutesDeps): void {
  const { db } = ctx;
  const { updateProject } = ctx.projectStore;
  const {
    getConversation,
    listPreviewComments,
    upsertPreviewComment,
    getPreviewComment,
    updatePreviewCommentStatus,
    updatePreviewCommentAnchor,
    deletePreviewComment,
    reorderPreviewComment,
  } = ctx.conversations;
  const getRoutableConversation = (projectId: string, conversationId: string) => {
    if (isProjectCommentAnchorConversationId(conversationId)) return null;
    const conversation = getConversation(db, conversationId);
    return conversation?.projectId === projectId ? conversation : null;
  };

  function getRequestPreviewComment(
    projectId: string,
    conversationId: string,
    commentId: string,
  ): PreviewComment | null {
    return getPreviewComment(db, projectId, conversationId, commentId, {
      includeProjectAnchor: true,
    }) as PreviewComment | null;
  }

  /**
   * Project gate for a comment mutation. Writes the denial itself and returns
   * false; a no-op (always allows) when the gate is not wired up.
   */
  async function authorizeCommentMutation(
    req: Request,
    res: any,
    projectId: string,
  ): Promise<boolean> {
    if (!ctx.authorizeProjectRequest) return true;
    return ctx.authorizeProjectRequest(req, res, projectId, {
      mode: 'write',
      // NOT `writeFiles`: a comment is not an artifact edit.
      capability: 'comment',
    });
  }

  function sendCommentPayloadTooLarge(res: any): void {
    const message = `comment request exceeds ${COMMENT_REQUEST_MAX_BYTES} bytes`;
    if (ctx.sendApiError) {
      ctx.sendApiError(res, 413, 'PAYLOAD_TOO_LARGE', message);
      return;
    }
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message } });
  }

  app.get('/api/projects/:id/comments/read', async (req, res) => {
    if (!getProject(db, req.params.id)) return res.status(404).json({ error: 'project not found' });
    const filePath = typeof req.query.filePath === 'string' ? req.query.filePath : null;
    if (filePath) return res.json(getFileCommentReadState(db, req.params.id, LOCAL_COMMENT_VIEWER_SCOPE, filePath));
    return res.json(getProjectCommentReadState(db, req.params.id, LOCAL_COMMENT_VIEWER_SCOPE));
  });

  app.put('/api/projects/:id/comments/read', async (req, res) => {
    if (!getProject(db, req.params.id)) return res.status(404).json({ error: 'project not found' });
    const body = req.body as { readAt?: unknown; filePath?: unknown; commentIds?: unknown } | undefined;
    if (body?.filePath !== undefined || body?.commentIds !== undefined) {
      if (typeof body.filePath !== 'string' || !body.filePath.trim() || !Array.isArray(body.commentIds)
        || body.commentIds.length > 500 || body.commentIds.some(id => typeof id !== 'string' || !id || id.length > 256)) {
        return res.status(400).json({ error: 'filePath and up to 500 commentIds are required' });
      }
      return res.json(markFileCommentsSeen(db, req.params.id, LOCAL_COMMENT_VIEWER_SCOPE, body.filePath, body.commentIds as string[]));
    }
    if (typeof body?.readAt !== 'number' || !Number.isFinite(body.readAt)) {
      return res.status(400).json({ error: 'readAt must be a finite number' });
    }
    // A future client clock must not hide comments that have not arrived yet.
    const readAt = Math.min(body.readAt, Date.now());
    return res.json(markProjectCommentsRead(db, req.params.id, LOCAL_COMMENT_VIEWER_SCOPE, readAt));
  });

  // ---- Preview comments ----------------------------------------------------

  app.get('/api/projects/:id/conversations/:cid/comments', async (req, res) => {
    const conv = getRoutableConversation(req.params.id, req.params.cid);
    if (!conv) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    res.json({
      comments: listPreviewComments(db, req.params.id, req.params.cid, { includeProjectAnchor: true }),
    });
  });

  app.post('/api/projects/:id/conversations/:cid/comments', async (req, res) => {
    const conv = getRoutableConversation(req.params.id, req.params.cid);
    if (!conv) {
      return res.status(404).json({ error: 'conversation not found' });
    }
    if (!await authorizeCommentMutation(req, res, req.params.id)) return;
    try {
      // New comments do not use a natural element key; editing requires an id.
      const body = { ...(req.body || {}) };
      // Author identity fields are daemon-owned. A local daemon has no
      // account to attribute a comment to, so none is stamped; strip every
      // client-supplied author field so a forged identity never reaches SQLite.
      delete body.authorMemberId;
      delete body.authorKind;
      delete body.authorAppUserId;
      delete body.authorDisplayName;
      delete body.authorKey;
      delete body.sourceFileId;
      delete body.sourceFilePath;
      if (jsonBodyByteLength(req) > COMMENT_REQUEST_MAX_BYTES) {
        return sendCommentPayloadTooLarge(res);
      }
      const requestedId = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : '';
      let existing: PreviewComment | null = null;
      if (requestedId) {
        existing = getRequestPreviewComment(req.params.id, req.params.cid, requestedId);
        if (!existing) {
          return res.status(404).json({ error: 'comment not found' });
        }
        // An edit keeps whatever attribution the row already carries.
        if (existing.authorMemberId) body.authorMemberId = existing.authorMemberId;
        if (existing.sourceFileId) body.sourceFileId = existing.sourceFileId;
      }
      const targetConversationId = requestedId
        ? existing?.conversationId ?? req.params.cid
        : req.params.cid;
      const comment = db.transaction(() => {
        const saved = upsertPreviewComment(db, req.params.id, targetConversationId, body);
        updateProject(db, req.params.id, {});
        return saved;
      })();
      // Only a genuinely new, successfully persisted comment is counted.
      // Edits reuse this POST route with an id and must not inflate creation.
      if (comment && !requestedId) {
        const project = getProject(db, req.params.id);
        try {
          void Promise.resolve(ctx.telemetry?.captureProductEvent?.(
            req,
            'project_comment_create_result',
            {
              page_name: 'artifact',
              area: 'comments',
              result: 'success',
              target_project_relation: 'self',
              comment_level: 'top_level',
              project_id: req.params.id,
              comment_id: comment.id,
              project_kind: projectKindFromMetadataToTrackingOrLegacyDefault(project?.metadata),
            },
          )).catch(() => {});
        } catch {
          // Measurement cannot change the successful save or response.
        }
      }
      res.json({ comment });
    } catch (err: any) {
      res.status(400).json({ error: String(err?.message || err) });
    }
  });

  app.patch(
    '/api/projects/:id/conversations/:cid/comments/:commentId',
    async (req, res) => {
      const conv = getRoutableConversation(req.params.id, req.params.cid);
      if (!conv) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      if (!await authorizeCommentMutation(req, res, req.params.id)) return;
      try {
        const existing = getRequestPreviewComment(req.params.id, req.params.cid, req.params.commentId);
        if (!existing) return res.status(404).json({ error: 'comment not found' });
        const comment = db.transaction(() => {
          const saved = updatePreviewCommentStatus(
            db,
            req.params.id,
            existing.conversationId,
            req.params.commentId,
            req.body?.status,
          );
          if (!saved) return null;
          updateProject(db, req.params.id, {});
          return saved;
        })();
        if (!comment)
          return res.status(404).json({ error: 'comment not found' });
        res.json({ comment });
      } catch (err: any) {
        res.status(400).json({ error: String(err?.message || err) });
      }
    },
  );

  app.patch(
    '/api/projects/:id/conversations/:cid/comments/:commentId/anchor',
    async (req, res) => {
      const conv = getRoutableConversation(req.params.id, req.params.cid);
      if (!conv) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      try {
        // Drift-ladder write-back: the client resolves anchor state each render
        // and reports it here. This is a DERIVED read-back, not a user edit —
        // so it is neither permission-gated nor does it bump updated_at.
        const existing = getRequestPreviewComment(req.params.id, req.params.cid, req.params.commentId);
        if (!existing) return res.status(404).json({ error: 'comment not found' });
        const comment = updatePreviewCommentAnchor(
          db,
          req.params.id,
          existing.conversationId,
          req.params.commentId,
          req.body || {},
        );
        if (!comment) return res.status(404).json({ error: 'comment not found' });
        res.json({ comment });
      } catch (err: any) {
        res.status(400).json({ error: String(err?.message || err) });
      }
    },
  );

  app.patch(
    '/api/projects/:id/conversations/:cid/comments/:commentId/reorder',
    async (req, res) => {
      const conv = getRoutableConversation(req.params.id, req.params.cid);
      if (!conv) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      const sortKey = Number(req.body?.sortKey);
      if (!Number.isFinite(sortKey)) {
        return res.status(400).json({ error: 'sortKey must be a finite number' });
      }
      try {
        // Sidebar display order is a viewing preference, not a content edit:
        // it does not bump updated_at — see PreviewComment.sortKey.
        const existing = getRequestPreviewComment(req.params.id, req.params.cid, req.params.commentId);
        if (!existing) return res.status(404).json({ error: 'comment not found' });
        const comment = reorderPreviewComment(
          db,
          req.params.id,
          existing.conversationId,
          req.params.commentId,
          sortKey,
        );
        if (!comment) return res.status(404).json({ error: 'comment not found' });
        res.json({ comment });
      } catch (err: any) {
        res.status(400).json({ error: String(err?.message || err) });
      }
    },
  );

  app.delete(
    '/api/projects/:id/conversations/:cid/comments/:commentId',
    async (req, res) => {
      const conv = getRoutableConversation(req.params.id, req.params.cid);
      if (!conv) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      if (!await authorizeCommentMutation(req, res, req.params.id)) return;
      const existing = getRequestPreviewComment(req.params.id, req.params.cid, req.params.commentId);
      if (!existing) return res.status(404).json({ error: 'comment not found' });
      let ok = false;
      try {
        ok = db.transaction(() => {
          const deleted = deletePreviewComment(
            db,
            req.params.id,
            existing.conversationId,
            req.params.commentId,
          );
          if (!deleted) return false;
          updateProject(db, req.params.id, {});
          return true;
        })();
      } catch (err: any) {
        return res.status(400).json({ error: String(err?.message || err) });
      }
      if (!ok) return res.status(404).json({ error: 'comment not found' });
      res.json({ ok: true });
    },
  );
}
