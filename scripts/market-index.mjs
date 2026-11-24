/**
 * Generate the plugin index that lets dsh list this plugin in Plugins > Discover.
 *
 * The index pins one git commit, so run it after the release commit exists:
 *
 *   pnpm run market:index -- --commit "$(git rev-parse HEAD)"
 *
 * Everything written into the index is read from that commit, not from the
 * working tree, so the index cannot advertise a version, an `engines.dsh` or a
 * description the pinned code does not have.
 *
 * `--check` regenerates in memory and fails when the committed index differs,
 * which is what keeps the file honest after a release.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(join(import.meta.dirname, '..'))
const packagePath = 'packages/agent-tree-canvas'
const indexPath = 'market/index.json'
const defaultUrl = 'https://raw.githubusercontent.com/Hayden-Chang/dsh-agent-tree-canvas/main/market/index.json'

const usage = `Usage: pnpm run market:index -- [options]

  --commit <sha>        Commit to publish (default: HEAD); must exist.
  --timestamp <seconds> Publish time (default: the commit's committer time).
  --url <url>           Address the index will be served from.
  --author <text>       Author shown in Discover (default: Hayden-Chang).
  --title <text>        Index name shown in Discover (default: Agent tree canvas).
  --check               Fail when ${indexPath} differs from the generated index.`

const known = new Set(['commit', 'timestamp', 'url', 'author', 'title', 'check', 'help'])
const options = {}
const arguments_ = process.argv.slice(2).filter(argument => argument !== '--')
for (let index = 0; index < arguments_.length; index += 1) {
  const argument = arguments_[index]
  if (!argument.startsWith('--')) throw new Error(`Unexpected argument ${argument}\n\n${usage}`)
  const equals = argument.indexOf('=')
  const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals)
  if (!known.has(name)) throw new Error(`Unknown option --${name}\n\n${usage}`)
  if (name === 'check' || name === 'help') {
    if (equals !== -1) throw new Error(`--${name} takes no value`)
    options[name] = true
    continue
  }
  if (equals !== -1) {
    options[name] = argument.slice(equals + 1)
    continue
  }
  const value = arguments_[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value\n\n${usage}`)
  options[name] = value
  index += 1
}

if (options.help) {
  console.log(usage)
  process.exit(0)
}

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })

// In check mode the committed index names the commit to compare against, so
// `--check` keeps passing after the index itself is committed.
let requested = options.commit
if (!requested && options.check) {
  try {
    requested = JSON.parse(await readFile(join(root, indexPath), 'utf8')).plugins?.[0]?.versions?.[0]?.source?.commit
  } catch {
    requested = undefined
  }
}
requested ??= 'HEAD'
let commit
try {
  commit = git('rev-parse', '--verify', `${requested}^{commit}`).trim()
} catch {
  throw new Error(`--commit ${requested} is not a commit in this repository`)
}
const readAt = path => git('show', `${commit}:${path}`)
const manifest = JSON.parse(readAt(`${packagePath}/package.json`))

if (!manifest.repository?.url || !manifest.repository.directory) throw new Error(`${packagePath}/package.json must declare repository.url and repository.directory`)
if (!manifest.engines?.dsh) throw new Error(`${packagePath}/package.json must declare engines.dsh`)
for (const input of ['scripts/build.mjs', 'tsconfig.base.json', 'tsconfig.host.json', 'tsconfig.client.json']) {
  try {
    git('cat-file', '-e', `${commit}:${packagePath}/${input}`)
  } catch {
    throw new Error(`${commit} is not installable: ${packagePath}/${input} is missing, so a prepare build would fail`)
  }
}
if (manifest.scripts?.prepare !== 'node scripts/build.mjs') {
  throw new Error(`${commit} is not installable: its ${packagePath}/package.json has no prepare build, so a git install would ship no entry points`)
}
const repository = manifest.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')

// The publish time defaults to the commit's own time, so regenerating an
// unchanged index is a no-op.
const timestamp = options.timestamp ?? git('show', '-s', '--format=%ct', commit).trim()
if (!/^\d+$/.test(timestamp)) throw new Error(`--timestamp must be whole Unix seconds, received ${timestamp}`)

const localeNames = git('ls-tree', '--name-only', `${commit}:${packagePath}/locale`)
  .split('\n').map(name => name.trim()).filter(name => name.endsWith('.json')).sort()
if (localeNames.length === 0) throw new Error(`${commit} has no ${packagePath}/locale resources`)
const locales = {}
for (const file of localeNames) {
  const language = file.replace(/\.json$/, '')
  try {
    locales[language] = JSON.parse(readAt(`${packagePath}/locale/${file}`)).meta ?? {}
  } catch {
    throw new Error(`${commit}:${packagePath}/locale/${file} is not valid JSON`)
  }
}
if (!locales.en) throw new Error(`${commit} has no locale/en.json`)

/** Build a LocalizedText from every locale that supplies a non-blank field. */
const localized = (field, fallback) => {
  const text = {}
  for (const [language, meta] of Object.entries(locales)) {
    const value = meta[field]
    if (typeof value === 'string' && value.trim()) text[language] = value
  }
  if (!text.en) text.en = fallback
  return text
}

const index = {
  format: 1,
  title: options.title ?? { en: 'Agent tree canvas', zh: '会话画布' },
  plugins: [
    {
      name: manifest.name,
      title: localized('title', manifest.name),
      description: localized('description', manifest.description),
      author: options.author ?? 'Hayden-Chang',
      homepage: manifest.homepage,
      repository: { url: repository, directory: manifest.repository.directory },
      versions: [
        {
          version: manifest.version,
          publishTimestamp: Number(timestamp),
          source: { type: 'git', url: repository, commit, path: manifest.repository.directory },
          engines: { dsh: manifest.engines.dsh },
        },
      ],
    },
  ],
}

// Validate with the same parser dsh uses, so a served index cannot be rejected.
const { parseMarketIndex, marketInstallTarget } = await import('@deepseek-ai/dsh-plugin-market-index')
const parsed = parseMarketIndex(index, options.url ?? defaultUrl)
const target = marketInstallTarget(parsed.plugins[0].name, parsed.plugins[0].versions[0])
const document = `${JSON.stringify(index, null, 2)}\n`

const output = join(root, indexPath)
if (options.check) {
  let current
  try {
    current = await readFile(output, 'utf8')
  } catch {
    throw new Error(`${indexPath} is missing; run without --check to generate it`)
  }
  if (current !== document) throw new Error(`${indexPath} is out of date for ${commit}; regenerate it and commit the result`)
  console.log(`${indexPath} is up to date for ${manifest.name}@${manifest.version} at ${commit}`)
} else {
  await mkdir(join(root, 'market'), { recursive: true })
  await writeFile(output, document)
  console.log(`Wrote ${indexPath} for ${manifest.name}@${manifest.version} at ${commit}`)
}
console.log(`Installs as ${target.spec}`)
