'use strict';

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

const path = require('path');

const DEFAULT_DB_PATH = path.join(__dirname, '../advisors.db');

// Suppress the ExperimentalWarning emitted when requiring node:sqlite on Node 22/24.
// Uses a targeted process.on('warning') handler rather than monkeypatching process.emit.
process.on('warning', (warning) => {
  if (
    warning?.name === 'ExperimentalWarning' &&
    String(warning?.message || '').includes('SQLite')
  ) {
    // swallow only this specific warning
  }
});

const { DatabaseSync } = require('node:sqlite');

function openDb(dbPath) {
  const resolved = dbPath || DEFAULT_DB_PATH;
  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  return db;
}

function dbRun(db, sql, params) {
  if (!params || params.length === 0) {
    db.exec(sql);
  } else {
    db.prepare(sql).run(...params);
  }
}

function dbAll(db, sql, params) {
  const stmt = db.prepare(sql);
  return params && params.length > 0 ? stmt.all(...params) : stmt.all();
}

function dbGet(db, sql, params) {
  const rows = dbAll(db, sql, params);
  return rows[0] ?? null;
}

module.exports = { openDb, dbRun, dbAll, dbGet, DEFAULT_DB_PATH };
