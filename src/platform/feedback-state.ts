import { createStore, type StoreApi } from "zustand/vanilla";

export type FeedbackFilters = {
	projectId: string | null;
	status: string | null;
	mentionedMe: boolean;
	watched: boolean;
	submittedByMe: boolean;
};

export type FeedbackState = {
	filters: FeedbackFilters;
	selectedTicketId: string | null;
	setFilter: <K extends keyof FeedbackFilters>(
		filter: K,
		value: FeedbackFilters[K],
	) => void;
	setFilters: (filters: FeedbackFilters) => void;
	setSelectedTicketId: (ticketId: string | null) => void;
};

export type FeedbackStore = StoreApi<FeedbackState>;

export type FeedbackStoreInitialState = Partial<
	Pick<FeedbackState, "filters" | "selectedTicketId">
>;

const DEFAULT_FILTERS: FeedbackFilters = {
	projectId: null,
	status: null,
	mentionedMe: false,
	watched: false,
	submittedByMe: false,
};

export function createFeedbackStore(
	initialState: FeedbackStoreInitialState = {},
) {
	return createStore<FeedbackState>((set) => ({
		filters: normalizeFeedbackFilters(initialState.filters || DEFAULT_FILTERS),
		selectedTicketId: initialState.selectedTicketId || null,
		setFilter: (filter, value) =>
			set((state) => ({
				filters: normalizeFeedbackFilters({
					...state.filters,
					[filter]: value,
				}),
			})),
		setFilters: (filters) =>
			set({ filters: normalizeFeedbackFilters(filters) }),
		setSelectedTicketId: (selectedTicketId) => set({ selectedTicketId }),
	}));
}

export function normalizeFeedbackFilters(
	filters: FeedbackFilters,
): FeedbackFilters {
	return {
		projectId: filters.projectId || null,
		status: filters.status || null,
		mentionedMe: Boolean(filters.mentionedMe),
		watched: Boolean(filters.watched),
		submittedByMe: Boolean(filters.submittedByMe),
	};
}
