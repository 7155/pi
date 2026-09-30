/** Official public-client SIWC flow. Never reads or reuses Codex credentials. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";

export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const AUTHORIZE_URL = `${CHATGPT_ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${CHATGPT_ISSUER}/.well-known/openid-configuration`;
const DYNAMIC_CLIENT = "dynamic_agent_client";
const TERMINAL_REFRESH_ERRORS = new Set([
	"invalid_grant",
	"invalid_refresh_token",
	"token_expired",
	"refresh_token_expired",
	"refresh_token_invalidated",
	"refresh_token_reused",
]);

export interface ChatGPTRegistration extends OAuthCredential {
	protocol: "siwc-v1";
	clientId: string;
	issuer: typeof CHATGPT_ISSUER;
	subject: string;
	email?: string;
	idToken: string;
	scopes: string[];
	sessionState: "active" | "signed_out" | "reauthorization_required";
}

export interface ChatGPTLoginOptions {
	/** Actual host application's name, unchanged across installations. */
	agentName: string;
	hostId: string;
	registration?: ChatGPTRegistration;
	/** Only for an explicit user request to enable plan usage after declining it. */
	requestConsent?: boolean;
}

export class ChatGPTOAuthError extends Error {
	readonly code: string;
	readonly status?: number;
	constructor(code: string, status?: number) {
		super(`ChatGPT sign-in: ${code}${status ? ` (HTTP ${status})` : ""}`);
		this.name = "ChatGPTOAuthError";
		this.code = code;
		this.status = status;
	}
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function issuedClientId(value: unknown): value is string {
	return typeof value === "string" && value !== DYNAMIC_CLIENT && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

export function isChatGPTRegistration(value: unknown): value is ChatGPTRegistration {
	const item = record(value);
	return (
		item.type === "oauth" &&
		item.protocol === "siwc-v1" &&
		issuedClientId(item.clientId) &&
		item.issuer === CHATGPT_ISSUER &&
		typeof item.subject === "string" &&
		item.subject.length > 0 &&
		typeof item.access === "string" &&
		typeof item.refresh === "string" &&
		typeof item.idToken === "string" &&
		typeof item.expires === "number" &&
		Number.isFinite(item.expires) &&
		Array.isArray(item.scopes) &&
		item.scopes.every((scope) => typeof scope === "string") &&
		["active", "signed_out", "reauthorization_required"].includes(String(item.sessionState))
	);
}

export function chatGPTPlanEnabled(value: unknown): value is ChatGPTRegistration {
	return (
		isChatGPTRegistration(value) &&
		value.sessionState === "active" &&
		Boolean(value.access) &&
		value.scopes.includes("chatgpt.tokens.use.direct") &&
		value.scopes.includes("resource.invoke")
	);
}

/** Host identity is deliberately separate from movable account credentials. */
export async function getOrCreateChatGPTHostId(path: string): Promise<string> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	try {
		await writeFile(path, `urn:uuid:${randomUUID()}\n`, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const host = (await readFile(path, "utf8")).trim();
	if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(host)) {
		throw new ChatGPTOAuthError("invalid_host_id");
	}
	return host;
}

async function authFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
	const signal = init.signal
		? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
		: AbortSignal.timeout(15_000);
	try {
		return await fetch(url, { ...init, signal, redirect: "error" });
	} catch {
		if (init.signal?.aborted) throw new ChatGPTOAuthError("cancelled");
		throw new ChatGPTOAuthError("network_unavailable");
	}
}

const jwks = createRemoteJWKSet(new URL(`${CHATGPT_ISSUER}/.well-known/jwks.json`), {
	[customFetch]: (url, options) => authFetch(url, options),
	timeoutDuration: 15_000,
	cacheMaxAge: 600_000,
	cooldownDuration: 30_000,
});

async function identity(idToken: string, clientId: string, nonce?: string) {
	try {
		const { payload } = await jwtVerify(idToken, jwks, {
			issuer: CHATGPT_ISSUER,
			audience: clientId,
			requiredClaims: ["sub", "exp", "iat"],
			clockTolerance: 5,
			algorithms: ["RS256", "ES256"],
		});
		if (
			!payload.sub ||
			!payload.iat ||
			payload.iat > Date.now() / 1000 + 5 ||
			(nonce !== undefined && payload.nonce !== nonce) ||
			(Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) ||
			(payload.azp !== undefined && payload.azp !== clientId)
		)
			throw new Error("invalid identity");
		return payload;
	} catch {
		throw new ChatGPTOAuthError("invalid_id_token");
	}
}

async function tokenResponse(response: Response): Promise<Record<string, unknown>> {
	let json: Record<string, unknown>;
	try {
		json = record(await response.json());
	} catch {
		throw new ChatGPTOAuthError("invalid_token_response", response.status);
	}
	if (!response.ok) {
		const code = typeof json.error === "string" ? json.error : record(json.error).code;
		throw new ChatGPTOAuthError(
			typeof code === "string" && /^[a-z_]{1,80}$/.test(code) ? code : "token_request_failed",
			response.status,
		);
	}
	if (response.status !== 200 || typeof json.scope !== "string") throw new ChatGPTOAuthError("invalid_token_response");
	const scopes = json.scope.split(/\s+/);
	const plan = scopes.includes("chatgpt.tokens.use.direct");
	const hasAccess = typeof json.access_token === "string" && Boolean(json.access_token);
	if (
		(plan && !hasAccess) ||
		(hasAccess &&
			(json.token_type !== "Bearer" ||
				typeof json.expires_in !== "number" ||
				!Number.isFinite(json.expires_in) ||
				json.expires_in <= 0)) ||
		(scopes.includes("offline_access") && (typeof json.refresh_token !== "string" || !json.refresh_token))
	) {
		throw new ChatGPTOAuthError("invalid_token_response");
	}
	return json;
}

async function credentialsFromResponse(
	json: Record<string, unknown>,
	clientId: string,
	nonce?: string,
	previous?: ChatGPTRegistration,
): Promise<ChatGPTRegistration> {
	const idToken = typeof json.id_token === "string" ? json.id_token : undefined;
	if (!idToken && (!previous || nonce !== undefined)) throw new ChatGPTOAuthError("missing_id_token");
	const verified = idToken ? await identity(idToken, clientId, nonce) : undefined;
	if (previous && verified && verified.sub !== previous.subject) throw new ChatGPTOAuthError("account_mismatch");
	// The documented direct-flow access token is a JWT bound to this public resource/client.
	try {
		if (json.access_token) {
			const { payload } = await jwtVerify(String(json.access_token), jwks, {
				issuer: CHATGPT_ISSUER,
				audience: CHATGPT_RESOURCE,
				requiredClaims: ["exp", "iat", "client_id"],
				clockTolerance: 5,
				algorithms: ["RS256", "ES256"],
			});
			if (payload.client_id !== clientId) throw new Error("client mismatch");
		}
	} catch {
		throw new ChatGPTOAuthError("invalid_access_token");
	}
	return {
		...previous,
		type: "oauth",
		protocol: "siwc-v1",
		issuer: CHATGPT_ISSUER,
		clientId,
		subject: verified?.sub ?? previous!.subject,
		email: typeof verified?.email === "string" ? verified.email : previous?.email,
		idToken: idToken ?? previous!.idToken,
		access: typeof json.access_token === "string" ? json.access_token : "",
		refresh: typeof json.refresh_token === "string" ? json.refresh_token : "",
		expires: Date.now() + (typeof json.expires_in === "number" ? json.expires_in : 0) * 1000,
		scopes: String(json.scope).split(/\s+/).filter(Boolean),
		sessionState: "active",
	};
}

async function authorize(
	options: ChatGPTLoginOptions,
	interaction: ProviderAuthInteraction,
	retryClientId?: string,
): Promise<ChatGPTRegistration> {
	interaction.signal.throwIfAborted();
	const state = randomBytes(32).toString("base64url");
	const nonce = randomBytes(32).toString("base64url");
	const verifier = randomBytes(32).toString("base64url");
	const clientId = retryClientId ?? options.registration?.clientId ?? DYNAMIC_CLIENT;
	let finish: (params: URLSearchParams) => void = () => {};
	const callback = new Promise<URLSearchParams>((resolve) => {
		finish = resolve;
	});
	let consumed = false;
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Content-Type", "text/plain; charset=utf-8");
		res.setHeader("Referrer-Policy", "no-referrer");
		if (req.method !== "GET" || url.pathname !== "/auth/callback") {
			res.writeHead(404).end("Not found");
			return;
		}
		if (consumed || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== state) {
			res.writeHead(400).end("Invalid sign-in state. Return to the application.");
			return;
		}
		consumed = true;
		res.end("Authorization received. Return to the application to check the result.");
		finish(url.searchParams);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new ChatGPTOAuthError("callback_unavailable");
	}
	const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
	const params = new URLSearchParams({
		client_id: clientId,
		ext_agent_host_id: options.hostId,
		response_type: "code",
		redirect_uri: redirectUri,
		scope: CHATGPT_SCOPES,
		resource: CHATGPT_RESOURCE,
		state,
		nonce,
		code_challenge_method: "S256",
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
	});
	if (clientId === DYNAMIC_CLIENT) params.set("agent_name_hint", options.agentName);
	// Deliberately omit optional ID-token hints: URLs are displayed by host applications.
	if (options.registration?.email) params.set("login_hint", options.registration.email);
	if (options.requestConsent) params.set("prompt", "consent");
	const signal = AbortSignal.any([interaction.signal, AbortSignal.timeout(15 * 60_000)]);
	let abort: () => void = () => {};
	try {
		const cancelled = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new ChatGPTOAuthError(interaction.signal.aborted ? "cancelled" : "login_timeout"));
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		});
		interaction.notify({
			type: "auth_url",
			url: `${AUTHORIZE_URL}?${params}`,
			instructions: "Continue with ChatGPT in the browser on this host.",
		});
		const returned = await Promise.race([callback, cancelled]);
		if (returned.has("error"))
			throw new ChatGPTOAuthError(
				returned.get("error") === "access_denied" ? "access_denied" : "authorization_failed",
			);
		const issued = returned.get("client_id") ?? (clientId === DYNAMIC_CLIENT ? undefined : clientId);
		if (returned.getAll("client_id").length > 1 || !issuedClientId(issued))
			throw new ChatGPTOAuthError("incomplete_registration");
		if (clientId !== DYNAMIC_CLIENT && issued !== clientId) throw new ChatGPTOAuthError("client_mismatch");
		const code = returned.get("code");
		if (!code || returned.getAll("code").length !== 1) throw new ChatGPTOAuthError("missing_code");
		try {
			const json = await tokenResponse(
				await authFetch(TOKEN_URL, {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					signal,
					body: new URLSearchParams({
						grant_type: "authorization_code",
						client_id: issued,
						code,
						code_verifier: verifier,
						redirect_uri: redirectUri,
						resource: CHATGPT_RESOURCE,
					}),
				}),
			);
			signal.throwIfAborted();
			return await credentialsFromResponse(json, issued, nonce, options.registration);
		} catch (error) {
			if (error instanceof ChatGPTOAuthError && error.code === "invalid_grant" && !retryClientId) {
				interaction.notify({
					type: "info",
					message: "The authorization code expired. Continue with ChatGPT again.",
				});
				return await authorize(options, interaction, issued);
			}
			throw error;
		}
	} finally {
		signal.removeEventListener("abort", abort);
		server.closeAllConnections();
		server.close();
	}
}

export function clearChatGPTSession(
	credential: ChatGPTRegistration,
	state: "signed_out" | "reauthorization_required" = "signed_out",
): ChatGPTRegistration {
	return { ...credential, access: "", refresh: "", idToken: "", scopes: [], expires: 0, sessionState: state };
}

export async function revokeChatGPTSession(credential: ChatGPTRegistration, signal: AbortSignal): Promise<boolean> {
	if (!credential.refresh) return true;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const discovery = await authFetch(DISCOVERY_URL, { signal });
			if (!discovery.ok) throw new ChatGPTOAuthError("discovery_failed", discovery.status);
			const metadata = record(await discovery.json());
			const endpoint = new URL(String(metadata.revocation_endpoint));
			if (
				metadata.issuer !== CHATGPT_ISSUER ||
				endpoint.origin !== CHATGPT_ISSUER ||
				endpoint.username ||
				endpoint.password ||
				endpoint.hash
			)
				return false;
			const response = await authFetch(endpoint, {
				method: "POST",
				signal,
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					token: credential.refresh,
					token_type_hint: "refresh_token",
					client_id: credential.clientId,
				}),
			});
			if (response.status === 200) return true;
			if (response.status < 500) return false;
		} catch {
			if (signal.aborted) return false;
		}
		if (attempt < 2) await sleep(250 * 2 ** attempt, undefined, { signal }).catch(() => {});
	}
	return false;
}

export function createOpenAIChatGPTOAuth(options?: ChatGPTLoginOptions): OAuthAuth {
	return {
		name: "ChatGPT plan (Sign in with ChatGPT)",
		isSubscription: true,
		loginLabel: "Continue with ChatGPT",
		async login(interaction) {
			if (
				!options?.agentName.trim() ||
				!options.hostId ||
				(options.registration && !isChatGPTRegistration(options.registration))
			) {
				throw new ChatGPTOAuthError("host_application_configuration_required");
			}
			return authorize(options, interaction);
		},
		async refresh(credential, signal) {
			if (!isChatGPTRegistration(credential)) throw new ChatGPTOAuthError("legacy_credentials_require_new_sign_in");
			if (!credential.refresh || credential.sessionState !== "active") return credential;
			try {
				const json = await tokenResponse(
					await authFetch(TOKEN_URL, {
						method: "POST",
						signal,
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({
							grant_type: "refresh_token",
							client_id: credential.clientId,
							refresh_token: credential.refresh,
							resource: CHATGPT_RESOURCE,
						}),
					}),
				);
				return await credentialsFromResponse(json, credential.clientId, undefined, credential);
			} catch (error) {
				if (error instanceof ChatGPTOAuthError && TERMINAL_REFRESH_ERRORS.has(error.code)) {
					return clearChatGPTSession(credential, "reauthorization_required");
				}
				throw error;
			}
		},
		async toAuth(credential) {
			if (!chatGPTPlanEnabled(credential)) throw new ChatGPTOAuthError("chatgpt_plan_permission_required");
			if (credential.expires <= Date.now()) throw new ChatGPTOAuthError("access_token_expired_reauthorize");
			return { apiKey: credential.access, baseUrl: CHATGPT_RESOURCE };
		},
	};
}

export const openaiChatGPTOAuth = createOpenAIChatGPTOAuth();
