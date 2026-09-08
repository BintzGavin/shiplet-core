importScripts("config.js");
const lifetime = 10 * 60 * 1000;
let queue = Promise.resolve();
function localPage(sender, path) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(path);
}
function validImage(image) {
  return typeof image === "string" && image.length <= 8_388_630 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image);
}
function sourceUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
    url.search = ""; url.hash = ""; return url.toString().slice(0, 2048);
  } catch { return ""; }
}
async function dispatch(message, sender) {
  if (!message || sender.id !== chrome.runtime.id) return { ok: false };
  if (message.type === "shiplet.capture.start" && localPage(sender, "popup.html")) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.windowId) return { ok: false, error: "Choose a browser tab first." };
    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const after = await chrome.tabs.get(tab.id);
    if (!after.active || after.url !== tab.url || after.pendingUrl || !validImage(image)) return { ok: false, error: "The tab changed or the image was too large. Return to the work and capture again." };
    await chrome.storage.session.remove("pending");
    await chrome.storage.session.remove("draft");
    const preview = await chrome.tabs.create({ url: "about:blank" });
    await chrome.storage.session.set({ draft: { image, sourceUrl: sourceUrl(tab.url), previewTabId: preview.id, expires: Date.now() + lifetime } });
    await chrome.tabs.update(preview.id, { url: chrome.runtime.getURL("preview.html") });
    await chrome.alarms.create("capture-expiry", { delayInMinutes: 10 });
    return { ok: true };
  }
  if (message.type === "shiplet.capture.take") {
    const { pending } = await chrome.storage.session.get("pending");
    if (!pending) return { ok: false };
    if (pending.expires <= Date.now()) { await chrome.storage.session.remove("pending"); return { ok: false }; }
    let url; try { url = new URL(sender.url); } catch { return { ok: false }; }
    if (sender.frameId !== 0 || sender.tab?.id !== pending.destinationTabId || url.origin !== SHIPLET_ORIGIN || url.pathname !== "/capture" || message.id !== pending.id) return { ok: false };
    await chrome.storage.session.remove("pending");
    return { ok: true, image: pending.image, sourceUrl: pending.sourceUrl };
  }
  if (!localPage(sender, "preview.html")) return { ok: false };
  const { draft } = await chrome.storage.session.get("draft");
  if (!draft || draft.previewTabId !== sender.tab?.id || draft.expires <= Date.now()) return { ok: false, error: "This preview expired. Capture the tab again." };
  if (message.type === "shiplet.capture.preview") return { ok: true, image: draft.image, sourceUrl: draft.sourceUrl };
  if (message.type === "shiplet.capture.cancel") { await chrome.storage.session.remove("draft"); return { ok: true }; }
  if (message.type === "shiplet.capture.share" && validImage(message.image)) {
    const id = crypto.randomUUID();
    const destination = await chrome.tabs.create({ url: "about:blank" });
    await chrome.storage.session.remove("draft");
    await chrome.storage.session.set({ pending: { id, image: message.image, sourceUrl: sourceUrl(message.sourceUrl), destinationTabId: destination.id, expires: Date.now() + lifetime } });
    await chrome.tabs.update(destination.id, { url: SHIPLET_ORIGIN + "/capture#companion=" + id });
    await chrome.alarms.create("capture-expiry", { delayInMinutes: 10 });
    return { ok: true };
  }
  return { ok: false };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Serialize consumption so concurrent requests cannot receive the same image.
  queue = queue.then(() => dispatch(message, sender)).then(respond, () => respond({ ok: false, error: "The browser blocked capture. Upload a screenshot at Shiplet instead." }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  queue = queue.then(async () => {
    for (const key of ["draft", "pending"]) {
      const record = (await chrome.storage.session.get(key))[key];
      if (record && [record.previewTabId, record.destinationTabId].includes(tabId)) await chrome.storage.session.remove(key);
    }
  }).catch(() => {});
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== "capture-expiry") return;
  queue = queue.then(async () => {
    for (const key of ["draft", "pending"]) {
      const record = (await chrome.storage.session.get(key))[key];
      if (record && record.expires <= Date.now()) await chrome.storage.session.remove(key);
    }
  }).catch(() => {});
});
