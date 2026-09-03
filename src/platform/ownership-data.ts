import type { Project } from "../types";
import {
  AdaptOwnershipPageModel,
  type OwnershipDraft,
  type OwnershipRevision,
  type OwnershipRevisionHistoryItem,
  type OwnershipSealedRevisionItem,
  type ShipletOwnershipPageModel,
} from "./ownership-page";

function validationSummary(value: string | null) {
  if (!value) return null;
  try {
    const report = JSON.parse(value) as Record<string, unknown>;
    if (report.ok === true) return "All declared package checks passed.";
    const checks = Array.isArray(report.checks) ? report.checks : [];
    const failed = checks.filter(
      (check) =>
        typeof check === "object" &&
        check !== null &&
        (check as Record<string, unknown>).ok === false,
    ).length;
    return failed > 0
      ? `${failed} validation ${failed === 1 ? "check needs" : "checks need"} attention.`
      : "Validation did not pass. Inspect the draft report before retrying.";
  } catch {
    return "Validation status is unavailable. Validate the draft again before promotion.";
  }
}

export async function loadShipletOwnershipPageModel(input: {
  db: D1Database;
  project: Project;
  managedWorkerAvailable: boolean;
  cloudflareConnectAvailable: boolean;
  temporaryClaimAvailable: boolean;
  managedRuntime?: "static" | "worker" | "external_proxy";
  now?: () => number;
}): Promise<ShipletOwnershipPageModel> {
  const now = input.now?.() ?? Date.now();
  const revisions = await input.db
    .prepare(
      `SELECT revision.id, revision.created_on, revision.validation_report_json,
			 EXISTS (
				SELECT 1 FROM shiplet_revision_activations activation
				WHERE activation.project_id = revision.project_id
				AND activation.revision_id = revision.id
			 ) AS was_activated,
			 EXISTS (
				SELECT 1 FROM shiplet_revision_activations activation
				WHERE activation.project_id = revision.project_id
				AND activation.revision_id = revision.id
				AND activation.kind = 'rollback'
			 ) AS was_rolled_back,
			 EXISTS (
				SELECT 1 FROM shiplet_revision_seals seal
				WHERE seal.revision_id = revision.id
			 ) AS is_sealed
			 FROM shiplet_revisions revision
			 WHERE revision.project_id = ?
			 ORDER BY revision.created_on ASC, revision.id ASC`,
    )
    .bind(input.project.id)
    .all<{
      id: string;
      created_on: string;
      validation_report_json: string;
      was_activated: number;
      was_rolled_back: number;
      is_sealed: number;
    }>();
  const revisionLabels = new Map(
    revisions.results.map((revision, index) => [
      revision.id,
      `Revision ${index + 1}`,
    ]),
  );
  const activeRevisionId = (
    input.project as Project & { active_revision_id?: string | null }
  ).active_revision_id;
  const activeRow = revisions.results.find(
    (revision) => revision.id === activeRevisionId,
  );
  const activeRevision: OwnershipRevision | null = activeRow
    ? {
        id: activeRow.id,
        label: revisionLabels.get(activeRow.id) ?? activeRow.id,
        createdAt: activeRow.created_on,
        validatedAt: activeRow.created_on,
      }
    : null;
  const history: OwnershipRevisionHistoryItem[] = revisions.results
    .filter(
      (revision) =>
        revision.id !== activeRevisionId && Boolean(revision.was_activated),
    )
    .map((revision) => ({
      id: revision.id,
      label: revisionLabels.get(revision.id) ?? revision.id,
      createdAt: revision.created_on,
      status: revision.was_rolled_back ? "rolled_back" : "known_good",
    }));
  const sealed: OwnershipSealedRevisionItem[] = revisions.results
    .filter(
      (revision) =>
        revision.id !== activeRevisionId &&
        Boolean(revision.is_sealed) &&
        !revision.was_activated,
    )
    .map((revision) => ({
      id: revision.id,
      label: revisionLabels.get(revision.id) ?? revision.id,
      createdAt: revision.created_on,
    }));

  const draftRows = await input.db
    .prepare(
      `SELECT id, base_revision_id, version, validation_state,
			 validated_revision_id, validation_report_json, updated_on
			 FROM shiplet_drafts WHERE project_id = ?
			 ORDER BY updated_on DESC, id ASC`,
    )
    .bind(input.project.id)
    .all<{
      id: string;
      base_revision_id: string;
      version: number;
      validation_state: string;
      validated_revision_id: string | null;
      validation_report_json: string | null;
      updated_on: string;
    }>();
  const drafts: OwnershipDraft[] = draftRows.results.map((draft, index) => ({
    id: draft.id,
    label: `Draft ${draftRows.results.length - index}`,
    parentRevisionId: draft.base_revision_id,
    state:
      draft.validation_state === "validated"
        ? "validated"
        : draft.validation_state === "failed"
          ? "invalid"
          : "draft",
    version: draft.version,
    validatedRevisionId: draft.validated_revision_id,
    updatedAt: draft.updated_on,
    validationSummary: validationSummary(draft.validation_report_json),
  }));

  const targetRows = await input.db
    .prepare(
      `SELECT target.id, target.kind, target.owner_id,
			 target.provider_account_id, target.detached_on, target.connection_id,
			 connection.status AS connection_status,
			 connection.account_label, connection.scopes_json,
			 deployment.id AS deployment_id,
			 deployment.revision_id AS deployment_revision_id,
			 deployment.provider_resource_name,
			 deployment.status AS deployment_status,
			 deployment.deployed_on
			 FROM deployment_targets target
			 LEFT JOIN cloudflare_connections connection
			 ON connection.id = target.connection_id
			 LEFT JOIN shiplet_deployments deployment ON deployment.id = (
				SELECT latest.id FROM shiplet_deployments latest
				WHERE latest.target_id = target.id
				ORDER BY latest.deployed_on DESC, latest.rowid DESC LIMIT 1
			 )
			 WHERE target.project_id = ?
			 AND target.kind = 'customer_cloudflare'
			 ORDER BY target.created_on, target.id`,
    )
    .bind(input.project.id)
    .all<Record<string, unknown>>();
  const deploymentTargets = targetRows.results.map((row) => {
    const connectionStatus: "active" | "revoked" | "unavailable" =
      row.connection_status === "active" || row.connection_status === "revoked"
        ? row.connection_status
        : row.detached_on
          ? "revoked"
          : "unavailable";
    const deploymentStatus =
      typeof row.deployment_status === "string" ? row.deployment_status : null;
    return {
      id: String(row.id),
      kind: String(row.kind),
      ownership: "customer" as const,
      providerAccountId:
        typeof row.provider_account_id === "string"
          ? row.provider_account_id
          : null,
      connection:
        typeof row.connection_id === "string"
          ? {
              id: row.connection_id,
              status: connectionStatus,
            }
          : null,
      detached: Boolean(row.detached_on),
      lastDeployment:
        typeof row.deployment_id === "string"
          ? {
              id: row.deployment_id,
              revisionId: String(row.deployment_revision_id),
              scriptName:
                typeof row.provider_resource_name === "string"
                  ? row.provider_resource_name
                  : null,
              status: deploymentStatus,
              deployedOn:
                typeof row.deployed_on === "string" ? row.deployed_on : null,
              running: deploymentStatus === "healthy",
              updatesAvailable:
                connectionStatus === "active" && !row.detached_on,
            }
          : null,
    };
  });
  const authorityRow = targetRows.results.find(
    (row) => typeof row.connection_id === "string",
  );
  let scopes: string[] | undefined;
  if (typeof authorityRow?.scopes_json === "string") {
    try {
      const parsed = JSON.parse(authorityRow.scopes_json) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.every((scope) => typeof scope === "string")
      ) {
        scopes = parsed;
      }
    } catch {
      scopes = undefined;
    }
  }

  const claim = await input.db
    .prepare(
      `SELECT claim.target_id, claim.status, claim.expires_at_ms,
			 claim.delivery_event_id
			 FROM deployment_temporary_claims claim
			 JOIN deployment_targets target ON target.id = claim.target_id
			 WHERE claim.shiplet_id = ? AND target.project_id = ?
			 ORDER BY claim.updated_at_ms DESC, claim.target_id DESC LIMIT 1`,
    )
    .bind(input.project.id, input.project.id)
    .first<{
      target_id: string;
      status: string;
      expires_at_ms: number;
      delivery_event_id: string | null;
    }>();
  const temporaryClaim: ShipletOwnershipPageModel["temporaryClaim"] = claim
    ? claim.delivery_event_id
      ? { status: "claimed", targetId: claim.target_id }
      : claim.expires_at_ms <= now
        ? {
            status: "expired",
            targetId: claim.target_id,
            expiresAt: new Date(claim.expires_at_ms).toISOString(),
          }
        : {
            status: "awaiting_claim",
            targetId: claim.target_id,
            expiresAt: new Date(claim.expires_at_ms).toISOString(),
          }
    : input.temporaryClaimAvailable
      ? { status: "ready" }
      : { status: "unavailable" };

  return AdaptOwnershipPageModel({
    shiplet: { id: input.project.id, name: input.project.name },
    activeRevision,
    drafts,
    history,
    sealed,
    deploymentStatus: {
      shipletId: input.project.id,
      managed: {
        default: true,
        owner: "shiplet",
        status: input.project.archived_on ? "archived" : "active",
        runtime:
          input.managedRuntime ??
          (input.project.source_type === "worker"
            ? "worker"
            : input.project.source_type === "external_url"
              ? "external_proxy"
              : "static"),
        arbitraryWorkerExecution: input.managedWorkerAvailable
          ? { available: true }
          : {
              available: false,
              reason: "managed_dynamic_unavailable",
            },
      },
      customerCloudflare: {
        connectAvailable: input.cloudflareConnectAvailable,
        ...(input.cloudflareConnectAvailable
          ? {}
          : { reason: "cloudflare_oauth_prerequisite" as const }),
        targets: deploymentTargets,
      },
    },
    ...(authorityRow
      ? {
          cloudflareAuthority: {
            accountLabel:
              typeof authorityRow.account_label === "string"
                ? authorityRow.account_label
                : null,
            ...(scopes ? { scopes } : {}),
          },
        }
      : {}),
    temporaryClaim,
    export: { available: Boolean(activeRevision) },
  });
}
