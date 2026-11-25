// Smoke test: apply() must not throw, and must register the tool + both routes.
//
// Why this exists: an apply() that throws — a temporal-dead-zone reference, for
// instance — aborts the plugin silently. DSH keeps running, the bundle stays
// enabled, and the only symptom is that the tool quietly disappears (which is
// exactly what happened once and cost several debug cycles). This runs in
// milliseconds and catches that class of bug before a restart.
//
//   node test/smoke.mjs

import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const entry = pathToFileURL(join(here, '..', 'lib', 'index.js')).href

const registered = []
const routes = []

const inner = {
  get: (name) => {
    if (name === 'agents') return { list: () => [] }
    if (name === 'schedule') return { create: async () => ({}) }
    return undefined
  },
  tools: {
    register: (def) => {
      if (!def?.name) throw new Error('register: missing name')
      registered.push(def.name)
    },
  },
  webServer: {
    register: (route) => {
      routes.push(route.path)
      return () => {}
    },
  },
  effect: (fn) => {
    const disposal = typeof fn === 'function' ? fn() : undefined
    return typeof disposal === 'function' ? disposal : () => {}
  },
}

const ctx = {
  logger: { info: () => {}, warn: () => {} },
  inject: (_services, cb) => {
    cb(inner)
    return () => {}
  },
  get: inner.get,
}

const mod = await import(entry)

let failed = false
try {
  mod.apply(ctx)
} catch (error) {
  console.log('FAIL apply() threw:', error?.message ?? String(error))
  failed = true
}

if (!registered.includes('restart_guard')) {
  console.log('FAIL restart_guard was not registered')
  failed = true
}
if (routes.length !== 2) {
  console.log(`FAIL expected 2 routes, got ${routes.length}: ${JSON.stringify(routes)}`)
  failed = true
}

if (failed) process.exit(1)
console.log(`ok  tool=${registered.join(',')} routes=${routes.join(',')}`)