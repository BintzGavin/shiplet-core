import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import claudeMain from "./fixtures/traces/claude-code-main.jsonl?raw";
import { parseJsonl, prepareTraceUpload } from "../src/cli/trace-core.mjs";

type TestEnv = Omit<Env, "SHIPLET_ENABLED_FEATURE_FLAGS"> & { SHIPLET_ENABLED_FEATURE_FLAGS?: string };
const testEnv = env as unknown as TestEnv;
const runtimeEnv = env as unknown as Env;

const person = (id: string) => ({ "x-shiplet-user-id": `user_mcp_${id}`, "x-shiplet-user-email": `${id}@mcp.test` });
const OWNER = person("owner");
const COLLEAGUE = person("colleague");

async function request(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  let response: Response;
  try {
    response = await app.fetch(new Request(`http://localhost${path}`, init), runtimeEnv, context);
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    response = error;
  }
  await waitOnExecutionContext(context);
  return response;
}

async function withTraces<T>(callback: () => Promise<T>) {
  const previous = testEnv.SHIPLET_ENABLED_FEATURE_FLAGS;
  testEnv.SHIPLET_ENABLED_FEATURE_FLAGS = "traces";
  try {
    return await callback();
  } finally {
    testEnv.SHIPLET_ENABLED_FEATURE_FLAGS = previous;
  }
}

async function tool(headers: Record<string, string>, name: "search" | "execute", code: string) {
  const response = await request("/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: { code } } }),
  });
  const value = (await response.json()) as Record<string, any>;
  const text = value.result?.content?.[0]?.text;
  let output: any;
  try {
    output = typeof text === "string" ? JSON.parse(text) : undefined;
  } catch {
    output = text;
  }
  return { response, value, output, isError: value.result?.isError === true, text };
}

const execute = (headers: Record<string, string>, call: string) => tool(headers, "execute", `async () => await codemode.request(${call})`);

async function setup() {
  const org = await request("/api/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({ name: `MCP traces ${crypto.randomUUID()}` }),
  });
  const organizationId = ((await org.json()) as { organization: { id: string } }).organization.id;
  const created = await request("/api/shiplets", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({
      name: "Checkout review",
      organization_id: organizationId,
      subdomain: `mcp-traces-${crypto.randomUUID().slice(0, 8)}`,
      visibility: "organization",
      assets: [{ path: "index.html", content: btoa("<h1>Review</h1>") }],
    }),
  });
  const projectId = ((await created.json()) as { project: { id: string } }).project.id;
  await request("/api/me", { headers: COLLEAGUE });
  await testEnv.DB.prepare("INSERT INTO organization_memberships (id, organization_id, user_id, role, created_on) VALUES (?, ?, ?, 'member', ?)")
    .bind(`orgm_${crypto.randomUUID()}`, organizationId, COLLEAGUE["x-shiplet-user-id"], new Date().toISOString())
    .run();
  return { organizationId, projectId };
}

describe("traces over Code Mode MCP (slice 3)", () => {
  it("uploads through an upload link, then lists, loads context, and shares through execute", async () => {
    await withTraces(async () => {
      const { projectId } = await setup();
      const link = await execute(OWNER, `{ method: "POST", path: "/api/shiplets/${projectId}/trace-uploads" }`);
      expect(link.isError, link.text).toBe(false);
      expect(link.output.uploadUrl).toMatch(/\/api\/trace-uploads\/shiplet_trace_upload_[a-f0-9]{64}$/);
      const path = new URL(link.output.uploadUrl).pathname;

      const prepared = await prepareTraceUpload({ main: parseJsonl(claudeMain), importer: "mcp-test" });
      const uploaded = await request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(prepared.upload) });
      expect(uploaded.status).toBe(201);
      const { trace } = (await uploaded.json()) as { trace: { id: string; uploadedBy: unknown } };
      expect(trace.uploadedBy).toEqual({ kind: "user", id: OWNER["x-shiplet-user-id"] });
      const reused = await request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...prepared.upload, title: "again" }) });
      expect(reused.status).toBe(409);
      expect((await request("/api/trace-uploads/shiplet_trace_upload_nope", { method: "POST", body: "{}" })).status).toBe(404);

      const listed = await execute(OWNER, `{ method: "GET", path: "/api/shiplets/${projectId}/traces" }`);
      expect(listed.output.traces.map((item: { id: string }) => item.id)).toEqual([trace.id]);

      const context = await execute(OWNER, `{ method: "GET", path: "/api/shiplets/${projectId}/traces/${trace.id}/context", query: { maxTokens: 4000 } }`);
      expect(context.output.level).toBe("full");
      expect(context.output.context).toContain("A trace is the full log of an agent session");
      expect(context.output.context).toContain("**User:** Add pagination to orders.");

      // the colleague cannot see it until it is shared
      const hidden = await execute(COLLEAGUE, `{ method: "GET", path: "/api/shiplets/${projectId}/traces/${trace.id}" }`);
      expect(hidden.isError).toBe(true);
      const shared = await execute(
        OWNER,
        `{ method: "PUT", path: "/api/shiplets/${projectId}/traces/${trace.id}/audiences", body: { audiences: [{ targetType: "organization", profile: { level: "conversation" } }] } }`,
      );
      expect(shared.output.sharing).toBe("shared");

      const found = await execute(COLLEAGUE, `{ method: "GET", path: "/api/traces" }`);
      expect(found.output.traces).toEqual([
        expect.objectContaining({ id: trace.id, shiplet: { id: projectId, name: "Checkout review" }, access: { level: "conversation", via: "audience" } }),
      ]);
      const colleagueContext = await execute(COLLEAGUE, `{ method: "GET", path: "/api/shiplets/${projectId}/traces/${trace.id}/context" }`);
      expect(colleagueContext.output.level).toBe("conversation");
      expect(colleagueContext.output.context).not.toContain("← error:");
      const preview = await execute(
        OWNER,
        `{ method: "POST", path: "/api/shiplets/${projectId}/traces/${trace.id}/preview", body: { profile: { level: "summary" } } }`,
      );
      expect(preview.output.events).toEqual([]);
      // a colleague cannot manage or delete it
      expect((await execute(COLLEAGUE, `{ method: "GET", path: "/api/shiplets/${projectId}/traces/${trace.id}/audiences" }`)).isError).toBe(true);
      expect((await execute(COLLEAGUE, `{ method: "DELETE", path: "/api/shiplets/${projectId}/traces/${trace.id}" }`)).isError).toBe(true);
      const deleted = await execute(OWNER, `{ method: "DELETE", path: "/api/shiplets/${projectId}/traces/${trace.id}" }`);
      expect(deleted.output).toEqual({ deleted: true, traceId: trace.id });
    });
  });

  it("creates a trace-only Shiplet through execute", async () => {
    await withTraces(async () => {
      const { organizationId } = await setup();
      const created = await execute(OWNER, `{ method: "POST", path: "/api/trace-shiplets", body: { name: "Agent session", organizationId: "${organizationId}" } }`);
      expect(created.isError, created.text).toBe(false);
      expect(created.output.shiplet).toMatchObject({ name: "Agent session", traceOnly: true, organizationId });
      const link = await execute(OWNER, `{ method: "POST", path: "/api/shiplets/${created.output.shiplet.id}/trace-uploads" }`);
      expect(link.isError, link.text).toBe(false);
    });
  });

  it("describes traces in search, including what a trace is", async () => {
    await withTraces(async () => {
      const found = await tool(
        OWNER,
        "search",
        `async () => { const spec = await codemode.spec(); return Object.entries(spec.paths).filter(([path]) => path.includes("trace")).map(([path, item]) => [path, Object.values(item).map((op) => op.operationId)]); }`,
      );
      const ids = (found.output as Array<[string, string[]]>).flatMap(([, operations]) => operations);
      expect(ids).toEqual(expect.arrayContaining(["listReadableTraces", "getTraceContext", "setTraceAudiences", "createTraceUploadLink"]));
      expect(ids).not.toContain("createTrace");
      const described = await tool(OWNER, "search", `async () => (await codemode.spec()).paths["/api/shiplets/{projectId}/traces/{traceId}/context"].get.description`);
      expect(String(described.output)).toContain("A trace is the full log of an agent session");
    });
  });
});
