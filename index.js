/**
 * dsh-hud — Host half.
 *
 * Folds the live task state of the active DSH session and hands it to the
 * desktop overlay through a small local file:
 *
 *   ~/.dsh/dsh-hud/state.json   current HUD state (active session + step list)
 *
 * Data comes exclusively from services the composition already runs:
 *
 *   - `ctx.sessions.list()`           live Session instances
 *   - `ctx.sessionProjections.snapshot(session)`  the `todos` / `title` keys
 *   - `ctx.on('session/event', …)`    turn / step lifecycle
 *
 * Nothing is persisted and nothing is written back: the HUD is a read-only
 * view of work that is already happening.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-hud'
export const inject = ['sessions', 'sessionProjections']

const STALE_MS = 45 * 60 * 1000
const MAX_STEPS = 24

/** Local IPC with the desktop overlay window; nothing here leaves the machine. */
const HUD_DIR = join(homedir(), '.dsh', 'dsh-hud')
const STATE_FILE = join(HUD_DIR, 'state.json')
const HEARTBEAT_FILE = join(HUD_DIR, 'overlay.heartbeat')
const OVERLAY_SCRIPT = join(import.meta.dirname, 'overlay.ps1')
const HEARTBEAT_FRESH_MS = 4000
const SPAWN_LOG = join(HUD_DIR, 'overlay-spawn.log')

/** Absolute path first: the Host's PATH is not guaranteed to include System32. */
function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const candidates = [
    join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    join(root, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'powershell.exe'
}

function logSpawn(message) {
  try {
    ensureHudDir()
    const line = `${new Date().toISOString()} ${message}\n`
    writeFileSync(SPAWN_LOG, line, { flag: 'a' })
  } catch {
    /* logging must never break the HUD */
  }
}


/** Per-session folding state, keyed by the live Session object. */
const activity = new WeakMap()

function ensure(session) {
  let state = activity.get(session)
  if (state === undefined) {
    state = {
      seq: -1,
      at: 0,
      running: false,
      turn: null,
      step: null,
      turnStartedAt: 0,
      turnEndedAt: 0,
      turnEndReason: null,
      lastType: null,
    }
    activity.set(session, state)
  }
  return state
}

function feed(session, event, onChange) {
  if (event === null || typeof event !== 'object') return
  const state = ensure(session)
  const type = typeof event.type === 'string' ? event.type : null
  if (typeof event.seq === 'number' && event.seq > state.seq) state.seq = event.seq
  const time = Number(event.time)
  state.at = Number.isFinite(time) && time > 0 ? time : Date.now()
  state.lastType = type
  const data = event.data && typeof event.data === 'object' ? event.data : {}

  if (type === 'turn/start') {
    state.running = true
    state.turn = data.turn ?? null
    state.turnStartedAt = state.at
    state.turnEndedAt = 0
    state.turnEndReason = null
  } else if (type === 'turn/end') {
    state.running = false
    state.turnEndedAt = state.at
    state.turnEndReason = typeof data.reason === 'string' ? data.reason : null
  } else if (type === 'step/start') {
    state.step = data.step ?? null
  }
  if (typeof onChange === 'function') onChange()
}

function normalizeStatus(raw) {
  if (raw === 'completed') return 'completed'
  if (raw === 'in_progress') return 'in_progress'
  return 'pending'
}

function readSession(ctx, session) {
  const values = (() => {
    try {
      const snapshot = ctx.sessionProjections.snapshot(session)
      return snapshot && snapshot.values ? snapshot.values : {}
    } catch {
      return {}
    }
  })()

  const todos = Array.isArray(values.todos) ? values.todos : null
  const steps = todos === null
    ? []
    : todos.slice(0, MAX_STEPS).map((todo) => ({
      text: String((todo && todo.content) || ''),
      status: normalizeStatus(todo && todo.status),
    }))

  const total = steps.length
  const completed = steps.filter((step) => step.status === 'completed').length
  const currentIndex = steps.findIndex((step) => step.status === 'in_progress')
  const nextIndex = steps.findIndex((step) => step.status === 'pending')
  const state = activity.get(session) || null
  const running = state !== null && state.running
  const allDone = total > 0 && completed === total
  const title = typeof values.title === 'string' && values.title.trim() !== '' ? values.title.trim() : null

  let status
  if (allDone) status = 'done'
  else if (todos === null || total === 0) status = running ? 'noplan' : 'noplan'
  else if (running) status = 'charging'
  else status = 'waiting'

  const currentStep = currentIndex >= 0
    ? steps[currentIndex]
    : (nextIndex >= 0 ? steps[nextIndex] : null)

  const lastAt = state === null ? 0 : state.at
  const elapsedMs = running
    ? Math.max(0, Date.now() - state.turnStartedAt)
    : (state !== null && state.turnEndedAt > 0 && state.turnStartedAt > 0
      ? Math.max(0, state.turnEndedAt - state.turnStartedAt)
      : 0)

  return {
    sessionId: typeof session.id === 'string' ? session.id : String(session.id ?? ''),
    title,
    status,
    steps,
    total,
    completed,
    percent: total === 0 ? null : Math.round((completed / total) * 100),
    currentStep: currentStep ? currentStep.text : null,
    running,
    turn: state === null ? null : state.turn,
    step: state === null ? null : state.step,
    lastAt,
    elapsedMs,
    lastEvent: state === null ? null : state.lastType,
  }
}

function buildState(ctx) {
  const sessions = (() => {
    try {
      const list = ctx.sessions.list()
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  })()

  const views = []
  for (const session of sessions) {
    try {
      views.push(readSession(ctx, session))
    } catch {
      // A session that cannot be folded never blocks the rest.
    }
  }

  // Active session: a running turn wins; otherwise the most recently active
  // session that actually carries a task (todos or a running turn).
  const rank = (view) => (view.running ? 1 : 0)
  views.sort((a, b) => {
    const byRun = rank(b) - rank(a)
    if (byRun !== 0) return byRun
    if (b.lastAt !== a.lastAt) return b.lastAt - a.lastAt
    return 0
  })

    // A finished plan from a long time ago is not worth a HUD on boot; keep the
  // window short so yesterday's tasks do not reappear.
  const fresh = Date.now() - STALE_MS
  const active = views.find((view) => view.running || (view.total > 0 && view.lastAt >= fresh)) || null

  return {
    ok: true,
    plugin: name,
    now: Date.now(),
    active,
    sessions: views.slice(0, 8).map((view) => ({
      sessionId: view.sessionId,
      title: view.title,
      status: view.status,
      total: view.total,
      completed: view.completed,
      running: view.running,
      lastAt: view.lastAt,
    })),
  }
}


function ensureHudDir() {
  try {
    mkdirSync(HUD_DIR, { recursive: true })
  } catch {
    /* the overlay simply stays off if the directory cannot be created */
  }
}

function overlayAlive() {
  try {
    if (Date.now() - statSync(HEARTBEAT_FILE).mtimeMs < HEARTBEAT_FRESH_MS) return true
  } catch {
    /* no heartbeat yet */
  }
  return false
}

function writeSnapshot(ctx) {
  ensureHudDir()
  const state = buildState(ctx)
  const payload = {
    ok: true,
    plugin: name,
    now: Date.now(),
    overlayAlive: overlayAlive(),
    active: state.active,
  }
  try {
    const tmp = STATE_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, STATE_FILE)
  } catch {
    /* a failed snapshot write must never disturb the session */
  }
}

function snapshotNow(ctx) {
  try {
    writeSnapshot(ctx)
  } catch {
    /* ignored */
  }
}

function debounce(fn, ms) {
  let timer = null
  return () => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      try {
        fn()
      } catch {
        /* ignored */
      }
    }, ms)
    timer.unref?.()
  }
}

/** The single overlay process this Host owns (spawned on demand, watched). */
let overlayChild = null

function startOverlay() {
  if (process.platform !== 'win32') return null
  if (process.env.DSH_HUD_OVERLAY === '0') return null
  if (!existsSync(OVERLAY_SCRIPT)) {
    logSpawn(`overlay script missing: ${OVERLAY_SCRIPT}`)
    return null
  }
  ensureHudDir()
  const exe = powershellPath()
  let child
  try {
    child = spawn(
      exe,
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', OVERLAY_SCRIPT, '-ParentPid', String(process.pid)],
      { windowsHide: true, stdio: 'ignore' },
    )
  } catch (error) {
    logSpawn(`spawn threw: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  logSpawn(`spawned overlay pid=${child.pid} exe=${exe}`)
  child.on('error', (error) => {
    logSpawn(`spawn error: ${error instanceof Error ? error.message : String(error)}`)
  })
  child.on('exit', (code, signal) => {
    logSpawn(`overlay exited code=${code} signal=${signal}`)
    if (overlayChild === child) overlayChild = null
  })
  child.unref()
  overlayChild = child
  return child
}

/** Keep exactly one overlay alive; called at startup and every few seconds. */
function ensureOverlay() {
  if (process.platform !== 'win32') return
  if (process.env.DSH_HUD_OVERLAY === '0') return
  if (overlayAlive()) return
  if (overlayChild !== null && overlayChild.exitCode === null && !overlayChild.killed) {
    /* process exists but heartbeat is stale: wait one more cycle */
    return
  }
  logSpawn(`starting overlay (alive=${overlayAlive()})`)
  startOverlay()
}

export function apply(ctx) {
  ensureHudDir()
  const snapshot = debounce(() => writeSnapshot(ctx), 200)

  // Fold lifecycle events as they are committed; the projection snapshot
  // already carries the todo list, this only adds "is a turn running" and
  // timing. Each event also refreshes the snapshot the overlay window reads.
  ctx.on('session/event', (session, event) => {
    feed(session, event, snapshot)
  })
  ctx.on('session/created', (session) => {
    ensure(session)
  })

  // The detached overlay window is a separate Win32/WPF process: a browser
  // overlay cannot stay above the desktop once the app is minimized.
  ensureOverlay()
  const watchdog = setInterval(() => ensureOverlay(), 15000)
  watchdog.unref?.()
  ctx.effect(() => () => {
    clearInterval(watchdog)
    if (overlayChild !== null) {
      try {
        overlayChild.kill()
      } catch {
        /* already gone */
      }
      overlayChild = null
    }
  }, 'dsh-hud: overlay window')

  // Publish a startup snapshot so a stale file from a previous run can never
  // resurface on the desktop overlay before the first session event.
  snapshotNow(ctx)

}

/** Test seam for the folding logic; not part of the plugin surface. */
export const __internals = { feed, buildState, readSession }
