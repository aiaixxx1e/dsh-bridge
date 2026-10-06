// dsh-bridge/test-relay.mjs — prove the relay is serialized and deduplicated.
//
// Two failure modes this guards:
//
//  1. Concurrency: the polling loop and an operator-triggered /tick can read the
//     same `lastTurn` cursor and each forward the same turn, so the Codex session
//     receives duplicates. `relayDshToCodex` serializes passes.
//  2. Rewind: any code that resets the cursor (a retry, a restored state file, an
//     operator replaying history) would re-send turns the peer already processed.
//     The durable `forwardKey(pair, turn)` set makes a delivered turn un-sendable
//     regardless of the cursor.
//
// This test exercises BOTH: it rewinds the cursor to 0 and then launches several
// concurrent passes, asserting that nothing is delivered twice.

import { loadState, relayDshToCodex, forwardKey } from '../src/broker.mjs'
import { DshClient } from '../src/client.mjs'

const statePath = process.env.DSH_BRIDGE_STATE ?? new URL('./state.json', import.meta.url).pathname.replace(/^\//u, '')
const state = loadState(statePath)
const pair = Object.values(state.pairs)[0]
if (!pair) {
  console.error('FAIL: no pair registered; run broker.mjs init first')
  process.exit(1)
}

const messagesBefore = state.messages.length

const dsh = new DshClient()
const quiet = () => {}

// Phase 1 — make sure every completed turn has a recorded delivery key.
// The cursor is rewound first so this pass delivers whatever is missing and
// records the key for each delivery. Afterwards the key set is authoritative.
pair.lastTurn = 0
const seed = await relayDshToCodex({ state, dsh, log: quiet })
const deliveredAfterSeed = new Set(state.forwarded ?? [])
console.log(`pair ${pair.id}: phase 1 delivered ${seed.forwarded}; ${deliveredAfterSeed.size} delivery keys recorded`)

// Phase 2 — the actual guard. Rewind the cursor AGAIN, then launch concurrent
// passes. Deduplication alone must prevent any re-delivery.
console.log('phase 2: cursor rewound to 0 again; dispatching 3 CONCURRENT relay passes...')
pair.lastTurn = 0
const passes = await Promise.all([
  relayDshToCodex({ state, dsh, log: quiet }),
  relayDshToCodex({ state, dsh, log: quiet }),
  relayDshToCodex({ state, dsh, log: quiet })
])

const totalForwarded = passes.reduce((sum, pass) => sum + pass.forwarded, 0)
const newMessages = state.messages.slice(messagesBefore)
const deliveredAfter = new Set(state.forwarded ?? [])

console.log('per-pass forwarded:', passes.map((pass) => pass.forwarded).join(', '))
console.log('total forwarded   :', totalForwarded)
console.log('messages appended :', newMessages.length, '(was', messagesBefore, ')')
console.log('delivery keys     :', deliveredAfterSeed.size, '->', deliveredAfter.size)

const counts = new Map()
for (const key of deliveredAfter) counts.set(key, (counts.get(key) ?? 0) + 1)
const duplicates = [...counts.entries()].filter(([, count]) => count > 1)

if (duplicates.length > 0) {
  console.error(`FAIL: duplicate delivery keys: ${duplicates.map(([key]) => key).join(', ')}`)
  process.exitCode = 1
} else if (totalForwarded !== 0) {
  console.error(`FAIL: expected 0 forwardings after a rewind (all turns already delivered), got ${totalForwarded}`)
  process.exitCode = 1
} else if (deliveredAfter.size !== deliveredAfterSeed.size) {
  console.error('FAIL: the delivered-key set changed even though nothing should have been sent')
  process.exitCode = 1
} else {
  console.log('PASS: a cursor rewind plus concurrent passes delivered nothing twice')
}

