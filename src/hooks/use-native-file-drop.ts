import { useEffect, useRef, useState, type RefObject } from "react"
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview"
import type { Event } from "@tauri-apps/api/event"

export function isNativeDropInside(
  position: { x: number; y: number },
  rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  scaleFactor: number,
): boolean {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return false
  const x = position.x / scaleFactor
  const y = position.y / scaleFactor
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

export function useNativeFileDrop<T extends HTMLElement>({
  target,
  enabled,
  onDrop,
}: {
  target: RefObject<T | null>
  enabled: boolean
  onDrop: (paths: string[]) => void
}): boolean {
  const [dragging, setDragging] = useState(false)
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop

  useEffect(() => {
    if (!enabled) {
      setDragging(false)
      return
    }

    let disposed = false
    let unlisten: (() => void) | undefined
    const handleEvent = (event: Event<DragDropEvent>) => {
      if (disposed) return
      const payload = event.payload
      if (payload.type === "leave") {
        setDragging(false)
        return
      }
      const element = target.current
      if (!element) {
        setDragging(false)
        return
      }
      const inside = isNativeDropInside(
        payload.position,
        element.getBoundingClientRect(),
        window.devicePixelRatio || 1,
      )
      if (payload.type === "enter" || payload.type === "over") {
        setDragging(inside)
        return
      }
      if (payload.type === "drop") {
        setDragging(false)
        if (inside && payload.paths.length > 0) onDropRef.current(payload.paths)
      }
    }

    getCurrentWebview().onDragDropEvent(handleEvent)
      .then((unregister) => {
        if (disposed) unregister()
        else unlisten = unregister
      })
      .catch(() => {
        if (!disposed) setDragging(false)
      })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [enabled, target])

  return dragging
}
