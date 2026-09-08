import { CaptureEditor } from "./editor.js";
const status = document.querySelector("#status"), share = document.querySelector("#share");
const editor = new CaptureEditor(document.querySelector("canvas"));
try {
  const response = await chrome.runtime.sendMessage({ type: "shiplet.capture.preview" });
  if (!response?.ok) throw new Error(response?.error || "Capture expired. Capture the tab again.");
  // Decode locally without fetching any URL or executing remote code.
  const bytes = Uint8Array.from(atob(response.image.split(",")[1]), value => value.charCodeAt(0));
  await editor.load(new Blob([bytes], { type: "image/png" }));
  document.querySelector("#source").value = response.sourceUrl || "";
  status.textContent = "Review the image, then continue. You’ll choose a workspace and confirm publishing in Shiplet.";
  share.disabled = false;
} catch (error) { status.textContent = error.message; }
document.querySelector("#reset").onclick = () => editor.reset();
document.querySelector("#redact").onclick = () => editor.redact(...["x", "y", "width", "height"].map(id => Number(document.getElementById(id).value)));
document.querySelector("#cancel").onclick = async () => { await chrome.runtime.sendMessage({ type: "shiplet.capture.cancel" }); editor.clear(); window.close(); };
share.onclick = async () => {
  share.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "shiplet.capture.share", image: editor.export(), sourceUrl: document.querySelector("#source").value });
    if (!response?.ok) throw new Error(response?.error || "Could not transfer this capture.");
    editor.clear(); status.textContent = "Continue in the Shiplet tab. This local preview has been cleared.";
  } catch (error) { status.textContent = error.message; share.disabled = false; }
};
