import { describe, it, expect, vi } from "vitest"
import { makeAdapterWizard } from "../wizard.js"
import type { WizardStepResult, AdapterWizardStep } from "../wizard.js"
import type { SetupLedger } from "../ledger.js"
import type { AdapterCatalog, AdapterHandle, SetupLedgerRecord } from "../types.js"

interface TestHandle extends AdapterHandle {}

const CATALOG: AdapterCatalog = [
  { slug: "ngrok", name: "ngrok", description: "tunnel", packageName: "@x/adapter-ngrok" },
]

const STEPS: AdapterWizardStep[] = [
  { id: "auth", kind: "prompt", label: "Enter auth token", secret: true },
  { id: "verify", kind: "cmd", label: "Verify connection" },
]

function handle(slug: string): TestHandle {
  return {
    slug,
    name: slug,
    version: "1.0.0",
    description: "d",
    requiresSetup: true,
    check: async () => true,
  }
}

/** In-memory ledger seeded with optional prior record. */
function memLedger(prior?: SetupLedgerRecord): { ledger: SetupLedger; store: { rec?: SetupLedgerRecord } } {
  const store: { rec?: SetupLedgerRecord } = { rec: prior }
  return {
    store,
    ledger: {
      exists: async () => store.rec !== undefined,
      read: async () => store.rec ?? null,
      write: async (_slug, rec) => {
        store.rec = rec
      },
    },
  }
}

describe("makeAdapterWizard", () => {
  it("runs all steps for a fresh adapter and writes the ledger", async () => {
    const { ledger, store } = memLedger()
    const runStep = vi.fn(async (): Promise<WizardStepResult> => ({ ok: true, value: "tok" }))
    const wiz = makeAdapterWizard<TestHandle, string>({
      catalog: CATALOG,
      resolver: async (s) => handle(s),
      ledger,
      getSteps: () => STEPS,
      runStep,
    })
    const code = await wiz.run()
    expect(code).toBe(0)
    expect(runStep).toHaveBeenCalledTimes(2)
    expect(store.rec?.steps.map((s) => s.id).sort()).toEqual(["auth", "verify"])
  })

  it("skips ledger-completed steps unless force", async () => {
    const prior: SetupLedgerRecord = {
      slug: "ngrok",
      completedAt: "2026-06-01T00:00:00.000Z",
      steps: [{ id: "auth", completedAt: "2026-06-01T00:00:00.000Z" }],
    }
    const ran: string[] = []
    const runStep = vi.fn(async (_h: TestHandle, step: AdapterWizardStep): Promise<WizardStepResult> => {
      ran.push(step.id)
      return { ok: true }
    })
    const wiz = makeAdapterWizard<TestHandle, string>({
      catalog: CATALOG,
      resolver: async (s) => handle(s),
      ledger: memLedger(prior).ledger,
      getSteps: () => STEPS,
      runStep,
    })
    await wiz.run()
    // only "verify" runs — "auth" already in the ledger
    expect(runStep).toHaveBeenCalledTimes(1)
    expect(ran).toEqual(["verify"])
  })

  it("force re-runs ledger-completed steps", async () => {
    const prior: SetupLedgerRecord = {
      slug: "ngrok",
      completedAt: "2026-06-01T00:00:00.000Z",
      steps: [{ id: "auth", completedAt: "2026-06-01T00:00:00.000Z" }],
    }
    const runStep = vi.fn(async (): Promise<WizardStepResult> => ({ ok: true }))
    const wiz = makeAdapterWizard<TestHandle, string>({
      catalog: CATALOG,
      resolver: async (s) => handle(s),
      ledger: memLedger(prior).ledger,
      getSteps: () => STEPS,
      runStep,
    })
    await wiz.run({ force: true })
    expect(runStep).toHaveBeenCalledTimes(2)
  })

  it("persists secret prompt values to the injected credsStore", async () => {
    const written: { slug: string; creds: string }[] = []
    const wiz = makeAdapterWizard<TestHandle, string>({
      catalog: CATALOG,
      resolver: async (s) => handle(s),
      ledger: memLedger().ledger,
      credsStore: {
        exists: async () => false,
        read: async () => null,
        write: async (slug, creds) => {
          written.push({ slug, creds })
        },
      },
      getSteps: () => STEPS,
      runStep: async (_h, step) => ({ ok: true, value: step.secret ? "tok-secret" : undefined }),
    })
    await wiz.run()
    expect(written).toEqual([{ slug: "ngrok", creds: "tok-secret" }])
  })

  it("dry-run does not write the ledger", async () => {
    const { ledger, store } = memLedger()
    const wiz = makeAdapterWizard<TestHandle, string>({
      catalog: CATALOG,
      resolver: async (s) => handle(s),
      ledger,
      getSteps: () => STEPS,
      runStep: async () => ({ ok: true }),
    })
    const code = await wiz.run({ dryRun: true })
    expect(code).toBe(0)
    expect(store.rec).toBeUndefined()
  })

  it("returns non-zero when the adapter is not installed", async () => {
    const wiz = makeAdapterWizard<TestHandle, string>({
      catalog: CATALOG,
      resolver: async () => null,
      ledger: memLedger().ledger,
      getSteps: () => STEPS,
      runStep: async () => ({ ok: true }),
    })
    expect(await wiz.run()).toBe(1)
  })
})
