/**
 * Generate the plugin index that lets DSH list this plugin in Plugins > Discover.
 *
 * The index pins one git commit, so run it after the release commit exists and
 * commit the result on top:
 *
 *   pnpm run market:index -- --commit "$(git rev-parse HEAD)"
 *
 * DSH installs a listed version from that commit, so the commit must contain
 * this package with its `prepare` build and a compatible `engines.dsh`.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(join(import.meta.dirname, '..'))
const directory = join(root, 'packages/agent-tree-canvas')
const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))

const argument = name => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}
const commit = argument('commit') ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`--commit must be a full 40-character commit, received ${commit}`)

const repository = manifest.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '')
if (!repository) throw new Error('package.json must declare repository.url')
const published = argument('timestamp') ?? Math.floor(Date.now() / 1000)

const locale = async name => {
  try {
    return JSON.parse(await readFile(join(directory, 'locale', `${name}.json`), 'utf8')).meta ?? {}
  } catch {
    return {}
  }
}
const en = await locale('en')
const zh = await locale('zh')
const text = (primary, fallback) => (zh[primary] ? { en: en[primary] ?? fallback, zh: zh[primary] } : en[primary] ?? fallback)

const index = {
  format: 1,
  title: { en: 'Agent tree canvas', zh: '会话画布' },
  plugins: [
    {
      name: manifest.name,
      title: text('title', manifest.name),
      description: text('description', manifest.description),
      author: 'Hayden-Chang',
      homepage: manifest.homepage,
      repository: { url: repository, directory: manifest.repository.directory },
      versions: [
        {
          version: manifest.version,
          publishTimestamp: Number(published),
          source: { type: 'git', url: repository, commit, path: manifest.repository.directory },
          engines: { dsh: manifest.engines.dsh },
        },
      ],
    },
  ],
}

const output = join(root, 'market/index.json')
await mkdir(join(root, 'market'), { recursive: true })
await writeFile(output, `${JSON.stringify(index, null, 2)}\n`)
console.log(`Wrote ${output} for ${manifest.name}@${manifest.version} at ${commit}`)
