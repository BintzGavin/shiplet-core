import { expect, test, type Page } from "@playwright/test";

import {
  reviewAnnotationEditorScript,
  reviewAnnotationEditorStyles,
} from "../src/review-annotation-editor";

test.use({
  viewport: { width: 1000, height: 800 },
  screenshot: "off",
  trace: "on",
  video: "on",
});

const evidenceDirectory =
  "/private/tmp/shiplet-parity-tail-t2-recovery-r1b-20260921";

type AnnotationShape = Record<string, any> & { id: string; type: string };
type AnnotationSnapshot = {
  version: 1;
  coordinateSpace: "normalized";
  imageWidth: number;
  imageHeight: number;
  shapes: AnnotationShape[];
};

async function setupEditor(page: Page) {
  await page.setContent(`<!doctype html>
    <html>
      <head><meta charset="utf-8"></head>
      <body>
        <aside id="outside-fixture" data-preserve="true">Outside fixture content</aside>
        <main id="annotation-mount"></main>
      </body>
    </html>`);
  await page.addStyleTag({ content: reviewAnnotationEditorStyles() });
  await page.addScriptTag({ content: reviewAnnotationEditorScript() });
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 300;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Fixture canvas unavailable");
    context.fillStyle = "rgb(246,248,250)";
    context.fillRect(0, 0, 400, 300);
    context.fillStyle = "rgb(220,225,232)";
    context.fillRect(8, 8, 384, 24);
    return canvas.toDataURL("image/png");
  });
  await page.evaluate(() => {
    const state = window as typeof window & {
      __editor?: any;
      __editorEvents?: {
        apply: any[];
        cancel: number;
        error: string[];
        preference: any[];
      };
      __outsideMutations?: number;
      createReviewAnnotationEditor?: (options: Record<string, unknown>) => any;
    };
    state.__editorEvents = {
      apply: [],
      cancel: 0,
      error: [],
      preference: [],
    };
    const outside = document.querySelector("#outside-fixture");
    state.__outsideMutations = 0;
    if (outside) {
      new MutationObserver(() => {
        state.__outsideMutations = (state.__outsideMutations || 0) + 1;
      }).observe(outside, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
    const container = document.querySelector("#annotation-mount");
    if (!container || !state.createReviewAnnotationEditor) {
      throw new Error("Annotation editor factory unavailable");
    }
    state.__editor = state.createReviewAnnotationEditor({
      container,
      onApply(result: unknown) {
        state.__editorEvents?.apply.push(result);
      },
      onCancel() {
        if (state.__editorEvents) state.__editorEvents.cancel += 1;
      },
      onError(message: string) {
        state.__editorEvents?.error.push(message);
      },
      onPreferenceChange(preferences: unknown) {
        state.__editorEvents?.preference.push(preferences);
      },
    });
  });
  return image;
}

async function openEditor(
  page: Page,
  screenshotDataUrl: string,
  screenshotAnnotations?: AnnotationSnapshot,
  defaults?: { tool?: string; color?: string; strokeWidth?: number },
) {
  return page.evaluate(
    async ({ screenshotDataUrl, screenshotAnnotations, defaults }) => {
      const editor = (window as typeof window & { __editor?: any }).__editor;
      if (!editor) throw new Error("Editor unavailable");
      return editor.open({ screenshotDataUrl, screenshotAnnotations, defaults });
    },
    { screenshotDataUrl, screenshotAnnotations, defaults },
  );
}

function annotationWithText(text: string, id = "text_proposed"): AnnotationSnapshot {
  return {
    version: 1,
    coordinateSpace: "normalized",
    imageWidth: 400,
    imageHeight: 300,
    shapes: [
      {
        id,
        type: "text",
        color: "#0066CC",
        x: 0.2,
        y: 0.2,
        width: 0.42,
        height: 0.22,
        fontSize: 18,
        text,
      },
    ],
  };
}

async function installControlledDecoder(page: Page) {
  await page.evaluate(() => {
    const state = window as typeof window & {
      __nativeImage?: typeof Image;
      __decodeQueue?: Array<{ image: any; source: string; released: boolean }>;
      __releaseDecode?: (index: number, success: boolean) => void;
    };
    if (state.__nativeImage) return;
    state.__nativeImage = window.Image;
    state.__decodeQueue = [];
    class ControlledImage {
      naturalWidth = 0;
      naturalHeight = 0;
      decoding = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private source = "";

      set src(value: string) {
        this.source = value;
        state.__decodeQueue?.push({ image: this, source: value, released: false });
      }

      get src() {
        return this.source;
      }
    }
    state.Image = ControlledImage as unknown as typeof Image;
    state.__releaseDecode = (index, success) => {
      const entry = state.__decodeQueue?.[index];
      if (!entry || entry.released) return;
      entry.released = true;
      if (success) {
        entry.image.naturalWidth = 400;
        entry.image.naturalHeight = 300;
        entry.image.onload?.call(entry.image);
      } else {
        entry.image.onerror?.call(entry.image);
      }
    };
  });
}

async function restoreControlledDecoder(page: Page) {
  await page.evaluate(() => {
    const state = window as typeof window & {
      __nativeImage?: typeof Image;
      __releaseDecode?: unknown;
    };
    if (state.__nativeImage) window.Image = state.__nativeImage;
    delete state.__nativeImage;
    delete state.__releaseDecode;
  });
}

async function controlledDecodeCount(page: Page) {
  return page.evaluate(
    () =>
      (window as typeof window & { __decodeQueue?: unknown[] }).__decodeQueue
        ?.length || 0,
  );
}

async function releaseDecode(page: Page, index: number, success = true) {
  await page.evaluate(
    ({ index, success }) => {
      (
        window as typeof window & {
          __releaseDecode?: (index: number, success: boolean) => void;
        }
      ).__releaseDecode?.(index, success);
    },
    { index, success },
  );
}

async function startPendingOpen(
  page: Page,
  input: {
    screenshotDataUrl: string;
    screenshotAnnotations?: AnnotationSnapshot;
    defaults?: { tool?: string; color?: string; strokeWidth?: number };
  },
) {
  return page.evaluate((payload) => {
    const state = window as typeof window & {
      __editor?: { open: (value: unknown) => Promise<boolean> };
      __openResults?: Array<boolean | null>;
      __openSettles?: number[];
    };
    const index = state.__openResults?.length || 0;
    state.__openResults ||= [];
    state.__openSettles ||= [];
    state.__openResults.push(null);
    state.__openSettles.push(0);
    const finish = (value: boolean | undefined) => {
      state.__openResults![index] = Boolean(value);
      state.__openSettles![index] += 1;
    };
    Promise.resolve(state.__editor?.open(payload)).then(finish, () => finish(false));
    return index;
  }, input);
}

async function openResults(page: Page) {
  return page.evaluate(
    () =>
      (window as typeof window & { __openResults?: Array<boolean | null> })
        .__openResults || [],
  );
}

async function openSettles(page: Page) {
  return page.evaluate(
    () =>
      (window as typeof window & { __openSettles?: number[] }).__openSettles ||
      [],
  );
}

async function currentSnapshot(page: Page): Promise<AnnotationSnapshot | null> {
  return page.evaluate(() => {
    const editor = (window as typeof window & { __editor?: any }).__editor;
    return editor?.current || null;
  });
}

async function setColor(page: Page, color: string) {
  await page.getByLabel("Annotation color").evaluate((element, value) => {
    const input = element as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, color);
}

async function setStrokeWidth(page: Page, width: number) {
  await page.getByLabel("Stroke width").evaluate((element, value) => {
    const input = element as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, width);
}

async function drawGesture(
  page: Page,
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const canvas = page.locator("[data-shiplet-annotation-canvas]");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Annotation canvas is not visible");
  const from = {
    x: bounds.x + bounds.width * start.x,
    y: bounds.y + bounds.height * start.y,
  };
  const to = {
    x: bounds.x + bounds.width * end.x,
    y: bounds.y + bounds.height * end.y,
  };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, {
    steps: 4,
  });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

async function clickCanvas(page: Page, point: { x: number; y: number }) {
  const canvas = page.locator("[data-shiplet-annotation-canvas]");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Annotation canvas is not visible");
  await page.mouse.click(
    bounds.x + bounds.width * point.x,
    bounds.y + bounds.height * point.y,
  );
}

async function dragHandle(
  page: Page,
  name: "Move text annotation" | "Resize text annotation",
  delta: { x: number; y: number },
) {
  const handle = page.getByRole("button", { name });
  const bounds = await handle.boundingBox();
  if (!bounds) throw new Error(`${name} handle is not visible`);
  const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + delta.x, start.y + delta.y, { steps: 5 });
  await page.mouse.up();
}

async function editorEvents(page: Page) {
  return page.evaluate(() =>
    structuredClone(
      (window as typeof window & { __editorEvents?: unknown }).__editorEvents,
    ),
  ) as Promise<{
    apply: Array<{
      screenshotDataUrl: string;
      screenshotAnnotations: AnnotationSnapshot;
    }>;
    cancel: number;
    error: string[];
    preference: unknown[];
  }>;
}

test("draws, edits and rasterizes pen, arrow and multiline text without losing normalized structure", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const originalImage = await setupEditor(page);

  expect(await openEditor(page, originalImage)).toBe(true);
  await expect(page.locator(".shiplet-annotation-editor")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pen", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Undo annotation" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Apply annotations" })).toBeDisabled();

  await drawGesture(page, { x: 0.1, y: 0.2 }, { x: 0.34, y: 0.27 });
  await expect(page.getByRole("button", { name: "Undo annotation" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Apply annotations" })).toBeEnabled();

  await page.getByRole("button", { name: "Arrow", exact: true }).click();
  await setColor(page, "#0066cc");
  await setStrokeWidth(page, 8);
  await drawGesture(page, { x: 0.55, y: 0.2 }, { x: 0.84, y: 0.42 });

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await clickCanvas(page, { x: 0.24, y: 0.56 });
  const textarea = page.getByRole("textbox", { name: "Text annotation" });
  await expect(textarea).toBeFocused();
  await textarea.fill("First line\nSecond line <b>plain</b>");
  await dragHandle(page, "Move text annotation", { x: 36, y: 18 });
  await dragHandle(page, "Resize text annotation", { x: 52, y: 28 });

  const marked = await currentSnapshot(page);
  expect(marked).toMatchObject({
    version: 1,
    coordinateSpace: "normalized",
    imageWidth: 400,
    imageHeight: 300,
  });
  expect(marked?.shapes.map((shape) => shape.type)).toEqual([
    "pen",
    "arrow",
    "text",
  ]);
  expect(marked?.shapes[0].points.length).toBeGreaterThan(4);
  expect(marked?.shapes[1]).toMatchObject({ color: "#0066CC", strokeWidth: 8 });
  expect(marked?.shapes[2].text).toBe("First line\nSecond line <b>plain</b>");
  for (const shape of marked?.shapes || []) {
    expect(JSON.stringify(shape)).not.toContain("NaN");
  }

  await page.screenshot({
    path: `${evidenceDirectory}/desktop-completed-markings.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Apply annotations" }).click();
  await expect.poll(async () => (await editorEvents(page)).apply.length).toBe(1);
  const firstApply = (await editorEvents(page)).apply[0];
  expect(firstApply.screenshotDataUrl).toMatch(/^data:image\/png;base64,/);
  expect(firstApply.screenshotAnnotations).toEqual(marked);

  const pixels = await page.evaluate(
    async ({ dataUrl, annotations }) => {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Flattened result failed to decode"));
        image.src = dataUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Pixel canvas unavailable");
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const count = (
        box: { left: number; top: number; right: number; bottom: number },
        expected: [number, number, number],
      ) => {
        let matches = 0;
        for (let y = Math.max(0, Math.floor(box.top)); y < Math.min(canvas.height, Math.ceil(box.bottom)); y += 1) {
          for (let x = Math.max(0, Math.floor(box.left)); x < Math.min(canvas.width, Math.ceil(box.right)); x += 1) {
            const index = (y * canvas.width + x) * 4;
            if (
              Math.abs(data[index] - expected[0]) < 35 &&
              Math.abs(data[index + 1] - expected[1]) < 35 &&
              Math.abs(data[index + 2] - expected[2]) < 35 &&
              data[index + 3] > 180
            ) matches += 1;
          }
        }
        return matches;
      };
      const text = annotations.shapes.find((shape: any) => shape.type === "text");
      if (!text) throw new Error("Flattened annotations are missing text");
      return {
        width: canvas.width,
        height: canvas.height,
        penPixels: count({ left: 30, top: 45, right: 150, bottom: 100 }, [255, 51, 102]),
        arrowHeadPixels: count({ left: 315, top: 100, right: 350, bottom: 145 }, [0, 102, 204]),
        textPixels: count(
          {
            left: text.x * canvas.width,
            top: text.y * canvas.height,
            right: (text.x + text.width) * canvas.width,
            bottom: (text.y + text.height) * canvas.height,
          },
          [0, 102, 204],
        ),
      };
    },
    { dataUrl: firstApply.screenshotDataUrl, annotations: firstApply.screenshotAnnotations },
  );
  expect(pixels).toMatchObject({ width: 400, height: 300 });
  expect(pixels.penPixels).toBeGreaterThan(20);
  expect(pixels.arrowHeadPixels).toBeGreaterThan(10);
  expect(pixels.textPixels).toBeGreaterThan(30);

  expect(
    await openEditor(page, originalImage, firstApply.screenshotAnnotations),
  ).toBe(true);
  expect((await currentSnapshot(page))?.shapes).toHaveLength(3);
  const reopenedText = page.getByRole("textbox", { name: "Text annotation" });
  await reopenedText.fill("First line\nSecond line <b>plain</b>\nThird line");
  await reopenedText.blur();
  expect((await currentSnapshot(page))?.shapes[2].text).toContain("Third line");
  const beforeResize = await currentSnapshot(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("[data-shiplet-annotation-stage]")).toBeVisible();
  expect(await currentSnapshot(page)).toEqual(beforeResize);
  expect(requests).toEqual([]);
});

test("supports keyboard text movement and resize, IME-safe Escape, logical Undo, pointer cancel and touch", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const originalImage = await setupEditor(page);
  expect(await openEditor(page, originalImage)).toBe(true);

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await clickCanvas(page, { x: 0.18, y: 0.3 });
  const textarea = page.getByRole("textbox", { name: "Text annotation" });
  await textarea.fill("Composed line\nSecond line");
  await textarea.evaluate((element) => {
    element.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true, data: "文" }),
    );
    const escape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    Object.defineProperty(escape, "keyCode", { value: 229 });
    element.dispatchEvent(escape);
    element.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "文" }),
    );
  });
  expect((await editorEvents(page)).cancel).toBe(0);
  await expect(page.locator(".shiplet-annotation-editor")).toBeVisible();

  await textarea.blur();
  const move = page.getByRole("button", { name: "Move text annotation" });
  await move.focus();
  const beforeMove = (await currentSnapshot(page))!.shapes[0];
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  const afterMove = (await currentSnapshot(page))!.shapes[0];
  expect(afterMove.x).toBeCloseTo(beforeMove.x + 0.01, 5);
  expect(afterMove.y).toBeCloseTo(beforeMove.y + 0.05, 5);

  const resize = page.getByRole("button", { name: "Resize text annotation" });
  await resize.focus();
  const beforeResize = (await currentSnapshot(page))!.shapes[0];
  await page.keyboard.press("Alt+ArrowRight");
  await page.keyboard.press("Alt+Shift+ArrowDown");
  const afterResize = (await currentSnapshot(page))!.shapes[0];
  expect(afterResize.width).toBeCloseTo(beforeResize.width + 0.01, 5);
  expect(afterResize.height).toBeCloseTo(beforeResize.height + 0.05, 5);

  await setColor(page, "#008855");
  expect((await currentSnapshot(page))!.shapes[0].color).toBe("#008855");
  await page.getByRole("button", { name: "Undo annotation" }).click();
  expect((await currentSnapshot(page))!.shapes[0].color).not.toBe("#008855");

  await page.getByRole("button", { name: "Pen", exact: true }).click();
  const canvas = page.locator("[data-shiplet-annotation-canvas]");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Annotation canvas is not visible");
  const shapeCount = (await currentSnapshot(page))!.shapes.length;
  await canvas.evaluate(
    (element, points) => {
      const dispatch = (type: string, x: number, y: number, buttons: number) =>
        element.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 41,
            pointerType: "pen",
            clientX: x,
            clientY: y,
            buttons,
          }),
        );
      dispatch("pointerdown", points.x1, points.y1, 1);
      dispatch("pointermove", points.x2, points.y2, 1);
      dispatch("pointercancel", points.x2, points.y2, 0);
    },
    {
      x1: bounds.x + 40,
      y1: bounds.y + 80,
      x2: bounds.x + 130,
      y2: bounds.y + 110,
    },
  );
  expect((await currentSnapshot(page))!.shapes).toHaveLength(shapeCount);

  await canvas.evaluate(
    (element, points) => {
      const dispatch = (type: string, x: number, y: number, buttons: number) =>
        element.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 52,
            pointerType: "touch",
            clientX: x,
            clientY: y,
            buttons,
          }),
        );
      dispatch("pointerdown", points.x1, points.y1, 1);
      dispatch("pointermove", points.x2, points.y2, 1);
      dispatch("pointerup", points.x2, points.y2, 0);
    },
    {
      x1: bounds.x + 55,
      y1: bounds.y + 180,
      x2: bounds.x + 180,
      y2: bounds.y + 205,
    },
  );
  expect((await currentSnapshot(page))!.shapes).toHaveLength(shapeCount + 1);
  await page.screenshot({
    path: `${evidenceDirectory}/narrow-completed-markings.png`,
    fullPage: true,
  });

  await page.getByRole("button", { name: "Pen", exact: true }).focus();
  await page.keyboard.press("Control+z");
  expect((await currentSnapshot(page))!.shapes).toHaveLength(shapeCount);
  await page.getByRole("button", { name: "Cancel annotation" }).click();
  const events = await editorEvents(page);
  expect(events.apply).toEqual([]);
  expect(events.cancel).toBe(1);
  await expect(page.locator(".shiplet-annotation-editor")).toBeHidden();
});

test("fails closed on invalid images and annotations while cancel, close and destroy never apply or mutate outside content", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const originalImage = await setupEditor(page);
  const outsideBefore = await page.locator("#outside-fixture").evaluate((node) => node.outerHTML);

  expect(await openEditor(page, "data:text/plain;base64,SGVsbG8=")).toBe(false);
  await expect(page.getByRole("alert")).toContainText(/PNG|JPEG|WebP/i);
  await expect(page.getByRole("button", { name: "Apply annotations" })).toBeDisabled();

  const oversizedImage = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 8193;
    canvas.height = 1;
    return canvas.toDataURL("image/png");
  });
  expect(await openEditor(page, oversizedImage)).toBe(false);
  await expect(page.getByRole("alert")).toContainText(/8,?192|dimension/i);

  const oversizedAnnotations = {
    version: 1 as const,
    coordinateSpace: "normalized" as const,
    imageWidth: 400,
    imageHeight: 300,
    shapes: Array.from({ length: 65 }, (_, index) => ({
      id: `arrow_${index}`,
      type: "arrow",
      color: "#FF3366",
      strokeWidth: 5,
      start: { x: 0.1, y: 0.1 },
      end: { x: 0.2, y: 0.2 },
    })),
  } as unknown as AnnotationSnapshot;
  const serializedBefore = JSON.stringify(oversizedAnnotations);
  expect(
    await openEditor(page, originalImage, oversizedAnnotations),
  ).toBe(false);
  await expect(page.getByRole("alert")).toContainText(/64|shape/i);
  expect(JSON.stringify(oversizedAnnotations)).toBe(serializedBefore);

  expect(await openEditor(page, originalImage)).toBe(true);
  await page.evaluate(() => {
    (window as typeof window & { __editor?: any }).__editor?.close();
  });
  expect((await editorEvents(page)).apply).toEqual([]);

  expect(await openEditor(page, originalImage)).toBe(true);
  await page.getByRole("button", { name: "Cancel annotation" }).click();
  expect((await editorEvents(page)).apply).toEqual([]);

  expect(await openEditor(page, originalImage)).toBe(true);
  await page.evaluate(() => {
    (window as typeof window & { __editor?: any }).__editor?.destroy();
  });
  await expect(page.locator(".shiplet-annotation-editor")).toHaveCount(0);
  const events = await editorEvents(page);
  expect(events.apply).toEqual([]);
  expect(events.error.length).toBeGreaterThanOrEqual(3);
  expect(await page.locator("#outside-fixture").evaluate((node) => node.outerHTML)).toBe(
    outsideBefore,
  );
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __outsideMutations?: number })
          .__outsideMutations,
    ),
  ).toBe(0);
  expect(requests).toEqual([]);
});

test("retains a committed draft when a replacement image or prior markup is invalid", async ({
  page,
}) => {
  const originalImage = await setupEditor(page);
  expect(await openEditor(page, originalImage)).toBe(true);

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await clickCanvas(page, { x: 0.2, y: 0.25 });
  await page.getByRole("textbox", { name: "Text annotation" }).fill("Committed draft");
  await page.getByRole("textbox", { name: "Text annotation" }).blur();
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  await drawGesture(page, { x: 0.1, y: 0.6 }, { x: 0.34, y: 0.72 });
  const committed = await currentSnapshot(page);
  expect(committed?.shapes).toHaveLength(2);
  await expect(page.getByRole("button", { name: "Undo annotation" })).toBeEnabled();

  expect(await openEditor(page, "data:text/plain;base64,SGVsbG8=")).toBe(false);
  expect(await currentSnapshot(page)).toEqual(committed);
  await expect(page.getByRole("button", { name: "Apply annotations" })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText(/PNG|JPEG|WebP/i);

  const invalidPriorMarkup = {
    ...annotationWithText("invalid prior"),
    shapes: [{ ...annotationWithText("invalid prior").shapes[0], unexpected: true }],
  } as unknown as AnnotationSnapshot;
  expect(await openEditor(page, originalImage, invalidPriorMarkup)).toBe(false);
  expect(await currentSnapshot(page)).toEqual(committed);
  await expect(page.getByRole("button", { name: "Undo annotation" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Apply annotations" })).toBeDisabled();
});

test("commits only the newest open generation and snapshots mutable input", async ({
  page,
}) => {
  const originalImage = await setupEditor(page);
  expect(await openEditor(page, originalImage)).toBe(true);
  await installControlledDecoder(page);

  const oldIndex = await startPendingOpen(page, {
    screenshotDataUrl: originalImage,
    screenshotAnnotations: annotationWithText("old decode", "old_decode"),
  });
  await expect.poll(() => controlledDecodeCount(page)).toBe(1);
  const newIndex = await startPendingOpen(page, {
    screenshotDataUrl: originalImage,
    screenshotAnnotations: annotationWithText("new decode", "new_decode"),
  });
  await expect.poll(() => openSettles(page)).toEqual([1, 0]);
  await releaseDecode(page, newIndex);
  await expect.poll(() => openResults(page)).toEqual([false, true]);
  expect((await currentSnapshot(page))?.shapes[0].text).toBe("new decode");

  await releaseDecode(page, oldIndex);
  await expect.poll(() => openSettles(page)).toEqual([1, 1]);
  expect((await currentSnapshot(page))?.shapes[0].text).toBe("new decode");

  const lateIndex = await startPendingOpen(page, {
    screenshotDataUrl: originalImage,
    screenshotAnnotations: annotationWithText("late decode", "late_decode"),
  });
  await expect.poll(() => controlledDecodeCount(page)).toBe(3);
  const errorsBeforeInvalid = (await editorEvents(page)).error.length;
  await startPendingOpen(page, {
    screenshotDataUrl: "data:text/plain;base64,SGVsbG8=",
  });
  await expect.poll(() => openResults(page)).toEqual([false, true, false, false]);
  expect((await currentSnapshot(page))?.shapes[0].text).toBe("new decode");
  expect((await editorEvents(page)).error.length).toBeGreaterThan(errorsBeforeInvalid);

  await releaseDecode(page, lateIndex, false);
  await expect.poll(() => openSettles(page)).toEqual([1, 1, 1, 1]);
  expect((await currentSnapshot(page))?.shapes[0].text).toBe("new decode");
  expect((await editorEvents(page)).error.length).toBeGreaterThan(errorsBeforeInvalid);

  const mutationDecodeIndex = await controlledDecodeCount(page);
  const mutationIndex = await page.evaluate((payload) => {
    const state = window as typeof window & {
      __editor?: { open: (value: unknown) => Promise<boolean> };
      __openResults?: Array<boolean | null>;
      __openSettles?: number[];
      __mutableInput?: any;
    };
    const index = state.__openResults?.length || 0;
    state.__openResults ||= [];
    state.__openSettles ||= [];
    state.__openResults.push(null);
    state.__openSettles.push(0);
    state.__mutableInput = structuredClone(payload);
    const promise = state.__editor?.open(state.__mutableInput);
    state.__mutableInput.screenshotAnnotations.shapes[0].text = "mutated after open";
    state.__mutableInput.defaults.color = "#00FF00";
    Promise.resolve(promise).then(
      (value) => {
        state.__openResults![index] = Boolean(value);
        state.__openSettles![index] += 1;
      },
      () => {
        state.__openResults![index] = false;
        state.__openSettles![index] += 1;
      },
    );
    return index;
  }, {
    screenshotDataUrl: originalImage,
    screenshotAnnotations: annotationWithText("bound before mutation", "bound_decode"),
    defaults: { tool: "arrow", color: "#AA55CC", strokeWidth: 7 },
  });
  await expect.poll(() => controlledDecodeCount(page)).toBe(4);
  await releaseDecode(page, mutationDecodeIndex);
  await expect.poll(() => openResults(page)).toEqual([false, true, false, false, true]);
  expect((await currentSnapshot(page))?.shapes[0].text).toBe("bound before mutation");
  await expect(page.getByLabel("Annotation color")).toHaveValue("#aa55cc");
  await restoreControlledDecoder(page);
});

test("settles and ignores a pending open after close, then permits a fresh reopen", async ({
  page,
}) => {
  const originalImage = await setupEditor(page);
  expect(await openEditor(page, originalImage)).toBe(true);
  const committed = await currentSnapshot(page);
  await installControlledDecoder(page);

  const pendingIndex = await startPendingOpen(page, {
    screenshotDataUrl: originalImage,
    screenshotAnnotations: annotationWithText("never released", "never_released"),
  });
  await expect.poll(() => controlledDecodeCount(page)).toBe(1);
  await expect(page.getByRole("button", { name: "Apply annotations" })).toBeDisabled();
  await page.evaluate(() => (window as typeof window & { __editor?: any }).__editor?.close());
  await expect.poll(() => openResults(page)).toEqual([false]);
  await expect.poll(() => openSettles(page)).toEqual([1]);
  await expect(page.locator(".shiplet-annotation-editor")).toBeHidden();
  expect(await currentSnapshot(page)).toEqual(committed);
  expect((await editorEvents(page)).cancel).toBe(0);
  expect((await editorEvents(page)).apply).toEqual([]);

  await releaseDecode(page, pendingIndex);
  await page.waitForTimeout(50);
  expect(await currentSnapshot(page)).toEqual(committed);
  await expect(page.locator(".shiplet-annotation-editor")).toBeHidden();
  await expect.poll(() => openSettles(page)).toEqual([1]);

  const freshIndex = await startPendingOpen(page, {
    screenshotDataUrl: originalImage,
    screenshotAnnotations: annotationWithText("fresh reopen", "fresh_reopen"),
  });
  await expect.poll(() => controlledDecodeCount(page)).toBe(2);
  await releaseDecode(page, freshIndex);
  await expect.poll(() => openResults(page)).toEqual([false, true]);
  await expect(page.locator(".shiplet-annotation-editor")).toBeVisible();
  expect((await currentSnapshot(page))?.shapes[0].text).toBe("fresh reopen");
  await restoreControlledDecoder(page);
});

test("destroy settles pending opens, clears current permanently and blocks future DOM or callbacks", async ({
  page,
}) => {
  const originalImage = await setupEditor(page);
  expect(await openEditor(page, originalImage)).toBe(true);
  await installControlledDecoder(page);
  const pendingIndex = await startPendingOpen(page, {
    screenshotDataUrl: originalImage,
    screenshotAnnotations: annotationWithText("destroyed decode", "destroyed_decode"),
  });
  await expect.poll(() => controlledDecodeCount(page)).toBe(1);
  const errorsBeforeDestroy = (await editorEvents(page)).error.length;
  await page.evaluate(() => {
    const editor = (window as typeof window & { __editor?: any }).__editor;
    editor?.destroy();
    editor?.destroy();
    editor?.close();
  });
  await expect.poll(() => openResults(page)).toEqual([false]);
  await expect.poll(() => openSettles(page)).toEqual([1]);
  await expect(page.locator(".shiplet-annotation-editor")).toHaveCount(0);
  expect(await currentSnapshot(page)).toBeNull();

  await releaseDecode(page, pendingIndex);
  await page.waitForTimeout(50);
  expect(await currentSnapshot(page)).toBeNull();
  expect((await editorEvents(page)).error.length).toBe(errorsBeforeDestroy);
  expect((await editorEvents(page)).apply).toEqual([]);
  expect((await editorEvents(page)).cancel).toBe(0);
  expect(await openEditor(page, originalImage)).toBe(false);
  await expect(page.locator(".shiplet-annotation-editor")).toHaveCount(0);
  expect((await editorEvents(page)).error.length).toBe(errorsBeforeDestroy);
  await restoreControlledDecoder(page);
});
