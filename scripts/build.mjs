/** Build the distributable plugin against published DSH packages, without a DSH checkout. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { transform } from 'lightningcss'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = join(root, 'packages/agent-tree-canvas')
const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
const tsc = join(root, 'node_modules/typescript/bin/tsc')
const compile = face => execFileSync(process.execPath, [tsc, '-b', `tsconfig.${face}.json`], { cwd: root, stdio: 'inherit' })
await mkdir(join(directory, 'lib'), { recursive: true })
compile('host')
await build({ absWorkingDir: directory, entryPoints: { index: 'lib/types/index.js', remote: 'lib/types/remote.js', 'typert.host': 'lib/types/reflection.js' }, outdir: 'lib',
  bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', sourcemap: false })
compile('client')
const platform = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', 'zod',
  '@tanstack/react-virtual', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit']
const result = await build({ absWorkingDir: directory, entryPoints: ['src/client/index.ts'], bundle: true,
  platform: 'browser', target: 'es2022', format: 'cjs', write: false, external: platform,
  define: { 'process.env.NODE_ENV': '"production"' }, jsx: 'automatic',
  plugins: [{ name: 'plugin-owned-css', setup(builder) {
    builder.onLoad({ filter: /\.module\.css$/ }, async ({ path }) => {
      const css = transform({ filename: path, code: await readFile(path), cssModules: { pattern: 'canvas_[local]_[hash]' } })
      const names = Object.fromEntries(Object.entries(css.exports ?? {}).map(([key, value]) => [key, value.name]))
      return { loader: 'js', contents: `const style = document.createElement('style'); style.textContent = ${JSON.stringify(css.code.toString())}; document.head.append(style); export default ${JSON.stringify(names)};` }
    })
  } }],
})
const code = result.outputFiles[0].text
const client = `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;\n${code}\nreturn module.exports;\n} });\n`
await writeFile(join(directory, 'lib/client.js'), client)
console.log(`Built ${manifest.name}: Host, Remote, Client and declarations`)
