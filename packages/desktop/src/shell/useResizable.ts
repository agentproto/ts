// useResizable — a self-contained drag-to-resize hook for a column gutter.
// The returned onHandleMouseDown arms window-level mousemove/mouseup listeners
// for the duration of a single drag; width is clamped to [min, max] and the
// sign of the drag delta is chosen by which edge the handle sits on. No
// external deps, no `any`.

import { useCallback, useEffect, useRef, useState } from "react"
import type { MouseEventHandler } from "react"

interface UseResizableOptions {
  initial: number
  min: number
  max: number
  // Which side of the resized column the handle lives on: dragging a "right"
  // handle rightwards grows the column, a "left" handle shrinks it.
  side: "left" | "right"
}

interface UseResizableResult {
  width: number
  onHandleMouseDown: MouseEventHandler
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function useResizable({
  initial,
  min,
  max,
  side,
}: UseResizableOptions): UseResizableResult {
  const [width, setWidth] = useState(() => clamp(initial, min, max))

  // Latest width, mirrored into a ref so a drag reads the current value at
  // mousedown without re-creating the callback on every resize frame.
  const widthRef = useRef(width)
  widthRef.current = width

  // Teardown for an in-flight drag, so an unmount mid-drag can't leak listeners.
  const teardownRef = useRef<(() => void) | null>(null)

  const onHandleMouseDown = useCallback<MouseEventHandler>(
    (event) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = widthRef.current
      const sign = side === "left" ? -1 : 1

      const onMove = (moveEvent: MouseEvent) => {
        const delta = (moveEvent.clientX - startX) * sign
        setWidth(clamp(startWidth + delta, min, max))
      }
      const onUp = () => {
        window.removeEventListener("mousemove", onMove)
        window.removeEventListener("mouseup", onUp)
        teardownRef.current = null
      }

      window.addEventListener("mousemove", onMove)
      window.addEventListener("mouseup", onUp)
      teardownRef.current = onUp
    },
    [min, max, side],
  )

  useEffect(() => () => teardownRef.current?.(), [])

  return { width, onHandleMouseDown }
}
