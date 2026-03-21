#!/usr/bin/env node

/**
 * orchestrator.js — Advisor Enrichment Orchestrator (OpenClaw Agent Version)
 * 
 * This runs as a persistent OpenClaw agent session.
 * 
 * IMPORTANT: OpenClaw `sessions_spawn` is non-blocking. Sub-agent results arrive later
 * via announce/transcript, so this orchestrator MUST be a turn-based state machine:
 *   - Turn 1: receive ENRICH → spawn specialists → persist childSessionKeys → sessions_yield
 *   - Turn 2+: poll pending rows → sessions_history(childSessionKey) → merge → spawn scorer → yield
 *   - Final: save to DB → reply DONE
 * 
 * To use:
 *   1. Register as an agent in openclaw.json (or deploy as skill agent)
 *   2. Main agent sends: sessions_send(label="lead-gen", message="ENRICH:{...advisor_json...}")
 *   3. Orchestrator spawns 10 specialists in parallel
 *   4. Replies with DONE:{...summary...}
 * 
 * For local testing:
 *   node orchestrator.js 'ENRICH:{"sec_id":4167394,"first_name":"Chris",...}'
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { validateApiKeys, envErrorMessage, envStatus, formatEnvHelp, ENV_SPECS } = require('./env');

// Paths
const SKILL_DIR = path.join(__dirname, '..');
const AGENTS_DIR = path.join(SKILL_DIR, 'agents');
const DB_PATH = path.join(SKILL_DIR, 'advisors.db');

const SPECIALISTS = [
  'profile', 'email', 'phone', 'website', 'linkedin',
  'cert', 'award', 'speaking', 'news', 'network'
];

const FINDING_TYPE_MAP = {
  profile: { mergedKey: 'urls', findingType: 'profile_url' },
  email: { mergedKey: 'emails', findingType: 'email' },
  phone: { mergedKey: 'phones', findingType: 'phone' },
  website: { mergedKey: 'websites', findingType: 'website' },
  linkedin: { mergedKey: 'linkedin', findingType: 'linkedin_url' },
  cert: { mergedKey: 'certifications', findingType: 'certification' },
  award: { mergedKey: 'awards', findingType: 'award' },
  speaking: { mergedKey: 'speaking', findingType: 'speaking_engagement' },
  news: { mergedKey: 'news', findingType: 'news_mention' },
  network: { mergedKey: 'network', findingType: 'network' }
};

function parseLeadgenCommand(message) {
  const raw = String(message || '').trim();
  if (!raw) return null;

  // Direct orchestrator commands (for main-agent / leadgen routing)
  if (raw.toUpperCase() === 'ENV') return { cmd: 'env', mode: 'status' };
  if (raw.toUpperCase() === 'ENV:HELP') return { cmd: 'env', mode: 'help' };
  if (raw.toUpperCase() === 'ENV:STATUS') return { cmd: 'env', mode: 'status' };
  if (raw.toUpperCase() === 'STATUS') return { cmd: 'status', secId: null };
  if (raw.toUpperCase().startsWith('STATUS:')) {
    const rest = raw.slice('STATUS:'.length).trim();
    const secId = parseInt(rest, 10);
    return Number.isFinite(secId) ? { cmd: 'status', secId } : { cmd: 'status', secId: null };
  }

  // Slash command style (user-facing)
  if (!raw.toLowerCase().startsWith('/leadgen')) return null;
  const rest = raw.slice('/leadgen'.length).trim();
  if (!rest) return { cmd: 'help' };

  const parts = rest.split(/\s+/).filter(Boolean);
  const sub = (parts[0] || '').toLowerCase();
  if (sub === 'env') {
    const mode = (parts[1] || 'status').toLowerCase();
    return { cmd: 'env', mode: mode === 'help' ? 'help' : 'status' };
  }
  if (sub === 'status') {
    const secId = parts[1] ? parseInt(parts[1], 10) : null;
    return { cmd: 'status', secId: Number.isFinite(secId) ? secId : null };
  }
  if (sub === 'help') return { cmd: 'help' };
  return null;
}

function envReportPayload() {
  const requireAllApiKeys = process.env.LEADGEN_REQUIRE_ALL_API_KEYS === '1';
  const specs = (envStatus && typeof envStatus === 'function') ? envStatus() : (ENV_SPECS || []).map((s) => ({
    ...s,
    set: Boolean(process.env[s.name] && String(process.env[s.name]).length > 0),
    masked: ''
  }));

  const mustHave = (s) => (s.kind === 'api_key') && (requireAllApiKeys ? true : Boolean(s.required));
  const missingRequired = specs.filter((s) => mustHave(s) && !s.set).map((s) => s.name);
  const missingOptional = specs
    .filter((s) => s.kind === 'api_key' && !mustHave(s) && !s.set)
    .map((s) => s.name);

  const howToSet = {};
  for (const s of specs) howToSet[s.name] = Array.isArray(s.howToSet) ? s.howToSet : [];

  return {
    type: 'env',
    strict_api_keys: requireAllApiKeys,
    vars: specs.map((s) => ({
      name: s.name,
      kind: s.kind,
      required: Boolean(s.required),
      set: Boolean(s.set),
      masked: s.masked || '',
      description: s.description || ''
    })),
    missing_required: missingRequired,
    missing_optional_api_keys: missingOptional,
    how_to_set: howToSet
  };
}

async function statusDashboardPayload({ secId = null, limit = 10 } = {}) {
  const db = getDB();

  async function hasTable(tableName) {
    const row = await dbGet(
      db,
      `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name = ?;`,
      [tableName]
    );
    return Number(row?.c || 0) > 0;
  }

  const payload = {
    type: 'status_dashboard',
    now: new Date().toISOString(),
    db_path: DB_PATH,
    tables: {
      advisors: false,
      advisor_findings: false,
      pending_enrichments: false,
    },
    totals: {},
    active_runs: [],
    recent_enriched: [],
    recent_failed: [],
    sec_id_detail: null,
  };

  try {
    payload.tables.advisors = await hasTable('advisors');
    payload.tables.advisor_findings = await hasTable('advisor_findings');
    payload.tables.pending_enrichments = await hasTable('pending_enrichments');
  } catch (e) {
    return { ...payload, error: 'db_unavailable', message: e?.message || String(e) };
  }

  if (payload.tables.advisors) {
    const advisorsTotal = await dbGet(db, `SELECT COUNT(*) AS c FROM advisors;`);
    const advisorsEnriched = await dbGet(db, `SELECT COUNT(*) AS c FROM advisors WHERE enriched_at IS NOT NULL;`);
    const advisorsScored = await dbGet(db, `SELECT COUNT(*) AS c FROM advisors WHERE lead_score IS NOT NULL AND lead_score > 0;`);
    payload.totals.advisors_total = Number(advisorsTotal?.c || 0);
    payload.totals.advisors_enriched = Number(advisorsEnriched?.c || 0);
    payload.totals.advisors_scored = Number(advisorsScored?.c || 0);

    const recent = await dbAll(
      db,
      `
      SELECT
        sec_id, first_name, last_name, firm_name, city, state, lead_score, enriched_at
      FROM advisors
      WHERE enriched_at IS NOT NULL
      ORDER BY enriched_at DESC
      LIMIT ?;
      `,
      [limit]
    );
    payload.recent_enriched = (recent || []).map((r) => ({
      sec_id: Number(r.sec_id),
      name: [r.first_name, r.last_name].filter(Boolean).join(' '),
      firm_name: r.firm_name || '',
      city: r.city || '',
      state: r.state || '',
      lead_score: r.lead_score === null || r.lead_score === undefined ? null : Number(r.lead_score),
      enriched_at: r.enriched_at || null,
    }));
  }

  if (payload.tables.pending_enrichments) {
    const pendingRows = await dbGet(db, `SELECT COUNT(*) AS c FROM pending_enrichments WHERE status='PENDING';`);
    const failedRows = await dbGet(db, `SELECT COUNT(*) AS c FROM pending_enrichments WHERE status='FAILED';`);
    const pendingSecIds = await dbGet(db, `SELECT COUNT(DISTINCT sec_id) AS c FROM pending_enrichments WHERE status='PENDING';`);
    payload.totals.pending_rows = Number(pendingRows?.c || 0);
    payload.totals.failed_rows = Number(failedRows?.c || 0);
    payload.totals.pending_sec_ids = Number(pendingSecIds?.c || 0);

    const active = await dbAll(
      db,
      `
      WITH per AS (
        SELECT
          sec_id,
          MIN(spawned_at) AS started_at,
          MAX(COALESCE(completed_at, spawned_at)) AS last_activity_at,
          SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END) AS pending_count,
          SUM(CASE WHEN status='DONE' THEN 1 ELSE 0 END) AS done_count,
          SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failed_count
        FROM pending_enrichments
        GROUP BY sec_id
      )
      SELECT *
      FROM per
      WHERE pending_count > 0
      ORDER BY last_activity_at DESC
      LIMIT ?;
      `,
      [limit]
    );

    let advisorBySec = {};
    if (payload.tables.advisors && (active || []).length > 0) {
      const secIds = active.map((r) => Number(r.sec_id)).filter((n) => Number.isFinite(n));
      if (secIds.length > 0) {
        const list = secIds.join(',');
        const rows = await dbAll(
          db,
          `
          SELECT sec_id, first_name, last_name, firm_name, city, state
          FROM advisors
          WHERE sec_id IN (${list});
          `
        );
        for (const r of (rows || [])) {
          advisorBySec[Number(r.sec_id)] = {
            name: [r.first_name, r.last_name].filter(Boolean).join(' '),
            firm_name: r.firm_name || '',
            city: r.city || '',
            state: r.state || '',
          };
        }
      }
    }

    payload.active_runs = (active || []).map((r) => {
      const sec = Number(r.sec_id);
      const a = advisorBySec[sec] || {};
      return {
        sec_id: sec,
        name: a.name || '',
        firm_name: a.firm_name || '',
        city: a.city || '',
        state: a.state || '',
        started_at: r.started_at || null,
        last_activity_at: r.last_activity_at || null,
        pending_count: Number(r.pending_count || 0),
        done_count: Number(r.done_count || 0),
        failed_count: Number(r.failed_count || 0),
      };
    });

    const failed = await dbAll(
      db,
      `
      SELECT sec_id, specialist, error, completed_at
      FROM pending_enrichments
      WHERE status='FAILED'
      ORDER BY COALESCE(completed_at, spawned_at) DESC
      LIMIT ?;
      `,
      [limit]
    );
    payload.recent_failed = (failed || []).map((r) => ({
      sec_id: Number(r.sec_id),
      specialist: r.specialist || '',
      error: r.error || '',
      completed_at: r.completed_at || null,
    }));
  }

  if (Number.isFinite(secId) && secId !== null) {
    const detail = { sec_id: Number(secId) };
    if (payload.tables.advisors) {
      const a = await dbGet(
        db,
        `
        SELECT sec_id, first_name, last_name, firm_name, city, state, lead_score, enriched_at, updated_at
        FROM advisors
        WHERE sec_id = ?
        LIMIT 1;
        `,
        [secId]
      );
      if (a) {
        detail.advisor = {
          sec_id: Number(a.sec_id),
          name: [a.first_name, a.last_name].filter(Boolean).join(' '),
          firm_name: a.firm_name || '',
          city: a.city || '',
          state: a.state || '',
          lead_score: a.lead_score === null || a.lead_score === undefined ? null : Number(a.lead_score),
          enriched_at: a.enriched_at || null,
          updated_at: a.updated_at || null,
        };
      }
    }
    if (payload.tables.pending_enrichments) {
      const rows = await dbAll(
        db,
        `
        SELECT specialist, status, spawned_at, completed_at, error
        FROM pending_enrichments
        WHERE sec_id = ?
        ORDER BY specialist;
        `,
        [secId]
      );
      detail.specialists = (rows || []).map((r) => ({
        specialist: r.specialist || '',
        status: r.status || '',
        spawned_at: r.spawned_at || null,
        completed_at: r.completed_at || null,
        error: r.error || null,
      }));
    }
    payload.sec_id_detail = detail;
  }

  return payload;
}

function handleTopLevelCommand(message) {
  const cmd = parseLeadgenCommand(message);
  if (!cmd) return null;

  if (cmd.cmd === 'env') {
    const payload = envReportPayload();
    if (cmd.mode === 'help') {
      payload.help_text = (formatEnvHelp && typeof formatEnvHelp === 'function') ? formatEnvHelp() : '';
    }
    return `DONE:${JSON.stringify(payload)}`;
  }

  if (cmd.cmd === 'status') {
    return statusDashboardPayload({ secId: cmd.secId }).then((payload) => `DONE:${JSON.stringify(payload)}`);
  }

  if (cmd.cmd === 'help') {
    const help = [
      'LeadGen commands:',
      '- /leadgen env',
      '- /leadgen env help',
      '- /leadgen status',
      '- /leadgen status <sec_id>',
      '',
      'If you are an operator, you can also run: npm run env:help'
    ].join('\n');
    return `DONE:${JSON.stringify({ type: 'help', text: help })}`;
  }

  return null;
}

// If a child session doesn't produce parseable JSON, we keep it PENDING until it's stale.
// Stale PENDING rows are marked FAILED so the orchestrator can complete the run with partial results.
const PENDING_STALE_SECONDS = 15 * 60; // 15 minutes

function isOpenClawContext() {
  return (
    typeof sessions_spawn !== 'undefined' &&
    typeof sessions_history !== 'undefined' &&
    typeof sessions_yield !== 'undefined'
  );
}

function getDB() {
  return { close: () => {} };
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function bindSql(sql, params = []) {
  if (!params || params.length === 0) return sql;
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = params[i++];
    return sqlLiteral(v);
  });
}

function execSql(sql, jsonMode = false) {
  return new Promise((resolve, reject) => {
    const args = jsonMode ? ['-json', DB_PATH, sql] : [DB_PATH, sql];
    execFile('sqlite3', args, { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(err);
      else if (stderr && stderr.trim()) reject(new Error(stderr.trim()));
      else resolve(stdout || '');
    });
  });
}

function dbRun(_db, sql, params = []) {
  return execSql(bindSql(sql, params), false);
}

function dbAll(db, sql, params = []) {
  const _dbUnused = db;
  void _dbUnused;
  return execSql(bindSql(sql, params), true).then((out) => {
    const trimmed = out.trim();
    if (!trimmed) return [];
    try {
      return JSON.parse(trimmed);
    } catch {
      return [];
    }
  });
}

function dbGet(db, sql, params = []) {
  return dbAll(db, sql, params).then((rows) => (rows[0] || null));
}

function requiredSpecialistFiles() {
  return [...SPECIALISTS, 'scorer'].map((name) => path.join(AGENTS_DIR, `${name}.md`));
}

async function runPreflight() {
  const errors = [];

  const requireAllApiKeys = process.env.LEADGEN_REQUIRE_ALL_API_KEYS === '1';
  const envCheck = validateApiKeys({ requireAll: requireAllApiKeys });
  if (!envCheck.ok) {
    errors.push(envErrorMessage(envCheck.missing));
  }

  for (const file of requiredSpecialistFiles()) {
    if (!fs.existsSync(file)) {
      errors.push(`Missing specialist prompt file: ${file}`);
    }
  }

  try {
    // Ensure DB path is writable/creatable.
    fs.closeSync(fs.openSync(DB_PATH, 'a'));
  } catch (err) {
    errors.push(`Database is not writable at ${DB_PATH}: ${err.message}`);
  }

  if (errors.length > 0) {
    throw new Error(`Preflight failed:\n- ${errors.join('\n- ')}`);
  }
}

function looksLikeFatalChildError(text) {
  if (!text) return false;
  const t = String(text);
  return (
    t.includes('Preflight failed') ||
    t.includes('Missing required environment variables') ||
    t.includes('Fatal error') ||
    t.includes('Error:') ||
    t.includes('Cannot find module')
  );
}

function summarizeChildError(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.slice(0, 3).join(' | ').slice(0, 280);
}

async function ensureSchema() {
  const db = getDB();
  try {
    await dbRun(
      db,
      `
      CREATE TABLE IF NOT EXISTS advisors (
        sec_id INTEGER PRIMARY KEY,
        first_name TEXT NOT NULL,
        middle_name TEXT,
        last_name TEXT NOT NULL,
        alternate_names TEXT,
        firm_id INTEGER,
        firm_name TEXT,
        city TEXT,
        state TEXT,
        zip TEXT,
        registration_status TEXT,
        investment_advisor_only INTEGER,
        disclosure_flag TEXT,
        finra_registration_count INTEGER,
        employment_count INTEGER,
        last_updated_iapd TEXT,
        raw_employment_data TEXT,
        email TEXT,
        phone TEXT,
        firm_website TEXT,
        linkedin_url TEXT,
        linkedin_handle TEXT,
        enrichment_notes TEXT,
        lead_score INTEGER DEFAULT 0,
        lead_score_reason TEXT,
        validation_status TEXT DEFAULT 'pending',
        agents_processed TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        enriched_at DATETIME
      );
      `
    );

    await dbRun(
      db,
      `
      CREATE TABLE IF NOT EXISTS advisor_findings (
        finding_id INTEGER PRIMARY KEY AUTOINCREMENT,
        sec_id INTEGER NOT NULL,
        finding_type TEXT NOT NULL,
        finding_value TEXT,
        source_name TEXT,
        source_url TEXT,
        source_content TEXT,
        agent_name TEXT,
        confidence TEXT DEFAULT 'medium',
        is_trigger_event INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(sec_id) REFERENCES advisors(sec_id)
      );
      `
    );

    await dbRun(
      db,
      `
      CREATE TABLE IF NOT EXISTS pending_enrichments (
        sec_id INTEGER NOT NULL,
        specialist TEXT NOT NULL,
        childSessionKey TEXT NOT NULL,
        runId TEXT,
        advisor_json TEXT,
        result_json TEXT,
        spawned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        status TEXT NOT NULL DEFAULT 'PENDING',
        error TEXT,
        PRIMARY KEY (sec_id, specialist)
      );
      `
    );
    await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_pending_enrichments_status ON pending_enrichments(status);`);
    await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_pending_enrichments_spawned ON pending_enrichments(spawned_at);`);
    await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_advisors_enriched_at ON advisors(enriched_at);`);
    await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_findings_sec_type ON advisor_findings(sec_id, finding_type);`);

    // Backward-compatible migrations for older local DBs.
    const findingsCols = (await dbAll(db, `PRAGMA table_info(advisor_findings);`)).map((c) => c.name);
    if (!findingsCols.includes('agent_name')) {
      await dbRun(db, `ALTER TABLE advisor_findings ADD COLUMN agent_name TEXT;`);
    }
    if (!findingsCols.includes('is_trigger_event')) {
      await dbRun(db, `ALTER TABLE advisor_findings ADD COLUMN is_trigger_event INTEGER DEFAULT 0;`);
    }

    const advisorsCols = (await dbAll(db, `PRAGMA table_info(advisors);`)).map((c) => c.name);
    if (!advisorsCols.includes('created_at')) {
      await dbRun(db, `ALTER TABLE advisors ADD COLUMN created_at DATETIME;`);
    }
  } finally {
    db.close();
  }
}

/**
 * Load specialist .md file and append the RESEARCH task
 */
function buildSpecialistTask(specialist, advisorJson) {
  const mdFile = path.join(AGENTS_DIR, `${specialist}.md`);
  try {
    const mdContent = fs.readFileSync(mdFile, 'utf8');
    return `${mdContent}\n\n---\n\nRESEARCH:${advisorJson}`;
  } catch (err) {
    console.error(`❌ Failed to load ${specialist}.md: ${err.message}`);
    return null;
  }
}

/**
 * Upsert a pending row for this specialist spawn
 */
async function upsertPendingSpawn(secId, specialist, advisorJson, childSessionKey, runId) {
  const db = getDB();
  try {
    await dbRun(
      db,
      `
      INSERT INTO pending_enrichments
        (sec_id, specialist, childSessionKey, runId, advisor_json, status, error, completed_at)
      VALUES
        (?, ?, ?, ?, ?, 'PENDING', NULL, NULL)
      ON CONFLICT(sec_id, specialist) DO UPDATE SET
        childSessionKey = excluded.childSessionKey,
        runId = excluded.runId,
        advisor_json = excluded.advisor_json,
        status = 'PENDING',
        error = NULL,
        result_json = NULL,
        spawned_at = datetime('now'),
        completed_at = NULL;
      `,
      [secId, specialist, childSessionKey, runId || null, advisorJson]
    );
  } finally {
    db.close();
  }
}

/**
 * Spawn all specialists and persist childSessionKeys.
 * NOTE: sessions_spawn is non-blocking; we yield after scheduling.
 */
async function spawnAllSpecialists(advisor, advisorJson) {
  console.log(`\n📤 Spawning ${SPECIALISTS.length} specialists in parallel...\n`);

  const tasks = [];
  for (const specialist of SPECIALISTS) {
    const task = buildSpecialistTask(specialist, advisorJson);
    if (!task) continue;
    tasks.push({ specialist, task });
  }

  const outcomes = await Promise.allSettled(
    tasks.map(({ task, specialist }) =>
      sessions_spawn({
        task,
        mode: 'run',
        runTimeoutSeconds: 90,
        label: `lg-${specialist}`
      }).then((res) => ({ specialist, res }))
    )
  );

  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled') {
      const { specialist, res } = outcome.value;
      const childSessionKey = res.childSessionKey;
      const runId = res.runId;
      await upsertPendingSpawn(advisor.sec_id, specialist, advisorJson, childSessionKey, runId);
      console.log(`  ✅ ${specialist.padEnd(12)} → ${String(childSessionKey).substring(0, 30)}...`);
    } else {
      const errMsg = outcome.reason?.message || String(outcome.reason || 'spawn_failed');
      console.error(`  ❌ spawn failed: ${errMsg}`);
    }
  }
}

/**
 * Extract text content from a sessions_history message record.
 */
function extractMessageText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => {
        if (!c) return '';
        if (typeof c === 'string') return c;
        if (typeof c.text === 'string') return c.text;
        if (typeof c.content === 'string') return c.content;
        return '';
      })
      .join('\n');
  }
  if (typeof msg.text === 'string') return msg.text;
  return '';
}

function tryParseJsonObject(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Merge all specialist results into one findings object
 */
function mergeFindings(advisor, specialistResults) {
  const merged = {
    sec_id: advisor.sec_id,
    name: `${advisor.first_name} ${advisor.last_name}`,
    firm: advisor.firm_name,
    findings: {
      urls: [],
      emails: [],
      phones: [],
      websites: [],
      linkedin: [],
      certifications: [],
      awards: [],
      speaking: [],
      news: [],
      network: []
    }
  };

  for (const specialist of SPECIALISTS) {
    const res = specialistResults[specialist];
    if (!res) continue;

    switch (specialist) {
      case 'profile':
        merged.findings.urls = Array.isArray(res.urls) ? res.urls : [];
        break;
      case 'email':
        merged.findings.emails = Array.isArray(res.emails) ? res.emails : [];
        break;
      case 'phone':
        merged.findings.phones = Array.isArray(res.phones) ? res.phones : [];
        break;
      case 'website':
        merged.findings.websites = Array.isArray(res.websites) ? res.websites : [];
        break;
      case 'linkedin':
        merged.findings.linkedin = Array.isArray(res.linkedin) ? res.linkedin : [];
        break;
      case 'cert':
        merged.findings.certifications = Array.isArray(res.certifications) ? res.certifications : [];
        break;
      case 'award':
        merged.findings.awards = Array.isArray(res.awards) ? res.awards : [];
        break;
      case 'speaking':
        merged.findings.speaking = Array.isArray(res.speaking) ? res.speaking : [];
        break;
      case 'news':
        merged.findings.news = Array.isArray(res.news) ? res.news : [];
        break;
      case 'network':
        merged.findings.network = Array.isArray(res.network) ? res.network : [];
        break;
      default:
        break;
    }
  }

  return merged;
}

/**
 * Spawn scorer sub-agent and persist its childSessionKey.
 */
async function spawnScorer(secId, mergedFindings, advisorJson) {
  const scorerMd = fs.readFileSync(path.join(AGENTS_DIR, 'scorer.md'), 'utf8');
  const task = `${scorerMd}\n\n---\n\nSCORE:${JSON.stringify(mergedFindings)}`;

  console.log(`\n🧠 Spawning scorer...\n`);
  const res = await sessions_spawn({
    task,
    mode: 'run',
    runTimeoutSeconds: 60,
    label: 'lg-scorer'
  });

  await upsertPendingSpawn(secId, 'scorer', advisorJson, res.childSessionKey, res.runId);
  console.log(`  ✅ scorer → ${String(res.childSessionKey).substring(0, 30)}...`);
}

/**
 * Persist findings + lead score into SQLite DB.
 */
async function saveToDB(advisor, mergedFindings, scoreResult) {
  const db = getDB();
  try {
    // Update advisor
    const leadScore = Number(scoreResult.lead_score || 0);
    const scoreReason = scoreResult.score_reason || scoreResult.lead_score_reason || '';

    await dbRun(
      db,
      `
      UPDATE advisors
      SET enriched_at = datetime('now'),
          updated_at = datetime('now'),
          lead_score = ?,
          lead_score_reason = ?,
          validation_status = CASE
            WHEN validation_status IS NULL OR validation_status = 'pending' THEN 'enriched'
            ELSE validation_status
          END
      WHERE sec_id = ?;
      `,
      [leadScore, scoreReason, advisor.sec_id]
    );

    // Insert findings
    const insertSql = `
      INSERT OR IGNORE INTO advisor_findings
        (sec_id, finding_type, finding_value, source_name, source_url, agent_name, confidence, created_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, datetime('now'));
    `;

    for (const specialist of SPECIALISTS) {
      const map = FINDING_TYPE_MAP[specialist];
      const items = mergedFindings.findings[map.mergedKey];
      if (!Array.isArray(items)) continue;

      for (const item of items) {
        if (!item) continue;
        const confidence = item.confidence || 'medium';

        let value = null;
        let sourceUrl = '';
        if (specialist === 'profile') {
          value = item.url || item.value || null;
          sourceUrl = item.url || '';
        } else if (specialist === 'website' || specialist === 'linkedin') {
          value = item.url || item.value || null;
          sourceUrl = item.source_url || item.url || '';
        } else if (specialist === 'network') {
          value = item.name || item.value || null;
          sourceUrl = item.source_url || item.url || '';
        } else if (specialist === 'speaking') {
          value = item.event || item.value || null;
          sourceUrl = item.source_url || item.url || '';
        } else if (specialist === 'news') {
          value = item.url || item.headline || item.value || null;
          sourceUrl = item.url || item.source_url || '';
        } else {
          value = item.value || null;
          sourceUrl = item.source_url || item.url || '';
        }

        if (!value) continue;

        await dbRun(db, insertSql, [
          advisor.sec_id,
          map.findingType,
          String(value),
          `lg-${specialist}`,
          String(sourceUrl || ''),
          `lg-${specialist}`,
          String(confidence),
        ]);
      }
    }
  } finally {
    db.close();
  }
}

/**
 * Main orchestration: process an ENRICH request
 */
async function processEnrichRequest(message) {
  console.log(`\n📨 Received message: ${message.substring(0, 80)}...\n`);

  // Parse ENRICH: message
  if (!message.startsWith('ENRICH:')) {
    console.error('❌ Invalid message format. Expected ENRICH:{...}');
    return;
  }

  let advisor;
  try {
    const jsonStr = message.substring(7); // Remove "ENRICH:"
    advisor = JSON.parse(jsonStr);
  } catch (err) {
    console.error(`❌ Failed to parse advisor JSON: ${err.message}`);
    return;
  }

  console.log(`🎯 Enriching: ${advisor.first_name} ${advisor.last_name}`);
  console.log(`   Firm: ${advisor.firm_name}`);
  console.log(`   CRD: ${advisor.crd || advisor.sec_id}`);
  console.log(`   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  try {
    const advisorJson = JSON.stringify(advisor);
    await spawnAllSpecialists(advisor, advisorJson);

    console.log(`\n⏳ Yielding (waiting for specialist announces)...\n`);
    await sessions_yield({ message: 'Waiting for specialists to complete' });
  } catch (err) {
    console.error(`\n❌ Enrichment failed: ${err.message}`);
  }
}

/**
 * Poll DB for pending rows and try to materialize results via sessions_history.
 * Returns a map: { [sec_id]: { advisor, resultsBySpecialist, readyForScoring, scoringDone, scoreResult } }
 */
async function pollPending() {
  const db = getDB();
  try {
    // Mark stale pending rows as failed (prevents infinite waiting).
    await dbRun(
      db,
      `
      UPDATE pending_enrichments
      SET status = 'FAILED',
          completed_at = datetime('now'),
          error = COALESCE(error, 'timeout_waiting_for_child_result')
      WHERE status = 'PENDING'
        AND spawned_at < datetime('now', '-' || ? || ' seconds');
      `,
      [PENDING_STALE_SECONDS]
    );

    const pendingRows = await dbAll(
      db,
      `SELECT sec_id, specialist, childSessionKey, advisor_json, status, result_json
       FROM pending_enrichments
       WHERE status = 'PENDING'
       ORDER BY spawned_at ASC`
    );

    if (pendingRows.length === 0) return {};

    const jobs = {};
    for (const row of pendingRows) {
      if (!jobs[row.sec_id]) {
        let advisor = null;
        try {
          advisor = row.advisor_json ? JSON.parse(row.advisor_json) : null;
        } catch {
          advisor = null;
        }
        jobs[row.sec_id] = { advisor, results: {} };
      }

      // Fetch child history and attempt parse
      let history;
      try {
        history = await sessions_history({ sessionKey: row.childSessionKey, includeTools: true, limit: 80 });
      } catch (e) {
        // Can't read history yet; keep pending
        continue;
      }

      const msgs = Array.isArray(history) ? history : (history?.messages || []);
      const assistantMsgs = msgs.filter((m) => (m.role || '').toLowerCase() === 'assistant');
      const lastAssistant = assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1] : null;
      const text = extractMessageText(lastAssistant);
      const parsed = tryParseJsonObject(text);
      if (!parsed) {
        // If the child produced a clear fatal error, fail it immediately so we can complete with partial results.
        if (looksLikeFatalChildError(text)) {
          await dbRun(
            db,
            `UPDATE pending_enrichments
             SET status = 'FAILED', completed_at = datetime('now'), error = ?
             WHERE sec_id = ? AND specialist = ?;`,
            [summarizeChildError(text), row.sec_id, row.specialist]
          );
        }
        continue;
      }

      // Persist result_json and mark DONE
      await dbRun(
        db,
        `UPDATE pending_enrichments
         SET status = 'DONE', result_json = ?, completed_at = datetime('now'), error = NULL
         WHERE sec_id = ? AND specialist = ?;`,
        [JSON.stringify(parsed), row.sec_id, row.specialist]
      );

      jobs[row.sec_id].results[row.specialist] = parsed;
    }

    // Also load already-DONE specialist results for any sec_id we touched (for merge/scoring decisions)
    const secIds = Object.keys(jobs);
    if (secIds.length > 0) {
      const placeholders = secIds.map(() => '?').join(',');
      const doneRows = await dbAll(
        db,
        `SELECT sec_id, specialist, advisor_json, result_json, status
         FROM pending_enrichments
         WHERE sec_id IN (${placeholders});`,
        secIds
      );

      for (const row of doneRows) {
        if (!jobs[row.sec_id]) continue;
        if (!jobs[row.sec_id].advisor && row.advisor_json) {
          try {
            jobs[row.sec_id].advisor = JSON.parse(row.advisor_json);
          } catch {}
        }
        if (row.status === 'DONE' && row.result_json) {
          try {
            jobs[row.sec_id].results[row.specialist] = JSON.parse(row.result_json);
          } catch {}
        }
      }
    }

    return jobs;
  } finally {
    db.close();
  }
}

async function hasPendingForSecId(secId) {
  const db = getDB();
  try {
    const row = await dbGet(
      db,
      `SELECT COUNT(*) AS c FROM pending_enrichments WHERE sec_id = ? AND status = 'PENDING'`,
      [secId]
    );
    return (row?.c || 0) > 0;
  } finally {
    db.close();
  }
}

async function getRow(secId, specialist) {
  const db = getDB();
  try {
    return await dbGet(
      db,
      `SELECT sec_id, specialist, status, result_json, advisor_json FROM pending_enrichments WHERE sec_id = ? AND specialist = ?`,
      [secId, specialist]
    );
  } finally {
    db.close();
  }
}

async function finalizeIfReady(secId, advisor, results) {
  // Ensure all specialists have resolved (DONE or missing). If any are still PENDING, stop.
  if (await hasPendingForSecId(secId)) return null;

  const advisorJson = JSON.stringify(advisor);
  const scorerRow = await getRow(secId, 'scorer');

  // If scorer not spawned yet, spawn it and yield.
  if (!scorerRow) {
    const merged = mergeFindings(advisor, results);
    await spawnScorer(secId, merged, advisorJson);
    console.log(`\n⏳ Yielding (waiting for scorer)...\n`);
    await sessions_yield({ message: 'Waiting for scorer to complete' });
    return null;
  }

  // If scorer exists but isn't DONE yet, wait.
  if (scorerRow.status !== 'DONE') return null;

  let scoreResult = null;
  try {
    scoreResult = scorerRow.result_json ? JSON.parse(scorerRow.result_json) : null;
  } catch {
    scoreResult = null;
  }
  if (!scoreResult) return null;

  const merged = mergeFindings(advisor, results);
  await saveToDB(advisor, merged, scoreResult);

  const totalFindings = Object.values(merged.findings).reduce((sum, arr) => sum + (arr?.length || 0), 0);

  const db = getDB();
  let failed = [];
  try {
    const rows = await dbAll(
      db,
      `SELECT specialist, error FROM pending_enrichments WHERE sec_id = ? AND status = 'FAILED' ORDER BY specialist`,
      [secId]
    );
    failed = (rows || []).map((r) => ({ specialist: r.specialist, error: r.error || 'unknown_error' }));
  } finally {
    db.close();
  }

  const donePayload = {
    sec_id: advisor.sec_id,
    name: `${advisor.first_name} ${advisor.last_name}`,
    specialists_run: SPECIALISTS.length,
    findings_count: totalFindings,
    lead_score: scoreResult.lead_score,
    score_reason: scoreResult.score_reason || scoreResult.lead_score_reason || '',
    failed_specialists: failed
  };

  // Mark job as completed (optional: mark scorer row is already DONE)
  const db2 = getDB();
  try {
    await dbRun(
      db2,
      `UPDATE pending_enrichments
       SET status = 'DONE', completed_at = COALESCE(completed_at, datetime('now'))
       WHERE sec_id = ?;`,
      [secId]
    );
  } finally {
    db2.close();
  }

  return `DONE:${JSON.stringify(donePayload)}`;
}

async function advancePendingOnce() {
  const jobs = await pollPending();
  const doneMessages = [];

  for (const [secIdStr, job] of Object.entries(jobs)) {
    const secId = Number(secIdStr);
    const advisor = job.advisor;
    if (!advisor) continue;

    const maybeDone = await finalizeIfReady(secId, advisor, job.results);
    if (maybeDone) doneMessages.push(maybeDone);
  }

  if (doneMessages.length > 0) {
    console.log(doneMessages.join('\n'));
    return true;
  }

  await sessions_yield({ message: 'Waiting for pending enrichments to complete' });
  return false;
}

/**
 * Entry point
 */
async function main() {
  console.log(`\n╔════════════════════════════════════════════════════════╗`);
  console.log(`║   Advisor Enrichment Orchestrator v3.0              ║`);
  console.log(`║   Agent-to-Agent (sessions_spawn/yield/send)          ║`);
  console.log(`╚════════════════════════════════════════════════════════╝`);

  const inboundMessage = process.argv.length > 2 ? process.argv[2] : null;

  if (isOpenClawContext() && inboundMessage) {
    const maybeDone = handleTopLevelCommand(inboundMessage);
    if (maybeDone) {
      const resolved = await Promise.resolve(maybeDone);
      if (resolved) {
        console.log(resolved);
        return;
      }
    }
  }

  try {
    await runPreflight();
    await ensureSchema();
  } catch (err) {
    if (isOpenClawContext() && inboundMessage) {
      console.log(`DONE:${JSON.stringify({ error: 'preflight_failed', message: err.message })}`);
      return;
    }
    throw err;
  }

  if (process.argv.length > 2) {
    // CLI mode: node orchestrator.js "ENRICH:{...}"
    const message = process.argv[2];
    if (isOpenClawContext()) {
      if (message === 'TICK') {
        await advancePendingOnce();
        return;
      }
      if (message.startsWith('ENRICH:')) {
        await processEnrichRequest(message);
        return;
      }
      console.log(`DONE:${JSON.stringify({ error: 'unknown_command', message })}`);
      return;
    } else {
      console.log(`\n⚠️  Not in OpenClaw session context (no sessions_* globals).`);
      console.log(`   This script is intended to be run as an OpenClaw agent session.`);
    }
  } else {
    if (!isOpenClawContext()) {
      console.log(`\n📝 Local mode: nothing to do (no inbound message).`);
      return;
    }

    // OpenClaw mode: on any wake-up/turn, try to advance pending jobs.
    await advancePendingOnce();
  }
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
