import { CaptureEditor } from "./editor.js";
const $ = id => document.getElementById(id);
const status = $("capture-status");
const editor = new CaptureEditor($("capture-canvas"), () => { $("capture-confirm").checked = false; });
let busy = false, receiving = location.hash.startsWith("#companion=");
async function load(blob) {
  await editor.load(blob);
  $("capture-preview").hidden = false;
  status.textContent = "Preview ready. Nothing has been uploaded. Review and redact it before sharing.";
}
$("capture-file").onchange = async event => {
  try { if (event.target.files[0]) await load(event.target.files[0]); }
  catch (error) { status.textContent = error.message; }
};
document.addEventListener("paste", async event => {
  const image = Array.from(event.clipboardData?.files || []).find(file => file.type.startsWith("image/"));
  if (image) { event.preventDefault(); try { await load(image); } catch (error) { status.textContent = error.message; } }
});
$("capture-reset").onclick = () => editor.reset();
$("capture-redact").onclick = () => editor.redact(...["x", "y", "width", "height"].map(id => Number($("redact-" + id).value)));
$("capture-screen").onclick = async event => {
  let stream;
  event.target.disabled = true;
  try {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("This browser cannot capture a tab here. Upload a screenshot or install the browser companion.");
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: false });
    const video = document.createElement("video"); video.muted = true; video.srcObject = stream;
    await video.play();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No video frame arrived. Try uploading a screenshot.")), 8000);
      video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
    });
    const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    if (!canvas.width || canvas.width * canvas.height > 20_000_000) throw new Error("Choose a smaller tab or window (up to 20 megapixels).");
    canvas.getContext("2d").drawImage(video, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    await load(blob); video.srcObject = null;
  } catch (error) {
    status.textContent = error.name === "NotAllowedError" ? "Capture was canceled or blocked. Try again, use the companion, or upload a screenshot." : error.message;
  } finally { stream?.getTracks().forEach(track => track.stop()); event.target.disabled = false; }
};
$("capture-refresh").onclick = async () => {
  try {
    const response = await fetch("/capture/workspaces", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Sign in in the other tab, then try again.");
    const { organizations } = await response.json();
    $("capture-organization").replaceChildren(...organizations.map(org => { const option = document.createElement("option"); option.value = org.id; option.textContent = org.name; return option; }));
    $("capture-login").hidden = organizations.length > 0;
    status.textContent = organizations.length ? "Choose your workspace and confirm sharing." : "Create a workspace in Shiplet, then choose I’m signed in again.";
  } catch (error) { status.textContent = error.message; }
};
$("capture-form").onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  busy = true; $("capture-publish").disabled = true;
  try {
    if (!$("capture-organization").value) throw new Error("Sign in and choose a workspace.");
    if (!$("capture-confirm").checked) throw new Error("Review the image and confirm sharing first.");
    const body = { name: $("capture-name").value, organizationId: $("capture-organization").value, sourceUrl: $("capture-source").value, image: editor.export(), confirmed: true };
    status.textContent = "Creating your shared review…";
    const response = await fetch("/capture", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(response.status === 401 ? "Your sign-in expired. Sign in again, then retry. Your image is still here." : (await response.text()).slice(0, 300));
    const result = await response.json();
    const review = new URL(result.reviewUrl, location.origin);
    if (review.origin !== location.origin) throw new Error("Unexpected review destination. Open your workspace to find the capture.");
    editor.clear(); location.assign(review.href);
  } catch (error) { status.textContent = error.message; }
  finally { busy = false; $("capture-publish").disabled = false; }
};
if (receiving) {
  let attempts = 0;
  const timer = setInterval(() => {
    if (!receiving || ++attempts > 30) { clearInterval(timer); if (receiving) status.textContent = "Companion transfer did not arrive. Return to the original tab and capture again, or upload an image."; return; }
    window.postMessage({ type: "shiplet.capture.ready" }, location.origin);
  }, 300);
  window.addEventListener("message", async event => {
    if (!receiving || event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === "shiplet.capture.error") { receiving = false; status.textContent = "Capture expired. Return to the original tab and capture again."; return; }
    if (event.data?.type !== "shiplet.capture.image") return;
    receiving = false; clearInterval(timer); history.replaceState(null, "", location.pathname);
    try {
      const image = event.data.image;
      if (typeof image !== "string" || image.length > 8_388_630 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) throw new Error("Invalid companion image.");
      const bytes = Uint8Array.from(atob(image.slice(22)), char => char.charCodeAt(0));
      await load(new Blob([bytes], { type: "image/png" }));
      $("capture-source").value = typeof event.data.sourceUrl === "string" ? event.data.sourceUrl.slice(0, 2048) : "";
    } catch (error) { status.textContent = error.message; }
  });
}
