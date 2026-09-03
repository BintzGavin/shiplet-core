function createScopedSessionFetch(options) {
  const apiUrl = new URL(String(options.apiUrl)).origin;
  const accessToken = String(options.accessToken || "");
  const fetchImpl = options.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("This Node runtime does not provide fetch.");
  }
  if (!accessToken) {
    throw new Error("Shiplet did not return a valid scoped CLI session.");
  }

  let revoked = false;
  const sessionFetch = async (url, init = {}) => {
    if (revoked) throw new Error("CLI session has been revoked.");
    const requestUrl = new URL(url);
    if (requestUrl.origin !== apiUrl) {
      throw new Error("CLI session cannot be sent outside the Shiplet API origin.");
    }
    const headers = new Headers(init.headers || {});
    headers.set("authorization", `Bearer ${accessToken}`);
    return fetchImpl(requestUrl.toString(), {
      ...init,
      redirect: "error",
      headers,
    });
  };

  sessionFetch.revoke = async () => {
    if (revoked) return;
    const headers = new Headers({ accept: "application/json" });
    headers.set("authorization", `Bearer ${accessToken}`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchImpl(`${apiUrl}/api/cli/session/revoke`, {
          method: "POST",
          redirect: "error",
          headers,
        });
        if (response.status === 204) {
          revoked = true;
          return;
        }
      } catch {
        // A second bounded attempt covers one transient transport failure.
      }
    }
    throw new Error("Shiplet CLI session revocation was not confirmed.");
  };

  return sessionFetch;
}

module.exports = { createScopedSessionFetch };
