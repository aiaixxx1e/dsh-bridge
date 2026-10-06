// dsh-bridge/probe-argv-limit.mjs
//
// Measure the real ceiling for passing a message to `codex queue`.
//
// Why this matters: `codex queue` accepts the message only as a command-line
// argument (`--message <TEXT>`) — it has no stdin or file input. Node's
// `execFile` avoids the *shell*, so quoting and `cmd.exe`'s ~8191-character
// limit do not apply, but Windows still creates the process through
// CreateProcess, whose command line is capped (historically 32,767 characters).
// A bridge that must not truncate a long body has to know where that ceiling is.
//
// The probe deliberately sends messages the receiver will not act on, and every
// message self-identifies as a probe so an operator can ignore it.

import { execFile } from 'node:child_process'
import { resolveCodexExe } from '../src/codex.mjs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const thread = process.argv[2]
if (!thread) {
  console.error('usage: node probe-argv-limit.mjs <codexThreadId>')
  process.exit(2)
}

const exe = resolveCodexExe()
console.log('codex exe:', exe)
console.log('thread   :', thread)
console.log('')

// Ascending sizes around the suspected ceiling.
const sizes = [8 * 1024, 24 * 1024, 30 * 1024, 32 * 1024, 33 * 1024, 40 * 1024, 64 * 1024]

for (const size of sizes) {
  const prefix = `【argv上限探测 size=${size}】本条为长度探测消息，请忽略，不要执行任何动作。`
  const padding = 'x'.repeat(Math.max(0, size - prefix.length))
  const message = prefix + padding
  try {
    const { stdout } = await execFileAsync(exe, ['queue', '--thread', thread, '--message', message], {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024
    })
    console.log(`size ${String(size).padStart(6)}  OK     ${stdout.trim().slice(0, 80)}`)
  } catch (error) {
    const code = error?.code ?? ''
    const killed = error?.killed === true ? ' (killed/timeout)' : ''
    const firstLine = String(error?.stderr ?? error?.message ?? '').split('\n')[0].slice(0, 140)
    console.log(`size ${String(size).padStart(6)}  FAIL   code=${code}${killed} ${firstLine}`)
  }
}
