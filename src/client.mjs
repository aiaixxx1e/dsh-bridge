// dsh-bridge/client.mjs
//
// DSH side of the Codex <-> DeepSeek Harness bridge.
//
// Delivers a user prompt into ANY existing DSH session over the local HTTP API
// (`/api/session/prompt`), which is the same RPC the DSH web client uses.
//
// Why this works (each fact verified against the shipped DSH 0.2.0-rc.2 code):
//  - `/api/<endpoint>` is a JSON RPC carrier. Request envelope:
//      { type: 'client-request', rpcId, method: '<endpoint>', payload }
//    Response envelope:
//      { type: 'server-response', rpcId, result: { ok: true, value } | { ok: false, error } }
//    (dsh-client-connection/lib/client.js, createWebConnectionRpc)
//  - `session/prompt` is an endpoint of @deepseek-ai/dsh-api-session-controller with
//      SessionPromptRequest  { requestId, sessionId, mode: 'queue' | 'steer', content, clientTimeZone? }
//      SessionPromptValue    { accepted: true }
//    "Receipt after one prompt enters the target Agent inbox."
//  - Two gates protect `/api`:
//      1. a Host/Origin trust fence  -> passes for loopback Host with no Origin
//      2. a browser-session cookie   -> HMAC-SHA256 signed with a secret that DSH
//         stores in $DSH_HOME/.credentials.yaml under
//         `client-connection/browser-session`. Because that secret is readable by
//         the local user, a local process can mint a valid cookie itself.
//
// Cookie format (dsh-client-connection/lib/index.js):
//   name  = 'dsh-auth-' + base64url(sha256(authority))
//   value = 'v1.' + base64url(JSON({version:1, authority, issuedAt, expiresAt}))
//           + '.' + base64url(HMAC-SHA256(secret, body))
//   authority = the request's Host header, e.g. '127.0.0.1:19387'

import { createHash, createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../src/session-log.mjs'

const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_PAYLOAD_VERSION = 1

/** base64url without padding, the encoding DSH uses on the wire. */
function b64url(input) {
  return Buffer.from(input).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/**
 * Read the browser-session signing secret from the DSH credential file.
 *
 * The file is a small YAML document. We avoid a YAML dependency by reading the
 * one path we need with a targeted regex, and we fail loudly when it is absent
 * so a silent misconfiguration cannot look like a network problem.
 *
 * @param {string} dshHome - DSH home directory ($DSH_HOME).
 * @returns {string} the raw base64url secret.
 */
export function readBrowserSessionSecret(dshHome) {
  const path = join(dshHome, '.credentials.yaml')
  const text = readFileSync(path, 'utf8')
  // Match the nested key under 'client-connection/browser-session:'.
  const anchor = text.indexOf('client-connection/browser-session:')
  if (anchor === -1) throw new Error(`no client-connection/browser-session record in ${path}`)
  const tail = text.slice(anchor)
  const match = /^\s*secret:\s*(\S+)\s*$/mu.exec(tail)
  if (!match) throw new Error(`no secret field for browser-session in ${path}`)
  const secret = match[1]
  const decoded = Buffer.from(secret.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  if (decoded.byteLength !== 32) throw new Error(`browser-session secret is not 32 bytes in ${path}`)
  return secret
}

/**
 * Mint a browser-session cookie for one authority.
 *
 * @param {string} secret - raw base64url secret from the credential file.
 * @param {string} authority - Host header value, e.g. '127.0.0.1:19387'.
 * @param {number} maxAgeMs - cookie lifetime in milliseconds.
 * @returns {{ name: string, value: string }} the cookie to send.
 */
export function mintSessionCookie(secret, authority, maxAgeMs = 24 * 60 * 60 * 1000) {
  const issuedAt = Date.now()
  const expiresAt = issuedAt + maxAgeMs
  const body = b64url(JSON.stringify({ version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt }))
  const signature = b64url(createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest())
  const name = COOKIE_PREFIX + b64url(createHash('sha256').update(authority).digest())
  return { name, value: `v1.${body}.${signature}` }
}

/** A DSH host connection: base URL + authority + a freshly minted cookie. */
export class DshClient {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl] - DSH web URL; defaults to $DSH_WEB_URL.
   * @param {string} [options.dshHome] - DSH home; defaults to $DSH_HOME.
   */
  constructor(options = {}) {
    this.baseUrl = options.baseUrl ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387'
    this.dshHome = options.dshHome ?? dshHome()
    const url = new URL(this.baseUrl)
    // DSH derives the cookie name and signature audience from the Host authority.
    this.authority = url.host || `${url.hostname}:19387`
    this.secret = readBrowserSessionSecret(this.dshHome)
  }

  /** Build the Cookie header for one request. */
  cookieHeader() {
    const cookie = mintSessionCookie(this.secret, this.authority)
    return `${cookie.name}=${cookie.value}`
  }

  /**
   * Invoke one Connection RPC endpoint on the `/api` channel.
   *
   * The Gateway requires the RPC payload to be exactly `{ args: <plain object> }`
   * (dsh-api-gateway: "Remote payload must contain exactly one plain-object args
   * field"), so callers pass the endpoint's named arguments and this method adds
   * that one wrapper.
   *
   * @param {string} endpoint - e.g. 'session/prompt'.
   * @param {Record<string, unknown>} args - the endpoint's named arguments.
   * @returns {Promise<unknown>} the endpoint value.
   */
  async call(endpoint, args) {
    const rpcId = randomUUID()
    const body = JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } })
    const response = await fetch(new URL(`/api/${endpoint}`, this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: this.cookieHeader(),
        // No Origin and no Sec-Fetch-Site: this is not a browser request, so the
        // trust fence accepts the loopback Host outright.
      },
      body,
      signal: AbortSignal.timeout(30_000)
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`dsh ${endpoint}: HTTP ${response.status} ${text.slice(0, 400)}`)
    const envelope = JSON.parse(text)
    if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId) {
      throw new Error(`dsh ${endpoint}: malformed response envelope ${text.slice(0, 400)}`)
    }
    const result = envelope.result
    if (result?.ok !== true) {
      const error = result?.error ?? {}
      throw new Error(`dsh ${endpoint} failed: ${error.code ?? 'unknown'} ${error.message ?? ''}`.trim())
    }
    return result.value
  }

  /**
   * Deliver one user message into an existing DSH session.
   *
   * @param {object} args
   * @param {string} args.sessionId - target session, e.g. 'session-00000000-...' (the 'session-' prefix is optional).
   * @param {string} args.text - message text.
   * @param {'queue'|'steer'} [args.mode] - 'queue' waits for the current turn; 'steer' interrupts it.
   * @returns {Promise<{accepted: true}>} DSH's receipt.
   */
  async prompt({ sessionId, text, mode = 'queue', requestId = randomUUID() }) {
    if (typeof text !== 'string' || text.trim() === '') throw new Error('prompt text must be non-empty')
    // Descriptor: prompt(request: SessionPromptRequest, signal: AbortSignal).
    // The trailing AbortSignal is descriptor metadata, never a wire argument.
    return this.call('session/prompt', {
      request: {
        requestId,
        sessionId,
        mode,
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      }
    })
  }

  /**
   * List known sessions (identity + title), ordered by activity.
   *
   * @param {object} [request] - SessionListRequest; only `cursor` is accepted.
   * @returns {Promise<{items: readonly unknown[]}>} the SessionListValue.
   */
  async listSessions(request = {}) {
    // Descriptor: list(_request: SessionListRequest, signal: AbortSignal).
    return this.call('session/list', { _request: request })
  }
}
