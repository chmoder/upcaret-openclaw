const ENV_SPECS = [
  {
    name: 'BRAVE_API_KEY',
    required: true,
    kind: 'api_key',
    description: 'Required for enrichment/prospecting. Used for web discovery/search (Brave Search). Not needed for SEC download-only.',
    howToSet: [
      'export BRAVE_API_KEY="..."',
      'openclaw config set env.BRAVE_API_KEY "..."'
    ]
  },
  {
    name: 'FIRECRAWL_API_KEY',
    required: false,
    kind: 'api_key',
    description: 'Optional. If set, fetch may use Firecrawl (paid).',
    howToSet: [
      'export FIRECRAWL_API_KEY="..."',
      'openclaw config set env.FIRECRAWL_API_KEY "..."'
    ]
  },
  {
    name: 'ANTHROPIC_API_KEY',
    required: false,
    kind: 'api_key',
    description: 'Optional. Used by specialist sub-sessions if your OpenClaw/model setup routes LLM calls through it.',
    howToSet: [
      'export ANTHROPIC_API_KEY="..."',
      'openclaw config set env.ANTHROPIC_API_KEY "..."'
    ]
  },
  {
    name: 'HUNTER_API_KEY',
    required: false,
    kind: 'api_key',
    description: 'Optional. Used for email enrichment/verification via Hunter.io.',
    howToSet: [
      'export HUNTER_API_KEY="..."',
      'openclaw config set env.HUNTER_API_KEY "..."'
    ]
  },
  {
    name: 'DEBUG_FETCH',
    required: false,
    kind: 'debug',
    description: 'Optional. Set to 1 for verbose fetch logs.',
    howToSet: ['export DEBUG_FETCH=1']
  },
  {
    name: 'DEBUG_DISCOVERY',
    required: false,
    kind: 'debug',
    description: 'Optional. Set to 1 for verbose profile discovery logs.',
    howToSet: ['export DEBUG_DISCOVERY=1']
  }
];

function isSet(name) {
  return Boolean(process.env[name] && String(process.env[name]).length > 0);
}

function mask(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 6) return '******';
  return `${s.slice(0, 2)}…${s.slice(-2)}`;
}

function envStatus() {
  return ENV_SPECS.map((s) => ({
    ...s,
    set: isSet(s.name),
    masked: isSet(s.name) ? mask(process.env[s.name]) : ''
  }));
}

function formatEnvHelp() {
  const lines = [];
  lines.push('Environment variables for sec-iapd-advisor-enrichment:\n');

  for (const s of envStatus()) {
    lines.push(`- ${s.name}${s.required ? ' (required)' : ' (optional)'}`);
    lines.push(`  - ${s.description}`);
    lines.push(`  - currently: ${s.set ? `set (${s.masked})` : 'not set'}`);
    if (s.howToSet && s.howToSet.length > 0) {
      lines.push('  - set with:');
      for (const cmd of s.howToSet) lines.push(`    - ${cmd}`);
    }
    lines.push('');
  }

  lines.push('Notes:');
  lines.push('- Do not hardcode API keys in tracked files.');
  lines.push('- If you set FIRECRAWL_API_KEY, fetch may require Firecrawl to succeed (no fallback).');
  lines.push('- To require all 4 API keys up front, set: export LEADGEN_REQUIRE_ALL_API_KEYS=1');
  lines.push('');
  return lines.join('\n');
}

function validateEnv({ requiredOnly = true } = {}) {
  const missing = [];
  for (const s of ENV_SPECS) {
    if (requiredOnly && !s.required) continue;
    if (!isSet(s.name)) missing.push(s.name);
  }
  return { ok: missing.length === 0, missing };
}

function validateApiKeys({ requireAll = false } = {}) {
  const missing = [];
  for (const s of ENV_SPECS.filter((x) => x.kind === 'api_key')) {
    const mustHave = requireAll ? true : s.required;
    if (!mustHave) continue;
    if (!isSet(s.name)) missing.push(s.name);
  }
  return { ok: missing.length === 0, missing };
}

function envErrorMessage(missing) {
  const lines = [];
  lines.push('Missing required environment variables:');
  for (const name of missing) lines.push(`- ${name}`);
  lines.push('');
  lines.push('Set them with one of the following methods:\n');

  for (const name of missing) {
    const spec = ENV_SPECS.find((s) => s.name === name);
    if (!spec) continue;
    lines.push(`${name}:`);
    if (spec.howToSet && spec.howToSet.length > 0) {
      for (const cmd of spec.howToSet) lines.push(`  - ${cmd}`);
    } else {
      lines.push('  - export ' + name + '="..."');
    }
    lines.push('');
  }

  lines.push('For the full list (required + optional), run: `npm run env:help`');
  return lines.join('\n');
}

module.exports = {
  ENV_SPECS,
  envStatus,
  formatEnvHelp,
  validateEnv,
  validateApiKeys,
  envErrorMessage
};

