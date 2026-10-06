// dsh-bridge/body-store.mjs
//
// Message bodies, kept out of command lines.
//
// Why this exists: `codex queue` accepts its message only as a command-line
// argument, and Windows caps a created process's command line at 32,767
// characters. Measured on this machine:
//
//     8 KiB OK · 24 KiB OK · 30 KiB OK · 32 KiB FAIL (ENAMETOOLONG)
//
// So a body above the safe ceiling cannot be delivered inline no matter how the
// process is spawned. Truncating would silently lose content, which the task
// explicitly forbids. This store therefore keeps every body as a file and lets
// delivery either send the body inline (when it fits) or send ordered parts that
// reassemble by (messageId, part/total) — never a teaser with the rest dropped.

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Conservative inline ceiling for one `codex queue --message` argument.
 *
 * The measured failure is at 32,768 characters for the whole command line. The
 * executable path, the subcommand, and the flag names together consume roughly
 * 100 characters, and CreateProcess accounting is not guaranteed to match our own
 * character count (quoting and escaping are the platform's business). 24,000
 * leaves ample headroom while still covering ordinary task text.
 */
export const INLINE_LIMIT = 24_000

/** Body store: one file per message body, plus content addressing. */
export class BodyStore {
  /**
   * @param {string} root - directory holding body files.
   */
  constructor(root) {
    this.root = root
    mkdirSync(root, { recursive: true })
  }

  /**
   * Persist one body and return its handle.
   *
   * @param {string} messageId - the owning message.
   * @param {string} text - full body text (UTF-8).
   * @returns {{path: string, bytes: number, chars: number, sha256: string}} handle.
   */
  put(messageId, text) {
    const bytes = Buffer.from(text, 'utf8')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const path = join(this.root, `${messageId}.txt`)
    writeFileSync(path, bytes)
    return { path, bytes: bytes.byteLength, chars: text.length, sha256 }
  }

  /**
   * Read a stored body back.
   *
   * @param {string} path - body file path.
   * @returns {string} the body text.
   */
  get(path) {
    return readFileSync(path, 'utf8')
  }

  /**
   * Verify a stored body still matches its recorded hash.
   *
   * This is the integrity check the acceptance criteria ask for: a long message
   * is "completely readable" only if reading the file yields the recorded
   * content, not merely that the file exists.
   *
   * @param {{path: string, sha256: string, bytes: number}} handle - the recorded handle.
   * @returns {{ok: boolean, reason?: string}} verification result.
   */
  verify(handle) {
    let bytes
    try {
      bytes = readFileSync(handle.path)
    } catch (error) {
      return { ok: false, reason: `unreadable: ${error?.code ?? error?.message ?? error}` }
    }
    if (bytes.byteLength !== handle.bytes) {
      return { ok: false, reason: `size mismatch: expected ${handle.bytes}, read ${bytes.byteLength}` }
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== handle.sha256) return { ok: false, reason: 'sha256 mismatch' }
    return { ok: true }
  }
}

/**
 * Split a body into ordered parts that each fit the inline ceiling.
 *
 * Splitting happens on character boundaries, so a multi-byte character is never
 * cut in half. Parts reassemble by `(messageId, part, total)`.
 *
 * @param {string} text - full body.
 * @param {number} [limit] - maximum characters per part.
 * @returns {string[]} the parts, in order.
 */
export function chunkBody(text, limit = INLINE_LIMIT) {
  if (text.length <= limit) return [text]
  const parts = []
  for (let at = 0; at < text.length; at += limit) parts.push(text.slice(at, at + limit))
  return parts
}

/**
 * Mint a stable message identity.
 *
 * @returns {string} a UUID usable as both the message and body-file name.
 */
export function newMessageId() {
  return randomUUID()
}
