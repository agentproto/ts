/**
 * The pairing service worker (AIP-59 §5): registered once per paired daemon
 * with scope `/d/<id>/`, it answers every fetch under that scope from the
 * daemon, through the E2E rendezvous tunnel (`@agentproto/pair-client`). The
 * Control Center page, its REST and `/mcp` calls and its SSE streams all come
 * from the daemon this way; the pair page's server hosts none of it.
 *
 * ONE `TunnelClient` per registration, at module scope, shared by every fetch
 * event (§5.3): the daemon parks a bounded number of channels per pairing, so
 * the pages never connect themselves; they ask this worker for its state
 * instead (`agentproto-pair:*` messages, see src/lib/pair.ts). When the
 * browser stops an idle worker the client goes with it, and the next event
 * builds a new one (§5.7).
 *
 * Responses synthesized here from the daemon (the Control Center document
 * included) never pass through the edge Worker, so they don't carry its
 * headers: the daemon UI's CSP is the daemon's own responsibility.
 *
 * Bundled by scripts/build.mjs to dist/pair-sw.js.
 */

import {
  connect,
  createIndexedDbCredentialStore,
  TunnelClientError,
  type StateChange,
  type TunnelClient,
} from "@agentproto/pair-client"
import { pageMode, scopeCredentialStore } from "./lib/host"
import {
  CONTROL_CENTER_PATH,
  isOutdatedPairingError,
  isPairingId,
  statusPath,
  type PairState,
  type PairWorkerRequest,
  type PairWorkerStatus,
} from "./lib/pair"

declare const self: ServiceWorkerGlobalScope

/** Offline this long with a Control Center open → send it to the status page
 *  (which shows "daemon offline, retrying" and comes back once connected). A
 *  short blip stays invisible: the Control Center retries on its own. */
const OFFLINE_GRACE_MS = 8_000

const scope = new URL(self.registration.scope).pathname // "/d/<id>/"
const id = scope.split("/")[2] ?? ""
const prefix = scope.slice(0, -1) // "/d/<id>"

// On a daemon origin this only ever yields that daemon's credential (§5.8).
const store = scopeCredentialStore(createIndexedDbCredentialStore(), pageMode(self.location.hostname))
let client: TunnelClient | null = null
let building: Promise<TunnelClient> | null = null
let notPaired = false
let offlineTimer: ReturnType<typeof setTimeout> | null = null

class NotPairedError extends Error {
  readonly code = "not_paired"
}

function getClient(): Promise<TunnelClient> {
  // Kept even when closed as outdated: rebuilding would only be refused again.
  if (client && (client.state !== "closed" || isOutdatedPairingError(client.lastError))) {
    return Promise.resolve(client)
  }
  building ??= (async () => {
    const credential = isPairingId(id) ? await store.get(id) : undefined
    notPaired = !credential
    if (!credential) throw new NotPairedError(`no pairing stored for ${id}`)
    const c = connect(credential, {
      store,
      mapPath: url => url.pathname.slice(prefix.length) + url.search,
    })
    c.onStateChange(change => onState(c, change))
    client = c
    return c
  })().finally(() => {
    building = null
  })
  return building
}

function dropClient(): void {
  client?.close()
  client = null
  notPaired = false
}

function currentStatus(): PairWorkerStatus {
  const err = client?.lastError
  // A credential from before the current pairing protocol is refused before
  // any dial; key on the error as well as the state.
  const state: PairState = notPaired
    ? "not_paired"
    : isOutdatedPairingError(err)
      ? "outdated"
      : (client?.state ?? "connecting")
  return {
    type: "agentproto-pair:state",
    id,
    state,
    ...(client ? { daemonName: client.credential.name } : {}),
    ...(err && state !== "open" ? { error: { code: err.code, message: err.message } } : {}),
  }
}

async function broadcast(): Promise<void> {
  const status = currentStatus()
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  for (const w of windows) w.postMessage(status)
}

/** Send every Control Center this worker controls to the status page. */
async function leaveControlCenter(state: PairState): Promise<void> {
  const windows = await self.clients.matchAll({ type: "window" })
  for (const w of windows) {
    const here = new URL(w.url)
    const next = here.pathname + here.search + here.hash
    void w.navigate(`${statusPath(id)}?state=${state}&next=${encodeURIComponent(next)}`).catch(() => {})
  }
}

function onState(c: TunnelClient, change: StateChange): void {
  if (c !== client) return
  const state = isOutdatedPairingError(change.error ?? c.lastError) ? "outdated" : change.state
  void broadcast()
  if (offlineTimer && state !== "offline") {
    clearTimeout(offlineTimer)
    offlineTimer = null
  }
  // Both terminal: the client stops retrying, and only a new pairing helps.
  if (state === "revoked" || state === "outdated") void leaveControlCenter(state)
  if (state === "offline" && !offlineTimer) {
    offlineTimer = setTimeout(() => {
      offlineTimer = null
      if (client === c && c.state !== "open") void leaveControlCenter("offline")
    }, OFFLINE_GRACE_MS)
  }
}

/** The `state=` hint for the status page. */
function errorCode(err: unknown): string {
  if (isOutdatedPairingError(err)) return "outdated"
  if (err instanceof TunnelClientError || err instanceof NotPairedError) return err.code
  return "error"
}

async function proxy(request: Request): Promise<Response> {
  try {
    const c = await getClient()
    return await c.fetch(request)
  } catch (err) {
    // The page went away (or cancelled the request): nobody reads this.
    if (request.signal.aborted) throw err
    const code = errorCode(err)
    if (request.mode === "navigate") {
      // A page load that can't reach the daemon lands on the status page,
      // which retries and comes back here once the tunnel is up.
      const url = new URL(request.url)
      const next = encodeURIComponent(url.pathname + url.search)
      return Response.redirect(`${statusPath(id)}?state=${code}&next=${next}`, 302)
    }
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: code, message }, { status: code === "revoked" ? 410 : 503 })
  }
}

self.addEventListener("install", () => {
  void self.skipWaiting()
})

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url)
  // A controlled page's requests elsewhere (other origins, this bundle's own
  // routes) go to the network as usual (§5.1: answer only under the scope).
  if (url.origin !== self.location.origin || !url.pathname.startsWith(scope)) return
  if (url.pathname === scope && event.request.mode === "navigate") {
    // The scope root (home-screen launches, bare links) opens the Control Center.
    event.respondWith(Response.redirect(`${prefix}${CONTROL_CENTER_PATH}${url.search}`, 302))
    return
  }
  event.respondWith(proxy(event.request))
})

self.addEventListener("message", event => {
  const data = event.data as PairWorkerRequest | undefined
  const source = event.source
  const reply = (): void => {
    if (source && "postMessage" in source) source.postMessage(currentStatus())
  }
  switch (data?.type) {
    case "agentproto-pair:status":
      event.waitUntil(getClient().then(reply, reply))
      break
    case "agentproto-pair:reconnect":
      client?.reconnect()
      event.waitUntil(getClient().then(reply, reply))
      break
    case "agentproto-pair:reset":
      dropClient()
      event.waitUntil(getClient().then(reply, reply))
      break
  }
})
