import { createHash, randomUUID } from "node:crypto";
import { initSchema } from "./db-init.js";
import { openDb, resolveEnrichmentDbPath } from "./db.js";

function asString(value) {
  return String(value ?? "").trim();
}

function parseDateMs(value) {
  const raw = asString(value);
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

function normalizeProfiles(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.profiles)) return payload.profiles;
  if (payload && typeof payload === "object") return [payload];
  return [];
}

function splitDisplayName(displayName) {
  const parts = String(displayName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return {
    firstName: parts[0],
    lastName: parts[parts.length - 1],
  };
}

function toSourceKey(profile) {
  const provided = asString(profile?.source_key);
  if (provided) return provided;
  const raw = [
    asString(profile?.display_name).toLowerCase(),
    asString(profile?.current_employer).toLowerCase(),
    asString(profile?.location_city).toLowerCase(),
    asString(profile?.location_state).toLowerCase(),
  ].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function parseSourceData(raw) {
  try {
    return JSON.parse(String(raw || "{}")) || {};
  } catch {
    return {};
  }
}

function isManualFieldLocked(existingSourceData, fieldName) {
  const locks = existingSourceData?.manual_overrides;
  return Boolean(locks && locks[fieldName] === true);
}

function pickSurvivor({
  existingValue,
  incomingValue,
  overwriteExisting,
  preferMostRecent,
  incomingUpdatedAtMs,
  existingUpdatedAtMs,
  manualFieldLocked,
}) {
  const existing = asString(existingValue);
  const incoming = asString(incomingValue);
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (manualFieldLocked && !overwriteExisting) return existing;
  if (overwriteExisting) return incoming;
  if (preferMostRecent && incomingUpdatedAtMs != null && existingUpdatedAtMs != null) {
    return incomingUpdatedAtMs >= existingUpdatedAtMs ? incoming : existing;
  }
  return existing;
}

export function upsertProfileRecord(db, profile, options = {}) {
  const sourceSystem =
    asString(profile?.source_system) ||
    asString(options.defaultSourceSystem) ||
    "profile_research";
  const sourceKey = toSourceKey(profile);
  const existingBySource = db
    .prepare(
      `SELECT profile_id, source_data
       FROM profiles
       WHERE source_system = ? AND source_key = ?
       LIMIT 1`,
    )
    .get(sourceSystem, sourceKey);
  const existing = existingBySource
    ? db
        .prepare(
          `SELECT profile_id, first_name, last_name, middle_name, display_name,
                  location_city, location_state, location_country,
                  current_employer, current_title, industry, source_data
           FROM profiles
           WHERE profile_id = ?
           LIMIT 1`,
        )
        .get(existingBySource.profile_id)
    : null;

  const profileId = existing?.profile_id || randomUUID();
  const displayName = asString(profile?.display_name);
  const split = splitDisplayName(displayName);
  const overwriteExisting =
    profile?.allow_overwrite === true || profile?.force_overwrite === true;

  const existingSourceData = parseSourceData(existing?.source_data);
  const existingRaw = existingSourceData?.raw_profile ?? null;
  const incomingUpdatedAtMs =
    parseDateMs(profile?.source_updated_at) ??
    parseDateMs(profile?.updated_at) ??
    parseDateMs(profile?.request_context?.captured_at);
  const existingUpdatedAtMs =
    parseDateMs(existingRaw?.source_updated_at) ??
    parseDateMs(existingRaw?.updated_at) ??
    parseDateMs(existingRaw?.request_context?.captured_at);

  const firstName = pickSurvivor({
    existingValue: existing?.first_name,
    incomingValue: asString(profile?.first_name) || split.firstName,
    overwriteExisting,
    preferMostRecent: false,
    incomingUpdatedAtMs,
    existingUpdatedAtMs,
    manualFieldLocked: isManualFieldLocked(existingSourceData, "first_name"),
  });
  const lastName = pickSurvivor({
    existingValue: existing?.last_name,
    incomingValue: asString(profile?.last_name) || split.lastName,
    overwriteExisting,
    preferMostRecent: false,
    incomingUpdatedAtMs,
    existingUpdatedAtMs,
    manualFieldLocked: isManualFieldLocked(existingSourceData, "last_name"),
  });
  if (!firstName || !lastName) {
    return { action: "skipped", profileId: null };
  }

  const merged = {
    middle_name: pickSurvivor({
      existingValue: existing?.middle_name,
      incomingValue: asString(profile?.middle_name),
      overwriteExisting,
      preferMostRecent: false,
      incomingUpdatedAtMs,
      existingUpdatedAtMs,
      manualFieldLocked: isManualFieldLocked(existingSourceData, "middle_name"),
    }),
    display_name: pickSurvivor({
      existingValue: existing?.display_name,
      incomingValue: displayName || `${firstName} ${lastName}`.trim(),
      overwriteExisting,
      preferMostRecent: false,
      incomingUpdatedAtMs,
      existingUpdatedAtMs,
      manualFieldLocked: isManualFieldLocked(existingSourceData, "display_name"),
    }),
    location_city: pickSurvivor({
      existingValue: existing?.location_city,
      incomingValue: asString(profile?.location_city),
      overwriteExisting,
      preferMostRecent: false,
      incomingUpdatedAtMs,
      existingUpdatedAtMs,
      manualFieldLocked: isManualFieldLocked(existingSourceData, "location_city"),
    }),
    location_state: pickSurvivor({
      existingValue: existing?.location_state,
      incomingValue: asString(profile?.location_state),
      overwriteExisting,
      preferMostRecent: false,
      incomingUpdatedAtMs,
      existingUpdatedAtMs,
      manualFieldLocked: isManualFieldLocked(existingSourceData, "location_state"),
    }),
    location_country: pickSurvivor({
      existingValue: existing?.location_country,
      incomingValue: asString(profile?.location_country) || "US",
      overwriteExisting,
      preferMostRecent: false,
      incomingUpdatedAtMs,
      existingUpdatedAtMs,
      manualFieldLocked: isManualFieldLocked(existingSourceData, "location_country"),
    }),
    current_employer: pickSurvivor({
      existingValue: existing?.current_employer,
      incomingValue: asString(profile?.current_employer),
      overwriteExisting,
      preferMostRecent: true,
      incomingUpdatedAtMs,
      existingUpdatedAtMs,
      manualFieldLocked: isManualFieldLocked(existingSourceData, "current_employer"),
    }),
    current_title: pickSurvivor({
      existingValue: existing?.current_title,
      incomingValue: asString(profile?.current_title),
      overwriteExisting,
      preferMostRecent: true,
      incomingUpdatedAtMs,
      existingUpdatedAtMs,
      manualFieldLocked: isManualFieldLocked(existingSourceData, "current_title"),
    }),
    industry: pickSurvivor({
      existingValue: existing?.industry,
      incomingValue: asString(profile?.industry),
      overwriteExisting,
      preferMostRecent: true,
      incomingUpdatedAtMs,
      existingUpdatedAtMs,
      manualFieldLocked: isManualFieldLocked(existingSourceData, "industry"),
    }),
  };

  const sourceData = {
    ...(existingSourceData || {}),
    source_url: asString(profile?.source_url),
    source_updated_at:
      asString(profile?.source_updated_at) ||
      asString(profile?.updated_at) ||
      asString(profile?.request_context?.captured_at),
    overwrite_existing: overwriteExisting,
    raw_profile: profile,
  };

  db.prepare(
    `INSERT INTO profiles (
      profile_id, first_name, last_name, middle_name, display_name,
      location_city, location_state, location_country,
      current_employer, current_title, industry,
      source_system, source_key, source_data,
      enriched_at, enrichment_status, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      NULL, 'pending', datetime('now')
    )
    ON CONFLICT(source_system, source_key) DO UPDATE SET
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      middle_name = excluded.middle_name,
      display_name = excluded.display_name,
      location_city = excluded.location_city,
      location_state = excluded.location_state,
      location_country = excluded.location_country,
      current_employer = excluded.current_employer,
      current_title = excluded.current_title,
      industry = excluded.industry,
      source_data = excluded.source_data,
      updated_at = datetime('now')`,
  ).run(
    profileId,
    firstName,
    lastName,
    merged.middle_name,
    merged.display_name,
    merged.location_city,
    merged.location_state,
    merged.location_country,
    merged.current_employer,
    merged.current_title,
    merged.industry,
    sourceSystem,
    sourceKey,
    JSON.stringify(sourceData),
  );

  return { action: existing ? "updated" : "inserted", profileId };
}

export function saveProfilesPayload(payload, options = {}) {
  const profiles = normalizeProfiles(payload);
  if (profiles.length === 0) {
    throw new Error("payload must include a profile object or profiles array");
  }

  const dbPath = options.dbPath || resolveEnrichmentDbPath();
  const db = openDb(dbPath);
  try {
    initSchema(db);
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    for (const profile of profiles) {
      const outcome = upsertProfileRecord(db, profile, options);
      if (outcome.action === "skipped" || !outcome.profileId) {
        skipped++;
        continue;
      }
      if (outcome.action === "inserted") inserted++;
      if (outcome.action === "updated") updated++;
    }
    return {
      inserted,
      updated,
      skipped,
      profiles_total: profiles.length,
      db_path: dbPath,
    };
  } finally {
    db.close();
  }
}
