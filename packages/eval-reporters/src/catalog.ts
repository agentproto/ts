import type { AdapterCatalog } from "@agentproto/adapter-kit"

/** Family key used for the eval-reporter creds store path. */
export const EVAL_REPORTER_FAMILY = "eval-reporter" as const

/** Static catalog of eval reporter backends. */
export const EVAL_REPORTER_CATALOG: AdapterCatalog = [
  {
    slug: "langfuse",
    name: "Langfuse",
    description:
      "Langfuse observability platform via the public ingestion API. " +
      "Requires public key, secret key, and base URL.",
    packageName: "@agentproto/telemetry-langfuse",
    hint: "observability · scores",
  },
  {
    slug: "stderr",
    name: "Standard Error",
    description: "Human-readable eval events written to process stderr.",
    packageName: "@agentproto/eval-reporters",
    hint: "local · debug",
  },
  {
    slug: "array",
    name: "In-Memory Array",
    description: "Collects eval events in an in-memory array for tests and inspection.",
    packageName: "@agentproto/eval-reporters",
    hint: "local · test",
  },
]
