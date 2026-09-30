// The loopback page must work offline, without remote fonts, scripts, or assets.
// Colors and control shapes follow DESIGN.md's Harbor Office semantic palette.
function renderCliCallbackPage(valid, nonce) {
  const title = valid ? "Return to your terminal" : "Authorization could not finish";
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex,nofollow,noarchive">
<title>${title} | Shiplet CLI</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;--bg:oklch(97% .01 95);--surface:oklch(99% .005 95);--text:oklch(23% .04 255);--muted:oklch(34% .035 255);--line:oklch(80% .02 250);--accent:oklch(40% .075 220);--ok:oklch(42% .1 155);--ok-surface:oklch(93% .055 155);--err:oklch(50% .19 27);--err-surface:oklch(93% .045 27)}
@media(prefers-color-scheme: dark){:root{--bg:oklch(18% .025 255);--surface:oklch(23% .03 255);--text:oklch(94% .01 95);--muted:oklch(82% .02 250);--line:oklch(43% .03 255);--accent:oklch(78% .08 215);--ok:oklch(80% .1 155);--ok-surface:oklch(28% .045 155);--err:oklch(80% .1 27);--err-surface:oklch(28% .045 27)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,sans-serif}
header{padding:24px clamp(20px,5vw,64px);border-bottom:1px solid var(--line);font-size:24px;font-weight:750;letter-spacing:-.03em}
header span{font:13px ui-monospace,monospace;color:var(--muted);letter-spacing:0;margin-left:12px}
main{width:min(520px,calc(100% - 32px));margin:clamp(32px,9vh,88px) auto;padding:clamp(24px,5vw,40px);background:var(--surface);border:1px solid var(--line);border-bottom:3px solid var(--text);border-radius:10px;overflow-wrap:anywhere}
.status{display:inline-block;padding:4px 10px;border:1px solid currentColor;border-radius:6px;font-size:13px;font-weight:650;color:var(${valid ? "--ok" : "--err"});background:var(${valid ? "--ok-surface" : "--err-surface"})}
h1{font-size:32px;line-height:1.15;letter-spacing:-.03em;margin:20px 0 16px;text-wrap:balance}p{color:var(--muted);margin:0 0 16px}.next{border-top:1px dashed var(--line);padding-top:20px;margin-top:24px;margin-bottom:0;color:var(--text)}
</style></head><body><header>Shiplet<span>CLI access</span></header>
<main aria-labelledby="auth-title"><span class="status">${valid ? "Browser approval received" : "Authorization stopped"}</span>
<h1 id="auth-title">${title}</h1>
<p>${valid ? "Your CLI is completing the connection. Check your terminal or agent for the command’s result." : "Authorization did not match this CLI process. Run your CLI command again and approve the new request in your browser."}</p>
<p class="next">${valid ? "You can close this window." : "You can close this window and return to your terminal."}</p>
</main></body></html>`;
}

module.exports = { renderCliCallbackPage };
