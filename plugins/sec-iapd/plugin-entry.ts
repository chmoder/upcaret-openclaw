// @ts-nocheck
let definePluginEntry: undefined | ((entry: any) => any);
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  definePluginEntry =
    require("openclaw/plugin-sdk/plugin-entry")?.definePluginEntry;
} catch {}

const entry = {
  id: "sec-iapd",
  name: "upCaret SEC IAPD Adapter",
  description: "SEC IAPD source adapter for enrichment profiles",
  register() {
    // Adapter plugin: scripts/skill only, no runtime service required.
  },
};

export default typeof definePluginEntry === "function"
  ? definePluginEntry(entry)
  : entry;
