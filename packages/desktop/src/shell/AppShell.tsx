// AppShell — the window frame + the 3-pane body grid (rail / main / changes).
// Layout only; each slot's content is composed by App. Matches the mock's
// .window > (.titlebar, .body[286px 1fr 360px]) structure.

import { useEffect, useRef, type ReactNode } from "react"

import { useResizable } from "./useResizable"
import "./resizable.css"

interface AppShellProps {
  titlebar: ReactNode
  rail: ReactNode
  main: ReactNode
  changes: ReactNode
}

export function AppShell({ titlebar, rail, main, changes }: AppShellProps) {
  // Drag-to-resize the left rail. The handle sits on the rail's right edge, so
  // dragging it rightward widens the rail. The width feeds the `--rail-w` custom
  // property; the grid template (and its responsive breakpoints) lives entirely
  // in shell.css / .body, so the @media rules can still reclaim the layout as the
  // window narrows (an inline grid-template-columns would override them).
  const { width, onHandleMouseDown } = useResizable({
    initial: 286,
    min: 220,
    max: 460,
    side: "right",
  })

  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bodyRef.current?.style.setProperty("--rail-w", `${width}px`)
  }, [width])

  return (
    <div className="window">
      {titlebar}
      <div className="body" ref={bodyRef}>
        {rail}
        <div className="resize-handle" onMouseDown={onHandleMouseDown} />
        <main className="main">{main}</main>
        <aside className="changes">{changes}</aside>
      </div>
    </div>
  )
}
