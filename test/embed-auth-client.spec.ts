import { describe, expect, it, vi } from "vitest";
import { embedAuthBootstrapScript } from "../src/embed-auth-client";

function bootstrap(blocked = false) {
  const listeners = new Map<string, (event: any) => any>();
  const buttons = ["annotate", "comments"].map(action => ({
    click: (_event: any) => {},
    getAttribute: (name: string) => name === "data-shiplet-embed-action" ? action : "https://shiplet.test/embed/review/authorize",
    addEventListener(_type: string, listener: (event: any) => any) { this.click = listener; },
  }));
  const status = { hidden: true };
  const statusText = { textContent: "" };
  const dismiss = { click: () => {}, addEventListener(_type: string, listener: () => void) { this.click = listener; } };
  const popup = { closed: false, focus: vi.fn(), close: vi.fn() };
  const parent = { postMessage: vi.fn() };
  const open = vi.fn(() => blocked ? null : popup);
  const timers: Array<() => void> = [];
  const storage = new Map<string, string>();
  const replace = vi.fn();
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ hostUrl: "https://shiplet.test/embed/review/host?installation_id=install_test" }) }));
  new Function("window", "document", "parent", "location", "fetch", "sessionStorage", "setInterval", "clearInterval", embedAuthBootstrapScript())(
    { open, addEventListener: (type: string, listener: (event: any) => any) => listeners.set(type, listener) },
    { querySelectorAll: () => buttons, querySelector: (selector: string) => selector.endsWith("-text]") ? statusText : selector.endsWith("-dismiss]") ? dismiss : status },
    parent,
    { origin: "https://shiplet.test", href: "https://shiplet.test/embed/review/start?installation_id=install_test&return_url=https://site.test/essay", replace },
    fetch,
    { setItem: (key: string, value: string) => storage.set(key, value) },
    (callback: () => void) => timers.push(callback),
    vi.fn(),
  );
  return { listeners, buttons, status, statusText, dismiss, popup, parent, open, timers, storage, replace, fetch };
}

describe("direct embedded authentication", () => {
  it("opens the dedicated popup only from a trusted launcher click and reports blocked/closed windows", () => {
    const blocked = bootstrap(true);
    expect(blocked.open).not.toHaveBeenCalled();
    blocked.buttons[0].click({ isTrusted: false });
    expect(blocked.open).not.toHaveBeenCalled();
    blocked.buttons[0].click({ isTrusted: true });
    expect(blocked.open).toHaveBeenCalledOnce();
    expect(blocked.status.hidden).toBe(false);
    expect(blocked.statusText.textContent).toContain("Allow the Shiplet sign-in popup");
    blocked.dismiss.click();
    expect(blocked.parent.postMessage).toHaveBeenLastCalledWith({ protocol: "shiplet.embed.ui.v1", view: "toolbar" }, "https://site.test");
    const closed = bootstrap();
    closed.buttons[0].click({ isTrusted: true });
    closed.popup.closed = true;
    closed.timers[0]();
    expect(closed.statusText.textContent).toContain("Sign-in window closed");
  });

  it("keeps the handoff inside Shiplet and resumes the clicked action without another login", async () => {
    const harness = bootstrap();
    harness.buttons[1].click({ isTrusted: true });
    const data = { protocol: "shiplet.embed.auth.v1", ticket: "shiplet_embed_auth_synthetic_test_handoff_only" };
    const message = harness.listeners.get("message")!;
    await message({ source: harness.parent, origin: "https://site.test", data });
    await message({ source: harness.popup, origin: "https://attacker.test", data });
    expect(harness.fetch).not.toHaveBeenCalled();
    await message({ source: harness.popup, origin: "https://shiplet.test", data });
    expect(harness.fetch).toHaveBeenCalledOnce();
    expect(harness.storage.get("shiplet.embed.intent:install_test")).toBe("comments");
    expect(harness.popup.close).toHaveBeenCalledOnce();
    expect(harness.replace).toHaveBeenCalledWith("https://shiplet.test/embed/review/host?installation_id=install_test");
    expect(JSON.stringify(harness.parent.postMessage.mock.calls)).not.toContain("ticket");
    await message({ source: harness.popup, origin: "https://shiplet.test", data });
    expect(harness.fetch).toHaveBeenCalledOnce();
  });
});
