import agentRegistrationFlowSvg from "../public/brand/docs/agent-registration-flow.svg";
import { ASSET_CACHE_CONTROL } from "./seo";

export function agentRegistrationFlowResponse() {
	return new Response(agentRegistrationFlowSvg, {
		headers: {
			"cache-control": ASSET_CACHE_CONTROL,
			"content-length": String(
				new TextEncoder().encode(agentRegistrationFlowSvg).byteLength,
			),
			"content-type": "image/svg+xml; charset=utf-8",
			"x-content-type-options": "nosniff",
		},
	});
}
