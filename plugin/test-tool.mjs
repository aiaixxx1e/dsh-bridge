// dsh-codex-bridge-tool/test-tool.mjs
//
// Exercise the plugin's registered tools against the live broker without
// installing the plugin into a profile.
//
// This captures the definitions the plugin registers, then invokes
// `codex_send` / `codex_pairs` through their real `execute` functions with a
// synthetic execution context, so a pass here proves the same code the DSH
// agent would run.

import { apply } from './lib/index.js'

/** Collect the tool definitions the plugin registers. */
const registered = []
const ctx = {
  tools: {
    register: (definition) => {
      registered.push(definition)
    }
  }
}

await apply(ctx)
console.log('registered tools:', registered.map((tool) => tool.name).join(', '))
if (registered.length === 0) {
  console.error('FAIL: plugin registered no tools')
  process.exit(1)
}

/** Minimal exec context: one synthetic agent owning one session. */
function execContext(sessionId) {
  return {
    callId: 'test-call',
    name: 'codex_send',
    arguments: {},
    agent: { session: { id: sessionId } },
    signal: AbortSignal.timeout(60_000)
  }
}

const sessionId = process.argv[2]
const message = process.argv[3]
const pairs = registered.find((tool) => tool.name === 'codex_pairs')
const send = registered.find((tool) => tool.name === 'codex_send')

console.log('\n=== codex_pairs ===')
const pairResult = await pairs.execute({}, { signal: AbortSignal.timeout(15_000) })
console.log(JSON.stringify(pairResult, null, 2))

if (sessionId && message) {
  console.log('\n=== codex_send ===')
  const sendResult = await send.execute({ message }, execContext(sessionId))
  console.log(JSON.stringify(sendResult, null, 2))
  if (!sendResult.ok) process.exitCode = 1
}

// Exercise the no-pair failure path so its message is verified too.
console.log('\n=== codex_send with an unpaired session (expected failure) ===')
const missing = await send.execute({ message: 'x' }, execContext('session-does-not-exist'))
console.log(JSON.stringify(missing, null, 2))
if (missing.ok) {
  console.error('FAIL: an unpaired session should not report success')
  process.exitCode = 1
}
