export const SKILL_SEARCH_TOOL_NAME = "skill_search";
export const SKILL_LOAD_TOOL_NAME = "skill_load";
export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const TOOL_LOAD_TOOL_NAME = "tool_load";
export const MEMORY_CAPTURE_TOOL_NAME = "memory_capture";
export const READ_TOOL_NAME = "read";
export const GREP_TOOL_NAME = "grep";
export const FIND_TOOL_NAME = "find";
export const LS_TOOL_NAME = "ls";
export const EDIT_TOOL_NAME = "edit";
export const WRITE_TOOL_NAME = "write";
export const BASH_TOOL_NAME = "bash";

export const NATIVE_WORKSPACE_TOOL_NAMES = [
	READ_TOOL_NAME,
	GREP_TOOL_NAME,
	FIND_TOOL_NAME,
	LS_TOOL_NAME,
	EDIT_TOOL_NAME,
	WRITE_TOOL_NAME,
	BASH_TOOL_NAME,
] as const;

export const RESERVED_RUNTIME_TOOL_NAMES = new Set([
	SKILL_SEARCH_TOOL_NAME,
	SKILL_LOAD_TOOL_NAME,
	TOOL_SEARCH_TOOL_NAME,
	TOOL_LOAD_TOOL_NAME,
	MEMORY_CAPTURE_TOOL_NAME,
	...NATIVE_WORKSPACE_TOOL_NAMES,
]);
