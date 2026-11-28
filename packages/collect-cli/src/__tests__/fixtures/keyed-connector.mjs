import { defineConnector } from "@agentproto/collect"

export default defineConnector({
  id: "keyed",
  version: "0.1.0",
  transports: ["api", "browser"],
  access: { level: "key", secret: "FAKE_TOKEN" },
  capabilities: ["read-by-url"],
  plan: () => [],
  fetch: async () => ({ raws: [] }),
  parse: () => ({}),
})
