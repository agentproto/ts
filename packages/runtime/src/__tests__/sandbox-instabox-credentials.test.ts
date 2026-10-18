import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SANDBOX_FAMILY,
  makeSandboxCredsStore,
  makeSandboxResolver,
} from "../sandbox-adapters.js"
import {
  readSandboxLedger,
  recordSandboxBoot,
  sandboxLedgerPath,
} from "../sandbox-ledger.js"

const INSTABOX_KEY = "ib_test_SECRET123"

describe("instabox credentials never reach the sandbox ledger", () => {
  let home: string
  let ledgerPath: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "instabox-ledger-"))
    ledgerPath = join(home, "sandboxes.json")
    process.env.AGENTPROTO_SANDBOX_LEDGER = ledgerPath
  })

  afterEach(() => {
    delete process.env.AGENTPROTO_SANDBOX_LEDGER
    delete process.env.INSTABOX_API_KEY
    rmSync(home, { recursive: true, force: true })
  })

  it("keeps the apiKey in the creds store and out of every ledger row", async () => {
    const credsStore = makeSandboxCredsStore(home)
    await credsStore.write("instabox", { apiKey: INSTABOX_KEY })

    // Resolving legitimately copies the key into process.env.INSTABOX_API_KEY
    // (the runtime's control-plane channel) — never into the ledger.
    const resolver = makeSandboxResolver(credsStore, {
      importPackage: async () => ({
        instaboxSandboxProvider: {
          boot: async () => ({
            mcpUrl: "https://18790-mfake.instabox.tech/mcp",
            sandboxId: "m_fake",
            stop: async () => {},
          }),
        },
      }),
    })
    const handle = await resolver("instabox")
    expect(handle).not.toBeNull()

    recordSandboxBoot({ sandboxId: "m_fake", provider: "instabox", state: "booted" })

    const rows = readSandboxLedger()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sandboxId: "m_fake",
      provider: "instabox",
      state: "booted",
    })

    const onDisk = readFileSync(sandboxLedgerPath(), "utf8")
    expect(onDisk).not.toContain(INSTABOX_KEY)

    // Sanity: the key IS persisted where it belongs.
    expect(existsSync(join(home, `${SANDBOX_FAMILY}-creds`, "instabox.json"))).toBe(true)
  })
})
