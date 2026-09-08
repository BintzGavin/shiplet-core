import { trustedArtifactBridgeScript } from "./trusted-artifact-bridge";

/** A classic script: no bundler, framework runtime, host backend, or credential. */
export function embedWidgetScript() {
  return String.raw`(() => {
  "use strict";
  if (!window.customElements || customElements.get("shiplet-feedback")) return;
  const source = document.currentScript && document.currentScript.src;
  if (!source) return;
  const defaultOrigin = new URL(source).origin;
  ${trustedArtifactBridgeScript(true)}
  function safePageUrl() {
    const sensitive = /token|secret|password|credential|authorization|signature/i;
    const names = new Set(["claim", "claim_url", "code", "id_token", "key_pair_id", "magic_link", "nonce", "oauth_code", "policy", "reset_code", "session", "shiplet_code", "shiplet_embed_code", "sig", "signed", "state", "apikey"]);
    function clean(url, depth) {
      const fragment = url.hash; url.hash = "";
      if (fragment.startsWith("#/") && !fragment.startsWith("#//") && depth < 8) {
        const route = new URL(fragment.slice(1), url.origin);
        if (route.origin === url.origin) { const sanitized = clean(route, depth + 1); url.hash = "#" + sanitized.pathname + sanitized.search; }
      }
      const entries = Array.from(url.searchParams); url.search = "";
      for (const [key, value] of entries) {
        const normalized = key.trim().toLowerCase().replace(/-/g, "_");
        if (sensitive.test(normalized) || names.has(normalized) || normalized.startsWith("x_amz_") || normalized.replace(/[^a-z]/g, "") === "apikey") continue;
        let nested; try { nested = new URL(value); } catch {}
        if (nested && /^https?:$/.test(nested.protocol)) {
          if (depth >= 8 || nested.username || nested.password) continue;
          url.searchParams.append(key, clean(nested, depth + 1).toString());
        } else url.searchParams.append(key, value);
      }
      return url;
    }
    return clean(new URL(location.href), 0).toString();
  }
  class ShipletFeedback extends HTMLElement {
    static get observedAttributes() { return ["installation-id", "api-url", "disabled"]; }
    constructor() { super(); this.attachShadow({ mode: "open" }); }
    connectedCallback() { this.mount(); }
    disconnectedCallback() { this.dispose(); }
    attributeChangedCallback() { if (this.isConnected) this.mount(); }
    dispose() {
      this.close(); clearInterval(this.timer); this.timer = null;
      if (this.onKey) window.removeEventListener("keydown", this.onKey, true);
      this.shadowRoot.replaceChildren();
    }
    mount() {
      this.dispose();
      if (this.hasAttribute("disabled")) return;
      this.installation = (this.getAttribute("installation-id") || "").trim();
      let api; try { api = new URL(this.getAttribute("api-url") || defaultOrigin); } catch { return this.fail("Shiplet: invalid API URL."); }
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(this.installation)) return this.fail("Shiplet: add a valid installation-id.");
      if ((api.protocol !== "https:" && !(api.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(api.hostname))) || api.username || api.password || api.search || api.hash || api.pathname !== "/") return this.fail("Shiplet: use an HTTPS API origin, or localhost.");
      this.origin = api.origin;
      this.shadowRoot.innerHTML = '<link rel="stylesheet"><div class="pins"></div><section class="surface" aria-label="Shiplet feedback" hidden></section><button type="button" aria-label="Open Shiplet feedback" aria-expanded="false">Feedback</button>';
      this.shadowRoot.querySelector("link").href = this.origin + "/api/embed/widget.css";
      this.pins = this.shadowRoot.querySelector(".pins");
      this.surface = this.shadowRoot.querySelector(".surface");
      this.button = this.shadowRoot.querySelector("button");
      this.button.addEventListener("click", () => this.frame ? this.close() : this.open());
      this.onKey = event => { if (event.key === "Escape" && this.frame) { this.close(); this.button.focus(); } };
      window.addEventListener("keydown", this.onKey, true);
      this.page = safePageUrl();
      this.timer = setInterval(() => { this.positionPins(); const next = safePageUrl(); if (next !== this.page) { this.page = next; if (this.frame) { this.close(); this.open(); } } }, 400);
    }
    fail(message) { const status = document.createElement("span"); status.setAttribute("role", "status"); status.textContent = message; this.shadowRoot.append(status); }
    open() {
      if (this.frame || !this.surface) return;
      this.page = safePageUrl();
      const start = new URL("/embed/review/start", this.origin);
      start.searchParams.set("installation_id", this.installation);
      start.searchParams.set("return_url", this.page);
      this.frame = document.createElement("iframe");
      this.frame.title = "Shiplet feedback";
      this.frame.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-storage-access-by-user-activation");
      this.frame.setAttribute("allow", "storage-access");
      this.frame.referrerPolicy = "no-referrer";
      this.frame.src = start.toString();
      this.surface.replaceChildren(this.frame);
      this.surface.hidden = false;
      this.button.textContent = "Close feedback";
      this.button.setAttribute("aria-label", "Close Shiplet feedback");
      this.button.setAttribute("aria-expanded", "true");
      this.cleanupBridge = attachShipletPageBridge(this.frame, this.origin);
      this.onMessage = event => {
        if (!this.frame || event.source !== this.frame.contentWindow || event.origin !== this.origin) return;
        const data = event.data;
        if (!data || data.protocol !== "shiplet.embed.ui.v1") return;
        clearTimeout(this.loadTimer);
        this.surface.querySelector(".recovery")?.remove();
        if (typeof data.composing === "boolean") this.surface.dataset.composing = String(data.composing);
        if (typeof data.selecting === "boolean") { this.surface.dataset.selecting = String(data.selecting); this.pins.hidden = data.selecting; }
        if (Array.isArray(data.pins)) this.renderPins(data.pins);
      };
      window.addEventListener("message", this.onMessage);
      this.loadTimer = setTimeout(() => this.recovery(), 15000);
      this.frame.addEventListener("error", () => this.recovery());
    }
    renderPins(items) {
      this.pins.replaceChildren(); this.pinItems = [];
      for (const item of items.slice(0, 100)) {
        if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index >= 100 || typeof item.selector !== "string" || item.selector.length > 1200 || !Number.isFinite(item.pageX) || !Number.isFinite(item.pageY)) continue;
        const button = document.createElement("button"); button.type = "button"; button.textContent = String(item.index + 1); button.setAttribute("aria-label", "Open comment " + (item.index + 1));
        button.addEventListener("click", () => this.frame?.contentWindow.postMessage({ protocol: "shiplet.embed.focus.v1", index: item.index }, this.origin));
        this.pins.append(button); this.pinItems.push({ ...item, button });
      }
      this.positionPins();
    }
    positionPins() {
      for (const item of this.pinItems || []) {
        let target; try { target = item.selector && document.querySelector(item.selector); } catch {}
        const rect = target?.getBoundingClientRect();
        const x = rect ? rect.left + Math.min(rect.width, 24) : item.pageX - scrollX;
        const y = rect ? rect.top - 12 : item.pageY - scrollY - 16;
        item.button.hidden = x < 0 || x > innerWidth || y < -16 || y > innerHeight || Boolean(target?.closest("[data-shiplet-private],shiplet-feedback"));
        item.button.style.left = Math.max(0, x) + "px"; item.button.style.top = Math.max(0, y) + "px";
      }
    }
    recovery() {
      if (!this.frame) return;
      if (this.surface.querySelector(".recovery")) return;
      const box = document.createElement("div"); box.className = "recovery";
      const status = document.createElement("p"); status.setAttribute("role", "status"); status.textContent = "Shiplet could not connect. Check your connection and site CSP.";
      const retry = document.createElement("button"); retry.textContent = "Retry"; retry.onclick = () => { this.close(); this.open(); };
      const help = document.createElement("a"); help.href = this.origin + "/docs/embed"; help.target = "_blank"; help.rel = "noopener noreferrer"; help.textContent = "Install help";
      box.append(status, retry, help); this.surface.append(box);
    }
    close() {
      clearTimeout(this.loadTimer);
      if (this.cleanupBridge) this.cleanupBridge(); this.cleanupBridge = null;
      if (this.onMessage) window.removeEventListener("message", this.onMessage);
      this.frame?.remove(); this.frame = null;
      this.pinItems = []; this.pins?.replaceChildren();
      if (this.surface) { this.surface.hidden = true; this.surface.replaceChildren(); delete this.surface.dataset.selecting; delete this.surface.dataset.composing; }
      if (this.button) { this.button.textContent = "Feedback"; this.button.setAttribute("aria-label", "Open Shiplet feedback"); this.button.setAttribute("aria-expanded", "false"); }
    }
  }
  customElements.define("shiplet-feedback", ShipletFeedback);
})();`;
}

export const EMBED_WIDGET_CSS =
  ':host{all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;font:14px/1.4 system-ui,sans-serif;color:#20293a}*{box-sizing:border-box}button{font:700 14px system-ui;cursor:pointer;border:1px solid #8f321c;border-radius:24px;background:#b44729;color:white;min-height:44px;padding:10px 18px;box-shadow:0 3px 14px #0002}button:focus-visible,a:focus-visible{outline:3px solid #2f6e88;outline-offset:3px}.surface{position:fixed;right:16px;bottom:72px;width:min(420px,calc(100vw - 32px));height:min(680px,calc(100dvh - 96px));border:1px solid #bcc3ca;border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 16px 48px #0f172a33}.surface[hidden]{display:none}iframe{display:block;width:100%;height:100%;border:0;background:white}.recovery{padding:14px;background:#f4f1e9;display:flex;gap:12px;align-items:center;flex-wrap:wrap}.recovery a{color:#245b72}.recovery p{margin:0}.surface[data-selecting=true]{height:54px}.surface[data-selecting=true] iframe{visibility:hidden}.surface[data-selecting=true]::after{content:"Select an element on the page \u00b7 Escape to cancel";position:absolute;inset:0;padding:16px;background:#edf5f7;color:#245b72;font:600 13px system-ui}.pins button{position:fixed;border-radius:50%;padding:0;min-height:32px;width:32px;height:32px;background:#2f6e88;border-color:#245b72}.pins[hidden]{display:none}.recovery{position:absolute;inset:auto 0 0;z-index:2}.surface[data-composing=true]:not([data-selecting=true]){height:min(430px,calc(100dvh - 96px))}';
