// Schema for retired cloud features (team sync, comment relay, public file
// publishing, AMR terminal reports).
//
// Nothing reads or writes these tables any more. They stay so a database written
// by an older build keeps opening at the same schema, and so its rows are never
// dropped. Do not add consumers here, and do not delete a migration: `CREATE TABLE
// IF NOT EXISTS` plus additive column checks are what make an old database open.

import type Database from 'better-sqlite3';

type SqliteDb = Database.Database;

function hasColumn(db: SqliteDb, name: string): boolean {
  const columns = db.prepare('PRAGMA table_info(amr_terminal_report_outbox)').all() as Array<{ name: string }>;
  return columns.some((column) => column.name === name);
}

export function migrateCollabSyncSnapshots(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collab_sync_snapshots (
      face TEXT NOT NULL,
      account_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      digest_token TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (face, account_id, workspace_id)
    );
  `);
}

export function migrateCommentRelayPublicationMappings(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS comment_relay_publication_mappings (
    resource_team_id TEXT NOT NULL, owner_member_id TEXT NOT NULL,
    project_id TEXT NOT NULL, file_path TEXT NOT NULL,
    slug TEXT NOT NULL, revision TEXT NOT NULL, public_file_path TEXT NOT NULL,
    PRIMARY KEY(resource_team_id, owner_member_id, project_id, file_path)
  )`);
  db.exec('CREATE TABLE IF NOT EXISTS published_comment_mutations (resource_team_id TEXT NOT NULL, owner_member_id TEXT NOT NULL, project_id TEXT NOT NULL, file_path TEXT NOT NULL, comment_id TEXT NOT NULL, slug TEXT NOT NULL, publication_revision TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(resource_team_id,owner_member_id,project_id,file_path,comment_id))');
}

export function migrateCommentRelayOutbox(db: SqliteDb): void {
	migrateCommentRelayPublicationMappings(db);
	db.exec(`
    CREATE TABLE IF NOT EXISTS comment_relay_outbox (
      workspace_id TEXT NOT NULL,
      workspace_member_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      relay_scope TEXT NOT NULL DEFAULT 'team',
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL DEFAULT '',
      comment_id TEXT NOT NULL,
      expected_owner_member_id TEXT,
      payload_json TEXT NOT NULL,
      event_key TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, workspace_member_id, project_id, comment_id)
    );

    CREATE TABLE IF NOT EXISTS comment_relay_mutation_keys (
      workspace_id TEXT NOT NULL, workspace_member_id TEXT NOT NULL,
      project_id TEXT NOT NULL, comment_id TEXT NOT NULL,
      source_file_path TEXT NOT NULL, publication_slug TEXT NOT NULL,
      payload_fingerprint TEXT NOT NULL, event_key TEXT NOT NULL,
      PRIMARY KEY (workspace_id, workspace_member_id, project_id, comment_id)
    );

    CREATE TABLE IF NOT EXISTS comment_relay_sync_failures (
      workspace_id TEXT NOT NULL,
      workspace_member_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      failed_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, workspace_member_id, project_id)
    );

    CREATE INDEX IF NOT EXISTS idx_comment_relay_outbox_due
      ON comment_relay_outbox(next_attempt_at, updated_at);
  `);
	const columns = db
		.prepare("PRAGMA table_info(comment_relay_outbox)")
		.all() as Array<{ name: string }>;
	if (!columns.some((column) => column.name === "publication_json")) {
		db.exec(
			"ALTER TABLE comment_relay_outbox ADD COLUMN publication_json TEXT",
		);
	}
	if (!columns.some((column) => column.name === "event_key"))
		db.exec("ALTER TABLE comment_relay_outbox ADD COLUMN event_key TEXT");
	// Compatible with rows written before personal publication relay existed.
	try {
		db.exec(
			"ALTER TABLE comment_relay_outbox ADD COLUMN relay_scope TEXT NOT NULL DEFAULT 'team'",
		);
	} catch {
		/* already migrated */
	}
	try {
		db.exec(
			"ALTER TABLE comment_relay_outbox ADD COLUMN file_path TEXT NOT NULL DEFAULT ''",
		);
	} catch {
		/* already migrated */
	}
	// Personal rows predate the explicit exact-file cancellation key. Backfill
	// from the durable payload once; malformed legacy JSON stays uncancelled and
	// remains protected by the existing delivery-time eligibility gate.
	db.exec(`UPDATE comment_relay_outbox
    SET file_path = COALESCE(json_extract(payload_json, '$.filePath'), file_path)
    WHERE relay_scope = 'personal' AND file_path = '' AND json_valid(payload_json)`);
	db.exec(`UPDATE comment_relay_outbox SET event_key = lower(hex(randomblob(16))) WHERE event_key IS NULL;
    INSERT OR IGNORE INTO comment_relay_mutation_keys(workspace_id,workspace_member_id,project_id,comment_id,source_file_path,publication_slug,payload_fingerprint,event_key)
    SELECT workspace_id,workspace_member_id,project_id,comment_id,file_path,COALESCE(json_extract(publication_json, '$.slug'), ''),'',event_key FROM comment_relay_outbox WHERE event_key IS NOT NULL`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_comment_relay_outbox_personal_publication
    ON comment_relay_outbox(
      workspace_id, workspace_member_id, team_id, relay_scope, project_id, file_path
    )`);
}

export function migrateAmrTerminalReportOutbox(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS amr_terminal_report_outbox (
      run_id TEXT PRIMARY KEY,
      outcome TEXT NOT NULL CHECK (outcome IN ('failed', 'canceled')),
      terminal_at INTEGER NOT NULL
    );
  `);
  const additions: Array<[string, string]> = [
    ['terminal_at_iso', 'ALTER TABLE amr_terminal_report_outbox ADD COLUMN terminal_at_iso TEXT'],
    ['state', "ALTER TABLE amr_terminal_report_outbox ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'"],
    ['attempt_count', 'ALTER TABLE amr_terminal_report_outbox ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0'],
    ['next_attempt_at', 'ALTER TABLE amr_terminal_report_outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0'],
    ['version', 'ALTER TABLE amr_terminal_report_outbox ADD COLUMN version INTEGER NOT NULL DEFAULT 0'],
    ['lease_until', 'ALTER TABLE amr_terminal_report_outbox ADD COLUMN lease_until INTEGER'],
    ['last_error_code', 'ALTER TABLE amr_terminal_report_outbox ADD COLUMN last_error_code TEXT'],
    ['last_error', 'ALTER TABLE amr_terminal_report_outbox ADD COLUMN last_error TEXT'],
    ['receipt', 'ALTER TABLE amr_terminal_report_outbox ADD COLUMN receipt TEXT'],
    ['created_at', 'ALTER TABLE amr_terminal_report_outbox ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0'],
    ['updated_at', 'ALTER TABLE amr_terminal_report_outbox ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [name, statement] of additions) {
    if (!hasColumn(db, name)) db.exec(statement);
  }
  const missingIso = db.prepare(`
    SELECT run_id AS runId, terminal_at AS terminalAt
      FROM amr_terminal_report_outbox
     WHERE terminal_at_iso IS NULL OR terminal_at_iso = ''
  `).all() as Array<{ runId: string; terminalAt: number }>;
  const backfill = db.prepare(`
    UPDATE amr_terminal_report_outbox
       SET terminal_at_iso = ?,
           next_attempt_at = CASE WHEN next_attempt_at = 0 THEN terminal_at ELSE next_attempt_at END,
           created_at = CASE WHEN created_at = 0 THEN terminal_at ELSE created_at END,
           updated_at = CASE WHEN updated_at = 0 THEN terminal_at ELSE updated_at END
     WHERE run_id = ?
  `);
  const transaction = db.transaction(() => {
    for (const row of missingIso) backfill.run(new Date(row.terminalAt).toISOString(), row.runId);
  });
  transaction();
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_amr_terminal_report_outbox_due
      ON amr_terminal_report_outbox(state, next_attempt_at, lease_until, run_id);
    CREATE INDEX IF NOT EXISTS idx_amr_terminal_report_outbox_terminal_at
      ON amr_terminal_report_outbox(terminal_at, run_id);
  `);
}

export function migratePublishedCommentBackfillState(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS published_comment_backfill_batches (
      workspace_id TEXT NOT NULL,
      workspace_member_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      publication_revision TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed')),
      retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
      code TEXT,
      reopened INTEGER CHECK (reopened IN (0, 1)),
      PRIMARY KEY (workspace_id, workspace_member_id, project_id, file_path, publication_revision)
    );
    CREATE TABLE IF NOT EXISTS published_comment_backfill_members (
      workspace_id TEXT NOT NULL,
      workspace_member_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      publication_revision TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1)),
      PRIMARY KEY (workspace_id, workspace_member_id, project_id, file_path, publication_revision, comment_id)
    );
  `);
  const columns = db.prepare("PRAGMA table_info(published_comment_backfill_batches)").all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === "reopened")) {
    db.exec("ALTER TABLE published_comment_backfill_batches ADD COLUMN reopened INTEGER CHECK (reopened IN (0, 1))");
  }
}

export function migratePublicFilePublications(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS public_file_publications (
      resource_team_id TEXT NOT NULL,
      owner_member_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      url TEXT,
      slug TEXT NOT NULL,
      file_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revision TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (resource_team_id, owner_member_id, project_id, file_path)
    );
    CREATE TABLE IF NOT EXISTS public_file_stop_queue (
      resource_team_id TEXT NOT NULL,
      owner_member_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      slug TEXT NOT NULL,
      failure_count INTEGER NOT NULL CHECK (failure_count BETWEEN 1 AND 5),
      publication_revision TEXT,
      PRIMARY KEY (resource_team_id, owner_member_id, project_id, file_path, slug)
    );
  `);
  const stopColumns = db.prepare('PRAGMA table_info(public_file_stop_queue)').all() as Array<{ name: string }>;
  if (!stopColumns.some(column => column.name === 'publication_revision')) {
    db.exec('ALTER TABLE public_file_stop_queue ADD COLUMN publication_revision TEXT');
  }
  const columns = db.prepare('PRAGMA table_info(public_file_publications)').all() as Array<{ name: string; notnull: number }>;
  if (!columns.some(column => column.name === 'revision')) {
    db.exec("ALTER TABLE public_file_publications ADD COLUMN revision TEXT NOT NULL DEFAULT ''");
  }
  // Legacy rows required a display URL to exist before retaining a publication
  // witness. Preserve every identity/revision while allowing a real SQL NULL;
  // an empty or guessed URL would leak a false copy target to callers.
  if (columns.find(column => column.name === 'url')?.notnull) {
    db.transaction(() => {
      db.exec(`CREATE TABLE public_file_publications_nullable (
        resource_team_id TEXT NOT NULL, owner_member_id TEXT NOT NULL,
        project_id TEXT NOT NULL, file_path TEXT NOT NULL, url TEXT,
        slug TEXT NOT NULL, file_name TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        revision TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (resource_team_id, owner_member_id, project_id, file_path)
      );
      INSERT INTO public_file_publications_nullable
        SELECT resource_team_id, owner_member_id, project_id, file_path, url,
          slug, file_name, created_at, updated_at, revision FROM public_file_publications;
      DROP TABLE public_file_publications;
      ALTER TABLE public_file_publications_nullable RENAME TO public_file_publications;`);
    })();
  }
}

export function migrateCommentInboundStore(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS comment_member_sync_cursor (
    workspace_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('snapshot','incremental')),
    page_token TEXT,
    resume_token TEXT,
    stream_epoch TEXT NOT NULL,
    scope_token TEXT NOT NULL,
    watermark_seq INTEGER NOT NULL,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    CHECK((page_token IS NULL) <> (resume_token IS NULL)),
    PRIMARY KEY(workspace_id, member_id, team_id, project_id)
  )`);
  // Ids the member stream delivered to a scope; `seen` is the current snapshot
  // pass's mark (see the header comment).
  db.exec(`CREATE TABLE IF NOT EXISTS comment_member_sync_known (
    workspace_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    seen INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(workspace_id, member_id, team_id, project_id, comment_id)
  )`);
}

export function migrateOwnedContentSync(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS owned_content_sync (
    scope_key TEXT PRIMARY KEY,
    local_version INTEGER,
    latest_version INTEGER,
    ignored_version INTEGER,
    prompt_suppressed_until INTEGER,
    fingerprint TEXT
  )`);
  const columns = db.pragma('table_info(owned_content_sync)') as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'prompt_suppressed_until')) {
    db.exec('ALTER TABLE owned_content_sync ADD COLUMN prompt_suppressed_until INTEGER');
  }
  // The earlier unshipped implementation stored automatic overwrite permission.
  // Do not inherit that permission as either synchronization or reminder consent.
  if (columns.some(column => column.name === 'auto_apply_until')) {
    db.exec('UPDATE owned_content_sync SET auto_apply_until = NULL WHERE auto_apply_until IS NOT NULL');
  }
}
