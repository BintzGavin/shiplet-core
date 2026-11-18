import { ensureTraceAudienceSchema } from "./audiences";

// D1 schema for traces. A trace is the full log of an agent session (prompts,
// replies, tool calls and results) stored against a Shiplet. Event bodies live
// in R2; this table holds the metadata and the authorization facts.

export async function ensureTraceSchema(db: D1Database) {
	await db.batch([
		db.prepare(
			`CREATE TABLE IF NOT EXISTS project_traces (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				organization_id TEXT,
				revision_id TEXT,
				uploader_user_id TEXT,
				uploader_token_id TEXT,
				upload_sha256 TEXT NOT NULL,
				sharing TEXT NOT NULL DEFAULT 'private',
				title TEXT NOT NULL,
				harness TEXT NOT NULL,
				started_on TEXT,
				ended_on TEXT,
				event_count INTEGER NOT NULL,
				segment_count INTEGER NOT NULL,
				canonical_bytes INTEGER NOT NULL,
				attachment_count INTEGER NOT NULL,
				attachment_bytes INTEGER NOT NULL,
				pending_attachments INTEGER NOT NULL DEFAULT 0,
				client_masked_count INTEGER NOT NULL,
				server_masked_count INTEGER NOT NULL,
				manifest_sha256 TEXT NOT NULL,
				created_on TEXT NOT NULL,
				FOREIGN KEY (project_id) REFERENCES projects(id)
			)`,
		),
		db.prepare(
			`CREATE UNIQUE INDEX IF NOT EXISTS project_traces_upload
			 ON project_traces(project_id, upload_sha256)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS project_traces_project
			 ON project_traces(project_id, created_on)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS project_traces_org
			 ON project_traces(organization_id)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS project_traces_uploader
			 ON project_traces(uploader_user_id)`,
		),
		// Deferred attachments (session-produced files) awaiting their bytes.
		db.prepare(
			`CREATE TABLE IF NOT EXISTS trace_pending_attachments (
				trace_id TEXT NOT NULL,
				sha256 TEXT NOT NULL,
				media_type TEXT NOT NULL,
				bytes INTEGER NOT NULL,
				PRIMARY KEY (trace_id, sha256)
			)`,
		),
	]);
	// Databases that recorded epoch 5 have project_traces without this column.
	const columns = await db.prepare("PRAGMA table_info(project_traces)").all<{ name: string }>();
	if (!columns.results?.some((column) => column.name === "pending_attachments")) {
		await db.prepare("ALTER TABLE project_traces ADD COLUMN pending_attachments INTEGER NOT NULL DEFAULT 0").run();
	}
	await ensureTraceAudienceSchema(db);
}
