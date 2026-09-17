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
      if (this.onResize) window.removeEventListener("resize", this.onResize);
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
      this.shadowRoot.innerHTML = '<link rel="stylesheet"><div class="pins"></div><section class="surface" data-view="toolbar" aria-label="Shiplet review tools"></section>';
      this.shadowRoot.querySelector("link").href = this.origin + "/api/embed/widget.css";
      this.pins = this.shadowRoot.querySelector(".pins");
      this.surface = this.shadowRoot.querySelector(".surface");
      this.onKey = event => { if (event.isTrusted && event.key === "Escape" && this.frame) this.frame.contentWindow.postMessage({ protocol: "shiplet.embed.dismiss.v1" }, this.origin); };
      window.addEventListener("keydown", this.onKey, true);
      this.onResize = () => this.positionSurface();
      window.addEventListener("resize", this.onResize);
      this.page = safePageUrl();
      this.open();
      this.timer = setInterval(() => { this.positionPins(); const next = safePageUrl(); if (next !== this.page) { this.page = next; this.close(); this.open(); } }, 400);
    }
    fail(message) { const status = document.createElement("span"); status.setAttribute("role", "status"); status.textContent = message; this.shadowRoot.append(status); }
    open() {
      if (this.frame || !this.surface) return;
      this.page = safePageUrl();
      const start = new URL("/embed/review/start", this.origin);
      start.searchParams.set("installation_id", this.installation);
      start.searchParams.set("return_url", this.page);
      this.frame = document.createElement("iframe");
      this.frame.title = "Shiplet review tools";
      this.frame.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-storage-access-by-user-activation");
      this.frame.setAttribute("allow", "storage-access");
      this.frame.referrerPolicy = "no-referrer";
      this.frame.src = start.toString();
      this.surface.replaceChildren(this.frame);
      this.surface.hidden = false;
      this.surface.dataset.view = "toolbar";
      this.positionSurface();
      this.cleanupBridge = attachShipletPageBridge(this.frame, this.origin);
      this.onMessage = event => {
        if (!this.frame || event.source !== this.frame.contentWindow || event.origin !== this.origin) return;
        const data = event.data;
        if (!data || data.protocol !== "shiplet.embed.ui.v1") return;
        clearTimeout(this.loadTimer);
        this.surface.querySelector(".recovery")?.remove();
        if (["toolbar", "comments", "selecting", "composer", "expanded", "drawing", "access"].includes(data.view)) {
          this.surface.dataset.view = data.view;
          this.pins.hidden = data.view === "selecting";
          this.anchor = data.anchor && Number.isFinite(data.anchor.x) && Number.isFinite(data.anchor.y) ? data.anchor : null;
          this.positionSurface();
        }
        if (Array.isArray(data.pins)) this.renderPins(data.pins);
      };
      window.addEventListener("message", this.onMessage);
      this.loadTimer = setTimeout(() => this.recovery(), 15000);
      this.frame.addEventListener("error", () => this.recovery());
    }
    positionSurface() {
      if (!this.surface) return;
      this.surface.style.left = ""; this.surface.style.top = "";
      const view = this.surface.dataset.view;
      if ((view === "composer" || view === "expanded") && this.anchor && innerWidth > 480) {
        const rect = this.surface.getBoundingClientRect();
        const x = this.anchor.x - scrollX, y = this.anchor.y - scrollY;
        const left = x + rect.width + 70 < innerWidth ? x + 54 : x - rect.width - 54;
        this.surface.style.left = Math.max(8, Math.min(innerWidth - rect.width - 8, left)) + "px";
        this.surface.style.top = Math.max(8, Math.min(innerHeight - rect.height - 8, y + 24)) + "px";
      }
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
      this.surface.dataset.view = "access";
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
      this.anchor = null;
    }
  }
  customElements.define("shiplet-feedback", ShipletFeedback);
})();`;
}

export const EMBED_WIDGET_CSS = String.raw`
:host{all:initial;position:fixed;right:0;bottom:0;z-index:2147483647;font:14px/1.4 system-ui,sans-serif;color:#20293a}*{box-sizing:border-box}
.surface{position:fixed;right:4px;bottom:4px;width:188px;height:72px;border:0;background:transparent}.surface[hidden]{display:none}iframe{display:block;width:100%;height:100%;border:0;background:transparent;color-scheme:normal}
.surface[data-view=comments]{width:min(420px,100vw);height:min(680px,100dvh)}
.surface[data-view=selecting]{top:4px;left:50%;bottom:auto;right:auto;transform:translateX(-50%);width:min(560px,100vw);height:76px}
.surface[data-view=composer]{width:min(384px,100vw);height:112px}
.surface[data-view=expanded]{width:min(408px,100vw);height:min(460px,100dvh)}
.surface[data-view=drawing]{inset:0;width:100vw;height:100dvh}
.surface[data-view=access]{width:min(368px,100vw);height:188px}
.pins button{position:fixed;border-radius:50%;padding:0;min-height:32px;width:32px;height:32px;background:#fff;color:#20293a;border:2px solid #20293a;font:800 12px system-ui;cursor:pointer;box-shadow:0 3px 10px #0003}.pins[hidden]{display:none}
.recovery{position:absolute;inset:8px;padding:16px;border:1px solid #c8cbd3;border-radius:12px;background:#fbf9f4;display:flex;gap:12px;align-items:center;flex-wrap:wrap}.recovery a{color:#245b72}.recovery p{margin:0}.recovery button{min-height:44px;padding:8px 16px;border:1px solid #20293a;border-radius:8px;background:#20293a;color:#fff;font:700 14px system-ui;cursor:pointer}button:focus-visible,a:focus-visible{outline:3px solid #2f6e88;outline-offset:3px}
@media(max-width:480px){.surface{right:0;bottom:0}.surface[data-view=comments]{height:100dvh;width:100vw}.surface[data-view=expanded]{height:min(460px,100dvh)}}
`;
