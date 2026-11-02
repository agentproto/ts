/**
 * Sandbox preflight probes against a fake exec: the `model-answers` verdicts
 * (ok, ko with a classified usage cap, timeout -> unknown), the runner's
 * ordering and stop-at-first-ko rule, and the typed failure payload.
 */

import { describe, expect, it, vi } from "vitest"
import type { SandboxExecOpts, SandboxExecResult } from "@agentproto/sandbox"
import {
  createPreflightRegistry,
  defaultPreflightRegistry,
  MODEL_ANSWERS_PROBE_ID,
  modelAnswersProbe,
  preflightFailedResult,
  runPreflightProbe,
  runSandboxPreflight,
  unknownPreflightProbes,
  type PreflightContext,
  type PreflightProbe,
} from "../sandbox-preflight.js"

/** The exact string the CI reviewer run died on. */
const CI_USAGE_LIMIT =
  "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"
const MODEL = "opencode/glm-5.3-flash-free"

const result = (over: Partial<SandboxExecResult> = {}): SandboxExecResult => ({
  exitCode: 0,
  stdout: "ok\n",
  stderr: "",
  durationMs: 5,
  ...over,
})

function ctxWith(
  exec: (opts: SandboxExecOpts) => Promise<SandboxExecResult>,
  over: Partial<Omit<PreflightContext, "timeoutMs">> = {},
): Omit<PreflightContext, "timeoutMs"> {
  return { exec, adapter: "opencode", model: MODEL, cwd: "/home/user", ...over }
}

describe("model-answers probe", () => {
  it("is registered by default under its id", () => {
    expect(defaultPreflightRegistry.get(MODEL_ANSWERS_PROBE_ID)).toBe(modelAnswersProbe)
  })

  it("ok: runs `opencode run -m <model> 'reply ok'` in the box and sees an answer", async () => {
    const calls: SandboxExecOpts[] = []
    const out = await runPreflightProbe(
      modelAnswersProbe,
      ctxWith(async o => {
        calls.push(o)
        return result()
      }),
    )
    expect(out).toMatchObject({ probe: "model-answers", verdict: "ok" })
    expect(out.errorClass).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe(`opencode run -m '${MODEL}' 'reply ok' < /dev/null`)
    expect(calls[0]?.cwd).toBe("/home/user")
    expect(calls[0]?.timeoutMs).toBe(90_000)
  })

  it("ko: the exact CI usage-cap string on stderr is classified as usage-limit", async () => {
    const out = await runPreflightProbe(
      modelAnswersProbe,
      ctxWith(async () => result({ exitCode: 1, stdout: "", stderr: CI_USAGE_LIMIT })),
    )
    expect(out.verdict).toBe("ko")
    expect(out.errorClass).toBe("usage-limit")
    expect(out.detail).toContain("Free usage limit reached")
  })

  it("ko: a refusal printed with exit 0 is still caught", async () => {
    const out = await runPreflightProbe(
      modelAnswersProbe,
      ctxWith(async () => result({ exitCode: 0, stdout: CI_USAGE_LIMIT })),
    )
    expect(out).toMatchObject({ verdict: "ko", errorClass: "usage-limit" })
  })

  it("ok: an answer that merely mentions an error word is the model talking, not a failure", async () => {
    for (const stdout of [
      "A 401 Unauthorized response means the credentials were rejected.",
      "Rate limit exceeded is HTTP 429, and permission denied is a filesystem error.",
    ]) {
      const out = await runPreflightProbe(modelAnswersProbe, ctxWith(async () => result({ exitCode: 0, stdout })))
      expect(out.verdict).toBe("ok")
    }
  })

  it("a non-zero exit with the same words is still a failure", async () => {
    const out = await runPreflightProbe(
      modelAnswersProbe,
      ctxWith(async () => result({ exitCode: 1, stdout: "", stderr: "401 Unauthorized" })),
    )
    expect(out).toMatchObject({ verdict: "ko", errorClass: "auth" })
  })

  it("redacts credential-shaped text from the detail", async () => {
    const out = await runPreflightProbe(
      modelAnswersProbe,
      ctxWith(async () =>
        result({
          exitCode: 1,
          stdout: "",
          stderr:
            "429 Too Many Requests Authorization: Bearer abcdef1234567890abcdef OPENAI_API_KEY=sk-live1234567890abcdefgh token: hunter2hunter2",
        }),
      ),
    )
    expect(out).toMatchObject({ verdict: "ko", errorClass: "rate-limit" })
    expect(out.detail).not.toMatch(/abcdef1234567890|sk-live|hunter2/)
    expect(out.detail).toContain("[redacted]")
  })

  it("ko carries the class of other provider failures (rate limit)", async () => {
    const out = await runPreflightProbe(
      modelAnswersProbe,
      ctxWith(async () => result({ exitCode: 1, stdout: "", stderr: "429 Too Many Requests" })),
    )
    expect(out).toMatchObject({ verdict: "ko", errorClass: "rate-limit" })
  })

  it("timeout -> unknown, not ko (a hung exec cannot veto a placement)", async () => {
    const out = await runPreflightProbe(modelAnswersProbe, ctxWith(() => new Promise<SandboxExecResult>(() => {})), 25)
    expect(out.verdict).toBe("unknown")
    expect(out.errorClass).toBeUndefined()
    expect(out.detail).toContain("timed out after 25ms")
  })

  it("an exec that throws (provider-side timeout, dropped box) is unknown", async () => {
    const out = await runPreflightProbe(
      modelAnswersProbe,
      ctxWith(async () => {
        throw new Error("TimeoutError: command exceeded 90000ms")
      }),
    )
    expect(out.verdict).toBe("unknown")
    expect(out.detail).toContain("TimeoutError")
  })

  it("unknown when the harness binary is missing, empty, or fails without a recognizable error", async () => {
    const missing = await runPreflightProbe(
      modelAnswersProbe,
      ctxWith(async () => result({ exitCode: 127, stdout: "", stderr: "sh: opencode: command not found" })),
    )
    expect(missing.verdict).toBe("unknown")
    expect(missing.detail).toContain("not installed")

    const silent = await runPreflightProbe(modelAnswersProbe, ctxWith(async () => result({ stdout: "  \n" })))
    expect(silent.verdict).toBe("unknown")

    const odd = await runPreflightProbe(
      modelAnswersProbe,
      ctxWith(async () => result({ exitCode: 2, stdout: "", stderr: "segfault" })),
    )
    expect(odd.verdict).toBe("unknown")
  })

  it("unknown, without running anything, for an adapter it has no command for or an unsafe model id", async () => {
    const exec = vi.fn(async () => result())
    const noRow = await runPreflightProbe(modelAnswersProbe, ctxWith(exec, { adapter: "claude-code" }))
    expect(noRow.verdict).toBe("unknown")
    const unsafe = await runPreflightProbe(modelAnswersProbe, ctxWith(exec, { model: "x'; rm -rf / #" }))
    expect(unsafe.verdict).toBe("unknown")
    expect(exec).not.toHaveBeenCalled()
  })

  it("omits -m when the spawn named no model", async () => {
    const calls: SandboxExecOpts[] = []
    await runPreflightProbe(
      modelAnswersProbe,
      ctxWith(
        async o => {
          calls.push(o)
          return result()
        },
        { model: undefined },
      ),
    )
    expect(calls[0]?.command).toBe(`opencode run 'reply ok' < /dev/null`)
  })
})

describe("runSandboxPreflight", () => {
  const probe = (id: string, verdict: "ok" | "ko" | "unknown"): PreflightProbe => ({
    id,
    description: id,
    defaultTimeoutMs: 1000,
    run: vi.fn(async () => ({
      verdict,
      detail: `${id} says ${verdict}`,
      ...(verdict === "ko" ? { errorClass: "usage-limit" as const } : {}),
    })),
  })

  it("runs probes in order and stops at the first ko", async () => {
    const a = probe("a", "ok")
    const b = probe("b", "ko")
    const c = probe("c", "ok")
    const registry = createPreflightRegistry([a, b, c])
    const run = await runSandboxPreflight(["a", "b", "c"], ctxWith(async () => result()), { registry })
    expect(run.ok).toBe(false)
    expect(run.outcomes.map(o => o.probe)).toEqual(["a", "b"])
    expect(run.failed).toMatchObject({ probe: "b", verdict: "ko", errorClass: "usage-limit" })
    expect(c.run).not.toHaveBeenCalled()
  })

  it("an unknown never fails the run", async () => {
    const registry = createPreflightRegistry([probe("a", "unknown"), probe("b", "ok")])
    const run = await runSandboxPreflight(["a", "b"], ctxWith(async () => result()), { registry })
    expect(run.ok).toBe(true)
    expect(run.failed).toBeUndefined()
    expect(run.outcomes.map(o => o.verdict)).toEqual(["unknown", "ok"])
  })

  it("a new criterion is a registration, not an edit", async () => {
    const registry = createPreflightRegistry()
    expect(unknownPreflightProbes(["egress-reachable"], registry)).toEqual(["egress-reachable"])
    registry.register(probe("egress-reachable", "ok"))
    expect(unknownPreflightProbes(["egress-reachable"], registry)).toEqual([])
    const run = await runSandboxPreflight(["egress-reachable"], ctxWith(async () => result()), { registry })
    expect(run.ok).toBe(true)
  })

  it("an id with no probe is an unknown outcome at run time, never a ko", async () => {
    const run = await runSandboxPreflight(["nope"], ctxWith(async () => result()), { registry: createPreflightRegistry() })
    expect(run.ok).toBe(true)
    expect(run.outcomes[0]).toMatchObject({ probe: "nope", verdict: "unknown" })
  })

  it("runs a duplicated id once", async () => {
    const a = probe("a", "ok")
    const run = await runSandboxPreflight(["a", "a"], ctxWith(async () => result()), {
      registry: createPreflightRegistry([a]),
    })
    expect(a.run).toHaveBeenCalledTimes(1)
    expect(run.outcomes).toHaveLength(1)
  })

  it("clamps a probe's exec to its budget and refuses exec once the probe is over", async () => {
    const seen: Array<number | undefined> = []
    let leaked: PreflightContext["exec"] | undefined
    const slow: PreflightProbe = {
      id: "slow",
      description: "slow",
      defaultTimeoutMs: 30,
      async run(ctx) {
        leaked = ctx.exec
        await ctx.exec({ command: "x", timeoutMs: 600_000 })
        await ctx.exec({ command: "y" })
        return new Promise(() => {})
      },
    }
    const exec = async (o: SandboxExecOpts) => {
      seen.push(o.timeoutMs)
      return result()
    }
    const out = await runPreflightProbe(slow, ctxWith(exec))
    expect(out.verdict).toBe("unknown")
    expect(seen).toEqual([30, 30])
    await expect(leaked!({ command: "late" })).rejects.toThrow(/probe is over/)
    expect(seen).toHaveLength(2)
  })

  it("the timeoutMs option overrides the probe's own budget", async () => {
    const run = await runSandboxPreflight(["model-answers"], ctxWith(() => new Promise<SandboxExecResult>(() => {})), {
      timeoutMs: 20,
    })
    expect(run.ok).toBe(true)
    expect(run.outcomes[0]).toMatchObject({ verdict: "unknown" })
  })
})

describe("preflightFailedResult", () => {
  it("is the typed spawn failure: probe id, errorClass and egress IP", async () => {
    const run = await runSandboxPreflight(
      ["model-answers"],
      ctxWith(async () => result({ exitCode: 1, stdout: "", stderr: CI_USAGE_LIMIT })),
    )
    expect(run.failed).toBeDefined()
    const failure = preflightFailedResult(
      { ...run, failed: run.failed! },
      { provider: "computer", sandboxId: "sbx_1", egressIp: "203.0.113.7" },
    )
    expect(failure).toMatchObject({
      ok: false,
      code: "sandbox_preflight_failed",
      details: {
        probe: "model-answers",
        errorClass: "usage-limit",
        egressIp: "203.0.113.7",
        provider: "computer",
        sandboxId: "sbx_1",
      },
    })
    expect(failure.message).toContain("203.0.113.7")
    expect(failure.message).toContain("usage-limit")
    expect(failure.details.outcomes).toHaveLength(1)
  })

  it("omits egressIp when the provider brokered none", async () => {
    const run = await runSandboxPreflight(
      ["model-answers"],
      ctxWith(async () => result({ exitCode: 1, stdout: "", stderr: CI_USAGE_LIMIT })),
    )
    const failure = preflightFailedResult({ ...run, failed: run.failed! }, { provider: "e2b", sandboxId: "sbx_2" })
    expect(failure.details).not.toHaveProperty("egressIp")
  })
})
