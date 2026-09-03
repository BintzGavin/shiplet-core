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
  if (headEnd >= 0) return `${html.slice(0, headEnd)}${tag}${html.slice(headEnd)}`;
  const bodyStart = html.search(/<body(?:\s[^>]*)?>/i);
  if (bodyStart >= 0) return `${html.slice(0, bodyStart)}${tag}${html.slice(bodyStart)}`;
  return `${tag}${html}`;
}

export function trustedArtifactBridgeScript() {
  return String.raw`(() => {
	"use strict";
	if (window === parent || typeof MessageChannel !== "function") return;
	let hostOrigin = "";
	let channelNonce = "";
	let shipletId = "";
	let revisionId = "";
	let port = null;
	let activeRequestId = "";
	let highlight = null;
	let selectedTarget = null;
	let selectedRequestId = "";
	let selectedOffsetX = 0;
	let selectedOffsetY = 0;
	let positionUpdatePending = false;

	function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
	function exactKeys(value, keys) { const actual = Object.keys(value); return actual.length === keys.length && actual.every((key) => keys.includes(key)); }
	function isIdentifier(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value); }
	function boundedNumber(value, minimum, maximum) { return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum; }
	function safeText(value, maximum) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum); }
	function boundedCoordinate(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, Number(value) || 0)); }

	function viewportState() {
		return {
			width: Math.max(1, Math.min(100000, Number(innerWidth) || 1)),
			height: Math.max(1, Math.min(100000, Number(innerHeight) || 1)),
			documentWidth: Math.max(1, Math.min(100000, Number(document.documentElement.scrollWidth) || 1)),
			documentHeight: Math.max(1, Math.min(100000, Number(document.documentElement.scrollHeight) || 1)),
			scrollX: boundedCoordinate(window.scrollX, -10000000, 10000000),
			scrollY: boundedCoordinate(window.scrollY, -10000000, 10000000),
		};
	}

	function postViewportState() {
		if (!port || typeof port.postMessage !== "function") return;
		port.postMessage({ protocol: "shiplet.artifact.viewport.v1", type: "change", channelNonce, shipletId, revisionId, viewport: viewportState() });
	}

	function postSelectedAnchor() {
		if (!port || typeof port.postMessage !== "function" || !selectedRequestId || !(selectedTarget instanceof Element) || !selectedTarget.isConnected) return;
		const rect = selectedTarget.getBoundingClientRect();
		const viewportX = boundedCoordinate(rect.left + selectedOffsetX, -100000, 100000);
		const viewportY = boundedCoordinate(rect.top + selectedOffsetY, -100000, 100000);
		port.postMessage({
			protocol: "shiplet.artifact.anchor.v1",
			type: "position",
			channelNonce,
			shipletId,
			revisionId,
			requestId: selectedRequestId,
			coordinates: {
				pageX: boundedCoordinate(viewportX + window.scrollX, -10000000, 10000000),
				pageY: boundedCoordinate(viewportY + window.scrollY, -10000000, 10000000),
				viewportX,
				viewportY,
			},
			targetRect: {
				left: boundedCoordinate(rect.left, -100000, 100000),
				top: boundedCoordinate(rect.top, -100000, 100000),
				width: boundedCoordinate(rect.width, 0, 100000),
				height: boundedCoordinate(rect.height, 0, 100000),
			},
		});
	}

	function postArtifactPosition() {
		postViewportState();
		postSelectedAnchor();
	}

	function scheduleArtifactPosition() {
		if (positionUpdatePending) return;
		positionUpdatePending = true;
		const flush = () => {
			positionUpdatePending = false;
			postArtifactPosition();
		};
		if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(flush);
		else flush();
	}

	function releaseSelectedTarget(requestId) {
		if (requestId && requestId !== selectedRequestId) return;
		selectedTarget = null;
		selectedRequestId = "";
		selectedOffsetX = 0;
		selectedOffsetY = 0;
	}

	function removeHighlight() {
		if (highlight) highlight.remove();
		highlight = null;
	}

	function showHighlight(target) {
		if (!(target instanceof Element) || target === highlight) return;
		if (!highlight) {
			highlight = document.createElement("div");
			highlight.setAttribute("data-shiplet-artifact-capture-highlight", "v1");
			highlight.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #2f6e88;background:rgba(47,110,136,.12);box-sizing:border-box";
			document.documentElement.appendChild(highlight);
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

	function sanitizedClone() {
		const clone = document.documentElement.cloneNode(true);
		clone.querySelectorAll("script,noscript,iframe,frame,object,embed,video,audio,canvas,img,picture,source,link,meta,[data-shiplet-artifact-capture-highlight]").forEach((node) => node.remove());
		let visited = 0;
		for (const node of clone.querySelectorAll("*")) {
			visited += 1;
			if (visited > 10000) { node.remove(); continue; }
			for (const attribute of Array.from(node.attributes)) {
				const name = attribute.name.toLowerCase();
				if (name.startsWith("on") || ["src", "srcset", "href", "action", "formaction"].includes(name)) node.removeAttribute(attribute.name);
				if (name === "style" && /url\s*\(/i.test(attribute.value)) node.setAttribute("style", attribute.value.replace(/url\s*\([^)]*\)/gi, "none"));
			}
		}
		return clone;
	}

	async function domScreenshot() {
		const width = Math.max(1, Math.min(1920, Math.round(innerWidth || 1)));
		const height = Math.max(1, Math.min(1080, Math.round(innerHeight || 1)));
		const serialized = new XMLSerializer().serializeToString(sanitizedClone());
		if (new TextEncoder().encode(serialized).byteLength > 1000000) throw new Error("Artifact DOM exceeded the bounded capture size.");
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">' + serialized + "</div></foreignObject></svg>";
		const image = new Image();
		const loaded = new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error("Artifact DOM capture could not render.")); });
		image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
		await loaded;
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas capture is unavailable.");
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, width, height);
		context.drawImage(image, 0, 0, width, height);
		const dataUrl = canvas.toDataURL("image/png");
		if (dataUrl.length > 13400000) throw new Error("Artifact screenshot exceeded the bounded capture size.");
		return dataUrl;
	}

	function syntheticScreenshot(target) {
		const width = Math.max(1, Math.min(1920, Math.round(innerWidth || 1)));
		const height = Math.max(1, Math.min(1080, Math.round(innerHeight || 1)));
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d");
		if (!context) return null;
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, width, height);
		context.fillStyle = "#20293a";
		context.font = "16px system-ui, sans-serif";
		let drawn = 0;
		for (const node of document.querySelectorAll("h1,h2,h3,p,li,button,a,label")) {
			if (drawn >= 80) break;
			const rect = node.getBoundingClientRect();
			const text = safeText(node.textContent, 180);
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

	async function captureTarget(target, event) {
		let screenshotDataUrl = null;
		let screenshotFailureNote = null;
		removeHighlight();
		try { screenshotDataUrl = await domScreenshot(); }
		catch (error) {
			screenshotFailureNote = safeText(error && error.message ? error.message : "Artifact screenshot capture failed.", 500);
			screenshotDataUrl = syntheticScreenshot(target);
		}
		return {
			screenshotDataUrl,
			screenshotFailureNote,
			screenshotMode: "element",
			viewport: { width: Math.max(1, innerWidth), height: Math.max(1, innerHeight), devicePixelRatio: Math.max(.1, Math.min(10, devicePixelRatio || 1)) },
			coordinates: { pageX: event.pageX, pageY: event.pageY, viewportX: event.clientX, viewportY: event.clientY },
			selectedElement: { selector: selectorFor(target), tagName: target.tagName.slice(0, 64), text: safeText(target.textContent, 500) },
			captureContext: { documentWidth: Math.max(1, document.documentElement.scrollWidth), documentHeight: Math.max(1, document.documentElement.scrollHeight), scrollX: window.scrollX, scrollY: window.scrollY },
		};
	}

	function cancelCapture() {
		activeRequestId = "";
		removeHighlight();
		document.removeEventListener("pointerover", onPointerOver, true);
		document.removeEventListener("click", onCaptureClick, true);
	}

	function onPointerOver(event) { if (activeRequestId && event.target instanceof Element) showHighlight(event.target); }
	async function onCaptureClick(event) {
		if (!activeRequestId || event.isTrusted !== true || !(event.target instanceof Element)) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		const requestId = activeRequestId;
		const target = event.target;
		const targetRect = target.getBoundingClientRect();
		selectedTarget = target;
		selectedRequestId = requestId;
		selectedOffsetX = event.clientX - targetRect.left;
		selectedOffsetY = event.clientY - targetRect.top;
		cancelCapture();
		const payload = await captureTarget(target, event);
		if (!port) return;
		port.postMessage({ protocol: "shiplet.artifact.capture.result.v1", type: "result", channelNonce, shipletId, revisionId, requestId, status: "captured", payload });
		postArtifactPosition();
	}

	function handlePortMessage(event) {
		const data = event.data;
		if (!isRecord(data) || !exactKeys(data, ["protocol", "type", "channelNonce", "shipletId", "revisionId", "requestId"])) return;
		if (data.protocol !== "shiplet.artifact.capture.command.v1" || data.channelNonce !== channelNonce || data.shipletId !== shipletId || data.revisionId !== revisionId || !isIdentifier(data.requestId)) return;
		if (data.type === "cancel") { if (data.requestId === activeRequestId) cancelCapture(); return; }
		if (data.type === "release") { releaseSelectedTarget(data.requestId); return; }
		if (data.type !== "start" || activeRequestId) return;
		releaseSelectedTarget("");
		activeRequestId = data.requestId;
		document.addEventListener("pointerover", onPointerOver, true);
		document.addEventListener("click", onCaptureClick, true);
	}

	window.addEventListener("message", (event) => {
		if (event.source !== parent || event.origin === "null" || !isRecord(event.data)) return;
		const data = event.data;
		if (exactKeys(data, ["protocol", "type", "channelNonce", "shipletId", "revisionId"]) && data.protocol === "shiplet.artifact.channel.v1" && data.type === "offer" && isIdentifier(data.channelNonce) && isIdentifier(data.shipletId) && isIdentifier(data.revisionId)) {
			if (hostOrigin && event.origin !== hostOrigin) return;
			if (!hostOrigin) hostOrigin = event.origin;
			cancelCapture();
			try { if (port && typeof port.close === "function") port.close(); } catch {}
			port = null;
			channelNonce = data.channelNonce;
			shipletId = data.shipletId;
			revisionId = data.revisionId;
			parent.postMessage({ protocol: "shiplet.artifact.channel.v1", type: "ready", channelNonce, shipletId, revisionId }, hostOrigin);
			return;
		}
		if (event.origin !== hostOrigin || !exactKeys(data, ["protocol", "type", "channelNonce", "shipletId", "revisionId"]) || data.protocol !== "shiplet.artifact.channel.v1" || data.type !== "connect" || data.channelNonce !== channelNonce || data.shipletId !== shipletId || data.revisionId !== revisionId || event.ports.length !== 1 || port) return;
		const connectedPort = event.ports[0];
		const connectedNonce = channelNonce;
		port = connectedPort;
		connectedPort.addEventListener("message", (portEvent) => {
			if (port !== connectedPort || channelNonce !== connectedNonce) return;
			handlePortMessage(portEvent);
		});
		connectedPort.start();
		postArtifactPosition();
	});
	window.addEventListener("scroll", scheduleArtifactPosition, true);
	window.addEventListener("resize", scheduleArtifactPosition);
	document.addEventListener("scroll", scheduleArtifactPosition, true);
})();`;
}
