import type { AdapterCatalog } from "@agentproto/provider-kit"

/** Family key used for the code-brain backend creds/ledger store path. */
export const CODE_BRAIN_FAMILY = "code-brain" as const

/** The two backend slugs this adapter provides. */
export const GBRAIN_LOCAL_SLUG = "gbrain-local" as const
export const GBRAIN_HTTP_SLUG = "gbrain-http" as const

/**
 * Static catalog of code-brain backends shipped by this adapter. Both slugs
 * resolve from THIS package (`@agentproto/adapter-code-brain-gbrain`) — the
 * provider-kit discovery convention (`@agentproto/adapter-code-brain-*`)
 * points every code-brain backend here.
 */
export const CODE_BRAIN_CATALOG: AdapterCatalog = [
  {
    slug: GBRAIN_LOCAL_SLUG,
    name: "gbrain (local)",
    description:
      "Code intelligence from a local gbrain container via `docker exec`. " +
      "No credentials — requires the gbrain-pg container to be running.",
    packageName: "@agentproto/adapter-code-brain-gbrain",
    hint: "gbrain · docker",
  },
  {
    slug: GBRAIN_HTTP_SLUG,
    name: "gbrain (http)",
    description:
      "Code intelligence from a gbrain server over MCP/HTTP with a bearer " +
      "token. Requires GBRAIN_BEARER_TOKEN and a reachable endpoint.",
    packageName: "@agentproto/adapter-code-brain-gbrain",
    hint: "gbrain · bearer",
  },
]
