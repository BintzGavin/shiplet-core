export const REVIEW_ATTACHMENT_MAX_COUNT = 4;
export const REVIEW_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const REVIEW_ATTACHMENT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const REVIEW_ATTACHMENT_ACCEPT =
  "image/*,video/*,.amv,.asf,.avi,.f4v,.flv,.gifv,.m4v,.mov,.mpeg,.mp4,.qt,.webm,.wmv";

export const REVIEW_ATTACHMENT_MIME_TYPES = [
  "image/gif",
  "image/heic",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/tiff",
  "image/webp",
  "image/vnd.microsoft.icon",
  "video/x-amv",
  "video/x-ms-asf",
  "video/x-msvideo",
  "video/x-f4v",
  "video/x-flv",
  "video/mp4",
  "application/mp4",
  "video/webm",
  "video/quicktime",
  "video/mpeg",
] as const;

export const REVIEW_ATTACHMENT_EXTENSION_TYPES = {
  amv: "video/x-amv",
  asf: "video/x-ms-asf",
  avi: "video/x-msvideo",
  f4v: "video/x-f4v",
  flv: "video/x-flv",
  gif: "image/gif",
  gifv: "video/mp4",
  heic: "image/heic",
  ico: "image/vnd.microsoft.icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  png: "image/png",
  qt: "video/quicktime",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webm: "video/webm",
  webp: "image/webp",
  wmv: "video/x-ms-asf",
} as const;

export type ReviewAttachmentMimeType =
  (typeof REVIEW_ATTACHMENT_MIME_TYPES)[number];

export type ReviewAttachmentDraftMetadata = {
  id: string;
  name: string;
  mimeType: ReviewAttachmentMimeType;
  size: number;
  lastModified: number;
};

export type SerializedReviewAttachment = Pick<
  ReviewAttachmentDraftMetadata,
  "id" | "name" | "mimeType" | "size"
> & { dataUrl: string };

const reviewAttachmentMimeTypeSet = new Set<string>(
  REVIEW_ATTACHMENT_MIME_TYPES,
);

export function resolveReviewAttachmentMimeType(input: {
  name: string;
  type?: string | null;
}): ReviewAttachmentMimeType | null {
  const declared = String(input.type || "").toLowerCase();
  if (reviewAttachmentMimeTypeSet.has(declared)) {
    return declared as ReviewAttachmentMimeType;
  }
  const extension = String(input.name || "").toLowerCase().split(".").pop() || "";
  return (
    REVIEW_ATTACHMENT_EXTENSION_TYPES[
      extension as keyof typeof REVIEW_ATTACHMENT_EXTENSION_TYPES
    ] || null
  );
}

/**
 * Returns a dependency-free classic script that declares
 * createReviewAttachmentDrafts in the trusted host's IIFE scope.
 *
 * Public instance API:
 * - addFiles(iterable), remove(id), clear(), hide(), show(), destroy()
 * - current() returns copied metadata without mutable internal entries
 * - serialize() captures one immutable snapshot and returns
 *   {id,name,mimeType,size,dataUrl}[] without clearing it
 * - restore([{id,file}]) replaces the draft only after every File/Blob-backed
 *   entry passes validation; Blob records also require a bounded name
 */
export function reviewAttachmentDraftScript(): string {
  const mimeTypes = JSON.stringify(REVIEW_ATTACHMENT_MIME_TYPES);
  const extensionTypes = JSON.stringify(REVIEW_ATTACHMENT_EXTENSION_TYPES);
  const accept = JSON.stringify(REVIEW_ATTACHMENT_ACCEPT);

  return String.raw`
function createReviewAttachmentDrafts(options) {
  "use strict";

  if (!options || !(options.container instanceof Element)) {
    throw new TypeError("Attachment drafts require a trusted container element.");
  }

  var maximumCount = 4;
  var maximumBytes = 5 * 1024 * 1024;
  var maximumTotalBytes = 10 * 1024 * 1024;
  var supportedMimeTypes = new Set(${mimeTypes});
  var extensionTypes = ${extensionTypes};
  var identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
  var controller = new AbortController();
  var signal = controller.signal;
  var destroyed = false;
  var entries = [];
  var errors = [];
  var pendingSerializations = new Set();
  var generatedId = 0;
  var createObjectUrl = typeof options.createObjectURL === "function"
    ? options.createObjectURL
    : URL.createObjectURL.bind(URL);
  var revokeObjectUrl = typeof options.revokeObjectURL === "function"
    ? options.revokeObjectURL
    : URL.revokeObjectURL.bind(URL);
  var readerFactory = typeof options.readerFactory === "function"
    ? options.readerFactory
    : function () { return new FileReader(); };

  var root = document.createElement("section");
  root.className = "shiplet-attachment-drafts";
  root.setAttribute("aria-label", "Photo and video attachments");

  var controls = document.createElement("div");
  controls.className = "shiplet-attachment-controls";
  var chooseButton = document.createElement("button");
  chooseButton.type = "button";
  chooseButton.className = "shiplet-attachment-choose";
  chooseButton.textContent = "Attach photos or video";
  var input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ${accept};
  input.className = "shiplet-attachment-input";
  input.setAttribute("aria-label", "Choose photos or video");
  var clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.className = "shiplet-attachment-clear";
  clearButton.textContent = "Clear all";
  clearButton.hidden = true;
  controls.append(chooseButton, input, clearButton);

  var guidance = document.createElement("p");
  guidance.className = "shiplet-attachment-guidance";
  guidance.textContent = "Up to 4 files · 5 MiB each · 10 MiB total";

  var dropTarget = document.createElement("div");
  dropTarget.className = "shiplet-attachment-drop";
  dropTarget.tabIndex = 0;
  dropTarget.setAttribute("role", "button");
  dropTarget.setAttribute("aria-label", "Drop photos or video here");
  dropTarget.textContent = "Drop photos or video here";

  var errorElement = document.createElement("p");
  errorElement.className = "shiplet-attachment-error";
  errorElement.setAttribute("role", "status");
  errorElement.setAttribute("aria-live", "polite");
  errorElement.hidden = true;

  var summary = document.createElement("p");
  summary.className = "shiplet-attachment-summary";
  summary.setAttribute("aria-live", "polite");

  var list = document.createElement("div");
  list.className = "shiplet-attachment-list";
  list.setAttribute("role", "list");

  root.append(controls, guidance, dropTarget, errorElement, summary, list);
  options.container.appendChild(root);

  function formatBytes(bytes) {
    var mebibytes = bytes / (1024 * 1024);
    if (mebibytes >= 1) {
      return (Number.isInteger(mebibytes) ? mebibytes : mebibytes.toFixed(1)) + " MiB";
    }
    return Math.max(1, Math.round(bytes / 1024)) + " KiB";
  }

  function mimeTypeFor(file, name) {
    var declared = String(file.type || "").toLowerCase();
    if (supportedMimeTypes.has(declared)) return declared;
    var extension = String(name || "").toLowerCase().split(".").pop();
    return extensionTypes[extension] || "";
  }

  function duplicateKey(name, size, lastModified) {
    return name + "\u0000" + size + "\u0000" + lastModified;
  }

  function freshId(used) {
    for (var attempt = 0; attempt < 100; attempt += 1) {
      generatedId += 1;
      var candidate = "attachment_" + generatedId;
      if (typeof options.idFactory === "function") {
        try {
          candidate = String(options.idFactory());
        } catch (_error) {
          candidate = "attachment_" + generatedId;
        }
      } else if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        candidate = "attachment_" + crypto.randomUUID();
      }
      if (identifierPattern.test(candidate) && !used.has(candidate)) return candidate;
    }
    throw new Error("Unable to allocate an attachment ID.");
  }

  function previewKind(mimeType) {
    if (mimeType === "image/jpeg" || mimeType === "image/png" ||
        mimeType === "image/gif" || mimeType === "image/webp" ||
        mimeType === "image/vnd.microsoft.icon") return "image";
    if (mimeType.indexOf("video/") === 0 || mimeType === "application/mp4") return "video";
    return "none";
  }

  function copiedCurrent() {
    return entries.map(function (entry) {
      return {
        id: entry.id,
        name: entry.name,
        mimeType: entry.mimeType,
        size: entry.size,
        lastModified: entry.lastModified,
        previewAvailable: !entry.previewUnavailable && entry.previewKind !== "none"
      };
    });
  }

  function setErrors(nextErrors) {
    errors = Array.from(new Set(nextErrors.map(function (error) {
      return String(error || "Unable to use this attachment.").slice(0, 240);
    })));
    render();
    if (errors.length && typeof options.onError === "function") {
      options.onError(errors.slice());
    }
  }

  function clearErrors() {
    errors = [];
  }

  function render() {
    if (destroyed) return;
    errorElement.textContent = errors.join(" ");
    errorElement.hidden = errors.length === 0;
    clearButton.hidden = entries.length === 0;
    var totalBytes = entries.reduce(function (total, entry) { return total + entry.size; }, 0);
    summary.textContent = entries.length
      ? entries.length + (entries.length === 1 ? " file" : " files") + " · " + formatBytes(totalBytes)
      : "No files selected";
    list.replaceChildren();
    entries.forEach(function (entry) {
      var card = document.createElement("article");
      card.className = "shiplet-attachment-card";
      card.setAttribute("role", "listitem");
      card.setAttribute("data-attachment-id", entry.id);

      var preview = document.createElement("div");
      preview.className = "shiplet-attachment-preview";
      if (entry.previewUnavailable || entry.previewKind === "none") {
        var unavailable = document.createElement("span");
        unavailable.className = "shiplet-attachment-preview-unavailable";
        unavailable.textContent = "Preview unavailable";
        preview.appendChild(unavailable);
      } else if (entry.previewKind === "image") {
        var image = document.createElement("img");
        image.alt = "Preview of " + entry.name;
        image.draggable = false;
        image.src = entry.previewUrl;
        image.setAttribute("data-attachment-preview", entry.id);
        preview.appendChild(image);
      } else {
        var video = document.createElement("video");
        video.controls = true;
        video.autoplay = false;
        video.preload = "metadata";
        video.playsInline = true;
        video.setAttribute("aria-label", "Video preview of " + entry.name);
        video.src = entry.previewUrl;
        video.setAttribute("data-attachment-preview", entry.id);
        preview.appendChild(video);
      }

      var metadata = document.createElement("div");
      metadata.className = "shiplet-attachment-meta";
      var name = document.createElement("span");
      name.className = "shiplet-attachment-name";
      name.textContent = entry.name;
      name.title = entry.name;
      var detail = document.createElement("span");
      detail.className = "shiplet-attachment-detail";
      detail.textContent = formatBytes(entry.size) + " · " + entry.mimeType;
      metadata.append(name, detail);

      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "shiplet-attachment-remove";
      remove.setAttribute("data-remove-attachment", entry.id);
      remove.setAttribute("aria-label", "Remove " + entry.name);
      remove.textContent = "Remove";
      card.append(preview, metadata, remove);
      list.appendChild(card);
    });
  }

  function revokeEntry(entry) {
    if (entry.revoked) return;
    entry.revoked = true;
    try { revokeObjectUrl(entry.previewUrl); } catch (_error) {}
  }

  function addFiles(fileList) {
    if (destroyed) return { ok: false, error: "Attachment drafts are destroyed." };
    var files = Array.from(fileList || []);
    if (!files.length) return { ok: true, value: copiedCurrent(), errors: [] };
    var nextErrors = [];
    var totalBytes = entries.reduce(function (total, entry) { return total + entry.size; }, 0);
    var duplicateKeys = new Set(entries.map(function (entry) {
      return duplicateKey(entry.name, entry.size, entry.lastModified);
    }));
    var usedIds = new Set(entries.map(function (entry) { return entry.id; }));

    files.forEach(function (file) {
      if (!(file instanceof Blob)) {
        nextErrors.push("Only files can be attached.");
        return;
      }
      var name = typeof file.name === "string" ? file.name : "";
      var lastModified = Number.isFinite(file.lastModified) && file.lastModified >= 0
        ? Math.floor(file.lastModified)
        : 0;
      if (!name || name.length > 255) {
        nextErrors.push("Attachment names must contain 1 through 255 characters.");
        return;
      }
      var key = duplicateKey(name, file.size, lastModified);
      if (duplicateKeys.has(key)) return;
      var mimeType = mimeTypeFor(file, name);
      if (!mimeType) {
        nextErrors.push(name + " is not a supported photo or video.");
        return;
      }
      if (!file.size || file.size > maximumBytes) {
        nextErrors.push(name + " must be between 1 byte and 5 MiB.");
        return;
      }
      if (entries.length >= maximumCount) {
        nextErrors.push("You can attach up to 4 files.");
        return;
      }
      if (totalBytes + file.size > maximumTotalBytes) {
        nextErrors.push("Attachments must total 10 MiB or less.");
        return;
      }
      var previewUrl;
      try {
        previewUrl = createObjectUrl(file);
      } catch (_error) {
        nextErrors.push(name + " could not be prepared for preview.");
        return;
      }
      var id;
      try {
        id = freshId(usedIds);
      } catch (error) {
        try { revokeObjectUrl(previewUrl); } catch (_revokeError) {}
        nextErrors.push(error instanceof Error ? error.message : "Unable to allocate an attachment ID.");
        return;
      }
      var kind = previewKind(mimeType);
      entries.push({
        id: id,
        file: file,
        name: name,
        mimeType: mimeType,
        size: file.size,
        lastModified: lastModified,
        previewUrl: previewUrl,
        previewKind: kind,
        previewUnavailable: kind === "none",
        revoked: false
      });
      usedIds.add(id);
      duplicateKeys.add(key);
      totalBytes += file.size;
    });

    errors = Array.from(new Set(nextErrors));
    render();
    if (errors.length && typeof options.onError === "function") options.onError(errors.slice());
    return { ok: true, value: copiedCurrent(), errors: errors.slice() };
  }

  function remove(id) {
    if (destroyed || typeof id !== "string") return false;
    var index = entries.findIndex(function (entry) { return entry.id === id; });
    if (index < 0) return false;
    var removed = entries.splice(index, 1)[0];
    revokeEntry(removed);
    clearErrors();
    render();
    return true;
  }

  function cancelSerializations(message) {
    Array.from(pendingSerializations).forEach(function (operation) {
      operation.cancel(message);
    });
  }

  function clear() {
    if (destroyed) return false;
    cancelSerializations("Attachment serialization was cancelled because the draft was cleared.");
    entries.forEach(revokeEntry);
    entries = [];
    clearErrors();
    render();
    return true;
  }

  function restore(records) {
    if (destroyed) return { ok: false, error: "Attachment drafts are destroyed." };
    if (!Array.isArray(records)) {
      setErrors(["Saved attachments must be an array."]);
      return { ok: false, error: errors[0] };
    }
    if (records.length > maximumCount) {
      setErrors(["Saved attachments cannot contain more than 4 files."]);
      return { ok: false, error: errors[0] };
    }
    var prepared = [];
    var totalBytes = 0;
    var ids = new Set();
    var duplicates = new Set();
    var validationError = "";

    for (var index = 0; index < records.length; index += 1) {
      var record = records[index];
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        validationError = "Saved attachment " + (index + 1) + " is invalid.";
        break;
      }
      var id = typeof record.id === "string" ? record.id : "";
      if (!identifierPattern.test(id) || ids.has(id)) {
        validationError = "Saved attachment IDs must be valid and unique.";
        break;
      }
      var file = record.file;
      if (!(file instanceof Blob)) {
        validationError = "Saved attachments require File or Blob data.";
        break;
      }
      var fileName = typeof file.name === "string" ? file.name : "";
      var name = fileName || (typeof record.name === "string" ? record.name : "");
      if (!name || name.length > 255) {
        validationError = "Saved attachment names must contain 1 through 255 characters.";
        break;
      }
      if (!file.size || file.size > maximumBytes) {
        validationError = name + " must be between 1 byte and 5 MiB.";
        break;
      }
      totalBytes += file.size;
      if (totalBytes > maximumTotalBytes) {
        validationError = "Saved attachments must total 10 MiB or less.";
        break;
      }
      var lastModified = Number.isFinite(file.lastModified) && file.lastModified >= 0
        ? Math.floor(file.lastModified)
        : (Number.isFinite(record.lastModified) && record.lastModified >= 0
          ? Math.floor(record.lastModified)
          : 0);
      var mimeType = mimeTypeFor(file, name);
      if (!mimeType || (record.mimeType != null && record.mimeType !== mimeType)) {
        validationError = name + " has invalid saved attachment metadata.";
        break;
      }
      var key = duplicateKey(name, file.size, lastModified);
      if (duplicates.has(key)) {
        validationError = "Saved attachments cannot contain duplicates.";
        break;
      }
      ids.add(id);
      duplicates.add(key);
      prepared.push({
        id: id,
        file: file,
        name: name,
        mimeType: mimeType,
        size: file.size,
        lastModified: lastModified
      });
    }

    if (validationError) {
      setErrors([validationError]);
      return { ok: false, error: validationError };
    }

    var replacements = [];
    try {
      prepared.forEach(function (record) {
        var url = createObjectUrl(record.file);
        var kind = previewKind(record.mimeType);
        replacements.push({
          id: record.id,
          file: record.file,
          name: record.name,
          mimeType: record.mimeType,
          size: record.size,
          lastModified: record.lastModified,
          previewUrl: url,
          previewKind: kind,
          previewUnavailable: kind === "none",
          revoked: false
        });
      });
    } catch (_error) {
      replacements.forEach(revokeEntry);
      setErrors(["Saved attachments could not be prepared for preview."]);
      return { ok: false, error: errors[0] };
    }

    cancelSerializations("Attachment serialization was cancelled because the draft was replaced.");
    entries.forEach(revokeEntry);
    entries = replacements;
    clearErrors();
    render();
    return { ok: true, value: copiedCurrent() };
  }

  function serialize() {
    if (destroyed) return Promise.reject(new Error("Attachment drafts are destroyed."));
    var captured = entries.map(function (entry) {
      return {
        id: entry.id,
        file: entry.file,
        name: entry.name,
        mimeType: entry.mimeType,
        size: entry.size
      };
    });
    if (!captured.length) return Promise.resolve([]);

    return new Promise(function (resolve, reject) {
      var results = new Array(captured.length);
      var remaining = captured.length;
      var operation = {
        settled: false,
        readers: [],
        cancel: function (message) {
          if (operation.settled) return;
          operation.settled = true;
          pendingSerializations.delete(operation);
          operation.readers.forEach(function (reader) {
            try { reader.abort(); } catch (_error) {}
          });
          reject(new Error(message));
        }
      };
      pendingSerializations.add(operation);

      function fail(error) {
        if (operation.settled) return;
        operation.settled = true;
        pendingSerializations.delete(operation);
        operation.readers.forEach(function (reader) {
          try { reader.abort(); } catch (_abortError) {}
        });
        if (!destroyed) setErrors(["Attachment could not be read. Try again."]);
        reject(error instanceof Error ? error : new Error("Attachment could not be read."));
      }

      captured.forEach(function (record, index) {
        if (operation.settled) return;
        var reader;
        try {
          reader = readerFactory();
          if (!reader || typeof reader.addEventListener !== "function" ||
              typeof reader.readAsDataURL !== "function") {
            throw new Error("Attachment reader is unavailable.");
          }
        } catch (error) {
          fail(error);
          return;
        }
        operation.readers.push(reader);
        reader.addEventListener("load", function () {
          if (operation.settled) return;
          var result = typeof reader.result === "string" ? reader.result : "";
          var separator = result.indexOf(",");
          if (separator < 0) {
            fail(new Error("Attachment could not be encoded."));
            return;
          }
          results[index] = {
            id: record.id,
            name: record.name,
            mimeType: record.mimeType,
            size: record.size,
            dataUrl: "data:" + record.mimeType + ";base64," + result.slice(separator + 1)
          };
          remaining -= 1;
          if (remaining === 0) {
            operation.settled = true;
            pendingSerializations.delete(operation);
            resolve(results);
          }
        });
        reader.addEventListener("error", function () {
          fail(reader.error || new Error("Attachment could not be read."));
        });
        reader.addEventListener("abort", function () {
          if (!operation.settled) fail(new Error("Attachment reading was aborted."));
        });
        try {
          reader.readAsDataURL(record.file);
        } catch (error) {
          fail(error);
        }
      });
    });
  }

  function isFileDrag(event) {
    return Array.from((event.dataTransfer && event.dataTransfer.types) || []).indexOf("Files") >= 0;
  }

  chooseButton.addEventListener("click", function () { input.click(); }, { signal: signal });
  input.addEventListener("change", function () {
    addFiles(input.files);
    input.value = "";
  }, { signal: signal });
  clearButton.addEventListener("click", clear, { signal: signal });
  dropTarget.addEventListener("click", function () { input.click(); }, { signal: signal });
  dropTarget.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    input.click();
  }, { signal: signal });
  dropTarget.addEventListener("dragenter", function (event) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dropTarget.setAttribute("data-dragging", "true");
  }, { signal: signal });
  dropTarget.addEventListener("dragover", function (event) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }, { signal: signal });
  dropTarget.addEventListener("dragleave", function (event) {
    if (event.relatedTarget && dropTarget.contains(event.relatedTarget)) return;
    dropTarget.removeAttribute("data-dragging");
  }, { signal: signal });
  dropTarget.addEventListener("drop", function (event) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dropTarget.removeAttribute("data-dragging");
    addFiles(event.dataTransfer && event.dataTransfer.files);
  }, { signal: signal });
  root.addEventListener("click", function (event) {
    var target = event.target instanceof Element
      ? event.target.closest("button[data-remove-attachment]")
      : null;
    if (!target || !root.contains(target)) return;
    if (remove(target.getAttribute("data-remove-attachment"))) chooseButton.focus();
  }, { signal: signal });
  root.addEventListener("error", function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var id = target.getAttribute("data-attachment-preview");
    if (!id) return;
    var entry = entries.find(function (candidate) { return candidate.id === id; });
    if (!entry || entry.previewUnavailable) return;
    entry.previewUnavailable = true;
    render();
  }, { capture: true, signal: signal });

  render();

  return Object.freeze({
    root: root,
    addFiles: addFiles,
    remove: remove,
    clear: clear,
    hide: function () {
      if (destroyed) return false;
      root.hidden = true;
      return true;
    },
    show: function () {
      if (destroyed) return false;
      root.hidden = false;
      return true;
    },
    destroy: function () {
      if (destroyed) return false;
      destroyed = true;
      cancelSerializations("Attachment serialization was cancelled because the component was destroyed.");
      entries.forEach(revokeEntry);
      entries = [];
      controller.abort();
      root.remove();
      return true;
    },
    current: copiedCurrent,
    serialize: serialize,
    restore: restore
  });
}
`;
}

export function reviewAttachmentDraftStyles(): string {
  return String.raw`
.shiplet-attachment-drafts{display:grid;gap:8px;color:#102a3c;font:13px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.shiplet-attachment-drafts[hidden]{display:none}
.shiplet-attachment-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.shiplet-attachment-controls button{min-height:36px;border:1px solid #9cb4c2;border-radius:7px;background:#fff;color:#123f52;font:inherit;font-weight:700;padding:7px 11px;cursor:pointer}
.shiplet-attachment-controls button:hover,.shiplet-attachment-controls button:focus-visible{border-color:#167f8d;outline:2px solid rgba(22,127,141,.25);outline-offset:1px}
.shiplet-attachment-choose{background:#e9f7f5!important;border-color:#78bdb7!important;color:#064b47!important}
.shiplet-attachment-clear{margin-left:auto}
.shiplet-attachment-input{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
.shiplet-attachment-guidance,.shiplet-attachment-summary,.shiplet-attachment-error{margin:0}
.shiplet-attachment-guidance,.shiplet-attachment-summary{color:#597282;font-size:12px}
.shiplet-attachment-drop{display:flex;align-items:center;justify-content:center;min-height:58px;border:2px dashed #9cb4c2;border-radius:8px;background:#f7fafb;color:#365b6c;font-weight:700;text-align:center;padding:10px;cursor:pointer}
.shiplet-attachment-drop[data-dragging="true"],.shiplet-attachment-drop:focus-visible{border-color:#0d7280;background:#e8f7f4;outline:2px solid rgba(13,114,128,.2);outline-offset:2px}
.shiplet-attachment-error{color:#8c281f;font-weight:700}
.shiplet-attachment-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.shiplet-attachment-card{display:grid;grid-template-columns:88px minmax(0,1fr);grid-template-rows:minmax(64px,auto) auto;min-width:0;border:1px solid #c8dce6;border-radius:8px;background:#fff;overflow:hidden;position:relative}
.shiplet-attachment-preview{display:flex;align-items:center;justify-content:center;grid-row:1/3;background:#e5edf1;min-height:76px;overflow:hidden}
.shiplet-attachment-preview img,.shiplet-attachment-preview video{display:block;width:100%;height:100%;min-height:76px;object-fit:cover}
.shiplet-attachment-preview video{background:#17232b}
.shiplet-attachment-preview-unavailable{color:#5e7480;font-size:11px;font-weight:700;padding:8px;text-align:center}
.shiplet-attachment-meta{display:flex;flex-direction:column;gap:3px;min-width:0;padding:9px 10px 4px}
.shiplet-attachment-name{font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.shiplet-attachment-detail{color:#657e8b;font-size:11px;overflow-wrap:anywhere}
.shiplet-attachment-remove{justify-self:start;margin:0 10px 8px;border:0;background:transparent;color:#8c281f;font:inherit;font-size:12px;font-weight:800;padding:3px 0;cursor:pointer}
.shiplet-attachment-remove:hover,.shiplet-attachment-remove:focus-visible{text-decoration:underline;outline:2px solid rgba(140,40,31,.22);outline-offset:2px}
@media(max-width:520px){.shiplet-attachment-list{grid-template-columns:1fr}.shiplet-attachment-clear{margin-left:0}}
@media(prefers-reduced-motion:reduce){.shiplet-attachment-drafts *{scroll-behavior:auto!important;transition:none!important}}
`;
}
