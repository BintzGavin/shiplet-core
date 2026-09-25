import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import {
  inviteLinksEndpoint,
  type InviteLinkResponse,
  type InviteLinkView,
  type WorkspaceInviteLinksSeed,
} from "../src/platform/invite-links-types";

type Actor = {
  "x-shiplet-user-id": string;
  "x-shiplet-user-email": string;
};

const JSON_HEADERS = { "Content-Type": "application/json" };

function person(label: string): Actor {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return {
    "x-shiplet-user-id": `user_workspace_links_${label}_${suffix}`,
    "x-shiplet-user-email": `workspace-links-${label}-${suffix}@example.com`,
  };
}

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

async function createOrganization(
  actor: Actor,
  name = `Workspace links ${crypto.randomUUID()}`,
) {
  const response = await request("/api/organizations", {
    method: "POST",
    headers: { ...JSON_HEADERS, ...actor },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as {
    organization: { id: string; name: string };
  }).organization;
}

async function createLink(
  organizationId: string,
  actor: Actor,
  body: Record<string, unknown> = {},
) {
  const response = await request(inviteLinksEndpoint(organizationId), {
    method: "POST",
    headers: { ...JSON_HEADERS, ...actor },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as InviteLinkResponse).link;
}

function tokenOf(link: InviteLinkView) {
  return new URL(link.url).pathname.split("/").pop() as string;
}

async function openPage(path: string, actor: Actor) {
  const response = await request(path, { headers: actor });
  return { response, html: await response.text() };
}

/** The server-rendered `#inviteLinks` section, up to its closing tag. */
function inviteLinksSection(html: string) {
  const start = html.indexOf('id="inviteLinks"');
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

function inviteLinksSeed(html: string) {
  const match = html.match(
    /<script\b[^>]*\bid="shiplet-platform-invite-links-state"[^>]*>([\s\S]*?)<\/script>/,
  );
  expect(match).toBeTruthy();
  return JSON.parse((match as RegExpMatchArray)[1]) as {
    route: string;
    seed: WorkspaceInviteLinksSeed;
  };
}

function selectMarkup(html: string, id: string) {
  const match = html.match(
    new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`),
  );
  expect(match, id).toBeTruthy();
  return (match as RegExpMatchArray)[1];
}

describe("workspace invite links island", () => {
  it("server-renders an administrator's empty invite links section with its seed and client script", async () => {
    const admin = person("empty");
    const organization = await createOrganization(admin);

    const { response, html } = await openPage("/workspace", admin);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain('id="invite-links-platform-root"');
    expect(html).toContain('id="shiplet-platform-invite-links-state"');
    expect(html).toContain('src="/assets/platform/invite-links.js"');
    const section = inviteLinksSection(html);
    expect(section).toContain(
      `data-invite-links-organization="${organization.id}"`,
    );
    expect(section).toContain(organization.name);
    expect(section).toContain('id="inviteLinkForm"');
    expect(section).toContain("No invite links yet");
    expect(inviteLinksSeed(html).route).toBe("workspace");
  });

  it("preselects a 30-day expiry and unlimited uses on first paint while still offering links that never expire", async () => {
    const admin = person("defaults");
    await createOrganization(admin);

    const { html } = await openPage("/workspace", admin);

    const expires = selectMarkup(html, "inviteLinkExpires");
    expect(expires).toMatch(/<option value="30" selected="">In 30 days<\/option>/);
    expect(expires).toContain('<option value="never">Never</option>');
    expect(expires.match(/selected=""/g)).toHaveLength(1);
    expect(selectMarkup(html, "inviteLinkUses")).toMatch(
      /<option value="unlimited" selected="">Unlimited<\/option>/,
    );
  });

  it("server-renders a created link's URL in the section and the seed without a loading state", async () => {
    const admin = person("created");
    const organization = await createOrganization(admin);
    const link = await createLink(organization.id, admin, { maxUses: 5 });

    const { response, html } = await openPage("/workspace", admin);

    expect(response.status).toBe(200);
    const section = inviteLinksSection(html);
    expect(section).toContain(`<code class="invite-link-url">${link.url}</code>`);
    expect(section).toContain(`data-invite-link-id="${link.id}"`);
    expect(section).toContain("0 of 5 used");
    expect(section).not.toContain("No invite links yet");
    expect(section).not.toMatch(/loading/i);
    const { seed } = inviteLinksSeed(html);
    expect(
      seed.linksByOrganization[organization.id].map((seeded) => seeded.url),
    ).toEqual([link.url]);
  });

  it("tells a plain member that only administrators create invite links and shows them no join links", async () => {
    const owner = person("owner");
    const member = person("member");
    const organization = await createOrganization(owner);
    const link = await createLink(organization.id, owner);
    const accepted = await request(new URL(link.url).pathname, {
      method: "POST",
      headers: member,
    });
    expect(accepted.status).toBe(303);

    const { response, html } = await openPage("/workspace", member);

    expect(response.status).toBe(200);
    const section = inviteLinksSection(html);
    expect(section).toContain(
      "Only organization administrators can create invite links.",
    );
    expect(section).not.toContain('id="inviteLinkForm"');
    expect(html).not.toContain("/join/");
    expect(html).not.toContain(tokenOf(link));
    const { seed } = inviteLinksSeed(html);
    expect(seed.rolesByOrganization[organization.id]).toBe("member");
    expect(seed.linksByOrganization[organization.id]).toEqual([]);
  });

  it("renders the invite links island only on the workspace page", async () => {
    const admin = person("routes");
    const organization = await createOrganization(admin);
    const link = await createLink(organization.id, admin);

    for (const path of ["/account", "/access", "/agents"]) {
      const { response, html } = await openPage(path, admin);

      expect(response.status, path).toBe(200);
      expect(html, path).not.toContain("invite-links-platform-root");
      expect(html, path).not.toContain("shiplet-platform-invite-links-state");
      expect(html, path).not.toContain("/assets/platform/invite-links.js");
      expect(html, path).not.toContain(tokenOf(link));
    }
  });

  it("serves the invite links client bundle as browser JavaScript that hydrates the island", async () => {
    const response = await request("/assets/platform/invite-links.js");
    const source = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/javascript",
    );
    expect(source).toContain("hydrateRoot");
    expect(source).toContain("invite-links-platform-root");
    expect(source).toContain("shiplet-platform-invite-links-state");
    expect(source).not.toContain("process.env.NODE_ENV");
  });

  it("selects the first organization in the seed, on first paint, and in the workspace switcher alike", async () => {
    const admin = person("switcher");
    const first = await createOrganization(admin);
    const second = await createOrganization(admin);

    const { html } = await openPage("/workspace", admin);

    const { seed } = inviteLinksSeed(html);
    expect(seed.organizations.map((organization) => organization.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(seed.selectedOrganizationId).toBe(seed.organizations[0].id);
    expect(inviteLinksSection(html)).toContain(
      `data-invite-links-organization="${seed.selectedOrganizationId}"`,
    );
    const dashboard = await request("/api/dashboard", { headers: admin });
    expect(dashboard.status).toBe(200);
    const dashboardBody = (await dashboard.json()) as {
      organizations: Array<{ id: string }>;
    };
    expect(dashboardBody.organizations[0].id).toBe(seed.selectedOrganizationId);
  });

  it("escapes an organization name that tries to break out of the seed script", async () => {
    const admin = person("escape");
    const hostileName = "Acme </script><script>alert(1)</script> & <b>";
    const organization = await createOrganization(admin, hostileName);

    const { html } = await openPage("/workspace", admin);

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(inviteLinksSection(html)).toContain(
      "Acme &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;",
    );
    expect(inviteLinksSeed(html).seed.organizations).toContainEqual({
      id: organization.id,
      name: hostileName,
    });
  });

  it("marks every response that carries a join link as not cacheable", async () => {
    const admin = person("no-store-admin");
    const organization = await createOrganization(admin);
    const link = await createLink(organization.id, admin, { maxUses: 3 });

    // The workspace page and the invite-links API embed live join URLs, so
    // browsers, the back-forward cache, and shared caches must not keep them.
    const page = await request("/workspace", { headers: admin });
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toContain("no-store");

    const list = await request(inviteLinksEndpoint(organization.id), {
      headers: admin,
    });
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toContain("no-store");

    const created = await request(inviteLinksEndpoint(organization.id), {
      method: "POST",
      headers: { ...JSON_HEADERS, ...admin },
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toContain("no-store");

    const revoked = await request(
      `${inviteLinksEndpoint(organization.id)}/${encodeURIComponent(link.id)}`,
      { method: "DELETE", headers: admin },
    );
    expect(revoked.status).toBe(200);
    expect(revoked.headers.get("cache-control")).toContain("no-store");
  });

  it("skips the invite links island entirely for a person without organizations", async () => {
    const { response, html } = await openPage("/workspace", person("no-orgs"));

    expect(response.status).toBe(200);
    expect(html).not.toContain('id="inviteLinks"');
    // Nothing to show, so the page also skips the root, the seed, and the
    // island bundle download.
    expect(html).not.toContain('id="invite-links-platform-root"');
    expect(html).not.toContain('id="shiplet-platform-invite-links-state"');
    expect(html).not.toContain('src="/assets/platform/invite-links.js"');
  });
});
