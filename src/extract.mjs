// dsh-bridge/extract.mjs
//
// Turn extraction: turn a DSH session log into whole assistant replies.
//
// A DSH turn is many steps, and each step emits its own `assistant/message`
// containing a mix of `reasoning`, `text`, and `tool-call` parts. Forwarding
// every one of those to a peer agent would spam it with fragments, so a reply is
// the CONCATENATION of the `text` parts across all assistant messages in one
// completed turn. The `turn/start` .. `turn/end` pair is the explicit boundary;
// `known-event-types.js` in dsh-session declares those types, and the log
// carries them verbatim.

/** Event type that opens a turn. */
const TURN_START = 'turn/start'
/** Event type that closes a turn. */
const TURN_END = 'turn/end'
/** Event carrying one assistant message. */
const ASSISTANT_MESSAGE = 'assistant/message'
/** Event carrying one user message. */
const USER_MESSAGE = 'user/message'

/**
 * Join the `text` parts of one assistant message, ignoring reasoning and tool calls.
 *
 * @param {object} event - an `assistant/message` event.
 * @returns {string} the visible text, trimmed.
 */
export function assistantText(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n\n')
    .trim()
}

/**
 * Join the `text` parts of one user message.
 *
 * @param {object} event - a `user/message` event.
 * @returns {string} the visible text, trimmed.
 */
export function userText(event) {
  const content = event?.data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n\n')
    .trim()
}

/**
 * Is this user message the operator's own input, rather than harness context?
 *
 * DSH injects `runtime-context` snapshots and other system-authored messages
 * into the same stream. Only `source.kind === 'user'` is a real human or bridge
 * message; an external bridge must not mistake a context snapshot for a request.
 *
 * @param {object} event - a `user/message` event.
 * @returns {boolean} true when the message came from a user.
 */
export function isUserAuthored(event) {
  return event?.data?.source?.kind === 'user'
}

/**
 * Extract completed turns from a session's events.
 *
 * A turn is complete only once its `turn/end` is present, so the last, still-open
 * turn never produces a forwardable reply.
 *
 * @param {object[]} events - decoded session events, in order.
 * @returns {Array<{turn: number, seq: number, text: string, requestId?: string}>} completed replies.
 */
export function extractCompletedTurns(events) {
  const turns = new Map()
  let current = null

  for (const event of events) {
    switch (event?.type) {
      case TURN_START: {
        const turn = Number(event.data?.turn ?? event.turn ?? 0)
        current = { turn, seq: event.seq, texts: [], requestId: undefined, open: true }
        turns.set(turn, current)
        break
      }
      case ASSISTANT_MESSAGE: {
        if (current === null) break
        const text = assistantText(event)
        if (text !== '') current.texts.push(text)
        break
      }
      case USER_MESSAGE: {
        // The prompt that opened this turn carries the bridge's idempotency key.
        if (current !== null && isUserAuthored(event) && current.requestId === undefined) {
          current.requestId = event.data?.source?.rpcId
        }
        break
      }
      case TURN_END: {
        const turn = Number(event.data?.turn ?? event.turn ?? current?.turn ?? 0)
        const entry = turns.get(turn) ?? current
        if (entry !== null && entry !== undefined) entry.open = false
        current = null
        break
      }
      default:
        break
    }
  }

  return [...turns.values()]
    .filter((entry) => entry.open === false)
    .map((entry) => ({
      turn: entry.turn,
      seq: entry.seq,
      text: entry.texts.join('\n\n').trim(),
      ...entry.requestId === undefined ? {} : { requestId: entry.requestId }
    }))
    .sort((a, b) => a.seq - b.seq)
}

/**
 * Pick replies worth forwarding after a given position.
 *
 * Empty turns are skipped: a turn that produced no prose would forward nothing
 * useful, and forwarding a placeholder would make the peer agent act on noise.
 *
 * @param {Array<{turn: number, seq: number, text: string}>} turns - extracted turns.
 * @param {number} afterTurn - only replies with a greater turn number are returned.
 * @returns {Array<{turn: number, seq: number, text: string}>} replies to forward.
 */
export function turnsAfter(turns, afterTurn) {
  return turns.filter((entry) => entry.turn > afterTurn && entry.text !== '')
}

/**
 * Detect whether a reply is asking the peer to confirm something, so the bridge
 * can mark it instead of silently continuing.
 *
 * This is a heuristic used only to add a header line; it never suppresses or
 * rewrites the reply itself.
 *
 * @param {string} text - the reply text.
 * @returns {boolean} true when the reply appears to need a human or peer decision.
 */
export function needsConfirmation(text) {
  return /(需要确认|请确认|确认一下|请你决定|等你确认|待确认|需要你|请你选择|二选一|是否继续|confirm|please confirm|need confirmation|waiting for (?:your )?(?:reply|confirmation|decision)|which (?:one|option))/iu.test(
    text
  )
}
