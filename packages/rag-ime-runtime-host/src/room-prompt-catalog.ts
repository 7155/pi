const TOOL_FOCUS_BY_STAGE: Readonly<Record<string, readonly string[]>> = {
	requirements: ["room_collaborate"],
	solution: ["room_collaborate", "workspace_list", "workspace_search", "workspace_read"],
	planning: ["room_collaborate", "workspace_list", "workspace_search", "workspace_read"],
	implementation: ["room_collaborate", "workspace_read", "workspace_patch", "workspace_shell"],
	debugging: ["room_collaborate", "workspace_search", "workspace_read", "workspace_shell"],
	"self-check": ["room_collaborate", "workspace_search", "workspace_read", "workspace_shell"],
	review: ["room_collaborate", "workspace_search", "workspace_read", "workspace_shell"],
	"vision-review": ["room_collaborate", "workspace_search", "workspace_read", "workspace_shell"],
	feedback: ["room_collaborate", "workspace_read", "workspace_patch", "workspace_shell"],
	handoff: ["room_collaborate"],
	closure: ["room_collaborate"],
};

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function exactNames(value: unknown, maximum = 4): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean))].slice(
		0,
		maximum,
	);
}

export function roomToolPromptFocus(value: unknown): string[] | undefined {
	const policy = objectRecord(value);
	if (!policy) return undefined;
	const stage = typeof policy.stage === "string" ? policy.stage.trim() : "";
	return [...(TOOL_FOCUS_BY_STAGE[stage] ?? [])];
}

export function roomSkillPromptFocus(value: unknown): string[] | undefined {
	const policy = objectRecord(value);
	if (!policy) return undefined;
	const nextCandidates = exactNames(policy.nextCandidates);
	if (nextCandidates.length > 0) return nextCandidates;
	return exactNames(policy.candidateSkillIds);
}
