document.querySelector("#capture").addEventListener("click", async event => {
  event.target.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "shiplet.capture.start" });
    if (!result?.ok) throw new Error(result?.error || "Capture unavailable. Upload a screenshot instead.");
    window.close();
  } catch (error) { document.querySelector("#status").textContent = error.message; event.target.disabled = false; }
});
