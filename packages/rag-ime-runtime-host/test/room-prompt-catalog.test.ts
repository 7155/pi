import { describe, expect, it } from "vitest";
import { roomSkillPromptFocus, roomToolPromptFocus } from "../src/room-prompt-catalog.ts";

describe("Room prompt catalog projection", () => {
	it("selects no more than four exact Tool cards for the current stage", () => {
		expect(roomToolPromptFocus({ stage: "implementation" })).toEqual([
			"room_collaborate",
			"workspace_read",
			"workspace_patch",
			"workspace_shell",
		]);
		expect(roomToolPromptFocus({ stage: "closure" })).toEqual(["room_collaborate"]);
		expect(roomToolPromptFocus({ stage: "unknown" })).toEqual([]);
		expect(roomToolPromptFocus(undefined)).toBeUndefined();
	});

	it("prefers ordered next candidates and bounds exact Skill cards", () => {
		expect(
			roomSkillPromptFocus({
				nextCandidates: ["grill-me", "quality-gate", "grill-me", "review", "fifth"],
				candidateSkillIds: ["fallback"],
			}),
		).toEqual(["grill-me", "quality-gate", "review", "fifth"]);
		expect(roomSkillPromptFocus({ candidateSkillIds: ["managed-task-execution"] })).toEqual([
			"managed-task-execution",
		]);
		expect(roomSkillPromptFocus(undefined)).toBeUndefined();
	});
});
