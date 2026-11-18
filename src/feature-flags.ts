import type { Env } from "./env";

export const ACCOUNT_EMAIL_SWITCHING_FLAG = "account-email-switching";
// Traces: full agent session logs (prompts, replies, tool calls) on Shiplets.
export const TRACES_FLAG = "traces";

export type ShipletFeatureFlagKey =
	| typeof ACCOUNT_EMAIL_SWITCHING_FLAG
	| typeof TRACES_FLAG;

export function useFeatureFlag(env: Env, flagKey: ShipletFeatureFlagKey) {
	const enabledFlags = String(env.SHIPLET_ENABLED_FEATURE_FLAGS || "")
		.split(/[\s,]+/)
		.map((flag) => flag.trim())
		.filter(Boolean);

	return enabledFlags.includes(flagKey);
}

export function dashboardFeatureFlags(env: Env) {
	return {
		accountEmailSwitching: useFeatureFlag(env, ACCOUNT_EMAIL_SWITCHING_FLAG),
	};
}
