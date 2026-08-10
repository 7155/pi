const TOOL_FOCUS_BY_STAGE: Readonly<Record<string, readonly string[]>> = {
	// `read`, `grep`, `find`, `ls`, and `bash` are resident
	// native coding tools. They are deliberately absent here: this projection
	// is only for deferred product-tool discovery, and advertising native
	// tools again makes the model search for or load capabilities it already
	// has.
	requirements: ["room_collaborate"],
	solution: ["room_collaborate"],
	planning: ["room_collaborate"],
	implementation: ["room_collaborate"],
	debugging: ["room_collaborate"],
	"self-check": ["room_collaborate"],
	review: ["room_collaborate"],
	"vision-review": ["room_collaborate"],
	feedback: ["room_collaborate"],
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
