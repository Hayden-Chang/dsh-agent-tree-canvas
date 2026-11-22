/** Launch a stock DSH Web profile without inheriting another checkout's module search path. */
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

const carrier = process.env.DSH_STOCK_ROOT
if (!carrier || !isAbsolute(carrier)) throw new Error('Set DSH_STOCK_ROOT to an absolute stock DSH checkout path')
if (!process.env.DSH_HOME || !isAbsolute(process.env.DSH_HOME)) throw new Error('Set DSH_HOME to the existing absolute data directory')
await access(join(process.env.DSH_HOME, 'profiles', 'web', 'package.json'))
await access(join(carrier, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'))
const env = { ...process.env }
delete env.NODE_PATH
// Invoke pnpm itself, since generated .bin shims inject their checkout into NODE_PATH.
env.PATH = [dirname(process.execPath), join(carrier, 'node_modules', '.bin'),
  ...(env.PATH ?? '').split(delimiter).filter(entry => entry && !entry.includes('/node_modules/'))].join(delimiter)
const child = spawn(process.execPath, [join(carrier, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
  'dsh', 'web', ...process.argv.slice(2)], { cwd: carrier, env, stdio: 'inherit' })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
