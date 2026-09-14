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
  const parentMessages: Array<{ message: any; origin: string }> = [];
  const parentWindow = {
    postMessage(message: any, origin: string) {
      parentMessages.push({ message, origin });
    },
  };
  const window = {
    addEventListener(type: string, listener: (event: any) => unknown) {
      if (type === "message") messageListeners.push(listener);
    },
    scrollX: 0,
    scrollY: 0,
    scrollTo: undefined as undefined | ((value: unknown) => void),
  };
  const documentListeners = new Map<string, Array<(event: any) => unknown>>();
  const document = {
    documentElement: {
      appendChild() {},
      scrollWidth: 1280,
      scrollHeight: 720,
    },
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
  execute(window, document, parentWindow, class {}, class {}, 1280, 720);
  const dispatch = (event: any) => {
    for (const listener of messageListeners) listener(event);
  };
  return { dispatch, documentListeners, parentMessages, parentWindow, FakePort, window };
}

describe("trusted artifact capture bridge", () => {
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
