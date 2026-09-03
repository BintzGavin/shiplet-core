import {
  kernelScriptNonceAttribute,
  type KernelDocumentNonce,
} from "../kernel-document-nonce";

export function ExternalUrlMetadataAutofillScript(nonce: KernelDocumentNonce) {
  return `<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(nonce)}>
(function() {
  var applyingSuggestion = false;
  var timer = 0;
  var version = 0;

  function byId(id) { return document.getElementById(id); }
  function sourceMode() {
    var selected = document.querySelector('input[name="sourceMode"]:checked');
    return selected ? selected.value : "upload";
  }
  function setStatus(message) {
    var status = byId("externalUrlMetadataStatus");
    if (status) status.textContent = message || "";
  }
  function schedule() {
    var input = byId("externalUrl");
    var rawUrl = input ? input.value.trim() : "";
    version += 1;
    var requestVersion = version;
    window.clearTimeout(timer);
    if (sourceMode() !== "external_url" || !rawUrl) {
      setStatus("");
      return;
    }
    try {
      var parsed = new URL(rawUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        setStatus("");
        return;
      }
    } catch (error) {
      setStatus("");
      return;
    }

    setStatus("Reading page metadata...");
    timer = window.setTimeout(async function() {
      try {
        var response = await fetch("/api/external-url/metadata", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: rawUrl })
        });
        if (!response.ok) throw new Error(await response.text());
        var suggestion = await response.json();
        if (
          requestVersion !== version ||
          sourceMode() !== "external_url" ||
          !input ||
          input.value.trim() !== rawUrl
        ) return;

        var name = byId("projectName");
        var subdomain = byId("subdomain");
        var nameWasEdited = !!(name && name.dataset.externalMetadataTouched);
        var applied = false;
        applyingSuggestion = true;
        if (
          name &&
          !nameWasEdited &&
          suggestion &&
          typeof suggestion.name === "string" &&
          suggestion.name
        ) {
          name.value = suggestion.name;
          name.dispatchEvent(new Event("input", { bubbles: true }));
          applied = true;
        }
        if (
          subdomain &&
          !subdomain.dataset.touched &&
          (!nameWasEdited || !subdomain.value.trim()) &&
          suggestion &&
          typeof suggestion.subdomain === "string" &&
          suggestion.subdomain
        ) {
          subdomain.value = suggestion.subdomain;
          applied = true;
        }
        applyingSuggestion = false;
        setStatus(
          applied
            ? suggestion.source === "url"
              ? "Suggested from the URL."
              : "Suggested from page metadata."
            : "Page metadata found. Your edits were kept."
        );
      } catch (error) {
        applyingSuggestion = false;
        if (requestVersion !== version) return;
        setStatus("Could not read page metadata. Enter a name and address.");
      }
    }, 450);
  }

  var name = byId("projectName");
  if (name) {
    name.addEventListener("input", function() {
      if (!applyingSuggestion) name.dataset.externalMetadataTouched = "true";
    });
  }
  var externalUrl = byId("externalUrl");
  if (externalUrl) externalUrl.addEventListener("input", schedule);
  document.querySelectorAll('input[name="sourceMode"]').forEach(function(input) {
    input.addEventListener("change", schedule);
  });
})();
</script>`;
}
