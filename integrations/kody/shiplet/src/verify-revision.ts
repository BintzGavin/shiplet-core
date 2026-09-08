import { client } from "./runtime";
import type { Connection } from "./client";

/**
 * Compare ticket checks against immutable source and candidate artifacts; keep review status unchanged.
 * @param input - Operation arguments; pass the receipt from the previous step.
 * @param connection - This user's remote MCP server name and matching Shiplet origin.
 * @returns The acknowledged provider result; throws on failure without retrying mutations.
 * @example
 * import run from 'kody:@your-account/shiplet/verify-revision'
 * const result = await run(input)
 */
export default async function run(
  input: Parameters<ReturnType<typeof client>["verifyRevision"]>[0],
  connection?: Connection,
) {
  return client(connection).verifyRevision(input);
}
