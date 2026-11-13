/**
 * Wiring check for dsh-workspace-tidy: imports the plugin, drives its
 * handlers with a fake context and asserts the three pass modes.
 *
 *   node test/verify.mjs
 */

import { mkdir, rm, stat, utimes, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply } = await import(new URL('../index.js', import.meta.url).href)
const root = join(tmpdir(), 'dsh-workspace-tidy-test')

await rm(root, { recursive: true, force: true })
await mkdir(join(root, '.dsh-office-t'), { recursive: true })
await writeFile(join(root, 'a.tmp'), 'tmp')
await writeFile(join(root, 'b.py'), 'print(1)')
await writeFile(join(root, '清理DSH临时文件.ps1'), 'keep me')
await writeFile(join(root, '.dsh-office-t', 'page-1.png'), 'png')
const old = new Date(Date.now() - 10 * 60_000)
for (const path of ['a.tmp', 'b.py', '清理DSH临时文件.ps1', '.dsh-office-t', '.dsh-office-t/page-1.png']) {
  await utimes(join(root, path), old, old)
}

const handlers = new Map()
const ctx = {
  logger: { info() {}, warn() {}, debug() {} },
  on(event, handler) {
    handlers.set(event, [...(handlers.get(event) ?? []), handler])
  },
  effect(fn) {
    fn()
  },
  get(service) {
    return service === 'agents' ? { list: () => [] } : undefined
  },
}
apply(ctx, {})

const session = { header: { cwd: root } }
const fire = async (event, payload) => {
  for (const handler of handlers.get(event) ?? []) await handler(payload)
}
const exists = async (path) => stat(path).then(() => 'yes', () => 'no')

await fire('agent/turn-stopping', { agent: { session } })
const afterTurn = (await readFile(join(root, '.dsh/tidy-log.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
const turnMoves = afterTurn.flatMap((line) => line.moves.map((move) => move.from.replaceAll('\\', '/').split('/').pop()))

console.log('events:', [...handlers.keys()].join(','))
console.log('turn mode:', afterTurn.map((line) => line.mode).join(','))
console.log('turn moved:', turnMoves.join(','))
console.log('turn kept script:', await exists(join(root, '清理DSH临时文件.ps1')))
console.log('turn kept .py:', await exists(join(root, 'b.py')))

await fire('session/disposed', session)
const lines = (await readFile(join(root, '.dsh/tidy-log.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
console.log('modes:', lines.map((line) => line.mode).join(','))
console.log('disposed .py moved:', await exists(join(root, '.dsh/tmp/scripts/b.py')))
console.log('keep file kept:', await exists(join(root, '清理DSH临时文件.ps1')))
console.log('absolute paths:', lines.flatMap((line) => line.moves).every((move) => move.from.includes(':') && move.to.includes(':')))

await rm(root, { recursive: true, force: true })
