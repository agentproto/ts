import { describe, expect, it } from "vitest"
import { toToolResult } from "@agentproto/tool"
import {
  assertCapability,
  assertToolSupported,
  BROWSER_UNSUPPORTED_CODE,
  browserCapabilitiesSchema,
  BrowserUnsupportedError,
  hasCapability,
  isBrowserUnsupportedError,
} from "../index.js"
import { makeFakeProvider } from "./fake-provider.js"

describe("capability gate", () => {
  const noCdp = browserCapabilitiesSchema.parse({ downloads: true })

  it("passes when the capability is present", () => {
    expect(() => assertCapability(browserCapabilitiesSchema.parse({ cdp: true }), "cdp")).not.toThrow()
    expect(hasCapability(noCdp, "downloads")).toBe(true)
    expect(hasCapability(noCdp, "recording")).toBe(false)
    expect(hasCapability(browserCapabilitiesSchema.parse({ recording: "video" }), "recording")).toBe(true)
  })

  it("throws a typed error naming the missing capability", () => {
    let caught: unknown
    try {
      assertCapability(noCdp, "cdp", { providerId: "camofox", tool: "browser.list_requests" })
    } catch (err) {
      caught = err
    }
    expect(isBrowserUnsupportedError(caught)).toBe(true)
    const err = caught as BrowserUnsupportedError
    expect(err.code).toBe(BROWSER_UNSUPPORTED_CODE)
    expect(err.code).toBe("browser:unsupported")
    expect(err.capability).toBe("cdp")
    expect(err.message).toContain('"cdp"')
    expect(err.message).toContain("camofox")
    expect(err.message).toContain("browser.list_requests")
    expect(err.retryable).toBe(false)
  })

  it("maps to the AIP-14 envelope with cause.capability", () => {
    const result = toToolResult(undefined, new BrowserUnsupportedError({ capability: "cdp" }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("browser:unsupported")
      expect(result.error.message).toContain('"cdp"')
      expect(result.error.cause).toMatchObject({ capability: "cdp" })
    }
  })

  it("gates tools by id and ignores ungated tools", () => {
    expect(() => assertToolSupported(noCdp, "browser.navigate")).not.toThrow()
    expect(() => assertToolSupported(noCdp, "browser.download")).not.toThrow()
    for (const tool of ["browser.list_requests", "browser.get_request_body", "browser.cdp_send"]) {
      expect(() => assertToolSupported(noCdp, tool, "camofox")).toThrow(/"cdp"/)
    }
    expect(() => assertToolSupported(noCdp, "browser.act")).toThrow(/canAiActions/)
  })

  it("a driver on a provider without cdp fails listRequests with the typed error, not an opaque one", async () => {
    const { provider } = makeFakeProvider({ id: "nocdp" })
    const instance = await provider.launch({}, {})
    const driver = await instance.attach()
    await expect(driver.listRequests()).rejects.toMatchObject({
      code: "browser:unsupported",
      capability: "cdp",
    })
  })
})
