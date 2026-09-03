import type { RevisionPreviewSelector } from "./revision-preview";
import type { ShipletActor } from "./revisions";

export type RevisionPreviewReceipt = Readonly<{
  previewed: true;
  shipletId: string;
  draftId: string;
  revisionId: string;
  draftVersion: number;
}>;

type ReceiptInput = RevisionPreviewSelector & {
  db: D1Database;
  actor: ShipletActor;
  sessionBindingDigest: string;
};

const SESSION_BINDING = /^[a-f0-9]{64}$/;

function assertReceiptInput(input: ReceiptInput) {
  if (!SESSION_BINDING.test(input.sessionBindingDigest)) {
    throw new TypeError("revision_preview_receipt_session_invalid");
  }
}

function receipt(input: RevisionPreviewSelector): RevisionPreviewReceipt {
  return Object.freeze({
    previewed: true as const,
    shipletId: input.shipletId,
    draftId: input.draftId,
    revisionId: input.revisionId,
    draftVersion: input.draftVersion,
  });
}

async function exactReceiptExists(input: ReceiptInput) {
  assertReceiptInput(input);
  const row = await input.db
    .prepare(
      `SELECT 1 AS present
       FROM shiplet_revision_preview_receipts_v2
       WHERE project_id = ? AND draft_id = ? AND revision_id = ?
         AND draft_version = ? AND actor_kind = ? AND actor_id = ?
         AND session_binding_digest = ?
       LIMIT 1`,
    )
    .bind(
      input.shipletId,
      input.draftId,
      input.revisionId,
      input.draftVersion,
      input.actor.kind,
      input.actor.id,
      input.sessionBindingDigest,
    )
    .first<{ present: number }>();
  return row?.present === 1;
}

export async function recordRevisionPreviewReceipt(
  input: ReceiptInput & { now?: () => number },
): Promise<RevisionPreviewReceipt> {
  assertReceiptInput(input);
  const previewedOn = new Date(input.now?.() ?? Date.now()).toISOString();
  await input.db.batch([
    input.db
      .prepare(
        `INSERT OR IGNORE INTO shiplet_revision_preview_receipts_v2 (
           project_id, draft_id, revision_id, draft_version,
           actor_kind, actor_id, session_binding_digest, previewed_on
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1
             FROM shiplet_drafts draft
             JOIN shiplet_revisions revision
               ON revision.id = draft.validated_revision_id
              AND revision.project_id = draft.project_id
             WHERE draft.id = ? AND draft.project_id = ?
               AND draft.version = ? AND draft.validation_state = 'validated'
               AND draft.validated_revision_id = ?
           )`,
      )
      .bind(
        input.shipletId,
        input.draftId,
        input.revisionId,
        input.draftVersion,
        input.actor.kind,
        input.actor.id,
        input.sessionBindingDigest,
        previewedOn,
        input.draftId,
        input.shipletId,
        input.draftVersion,
        input.revisionId,
      ),
    input.db
      .prepare(
        `INSERT INTO shiplet_audit_events (
           id, project_id, revision_id, deployment_id, actor_kind, actor_id,
           event_kind, summary, status_category, payload_json, occurred_on,
           recorded_on
         ) SELECT ?, ?, ?, NULL, ?, ?, 'revision.previewed',
                    'Sealed revision preview opened', 'informational', ?, ?, ?
           WHERE changes() = 1`,
      )
      .bind(
        `audit_preview_${crypto.randomUUID().replaceAll("-", "")}`,
        input.shipletId,
        input.revisionId,
        input.actor.kind,
        input.actor.id,
        JSON.stringify({
          draftId: input.draftId,
          draftVersion: input.draftVersion,
        }),
        previewedOn,
        previewedOn,
      ),
  ]);
  if (!(await exactReceiptExists(input))) {
    throw new Error("revision_preview_receipt_scope_mismatch");
  }
  return receipt(input);
}

export async function loadRevisionPreviewReceipt(
  input: ReceiptInput,
): Promise<RevisionPreviewReceipt | null> {
  return (await exactReceiptExists(input)) ? receipt(input) : null;
}
