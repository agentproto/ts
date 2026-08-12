/**
 * Tests for `@agentproto/app-client/react` (`../react.ts`): `McpAppProvider`
 * resolving `connectMcpApp()` and handing it down via context, `useMcpTool`
 * staying disabled until connected, `useMcpToolMutation` invalidating the
 * given keys on success, and `useMcpTeardown` registering with the
 * connection. Hermetic: `window.McpApp` is stubbed per test (host mode) or
 * left absent (bridge/standalone), no real network or DOM host needed
 * beyond happy-dom.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactElement, type ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import {
  McpAppProvider,
  useMcpConnection,
  useMcpTeardown,
  useMcpTool,
  useMcpToolMutation,
} from "../react.js"
import type { ConnectOptions, McpAppBridge } from "../index.js"

afterEach(() => {
  vi.unstubAllGlobals()
  delete window.McpApp
})

function stubHost(bridge: Partial<McpAppBridge>): void {
  window.McpApp = { connect: () => Promise.resolve(bridge as McpAppBridge) }
}

function makeWrapper(options?: ConnectOptions): (props: { children: ReactNode }) => ReactElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(McpAppProvider, { options, children }),
    )
  }
}

describe("McpAppProvider / useMcpConnection", () => {
  it("starts null, then resolves to the host connection once connectMcpApp settles", async () => {
    stubHost({ callTool: () => Promise.resolve({}) })
    const { result } = renderHook(() => useMcpConnection(), { wrapper: makeWrapper() })

    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).not.toBeNull())
    expect(result.current?.mode).toBe("host")
  })

  it("resolves to bridge mode when there's no window.McpApp", async () => {
    const { result } = renderHook(() => useMcpConnection(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current).not.toBeNull())
    expect(result.current?.mode).toBe("bridge")
  })
})

describe("useMcpTool", () => {
  it("stays disabled until connected, then fetches via connection.callTool", async () => {
    const callTool = vi.fn().mockResolvedValue({ structuredContent: { count: 7 } })
    stubHost({ callTool })

    const { result } = renderHook(() => useMcpTool<{ count: number }>("get-count"), {
      wrapper: makeWrapper(),
    })

    expect(result.current.fetchStatus).toBe("idle")
    await waitFor(() => expect(result.current.data).toEqual({ count: 7 }))
    expect(callTool).toHaveBeenCalledWith("get-count", {})
  })

  it("stays disabled forever when options.enabled is false", async () => {
    const callTool = vi.fn().mockResolvedValue({})
    stubHost({ callTool })

    const { result } = renderHook(
      () => useMcpTool("get-count", undefined, { enabled: false }),
      { wrapper: makeWrapper() },
    )

    await waitFor(() => expect(useMcpConnection).toBeDefined())
    // give the connection a chance to resolve — it must not trigger a fetch.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(callTool).not.toHaveBeenCalled()
    expect(result.current.fetchStatus).toBe("idle")
  })

  it("surfaces a rejected callTool as the query's error", async () => {
    stubHost({ callTool: () => Promise.resolve({ isError: true, content: [{ type: "text", text: "nope" }] }) })

    const { result } = renderHook(() => useMcpTool("failing-tool"), { wrapper: makeWrapper() })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toMatchObject({ name: "McpToolError", toolName: "failing-tool" })
  })
})

describe("useMcpToolMutation", () => {
  it("calls callTool with the mutation args and invalidates the given keys on success", async () => {
    const callTool = vi.fn().mockResolvedValue({ structuredContent: { ok: true } })
    stubHost({ callTool })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries")
    const Wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, createElement(McpAppProvider, { children }))

    const { result } = renderHook(
      () => ({
        connection: useMcpConnection(),
        mutation: useMcpToolMutation<{ ok: boolean }, { id: string }>("do-thing", {
          invalidates: [["mcp-tool", "get-count"]],
        }),
      }),
      { wrapper: Wrapper },
    )

    await waitFor(() => expect(result.current.connection).not.toBeNull())

    await act(async () => {
      await result.current.mutation.mutateAsync({ id: "abc" })
    })

    expect(callTool).toHaveBeenCalledWith("do-thing", { id: "abc" })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["mcp-tool", "get-count"] })
  })
})

describe("useMcpTeardown", () => {
  it("registers the callback with the connection's onTeardown once connected", async () => {
    const onTeardown = vi.fn()
    stubHost({ callTool: () => Promise.resolve({}), onTeardown })
    const cb = (): void => {}

    renderHook(() => useMcpTeardown(cb), { wrapper: makeWrapper() })

    await waitFor(() => expect(onTeardown).toHaveBeenCalledWith(cb))
  })
})
