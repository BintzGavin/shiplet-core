import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it, vi } from "vitest";
import { authenticateMcpOAuthPrincipal } from "../src/mcp-auth";

it("rejects a cryptographically valid expired OAuth credential before resolving user authority", async () => {
  const issuer = "https://expired-fixture.authkit.test";
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  const mockedFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    expect(String(input)).toBe(`${issuer}/oauth2/jwks`);
    return Response.json({ keys: [{ ...jwk, kid: "fixture-expiry", alg: "RS256", use: "sig" }] });
  });
  try {
    const expired = await new SignJWT({
      sub: "expired-owner",
      client_id: "fixture-client",
      sid: "fixture-consent",
      permissions: ["mcp", "shiplets:read"],
    })
      .setProtectedHeader({ alg: "RS256", kid: "fixture-expiry" })
      .setIssuer(issuer)
      .setAudience("https://shiplet.cc/api/mcp")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(keys.privateKey);
    const result = await authenticateMcpOAuthPrincipal(
      { ...(env as Env), SHIPLET_AUTH_MODE: "workos", WORKOS_AUTHKIT_ISSUER: issuer } as unknown as Env,
      new Request("https://shiplet.cc/api/mcp", {
        headers: { authorization: `Bearer ${expired}` },
      }),
      { appUrl: "https://shiplet.cc", requiredPermissions: ["mcp"] },
    ).then(
      () => null,
      (error) => error,
    );
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(401);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  } finally {
    mockedFetch.mockRestore();
  }
});
