import { client } from "./runtime";
import type { Connection } from "./client";

/**
 * Publish explicit static files and get a versioned review receipt.
 * @param input - Operation arguments; pass the receipt from the previous step.
 * @param connection - This user's remote MCP server name and matching Shiplet origin.
 * @returns The acknowledged provider result; throws on failure without retrying mutations.
 * @example
 * import run from 'kody:@your-account/shiplet/publish'
 * const result = await run(input)
 */
export default async function run(
  input: Parameters<ReturnType<typeof client>["publish"]>[0],
  connection?: Connection,
) {
  return client(connection).publish(input);
}
