import { describe, expect, it } from "vitest";
import { BuildShipletReviewPage } from "../src/render";
import type { KernelDocumentNonce } from "../src/kernel-document-nonce";
import type { Project } from "../src/types";

describe("shiplet review bridge feedback labels", () => {
	it("uses canonical preview feedback labels in the comments panel runtime", () => {
		const project: Project = {
			id: "project_test",
			organization_id: "org_test",
			name: "Prod Smoke Review",
			subdomain: "prod-smoke-review",
			script_content: "",
			visibility: "organization",
			created_on: "2026-06-16T00:00:00.000Z",
			modified_on: "2026-06-16T00:00:00.000Z",
		};

		const html = BuildShipletReviewPage({
			nonce: "test-kernel-document-nonce" as KernelDocumentNonce,
			project,
			artifactUrl: "https://prod-smoke-review.shiplet.cc/",
			previewUrl: "/shiplets/project_test/preview",
			reviewUrl: "https://prod-smoke-review.shiplet.cc/",
		});

		expect(html).toContain("function commentLabelFor(item)");
		expect(html).toMatch(
			/if \(item && item\.ticket_label\) return item\.ticket_label;[\s\S]*return "PF-" \+ number;/,
		);
		expect(html).not.toContain(
			'return initialsForProject(detailProject) + "-" + number;',
		);
	});
});
