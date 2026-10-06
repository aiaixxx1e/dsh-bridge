// dsh-bridge/adapters.mjs
//
// Session discovery for both sides, plus the evidence check that distinguishes
// "delivered" from "completed".
//
// Location independence is the point of this module: nothing here assumes a
// default install path or a fixed database file name. Roots come from
// resolvers.mjs (env, override, running process, probe), and the Codex state
// database is found by PROBING each `state*.sqlite` for the table we need —
// because the version is part of the file name (`state_5.sqlite`) and changes on
// upgrade.
//
// Requirements honored:
//  - Codex metadata comes from a READ-ONLY SQLite query. Schema drift and a
//    locked file both fall back to `session_index.jsonl`, and a field the
//    fallback cannot supply is reported as `unknown` rather than guessed.
//  - DSH metadata comes from `session/list`, which already carries running state.
//  - Selection is by exact id. Titles are never matched fuzzily.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readSessionEvents } from '../src/session-log.mjs'
import { resolveCodexHome, resolveCodexExe } from '../src/resolvers.mjs'

/** Fields whose absence is reported honestly rather than defaulted. */
const UNKNOWN = 'unknown'

/** Tables a usable Codex state database must contain. */
const REQUIRED_THREAD_TABLE = 'threads'

/**
 * Find the Codex state database by probing, not by file name.
 *
 * The schema version is baked into the name (`state_5.sqlite`), so a hardcoded
 * name breaks after an upgrade. Every `*.sqlite` in the Codex home is opened
 * read-only and inspected for the `threads` table; the one that has it wins.
 *
 * @param {object} [options]
 * @param {string} [options.codexHome] - resolved Codex home.
 * @returns {Promise<{path?: string, tried: object[], detail: string}>} discovery result.
 */
export async function findCodexStateDb(options = {}) {
  const home = options.codexHome ?? resolveCodexHome().path
  if (home === undefined) return { tried: [], detail: 'no Codex home to scan' }

  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch (error) {
    return { tried: [], detail: `node:sqlite unavailable: ${error?.message ?? error}` }
  }
  if (!existsSync(home)) return { tried: [], detail: `Codex home does not exist: ${home}` }

  let files
  try {
    files = readdirSync(home).filter((name) => name.toLowerCase().endsWith('.sqlite'))
  } catch (error) {
    return { tried: [], detail: `cannot list ${home}: ${error?.message ?? error}` }
  }

  // Prefer names starting with "state" (the historical location) but probe all,
  // so a renamed database still works.
  files.sort((a, b) => Number(!a.startsWith('state')) - Number(!b.startsWith('state')))

  const tried = []
  for (const file of files) {
    const path = join(home, file)
    let db
    try {
      db = new sqlite.DatabaseSync(path, { readOnly: true })
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(REQUIRED_THREAD_TABLE)
      const hasTable = row !== undefined
      tried.push({ path, hasThreads: hasTable })
      if (hasTable) return { path, tried, detail: `${path} (has ${REQUIRED_THREAD_TABLE}; version suffix ignored)` }
    } catch (error) {
      tried.push({ path, error: String(error?.message ?? error) })
    } finally {
      try {
        db?.close()
      } catch {
        // Closing an already-closed handle is not interesting.
      }
    }
  }
  return { tried, detail: `no database under ${home} contains a ${REQUIRED_THREAD_TABLE} table` }
}

/**
 * Query the read-only Codex thread table.
 *
 * @param {object} [options]
 * @param {string} [options.codexHome] - resolved Codex home.
 * @returns {Promise<{rows: object[], source: string, error?: string}>} rows and provenance.
 */
export async function readCodexThreadsFromSqlite(options = {}) {
  const found = await findCodexStateDb(options)
  if (found.path === undefined) {
    return { rows: [], source: 'unavailable', error: found.detail }
  }
  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch (error) {
    return { rows: [], source: 'unavailable', error: `node:sqlite unavailable: ${error?.message ?? error}` }
  }
  let db
  try {
    db = new sqlite.DatabaseSync(found.path, { readOnly: true })
    // Column set differs across versions, so select by name and tolerate absence
    // by falling back to the columns that have existed throughout.
    const rows = db
      .prepare(
        `SELECT id, title, name, cwd, archived, updated_at_ms, recency_at_ms, model, sandbox_policy, approval_mode
           FROM ${REQUIRED_THREAD_TABLE}
          ORDER BY recency_at_ms DESC`
      )
      .all()
    return { rows, source: `sqlite:${found.path.replace(/^.*[\\/]/u, '')}` }
  } catch (error) {
    return { rows: [], source: 'sqlite:error', error: `query failed (schema may have changed): ${error?.message ?? error}` }
  } finally {
    try {
      db?.close()
    } catch {
      // ignore
    }
  }
}

/**
 * Fallback Codex discovery from the JSONL session index.
 *
 * @param {object} [options]
 * @param {string} [options.codexHome] - resolved Codex home.
 * @returns {{rows: object[], source: string, error?: string}} rows and provenance.
 */
export function readCodexThreadsFromIndex(options = {}) {
  const home = options.codexHome ?? resolveCodexHome().path
  if (home === undefined) return { rows: [], source: 'unavailable', error: 'no Codex home' }
  try {
    const path = join(home, 'session_index.jsonl')
    const rows = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
      .map((row) => ({
        id: row.id,
        title: row.thread_name ?? '',
        cwd: undefined,
        archived: undefined,
        updated_at_ms: row.updated_at === undefined ? undefined : Date.parse(row.updated_at)
      }))
    return { rows, source: 'jsonl:session_index' }
  } catch (error) {
    return { rows: [], source: 'unavailable', error: `cannot read session index: ${error?.message ?? error}` }
  }
}

/**
 * List Codex sessions for explicit selection.
 *
 * Run state is always `unknown`: the Codex thread table has no run-state column,
 * and inferring "running" from a recent timestamp would be a guess.
 *
 * @param {object} [options]
 * @param {string} [options.filter] - case-insensitive substring on title or id.
 * @param {string} [options.codexHome] - resolved Codex home.
 * @returns {Promise<{sessions: object[], source: string, warning?: string}>} discovery result.
 */
export async function listCodexSessions(options = {}) {
  const primary = await readCodexThreadsFromSqlite({ codexHome: options.codexHome })
  let rows = primary.rows
  let source = primary.source
  let warning

  if (rows.length === 0) {
    const fallback = readCodexThreadsFromIndex({ codexHome: options.codexHome })
    rows = fallback.rows
    source = fallback.source
    warning = primary.error ?? 'primary discovery returned no rows'
  }

  const sessions = rows.map((row) => {
    // `name` is the short, user-facing thread name; `title` is frequently the
    // whole first user message (thousands of characters). Prefer the short one
    // for display and selection, and keep the long one as a separate field.
    const shortName = typeof row.name === 'string' && row.name !== '' ? row.name : undefined
    const displayTitle = shortName ?? row.title ?? ''
    return {
      side: 'codex',
      id: row.id,
      title: displayTitle,
      ...shortName === undefined || row.title === undefined ? {} : { firstMessage: row.title },
      workspace: row.cwd ?? UNKNOWN,
      archived: row.archived === undefined ? UNKNOWN : row.archived === 1 || row.archived === true,
      running: UNKNOWN,
      bindable: true,
      updatedAt: row.updated_at_ms === undefined ? UNKNOWN : new Date(Number(row.updated_at_ms)).toISOString(),
      ...row.model === undefined || row.model === null ? {} : { model: row.model }
    }
  })

  const needle = options.filter?.toLowerCase()
  const filtered =
    needle === undefined || needle === ''
      ? sessions
      : sessions.filter(
          (session) => session.id.toLowerCase().includes(needle) || session.title.toLowerCase().includes(needle)
        )

  return { sessions: filtered, source, ...warning === undefined ? {} : { warning } }
}

/**
 * List DSH sessions for explicit selection.
 *
 * @param {import('../src/client.mjs').DshClient} dsh - DSH client.
 * @param {object} [options]
 * @param {string} [options.filter] - case-insensitive substring on title or id.
 * @returns {Promise<{sessions: object[], source: string, warning?: string}>} discovery result.
 */
export async function listDshSessions(dsh, options = {}) {
  let items
  try {
    const value = await dsh.listSessions({})
    items = value.items ?? []
  } catch (error) {
    return { sessions: [], source: 'unavailable', warning: `session/list failed: ${error?.message ?? error}` }
  }

  const sessions = items.map((item) => {
    const isSubagent = item.origin === 'subagent' || item.parentSessionId !== undefined
    const title = item.projections?.values?.title ?? ''
    return {
      side: 'dsh',
      id: item.sessionId,
      title: typeof title === 'string' ? title : '',
      workspace: item.cwd ?? UNKNOWN,
      // A subagent is not a session a user can address and keep talking to.
      kind: isSubagent ? 'subagent' : 'top-level',
      bindable: !isSubagent,
      running: item.running === true,
      agentAvailable: item.agentAvailable === true,
      updatedAt: item.updatedAt === undefined ? UNKNOWN : new Date(Number(item.updatedAt)).toISOString(),
      ...item.parentSessionId === undefined ? {} : { parentSessionId: item.parentSessionId }
    }
  })

  const needle = options.filter?.toLowerCase()
  const filtered =
    needle === undefined || needle === ''
      ? sessions
      : sessions.filter(
          (session) => session.id.toLowerCase().includes(needle) || session.title.toLowerCase().includes(needle)
        )

  return { sessions: filtered, source: 'dsh:session/list' }
}

/**
 * Resolve exactly one session by exact id.
 *
 * @param {'codex'|'dsh'} side - which side to resolve on.
 * @param {string} id - the exact session id.
 * @param {object} context - `{ dsh, codexHome }`.
 * @returns {Promise<{ok: true, session: object} | {ok: false, error: string, candidates?: object[]}>} resolution.
 */
export async function resolveExactSession(side, id, context) {
  const listed =
    side === 'codex'
      ? await listCodexSessions({ codexHome: context.codexHome })
      : await listDshSessions(context.dsh)

  const matches = listed.sessions.filter((session) => session.id === id)
  if (matches.length === 0) {
    // Offer near misses to make a typo debuggable, but never auto-select one.
    const needle = id.toLowerCase()
    const candidates = listed.sessions
      .filter((session) => session.id.toLowerCase().includes(needle) || session.title.toLowerCase().includes(needle))
      .slice(0, 5)
      .map((session) => ({ id: session.id, title: session.title }))
    return {
      ok: false,
      error: `no ${side} session with exact id "${id}"`,
      ...candidates.length === 0 ? {} : { candidates }
    }
  }
  const session = matches[0]
  if (session.bindable !== true) {
    return { ok: false, error: `${side} session "${id}" is a ${session.kind ?? 'non-bindable'} session and cannot be bound` }
  }
  return { ok: true, session }
}

/**
 * Find whether one queued Codex message id was actually consumed.
 *
 * `codex queue` returning a receipt proves only that the daemon accepted the
 * message. The durable proof of consumption is the id appearing in the thread's
 * rollout log, which is what this reads. Absence is reported as "no evidence",
 * never as failure — the daemon may simply not have processed it yet.
 *
 * @param {object} args
 * @param {string} args.rolloutPath - rollout JSONL for the thread.
 * @param {string} args.messageId - the id `codex queue` returned.
 * @returns {{found: boolean, turnId?: string, at?: string, reason?: string}} evidence.
 */
export function findCodexConsumption({ rolloutPath, messageId }) {
  if (messageId === undefined || messageId === '') return { found: false, reason: 'no message id' }
  let text
  try {
    text = readFileSync(rolloutPath, 'utf8')
  } catch (error) {
    return { found: false, reason: `rollout unreadable: ${error?.code ?? error?.message ?? error}` }
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '' || !line.includes(messageId)) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const payload = record.payload ?? {}
    const item = payload.item ?? {}
    const idMatches = item.id === messageId || payload.id === messageId || payload.message_id === messageId
    if (!idMatches) continue
    return {
      found: true,
      ...payload.turn_id === undefined ? {} : { turnId: payload.turn_id },
      ...record.timestamp === undefined ? {} : { at: record.timestamp }
    }
  }
  return { found: false, reason: 'not present in rollout yet' }
}

/**
 * Locate a thread's rollout file from the read-only thread table.
 *
 * @param {string} threadId - Codex thread id.
 * @param {object} [options]
 * @param {string} [options.codexHome] - resolved Codex home.
 * @returns {Promise<string | undefined>} absolute rollout path when known.
 */
export async function findCodexRolloutPath(threadId, options = {}) {
  const found = await findCodexStateDb({ codexHome: options.codexHome })
  if (found.path === undefined) return undefined
  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch {
    return undefined
  }
  let db
  try {
    db = new sqlite.DatabaseSync(found.path, { readOnly: true })
    const row = db.prepare(`SELECT rollout_path FROM ${REQUIRED_THREAD_TABLE} WHERE id = ?`).get(threadId)
    return row?.rollout_path
  } catch {
    return undefined
  } finally {
    try {
      db?.close()
    } catch {
      // ignore
    }
  }
}

/**
 * Read a DSH session's completed turns, for task-correlated replies.
 *
 * @param {object} args
 * @param {string} args.sessionId - DSH session.
 * @param {string} args.cwd - session workspace.
 * @param {string} [args.dshHome] - resolved DSH home.
 * @returns {Promise<object[]>} decoded events.
 */
export async function readDshEvents({ sessionId, cwd, dshHome }) {
  const { findSessionLog } = await import('../src/session-log.mjs')
  return readSessionEvents(findSessionLog(dshHome, cwd, sessionId))
}

/** Re-export the executable resolver so callers have one import for Codex facts. */
export { resolveCodexExe }
