import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

export function resolveEnrichmentDbPath() {
  const fromEnv = String(process.env.ENRICHMENT_DB_PATH || "").trim();
  if (fromEnv) return fromEnv;

  const openclawHome =
    process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
  return path.join(openclawHome, "enrichment", "enrichment.db");
}

export const DEFAULT_DB_PATH = resolveEnrichmentDbPath();

const _sqliteWarnKey = Symbol.for("openclaw:sqlite:warning:suppressed");
if (!process[_sqliteWarnKey]) {
  process[_sqliteWarnKey] = true;
  process.on("warning", (warning) => {
    if (
      warning?.name === "ExperimentalWarning" &&
      String(warning?.message || "").includes("SQLite")
    ) {
      // swallow only node:sqlite experimental warning
    }
  });
}

const _sqliteEmitWarnKey = Symbol.for("openclaw:sqlite:emitWarning:patched");
if (!process[_sqliteEmitWarnKey]) {
  process[_sqliteEmitWarnKey] = true;
  const orig = process.emitWarning;
  process.emitWarning = function patchedEmitWarning(warning, ...rest) {
    try {
      const msg =
        typeof warning === "string"
          ? warning
          : String(warning?.message || "");
      const name =
        typeof warning === "object" && warning
          ? String(warning?.name || "")
          : "";
      if (
        name === "ExperimentalWarning" &&
        msg.includes("SQLite is an experimental feature")
      ) {
        return;
      }
    } catch {}
    return orig.call(this, warning, ...rest);
  };
}

const _sqliteRequireKey = Symbol.for("openclaw:sqlite:require");
function getDatabaseSync() {
  if (process[_sqliteRequireKey]) return process[_sqliteRequireKey];
  const require = createRequire(import.meta.url);
  // Requiring after warning handler prevents the ExperimentalWarning from printing.
  const mod = require("node:sqlite");
  const DatabaseSync = mod?.DatabaseSync;
  if (!DatabaseSync) {
    throw new Error("node:sqlite DatabaseSync unavailable (requires Node 22+)");
  }
  process[_sqliteRequireKey] = DatabaseSync;
  return DatabaseSync;
}

export function openDb(dbPath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const DatabaseSync = getDatabaseSync();
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  return db;
}

export function dbRun(db, sql, params = []) {
  if (!params || params.length === 0) {
    db.exec(sql);
  } else {
    db.prepare(sql).run(...params);
  }
}

export function dbAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  return params && params.length > 0 ? stmt.all(...params) : stmt.all();
}

export function dbGet(db, sql, params = []) {
  const rows = dbAll(db, sql, params);
  return rows[0] ?? null;
}

export function newJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
