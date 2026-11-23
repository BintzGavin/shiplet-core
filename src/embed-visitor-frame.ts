// The visitor frame: Shiplet's own page inside the website widget for people
// who are not signed in, when the installation has visitor feedback on.
//
// It runs the Turnstile check on Shiplet's origin (so the widget's site key
// only needs Shiplet's hostname), keeps the visitor token inside this frame,
// and offers two things: leave a note, and, when an agent is on duty, ask it.
// It reuses the widget's "expanded" view, so the parent widget needs nothing new.
import type { EmbedInstallationRecord } from "./embed";

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

function escapeHtml(value: string) {
	return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

export function visitorFrameResponse(input: {
	origin: string;
	installation: Pick<EmbedInstallationRecord, "id" | "site_origin" | "site_name">;
	pageUrl: string;
	siteKey: string;
	nonce: string;
	backUrl: string;
}) {
	const { origin, installation, nonce } = input;
	const e = escapeHtml;
	const html = `<!doctype html><html lang="en" data-shiplet-visitor-frame="v1" data-installation-id="${e(installation.id)}" data-site-origin="${e(installation.site_origin)}" data-page-url="${e(input.pageUrl)}" data-site-key="${e(input.siteKey)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Feedback</title><link rel="stylesheet" href="${origin}/api/embed/visitor.css"><script src="${origin}/api/embed/visitor.js" nonce="${nonce}" defer></script><script src="${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit" nonce="${nonce}" async defer></script></head><body><main class="visitor" aria-labelledby="visitorTitle"><header class="visitor-head"><h1 id="visitorTitle">Feedback for ${e(installation.site_name || new URL(installation.site_origin).hostname)}</h1><a class="visitor-close" href="${e(input.backUrl)}" data-visitor-close>Close</a></header><p class="visitor-lede">No account needed. Your note goes to the team behind this site, marked as from a visitor. Don't include passwords or personal details.</p><section data-visitor-step="check"><p class="visitor-hint">First, a quick check that you are a person.</p><div id="visitorCheck"></div></section><section data-visitor-step="note" hidden><form data-visitor-note><label for="visitorNote">Your note about this page</label><textarea id="visitorNote" rows="4" maxlength="2000" required></textarea><button type="submit">Send note</button></form><p role="status" data-visitor-note-status></p></section><section data-visitor-step="chat" hidden aria-labelledby="visitorChatTitle"><h2 id="visitorChatTitle">Ask <span data-visitor-agent></span></h2><p class="visitor-hint">An AI agent is answering visitors right now. It can make mistakes.</p><ol class="visitor-lines" aria-live="polite" data-visitor-lines></ol><form data-visitor-chat><label for="visitorAsk">Your question</label><textarea id="visitorAsk" rows="2" maxlength="2000" required></textarea><button type="submit">Ask</button></form></section><p role="alert" class="visitor-error" data-visitor-error hidden></p></main></body></html>`;
	return new Response(html, {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": [
				"default-src 'none'",
				`script-src 'nonce-${nonce}' ${TURNSTILE_ORIGIN}`,
				"script-src-attr 'none'",
				`frame-src ${TURNSTILE_ORIGIN}`,
				"connect-src 'self'",
				"img-src 'none'",
				"style-src 'self'",
				"style-src-attr 'none'",
				"base-uri 'none'",
				"form-action 'none'",
				`frame-ancestors 'self' ${installation.site_origin}`,
			].join("; "),
			"cache-control": "no-store",
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
		},
	});
}

export const VISITOR_FRAME_CSS = `:root{color-scheme:light dark;--bg:#fbfaf7;--text:#1f2933;--soft:#52606d;--line:#d9d4c7;--accent:#c2563b;--err:#b42318}
@media(prefers-color-scheme:dark){:root{--bg:#1b1f24;--text:#eef1f4;--soft:#a7b1bc;--line:#3a424c;--accent:#e07a5f;--err:#f97066}}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,sans-serif}
.visitor{display:grid;gap:12px;align-content:start;height:100%;overflow-y:auto;padding:16px;border:1px solid var(--line);border-radius:12px}
.visitor-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px}.visitor-head h1{margin:0;font-size:17px}
.visitor-close{color:var(--soft);font-size:14px}.visitor-lede,.visitor-hint{margin:0;color:var(--soft);font-size:13px}
section{display:grid;gap:8px}section[hidden],[hidden]{display:none!important}h2{margin:8px 0 0;font-size:15px}
form{display:grid;gap:6px}label{font-weight:600;font-size:13px}textarea{width:100%;font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:8px;padding:8px;resize:vertical}
button{justify-self:start;font:inherit;font-weight:600;color:#fff;background:var(--accent);border:0;border-radius:8px;padding:7px 14px;cursor:pointer}button:disabled{opacity:.6;cursor:default}
button:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.visitor-lines{display:grid;gap:6px;margin:0;padding:0;list-style:none;max-height:180px;overflow-y:auto}.visitor-lines li{padding:6px 10px;border:1px solid var(--line);border-radius:8px;max-width:90%;overflow-wrap:anywhere}
.visitor-lines li[data-mine]{justify-self:end}.visitor-lines strong{display:block;font-size:12px;color:var(--soft)}
.visitor-error{margin:0;color:var(--err);font-size:13px}[data-visitor-note-status]{margin:0;font-size:13px}`;

// Plain script, no framework. Every value from the server or the agent is set
// with textContent, never as HTML.
export const VISITOR_FRAME_SCRIPT = String.raw`(() => {
	const root = document.documentElement;
	const installationId = root.dataset.installationId || "";
	const siteOrigin = root.dataset.siteOrigin || "";
	const pageUrl = root.dataset.pageUrl || "";
	const siteKey = root.dataset.siteKey || "";
	const $ = (selector) => document.querySelector(selector);
	const step = (name) => $('[data-visitor-step="' + name + '"]');
	const errorBox = $("[data-visitor-error]");
	let token = "";
	let widgetId = null;
	let polling = false;

	function notify(view) {
		if (parent !== window && siteOrigin) parent.postMessage({ protocol: "shiplet.embed.ui.v1", view }, siteOrigin);
	}
	function showError(message) {
		errorBox.textContent = message || "";
		errorBox.hidden = !message;
	}
	async function call(method, path, body) {
		const response = await fetch(path, {
			method,
			credentials: "omit",
			cache: "no-store",
			headers: Object.assign({ "content-type": "application/json" }, token ? { authorization: "Bearer " + token } : {}),
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const data = await response.json().catch(() => ({}));
		if (response.status === 401 && token) {
			token = "";
			step("note").hidden = true;
			step("chat").hidden = true;
			step("check").hidden = false;
			if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
		}
		if (!response.ok) throw new Error(data.message || "Something went wrong. Try again.");
		return data;
	}

	async function exchange(turnstileToken) {
		showError("");
		try {
			const session = await call("POST", "/api/embed/visitors/session", { installation_id: installationId, turnstile_token: turnstileToken, page_url: pageUrl });
			token = session.token;
			step("check").hidden = true;
			step("note").hidden = false;
			$("#visitorNote").focus();
			const chat = await call("GET", "/api/embed/visitors/chat");
			if (chat.onDuty && chat.agent) {
				$("[data-visitor-agent]").textContent = chat.agent.name;
				step("chat").hidden = false;
				poll();
			}
		} catch (error) {
			showError(error.message);
			if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
		}
	}

	function renderCheck() {
		if (!window.turnstile) return void setTimeout(renderCheck, 100);
		widgetId = window.turnstile.render("#visitorCheck", {
			sitekey: siteKey,
			action: "visitor",
			callback: exchange,
			"error-callback": () => showError("The check could not load. Reload the page and try again."),
		});
	}

	function addLine(text, who, mine) {
		const item = document.createElement("li");
		if (mine) item.dataset.mine = "";
		const name = document.createElement("strong");
		name.textContent = who;
		item.append(name, document.createTextNode(text));
		$("[data-visitor-lines]").append(item);
		item.scrollIntoView({ block: "nearest" });
	}

	async function poll() {
		if (polling) return;
		polling = true;
		while (token) {
			try {
				const inbox = await call("GET", "/api/embed/visitors/chat/inbox?wait=20");
				for (const message of inbox.messages || []) addLine(message.text, message.from.name, false);
			} catch (error) {
				showError(error.message);
				await new Promise((resolve) => setTimeout(resolve, 5000));
			}
		}
		polling = false;
	}

	function busy(form, on) {
		const button = form.querySelector("button");
		button.disabled = on;
		if (on) button.setAttribute("aria-busy", "true");
		else button.removeAttribute("aria-busy");
	}

	$("[data-visitor-note]").addEventListener("submit", async (event) => {
		event.preventDefault();
		const form = event.currentTarget;
		const field = $("#visitorNote");
		const comment = field.value.trim();
		if (!comment) return;
		busy(form, true);
		showError("");
		try {
			const result = await call("POST", "/api/embed/visitors/feedback", { comment, pageUrl, viewport: { width: innerWidth, height: innerHeight } });
			field.value = "";
			$("[data-visitor-note-status]").textContent = "Thanks. Your note reached the team" + (result.feedback && result.feedback.ticket_label ? " as " + result.feedback.ticket_label : "") + ".";
		} catch (error) {
			showError(error.message);
		} finally {
			busy(form, false);
		}
	});

	$("[data-visitor-chat]").addEventListener("submit", async (event) => {
		event.preventDefault();
		const form = event.currentTarget;
		const field = $("#visitorAsk");
		const text = field.value.trim();
		if (!text) return;
		busy(form, true);
		showError("");
		try {
			await call("POST", "/api/embed/visitors/chat", { text, pageUrl });
			addLine(text, "You", true);
			field.value = "";
		} catch (error) {
			showError(error.message);
		} finally {
			busy(form, false);
		}
	});

	$("[data-visitor-close]").addEventListener("click", () => notify("toolbar"));
	notify("expanded");
	renderCheck();
})();`;
