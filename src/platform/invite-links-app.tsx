/// <reference lib="dom" />

import * as React from "react";
import {
	QueryClient,
	QueryClientProvider,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useStore } from "zustand";

import {
	buildCreateRequest,
	createInviteLinksStore,
	describeAudience,
	describeExpiry,
	describeUses,
	destinationLabel,
	formatDateLabel,
	sortInviteLinks,
	statusStamp,
	type InviteLinkDraft,
	type InviteLinkExpiresPreset,
	type InviteLinkUsesPreset,
	type InviteLinksState,
	type InviteLinksStore,
} from "./invite-links-state";
import {
	inviteLinkEndpoint,
	inviteLinksEndpoint,
	type CreateInviteLinkRequest,
	type InviteLinkListResponse,
	type InviteLinkResponse,
	type InviteLinkView,
	type WorkspaceInviteLinksSeed,
} from "./invite-links-types";

export type InviteLinksAppProps = {
	seed: WorkspaceInviteLinksSeed;
};

type TeamOption = {
	id: string;
	name: string;
};

type PendingInviteLink = {
	organizationId: string;
	link: InviteLinkView;
};

type FocusRequest =
	| { kind: "copy" | "revoke" | "row"; linkId: string }
	| { kind: "create" };

type CreateVariables = {
	organizationId: string;
	pendingId: string;
	request: CreateInviteLinkRequest;
	draft: InviteLinkDraft;
};

type RevokeVariables = {
	organizationId: string;
	linkId: string;
	previous: InviteLinkView;
};

const USES_OPTIONS: Array<{ value: InviteLinkUsesPreset; label: string }> = [
	{ value: "unlimited", label: "Unlimited" },
	{ value: "1", label: "1 use" },
	{ value: "5", label: "5 uses" },
	{ value: "10", label: "10 uses" },
	{ value: "25", label: "25 uses" },
	{ value: "custom", label: "Custom" },
];

const EXPIRES_OPTIONS: Array<{
	value: InviteLinkExpiresPreset;
	label: string;
}> = [
	{ value: "never", label: "Never" },
	{ value: "7", label: "In 7 days" },
	{ value: "30", label: "In 30 days" },
	{ value: "90", label: "In 90 days" },
];

const INVITE_LINKS_STALE_MS = 30_000;
const COPIED_RESET_MS = 1200;
const DAY_MS = 24 * 60 * 60 * 1000;
const CREATE_ERROR_FALLBACK = "Couldn't create the link. Try again.";
const REVOKE_ERROR_MESSAGE = "Couldn't revoke this link. Try again.";

const InviteLinksStoreContext = React.createContext<InviteLinksStore | null>(
	null,
);

export function inviteLinksQueryKey(organizationId: string) {
	return ["invite-links", organizationId] as const;
}

export function InviteLinksApp(props: InviteLinksAppProps) {
	const [queryClient] = React.useState(() =>
		createInviteLinksQueryClient(props.seed),
	);
	const storeRef = React.useRef<InviteLinksStore | null>(null);

	if (!storeRef.current) {
		storeRef.current = createInviteLinksStore({
			selectedOrganizationId: initialOrganizationId(props.seed),
		});
	}

	return (
		<QueryClientProvider client={queryClient}>
			<InviteLinksStoreContext.Provider value={storeRef.current}>
				<InviteLinksPanel seed={props.seed} />
			</InviteLinksStoreContext.Provider>
		</QueryClientProvider>
	);
}

function InviteLinksPanel(props: { seed: WorkspaceInviteLinksSeed }) {
	const { seed } = props;
	const queryClient = useQueryClient();
	const store = useInviteLinksStoreApi();
	const selectedOrganizationId = useInviteLinksStore(
		(state) => state.selectedOrganizationId,
	);
	const draft = useInviteLinksStore((state) => state.draft);
	const copiedLinkId = useInviteLinksStore((state) => state.copiedLinkId);
	const confirmingRevokeLinkId = useInviteLinksStore(
		(state) => state.confirmingRevokeLinkId,
	);
	const formError = useInviteLinksStore((state) => state.formError);
	const setDraft = useInviteLinksStore((state) => state.setDraft);

	const organization =
		seed.organizations.find(
			(candidate) => candidate.id === selectedOrganizationId,
		) ||
		seed.organizations[0] ||
		null;
	const organizationId = organization?.id || "";
	const isAdministrator = isAdministratorRole(
		seed.rolesByOrganization[organizationId],
	);

	const [observedTeams, setObservedTeams] = React.useState<
		Record<string, TeamOption[]>
	>({});
	const [pendingLinks, setPendingLinks] = React.useState<PendingInviteLink[]>(
		[],
	);
	const [revokeFailedLinkIds, setRevokeFailedLinkIds] = React.useState<
		string[]
	>([]);
	const [announcement, setAnnouncement] = React.useState("");
	// Set when the workspace switcher selects an organization the server did
	// not render (for example one just created on this page).
	const [unknownOrganizationSelected, setUnknownOrganizationSelected] =
		React.useState(false);
	const [focusRequest, setFocusRequest] = React.useState<FocusRequest | null>(
		null,
	);
	const sectionRef = React.useRef<HTMLElement>(null);
	const createButtonRef = React.useRef<HTMLButtonElement>(null);
	const pendingCounterRef = React.useRef(0);
	const createInFlightRef = React.useRef(false);
	const copiedTimerRef = React.useRef<number | undefined>(undefined);

	const knownOrganizationIds = React.useMemo(
		() => new Set(seed.organizations.map((candidate) => candidate.id)),
		[seed.organizations],
	);
	const teams = React.useMemo(
		() =>
			mergeTeamOptions(
				seed.teamsByOrganization[organizationId] || [],
				observedTeams[organizationId] || [],
			),
		[observedTeams, organizationId, seed.teamsByOrganization],
	);
	const destination =
		draft.destination !== "organization" &&
		teams.some((team) => team.id === draft.destination)
			? draft.destination
			: "organization";

	const linksQuery = useQuery({
		queryKey: inviteLinksQueryKey(organizationId),
		queryFn: ({ signal }) => fetchInviteLinks(organizationId, signal),
		initialData: () => ({
			links: seed.linksByOrganization[organizationId] || [],
		}),
		enabled: isAdministrator,
		staleTime: INVITE_LINKS_STALE_MS,
		refetchOnWindowFocus: true,
		retry: false,
	});
	const links = linksQuery.data.links;
	const sortedLinks = React.useMemo(() => sortInviteLinks(links), [links]);
	const visiblePendingLinks = pendingLinks.filter(
		(entry) => entry.organizationId === organizationId,
	);

	const announce = React.useCallback((message: string) => {
		// Re-announce a repeated message by changing the text node slightly.
		setAnnouncement((current) =>
			current === message ? `${message}\u00a0` : message,
		);
	}, []);

	const createMutation = useMutation({
		mutationFn: (variables: CreateVariables) =>
			createInviteLink(variables.organizationId, variables.request),
		onSuccess: async (body, variables) => {
			const queryKey = inviteLinksQueryKey(variables.organizationId);
			await queryClient.cancelQueries({ queryKey });
			queryClient.setQueryData<InviteLinkListResponse>(
				queryKey,
				(current) => ({
					links: upsertInviteLink(current?.links || [], body.link),
				}),
			);
			setPendingLinks((current) =>
				current.filter((entry) => entry.link.id !== variables.pendingId),
			);
			const state = store.getState();
			state.setFormError(null);
			announce("Link created");
			// Only finish the flow for someone still waiting on it: edits made
			// while the request was in flight are kept, and focus stays put.
			if (state.draft !== variables.draft) return;
			state.resetDraft();
			const focusInSection = Boolean(
				sectionRef.current?.contains(document.activeElement),
			);
			if (
				state.selectedOrganizationId === variables.organizationId &&
				(focusInSection || focusIsLost())
			) {
				setFocusRequest({ kind: "copy", linkId: body.link.id });
			} else if (focusIsLost()) {
				setFocusRequest({ kind: "create" });
			}
		},
		onError: (error, variables) => {
			setPendingLinks((current) =>
				current.filter((entry) => entry.link.id !== variables.pendingId),
			);
			store.getState().setFormError(createErrorMessage(error));
			if (focusIsLost()) setFocusRequest({ kind: "create" });
		},
		onSettled: () => {
			createInFlightRef.current = false;
		},
	});

	const { mutate: revokeLink } = useMutation({
		mutationFn: (variables: RevokeVariables) =>
			revokeInviteLink(variables.organizationId, variables.linkId),
		onSuccess: async (body, variables) => {
			const queryKey = inviteLinksQueryKey(variables.organizationId);
			await queryClient.cancelQueries({ queryKey });
			queryClient.setQueryData<InviteLinkListResponse>(queryKey, (current) =>
				current
					? { links: replaceInviteLink(current.links, body.link) }
					: current,
			);
			announce("Link revoked");
		},
		onError: (_error, variables) => {
			queryClient.setQueryData<InviteLinkListResponse>(
				inviteLinksQueryKey(variables.organizationId),
				(current) =>
					current
						? { links: replaceInviteLink(current.links, variables.previous) }
						: current,
			);
			setRevokeFailedLinkIds((current) =>
				current.includes(variables.linkId)
					? current
					: [...current, variables.linkId],
			);
		},
	});

	// Follow the vanilla workspace switcher. Options arrive after its own
	// dashboard fetch and are set without a change event, so watch both.
	React.useEffect(() => {
		const select = document.getElementById("organizationSelect");
		if (!(select instanceof HTMLSelectElement)) return;
		const adoptSelectedOrganization = () => {
			const value = select.value;
			const state = store.getState();
			if (!value) return;
			if (!knownOrganizationIds.has(value)) {
				setUnknownOrganizationSelected(true);
				return;
			}
			setUnknownOrganizationSelected(false);
			if (value === state.selectedOrganizationId) return;
			state.setSelectedOrganizationId(value);
			state.setConfirmingRevokeLinkId(null);
			state.setFormError(null);
		};
		adoptSelectedOrganization();
		select.addEventListener("change", adoptSelectedOrganization);
		const observer = new MutationObserver(adoptSelectedOrganization);
		observer.observe(select, { childList: true });
		return () => {
			select.removeEventListener("change", adoptSelectedOrganization);
			observer.disconnect();
		};
	}, [knownOrganizationIds, store]);

	// Pick up teams created in the vanilla Teams section without a reload.
	React.useEffect(() => {
		const teamSelect = document.getElementById("teamInviteSelect");
		if (!(teamSelect instanceof HTMLSelectElement)) return;
		const collectTeams = () => {
			// The vanilla runtime fills this select for the organization shown
			// in its own switcher, so file the teams under that organization.
			const organizationSelect = document.getElementById("organizationSelect");
			const teamOrganizationId =
				(organizationSelect instanceof HTMLSelectElement &&
					organizationSelect.value) ||
				store.getState().selectedOrganizationId;
			if (!teamOrganizationId) return;
			const options = Array.from(teamSelect.options, (option) => ({
				id: option.value,
				name: (option.textContent || "").trim(),
			})).filter((team) => team.id && team.name);
			if (!options.length) return;
			setObservedTeams((current) => {
				const previous = current[teamOrganizationId] || [];
				const merged = mergeTeamOptions(previous, options);
				return merged.length === previous.length
					? current
					: { ...current, [teamOrganizationId]: merged };
			});
		};
		collectTeams();
		const observer = new MutationObserver(collectTeams);
		observer.observe(teamSelect, { childList: true });
		return () => observer.disconnect();
	}, [store]);

	const createPending = createMutation.isPending;
	React.useEffect(() => {
		if (!focusRequest) return;
		const section = sectionRef.current;
		let target: HTMLElement | null = null;
		if (focusRequest.kind === "create") {
			target = createButtonRef.current;
		} else if (section) {
			const row = findInviteLinkRow(section, focusRequest.linkId);
			target =
				focusRequest.kind === "row" || !row
					? row
					: row.querySelector<HTMLElement>(
							focusRequest.kind === "copy"
								? "[data-invite-link-copy]"
								: "[data-invite-link-revoke]",
						);
		}
		// Mutation callbacks run before React Query marks the mutation settled,
		// so the Create button can still be disabled here; retry once it is not.
		if (target instanceof HTMLButtonElement && target.disabled) return;
		setFocusRequest(null);
		target?.focus();
	}, [focusRequest, createPending]);

	React.useEffect(
		() => () => {
			window.clearTimeout(copiedTimerRef.current);
		},
		[],
	);

	const copyLink = React.useCallback(
		async (link: InviteLinkView) => {
			let copied = false;
			try {
				if (navigator.clipboard && window.isSecureContext) {
					await navigator.clipboard.writeText(link.url);
					copied = true;
				} else {
					copied = fallbackCopy(link.url);
				}
			} catch {
				copied = fallbackCopy(link.url);
			}
			if (!copied) {
				announce("Couldn't copy. Select the link and copy it.");
				return;
			}
			store.getState().setCopiedLinkId(link.id);
			announce("Link copied");
			window.clearTimeout(copiedTimerRef.current);
			copiedTimerRef.current = window.setTimeout(() => {
				if (store.getState().copiedLinkId === link.id) {
					store.getState().setCopiedLinkId(null);
				}
			}, COPIED_RESET_MS);
		},
		[announce, store],
	);

	const startRevoke = React.useCallback(
		(link: InviteLinkView) => {
			store.getState().setConfirmingRevokeLinkId(link.id);
		},
		[store],
	);

	const cancelRevoke = React.useCallback(
		(link: InviteLinkView) => {
			store.getState().setConfirmingRevokeLinkId(null);
			setFocusRequest({ kind: "revoke", linkId: link.id });
		},
		[store],
	);

	const confirmRevoke = React.useCallback(
		(link: InviteLinkView) => {
			const queryKey = inviteLinksQueryKey(organizationId);
			// Cancelling reverts any in-flight refetch synchronously, so the
			// optimistic write below cannot be overwritten by stale data.
			void queryClient.cancelQueries({ queryKey });
			const previous =
				queryClient
					.getQueryData<InviteLinkListResponse>(queryKey)
					?.links.find((candidate) => candidate.id === link.id) || link;
			const revokedOn = new Date().toISOString();
			queryClient.setQueryData<InviteLinkListResponse>(queryKey, (current) =>
				current
					? {
							links: current.links.map((candidate) =>
								candidate.id === link.id
									? {
											...candidate,
											status: "revoked",
											revoked_on: revokedOn,
										}
									: candidate,
							),
						}
					: current,
			);
			setRevokeFailedLinkIds((current) =>
				current.filter((linkId) => linkId !== link.id),
			);
			const state = store.getState();
			state.setConfirmingRevokeLinkId(null);
			if (state.copiedLinkId === link.id) state.setCopiedLinkId(null);
			setFocusRequest({ kind: "row", linkId: link.id });
			revokeLink({ organizationId, linkId: link.id, previous });
		},
		[organizationId, queryClient, revokeLink, store],
	);

	function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (
			!isAdministrator ||
			unknownOrganizationSelected ||
			createInFlightRef.current
		) {
			return;
		}
		const state = store.getState();
		const result = buildCreateRequest({ ...state.draft, destination });
		if ("error" in result) {
			state.setFormError(result.error);
			return;
		}
		state.setFormError(null);
		createInFlightRef.current = true;
		pendingCounterRef.current += 1;
		const pendingId = `pending-${pendingCounterRef.current}`;
		const teamName = result.request.teamId
			? teams.find((team) => team.id === result.request.teamId)?.name || null
			: null;
		const placeholder = buildPendingInviteLink({
			id: pendingId,
			organizationId,
			request: result.request,
			teamName,
			now: Date.now(),
		});
		setPendingLinks((current) => [
			{ organizationId, link: placeholder },
			...current,
		]);
		createMutation.mutate({
			organizationId,
			pendingId,
			request: result.request,
			draft: state.draft,
		});
	}

	if (!organization) return null;

	return (
		<section
			className="success-card shiplet-panel"
			id="inviteLinks"
			data-invite-links-organization={organizationId}
			ref={sectionRef}
		>
			<div className="dashboard-section-header">
				<div>
					<span className="success-card-label">Gangway</span>
					<h2>Invite links</h2>
					<p>
						{`Share one link to bring people into ${
							unknownOrganizationSelected
								? "an organization"
								: organization.name
						} or one of its teams. Choose how many times it can be used, or reserve it for specific emails.`}
					</p>
				</div>
				{isAdministrator && linksQuery.isError ? (
					<span className="live-status live-status-error">
						Couldn't refresh links
					</span>
				) : null}
			</div>
			{unknownOrganizationSelected ? (
				<p className="form-help" id="inviteLinksReloadNote">
					Reload the page to manage invite links for the organization you
					just selected. <a href="/workspace">Reload</a>
				</p>
			) : isAdministrator ? (
				<>
					<form
						id="inviteLinkForm"
						className="invite-link-form"
						noValidate
						onSubmit={handleSubmit}
					>
						<div className="settings-form-grid">
							<div className="form-group">
								<label htmlFor="inviteLinkDestination">Invite to</label>
								<select
									id="inviteLinkDestination"
									value={destination}
									onChange={(event) =>
										setDraft({ destination: event.currentTarget.value })
									}
								>
									<option value="organization">Whole organization</option>
									{teams.map((team) => (
										<option key={team.id} value={team.id}>
											{team.name}
										</option>
									))}
								</select>
							</div>
							<div className="form-group">
								<label htmlFor="inviteLinkUses">Uses</label>
								<select
									id="inviteLinkUses"
									value={draft.usesPreset}
									onChange={(event) =>
										setDraft({
											usesPreset: event.currentTarget
												.value as InviteLinkUsesPreset,
										})
									}
								>
									{USES_OPTIONS.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</select>
							</div>
							{draft.usesPreset === "custom" ? (
								<div className="form-group">
									<label htmlFor="inviteLinkCustomUses">Number of uses</label>
									<input
										id="inviteLinkCustomUses"
										type="text"
										inputMode="numeric"
										pattern="[0-9]*"
										autoComplete="off"
										value={draft.customUses}
										onChange={(event) =>
											setDraft({ customUses: event.currentTarget.value })
										}
									/>
								</div>
							) : null}
							<div className="form-group">
								<label htmlFor="inviteLinkExpires">Expires</label>
								<select
									id="inviteLinkExpires"
									value={draft.expiresPreset}
									onChange={(event) =>
										setDraft({
											expiresPreset: event.currentTarget
												.value as InviteLinkExpiresPreset,
										})
									}
								>
									{EXPIRES_OPTIONS.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</select>
							</div>
						</div>
						<div className="form-group">
							<label htmlFor="inviteLinkEmails">Only these emails (optional)</label>
							<textarea
								id="inviteLinkEmails"
								rows={2}
								autoCapitalize="none"
								autoComplete="off"
								spellCheck={false}
								placeholder="teammate@example.com"
								aria-describedby="inviteLinkEmailsHelp"
								value={draft.allowedEmailsText}
								onChange={(event) =>
									setDraft({ allowedEmailsText: event.currentTarget.value })
								}
							/>
							<span className="form-help" id="inviteLinkEmailsHelp">
								Comma or line separated. Leave empty to let anyone with the
								link join.
							</span>
						</div>
						<button
							id="inviteLinkCreate"
							ref={createButtonRef}
							className="btn btn-primary btn-sm"
							type="submit"
							disabled={createMutation.isPending}
							aria-busy={createMutation.isPending ? "true" : undefined}
						>
							Create link
						</button>
					</form>
					{formError ? (
						<div id="inviteLinkError" className="banner banner-error" role="alert">
							{formError}
						</div>
					) : null}
					{sortedLinks.length || visiblePendingLinks.length ? (
						<ul className="invite-links-list" id="inviteLinkList">
							{visiblePendingLinks.map((entry) => (
								<PendingInviteLinkRow key={entry.link.id} link={entry.link} />
							))}
							{sortedLinks.map((link) => (
								<InviteLinkRow
									key={link.id}
									link={link}
									copied={copiedLinkId === link.id}
									confirming={confirmingRevokeLinkId === link.id}
									revokeFailed={revokeFailedLinkIds.includes(link.id)}
									onCopy={copyLink}
									onRevoke={startRevoke}
									onConfirmRevoke={confirmRevoke}
									onCancelRevoke={cancelRevoke}
								/>
							))}
						</ul>
					) : (
						<p className="invite-links-empty">
							No invite links yet. Create one to share with your team.
						</p>
					)}
				</>
			) : (
				<p className="form-help">
					Only organization administrators can create invite links.
				</p>
			)}
			<span className="sr-only" aria-live="polite">
				{announcement}
			</span>
		</section>
	);
}

function InviteLinkRow(props: {
	link: InviteLinkView;
	copied: boolean;
	confirming: boolean;
	revokeFailed: boolean;
	onCopy: (link: InviteLinkView) => Promise<void>;
	onRevoke: (link: InviteLinkView) => void;
	onConfirmRevoke: (link: InviteLinkView) => void;
	onCancelRevoke: (link: InviteLinkView) => void;
}) {
	const { link } = props;
	const stamp = statusStamp(link);
	const redemptions = link.redemptions || [];
	const keepButtonRef = React.useRef<HTMLButtonElement>(null);
	const promptId = `inviteLinkRevokePrompt-${link.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
	const createdBy = link.created_by?.email;

	React.useEffect(() => {
		// Focus the safe choice so a repeated key press cannot revoke.
		if (props.confirming) keepButtonRef.current?.focus();
	}, [props.confirming]);

	return (
		<li
			className="invite-link-row"
			data-invite-link-id={link.id}
			data-status={link.status}
			tabIndex={-1}
		>
			<div className="invite-link-row-main">
				<div className="invite-link-row-title">
					<strong>{destinationLabel(link)}</strong>
					<span className={`status-badge status-${stamp.tone}`}>
						{stamp.label}
					</span>
				</div>
				<code className="invite-link-url">{link.url}</code>
				<span className="invite-link-meta">
					<span>{describeUses(link)}</span>
					<span>{describeAudience(link)}</span>
					<span>{describeExpiry(link)}</span>
					<span>
						{createdBy
							? `Created ${formatDateLabel(link.created_on)} by ${createdBy}`
							: `Created ${formatDateLabel(link.created_on)}`}
					</span>
				</span>
				{redemptions.length ? (
					<details className="invite-link-redemptions">
						<summary>{`Who used it (${redemptions.length})`}</summary>
						<ul>
							{redemptions.map((redemption) => (
								<li key={`${redemption.user_id}:${redemption.redeemed_on}`}>
									{redemption.email}
									<span aria-hidden="true"> · </span>
									{formatDateLabel(redemption.redeemed_on)}
								</li>
							))}
						</ul>
					</details>
				) : null}
			</div>
			{link.status === "active" ? (
				<div
					className="invite-link-row-actions"
					onKeyDown={(event) => {
						if (!props.confirming || event.key !== "Escape") return;
						event.preventDefault();
						event.stopPropagation();
						props.onCancelRevoke(link);
					}}
				>
					{props.confirming ? (
						<>
							<span className="invite-link-revoke-prompt" id={promptId}>
								Revoke this link? People who already joined keep access.
							</span>
							<button
								type="button"
								className="btn btn-destructive btn-sm"
								data-invite-link-revoke-confirm
								aria-describedby={promptId}
								onClick={() => props.onConfirmRevoke(link)}
							>
								Revoke link
							</button>
							<button
								type="button"
								className="btn btn-secondary btn-sm"
								data-invite-link-revoke-cancel
								ref={keepButtonRef}
								onClick={() => props.onCancelRevoke(link)}
							>
								Keep link
							</button>
						</>
					) : (
						<>
							<button
								type="button"
								className={`btn btn-secondary btn-sm${props.copied ? " is-copied" : ""}`}
								data-invite-link-copy
								onClick={() => void props.onCopy(link)}
							>
								{props.copied ? "Copied" : "Copy"}
							</button>
							<button
								type="button"
								className="btn btn-secondary btn-sm"
								data-invite-link-revoke
								onClick={() => props.onRevoke(link)}
							>
								Revoke
							</button>
						</>
					)}
				</div>
			) : null}
			{props.revokeFailed ? (
				<div
					className="banner banner-error invite-link-row-error"
					role="alert"
				>
					{REVOKE_ERROR_MESSAGE}
				</div>
			) : null}
		</li>
	);
}

function PendingInviteLinkRow(props: { link: InviteLinkView }) {
	const { link } = props;
	return (
		<li
			className="invite-link-row"
			data-invite-link-id={link.id}
			data-pending="true"
		>
			<div className="invite-link-row-main">
				<div className="invite-link-row-title">
					<strong>{destinationLabel(link)}</strong>
				</div>
				<span className="invite-link-url-skeleton" aria-hidden="true" />
				<span className="sr-only">Creating link</span>
				<span className="invite-link-meta">
					<span>{describeUses(link)}</span>
					<span>{describeAudience(link)}</span>
					<span>{describeExpiry(link)}</span>
				</span>
			</div>
		</li>
	);
}

function useInviteLinksStoreApi() {
	const store = React.useContext(InviteLinksStoreContext);
	if (!store) {
		throw new Error("Invite links store is not available.");
	}
	return store;
}

function useInviteLinksStore<T>(selector: (state: InviteLinksState) => T) {
	return useStore(useInviteLinksStoreApi(), selector);
}

function createInviteLinksQueryClient(seed: WorkspaceInviteLinksSeed) {
	const client = new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: INVITE_LINKS_STALE_MS,
				// Keep every organization's list for the life of the page so
				// switching back never falls back to the first-paint seed.
				gcTime: Number.POSITIVE_INFINITY,
				refetchOnWindowFocus: true,
				retry: false,
			},
		},
	});
	for (const organization of seed.organizations) {
		if (!isAdministratorRole(seed.rolesByOrganization[organization.id])) {
			continue;
		}
		const links = seed.linksByOrganization[organization.id];
		client.setQueryData<InviteLinkListResponse>(
			inviteLinksQueryKey(organization.id),
			{ links: links || [] },
			// A missing seed entry is shown as empty but refreshed right away.
			links ? undefined : { updatedAt: 0 },
		);
	}
	return client;
}

function initialOrganizationId(seed: WorkspaceInviteLinksSeed) {
	const selected = seed.organizations.find(
		(organization) => organization.id === seed.selectedOrganizationId,
	);
	return (selected || seed.organizations[0])?.id || "";
}

function isAdministratorRole(role: string | undefined) {
	const normalized = (role || "").trim().toLowerCase();
	return normalized === "admin" || normalized === "owner";
}

function mergeTeamOptions(base: TeamOption[], extra: TeamOption[]) {
	const merged = [...base];
	const knownIds = new Set(base.map((team) => team.id));
	for (const team of extra) {
		if (knownIds.has(team.id)) continue;
		knownIds.add(team.id);
		merged.push(team);
	}
	return merged;
}

function upsertInviteLink(links: InviteLinkView[], link: InviteLinkView) {
	return links.some((candidate) => candidate.id === link.id)
		? replaceInviteLink(links, link)
		: [link, ...links];
}

function replaceInviteLink(links: InviteLinkView[], link: InviteLinkView) {
	return links.map((candidate) => (candidate.id === link.id ? link : candidate));
}

function buildPendingInviteLink(options: {
	id: string;
	organizationId: string;
	request: CreateInviteLinkRequest;
	teamName: string | null;
	now: number;
}): InviteLinkView {
	const expiresInDays = options.request.expiresInDays ?? null;
	return {
		id: options.id,
		organization_id: options.organizationId,
		team_id: options.request.teamId ?? null,
		team_name: options.teamName,
		url: "",
		max_uses: options.request.maxUses ?? null,
		use_count: 0,
		allowed_emails: options.request.allowedEmails || [],
		expires_on: expiresInDays
			? new Date(options.now + expiresInDays * DAY_MS).toISOString()
			: null,
		created_by: { id: "", email: "" },
		created_on: new Date(options.now).toISOString(),
		revoked_on: null,
		status: "active",
		redemptions: [],
	};
}

function findInviteLinkRow(section: HTMLElement, linkId: string) {
	return (
		Array.from(
			section.querySelectorAll<HTMLElement>("[data-invite-link-id]"),
		).find((row) => row.dataset.inviteLinkId === linkId) || null
	);
}

function focusIsLost() {
	const active = document.activeElement;
	return !active || active === document.body;
}

class InviteLinkRequestError extends Error {
	readonly readableMessage: string | null;

	constructor(readableMessage: string | null) {
		super(readableMessage || "Invite link request failed.");
		this.name = "InviteLinkRequestError";
		this.readableMessage = readableMessage;
	}
}

async function fetchInviteLinks(
	organizationId: string,
	signal?: AbortSignal,
): Promise<InviteLinkListResponse> {
	const response = await fetch(inviteLinksEndpoint(organizationId), {
		signal,
	});
	if (!response.ok) {
		throw new InviteLinkRequestError(null);
	}
	const body = (await response.json()) as Partial<InviteLinkListResponse>;
	if (!Array.isArray(body?.links)) {
		throw new InviteLinkRequestError(null);
	}
	return { links: body.links };
}

async function createInviteLink(
	organizationId: string,
	request: CreateInviteLinkRequest,
) {
	const response = await fetch(inviteLinksEndpoint(organizationId), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(request),
	});
	return readInviteLinkResponse(response);
}

async function revokeInviteLink(organizationId: string, linkId: string) {
	const response = await fetch(inviteLinkEndpoint(organizationId, linkId), {
		method: "DELETE",
	});
	return readInviteLinkResponse(response);
}

async function readInviteLinkResponse(
	response: Response,
): Promise<InviteLinkResponse> {
	if (!response.ok) {
		throw new InviteLinkRequestError(await readShortPlainText(response));
	}
	const body = (await response.json()) as Partial<InviteLinkResponse>;
	if (!body?.link || typeof body.link.id !== "string") {
		throw new InviteLinkRequestError(null);
	}
	return { link: body.link };
}

/** Server errors are shown only when they are a short, single line of plain text. */
async function readShortPlainText(response: Response) {
	if (response.status >= 500) return null;
	const contentType = (response.headers.get("content-type") || "").toLowerCase();
	if (contentType && !contentType.startsWith("text/plain")) return null;
	let text = "";
	try {
		text = (await response.text()).trim();
	} catch {
		return null;
	}
	if (!text || text.length > 160 || /[\r\n<>{}]/.test(text)) return null;
	return text;
}

function createErrorMessage(error: unknown) {
	return error instanceof InviteLinkRequestError && error.readableMessage
		? error.readableMessage
		: CREATE_ERROR_FALLBACK;
}

function fallbackCopy(value: string): boolean {
	const textarea = document.createElement("textarea");
	textarea.value = value;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.left = "-9999px";
	document.body.appendChild(textarea);
	textarea.select();
	let copied = false;
	try {
		copied = document.execCommand("copy");
	} catch {
		// The full link stays visible and selectable.
	}
	textarea.remove();
	return copied;
}
