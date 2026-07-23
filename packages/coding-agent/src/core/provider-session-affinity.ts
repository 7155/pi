const PROVIDER_SESSION_AFFINITY_MAX_LENGTH = 64;
const UPSTREAM_ERROR_PATTERN = /upstream(?:_error|.?request.?failed)/iu;
const TRANSIENT_GATEWAY_STATUS_PATTERN =
	/(?:\bapi error\s*\((?:502|503|504|524)\)|\b(?:502|503|504|524)\s+status code\b)/iu;

export function isUpstreamProviderError(errorMessage: string | undefined): boolean {
	const message = errorMessage || "";
	return UPSTREAM_ERROR_PATTERN.test(message) || TRANSIENT_GATEWAY_STATUS_PATTERN.test(message);
}

export function rotateProviderSessionAffinity(base: string | undefined, generation: number): string | undefined {
	if (!base) return undefined;
	const suffix = `:retry:${Math.max(1, generation)}`;
	const prefixLength = Math.max(0, PROVIDER_SESSION_AFFINITY_MAX_LENGTH - suffix.length);
	return `${base.slice(0, prefixLength)}${suffix}`;
}
