import { expect, test } from "@playwright/test";
import {
  createOrganization,
  establishMembership,
  loginAs,
  publishStaticShiplet,
  testUser,
} from "./helpers";

test("sharing by email says Access granted for a workspace member and Invite sent for a new reviewer", async ({
  page,
  request,
}) => {
  const owner = testUser("share-owner");
  const member = testUser("share-member");
  const newcomer = testUser("share-newcomer");
  const organization = await createOrganization(request, owner);
  await establishMembership(request, organization.id, member);
  const { project } = await publishStaticShiplet(
    request,
    owner,
    organization.id,
    { visibility: "private" },
  );
  await loginAs(page, owner);
  await page.goto("/access");
  const shiplet = page.locator("#shareProjectSelect");
  await expect(
    shiplet.locator(`option[value="${project.id}"]`),
  ).toHaveCount(1);
  await shiplet.selectOption(project.id);
  await page.locator("#shareTargetType").selectOption("user");
  const result = page.locator("#shareResult");

  await page.getByLabel("Email").fill(member.email);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(result).toContainText("Access granted");
  await expect(result).not.toContainText("Invite sent");

  await page.getByLabel("Email").fill(newcomer.email);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(result).toContainText("Invite sent");
  await expect(result).not.toContainText("Access granted");
});
