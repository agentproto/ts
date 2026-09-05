# @agentproto/app-client

Typed client for the `window.McpApp` bridge an agentproto host injects into
an app's UI, plus TanStack Query hooks. `connectMcpApp()` resolves **host**
(MCP-Apps panel / `agentproto app serve`) → **bridge** (`agentproto app dev`)
→ **standalone** (plain `vite dev`, `file://`), so the same UI code runs
embedded, in dev, and as a static page with no mode branching in app code.

Zero runtime deps on the `.` entry. The `./react` entry additionally needs
`react` and `@tanstack/react-query` (peer deps).

## The three modes

| Mode         | When                                                        | How `callTool` gets there                                  |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `host`       | Embedded in an MCP-Apps panel, or `agentproto app serve`      | `window.McpApp.connect()`, injected by the host              |
| `bridge`     | `agentproto app dev` (Vite dev server + bridge proxy)         | same-origin `POST /__agentproto/tool-call`                   |
| `standalone` | Bare `vite dev` / `vite preview` / `file://`, no daemon nearby | your own mock handlers, passed as `standaloneTools`          |

Mode detection never does an upfront network probe. If `window.McpApp` is
missing, the connection starts in `bridge` mode optimistically; only the
*first* `callTool` finds out whether the bridge route is really there. A
network failure, a `404`, or a non-JSON response on that first call flips
the connection **permanently** to `standalone` and replays the call against
`standaloneTools` — so a UI you're iterating on without the daemon running
never hard-fails, it just falls back to your mocks.

## Usage — framework-free

```ts
import { connectMcpApp } from "@agentproto/app-client"

const conn = await connectMcpApp({
  // Only exercised in standalone mode (no host, no bridge reachable).
  standaloneTools: {
    "list-items": () => ({ items: [{ id: "1", label: "Demo item" }] }),
  },
})

const { items } = await conn.callTool<{ items: unknown[] }>("list-items")

conn.onModeChange((mode) => console.log("downgraded to", mode))
await conn.updateModelContext({ currentView: "list" })
await conn.openLink("https://example.com")
conn.onTeardown(() => cleanupSubscriptions())
```

`callTool<TResult>()` unwraps the raw MCP `tools/call` result: an
`isError` envelope rejects with `McpToolError`; `structuredContent` wins if
present; otherwise the first text content block is `JSON.parse`d when
possible, else returned as a string; no content resolves to `{}`. The
caller supplies `TResult` — there's no runtime shape validation.

## Usage — React (`@agentproto/app-client/react`)

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { McpAppProvider, useMcpTool, useMcpToolMutation, useMcpTeardown } from "@agentproto/app-client/react"

const queryClient = new QueryClient()

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <McpAppProvider
        options={{
          standaloneTools: {
            "list-items": () => ({ items: [] }),
          },
        }}
      >
        <ItemList />
      </McpAppProvider>
    </QueryClientProvider>
  )
}

function ItemList() {
  const { data, isPending, error } = useMcpTool<{ items: { id: string; label: string }[] }>("list-items")
  const addItem = useMcpToolMutation<{ id: string }, { label: string }>("add-item", {
    invalidates: [["mcp-tool", "list-items"]],
  })

  useMcpTeardown(() => console.log("panel closing / tab unloading"))

  if (isPending) return <p>Loading…</p>
  if (error) return <p>Failed: {error.message}</p>

  return (
    <ul>
      {data?.items.map((item) => (
        <li key={item.id}>{item.label}</li>
      ))}
      <button onClick={() => addItem.mutate({ label: "New item" })}>Add</button>
    </ul>
  )
}
```

- `useMcpTool` is a `useQuery` wrapper keyed `["mcp-tool", name, args]`,
  disabled until `McpAppProvider`'s connection resolves (and by
  `options.enabled`).
- `useMcpToolMutation` is a `useMutation` wrapper that invalidates the
  `invalidates` query keys on success.
- `useMcpConnection()` returns the raw `McpConnection` (`null` until ready)
  for anything the hooks above don't cover — e.g. reading `.mode` to render
  a "running standalone" badge.
- Mount `McpAppProvider` once near the root with stable `options` — it
  connects once on mount and does not reconnect on re-renders.

## Runner selector (harness + model)

`@agentproto/app-client/runner-select` exports `RUNNER_SELECT_SCRIPT`, a
plain ES5 `<script>` block (`injectRunnerSelect(html)` inlines it into a
served page, the same way a host injects the `window.McpApp` bridge) that
defines `window.AgentprotoUI.mountRunnerSelect`. It discovers the host's
installed harnesses/models via `adapter_list` + `harness_preset_list` (an
app's own `callTool` — no daemon coupling), so an app UI never has to
hardcode a harness/model `<select>` again:

```html
<script>
  const runner = window.AgentprotoUI.mountRunnerSelect(
    document.getElementById("runner-slot"),
    { callTool: callApp }, // your app's own tool-call wrapper
  )

  async function run() {
    const { appId, agents } = await callApp("app_run", {
      appId: "my-app",
      agents: ["writer"],
      prompt: "...",
      ...runner.getRunner(), // { harness, model? }
    })
  }
</script>
```

`getRunner()` never returns `access`/`profileRef` — the daemon's default
harness preset resolves billing for whichever harness the caller picked.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
