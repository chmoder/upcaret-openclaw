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

export function openDb(dbPath = resolveEnrichmentDbPath()) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  return db;
}
