import { expect, test, type Page, type Request } from "@playwright/test";
import {
  authHeaders,
  createOrganization,
  loginAs,
  publishStaticShiplet,
  testUser,
} from "./helpers";

// Shiplet serves sign-in, consent, and website setup pages with
// `Referrer-Policy: no-referrer`. Chrome then serializes the Origin of the
// pages' own same-origin form submissions as the literal string "null". These
// journeys run the real forms in a real browser so the server's origin guard
// is exercised against what the browser actually sends.

type RecordedFormPost = {
  headers: Record<string, string>;
  body: string;
};

function recordFormPosts(page: Page, pathname: string) {
  const posts: Promise<RecordedFormPost>[] = [];
  page.on("request", (request: Request) => {
    if (request.method() !== "POST") return;
    if (new URL(request.url()).pathname !== pathname) return;
    posts.push(
      request
        .allHeaders()
        .then((headers) => ({ headers, body: request.postData() || "" })),
    );
  });
  return () => Promise.all(posts);
}

test("an invited reviewer's consent form is accepted with its browser-sent null Origin", async ({
  page,
  request,
}) => {
  const owner = testUser("consent-owner");
  const invitee = testUser("consent-invitee");
  const organization = await createOrganization(request, owner);
  const { project } = await publishStaticShiplet(
    request,
    owner,
    organization.id,
  );
  const invitation = await request.post(
    `/api/projects/${encodeURIComponent(project.id)}/invitations`,
    {
      headers: {
        ...authHeaders(owner),
        Origin: "http://localhost:8787",
      },
      data: { targetType: "user", email: invitee.email, role: "viewer" },
    },
  );
  expect(invitation.status()).toBe(201);

  await page.route("https://authkit.test/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>AuthKit stub</title><h1>AuthKit stub</h1>",
    }),
  );
  const consentPosts = recordFormPosts(page, "/auth/login");
  // Chrome abandons this POST when it refuses the redirect, so Playwright
  // never sees its network-stage headers; read them from DevTools instead.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const sentHeaders = new Map<string, Record<string, string>>();
  const sentUrls = new Map<string, string>();
  cdp.on("Network.requestWillBeSent", (event) => {
    sentUrls.set(event.requestId, `${event.request.method} ${event.request.url}`);
  });
  cdp.on("Network.requestWillBeSentExtraInfo", (event) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(event.headers))
      headers[name.toLowerCase()] = String(value);
    sentHeaders.set(event.requestId, headers);
  });
  const networkPostHeaders = () =>
    [...sentUrls.entries()]
      .filter(([, line]) => line === "POST http://localhost:8787/auth/login")
      .map(([requestId]) => sentHeaders.get(requestId) || {});

  const shipletPath = `/shiplets/${project.id}`;
  const consentPage = await page.goto(
    `/auth/login?return_to=${encodeURIComponent(shipletPath)}`,
  );
  expect(consentPage?.headers()["referrer-policy"]).toBe("no-referrer");
  const submitted = page.waitForEvent("requestfinished", {
    predicate: (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/auth/login",
  }).catch(() => undefined);
  const blocked = page.waitForEvent("requestfailed", {
    predicate: (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/auth/login",
  }).catch(() => undefined);
  await page
    .getByRole("button", { name: "Sign in and accept invitation" })
    .click();
  await Promise.race([submitted, blocked]);
  await expect(page.getByText("Control-plane origin required")).toHaveCount(0);
  await expect(page.getByText("Invitation consent origin denied")).toHaveCount(
    0,
  );

  // The browser condition behind the defect: the consent POST is a
  // same-origin top-level navigation whose Origin is "null" because the
  // consent page uses no-referrer.
  const posts = await consentPosts();
  expect(posts).toHaveLength(1);
  const [post] = posts;
  expect(post.headers.origin).toBe("null");
  await expect.poll(() => networkPostHeaders().length).toBe(1);
  const [sent] = networkPostHeaders();
  expect(sent.origin).toBe("null");
  expect(sent["sec-fetch-site"]).toBe("same-origin");
  expect(sent["sec-fetch-mode"]).toBe("navigate");
  expect(sent["sec-fetch-dest"]).toBe("document");

  // Chrome stops following the server's cross-origin redirect to AuthKit
  // under the page's `form-action 'self'` policy, so replay the exact request
  // the browser sent to observe the server's answer, then finish sign-in.
  const replay = await page.request.post("/auth/login", {
    headers: {
      "content-type": sent["content-type"],
      origin: sent.origin,
      "sec-fetch-site": sent["sec-fetch-site"],
      "sec-fetch-mode": sent["sec-fetch-mode"],
      "sec-fetch-dest": sent["sec-fetch-dest"],
    },
    data: post.body,
    maxRedirects: 0,
  });
  expect(replay.status()).toBe(302);
  const authorization = new URL(replay.headers().location || "");
  expect(authorization.origin).toBe("https://authkit.test");
  const state = authorization.searchParams.get("state");
  expect(state).toBeTruthy();

  const code = `test-code::${encodeURIComponent(invitee.email)}`;
  const callback = await page.goto(
    `/auth/callback?${new URLSearchParams({ code, state: state! })}`,
  );
  expect(callback?.status()).toBeLessThan(400);
  await expect(page).toHaveURL(
    new RegExp(`${shipletPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[/?#])`),
  );
  await expect(page.getByText("Control-plane origin required")).toHaveCount(0);
});

test("an editor can create and disconnect a website install from the setup page", async ({
  page,
  request,
}) => {
  const owner = testUser("embed-setup-owner");
  const organization = await createOrganization(request, owner);
  const { project } = await publishStaticShiplet(
    request,
    owner,
    organization.id,
  );
  await loginAs(page, owner);
  const setupPosts = recordFormPosts(page, "/embed/install");

  const setupPage = await page.goto(`/embed/install?project_id=${project.id}`);
  expect(setupPage?.headers()["referrer-policy"]).toBe("no-referrer");
  await page.getByLabel("Site URL").fill("http://127.0.0.1:8799");
  await page.getByRole("button", { name: "Create install snippet" }).click();
  await expect(page.getByText("Control-plane origin required")).toHaveCount(0);
  const snippet = page.getByLabel("Install snippet");
  await expect(snippet).toBeVisible();
  expect(await snippet.inputValue()).toContain("shiplet-feedback");

  await page.getByRole("button", { name: "Disconnect this site" }).click();
  await expect(
    page.getByText("Site disconnected. Its feedback stays in Shiplet."),
  ).toBeVisible();
  await expect(page.getByLabel("Install snippet")).toHaveCount(0);

  const origins = (await setupPosts()).map((post) => post.headers.origin);
  expect(origins).toEqual(["null", "null"]);
});
