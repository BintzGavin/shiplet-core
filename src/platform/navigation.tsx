import * as React from "react";

export type PlatformRoute =
	| "home"
	| "annotate"
	| "feedback"
	| "handshakes"
	| "traces"
	| "shiplets"
	| "inbox"
	| "workspace"
	| "access"
	| "agents"
	| "account";

type NavItem = {
	route: PlatformRoute;
	href: string;
	label: string;
	badge?: "notifications" | "feedback";
};

// The nav reads as the loop: what you asked for (annotations), agents working
// on it together (handshakes), and what came back (traces). Annotating is the
// way in, so it is the one primary action, on every page.
const LOOP_ITEMS: NavItem[] = [
	{ route: "feedback", href: "/feedback", label: "Annotations", badge: "feedback" },
	{ route: "handshakes", href: "/handshakes", label: "Handshakes" },
	{ route: "traces", href: "/traces", label: "Traces" },
];

const PLACE_ITEMS: NavItem[] = [
	{ route: "shiplets", href: "/shiplets", label: "Shiplets" },
	{ route: "inbox", href: "/inbox", label: "Inbox", badge: "notifications" },
	{ route: "workspace", href: "/workspace", label: "Workspace" },
];

export type PlatformNavCounts = {
	feedback?: number | null;
	notifications?: number | null;
};

export function PlatformNav(props: {
	counts?: PlatformNavCounts;
	current: PlatformRoute;
}) {
	const activeRoute =
		props.current === "account" ||
		props.current === "access" ||
		props.current === "agents"
			? "workspace"
			: props.current;
	const current = (route: PlatformRoute) =>
		activeRoute === route
			? { "data-current": "true", "aria-current": "page" as const }
			: {};
	const link = (item: NavItem) => (
		<a key={item.route} href={item.href} {...current(item.route)}>
			<span>{item.label}</span>
			{item.badge ? (
				<PlatformNavBadge badge={item.badge} counts={props.counts} />
			) : null}
		</a>
	);
	return (
		<nav
			className="platform-nav"
			data-platform-nav="primary"
			aria-label="Platform"
		>
			<a href="/" {...current("home")}>
				<span>Home</span>
			</a>
			<span className="platform-nav-rule" aria-hidden="true" />
			{LOOP_ITEMS.map((item, index) => (
				<React.Fragment key={item.route}>
					{index > 0 ? (
						<span className="platform-nav-step" aria-hidden="true">
							→
						</span>
					) : null}
					{link(item)}
				</React.Fragment>
			))}
			<span className="platform-nav-rule" aria-hidden="true" />
			{PLACE_ITEMS.map(link)}
			<a
				className="platform-nav-annotate"
				href="/annotate"
				{...current("annotate")}
			>
				<span>Annotate</span>
			</a>
		</nav>
	);
}

function PlatformNavBadge(props: {
	badge: "notifications" | "feedback";
	counts?: PlatformNavCounts;
}) {
	const id =
		props.badge === "notifications"
			? "platformInboxBadge"
			: "platformFeedbackBadge";
	const dataAttribute =
		props.badge === "notifications"
			? { "data-live-notification-count": "" }
			: { "data-live-feedback-count": "" };
	const count =
		props.badge === "notifications"
			? props.counts?.notifications
			: props.counts?.feedback;
	const hasCount = typeof count === "number" && count > 0;
	return (
		<span
			className="platform-nav-badge"
			id={id}
			hidden={!hasCount}
			{...dataAttribute}
		>
			{hasCount ? count : null}
		</span>
	);
}
