import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { openUrl } from "@tauri-apps/plugin-opener"
import zhManual from "@/content/user-manual.zh.md?raw"
import enManual from "@/content/user-manual.en.md?raw"

export function UserManualSection() {
  const { t, i18n } = useTranslation()
  const lang: "en" | "zh" = i18n.language?.startsWith("zh") ? "zh" : "en"

  // Strip the H1 — the section already has its own title row, so
  // rendering the markdown H1 too would just look like a duplicate.
  const body = useMemo(() => {
    const src = lang === "zh" ? zhManual : enManual
    return src.replace(/^#\s.*\n+/, "")
  }, [lang])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.userManual.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.userManual.description")}
        </p>
      </div>

      <article className="text-sm leading-relaxed text-foreground/90">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ children }) => (
              <h1 className="mt-8 mb-3 text-lg font-semibold text-foreground">{children}</h1>
            ),
            h2: ({ children }) => (
              <h2 className="mt-7 mb-3 border-b border-border/60 pb-1 text-base font-semibold text-foreground">
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 className="mt-5 mb-2 text-sm font-semibold text-foreground">{children}</h3>
            ),
            h4: ({ children }) => (
              <h4 className="mt-4 mb-1.5 text-sm font-medium text-foreground/90">{children}</h4>
            ),
            p: ({ children }) => <p className="my-2">{children}</p>,
            ul: ({ children }) => (
              <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>
            ),
            ol: ({ children }) => (
              <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>
            ),
            li: ({ children }) => <li className="leading-relaxed">{children}</li>,
            hr: () => <hr className="my-6 border-border/60" />,
            blockquote: ({ children }) => (
              <blockquote className="my-3 border-l-2 border-primary/40 bg-muted/30 px-3 py-2 text-foreground/80">
                {children}
              </blockquote>
            ),
            a: ({ href, children }) => {
              // Only external links (http/https) are clickable — the
              // manual references sibling docs like `features.md` with
              // relative paths that resolve to nothing inside the app.
              // Render those as plain emphasized text so the citation
              // still reads naturally without looking like a dead link.
              if (href && /^https?:\/\//i.test(href)) {
                return (
                  <a
                    href={href}
                    className="text-primary underline underline-offset-2 hover:text-primary/80"
                    onClick={(e) => {
                      e.preventDefault()
                      void openUrl(href).catch((err) => {
                        console.error("[user-manual] openUrl failed:", err)
                      })
                    }}
                  >
                    {children}
                  </a>
                )
              }
              return (
                <span className="font-medium text-foreground/80" title={href}>
                  {children}
                </span>
              )
            },
            table: ({ children }) => (
              <div className="my-3 overflow-x-auto rounded border border-border">
                <table className="w-full border-collapse text-xs">{children}</table>
              </div>
            ),
            thead: ({ children }) => <thead className="bg-muted">{children}</thead>,
            th: ({ children }) => (
              <th className="border border-border/80 px-3 py-1.5 text-start font-semibold">
                {children}
              </th>
            ),
            td: ({ children }) => (
              <td className="border border-border/60 px-3 py-1.5 align-top">{children}</td>
            ),
            code: ({ className, children }) => {
              const isBlock = className?.startsWith("language-")
              if (isBlock) {
                return <code className={className}>{children}</code>
              }
              return (
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
                  {children}
                </code>
              )
            },
            pre: ({ children }) => (
              <pre className="my-3 overflow-x-auto rounded border border-border/60 bg-muted/30 p-3 text-xs leading-relaxed">
                {children}
              </pre>
            ),
            strong: ({ children }) => (
              <strong className="font-semibold text-foreground">{children}</strong>
            ),
          }}
        >
          {body}
        </ReactMarkdown>
      </article>
    </div>
  )
}
