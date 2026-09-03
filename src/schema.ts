const USER_COLUMNS: Array<{ name: string; ddl: string }> = [
	{
		name: "avatar_preset",
		ddl: "avatar_preset TEXT NOT NULL DEFAULT 'aurora-grid'",
	},
	{ name: "avatar_data_url", ddl: "avatar_data_url TEXT" },
];

const PROJECT_COLUMNS: Array<{ name: string; ddl: string }> = [
	{ name: "organization_id", ddl: "organization_id TEXT" },
	{ name: "owner_user_id", ddl: "owner_user_id TEXT" },
	{
		name: "source_type",
		ddl: "source_type TEXT NOT NULL DEFAULT 'static'",
	},
	{
		name: "external_origin_url",
		ddl: "external_origin_url TEXT",
	},
	{
		name: "visibility",
		ddl: "visibility TEXT NOT NULL DEFAULT 'organization'",
	},
	{ name: "archived_on", ddl: "archived_on TEXT" },
	{ name: "delete_after", ddl: "delete_after TEXT" },
];

const PROJECT_ASSET_COLUMNS: Array<{ name: string; ddl: string }> = [
	{ name: "object_key", ddl: "object_key TEXT" },
];

async function addColumnIfMissing(
	db: D1Database,
	tableName: string,
	column: { name: string; ddl: string },
) {
	const columns = await db.prepare(`PRAGMA table_info(${tableName})`).all<{
		name: string;
	}>();
	const exists = columns.results?.some((row) => row.name === column.name);
	if (!exists) {
		await db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${column.ddl}`).run();
	}
}

export async function ensureSchema(db: D1Database) {
	await db.batch([
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS users (
					id TEXT PRIMARY KEY,
					email TEXT NOT NULL UNIQUE,
					first_name TEXT,
					last_name TEXT,
					avatar_preset TEXT NOT NULL DEFAULT 'aurora-grid',
					avatar_data_url TEXT,
					created_on TEXT NOT NULL,
					updated_on TEXT NOT NULL
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS workos_user_identities (
					workos_user_id TEXT PRIMARY KEY,
					user_id TEXT NOT NULL,
					email TEXT NOT NULL,
					created_on TEXT NOT NULL,
					last_authenticated_on TEXT NOT NULL,
					FOREIGN KEY (user_id) REFERENCES users(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS sessions (
					id TEXT PRIMARY KEY,
					user_id TEXT NOT NULL,
					expires_on TEXT NOT NULL,
					created_on TEXT NOT NULL,
					FOREIGN KEY (user_id) REFERENCES users(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS account_group_sessions (
					group_id TEXT NOT NULL,
					user_id TEXT NOT NULL,
					session_id TEXT NOT NULL UNIQUE,
					created_on TEXT NOT NULL,
					last_selected_on TEXT NOT NULL,
					PRIMARY KEY (group_id, user_id),
					FOREIGN KEY (user_id) REFERENCES users(id),
					FOREIGN KEY (session_id) REFERENCES sessions(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS cli_authorization_requests (
					id TEXT PRIMARY KEY,
					user_id TEXT NOT NULL,
					redirect_uri TEXT NOT NULL,
					state_value TEXT NOT NULL,
					code_challenge TEXT NOT NULL,
					code_hash TEXT UNIQUE,
						expires_on TEXT NOT NULL,
						approved_on TEXT,
						exchanged_on TEXT,
						exchange_marker TEXT UNIQUE,
						created_on TEXT NOT NULL
					)`,
				),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS cli_session_audit_events (
					sequence INTEGER PRIMARY KEY AUTOINCREMENT,
					id TEXT NOT NULL UNIQUE,
					authorization_request_id TEXT NOT NULL,
					user_id TEXT NOT NULL,
					event_kind TEXT NOT NULL CHECK (event_kind IN (
						'cli.authorization.requested',
						'cli.authorization.approved',
						'cli.session.exchanged',
						'cli.session.revoked'
					)),
					summary TEXT NOT NULL,
					metadata_json TEXT NOT NULL,
					occurred_on TEXT NOT NULL,
					UNIQUE (authorization_request_id, event_kind),
					FOREIGN KEY (authorization_request_id)
					 REFERENCES cli_authorization_requests(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS cli_sessions (
						session_hash TEXT PRIMARY KEY,
						authorization_request_id TEXT NOT NULL,
						user_id TEXT NOT NULL,
					scopes_json TEXT NOT NULL,
					expires_on TEXT NOT NULL,
					created_on TEXT NOT NULL,
					revoked_on TEXT
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS organizations (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					created_by_user_id TEXT NOT NULL,
					created_on TEXT NOT NULL,
					FOREIGN KEY (created_by_user_id) REFERENCES users(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS organization_memberships (
					id TEXT PRIMARY KEY,
					organization_id TEXT NOT NULL,
					user_id TEXT NOT NULL,
					role TEXT NOT NULL,
					created_on TEXT NOT NULL,
					UNIQUE (organization_id, user_id),
					FOREIGN KEY (organization_id) REFERENCES organizations(id),
					FOREIGN KEY (user_id) REFERENCES users(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS teams (
					id TEXT PRIMARY KEY,
					organization_id TEXT NOT NULL,
					name TEXT NOT NULL,
					description TEXT,
					created_by_user_id TEXT NOT NULL,
					created_on TEXT NOT NULL,
					UNIQUE (organization_id, name),
					FOREIGN KEY (organization_id) REFERENCES organizations(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS team_memberships (
					team_id TEXT NOT NULL,
					user_id TEXT NOT NULL,
					organization_membership_id TEXT,
					created_on TEXT NOT NULL,
					PRIMARY KEY (team_id, user_id),
					FOREIGN KEY (team_id) REFERENCES teams(id),
					FOREIGN KEY (user_id) REFERENCES users(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS projects (
					id TEXT PRIMARY KEY,
					organization_id TEXT,
					owner_user_id TEXT,
					name TEXT NOT NULL,
					subdomain TEXT UNIQUE NOT NULL,
					custom_hostname TEXT,
					source_type TEXT NOT NULL DEFAULT 'static',
					external_origin_url TEXT,
					script_content TEXT NOT NULL,
					visibility TEXT NOT NULL DEFAULT 'organization',
					archived_on TEXT,
					delete_after TEXT,
					created_on TEXT NOT NULL,
					modified_on TEXT NOT NULL
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS shiplet_access_grants (
					id TEXT PRIMARY KEY,
					project_id TEXT NOT NULL,
					organization_id TEXT NOT NULL,
					target_type TEXT NOT NULL,
					target_id TEXT,
					email TEXT,
					role TEXT NOT NULL,
					invited_by_user_id TEXT NOT NULL,
					workos_invitation_id TEXT,
					created_on TEXT NOT NULL,
					accepted_on TEXT,
					FOREIGN KEY (project_id) REFERENCES projects(id),
					FOREIGN KEY (organization_id) REFERENCES organizations(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS shiplet_access_requests (
					id TEXT PRIMARY KEY,
					project_id TEXT NOT NULL,
					organization_id TEXT,
					requester_user_id TEXT NOT NULL,
					requester_email TEXT NOT NULL,
					status TEXT NOT NULL DEFAULT 'pending',
					email_status TEXT NOT NULL DEFAULT 'pending',
					email_error TEXT,
					created_on TEXT NOT NULL,
					updated_on TEXT NOT NULL,
					UNIQUE (project_id, requester_user_id),
					FOREIGN KEY (project_id) REFERENCES projects(id),
					FOREIGN KEY (requester_user_id) REFERENCES users(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS project_assets (
					project_id TEXT NOT NULL,
					path TEXT NOT NULL,
					content_type TEXT NOT NULL,
					content_base64 TEXT NOT NULL,
					object_key TEXT,
					size INTEGER NOT NULL,
					created_on TEXT NOT NULL,
					PRIMARY KEY (project_id, path),
					FOREIGN KEY (project_id) REFERENCES projects(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS app_invitations (
					id TEXT PRIMARY KEY,
					organization_id TEXT NOT NULL,
					team_id TEXT,
					project_id TEXT,
					email TEXT NOT NULL,
					invite_type TEXT NOT NULL,
					role TEXT NOT NULL,
					status TEXT NOT NULL,
					invited_by_user_id TEXT NOT NULL,
					workos_invitation_id TEXT NOT NULL,
					workos_invitation_token TEXT,
					created_on TEXT NOT NULL,
					accepted_on TEXT,
					FOREIGN KEY (organization_id) REFERENCES organizations(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS review_feedback (
					id TEXT PRIMARY KEY,
					project_id TEXT NOT NULL,
					organization_id TEXT NOT NULL,
					ticket_number INTEGER NOT NULL,
					client_feedback_id TEXT NOT NULL,
					name TEXT,
					comment TEXT NOT NULL,
					status TEXT NOT NULL DEFAULT 'New',
					page_url TEXT NOT NULL,
					pathname TEXT NOT NULL,
					page_url_key TEXT NOT NULL,
					screenshot_key TEXT,
					screenshot_content_type TEXT,
					screenshot_size INTEGER,
					screenshot_failure_note TEXT,
					screenshot_mode TEXT NOT NULL DEFAULT 'page',
					viewport_json TEXT,
					coordinates_json TEXT,
					selected_element_json TEXT,
					capture_context_json TEXT,
					user_agent TEXT,
					submitted_by_user_id TEXT,
					submitted_by_email TEXT,
					source TEXT NOT NULL DEFAULT 'web',
					created_on TEXT NOT NULL,
					updated_on TEXT NOT NULL,
					UNIQUE (project_id, ticket_number),
					UNIQUE (project_id, client_feedback_id),
					FOREIGN KEY (project_id) REFERENCES projects(id),
					FOREIGN KEY (organization_id) REFERENCES organizations(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS review_feedback_replies (
					id TEXT PRIMARY KEY,
					feedback_id TEXT NOT NULL,
					project_id TEXT NOT NULL,
					comment TEXT NOT NULL,
					author_user_id TEXT,
					author_email TEXT,
					created_on TEXT NOT NULL,
					FOREIGN KEY (feedback_id) REFERENCES review_feedback(id),
					FOREIGN KEY (project_id) REFERENCES projects(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS review_feedback_mentions (
					id TEXT PRIMARY KEY,
					project_id TEXT NOT NULL,
					organization_id TEXT NOT NULL,
					feedback_id TEXT NOT NULL,
					reply_id TEXT,
					mentioned_user_id TEXT NOT NULL,
					mentioned_email TEXT NOT NULL,
					mentioned_name TEXT,
					access_status TEXT NOT NULL,
					grant_id TEXT,
					invite_error TEXT,
					created_on TEXT NOT NULL,
					FOREIGN KEY (project_id) REFERENCES projects(id),
					FOREIGN KEY (feedback_id) REFERENCES review_feedback(id),
					FOREIGN KEY (reply_id) REFERENCES review_feedback_replies(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS review_notifications (
					id TEXT PRIMARY KEY,
					dedupe_key TEXT NOT NULL UNIQUE,
					recipient_user_id TEXT NOT NULL,
					recipient_email TEXT NOT NULL,
					organization_id TEXT NOT NULL,
					project_id TEXT NOT NULL,
					feedback_id TEXT,
					reply_id TEXT,
					type TEXT NOT NULL,
					reason TEXT NOT NULL,
					actor_user_id TEXT,
					actor_email TEXT,
					message TEXT NOT NULL,
					read_on TEXT,
					email_status TEXT NOT NULL DEFAULT 'email_not_configured',
					email_error TEXT,
					created_on TEXT NOT NULL,
					FOREIGN KEY (project_id) REFERENCES projects(id),
					FOREIGN KEY (feedback_id) REFERENCES review_feedback(id),
					FOREIGN KEY (reply_id) REFERENCES review_feedback_replies(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS shiplet_watch_subscriptions (
					project_id TEXT NOT NULL,
					user_id TEXT NOT NULL,
					status TEXT NOT NULL DEFAULT 'active',
					created_by_user_id TEXT,
					created_on TEXT NOT NULL,
					updated_on TEXT NOT NULL,
					PRIMARY KEY (project_id, user_id),
					FOREIGN KEY (project_id) REFERENCES projects(id),
					FOREIGN KEY (user_id) REFERENCES users(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS review_api_tokens (
					id TEXT PRIMARY KEY,
					project_id TEXT NOT NULL,
					name TEXT NOT NULL,
					token_hash TEXT NOT NULL UNIQUE,
					scopes TEXT NOT NULL,
					created_by_user_id TEXT NOT NULL,
					created_on TEXT NOT NULL,
					last_used_on TEXT,
					revoked_on TEXT,
					FOREIGN KEY (project_id) REFERENCES projects(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS organization_api_tokens (
					id TEXT PRIMARY KEY,
					organization_id TEXT NOT NULL,
					name TEXT NOT NULL,
					token_hash TEXT NOT NULL UNIQUE,
					scopes TEXT NOT NULL,
					project_access_mode TEXT NOT NULL DEFAULT 'all',
					created_by_user_id TEXT NOT NULL,
					created_on TEXT NOT NULL,
					last_used_on TEXT,
					revoked_on TEXT,
					FOREIGN KEY (organization_id) REFERENCES organizations(id),
					FOREIGN KEY (created_by_user_id) REFERENCES users(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS kernel_admin_audit_events (
					id TEXT PRIMARY KEY,
					organization_id TEXT NOT NULL,
					project_id TEXT,
					actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'system')),
					actor_id TEXT NOT NULL,
					action TEXT NOT NULL,
					outcome TEXT NOT NULL CHECK (outcome IN ('intent', 'succeeded', 'denied', 'failed')),
					metadata_json TEXT NOT NULL,
					occurred_on TEXT NOT NULL
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS organization_api_token_project_rules (
					token_id TEXT NOT NULL,
					project_id TEXT NOT NULL,
					effect TEXT NOT NULL,
					created_on TEXT NOT NULL,
					PRIMARY KEY (token_id, project_id, effect),
					FOREIGN KEY (token_id) REFERENCES organization_api_tokens(id),
					FOREIGN KEY (project_id) REFERENCES projects(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS embed_installations (
					id TEXT PRIMARY KEY,
					project_id TEXT NOT NULL,
					organization_id TEXT NOT NULL,
					site_origin TEXT NOT NULL,
					site_url TEXT NOT NULL,
					site_name TEXT NOT NULL,
					secret_hash TEXT NOT NULL UNIQUE,
					created_by_user_id TEXT NOT NULL,
					created_on TEXT NOT NULL,
					last_used_on TEXT,
					revoked_on TEXT,
					FOREIGN KEY (project_id) REFERENCES projects(id),
					FOREIGN KEY (organization_id) REFERENCES organizations(id),
					FOREIGN KEY (created_by_user_id) REFERENCES users(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS embed_exchange_codes (
					code_hash TEXT PRIMARY KEY,
					purpose TEXT NOT NULL,
					installation_id TEXT,
					project_id TEXT NOT NULL,
					organization_id TEXT NOT NULL,
					user_id TEXT NOT NULL,
					site_origin TEXT NOT NULL,
					site_url TEXT NOT NULL,
					site_name TEXT NOT NULL,
					return_url TEXT NOT NULL,
					expires_on TEXT NOT NULL,
					used_on TEXT,
					created_on TEXT NOT NULL,
					FOREIGN KEY (installation_id) REFERENCES embed_installations(id),
					FOREIGN KEY (project_id) REFERENCES projects(id),
					FOREIGN KEY (organization_id) REFERENCES organizations(id),
					FOREIGN KEY (user_id) REFERENCES users(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS embed_review_sessions (
					session_hash TEXT PRIMARY KEY,
					installation_id TEXT NOT NULL,
					project_id TEXT NOT NULL,
					revision_id TEXT NOT NULL,
					site_origin TEXT NOT NULL,
					page_url TEXT NOT NULL,
					actor_user_id TEXT NOT NULL,
					expires_on TEXT NOT NULL,
					created_on TEXT NOT NULL,
					FOREIGN KEY (installation_id) REFERENCES embed_installations(id),
					FOREIGN KEY (project_id) REFERENCES projects(id),
					FOREIGN KEY (actor_user_id) REFERENCES users(id)
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS embed_review_operation_receipts (
					receipt_hash TEXT PRIMARY KEY,
					installation_id TEXT NOT NULL,
					project_id TEXT NOT NULL,
					revision_id TEXT NOT NULL,
					actor_user_id TEXT NOT NULL,
					effect TEXT NOT NULL,
					payload_digest TEXT NOT NULL,
					request_id TEXT NOT NULL,
					expires_on TEXT NOT NULL,
					claimed_on TEXT
				)`,
			),
		db
			.prepare(
				`CREATE TABLE IF NOT EXISTS embed_review_operation_intents (
					id TEXT PRIMARY KEY,
					installation_id TEXT NOT NULL,
					project_id TEXT NOT NULL,
					revision_id TEXT NOT NULL,
					actor_user_id TEXT NOT NULL,
					effect TEXT NOT NULL,
					payload_json TEXT NOT NULL,
					payload_digest TEXT NOT NULL,
					request_id TEXT NOT NULL,
					page_url TEXT NOT NULL,
					expires_on TEXT NOT NULL,
					confirmed_on TEXT,
					completed_on TEXT,
					created_on TEXT NOT NULL,
					UNIQUE (installation_id, actor_user_id, request_id)
				)`,
			),
	]);

	for (const column of USER_COLUMNS) {
		await addColumnIfMissing(db, "users", column);
	}
	for (const column of PROJECT_COLUMNS) {
		await addColumnIfMissing(db, "projects", column);
	}
	for (const column of PROJECT_ASSET_COLUMNS) {
		await addColumnIfMissing(db, "project_assets", column);
	}
	await addColumnIfMissing(db, "cli_authorization_requests", {
		name: "exchange_marker",
		ddl: "exchange_marker TEXT",
	});
	await addColumnIfMissing(db, "cli_sessions", {
		name: "authorization_request_id",
		ddl: "authorization_request_id TEXT",
	});

	await db.batch([
		db.prepare(
			`CREATE TRIGGER IF NOT EXISTS kernel_admin_audit_events_no_update
			 BEFORE UPDATE ON kernel_admin_audit_events
			 BEGIN
				SELECT RAISE(ABORT, 'kernel admin audit events are immutable');
			 END`,
		),
		db.prepare(
			`CREATE TRIGGER IF NOT EXISTS kernel_admin_audit_events_no_delete
			 BEFORE DELETE ON kernel_admin_audit_events
			 BEGIN
				SELECT RAISE(ABORT, 'kernel admin audit events are immutable');
			 END`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_kernel_admin_audit_org_time
			 ON kernel_admin_audit_events(organization_id, occurred_on)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_review_feedback_project_status
			 ON review_feedback(project_id, status, created_on)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_review_feedback_project_path
			 ON review_feedback(project_id, page_url_key, created_on)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_review_replies_feedback
			 ON review_feedback_replies(feedback_id, created_on)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_review_mentions_feedback
			 ON review_feedback_mentions(feedback_id, created_on)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_review_mentions_user
			 ON review_feedback_mentions(mentioned_user_id, created_on)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_review_notifications_recipient
			 ON review_notifications(recipient_user_id, read_on, created_on)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_review_notifications_project
			 ON review_notifications(project_id, created_on)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_shiplet_watch_subscriptions_user
			 ON shiplet_watch_subscriptions(user_id, status)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_review_tokens_project
			 ON review_api_tokens(project_id, revoked_on)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_project_assets_project
			 ON project_assets(project_id, path)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_shiplet_access_requests_owner
			 ON shiplet_access_requests(project_id, status, created_on)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_projects_archive
			 ON projects(archived_on, delete_after)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_account_group_sessions_group
			 ON account_group_sessions(group_id, last_selected_on)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_workos_user_identities_user
			 ON workos_user_identities(user_id, last_authenticated_on)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_cli_authorization_expiry
			 ON cli_authorization_requests(expires_on, exchanged_on)`,
		),
		db.prepare(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_cli_authorization_exchange_marker
			 ON cli_authorization_requests(exchange_marker)
			 WHERE exchange_marker IS NOT NULL`,
		),
		db.prepare(
			`CREATE TRIGGER IF NOT EXISTS cli_session_audit_events_no_update
			 BEFORE UPDATE ON cli_session_audit_events
			 BEGIN SELECT RAISE(ABORT, 'CLI session audit events are immutable'); END`,
		),
		db.prepare(
			`CREATE TRIGGER IF NOT EXISTS cli_session_audit_events_no_delete
			 BEFORE DELETE ON cli_session_audit_events
			 BEGIN SELECT RAISE(ABORT, 'CLI session audit events are immutable'); END`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_cli_sessions_expiry
			 ON cli_sessions(expires_on, revoked_on)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_org_api_tokens_org
			 ON organization_api_tokens(organization_id, revoked_on)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_org_api_token_rules_token
			 ON organization_api_token_project_rules(token_id, project_id)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_embed_installations_project_origin
			 ON embed_installations(project_id, site_origin, revoked_on)`,
		),
		db.prepare(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_embed_installations_active_origin
			 ON embed_installations(site_origin)
			 WHERE revoked_on IS NULL`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_embed_exchange_codes_expiry
			 ON embed_exchange_codes(purpose, expires_on, used_on)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_embed_review_sessions_expiry
			 ON embed_review_sessions(expires_on, installation_id)`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_embed_review_receipts_binding
			 ON embed_review_operation_receipts(
				installation_id, project_id, revision_id, actor_user_id,
				expires_on, claimed_on
			 )`,
		),
		db.prepare(
			`CREATE INDEX IF NOT EXISTS idx_embed_review_intents_expiry
			 ON embed_review_operation_intents(
				project_id, actor_user_id, expires_on, confirmed_on, completed_on
			 )`,
		),
	]);
}
