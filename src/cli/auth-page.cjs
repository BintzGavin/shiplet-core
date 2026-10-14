// The loopback page must work offline, without remote fonts, scripts, or assets.
// It mirrors the hosted Harbor Office shell (DESIGN.md): the same semantic
// tokens, mark, waterline header, manifest card, and stamps. Token values and
// the mark are copied from src/render.ts and src/seo.ts; a drift test keeps
// them in sync.
const SHIPLET_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Shiplet" shape-rendering="geometricPrecision">
	<rect x="6" y="6" width="116" height="116" rx="26" fill="#fbf9f4" stroke="#20293a" stroke-width="7"/>
	<g transform="translate(0 -8)">
		<rect x="62" y="20" width="4" height="42" rx="2" fill="#20293a"/>
		<path d="M66 18l26 11-26 11z" fill="#c2502f"/>
		<rect x="40" y="62" width="21" height="20" rx="2" fill="#2f6e88"/>
		<rect x="67" y="62" width="21" height="20" rx="2" fill="#c2502f"/>
		<path d="M28 86h72l-13 24H41z" fill="#20293a"/>
		<path d="M29 118q7-7 14 0t14 0t14 0t14 0t14 0" fill="none" stroke="#2f6e88" stroke-width="5" stroke-linecap="round"/>
	</g>
</svg>`;

const LOOPBACK_TOKENS = {
  light: {
    "--bg": "oklch(97% 0.01 95)",
    "--surface": "oklch(99% 0.005 95)",
    "--text": "oklch(23% 0.04 255)",
    "--text-soft": "oklch(34% 0.035 255)",
    "--line": "oklch(80% 0.02 250)",
    "--line-strong": "oklch(23% 0.04 255)",
    "--ok": "oklch(42% 0.1 155)",
    "--ok-surface": "oklch(93% 0.055 155)",
    "--err": "oklch(50% 0.19 27)",
    "--err-surface": "oklch(93% 0.045 27)",
    "--mark-harbor": "#2f6e88",
    "--glow-warm": "color-mix(in oklch, oklch(93% 0.045 40), transparent 50%)",
    "--glow-cool": "color-mix(in oklch, oklch(92% 0.04 215), transparent 55%)",
  },
  dark: {
    "--bg": "oklch(21% 0.025 255)",
    "--surface": "oklch(25% 0.025 255)",
    "--text": "oklch(94% 0.01 95)",
    "--text-soft": "oklch(83% 0.015 95)",
    "--line": "oklch(38% 0.025 255)",
    "--line-strong": "oklch(62% 0.025 250)",
    "--ok": "oklch(80% 0.1 155)",
    "--ok-surface": "oklch(30% 0.05 155)",
    "--err": "oklch(78% 0.12 27)",
    "--err-surface": "oklch(30% 0.06 27)",
    "--mark-harbor": "oklch(70% 0.07 220)",
    "--glow-warm": "oklch(32% 0.05 40 / 0.5)",
    "--glow-cool": "oklch(30% 0.05 230 / 0.55)",
  },
};

function tokenBlock(tokens) {
  return Object.entries(tokens).map(([name, value]) => `${name}:${value}`).join(";");
}

// A static stand-in for the hosted header's animated sea: three swell layers.
function wave(y, amplitude, length, phase) {
  let path = `M${-phase} ${y}`;
  for (let x = -phase; x < 2400; x += length) path += ` q${length / 4} ${-amplitude} ${length / 2} 0 t${length / 2} 0`;
  return path;
}

const WATERLINE_SVG = `<svg class="waterline" viewBox="0 0 2400 34" preserveAspectRatio="xMinYMax slice" aria-hidden="true" focusable="false">
<path class="far" d="${wave(15, 3, 160, 40)}"/>
<path class="mid" d="${wave(21, 4, 112, 0)}"/>
<path class="near-body" d="${wave(26, 5, 136, 70)} V34 H-70 Z"/>
<path class="near" d="${wave(26, 5, 136, 70)}"/>
</svg>`;

function renderCliCallbackPage(valid, nonce) {
  const title = valid ? "You’re done. Return to your terminal." : "Authorization could not finish";
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex,nofollow,noarchive">
<title>${valid ? "Return to your terminal" : title} | Shiplet CLI</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;${tokenBlock(LOOPBACK_TOKENS.light)};--font-display:"Bricolage Grotesque",ui-sans-serif,system-ui,sans-serif;--font-body:ui-sans-serif,system-ui,sans-serif,"Apple Color Emoji","Segoe UI Emoji";--font-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme: dark){:root{${tokenBlock(LOOPBACK_TOKENS.dark)}}}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--bg)}
body{min-height:100vh;font-family:var(--font-body);font-size:.875rem;line-height:1.55;color:var(--text);background:radial-gradient(90rem 36rem at 82% -14rem,var(--glow-warm),transparent 70%),radial-gradient(70rem 30rem at -12% -10rem,var(--glow-cool),transparent 70%),var(--bg);background-attachment:fixed}
header{position:relative;overflow:hidden;min-height:66px;background:color-mix(in oklch,var(--surface),transparent 14%);border-bottom:2px solid var(--line-strong)}
.brand{position:relative;z-index:1;max-width:1080px;margin:0 auto;min-height:64px;padding:6px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand svg{display:block;width:40px;height:40px}
.brand span{font-family:var(--font-mono);font-size:.78rem;color:var(--text-soft)}
.waterline{position:absolute;inset:auto 0 0 0;width:100%;height:34px;fill:none;stroke:var(--mark-harbor);stroke-width:1.4;stroke-linecap:round}
.waterline .far{opacity:.46}.waterline .mid{opacity:.65}.waterline .near{opacity:.9}.waterline .near-body{fill:var(--mark-harbor);fill-opacity:.2;stroke:none}
main{display:grid;place-items:center;padding:clamp(24px,6vh,64px) 16px}
.card{display:grid;gap:20px;width:100%;max-width:520px;padding:26px;background:var(--surface);border:1px solid var(--line);border-bottom:3px solid var(--line-strong);border-radius:10px;box-shadow:0 1px 2px oklch(23% 0.04 255 / 0.06);overflow-wrap:anywhere}
.stamp{justify-self:start;font-family:var(--font-mono);font-size:.6875rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;padding:3px 8px;border:1.5px solid currentColor;border-radius:4px;transform:rotate(-1deg);color:var(--ok);background:var(--ok-surface)}
.stamp[data-tone="err"]{color:var(--err);background:var(--err-surface)}
h1{font-family:var(--font-display);font-size:clamp(1.6rem,1.2rem + 1.6vw,2.2rem);font-weight:800;line-height:1.15;letter-spacing:-.025em;text-wrap:balance}
p{color:var(--text-soft);line-height:1.6}
.next{padding-top:20px;border-top:1px dashed var(--line);color:var(--text)}
@media (max-width:640px){.brand{padding:6px 16px}.card{padding:22px}}
</style></head><body><header><div class="brand">${SHIPLET_MARK_SVG}<span>Local CLI</span></div>${WATERLINE_SVG}</header>
<main><section class="card" aria-labelledby="auth-title"><span class="stamp"${valid ? "" : ' data-tone="err"'}>${valid ? "Approval handed back" : "Authorization stopped"}</span>
<h1 id="auth-title">${title}</h1>
<p>${valid ? "Shiplet handed your approval to the CLI command waiting on this computer. The command finishes in your terminal or agent, so check there for its result." : "Authorization did not match this CLI process. Run your CLI command again and approve the new request in your browser."}</p>
<p class="next">${valid ? "You can close this tab." : "You can close this tab and return to your terminal."}</p>
</section></main></body></html>`;
}

module.exports = { renderCliCallbackPage, LOOPBACK_TOKENS, SHIPLET_MARK_SVG };
