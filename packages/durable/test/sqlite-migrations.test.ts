import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import {
	applySqliteMigrations,
	CURRENT_SQLITE_SCHEMA_VERSION,
	SQLITE_MIGRATIONS,
	type SqliteMigration,
} from "../src/storage/sqlite/index.ts";
import { NodeSqliteDatabase, openNodeSqliteDatabase, openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { type EntryId, ROOT_CONVERSATION_ID } from "../src/types.ts";

const directories = new Set<string>();

async function databasePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-migrations-"));
	directories.add(directory);
	return join(directory, "storage.sqlite");
}

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

describe("durable SQLite migrations", () => {
	it.each([
		{ route: "storage", journal: "DELETE" },
		{ route: "storage", journal: "WAL" },
		{ route: "portable migrations", journal: "DELETE" },
	])("rejects historical v1 through $route ($journal) without changing the file", async ({ route, journal }) => {
		const path = await databasePath();
		const database = new DatabaseSync(path);
		database.exec(`PRAGMA journal_mode = ${journal}`);
		const legacySchema = await readFile(new URL("./fixtures/sqlite-schema-v1-a45d9776.sql", import.meta.url), "utf8");
		database.exec(legacySchema);
		database.exec(`
			INSERT INTO record_ids (id, record_type) VALUES (1, 'conversation'), (2, 'entry');
			INSERT INTO conversations (id, record) VALUES (1, '{"id":1}');
			INSERT INTO entries (id, conversation_id, head, commit_seq, record)
				VALUES (2, 1, NULL, 1, '{"id":2,"conversationId":1,"kind":"retained","data":{"retained":true}}');
			UPDATE durable_metadata SET next_id = '3', next_seq = 2 WHERE singleton = 1;
		`);
		const recordsBefore = database.prepare("SELECT * FROM entries").all();
		const schemaBefore = database.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
		database.close();
		const bytesBefore = await readFile(path);
		const hashBefore = createHash("sha256").update(bytesBefore).digest("hex");

		if (route === "storage") {
			await expect(openNodeSqliteStorage(path).then((storage) => storage.close(BACKGROUND_CONTEXT))).rejects.toThrow(
				/Unsupported durable SQLite schema.*preserve.*older version/i,
			);
		} else {
			const adapter = new NodeSqliteDatabase(new DatabaseSync(path));
			try {
				await expect(applySqliteMigrations(adapter)).rejects.toThrow(/Unsupported durable SQLite schema/i);
			} finally {
				await adapter.close();
			}
		}

		const bytesAfter = await readFile(path);
		expect(createHash("sha256").update(bytesAfter).digest("hex")).toBe(hashBefore);
		expect(bytesAfter).toEqual(bytesBefore);
		if (journal === "DELETE") {
			expect(await readdir(dirname(path))).toEqual(["storage.sqlite"]);
		} else {
			// SQLite readers may create an empty WAL and a shared-memory index, but cannot commit records.
			expect((await readFile(`${path}-wal`)).length).toBe(0);
		}
		const unchanged = new DatabaseSync(path, { readOnly: true });
		try {
			expect(unchanged.prepare("SELECT * FROM entries").all()).toEqual(recordsBefore);
			expect(unchanged.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(schemaBefore);
			expect(unchanged.prepare("SELECT * FROM durable_schema").get()).toEqual({ singleton: 1, version: 1 });
			expect(unchanged.prepare("SELECT * FROM durable_metadata").get()).toEqual({
				singleton: 1,
				next_id: "3",
				next_seq: 2,
			});
		} finally {
			unchanged.close();
		}
	});

	it("leaves a historical database and its uncheckpointed WAL byte-for-byte unchanged", async () => {
		const path = await databasePath();
		execFileSync(process.execPath, [
			"--experimental-strip-types",
			fileURLToPath(new URL("./fixtures/sqlite-legacy-wal.ts", import.meta.url)),
			path,
		]);
		const files = (await readdir(dirname(path))).sort();
		expect(files).toContain("storage.sqlite-wal");
		// Shared-memory read marks may change during reads; only the database and WAL contain durable records.
		const durableFiles = [path, `${path}-wal`];
		const before = await Promise.all(durableFiles.map((file) => readFile(file)));
		expect((await readFile(`${path}-wal`)).length).toBeGreaterThan(0);
		await expect(openNodeSqliteStorage(path)).rejects.toThrow("Unsupported durable SQLite schema");
		expect((await readdir(dirname(path))).sort()).toEqual(files);
		const after = await Promise.all(durableFiles.map((file) => readFile(file)));
		expect(after).toEqual(before);
	});

	it("initializes an existing empty file and reopens its current records", async () => {
		const path = await databasePath();
		await writeFile(path, "");
		const storage = await openNodeSqliteStorage(path);
		await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT);
		await storage.close(BACKGROUND_CONTEXT);
		const reopened = await openNodeSqliteStorage(path);
		try {
			expect(await reopened.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)).toEqual({
				id: ROOT_CONVERSATION_ID,
			});
		} finally {
			await reopened.close(BACKGROUND_CONTEXT);
		}
	});

	it.each(["conversation owners", "submission status", "task states"])(
		"rejects an incompatible v1 even when only %s differ",
		async (difference) => {
			const path = await databasePath();
			const database = new DatabaseSync(path);
			database.exec("CREATE TABLE durable_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL) STRICT");
			database.exec("INSERT INTO durable_schema (singleton, version) VALUES (1, 1)");
			for (const original of SQLITE_MIGRATIONS[0].statements) {
				let statement = original;
				if (difference === "conversation owners") {
					if (statement.startsWith("CREATE INDEX conversations_by_owner_")) continue;
					statement = statement.replace(/\s*owner_(?:conversation|task)_id INTEGER,/g, "");
				} else if (difference === "submission status") {
					if (statement.startsWith("CREATE INDEX submissions_by_status")) continue;
					if (statement.startsWith("CREATE TABLE submissions")) {
						statement = statement.replace(/\s*status TEXT NOT NULL CHECK \(status IN \([^)]*\)\),/, "");
					}
				} else {
					statement = statement.replace("'running', 'waiting', 'completing', 'terminal'", "'running', 'terminal'");
				}
				database.exec(statement);
			}
			database.close();
			const before = await readFile(path);
			await expect(openNodeSqliteStorage(path).then((storage) => storage.close(BACKGROUND_CONTEXT))).rejects.toThrow(
				"Unsupported durable SQLite schema",
			);
			expect(await readFile(path)).toEqual(before);
			expect(await readdir(dirname(path))).toEqual(["storage.sqlite"]);
		},
	);

	it("creates the current schema and can be applied repeatedly", async () => {
		const database = await openNodeSqliteDatabase(await databasePath());
		try {
			await applySqliteMigrations(database);
			await applySqliteMigrations(database);
			expect(await database.get("SELECT version FROM durable_schema WHERE singleton = 1")).toEqual({
				version: CURRENT_SQLITE_SCHEMA_VERSION,
			});
			expect(await database.get("SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1")).toEqual({
				next_id: "2",
				next_seq: 1,
			});
		} finally {
			await database.close();
		}
	});

	it("rejects a database newer than the portable core", async () => {
		const path = await databasePath();
		const database = await openNodeSqliteDatabase(path);
		await applySqliteMigrations(database);
		await database.run(
			"UPDATE durable_schema SET version = ? WHERE singleton = 1",
			CURRENT_SQLITE_SCHEMA_VERSION + 1,
		);
		await database.close();

		await expect(openNodeSqliteStorage(path)).rejects.toThrow("is newer than supported version");
	});

	it("awaits version validation on the transaction handle before applying migrations", async () => {
		const database = await openNodeSqliteDatabase(await databasePath());
		try {
			await applySqliteMigrations(database);
			let validated = false;
			const migrations: readonly SqliteMigration[] = [
				{
					...SQLITE_MIGRATIONS[0],
					validate: async (transaction) => {
						expect(transaction).not.toBe(database);
						expect(await transaction.get("SELECT version FROM durable_schema WHERE singleton = 1")).toEqual({
							version: 1,
						});
						await Promise.resolve();
						validated = true;
						throw new Error("schema validation rejected");
					},
				},
				{ version: 2, statements: ["CREATE TABLE must_not_exist (value TEXT) STRICT"] },
			];
			await expect(applySqliteMigrations(database, migrations)).rejects.toThrow("schema validation rejected");
			expect(validated).toBe(true);
			expect(await database.get("SELECT version FROM durable_schema WHERE singleton = 1")).toEqual({ version: 1 });
			expect(await database.get("SELECT name FROM sqlite_schema WHERE name = 'must_not_exist'")).toBeUndefined();
		} finally {
			await database.close();
		}
	});

	it("rolls initial bootstrap and every pending migration back together", async () => {
		const database = await openNodeSqliteDatabase(await databasePath());
		try {
			const failed: readonly SqliteMigration[] = [
				{
					version: 1,
					statements: [
						"CREATE TABLE migration_first (value TEXT) STRICT",
						"INSERT INTO migration_first (value) VALUES ('retained')",
					],
				},
				{
					version: 2,
					statements: ["CREATE TABLE migration_second (value TEXT) STRICT", "THIS IS NOT SQL"],
				},
			];
			await expect(applySqliteMigrations(database, failed)).rejects.toThrow();
			expect(
				await database.get(
					"SELECT count(*) AS count FROM sqlite_schema WHERE name IN ('durable_schema', 'migration_first', 'migration_second')",
				),
			).toEqual({ count: 0 });

			await applySqliteMigrations(database, [
				failed[0],
				{ version: 2, statements: ["CREATE TABLE migration_second (value TEXT) STRICT"] },
			]);
			expect(await database.get("SELECT version FROM durable_schema WHERE singleton = 1")).toEqual({
				version: 2,
			});
			expect(await database.get("SELECT value FROM migration_first")).toEqual({
				value: "retained",
			});
		} finally {
			await database.close();
		}
	});

	it("rolls a failed migration back and preserves stored data for a successful retry", async () => {
		const path = await databasePath();
		const storage = await openNodeSqliteStorage(path);
		await storage.commit(
			[
				{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
				{
					type: "entry",
					value: {
						id: idFromNumber<EntryId>(2),
						conversationId: ROOT_CONVERSATION_ID,
						kind: "retained",
						data: { retained: true },
					},
				},
			],
			BACKGROUND_CONTEXT,
		);
		await storage.close(BACKGROUND_CONTEXT);

		const database = await openNodeSqliteDatabase(path);
		const nextVersion = CURRENT_SQLITE_SCHEMA_VERSION + 1;
		const failedMigrations: readonly SqliteMigration[] = [
			...SQLITE_MIGRATIONS,
			{
				version: nextVersion,
				statements: ["CREATE TABLE migration_probe (value TEXT) STRICT", "THIS IS NOT SQL"],
			},
		];
		await expect(applySqliteMigrations(database, failedMigrations)).rejects.toThrow();
		expect(await database.get("SELECT version FROM durable_schema WHERE singleton = 1")).toEqual({
			version: CURRENT_SQLITE_SCHEMA_VERSION,
		});
		expect(
			await database.get(
				"SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'migration_probe'",
			),
		).toEqual({ count: 0 });

		const successfulMigrations: readonly SqliteMigration[] = [
			...SQLITE_MIGRATIONS,
			{ version: nextVersion, statements: ["CREATE TABLE migration_probe (value TEXT) STRICT"] },
		];
		await applySqliteMigrations(database, successfulMigrations);
		expect(await database.get("SELECT version FROM durable_schema WHERE singleton = 1")).toEqual({
			version: nextVersion,
		});
		expect(await database.get("SELECT record, commit_seq FROM entries WHERE id = 2")).toEqual({
			record: JSON.stringify({
				id: 2,
				conversationId: ROOT_CONVERSATION_ID,
				kind: "retained",
				data: { retained: true },
			}),
			commit_seq: 1,
		});
		expect(await database.get("SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1")).toEqual({
			next_id: "3",
			next_seq: 2,
		});
		await database.close();
	});
});
