/** Focused browser regression against an installed, unmodified DSH runtime. */
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['tests/quote-follow.browser.spec.ts'], testTimeout: 120_000, hookTimeout: 30_000, fileParallelism: false } })
