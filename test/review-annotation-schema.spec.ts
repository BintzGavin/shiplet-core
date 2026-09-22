import { describe, expect, it } from "vitest";

import { reviewAnnotationEditorScript } from "../src/review-annotation-editor";
import {
  validateReviewScreenshotAnnotations,
  type ReviewScreenshotAnnotations,
} from "../src/review-annotation-schema";

function validAnnotations(): ReviewScreenshotAnnotations {
  return {
    version: 1,
    coordinateSpace: "normalized",
    imageWidth: 800,
    imageHeight: 600,
    shapes: [
      {
        id: "pen_1",
        type: "pen",
        color: "#ff3366",
        strokeWidth: 5,
        points: [
          { x: 0, y: 0 },
          { x: 0.5, y: 0.5 },
          { x: 1, y: 1 },
        ],
      },
      {
        id: "arrow_1",
        type: "arrow",
        color: "#0066cc",
        strokeWidth: 16,
        start: { x: 0, y: 1 },
        end: { x: 1, y: 0 },
      },
      {
        id: "text_1",
        type: "text",
        color: "#20293a",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        fontSize: 12,
        text: "First line\n<b>remains plain text</b>",
      },
    ],
  };
}

function expectInvalid(value: unknown, message: RegExp) {
  const result = validateReviewScreenshotAnnotations(value);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(message);
  expect(result.error.length).toBeLessThanOrEqual(240);
}

describe("review screenshot annotation schema", () => {
  it("constructs the trusted annotation editor without an HTML parser sink", () => {
    const script = reviewAnnotationEditorScript();
    const htmlParserSinks = [
      /\.innerHTML\s*=/,
      /\.outerHTML\s*=/,
      /\.insertAdjacentHTML\s*\(/,
      /\bDOMParser\s*\(/,
      /\.createContextualFragment\s*\(/,
      /\.setHTMLUnsafe\s*\(/,
      /\bdocument\.write(?:ln)?\s*\(/,
    ];

    expect(
      htmlParserSinks.filter((pattern) => pattern.test(script)).map(String),
    ).toEqual([]);
  });

  it("round-trips every bounded shape with boundary coordinates and normalizes colors without mutating input", () => {
    const input = validAnnotations();
    const before = structuredClone(input);
    const result = validateReviewScreenshotAnnotations(input);

    expect(result).toEqual({
      ok: true,
      value: {
        ...input,
        shapes: [
          { ...input.shapes[0], color: "#FF3366" },
          { ...input.shapes[1], color: "#0066CC" },
          { ...input.shapes[2], color: "#20293A" },
        ],
      },
    });
    expect(input).toEqual(before);
    expect(
      result.ok && result.value.shapes[2].type === "text"
        ? result.value.shapes[2].text
        : "",
    ).toBe("First line\n<b>remains plain text</b>");
  });

  it("accepts an empty ordered shape list and the maximum bounded image", () => {
    expect(
      validateReviewScreenshotAnnotations({
        version: 1,
        coordinateSpace: "normalized",
        imageWidth: 8192,
        imageHeight: 1953,
        shapes: [],
      }),
    ).toEqual({
      ok: true,
      value: {
        version: 1,
        coordinateSpace: "normalized",
        imageWidth: 8192,
        imageHeight: 1953,
        shapes: [],
      },
    });
  });

  it.each([
    ["top-level keys", { ...validAnnotations(), extra: true }, /unexpected/i],
    [
      "nested point keys",
      {
        ...validAnnotations(),
        shapes: [
          {
            id: "pen_1",
            type: "pen",
            color: "#FF3366",
            strokeWidth: 5,
            points: [
              { x: 0, y: 0, value: "outside-contract" },
              { x: 1, y: 1 },
            ],
          },
        ],
      },
      /point|unexpected/i,
    ],
    [
      "shape keys",
      {
        ...validAnnotations(),
        shapes: [{ ...validAnnotations().shapes[1], html: "outside-contract" }],
      },
      /arrow|unexpected/i,
    ],
    ["version", { ...validAnnotations(), version: 2 }, /version/i],
    [
      "coordinate space",
      { ...validAnnotations(), coordinateSpace: "pixels" },
      /coordinate/i,
    ],
    ["unknown shape", { ...validAnnotations(), shapes: [{ id: "shape_1", type: "circle" }] }, /type/i],
  ])("rejects unexpected or unsupported %s", (_label, value, message) => {
    expectInvalid(value, message);
  });

  it.each([
    ["empty", ""],
    ["missing hash", "FF3366"],
    ["short", "#F36"],
    ["alpha", "#FF3366AA"],
    ["non-hex", "#GG3366"],
  ])("rejects %s colors", (_label, color) => {
    const input = validAnnotations();
    expectInvalid(
      {
        ...input,
        shapes: [{ ...input.shapes[0], color }],
      },
      /color/i,
    );
  });

  it.each([
    ["NaN point", { x: Number.NaN, y: 0 }, /point|finite/i],
    ["infinite point", { x: Number.POSITIVE_INFINITY, y: 0 }, /point|finite/i],
    ["negative point", { x: -0.01, y: 0 }, /point|coordinate/i],
    ["large point", { x: 1.01, y: 0 }, /point|coordinate/i],
  ])("rejects %s coordinates", (_label, point, message) => {
    const input = validAnnotations();
    expectInvalid(
      {
        ...input,
        shapes: [
          {
            ...input.shapes[0],
            points: [point, { x: 1, y: 1 }],
          },
        ],
      },
      message,
    );
  });

  it("rejects duplicate IDs, invalid numeric bounds and boxes extending outside the source image", () => {
    const input = validAnnotations();
    expectInvalid(
      { ...input, shapes: [input.shapes[0], { ...input.shapes[1], id: "pen_1" }] },
      /unique|duplicate/i,
    );
    expectInvalid(
      { ...input, shapes: [{ ...input.shapes[0], strokeWidth: 0 }] },
      /stroke/i,
    );
    expectInvalid(
      { ...input, shapes: [{ ...input.shapes[2], fontSize: 65 }] },
      /font/i,
    );
    expectInvalid(
      {
        ...input,
        shapes: [
          { ...input.shapes[2], x: 0.8, y: 0.8, width: 0.3, height: 0.3 },
        ],
      },
      /inside|box/i,
    );
  });

  it("enforces image, shape, aggregate point, ID and text limits", () => {
    const input = validAnnotations();
    expectInvalid({ ...input, imageWidth: 8193 }, /8,?192|dimension/i);
    expectInvalid(
      { ...input, imageWidth: 5000, imageHeight: 4000 },
      /16,?000,?000|pixel/i,
    );
    expectInvalid(
      {
        ...input,
        shapes: Array.from({ length: 65 }, (_, index) => ({
          ...input.shapes[1],
          id: `arrow_${index}`,
        })),
      },
      /64|shape/i,
    );
    expectInvalid(
      {
        ...input,
        shapes: [
          {
            ...input.shapes[0],
            points: Array.from({ length: 4001 }, () => ({ x: 0.5, y: 0.5 })),
          },
        ],
      },
      /4,?000|point/i,
    );
    expectInvalid(
      { ...input, shapes: [{ ...input.shapes[2], text: "x".repeat(1001) }] },
      /1,?000|text/i,
    );
    expectInvalid(
      { ...input, shapes: [{ ...input.shapes[0], id: "x".repeat(257) }] },
      /id/i,
    );
  });
});
