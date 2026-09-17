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
    function notify(view) { if (parent !== window) parent.postMessage({ protocol: "shiplet.embed.ui.v1", view }, siteOrigin); }
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
