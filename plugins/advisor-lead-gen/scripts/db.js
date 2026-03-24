/**
 * db.js — shared SQLite helper using node:sqlite (built-in Node 22.5+).
 * No external npm packages, no sqlite3 CLI required.
 *
 * API:
 *   openDb(dbPath?)  → DatabaseSync instance (remember to call .close() when done)
 *   dbRun(db, sql, params?)  → void
 *   dbAll(db, sql, params?)  → row[]
 *   dbGet(db, sql, params?)  → row | null
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolveDomainDbPath() {
  const fromEnv = String(process.env.ADVISOR_DOMAIN_DB_PATH || "").trim();
  if (fromEnv) return fromEnv;

  const openclawHome = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
  return path.join(openclawHome, "advisor-lead-gen", "advisors.db");
}

export const DEFAULT_DB_PATH = resolveDomainDbPath();

// Suppress the ExperimentalWarning emitted by node:sqlite on Node 22/24.
// Guard prevents duplicate listeners if this module is somehow loaded more than once.
const _sqliteWarnKey = Symbol.for("openclaw:sqlite:warning:suppressed");
if (!process[_sqliteWarnKey]) {
  process[_sqliteWarnKey] = true;
  process.on("warning", (warning) => {
    if (
      warning?.name === "ExperimentalWarning" &&
      String(warning?.message || "").includes("SQLite")
    ) {
      // swallow only this specific warning
    }
  });
}

export function openDb(dbPath) {
  const resolved = dbPath || DEFAULT_DB_PATH;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
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
