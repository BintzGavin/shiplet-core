/** Runs only on the trusted Shiplet origin, never in the embedding website. */
export function embedAuthBootstrapScript() {
  return String.raw`(() => {
    "use strict";
    const buttons = document.querySelectorAll("[data-shiplet-embed-action]");
    const status = document.querySelector("[data-shiplet-embed-auth-status]");
    const statusText = document.querySelector("[data-shiplet-embed-auth-status-text]");
    const dismiss = document.querySelector("[data-shiplet-embed-auth-dismiss]");
    const installation = new URL(location.href).searchParams.get("installation_id") || "";
    const registeredPage = new URL(location.href).searchParams.get("return_url");
    let siteOrigin; try { siteOrigin = new URL(registeredPage).origin; } catch { return; }
    // Visitor feedback adds a third launcher, so the widget widens its toolbar for it.
    const visitor = document.querySelector("[data-shiplet-visitor-url]");
    // "Feedback only" for the public: with no review buttons the toolbar is
    // Feedback alone (one button wide), or nothing, so the widget hides itself.
    if (!buttons.length && !visitor) { if (parent !== window) parent.postMessage({ protocol: "shiplet.embed.ui.v1", view: "hidden" }, siteOrigin); return; }
    const size = !buttons.length ? { single: true } : visitor ? { agents: true } : {};
    function notify(view) { if (parent !== window) parent.postMessage(Object.assign({ protocol: "shiplet.embed.ui.v1", view }, size), siteOrigin); }
    function report(message) { statusText.textContent = message; status.hidden = false; notify("access"); }
    function collapse() { status.hidden = true; notify("toolbar"); }
    notify("toolbar");
    let popup = null;
    let exchanging = false;
    let action = "annotate";
    let closeTimer;
    for (const button of buttons) button.addEventListener("click", event => {
      if (!event.isTrusted) return;
      action = button.getAttribute("data-shiplet-embed-action");
      if (popup && !popup.closed) { popup.focus(); return; }
      popup = window.open(button.getAttribute("data-login-url"), "shiplet-embed-auth", "popup,width=560,height=720,resizable=yes,scrollbars=yes");
      if (!popup) { report("Allow the Shiplet sign-in popup, then choose Annotate or Comments again."); return; }
      collapse(); popup.focus();
      clearInterval(closeTimer);
      closeTimer = setInterval(() => {
        if (popup && popup.closed && !exchanging) {
          clearInterval(closeTimer); popup = null;
          report("Sign-in window closed. Choose Annotate or Comments to try again.");
        }
      }, 500);
    });
    dismiss.addEventListener("click", collapse);
    if (visitor) visitor.addEventListener("click", event => {
      if (!event.isTrusted) return;
      const target = new URL(visitor.getAttribute("data-shiplet-visitor-url") || "", location.origin);
      if (target.origin !== location.origin || target.pathname !== "/embed/visitor/frame") return;
      location.assign(target.toString());
    });
    window.addEventListener("message", async event => {
      if (!popup || event.source !== popup || event.origin !== location.origin || exchanging) return;
      const data = event.data;
      if (!data || data.protocol !== "shiplet.embed.auth.v1" || typeof data.ticket !== "string" || !/^shiplet_embed_auth_[A-Za-z0-9_-]{20,200}$/.test(data.ticket)) return;
      exchanging = true;
      try {
        const response = await fetch("/embed/review/authorize", { method: "POST", credentials: "include", body: new URLSearchParams({ ticket: data.ticket, installation_id: installation }) });
        if (!response.ok) throw new Error("exchange_failed");
        const result = await response.json();
        const host = new URL(result.hostUrl, location.origin);
        if (host.origin !== location.origin || host.pathname !== "/embed/review/host" || host.searchParams.get("installation_id") !== installation) throw new Error("invalid_host");
        try { sessionStorage.setItem("shiplet.embed.intent:" + installation, action); } catch {}
        clearInterval(closeTimer); popup.close(); location.replace(host.toString());
      } catch {
        report("Sign-in could not be completed. Close the sign-in window and choose Annotate or Comments to retry.");
        exchanging = false;
      }
    });
    window.addEventListener("pagehide", () => { clearInterval(closeTimer); if (popup && !popup.closed) popup.close(); });
  })();`;
}

export type EmbedSignedOutToolbar = "full" | "feedback" | "hidden";

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The signed-out page inside the widget. "full" is Annotate, Comments and,
 * with a visitor URL, Feedback. "feedback" is Feedback alone and "hidden" is
 * no toolbar at all, for a site whose public toolbar is Feedback only.
 */
export function embedAuthBootstrapHtml(input: {
  origin: string;
  siteOrigin: string;
  themeStylesheetUrl: string;
  nonce: string;
  loginUrl: string;
  visitorUrl: string | null;
  deniedAccount?: string;
  toolbar: EmbedSignedOutToolbar;
}) {
  const e = escapeHtml;
  const { origin, deniedAccount, loginUrl } = input;
  const notice = deniedAccount
    ? `<span class="shiplet-review-visually-hidden" role="alert">${e(deniedAccount)} needs review access. Sign in with another account to continue.</span>`
    : "";
  const visitorLink = input.visitorUrl
    ? `<button type="button" class="shiplet-review-launcher" data-shiplet-visitor-url="${e(input.visitorUrl)}" aria-label="Leave feedback without an account">Feedback</button>`
    : "";
  const reviewButtons =
    input.toolbar === "full"
      ? `<button type="button" class="shiplet-review-launcher" data-shiplet-embed-action="annotate" data-login-url="${e(loginUrl)}" aria-label="Annotate">Annotate</button><button type="button" class="shiplet-review-comments-launcher" data-shiplet-embed-action="comments" data-login-url="${e(loginUrl)}" aria-label="Open comments" title="Comments"><span class="shiplet-review-count" aria-hidden="true">…</span></button>`
      : "";
  const toolbar =
    input.toolbar === "hidden"
      ? ""
      : `<div class="shiplet-review-launcher-dock">${reviewButtons}${visitorLink}</div><div class="shiplet-embed-auth-status" data-shiplet-embed-auth-status hidden><span role="status" aria-live="polite" data-shiplet-embed-auth-status-text></span><button type="button" data-shiplet-embed-auth-dismiss>Dismiss</button></div>`;
  return `<!doctype html><html lang="en" data-shiplet-embed-auth-bootstrap="v1" data-shiplet-embed-origin="${e(input.siteOrigin)}"${deniedAccount ? ' data-review-state="permission_denied"' : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shiplet review</title><link rel="stylesheet" href="${origin}/api/review/host.css"><link rel="stylesheet" href="${e(input.themeStylesheetUrl)}"><script src="${origin}/api/embed/auth-bootstrap.js" nonce="${input.nonce}" defer></script></head><body>${notice}${toolbar}</body></html>`;
}
