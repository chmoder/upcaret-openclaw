import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_ENGINE_DB_PATH = path.join(__dirname, "..", "enrichment.db");

// Guard prevents duplicate listeners if this module is somehow loaded more than once.
const _sqliteWarnKey = Symbol.for("openclaw:sqlite:warning:suppressed");
if (!process[_sqliteWarnKey]) {
  process[_sqliteWarnKey] = true;
  process.on("warning", (warning) => {
    if (
      warning?.name === "ExperimentalWarning" &&
      String(warning?.message || "").includes("SQLite")
    ) {
      // Ignore only node:sqlite experimental warning.
    }
  });
}

export function openDb(dbPath) {
  const resolved = dbPath || DEFAULT_ENGINE_DB_PATH;
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  return db;
}

export function dbRun(db, sql, params) {
  if (!params || params.length === 0) {
    db.exec(sql);
  } else {
    db.prepare(sql).run(...params);
  }
}

export function dbAll(db, sql, params) {
  const stmt = db.prepare(sql);
  return params && params.length > 0 ? stmt.all(...params) : stmt.all();
}

export function dbGet(db, sql, params) {
  const rows = dbAll(db, sql, params);
  return rows[0] ?? null;
}
