import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { createShipletClient } from "../integrations/kody/shiplet/src/client";

const owner = {
  "x-shiplet-user-id": "kody_workflow_owner",
  "x-shiplet-user-email": "workflow@example.test",
};
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = owner,
) {
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
function client(headers = owner) {
  return createShipletClient({
    origin: "https://shiplet.cc",
    execute: async ({ code }) => {
      const response = await request(
        "/api/mcp",
        "POST",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "execute", arguments: { code } },
        },
        headers,
      );
      if (!response.ok)
        throw Object.assign(new Error("MCP HTTP failure"), { status: response.status });
      const result = (await response.json()) as any;
      if (result.error)
        throw Object.assign(new Error("MCP operation failed"), { status: result.error.code });
      return result.result;
    },
  });
}
async function setup() {
  const { organization } = (await (
    await request("/api/organizations", "POST", { name: `Kody ${crypto.randomUUID()}` })
  ).json()) as any;
  const api = client();
  const input = {
    name: "Field Notes",
    organizationId: organization.id,
    subdomain: `field-notes-${crypto.randomUUID().slice(0, 8)}`,
    visibility: "private" as const,
    files: [
      {
        path: "index.html",
        content: "<!doctype html><h1>Field Notes</h1><a href='#'>Get started</a>",
      },
    ],
  };
  const published = await api.publish(input);
  return { api, published, input, organization };
}
async function ticket(projectId: string, n: number) {
  const response = await request(`/api/projects/${projectId}/review-feedback`, "POST", {
    clientFeedbackId: `kody-fixture-feedback-${n}`,
    comment: "Say what happens next: View the trail guide.",
    pageUrl: `https://shiplet.cc/shiplets/${projectId}/review-host`,
    selectedElement: { selector: "a", text: "Get started" },
  });
  return ((await response.json()) as any).feedback;
}
describe("static Kody package through real Shiplet MCP and D1/R2", () => {
  it("publishes, reads, revises, verifies changed evidence, promotes with approval, and keeps feedback open", async () => {
    const { api, published } = await setup();
    expect(published).toMatchObject({
      projectId: expect.any(String),
      revisionId: expect.any(String),
      reviewUrl: expect.stringMatching(/^https:\/\//),
      previewUrl: expect.stringMatching(/^https:\/\//),
    });
    expect(await api.feedback({ ref: published })).toMatchObject({
      feedback: [],
      nextCursor: null,
    });
    const feedback = await ticket(published.projectId, 1);
    const read = await api.feedback({ ref: published });
    expect(read.feedback[0]).toMatchObject({
      id: feedback.id,
      source_revision_id: published.revisionId,
      revisionRelation: "matches_reference",
      selected_element: { selector: "a" },
    });
    const candidate = await api.prepareRevision({
      ref: published,
      feedbackIds: [feedback.id],
      changes: [
        {
          path: "index.html",
          content: "<!doctype html><h1>Field Notes</h1><a href='/guide'>View the trail guide</a>",
        },
      ],
    });
    expect(candidate).toMatchObject({
      projectId: published.projectId,
      baseRevisionId: published.revisionId,
      revisionId: expect.any(String),
      previewUrl: expect.stringContaining("/revisions/"),
    });
    expect(candidate.revisionId).not.toBe(published.revisionId);
    const checks = [
      {
        feedbackId: feedback.id,
        path: "index.html",
        includes: "View the trail guide",
        excludes: "Get started",
      },
    ];
    const evidence = await api.verifyRevision({ candidate, checks });
    expect(evidence.results).toMatchObject([
      { feedbackId: feedback.id, outcome: "changed_checks_passed", status: "New" },
    ]);
    expect(
      (
        await api.verifyRevision({
          candidate,
          checks: [{ feedbackId: feedback.id, path: "index.html", includes: "Field Notes" }],
        })
      ).results[0].outcome,
    ).toBe("unchanged_checks");
    expect(
      (
        await api.verifyRevision({
          candidate,
          checks: [{ feedbackId: feedback.id, path: "index.html", includes: "Missing" }],
        })
      ).results[0].outcome,
    ).toBe("checks_failed");
    // Browser-user fixture drives the service here; agent approval is tested separately.
    const activated = await api.activateRevision({
      candidate,
      idempotencyKey: `fixture-${crypto.randomUUID()}`,
      approval: true,
    });
    expect(activated).toMatchObject({
      state: "active",
      projectId: published.projectId,
      revisionId: candidate.revisionId,
    });
    expect((await api.feedback({ ref: activated as any })).feedback[0]).toMatchObject({
      id: feedback.id,
      status: "New",
      source_revision_id: published.revisionId,
      revisionRelation: "other_revision",
    });
    await expect(
      api.prepareRevision({
        ref: published,
        feedbackIds: [feedback.id],
        changes: [{ path: "index.html", content: "stale" }],
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });
  });
  it("does not retry create or accept another project's feedback", async () => {
    const { api, published, input } = await setup();
    await expect(api.publish(input)).rejects.toMatchObject({ status: 409 });
    const other = await setup();
    const wrong = await ticket(other.published.projectId, 2);
    await expect(
      api.prepareRevision({
        ref: published,
        feedbackIds: [wrong.id],
        changes: [{ path: "index.html", content: "new" }],
      }),
    ).rejects.toMatchObject({ code: "feedback_not_found" });
    expect((await api.feedback({ ref: published })).feedback).toEqual([]);
  });
  it("surfaces API failures and incompatible feedback responses without claiming empty success", async () => {
    const api = createShipletClient({
      origin: "https://shiplet.test",
      execute: async () => ({ isError: true, content: [{ type: "text", text: "unavailable" }] }),
    });
    await expect(
      api.feedback({ ref: { projectId: "p", revisionId: "r" } as any }),
    ).rejects.toMatchObject({ code: "mcp_error" });
    const old = createShipletClient({
      origin: "https://shiplet.test",
      execute: async () => ({
        content: [{ type: "text", text: JSON.stringify({ feedback: [] }) }],
      }),
    });
    await expect(
      old.feedback({ ref: { projectId: "p", revisionId: "r" } as any }),
    ).rejects.toMatchObject({ code: "unsupported_feedback_contract" });
  });
});

async function organizationClient(organizationId: string, scopes: string[], projectIds?: string[]) {
  const response = await request(`/api/organizations/${organizationId}/api-tokens`, "POST", {
    name: "Isolated fixture",
    scopes,
    projectAccessMode: projectIds ? "selected" : "all",
    ...(projectIds
      ? { projectRules: projectIds.map((projectId) => ({ projectId, effect: "allow" })) }
      : {}),
  });
  expect(response.status).toBe(201);
  // Generated credentials stay inside the fixture and are never logged or persisted.
  const issued = (await response.json()) as any;
  return { api: client({ authorization: `Bearer ${issued.token}` } as any), id: issued.record.id };
}

describe("package authority, approval and recovery", () => {
  it("honors read-only scopes, selected projects, revocation and owner isolation", async () => {
    const { api, published, input, organization } = await setup();
    const other = await api.publish({
      ...input,
      subdomain: `other-${crypto.randomUUID().slice(0, 8)}`,
    });
    const reader = await organizationClient(
      organization.id,
      ["mcp", "shiplets:read", "feedback:read"],
      [published.projectId],
    );
    expect((await reader.api.list()).projects.map((p: any) => p.id)).toEqual([published.projectId]);
    await expect(reader.api.feedback({ ref: published })).resolves.toMatchObject({ feedback: [] });
    await expect(
      reader.api.publish({ ...input, subdomain: `blocked-${crypto.randomUUID().slice(0, 8)}` }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      reader.api.prepareRevision({
        ref: published,
        feedbackIds: [],
        changes: [{ path: "index.html", content: "read only" }],
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(reader.api.inspect({ projectId: other.projectId })).rejects.toMatchObject({
      status: 403,
    });
    await expect(reader.api.feedback({ ref: other })).rejects.toMatchObject({ status: 403 });
    const writer = await organizationClient(
      organization.id,
      ["mcp", "shiplets:read", "shiplets:write", "feedback:read"],
      [published.projectId],
    );
    const candidate = await writer.api.prepareRevision({
      ref: published,
      feedbackIds: [],
      changes: [{ path: "index.html", content: "<!doctype html><h1>Allowed</h1>" }],
    });
    expect(candidate.projectId).toBe(published.projectId);
    await expect(writer.api.publish(input)).rejects.toMatchObject({ status: 403 });
    await expect(
      reader.api.inspectDraft({ projectId: other.projectId, draftId: candidate.draftId }),
    ).rejects.toMatchObject({ code: "checkpoint_mismatch" });
    const outsider = client({
      "x-shiplet-user-id": "unrelated_owner",
      "x-shiplet-user-email": "unrelated@example.test",
    });
    await expect(outsider.inspect({ projectId: published.projectId })).rejects.toMatchObject({
      status: 403,
    });
    await expect(outsider.feedback({ ref: published })).rejects.toMatchObject({ status: 403 });
    await expect(
      outsider.inspectDraft({ projectId: published.projectId, draftId: candidate.draftId }),
    ).rejects.toMatchObject({ status: 403 });
    const foreign = await setup();
    const foreignKey = await organizationClient(foreign.organization.id, [
      "mcp",
      "shiplets:read",
      "feedback:read",
    ]);
    await expect(foreignKey.api.inspect({ projectId: published.projectId })).rejects.toMatchObject({
      status: 403,
    });
    await request(`/api/organizations/${organization.id}/api-tokens/${reader.id}`, "DELETE");
    await expect(reader.api.list()).rejects.toMatchObject({ status: 401 });
  });
  it("requires an exact owner approval for an agent, replays promotion, and rejects expired approval", async () => {
    const { published, organization } = await setup();
    const writer = await organizationClient(
      organization.id,
      ["mcp", "shiplets:read", "shiplets:write", "feedback:read"],
      [published.projectId],
    );
    const candidate = await writer.api.prepareRevision({
      ref: published,
      feedbackIds: [],
      changes: [{ path: "index.html", content: "<!doctype html><h1>Approved candidate</h1>" }],
    });
    const input = { candidate, idempotencyKey: `retry-${crypto.randomUUID()}`, approval: true };
    const pending = await writer.api.activateRevision(input);
    expect(pending.state).toBe("approval_required");
    if (pending.state !== "approval_required") throw new Error("Expected approval");
    expect((await writer.api.inspect({ projectId: published.projectId })).revision.id).toBe(
      published.revisionId,
    );
    const approvalPath = new URL(pending.approvalUrl).pathname;
    const approvalPage = await request(approvalPath);
    expect(approvalPage.headers.get("referrer-policy")).toBe("same-origin");
    expect(
      (
        await request(`${approvalPath}/confirm`, "POST", undefined, {
          ...owner,
          Origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        })
      ).status,
    ).toBe(200);
    const activated = await writer.api.activateRevision({
      ...input,
      approvalRequestId: pending.approvalRequestId,
    });
    expect(activated.state).toBe("active");
    expect(
      await writer.api.activateRevision({ ...input, approvalRequestId: pending.approvalRequestId }),
    ).toEqual(activated);
    const latest = { ...published, revisionId: candidate.revisionId };
    const next = await writer.api.prepareRevision({
      ref: latest,
      feedbackIds: [],
      changes: [{ path: "index.html", content: "<!doctype html><h1>Next</h1>" }],
    });
    const expiring = await writer.api.activateRevision({
      candidate: next,
      idempotencyKey: "expired-approval",
    });
    if (expiring.state !== "approval_required") throw new Error("Expected approval");
    // Advance time for the owner-approval boundary without mutating immutable records.
    const { createD1KernelApprovalService } = await import("../src/mcp-kernel-approval");
    const expired = await createD1KernelApprovalService({
      db: (env as Env).DB,
      now: () => expiring.expiresAt + 1,
    }).decide({
      id: expiring.approvalRequestId,
      subjectUserId: owner["x-shiplet-user-id"],
      decision: "approved",
    });
    expect(expired).toBeNull();
    await expect(
      writer.api.activateRevision({
        candidate: next,
        idempotencyKey: "expired-approval",
        approvalRequestId: expiring.approvalRequestId,
      }),
    ).rejects.toMatchObject({ code: "trusted_approval_invalid" });
  });
  it("rejects wrong-version/unknown feedback, invalid assets, and resumes only an acknowledged checkpoint", async () => {
    const { api, published } = await setup();
    const f = await ticket(published.projectId, 5);
    const candidate = await api.prepareRevision({
      ref: published,
      feedbackIds: [f.id],
      changes: [{ path: "index.html", content: "<!doctype html><h1>Next</h1>" }],
    });
    await api.activateRevision({ candidate, idempotencyKey: "next-fixture", approval: true });
    await expect(
      api.prepareRevision({
        ref: { ...published, revisionId: candidate.revisionId },
        feedbackIds: [f.id],
        changes: [{ path: "index.html", content: "wrong" }],
      }),
    ).rejects.toMatchObject({ code: "wrong_feedback_revision" });
    for (const path of ["../widget/index.html", "/index.html", ".env"]) {
      await expect(
        api.prepareRevision({
          ref: published,
          feedbackIds: [],
          changes: [{ path, content: "bad" }],
        }),
      ).rejects.toMatchObject({ code: "invalid_artifact_path" });
    }
    await expect(
      api.verifyRevision({ candidate, checks: [{ feedbackId: f.id, path: "index.html" }] }),
    ).rejects.toMatchObject({ code: "invalid_evidence_check" });
    const latest = { ...published, revisionId: candidate.revisionId };
    let failedOnce = false;
    const flaky = createShipletClient({
      origin: published.origin,
      execute: async ({ code }) => {
        if (code.includes("/validate") && !failedOnce) {
          failedOnce = true;
          throw new Error("Fixture interruption");
        }
        const response = await request("/api/mcp", "POST", {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "execute", arguments: { code } },
        });
        return ((await response.json()) as any).result;
      },
    });
    const input = {
      ref: latest,
      feedbackIds: [],
      changes: [{ path: "index.html", content: "<!doctype html><h1>Recovered</h1>" }],
    };
    const failure = await flaky.prepareRevision(input).catch((error) => error);
    expect(failure.checkpoint).toMatchObject({
      projectId: published.projectId,
      baseRevisionId: candidate.revisionId,
      draftVersion: 2,
    });
    // Kody's execution boundary transports err.message, not custom properties.
    const recovery = JSON.parse(failure.message);
    expect(recovery).toMatchObject({ code: "revision_failed", checkpoint: failure.checkpoint });
    const recovered = await api.prepareRevision({ ...input, checkpoint: failure.checkpoint });
    expect(recovered.draftId).toBe(failure.checkpoint.draftId);
    await expect(
      api.prepareRevision({ ...input, checkpoint: failure.checkpoint }),
    ).rejects.toMatchObject({ code: "draft_conflict" });
  });
});
