/**
 * HTTP routes of the device pairing binding (see `device-access.ts`):
 *
 *   POST /device-pair/request         a device presents an offer, gets a number to compare
 *   GET  /device-pair/request/:id     the device polls (X-Poll-Secret); the token is delivered once
 *   GET  /device/me                   the device's identity and the apps it may open (Bearer dvt_…)
 *   GET  /pair                        the page a pairing link opens (code in the fragment)
 *   GET  /.well-known/assetlinks.json Android App Links proof, from `~/.agentproto/assetlinks.json`
 *
 * The first two are open on purpose: the offer is the only credential, and a
 * request still needs a human confirmation. Confirmation is an approval of the
 * daemon's approvals engine, decided only by a human channel (a Telegram card,
 * the approval page); no tool can decide it. Without that engine the request
 * is refused (nothing is ever approved by default).
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"

import type { ApprovalsEngine } from "./approvals/engine.js"
import type { AppRegistry } from "./app-registry.js"
import {
  extractDeviceToken,
  getDeviceAccessStore,
  grantAllowsApp,
  type AccessDeviceInfo,
  type DeviceAccessStore,
  type DeviceGrant,
} from "./device-access.js"

export const DEVICE_PAIR_KIND = "device_pairing"
/** The package the pairing page hands the code to (the hub shell). */
export const HUB_ANDROID_PACKAGE = "sh.agentproto.hub"
const MAX_BODY_BYTES = 8 * 1024

export type DeviceRoute = "request" | "poll" | "me" | "landing" | "assetlinks"

const POLL_RE = /^\/device-pair\/request\/([A-Za-z0-9_]+)$/

/** Which device route a request is, if any. */
export function deviceRoute(method: string, path: string): { route: DeviceRoute; id?: string } | undefined {
  if (path === "/device-pair/request" && (method === "POST" || method === "OPTIONS")) return { route: "request" }
  const poll = POLL_RE.exec(path)
  if (poll && (method === "GET" || method === "OPTIONS")) return { route: "poll", id: poll[1]! }
  if (path === "/device/me" && (method === "GET" || method === "OPTIONS")) return { route: "me" }
  if (path === "/pair" && method === "GET") return { route: "landing" }
  if (path === "/.well-known/assetlinks.json" && method === "GET") return { route: "assetlinks" }
  return undefined
}

/** The routes a daemon in bearer mode must let through without the daemon bearer. */
export function isOpenDeviceRoute(method: string, path: string): boolean {
  const r = deviceRoute(method, path)
  return r !== undefined && r.route !== "me"
}

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra })
  res.end(JSON.stringify(body))
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,x-poll-secret,authorization",
  "access-control-max-age": "600",
}

async function readSmallJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer)
    size += b.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(b)
  }
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export interface DeviceHttpDeps {
  approvals?: ApprovalsEngine
  appRegistry?: AppRegistry
  store?: DeviceAccessStore
  /** Where the Android App Links proof lives. */
  assetLinksPath?: string
  machineName?: string
}

function describeGrant(grant: DeviceGrant): string {
  const apps = grant.apps === "*" ? "all apps" : grant.apps.join(", ")
  return grant.sessionsRead ? `${apps}, and session reads` : apps
}

/** Approval status as the pairing request understands it. */
function decidedFrom(approvals: ApprovalsEngine | undefined, approvalId: string | undefined): "approved" | "denied" | "expired" | undefined {
  if (!approvals || !approvalId) return undefined
  const rec = approvals.get(approvalId)
  if (!rec) return undefined
  if (rec.status === "approved" || rec.status === "consumed") return "approved"
  if (rec.status === "denied") return "denied"
  if (rec.status === "expired") return "expired"
  return undefined
}

/** The apps of this machine a device may open. */
export function appsFor(grant: DeviceGrant, registry: AppRegistry | undefined): Array<Record<string, string>> {
  if (!registry) return []
  return registry
    .listApps()
    .filter(a => a.ui && a.access?.remote !== false && grantAllowsApp(grant, a.appId))
    .map(a => ({
      appId: a.appId,
      name: a.name ?? a.appId,
      ...(a.description ? { description: a.description.slice(0, 280) } : {}),
      ...(a.version ? { version: a.version } : {}),
      uiPath: `/apps/${a.appId}/ui`,
    }))
}

/** Answers a device route. Returns false when the request is not one. */
export async function handleDeviceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  deps: DeviceHttpDeps,
): Promise<boolean> {
  const hit = deviceRoute(method, path)
  if (!hit) return false
  const store = deps.store ?? getDeviceAccessStore()

  if (method === "OPTIONS") {
    res.writeHead(204, CORS)
    res.end()
    return true
  }

  if (hit.route === "landing") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    })
    res.end(renderPairingPage())
    return true
  }

  if (hit.route === "assetlinks") {
    const file = deps.assetLinksPath ?? join(process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto"), "assetlinks.json")
    if (!existsSync(file)) {
      json(res, 404, { error: "not_found" })
      return true
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" })
    res.end(readFileSync(file))
    return true
  }

  if (hit.route === "request") {
    const body = await readSmallJson(req)
    if (!body || typeof body.offer !== "string" || body.offer.length === 0 || body.offer.length > 64) {
      json(res, 400, { error: "bad_request" }, CORS)
      return true
    }
    if (!deps.approvals) {
      // Nothing may be approved without a human channel.
      json(res, 503, { error: "no_confirmation_channel", message: "This machine has no way to confirm a new device (approvals are off)." }, CORS)
      return true
    }
    const r = store.request({
      offer: body.offer,
      ...(typeof body.deviceName === "string" ? { deviceName: body.deviceName } : {}),
      ...(typeof body.platform === "string" ? { platform: body.platform } : {}),
    })
    if (!r.ok) {
      const status = r.error === "locked" ? 429 : r.error === "offer_expired" ? 410 : 400
      json(res, status, { error: r.error }, CORS)
      return true
    }
    try {
      const approval = deps.approvals.request(
        {
          kind: DEVICE_PAIR_KIND,
          title: `${r.deviceName} (${r.platform}) wants access. Compare the number: ${r.number}`,
          preview: {
            summary:
              `**${r.deviceName}** (${r.platform}) asks to connect to ${deps.machineName ?? hostname()}.\n\n` +
              `The number on its screen must be **${r.number}**. If it is not, refuse.\n\n` +
              `It would be able to open: ${describeGrant(r.grant)}.`,
            number: r.number,
            deviceName: r.deviceName,
            platform: r.platform,
            apps: r.grant.apps,
            sessionsRead: r.grant.sessionsRead,
          },
          payload: { requestId: r.requestId, number: r.number, deviceName: r.deviceName, platform: r.platform, grant: r.grant },
          expiresAt: r.expiresAt,
        },
        { operator: true },
      )
      store.attachApproval(r.requestId, approval.id)
    } catch (err) {
      // No card, no way to confirm: the request cannot be approved, so end it.
      store.decide(r.requestId, "deny")
      console.warn(`device-pair: could not open the confirmation: ${err instanceof Error ? err.message : String(err)}`)
      json(res, 503, { error: "no_confirmation_channel" }, CORS)
      return true
    }
    json(res, 200, { requestId: r.requestId, pollSecret: r.pollSecret, number: r.number, expiresAt: r.expiresAt }, CORS)
    return true
  }

  if (hit.route === "poll") {
    const secretHeader = req.headers["x-poll-secret"]
    const secret = typeof secretHeader === "string" ? secretHeader : ""
    const info = store.describeRequest(hit.id!)
    const out = store.poll(hit.id!, secret, decidedFrom(deps.approvals, info?.approvalId))
    if (!out.ok) {
      json(res, out.error === "already_delivered" ? 410 : 404, { error: out.error }, CORS)
      return true
    }
    if (out.status === "approved") {
      json(res, 200, { status: "approved", token: out.token, deviceId: out.deviceId }, CORS)
    } else {
      json(res, 200, { status: out.status }, CORS)
    }
    return true
  }

  // GET /device/me
  const token = extractDeviceToken(req)
  if (!token) {
    json(res, 401, { error: "unauthorized" }, CORS)
    return true
  }
  const checked = store.check(token)
  if ("error" in checked) {
    json(res, 401, { error: checked.error === "access_revoked" ? "access_revoked" : "unauthorized" }, CORS)
    return true
  }
  const d: AccessDeviceInfo = checked.device
  json(
    res,
    200,
    {
      deviceId: d.id,
      name: d.name,
      platform: d.platform,
      machine: { name: deps.machineName ?? hostname() },
      apps: appsFor(d.grant, deps.appRegistry),
      sessionsRead: d.grant.sessionsRead,
    },
    CORS,
  )
  return true
}

// ── gates used by the daemon's main request handler ───────────────────────────

export type DeviceCallAuth =
  | { kind: "none" }
  | { kind: "ok"; device: AccessDeviceInfo }
  | { kind: "refused"; status: 401 | 403; error: "access_revoked" | "unauthorized" | "grant_out_of_scope" | "cross_origin" }

/**
 * A request that carries a device token, for the tool-call route of `appId`.
 * `none` = no device token (other gates decide). A cookie token also needs the
 * request to be same-origin (a bearer header cannot be sent by a foreign page).
 */
export function deviceToolCallAuth(
  req: IncomingMessage,
  appId: string,
  opts: { store?: DeviceAccessStore; sameOrigin: (req: IncomingMessage) => boolean; remoteAllowed?: (appId: string) => boolean },
): DeviceCallAuth {
  const token = extractDeviceToken(req)
  if (!token) return { kind: "none" }
  const store = opts.store ?? getDeviceAccessStore()
  const checked = store.check(token)
  if ("error" in checked) {
    return { kind: "refused", status: 401, error: checked.error === "access_revoked" ? "access_revoked" : "unauthorized" }
  }
  const viaHeader = typeof req.headers.authorization === "string"
  const origin = req.headers.origin
  if (!viaHeader && typeof origin === "string" && origin.length > 0 && !opts.sameOrigin(req)) {
    return { kind: "refused", status: 403, error: "cross_origin" }
  }
  if (!grantAllowsApp(checked.device.grant, appId) || opts.remoteAllowed?.(appId) === false) {
    return { kind: "refused", status: 403, error: "grant_out_of_scope" }
  }
  return { kind: "ok", device: checked.device }
}

/** May this device read the daemon's session routes? (`GET /sessions/…`) */
export function deviceMaySessionRead(req: IncomingMessage, store: DeviceAccessStore = getDeviceAccessStore()): boolean {
  const token = extractDeviceToken(req)
  if (!token) return false
  const d = store.verify(token)
  return d !== undefined && d.grant.sessionsRead
}

/** Any valid device token (for the tunnel gate on the tool-call route; the grant is checked by the route). */
export function hasValidDeviceToken(req: IncomingMessage, store: DeviceAccessStore = getDeviceAccessStore()): boolean {
  const token = extractDeviceToken(req)
  return token !== undefined && store.verify(token) !== undefined
}

// ── the page a pairing link opens ─────────────────────────────────────────────

function renderPairingPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Connect a device</title>
<style>
  html,body{margin:0;background:#111114;color:#f2f2f5;font:16px -apple-system,Roboto,Helvetica,sans-serif}
  main{max-width:28rem;margin:0 auto;padding:2.5rem 1.25rem;display:flex;flex-direction:column;gap:1rem}
  h1{font-size:1.35rem;margin:0}p{margin:0;color:#a8a8b3;line-height:1.45}
  a.btn{display:block;text-align:center;padding:.95rem;border-radius:.6rem;background:#4f7cff;color:#fff;text-decoration:none;font-weight:600}
  code{display:block;padding:.8rem;border-radius:.6rem;background:#1b1b21;letter-spacing:.08em;word-break:break-all}
  .muted{font-size:.9rem}
</style></head><body><main>
<h1>Connect a device</h1>
<p id="msg">Opening the agentproto app...</p>
<a id="open" class="btn" href="#" hidden>Open in the agentproto app</a>
<div id="code" hidden><p class="muted">If the app does not open, install it, then paste this code in it:</p><code id="c"></code></div>
<p class="muted">This link works once and expires in a few minutes. You will be asked to confirm on the machine it comes from.</p>
</main>
<script>
(function(){
  var m=/[#&]o=([^&]+)/.exec(location.hash);
  var code=m?decodeURIComponent(m[1]):"";
  var msg=document.getElementById("msg");
  if(!code){msg.textContent="This link is incomplete. Ask for a new one.";return;}
  var host=location.origin, o=encodeURIComponent(code);
  var scheme="agentapp://pair?h="+encodeURIComponent(host)+"&o="+o;
  var intent="intent://pair?h="+encodeURIComponent(host)+"&o="+o+"#Intent;scheme=agentapp;package=${HUB_ANDROID_PACKAGE};end";
  var android=/android/i.test(navigator.userAgent);
  var a=document.getElementById("open"); a.hidden=false; a.href=android?intent:scheme;
  document.getElementById("c").textContent=code; document.getElementById("code").hidden=false;
  msg.textContent="Tap the button to continue in the app.";
  if(android){ try{ location.href=intent; }catch(e){} }
})();
</script></body></html>`
}
