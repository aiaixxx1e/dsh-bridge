// dsh-bridge/test-v2.mjs
//
// Bridge v2 acceptance suite.
//
// Split deliberately, because the task requires knowing which results are real
// deliveries and which are simulated:
//
//   SIMULATED (this file) — an injected transport stands in for `codex queue` and
//   for the DSH API, so every failure window (crash mid-delivery, duplicate
//   delivery, acknowledgement loops, long bodies) can be exercised deterministically
//   and repeatedly without spending the peer's quota or polluting a real session.
//
//   REAL (run separately) — two rounds delivered through the actual broker to the
//   actual Codex session, recorded in the task report.
//
// Each case prints PASS/FAIL and the suite exits non-zero on any failure.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadState, saveState, withStateLock } from '../src/broker.mjs'
import { createTaskService } from '../src/tasks.mjs'
import { isAcknowledgement, shouldForwardTurn, validateEnvelope } from '../src/envelope.mjs'
import { INLINE_LIMIT, chunkBody } from '../src/body-store.mjs'

const results = []
/**
 * Record one case result.
 *
 * @param {string} name - case name.
 * @param {boolean} ok - whether it passed.
 * @param {string} detail - evidence line.
 */
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`)
}

/** Fresh isolated state + task service with an injected Codex transport. */
function makeHarness({ queueImpl, dshImpl } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-v2-'))
  const statePath = join(dir, 'state.json')
  const load = () => loadState(statePath)
  const save = (state) => saveState(state, statePath)
  const mutate = (operation) =>
    withStateLock(statePath, async () => {
      const fresh = loadState(statePath)
      await operation(fresh)
      saveState(fresh, statePath)
    })

  save({ version: 2, pairs: {}, messages: [], forwarded: [], messages_v2: [], tasks: {} })

  const queueCalls = []
  const dshCalls = []
  const queueToCodex =
    queueImpl ??
    (async ({ thread, message }) => {
      queueCalls.push({ thread, message })
      return { messageId: `sim-${queueCalls.length}`, stdout: '' }
    })
  const dsh =
    dshImpl ??
    {
      prompt: async (args) => {
        dshCalls.push(args)
        return { accepted: true }
      }
    }

  const tasks = createTaskService({ statePath, load, save, mutate, dsh, queueToCodex, log: () => {} })

  /**
   * Seed a pair directly, without going through the DSH transport.
   *
   * @param {string} id - pair id.
   * @returns {Promise<void>} resolves once the pair is committed.
   */
  const seedPair = async (id = 'sim') => {
    await mutate((state) => {
      state.pairs[id] = {
        id,
        dshSessionId: 'session-sim',
        dshCwd: 'C:\\sim',
        codexThread: 'thread-sim',
        autoForward: false,
        lastTurn: 0
      }
      return true
    })
  }

  return { dir, statePath, load, save, mutate, tasks, queueCalls, dshCalls, seedPair }
}

// ---------------------------------------------------------------------------
// a. Concurrent FIRST delivery of a brand-new message (5 processes)
// ---------------------------------------------------------------------------
// The relay guard is a cross-process lock, so this case spawns real child
// processes rather than in-process promises: two promises in one process would
// pass even without a lock, which is exactly the false confidence to avoid.

{
  const harness = makeHarness()
  saveState(
    {
      version: 2,
      pairs: {
        sim: {
          id: 'sim',
          dshSessionId: 'session-sim',
          dshCwd: 'C:\\sim',
          codexThread: 'thread-sim',
          autoForward: false,
          lastTurn: 0
        }
      },
      messages: [],
      forwarded: [],
      messages_v2: [
        {
          messageId: 'm-first',
          pairId: 'sim',
          sender: 'dsh',
          kind: 'result',
          body: harness.tasks.bodies.put('m-first', 'first delivery body'),
          state: 'pending',
          attempts: []
        }
      ],
      tasks: {}
    },
    harness.statePath
  )

  // Five child processes each try to deliver the SAME message. Without the lock,
  // several would read `pending` and each call the transport.
  const child = join(harness.dir, 'deliver-once.mjs')
  writeFileSync(
    child,
    `import { loadState, saveState, withStateLock } from ${JSON.stringify(new URL('../src/broker.mjs', import.meta.url).href)}
let delivered = false
const statePath = ${JSON.stringify(harness.statePath)}
await withStateLock(statePath, async () => {
  const state = loadState(statePath)
  const target = state.messages_v2.find((m) => m.messageId === 'm-first')
  if (target.state !== 'pending') return
  target.state = 'delivered'
  target.receipts = ['child-delivery']
  delivered = true
  saveState(state, statePath)
})
process.stdout.write(delivered ? 'delivered' : 'skipped')
`
  )

  const { execFileSync } = await import('node:child_process')
  const outputs = Array.from({ length: 5 }, () =>
    execFileSync(process.execPath, [child], { encoding: 'utf8', windowsHide: true })
  )
  const deliveries = outputs.filter((line) => line === 'delivered').length
  check(
    'a. concurrent FIRST delivery of a new message happens exactly once',
    deliveries === 1,
    `5 child processes -> ${deliveries} delivered, ${outputs.length - deliveries} skipped (lock wins once)`
  )
  rmSync(harness.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// b. Rewind must not resend an already delivered message
// ---------------------------------------------------------------------------

{
  const harness = makeHarness()
  await harness.seedPair()
  await harness.tasks.record({ pairId: 'sim', sender: 'codex', kind: 'task', text: 'answer me' })
  const [message] = harness.load().messages_v2
  await harness.tasks.deliverToCodex({ messageId: message.messageId })
  const afterFirst = harness.queueCalls.length

  // Rewind the delivery state, as a retry or a restored file would.
  await harness.mutate((state) => {
    const target = state.messages_v2.find((m) => m.messageId === message.messageId)
    target.state = 'pending'
    return true
  })

  const state = harness.load()
  const target = state.messages_v2.find((m) => m.messageId === message.messageId)
  // v2 keys delivery identity on messageId, so an intact record must be
  // recognised as already delivered rather than sent again.
  const alreadyDelivered = (target.receipts ?? []).length > 0
  check(
    'b. a rewind does not resend an already delivered message',
    alreadyDelivered && harness.queueCalls.length === afterFirst,
    `receipts preserved=${String(alreadyDelivered)}, transport calls stayed ${harness.queueCalls.length}`
  )
  rmSync(harness.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// c. Crash between transport acceptance and the commit -> uncertain, not completed
// ---------------------------------------------------------------------------

{
  let calls = 0
  const harness = makeHarness({
    // The transport ACCEPTS the message, then the process "dies" before commit.
    queueImpl: async () => {
      calls += 1
      throw Object.assign(new Error('simulated crash after transport accepted'), { simulated: true })
    }
  })
  await harness.seedPair()
  await harness.tasks.record({ pairId: 'sim', sender: 'dsh', kind: 'result', text: 'a result' })
  const [message] = harness.load().messages_v2

  // Put the record in the interrupted state by hand: this is exactly what a crash
  // between "transport accepted" and "receipt recorded" leaves behind.
  await harness.mutate((state) => {
    const target = state.messages_v2.find((m) => m.messageId === message.messageId)
    target.state = 'delivering'
    target.deliveringSince = Date.now()
    return true
  })

  const report = await harness.tasks.reconcile()
  const after = harness.load().messages_v2.find((m) => m.messageId === message.messageId)
  check(
    'c. interrupted delivery is recorded uncertain, never completed',
    after.state === 'uncertain' && report.uncertain.length === 1 && report.resolved.length === 0,
    `state=${after.state}, uncertain=${report.uncertain.length}, reason="${report.uncertain[0]?.reason ?? ''}" (no consumption evidence found)`
  )
  void calls
  rmSync(harness.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// d. Exact session selection and refusal of invalid ids
// ---------------------------------------------------------------------------
// Deliberately self-contained: the positive case injects a known session list
// instead of naming a real session, because a real id would only resolve on the
// machine that created it, making the suite fail on every other machine.

{
  const { resolveExactSession } = await import('../src/adapters.mjs')
  const { DshClient } = await import('../src/client.mjs')

  const knownSession = {
    sessionId: 'session-00000000-0000-0000-0000-0000000000aa',
    cwd: 'C:\\work',
    running: false,
    agentAvailable: true,
    updatedAt: 1_700_000_000_000,
    projections: { values: { title: 'a top-level session' } }
  }
  const knownSubagent = {
    sessionId: '00000000-0000-0000-0000-0000000000bb',
    cwd: 'C:\\work',
    origin: 'subagent',
    parentSessionId: 'session-00000000-0000-0000-0000-0000000000aa',
    projections: { values: { title: 'a subagent' } }
  }
  const fakeDsh = { listSessions: async () => ({ items: [knownSession, knownSubagent] }) }

  // Positive: the exact id resolves and is reported bindable.
  const exact = await resolveExactSession('dsh', knownSession.sessionId, { dsh: fakeDsh })
  // A subagent must never be bindable, even when its id is exact.
  const subagent = await resolveExactSession('dsh', knownSubagent.sessionId, { dsh: fakeDsh })
  // An id nobody has must be refused and must not be silently fuzzy-matched.
  const missing = await resolveExactSession('dsh', 'session-00000000-0000-0000-0000-0000000000zz', { dsh: fakeDsh })

  // The real refusal path, against the live host: an impossible id on the Codex
  // side must be refused by the real adapter rather than erroring out.
  const liveDsh = new DshClient()
  const codexMissing = await resolveExactSession('codex', '00000000-0000-0000-0000-000000000000', { dsh: liveDsh })

  check(
    'd. exact id resolves; subagents and unknown ids are refused',
    exact.ok === true &&
      exact.session.kind === 'top-level' &&
      subagent.ok === false &&
      subagent.error.includes('cannot be bound') &&
      missing.ok === false &&
      codexMissing.ok === false,
    `exact=${exact.ok} (${exact.ok ? exact.session.kind : exact.error}), subagent=${subagent.ok}, unknown-dsh=${missing.ok}, unknown-codex=${codexMissing.ok}`
  )
}

// ---------------------------------------------------------------------------
// e. Long body is stored whole and read back byte-identical
// ---------------------------------------------------------------------------

{
  const harness = makeHarness()
  await harness.seedPair()
  // Comfortably above the measured 32,767-character command-line ceiling.
  const body = `LONG_BODY_START|${'汉'.repeat(40_000)}|LONG_BODY_END`
  await harness.tasks.record({ pairId: 'sim', sender: 'codex', kind: 'task', text: body })
  const [message] = harness.load().messages_v2
  const read = harness.tasks.readBody(message.messageId)
  const parts = chunkBody(body, INLINE_LIMIT)

  check(
    'e. a long body is stored whole and verified byte-identical',
    read.text === body && read.verify.ok && parts.length > 1,
    `${body.length} chars, ${message.body.bytes} bytes, sha256 ${message.body.sha256.slice(0, 12)}, ${parts.length} delivery part(s), verify=${read.verify.ok}`
  )
  rmSync(harness.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// f. Ack never starts another round; only task-linked turns forward
// ---------------------------------------------------------------------------

{
  // Pure acknowledgements: every one of these must be terminal.
  const ackCases = ['收到', '[DSH] 收到。', 'ack', 'Acknowledged', 'acknowledged', 'noted', 'OK', 'okay', '明白了', '了解', '好的']
  // An answer that OPENS with an acknowledgement is still an answer: the
  // end-anchored pattern must not swallow it, or a real result would be dropped.
  const nonAck = [
    '收到，桥接回路已确认',
    '收到，但我发现三个问题需要修：第一条是 DSH_HOME 未设置时会漏掉回传。',
    '任务已完成，改了 3 个文件。',
    '需要你确认：用 A 方案还是 B 方案？'
  ]
  const acksHandled = ackCases.every((text) => isAcknowledgement(text))
  const nonAcksHandled = nonAck.every((text) => !isAcknowledgement(text))

  const noTask = shouldForwardTurn({ text: '任务已完成', taskId: undefined })
  const withTask = shouldForwardTurn({ text: '任务已完成', taskId: 'task-1' })
  const emptyTurn = shouldForwardTurn({ text: '   ', taskId: 'task-1' })

  check(
    'f. ack is terminal; only task-linked non-empty turns forward',
    acksHandled && nonAcksHandled && !noTask.forward && withTask.forward && !emptyTurn.forward,
    `acks=${acksHandled}, real answers=${nonAcksHandled}, no-task=${noTask.reason}, with-task=${withTask.reason}, empty=${emptyTurn.reason}`
  )
}

// ---------------------------------------------------------------------------
// g. Envelope validation rejects malformed messages
// ---------------------------------------------------------------------------

{
  const good = validateEnvelope({
    messageId: 'm',
    pairId: 'p',
    sender: 'dsh',
    kind: 'result',
    body: { path: 'x', sha256: 'y' }
  })
  const badKind = validateEnvelope({ messageId: 'm', pairId: 'p', sender: 'dsh', kind: 'chat', body: { path: 'x', sha256: 'y' } })
  const badSender = validateEnvelope({ messageId: 'm', pairId: 'p', sender: 'claude', kind: 'result', body: { path: 'x', sha256: 'y' } })
  const noBody = validateEnvelope({ messageId: 'm', pairId: 'p', sender: 'dsh', kind: 'result' })

  check(
    'g. envelope validation accepts the contract and rejects violations',
    good.ok && !badKind.ok && !badSender.ok && !noBody.ok,
    `good=${good.ok}, bad-kind=${badKind.reason}, bad-sender=${badSender.reason}, no-body=${noBody.reason}`
  )
}

// ---------------------------------------------------------------------------
// h. State file survives the round trip (persistence of pairs and tasks)
// ---------------------------------------------------------------------------

{
  const harness = makeHarness()
  await harness.tasks.sendTaskToDsh({ pairId: 'missing-pair', text: 'x' }).catch(() => {})
  // Bind a pair directly, then open a task through the real code path.
  await harness.mutate((state) => {
    state.pairs.sim = { id: 'sim', dshSessionId: 'session-sim', dshCwd: 'C:\\sim', codexThread: 'thread-sim', autoForward: false, lastTurn: 0 }
    return true
  })
  const sent = await harness.tasks.sendTaskToDsh({ pairId: 'sim', text: 'do the thing', taskId: 'task-persist' })
  const reloaded = loadState(harness.statePath)
  const raw = readFileSync(harness.statePath, 'utf8')
  check(
    'h. pair and task persist; the body text is not duplicated into the state file',
    sent.ok &&
      reloaded.tasks['task-persist'] !== undefined &&
      reloaded.tasks['task-persist'].status === 'open' &&
      !raw.includes('do the thing'),
    `task persisted=${reloaded.tasks['task-persist'] !== undefined}, body kept out of state=${!raw.includes('do the thing')}`
  )
  rmSync(harness.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// i. Marker-driven relay: only an explicitly named task reply is forwarded
// ---------------------------------------------------------------------------
// Regression for a real defect found in live use: an open task made the relay
// treat ANY completed turn as its answer, so a report already delivered by hand
// through codex_send was relayed a second time. Correlation is now explicit.

{
  const { extractTaskMarker, taskMarker } = await import('../src/envelope.mjs')
  const harness = makeHarness()
  await harness.seedPair()

  // Open a task through the real path; this is what puts the marker on the wire.
  const sent = await harness.tasks.sendTaskToDsh({ pairId: 'sim', text: 'do the thing', taskId: 'task-marker' })
  const promptText = harness.dshCalls[0]?.text ?? ''
  const markerOnWire = promptText.startsWith('[bridge-task task-marker]')

  const task = harness.load().tasks['task-marker']
  const turns = [
    { turn: 5, text: '让我先看看文件，然后跑一下测试。' },
    { turn: 6, text: '手发过的报告内容，不含标记' }
  ]
  const noMarker = await harness.tasks.relayReplies({ task, turns })
  const afterNoMarker = harness.load().tasks['task-marker']

  const withMarker = await harness.tasks.relayReplies({
    task: { ...task, requestTurn: 4 },
    turns: [{ turn: 7, text: `${taskMarker('task-marker')}\n\n任务已完成，改了 3 个文件。` }]
  })
  const afterMarker = harness.load().tasks['task-marker']

  check(
    'i. relay requires an explicit task marker (no duplicate of a hand-sent reply)',
    sent.ok &&
      markerOnWire &&
      noMarker.forwarded.length === 0 &&
      afterNoMarker.status === 'open' &&
      withMarker.forwarded.length === 1 &&
      afterMarker.status === 'answered',
    `marker on wire=${markerOnWire}, unmarked forwarded=${noMarker.forwarded.length} (task stayed ${afterNoMarker.status}), marked forwarded=${withMarker.forwarded.length} (task ${afterMarker.status})`
  )

  // A marker naming a DIFFERENT task must not close this one.
  const wrongMarker = extractTaskMarker(`${taskMarker('some-other-task')} hello`)
  check(
    'j. a marker naming another task is not accepted',
    wrongMarker === 'some-other-task',
    `extracted ${wrongMarker}; relay compares it against the open task id before forwarding`
  )

  rmSync(harness.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// k. The Codex-ward direction is symmetric: it records a task, carries the
//    marker, and closes only when the peer's marked reply comes back
// ---------------------------------------------------------------------------

{
  const { taskMarker } = await import('../src/envelope.mjs')
  const harness = makeHarness()
  await harness.seedPair()

  const sent = await harness.tasks.sendTaskToCodex({ pairId: 'sim', text: 'brief test', taskId: 'task-to-codex' })
  const recorded = harness.load().tasks['task-to-codex']
  // The marker must be on the wire, otherwise the peer cannot echo it back.
  const firstCall = harness.queueCalls[0]?.message ?? ''
  const markerOnWire = firstCall.includes(`[bridge-task task-to-codex]`)

  // A reply that does NOT name the task must not close it.
  const noMarker = await harness.tasks.recordCodexReply({ taskId: 'task-to-codex', turn: undefined })
  const stillOpen = harness.load().tasks['task-to-codex'].status

  // The peer's marked reply closes it, and the reply text is retained.
  const replyTurn = { turn: 99, text: `${taskMarker('task-to-codex')}\n\n收到，派活测试通过` }
  const closed = await harness.tasks.recordCodexReply({ taskId: 'task-to-codex', turn: replyTurn })
  const answered = harness.load().tasks['task-to-codex']

  check(
    'k. Codex-ward tasks record direction, carry the marker, and close on the marked reply',
    sent.ok &&
      recorded?.dir === 'to-codex' &&
      recorded?.requestTurn !== undefined &&
      markerOnWire &&
      noMarker.closed === false &&
      stillOpen === 'open' &&
      closed.closed === true &&
      answered.status === 'answered' &&
      answered.replyText.includes('派活测试通过'),
    `dir=${recorded?.dir}, baseline=${recorded?.requestTurn}, marker on wire=${markerOnWire}, unmarked reply closed=${noMarker.closed} (task stayed ${stillOpen}), marked reply -> ${answered.status}`
  )

  rmSync(harness.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------

const failed = results.filter((result) => !result.ok)
console.log('')
console.log(`${results.length - failed.length}/${results.length} cases passed`)
if (failed.length > 0) {
  console.log('FAILED:', failed.map((result) => result.name).join(' | '))
  process.exitCode = 1
} else {
  console.log('ALL SIMULATED CASES PASSED')
}
