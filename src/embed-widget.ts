import { trustedArtifactBridgeScript } from "./trusted-artifact-bridge";

/** A classic script: no bundler, framework runtime, host backend, or credential. */
export function embedWidgetScript() {
  return String.raw`(() => {
  "use strict";
  if (!window.customElements || customElements.get("shiplet-feedback")) return;
  const source = document.currentScript && document.currentScript.src;
  if (!source) return;
  const defaultOrigin = new URL(source).origin;
  const allowedDocks = ["top-left", "top-right", "bottom-left", "bottom-right"];
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
    constructor() { super(); this.attachShadow({ mode: "open" }); this.focusEpoch = 0; this.overlayVisible = true; this.routeTransition = null; this.pinStacks = []; }
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
      this.shadowRoot.innerHTML = '<link rel="stylesheet"><button type="button" class="overlay-toggle" aria-label="Hide comments">Hide comments</button><div class="pins"></div><section id="shiplet-embedded-review-surface" class="surface" data-view="toolbar" aria-label="Shiplet review tools"></section>';
      this.shadowRoot.querySelector("link").href = this.origin + "/api/embed/widget.css";
      this.pins = this.shadowRoot.querySelector(".pins");
      this.surface = this.shadowRoot.querySelector(".surface");
      this.overlayToggle = this.shadowRoot.querySelector(".overlay-toggle");
      this.overlayToggle.addEventListener("click", () => {
        this.overlayVisible = !this.overlayVisible;
        this.overlayToggle.textContent = this.overlayVisible ? "Hide comments" : "Show comments";
        this.overlayToggle.setAttribute("aria-label", this.overlayVisible ? "Hide comments" : "Show comments");
        this.positionPins();
        this.frame?.contentWindow.postMessage({ protocol: "shiplet.embed.overlay.v1", type: "set", visible: this.overlayVisible }, this.origin);
      });
      this.onKey = event => { if (event.isTrusted && !event.isComposing && event.key === "Escape" && this.frame) this.frame.contentWindow.postMessage({ protocol: "shiplet.embed.dismiss.v1" }, this.origin); };
      window.addEventListener("keydown", this.onKey, true);
      this.onResize = () => this.positionSurface();
      window.addEventListener("resize", this.onResize);
      this.page = safePageUrl();
      this.open();
      this.timer = setInterval(() => { this.positionPins(); const next = safePageUrl(); if (next !== this.page) this.requestRouteTransition(next); }, 400);
    }
    fail(message) { const status = document.createElement("span"); status.setAttribute("role", "status"); status.textContent = message; this.shadowRoot.append(status); }
    open() {
      if (this.frame || !this.surface) return;
      this.focusEpoch += 1;
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
        if (!data || (data.protocol !== "shiplet.embed.ui.v1" && data.protocol !== "shiplet.embed.route-transition.v1" && data.protocol !== "shiplet.embed.presentation.v1")) return;
        if (data.protocol === "shiplet.embed.presentation.v1") {
          if (Object.keys(data).length !== 4 || !allowedDocks.includes(data.dock) || typeof data.overlayVisible !== "boolean" || typeof data.reviewVisible !== "boolean") return;
          this.setAttribute("data-dock", data.dock);
          this.overlayVisible = data.overlayVisible;
          this.overlayToggle.hidden = !data.reviewVisible;
          this.surface.hidden = !data.reviewVisible;
          this.pins.hidden = !data.reviewVisible || !data.overlayVisible;
          this.positionPins();
          return;
        }
        if (data.protocol === "shiplet.embed.route-transition.v1") {
          if (data.type === "retained") {
            if (Object.keys(data).length !== 5 || typeof data.pageUrl !== "string" || data.pageUrl.length > 4096 || typeof data.retained !== "boolean" || typeof data.safeToReplace !== "boolean") return;
            if (!this.routeTransition || this.routeTransition.page !== data.pageUrl) return;
            clearTimeout(this.routeTransition.timer);
            this.routeTransition = null;
            if (data.safeToReplace) { this.page = data.pageUrl; this.positionPins(); }
            else this.surface.dataset.view = this.surface.dataset.view || "toolbar";
            return;
          }
          if (Object.keys(data).length !== 5 || data.type !== "request" || typeof data.pageUrl !== "string" || data.pageUrl.length > 4096 || typeof data.overlayVisible !== "boolean" || typeof data.retained !== "boolean") return;
          if (this.routeTransition && this.routeTransition.page === data.pageUrl) this.frame.contentWindow.postMessage({ protocol: "shiplet.embed.route-transition.v1", type: "retained", pageUrl: data.pageUrl, retained: data.retained, safeToReplace: true }, this.origin);
          return;
        }
        clearTimeout(this.loadTimer);
        this.surface.querySelector(".recovery")?.remove();
        if (["toolbar", "comments", "thread", "selecting", "composer", "expanded", "drawing", "access"].includes(data.view)) {
          const previousView = this.surface.dataset.view;
          const focusEpoch = ++this.focusEpoch;
          this.surface.dataset.view = data.view;
          this.pins.hidden = data.view === "selecting";
          this.anchor = data.anchor && Number.isFinite(data.anchor.x) && Number.isFinite(data.anchor.y) ? data.anchor : null;
          if (typeof data.activeFeedbackId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(data.activeFeedbackId)) this.selectedFeedbackId = data.activeFeedbackId;
          if (typeof data.overlayVisible === "boolean") { this.overlayVisible = data.overlayVisible; this.overlayToggle.textContent = this.overlayVisible ? "Hide comments" : "Show comments"; this.overlayToggle.setAttribute("aria-label", this.overlayVisible ? "Hide comments" : "Show comments"); this.pins.hidden = !this.overlayVisible || data.view === "selecting"; }
          if (previousView === "thread" && data.view !== "thread") {
            const feedbackId = this.selectedFeedbackId || "";
            const legacyIndex = feedbackId ? -1 : this.selectedPinIndex;
            const frame = this.frame;
            const page = this.page;
            requestAnimationFrame(() => {
              if (this.focusEpoch !== focusEpoch || !this.isConnected || this.frame !== frame || this.page !== page || this.surface?.dataset.view === "thread") return;
              const selected = feedbackId ? (this.pinItems || []).find(item => item.feedbackId === feedbackId) : Number.isInteger(legacyIndex) && legacyIndex >= 0 && legacyIndex < 250 ? (this.pinItems || []).find(item => item.index === legacyIndex && !item.feedbackId) : null;
              const button = selected?.button;
              if (button?.isConnected && button.getRootNode() === this.shadowRoot) button.focus({ preventScroll: true });
            });
            this.selectedFeedbackId = ""; this.selectedPinIndex = -1;
          }
          this.positionPins();
        }
        if (Array.isArray(data.pins)) this.renderPins(data.pins);
      };
      window.addEventListener("message", this.onMessage);
      this.loadTimer = setTimeout(() => this.recovery(), 15000);
      this.frame.addEventListener("error", () => this.recovery());
    }
    requestRouteTransition(next) {
      if (!this.frame || !this.surface || this.routeTransition) return;
      const transition = { page: next, epoch: ++this.focusEpoch, timer: null };
      this.routeTransition = transition;
      this.frame.contentWindow.postMessage({ protocol: "shiplet.embed.route-transition.v1", type: "request", pageUrl: next, overlayVisible: this.overlayVisible, retained: true }, this.origin);
      transition.timer = setTimeout(() => {
        if (!this.routeTransition || this.routeTransition.page !== next) return;
        this.page = next;
        this.routeTransition = null;
        this.close();
        this.open();
      }, 1500);
    }
    positionSurface() {
      if (!this.surface) return;
      this.surface.style.left = ""; this.surface.style.top = "";
      const view = this.surface.dataset.view;
      const selected = view === "thread" ? (this.pinItems || []).find(item => item.feedbackId && item.feedbackId === this.selectedFeedbackId) || (this.pinItems || []).find(item => item.index === this.selectedPinIndex) : null;
      const anchor = selected && Number.isFinite(selected.viewportX) && Number.isFinite(selected.viewportY) ? { x: selected.viewportX + scrollX, y: selected.viewportY + scrollY } : this.anchor;
      if ((view === "composer" || view === "expanded" || view === "thread") && anchor && innerWidth > 480) {
        const rect = this.surface.getBoundingClientRect();
        const x = anchor.x - scrollX, y = anchor.y - scrollY;
        const left = x + rect.width + 70 < innerWidth ? x + 54 : x - rect.width - 54;
        this.surface.style.left = Math.max(8, Math.min(innerWidth - rect.width - 8, left)) + "px";
        this.surface.style.top = Math.max(8, Math.min(innerHeight - rect.height - 8, view === "thread" ? y - 40 : y + 24)) + "px";
      }
    }
    renderPins(items) {
      this.pins.replaceChildren(); this.pinItems = []; this.pinStacks = [];
      for (const item of items.slice(0, 250)) {
        if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index >= 1000000) continue;
        const geometry = item.geometry && typeof item.geometry === "object" ? item.geometry : null;
        if (geometry && (!Number.isFinite(geometry.viewportX) || !Number.isFinite(geometry.viewportY) || geometry.eligible !== true || geometry.offscreen === true)) continue;
        if (!geometry && (typeof item.selector !== "string" || item.selector.length > 1200 || !Number.isFinite(item.pageX) || !Number.isFinite(item.pageY))) continue;
        const feedbackId = typeof item.feedbackId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(item.feedbackId) ? item.feedbackId : "";
        const ticket = typeof item.ticket === "string" && item.ticket.length > 0 && item.ticket.length <= 120 ? item.ticket : "Comment " + (item.index + 1);
        const label = typeof item.label === "string" && item.label.length > 0 && item.label.length <= 12 ? item.label : String(item.index + 1);
        const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.setAttribute("aria-label", "Open " + ticket); button.setAttribute("aria-expanded", "false"); button.setAttribute("aria-controls", "shiplet-embedded-review-surface");
        button.addEventListener("click", () => {
          this.focusEpoch += 1;
          this.selectedFeedbackId = feedbackId; this.selectedPinIndex = item.index;
          this.frame?.contentWindow.postMessage(feedbackId ? { protocol: "shiplet.embed.focus.v1", feedbackId, index: item.index } : { protocol: "shiplet.embed.focus.v1", index: item.index }, this.origin);
        });
        this.pins.append(button); this.pinItems.push({ ...item, geometry, feedbackId, ticket, label, button });
      }
      this.positionPins();
      this.renderPinStacks();
      this.positionPins();
    }
    renderPinStacks() {
      const candidates = (this.pinItems || []).slice();
      const visited = new Set();
      for (const entry of candidates) {
        if (visited.has(entry.index)) continue;
        const group = [];
        const queue = [entry];
        visited.add(entry.index);
        while (queue.length) {
          const current = queue.shift();
          group.push(current);
          for (const other of candidates) {
            if (visited.has(other.index)) continue;
            if (Math.abs(current.viewportX - other.viewportX) <= 36 && Math.abs(current.viewportY - other.viewportY) <= 36) {
              visited.add(other.index);
              queue.push(other);
            }
          }
        }
        if (group.length < 2) continue;
        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "pin-stack";
        trigger.textContent = String(group.length);
        trigger.setAttribute("aria-label", group.length + " comments at this location");
        trigger.setAttribute("aria-haspopup", "menu");
        trigger.setAttribute("aria-expanded", "false");
        const menu = document.createElement("div");
        menu.className = "pin-stack-menu";
        menu.setAttribute("role", "menu");
        menu.hidden = true;
        for (const member of group) {
          member.button.hidden = true;
          const choice = document.createElement("button");
          choice.type = "button";
          choice.setAttribute("role", "menuitem");
          choice.textContent = member.ticket + " · Comment";
          choice.addEventListener("click", () => {
            menu.hidden = true;
            trigger.setAttribute("aria-expanded", "false");
            member.button.hidden = false;
            member.button.click();
          });
          menu.appendChild(choice);
        }
        trigger.addEventListener("click", () => {
          const opening = menu.hidden;
          for (const stack of this.pinStacks) { stack.menu.hidden = true; stack.trigger.setAttribute("aria-expanded", "false"); }
          menu.hidden = !opening;
          trigger.setAttribute("aria-expanded", opening ? "true" : "false");
          if (opening) menu.querySelector("button")?.focus();
        });
        menu.addEventListener("keydown", (event) => {
          const choices = Array.from(menu.querySelectorAll("button"));
          const index = choices.indexOf(document.activeElement);
          if (event.key === "Escape") { event.preventDefault(); menu.hidden = true; trigger.setAttribute("aria-expanded", "false"); trigger.focus(); }
          else if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); choices[(index + 1 + choices.length) % choices.length]?.focus(); }
          else if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); choices[(index - 1 + choices.length) % choices.length]?.focus(); }
          else if (event.key === "Home") { event.preventDefault(); choices[0]?.focus(); }
          else if (event.key === "End") { event.preventDefault(); choices[choices.length - 1]?.focus(); }
        });
        this.pins.append(trigger, menu);
        this.pinStacks.push({ entries: group, trigger, menu });
      }
      this.positionPinStacks();
    }
    positionPinStacks() {
      for (const stack of this.pinStacks || []) {
        const visible = stack.entries.filter((entry) => !entry.button.hidden);
        const points = stack.entries.map((entry) => ({ x: entry.viewportX, y: entry.viewportY })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= innerWidth && point.y >= -16 && point.y <= innerHeight);
        if (!this.overlayVisible || !points.length || visible.length === stack.entries.length) { stack.trigger.hidden = !this.overlayVisible; stack.menu.hidden = true; continue; }
        const point = points.reduce((sum, value) => ({ x: sum.x + value.x, y: sum.y + value.y }), { x: 0, y: 0 });
        point.x /= points.length; point.y /= points.length;
        stack.trigger.hidden = false;
        stack.trigger.style.left = Math.max(0, point.x) + "px";
        stack.trigger.style.top = Math.max(0, point.y) + "px";
        stack.menu.style.left = Math.max(8, Math.min(innerWidth - 328, point.x - 150)) + "px";
        stack.menu.style.top = Math.max(8, Math.min(innerHeight - 180, point.y + 24)) + "px";
      }
    }
    positionPins() {
      for (const item of this.pinItems || []) {
        const target = null;
        const x = item.geometry ? item.geometry.viewportX : item.pageX - scrollX;
        const y = item.geometry ? item.geometry.viewportY : item.pageY - scrollY - 16;
        item.viewportX = x; item.viewportY = y;
        item.button.hidden = !this.overlayVisible || x < 0 || x > innerWidth || y < -16 || y > innerHeight || Boolean(target?.closest("[data-shiplet-private],shiplet-feedback"));
        item.button.style.left = Math.max(0, x) + "px"; item.button.style.top = Math.max(0, y) + "px";
        const active = item.feedbackId ? item.feedbackId === this.selectedFeedbackId : item.index === this.selectedPinIndex;
        item.button.setAttribute("data-active", active ? "true" : "false"); item.button.setAttribute("aria-expanded", active && this.surface?.dataset.view === "thread" ? "true" : "false");
      }
      this.positionPinStacks();
      this.positionSurface();
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
      this.focusEpoch += 1;
      clearTimeout(this.loadTimer);
      if (this.routeTransition?.timer) clearTimeout(this.routeTransition.timer);
      this.routeTransition = null;
      if (this.cleanupBridge) this.cleanupBridge(); this.cleanupBridge = null;
      if (this.onMessage) window.removeEventListener("message", this.onMessage);
      this.frame?.remove(); this.frame = null;
      this.pinItems = []; this.pinStacks = []; this.pins?.replaceChildren();
      if (this.surface) { this.surface.hidden = true; this.surface.replaceChildren(); delete this.surface.dataset.selecting; delete this.surface.dataset.composing; }
      this.anchor = null;
      this.selectedFeedbackId = ""; this.selectedPinIndex = -1;
    }
  }
  customElements.define("shiplet-feedback", ShipletFeedback);
})();`;
}

export const EMBED_WIDGET_CSS = String.raw`
:host{all:initial;position:fixed;right:0;bottom:0;z-index:2147483647;font:14px/1.4 system-ui,sans-serif;color:#20293a}*{box-sizing:border-box}
:host([data-dock=top-left]){left:0;right:auto;top:0;bottom:auto}:host([data-dock=top-right]){left:auto;right:0;top:0;bottom:auto}:host([data-dock=bottom-left]){left:0;right:auto;top:auto;bottom:0}:host([data-dock=bottom-right]){left:auto;right:0;top:auto;bottom:0}
:host([data-dock=top-left]) .surface,:host([data-dock=top-right]) .surface{top:max(4px,env(safe-area-inset-top));bottom:auto}:host([data-dock=top-left]) .surface,:host([data-dock=bottom-left]) .surface{left:max(4px,env(safe-area-inset-left));right:auto}:host([data-dock=top-right]) .surface,:host([data-dock=bottom-right]) .surface{right:max(4px,env(safe-area-inset-right));left:auto}
.surface{position:fixed;right:4px;bottom:4px;width:188px;height:72px;border:0;background:transparent}.surface[hidden]{display:none}iframe{display:block;width:100%;height:100%;border:0;background:transparent;color-scheme:normal}
.surface[data-view=comments]{width:min(420px,100vw);height:min(680px,100dvh)}
.surface[data-view=thread]{width:min(440px,calc(100vw - 16px));height:min(560px,calc(100dvh - 16px))}
.surface[data-view=selecting]{top:4px;left:50%;bottom:auto;right:auto;transform:translateX(-50%);width:min(560px,100vw);height:76px}
.surface[data-view=composer]{width:min(384px,100vw);height:112px}
.surface[data-view=expanded]{width:min(408px,100vw);height:min(460px,100dvh)}
.surface[data-view=drawing]{inset:0;width:100vw;height:100dvh}
.surface[data-view=access]{width:min(368px,100vw);height:188px}
.overlay-toggle{position:fixed;right:8px;bottom:80px;z-index:3;min-height:32px;padding:0 9px;border:1px solid #c8cbd3;border-radius:7px;background:#fbf9f4;color:#20293a;font:700 11px system-ui;cursor:pointer;box-shadow:0 3px 10px #0003}.overlay-toggle:focus-visible{outline:3px solid #2f6e88;outline-offset:3px}
.pins button{position:fixed;border-radius:50%;padding:0;min-height:32px;min-width:32px;width:auto;height:32px;background:#fff;color:#20293a;border:2px solid #20293a;font:800 12px system-ui;cursor:pointer;box-shadow:0 3px 10px #0003}.pins button[data-active=true]{background:#a73f28;color:#fff;box-shadow:0 0 0 2px #20293a,0 4px 12px #0004}.pins .pin-stack{background:#a73f28;color:#fff;border-color:#fff}.pins .pin-stack-menu{position:fixed;z-index:2;display:grid;gap:4px;width:min(320px,calc(100vw - 16px));max-height:min(220px,calc(100vh - 16px));padding:6px;overflow:auto;border:1px solid #c8cbd3;border-radius:9px;background:#fff;box-shadow:0 10px 28px #0004}.pins .pin-stack-menu[hidden]{display:none}.pins .pin-stack-menu button{position:static;width:100%;height:auto;min-height:36px;padding:6px 8px;border:1px solid transparent;border-radius:6px;background:#fff;color:#20293a;font:700 11px/1.3 system-ui;text-align:left;box-shadow:none}.pins .pin-stack-menu button:hover,.pins .pin-stack-menu button:focus-visible{border-color:#2f6e88;background:#edf5f7;outline:0}.pins[hidden]{display:none}
.recovery{position:absolute;inset:8px;padding:16px;border:1px solid #c8cbd3;border-radius:12px;background:#fbf9f4;display:flex;gap:12px;align-items:center;flex-wrap:wrap}.recovery a{color:#245b72}.recovery p{margin:0}.recovery button{min-height:44px;padding:8px 16px;border:1px solid #20293a;border-radius:8px;background:#20293a;color:#fff;font:700 14px system-ui;cursor:pointer}button:focus-visible,a:focus-visible{outline:3px solid #2f6e88;outline-offset:3px}
@media(max-width:480px){.surface{right:0;bottom:0}.surface[data-view=comments]{height:100dvh;width:100vw}.surface[data-view=thread]{right:8px;bottom:8px;width:calc(100vw - 16px);height:min(560px,calc(100dvh - 16px))}.surface[data-view=expanded]{height:min(460px,100dvh)}}
`;
