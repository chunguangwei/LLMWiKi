const CONTEXT_PRESETS = [
  { value: 4096, label: "4K" },
  { value: 8192, label: "8K" },
  { value: 16384, label: "16K" },
  { value: 32768, label: "32K" },
  { value: 65536, label: "64K" },
  { value: 131072, label: "128K" },
  { value: 204800, label: "200K" },
  { value: 262144, label: "256K" },
  { value: 524288, label: "512K" },
  { value: 1000000, label: "1M" },
]

function formatSize(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M tokens`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K tokens`
  return `${tokens} tokens`
}

export function ContextSizeSelector({
  value,
  onChange,
}: {
  value: number
  onChange: (v: number) => void
}) {
  const closestIndex = CONTEXT_PRESETS.reduce((best, preset, i) => {
    return Math.abs(preset.value - value) < Math.abs(CONTEXT_PRESETS[best].value - value)
      ? i
      : best
  }, 0)
  const pct = (closestIndex / (CONTEXT_PRESETS.length - 1)) * 100

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium">{formatSize(value)}</span>
        <span className="text-xs text-muted-foreground">
          ~{Math.floor((value * 0.6) / 1000)}K tokens for wiki content
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={CONTEXT_PRESETS.length - 1}
        step={1}
        value={closestIndex}
        onChange={(e) => onChange(CONTEXT_PRESETS[parseInt(e.target.value)].value)}
        className="w-full h-2 rounded-lg appearance-none cursor-pointer accent-primary"
        style={{
          background: `linear-gradient(to right, #4f46e5 ${pct}%, #e5e7eb ${pct}%)`,
        }}
      />
      <div className="flex justify-between mt-1">
        {CONTEXT_PRESETS.map((preset, i) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => onChange(preset.value)}
            className={`text-[9px] px-0.5 ${
              i === closestIndex ? "text-primary font-bold" : "text-muted-foreground/50"
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  )
}
