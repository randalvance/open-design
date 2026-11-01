import { jsonBodyByteLength } from '../../http/json-body-size.js';
import type { Express, } from 'express';
import type {
  PreviewComment,
  ProjectCommentReadRequest,
} from '@open-design/contracts';
import { SHARE_COMMENT_MAX_BYTES } from '@open-design/contracts';
import { projectKindFromMetadataToTrackingOrLegacyDefault } from '@open-design/contracts/analytics';
import type { RouteDeps } from '../../server-context.js';
import {
  getProject,
  getProjectCommentReadState,
  isProjectCommentAnchorConversationId,
  markProjectCommentsRead,
} from '../../db.js';

export interface RegisterProjectCommentRoutesDeps extends RouteDeps<'db' | 'projectStore' | 'conversations'> {
  /** Optional in focused CRUD fixtures; production supplies request-scoped analytics. */
  telemetry?: RouteDeps<'telemetry'>['telemetry'];
  sendApiError?: (res: any, status: number, code: string, message: string) => unknown;
  /** Stamps the durable local file identity on a new HTML comment. */
  prepareCommentFile?: (projectId: string, filePath: string) => Promise<string | undefined>;
}

/** External authors cannot be claimed through a member-only editing endpoint. */
function hasExternalCommentAuthor(comment: PreviewComment): boolean {
  return comment.authorKind === 'user'
    || (typeof comment.authorAppUserId === 'string' && comment.authorAppUserId.trim().length > 0);
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
    return getPreviewComment(db, projectId, conversationId, commentId, { includeProjectAnchor: true }) as PreviewComment | null;
  }

  function sendCommentPayloadTooLarge(res: any): void {
    const message = `comment request exceeds ${SHARE_COMMENT_MAX_BYTES} bytes`;
    if (ctx.sendApiError) {
      ctx.sendApiError(res, 413, 'PAYLOAD_TOO_LARGE', message);
      return;
    }
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message } });
  }

  // Single local reader. Rows an older build keyed by workspace member stay in
  // the table but no longer apply.
  const LOCAL_VIEWER_SCOPE = 'local';

  app.get('/api/projects/:id/comments/read', async (req, res) => {
    if (!getProject(db, req.params.id)) return res.status(404).json({ error: 'project not found' });
    return res.json(getProjectCommentReadState(db, req.params.id, LOCAL_VIEWER_SCOPE));
  });

  app.put('/api/projects/:id/comments/read', async (req, res) => {
    if (!getProject(db, req.params.id)) return res.status(404).json({ error: 'project not found' });
    const body = req.body as Partial<ProjectCommentReadRequest> | undefined;
    if (!Number.isFinite(body?.readAt)) {
      return res.status(400).json({ error: 'readAt must be a finite number' });
    }
    // A future client clock must not hide comments that have not arrived yet.
    const readAt = Math.min(body!.readAt!, Date.now());
    return res.json(markProjectCommentsRead(db, req.params.id, LOCAL_VIEWER_SCOPE, readAt));
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
    try {
      const body = { ...(req.body || {}) };
      // Author fields are never client-supplied. An older build may have stamped
      // them on a row; those values stay as history and do not gate this user.
      delete body.authorMemberId;
      delete body.authorKind;
      delete body.authorAppUserId;
      delete body.authorDisplayName;
      delete body.authorKey;
      delete body.sourceFileId;
      delete body.sourceFilePath;
      // This is a transport anti-abuse ceiling, not a product character limit.
      // Keep it server-side: CLI and UI must send the body unchanged and let the
      // route reject a pathological UTF-8 payload without creating a row.
      if (jsonBodyByteLength(req) > SHARE_COMMENT_MAX_BYTES) {
        return sendCommentPayloadTooLarge(res);
      }
      const requestedId = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : '';
      let existing: PreviewComment | null = null;
      if (requestedId) {
        existing = getRequestPreviewComment(
          req.params.id,
          req.params.cid,
          requestedId,
        );
        if (!existing) {
          return res.status(404).json({ error: 'comment not found' });
        }
        if (hasExternalCommentAuthor(existing)) {
          return res.status(403).json({ error: 'not permitted' });
        }
        if (existing.authorMemberId) body.authorMemberId = existing.authorMemberId;
      }
      if (existing?.sourceFileId) body.sourceFileId = existing.sourceFileId;
      else if (!requestedId && ctx.prepareCommentFile) {
        const sourceFileId = await ctx.prepareCommentFile(req.params.id, body.target?.filePath ?? '');
        if (sourceFileId) body.sourceFileId = sourceFileId;
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
      try {
        const existing = getRequestPreviewComment(
          req.params.id,
          req.params.cid,
          req.params.commentId,
        );
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
        // Drift-ladder write-back: a derived read-back, not a user edit, so it
        // does not bump updated_at.
        const existing = getRequestPreviewComment(
          req.params.id,
          req.params.cid,
          req.params.commentId,
        );
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
        // Sidebar display order is a viewing preference, not a content edit, so
        // it does not bump updated_at. See PreviewComment.sortKey.
        const existing = getRequestPreviewComment(
          req.params.id,
          req.params.cid,
          req.params.commentId,
        );
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
      const existing = getRequestPreviewComment(
        req.params.id,
        req.params.cid,
        req.params.commentId,
      );
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
