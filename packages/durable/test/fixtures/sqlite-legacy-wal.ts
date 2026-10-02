import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const path = process.argv[2];
if (path === undefined) throw new Error("Missing SQLite fixture path");
const database = new DatabaseSync(path);
database.exec("PRAGMA journal_mode = WAL");
database.exec("PRAGMA wal_autocheckpoint = 0");
database.exec(readFileSync(new URL("./sqlite-schema-v1-a45d9776.sql", import.meta.url), "utf8"));
database.exec("INSERT INTO conversations (id, record) VALUES (1, '{\"id\":1}')");
// Leave committed records in the WAL, as after process interruption, without closing the connection.
process.exit(0);
