import {
  Group,
  Panel,
  Separator,
  type GroupProps,
  type PanelProps,
  type SeparatorProps,
} from "react-resizable-panels"

import { cn } from "@/lib/utils"

function ResizablePanelGroup({
  className,
  direction,
  ...props
}: GroupProps & { direction?: "horizontal" | "vertical" }) {
  return (
    <Group
      data-slot="resizable-panel-group"
      orientation={direction ?? "horizontal"}
      className={cn("flex h-full w-full", className)}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: PanelProps) {
  return <Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: SeparatorProps & {
  withHandle?: boolean
}) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        "relative flex w-1.5 shrink-0 cursor-col-resize items-center justify-center bg-border/40 transition-colors outline-none hover:bg-primary/30 focus-visible:ring-2 focus-visible:ring-ring/50 data-[separator=active]:bg-primary/40 aria-[orientation=horizontal]:h-1.5 aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:cursor-row-resize [&[aria-orientation=horizontal]>div]:h-1.5 [&[aria-orientation=horizontal]>div]:w-8",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-8 w-1.5 shrink-0 rounded-full bg-border" />
      )}
    </Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
