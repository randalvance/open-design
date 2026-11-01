import type Database from 'better-sqlite3';
import type { CommentFileFact, CommentFileState } from '@open-design/contracts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function canonicalCommentFilePath(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && !value.includes('\0') && /\.html?$/i.test(value) && !value.includes('\\')
    && !value.startsWith('/') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

/** Reads the `_commentFiles` facts an older build may have left on project metadata. */
export function parseCommentFileState(value: unknown): CommentFileState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as CommentFileState;
  if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !Array.isArray(state.files) || state.files.length > 10_000) return null;
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const fact of state.files) {
    if (!fact || !uuid.test(fact.sourceFileId) || ids.has(fact.sourceFileId)
      || !canonicalCommentFilePath(fact.sourceFilePath) || !canonicalCommentFilePath(fact.entryPath)
      || typeof fact.resourceId !== 'string' || !fact.resourceId.trim()
      || typeof fact.versionId !== 'string' || !fact.versionId.trim() || typeof fact.retired !== 'boolean'
      || (!fact.retired && paths.has(fact.sourceFilePath))) return null;
    ids.add(fact.sourceFileId);
    if (!fact.retired) paths.add(fact.sourceFilePath);
  }
  return state;
}

export function migrateCommentFileRetirements(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS comment_file_retirements (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_file_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    creator_member_id TEXT NOT NULL,
    fact_json TEXT NOT NULL,
    committed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, source_file_id)
  )`);
}

/** File lifetimes an older build began retiring. Nothing writes new rows. */
export function pendingCommentFileRetirements(db: Database.Database, projectId: string): CommentFileFact[] {
  const rows = db.prepare('SELECT fact_json FROM comment_file_retirements WHERE project_id = ?')
    .all(projectId) as Array<{ fact_json: string }>;
  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row.fact_json) as CommentFileFact];
    } catch {
      return [];
    }
  });
}
