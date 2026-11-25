/**
 * dsh-restart-guard — stage 2 (host side).
 *
 * Owns the restart request state machine and the HTTP route the client banner
 * polls. The actual restart is still performed by the detached script
 * (restart-dsh.ps1) which now waits for `restart-approved` before killing.
 *
 * Files (all under ~/.dsh):
 *   restart-request.json  — pending countdown {id, requestedAt, deadline}
 *   restart-approved      — marker the external restarter waits for
 *   restart-profile.json  — measured timing {killToPortMs, samples}
 *
 * No client bundle is declared here on purpose: `lib/client.js` must exist
 * before the manifest mentions it, otherwise DSH fails to boot.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'restart-guard'

const HOME = join(homedir(), '.dsh')
const REQUEST_FILE = join(HOME, 'restart-request.json')
const APPROVED_FILE = join(HOME, 'restart-approved')
const PROFILE_FILE = join(HOME, 'restart-profile.json')
const BOOT_LOG = join(HOME, 'restart-guard-boot.log')
const LOG_FILE = join(HOME, 'restart-supervisor.log')

// The restarter ships inside the package (scripts/), so resolve it relative to
// this module rather than a fixed ~/.dsh/bin path — otherwise the plugin only
// works on the machine it was developed on.
const HERE = dirname(fileURLToPath(import.meta.url))
const TRIGGER_SCRIPT = join(HERE, '..', 'scripts', 'trigger-restart.ps1')

const DEFAULT_COUNTDOWN_MS = 60_000
const SETTLE_MARGIN_MS = 15_000
const MIN_COUNTDOWN_MS = 20_000

function bootLog(line) {
  try {
    mkdirSync(HOME, { recursive: true })
    appendFileSync(BOOT_LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    // diagnostics must never be fatal
  }
}

function readJson(file) {
  try {
    let text = readFileSync(file, 'utf8')
    // PowerShell's `Set-Content -Encoding UTF8` (5.1) writes a BOM, and
    // JSON.parse rejects it. Strip it so a hand-written profile still loads.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Countdown = measured kill→port time + margin, with a conservative fallback. */
function countdownMs() {
  const profile = readJson(PROFILE_FILE)
  const measured = Number(profile?.killToPortMs)
  if (!Number.isFinite(measured) || measured <= 0) return DEFAULT_COUNTDOWN_MS
  return Math.max(MIN_COUNTDOWN_MS, measured + SETTLE_MARGIN_MS)
}

/**
 * Learn this machine's real restart cost from the restarter's own log.
 *
 * The restarter already writes `timing killToPortMs=<n>` after every successful
 * run, so the plugin only has to read it back on the next boot. Keeping the last
 * five samples and using the WORST of them (rather than the average) means one
 * unusually slow restart — antivirus scanning, disk contention — does not leave
 * the countdown too short for the following ones.
 *
 * Idempotent: `lastSampleAt` records which log line was consumed, so repeated
 * boots do not keep appending the same measurement.
 */
function refreshProfileFromLog() {
  try {
    let text
    try {
      text = readFileSync(LOG_FILE, 'utf8')
    } catch {
      return null
    }

    let found = null
    for (const line of text.split(/\r?\n/)) {
      const m = /^\[(.+?)\]\s+timing killToPortMs=(\d+)/.exec(line)
      if (m) found = { at: m[1], ms: Number(m[2]) }
    }
    if (found === null || !Number.isFinite(found.ms) || found.ms <= 0) return null

    const profile = readJson(PROFILE_FILE) ?? {}
    if (profile.lastSampleAt === found.at) return null

    const samples = Array.isArray(profile.samples) ? profile.samples.slice(-4) : []
    samples.push(found.ms)
    const worst = Math.max(...samples)

    writeFileSync(
      PROFILE_FILE,
      JSON.stringify(
        { killToPortMs: worst, samples, lastSampleAt: found.at, updatedAt: new Date().toISOString() },
        null,
        2,
      ),
    )
    bootLog(`profile updated from log: killToPortMs=${worst} samples=${samples.join(',')}`)
    return { killToPortMs: worst, samples }
  } catch (error) {
    bootLog(`profile refresh failed: ${String(error)}`)
    return null
  }
}

export function apply(ctx) {
  bootLog('apply entered (stage 2)')

  // First thing on boot: learn the real cost of the restart that just happened,
  // so the next countdown is measured rather than guessed.
  refreshProfileFromLog()

  // If the previous run was a self-restart, the restarter's console may still be
  // on screen. Clean it up once the new Host is up.
  cleanupAfterRestart()

  const state = {
    phase: 'idle', // idle | counting | approved | deferred
    id: null,
    requestedAt: null,
    deadline: null,
    reason: null,
  }

  const snapshot = () => {
    const approved = existsSync(APPROVED_FILE)
    return {
      ok: true,
      phase: state.phase,
      id: state.id,
      requestedAt: state.requestedAt,
      deadline: state.deadline,
      remainingMs: state.deadline === null ? null : Math.max(0, state.deadline - Date.now()),
      countdownMs: countdownMs(),
      approved,
      hasRequest: existsSync(REQUEST_FILE),
    }
  }

  const clearRequest = () => {
    try {
      rmSync(REQUEST_FILE, { force: true })
    } catch {
      // ignore
    }
  }

  const clearApproved = () => {
    try {
      rmSync(APPROVED_FILE, { force: true })
    } catch {
      // ignore
    }
  }

  // The detached restarter waits for restart-approved. It has to be started when
  // the request appears, not when the user approves: the countdown may expire
  // with nobody watching, and then the plugin itself approves on the deadline.
  let autoTimer = null
let cleanupTimer = null

// The restarter runs in a visible console (Task Scheduler on this machine hands
// it to Windows Terminal). That window does not always close when the script
// finishes: OpenConsole / WindowsTerminal under svchost can outlive the shell.
// After the restart completes, clean up the one-shot task and any console window
// that no longer hosts a shell — otherwise the user is left with a dead black
// box on screen.
//
// Declared as a hoisted `function` on purpose: it is called at the top of
// apply(), and a `const` arrow here would hit the temporal dead zone and abort
// the whole plugin — which is exactly the bug that silently killed
// tools.register once.
function cleanupAfterRestart() {
  // Runs as a FILE, not as an inline -Command. A multi-line script with embedded
  // double quotes cannot survive execFile's argv quoting on Windows: PowerShell
  // receives something it cannot parse and the whole cleanup silently fails.
  const script = join(HERE, '..', 'scripts', 'cleanup-after-restart.ps1')

  try {
    if (!existsSync(script)) {
      bootLog(`post-restart cleanup script missing at ${script}`)
      return
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, timeout: 30_000 },
      (error) => {
        if (error) bootLog(`post-restart cleanup failed: ${error.message.slice(0, 200)}`)
      },
    )
  } catch (error) {
    bootLog(`post-restart cleanup threw: ${String(error)}`)
  }
}

  const startRestarter = () => {
    try {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          TRIGGER_SCRIPT,
          '-DelaySeconds',
          '0',
        ],
        { windowsHide: false, timeout: 15_000 },
        (error) => {
          if (error) bootLog(`restarter spawn failed: ${error.message}`)
        },
      )
      bootLog('restarter spawned (waiting for approval)')
    } catch (error) {
      bootLog(`restarter spawn threw: ${String(error)}`)
    }
  }

  const clearAutoTimer = () => {
    if (autoTimer !== null) {
      clearTimeout(autoTimer)
      autoTimer = null
    }
  }

  ctx.inject(['tools'], (inner) => {
    try {
      inner.tools.register({
        name: 'restart_guard',
        description:
          'Ask the user to approve a DSH self-restart. '
          + 'action=request writes a countdown request that the page banner shows; '
          + 'action=approve marks it approved so the detached restarter may kill DSH '
          + '(and first schedules a continuation prompt for every other session that is still running); '
          + 'action=defer cancels this request and leaves the calling task suspended indefinitely; '
          + 'action=status reports the current phase, the live sessions and which ones are busy.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['status', 'request', 'approve', 'defer'] },
            reason: {
              type: 'string',
              description:
                'Why this restart is needed (e.g. "installed a plugin update"). Passed verbatim into '
                + 'every continuation prompt so the other sessions know this restart was intentional.',
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
          const action = String(args?.action ?? 'status')
          // The calling session, so continuations skip it: the caller already
          // has its own way of resuming, and a duplicate prompt would fight it.
          const selfId = exec?.agent?.session?.id ?? null

          if (action === 'request') {
            clearApproved()
            clearAutoTimer()
            const id = randomUUID()
            const now = Date.now()
            const ms = countdownMs()
            const reason = String(args?.reason ?? '').trim()
            state.phase = 'counting'
            state.id = id
            state.requestedAt = now
            state.deadline = now + ms
            state.reason = reason || null
            try {
              mkdirSync(HOME, { recursive: true })
              writeFileSync(
                REQUEST_FILE,
                JSON.stringify(
                  { id, requestedAt: now, deadline: state.deadline, countdownMs: ms, reason: state.reason },
                  null,
                  2,
                ),
              )
            } catch (error) {
              bootLog(`request write failed: ${String(error)}`)
            }

            // Start the restarter now; it blocks on the approval marker.
            startRestarter()

            // Deadline with nobody pressing anything = restart. Deferring clears
            // this timer, so "稍后" still means "never restart on my behalf".
            autoTimer = setTimeout(() => {
              autoTimer = null
              if (state.phase !== 'counting') return
              bootLog(`countdown expired; auto-approving ${state.id}`)
              void doApprove(inner, selfId, 'auto')
            }, ms)

            bootLog(`request ${id} scheduled in ${ms}ms`)
            return snapshot()
          }

          if (action === 'approve') {
            if (state.phase !== 'counting') {
              return { ok: false, error: 'no counting request to approve', ...snapshot() }
            }
            clearAutoTimer()
            return doApprove(inner, selfId, 'user')
          }

          if (action === 'defer') {
            clearAutoTimer()
            clearRequest()
            clearApproved()
            state.phase = 'deferred'
            bootLog(`deferred ${state.id ?? '(none)'}`)
            return snapshot()
          }

          return { ...snapshot(), self: selfId, sessions: await sessionReport(inner, selfId) }
        },
      })
      bootLog('tools.register returned (stage 2)')
    } catch (error) {
      bootLog(`tools.register threw: ${error instanceof Error ? error.message : String(error)}`)
    }

    /** Shared by the user's button and the expiry timer. */
    async function doApprove(inner, selfId, source) {
      // Continuations first: once the approval file exists the restarter may
      // kill DSH within a few seconds, so the prompts must already be queued.
      const continuations = await scheduleContinuations(inner, selfId)
      try {
        writeFileSync(APPROVED_FILE, String(state.id))
      } catch (error) {
        bootLog(`approve write failed: ${String(error)}`)
        return { ok: false, error: `approve write failed: ${String(error)}`, continuations }
      }
      clearRequest()
      state.phase = 'approved'
      bootLog(`approved ${state.id} by ${source}; continuations=${JSON.stringify(continuations)}`)
      return { ...snapshot(), approvedBy: source, continuations }
    }

    /**
     * Live agents and whether each is mid-turn. `agent.status === 'running'` is
     * how DSH's own workspace gate decides a session is busy.
     */
    async function sessionReport(inner, selfId) {
      const agents = inner.get?.('agents')
      const list = typeof agents?.list === 'function' ? agents.list() : []
      return list.map((agent) => {
        const id = agent?.session?.id ?? agent?.id ?? agent?.sessionId ?? null
        return {
          sessionId: id,
          running: agent?.status === 'running',
          status: agent?.status ?? null,
          isSelf: selfId !== null && id === selfId,
        }
      })
    }

    /**
     * Queue a one-shot continuation prompt so the work resumes after the reboot.
     *
     * Two different rules, because the two cases mean different things:
     *
     *  - The CALLING session is always queued, even if its turn has already
     *    ended. It asked for this restart and it wants to be woken up; waiting
     *    for it to look "running" would silently drop its continuation in the
     *    common case where the agent finished its message and went idle while
     *    the countdown ran out.
     *  - Other sessions are queued only while they are actually mid-turn. Waking
     *    an idle conversation nobody asked about is noise.
     */
    async function scheduleContinuations(inner, selfId) {
      const schedule = inner.get?.('schedule')
      if (!schedule || typeof schedule.create !== 'function') {
        bootLog('schedule service unavailable; no continuations queued')
        return { queued: [], error: 'schedule service unavailable' }
      }

      const report = await sessionReport(inner, selfId)
      const busy = report.filter((entry) => entry.running && entry.sessionId && !entry.isSelf)

      const targets = []
      if (selfId) targets.push({ sessionId: selfId, isSelf: true })
      for (const entry of busy) targets.push({ sessionId: entry.sessionId, isSelf: false })

      const why = state.reason ? `原因：${state.reason}。` : '原因：应用了一次更新。'
      const after = Math.ceil(countdownMs() / 1000) + 10

      const queued = []
      for (const target of targets) {
        // The waking session sees DSH's own "本轮已中止 / 任务已停止" notice and
        // has no idea why. Without saying that the restart was intentional and
        // that "stopped" is expected, a careful agent stops and asks the user
        // instead of carrying on — which defeats the whole point. The caller
        // itself may have gone idle before the restart, so it gets a variant
        // that does not assume it saw that notice.
        const prompt = target.isSelf
          ? [
              `【自动续接】DSH 刚刚重启完成，${why}`,
              '这次重启是你自己通过 restart_guard 发起的，属于计划内操作。',
              '请继续你重启前正在做的工作，从被打断的地方接着做；',
              '不要询问用户是否需要继续，不要从头重做整个任务，也不要重复已经完成的步骤。',
              '如果你无法判断进度，就从你已确认完成的部分往后继续，并在最后简要说明从哪里接上的。',
            ].join('')
          : [
              `【自动续接】DSH 刚刚被有意地重启了一次，${why}`,
              '你看到的「任务已停止 / 本轮已中止」是这次重启造成的，属于预期结果，不是故障，也不是你的错误。',
              '请立刻继续你重启前正在执行的任务，从被打断的地方接着做；',
              '不要询问用户是否需要继续，不要重新开始整个任务，也不要重复已经完成的步骤。',
              '如果你无法判断进度，就从你已确认完成的部分往后继续，并在最后简要说明从哪里接上的。',
            ].join('')

        try {
          await schedule.create(
            {
              title: target.isSelf ? 'DSH restart continuation (self)' : 'DSH restart continuation',
              prompt,
              timing: { kind: 'after', after_seconds: after },
              target: { kind: 'session', sessionId: target.sessionId },
            },
            target.sessionId,
          )
          queued.push(target.sessionId)
        } catch (error) {
          bootLog(`continuation for ${target.sessionId} failed: ${String(error)}`)
        }
      }

      return {
        queued,
        self: selfId ? queued.includes(selfId) : false,
        busy: busy.map((entry) => entry.sessionId),
        afterSeconds: after,
      }
    }
  })

  // The page banner polls this route. Registered from a webServer child scope,
  // because services are only reachable from a context that injected them.
  try {
    ctx.inject(['webServer'], (webCtx) => {
      const server = webCtx.webServer
      if (server === undefined || typeof server.register !== 'function') {
        bootLog('webServer unavailable; banner has no route')
        return
      }
      webCtx.effect(
        () =>
          server.register({
            kind: 'exact',
            path: '/api/restart-guard/state',
            handler: async (_req, res) => {
              const body = JSON.stringify(snapshot())
              res.statusCode = 200
              res.setHeader('content-type', 'application/json; charset=utf-8')
              res.setHeader('cache-control', 'no-store')
              res.end(body)
            },
          }),
        'restart-guard state route',
      )

      // The banner's two buttons talk to this route: {"action":"approve"|"defer"}.
      webCtx.effect(
        () =>
          server.register({
            kind: 'exact',
            path: '/api/restart-guard/action',
            handler: async (req, res) => {
              const send = (code, value) => {
                res.statusCode = code
                res.setHeader('content-type', 'application/json; charset=utf-8')
                res.setHeader('cache-control', 'no-store')
                res.end(JSON.stringify(value))
              }
              if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' })

              const chunks = []
              for await (const chunk of req) chunks.push(chunk)
              let action = ''
              try {
                action = String(JSON.parse(Buffer.concat(chunks).toString('utf8'))?.action ?? '')
              } catch {
                return send(400, { ok: false, error: 'invalid json' })
              }

              if (action === 'approve') {
                if (state.phase !== 'counting') return send(409, { ok: false, ...snapshot() })
                try {
                  writeFileSync(APPROVED_FILE, String(state.id))
                } catch (error) {
                  return send(500, { ok: false, error: String(error) })
                }
                clearRequest()
                state.phase = 'approved'
                bootLog(`approved via banner ${state.id}`)
                return send(200, snapshot())
              }

              if (action === 'defer') {
                clearRequest()
                try {
                  rmSync(APPROVED_FILE, { force: true })
                } catch {
                  // ignore
                }
                state.phase = 'deferred'
                bootLog(`deferred via banner ${state.id ?? '(none)'}`)
                return send(200, snapshot())
              }

              return send(400, { ok: false, error: `unknown action: ${action}` })
            },
          }),
        'restart-guard action route',
      )

      bootLog('webServer routes registered')
    })
  } catch (error) {
    bootLog(`webServer inject threw: ${error instanceof Error ? error.message : String(error)}`)
  }
}
