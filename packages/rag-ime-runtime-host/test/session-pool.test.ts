import { describe, expect, it, vi } from "vitest";
import { BoundedSessionPool, type PooledSession } from "../src/session-pool.ts";

function session(id: string, idle = true): PooledSession {
	return { externalSessionId: id, isIdle: idle, dispose: vi.fn() };
}

describe("bounded session pool", () => {
	it("evicts only the least recently used idle session", async () => {
		const pool = new BoundedSessionPool<PooledSession>(2);
		const first = session("first");
		await pool.open("first", async () => first);
		await new Promise((resolve) => setTimeout(resolve, 2));
		await pool.open("second", async () => session("second"));

		const opened = await pool.open("third", async () => session("third"));

		expect(opened.evictedSessionId).toBe("first");
		expect(first.dispose).toHaveBeenCalledOnce();
		expect(
			pool
				.list()
				.map((value) => value.externalSessionId)
				.sort(),
		).toEqual(["second", "third"]);
	});

	it("fails closed when every session is active", async () => {
		const pool = new BoundedSessionPool<PooledSession>(1);
		await pool.open("active", async () => session("active", false));
		await expect(pool.open("next", async () => session("next"))).rejects.toMatchObject({ code: "SESSION_CAPACITY" });
	});
});
