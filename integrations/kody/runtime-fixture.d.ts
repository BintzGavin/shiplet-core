/** Type boundary for local package tests. Kody supplies the actual per-user runtime. */
declare module 'kody:runtime' {
  export const kody: { mcp: Record<string, { execute(input: { code: string }): Promise<unknown> }> };
}
