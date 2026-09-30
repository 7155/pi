import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CHATGPT_ISSUER,
	CHATGPT_RESOURCE,
	CHATGPT_SCOPES,
	type ChatGPTRegistration,
	chatGPTPlanEnabled,
	clearChatGPTSession,
	createOpenAIChatGPTOAuth,
	getOrCreateChatGPTHostId,
	revokeChatGPTSession,
} from "../src/auth/oauth/openai-chatgpt.ts";

const originalFetch = globalThis.fetch;
const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "siwc-test", alg: "RS256", use: "sig" };
const signal = new AbortController().signal;
const hostId = "urn:uuid:5c9d51de-8015-4f78-81eb-2f7f79f8ade5";
const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

async function jwt(payload: Record<string, unknown>, audience = "oaiapp_fixture", issuer = CHATGPT_ISSUER) {
	return new SignJWT(payload)
		.setProtectedHeader({ alg: "RS256", kid: "siwc-test" })
		.setIssuer(issuer)
		.setAudience(audience)
		.setSubject(typeof payload.sub === "string" ? payload.sub : "subject-fixture")
		.setIssuedAt()
		.setExpirationTime("1h")
		.sign(keys.privateKey);
}

function registration(): ChatGPTRegistration {
	return {
		type: "oauth",
		protocol: "siwc-v1",
		issuer: CHATGPT_ISSUER,
		clientId: "oaiapp_fixture",
		subject: "subject-fixture",
		email: "fixture@example.invalid",
		idToken: "old-id",
		access: "old-access",
		refresh: "old-refresh",
		expires: Date.now() + 3_600_000,
		scopes: CHATGPT_SCOPES.split(" "),
		sessionState: "active",
	};
}

function stubExchange(
	options: {
		scope?: string;
		idAudience?: string;
		issuer?: string;
		nonce?: string;
		subject?: string;
		expired?: boolean;
		invalidSignature?: boolean;
		accessAudience?: string;
		code?: string;
		identityOnly?: boolean;
		omitIdToken?: boolean;
	} = {},
) {
	let authorization: URL;
	const calls: Array<{ url: string; body: URLSearchParams }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/.well-known/jwks.json")) return json({ keys: [jwk] });
			if (url.endsWith("/api/accounts/oauth/token")) {
				const body = new URLSearchParams(String(init?.body));
				calls.push({ url, body });
				if (options.code) return json({ error: options.code }, 400);
				let idToken = await jwt(
					{
						nonce: options.nonce ?? authorization.searchParams.get("nonce"),
						...(options.subject ? { sub: options.subject } : {}),
					},
					options.idAudience,
					options.issuer,
				);
				if (options.expired)
					idToken = await new SignJWT({ nonce: authorization.searchParams.get("nonce") })
						.setProtectedHeader({ alg: "RS256", kid: "siwc-test" })
						.setIssuer(CHATGPT_ISSUER)
						.setAudience("oaiapp_fixture")
						.setSubject("subject-fixture")
						.setIssuedAt()
						.setExpirationTime(1)
						.sign(keys.privateKey);
				if (options.invalidSignature) idToken = idToken.slice(0, -20) + "x".repeat(20);
				if (options.identityOnly) return json({ id_token: idToken, scope: "openid profile email" });
				return json({
					id_token: options.omitIdToken ? undefined : idToken,
					access_token: await jwt({ client_id: "oaiapp_fixture" }, options.accessAudience ?? CHATGPT_RESOURCE),
					refresh_token: "fixture-refresh",
					token_type: "Bearer",
					expires_in: 3600,
					scope: options.scope ?? CHATGPT_SCOPES,
				});
			}
			throw new Error(`Unexpected test request: ${url}`);
		}),
	);
	return {
		calls,
		setAuthorization: (url: string) => {
			authorization = new URL(url);
		},
		getAuthorization: () => authorization,
	};
}

async function completeCallback(url: string, query: Record<string, string> = {}, omitClient = false) {
	const authorization = new URL(url);
	const callback = new URL(authorization.searchParams.get("redirect_uri")!);
	callback.search = new URLSearchParams({
		state: authorization.searchParams.get("state")!,
		code: "test-code",
		...(!omitClient ? { client_id: "oaiapp_fixture" } : {}),
		...query,
	}).toString();
	return originalFetch(callback);
}

async function login(
	options: Parameters<typeof stubExchange>[0] = {},
	previous?: ChatGPTRegistration,
	callbackFields?: Record<string, string>,
) {
	const fixture = stubExchange(options);
	let callback: Promise<Response> | undefined;
	const result = createOpenAIChatGPTOAuth({
		agentName: "Personal Agent Workbench",
		hostId,
		registration: previous,
	}).login({
		signal,
		prompt: async () => {
			throw new Error("No prompts expected");
		},
		notify: (event) => {
			if (event.type === "auth_url") {
				fixture.setAuthorization(event.url);
				callback = completeCallback(event.url, callbackFields, Boolean(previous));
			}
		},
	});
	try {
		return { credential: await result, fixture };
	} finally {
		await callback;
	}
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("official ChatGPT SIWC OAuth", () => {
	it("rejects an incomplete dynamic registration rather than exchanging with the entrypoint ID", async () => {
		await expect(login({}, undefined, { client_id: "dynamic_agent_client" })).rejects.toThrow(
			"incomplete_registration",
		);
	});
	it("rotates refresh tokens and preserves app-owned account metadata", async () => {
		const previous = { ...registration(), savedAccounts: [{ fixture: "other-registration" }] };
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url) => {
				if (String(url).endsWith("jwks.json")) return json({ keys: [jwk] });
				return json({
					access_token: await jwt({ client_id: previous.clientId }, CHATGPT_RESOURCE),
					refresh_token: "replacement-refresh",
					token_type: "Bearer",
					expires_in: 3600,
					scope: CHATGPT_SCOPES,
				});
			}),
		);
		const refreshed = await createOpenAIChatGPTOAuth().refresh(previous, signal);
		expect(refreshed.refresh).toBe("replacement-refresh");
		expect(refreshed.idToken).toBe(previous.idToken);
		expect(refreshed.savedAccounts).toEqual(previous.savedAccounts);
	});
	it("requires a fresh ID token even when reauthorizing a saved account", async () => {
		await expect(login({ omitIdToken: true }, registration())).rejects.toThrow("missing_id_token");
	});
	it("retains a valid identity-only result without access or refresh tokens", async () => {
		const { credential } = await login({ identityOnly: true });
		expect(credential).toMatchObject({ subject: "subject-fixture", access: "", refresh: "", sessionState: "active" });
		expect(chatGPTPlanEnabled(credential)).toBe(false);
	});
	it("rejects a returning identity that belongs to another subject", async () => {
		await expect(login({ subject: "different-subject" }, registration())).rejects.toThrow("account_mismatch");
	});
	it("uses issued registration, state/nonce/PKCE, exact loopback/resource and actual app name", async () => {
		const { credential, fixture } = await login();
		const url = fixture.getAuthorization();
		expect(url.origin + url.pathname).toBe(`${CHATGPT_ISSUER}/api/accounts/authorize`);
		expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
		expect(url.searchParams.get("agent_name_hint")).toBe("Personal Agent Workbench");
		expect(url.searchParams.get("ext_agent_host_id")).toBe(hostId);
		expect(url.searchParams.get("scope")).toBe(CHATGPT_SCOPES);
		expect(url.searchParams.get("resource")).toBe(CHATGPT_RESOURCE);
		expect(url.searchParams.get("nonce")).not.toBe(url.searchParams.get("state"));
		const body = fixture.calls[0].body;
		expect(body.get("client_id")).toBe("oaiapp_fixture");
		expect(body.get("resource")).toBe(CHATGPT_RESOURCE);
		expect(body.get("redirect_uri")).toBe(url.searchParams.get("redirect_uri"));
		expect(new URL(body.get("redirect_uri")!).hostname).toBe("127.0.0.1");
		expect(body.has("client_secret")).toBe(false);
		expect(credential.subject).toBe("subject-fixture");
		expect(chatGPTPlanEnabled(credential)).toBe(true);
	});
	it("reuses client ID on reauthorization without leaking ID-token hints into UI URLs", async () => {
		const { fixture } = await login({}, registration());
		expect(fixture.getAuthorization().searchParams.get("client_id")).toBe("oaiapp_fixture");
		expect(fixture.getAuthorization().searchParams.has("agent_name_hint")).toBe(false);
		expect(fixture.getAuthorization().searchParams.has("id_token_hint")).toBe(false);
	});
	it.each([
		{ nonce: "wrong" },
		{ idAudience: "another_client" },
		{ issuer: "https://attacker.invalid" },
		{ expired: true },
		{ invalidSignature: true },
	])("rejects invalid ID token %j", async (options) => {
		await expect(login(options)).rejects.toThrow("invalid_id_token");
	});
	it("rejects an access token for a different resource", async () => {
		await expect(login({ accessAudience: "https://other.invalid" })).rejects.toThrow("invalid_access_token");
	});
	it("rejects changed issued client ID for a returning account", async () => {
		await expect(login({}, registration(), { client_id: "oaiapp_other" })).rejects.toThrow("client_mismatch");
	});
	it("does not exchange a code after access is denied", async () => {
		await expect(login({}, undefined, { error: "access_denied" })).rejects.toThrow("access_denied");
		expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).endsWith("/oauth/token"))).toBe(true);
	});
	it("retains identity with plan permission disabled", async () => {
		const { credential } = await login({ scope: "openid profile email offline_access" });
		expect(chatGPTPlanEnabled(credential)).toBe(false);
		await expect(createOpenAIChatGPTOAuth().toAuth(credential)).rejects.toThrow("permission_required");
	});
	it("ignores wrong state, then accepts only the valid callback", async () => {
		const fixture = stubExchange();
		let callbacks: Promise<void> | undefined;
		const credential = await createOpenAIChatGPTOAuth({ agentName: "PAW", hostId }).login({
			signal,
			prompt: async () => "",
			notify: (event) => {
				if (event.type === "auth_url") {
					fixture.setAuthorization(event.url);
					callbacks = (async () => {
						expect((await completeCallback(event.url, { state: "wrong" })).status).toBe(400);
						await completeCallback(event.url);
					})();
				}
			},
		});
		await callbacks;
		expect(chatGPTPlanEnabled(credential)).toBe(true);
	});
	it("cancels the listener before storing anything", async () => {
		const controller = new AbortController();
		let callback = "";
		await expect(
			createOpenAIChatGPTOAuth({ agentName: "PAW", hostId }).login({
				signal: controller.signal,
				prompt: async () => "",
				notify: (event) => {
					if (event.type === "auth_url") {
						callback = new URL(event.url).searchParams.get("redirect_uri")!;
						controller.abort();
					}
				},
			}),
		).rejects.toThrow("cancelled");
		await expect(originalFetch(callback)).rejects.toThrow();
	});
	it("clears unusable refresh tokens but retains account/client mapping", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json({ error: "refresh_token_reused" }, 400)),
		);
		const cleared = await createOpenAIChatGPTOAuth().refresh(registration(), signal);
		expect(cleared).toMatchObject({
			clientId: "oaiapp_fixture",
			subject: "subject-fixture",
			access: "",
			refresh: "",
			idToken: "",
			sessionState: "reauthorization_required",
		});
		await expect(createOpenAIChatGPTOAuth().toAuth(cleared)).rejects.toThrow();
	});
	it("preserves credentials on temporary refresh errors and never sends scope", async () => {
		const credential = registration();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url, init) => {
				const body = new URLSearchParams(String(init?.body));
				expect(body.get("client_id")).toBe(credential.clientId);
				expect(body.get("resource")).toBe(CHATGPT_RESOURCE);
				expect(body.has("scope")).toBe(false);
				return json({ error: "temporarily_unavailable" }, 503);
			}),
		);
		await expect(createOpenAIChatGPTOAuth().refresh(credential, signal)).rejects.toThrow("temporarily_unavailable");
		expect(credential.refresh).toBe("old-refresh");
	});
	it("revokes through validated discovery, accepting an empty 200", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url, init) => {
				if (String(url).endsWith("openid-configuration"))
					return json({ issuer: CHATGPT_ISSUER, revocation_endpoint: `${CHATGPT_ISSUER}/revoke` });
				expect(new URLSearchParams(String(init?.body)).get("token_type_hint")).toBe("refresh_token");
				return new Response(null, { status: 200 });
			}),
		);
		expect(await revokeChatGPTSession(registration(), signal)).toBe(true);
	});
	it("never transmits tokens to a foreign revocation endpoint", async () => {
		const stub = vi.fn(async () =>
			json({ issuer: CHATGPT_ISSUER, revocation_endpoint: "https://attacker.invalid/revoke" }),
		);
		vi.stubGlobal("fetch", stub);
		expect(await revokeChatGPTSession(registration(), signal)).toBe(false);
		expect(stub).toHaveBeenCalledTimes(1);
	});
	it("preserves stable host identity independently of credential transfer", async () => {
		const directory = await mkdtemp(join(tmpdir(), "siwc-host-"));
		try {
			const path = join(directory, "host");
			const first = await getOrCreateChatGPTHostId(path);
			expect(await getOrCreateChatGPTHostId(path)).toBe(first);
			expect((await readFile(path, "utf8")).trim()).toBe(first);
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			expect(clearChatGPTSession(registration()).clientId).toBe("oaiapp_fixture");
		} finally {
			await rm(directory, { recursive: true });
		}
	});
});
