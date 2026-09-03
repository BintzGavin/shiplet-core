import * as React from "react";

export type PlatformRoute =
	| "publish"
	| "shiplets"
	| "feedback"
	| "inbox"
	| "workspace"
	| "access"
	| "agents"
	| "account";

const NAV_ITEMS: Array<{
	route: PlatformRoute;
	href: string;
	label: string;
	badge?: "notifications" | "feedback";
}> = [
	{ route: "publish", href: "/", label: "Prepare" },
	{ route: "shiplets", href: "/shiplets", label: "Shiplets" },
	{ route: "feedback", href: "/feedback", label: "Feedback", badge: "feedback" },
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
	return (
		<nav
			className="platform-nav"
			data-platform-nav="primary"
			aria-label="Platform"
		>
			{NAV_ITEMS.map((item) => (
				<a
					key={item.route}
					href={item.href}
					data-current={activeRoute === item.route ? "true" : undefined}
				>
					<span>{item.label}</span>
					{item.badge ? (
						<PlatformNavBadge badge={item.badge} counts={props.counts} />
					) : null}
				</a>
			))}
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
