import { createStore, type StoreApi } from "zustand/vanilla";

export type ShipletsState = {
	search: string;
	selectedOrganizationId: string;
	selectedProjectIds: string[];
	visibleProjectIds: string[];
	setSearch: (search: string) => void;
	setSelectedOrganizationId: (organizationId: string) => void;
	setVisibleProjectIds: (projectIds: string[]) => void;
	toggleProjectSelection: (projectId: string) => void;
	toggleAllVisibleProjectSelections: () => void;
	clearSelection: () => void;
};

export type ShipletsStore = StoreApi<ShipletsState>;

export type ShipletsStoreInitialState = Partial<
	Pick<
		ShipletsState,
		| "search"
		| "selectedOrganizationId"
		| "selectedProjectIds"
		| "visibleProjectIds"
	>
>;

export function createShipletsStore(
	initialState: ShipletsStoreInitialState = {},
) {
	const visibleProjectIds = uniqueIds(initialState.visibleProjectIds || []);
	const selectedProjectIds = pruneSelectedIds(
		uniqueIds(initialState.selectedProjectIds || []),
		visibleProjectIds,
	);

	return createStore<ShipletsState>((set, get) => ({
		search: initialState.search || "",
		selectedOrganizationId: initialState.selectedOrganizationId || "",
		selectedProjectIds,
		visibleProjectIds,
		setSearch: (search) => set({ search }),
		setSelectedOrganizationId: (selectedOrganizationId) =>
			set({ selectedOrganizationId }),
		setVisibleProjectIds: (nextProjectIds) => {
			const nextVisibleProjectIds = uniqueIds(nextProjectIds);
			set((state) => ({
				visibleProjectIds: nextVisibleProjectIds,
				selectedProjectIds: pruneSelectedIds(
					state.selectedProjectIds,
					nextVisibleProjectIds,
				),
			}));
		},
		toggleProjectSelection: (projectId) => {
			const state = get();
			if (!state.visibleProjectIds.includes(projectId)) return;
			const selected = new Set(state.selectedProjectIds);
			if (selected.has(projectId)) {
				selected.delete(projectId);
			} else {
				selected.add(projectId);
			}
			set({
				selectedProjectIds: pruneSelectedIds(
					Array.from(selected),
					state.visibleProjectIds,
				),
			});
		},
		toggleAllVisibleProjectSelections: () => {
			const state = get();
			if (!state.visibleProjectIds.length) {
				set({ selectedProjectIds: [] });
				return;
			}
			const selectedVisibleCount = pruneSelectedIds(
				state.selectedProjectIds,
				state.visibleProjectIds,
			).length;
			set({
				selectedProjectIds:
					selectedVisibleCount === state.visibleProjectIds.length
						? []
						: state.visibleProjectIds,
			});
		},
		clearSelection: () => set({ selectedProjectIds: [] }),
	}));
}

export function shipletsSelectionSnapshot(
	state: Pick<ShipletsState, "selectedProjectIds" | "visibleProjectIds">,
) {
	const selectedProjectIds = pruneSelectedIds(
		state.selectedProjectIds,
		state.visibleProjectIds,
	);
	const selectedCount = selectedProjectIds.length;
	const allSelected =
		state.visibleProjectIds.length > 0 &&
		selectedCount === state.visibleProjectIds.length;

	return {
		allSelected,
		bulkArchiveDisabled: selectedCount === 0,
		selectedCount,
		selectedLabel: `${selectedCount} selected`,
		someSelected:
			selectedCount > 0 && selectedCount < state.visibleProjectIds.length,
	};
}

function uniqueIds(ids: string[]) {
	return Array.from(new Set(ids.filter(Boolean)));
}

function pruneSelectedIds(selectedIds: string[], visibleIds: string[]) {
	const visible = new Set(visibleIds);
	return uniqueIds(selectedIds).filter((projectId) => visible.has(projectId));
}
