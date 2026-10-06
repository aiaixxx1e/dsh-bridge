// dsh-bridge/envelope.mjs
//
// The structured message contract both sides speak.
//
// Wire fields (all messages, both directions):
//   messageId   stable identity; the receiver deduplicates on it
//   taskId      the task this message belongs to (set by the task's opener)
//   replyTo     messageId this message answers, when it is a reply
//   pairId      which pairing carried it
//   sender      'codex' | 'dsh'
//   kind        task | result | question | status | ack
//   body        { path, bytes, chars, sha256 } — the full text lives in the body store
//   parts       delivery parts when the body exceeds the inline ceiling
//
// Lifecycle of a message, kept strictly apart:
//   accepted  — the receiving side admitted it (DSH: `{"accepted":true}`;
//               Codex: `codex queue` returned a queue receipt)
//   delivered — the receiving side is known to hold it
//   completed — the receiving side is known to have CONSUMED it (real evidence,
//               e.g. the message id appears in the Codex rollout)
//   uncertain — the delivery/commit window was interrupted; must be reconciled,
//               never reported as completed
//
// Nothing here claims exactly-once. The receiver's job is to deduplicate on
// messageId; this side's job is to retry only after checking the durable record,
// and to surface uncertainty rather than hide it.

/** Message kinds. `ack` exists specifically to end a loop. */
export const KINDS = ['task', 'result', 'question', 'status', 'ack']

/** Delivery/consumption states, ordered by strength of evidence. */
export const STATES = ['pending', 'accepted', 'delivered', 'completed', 'uncertain', 'failed']

/**
 * Validate a wire envelope.
 *
 * @param {object} value - candidate envelope.
 * @returns {{ok: true} | {ok: false, reason: string}} validation result.
 */
export function validateEnvelope(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'not an object' }
  for (const field of ['messageId', 'pairId', 'sender', 'kind']) {
    if (typeof value[field] !== 'string' || value[field] === '') return { ok: false, reason: `${field} must be a non-empty string` }
  }
  if (!KINDS.includes(value.kind)) return { ok: false, reason: `kind must be one of ${KINDS.join(', ')}` }
  if (!['codex', 'dsh'].includes(value.sender)) return { ok: false, reason: "sender must be 'codex' or 'dsh'" }
  if (value.taskId !== undefined && typeof value.taskId !== 'string') return { ok: false, reason: 'taskId must be a string' }
  if (value.replyTo !== undefined && typeof value.replyTo !== 'string') return { ok: false, reason: 'replyTo must be a string' }
  if (value.body === undefined || typeof value.body !== 'object' || value.body === null) return { ok: false, reason: 'body handle is required' }
  if (typeof value.body.path !== 'string' || typeof value.body.sha256 !== 'string') {
    return { ok: false, reason: 'body handle needs path and sha256' }
  }
  return { ok: true }
}

/**
 * May this message start another round on the receiving side?
 *
 * An `ack` never does, and neither does a `status`. This is what stops two
 * agents from answering each other's acknowledgements forever: an ack is a
 * terminal courtesy, not a prompt.
 *
 * @param {string} kind - the message kind.
 * @returns {boolean} true when the receiver should act on it.
 */
export function expectsAction(kind) {
  return kind === 'task' || kind === 'question'
}

/**
 * Extract the explicit task marker from a reply.
 *
 * The sender must echo the marker the task carried; nothing is inferred from
 * wording. This is what stops a completed turn from being relayed as "the
 * answer to whatever task happens to be open" — the failure that produced
 * duplicate reports before v2.
 *
 * @param {string} text - the reply text.
 * @returns {string | undefined} the task id the reply declares, when present.
 */
export function extractTaskMarker(text) {
  if (typeof text !== 'string') return undefined
  const match = /\[bridge-task\s+([A-Za-z0-9._:-]+)\]/u.exec(text)
  return match?.[1]
}

/**
 * Render the marker a task carries so its reply can name it.
 *
 * @param {string} taskId - the task id.
 * @returns {string} the marker line.
 */
export function taskMarker(taskId) {
  return `[bridge-task ${taskId}]`
}

/**
 * Should a completed DSH turn be forwarded back to Codex?
 *
 * Only when the turn is genuinely an answer to an outstanding task:
 *
 *  - the turn produced text (nothing to say means nothing to send);
 *  - the turn is linked to a task opened by Codex (`taskId` present);
 *  - the text is not merely an acknowledgement.
 *
 * Process narration ("let me check X", "now I will run Y") fails the taskId test
 * because it is not the answer to a task. This replaces the old keyword guess:
 * nothing is inferred from wording.
 *
 * @param {object} args
 * @param {string} args.text - the turn's visible text.
 * @param {string | undefined} args.taskId - task the turn answers, when known.
 * @returns {{forward: boolean, reason: string}} decision and why.
 */
export function shouldForwardTurn({ text, taskId }) {
  if (typeof text !== 'string' || text.trim() === '') return { forward: false, reason: 'empty turn' }
  if (taskId === undefined || taskId === '') return { forward: false, reason: 'not linked to an open task' }
  if (isAcknowledgement(text)) return { forward: false, reason: 'turn is an acknowledgement' }
  return { forward: true, reason: 'answer to an open task' }
}

/**
 * Acknowledgements that must never start another round.
 *
 * Ordering inside the alternation matters: `acknowledged` precedes `ack` so the
 * longer word is not cut short by the shorter alternative and then failed by the
 * end anchor. Longer CJK forms (`明白(?:了)?`) come before their stems for the
 * same reason.
 */
const ACK_PATTERN = /^\s*(\[[^\]]{0,40}\]\s*)?(收到|已收到|了解|明白(?:了)?|好的|acknowledged|ack|noted|roger|ok(?:ay)?)[。.!！,，\s]*$/iu

/**
 * Whether a reply is nothing but an acknowledgement.
 *
 * A heuristic is acceptable HERE and nowhere else, because a false negative only
 * means one extra message is sent, while a false positive would silently swallow
 * a real answer. The terminator in the pattern (end of string) is what keeps it
 * from matching a long answer that merely opens with "收到".
 *
 * @param {string} text - reply text.
 * @returns {boolean} true when the whole reply is an acknowledgement.
 */
export function isAcknowledgement(text) {
  return ACK_PATTERN.test(text)
}

/**
 * Build a wire envelope plus its body handle.
 *
 * @param {object} args - identity, kind, and body text.
 * @returns {object} the envelope to persist and deliver.
 */
export function makeEnvelope({ messageId, taskId, replyTo, pairId, sender, kind, body, parts, createdAt }) {
  return {
    messageId,
    ...taskId === undefined ? {} : { taskId },
    ...replyTo === undefined ? {} : { replyTo },
    pairId,
    sender,
    kind,
    body,
    ...parts === undefined ? {} : { parts },
    createdAt: createdAt ?? Date.now()
  }
}
