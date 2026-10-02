import type { SqliteDatabase, SqliteExecutor } from "./database.ts";

export type SqliteMigration = {
	readonly version: number;
	readonly statements: readonly string[];
	/** Read-only validation of an existing database at this version, before any migration runs. */
	readonly validate?: (database: SqliteExecutor) => void | Promise<void>;
};

// next_id is TEXT because node:sqlite rejects INTEGER results outside JavaScript's safe integer range.
const INITIAL_SCHEMA: readonly string[] = [
	`CREATE TABLE durable_metadata (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		next_id TEXT NOT NULL,
		next_seq INTEGER NOT NULL
	) STRICT`,
	`INSERT INTO durable_metadata (singleton, next_id, next_seq) VALUES (1, '2', 1)`,
	`CREATE TABLE record_ids (
		id INTEGER PRIMARY KEY,
		record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
	) STRICT`,
	`CREATE TABLE conversations (
		id INTEGER PRIMARY KEY,
		owner_conversation_id INTEGER,
		owner_task_id INTEGER,
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
	"CREATE INDEX conversations_by_owner_conversation ON conversations (owner_conversation_id, id)",
	"CREATE INDEX conversations_by_owner_task ON conversations (owner_task_id, id)",
	`CREATE TABLE entries (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		head INTEGER,
		commit_seq INTEGER NOT NULL,
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
	"CREATE INDEX entries_by_conversation ON entries (conversation_id, id DESC)",
	"CREATE INDEX entry_heads_by_conversation ON entries (conversation_id, id DESC) WHERE head IS NOT NULL",
	`CREATE TABLE tasks (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		kind TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
		abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
		background INTEGER NOT NULL CHECK (background IN (0, 1)),
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
	"CREATE INDEX tasks_by_status ON tasks (status, id)",
	"CREATE INDEX tasks_by_conversation ON tasks (conversation_id, id)",
	"CREATE INDEX tasks_by_kind ON tasks (kind, id)",
	"CREATE INDEX tasks_by_abort_requested ON tasks (abort_requested, id)",
	"CREATE INDEX tasks_by_background ON tasks (background, id)",
	`CREATE TABLE submissions (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		request_id TEXT,
		status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
	"CREATE INDEX submissions_by_request ON submissions (conversation_id, request_id)",
	"CREATE INDEX submissions_by_conversation ON submissions (conversation_id, id)",
	"CREATE INDEX submissions_by_status ON submissions (status, id)",
	`CREATE TABLE documents (
		id INTEGER PRIMARY KEY,
		kind TEXT NOT NULL,
		family INTEGER NOT NULL CHECK (family IN (0, 1)),
		key_value TEXT NOT NULL,
		scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
		owner_id INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		retired_at INTEGER,
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT`,
	`CREATE INDEX documents_by_address
		ON documents (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
	"CREATE INDEX documents_by_scope ON documents (scope_kind, owner_id, id)",
	"CREATE INDEX documents_by_scope_kind ON documents (scope_kind, owner_id, kind, id)",
	`CREATE TABLE document_revisions (
		document_id INTEGER NOT NULL,
		seq INTEGER NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
		version INTEGER NOT NULL,
		content TEXT NOT NULL CHECK (json_valid(content)),
		PRIMARY KEY (document_id, seq)
	) STRICT`,
	"CREATE INDEX document_revisions_by_kind ON document_revisions (document_id, kind, seq DESC)",
];

async function validateInitialSchema(database: SqliteExecutor): Promise<void> {
	const definitions = new Map(
		(
			await database.all<{ readonly name: string; readonly sql: string }>(
				"SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL",
			)
		).map((row) => [row.name, row.sql.replace(/\s+/g, " ").trim()]),
	);
	// WIP versions changed the initial schema in place. The version number alone cannot identify them.
	for (const statement of INITIAL_SCHEMA) {
		const name = /^CREATE (?:TABLE|INDEX) (\w+)/.exec(statement)?.[1];
		if (name === undefined || definitions.get(name) === statement.replace(/\s+/g, " ").trim()) continue;
		throw new Error(
			`Unsupported durable SQLite schema version 1 (${name} differs from this pre-release build). ` +
				"Preserve the database and use the older version that created it to read or export its records; automatic migration is not supported.",
		);
	}
}

/** Immutable, ordered schema history. Append new migrations after the initial schema ships. */
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
	{ version: 1, statements: INITIAL_SCHEMA, validate: validateInitialSchema },
];

export const CURRENT_SQLITE_SCHEMA_VERSION = SQLITE_MIGRATIONS.at(-1)?.version ?? 0;

type SchemaRow = { readonly version: number };

/** Check an existing schema without writes, including before a Node adapter enables WAL. */
export async function validateSqliteSchema(
	database: SqliteExecutor,
	migrations: readonly SqliteMigration[] = SQLITE_MIGRATIONS,
): Promise<void> {
	if (
		(await database.get("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'durable_schema'")) ===
		undefined
	) {
		return;
	}
	const row = await database.get<SchemaRow>("SELECT version FROM durable_schema WHERE singleton = 1");
	if (row === undefined) throw new Error("Durable SQLite schema metadata is missing");
	const currentVersion = migrations.at(-1)?.version ?? 0;
	if (row.version > currentVersion) {
		throw new Error(`Durable SQLite schema version ${row.version} is newer than supported version ${currentVersion}`);
	}
	await migrations.find((migration) => migration.version === row.version)?.validate?.(database);
}

/** Apply all pending schema migrations atomically. */
export async function applySqliteMigrations(
	database: SqliteDatabase,
	migrations: readonly SqliteMigration[] = SQLITE_MIGRATIONS,
): Promise<void> {
	for (let index = 0; index < migrations.length; index++) {
		if (migrations[index]?.version !== index + 1) {
			throw new Error("Durable SQLite migrations must have contiguous versions starting at 1");
		}
	}

	await database.transaction(async (transaction) => {
		// Validation must use this transaction handle, never the queued parent database.
		await validateSqliteSchema(transaction, migrations);
		await transaction.exec(`CREATE TABLE IF NOT EXISTS durable_schema (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			version INTEGER NOT NULL CHECK (version >= 0)
		) STRICT`);
		await transaction.run("INSERT OR IGNORE INTO durable_schema (singleton, version) VALUES (1, 0)");
		const row = await transaction.get<SchemaRow>("SELECT version FROM durable_schema WHERE singleton = 1");
		if (row === undefined) throw new Error("Durable SQLite schema metadata is missing");
		const currentVersion = migrations.at(-1)?.version ?? 0;
		if (row.version > currentVersion) {
			throw new Error(
				`Durable SQLite schema version ${row.version} is newer than supported version ${currentVersion}`,
			);
		}
		for (const migration of migrations) {
			if (migration.version <= row.version) continue;
			for (const statement of migration.statements) await transaction.exec(statement);
			await transaction.run("UPDATE durable_schema SET version = ? WHERE singleton = 1", migration.version);
		}
	});
}
