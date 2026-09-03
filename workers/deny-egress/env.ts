export interface DenyEgressEnv {
	policy?: string;
	shiplet?: string;
	revision?: string;
	generation?: string;
	CF_VERSION_METADATA: { id: string; tag?: string };
}
