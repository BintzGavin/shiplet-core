import {
  kernelScriptNonceAttribute,
  type KernelDocumentNonce,
} from "../kernel-document-nonce";

export const PlatformLiveUpdatesScript = (nonce: KernelDocumentNonce) => `
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(nonce)} id="shiplet-platform-live-updates">
(function() {
  if (!document.querySelector("[data-platform-app='react-tanstack']")) return;
  var POLL_MS = 15000;
  var inFlight = false;

  function qs(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function formatDate(value) {
    if (!value) return "Recently";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Recently";
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  }
  function notificationHref(notification) {
    var feedbackQuery = notification.feedback_id ? "?feedback=" + encodeURIComponent(notification.feedback_id) : "";
    return "/shiplets/" + encodeURIComponent(notification.project_id) + feedbackQuery;
  }
  async function requestJson(path) {
    var response = await fetch(path, { credentials: "same-origin" });
    if (!response.ok) throw new Error("Live update failed: " + response.status);
    return response.json();
  }
  function setBadge(id, count) {
    var badge = qs(id);
    if (!badge) return;
    badge.textContent = String(count);
    badge.hidden = count <= 0;
  }
  function setStatus(id, message, kind) {
    var status = qs(id);
    if (!status) return;
    status.className = "live-status live-status-" + (kind || "info");
    status.textContent = message;
  }
  function renderNotifications(notifications) {
    if (qs("inbox-platform-root")) return;
    var rows = qs("notificationRows");
    if (!rows) return;
    if (!notifications.length) {
      rows.innerHTML = "<tr><td colspan=\\"5\\">No notifications yet.</td></tr>";
      return;
    }
    rows.innerHTML = notifications.map(function(notification) {
      var readLabel = notification.read_on ? "Read" : "Unread";
      var visibility = notification.read_on ? "organization" : "private";
      return "<tr data-notification-row=\\"" + esc(notification.id) + "\\">" +
        "<td><span class=\\"shiplet-visibility-badge\\" data-visibility=\\"" + visibility + "\\">" + readLabel + "</span></td>" +
        "<td><a class=\\"table-link\\" href=\\"" + esc(notificationHref(notification)) + "\\">" + esc(notification.message) + "</a></td>" +
        "<td>" + esc(notification.project_name || "Shiplet") + "</td>" +
        "<td>" + esc(String(notification.reason || "").replace(/_/g, " ")) + "</td>" +
        "<td>" + esc(formatDate(notification.created_on)) + "</td>" +
      "</tr>";
    }).join("");
  }
  function feedbackSearch(filters) {
    var params = new URLSearchParams();
    if (filters && filters.projectId) params.set("projectId", filters.projectId);
    if (filters && filters.status) params.set("status", filters.status);
    if (filters && filters.mentionedMe) params.set("mentionedMe", "true");
    if (filters && filters.watched) params.set("watched", "true");
    if (filters && filters.submittedByMe) params.set("submittedByMe", "true");
    params.set("limit", "100");
    var search = params.toString();
    return search ? "?" + search : "";
  }
  function readFeedbackFilters() {
    var node = qs("shiplet-platform-feedback-state");
    if (!node) return {};
    try {
      return (JSON.parse(node.textContent || "{}").filters) || {};
    } catch (error) {
      return {};
    }
  }
  function renderFeedback(feedback) {
    if (qs("feedback-platform-root")) return;
    var rows = qs("feedbackRows");
    if (!rows) return;
    if (!feedback.length) {
      rows.innerHTML = "<tr><td colspan=\\"7\\">No feedback matched these filters.</td></tr>";
      return;
    }
    rows.innerHTML = feedback.map(function(item) {
      var ticketLabel = item.ticket_label || ("PF-" + item.ticket_number);
      var mentions = (item.mentions || []).map(function(mention) {
        var label = mention.mentioned_name || mention.mentioned_email || "Reviewer";
        return "<span class=\\"success-card-label\\">" + esc(label) + "</span>";
      }).join("");
      return "<tr data-feedback-row=\\"" + esc(item.id) + "\\">" +
        "<td><a class=\\"table-link\\" href=\\"/shiplets/" + encodeURIComponent(item.project_id) + "?feedback=" + encodeURIComponent(item.id) + "\\">" + esc(ticketLabel) + "</a></td>" +
        "<td>" + esc(item.project_name || item.project_id || "Shiplet") + "</td>" +
        "<td>" + esc(item.status || "") + "</td>" +
        "<td>" + esc(item.comment || "") + "</td>" +
        "<td>" + (mentions || "-") + "</td>" +
        "<td>" + esc(item.submitted_by_email || "Reviewer") + "</td>" +
        "<td>" + esc(formatDate(item.created_on)) + "</td>" +
      "</tr>";
    }).join("");
  }
  async function refreshNotifications() {
    var hasHydratedInboxRoot = !!qs("inbox-platform-root");
    var data = await requestJson("/api/notifications?limit=100");
    var notifications = data.notifications || [];
    var unreadCount = notifications.filter(function(notification) { return !notification.read_on; }).length;
    if (!hasHydratedInboxRoot) {
      setBadge("platformInboxBadge", unreadCount);
      renderNotifications(notifications);
      setStatus("inboxLiveStatus", "Live. Updated " + new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) + ".", "success");
    }
    window.dispatchEvent(new CustomEvent("shiplet:platform-notifications-updated", { detail: { notifications: notifications } }));
  }
  async function refreshFeedback() {
    if (!qs("feedbackRows") && !qs("platformFeedbackBadge")) return;
    var hasHydratedFeedbackRoot = !!qs("feedback-platform-root");
    var filters = readFeedbackFilters();
    var data = await requestJson("/api/feedback" + feedbackSearch(filters));
    var feedback = data.feedback || [];
    if (!hasHydratedFeedbackRoot) {
      setBadge("platformFeedbackBadge", feedback.length);
      renderFeedback(feedback);
      setStatus("feedbackLiveStatus", "Live. Updated " + new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) + ".", "success");
    }
    window.dispatchEvent(new CustomEvent("shiplet:platform-feedback-updated", { detail: { feedback: feedback, filters: filters } }));
  }
  async function tick() {
    if (inFlight || document.visibilityState === "hidden") return;
    inFlight = true;
    try {
      await Promise.all([refreshNotifications(), refreshFeedback()]);
    } catch (error) {
      setStatus("inboxLiveStatus", error.message || String(error), "error");
      setStatus("feedbackLiveStatus", error.message || String(error), "error");
    } finally {
      inFlight = false;
    }
  }
  window.addEventListener("message", function(event) {
    var data = event.data || {};
    if (data.type === "shiplet:feedback-created" || data.type === "shiplet:feedback-updated") tick();
  });
  window.addEventListener("focus", tick);
  document.addEventListener("visibilitychange", tick);
  window.setInterval(tick, POLL_MS);
  window.setTimeout(tick, 1500);
})();
</script>`;
