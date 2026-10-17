import { describe, expect, it, vi } from "vitest";
import { ShipletController } from "../src/plugin-app/controller";
import type { ShipletHost } from "../src/plugin-app/host";
import type { PluginFeedbackDetail } from "../src/plugin-contract";

const shiplet = { id: "shiplet_one", name: "Test", reviewUrl: "https://example.test" };
const feedback = (id = "feedback_one"): PluginFeedbackDetail => ({
	id, shipletId: shiplet.id, title: "Test", status: "New", authorName: null,
	pageUrl: null, replyCount: 0, createdAt: null, url: "https://example.test/thread",
	comment: "Synthetic feedback", replies: [],
});
const page = (ids: string[], nextCursor: string | null) => ({
	view: "feedback", shiplet, feedback: ids.map(feedback), nextCursor,
});
const detail = (item = feedback()) => ({ view: "feedback-detail", shiplet, feedback: item });
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function setup() {
	const host: ShipletHost = {
		ready: Promise.resolve(), callTool: vi.fn(), openLink: vi.fn(), askChatGPT: vi.fn(),
		attachFeedback: vi.fn(async () => true), clearAttachedFeedback: vi.fn(async () => {}),
		requestFullscreen: vi.fn(), canReadFiles: () => false, readTextFile: vi.fn(),
	};
	const controller = new ShipletController();
	controller.setHost(host);
	controller.setHostView({ connection: "connected", displayMode: "fullscreen" });
	return { controller, host, call: vi.mocked(host.callTool), attach: vi.mocked(host.attachFeedback) };
}

describe("plugin feedback pagination", () => {
	it("continues the server cursor, retains earlier rows, and resets on refresh", async () => {
		const { controller, call } = setup();
		call.mockResolvedValueOnce(page(["a", "b"], "next")).mockResolvedValueOnce(page(["b", "c"], null));
		await controller.loadFeedback(shiplet.id, "open");
		await controller.loadMoreFeedback(shiplet.id);
		expect(call.mock.calls[1][1]).toMatchObject({ shiplet_id: shiplet.id, cursor: "next" });
		expect(controller.getState().feedbackList.data?.feedback.map(x => x.id)).toEqual(["a", "b", "c"]);
		expect(controller.getState().feedbackList.data?.nextCursor).toBeNull();
		await controller.loadMoreFeedback(shiplet.id);
		expect(call).toHaveBeenCalledTimes(2);
		call.mockResolvedValueOnce(page(["new"], "later"));
		await controller.loadFeedback(shiplet.id, "open");
		expect(controller.getState().feedbackList.data?.feedback.map(x => x.id)).toEqual(["new"]);
	});
	it("allows a failed page to be retried without losing the preceding page", async () => {
		const { controller, call } = setup();
		call.mockResolvedValueOnce(page(["a"], "next")).mockRejectedValueOnce(new Error("Unavailable"));
		await controller.loadFeedback(shiplet.id, "open");
		await controller.loadMoreFeedback(shiplet.id);
		expect(controller.getState().feedbackList.data?.feedback.map(x => x.id)).toEqual(["a"]);
		call.mockResolvedValueOnce(page(["b"], null));
		await controller.loadMoreFeedback(shiplet.id);
		expect(controller.getState().feedbackList.data?.feedback.map(x => x.id)).toEqual(["a", "b"]);
	});
	it("does not duplicate in-flight pages or append a late page to a changed filter", async () => {
		const { controller, call } = setup();
		call.mockResolvedValueOnce(page(["a"], "next"));
		await controller.loadFeedback(shiplet.id, "open");
		const pending = deferred<unknown>();
		call.mockReturnValueOnce(pending.promise);
		const more = controller.loadMoreFeedback(shiplet.id);
		await controller.loadMoreFeedback(shiplet.id);
		expect(call).toHaveBeenCalledTimes(2);
		call.mockResolvedValueOnce(page(["done"], null));
		await controller.loadFeedback(shiplet.id, "done");
		pending.resolve(page(["b"], null));
		await more;
		expect(controller.getState().feedbackList.data?.feedback.map(x => x.id)).toEqual(["done"]);
	});
});

describe("plugin attached model context", () => {
	it("refreshes after a confirmed status change, without publishing optimistic state", async () => {
		const { controller, call, attach } = setup();
		controller.handleToolResult(detail(), false);
		await tick();
		const pending = deferred<unknown>();
		call.mockReturnValueOnce(pending.promise);
		const change = controller.setStatus(feedback(), "Done");
		await tick();
		expect(attach).toHaveBeenCalledTimes(1);
		pending.resolve(detail({ ...feedback(), status: "Done" }));
		await change;
		await tick();
		expect(attach.mock.calls.at(-1)?.[0].feedback.status).toBe("Done");
		expect(attach).toHaveBeenCalledTimes(2);
	});
	it("keeps confirmed context on failure and respects removal until another thread opens", async () => {
		const { controller, call, attach } = setup();
		controller.handleToolResult(detail(), false);
		await tick();
		call.mockRejectedValueOnce(new Error("Denied"));
		await controller.setStatus(feedback(), "Done");
		await tick();
		expect(attach).toHaveBeenCalledTimes(1);
		controller.handleModelContextCleared();
		call.mockResolvedValueOnce(detail({ ...feedback(), status: "Done" }));
		await controller.setStatus(feedback(), "Done");
		await tick();
		expect(attach).toHaveBeenCalledTimes(1);
		expect(controller.getState().attachedFeedbackId).toBeNull();
		call.mockResolvedValueOnce(detail({ ...feedback(), status: "Done" }));
		await controller.loadDetail(shiplet.id, feedback().id);
		await tick();
		expect(attach).toHaveBeenCalledTimes(1);
		controller.handleToolResult(detail(feedback("other")), false);
		await tick();
		expect(attach.mock.calls.at(-1)?.[0].feedback.id).toBe("other");
	});
	it("keeps context removed if an earlier attachment acknowledgement arrives late", async () => {
		const { controller, host, attach } = setup();
		const pending = deferred<boolean>();
		attach.mockReturnValueOnce(pending.promise);
		controller.handleToolResult(detail(), false);
		await tick();
		controller.handleModelContextCleared();
		pending.resolve(true);
		await tick();
		expect(controller.getState().attachedFeedbackId).toBeNull();
		expect(host.clearAttachedFeedback).toHaveBeenCalledTimes(1);
	});
});
