import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrokerServer, loadState, saveState, pollBrokerOnce } from '../src/broker.mjs'
import { createSessionServer } from '../src/session-server.mjs'
import { sendConnectionGuides } from '../src/onboarding.mjs'

const root = mkdtempSync(join(tmpdir(), 'bridge-onboard-'))
const statePath = join(root, 'state.json')
writeFileSync(join(root, 'session_index.jsonl'), JSON.stringify({ id: 'codex-fixture', thread_name: 'fixture' }) + '\n')
const calls = []
let failDsh = false
const dsh = {
  listSessions: async () => ({ items: [{ sessionId: 'session-fixture', cwd: root }] }),
  prompt: async args => {
    calls.push({ side: 'dsh', ...args })
    if (failDsh) throw new Error('transport interrupted')
    return { accepted: true }
  }
}
const queue = async args => { calls.push({ side: 'codex', ...args }); return { messageId: 'receipt-' + calls.length } }
const broker = createBrokerServer({ statePath, dsh, queue, tasks: {}, log: () => {}, codexHome: root })
await new Promise(resolve => broker.listen(0, '127.0.0.1', resolve))
const brokerUrl = `http://127.0.0.1:${broker.address().port}`
const consoleApp = await createSessionServer({ statePath, dsh, brokerUrl, log: () => {},
  env: { codexHome: { path: root }, dshHome: { path: root } } })
await new Promise(resolve => consoleApp.server.listen(0, '127.0.0.1', resolve))
const consoleUrl = `http://127.0.0.1:${consoleApp.server.address().port}`
const post = async (base, path, body) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}
const binding = { pairId: 'demo', codex: 'codex-fixture', dsh: 'session-fixture' }
try {
  let result = await post(consoleUrl, '/api/pairs', binding)
  assert.equal(result.body.guide.ok, true)
  assert.equal(calls.length, 2)
  assert.ok(calls[0].message.includes('/send-task'))
  assert.ok(calls[1].text.includes('/send-task-to-codex'))
  assert.ok(calls.every(call => (call.message ?? call.text).includes(brokerUrl)))
  assert.ok(calls.every(call => (call.message ?? call.text).includes('无需回复')))
  assert.equal(Object.keys(loadState(statePath).tasks).length, 0)
  await Promise.all([post(brokerUrl, '/onboard', { pairId: 'demo' }), post(brokerUrl, '/onboard', { pairId: 'demo' })])
  assert.equal(calls.length, 2, 'Concurrent repeats must not redeliver')
  await post(brokerUrl, '/bind', binding)
  assert.equal(calls.length, 2, 'Rebinding exact same IDs keeps receipts')
  await post(consoleUrl, '/api/onboard', { pairId: 'demo', force: true })
  assert.equal(calls.length, 4)
  assert.ok((await (await fetch(consoleUrl)).text()).includes('重新发送使用说明'))
  assert.equal((await post(brokerUrl, '/onboard', { pairId: 'missing' })).status, 404)

  // Single-sided interruption does not suppress the other side or auto-retry.
  const state = loadState(statePath)
  state.pairs.partial = { ...state.pairs.demo, id: 'partial', onboarding: undefined }
  failDsh = true
  result = await sendConnectionGuides({ state, pairId: 'partial', dsh, queue, brokerUrl, save: () => saveState(state, statePath) })
  assert.equal(result.ok, false)
  assert.equal(result.onboarding.sides.codex.state, 'delivered')
  assert.equal(result.onboarding.sides.dsh.state, 'uncertain')
  const before = calls.length
  await sendConnectionGuides({ state: loadState(statePath), pairId: 'partial', dsh, queue, brokerUrl, save: () => {} })
  assert.equal(calls.length, before)
  failDsh = false
  const changed = loadState(statePath)
  changed.pairs.demo.dshSessionId = 'session-new'
  await sendConnectionGuides({ state: changed, pairId: 'demo', dsh, queue, brokerUrl, save: () => saveState(changed, statePath) })
  assert.equal(calls.length, before + 2, 'Changed session receives a fresh guide')

  // Broker unavailable at bind: pair is saved, then next owner poll sends guides.
  await new Promise(resolve => broker.close(resolve))
  result = await post(consoleUrl, '/api/pairs', { ...binding, pairId: 'pending' })
  assert.equal(result.body.guide.pending, true)
  await pollBrokerOnce({ statePath, dsh, queue, brokerUrl, relayLegacy: async () => {}, relayTasks: async () => ({}), relayCodexReplies: async () => {} })
  assert.equal(loadState(statePath).pairs.pending.onboarding.sides.dsh.state, 'delivered')
  assert.equal(Object.keys(loadState(statePath).tasks).length, 0)
  console.log('PASS onboarding: UI/HTTP bind, exact destinations, role guides, concurrency/rebind dedup, resend, partial failure, session change, offline recovery; simulated agent deliveries')
} finally {
  await consoleApp.close()
  if (broker.listening) await new Promise(resolve => broker.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
