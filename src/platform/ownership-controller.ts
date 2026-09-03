import {
  kernelScriptNonceAttribute,
  type KernelDocumentNonce,
} from "../kernel-document-nonce";

function scriptJson(value: unknown) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

const OWNERSHIP_ACTION_FAILURE_COPY = Object.freeze({
  offline: Object.freeze({
    tone: "warning" as const,
    message:
      "You appear to be offline. No deployment or revision change was attempted. Reconnect before retrying.",
  }),
  permission: Object.freeze({
    tone: "warning" as const,
    message:
      "Your current session does not have access to complete this action. Sign in with an authorized account or ask a Shiplet owner.",
  }),
  prerequisite: Object.freeze({
    tone: "warning" as const,
    message:
      "Shiplet needs a fresh trusted approval or prerequisite before this action. Review the action details and try again.",
  }),
  validation: Object.freeze({
    tone: "warning" as const,
    message:
      "The draft or deployment input did not pass validation. Review the revision details, validate again, and retry.",
  }),
  conflict: Object.freeze({
    tone: "warning" as const,
    message:
      "Ownership state changed in another session. Refresh before retrying; no conflicting change was applied.",
  }),
  service: Object.freeze({
    tone: "error" as const,
    message:
      "Shiplet could not reach or verify the target service. Refresh ownership status before starting another revision or deployment action.",
  }),
  uncertain: Object.freeze({
    tone: "warning" as const,
    message:
      "Outcome unknown. Retry this exact operation to reconcile it; do not start another revision or deployment action until Shiplet confirms the result.",
    retryExact: true as const,
    blockCompeting: true as const,
  }),
  fallback: Object.freeze({
    tone: "error" as const,
    message:
      "The action could not be completed. Refresh ownership status before retrying.",
  }),
});

export function OwnershipActionFailureState(input: {
  offline: boolean;
  status?: number | null;
  effectStarted?: boolean;
}) {
  if (input.effectStarted && (input.status == null || input.status >= 500)) {
    return OWNERSHIP_ACTION_FAILURE_COPY.uncertain;
  }
  if (input.offline) return OWNERSHIP_ACTION_FAILURE_COPY.offline;
  if (input.status === 401 || input.status === 403) {
    return OWNERSHIP_ACTION_FAILURE_COPY.permission;
  }
  if (input.status === 428) return OWNERSHIP_ACTION_FAILURE_COPY.prerequisite;
  if (input.status === 422) return OWNERSHIP_ACTION_FAILURE_COPY.validation;
  if (input.status === 409) return OWNERSHIP_ACTION_FAILURE_COPY.conflict;
  if (typeof input.status === "number" && input.status >= 500) {
    return OWNERSHIP_ACTION_FAILURE_COPY.service;
  }
  return OWNERSHIP_ACTION_FAILURE_COPY.fallback;
}

export function BuildOwnershipController(input: {
  nonce: KernelDocumentNonce;
  shipletId: string;
}) {
  const configuration = scriptJson({
    shipletId: input.shipletId,
    preparePath: `/api/shiplets/${encodeURIComponent(input.shipletId)}/ownership/actions`,
    actionFailureCopy: OWNERSHIP_ACTION_FAILURE_COPY,
  });
  return `<div class="ownership-notice" data-ownership-action-status hidden role="status" aria-live="polite" tabindex="-1"><p></p></div>
<dialog class="ownership-controller-dialog" data-ownership-compare-dialog aria-labelledby="ownership-compare-title">
  <form method="dialog"><button class="ownership-action" value="close" aria-label="Close revision comparison">Close</button></form>
  <h2 id="ownership-compare-title">Revision comparison</h2>
  <p data-ownership-compare-overview role="status">Loading the package comparison.</p>
  <div class="ownership-comparison-grid">
    <section aria-labelledby="ownership-changed-files-title">
      <h3 id="ownership-changed-files-title">Changed files</h3>
      <ul data-ownership-changed-files></ul>
    </section>
    <section aria-labelledby="ownership-manifest-changes-title">
      <h3 id="ownership-manifest-changes-title">Manifest changes</h3>
      <ul data-ownership-manifest-changes></ul>
    </section>
    <section aria-labelledby="ownership-capability-changes-title">
      <h3 id="ownership-capability-changes-title">Capability changes</h3>
      <ul data-ownership-capability-changes></ul>
    </section>
  </div>
  <details class="ownership-controller-disclosure" data-ownership-raw-comparison>
    <summary>Advanced: view raw package JSON</summary>
    <pre data-ownership-compare-output></pre>
  </details>
</dialog>
<dialog class="ownership-package-editor" data-ownership-package-editor aria-labelledby="ownership-package-title">
  <form method="dialog"><button class="ownership-action" value="close" aria-label="Close draft package editor">Close</button></form>
  <h2 id="ownership-package-title" tabindex="-1">Review isolated draft package</h2>
  <p>Review the package parts first. Advanced owners can edit raw package JSON; saving still changes only this draft.</p>
  <section class="ownership-package-summary" aria-labelledby="ownership-package-contents-title">
    <h3 id="ownership-package-contents-title">Package contents</h3>
    <ul data-ownership-package-contents></ul>
    <p data-ownership-package-capabilities></p>
  </section>
  <details class="ownership-controller-disclosure" data-ownership-raw-editor>
    <summary>Advanced: edit raw package JSON</summary>
    <label for="ownershipPackageJson">Draft package JSON</label>
    <textarea id="ownershipPackageJson" aria-label="Draft package JSON" autocomplete="off" spellcheck="false"></textarea>
    <div class="ownership-actions"><button class="ownership-action ownership-action-primary" type="button" data-ownership-package-save>Save draft package</button></div>
  </details>
</dialog>
<style data-ownership-controller-styles>
.ownership-controller-dialog,.ownership-package-editor{background:var(--surface,#fff);border:1px solid var(--line-strong,#20293a);border-radius:10px;color:var(--text,#20293a);max-height:calc(100vh - 32px);max-width:min(900px,calc(100vw - 32px));overflow:auto;padding:18px;width:100%}.ownership-controller-dialog::backdrop,.ownership-package-editor::backdrop{background:rgba(20,28,42,.56)}.ownership-controller-dialog>form,.ownership-package-editor>form{float:right}.ownership-controller-dialog>h2,.ownership-package-editor>h2{padding-right:84px}.ownership-controller-dialog p,.ownership-package-editor p{color:var(--text-soft,#3a4459);line-height:1.5;margin:8px 0 14px}.ownership-comparison-grid{border-bottom:1px dashed var(--line,#c8cbd3);border-top:1px dashed var(--line,#c8cbd3);display:grid;gap:0;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:14px}.ownership-comparison-grid section{padding:14px}.ownership-comparison-grid section+section{border-left:1px dashed var(--line,#c8cbd3)}.ownership-comparison-grid h3,.ownership-package-summary h3{font-size:1rem;margin:0 0 8px}.ownership-comparison-grid ul,.ownership-package-summary ul{display:grid;gap:6px;margin:0;padding-left:19px}.ownership-comparison-grid li,.ownership-package-summary li{color:var(--text-soft,#3a4459);font-size:.8125rem;line-height:1.45;overflow-wrap:anywhere}.ownership-controller-disclosure{border-top:1px dashed var(--line,#c8cbd3);margin-top:14px;padding-top:8px}.ownership-controller-disclosure summary{color:var(--text-soft,#3a4459);cursor:pointer;font-size:.875rem;font-weight:650;min-height:38px;padding:9px 0}.ownership-controller-disclosure[open] summary{color:var(--text,#20293a)}.ownership-controller-disclosure pre{background:var(--surface-sunken,#f4f1ea);border-radius:7px;font:12px/1.5 "IBM Plex Mono",ui-monospace,monospace;max-height:48vh;overflow:auto;padding:12px;white-space:pre-wrap}.ownership-package-summary{background:var(--surface-sunken,#f4f1ea);border-radius:8px;padding:14px}.ownership-package-editor label{display:block;font-weight:700;margin-bottom:6px}.ownership-package-editor textarea{background:var(--surface-sunken,#f4f1ea);border:1px solid var(--line,#c8cbd3);border-radius:7px;color:var(--text,#20293a);font:12px/1.5 "IBM Plex Mono",ui-monospace,monospace;min-height:min(50vh,520px);padding:12px;resize:vertical;width:100%}.ownership-package-editor .ownership-actions{margin-top:12px}@media(max-width:700px){.ownership-controller-dialog,.ownership-package-editor{border-radius:0;max-height:100vh;max-width:100vw}.ownership-comparison-grid{grid-template-columns:1fr}.ownership-comparison-grid section+section{border-left:0;border-top:1px dashed var(--line,#c8cbd3)}.ownership-package-editor textarea{min-height:45vh}}
</style>
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(input.nonce)} data-ownership-controller="trusted-kernel">
(() => {
  "use strict";
  const config = ${configuration};
  const root = document.querySelector("[data-shiplet-ownership-page]");
  const status = document.querySelector("[data-ownership-action-status]");
  const statusText = status?.querySelector("p");
  const dialog = document.querySelector("[data-ownership-compare-dialog]");
  const comparisonOverview = dialog?.querySelector("[data-ownership-compare-overview]");
  const comparisonFiles = dialog?.querySelector("[data-ownership-changed-files]");
  const comparisonManifest = dialog?.querySelector("[data-ownership-manifest-changes]");
  const comparisonCapabilities = dialog?.querySelector("[data-ownership-capability-changes]");
  const comparisonRaw = dialog?.querySelector("[data-ownership-compare-output]");
  const packageDialog = document.querySelector("[data-ownership-package-editor]");
  const packageHeading = packageDialog?.querySelector("#ownership-package-title");
  const packageContents = packageDialog?.querySelector("[data-ownership-package-contents]");
  const packageCapabilities = packageDialog?.querySelector("[data-ownership-package-capabilities]");
  const packageEditor = packageDialog?.querySelector("textarea");
  const packageSave = packageDialog?.querySelector("[data-ownership-package-save]");
  if (!root || !status || !statusText) return;

  const announce = (message, tone = "info") => {
    status.hidden = false;
    status.classList.toggle("ownership-notice-error", tone === "error");
    status.classList.toggle("ownership-notice-warning", tone === "warning");
    statusText.textContent = message;
    status.focus({ preventScroll: false });
  };
  const actionFailureState = (error, effectStarted = false) => {
    const statusCode = error && Number(error.status);
    if (effectStarted && (!Number.isFinite(statusCode) || statusCode >= 500)) return config.actionFailureCopy.uncertain;
    if (navigator.onLine === false) return config.actionFailureCopy.offline;
    if (statusCode === 401 || statusCode === 403) return config.actionFailureCopy.permission;
    if (statusCode === 428) return config.actionFailureCopy.prerequisite;
    if (statusCode === 422) return config.actionFailureCopy.validation;
    if (statusCode === 409) return config.actionFailureCopy.conflict;
    if (Number.isFinite(statusCode) && statusCode >= 500) return config.actionFailureCopy.service;
    return config.actionFailureCopy.fallback;
  };
  const identifier = (prefix) => prefix + "_" + crypto.randomUUID();
  const exactRetryActions = new Set(["promote", "rollback", "redeploy", "create-temporary-claim"]);
  const operationIntents = new WeakMap();
  let uncertainOperation = null;
  const holdUncertainOperation = (button, action) => {
    uncertainOperation = { button, action };
    root.querySelectorAll("[data-shiplet-action]").forEach((candidate) => {
      if (candidate === button || candidate.hasAttribute("disabled")) return;
      candidate.setAttribute("disabled", "");
      candidate.setAttribute("data-disabled-by-uncertain-operation", "true");
    });
    if (!button.dataset.operationOriginalLabel) {
      button.dataset.operationOriginalLabel = button.textContent || "Retry action";
    }
    button.textContent = "Retry exact operation";
    button.setAttribute("data-operation-retry", "exact");
    button.removeAttribute("disabled");
    button.removeAttribute("aria-busy");
  };
  const releaseUncertainOperation = (button) => {
    root.querySelectorAll('[data-disabled-by-uncertain-operation="true"]').forEach((candidate) => {
      candidate.removeAttribute("disabled");
      candidate.removeAttribute("data-disabled-by-uncertain-operation");
    });
    if (button.dataset.operationOriginalLabel) {
      button.textContent = button.dataset.operationOriginalLabel;
      delete button.dataset.operationOriginalLabel;
    }
    button.removeAttribute("data-operation-retry");
    uncertainOperation = null;
  };
  const receiptVerifiedPromotions = new WeakSet();
  const previewCoordinates = (element) => {
    const draftId = element.dataset.previewDraftId;
    const revisionId = element.dataset.previewRevisionId;
    const version = element.dataset.previewVersion;
    if (!draftId || !revisionId || revisionId === "unavailable" || !/^\\d+$/.test(version || "")) return null;
    return { draftId, revisionId, draftVersion: Number(version) };
  };
  const syncPromotionButton = (button, satisfied) => {
    if (uncertainOperation && uncertainOperation.button !== button) satisfied = false;
    if (satisfied) receiptVerifiedPromotions.add(button);
    button.toggleAttribute("disabled", !satisfied);
    button.setAttribute("aria-disabled", String(!satisfied));
    const noteId = button.getAttribute("aria-describedby");
    const note = noteId ? document.getElementById(noteId) : null;
    if (note && satisfied) {
      note.textContent = "The trusted kernel recorded this exact sealed preview for your current session. Promotion is available and still requires explicit approval.";
    }
  };
  const verifyPromotionReceipt = async (button) => {
    const coordinates = previewCoordinates(button);
    const endpoint = button.dataset.previewReceiptEndpoint;
    const expectedEndpoint = coordinates
      ? "/api/shiplets/" + encodeURIComponent(config.shipletId) +
        "/drafts/" + encodeURIComponent(coordinates.draftId) +
        "/revisions/" + encodeURIComponent(coordinates.revisionId) +
        "/versions/" + encodeURIComponent(coordinates.draftVersion) +
        "/preview-receipt"
      : null;
    if (!coordinates || button.dataset.previewReceiptRequired !== "true" || endpoint !== expectedEndpoint) {
      syncPromotionButton(button, false);
      return false;
    }
    try {
      const response = await fetch(endpoint, { credentials: "same-origin", headers: { accept: "application/json" } });
      if (!response.ok) {
        syncPromotionButton(button, false);
        return false;
      }
      const receipt = await response.json();
      const valid = receipt?.previewed === true &&
        receipt.shipletId === config.shipletId &&
        receipt.draftId === coordinates.draftId &&
        receipt.revisionId === coordinates.revisionId &&
        receipt.draftVersion === coordinates.draftVersion;
      syncPromotionButton(button, valid);
      return valid;
    } catch {
      syncPromotionButton(button, false);
      return false;
    }
  };
  const refreshPromotionReceipts = () => Promise.all(
    [...root.querySelectorAll('[data-shiplet-action="promote"][data-preview-receipt-required="true"]')]
      .map((button) => verifyPromotionReceipt(button)),
  );
  const syncMatchingPromotions = async (preview) => {
    const checks = [];
    root.querySelectorAll('[data-shiplet-action="promote"][data-preview-required="true"]').forEach((button) => {
      if (button.dataset.previewDraftId === preview.dataset.previewDraftId &&
          button.dataset.previewRevisionId === preview.dataset.previewRevisionId &&
          button.dataset.previewVersion === preview.dataset.previewVersion) {
        checks.push(verifyPromotionReceipt(button));
      }
    });
    await Promise.all(checks);
  };
  const json = async (response) => {
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await response.json()
      : {};
    if (!response.ok) {
      const error = new Error(typeof body?.code === "string" ? body.code : "request_failed");
      error.status = response.status;
      throw error;
    }
    return body;
  };
  const prepare = async (input) => {
    const response = await fetch(config.preparePath, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return json(response);
  };
  const execute = async (plan) => {
    const headers = { "content-type": "application/json", ...(plan.headers || {}) };
    return json(await fetch(plan.path, {
      method: plan.method,
      credentials: "same-origin",
      headers,
      body: JSON.stringify(plan.body || {}),
    }));
  };
  const packageFiles = (pkg) => Array.isArray(pkg?.files)
    ? pkg.files.filter((file) => file && typeof file.path === "string")
    : [];
  const capabilities = (pkg) => Array.isArray(pkg?.manifest?.requestedCapabilities)
    ? pkg.manifest.requestedCapabilities.filter((capability) => typeof capability === "string")
    : [];
  const replaceList = (list, items, emptyMessage) => {
    if (!list) return;
    list.replaceChildren();
    const values = items.length ? items : [{ label: emptyMessage, value: "" }];
    values.forEach((item) => {
      const row = document.createElement("li");
      if (item.label) {
        const label = document.createElement("strong");
        label.textContent = item.value ? item.label + ": " : item.label;
        row.append(label);
      }
      if (item.value) {
        const value = document.createElement("span");
        value.textContent = item.value;
        row.append(value);
      }
      list.append(row);
    });
  };
  const stableValue = (value) => JSON.stringify(value ?? null);
  const comparisonModel = (basePackage, draftPackage) => {
    const baseFiles = new Map(packageFiles(basePackage).map((file) => [file.path, file]));
    const draftFiles = new Map(packageFiles(draftPackage).map((file) => [file.path, file]));
    const paths = [...new Set([...baseFiles.keys(), ...draftFiles.keys()])].sort();
    const files = paths.flatMap((path) => {
      const before = baseFiles.get(path);
      const after = draftFiles.get(path);
      if (!before) return [{ label: "Added", value: path }];
      if (!after) return [{ label: "Removed", value: path }];
      const beforeFingerprint = before.sha256 || stableValue([before.size, before.mediaType, before.content]);
      const afterFingerprint = after.sha256 || stableValue([after.size, after.mediaType, after.content]);
      return beforeFingerprint === afterFingerprint ? [] : [{ label: "Modified", value: path }];
    });
    const manifestFields = ["schemaVersion", "runtimeCompatibility", "staticFirst", "entrypoints", "limits"];
    const manifest = manifestFields.flatMap((field) =>
      stableValue(basePackage?.manifest?.[field]) === stableValue(draftPackage?.manifest?.[field])
        ? []
        : [{ label: "Changed", value: field }],
    );
    const beforeCapabilities = new Set(capabilities(basePackage));
    const afterCapabilities = new Set(capabilities(draftPackage));
    const capabilityChanges = [
      ...[...afterCapabilities].filter((value) => !beforeCapabilities.has(value)).sort().map((value) => ({ label: "Requested", value })),
      ...[...beforeCapabilities].filter((value) => !afterCapabilities.has(value)).sort().map((value) => ({ label: "Removed", value })),
    ];
    return { files, manifest, capabilities: capabilityChanges };
  };
  const renderPackageContents = (pkg) => {
    const files = packageFiles(pkg);
    const entrypoints = pkg?.manifest?.entrypoints || {};
    const sections = [
      ["Artifact", files.filter((file) => file.path.startsWith("artifact/")).length],
      ["Review widget", files.filter((file) => file.path.startsWith("widget/")).length],
      ["Workflow", files.filter((file) => file.path.startsWith("workflow/")).length],
      ["Custom MCP", files.filter((file) => file.path.startsWith("mcp/")).length],
      ["Agent instructions", typeof entrypoints.agentInstructions === "string" ? 1 : 0],
      ["Validation", files.filter((file) => file.path.startsWith("validation/")).length],
    ].map(([label, count]) => ({ label: String(label), value: count + (count === 1 ? " file" : " files") }));
    replaceList(packageContents, sections, "Package contents unavailable");
    if (packageCapabilities) {
      const requested = capabilities(pkg);
      packageCapabilities.textContent = requested.length
        ? "Requested capabilities: " + requested.join(", ")
        : "Requested capabilities: none";
    }
  };
  const compare = async (button) => {
    const [draft, base] = await Promise.all([
      fetch(button.dataset.draftPackageEndpoint, { credentials: "same-origin" }).then(json),
      fetch(button.dataset.basePackageEndpoint, { credentials: "same-origin" }).then(json),
    ]);
    if (!dialog) return;
    const changes = comparisonModel(base?.package, draft?.package);
    replaceList(comparisonFiles, changes.files, "No file content changed");
    replaceList(comparisonManifest, changes.manifest, "No manifest settings changed");
    replaceList(comparisonCapabilities, changes.capabilities, "No capability requests changed");
    if (comparisonOverview) {
      const total = changes.files.length + changes.manifest.length + changes.capabilities.length;
      comparisonOverview.textContent = total
        ? total + (total === 1 ? " package change is ready to review." : " package changes are ready to review.")
        : "The draft package matches the active package in the compared fields.";
    }
    if (comparisonRaw) comparisonRaw.textContent = JSON.stringify({ active: base?.package, draft: draft?.package }, null, 2);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  };
  const openDraft = async (button) => {
    const envelope = await fetch(button.dataset.actionEndpoint, { credentials: "same-origin" }).then(json);
    if (!packageDialog || !packageEditor || !envelope?.package || !Number.isInteger(envelope?.draft?.version)) {
      throw new Error("draft_package_unavailable");
    }
    packageEditor.value = JSON.stringify(envelope.package, null, 2);
    renderPackageContents(envelope.package);
    packageDialog.dataset.endpoint = button.dataset.actionEndpoint;
    packageDialog.dataset.version = String(envelope.draft.version);
    if (typeof packageDialog.showModal === "function") packageDialog.showModal();
    else packageDialog.setAttribute("open", "");
    packageHeading?.focus();
  };
  packageSave?.addEventListener("click", async () => {
    if (!packageDialog || !packageEditor || !packageSave) return;
    packageSave.setAttribute("disabled", "");
    packageSave.setAttribute("aria-busy", "true");
    announce("Saving the isolated draft package. The active revision remains unchanged.");
    try {
      const packageValue = JSON.parse(packageEditor.value);
      const result = await json(await fetch(packageDialog.dataset.endpoint, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: Number(packageDialog.dataset.version),
          package: packageValue,
        }),
      }));
      packageDialog.dataset.version = String(result.draft.version);
      announce("Draft package saved. Validate it before promotion.");
      if (typeof packageDialog.close === "function") packageDialog.close();
      else packageDialog.removeAttribute("open");
      location.reload();
    } catch (error) {
      const conflict = error && error.status === 409;
      announce(conflict
        ? "The draft changed in another session. Refresh before saving; no conflicting change was applied."
        : "The package could not be saved. Check the package JSON and try again.", conflict ? "warning" : "error");
      packageSave.removeAttribute("disabled");
      packageSave.removeAttribute("aria-busy");
      packageSave.focus();
    }
  });
  const semanticInput = (button, action) => {
    const common = { shipletId: config.shipletId };
    if (action === "fork") return { ...common, action: "fork" };
    if (action === "validate") return {
      ...common,
      action: "validate",
      draftId: button.dataset.actionEndpoint.split("/").at(-2),
      expectedVersion: Number(button.dataset.expectedVersion),
    };
    if (action === "promote") return {
      ...common,
      action: "promote",
      draftId: button.dataset.actionEndpoint.split("/").at(-2),
      expectedVersion: Number(button.dataset.expectedVersion),
      expectedActiveRevisionId: button.dataset.expectedActiveRevisionId,
      idempotencyKey: identifier("ownership_promote"),
      approved: true,
    };
    if (action === "rollback") return {
      ...common,
      action: "rollback",
      revisionId: button.dataset.revisionId,
      expectedActiveRevisionId: button.dataset.expectedActiveRevisionId,
      idempotencyKey: identifier("ownership_rollback"),
      approved: true,
    };
    if (action === "connect-cloudflare") return { ...common, action: "connect_cloudflare" };
    if (action === "revoke-cloudflare") return {
      ...common,
      action: "revoke_cloudflare",
      connectionId: button.dataset.actionEndpoint.split("/").at(-1),
      approved: true,
    };
    if (action === "redeploy") return {
      ...common,
      action: "redeploy",
      revisionId: button.dataset.actionEndpoint.split("/").at(-2),
      targetId: button.dataset.targetId,
      idempotencyKey: identifier("ownership_deploy"),
      approved: true,
    };
    if (action === "create-temporary-claim") return {
      ...common,
      action: "temporary_claim",
      revisionId: button.dataset.actionEndpoint.split("/").at(-2),
      idempotencyKey: identifier("ownership_claim"),
      approved: true,
      acceptedCloudflarePolicies: Boolean(root.querySelector("[data-cloudflare-policy-checkbox]")?.checked),
    };
    throw new Error("unsupported_action");
  };
  const operationInput = (button, action) => {
    const existing = operationIntents.get(button);
    if (existing) return existing;
    const input = semanticInput(button, action);
    if (exactRetryActions.has(action)) operationIntents.set(button, input);
    return input;
  };

  root.addEventListener("click", async (event) => {
    const button = event.target instanceof Element
      ? event.target.closest("[data-shiplet-action]")
      : null;
    if (!(button instanceof HTMLElement) || button.hasAttribute("disabled")) return;
    const action = button.dataset.shipletAction || "";
    if (action === "compare") {
      event.preventDefault();
      announce("Loading the active revision and draft comparison.");
      try { await compare(button); status.hidden = true; }
      catch { announce("The revision comparison could not be loaded. No change was made.", "error"); }
      return;
    }
    if (action === "preview") {
      announce("Opening the exact sealed preview. Promotion stays locked until the trusted kernel records your session receipt.");
      window.setTimeout(() => { void syncMatchingPromotions(button); }, 750);
      return;
    }
    if (action === "continue-temporary-claim") {
      event.preventDefault();
      const form = document.createElement("form");
      form.method = "post";
      form.action = button.dataset.actionEndpoint;
      form.hidden = true;
      document.body.append(form);
      form.submit();
      return;
    }
    if (action === "open-draft") {
      event.preventDefault();
      announce("Loading the isolated draft package.");
      try { await openDraft(button); status.hidden = true; }
      catch { announce("The draft package could not be loaded. No change was made.", "error"); }
      return;
    }
    if (!["fork", "validate", "promote", "rollback", "connect-cloudflare", "revoke-cloudflare", "redeploy", "create-temporary-claim"].includes(action)) return;
    event.preventDefault();
    if (action === "promote" && !receiptVerifiedPromotions.has(button)) {
      announce("Promotion is locked until the trusted kernel confirms that you opened this exact sealed revision preview in the current session.", "warning");
      return;
    }
    if (button.dataset.requiresApproval === "true") {
      const confirmationMessage = button.dataset.confirmationMessage;
      if (!confirmationMessage) {
        announce("The trusted confirmation details are unavailable. No change was made.", "error");
        return;
      }
      const accepted = window.confirm(confirmationMessage);
      if (!accepted) { announce("No change was made."); return; }
    }
    const previousDisabled = button.hasAttribute("disabled");
    button.setAttribute("disabled", "");
    button.setAttribute("aria-busy", "true");
    announce("Preparing the trusted Shiplet action.");
    let effectStarted = false;
    try {
      const plan = await prepare(operationInput(button, action));
      announce("Applying the Shiplet action. The previous active revision remains available until this completes.");
      effectStarted = true;
      const result = await execute(plan);
      if (action === "connect-cloudflare") {
        const authorizationUrl = new URL(result.authorizationUrl);
        if (authorizationUrl.protocol !== "https:" || authorizationUrl.hostname !== "dash.cloudflare.com" || authorizationUrl.pathname !== "/oauth2/auth") {
          throw new Error("invalid_authorization_destination");
        }
        location.assign(authorizationUrl.href);
        return;
      }
      announce("The action completed. Refreshing ownership status.");
      location.reload();
    } catch (error) {
      const canRetryExactly = effectStarted && exactRetryActions.has(action);
      const recovery = actionFailureState(error, canRetryExactly);
      announce(recovery.message, recovery.tone);
      if (recovery.retryExact && recovery.blockCompeting) {
        holdUncertainOperation(button, action);
        button.focus();
        return;
      }
      operationIntents.delete(button);
      if (uncertainOperation?.button === button) releaseUncertainOperation(button);
      if (!previousDisabled) button.removeAttribute("disabled");
      button.removeAttribute("aria-busy");
      button.focus();
    }
  });
  void refreshPromotionReceipts();
  window.addEventListener("focus", () => { void refreshPromotionReceipts(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshPromotionReceipts();
  });
})();
</script>`;
}
