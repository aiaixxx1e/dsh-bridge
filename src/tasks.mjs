// dsh-bridge/tasks.mjs
//
// Task and message orchestration for bridge v2.
//
// Replaces the v1 blanket whole-turn forwarding with task-correlated delivery:
// a reply is sent back only when it answers an open task, and acknowledgements
// never start another round. See envelope.mjs for the wire contract.
//
// Delivery semantics, stated honestly:
//
//   accepted  — the transport admitted the message (queue receipt / accepted:true)
//   delivered — the message is known to be held by the receiving side
//   completed — real evidence of CONSUMPTION exists (the message id appears in
//               the receiver's own durable log)
//   uncertain — the process died between "transport accepted it" and "we recorded
//               the receipt". Reconcile before retrying; never report completed.
//
// Exactly-once is NOT claimed. The receiver deduplicates on `messageId`, and this
// side retries only after consulting the durable record.

import { randomUUID } from 'node:crypto'
import { BodyStore, chunkBody, INLINE_LIMIT } from '../src/body-store.mjs'
import { findCodexConsumption, findCodexRolloutPath } from '../src/adapters.mjs'
import { extractCompletedTurns } from '../src/extract.mjs'
import { findSessionLog, readSessionEvents } from '../src/session-log.mjs'
import {
  extractTaskMarker,
  isAcknowledgement,
  makeEnvelope,
  shouldForwardTurn,
  taskMarker,
  validateEnvelope
} from '../src/envelope.mjs'

/** Directory holding body files, relative to the state file. */
export const BODY_DIR_NAME = 'bodies'

/**
 * Create the task service over a state object and its persistence hooks.
 *
 * @param {object} args
 * @param {string} args.statePath - state file path.
 * @param {() => object} args.load - read the latest state.
 * @param {(state: object) => void} args.save - commit the state.
 * @param {(fn: (state: object) => Promise<unknown>) => Promise<unknown>} args.mutate - lock+read+modify+commit.
 * @param {object} args.dsh - DSH client.
 * @param {(args: object) => Promise<object>} args.queueToCodex - Codex delivery function.
 * @param {(message: string) => void} [args.log] - progress sink.
 * @returns {object} the task service.
 */
export function createTaskService({ statePath, load, save, mutate, dsh, queueToCodex, log = () => {} }) {
  const bodies = new BodyStore(statePath.replace(/[^\\/]+$/u, BODY_DIR_NAME))

  /**
   * Register one outbound message: persist the body, then record the envelope as
   * `pending`. Recording BEFORE delivery is what makes an interrupted delivery
   * detectable instead of silently lost.
   *
   * @param {object} args - pair, kind, text, and correlation ids.
   * @returns {Promise<object>} the recorded message.
   */
  const record = async ({ pairId, sender, kind, text, taskId, replyTo }) => {
    const messageId = randomUUID()
    const handle = bodies.put(messageId, text)
    const parts = chunkBody(text)
    const envelope = makeEnvelope({
      messageId,
      taskId,
      replyTo,
      pairId,
      sender,
      kind,
      body: handle,
      parts: parts.length > 1 ? parts.length : undefined
    })
    const invalid = validateEnvelope(envelope)
    if (!invalid.ok) throw new Error(`internal: invalid envelope (${invalid.reason})`)

    await mutate((state) => {
      state.messages_v2 = state.messages_v2 ?? []
      state.messages_v2.push({
        ...envelope,
        // The body text is never duplicated into the state file; it lives in the store.
        state: 'pending',
        attempts: []
      })
      return true
    })
    return envelope
  }

  /**
   * Deliver one recorded message to Codex.
   *
   * Long bodies are sent as ordered parts, each within the measured inline
   * ceiling, because `codex queue` takes its message only from the command line
   * and Windows caps that at 32,767 characters.
   *
   * @param {object} args
   * @param {string} args.messageId - the recorded message.
   * @returns {Promise<{ok: boolean, state: string, receipts: string[], error?: string}>} delivery result.
   */
  const deliverToCodex = async ({ messageId }) => {
    const message = load().messages_v2?.find((candidate) => candidate.messageId === messageId)
    if (message === undefined) return { ok: false, state: 'failed', receipts: [], error: 'message not recorded' }
    const pair = load().pairs[message.pairId]
    if (pair === undefined) return { ok: false, state: 'failed', receipts: [], error: `unknown pair ${message.pairId}` }

    const full = bodies.get(message.body.path)
    const parts = chunkBody(full, INLINE_LIMIT)
    const total = parts.length
    const receipts = []

    // Mark intent first: a crash after this point is detectable.
    await mutate((state) => {
      const target = state.messages_v2.find((candidate) => candidate.messageId === messageId)
      target.state = 'delivering'
      target.deliveringSince = Date.now()
      return true
    })

    try {
      for (const [index, part] of parts.entries()) {
        // Long bodies carry a machine-readable reference instead of the full text.
        const prefix =
          total === 1
            ? ''
            : `[part ${index + 1}/${total} of message ${messageId}] `
        const reference =
          total === 1
            ? ''
            : `\n\n[long body: message ${messageId}, part ${index + 1}/${total}, ${message.body.chars} chars total, ` +
              `full body at ${message.body.path}, sha256 ${message.body.sha256.slice(0, 16)}]`
        const receipt = await queueToCodex({ thread: pair.codexThread, message: `${prefix}${part}${reference}` })
        receipts.push(receipt.messageId ?? '(no id)')
      }
      await mutate((state) => {
        const target = state.messages_v2.find((candidate) => candidate.messageId === messageId)
        target.state = 'delivered'
        target.deliveredAt = Date.now()
        target.receipts = receipts
        target.attempts.push({ at: Date.now(), ok: true, receipts })
        return true
      })
      return { ok: true, state: 'delivered', receipts }
    } catch (error) {
      await mutate((state) => {
        const target = state.messages_v2.find((candidate) => candidate.messageId === messageId)
        // A failure after some parts were accepted leaves the sequence partial;
        // it is NOT safe to treat the message as delivered.
        target.state = receipts.length === 0 ? 'failed' : 'uncertain'
        target.attempts.push({ at: Date.now(), ok: false, error: String(error?.message ?? error), receipts })
        return true
      })
      return {
        ok: false,
        state: receipts.length === 0 ? 'failed' : 'uncertain',
        receipts,
        error: String(error?.message ?? error)
      }
    }
  }

  /**
   * Reconcile the delivery/commit crash window.
   *
   * A message left in `delivering` means the process died between asking the
   * transport and recording its answer. The honest resolution consults the
   * receiver's own log: if the message id is present there, it WAS delivered;
   * otherwise it is `uncertain` and an operator decides, because retrying might
   * duplicate and not retrying might lose it.
   *
   * @returns {Promise<{checked: number, resolved: object[], uncertain: object[]}>} reconciliation report.
   */
  const reconcile = async () => {
    const state = load()
    const pending = (state.messages_v2 ?? []).filter((message) => message.state === 'delivering')
    const resolved = []
    const uncertain = []

    for (const message of pending) {
      const pair = state.pairs[message.pairId]
      let evidence = { found: false, reason: 'no rollout path' }
      if (pair !== undefined && message.sender === 'dsh') {
        const rolloutPath = await findCodexRolloutPath(pair.codexThread)
        if (rolloutPath !== undefined) {
          // A part's receipt id is what would appear, but the queued message id is
          // what `codex queue` printed; we recorded neither on a crash, so look for
          // the message id itself first and fall back to reporting uncertainty.
          evidence = findCodexConsumption({ rolloutPath, messageId: message.messageId })
        }
      }
      if (evidence.found) {
        resolved.push({ messageId: message.messageId, evidence })
        await mutate((fresh) => {
          const target = fresh.messages_v2.find((candidate) => candidate.messageId === message.messageId)
          target.state = 'delivered'
          target.deliveredAt = Date.now()
          target.reconciledFrom = 'delivering'
          return true
        })
      } else {
        uncertain.push({ messageId: message.messageId, reason: evidence.reason })
        await mutate((fresh) => {
          const target = fresh.messages_v2.find((candidate) => candidate.messageId === message.messageId)
          target.state = 'uncertain'
          target.uncertainReason = evidence.reason
          return true
        })
      }
    }

    return { checked: pending.length, resolved, uncertain }
  }

  /**
   * Confirm consumption from the receiver's durable log.
   *
   * `codex queue`'s receipt proves acceptance only. This promotes a message to
   * `completed` solely when its id is found in the Codex rollout.
   *
   * @param {object} [args]
   * @param {string} [args.messageId] - check one message instead of all delivered ones.
   * @returns {Promise<{completed: string[], stillDelivered: object[]}>} check result.
   */
  const confirmCompletion = async ({ messageId } = {}) => {
    const state = load()
    const candidates = (state.messages_v2 ?? []).filter(
      (message) =>
        message.sender === 'dsh' &&
        (message.state === 'delivered' || (messageId !== undefined && message.messageId === messageId)) &&
        (messageId === undefined || message.messageId === messageId)
    )
    const completed = []
    const stillDelivered = []

    for (const message of candidates) {
      const pair = state.pairs[message.pairId]
      if (pair === undefined) continue
      const rolloutPath = await findCodexRolloutPath(pair.codexThread)
      if (rolloutPath === undefined) {
        stillDelivered.push({ messageId: message.messageId, reason: 'rollout path unknown' })
        continue
      }
      const receiptIds = message.receipts ?? []
      let evidence = { found: false, reason: 'no receipt id' }
      for (const receiptId of receiptIds) {
        evidence = findCodexConsumption({ rolloutPath, messageId: receiptId })
        if (evidence.found) break
      }
      if (evidence.found) {
        completed.push(message.messageId)
        await mutate((fresh) => {
          const target = fresh.messages_v2.find((candidate) => candidate.messageId === message.messageId)
          target.state = 'completed'
          target.completedAt = Date.now()
          target.consumptionEvidence = evidence
          return true
        })
      } else {
        stillDelivered.push({ messageId: message.messageId, reason: evidence.reason })
      }
    }

    return { completed, stillDelivered }
  }

  /**
   * Relay one task's reply back to Codex.
   *
   * A turn is forwarded only when it EXPLICITLY names the task it answers, via
   * the `[bridge-task <id>]` marker the task carried. Nothing is inferred from
   * wording and nothing is inferred from "a task happens to be open":
   *
   *  - without the marker, a completed turn (including one already delivered by
   *    hand through codex_send) is not relayed, so the peer never receives the
   *    same content twice;
   *  - with the marker, the reply is relayed once and the task is closed.
   *
   * Process narration carries no marker, so it stays out of the peer's
   * conversation without any keyword guessing.
   *
   * @param {object} args
   * @param {object} args.task - the open task being answered.
   * @param {object[]} args.turns - completed DSH turns from this session.
   * @returns {Promise<{forwarded: object[], skipped: object[]}>} relay decisions.
   */
  const relayReplies = async ({ task, turns }) => {
    const forwarded = []
    const skipped = []

    for (const turn of turns) {
      // Turns at or before the task request predate it and cannot answer it.
      if (turn.turn <= (task.requestTurn ?? 0)) {
        skipped.push({ turn: turn.turn, reason: 'completed before the task was sent' })
        continue
      }
      if (turn.turn === task.replyTurn) {
        skipped.push({ turn: turn.turn, reason: 'already relayed' })
        continue
      }
      const markedTaskId = extractTaskMarker(turn.text)
      if (markedTaskId === undefined) {
        skipped.push({ turn: turn.turn, reason: 'no [bridge-task] marker; treated as narration or hand-sent' })
        continue
      }
      if (markedTaskId !== task.taskId) {
        skipped.push({ turn: turn.turn, reason: `marker names ${markedTaskId}, not ${task.taskId}` })
        continue
      }
      if (isAcknowledgement(turn.text)) {
        skipped.push({ turn: turn.turn, reason: 'acknowledgement is terminal' })
        continue
      }
      const decision = shouldForwardTurn({ text: turn.text, taskId: task.taskId })
      if (!decision.forward) {
        skipped.push({ turn: turn.turn, reason: decision.reason })
        continue
      }

      const envelope = await record({
        pairId: task.pairId,
        sender: 'dsh',
        kind: 'result',
        text: turn.text,
        taskId: task.taskId,
        replyTo: task.requestMessageId
      })
      const delivery = await deliverToCodex({ messageId: envelope.messageId })
      await mutate((fresh) => {
        const target = fresh.tasks[task.taskId]
        target.replyTurn = turn.turn
        target.replyMessageId = envelope.messageId
        target.status = 'answered'
        return true
      })
      forwarded.push({ turn: turn.turn, messageId: envelope.messageId, state: delivery.state })
    }

    return { forwarded, skipped }
  }

  /**
   * Open a task and send it to DSH.
   *
   * @param {object} args
   * @param {string} args.pairId - the pair to send through.
   * @param {string} args.text - full task text (may be arbitrarily long).
   * @param {string} [args.taskId] - reuse an existing task id.
   * @param {'queue'|'steer'} [args.mode] - DSH delivery mode.
   * @returns {Promise<object>} the task and its delivery result.
   */
  const sendTaskToDsh = async ({ pairId, text, taskId, mode = 'queue' }) => {
    const state = load()
    const pair = state.pairs[pairId]
    if (pair === undefined) return { ok: false, error: `unknown pair ${pairId}` }

    // Baseline for correlation: a turn can only answer this task if it completed
    // after the task was delivered. Without this, any older finished turn would
    // look like an answer and get replayed to the peer.
    const baselineTurn = await latestTurnForPair(pair)

    const id = taskId ?? `task-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8)}`
    const envelope = await record({ pairId, sender: 'codex', kind: 'task', text, taskId: id })
    const handle = envelope.body

    // DSH's transport carries the body as JSON over loopback HTTP, so the
    // Windows command-line ceiling does not apply; the full text goes inline.
    // The marker rides along so the reply can name this task explicitly.
    const receipt = await dsh.prompt({ sessionId: pair.dshSessionId, text: `${taskMarker(id)}\n\n${text}`, mode })

    await mutate((fresh) => {
      fresh.tasks = fresh.tasks ?? {}
      fresh.tasks[id] = {
        taskId: id,
        pairId,
        status: 'open',
        createdAt: Date.now(),
        requestMessageId: envelope.messageId,
        requestTurn: baselineTurn,
        body: handle
      }
      const target = fresh.messages_v2.find((candidate) => candidate.messageId === envelope.messageId)
      target.state = 'delivered'
      target.deliveredAt = Date.now()
      target.receipts = ['dsh:accepted']
      return true
    })

    log(`[task] ${id} delivered to DSH (accepted=${String(receipt.accepted)})`)
    return { ok: true, taskId: id, messageId: envelope.messageId, accepted: receipt.accepted, baselineTurn }
  }

  /**
   * Open a task and send it to Codex — the mirror of {@link sendTaskToDsh}.
   *
   * Without this the service could only record tasks travelling DSH-ward, so a
   * task started from this side had no taskId, no correlation, and therefore no
   * relayed reply. Both directions now create the same kind of record.
   *
   * The marker travels with the prompt so the reply can name the task; when the
   * reply arrives as a DSH turn carrying that marker, the relay routes it back to
   * this side's originating session.
   *
   * @param {object} args
   * @param {string} args.pairId - the pair to send through.
   * @param {string} args.text - full task text (may be arbitrarily long).
   * @param {string} [args.taskId] - reuse an existing task id.
   * @returns {Promise<object>} the task and its delivery result.
   */
  const sendTaskToCodex = async ({ pairId, text, taskId }) => {
    const state = load()
    const pair = state.pairs[pairId]
    if (pair === undefined) return { ok: false, error: `unknown pair ${pairId}` }
    if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'text is required' }

    const id = taskId ?? `task-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8)}`

    // Baseline for correlation, exactly as the DSH-ward direction does: only a
    // turn completed after this point can be the reply.
    const baselineTurn = await latestTurnForPair(pair)

    // The marker goes on the wire first so the peer can echo it back verbatim.
    const marked = `${taskMarker(id)}\n\n${text}`
    const envelope = await record({ pairId, sender: 'codex', kind: 'task', text: marked, taskId: id })

    const delivery = await deliverToCodex({ messageId: envelope.messageId })

    await mutate((fresh) => {
      fresh.tasks = fresh.tasks ?? {}
      fresh.tasks[id] = {
        taskId: id,
        pairId,
        // `dir` records which way the task travels, so a reply can be routed back
        // to the originator instead of always being treated as DSH-ward.
        dir: 'to-codex',
        status: 'open',
        createdAt: Date.now(),
        requestMessageId: envelope.messageId,
        requestTurn: baselineTurn,
        body: envelope.body
      }
      return true
    })

    log(`[task] ${id} sent to Codex (${delivery.state}, ${delivery.receipts?.length ?? 0} part(s))`)
    return { ok: true, taskId: id, messageId: envelope.messageId, state: delivery.state, parts: delivery.receipts?.length ?? 0 }
  }

  /**
   * Close a `to-codex` task once its reply has arrived.
   *
   * @param {object} args
   * @param {string} args.taskId - the task being answered.
   * @param {object} [args.turn] - the DSH turn that carries the reply, when found.
   * @returns {Promise<{closed: boolean, reason?: string}>} whether the task closed.
   */
  const recordCodexReply = async ({ taskId, turn }) => {
    if (turn === undefined) return { closed: false, reason: 'no reply turn carrying this task marker yet' }
    await mutate((fresh) => {
      const task = fresh.tasks[taskId]
      if (task === undefined || task.status !== 'open') return true
      task.status = 'answered'
      task.replyTurn = turn.turn
      task.replyText = turn.text
      task.answeredAt = Date.now()
      return true
    })
    return { closed: true }
  }

  /**
   * Highest completed turn in a pair's DSH session right now, or 0.
   *
   * @param {object} pair - the bound pair.
   * @returns {Promise<number>} latest completed turn number.
   */
  const latestTurnForPair = async (pair) => {
    try {
      const turns = extractCompletedTurns(readSessionEvents(findSessionLog(undefined, pair.dshCwd, pair.dshSessionId)))
      return turns.length === 0 ? 0 : turns[turns.length - 1].turn
    } catch {
      return 0
    }
  }

  return {
    bodies,
    record,
    deliverToCodex,
    reconcile,
    confirmCompletion,
    relayReplies,
    sendTaskToDsh,
    sendTaskToCodex,
    recordCodexReply,
    /** Read a stored body by message id (for operators and tests). */
    readBody: (messageId) => {
      const message = load().messages_v2?.find((candidate) => candidate.messageId === messageId)
      if (message === undefined) return undefined
      return { text: bodies.get(message.body.path), handle: message.body, verify: bodies.verify(message.body) }
    }
  }
}

export { isAcknowledgement, shouldForwardTurn, taskMarker, extractTaskMarker }
