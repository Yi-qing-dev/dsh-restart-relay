// Continuation-queue rules.
//
// The two halves are deliberately different, and both were wrong once:
//
//   - the CALLING session is always queued, even when its turn already ended
//     (the common case: the agent posts its message, the countdown runs down
//     while it sits idle, and only then does approval fire);
//   - OTHER sessions are queued only while genuinely mid-turn.
//
// This also pins down that "defer" queues nothing for anyone, and that the
// reason travels into the prompt.
//
//   node test/continuations.mjs

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// The plugin resolves ~/.dsh at import time from the home directory, and a
// `request` really does spawn the restarter. Point the whole run at a scratch
// home so the test never touches the real marker files or the task scheduler.
const scratch = mkdtempSync(join(tmpdir(), 'relay-test-'))
process.env.USERPROFILE = scratch
process.env.HOME = scratch

const created = []
let toolDef = null

const inner = {
  get: (name) => {
    if (name === 'agents') return { list: () => agents }
    if (name === 'schedule') {
      return {
        create: async (task, actor) => {
          created.push({ ...task, actor })
          return { id: `sched-${created.length}` }
        },
      }
    }
    return undefined
  },
  tools: { register: (def) => { toolDef = def } },
  webServer: { register: () => () => {} },
  effect: () => () => {},
}

const ctx = {
  logger: { info: () => {}, warn: () => {} },
  inject: (_services, cb) => { cb(inner); return () => {} },
  get: inner.get,
}

// Three sessions: us (idle — the turn ended while the countdown ran), another
// one mid-turn, and a third that is idle and must not be woken.
const SELF = 'session-self'
let agents = [
  { id: SELF, status: 'idle' },
  { id: 'session-busy', status: 'running' },
  { id: 'session-idle', status: 'idle' },
]

const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
mod.apply(ctx)

const run = (action, extra = {}) => toolDef.execute({ action, ...extra }, { agent: { session: { id: SELF } } })

let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`ok   ${label}`)
  } else {
    console.log(`FAIL ${label} — ${detail}`)
    failures++
  }
}

// ── 1. request + approve: self always, busy other only ──────────────────────
await run('request', { reason: 'installed an update' })
const approved = await run('approve')

const ids = created.map((c) => c.target.sessionId)
check('self is queued even though its turn is idle', ids.includes(SELF), `queued=${JSON.stringify(ids)}`)
check('busy other session is queued', ids.includes('session-busy'), `queued=${JSON.stringify(ids)}`)
check('idle other session is NOT queued', !ids.includes('session-idle'), `queued=${JSON.stringify(ids)}`)
check('exactly two continuations', created.length === 2, `got ${created.length}`)

const selfTask = created.find((c) => c.target.sessionId === SELF)
const otherTask = created.find((c) => c.target.sessionId === 'session-busy')
check('reason reaches the self prompt', Boolean(selfTask?.prompt?.includes('installed an update')), selfTask?.prompt)
check('reason reaches the other prompt', Boolean(otherTask?.prompt?.includes('installed an update')), otherTask?.prompt)
check('self prompt does not claim it saw "task stopped"', !selfTask?.prompt?.includes('任务已停止'), selfTask?.prompt)
check('other prompt does explain "task stopped"', Boolean(otherTask?.prompt?.includes('任务已停止')), otherTask?.prompt)
check('self continuation is its own title', selfTask?.title === 'DSH restart continuation (self)', selfTask?.title)
check('self reports queued', approved?.continuations?.self === true, JSON.stringify(approved?.continuations))

// ── 2. defer queues nothing ────────────────────────────────────────────────
created.length = 0
agents = [
  { id: SELF, status: 'running' },
  { id: 'session-busy', status: 'running' },
]
await run('request', { reason: 'second attempt' })
const deferred = await run('defer')
check('defer queues no continuation', created.length === 0, `got ${created.length}`)
check('defer leaves phase deferred', deferred?.phase === 'deferred', JSON.stringify(deferred?.phase))

rmSync(scratch, { recursive: true, force: true })

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall continuation checks passed')