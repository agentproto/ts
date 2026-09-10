import { describe, expect, it } from "vitest"

import type { InstalledAppInfo, InstalledAppUi } from "../client/types.js"
import {
  SESSION_CHAT_APP_ID,
  chatPanelUrl,
  chatUrl,
  installedSessionChatApp,
  resolveSessionOpen,
} from "./sessionView.logic.js"

const CHAT_APP: InstalledAppInfo = { appId: SESSION_CHAT_APP_ID, ui: { path: "ui" } }

function app(appId: string, ui?: InstalledAppUi): InstalledAppInfo {
  return { appId, ...(ui === undefined ? {} : { ui }) }
}

describe("installedSessionChatApp", () => {
  it("requires the appId AND a ui block", () => {
    expect(installedSessionChatApp([])).toBe(false)
    expect(installedSessionChatApp([app(SESSION_CHAT_APP_ID)])).toBe(false)
    expect(installedSessionChatApp([app("@agentik/other", { path: "ui" }), CHAT_APP])).toBe(true)
    expect(installedSessionChatApp([CHAT_APP])).toBe(true)
  })
})

describe("chatUrl", () => {
  it("builds the standalone app-host deep link", () => {
    expect(chatUrl("http://127.0.0.1:18790", "sess_abc")).toBe(
      "http://127.0.0.1:18790/apps/%40agentik%2Fsession-chat/ui?session=sess_abc",
    )
  })

  it("encodes the session id and tolerates a trailing slash on daemonUrl", () => {
    expect(chatUrl("http://127.0.0.1:18790/", "sess_a b")).toBe(
      "http://127.0.0.1:18790/apps/%40agentik%2Fsession-chat/ui?session=sess_a%20b",
    )
  })
})

describe("chatPanelUrl", () => {
  it("appends embed=1 to the chat deep link", () => {
    expect(chatPanelUrl("http://127.0.0.1:18790", "sess_abc")).toBe(
      "http://127.0.0.1:18790/apps/%40agentik%2Fsession-chat/ui?session=sess_abc&embed=1",
    )
  })
})

describe("resolveSessionOpen", () => {
  const daemonUrl = "http://127.0.0.1:18790"

  it("routes to chat when the setting is chat and the app is installed", () => {
    expect(resolveSessionOpen([CHAT_APP], "chat", daemonUrl, "sess_1")).toEqual({
      kind: "chat",
      url: chatUrl(daemonUrl, "sess_1"),
    })
  })

  it("falls back to builtin when the app is not installed (silent)", () => {
    expect(resolveSessionOpen([], "chat", daemonUrl, "sess_1")).toEqual({ kind: "builtin" })
    expect(
      resolveSessionOpen([app(SESSION_CHAT_APP_ID)], "chat", daemonUrl, "sess_1"),
    ).toEqual({ kind: "builtin" })
    expect(
      resolveSessionOpen([app("@agentik/other", { path: "ui" })], "chat", daemonUrl, "sess_1"),
    ).toEqual({ kind: "builtin" })
  })

  it("falls back to builtin when the setting is builtin", () => {
    expect(resolveSessionOpen([CHAT_APP], "builtin", daemonUrl, "sess_1")).toEqual({
      kind: "builtin",
    })
  })

  it("routes to chat-panel when the setting is chat-panel and the app is installed", () => {
    expect(resolveSessionOpen([CHAT_APP], "chat-panel", daemonUrl, "sess_1")).toEqual({
      kind: "chat-panel",
      url: chatPanelUrl(daemonUrl, "sess_1"),
    })
    expect(resolveSessionOpen([CHAT_APP], "chat-panel", daemonUrl, "sess_1").kind).toBe("chat-panel")
  })

  it("falls back to builtin when the setting is chat-panel and the app is missing", () => {
    expect(resolveSessionOpen([], "chat-panel", daemonUrl, "sess_1")).toEqual({ kind: "builtin" })
    expect(
      resolveSessionOpen([app(SESSION_CHAT_APP_ID)], "chat-panel", daemonUrl, "sess_1"),
    ).toEqual({ kind: "builtin" })
    expect(
      resolveSessionOpen([app("@agentik/other", { path: "ui" })], "chat-panel", daemonUrl, "sess_1"),
    ).toEqual({ kind: "builtin" })
  })
})