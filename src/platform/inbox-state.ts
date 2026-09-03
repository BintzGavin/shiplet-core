import { createStore } from "zustand/vanilla";

export type InboxStoreState = {
	route: "inbox";
	selectedNotificationId: string | null;
	setSelectedNotificationId: (notificationId: string | null) => void;
};

export type InboxState = InboxStoreState;

export type InboxStore = ReturnType<typeof createInboxStore>;

export type InboxStoreInitialState = {
	selectedNotificationId?: string | null;
};

export function createInboxStore(initialState: InboxStoreInitialState = {}) {
	return createStore<InboxStoreState>((set) => ({
		route: "inbox",
		selectedNotificationId: initialState.selectedNotificationId || null,
		setSelectedNotificationId: (notificationId) =>
			set({ selectedNotificationId: notificationId }),
	}));
}
