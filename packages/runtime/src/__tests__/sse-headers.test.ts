import { describe, expect, it, vi } from "vitest"
import type { ServerResponse } from "node:http"

import { SSE_HEADERS, writeSseHead } from "../sse-headers.js"

describe("writeSseHead", () => {
  it("writes the shared anti-buffering SSE headers", () => {
    const writeHead = vi.fn()
    writeSseHead({ writeHead } as unknown as ServerResponse)
    expect(writeHead).toHaveBeenCalledWith(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    })
  })

  it("merges route-specific extras without dropping the shared ones", () => {
    const writeHead = vi.fn()
    writeSseHead({ writeHead } as unknown as ServerResponse, {
      "x-vercel-ai-ui-message-stream": "v1",
    })
    expect(writeHead).toHaveBeenCalledWith(200, {
      ...SSE_HEADERS,
      "x-vercel-ai-ui-message-stream": "v1",
    })
  })
})
