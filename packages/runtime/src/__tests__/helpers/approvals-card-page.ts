/**
 * Runs an approval card page's inline script in a `vm` against a small fake
 * DOM and a fake MCP Apps host. The host answers `ui/initialize` and, when
 * given a `callTool`, forwards the page's `tools/call` requests to it (the
 * tests wire that to a real MCP client on the cards surface).
 */

import vm from "node:vm"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { buildApprovalCardsServer } from "../../approvals/card-surface.js"
import type { ApprovalsEngine } from "../../approvals/engine.js"

const realSetImmediate = globalThis.setImmediate
const realNow = Date.now.bind(Date)
const FLUSH_DEADLINE_MS = 15_000

export interface Posted {
  jsonrpc?: string
  id?: number
  method?: string
  params?: Record<string, unknown>
}

export class FakeNode {
  readonly children: FakeNode[] = []
  parent: FakeNode | undefined
  className = ""
  disabled = false
  hidden = false
  style: Record<string, string> = {}
  attrs: Record<string, string> = {}
  listeners: Record<string, () => void> = {}
  private own = ""

  constructor(
    readonly tag: string,
    readonly id = "",
  ) {}

  get textContent(): string {
    return this.own + this.children.map(c => c.textContent).join("")
  }

  set textContent(value: string) {
    this.children.length = 0
    this.own = String(value)
  }

  appendChild(child: FakeNode): FakeNode {
    child.remove()
    child.parent = this
    this.children.push(child)
    return child
  }

  remove(): void {
    if (!this.parent) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = undefined
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null
  }

  addEventListener(type: string, fn: () => void): void {
    this.listeners[type] = fn
  }

  click(): void {
    if (!this.disabled) this.listeners["click"]?.()
  }

  findAll(match: (node: FakeNode) => boolean): FakeNode[] {
    const out: FakeNode[] = []
    for (const child of this.children) {
      if (match(child)) out.push(child)
      out.push(...child.findAll(match))
    }
    return out
  }
}

export interface CardPageOptions {
  /** Answers the page's `tools/call` requests. Without it they stay unanswered. */
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>
  /** Answer `ui/initialize` with an empty host context. Default true. */
  autoInit?: boolean
  /** The page's `setInterval`. Default: a no-op. */
  setInterval?: (fn: () => void, ms: number) => unknown
  bodyHeight?: { value: number }
}

export function runCardPage(html: string, opts: CardPageOptions = {}) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/)
  if (!match) throw new Error("no inline script in the card")
  const posted: Posted[] = []
  const rootAttrs: Record<string, string> = {}
  const rootVars: Record<string, string> = {}
  const cardsEl = new FakeNode("div", "cards")
  const note = new FakeNode("p", "note")
  const bodyHeight = opts.bodyHeight ?? { value: 100 }
  let inflight = 0
  let onMessage: (evt: { data: unknown; source?: unknown }) => void = () => {}

  const parent = {
    postMessage: (msg: Posted) => {
      posted.push(msg)
      if (msg.id === undefined || msg.method === undefined) return
      const id = msg.id
      if (msg.method === "ui/initialize" && opts.autoInit !== false) {
        void Promise.resolve().then(() => reply(id, { hostContext: {} }))
      } else if (msg.method === "tools/call" && opts.callTool) {
        const params = msg.params as { name: string; arguments?: Record<string, unknown> }
        inflight++
        opts.callTool(params.name, params.arguments ?? {}).then(
          result => {
            inflight--
            reply(id, result)
          },
          (err: unknown) => {
            inflight--
            reject(id, err instanceof Error ? err.message : String(err))
          },
        )
      }
    },
  }
  const reply = (id: number, result: unknown) => onMessage({ data: { jsonrpc: "2.0", id, result }, source: parent })
  const reject = (id: number, message = "bad") =>
    onMessage({ data: { jsonrpc: "2.0", id, error: { code: -32600, message } }, source: parent })

  const doc = {
    visibilityState: "visible",
    documentElement: {
      setAttribute: (k: string, v: string) => void (rootAttrs[k] = v),
      style: {
        setProperty: (k: string, v: string) => void (rootVars[k] = v),
        removeProperty: (k: string) => void delete rootVars[k],
      },
    },
    body: { getBoundingClientRect: () => ({ height: bodyHeight.value }) },
    createElement: (tag: string) => new FakeNode(tag),
    getElementById: (id: string) => (id === "cards" ? cardsEl : id === "note" ? note : undefined),
  }
  let resize: () => void = () => {}
  vm.runInNewContext(match[1]!, {
    window: {
      parent,
      addEventListener: (type: string, fn: typeof onMessage) => {
        if (type === "message") onMessage = fn
      },
    },
    document: doc,
    ResizeObserver: class {
      constructor(cb: () => void) {
        resize = cb
      }
      observe(): void {}
    },
    setInterval: opts.setInterval ?? (() => 1),
    clearInterval: () => {},
    Date,
  })

  /** Lets the page settle: waits, on a real-time deadline, until no tool call
   *  is in flight. Not a tick count: a ticking loop of `setImmediate` runs in
   *  microseconds and would give up long before a slow host answers. */
  const flush = async (): Promise<void> => {
    const deadline = realNow() + FLUSH_DEADLINE_MS
    let quiet = 0
    while (quiet < 4) {
      if (realNow() > deadline) throw new Error(`card page did not settle: ${inflight} tool call(s) still in flight`)
      await new Promise<void>(resolve => realSetImmediate(resolve))
      quiet = inflight === 0 ? quiet + 1 : 0
    }
  }
  const cards = () => cardsEl.children
  const buttons = (card: FakeNode) => {
    const all = card.findAll(n => n.tag === "button")
    return {
      approve: all.find(b => b.textContent === "Approve")!,
      deny: all.find(b => b.textContent === "Refuse")!,
    }
  }
  const titleOf = (card: FakeNode) => card.findAll(n => n.tag === "h3")[0]?.textContent ?? ""
  const metaOf = (card: FakeNode) => card.findAll(n => n.className === "meta")[0]?.textContent ?? ""
  const statusOf = (card: FakeNode) => card.findAll(n => n.className === "status")[0]?.textContent ?? ""
  const actionsOf = (card: FakeNode) => card.findAll(n => n.className === "actions")[0]!
  const sizes = () => posted.filter(m => m.method === "ui/notifications/size-changed").map(m => m.params?.height)
  const calls = (name?: string) =>
    posted.filter(m => m.method === "tools/call" && (name === undefined || m.params?.["name"] === name))

  return {
    posted,
    doc,
    note,
    cardsEl,
    rootAttrs,
    rootVars,
    reply,
    reject,
    flush,
    cards,
    buttons,
    titleOf,
    metaOf,
    statusOf,
    actionsOf,
    sizes,
    calls,
    parent,
    deliver: (data: unknown, source?: unknown) => onMessage({ data, source }),
    resize: () => resize(),
    notify: (method: string, params: Record<string, unknown> = {}) =>
      onMessage({ data: { jsonrpc: "2.0", method, params }, source: parent }),
    text: () => cardsEl.textContent + note.textContent,
  }
}

export type CardPage = ReturnType<typeof runCardPage>

/** A real MCP client on the production cards surface, and the host-side
 *  `callTool` that forwards a page's tool calls to it. */
export async function connectCards(engine: ApprovalsEngine) {
  const server = buildApprovalCardsServer(engine, { surface: "approval-cards" }, { name: "cards", version: "0" })
  if (!server) throw new Error("cards surface not built")
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "card-page-host", version: "0" })
  await client.connect(clientTransport)
  const callTool = (name: string, args: Record<string, unknown>): Promise<unknown> =>
    client.callTool({ name, arguments: args })
  return { client, callTool, close: () => client.close() }
}

export async function readCardHtml(client: Client, uri: string): Promise<string> {
  const read = await client.readResource({ uri })
  const content = read.contents[0]
  if (!content || !("text" in content)) throw new Error("resource read returned no text content")
  return content.text
}
