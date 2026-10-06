// dsh-bridge/session-log.mjs
//
// Read a DSH session's durable event log.
//
// DSH persists each session as a zstd-compressed JSONL stream at
//   $DSH_HOME/sessions/<project-slug>/<session-id>/session[.vN].jsonl.zstd
// Node 24 ships zstd in node:zlib, so no external tool is needed.
//
// Events are what the Host broadcasts on its `session/event` firehose; the log
// is the durable copy of the same stream, which makes it the reliable way for an
// out-of-process bridge to observe turn boundaries and assistant output.

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

/**
 * Resolve the DSH home directory.
 *
 * `$DSH_HOME` is only set for processes DSH itself spawns. A bridge started
 * independently (a service, a scheduled task, a plain terminal) has no such
 * variable, so falling back to the conventional `~/.dsh` is required — without
 * it the log path silently becomes relative and every read fails with ENOENT.
 *
 * @returns {string} absolute DSH home path.
 */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** DSH encodes a workspace path as the session subdirectory name. */
export function projectSlug(cwd) {
  return '--' + cwd.replaceAll(':', '').replaceAll('\\', '-').replaceAll('/', '-') + '--'
}

/**
 * Locate the newest session-log file for one session id.
 *
 * @param {string} [home] - DSH home directory; defaults to {@link dshHome}.
 * @param {string} cwd - the session's workspace path.
 * @param {string} sessionId - e.g. 'session-00000000-...'.
 * @returns {string} absolute log path.
 */
export function findSessionLog(home, cwd, sessionId) {
  const dir = join(home ?? dshHome(), 'sessions', projectSlug(cwd), sessionId)
  let candidates
  try {
    candidates = readdirSync(dir).filter((name) => name.endsWith('.jsonl.zstd'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`no session log directory at ${dir} (check the session id and --cwd)`)
    }
    throw error
  }
  if (candidates.length === 0) throw new Error(`no session log in ${dir}`)
  // Prefer the highest format version when several exist.
  candidates.sort()
  return join(dir, candidates[candidates.length - 1])
}

/**
 * Decode one session log into its event objects.
 *
 * DSH appends to this file as a sequence of independent zstd frames, so a
 * one-shot `zstdDecompressSync` stops after the first frame — it decodes one
 * frame and ignores the rest. Splitting on the zstd magic number and decoding
 * each frame separately yields every event, and a partially written final frame
 * (a live session still appending) is dropped instead of failing the read.
 *
 * @param {string} path - session log file.
 * @returns {object[]} decoded events.
 */
export function readSessionEvents(path) {
  return decodeFrameBuffer(readFileSync(path))
}

/** zstd frame magic number, little-endian on the wire. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decode every complete zstd frame in a buffer into JSONL events.
 *
 * @param {Buffer} bytes - raw log contents.
 * @returns {object[]} decoded events.
 */
export function decodeFrameBuffer(bytes) {
  const events = []
  const starts = []
  let at = bytes.indexOf(ZSTD_MAGIC)
  while (at !== -1) {
    starts.push(at)
    at = bytes.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.byteLength)
  }

  for (const [index, start] of starts.entries()) {
    // A frame ends where the next frame begins; the last one runs to EOF and may
    // be truncated, in which case decoding fails and we stop.
    const end = index + 1 < starts.length ? starts[index + 1] : bytes.byteLength
    let text
    try {
      text = zstdDecompressSync(bytes.subarray(start, end)).toString('utf8')
    } catch {
      break
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      events.push(JSON.parse(line))
    }
  }
  return events
}

/** A stable id for the log position, usable to detect new content. */
export function logFingerprint(path) {
  const bytes = readFileSync(path)
  return { bytes: bytes.byteLength, sha: createHash('sha256').update(bytes).digest('hex').slice(0, 16) }
}

// Allow `node session-log.mjs <sessionId> <cwd>` for a quick dump.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , sessionId, cwd] = process.argv
  const path = findSessionLog(dshHome(), cwd ?? process.cwd(), sessionId)
  const events = readSessionEvents(path)
  console.log('log    :', path)
  console.log('events :', events.length)
  const types = new Map()
  for (const event of events) types.set(event.type, (types.get(event.type) ?? 0) + 1)
  console.log('types  :', JSON.stringify([...types.entries()].sort(), null, 0))
  console.log('\nlast 6 events:')
  for (const event of events.slice(-6)) console.log(JSON.stringify(event).slice(0, 500))
}
