/**
 * Dynamic MCP-app panels for installed `@agentproto/app-kit` apps that ship
 * a `ui` block (`defineApp({ ui: { html, title?, tools?, csp? } })`,
 * `app-tools.ts`'s `performInstall`). Bridges `AppRegistry` → `AgnoMcpApp[]`
 * so `registerMcpApps` (mcp-apps-adapter.ts) can mount them next to the
 * built-in panels (agentproto_sessions, agents_overview, ...).
 *
 * `mcpServerFactory` (index.ts) rebuilds a fresh McpServer per `/mcp`
 * request, so this module never throws — a bad app record must not take
 * down every other request. Failures (a collided tool id, an unreadable
 * `ui.path`) are skipped with a `console.warn`, not surfaced to the caller.
 */

import { readFile } from "node:fs/promises"
import { z } from "zod"
import type { AppRegistry } from "./app-registry.js"
import type { AgnoMcpApp } from "@agentproto/apps"

/** Derive the MCP tool id for an installed app's UI panel — strips the
 *  `@owner/` scope (if any) and maps every non `[a-z0-9]` character to `_`. */
export function appUiToolId(appId: string): string {
  const slug = appId.replace(/^@[^/]+\//, "").replace(/[^a-z0-9]/g, "_")
  return `app_ui_${slug}`
}

interface UiHtmlCache {
  get(path: string, version: string): Promise<string>
}

/**
 * The MCP Apps wire (spec `2026-01-26`) over `postMessage` JSON-RPC, exposed
 * as `window.McpApp.connect() -> Promise<{ callTool, sendMessage,
 * updateModelContext, openLink, onTeardown }>`. No host in this stack injects
 * an SDK global into the app iframe, so every UI panel that talks through
 * `window.McpApp` (all of them — see each app's `ui.ts` under
 * `packages/apps/src`) would otherwise throw `Cannot read properties of
 * undefined (reading 'connect')` at boot. Injected here, at serve time, so
 * every installed app's panel is covered without each app shipping its own
 * copy of the bridge.
 *
 * Bridge surface:
 * - `callTool(name, args)` — JSON-RPC `tools/call`
 * - `sendMessage(content)` — JSON-RPC `ui/message`
 * - `updateModelContext({content?, structuredContent?})` — JSON-RPC
 *   `ui/update-model-context`; each call replaces the previous context.
 * - `openLink(url)` — JSON-RPC `ui/open-link` {url}
 * - `onTeardown(cb)` — register a cleanup callback invoked on
 *   `ui/resource-teardown` from the host, at which point the bridge also
 *   replies `{result:{}}` automatically.
 */
const MCP_APP_BRIDGE_SCRIPT = `<script>
(function () {
  if (window.McpApp) return;
  var nextId = 1, pending = {}, teardownCbs = [];
  function post(m) { window.parent.postMessage(m, "*"); }
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (typeof m === "string") { try { m = JSON.parse(m); } catch (_) { return; } }
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.method === "ui/resource-teardown") {
      for (var i = 0; i < teardownCbs.length; i++) teardownCbs[i]();
      post({ jsonrpc: "2.0", id: m.id, result: {} });
      return;
    }
    if (m.id != null && pending[m.id]) { var cb = pending[m.id]; delete pending[m.id]; cb(m.result, m.error); }
  });
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = function (r, err) { if (err) reject(new Error((err && err.message) || String(err))); else resolve(r); };
      post({ jsonrpc: "2.0", id: id, method: method, params: params });
    });
  }
  window.McpApp = {
    connect: function () {
      if (window.parent === window) return Promise.reject(new Error("no host (standalone)"));
      return request("ui/initialize", {
        appInfo: { name: "agentproto-app", version: "1.0" },
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
        protocolVersion: "2026-01-26"
      }).then(function () {
        post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
        return {
          callTool: function (name, args) { return request("tools/call", { name: name, arguments: args || {} }); },
          sendMessage: function (p) {
            var params = typeof p === "string" ? { content: p } : (p || {});
            var content = typeof params.content === "string" ? [{ type: "text", text: params.content }] : (params.content || []);
            return request("ui/message", { role: "user", content: content });
          },
          updateModelContext: function (p) { return request("ui/update-model-context", p || {}); },
          openLink: function (url) { return request("ui/open-link", { url: url }); },
          onTeardown: function (cb) { teardownCbs.push(cb); }
        };
      });
    }
  };
})();
</script>
`

/** Insert `script` right after the earliest structural opening tag the
 *  document has (`<head>`, else `<body>`, else `<html>`, else prepend), so
 *  the injected bridge is defined before any app script runs. */
function injectAfterStructuralTag(html: string, script: string): string {
  for (const tag of ["head", "body", "html"]) {
    const match = html.match(new RegExp(`<${tag}[^>]*>`, "i"))
    if (match?.index !== undefined) {
      const insertAt = match.index + match[0].length
      return html.slice(0, insertAt) + script + html.slice(insertAt)
    }
  }
  return script + html
}

/** Inject `MCP_APP_BRIDGE_SCRIPT` (see `injectAfterStructuralTag` for the
 *  placement rule). Idempotent: a no-op if the document already DEFINES
 *  `window.McpApp` (e.g. an app that inlines its own shim, or html already
 *  injected by an earlier pass through this same cache). The guard matches
 *  an assignment only — every app panel CONSUMES `window.McpApp.connect()`,
 *  so matching any mention would skip injection for exactly the documents
 *  that need it, leaving `window.McpApp` undefined in the host iframe. */
export function injectMcpAppBridge(html: string): string {
  if (/window\.McpApp\s*=/.test(html)) return html
  return injectAfterStructuralTag(html, MCP_APP_BRIDGE_SCRIPT)
}

/**
 * The standalone-browser-tab twin of `MCP_APP_BRIDGE_SCRIPT` — same
 * `window.McpApp.connect() -> Promise<{ callTool, sendMessage,
 * updateModelContext, openLink, onTeardown }>` surface, but `callTool` POSTs
 * to the sibling `./tool-call` route (http-server.ts's `POST
 * /apps/:appId/tool-call`) instead of JSON-RPC over `postMessage`, so
 * `GET /apps/:appId/ui` renders a working app with no host iframe at all.
 * `callTool` resolves with the route's body — the same MCP result envelope a
 * postMessage host's `tools/call` reply carries — so an app's unwrapping code
 * (see media-viewer's `unwrapText`) behaves identically in both modes. There
 * is no chat host to receive `ui/message`, so `sendMessage` rejects; there is
 * no context host either, so `updateModelContext` rejects; `openLink` opens a
 * new tab via `window.open`; `onTeardown` is a no-op.
 *
 * Injected INSTEAD OF (not on top of) the postMessage bridge: that bridge's
 * `connect()` rejects when `window.parent === window`, which is exactly the
 * standalone case this one exists for.
 */
const STANDALONE_REST_BRIDGE_SCRIPT = `<script>
(function () {
  if (window.McpApp) return;
  window.McpApp = {
    connect: function () {
      return Promise.resolve({
        callTool: function (name, args) {
          return fetch("./tool-call", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tool: name, args: args || {} })
          }).then(function (res) {
            return res.json().catch(function () {
              throw new Error("tool-call failed: HTTP " + res.status);
            }).then(function (body) {
              if (!res.ok) throw new Error((body && body.error) || ("tool-call failed: HTTP " + res.status));
              return body;
            });
          });
        },
        sendMessage: function () {
          return Promise.reject(new Error("sendMessage: no chat host (standalone mode)"));
        },
        updateModelContext: function () {
          return Promise.reject(new Error("updateModelContext: no host (standalone mode)"));
        },
        openLink: function (url) {
          window.open(url, "_blank");
          return Promise.resolve({});
        },
        onTeardown: function () {}
      });
    }
  };
})();
</script>
`

/** Inject the standalone REST bridge (placement rule shared with
 *  `injectMcpAppBridge`). Meant for raw `ui.path` html — the script guards
 *  on an existing `window.McpApp` at runtime, so an app shipping its own
 *  shim keeps it. */
export function injectStandaloneAppBridge(html: string): string {
  return injectAfterStructuralTag(html, STANDALONE_REST_BRIDGE_SCRIPT)
}

/** Per-path HTML cache keyed by `(path, version)` — a request rebuilds the
 *  McpServer every time, but re-reading an installed app's `ui.path` off
 *  disk on every `/mcp` call would be wasteful when nothing changed. The
 *  cache lives at gateway scope (created once in index.ts, outside
 *  `mcpServerFactory`) so it actually persists across requests; `version`
 *  (the app's `updatedAt`) invalidates a stale entry after a re-install.
 *  The cached value is post-bridge-injection, so injection only runs once
 *  per (path, version) rather than on every served request. */
export function createUiHtmlCache(): UiHtmlCache {
  const cache = new Map<string, { version: string; html: string }>()
  return {
    async get(path, version) {
      const cached = cache.get(path)
      if (cached && cached.version === version) return cached.html
      const raw = await readFile(path, "utf8")
      const html = injectMcpAppBridge(raw)
      cache.set(path, { version, html })
      return html
    },
  }
}

/**
 * Build one `AgnoMcpApp` per installed app that has a `ui` block, skipping
 * (with a `console.warn`) any whose derived tool id collides with
 * `existingToolNames` (built-in panels) or an earlier installed app in this
 * same pass, and any whose `ui.path` can't be read.
 */
export async function makeInstalledAppUiApps(
  appRegistry: AppRegistry,
  cache: UiHtmlCache,
  existingToolNames: Set<string>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<AgnoMcpApp<any, any>[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apps: AgnoMcpApp<any, any>[] = []
  const seen = new Set<string>(existingToolNames)

  for (const app of appRegistry.listApps()) {
    const ui = app.ui
    if (!ui) continue

    const toolId = appUiToolId(app.appId)
    if (seen.has(toolId)) {
      console.warn(
        `[app-ui-apps] skipping UI panel for app "${app.appId}": tool id "${toolId}" ` +
          "collides with an existing tool or another installed app's panel.",
      )
      continue
    }

    let html: string
    try {
      html = await cache.get(ui.path, app.updatedAt)
    } catch (err) {
      console.warn(
        `[app-ui-apps] skipping UI panel for app "${app.appId}": could not read "${ui.path}": ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }

    seen.add(toolId)
    apps.push({
      id: toolId,
      title: ui.title ?? app.name ?? app.appId,
      ...(ui.description ? { description: ui.description } : {}),
      inputSchema: z.object({}),
      execute: async () => ({ appId: app.appId, tools: ui.tools ?? [] }),
      html,
      ...(ui.csp
        ? {
            csp: {
              ...(ui.csp.connectDomains ? { connectDomains: [...ui.csp.connectDomains] } : {}),
              ...(ui.csp.resourceDomains ? { resourceDomains: [...ui.csp.resourceDomains] } : {}),
            },
          }
        : {}),
    })
  }

  return apps
}
