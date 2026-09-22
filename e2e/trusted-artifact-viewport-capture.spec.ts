import {
  expect,
  test,
  type Frame,
  type Locator,
  type Page,
} from "@playwright/test";

import { trustedArtifactBridgeScript } from "../src/trusted-artifact-bridge";

test.use({
  viewport: { width: 900, height: 700 },
  deviceScaleFactor: 2,
  screenshot: "off",
  trace: "off",
  video: "off",
});

const customerOrigin = "https://capture-customer.test";
const artifactOrigin = "https://capture-artifact.test";
const shipletOrigin = "https://capture-shiplet.test";

type BridgeMode = "hosted" | "embedded";
type BrowserContext = Page | Frame;

type CaptureResult = {
  protocol: string;
  requestId: string;
  status: string;
  payload: {
    screenshotDataUrl: string | null;
    screenshotFailureNote: string | null;
    viewport: {
      width: number;
      height: number;
      devicePixelRatio: number;
    };
    captureContext: {
      documentWidth: number;
      documentHeight: number;
      scrollX: number;
      scrollY: number;
    };
  };
};

const captureFixture = String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html,body{margin:0;background:#fff}
    body{position:relative;width:1800px;height:2400px;overflow:visible}
    .viewport-marker{position:absolute;width:100vw;height:100vh}
    #top-marker{left:0;top:0;background:rgb(210,30,30)}
    #lower-marker{left:640px;top:1120px;background:rgb(30,180,90)}
    #top-target,#lower-target{position:absolute;width:120px;height:48px;border:0;background:rgb(20,30,40);color:#fff}
    #top-target{left:250px;top:170px}
    #lower-target{left:890px;top:1290px}
    #private-marker{position:absolute;left:720px;top:1180px;width:60px;height:60px;background:rgb(255,0,255)}
    #editable-marker{position:absolute;left:800px;top:1180px;width:60px;height:60px;border:0;padding:0;background:rgb(0,0,255);color:transparent}
    #raster-target{position:absolute;left:320px;top:80px;width:80px;height:80px}
    #bridge-peer{position:fixed;right:0;bottom:0;width:1px;height:1px;border:0}
  </style>
</head>
<body>
  <div id="top-marker" class="viewport-marker" aria-label="red top viewport"></div>
  <button id="top-target" type="button">Top target</button>
  <div id="lower-marker" class="viewport-marker" aria-label="green lower viewport"></div>
  <div id="private-marker" data-shiplet-private>Private marker</div>
  <input id="editable-marker" value="private editable value">
  <button id="lower-target" type="button">Lower target</button>
  <img id="raster-target" data-shiplet-raster-capture alt="Raster target">
</body>
</html>`;

const offer = (mode: BridgeMode) => ({
  protocol: "shiplet.artifact.channel.v1",
  type: "offer",
  channelNonce: `nonce_capture_${mode}`,
  shipletId: "shiplet_capture",
  revisionId: "revision_capture",
});

function peerDocument() {
  return "<!doctype html><html><body>Trusted bridge peer</body></html>";
}

async function setupBridge(page: Page, mode: BridgeMode) {
  const peerOrigin = mode === "hosted" ? artifactOrigin : shipletOrigin;
  const pageBody =
    mode === "hosted"
      ? `<!doctype html><iframe id="bridge-peer" src="${artifactOrigin}/artifact" style="width:520px;height:360px;border:0"></iframe>`
      : captureFixture.replace(
          "</body>",
          `<iframe id="bridge-peer" src="${shipletOrigin}/review-host"></iframe></body>`,
        );

  await page.route(`${customerOrigin}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: pageBody }),
  );
  await page.route(`${artifactOrigin}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: captureFixture }),
  );
  await page.route(`${shipletOrigin}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: peerDocument() }),
  );
  await page.goto(`${customerOrigin}/`, { waitUntil: "domcontentloaded" });

  await expect
    .poll(() =>
      page.frames().some((frame) => frame.url().startsWith(peerOrigin)),
    )
    .toBe(true);
  const peerFrame = page
    .frames()
    .find((frame) => frame.url().startsWith(peerOrigin));
  expect(peerFrame).toBeDefined();
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
              __capturePort?: MessagePort;
              __captureResults?: unknown[];
            };
            state.__captureResults = [];
            state.__capturePort = channel.port1;
            channel.port1.addEventListener("message", (portEvent) => {
              state.__captureResults?.push(portEvent.data);
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
              __capturePort?: MessagePort;
              __captureResults?: unknown[];
            };
            state.__captureResults = [];
            state.__capturePort = channel.port1;
            channel.port1.addEventListener("message", (portEvent) => {
              state.__captureResults?.push(portEvent.data);
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

  return { binding, capturePage, controlPage };
}

async function capture(
  controlPage: BrowserContext,
  target: Locator,
  binding: ReturnType<typeof offer>,
  requestId: string,
  afterClick?: () => Promise<void>,
) {
  await controlPage.evaluate(
    ({ binding, requestId }) => {
      const port = (
        window as typeof window & { __capturePort?: MessagePort }
      ).__capturePort;
      if (!port) throw new Error("Capture port is not connected");
      port.postMessage({
        ...binding,
        protocol: "shiplet.artifact.capture.command.v1",
        type: "start",
        requestId,
      });
    },
    { binding, requestId },
  );
  await target.click({ position: { x: 20, y: 20 } });
  await afterClick?.();
  await expect
    .poll(() =>
      controlPage.evaluate((expectedRequestId) => {
        const results = (
          window as typeof window & { __captureResults?: CaptureResult[] }
        ).__captureResults;
        return results?.some(
          (result) =>
            result.protocol === "shiplet.artifact.capture.result.v1" &&
            result.requestId === expectedRequestId,
        );
      }, requestId),
    )
    .toBe(true);
  const result = await controlPage.evaluate((expectedRequestId) => {
    const results = (
      window as typeof window & { __captureResults?: CaptureResult[] }
    ).__captureResults;
    return results?.find(
      (candidate) =>
        candidate.protocol === "shiplet.artifact.capture.result.v1" &&
        candidate.requestId === expectedRequestId,
    );
  }, requestId);
  if (!result) throw new Error(`Missing capture result ${requestId}`);
  return result;
}

async function decodePng(
  page: Page,
  dataUrl: string,
  samples: Array<{ x: number; y: number }>,
) {
  return page.evaluate(
    async ({ dataUrl, samples }) => {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Capture image did not load"));
        image.src = dataUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Capture image canvas is unavailable");
      context.drawImage(image, 0, 0);
      return {
        width: canvas.width,
        height: canvas.height,
        pixels: samples.map(({ x, y }) =>
          Array.from(context.getImageData(x, y, 1, 1).data),
        ),
      };
    },
    { dataUrl, samples },
  );
}

function expectColor(
  actual: number[],
  expected: [number, number, number, number],
) {
  expect(actual).toHaveLength(4);
  expected.forEach((value, index) =>
    expect(actual[index]).toBeGreaterThanOrEqual(value - 2),
  );
  expected.forEach((value, index) =>
    expect(actual[index]).toBeLessThanOrEqual(value + 2),
  );
}

for (const mode of ["hosted", "embedded"] as const) {
  test(`${mode} capture rasterizes the selected scroll viewport without mutating the reviewed page`, async ({
    page,
  }) => {
    const requestsDuringCapture: string[] = [];
    const { binding, capturePage, controlPage } = await setupBridge(page, mode);
    page.on("request", (request) => requestsDuringCapture.push(request.url()));

    await capturePage.evaluate(() => {
      const raster = document.querySelector<HTMLImageElement>("#raster-target");
      if (!raster) throw new Error("Missing raster target");
      const canvas = document.createElement("canvas");
      canvas.width = 8;
      canvas.height = 8;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Missing raster fixture canvas");
      context.fillStyle = "rgb(35,90,220)";
      context.fillRect(0, 0, canvas.width, canvas.height);
      raster.src = canvas.toDataURL("image/png");
      (window as typeof window & { __probeCount?: number }).__probeCount = 0;
      window.addEventListener("shiplet-capture-probe", () => {
        const state = window as typeof window & { __probeCount?: number };
        state.__probeCount = (state.__probeCount || 0) + 1;
      });
    });

    await capturePage.evaluate(() => window.scrollTo(0, 0));
    await capturePage.locator("#top-target").focus();
    requestsDuringCapture.length = 0;
    const top = await capture(
      controlPage,
      capturePage.locator("#top-target"),
      binding,
      `capture_top_${mode}`,
    );
    expect(top.payload.screenshotFailureNote).toBeNull();
    expect(top.payload.screenshotDataUrl).toMatch(/^data:image\/png;base64,/);
    const topDecoded = await decodePng(page, top.payload.screenshotDataUrl!, [
      { x: 100, y: 100 },
    ]);
    expectColor(topDecoded.pixels[0], [210, 30, 30, 255]);

    await capturePage.evaluate(() => window.scrollTo(640, 1120));
    await expect
      .poll(() =>
        capturePage.evaluate(() => ({ x: window.scrollX, y: window.scrollY })),
      )
      .toEqual({ x: 640, y: 1120 });
    await capturePage.locator("#lower-target").focus();
    const before = await capturePage.evaluate(() => {
      const target = document.querySelector("#lower-target");
      if (!target) throw new Error("Missing lower target");
      const rect = target.getBoundingClientRect();
      return {
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        activeId: (document.activeElement as HTMLElement | null)?.id,
        targetText: target.textContent,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        },
      };
    });
    requestsDuringCapture.length = 0;
    const lower = await capture(
      controlPage,
      capturePage.locator("#lower-target"),
      binding,
      `capture_lower_${mode}`,
    );

    expect(lower.payload.screenshotFailureNote).toBeNull();
    expect(lower.payload.screenshotDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(lower.payload.captureContext).toMatchObject({
      scrollX: 640,
      scrollY: 1120,
    });
    expect(lower.payload.viewport).toEqual(before.viewport);
    const lowerDecoded = await decodePng(page, lower.payload.screenshotDataUrl!, [
      { x: 400, y: 300 },
      { x: 100, y: 80 },
      { x: 180, y: 80 },
    ]);
    expect(lowerDecoded.width).toBe(before.viewport.width);
    expect(lowerDecoded.height).toBe(before.viewport.height);
    expectColor(lowerDecoded.pixels[0], [30, 180, 90, 255]);
    expectColor(lowerDecoded.pixels[1], [30, 180, 90, 255]);
    expectColor(lowerDecoded.pixels[2], [30, 180, 90, 255]);

    const after = await capturePage.evaluate(() => {
      const target = document.querySelector("#lower-target");
      if (!target) throw new Error("Missing lower target");
      const rect = target.getBoundingClientRect();
      window.dispatchEvent(new Event("shiplet-capture-probe"));
      return {
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        activeId: (document.activeElement as HTMLElement | null)?.id,
        targetText: target.textContent,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        probeCount: (window as typeof window & { __probeCount?: number })
          .__probeCount,
      };
    });
    expect(after).toEqual({
      scrollX: before.scrollX,
      scrollY: before.scrollY,
      activeId: before.activeId,
      targetText: before.targetText,
      rect: before.rect,
      probeCount: 1,
    });
    expect(requestsDuringCapture).toEqual([]);

    await capturePage.evaluate(() => {
      const state = window as typeof window & {
        Image: typeof Image;
        __nativeImage?: typeof Image;
      };
      const NativeImage = state.Image;
      state.__nativeImage = NativeImage;
      state.Image = class DelayedCaptureImage extends NativeImage {
        override set src(value: string) {
          const onload = this.onload;
          this.onload = null;
          this.addEventListener(
            "load",
            () => window.setTimeout(() => onload?.call(this, new Event("load")), 100),
            { once: true },
          );
          super.src = value;
        }
        override get src() {
          return super.src;
        }
      } as typeof Image;
    });
    const scrollRace = await capture(
      controlPage,
      capturePage.locator("#lower-target"),
      binding,
      `capture_scroll_race_${mode}`,
      () => capturePage.evaluate(() => window.scrollTo(0, 0)),
    );
    await capturePage.evaluate(() => {
      const state = window as typeof window & {
        Image: typeof Image;
        __nativeImage?: typeof Image;
      };
      if (state.__nativeImage) state.Image = state.__nativeImage;
    });
    expect(scrollRace.payload.captureContext).toMatchObject({
      scrollX: 640,
      scrollY: 1120,
    });
    const scrollRaceDecoded = await decodePng(
      page,
      scrollRace.payload.screenshotDataUrl!,
      [{ x: 400, y: 300 }],
    );
    expectColor(scrollRaceDecoded.pixels[0], [30, 180, 90, 255]);

    await capturePage.locator("#raster-target").focus();
    const raster = await capture(
      controlPage,
      capturePage.locator("#raster-target"),
      binding,
      `capture_raster_${mode}`,
    );
    expect(raster.payload.screenshotFailureNote).toBeNull();
    const rasterDecoded = await decodePng(
      page,
      raster.payload.screenshotDataUrl!,
      [{ x: 340, y: 100 }],
    );
    expectColor(rasterDecoded.pixels[0], [35, 90, 220, 255]);

    await capturePage.evaluate(() => {
      const state = window as typeof window & {
        Image: typeof Image;
        __nativeImage?: typeof Image;
      };
      state.__nativeImage = state.Image;
      state.Image = class BrokenCaptureImage {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onerror?.());
        }
      } as unknown as typeof Image;
    });
    const failed = await capture(
      controlPage,
      capturePage.locator("#top-target"),
      binding,
      `capture_failure_${mode}`,
    );
    expect(failed.payload.screenshotFailureNote).toContain(
      "Artifact DOM capture could not render",
    );
    expect(failed.payload.screenshotDataUrl).toMatch(/^data:image\/png;base64,/);
    await capturePage.evaluate(() => {
      const state = window as typeof window & {
        Image: typeof Image;
        __nativeImage?: typeof Image;
      };
      if (state.__nativeImage) state.Image = state.__nativeImage;
    });
  });
}
