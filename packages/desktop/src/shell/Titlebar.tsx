// Titlebar — traffic lights, brand, daemon connection pill, today's cost pill,
// the kit switcher, New agent, and the account chip. Purely presentational; the
// connection + cost data is passed in from App.

import { KitSwitcher } from "./KitSwitcher"

export type ConnState = "connecting" | "online" | "offline"

interface TitlebarProps {
  daemonUrl: string
  conn: ConnState
  /** Sum of session costs today, already formatted (e.g. "$4.18"). */
  costToday: string
  onNewAgent: () => void
}

/** Strip the scheme so the pill reads "127.0.0.1:18790". */
function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "")
}

export function Titlebar({ daemonUrl, conn, costToday, onNewAgent }: TitlebarProps) {
  return (
    // data-tauri-drag-region makes the empty bar drag the window; the native
    // macOS traffic lights (titleBarStyle: Overlay) render at the padded-out
    // left edge, so there is exactly one titlebar.
    <div className="titlebar" data-tauri-drag-region>
      <div className="brand">
        <span className="glyph">◇</span>agentproto <span className="sub">— daemon cockpit</span>
      </div>
      <div className="toolbar">
        <span className="pill" title={conn}>
          <span className={`led led--${conn}`} />
          {hostOf(daemonUrl)}
        </span>
        <span className="pill">
          today <span className="cost">{costToday}</span>
        </span>
        <KitSwitcher />
        <button className="btn" onClick={onNewAgent}>
          <span style={{ fontSize: "15px", lineHeight: 1 }}>+</span> New agent
        </button>
        <div className="account" title="Jeremy · switch tenant in account">
          JA
        </div>
      </div>
    </div>
  )
}
