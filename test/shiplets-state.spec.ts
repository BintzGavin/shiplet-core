import { describe, expect, it } from "vitest";

import {
	createShipletsStore,
	shipletsSelectionSnapshot,
} from "../src/platform/shiplets-state";

describe("shiplets selection state", () => {
	it("keeps bulk archive disabled until a visible shiplet is selected", () => {
		const store = createShipletsStore({
			visibleProjectIds: ["shiplet_one", "shiplet_two"],
		});

		expect(shipletsSelectionSnapshot(store.getState())).toMatchObject({
			allSelected: false,
			bulkArchiveDisabled: true,
			selectedCount: 0,
			selectedLabel: "0 selected",
			someSelected: false,
		});

		store.getState().toggleProjectSelection("shiplet_one");

		expect(shipletsSelectionSnapshot(store.getState())).toMatchObject({
			allSelected: false,
			bulkArchiveDisabled: false,
			selectedCount: 1,
			selectedLabel: "1 selected",
			someSelected: true,
		});
	});

	it("toggles all visible shiplets without retaining stale selections", () => {
		const store = createShipletsStore({
			visibleProjectIds: ["shiplet_one", "shiplet_two"],
		});

		store.getState().toggleAllVisibleProjectSelections();

		expect(store.getState().selectedProjectIds).toEqual([
			"shiplet_one",
			"shiplet_two",
		]);
		expect(shipletsSelectionSnapshot(store.getState())).toMatchObject({
			allSelected: true,
			selectedCount: 2,
			selectedLabel: "2 selected",
		});

		store.getState().setVisibleProjectIds(["shiplet_two"]);

		expect(store.getState().selectedProjectIds).toEqual(["shiplet_two"]);
		expect(shipletsSelectionSnapshot(store.getState())).toMatchObject({
			allSelected: true,
			selectedCount: 1,
			selectedLabel: "1 selected",
		});

		store.getState().setVisibleProjectIds([]);

		expect(store.getState().selectedProjectIds).toEqual([]);
		expect(shipletsSelectionSnapshot(store.getState())).toMatchObject({
			allSelected: false,
			bulkArchiveDisabled: true,
			selectedCount: 0,
		});
	});
});
