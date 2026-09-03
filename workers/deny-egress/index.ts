import { WorkerEntrypoint } from "cloudflare:workers";
import type { DenyEgressEnv } from "./env";

import { handleManagedOutboundRequest } from "../../src/cloudflare-support/managed-runtime";
import { createInternalSupportEntrypointContract } from "../../src/cloudflare-support/service-contract";

/** Value-free release identity used by the managed gateway before dispatch. */
export class DenyEgressContractRpc extends WorkerEntrypoint<DenyEgressEnv> {
  contract() {
    return createInternalSupportEntrypointContract({
      service: "shiplet-deny-egress",
      entrypoint: "DenyEgressContractRpc",
      metadata: this.env.CF_VERSION_METADATA,
    });
  }
}

/**
 * Default outbound mediator for untrusted managed Shiplet Workers.
 *
 * The deployed service has no secrets, platform bindings, or allow-list. A
 * request therefore cannot escape unless a future, separately reviewed
 * mediator supplies an exact resource grant to the shared policy function.
 */
export class DenyEgressWorker extends WorkerEntrypoint<DenyEgressEnv> {
  fetch(request: Request) {
    return handleManagedOutboundRequest({
      request,
      context: {
        policy: "deny_by_default",
        shiplet:
          this.env.policy === "deny_by_default" ? (this.env.shiplet ?? "") : "",
        revision: this.env.revision ?? "",
        generation: this.env.generation ?? "",
      },
      allow: [],
      fetch,
    });
  }
}

export default DenyEgressWorker;
