import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import claudeMain from "./fixtures/traces/claude-code-main.jsonl?raw";
import claudeSub from "./fixtures/traces/claude-code-main/subagents/agent-a1.jsonl?raw";
import openTrace from "./fixtures/traces/open-format.jsonl?raw";
import { parseJsonl, prepareTraceUpload, type TraceUpload } from "../src/cli/trace-core.mjs";

type TestEnv = Omit<Env, "SHIPLET_ENABLED_FEATURE_FLAGS"> & { SHIPLET_ENABLED_FEATURE_FLAGS?: string };
const testEnv = env as unknown as TestEnv;
const runtimeEnv = env as unknown as Env;

const OWNER = { "x-shiplet-user-id": "user_trace_owner", "x-shiplet-user-email": "trace-owner@example.com" };
const MEMBER = { "x-shiplet-user-id": "user_trace_member", "x-shiplet-user-email": "trace-member@example.com" };
const ADMIN = { "x-shiplet-user-id": "user_trace_admin", "x-shiplet-user-email": "trace-admin@example.com" };

async function request(path: string, init: RequestInit = {}, targetEnv: Env = runtimeEnv) {
  const context = createExecutionContext();
  let response: Response;
  try {
    response = await app.fetch(new Request(`http://localhost${path}`, init), targetEnv, context);
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    response = error;
  }
  await waitOnExecutionContext(context);
  return response;
}

async function withTraces<T>(callback: () => Promise<T>, flags = "traces") {
  const previous = testEnv.SHIPLET_ENABLED_FEATURE_FLAGS;
  testEnv.SHIPLET_ENABLED_FEATURE_FLAGS = flags;
  try {
    return await callback();
  } finally {
    testEnv.SHIPLET_ENABLED_FEATURE_FLAGS = previous;
  }
}

async function createOrganization() {
  const response = await request("/api/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({ name: `Traces ${crypto.randomUUID()}` }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { organization: { id: string } }).organization.id;
}

async function addMember(organizationId: string, headers: Record<string, string>, role: "member" | "admin") {
  await request("/api/me", { headers });
  await testEnv.DB.prepare(
    "INSERT OR REPLACE INTO organization_memberships (id, organization_id, user_id, role, created_on) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(`orgm_${crypto.randomUUID()}`, organizationId, headers["x-shiplet-user-id"], role, new Date().toISOString())
    .run();
}

async function createShiplet(organizationId: string, visibility = "organization") {
  const response = await request("/api/shiplets", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({
      name: "Trace Shiplet",
      organization_id: organizationId,
      subdomain: `trace-${crypto.randomUUID().slice(0, 8)}`,
      visibility,
      assets: [{ path: "index.html", content: btoa("<h1>Review</h1>") }],
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id?: string; project?: { id: string }; shiplet?: { id: string } };
  const id = body.id || body.project?.id || body.shiplet?.id;
  expect(id).toBeTruthy();
  return id as string;
}

async function createApiToken(organizationId: string, scopes: string[], projectId?: string) {
  const response = await request(`/api/organizations/${organizationId}/api-tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({
      name: `Trace agent ${crypto.randomUUID().slice(0, 6)}`,
      scopes,
      projectAccessMode: projectId ? "selected" : "all",
      ...(projectId ? { projectRules: [{ projectId, effect: "allow" }] } : {}),
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: string; record: { id: string } });
}

async function fixtureUpload(overrides: Partial<TraceUpload> = {}): Promise<TraceUpload> {
  const prepared = await prepareTraceUpload({
    main: parseJsonl(claudeMain),
    subagents: [{ fileName: "agent-a1.jsonl", ...parseJsonl(claudeSub) }],
    importer: "trace-api-test",
  });
  return { ...prepared.upload, ...overrides };
}

const post = (projectId: string, body: unknown, headers: Record<string, string> = OWNER) =>
  request(`/api/shiplets/${projectId}/traces`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("trace API (slice 1)", () => {
  it("masks a secret that skipped client masking on ingest", async () => {
    await withTraces(async () => {
      const organizationId = await createOrganization();
      const projectId = await createShiplet(organizationId);
      const upload = await fixtureUpload({ clientMasking: { coreVersion: "1", count: 0, kinds: {} } });
      const planted = `shiplet_org_${"a1b2c3".repeat(4)}`;
      upload.events = upload.events.map((event) =>
        event.kind === "tool_result" ? { ...event, result: { ...event.result!, text: `key ${planted}` } } : event,
      );
      const response = await post(projectId, upload);
      expect(response.status).toBe(201);
      const created = (await response.json()) as {
        trace: { id: string; segmentCount: number; sharing: string };
        serverMasked: { count: number; kinds: Record<string, number> };
      };
      const toolResults = upload.events.filter((event) => event.kind === "tool_result").length;
      expect(created.serverMasked.kinds["shiplet-api-key"]).toBe(toolResults);
      expect(created.trace.sharing).toBe("private");
      const segment = await request(`/api/shiplets/${projectId}/traces/${created.trace.id}/segments/0`, { headers: OWNER });
      expect(segment.status).toBe(200);
      const text = await segment.text();
      expect(text).toContain("[secret:shiplet-api-key]");
      expect(text).not.toContain(planted);
    });
  });

  it("stores a session from any agent in the open format, names its harness, and masks it on ingest", async () => {
    await withTraces(async () => {
      const organizationId = await createOrganization();
      const projectId = await createShiplet(organizationId);
      const prepared = await prepareTraceUpload({ main: parseJsonl(openTrace), importer: "trace-api-test" });
      expect(prepared.upload.source.harness).toBe("acme-agent");
      // Plant a secret after client masking, as a raw API client might.
      const planted = `shiplet_org_${"d4e5f6".repeat(4)}`;
      const upload = {
        ...prepared.upload,
        title: `Deploy with ${planted}`,
        clientMasking: { coreVersion: "1", count: 0, kinds: {} },
        events: prepared.upload.events.map((event) => (event.kind === "assistant_message" ? { ...event, text: `${event.text} ${planted}` } : event)),
      };
      const response = await post(projectId, upload);
      expect(response.status).toBe(201);
      const created = (await response.json()) as {
        trace: { id: string; harness: string };
        manifest: { title: string; source: { harness: string; harnessVersion: string }; agents: unknown[]; summary: { outcome: string } };
        serverMasked: { count: number; kinds: Record<string, number> };
      };
      expect(created.trace.harness).toBe("acme-agent");
      expect(created.manifest.source).toMatchObject({ harness: "acme-agent", harnessVersion: "1.4.0" });
      expect(created.manifest.agents).toEqual([{ id: "reviewer", title: "Check the discount rules" }]);
      expect(created.manifest.summary.outcome).toBe("last-check-passed");
      expect(created.serverMasked).toEqual({ count: 2, kinds: { "shiplet-api-key": 2 } });
      expect(created.manifest).toMatchObject({ title: "Deploy with [secret:shiplet-api-key]" });
      expect(JSON.stringify(created)).not.toContain(planted);
      const segment = await (await request(`/api/shiplets/${projectId}/traces/${created.trace.id}/segments/0`, { headers: OWNER })).text();
      expect(segment).toContain("[secret:shiplet-api-key]");
      expect(segment).toContain("[secret:github-token]");
      expect(segment).not.toContain(planted);
      const listed = (await (await request(`/api/shiplets/${projectId}/traces`, { headers: OWNER })).json()) as { traces: Array<{ harness: string }> };
      expect(listed.traces.map((trace) => trace.harness)).toEqual(["acme-agent"]);

      const invalid = await post(projectId, { ...prepared.upload, source: { ...prepared.upload.source, harness: "Acme Agent" } });
      expect(invalid.status).toBe(400);
      expect(((await invalid.json()) as { errors: Array<{ path: string }> }).errors.map((error) => error.path)).toContain("source.harness");
    });
  });

  it("uploads, lists, reads, serves attachments, pulls context data, and deletes", async () => {
    await withTraces(async () => {
      const organizationId = await createOrganization();
      const projectId = await createShiplet(organizationId);
      const upload = await fixtureUpload();
      const created = await post(projectId, upload);
      expect(created.status).toBe(201);
      const { trace, manifest } = (await created.json()) as {
        trace: Record<string, unknown> & { id: string };
        manifest: { summary: { outcome: string }; attachments: Array<{ sha256: string }>; segments: unknown[] };
      };
      expect(Object.keys(trace).sort()).toEqual(
        [
          "attachmentBytes",
          "attachmentCount",
          "canonicalBytes",
          "createdOn",
          "endedOn",
          "eventCount",
          "harness",
          "id",
          "pendingAttachments",
          "projectId",
          "revisionId",
          "segmentCount",
          "serverMaskedCount",
          "sharing",
          "startedOn",
          "title",
          "uploadedBy",
        ].sort(),
      );
      expect(trace.uploadedBy).toEqual({ kind: "user", id: "user_trace_owner" });
      expect(manifest.summary.outcome).toBe("last-check-passed");

      const list = await request(`/api/shiplets/${projectId}/traces`, { headers: OWNER });
      expect(((await list.json()) as { traces: Array<{ id: string }> }).traces.map((item) => item.id)).toEqual([trace.id]);

      const detail = await request(`/api/shiplets/${projectId}/traces/${trace.id}`, { headers: OWNER });
      expect(detail.status).toBe(200);

      const sha = manifest.attachments[0].sha256;
      const attachment = await request(`/api/shiplets/${projectId}/traces/${trace.id}/attachments/${sha}`, { headers: OWNER });
      expect(attachment.status).toBe(200);
      expect(attachment.headers.get("content-type")).toBe("image/png");
      expect(attachment.headers.get("x-content-type-options")).toBe("nosniff");
      expect(attachment.headers.get("content-disposition")).toBe("inline");

      const outOfRange = await request(`/api/shiplets/${projectId}/traces/${trace.id}/segments/${manifest.segments.length}`, { headers: OWNER });
      expect(outOfRange.status).toBe(404);

      const removed = await request(`/api/shiplets/${projectId}/traces/${trace.id}`, { method: "DELETE", headers: OWNER });
      expect(removed.status).toBe(200);
      const gone = await request(`/api/shiplets/${projectId}/traces/${trace.id}`, { headers: OWNER });
      expect(gone.status).toBe(404);
      const objects = await testEnv.REVIEW_ASSETS.list({ prefix: `traces/v1/${projectId}/${trace.id}/` });
      expect(objects.objects).toHaveLength(0);
    });
  });

  it("returns the same trace for an identical retry instead of a second one", async () => {
    await withTraces(async () => {
      const projectId = await createShiplet(await createOrganization());
      const body = JSON.stringify(await fixtureUpload());
      const first = await post(projectId, body);
      expect(first.status).toBe(201);
      const second = await post(projectId, body);
      expect(second.status).toBe(200);
      const retried = (await second.json()) as { duplicate: boolean; trace: { id: string } };
      expect(retried.duplicate).toBe(true);
      expect(retried.trace.id).toBe(((await first.json()) as { trace: { id: string } }).trace.id);
      const count = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM project_traces WHERE project_id = ?").bind(projectId).first<{ n: number }>();
      expect(count?.n).toBe(1);
    });
  });

  it("keeps a new trace private from other members, admins, and anonymous viewers", async () => {
    await withTraces(async () => {
      const organizationId = await createOrganization();
      await addMember(organizationId, MEMBER, "member");
      await addMember(organizationId, ADMIN, "admin");
      const projectId = await createShiplet(organizationId, "public");
      const created = await post(projectId, await fixtureUpload());
      const { trace } = (await created.json()) as { trace: { id: string } };
      for (const headers of [MEMBER, ADMIN, {}]) {
        const read = await request(`/api/shiplets/${projectId}/traces/${trace.id}`, { headers });
        expect(read.status).toBe(404);
        expect(await read.json()).toMatchObject({ error: "not_found" });
        const list = await request(`/api/shiplets/${projectId}/traces`, { headers });
        if (list.status === 200) expect(((await list.json()) as { traces: unknown[] }).traces).toEqual([]);
        if (headers !== ADMIN) {
          const del = await request(`/api/shiplets/${projectId}/traces/${trace.id}`, { method: "DELETE", headers });
          expect(del.status).toBe(404);
        }
      }
      // a member cannot even add a trace to a Shiplet they cannot edit
      const memberUpload = await post(projectId, await fixtureUpload({ title: "member" }), MEMBER);
      expect(memberUpload.status).toBe(403);
      // organization admins cannot read a private trace, but may delete it
      const adminDelete = await request(`/api/shiplets/${projectId}/traces/${trace.id}`, { method: "DELETE", headers: ADMIN });
      expect(adminDelete.status).toBe(200);
    });
  });

  it("lets an API key read only the traces it uploaded", async () => {
    await withTraces(async () => {
      const organizationId = await createOrganization();
      const projectId = await createShiplet(organizationId);
      const writer = await createApiToken(organizationId, ["traces:read", "traces:write"]);
      const reader = await createApiToken(organizationId, ["traces:read"]);
      const auth = (token: string) => ({ authorization: `Bearer ${token}` });
      const created = await post(projectId, await fixtureUpload(), auth(writer.token));
      expect(created.status).toBe(201);
      const { trace } = (await created.json()) as { trace: { id: string; uploadedBy: unknown } };
      expect(trace.uploadedBy).toEqual({ kind: "api_key", id: writer.record.id });
      expect((await request(`/api/shiplets/${projectId}/traces/${trace.id}`, { headers: auth(writer.token) })).status).toBe(200);
      expect((await request(`/api/shiplets/${projectId}/traces/${trace.id}`, { headers: auth(reader.token) })).status).toBe(404);
      // the Shiplet owner can read it too
      expect((await request(`/api/shiplets/${projectId}/traces/${trace.id}`, { headers: OWNER })).status).toBe(200);
      // a read-only key cannot upload
      const denied = await post(projectId, await fixtureUpload({ title: "x" }), auth(reader.token));
      expect(denied.status).toBe(403);
      expect((await post(projectId, await fixtureUpload(), { authorization: "Bearer shiplet_org_nope" })).status).toBe(401);
    });
  });

  it("asks a CLI session without trace scopes to sign in again, and accepts one with them", async () => {
    await withTraces(async () => {
      const projectId = await createShiplet(await createOrganization());
      const session = async (scopes: string[]) => {
        const token = `shiplet_cli_session_${crypto.randomUUID().replace(/-/g, "")}`;
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
        const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        await testEnv.DB.prepare(
          "INSERT INTO cli_sessions (session_hash, authorization_request_id, user_id, scopes_json, expires_on, created_on) VALUES (?, ?, ?, ?, ?, ?)",
        )
          .bind(hash, `cli_req_${crypto.randomUUID()}`, "user_trace_owner", JSON.stringify(scopes), new Date(Date.now() + 3_600_000).toISOString(), new Date().toISOString())
          .run();
        return { authorization: `Bearer ${token}` };
      };
      const old = await session(["revision:read", "revision:write", "deployment:write", "session:read", "session:revoke"]);
      const stale = await request(`/api/shiplets/${projectId}/traces`, { headers: old });
      expect(stale.status).toBe(401);
      expect(await stale.json()).toMatchObject({ error: "cli_session_reauth_required" });
      const fresh = await session(["revision:read", "session:read", "session:revoke", "trace:read", "trace:write"]);
      const created = await post(projectId, await fixtureUpload(), fresh);
      expect(created.status).toBe(201);
      const listed = await request(`/api/shiplets/${projectId}/traces`, { headers: fresh });
      expect(listed.status).toBe(200);
      expect(((await listed.json()) as { traces: unknown[] }).traces).toHaveLength(1);
    });
  });

  it("lets a CLI session with trace scopes reach every trace route the CLI calls", async () => {
    await withTraces(async () => {
      const organizationId = await createOrganization();
      const projectId = await createShiplet(organizationId);
      const token = `shiplet_cli_session_${crypto.randomUUID().replace(/-/g, "")}`;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      await testEnv.DB.prepare(
        "INSERT INTO cli_sessions (session_hash, authorization_request_id, user_id, scopes_json, expires_on, created_on) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(hash, `cli_req_${crypto.randomUUID()}`, "user_trace_owner", JSON.stringify(["session:read", "trace:read", "trace:write"]), new Date(Date.now() + 3_600_000).toISOString(), new Date().toISOString())
        .run();
      const cli = { authorization: `Bearer ${token}` };
      const created = await post(projectId, await fixtureUpload(), cli);
      expect(created.status).toBe(201);
      const traceId = ((await created.json()) as { trace: { id: string } }).trace.id;
      const trace = `/api/shiplets/${projectId}/traces/${traceId}`;
      const json = (method: string, body: unknown) => ({
        method,
        headers: { "Content-Type": "application/json", ...cli },
        body: JSON.stringify(body),
      });
      const routes: Array<[string, RequestInit]> = [
        ["/api/trace-shiplets", json("POST", { name: "CLI trace-only", organizationId })],
        ["/api/traces", { headers: cli }],
        [`${trace}/context`, { headers: cli }],
        [`${trace}/audiences`, { headers: cli }],
        [`${trace}/audiences`, json("PUT", { audiences: [] })],
        [`${trace}/preview`, json("POST", { level: "conversation" })],
        [`${trace}/attachments/${"0".repeat(64)}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", ...cli }, body: "x" }],
        [`/api/shiplets/${projectId}/trace-uploads`, json("POST", {})],
      ];
      for (const [path, init] of routes) {
        const response = await request(path, init);
        expect({ path, method: init.method ?? "GET", status: response.status }).not.toMatchObject({ status: 401 });
      }
    });
  });

  it("refuses cross-site trace changes from a browser session", async () => {
    await withTraces(async () => {
      const projectId = await createShiplet(await createOrganization());
      const crossSite = await post(projectId, await fixtureUpload(), { ...OWNER, "sec-fetch-site": "cross-site" });
      expect(crossSite.status).toBe(403);
      const sameOrigin = await post(projectId, await fixtureUpload(), { ...OWNER, "sec-fetch-site": "same-origin" });
      expect(sameOrigin.status).toBe(201);
    });
  });

  it("refuses with clear errors", async () => {
    await withTraces(async () => {
      const organizationId = await createOrganization();
      const projectId = await createShiplet(organizationId);
      const invalid = await post(projectId, { ...(await fixtureUpload()), title: "" });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: "invalid_upload", errors: [expect.objectContaining({ path: "title" })] });
      const badJson = await post(projectId, "{not json");
      expect(badJson.status).toBe(400);
      const foreign = await post(projectId, await fixtureUpload({ revisionId: "rev_not_here" }));
      expect(foreign.status).toBe(400);
      expect(await foreign.json()).toMatchObject({ error: "revision_not_in_shiplet" });
      const tooLarge = await post(projectId, "x".repeat(16 * 1024 * 1024 + 1));
      expect(tooLarge.status).toBe(413);
      expect(await tooLarge.json()).toMatchObject({ error: "payload_too_large" });
      const anonymous = await post(projectId, await fixtureUpload(), {});
      expect(anonymous.status).toBe(401);
      const missing = await request(`/api/shiplets/proj_missing/traces`, { headers: OWNER });
      expect(missing.status).toBe(404);
    });
  });

  it("enforces the storage quota", async () => {
    await withTraces(async () => {
      const organizationId = await createOrganization();
      const projectId = await createShiplet(organizationId);
      await testEnv.DB.prepare(
        `INSERT INTO project_traces (id, project_id, organization_id, upload_sha256, title, harness, event_count, segment_count,
          canonical_bytes, attachment_count, attachment_bytes, client_masked_count, server_masked_count, manifest_sha256, created_on)
         VALUES (?, ?, ?, ?, 'big', 'codex', 1, 1, ?, 0, 0, 0, 0, 'x', ?)`,
      )
        .bind(`trc_${crypto.randomUUID()}`, projectId, organizationId, crypto.randomUUID(), 10 * 1024 * 1024 * 1024, new Date().toISOString())
        .run();
      const response = await post(projectId, await fixtureUpload());
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: "quota_exceeded" });
    });
  });

  it("refuses uploads to archived Shiplets and deletes trace objects with the Shiplet", async () => {
    await withTraces(async () => {
      const organizationId = await createOrganization();
      const projectId = await createShiplet(organizationId);
      const created = await post(projectId, await fixtureUpload());
      expect(created.status).toBe(201);
      await testEnv.REVIEW_ASSETS.put(`traces/v1/${projectId}/trc_orphan/canonical/manifest.json`, "{}");
      const archive = await request(`/api/projects/${projectId}/archive`, { method: "POST", headers: OWNER });
      expect(archive.status).toBeLessThan(300);
      const archived = await post(projectId, await fixtureUpload({ title: "after archive" }));
      expect(archived.status).toBe(409);
      expect(await archived.json()).toMatchObject({ error: "shiplet_archived" });
      const { subdomain } = (await testEnv.DB.prepare("SELECT subdomain FROM projects WHERE id = ?").bind(projectId).first<{ subdomain: string }>())!;
      const purge = await request(`/api/projects/${projectId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...OWNER },
        body: JSON.stringify({ confirmSubdomain: subdomain }),
      });
      expect(purge.status).toBeLessThan(300);
      const objects = await testEnv.REVIEW_ASSETS.list({ prefix: `traces/v1/${projectId}/` });
      expect(objects.objects).toHaveLength(0);
      const rows = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM project_traces WHERE project_id = ?").bind(projectId).first<{ n: number }>();
      expect(rows?.n).toBe(0);
    });
  });

  it("is hidden when the flag is off, and reports missing storage", async () => {
    const organizationId = await createOrganization();
    const projectId = await createShiplet(organizationId);
    await withTraces(async () => {
      const off = await request(`/api/shiplets/${projectId}/traces`, { headers: OWNER });
      expect(off.status).toBe(404);
      expect(await off.json()).toMatchObject({ error: "traces_not_enabled" });
    }, "");
    await withTraces(async () => {
      const noStorage = { ...testEnv, REVIEW_ASSETS: undefined } as unknown as Env;
      const response = await request(`/api/shiplets/${projectId}/traces`, { headers: OWNER }, noStorage);
      expect(response.status).toBe(503);
    });
  });

  it("accepts an upload just under 16 MiB", async () => {
    await withTraces(async () => {
      const projectId = await createShiplet(await createOrganization());
      const upload = await fixtureUpload();
      const chunk = "q".repeat(200 * 1024);
      const base = upload.events.length;
      const extra = Array.from({ length: 74 }, (_, index) => ({
        id: `e${String(base + index).padStart(6, "0")}`,
        seq: base + index,
        t: null,
        agent: "main",
        kind: "assistant_message" as const,
        text: chunk,
      }));
      const body = JSON.stringify({ ...upload, events: [...upload.events, ...extra] });
      expect(body.length).toBeGreaterThan(14 * 1024 * 1024);
      expect(body.length).toBeLessThan(16 * 1024 * 1024);
      const response = await post(projectId, body);
      expect(response.status).toBe(201);
      const { trace } = (await response.json()) as { trace: { segmentCount: number } };
      expect(trace.segmentCount).toBeGreaterThan(10);
    });
  });
});
