#!/usr/bin/env node
/**
 * Generate GitHub release notes from src/lib/changelog.ts.
 *
 * Used by CI after a tag build publishes: `gh release edit <tag>
 * --notes-file notes.md` so the in-app update banner (which previews
 * the GitHub release body for versions the bundled CHANGELOG can't
 * describe yet) shows real highlights instead of the static
 * "See the assets below" boilerplate.
 *
 * Regex-parses the TS source — no TypeScript toolchain on the CI
 * runner. Prints `vX.Y.Z · date` + the Chinese bullets (fork's primary
 * audience; English fallback when an entry lacks zh) and exits 1 when
 * the tag has no changelog entry: changelog.test.ts already guards
 * CHANGELOG[0].version === package.json.version, so a miss means the
 * release process skipped its changelog step.
 *
 * Usage: node scripts/release-notes.mjs v0.9.1 > notes.md
 */
import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const tag = (process.argv[2] || "").trim()
const bare = tag.replace(/^v/i, "")
if (!bare) {
  console.error("usage: release-notes.mjs <tag>   (e.g. v0.9.1)")
  process.exit(2)
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = readFileSync(resolve(repoRoot, "src/lib/changelog.ts"), "utf8")

function extractStrings(arrayText) {
  const out = []
  const re = /"((?:[^"\\]|\\.)*)"/g
  let m
  while ((m = re.exec(arrayText))) {
    out.push(m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"))
  }
  return out
}

// Isolate the entry block for `bare`: from its `version: "x"` up to the
// next entry's `version: "` (or end of file).
const entryRe = new RegExp(`version:\\s*"${bare.replace(/\./g, "\\.")}"`)
const entryStart = source.search(entryRe)
if (entryStart < 0) {
  console.error(`no changelog entry for ${tag} in src/lib/changelog.ts`)
  console.error("add the release entry before cutting the release (see docs/release-and-update.md step 2)")
  process.exit(1)
}
const nextEntry = source.indexOf('version: "', entryStart + 1)
const block = source.slice(entryStart, nextEntry < 0 ? undefined : nextEntry)

const date = block.match(/date:\s*"([^"]+)"/)?.[1] ?? ""
const highlights = block.slice(block.indexOf("highlights:"))
const zhMatch = highlights.match(/zh:\s*\[([\s\S]*?)\]/)
const enMatch = highlights.match(/en:\s*\[([\s\S]*?)\]/)
const bullets = zhMatch
  ? extractStrings(zhMatch[1])
  : enMatch
    ? extractStrings(enMatch[1])
    : []

if (bullets.length === 0) {
  console.error(`changelog entry for ${tag} has no en/zh highlight bullets`)
  process.exit(1)
}

const header = `v${bare}${date ? ` · ${date}` : ""}`
console.log(`${header}\n\n${bullets.map((b) => `- ${b}`).join("\n")}`)
