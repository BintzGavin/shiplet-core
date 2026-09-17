import { SHIPLET_FAVICON_SVG } from "./seo";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

// Compact trusted pages use the Harbor Office palette without external assets.
// Their styles travel with the document, including inside third-party frames.
const REVIEW_ACCESS_CSS = `
:root {
  color-scheme: light dark;
  --surface: oklch(99% 0.005 95);
  --text: oklch(23% 0.04 255);
  --text-soft: oklch(34% 0.035 255);
  --line: oklch(80% 0.02 250);
  --action: oklch(54% 0.165 35);
  --action-hover: oklch(48% 0.16 35);
  --action-contrast: white;
  --accent: oklch(40% 0.075 220);
}
@media (prefers-color-scheme: dark) {
  :root {
    --surface: oklch(25% 0.025 255);
    --text: oklch(94% 0.01 95);
    --text-soft: oklch(83% 0.015 95);
    --line: oklch(38% 0.025 255);
    --action: oklch(66% 0.16 40);
    --action-hover: oklch(72% 0.16 45);
    --action-contrast: oklch(18% 0.03 255);
    --accent: oklch(78% 0.07 215);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100svh;
  padding: 24px;
  display: grid;
  align-items: center;
  justify-items: center;
  background: var(--surface);
  color: var(--text);
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 16px;
  line-height: 1.55;
}
.access-page { width: 100%; max-width: 30rem; overflow-wrap: anywhere; }
.access-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 32px; font-size: 18px; font-weight: 750; }
.access-brand svg { width: 36px; height: 36px; flex: none; }
h1 { margin: 0 0 16px; font-size: 28px; line-height: 1.2; letter-spacing: -0.025em; text-wrap: balance; }
h2 { margin: 24px 0 12px; font-size: 18px; }
p { margin: 0 0 20px; color: var(--text-soft); }
strong { color: var(--text); }
.access-actions { display: grid; gap: 12px; margin: 24px 0 16px; }
button, .access-primary {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  min-height: 44px;
  padding: 12px 16px;
  border: 0;
  border-radius: 8px;
  background: var(--action);
  color: var(--action-contrast);
  font: inherit;
  font-weight: 650;
  line-height: 1.4;
  text-align: center;
  text-decoration: none;
  cursor: pointer;
}
button:hover, .access-primary:hover { background: var(--action-hover); color: var(--action-contrast); }
button:active, .access-primary:active { transform: translateY(1px); }
a { color: var(--accent); text-underline-offset: 3px; }
:is(a, button):focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
[role="status"] { font-size: 14px; }
[role="status"]:empty { display: none; }
.access-note { font-size: 14px; margin-top: 20px; }
dl { margin: 0 0 24px; }
dl > div { padding: 12px 0; border-top: 1px solid var(--line); }
dt { font-weight: 650; }
dd { margin: 4px 0 0; }
code { font-size: 14px; white-space: pre-wrap; }
form { margin: 24px 0 0; }
@media (max-width: 380px) { body { padding: 20px; } h1 { font-size: 25px; } }
`;

export function renderReviewAccessPage(input: {
  title: string;
  heading: string;
  content: string;
  attributes?: string;
  script?: string;
}) {
  return `<!doctype html><html lang="en" data-shiplet-access-page="v1" ${input.attributes || ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(input.title)} · Shiplet</title></head><body><main class="access-page"><div class="access-brand">${SHIPLET_FAVICON_SVG}<span aria-hidden="true">Shiplet</span></div><h1>${escapeHtml(input.heading)}</h1>${input.content}</main>${input.script || ""}</body></html>`;
}

export function withReviewAccessStyles(html: string, nonce: string) {
  return html.replace("</head>", `<style nonce="${escapeHtml(nonce)}">${REVIEW_ACCESS_CSS}</style></head>`);
}
