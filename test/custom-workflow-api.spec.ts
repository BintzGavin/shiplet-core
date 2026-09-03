import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app, { commitValidatedWorkflowEvent } from "../src/index";

const OWNER = {
  "x-shiplet-user-id": "user_workflow_owner",
  "x-shiplet-user-email": "workflow-owner@example.com",
};

async function request(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request(`http://localhost${path}`, init),
    env as Env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

describe("custom workflow API", () => {
  it("validates against the active package and projects the event into the canonical inbox", async () => {
    const organizationResponse = await request("/api/organizations", {
      method: "POST",
      headers: { "content-type": "application/json", ...OWNER },
      body: JSON.stringify({ name: `Workflow ${crypto.randomUUID()}` }),
    });
    const organization = (await organizationResponse.json()) as {
      organization: { id: string };
    };
    const publishResponse = await request("/api/shiplets", {
      method: "POST",
      headers: { "content-type": "application/json", ...OWNER },
      body: JSON.stringify({
        name: "Custom workflow",
        organization_id: organization.organization.id,
        subdomain: `workflow-${crypto.randomUUID().slice(0, 8)}`,
        visibility: "private",
        assets: [{ path: "index.html", content: btoa("<h1>Workflow</h1>") }],
      }),
    });
    const project = (await publishResponse.json()) as {
      project: { id: string; subdomain: string };
    };
    const activeResponse = await request(`/api/shiplets/${project.project.id}/package`, {
      headers: OWNER,
    });
    const active = (await activeResponse.json()) as {
      revision: { id: string };
      package: { files: Array<Record<string, unknown>> };
    };
    const forkResponse = await request(`/api/shiplets/${project.project.id}/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json", ...OWNER },
      body: JSON.stringify({ fromRevisionId: active.revision.id }),
    });
    const fork = (await forkResponse.json()) as { draft: { id: string; version: number } };
    const draftResponse = await request(`/api/drafts/${fork.draft.id}/package`, {
      headers: OWNER,
    });
    const draft = (await draftResponse.json()) as {
      package: { files: Array<Record<string, unknown>> };
    };
    const schema = draft.package.files.find((file) => file.path === "workflow/schema.json");
    expect(schema).toBeTruthy();
    const schemaText = `${JSON.stringify({
      schemaVersion: "shiplet.workflow/v1",
      statuses: [
        { name: "Waiting on owner", category: "blocked" },
        { name: "FYI", category: "informational" },
      ],
      fields: [
        { name: "risk", type: "string" },
        { name: "score", type: "integer" },
      ],
    })}\n`;
    Object.assign(schema!, {
      encoding: "utf8",
      content: schemaText,
      size: new TextEncoder().encode(schemaText).byteLength,
      sha256: await sha256Hex(schemaText),
    });
    const updateResponse = await request(`/api/drafts/${fork.draft.id}/package`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "if-match": String(fork.draft.version),
        ...OWNER,
      },
      body: JSON.stringify({
        package: draft.package,
        expectedVersion: fork.draft.version,
      }),
    });
    expect(updateResponse.status, await updateResponse.clone().text()).toBe(200);
    const validateResponse = await request(`/api/drafts/${fork.draft.id}/validate`, {
      method: "POST",
      headers: { "content-type": "application/json", ...OWNER },
      body: JSON.stringify({ expectedVersion: fork.draft.version + 1 }),
    });
    expect(validateResponse.status, await validateResponse.clone().text()).toBe(200);
    const validated = (await validateResponse.json()) as {
      validation: { revisionId: string };
    };
    const promoteResponse = await request(`/api/drafts/${fork.draft.id}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json", ...OWNER },
      body: JSON.stringify({
        expectedActiveRevisionId: active.revision.id,
        approval: true,
      }),
    });
    expect(promoteResponse.status, await promoteResponse.clone().text()).toBe(200);

    const staleResponse = await request(`/api/shiplets/${project.project.id}/workflow-events`, {
      method: "POST",
      headers: { "content-type": "application/json", ...OWNER },
      body: JSON.stringify({
        revisionId: active.revision.id,
        status: "Waiting on owner",
        summary: "Stale event",
        fields: { risk: "high", score: 5 },
      }),
    });
    expect(staleResponse.status).toBe(409);

    const invalidResponse = await request(`/api/shiplets/${project.project.id}/workflow-events`, {
      method: "POST",
      headers: { "content-type": "application/json", ...OWNER },
      body: JSON.stringify({
        revisionId: validated.validation.revisionId,
        status: "Waiting on owner",
        summary: "Malformed event",
        fields: { risk: "high", score: "five" },
      }),
    });
    expect(invalidResponse.status).toBe(400);

    const response = await request(`/api/shiplets/${project.project.id}/workflow-events`, {
      method: "POST",
      headers: { "content-type": "application/json", ...OWNER },
      body: JSON.stringify({
        revisionId: validated.validation.revisionId,
        status: "Waiting on owner",
        summary: "Legal review is required",
        fields: { risk: "high", score: 5 },
      }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    expect(await response.json()).toMatchObject({
      event: {
        shipletId: project.project.id,
        revisionId: validated.validation.revisionId,
        actorKind: "human",
        actorId: OWNER["x-shiplet-user-id"],
        eventKind: "workflow.status-changed",
        canonicalStatusCategory: "blocked",
        customPayload: {
          status: "Waiting on owner",
          fields: { risk: "high", score: 5 },
        },
      },
    });

    const inboxResponse = await request("/api/notifications", { headers: OWNER });
    const inbox = (await inboxResponse.json()) as {
      notifications: Array<Record<string, unknown>>;
    };
    expect(inbox.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          project_id: project.project.id,
          type: "workflow",
          reason: "custom_event",
          message: "Legal review is required",
        }),
      ]),
    );

    const confirmationForm = new URLSearchParams({
      shiplet_id: project.project.id,
      revision_id: validated.validation.revisionId,
      request_id: `request_${crypto.randomUUID().replace(/-/g, "")}`,
      operation: "workflow.event.create",
      workflow_status: "FYI",
      workflow_summary: "Deployment note is informational",
      workflow_fields_json: JSON.stringify({
        risk: '<img src=x onerror="globalThis.compromised=true">',
        score: 1,
      }),
      page_url: `http://localhost/${project.project.subdomain}`,
    });
    const prepareConfirmation = await request("/review/confirm", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost",
        ...OWNER,
      },
      body: confirmationForm.toString(),
    });
    expect(
      prepareConfirmation.status,
      await prepareConfirmation.clone().text(),
    ).toBe(200);
    const confirmationHtml = await prepareConfirmation.text();
    expect(confirmationHtml).toContain("Workflow fields");
    expect(confirmationHtml).toContain("<dt>risk</dt>");
    expect(confirmationHtml).toContain("<dt>score</dt>");
    expect(confirmationHtml).toContain(
      '&quot;&lt;img src=x onerror=\\&quot;globalThis.compromised=true\\&quot;&gt;&quot;',
    );
    expect(confirmationHtml).not.toContain('<img src=x onerror="globalThis.compromised=true">');
    const emptyFieldsConfirmation = await request("/review/confirm", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost",
        ...OWNER,
      },
      body: new URLSearchParams({
        shiplet_id: project.project.id,
        revision_id: validated.validation.revisionId,
        request_id: `request_${crypto.randomUUID().replace(/-/g, "")}`,
        operation: "workflow.event.create",
        workflow_status: "FYI",
        workflow_summary: "No custom fields",
        workflow_fields_json: JSON.stringify({}),
        page_url: `http://localhost/${project.project.subdomain}`,
      }).toString(),
    });
    expect(emptyFieldsConfirmation.status).toBe(200);
    const emptyFieldsHtml = await emptyFieldsConfirmation.text();
    expect(emptyFieldsHtml).toContain("<h1>Confirm workflow event</h1>");
    expect(emptyFieldsHtml).toContain("Confirm and record workflow event");
    expect(emptyFieldsHtml).not.toContain("Confirm and send feedback");
    const intentId = confirmationHtml.match(/name="intent_id" value="([^"]+)"/)?.[1];
    expect(intentId).toMatch(/^review_intent_/);
    const completeConfirmation = await request("/review/confirm/complete", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost",
        ...OWNER,
      },
      body: new URLSearchParams({
        intent_id: intentId || "missing",
        approval: "confirm",
      }).toString(),
    });
    expect(
      completeConfirmation.status,
      await completeConfirmation.clone().text(),
    ).toBe(200);
    expect(await completeConfirmation.text()).toContain(
      "The workflow event was recorded by Shiplet.",
    );
    const informational = await (env as Env).DB.prepare(
      `SELECT canonical_status_category, canonical_status_category_v2
       FROM shiplet_events
       WHERE project_id = ? AND event_kind = 'workflow.status-changed'
       ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(project.project.id)
      .first<Record<string, string>>();
    expect(informational).toMatchObject({
      canonical_status_category: "unknown",
      canonical_status_category_v2: "informational",
    });

    const projectRow = await (env as Env).DB.prepare(
      "SELECT * FROM projects WHERE id = ? LIMIT 1",
    )
      .bind(project.project.id)
      .first();
    expect(projectRow).toBeTruthy();
    const realDb = (env as Env).DB;
    const raceDb = {
      prepare: realDb.prepare.bind(realDb),
      async batch(statements: D1PreparedStatement[]) {
        await realDb
          .prepare("UPDATE projects SET active_revision_id = ? WHERE id = ?")
          .bind(active.revision.id, project.project.id)
          .run();
        return realDb.batch(statements);
      },
    } as unknown as D1Database;
    const raced = await commitValidatedWorkflowEvent({
      env: { DB: raceDb } as Env,
      project: projectRow as never,
      actorId: OWNER["x-shiplet-user-id"],
      revisionId: validated.validation.revisionId,
      value: {
        status: "FYI",
        summary: "Must not cross the activation fence",
        canonicalStatusCategory: "informational",
        fields: {},
      },
    });
    expect(raced).toEqual({
      ok: false,
      code: "active_revision_conflict",
      status: 409,
    });
    expect(
      await realDb
        .prepare("SELECT COUNT(*) AS count FROM shiplet_events WHERE summary = ?")
        .bind("Must not cross the activation fence")
        .first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
    await realDb
      .prepare("UPDATE projects SET active_revision_id = ? WHERE id = ?")
      .bind(validated.validation.revisionId, project.project.id)
      .run();

    await realDb.prepare(
      `WITH digits(d) AS (
         VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
       ), numbers(n) AS (
         SELECT ones.d + 10 * tens.d
         FROM digits ones CROSS JOIN digits tens
       )
       INSERT INTO users (id, email, created_on, updated_on)
       SELECT 'user_workflow_watcher_' || n,
              'workflow-watcher-' || n || '@example.com',
              '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z'
       FROM numbers WHERE n < 95`,
    ).run();
    await realDb
      .prepare(
        `WITH digits(d) AS (
           VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
         ), numbers(n) AS (
           SELECT ones.d + 10 * tens.d
           FROM digits ones CROSS JOIN digits tens
         )
         INSERT INTO shiplet_watch_subscriptions
          (project_id, user_id, status, created_by_user_id, created_on, updated_on)
         SELECT ?, 'user_workflow_watcher_' || n, 'active', ?,
                '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z'
         FROM numbers WHERE n < 95`,
      )
      .bind(project.project.id, OWNER["x-shiplet-user-id"])
      .run();
    const cappedResponse = await request(
      `/api/shiplets/${project.project.id}/workflow-events`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...OWNER },
        body: JSON.stringify({
          revisionId: validated.validation.revisionId,
          status: "FYI",
          summary: "Bounded watcher fanout",
          fields: { risk: "low", score: 2 },
        }),
      },
    );
    expect(cappedResponse.status).toBe(201);
    expect(
      await realDb
        .prepare(
          `SELECT COUNT(*) AS count FROM review_notifications
           WHERE project_id = ? AND message = 'Bounded watcher fanout'`,
        )
        .bind(project.project.id)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 90 });

    const existingEvents = await realDb
      .prepare("SELECT COUNT(*) AS count FROM shiplet_events WHERE project_id = ?")
      .bind(project.project.id)
      .first<{ count: number }>();
    const remaining = 10_000 - (existingEvents?.count || 0);
    await realDb
      .prepare(
        `WITH digits(d) AS (
           VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
         ), numbers(n) AS (
           SELECT ones.d + 10*tens.d + 100*hundreds.d + 1000*thousands.d
           FROM digits ones CROSS JOIN digits tens CROSS JOIN digits hundreds
           CROSS JOIN digits thousands
         )
         INSERT INTO shiplet_events (
          id, project_id, revision_id, actor_kind, actor_id, event_kind,
          summary, canonical_status_category, custom_payload_json,
          occurred_at, created_at
         )
         SELECT 'event_workflow_quota_' || n, ?, ?, 'system', 'quota_fixture',
                'workflow.quota', 'Quota fixture', 'unknown', '{}',
                '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z'
         FROM numbers WHERE n < ?`,
      )
      .bind(project.project.id, validated.validation.revisionId, remaining)
      .run();
    const quotaResponse = await request(
      `/api/shiplets/${project.project.id}/workflow-events`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...OWNER },
        body: JSON.stringify({
          revisionId: validated.validation.revisionId,
          status: "FYI",
          summary: "Over quota",
          fields: { risk: "low", score: 3 },
        }),
      },
    );
    expect(quotaResponse.status).toBe(429);
    expect(await quotaResponse.json()).toEqual({
      ok: false,
      code: "workflow_event_limit_exceeded",
    });
  });
});
