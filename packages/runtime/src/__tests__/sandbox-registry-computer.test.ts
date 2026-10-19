import { describe, it, expect } from "vitest"
import { computerSandboxProvider } from "@agentproto/sandbox-computer"
import { resolveSandboxProvider } from "../sandbox-providers/registry.js"

describe("sandbox provider registry: computer", () => {
  it("resolves the third-party computer handle with sharedSessions capability", async () => {
    const handle = await resolveSandboxProvider("computer", {
      importPackage: async () => ({ computerSandboxProvider }),
    })
    expect(handle).not.toBeNull()
    expect(handle!.slug).toBe("computer")
    expect(handle!.name).toBe("Computer")
    expect(handle!.provider).toBe(computerSandboxProvider)
    expect(handle!.capabilities).toMatchObject({
      lifecyclePause: true,
      exec: true,
      sharedSessions: true,
    })
    expect(handle!.defaultCwd).toBe("/home/user")
    expect(handle!.setupFields?.map((f) => f.name)).toEqual(["apiKey", "controllerUrl", "tenantId", "gatewayUrl"])
  })

  it("reports the catalog placeholder as null when the package is missing", async () => {
    const probeMissing = () => null
    const handle = await resolveSandboxProvider("computer", { importPackage: async () => { throw new Error("nope") } })
    expect(handle).toBeNull()
    void probeMissing
  })

  it("stores creds fill both credentials' env vars when unset", async () => {
    const previousToken = process.env.COMPUTER_CONTROLLER_TOKEN
    const previousUrl = process.env.COMPUTER_CONTROLLER_URL
    delete process.env.COMPUTER_CONTROLLER_TOKEN
    delete process.env.COMPUTER_CONTROLLER_URL
    const previousTenant = process.env.COMPUTER_TENANT_ID
    delete process.env.COMPUTER_TENANT_ID
    const previousGateway = process.env.COMPUTER_GATEWAY_URL
    delete process.env.COMPUTER_GATEWAY_URL
    try {
      await resolveSandboxProvider("computer", {
        importPackage: async () => ({ computerSandboxProvider }),
        creds: {
          apiKey: "stored-token",
          controllerUrl: "http://stored:7110",
          tenantId: "t1",
          gatewayUrl: "http://127.0.0.1:{hostPort}",
        },
      })
      expect(process.env.COMPUTER_CONTROLLER_TOKEN).toBe("stored-token")
      expect(process.env.COMPUTER_CONTROLLER_URL).toBe("http://stored:7110")
      expect(process.env.COMPUTER_TENANT_ID).toBe("t1")
      expect(process.env.COMPUTER_GATEWAY_URL).toBe("http://127.0.0.1:{hostPort}")
    } finally {
      if (previousGateway === undefined) delete process.env.COMPUTER_GATEWAY_URL
      else process.env.COMPUTER_GATEWAY_URL = previousGateway
      if (previousTenant === undefined) delete process.env.COMPUTER_TENANT_ID
      else process.env.COMPUTER_TENANT_ID = previousTenant
      if (previousToken === undefined) delete process.env.COMPUTER_CONTROLLER_TOKEN
      else process.env.COMPUTER_CONTROLLER_TOKEN = previousToken
      if (previousUrl === undefined) delete process.env.COMPUTER_CONTROLLER_URL
      else process.env.COMPUTER_CONTROLLER_URL = previousUrl
    }
  })
})
