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
	// Room coordination is already an always-available `room_partner` Provider
	// schema. It is never a deferred discovery Tool.
	return [];
}

export function roomSkillPromptFocus(value: unknown): string[] | undefined {
	const policy = objectRecord(value);
	if (!policy) return undefined;
	const nextCandidates = exactNames(policy.nextCandidates);
	if (nextCandidates.length > 0) return nextCandidates;
	return exactNames(policy.candidateSkillIds);
}
