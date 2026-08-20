import { describe, expect, it } from "vitest";
import { roomSkillPromptFocus, roomToolPromptFocus } from "../src/room-prompt-catalog.ts";

describe("Room prompt catalog projection", () => {
	it("does not advertise the direct room_partner schema as a deferred Tool card", () => {
		expect(roomToolPromptFocus({ stage: "implementation" })).toEqual([]);
		expect(roomToolPromptFocus({ stage: "closure" })).toEqual([]);
		expect(roomToolPromptFocus({ stage: "unknown" })).toEqual([]);
		expect(roomToolPromptFocus(undefined)).toBeUndefined();
	});

	it("never re-advertises retired Room or resident native tools as deferred tools", () => {
		for (const stage of [
			"requirements",
			"solution",
			"planning",
			"implementation",
			"debugging",
			"self-check",
			"review",
			"vision-review",
			"feedback",
			"handoff",
			"closure",
		]) {
			const focus = roomToolPromptFocus({ stage }) ?? [];
			expect(focus).toEqual([]);
			expect(focus.some((name) => name.startsWith("workspace_"))).toBe(false);
		}
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
