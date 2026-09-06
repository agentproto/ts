/**
 * `@agentproto/app-client/react` — TanStack Query hooks over the bridge
 * client in `./index.ts`.
 *
 * `McpAppProvider` owns the single `connectMcpApp()` promise for a UI tree:
 * it resolves once on mount (host → bridge → standalone, per `connectMcpApp`'s
 * frozen resolution order) and hands the result down via context.
 * `useMcpTool`/`useMcpToolMutation` are thin `useQuery`/`useMutation`
 * wrappers that stay disabled until that connection resolves, so an app
 * never races a `callTool` against a not-yet-connected bridge.
 *
 * This file is `.ts`, not `.tsx` (the package skeleton is frozen), so
 * component bodies use `React.createElement` instead of JSX.
 */

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query"

import { connectMcpApp, McpToolError, type ConnectOptions, type McpConnection } from "./index.js"

const McpConnectionContext = createContext<McpConnection | null>(null)

/** Context provider; owns the connectMcpApp() promise. */
export function McpAppProvider(props: {
  children: ReactNode
  options?: ConnectOptions
}): ReactElement {
  const { children, options } = props
  const [connection, setConnection] = useState<McpConnection | null>(null)

  useEffect(() => {
    let cancelled = false
    void connectMcpApp(options).then((resolved) => {
      if (!cancelled) setConnection(resolved)
    })
    return () => {
      cancelled = true
    }
    // Connect once per mount. `options` (in particular `standaloneTools`) is
    // typically a fresh object literal every render at the call site, so
    // depending on it would reconnect (and tear down an in-flight bridge)
    // on every render instead of once — mount `McpAppProvider` near the root
    // with stable options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return createElement(McpConnectionContext.Provider, { value: connection }, children)
}

/** The resolved connection (Suspense-free: returns null until ready). */
export function useMcpConnection(): McpConnection | null {
  return useContext(McpConnectionContext)
}

/** useQuery wrapper. queryKey = ["mcp-tool", name, args]. Disabled until
 *  the connection resolves (and by options.enabled). */
export function useMcpTool<TResult>(
  name: string,
  args?: Record<string, unknown>,
  options?: { enabled?: boolean; refetchInterval?: number },
): UseQueryResult<TResult, McpToolError> {
  const connection = useMcpConnection()

  return useQuery<TResult, McpToolError>({
    queryKey: ["mcp-tool", name, args],
    queryFn: async () => {
      if (!connection) {
        // Guarded by `enabled` below — reachable only if a query somehow
        // fires before the connection resolves.
        throw new McpToolError(name, "bridge", "McpAppProvider connection not ready")
      }
      return connection.callTool<TResult>(name, args)
    },
    enabled: connection !== null && (options?.enabled ?? true),
    refetchInterval: options?.refetchInterval,
  })
}

/** useMutation wrapper; invalidates the given ["mcp-tool", ...] keys on
 *  success. */
export function useMcpToolMutation<TResult, TArgs extends Record<string, unknown>>(
  name: string,
  options?: { invalidates?: ReadonlyArray<readonly unknown[]> },
): UseMutationResult<TResult, McpToolError, TArgs> {
  const connection = useMcpConnection()
  const queryClient = useQueryClient()

  return useMutation<TResult, McpToolError, TArgs>({
    mutationFn: async (args: TArgs) => {
      if (!connection) {
        throw new McpToolError(name, "bridge", "McpAppProvider connection not ready")
      }
      return connection.callTool<TResult>(name, args)
    },
    onSuccess: async () => {
      for (const key of options?.invalidates ?? []) {
        await queryClient.invalidateQueries({ queryKey: [...key] })
      }
    },
  })
}

/** Register cleanup with the host teardown (panel close / tab unload). */
export function useMcpTeardown(cb: () => void): void {
  const connection = useMcpConnection()

  useEffect(() => {
    if (!connection) return
    connection.onTeardown(cb)
    // McpConnection.onTeardown has no unregister — the underlying host/
    // bridge hook (postMessage teardown / beforeunload) is one-shot by
    // nature, so there's nothing to unwind on effect cleanup.
  }, [connection, cb])
}
