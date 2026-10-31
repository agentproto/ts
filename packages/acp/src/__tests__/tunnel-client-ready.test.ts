import { describe, expect, it } from "vitest"
import { createTunnelClient } from "../tunnel/client.js"
import { connect } from "./e2e-harness.js"

describe("tunnel client ready()", () => {
  it("rejects on a tunnel-level error before hello", async () => {
    const { a, b } = connect()
    const client = createTunnelClient({ sink: a, helloTimeoutMs: 5_000 })
    const ready = client.ready()
    b.send({ t: "error", code: "pairing_revoked", message: "this device was unpaired" })
    await expect(ready).rejects.toThrow(/pairing_revoked/)
    await client.close()
  })

  it("rejects when the transport closes before hello", async () => {
    const { a, b } = connect()
    const client = createTunnelClient({ sink: a, helloTimeoutMs: 5_000 })
    const ready = client.ready()
    b.close("pairing_revoked")
    await expect(ready).rejects.toThrow(/closed before hello/)
    await client.close()
  })
})
