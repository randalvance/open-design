import type Database from 'better-sqlite3';
import { ensureWorkspaceArtifactForPath } from '../chat-artifacts/store.js';
import { getProject } from '../db.js';
import { canonicalCommentFilePath, parseCommentFileState, pendingCommentFileRetirements } from './comment-file-facts.js';

/**
 * Paths whose comment identity a managed rename must not move. Joins the exact
 * artifact UUID and original path; historical rows never get a guessed identity.
 */
export function trackedCommentFilePaths(db: Database.Database, projectId: string): string[] {
  const facts = parseCommentFileState(getProject(db, projectId)?.metadata?._commentFiles)?.files ?? [];
  const retired = new Set(facts.filter(fact => fact.retired).map(fact => fact.sourceFileId));
  const local = db.prepare(`SELECT DISTINCT a.id, a.current_path AS path
    FROM workspace_artifacts a JOIN preview_comments c
      ON c.project_id = a.project_id AND c.source_file_id = a.id AND c.file_path = a.current_path
    WHERE a.project_id = ? AND a.deleted_at IS NULL AND a.current_path IS NOT NULL`)
    .all(projectId) as Array<{ id: string; path: string }>;
  return [...new Set([...facts.filter(fact => !fact.retired).map(fact => fact.sourceFilePath),
    ...local.filter(row => !retired.has(row.id)).map(row => row.path)])];
}

/**
 * The durable identity a new comment on this HTML file is stamped with.
 *
 * An identity whose lifetime has ended (retired, or left pending by an older
 * build) is hidden by the comment read filter, so reusing it would make the new
 * comment vanish. Tombstone that old pointer so the file gets a fresh one.
 */
export function commentFileIdentity(db: Database.Database, projectId: string, filePath: string): string {
  if (!canonicalCommentFilePath(filePath)) throw new Error('COMMENT_FILE_PATH_INVALID');
  const state = parseCommentFileState(getProject(db, projectId)?.metadata?._commentFiles);
  const pending = pendingCommentFileRetirements(db, projectId).filter(fact => fact.sourceFilePath === filePath);
  const pendingIds = new Set(pending.map(fact => fact.sourceFileId));
  const current = state?.files.find(fact => !fact.retired && fact.sourceFilePath === filePath && !pendingIds.has(fact.sourceFileId));
  if (current) return current.sourceFileId;
  const ended = [...(state?.files.filter(fact => fact.retired && fact.sourceFilePath === filePath) ?? []), ...pending];
  const now = Date.now();
  for (const fact of ended) {
    db.prepare('UPDATE workspace_artifacts SET current_path = NULL, deleted_at = ?, updated_at = ? WHERE project_id = ? AND id = ? AND current_path = ? AND deleted_at IS NULL')
      .run(now, now, projectId, fact.sourceFileId, filePath);
  }
  return ensureWorkspaceArtifactForPath(db, { projectId, path: filePath, kind: 'html' }).id;
}
