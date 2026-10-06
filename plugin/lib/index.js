/**
 * dsh-codex-bridge-tool — native DSH tools for driving a Codex session.
 *
 * Registers two model-facing tools on `ctx.tools`:
 *
 *  - `codex_send`   queue one message into the Codex session paired with the
 *                   CALLING DSH session, through the local dsh-bridge broker.
 *  - `codex_pairs`  report which DSH sessions are currently paired with which
 *                   Codex threads, so the agent can explain or debug the link.
 *
 * Design notes:
 *
 *  - Pairing is keyed by the calling agent's own session id (`exec.agent`), so a
 *    DSH agent never has to know internal pair ids or the Codex thread UUID: it
 *    just says what it wants delivered.
 *  - The broker address comes from `DSH_BRIDGE_URL`, then from `brokerUrl` in
 *    `$DSH_HOME/dsh-bridge.json`, then from the loopback default.
 *  - This package performs no delivery itself. It delegates to the broker over
 *    loopback HTTP, so there is exactly one place (broker.mjs) that owns state,
 *    idempotency, and the Codex CLI invocation.
 */

const name = 'codex-bridge-tool'

/** Services required before this plugin mounts. */
const inject = ['tools']

/** Loopback default the broker serves on. */
const DEFAULT_BROKER_URL = 'http://127.0.0.1:8791'

/** Read `$DSH_HOME`, falling back to the conventional location. */
function dshHome() {
  return process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? ''}\\.dsh`
}

/**
 * Import `@deepseek-ai/dsh-tools` through a fallback chain.
 *
 * The package is shipped by DeepSeek Harness and lives inside DSH's own profile
 * store, so a plain `import` only resolves when this plugin sits in that store
 * too. When the plugin is loaded from an arbitrary checkout, the plain import
 * fails with ERR_MODULE_NOT_FOUND, which would break the tools at run time.
 *
 * Order:
 *   1. a normal bare import (works when installed into the profile)
 *   2. `$DSH_TOOLS_PATH`, an explicit override for unusual layouts
 *   3. probing `$DSH_HOME/profiles/node_modules` and each profile's own
 *      `node_modules`, which is where DSH actually keeps it
 *
 * @returns {Promise<{defineTool: Function}>} the tools module.
 */
async function loadDshTools() {
  const attempts = []
  try {
    return await import('@deepseek-ai/dsh-tools')
  } catch (error) {
    attempts.push(`bare import: ${error?.code ?? error?.message}`)
  }

  const { pathToFileURL } = await import('node:url')
  const { join } = await import('node:path')

  const candidates = []
  if (process.env.DSH_TOOLS_PATH) candidates.push(process.env.DSH_TOOLS_PATH)
  const home = dshHome()
  candidates.push(join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
  // Per-profile stores, in case the shared store is absent.
  try {
    const { readdirSync } = await import('node:fs')
    for (const profile of readdirSync(join(home, 'profiles'))) {
      candidates.push(join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
    }
  } catch {
    // No profiles directory: the remaining candidates still stand.
  }

  for (const candidate of candidates) {
    try {
      return await import(pathToFileURL(candidate).href)
    } catch (error) {
      attempts.push(`${candidate}: ${error?.code ?? error?.message}`)
    }
  }

  throw new Error(
    `cannot load @deepseek-ai/dsh-tools; set DSH_TOOLS_PATH to its lib/index.js. Tried: ${attempts.join(' | ')}`
  )
}

/**
 * Resolve the broker base URL.
 *
 * @returns {Promise<string>} base URL without a trailing slash.
 */
async function brokerUrl() {
  if (process.env.DSH_BRIDGE_URL) return process.env.DSH_BRIDGE_URL.replace(/\/+$/u, '')
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  try {
    const parsed = JSON.parse(await readFile(join(dshHome(), 'dsh-bridge.json'), 'utf8'))
    if (typeof parsed.brokerUrl === 'string' && parsed.brokerUrl !== '') return parsed.brokerUrl.replace(/\/+$/u, '')
  } catch {
    // No side file: fall through to the loopback default.
  }
  return DEFAULT_BROKER_URL
}

/**
 * Resolve the broker's state file.
 *
 * Order: `$DSH_BRIDGE_STATE`, then `stateFile` in `$DSH_HOME/dsh-bridge.json`, then
 * the conventional `$DSH_HOME/dsh-bridge/state.json`. Nothing is hardcoded to a
 * particular checkout directory, so the package works wherever the bridge lives.
 *
 * @returns {Promise<string>} absolute path to the state file.
 */
async function stateFilePath() {
  if (process.env.DSH_BRIDGE_STATE) return process.env.DSH_BRIDGE_STATE
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  try {
    const parsed = JSON.parse(await readFile(join(dshHome(), 'dsh-bridge.json'), 'utf8'))
    if (typeof parsed.stateFile === 'string' && parsed.stateFile !== '') return parsed.stateFile
  } catch {
    // No side file: fall through to the conventional location.
  }
  return join(dshHome(), 'dsh-bridge', 'state.json')
}

/**
 * Load the broker's pair table.
 *
 * @returns {Promise<Record<string, {id: string, dshSessionId: string, codexThread: string, codexThreadName?: string}>>} pairs.
 */
async function loadPairs() {
  const { readFile } = await import('node:fs/promises')
  const parsed = JSON.parse(await readFile(await stateFilePath(), 'utf8'))
  return parsed.pairs ?? {}
}

/**
 * Find the pair whose DSH session is the calling session.
 *
 * @param {Record<string, object>} pairs - broker pair table.
 * @param {string} sessionId - the calling agent's session id.
 * @returns {object | undefined} the matching pair.
 */
function pairForSession(pairs, sessionId) {
  return Object.values(pairs).find((pair) => pair.dshSessionId === sessionId)
}

/**
 * POST one JSON body to the broker.
 *
 * @param {string} url - absolute URL.
 * @param {object} body - JSON body.
 * @param {AbortSignal} signal - caller cancellation.
 * @returns {Promise<object>} the decoded response body.
 */
async function post(url, body, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`broker returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`)
  }
  if (!response.ok) throw new Error(`broker HTTP ${response.status}: ${parsed.error ?? text.slice(0, 200)}`)
  return parsed
}

/**
 * Register the Codex-bridge tools.
 *
 * `@deepseek-ai/dsh-tools` is resolved through {@link loadDshTools} rather than a
 * bare import, so the plugin works both when installed into DSH's own profile
 * store and when it is loaded from an arbitrary checkout.
 *
 * @param {object} ctx - registrant context carrying the tool registry.
 * @returns {Promise<void>} resolves once both tools are registered.
 */
function apply(ctx) {
  return (async () => {
    const { defineTool } = await loadDshTools()

    ctx.tools.register(
      defineTool({
        name: 'codex_send',
        description:
          'Send a message to the Codex session paired with THIS DeepSeek Harness session, through the local dsh-bridge broker. ' +
          'Use it to hand a task to Codex, to report your result back to the Codex-side coordinator, or to ask Codex a question. ' +
          'Delivery is asynchronous: the tool returns once the message is queued, not when Codex answers. ' +
          'Codex replies arrive as normal user messages in this session. ' +
          'Requirements: the local broker must be running and this session must be paired. ' +
          'On failure the error explains whether the broker is unreachable or no pair exists.',
        parameters: {
          message: {
            type: 'string',
            required: true,
            description: 'The message body to deliver to the paired Codex session.'
          },
          pairId: {
            type: 'string',
            description: 'Optional pair id; omit to use the pair bound to THIS session.'
          }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              to: { type: 'string', required: true },
              messageId: { type: 'string' },
              error: { type: 'string' }
            }
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: value.ok
                ? `Delivered to Codex session ${value.to}${value.messageId === undefined ? '' : ` (message ${value.messageId})`}.`
                : `Delivery to Codex failed: ${value.error ?? 'unknown error'}`
            }
          ]
        },
        async execute(args, exec) {
          const sessionId = exec.agent?.session?.id
          const base = await brokerUrl()
          let pair
          try {
            const pairs = await loadPairs()
            pair = args.pairId === undefined
              ? (sessionId === undefined ? undefined : pairForSession(pairs, sessionId))
              : pairs[args.pairId]
          } catch (error) {
            return { ok: false, to: '', error: `cannot read broker state: ${error?.message ?? error}` }
          }
          if (pair === undefined) {
            return {
              ok: false,
              to: '',
              error:
                sessionId === undefined
                  ? 'this tool has no owning agent session, so no pair can be selected'
                  : `no Codex pair is bound to session ${sessionId}; create one with: node dsh-bridge/broker.mjs init <pairId> --dsh ${sessionId} --codex <codexThreadId>`
            }
          }
          try {
            const result = await post(`${base}/to-codex`, { pairId: pair.id, text: args.message }, exec.signal)
            return {
              ok: true,
              to: pair.codexThread,
              ...result.receipt?.messageId === undefined ? {} : { messageId: result.receipt.messageId }
            }
          } catch (error) {
            return {
              ok: false,
              to: pair.codexThread,
              error: `broker at ${base} unreachable or refused: ${error?.message ?? error}`
            }
          }
        },
        presentCall: (args) => ({
          card: 'generic',
          title: 'Send to Codex',
          kind: 'other',
          rawInput: args.message
        })
      })
    )

    ctx.tools.register(
      defineTool({
        name: 'codex_pairs',
        description:
          'List the Codex <-> DeepSeek Harness session pairings known to the local dsh-bridge broker. ' +
          'Use it to discover which Codex session is linked, or to diagnose why codex_send has no target.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              pairs: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    dshSessionId: { type: 'string', required: true },
                    codexThread: { type: 'string', required: true },
                    codexThreadName: { type: 'string' },
                    autoForward: { type: 'boolean', required: true },
                    lastTurn: { type: 'integer', required: true }
                  }
                }
              },
              error: { type: 'string' }
            }
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: value.ok
                ? value.pairs.length === 0
                  ? 'No pairs are registered.'
                  : value.pairs
                      .map(
                        (pair) =>
                          `${pair.id}: dsh=${pair.dshSessionId} -> codex=${pair.codexThread}` +
                          `${pair.codexThreadName === undefined ? '' : ` "${pair.codexThreadName}"`}` +
                          ` autoForward=${String(pair.autoForward)} lastTurn=${String(pair.lastTurn)}`
                      )
                      .join('\n')
                : `Cannot read pairs: ${value.error ?? 'unknown error'}`
            }
          ]
        },
        async execute() {
          try {
            const pairs = await loadPairs()
            return {
              ok: true,
              pairs: Object.values(pairs).map((pair) => ({
                id: pair.id,
                dshSessionId: pair.dshSessionId,
                codexThread: pair.codexThread,
                ...pair.codexThreadName === undefined ? {} : { codexThreadName: pair.codexThreadName },
                autoForward: pair.autoForward === true,
                lastTurn: Number(pair.lastTurn ?? 0)
              }))
            }
          } catch (error) {
            return { ok: false, pairs: [], error: String(error?.message ?? error) }
          }
        },
        presentCall: () => ({
          card: 'generic',
          title: 'List Codex pairs',
          kind: 'other',
          rawInput: {}
        })
      })
    )
  })()
}

export { apply, inject, name }
