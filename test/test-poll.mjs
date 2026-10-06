import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pollBrokerOnce, saveState, loadState } from '../src/broker.mjs'

const root = mkdtempSync(join(tmpdir(), 'bridge-poll-'))
const statePath = join(root, 'state.json')
saveState({ pairs: { demo: { id: 'demo', codexThread: 'fixture' } },
  tasks: { test: { taskId: 'test', pairId: 'demo', status: 'open', requestTurn: 1, requestMessageId: 'request' } },
  messages_v2: [], messages: [], forwarded: [] }, statePath)
let calls = 0
try {
  const options = { statePath, dsh: {}, queue: async () => {
    calls++
    return { messageId: 'fixture-receipt' }
  }, relayLegacy: async () => {}, relayTasks: async ({ state, tasks }) => {
    if (state.tasks.test.status !== 'open') return
    await tasks.relayReplies({ task: state.tasks.test, turns: [{ turn: 2, text: '测试通过\n[bridge-task test]' }] })
  } }
  await Promise.all([pollBrokerOnce(options), pollBrokerOnce(options)])
  assert.equal(calls, 1)
  const state = loadState(statePath)
  assert.equal(state.tasks.test.status, 'answered')
  assert.equal(state.messages_v2.length, 1)
  assert.equal(state.messages_v2[0].state, 'delivered')
  assert.equal(existsSync(`${statePath}.lock`), false)
  console.log('PASS poll: real state lock, nested task mutations, concurrent passes; one simulated reply, no deadlock')
} finally {
  rmSync(root, { recursive: true, force: true })
}
