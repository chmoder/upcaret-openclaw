/**
 * Canonical finding_type vocabulary for advisor enrichment findings.
 * Keep this list in sync with specialist agent outputs.
 */

export const ALLOWED_FINDING_TYPES = new Set([
  "email",
  "phone",
  "linkedin_url",
  "linkedin_handle",
  "firm_website",
  "profile_url",
  "profile_summary",
  "certification",
  "award",
  "speaking_engagement",
  "news_mention",
  "network_connection",
  "unknown",
]);

export function normalizeFindingType(input) {
  const normalized = String(input ?? "").trim().toLowerCase();
  if (!normalized) return "unknown";
  return ALLOWED_FINDING_TYPES.has(normalized) ? normalized : "unknown";
}
