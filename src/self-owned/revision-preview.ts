const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export type RevisionPreviewSelector = {
  shipletId: string;
  draftId: string;
  revisionId: string;
  draftVersion: number;
};

function identifier(value: string, label: string) {
  if (!IDENTIFIER.test(value)) throw new TypeError(`Invalid ${label}`);
  return value;
}

export function parseRevisionPreviewDraftVersion(value: string | null) {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function revisionPreviewPath(input: RevisionPreviewSelector) {
  const shipletId = identifier(input.shipletId, "Shiplet ID");
  const draftId = identifier(input.draftId, "draft ID");
  const revisionId = identifier(input.revisionId, "revision ID");
  if (!Number.isSafeInteger(input.draftVersion) || input.draftVersion < 1) {
    throw new TypeError("Invalid draft version");
  }
  return `/shiplets/${encodeURIComponent(shipletId)}/drafts/${encodeURIComponent(draftId)}/revisions/${encodeURIComponent(revisionId)}/versions/${input.draftVersion}/preview`;
}

export function revisionPreviewUrl(
  appUrl: string,
  input: RevisionPreviewSelector,
) {
  const url = new URL(revisionPreviewPath(input), appUrl);
  url.hash = "";
  return url.toString();
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function addTrustedRevisionPreviewContext(
  response: Response,
  input: RevisionPreviewSelector,
) {
  if (response.status !== 200 || response.body === null) return response;
  const ownershipUrl = `/shiplets/${encodeURIComponent(input.shipletId)}/ownership#ownership-revisions-title`;
  const context = `<aside data-shiplet-revision-preview-context="v1" aria-label="Revision preview context"><p><strong>Previewing validated revision <code>${escapeHtml(input.revisionId)}</code>.</strong> The active revision is still unchanged.</p><nav aria-label="Revision preview actions"><a href="${escapeHtml(ownershipUrl)}">Return to ownership</a><a href="${escapeHtml(ownershipUrl)}">Promote this validated draft</a></nav></aside>`;
  const html = (await response.text()).replace("<body>", `<body>${context}`);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("cache-control", "private, no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-shiplet-preview-revision", input.revisionId);
  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
