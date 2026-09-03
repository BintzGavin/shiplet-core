import { randomBytes, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

import { expect, type APIRequestContext, type Page } from "@playwright/test";

const e2eBaseURL = "http://localhost:8787";
const controlPlaneOrigin = new URL(e2eBaseURL).origin;

export type E2EUser = {
	email: string;
	id: string;
};

export type E2EOrganization = {
	id: string;
	name: string;
};

export type E2EProject = {
	id: string;
	name: string;
	subdomain: string;
	previewUrl: string;
	reviewUrl: string;
};

export function testUser(label: string): E2EUser {
	const email = `${slug(label)}-${Date.now()}-${Math.random()
		.toString(16)
		.slice(2, 8)}@example.com`;
	return {
		email,
		id: userIdForEmail(email),
	};
}

export function userIdForEmail(email: string) {
	return `user_${slug(email)}`;
}

export function authHeaders(user: E2EUser) {
	return {
		"x-shiplet-user-id": user.id,
		"x-shiplet-user-email": user.email,
	};
}

export async function loginAs(
	page: Page,
	user: E2EUser,
	options: { organizationId?: string; returnTo?: string } = {},
) {
	await page.goto(authCallbackPath(user, options), { waitUntil: "networkidle" });
	if (options.returnTo) {
		await expect(page).toHaveURL(
			new RegExp(`${escapeRegex(options.returnTo)}(?:$|[?#])`),
		);
	}
}

export async function establishMembership(
	request: APIRequestContext,
	organizationId: string,
	user: E2EUser,
) {
	const response = await request.get(authCallbackPath(user, { organizationId }), {
		maxRedirects: 0,
	});
	expect(response.status()).toBe(302);
}

export async function createOrganization(
	request: APIRequestContext,
	owner: E2EUser,
	name = `E2E Workspace ${randomSlug()}`,
) {
	const response = await request.post("/api/organizations", {
		headers: { ...authHeaders(owner), Origin: controlPlaneOrigin },
		data: { name },
	});
	await expectOk(response, "create organization");
	const body = (await response.json()) as { organization: E2EOrganization };
	return body.organization;
}

export async function publishStaticShiplet(
	request: APIRequestContext,
	owner: E2EUser,
	organizationId: string,
	options: { html?: string; name?: string; subdomain?: string; visibility?: string } = {},
) {
	const name = options.name || `E2E Shiplet ${randomSlug()}`;
	const subdomain = options.subdomain || randomSlug("e2e-shiplet");
	const html =
		options.html ||
		`<!doctype html><title>${escapeHtml(name)}</title><h1>${escapeHtml(name)}</h1>`;
	const response = await request.post("/projects", {
		headers: {
			...authHeaders(owner),
			"Content-Type": "application/json",
			Origin: controlPlaneOrigin,
		},
		data: {
			name,
			organization_id: organizationId,
			subdomain,
			visibility: options.visibility || "organization",
			assets: [
				{
					path: "index.html",
					content: Buffer.from(html).toString("base64"),
					size: Buffer.byteLength(html),
				},
			],
		},
	});
	await expectOk(response, "publish static shiplet");
	const body = (await response.json()) as {
		project: E2EProject;
		previewUrl: string;
		reviewUrl: string;
	};
	return {
		...body,
		project: {
			...body.project,
			previewUrl: body.previewUrl,
			reviewUrl: body.reviewUrl,
		},
	};
}

export async function createReviewFeedback(
	request: APIRequestContext,
	actor: E2EUser,
	project: E2EProject,
	options: {
		comment?: string;
		mentions?: Array<{ userId?: string; email?: string; name?: string }>;
	} = {},
) {
	const response = await request.post(
		`/api/projects/${encodeURIComponent(project.id)}/review-feedback`,
		{
			headers: {
				...authHeaders(actor),
				"Content-Type": "application/json",
				Origin: controlPlaneOrigin,
			},
			data: {
				clientFeedbackId: `e2e-feedback-${randomSlug()}`,
				comment: options.comment || `E2E feedback ${randomSlug()}`,
				name: actor.email,
				pageUrl: new URL(`/${project.subdomain}`, e2eBaseURL).toString(),
				screenshotMode: "page",
				mentions: options.mentions || [],
				viewport: { width: 1280, height: 720 },
			},
		},
	);
	await expectOk(response, "create review feedback");
	return (await response.json()) as {
		feedback: { id: string; ticket_label: string };
	};
}

export function collectPageErrors(page: Page) {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	return errors;
}

export async function expectNoPageErrors(errors: string[]) {
	expect(errors.filter((message) => !message.includes("favicon"))).toEqual([]);
}

export function tinyPngBuffer() {
	return Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
		"base64",
	);
}

export function largePngBuffer(options: { minBytes?: number; maxBytes?: number } = {}) {
	const minBytes = options.minBytes || 4 * 1024 * 1024;
	const maxBytes = options.maxBytes || 10 * 1024 * 1024;

	for (let width = 1536; width >= 1024; width -= 128) {
		const buffer = randomPngBuffer(width, width);
		if (buffer.byteLength >= minBytes && buffer.byteLength <= maxBytes) {
			return buffer;
		}
	}
	throw new Error("Unable to generate a large PNG within the requested size.");
}

function authCallbackPath(
	user: E2EUser,
	options: { organizationId?: string; returnTo?: string } = {},
) {
	const code = `test-code:${options.organizationId || ""}:${encodeURIComponent(user.email)}`;
	const params = new URLSearchParams({ code });
	if (options.returnTo) {
		params.set(
			"state",
			Buffer.from(JSON.stringify({ returnTo: options.returnTo })).toString(
				"base64",
			),
		);
	}
	return `/auth/callback?${params.toString()}`;
}

function randomSlug(prefix = "e2e") {
	return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function slug(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function escapeRegex(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function randomPngBuffer(width: number, height: number) {
	const channels = 3;
	const rowLength = 1 + width * channels;
	const raw = Buffer.allocUnsafe(rowLength * height);
	for (let row = 0; row < height; row += 1) {
		const rowOffset = row * rowLength;
		raw[rowOffset] = 0;
		randomBytes(width * channels).copy(raw, rowOffset + 1);
	}

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", pngIhdr(width, height)),
		pngChunk("IDAT", deflateSync(raw, { level: 0 })),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function pngIhdr(width: number, height: number) {
	const data = Buffer.alloc(13);
	data.writeUInt32BE(width, 0);
	data.writeUInt32BE(height, 4);
	data[8] = 8;
	data[9] = 2;
	data[10] = 0;
	data[11] = 0;
	data[12] = 0;
	return data;
}

function pngChunk(type: string, data: Buffer) {
	const typeBuffer = Buffer.from(type, "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.byteLength, 0);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
	return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(data: Buffer) {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

async function expectOk(
	response: { ok(): boolean; status(): number; text(): Promise<string> },
	label: string,
) {
	if (response.ok()) return;
	throw new Error(`${label} failed ${response.status()}: ${await response.text()}`);
}
