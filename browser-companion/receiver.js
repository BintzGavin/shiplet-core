(() => {
  if (window !== top || location.pathname !== "/capture") return;
  const id = new URLSearchParams(location.hash.slice(1)).get("companion");
  if (!id || !/^[a-z0-9-]{36}$/.test(id)) return;
  let consumed = false;
  window.addEventListener("message", async event => {
    if (consumed || event.source !== window || event.origin !== location.origin || event.data?.type !== "shiplet.capture.ready") return;
    consumed = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: "shiplet.capture.take", id });
      if (!result?.ok) throw new Error("Capture expired. Return to the original tab and capture again.");
      window.postMessage({ type: "shiplet.capture.image", image: result.image, sourceUrl: result.sourceUrl }, location.origin);
    } catch { window.postMessage({ type: "shiplet.capture.error" }, location.origin); }
  });
})();
