/**
 * Returns a dependency-free classic script for the trusted review host.
 * The script declares createReviewAnnotationEditor in the host's IIFE scope.
 */
export function reviewAnnotationEditorScript(): string {
  return String.raw`
function createReviewAnnotationEditor(options) {
  "use strict";

  if (!options || !(options.container instanceof Element)) {
    throw new TypeError("Annotation editor requires a trusted container element.");
  }

  var maximumDataUrlLength = 13400000;
  var maximumDimension = 8192;
  var maximumPixels = 16000000;
  var maximumShapes = 64;
  var maximumPenPoints = 4000;
  var maximumTextLength = 1000;
  var identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
  var colorPattern = /^#[0-9A-Fa-f]{6}$/;
  var dataUrlPattern = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/;
  var controller = new AbortController();
  var signal = controller.signal;
  var destroyed = false;
  var imageWidth = 0;
  var imageHeight = 0;
  var sourceImage = null;
  var sourceDataUrl = "";
  var shapes = [];
  var history = [];
  var draft = null;
  var pointerWork = null;
  var selectedTextId = null;
  var editBaseline = null;
  var composing = false;
  var busy = false;
  var shapeCounter = 0;
  var openGeneration = 0;
  var pendingOpen = null;
  var loadError = false;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function exactKeys(value, expected) {
    var keys = Object.keys(value);
    return keys.length === expected.length && keys.every(function (key) {
      return expected.indexOf(key) !== -1;
    });
  }

  function finiteBetween(value, minimum, maximum) {
    return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
  }

  function invalid(message) {
    return { ok: false, error: String(message).slice(0, 240) };
  }

  function validatePoint(value, label) {
    if (!isRecord(value) || !exactKeys(value, ["x", "y"])) {
      return invalid(label + " point has unexpected fields.");
    }
    if (!finiteBetween(value.x, 0, 1) || !finiteBetween(value.y, 0, 1)) {
      return invalid(label + " point coordinates must be finite values from 0 through 1.");
    }
    return { ok: true, value: { x: value.x, y: value.y } };
  }

  function validateAnnotations(value) {
    if (!isRecord(value) || !exactKeys(value, ["version", "coordinateSpace", "imageWidth", "imageHeight", "shapes"])) {
      return invalid("Annotation payload has unexpected top-level fields.");
    }
    if (value.version !== 1) return invalid("Annotation version must be 1.");
    if (value.coordinateSpace !== "normalized") return invalid("Annotation coordinateSpace must be normalized.");
    if (!Number.isInteger(value.imageWidth) || !Number.isInteger(value.imageHeight) ||
        !finiteBetween(value.imageWidth, 1, maximumDimension) || !finiteBetween(value.imageHeight, 1, maximumDimension)) {
      return invalid("Image dimensions must be integers from 1 through 8,192.");
    }
    if (value.imageWidth * value.imageHeight > maximumPixels) {
      return invalid("Annotation image cannot exceed 16,000,000 pixels.");
    }
    if (!Array.isArray(value.shapes)) return invalid("Annotation shapes must be an ordered array.");
    if (value.shapes.length > maximumShapes) return invalid("Annotation payload cannot contain more than 64 shapes.");

    var ids = Object.create(null);
    var normalized = [];
    var aggregatePoints = 0;
    for (var index = 0; index < value.shapes.length; index += 1) {
      var shape = value.shapes[index];
      var label = "Shape " + (index + 1);
      if (!isRecord(shape) || typeof shape.type !== "string" ||
          ["pen", "arrow", "text"].indexOf(shape.type) === -1) {
        return invalid(label + " type is unsupported.");
      }
      if (typeof shape.id !== "string" || !identifierPattern.test(shape.id)) {
        return invalid(label + " id is invalid or too long.");
      }
      if (ids[shape.id]) return invalid("Annotation shape IDs must be unique; duplicate ID found.");
      ids[shape.id] = true;
      if (typeof shape.color !== "string" || !colorPattern.test(shape.color)) {
        return invalid(label + " color must use #RRGGBB.");
      }
      var color = shape.color.toUpperCase();

      if (shape.type === "pen") {
        if (!exactKeys(shape, ["id", "type", "color", "strokeWidth", "points"])) {
          return invalid(label + " pen has unexpected fields.");
        }
        if (!finiteBetween(shape.strokeWidth, 1, 16)) return invalid(label + " pen strokeWidth must be from 1 through 16.");
        if (!Array.isArray(shape.points) || shape.points.length < 2) return invalid(label + " pen must contain at least two points.");
        aggregatePoints += shape.points.length;
        if (aggregatePoints > maximumPenPoints) return invalid("Annotation payload cannot exceed 4,000 aggregate pen points.");
        var points = [];
        for (var pointIndex = 0; pointIndex < shape.points.length; pointIndex += 1) {
          var point = validatePoint(shape.points[pointIndex], label + " pen point " + (pointIndex + 1));
          if (!point.ok) return point;
          points.push(point.value);
        }
        normalized.push({ id: shape.id, type: "pen", color: color, strokeWidth: shape.strokeWidth, points: points });
        continue;
      }

      if (shape.type === "arrow") {
        if (!exactKeys(shape, ["id", "type", "color", "strokeWidth", "start", "end"])) {
          return invalid(label + " arrow has unexpected fields.");
        }
        if (!finiteBetween(shape.strokeWidth, 1, 16)) return invalid(label + " arrow strokeWidth must be from 1 through 16.");
        var start = validatePoint(shape.start, label + " arrow start");
        var end = validatePoint(shape.end, label + " arrow end");
        if (!start.ok) return start;
        if (!end.ok) return end;
        normalized.push({ id: shape.id, type: "arrow", color: color, strokeWidth: shape.strokeWidth, start: start.value, end: end.value });
        continue;
      }

      if (!exactKeys(shape, ["id", "type", "color", "x", "y", "width", "height", "fontSize", "text"])) {
        return invalid(label + " text has unexpected fields.");
      }
      if (!finiteBetween(shape.x, 0, 1) || !finiteBetween(shape.y, 0, 1) ||
          !finiteBetween(shape.width, 0, 1) || !finiteBetween(shape.height, 0, 1) ||
          shape.width === 0 || shape.height === 0 || shape.x + shape.width > 1 + Number.EPSILON ||
          shape.y + shape.height > 1 + Number.EPSILON) {
        return invalid(label + " text box must remain inside the image.");
      }
      if (!finiteBetween(shape.fontSize, 12, 64)) return invalid(label + " text fontSize must be from 12 through 64.");
      if (typeof shape.text !== "string" || shape.text.length > maximumTextLength) {
        return invalid(label + " text cannot exceed 1,000 characters.");
      }
      normalized.push({
        id: shape.id,
        type: "text",
        color: color,
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height,
        fontSize: shape.fontSize,
        text: shape.text
      });
    }
    return {
      ok: true,
      value: {
        version: 1,
        coordinateSpace: "normalized",
        imageWidth: value.imageWidth,
        imageHeight: value.imageHeight,
        shapes: normalized
      }
    };
  }

  function validTool(value) {
    return value === "pen" || value === "arrow" || value === "text";
  }

  function normalizedPreferences(value, fallback) {
    var preferences = {
      tool: fallback && validTool(fallback.tool) ? fallback.tool : "pen",
      color: fallback && typeof fallback.color === "string" && colorPattern.test(fallback.color) ? fallback.color.toUpperCase() : "#FF3366",
      strokeWidth: fallback && finiteBetween(fallback.strokeWidth, 1, 16) ? fallback.strokeWidth : 5
    };
    if (!isRecord(value)) return preferences;
    if (validTool(value.tool)) preferences.tool = value.tool;
    if (typeof value.color === "string" && colorPattern.test(value.color)) preferences.color = value.color.toUpperCase();
    if (finiteBetween(value.strokeWidth, 1, 16)) preferences.strokeWidth = value.strokeWidth;
    return preferences;
  }

  var preferences = normalizedPreferences(options.initialPreferences, null);
  var root = document.createElement("section");
  root.className = "shiplet-annotation-editor";
  root.hidden = true;
  root.setAttribute("aria-label", "Screenshot annotation editor");

  var toolbar = document.createElement("div");
  toolbar.className = "shiplet-annotation-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Annotation tools");

  var toolset = document.createElement("div");
  toolset.className = "shiplet-annotation-toolset";
  [
    ["pen", "Pen"],
    ["arrow", "Arrow"],
    ["text", "Text"]
  ].forEach(function (tool) {
    var button = document.createElement("button");
    button.type = "button";
    button.setAttribute("data-tool", tool[0]);
    button.textContent = tool[1];
    toolset.append(button);
  });

  var colorField = document.createElement("label");
  colorField.className = "shiplet-annotation-field";
  colorField.append(document.createTextNode("Color"));
  var colorControl = document.createElement("input");
  colorControl.type = "color";
  colorControl.setAttribute("aria-label", "Annotation color");
  colorField.append(colorControl);

  var widthField = document.createElement("label");
  widthField.className = "shiplet-annotation-field";
  widthField.append(document.createTextNode("Width"));
  var widthControl = document.createElement("input");
  widthControl.type = "range";
  widthControl.min = "1";
  widthControl.max = "16";
  widthControl.step = "1";
  widthControl.setAttribute("aria-label", "Stroke width");
  var widthValue = document.createElement("output");
  widthField.append(widthControl, widthValue);

  var undoControl = document.createElement("button");
  undoControl.type = "button";
  undoControl.setAttribute("data-action", "undo");
  undoControl.setAttribute("aria-label", "Undo annotation");
  undoControl.textContent = "Undo";

  var spacer = document.createElement("span");
  spacer.className = "shiplet-annotation-spacer";

  var cancelControl = document.createElement("button");
  cancelControl.type = "button";
  cancelControl.setAttribute("data-action", "cancel");
  cancelControl.setAttribute("aria-label", "Cancel annotation");
  cancelControl.textContent = "Cancel";

  var applyControl = document.createElement("button");
  applyControl.type = "button";
  applyControl.className = "shiplet-annotation-primary";
  applyControl.setAttribute("data-action", "apply");
  applyControl.setAttribute("aria-label", "Apply annotations");
  applyControl.textContent = "Apply";

  toolbar.append(
    toolset,
    colorField,
    widthField,
    undoControl,
    spacer,
    cancelControl,
    applyControl
  );

  var guidance = document.createElement("p");
  guidance.className = "shiplet-annotation-guidance";
  guidance.textContent = "Selected text: Arrow keys move, Alt+Arrow resizes, and Shift uses a larger step.";

  var errorMessage = document.createElement("p");
  errorMessage.className = "shiplet-annotation-error";
  errorMessage.setAttribute("role", "alert");
  errorMessage.hidden = true;

  var workspace = document.createElement("div");
  workspace.className = "shiplet-annotation-workspace";
  var stageElement = document.createElement("div");
  stageElement.className = "shiplet-annotation-stage";
  stageElement.setAttribute("data-shiplet-annotation-stage", "");
  var screenshot = document.createElement("img");
  screenshot.alt = "Screenshot being annotated";
  screenshot.draggable = false;
  var drawingSurface = document.createElement("canvas");
  drawingSurface.setAttribute("data-shiplet-annotation-canvas", "");
  drawingSurface.setAttribute("aria-label", "Screenshot drawing surface");
  var annotationTextLayer = document.createElement("div");
  annotationTextLayer.className = "shiplet-annotation-text-layer";
  stageElement.append(screenshot, drawingSurface, annotationTextLayer);
  workspace.append(stageElement);

  root.append(toolbar, guidance, errorMessage, workspace);
  options.container.appendChild(root);

  var stage = root.querySelector("[data-shiplet-annotation-stage]");
  var imageElement = root.querySelector("img");
  var canvas = root.querySelector("[data-shiplet-annotation-canvas]");
  var context = canvas.getContext("2d");
  var textLayer = root.querySelector(".shiplet-annotation-text-layer");
  var errorElement = root.querySelector(".shiplet-annotation-error");
  var undoButton = root.querySelector('[data-action="undo"]');
  var applyButton = root.querySelector('[data-action="apply"]');
  var cancelButton = root.querySelector('[data-action="cancel"]');
  var colorInput = root.querySelector('input[type="color"]');
  var widthInput = root.querySelector('input[type="range"]');
  var widthOutput = root.querySelector("output");
  var toolButtons = Array.prototype.slice.call(root.querySelectorAll("[data-tool]"));

  if (!context) {
    root.remove();
    throw new Error("Annotation canvas is unavailable.");
  }

  function emitError(message) {
    var bounded = String(message || "Unable to edit this screenshot.").slice(0, 240);
    errorElement.textContent = bounded;
    errorElement.hidden = false;
    if (typeof options.onError === "function") options.onError(bounded);
  }

  function clearError() {
    errorElement.textContent = "";
    errorElement.hidden = true;
  }

  function isActiveOpen(transaction) {
    return !destroyed && pendingOpen === transaction && transaction.generation === openGeneration;
  }

  function settleOpen(transaction, value) {
    if (!transaction || transaction.settled) return;
    transaction.settled = true;
    if (typeof transaction.cancelLoad === "function") {
      var cancelLoad = transaction.cancelLoad;
      transaction.cancelLoad = null;
      cancelLoad();
    }
    if (pendingOpen === transaction) pendingOpen = null;
    transaction.resolve(Boolean(value));
  }

  function retirePendingOpen() {
    openGeneration += 1;
    if (pendingOpen) settleOpen(pendingOpen, false);
  }

  function prepareOpen(input) {
    if (!isRecord(input) || !Object.keys(input).every(function (key) {
      return ["screenshotDataUrl", "screenshotAnnotations", "defaults"].indexOf(key) !== -1;
    })) {
      throw new Error("Annotation input has unexpected fields.");
    }
    var proposal = {
      screenshotDataUrl: input.screenshotDataUrl,
      screenshotAnnotations: input.screenshotAnnotations === undefined ? undefined : clone(input.screenshotAnnotations),
      defaults: input.defaults === undefined ? undefined : clone(input.defaults)
    };
    if (typeof proposal.screenshotDataUrl !== "string" || proposal.screenshotDataUrl.length > maximumDataUrlLength || !dataUrlPattern.test(proposal.screenshotDataUrl)) {
      throw new Error("Choose a PNG, JPEG, or WebP screenshot under 13.4 MB.");
    }
    var prior = null;
    if (proposal.screenshotAnnotations !== undefined) {
      prior = validateAnnotations(proposal.screenshotAnnotations);
      if (!prior.ok) throw new Error(prior.error);
    }
    return {
      screenshotDataUrl: proposal.screenshotDataUrl,
      screenshotAnnotations: proposal.screenshotAnnotations,
      defaults: proposal.defaults,
      preferences: normalizedPreferences(proposal.defaults, normalizedPreferences(options.initialPreferences, preferences)),
      prior: prior
    };
  }

  function failOpen(transaction, error) {
    if (!isActiveOpen(transaction)) return;
    busy = false;
    loadError = true;
    emitError(error && error.message ? error.message : "The screenshot could not be opened.");
    if (!imageWidth || !imageHeight) root.hidden = false;
    updateControls();
    settleOpen(transaction, false);
  }

  function notifyPreferences() {
    if (typeof options.onPreferenceChange === "function") options.onPreferenceChange(clone(preferences));
  }

  function round(value) {
    return Math.round(value * 1000000) / 1000000;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function nextId(prefix) {
    shapeCounter += 1;
    var candidate = prefix + "_" + shapeCounter;
    while (shapes.some(function (shape) { return shape.id === candidate; })) {
      shapeCounter += 1;
      candidate = prefix + "_" + shapeCounter;
    }
    return candidate;
  }

  function snapshot() {
    if (!imageWidth || !imageHeight) return null;
    return {
      version: 1,
      coordinateSpace: "normalized",
      imageWidth: imageWidth,
      imageHeight: imageHeight,
      shapes: clone(shapes)
    };
  }

  function selectedText() {
    return shapes.find(function (shape) {
      return shape.type === "text" && shape.id === selectedTextId;
    }) || null;
  }

  function pushHistory(before) {
    history.push(clone(before));
    if (history.length > 100) history.shift();
  }

  function updateControls() {
    toolButtons.forEach(function (button) {
      button.setAttribute("aria-pressed", button.getAttribute("data-tool") === preferences.tool ? "true" : "false");
    });
    colorInput.value = preferences.color;
    widthInput.value = String(preferences.strokeWidth);
    widthOutput.value = String(preferences.strokeWidth);
    widthOutput.textContent = String(preferences.strokeWidth);
    undoButton.disabled = history.length === 0 || busy;
    var current = snapshot();
    applyButton.disabled = busy || loadError || !current || current.shapes.length === 0 || !validateAnnotations(current).ok;
  }

  function drawArrow(target, shape, width, height) {
    var startX = shape.start.x * width;
    var startY = shape.start.y * height;
    var endX = shape.end.x * width;
    var endY = shape.end.y * height;
    var angle = Math.atan2(endY - startY, endX - startX);
    var head = Math.max(shape.strokeWidth * 3, 14);
    target.save();
    target.strokeStyle = shape.color;
    target.fillStyle = shape.color;
    target.lineWidth = shape.strokeWidth;
    target.lineCap = "round";
    target.lineJoin = "round";
    target.beginPath();
    target.moveTo(startX, startY);
    target.lineTo(endX, endY);
    target.stroke();
    target.beginPath();
    target.moveTo(endX, endY);
    target.lineTo(endX - head * Math.cos(angle - Math.PI / 6), endY - head * Math.sin(angle - Math.PI / 6));
    target.lineTo(endX - head * Math.cos(angle + Math.PI / 6), endY - head * Math.sin(angle + Math.PI / 6));
    target.closePath();
    target.fill();
    target.restore();
  }

  function drawPen(target, shape, width, height) {
    if (!shape.points.length) return;
    target.save();
    target.strokeStyle = shape.color;
    target.lineWidth = shape.strokeWidth;
    target.lineCap = "round";
    target.lineJoin = "round";
    target.beginPath();
    target.moveTo(shape.points[0].x * width, shape.points[0].y * height);
    for (var index = 1; index < shape.points.length; index += 1) {
      target.lineTo(shape.points[index].x * width, shape.points[index].y * height);
    }
    target.stroke();
    target.restore();
  }

  function paintVectors() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    shapes.forEach(function (shape) {
      if (shape.type === "pen") drawPen(context, shape, canvas.width, canvas.height);
      if (shape.type === "arrow") drawArrow(context, shape, canvas.width, canvas.height);
    });
    if (draft) {
      if (draft.type === "pen") drawPen(context, draft, canvas.width, canvas.height);
      if (draft.type === "arrow") drawArrow(context, draft, canvas.width, canvas.height);
    }
  }

  function focusSelectedText() {
    if (!selectedTextId) return;
    var field = textLayer.querySelector('[data-shape-id="' + CSS.escape(selectedTextId) + '"] textarea');
    if (field) {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }

  function syncTextSelectionDom() {
    Array.prototype.forEach.call(textLayer.querySelectorAll("[data-shape-id]"), function (wrapper) {
      var selected = wrapper.getAttribute("data-shape-id") === selectedTextId;
      wrapper.classList.toggle("is-selected", selected);
      Array.prototype.forEach.call(wrapper.querySelectorAll("[data-handle]"), function (handle) {
        handle.hidden = !selected;
      });
    });
  }

  function renderTextLayer(focusId) {
    textLayer.replaceChildren();
    shapes.forEach(function (shape) {
      if (shape.type !== "text") return;
      var wrapper = document.createElement("div");
      wrapper.className = "shiplet-annotation-text-box" + (shape.id === selectedTextId ? " is-selected" : "");
      wrapper.setAttribute("data-shape-id", shape.id);
      wrapper.style.left = (shape.x * 100) + "%";
      wrapper.style.top = (shape.y * 100) + "%";
      wrapper.style.width = (shape.width * 100) + "%";
      wrapper.style.height = (shape.height * 100) + "%";
      wrapper.style.setProperty("--annotation-color", shape.color);

      var textarea = document.createElement("textarea");
      textarea.setAttribute("aria-label", "Text annotation");
      textarea.maxLength = maximumTextLength;
      textarea.spellcheck = true;
      textarea.value = shape.text;
      textarea.style.color = shape.color;
      textarea.style.fontSize = shape.fontSize + "px";
      wrapper.appendChild(textarea);

      var move = document.createElement("button");
      move.type = "button";
      move.className = "shiplet-annotation-handle shiplet-annotation-move";
      move.setAttribute("aria-label", "Move text annotation");
      move.setAttribute("data-handle", "move");
      move.textContent = "Move";
      move.hidden = shape.id !== selectedTextId;
      wrapper.appendChild(move);

      var resize = document.createElement("button");
      resize.type = "button";
      resize.className = "shiplet-annotation-handle shiplet-annotation-resize";
      resize.setAttribute("aria-label", "Resize text annotation");
      resize.setAttribute("data-handle", "resize");
      resize.textContent = "Resize";
      resize.hidden = shape.id !== selectedTextId;
      wrapper.appendChild(resize);
      textLayer.appendChild(wrapper);
    });
    if (focusId) requestAnimationFrame(focusSelectedText);
  }

  function render(focusId) {
    paintVectors();
    renderTextLayer(focusId);
    updateControls();
  }

  function pointFromEvent(event) {
    var bounds = canvas.getBoundingClientRect();
    return {
      x: round(clamp((event.clientX - bounds.left) / bounds.width, 0, 1)),
      y: round(clamp((event.clientY - bounds.top) / bounds.height, 0, 1))
    };
  }

  function commitTextEdit() {
    if (!editBaseline) return;
    var before = editBaseline;
    editBaseline = null;
    if (JSON.stringify(before) !== JSON.stringify(shapes)) pushHistory(before);
    updateControls();
  }

  function cancelPointerWork(restore) {
    if (pointerWork && restore && pointerWork.before) shapes = clone(pointerWork.before);
    draft = null;
    pointerWork = null;
    render();
  }

  function setTool(tool) {
    if (!validTool(tool) || tool === preferences.tool) return;
    commitTextEdit();
    preferences.tool = tool;
    notifyPreferences();
    updateControls();
  }

  toolButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      setTool(button.getAttribute("data-tool"));
    }, { signal: signal });
  });

  colorInput.addEventListener("input", function () {
    var next = colorInput.value.toUpperCase();
    if (!colorPattern.test(next)) return;
    if (next !== preferences.color) {
      preferences.color = next;
      notifyPreferences();
    }
    var text = selectedText();
    if (text && text.color !== next) {
      commitTextEdit();
      var before = clone(shapes);
      text = selectedText();
      text.color = next;
      pushHistory(before);
      render();
      return;
    }
    updateControls();
  }, { signal: signal });

  widthInput.addEventListener("input", function () {
    var next = Number(widthInput.value);
    if (!finiteBetween(next, 1, 16)) return;
    if (next !== preferences.strokeWidth) {
      preferences.strokeWidth = next;
      notifyPreferences();
    }
    updateControls();
  }, { signal: signal });

  canvas.addEventListener("pointerdown", function (event) {
    if (busy || !imageWidth || event.button > 0) return;
    clearError();
    commitTextEdit();
    var point = pointFromEvent(event);
    if (preferences.tool === "text") {
      if (shapes.length >= maximumShapes) {
        emitError("Annotation payload cannot contain more than 64 shapes.");
        return;
      }
      var width = 0.36;
      var height = 0.22;
      var shape = {
        id: nextId("text"),
        type: "text",
        color: preferences.color,
        x: round(clamp(point.x, 0, 1 - width)),
        y: round(clamp(point.y, 0, 1 - height)),
        width: width,
        height: height,
        fontSize: 18,
        text: ""
      };
      pushHistory(shapes);
      shapes.push(shape);
      selectedTextId = shape.id;
      render(shape.id);
      event.preventDefault();
      return;
    }
    if (shapes.length >= maximumShapes) {
      emitError("Annotation payload cannot contain more than 64 shapes.");
      return;
    }
    selectedTextId = null;
    pointerWork = { kind: "draw", pointerId: event.pointerId, before: clone(shapes) };
    if (preferences.tool === "pen") {
      draft = { id: nextId("pen"), type: "pen", color: preferences.color, strokeWidth: preferences.strokeWidth, points: [point] };
    } else {
      draft = { id: nextId("arrow"), type: "arrow", color: preferences.color, strokeWidth: preferences.strokeWidth, start: point, end: point };
    }
    try { canvas.setPointerCapture(event.pointerId); } catch (_error) {}
    render();
    event.preventDefault();
  }, { signal: signal });

  canvas.addEventListener("pointermove", function (event) {
    if (!pointerWork || pointerWork.kind !== "draw" || pointerWork.pointerId !== event.pointerId || !draft) return;
    var point = pointFromEvent(event);
    if (draft.type === "pen") {
      var previous = draft.points[draft.points.length - 1];
      if (!previous || previous.x !== point.x || previous.y !== point.y) draft.points.push(point);
    } else {
      draft.end = point;
    }
    paintVectors();
    event.preventDefault();
  }, { signal: signal });

  canvas.addEventListener("pointerup", function (event) {
    if (!pointerWork || pointerWork.kind !== "draw" || pointerWork.pointerId !== event.pointerId || !draft) return;
    var point = pointFromEvent(event);
    if (draft.type === "pen") {
      var last = draft.points[draft.points.length - 1];
      if (!last || last.x !== point.x || last.y !== point.y) draft.points.push(point);
      if (draft.points.length === 1) draft.points.push({ x: round(clamp(point.x + 0.000001, 0, 1)), y: point.y });
    } else {
      draft.end = point;
    }
    var committed = clone(draft);
    var before = pointerWork.before;
    draft = null;
    pointerWork = null;
    shapes.push(committed);
    pushHistory(before);
    render();
    event.preventDefault();
  }, { signal: signal });

  canvas.addEventListener("pointercancel", function (event) {
    if (!pointerWork || pointerWork.kind !== "draw" || pointerWork.pointerId !== event.pointerId) return;
    cancelPointerWork(false);
  }, { signal: signal });

  textLayer.addEventListener("pointerdown", function (event) {
    var wrapper = event.target.closest("[data-shape-id]");
    if (!wrapper) return;
    selectedTextId = wrapper.getAttribute("data-shape-id");
    syncTextSelectionDom();
  }, { signal: signal });

  textLayer.addEventListener("focusin", function (event) {
    if (!(event.target instanceof HTMLTextAreaElement)) return;
    var wrapper = event.target.closest("[data-shape-id]");
    if (!wrapper) return;
    selectedTextId = wrapper.getAttribute("data-shape-id");
    syncTextSelectionDom();
    if (!editBaseline) editBaseline = clone(shapes);
    updateControls();
  }, { signal: signal });

  textLayer.addEventListener("input", function (event) {
    if (!(event.target instanceof HTMLTextAreaElement)) return;
    var wrapper = event.target.closest("[data-shape-id]");
    var shape = wrapper && shapes.find(function (candidate) { return candidate.id === wrapper.getAttribute("data-shape-id"); });
    if (!shape || shape.type !== "text") return;
    shape.text = event.target.value.slice(0, maximumTextLength);
    updateControls();
  }, { signal: signal });

  textLayer.addEventListener("focusout", function (event) {
    if (!(event.target instanceof HTMLTextAreaElement)) return;
    commitTextEdit();
  }, { signal: signal });

  textLayer.addEventListener("compositionstart", function () { composing = true; }, { signal: signal });
  textLayer.addEventListener("compositionend", function () { composing = false; }, { signal: signal });

  root.addEventListener("pointerdown", function (event) {
    var handle = event.target.closest("[data-handle]");
    if (!handle || busy) return;
    var wrapper = handle.closest("[data-shape-id]");
    var shape = wrapper && shapes.find(function (candidate) { return candidate.id === wrapper.getAttribute("data-shape-id"); });
    if (!shape || shape.type !== "text") return;
    selectedTextId = shape.id;
    pointerWork = {
      kind: handle.getAttribute("data-handle"),
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      original: clone(shape),
      before: clone(shapes)
    };
    try { root.setPointerCapture(event.pointerId); } catch (_error) {}
    event.preventDefault();
  }, { signal: signal });

  root.addEventListener("pointermove", function (event) {
    if (!pointerWork || pointerWork.kind === "draw" || pointerWork.pointerId !== event.pointerId) return;
    var shape = selectedText();
    if (!shape) return;
    var bounds = stage.getBoundingClientRect();
    var deltaX = (event.clientX - pointerWork.startX) / bounds.width;
    var deltaY = (event.clientY - pointerWork.startY) / bounds.height;
    if (pointerWork.kind === "move") {
      shape.x = round(clamp(pointerWork.original.x + deltaX, 0, 1 - shape.width));
      shape.y = round(clamp(pointerWork.original.y + deltaY, 0, 1 - shape.height));
    } else {
      shape.width = round(clamp(pointerWork.original.width + deltaX, 0.08, 1 - shape.x));
      shape.height = round(clamp(pointerWork.original.height + deltaY, 0.08, 1 - shape.y));
    }
    renderTextLayer();
    updateControls();
    event.preventDefault();
  }, { signal: signal });

  root.addEventListener("pointerup", function (event) {
    if (!pointerWork || pointerWork.kind === "draw" || pointerWork.pointerId !== event.pointerId) return;
    var before = pointerWork.before;
    pointerWork = null;
    if (JSON.stringify(before) !== JSON.stringify(shapes)) pushHistory(before);
    render();
    event.preventDefault();
  }, { signal: signal });

  root.addEventListener("pointercancel", function (event) {
    if (!pointerWork || pointerWork.kind === "draw" || pointerWork.pointerId !== event.pointerId) return;
    cancelPointerWork(true);
  }, { signal: signal });

  function undo() {
    if (!history.length || busy) return;
    commitTextEdit();
    if (!history.length) return;
    shapes = history.pop();
    if (!selectedText()) selectedTextId = null;
    render();
  }

  undoButton.addEventListener("click", undo, { signal: signal });

  function moveOrResizeSelected(event) {
    var shape = selectedText();
    if (!shape || ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].indexOf(event.key) === -1) return false;
    var focusedHandle = event.target && event.target.getAttribute ? event.target.getAttribute("data-handle") : null;
    var step = event.shiftKey ? 0.05 : 0.01;
    var horizontal = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
    var vertical = event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0;
    var before = clone(shapes);
    if (event.altKey) {
      shape.width = round(clamp(shape.width + horizontal, 0.08, 1 - shape.x));
      shape.height = round(clamp(shape.height + vertical, 0.08, 1 - shape.y));
    } else {
      shape.x = round(clamp(shape.x + horizontal, 0, 1 - shape.width));
      shape.y = round(clamp(shape.y + vertical, 0, 1 - shape.height));
    }
    if (JSON.stringify(before) !== JSON.stringify(shapes)) pushHistory(before);
    render();
    if (focusedHandle) {
      var replacement = textLayer.querySelector('[data-handle="' + focusedHandle + '"]');
      if (replacement) replacement.focus();
    }
    event.preventDefault();
    return true;
  }

  root.addEventListener("keydown", function (event) {
    var inText = event.target instanceof HTMLTextAreaElement;
    if (inText || composing || event.keyCode === 229) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "z") {
      undo();
      event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      cancel();
      event.preventDefault();
      return;
    }
    moveOrResizeSelected(event);
  }, { signal: signal });

  function drawWrappedText(target, shape, width, height) {
    var x = shape.x * width;
    var y = shape.y * height;
    var boxWidth = shape.width * width;
    var boxHeight = shape.height * height;
    var padding = Math.max(4, shape.fontSize * 0.3);
    target.save();
    target.fillStyle = "rgba(255,255,255,0.88)";
    target.fillRect(x, y, boxWidth, boxHeight);
    target.strokeStyle = shape.color;
    target.lineWidth = 2;
    target.strokeRect(x + 1, y + 1, Math.max(0, boxWidth - 2), Math.max(0, boxHeight - 2));
    target.fillStyle = shape.color;
    target.font = shape.fontSize + "px system-ui, sans-serif";
    target.textBaseline = "top";
    var lineHeight = shape.fontSize * 1.25;
    var cursorY = y + padding;
    shape.text.split("\n").forEach(function (paragraph) {
      var words = paragraph.split(/\s+/);
      var line = "";
      if (paragraph === "") words = [""];
      words.forEach(function (word) {
        var candidate = line ? line + " " + word : word;
        if (line && target.measureText(candidate).width > boxWidth - padding * 2) {
          if (cursorY + lineHeight <= y + boxHeight) target.fillText(line, x + padding, cursorY);
          cursorY += lineHeight;
          line = word;
        } else {
          line = candidate;
        }
      });
      if (cursorY + lineHeight <= y + boxHeight) target.fillText(line, x + padding, cursorY);
      cursorY += lineHeight;
    });
    target.restore();
  }

  async function apply() {
    if (busy || destroyed || root.hidden || loadError) return;
    commitTextEdit();
    var current = snapshot();
    var validation = validateAnnotations(current);
    if (!validation.ok || validation.value.shapes.length === 0) {
      emitError(validation.ok ? "Add at least one annotation before applying." : validation.error);
      updateControls();
      return;
    }
    busy = true;
    updateControls();
    clearError();
    try {
      var output = document.createElement("canvas");
      output.width = imageWidth;
      output.height = imageHeight;
      var outputContext = output.getContext("2d");
      if (!outputContext || !sourceImage) throw new Error("The annotated screenshot could not be rendered.");
      outputContext.drawImage(sourceImage, 0, 0, imageWidth, imageHeight);
      validation.value.shapes.forEach(function (shape) {
        if (shape.type === "pen") drawPen(outputContext, shape, imageWidth, imageHeight);
        if (shape.type === "arrow") drawArrow(outputContext, shape, imageWidth, imageHeight);
        if (shape.type === "text") drawWrappedText(outputContext, shape, imageWidth, imageHeight);
      });
      var screenshotDataUrl = output.toDataURL("image/png");
      if (screenshotDataUrl.length > maximumDataUrlLength) throw new Error("The annotated screenshot exceeds the 13.4 MB limit.");
      if (typeof options.onApply === "function") {
        options.onApply({ screenshotDataUrl: screenshotDataUrl, screenshotAnnotations: clone(validation.value) });
      }
    } catch (error) {
      emitError(error && error.message ? error.message : "The annotated screenshot could not be rendered.");
    } finally {
      busy = false;
      updateControls();
    }
  }

  applyButton.addEventListener("click", apply, { signal: signal });

  function close() {
    if (destroyed) return;
    retirePendingOpen();
    busy = false;
    draft = null;
    pointerWork = null;
    editBaseline = null;
    composing = false;
    root.hidden = true;
    updateControls();
  }

  function cancel() {
    close();
    if (typeof options.onCancel === "function") options.onCancel();
  }

  cancelButton.addEventListener("click", cancel, { signal: signal });

  function loadImage(dataUrl, transaction) {
    return new Promise(function (resolve, reject) {
      var image;
      var settled = false;
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        if (image) {
          image.onload = null;
          image.onerror = null;
        }
        if (transaction.cancelLoad === cancelLoad) transaction.cancelLoad = null;
        callback(value);
      }
      function cancelLoad() {
        finish(reject, new Error("The screenshot load was canceled."));
      }
      try {
        image = new Image();
        transaction.cancelLoad = cancelLoad;
        image.decoding = "async";
        image.onload = function () { finish(resolve, image); };
        image.onerror = function () { finish(reject, new Error("The screenshot must be a decodable PNG, JPEG, or WebP image.")); };
        image.src = dataUrl;
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  function open(input) {
    if (destroyed) return Promise.resolve(false);
    var transaction = {
      generation: openGeneration + 1,
      settled: false,
      resolve: null,
      cancelLoad: null
    };
    openGeneration = transaction.generation;
    if (pendingOpen) settleOpen(pendingOpen, false);
    pendingOpen = transaction;
    busy = true;
    updateControls();
    var result = new Promise(function (resolve) {
      transaction.resolve = resolve;
    });

    try {
      var proposal = prepareOpen(input);
      loadImage(proposal.screenshotDataUrl, transaction).then(function (decoded) {
        if (!isActiveOpen(transaction)) return;
        try {
          if (!decoded.naturalWidth || !decoded.naturalHeight || decoded.naturalWidth > maximumDimension || decoded.naturalHeight > maximumDimension) {
            throw new Error("Screenshot dimensions must be from 1 through 8,192 pixels.");
          }
          if (decoded.naturalWidth * decoded.naturalHeight > maximumPixels) {
            throw new Error("Screenshot images cannot exceed 16,000,000 pixels.");
          }
          if (proposal.prior && (proposal.prior.value.imageWidth !== decoded.naturalWidth || proposal.prior.value.imageHeight !== decoded.naturalHeight)) {
            throw new Error("Annotation dimensions do not match the original screenshot.");
          }
          var initialShapes = proposal.prior ? clone(proposal.prior.value.shapes) : [];
          if (!isActiveOpen(transaction)) return;
          preferences = proposal.preferences;
          sourceImage = decoded;
          sourceDataUrl = proposal.screenshotDataUrl;
          imageWidth = decoded.naturalWidth;
          imageHeight = decoded.naturalHeight;
          shapes = initialShapes;
          history = [];
          draft = null;
          pointerWork = null;
          editBaseline = null;
          composing = false;
          var firstText = shapes.find(function (shape) { return shape.type === "text"; });
          selectedTextId = firstText ? firstText.id : null;
          imageElement.src = sourceDataUrl;
          canvas.width = imageWidth;
          canvas.height = imageHeight;
          stage.style.aspectRatio = imageWidth + " / " + imageHeight;
          loadError = false;
          busy = false;
          clearError();
          root.hidden = false;
          render();
          settleOpen(transaction, true);
        } catch (error) {
          failOpen(transaction, error);
        }
      }, function (error) {
        failOpen(transaction, error);
      });
    } catch (error) {
      failOpen(transaction, error);
    }
    return result;
  }

  function destroy() {
    if (destroyed) return;
    retirePendingOpen();
    destroyed = true;
    controller.abort();
    busy = false;
    loadError = false;
    imageWidth = 0;
    imageHeight = 0;
    selectedTextId = null;
    editBaseline = null;
    composing = false;
    draft = null;
    pointerWork = null;
    shapes = [];
    history = [];
    sourceImage = null;
    sourceDataUrl = "";
    canvas.width = 1;
    canvas.height = 1;
    root.remove();
  }

  updateControls();
  return {
    open: open,
    close: close,
    destroy: destroy,
    get current() {
      var current = snapshot();
      return current ? clone(current) : null;
    }
  };
}
`;
}

/** Scoped styles for the generated trusted annotation editor. */
export function reviewAnnotationEditorStyles(): string {
  return String.raw`
.shiplet-annotation-editor {
  --annotation-border: #cbd5e1;
  --annotation-ink: #172033;
  --annotation-muted: #5e6b7d;
  box-sizing: border-box;
  color: var(--annotation-ink);
  display: grid;
  font: 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  gap: 10px;
  min-width: 0;
  width: 100%;
}
.shiplet-annotation-editor[hidden] { display: none !important; }
.shiplet-annotation-editor *, .shiplet-annotation-editor *::before, .shiplet-annotation-editor *::after { box-sizing: border-box; }
.shiplet-annotation-toolbar {
  align-items: center;
  background: #f8fafc;
  border: 1px solid var(--annotation-border);
  border-radius: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px;
}
.shiplet-annotation-toolset { display: flex; gap: 4px; }
.shiplet-annotation-toolbar button,
.shiplet-annotation-handle {
  background: #fff;
  border: 1px solid #aab5c5;
  border-radius: 7px;
  color: #172033;
  cursor: pointer;
  font: inherit;
  min-height: 36px;
  padding: 7px 11px;
}
.shiplet-annotation-toolbar button[aria-pressed="true"] { background: #172033; border-color: #172033; color: #fff; }
.shiplet-annotation-toolbar button:disabled { cursor: default; opacity: 0.48; }
.shiplet-annotation-toolbar button:focus-visible,
.shiplet-annotation-editor input:focus-visible,
.shiplet-annotation-editor textarea:focus-visible,
.shiplet-annotation-handle:focus-visible { outline: 3px solid #7dd3fc; outline-offset: 2px; }
.shiplet-annotation-primary { background: #075985 !important; border-color: #075985 !important; color: #fff !important; font-weight: 700 !important; }
.shiplet-annotation-spacer { flex: 1 1 18px; }
.shiplet-annotation-field { align-items: center; color: var(--annotation-muted); display: inline-flex; gap: 6px; white-space: nowrap; }
.shiplet-annotation-field input[type="color"] { background: #fff; border: 1px solid #aab5c5; border-radius: 6px; height: 36px; padding: 3px; width: 44px; }
.shiplet-annotation-field input[type="range"] { max-width: 110px; }
.shiplet-annotation-field output { color: var(--annotation-ink); min-width: 2ch; }
.shiplet-annotation-guidance { color: var(--annotation-muted); font-size: 12px; margin: 0; }
.shiplet-annotation-error { background: #fff1f2; border: 1px solid #fda4af; border-radius: 8px; color: #9f1239; margin: 0; padding: 9px 11px; }
.shiplet-annotation-workspace { background: #dbe2ea; border: 1px solid var(--annotation-border); border-radius: 10px; min-height: 180px; overflow: auto; padding: 12px; }
.shiplet-annotation-stage { margin: 0 auto; max-width: 100%; overflow: visible; position: relative; touch-action: none; width: var(--annotation-source-width, 100%); }
.shiplet-annotation-stage > img { display: block; height: 100%; object-fit: contain; pointer-events: none; user-select: none; width: 100%; }
.shiplet-annotation-stage > canvas,
.shiplet-annotation-text-layer { height: 100%; inset: 0; position: absolute; width: 100%; }
.shiplet-annotation-stage > canvas { cursor: crosshair; touch-action: none; }
.shiplet-annotation-text-layer { pointer-events: none; }
.shiplet-annotation-text-box { border: 2px solid transparent; min-height: 28px; pointer-events: auto; position: absolute; }
.shiplet-annotation-text-box.is-selected { border-color: var(--annotation-color); box-shadow: 0 0 0 2px rgba(255,255,255,.9); }
.shiplet-annotation-text-box textarea { background: rgba(255,255,255,.88); border: 0; color: inherit; height: 100%; line-height: 1.25; overflow: auto; padding: 6px; resize: none; width: 100%; }
.shiplet-annotation-handle { font-size: 0; height: 30px; min-height: 30px; padding: 0; position: absolute; width: 30px; }
.shiplet-annotation-handle::after { color: #172033; font-size: 15px; font-weight: 800; }
.shiplet-annotation-move { left: -16px; top: -16px; }
.shiplet-annotation-move::after { content: "↕"; }
.shiplet-annotation-resize { bottom: -16px; right: -16px; }
.shiplet-annotation-resize::after { content: "↘"; }
@media (max-width: 520px) {
  .shiplet-annotation-toolbar { align-items: stretch; }
  .shiplet-annotation-toolset { flex: 1 1 100%; }
  .shiplet-annotation-toolset button { flex: 1 1 0; }
  .shiplet-annotation-spacer { display: none; }
  .shiplet-annotation-workspace { padding: 8px; }
  .shiplet-annotation-guidance { font-size: 11px; }
}
`;
}
