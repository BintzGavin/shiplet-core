declare module "cloudflare:test" {
	export const env: unknown;
	export function createExecutionContext(): ExecutionContext;
	export function waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
	export function runInDurableObject<T>(
		stub: DurableObjectStub,
		callback: (instance: unknown, state: DurableObjectState) => Promise<T>,
	): Promise<T>;
}
