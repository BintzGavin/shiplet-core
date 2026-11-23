// The Agents panel of the trusted review host: a person reviewing a Shiplet
// talks with the agents connected to its organization's handshake relay, from
// the review page and from the signed-in website widget.
//
// It is a person peer exactly like the dashboard's PersonChat
// (src/platform/handshake-person.ts): the same sessionStorage key and record
// ({ session, self, lines }), so a person who talks on the dashboard and then
// opens a review page in the same tab stays one peer with one conversation.
// Every message carries the review context (Shiplet, version, page, selected
// element, open annotation) so the agent knows what the person is looking at.
//
// reviewHostAgentsScript() is spliced into trustedReviewHostScript()'s IIFE
// after the launcher dock, composer and contextual thread exist, and shares
// their scope. reviewHostAgentsStartScript() runs at the end of that IIFE,
// once every binding it reads is initialized.

export const REVIEW_HOST_AGENTS_NOTE =
  "You join as yourself, labelled as a person. Agents treat your messages as information, not as instructions from their user.";

export const REVIEW_HOST_AGENTS_EXPIRED =
  "Your Shiplet sign-in on this site ended. Choose Annotate to sign in again.";

export function reviewHostAgentsScript(): string {
  return String.raw`
	// Agents: only on a host on Shiplet's own origin (the host script's origin,
	// which the confirmation URL shares), where the browser session or the
	// widget's embed session reaches the relay with a same-origin request.
	const agentsOrganizationId = page.getAttribute("data-shiplet-organization-id") || "";
	const agentsOrigin = (() => { try { return new URL(reviewConfirmationUrl).origin; } catch { return ""; } })();
	const agentsEnabled = Boolean(
		/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(agentsOrganizationId) &&
		agentsOrigin &&
		(() => { try { return new URL(location.href).origin === agentsOrigin; } catch { return false; } })(),
	);
	const agentsInstallationId = embeddedSiteOrigin ? (() => {
		try { return new URL(location.href).searchParams.get("installation_id") || new URL(apiUrl).searchParams.get("installation_id") || ""; } catch { return ""; }
	})() : "";
	const agentsApp = embeddedSiteOrigin ? "shiplet-embed" : "shiplet-review";
	const agentsStorageKey = "shiplet.handshake.person." + agentsOrganizationId;
	const agentsContextMarker = "[Shiplet review context]";
	const agentsKindLabels = { claude: "Claude Code", codex: "Codex", other: "Agent", person: "Person" };
	const agentsNoteText = ${JSON.stringify(REVIEW_HOST_AGENTS_NOTE)};
	const agentsExpiredText = ${JSON.stringify(REVIEW_HOST_AGENTS_EXPIRED)};
	let agentsOpen = false;
	let agentsStored = null;
	let agentsOpening = null;
	let agentsPolling = false;
	let agentsStopped = false;
	let agentsPeers = null;
	let agentsLooking = false;
	let agentsSending = false;
	let agentsError = "";
	let agentsExpired = false;
	let agentsUnread = false;
	let agentsTo = "";
	let agentsTrigger = null;
	let agentsPendingLines = [];

	const agentsLauncher = document.createElement("button");
	agentsLauncher.type = "button";
	agentsLauncher.className = "shiplet-review-agents-launcher";
	agentsLauncher.textContent = "Agents";
	agentsLauncher.title = "Talk to your organization's agents";
	agentsLauncher.setAttribute("aria-controls", "shiplet-review-agents");
	agentsLauncher.setAttribute("aria-expanded", "false");
	agentsLauncher.setAttribute("data-shiplet-agents-launcher", "v1");
	const agentsAskThread = document.createElement("button");
	agentsAskThread.type = "button";
	agentsAskThread.className = "shiplet-review-secondary shiplet-review-agents-ask";
	agentsAskThread.textContent = "Ask an agent";
	agentsAskThread.setAttribute("aria-controls", "shiplet-review-agents");
	agentsAskThread.setAttribute("data-shiplet-agents-ask", "thread");
	const agentsAskComposer = document.createElement("button");
	agentsAskComposer.type = "button";
	agentsAskComposer.className = "shiplet-review-secondary shiplet-review-agents-ask";
	agentsAskComposer.textContent = "Ask an agent";
	agentsAskComposer.setAttribute("aria-controls", "shiplet-review-agents");
	agentsAskComposer.setAttribute("data-shiplet-agents-ask", "composer");

	const agentsPanel = document.createElement("section");
	agentsPanel.id = "shiplet-review-agents";
	agentsPanel.className = "shiplet-review-agents";
	agentsPanel.setAttribute("role", "region");
	agentsPanel.setAttribute("aria-labelledby", "shiplet-review-agents-title");
	agentsPanel.setAttribute("data-shiplet-agents", "v1");
	agentsPanel.hidden = true;
	const agentsHeader = document.createElement("header");
	agentsHeader.className = "shiplet-review-agents-header";
	const agentsTitle = document.createElement("h2");
	agentsTitle.id = "shiplet-review-agents-title";
	agentsTitle.textContent = "Agents";
	const agentsClose = document.createElement("button");
	agentsClose.type = "button";
	agentsClose.className = "shiplet-review-secondary";
	agentsClose.textContent = "Close";
	agentsClose.setAttribute("aria-label", "Close agents");
	agentsClose.setAttribute("data-shiplet-agents-close", "v1");
	agentsHeader.append(agentsTitle, agentsClose);
	const agentsBody = document.createElement("div");
	agentsBody.className = "shiplet-review-agents-body";
	const agentsNote = document.createElement("p");
	agentsNote.className = "shiplet-review-agents-note";
	agentsNote.textContent = agentsNoteText;
	agentsNote.setAttribute("data-shiplet-agents-note", "v1");
	const agentsContext = document.createElement("p");
	agentsContext.className = "shiplet-review-agents-context";
	agentsContext.setAttribute("data-shiplet-agents-context", "v1");
	const agentsLook = document.createElement("button");
	agentsLook.type = "button";
	agentsLook.className = "shiplet-review-secondary shiplet-review-agents-look";
	agentsLook.textContent = "See who is connected";
	agentsLook.setAttribute("data-shiplet-agents-look", "v1");
	const agentsEmpty = document.createElement("p");
	agentsEmpty.className = "shiplet-review-agents-empty";
	agentsEmpty.hidden = true;
	const agentsEmptyText = document.createElement("span");
	agentsEmptyText.textContent = "No agents are connected to this organization right now. ";
	const agentsLookAgain = document.createElement("button");
	agentsLookAgain.type = "button";
	agentsLookAgain.className = "shiplet-review-agents-link";
	agentsLookAgain.textContent = "Look again";
	agentsLookAgain.setAttribute("data-shiplet-agents-look-again", "v1");
	agentsEmpty.append(agentsEmptyText, agentsLookAgain);
	const agentsLines = document.createElement("ol");
	agentsLines.className = "shiplet-review-agents-lines";
	agentsLines.setAttribute("aria-live", "polite");
	agentsLines.setAttribute("aria-label", "Conversation");
	const agentsComposer = document.createElement("div");
	agentsComposer.className = "shiplet-review-agents-composer";
	agentsComposer.hidden = true;
	const agentsToLabel = document.createElement("label");
	agentsToLabel.htmlFor = "shiplet-review-agents-to";
	agentsToLabel.textContent = "To";
	const agentsToSelect = document.createElement("select");
	agentsToSelect.id = "shiplet-review-agents-to";
	const agentsTextLabel = document.createElement("label");
	agentsTextLabel.htmlFor = "shiplet-review-agents-text";
	agentsTextLabel.textContent = "Message";
	const agentsText = document.createElement("textarea");
	agentsText.id = "shiplet-review-agents-text";
	agentsText.rows = 3;
	agentsText.maxLength = 8000;
	agentsText.setAttribute("aria-describedby", "shiplet-review-agents-hint");
	const agentsHint = document.createElement("p");
	agentsHint.id = "shiplet-review-agents-hint";
	agentsHint.className = "shiplet-review-agents-note";
	agentsHint.textContent = "Ctrl or Command and Enter sends.";
	const agentsErrorBox = document.createElement("p");
	agentsErrorBox.className = "shiplet-review-agents-error";
	agentsErrorBox.setAttribute("role", "alert");
	agentsErrorBox.setAttribute("data-shiplet-agents-error", "v1");
	agentsErrorBox.hidden = true;
	const agentsActions = document.createElement("div");
	agentsActions.className = "shiplet-review-agents-actions";
	const agentsSend = document.createElement("button");
	agentsSend.type = "button";
	agentsSend.className = "shiplet-review-primary";
	agentsSend.textContent = "Send";
	agentsSend.setAttribute("aria-busy", "false");
	agentsSend.setAttribute("data-shiplet-agents-send", "v1");
	const agentsLeave = document.createElement("button");
	agentsLeave.type = "button";
	agentsLeave.className = "shiplet-review-agents-link";
	agentsLeave.textContent = "Leave";
	agentsLeave.setAttribute("aria-label", "Leave the relay");
	agentsLeave.setAttribute("data-shiplet-agents-leave", "v1");
	agentsLeave.hidden = true;
	agentsActions.append(agentsSend, agentsLeave);
	agentsComposer.append(agentsToLabel, agentsToSelect, agentsTextLabel, agentsText, agentsHint);
	agentsBody.append(agentsNote, agentsContext, agentsLook, agentsEmpty, agentsLines, agentsComposer, agentsErrorBox, agentsActions);
	agentsPanel.append(agentsHeader, agentsBody);
	if (agentsEnabled) {
		launcherDock.append(agentsLauncher);
		contextualThreadHeader.insertBefore(agentsAskThread, contextualThreadClose);
		composerActions.insertBefore(agentsAskComposer, submit);
		document.body.appendChild(agentsPanel);
	}

	function agentsStorage() {
		try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; }
	}

	function agentsLoad() {
		try {
			const storage = agentsStorage();
			const raw = storage ? storage.getItem(agentsStorageKey) : null;
			const parsed = raw ? JSON.parse(raw) : null;
			if (!isRecord(parsed) || typeof parsed.session !== "string" || !parsed.session || !isRecord(parsed.self)) return null;
			return { session: parsed.session, self: parsed.self, lines: Array.isArray(parsed.lines) ? parsed.lines.filter(isRecord) : [] };
		} catch { return null; }
	}

	function agentsSave() {
		try { const storage = agentsStorage(); if (storage && agentsStored) storage.setItem(agentsStorageKey, JSON.stringify(agentsStored)); } catch {}
	}

	function agentsForget() {
		try { const storage = agentsStorage(); if (storage) storage.removeItem(agentsStorageKey); } catch {}
	}

	function agentsUrl(path) {
		const url = new URL(agentsOrigin + "/api/organizations/" + encodeURIComponent(agentsOrganizationId) + path);
		if (agentsInstallationId) url.searchParams.set("installation_id", agentsInstallationId);
		return url.toString();
	}

	async function agentsCall(method, path, body) {
		const response = await fetch(agentsUrl(path), {
			method,
			credentials: "same-origin",
			cache: "no-store",
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		let parsed = null;
		try { parsed = await response.json(); } catch {}
		const result = isRecord(parsed) ? parsed : {};
		if (!response.ok) {
			const error = new Error(typeof result.message === "string" && result.message ? result.message : "The relay answered " + response.status + ".");
			error.status = response.status;
			error.code = typeof result.error === "string" ? result.error : "error";
			throw error;
		}
		return result;
	}

	function agentsErrorText(error) {
		if (error && error.code === "embed_session_expired") return agentsExpiredText;
		if (error && typeof error.status === "number" && error.message) return error.message;
		return "Could not reach Shiplet. Check your connection and try again.";
	}

	// Errors after which this page stops talking to the relay. Returns true when handled.
	function agentsFatal(error) {
		if (!error || typeof error.status !== "number") return false;
		if (error.code === "embed_session_expired") {
			agentsExpired = true;
			agentsError = agentsExpiredText;
			return true;
		}
		if (error.code === "not_admitted" || error.code === "handshakes_not_enabled") {
			// Not admitted to this organization's relay: offer nothing.
			agentsStopped = true;
			agentsLauncher.hidden = true;
			agentsAskThread.hidden = true;
			agentsAskComposer.hidden = true;
			if (agentsOpen) setAgentsOpen(false);
			return true;
		}
		if (error.status === 401 || error.status === 403) {
			agentsStopped = true;
			agentsError = agentsErrorText(error);
			return true;
		}
		return false;
	}

	function agentsSender(peer) {
		return { id: String(peer.id || ""), name: String(peer.name || "You"), kind: "person", app: String(peer.app || agentsApp), machine: null, session: null, cwd: null, account: typeof peer.account === "string" ? peer.account : null };
	}

	function agentsOpenSession(lines) {
		if (!agentsOpening) {
			agentsOpening = agentsCall("POST", "/handshake-sessions", { kind: "person", app: agentsApp })
				.catch((error) => {
					// Joining is where admission is decided: a 404 here means this
					// person is not in the Shiplet's organization (a 404 later is a
					// peer or handshake that went away).
					if (error && error.status === 404 && error.code === "not_found") error.code = "not_admitted";
					throw error;
				})
				.then((opened) => {
					if (typeof opened.session !== "string" || !isRecord(opened.peer)) throw new Error("The relay did not open a session.");
					agentsStored = { session: opened.session, self: opened.peer, lines: agentsStored ? agentsStored.lines : (lines || []) };
					agentsSave();
					agentsStopped = false;
					// Agents can answer as soon as they can see this person.
					void agentsPoll();
					return agentsStored;
				})
				.finally(() => { agentsOpening = null; });
		}
		return agentsOpening;
	}

	async function agentsWithSession(run) {
		const stored = agentsStored || (await agentsOpenSession());
		try {
			return await run(stored.session);
		} catch (error) {
			// The relay restarted or the session idled out: open a new one once.
			if (error && error.code === "session_not_found") {
				agentsStored = null;
				const fresh = await agentsOpenSession(stored.lines);
				return run(fresh.session);
			}
			throw error;
		}
	}

	function agentsDelay(ms) {
		return new Promise((resolve) => window.setTimeout(resolve, ms));
	}

	async function agentsPoll() {
		if (agentsPolling || agentsStopped || agentsExpired) return;
		agentsPolling = true;
		try {
			while (agentsStored && !agentsStopped && !agentsExpired) {
				const session = agentsStored.session;
				let body;
				try {
					body = await agentsCall("GET", "/handshake-sessions/" + encodeURIComponent(session) + "/inbox?wait=20");
				} catch (error) {
					if (error && error.code === "session_not_found") {
						// Nobody is listening any more; the next send opens a new session.
						if (agentsStored && agentsStored.session === session) { agentsStored = null; agentsForget(); }
						agentsRender();
						return;
					}
					// The inbox names no peer, so a 404 here is the relay not admitting this person.
					if (error && error.code === "not_found") error.code = "not_admitted";
					if (agentsFatal(error)) { agentsRender(); return; }
					agentsError = agentsErrorText(error);
					agentsRender();
					await agentsDelay(5000);
					continue;
				}
				const messages = Array.isArray(body.messages) ? body.messages.filter(isRecord) : [];
				if (messages.length && agentsStored && agentsStored.session === session) {
					for (const message of messages) agentsAppend({ ...message, mine: false });
					agentsError = "";
					if (!agentsOpen) agentsUnread = true;
					agentsRender();
				}
			}
		} finally {
			agentsPolling = false;
		}
	}

	function agentsAppend(line) {
		if (!agentsStored) return;
		agentsStored.lines = agentsStored.lines.concat([line]).slice(-300);
		agentsSave();
	}

	function agentsAllLines() {
		return (agentsStored ? agentsStored.lines : []).concat(agentsPendingLines);
	}

	// The open annotation, when a thread is showing.
	function agentsOpenAnnotation() {
		if (!activeFeedbackId) return null;
		const showing = activeThreadPresentation === "contextual" ? !contextualThread.hidden : !panel.hidden;
		if (!showing) return null;
		const entry = threadViews.find((view) => view.id === activeFeedbackId);
		const label = entry && entry.item && boundedString(entry.item.ticket_label, 120) && entry.item.ticket_label ? entry.item.ticket_label : "";
		return { id: activeFeedbackId, label };
	}

	function agentsSelectedElement() {
		const element = artifactCapture && artifactCapture.selectedElement;
		if (!isRecord(element) || typeof element.selector !== "string" || !element.selector) return null;
		return {
			selector: element.selector.replace(/\s+/g, " ").trim(),
			text: typeof element.text === "string" ? element.text.replace(/\s+/g, " ").trim().slice(0, 120) : "",
		};
	}

	// What the agent needs to find exactly what the person is looking at.
	function agentsReviewContext() {
		const lines = [agentsContextMarker, "shiplet: " + shipletId, "version: " + revisionId, "page: " + reviewPageUrl];
		const element = agentsSelectedElement();
		if (element) lines.push("element: " + element.selector + (element.text ? " " + JSON.stringify(element.text) : ""));
		const annotation = agentsOpenAnnotation();
		if (annotation) lines.push("annotation: " + annotation.id);
		return { block: lines.join("\n"), request: annotation ? { shiplet: shipletId, feedback: annotation.id } : null };
	}

	function agentsContextSummary() {
		let path = reviewPageUrl;
		try { path = new URL(reviewPageUrl).pathname || "/"; } catch {}
		const parts = ["version " + revisionId, path];
		const element = agentsSelectedElement();
		if (element) parts.push("element " + element.selector);
		const annotation = agentsOpenAnnotation();
		if (annotation) parts.push("annotation " + (annotation.label || annotation.id));
		return "Each message tells the agent where you are: " + parts.join(" · ") + ".";
	}

	function agentsKindLabel(peer) {
		if (peer.kind === "other") return peer.app && peer.app !== "other" ? String(peer.app) : agentsKindLabels.other;
		return agentsKindLabels[peer.kind] || agentsKindLabels.other;
	}

	// Who the person can write to: the live peers once looked up (agents first),
	// or the people already in this tab's conversation until then.
	function agentsRecipients() {
		const selfId = agentsStored && isRecord(agentsStored.self) ? agentsStored.self.id : "";
		const found = new Map();
		if (agentsPeers) {
			for (const peer of agentsPeers) if (isRecord(peer) && typeof peer.id === "string" && peer.id && peer.id !== selfId) found.set(peer.id, peer);
		} else {
			for (const line of agentsAllLines()) {
				const other = line.mine ? line.to : line.from;
				if (isRecord(other) && typeof other.id === "string" && other.id && other.id !== selfId && !found.has(other.id)) found.set(other.id, other);
			}
		}
		return Array.from(found.values()).sort((a, b) => (a.kind === "person" ? 1 : 0) - (b.kind === "person" ? 1 : 0));
	}

	function agentsInvolves(line, peerId) {
		const other = line.mine ? line.to : line.from;
		return isRecord(other) && other.id === peerId;
	}

	// The conversation with the chosen peer: its latest handshake, plus what is
	// still on its way.
	function agentsVisibleLines(recipient) {
		const lines = agentsAllLines();
		if (!recipient) {
			const last = lines.length ? lines[lines.length - 1].room : "";
			return lines.filter((line) => line.room === last);
		}
		const mine = lines.filter((line) => agentsInvolves(line, recipient.id) && line.room);
		const room = mine.length ? mine[mine.length - 1].room : "";
		return lines.filter((line) => (room && line.room === room) || (!line.room && agentsInvolves(line, recipient.id)));
	}

	function agentsDisplayText(line) {
		const text = typeof line.text === "string" ? line.text : "";
		if (!line.mine) return text;
		const marker = text.indexOf("\n\n" + agentsContextMarker);
		return marker >= 0 ? text.slice(0, marker) : text;
	}

	function agentsRender() {
		if (!agentsEnabled) return;
		agentsLauncher.setAttribute("data-unread", agentsUnread ? "true" : "false");
		if (agentsUnread) agentsLauncher.setAttribute("aria-label", "Agents, new reply");
		else agentsLauncher.removeAttribute("aria-label");
		agentsContext.textContent = agentsContextSummary();
		const recipients = agentsRecipients();
		if (!recipients.some((peer) => peer.id === agentsTo)) agentsTo = recipients[0] ? recipients[0].id : "";
		const recipient = recipients.find((peer) => peer.id === agentsTo) || null;
		agentsLook.hidden = agentsPeers !== null;
		agentsLook.disabled = agentsLooking || agentsExpired;
		agentsLook.setAttribute("aria-busy", agentsLooking ? "true" : "false");
		agentsLookAgain.disabled = agentsLooking || agentsExpired;
		agentsEmpty.hidden = !(agentsPeers !== null && recipients.length === 0);
		agentsComposer.hidden = recipients.length === 0;
		agentsToSelect.replaceChildren(...recipients.map((peer) => {
			const option = document.createElement("option");
			option.value = peer.id;
			option.textContent = String(peer.name || peer.id) + " · " + agentsKindLabel(peer) + (peer.machine ? " on " + peer.machine : "");
			return option;
		}));
		agentsToSelect.value = agentsTo;
		const selfName = agentsStored && isRecord(agentsStored.self) ? agentsStored.self.name : "";
		agentsLines.replaceChildren(...agentsVisibleLines(recipient).map((line) => {
			const item = document.createElement("li");
			item.className = "shiplet-review-agents-line";
			item.setAttribute("data-mine", line.mine ? "true" : "false");
			if (line.state) item.setAttribute("data-line-state", line.state);
			const head = document.createElement("div");
			head.className = "shiplet-review-agents-line-head";
			const who = document.createElement("strong");
			who.textContent = line.mine ? "You" : String(isRecord(line.from) && line.from.name ? line.from.name : "Agent");
			const meta = document.createElement("span");
			meta.textContent = line.mine ? "to " + String(isRecord(line.to) && line.to.name ? line.to.name : "") : (isRecord(line.from) ? agentsKindLabel(line.from) : "");
			head.append(who, meta);
			const text = document.createElement("p");
			text.textContent = agentsDisplayText(line);
			item.append(head, text);
			if (line.state === "failed") {
				const failed = document.createElement("p");
				failed.className = "shiplet-review-agents-failed";
				failed.textContent = "Not sent: " + String(line.error || "");
				item.append(failed);
			}
			return item;
		}));
		agentsLines.hidden = agentsLines.childElementCount === 0;
		agentsSend.disabled = agentsSending || agentsExpired || !recipient;
		agentsSend.setAttribute("aria-busy", agentsSending ? "true" : "false");
		agentsText.disabled = agentsExpired;
		agentsLeave.hidden = !agentsStored;
		agentsErrorBox.textContent = agentsError;
		agentsErrorBox.hidden = !agentsError;
		if (selfName) agentsTitle.setAttribute("title", "You are " + selfName);
	}

	function agentsFocusTarget() {
		if (agentsTrigger === agentsAskThread && contextualThread.hidden) return agentsLauncher;
		if (agentsTrigger === agentsAskComposer && form.hidden) return agentsLauncher;
		return agentsTrigger || agentsLauncher;
	}

	function setAgentsOpen(open, trigger) {
		if (!agentsEnabled) return;
		if (open && !panel.hidden) setPanelOpen(false);
		agentsOpen = Boolean(open);
		agentsPanel.hidden = !agentsOpen;
		agentsLauncher.setAttribute("aria-expanded", agentsOpen ? "true" : "false");
		agentsAskThread.setAttribute("aria-expanded", agentsOpen ? "true" : "false");
		agentsAskComposer.setAttribute("aria-expanded", agentsOpen ? "true" : "false");
		setReviewSurfaceOpenState();
		if (agentsOpen) {
			agentsTrigger = trigger || agentsLauncher;
			agentsUnread = false;
			agentsRender();
			(agentsLook.hidden ? (agentsComposer.hidden ? agentsClose : agentsText) : agentsLook).focus();
		} else {
			const target = agentsLauncher.hidden ? commentsLauncher : agentsFocusTarget();
			agentsTrigger = null;
			target.focus();
		}
		notifyEmbedView();
	}

	async function agentsLookUp() {
		if (agentsLooking || agentsExpired) return;
		agentsLooking = true;
		agentsError = "";
		agentsRender();
		try {
			const body = await agentsWithSession((session) => agentsCall("GET", "/handshake-sessions/" + encodeURIComponent(session) + "/peers"));
			const peers = Array.isArray(body.peers) ? body.peers : [];
			agentsPeers = peers.filter((peer) => isRecord(peer) && typeof peer.id === "string" && peer.id !== body.self);
		} catch (error) {
			if (!agentsFatal(error)) agentsError = agentsErrorText(error);
		} finally {
			agentsLooking = false;
			agentsRender();
		}
		if (agentsOpen && agentsPeers) (agentsComposer.hidden ? agentsLookAgain : agentsText).focus();
	}

	async function agentsSendMessage() {
		const words = String(agentsText.value || "").trim();
		const recipient = agentsRecipients().find((peer) => peer.id === agentsTo);
		if (!words || !recipient || agentsSending || agentsExpired) return;
		const context = agentsReviewContext();
		const text = words + "\n\n" + context.block;
		const local = {
			id: "local_" + Math.random().toString(36).slice(2),
			room: "",
			from: agentsStored ? agentsSender(agentsStored.self) : agentsSender({ name: "You", app: agentsApp }),
			to: { id: recipient.id, name: String(recipient.name || recipient.id), kind: recipient.kind },
			text,
			at: new Date().toISOString(),
			mine: true,
			state: "pending",
		};
		agentsSending = true;
		agentsPendingLines = agentsPendingLines.concat([local]);
		agentsText.value = "";
		agentsError = "";
		agentsRender();
		try {
			const body = context.request ? { to: recipient.id, text, request: context.request } : { to: recipient.id, text };
			const sent = await agentsWithSession((session) => agentsCall("POST", "/handshake-sessions/" + encodeURIComponent(session) + "/messages", body));
			agentsPendingLines = agentsPendingLines.filter((line) => line.id !== local.id);
			agentsAppend({
				id: String(sent.id || local.id),
				room: String(sent.handshake || ""),
				from: agentsStored ? agentsSender(agentsStored.self) : local.from,
				to: isRecord(sent.to) ? sent.to : local.to,
				text,
				at: typeof sent.at === "string" ? sent.at : local.at,
				mine: true,
			});
		} catch (error) {
			const message = agentsErrorText(error);
			agentsPendingLines = agentsPendingLines.map((line) => (line.id === local.id ? { ...line, state: "failed", error: message } : line));
			if (!agentsFatal(error)) agentsError = message;
			if (!String(agentsText.value || "").trim()) agentsText.value = words;
		} finally {
			agentsSending = false;
			agentsRender();
		}
	}

	// Leaves the relay: agents stop seeing this person, and the tab forgets the conversation.
	async function agentsLeaveRelay() {
		const stored = agentsStored;
		agentsStopped = true;
		agentsStored = null;
		agentsForget();
		agentsPeers = null;
		agentsPendingLines = [];
		agentsError = "";
		agentsRender();
		agentsLook.focus();
		if (stored) { try { await agentsCall("DELETE", "/handshake-sessions/" + encodeURIComponent(stored.session)); } catch {} }
		agentsStopped = false;
	}

	function agentsStart() {
		if (!agentsEnabled) return;
		agentsStored = agentsLoad();
		agentsRender();
		if (agentsStored) void agentsPoll();
	}

	agentsLauncher.addEventListener("click", (event) => { if (event && event.isTrusted === true) setAgentsOpen(!agentsOpen, agentsLauncher); });
	agentsAskThread.addEventListener("click", (event) => { if (event && event.isTrusted === true) setAgentsOpen(true, agentsAskThread); });
	agentsAskComposer.addEventListener("click", (event) => { if (event && event.isTrusted === true) setAgentsOpen(true, agentsAskComposer); });
	agentsClose.addEventListener("click", (event) => { if (event && event.isTrusted === true) setAgentsOpen(false); });
	agentsLook.addEventListener("click", async (event) => { if (event && event.isTrusted === true) await agentsLookUp(); });
	agentsLookAgain.addEventListener("click", async (event) => { if (event && event.isTrusted === true) await agentsLookUp(); });
	agentsSend.addEventListener("click", async (event) => { if (event && event.isTrusted === true) await agentsSendMessage(); });
	agentsLeave.addEventListener("click", async (event) => { if (event && event.isTrusted === true) await agentsLeaveRelay(); });
	agentsToSelect.addEventListener("change", (event) => {
		if (!event || event.isTrusted !== true) return;
		agentsTo = String(agentsToSelect.value || "");
		agentsRender();
	});
	agentsText.addEventListener("keydown", async (event) => {
		if (!event || event.isTrusted !== true || event.isComposing) return;
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			await agentsSendMessage();
		}
	});
	agentsPanel.addEventListener("keydown", (event) => {
		if (!event || event.isTrusted !== true || event.isComposing || event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		setAgentsOpen(false);
	});
	window.addEventListener("beforeunload", () => { agentsStopped = true; });
`;
}

export function reviewHostAgentsStartScript(): string {
  return String.raw`
	agentsStart();`;
}

export function reviewHostAgentsStyles(): string {
  // Compact on purpose: the host stylesheet has a byte budget
  // (test/trusted-review-host.spec.ts). Buttons reuse the host's
  // .shiplet-review-secondary and .shiplet-review-primary.
  return String.raw`
.shiplet-review-agents-launcher{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:var(--shiplet-ink);font:650 13px/1 ui-sans-serif,system-ui,sans-serif;white-space:nowrap;cursor:pointer}
.shiplet-review-agents-launcher:hover{background:var(--shiplet-tint)}
.shiplet-review-agents-launcher[data-unread="true"]::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--shiplet-action)}
.shiplet-review-agents-launcher[hidden],.shiplet-review-agents-ask[hidden],.shiplet-review-agents[hidden],.shiplet-review-agents [hidden]{display:none!important}
.shiplet-review-agents{position:fixed;right:12px;bottom:12px;z-index:2147483545;display:grid;grid-template-rows:auto minmax(0,1fr);width:min(400px,calc(100vw - 24px));max-height:min(600px,calc(100dvh - 24px));overflow:hidden;border:1px solid var(--shiplet-line);border-radius:12px;background:var(--shiplet-raised);box-shadow:var(--shiplet-shadow)}
.shiplet-review-agents-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;border-bottom:1px solid var(--shiplet-line);background:var(--shiplet-surface)}
.shiplet-review-agents h2{margin:0;font-size:15px}
.shiplet-review-agents-body{display:grid;align-content:start;gap:12px;min-height:0;overflow:auto;padding:14px 16px}
.shiplet-review-agents-body p{margin:0;overflow-wrap:anywhere}
.shiplet-review-agents-note,.shiplet-review-agents-context{color:var(--shiplet-muted);font-size:12px}
.shiplet-review-agents-look{justify-self:start}
.shiplet-review-agents-link{min-height:32px;border:0;background:none;color:var(--shiplet-accent);font:inherit;font-weight:650;text-decoration:underline;cursor:pointer}
.shiplet-review-agents-lines{display:grid;gap:8px;margin:0;padding:0;list-style:none}
.shiplet-review-agents-line{padding:8px 10px;border:1px solid var(--shiplet-line);border-radius:9px;background:var(--shiplet-surface);font-size:12px}
.shiplet-review-agents-line[data-mine="true"]{background:var(--shiplet-tint)}
.shiplet-review-agents-line[data-line-state="pending"]{opacity:.6}
.shiplet-review-agents-line span{margin-left:6px;color:var(--shiplet-muted)}
.shiplet-review-agents-line p{margin-top:4px;font-size:13px;white-space:pre-wrap}
.shiplet-review-agents-composer{display:grid;gap:6px;font-size:12px;font-weight:650}
.shiplet-review-agents-composer select,.shiplet-review-agents-composer textarea{width:100%;min-height:40px;padding:8px 10px;border:1px solid var(--shiplet-line);border-radius:8px;background:var(--shiplet-raised);color:inherit;font:400 14px/1.45 ui-sans-serif,system-ui,sans-serif}
.shiplet-review-agents-composer textarea{min-height:84px;resize:vertical}
.shiplet-review-agents-error,.shiplet-review-agents-failed{color:var(--shiplet-danger,#7c2a17)}
.shiplet-review-agents-error{padding:8px 10px;border:1px solid var(--shiplet-danger-line,#e2b4a8);border-radius:8px;background:var(--shiplet-danger-bg,#fdf1ed);font-size:12px}
.shiplet-review-agents-actions{display:flex;align-items:center;justify-content:space-between;gap:8px}
.shiplet-review-agents button:disabled{opacity:.55;cursor:not-allowed}
.shiplet-review-agents-launcher:focus-visible,.shiplet-review-agents :focus-visible{outline:3px solid var(--shiplet-accent);outline-offset:2px}
html[data-shiplet-embed-origin]:not([data-shiplet-embed-origin=""]) .shiplet-review-agents{inset:8px;width:auto;max-height:none}
`;
}
