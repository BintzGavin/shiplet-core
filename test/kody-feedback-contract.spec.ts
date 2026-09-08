import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";

const owner = {
  "x-shiplet-user-id": "kody_contract_owner",
  "x-shiplet-user-email": "owner@example.test",
};
async function request(path: string, body?: unknown, headers = owner) {
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
async function setup() {
  const { organization } = (await (
    await request("/api/organizations", { name: `Kody contract ${crypto.randomUUID()}` })
  ).json()) as any;
  const { project } = (await (
    await request("/api/shiplets", {
      name: "Review",
      organization_id: organization.id,
      subdomain: `kody-${crypto.randomUUID().slice(0, 8)}`,
      visibility: "private",
      assets: [{ path: "index.html", content: btoa("<h1>Review</h1>") }],
    })
  ).json()) as any;
  const { revision } = (await (await request(`/api/shiplets/${project.id}/package`)).json()) as any;
  return { project, revision };
}
async function feedback(project: any, n: number) {
  return (
    (await (
      await request(`/api/projects/${project.id}/review-feedback`, {
        clientFeedbackId: `fixture-feedback-${n}`,
        comment: `Improve section ${n}`,
        pageUrl: `http://localhost/shiplets/${project.id}/review-host`,
        captureContext: { revisionId: "untrusted-client-claim" },
      })
    ).json()) as any
  ).feedback;
}
async function mcp(path: string, query: Record<string, unknown>) {
  const result = (await (
    await request("/api/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "execute",
        arguments: {
          code: `async () => await codemode.request(${JSON.stringify({ method: "GET", path, query })})`,
        },
      },
    })
  ).json()) as any;
  return result.error ?? JSON.parse(result.result.content[0].text);
}
describe("Kody feedback completeness and provenance", () => {
  it("pages tied timestamps without losing tickets; binds cursor to project and filters across HTTP and MCP", async () => {
    const { project, revision } = await setup();
    const tickets = [];
    for (let n = 0; n < 5; n++) tickets.push(await feedback(project, n));
    await (env as Env).DB.prepare("UPDATE review_feedback SET created_on = ? WHERE project_id = ?")
      .bind("2026-09-08T12:00:00Z", project.id)
      .run();
    const path = `/api/projects/${project.id}/review-feedback`;
    const first = await mcp(path, { limit: 2, status: "New", revisionId: revision.id });
    expect(first.feedback.map((f: any) => f.id)).toEqual(
      tickets
        .slice(3)
        .reverse()
        .map((f) => f.id),
    );
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.feedback[0].source_revision_id).toBe(revision.id);
    const second = (await (
      await request(
        `${path}?limit=2&status=New&revisionId=${revision.id}&cursor=${encodeURIComponent(first.nextCursor)}`,
      )
    ).json()) as any;
    const third = await mcp(path, {
      limit: 2,
      status: "New",
      revisionId: revision.id,
      cursor: second.nextCursor,
    });
    expect([...first.feedback, ...second.feedback, ...third.feedback].map((f) => f.id)).toEqual(
      tickets.reverse().map((f) => f.id),
    );
    expect(third.nextCursor).toBeNull();
    expect(
      (await request(`${path}?status=Done&cursor=${encodeURIComponent(first.nextCursor)}`)).status,
    ).toBe(400);
    const other = await setup();
    expect(
      (
        await request(
          `/api/projects/${other.project.id}/review-feedback?cursor=${encodeURIComponent(first.nextCursor)}`,
        )
      ).status,
    ).toBe(400);
  });
  it("returns explicit empty pages, rejects malformed filters, and scopes item provenance", async () => {
    const { project } = await setup();
    const path = `/api/projects/${project.id}/review-feedback`;
    expect(await mcp(path, {})).toEqual({ feedback: [], nextCursor: null });
    for (const query of ["limit=NaN", "limit=0", "status=bogus", "cursor=bogus"]) {
      expect((await request(`${path}?${query}`)).status).toBe(400);
    }
    const ticket = await feedback(project, 1);
    const original = await mcp(path, {});
    expect(original.feedback[0].source_revision_id).not.toBe("untrusted-client-claim");
    await request(`${path}/${ticket.id}/status`, { status: "Done" });
    expect((await mcp(path, {})).feedback).toEqual([]);
    expect((await mcp(path, { status: "Done" })).feedback.map((f: any) => f.id)).toEqual([
      ticket.id,
    ]);
    expect((await mcp(path, { includeClosed: true })).feedback).toHaveLength(1);
    expect(
      (await mcp(path, { includeClosed: true, pageUrl: "https://different.test/path" })).feedback,
    ).toEqual([]);
    expect(
      (await mcp(path, { includeClosed: true, revisionId: "revision_unknown" })).feedback,
    ).toEqual([]);
    const other = await setup();
    const result = await mcp(`/api/projects/${other.project.id}/review-feedback/${ticket.id}`, {});
    expect(result.feedback).toBeNull();
  });
});
