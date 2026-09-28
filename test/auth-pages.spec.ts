import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";

async function request(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await app.fetch(new Request(`http://localhost${path}`, init), env as Env, context);
  await waitOnExecutionContext(context);
  return response;
}

describe("authentication page experience", () => {
  it("shows the signed-in account, short-lived authority, and explicit approve/cancel actions in the branded CLI page", async () => {
    const response = await request(`/cli/authorize?${new URLSearchParams({
      redirect_uri: "http://127.0.0.1:43191/callback",
      state: "s".repeat(32),
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
    })}`, { headers: { "x-shiplet-user-id": "user_auth_page", "x-shiplet-user-email": "auth-page@example.com" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await response.text();
    expect(html).toContain("shiplet-brand-shell");
    expect(html).toContain("auth-page@example.com");
    expect(html).toContain("ten minutes");
    expect(html).toContain("Recommended for agent work");
    expect(html).toContain('name="approval" value="approve"');
    expect(html).toContain('name="approval" value="deny"');
    expect(html).toContain("noindex,nofollow,noarchive");
  });

  it.each([
    ["/auth/callback", 400, "Missing WorkOS authorization code"],
    ["/auth/login?consent=invalid", 400, "Invitation consent is invalid or expired"],
    ["/cli/authorize/complete", 403, "CLI authorization denied"],
  ])("gives browser errors a styled recovery page at %s", async (path, status, message) => {
    const response = await request(String(path), {
      headers: { Accept: "text/html", Origin: "http://localhost", "Content-Type": "application/x-www-form-urlencoded", "x-shiplet-user-id": "user_auth_page", "x-shiplet-user-email": "auth-page@example.com" },
      ...(String(path).endsWith("/complete") ? { method: "POST", body: "approval=deny" } : {}),
    });
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("auth-card");
    expect(html).toContain(message);
    expect(html).toContain("Go to Shiplet");
  });

  it("keeps machine error responses unchanged", async () => {
    const response = await request("/auth/callback", { headers: { Accept: "application/json" } });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Missing WorkOS authorization code");
  });

  it("recommends CLI authentication to agents while keeping browser sign-in and MCP available", async () => {
    const home = await (await request("/")).text();
    expect(home).toContain('href="/auth/login"');
    expect(home).toContain('href="/docs/cli"');
    const cli = await request("/docs/cli");
    expect(cli.status).toBe(200);
    const html = await cli.text();
    expect(html).toContain("Recommended for agent work");
    expect(html).toContain("source checkout");
    expect(html).toContain("npm run shiplet -- prepare");
    expect(html).toContain('href="/docs/code-mode-mcp"');
    expect(await (await request("/llms.txt")).text()).toContain("CLI is the recommended authentication route for agent work");
  });
});
