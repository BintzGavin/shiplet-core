import { describe, expect, it } from "vitest";

import { executeTemporaryProviderEffect } from "../src/cloudflare-support/temporary-effect-fence";

describe("temporary provider effect fence", () => {
  it("prevents provider effects when validation or immutable intent audit fails", async () => {
    const observed: string[] = [];
    const run = (validationError?: Error, auditError?: Error) =>
      executeTemporaryProviderEffect({
        validate: () => {
          observed.push("validate");
          if (validationError) throw validationError;
        },
        consume: () => {
          observed.push("consume");
        },
        audit: () => {
          observed.push("audit");
          if (auditError) throw auditError;
        },
        effect: () => {
          observed.push("effect");
          return "complete";
        },
      });

    await expect(run(new Error("invalid"))).rejects.toThrow("invalid");
    expect(observed).toEqual(["validate"]);

    observed.length = 0;
    await expect(run(undefined, new Error("audit unavailable"))).rejects.toThrow(
      "audit unavailable",
    );
    expect(observed).toEqual(["validate", "consume", "audit"]);

    observed.length = 0;
    await expect(run()).resolves.toBe("complete");
    expect(observed).toEqual(["validate", "consume", "audit", "effect"]);
  });
});
