#!/usr/bin/env -S node --no-warnings

import { openDb, resolveEnrichmentDbPath } from "./db.js";
import { initSchema } from "./db-init.js";

function asString(v) {
  return String(v ?? "").trim();
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    command: args[0] || "help",
    limit: 25,
    offset: 0,
    q: "",
    profileId: "",
    findingType: "",
    includeSourceData: false,
    includeSourceContent: false,
    findingsLimit: 50,
  };

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if ((a === "--limit" || a === "-n") && args[i + 1]) {
      out.limit = Math.max(1, Number.parseInt(args[++i], 10) || out.limit);
    } else if (a === "--offset" && args[i + 1]) {
      out.offset = Math.max(0, Number.parseInt(args[++i], 10) || 0);
    } else if ((a === "--q" || a === "--query") && args[i + 1]) {
      out.q = String(args[++i]);
    } else if (a === "--profile-id" && args[i + 1]) {
      out.profileId = String(args[++i]);
    } else if (a === "--finding-type" && args[i + 1]) {
      out.findingType = String(args[++i]);
    } else if (a === "--include-source-data") {
      out.includeSourceData = true;
    } else if (a === "--include-source-content") {
      out.includeSourceContent = true;
    } else if (a === "--findings-limit" && args[i + 1]) {
      out.findingsLimit = Math.max(
        0,
        Number.parseInt(args[++i], 10) || out.findingsLimit,
      );
    } else if (a === "--help" || a === "-h") {
      out.command = "help";
    }
  }
  return out;
}

function likeWrap(q) {
  const v = asString(q);
  if (!v) return "";
  return `%${v.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}

function main() {
  const opts = parseArgs(process.argv);
  const dbPath = resolveEnrichmentDbPath();
  const db = openDb(dbPath);
  try {
    initSchema(db);

    if (opts.command === "help") {
      console.log(
        [
          "Usage:",
          "  node scripts/pull-data.js profiles [--limit N] [--offset N] [--q TEXT] [--include-source-data]",
          "  node scripts/pull-data.js profile --profile-id ID [--findings-limit N] [--include-source-data] [--include-source-content]",
          "  node scripts/pull-data.js findings [--limit N] [--offset N] [--profile-id ID] [--finding-type TYPE] [--q TEXT] [--include-source-content]",
          "",
          "Output: prints one line starting with PULLED:<json>",
        ].join("\n"),
      );
      process.exit(0);
    }

    if (opts.command === "profiles") {
      const qLike = likeWrap(opts.q);
      const where = qLike
        ? `WHERE (
             display_name LIKE ? ESCAPE '\\'
          OR first_name LIKE ? ESCAPE '\\'
          OR last_name LIKE ? ESCAPE '\\'
          OR current_employer LIKE ? ESCAPE '\\'
          OR current_title LIKE ? ESCAPE '\\'
        )`
        : "";
      const params = qLike ? [qLike, qLike, qLike, qLike, qLike] : [];

      const total = Number(
        db
          .prepare(`SELECT COUNT(*) AS c FROM profiles ${where}`)
          .get(...params)?.c || 0,
      );

      const cols = [
        "profile_id",
        "display_name",
        "first_name",
        "last_name",
        "current_employer",
        "current_title",
        "location_city",
        "location_state",
        "location_country",
        "industry",
        "enriched_at",
        "enrichment_status",
        "enrichment_score",
        "source_system",
        "source_key",
        "created_at",
        "updated_at",
      ];
      if (opts.includeSourceData) cols.push("source_data");

      const rows = db
        .prepare(
          `SELECT ${cols.join(", ")}
           FROM profiles
           ${where}
           ORDER BY datetime(created_at) DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, opts.limit, opts.offset);

      console.log(
        `PULLED:${JSON.stringify({
          kind: "profiles",
          db_path: dbPath,
          query: { q: opts.q || null, limit: opts.limit, offset: opts.offset },
          total,
          items: rows,
        })}`,
      );
      return;
    }

    if (opts.command === "profile") {
      const pid = asString(opts.profileId);
      if (!pid) {
        console.error("ERROR: profile requires --profile-id");
        process.exit(1);
      }

      const pCols = [
        "profile_id",
        "display_name",
        "first_name",
        "last_name",
        "middle_name",
        "current_employer",
        "current_title",
        "location_city",
        "location_state",
        "location_country",
        "industry",
        "enriched_at",
        "enrichment_status",
        "enrichment_score",
        "enrichment_score_reason",
        "source_system",
        "source_key",
        "created_at",
        "updated_at",
      ];
      if (opts.includeSourceData) pCols.push("source_data");

      const profile = db
        .prepare(
          `SELECT ${pCols.join(", ")}
           FROM profiles
           WHERE profile_id = ?
           LIMIT 1`,
        )
        .get(pid);
      if (!profile) {
        console.log(
          `PULLED:${JSON.stringify({
            kind: "profile",
            db_path: dbPath,
            profile_id: pid,
            found: false,
          })}`,
        );
        return;
      }

      const fCols = [
        "finding_id",
        "finding_type",
        "finding_value",
        "confidence",
        "source_name",
        "source_url",
        "agent_name",
        "is_trigger_event",
        "created_at",
      ];
      if (opts.includeSourceContent) fCols.push("source_content");

      const findings = opts.findingsLimit === 0
        ? []
        : db
            .prepare(
              `SELECT ${fCols.join(", ")}
               FROM findings
               WHERE profile_id = ?
               ORDER BY datetime(created_at) DESC
               LIMIT ?`,
            )
            .all(pid, opts.findingsLimit);

      const findingsCount = Number(
        db
          .prepare(`SELECT COUNT(*) AS c FROM findings WHERE profile_id = ?`)
          .get(pid)?.c || 0,
      );

      console.log(
        `PULLED:${JSON.stringify({
          kind: "profile",
          db_path: dbPath,
          found: true,
          profile,
          findings: {
            total: findingsCount,
            limit: opts.findingsLimit,
            items: findings,
          },
        })}`,
      );
      return;
    }

    if (opts.command === "findings") {
      const qLike = likeWrap(opts.q);
      const pid = asString(opts.profileId);
      const fType = asString(opts.findingType);
      const clauses = [];
      const params = [];
      if (pid) {
        clauses.push("profile_id = ?");
        params.push(pid);
      }
      if (fType) {
        clauses.push("finding_type = ?");
        params.push(fType);
      }
      if (qLike) {
        clauses.push(
          `(finding_type LIKE ? ESCAPE '\\' OR finding_value LIKE ? ESCAPE '\\' OR source_url LIKE ? ESCAPE '\\' OR source_name LIKE ? ESCAPE '\\')`,
        );
        params.push(qLike, qLike, qLike, qLike);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

      const total = Number(
        db
          .prepare(`SELECT COUNT(*) AS c FROM findings ${where}`)
          .get(...params)?.c || 0,
      );

      const cols = [
        "finding_id",
        "profile_id",
        "finding_type",
        "finding_value",
        "confidence",
        "source_name",
        "source_url",
        "agent_name",
        "is_trigger_event",
        "created_at",
      ];
      if (opts.includeSourceContent) cols.push("source_content");

      const rows = db
        .prepare(
          `SELECT ${cols.join(", ")}
           FROM findings
           ${where}
           ORDER BY datetime(created_at) DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, opts.limit, opts.offset);

      console.log(
        `PULLED:${JSON.stringify({
          kind: "findings",
          db_path: dbPath,
          query: {
            profile_id: pid || null,
            finding_type: fType || null,
            q: opts.q || null,
            limit: opts.limit,
            offset: opts.offset,
          },
          total,
          items: rows,
        })}`,
      );
      return;
    }

    console.error(`ERROR: unknown command "${opts.command}" (run with --help)`);
    process.exit(1);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error(`ERROR:${err?.message || String(err)}`);
  process.exit(1);
}

