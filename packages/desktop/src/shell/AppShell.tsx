// AppShell — the window frame + the 3-pane body grid (rail / main / changes).
// Layout only; each slot's content is composed by App. Matches the mock's
// .window > (.titlebar, .body[286px 1fr 360px]) structure.

import type { ReactNode } from "react"

interface AppShellProps {
  titlebar: ReactNode
  rail: ReactNode
  main: ReactNode
  changes: ReactNode
}

export function AppShell({ titlebar, rail, main, changes }: AppShellProps) {
  return (
    <div className="window">
      {titlebar}
      <div className="body">
        {rail}
        <main className="main">{main}</main>
        <aside className="changes">{changes}</aside>
      </div>
    </div>
  )
}
