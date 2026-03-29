import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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

export function openDb(dbPath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
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
