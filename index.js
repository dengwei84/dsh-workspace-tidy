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

import { execFile } from 'node:child_process'
import { appendFile, copyFile, lstat, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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
  /** A script must be this old to move at session end (still being written). */
  scriptMinAgeSeconds: 30,
  /** A script must be at least this old to move during a startup scan. */
  scriptMinAgeHours: 12,
  /** Never move a file tracked by git in the workspace repository. */
  skipGitTracked: true,
  /** Log moves without touching disk. */
  dryRun: false,
  /** Upper bound of candidate entries inspected per pass. */
  maxEntries: 500,
  /** Periodic startup-style scan while a session is live; 0 disables. */
  intervalMinutes: 10,
}

const TURN = 'turn'
const FULL = 'full'
const STARTUP = 'startup'

/** How long a `git ls-files` answer is reused. */
const TRACKED_TTL_MS = 30_000

/** root -> { at: number, files: Set<string> | null } */
const trackedCache = new Map()

async function trackedFiles(root) {
  const cached = trackedCache.get(root)
  if (cached !== undefined && Date.now() - cached.at < TRACKED_TTL_MS) return cached.files
  let files = null
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'ls-files', '-z', '--cached'], {
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    })
    files = new Set(stdout.split('\0').filter((path) => path.length > 0))
  } catch {
    // Not a git repository, git missing, or the command failed: no guard.
    files = null
  }
  trackedCache.set(root, { at: Date.now(), files })
  return files
}

function escapeRegExp(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

function globToRegExp(glob) {
  return new RegExp(`^${escapeRegExp(glob).replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
}

function compile(globs) {
  const patterns = (Array.isArray(globs) ? globs : [globs]).filter((glob) => typeof glob === 'string').map(globToRegExp)
  return (value) => patterns.some((pattern) => pattern.test(value))
}

function normalize(config) {
  const merged = { ...DEFAULTS, ...(config ?? {}) }
  merged.junk = compile(merged.junkPatterns)
  merged.office = compile(merged.officeDirs)
  merged.cache = compile(merged.cacheDirs)
  merged.script = compile(merged.scriptPatterns)
  merged.keepSet = new Set(merged.keep.map((entry) => String(entry).toLowerCase()))
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

async function moveInto(from, toDirectory, renameFile = rename) {
  await mkdir(toDirectory, { recursive: true })
  const original = basename(from)
  const suffixed = uniqueNames(original)
  let to = join(toDirectory, original)
  for (let index = 2; index < 100 && (await lstatOrNone(to)) !== undefined; index += 1) {
    to = join(toDirectory, suffixed(index))
  }
  try {
    await renameFile(from, to)
  } catch (error) {
    // rename() cannot cross volumes; fall back to copy + unlink.
    if (error?.code !== 'EXDEV') throw error
    await copyFile(from, to)
    await unlink(from)
  }
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

function destinationFor(root, targetName, entry, options) {
  if (entry.isDirectory()) {
    return options.office(entry.name)
      ? join(root, targetName, 'office')
      : join(root, targetName, 'tmp', 'cache')
  }
  if (options.script(entry.name) && !options.junk(entry.name)) {
    return join(root, targetName, 'tmp', 'scripts')
  }
  return join(root, targetName, 'tmp')
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

  const targetName = String(options.target).replace(/[\\/]+$/, '')
  const candidates = []
  for (const entry of entries) {
    if (entry.name === targetName) continue
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (options.office(entry.name) || options.cache(entry.name)) candidates.push(entry)
      continue
    }
    if (!entry.isFile()) continue
    if (options.keepSet.has(entry.name.toLowerCase())) continue
    if (!options.junk(entry.name) && !options.script(entry.name)) continue
    candidates.push(entry)
  }

  const limited = candidates.slice(0, options.maxEntries)
  if (candidates.length > limited.length) {
    ctx.logger.warn(
      `workspace-tidy: ${candidates.length - limited.length} candidate(s) left for the next pass in ${root} (maxEntries ${options.maxEntries})`,
    )
  }

  const tracked = options.skipGitTracked ? await trackedFiles(root) : null
  const renameFile = typeof options.renameFile === 'function' ? options.renameFile : rename
  const moves = []
  const failed = []

  for (const entry of limited) {
    const full = join(root, entry.name)
    try {
      const info = await statOrNone(full)
      if (info === undefined) continue

      if (entry.isDirectory()) {
        const destination = destinationFor(root, targetName, entry, options)
        if (options.dryRun) {
          moves.push({ from: full, to: join(destination, entry.name) })
        } else {
          moves.push({ from: full, to: await moveInto(full, destination, renameFile) })
        }
        continue
      }

      if (tracked !== null && tracked.has(entry.name)) continue
      const age = ageSeconds(info)

      if (options.junk(entry.name) && age >= options.minAgeSeconds) {
        const destination = destinationFor(root, targetName, entry, options)
        if (options.dryRun) {
          moves.push({ from: full, to: join(destination, entry.name) })
        } else {
          moves.push({ from: full, to: await moveInto(full, destination, renameFile) })
        }
        continue
      }

      if (mode === TURN || !options.script(entry.name)) continue
      const minimumAge = mode === FULL ? options.scriptMinAgeSeconds : options.scriptMinAgeHours * 3600
      if (age < minimumAge) continue
      const destination = join(root, targetName, 'tmp', 'scripts')
      if (options.dryRun) {
        moves.push({ from: full, to: join(destination, entry.name) })
      } else {
        moves.push({ from: full, to: await moveInto(full, destination, renameFile) })
      }
    } catch (error) {
      // One unreadable/locked entry must not abort the whole pass.
      failed.push({ name: entry.name, error: String(error) })
    }
  }

  if (moves.length === 0 && failed.length === 0) return
  await appendLog(root, targetName, {
    at: new Date().toISOString(),
    mode,
    root,
    dryRun: options.dryRun === true,
    moves,
    failed,
  })
  if (moves.length > 0) {
    ctx.logger.info(
      `workspace-tidy: ${mode} pass moved ${moves.length} item(s) in ${root}${options.dryRun ? ' (dry run)' : ''}`,
    )
  }
  if (failed.length > 0) {
    ctx.logger.warn(`workspace-tidy: ${mode} pass failed to move ${failed.length} item(s) in ${root}`)
  }
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
