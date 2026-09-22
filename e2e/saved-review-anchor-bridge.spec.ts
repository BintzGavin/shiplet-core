import { expect, test, type Frame, type Page } from "@playwright/test";

import { trustedArtifactBridgeScript } from "../src/trusted-artifact-bridge";

test.use({
  viewport: { width: 900, height: 700 },
  screenshot: "off",
  trace: "off",
  video: "off",
});

const customerOrigin = "https://b2-customer.test";
const artifactOrigin = "https://b2-artifact.test";
const shipletOrigin = "https://b2-shiplet.test";

type BridgeMode = "hosted" | "embedded";
type BrowserContext = Page | Frame;

type BridgeBinding = {
  protocol: "shiplet.artifact.channel.v1";
  type: "offer";
  channelNonce: string;
  shipletId: string;
  revisionId: string;
};

type SavedGeometry = {
  feedbackId: string;
  eligible: boolean;
  offscreen: boolean;
  coordinates: null | {
    pageX: number;
    pageY: number;
    viewportX: number;
    viewportY: number;
  };
  targetRect: null | {
    left: number;
    top: number;
    width: number;
    height: number;
  };
};

const artifactFixture = String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html,body{margin:0}
    body{position:relative;min-height:2600px;font-family:system-ui}
    #spacer{height:120px;background:#e9edf2}
    #target-wrap{margin:16px 0 0 32px}
    #saved-target{width:160px;height:48px}
    #offscreen-target{position:absolute;left:180px;top:1780px;width:160px;height:48px}
    #hidden-wrap{position:absolute;left:360px;top:1880px;visibility:hidden}
    #hidden-target,#private-target{width:160px;height:48px}
    #private-wrap{position:absolute;left:540px;top:1980px}
    #plain-button{position:absolute;left:32px;top:360px;width:160px;height:48px}
    #editor{position:absolute;left:32px;top:430px;width:220px;height:42px}
    #bridge-peer{position:fixed;right:0;bottom:0;width:1px;height:1px;border:0}
  </style>
</head>
<body>
  <div id="spacer"></div>
  <div id="target-wrap"><button id="saved-target" type="button">Saved target</button></div>
  <button id="plain-button" type="button">Artifact control</button>
  <input id="editor" aria-label="Artifact editor">
  <div id="content-editor" contenteditable="true">Editable</div>
  <open-shadow-editor id="open-shadow-editor"></open-shadow-editor>
  <closed-shadow-editor id="closed-shadow-editor"></closed-shadow-editor>
  <div id="closed-div-host"></div>
  <open-shadow-button id="open-shadow-button"></open-shadow-button>
  <button id="offscreen-target" type="button">Offscreen target</button>
  <div id="hidden-wrap"><button id="hidden-target" type="button">Hidden target</button></div>
  <div id="private-wrap" data-shiplet-private><button id="private-target" type="button">Private target</button></div>
  <script>
    window.__pageKeyEvents = [];
    window.__bridgeLifecycle = { intervals: new Set(), mutationObservers: new Set(), resizeObservers: new Set(), layoutObservers: new Set() };
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => { const id = nativeSetInterval(callback, delay, ...args); window.__bridgeLifecycle.intervals.add(id); return id; };
    window.clearInterval = id => { window.__bridgeLifecycle.intervals.delete(id); nativeClearInterval(id); };
    const NativeMutationObserver = window.MutationObserver;
    window.MutationObserver = class extends NativeMutationObserver {
      observe(target, options) {
        if (target === document.documentElement && options?.subtree && options?.childList && options?.attributes && options?.characterData) window.__bridgeLifecycle.mutationObservers.add(this);
        return super.observe(target, options);
      }
      disconnect() { window.__bridgeLifecycle.mutationObservers.delete(this); return super.disconnect(); }
    };
    const NativeResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeResizeObserver {
      observe(target, options) {
        if (target === document.documentElement) window.__bridgeLifecycle.resizeObservers.add(this);
        return super.observe(target, options);
      }
      disconnect() { window.__bridgeLifecycle.resizeObservers.delete(this); return super.disconnect(); }
    };
    const NativePerformanceObserver = window.PerformanceObserver;
    window.PerformanceObserver = class extends NativePerformanceObserver {
      observe(options) {
        if (options?.type === "layout-shift") window.__bridgeLifecycle.layoutObservers.add(this);
        return super.observe(options);
      }
      disconnect() { window.__bridgeLifecycle.layoutObservers.delete(this); return super.disconnect(); }
    };
    customElements.define("open-shadow-editor", class extends HTMLElement {
      connectedCallback() { if (this.shadowRoot) return; const root = this.attachShadow({ mode: "open" }); root.innerHTML = '<label>Open editor<div><input aria-label="Open shadow editor"></div></label>'; }
    });
    customElements.define("closed-shadow-editor", class extends HTMLElement {
      connectedCallback() { if (this.__input) return; const root = this.attachShadow({ mode: "closed" }); root.innerHTML = '<label>Closed editor<input aria-label="Closed shadow editor"></label>'; this.__input = root.querySelector("input"); }
      focusEditor() { this.__input.focus(); }
      editorValue() { return this.__input.value; }
    });
    const closedDivRoot = document.querySelector("#closed-div-host").attachShadow({ mode: "closed" });
    closedDivRoot.innerHTML = '<input aria-label="Closed div editor">';
    window.__closedDivEditor = closedDivRoot.querySelector("input");
    customElements.define("open-shadow-button", class extends HTMLElement {
      connectedCallback() { if (this.shadowRoot) return; const root = this.attachShadow({ mode: "open" }); root.innerHTML = '<button type="button">Open shadow action</button>'; }
    });
    document.addEventListener("keydown", event => window.__pageKeyEvents.push({ key: event.key, defaultPrevented: event.defaultPrevented }));
  </script>
</body>
</html>`;

function offer(mode: BridgeMode): BridgeBinding {
  return {
    protocol: "shiplet.artifact.channel.v1",
    type: "offer",
    channelNonce: `nonce_saved_${mode}`,
    shipletId: "shiplet_saved",
    revisionId: "revision_saved",
  };
}


function peerDocument() {
  return "<!doctype html><html><body>Trusted bridge peer</body></html>";
}

async function setupBridge(page: Page, mode: BridgeMode) {
  const peerOrigin = mode === "hosted" ? artifactOrigin : shipletOrigin;
  const pageBody =
    mode === "hosted"
      ? `<!doctype html><iframe id="bridge-peer" src="${artifactOrigin}/artifact" style="width:700px;height:620px;border:0"></iframe>`
      : artifactFixture.replace(
          "</body>",
          `<iframe id="bridge-peer" src="${shipletOrigin}/review-host"></iframe></body>`,
        );

  await page.route(`${customerOrigin}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: pageBody }),
  );
  await page.route(`${artifactOrigin}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: artifactFixture }),
  );
  await page.route(`${shipletOrigin}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: peerDocument() }),
  );
  await page.goto(`${customerOrigin}/`, { waitUntil: "domcontentloaded" });

  await expect
    .poll(() => page.frames().some((frame) => frame.url().startsWith(peerOrigin)))
    .toBe(true);
  const peerFrame = page
    .frames()
    .find((frame) => frame.url().startsWith(peerOrigin));
  if (!peerFrame) throw new Error("Bridge peer frame did not load");

  const capturePage: BrowserContext = mode === "hosted" ? peerFrame : page;
  const controlPage: BrowserContext = mode === "hosted" ? page : peerFrame;
  const binding = offer(mode);

  if (mode === "hosted") {
    await capturePage.addScriptTag({ content: trustedArtifactBridgeScript() });
    await page.evaluate(
      async ({ binding, peerOrigin }) => {
        const frame = document.querySelector<HTMLIFrameElement>("#bridge-peer");
        if (!frame?.contentWindow) throw new Error("Missing artifact frame");
        const peerWindow = frame.contentWindow;
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(
            () => reject(new Error("Hosted bridge did not become ready")),
            5_000,
          );
          const onMessage = (event: MessageEvent) => {
            if (
              event.source !== peerWindow ||
              event.origin !== peerOrigin ||
              event.data?.protocol !== binding.protocol ||
              event.data?.type !== "ready" ||
              event.data?.channelNonce !== binding.channelNonce
            ) {
              return;
            }
            window.removeEventListener("message", onMessage);
            window.clearTimeout(timer);
            const channel = new MessageChannel();
            const state = window as typeof window & {
              __bridgePort?: MessagePort;
              __bridgeMessages?: unknown[];
            };
            state.__bridgeMessages = [];
            state.__bridgePort = channel.port1;
            channel.port1.addEventListener("message", (portEvent) => {
              state.__bridgeMessages?.push(portEvent.data);
            });
            channel.port1.start();
            peerWindow.postMessage(
              { ...binding, type: "connect" },
              peerOrigin,
              [channel.port2],
            );
            resolve();
          };
          window.addEventListener("message", onMessage);
          peerWindow.postMessage(binding, peerOrigin);
        });
      },
      { binding, peerOrigin },
    );
  } else {
    await page.addScriptTag({ content: trustedArtifactBridgeScript(true) });
    await page.evaluate(
      ({ peerOrigin }) => {
        const frame = document.querySelector<HTMLIFrameElement>("#bridge-peer");
        const attach = (
          window as typeof window & {
            attachShipletPageBridge?: (
              frame: HTMLIFrameElement,
              expectedOrigin: string,
            ) => () => void;
          }
        ).attachShipletPageBridge;
        if (!frame || !attach) throw new Error("Missing embedded bridge");
        (
          window as typeof window & { __cleanupBridge?: () => void }
        ).__cleanupBridge = attach(frame, peerOrigin);
      },
      { peerOrigin },
    );
    await peerFrame.evaluate(
      async ({ binding, customerOrigin }) => {
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(
            () => reject(new Error("Embedded bridge did not become ready")),
            5_000,
          );
          const onMessage = (event: MessageEvent) => {
            if (
              event.source !== parent ||
              event.origin !== customerOrigin ||
              event.data?.protocol !== binding.protocol ||
              event.data?.type !== "ready" ||
              event.data?.channelNonce !== binding.channelNonce
            ) {
              return;
            }
            window.removeEventListener("message", onMessage);
            window.clearTimeout(timer);
            const channel = new MessageChannel();
            const state = window as typeof window & {
              __bridgePort?: MessagePort;
              __bridgeMessages?: unknown[];
            };
            state.__bridgeMessages = [];
            state.__bridgePort = channel.port1;
            channel.port1.addEventListener("message", (portEvent) => {
              state.__bridgeMessages?.push(portEvent.data);
            });
            channel.port1.start();
            parent.postMessage(
              { ...binding, type: "connect" },
              customerOrigin,
              [channel.port2],
            );
            resolve();
          };
          window.addEventListener("message", onMessage);
          parent.postMessage(binding, customerOrigin);
        });
      },
      { binding, customerOrigin },
    );
  }

  return { binding, capturePage, controlPage, peerFrame };
}

async function postCommand(
  controlPage: BrowserContext,
  command: Record<string, unknown>,
) {
  await controlPage.evaluate((value) => {
    const port = (window as typeof window & { __bridgePort?: MessagePort })
      .__bridgePort;
    if (!port) throw new Error("Bridge port is not connected");
    port.postMessage(value);
  }, command);
}

async function clearMessages(controlPage: BrowserContext) {
  await controlPage.evaluate(() => {
    const state = window as typeof window & { __bridgeMessages?: unknown[] };
    state.__bridgeMessages = [];
  });
}

async function messages(controlPage: BrowserContext) {
  return controlPage.evaluate(() => {
    const state = window as typeof window & { __bridgeMessages?: unknown[] };
    return state.__bridgeMessages || [];
  });
}

async function latestGeometry(
  controlPage: BrowserContext,
  feedbackId: string,
): Promise<SavedGeometry | null> {
  return controlPage.evaluate((expectedId) => {
    const items = (
      window as typeof window & { __bridgeMessages?: Array<any> }
    ).__bridgeMessages;
    for (const message of [...(items || [])].reverse()) {
      if (
        message?.protocol ===
          "shiplet.artifact.saved-targets.geometry.v1" &&
        message?.type === "update"
      ) {
        const target = message.targets?.find(
          (candidate: any) => candidate.feedbackId === expectedId,
        );
        if (target) return target;
      }
    }
    return null;
  }, feedbackId);
}

async function routeMessages(controlPage: BrowserContext) {
  return (await messages(controlPage)).filter(
    (message: any) => message?.protocol === "shiplet.artifact.route.v1",
  ) as Array<{ pageUrl: string }>;
}

async function shortcutMessages(controlPage: BrowserContext) {
  return (await messages(controlPage)).filter(
    (message: any) => message?.protocol === "shiplet.artifact.shortcuts.v1",
  ) as Array<{ action: string }>;
}

async function lifecycleMessages(controlPage: BrowserContext) {
  return (await messages(controlPage)).filter(
    (message: any) => message?.protocol === "shiplet.artifact.lifecycle.v1",
  ) as Array<{ sequence: number }>;
}

async function clearPageKeyEvents(capturePage: BrowserContext) {
  await capturePage.evaluate(() => {
    (
      window as typeof window & {
        __pageKeyEvents?: Array<{ key: string; defaultPrevented: boolean }>;
      }
    ).__pageKeyEvents = [];
  });
}

async function pageKeyEvents(capturePage: BrowserContext) {
  return capturePage.evaluate(
    () =>
      (
        window as typeof window & {
          __pageKeyEvents?: Array<{ key: string; defaultPrevented: boolean }>;
        }
      ).__pageKeyEvents || [],
  );
}

function registration(binding: BridgeBinding) {
  return {
    ...binding,
    protocol: "shiplet.artifact.saved-targets.command.v1",
    type: "replace",
    targets: [
      {
        feedbackId: "feedback_saved",
        selector: "#saved-target",
        expectedTag: "BUTTON",
        relativePoint: { x: 0.25, y: 0.75 },
      },
      { feedbackId: "feedback_offscreen", selector: "#offscreen-target" },
      { feedbackId: "feedback_hidden", selector: "#hidden-target" },
      { feedbackId: "feedback_private", selector: "#private-target" },
      {
        feedbackId: "feedback_tag_mismatch",
        selector: "#saved-target",
        expectedTag: "DIV",
      },
    ],
  };
}

async function replaceChannel(
  page: Page,
  peerFrame: Frame,
  mode: BridgeMode,
  binding: BridgeBinding,
) {
  const fresh = { ...binding, channelNonce: `nonce_fresh_${mode}` };
  if (mode === "hosted") {
    await page.evaluate(
      ({ fresh, artifactOrigin }) => {
        const frame = document.querySelector<HTMLIFrameElement>("#bridge-peer");
        frame?.contentWindow?.postMessage(fresh, artifactOrigin);
      },
      { fresh, artifactOrigin },
    );
  } else {
    await peerFrame.evaluate(
      ({ fresh, customerOrigin }) => {
        parent.postMessage(fresh, customerOrigin);
      },
      { fresh, customerOrigin },
    );
  }
}

async function reconnectChannel(
  page: Page,
  peerFrame: Frame,
  mode: BridgeMode,
  binding: BridgeBinding,
  suffix: string,
) {
  const fresh: BridgeBinding = {
    ...binding,
    channelNonce: `nonce_${suffix}_${mode}`,
  };
  if (mode === "hosted") {
    await page.evaluate(
      async ({ fresh, artifactOrigin }) => {
        const frame = document.querySelector<HTMLIFrameElement>("#bridge-peer");
        if (!frame?.contentWindow) throw new Error("Missing artifact frame");
        const peer = frame.contentWindow;
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(
            () => reject(new Error("Fresh hosted bridge did not become ready")),
            5_000,
          );
          const onMessage = (event: MessageEvent) => {
            if (
              event.source !== peer ||
              event.origin !== artifactOrigin ||
              event.data?.protocol !== fresh.protocol ||
              event.data?.type !== "ready" ||
              event.data?.channelNonce !== fresh.channelNonce
            ) {
              return;
            }
            window.removeEventListener("message", onMessage);
            window.clearTimeout(timer);
            const channel = new MessageChannel();
            const state = window as typeof window & {
              __bridgePort?: MessagePort;
              __bridgeMessages?: unknown[];
            };
            state.__bridgeMessages = [];
            state.__bridgePort = channel.port1;
            channel.port1.addEventListener("message", (portEvent) => {
              state.__bridgeMessages?.push(portEvent.data);
            });
            channel.port1.start();
            peer.postMessage(
              { ...fresh, type: "connect" },
              artifactOrigin,
              [channel.port2],
            );
            resolve();
          };
          window.addEventListener("message", onMessage);
          peer.postMessage(fresh, artifactOrigin);
        });
      },
      { fresh, artifactOrigin },
    );
  } else {
    await peerFrame.evaluate(
      async ({ fresh, customerOrigin }) => {
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(
            () => reject(new Error("Fresh embedded bridge did not become ready")),
            5_000,
          );
          const onMessage = (event: MessageEvent) => {
            if (
              event.source !== parent ||
              event.origin !== customerOrigin ||
              event.data?.protocol !== fresh.protocol ||
              event.data?.type !== "ready" ||
              event.data?.channelNonce !== fresh.channelNonce
            ) {
              return;
            }
            window.removeEventListener("message", onMessage);
            window.clearTimeout(timer);
            const channel = new MessageChannel();
            const state = window as typeof window & {
              __bridgePort?: MessagePort;
              __bridgeMessages?: unknown[];
            };
            state.__bridgeMessages = [];
            state.__bridgePort = channel.port1;
            channel.port1.addEventListener("message", (portEvent) => {
              state.__bridgeMessages?.push(portEvent.data);
            });
            channel.port1.start();
            parent.postMessage(
              { ...fresh, type: "connect" },
              customerOrigin,
              [channel.port2],
            );
            resolve();
          };
          window.addEventListener("message", onMessage);
          parent.postMessage(fresh, customerOrigin);
        });
      },
      { fresh, customerOrigin },
    );
  }
  return fresh;
}

async function bridgeLifecycleState(capturePage: BrowserContext) {
  return capturePage.evaluate(() => {
    const state = (
      window as typeof window & {
        __bridgeLifecycle?: {
          intervals: Set<number>;
          mutationObservers: Set<MutationObserver>;
          resizeObservers: Set<ResizeObserver>;
          layoutObservers: Set<PerformanceObserver>;
        };
      }
    ).__bridgeLifecycle;
    return {
      intervals: state?.intervals.size || 0,
      mutationObservers: state?.mutationObservers.size || 0,
      resizeObservers: state?.resizeObservers.size || 0,
      layoutObservers: state?.layoutObservers.size || 0,
    };
  });
}

for (const mode of ["hosted", "embedded"] as const) {
  test(`${mode} bridge follows saved target geometry and reveals only eligible registered targets`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const { binding, capturePage, controlPage } = await setupBridge(page, mode);
    await capturePage.evaluate(() => {
      const nativeScrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions) {
        (
          window as typeof window & { __lastScrollBehavior?: ScrollBehavior }
        ).__lastScrollBehavior =
          typeof options === "object" ? options.behavior : undefined;
        return nativeScrollIntoView.call(this, options);
      };
    });

    await postCommand(controlPage, registration(binding));
    await expect
      .poll(() => latestGeometry(controlPage, "feedback_saved"))
      .toMatchObject({ eligible: true, offscreen: false });
    const initial = await latestGeometry(controlPage, "feedback_saved");
    expect(initial?.coordinates?.viewportX).toBeCloseTo(
      initial!.targetRect!.left + initial!.targetRect!.width * 0.25,
    );
    expect(initial?.coordinates?.viewportY).toBeCloseTo(
      initial!.targetRect!.top + initial!.targetRect!.height * 0.75,
    );

    await clearMessages(controlPage);
    await capturePage.evaluate(() => {
      const target = document.querySelector<HTMLElement>("#saved-target");
      if (target) {
        target.style.width = "0";
        target.style.height = "0";
        target.style.padding = "0";
        target.style.border = "0";
      }
    });
    await expect
      .poll(() => latestGeometry(controlPage, "feedback_saved"))
      .toEqual({
        feedbackId: "feedback_saved",
        eligible: false,
        offscreen: false,
        coordinates: null,
        targetRect: null,
      });
    await clearMessages(controlPage);
    await capturePage.evaluate(() => {
      const target = document.querySelector<HTMLElement>("#saved-target");
      if (target) {
        target.style.width = "160px";
        target.style.height = "48px";
        target.style.padding = "";
        target.style.border = "";
      }
    });
    await expect
      .poll(() => latestGeometry(controlPage, "feedback_saved"))
      .toMatchObject({ eligible: true, offscreen: false });

    await clearMessages(controlPage);
    await capturePage.evaluate(() => {
      document.querySelector("#saved-target")?.remove();
    });
    await expect
      .poll(() => latestGeometry(controlPage, "feedback_saved"))
      .toEqual({
        feedbackId: "feedback_saved",
        eligible: false,
        offscreen: false,
        coordinates: null,
        targetRect: null,
      });
    await clearMessages(controlPage);
    await capturePage.evaluate(() => {
      const wrap = document.querySelector<HTMLElement>("#target-wrap");
      const target = document.createElement("button");
      target.id = "saved-target";
      target.type = "button";
      target.style.cssText = "width:160px;height:48px";
      target.textContent = "Restored target";
      wrap?.appendChild(target);
    });
    await expect
      .poll(() => latestGeometry(controlPage, "feedback_saved"))
      .toMatchObject({ eligible: true, offscreen: false });
    expect(await latestGeometry(controlPage, "feedback_offscreen")).toMatchObject(
      { eligible: true, offscreen: true },
    );
    expect(await latestGeometry(controlPage, "feedback_hidden")).toEqual({
      feedbackId: "feedback_hidden",
      eligible: false,
      offscreen: false,
      coordinates: null,
      targetRect: null,
    });
    expect(await latestGeometry(controlPage, "feedback_private")).toEqual({
      feedbackId: "feedback_private",
      eligible: false,
      offscreen: false,
      coordinates: null,
      targetRect: null,
    });
    expect(await latestGeometry(controlPage, "feedback_tag_mismatch")).toEqual({
      feedbackId: "feedback_tag_mismatch",
      eligible: false,
      offscreen: false,
      coordinates: null,
      targetRect: null,
    });
    expect(JSON.stringify(await messages(controlPage))).not.toContain(
      "Saved target",
    );

    await clearMessages(controlPage);
    await capturePage.evaluate(() => {
      const spacer = document.querySelector<HTMLElement>("#spacer");
      if (spacer) spacer.style.height = "300px";
    });
    await expect
      .poll(() => latestGeometry(controlPage, "feedback_saved"))
      .toMatchObject({ eligible: true });
    const shifted = await latestGeometry(controlPage, "feedback_saved");
    expect(shifted!.targetRect!.top).toBeGreaterThan(
      initial!.targetRect!.top + 150,
    );

    await clearMessages(controlPage);
    await capturePage.evaluate(() => {
      const target = document.querySelector("#saved-target");
      if (!target) throw new Error("Missing saved target");
      target.outerHTML =
        '<button id="saved-target" type="button" style="margin-left:140px;width:160px;height:48px">Replacement target</button>';
    });
    await expect
      .poll(() => latestGeometry(controlPage, "feedback_saved"))
      .toMatchObject({ eligible: true });
    const replaced = await latestGeometry(controlPage, "feedback_saved");
    expect(replaced!.targetRect!.left).toBeGreaterThan(
      initial!.targetRect!.left + 100,
    );

    await clearMessages(controlPage);
    await capturePage.evaluate(() => {
      const wrap = document.querySelector<HTMLElement>("#target-wrap");
      if (wrap) wrap.style.visibility = "hidden";
    });
    await expect
      .poll(() => latestGeometry(controlPage, "feedback_saved"))
      .toEqual({
        feedbackId: "feedback_saved",
        eligible: false,
        offscreen: false,
        coordinates: null,
        targetRect: null,
      });
    await clearMessages(controlPage);
    await capturePage.evaluate(() => {
      const wrap = document.querySelector<HTMLElement>("#target-wrap");
      if (wrap) wrap.style.visibility = "visible";
    });
    await expect
      .poll(() => latestGeometry(controlPage, "feedback_saved"))
      .toMatchObject({ eligible: true, offscreen: false });

    await postCommand(controlPage, {
      ...binding,
      protocol: "shiplet.artifact.follow.command.v1",
      type: "scroll",
      scrollX: 0,
      scrollY: 20,
    });
    await clearMessages(controlPage);
    await postCommand(controlPage, {
      ...binding,
      protocol: "shiplet.artifact.saved-target.reveal.v1",
      type: "reveal",
      feedbackId: "feedback_offscreen",
    });
    await expect
      .poll(() =>
        capturePage.evaluate(() => ({
          scrollY: window.scrollY,
          behavior: (
            window as typeof window & { __lastScrollBehavior?: string }
          ).__lastScrollBehavior,
        })),
      )
      .toMatchObject({ behavior: "auto" });
    await expect
      .poll(() => latestGeometry(controlPage, "feedback_offscreen"))
      .toMatchObject({ eligible: true, offscreen: false });
    expect(
      (await messages(controlPage)).filter(
        (message: any) =>
          message?.protocol === "shiplet.artifact.follow.v1" &&
          message?.type === "interrupt",
      ),
    ).toHaveLength(1);

    await capturePage.evaluate(() => window.scrollTo(0, 0));
    await expect
      .poll(() => capturePage.evaluate(() => window.scrollY))
      .toBe(0);
    await clearMessages(controlPage);
    for (const feedbackId of [
      "feedback_hidden",
      "feedback_private",
      "feedback_unknown",
    ]) {
      await postCommand(controlPage, {
        ...binding,
        protocol: "shiplet.artifact.saved-target.reveal.v1",
        type: "reveal",
        feedbackId,
      });
    }
    await page.waitForTimeout(200);
    expect(await capturePage.evaluate(() => window.scrollY)).toBe(0);
  });

  test(`${mode} bridge invalidates route state and relays only enabled trusted shortcuts`, async ({
    page,
  }) => {
    const { binding, capturePage, controlPage, peerFrame } = await setupBridge(
      page,
      mode,
    );
    await postCommand(controlPage, registration(binding));
    await expect
      .poll(() => latestGeometry(controlPage, "feedback_saved"))
      .toMatchObject({ eligible: true });

    await clearMessages(controlPage);
    await capturePage.locator("#plain-button").focus();
    await page.keyboard.press("c");
    expect(await shortcutMessages(controlPage)).toEqual([]);
    expect(
      await capturePage.evaluate(
        () =>
          (
            window as typeof window & {
              __pageKeyEvents?: Array<{ key: string }>;
            }
          ).__pageKeyEvents?.at(-1)?.key,
      ),
    ).toBe("c");

    await postCommand(controlPage, {
      ...binding,
      protocol: "shiplet.artifact.shortcuts.command.v1",
      type: "enable",
    });
    await page.waitForTimeout(50);
    await clearMessages(controlPage);
    await clearPageKeyEvents(capturePage);
    await capturePage.locator("#plain-button").focus();
    await page.keyboard.press("c");
    await page.keyboard.press("Escape");
    await expect.poll(() => shortcutMessages(controlPage)).toEqual([
      { ...binding, protocol: "shiplet.artifact.shortcuts.v1", type: "action", action: "comment" },
      { ...binding, protocol: "shiplet.artifact.shortcuts.v1", type: "action", action: "cancel" },
    ]);

    await clearMessages(controlPage);
    await capturePage.locator("#editor").focus();
    await page.keyboard.type("c");
    await page.keyboard.press("Escape");
    expect(await shortcutMessages(controlPage)).toEqual([]);
    expect(await capturePage.locator("#editor").inputValue()).toBe("c");

    const shadowEditors = [
      {
        name: "open custom-element input",
        focus: () =>
          capturePage.locator("#open-shadow-editor").evaluate((host) =>
            (host.shadowRoot?.querySelector("input") as HTMLInputElement).focus(),
          ),
        value: () =>
          capturePage.locator("#open-shadow-editor").evaluate((host) =>
            (host.shadowRoot?.querySelector("input") as HTMLInputElement).value,
          ),
      },
      {
        name: "closed custom-element input",
        focus: () =>
          capturePage.locator("#closed-shadow-editor").evaluate((host) =>
            (host as HTMLElement & { focusEditor: () => void }).focusEditor(),
          ),
        value: () =>
          capturePage.locator("#closed-shadow-editor").evaluate((host) =>
            (host as HTMLElement & { editorValue: () => string }).editorValue(),
          ),
      },
      {
        name: "closed ordinary div input",
        focus: () =>
          capturePage.evaluate(() =>
            (
              window as typeof window & { __closedDivEditor?: HTMLInputElement }
            ).__closedDivEditor?.focus(),
          ),
        value: () =>
          capturePage.evaluate(
            () =>
              (
                window as typeof window & {
                  __closedDivEditor?: HTMLInputElement;
                }
              ).__closedDivEditor?.value || "",
          ),
      },
    ];
    for (const editor of shadowEditors) {
      await clearMessages(controlPage);
      await editor.focus();
      await page.keyboard.type("c");
      await page.keyboard.press("Escape");
      expect(await shortcutMessages(controlPage), editor.name).toEqual([]);
      expect(await editor.value(), editor.name).toBe("c");
    }

    await clearMessages(controlPage);
    await capturePage.locator("#content-editor").focus();
    await page.keyboard.type("c");
    await page.keyboard.press("Escape");
    expect(await shortcutMessages(controlPage)).toEqual([]);
    await expect(capturePage.locator("#content-editor")).toContainText("c");

    await clearMessages(controlPage);
    await clearPageKeyEvents(capturePage);
    await capturePage.locator("#open-shadow-button").evaluate((host) =>
      (host.shadowRoot?.querySelector("button") as HTMLButtonElement).focus(),
    );
    await page.keyboard.press("c");
    await page.keyboard.press("Escape");
    await expect.poll(() => shortcutMessages(controlPage)).toEqual([
      { ...binding, protocol: "shiplet.artifact.shortcuts.v1", type: "action", action: "comment" },
      { ...binding, protocol: "shiplet.artifact.shortcuts.v1", type: "action", action: "cancel" },
    ]);
    expect(await pageKeyEvents(capturePage)).toEqual([
      { key: "c", defaultPrevented: false },
      { key: "Escape", defaultPrevented: false },
    ]);

    await capturePage.evaluate(() => {
      const state = window as typeof window & {
        Image: typeof Image;
        __nativeImage?: typeof Image;
      };
      const NativeImage = state.Image;
      state.__nativeImage = NativeImage;
      state.Image = class DelayedRouteImage extends NativeImage {
        override set src(value: string) {
          const onload = this.onload;
          this.onload = null;
          this.addEventListener(
            "load",
            () => window.setTimeout(() => onload?.call(this, new Event("load")), 350),
            { once: true },
          );
          super.src = value;
        }
        override get src() {
          return super.src;
        }
      } as typeof Image;
    });
    await postCommand(controlPage, {
      ...binding,
      protocol: "shiplet.artifact.capture.command.v1",
      type: "start",
      requestId: `capture_route_${mode}`,
    });
    await capturePage.locator("#saved-target").click({ position: { x: 20, y: 20 } });
    await clearMessages(controlPage);
    await capturePage.evaluate(() => {
      history.pushState(
        {},
        "",
        "/next?tab=details&token=remove-me#/panel?password=remove-me&view=wide",
      );
    });
    await expect.poll(() => routeMessages(controlPage)).toHaveLength(1);
    const pushed = (await routeMessages(controlPage))[0];
    expect(pushed.pageUrl).toContain("/next?tab=details#/panel?view=wide");
    expect(JSON.stringify(pushed)).not.toMatch(/token|password|remove-me/i);
    await page.waitForTimeout(450);
    expect(
      (await messages(controlPage)).filter(
        (message: any) =>
          message?.protocol === "shiplet.artifact.capture.result.v1",
      ),
    ).toEqual([]);
    await capturePage.evaluate(() => {
      const state = window as typeof window & {
        Image: typeof Image;
        __nativeImage?: typeof Image;
      };
      if (state.__nativeImage) state.Image = state.__nativeImage;
    });

    await clearMessages(controlPage);
    await capturePage.evaluate(() => {
      const target = document.querySelector<HTMLElement>("#saved-target");
      if (target) target.style.marginLeft = "240px";
    });
    await page.waitForTimeout(250);
    expect(
      (await messages(controlPage)).filter(
        (message: any) =>
          message?.protocol ===
          "shiplet.artifact.saved-targets.geometry.v1",
      ),
    ).toEqual([]);
    await capturePage.evaluate(() => window.scrollTo(0, 0));
    await clearMessages(controlPage);
    await postCommand(controlPage, {
      ...binding,
      protocol: "shiplet.artifact.saved-target.reveal.v1",
      type: "reveal",
      feedbackId: "feedback_offscreen",
    });
    await page.waitForTimeout(200);
    expect(await capturePage.evaluate(() => window.scrollY)).toBe(0);

    await clearMessages(controlPage);
    await capturePage.evaluate(() => {
      history.replaceState({}, "", "/replaced?state=remove-me&mode=compact");
    });
    await expect.poll(() => routeMessages(controlPage)).toHaveLength(1);
    expect((await routeMessages(controlPage))[0].pageUrl).toContain(
      "/replaced?mode=compact",
    );
    await page.waitForTimeout(250);
    expect(await routeMessages(controlPage)).toHaveLength(1);

    await clearMessages(controlPage);
    await capturePage.evaluate(() => history.back());
    await expect.poll(() => routeMessages(controlPage)).toHaveLength(1);

    await clearMessages(controlPage);
    await capturePage.evaluate(() => {
      location.hash = "/panel?code=remove-me&view=grid";
    });
    await expect.poll(() => routeMessages(controlPage)).toHaveLength(1);
    const hashRoute = (await routeMessages(controlPage))[0];
    expect(hashRoute.pageUrl).toContain("#/panel?view=grid");
    expect(JSON.stringify(hashRoute)).not.toMatch(/code|remove-me/i);

    await clearMessages(controlPage);
    await capturePage.locator("#plain-button").focus();
    await page.keyboard.press("c");
    await expect.poll(() => shortcutMessages(controlPage)).toHaveLength(1);

    await postCommand(controlPage, registration(binding));
    await expect
      .poll(() => latestGeometry(controlPage, "feedback_saved"))
      .toMatchObject({ eligible: true });
    await clearMessages(controlPage);
    if (mode === "embedded") {
      await page.evaluate(() => {
        (
          window as typeof window & { __cleanupBridge?: () => void }
        ).__cleanupBridge?.();
      });
    } else {
      await replaceChannel(page, peerFrame, mode, binding);
    }
    await page.waitForTimeout(100);
    await capturePage.evaluate(() => {
      const target = document.querySelector<HTMLElement>("#saved-target");
      if (target) target.style.marginLeft = "320px";
    });
    await capturePage.locator("#plain-button").focus();
    await page.keyboard.press("c");
    await postCommand(controlPage, {
      ...binding,
      protocol: "shiplet.artifact.saved-target.reveal.v1",
      type: "reveal",
      feedbackId: "feedback_offscreen",
    });
    await page.waitForTimeout(250);
    expect(await messages(controlPage)).toEqual([]);

  });

test(`${mode} bridge leases new authority while legacy capture and follow remain compatible`, async ({
    page,
  }) => {
    const { binding, capturePage, controlPage, peerFrame } = await setupBridge(
      page,
      mode,
    );

    await page.waitForTimeout(3_200);
    await postCommand(controlPage, {
      ...binding,
      protocol: "shiplet.artifact.capture.command.v1",
      type: "start",
      requestId: `legacy_capture_${mode}`,
});

    await capturePage.locator("#plain-button").click({
      position: { x: 16, y: 16 },
    });
    await expect
      .poll(async () =>
        (await messages(controlPage)).filter(
          (message: any) =>
            message?.protocol === "shiplet.artifact.capture.result.v1" &&
            message?.requestId === `legacy_capture_${mode}`,
        ),
      )
      .toHaveLength(1);
    await postCommand(controlPage, {
      ...binding,
      protocol: "shiplet.artifact.capture.command.v1",
      type: "release",
      requestId: `legacy_capture_${mode}`,
    });
    await postCommand(controlPage, {
      ...binding,
      protocol: "shiplet.artifact.follow.command.v1",
      type: "scroll",
      scrollX: 0,
      scrollY: 40,
    });
    await expect
      .poll(() => capturePage.evaluate(() => Math.round(window.scrollY)))
      .toBe(40);

    await capturePage.evaluate(() => window.scrollTo(0, 0));
    await postCommand(controlPage, registration(binding));
    await postCommand(controlPage, {
      ...binding,
      protocol: "shiplet.artifact.shortcuts.command.v1",
      type: "enable",
    });
    await clearMessages(controlPage);
    await postCommand(controlPage, {
      ...binding,
      protocol: "shiplet.artifact.lifecycle.command.v1",
      type: "renew",
      sequence: 1,
    });
    await expect.poll(() => lifecycleMessages(controlPage)).toEqual([
      {
        ...binding,
        protocol: "shiplet.artifact.lifecycle.v1",
        type: "alive",
        sequence: 1,
      },
    ]);
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    await clearMessages(controlPage);
    await postCommand(controlPage, {
      ...binding,
      protocol: "shiplet.artifact.lifecycle.command.v1",
      type: "renew",
      sequence: 2,
    });
    await expect.poll(() => lifecycleMessages(controlPage)).toEqual([
      {
        ...binding,
        protocol: "shiplet.artifact.lifecycle.v1",
        type: "alive",
        sequence: 2,
      },
    ]);
    await page.waitForTimeout(1_000);
    await clearMessages(controlPage);
    await capturePage.evaluate(() => {
      const target = document.querySelector<HTMLElement>("#saved-target");
      if (target) target.style.marginLeft = "180px";
    });
    await expect
      .poll(() => latestGeometry(controlPage, "feedback_saved"))
      .toMatchObject({ eligible: true });

    await capturePage.evaluate(() => {
      const state = window as typeof window & {
        Image: typeof Image;
        __nativeLeaseImage?: typeof Image;
      };
      const NativeImage = state.Image;
      state.__nativeLeaseImage = NativeImage;
      state.Image = class DelayedLeaseImage extends NativeImage {
        override set src(value: string) {
          const onload = this.onload;
          this.onload = null;
          this.addEventListener(
            "load",
            () =>
              window.setTimeout(
                () => onload?.call(this, new Event("load")),
                2_500,
              ),
            { once: true },
          );
          super.src = value;
        }
        override get src() {
          return super.src;
        }
      } as typeof Image;
    });
    await postCommand(controlPage, {
      ...binding,
      protocol: "shiplet.artifact.capture.command.v1",
      type: "start",
      requestId: `expiring_capture_${mode}`,
    });
    await capturePage.locator("#saved-target").click({
      position: { x: 20, y: 20 },
    });
    await clearMessages(controlPage);
    for (const invalidRenew of [
      { ...binding, type: "renew", sequence: 2 },
      { ...binding, type: "renew", sequence: 1 },
      { ...binding, type: "renew", sequence: 3, unexpected: true },
      { ...binding, channelNonce: "nonce_stale", type: "renew", sequence: 3 },
      { ...binding, type: "renew", sequence: 2 ** 31 },
    ]) {
      await postCommand(controlPage, {
        ...invalidRenew,
        protocol: "shiplet.artifact.lifecycle.command.v1",
      });
    }
    await page.waitForTimeout(2_700);
    expect(await lifecycleMessages(controlPage)).toEqual([]);
    expect(
      (await messages(controlPage)).filter(
        (message: any) =>
          message?.protocol === "shiplet.artifact.capture.result.v1" &&
          message?.requestId === `expiring_capture_${mode}`,
      ),
    ).toEqual([]);
    await capturePage.evaluate(() => {
      const state = window as typeof window & {
        Image: typeof Image;
        __nativeLeaseImage?: typeof Image;
      };
      if (state.__nativeLeaseImage) state.Image = state.__nativeLeaseImage;
    });
    await clearPageKeyEvents(capturePage);
    await capturePage.locator("#plain-button").focus();
    await page.keyboard.press("c");
    expect(await pageKeyEvents(capturePage)).toEqual([
      { key: "c", defaultPrevented: false },
    ]);
    await expect.poll(() => bridgeLifecycleState(capturePage)).toEqual({
      intervals: 0,
      mutationObservers: 0,
      resizeObservers: 0,
      layoutObservers: 0,
    });

    const explicitBinding = await reconnectChannel(
      page,
      peerFrame,
      mode,
      binding,
      "explicit_disconnect",
    );
    await postCommand(controlPage, registration(explicitBinding));
    await postCommand(controlPage, {
      ...explicitBinding,
      protocol: "shiplet.artifact.shortcuts.command.v1",
      type: "enable",
    });
    await postCommand(controlPage, {
      ...explicitBinding,
      protocol: "shiplet.artifact.lifecycle.command.v1",
      type: "renew",
      sequence: 1,
    });
    await expect.poll(() => lifecycleMessages(controlPage)).toContainEqual({
      ...explicitBinding,
      protocol: "shiplet.artifact.lifecycle.v1",
      type: "alive",
      sequence: 1,
    });
    await clearMessages(controlPage);
    await postCommand(controlPage, {
      ...explicitBinding,
      protocol: "shiplet.artifact.lifecycle.command.v1",
      type: "disconnect",
    });
    await expect.poll(() => bridgeLifecycleState(capturePage)).toEqual({
      intervals: 0,
      mutationObservers: 0,
      resizeObservers: 0,
      layoutObservers: 0,
    });
    await clearPageKeyEvents(capturePage);
    await capturePage.locator("#plain-button").focus();
    await page.keyboard.press("c");
    expect(await pageKeyEvents(capturePage)).toEqual([
      { key: "c", defaultPrevented: false },
    ]);
    expect(await shortcutMessages(controlPage)).toEqual([]);

    const closedBinding = await reconnectChannel(
      page,
      peerFrame,
      mode,
      binding,
      "controller_close",
    );
    await postCommand(controlPage, registration(closedBinding));
    await postCommand(controlPage, {
      ...closedBinding,
      protocol: "shiplet.artifact.shortcuts.command.v1",
      type: "enable",
    });
    await postCommand(controlPage, {
      ...closedBinding,
      protocol: "shiplet.artifact.lifecycle.command.v1",
      type: "renew",
      sequence: 1,
    });
    await expect.poll(() => lifecycleMessages(controlPage)).toContainEqual({
      ...closedBinding,
      protocol: "shiplet.artifact.lifecycle.v1",
      type: "alive",
      sequence: 1,
    });
    await controlPage.evaluate(() => {
      (
        window as typeof window & { __bridgePort?: MessagePort }
      ).__bridgePort?.close();
    });
    await clearPageKeyEvents(capturePage);
    await capturePage.locator("#plain-button").focus();
    await page.keyboard.press("c");
    expect(await pageKeyEvents(capturePage)).toEqual([
      { key: "c", defaultPrevented: false },
    ]);
    for (let activity = 0; activity < 4; activity += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 850));
      await capturePage.evaluate((step) => {
        const target = document.querySelector<HTMLElement>("#saved-target");
        if (target) target.style.marginLeft = `${210 + step * 10}px`;
      }, activity);
      await page.keyboard.press("c");
    }
    expect(await pageKeyEvents(capturePage)).toEqual(
      Array.from({ length: 5 }, () => ({
        key: "c",
        defaultPrevented: false,
      })),
    );
    await expect.poll(() => bridgeLifecycleState(capturePage)).toEqual({
      intervals: 0,
      mutationObservers: 0,
      resizeObservers: 0,
      layoutObservers: 0,
    });
  });
}

test("mutant probe fences stale channel commands in hosted and embedded bridges", async ({ page }) => {
  for (const mode of ["hosted", "embedded"] as const) {
    const probePage = await page.context().newPage();
    const { binding, capturePage, controlPage, peerFrame } = await setupBridge(probePage, mode);
    await postCommand(controlPage, registration(binding));
    await expect.poll(() => latestGeometry(controlPage, "feedback_saved")).toMatchObject({ eligible: true });
    await reconnectChannel(probePage, peerFrame, mode, binding, "mutant_probe_fresh");

    await clearMessages(controlPage);
    await postCommand(controlPage, registration(binding));
    await probePage.waitForTimeout(250);
    expect(await latestGeometry(controlPage, "feedback_saved")).toBeNull();

    await clearMessages(controlPage);
    await postCommand(controlPage, { ...binding, protocol: "shiplet.artifact.shortcuts.command.v1", type: "enable" });
    await capturePage.locator("#plain-button").focus();
    await probePage.keyboard.press("c");
    await probePage.waitForTimeout(250);
    expect(await shortcutMessages(controlPage)).toEqual([]);

    await clearMessages(controlPage);
    await postCommand(controlPage, { ...binding, protocol: "shiplet.artifact.lifecycle.command.v1", type: "renew", sequence: 1 });
    await probePage.waitForTimeout(250);
    expect(await lifecycleMessages(controlPage)).toEqual([]);
    await probePage.close();
  }
});
