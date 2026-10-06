// dsh-bridge/broker.mjs
//
// The bridge broker: pairs one Codex session with one DeepSeek Harness session
// and relays turns in both directions.
//
//   Codex  ->  DSH   : dsh.prompt() posts into the target session's Agent inbox
//                      over DSH's own /api/session/prompt endpoint.
//   DSH    ->  Codex : the broker watches the DSH session log, cuts replies at
//                      turn boundaries, and delivers them with `codex queue`.
//
// The broker is deliberately a plain local process with a file-backed state file
// and a loopback HTTP API, so either side can drive it and nothing leaks off the
// machine.
//
// CLI:
//   node broker.mjs init <pairId> --dsh <sessionId> --codex <threadId> [--auto-forward]
//   node broker.mjs list
//   node broker.mjs send <pairId> <text...>          # deliver into the DSH session
//   node broker.mjs to-codex <pairId> <text...>      # deliver into the Codex thread
//   node broker.mjs tick                             # one relay pass
//   node broker.mjs serve [--port 8791] [--log FILE] # HTTP API + polling loop
//
// A detached broker appends its own log with `--log` instead of relying on shell
// redirection: `Start-Process -RedirectStandardOutput` blocks until the child
// exits, which would hang any launcher that tries to background the broker.

import { createServer } from 'node:http'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { listCodexSessions, listDshSessions, resolveExactSession } from '../src/adapters.mjs'
import { DshClient } from '../src/client.mjs'
import { queueToCodex, readSessionIndex, findThreads } from '../src/codex.mjs'
import { extractCompletedTurns, needsConfirmation, turnsAfter } from '../src/extract.mjs'
import { findSessionLog, readSessionEvents } from '../src/session-log.mjs'
import { createTaskService } from '../src/tasks.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_STATE = join(HERE, '..', 'state.json')
const DEFAULT_DHS_CWD = process.cwd()

/**
 * Build a logger that writes to stdout and, when given, appends to a file.
 *
 * @param {string | undefined} file - log file path; omitted means stdout only.
 * @returns {(message: string) => void} the log sink.
 */
function createLogger(file) {
  if (file === undefined) return (message) => console.log(message)
  return (message) => {
    const line = `[${new Date().toISOString()}] ${message}\n`
    process.stdout.write(line)
    try {
      appendFileSync(file, line, 'utf8')
    } catch {
      // Logging must never take the relay down.
    }
  }
}

/** Read the broker state, creating an empty one when the file is absent. */
export function loadState(path = DEFAULT_STATE) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return {
      version: parsed.version ?? 1,
      pairs: parsed.pairs ?? {},
      messages: parsed.messages ?? [],
      forwarded: parsed.forwarded ?? [],
      // v2 additions: structured envelopes and task records.
      messages_v2: parsed.messages_v2 ?? [],
      tasks: parsed.tasks ?? {}
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return { version: 1, pairs: {}, messages: [], forwarded: [], messages_v2: [], tasks: {} }
  }
}

/**
 * Build the durable deduplication key for one forwarded reply.
 *
 * The `lastTurn` cursor alone only proves "we believe we already sent up to turn
 * N". A rewind (a retry, a restored state file, an operator restarting a pair to
 * replay history) makes that belief wrong and re-sends turns the peer already
 * processed. The key names the exact message a peer saw — pair, DSH session, and
 * turn — so a pass can skip a turn it has already delivered no matter what the
 * cursor says.
 *
 * @param {object} pair - the registered pair.
 * @param {number} turn - DSH turn number.
 * @returns {string} the deduplication key.
 */
export function forwardKey(pair, turn) {
  return `${pair.id}|${pair.dshSessionId}|${turn}`
}

/** Persist the broker state atomically so a crash cannot truncate it. */
export function saveState(state, path = DEFAULT_STATE) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

/**
 * Run one operation while holding a cross-process lock on the state file.
 *
 * Why this is required: `state.json` is read once into memory per process, and
 * each process writes its whole in-memory copy back. With two writers — the
 * long-running `serve` loop and any one-shot `tick`, `/to-codex`, or `send`
 * command against the same file — a stale copy wins the last write and
 * resurrects an older `lastTurn`. The relay then re-sends turns the peer already
 * received, which is exactly the duplicate Codex reported.
 *
 * The lock is a `wx`-created sibling holding the holder's pid, so a lock left by
 * a dead process is taken over instead of blocking forever.
 *
 * @param {string} statePath - the state file the lock protects.
 * @param {() => Promise<T>} operation - work to run under the lock.
 * @param {object} [options]
 * @param {number} [options.waitMs] - how long to wait for the lock.
 * @returns {Promise<T>} the operation's result.
 * @template T
 */
export async function withStateLock(statePath, operation, options = {}) {
  const lockPath = `${statePath}.lock`
  const deadline = Date.now() + (options.waitMs ?? 10_000)
  let delay = 25

  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' })
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // Take over a lock whose holder is gone.
      if (holderExited(lockPath)) {
        try {
          rmSync(lockPath, { force: true })
        } catch {
          // Another contender won the race; fall through to waiting.
        }
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for the state lock at ${lockPath}`)
      }
      await new Promise((resolve) => setTimeout(resolve, delay))
      delay = Math.min(delay * 2, 250)
    }
  }

  try {
    return await operation()
  } finally {
    try {
      rmSync(lockPath, { force: true })
    } catch {
      // Releasing a lock that is already gone is not an error.
    }
  }
}

/**
 * Whether the recorded lock holder no longer exists.
 *
 * @param {string} lockPath - the lock file.
 * @returns {boolean} true when the lock can be taken over.
 */
function holderExited(lockPath) {
  let record
  try {
    record = readFileSync(lockPath, 'utf8')
  } catch {
    return false
  }
  if (!/^\d+\n?$/u.test(record)) return false
  const pid = Number(record.trim())
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

/**
 * Relay every new completed DSH turn to its paired Codex thread.
 *
 * Idempotency comes from `pair.lastTurn`: each reply is forwarded at most once,
 * even across broker restarts, because the cursor is persisted with the state.
 *
 * Concurrency is handled in two layers:
 *
 *  - In-process: the polling loop and an operator-triggered `/tick` can fire at
 *    the same instant. Both would read the same `lastTurn` and forward the same
 *    turn twice. Every call therefore runs inside one in-process queue.
 *  - Cross-process: a one-shot CLI command (`tick`, `send`, `to-codex`) mutates
 *    the same state file. A stale in-memory copy written back would resurrect an
 *    older cursor, so each such command runs under {@link withStateLock} and the
 *    long-running server re-reads the file before every pass.
 *
 * @param {object} args
 * @param {object} args.state - mutable broker state.
 * @param {DshClient} args.dsh - DSH client.
 * @param {object} [args.log] - sink for progress lines.
 * @param {string} [args.home] - DSH home override; defaults to `$DSH_HOME`.
 * @returns {Promise<{forwarded: number, checked: number}>} relay summary.
 */
export function relayDshToCodex(args) {
  // Serialize passes: chain each call onto the previous one.
  const run = relayTail.then(
    () => relayPass(args),
    () => relayPass(args)
  )
  // Keep the chain alive but never leave an unhandled rejection behind.
  relayTail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** Tail of the relay serialization chain; see {@link relayDshToCodex}. */
let relayTail = Promise.resolve()

/**
 * One relay pass. Callers must go through {@link relayDshToCodex} so passes
 * cannot overlap.
 *
 * @param {object} args - see {@link relayDshToCodex}.
 * @returns {Promise<{forwarded: number, checked: number}>} relay summary.
 */
async function relayPass({ state, dsh, log = console.log, home }) {
  let forwarded = 0
  let checked = 0

  for (const pair of Object.values(state.pairs)) {
    if (pair.autoForward !== true) continue
    checked += 1
    let events
    try {
      const logPath = findSessionLog(home, pair.dshCwd ?? DEFAULT_DHS_CWD, pair.dshSessionId)
      events = readSessionEvents(logPath)
    } catch (error) {
      log(`[relay] ${pair.id}: cannot read DSH log: ${error.message}`)
      continue
    }

    const turns = extractCompletedTurns(events)
    const pending = turnsAfter(turns, pair.lastTurn ?? 0)
    const delivered = new Set(state.forwarded ?? [])
    for (const turn of pending) {
      // Advance the cursor even for a skipped turn: it is already delivered.
      pair.lastTurn = Math.max(pair.lastTurn ?? 0, turn.turn)
      const key = forwardKey(pair, turn.turn)
      if (delivered.has(key)) {
        log(`[relay] ${pair.id}: turn ${turn.turn} already delivered (${key}); skipped`)
        continue
      }
      const header = needsConfirmation(turn.text)
        ? '【DSH 需要你确认】'
        : '【DSH 执行结果】'
      const message = `${header} (${pair.dshSessionId} turn ${turn.turn})\n\n${turn.text}`
      try {
        const receipt = await queueToCodex({ thread: pair.codexThread, message })
        forwarded += 1
        // Record the delivery key so a later rewind cannot resend this turn.
        state.forwarded = [...(state.forwarded ?? []), key]
        state.messages.push({
          at: Date.now(),
          pairId: pair.id,
          direction: 'dsh->codex',
          dshTurn: turn.turn,
          codexMessageId: receipt.messageId,
          needsConfirmation: needsConfirmation(turn.text)
        })
        log(`[relay] ${pair.id}: forwarded DSH turn ${turn.turn} to Codex ${receipt.messageId ?? '(no id)'}`)
      } catch (error) {
        // Rewind the cursor so the reply is retried on the next pass.
        pair.lastTurn = turn.turn - 1
        log(`[relay] ${pair.id}: codex queue failed: ${error.message}`)
        break
      }
    }
  }

  return { forwarded, checked }
}

/**
 * Announce this broker so other components can find it without environment setup.
 *
 * Both the DSH plugin and the web console need two facts that are otherwise
 * invisible from outside this process: which port the broker serves, and where its
 * state file lives. Writing them to `$DSH_HOME/dsh-bridge.json` means a plugin can
 * discover a broker that was started from any directory, with any `--state`, and
 * with no environment variables configured.
 *
 * @param {object} args
 * @param {string} args.brokerUrl - loopback URL this broker serves.
 * @param {string} args.statePath - the state file in use.
 * @param {(message: string) => void} args.log - progress sink.
 */
function announceBroker({ brokerUrl, statePath, log }) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const file = join(home, 'dsh-bridge.json')
  const payload = {
    version: 1,
    brokerUrl,
    stateFile: statePath,
    pid: process.pid,
    updatedAt: new Date().toISOString()
  }
  try {
    mkdirSync(home, { recursive: true })
    const temp = `${file}.tmp`
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(temp, file)
    log(`[broker] discovery file: ${file}`)
  } catch (error) {
    // Discovery is a convenience; failing to write it must not stop the broker.
    log(`[broker] could not write discovery file ${file}: ${error.message}`)
  }
}

/**
 * Relay only task-correlated DSH replies (bridge v2).
 *
 * Contrast with {@link relayDshToCodex}: that one forwards every completed turn
 * of a pair that opted into `autoForward`, which is what produced the earlier
 * flood of repeated whole-turn reports. This one forwards a turn only when it
 * answers a task the Codex side opened, so process narration stays out of the
 * peer's conversation.
 *
 * @param {object} args
 * @param {string} args.state - the freshly loaded state.
 * @param {object} args.dsh - DSH client.
 * @param {object} args.tasks - the task service.
 * @param {(message: string) => void} args.log - progress sink.
 * @returns {Promise<{forwarded: number, skipped: number}>} relay summary.
 */
async function relayTaskRepliesV2({ state, dsh, tasks, log }) {
  const openTasks = Object.values(state.tasks ?? {}).filter((task) => task.status === 'open')
  if (openTasks.length === 0) return { forwarded: 0, skipped: 0 }

  let forwarded = 0
  let skipped = 0

  for (const task of openTasks) {
    const pair = state.pairs[task.pairId]
    if (pair === undefined) continue
    let turns
    try {
      turns = extractCompletedTurns(readSessionEvents(findSessionLog(undefined, pair.dshCwd, pair.dshSessionId)))
    } catch (error) {
      log(`[task] ${task.taskId}: cannot read DSH log: ${error.message}`)
      continue
    }

    // Only turns that completed after the task was delivered can answer it.
    const afterTask = turns.filter((turn) => turn.turn > (task.requestTurn ?? 0))
    const result = await tasks.relayReplies({ task, turns: afterTask })
    for (const entry of result.forwarded) {
      forwarded += 1
      log(`[task] ${task.taskId}: DSH turn ${entry.turn} forwarded as ${entry.messageId} (state ${entry.state})`)
    }
    skipped += result.skipped.length
  }

  return { forwarded, skipped }
}

/** Build the loopback HTTP API. */
function createBrokerServer({ statePath, dsh, log, tasks }) {
  /**
   * Run one read-modify-write cycle over the latest on-disk state under the
   * cross-process lock, committing only when the operation reports success.
   *
   * @param {(state: object) => Promise<boolean>} operation - returns true to commit.
   * @returns {Promise<object>} the committed (or merely read) state.
   */
  const cycle = async (operation) => {
    let committed
    await withStateLock(statePath, async () => {
      const fresh = loadState(statePath)
      committed = (await operation(fresh)) ? fresh : undefined
      if (committed !== undefined) saveState(fresh, statePath)
    })
    return committed
  }

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const send = (status, body) => {
      const text = JSON.stringify(body)
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(text)
    }
    const readBody = async () => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }

    try {
      if (request.method === 'GET' && url.pathname === '/status') {
        const state = loadState(statePath)
        send(200, {
          ok: true,
          pairs: Object.values(state.pairs).map((pair) => ({
            id: pair.id,
            dshSessionId: pair.dshSessionId,
            dshCwd: pair.dshCwd,
            codexThread: pair.codexThread,
            codexThreadName: pair.codexThreadName,
            autoForward: pair.autoForward,
            lastTurn: pair.lastTurn
          })),
          messages: state.messages.length,
          forwarded: (state.forwarded ?? []).length
        })
        return
      }

      // Deliver a message into the paired DSH session. This is the endpoint a
      // Codex-side tool or hook calls to hand work to DeepSeek Harness.
      if (request.method === 'POST' && url.pathname === '/to-dsh') {
        const body = await readBody()
        if (typeof body.text !== 'string' || body.text.trim() === '') {
          return send(400, { ok: false, error: 'text is required' })
        }
        const target = loadState(statePath).pairs[body.pairId]
        if (!target) return send(404, { ok: false, error: `unknown pair ${body.pairId}` })
        const receipt = await dsh.prompt({
          sessionId: target.dshSessionId,
          text: body.text,
          mode: body.mode === 'steer' ? 'steer' : 'queue'
        })
        await cycle(async (state) => {
          state.messages.push({ at: Date.now(), pairId: target.id, direction: 'codex->dsh', text: body.text })
          return true
        })
        send(200, { ok: true, receipt })
        return
      }

      // Deliver a message into the paired Codex thread.
      if (request.method === 'POST' && url.pathname === '/to-codex') {
        const body = await readBody()
        if (typeof body.text !== 'string' || body.text.trim() === '') {
          return send(400, { ok: false, error: 'text is required' })
        }
        const target = loadState(statePath).pairs[body.pairId]
        if (!target) return send(404, { ok: false, error: `unknown pair ${body.pairId}` })
        const receipt = await queueToCodex({ thread: target.codexThread, message: body.text })
        await cycle(async (state) => {
          state.messages.push({
            at: Date.now(),
            pairId: target.id,
            direction: 'dsh->codex',
            codexMessageId: receipt.messageId,
            text: body.text
          })
          return true
        })
        send(200, { ok: true, receipt })
        return
      }

      if (request.method === 'POST' && url.pathname === '/tick') {
        let summary
        await cycle(async (state) => {
          summary = await relayDshToCodex({ state, dsh, log })
          return true
        })
        send(200, { ok: true, ...summary })
        return
      }

      // ---- v2: explicit session discovery, binding, and task delivery ----

      if (request.method === 'GET' && url.pathname === '/sessions') {
        const side = url.searchParams.get('side') ?? 'both'
        const filter = url.searchParams.get('filter') ?? undefined
        const body = { ok: true }
        if (side === 'codex' || side === 'both') body.codex = await listCodexSessions({ filter: filter ?? undefined })
        if (side === 'dsh' || side === 'both') body.dsh = await listDshSessions(dsh, { filter: filter ?? undefined })
        send(200, body)
        return
      }

      if (request.method === 'POST' && url.pathname === '/bind') {
        const body = await readBody()
        if (typeof body.pairId !== 'string' || typeof body.codex !== 'string' || typeof body.dsh !== 'string') {
          return send(400, { ok: false, error: 'pairId, codex (exact id), and dsh (exact id) are required' })
        }
        const codexResolved = await resolveExactSession('codex', body.codex, { dsh })
        if (!codexResolved.ok) return send(400, { ok: false, error: codexResolved.error, candidates: codexResolved.candidates })
        const dshResolved = await resolveExactSession('dsh', body.dsh, { dsh })
        if (!dshResolved.ok) return send(400, { ok: false, error: dshResolved.error, candidates: dshResolved.candidates })
        let bound
        await cycle(async (state) => {
          const pairId = body.pairId
          const existing = state.pairs[pairId]
          state.pairs[pairId] = {
            id: pairId,
            dshSessionId: dshResolved.session.id,
            dshCwd: dshResolved.session.workspace === 'unknown' ? process.cwd() : dshResolved.session.workspace,
            codexThread: codexResolved.session.id,
            codexThreadName: codexResolved.session.title,
            autoForward: false,
            legacyAutoForward: false,
            lastTurn: existing?.lastTurn ?? 0,
            createdAt: existing?.createdAt ?? Date.now()
          }
          bound = state.pairs[pairId]
          return true
        })
        send(200, { ok: true, pair: bound })
        return
      }

      if (request.method === 'POST' && url.pathname === '/send-task') {
        const body = await readBody()
        if (typeof body.pairId !== 'string') return send(400, { ok: false, error: 'pairId is required' })
        const text = typeof body.text === 'string' ? body.text : undefined
        if (text === undefined || text.trim() === '') {
          return send(400, { ok: false, error: 'text is required (send the full body in the JSON field; there is no command-line ceiling here)' })
        }
        const result = await tasks.sendTaskToDsh({ pairId: body.pairId, text, taskId: body.taskId, mode: body.mode })
        if (!result.ok) return send(400, { ok: false, error: result.error })
        send(200, { ok: true, ...result })
        return
      }

      if (request.method === 'GET' && url.pathname === '/tasks') {
        const state = loadState(statePath)
        send(200, { ok: true, tasks: Object.values(state.tasks ?? {}), messages: state.messages_v2 ?? [] })
        return
      }

      if (request.method === 'POST' && url.pathname === '/reconcile') {
        const result = await tasks.reconcile()
        send(200, { ok: true, ...result })
        return
      }

      if (request.method === 'POST' && url.pathname === '/confirm') {
        let body = {}
        try {
          body = await readBody()
        } catch {
          // An empty body means "confirm everything currently delivered".
        }
        const result = await tasks.confirmCompletion({ messageId: body.messageId })
        send(200, { ok: true, ...result })
        return
      }

      send(404, { ok: false, error: `no route ${request.method} ${url.pathname}` })
    } catch (error) {
      send(500, { ok: false, error: String(error?.message ?? error) })
    }
  })
}

/**
 * Register one Codex <-> DSH pair.
 *
 * History policy: a NEW pair starts with its cursor at the DSH session's latest
 * completed turn, so enabling auto-forward does not dump the session's entire
 * backlog into the Codex conversation. Pass `replay: true` to start from turn 0
 * and forward history from the beginning. An existing pair keeps its cursor.
 *
 * @param {object} state - mutable broker state.
 * @param {object} args - pair identity, forwarding policy, and replay choice.
 * @returns {Promise<object>} the registered pair.
 */
async function initPair(state, { pairId, dshSessionId, codexThread, dshCwd, autoForward, replay }) {
  const threads = findThreads(codexThread)
  const threadName = threads.find((row) => row.id === codexThread)?.thread_name
  const existing = state.pairs[pairId]
  const cwd = dshCwd ?? DEFAULT_DHS_CWD

  let lastTurn
  if (existing !== undefined) {
    lastTurn = existing.lastTurn ?? 0
  } else if (replay === true) {
    lastTurn = 0
  } else {
    lastTurn = await latestCompletedTurn(cwd, dshSessionId)
  }

  state.pairs[pairId] = {
    id: pairId,
    dshSessionId,
    dshCwd: cwd,
    codexThread,
    ...threadName === undefined ? {} : { codexThreadName: threadName },
    autoForward: autoForward === true,
    lastTurn,
    createdAt: existing?.createdAt ?? Date.now()
  }
  return state.pairs[pairId]
}

/**
 * Read the highest completed turn number in a DSH session's log.
 *
 * Used as a new pair's starting cursor. A log that cannot be read yields 0,
 * which makes the pair forward nothing until the session completes a new turn —
 * the safe direction, since it can only under-send, never duplicate.
 *
 * @param {string} cwd - the session's workspace path.
 * @param {string} sessionId - DSH session id.
 * @returns {Promise<number>} the latest completed turn number, or 0.
 */
async function latestCompletedTurn(cwd, sessionId) {
  try {
    const logPath = findSessionLog(undefined, cwd, sessionId)
    const turns = extractCompletedTurns(readSessionEvents(logPath))
    return turns.length === 0 ? 0 : turns[turns.length - 1].turn
  } catch {
    return 0
  }
}

/**
 * Read a message body from stdin, a UTF-8 file, or literal arguments.
 *
 * The file and stdin paths exist because a long body must never be truncated by
 * a shell or a platform command-line limit; the literal path stays for short text.
 *
 * @param {object} args
 * @param {object} args.flags - parsed flags; supports `--body-file` and `--stdin`.
 * @param {string[]} args.positional - literal words.
 * @returns {Promise<string>} the full body text.
 */
async function readTextInput({ flags, positional }) {
  if (typeof flags['body-file'] === 'string') {
    const { readFile } = await import('node:fs/promises')
    return readFile(flags['body-file'], 'utf8')
  }
  if (flags.stdin === true || flags['body-stdin'] === true) {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
  }
  return positional.join(' ')
}

/** Parse `--flag value` and `--flag` style arguments. */
function parseFlags(argv) {
  const flags = {}
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true
    } else {
      flags[key] = next
      index += 1
    }
  }
  return { flags, positional }
}

async function main() {
  const [, , command, ...rest] = process.argv
  const statePath = process.env.DSH_BRIDGE_STATE ?? DEFAULT_STATE
  const dsh = new DshClient()

  /**
   * Load the latest on-disk state, apply one mutation under the cross-process
   * lock, and commit. Reading inside the lock is what stops a stale in-memory
   * copy from resurrecting an older cursor and re-sending delivered turns.
   *
   * @param {(state: object) => Promise<unknown> | unknown} operation - the mutation.
   * @returns {Promise<void>} resolves after the state is committed.
   */
  const mutate = async (operation) => {
    await withStateLock(statePath, async () => {
      const fresh = loadState(statePath)
      await operation(fresh)
      saveState(fresh, statePath)
    })
  }

  const state = () => loadState(statePath)

  /** v2 task service, sharing the same state file, lock, and commit path. */
  const tasks = createTaskService({
    statePath,
    load: state,
    save: (fresh) => saveState(fresh, statePath),
    mutate,
    dsh,
    queueToCodex
  })

  switch (command) {
    case 'init': {
      const { flags, positional } = parseFlags(rest)
      const pairId = positional[0]
      if (!pairId || !flags.dsh || !flags.codex) {
        console.error('usage: broker.mjs init <pairId> --dsh <sessionId> --codex <threadId> [--cwd DIR] [--auto-forward] [--replay]')
        process.exitCode = 2
        return
      }
      let registered
      await mutate(async (fresh) => {
        registered = await initPair(fresh, {
          pairId,
          dshSessionId: flags.dsh,
          codexThread: flags.codex,
          dshCwd: typeof flags.cwd === 'string' ? flags.cwd : undefined,
          autoForward: flags['auto-forward'] === true,
          replay: flags.replay === true
        })
      })
      console.log('pair registered:', JSON.stringify(registered, null, 2))
      return
    }

    case 'list': {
      const pairs = Object.values(state().pairs)
      if (pairs.length === 0) console.log('(no pairs)')
      for (const pair of pairs) {
        console.log(
          [
            pair.id,
            `dsh=${pair.dshSessionId}`,
            `codex=${pair.codexThread}`,
            pair.codexThreadName === undefined ? '' : `"${pair.codexThreadName}"`,
            `autoForward=${String(pair.autoForward)}`,
            `lastTurn=${String(pair.lastTurn ?? 0)}`
          ].join(' | ')
        )
      }
      return
    }

    case 'threads': {
      const { positional } = parseFlags(rest)
      const rows = positional[0] ? findThreads(positional[0]) : readSessionIndex()
      for (const row of rows) console.log(`${row.id} | ${row.thread_name ?? ''} | ${row.updated_at ?? ''}`)
      return
    }

    case 'send': {
      const [pairId, ...words] = rest
      const text = words.join(' ')
      let receipt
      await mutate(async (fresh) => {
        const pair = fresh.pairs[pairId]
        if (!pair) throw new Error(`unknown pair ${pairId}`)
        receipt = await dsh.prompt({ sessionId: pair.dshSessionId, text, mode: 'queue' })
        fresh.messages.push({ at: Date.now(), pairId, direction: 'codex->dsh', text })
      })
      console.log('DELIVERED', JSON.stringify(receipt))
      return
    }

    case 'to-codex': {
      const [pairId, ...words] = rest
      let receipt
      await mutate(async (fresh) => {
        const pair = fresh.pairs[pairId]
        if (!pair) throw new Error(`unknown pair ${pairId}`)
        receipt = await queueToCodex({ thread: pair.codexThread, message: words.join(' ') })
        fresh.messages.push({ at: Date.now(), pairId, direction: 'dsh->codex', codexMessageId: receipt.messageId })
      })
      console.log('QUEUED', JSON.stringify(receipt))
      return
    }

    case 'tick': {
      let summary
      await mutate(async (fresh) => {
        summary = await relayDshToCodex({ state: fresh, dsh })
      })
      console.log('tick:', JSON.stringify(summary))
      return
    }

    case 'backfill': {
      // Turns delivered before deduplication existed have a message record but
      // no delivery key, so a cursor rewind could still re-send them. Rebuild
      // the key set from the recorded message history.
      let added = 0
      let total = 0
      await mutate(async (fresh) => {
        const keys = new Set(fresh.forwarded ?? [])
        for (const message of fresh.messages) {
          if (message.direction !== 'dsh->codex' || message.dshTurn === undefined) continue
          const pair = fresh.pairs[message.pairId]
          if (pair === undefined) continue
          const key = forwardKey(pair, message.dshTurn)
          if (!keys.has(key)) {
            keys.add(key)
            added += 1
          }
        }
        fresh.forwarded = [...keys]
        total = keys.size
      })
      console.log(`backfill: added ${added} delivery key(s); ${total} total`)
      return
    }

    case 'sessions': {
      const { flags, positional } = parseFlags(rest)
      const side = positional[0] ?? 'both'
      const filter = typeof flags.filter === 'string' ? flags.filter : undefined
      if (side !== 'both' && side !== 'codex' && side !== 'dsh') {
        console.error('usage: broker.mjs sessions [codex|dsh|both] [--filter TEXT]')
        process.exitCode = 2
        return
      }
      if (side === 'codex' || side === 'both') {
        const result = await listCodexSessions({ filter })
        console.log(`# codex (source: ${result.source}${result.warning === undefined ? '' : `, warning: ${result.warning}`})`)
        for (const session of result.sessions) {
          console.log(
            `  ${session.id} | ${session.title.slice(0, 40) || '(no title)'} | ws=${session.workspace} | archived=${String(session.archived)} | running=${String(session.running)} | ${session.updatedAt}`
          )
        }
      }
      if (side === 'dsh' || side === 'both') {
        const result = await listDshSessions(dsh, { filter })
        console.log(`# dsh (source: ${result.source}${result.warning === undefined ? '' : `, warning: ${result.warning}`})`)
        for (const session of result.sessions) {
          console.log(
            `  ${session.id} | [${session.kind}] bindable=${String(session.bindable)} | running=${String(session.running)} | ws=${session.workspace} | ${session.title.slice(0, 40) || '(no title)'}`
          )
        }
      }
      return
    }

    case 'bind': {
      const { flags, positional } = parseFlags(rest)
      const pairId = positional[0]
      if (!pairId || typeof flags.codex !== 'string' || typeof flags.dsh !== 'string') {
        console.error('usage: broker.mjs bind <pairId> --codex <exactId> --dsh <exactId> [--note TEXT]')
        process.exitCode = 2
        return
      }
      // Exact-id resolution on both sides. A fuzzy title match is never accepted,
      // and a non-bindable (subagent) DSH session is rejected.
      const codexResolved = await resolveExactSession('codex', flags.codex, { dsh })
      if (!codexResolved.ok) {
        console.error(`bind refused: ${codexResolved.error}`)
        if (codexResolved.candidates !== undefined) {
          console.error('did you mean:')
          for (const candidate of codexResolved.candidates) console.error(`  ${candidate.id} | ${candidate.title}`)
        }
        process.exitCode = 1
        return
      }
      const dshResolved = await resolveExactSession('dsh', flags.dsh, { dsh })
      if (!dshResolved.ok) {
        console.error(`bind refused: ${dshResolved.error}`)
        if (dshResolved.candidates !== undefined) {
          console.error('did you mean:')
          for (const candidate of dshResolved.candidates) console.error(`  ${candidate.id} | ${candidate.title}`)
        }
        process.exitCode = 1
        return
      }
      let bound
      await mutate((fresh) => {
        const existing = fresh.pairs[pairId]
        fresh.pairs[pairId] = {
          id: pairId,
          dshSessionId: dshResolved.session.id,
          dshCwd: dshResolved.session.workspace === 'unknown' ? DEFAULT_DHS_CWD : dshResolved.session.workspace,
          codexThread: codexResolved.session.id,
          codexThreadName: codexResolved.session.title,
          // v1 blanket forwarding stays off; v2 forwards task-correlated replies only.
          autoForward: false,
          legacyAutoForward: false,
          lastTurn: existing?.lastTurn ?? 0,
          createdAt: existing?.createdAt ?? Date.now(),
          ...typeof flags.note === 'string' ? { note: flags.note } : {}
        }
        bound = fresh.pairs[pairId]
      })
      console.log('pair bound (exact-id verified on both sides):')
      console.log(JSON.stringify(bound, null, 2))
      return
    }

    case 'send-task': {
      const { flags, positional } = parseFlags(rest)
      const pairId = positional[0]
      if (!pairId) {
        console.error('usage: broker.mjs send-task <pairId> (--body-file FILE | --stdin | <text...>) [--task-id ID] [--steer]')
        process.exitCode = 2
        return
      }
      // Long text arrives via stdin or a UTF-8 file so no shell or command-line
      // ceiling can truncate it.
      const text = await readTextInput({ flags, positional: positional.slice(1) })
      if (text.trim() === '') {
        console.error('send-task refused: empty body')
        process.exitCode = 2
        return
      }
      const result = await tasks.sendTaskToDsh({
        pairId,
        text,
        taskId: typeof flags['task-id'] === 'string' ? flags['task-id'] : undefined,
        mode: flags.steer === true ? 'steer' : 'queue'
      })
      if (!result.ok) {
        console.error(`send-task failed: ${result.error}`)
        process.exitCode = 1
        return
      }
      console.log(`TASK ${result.taskId}`)
      console.log(`  messageId: ${result.messageId}`)
      console.log(`  accepted : ${String(result.accepted)} (admitted by DSH — NOT completion)`)
      return
    }

    case 'status': {
      const { positional } = parseFlags(rest)
      const wanted = positional[0]
      const fresh = state()
      const tasks = Object.values(fresh.tasks ?? {})
      const messages = fresh.messages_v2 ?? []
      if (wanted !== undefined) {
        const task = fresh.tasks?.[wanted]
        if (task === undefined) {
          console.error(`unknown task ${wanted}`)
          process.exitCode = 1
          return
        }
        console.log(JSON.stringify({ task, messages: messages.filter((message) => message.taskId === wanted) }, null, 2))
        return
      }
      console.log(`tasks: ${tasks.length} | v2 messages: ${messages.length}`)
      for (const task of tasks) {
        console.log(
          `  ${task.taskId} | ${task.status} | pair=${task.pairId} | replyTurn=${String(task.replyTurn ?? '-')} | created=${new Date(task.createdAt).toISOString()}`
        )
      }
      const byState = new Map()
      for (const message of messages) byState.set(message.state, (byState.get(message.state) ?? 0) + 1)
      console.log(`message states: ${JSON.stringify([...byState.entries()])}`)
      return
    }

    case 'reconcile': {
      const result = await tasks.reconcile()
      console.log(`reconcile: checked ${result.checked} interrupted delivery(ies)`)
      for (const entry of result.resolved) console.log(`  resolved  ${entry.messageId} (evidence in receiver log)`)
      for (const entry of result.uncertain) console.log(`  UNCERTAIN ${entry.messageId} — ${entry.reason}`)
      if (result.uncertain.length > 0) {
        console.log('  An uncertain message may or may not have arrived; inspect the receiver before retrying.')
      }
      return
    }

    case 'confirm': {
      const { positional } = parseFlags(rest)
      const result = await tasks.confirmCompletion({ messageId: positional[0] })
      console.log(`confirm: completed ${result.completed.length}`)
      for (const id of result.completed) console.log(`  completed ${id} (consumption evidence found)`)
      for (const entry of result.stillDelivered) console.log(`  delivered-but-unproven ${entry.messageId} — ${entry.reason}`)
      return
    }

    case 'read-body': {
      const { positional } = parseFlags(rest)
      const found = tasks.readBody(positional[0])
      if (found === undefined) {
        console.error(`no message ${positional[0]}`)
        process.exitCode = 1
        return
      }
      console.log(`# message ${positional[0]} | ${found.handle.chars} chars | ${found.handle.bytes} bytes`)
      console.log(`# sha256 ${found.handle.sha256}`)
      console.log(`# integrity: ${found.verify.ok ? 'verified' : `FAILED (${found.verify.reason})`}`)
      process.stdout.write(found.text)
      if (!found.text.endsWith('\n')) process.stdout.write('\n')
      return
    }

    case 'serve': {
      const { flags } = parseFlags(rest)
      const port = Number(flags.port ?? 8791)
      const logFile = typeof flags.log === 'string' ? flags.log : undefined
      const log = createLogger(logFile)
      const server = createBrokerServer({ statePath, dsh, log, tasks })
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
      log(`dsh-bridge broker listening on http://127.0.0.1:${port}`)
      announceBroker({ brokerUrl: `http://127.0.0.1:${port}`, statePath, log })
      log('  GET  /status')
      log('  GET  /sessions?side=codex|dsh|both&filter=')
      log('  POST /bind        {pairId, codex, dsh}   exact ids only')
      log('  POST /send-task   {pairId, text, taskId?, mode?}')
      log('  GET  /tasks')
      log('  POST /reconcile')
      log('  POST /confirm     {messageId?}')
      log('  POST /to-dsh      {pairId, text, mode?}')
      log('  POST /to-codex    {pairId, text}')
      log('  POST /tick')

      const intervalMs = Number(flags['interval-ms'] ?? 3000)
      /**
       * One polling pass over the LATEST on-disk state.
       *
       * Re-reading inside the lock is what makes the server safe next to a
       * one-shot CLI command: a stale in-memory copy written back would
       * resurrect an older `lastTurn` and re-send delivered turns.
       */
      const pollOnce = async () => {
        await withStateLock(statePath, async () => {
          const fresh = loadState(statePath)
          // v1 blanket forwarding stays available but is off unless a pair opts in.
          await relayDshToCodex({ state: fresh, dsh, log })
          // v2: forward only replies correlated to an open task.
          await relayTaskRepliesV2({ state: fresh, dsh, tasks, log })
          saveState(fresh, statePath)
        })
      }

      // The interval is deliberately NOT unref'd: the polling loop is the
      // broker's reason to exist, so it must keep the process alive even if the
      // listening socket is the only other handle.
      setInterval(() => {
        pollOnce().catch((error) => log(`[relay] error: ${error.message}`))
      }, intervalMs)
      return
    }

    default:
      console.error('usage: broker.mjs <command> [args]')
      console.error('')
      console.error('  bridge v2 (structured tasks)')
      console.error('    sessions [codex|dsh|both] [--filter TEXT]   list sessions for explicit selection')
      console.error('    bind <pairId> --codex <exactId> --dsh <exactId>')
      console.error('    send-task <pairId> (--body-file FILE | --stdin | <text...>) [--task-id ID] [--steer]')
      console.error('    status [taskId]                            tasks and message states')
      console.error('    reconcile                                  resolve interrupted deliveries')
      console.error('    confirm [messageId]                        promote delivered -> completed on real evidence')
      console.error('    read-body <messageId>                      read a stored full body')
      console.error('')
      console.error('  bridge v1 (legacy whole-turn relay; pair must opt in)')
      console.error('    init | list | threads | send | to-codex | tick | backfill')
      console.error('')
      console.error('  server')
      console.error('    serve [--port 8791] [--interval-ms 3000] [--log FILE]')
      process.exitCode = 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
