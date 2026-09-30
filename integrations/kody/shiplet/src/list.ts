import { client } from "./runtime";
import type { Connection } from "./client";

/**
 * List projects visible to this connection without guessing project identities.
 * @param input - Operation arguments; pass the receipt from the previous step.
 * @param connection - This user's remote MCP server name and matching Shiplet origin.
 * @returns The acknowledged provider result; throws on failure without retrying mutations.
 * @example
 * import run from 'kody:@your-account/shiplet/list'
 * const result = await run({})
 */
export default async function run(input: Record<string, never> = {}, connection?: Connection) {
  return client(connection).list();
}
