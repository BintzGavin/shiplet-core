import type { Env } from "./env";
import {
	updateShipletAccessRequestEmailStatus,
	type ShipletAccessRequestRecord,
	type ShipletUser,
} from "./store";
import type { Project } from "./types";

export async function deliverShipletAccessRequestEmail(
	env: Env,
	options: {
		request: ShipletAccessRequestRecord;
		project: Project;
		owner: Pick<ShipletUser, "email">;
		manageUrl: string;
	},
) {
	const sender = env.SHIPLET_EMAIL_FROM;
	if (!emailIsConfigured(env) || !sender) {
		return updateShipletAccessRequestEmailStatus(
			env.DB,
			options.request.id,
			options.request.updated_on,
			"not_configured",
			"delivery_not_configured",
		);
	}

	const requesterEmail = options.request.requester_email;
	const subject = `${requesterEmail} requested access to ${options.project.name}`;
	const text = [
		`${requesterEmail} requested access to "${options.project.name}".`,
		"",
		`Open the Shiplet to manage access: ${options.manageUrl}`,
		"",
		"No access has been granted automatically.",
	].join("\n");
	const html = [
		`<p><strong>${escapeHtml(requesterEmail)}</strong> requested access to <strong>${escapeHtml(options.project.name)}</strong>.</p>`,
		`<p><a href="${escapeHtml(options.manageUrl)}">Open the Shiplet to manage access</a></p>`,
		"<p>No access has been granted automatically.</p>",
	].join("");

	try {
		await env.EMAIL!.send({
			to: options.owner.email,
			from: {
				email: sender,
				name: env.SHIPLET_EMAIL_FROM_NAME || "Shiplet",
			},
			subject,
			text,
			html,
		});
		return updateShipletAccessRequestEmailStatus(
			env.DB,
			options.request.id,
			options.request.updated_on,
			"sent",
		);
	} catch {
		return updateShipletAccessRequestEmailStatus(
			env.DB,
			options.request.id,
			options.request.updated_on,
			"failed",
			"delivery_failed",
		);
	}
}

function emailIsConfigured(env: Env) {
	const setting = env.SHIPLET_EMAIL_NOTIFICATIONS?.trim().toLowerCase();
	if (setting === "false" || setting === "off") return false;
	return Boolean(env.EMAIL && env.SHIPLET_EMAIL_FROM);
}

function escapeHtml(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
