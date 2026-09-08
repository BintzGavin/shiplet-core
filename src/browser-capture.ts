import type { OrganizationRecord } from "./store";

export const CAPTURE_BODY_LIMIT = 8_400_000;
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function captureSourceUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

/** Bound bytes and decoded dimensions before any artifact is persisted. */
export function capturePublishPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Response("Invalid capture", { status: 400 });
  const input = value as Record<string, unknown>;
  if (input.confirmed !== true) throw new Response("Review the image and confirm sharing first", { status: 400 });
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 120 || typeof input.organizationId !== "string") throw new Response("Choose a workspace and a name", { status: 400 });
  if (typeof input.image !== "string" || input.image.length > 8_388_630 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(input.image)) throw new Response("Use a PNG image up to 6 MB", { status: 400 });
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(input.image.slice(22)), char => char.charCodeAt(0)); }
  catch { throw new Response("Invalid PNG image", { status: 400 }); }
  const signature = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
  if (bytes.length < 45 || bytes.length > 6_291_456 || signature.some((byte, index) => bytes[index] !== byte)) throw new Response("Invalid PNG image", { status: 400 });
  const view = new DataView(bytes.buffer);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height || width > 16_384 || height > 16_384 || width * height > 20_000_000) throw new Response("Image exceeds 20 megapixels or 16,384 pixels per side", { status: 400 });
  // Reject truncated chunks, embedded trailing payloads, and animated PNGs.
  let offset = 8, imageData = false, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) break;
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    if (type === "acTL") throw new Response("Use a still image", { status: 400 });
    if (type === "IDAT") imageData = true;
    offset += length + 12;
    if (type === "IEND") { ended = length === 0 && offset === bytes.length; break; }
  }
  if (!imageData || !ended) throw new Response("Incomplete PNG image", { status: 400 });
  const sourceUrl = captureSourceUrl(input.sourceUrl);
  const capturedOn = new Date().toISOString();
  const metadata = { format: "shiplet.browser-capture.v1", sourceUrl, capturedOn, width, height, kind: "visual-snapshot", note: "A user-reviewed visual copy. Original page queries, fragments, cookies and DOM are not included." };
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(name)}</title><style>html,body{margin:0;background:#eef0f2;color:#20293a;font:14px system-ui}main{width:${width}px}img{display:block;width:${width}px;height:${height}px;max-width:none}footer{padding:16px;max-width:900px;overflow-wrap:anywhere}a{color:#245b72}</style></head><body><main><img id="browser-capture" data-shiplet-raster-capture src="${input.image}" width="${width}" height="${height}" alt="${escape(name)}"><footer><strong>${escape(name)}</strong> · Captured ${capturedOn}<p>This is a visual copy. Use Annotate to pin feedback to any point.</p>${sourceUrl ? `<a href="${escape(sourceUrl)}" target="_blank" rel="noopener noreferrer">Open original page</a> · ` : ""}<a href="capture.png">Download image</a> · <a href="capture.json">Capture details</a></footer></main></body></html>`;
  const base64 = (text: string) => {
    const bytes = new TextEncoder().encode(text); let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return btoa(binary);
  };
  return {
    name,
    organization_id: input.organizationId,
    subdomain: `capture-${crypto.randomUUID().slice(0, 18)}`,
    visibility: "organization",
    assets: [
      { path: "index.html", content: base64(html) },
      { path: "capture.png", content: input.image.slice(22) },
      { path: "capture.json", content: base64(JSON.stringify(metadata, null, 2)) },
    ],
  };
}

export function renderBrowserCapture(organizations: OrganizationRecord[], loginUrl: string, nonce: string) {
  return `<main class="dashboard-shell shiplet-dashboard-stage capture-page"><header><p class="success-card-label">Shiplet browser capture</p><h1>Capture browser work</h1><p>Turn what you see into a shared canvas for comments. Works with signed-in apps, documents, PDFs, and prototypes.</p></header><p><a href="/">Workspace</a> · <a href="/docs/browser-capture">Browser companion and help</a></p><section class="success-card shiplet-panel"><div class="capture-actions"><button class="btn btn-primary" id="capture-screen">Capture a tab or window</button><label class="btn btn-secondary">Upload an image<input id="capture-file" type="file" accept="image/png,image/jpeg,image/webp"></label></div><p>Choose what to capture, or upload/paste a screenshot. Only the visible image is shared; the original page stays private.</p><p id="capture-status" role="status" aria-live="polite">Nothing has been uploaded.</p><div id="capture-preview" hidden><h2>Review before sharing</h2><p>Drag over sensitive areas to redact them. Black rectangles are permanently included in the shared image.</p><div class="capture-canvas-wrap"><canvas id="capture-canvas" aria-label="Capture preview; drag to redact"></canvas></div><button class="btn btn-secondary" id="capture-reset" type="button">Reset redactions</button><details><summary>Redact using coordinates</summary><div class="capture-actions">${["X", "Y", "Width", "Height"].map(label => `<label>${label}<input type="number" min="0" value="0" id="redact-${label.toLowerCase()}"></label>`).join("")}<button id="capture-redact" class="btn btn-secondary" type="button">Apply redaction</button></div></details><form id="capture-form"><label>Name<input id="capture-name" required maxlength="120" value="Browser capture"></label><label>Original page URL (optional)<input id="capture-source" type="url" maxlength="2048" placeholder="https://example.com/page"></label><p>Query strings and fragments are removed. Remove the URL if the path is private.</p><label>Workspace<select id="capture-organization" aria-label="Workspace" required>${organizations.map(org => `<option value="${escape(org.id)}">${escape(org.name)}</option>`).join("")}</select></label><div id="capture-login"${organizations.length ? " hidden" : ""}><p><a class="btn btn-secondary" href="${escape(loginUrl)}" target="_blank" rel="noopener">Sign in to Shiplet</a> <button id="capture-refresh" class="btn btn-secondary" type="button">I’m signed in</button></p><p>Sign in or create a workspace, then return here. Your preview stays in this tab.</p></div><label><input id="capture-confirm" type="checkbox" required> I reviewed this image and want to share it with this workspace.</label><button id="capture-publish" class="btn btn-primary" type="submit">Create shared review</button></form></div></section><style nonce="${nonce}">.capture-page{max-width:1080px;margin:auto;padding:32px 20px}.capture-page h1{font-size:clamp(30px,5vw,48px)}.capture-actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.capture-actions input[type=file]{display:block;max-width:240px;font-size:12px;margin-top:8px}.capture-canvas-wrap{max-height:65vh;overflow:auto;border:1px solid #bbc3c9;margin:16px 0;background:#e9edf0}.capture-page canvas{display:block;max-width:100%;height:auto;cursor:crosshair;touch-action:none}.capture-page form{display:grid;gap:16px;max-width:620px;margin-top:24px}.capture-page p{margin:12px 0;line-height:1.55}.capture-page h2{margin:24px 0 12px}.capture-page label{display:block}.capture-actions label.btn{position:relative;min-height:44px;display:flex;align-items:center}.capture-actions label.btn:focus-within{outline:3px solid #2f6e88;outline-offset:3px}#capture-file{position:absolute;width:1px!important;height:1px;padding:0;overflow:hidden;clip-path:inset(50%)}.capture-page label input:not([type=checkbox]),.capture-page select{display:block;width:100%;margin-top:6px}.capture-page details{margin:16px 0}.capture-page details input{max-width:100px}.capture-page [hidden]{display:none!important}</style><script type="module" nonce="${nonce}" src="/capture/client.js"></script></main>`;
}
