import type {
  CustomMcpQuarantineReference,
  CustomMcpQuarantineVault,
  CustomMcpQuarantineVaultEntry,
} from "./custom-mcp";

const CONTROL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REFERENCE_ID = /^qm_[A-Za-z0-9_-]{16,128}$/;
const MAX_ITEMS = 256;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_ACTIVE_PER_SHIPLET = 256;
const MAX_TTL_MS = 15 * 60_000;

type QuarantineRow = {
  reference_id: string;
  project_id: string;
  revision_id: string;
  content_kind: "custom_mcp_description" | "custom_mcp_result";
  expires_at_ms: number;
  text_items_json: string;
};

function trustedClock(read: () => number) {
  const value = read();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Custom MCP quarantine clock unavailable");
  }
  return value;
}

function validReference(value: CustomMcpQuarantineReference): boolean {
  return (
    Boolean(value) &&
    REFERENCE_ID.test(value.referenceId) &&
    CONTROL_ID.test(value.shipletId) &&
    CONTROL_ID.test(value.revisionId) &&
    (value.contentKind === "custom_mcp_description" ||
      value.contentKind === "custom_mcp_result") &&
    Number.isSafeInteger(value.expiresAt)
  );
}

function stableTextItems(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  let bytes = 0;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    bytes += new TextEncoder().encode(item).byteLength;
    if (bytes > MAX_TEXT_BYTES) return null;
    items.push(item);
  }
  return Object.freeze(items);
}

function publicReference(row: QuarantineRow) {
  return Object.freeze({
    referenceId: row.reference_id,
    shipletId: row.project_id,
    revisionId: row.revision_id,
    contentKind: row.content_kind,
    expiresAt: row.expires_at_ms,
  });
}

export async function ensureD1CustomMcpQuarantineSchema(db: D1Database) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_custom_mcp_quarantine (
       reference_id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL,
       revision_id TEXT NOT NULL,
       content_kind TEXT NOT NULL
        CHECK (content_kind IN ('custom_mcp_description','custom_mcp_result')),
       expires_at_ms INTEGER NOT NULL,
       text_items_json TEXT NOT NULL,
       created_at_ms INTEGER NOT NULL,
       consumed_at_ms INTEGER
      )`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_custom_mcp_quarantine_active
       ON shiplet_custom_mcp_quarantine(project_id, expires_at_ms)
       WHERE consumed_at_ms IS NULL`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS immutable_custom_mcp_quarantine_delete_v1
       BEFORE DELETE ON shiplet_custom_mcp_quarantine
       BEGIN
        SELECT RAISE(ABORT, 'custom_mcp_quarantine_immutable');
       END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS immutable_custom_mcp_quarantine_update_v1
       BEFORE UPDATE ON shiplet_custom_mcp_quarantine
       WHEN OLD.consumed_at_ms IS NOT NULL
        OR NEW.consumed_at_ms IS NULL
        OR NEW.consumed_at_ms < OLD.created_at_ms
        OR NEW.reference_id <> OLD.reference_id
        OR NEW.project_id <> OLD.project_id
        OR NEW.revision_id <> OLD.revision_id
        OR NEW.content_kind <> OLD.content_kind
        OR NEW.expires_at_ms <> OLD.expires_at_ms
        OR NEW.text_items_json <> OLD.text_items_json
        OR NEW.created_at_ms <> OLD.created_at_ms
       BEGIN
        SELECT RAISE(ABORT, 'custom_mcp_quarantine_immutable');
       END`,
    ),
  ]);
}

export function createD1CustomMcpQuarantineVault(input: {
  db: D1Database;
  now(): number;
  activeRevisionFence?: Readonly<{
    shipletId: string;
    revisionId: string;
    packageDigest: string;
    activationGeneration: number;
  }>;
}): CustomMcpQuarantineVault & {
  listActive(scope: {
    shipletId: string;
    now: number;
    limit: number;
  }): Promise<readonly Readonly<CustomMcpQuarantineReference>[]>;
  getReference(scope: {
    shipletId: string;
    referenceId: string;
    now: number;
  }): Promise<Readonly<CustomMcpQuarantineReference> | null>;
  consumeWithAudit(
    request: CustomMcpQuarantineReference & { now: number },
    audit: { actorId: string },
  ): Promise<CustomMcpQuarantineVaultEntry | null>;
} {
  const { db } = input;

  const consume = async (
    request: CustomMcpQuarantineReference & { now: number },
    audit?: { actorId: string },
  ) => {
    const currentTime = trustedClock(input.now);
    if (
      !validReference(request) ||
      !Number.isSafeInteger(request.now) ||
      request.now > currentTime ||
      currentTime - request.now > 5_000 ||
      currentTime >= request.expiresAt ||
      (audit !== undefined && !CONTROL_ID.test(audit.actorId))
    ) {
      return null;
    }
    const consumeStatement = db
      .prepare(
        `UPDATE shiplet_custom_mcp_quarantine
         SET consumed_at_ms = ?
         WHERE reference_id = ? AND project_id = ? AND revision_id = ?
          AND content_kind = ? AND expires_at_ms = ?
          AND consumed_at_ms IS NULL AND expires_at_ms > ?
         RETURNING reference_id, project_id, revision_id, content_kind,
          expires_at_ms, text_items_json`,
      )
      .bind(
        currentTime,
        request.referenceId,
        request.shipletId,
        request.revisionId,
        request.contentKind,
        request.expiresAt,
        currentTime,
      );
    let row: QuarantineRow | null = null;
    if (audit) {
      const timestamp = new Date(currentTime).toISOString();
      const results = await db.batch([
        consumeStatement,
        db
          .prepare(
            `INSERT INTO shiplet_audit_events (
             id, project_id, revision_id, deployment_id, actor_kind, actor_id,
             event_kind, summary, status_category, payload_json,
             occurred_on, recorded_on
            ) SELECT ?, ?, ?, NULL, 'human', ?,
             'custom_mcp.quarantine_released',
             'Custom MCP quarantine content released to a trusted human',
             'informational', ?, ?, ? WHERE changes() = 1`,
          )
          .bind(
            `audit_${crypto.randomUUID()}`,
            request.shipletId,
            request.revisionId,
            audit.actorId,
            JSON.stringify({
              referenceId: request.referenceId,
              contentKind: request.contentKind,
            }),
            timestamp,
            timestamp,
          ),
      ]);
      if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
        return null;
      }
      row = (results[0]?.results?.[0] as QuarantineRow | undefined) ?? null;
    } else {
      row = await consumeStatement.first<QuarantineRow>();
    }
    if (!row) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.text_items_json);
    } catch {
      return null;
    }
    const textItems = stableTextItems(parsed);
    if (textItems === null) return null;
    return Object.freeze({ ...publicReference(row), textItems });
  };

  return Object.freeze({
    async store(entry: CustomMcpQuarantineVaultEntry) {
      const currentTime = trustedClock(input.now);
      const textItems = stableTextItems(entry?.textItems);
      if (
        !validReference(entry) ||
        textItems === null ||
        entry.expiresAt <= currentTime ||
        entry.expiresAt - currentTime > MAX_TTL_MS
      ) {
        return null;
      }
      const serialized = JSON.stringify(textItems);
      try {
        const activeFence =
          entry.contentKind === "custom_mcp_result"
            ? input.activeRevisionFence
            : undefined;
        if (
          activeFence &&
          (activeFence.shipletId !== entry.shipletId ||
            activeFence.revisionId !== entry.revisionId ||
            !Number.isSafeInteger(activeFence.activationGeneration) ||
            activeFence.activationGeneration <= 0)
        ) {
          return null;
        }
        const result = activeFence
          ? await db
              .prepare(
                `INSERT OR IGNORE INTO shiplet_custom_mcp_quarantine (
                 reference_id, project_id, revision_id, content_kind,
                 expires_at_ms, text_items_json, created_at_ms, consumed_at_ms
                ) SELECT ?, ?, ?, ?, ?, ?, ?, NULL
                 FROM projects project
                 JOIN shiplet_revisions revision
                  ON revision.id = project.active_revision_id
                  AND revision.project_id = project.id
                 WHERE project.id = ? AND project.archived_on IS NULL
                  AND project.active_revision_id = ?
                  AND project.active_revision_generation = ?
                  AND ('sha256:' || revision.content_digest) = ?
                  AND (
                   SELECT COUNT(*) FROM shiplet_custom_mcp_quarantine
                   WHERE project_id = ? AND consumed_at_ms IS NULL
                    AND expires_at_ms > ?
                  ) < ?`,
              )
              .bind(
                entry.referenceId,
                entry.shipletId,
                entry.revisionId,
                entry.contentKind,
                entry.expiresAt,
                serialized,
                currentTime,
                activeFence.shipletId,
                activeFence.revisionId,
                activeFence.activationGeneration,
                activeFence.packageDigest,
                entry.shipletId,
                currentTime,
                MAX_ACTIVE_PER_SHIPLET,
              )
              .run()
          : await db
              .prepare(
                `INSERT OR IGNORE INTO shiplet_custom_mcp_quarantine (
                 reference_id, project_id, revision_id, content_kind,
                 expires_at_ms, text_items_json, created_at_ms, consumed_at_ms
                ) SELECT ?, ?, ?, ?, ?, ?, ?, NULL
                 WHERE (
                  SELECT COUNT(*) FROM shiplet_custom_mcp_quarantine
                  WHERE project_id = ? AND consumed_at_ms IS NULL
                   AND expires_at_ms > ?
                 ) < ?`,
              )
              .bind(
                entry.referenceId,
                entry.shipletId,
                entry.revisionId,
                entry.contentKind,
                entry.expiresAt,
                serialized,
                currentTime,
                entry.shipletId,
                currentTime,
                MAX_ACTIVE_PER_SHIPLET,
              )
              .run();
        if (result.meta.changes === 1) {
          return Object.freeze({ referenceId: entry.referenceId });
        }
        if (activeFence) return null;
        const existing = await db
          .prepare(
            `SELECT reference_id FROM shiplet_custom_mcp_quarantine
             WHERE reference_id = ? AND project_id = ? AND revision_id = ?
              AND content_kind = ? AND text_items_json = ? LIMIT 1`,
          )
          .bind(
            entry.referenceId,
            entry.shipletId,
            entry.revisionId,
            entry.contentKind,
            serialized,
          )
          .first<{ reference_id: string }>();
        return existing?.reference_id === entry.referenceId
          ? Object.freeze({ referenceId: entry.referenceId })
          : null;
      } catch {
        return null;
      }
    },

    async consume(request: CustomMcpQuarantineReference & { now: number }) {
      return consume(request);
    },

    async consumeWithAudit(
      request: CustomMcpQuarantineReference & { now: number },
      audit: { actorId: string },
    ) {
      return consume(request, audit);
    },

    async listActive(scope: { shipletId: string; now: number; limit: number }) {
      const currentTime = trustedClock(input.now);
      if (
        !CONTROL_ID.test(scope.shipletId) ||
        !Number.isSafeInteger(scope.now) ||
        scope.now > currentTime ||
        currentTime - scope.now > 5_000 ||
        !Number.isSafeInteger(scope.limit) ||
        scope.limit <= 0 ||
        scope.limit > 100
      ) {
        return Object.freeze([]);
      }
      const result = await db
        .prepare(
          `SELECT reference_id, project_id, revision_id, content_kind,
           expires_at_ms, text_items_json
           FROM shiplet_custom_mcp_quarantine
           WHERE project_id = ? AND consumed_at_ms IS NULL
            AND expires_at_ms > ?
           ORDER BY created_at_ms DESC, reference_id DESC LIMIT ?`,
        )
        .bind(scope.shipletId, currentTime, scope.limit)
        .all<QuarantineRow>();
      return Object.freeze(result.results.map(publicReference));
    },

    async getReference(scope: {
      shipletId: string;
      referenceId: string;
      now: number;
    }) {
      const currentTime = trustedClock(input.now);
      if (
        !CONTROL_ID.test(scope.shipletId) ||
        !REFERENCE_ID.test(scope.referenceId) ||
        !Number.isSafeInteger(scope.now) ||
        scope.now > currentTime ||
        currentTime - scope.now > 5_000
      ) {
        return null;
      }
      const row = await db
        .prepare(
          `SELECT reference_id, project_id, revision_id, content_kind,
           expires_at_ms, text_items_json
           FROM shiplet_custom_mcp_quarantine
           WHERE reference_id = ? AND project_id = ?
            AND consumed_at_ms IS NULL AND expires_at_ms > ? LIMIT 1`,
        )
        .bind(scope.referenceId, scope.shipletId, currentTime)
        .first<QuarantineRow>();
      return row ? publicReference(row) : null;
    },
  });
}
