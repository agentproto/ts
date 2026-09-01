/** Minimal fetch stand-in for driver tests — builds real `Response` objects
 *  so tests never duck-type one by hand. The single cast at the bottom
 *  mirrors the pattern in packages/relay/src/daemon-client.test.ts. */

export interface FakeFetchCall {
  readonly url: string
  readonly init?: RequestInit
}

export interface FakeFetchResponse {
  readonly status?: number
  readonly body?: unknown
  readonly text?: string
}

export function fakeFetch(
  handler: (url: string, init: RequestInit | undefined) => FakeFetchResponse,
): { fetch: typeof fetch; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    calls.push({ url, init })
    const { status = 200, body, text } = handler(url, init)
    const payload = text ?? (body === undefined ? "" : JSON.stringify(body))
    return new Response(payload, { status, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  return { fetch: impl, calls }
}
