import { useQuery } from "@tanstack/react-query";

import type { ReviewNotificationRecord } from "../notifications";
import type { ReviewFeedbackRecord } from "../review";

type NotificationsQueryResult = {
	notifications: ReviewNotificationRecord[];
};

type FeedbackQueryResult = {
	feedback: ReviewFeedbackRecord[];
};

export const PLATFORM_NOTIFICATIONS_QUERY_KEY = [
	"platform-counts",
	"notifications",
] as const;
export const PLATFORM_FEEDBACK_QUERY_KEY = [
	"platform-counts",
	"feedback",
] as const;

export function usePlatformCounts(options: {
	initialFeedback?: ReviewFeedbackRecord[];
	initialNotifications?: ReviewNotificationRecord[];
} = {}) {
	const notificationsQuery = useQuery({
		queryKey: PLATFORM_NOTIFICATIONS_QUERY_KEY,
		queryFn: async () => {
			const response = await fetch("/api/notifications?limit=100");
			if (!response.ok) {
				throw new Error(`Failed to load notifications: ${response.status}`);
			}
			return (await response.json()) as NotificationsQueryResult;
		},
		initialData: options.initialNotifications
			? { notifications: options.initialNotifications }
			: undefined,
		refetchInterval: 15_000,
		refetchOnWindowFocus: true,
		staleTime: 10_000,
	});
	const feedbackQuery = useQuery({
		queryKey: PLATFORM_FEEDBACK_QUERY_KEY,
		queryFn: async () => {
			const response = await fetch("/api/feedback?limit=100");
			if (!response.ok) {
				throw new Error(`Failed to load feedback: ${response.status}`);
			}
			return (await response.json()) as FeedbackQueryResult;
		},
		initialData: options.initialFeedback
			? { feedback: options.initialFeedback }
			: undefined,
		refetchInterval: 15_000,
		refetchOnWindowFocus: true,
		staleTime: 10_000,
	});

	return {
		feedback: feedbackQuery.data?.feedback.length ?? null,
		notifications:
			notificationsQuery.data?.notifications.filter(
				(notification) => !notification.read_on,
			).length ?? null,
	};
}
