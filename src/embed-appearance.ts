// Per-site Appearance for the website widget: a theme, an accent color and a
// default corner, chosen by an editor on "Connect a website".
//
// The widget's controls render inside Shiplet's own frames, so a site's CSS
// cannot restyle them. Instead every Shiplet page inside the widget links
// /api/embed/theme.css for its installation, after the base stylesheet. That
// stylesheet only overrides design tokens (and, for a chosen corner, where the
// collapsed toolbar sits). With no appearance it is empty, so existing sites
// look exactly as before.
import { BROWSER_INSTALLATION_FILTER } from "./embed";

export const EMBED_APPEARANCE_THEMES = ["auto", "light", "dark"] as const;
export const EMBED_APPEARANCE_POSITIONS = [
  "bottom-right",
  "bottom-left",
  "top-right",
  "top-left",
] as const;
export const EMBED_DEFAULT_ACCENT = "#b44729";

export type EmbedAppearanceTheme = (typeof EMBED_APPEARANCE_THEMES)[number];
export type EmbedAppearancePosition =
  (typeof EMBED_APPEARANCE_POSITIONS)[number];
export type EmbedAppearance = {
  theme: EmbedAppearanceTheme;
  accent: string;
  position: EmbedAppearancePosition;
};

const ACCENT = /^#[0-9a-f]{6}$/;

/** Strict: exact enums and a lowercase #rrggbb accent, or null. */
export function parseEmbedAppearance(input: {
  theme?: unknown;
  accent?: unknown;
  position?: unknown;
}): EmbedAppearance | null {
  const { theme, accent, position } = input;
  if (
    typeof theme !== "string" ||
    !(EMBED_APPEARANCE_THEMES as readonly string[]).includes(theme) ||
    typeof accent !== "string" ||
    !ACCENT.test(accent) ||
    typeof position !== "string" ||
    !(EMBED_APPEARANCE_POSITIONS as readonly string[]).includes(position)
  )
    return null;
  return {
    theme: theme as EmbedAppearanceTheme,
    accent,
    position: position as EmbedAppearancePosition,
  };
}

/** The stored column; anything unreadable counts as no appearance. */
export function readEmbedAppearance(
  stored: string | null | undefined,
): EmbedAppearance | null {
  if (typeof stored !== "string" || !stored || stored.length > 512) return null;
  try {
    const value = JSON.parse(stored);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (Object.keys(value).sort().join() !== "accent,position,theme") return null;
    return parseEmbedAppearance(value);
  } catch {
    return null;
  }
}

export function serializeEmbedAppearance(appearance: EmbedAppearance) {
  return JSON.stringify({
    theme: appearance.theme,
    accent: appearance.accent,
    position: appearance.position,
  });
}

/** A short hash of the appearance, so theme.css URLs change with it. */
export async function embedAppearanceVersion(
  appearance: EmbedAppearance | null,
) {
  const text = appearance ? serializeEmbedAppearance(appearance) : "default";
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return Array.from(digest.subarray(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function embedThemeStylesheetUrl(
  origin: string,
  installationId: string,
  appearance: EmbedAppearance | null,
) {
  const url = new URL("/api/embed/theme.css", origin);
  url.searchParams.set("installation_id", installationId);
  url.searchParams.set("v", await embedAppearanceVersion(appearance));
  return url.toString();
}

export async function setInstallationAppearance(
  db: D1Database,
  projectId: string,
  installationId: string,
  appearance: EmbedAppearance | null,
) {
  const result = await db
    .prepare(
      `UPDATE embed_installations SET appearance = ? WHERE id = ? AND project_id = ? AND revoked_on IS NULL AND ${BROWSER_INSTALLATION_FILTER}`,
    )
    .bind(
      appearance ? serializeEmbedAppearance(appearance) : null,
      installationId,
      projectId,
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

// --- Color -----------------------------------------------------------------

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)) as Rgb;
}

function hex(color: Rgb) {
  return `#${color
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function mix(color: string, toward: string, amount: number) {
  const from = rgb(color);
  const to = rgb(toward);
  return hex(from.map((channel, index) => channel + (to[index] - channel) * amount) as Rgb);
}

/** WCAG 2 relative luminance. */
export function relativeLuminance(color: string) {
  const [r, g, b] = rgb(color).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two #rrggbb colors. */
export function contrastRatio(first: string, second: string) {
  const [high, low] = [relativeLuminance(first), relativeLuminance(second)].sort(
    (a, b) => b - a,
  );
  return (high + 0.05) / (low + 0.05);
}

const ON_DARK = "#ffffff";
const ON_LIGHT = "#111827";

/**
 * Near-black or white, whichever reads better on the accent. A mid-tone
 * accent that neither reaches 4.5:1 with gets pure black, which always does.
 */
export function onAccentColor(accent: string) {
  const best =
    contrastRatio(accent, ON_DARK) >= contrastRatio(accent, ON_LIGHT)
      ? ON_DARK
      : ON_LIGHT;
  return contrastRatio(accent, best) >= 4.5 ? best : "#000000";
}

// --- Token sets ------------------------------------------------------------

type Palette = Record<string, string>;

// Today's light look: the defaults the base stylesheets already render.
const LIGHT: Palette = {
  ink: "#20293a",
  "ink-soft": "#3a4459",
  muted: "#566378",
  line: "#d5d9df",
  divider: "#d7dbe3",
  "field-line": "#8994a3",
  surface: "#fbf9f4",
  raised: "#ffffff",
  tint: "#edf3f5",
  wash: "#edf5f7",
  select: "#e3edf2",
  chip: "#eae7e0",
  mark: "#f6e8e1",
  accent: "#2f6e88",
  focus: "#2f6e88",
  info: "#245b72",
  "info-line": "#9cb8c4",
  danger: "#8c2a1c",
  "danger-bg": "#f8e9e5",
  "danger-line": "#e5b7ad",
  "warn-bg": "#fff8df",
  "warn-line": "#b8a978",
  shadow: "0 3px 8px rgba(32,41,58,.16)",
};

// Reads well on a dark navy page. Every text color meets WCAG AA (4.5:1) on
// surface, raised, tint and wash (test/embed-appearance.spec.ts checks).
const DARK: Palette = {
  ink: "#eef1ff",
  "ink-soft": "#cdd3f0",
  muted: "#a3acd0",
  line: "rgba(170,186,255,.18)",
  divider: "rgba(170,186,255,.18)",
  "field-line": "rgba(170,186,255,.4)",
  surface: "#111a33",
  raised: "#18223f",
  tint: "#222e55",
  wash: "#1e2a4d",
  select: "#2a3a6b",
  chip: "#27335c",
  mark: "#2c2f4a",
  accent: "#9cc0ff",
  focus: "#9cc0ff",
  info: "#a9cdff",
  "info-line": "rgba(156,192,255,.42)",
  danger: "#ffb4a8",
  "danger-bg": "#3a1e29",
  "danger-line": "#7d3c43",
  "warn-bg": "#2d2916",
  "warn-line": "#8c7b3e",
  shadow: "0 8px 24px rgba(0,0,0,.5)",
};

export const EMBED_THEME_PALETTES = { light: LIGHT, dark: DARK } as const;

function tokens(palette: Palette, accent: string) {
  const onAction = onAccentColor(accent);
  // Hover and border move away from the text color, so contrast only grows.
  const away = onAction === ON_DARK ? "#000000" : "#ffffff";
  const surface = palette.surface;
  const values: Palette = {
    ...palette,
    action: accent,
    "action-hover": mix(accent, away, 0.16),
    "action-line": mix(accent, away, 0.24),
    "on-action": onAction,
    pin: accent,
    "on-pin": onAction,
    // The focus ring follows the accent when it is visible on the panel (3:1).
    focus: contrastRatio(accent, surface) >= 3 ? accent : palette.focus,
  };
  return Object.entries(values)
    .map(([name, value]) => `--shiplet-${name}:${value}`)
    .join(";");
}

// Accent as text (ticket labels) only where it is readable; otherwise ink.
function accentText(palette: Palette, accent: string) {
  return contrastRatio(accent, palette.mark) >= 4.5 &&
    contrastRatio(accent, palette.surface) >= 4.5
    ? accent
    : palette.ink;
}

function scheme(palette: Palette, accent: string, colorScheme: string) {
  // :root for Shiplet's own frames, :host for the widget's shadow root on the
  // site. iframe keeps the widget's frame element in the frame's color scheme,
  // so the browser never paints an opaque backdrop behind a transparent frame.
  return `:root,:host{color-scheme:${colorScheme};${tokens(palette, accent)}}
iframe{color-scheme:${colorScheme}}
.shiplet-review-thread-summary strong,.shiplet-review-context-disclosure summary::before{color:${accentText(palette, accent)}}`;
}

// Components with their own palettes, restated for dark.
const DARK_COMPONENTS = `.shiplet-annotation-editor{--annotation-border:rgba(170,186,255,.28);--annotation-ink:#eef1ff;--annotation-muted:#a3acd0}
.shiplet-annotation-toolbar{background:#18223f}
.shiplet-annotation-toolbar button,.shiplet-annotation-handle,.shiplet-annotation-field input[type="color"]{background:#111a33;border-color:rgba(170,186,255,.4);color:#eef1ff}
.shiplet-annotation-toolbar button[aria-pressed="true"]{background:#eef1ff;border-color:#eef1ff;color:#111a33}
.shiplet-annotation-handle::after{color:#eef1ff}
.shiplet-annotation-workspace{background:#0b1226}
.shiplet-annotation-error{background:#3a1e29;border-color:#7d3c43;color:#ffb4a8}
.shiplet-annotation-primary{background:var(--shiplet-action)!important;border-color:var(--shiplet-action)!important;color:var(--shiplet-on-action)!important}
.shiplet-attachment-drafts{color:#eef1ff}
.shiplet-attachment-controls button,.shiplet-attachment-card{background:#18223f;border-color:rgba(170,186,255,.3);color:#eef1ff}
.shiplet-attachment-drop{background:#18223f;border-color:rgba(170,186,255,.4);color:#cdd3f0}
.shiplet-attachment-drop[data-dragging="true"],.shiplet-attachment-drop:focus-visible{background:#1e2a4d;border-color:#9cc0ff}
.shiplet-attachment-guidance,.shiplet-attachment-summary,.shiplet-attachment-detail,.shiplet-attachment-preview-unavailable{color:#a3acd0}
.shiplet-attachment-preview{background:#222e55}
.shiplet-attachment-error,.shiplet-attachment-remove{color:#ffb4a8}`;

function positionRules(position: EmbedAppearancePosition) {
  const [vertical, horizontal] = position.split("-") as [
    "top" | "bottom",
    "left" | "right",
  ];
  const opposite = { top: "bottom", bottom: "top", left: "right", right: "left" };
  const host = `${vertical}:0;${opposite[vertical]}:auto;${horizontal}:0;${opposite[horizontal]}:auto`;
  const edge = (gap: number, side: string) =>
    `${side}:max(${gap}px,env(safe-area-inset-${side}));${opposite[side as keyof typeof opposite]}:auto`;
  const rules = [
    // The widget on the site, until a signed-in reviewer's own dock applies.
    `:host(:not([data-dock])){${host}}`,
    `:host(:not([data-dock])) .surface:not([data-view=selecting]):not([data-view=drawing]){${edge(4, vertical)};${edge(4, horizontal)}}`,
    // Inside Shiplet's frame: the toolbar, unless a reviewer docked it.
    `.shiplet-review-launcher-dock:not([data-review-dock]){${edge(12, vertical)};${edge(12, horizontal)}}`,
  ];
  if (vertical === "top")
    rules.push(
      `:host(:not([data-dock])) .overlay-toggle{top:80px;bottom:auto}`,
      // The signed-out status box sits below a top toolbar, not over it.
      `.shiplet-embed-auth-status{inset:72px 8px 8px}`,
    );
  if (horizontal === "left")
    rules.push(`:host(:not([data-dock])) .overlay-toggle{left:8px;right:auto}`);
  return rules.join("\n");
}

/** theme.css for one installation; empty when it has no appearance. */
export function embedThemeCss(appearance: EmbedAppearance | null) {
  if (!appearance) return "";
  const { theme, accent } = appearance;
  const light = scheme(LIGHT, accent, "light");
  const dark = `${scheme(DARK, accent, "dark")}\n${DARK_COMPONENTS}`;
  const colors =
    theme === "light"
      ? light
      : theme === "dark"
        ? dark
        : `${scheme(LIGHT, accent, "light dark")}\n@media (prefers-color-scheme:dark){\n${scheme(DARK, accent, "light dark")}\n${DARK_COMPONENTS}\n}`;
  return `/* Shiplet widget appearance: ${theme}, ${accent}, ${appearance.position} */\n${colors}\n${positionRules(appearance.position)}\n`;
}
