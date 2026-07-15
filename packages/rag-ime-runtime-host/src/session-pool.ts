import { RuntimeProtocolError } from "./protocol.ts";

export interface PooledSession {
	readonly externalSessionId: string;
	readonly isIdle: boolean;
	dispose(): void | Promise<void>;
}

interface PoolEntry<T extends PooledSession> {
	session: T;
	lastUsedAt: number;
}

export class BoundedSessionPool<T extends PooledSession> {
	readonly maxSessions: number;
	readonly evictionPolicy = "lru-idle" as const;
	private readonly entries = new Map<string, PoolEntry<T>>();

	constructor(maxSessions: number) {
		if (!Number.isInteger(maxSessions) || maxSessions < 1) {
			throw new Error("maxSessions must be a positive integer");
		}
		this.maxSessions = maxSessions;
	}

	get size(): number {
		return this.entries.size;
	}

	list(): T[] {
		return [...this.entries.values()].map((entry) => entry.session);
	}

	get(sessionId: string): T | undefined {
		const entry = this.entries.get(sessionId);
		if (!entry) return undefined;
		entry.lastUsedAt = Date.now();
		return entry.session;
	}

	async open(sessionId: string, create: () => Promise<T>): Promise<{ session: T; evictedSessionId?: string }> {
		const existing = this.get(sessionId);
		if (existing) return { session: existing };

		let evictedSessionId: string | undefined;
		if (this.entries.size >= this.maxSessions) {
			const idleEntries = [...this.entries.entries()]
				.filter(([, entry]) => entry.session.isIdle)
				.sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
			const victim = idleEntries[0];
			if (!victim) {
				throw new RuntimeProtocolError(
					"SESSION_CAPACITY",
					`Runtime session limit (${this.maxSessions}) reached and all sessions are active`,
				);
			}
			this.entries.delete(victim[0]);
			await victim[1].session.dispose();
			evictedSessionId = victim[0];
		}

		const session = await create();
		if (session.externalSessionId !== sessionId) {
			await session.dispose();
			throw new Error("Session factory returned a mismatched externalSessionId");
		}
		this.entries.set(sessionId, { session, lastUsedAt: Date.now() });
		return { session, evictedSessionId };
	}

	async close(sessionId: string): Promise<boolean> {
		const entry = this.entries.get(sessionId);
		if (!entry) return false;
		this.entries.delete(sessionId);
		await entry.session.dispose();
		return true;
	}

	async dispose(): Promise<void> {
		const sessions = [...this.entries.values()].map((entry) => entry.session);
		this.entries.clear();
		await Promise.allSettled(sessions.map(async (session) => session.dispose()));
	}
}
