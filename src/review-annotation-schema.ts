export type ReviewAnnotationPoint = { x: number; y: number };

export type ReviewPenAnnotation = {
  id: string;
  type: "pen";
  color: string;
  strokeWidth: number;
  points: ReviewAnnotationPoint[];
};

export type ReviewArrowAnnotation = {
  id: string;
  type: "arrow";
  color: string;
  strokeWidth: number;
  start: ReviewAnnotationPoint;
  end: ReviewAnnotationPoint;
};

export type ReviewTextAnnotation = {
  id: string;
  type: "text";
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  text: string;
};

export type ReviewAnnotationShape =
  | ReviewPenAnnotation
  | ReviewArrowAnnotation
  | ReviewTextAnnotation;

export type ReviewScreenshotAnnotations = {
  version: 1;
  coordinateSpace: "normalized";
  imageWidth: number;
  imageHeight: number;
  shapes: ReviewAnnotationShape[];
};

export type ReviewAnnotationValidationResult =
  | { ok: true; value: ReviewScreenshotAnnotations }
  | { ok: false; error: string };

export const REVIEW_ANNOTATION_LIMITS = Object.freeze({
  maximumShapes: 64,
  maximumPenPoints: 4000,
  maximumTextLength: 1000,
  maximumImageDimension: 8192,
  maximumImagePixels: 16_000_000,
});

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const COLOR = /^#[0-9A-Fa-f]{6}$/;

function invalid(error: string): ReviewAnnotationValidationResult {
  return { ok: false, error: error.slice(0, 240) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    actual.every((key) => expected.includes(key))
  );
}

function finiteBetween(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function normalizedPoint(
  value: unknown,
  label: string,
): { ok: true; value: ReviewAnnotationPoint } | { ok: false; error: string } {
  if (!isRecord(value) || !exactKeys(value, ["x", "y"])) {
    return { ok: false, error: `${label} point has unexpected fields.` };
  }
  if (!finiteBetween(value.x, 0, 1) || !finiteBetween(value.y, 0, 1)) {
    return {
      ok: false,
      error: `${label} point coordinates must be finite values from 0 through 1.`,
    };
  }
  return { ok: true, value: { x: value.x, y: value.y } };
}

function normalizedColor(value: unknown, label: string) {
  if (typeof value !== "string" || !COLOR.test(value)) {
    return { ok: false as const, error: `${label} color must use #RRGGBB.` };
  }
  return { ok: true as const, value: value.toUpperCase() };
}

function validId(value: unknown, label: string) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    return { ok: false as const, error: `${label} id is invalid or too long.` };
  }
  return { ok: true as const, value };
}

export function validateReviewScreenshotAnnotations(
  value: unknown,
): ReviewAnnotationValidationResult {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "version",
      "coordinateSpace",
      "imageWidth",
      "imageHeight",
      "shapes",
    ])
  ) {
    return invalid("Annotation payload has unexpected top-level fields.");
  }
  if (value.version !== 1) {
    return invalid("Annotation version must be 1.");
  }
  if (value.coordinateSpace !== "normalized") {
    return invalid('Annotation coordinateSpace must be "normalized".');
  }
  if (
    !Number.isInteger(value.imageWidth) ||
    !Number.isInteger(value.imageHeight) ||
    !finiteBetween(value.imageWidth, 1, REVIEW_ANNOTATION_LIMITS.maximumImageDimension) ||
    !finiteBetween(value.imageHeight, 1, REVIEW_ANNOTATION_LIMITS.maximumImageDimension)
  ) {
    return invalid("Image dimensions must be integers from 1 through 8,192.");
  }
  if (
    (value.imageWidth as number) * (value.imageHeight as number) >
    REVIEW_ANNOTATION_LIMITS.maximumImagePixels
  ) {
    return invalid("Annotation image cannot exceed 16,000,000 pixels.");
  }
  if (!Array.isArray(value.shapes)) {
    return invalid("Annotation shapes must be an ordered array.");
  }
  if (value.shapes.length > REVIEW_ANNOTATION_LIMITS.maximumShapes) {
    return invalid("Annotation payload cannot contain more than 64 shapes.");
  }

  const ids = new Set<string>();
  const shapes: ReviewAnnotationShape[] = [];
  let pointCount = 0;
  for (let index = 0; index < value.shapes.length; index += 1) {
    const shape = value.shapes[index];
    const label = `Shape ${index + 1}`;
    if (!isRecord(shape) || typeof shape.type !== "string") {
      return invalid(`${label} type is unsupported.`);
    }
    if (
      shape.type !== "pen" &&
      shape.type !== "arrow" &&
      shape.type !== "text"
    ) {
      return invalid(`${label} type is unsupported.`);
    }
    const id = validId(shape.id, label);
    if (!id.ok) return invalid(id.error);
    if (ids.has(id.value)) {
      return invalid("Annotation shape IDs must be unique; duplicate ID found.");
    }
    ids.add(id.value);
    const color = normalizedColor(shape.color, label);
    if (!color.ok) return invalid(color.error);

    if (shape.type === "pen") {
      if (
        !exactKeys(shape, ["id", "type", "color", "strokeWidth", "points"])
      ) {
        return invalid(`${label} pen has unexpected fields.`);
      }
      if (!finiteBetween(shape.strokeWidth, 1, 16)) {
        return invalid(`${label} pen strokeWidth must be from 1 through 16.`);
      }
      if (!Array.isArray(shape.points) || shape.points.length < 2) {
        return invalid(`${label} pen must contain at least two points.`);
      }
      pointCount += shape.points.length;
      if (pointCount > REVIEW_ANNOTATION_LIMITS.maximumPenPoints) {
        return invalid("Annotation payload cannot exceed 4,000 aggregate pen points.");
      }
      const points: ReviewAnnotationPoint[] = [];
      for (let pointIndex = 0; pointIndex < shape.points.length; pointIndex += 1) {
        const point = normalizedPoint(
          shape.points[pointIndex],
          `${label} pen point ${pointIndex + 1}`,
        );
        if (!point.ok) return invalid(point.error);
        points.push(point.value);
      }
      shapes.push({
        id: id.value,
        type: "pen",
        color: color.value,
        strokeWidth: shape.strokeWidth,
        points,
      });
      continue;
    }

    if (shape.type === "arrow") {
      if (
        !exactKeys(shape, [
          "id",
          "type",
          "color",
          "strokeWidth",
          "start",
          "end",
        ])
      ) {
        return invalid(`${label} arrow has unexpected fields.`);
      }
      if (!finiteBetween(shape.strokeWidth, 1, 16)) {
        return invalid(`${label} arrow strokeWidth must be from 1 through 16.`);
      }
      const start = normalizedPoint(shape.start, `${label} arrow start`);
      const end = normalizedPoint(shape.end, `${label} arrow end`);
      if (!start.ok) return invalid(start.error);
      if (!end.ok) return invalid(end.error);
      shapes.push({
        id: id.value,
        type: "arrow",
        color: color.value,
        strokeWidth: shape.strokeWidth,
        start: start.value,
        end: end.value,
      });
      continue;
    }

    if (shape.type === "text") {
      if (
        !exactKeys(shape, [
          "id",
          "type",
          "color",
          "x",
          "y",
          "width",
          "height",
          "fontSize",
          "text",
        ])
      ) {
        return invalid(`${label} text has unexpected fields.`);
      }
      if (
        !finiteBetween(shape.x, 0, 1) ||
        !finiteBetween(shape.y, 0, 1) ||
        !finiteBetween(shape.width, 0, 1) ||
        !finiteBetween(shape.height, 0, 1) ||
        shape.width === 0 ||
        shape.height === 0 ||
        (shape.x as number) + (shape.width as number) > 1 + Number.EPSILON ||
        (shape.y as number) + (shape.height as number) > 1 + Number.EPSILON
      ) {
        return invalid(`${label} text box must remain inside the image.`);
      }
      if (!finiteBetween(shape.fontSize, 12, 64)) {
        return invalid(`${label} text fontSize must be from 12 through 64.`);
      }
      if (
        typeof shape.text !== "string" ||
        shape.text.length > REVIEW_ANNOTATION_LIMITS.maximumTextLength
      ) {
        return invalid(`${label} text cannot exceed 1,000 characters.`);
      }
      shapes.push({
        id: id.value,
        type: "text",
        color: color.value,
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height,
        fontSize: shape.fontSize,
        text: shape.text,
      });
      continue;
    }

    return invalid(`${label} type is unsupported.`);
  }

  return {
    ok: true,
    value: {
      version: 1,
      coordinateSpace: "normalized",
      imageWidth: value.imageWidth as number,
      imageHeight: value.imageHeight as number,
      shapes,
    },
  };
}
