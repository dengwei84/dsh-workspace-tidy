import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply } = await import(new URL('../index.js', import.meta.url).href)

async function makeRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-workspace-tidy-'))
}

async function backdate(path, seconds) {
  const time = new Date(Date.now() - seconds * 1000)
  await utimes(path, time, time)
}

async function exists(path) {
  return stat(path).then(() => true, () => false)
}

function makeContext() {
  const handlers = new Map()
  const logs = []
  const ctx = {
    logger: {
      info: (line) => logs.push(line),
      warn: (line) => logs.push(line),
      debug: () => {},
    },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    effect(fn) {
      fn()
    },
    get() {
      return undefined
    },
  }
  const fire = async (event, payload) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload)
  }
  return { ctx, fire, logs }
}

async function readLog(root) {
  const text = await readFile(join(root, '.dsh', 'tidy-log.jsonl'), 'utf8')
  return text.trim().split('\n').map((line) => JSON.parse(line))
}

test('turn pass moves junk and render dirs, keeps scripts and keep-list', async () => {
  const root = await makeRoot()
  try {
    await mkdir(join(root, '.dsh-office-x'), { recursive: true })
    await writeFile(join(root, 'a.tmp'), 'tmp')
    await writeFile(join(root, 'b.py'), 'print(1)')
    await writeFile(join(root, '清理DSH临时文件.ps1'), 'keep')
    for (const name of ['a.tmp', 'b.py', '清理DSH临时文件.ps1', '.dsh-office-x']) {
      await backdate(join(root, name), 600)
    }

    const { ctx, fire } = makeContext()
    apply(ctx, { intervalMinutes: 0 })
    await fire('agent/turn-stopping', { agent: { session: { header: { cwd: root } } } })

    assert.equal(await exists(join(root, '.dsh', 'tmp', 'a.tmp')), true)
    assert.equal(await exists(join(root, 'a.tmp')), false)
    assert.equal(await exists(join(root, '.dsh', 'office', '.dsh-office-x')), true)
    assert.equal(await exists(join(root, 'b.py')), true, 'scripts stay on turn pass')
    assert.equal(await exists(join(root, '清理DSH临时文件.ps1')), true, 'keep list protected')

    const [entry] = await readLog(root)
    assert.equal(entry.mode, 'turn')
    assert.deepEqual(entry.failed, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('full pass moves scripts only when older than scriptMinAgeSeconds', async () => {
  const root = await makeRoot()
  try {
    await writeFile(join(root, 'fresh.py'), 'print(1)')
    await writeFile(join(root, 'old.py'), 'print(2)')
    await backdate(join(root, 'old.py'), 120)

    const { ctx, fire } = makeContext()
    apply(ctx, { intervalMinutes: 0 })
    await fire('session/disposed', { header: { cwd: root } })

    assert.equal(await exists(join(root, '.dsh', 'tmp', 'scripts', 'old.py')), true)
    assert.equal(await exists(join(root, 'fresh.py')), true, 'fresh script may still be written')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('git-tracked scripts are never moved', async () => {
  const root = await makeRoot()
  try {
    execFileSync('git', ['init', '-q'], { cwd: root })
    await writeFile(join(root, 'tracked.py'), 'print(1)')
    await writeFile(join(root, 'untracked.py'), 'print(2)')
    execFileSync('git', ['add', 'tracked.py'], { cwd: root })
    await backdate(join(root, 'tracked.py'), 600)
    await backdate(join(root, 'untracked.py'), 600)

    const { ctx, fire } = makeContext()
    apply(ctx, { intervalMinutes: 0 })
    await fire('session/disposed', { header: { cwd: root } })

    assert.equal(await exists(join(root, 'tracked.py')), true)
    assert.equal(await exists(join(root, '.dsh', 'tmp', 'scripts', 'untracked.py')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('one failing entry does not abort the rest of the pass', async () => {
  const root = await makeRoot()
  try {
    await writeFile(join(root, 'a.tmp'), 'a')
    await writeFile(join(root, 'b.tmp'), 'b')
    await backdate(join(root, 'a.tmp'), 600)
    await backdate(join(root, 'b.tmp'), 600)

    const { ctx, fire } = makeContext()
    apply(ctx, {
      intervalMinutes: 0,
      renameFile: async (from, to) => {
        if (from.endsWith('a.tmp')) {
          const error = new Error('EBUSY: resource busy or locked')
          error.code = 'EBUSY'
          throw error
        }
        return rename(from, to)
      },
    })
    await fire('agent/turn-stopping', { agent: { session: { header: { cwd: root } } } })

    assert.equal(await exists(join(root, '.dsh', 'tmp', 'b.tmp')), true, 'later entries still move')
    assert.equal(await exists(join(root, 'a.tmp')), true)
    const [entry] = await readLog(root)
    assert.equal(entry.failed.length, 1)
    assert.equal(entry.failed[0].name, 'a.tmp')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('maxEntries applies to candidates, not to the raw directory listing', async () => {
  const root = await makeRoot()
  try {
    for (const name of ['x.tmp', 'y.tmp', 'z.tmp']) {
      await writeFile(join(root, name), name)
      await backdate(join(root, name), 600)
    }

    const { ctx, fire } = makeContext()
    apply(ctx, { intervalMinutes: 0, maxEntries: 2 })
    await fire('agent/turn-stopping', { agent: { session: { header: { cwd: root } } } })

    const moved = (await readLog(root)).flatMap((entry) => entry.moves)
    assert.equal(moved.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('dryRun records moves without touching disk', async () => {
  const root = await makeRoot()
  try {
    await writeFile(join(root, 'a.tmp'), 'a')
    await backdate(join(root, 'a.tmp'), 600)

    const { ctx, fire } = makeContext()
    apply(ctx, { intervalMinutes: 0, dryRun: true })
    await fire('agent/turn-stopping', { agent: { session: { header: { cwd: root } } } })

    assert.equal(await exists(join(root, 'a.tmp')), true)
    const [entry] = await readLog(root)
    assert.equal(entry.dryRun, true)
    assert.equal(entry.moves.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
