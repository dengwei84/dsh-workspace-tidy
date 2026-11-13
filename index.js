/**
 * dsh-workspace-tidy
 *
 * Keeps a session workspace tidy: generated scripts and leftovers are moved
 * into one hidden directory (`.dsh/` by default) instead of being deleted.
 *
 * Wiring (all through Host events, no UI):
 *   - agent/turn-stopping  -> "junk" pass: temp files and render leftovers only
 *                             (runs after tools settle, before the turn closes)
 *   - session/disposed     -> "full" pass: junk + generated scripts
 *   - session/created      -> "startup" pass: junk + scripts older than
 *                             scriptMinAgeHours
 *   - ctx.interval         -> "startup" pass for every live session
 *   - apply()              -> "startup" pass for sessions already live
 *
 * Every move is appended to `<target>/tidy-log.jsonl` so nothing is lost.
 */

import { appendFile, lstat, mkdir, readdir, rename, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

export const name = 'workspace-tidy'

const DEFAULTS = {
  /** Directory that receives everything, relative to the workspace root. */
  target: '.dsh',
  /** File globs treated as disposable leftovers; moved on every turn. */
  junkPatterns: ['.dsh-*', '~$*', '*.tmp', '*.log', '*.bak', '*.orig'],
  /** Directories treated as leftovers and moved as a whole. */
  officeDirs: ['.dsh-office-*'],
  cacheDirs: ['__pycache__', '.pytest_cache'],
  /** Generated script globs; moved at session end, or at startup when old. */
  scriptPatterns: ['*.py', '*.ps1', '*.sh', '*.bat', '*.cmd'],
  /** Names never moved (exact match, case-insensitive). */
  keep: ['AGENTS.md', 'README.md', '清理DSH临时文件.ps1', '修复-DSH插件更新.ps1'],
  /** A leftover younger than this may still be written; skip it. */
  minAgeSeconds: 120,
  /** A script must be at least this old to move during a startup scan. */
  scriptMinAgeHours: 12,
  /** Log moves without touching disk. */
  dryRun: false,
  /** Upper bound of root entries inspected per pass. */
  maxEntries: 500,
  /** Periodic startup-style scan while a session is live; 0 disables. */
  intervalMinutes: 10,
}

const TURN = 'turn'
const FULL = 'full'
const STARTUP = 'startup'

function escapeRegExp(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

function globToRegExp(glob) {
  return new RegExp(`^${escapeRegExp(glob).replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
}

function compile(globs) {
  const patterns = (globs ?? []).map(globToRegExp)
  return (value) => patterns.some((pattern) => pattern.test(value))
}

function normalize(config) {
  const merged = { ...DEFAULTS, ...(config ?? {}) }
  merged.junk = compile(merged.junkPatterns)
  merged.office = compile(merged.officeDirs)
  merged.cache = compile(merged.cacheDirs)
  merged.script = compile(merged.scriptPatterns)
  merged.keepSet = new Set((merged.keep ?? []).map((entry) => entry.toLowerCase()))
  return merged
}

async function statOrNone(path) {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}

async function lstatOrNone(path) {
  try {
    return await lstat(path)
  } catch {
    return undefined
  }
}

function uniqueNames(filename) {
  const extension = extname(filename)
  const stem = filename.slice(0, filename.length - extension.length)
  return (index) => join(`${stem}-${index}${extension}`)
}

async function moveInto(from, toDirectory) {
  await mkdir(toDirectory, { recursive: true })
  const original = basename(from)
  const suffixed = uniqueNames(original)
  let to = join(toDirectory, original)
  for (let index = 2; index < 100 && (await lstatOrNone(to)) !== undefined; index += 1) {
    to = join(toDirectory, suffixed(index))
  }
  await rename(from, to)
  return to
}

async function appendLog(root, target, entry) {
  const directory = join(root, target)
  await mkdir(directory, { recursive: true })
  await appendFile(join(directory, 'tidy-log.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8')
}

function ageSeconds(stats) {
  return (Date.now() - stats.mtimeMs) / 1000
}

function sessionDirectory(ctx, session) {
  const fromHeader = session?.header?.cwd
  if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory === undefined) return undefined
  try {
    return workingDirectory.get(session)
  } catch {
    return undefined
  }
}

async function pass(ctx, session, mode, options) {
  const root = sessionDirectory(ctx, session)
  if (root === undefined) return
  const rootStats = await statOrNone(root)
  if (rootStats === undefined || !rootStats.isDirectory()) return

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    ctx.logger.warn(`workspace-tidy: cannot read ${root}: ${String(error)}`)
    return
  }

  const targetName = options.target.replace(/[\\/]+$/, '')
  const moves = []
  for (const entry of entries.slice(0, options.maxEntries)) {
    if (entry.name === targetName) continue
    if (entry.isSymbolicLink()) continue
    const full = join(root, entry.name)
    const info = await statOrNone(full)
    if (info === undefined) continue

    if (entry.isDirectory()) {
      if (options.office(entry.name) || options.cache(entry.name)) {
        const destination = options.office(entry.name)
          ? join(root, targetName, 'office')
          : join(root, targetName, 'tmp', 'cache')
        if (!options.dryRun) {
          const to = await moveInto(full, destination)
          moves.push({ from: full, to })
        } else {
          moves.push({ from: full, to: join(destination, entry.name) })
        }
      }
      continue
    }

    if (!entry.isFile()) continue
    if (options.keepSet.has(entry.name.toLowerCase())) continue
    const age = ageSeconds(info)

    if (options.junk(entry.name) && age >= options.minAgeSeconds) {
      const destination = join(root, targetName, 'tmp')
      if (!options.dryRun) {
        const to = await moveInto(full, destination)
        moves.push({ from: full, to })
      } else {
        moves.push({ from: full, to: join(destination, entry.name) })
      }
      continue
    }

    if (options.script(entry.name)) {
      const oldEnoughForStartup = age >= options.scriptMinAgeHours * 3600
      const wanted = mode === FULL || (mode === STARTUP && oldEnoughForStartup)
      if (!wanted) continue
      const destination = join(root, targetName, 'tmp', 'scripts')
      if (!options.dryRun) {
        const to = await moveInto(full, destination)
        moves.push({ from: full, to })
      } else {
        moves.push({ from: full, to: join(destination, entry.name) })
      }
    }
  }

  if (moves.length === 0) return
  await appendLog(root, targetName, {
    at: new Date().toISOString(),
    mode,
    root,
    dryRun: options.dryRun === true,
    moves: moves.map(({ from, to }) => ({ from, to })),
  })
  ctx.logger.info(`workspace-tidy: ${mode} pass moved ${moves.length} item(s) in ${root}${options.dryRun ? ' (dry run)' : ''}`)
}

export function apply(ctx, config) {
  const options = normalize(config)
  const chains = new Map()

  const run = (mode, session) => {
    const root = sessionDirectory(ctx, session)
    if (root === undefined) return Promise.resolve()
    const previous = chains.get(root) ?? Promise.resolve()
    const next = previous
      .then(() => pass(ctx, session, mode, options))
      .catch((error) => {
        ctx.logger.warn(`workspace-tidy: ${mode} pass failed: ${String(error)}`)
      })
    chains.set(root, next)
    return next
  }

  ctx.on('agent/turn-stopping', ({ agent }) => run(TURN, agent.session))
  ctx.on('session/created', (session) => run(STARTUP, session))
  ctx.on('session/disposed', (session) => run(FULL, session))

  const agents = ctx.get('agents')
  if (agents !== undefined) {
    for (const agent of agents.list()) void run(STARTUP, agent.session)
  }

  if (options.intervalMinutes > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        const live = ctx.get('agents')
        for (const agent of live?.list() ?? []) void run(STARTUP, agent.session)
      }, options.intervalMinutes * 60_000)
      timer.unref?.()
      return () => clearInterval(timer)
    })
  }
}
