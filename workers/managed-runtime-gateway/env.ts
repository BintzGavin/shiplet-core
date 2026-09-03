export interface ManagedRuntimeEnv {
	RUNTIME_DB: D1Database;
	STAGING_DISPATCH: DispatchNamespace;
	PRODUCTION_DISPATCH: DispatchNamespace;
	CUSTOM_MCP_LOADER: WorkerLoader;
	MANAGED_DEPLOYMENT_BROKER: Service;
	DENY_EGRESS_CONTRACT: Service;
	DENY_EGRESS: Service;
	policy?: string;
	shiplet?: string;
	revision?: string;
	generation?: string;
	packageDigest?: string;
	invocationId?: string;
	invocationKind?: string;
	stateMode?: string;
	stateNamespace?: string;
	CF_VERSION_METADATA: { id: string; tag?: string };
}
