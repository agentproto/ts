/**
 * rendezvous — is the configured (or hosted-default) rendezvous broker
 * reachable from this machine, direct or through a corporate `HTTPS_PROXY`
 * (DEVICES-PLAN item 3)? `ws` doesn't read `HTTPS_PROXY`/`NO_PROXY` on its
 * own (unlike `fetch`), so on a locked-down, outbound-HTTPS-only network the
 * daemon's rendezvous dial can silently fail with no clearer signal than a
 * dial timeout deep inside `pair accept`/`devices add`. This step surfaces
 * that up front, and reports which mode (direct/proxy) actually connected.
 *
 * Not required: a daemon that never uses pairing/device-forwarding has no
 * reason to reach the broker at all.
 */

import { HOSTED_RENDEZVOUS_URL } from "@agentproto/secrets/pairing"
import type { OnboardingStep, StepCheck } from "../types.js"
import { errorMessage } from "./_util.js"

const CHECK_ID = "rendezvous.reachable"
const TITLE = "Rendezvous broker"
const PROBE_TIMEOUT_MS = 4_000

export const rendezvousStep: OnboardingStep = {
  id: "rendezvous",
  title: "Rendezvous",
  required: false,
  async detect(ctx): Promise<StepCheck[]> {
    let configured: string | undefined
    try {
      configured = (await ctx.sources.loadConfig()).pairing?.rendezvous
    } catch (err) {
      return [{ id: CHECK_ID, title: TITLE, status: "warn", detail: `not checked: ${errorMessage(err)}` }]
    }

    if (configured === "") {
      return [
        {
          id: CHECK_ID,
          title: TITLE,
          status: "skipped",
          detail: 'pairing.rendezvous is set to "" — hosted default disabled, no broker configured',
        },
      ]
    }

    const url = configured || HOSTED_RENDEZVOUS_URL
    const result = await ctx.dialWebSocket(url, { timeoutMs: PROBE_TIMEOUT_MS })
    const mode = result.via === "proxy" ? "via proxy" : "direct"

    if (result.ok) {
      return [
        {
          id: CHECK_ID,
          title: TITLE,
          status: "ok",
          detail: `reachable (${mode}) — ${url}`,
          data: { url, via: result.via },
        },
      ]
    }
    return [
      {
        id: CHECK_ID,
        title: TITLE,
        status: "warn",
        detail: `not reachable (${mode}) — ${url}${result.error ? `: ${result.error}` : ""}`,
        fix:
          "check network/HTTPS_PROXY/NO_PROXY settings, or self-host with " +
          "`agentproto rendezvous serve` and set pairing.rendezvous",
        data: { url, via: result.via },
      },
    ]
  },
}
