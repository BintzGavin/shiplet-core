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

function expectStyledReviewPage(response: Response, html: string) {
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(html).toContain('data-shiplet-access-page="v1"');
  expect(html).toContain('name="viewport"');
  const nonce = html.match(/<style nonce="([^"]+)">/)?.[1];
  expect(nonce).toBeTruthy();
  expect(response.headers.get("content-security-policy")).toContain(`style-src 'nonce-${nonce}'`);
  expect(response.headers.get("content-security-policy")).toContain("style-src-attr 'none'");
  expect(html).toContain("font-family:");
  expect(html).toContain("min-height: 44px");
}

async function reviewInstallation() {
  const id = await project();
  await request("/embed/install", form(id));
  return (await (env as Env).DB.prepare(
    "SELECT id FROM embed_installations WHERE project_id = ? AND revoked_on IS NULL",
  ).bind(id).first<{ id: string }>())!;
}

describe("framework-independent widget installation", () => {
  it("[T2] confines outer dock and visibility synchronization to bounded presentation state", async () => {
    const script = await (await request("/api/embed/widget.js")).text();
    const styles = await (await request("/api/embed/widget.css")).text();

    expect(script).toContain('shiplet.embed.presentation.v1');
    expect(script).toContain("allowedDocks");
    for (const dock of ["top-left", "top-right", "bottom-left", "bottom-right"]) expect(script).toContain(dock);
    expect(styles).toContain(':host([data-dock=top-left])');
    expect(styles).toContain(':host([data-dock=bottom-left])');
    expect(script).not.toContain('data.draft');
    expect(script).not.toContain('data.recipients');
  });
  it("serves stable-ticket contextual pin assets without moving write controls into the page", async () => {
    const script = await (await request("/api/embed/widget.js")).text();
    const styles = await (await request("/api/embed/widget.css")).text();

    expect(script).toContain("feedbackId");
    expect(script).toContain("ticket");
    expect(script).toContain('protocol: "shiplet.embed.focus.v1"');
    expect(script).toContain('["toolbar", "comments", "thread"');
    expect(script).toContain('id="shiplet-embedded-review-surface"');
    expect(script).toContain("items.slice(0, 250)");
    expect(script).toContain("item.index >= 1000000");
    expect(script).not.toContain("items.slice(0, 100)");
    expect(script).toContain(
      'button.setAttribute("aria-controls", "shiplet-embedded-review-surface")',
    );
    expect(script).not.toContain("review-feedback/replies");
    expect(script).not.toContain("Confirm reply");
    expect(styles).toContain(".surface[data-view=thread]");
  });

  it("shows the regular Annotate toolbar while signed out, without a nested login panel", async () => {
    const installation = await reviewInstallation();
    const response = await request(`/embed/review/start?${new URLSearchParams({
      installation_id: installation.id,
      return_url: "https://example.com/pricing",
    })}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('class="shiplet-review-launcher"');
    expect(html).toContain('data-shiplet-embed-action="annotate"');
    expect(html).toContain('data-shiplet-embed-action="comments"');
    expect(html).toContain(">Annotate</button>");
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("Open secure Shiplet sign-in");
    expect(html).toContain("/api/review/host.css");
    expect(response.headers.get("content-security-policy")).toContain("style-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'self' https://example.com");
    expect(html).not.toContain("shiplet_embed_auth_");
  });

  it("explains denied access and offers an account switch without granting the wrong account access", async () => {
    const installation = await reviewInstallation();
    const path = `/embed/review/authorize?${new URLSearchParams({
      installation_id: installation.id,
      return_url: "https://example.com/pricing?plan=team",
    })}`;
    const response = await request(path, { headers: {
      "x-shiplet-user-id": "user_embed_wrong_account",
      "x-shiplet-user-email": "wrong-account@example.com",
    } });
    expect(response.status).toBe(403);
    const html = await response.text();
    expectStyledReviewPage(response, html);
    expect(html).toContain("wrong-account@example.com");
    expect(html).toContain("Sign in with another account");
    expect(html).toContain("Ask the owner to invite this account");
    expect(html).not.toContain("shiplet_embed_auth_");
    const switchPath = html.match(/href="([^"]+switch_account=1[^"]*)"/)?.[1]?.replaceAll("&amp;", "&");
    expect(switchPath).toBeTruthy();
    const login = await request(switchPath!);
    expect(login.status).toBe(302);
    const destination = new URL(login.headers.get("location")!);
    expect(destination.origin).toBe("https://authkit.test");
    expect(destination.searchParams.get("prompt")).toBe("login");
    const state = JSON.parse(atob(destination.searchParams.get("state")!));
    expect(state.returnTo).toBe(path);
    expect(state.returnTo).not.toContain("switch_account");
  });

  it("keeps account switching bound to a valid installation and exact registered return origin", async () => {
    const installation = await reviewInstallation();
    for (const [id, returnUrl] of [
      [installation.id, "https://example.com.attacker.test/pricing"],
      ["missing-installation", "https://example.com/pricing"],
    ]) {
      const response = await request(`/embed/review/authorize?${new URLSearchParams({
        installation_id: id,
        return_url: returnUrl,
        switch_account: "1",
      })}`);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers.get("location")).toBeNull();
      expectStyledReviewPage(response, await response.text());
    }
  });
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
  it("accepts same-origin top-level setup forms whose no-referrer Origin is null", async () => {
    const id = await project();
    const page = await request(`/embed/install?project_id=${id}`, {
      headers: { ...owner, Accept: "text/html" },
    });
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const nullOriginForm = (extra = {}) => {
      const init = form(id, "https://example.com", extra);
      return {
        ...init,
        headers: {
          ...owner,
          Origin: "null",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
        },
      };
    };
    const created = await request("/embed/install", nullOriginForm());
    expect(created.status).toBe(200);
    expect(await created.text()).toContain("shiplet-feedback");
    const installation = (await (env as Env).DB.prepare(
      "SELECT id FROM embed_installations WHERE project_id = ? AND revoked_on IS NULL",
    )
      .bind(id)
      .first<{ id: string }>())!;
    expect(installation).toBeTruthy();
    const revoked = await request(
      "/embed/install",
      nullOriginForm({ action: "revoke", installation_id: installation.id }),
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.text()).toContain("Site disconnected");
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
  it("rejects null-Origin setup forms that are not same-origin top-level navigations", async () => {
    const topLevelSameOrigin = {
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    };
    const variants: Array<[string, Record<string, string>]> = [
      ["no fetch metadata", {}],
      // A sandboxed artifact frame has an opaque origin, so the browser
      // labels its form submission cross-site even on Shiplet's host.
      [
        "sandboxed or foreign frame",
        { ...topLevelSameOrigin, "Sec-Fetch-Site": "cross-site" },
      ],
      ["same-site", { ...topLevelSameOrigin, "Sec-Fetch-Site": "same-site" }],
      ["iframe", { ...topLevelSameOrigin, "Sec-Fetch-Dest": "iframe" }],
      ["fetch", { ...topLevelSameOrigin, "Sec-Fetch-Mode": "cors" }],
    ];
    const activeCount = async (projectId: string) =>
      (
        await (env as Env).DB.prepare(
          "SELECT COUNT(*) AS count FROM embed_installations WHERE project_id = ? AND revoked_on IS NULL",
        )
          .bind(projectId)
          .first<{ count: number }>()
      )?.count;

    const createId = await project();
    for (const [label, fetchMetadata] of variants) {
      const response = await request("/embed/install", {
        ...form(createId),
        headers: { ...owner, Origin: "null", ...fetchMetadata },
      });
      expect(response.status, label).toBe(403);
    }
    const originless = await request("/embed/install", {
      ...form(createId),
      headers: { ...owner, ...topLevelSameOrigin },
    });
    expect(originless.status).toBe(403);
    expect(await activeCount(createId)).toBe(0);

    const revokeId = await project();
    await request("/embed/install", form(revokeId));
    const installation = (await (env as Env).DB.prepare(
      "SELECT id FROM embed_installations WHERE project_id = ? AND revoked_on IS NULL",
    )
      .bind(revokeId)
      .first<{ id: string }>())!;
    expect(installation).toBeTruthy();
    for (const [label, fetchMetadata] of variants) {
      const response = await request("/embed/install", {
        ...form(revokeId, "https://example.com", {
          action: "revoke",
          installation_id: installation.id,
        }),
        headers: { ...owner, Origin: "null", ...fetchMetadata },
      });
      expect(response.status, label).toBe(403);
    }
    expect(await activeCount(revokeId)).toBe(1);
  });
  it("does not disconnect another project's installation for the same origin", async () => {
    const first = await project();
    const second = await project();
    await request("/embed/install", form(first));
    await request("/embed/install", form(second));
    // Rolling back the Worker must not fail its previous schema initializer
    // after two projects have connected the same host origin.
    await expect(
      (env as Env).DB.prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_embed_installations_active_origin ON embed_installations(site_origin) WHERE revoked_on IS NULL`,
      ).run(),
    ).resolves.toBeTruthy();
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
    expectStyledReviewPage(authorization, html);
    expect(html).toContain('href="https://example.com/pricing"');
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
