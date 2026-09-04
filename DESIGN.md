# Shiplet Design System — "The Harbor Office"

This is the design source of truth for Shiplet's web interface. It implements the
brand brief in PRODUCT.md: quirky, practical, crisp — lighter and more memorable
than a generic admin panel, while behaving like dependable infrastructure.

## 1. Brand idea

**Shiplet is a well-run harbor for small vessels.**

Every preview is a little ship. Publishing gives it a berth (a URL). Reviewers
walk the deck and leave manifest tickets (PF-1, PF-2…). Agents are the dock crew
who pick the manifest up over MCP and get the work done.

The interface should feel like the front office of a tidy working harbor:
paper manifests, stamped statuses, signal-flag colors — run by people who have
never once lost a package.

### Where the quirk is allowed to live

Per the design principles ("personality in surfaces, states, and details, not in
unclear labels"):

| Allowed | Not allowed |
| --- | --- |
| Stamp-styled status badges | Renaming "Publish" to "Set sail" |
| Mono "deck label" eyebrows above sections | Nautical jargon in form labels |
| A waterline rule under the header | Decorative gradients, oversized heroes |
| Warm copy in empty states & confirmations | Cute icons that obscure meaning |

Control labels are always plain: Publish, Settings, Invite, Revoke, Sign out.

## 2. Voice

[BRAND-VOICE.md](BRAND-VOICE.md) is the language source of truth. The rules below summarize
the product register used by this visual system.

- Labels: plain and short. Verbs on buttons.
- Confirmations: warm but factual. "Workspace ready." "Invite sent."
- Empty states: one helpful sentence, never a joke at the user's expense.
- Errors: say what happened and what to do next. No "Oops!".

## 3. Logo & mark

- **Mark**: a flag pennant over a hull carrying two cargo squares (buoy orange +
  harbor teal) on a warm paper tile with an ink border. Drawn as inline SVG
  (`SHIPLET_FAVICON_SVG` in `src/seo.ts`, mirrored in `favicon.svg`).
- **Header vessel**: the mark is the compact header's only ship. Its header-sized
  rendering may add restrained rigging, deck, hull, water-contact, and wake
  detail around the canonical silhouette, while the full-width waterline stays
  boat-free.
- **Wordmark**: "Shiplet" set in Bricolage Grotesque 700, ink, tight tracking.
- Clear space: half the mark's width on all sides. Never stretch, recolor, or
  put the mark on a gradient.

## 4. Color

All colors are OKLCH (perceptually uniform lightness, wide-gamut safe).
Three tiers: primitives → semantic aliases → component usage. Components only
reference semantic tokens.

### Primitives

| Token | Value | Role |
| --- | --- | --- |
| `--ink-900` | `oklch(23% 0.04 255)` | Primary text, borders-strong |
| `--ink-700` | `oklch(34% 0.035 255)` | Soft text |
| `--ink-500` | `oklch(47% 0.03 252)` | Muted text (AA on paper) |
| `--ink-300` | `oklch(80% 0.02 250)` | Hairlines |
| `--paper-0` | `oklch(99% 0.005 95)` | Card surface (warm white) |
| `--paper-50` | `oklch(97% 0.01 95)` | Page background |
| `--paper-100` | `oklch(94% 0.015 92)` | Sunken wells, table headers |
| `--buoy-700` | `oklch(48% 0.16 35)` | Primary action hover |
| `--buoy-600` | `oklch(54% 0.165 35)` | Primary action (white text ≥ 4.5:1) |
| `--buoy-100` | `oklch(93% 0.045 40)` | Buoy tint surface |
| `--harbor-700` | `oklch(40% 0.075 220)` | Accent text on tint |
| `--harbor-600` | `oklch(47% 0.085 220)` | Links, focus ring, info |
| `--harbor-100` | `oklch(92% 0.04 215)` | Info tint surface |
| `--sea-700` | `oklch(42% 0.1 155)` | Success text |
| `--sea-100` | `oklch(93% 0.055 155)` | Success tint |
| `--flag-700` | `oklch(45% 0.1 75)` | Warning text |
| `--flag-100` | `oklch(94% 0.08 90)` | Warning tint |
| `--signal-600` | `oklch(50% 0.19 27)` | Error / destructive |
| `--signal-100` | `oklch(93% 0.045 27)` | Error tint |

Why orange, not blue: blue-primary is the uniform of every generic SaaS
dashboard (an explicit anti-reference). Buoy orange is a working-harbor signal
color — memorable, and AA-checked at `--buoy-600` with white text. Harbor teal
carries links/info so orange stays reserved for the primary action on each page.

### Semantic aliases

`--bg`, `--surface`, `--surface-sunken`, `--text`, `--text-soft`, `--text-muted`,
`--line`, `--line-strong`, `--action`, `--action-hover`, `--action-contrast`,
`--accent`, `--ring`, plus `--ok/--warn/--err/--info` with `*-surface` pairs.
Hover states derive via `color-mix()` — no hand-tuned hover hexes.

### Night watch (dark theme)

Dark mode ships as a pure semantic-tier override under
`@media (prefers-color-scheme: dark)` — primitives and components are
untouched. Key moves: paper becomes deep harbor navy, the buoy action
lightens and flips to dark text (`--action-contrast`), links/focus shift to a
lighter harbor, and status tints invert to dark surfaces with light text.
The inline brand mark reads `--mark-ink` / `--mark-harbor` so the hull stays
visible on dark. `color-scheme: light dark` lets native controls follow.

## 5. Typography

| Role | Face | Notes |
| --- | --- | --- |
| Display / headings / wordmark | **Bricolage Grotesque** (Google Fonts, 500–800) | The quirk carrier. `font-display: swap`, system-ui fallback. |
| Body / UI | system-ui stack | Fast, dependable, zero payload. |
| Mono (URLs, IDs, tokens, stamps, deck labels) | **IBM Plex Mono** → `ui-monospace` | The infrastructure voice. |

Fluid scale with `clamp()`:
`--type-display` ~28–34px · `--type-title` ~20–23px · `--type-section` 16px ·
body 14px · `--type-small` 12.5px · `--type-micro` 11px (mono, uppercase,
letter-spaced — used for deck labels and stamps).

## 6. Surfaces — the manifest card

Cards are paper manifests, not floating glass:

- `--surface` background, 1px `--line-strong` border, **3px bottom border**
  (the "sturdy base" — this replaces drop-shadow depth).
- Radius 10px. Shadow only a whisper (`0 1px 2px` ink at 6%).
- The lead card of a page (`.shiplet-focus-strip`) gets a 4px buoy keel-line
  on its left edge.
- Sub-sections separate with **perforated rules** (dashed hairlines).
- Section eyebrows (`.success-card-label`) are mono micro deck labels.

Page background is flat warm paper. The header carries a **waterline**: a thin
repeating wave under a double ledger rule. That one detail does the work the
old grid wallpaper was failing to do.

## 7. Controls

- **Buttons**: sturdy. Primary = buoy fill, white text, darker 2px bottom
  border (press affordance). Secondary = paper fill, ink border. Destructive =
  signal. 36px tall desktop, ≥44px touch targets on mobile.
- **Inputs/selects/textareas**: native semantic elements, 1px ink border,
  paper-0 fill, harbor focus ring. Placeholders at AA-readable contrast.
- **Focus**: `:focus-visible` → 2px solid `--ring` with 2px offset, everywhere.
- **Stamps** (`.status-badge`, feedback ticket chips): mono uppercase, 1.5px
  border, tinted fill — looks rubber-stamped onto the manifest.
- **Tables**: ledger style — mono micro headers, hairline rows, row hover in
  paper-100.

### Review overlay

The injected review overlay borrows the compact, contextual structure of modern
preview-comment tools while keeping Shiplet's Harbor Office palette:

- One segmented toolbar groups Review, the page comment count, and settings.
- The desktop comment rail is a continuous thread list, not a stack of cards.
  Each thread co-locates author, time, ticket, status, replies, and reply input.
- A selected element opens one anchored editor with target context, reviewer
  identity, annotation access, cancel, and a labeled Add comment action.
- Numbered buoy-orange pins connect page locations to tickets; completed pins
  become neutral rather than disappearing.
- On small screens, the comment rail becomes a full-screen surface and all
  primary controls use touch-sized targets.

## 8. Motion

- One orchestrated page-load (staggered card rise + scene line-draw), then a
  few high-impact moments: the publish stepper's rope drawing between
  bollards, the arrival sail-in + stamp slam on the cockpit, ticket stagger.
- SVG line work animates via `pathLength="1"` + `stroke-dashoffset` (the
  `.draw-path` rule); 140ms `ease` on hover/active.
- **CSS owns anything visibility-critical** (it completes even when rAF
  throttles in background tabs). GSAP is embellishment only: the looping boat
  bob and other infinite ambience. Never gate an element's visibility on a
  JS-driven tween, and never add scene classes inside `requestAnimationFrame`.
- `@media (prefers-reduced-motion: reduce)` disables all of it; `.draw-path`
  falls back to fully drawn.

## 8b. Decoration art (the 2007 harbor office)

Real raster decorations, generated as transparent PNGs by the asset pipeline
and served from `/brand/decor/*`:

| Asset | Use |
| --- | --- |
| `rope-h.png` / `rope-v.png` | Twisted hemp rope tiles: `hr.solid`, reply-list rules, and the voyage rail behind the animated draw line |
| `rope-knot.png` | Coiled rope corner flourish on lead cards (publish panel, auth card) |
| `anchor.png` | Low-alpha admiralty anchor watermark (settings → Agents) |
| `compass.png` | Low-alpha compass rose watermark (cockpit → MCP panel) |

Rules: hemp tan (`#b08a5e`) for rope so it reads on both paper and night-watch
navy; watermarks bake their alpha into the pixels (harbor teal ≤ 13%); max one
watermark per screen; decorations never sit under dense text.

## 9. Layout

- Content max-width 1080px, 24px gutters (16px mobile).
- Shared shell: compact mark-only home control plus utility navigation over the
  waterline rule. The mark is the primary vessel; header waterline decoration is
  limited to waves, navigation markers, and control-adjacent ripples.
- Publish page: one column, dropzone-first.
- Settings: sticky local nav rail + stacked sections (collapses on mobile).
- The Bridge: preview iframe ~2fr, side stack (invites / feedback / MCP) 1fr.
- All multi-column grids collapse to one column under 640px.

## 10. Accessibility contract

- WCAG AA contrast on all text/control pairs (muted text ≥ 4.5:1 on paper).
- Keyboard: visible focus ring on every interactive element.
- Semantic native controls only; labels always associated with inputs.
- Reduced motion honored; no information conveyed by color alone (stamps carry
  text).

## 11. Engineering constraints (why it's built this way)

- Single inline stylesheet in `src/render.ts` (`CSS` constant) — server-rendered
  Worker, no build step. Token tiers live at `:root`.
- The dashboard runtime script owns element IDs (`projectForm`, `feedbackList`,
  …) and emits classes (`banner-*`, `dataTable`, `feedback-ticket*`,
  `inline-field-row`, `table-link`, `btn*`). These are API — restyle, never
  rename.
- Fonts are the only external request (one Google Fonts stylesheet,
  preconnected, swap). Everything else ships in the HTML.

## 12. Asset pipeline

Raster brand assets (`public/brand/logo.png`, `public/apple-touch-icon.png`,
`public/og-image.png`, and the base64 copies in
`src/generated-brand-assets.ts`) are generated from the mark by
`node scripts/generate-brand-assets.mjs`. Never edit the PNGs or the
generated TS by hand — change the SVG art in the script (keeping it in sync
with `SHIPLET_FAVICON_SVG` in `src/seo.ts`) and re-run it.

The injected review widget (`src/review-client.ts`) carries the palette as
self-contained hex values because it renders inside arbitrary artifact pages;
when tokens change, update its hex constants to match.
