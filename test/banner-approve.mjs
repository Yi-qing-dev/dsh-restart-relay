// The banner button must queue continuations, exactly like the tool and the timer.
//
// This is a regression test for a real bug: the HTTP `approve` route wrote the
// approval marker itself instead of going through the shared approve path, so
// clicking 「立即重启」 restarted everything and resumed nothing. The tool and the
// expiry timer were fine, which is why the bug survived the earlier tests — they
// only ever exercised the tool.
//
//   node test/banner-approve.mjs

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const scratch = mkdtempSync(join(tmpdir(), 'relay-banner-'))
process.env.USERPROFILE = scratch
process.env.HOME = scratch

const SELF = 'session-who-asked'

const created = []
let toolDef = null
const routes = new Map()

const inner = {
  get: (name) => {
    if (name === 'agents') return { list: () => [{ id: SELF, status: 'idle' }] }
    if (name === 'schedule') {
      return {
        create: async (task) => {
          created.push(task)
          return { id: `sched-${created.length}` }
        },
      }
    }
    return undefined
  },
  tools: { register: (def) => { toolDef = def } },
  webServer: {
    register: (route) => {
      routes.set(route.path, route)
      return () => {}
    },
  },
  // Must actually invoke the callback: routes are registered inside
  // webCtx.effect(() => server.register(...)), so a no-op effect registers nothing.
  effect: (fn) => {
    const disposal = typeof fn === 'function' ? fn() : undefined
    return typeof disposal === 'function' ? disposal : () => {}
  },
}

const ctx = {
  logger: { info: () => {}, warn: () => {} },
  inject: (_services, cb) => { cb(inner); return () => {} },
  get: inner.get,
}

const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)
mod.apply(ctx)

// 1. the session asks for a restart through the tool
await toolDef.execute(
  { action: 'request', reason: 'installed a plugin update' },
  { agent: { session: { id: SELF } } },
)

// 2. the user clicks 「立即重启」 — this goes over HTTP, with no calling session
const route = routes.get('/api/restart-guard/action')
if (!route) {
  console.log('FAIL the action route was not registered')
  process.exit(1)
}

const body = Buffer.from(JSON.stringify({ action: 'approve' }), 'utf8')
const req = {
  method: 'POST',
  async *[Symbol.asyncIterator]() {
    yield body
  },
}
let statusCode = 0
let payload = ''
const res = {
  set statusCode(value) { statusCode = value },
  get statusCode() { return statusCode },
  setHeader: () => {},
  end: (chunk) => { payload = String(chunk ?? '') },
}

await route.handler(req, res)

let failures = 0
const check = (label, ok, detail) => {
  if (ok) console.log(`ok   ${label}`)
  else { console.log(`FAIL ${label} — ${detail}`); failures++ }
}

check('route answered 200', statusCode === 200, `got ${statusCode} ${payload}`)
check('a continuation was queued', created.length === 1, `got ${created.length}`)
check(
  'queued for the session that asked',
  created[0]?.target?.sessionId === SELF,
  JSON.stringify(created[0]?.target),
)
check(
  'prompt carries the reason',
  Boolean(created[0]?.prompt?.includes('installed a plugin update')),
  created[0]?.prompt?.slice(0, 80),
)
check(
  'self prompt does not claim it saw "task stopped"',
  !String(created[0]?.prompt ?? '').includes('任务已停止'),
  created[0]?.prompt?.slice(0, 80),
)

rmSync(scratch, { recursive: true, force: true })

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nbanner approve path verified')