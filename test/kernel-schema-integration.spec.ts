import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";

async function request(path: string) {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      headers: {
        "x-shiplet-user-id": "user_schema_integration",
        "x-shiplet-user-email": "schema-integration@example.com",
      },
    }),
    env as Env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

describe("trusted kernel schema integration", () => {
  it("Given a normal request, When schema initialization runs, Then all additive kernel contracts exist", async () => {
    const response = await request("/api/shiplets");
    expect(response.status).toBe(200);

    const tables = await (env as Env).DB.prepare(
      `SELECT name FROM sqlite_master
			 WHERE type = 'table' AND name IN (
			  'shiplet_revisions', 'shiplet_drafts', 'shiplet_revision_operations',
			  'shiplet_revision_preview_receipts',
			  'shiplet_revision_preview_receipts_v2',
			  'shiplet_broker_grants', 'shiplet_broker_approvals',
			  'shiplet_broker_uses', 'shiplet_audit_events', 'shiplet_events',
			  'embed_review_sessions', 'cloudflare_oauth_state_refs',
			  'cloudflare_connections', 'cloudflare_refresh_reservations',
			  'cloudflare_control_audit_outbox',
			  'deployment_target_resources', 'deployment_operation_journals',
			  'deployment_temporary_claims', 'deployment_failure_events',
			  'shiplet_custom_mcp_quarantine'
			 ) ORDER BY name`,
    ).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      "cloudflare_connections",
      "cloudflare_control_audit_outbox",
      "cloudflare_oauth_state_refs",
      "cloudflare_refresh_reservations",
      "deployment_failure_events",
      "deployment_operation_journals",
      "deployment_target_resources",
      "deployment_temporary_claims",
      "embed_review_sessions",
      "shiplet_audit_events",
      "shiplet_broker_approvals",
      "shiplet_broker_grants",
      "shiplet_broker_uses",
      "shiplet_custom_mcp_quarantine",
      "shiplet_drafts",
      "shiplet_events",
      "shiplet_revision_operations",
      "shiplet_revision_preview_receipts",
      "shiplet_revision_preview_receipts_v2",
      "shiplet_revisions",
    ]);

    const retiredTables = await (env as Env).DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (
        'shiplet_review_layers', 'shiplet_review_layer_previews',
        'shiplet_root_migrations'
       ) ORDER BY name`,
    ).all<{ name: string }>();
    expect(retiredTables.results).toEqual([]);

    const projectColumns = await (env as Env).DB.prepare(
      "PRAGMA table_info(projects)",
    ).all<{ name: string }>();
    expect(projectColumns.results.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "active_revision_id",
        "active_revision_generation",
        "revision_migrated_on",
        "deployment_target_generation",
        "revision_operation_id",
      ]),
    );

    const deploymentColumns = await (env as Env).DB.prepare(
      "PRAGMA table_info(shiplet_deployments)",
    ).all<{ name: string }>();
    expect(deploymentColumns.results.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "provider_deployment_id",
        "deployed_at_ms",
        "failure_reason",
      ]),
    );

    const previewReceiptColumns = await (env as Env).DB.prepare(
      "PRAGMA table_info(shiplet_revision_preview_receipts_v2)",
    ).all<{ name: string }>();
    expect(previewReceiptColumns.results.map((row) => row.name)).toContain(
      "session_binding_digest",
    );

    const triggers = await (env as Env).DB.prepare(
      `SELECT name FROM sqlite_master
			 WHERE type = 'trigger' AND name IN (
			  'shiplet_revisions_no_update',
			  'shiplet_revision_preview_receipts_v2_no_update',
			  'trg_shiplet_events_immutable_update',
			  'shiplet_audit_events_no_update'
			 ) ORDER BY name`,
    ).all<{ name: string }>();
    expect(triggers.results.map((row) => row.name)).toEqual([
      "shiplet_audit_events_no_update",
      "shiplet_revision_preview_receipts_v2_no_update",
      "shiplet_revisions_no_update",
      "trg_shiplet_events_immutable_update",
    ]);
  });
});
