import { client } from "./runtime";
import type { Connection } from "./client";

/**
 * Read one complete page of actionable tickets with source-version provenance.
 * @param input - Operation arguments; pass the receipt from the previous step.
 * @param connection - This user's remote MCP server name and matching Shiplet origin.
 * @returns The acknowledged provider result; throws on failure without retrying mutations.
 * @example
 * import run from 'kody:@your-account/shiplet/feedback'
 * const result = await run(input)
 */
export default async function run(
  input: Parameters<ReturnType<typeof client>["feedback"]>[0],
  connection?: Connection,
) {
  return client(connection).feedback(input);
}
