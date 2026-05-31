import type { LintScenario } from "./types"

// NOTE: Structural lint only counts inbound wikilinks from OTHER content
// pages (index.md and log.md are excluded from the slug map). So to avoid
// an "orphan" finding on a page, at least one non-index content page must
// [[link]] to it. Scenario wikis here are built with that in mind.

function page(title: string, body: string): string {
  return `---\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`
}

export const lintScenarios: LintScenario[] = [
  // 1. clean-wiki — fully interlinked, no findings
  {
    name: "structural/clean-wiki",
    description:
      "Two content pages cross-link each other. No orphans, no broken " +
      "links, no no-outlinks. Structural lint returns an empty result.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[attention]]\n- [[transformer]]\n",
      "wiki/attention.md": page(
        "Attention",
        "See the [[transformer]] architecture for how this is applied.",
      ),
      "wiki/transformer.md": page(
        "Transformer",
        "Transformers are built on the [[attention]] mechanism.",
      ),
    },
    expected: {
      structural: [],
    },
  },

  // 2. orphan-page — no inbound wikilinks
  {
    name: "structural/orphan-page",
    description:
      "orphan.md links out to attention.md but no content page links BACK " +
      "to orphan.md. Structural lint should flag it as orphan, nothing else.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[attention]]\n- [[transformer]]\n",
      "wiki/attention.md": page("Attention", "Related: [[transformer]]."),
      "wiki/transformer.md": page("Transformer", "Built on [[attention]]."),
      "wiki/orphan.md": page(
        "Orphan",
        "This page links to [[attention]] but nobody links back here.",
      ),
    },
    expected: {
      structural: [{ type: "orphan", page: "orphan.md" }],
    },
  },

  // 3. broken-link — wikilink to a page that doesn't exist
  {
    name: "structural/broken-link",
    description:
      "attention.md contains a wikilink to [[nonexistent-page]] which has " +
      "no corresponding file. Structural lint must flag the broken link " +
      "and name it in the detail.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[attention]]\n- [[transformer]]\n",
      "wiki/attention.md": page(
        "Attention",
        "Related to [[transformer]] and also to [[nonexistent-page]].",
      ),
      "wiki/transformer.md": page("Transformer", "Built on [[attention]]."),
    },
    expected: {
      structural: [
        {
          type: "broken-link",
          page: "attention.md",
          linkName: "nonexistent-page",
        },
      ],
    },
  },

  // 3b. broken-link DEDUP — same missing target referenced from
  //     multiple source pages collapses into ONE lint row with
  //     affectedPages populated. Without this, every reference
  //     produces a separate row, flooding the Lint view (a popular
  //     missing target like a wiki concept can appear 5–10 times).
  {
    name: "structural/broken-link-dedup",
    description:
      "[[missing-target]] is referenced from three different pages. The " +
      "structural lint should emit exactly ONE broken-link row whose " +
      "affectedPages list names all three.",
    initialWiki: {
      "wiki/index.md":
        "# Index\n\n- [[page-a]]\n- [[page-b]]\n- [[page-c]]\n",
      // Cross-link page-a / page-b / page-c so they're NOT orphans —
      // the lint that's being tested here is the broken-link dedup,
      // not the orphan flag. Each page also references the missing
      // target with its OWN wording (same target, three references).
      "wiki/page-a.md": page(
        "Page A",
        "Page A talks about [[missing-target]]. See also [[page-b]].",
      ),
      "wiki/page-b.md": page(
        "Page B",
        "Page B also mentions [[missing-target]] for the same reason. " +
          "Cross-ref: [[page-a]], [[page-c]].",
      ),
      "wiki/page-c.md": page(
        "Page C",
        "And [[missing-target]] comes up again here, in Page C. " +
          "Related: [[page-b]].",
      ),
    },
    expected: {
      structural: [
        {
          type: "broken-link",
          // page = first affected (sorted alphabetically), the lint UI
          // uses this as the row anchor.
          page: "page-a.md",
          linkName: "missing-target",
          affectedPages: ["page-a.md", "page-b.md", "page-c.md"],
        },
      ],
    },
  },

  // 3c. lint exclusion: raw-source paths (sources/, queries/) are
  //     skipped by default. A page directly under wiki/sources/ has
  //     a broken link AND no inbound link — without the exclusion it
  //     would produce orphan + no-outlinks + broken-link. With the
  //     default LintConfig it produces NONE.
  {
    name: "structural/ignore-raw-sources",
    description:
      "sources/raw-import.md has [[non-existent]] and no other linking page. " +
      "Default lint config skips sources/ so the page produces zero findings.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n",
      "wiki/sources/raw-import.md": page(
        "Raw import",
        "Some imported content referencing [[non-existent]] and nothing else.",
      ),
    },
    expected: {
      structural: [],
    },
  },

  // 3d. structural pages (overview / purpose / schema) are filtered
  //     from orphan + no-outlinks + broken-link checks — they're
  //     entry points / framing docs, not knowledge nodes. BUT they
  //     remain valid wikilink targets, so a knowledge page that
  //     references [[overview]] doesn't get a broken-link warning.
  //
  //     A real user lost their overview.md page when bulk-delete
  //     acted on a stale "orphan: overview.md" lint warning. This
  //     scenario pins the fix.
  {
    name: "structural/skip-overview-as-orphan",
    description:
      "overview.md exists at wiki root with no inbound links. Lint must " +
      "NOT flag it as orphan / no-outlinks. A knowledge page also " +
      "wikilinks to [[overview]] — that resolves cleanly, no broken-link.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[note]]\n- [[concept]]\n",
      "wiki/overview.md": "---\ntype: overview\ntitle: Project Overview\n---\n\nNo other page links here, but that's intentional.\n",
      // note + concept cross-link each other so neither is orphan;
      // both reference [[overview]] to test the resolution path.
      "wiki/note.md": page(
        "A note",
        "See the [[overview]] for framing context. Related: [[concept]].",
      ),
      "wiki/concept.md": page(
        "A concept",
        "Background in the [[overview]]; cross-ref [[note]].",
      ),
    },
    expected: {
      // Without the structural skip: overview.md gets orphan +
      // no-outlinks. With the fix: zero findings — overview is a
      // recognised entry point and its lack of inbound/outbound
      // links is by design.
      structural: [],
    },
  },

  // 4. no-outlinks — a page has zero [[wikilinks]]
  {
    name: "structural/no-outlinks",
    description:
      "leaf.md is linked-to by transformer.md but has no outgoing links " +
      "of its own. Lint should flag 'no-outlinks' on leaf.md.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[attention]]\n- [[transformer]]\n- [[leaf]]\n",
      "wiki/attention.md": page("Attention", "Related: [[transformer]]."),
      "wiki/transformer.md": page(
        "Transformer",
        "Uses [[attention]] and references [[leaf]] as a concept.",
      ),
      "wiki/leaf.md": page(
        "Leaf",
        "This page describes a leaf concept and makes no external references.",
      ),
    },
    expected: {
      // Only the no-outlinks finding — transformer still outlinks, attention
      // still outlinks, leaf has inbound from transformer.
      structural: [{ type: "no-outlinks", page: "leaf.md" }],
    },
  },

  // 5. semantic-contradiction (LLM-backed)
  {
    name: "semantic/contradiction-found",
    description:
      "Two cross-linked pages make conflicting claims. Structural lint " +
      "sees no issues, but the mocked semantic LLM response emits a LINT " +
      "block that the parser extracts into a contradiction finding.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[attention]]\n- [[transformer]]\n",
      "wiki/attention.md": page(
        "Attention",
        "Attention ALWAYS uses the softmax function. See [[transformer]].",
      ),
      "wiki/transformer.md": page(
        "Transformer",
        "The transformer's [[attention]] layer uses a linear kernel, not softmax.",
      ),
    },
    llmResponse: [
      "Reviewing the pages I found one contradiction:",
      "",
      "---LINT: contradiction | warning | Attention function differs between pages---",
      "attention.md claims softmax is always used, but transformer.md describes a",
      "linear attention kernel. One page needs correction.",
      "PAGES: attention.md, transformer.md",
      "---END LINT---",
    ].join("\n"),
    expected: {
      structural: [],
      semantic: [
        {
          // Parser collapses all semantic findings to type="semantic";
          // the original LLM-declared type ("contradiction") lives in detail.
          type: "semantic",
          severity: "warning",
          titleContains: "Attention function differs",
        },
      ],
    },
  },
]
