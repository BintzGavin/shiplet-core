import { describe, expect, it } from "vitest";

import type { KernelDocumentNonce } from "../src/kernel-document-nonce";
import { BuildPlatformPublishPage } from "../src/platform/publish-page";
import {
	BuildSettingsPage,
	BuildWebsitePage,
	CSS,
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

function decodeAuthStamp() {
	const authCardRuleStart = CSS.indexOf(".auth-card {\n  background-image:");
	const authCardRule = CSS.slice(
		authCardRuleStart,
		CSS.indexOf("\n}", authCardRuleStart),
	);
	const encodedSvg = authCardRule.match(/data:image\/svg\+xml,([^"')]+)/)?.[1];
	return encodedSvg ? decodeURIComponent(encodedSvg) : "";
}

function extractBrandHeader(html: string) {
	return (
		html.match(/<header class="shiplet-brand-header"[^>]*>[\s\S]*?<\/header>/)
			?.[0] || ""
	);
}

function extractCssRule(selector: string) {
	const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return (
		CSS.match(new RegExp(`${escapedSelector}\\s*\\{[\\s\\S]*?\\}`))?.[0] ||
		""
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

	it("Given public and authenticated shells, when the shared header renders, then the logo is the sole vessel and each variant keeps a compact waterline story", () => {
		const nonce = "svg-system-test-nonce-12345" as KernelDocumentNonce;
		const publicHeader = extractBrandHeader(
			renderPage("<p>Public fixture</p>", { nonce }),
		);
		const authenticatedHeader = extractBrandHeader(
			renderPage("<p>Authenticated fixture</p>", {
				nonce,
				user: {
					id: "user_svg_system",
					email: "svg-system@example.com",
					avatar_preset: "aurora-grid",
				},
			}),
		);

		expect(publicHeader).toContain('data-header-variant="public"');
		expect(authenticatedHeader).toContain(
			'data-header-variant="authenticated"',
		);
		expect(publicHeader.match(/<svg class="shiplet-waterline-svg"/g)).toHaveLength(1);
		expect(authenticatedHeader.match(/<svg class="shiplet-waterline-svg"/g)).toHaveLength(1);
		for (const sharedDepth of [
			"shiplet-waterline-far",
			"shiplet-waterline-mid",
			"shiplet-waterline-near",
			"shiplet-waterline-foam",
		]) {
			expect(publicHeader).toContain(sharedDepth);
			expect(authenticatedHeader).toContain(sharedDepth);
		}
		for (const header of [publicHeader, authenticatedHeader]) {
			expect(header.match(/data-header-vessel="primary"/g)).toHaveLength(1);
			expect(header).toContain("shiplet-mark-vessel");
			expect(header).toContain("shiplet-mark-depth");
			expect(header).toContain("shiplet-mark-water-contact");
			expect(header).toContain("shiplet-mark-wake");
			expect(header).toContain("shiplet-brand-wake-extension");
			expect(header).not.toContain("shiplet-waterline-vessel");
			expect(header).not.toContain("shiplet-waterline-pilot-skiff");
			expect(header).not.toContain("shiplet-waterline-distant-vessel");
		}
		for (const authenticatedDetail of [
			"shiplet-waterline-marker-buoy",
			"shiplet-waterline-avatar-ripple",
		]) {
			expect(authenticatedHeader).toContain(authenticatedDetail);
			expect(publicHeader).not.toContain(authenticatedDetail);
		}
	});

	it("Given the primary logo vessel, when transform motion runs, then animation stays inside its positioned mark and full-width water never stretches boat geometry", () => {
		const nonce = "svg-system-test-nonce-12345" as KernelDocumentNonce;
		const publicHeader = extractBrandHeader(
			renderPage("<p>Public fixture</p>", { nonce }),
		);
		const authenticatedHeader = extractBrandHeader(
			renderPage("<p>Authenticated fixture</p>", {
				nonce,
				user: {
					id: "user_svg_system",
					email: "svg-system@example.com",
				},
			}),
		);

		for (const header of [publicHeader, authenticatedHeader]) {
			expect(header).toContain(
				'class="shiplet-mark-position" transform="translate(0 -8)"',
			);
			expect(header).toContain(
				'class="shiplet-mark-vessel" data-header-vessel="primary"',
			);
			expect(header).not.toMatch(
				/<g class="shiplet-mark-vessel"[^>]* transform=/,
			);
			expect(header).not.toContain("shiplet-waterline-vessel");
		}
		expect(authenticatedHeader).toContain(
			'class="shiplet-waterline-position shiplet-waterline-marker-buoy-position shiplet-waterline-mobile-hide" transform="translate(300 11)"',
		);
		expect(authenticatedHeader).not.toMatch(
			/<g class="shiplet-waterline-marker-buoy[^"]*" transform=/,
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

	it("Given reduced motion and no JS, when the compact waterline renders, then the logo vessel and every wave stay visible with transforms settled", () => {
		const nonce = "svg-system-test-nonce-12345" as KernelDocumentNonce;
		const header = extractBrandHeader(
			renderPage("<p>Authenticated fixture</p>", {
				nonce,
				user: {
					id: "user_svg_system",
					email: "svg-system@example.com",
					avatar_preset: "aurora-grid",
				},
			}),
		);
		const waterlineCss = CSS.slice(
			CSS.indexOf(".shiplet-waterline {"),
			CSS.indexOf(".shiplet-main {"),
		);
		const reducedMotionRule = CSS.slice(
			CSS.indexOf("@media (prefers-reduced-motion: reduce)"),
			CSS.indexOf(
				"/* --------------------------------------------------------------------------\n   Shell",
				CSS.indexOf("@media (prefers-reduced-motion: reduce)"),
			),
		);

		expect(header).toContain("shiplet-waterline-svg");
		expect(header).not.toContain(" hidden");
		expect(waterlineCss).not.toContain("data:image/svg+xml");
		expect(waterlineCss).toContain("color: var(--mark-harbor);");
		expect(CSS).toContain(
			"html:not(.js) .shiplet-waterline-svg :is(.shiplet-waterline-wave, .shiplet-waterline-avatar-ripple) { animation: none; transform: none; }",
		);
		expect(CSS).toContain(
			"html:not(.js) .shiplet-brand-mark :is(.shiplet-mark-vessel, .shiplet-mark-water-motion) { animation: none; transform: none; }",
		);
		expect(reducedMotionRule).toContain(
			".shiplet-waterline-svg :is(.shiplet-waterline-wave, .shiplet-waterline-avatar-ripple) { transform: none; }",
		);
		expect(reducedMotionRule).toContain(
			".shiplet-brand-mark :is(.shiplet-mark-vessel, .shiplet-mark-water-motion) { transform: none; }",
		);
		expect(reducedMotionRule).toContain(
			".shiplet-waterline-svg .shiplet-waterline-drawn { stroke-dashoffset: 0; }",
		);
	});

	it("Given the compact header at mobile width, when decoration is simplified, then tertiary and control-adjacent detail is pruned without hiding controls or the logo vessel", () => {
		const mobileRules = CSS.slice(CSS.indexOf("@media (max-width: 640px)"));

		expect(mobileRules).toContain(
			".shiplet-waterline-tertiary { display: none; }",
		);
		expect(mobileRules).toContain(
			".shiplet-waterline-mobile-hide { display: none; }",
		);
		expect(mobileRules).toContain(
			".shiplet-brand-wake-extension { width: 64px; }",
		);
		for (const mustRemainVisible of [
			".shiplet-brand-mark { display: none;",
			".shiplet-brand-nav { display: none;",
			".shiplet-header-avatar { display: none;",
			".shiplet-waterline-primary { display: none;",
			".shiplet-mark-vessel { display: none;",
		]) {
			expect(mobileRules).not.toContain(mustRemainVisible);
		}
		expect(mobileRules).toContain(".shiplet-brand-inner { padding: 6px 16px;");
		expect(mobileRules).toContain(
			".shiplet-brand-nav a { min-height: 44px;",
		);
	});

	it("Given the compact header CSS, when it is inspected for product-shell constraints, then it keeps the header under title-screen scale", () => {
		const shellCss = CSS.slice(
			CSS.indexOf("Shell: brand header over a living waterline"),
			CSS.indexOf(".platform-nav"),
		);

		expect(extractCssRule(".shiplet-brand-header")).toContain(
			"max-height: 76px;",
		);
		expect(extractCssRule(".shiplet-brand-inner")).toContain(
			"min-height: 64px;",
		);
		expect(extractCssRule(".shiplet-brand-lockup")).toContain("width: 50px;");
		expect(extractCssRule(".shiplet-brand-mark")).toContain("width: 40px;");
		expect(shellCss).not.toMatch(
			/\b(?:height|min-height):\s*(?:100vh|100dvh|100svh|[8-9]\dvh)/,
		);
		expect(shellCss).not.toContain("hero");
		expect(shellCss).not.toContain("title-screen");
	});

	it("Given the wide harbor scene, when it scales to a narrow viewport, then its full original composition is contained inside an explicit viewport", () => {
		expect(HARBOR_SCENE_SVG).toContain('viewBox="0 0 640 190"');
		expect(HARBOR_SCENE_SVG).toContain("scene-horizon-line");
		expect(HARBOR_SCENE_SVG).toContain("scene-pier-house");
		expect(HARBOR_SCENE_SVG).toContain("scene-working-vessel");
		expect(HARBOR_SCENE_SVG).toContain("scene-lantern-glints");
		expect(HARBOR_SCENE_SVG).toContain(
			'shape-rendering="geometricPrecision"',
		);
		expect(CSS).toContain(
			".harbor-scene-svg { display: block; max-width: 100%; overflow: hidden;",
		);
		expect(CSS).not.toContain(".harbor-scene-svg { overflow: visible;");
		expect(HARBOR_SCENE_SVG).toContain(
			'd="M5 164c26-8 51-8 76 0',
		);
		expect(HARBOR_SCENE_SVG).not.toContain(
			'class="draw-path scene-horizon-line" style="--di:0" d="M0 ',
		);
	});

	it("Given primary landmarks and secondary texture, when the harbor scene is scaled, then its optical stroke hierarchy remains explicit", () => {
		expect(HARBOR_SCENE_SVG).toContain("scene-beacon-body");
		expect(HARBOR_SCENE_SVG).toContain("scene-beacon-detail");
		expect(HARBOR_SCENE_SVG).toContain("scene-beacon-cap");
		expect(HARBOR_SCENE_SVG).toContain("scene-lantern-room");
		expect(CSS).toContain(
			".harbor-scene-svg .scene-primary-silhouette { stroke-width: 2.8px; }",
		);
		expect(CSS).toContain(
			".harbor-scene-svg .scene-fine-detail { stroke-width: 1.45px; }",
		);
	});

	it("Given the signed-out harbor settles, when its working details resolve, then sparse craft, dock, beacon, and water cues add depth without changing the scene's identity", () => {
		for (const detailGroup of [
			"scene-dock-mooring",
			"scene-beacon-masonry",
			"scene-vessel-working-details",
			"scene-beacon-water-glints",
		]) {
			expect(HARBOR_SCENE_SVG).toContain(detailGroup);
		}

		expect(HARBOR_SCENE_SVG).toContain(
			'class="scene-dock-mooring scene-tertiary-detail"',
		);
		expect(HARBOR_SCENE_SVG).toContain(
			'class="scene-beacon-masonry scene-tertiary-detail"',
		);
		expect(HARBOR_SCENE_SVG).toContain(
			'class="scene-vessel-working-details scene-fine-detail"',
		);
		expect(HARBOR_SCENE_SVG).toContain(
			'class="scene-beacon-water-glints scene-beacon-reflection"',
		);
		expect(HARBOR_SCENE_SVG).toContain("scene-structural-line");
		expect(HARBOR_SCENE_SVG).toContain('pathLength="1"');

		const mobileRules = CSS.slice(CSS.indexOf("@media (max-width: 640px)"));
		expect(mobileRules).toContain(
			".harbor-scene-svg .scene-tertiary-detail { display: none; }",
		);
		expect(CSS).toContain(
			"html:not(.js) .draw-path { stroke-dashoffset: 0; }",
		);
		expect(HARBOR_SCENE_SVG).not.toContain("scene-logo-insignia");
	});

	it("Given the signed-out landing page, when its hero occupies a desktop viewport, then the original scene and centered card form a compact stacked stage", () => {
		expect(CSS).toContain(".auth-stage { display: grid; place-items: center; gap: 6px; padding: 3vh 0 0; }");
		expect(CSS).toContain(".auth-scene { width: min(640px, 92%); color: var(--mark-ink); }");
		expect(CSS).toContain(".auth-card {\n  max-width: 520px;");
		expect(CSS).toContain("text-align: center;");
		expect(CSS).toContain("justify-items: center;");
		expect(CSS).toContain("margin-top: -6px;");
		expect(CSS).toContain(".auth-card {\n  background-image:");
		expect(HARBOR_SCENE_SVG).not.toContain("auth-product-proof");

		const mobileRules = CSS.slice(CSS.indexOf("@media (max-width: 640px)"));
		expect(mobileRules).not.toContain("grid-template-areas: \"copy\" \"proof\";");
		expect(mobileRules).not.toContain(".auth-scene svg { width: 120%;");
	});

	it("Given reduced motion, when branded pages load, then decorative SVG and chrome animation is disabled without hiding drawn content", () => {
		const reducedMotionRule = CSS.slice(
			CSS.indexOf("@media (prefers-reduced-motion: reduce)"),
			CSS.indexOf("/* --------------------------------------------------------------------------\n   Shell", CSS.indexOf("@media (prefers-reduced-motion: reduce)")),
		);

		expect(reducedMotionRule).toContain("animation: none !important;");
		expect(reducedMotionRule).toContain(
			".draw-path { stroke-dashoffset: 0; }",
		);
		expect(reducedMotionRule).toContain(
			".harbor-scene-svg .scene-boat-float { transform: none; }",
		);

		const allowedMotionRule = CSS.slice(
			CSS.indexOf("@media (prefers-reduced-motion: no-preference)"),
			CSS.indexOf("@media (prefers-reduced-motion: reduce)"),
		);
		expect(allowedMotionRule).toContain(
			".js .scene-bob { animation: bob 4.5s ease-in-out infinite; }",
		);
		expect(allowedMotionRule).toContain(
			".js .scene-gull { animation: gull-drift 6s ease-in-out infinite; }",
		);
		expect(allowedMotionRule).not.toMatch(/\n\s*\.scene-(?:bob|gull) \{/);
	});

	it("Given the customs stamp renders at about 144 pixels, when it decorates a card, then it uses one legible centered label without microtext", () => {
		const stamp = decodeAuthStamp();

		expect(stamp).toContain('shape-rendering="geometricPrecision"');
		expect(stamp.match(/<text\b/g)).toHaveLength(1);
		expect(stamp).toContain('font-size="21"');
		expect(stamp).toContain('letter-spacing="1.2"');
		expect(stamp).toContain('<rect x="24" y="71" width="132" height="42"');
		expect(stamp).toContain(">CLEARED</text>");
		expect(stamp).not.toContain(">SHIPLET</text>");
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
			expect(svgRoot).toContain('shape-rendering="geometricPrecision"');
		}
	});

	it("Given the landing calls to action, when they render, then the original card retains its customs stamp and ownership link styling", () => {
		expect(CSS).toContain(".auth-card {\n  background-image:");
		expect(CSS).toContain(".auth-docs-link {");
		expect(CSS).toContain("font-family: var(--font-mono);");
	});

	it("Given the landing copy at desktop width, when it renders, then the proof list retains the original centered compact treatment", () => {
		expect(CSS).toContain(".auth-proof-list {\n  display: flex;");
		expect(CSS).toContain("flex-wrap: wrap;");
		expect(CSS).toContain("justify-content: center;");
		expect(CSS).toContain("list-style-position: inside;");
		expect(CSS).toContain(".auth-proof-list li::marker { color: var(--action); }");
	});

	it("Given the original harbor illustration, when it renders in the landing hero, then its landmarks and drawing sequence remain explicit", () => {
		expect(HARBOR_SCENE_SVG).toContain("scene-water");
		expect(HARBOR_SCENE_SVG).toContain("scene-dock");
		expect(HARBOR_SCENE_SVG).toContain("scene-working-vessel");
		expect(HARBOR_SCENE_SVG).toContain("scene-beacon");
		expect(HARBOR_SCENE_SVG).toContain("scene-gull");
		expect(HARBOR_SCENE_SVG).toContain('pathLength="1"');
	});

	it("Given the flagship harbor scene, when its authored entrance runs, then the environment resolves before the boat arrives and supporting details settle", () => {
		expect(HARBOR_SCENE_SVG).toContain("scene-environment");
		expect(HARBOR_SCENE_SVG).toContain("scene-boat-arrival");
		expect(HARBOR_SCENE_SVG).toContain("scene-supporting-details");
		expect(HARBOR_SCENE_SVG).toContain("scene-boat-float");
		expect(CSS).toContain("@keyframes harbor-line-resolve");
		expect(CSS).toContain("@keyframes harbor-boat-dock");
		expect(CSS).toContain("@keyframes harbor-details-settle");
		expect(CSS).toContain(
			"animation: harbor-line-resolve 620ms var(--ease-out) both;",
		);
		expect(CSS).toContain(
			"animation: harbor-boat-dock 2.4s cubic-bezier(0.4, 0, 0.2, 1) 120ms both;",
		);
		expect(CSS).toContain(
			"animation: harbor-details-settle 520ms var(--ease-out) 1.35s both;",
		);
		expect(CSS).toContain(
			".harbor-scene-svg :is(.scene-boat-arrival, .scene-supporting-details, .scene-boat-float, .scene-foreground-tide, .scene-wake-arrival, .scene-boat-wake, .scene-boat-flag, .scene-gull-flight, .scene-beacon-beam, .scene-beacon-lamp) { transform-box: fill-box; transform-origin: center; }",
		);
	});

	it("Given a slow or paused animation frame, when the harbor entrance has not completed, then the scene stays legible instead of being visibility-gated", () => {
		expect(CSS).toContain(
			".harbor-scene-svg .draw-path { stroke-dashoffset: 0; }",
		);
		expect(CSS).toContain(
			".harbor-scene-svg .scene-boat-hull { fill-opacity: 1; }",
		);
		expect(CSS).toContain("stroke-dasharray: 0.16 0.045;");
		expect(CSS).not.toContain(
			"@keyframes harbor-line-resolve { from { stroke-dashoffset: 1; }",
		);
	});

	it("Given the entrance has settled, when ambient harbor motion continues, then it remains low-amplitude, asynchronous, and transform-only", () => {
		expect(CSS).toContain("@keyframes harbor-boat-idle");
		expect(CSS).toContain("@keyframes harbor-wake-breathe");
		expect(CSS).toContain("@keyframes harbor-flag-breathe");
		expect(CSS).toContain("@keyframes harbor-lamp-breathe");
		expect(CSS).toContain("@keyframes harbor-water-far-drift");
		expect(CSS).toContain("@keyframes harbor-water-mid-drift");
		expect(CSS).toContain("@keyframes harbor-water-near-drift");
		expect(CSS).toContain("@keyframes harbor-gull-glide");
		expect(CSS).toContain(
			"animation: harbor-boat-idle 7.2s ease-in-out 2.52s infinite both;",
		);
		expect(CSS).toContain(
			"50% { transform: translateY(-2.4px) rotate(0.2deg); }",
		);
		expect(CSS).toContain(
			"animation: harbor-wake-breathe 7.2s ease-in-out 2.42s infinite both;",
		);
		expect(CSS).toContain(
			"animation: harbor-flag-breathe 4.6s ease-in-out 2.5s infinite both;",
		);
		expect(CSS).toContain(
			"animation: harbor-water-near-drift 7.1s ease-in-out -4.1s infinite;",
		);
		expect(CSS).toContain(
			"animation: harbor-gull-glide 10s ease-in-out 3s infinite;",
		);

		const harborMotion = CSS.slice(
			CSS.indexOf("@keyframes harbor-line-resolve"),
			CSS.indexOf("@media (prefers-reduced-motion: reduce)"),
		);
		expect(harborMotion).not.toMatch(/\b(?:width|height|top|left|margin):/);
		expect(harborMotion).not.toMatch(/bounce|elastic/);
	});

	it("Given the harbor scene renders on a narrow screen, when secondary detail is simplified, then the same primary silhouettes and palette remain", () => {
		expect(HARBOR_SCENE_SVG).toContain("scene-mobile-secondary");
		const mobileRules = CSS.slice(CSS.indexOf("@media (max-width: 640px)"));
		expect(mobileRules).toContain(
			".harbor-scene-svg .scene-mobile-secondary { display: none; }",
		);
		expect(mobileRules).not.toContain(".harbor-scene-svg .scene-dock { display: none;");
		expect(mobileRules).not.toContain(".harbor-scene-svg .scene-boat { display: none;");
		expect(mobileRules).not.toContain(".harbor-scene-svg .scene-beacon { display: none;");
	});

	it("Given the flagship harbor is judged in a settled frame, when compared with the original sparse scene, then it has three explicit depth planes and a legible docking story", () => {
		const backdrop = HARBOR_SCENE_SVG.indexOf('class="scene-backdrop');
		const midground = HARBOR_SCENE_SVG.indexOf('class="scene-midground');
		const foreground = HARBOR_SCENE_SVG.indexOf('class="scene-foreground');

		expect(backdrop).toBeGreaterThan(-1);
		expect(midground).toBeGreaterThan(backdrop);
		expect(foreground).toBeGreaterThan(midground);
		for (const landmark of [
			"scene-sky-birds",
			"scene-breakwater",
			"scene-dock-ladder",
			"scene-mooring-line",
			"scene-boat-reflection",
			"scene-beacon-beam",
			"scene-lantern-glints",
			"scene-signal-flag",
		]) {
			expect(HARBOR_SCENE_SVG).toContain(landmark);
		}
		expect(CSS).toContain(
			".harbor-scene-svg .scene-primary-silhouette { stroke-width: 2.8px; }",
		);
		expect(CSS).toContain(
			".harbor-scene-svg .scene-fine-detail { stroke-width: 1.45px; }",
		);
	});

	it("Given the harbor is the flagship brand illustration, when it settles at desktop and mobile sizes, then each depth tier remains explicit without pier-water crosshatching", () => {
		for (const detail of [
			"scene-intentional-contour",
			"scene-pier-texture",
			"scene-tertiary-detail",
			"scene-working-vessel",
			"scene-wheelhouse",
			"scene-fender",
		]) {
			expect(HARBOR_SCENE_SVG).toContain(detail);
		}
		expect(HARBOR_SCENE_SVG).not.toContain("scene-cloud-bank");
		expect(HARBOR_SCENE_SVG).not.toContain("scene-coastline");
		expect(HARBOR_SCENE_SVG).not.toContain("scene-far-water");
		expect(HARBOR_SCENE_SVG).not.toContain("scene-logo-insignia");
		expect(HARBOR_SCENE_SVG).not.toContain("scene-beacon-rays");
		expect(HARBOR_SCENE_SVG).not.toContain(
			'<circle class="scene-beacon',
		);
		expect(CSS).toContain(
			".harbor-scene-svg .scene-tertiary-detail { stroke-width: 1.05px; opacity: 0.34; }",
		);
		expect(CSS).toContain(
			".harbor-scene-svg .scene-pier-texture { opacity: 0.48; }",
		);
		const mobileRules = CSS.slice(CSS.indexOf("@media (max-width: 640px)"));
		expect(mobileRules).toContain(
			".harbor-scene-svg .scene-tertiary-detail { display: none; }",
		);
		expect(mobileRules).toContain(
			".harbor-scene-svg .scene-pier-texture { opacity: 0.28; }",
		);
	});

	it("Given the boat enters open water, when the authored sequence completes, then it docks, casts a line, settles the wake, and yields to depth-aware ambient motion", () => {
		for (const motion of [
			"@keyframes harbor-boat-dock",
			"@keyframes harbor-mooring-slack",
			"@keyframes harbor-mooring-secure",
			"@keyframes harbor-wake-dissolve",
			"@keyframes harbor-lamp-breathe",
			"@keyframes harbor-beam-drift",
			"@keyframes harbor-water-far-drift",
		]) {
			expect(CSS).toContain(motion);
		}
		expect(CSS).toContain(
			".scene-go .harbor-scene-svg .scene-boat-arrival { animation: harbor-boat-dock",
		);
		expect(HARBOR_SCENE_SVG).toContain("scene-mooring-slack");
		expect(HARBOR_SCENE_SVG).toContain("scene-mooring-taut");
		expect(CSS).toContain(".scene-go .harbor-scene-svg .scene-mooring-slack { animation: harbor-mooring-slack");
		expect(CSS).toContain(".scene-go .harbor-scene-svg .scene-mooring-taut { animation: harbor-mooring-secure");
		expect(HARBOR_SCENE_SVG).toContain("scene-beacon-lamp");
		expect(CSS).toContain(".scene-go .harbor-scene-svg .scene-beacon-lamp { animation: harbor-lamp-breathe");
		expect(CSS).toContain(
			".scene-go .harbor-scene-svg .scene-wake-arrival { animation: harbor-wake-dissolve",
		);

		const mobileRules = CSS.slice(CSS.indexOf("@media (max-width: 640px)"));
		expect(mobileRules).not.toContain(".scene-sky-birds { display: none;");
		expect(mobileRules).not.toContain(".scene-dock-ladder { display: none;");
		expect(mobileRules).not.toContain(".scene-mooring-line { display: none;");
		expect(mobileRules).not.toContain(".scene-boat-reflection { display: none;");
	});

	it("Given the lighthouse is resting after arrival, when its spotlight crosses the harbor, then one soft beam sweeps open water slowly without snapping onto the ship", () => {
		const beamStart = HARBOR_SCENE_SVG.indexOf(
			'<g class="scene-beacon-beam"',
		);
		const beamEnd = HARBOR_SCENE_SVG.indexOf("</g>", beamStart);
		const beamMarkup = HARBOR_SCENE_SVG.slice(beamStart, beamEnd);

		expect(beamStart).toBeGreaterThan(-1);
		expect(beamMarkup.match(/<path\b/g)).toHaveLength(1);
		expect(beamMarkup).toContain('data-beam-course="port-open-sky"');
		expect(beamMarkup).toContain('data-beam-bounds="410 10 539 67"');
		expect(HARBOR_SCENE_SVG).toContain(
			'<linearGradient id="harbor-beam-fade" gradientUnits="userSpaceOnUse" x1="539" y1="58" x2="410" y2="18">',
		);
		expect(HARBOR_SCENE_SVG).toContain(
			'<stop data-beam-depth="source" offset="0%" stop-color="var(--mark-harbor, #2f6e88)" stop-opacity="1"/>',
		);
		expect(HARBOR_SCENE_SVG).toContain(
			'<stop data-beam-depth="mid" offset="64%" stop-color="var(--mark-harbor, #2f6e88)" stop-opacity="0.74"/>',
		);
		expect(HARBOR_SCENE_SVG).toContain(
			'<stop data-beam-depth="far" offset="100%" stop-color="var(--mark-harbor, #2f6e88)" stop-opacity="0"/>',
		);
		expect(beamMarkup).toContain(
			'd="M538 52c-36-20-76-34-120-42-7-1-10 16-4 18 44 10 85 25 125 39z"',
		);
		expect(beamMarkup).toContain('fill="url(#harbor-beam-fade)"');
		expect(HARBOR_SCENE_SVG).toContain("scene-beacon-lamp");
		expect(HARBOR_SCENE_SVG).toContain("scene-lantern-glints");

		const beamMotionStart = CSS.indexOf("@keyframes harbor-beam-drift");
		const beamMotionEnd = CSS.indexOf("@keyframes harbor-cloud-near-drift", beamMotionStart);
		const beamMotion = CSS.slice(beamMotionStart, beamMotionEnd);
		expect(beamMotion).toContain(
			"0%, 100% { opacity: 0.18; transform: rotate(-4.5deg); }",
		);
		expect(beamMotion).toContain(
			"50% { opacity: 0.2; transform: rotate(4.5deg); }",
		);
		expect(beamMotion).not.toMatch(/steps\(|linear/);
		expect(CSS).toContain(
			".scene-go .harbor-scene-svg .scene-beacon-beam { animation: harbor-beam-drift 18s cubic-bezier(0.45, 0, 0.55, 1) 0s infinite; }",
		);
		expect(CSS).toContain(
			".harbor-scene-svg .scene-beacon-beam { color: var(--mark-harbor); fill: currentColor; stroke: none; opacity: 0.19; transform: rotate(-4.5deg); }",
		);
		expect(CSS).toContain(
			"html:not(.js) .harbor-scene-svg .scene-beacon-beam { transform: none; opacity: 0.19; }",
		);

		const reducedMotionRule = CSS.slice(
			CSS.indexOf("@media (prefers-reduced-motion: reduce)"),
			CSS.indexOf(
				"/* --------------------------------------------------------------------------\n   Shell",
				CSS.indexOf("@media (prefers-reduced-motion: reduce)"),
			),
		);
		expect(reducedMotionRule).toContain(
			".harbor-scene-svg :is(.scene-boat-wake, .scene-boat-flag, .scene-beacon-beam, .scene-beacon-lamp) { transform: none; }",
		);
		for (const rejectedMotif of [
			"scene-logo-insignia",
			"scene-beacon-rays",
			'<circle class="scene-beacon',
		]) {
			expect(HARBOR_SCENE_SVG).not.toContain(rejectedMotif);
		}
	});

	it("Given the ship enters and settles, when arrival hands off to rest, then its course eases monotonically into a calm logo-like bob without a transform jump", () => {
		const arrivalStart = CSS.indexOf("@keyframes harbor-boat-dock");
		const arrivalEnd = CSS.indexOf("@keyframes harbor-mooring-slack", arrivalStart);
		const arrivalMotion = CSS.slice(arrivalStart, arrivalEnd);
		const arrivalSteps = [...arrivalMotion.matchAll(
			/(?:0%|25%|50%|75%|100%) \{ opacity: (\d+(?:\.\d+)?); transform: translate\((\d+(?:\.\d+)?)(?:px)?, (\d+(?:\.\d+)?)(?:px)?\) rotate\((\d+(?:\.\d+)?)deg\); \}/g,
		)].map((match) => ({
			opacity: Number(match[1]),
			x: Number(match[2]),
			y: Number(match[3]),
			rotation: Number(match[4]),
		}));
		expect(arrivalSteps).toHaveLength(5);
		expect(arrivalSteps[0]).toEqual({
			opacity: 0.76,
			x: 28,
			y: 4,
			rotation: 0.32,
		});
		expect(arrivalSteps.at(-1)).toEqual({
			opacity: 1,
			x: 0,
			y: 0,
			rotation: 0,
		});
		for (let index = 1; index < arrivalSteps.length; index += 1) {
			expect(arrivalSteps[index].x).toBeLessThan(arrivalSteps[index - 1].x);
			expect(arrivalSteps[index].opacity).toBeGreaterThanOrEqual(
				arrivalSteps[index - 1].opacity,
			);
			expect(arrivalSteps[index - 1].x - arrivalSteps[index].x).toBe(7);
		}
		expect(arrivalSteps[0].x).toBeGreaterThanOrEqual(24);
		expect(arrivalSteps[0].x).toBeLessThanOrEqual(28);
		expect(arrivalSteps[0].opacity).toBeGreaterThanOrEqual(0.75);
		const authoredBoatRightEdge = 418;
		const authoredBreakwaterLeftEdge = 454;
		const authoredLighthouseLeftEdge = 514;
		expect(authoredBoatRightEdge + arrivalSteps[0].x).toBeLessThan(
			authoredBreakwaterLeftEdge,
		);
		expect(authoredBoatRightEdge + arrivalSteps[0].x).toBeLessThan(
			authoredLighthouseLeftEdge,
		);
		expect(arrivalMotion).toContain(
			"100% { opacity: 1; transform: translate(0, 0) rotate(0deg); }",
		);
		expect(arrivalMotion).not.toContain("translate(-");
		expect(arrivalMotion).not.toMatch(/steps\(|linear/);
		expect(CSS).toContain(
			".scene-go .harbor-scene-svg .scene-boat-arrival { animation: harbor-boat-dock 2.4s cubic-bezier(0.4, 0, 0.2, 1) 120ms both; }",
		);

		const idleStart = CSS.indexOf("@keyframes harbor-boat-idle");
		const idleEnd = CSS.indexOf("@keyframes harbor-wake-breathe", idleStart);
		const idleMotion = CSS.slice(idleStart, idleEnd);
		expect(idleMotion).toContain(
			"0%, 100% { transform: none; }",
		);
		expect(idleMotion).toContain(
			"50% { transform: translateY(-2.4px) rotate(0.2deg); }",
		);
		expect(CSS).toContain(
			".scene-go .harbor-scene-svg .scene-boat-float { animation: harbor-boat-idle 7.2s ease-in-out 2.52s infinite both; }",
		);
		expect(CSS).toContain(
			"html:not(.js) .harbor-scene-svg .scene-boat-float { transform: none; }",
		);

		const arrivalGroup = HARBOR_SCENE_SVG.indexOf(
			'<g class="scene-boat-arrival scene-boat scene-working-vessel">',
		);
		const floatGroup = HARBOR_SCENE_SVG.indexOf(
			'<g class="scene-boat-float">',
			arrivalGroup,
		);
		expect(arrivalGroup).toBeGreaterThan(-1);
		expect(floatGroup).toBeGreaterThan(arrivalGroup);

		const reducedMotionRule = CSS.slice(
			CSS.indexOf("@media (prefers-reduced-motion: reduce)"),
			CSS.indexOf(
				"/* --------------------------------------------------------------------------\n   Shell",
				CSS.indexOf("@media (prefers-reduced-motion: reduce)"),
			),
		);
		expect(reducedMotionRule).toContain(
			".harbor-scene-svg .scene-boat-float { transform: none; }",
		);
	});

	it("Given the harbor environment remains alive at rest, when clouds and water move, then depth layers drift gently on distinct slow phases without dash redraws", () => {
		for (const layer of [
			"scene-cloud-near",
			"scene-cloud-far",
			"scene-water-far-layer",
			"scene-water-mid-layer",
			"scene-water-near-layer",
		]) {
			expect(HARBOR_SCENE_SVG).toContain(layer);
		}

		for (const motion of [
			"@keyframes harbor-cloud-near-drift",
			"@keyframes harbor-cloud-far-drift",
			"@keyframes harbor-water-far-drift",
			"@keyframes harbor-water-mid-drift",
			"@keyframes harbor-water-near-drift",
		]) {
			expect(CSS).toContain(motion);
		}
		expect(CSS).toContain(
			".scene-go .harbor-scene-svg .scene-cloud-near { animation: harbor-cloud-near-drift 32s ease-in-out -8s infinite; }",
		);
		expect(CSS).toContain(
			".scene-go .harbor-scene-svg .scene-cloud-far { animation: harbor-cloud-far-drift 44s ease-in-out -19s infinite; }",
		);
		expect(CSS).toContain(
			".scene-go .harbor-scene-svg .scene-water-far-layer { animation: harbor-water-far-drift 12.8s ease-in-out -1.7s infinite; }",
		);
		expect(CSS).toContain(
			".scene-go .harbor-scene-svg .scene-water-mid-layer { animation: harbor-water-mid-drift 9.6s ease-in-out -2.3s infinite; }",
		);
		expect(CSS).toContain(
			".scene-go .harbor-scene-svg .scene-water-near-layer { animation: harbor-water-near-drift 7.1s ease-in-out -4.1s infinite; }",
		);

		const ambientStart = CSS.indexOf("@keyframes harbor-cloud-near-drift");
		const ambientEnd = CSS.indexOf("@media (prefers-reduced-motion: reduce)");
		const ambientMotion = CSS.slice(ambientStart, ambientEnd);
		expect(ambientMotion).toContain(
			"0%, 100% { transform: translate(-8px, 0); }",
		);
		expect(ambientMotion).toContain(
			"50% { transform: translate(16px, -1.2px); }",
		);
		expect(ambientMotion).toContain(
			"0%, 100% { transform: translate(-6px, 0.3px); }",
		);
		expect(ambientMotion).toContain(
			"50% { transform: translate(11px, -0.8px); }",
		);
		expect(ambientMotion).toContain(
			"50% { transform: translate(6.4px, -1.1px) scaleX(1.012); }",
		);
		expect(ambientMotion).not.toContain("stroke-dasharray");
		expect(ambientMotion).not.toContain("stroke-dashoffset");
		expect(ambientMotion).not.toMatch(/steps\(/);
		expect(CSS).toContain(
			"html:not(.js) .harbor-scene-svg :is(.scene-cloud-near, .scene-cloud-far, .scene-water-far-layer, .scene-water-mid-layer, .scene-water-near-layer) { animation: none; transform: none; }",
		);

		const reducedMotionRule = CSS.slice(
			CSS.indexOf("@media (prefers-reduced-motion: reduce)"),
			CSS.indexOf(
				"/* --------------------------------------------------------------------------\n   Shell",
				CSS.indexOf("@media (prefers-reduced-motion: reduce)"),
			),
		);
		expect(reducedMotionRule).toContain(
			".harbor-scene-svg :is(.scene-cloud-near, .scene-cloud-far, .scene-water-far-layer, .scene-water-mid-layer, .scene-water-near-layer) { transform: none; }",
		);
	});
});
