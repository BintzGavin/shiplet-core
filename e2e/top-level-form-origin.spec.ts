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

test("an invited reviewer signs in, accepts consent with its browser-sent null Origin, and lands on the Shiplet", async ({
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

  // Signed out, the restricted Shiplet starts an ordinary sign-in: the
  // browser is sent straight to AuthKit, which is not reachable here, so the
  // journey reads the AuthKit request the browser attempted.
  const shipletPath = `/shiplets/${project.id}`;
  const authKitRequest = page.waitForRequest((request) =>
    request.url().startsWith("https://authkit.test/"),
  );
  await page
    .goto(`/auth/login?return_to=${encodeURIComponent(shipletPath)}`)
    .catch(() => undefined);
  const authorization = await authKitRequest;
  const signInStart = await authorization.redirectedFrom()?.response();
  expect(signInStart?.status()).toBe(302);
  expect(new URL(signInStart!.url()).pathname).toBe("/auth/login");
  const state = new URL(authorization.url()).searchParams.get("state");
  expect(state).toBeTruthy();

  // AuthKit returns the invitee, who is offered the named consent step.
  const code = `test-code::${encodeURIComponent(invitee.email)}`;
  const consentPage = await page.goto(
    `/auth/callback?${new URLSearchParams({ code, state: state! })}`,
  );
  await expect(page).toHaveURL(/\/auth\/login\?consent=/);
  expect(consentPage?.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(
    page.getByRole("heading", { name: `Review ${project.name}` }),
  ).toBeVisible();
  await expect(page.getByText(organization.name)).toBeVisible();

  const consentPosts = recordFormPosts(page, "/auth/login");
  await page
    .getByRole("button", { name: "Accept invitation and open Shiplet" })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`${shipletPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[/?#])`),
  );
  await expect(page.getByText("Control-plane origin required")).toHaveCount(0);
  await expect(page.getByText("Invitation consent origin denied")).toHaveCount(
    0,
  );
  await expect(page.getByText(project.name).first()).toBeVisible();

  // The browser condition behind the original defect still holds: the
  // consent POST is a same-origin top-level navigation whose Origin is
  // "null" because the consent page uses no-referrer.
  const posts = await consentPosts();
  expect(posts).toHaveLength(1);
  const [post] = posts;
  expect(post.headers.origin).toBe("null");
  expect(post.headers["sec-fetch-site"]).toBe("same-origin");
  expect(post.headers["sec-fetch-mode"]).toBe("navigate");
  expect(post.headers["sec-fetch-dest"]).toBe("document");
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
