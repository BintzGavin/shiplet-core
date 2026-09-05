import { describe, expect, it } from "vitest";

import type { KernelDocumentNonce } from "../src/kernel-document-nonce";
import { BuildPlatformPublishPage } from "../src/platform/publish-page";
import {
	BuildSettingsPage,
	BuildWebsitePage,
	HARBOR_SCENE_SVG,
	renderPage,
} from "../src/render";
import { SHIPLET_FAVICON_SVG } from "../src/seo";

const CANONICAL_MARK_GEOMETRY = [
	'x="62" y="20" width="4" height="42" rx="2"',
	'd="M66 18l26 11-26 11z"',
	'x="40" y="62" width="21" height="20" rx="2"',
	'x="67" y="62" width="21" height="20" rx="2"',
	'd="M28 86h72l-13 24H41z"',
	'd="M29 118q7-7 14 0t14 0t14 0t14 0t14 0"',
];

const CANONICAL_MARK_OPTICAL_OFFSET = 'transform="translate(0 -8)"';

function extractBrandHeader(html: string) {
	return (
		html.match(/<header class="shiplet-brand-header"[^>]*>[\s\S]*?<\/header>/)
			?.[0] || ""
	);
}

describe("Shiplet SVG system", () => {
	it("Given the favicon and header marks, when they render at different optical sizes, then they expose the same canonical silhouette", () => {
		const page = renderPage("<p>SVG system fixture</p>", {
			nonce: "svg-system-test-nonce-12345" as KernelDocumentNonce,
		});

		for (const fragment of CANONICAL_MARK_GEOMETRY) {
			expect(SHIPLET_FAVICON_SVG).toContain(fragment);
			expect(page).toContain(fragment);
		}
		expect(SHIPLET_FAVICON_SVG).toContain(CANONICAL_MARK_OPTICAL_OFFSET);
		expect(page).toContain(CANONICAL_MARK_OPTICAL_OFFSET);
		expect(HARBOR_SCENE_SVG).not.toContain("scene-logo-insignia");
		expect(HARBOR_SCENE_SVG).not.toContain(
			'transform="translate(305 119) scale(.2)"',
		);
	});

	it("Given either compact header variant, when navigation renders, then canonical mark geometry and utility contracts stay unchanged while platform nav remains outside", () => {
		const nonce = "svg-system-test-nonce-12345" as KernelDocumentNonce;
		const user = {
			id: "user_svg_system",
			email: "svg-system@example.com",
			created_on: "2026-08-13T00:00:00.000Z",
			updated_on: "2026-08-13T00:00:00.000Z",
		};
		const page = renderPage(
			BuildPlatformPublishPage({
				nonce,
				user,
			}),
			{ nonce, user },
		);
		const header = extractBrandHeader(page);

		for (const fragment of CANONICAL_MARK_GEOMETRY) {
			expect(header).toContain(fragment);
		}
		expect(header).toContain(CANONICAL_MARK_OPTICAL_OFFSET);
		expect(header).toContain('aria-label="Shiplet home"');
		expect(header).toContain('aria-label="Utility"');
		expect(header).toContain('href="/docs"');
		expect(header).toContain('href="/account"');
		for (const routeLink of [
			'href="/shiplets"',
			'href="/feedback"',
			'href="/inbox"',
			'href="/workspace"',
		]) {
			expect(header).not.toContain(routeLink);
		}
		expect(page.indexOf("</header>")).toBeLessThan(
			page.indexOf('data-platform-nav="primary"'),
		);
	});

	it("Given repeated non-widget action glyphs, when they render in the publish flow, then they share crisp, non-focusable SVG roots", () => {
		const reactPublishPage = BuildPlatformPublishPage({
			nonce: "svg-system-test-nonce-12345" as KernelDocumentNonce,
			user: {
				id: "user_svg_system",
				email: "svg-system@example.com",
				created_on: "2026-08-13T00:00:00.000Z",
				updated_on: "2026-08-13T00:00:00.000Z",
			},
		});
		const nonce = "svg-system-test-nonce-12345" as KernelDocumentNonce;
		const pages = [
			reactPublishPage,
			BuildWebsitePage(nonce),
			BuildSettingsPage(nonce),
		];
		const svgRoots = pages.flatMap((page) => page.match(/<svg\b[^>]*>/g) || []);

		expect(svgRoots.length).toBeGreaterThanOrEqual(3);
		for (const svgRoot of svgRoots) {
			expect(svgRoot).toContain('aria-hidden="true"');
			expect(svgRoot).toContain('focusable="false"');
		}
	});
});
