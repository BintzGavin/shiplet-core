import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { normalizeEmbedReviewPageUrl } from "../src/embed";

const owner = {
  "x-shiplet-user-id": "user_embed_editor",
  "x-shiplet-user-email": "embed-editor@example.com",
};
async function request(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(`http://localhost${path}`, init),
    env as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
async function project() {
  const org = await request("/api/organizations", {
    method: "POST",
    headers: { ...owner, "Content-Type": "application/json" },
    body: JSON.stringify({ name: `Embed tests ${crypto.randomUUID()}` }),
  });
  const { organization } = (await org.json()) as any;
  const result = await request("/api/shiplets", {
    method: "POST",
    headers: { ...owner, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Website",
      organization_id: organization.id,
      subdomain: `embed-${crypto.randomUUID().slice(0, 8)}`,
      external_url: "https://example.com/",
    }),
  });
  expect(result.status).toBe(201);
  return ((await result.json()) as any).project.id as string;
}
function form(projectId: string, origin = "https://example.com", extra = {}) {
  return {
    method: "POST",
    headers: { ...owner, Origin: "http://localhost" },
    body: new URLSearchParams({
      project_id: projectId,
      site_url: origin,
      ...extra,
    }),
  };
}
describe("framework-independent widget installation", () => {
  it("keeps hash-router pages distinct while removing credential-shaped fragment values", () => {
    expect(
      normalizeEmbedReviewPageUrl(
        "https://example.com/#/pricing?plan=team&access_token=private",
        "https://example.com",
      ),
    ).toBe("https://example.com/#/pricing?plan=team");
    expect(
      normalizeEmbedReviewPageUrl(
        "https://example.com/#access_token=private",
        "https://example.com",
      ),
    ).toBe("https://example.com/");
  });
  it("offers website connection and labels URL proxying experimental, with a complete public install guide", async () => {
    const html = await (await request("/", { headers: owner })).text();
    expect(html).toContain('href="/embed/install"');
    expect(html).toContain("Connect a website");
    expect(html).toContain("Experimental URL preview");
    const guide = await request("/docs/embed");
    expect(guide.status).toBe(200);
    const docs = await guide.text();
    for (const text of [
      "installation-id",
      "Paste this into your agent",
      "Content Security Policy",
      "React",
      "Disconnect",
      "third-party",
      "data-shiplet-private",
    ])
      expect(docs).toContain(text);
    expect((await request("/docs/wordpress")).headers.get("location")).toBe(
      "/docs/embed",
    );
  });
  it("registers, lists, reuses, and revokes an editor-owned installation without exposing a secret", async () => {
    const id = await project();
    const response = await request("/embed/install", form(id));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("shiplet-feedback");
    expect(html).toContain("/api/embed/widget.js");
    expect(html).not.toContain("shiplet_embed_install_");
    const installation = (await (env as Env).DB.prepare(
      "SELECT id FROM embed_installations WHERE project_id = ? AND revoked_on IS NULL",
    )
      .bind(id)
      .first<{ id: string }>())!;
    expect(installation).toBeTruthy();
    expect(
      await (
        await request(`/embed/install?project_id=${id}`, { headers: owner })
      ).text(),
    ).toContain(installation.id);
    await request("/embed/install", form(id));
    expect(
      (
        await (env as Env).DB.prepare(
          "SELECT COUNT(*) AS count FROM embed_installations WHERE project_id = ? AND revoked_on IS NULL",
        )
          .bind(id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    const revoked = await request(
      "/embed/install",
      form(id, "https://example.com", {
        action: "revoke",
        installation_id: installation.id,
      }),
    );
    expect(revoked.status).toBe(200);
    expect(
      (
        await (env as Env).DB.prepare(
          "SELECT revoked_on FROM embed_installations WHERE id = ?",
        )
          .bind(installation.id)
          .first<any>()
      )?.revoked_on,
    ).toBeTruthy();
  });
  it("rejects foreign origins, unsafe sites, and users without edit access", async () => {
    const id = await project();
    expect(
      (
        await request("/embed/install", {
          ...form(id),
          headers: { ...owner, Origin: "https://attacker.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await request("/embed/install", form(id, "http://example.com"))).status,
    ).toBe(400);
    expect(
      (
        await request("/embed/install", {
          ...form(id),
          headers: {
            Origin: "http://localhost",
            "x-shiplet-user-id": "user_embed_stranger",
            "x-shiplet-user-email": "stranger@example.com",
          },
        })
      ).status,
    ).toBe(403);
  });
  it("does not disconnect another project's installation for the same origin", async () => {
    const first = await project();
    const second = await project();
    await request("/embed/install", form(first));
    await request("/embed/install", form(second));
    for (const id of [first, second])
      expect(
        (
          await (env as Env).DB.prepare(
            "SELECT COUNT(*) AS count FROM embed_installations WHERE project_id = ? AND revoked_on IS NULL",
          )
            .bind(id)
            .first<any>()
        )?.count,
      ).toBe(1);
  });
  it("keeps sign-in handoff single-use and confined to Shiplet's origin", async () => {
    const id = await project();
    await request("/embed/install", form(id));
    const installation = (await (env as Env).DB.prepare(
      "SELECT id FROM embed_installations WHERE project_id = ? AND revoked_on IS NULL",
    )
      .bind(id)
      .first<{ id: string }>())!;
    const path = `/embed/review/authorize?installation_id=${installation.id}&return_url=${encodeURIComponent("https://example.com/pricing")}`;
    const authorization = await request(path, { headers: owner });
    expect(authorization.status).toBe(200);
    expect(authorization.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    const html = await authorization.text();
    const ticket = html.match(/shiplet_embed_auth_[A-Za-z0-9_-]+/)![0];
    const redeem = (origin: string) =>
      request("/embed/review/authorize", {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ installation_id: installation.id, ticket }),
      });
    expect((await redeem("https://example.com")).status).toBe(403);
    const exchanged = await redeem("http://localhost");
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers.get("set-cookie")).toContain("HttpOnly");
    expect(exchanged.headers.get("set-cookie")).toContain("Partitioned");
    const result = (await exchanged.json()) as any;
    expect(Object.keys(result)).toEqual(["hostUrl"]);
    const originalExpiry = new Date(Date.now() + 60_000).toISOString();
    await (env as Env).DB.prepare(
      "UPDATE embed_review_sessions SET expires_on = ? WHERE installation_id = ?",
    )
      .bind(originalExpiry, installation.id)
      .run();
    const navigated = await request(
      `/embed/review/start?installation_id=${installation.id}&return_url=${encodeURIComponent("https://example.com/next")}`,
      {
        headers: {
          Cookie: exchanged.headers.get("set-cookie")!.split(";", 1)[0],
        },
      },
    );
    expect(navigated.status).toBe(302);
    expect(navigated.headers.get("location")).toContain("/embed/review/host");
    const renewed = await (env as Env).DB.prepare(
      "SELECT MAX(expires_on) AS expires_on FROM embed_review_sessions WHERE installation_id = ?",
    )
      .bind(installation.id)
      .first<{ expires_on: string }>();
    expect(renewed?.expires_on).toBe(originalExpiry);
    expect((await redeem("http://localhost")).status).toBe(403);
  });
});
