import { describe, expect, it } from "vitest";

import {
  injectTrustedArtifactBridge,
  parseTrustedArtifactCapture,
  trustedArtifactBridgeScript,
} from "../src/trusted-artifact-bridge";

const binding = {
  channelNonce: "nonce_capture_123456",
  shipletId: "shiplet_a",
  revisionId: "revision_a",
  requestId: "capture_request_a",
};

function capture(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "shiplet.artifact.capture.result.v1",
    type: "result",
    channelNonce: binding.channelNonce,
    shipletId: binding.shipletId,
    revisionId: binding.revisionId,
    requestId: binding.requestId,
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
      ...overrides,
    },
  };
}

function operateArtifactBridge() {
  const messageListeners: Array<(event: any) => unknown> = [];
  const windowListeners = new Map<string, Array<(event: any) => unknown>>();
  const activeIntervals = new Set<number>();
  const activeTimeouts = new Set<number>();
  let nextTimer = 1;
  const parentMessages: Array<{ message: any; origin: string }> = [];
  const parentWindow = {
    postMessage(message: any, origin: string) {
      parentMessages.push({ message, origin });
    },
  };
  const window = {
    addEventListener(type: string, listener: (event: any) => unknown) {
      if (type === "message") messageListeners.push(listener);
      windowListeners.set(type, [
        ...(windowListeners.get(type) || []),
        listener,
      ]);
    },
    removeEventListener(type: string, listener: (event: any) => unknown) {
      windowListeners.set(
        type,
        (windowListeners.get(type) || []).filter(
          (candidate) => candidate !== listener,
        ),
      );
    },
    getComputedStyle(target: FakeElement) {
      return target.computedStyle;
    },
    matchMedia() {
      return { matches: false };
    },
    requestAnimationFrame(callback: () => void) {
      callback();
      return 1;
    },
    setInterval() {
      const timer = nextTimer++;
      activeIntervals.add(timer);
      return timer;
    },
    clearInterval(timer: number) {
      activeIntervals.delete(timer);
    },
    setTimeout() {
      const timer = nextTimer++;
      activeTimeouts.add(timer);
      return timer;
    },
    clearTimeout(timer: number) {
      activeTimeouts.delete(timer);
    },
    location: { href: "https://artifact.example/review" },
    scrollX: 0,
    scrollY: 0,
    scrollTo: undefined as undefined | ((value: unknown) => void),
  };
  class FakeElement {
    isConnected = true;
    isContentEditable = false;
    parentElement: FakeElement | null = null;
    shadowRoot: { activeElement: FakeElement | null } | null = null;
    tagName = "BUTTON";
    scrollCalls: unknown[] = [];
    rect = { left: 100, top: 120, width: 80, height: 40 };
    computedStyle = {
      display: "block",
      visibility: "visible",
      opacity: "1",
      contentVisibility: "visible",
    };
    closest(): FakeElement | null {
      return null;
    }
    getBoundingClientRect() {
      return {
        ...this.rect,
        right: this.rect.left + this.rect.width,
        bottom: this.rect.top + this.rect.height,
      };
    }
    getClientRects() {
      return this.rect.width > 0 && this.rect.height > 0 ? [this.rect] : [];
    }
    scrollIntoView(value: unknown) {
      this.scrollCalls.push(value);
    }
  }
  const targets = new Map<string, FakeElement>();
  const documentListeners = new Map<string, Array<(event: any) => unknown>>();
  const documentElement = new FakeElement();
  documentElement.tagName = "HTML";
  Object.assign(documentElement, {
    appendChild() {},
    scrollWidth: 1280,
    scrollHeight: 720,
  });
  const body = new FakeElement();
  body.tagName = "BODY";
  const document = {
    activeElement: body as FakeElement | null,
    body,
    documentElement,
    createElement() {
      return {
        style: {},
        remove() {},
        setAttribute() {},
      };
    },
    addEventListener(type: string, listener: (event: any) => unknown) {
      documentListeners.set(type, [
        ...(documentListeners.get(type) || []),
        listener,
      ]);
    },
    removeEventListener(type: string, listener: (event: any) => unknown) {
      documentListeners.set(
        type,
        (documentListeners.get(type) || []).filter(
          (candidate) => candidate !== listener,
        ),
      );
    },
    querySelectorAll() {
      return [];
    },
    querySelector(selector: string) {
      if (selector === "[invalid") throw new SyntaxError("Invalid selector");
      return targets.get(selector) || null;
    },
  };
  class FakePort {
    closed = false;
    listeners: Array<(event: { data: unknown }) => unknown> = [];
    addEventListener(type: string, listener: (event: { data: unknown }) => unknown) {
      if (type === "message") this.listeners.push(listener);
    }
    start() {}
    close() {
      this.closed = true;
    }
    dispatch(data: unknown) {
      for (const listener of this.listeners) listener({ data });
    }
  }
  const execute = new Function(
    "window",
    "document",
    "parent",
    "Element",
    "MessageChannel",
    "innerWidth",
    "innerHeight",
    trustedArtifactBridgeScript(),
  );
  execute(window, document, parentWindow, FakeElement, class {}, 1280, 720);
  const dispatch = (event: any) => {
    for (const listener of messageListeners) listener(event);
  };
  return {
    dispatch,
    activeIntervals,
    activeTimeouts,
    document,
    documentListeners,
    parentMessages,
    parentWindow,
    FakeElement,
    FakePort,
    targets,
    window,
    windowListeners,
  };
}

function connectArtifactBridge(harness: ReturnType<typeof operateArtifactBridge>) {
  const offer = {
    protocol: "shiplet.artifact.channel.v1",
    type: "offer",
    channelNonce: "nonce_saved_targets",
    shipletId: "shiplet_a",
    revisionId: "revision_a1",
  };
  const port = new harness.FakePort();
  const posted: unknown[] = [];
  (port as unknown as { postMessage: (value: unknown) => void }).postMessage = (
    value: unknown,
  ) => {
    posted.push(value);
  };
  harness.dispatch({
    source: harness.parentWindow,
    origin: "https://app.shiplet.cc",
    data: offer,
    ports: [],
  });
  harness.dispatch({
    source: harness.parentWindow,
    origin: "https://app.shiplet.cc",
    data: { ...offer, type: "connect" },
    ports: [port],
  });
  posted.length = 0;
  return { offer, port, posted };
}

describe("trusted artifact capture bridge", () => {
  it("[T2] captures the current page through a distinct request-bound protocol with truthful fidelity", () => {
    const script = trustedArtifactBridgeScript();

    expect(script).toContain('shiplet.artifact.page-capture.command.v1');
    expect(script).toContain('shiplet.artifact.page-capture.result.v1');
    expect(script).toContain('"raster-source"');
    expect(script).toContain('"sanitized-dom"');
    expect(script).toContain('"fallback"');
    expect(script).toContain(
      '["images", "canvas", "media", "form-values", "external-styles"]',
    );
  });
  it("Given an opaque artifact frame, When it returns bounded context for the outstanding request, Then the kernel accepts only inert review metadata", () => {
    expect(parseTrustedArtifactCapture(capture(), binding)).toEqual(
      capture().payload,
    );
  });

  it.each([
    ["wrong nonce", { channelNonce: "nonce_attacker" }],
    ["wrong Shiplet", { shipletId: "shiplet_b" }],
    ["wrong revision", { revisionId: "revision_b" }],
    ["replayed request", { requestId: "capture_request_old" }],
    ["unknown envelope field", { credential: "must-not-cross" }],
  ])(
    "Given a hostile artifact response with %s, When the kernel validates it, Then it fails closed",
    (_label, mutation) => {
      expect(
        parseTrustedArtifactCapture({ ...capture(), ...mutation }, binding),
      ).toBeNull();
    },
  );

  it.each([
    ["credential-shaped target data", { access_token: "forbidden" }],
    ["nested target data", { nested: { token: "forbidden" } }],
    ["oversized selector", { selector: "x".repeat(1201) }],
    ["non-finite coordinates", { pageX: Number.POSITIVE_INFINITY }],
    ["unexpected screenshot media", { screenshotDataUrl: "data:text/html;base64,PGgxPkJvb208L2gxPg==" }],
  ])(
    "Given capture payload containing %s, When the kernel validates it, Then no metadata crosses the boundary",
    (_label, mutation) => {
      const base = capture();
      const key = Object.keys(mutation)[0];
      const nestedKey = ["pageX"].includes(key)
        ? "coordinates"
        : key === "selector" || key === "access_token" || key === "nested"
          ? "selectedElement"
          : null;
      const payload = nestedKey
        ? {
            ...base,
            payload: {
              ...base.payload,
              [nestedKey]: {
                ...(base.payload as Record<string, any>)[nestedKey],
                ...mutation,
              },
            },
          }
        : { ...base, payload: { ...base.payload, ...mutation } };
      expect(parseTrustedArtifactCapture(payload, binding)).toBeNull();
    },
  );

  it("Given artifact HTML with hostile stale bridge markup, When Shiplet serves the frame, Then it injects a fresh kernel bridge without changing artifact authority", () => {
    const html =
      '<!doctype html><html><head><script data-shiplet-artifact-bridge src="https://attacker.example/bridge.js"></script></head><body><h1>Hello</h1></body></html>';
    const injected = injectTrustedArtifactBridge(html, "/api/review/artifact-bridge.js");
    expect(injected).toContain("<h1>Hello</h1>");
    expect(injected.match(/data-shiplet-kernel-artifact-bridge/g)).toHaveLength(1);
    expect(injected).toContain('src="/api/review/artifact-bridge.js"');
  });

  it("Given arbitrary artifact code, When the capture bridge is delivered, Then the bridge contains no platform fetch, cookie, storage, or bearer authority", () => {
    const script = trustedArtifactBridgeScript();
    expect(script).toContain("MessageChannel");
    expect(script).toContain("event.source !== parent");
    expect(script).not.toContain("fetch(");
    expect(script).not.toContain("document.cookie");
    expect(script).not.toContain("localStorage");
    expect(script).not.toContain("sessionStorage");
    expect(script).not.toContain("Authorization");
    expect(new TextEncoder().encode(script).byteLength).toBeLessThan(32_768);
  });

  it("replaces a connected capture channel only for a fresh offer from the same trusted parent origin", () => {
    const harness = operateArtifactBridge();
    const firstOffer = {
      protocol: "shiplet.artifact.channel.v1",
      type: "offer",
      channelNonce: "nonce_first",
      shipletId: "shiplet_a",
      revisionId: "revision_a1",
    };
    harness.dispatch({
      source: harness.parentWindow,
      origin: "https://app.shiplet.cc",
      data: firstOffer,
      ports: [],
    });
    const firstPort = new harness.FakePort();
    harness.dispatch({
      source: harness.parentWindow,
      origin: "https://app.shiplet.cc",
      data: { ...firstOffer, type: "connect" },
      ports: [firstPort],
    });
    firstPort.dispatch({
      protocol: "shiplet.artifact.capture.command.v1",
      type: "start",
      channelNonce: firstOffer.channelNonce,
      shipletId: firstOffer.shipletId,
      revisionId: firstOffer.revisionId,
      requestId: "capture_before_reload",
    });
    expect(harness.documentListeners.get("click")).toHaveLength(1);

    const freshOffer = { ...firstOffer, channelNonce: "nonce_fresh" };
    harness.dispatch({
      source: harness.parentWindow,
      origin: "https://attacker.example",
      data: freshOffer,
      ports: [],
    });
    expect(firstPort.closed).toBe(false);
    harness.dispatch({
      source: harness.parentWindow,
      origin: "https://app.shiplet.cc",
      data: freshOffer,
      ports: [],
    });

    expect(firstPort.closed).toBe(true);
    expect(harness.documentListeners.get("click") || []).toHaveLength(0);
    expect(harness.parentMessages.at(-1)).toEqual({
      message: { ...freshOffer, type: "ready" },
      origin: "https://app.shiplet.cc",
    });

    const freshPort = new harness.FakePort();
    harness.dispatch({
      source: harness.parentWindow,
      origin: "https://app.shiplet.cc",
      data: { ...firstOffer, type: "connect" },
      ports: [freshPort],
    });
    expect(freshPort.listeners).toHaveLength(0);
    harness.dispatch({
      source: harness.parentWindow,
      origin: "https://app.shiplet.cc",
      data: { ...freshOffer, type: "connect" },
      ports: [freshPort],
    });
    expect(freshPort.listeners).toHaveLength(1);
  });

  it("acknowledges each exact capture start only after the listeners are installed", () => {
    const harness = operateArtifactBridge();
    const { offer, port, posted } = connectArtifactBridge(harness);
    const start = {
      ...offer,
      protocol: "shiplet.artifact.capture.command.v1",
      type: "start",
      requestId: "capture_request_ready",
    };

    port.dispatch(start);

    expect(harness.documentListeners.get("pointerover")).toHaveLength(1);
    expect(harness.documentListeners.get("click")).toHaveLength(1);
    expect(posted).toEqual([
      {
        protocol: "shiplet.artifact.capture.state.v1",
        type: "ready",
        channelNonce: offer.channelNonce,
        shipletId: offer.shipletId,
        revisionId: offer.revisionId,
        requestId: start.requestId,
      },
    ]);

    port.dispatch(start);
    port.dispatch({ ...start, requestId: "capture_request_other" });
    port.dispatch({ ...start, channelNonce: "nonce_foreign" });
    port.dispatch({ ...start, type: "unexpected" });
    expect(posted).toHaveLength(1);
  });

  it("Given a connected artifact channel, When the reviewer moves their pointer, Then the bridge reports bounded page coordinates to the kernel only", () => {
    const harness = operateArtifactBridge();
    const offer = { protocol: "shiplet.artifact.channel.v1", type: "offer", channelNonce: "nonce_pointer", shipletId: "shiplet_a", revisionId: "revision_a1" };
    const port = new harness.FakePort();
    const posted: unknown[] = [];
    (port as unknown as { postMessage: (value: unknown) => void }).postMessage = (value: unknown) => { posted.push(value); };
    harness.dispatch({ source: harness.parentWindow, origin: "https://app.shiplet.cc", data: offer, ports: [] });
    harness.dispatch({ source: harness.parentWindow, origin: "https://app.shiplet.cc", data: { ...offer, type: "connect" }, ports: [port] });
    posted.length = 0;
    const move = harness.documentListeners.get("pointermove") || [];
    expect(move).toHaveLength(1);
    move[0]({ clientX: 120.4, clientY: 80.6 });
    expect(posted).toEqual([
      {
        protocol: "shiplet.artifact.pointer.v1",
        type: "move",
        channelNonce: "nonce_pointer",
        shipletId: "shiplet_a",
        revisionId: "revision_a1",
        pointer: { pageX: 120.4, pageY: 80.6, viewportX: 120.4, viewportY: 80.6 },
      },
    ]);
    const out = harness.documentListeners.get("pointerout") || [];
    out[0]({ relatedTarget: null });
    expect(posted.at(-1)).toEqual({ protocol: "shiplet.artifact.pointer.v1", type: "leave", channelNonce: "nonce_pointer", shipletId: "shiplet_a", revisionId: "revision_a1" });
    expect(JSON.stringify(posted)).not.toMatch(/cookie|token|authorization/i);
  });

  it("Given a follow scroll command from the kernel, When the artifact obeys it and the reviewer then scrolls themselves, Then the bridge mirrors once and reports the interruption", () => {
    const harness = operateArtifactBridge();
    const scrolled: unknown[] = [];
    const offer = { protocol: "shiplet.artifact.channel.v1", type: "offer", channelNonce: "nonce_follow", shipletId: "shiplet_a", revisionId: "revision_a1" };
    const port = new harness.FakePort();
    const posted: unknown[] = [];
    (port as unknown as { postMessage: (value: unknown) => void }).postMessage = (value: unknown) => { posted.push(value); };
    harness.dispatch({ source: harness.parentWindow, origin: "https://app.shiplet.cc", data: offer, ports: [] });
    harness.dispatch({ source: harness.parentWindow, origin: "https://app.shiplet.cc", data: { ...offer, type: "connect" }, ports: [port] });
    harness.window.scrollTo = (value: unknown) => { scrolled.push(value); };
    port.dispatch({ ...offer, protocol: "shiplet.artifact.follow.command.v1", type: "scroll", scrollX: 0, scrollY: 640 });
    expect(scrolled).toEqual([{ left: 0, top: 640, behavior: "smooth" }]);
    port.dispatch({ ...offer, protocol: "shiplet.artifact.follow.command.v1", type: "scroll", scrollX: 0, scrollY: 640, extra: "no" });
    port.dispatch({ ...offer, channelNonce: "nonce_other", protocol: "shiplet.artifact.follow.command.v1", type: "scroll", scrollX: 0, scrollY: 900 });
    expect(scrolled).toHaveLength(1);
    posted.length = 0;
    const wheel = harness.documentListeners.get("wheel") || [];
    wheel[0]({});
    wheel[0]({});
    expect(posted).toEqual([{ protocol: "shiplet.artifact.follow.v1", type: "interrupt", channelNonce: "nonce_follow", shipletId: "shiplet_a", revisionId: "revision_a1" }]);
    port.dispatch({ ...offer, protocol: "shiplet.artifact.follow.command.v1", type: "stop" });
    const keydown = harness.documentListeners.get("keydown") || [];
    keydown[0]({ key: "ArrowDown" });
    expect(posted).toHaveLength(1);
  });
});

describe("trusted saved-target bridge", () => {
  it("registers bounded inert descriptors and reveals only a bound eligible target", () => {
    const harness = operateArtifactBridge();
    const target = new harness.FakeElement();
    harness.targets.set("#saved-target", target);
    const { offer, port, posted } = connectArtifactBridge(harness);

    port.dispatch({
      ...offer,
      protocol: "shiplet.artifact.saved-targets.command.v1",
      type: "replace",
      targets: [
        {
          feedbackId: "feedback_a",
          selector: "#saved-target",
          expectedTag: "BUTTON",
          relativePoint: { x: 0.25, y: 0.75 },
        },
      ],
    });

    expect(posted).toContainEqual({
      ...offer,
      protocol: "shiplet.artifact.saved-targets.geometry.v1",
      type: "update",
      targets: [
        {
          feedbackId: "feedback_a",
          eligible: true,
          offscreen: false,
          coordinates: {
            pageX: 120,
            pageY: 150,
            viewportX: 120,
            viewportY: 150,
          },
          targetRect: { left: 100, top: 120, width: 80, height: 40 },
        },
      ],
    });
    expect(JSON.stringify(posted)).not.toContain("#saved-target");
    expect(JSON.stringify(posted)).not.toContain("BUTTON");

    port.dispatch({
      ...offer,
      protocol: "shiplet.artifact.saved-target.reveal.v1",
      type: "reveal",
      feedbackId: "feedback_a",
      unexpected: true,
    });
    port.dispatch({
      ...offer,
      protocol: "shiplet.artifact.saved-target.reveal.v1",
      type: "reveal",
      feedbackId: "feedback_unknown",
    });
    expect(target.scrollCalls).toEqual([]);
    port.dispatch({
      ...offer,
      protocol: "shiplet.artifact.saved-target.reveal.v1",
      type: "reveal",
      feedbackId: "feedback_a",
    });
    expect(target.scrollCalls).toEqual([
      { behavior: "smooth", block: "center", inline: "center" },
    ]);
  });

  it("rejects oversized, malformed, stale and unexpected saved-target authority", () => {
    const harness = operateArtifactBridge();
    const target = new harness.FakeElement();
    harness.targets.set("#saved-target", target);
    const { offer, port, posted } = connectArtifactBridge(harness);
    const descriptor = {
      feedbackId: "feedback_a",
      selector: "#saved-target",
    };

    for (const message of [
      {
        ...offer,
        protocol: "shiplet.artifact.saved-targets.command.v1",
        type: "replace",
        targets: Array.from({ length: 251 }, (_, index) => ({
          feedbackId: `feedback_${index}`,
          selector: "#saved-target",
        })),
      },
      {
        ...offer,
        protocol: "shiplet.artifact.saved-targets.command.v1",
        type: "replace",
        targets: [{ ...descriptor, selector: "[invalid" }],
      },
      {
        ...offer,
        protocol: "shiplet.artifact.saved-targets.command.v1",
        type: "replace",
        targets: [{ ...descriptor, credential: "forbidden" }],
      },
      {
        ...offer,
        channelNonce: "nonce_stale",
        protocol: "shiplet.artifact.saved-targets.command.v1",
        type: "replace",
        targets: [descriptor],
      },
      {
        ...offer,
        shipletId: "shiplet_other",
        protocol: "shiplet.artifact.saved-targets.command.v1",
        type: "replace",
        targets: [descriptor],
      },
      {
        ...offer,
        revisionId: "revision_other",
        protocol: "shiplet.artifact.saved-targets.command.v1",
        type: "replace",
        targets: [descriptor],
      },
      {
        ...offer,
        protocol: "shiplet.artifact.saved-targets.command.v1",
        type: "replace",
        targets: [{ ...descriptor, selector: "x".repeat(1201) }],
      },
      {
        ...offer,
        protocol: "shiplet.artifact.saved-targets.command.v1",
        type: "replace",
        targets: [{ ...descriptor, relativePoint: { x: 1.1, y: 0.5 } }],
      },
    ]) {
      port.dispatch(message);
    }
    port.dispatch({
      ...offer,
      protocol: "shiplet.artifact.saved-target.reveal.v1",
      type: "reveal",
      feedbackId: "feedback_a",
    });

    expect(posted).toEqual([]);
    expect(target.scrollCalls).toEqual([]);
  });

  it("relays only explicitly enabled trusted non-editable shortcut actions", () => {
    const harness = operateArtifactBridge();
    const { offer, port, posted } = connectArtifactBridge(harness);
    const keydown = harness.documentListeners.get("keydown") || [];
    expect(keydown).toHaveLength(2);
    const shortcutListener = keydown[1];
    const plainTarget = new harness.FakeElement();
    const editableTarget = new harness.FakeElement();
    editableTarget.tagName = "INPUT";
    editableTarget.closest = () => editableTarget;
    harness.document.activeElement = plainTarget;
    let prevented = 0;
    let stopped = 0;
    const event = (overrides: Record<string, unknown> = {}) => {
      const value = {
        key: "c",
        keyCode: 67,
        isTrusted: true,
        isComposing: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        target: plainTarget,
        preventDefault() {
          prevented += 1;
        },
        stopPropagation() {
          stopped += 1;
        },
        ...overrides,
      };
      return { ...value, composedPath: () => [value.target] };
    };

    shortcutListener(event());
    port.dispatch({
      ...offer,
      protocol: "shiplet.artifact.shortcuts.command.v1",
      type: "enable",
      unexpected: true,
    });
    shortcutListener(event());
    port.dispatch({
      ...offer,
      protocol: "shiplet.artifact.shortcuts.command.v1",
      type: "enable",
    });
    const compositionStart =
      harness.documentListeners.get("compositionstart") || [];
    const compositionEnd =
      harness.documentListeners.get("compositionend") || [];
    compositionStart[0]({});
    shortcutListener(event());
    compositionEnd[0]({});
    shortcutListener(event());
    shortcutListener(event({ key: "Escape", keyCode: 27 }));
    for (const blocked of [
      event({ target: editableTarget }),
      event({ ctrlKey: true }),
      event({ metaKey: true }),
      event({ altKey: true }),
      event({ shiftKey: true }),
      event({ isComposing: true }),
      event({ keyCode: 229 }),
      event({ isTrusted: false }),
    ]) {
      shortcutListener(blocked);
    }

    expect(posted).toEqual([
      {
        ...offer,
        protocol: "shiplet.artifact.shortcuts.v1",
        type: "action",
        action: "comment",
      },
      {
        ...offer,
        protocol: "shiplet.artifact.shortcuts.v1",
        type: "action",
        action: "cancel",
      },
    ]);
    expect(prevented).toBe(0);
    expect(stopped).toBe(0);
  });

  it("renews only increasing bounded lifecycle sequences and disconnects the full B2 session", () => {
    const harness = operateArtifactBridge();
    const target = new harness.FakeElement();
    harness.targets.set("#saved-target", target);
    const { offer, port, posted } = connectArtifactBridge(harness);
    expect(harness.activeIntervals.size).toBe(1);
    port.dispatch({
      ...offer,
      protocol: "shiplet.artifact.saved-targets.command.v1",
      type: "replace",
      targets: [{ feedbackId: "feedback_a", selector: "#saved-target" }],
    });
    expect(harness.activeTimeouts.size).toBe(1);
    posted.length = 0;

    port.dispatch({
      ...offer,
      protocol: "shiplet.artifact.lifecycle.command.v1",
      type: "renew",
      sequence: 1,
    });
    for (const invalid of [
      { ...offer, type: "renew", sequence: 1 },
      { ...offer, type: "renew", sequence: 0 },
      { ...offer, type: "renew", sequence: 2 ** 31 },
      { ...offer, type: "renew", sequence: 2, unexpected: true },
      { ...offer, channelNonce: "nonce_stale", type: "renew", sequence: 2 },
    ]) {
      port.dispatch({
        ...invalid,
        protocol: "shiplet.artifact.lifecycle.command.v1",
      });
    }
    port.dispatch({
      ...offer,
      protocol: "shiplet.artifact.lifecycle.command.v1",
      type: "renew",
      sequence: 2,
    });
    expect(posted).toEqual([
      {
        ...offer,
        protocol: "shiplet.artifact.lifecycle.v1",
        type: "alive",
        sequence: 1,
      },
      {
        ...offer,
        protocol: "shiplet.artifact.lifecycle.v1",
        type: "alive",
        sequence: 2,
      },
    ]);

    port.dispatch({
      ...offer,
      protocol: "shiplet.artifact.lifecycle.command.v1",
      type: "disconnect",
      unexpected: true,
    });
    expect(port.closed).toBe(false);
    port.dispatch({
      ...offer,
      protocol: "shiplet.artifact.lifecycle.command.v1",
      type: "disconnect",
    });
    expect(port.closed).toBe(true);
    expect(harness.activeIntervals.size).toBe(0);
    expect(harness.activeTimeouts.size).toBe(0);
    posted.length = 0;
    port.dispatch({
      ...offer,
      protocol: "shiplet.artifact.lifecycle.command.v1",
      type: "renew",
      sequence: 3,
    });
    expect(posted).toEqual([]);
  });

  it("clears saved targets and shortcut authority when a fresh channel replaces the port", () => {
    const harness = operateArtifactBridge();
    const target = new harness.FakeElement();
    harness.targets.set("#saved-target", target);
    const { offer, port, posted } = connectArtifactBridge(harness);
    port.dispatch({
      ...offer,
      protocol: "shiplet.artifact.saved-targets.command.v1",
      type: "replace",
      targets: [{ feedbackId: "feedback_a", selector: "#saved-target" }],
    });
    port.dispatch({
      ...offer,
      protocol: "shiplet.artifact.shortcuts.command.v1",
      type: "enable",
    });
    posted.length = 0;

    harness.dispatch({
      source: harness.parentWindow,
      origin: "https://app.shiplet.cc",
      data: { ...offer, channelNonce: "nonce_fresh" },
      ports: [],
    });
    port.dispatch({
      ...offer,
      protocol: "shiplet.artifact.saved-target.reveal.v1",
      type: "reveal",
      feedbackId: "feedback_a",
    });
    const keydown = harness.documentListeners.get("keydown") || [];
    keydown[1]({
      key: "c",
      keyCode: 67,
      isTrusted: true,
      isComposing: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      target: { closest: () => null, isContentEditable: false },
      preventDefault() {},
      stopPropagation() {},
    });

    expect(port.closed).toBe(true);
    expect(posted).toEqual([]);
    expect(target.scrollCalls).toEqual([]);
  });
});
