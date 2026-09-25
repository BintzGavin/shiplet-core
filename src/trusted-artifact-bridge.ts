export type TrustedArtifactCaptureBinding = {
  channelNonce: string;
  shipletId: string;
  revisionId: string;
  requestId: string;
};

export type TrustedArtifactCapture = {
  screenshotDataUrl: string | null;
  screenshotFailureNote: string | null;
  screenshotMode: "element";
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
  };
  coordinates: {
    pageX: number;
    pageY: number;
    viewportX: number;
    viewportY: number;
  };
  selectedElement: {
    selector: string;
    tagName: string;
    text: string;
  };
  captureContext: {
    documentWidth: number;
    documentHeight: number;
    scrollX: number;
    scrollY: number;
  };
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SCREENSHOT_DATA_URL =
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_SCREENSHOT_DATA_URL_BYTES = 13_400_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function finiteNumber(value: unknown, minimum: number, maximum: number) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function validBinding(binding: TrustedArtifactCaptureBinding) {
  return (
    IDENTIFIER.test(binding.channelNonce) &&
    IDENTIFIER.test(binding.shipletId) &&
    IDENTIFIER.test(binding.revisionId) &&
    IDENTIFIER.test(binding.requestId)
  );
}

export function parseTrustedArtifactCapture(
  value: unknown,
  binding: TrustedArtifactCaptureBinding,
): TrustedArtifactCapture | null {
  if (!validBinding(binding) || !isRecord(value)) return null;
  if (
    !exactKeys(value, [
      "protocol",
      "type",
      "channelNonce",
      "shipletId",
      "revisionId",
      "requestId",
      "status",
      "payload",
    ]) ||
    value.protocol !== "shiplet.artifact.capture.result.v1" ||
    value.type !== "result" ||
    value.channelNonce !== binding.channelNonce ||
    value.shipletId !== binding.shipletId ||
    value.revisionId !== binding.revisionId ||
    value.requestId !== binding.requestId ||
    value.status !== "captured" ||
    !isRecord(value.payload)
  ) {
    return null;
  }
  return parseTrustedArtifactCapturePayload(value.payload);
}

export function parseTrustedArtifactCapturePayload(
  payload: unknown,
): TrustedArtifactCapture | null {
  if (
    !isRecord(payload) ||
    !exactKeys(payload, [
      "screenshotDataUrl",
      "screenshotFailureNote",
      "screenshotMode",
      "viewport",
      "coordinates",
      "selectedElement",
      "captureContext",
    ]) ||
    payload.screenshotMode !== "element" ||
    !isRecord(payload.viewport) ||
    !isRecord(payload.coordinates) ||
    !isRecord(payload.selectedElement) ||
    !isRecord(payload.captureContext)
  ) {
    return null;
  }
  const screenshotDataUrl = payload.screenshotDataUrl;
  if (
    screenshotDataUrl !== null &&
    (!boundedString(screenshotDataUrl, MAX_SCREENSHOT_DATA_URL_BYTES) ||
      !SCREENSHOT_DATA_URL.test(screenshotDataUrl))
  ) {
    return null;
  }
  const screenshotFailureNote = payload.screenshotFailureNote;
  if (
    screenshotFailureNote !== null &&
    !boundedString(screenshotFailureNote, 500)
  ) {
    return null;
  }
  if (
    !exactKeys(payload.viewport, ["width", "height", "devicePixelRatio"]) ||
    !finiteNumber(payload.viewport.width, 1, 100_000) ||
    !finiteNumber(payload.viewport.height, 1, 100_000) ||
    !finiteNumber(payload.viewport.devicePixelRatio, 0.1, 10) ||
    !exactKeys(payload.coordinates, [
      "pageX",
      "pageY",
      "viewportX",
      "viewportY",
    ]) ||
    !finiteNumber(payload.coordinates.pageX, -10_000_000, 10_000_000) ||
    !finiteNumber(payload.coordinates.pageY, -10_000_000, 10_000_000) ||
    !finiteNumber(payload.coordinates.viewportX, -100_000, 100_000) ||
    !finiteNumber(payload.coordinates.viewportY, -100_000, 100_000) ||
    !exactKeys(payload.selectedElement, ["selector", "tagName", "text"]) ||
    !boundedString(payload.selectedElement.selector, 1200) ||
    payload.selectedElement.selector.length === 0 ||
    !boundedString(payload.selectedElement.tagName, 64) ||
    !/^[A-Z][A-Z0-9-]{0,63}$/.test(payload.selectedElement.tagName) ||
    !boundedString(payload.selectedElement.text, 500) ||
    !exactKeys(payload.captureContext, [
      "documentWidth",
      "documentHeight",
      "scrollX",
      "scrollY",
    ]) ||
    !finiteNumber(payload.captureContext.documentWidth, 1, 100_000) ||
    !finiteNumber(payload.captureContext.documentHeight, 1, 100_000) ||
    !finiteNumber(payload.captureContext.scrollX, -10_000_000, 10_000_000) ||
    !finiteNumber(payload.captureContext.scrollY, -10_000_000, 10_000_000)
  ) {
    return null;
  }
  return payload as TrustedArtifactCapture;
}

export function injectTrustedArtifactBridge(
  html: string,
  scriptPath = "/api/review/artifact-bridge.js",
) {
  if (
    typeof html !== "string" ||
    typeof scriptPath !== "string" ||
    !/^\/api\/review\/artifact-bridge\.js$/.test(scriptPath)
  ) {
    throw new TypeError("Invalid trusted artifact bridge input");
  }
  const tag = `<script data-shiplet-kernel-artifact-bridge="v1" src="${scriptPath}" defer></script>`;
  const headEnd = html.search(/<\/head\s*>/i);
  if (headEnd >= 0)
    return `${html.slice(0, headEnd)}${tag}${html.slice(headEnd)}`;
  const bodyStart = html.search(/<body(?:\s[^>]*)?>/i);
  if (bodyStart >= 0)
    return `${html.slice(0, bodyStart)}${tag}${html.slice(bodyStart)}`;
  return `${tag}${html}`;
}

export function trustedArtifactBridgeScript(embedded = false) {
  const script = String.raw`${embedded ? "function attachShipletPageBridge(frame, expectedOrigin) {" : "(() => {"}
"use strict";
${embedded ? "const parent = frame.contentWindow; if (!parent) return () => {};" : 'if (window === parent || typeof MessageChannel !== "function") return;'}
const win = window, doc = document;
let origin = "", nonce = "", shipletId = "", revisionId = "", port = null;
let captureId = "", pageId = "", highlight = null;
let anchorTarget = null, anchorId = "", offsetX = 0, offsetY = 0;
let framePending = false, pointerTimer = 0, pointerAt = 0, pointer = null, following = false;
let savedTargets = new Map(), targetsPending = false, observed = new Set(), lastTargets = "";
let mutationWatch = null, resizeWatch = null, layoutWatch = null;
let routeTimer = 0, routePending = false, lastRoute = "";
let shortcuts = false, composing = false;
let leaseExpiry = 0, leaseTimer = 0, leaseSeq = 0;
const envelopeKeys = ["protocol", "type", "channelNonce", "shipletId", "revisionId"];
const privateSelector = "shiplet-feedback,[data-shiplet-private]";
const highlightSelector = "[data-shiplet-artifact-capture-highlight]";
const captureLimits = ["images", "canvas", "media", "form-values", "external-styles"];
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function callable(value) { return typeof value === "function"; }
function exactKeys(value, keys) { const actual = Object.keys(value); return actual.length === keys.length && actual.every((key) => keys.includes(key)); }
function messageKeys(value, extras = []) { return exactKeys(value, envelopeKeys.concat(extras)); }
function isIdentifier(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value); }
function inRange(value, minimum, maximum) { return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum; }
function safeText(value, maximum) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum); }
function publicText(target, maximum) {
if (target.closest(privateSelector)) return "";
const clone = target.cloneNode(true);
clone.querySelectorAll(privateSelector + ",script,style,input,textarea,select").forEach(node => node.remove());
return safeText(clone.textContent, maximum);
}
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, Number(value) || 0)); }
function envelope(protocol, type, payload) { return Object.assign({ protocol, type, channelNonce: nonce, shipletId, revisionId }, payload); }
function postBridge(protocol, type, payload) {
if (!liveChannel() || !callable(port.postMessage)) return false;
port.postMessage(envelope(protocol, type, payload));
return true;
}
function pointAt(viewportX, viewportY) {
return {
pageX: clamp(viewportX + (Number(win.scrollX) || 0), -1e7, 1e7),
pageY: clamp(viewportY + (Number(win.scrollY) || 0), -1e7, 1e7),
viewportX,
viewportY,
};
}
function rectState(rect) {
return {
left: clamp(rect.left, -1e5, 1e5),
top: clamp(rect.top, -1e5, 1e5),
width: clamp(rect.width, 0, 1e5),
height: clamp(rect.height, 0, 1e5),
};
}
function routeUrl() {
try {
const sensitive = /token|secret|password|credential|authorization|signature/i;
const names = new Set("claim claim_url code id_token key_pair_id magic_link nonce oauth_code policy reset_code session shiplet_code shiplet_embed_code sig signed state apikey".split(" "));
function clean(url, depth) {
url.username = ""; url.password = "";
const fragment = url.hash; url.hash = "";
if (fragment.startsWith("#/") && !fragment.startsWith("#//") && depth < 8) { const route = new URL(fragment.slice(1), url.origin); if (route.origin === url.origin) { const sanitized = clean(route, depth + 1); url.hash = "#" + sanitized.pathname + sanitized.search; } }
const entries = Array.from(url.searchParams); url.search = "";
for (const [key, value] of entries) {
const normalized = key.trim().toLowerCase().replace(/-/g, "_");
if (sensitive.test(normalized) || names.has(normalized) || normalized.startsWith("x_amz_") || normalized.replace(/[^a-z]/g, "") === "apikey") continue;
let nested; try { nested = new URL(value); } catch {}
if (nested && /^https?:$/.test(nested.protocol)) { if (depth >= 8 || nested.username || nested.password) continue; url.searchParams.append(key, clean(nested, depth + 1).toString()); } else url.searchParams.append(key, value);
}
return url;
}
return clean(new URL(win.location.href), 0).toString().slice(0, 4096);
} catch { return ""; }
}
function readViewport() {
return {
width: Math.max(1, Math.min(1e5, Number(innerWidth) || 1)),
height: Math.max(1, Math.min(1e5, Number(innerHeight) || 1)),
documentWidth: Math.max(1, Math.min(1e5, Number(doc.documentElement.scrollWidth) || 1)),
documentHeight: Math.max(1, Math.min(1e5, Number(doc.documentElement.scrollHeight) || 1)),
scrollX: clamp(win.scrollX, -1e7, 1e7),
scrollY: clamp(win.scrollY, -1e7, 1e7),
};
}
function captureView(state, ratio = devicePixelRatio) {
return { width: state.width, height: state.height, devicePixelRatio: Math.max(.1, Math.min(10, ratio || 1)) };
}
function captureBounds(state) {
return { documentWidth: state.documentWidth, documentHeight: state.documentHeight, scrollX: state.scrollX, scrollY: state.scrollY };
}
function captureResult(image, mode, state, extra, ratio) {
return Object.assign({ screenshotDataUrl: image.dataUrl, screenshotFailureNote: image.failure, screenshotMode: mode, viewport: captureView(state, ratio), captureContext: captureBounds(state) }, extra);
}
function fidelityFor(kind, limitations) { return { version: 1, kind, limitations }; }
function nextFrame(callback) {
if (callable(win.requestAnimationFrame)) win.requestAnimationFrame(callback); else callback();
}
function reducedMotion() {
return callable(win.matchMedia) && win.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function postViewport() {
postBridge("shiplet.artifact.viewport.v1", "change", { viewport: readViewport() });
}
function postPointer(payload) {
postBridge("shiplet.artifact.pointer.v1", payload.type, payload);
}
function flushPointer() {
pointerTimer = 0;
if (!pointer) return;
const pending = pointer;
pointer = null;
pointerAt = Date.now();
postPointer({ type: "move", pointer: pending });
}
function onPointerMove(event) {
if (!port || !event || typeof event.clientX !== "number" || typeof event.clientY !== "number") return;
const viewportX = clamp(event.clientX, -1e5, 1e5);
const viewportY = clamp(event.clientY, -1e5, 1e5);
pointer = pointAt(viewportX, viewportY);
const elapsed = Date.now() - pointerAt;
if (elapsed >= 40) { flushPointer(); return; }
if (!pointerTimer && callable(setTimeout)) pointerTimer = setTimeout(flushPointer, 40 - elapsed);
}
function onPointerLeave(event) {
if (event && event.relatedTarget) return;
pointer = null;
if (pointerTimer && callable(clearTimeout)) clearTimeout(pointerTimer);
pointerTimer = 0;
postPointer({ type: "leave" });
}
function interruptFollow() {
if (!following) return;
following = false;
postBridge("shiplet.artifact.follow.v1", "interrupt");
}
function clearLease() {
if (leaseTimer && callable(win.clearTimeout)) win.clearTimeout(leaseTimer);
leaseTimer = 0;
leaseExpiry = 0;
leaseSeq = 0;
}
function checkLease() {
leaseTimer = 0;
if (!leaseExpiry) return;
const remaining = leaseExpiry - Date.now();
if (remaining <= 0) { resetSession(true); return; }
if (callable(win.setTimeout)) leaseTimer = win.setTimeout(checkLease, remaining);
}
function refreshLease() {
if (!port) return;
if (leaseTimer && callable(win.clearTimeout)) win.clearTimeout(leaseTimer);
leaseExpiry = Date.now() + 3000;
leaseTimer = 0;
if (callable(win.setTimeout)) leaseTimer = win.setTimeout(checkLease, 3000);
}
function liveChannel() {
if (!port) return false;
if (leaseExpiry && Date.now() >= leaseExpiry) { resetSession(true); return false; }
return true;
}
function parseTarget(value) {
if (!isRecord(value)) return null;
const keys = ["feedbackId", "selector"];
if (Object.keys(value).includes("expectedTag")) keys.push("expectedTag");
if (Object.keys(value).includes("relativePoint")) keys.push("relativePoint");
if (!exactKeys(value, keys) || !isIdentifier(value.feedbackId) || typeof value.selector !== "string" || !value.selector || value.selector.length > 1200) return null;
if (value.expectedTag !== undefined && (typeof value.expectedTag !== "string" || !/^[A-Z][A-Z0-9-]{0,63}$/.test(value.expectedTag))) return null;
let relativeX = .5; let relativeY = .5;
if (value.relativePoint !== undefined) {
if (!isRecord(value.relativePoint) || !exactKeys(value.relativePoint, ["x", "y"]) || !inRange(value.relativePoint.x, 0, 1) || !inRange(value.relativePoint.y, 0, 1)) return null;
relativeX = value.relativePoint.x; relativeY = value.relativePoint.y;
}
return { feedbackId: value.feedbackId, selector: value.selector, expectedTag: value.expectedTag || "", relativeX, relativeY };
}
function resolveTarget(descriptor) {
const unavailable = { feedbackId: descriptor.feedbackId, eligible: false, offscreen: false, coordinates: null, targetRect: null };
const reject = () => ({ target: null, geometry: unavailable });
let target;
try { target = doc.querySelector(descriptor.selector); } catch { return reject(); }
if (!(target instanceof Element) || !target.isConnected || (descriptor.expectedTag && target.tagName !== descriptor.expectedTag)) return reject();
try {
if (target.closest(privateSelector + ",[data-shiplet-review-ui]," + highlightSelector)) return reject();
let node = target;
while (node instanceof Element) {
const style = win.getComputedStyle(node);
if (style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || Number(style.opacity) === 0 || style.contentVisibility === "hidden") return reject();
node = node.parentElement;
}
if (callable(target.getClientRects) && target.getClientRects().length === 0) return reject();
const rect = target.getBoundingClientRect();
if (["left", "top", "right", "bottom"].some(key => !inRange(rect[key], -1e7, 1e7)) || !inRange(rect.width, 0, 1e5) || !inRange(rect.height, 0, 1e5) || rect.width <= 0 || rect.height <= 0) return reject();
const viewportX = clamp(rect.left + rect.width * descriptor.relativeX, -1e5, 1e5);
const viewportY = clamp(rect.top + rect.height * descriptor.relativeY, -1e5, 1e5);
const offscreen = rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth;
return {
target,
geometry: {
feedbackId: descriptor.feedbackId,
eligible: true,
offscreen,
coordinates: pointAt(viewportX, viewportY),
targetRect: rectState(rect),
},
};
} catch { return reject(); }
}
function syncTargetSizes(elements) {
if (typeof ResizeObserver !== "function") return;
let changed = elements.size !== observed.size;
if (!changed) for (const element of elements) if (!observed.has(element)) { changed = true; break; }
if (!changed) return;
if (!resizeWatch) resizeWatch = new ResizeObserver(queueTargets);
resizeWatch.disconnect();
observed = elements;
if (!savedTargets.size) return;
try { resizeWatch.observe(doc.documentElement); } catch {}
for (const element of elements) try { resizeWatch.observe(element); } catch {}
}
function postSaved(force) {
if (!liveChannel() || !callable(port.postMessage)) return;
if (!savedTargets.size && !force) return;
const targets = [];
const elements = new Set();
for (const descriptor of savedTargets.values()) {
const resolved = resolveTarget(descriptor);
targets.push(resolved.geometry);
if (resolved.target) elements.add(resolved.target);
}
syncTargetSizes(elements);
const serialized = JSON.stringify(targets);
if (!force && serialized === lastTargets) return;
lastTargets = serialized;
postBridge("shiplet.artifact.saved-targets.geometry.v1", "update", { targets });
}
function queueTargets() {
if (!savedTargets.size || targetsPending || !liveChannel()) return;
targetsPending = true;
const flush = () => { targetsPending = false; postSaved(false); };
nextFrame(flush);
}
function overlayMutation(mutation) {
const nodes = Array.from(mutation.addedNodes || []).concat(Array.from(mutation.removedNodes || []));
if (nodes.length) return nodes.every((node) => node instanceof Element && (node.matches(highlightSelector) || node.closest(highlightSelector)));
return mutation.target instanceof Element && Boolean(mutation.target.closest(highlightSelector));
}
function observeTargets() {
if (!savedTargets.size) return;
if (!mutationWatch && typeof MutationObserver === "function") { mutationWatch = new MutationObserver((mutations) => { if (!mutations.every(overlayMutation)) queueTargets(); }); mutationWatch.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); }
if (!layoutWatch && typeof PerformanceObserver === "function") try { layoutWatch = new PerformanceObserver(queueTargets); layoutWatch.observe({ type: "layout-shift" }); } catch {}
}
function clearTargets() {
savedTargets = new Map();
lastTargets = "";
targetsPending = false;
for (const observer of [mutationWatch, resizeWatch, layoutWatch]) if (observer) observer.disconnect();
mutationWatch = resizeWatch = layoutWatch = null;
observed = new Set();
}
function registerTargets(data) {
if (!messageKeys(data, ["targets"]) || data.type !== "replace" || !Array.isArray(data.targets) || data.targets.length > 250) return false;
const next = new Map();
for (const value of data.targets) {
const descriptor = parseTarget(value);
if (!descriptor || next.has(descriptor.feedbackId)) return false;
try { doc.querySelector(descriptor.selector); } catch { return false; }
next.set(descriptor.feedbackId, descriptor);
}
clearTargets();
savedTargets = next;
observeTargets();
postSaved(true);
return true;
}
function revealTarget(data) {
if (!messageKeys(data, ["feedbackId"]) || data.type !== "reveal" || !isIdentifier(data.feedbackId)) return false;
const descriptor = savedTargets.get(data.feedbackId);
if (!descriptor) return false;
const resolved = resolveTarget(descriptor);
if (!resolved.target || !resolved.geometry.eligible || !callable(resolved.target.scrollIntoView)) return true;
interruptFollow();
const reduced = reducedMotion();
try { resolved.target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center", inline: "center" }); } catch { resolved.target.scrollIntoView(); }
queueTargets();
if (callable(win.setTimeout)) win.setTimeout(queueTargets, 100);
return true;
}
function setShortcuts(data) {
if (!messageKeys(data) || (data.type !== "enable" && data.type !== "disable")) return false;
shortcuts = data.type === "enable";
return true;
}
function editableTarget(target) {
if (!(target instanceof Element)) return false;
try { return Boolean(target.isContentEditable || target.closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])")); } catch { return true; }
}
function shortcutFocus(event) {
let path;
try { path = callable(event.composedPath) ? event.composedPath() : [event.target]; } catch { return false; }
for (const item of path) if (editableTarget(item)) return false;
let active = doc.activeElement;
for (let depth = 0; depth < 8 && active instanceof Element; depth += 1) {
if (editableTarget(active)) return false;
let nested = null; try { nested = active.shadowRoot && active.shadowRoot.activeElement; } catch { return false; }
if (!(nested instanceof Element)) break;
active = nested;
}
const primary = path.find(item => item instanceof Element);
if (!primary) return !doc.activeElement || doc.activeElement === doc.body || doc.activeElement === doc.documentElement;
return ["BODY", "HTML", "BUTTON", "A", "SUMMARY"].includes(primary.tagName);
}
function onShortcutKeydown(event) {
if (!shortcuts || !liveChannel() || !event || event.isTrusted !== true || composing || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || !shortcutFocus(event)) return;
let action = "";
if (!event.shiftKey && (event.key === "c" || event.key === "C")) action = "comment";
else if (!event.shiftKey && event.key === "Escape") action = "cancel";
if (!action) return;
postBridge("shiplet.artifact.shortcuts.v1", "action", { action });
}
function onCompositionStart() { composing = true; }
function onCompositionEnd() { composing = false; }
function handleLease(data) {
if (data.type === "disconnect" && messageKeys(data)) { resetSession(true); return; }
if (data.type !== "renew" || !messageKeys(data, ["sequence"]) || !Number.isInteger(data.sequence) || data.sequence < 1 || data.sequence > 2147483647 || data.sequence <= leaseSeq) return;
leaseSeq = data.sequence;
refreshLease();
postBridge("shiplet.artifact.lifecycle.v1", "alive", { sequence: data.sequence });
}
function onFollowKeydown(event) {
if (!following || !event || typeof event.key !== "string") return;
if (/^(?:Arrow(?:Up|Down|Left|Right)|Page(?:Up|Down)|Home|End|Escape|\x20)$/.test(event.key)) interruptFollow();
}
function setFollow(data) {
if (data.type === "stop" && messageKeys(data)) { following = false; return; }
if (data.type !== "scroll" || !messageKeys(data, ["scrollX", "scrollY"])) return;
if (!inRange(data.scrollX, -1e7, 1e7) || !inRange(data.scrollY, -1e7, 1e7)) return;
following = true;
if (!callable(win.scrollTo)) return;
const reduced = reducedMotion();
try { win.scrollTo({ left: data.scrollX, top: data.scrollY, behavior: reduced ? "auto" : "smooth" }); } catch { win.scrollTo(data.scrollX, data.scrollY); }
}
function stopRoute() {
if (routeTimer && callable(win.clearInterval)) win.clearInterval(routeTimer);
routeTimer = 0;
routePending = false;
lastRoute = "";
}
function checkRoute() {
routePending = false;
if (!liveChannel()) return;
const nextRouteUrl = routeUrl();
if (!nextRouteUrl || nextRouteUrl === lastRoute) return;
lastRoute = nextRouteUrl;
cancelCapture();
clearAnchor("");
clearTargets();
postBridge("shiplet.artifact.route.v1", "change", { pageUrl: nextRouteUrl });
}
function queueRoute() {
if (!port || routePending) return;
routePending = true;
nextFrame(checkRoute);
}
function trackRoute() {
stopRoute();
lastRoute = routeUrl();
if (callable(win.setInterval)) routeTimer = win.setInterval(queueRoute, 100);
}
function resetSession(closePort) {
const previousPort = port;
port = null;
clearLease();
cancelCapture();
pageId = "";
clearAnchor("");
clearTargets();
stopRoute();
shortcuts = false;
composing = false;
following = false;
pointer = null;
if (pointerTimer && callable(clearTimeout)) clearTimeout(pointerTimer);
pointerTimer = 0;
if (closePort && previousPort) try { previousPort.close(); } catch {}
}
function postAnchor() {
if (!liveChannel() || !callable(port.postMessage) || !anchorId || !(anchorTarget instanceof Element) || !anchorTarget.isConnected) return;
const rect = anchorTarget.getBoundingClientRect();
const viewportX = clamp(rect.left + offsetX, -1e5, 1e5);
const viewportY = clamp(rect.top + offsetY, -1e5, 1e5);
postBridge("shiplet.artifact.anchor.v1", "position", {
requestId: anchorId,
coordinates: pointAt(viewportX, viewportY),
targetRect: rectState(rect),
});
}
function postState() {
postViewport();
postAnchor();
postSaved(false);
}
function queuePosition() {
if (framePending) return;
framePending = true;
const flush = () => {
framePending = false;
postState();
};
nextFrame(flush);
}
function clearAnchor(requestId) {
if (requestId && requestId !== anchorId) return;
anchorTarget = null;
anchorId = "";
offsetX = offsetY = 0;
}
function clearHighlight() {
if (highlight) highlight.remove();
highlight = null;
}
function showHighlight(target) {
if (!(target instanceof Element) || target === highlight) return;
if (!highlight) {
highlight = doc.createElement("div");
highlight.setAttribute("data-shiplet-artifact-capture-highlight", "v1");
highlight.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #2f6e88;background:rgba(47,110,136,.12);box-sizing:border-box";
doc.documentElement.appendChild(highlight);
}
const rect = target.getBoundingClientRect();
highlight.style.left = Math.max(0, rect.left) + "px";
highlight.style.top = Math.max(0, rect.top) + "px";
highlight.style.width = Math.max(0, rect.width) + "px";
highlight.style.height = Math.max(0, rect.height) + "px";
}
function selectorFor(target) {
if (target.id && /^[A-Za-z][A-Za-z0-9_:.\-]{0,200}$/.test(target.id)) return "#" + target.id.replace(/([:.])/g, "\\$1");
const parts = [];
let node = target;
while (node && node.nodeType === 1 && parts.length < 6) {
let part = node.tagName.toLowerCase();
const classes = Array.from(node.classList || []).filter((value) => /^[A-Za-z][A-Za-z0-9_-]{0,80}$/.test(value)).slice(0, 2);
if (classes.length) part += "." + classes.join(".");
if (node.parentElement) {
const siblings = Array.from(node.parentElement.children).filter((item) => item.tagName === node.tagName);
if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
}
parts.unshift(part);
node = node.parentElement;
}
return parts.join(" > ").slice(0, 1200) || target.tagName.toLowerCase();
}
function safeClone() {
const clone = doc.documentElement.cloneNode(true);
clone.querySelectorAll("script,noscript,iframe,frame,object,embed,video,audio,canvas,img,picture,source,link,meta,input,textarea,select,shiplet-feedback,[data-shiplet-private]," + highlightSelector).forEach(node => node.remove());
let visited = 0;
for (const node of clone.querySelectorAll("*")) {
if (++visited > 10000) { node.remove(); continue; }
for (const attribute of Array.from(node.attributes)) {
const name = attribute.name.toLowerCase();
if (name.startsWith("on") || ["src", "srcset", "href", "action", "formaction"].includes(name)) node.removeAttribute(attribute.name);
if (name === "style" && /url\s*\(/i.test(attribute.value)) node.setAttribute("style", attribute.value.replace(/url\s*\([^)]*\)/gi, "none"));
}
}
return clone;
}
function canvas2d(width, height, color) {
const canvas = doc.createElement("canvas"); canvas.width = width; canvas.height = height;
const context = canvas.getContext("2d");
if (context && color) { context.fillStyle = color; context.fillRect(0, 0, width, height); }
return [canvas, context];
}
function canvasUrl(canvas) {
const dataUrl = canvas.toDataURL("image/png");
if (dataUrl.length > 13.4e6) throw new Error("Artifact screenshot exceeded the bounded capture size.");
return dataUrl;
}
async function domScreenshot(target, state) {
const width = Math.max(1, Math.min(1920, Math.round(state.width)));
const height = Math.max(1, Math.min(1080, Math.round(state.height)));
if (target.tagName === "IMG" && target.hasAttribute("data-shiplet-raster-capture") && !target.closest("[data-shiplet-private]") && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(target.src) && target.src.length <= 8388630) {
const rect = target.getBoundingClientRect();
await target.decode();
const [canvas, context] = canvas2d(width, height, "#eef0f2");
if (!context) throw new Error("Canvas capture is unavailable.");
context.drawImage(target, rect.left, rect.top, rect.width, rect.height);
return canvasUrl(canvas);
}
const serialized = new XMLSerializer().serializeToString(safeClone());
if (new TextEncoder().encode(serialized).byteLength > 1e6) throw new Error("Artifact DOM exceeded the bounded capture size.");
const viewportClone = '<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:' + width + 'px;min-height:' + state.documentHeight + 'px;transform:translate(' + (-state.scrollX) + 'px,' + (-state.scrollY) + 'px);transform-origin:0 0">' + serialized + "</div>";
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><foreignObject width="100%" height="100%">' + viewportClone + "</foreignObject></svg>";
const image = new Image();
const loaded = new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error("Artifact DOM capture could not render.")); });
image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
await loaded;
const [canvas, context] = canvas2d(width, height, "#ffffff");
if (!context) throw new Error("Canvas capture is unavailable.");
context.drawImage(image, 0, 0, width, height);
return canvasUrl(canvas);
}
function fallbackImage(target) {
const width = Math.max(1, Math.min(1920, Math.round(innerWidth || 1)));
const height = Math.max(1, Math.min(1080, Math.round(innerHeight || 1)));
const [canvas, context] = canvas2d(width, height, "#ffffff");
if (!context) return null;
context.fillStyle = "#20293a";
context.font = "16px system-ui, sans-serif";
let drawn = 0;
for (const node of doc.querySelectorAll("h1,h2,h3,p,li,button,a,label")) {
if (drawn >= 80) break;
const rect = node.getBoundingClientRect();
const text = publicText(node, 180);
if (!text || rect.bottom < 0 || rect.top > height || rect.right < 0 || rect.left > width) continue;
context.fillText(text, Math.max(4, rect.left), Math.max(18, rect.top + 18), Math.max(40, width - Math.max(4, rect.left) - 4));
drawn += 1;
}
const rect = target.getBoundingClientRect();
context.strokeStyle = "#2f6e88";
context.lineWidth = 3;
context.strokeRect(rect.left, rect.top, Math.max(1, rect.width), Math.max(1, rect.height));
return canvas.toDataURL("image/png");
}
async function captureImage(target, state, failureText) {
try { return { dataUrl: await domScreenshot(target, state), failure: null, fallback: false }; }
catch (error) {
return { dataUrl: fallbackImage(target), failure: safeText(error && error.message ? error.message : failureText, 500), fallback: true };
}
}
async function captureTarget(target, event) {
const state = readViewport();
const pixelRatio = Math.max(.1, Math.min(10, devicePixelRatio || 1));
clearHighlight();
const image = await captureImage(target, state, "Artifact screenshot capture failed.");
return captureResult(image, "element", state, {
coordinates: { pageX: event.pageX, pageY: event.pageY, viewportX: event.clientX, viewportY: event.clientY },
selectedElement: { selector: selectorFor(target), tagName: target.tagName.slice(0, 64), text: publicText(target, 500) },
}, pixelRatio);
}
async function capturePage(requestId, pageUrl) {
pageId = requestId;
const capturePort = port;
const captureNonce = nonce;
const routeAtStart = routeUrl();
if (!routeAtStart || routeAtStart !== pageUrl) return;
const state = readViewport();
const rasterSource = doc.querySelector("img[data-shiplet-raster-capture]");
const rasterRect = rasterSource instanceof Element ? rasterSource.getBoundingClientRect() : null;
const exactRaster = rasterRect && rasterRect.left <= 0 && rasterRect.top <= 0 && rasterRect.right >= state.width && rasterRect.bottom >= state.height;
const image = await captureImage(exactRaster ? rasterSource : doc.documentElement, state, "Visible page capture failed.");
const fidelity = image.fallback
? fidelityFor(image.dataUrl ? "fallback" : "none", image.dataUrl ? captureLimits : [])
: fidelityFor(exactRaster ? "raster-source" : "sanitized-dom", exactRaster ? [] : captureLimits);
if (!liveChannel() || port !== capturePort || nonce !== captureNonce || pageId !== requestId || routeUrl() !== routeAtStart) return;
pageId = "";
capturePort.postMessage(envelope("shiplet.artifact.page-capture.result.v1", "result", {
requestId,
pageUrl: routeAtStart,
status: "captured",
payload: captureResult(image, "page", state, { fidelity }),
}));
}
function cancelCapture() {
captureId = "";
clearHighlight();
doc.removeEventListener("pointerover", onPointerOver, true);
doc.removeEventListener("click", onCaptureClick, true);
}
function onPointerOver(event) { if (captureId && liveChannel() && event.target instanceof Element && !event.target.closest("shiplet-feedback,[data-shiplet-private]")) showHighlight(event.target); }
async function onCaptureClick(event) {
if (!captureId || !liveChannel() || event.isTrusted !== true || !(event.target instanceof Element)) return;
if (event.target.closest(privateSelector)) return;
event.preventDefault();
event.stopImmediatePropagation();
const requestId = captureId;
const target = event.target;
const targetRect = target.getBoundingClientRect();
anchorTarget = target;
anchorId = requestId;
offsetX = event.clientX - targetRect.left;
offsetY = event.clientY - targetRect.top;
cancelCapture();
const capturePort = port;
const captureNonce = nonce;
const payload = await captureTarget(target, event);
if (!liveChannel() || port !== capturePort || nonce !== captureNonce || anchorId !== requestId) return;
postBridge("shiplet.artifact.capture.result.v1", "result", { requestId, status: "captured", payload });
postState();
}
function onPortMessage(event) {
if (!liveChannel()) return;
const data = event.data;
if (!isRecord(data) || data.channelNonce !== nonce || data.shipletId !== shipletId || data.revisionId !== revisionId) return;
if (data.protocol === "shiplet.artifact.follow.command.v1") { setFollow(data); return; }
if (data.protocol === "shiplet.artifact.saved-targets.command.v1") { if (registerTargets(data)) refreshLease(); return; }
if (data.protocol === "shiplet.artifact.saved-target.reveal.v1") { if (revealTarget(data)) refreshLease(); return; }
if (data.protocol === "shiplet.artifact.shortcuts.command.v1") { if (setShortcuts(data) && (shortcuts || leaseExpiry)) refreshLease(); return; }
if (data.protocol === "shiplet.artifact.lifecycle.command.v1") { handleLease(data); return; }
if (data.protocol === "shiplet.artifact.page-capture.command.v1") {
if (!messageKeys(data, ["requestId", "pageUrl"]) || !["capture", "cancel"].includes(data.type) || !isIdentifier(data.requestId) || typeof data.pageUrl !== "string" || data.pageUrl.length > 4096) return;
if (data.type === "cancel") { if (pageId === data.requestId) pageId = ""; return; }
void capturePage(data.requestId, data.pageUrl);
return;
}
if (!messageKeys(data, ["requestId"])) return;
if (data.protocol !== "shiplet.artifact.capture.command.v1" || !isIdentifier(data.requestId)) return;
if (data.type === "cancel") { if (data.requestId === captureId) cancelCapture(); return; }
if (data.type === "release") { clearAnchor(data.requestId); return; }
if (data.type !== "start" || captureId) return;
clearAnchor("");
captureId = data.requestId;
doc.addEventListener("pointerover", onPointerOver, true);
doc.addEventListener("click", onCaptureClick, true);
postBridge("shiplet.artifact.capture.state.v1", "ready", { requestId: data.requestId });
}
function onChannel(event) {
if (event.source !== parent || event.origin === "null" || !isRecord(event.data)) return;
${embedded ? "if (event.origin !== expectedOrigin) return;" : ""}
const data = event.data;
if (messageKeys(data) && data.protocol === "shiplet.artifact.channel.v1" && data.type === "offer" && isIdentifier(data.channelNonce) && isIdentifier(data.shipletId) && isIdentifier(data.revisionId)) {
if (origin && event.origin !== origin) return;
if (!origin) origin = event.origin;
resetSession(true);
nonce = data.channelNonce;
shipletId = data.shipletId;
revisionId = data.revisionId;
parent.postMessage({ protocol: "shiplet.artifact.channel.v1", type: "ready", channelNonce: nonce, shipletId, revisionId }, origin);
return;
}
if (event.origin !== origin || !messageKeys(data) || data.protocol !== "shiplet.artifact.channel.v1" || data.type !== "connect" || data.channelNonce !== nonce || data.shipletId !== shipletId || data.revisionId !== revisionId || event.ports.length !== 1 || port) return;
const nextPort = event.ports[0];
const nextNonce = nonce;
port = nextPort;
nextPort.addEventListener("message", (portEvent) => {
if (port !== nextPort || nonce !== nextNonce) return;
onPortMessage(portEvent);
});
const disconnect = () => { if (port === nextPort) resetSession(false); };
try { nextPort.addEventListener("messageerror", disconnect); nextPort.addEventListener("close", disconnect); } catch {}
nextPort.start();
trackRoute();
postState();
}
const artifactFonts = doc.fonts;
const listeners = [
[win, "message", onChannel],
[win, "scroll", queuePosition, true],
[win, "resize", queuePosition],
[doc, "scroll", queuePosition, true],
[doc, "pointermove", onPointerMove, true],
[doc, "pointerout", onPointerLeave, true],
[doc, "wheel touchmove pointerdown", interruptFollow, true],
[doc, "keydown", onFollowKeydown, true],
[doc, "keydown", onShortcutKeydown, true],
[doc, "compositionstart", onCompositionStart, true],
[doc, "compositionend", onCompositionEnd, true],
[doc, "visibilitychange load transitionend animationend", queueTargets, true],
[win, "popstate hashchange", queueRoute],
];
function setListeners(method) {
for (const [target, types, listener, capture] of listeners) for (const type of types.split(" ")) target[method](type, listener, capture);
if (artifactFonts && callable(artifactFonts[method])) artifactFonts[method]("loadingdone", queueTargets);
}
setListeners("addEventListener");
${
  embedded
    ? `return () => {
  resetSession(true);
  setListeners("removeEventListener");
}; }`
    : "})();"
}`;
  return script.trim();
}
