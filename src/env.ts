// Copyright (c) 2022 Cloudflare, Inc.
// Licensed under the APACHE LICENSE, VERSION 2.0 license found in the LICENSE file or at http://www.apache.org/licenses/LICENSE-2.0

import type { WorkerArgs } from "./types";

type ApplicationEnvOverrideKey =
	| "CLOUDFLARE_OAUTH_READINESS"
	| "CLOUDFLARE_OAUTH_SMOKE_USER_ID"
	| "CLOUDFLARE_CONTROL_PLANE_VERSION_ID"
	| "CLOUDFLARE_RUNTIME_GATEWAY_VERSION_ID"
	| "CLOUDFLARE_DENY_EGRESS_VERSION_ID"
	| "CLOUDFLARE_SUPPORT_RELEASE_TAG"
	| "CLOUDFLARE_MANAGED_RUNTIME_READINESS"
	| "CLOUDFLARE_MANAGED_RUNTIME_SMOKE_USER_ID"
	| "CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS"
	| "CLOUDFLARE_TEMPORARY_ACCOUNTS_SMOKE_USER_ID";

type GeneratedEnv = Omit<
	Cloudflare.Env,
	"SHIPLET_AUTH_MODE" | ApplicationEnvOverrideKey
> & {
	// Production is generated from wrangler.jsonc; tests opt in explicitly.
	SHIPLET_AUTH_MODE: Cloudflare.Env["SHIPLET_AUTH_MODE"] | "test";
};

/*
 * The generated Cloudflare contract owns every configured binding. This
 * extension contains only secrets, test-only values, and bindings which are
 * intentionally absent from the deployable default configuration.
 */
export type Env = GeneratedEnv & {
	dispatcher?: Dispatcher;
	EMAIL?: {
		send(message: {
			to: string;
			from: { email: string; name?: string };
			subject: string;
			html?: string;
			text?: string;
		}): Promise<unknown>;
	};
	WORKOS_CLIENT_ID?: string;
	WORKOS_API_KEY?: string;
	SHIPLET_BOOTSTRAP_TOKEN?: string;
	SHIPLET_REVIEW_TOKEN_SECRET?: string;
	SHIPLET_EMAIL_FROM?: string;
	SHIPLET_EMAIL_FROM_NAME?: string;
	SHIPLET_EMAIL_NOTIFICATIONS?: string;
	POSTHOG_KEY?: string;
	POSTHOG_HOST?: string;
	WORKERS_DEV_SUBDOMAIN?: string;
	CLOUDFLARE_ZONE_ID?: string; // For custom hostname operations
	FALLBACK_ORIGIN?: string;
	// Optional: API token with SSL permissions for custom hostname support
	CLOUDFLARE_API_TOKEN?: string;
};

interface Dispatcher {
	get: (
		scriptName: string,
		args?: WorkerArgs,
		getOptions?: {
			limits?: { cpuMs?: number; memory?: number };
			outbound?: string;
		},
	) => Worker;
}

interface Worker {
	fetch: (request: Request) => Promise<Response>;
}
