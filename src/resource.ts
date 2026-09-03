/**
 * Static artifact input shared by validation, previews, and managed storage.
 *
 * Deployment authority intentionally does not live in this module. Managed
 * static artifacts are stored through Shiplet-scoped D1/R2 bindings. Advanced
 * Worker deployments must cross the revision-aware support-service boundary;
 * the kernel never accepts a dispatch namespace credential.
 */
export interface AssetFile {
	path: string;
	content: string;
	size: number;
}
