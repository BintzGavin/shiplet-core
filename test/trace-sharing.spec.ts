import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { sweepArchivedShipletTraces } from "../src/traces/store";
import claudeMain from "./fixtures/traces/claude-code-main.jsonl?raw";
import claudeSub from "./fixtures/traces/claude-code-main/subagents/agent-a1.jsonl?raw";
import { parseJsonl, prepareTraceUpload, sha256Hex, type TraceUpload } from "../src/cli/trace-core.mjs";

type TestEnv = Omit<Env, "SHIPLET_ENABLED_FEATURE_FLAGS"> & { SHIPLET_ENABLED_FEATURE_FLAGS?: string };
const testEnv = env as unknown as TestEnv;
const runtimeEnv = env as unknown as Env;

const person = (id: string) => ({ "x-shiplet-user-id": `user_share_${id}`, "x-shiplet-user-email": `${id}@share.test` });
const OWNER = person("owner");

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

const json = (headers: Record<string, string>) => ({ "Content-Type": "application/json", ...headers });

async function setup(visibility = "organization") {
  const org = await request("/api/organizations", { method: "POST", headers: json(OWNER), body: JSON.stringify({ name: `Share ${crypto.randomUUID()}` }) });
  const organizationId = ((await org.json()) as { organization: { id: string } }).organization.id;
  const created = await request("/api/shiplets", {
    method: "POST",
    headers: json(OWNER),
    body: JSON.stringify({
      name: "Share Shiplet",
      organization_id: organizationId,
      subdomain: `share-${crypto.randomUUID().slice(0, 8)}`,
      visibility,
      assets: [{ path: "index.html", content: btoa("<h1>Review</h1>") }],
    }),
  });
  const projectId = ((await created.json()) as { project: { id: string } }).project.id;
  return { organizationId, projectId };
}

async function addMember(organizationId: string, headers: Record<string, string>, role = "member") {
  await request("/api/me", { headers });
  const membershipId = `orgm_${crypto.randomUUID()}`;
  await testEnv.DB.prepare("INSERT INTO organization_memberships (id, organization_id, user_id, role, created_on) VALUES (?, ?, ?, ?, ?)")
    .bind(membershipId, organizationId, headers["x-shiplet-user-id"], role, new Date().toISOString())
    .run();
  return membershipId;
}

async function addTeam(organizationId: string, members: Array<Record<string, string>>) {
  const teamId = `team_${crypto.randomUUID().slice(0, 12)}`;
  await testEnv.DB.prepare("INSERT INTO teams (id, organization_id, name, created_by_user_id, created_on) VALUES (?, ?, ?, ?, ?)")
    .bind(teamId, organizationId, `Team ${teamId}`, OWNER["x-shiplet-user-id"], new Date().toISOString())
    .run();
  for (const headers of members) {
    await testEnv.DB.prepare("INSERT INTO team_memberships (team_id, user_id, created_on) VALUES (?, ?, ?)")
      .bind(teamId, headers["x-shiplet-user-id"], new Date().toISOString())
      .run();
  }
  return teamId;
}

async function upload(projectId: string, overrides: Partial<TraceUpload> = {}) {
  const prepared = await prepareTraceUpload({
    main: parseJsonl(claudeMain),
    subagents: [{ fileName: "agent-a1.jsonl", ...parseJsonl(claudeSub) }],
    importer: "share-test",
  });
  const response = await request(`/api/shiplets/${projectId}/traces`, {
    method: "POST",
    headers: json(OWNER),
    body: JSON.stringify({ ...prepared.upload, ...overrides }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { trace: { id: string }; pendingAttachments: string[]; manifest: { attachments: Array<{ sha256: string }> } };
}

const putAudiences = (projectId: string, traceId: string, body: unknown, headers = OWNER) =>
  request(`/api/shiplets/${projectId}/traces/${traceId}/audiences`, { method: "PUT", headers: json(headers), body: JSON.stringify(body) });

async function read(projectId: string, traceId: string, headers: Record<string, string>) {
  const detail = await request(`/api/shiplets/${projectId}/traces/${traceId}`, { headers });
  if (detail.status !== 200) return { status: detail.status, level: undefined, manifest: undefined, events: [] as Array<Record<string, any>> };
  const body = (await detail.json()) as { access: { level: string }; manifest: { segments: unknown[]; summary: { filesTouched: string[] }; attachments: unknown[] } };
  const events: Array<Record<string, any>> = [];
  for (let index = 0; index < body.manifest.segments.length; index++) {
    const segment = await request(`/api/shiplets/${projectId}/traces/${traceId}/segments/${index}`, { headers });
    events.push(...((await segment.json()) as { events: Array<Record<string, any>> }).events);
  }
  return { status: 200, level: body.access.level, manifest: body.manifest, events };
}

describe("trace sharing (slice 2)", () => {
  it("gives a team Summary, an email Full, and the organization Conversation, and hides it from everyone else", async () => {
    await withTraces(async () => {
      const { organizationId, projectId } = await setup();
      const contractor = person("contractor");
      const alex = person("alex");
      const member = person("member");
      for (const headers of [contractor, alex, member]) await addMember(organizationId, headers);
      const outsider = person("outsider");
      await request("/api/me", { headers: outsider });
      const teamId = await addTeam(organizationId, [contractor, alex]);
      const { trace } = await upload(projectId);

      const shared = await putAudiences(projectId, trace.id, {
        audiences: [
          { targetType: "organization", profile: { level: "conversation" } },
          { targetType: "team", targetId: teamId, profile: { level: "summary" } },
          { targetType: "email", targetId: "ALEX@share.test", profile: { level: "full" } },
        ],
      });
      expect(shared.status).toBe(200);
      expect(await shared.json()).toMatchObject({ sharing: "shared" });

      const asMember = await read(projectId, trace.id, member);
      expect(asMember.level).toBe("conversation");
      expect(asMember.events.some((event) => event.kind === "reasoning")).toBe(false);
      expect(asMember.events.filter((event) => event.kind === "tool_result")).toHaveLength(0);
      expect(asMember.events.some((event) => event.kind === "omitted" && event.reason === "tool output hidden")).toBe(true);
      expect(asMember.events.filter((event) => event.kind === "tool_call").every((event) => !("input" in event.tool))).toBe(true);
      expect(asMember.events.some((event) => event.kind === "user_message" && event.attachmentIds?.length)).toBe(true);

      // the team is more specific than the organization, so it narrows to Summary
      const asContractor = await read(projectId, trace.id, contractor);
      expect(asContractor.level).toBe("summary");
      expect(asContractor.events).toEqual([]);
      expect(asContractor.manifest?.summary.filesTouched).toEqual(["src/orders.ts"]);
      expect(asContractor.manifest?.attachments).toEqual([]);

      // an exact email beats the team
      const asAlex = await read(projectId, trace.id, alex);
      expect(asAlex.level).toBe("full");
      expect(asAlex.events.some((event) => event.kind === "tool_result")).toBe(true);
      expect(asAlex.events.some((event) => event.kind === "reasoning")).toBe(true);

      expect((await read(projectId, trace.id, outsider)).status).toBe(404);
      expect((await read(projectId, trace.id, {})).status).toBe(404);

      const listed = await request(`/api/shiplets/${projectId}/traces`, { headers: member });
      const items = ((await listed.json()) as { traces: Array<{ id: string; access: { level: string } }> }).traces;
      expect(items).toEqual([expect.objectContaining({ id: trace.id, access: { level: "conversation", via: "audience" } })]);
    });
  });

  it("lets organization admins read shared traces in full, and hides traces made private again", async () => {
    await withTraces(async () => {
      const { organizationId, projectId } = await setup();
      const admin = person("admin");
      await addMember(organizationId, admin, "admin");
      const { trace } = await upload(projectId);
      expect((await read(projectId, trace.id, admin)).status).toBe(404);
      await putAudiences(projectId, trace.id, { audiences: [{ targetType: "organization", profile: { level: "summary" } }] });
      expect((await read(projectId, trace.id, admin)).level).toBe("full");
      const privateAgain = await putAudiences(projectId, trace.id, { sharing: "private" });
      expect(await privateAgain.json()).toMatchObject({ sharing: "private", audiences: [expect.objectContaining({ targetType: "organization" })] });
      expect((await read(projectId, trace.id, admin)).status).toBe(404);
      // sharing again restores the same audiences
      const sharedAgain = await putAudiences(projectId, trace.id, { sharing: "shared" });
      expect(await sharedAgain.json()).toMatchObject({ sharing: "shared", audiences: [expect.objectContaining({ targetType: "organization" })] });
      expect((await read(projectId, trace.id, admin)).level).toBe("full");
      // admins still cannot manage audiences
      expect((await putAudiences(projectId, trace.id, { audiences: [] }, admin)).status).toBe(404);
    });
  });

  it("shares with anyone who has the link of a public Shiplet only through a link audience", async () => {
    await withTraces(async () => {
      const { projectId } = await setup("public");
      const { trace } = await upload(projectId);
      expect((await read(projectId, trace.id, {})).status).toBe(404);
      await putAudiences(projectId, trace.id, { audiences: [{ targetType: "link", profile: { level: "summary" } }] });
      const anonymous = await read(projectId, trace.id, {});
      expect(anonymous.level).toBe("summary");
    });
  });

  it("applies custom rules and lets the owner preview a profile before sharing", async () => {
    await withTraces(async () => {
      const { organizationId, projectId } = await setup();
      const member = person("rules");
      await addMember(organizationId, member);
      const { trace } = await upload(projectId);
      const profile = {
        level: "full",
        rules: [
          { op: "mask_terms", terms: ["pagination"] },
          { op: "drop_paths", globs: ["src/**"] },
          { op: "drop_kinds", kinds: ["reasoning"] },
          { op: "drop_agents", agents: ["a1"] },
        ],
      };
      const preview = await request(`/api/shiplets/${projectId}/traces/${trace.id}/preview`, {
        method: "POST",
        headers: json(OWNER),
        body: JSON.stringify({ profile }),
      });
      expect(preview.status).toBe(200);
      const previewed = (await preview.json()) as { events: Array<Record<string, any>>; manifest: { summary: { filesTouched: string[] } } };
      const text = JSON.stringify(previewed.events);
      expect(text).not.toMatch(/pagination/i);
      expect(text).toContain("[masked]");
      expect(previewed.manifest.summary.filesTouched).toEqual([]);
      expect(previewed.events.some((event) => event.kind === "tool_call" && event.tool?.name === "Read")).toBe(false);
      expect(previewed.events.some((event) => event.kind === "reasoning")).toBe(false);
      expect(previewed.events.some((event) => event.agent === "a1" && event.kind !== "omitted")).toBe(false);
      // the Read call's result is hidden too, even though it is a separate event
      const readResult = previewed.events.find((event) => event.id && event.kind === "omitted" && event.reason === "tool output hidden");
      expect(readResult).toBeTruthy();

      await putAudiences(projectId, trace.id, { audiences: [{ targetType: "user", targetId: member["x-shiplet-user-id"], profile }] });
      const asMember = await read(projectId, trace.id, member);
      expect(JSON.stringify(asMember.events)).not.toMatch(/pagination/i);

      const invalid = await putAudiences(projectId, trace.id, {
        audiences: [{ targetType: "team", targetId: "team_missing", profile: { level: "loud" } }],
      });
      expect(invalid.status).toBe(400);
      const errors = ((await invalid.json()) as { errors: Array<{ path: string }> }).errors.map((error) => error.path);
      expect(errors).toEqual(expect.arrayContaining(["audiences[0].targetId", "audiences[0].profile.level"]));

      // replacing the set removes variants no audience uses
      await putAudiences(projectId, trace.id, { audiences: [] });
      const variants = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM trace_variants WHERE trace_id = ?").bind(trace.id).first<{ n: number }>();
      expect(variants?.n).toBe(0);
      const listed = await testEnv.REVIEW_ASSETS.list({ prefix: `traces/v1/${projectId}/${trace.id}/variants/` });
      expect(listed.objects).toHaveLength(0);
    });
  });

  it("accepts a deferred file attachment, then serves it", async () => {
    await withTraces(async () => {
      const { projectId } = await setup();
      const bytes = new Uint8Array(3 * 1024 * 1024).map((_, index) => index % 251);
      const sha256 = await sha256Hex(bytes);
      const prepared = await prepareTraceUpload({ main: parseJsonl(claudeMain), importer: "share-test" });
      const events = prepared.upload.events.map((event, index) => (index === 1 ? { ...event, attachmentIds: [...(event.attachmentIds || []), sha256] } : event));
      const created = await upload(projectId, {
        events,
        attachments: [
          ...prepared.upload.attachments,
          { sha256, mediaType: "video/mp4", bytes: bytes.byteLength, deferred: true, source: "file", name: "demo.mp4" },
        ],
      });
      expect(created.pendingAttachments).toEqual([sha256]);
      const path = `/api/shiplets/${projectId}/traces/${created.trace.id}/attachments/${sha256}`;
      const early = await request(path, { headers: OWNER });
      expect(early.status).toBe(404);
      expect(await early.json()).toMatchObject({ error: "attachment_pending" });
      const wrong = await request(path, { method: "PUT", headers: OWNER, body: new Uint8Array(10) });
      expect(wrong.status).toBe(400);
      const put = await request(path, { method: "PUT", headers: OWNER, body: bytes });
      expect(put.status).toBe(204);
      const served = await request(path, { headers: OWNER });
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("video/mp4");
      expect(served.headers.get("accept-ranges")).toBe("bytes");
      expect((await served.arrayBuffer()).byteLength).toBe(bytes.byteLength);

      // browsers seek in a video with byte ranges
      const total = bytes.byteLength;
      const ranged = async (range: string) => request(path, { headers: { ...OWNER, range } });
      const first = await ranged("bytes=0-99");
      expect(first.status).toBe(206);
      expect(first.headers.get("content-range")).toBe(`bytes 0-99/${total}`);
      expect(first.headers.get("content-length")).toBe("100");
      expect([...new Uint8Array(await first.arrayBuffer())]).toEqual([...bytes.slice(0, 100)]);
      const open = await ranged(`bytes=${total - 10}-`);
      expect(open.status).toBe(206);
      expect(open.headers.get("content-range")).toBe(`bytes ${total - 10}-${total - 1}/${total}`);
      expect([...new Uint8Array(await open.arrayBuffer())]).toEqual([...bytes.slice(total - 10)]);
      const suffix = await ranged("bytes=-5");
      expect(suffix.headers.get("content-range")).toBe(`bytes ${total - 5}-${total - 1}/${total}`);
      expect((await suffix.arrayBuffer()).byteLength).toBe(5);
      const clamped = await ranged(`bytes=${total - 2}-${total + 1000}`);
      expect(clamped.headers.get("content-range")).toBe(`bytes ${total - 2}-${total - 1}/${total}`);
      await clamped.arrayBuffer();
      const beyond = await ranged(`bytes=${total}-`);
      expect(beyond.status).toBe(416);
      expect(beyond.headers.get("content-range")).toBe(`bytes */${total}`);
      // several ranges, or nonsense, get the whole file
      const multi = await ranged("bytes=0-1,5-6");
      expect(multi.status).toBe(200);
      await multi.arrayBuffer();
      // a reader who cannot see the trace learns nothing from a range request
      expect((await request(path, { headers: { ...person("stranger"), range: "bytes=0-1" } })).status).toBe(404);
      const again = await request(path, { method: "PUT", headers: OWNER, body: bytes });
      expect(again.status).toBe(409);
      const detail = await request(`/api/shiplets/${projectId}/traces/${created.trace.id}`, { headers: OWNER });
      expect(((await detail.json()) as { trace: { pendingAttachments: number } }).trace.pendingAttachments).toBe(0);
    });
  });

  it("deletes traces of Shiplets archived more than 7 days ago", async () => {
    await withTraces(async () => {
      const { projectId } = await setup();
      const { trace } = await upload(projectId);
      const sixDays = new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString();
      await testEnv.DB.prepare("UPDATE projects SET archived_on = ? WHERE id = ?").bind(sixDays, projectId).run();
      await sweepArchivedShipletTraces(runtimeEnv);
      expect(await testEnv.DB.prepare("SELECT id FROM project_traces WHERE id = ?").bind(trace.id).first()).not.toBeNull();
      const eightDays = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
      await testEnv.DB.prepare("UPDATE projects SET archived_on = ? WHERE id = ?").bind(eightDays, projectId).run();
      await sweepArchivedShipletTraces(runtimeEnv);
      expect(await testEnv.DB.prepare("SELECT id FROM project_traces WHERE id = ?").bind(trace.id).first()).toBeNull();
      const objects = await testEnv.REVIEW_ASSETS.list({ prefix: `traces/v1/${projectId}/${trace.id}/` });
      expect(objects.objects).toHaveLength(0);
    });
  });
});
