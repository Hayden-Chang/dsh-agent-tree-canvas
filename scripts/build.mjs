/**
 * Build the distributable plugin.
 *
 * The package owns the pipeline, because a git-hosted install builds from the
 * package directory alone. This entry point delegates so a root build and a
 * published build cannot drift.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

execFileSync(process.execPath, [join(import.meta.dirname, '../packages/agent-tree-canvas/scripts/build.mjs')], { stdio: 'inherit' })
