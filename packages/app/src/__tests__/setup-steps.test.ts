/**
 * AIP-53 `setup[]` — the post-install configuration pipeline, app side.
 *
 * One positive per step kind (incl. a vendor `x-*` step), one negative per
 * conformance rule-10 clause, the emit → load round trip, and the spec's
 * Pygmalion reference example (EXAMPLES.md §5) as a positive fixture.
 * app NEVER executes a step: every test asserts carry/validate only.
 */

import { describe, it, expect } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import matter from "gray-matter"
import { defineAgent } from "@agentproto/agent"
import { defineApp, AppDefinitionError } from "../define-app.js"
import { loadAppHandle } from "../load-app.js"
import type { AppSetupStep } from "../types.js"

function soloAgent() {
  return defineAgent({ schema: "agent/v1", id: "solo", description: "Solo agent.", model: "claude-sonnet-5" })
}

function appWithSetup(setup: readonly AppSetupStep[]) {
  return defineApp({ agents: [{ agent: soloAgent(), body: "Solo." }], setup })
}

describe("defineApp — setup[] step kinds (AIP-53)", () => {
  it("carries a `cmd` step, frozen", () => {
    const setup: AppSetupStep[] = [
      {
        id: "seed-db",
        kind: "cmd",
        title: "Seed the database",
        cmd: "node scripts/seed.js",
        skip_if: { cmd: "test -f .seeded", exit_code: 0 },
        persist: { env: "SEEDED" },
      },
    ]
    const app = appWithSetup(setup)
    expect(app.setup).toEqual(setup)
    expect(Object.isFrozen(app.setup)).toBe(true)
    expect(Object.isFrozen(app.setup![0])).toBe(true)
  })

  it("carries a `prompt` step (secret → secret_slug)", () => {
    const setup: AppSetupStep[] = [
      {
        id: "telegram-bot-token",
        kind: "prompt",
        type: "secret",
        optional: true,
        prompt: "Telegram bot token (create one with @BotFather)",
        persist: { secret_slug: "acme/telegram-bot-token" },
      },
    ]
    expect(appWithSetup(setup).setup).toEqual(setup)
  })

  it("carries an `oauth` step", () => {
    const setup: AppSetupStep[] = [
      { id: "cloud-login", kind: "oauth", secret_slug: "acme/cloud-token", description: "Sign in to the cloud." },
    ]
    expect(appWithSetup(setup).setup).toEqual(setup)
  })

  it("carries an `external` step", () => {
    const setup: AppSetupStep[] = [
      { id: "activate", kind: "external", url: "https://example.com/activate", persist: { answer: "activation.done" } },
    ]
    expect(appWithSetup(setup).setup).toEqual(setup)
  })

  it("carries a `choice` step with options, default and answer persist", () => {
    const setup: AppSetupStep[] = [
      {
        id: "cloud-computer",
        kind: "choice",
        prompt: "Cloud computer",
        options: [
          { value: "none", label: "None", description: "Everything runs on this machine." },
          { value: "e2b", label: "E2B", description: "Use your own E2B account." },
          { value: "pygmalion-cloud", label: "PygmalionCloud", description: "Managed cloud computer." },
        ],
        default: "pygmalion-cloud",
        persist: { answer: "cloud.provider" },
      },
    ]
    expect(appWithSetup(setup).setup).toEqual(setup)
  })

  it("carries an `auth-profile` step", () => {
    const setup: AppSetupStep[] = [
      { id: "model-login", kind: "auth-profile", min: 1, harnesses: ["claude-code"], title: "A model subscription" },
    ]
    expect(appWithSetup(setup).setup).toEqual(setup)
  })

  it("carries a `pairing` step", () => {
    const setup: AppSetupStep[] = [
      { id: "bot-token", kind: "prompt", type: "secret", prompt: "Telegram bot token" },
      {
        id: "telegram-pairing",
        kind: "pairing",
        channel: "telegram",
        display: "qr",
        timeout_sec: 300,
        when: { step: "bot-token", done: true },
        description: "Scan the QR in Telegram, then press Start.",
      },
    ]
    expect(appWithSetup(setup).setup).toEqual(setup)
  })

  it("carries a `check` step (tool probe)", () => {
    const setup: AppSetupStep[] = [
      {
        id: "bot-ready",
        kind: "check",
        severity: "warn",
        check: { tool: { id: "telegram_bot_token_status", expect: { configured: true } } },
      },
    ]
    expect(appWithSetup(setup).setup).toEqual(setup)
  })

  it("carries a `check` step (cmd probe)", () => {
    const setup: AppSetupStep[] = [
      { id: "port-free", kind: "check", check: { cmd: { run: "test -z \"$(lsof -i :8080)\"", exit_code: 0 } } },
    ]
    expect(appWithSetup(setup).setup).toEqual(setup)
  })

  it("carries a vendor `x-*` step verbatim (the one open shape)", () => {
    const setup = [
      { id: "acme-telemetry", kind: "x-acme-telemetry", endpoint: "https://example.com/telemetry", batchSize: 10 },
    ] as unknown as AppSetupStep[]
    expect(appWithSetup(setup).setup).toEqual(setup)
  })

  it("leaves `setup` undefined on an app that declares none", () => {
    expect(defineApp({ agents: [{ agent: soloAgent(), body: "Solo." }] }).setup).toBeUndefined()
  })
})

describe("defineApp — setup[] conformance rule 10 (negatives)", () => {
  it("rejects an empty setup array", () => {
    expect(() => appWithSetup([])).toThrow(AppDefinitionError)
    expect(() => appWithSetup([])).toThrow(/'setup' must declare at least one step when present/)
  })

  it("rejects a duplicate step id, naming it", () => {
    expect(() =>
      appWithSetup([
        { id: "twice", kind: "external", url: "https://example.com/a" },
        { id: "twice", kind: "external", url: "https://example.com/b" },
      ]),
    ).toThrow(/setup step 'twice' is declared more than once/)
  })

  it("rejects a `when.step` that does not name an EARLIER step, naming both ids", () => {
    expect(() =>
      appWithSetup([
        { id: "second", kind: "external", url: "https://example.com/a", when: { step: "first", done: true } },
        { id: "first", kind: "external", url: "https://example.com/b" },
      ]),
    ).toThrow(/setup step 'second' has 'when\.step' naming 'first', which is not an EARLIER step id/)
  })

  it("rejects a `when.step` naming an unknown step", () => {
    expect(() =>
      appWithSetup([{ id: "lonely", kind: "external", url: "https://example.com/a", when: { step: "ghost", done: true } }]),
    ).toThrow(/which is not an EARLIER step id/)
  })

  it("rejects a `persist` block with two slots, naming the step", () => {
    expect(() =>
      appWithSetup([
        { id: "two-slots", kind: "prompt", prompt: "Token", persist: { env: "TOKEN", secret_slug: "acme/token" } },
      ]),
    ).toThrow(/setup step 'two-slots' declares a 'persist' block with 2 slots \(env, secret_slug\)/)
  })

  it("rejects an empty `persist` block (zero slots), naming the step", () => {
    expect(() =>
      appWithSetup([{ id: "no-slot", kind: "external", url: "https://example.com/a", persist: {} }]),
    ).toThrow(/setup step 'no-slot' declares a 'persist' block with 0 slots/)
  })

  it("rejects a `choice.default` that is not one of its options, naming the step", () => {
    expect(() =>
      appWithSetup([
        {
          id: "cloud",
          kind: "choice",
          prompt: "Where?",
          options: [
            { value: "local", label: "Local" },
            { value: "remote", label: "Remote" },
          ],
          default: "elsewhere",
        },
      ]),
    ).toThrow(/setup step 'cloud' has default 'elsewhere', which is not the value of one of its options \(local, remote\)/)
  })

  it("rejects `persist.answer` on a `type: secret` prompt, naming the step", () => {
    expect(() =>
      appWithSetup([
        {
          id: "tok",
          kind: "prompt",
          type: "secret",
          prompt: "API key",
          persist: { answer: "api.key" },
        },
      ]),
    ).toThrow(/setup step 'tok' is a 'secret' prompt — 'persist\.answer' MUST NOT be used with 'type: secret'/)
  })
})

describe("defineApp — setup[] shape validation (loader-shared)", () => {
  it("rejects an unknown non-vendor kind", () => {
    expect(() => appWithSetup([{ id: "weird", kind: "nonsense" } as unknown as AppSetupStep])).toThrow(
      /'setup\[0\]\.kind'/,
    )
  })

  it("rejects a non-kebab-case step id", () => {
    expect(() => appWithSetup([{ id: "Not-Kebab", kind: "external", url: "https://example.com/a" } as unknown as AppSetupStep])).toThrow(
      /'setup\[0\]\.id' must be a kebab-case slug/,
    )
  })

  it("rejects an unknown key on a closed-kind step", () => {
    expect(() =>
      appWithSetup([{ id: "oops", kind: "external", url: "https://example.com/a", cmd: "rm -rf /" } as unknown as AppSetupStep]),
    ).toThrow(/'setup\[0\]\.cmd' is not a supported 'external' setup step field/)
  })

  it("rejects a `when` with both `equals` and `done` (exactly one)", () => {
    expect(() =>
      appWithSetup([
        {
          id: "a",
          kind: "external",
          url: "https://example.com/a",
          when: { step: "b", equals: "x", done: true },
        } as unknown as AppSetupStep,
        { id: "b", kind: "external", url: "https://example.com/b" },
      ]),
    ).toThrow(/must declare exactly one of 'equals' \/ 'done'/)
  })

  it("rejects a non-https external url", () => {
    expect(() => appWithSetup([{ id: "insecure", kind: "external", url: "http://example.com" }])).toThrow(
      /'setup\[0\]\.url' must be a non-empty 'https:\/\/' URL/,
    )
  })

  it("rejects a `check` declaring both cmd and tool", () => {
    expect(() =>
      appWithSetup([
        {
          id: "both",
          kind: "check",
          check: { cmd: { run: "true" }, tool: { id: "some_tool" } },
        },
      ]),
    ).toThrow(/'setup\[0\]\.check' must declare exactly one of 'cmd' \/ 'tool'/)
  })

  it("never executes a step's cmd — a destructive `cmd`/`skip_if` is carried as data", async () => {
    const marker = join(tmpdir(), `app-setup-marker-${process.pid}-${Date.now()}`)
    const app = appWithSetup([{ id: "boom", kind: "cmd", cmd: `touch ${marker}`, skip_if: { cmd: `touch ${marker}` } }])
    expect(app.setup![0]).toMatchObject({ kind: "cmd", cmd: `touch ${marker}` })
    const { existsSync } = await import("node:fs")
    expect(existsSync(marker)).toBe(false)
  })
})

describe("setup[] — emit → load round trip", () => {
  const steps: AppSetupStep[] = [
    { id: "model-login", kind: "auth-profile", min: 1 },
    {
      id: "bot-token",
      kind: "prompt",
      type: "secret",
      optional: true,
      prompt: "Telegram bot token",
      persist: { secret_slug: "acme/telegram-bot-token" },
    },
    {
      id: "cloud",
      kind: "choice",
      prompt: "Cloud computer",
      options: [
        { value: "none", label: "None" },
        { value: "e2b", label: "E2B" },
      ],
      default: "none",
      persist: { answer: "cloud.provider" },
    },
    { id: "e2b-key", kind: "prompt", type: "secret", prompt: "E2B API key", when: { step: "cloud", equals: "e2b" }, persist: { secret_slug: "acme/e2b-api-key" } },
    { id: "hook", kind: "check", check: { cmd: { run: "true" } } },
  ]

  it("writes setup verbatim into APP.md, omits it when absent, and loads it back re-validated", async () => {
    const withSetup = await mkdtemp(join(tmpdir(), "app-emit-setup-"))
    const without = await mkdtemp(join(tmpdir(), "app-emit-nosetup-"))
    try {
      const { appPath } = await appWithSetup(steps).emit(withSetup)
      const parsed = matter(await readFile(appPath, "utf8"))
      expect(parsed.data.setup).toEqual(steps)

      const loaded = await loadAppHandle(withSetup)
      expect(loaded.setup).toEqual(steps)
      expect(Object.isFrozen(loaded.setup)).toBe(true)

      const bare = await defineApp({ agents: [{ agent: soloAgent(), body: "Solo." }] }).emit(without)
      const bareParsed = matter(await readFile(bare.appPath, "utf8"))
      expect("setup" in bareParsed.data).toBe(false)
      expect((await loadAppHandle(without)).setup).toBeUndefined()
    } finally {
      await rm(withSetup, { recursive: true, force: true })
      await rm(without, { recursive: true, force: true })
    }
  })

  it("re-validates rule 10 on load — a hand-edited APP.md with a forward `when.step` fails", async () => {
    const d = await mkdtemp(join(tmpdir(), "app-load-setup-rule10-"))
    try {
      const { appPath } = await appWithSetup(steps).emit(d)
      const parsed = matter(await readFile(appPath, "utf8"))
      await writeFile(
        appPath,
        matter.stringify(parsed.content, {
          ...parsed.data,
          setup: [
            { id: "dependent", kind: "external", url: "https://example.com/a", when: { step: "target", done: true } },
            { id: "target", kind: "external", url: "https://example.com/b" },
          ],
        }),
        "utf8",
      )
      await expect(loadAppHandle(d)).rejects.toThrow(/setup step 'dependent' has 'when\.step' naming 'target'/)
    } finally {
      await rm(d, { recursive: true, force: true })
    }
  })

  it("rejects a hand-edited APP.md whose setup step shape is invalid, naming the field path", async () => {
    const d = await mkdtemp(join(tmpdir(), "app-load-setup-shape-"))
    try {
      const { appPath } = await appWithSetup(steps).emit(d)
      const parsed = matter(await readFile(appPath, "utf8"))
      await writeFile(
        appPath,
        matter.stringify(parsed.content, {
          ...parsed.data,
          setup: [{ id: "bad", kind: "pairing" }],
        }),
        "utf8",
      )
      await expect(loadAppHandle(d)).rejects.toThrow(/'setup\[0\]\.channel' is required on a 'pairing' step/)
    } finally {
      await rm(d, { recursive: true, force: true })
    }
  })
})

describe("setup[] — Pygmalion reference example (AIP-53 EXAMPLES.md §5)", () => {
  // The spec's reference app: a model login, an optional Telegram bot token
  // + QR pairing, and a cloud-computer choice that branches the two later
  // secrets. Verbatim from specs/resources/aip-53/draft/EXAMPLES.md §5.
  const pygmalionSetup: AppSetupStep[] = [
    {
      id: "auth-profile",
      kind: "auth-profile",
      title: "A model subscription",
      description: "Pygmalion bills its own work against one login profile.",
      min: 1,
    },
    {
      id: "telegram-bot-token",
      kind: "prompt",
      type: "secret",
      optional: true,
      prompt: "Telegram bot token (create one with @BotFather)",
      persist: { secret_slug: "pygmalion/telegram-bot-token" },
    },
    {
      id: "telegram-pairing",
      kind: "pairing",
      channel: "telegram",
      display: "qr",
      optional: true,
      when: { step: "telegram-bot-token", done: true },
      description: "Scan the QR in Telegram, then press Start.",
    },
    {
      id: "cloud-computer",
      kind: "choice",
      prompt: "Cloud computer",
      options: [
        { value: "none", label: "None", description: "Everything runs on this machine." },
        { value: "e2b", label: "E2B", description: "Use your own E2B account." },
        { value: "pygmalion-cloud", label: "PygmalionCloud", description: "Managed cloud computer." },
      ],
      default: "pygmalion-cloud",
      persist: { answer: "cloud.provider" },
    },
    {
      id: "e2b-api-key",
      kind: "prompt",
      type: "secret",
      prompt: "E2B API key",
      when: { step: "cloud-computer", equals: "e2b" },
      persist: { secret_slug: "pygmalion/e2b-api-key" },
    },
    {
      id: "pygmalion-cloud-login",
      kind: "oauth",
      secret_slug: "pygmalion/cloud-token",
      when: { step: "cloud-computer", equals: "pygmalion-cloud" },
    },
    {
      id: "bot-ready",
      kind: "check",
      severity: "warn",
      when: { step: "telegram-pairing", done: true },
      check: { tool: { id: "telegram_bot_token_status", expect: { configured: true } } },
    },
  ]

  it("constructs, carries every step, and round-trips through emit → load", async () => {
    const d = await mkdtemp(join(tmpdir(), "app-pygmalion-"))
    try {
      const app = defineApp({
        id: "@pygmalion/app",
        name: "Pygmalion",
        version: "0.4.0",
        agents: [],
        ui: { html: "<html><body>Pygmalion</body></html>", title: "Pygmalion", tools: [] },
        setup: pygmalionSetup,
      })
      expect(app.setup).toEqual(pygmalionSetup)

      const { appPath } = await app.emit(d)
      const parsed = matter(await readFile(appPath, "utf8"))
      expect(parsed.data.setup).toEqual(pygmalionSetup)

      const loaded = await loadAppHandle(d)
      expect(loaded.setup).toEqual(pygmalionSetup)
    } finally {
      await rm(d, { recursive: true, force: true })
    }
  })
})
