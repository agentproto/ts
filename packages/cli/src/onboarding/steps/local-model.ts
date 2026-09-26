/**
 * local-model (setup only, extra, default off) — is a local/self-hosted
 * model endpoint configured? Informational: it never proposes an action
 * (named endpoints get their own setup flow later).
 */

import { join } from "node:path"
import type { OnboardingStep } from "../types.js"
import { pathExists, tildify } from "./_util.js"

export const localModelStep: OnboardingStep = {
  id: "local-model",
  title: "Local model (optional)",
  required: false,
  async detect(ctx) {
    const file = join(ctx.homedir, ".agentproto", "llm-endpoints.json")
    if (await pathExists(ctx, file)) {
      return [{ id: "local-model.endpoint", title: "Local model endpoint", status: "ok", detail: `configured in ${tildify(ctx, file)}` }]
    }
    const forge = ctx.env.FORGE_BASE_URL
    if (forge) {
      return [{ id: "local-model.endpoint", title: "Local model endpoint", status: "ok", detail: `FORGE_BASE_URL=${forge}` }]
    }
    return [
      {
        id: "local-model.endpoint",
        title: "Local model endpoint",
        status: "skipped",
        detail: "none configured — point FORGE_BASE_URL at an OpenAI-compatible server (vLLM, Ollama…) to use one",
      },
    ]
  },
}
