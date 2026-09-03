const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DELIVERY_HANDLE = /^[A-Za-z0-9_-]{43}$/;
const SESSION_BINDING = /^[a-f0-9]{64}$/;

type PendingAcknowledgementRow = {
	connection_id: string;
	project_id: string;
	user_id: string;
	shiplet_id: string;
	delivery_handle: string;
	session_binding: string;
	delivery_expires_at: number;
};

export type CloudflareOAuthAcknowledgementControl = {
	acknowledge(input: {
		actor: { kind: "human"; id: string };
		shipletId: string;
		sessionBinding: string;
		deliveryHandle: string;
		connectionId: string;
	}): Promise<{ ok: true } | { ok: false; reason: string }>;
	revoke(input: {
		actor: { kind: "human"; id: string };
		connectionId: string;
		sessionBinding: string;
	}): Promise<
		| { ok: true; connection?: { status: "revoked" } }
		| { ok: false; reason: string; connection?: { status: "revoked" } }
	>;
};

function validRow(row: PendingAcknowledgementRow) {
	return (
		IDENTIFIER.test(row.connection_id) &&
		IDENTIFIER.test(row.project_id) &&
		IDENTIFIER.test(row.user_id) &&
		row.shiplet_id === row.project_id &&
		DELIVERY_HANDLE.test(row.delivery_handle) &&
		SESSION_BINDING.test(row.session_binding) &&
		Number.isSafeInteger(row.delivery_expires_at)
	);
}

async function auditId(connectionId: string) {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(
				`shiplet:cloudflare-oauth-ack-expired:${connectionId}`,
			),
		),
	);
	const hex = [...digest]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `audit_${hex.slice(0, 48)}`;
}

/**
 * Retries the browser-independent half of OAuth finalization. Until an exact
 * ACK is delivered, deployment-status joins this outbox and reports `pending`.
 * Expired authority is revoked remotely before local state is marked revoked.
 */
export async function reconcileCloudflareOAuthAcknowledgements(input: {
	db: D1Database;
	now: number;
	limit: number;
	controlForUser(userId: string): CloudflareOAuthAcknowledgementControl | null;
}) {
	if (
		!Number.isSafeInteger(input.now) ||
		!Number.isSafeInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > 100
	) {
		throw new TypeError("cloudflare_oauth_ack_reconciliation_invalid");
	}
	const rows = await input.db
		.prepare(
			`SELECT connection_id, project_id, user_id, shiplet_id,
			        delivery_handle, session_binding, delivery_expires_at
			 FROM cloudflare_oauth_ack_outbox
			 ORDER BY delivery_expires_at, connection_id LIMIT ?`,
		)
		.bind(input.limit)
		.all<PendingAcknowledgementRow>();
	let acknowledged = 0;
	let revoked = 0;
	let pending = 0;
	for (const row of rows.results) {
		if (!validRow(row)) {
			pending += 1;
			continue;
		}
		const control = input.controlForUser(row.user_id);
		if (!control) {
			pending += 1;
			continue;
		}
		const actor = Object.freeze({ kind: "human" as const, id: row.user_id });
		const attemptedOn = new Date(input.now).toISOString();
		await input.db
			.prepare(
				`UPDATE cloudflare_oauth_ack_outbox
				 SET attempt_count = attempt_count + 1, last_attempt_on = ?
				 WHERE connection_id = ? AND project_id = ? AND user_id = ?
				   AND delivery_handle = ? AND session_binding = ?`,
			)
			.bind(
				attemptedOn,
				row.connection_id,
				row.project_id,
				row.user_id,
				row.delivery_handle,
				row.session_binding,
			)
			.run();
		let acked = false;
		try {
			acked = (
				await control.acknowledge({
					actor,
					shipletId: row.shiplet_id,
					sessionBinding: row.session_binding,
					deliveryHandle: row.delivery_handle,
					connectionId: row.connection_id,
				})
			).ok;
		} catch {
			acked = false;
		}
		if (acked) {
			const cleared = await input.db
				.prepare(
					`DELETE FROM cloudflare_oauth_ack_outbox
					 WHERE connection_id = ? AND project_id = ? AND user_id = ?
					   AND delivery_handle = ? AND session_binding = ?`,
				)
				.bind(
					row.connection_id,
					row.project_id,
					row.user_id,
					row.delivery_handle,
					row.session_binding,
				)
				.run();
			if (cleared.meta.changes === 1) acknowledged += 1;
			else pending += 1;
			continue;
		}
		if (input.now < row.delivery_expires_at) {
			pending += 1;
			continue;
		}
		let remoteRevoked = false;
		try {
			const result = await control.revoke({
				actor,
				connectionId: row.connection_id,
				sessionBinding: row.session_binding,
			});
			remoteRevoked = result.ok || result.connection?.status === "revoked";
		} catch {
			remoteRevoked = false;
		}
		if (!remoteRevoked) {
			pending += 1;
			continue;
		}
		const occurredOn = new Date(input.now).toISOString();
		await input.db.batch([
			input.db
				.prepare(
					`UPDATE cloudflare_connections SET status = 'revoked', revoked_at = ?
					 WHERE id = ? AND user_id = ? AND status = 'active'`,
				)
				.bind(input.now, row.connection_id, row.user_id),
			input.db
				.prepare(
					`UPDATE deployment_targets SET detached_on = ?
					 WHERE project_id = ? AND connection_id = ? AND detached_on IS NULL`,
				)
				.bind(occurredOn, row.project_id, row.connection_id),
			input.db
				.prepare(
					`INSERT OR IGNORE INTO shiplet_audit_events (
						id, project_id, revision_id, deployment_id, actor_kind, actor_id,
						event_kind, summary, status_category, payload_json,
						occurred_on, recorded_on
					) VALUES (?, ?, NULL, NULL, 'shiplet', ?,
						'cloudflare.connection.delivery_expired',
						'Unacknowledged Cloudflare connection revoked', 'resolved', ?, ?, ?)`,
				)
				.bind(
					await auditId(row.connection_id),
					row.project_id,
					row.project_id,
					JSON.stringify({ connectionId: row.connection_id }),
					occurredOn,
					occurredOn,
				),
			input.db
				.prepare(
					`DELETE FROM cloudflare_oauth_ack_outbox
					 WHERE connection_id = ? AND project_id = ? AND user_id = ?
					   AND delivery_handle = ? AND session_binding = ?`,
				)
				.bind(
					row.connection_id,
					row.project_id,
					row.user_id,
					row.delivery_handle,
					row.session_binding,
				),
		]);
		revoked += 1;
	}
	return { acknowledged, revoked, pending };
}
