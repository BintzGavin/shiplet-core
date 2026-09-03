import { createHash } from "node:crypto";

import { expect, test } from "@playwright/test";

import {
  authHeaders,
  createOrganization,
  loginAs,
  publishStaticShiplet,
  testUser,
} from "./helpers";

type PortableFile = {
  path: string;
  mediaType: string;
  encoding: "utf8" | "base64";
  content: string;
  sha256: string;
  size: number;
};

function replaceFile(files: PortableFile[], path: string, content: string) {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Missing portable file ${path}`);
  file.content = content;
  file.encoding = "utf8";
  file.size = Buffer.byteLength(content);
  file.sha256 = createHash("sha256").update(content).digest("hex");
}

test.describe("validated revision preview", () => {
  test("opens sealed R2 artifact and widget in opaque frames while R1 stays active", async ({
    page,
    request,
  }) => {
    const user = testUser("revision-preview");
    const organization = await createOrganization(request, user);
    const published = await publishStaticShiplet(
      request,
      user,
      organization.id,
      {
        name: `Revision preview ${Date.now()}`,
        html: "<!doctype html><h1>Active browser R1</h1>",
      },
    );
    const headers = { ...authHeaders(user), Origin: "http://localhost:8787" };
    const activeResponse = await request.get(
      `/api/shiplets/${published.project.id}/package`,
      { headers },
    );
    expect(activeResponse.ok(), await activeResponse.text()).toBe(true);
    const active = (await activeResponse.json()) as {
      revision: { id: string };
    };
    const forkResponse = await request.post(
      `/api/shiplets/${published.project.id}/drafts`,
      { headers, data: { fromRevisionId: active.revision.id } },
    );
    expect(forkResponse.ok(), await forkResponse.text()).toBe(true);
    const { draft } = (await forkResponse.json()) as {
      draft: { id: string; version: number };
    };
    const packageResponse = await request.get(
      `/api/drafts/${draft.id}/package`,
      {
        headers,
      },
    );
    const packageEnvelope = (await packageResponse.json()) as {
      package: { files: PortableFile[] };
    };
    replaceFile(
      packageEnvelope.package.files,
      "artifact/index.html",
      "<!doctype html><h1>Sealed browser R2</h1>",
    );
    replaceFile(
      packageEnvelope.package.files,
      "widget/index.html",
      '<!doctype html><p data-browser-widget="r2">Preview widget R2</p>',
    );
    const updateResponse = await request.put(
      `/api/drafts/${draft.id}/package`,
      {
        headers: { ...headers, "If-Match": String(draft.version) },
        data: {
          package: packageEnvelope.package,
          expectedVersion: draft.version,
        },
      },
    );
    expect(updateResponse.ok(), await updateResponse.text()).toBe(true);
    const updated = (await updateResponse.json()) as {
      draft: { version: number };
    };
    const validationResponse = await request.post(
      `/api/drafts/${draft.id}/validate`,
      { headers, data: { expectedVersion: updated.draft.version } },
    );
    expect(validationResponse.ok(), await validationResponse.text()).toBe(true);
    const { validation } = (await validationResponse.json()) as {
      validation: { revisionId: string; previewUrl: string };
    };

    await loginAs(page, user);
    await page.goto(validation.previewUrl, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("complementary", { name: "Revision preview context" }),
    ).toContainText("The active revision is still unchanged");
    await expect(
      page.getByRole("link", { name: "Return to ownership" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Promote this validated draft" }),
    ).toBeVisible();
    const artifact = page.frameLocator("[data-shiplet-artifact-frame]");
    await expect(
      artifact.getByRole("heading", { name: "Sealed browser R2" }),
    ).toBeVisible();
    const widget = page.frameLocator("[data-shiplet-widget-frame]");
    await expect(widget.locator("[data-browser-widget='r2']")).toContainText(
      "Preview widget R2",
    );
    for (const frame of await page.locator("iframe").all()) {
      expect((await frame.getAttribute("sandbox")) || "").not.toContain(
        "allow-same-origin",
      );
    }

    const activeAfterResponse = await request.get(
      `/api/shiplets/${published.project.id}/package`,
      { headers },
    );
    expect(
      ((await activeAfterResponse.json()) as { revision: { id: string } })
        .revision.id,
    ).toBe(active.revision.id);
    await page.goto(`/${published.project.subdomain}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page
        .frameLocator("[data-shiplet-artifact-frame]")
        .getByRole("heading", { name: "Active browser R1" }),
    ).toBeVisible();
  });
});
