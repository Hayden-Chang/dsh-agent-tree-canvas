/** Focused behavior checks against installed, unmodified DSH dependencies. */
import { defineConfig } from 'vitest/config'
import ts from 'typescript'

const execArgv = process.allowedNodeEnvironmentFlags.has('--webstorage') ? ['--no-webstorage'] : []
export default defineConfig({
  plugins: [{ name: 'standard-decorators', transform(code, id) {
    if (!id.endsWith('.ts') || !/^\s*@Remote/m.test(code)) return
    return ts.transpileModule(code, { fileName: id, compilerOptions: { target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.ESNext, sourceMap: true } }).outputText
  } }],
  test: {
    projects: [
      { extends: true, test: { name: 'host', execArgv, environment: 'node', include: ['packages/session-canvas/tests/host.spec.ts', 'packages/session-canvas/tests/remote.spec.ts'] } },
      { extends: true, test: { name: 'client', execArgv, environment: 'jsdom', environmentOptions: { jsdom: { url: 'http://localhost/' } },
        include: ['packages/session-canvas/tests/*.client.spec.ts'], setupFiles: ['./tests/client-setup.ts'] } },
    ],
    maxWorkers: 4,
  },
})
