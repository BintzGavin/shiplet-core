import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
  type FrameLocator,
  type Page,
} from "@playwright/test";

import {
  authHeaders,
  createOrganization,
  loginAs,
  publishStaticShiplet,
  testUser,
} from "./helpers";

const evidenceRoot = "/private/tmp/shiplet-parity-navigation-r8-20260920/contextual";

async function createAnchoredFeedback(
  request: APIRequestContext,
  actor: ReturnType<typeof testUser>,
  project: { id: string; subdomain: string },
  ticketNumber: number,
  pageUrl: string,
  selector: string,
) {
  const response = await request.post(
    `/api/projects/${encodeURIComponent(project.id)}/review-feedback`,
    {
      headers: {
        ...authHeaders(actor),
        "Content-Type": "application/json",
        Origin: "http://localhost:8787",
      },
      data: {
        clientFeedbackId: `contextual-${ticketNumber}-${randomUUID()}`,
        comment:
          ticketNumber === 7
            ? "Keep the checkout promise close to the call to action. ".repeat(8)
            : `Contextual feedback ${ticketNumber}`,
        name: actor.email,
        pageUrl,
        screenshotMode: "element",
        viewport: { width: 1280, height: 800, devicePixelRatio: 1 },
        coordinates:
          ticketNumber === 7 || ticketNumber === 20
            ? {
                pageX: ticketNumber === 7 ? 1120 : 220,
                pageY: ticketNumber === 7 ? 680 : 220,
                viewportX: ticketNumber === 7 ? 1120 : 220,
                viewportY: ticketNumber === 7 ? 680 : 220,
              }
            : undefined,
        selectedElement:
          ticketNumber === 7 || ticketNumber === 20
            ? { selector, tagName: "BUTTON", text: `Review target ${ticketNumber}` }
            : undefined,
        captureContext: { documentWidth: 1280, documentHeight: 900, scrollX: 0, scrollY: 0 },
        mentions: [],
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as {
    feedback: { id: string; ticket_label: string };
  };
}

async function createThreadFixture(
  request: APIRequestContext,
  actor: ReturnType<typeof testUser>,
  project: { id: string; subdomain: string },
  pageUrl: string,
  selector: string,
) {
  let seventh: Awaited<ReturnType<typeof createAnchoredFeedback>> | undefined;
  let twentieth: Awaited<ReturnType<typeof createAnchoredFeedback>> | undefined;
  for (let ticket = 1; ticket <= 20; ticket += 1) {
    const created = await createAnchoredFeedback(
      request,
      actor,
      project,
      ticket,
      pageUrl,
      selector,
    );
    if (ticket === 7) seventh = created;
    if (ticket === 20) twentieth = created;
  }
  expect(seventh?.feedback.ticket_label).toBe("PF-7");
  expect(twentieth?.feedback.ticket_label).toBe("PF-20");
  const replyResponse = await request.post(
    `/api/projects/${encodeURIComponent(project.id)}/review-feedback/${encodeURIComponent(seventh!.feedback.id)}/replies`,
    {
      headers: {
        ...authHeaders(actor),
        "Content-Type": "application/json",
        Origin: "http://localhost:8787",
      },
      data: { comment: "I can revise the supporting proof." },
    },
  );
  expect(replyResponse.ok(), await replyResponse.text()).toBe(true);
  return { seventh: seventh!, twentieth: twentieth! };
}

async function expectHitTarget(page: Page, locator: ReturnType<Page["locator"]>) {
  await locator.scrollIntoViewIfNeeded();
  const ownsCenter = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return hit === element || element.contains(hit);
  });
  expect(ownsCenter).toBe(true);
}

test("hosted canonical pin opens one nearby trusted thread and preserves its draft", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const actor = testUser("contextual-hosted");
  const organization = await createOrganization(request, actor);
  const published = await publishStaticShiplet(request, actor, organization.id, {
    name: `Contextual hosted ${Date.now()}`,
    html: "<!doctype html><html><body style='margin:0;min-height:900px'><button id='review-target' style='position:absolute;right:120px;bottom:100px'>Review target</button></body></html>",
  });
  const pageUrl = new URL(
    `/${published.project.subdomain}`,
    "http://localhost:8787",
  ).toString();
  const fixture = await createThreadFixture(
    request,
    actor,
    published.project,
    pageUrl,
    "#review-target",
  );
  await loginAs(page, actor);

  let listRequests = 0;
  await page.route("**/__shiplet/review/feedback?**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    listRequests += 1;
    const response = await route.fetch();
    if (listRequests === 1) return route.fulfill({ response });
    if (!response.ok() || !response.headers()["content-type"]?.includes("application/json")) {
      return route.fulfill({ response });
    }
    const body = (await response.json()) as { feedback?: unknown[] };
    if (Array.isArray(body.feedback)) body.feedback.reverse();
    return route.fulfill({ response, json: body });
  });
  await page.goto(`/${published.project.subdomain}`, {
    waitUntil: "domcontentloaded",
  });

  const stackTrigger = page.getByRole("button", {
    name: "2 comments at this location",
    exact: true,
  });
  await expect(stackTrigger).toBeVisible();
  await stackTrigger.click();
  const stackMenu = page.locator(".shiplet-review-pin-stack-menu");
  await expect(stackMenu).toBeVisible();
  const pf7Choice = stackMenu.getByRole("menuitem", { name: /^PF-7 ·/ });
  await expect(pf7Choice).toBeVisible();
  await pf7Choice.click();
  const card = page.getByRole("region", { name: "Thread PF-7", exact: true });
  if ((await card.count()) === 0) {
    await page.screenshot({ path: `${evidenceRoot}/before-hosted-fixed-panel.png` });
  }
  await expect(card).toBeVisible();
  await expect(page.locator("#shiplet-kernel-review-panel")).toBeHidden();
  await expect(card).toContainText("Keep the checkout promise");
  await expect(card).toContainText("I can revise the supporting proof.");
  const stackBox = await stackTrigger.boundingBox();
  const cardBox = await card.boundingBox();
  expect(cardBox!.width).toBeGreaterThan(stackBox!.width * 4);
  expect(cardBox!.x).toBeGreaterThanOrEqual(0);
  expect(cardBox!.y).toBeGreaterThanOrEqual(0);
  expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(1280);
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(800);

  const reply = page.getByRole("textbox", { name: "Reply text for PF-7" });
  await reply.fill("Draft remains bound to PF-7");
  await reply.evaluate((input: HTMLInputElement) => input.setSelectionRange(6, 13));
  await expectHitTarget(page, page.getByRole("button", { name: "Reply to PF-7" }));
  await expectHitTarget(page, page.getByRole("button", { name: "Close thread PF-7" }));
  await page.waitForTimeout(5_200);
  await expect(card).toBeVisible();
  await expect(reply).toHaveValue("Draft remains bound to PF-7");
  await expect(reply).toBeFocused();
  expect(
    await reply.evaluate((input: HTMLInputElement) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([6, 13]);
  await expect(stackTrigger).toBeVisible();
  const independentPf20Pin = page.getByRole("button", {
    name: "Open PF-20",
    exact: true,
  });
  await expect(independentPf20Pin).toBeVisible();
  await expect(independentPf20Pin).toHaveText("20");
  await expect(card).toHaveAttribute(
    "data-feedback-id",
    fixture.seventh.feedback.id,
  );

  await page.getByRole("button", { name: "Close thread PF-7" }).click();
  await expect(card).toBeHidden();
  await expect(stackTrigger).toBeFocused();

  await page.locator(".shiplet-review-comments-launcher").click();
  const listThread = page.locator(
    `[data-shiplet-review-thread="${fixture.seventh.feedback.id}"]`,
  );
  await listThread.locator(".shiplet-review-thread-summary").click();
  await expect(listThread.getByRole("textbox", { name: "Reply text for PF-7" })).toHaveValue(
    "Draft remains bound to PF-7",
  );
  await expectHitTarget(
    page,
    listThread.getByRole("button", { name: "Reply to PF-7" }),
  );
  await page.getByRole("button", { name: "Close review panel" }).click();
  await expect(stackTrigger).toBeVisible();
  await stackTrigger.click();
  await expect(stackMenu).toBeVisible();
  await expect(pf7Choice).toBeVisible();
  await pf7Choice.click();
  await expect(reply).toHaveValue("Draft remains bound to PF-7");
  await reply.press("Escape");
  await expect(card).toBeHidden();
  await expect(stackTrigger).toBeFocused();
  await stackTrigger.click();
  await expect(stackMenu).toBeVisible();
  await pf7Choice.click();
  await page.screenshot({ path: `${evidenceRoot}/after-hosted-contextual-thread.png` });
});

test("embedded canonical pin keeps the trusted thread inside a nearby iframe", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const actor = testUser("contextual-embedded");
  const organization = await createOrganization(request, actor);
  const published = await publishStaticShiplet(request, actor, organization.id);
  await loginAs(page, actor);
  await page.goto(`/embed/install?project_id=${published.project.id}`);
  await page.getByLabel("Site URL").fill("http://127.0.0.1:8794");
  await page.getByRole("button", { name: "Create install snippet" }).click();
  const snippet = await page.getByLabel("Install snippet").inputValue();
  const externalPageUrl = "http://127.0.0.1:8794/home";
  await createThreadFixture(
    request,
    actor,
    published.project,
    externalPageUrl,
    "#review-target",
  );

  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<!doctype html><html><body style="margin:0;min-height:900px"><button id="review-target" style="position:absolute;right:110px;bottom:90px">Review target</button>${snippet}</body></html>`,
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(8794, "127.0.0.1", resolve),
  );
  try {
    await page.goto(externalPageUrl);
    const widget = page.locator("shiplet-feedback");
    const frame = widget.locator("iframe").contentFrame();
    await expect(
      frame
        .getByRole("button", { name: /^Annotate/ })
        .or(frame.getByRole("button", { name: "Open secure Shiplet sign-in" })),
    ).toBeVisible();
    if (await frame.locator("html[data-shiplet-embed-auth-bootstrap='v1']").count()) {
      const popupPromise = page.waitForEvent("popup");
      await frame.getByRole("button", { name: "Open comments", exact: true }).click();
      const popup = await popupPromise;
      await expect(frame.locator("html[data-shiplet-trusted-review-host='v1']")).toBeAttached();
      if (!popup.isClosed()) await popup.close();
    } else if (
      await frame
        .getByRole("button", { name: "Open secure Shiplet sign-in" })
        .isVisible()
    ) {
      const popupPromise = page.waitForEvent("popup");
      await frame
        .getByRole("button", { name: "Open secure Shiplet sign-in" })
        .click();
      const popup = await popupPromise;
      await expect(frame.getByRole("button", { name: /^Annotate/ })).toBeVisible();
      if (!popup.isClosed()) await popup.close();
    }

    if (await frame.locator("#shiplet-kernel-review-panel").isVisible()) {
      await frame.getByRole("button", { name: "Close review panel" }).click();
    }

    const oldPin = widget.locator(".pins button").filter({ hasText: "7" });
    await expect(oldPin).toBeVisible();
    const pin = widget.getByRole("button", { name: "Open PF-7", exact: true });
    if ((await pin.count()) === 0) {
      await page.screenshot({ path: `${evidenceRoot}/before-embedded-fixed-panel.png` });
    }
    await expect(pin).toHaveText("7");
    await pin.click();
    const card = frame.getByRole("region", { name: "Thread PF-7", exact: true });
    await expect(card).toBeVisible();
    await expect(frame.locator("#shiplet-kernel-review-panel")).toBeHidden();
    await expect(card).toContainText("I can revise the supporting proof.");
    await expect(widget.locator(".surface")).toHaveAttribute("data-view", "thread");
    const pinBox = await pin.boundingBox();
    const frameBox = await widget.locator("iframe").boundingBox();
    expect(frameBox!.width).toBeGreaterThan(pinBox!.width * 4);

    const reply = frame.getByRole("textbox", { name: "Reply text for PF-7" });
    await reply.fill("Embedded draft remains trusted");
    await frame.getByRole("button", { name: "Close thread PF-7" }).click();
    await expect(card).toBeHidden();
    await expect(pin).toBeFocused();
    await pin.click();
    await expect(reply).toHaveValue("Embedded draft remains trusted");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(card).toBeVisible();
    const narrowBox = await widget.locator("iframe").boundingBox();
    expect(narrowBox!.x).toBeGreaterThanOrEqual(0);
    expect(narrowBox!.y).toBeGreaterThanOrEqual(0);
    expect(narrowBox!.x + narrowBox!.width).toBeLessThanOrEqual(390);
    expect(narrowBox!.y + narrowBox!.height).toBeLessThanOrEqual(844);
    await page.screenshot({ path: `${evidenceRoot}/after-embedded-contextual-thread.png` });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function startGeneratedWidgetFixture(port: number, apiOrigin: string) {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<!doctype html><html><body><button id="keep-focus">Keep focus</button><button id="target-a">Target A</button><button id="target-b">Target B</button><shiplet-feedback installation-id="install_focus"></shiplet-feedback><script src="${apiOrigin}/api/embed/widget.js"></script></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${port}/fixture`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const canonicalPin = {
  index: 0,
  feedbackId: "feedback_focus_7",
  ticket: "PF-7",
  label: "7",
  selector: "#target-a",
  pageX: 120,
  pageY: 120,
};

const otherPin = {
  index: 1,
  feedbackId: "feedback_focus_8",
  ticket: "PF-8",
  label: "8",
  selector: "#target-b",
  pageX: 180,
  pageY: 160,
};

async function postWidgetMessages(
  frame: FrameLocator,
  messages: Array<Record<string, unknown>>,
) {
  await frame.locator("body").evaluate((_body, payload) => {
    for (const message of payload.messages) {
      parent.postMessage(message, "*");
    }
  }, { messages });
}

async function waitForAnimationFrames(page: Page, count = 2) {
  await page.evaluate(
    (frames) =>
      new Promise<void>((resolve) => {
        const next = (remaining: number) =>
          requestAnimationFrame(() =>
            remaining <= 1 ? resolve() : next(remaining - 1),
          );
        next(frames);
      }),
    count,
  );
}

test("embedded pin controls a local shadow-root surface containing the trusted frame", async ({
  page,
  baseURL,
}) => {
  const fixture = await startGeneratedWidgetFixture(
    8798,
    new URL(baseURL!).origin,
  );
  try {
    await page.goto(fixture.url);
    const widget = page.locator("shiplet-feedback");
    const frame = widget.locator("iframe").contentFrame();
    await expect(frame.locator("body")).toBeAttached();
    await postWidgetMessages(frame, [
      { protocol: "shiplet.embed.ui.v1", pins: [canonicalPin] },
    ]);
    const pin = widget.getByRole("button", { name: "Open PF-7", exact: true });
    await expect(pin).toBeVisible();
    const relationship = await pin.evaluate((button) => {
      const root = button.getRootNode() as ShadowRoot;
      const controlledId = button.getAttribute("aria-controls") || "";
      const controlled = controlledId ? root.getElementById(controlledId) : null;
      return {
        controlledId,
        controlledExists: Boolean(controlled),
        containsTrustedFrame: Boolean(controlled?.querySelector("iframe")),
      };
    });
    expect(relationship).toEqual({
      controlledId: "shiplet-embedded-review-surface",
      controlledExists: true,
      containsTrustedFrame: true,
    });
  } finally {
    await fixture.close();
  }
});

test("embedded close resolves the current canonical pin after refresh and rejects stale focus callbacks", async ({
  page,
  baseURL,
}) => {
  const fixture = await startGeneratedWidgetFixture(
    8799,
    new URL(baseURL!).origin,
  );
  try {
    await page.goto(fixture.url);
    const widget = page.locator("shiplet-feedback");
    const frame = widget.locator("iframe").contentFrame();
    await expect(frame.locator("body")).toBeAttached();
    await postWidgetMessages(frame, [
      {
        protocol: "shiplet.embed.ui.v1",
        pins: [canonicalPin, otherPin],
      },
    ]);
    const canonical = widget.getByRole("button", {
      name: "Open PF-7",
      exact: true,
    });
    await canonical.focus();
    await canonical.press("Enter");
    await postWidgetMessages(frame, [
      {
        protocol: "shiplet.embed.ui.v1",
        view: "thread",
        activeFeedbackId: canonicalPin.feedbackId,
        anchor: null,
      },
    ]);
    await expect(canonical).toHaveAttribute("aria-expanded", "true");

    const refreshedCanonical = {
      ...canonicalPin,
      index: 1,
      selector: "#target-b",
    };
    const refreshedOther = {
      ...otherPin,
      index: 0,
      selector: "#target-a",
    };
    await postWidgetMessages(frame, [
      {
        protocol: "shiplet.embed.ui.v1",
        view: "toolbar",
        activeFeedbackId: "",
        anchor: null,
      },
      {
        protocol: "shiplet.embed.ui.v1",
        pins: [refreshedOther, refreshedCanonical],
      },
    ]);
    await waitForAnimationFrames(page);
    const currentCanonical = widget.getByRole("button", {
      name: "Open PF-7",
      exact: true,
    });
    await expect(currentCanonical).toBeFocused();
    await expect(currentCanonical).toHaveText("7");
    await expect(
      widget.getByRole("button", { name: "Open PF-8", exact: true }),
    ).not.toBeFocused();

    await currentCanonical.press("Enter");
    await postWidgetMessages(frame, [
      {
        protocol: "shiplet.embed.ui.v1",
        view: "thread",
        activeFeedbackId: canonicalPin.feedbackId,
        anchor: null,
      },
      {
        protocol: "shiplet.embed.ui.v1",
        view: "toolbar",
        activeFeedbackId: "",
        anchor: null,
      },
    ]);
    await waitForAnimationFrames(page);
    await expect(currentCanonical).toBeFocused();

    await frame.locator("body").evaluate(() => {
      window.addEventListener("message", (event) => {
        if (event.data?.protocol === "shiplet.embed.dismiss.v1") {
          parent.postMessage(
            {
              protocol: "shiplet.embed.ui.v1",
              view: "toolbar",
              activeFeedbackId: "",
              anchor: null,
            },
            "*",
          );
        }
      });
    });
    await currentCanonical.press("Enter");
    await postWidgetMessages(frame, [
      {
        protocol: "shiplet.embed.ui.v1",
        view: "thread",
        activeFeedbackId: canonicalPin.feedbackId,
        anchor: null,
      },
    ]);
    await page.keyboard.press("Escape");
    await waitForAnimationFrames(page);
    await expect(currentCanonical).toBeFocused();

    await currentCanonical.press("Enter");
    await postWidgetMessages(frame, [
      {
        protocol: "shiplet.embed.ui.v1",
        view: "thread",
        activeFeedbackId: canonicalPin.feedbackId,
        anchor: null,
      },
    ]);
    const keepFocus = page.locator("#keep-focus");
    await keepFocus.focus();
    await postWidgetMessages(frame, [
      {
        protocol: "shiplet.embed.ui.v1",
        view: "toolbar",
        activeFeedbackId: "",
        anchor: null,
      },
      {
        protocol: "shiplet.embed.ui.v1",
        view: "thread",
        activeFeedbackId: otherPin.feedbackId,
        anchor: null,
      },
    ]);
    await waitForAnimationFrames(page);
    await expect(keepFocus).toBeFocused();
    await expect(
      widget.getByRole("button", { name: "Open PF-7", exact: true }),
    ).not.toBeFocused();

    await postWidgetMessages(frame, [
      {
        protocol: "shiplet.embed.ui.v1",
        view: "toolbar",
        activeFeedbackId: "",
        anchor: null,
      },
    ]);
    await widget.evaluate((element, origin) => {
      const frameElement = element.shadowRoot?.querySelector(
        "iframe",
      ) as HTMLIFrameElement | null;
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            protocol: "shiplet.embed.ui.v1",
            view: "thread",
            activeFeedbackId: "feedback_focus_7",
            anchor: null,
          },
          origin,
          source: frameElement?.contentWindow || null,
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            protocol: "shiplet.embed.ui.v1",
            view: "toolbar",
            activeFeedbackId: "",
            anchor: null,
          },
          origin,
          source: frameElement?.contentWindow || null,
        }),
      );
      element.remove();
    }, "http://localhost:8787");
    await waitForAnimationFrames(page);
    await expect(keepFocus).toBeFocused();
  } finally {
    await fixture.close();
  }
});
