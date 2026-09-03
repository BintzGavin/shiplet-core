import type { Env } from "./env";
import {
  applyReviewLayerChanges,
  compileReviewLayer,
  type ReviewLayer,
  type ReviewLayerActor,
  type ReviewLayerDiagnostic,
} from "./review-layer";
import { ReviewPresenceCoordinator } from "./review-presence";

const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

type StoredLayerRow = {
  version: string;
  entry_path: string;
  files_json: string;
  updated_by_actor_kind: ReviewLayerActor["kind"];
  updated_by_actor_id: string;
  updated_on: string;
};

type StoredPreviewRow = {
  id: string;
  base_version: string;
  entry_path: string;
  files_json: string;
  expires_on: string;
  applied_on: string | null;
};

export type ShipletRootProvenance = Readonly<{
  sourceShipletId: string;
  sourceVersion: string;
}>;

export type ShipletRootInitialization = Readonly<{
  projectId: string;
  layer: ReviewLayer;
  actor: ReviewLayerActor;
  provenance?: ShipletRootProvenance | null;
}>;

export type ShipletRootSnapshot = Readonly<{
  projectId: string;
  reviewLayer: ReviewLayer;
  provenance: ShipletRootProvenance | null;
}>;

export type ShipletRootPreviewResult =
  | Readonly<{
      ok: true;
      previewId: string;
      baseVersion: string;
      expiresOn: string;
    }>
  | Readonly<{
      ok: false;
      code: "review_layer_conflict" | "review_layer_invalid";
      diagnostics?: readonly ReviewLayerDiagnostic[];
    }>;

export type ShipletRootApplyResult =
  | Readonly<{ ok: true; reviewLayer: ReviewLayer }>
  | Readonly<{
      ok: false;
      code: "preview_not_found" | "review_layer_conflict";
    }>;

function parseLayer(row: Pick<StoredLayerRow, "version" | "entry_path" | "files_json">): ReviewLayer {
  return {
    version: row.version,
    entryPath: row.entry_path,
    files: JSON.parse(row.files_json) as ReviewLayer["files"],
  };
}

function exactActor(actor: ReviewLayerActor): ReviewLayerActor {
  if (
    (actor.kind !== "human" && actor.kind !== "agent") ||
    typeof actor.id !== "string" ||
    actor.id.length === 0 ||
    actor.id.length > 256
  ) {
    throw new TypeError("invalid_review_layer_actor");
  }
  return actor;
}

function exactProjectId(projectId: string) {
  if (
    typeof projectId !== "string" ||
    !/^project_[A-Za-z0-9_-]{1,200}$/.test(projectId)
  ) {
    throw new TypeError("invalid_shiplet_root_project_id");
  }
  return projectId;
}

export class ShipletRoot extends ReviewPresenceCoordinator {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS shiplet_root_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_layer (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version TEXT NOT NULL UNIQUE,
        entry_path TEXT NOT NULL,
        files_json TEXT NOT NULL,
        updated_by_actor_kind TEXT NOT NULL,
        updated_by_actor_id TEXT NOT NULL,
        updated_on TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_layer_previews (
        id TEXT PRIMARY KEY,
        base_version TEXT NOT NULL,
        entry_path TEXT NOT NULL,
        files_json TEXT NOT NULL,
        created_by_actor_kind TEXT NOT NULL,
        created_by_actor_id TEXT NOT NULL,
        created_on TEXT NOT NULL,
        expires_on TEXT NOT NULL,
        applied_on TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_review_layer_previews_created
        ON review_layer_previews(created_on);
      CREATE TABLE IF NOT EXISTS review_layer_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_kind TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_on TEXT NOT NULL
      );
    `);
  }

  async initialize(input: ShipletRootInitialization): Promise<ShipletRootSnapshot> {
    const projectId = exactProjectId(input.projectId);
    const actor = exactActor(input.actor);
    const existingProjectId = this.meta("project_id");
    if (existingProjectId && existingProjectId !== projectId) {
      throw new Error("shiplet_root_identity_conflict");
    }
    const existing = this.activeLayer();
    if (existing) return this.snapshotFor(projectId, existing);

    await compileReviewLayer(input.layer);
    const now = new Date().toISOString();
    const layer: ReviewLayer = input.provenance
      ? {
          ...input.layer,
          version: `review_layer_${crypto.randomUUID().replaceAll("-", "")}`,
        }
      : input.layer;
    const provenance = input.provenance ?? null;
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO shiplet_root_meta (key, value) VALUES ('project_id', ?)",
      projectId,
    );
    if (provenance) {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO shiplet_root_meta (key, value) VALUES ('review_layer_provenance', ?)",
        JSON.stringify(provenance),
      );
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO review_layer (
        singleton, version, entry_path, files_json,
        updated_by_actor_kind, updated_by_actor_id, updated_on
      ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
      layer.version,
      layer.entryPath,
      JSON.stringify(layer.files),
      actor.kind,
      actor.id,
      now,
    );
    this.appendAudit("review_layer.initialized", actor, {
      version: layer.version,
      provenance,
    }, now);
    return this.snapshotFor(projectId, layer);
  }

  async readReviewLayer(
    input: ShipletRootInitialization,
  ): Promise<ShipletRootSnapshot> {
    await this.initialize(input);
    const projectId = exactProjectId(input.projectId);
    const layer = this.activeLayer();
    if (!layer) throw new Error("shiplet_root_uninitialized");
    return this.snapshotFor(projectId, layer);
  }

  async prepareReviewLayerPreview(input: {
    projectId: string;
    fallback: ReviewLayer;
    baseVersion: string;
    changes: unknown;
    actor: ReviewLayerActor;
  }): Promise<ShipletRootPreviewResult> {
    const snapshot = await this.readReviewLayer({
      projectId: input.projectId,
      layer: input.fallback,
      actor: input.actor,
    });
    if (snapshot.reviewLayer.version !== input.baseVersion) {
      return { ok: false, code: "review_layer_conflict" };
    }
    const changed = await applyReviewLayerChanges(
      snapshot.reviewLayer,
      input.changes,
    );
    if (!changed.ok) {
      return {
        ok: false,
        code: "review_layer_invalid",
        diagnostics: changed.diagnostics,
      };
    }
    const actor = exactActor(input.actor);
    const previewId = `review_preview_${crypto.randomUUID().replaceAll("-", "")}`;
    const createdOn = new Date().toISOString();
    const expiresOn = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO review_layer_previews (
        id, base_version, entry_path, files_json,
        created_by_actor_kind, created_by_actor_id, created_on, expires_on, applied_on
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      previewId,
      snapshot.reviewLayer.version,
      changed.layer.entryPath,
      JSON.stringify(changed.layer.files),
      actor.kind,
      actor.id,
      createdOn,
      expiresOn,
    );
    return {
      ok: true,
      previewId,
      baseVersion: snapshot.reviewLayer.version,
      expiresOn,
    };
  }

  async readReviewLayerPreview(input: {
    projectId: string;
    previewId: string;
  }): Promise<(ReviewLayer & { baseVersion: string; applied: boolean }) | null> {
    this.assertIdentity(input.projectId);
    const row = this.ctx.storage.sql
      .exec<StoredPreviewRow>(
        `SELECT id, base_version, entry_path, files_json, expires_on, applied_on
         FROM review_layer_previews
         WHERE id = ? AND expires_on > ? LIMIT 1`,
        input.previewId,
        new Date().toISOString(),
      )
      .toArray()[0];
    if (!row) return null;
    return {
      version: row.id,
      baseVersion: row.base_version,
      entryPath: row.entry_path,
      files: JSON.parse(row.files_json) as ReviewLayer["files"],
      applied: Boolean(row.applied_on),
    };
  }

  async applyReviewLayerPreview(input: {
    projectId: string;
    previewId: string;
    expectedVersion: string;
    actor: ReviewLayerActor;
  }): Promise<ShipletRootApplyResult> {
    this.assertIdentity(input.projectId);
    const actor = exactActor(input.actor);
    const now = new Date().toISOString();
    const preview = this.ctx.storage.sql
      .exec<StoredPreviewRow>(
        `SELECT id, base_version, entry_path, files_json, expires_on, applied_on
         FROM review_layer_previews WHERE id = ? LIMIT 1`,
        input.previewId,
      )
      .toArray()[0];
    if (!preview || preview.applied_on || preview.expires_on <= now) {
      return { ok: false, code: "preview_not_found" };
    }
    const current = this.activeLayer();
    if (
      !current ||
      current.version !== input.expectedVersion ||
      preview.base_version !== input.expectedVersion
    ) {
      return { ok: false, code: "review_layer_conflict" };
    }
    const version = `review_layer_${crypto.randomUUID().replaceAll("-", "")}`;
    const updated = this.ctx.storage.sql.exec<{ version: string }>(
      `UPDATE review_layer SET
        version = ?, entry_path = ?, files_json = ?,
        updated_by_actor_kind = ?, updated_by_actor_id = ?, updated_on = ?
       WHERE singleton = 1 AND version = ?
       RETURNING version`,
      version,
      preview.entry_path,
      preview.files_json,
      actor.kind,
      actor.id,
      now,
      input.expectedVersion,
    );
    if (updated.toArray().length !== 1) {
      return { ok: false, code: "review_layer_conflict" };
    }
    this.ctx.storage.sql.exec(
      "UPDATE review_layer_previews SET applied_on = ? WHERE id = ? AND applied_on IS NULL",
      now,
      input.previewId,
    );
    this.appendAudit("review_layer.applied", actor, {
      previewId: input.previewId,
      baseVersion: input.expectedVersion,
      version,
    }, now);
    const layer = this.activeLayer();
    if (!layer) throw new Error("shiplet_root_uninitialized");
    return { ok: true, reviewLayer: layer };
  }

  async health(projectId: string) {
    this.assertIdentity(projectId);
    const layerRow = this.ctx.storage.sql
      .exec<StoredLayerRow>(
        `SELECT version, entry_path, files_json,
                updated_by_actor_kind, updated_by_actor_id, updated_on
         FROM review_layer WHERE singleton = 1 LIMIT 1`,
      )
      .toArray()[0];
    const audit = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM review_layer_audit")
      .one();
    return {
      ok: true as const,
      projectId,
      reviewLayerVersion: layerRow?.version ?? null,
      reviewLayerActor: layerRow
        ? Object.freeze({
            kind: layerRow.updated_by_actor_kind,
            id: layerRow.updated_by_actor_id,
          })
        : null,
      auditEvents: audit.count,
    };
  }

  private activeLayer(): ReviewLayer | null {
    const row = this.ctx.storage.sql
      .exec<StoredLayerRow>(
        `SELECT version, entry_path, files_json,
                updated_by_actor_kind, updated_by_actor_id, updated_on
         FROM review_layer WHERE singleton = 1 LIMIT 1`,
      )
      .toArray()[0];
    return row ? parseLayer(row) : null;
  }

  private meta(key: string): string | null {
    return (
      this.ctx.storage.sql
        .exec<{ value: string }>(
          "SELECT value FROM shiplet_root_meta WHERE key = ? LIMIT 1",
          key,
        )
        .toArray()[0]?.value ?? null
    );
  }

  private provenance(): ShipletRootProvenance | null {
    const raw = this.meta("review_layer_provenance");
    return raw ? (JSON.parse(raw) as ShipletRootProvenance) : null;
  }

  private assertIdentity(projectId: string) {
    const exact = exactProjectId(projectId);
    const stored = this.meta("project_id");
    if (!stored) throw new Error("shiplet_root_uninitialized");
    if (stored !== exact) throw new Error("shiplet_root_identity_conflict");
  }

  private snapshotFor(projectId: string, reviewLayer: ReviewLayer): ShipletRootSnapshot {
    this.assertIdentity(projectId);
    return {
      projectId,
      reviewLayer,
      provenance: this.provenance(),
    };
  }

  private appendAudit(
    eventKind: string,
    actor: ReviewLayerActor,
    payload: Record<string, unknown>,
    occurredOn: string,
  ) {
    this.ctx.storage.sql.exec(
      `INSERT INTO review_layer_audit (
        event_kind, actor_kind, actor_id, payload_json, occurred_on
      ) VALUES (?, ?, ?, ?, ?)`,
      eventKind,
      actor.kind,
      actor.id,
      JSON.stringify(payload),
      occurredOn,
    );
  }
}
