import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { STRIPE_API_VERSION } from "../api-version.js"
import { FIXTURES_DIR } from "./kit.js"

// The fixtures are built by hand from the public API reference. They must stay clean:
// no private name of this repository's list, no e-mail outside example.com, no Stripe URL.
const namesFile = fileURLToPath(new URL("../../../../scripts/private-names.json", import.meta.url))
const names = (JSON.parse(readFileSync(namesFile, "utf8")) as { names: string[] }).names.map(n => new RegExp(n, "i"))
const files = readdirSync(FIXTURES_DIR).filter(f => f.endsWith(".json"))

describe("fixtures", () => {
  it("there are fixtures, and the private name list is read", () => {
    expect(files.length).toBeGreaterThan(10)
    expect(names.length).toBeGreaterThan(0)
  })
  for (const file of files) {
    it(`${file} is clean`, () => {
      const text = readFileSync(`${FIXTURES_DIR}${file}`, "utf8")
      for (const re of names) expect(re.test(text) || re.test(file), `${file} matches a private name`).toBe(false)
      for (const email of text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []) expect(email.endsWith("@example.com"), `${file}: e-mail ${email}`).toBe(true)
      expect(/stripe\.com/i.test(text), `${file} holds a stripe.com URL`).toBe(false)
      const json = JSON.parse(text) as { object?: string; api_version?: string; livemode?: boolean }
      if (json.object === "event") {
        expect(json.api_version).toBe(STRIPE_API_VERSION)
        expect(json.livemode).toBe(false)
      }
    })
  }
  it("the cleanliness check catches what it must", () => {
    const dirty = '{"email":"someone@gmail.com","url":"https://invoice.stripe.com/i/x"}'
    expect((dirty.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []).every(e => e.endsWith("@example.com"))).toBe(false)
    expect(/stripe\.com/i.test(dirty)).toBe(true)
  })
})
