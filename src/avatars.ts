export const AVATAR_SPRITE_URL = "/brand/avatars/shiplet-avatar-presets-v9.png";
export const AVATAR_SPRITE_COLUMNS = 4;
export const AVATAR_SPRITE_ROWS = 3;

export const AVATAR_PRESETS = [
	{ id: "aurora-grid", label: "A Alfa", column: 0, row: 0 },
	{ id: "coral-orbit", label: "B Bravo", column: 1, row: 0 },
	{ id: "tidal-prism", label: "C Charlie", column: 2, row: 0 },
	{ id: "ember-radar", label: "D Delta", column: 3, row: 0 },
	{ id: "jade-circuit", label: "E Echo", column: 0, row: 1 },
	{ id: "violet-signal", label: "F Foxtrot", column: 1, row: 1 },
	{ id: "golden-spiral", label: "G Golf", column: 2, row: 1 },
	{ id: "blueprint-wave", label: "H Hotel", column: 3, row: 1 },
	{ id: "rose-axis", label: "I India", column: 0, row: 2 },
	{ id: "kelp-mosaic", label: "J Juliet", column: 1, row: 2 },
	{ id: "cobalt-eclipse", label: "K Kilo", column: 2, row: 2 },
	{ id: "sunset-stack", label: "L Lima", column: 3, row: 2 },
] as const;

export type AvatarPresetId = (typeof AVATAR_PRESETS)[number]["id"];

const AVATAR_PRESET_IDS = new Set<string>(
	AVATAR_PRESETS.map((preset) => preset.id),
);
export const MAX_AVATAR_UPLOAD_BYTES = 10 * 1024 * 1024;

export function isAvatarPresetId(value: unknown): value is AvatarPresetId {
	return typeof value === "string" && AVATAR_PRESET_IDS.has(value);
}

export function normalizeAvatarPreset(value: unknown): AvatarPresetId {
	return isAvatarPresetId(value) ? value : "aurora-grid";
}

export function avatarPresetForUser(userId: string, email?: string | null) {
	const input = `${userId}:${email || ""}`;
	let hash = 0;
	for (let i = 0; i < input.length; i += 1) {
		hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
	}
	return AVATAR_PRESETS[hash % AVATAR_PRESETS.length].id;
}

export function validateAvatarUpdate(payload: unknown): {
	ok: true;
	value: { avatarPreset: AvatarPresetId; avatarDataUrl: string | null };
} | { ok: false; errors: string[] } {
	const input = isRecord(payload) ? payload : {};
	const avatarPreset = normalizeAvatarPreset(input.avatarPreset);
	const errors: string[] = [];
	let avatarDataUrl: string | null = null;

	if (input.avatarDataUrl !== undefined && input.avatarDataUrl !== null) {
		if (typeof input.avatarDataUrl !== "string") {
			errors.push("Avatar upload must be a data URL.");
		} else {
			avatarDataUrl = normalizeAvatarDataUrl(input.avatarDataUrl, errors);
		}
	}

	if (errors.length > 0) {
		return { ok: false, errors: Array.from(new Set(errors)) };
	}

	return {
		ok: true,
		value: { avatarPreset, avatarDataUrl },
	};
}

export function avatarPresetPosition(presetId: unknown) {
	const preset =
		AVATAR_PRESETS.find((candidate) => candidate.id === presetId) ||
		AVATAR_PRESETS[0];
	return {
		column: preset.column,
		row: preset.row,
		x:
			AVATAR_SPRITE_COLUMNS <= 1
				? 0
				: (preset.column / (AVATAR_SPRITE_COLUMNS - 1)) * 100,
		y:
			AVATAR_SPRITE_ROWS <= 1
				? 0
				: (preset.row / (AVATAR_SPRITE_ROWS - 1)) * 100,
	};
}

function normalizeAvatarDataUrl(value: string, errors: string[]) {
	const trimmed = value.trim();
	const match = trimmed.match(
		/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/,
	);
	if (!match) {
		errors.push("Avatar upload must be a PNG, JPEG, or WebP data URL.");
		return null;
	}

	let byteLength = 0;
	try {
		byteLength = atob(match[2]).length;
	} catch {
		errors.push("Avatar upload has invalid base64 content.");
		return null;
	}

	if (byteLength > MAX_AVATAR_UPLOAD_BYTES) {
		errors.push("Avatar upload must be 10MB or smaller.");
		return null;
	}

	return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
