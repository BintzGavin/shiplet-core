import type { Env } from "./env";

export const ACCOUNT_EMAIL_SWITCHING_FLAG = "account-email-switching";

export type ShipletFeatureFlagKey = typeof ACCOUNT_EMAIL_SWITCHING_FLAG;

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
