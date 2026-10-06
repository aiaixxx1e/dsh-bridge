// dsh-bridge/codex.mjs
//
// Codex side of the Codex <-> DeepSeek Harness bridge.
//
// Every operation is a plain Codex CLI invocation. No Codex protocol
// reverse-engineering is needed: the shipped CLI already exposes the primitives
// a bridge needs.
//
//   codex agents             -- browse sessions on the shared local app-server daemon
//   codex queue --thread ID --message TEXT
//                            -- queue one message for an EXISTING session
//   codex resume ID [PROMPT] -- resume a session (interactive)
//
// `codex queue` is the wake primitive: it targets a session UUID or exact
// session name, so a bridge can reach the user's own existing conversation.
// Verified against codex-cli 0.160.1.
//
// Executable and home discovery live in resolvers.mjs so a relocated install
// works; nothing here assumes a default path.

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolveCodexExe, resolveCodexHome } from '../src/resolvers.mjs'

const execFileAsync = promisify(execFile)

/**
 * Resolve the Codex executable, preferring the running process's own path.
 *
 * @param {object} [options]
 * @param {Array<object>} [options.processes] - pre-read processes.
 * @returns {string} absolute path to the Codex executable.
 */
export function codexExe(options = {}) {
  const resolved = resolveCodexExe(options)
  if (resolved.path === undefined) throw new Error(`cannot locate the Codex executable: ${resolved.detail}`)
  return resolved.path
}

/**
 * Read Codex's session index: one JSON object per line,
 * `{ id, thread_name, updated_at }`.
 *
 * This is the durable list of the user's existing Codex threads, and the fallback
 * when the state database cannot be read.
 *
 * @param {object} [options]
 * @param {string} [options.codexHome] - resolved Codex home.
 * @returns {Array<{id: string, thread_name?: string, updated_at?: string}>} index rows.
 */
export function readSessionIndex(options = {}) {
  const home = options.codexHome ?? resolveCodexHome().path
  if (home === undefined) throw new Error('cannot locate the Codex home; set CODEX_HOME')
  const path = join(home, 'session_index.jsonl')
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

/**
 * Find Codex threads by id or by a case-insensitive substring of the thread name.
 *
 * @param {string} query - thread id or name fragment.
 * @param {object} [options]
 * @param {string} [options.codexHome] - resolved Codex home.
 * @returns {Array<{id: string, thread_name?: string, updated_at?: string}>} matches.
 */
export function findThreads(query, options = {}) {
  const needle = query.toLowerCase()
  return readSessionIndex(options).filter(
    (row) => String(row.id ?? '').toLowerCase() === needle || String(row.thread_name ?? '').toLowerCase().includes(needle)
  )
}

/**
 * Queue one message into an existing Codex session.
 *
 * @param {object} args
 * @param {string} args.thread - session UUID or exact session name.
 * @param {string} args.message - message text.
 * @param {object} [args.options] - resolver options (`processes`, `override`).
 * @returns {Promise<{messageId: string | undefined, stdout: string}>} delivery receipt.
 */
export async function queueToCodex({ thread, message, options = {} }) {
  if (!thread) throw new Error('codex queue requires a thread id')
  if (typeof message !== 'string' || message.trim() === '') throw new Error('codex queue requires a non-empty message')
  const { stdout } = await execFileAsync(codexExe(options), ['queue', '--thread', thread, '--message', message], {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024
  })
  const match = /Queued message (\S+) for thread (\S+)/u.exec(stdout)
  return { messageId: match?.[1], stdout: stdout.trim() }
}
