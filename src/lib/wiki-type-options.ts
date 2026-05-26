/**
 * Canonical list of wiki page `type` slugs a user can assign from the
 * editor's type selector (frontmatter-panel). Each `value` is the
 * English slug written to a page's frontmatter `type:` field — always
 * English even when the on-disk folder name is localized — and
 * `labelKey` is the i18n key the knowledge tree already uses to render
 * the group label, so the selector and the left tree stay in lockstep.
 *
 * Order mirrors the sidebar grouping in
 * `components/layout/knowledge-tree.tsx` (TYPE_CONFIG). When a type is
 * added/removed there, update this list too — the `wiki-type-options`
 * test asserts every option resolves to a translated label.
 *
 * `overview` is intentionally omitted: it's reserved for the auto-managed
 * `overview.md` page and shouldn't be hand-assigned to arbitrary pages.
 */
export interface WikiTypeOption {
  value: string
  labelKey: string
}

export const WIKI_TYPE_OPTIONS: WikiTypeOption[] = [
  // ── single-page everyday types ──
  { value: "travel-plan", labelKey: "knowledgeTree.types.travelPlan" },
  { value: "manual", labelKey: "knowledgeTree.types.manual" },
  { value: "project-doc", labelKey: "knowledgeTree.types.projectDoc" },
  { value: "tutorial", labelKey: "knowledgeTree.types.tutorial" },
  { value: "book", labelKey: "knowledgeTree.types.book" },
  { value: "recipe", labelKey: "knowledgeTree.types.recipe" },
  { value: "note", labelKey: "knowledgeTree.types.note" },
  { value: "report", labelKey: "knowledgeTree.types.report" },
  { value: "article", labelKey: "knowledgeTree.types.article" },
  { value: "meeting", labelKey: "knowledgeTree.types.meeting" },
  { value: "decision", labelKey: "knowledgeTree.types.decision" },
  { value: "project", labelKey: "knowledgeTree.types.project" },
  { value: "film-tv", labelKey: "knowledgeTree.types.filmTv" },
  { value: "music", labelKey: "knowledgeTree.types.music" },
  { value: "game", labelKey: "knowledgeTree.types.game" },
  { value: "menu", labelKey: "knowledgeTree.types.menu" },
  { value: "shopping-list", labelKey: "knowledgeTree.types.shoppingList" },
  { value: "fitness-plan", labelKey: "knowledgeTree.types.fitnessPlan" },
  { value: "contract", labelKey: "knowledgeTree.types.contract" },
  { value: "invoice", labelKey: "knowledgeTree.types.invoice" },
  { value: "medical-record", labelKey: "knowledgeTree.types.medicalRecord" },
  { value: "insurance", labelKey: "knowledgeTree.types.insurance" },
  { value: "code-snippet", labelKey: "knowledgeTree.types.codeSnippet" },
  { value: "api-doc", labelKey: "knowledgeTree.types.apiDoc" },
  { value: "error-log", labelKey: "knowledgeTree.types.errorLog" },
  // ── multi-page (decomposable) types ──
  { value: "paper", labelKey: "knowledgeTree.types.paper" },
  { value: "concept", labelKey: "knowledgeTree.types.concept" },
  { value: "tool", labelKey: "knowledgeTree.types.tool" },
  { value: "dataset", labelKey: "knowledgeTree.types.dataset" },
  { value: "person", labelKey: "knowledgeTree.types.person" },
  { value: "company", labelKey: "knowledgeTree.types.company" },
  { value: "regulation", labelKey: "knowledgeTree.types.regulation" },
  // ── meta + legacy types ──
  { value: "synthesis", labelKey: "knowledgeTree.types.synthesis" },
  { value: "comparison", labelKey: "knowledgeTree.types.comparison" },
  { value: "query", labelKey: "knowledgeTree.types.query" },
  { value: "source", labelKey: "knowledgeTree.types.source" },
  { value: "entity", labelKey: "knowledgeTree.types.entity" },
  // ── research types ──
  { value: "finding", labelKey: "knowledgeTree.types.finding" },
  { value: "thesis", labelKey: "knowledgeTree.types.thesis" },
  { value: "methodology", labelKey: "knowledgeTree.types.methodology" },
]
