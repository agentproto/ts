import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { EvalEvent } from "@agentproto/eval"
import { computeStatus } from "@agentproto/provider-kit"
import {
  EVAL_REPORTER_CATALOG,
  makeEvalReporterCredsStore,
  makeEvalReporterResolver,
  makeEvalReporterTools,
  resolveEvalReporter,
} from "../index.js"

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "eval-reporters-"))
}

describe("resolveEvalReporter", () => {
  const langfuseCreds = {
    publicKey: "pk-test",
    secretKey: "sk-test",
    baseUrl: "https://cloud.langfuse.com",
    environment: "test",
  }

  it("returns a working langfuse sink from creds", () => {
    const handle = resolveEvalReporter("langfuse", { creds: langfuseCreds })
    expect(handle.slug).toBe("langfuse")
    expect(handle.requiresSetup).toBe(true)
    expect(handle.info()).toEqual({
      slug: "langfuse",
      capabilities: { needsCreds: true },
    })

    const sink = handle.sink()
    expect(typeof sink.emit).toBe("function")
    expect(typeof sink.flush).toBe("function")

    const event: EvalEvent = {
      kind: "eval.started",
      runId: "run-1",
      at: "2026-01-01T00:00:00.000Z",
      suiteId: "suite-a",
      caseCount: 1,
      scorerCount: 1,
    }
    sink.emit(event)
    expect(typeof sink.flush).toBe("function")
  })

  it("throws when langfuse sink is requested without creds", () => {
    const handle = resolveEvalReporter("langfuse", { creds: null })
    expect(handle.slug).toBe("langfuse")
    expect(() => handle.sink()).toThrow("not configured")
  })

  it("returns stderr and array handles without creds", () => {
    const stderr = resolveEvalReporter("stderr", { creds: null })
    expect(stderr.slug).toBe("stderr")
    expect(stderr.requiresSetup).toBe(false)
    expect(stderr.info().capabilities.needsCreds).toBe(false)
    expect(() => stderr.sink()).not.toThrow()

    const array = resolveEvalReporter("array", { creds: null })
    expect(array.slug).toBe("array")
    expect(array.requiresSetup).toBe(false)
    expect(array.info().capabilities.needsCreds).toBe(false)
    expect(() => array.sink()).not.toThrow()
  })

  it("throws for an unknown slug", () => {
    expect(() => resolveEvalReporter("unknown", { creds: null })).toThrow(
      "unknown eval reporter slug",
    )
  })
})

describe("makeEvalReporterResolver", () => {
  it("returns null for an unknown slug", async () => {
    const home = await tempHome()
    try {
      const store = makeEvalReporterCredsStore(home)
      const resolver = makeEvalReporterResolver(store)
      const handle = await resolver("not-a-reporter")
      expect(handle).toBeNull()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe("status classification", () => {
  it("is ready for langfuse when creds exist and available otherwise", () => {
    const withCreds = computeStatus({
      resolved: true,
      requiresSetup: true,
      ledgerExists: false,
      credsExist: true,
    })
    expect(withCreds).toBe("ready")

    const withoutCreds = computeStatus({
      resolved: true,
      requiresSetup: true,
      ledgerExists: false,
      credsExist: false,
    })
    expect(withoutCreds).toBe("available")
  })

  it("is ready for stderr and array without creds", () => {
    const status = computeStatus({
      resolved: true,
      requiresSetup: false,
      ledgerExists: false,
      credsExist: false,
    })
    expect(status).toBe("ready")
  })
})

describe("makeEvalReporterTools", () => {
  it("list tool output never leaks a secret", async () => {
    const home = await tempHome()
    try {
      const store = makeEvalReporterCredsStore(home)
      await store.write("langfuse", {
        publicKey: "pk-SECRET",
        secretKey: "sk-SECRET",
        baseUrl: "https://cloud.langfuse.com",
        environment: "prod",
      })

      const tools = makeEvalReporterTools({ home })
      const result = await tools.list_eval_reporters.handler()
      const text = result.content[0]?.text ?? ""

      expect(text).not.toContain("pk-SECRET")
      expect(text).not.toContain("sk-SECRET")
      expect(text).not.toContain("cloud.langfuse.com")
      expect(text).not.toContain("prod")

      const parsed = JSON.parse(text)
      const langfuse = parsed.find((entry: { slug: string }) => entry.slug === "langfuse")
      expect(langfuse).toBeDefined()
      expect(langfuse.status).toBe("ready")
      expect(langfuse.info).toEqual({
        slug: "langfuse",
        capabilities: { needsCreds: true },
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it("setup tool stores creds and never echoes them back", async () => {
    const home = await tempHome()
    try {
      const tools = makeEvalReporterTools({ home })
      const publicKey = "pk-SETUP-SECRET"
      const secretKey = "sk-SETUP-SECRET"

      const result = await tools.setup_eval_reporter.handler({
        slug: "langfuse",
        publicKey,
        secretKey,
        baseUrl: "https://cloud.langfuse.com",
      })

      expect(result.isError).toBeFalsy()
      const text = result.content[0]?.text ?? ""
      expect(text).not.toContain(publicKey)
      expect(text).not.toContain(secretKey)
      expect(JSON.parse(text)).toEqual({
        ok: true,
        slug: "langfuse",
        hint: "langfuse configured — status is now ready",
      })

      const store = makeEvalReporterCredsStore(home)
      const stored = await store.read("langfuse")
      expect(stored).toEqual({
        publicKey,
        secretKey,
        baseUrl: "https://cloud.langfuse.com",
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it("setup tool rejects unknown slugs", async () => {
    const tools = makeEvalReporterTools()
    const result = await tools.setup_eval_reporter.handler({
      slug: "stderr",
      publicKey: "x",
      secretKey: "x",
      baseUrl: "x",
    })
    expect(result.isError).toBe(true)
  })

  it("catalog covers the three expected slugs", () => {
    const slugs = EVAL_REPORTER_CATALOG.map((entry) => entry.slug)
    expect(slugs.sort()).toEqual(["array", "langfuse", "stderr"])
  })
})
