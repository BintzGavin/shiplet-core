// Copyright (c) 2022 Cloudflare, Inc.
// Licensed under the APACHE LICENSE, VERSION 2.0 license found in the LICENSE file or at http://www.apache.org/licenses/LICENSE-2.0

import { Project, ResourceValues } from "./types";
import type { SandboxSnapshot } from "./sandbox";
import type { ReviewNotificationRecord } from "./notifications";
import {
	kernelScriptNonceAttribute,
	type KernelDocumentNonce,
} from "./kernel-document-nonce";
import type { ReviewFeedbackRecord } from "./review";
import type { ShipletAccessRequestRecord } from "./store";
import {
  AVATAR_PRESETS,
  AVATAR_SPRITE_COLUMNS,
  AVATAR_SPRITE_ROWS,
  AVATAR_SPRITE_URL,
  MAX_AVATAR_UPLOAD_BYTES,
  avatarPresetPosition,
} from "./avatars";
import {
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  SITE_DESCRIPTION,
  SITE_KEYWORDS,
  SITE_NAME,
  SITE_TITLE,
  absoluteSiteUrl,
  htmlAttribute,
  normalizeAppUrl,
  scriptJson,
  structuredData,
} from "./seo";

type RenderUser = {
  id?: string | null;
  email?: string | null;
  avatar_preset?: string | null;
  avatar_data_url?: string | null;
};

type RenderPageOptions = {
	nonce: KernelDocumentNonce;
	customDomain?: string;
	appUrl?: string;
	user?: RenderUser | null;
	hideHeader?: boolean;
	title?: string;
	description?: string;
	canonicalPath?: string | null;
	indexing?: "index" | "noindex";
	skipLink?: { href: string; label: string };
};

const AUTH_CUSTOMS_STAMP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180" aria-hidden="true" focusable="false" shape-rendering="geometricPrecision"><g fill="none" stroke="#c2502f" stroke-linecap="round" stroke-linejoin="round"><circle cx="90" cy="90" r="68" stroke-width="5" opacity=".36"/><circle cx="90" cy="90" r="56" stroke-width="2.25" stroke-dasharray="7 6" opacity=".42"/><rect x="24" y="71" width="132" height="42" rx="4" stroke-width="3" opacity=".42"/><path d="M54 61h72M60 130c10-4 20-4 30 0s20 4 30 0" stroke-width="2.25" opacity=".36"/></g><text x="90" y="99" fill="#c2502f" opacity=".68" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="21" font-weight="800" letter-spacing="1.2" text-anchor="middle">CLEARED</text></svg>`;
const AUTH_CUSTOMS_STAMP_BACKGROUND = `url("data:image/svg+xml,${encodeURIComponent(AUTH_CUSTOMS_STAMP_SVG)}")`;

function ResourceValueToString(value: ResourceValues, columnName?: string) {
  if (value == null) return "null";

  const stringValue = value.toString();

  // Special handling for script_content column
  if (columnName === "script_content" && stringValue.length > 100) {
    const truncated = stringValue.substring(0, 100) + "...";
    return `<div class="script-preview" title="${escapeHtml(stringValue)}">${escapeHtml(truncated)}</div>`;
  }

  // HTML escape all content to prevent rendering issues
  return escapeHtml(stringValue);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateLabel(value: string | null | undefined) {
  if (!value) return "Recently";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function BuildTable(
  name: string,
  dataRows: Record<string, string | number | boolean | null>[] | undefined,
): string {
  if (!dataRows?.length) {
    return `<div class="dataContainer"><h3>${escapeHtml(name)}</h3><p style="color: var(--text-muted);">No data</p></div>`;
  }
  const columns = Object.keys(dataRows[0]);
  const headerRow = `<tr>${columns.map((col) => `<th>${escapeHtml(col)}</th>`).join("")}</tr>`;
  const dataRowsHtml = dataRows
    .map(
      (row) =>
        `<tr>${columns.map((col) => `<td>${ResourceValueToString(row[col], col)}</td>`).join("")}</tr>`,
    )
    .join("");

  const table = `<table class="dataTable">${headerRow}${dataRowsHtml}</table>`;
  return `<div class="dataContainer">${table}</div>`;
}

export const CSS = `
/* ==========================================================================
   Shiplet — "The Harbor Office" design system, Voyage iteration. DESIGN.md
   Token tiers: primitives -> semantic aliases -> components.
   Motion: one orchestrated page-load + a few high-impact moments; everything
   honors prefers-reduced-motion.
   ========================================================================== */

:root {
  color-scheme: light dark;

  /* Primitives */
  --ink-900: oklch(23% 0.04 255);
  --ink-700: oklch(34% 0.035 255);
  --ink-500: oklch(47% 0.03 252);
  --ink-300: oklch(80% 0.02 250);
  --paper-0: oklch(99% 0.005 95);
  --paper-50: oklch(97% 0.01 95);
  --paper-100: oklch(94% 0.015 92);
  --buoy-700: oklch(48% 0.16 35);
  --buoy-600: oklch(54% 0.165 35);
  --buoy-100: oklch(93% 0.045 40);
  --harbor-700: oklch(40% 0.075 220);
  --harbor-600: oklch(47% 0.085 220);
  --harbor-100: oklch(92% 0.04 215);
  --sea-700: oklch(42% 0.1 155);
  --sea-100: oklch(93% 0.055 155);
  --flag-700: oklch(45% 0.1 75);
  --flag-100: oklch(94% 0.08 90);
  --signal-600: oklch(50% 0.19 27);
  --signal-100: oklch(93% 0.045 27);

  /* Semantic */
  --bg: var(--paper-50);
  --surface: var(--paper-0);
  --surface-sunken: var(--paper-100);
  --text: var(--ink-900);
  --text-soft: var(--ink-700);
  --text-muted: var(--ink-500);
  --line: var(--ink-300);
  --line-soft: color-mix(in oklch, var(--ink-300), var(--paper-0) 35%);
  --line-strong: var(--ink-900);
  --action: var(--buoy-600);
  --action-hover: var(--buoy-700);
  --action-contrast: #fff;
  --accent: var(--harbor-600);
  --accent-strong: var(--harbor-700);
  --ring: var(--harbor-600);
  --ok: var(--sea-700);
  --ok-surface: var(--sea-100);
  --warn: var(--flag-700);
  --warn-surface: var(--flag-100);
  --err: var(--signal-600);
  --err-surface: var(--signal-100);
  --err-contrast: #fff;
  --info: var(--harbor-700);
  --info-surface: var(--harbor-100);
  --banner-code-bg: oklch(100% 0 0 / 0.6);
  --mark-ink: #20293a;
  --mark-harbor: #2f6e88;
  --glow-warm: color-mix(in oklch, var(--buoy-100), transparent 50%);
  --glow-cool: color-mix(in oklch, var(--harbor-100), transparent 55%);

  /* Type — big jumps, extreme weights */
  --font-display: "Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif;
  --font-body: ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
  --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --type-display: clamp(2.1rem, 1.35rem + 2.8vw, 3.3rem);
  --type-title: clamp(1.3rem, 1.1rem + 0.8vw, 1.7rem);
  --type-section: 1.08rem;
  --type-body: 0.875rem;
  --type-small: 0.78rem;
  --type-micro: 0.6875rem;

  /* Shape & motion */
  --radius: 10px;
  --radius-sm: 6px;
  --speed: 140ms;
  --ease: cubic-bezier(0.2, 0, 0.2, 1);
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}

/* "Night watch": dark theme via the semantic tier only (DESIGN.md section 4). */
@media (prefers-color-scheme: dark) {
  :root {
    --bg: oklch(21% 0.025 255);
    --surface: oklch(25% 0.025 255);
    --surface-sunken: oklch(18.5% 0.02 255);
    --text: oklch(94% 0.01 95);
    --text-soft: oklch(83% 0.015 95);
    --text-muted: oklch(72% 0.02 250);
    --line: oklch(38% 0.025 255);
    --line-soft: oklch(33% 0.02 255);
    --line-strong: oklch(62% 0.025 250);
    --action: oklch(66% 0.16 40);
    --action-hover: oklch(72% 0.16 45);
    --action-contrast: oklch(18% 0.03 255);
    --accent: oklch(72% 0.08 220);
    --accent-strong: oklch(78% 0.07 215);
    --ring: oklch(72% 0.08 220);
    --ok: oklch(80% 0.1 155);
    --ok-surface: oklch(30% 0.05 155);
    --warn: oklch(85% 0.1 90);
    --warn-surface: oklch(32% 0.05 85);
    --err: oklch(78% 0.12 27);
    --err-surface: oklch(30% 0.06 27);
    --err-contrast: oklch(18% 0.03 255);
    --info: oklch(80% 0.07 220);
    --info-surface: oklch(30% 0.045 220);
    --banner-code-bg: oklch(0% 0 0 / 0.25);
    --mark-ink: oklch(94% 0.01 95);
    --mark-harbor: oklch(70% 0.07 220);
    --glow-warm: oklch(32% 0.05 40 / 0.5);
    --glow-cool: oklch(30% 0.05 230 / 0.55);
  }
}

* { box-sizing: border-box; margin: 0; padding: 0; }

html { background: var(--bg); }

/* Dawn over the harbor: two quiet radial tints, never a marketing gradient. */
body {
  font-family: var(--font-body);
  font-size: var(--type-body);
  line-height: 1.55;
  color: var(--text);
  background:
    radial-gradient(90rem 36rem at 82% -14rem, var(--glow-warm), transparent 70%),
    radial-gradient(70rem 30rem at -12% -10rem, var(--glow-cool), transparent 70%),
    var(--bg);
  background-attachment: fixed;
  min-height: 100vh;
}

h1, h2, h3, h4 {
  font-family: var(--font-display);
  font-weight: 750;
  letter-spacing: -0.025em;
  color: var(--text);
  line-height: 1.12;
  text-wrap: balance;
}

p { margin: 0; }

a { color: var(--accent-strong); text-decoration-thickness: 1px; text-underline-offset: 2px; }
a:hover { color: var(--accent); }

code {
  font-family: var(--font-mono);
  font-size: 0.85em;
  background: var(--surface-sunken);
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  padding: 1px 5px;
  overflow-wrap: anywhere;
}

hr.solid {
  border: none;
  height: 12px;
  margin: 20px 0;
  background: url("/brand/decor/rope-h.png") repeat-x center / auto 12px;
}

:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
  border-radius: 2px;
}

::placeholder { color: var(--text-muted); opacity: 1; }

::selection { background: color-mix(in oklch, var(--accent), transparent 70%); }

[hidden] { display: none !important; }

/* --------------------------------------------------------------------------
   Motion vocabulary
   -------------------------------------------------------------------------- */

@keyframes rise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
@keyframes bob { 0%, 100% { transform: translateY(0) rotate(-1deg); } 50% { transform: translateY(-4px) rotate(1.4deg); } }
@keyframes drift { from { background-position-x: 0; } to { background-position-x: -56px; } }
@keyframes waterline-drift { from { background-position: 0 0, 8px 6px, 16px 12px, 24px 18px; } to { background-position: -840px 0, -832px 6px, -824px 12px, -816px 18px; } }
@keyframes harbor-header-bob { 0%, 100% { transform: translateY(10px) rotate(-0.35deg); } 50% { transform: translateY(8px) rotate(0.35deg); } }
@keyframes draw { to { stroke-dashoffset: 0; } }
@keyframes stamp-in { 0% { opacity: 0; transform: scale(1.55) rotate(-8deg); } 62% { opacity: 1; transform: scale(0.95) rotate(-1deg); } 100% { opacity: 1; transform: scale(1) rotate(-2deg); } }
@keyframes flag-pop { 0% { transform: scale(0); } 70% { transform: scale(1.25); } 100% { transform: scale(1); } }
@keyframes wave-flag { 0%, 100% { transform: rotate(0); } 40% { transform: rotate(-9deg); } 70% { transform: rotate(4deg); } }
@keyframes sail-in { from { opacity: 0; transform: translateX(-110px); } to { opacity: 1; transform: none; } }
@keyframes wheel-in { from { opacity: 0; transform: translateX(-26px) rotate(-6deg) scale(0.94); } to { opacity: 1; transform: none; } }
@keyframes helm-turn { 0%, 100% { transform: rotate(-10deg); } 42% { transform: rotate(22deg); } 68% { transform: rotate(10deg); } }
@keyframes helm-glint { 0%, 34%, 100% { opacity: 0.18; transform: translateX(-7px); } 50% { opacity: 0.72; transform: translateX(7px); } }
@keyframes ticket-in { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
@keyframes gull-drift { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(7px, -4px); } }

/* Line-drawing: paths carry pathLength="1" so one rule animates them all. */
.draw-path { stroke-dasharray: 1; stroke-dashoffset: 1; }
.scene-go .draw-path { animation: draw var(--draw-duration, 1.5s) var(--ease-out) forwards; animation-delay: calc(var(--di, 0) * var(--draw-stagger, 320ms)); }
html:not(.js) .draw-path { stroke-dashoffset: 0; }

.harbor-scene-svg { display: block; max-width: 100%; overflow: hidden; --harbor-line-step: 42ms; }
.harbor-scene-svg * { vector-effect: non-scaling-stroke; }
.harbor-scene-svg .draw-path { stroke-dashoffset: 0; }
.harbor-scene-svg :is(.scene-boat-arrival, .scene-supporting-details, .scene-boat-float, .scene-foreground-tide, .scene-wake-arrival, .scene-boat-wake, .scene-boat-flag, .scene-gull-flight, .scene-beacon-beam, .scene-beacon-lamp) { transform-box: fill-box; transform-origin: center; }
.harbor-scene-svg :is(.scene-cloud-near, .scene-cloud-far, .scene-water-far-layer, .scene-water-mid-layer, .scene-water-near-layer) { transform-box: fill-box; transform-origin: center; }
.harbor-scene-svg .scene-boat-arrival { transform-origin: 50% 78%; }
.harbor-scene-svg .scene-boat-float { transform-origin: 50% 76%; }
.harbor-scene-svg .scene-boat-flag { transform-origin: left center; }
.harbor-scene-svg .scene-beacon-beam { transform-box: view-box; transform-origin: 548px 58px; }
.harbor-scene-svg .scene-backdrop { color: var(--text-muted); opacity: 0.34; }
.harbor-scene-svg .scene-midground { color: var(--mark-ink); opacity: 0.88; }
.harbor-scene-svg .scene-foreground { color: var(--mark-harbor); opacity: 0.92; }
.harbor-scene-svg .scene-primary-silhouette { stroke-width: 2.8px; }
.harbor-scene-svg .scene-structural-line { stroke-width: 2.15px; }
.harbor-scene-svg .scene-fine-detail { stroke-width: 1.45px; }
.harbor-scene-svg .scene-tertiary-detail { stroke-width: 1.05px; opacity: 0.34; }
.harbor-scene-svg .scene-pier-texture { opacity: 0.48; }
.harbor-scene-svg .scene-water { color: var(--mark-harbor); }
.harbor-scene-svg .scene-water-deep { opacity: 0.88; }
.harbor-scene-svg .scene-water-mid { opacity: 0.56; }
.harbor-scene-svg .scene-water-fine { opacity: 0.34; }
.harbor-scene-svg .scene-dock-deck { fill: color-mix(in oklch, var(--surface), var(--mark-ink) 5%); }
.harbor-scene-svg .scene-door-dark { fill: var(--mark-ink); stroke: var(--mark-ink); }
.harbor-scene-svg .scene-window-fill { fill: var(--mark-harbor); stroke: var(--mark-harbor); opacity: 0.78; }
.harbor-scene-svg .scene-signal-flag,
.harbor-scene-svg .scene-beacon-lamp,
.harbor-scene-svg .scene-lantern-glints { fill: var(--action); stroke: var(--action); }
.harbor-scene-svg .scene-boat { opacity: 1; }
.harbor-scene-svg .scene-boat-hull { fill: var(--surface); fill-opacity: 1; stroke: var(--mark-ink); }
.harbor-scene-svg .scene-boat-keel { fill: var(--mark-ink); stroke: var(--mark-ink); }
.harbor-scene-svg .scene-wheelhouse { fill: var(--surface); stroke: var(--mark-ink); }
.harbor-scene-svg .scene-wheelhouse-window { fill: var(--mark-harbor); stroke: var(--mark-harbor); opacity: 0.82; }
.harbor-scene-svg .scene-cargo-harbor { fill: var(--mark-harbor); stroke: var(--mark-harbor); }
.harbor-scene-svg .scene-cargo-buoy { fill: var(--action); stroke: var(--action); }
.harbor-scene-svg .scene-fender { fill: var(--action); stroke: var(--action); }
.harbor-scene-svg .scene-lantern-room { fill: color-mix(in oklch, var(--surface), var(--action) 7%); stroke: var(--mark-ink); }
.harbor-scene-svg .scene-beacon-beam { color: var(--mark-harbor); fill: currentColor; stroke: none; opacity: 0.19; transform: rotate(-4.5deg); }
.harbor-scene-svg .scene-beacon-reflection { color: var(--mark-harbor); opacity: 0.48; }
.harbor-scene-svg .scene-mooring-line { color: var(--mark-ink); }
.harbor-scene-svg .scene-mooring-slack { opacity: 0; stroke-dasharray: 1; stroke-dashoffset: 0; }
.harbor-scene-svg .scene-mooring-taut { opacity: 1; stroke-dasharray: 1; stroke-dashoffset: 0; }
.harbor-scene-svg .scene-wake-arrival { opacity: 0.5; }
.harbor-scene-svg .scene-mooring-slack { transform-box: fill-box; transform-origin: right center; }
html:not(.js) .harbor-scene-svg .scene-boat-hull { fill-opacity: 1; }
html:not(.js) .harbor-scene-svg .scene-beacon-beam { transform: none; opacity: 0.19; }
html:not(.js) .harbor-scene-svg .scene-boat-float { transform: none; }
html:not(.js) .harbor-scene-svg :is(.scene-cloud-near, .scene-cloud-far, .scene-water-far-layer, .scene-water-mid-layer, .scene-water-near-layer) { animation: none; transform: none; }

@keyframes harbor-line-resolve {
  from { stroke-dasharray: 0.16 0.045; stroke-dashoffset: 0.14; }
  to { stroke-dasharray: 1 0; stroke-dashoffset: 0; }
}
@keyframes harbor-boat-dock {
  0% { opacity: 0.76; transform: translate(28px, 4px) rotate(0.32deg); }
  25% { opacity: 0.82; transform: translate(21px, 3px) rotate(0.24deg); }
  50% { opacity: 0.89; transform: translate(14px, 2px) rotate(0.16deg); }
  75% { opacity: 0.96; transform: translate(7px, 1px) rotate(0.08deg); }
  100% { opacity: 1; transform: translate(0, 0) rotate(0deg); }
}
@keyframes harbor-mooring-slack {
  0%, 16% { stroke-dashoffset: 1; opacity: 0; transform: translate(34px, -9px); }
  48%, 76% { stroke-dashoffset: 0; opacity: 0.9; transform: none; }
  100% { stroke-dashoffset: 0; opacity: 0; transform: translateY(-2px); }
}
@keyframes harbor-mooring-secure {
  0%, 58% { stroke-dashoffset: 1; opacity: 0; }
  100% { stroke-dashoffset: 0; opacity: 1; }
}
@keyframes harbor-wake-dissolve {
  0% { opacity: 0; transform: translateX(40px) scaleX(1.34); }
  26% { opacity: 0.96; }
  100% { opacity: 0.5; transform: none; }
}
@keyframes harbor-details-settle {
  from { opacity: 0.9; transform: translateY(2px); }
  to { opacity: 1; transform: none; }
}
@keyframes harbor-boat-idle {
  0%, 100% { transform: none; }
  50% { transform: translateY(-2.4px) rotate(0.2deg); }
}
@keyframes harbor-wake-breathe {
  0%, 100% { transform: translateX(0) scaleX(1); opacity: 0.5; }
  50% { transform: translateX(1.5px) scaleX(1.015); opacity: 0.6; }
}
@keyframes harbor-flag-breathe {
  0%, 100% { transform: translateY(0) scaleX(1); }
  50% { transform: translateY(-0.7px) scaleX(0.96); }
}
@keyframes harbor-lamp-breathe {
  0%, 100% { opacity: 0.72; transform: scale(0.92); }
  50% { opacity: 1; transform: scale(1); }
}
@keyframes harbor-beam-drift {
  0%, 100% { opacity: 0.18; transform: rotate(-4.5deg); }
  50% { opacity: 0.2; transform: rotate(4.5deg); }
}
@keyframes harbor-cloud-near-drift {
  0%, 100% { transform: translate(-8px, 0); }
  50% { transform: translate(16px, -1.2px); }
}
@keyframes harbor-cloud-far-drift {
  0%, 100% { transform: translate(-6px, 0.3px); }
  50% { transform: translate(11px, -0.8px); }
}
@keyframes harbor-water-far-drift {
  0%, 100% { transform: translate(0, 0); }
  50% { transform: translate(3.2px, -0.6px); }
}
@keyframes harbor-water-mid-drift {
  0%, 100% { transform: translate(0, 0) scaleX(1); }
  50% { transform: translate(-4.4px, 0.9px) scaleX(1.008); }
}
@keyframes harbor-water-near-drift {
  0%, 100% { transform: translate(0, 0) scaleX(1); }
  50% { transform: translate(6.4px, -1.1px) scaleX(1.012); }
}
@keyframes harbor-gull-glide {
  0%, 100% { transform: translate(0, 0); }
  50% { transform: translate(4px, -1.5px); }
}

@media (prefers-reduced-motion: no-preference) {
  .js .shiplet-dashboard-stage > *:not(.docs-skip-link),
  .js .settings-stack > section {
    animation: rise 0.55s var(--ease-out) both;
    animation-delay: calc(var(--ri, 0) * 90ms);
  }
  .js .scene-bob { animation: bob 4.5s ease-in-out infinite; }
  .js .scene-gull { animation: gull-drift 6s ease-in-out infinite; }
  .shiplet-header-avatar { animation: harbor-header-bob 5.8s ease-in-out infinite; }
  .scene-go .harbor-scene-svg .draw-path {
    animation: harbor-line-resolve 620ms var(--ease-out) both;
    animation-delay: calc(var(--di, 0) * var(--harbor-line-step));
  }
  .scene-go .harbor-scene-svg .scene-boat-arrival { animation: harbor-boat-dock 2.4s cubic-bezier(0.4, 0, 0.2, 1) 120ms both; }
  .scene-go .harbor-scene-svg .scene-mooring-slack { animation: harbor-mooring-slack 900ms var(--ease-out) 760ms both; }
  .scene-go .harbor-scene-svg .scene-mooring-taut { animation: harbor-mooring-secure 900ms var(--ease-out) 1.26s both; }
  .scene-go .harbor-scene-svg .scene-wake-arrival { animation: harbor-wake-dissolve 1.2s var(--ease-out) 350ms both; }
  .scene-go .harbor-scene-svg .scene-supporting-details { animation: harbor-details-settle 520ms var(--ease-out) 1.35s both; }
  .scene-go .harbor-scene-svg .scene-beacon-beam { animation: harbor-beam-drift 18s cubic-bezier(0.45, 0, 0.55, 1) 0s infinite; }
  .scene-go .harbor-scene-svg .scene-beacon-lamp { animation: harbor-lamp-breathe 4.8s ease-in-out 2.6s infinite; }
  .scene-go .harbor-scene-svg .scene-boat-float { animation: harbor-boat-idle 7.2s ease-in-out 2.52s infinite both; }
  .scene-go .harbor-scene-svg .scene-boat-wake { animation: harbor-wake-breathe 7.2s ease-in-out 2.42s infinite both; }
  .scene-go .harbor-scene-svg .scene-boat-flag { animation: harbor-flag-breathe 4.6s ease-in-out 2.5s infinite both; }
  .scene-go .harbor-scene-svg .scene-cloud-near { animation: harbor-cloud-near-drift 32s ease-in-out -8s infinite; }
  .scene-go .harbor-scene-svg .scene-cloud-far { animation: harbor-cloud-far-drift 44s ease-in-out -19s infinite; }
  .scene-go .harbor-scene-svg .scene-water-far-layer { animation: harbor-water-far-drift 12.8s ease-in-out -1.7s infinite; }
  .scene-go .harbor-scene-svg .scene-water-mid-layer { animation: harbor-water-mid-drift 9.6s ease-in-out -2.3s infinite; }
  .scene-go .harbor-scene-svg .scene-water-near-layer { animation: harbor-water-near-drift 7.1s ease-in-out -4.1s infinite; }
  .scene-go .harbor-scene-svg .scene-gull-flight { animation: harbor-gull-glide 10s ease-in-out 3s infinite; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation: none !important;
    transition-duration: 0.01ms !important;
  }
  .draw-path { stroke-dashoffset: 0; }
  .harbor-scene-svg .scene-boat-hull { fill-opacity: 1; }
  .harbor-scene-svg .scene-boat-float { transform: none; }
  .harbor-scene-svg :is(.scene-boat-wake, .scene-boat-flag, .scene-beacon-beam, .scene-beacon-lamp) { transform: none; }
  .harbor-scene-svg :is(.scene-cloud-near, .scene-cloud-far, .scene-water-far-layer, .scene-water-mid-layer, .scene-water-near-layer) { transform: none; }
  .harbor-scene-svg .scene-beacon-beam { opacity: 0.19; }
}

/* --------------------------------------------------------------------------
   Shell: brand header over a living waterline
   -------------------------------------------------------------------------- */

.shiplet-brand-header {
  position: relative;
  overflow: hidden;
  width: 100%;
  background: color-mix(in oklch, var(--surface), transparent 12%);
  border-bottom: 2px solid var(--line-strong);
}

.shiplet-brand-inner {
  position: relative;
  z-index: 3;
  max-width: 1080px;
  margin: 0 auto;
  padding: 14px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.shiplet-brand-lockup {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  gap: 12px;
  text-decoration: none;
  color: var(--text);
}

.shiplet-brand-mark {
  display: inline-flex;
  width: 34px;
  height: 34px;
  transform-origin: 50% 78%;
  will-change: transform;
}
.shiplet-brand-mark svg { display: block; width: 100%; height: 100%; }

.shiplet-brand-nav { display: inline-flex; align-items: center; gap: 4px; }

.shiplet-brand-nav a {
  font-family: var(--font-mono);
  font-size: var(--type-small);
  font-weight: 500;
  color: var(--text);
  text-decoration: none;
  padding: 7px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  transition: background-color var(--speed) var(--ease), border-color var(--speed) var(--ease);
}

.shiplet-brand-nav a:hover {
  color: var(--text);
  background: var(--surface-sunken);
  border-color: var(--line);
}

.platform-nav {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-bottom: 3px solid var(--line-strong);
  border-radius: var(--radius);
}

.platform-nav a {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 38px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  color: var(--text-soft);
  font-family: var(--font-mono);
  font-size: var(--type-small);
  text-decoration: none;
  border: 1px solid transparent;
}

.platform-nav a:hover,
.platform-nav a[data-current="true"] {
  color: var(--text);
  background: var(--surface-sunken);
  border-color: var(--line);
}

.platform-nav a[data-current="true"] {
  border-bottom-color: var(--action);
}

.platform-nav-badge {
  min-width: 1.45em;
  height: 1.45em;
  display: inline-grid;
  place-items: center;
  border-radius: 999px;
  padding: 0 5px;
  background: var(--action);
  color: var(--action-contrast);
  font-family: var(--font-mono);
  font-size: var(--type-micro);
  line-height: 1;
}

.platform-nav-badge[hidden] { display: none; }

.shiplet-avatar {
  display: inline-grid;
  place-items: center;
  width: 36px;
  height: 36px;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-bottom-width: 2px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: 0 4px 0 color-mix(in oklch, var(--ink-900), transparent 88%);
  flex: 0 0 auto;
}

.shiplet-avatar-sm { width: 30px; height: 30px; }
.shiplet-avatar-lg { width: 56px; height: 56px; }
.shiplet-avatar-xl { width: 78px; height: 78px; }

.shiplet-avatar-sprite,
.shiplet-avatar-img {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: inherit;
}

.shiplet-avatar-sprite {
  background-repeat: no-repeat;
  background-size: ${AVATAR_SPRITE_COLUMNS * 100}% ${AVATAR_SPRITE_ROWS * 100}%;
}

.shiplet-avatar-img { object-fit: cover; }

.shiplet-header-avatar {
  position: relative;
  z-index: 3;
  width: 42px;
  height: 42px;
  padding: 3px !important;
  border-radius: 999px !important;
  color: var(--text) !important;
  transform: translateY(10px);
  transform-origin: 50% 90%;
  will-change: transform;
}

.shiplet-header-avatar .shiplet-avatar {
  width: 34px;
  height: 34px;
  box-shadow: none;
}

.avatar-profile-summary {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin: 14px 0;
}

.avatar-profile-copy {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.avatar-profile-copy strong {
  font-size: var(--type-section);
  font-weight: 750;
}

.avatar-picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
  gap: 10px;
}

.avatar-choice {
  display: grid;
  justify-items: center;
  gap: 8px;
  min-height: 104px;
  padding: 10px 8px;
  color: var(--text-soft);
  background: var(--surface);
  border: 1px solid var(--line);
  border-bottom: 2px solid var(--line-strong);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: var(--type-micro);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  transition: transform var(--speed) var(--ease-out), background-color var(--speed) var(--ease), border-color var(--speed) var(--ease);
}

.avatar-choice:hover,
.avatar-choice.is-active {
  color: var(--text);
  background: var(--info-surface);
  border-color: var(--accent);
  transform: translateY(-1px);
}

.avatar-choice span:last-child {
  max-width: 100%;
  overflow-wrap: anywhere;
}

.avatar-upload-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px 16px;
  align-items: end;
  margin-top: 16px;
}

.avatar-upload-field {
  min-width: 0;
}

.avatar-upload-field .form-help {
  max-width: 58ch;
}

.avatar-upload-grid .btn {
  min-width: 170px;
  justify-self: end;
}

.avatar-crop-panel {
  grid-column: 1 / -1;
  display: grid;
  gap: 12px;
}

.avatar-crop-panel[hidden] { display: none; }

.avatar-crop-stage {
  width: min(100%, 260px);
  aspect-ratio: 1;
  overflow: hidden;
  border: 1px solid var(--line);
  border-bottom: 2px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
}

.avatar-crop-stage canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
}

.avatar-crop-stage canvas.is-dragging { cursor: grabbing; }

.avatar-crop-control {
  width: min(100%, 320px);
}

.avatar-crop-control input[type="range"] {
  width: 100%;
}

@media (max-width: 760px) {
  .avatar-upload-grid {
    grid-template-columns: 1fr;
  }

  .avatar-upload-grid .btn {
    width: 100%;
    justify-self: stretch;
  }
}

/* The waterline lives inside the header, just above the bottom rule. */
.shiplet-waterline {
  position: absolute;
  inset: auto -1px 0 -1px;
  height: 28px;
  overflow: hidden;
  pointer-events: none;
  z-index: 2;
  background-image:
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='8' viewBox='0 0 56 8'%3E%3Cpath d='M0 4 Q14 0.75 28 4 T56 4' fill='none' stroke='%232f6e88' stroke-width='1' opacity='0.22'/%3E%3C/svg%3E"),
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='42' height='8' viewBox='0 0 42 8'%3E%3Cpath d='M0 4 Q10.5 0.75 21 4 T42 4' fill='none' stroke='%232f6e88' stroke-width='1.2' opacity='0.34'/%3E%3C/svg%3E"),
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='8' viewBox='0 0 28 8'%3E%3Cpath d='M0 4 Q7 0.75 14 4 T28 4' fill='none' stroke='%232f6e88' stroke-width='1.5' opacity='0.5'/%3E%3C/svg%3E"),
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='70' height='10' viewBox='0 0 70 10'%3E%3Cpath d='M0 5 Q17.5 1 35 5 T70 5' fill='none' stroke='%232f6e88' stroke-width='1.8' opacity='0.58'/%3E%3C/svg%3E");
  background-repeat: repeat-x;
  background-position: 0 0, 8px 6px, 16px 12px, 24px 18px;
}

@media (prefers-reduced-motion: no-preference) {
  .shiplet-waterline { animation: waterline-drift 210s linear infinite; }
}

.shiplet-main {
  max-width: 1080px;
  margin: 0 auto;
  padding: 30px 24px 72px;
}

.shiplet-main:has(.shiplet-detail-page) {
  max-width: 1460px;
}

/* --------------------------------------------------------------------------
   Page scaffolding
   -------------------------------------------------------------------------- */

.dashboard-shell { display: block; }
.shiplet-dashboard-stage { display: grid; gap: 20px; }

.app-page-topbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.app-page-title h1 { font-size: var(--type-display); font-weight: 800; margin: 8px 0 8px; }
.app-page-title p { color: var(--text-soft); max-width: 52ch; font-size: 0.95rem; }
.app-page-title .docs-site-title {
  font-family: var(--font-display);
  font-size: var(--type-display);
  font-weight: 800;
  letter-spacing: -0.025em;
  line-height: 1.12;
  color: var(--text);
  margin: 8px 0;
  text-wrap: balance;
}

/* Rubber stamp: the section tag, inked slightly off-square. */
.success-card-label {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: var(--type-micro);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.13em;
  color: var(--accent-strong);
  background: color-mix(in oklch, var(--info-surface), transparent 30%);
  border: 1.5px solid color-mix(in oklch, var(--accent), transparent 45%);
  border-radius: 4px;
  padding: 3px 9px;
  transform: rotate(-1.6deg);
  margin-bottom: 8px;
}

.stamp-xl {
  font-size: 0.82rem;
  padding: 6px 14px;
  border-width: 2px;
  transform: rotate(-2deg);
}

/* CSS owns the stamp slam (completes even when rAF throttles); fill: both
   keeps it hidden through the delay without JS. */
@media (prefers-reduced-motion: no-preference) {
  .js .stamp-xl { animation: stamp-in 0.5s 1s both; }
}

/* --------------------------------------------------------------------------
   Manifest cards
   -------------------------------------------------------------------------- */

.success-card,
.shiplet-panel {
  min-width: 0;
  background: var(--surface);
  border: 1px solid var(--line);
  border-bottom: 3px solid var(--line-strong);
  border-radius: var(--radius);
  padding: 24px;
  box-shadow: 0 1px 2px oklch(23% 0.04 255 / 0.06);
}

.shiplet-panel h2, .shiplet-panel h3 { font-size: var(--type-section); }
.shiplet-panel > h2, .shiplet-panel > h3 { margin-bottom: 10px; }
.shiplet-panel p { color: var(--text-soft); }

/* Lead card: a pennant flies from the top edge instead of a slop left-border. */
.shiplet-focus-strip {
  position: relative;
  border-top: 3px solid var(--line-strong);
  margin-top: 14px;
}

.shiplet-focus-strip::before {
  content: "";
  position: absolute;
  top: -21px;
  left: 30px;
  width: 3px;
  height: 21px;
  background: var(--line-strong);
  border-radius: 2px;
}

.shiplet-focus-strip::after {
  content: "";
  position: absolute;
  top: -20px;
  left: 33px;
  border-top: 7px solid transparent;
  border-bottom: 7px solid transparent;
  border-left: 19px solid var(--action);
  transform-origin: left center;
}

@media (prefers-reduced-motion: no-preference) {
  .shiplet-focus-strip:hover::after { animation: wave-flag 0.7s var(--ease); }
}

.dashboard-section-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.dashboard-section-header h2,
.dashboard-section-header h3 { margin-bottom: 4px; }

.dashboard-actions { display: inline-flex; gap: 8px; flex-wrap: wrap; }

.section-glyph {
  display: inline-flex;
  width: 22px;
  height: 22px;
  vertical-align: -5px;
  margin-right: 8px;
  color: var(--accent-strong);
}

.section-glyph svg { display: block; width: 100%; height: 100%; }

/* --------------------------------------------------------------------------
   Forms
   -------------------------------------------------------------------------- */

.form-container {
  background: var(--surface);
  border: 1px solid var(--line);
  border-bottom: 3px solid var(--line-strong);
  border-radius: var(--radius);
  padding: 26px;
  box-shadow: 0 1px 2px oklch(23% 0.04 255 / 0.06);
}

.form-group { display: block; }
.form-group + .form-group { margin-top: 14px; }

label {
  display: block;
  font-weight: 600;
  font-size: var(--type-small);
  margin-bottom: 5px;
  color: var(--text);
}

.dashboard-shell :is(input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), select, textarea),
.form-container :is(input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), select, textarea) {
  width: 100%;
  padding: 9px 11px;
  font-family: inherit;
  font-size: var(--type-body);
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--ink-500);
  border-radius: var(--radius-sm);
  transition: border-color var(--speed) var(--ease), box-shadow var(--speed) var(--ease);
}

.dashboard-shell :is(input, select, textarea):hover,
.form-container :is(input, select, textarea):hover { border-color: var(--text-soft); }

.dashboard-shell :is(input, select, textarea):focus,
.form-container :is(input, select, textarea):focus {
  outline: none;
  border-color: var(--ring);
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--ring), transparent 75%);
}

textarea {
  font-family: var(--font-mono) !important;
  font-size: var(--type-small) !important;
  line-height: 1.6;
  min-height: 120px;
  resize: vertical;
}

input[type="checkbox"] { accent-color: var(--accent); width: 15px; height: 15px; }

.form-group small {
  display: block;
  margin-top: 5px;
  font-size: var(--type-small);
  color: var(--text-muted);
}

.form-help {
  display: block;
  margin-top: 5px;
  color: var(--text-soft);
  font-size: var(--type-small);
  line-height: 1.45;
}

.inline-field-row { display: flex; gap: 8px; align-items: stretch; }
.inline-field-row input { flex: 1; }

.account-list {
  display: grid;
  gap: 10px;
  padding: 12px;
}

.account-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.account-row-meta {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.account-row-meta strong {
  overflow-wrap: anywhere;
}

.account-row-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.domain-input-group {
  display: flex;
  align-items: stretch;
  min-width: 0;
}

.domain-input-group input {
  flex: 1;
  min-width: 0;
  border-top-right-radius: 0 !important;
  border-bottom-right-radius: 0 !important;
}

.domain-input-suffix {
  display: inline-flex;
  align-items: center;
  min-height: 38px;
  padding: 0 11px;
  font-family: var(--font-mono);
  font-size: var(--type-small);
  color: var(--text-soft);
  background: var(--surface-sunken);
  border: 1px solid var(--ink-500);
  border-left: 0;
  border-top-right-radius: var(--radius-sm);
  border-bottom-right-radius: var(--radius-sm);
  white-space: nowrap;
}

details summary {
  cursor: pointer;
  font-weight: 600;
  font-size: var(--type-small);
  color: var(--text-soft);
  padding: 6px 0;
}

details[open] summary { color: var(--text); }
details textarea { margin-top: 8px; }

/* --------------------------------------------------------------------------
   Buttons
   -------------------------------------------------------------------------- */

.btn, .link-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 36px;
  padding: 0 14px;
  font-family: inherit;
  font-size: var(--type-body);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  text-decoration: none;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line-strong);
  border-bottom-width: 2px;
  background: var(--surface);
  color: var(--text);
  transition: background-color var(--speed) var(--ease), transform var(--speed) var(--ease);
}

.btn:active, .link-btn:active { transform: translateY(1px); }

.btn-primary, .link-btn {
  background: var(--action);
  border-color: color-mix(in oklch, var(--action), black 30%);
  color: var(--action-contrast);
}

.btn-primary:hover, .link-btn:hover { background: var(--action-hover); color: var(--action-contrast); }

.btn-secondary { background: var(--surface); color: var(--text); }
.btn-secondary:hover { background: var(--surface-sunken); }

.btn-destructive {
  background: var(--err);
  border-color: color-mix(in oklch, var(--err), black 30%);
  color: var(--err-contrast);
}
.btn-destructive:hover { background: color-mix(in oklch, var(--err), black 12%); }

.btn-sm { height: 30px; padding: 0 10px; font-size: var(--type-small); }
.btn-lg { height: 46px; padding: 0 20px; font-size: 0.95rem; }

.btn-launch {
  width: 100%;
  height: 58px;
  font-family: var(--font-display);
  font-size: 1.12rem;
  font-weight: 750;
  letter-spacing: 0.01em;
  border-radius: var(--radius);
}

.btn-pennant { display: inline-flex; width: 20px; height: 20px; transform-origin: 20% 80%; }
.btn-pennant svg { display: block; width: 100%; height: 100%; }

@media (prefers-reduced-motion: no-preference) {
  .btn-launch:hover .btn-pennant { animation: wave-flag 0.7s var(--ease); }
}

.btn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
}
.btn-icon:hover { background: var(--surface-sunken); color: var(--text); }

/* --------------------------------------------------------------------------
   Banners & stamps
   -------------------------------------------------------------------------- */

.banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid;
  font-size: var(--type-body);
}

.banner-info { background: var(--info-surface); border-color: color-mix(in oklch, var(--info), transparent 55%); color: var(--info); }
.banner-success { background: var(--ok-surface); border-color: color-mix(in oklch, var(--ok), transparent 55%); color: var(--ok); }
.banner-warning { background: var(--warn-surface); border-color: color-mix(in oklch, var(--warn), transparent 55%); color: var(--warn); }
.banner-error { background: var(--err-surface); border-color: color-mix(in oklch, var(--err), transparent 55%); color: var(--err); }

.banner code { background: var(--banner-code-bg); border-color: transparent; }

.status-badge {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-mono);
  font-size: var(--type-micro);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 3px 8px;
  border-radius: 4px;
  border: 1.5px solid currentColor;
  transform: rotate(-1deg);
}

.status-badge.status-active { color: var(--ok); background: var(--ok-surface); }
.status-badge.status-pending { color: var(--warn); background: var(--warn-surface); }
.status-badge.status-error { color: var(--err); background: var(--err-surface); }

.status-row { display: flex; align-items: center; gap: 10px; }
.status-cell { display: flex; align-items: center; gap: 8px; }
.status-details { font-size: var(--type-small); color: var(--text-muted); margin-top: 4px; }
.status-details.error { color: var(--err); }
.status-details-item { display: block; }

@keyframes spin { to { transform: rotate(360deg); } }
.animate-spin { animation: spin 1s linear infinite; }

/* --------------------------------------------------------------------------
   Ledger tables
   -------------------------------------------------------------------------- */

.dataContainer {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.dataContainer h3 { padding: 14px 14px 0; font-size: var(--type-section); }
.dataContainer .banner { margin: 12px; }

.dataTable { border-collapse: collapse; width: 100%; font-size: var(--type-body); }

.dataTable th {
  font-family: var(--font-mono);
  font-size: var(--type-micro);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  text-align: left;
  color: var(--text-muted);
  background: var(--surface-sunken);
  padding: 9px 12px;
  border-bottom: 1px solid var(--line);
}

.dataTable td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--line-soft);
  text-align: left;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dataTable tr:last-child td { border-bottom: none; }
.dataTable tr:hover td { background: var(--surface-sunken); }

.table-link {
  font-family: var(--font-mono);
  font-size: var(--type-small);
  color: var(--accent-strong);
}

/* --------------------------------------------------------------------------
   Shiplets list
   -------------------------------------------------------------------------- */

.shiplet-list-shell {
  padding: 0;
  overflow: hidden;
}

.shiplet-list-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 24px 24px 18px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in oklch, var(--info-surface), transparent 55%);
}

.shiplet-list-head h2 { margin-bottom: 5px; }
.shiplet-list-head p { max-width: 56ch; }

.shiplet-list-toolbar {
  display: grid;
  grid-template-columns: minmax(130px, 180px) minmax(0, 1fr);
  gap: 20px;
  align-items: end;
  padding: 16px 24px;
  border-bottom: 1px solid var(--line);
}

.shiplet-list-metric {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.shiplet-list-metric strong {
  display: block;
  font-size: clamp(1.8rem, 1.2rem + 2vw, 2.4rem);
  line-height: 1;
  font-weight: 800;
  color: var(--text);
}

.shiplet-list-metric span {
  font-family: var(--font-mono);
  font-size: var(--type-micro);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-muted);
}

.shiplet-list-controls {
  display: grid;
  grid-template-columns: minmax(160px, 0.9fr) minmax(220px, 1.6fr);
  gap: 10px;
  align-items: end;
}

.shiplet-list-control {
  display: grid;
  gap: 5px;
  margin: 0;
}

.shiplet-list-control > span,
.shiplet-list-control > label {
  font-weight: 600;
  font-size: var(--type-small);
  color: var(--text);
  margin: 0;
}

.shiplet-list-control[hidden] { display: none; }
.shiplet-list-control[hidden] + .shiplet-list-search { grid-column: 1 / -1; }

.shiplet-list-summary {
  min-height: 20px;
  padding: 10px 24px;
  border-bottom: 1px solid var(--line-soft);
  color: var(--text-muted);
  font-size: var(--type-small);
}

.shiplet-bulk-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 24px;
  border-bottom: 1px solid var(--line-soft);
  background: var(--surface);
  color: var(--text-muted);
  font-size: var(--type-small);
}

.shiplet-select-all {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-weight: 700;
  color: var(--text);
}

.shiplet-row-checkbox {
  inline-size: 18px;
  block-size: 18px;
  accent-color: var(--accent);
}

.shiplet-list-shell #dashboardStatus {
  margin: 14px 24px 0;
}

.shiplet-list-grid {
  min-width: 0;
}

.shiplet-list-rows {
  display: grid;
}

.shiplet-list-row {
  display: grid;
  grid-template-columns: 28px minmax(220px, 1.35fr) minmax(150px, 0.75fr) auto;
  gap: 18px;
  align-items: center;
  padding: 16px 24px;
  border-bottom: 1px solid var(--line-soft);
  transition: background-color var(--speed) var(--ease);
}

.shiplet-list-row:last-child { border-bottom: none; }
.shiplet-list-row:hover { background: var(--surface-sunken); }

.shiplet-list-select {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
}

.shiplet-list-main {
  min-width: 0;
  display: grid;
  gap: 5px;
}

.shiplet-list-name {
  color: var(--text);
  font-weight: 800;
  text-decoration: none;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.shiplet-list-name:hover { color: var(--accent-strong); }

.shiplet-list-url {
  width: fit-content;
  max-width: 100%;
  font-family: var(--font-mono);
  font-size: var(--type-small);
  color: var(--accent-strong);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shiplet-list-url:hover { text-decoration: underline; text-underline-offset: 3px; }

.shiplet-list-meta {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  color: var(--text-muted);
  font-size: var(--type-small);
}

.shiplet-visibility-badge {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  min-height: 24px;
  padding: 3px 8px;
  border: 1px solid color-mix(in oklch, var(--accent), transparent 45%);
  border-radius: 999px;
  background: color-mix(in oklch, var(--info-surface), transparent 30%);
  color: var(--accent-strong);
  font-family: var(--font-mono);
  font-size: var(--type-micro);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  white-space: nowrap;
}

.shiplet-visibility-badge[data-visibility="public"] {
  border-color: color-mix(in oklch, var(--ok), transparent 45%);
  background: var(--ok-surface);
  color: var(--ok);
}

.shiplet-visibility-badge[data-visibility="private"] {
  border-color: color-mix(in oklch, var(--warn), transparent 40%);
  background: var(--warn-surface);
  color: var(--warn);
}

.shiplet-list-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.shiplet-list-actions .btn { white-space: nowrap; }

.shiplet-archive-section {
  border-top: 1px solid var(--line);
}

.shiplet-archive-section[hidden] { display: none; }

.shiplet-archive-section summary {
  cursor: pointer;
  padding: 12px 24px;
  font-weight: 800;
  color: var(--text);
  background: var(--surface-sunken);
}

.shiplet-archive-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 16px;
}

.shiplet-archive-facts div {
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.shiplet-archive-facts dt {
  font-family: var(--font-mono);
  font-size: var(--type-micro);
  font-weight: 700;
  color: var(--text-muted);
}

.shiplet-archive-facts dd {
  margin-top: 3px;
  overflow-wrap: anywhere;
  color: var(--text);
}

.shiplet-lifecycle-form {
  display: grid;
  gap: 10px;
  margin-top: 12px;
}

.shiplet-list-empty {
  display: grid;
  justify-items: start;
  gap: 10px;
  padding: 30px 24px 34px;
}

.shiplet-list-empty strong {
  font-size: var(--type-section);
  color: var(--text);
}

.shiplet-list-empty p {
  max-width: 52ch;
  color: var(--text-soft);
}

.script-preview {
  font-family: var(--font-mono);
  font-size: var(--type-small);
  background: var(--surface-sunken);
  padding: 5px 8px;
  border-radius: 4px;
  cursor: help;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* --------------------------------------------------------------------------
   The voyage: guided publish flow
   -------------------------------------------------------------------------- */

.url-tag {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px 10px 12px;
  background: var(--surface);
  border: 1.5px solid var(--line-strong);
  border-radius: 8px 16px 16px 8px;
  box-shadow: 3px 3px 0 color-mix(in oklch, var(--line), transparent 35%);
  transform: rotate(1.6deg);
}

.url-tag-hole {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--bg);
  border: 1.5px solid var(--line-strong);
  flex-shrink: 0;
}

.url-tag code {
  background: none;
  border: none;
  padding: 0;
  font-weight: 600;
  font-size: var(--type-small);
  color: var(--text);
}

.voyage { display: grid; }

.voyage-step {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  column-gap: 20px;
  padding: 20px 0;
  position: relative;
}

.voyage-step:first-child { padding-top: 4px; }
.voyage-step:last-child { padding-bottom: 4px; }

.voyage-rail { position: relative; display: flex; justify-content: center; }

.voyage-rail::before {
  content: "";
  position: absolute;
  top: 38px;
  bottom: -38px;
  left: 50%;
  width: 3px;
  transform: translateX(-50%);
  border-radius: 999px;
  background: repeating-linear-gradient(
    to bottom,
    color-mix(in oklch, var(--action), transparent 35%) 0 8px,
    transparent 8px 14px
  );
  opacity: 0.72;
  box-shadow: 0 0 0 1px color-mix(in oklch, var(--action), transparent 78%);
}

.voyage-step:last-child .voyage-rail::before { display: none; }

.voyage-step.done .voyage-rail::before {
  background: repeating-linear-gradient(
    to bottom,
    var(--action) 0 9px,
    transparent 9px 14px
  );
  opacity: 0.9;
}

.voyage-bollard {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: 2px solid var(--line-strong);
  background: var(--surface);
  font-family: var(--font-mono);
  font-size: var(--type-small);
  font-weight: 700;
  color: var(--text-soft);
  display: grid;
  place-items: center;
  position: relative;
  z-index: 1;
  transition: background-color 0.25s var(--ease), color 0.25s var(--ease), border-color 0.25s var(--ease);
}

.voyage-step.done .voyage-bollard {
  background: var(--action);
  border-color: color-mix(in oklch, var(--action), black 28%);
  color: var(--action-contrast);
}

.voyage-flag {
  position: absolute;
  top: -15px;
  left: calc(50% + 8px);
  width: 20px;
  height: 20px;
  color: var(--action);
  transform: scale(0);
  transform-origin: 15% 90%;
  z-index: 2;
}

.voyage-flag svg { display: block; width: 100%; height: 100%; }

.voyage-step.done .voyage-flag { transform: scale(1); }

@media (prefers-reduced-motion: no-preference) {
  .voyage-step.done .voyage-flag { animation: flag-pop 0.45s var(--ease-out) both; }
}

.voyage-title {
  font-size: var(--type-title);
  font-weight: 750;
  margin-bottom: 4px;
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.voyage-num {
  font-family: var(--font-mono);
  font-size: var(--type-small);
  font-weight: 600;
  color: var(--text-muted);
  letter-spacing: 0.1em;
}

.voyage-hint { color: var(--text-soft); font-size: var(--type-small); margin-bottom: 14px; }

.shiplet-upload-dropzone {
  display: grid;
  justify-items: center;
  gap: 6px;
  text-align: center;
  padding: 32px 20px;
  background:
    radial-gradient(28rem 10rem at 50% 120%, var(--glow-cool), transparent 70%),
    var(--surface-sunken);
  border: 2px dashed var(--ink-500);
  border-radius: var(--radius);
  cursor: pointer;
  transition: border-color var(--speed) var(--ease), transform 0.25s var(--ease-out);
}

.shiplet-upload-dropzone:hover,
.shiplet-upload-dropzone.is-dragging {
  border-color: var(--accent);
  transform: translateY(-2px);
}

.shiplet-upload-dropzone.is-dragging {
  background:
    radial-gradient(28rem 10rem at 50% 120%, var(--glow-warm), transparent 70%),
    var(--info-surface);
}

.shiplet-upload-dropzone strong {
  font-family: var(--font-display);
  font-size: var(--type-section);
  font-weight: 750;
}

.shiplet-upload-dropzone span { color: var(--text-soft); font-size: var(--type-small); }

.shiplet-upload-dropzone input[type="file"] {
  margin-top: 10px;
  font-size: var(--type-small);
  color: var(--text-soft);
  max-width: 100%;
}

.dropzone-glyph { width: 64px; height: 44px; color: var(--text-soft); margin-bottom: 4px; }
.dropzone-glyph svg { display: block; width: 100%; height: 100%; }

.source-choice-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.source-choice {
  position: relative;
  display: grid;
  gap: 4px;
  align-content: start;
  min-height: 112px;
  padding: 14px;
  border: 1px solid var(--line);
  border-bottom: 3px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
  overflow: hidden;
  cursor: pointer;
  transition: border-color var(--speed) var(--ease), transform var(--speed) var(--ease);
}

.source-choice:hover,
.source-choice.is-active {
  border-color: var(--accent-strong);
  transform: translateY(-1px);
}

.source-choice input {
  position: absolute;
  top: 0;
  left: 0;
  width: 1px;
  height: 1px;
  margin: 0;
  padding: 0;
  border: 0;
  opacity: 0;
  pointer-events: none;
}

.source-choice-title {
  font-family: var(--font-display);
  font-size: var(--type-section);
  font-weight: 750;
  color: var(--text);
}

.source-choice-copy {
  color: var(--text-soft);
  font-size: var(--type-small);
}

.publish-fields-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.publish-fields-grid .form-group + .form-group { margin-top: 0; }

/* --------------------------------------------------------------------------
   Settings: the harbor office ledger
   -------------------------------------------------------------------------- */

.settings-layout {
  display: grid;
  grid-template-columns: 178px minmax(0, 1fr);
  gap: 22px;
  align-items: start;
}

.settings-nav {
  position: sticky;
  top: 16px;
  display: grid;
  gap: 2px;
  padding: 10px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-bottom: 3px solid var(--line-strong);
  border-radius: var(--radius);
}

.settings-nav a {
  display: flex;
  align-items: center;
  gap: 9px;
  font-family: var(--font-mono);
  font-size: var(--type-small);
  color: var(--text-soft);
  text-decoration: none;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border-left: 2px solid transparent;
}

.settings-nav a:hover,
.settings-nav a[data-current="true"] {
  background: var(--surface-sunken);
  color: var(--text);
  border-left-color: var(--action);
}

.settings-nav .nav-glyph { display: inline-flex; width: 16px; height: 16px; color: var(--accent-strong); }
.settings-nav .nav-glyph svg { display: block; width: 100%; height: 100%; }

.settings-stack { display: grid; gap: 20px; min-width: 0; }

.live-status {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: var(--type-micro);
  color: var(--text-muted);
  background: var(--surface-sunken);
  white-space: nowrap;
}

.live-status-success {
  color: var(--ok);
  border-color: color-mix(in oklch, var(--ok), transparent 55%);
  background: var(--ok-surface);
}

.live-status-error {
  color: var(--err);
  border-color: color-mix(in oklch, var(--err), transparent 55%);
  background: var(--err-surface);
}

.docs-layout {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  gap: 22px;
  align-items: start;
}

.docs-skip-link {
  position: fixed;
  z-index: 1000;
  top: 12px;
  left: 12px;
  padding: 10px 14px;
  border: 1px solid var(--action);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--accent-strong);
  transform: translateY(-160%);
  transition: transform 120ms ease;
}

.docs-skip-link:focus {
  transform: translateY(0);
}

.docs-nav-disclosure {
  display: contents;
}

.docs-nav-disclosure > summary {
  display: none;
}

.docs-nav-disclosure:not([open]) > .docs-nav {
  display: grid;
}

.docs-nav { align-content: start; }

.docs-nav-group {
  display: grid;
  gap: 2px;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--line-soft);
}

.docs-nav-group:last-child { border-bottom: 0; padding-bottom: 0; }

.docs-nav-group > span {
  font-family: var(--font-mono);
  font-size: var(--type-micro);
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-muted);
  padding: 8px 10px 3px;
}

.docs-nav a[aria-current="page"] {
  background: var(--info-surface);
  color: var(--accent-strong);
  border-left-color: var(--action);
}

.docs-article {
  max-width: 780px;
}

.docs-article h1 {
  font-size: var(--type-title);
  margin: 6px 0 8px;
}

.docs-description {
  color: var(--text-soft);
}

.docs-content {
  display: grid;
  min-width: 0;
  gap: 14px;
  margin-top: 20px;
}

.docs-content h2 {
  font-size: var(--type-section);
  margin-top: 10px;
}

.docs-content h3 {
  font-size: var(--type-body-lg);
  margin-top: 8px;
}

.docs-figure {
  display: grid;
  gap: 8px;
  margin: 4px 0 10px;
}

.docs-figure img {
  display: block;
  width: 100%;
  height: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
}

.docs-figure figcaption {
  color: var(--text-muted);
  font-size: var(--type-small);
  line-height: 1.5;
}

.docs-content ul {
  display: grid;
  gap: 7px;
  padding-left: 1.2rem;
}

.docs-content pre {
  max-width: 100%;
  overflow-x: auto;
  background: var(--ink-900);
  color: var(--paper-50);
  border: 1px solid var(--ink-900);
  border-radius: var(--radius-sm);
  padding: 13px 14px;
}

.docs-content pre code {
  display: block;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  white-space: pre;
}

.docs-table {
  display: block;
  width: 100%;
  max-width: 100%;
  border-collapse: collapse;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  overflow-x: auto;
  overscroll-behavior-inline: contain;
}

.docs-table:focus-visible {
  outline: 3px solid var(--ring);
  outline-offset: 3px;
}

.docs-table th,
.docs-table td {
  border-bottom: 1px solid var(--line-soft);
  padding: 9px 10px;
  text-align: left;
  vertical-align: top;
}

.docs-table th {
  font-family: var(--font-mono);
  font-size: var(--type-small);
  color: var(--text-soft);
  background: var(--surface-sunken);
}

.settings-form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 12px;
  align-items: end;
}

.settings-form-grid .form-group + .form-group { margin-top: 0; }

.scope-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }

.scope-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-family: var(--font-mono);
  font-size: var(--type-small);
  font-weight: 500;
  padding: 6px 11px;
  margin-bottom: 0;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 999px;
  cursor: pointer;
  transition: border-color var(--speed) var(--ease), background-color var(--speed) var(--ease), transform var(--speed) var(--ease);
}

.scope-pill:hover { border-color: var(--accent); transform: translateY(-1px); }
.scope-pill:has(input:checked) { background: var(--info-surface); border-color: var(--accent); color: var(--accent-strong); }

/* --------------------------------------------------------------------------
   Review bridge: the arrival
   -------------------------------------------------------------------------- */

.arrival-scene {
  position: relative;
  height: 92px;
  margin: 8px 0 2px;
  overflow: hidden;
  color: var(--mark-ink);
}

.arrival-water {
  position: absolute;
  inset: auto 0 10px 0;
  height: 12px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='9' viewBox='0 0 28 9'%3E%3Cpath d='M0 4.5 Q7 0.5 14 4.5 T28 4.5' fill='none' stroke='%232f6e88' stroke-width='1.5' opacity='0.5'/%3E%3C/svg%3E");
  background-repeat: repeat-x;
}

@media (prefers-reduced-motion: no-preference) {
  .arrival-water { animation: drift 12s linear infinite; }
}

.arrival-boat { position: absolute; left: 18px; bottom: 12px; width: 86px; height: 78px; }
.arrival-boat svg { display: block; width: 100%; height: 100%; }

.bridge-interior-scene {
  position: relative;
  height: 150px;
  margin: 2px 0 10px;
  overflow: hidden;
  color: var(--mark-ink);
}

.bridge-interior-scene svg { display: block; width: 100%; height: 100%; overflow: hidden; }
.bridge-cabin-shell { fill: var(--surface-sunken); stroke: var(--line-strong); }
.bridge-window-glass { fill: color-mix(in oklch, var(--mark-harbor), var(--surface) 82%); stroke: var(--mark-harbor); }
.bridge-window-frame { stroke: var(--mark-ink); }
.bridge-harbor-horizon,
.bridge-window-water { stroke: var(--mark-harbor); }
.bridge-console { fill: var(--mark-ink); stroke: var(--line-strong); }
.bridge-console-top { fill: color-mix(in oklch, var(--mark-ink), var(--surface) 18%); }
.bridge-gauge { fill: var(--surface); stroke: var(--mark-harbor); }
.bridge-gauge-needle { stroke: #c2502f; }
.bridge-throttle { stroke: #c2502f; }
.bridge-wheel-stand { color: var(--mark-harbor); opacity: 0.9; }
.bridge-wheel-rim { fill: var(--surface); }
.bridge-wheel-spokes { color: var(--mark-harbor); }
.bridge-wheel-hub { fill: #c2502f; stroke: #c2502f; }
.bridge-wheel-grips { stroke: #c2502f; }
.bridge-wheel-rotor {
  transform-origin: 96px 88px;
  transform-box: view-box;
}
.bridge-wheel-glint {
  transform-origin: 96px 88px;
  transform-box: view-box;
}

@media (prefers-reduced-motion: no-preference) {
  .js .arrival-boat { animation: sail-in 1.3s var(--ease-out) both; }
  .js .bridge-interior-scene { animation: wheel-in 0.9s var(--ease-out) both; }
  .js .bridge-wheel-rotor { animation: helm-turn 5.8s ease-in-out 0.9s infinite; }
  .js .bridge-wheel-glint { animation: helm-glint 5.8s ease-in-out 0.9s infinite; }
  .js .feedback-ticket.ticket-enter { animation: ticket-in 0.45s var(--ease-out) both; animation-delay: var(--ti, 0ms); }
}

.shiplet-detail-hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.shiplet-detail-hero h1 { font-size: var(--type-title); margin: 6px 0 6px; }
.shiplet-detail-actions { display: inline-flex; gap: 8px; flex-wrap: wrap; align-items: center; }

.review-command-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
  gap: 18px;
  align-items: start;
}

.artifact-preview-shell {
  background: var(--surface);
  border: 1px solid var(--line);
  border-bottom: 3px solid var(--line-strong);
  border-radius: var(--radius);
  padding: 16px;
}

.artifact-preview-frame {
  width: 100%;
  height: min(72vh, 780px);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: #fff;
}

.review-side-stack { display: grid; gap: 16px; min-width: 0; }

.review-comments-panel {
  display: grid;
  gap: 12px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--line-soft);
}

.bridge-comment-form {
  display: grid;
  gap: 10px;
}

.bridge-comment-form textarea {
  min-height: 82px;
}

.dashboard-shell .bridge-comment-form .bridge-comment-submit {
  justify-self: start;
  width: auto;
  min-width: 160px;
}

.feedback-ticket-list { display: grid; gap: 10px; }

.feedback-ticket {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 12px;
  display: grid;
  gap: 8px;
  background: var(--surface);
}

.feedback-ticket-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.feedback-ticket-id {
  font-family: var(--font-mono);
  font-size: var(--type-micro);
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--accent-strong);
  background: var(--info-surface);
  border: 1.5px solid color-mix(in oklch, var(--accent), transparent 40%);
  border-radius: 4px;
  padding: 2px 7px;
  transform: rotate(-1deg);
}

.dashboard-shell .feedback-ticket-header .feedback-ticket-status-select {
  flex: 0 0 auto;
  width: auto;
  min-width: 128px;
  max-width: 172px;
  padding: 4px 8px;
  font-size: var(--type-small);
}

.feedback-ticket-meta {
  font-family: var(--font-mono);
  font-size: var(--type-micro);
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.feedback-context-details {
  color: var(--text-muted);
}

.feedback-context-details summary {
  display: inline-flex;
  padding: 0;
  font-family: var(--font-mono);
  font-size: var(--type-micro);
}

.feedback-context-details dl {
  display: grid;
  gap: 3px;
  margin-top: 6px;
  font-family: var(--font-mono);
  font-size: var(--type-micro);
  overflow-wrap: anywhere;
}

.feedback-context-details dt {
  color: var(--text-soft);
  font-weight: 700;
}

.feedback-context-details dd {
  margin: 0 0 5px;
}

.feedback-manifest-developer-context {
  border-top: 1px solid var(--line);
  padding-top: 8px;
}

.feedback-manifest-developer-context summary {
  cursor: pointer;
  font-weight: 700;
  color: var(--accent-strong);
}

.feedback-manifest-developer-body {
  display: grid;
  gap: 10px;
  margin-top: 8px;
}

.feedback-manifest-response {
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 6px 0 0;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: var(--type-micro);
  line-height: 1.5;
}

.feedback-ticket-screenshot {
  appearance: none;
  display: inline-grid;
  place-items: center;
  width: min(100%, 340px);
  aspect-ratio: 16 / 10;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: #fff;
  color: inherit;
  cursor: zoom-in;
}

.feedback-ticket-screenshot:hover { border-color: var(--accent); }

.feedback-ticket-screenshot img {
  display: block;
  width: 100%;
  height: 100%;
  max-height: none;
  object-fit: contain;
  background: #fff;
}

.feedback-ticket-screenshot-note {
  font-size: var(--type-small);
  color: var(--text-soft);
  background: var(--surface-sunken);
  border: 1px dashed var(--line);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}

.feedback-screenshot-lightbox {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 12px;
  padding: 20px;
  background: color-mix(in oklch, var(--ink-900), transparent 8%);
}

.feedback-screenshot-lightbox[hidden] {
  display: none;
}

.feedback-screenshot-lightbox-close {
  justify-self: end;
}

.feedback-screenshot-lightbox-frame {
  display: grid;
  place-items: center;
  min-height: 0;
}

.feedback-screenshot-lightbox img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: #fff;
}

.feedback-reply-list {
  display: grid;
  gap: 6px;
  background: url("/brand/decor/rope-h.png") repeat-x top center / auto 9px;
  padding-top: 15px;
}

.feedback-reply {
  font-size: var(--type-small);
  color: var(--text-soft);
  background: var(--surface-sunken);
  border-radius: var(--radius-sm);
  padding: 7px 9px;
}

.mcp-code-block {
  display: block;
  font-family: var(--font-mono);
  font-size: var(--type-small);
  line-height: 1.6;
  white-space: pre;
  overflow-x: auto;
  background: var(--ink-900);
  color: var(--paper-50);
  border: 1px solid var(--ink-900);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
}

.mcp-endpoint-copy {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  margin: 12px 0;
  padding: 10px;
  background: var(--surface-sunken);
  border: 1px solid var(--line);
  border-bottom: 2px solid var(--line-strong);
  border-radius: var(--radius-sm);
}

.mcp-endpoint-copy-label {
  grid-column: 1 / -1;
  font-family: var(--font-mono);
  font-size: var(--type-micro);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
}

.mcp-endpoint-copy-url {
  display: block;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  -webkit-overflow-scrolling: touch;
}

.mcp-copy-button {
  width: 34px;
  height: 34px;
  color: var(--accent-strong);
  background: var(--surface);
  border-color: var(--line);
}

.mcp-copy-button:hover,
.mcp-copy-button.is-copied {
  color: var(--text);
  background: var(--info-surface);
}

.mcp-copy-button svg { display: block; width: 16px; height: 16px; }

.result-slot:not(:empty) { margin-top: 14px; }

/* --------------------------------------------------------------------------
   Sign-in: arrival at the harbor
   -------------------------------------------------------------------------- */

.auth-stage { display: grid; place-items: center; gap: 6px; padding: 3vh 0 0; }

.auth-scene { width: min(640px, 92%); color: var(--mark-ink); }
.auth-scene svg { width: 100%; height: auto; }

.auth-card {
  max-width: 520px;
  width: 100%;
  text-align: center;
  display: grid;
  gap: 12px;
  justify-items: center;
  margin-top: -6px;
}

.auth-card h1 { font-size: clamp(1.6rem, 1.2rem + 1.6vw, 2.2rem); font-weight: 800; }
.auth-card .auth-card-copy { color: var(--text-soft); }
.auth-proof-list {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px 18px;
  padding: 0;
  color: var(--text-soft);
  font-family: var(--font-mono);
  font-size: var(--type-small);
  list-style-position: inside;
}
.auth-proof-list li::marker { color: var(--action); }
.auth-card .link-btn, .auth-card .btn { min-width: 180px; height: 46px; }
.auth-docs-link {
  font-family: var(--font-mono);
  font-size: var(--type-small);
  color: var(--text-soft);
}
.auth-docs-link:hover { color: var(--accent-strong); }

@media (prefers-reduced-motion: no-preference) {
  .js .auth-card { animation: rise 0.6s var(--ease-out) 0.5s both; }
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* --------------------------------------------------------------------------
   Harbor chrome: decoration art
   -------------------------------------------------------------------------- */

.publish-primary-panel {
  background-image: ${AUTH_CUSTOMS_STAMP_BACKGROUND};
  background-repeat: no-repeat;
  background-position: top -48px right -38px;
  background-size: 152px 152px;
}

.auth-card {
  background-image: ${AUTH_CUSTOMS_STAMP_BACKGROUND};
  background-repeat: no-repeat;
  background-position: top -52px right -44px;
  background-size: 144px 144px;
}

#agents.shiplet-panel {
  background-image: url("/brand/decor/anchor.png");
  background-repeat: no-repeat;
  background-position: bottom -36px right -26px;
  background-size: 270px;
}

.review-side-stack > section:last-child {
  background-image: url("/brand/decor/compass.png");
  background-repeat: no-repeat;
  background-position: bottom -48px right -40px;
  background-size: 230px;
}

/* --------------------------------------------------------------------------
   Responsive
   -------------------------------------------------------------------------- */

@media (max-width: 900px) {
  .review-command-grid { grid-template-columns: 1fr; }
  .settings-layout { grid-template-columns: 1fr; }
  .docs-layout { grid-template-columns: 1fr; }
  .shiplet-list-toolbar { grid-template-columns: 1fr; align-items: stretch; }
  .shiplet-list-controls { grid-template-columns: minmax(160px, 1fr) minmax(220px, 1fr); }
  .shiplet-list-row { grid-template-columns: minmax(0, 1fr); align-items: start; }
  .shiplet-list-actions { justify-content: flex-start; }
  .platform-nav { overflow-x: auto; flex-wrap: nowrap; -webkit-overflow-scrolling: touch; }
  .platform-nav a { flex: 0 0 auto; }
  .settings-nav { position: static; display: flex; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .docs-nav-disclosure { display: block; }
  .docs-nav-disclosure > summary {
    display: flex;
    min-height: 44px;
    align-items: center;
    padding: 10px 14px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    font-weight: 700;
  }
  .docs-nav-disclosure:not([open]) > .docs-nav { display: none; }
  .docs-nav-disclosure[open] > .docs-nav {
    display: grid;
    margin-top: 8px;
  }
  .docs-nav { overflow-x: visible; }
  .url-tag { display: none; }
}

	@media (max-width: 640px) {
  	  .shiplet-main { padding: 20px 16px 48px; }
  	  .shiplet-brand-inner { padding: 12px 16px; }
  .harbor-scene-svg .scene-mobile-atmosphere { display: none; }
  .harbor-scene-svg .scene-mobile-secondary { display: none; }
  .harbor-scene-svg .scene-tertiary-detail { display: none; }
  .harbor-scene-svg .scene-pier-texture { opacity: 0.28; }
  .shiplet-dashboard-stage { gap: 16px; }
  .success-card, .shiplet-panel { padding: 18px; }
  .shiplet-list-shell { padding: 0; }
  .shiplet-list-head,
  .shiplet-list-toolbar,
  .shiplet-list-summary,
  .shiplet-list-row,
  .shiplet-list-empty { padding-left: 16px; padding-right: 16px; }
  .shiplet-list-shell #dashboardStatus { margin-left: 16px; margin-right: 16px; }
  .shiplet-list-controls { grid-template-columns: 1fr; }
  .shiplet-list-actions { width: 100%; }
  .shiplet-list-actions .btn { flex: 1 1 120px; }
  .platform-nav {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    overflow-x: visible;
  }
  .platform-nav a { justify-content: space-between; min-width: 0; }
  .settings-stack { gap: 16px; }
  .settings-nav {
    width: 100%;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
    padding: 8px;
    overflow-x: visible;
  }
  .settings-nav a {
    min-width: 0;
    padding: 9px 8px;
    justify-content: flex-start;
    white-space: nowrap;
  }
  .settings-nav .nav-glyph { flex: 0 0 16px; }
  .docs-page .settings-nav {
    grid-template-columns: 1fr;
  }
  .docs-page .settings-nav a {
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .platform-nav {
    display: flex;
    grid-template-columns: none;
    flex-wrap: nowrap;
    overflow-x: auto;
    padding: 8px;
  }
  .platform-nav a {
    flex: 0 0 auto;
    justify-content: center;
    min-width: 86px;
  }
  .inline-field-row { flex-direction: column; }
  .inline-field-row input,
  .inline-field-row select,
  .inline-field-row .btn,
  .inline-field-row .link-btn { width: 100%; }
  .account-row { align-items: stretch; flex-direction: column; }
  .account-row-actions { justify-content: flex-start; }
  .dashboard-actions { width: 100%; }
  .dashboard-actions .btn,
  .dashboard-actions .link-btn { flex: 1 1 auto; }
  .dashboard-section-header { gap: 12px; }
  .dashboard-section-header > .btn,
  .dashboard-section-header > .link-btn { width: 100%; }
	  .publish-fields-grid,
	  .source-choice-grid,
	  .settings-form-grid,
	  .docs-layout,
	  .review-command-grid,
	  .settings-layout { grid-template-columns: 1fr !important; }
  .voyage-step { grid-template-columns: 42px minmax(0, 1fr); column-gap: 12px; }
  .voyage-bollard { width: 32px; height: 32px; }
  .btn, .link-btn { min-height: 44px; }
  .btn-sm { min-height: 38px; }
  .docs-page .btn-sm,
  .docs-page .docs-nav a { min-height: 44px; }
  .shiplet-brand-nav a { min-height: 44px; display: inline-flex; align-items: center; }
  .app-page-topbar { align-items: flex-start; }
  .artifact-preview-frame { height: 60vh; }
}
`;

const BRAND_MARK_SVG = `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" shape-rendering="geometricPrecision"><g transform="translate(0 -8)"><rect x="62" y="20" width="4" height="42" rx="2" fill="var(--mark-ink, #20293a)"/><path d="M66 18l26 11-26 11z" fill="#c2502f"/><rect x="40" y="62" width="21" height="20" rx="2" fill="var(--mark-harbor, #2f6e88)"/><rect x="67" y="62" width="21" height="20" rx="2" fill="#c2502f"/><path d="M28 86h72l-13 24H41z" fill="var(--mark-ink, #20293a)"/><path d="M29 118q7-7 14 0t14 0t14 0t14 0t14 0" fill="none" stroke="var(--mark-harbor, #2f6e88)" stroke-width="5" stroke-linecap="round"/></g></svg>`;

/* Pennant glyph for buttons and step flags. */
const PENNANT_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" shape-rendering="geometricPrecision"><path d="M7 22V3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M7 3.5l12 4.5-12 4.5z" fill="currentColor"/></svg>`;

/* Wide line-art harbor for the sign-in scene. Paths carry pathLength="1" so the
   stylesheet's draw rule animates them; --di staggers the drawing order. */
export const HARBOR_SCENE_SVG = `<svg class="harbor-scene-svg" viewBox="0 0 640 190" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" shape-rendering="geometricPrecision" fill="none" stroke="currentColor" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round">
  <defs>
    <linearGradient id="harbor-beam-fade" gradientUnits="userSpaceOnUse" x1="539" y1="58" x2="410" y2="18">
      <stop data-beam-depth="source" offset="0%" stop-color="var(--mark-harbor, #2f6e88)" stop-opacity="1"/>
      <stop data-beam-depth="mid" offset="64%" stop-color="var(--mark-harbor, #2f6e88)" stop-opacity="0.74"/>
      <stop data-beam-depth="far" offset="100%" stop-color="var(--mark-harbor, #2f6e88)" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <g class="scene-backdrop scene-environment">
    <path class="draw-path scene-shoreline scene-intentional-contour scene-fine-detail" style="--di:0" d="M8 126c28-9 55-8 79-2 25 6 51 4 77-4" pathLength="1"/>
    <path class="draw-path scene-shoreline scene-intentional-contour scene-fine-detail scene-mobile-secondary" style="--di:0" d="M462 122c29-8 56-7 81-1 25 6 53 3 86-6" pathLength="1"/>
    <path class="draw-path scene-cloud scene-cloud-near scene-intentional-contour scene-fine-detail" style="--di:1" d="M42 50c9-11 23-11 30 0 9-16 31-16 39 0h37" pathLength="1"/>
    <path class="draw-path scene-cloud scene-cloud-far scene-intentional-contour scene-fine-detail scene-mobile-secondary" style="--di:1" d="M454 37c7-9 18-9 24 0 8-13 26-13 33 0h25" pathLength="1"/>
    <g class="scene-sky-birds scene-gull-flight">
      <path class="draw-path scene-gull scene-fine-detail" style="--di:2" d="M399 46q8-8 16 0t16 0" pathLength="1"/>
      <path class="draw-path scene-gull scene-fine-detail scene-mobile-secondary" style="--di:2" d="M438 32q6-7 12 0t12 0" pathLength="1"/>
    </g>
  </g>

  <g class="scene-midground scene-supporting-details">
    <g class="scene-dock scene-detail">
      <path class="draw-path scene-dock-deck scene-primary-silhouette" style="--di:1" d="M24 135h189l27 17H17z" pathLength="1"/>
      <path class="draw-path scene-pier-texture scene-fine-detail" style="--di:2" d="M22 141h200" pathLength="1"/>
      <path class="draw-path scene-pier-texture scene-fine-detail" style="--di:2" d="M19 147h213" pathLength="1"/>
      <path class="draw-path scene-boathouse-shed-roof scene-pier-house scene-primary-silhouette" style="--di:1" d="M43 108h110l-15-17H61z" pathLength="1"/>
      <path class="draw-path scene-pier-house scene-structural-line" style="--di:2" d="M50 108v27h96v-27" pathLength="1"/>
      <path class="draw-path scene-pier-house scene-structural-line" style="--di:2" d="M75 108v27" pathLength="1"/>
      <rect class="draw-path scene-door-dark scene-boat-slip" style="--di:3" x="83" y="117" width="25" height="18" rx="1.5" pathLength="1"/>
      <rect class="draw-path scene-window-fill scene-fine-detail" style="--di:3" x="116" y="113" width="19" height="10" rx="1.5" pathLength="1"/>
      <path class="draw-path scene-window-mullion scene-tertiary-detail" style="--di:3" d="M116 118h19" pathLength="1"/>
      <path class="draw-path scene-window-mullion scene-tertiary-detail" style="--di:3" d="M125.5 113v10" pathLength="1"/>
      <path class="draw-path scene-signal-mast scene-structural-line" style="--di:2" d="M63 91V69" pathLength="1"/>
      <path class="draw-path scene-signal-flag" style="--di:3" d="M63 70l21 7-21 7z" pathLength="1"/>
      <path class="draw-path scene-dock-piling scene-primary-silhouette" style="--di:3" d="M34 135v36m92-36v40m92-25v25" pathLength="1"/>
      <path class="draw-path scene-dock-ladder scene-structural-line" style="--di:3" d="M157 138v30m16-29v28m-16-21h16m-16 9h16" pathLength="1"/>
      <path class="draw-path scene-dock-bollard scene-structural-line" style="--di:3" d="M201 145v-9h8v9z" pathLength="1"/>
    </g>

    <g class="scene-beacon scene-detail">
      <g class="scene-beacon-beam">
        <path data-beam-course="port-open-sky" data-beam-bounds="410 10 539 67" fill="url(#harbor-beam-fade)" d="M538 52c-36-20-76-34-120-42-7-1-10 16-4 18 44 10 85 25 125 39z"/>
      </g>
      <path class="draw-path scene-breakwater scene-primary-silhouette" style="--di:1" d="M469 145h126l30 16H454z" pathLength="1"/>
      <path class="draw-path scene-breakwater scene-pier-texture scene-fine-detail" style="--di:2" d="M463 151h143" pathLength="1"/>
      <path class="draw-path scene-beacon-body scene-primary-silhouette" style="--di:1" d="M514 143l9-67h40l9 67z" pathLength="1"/>
      <path class="draw-path scene-beacon-detail scene-structural-line" style="--di:2" d="M519 106h48" pathLength="1"/>
      <path class="draw-path scene-beacon-detail scene-structural-line" style="--di:2" d="M516 126h54" pathLength="1"/>
      <path class="draw-path scene-beacon-door scene-fine-detail" style="--di:3" d="M535 143v-17c0-5 4-9 8-9s8 4 8 9v17" pathLength="1"/>
      <path class="draw-path scene-beacon-balcony scene-primary-silhouette" style="--di:2" d="M515 76h56" pathLength="1"/>
      <path class="draw-path scene-beacon-rail scene-structural-line" style="--di:2" d="M520 76v-9h47v9" pathLength="1"/>
      <path class="draw-path scene-lantern-room scene-fine-detail" style="--di:2" d="M525 67V51c0-3 2-5 5-5h26c3 0 5 2 5 5v16z" pathLength="1"/>
      <path class="draw-path scene-beacon-cap scene-primary-silhouette" style="--di:2" d="M521 46q22-19 44 0z" pathLength="1"/>
      <path class="scene-beacon-lamp" d="M537 59v-5c0-3 2.5-5 5.5-5s5.5 2 5.5 5v5z"/>
      <g class="scene-lantern-glints scene-fine-detail">
        <path d="M518 55h-6"/>
        <path d="M568 55h6"/>
        <path class="scene-mobile-secondary" d="M543 38v-6"/>
      </g>
      <path class="draw-path scene-beacon-reflection scene-intentional-contour scene-fine-detail" style="--di:4" d="M520 158c14-4 28-4 42 0" pathLength="1"/>
      <path class="draw-path scene-beacon-reflection scene-intentional-contour scene-fine-detail scene-mobile-secondary" style="--di:4" d="M527 170c10-3 20-3 30 0" pathLength="1"/>
    </g>
  </g>

  <g class="scene-foreground scene-water">
    <g class="scene-foreground-tide">
      <g class="scene-water-far-layer">
        <path class="draw-path scene-horizon-line scene-water-deep scene-structural-line scene-intentional-contour" style="--di:0" d="M5 164c26-8 51-8 76 0s50 8 75 0" pathLength="1"/>
        <path class="draw-path scene-horizon-line scene-water-deep scene-structural-line scene-intentional-contour" style="--di:0" d="M469 164c27-8 53-8 79 0s52 8 86 0" pathLength="1"/>
      </g>
      <g class="scene-water-mid-layer">
        <path class="draw-path scene-water-mid scene-fine-detail scene-intentional-contour" style="--di:1" d="M18 178c21-6 42-6 63 0s42 6 63 0" pathLength="1"/>
        <path class="draw-path scene-water-mid scene-fine-detail scene-intentional-contour" style="--di:1" d="M503 178c22-6 44-6 66 0s43 6 64 0" pathLength="1"/>
      </g>
      <g class="scene-water-near-layer">
        <path class="draw-path scene-water-ripple scene-water-fine scene-tertiary-detail scene-intentional-contour" style="--di:2" d="M84 153c12-4 24-4 36 0" pathLength="1"/>
        <path class="draw-path scene-water-ripple scene-water-fine scene-tertiary-detail scene-intentional-contour scene-mobile-secondary" style="--di:2" d="M435 154c13-4 26-4 39 0" pathLength="1"/>
      </g>
    </g>

    <g class="scene-boat-arrival scene-boat scene-working-vessel">
      <g class="scene-wake-arrival">
        <g class="scene-boat-wake">
          <path class="draw-path scene-boat-wake-line scene-structural-line scene-intentional-contour" style="--di:2" d="M244 158c-20 8-41 8-63 0" pathLength="1"/>
          <path class="draw-path scene-boat-wake-line scene-fine-detail scene-intentional-contour" style="--di:3" d="M232 170c-23 7-47 6-70-1" pathLength="1"/>
          <path class="draw-path scene-boat-wake-line scene-structural-line scene-intentional-contour" style="--di:2" d="M403 159c23-9 47-8 72 2" pathLength="1"/>
          <path class="draw-path scene-boat-wake-line scene-fine-detail scene-intentional-contour" style="--di:3" d="M414 170c24-7 48-6 73 2" pathLength="1"/>
        </g>
      </g>
      <g class="scene-boat-float">
        <path class="draw-path scene-boat-hull scene-primary-silhouette" style="--di:1" d="M245 124h168l-15 29c-28 15-102 16-137 2z" pathLength="1"/>
        <path class="draw-path scene-deck-rim scene-primary-silhouette" style="--di:1" d="M241 123c39 5 135 5 177 0" pathLength="1"/>
        <path class="draw-path scene-boat-keel scene-structural-line" style="--di:2" d="M262 155c34 13 103 12 136-2l-7 9c-31 11-88 12-121 2z" pathLength="1"/>
        <rect class="draw-path scene-cargo-harbor" style="--di:2" x="267" y="98" width="34" height="25" rx="2.5" pathLength="1"/>
        <rect class="draw-path scene-cargo-buoy" style="--di:2" x="305" y="90" width="37" height="33" rx="2.5" pathLength="1"/>
        <path class="draw-path scene-container-detail scene-tertiary-detail" style="--di:3" d="M278 98v25m12-25v25" pathLength="1"/>
        <path class="draw-path scene-container-detail scene-tertiary-detail" style="--di:3" d="M317 90v33m13-33v33" pathLength="1"/>
        <path class="draw-path scene-wheelhouse scene-primary-silhouette" style="--di:2" d="M349 123V91h47l8 32z" pathLength="1"/>
        <path class="draw-path scene-wheelhouse scene-structural-line" style="--di:2" d="M345 91h55l-7-7h-39z" pathLength="1"/>
        <rect class="draw-path scene-wheelhouse-window scene-fine-detail" style="--di:3" x="356" y="98" width="14" height="11" rx="1.5" pathLength="1"/>
        <rect class="draw-path scene-wheelhouse-window scene-fine-detail" style="--di:3" x="376" y="98" width="14" height="11" rx="1.5" pathLength="1"/>
        <path class="draw-path scene-mast-crossbar scene-structural-line" style="--di:2" d="M371 84V58h22" pathLength="1"/>
        <path class="draw-path scene-rigging scene-fine-detail" style="--di:3" d="M371 62l-22 29" pathLength="1"/>
        <path class="draw-path scene-rigging scene-fine-detail" style="--di:3" d="M371 62l25 29" pathLength="1"/>
        <g class="scene-boat-flag">
          <path class="draw-path scene-signal-flag" style="--di:3" d="M371 59l25 8-25 8z" pathLength="1"/>
        </g>
        <circle class="draw-path scene-fender scene-fine-detail" style="--di:3" cx="252" cy="131" r="5" pathLength="1"/>
        <circle class="draw-path scene-fender scene-fine-detail" style="--di:3" cx="406" cy="131" r="5" pathLength="1"/>
        <path class="draw-path scene-bow-cleat scene-fine-detail" style="--di:3" d="M397 123v-6h8v6" pathLength="1"/>
      </g>
      <g class="scene-boat-reflection">
        <path class="draw-path scene-water-mid scene-structural-line scene-intentional-contour" style="--di:3" d="M272 170c28 8 92 8 120 0" pathLength="1"/>
        <path class="draw-path scene-water-fine scene-fine-detail scene-intentional-contour" style="--di:4" d="M289 180c22 5 68 5 88 0" pathLength="1"/>
      </g>
    </g>

    <path class="scene-mooring-line scene-mooring-slack scene-structural-line" d="M401 119c-33-2-40 25-71 27-50 4-85-1-122-2" pathLength="1"/>
    <path class="scene-mooring-line scene-mooring-taut scene-structural-line" d="M401 119c-72 8-128 16-193 25" pathLength="1"/>
  </g>
</svg>`;

/* Arrival boat for the review bridge hero. */
const ARRIVAL_BOAT_SVG = `<svg viewBox="0 0 100 90" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" shape-rendering="geometricPrecision" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M14 62h72l-14 20H26z" fill="currentColor"/><path d="M50 62V18"/><path d="M52 19l30 11-30 11" fill="#c2502f" stroke="none"/><path d="M28 48h18v14m8-14h18v14" stroke-width="2.5"/></svg>`;

/* Interior wheelhouse scene for active review bridges. */
const BRIDGE_INTERIOR_SVG = `<svg class="bridge-wheel-svg bridge-interior-svg" viewBox="0 0 300 150" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" shape-rendering="geometricPrecision" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
  <rect class="bridge-cabin-shell" x="10" y="8" width="280" height="134" rx="9" stroke-width="2"/>
  <g class="bridge-windows" stroke-width="2">
    <path class="bridge-window-glass" d="M24 20h70v54H24z"/>
    <path class="bridge-window-glass" d="M102 18h96v56h-96z"/>
    <path class="bridge-window-glass" d="M206 20h70v54h-70z"/>
    <path class="bridge-window-frame" d="M94 18v58M198 18v58M150 18v56M22 75h256"/>
    <path class="bridge-harbor-horizon" d="M31 50h55M112 49h76M216 50h52" opacity=".72"/>
    <path class="bridge-window-water" d="M31 62c9-4 18-4 27 0s18 4 27 0m31 0c11-4 22-4 33 0s22 4 33 0m38 0c8-4 16-4 24 0s16 4 24 0" opacity=".56"/>
  </g>
  <g class="bridge-console" stroke-width="2">
    <path d="M34 101h232l-24 36H58z"/>
    <path class="bridge-console-top" d="M58 88h184l24 13H34z" stroke="none"/>
  </g>
  <g class="bridge-instruments" stroke-width="2">
    <circle class="bridge-gauge" cx="170" cy="107" r="8"/>
    <path class="bridge-gauge-needle" d="M170 107l5-4"/>
    <circle class="bridge-gauge" cx="194" cy="107" r="8"/>
    <path class="bridge-gauge-needle" d="M194 107l-3-5"/>
    <circle class="bridge-gauge" cx="218" cy="107" r="8"/>
    <path class="bridge-gauge-needle" d="M218 107l4 5"/>
    <path class="bridge-throttle" d="M246 119V96"/>
    <circle class="bridge-wheel-hub" cx="246" cy="94" r="4"/>
  </g>
  <g class="bridge-wheel-stand" stroke-width="4">
    <path d="M96 111v24"/>
    <path d="M69 136h54"/>
    <path d="M82 134l14-28 14 28"/>
  </g>
  <g class="bridge-wheel-rotor" stroke-width="3">
    <circle class="bridge-wheel-rim" cx="96" cy="88" r="30"/>
    <circle cx="96" cy="88" r="20" opacity=".72"/>
    <g class="bridge-wheel-spokes" stroke-width="2.4">
      <path d="M96 58v60"/>
      <path d="M66 88h60"/>
      <path d="M75 67l42 42"/>
      <path d="M117 67l-42 42"/>
    </g>
    <g class="bridge-wheel-grips" stroke-width="4">
      <path d="M96 50v12"/>
      <path d="M96 114v12"/>
      <path d="M58 88h12"/>
      <path d="M122 88h12"/>
      <path d="M68 60l9 9"/>
      <path d="M115 107l9 9"/>
      <path d="M124 60l-9 9"/>
      <path d="M77 107l-9 9"/>
    </g>
    <circle class="bridge-wheel-hub" cx="96" cy="88" r="9"/>
    <path class="bridge-wheel-glint" d="M84 70c8-7 21-8 31-1" stroke="#fff" stroke-width="2.2" opacity=".24"/>
  </g>
</svg>`;

/* Settings nav glyphs: flag, knot, tag, plug — line icons, currentColor. */
const GLYPHS = {
  flag: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" shape-rendering="geometricPrecision" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4.5l13 4.5-13 4.5z"/></svg>`,
  knot: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" shape-rendering="geometricPrecision" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="12" r="5"/><circle cx="15" cy="12" r="5"/></svg>`,
  tag: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" shape-rendering="geometricPrecision" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12l9-9h9v9l-9 9z"/><circle cx="16.5" cy="7.5" r="1.6"/></svg>`,
  plug: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" shape-rendering="geometricPrecision" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v6m6-6v6"/><path d="M6 9h12l-2 7a4 4 0 01-8 0z"/><path d="M12 16v5"/></svg>`,
} as const;

function glyph(name: keyof typeof GLYPHS, cls = "nav-glyph") {
  return `<span class="${cls}" aria-hidden="true">${GLYPHS[name]}</span>`;
}

const REMOTE_MCP_ENDPOINT = "https://shiplet.cc/api/mcp";

function copyIconSvg() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" shape-rendering="geometricPrecision"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
}

function BuildMcpEndpointCopy(options: {
  endpoint: string;
  label?: string;
  id?: string;
}) {
  const endpoint = escapeHtml(options.endpoint);
  const label = escapeHtml(options.label || "MCP endpoint");
  const id = options.id ? ` id="${htmlAttribute(options.id)}"` : "";

  return `<div class="mcp-endpoint-copy" data-mcp-endpoint>
  <div class="mcp-endpoint-copy-label">${label}</div>
  <code${id} class="mcp-endpoint-copy-url">${endpoint}</code>
  <button type="button" class="btn-icon mcp-copy-button" data-copy-value="${htmlAttribute(options.endpoint)}" aria-label="Copy MCP endpoint" title="Copy MCP endpoint">
    ${copyIconSvg()}
    <span class="sr-only">Copy MCP endpoint</span>
  </button>
</div>`;
}

function avatarSpriteStyle(presetId: unknown) {
  const position = avatarPresetPosition(presetId);
  return [
    `background-image: url('${AVATAR_SPRITE_URL}')`,
    `background-position: ${position.x}% ${position.y}%`,
    `background-size: ${AVATAR_SPRITE_COLUMNS * 100}% ${AVATAR_SPRITE_ROWS * 100}%`,
  ].join("; ");
}

function renderAvatar(
  user?: RenderUser | null,
  options?: { className?: string; label?: string },
) {
  const className = options?.className ? ` ${options.className}` : "";
  const label = htmlAttribute(options?.label || user?.email || "Shiplet user");
  if (user?.avatar_data_url) {
    return `<span class="shiplet-avatar${className}" role="img" aria-label="${label}"><img class="shiplet-avatar-img" src="${htmlAttribute(user.avatar_data_url)}" alt=""></span>`;
  }
  return `<span class="shiplet-avatar${className}" role="img" aria-label="${label}"><span class="shiplet-avatar-sprite" style="${htmlAttribute(avatarSpriteStyle(user?.avatar_preset))}"></span></span>`;
}

function BuildAvatarPresetButtons() {
  return AVATAR_PRESETS.map(
    (preset) =>
      `<button class="avatar-choice" type="button" data-avatar-preset="${htmlAttribute(preset.id)}" aria-pressed="false">
  ${renderAvatar({ avatar_preset: preset.id }, { className: "shiplet-avatar-lg", label: preset.label })}
  <span>${escapeHtml(preset.label)}</span>
</button>`,
  ).join("");
}

function BuildHeaderNav(user?: RenderUser | null) {
  if (user) {
    return `<nav class="shiplet-brand-nav" aria-label="Utility">
      <a href="/docs">Docs</a>
      <a class="shiplet-header-avatar" href="/account" aria-label="Open account for ${htmlAttribute(user.email || "your account")}" title="Account">${renderAvatar(user)}</a>
    </nav>`;
  }
  return `<nav class="shiplet-brand-nav" aria-label="Utility">
      <a href="/docs">Docs</a>
    </nav>`;
}

/* Progressive enhancement: load orchestration, voyage stepper, live URL tag,
   CSS arrival timeline, and ticket stagger.
   The dashboard runtime script above owns all data behavior — this script only
   reads form state and animates. */
const EnhanceScript = (nonce: KernelDocumentNonce) => `
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(nonce)}>
(function () {
	var d = document;
	d.documentElement.classList.add("js");
	var reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
	d.addEventListener("DOMContentLoaded", function () {
		var docsDisclosure = d.querySelector(".docs-nav-disclosure");
		var docsViewport = window.matchMedia && matchMedia("(min-width: 901px)");
		function syncDocsDisclosure() {
			if (!docsDisclosure || !docsViewport) return;
			if (docsViewport.matches) docsDisclosure.setAttribute("open", "");
			else docsDisclosure.removeAttribute("open");
		}
		syncDocsDisclosure();
		if (docsViewport && docsViewport.addEventListener) docsViewport.addEventListener("change", syncDocsDisclosure);
		else if (docsViewport && docsViewport.addListener) docsViewport.addListener(syncDocsDisclosure);

		var i = 0;
		d.querySelectorAll(".shiplet-dashboard-stage > *:not(.docs-skip-link), .settings-stack > section").forEach(function (el) {
			el.style.setProperty("--ri", String(i++));
		});
		d.body.classList.add("scene-go");

		d.addEventListener("click", function (event) {
			var target = event.target;
			var button = target && target.closest ? target.closest("[data-copy-value]") : null;
			if (!button) return;
			var value = button.getAttribute("data-copy-value") || "";
			var previousLabel = button.getAttribute("aria-label") || "Copy MCP endpoint";
			function markCopied() {
				button.classList.add("is-copied");
				button.setAttribute("aria-label", "Copied");
				button.setAttribute("title", "Copied");
				window.setTimeout(function () {
					button.classList.remove("is-copied");
					button.setAttribute("aria-label", previousLabel);
					button.setAttribute("title", previousLabel);
				}, 1200);
			}
			function fallbackCopy() {
				var textarea = d.createElement("textarea");
				textarea.value = value;
				textarea.setAttribute("readonly", "");
				textarea.style.position = "fixed";
				textarea.style.left = "-9999px";
				d.body.appendChild(textarea);
				textarea.select();
				try { d.execCommand("copy"); } catch (error) {}
				textarea.remove();
				markCopied();
			}
			if (navigator.clipboard && window.isSecureContext) {
				navigator.clipboard.writeText(value).then(markCopied).catch(fallbackCopy);
			} else {
				fallbackCopy();
			}
		});

		var slug = d.getElementById("subdomain");
		var tag = d.getElementById("urlTagText");
		function tagText() {
			if (!tag) return;
			var v = (slug && slug.value.trim()) || "your-shiplet";
			tag.textContent = window.CUSTOM_DOMAIN ? v + "." + window.CUSTOM_DOMAIN : location.host + "/" + v;
		}
		tagText();

			var form = d.getElementById("projectForm");
			if (form && d.querySelector(".voyage")) {
				var file = d.getElementById("fileInput");
				var name = d.getElementById("projectName");
				var dropzone = d.querySelector("[data-upload-dropzone]");
				function handleUploadDrop(event) {
					if (!file || !event.dataTransfer || !event.dataTransfer.files || !event.dataTransfer.files.length) return;
					event.preventDefault();
					event.stopPropagation();
					var fileInput = file;
					fileInput.files = event.dataTransfer.files;
					fileInput.dispatchEvent(new Event("change", { bubbles: true }));
				}
				if (dropzone && file) {
					["dragenter", "dragover"].forEach(function (eventName) {
						dropzone.addEventListener(eventName, function (event) {
							event.preventDefault();
							dropzone.classList.add("is-dragging");
						});
					});
					["dragleave", "drop"].forEach(function (eventName) {
						dropzone.addEventListener(eventName, function () {
							dropzone.classList.remove("is-dragging");
						});
					});
					dropzone.addEventListener("drop", handleUploadDrop);
				}
				function setDone(n, done) {
					var s = d.querySelector('.voyage-step[data-step="' + n + '"]');
					if (s) s.classList.toggle("done", !!done);
				}
			function update() {
				setDone(1, file && file.files && file.files.length > 0);
				setDone(2, name && name.value.trim() && slug && slug.value.trim());
				tagText();
			}
			["change", "input"].forEach(function (e) { form.addEventListener(e, update); });
			update();
		}

		if (reduced) return;

		// CSS animations own visibility and motion, including the reduced-motion path.
		var list = d.getElementById("feedbackList");
		if (list && window.MutationObserver) {
			new MutationObserver(function () {
				list.querySelectorAll(".feedback-ticket:not(.ticket-seen)").forEach(function (el, k) {
					el.classList.add("ticket-seen");
					el.style.setProperty("--ti", (k * 80) + "ms");
					el.classList.add("ticket-enter");
				});
			}).observe(list, { childList: true, subtree: true });
		}
	});
})();
</script>`;

export function renderPage(
	body: string,
	options: RenderPageOptions,
) {
	const nonce = options.nonce;
	const appUrl = normalizeAppUrl(options?.appUrl);
	const title = options?.title || SITE_TITLE;
	const description = options?.description || SITE_DESCRIPTION;
	const noIndex =
		options?.indexing === "noindex" ||
		(options?.indexing === undefined && Boolean(options?.user));
	const canonicalPath =
		options?.canonicalPath === undefined ? "/" : options.canonicalPath;
	const canonicalUrl =
		noIndex || canonicalPath === null
			? null
			: absoluteSiteUrl(appUrl, canonicalPath);
	const ogImageUrl = absoluteSiteUrl(appUrl, "/og-image.png");
	const logoUrl = absoluteSiteUrl(appUrl, "/brand/logo.png");
	const jsonLd = noIndex ? null : scriptJson(structuredData(appUrl));
	const header = options?.hideHeader
		? ""
		: `<header class="shiplet-brand-header">
  <div class="shiplet-brand-inner">
    <a class="shiplet-brand-lockup" href="/" aria-label="Shiplet home">
      <span class="shiplet-brand-mark scene-bob" aria-hidden="true">${BRAND_MARK_SVG}</span>
    </a>
    ${BuildHeaderNav(options?.user)}
  </div>
  <div class="shiplet-waterline" aria-hidden="true"></div>
</header>`;
  const skipLink = options?.skipLink
    ? `<a class="docs-skip-link" href="${htmlAttribute(options.skipLink.href)}">${htmlAttribute(options.skipLink.label)}</a>`
    : "";

  return `
<!DOCTYPE html><html lang="en">
<head>
  <meta charset="utf-8">
  <title>${htmlAttribute(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="description" content="${htmlAttribute(description)}">
  <meta name="keywords" content="${htmlAttribute(SITE_KEYWORDS)}">
  <meta name="robots" content="${noIndex ? "noindex,nofollow,noarchive" : "index,follow,max-image-preview:large"}">
  <meta name="author" content="${htmlAttribute(SITE_NAME)}">
  <meta name="application-name" content="${htmlAttribute(SITE_NAME)}">
  <meta name="apple-mobile-web-app-title" content="${htmlAttribute(SITE_NAME)}">
  <meta name="theme-color" content="#20293a">
  <meta name="color-scheme" content="light dark">
  ${canonicalUrl ? `<link rel="canonical" href="${htmlAttribute(canonicalUrl)}">` : ""}
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="icon" href="${htmlAttribute(logoUrl)}" type="image/png" sizes="512x512">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <link rel="alternate" type="text/plain" href="/llms.txt" title="Shiplet LLM summary">
  <meta property="og:site_name" content="${htmlAttribute(SITE_NAME)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${htmlAttribute(title)}">
  <meta property="og:description" content="${htmlAttribute(description)}">
  ${canonicalUrl ? `<meta property="og:url" content="${htmlAttribute(canonicalUrl)}">` : ""}
  <meta property="og:image" content="${htmlAttribute(ogImageUrl)}">
  <meta property="og:image:secure_url" content="${htmlAttribute(ogImageUrl)}">
  <meta property="og:image:width" content="${OG_IMAGE_WIDTH}">
  <meta property="og:image:height" content="${OG_IMAGE_HEIGHT}">
  <meta property="og:image:alt" content="Shiplet logo and product card.">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${htmlAttribute(title)}">
  <meta name="twitter:description" content="${htmlAttribute(description)}">
  <meta name="twitter:image" content="${htmlAttribute(ogImageUrl)}">
  ${jsonLd ? `<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(nonce)} type="application/ld+json">${jsonLd}</script>` : ""}
  <style>${CSS}</style>
</head>
<body class="shiplet-brand-shell">
${skipLink}
${header}
<main class="shiplet-main">
${body}
</main>
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(nonce)}>
  window.CUSTOM_DOMAIN = ${scriptJson(options?.customDomain || "")};
  window.SHIPLET_AVATAR_PRESETS = ${scriptJson(AVATAR_PRESETS)};
</script>
${EnhanceScript(nonce)}
</body>
</html>
`;
}

export const DashboardRuntimeScript = (nonce: KernelDocumentNonce) => `
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(nonce)}>
(function() {
  var detailProject = window.SHIPLET_DETAIL_PROJECT || null;
  var MAX_AVATAR_UPLOAD_BYTES = ${MAX_AVATAR_UPLOAD_BYTES};
  var AVATAR_EXPORT_SIZE = 512;
  var state = {
    user: null,
    organizations: [],
    teamsByOrganization: {},
    projects: [],
    archivedProjects: [],
    apiTokensByOrganization: {},
    organizationRolesByOrganization: {},
    accountSessions: [],
    avatarPresets: window.SHIPLET_AVATAR_PRESETS || [],
    pendingAvatarPreset: "",
    pendingAvatarDataUrl: undefined,
    avatarCrop: null,
    features: { workerCodePublishing: false, accountEmailSwitching: false },
    selectedOrganizationId: detailProject && detailProject.organization_id || "",
    feedback: [],
    watch: { watching: false, source: "none" },
    watchLoading: false
  };

  function qs(id) { return document.getElementById(id); }
  function on(id, eventName, handler) {
    var el = qs(id);
    if (el) el.addEventListener(eventName, handler);
  }
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function setStatus(message, kind) {
    var el = qs("dashboardStatus");
    if (!el) return;
    el.className = "banner banner-" + (kind || "info");
    el.textContent = message;
  }
  function baseUrlFor(subdomain) {
    return window.CUSTOM_DOMAIN ? "https://" + subdomain + "." + window.CUSTOM_DOMAIN : window.location.origin + "/" + subdomain;
  }
  function avatarPresetFor(id) {
    var presets = state.avatarPresets && state.avatarPresets.length ? state.avatarPresets : (window.SHIPLET_AVATAR_PRESETS || []);
    for (var i = 0; i < presets.length; i++) {
      if (presets[i].id === id) return presets[i];
    }
    return presets[0] || { id: "aurora-grid", label: "Aurora grid", column: 0, row: 0 };
  }
  var avatarSpriteColumns = ${AVATAR_SPRITE_COLUMNS};
  var avatarSpriteRows = ${AVATAR_SPRITE_ROWS};
  function avatarSpriteStyle(presetId) {
    var preset = avatarPresetFor(presetId);
    var x = avatarSpriteColumns <= 1 ? 0 : (Number(preset.column || 0) / (avatarSpriteColumns - 1)) * 100;
    var y = avatarSpriteRows <= 1 ? 0 : (Number(preset.row || 0) / (avatarSpriteRows - 1)) * 100;
    return "background-image:url('${AVATAR_SPRITE_URL}');background-size:" + avatarSpriteColumns * 100 + "% " + avatarSpriteRows * 100 + "%;background-position:" + x + "% " + y + "%;";
  }
  function avatarMarkup(user, className) {
    var classes = "shiplet-avatar" + (className ? " " + className : "");
    var label = esc(user && user.email || "Shiplet user");
    if (user && user.avatar_data_url) {
      return "<span class=\\"" + classes + "\\" role=\\"img\\" aria-label=\\"" + label + "\\"><img class=\\"shiplet-avatar-img\\" src=\\"" + esc(user.avatar_data_url) + "\\" alt=\\"\\"></span>";
    }
    return "<span class=\\"" + classes + "\\" role=\\"img\\" aria-label=\\"" + label + "\\"><span class=\\"shiplet-avatar-sprite\\" style=\\"" + avatarSpriteStyle(user && user.avatar_preset) + "\\"></span></span>";
  }
  function renderHeaderAvatar() {
    var link = document.querySelector(".shiplet-header-avatar");
    if (link && state.user) link.innerHTML = avatarMarkup(state.user, "");
  }
  function activeAvatarDraft() {
    return {
      email: state.user && state.user.email,
      avatar_preset: state.pendingAvatarPreset || state.user && state.user.avatar_preset || "aurora-grid",
      avatar_data_url: state.pendingAvatarDataUrl === undefined ? state.user && state.user.avatar_data_url || null : state.pendingAvatarDataUrl
    };
  }
  function avatarOutputDataUrl(canvas) {
    var webp = canvas.toDataURL("image/webp", 0.86);
    return webp.indexOf("data:image/webp") === 0 ? webp : canvas.toDataURL("image/png");
  }
  function clearAvatarCrop() {
    state.avatarCrop = null;
    var panel = qs("avatarCropPanel");
    var canvas = qs("avatarCropCanvas");
    var zoomInput = qs("avatarCropZoom");
    if (panel) panel.hidden = true;
    if (canvas) canvas.classList.remove("is-dragging");
    if (zoomInput) zoomInput.value = "1";
  }
  function clampAvatarCrop(crop, canvas, drawWidth, drawHeight) {
    var maxX = Math.max(0, (drawWidth - canvas.width) / 2);
    var maxY = Math.max(0, (drawHeight - canvas.height) / 2);
    crop.offsetX = Math.min(maxX, Math.max(-maxX, crop.offsetX || 0));
    crop.offsetY = Math.min(maxY, Math.max(-maxY, crop.offsetY || 0));
  }
  function drawAvatarCrop() {
    var panel = qs("avatarCropPanel");
    var canvas = qs("avatarCropCanvas");
    var zoomInput = qs("avatarCropZoom");
    var crop = state.avatarCrop;
    if (!panel || !canvas) return;
    if (!crop || !crop.image) {
      panel.hidden = true;
      return;
    }
    var context = canvas.getContext("2d");
    if (!context) return;
    if (canvas.width !== AVATAR_EXPORT_SIZE) canvas.width = AVATAR_EXPORT_SIZE;
    if (canvas.height !== AVATAR_EXPORT_SIZE) canvas.height = AVATAR_EXPORT_SIZE;
    var imageWidth = crop.image.naturalWidth || crop.image.width || AVATAR_EXPORT_SIZE;
    var imageHeight = crop.image.naturalHeight || crop.image.height || AVATAR_EXPORT_SIZE;
    var baseScale = Math.max(canvas.width / imageWidth, canvas.height / imageHeight);
    var zoom = Math.max(1, Math.min(3, Number(crop.zoom || 1)));
    crop.zoom = zoom;
    var drawWidth = imageWidth * baseScale * zoom;
    var drawHeight = imageHeight * baseScale * zoom;
    clampAvatarCrop(crop, canvas, drawWidth, drawHeight);
    var x = (canvas.width - drawWidth) / 2 + crop.offsetX;
    var y = (canvas.height - drawHeight) / 2 + crop.offsetY;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(crop.image, x, y, drawWidth, drawHeight);
    state.pendingAvatarDataUrl = avatarOutputDataUrl(canvas);
    panel.hidden = false;
    if (zoomInput && document.activeElement !== zoomInput) zoomInput.value = String(zoom);
    var preview = qs("profileAvatarPreview");
    if (preview) preview.innerHTML = avatarMarkup(activeAvatarDraft(), "shiplet-avatar-xl");
  }
  function loadAvatarCrop(dataUrl) {
    var image = new Image();
    image.onload = function() {
      state.avatarCrop = {
        image: image,
        zoom: 1,
        offsetX: 0,
        offsetY: 0,
        dragging: false,
        lastX: 0,
        lastY: 0
      };
      state.pendingAvatarPreset = activeAvatarDraft().avatar_preset;
      drawAvatarCrop();
      setStatus("Crop your avatar, then save it.", "info");
    };
    image.onerror = function() {
      clearAvatarCrop();
      state.pendingAvatarDataUrl = undefined;
      setStatus("Could not read that avatar image.", "error");
    };
    image.src = dataUrl;
  }
	  function selectedOrganizationId() {
	    var select = qs("organizationSelect");
	    return select && select.value || state.selectedOrganizationId || detailProject && detailProject.organization_id || "";
	  }
	  function selectedSourceMode() {
	    var selected = document.querySelector('input[name="sourceMode"]:checked');
	    return selected ? selected.value : "upload";
	  }
	  function currentTeams() {
	    return state.teamsByOrganization[selectedOrganizationId()] || [];
	  }
  function currentProjects() {
    var orgId = selectedOrganizationId();
    return state.projects.filter(function(project) { return project.organization_id === orgId; });
  }
  function currentArchivedProjects() {
    var orgId = selectedOrganizationId();
    return (state.archivedProjects || []).filter(function(project) { return project.organization_id === orgId; });
  }
  function slugify(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\\s-]/g, "")
      .replace(/\\s+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
  async function requestJson(path, options) {
    var response = await fetch(path, options || {});
    var text = await response.text();
    var body = text ? (text.charAt(0) === "{" || text.charAt(0) === "[" ? JSON.parse(text) : text) : null;
    if (!response.ok) {
      throw new Error(typeof body === "string" ? body : JSON.stringify(body));
    }
    return body;
  }
  function showError(error, targetId) {
    var message = error && error.message ? error.message : String(error);
    setStatus(message, "error");
    if (targetId && qs(targetId)) {
      qs(targetId).innerHTML = "<div class=\\"banner banner-error\\">" + esc(message) + "</div>";
    }
  }
  async function readFile(file) {
    return new Promise(function(resolve, reject) {
      var reader = new FileReader();
      reader.onload = function() {
        resolve({
          path: file.webkitRelativePath ? file.webkitRelativePath.split("/").slice(1).join("/") || file.name : file.name,
          content: String(reader.result).split(",")[1],
          size: file.size
        });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  async function selectedAssets() {
    var input = qs("fileInput");
    var files = input && input.files ? Array.from(input.files) : [];
    var assets = [];
    for (var i = 0; i < files.length; i++) {
      assets.push(await readFile(files[i]));
    }
    return assets;
  }
  async function loadDashboard() {
    setStatus("Loading workspace...", "info");
    state = Object.assign(state, await requestJson("/api/dashboard"));
    if (detailProject && detailProject.organization_id) {
      state.selectedOrganizationId = detailProject.organization_id;
    }
    var selectedExists = state.organizations.some(function(org) {
      return org.id === state.selectedOrganizationId;
    });
    if ((!state.selectedOrganizationId || !selectedExists) && state.organizations.length > 0) {
      state.selectedOrganizationId = state.organizations[0].id;
    }
    render();
    setStatus(state.organizations.length ? "Workspace ready." : "Create your first shiplet to get started.", state.organizations.length ? "success" : "info");
  }
  async function loadFeedback() {
    if (!detailProject || !qs("feedbackList")) return;
    try {
      var data = await requestJson("/api/projects/" + encodeURIComponent(detailProject.id) + "/review-feedback?includeClosed=true&limit=250");
      state.feedback = data.feedback || [];
      renderFeedback();
    } catch (error) {
      showError(error, "feedbackList");
    }
  }
  function renderArtifactWatch() {
    var button = qs("watchArtifact");
    if (!button) return;
    var watching = !!(state.watch && state.watch.watching);
    button.disabled = !!state.watchLoading;
    button.className = "btn " + (watching ? "btn-primary" : "btn-secondary") + " btn-sm";
    button.textContent = state.watchLoading ? "..." : watching ? "Watching" : "Watch artifact";
    button.setAttribute("aria-pressed", watching ? "true" : "false");
    button.setAttribute("title", watching ? "Stop watching this artifact" : "Watch this artifact");
  }
  async function loadArtifactWatchStatus() {
    if (!detailProject || !qs("watchArtifact")) return;
    try {
      var data = await requestJson("/api/projects/" + encodeURIComponent(detailProject.id) + "/review-watch");
      state.watch = data.watch || { watching: false, source: "none" };
      renderArtifactWatch();
    } catch (error) {
      renderArtifactWatch();
    }
  }
  async function toggleArtifactWatch() {
    if (!detailProject || state.watchLoading) return;
    state.watchLoading = true;
    renderArtifactWatch();
    try {
      var method = state.watch && state.watch.watching ? "DELETE" : "POST";
      var data = await requestJson("/api/projects/" + encodeURIComponent(detailProject.id) + "/review-watch", { method: method });
      state.watch = data.watch || { watching: false, source: "none" };
      setStatus(state.watch.watching ? "Watching artifact updates." : "Artifact updates muted.", "success");
    } catch (error) {
      showError(error);
    } finally {
      state.watchLoading = false;
      renderArtifactWatch();
    }
  }
  function startFeedbackAutoRefresh() {
    if (!detailProject || !qs("feedbackList")) return;
    var refreshTimer = 0;
    window.addEventListener("message", function(event) {
      var data = event.data || {};
      if (data.projectId && data.projectId !== detailProject.id) return;
      if (data.type !== "shiplet:feedback-created" && data.type !== "shiplet:feedback-updated") return;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(loadFeedback, 150);
    });
  }
  function render() {
    renderHeaderAvatar();
    renderProfile();
    renderOrganizations();
    renderOrganizationInvitePermissions();
    renderTeams();
    renderProjects();
	    renderTokens();
	    renderAccountSwitcher();
	    renderSourceMode();
	    renderPublishCapabilities();
	    renderFeedback();
	    renderArtifactWatch();
	  }
  function renderProfile() {
    var section = qs("profileSection");
    if (!section || !state.user) return;
    var draft = activeAvatarDraft();
    var preview = qs("profileAvatarPreview");
    var email = qs("profileEmail");
    var grid = qs("avatarPresetGrid");
    if (preview) preview.innerHTML = avatarMarkup(draft, "shiplet-avatar-xl");
    if (email) email.textContent = state.user.email || "";
    if (!grid) return;
    var activePreset = draft.avatar_preset || "aurora-grid";
    var usingUpload = !!draft.avatar_data_url;
    grid.innerHTML = (state.avatarPresets || []).map(function(preset) {
      var active = !usingUpload && preset.id === activePreset;
      return "<button class=\\"avatar-choice" + (active ? " is-active" : "") + "\\" type=\\"button\\" data-avatar-preset=\\"" + esc(preset.id) + "\\" aria-pressed=\\"" + (active ? "true" : "false") + "\\">" +
        "<span class=\\"shiplet-avatar shiplet-avatar-lg\\" role=\\"img\\" aria-label=\\"" + esc(preset.label) + "\\"><span class=\\"shiplet-avatar-sprite\\" style=\\"" + avatarSpriteStyle(preset.id) + "\\"></span></span>" +
        "<span>" + esc(preset.label) + "</span>" +
      "</button>";
    }).join("");
    if (state.avatarCrop) {
      drawAvatarCrop();
    } else {
      var panel = qs("avatarCropPanel");
      if (panel) panel.hidden = true;
    }
  }
  function canPublishWorkerCode() {
    return !!(state.features && state.features.workerCodePublishing);
  }
	  function renderPublishCapabilities() {
	    var slot = qs("workerCodePublishSlot");
	    var fileInput = qs("fileInput");
	    var enabled = canPublishWorkerCode();
	    if (fileInput) fileInput.required = selectedSourceMode() === "upload" && !enabled;
	    if (!slot) return;
	    if (!enabled) {
	      slot.innerHTML = "";
      return;
    }
    slot.innerHTML =
      "<details>" +
      "<summary>" + "Worker " + "Code" + "</summary>" +
      "<textarea id=\\"scriptContent\\" rows=\\"8\\">export default {\\n" +
      "  async fetch(request, env, ctx) {\\n" +
      "    return new Response(\\"Hello from Shiplet\\", {\\n" +
      "      headers: { \\"content-type\\": \\"text/plain; charset=utf-8\\" }\\n" +
      "    });\\n" +
      "  }\\n" +
      "};</textarea>" +
	      "<small>Worker code requires Workers for Platforms. Static upload is the default path.</small>" +
	      "</details>";
	  }
	  function renderSourceMode() {
	    var mode = selectedSourceMode();
	    ["upload", "external_url", "hosting"].forEach(function(value) {
	      var panel = qs("sourcePanel" + (value === "external_url" ? "Url" : value.charAt(0).toUpperCase() + value.slice(1)));
	      if (panel) panel.hidden = mode !== value;
	    });
	    document.querySelectorAll(".source-choice").forEach(function(choice) {
	      var input = choice.querySelector('input[name="sourceMode"]');
	      choice.classList.toggle("is-active", !!input && input.checked);
	    });
	    var fileInput = qs("fileInput");
	    var externalUrl = qs("externalUrl");
	    if (fileInput) fileInput.required = mode === "upload" && !canPublishWorkerCode();
	    if (externalUrl) externalUrl.required = mode === "external_url";
	  }
	  function renderOrganizations() {
	    var select = qs("organizationSelect");
	    var organizationGroup = qs("organizationSelectGroup");
	    var hideSingleWorkspaceSelect = !!document.querySelector(".shiplet-publish-page");
	    if (organizationGroup) organizationGroup.hidden = hideSingleWorkspaceSelect && state.organizations.length <= 1;
	    if (!select) return;
	    select.innerHTML = state.organizations.map(function(org) {
	      return "<option value=\\"" + esc(org.id) + "\\">" + esc(org.name) + "</option>";
	    }).join("");
    if (state.selectedOrganizationId) select.value = state.selectedOrganizationId;
  }
  function renderOrganizationInvitePermissions() {
    var roleSelect = qs("organizationInviteRole");
    if (!roleSelect) return;
    var canAssignAdmin =
      state.organizationRolesByOrganization[selectedOrganizationId()] === "admin";
    var adminRoleOption = roleSelect.querySelector('option[value="admin"]');
    if (!adminRoleOption) return;
    adminRoleOption.disabled = !canAssignAdmin;
    adminRoleOption.hidden = !canAssignAdmin;
    if (!canAssignAdmin && roleSelect.value === "admin") {
      roleSelect.value = "member";
    }
  }
  function renderTeams() {
    var teams = currentTeams();
    var inviteSelect = qs("teamInviteSelect");
    if (inviteSelect) {
      inviteSelect.innerHTML = teams.map(function(team) {
        return "<option value=\\"" + esc(team.id) + "\\">" + esc(team.name) + "</option>";
      }).join("");
    }
    var shareTeamSelect = qs("shareTeamSelect");
    if (shareTeamSelect) {
      shareTeamSelect.innerHTML = teams.map(function(team) {
        return "<option value=\\"" + esc(team.id) + "\\">" + esc(team.name) + "</option>";
      }).join("");
    }
    var list = qs("teamList");
    if (!list) return;
    if (!teams.length) {
      list.innerHTML = "<div class=\\"banner banner-info\\">No teams yet.</div>";
      return;
    }
    list.innerHTML = "<table class=\\"dataTable\\"><tr><th>Name</th><th>Description</th></tr>" +
      teams.map(function(team) {
        return "<tr><td>" + esc(team.name) + "</td><td>" + esc(team.description || "-") + "</td></tr>";
      }).join("") + "</table>";
  }
  function isShipletsListPage() {
    return !!document.querySelector(".shiplet-list-page");
  }
  function visibilityKey(value) {
    var key = String(value || "organization");
    return ["private", "organization", "unlisted", "public"].indexOf(key) >= 0 ? key : "organization";
  }
  function visibilityLabel(value) {
    var key = visibilityKey(value);
    if (key === "private") return "Private";
    if (key === "unlisted") return "Unlisted";
    if (key === "public") return "Public";
    return "Workspace";
  }
  function sourceTypeLabel(value) {
    if (value === "external_url") return "External URL";
    if (value === "worker") return "Worker";
    return "Static bundle";
  }
  function initialsForProject(project) {
    var source = String(project && (project.name || project.subdomain) || "Comment");
    var words = source.match(/[A-Za-z0-9]+/g) || [];
    if (words.length >= 2) return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return "CM";
  }
  function commentLabelFor(item) {
    if (item && item.ticket_label) return item.ticket_label;
    var number = item && item.ticket_number ? item.ticket_number : "?";
    return "PF-" + number;
  }
  function formatShortDate(value) {
    if (!value) return "Recently";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Recently";
    var currentYear = new Date().getFullYear();
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: date.getFullYear() === currentYear ? undefined : "numeric"
    });
  }
  function shipletSearchQuery() {
    var input = qs("shipletSearch");
    return input ? input.value.trim().toLowerCase() : "";
  }
  function renderShipletsList(projects, list, options) {
    var archived = !!(options && options.archived);
    var metric = qs("shipletMetricCount");
    var metricLabel = qs("shipletMetricLabel");
    var summary = qs("shipletListSummary");
    var query = shipletSearchQuery();
    var filtered = projects.filter(function(project) {
      if (!query) return true;
      var url = baseUrlFor(project.subdomain);
      var visibility = visibilityKey(project.visibility);
      var searchable = [
        project.name,
        project.subdomain,
        url,
        visibility,
        visibilityLabel(visibility),
        sourceTypeLabel(project.source_type),
        archived ? "archived" : ""
      ].join(" ").toLowerCase();
      return searchable.indexOf(query) >= 0;
    });

    if (!archived && metric) metric.textContent = String(projects.length);
    if (!archived && metricLabel) metricLabel.textContent = projects.length === 1 ? "Review artifact" : "Review artifacts";
    if (!archived && summary) {
      if (!projects.length) summary.textContent = "No review artifacts in this workspace yet.";
      else if (query) summary.textContent = filtered.length + " of " + projects.length + " artifacts match.";
      else summary.textContent = "Showing " + projects.length + " artifact" + (projects.length === 1 ? "" : "s") + " in this workspace.";
    }

    if (!projects.length) {
      list.innerHTML = archived
        ? "<div class=\\"shiplet-list-empty\\"><span class=\\"success-card-label\\">Archive</span><strong>No archived shiplets</strong><p>Archived shiplets will appear here during their restore window.</p></div>"
        : "<div class=\\"shiplet-list-empty\\"><span class=\\"success-card-label\\">Clean slate</span><strong>No review artifacts yet</strong><p>Prepare an artifact and it will appear here with its live URL and review bridge.</p><a class=\\"btn btn-primary btn-sm\\" href=\\"/\\">Prepare artifact</a></div>";
      return;
    }
    if (!filtered.length) {
      list.innerHTML = "<div class=\\"shiplet-list-empty\\"><span class=\\"success-card-label\\">No matches</span><strong>Nothing matched that search</strong><p>Try a shiplet name, URL, source type, or visibility setting.</p></div>";
      return;
    }

    list.innerHTML = "<div class=\\"shiplet-list-rows\\">" + filtered.map(function(project) {
      var url = baseUrlFor(project.subdomain);
      var displayUrl = url.replace(/^https?:\\/\\//, "");
      var visibility = visibilityKey(project.visibility);
      var selectCell = archived
        ? "<span class=\\"shiplet-visibility-badge\\" data-visibility=\\"unlisted\\">Archived</span>"
        : "<input class=\\"shiplet-row-checkbox\\" type=\\"checkbox\\" value=\\"" + esc(project.id) + "\\" data-shiplet-select=\\"" + esc(project.id) + "\\" aria-label=\\"Select " + esc(project.name || project.subdomain || "shiplet") + "\\">";
      var lifecycleAction = archived
        ? "<button class=\\"btn btn-primary btn-sm\\" type=\\"button\\" data-restore-shiplet=\\"" + esc(project.id) + "\\">Restore</button>"
        : "<button class=\\"btn btn-secondary btn-sm\\" type=\\"button\\" data-archive-shiplet=\\"" + esc(project.id) + "\\">Archive</button>";
      return "<article class=\\"shiplet-list-row" + (archived ? " is-archived" : "") + "\\" data-shiplet-row=\\"" + esc(project.id) + "\\">" +
        "<div class=\\"shiplet-list-select\\">" + selectCell + "</div>" +
        "<div class=\\"shiplet-list-main\\">" +
          "<a class=\\"shiplet-list-name\\" href=\\"/shiplets/" + esc(project.id) + "\\">" + esc(project.name || project.subdomain || "Untitled shiplet") + "</a>" +
          "<a class=\\"shiplet-list-url\\" target=\\"_blank\\" rel=\\"noreferrer\\" href=\\"" + esc(url) + "\\">" + esc(displayUrl) + "</a>" +
        "</div>" +
        "<div class=\\"shiplet-list-meta\\">" +
          "<span class=\\"shiplet-visibility-badge\\" data-visibility=\\"" + esc(visibility) + "\\">" + esc(visibilityLabel(visibility)) + "</span>" +
          "<span>" + esc(sourceTypeLabel(project.source_type)) + "</span>" +
          "<span>" + (archived ? "Archived " + esc(formatShortDate(project.archived_on)) : "Updated " + esc(formatShortDate(project.modified_on || project.created_on))) + "</span>" +
        "</div>" +
        "<div class=\\"shiplet-list-actions\\">" +
          "<button class=\\"btn btn-secondary btn-sm\\" type=\\"button\\" data-copy-value=\\"" + esc(url) + "\\" aria-label=\\"Copy URL\\" title=\\"Copy URL\\">Copy URL</button>" +
          "<a class=\\"btn btn-secondary btn-sm\\" target=\\"_blank\\" rel=\\"noreferrer\\" href=\\"" + esc(url) + "\\">View live</a>" +
          "<a class=\\"btn btn-primary btn-sm\\" href=\\"/shiplets/" + esc(project.id) + "\\">Open review</a>" +
          lifecycleAction +
        "</div>" +
      "</article>";
    }).join("") + "</div>";
  }
  function renderArchivedShiplets(projects) {
    var section = qs("archivedShipletsSection");
    var summary = qs("archivedShipletsSummary");
    var list = qs("archivedProjectList");
    if (!section || !summary || !list) return;
    section.hidden = projects.length === 0;
    summary.textContent = "Archived shiplets (" + projects.length + ")";
    renderShipletsList(projects, list, { archived: true });
  }
  function renderProjects() {
    var projects = detailProject ? [detailProject] : currentProjects();
    var list = qs("projectList");
    var tokenRuleProjectSelect = qs("tokenRuleProjectSelect");
    var shareSelect = qs("shareProjectSelect");
    if (tokenRuleProjectSelect) {
      tokenRuleProjectSelect.innerHTML = currentProjects().map(function(project) {
        return "<option value=\\"" + esc(project.id) + "\\">" + esc(project.name) + "</option>";
      }).join("");
    }
    if (shareSelect && shareSelect.tagName === "SELECT") {
      shareSelect.innerHTML = projects.map(function(project) {
        return "<option value=\\"" + esc(project.id) + "\\">" + esc(project.name) + "</option>";
      }).join("");
      if (detailProject) shareSelect.value = detailProject.id;
    }
    if (!list) return;
    var listProjects = currentProjects();
    if (isShipletsListPage()) {
      renderShipletsList(listProjects, list);
      renderArchivedShiplets(currentArchivedProjects());
      updateBulkSelectionState();
      return;
    }
    if (!listProjects.length) {
      list.innerHTML = "<div class=\\"banner banner-info\\">No shiplets in this organization yet.</div>";
      return;
    }
    list.innerHTML = "<div class=\\"shiplet-bulk-actions\\"><label class=\\"shiplet-select-all\\" for=\\"shipletSelectAll\\"><input id=\\"shipletSelectAll\\" type=\\"checkbox\\"><span>Select all</span></label><button class=\\"btn btn-secondary btn-sm\\" type=\\"button\\" data-bulk-archive=\\"true\\" disabled>Archive selected</button><span id=\\"shipletBulkSelectionCount\\">0 selected</span></div><table class=\\"dataTable\\"><tr><th></th><th>Name</th><th>URL</th><th>Visibility</th><th>Review</th><th></th></tr>" +
      listProjects.map(function(project) {
        var url = baseUrlFor(project.subdomain);
        return "<tr data-shiplet-row=\\"" + esc(project.id) + "\\"><td><input class=\\"shiplet-row-checkbox\\" type=\\"checkbox\\" value=\\"" + esc(project.id) + "\\" data-shiplet-select=\\"" + esc(project.id) + "\\" aria-label=\\"Select " + esc(project.name) + "\\"></td><td>" + esc(project.name) + "</td><td><a class=\\"table-link\\" target=\\"_blank\\" href=\\"" + esc(url) + "\\">" + esc(url.replace(/^https?:\\/\\//, "")) + "</a></td><td>" + esc(project.visibility || "organization") + "</td><td><a class=\\"table-link\\" href=\\"/shiplets/" + esc(project.id) + "\\">Open review</a></td><td><button class=\\"btn btn-secondary btn-sm\\" type=\\"button\\" data-archive-shiplet=\\"" + esc(project.id) + "\\">Archive</button></td></tr>";
      }).join("") + "</table>";
    updateBulkSelectionState();
  }
  function renderTokens() {
    var tokenList = qs("tokenList");
    if (!tokenList) return;
    var organizationId = selectedOrganizationId();
    var role = state.organizationRolesByOrganization[organizationId] || "";
    var canManageTokens = role === "admin";
    var tokenManagement = qs("tokenManagement");
    var tokenManagementStatus = qs("tokenManagementStatus");
    if (tokenManagement) tokenManagement.hidden = !canManageTokens;
    if (tokenManagementStatus) {
      tokenManagementStatus.hidden = canManageTokens;
      tokenManagementStatus.className = "banner banner-info";
      tokenManagementStatus.textContent = organizationId
        ? "Organization administrator access is required to manage API keys."
        : "Choose an organization to manage API keys.";
    }
    if (!canManageTokens) {
      tokenList.innerHTML = "";
      return;
    }
    var rows = state.apiTokensByOrganization[organizationId] || [];
    if (!rows.length) {
      tokenList.innerHTML = "<div class=\\"banner banner-info\\">No API keys yet.</div>";
      return;
    }
    tokenList.innerHTML = "<table class=\\"dataTable\\"><tr><th>Name</th><th>Scopes</th><th>Project Access</th><th>Status</th><th></th></tr>" +
      rows.map(function(token) {
        var revoked = !!token.revoked_on;
        var ruleText = (token.project_rules || []).map(function(rule) { return rule.effect + ":" + rule.project_id; }).join(", ");
        return "<tr><td>" + esc(token.name) + "</td><td>" + esc((token.scopes || []).join(", ")) + "</td><td>" + esc((token.project_access_mode || "all") + (ruleText ? " (" + ruleText + ")" : "")) + "</td><td>" + (revoked ? "Revoked" : "Active") + "</td><td>" + (revoked ? "" : "<button class=\\"btn btn-secondary btn-sm\\" data-revoke-token=\\"" + esc(token.id) + "\\">Revoke</button>") + "</td></tr>";
	      }).join("") + "</table>";
	  }
	  function renderAccountSwitcher() {
	    var enabled = !!(state.features && state.features.accountEmailSwitching);
	    var nav = qs("accountNav");
	    var section = qs("account");
	    var list = qs("accountList");
	    var addAccountLink = qs("addAccountLink");
	    if (nav) nav.hidden = false;
	    if (section) section.hidden = false;
	    if (addAccountLink) addAccountLink.hidden = !enabled;
	    if (!list) return;
	    var accounts = (state.accountSessions || []).slice();
	    if (!accounts.length) {
	      accounts = [{
	        email: state.user && state.user.email || "Current account",
	        active: true
	      }];
	    }
	    var rows = accounts.map(function(account) {
	      var eyebrow = account.active ? "Current account" : "Available account";
	      var label = account.active ? "<span class=\\"success-card-label\\">Current</span>" : "";
	      var action = "";
	      if (enabled && !account.active && account.session_id) {
	        action = "<form method=\\"POST\\" action=\\"/auth/switch-account\\"><input type=\\"hidden\\" name=\\"session_id\\" value=\\"" + esc(account.session_id) + "\\"><input type=\\"hidden\\" name=\\"return_to\\" value=\\"/account\\"><button class=\\"btn btn-secondary btn-sm\\" type=\\"submit\\">Switch</button></form>";
	      }
	      return "<div class=\\"account-row\\"><div class=\\"account-row-meta\\"><span class=\\"success-card-label\\">" + eyebrow + "</span><strong>" + esc(account.email) + "</strong></div><div class=\\"account-row-actions\\">" + label + action + "</div></div>";
	    }).join("");
	    var note = enabled ? "" : "<div class=\\"banner banner-info\\">Account switching is not enabled in this environment.</div>";
	    list.innerHTML = "<div class=\\"account-list\\">" + rows + note + "</div>";
	  }
	  function renderFeedback() {
	    var list = qs("feedbackList");
	    if (!list) return;
    if (!state.feedback.length) {
      list.innerHTML = "<div class=\\"banner banner-info\\">No comments yet. Open the artifact or add a general comment here.</div>";
      return;
    }
    list.innerHTML = "<div class=\\"feedback-ticket-list\\">" + state.feedback.map(function(item) {
      var replies = (item.replies || []).map(function(reply) {
        return "<div class=\\"feedback-reply\\">" + esc(reply.comment) + "</div>";
      }).join("");
      var statusOptions = ["New", "In Progress", "Blocked", "Done", "Dropped"].map(function(status) {
        return "<option value=\\"" + esc(status) + "\\"" + (item.status === status ? " selected" : "") + ">" + esc(status) + "</option>";
      }).join("");
      var element = item.selected_element && item.selected_element.selector ? item.selected_element.selector : item.pathname || "Page";
      var commentLabel = commentLabelFor(item);
	      var submittedBy = item.submitted_by_email || "Reviewer";
	      var screenshot = item.screenshot_url
	        ? "<button class=\\"feedback-ticket-screenshot\\" type=\\"button\\" data-feedback-screenshot=\\"" + esc(item.screenshot_url) + "\\" aria-label=\\"Open screenshot for " + esc(commentLabel) + "\\"><img src=\\"" + esc(item.screenshot_url) + "\\" alt=\\"Screenshot for " + esc(commentLabel) + "\\" loading=\\"lazy\\"></button>"
	        : (item.screenshot_failure_note ? "<div class=\\"feedback-ticket-screenshot-note\\">" + esc(item.screenshot_failure_note) + "</div>" : "");
      var context = "<details class=\\"feedback-context-details\\"><summary>Context</summary><dl>" +
        "<dt>Target</dt><dd>" + esc(element) + "</dd>" +
        "<dt>Submitted by</dt><dd>" + esc(submittedBy) + "</dd>" +
        "<dt>Path</dt><dd>" + esc(item.pathname || "/") + "</dd>" +
	      "</dl></details>";
	      return "<article class=\\"feedback-ticket\\">" +
	        "<div class=\\"feedback-ticket-header\\"><span class=\\"feedback-ticket-id\\">" + esc(commentLabel) + "</span><select class=\\"feedback-ticket-status-select\\" aria-label=\\"Comment status\\" data-feedback-status=\\"" + esc(item.id) + "\\">" + statusOptions + "</select></div>" +
        "<p style=\\"margin:0;\\">" + esc(item.comment) + "</p>" +
        context +
        screenshot +
        (replies ? "<div class=\\"feedback-reply-list\\">" + replies + "</div>" : "") +
        "<div class=\\"inline-field-row\\"><input data-feedback-reply-input=\\"" + esc(item.id) + "\\" placeholder=\\"Follow up on " + esc(commentLabel) + "\\"><button class=\\"btn btn-secondary btn-sm\\" type=\\"button\\" data-feedback-reply=\\"" + esc(item.id) + "\\">Add follow-up</button></div>" +
      "</article>";
	    }).join("") + "</div>";
	  }
	  function openFeedbackScreenshotLightbox(url, label) {
	    var lightbox = qs("feedbackScreenshotLightbox");
	    var image = qs("feedbackScreenshotLightboxImage");
	    if (!lightbox || !image || !url) return;
	    image.src = url;
	    image.alt = label || "Feedback screenshot";
	    lightbox.hidden = false;
	    lightbox.setAttribute("aria-hidden", "false");
	    var closeButton = lightbox.querySelector("[data-feedback-screenshot-close]");
	    if (closeButton && closeButton.focus) closeButton.focus();
	  }
	  function closeFeedbackScreenshotLightbox() {
	    var lightbox = qs("feedbackScreenshotLightbox");
	    var image = qs("feedbackScreenshotLightboxImage");
	    if (!lightbox) return;
	    lightbox.hidden = true;
	    lightbox.setAttribute("aria-hidden", "true");
	    if (image) image.removeAttribute("src");
	  }
	  function updateShareFields() {
    var targetType = qs("shareTargetType") ? qs("shareTargetType").value : "user";
    if (qs("shareEmailGroup")) qs("shareEmailGroup").style.display = targetType === "user" ? "block" : "none";
    if (qs("shareTeamGroup")) qs("shareTeamGroup").style.display = targetType === "team" ? "block" : "none";
  }
  function selectedShipletIds() {
    return Array.from(document.querySelectorAll("[data-shiplet-select]:checked")).map(function(input) {
      return input.value || input.getAttribute("data-shiplet-select") || "";
    }).filter(Boolean);
  }
  function updateBulkSelectionState() {
    var selected = selectedShipletIds();
    var all = Array.from(document.querySelectorAll("[data-shiplet-select]"));
    var selectAll = qs("shipletSelectAll");
    var button = document.querySelector("[data-bulk-archive]");
    var count = qs("shipletBulkSelectionCount");
    if (selectAll) {
      selectAll.checked = all.length > 0 && selected.length === all.length;
      selectAll.indeterminate = selected.length > 0 && selected.length < all.length;
    }
    if (button) button.disabled = selected.length === 0;
    if (count) count.textContent = selected.length + " selected";
  }
  async function archiveSelectedShiplets() {
    var projectIds = selectedShipletIds();
    if (!projectIds.length) return;
    if (!window.confirm("Archive selected shiplets?")) return;
    await requestJson("/api/projects/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectIds: projectIds })
    });
    setStatus("Archived " + projectIds.length + " shiplet" + (projectIds.length === 1 ? "" : "s") + ".", "success");
    await loadDashboard();
  }
  function showInviteFields() {
    var fields = qs("shipletInviteFields");
    var button = qs("showInviteForm");
    if (fields) fields.hidden = false;
    if (button) button.hidden = true;
    updateShareFields();
  }
  function bindEvents() {
    on("refreshDashboard", "click", loadDashboard);
    on("refreshFeedback", "click", loadFeedback);
    on("showInviteForm", "click", showInviteFields);
    on("shipletSearch", "input", renderProjects);
    on("organizationSelect", "change", function(event) {
      state.selectedOrganizationId = event.target.value;
      render();
      loadFeedback();
    });
    on("shareTargetType", "change", updateShareFields);
    on("archiveShipletForm", "submit", async function(event) {
      event.preventDefault();
      if (!detailProject) return;
      try {
        await requestJson("/api/projects/" + encodeURIComponent(detailProject.id) + "/archive", {
          method: "POST"
        });
        window.location.reload();
      } catch (error) {
        showError(error);
      }
    });
    on("restoreShipletForm", "submit", async function(event) {
      event.preventDefault();
      if (!detailProject) return;
      try {
        await requestJson("/api/projects/" + encodeURIComponent(detailProject.id) + "/restore", {
          method: "POST"
        });
        window.location.reload();
      } catch (error) {
        showError(error);
      }
    });
    on("permanentDeleteShipletForm", "submit", async function(event) {
      event.preventDefault();
      if (!detailProject) return;
      try {
        var input = qs("confirmSubdomain");
        await requestJson("/api/projects/" + encodeURIComponent(detailProject.id), {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmSubdomain: input && input.value.trim() })
        });
        window.location.assign("/shiplets");
      } catch (error) {
        showError(error);
      }
    });
    on("projectName", "input", function(event) {
      var subdomain = qs("subdomain");
      if (subdomain && !subdomain.dataset.touched) subdomain.value = slugify(event.target.value);
    });
	    on("subdomain", "input", function(event) {
	      event.target.dataset.touched = "true";
	    });
	    document.querySelectorAll('input[name="sourceMode"]').forEach(function(input) {
	      input.addEventListener("change", renderSourceMode);
	    });
    on("avatarCropZoom", "input", function(event) {
      if (!state.avatarCrop) return;
      state.avatarCrop.zoom = Number(event.target.value || 1);
      drawAvatarCrop();
    });
    var cropCanvas = qs("avatarCropCanvas");
    if (cropCanvas) {
      cropCanvas.addEventListener("pointerdown", function(event) {
        if (!state.avatarCrop) return;
        event.preventDefault();
        state.avatarCrop.dragging = true;
        state.avatarCrop.lastX = event.clientX;
        state.avatarCrop.lastY = event.clientY;
        if (cropCanvas.setPointerCapture) cropCanvas.setPointerCapture(event.pointerId);
        cropCanvas.classList.add("is-dragging");
      });
      cropCanvas.addEventListener("pointermove", function(event) {
        if (!state.avatarCrop || !state.avatarCrop.dragging) return;
        event.preventDefault();
        var rect = cropCanvas.getBoundingClientRect();
        var scaleX = rect.width ? cropCanvas.width / rect.width : 1;
        var scaleY = rect.height ? cropCanvas.height / rect.height : 1;
        state.avatarCrop.offsetX += (event.clientX - state.avatarCrop.lastX) * scaleX;
        state.avatarCrop.offsetY += (event.clientY - state.avatarCrop.lastY) * scaleY;
        state.avatarCrop.lastX = event.clientX;
        state.avatarCrop.lastY = event.clientY;
        drawAvatarCrop();
      });
      function finishAvatarCropDrag(event) {
        if (!state.avatarCrop) return;
        state.avatarCrop.dragging = false;
        cropCanvas.classList.remove("is-dragging");
        if (cropCanvas.releasePointerCapture) {
          try {
            cropCanvas.releasePointerCapture(event.pointerId);
          } catch (error) {
            // Pointer capture can already be released by the browser.
          }
        }
      }
      cropCanvas.addEventListener("pointerup", finishAvatarCropDrag);
      cropCanvas.addEventListener("pointercancel", finishAvatarCropDrag);
      cropCanvas.addEventListener("pointerleave", finishAvatarCropDrag);
    }
    on("avatarUpload", "change", function(event) {
      var input = event.target;
      var file = input && input.files && input.files[0];
      if (!file) return;
      if (!/^image\\/(png|jpeg|webp)$/.test(file.type)) {
        setStatus("Avatar upload must be a PNG, JPEG, or WebP.", "error");
        input.value = "";
        return;
      }
      if (file.size > MAX_AVATAR_UPLOAD_BYTES) {
        setStatus("Avatar image can be up to 10MB.", "error");
        input.value = "";
        return;
      }
      var reader = new FileReader();
      reader.onload = function() {
        loadAvatarCrop(String(reader.result || ""));
      };
      reader.onerror = function() {
        setStatus("Could not read that avatar image.", "error");
      };
      reader.readAsDataURL(file);
    });
    on("avatarForm", "submit", async function(event) {
      event.preventDefault();
      try {
        var draft = activeAvatarDraft();
        var result = await requestJson("/api/me/avatar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            avatarPreset: draft.avatar_preset,
            avatarDataUrl: draft.avatar_data_url
          })
        });
        state.user = result.user;
        state.avatarPresets = result.avatarPresets || state.avatarPresets;
        state.pendingAvatarPreset = "";
        state.pendingAvatarDataUrl = undefined;
        clearAvatarCrop();
        renderProfile();
        renderHeaderAvatar();
        setStatus("Avatar updated.", "success");
      } catch (error) {
        showError(error);
      }
    });
	    on("organizationForm", "submit", async function(event) {
      event.preventDefault();
      try {
        var name = qs("organizationName").value.trim();
        if (!name) return;
        var result = await requestJson("/api/organizations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name })
        });
        state.selectedOrganizationId = result.organization.id;
        qs("organizationName").value = "";
        await loadDashboard();
      } catch (error) {
        showError(error);
      }
    });
    on("teamForm", "submit", async function(event) {
      event.preventDefault();
      try {
        var orgId = selectedOrganizationId();
        var name = qs("teamName").value.trim();
        if (!orgId || !name) return;
        await requestJson("/api/organizations/" + encodeURIComponent(orgId) + "/teams", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name, description: qs("teamDescription").value.trim() })
        });
        qs("teamName").value = "";
        qs("teamDescription").value = "";
        await loadDashboard();
      } catch (error) {
        showError(error);
      }
    });
    on("organizationInviteForm", "submit", async function(event) {
      event.preventDefault();
      try {
        var orgId = selectedOrganizationId();
        var email = qs("organizationInviteEmail").value.trim();
        if (!orgId || !email) return;
        await requestJson("/api/organizations/" + encodeURIComponent(orgId) + "/invitations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email, role: qs("organizationInviteRole").value })
        });
        qs("organizationInviteEmail").value = "";
        setStatus("Organization invitation sent.", "success");
      } catch (error) {
        showError(error);
      }
    });
    on("teamInviteForm", "submit", async function(event) {
      event.preventDefault();
      try {
        var orgId = selectedOrganizationId();
        var teamId = qs("teamInviteSelect").value;
        var email = qs("teamInviteEmail").value.trim();
        if (!orgId || !teamId || !email) return;
        await requestJson("/api/organizations/" + encodeURIComponent(orgId) + "/teams/" + encodeURIComponent(teamId) + "/invitations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email })
        });
        qs("teamInviteEmail").value = "";
        setStatus("Team invitation sent.", "success");
      } catch (error) {
        showError(error);
      }
    });
    on("bridgeCommentForm", "submit", async function(event) {
      event.preventDefault();
      try {
        if (!detailProject) return;
        var input = qs("bridgeComment");
        var comment = input && input.value.trim();
        if (!comment) return;
        var pageUrl = window.location.origin + "/shiplets/" + encodeURIComponent(detailProject.id);
        await requestJson("/api/projects/" + encodeURIComponent(detailProject.id) + "/review-feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comment: comment,
            pageUrl: pageUrl,
            clientFeedbackId: "bridge-" + Date.now() + "-" + Math.random().toString(36).slice(2),
            screenshotMode: "page"
          })
        });
        input.value = "";
        await loadFeedback();
      } catch (error) {
        showError(error, "feedbackList");
      }
    });
    on("watchArtifact", "click", function() {
      toggleArtifactWatch();
    });
    on("projectForm", "submit", async function(event) {
      event.preventDefault();
      try {
	        qs("publishResult").innerHTML = "<div class=\\"banner banner-info\\">Creating shiplet...</div>";
	        var assets = await selectedAssets();
	        var sourceMode = selectedSourceMode();
	        var payload = {
	          name: qs("projectName").value.trim(),
	          organization_id: selectedOrganizationId(),
	          subdomain: qs("subdomain").value.trim(),
	          visibility: qs("visibility").value
	        };
	        if (sourceMode === "external_url") {
	          payload.external_url = qs("externalUrl").value.trim();
	          if (!payload.external_url) throw new Error("Paste a URL before creating the shiplet.");
	        } else if (sourceMode === "hosting") {
	          throw new Error("Use API or MCP from agents and CI today, or switch to Upload files to create a shiplet by hand.");
	        } else if (assets.length > 0) payload.assets = assets;
	        else if (canPublishWorkerCode() && qs("scriptContent")) payload.script_content = qs("scriptContent").value;
	        else throw new Error("Choose a build, file, or URL before creating the shiplet.");
        var result = await requestJson("/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        window.location.assign(result.launchUrl || ("/shiplets/" + encodeURIComponent(result.project.id) + "?created=1"));
      } catch (error) {
        showError(error, "publishResult");
      }
    });
    on("shipletShareForm", "submit", async function(event) {
      event.preventDefault();
      try {
        var projectId = qs("shareProjectSelect").value;
        var targetType = qs("shareTargetType").value;
        if (!projectId) return;
        var payload = {
          targetType: targetType,
          role: qs("shareRole").value
        };
        if (targetType === "organization") {
          payload.organizationId = selectedOrganizationId();
        } else if (targetType === "team") {
          payload.teamId = qs("shareTeamSelect").value;
          if (!payload.teamId) return;
        } else {
          payload.email = qs("shareEmail").value.trim();
          if (!payload.email) return;
        }
        await requestJson("/api/projects/" + encodeURIComponent(projectId) + "/invitations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (qs("shareEmail")) qs("shareEmail").value = "";
        if (qs("shareResult")) qs("shareResult").innerHTML = "<div class=\\"banner banner-success\\">Invite sent. The reviewer can open the shared shiplet and leave feedback.</div>";
        setStatus("Shiplet access updated.", "success");
      } catch (error) {
        showError(error, "shareResult");
      }
    });
    on("tokenForm", "submit", async function(event) {
      event.preventDefault();
      try {
        var orgId = selectedOrganizationId();
        if (!orgId) return;
        var accessMode = qs("tokenProjectAccessMode").value;
        var selectedProjects = Array.from(qs("tokenRuleProjectSelect").selectedOptions || []).map(function(option) { return option.value; });
        var scopes = Array.from(document.querySelectorAll('input[name="tokenScope"]:checked')).map(function(input) { return input.value; });
        var projectRules = selectedProjects.map(function(projectId) {
          return {
            projectId: projectId,
            effect: accessMode === "selected" ? "allow" : "deny"
          };
        });
        var result = await requestJson("/api/organizations/" + encodeURIComponent(orgId) + "/api-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: qs("tokenName").value.trim() || "Local Agent",
            scopes: scopes,
            projectAccessMode: accessMode === "selected" ? "selected" : "all",
            projectRules: accessMode === "all" ? [] : projectRules
          })
        });
        qs("tokenResult").innerHTML = "<div class=\\"banner banner-warning\\"><div><strong>Copy this token now.</strong><br><code>" + esc(result.token) + "</code></div></div>";
        qs("tokenName").value = "";
        await loadDashboard();
      } catch (error) {
        showError(error, "tokenResult");
      }
    });
    document.addEventListener("click", async function(event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var avatarButton = target.closest("[data-avatar-preset]");
      if (avatarButton) {
        state.pendingAvatarPreset = avatarButton.getAttribute("data-avatar-preset") || "aurora-grid";
        state.pendingAvatarDataUrl = null;
        clearAvatarCrop();
        var upload = qs("avatarUpload");
        if (upload) upload.value = "";
        renderProfile();
        return;
      }
      var bulkArchiveButton = target.closest("[data-bulk-archive]");
      if (bulkArchiveButton) {
        try {
          await archiveSelectedShiplets();
        } catch (error) {
          showError(error);
        }
        return;
      }
      var archiveButton = target.closest("[data-archive-shiplet]");
      if (archiveButton) {
        try {
          await requestJson("/api/projects/" + encodeURIComponent(archiveButton.getAttribute("data-archive-shiplet") || "") + "/archive", {
            method: "POST"
          });
          setStatus("Shiplet archived.", "success");
          await loadDashboard();
        } catch (error) {
          showError(error);
        }
        return;
      }
	      var restoreButton = target.closest("[data-restore-shiplet]");
	      if (restoreButton) {
	        try {
          await requestJson("/api/projects/" + encodeURIComponent(restoreButton.getAttribute("data-restore-shiplet") || "") + "/restore", {
            method: "POST"
          });
          setStatus("Shiplet restored.", "success");
          await loadDashboard();
        } catch (error) {
          showError(error);
        }
	        return;
	      }
	      var screenshotButton = target.closest("[data-feedback-screenshot]");
	      if (screenshotButton) {
	        event.preventDefault();
	        openFeedbackScreenshotLightbox(
	          screenshotButton.getAttribute("data-feedback-screenshot") || "",
	          screenshotButton.getAttribute("aria-label") || "Feedback screenshot"
	        );
	        return;
	      }
	      if (target.closest("[data-feedback-screenshot-close]") || target.id === "feedbackScreenshotLightbox") {
	        closeFeedbackScreenshotLightbox();
	        return;
	      }
	      if (!target.dataset) return;
	      if (target.dataset.revokeToken) {
        try {
          var orgId = selectedOrganizationId();
          await requestJson("/api/organizations/" + encodeURIComponent(orgId) + "/api-tokens/" + encodeURIComponent(target.dataset.revokeToken), {
            method: "DELETE"
          });
          await loadDashboard();
        } catch (error) {
          showError(error);
        }
      }
      if (target.dataset.feedbackReply && detailProject) {
        try {
          var input = document.querySelector("[data-feedback-reply-input='" + CSS.escape(target.dataset.feedbackReply) + "']");
          var comment = input && input.value.trim();
          if (!comment) return;
          await requestJson("/api/projects/" + encodeURIComponent(detailProject.id) + "/review-feedback/" + encodeURIComponent(target.dataset.feedbackReply) + "/replies", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ comment: comment })
          });
          await loadFeedback();
        } catch (error) {
          showError(error, "feedbackList");
        }
	      }
	    });
	    document.addEventListener("keydown", function(event) {
	      if (event.key === "Escape") closeFeedbackScreenshotLightbox();
	    });
	    document.addEventListener("change", async function(event) {
      var target = event.target;
      if (target && target.id === "shipletSelectAll") {
        var checked = !!target.checked;
        document.querySelectorAll("[data-shiplet-select]").forEach(function(input) {
          input.checked = checked;
        });
        updateBulkSelectionState();
        return;
      }
      if (target && target.matches && target.matches("[data-shiplet-select]")) {
        updateBulkSelectionState();
        return;
      }
      if (!target || !target.dataset || !target.dataset.feedbackStatus || !detailProject) return;
      try {
        await requestJson("/api/projects/" + encodeURIComponent(detailProject.id) + "/review-feedback/" + encodeURIComponent(target.dataset.feedbackStatus) + "/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: target.value })
        });
        await loadFeedback();
      } catch (error) {
        showError(error, "feedbackList");
      }
    });
  }
  document.addEventListener("DOMContentLoaded", function() {
    bindEvents();
    updateShareFields();
    startFeedbackAutoRefresh();
    loadArtifactWatchStatus();
    loadDashboard().then(loadFeedback).catch(function(error) {
      setStatus(error.message || String(error), "error");
    });
  });
})();
</script>
`;

export function BuildSandboxPlayPage(
	snapshot: SandboxSnapshot,
	nonce: KernelDocumentNonce,
) {
	const firstShiplet = snapshot.shiplets[0];
	const previewUrl = firstShiplet?.previewUrl || "";
	const mcpUrl = snapshot.session.mcpUrl;
	const feedbackCount = snapshot.feedback.length;
	const snapshotJson = scriptJson(snapshot);
	const resetButton = snapshot.session.resetUrl
		? `<button class="btn btn-secondary" type="button" id="sandboxReset">Reset sandbox</button>`
		: "";
	const sessionDescription = snapshot.session.shared
		? "Everyone visiting this public sandbox shares the same live room. Leave a comment and other unauthenticated visitors can see the ticket stream update."
		: "This state is disposable and isolated from production organizations.";

  return `
<div class="sandbox-playground dashboard-shell shiplet-dashboard-stage">
  <section class="hero-panel shiplet-panel" style="--ri: 0;">
    <div class="hero-copy">
      <span class="success-card-label">Playground</span>
      <h1>Try Shiplet in a sandbox</h1>
      <p>Open a review artifact, leave feedback, and pull the comments through MCP. No WorkOS account, no real API key, no setup tax.</p>
      <div class="dashboard-actions">
        <a class="btn btn-primary" href="${escapeHtml(previewUrl)}" target="_blank" rel="noreferrer">Open artifact</a>
        ${resetButton}
      </div>
    </div>
    <div class="hero-scene" aria-hidden="true">${HARBOR_SCENE_SVG}</div>
  </section>

  <div class="review-command-grid">
    <section class="artifact-preview-shell shiplet-panel" style="--ri: 1;">
      <div class="dashboard-section-header" style="margin-bottom: 12px;">
        <div>
          <span class="success-card-label">Live demo shiplet</span>
          <h2 id="sandboxShipletName">${escapeHtml(firstShiplet?.name || "Sandbox shiplet")}</h2>
          <p>Use the review button inside the artifact. Feedback writes into this anonymous Durable Object session.</p>
        </div>
        <a id="sandboxOpenPreview" class="btn btn-secondary btn-sm" href="${escapeHtml(previewUrl)}" target="_blank" rel="noreferrer">Open URL</a>
      </div>
      <iframe id="sandboxPreviewFrame" class="artifact-preview-frame" src="${escapeHtml(previewUrl)}" title="Sandbox preview"></iframe>
    </section>

    <aside class="review-side-stack">
      <section class="success-card shiplet-panel" style="--ri: 2;">
        <span class="success-card-label">Session</span>
        <h2>Anonymous workspace</h2>
        <p>${escapeHtml(sessionDescription)}</p>
        <div class="banner banner-info" style="margin-top: 12px;">
          <div><strong>Session</strong><br><code id="sandboxSessionId">${escapeHtml(snapshot.session.id)}</code></div>
        </div>
      </section>

      <section class="success-card shiplet-panel" style="--ri: 3;">
        <div class="dashboard-section-header">
          <div>
            <span class="success-card-label">Manifest</span>
            <h2>Feedback</h2>
            <p><span id="sandboxFeedbackCount">${feedbackCount}</span> comment${feedbackCount === 1 ? "" : "s"} in this sandbox.</p>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" id="sandboxRefresh">Refresh</button>
        </div>
        <div id="sandboxFeedbackList" class="feedback-ticket-list" style="margin-top: 12px;"></div>
      </section>

      <section class="success-card shiplet-panel" style="--ri: 4;">
        <span class="success-card-label">Agent handoff</span>
        <h2>Sandbox MCP</h2>
        <p>Point an agent at this endpoint and call <code>search</code> or <code>execute</code>. It mutates only this sandbox.</p>
        ${BuildMcpEndpointCopy({ endpoint: mcpUrl, id: "sandboxMcpUrl" })}
        <code class="mcp-code-block">await codemode.request({
  method: "GET",
  path: "/api/shiplets"
})</code>
      </section>
    </aside>
  </div>
</div>
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(nonce)}>
window.SHIPLET_SANDBOX = ${snapshotJson};
(function() {
  var state = window.SHIPLET_SANDBOX;
  function qs(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function prettyJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (error) {
      return "{}";
    }
  }
  function feedbackLabel(item) {
    return item && item.ticket_label ? item.ticket_label : "PF-" + (item && item.ticket_number ? item.ticket_number : "?");
  }
  function feedbackScreenshotHtml(item, label) {
    if (item.screenshot_url) {
      return "<div class='feedback-ticket-screenshot feedback-manifest-screenshot' data-feedback-screenshot='" + esc(item.screenshot_url) + "' aria-label='Screenshot for " + esc(label) + "'><img src='" + esc(item.screenshot_url) + "' alt='Screenshot for " + esc(label) + "' loading='eager'></div>";
    }
    if (item.screenshot_failure_note) {
      return "<div class='feedback-ticket-screenshot-note'>" + esc(item.screenshot_failure_note) + "</div>";
    }
    return "<div class='feedback-ticket-screenshot-note'>No screenshot captured for this comment.</div>";
  }
  function feedbackDeveloperContextHtml(item) {
    var label = feedbackLabel(item);
    var selected = item.selected_element || {};
    var target = selected.selector || item.pathname || "Page";
    var submittedBy = item.submitted_by_email || item.name || "Reviewer";
    return "<details class='feedback-context-details feedback-manifest-developer-context'><summary>Developer context</summary>" +
      "<div class='feedback-manifest-developer-body'>" +
        feedbackScreenshotHtml(item, label) +
        "<dl>" +
          "<dt>Target</dt><dd>" + esc(target) + "</dd>" +
          "<dt>Submitted by</dt><dd>" + esc(submittedBy) + "</dd>" +
          "<dt>Path</dt><dd>" + esc(item.pathname || "/") + "</dd>" +
          "<dt>Mode</dt><dd>" + esc(item.screenshot_mode || "page") + "</dd>" +
        "</dl>" +
        "<div><strong class='success-card-label'>Full response</strong><pre class='feedback-manifest-response'><code>" + esc(prettyJson({ feedback: item })) + "</code></pre></div>" +
      "</div></details>";
  }
  function renderFeedback() {
    var list = qs("sandboxFeedbackList");
    if (!list) return;
    var items = state.feedback || [];
    qs("sandboxFeedbackCount").textContent = String(items.length);
    list.innerHTML = items.length
      ? items.map(function(item) {
          var label = feedbackLabel(item);
          return "<article class='feedback-ticket'><div class='feedback-ticket-header'><span class='feedback-ticket-id'>" +
            esc(label) + "</span><span class='success-card-label'>" + esc(item.status) +
            "</span></div><p style='margin:0;'>" + esc(item.comment) + "</p>" +
            feedbackDeveloperContextHtml(item) + "</article>";
        }).join("")
      : "<div class='empty-state'>No feedback yet. Open the artifact and use the Review button.</div>";
  }
  function sessionPath(path) {
    var id = state && state.session && state.session.id;
    return id ? path + "?session=" + encodeURIComponent(id) : path;
  }
  async function refresh() {
    var response = await fetch(sessionPath("/api/play/session"), { credentials: "include" });
    if (!response.ok) return;
    state = await response.json();
    window.SHIPLET_SANDBOX = state;
    renderFeedback();
  }
  async function reset() {
    if (!state.session || !state.session.resetUrl) return;
    var response = await fetch(state.session.resetUrl, { method: "POST", credentials: "include" });
    if (!response.ok) return;
    state = await response.json();
    window.SHIPLET_SANDBOX = state;
    var first = state.shiplets && state.shiplets[0];
    if (first) {
      qs("sandboxPreviewFrame").src = first.previewUrl;
      qs("sandboxOpenPreview").href = first.previewUrl;
      qs("sandboxShipletName").textContent = first.name;
    }
    renderFeedback();
  }
  window.addEventListener("message", function(event) {
    if (event && event.data && /^shiplet:feedback-/.test(event.data.type || "")) refresh();
  });
  var refreshButton = qs("sandboxRefresh");
  var resetButton = qs("sandboxReset");
  if (refreshButton) refreshButton.addEventListener("click", refresh);
  if (resetButton) resetButton.addEventListener("click", reset);
  renderFeedback();
})();
</script>
`;
}

export const BuildWebsitePage = (nonce: KernelDocumentNonce) => `
<div class="dashboard-shell shiplet-dashboard-stage shiplet-publish-page">
  <header class="app-page-topbar">
    <div class="app-page-title">
      <span class="success-card-label">Shiplet</span>
      <h1>Create a shiplet</h1>
      <p>Upload a build or file, or paste a public URL. Add access controls, contextual feedback, and agent handoff to the shiplet.</p>
    </div>
    <div class="url-tag" aria-hidden="true">
      <span class="url-tag-hole"></span>
      <code id="urlTagText">your-shiplet</code>
    </div>
  </header>

	  <section class="success-card shiplet-panel shiplet-focus-strip publish-primary-panel">
	    <form id="projectForm" class="publish-layout voyage">
	      <div class="source-choice-grid" aria-label="Choose shiplet source">
	        <label class="source-choice is-active" for="sourceModeUpload">
	          <input type="radio" id="sourceModeUpload" name="sourceMode" value="upload" checked>
	          <span class="source-choice-title">Upload files</span>
	          <span class="source-choice-copy">Select supported files, including static exports, images, video, audio, PDFs, code, data, and GIS files.</span>
	        </label>
	        <label class="source-choice" for="sourceModeUrl">
	          <input type="radio" id="sourceModeUrl" name="sourceMode" value="external_url">
	          <span class="source-choice-title">URL</span>
	          <span class="source-choice-copy">Attach a staging page, PR deployment, hosted report, or public URL.</span>
	        </label>
	        <label class="source-choice" for="sourceModeHosting">
	          <input type="radio" id="sourceModeHosting" name="sourceMode" value="hosting">
	          <span class="source-choice-title">Agent or CI</span>
	          <span class="source-choice-copy">Use API/MCP from agents, CLIs, CI jobs, and local scripts after build.</span>
	        </label>
	      </div>
	      <div class="voyage-step" data-step="1">
	        <div class="voyage-rail">
	          <span class="voyage-bollard" aria-hidden="true">01</span>
          <span class="voyage-flag" aria-hidden="true">${PENNANT_SVG}</span>
	        </div>
	        <div class="voyage-body">
	          <h2 class="voyage-title"><span class="voyage-num">STEP 01</span> Choose the source</h2>
	          <p class="voyage-hint">Upload a build output, static export, or standalone file, or attach a URL.</p>
	          <div id="sourcePanelUpload">
	            <label class="shiplet-upload-dropzone" for="fileInput" data-upload-dropzone>
	              <span class="dropzone-glyph" aria-hidden="true"><svg viewBox="0 0 64 44" aria-hidden="true" focusable="false" shape-rendering="geometricPrecision" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path class="draw-path" style="--di:1" d="M8 30h48l-9 12H17z" pathLength="1"/><path class="draw-path" style="--di:2" d="M22 22h9v8m4-8h9v8" pathLength="1"/><path class="draw-path" style="--di:3" d="M32 22V6m2 1l12 4.5L34 16" pathLength="1"/></svg></span>
	              <strong>Upload a build or file</strong>
	              <span>Drop static folders or standalone files here.</span>
	              <input type="file" id="fileInput" multiple required>
	            </label>
	          </div>
	          <div id="sourcePanelUrl" hidden>
	            <div class="form-group">
	              <label for="externalUrl">URL</label>
	              <input type="url" id="externalUrl" placeholder="https://my-app-git-feature.vercel.app">
	            </div>
	          </div>
	          <div id="sourcePanelHosting" hidden>
	            <div class="banner banner-info">
	              Agent and CI automation use the Shiplet API or MCP today. Use this form when you want to create a shiplet by hand.
	            </div>
	          </div>
	        </div>
	      </div>

      <div class="voyage-step" data-step="2">
        <div class="voyage-rail">
          <span class="voyage-bollard" aria-hidden="true">02</span>
          <span class="voyage-flag" aria-hidden="true">${PENNANT_SVG}</span>
        </div>
        <div class="voyage-body">
          <h2 class="voyage-title"><span class="voyage-num">STEP 02</span> Set review access</h2>
          <p class="voyage-hint">Name the shiplet, choose its address, and decide who can open it.</p>
          <div class="publish-fields-grid">
            <div class="form-group">
              <label for="projectName">Shiplet name</label>
              <input type="text" id="projectName" required placeholder="Sprint planning report">
            </div>
            <div class="form-group">
              <label for="subdomain">Shiplet address</label>
              <div class="domain-input-group">
                <input type="text" id="subdomain" required placeholder="sprint-planning-report" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" aria-describedby="subdomainSuffix">
                <span class="domain-input-suffix" id="subdomainSuffix">.shiplet.cc</span>
              </div>
            </div>
            <div class="form-group" id="organizationSelectGroup" hidden>
              <label for="organizationSelect">Workspace</label>
              <select id="organizationSelect"></select>
            </div>
            <div class="form-group">
              <label for="visibility">Visibility</label>
              <select id="visibility">
                <option value="organization">Organization</option>
                <option value="private">Private</option>
                <option value="unlisted">Unlisted</option>
                <option value="public">Public</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <div class="voyage-step" data-step="3">
        <div class="voyage-rail">
          <span class="voyage-bollard" aria-hidden="true">03</span>
          <span class="voyage-flag" aria-hidden="true">${PENNANT_SVG}</span>
        </div>
        <div class="voyage-body">
          <h2 class="voyage-title"><span class="voyage-num">STEP 03</span> Open review</h2>
          <p class="voyage-hint">Your shiplet includes comments, invites, and agent handoff.</p>
          <div id="workerCodePublishSlot"></div>
          <button type="submit" class="btn btn-primary btn-lg btn-launch">
            <span class="btn-pennant" aria-hidden="true">${PENNANT_SVG}</span>
            Create shiplet
          </button>
        </div>
      </div>
    </form>
    <div id="publishResult" class="result-slot"></div>
  </section>

  <section class="success-card shiplet-panel">
    <div class="dashboard-section-header">
      <div>
        <span class="success-card-label">Review loop</span>
        <h2>What reviewers get</h2>
        <p>Reviewers open the shared work, comment in context, and send agent-ready tickets back to your queue.</p>
      </div>
      <div class="dashboard-actions">
        <button type="button" class="btn btn-secondary btn-sm" id="refreshDashboard">Refresh</button>
        <a class="btn btn-secondary btn-sm" href="/workspace"><span>Workspace</span></a>
      </div>
    </div>
    <div id="dashboardStatus" class="banner banner-info" style="margin-top: 14px;">Loading workspace...</div>
  </section>
</div>
${DashboardRuntimeScript(nonce)}
`;

export const BuildShipletsListPage = (nonce: KernelDocumentNonce) => `
<div class="dashboard-shell shiplet-dashboard-stage shiplet-list-page">
  <header class="app-page-topbar">
    <div class="app-page-title">
      <span class="success-card-label">Harbor ledger</span>
      <h1>All shiplets</h1>
      <p>Open live artifacts and review bridges for the active workspace.</p>
    </div>
    <div class="dashboard-actions">
      <a class="btn btn-primary btn-sm" href="/">Prepare artifact</a>
      <a class="btn btn-secondary btn-sm" href="/access">Access</a>
    </div>
  </header>

  <section class="success-card shiplet-panel shiplet-list-shell" id="shiplets">
    <div class="shiplet-list-head">
      <div>
        <span class="success-card-label">Workspace</span>
        <h2>${glyph("tag", "section-glyph")}Shiplets</h2>
        <p>Find the live artifact, copy its URL, or jump into the review bridge without leaving the workspace.</p>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" id="refreshDashboard">Refresh</button>
    </div>
    <div class="shiplet-list-toolbar">
      <div class="shiplet-list-metric" aria-live="polite">
        <strong id="shipletMetricCount">0</strong>
        <span id="shipletMetricLabel">Review artifacts</span>
      </div>
      <div class="shiplet-list-controls">
        <div class="shiplet-list-control" id="organizationSelectGroup">
          <label for="organizationSelect">Workspace</label>
          <select id="organizationSelect"></select>
        </div>
        <label class="shiplet-list-control shiplet-list-search" for="shipletSearch">
          <span>Search</span>
          <input id="shipletSearch" type="search" autocomplete="off" placeholder="Name, URL, visibility">
        </label>
      </div>
    </div>
    <div id="dashboardStatus" class="banner banner-info">Loading workspace...</div>
    <div id="shipletListSummary" class="shiplet-list-summary">Loading shiplets...</div>
    <div id="projectList" class="shiplet-list-grid" aria-live="polite"></div>
  </section>
</div>
${DashboardRuntimeScript(nonce)}
`;

export const BuildSettingsPage = (nonce: KernelDocumentNonce) => `
<div class="dashboard-shell shiplet-dashboard-stage">
  <header class="app-page-topbar">
    <div class="app-page-title">
      <span class="success-card-label">Harbor office</span>
      <h1>Workspace settings</h1>
      <p>Organizations, teams, sharing rules, and agent access — the ledger behind the pier.</p>
    </div>
    <div class="dashboard-actions">
      <a class="btn btn-secondary btn-sm" href="/">Prepare</a>
      <a class="btn btn-secondary btn-sm" href="/auth/logout">Sign out</a>
    </div>
  </header>

  <div class="settings-layout">
    <nav class="settings-nav" aria-label="Settings sections">
      <a href="#profile">${glyph("tag")}Profile</a>
      <a href="#account" id="accountNav">${glyph("tag")}Accounts</a>
      <a href="#workspace">${glyph("flag")}Workspace</a>
      <a href="#teams">${glyph("knot")}Teams</a>
      <a href="#shiplets">${glyph("tag")}Shiplets</a>
      <a href="#agents">${glyph("plug")}Agents</a>
    </nav>

    <div class="settings-stack">
      <section class="success-card shiplet-panel shiplet-focus-strip" id="profileSection">
        <div class="dashboard-section-header">
          <div>
            <span class="success-card-label">Signal flag</span>
            <h2>${glyph("tag", "section-glyph")}Profile</h2>
            <p>Choose the object avatar reviewers will see on your feedback bubbles.</p>
          </div>
        </div>
        <form id="avatarForm" style="margin-top: 12px;">
          <div class="avatar-profile-summary">
            <div id="profileAvatarPreview">${renderAvatar(null, { className: "shiplet-avatar-xl", label: "Profile avatar" })}</div>
            <div class="avatar-profile-copy">
              <strong id="profileEmail">Loading account...</strong>
              <span class="form-help">Preset objects are fastest. Uploads are private to your Shiplet account.</span>
            </div>
          </div>
          <div class="avatar-picker-grid" id="avatarPresetGrid" aria-label="Avatar presets">
            ${BuildAvatarPresetButtons()}
          </div>
          <div class="avatar-upload-grid">
            <div class="form-group avatar-upload-field">
              <label for="avatarUpload">Upload avatar</label>
              <input id="avatarUpload" type="file" accept="image/png,image/jpeg,image/webp">
              <span class="form-help">PNG, JPEG, or WebP up to 10MB. Crop before saving; Shiplet stores an optimized square.</span>
            </div>
            <div id="avatarCropPanel" class="avatar-crop-panel" hidden>
              <div class="avatar-crop-stage">
                <canvas id="avatarCropCanvas" width="512" height="512" aria-label="Avatar crop preview"></canvas>
              </div>
              <div class="form-group avatar-crop-control">
                <label for="avatarCropZoom">Crop zoom</label>
                <input id="avatarCropZoom" type="range" min="1" max="3" step="0.01" value="1">
                <span class="form-help">Drag the image to position it. Avatar image can be up to 10MB.</span>
              </div>
            </div>
            <button class="btn btn-primary btn-sm" type="submit">Save Avatar</button>
          </div>
        </form>
      </section>

      <section class="success-card shiplet-panel shiplet-focus-strip" id="account">
        <div class="dashboard-section-header">
          <div>
            <span class="success-card-label">Identity</span>
            <h2>${glyph("tag", "section-glyph")}Accounts</h2>
            <p>Keep multiple Shiplet emails available in this browser and choose the active account explicitly.</p>
          </div>
          <a class="btn btn-secondary btn-sm" id="addAccountLink" href="/auth/login?account_action=add&return_to=%2Faccount">Add account</a>
        </div>
        <div id="accountList" class="dataContainer" style="margin-top: 14px;"></div>
      </section>

      <section class="success-card shiplet-panel shiplet-focus-strip" id="workspace">
        <div class="dashboard-section-header">
          <div>
            <span class="success-card-label">Workspace</span>
            <h2>${glyph("flag", "section-glyph")}Organizations</h2>
            <p>Choose the active organization or invite collaborators into the current workspace.</p>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" id="refreshDashboard">Refresh</button>
        </div>
        <div id="dashboardStatus" class="banner banner-info" style="margin-top: 14px;">Loading workspace...</div>
        <form id="organizationForm" class="form-group" style="margin-top: 16px;">
          <label for="organizationName">New organization</label>
          <div class="inline-field-row">
            <input id="organizationName" name="organizationName" type="text" placeholder="Acme Studio">
            <button class="btn btn-primary btn-sm" type="submit">Create</button>
          </div>
        </form>
        <div class="form-group" style="margin-top: 14px;">
          <label for="organizationSelect">Active organization</label>
          <select id="organizationSelect"></select>
        </div>
        <form id="organizationInviteForm" class="settings-form-grid" style="margin-top: 16px;">
          <div class="form-group">
            <label for="organizationInviteEmail">Invite to organization</label>
            <input id="organizationInviteEmail" type="email" placeholder="teammate@example.com">
          </div>
          <div class="form-group">
            <label for="organizationInviteRole">Role</label>
            <select id="organizationInviteRole">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <button class="btn btn-secondary btn-sm" type="submit">Send Org Invite</button>
        </form>
      </section>

      <section class="success-card shiplet-panel" id="teams">
        <span class="success-card-label">Crews</span>
        <h2>${glyph("knot", "section-glyph")}Teams</h2>
        <form id="teamForm" class="settings-form-grid" style="margin-top: 12px;">
          <div class="form-group">
            <label for="teamName">Team name</label>
            <input id="teamName" name="teamName" type="text" placeholder="Design Review">
          </div>
          <div class="form-group">
            <label for="teamDescription">Description</label>
            <input id="teamDescription" name="teamDescription" type="text" placeholder="Optional description">
          </div>
          <button class="btn btn-secondary btn-sm" type="submit">Create Team</button>
        </form>
        <form id="teamInviteForm" class="settings-form-grid" style="margin-top: 16px;">
          <div class="form-group">
            <label for="teamInviteSelect">Invite to team</label>
            <select id="teamInviteSelect"></select>
          </div>
          <div class="form-group">
            <label for="teamInviteEmail">Email</label>
            <input id="teamInviteEmail" type="email" placeholder="teammate@example.com">
          </div>
          <button class="btn btn-secondary btn-sm" type="submit">Send Invite</button>
        </form>
        <div id="teamList" class="dataContainer" style="margin-top: 16px;"></div>
      </section>

      <section class="success-card shiplet-panel" id="shiplets">
        <span class="success-card-label">Harbor ledger</span>
        <h2>${glyph("tag", "section-glyph")}Shiplets and sharing</h2>
        <p>Open artifacts, review feedback, and grant access to organizations, teams, or individual reviewers.</p>
        <div id="projectList" class="dataContainer" style="margin: 14px 0 16px;"></div>
        <form id="shipletShareForm" class="settings-form-grid">
          <div class="form-group">
            <label for="shareProjectSelect">Shiplet</label>
            <select id="shareProjectSelect"></select>
          </div>
          <div class="form-group">
            <label for="shareTargetType">Share with</label>
            <select id="shareTargetType">
              <option value="user">User</option>
              <option value="team">Team</option>
              <option value="organization">Organization</option>
            </select>
          </div>
          <div class="form-group" id="shareEmailGroup">
            <label for="shareEmail">Email</label>
            <input id="shareEmail" type="email" placeholder="reviewer@example.com">
          </div>
          <div class="form-group" id="shareTeamGroup" style="display: none;">
            <label for="shareTeamSelect">Team</label>
            <select id="shareTeamSelect"></select>
          </div>
          <div class="form-group">
            <label for="shareRole">Role</label>
            <select id="shareRole">
              <option value="viewer">Viewer</option>
              <option value="reviewer">Reviewer</option>
              <option value="owner">Owner</option>
            </select>
          </div>
          <button class="btn btn-secondary btn-sm" type="submit">Share</button>
        </form>
        <div id="shareResult" class="result-slot"></div>
      </section>

      <section class="success-card shiplet-panel" id="agents">
        <span class="success-card-label">Dock crew</span>
        <h2>${glyph("plug", "section-glyph")}API Keys and MCP</h2>
        <p>One organization key can publish shiplets and read review feedback through the Code Mode MCP endpoint. Tokens are shown once when created.</p>
        ${BuildMcpEndpointCopy({ endpoint: REMOTE_MCP_ENDPOINT })}
        <form id="tokenForm" class="settings-form-grid">
          <div class="form-group">
            <label for="tokenName">Token name</label>
            <input id="tokenName" type="text" placeholder="Local Codex">
          </div>
          <div class="form-group">
            <label for="tokenProjectAccessMode">Project access</label>
            <select id="tokenProjectAccessMode">
              <option value="all">All projects</option>
              <option value="all_except">All except selected</option>
              <option value="selected" selected>Only selected</option>
            </select>
          </div>
          <div class="form-group">
            <label for="tokenRuleProjectSelect">Project rules</label>
            <select id="tokenRuleProjectSelect" multiple size="3"></select>
          </div>
          <button class="btn btn-secondary btn-sm" type="submit">Create Key</button>
        </form>
        <div class="scope-grid">
          <label class="scope-pill"><input type="checkbox" name="tokenScope" value="shiplets:read"> shiplets:read</label>
          <label class="scope-pill"><input type="checkbox" name="tokenScope" value="shiplets:write"> shiplets:write</label>
          <label class="scope-pill"><input type="checkbox" name="tokenScope" value="shiplets:archive"> shiplets:archive</label>
          <label class="scope-pill"><input type="checkbox" name="tokenScope" value="feedback:read"> feedback:read</label>
          <label class="scope-pill"><input type="checkbox" name="tokenScope" value="feedback:write"> feedback:write</label>
          <label class="scope-pill"><input type="checkbox" name="tokenScope" value="mcp"> mcp</label>
        </div>
        <div id="tokenResult" class="result-slot"></div>
        <div id="tokenList" class="dataContainer" style="margin-top: 16px;"></div>
      </section>
    </div>
  </div>
</div>
${DashboardRuntimeScript(nonce)}
`;

export function BuildInboxPage(options: {
	notifications: ReviewNotificationRecord[];
	nonce: KernelDocumentNonce;
}) {
  const rows = options.notifications.length
    ? options.notifications
        .map((notification) => {
          const readLabel = notification.read_on ? "Read" : "Unread";
          const projectName = notification.project_name || "Shiplet";
          const href = `/shiplets/${escapeHtml(notification.project_id)}?feedback=${escapeHtml(notification.feedback_id || "")}`;
          return `<tr>
						<td><span class="shiplet-visibility-badge" data-visibility="${notification.read_on ? "organization" : "private"}">${readLabel}</span></td>
						<td><a class="table-link" href="${href}">${escapeHtml(notification.message)}</a></td>
						<td>${escapeHtml(projectName)}</td>
						<td>${escapeHtml(notification.reason.replace(/_/g, " "))}</td>
						<td>${escapeHtml(formatDateLabel(notification.created_on))}</td>
					</tr>`;
        })
        .join("")
    : `<tr><td colspan="5">No notifications yet.</td></tr>`;
  return `
<div class="dashboard-shell shiplet-dashboard-stage">
  <header class="app-page-topbar">
    <div class="app-page-title">
      <span class="success-card-label">Inbox</span>
      <h1>Notifications</h1>
      <p>Mentions, watched shiplet updates, replies, and status changes for shiplets you can access.</p>
    </div>
    <div class="dashboard-actions">
      <a class="btn btn-secondary btn-sm" href="/feedback">All feedback</a>
      <a class="btn btn-secondary btn-sm" href="/shiplets">Shiplets</a>
    </div>
  </header>
  <section class="success-card shiplet-panel">
    <div class="dashboard-section-header">
      <div>
        <span class="success-card-label">Latest</span>
        <h2>Notification inbox</h2>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" id="refreshInbox">Refresh</button>
    </div>
    <div class="dataContainer" style="margin-top: 14px;">
      <table class="dataTable">
        <tr><th>Status</th><th>Event</th><th>Shiplet</th><th>Reason</th><th>Received</th></tr>
        ${rows}
      </table>
    </div>
  </section>
</div>
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(options.nonce)}>
(function() {
  var refresh = document.getElementById("refreshInbox");
  if (refresh) refresh.addEventListener("click", function() { window.location.reload(); });
})();
</script>
`;
}

export function BuildGlobalFeedbackPage(options: {
  feedback: ReviewFeedbackRecord[];
}) {
  const rows = options.feedback.length
    ? options.feedback
        .map((item) => {
          const ticketLabel = item.ticket_label || `PF-${item.ticket_number}`;
          const projectName = item.project_name || item.project_id;
          const href = `/shiplets/${escapeHtml(item.project_id)}?feedback=${escapeHtml(item.id)}`;
          const mentions = (item.mentions || [])
            .map((mention) => {
              const label = mention.mentioned_name || mention.mentioned_email;
              const title =
                mention.access_status === "invited"
                  ? "Invited but has not joined this shiplet yet"
                  : mention.access_status === "invite_failed"
                    ? "Invite failed"
                    : "Active on this shiplet";
              return `<span class="success-card-label" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
            })
            .join(" ");
          return `<tr>
						<td><a class="table-link" href="${href}">${escapeHtml(ticketLabel)}</a></td>
						<td>${escapeHtml(projectName)}</td>
						<td>${escapeHtml(item.status)}</td>
						<td>${escapeHtml(item.comment)}</td>
						<td>${mentions || "-"}</td>
						<td>${escapeHtml(item.submitted_by_email || "Reviewer")}</td>
						<td>${escapeHtml(formatDateLabel(item.created_on))}</td>
					</tr>`;
        })
        .join("")
    : `<tr><td colspan="7">No feedback matched these filters.</td></tr>`;
  return `
<div class="dashboard-shell shiplet-dashboard-stage">
  <header class="app-page-topbar">
    <div class="app-page-title">
      <span class="success-card-label">Feedback</span>
      <h1>All feedback</h1>
      <p>A flat newest-first view across every shiplet you can access.</p>
    </div>
    <div class="dashboard-actions">
      <a class="btn btn-secondary btn-sm" href="/inbox">Inbox</a>
      <a class="btn btn-secondary btn-sm" href="/shiplets">Shiplets</a>
    </div>
  </header>
  <section class="success-card shiplet-panel">
    <div class="dashboard-section-header">
      <div>
        <span class="success-card-label">Global ledger</span>
        <h2>Review comments</h2>
      </div>
      <form class="dashboard-actions" method="GET" action="/feedback">
        <select name="status" aria-label="Status filter">
          <option value="">Any status</option>
          ${["New", "In Progress", "Blocked", "Done", "Dropped"]
            .map(
              (status) =>
                `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`,
            )
            .join("")}
        </select>
        <label class="scope-pill"><input type="checkbox" name="mentionedMe" value="true"> Mentioned me</label>
        <label class="scope-pill"><input type="checkbox" name="watched" value="true"> Watched</label>
        <label class="scope-pill"><input type="checkbox" name="submittedByMe" value="true"> Mine</label>
        <button class="btn btn-secondary btn-sm" type="submit">Filter</button>
      </form>
    </div>
    <div class="dataContainer" style="margin-top: 14px;">
      <table class="dataTable">
        <tr><th>ID</th><th>Shiplet</th><th>Status</th><th>Comment</th><th>Mentions</th><th>Submitted by</th><th>Created</th></tr>
        ${rows}
      </table>
    </div>
  </section>
</div>
`;
}

export function BuildArchivedShipletPage(options: {
  project: Project;
  canRestore: boolean;
  restoreUrl: string;
}) {
  const projectName = escapeHtml(options.project.name || "This shiplet");
  const deleteAfter = escapeHtml(options.project.delete_after || "");
  const archivedOn = escapeHtml(options.project.archived_on || "");
  const restoreUrl = escapeHtml(options.restoreUrl);
  const detailUrl = `/shiplets/${escapeHtml(options.project.id)}`;

  return `
<div class="dashboard-shell shiplet-dashboard-stage shiplet-archived-page">
  <section class="success-card shiplet-panel shiplet-focus-strip">
    <div class="arrival-scene" aria-hidden="true">
      <span class="arrival-boat">${ARRIVAL_BOAT_SVG}</span>
      <div class="arrival-water"></div>
    </div>
    <div class="shiplet-detail-hero">
      <div>
        <span class="success-card-label stamp-xl">Archived</span>
        <h1>This shiplet has been archived</h1>
        <p>${projectName} is no longer serving its artifact. Archived shiplets stay recoverable during the retention window.</p>
      </div>
      <div class="shiplet-detail-actions">
        ${
          options.canRestore
            ? `<form method="POST" action="${restoreUrl}"><button class="btn btn-primary btn-sm" type="submit">Restore shiplet</button></form>`
            : ""
        }
        <a class="btn btn-secondary btn-sm" href="${detailUrl}">Open details</a>
      </div>
    </div>
    <dl class="shiplet-archive-facts" data-delete-after="${deleteAfter}">
      <div><dt>archived_on</dt><dd>${archivedOn || "Unknown"}</dd></div>
      <div><dt>delete_after</dt><dd>${deleteAfter || "Not scheduled"}</dd></div>
    </dl>
  </section>
</div>
`;
}

export function BuildShipletAccessRequestPage(options: {
  project: Project;
  userEmail: string;
  request?: ShipletAccessRequestRecord | null;
  returnTo?: string | null;
}) {
  const projectName = escapeHtml(options.project.name || "this Shiplet");
  const userEmail = escapeHtml(options.userEmail);
  const projectId = encodeURIComponent(options.project.id);
  const request = options.request;
  const deliveryFailed =
    request?.email_status === "failed" ||
    request?.email_status === "not_configured";
  const requestSent = request?.email_status === "sent";
  const title = deliveryFailed
    ? "We couldn’t send your request"
    : requestSent
      ? "Access request sent"
      : `Request access to ${projectName}`;
  const statusCopy = deliveryFailed
    ? `Your request for ${projectName} is saved, but the owner notification could not be delivered. Try again in a moment.`
    : requestSent
      ? `Your access request is already pending. We notified the owner of ${projectName}; you’ll be able to open it after they grant access.`
      : `${projectName} is limited to its organization and invited reviewers. Confirm below to ask the owner for access.`;
  const buttonLabel = deliveryFailed ? "Try again" : "Request access";
  const returnToField = options.returnTo
    ? `<input type="hidden" name="return_to" value="${htmlAttribute(options.returnTo)}">`
    : "";

  return `
<div class="dashboard-shell shiplet-dashboard-stage shiplet-access-request-page">
  <section class="success-card shiplet-panel shiplet-focus-strip">
    <div class="shiplet-detail-hero">
      <div>
        <span class="success-card-label stamp-xl">Restricted review</span>
        <h1>${title}</h1>
        <p>${statusCopy}</p>
      </div>
    </div>
    <div class="form-container" style="margin-top: 18px; max-width: 560px;">
      <div class="banner ${deliveryFailed ? "banner-error" : requestSent ? "banner-success" : "banner-info"}">
        Signed in as <strong>${userEmail}</strong>
      </div>
      ${
        requestSent
          ? ""
          : `<form method="POST" action="/shiplets/${projectId}/access-requests" style="margin-top: 16px;">
        ${returnToField}
        <button class="btn btn-primary" type="submit">${buttonLabel}</button>
      </form>`
      }
    </div>
  </section>
</div>
`;
}

export function BuildShipletReviewPage(options: {
	nonce: KernelDocumentNonce;
	project: Project;
	artifactUrl: string;
	previewUrl: string;
	reviewUrl: string;
	created?: boolean;
	canEditLifecycle?: boolean;
	canPermanentlyDelete?: boolean;
}) {
  const projectJson = scriptJson({
    id: options.project.id,
    organization_id: options.project.organization_id || "",
    name: options.project.name,
    subdomain: options.project.subdomain,
    visibility: options.project.visibility || "organization",
    archived_on: options.project.archived_on || null,
    delete_after: options.project.delete_after || null,
  });
  const projectName = escapeHtml(options.project.name);
  const previewUrl = escapeHtml(options.previewUrl);
  const reviewUrl = escapeHtml(options.reviewUrl);
  const artifactUrl = escapeHtml(options.artifactUrl);
  const feedbackPath = `/api/projects/${escapeHtml(options.project.id)}/review-feedback`;
  const isArchived = Boolean(options.project.archived_on);
  const deleteAfter = escapeHtml(options.project.delete_after || "");
  const archivedOn = escapeHtml(options.project.archived_on || "");
  const projectSubdomain = escapeHtml(options.project.subdomain);
  const createdTitle = isArchived
    ? "Archived shiplet"
    : options.created
      ? "Shiplet ready"
      : "Review bridge";

	return `
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(options.nonce)}>window.SHIPLET_DETAIL_PROJECT=${projectJson};</script>
<div class="dashboard-shell shiplet-dashboard-stage shiplet-detail-page">
  <section class="success-card shiplet-panel shiplet-focus-strip">
    <div class="bridge-interior-scene" aria-hidden="true">
      ${BRIDGE_INTERIOR_SVG}
    </div>
    <div class="shiplet-detail-hero">
      <div>
        <span class="success-card-label stamp-xl">${isArchived ? "Archived" : options.created ? "Ready for review" : "Review bridge"}</span>
        <h1>${createdTitle}</h1>
        <p>${projectName} ${isArchived ? "is archived and no longer serves its artifact until restored." : "is prepared for review. Open the artifact, collect contextual comments, then hand clear notes to engineers or local agents through MCP."}</p>
      </div>
      <div class="shiplet-detail-actions">
        <a class="btn btn-primary btn-sm" href="${reviewUrl}" target="_blank" rel="noreferrer">${isArchived ? "View archived page" : "Open review page"}</a>
        <a class="btn btn-secondary btn-sm" href="/">Create another shiplet</a>
      </div>
    </div>
    <div id="dashboardStatus" class="banner banner-info" style="margin-top: 16px;">Loading workspace...</div>
  </section>

  <div class="review-command-grid">
    <section class="artifact-preview-shell">
      <div class="dashboard-section-header" style="margin-bottom: 12px;">
        <div>
          <span class="success-card-label">Review window</span>
          <h2>Artifact and review</h2>
          <p>The review layer is injected into this artifact for signed-in viewers.</p>
        </div>
        <div class="dashboard-actions">
          <button class="btn btn-secondary btn-sm" type="button" id="watchArtifact" data-watch-artifact aria-pressed="false">Watch artifact</button>
          <a class="btn btn-secondary btn-sm" href="${artifactUrl}" target="_blank" rel="noreferrer">Open URL</a>
        </div>
      </div>
      <iframe id="artifactPreviewFrame" class="artifact-preview-frame" src="${previewUrl}" title="${projectName} preview"></iframe>
      <section class="review-comments-panel" aria-labelledby="reviewCommentsTitle">
        <div class="dashboard-section-header">
          <div>
            <span class="success-card-label">Comments</span>
            <h2 id="reviewCommentsTitle">Comments</h2>
            <p>Leave a general note or follow up on an existing comment.</p>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" id="refreshFeedback">Refresh</button>
        </div>
        <form id="bridgeCommentForm" class="bridge-comment-form">
          <div class="form-group">
            <label for="bridgeComment">New comment</label>
            <textarea id="bridgeComment" placeholder="Add a general comment about this artifact"></textarea>
          </div>
          <button class="btn btn-primary btn-sm bridge-comment-submit" type="submit">Add comment</button>
        </form>
        <div id="feedbackList" class="feedback-ticket-list"></div>
        <div id="feedbackScreenshotLightbox" class="feedback-screenshot-lightbox" role="dialog" aria-modal="true" aria-hidden="true" aria-label="Feedback screenshot" hidden>
          <button class="btn btn-secondary btn-sm feedback-screenshot-lightbox-close" type="button" data-feedback-screenshot-close>Close</button>
          <div class="feedback-screenshot-lightbox-frame">
            <img id="feedbackScreenshotLightboxImage" alt="">
          </div>
        </div>
      </section>
    </section>

    <aside class="review-side-stack">
      ${
        options.created && !isArchived
          ? `<section class="success-card shiplet-panel"><span class="success-card-label">Ready</span><h2>Published for review.</h2><p>Share the review link when its visibility setting is right for your audience.</p></section>`
          : ""
      }
      <section class="success-card shiplet-panel">
        <h2>Invite reviewers</h2>
        <p>Send teammates straight into the artifact so feedback starts as contextual comments.</p>
        <button class="btn btn-secondary btn-sm" type="button" id="showInviteForm" style="margin-top: 12px;">Invite</button>
        <form id="shipletShareForm" style="display: grid; gap: 12px; margin-top: 12px;">
          <select id="shareProjectSelect" class="sr-only" aria-label="Shiplet" tabindex="-1">
            <option value="${escapeHtml(options.project.id)}">${projectName}</option>
          </select>
          <div id="shipletInviteFields" hidden>
            <div class="form-group">
              <label for="shareTargetType">Share with</label>
              <select id="shareTargetType">
                <option value="user">User</option>
                <option value="team">Team</option>
                <option value="organization">Organization</option>
              </select>
            </div>
            <div class="form-group" id="shareEmailGroup">
              <label for="shareEmail">Email</label>
              <input id="shareEmail" type="email" placeholder="reviewer@example.com">
            </div>
            <div class="form-group" id="shareTeamGroup" style="display: none;">
              <label for="shareTeamSelect">Team</label>
              <select id="shareTeamSelect"></select>
            </div>
            <div class="form-group">
              <label for="shareRole">Role</label>
              <select id="shareRole">
                <option value="reviewer">Reviewer</option>
                <option value="viewer">Viewer</option>
                <option value="owner">Owner</option>
              </select>
            </div>
            <button class="btn btn-primary btn-sm" type="submit">Invite reviewers</button>
          </div>
        </form>
        <div id="shareResult" class="result-slot"></div>
      </section>

      <section class="success-card shiplet-panel">
        <span class="success-card-label">Lifecycle</span>
        <h2>Shiplet status</h2>
        ${
          isArchived
            ? `<div class="banner banner-warning">Archived on ${archivedOn || "an unknown date"}. Scheduled delete_after ${deleteAfter || "is not set"}.</div>
        ${
          options.canEditLifecycle
            ? `
        <form id="restoreShipletForm" class="shiplet-lifecycle-form">
          <button class="btn btn-primary btn-sm" type="submit">Restore shiplet</button>
        </form>`
            : ""
        }
        ${
          options.canPermanentlyDelete
            ? `
        <form id="permanentDeleteShipletForm" class="shiplet-lifecycle-form">
          <div class="form-group">
            <label for="confirmSubdomain">Type ${projectSubdomain} to permanently delete</label>
            <input id="confirmSubdomain" name="confirmSubdomain" autocomplete="off" placeholder="${projectSubdomain}">
          </div>
          <button class="btn btn-destructive btn-sm" type="submit">Permanently delete</button>
        </form>`
            : ""
        }`
            : options.canEditLifecycle
              ? `<p>Archive this shiplet to stop serving the artifact while keeping a 30 day restore window.</p>
        <form id="archiveShipletForm" class="shiplet-lifecycle-form">
          <button class="btn btn-secondary btn-sm" type="submit">Archive shiplet</button>
        </form>`
              : `<p>You can view this shiplet, but lifecycle changes require editor access.</p>`
        }
      </section>

      <section class="success-card shiplet-panel">
        <span class="success-card-label">Agent handoff</span>
        <h2>MCP handoff</h2>
        <p>Use the account MCP endpoint with an organization API key that has <code>feedback:read</code> and <code>mcp</code> to hand comments to an agent.</p>
        ${BuildMcpEndpointCopy({ endpoint: REMOTE_MCP_ENDPOINT })}
        <code class="mcp-code-block">await codemode.request({
  method: "GET",
  path: "${feedbackPath}",
  query: { includeClosed: true }
})</code>
        <a class="btn btn-secondary btn-sm" style="margin-top: 12px;" href="/agents">Create API key</a>
      </section>
    </aside>
  </div>
</div>
${DashboardRuntimeScript(options.nonce)}
`;
}
