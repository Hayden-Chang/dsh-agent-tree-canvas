/** Run the preserved browser scenario with the stock DSH test carrier. */
import { resolve } from 'node:path'
import tsconfigPaths from 'vite-tsconfig-paths'
import ts from 'typescript'
import { defineConfig } from 'vitest/config'

const stock = process.env.DSH_STOCK_ROOT
if (stock === undefined) throw new Error('Set DSH_STOCK_ROOT to an unmodified, built DSH 0.2.2-rc.1 checkout')
const execArgv = process.allowedNodeEnvironmentFlags.has('--webstorage') ? ['--no-webstorage'] : []
export default defineConfig({
  plugins: [tsconfigPaths({ projects: [resolve(stock, 'tsconfig.base.json')] }), { name: 'standard-decorators', enforce: 'pre', transform(code, id) {
    if (!/\.[cm]?tsx?$/.test(id) || !/^\s*@[A-Za-z_$]/m.test(code)) return
    return ts.transpileModule(code, { fileName: id, compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } }).outputText
  } }],
  resolve: { alias: { '@stock/scaffold': resolve(stock, 'apps/web/tests/scaffold.ts'),
    '@stock/support': resolve(stock, 'apps/web/tests/support.ts'), '@stock/llm': resolve(stock, 'packages/llm/llm/src/index.ts') } },
  test: { execArgv, include: [process.env.CANVAS_REAL_MODEL === '1' ? 'tests/mindmap-quality.e2e.ts' : 'tests/session-canvas.e2e.ts'], testTimeout: 180_000, hookTimeout: 120_000, fileParallelism: false },
})
