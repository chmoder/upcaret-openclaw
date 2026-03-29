export const ALLOWED_FINDING_TYPES = new Set([
  "email",
  "phone",
  "linkedin_url",
  "linkedin_handle",
  "website",
  "profile_url",
  "profile_summary",
  "certification",
  "award",
  "speaking_engagement",
  "news_mention",
  "network_person",
  "network_affiliation",
  "current_employer",
  "current_title",
  "social_profile",
  "license",
  "regulatory_id",
  "professional_designation",
  "unknown",
]);

const TYPE_ALIASES = new Map([
  // certification/designation variants
  ["cert", "certification"],
  ["certs", "certification"],
  ["certificate", "certification"],
  ["credentials", "professional_designation"],
  ["credential", "professional_designation"],
  ["designation", "professional_designation"],

  // licensing/regulatory variants
  ["iar", "license"],
  ["investment_advisor_representative", "license"],
  ["advisor_license", "license"],
  ["license_type", "license"],
  ["registration", "regulatory_id"],
  ["registration_id", "regulatory_id"],
  ["reg_id", "regulatory_id"],
  ["crd", "regulatory_id"],
  ["crd_number", "regulatory_id"],
  ["nmls_id", "regulatory_id"],

  // common shorthand for existing types
  ["linkedin", "linkedin_url"],
  ["news", "news_mention"],
  ["speaking", "speaking_engagement"],
]);

export function normalizeFindingType(input) {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!normalized) return "unknown";
  if (ALLOWED_FINDING_TYPES.has(normalized)) return normalized;
  const mapped = TYPE_ALIASES.get(normalized);
  return mapped && ALLOWED_FINDING_TYPES.has(mapped) ? mapped : "unknown";
}
