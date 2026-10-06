// dsh-bridge/session-server.mjs
//
// The middle service, with a web page.
//
// Shape:  Codex  <->  this service  <->  DeepSeek Harness
//
// The console manages pairing and inventory; the broker owns transport.
// Open the page, pick one Codex session and one DSH
// session by exact id, press connect. Everything else reuses the already-tested
// pieces (client.mjs / session-log.mjs / tasks.mjs / adapters.mjs / resolvers.mjs).
//
// Why a page instead of only a CLI: choosing a session means comparing ids,
// titles, workspaces and states, and a table you can filter is the honest way to
// present that. The same operations stay available over HTTP and the CLI, so the
// page is a view, not a second implementation.
//
// Location independence: every path comes from resolvers.mjs, and /api/diagnostics
// reports exactly what was found, where, and what failed — so an unusual install
// is diagnosable from the page instead of producing an empty list.

import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { listCodexSessions, listDshSessions, resolveExactSession, findCodexStateDb } from '../src/adapters.mjs'
import { DshClient } from '../src/client.mjs'
import { loadState, saveState, withStateLock } from '../src/broker.mjs'
import { diagnose, readProcesses, resolveCodexExe, resolveCodexHome, resolveDshHome, resolveDshLayout, resolveDshRoot } from '../src/resolvers.mjs'

const DEFAULT_STATE = fileURLToPath(new URL('../state.json', import.meta.url))
const DEFAULT_PORT = 8792
/** Relay owner. The broker owns relaying; this service only manages pairings. */
const DEFAULT_BROKER_PORT = 8791

/** Process names that identify each agent on this machine. */
const CODEX_PROCESS_NAMES = ['codex.exe', 'codex']
const DSH_PROCESS_NAMES = ['DeepSeek Harness.exe', 'DeepSeek Harness']

/**
 * Resolve every location this service needs, with full provenance.
 *
 * @param {object} [options]
 * @param {string} [options.codexHome] - explicit override.
 * @param {string} [options.dshHome] - explicit override.
 * @param {string} [options.codexExe] - explicit override.
 * @param {string} [options.dshRoot] - explicit override.
 * @param {string} [options.dshUrl] - explicit DSH web URL.
 * @returns {Promise<object>} resolved locations plus diagnostics.
 */
export async function resolveEnvironment(options = {}) {
  const codexProcesses = readProcesses(CODEX_PROCESS_NAMES)
  const dshProcesses = readProcesses(DSH_PROCESS_NAMES)

  const codexHome = resolveCodexHome({ override: options.codexHome, processes: codexProcesses })
  const codexExe = resolveCodexExe({ override: options.codexExe, processes: codexProcesses })
  const stateDb = await findCodexStateDb({ codexHome: codexHome.path })

  const dshHome = resolveDshHome({ override: options.dshHome })
  const dshRoot = resolveDshRoot({ override: options.dshRoot, processes: dshProcesses })
  const dshLayout = resolveDshLayout(dshRoot.path)

  const dshUrl = options.dshUrl ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387'

  return {
    codexHome,
    codexExe,
    stateDb,
    dshHome,
    dshRoot,
    dshLayout,
    dshUrl,
    counts: { codexProcesses: codexProcesses.length, dshProcesses: dshProcesses.length },
    diagnostics: {
      codexHome: diagnose([options.codexHome, process.env.CODEX_HOME, codexHome.path].filter(Boolean)),
      codexExe: diagnose([options.codexExe, process.env.CODEX_CLI_PATH, codexExe.path].filter(Boolean)),
      dshHome: diagnose([options.dshHome, process.env.DSH_HOME, dshHome.path].filter(Boolean)),
      dshRoot: diagnose([options.dshRoot, dshRoot.path].filter(Boolean)),
      stateDbCandidates: stateDb.tried
    }
  }
}

/**
 * Build a logger that also appends to a file when asked.
 *
 * The service writes its own log so a launcher never has to redirect its stdout:
 * `Start-Process -RedirectStandardOutput` blocks until the child exits, which
 * would make any backgrounding launcher hang for the service's lifetime.
 *
 * @param {string | undefined} file - log file path; omitted means stdout only.
 * @returns {(message: string) => void} the log sink.
 */
function createLogger(file) {
  if (file === undefined) return (message) => console.log(message)
  return (message) => {
    const line = `[${new Date().toISOString()}] ${message}\n`
    process.stdout.write(line)
    try {
      appendFileSync(file, line, 'utf8')
    } catch {
      // Logging must never take the service down.
    }
  }
}

/** Minimal HTML escaping for anything interpolated into the page. */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

/**
 * The single-page UI.
 *
 * Deliberately dependency-free: no CDN, no build step, so it works offline and
 * nothing external can fail at load time.
 *
 * @returns {string} the HTML document.
 */
function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex ↔ DeepSeek Harness 连接台</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; background: #14161a; color: #e6e8eb; }
  header { padding: 14px 18px; border-bottom: 1px solid #262a31; display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .muted { color: #8b93a1; font-size: 12px; }
  main { padding: 16px 18px 40px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  section { border: 1px solid #262a31; border-radius: 8px; overflow: hidden; background: #191c21; }
  section > h2 { margin: 0; padding: 10px 12px; font-size: 13px; background: #1e2228; border-bottom: 1px solid #262a31; display: flex; justify-content: space-between; align-items: center; }
  .toolbar { display: flex; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #262a31; }
  input[type=search] { flex: 1; background: #14161a; border: 1px solid #2f343d; color: inherit; border-radius: 6px; padding: 6px 9px; }
  button { background: #2b6cb0; border: 0; color: #fff; border-radius: 6px; padding: 6px 11px; cursor: pointer; font: inherit; }
  button.secondary { background: #2f343d; }
  button.danger { background: #8b2f2f; }
  button:disabled { opacity: .45; cursor: default; }
  .list { max-height: 380px; overflow: auto; }
  .row { padding: 9px 12px; border-bottom: 1px solid #22262d; cursor: pointer; display: grid; gap: 2px; }
  .row:hover { background: #1f242b; }
  .row.sel { background: #23364a; }
  .row.disabled { opacity: .45; cursor: not-allowed; }
  .id { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: #9ecbff; }
  .title { font-size: 13px; }
  .meta { font-size: 11px; color: #8b93a1; display: flex; gap: 10px; flex-wrap: wrap; }
  .tag { border: 1px solid #2f343d; border-radius: 4px; padding: 0 4px; }
  .tag.run { border-color: #2f7d4f; color: #7ee2a8; }
  .tag.sub { border-color: #7d6a2f; color: #e2cf7e; }
  .tag.unknown { border-color: #4a4f57; }
  .warn { margin: 0 0 14px; padding: 10px 12px; border: 1px solid #7d6a2f; background: #2a2618; border-radius: 8px; font-size: 12px; white-space: pre-wrap; }
  .pairs { margin-top: 18px; }
  .pair { padding: 10px 12px; border-bottom: 1px solid #22262d; display: flex; justify-content: space-between; gap: 12px; align-items: center; flex-wrap: wrap; }
  .arrow { color: #8b93a1; }
  details { margin-top: 18px; border: 1px solid #262a31; border-radius: 8px; background: #191c21; }
  summary { padding: 10px 12px; cursor: pointer; font-size: 13px; }
  pre { margin: 0; padding: 0 12px 12px; overflow: auto; font-size: 11.5px; color: #a9b1be; }
  .toast { position: fixed; right: 16px; bottom: 16px; background: #23364a; border: 1px solid #2f4a63; padding: 10px 13px; border-radius: 8px; max-width: 420px; display: none; }
  .toast.err { background: #3a1f1f; border-color: #7d3030; }
</style>
</head>
<body>
<header>
  <h1>Codex ↔ DeepSeek Harness 连接台</h1>
  <span class="muted" id="env"></span>
  <span style="flex:1"></span>
  <button id="refresh">刷新会话</button>
  <button id="diagBtn" class="secondary">位置诊断</button>
</header>
<main>
  <div id="warn"></div>

  <div class="grid">
    <section>
      <h2><span>Codex 会话</span><span class="muted" id="codexCount"></span></h2>
      <div class="toolbar">
        <input type="search" id="codexFilter" placeholder="按标题或 ID 过滤（仅过滤，不会自动选中）">
      </div>
      <div class="list" id="codexList"></div>
    </section>

    <section>
      <h2><span>DeepSeek Harness 会话</span><span class="muted" id="dshCount"></span></h2>
      <div class="toolbar">
        <input type="search" id="dshFilter" placeholder="按标题或 ID 过滤（仅过滤，不会自动选中）">
      </div>
      <div class="list" id="dshList"></div>
    </section>
  </div>

  <div style="margin-top:16px; display:flex; gap:10px; align-items:center; flex-wrap:wrap">
    <button id="connect">连接所选两个会话</button>
    <span class="muted" id="selection">未选择</span>
  </div>

  <section class="pairs">
    <h2><span>已建立的连接</span><span class="muted" id="pairCount"></span></h2>
    <div id="pairList"></div>
  </section>

  <details id="diag">
    <summary>位置诊断（安装位置无关性）</summary>
    <pre id="diagBody"></pre>
  </details>
</main>
<div class="toast" id="toast"></div>
<script>
const state = { codex: [], dsh: [], selectedCodex: null, selectedDsh: null, pairs: [] }

const $ = (id) => document.getElementById(id)

function toast(message, isError) {
  const node = $('toast')
  node.textContent = message
  node.className = isError ? 'toast err' : 'toast'
  node.style.display = 'block'
  clearTimeout(node._timer)
  node._timer = setTimeout(() => { node.style.display = 'none' }, isError ? 9000 : 4500)
}

function tag(text, cls) {
  const span = document.createElement('span')
  span.className = 'tag ' + (cls || '')
  span.textContent = text
  return span
}

function renderList(container, sessions, side) {
  container.textContent = ''
  if (sessions.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'row muted'
    empty.textContent = side === 'codex' ? '未发现 Codex 会话（看下方「位置诊断」）' : '未发现 DSH 会话（确认 DSH 正在运行）'
    container.appendChild(empty)
    return
  }
  for (const session of sessions) {
    const row = document.createElement('div')
    row.className = 'row' + (session.bindable === false ? ' disabled' : '')
    const selected = side === 'codex' ? state.selectedCodex : state.selectedDsh
    if (selected === session.id) row.classList.add('sel')

    const id = document.createElement('div')
    id.className = 'id'
    id.textContent = session.id
    row.appendChild(id)

    const title = document.createElement('div')
    title.className = 'title'
    title.textContent = session.title || '(无标题)'
    row.appendChild(title)

    const meta = document.createElement('div')
    meta.className = 'meta'
    meta.appendChild(tag('工作区: ' + (session.workspace || 'unknown')))
    if (session.running === 'unknown') meta.appendChild(tag('运行状态: unknown', 'unknown'))
    else meta.appendChild(tag(session.running ? '运行中' : '空闲', session.running ? 'run' : ''))
    if (session.archived === true) meta.appendChild(tag('已归档'))
    if (session.kind === 'subagent') meta.appendChild(tag('子代理·不可绑定', 'sub'))
    if (session.updatedAt && session.updatedAt !== 'unknown') meta.appendChild(tag(session.updatedAt.slice(0, 19).replace('T', ' ')))
    row.appendChild(meta)

    if (session.bindable !== false) {
      row.addEventListener('click', () => {
        if (side === 'codex') state.selectedCodex = state.selectedCodex === session.id ? null : session.id
        else state.selectedDsh = state.selectedDsh === session.id ? null : session.id
        renderAll()
      })
    }
    container.appendChild(row)
  }
}

function renderSelection() {
  const codex = state.selectedCodex ? state.selectedCodex.slice(0, 12) + '…' : '未选'
  const dsh = state.selectedDsh ? state.selectedDsh.slice(0, 20) + '…' : '未选'
  $('selection').textContent = 'Codex: ' + codex + '   |   DSH: ' + dsh
  $('connect').disabled = !(state.selectedCodex && state.selectedDsh)
}

function renderPairs() {
  const container = $('pairList')
  container.textContent = ''
  $('pairCount').textContent = state.pairs.length + ' 个'
  if (state.pairs.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'pair muted'
    empty.textContent = '还没有连接。在上方各选一个会话，然后点「连接所选两个会话」。'
    container.appendChild(empty)
    return
  }
  for (const pair of state.pairs) {
    const row = document.createElement('div')
    row.className = 'pair'
    const text = document.createElement('div')
    const strong = document.createElement('div')
    strong.textContent = pair.id
    const detail = document.createElement('div')
    detail.className = 'muted id'
    detail.textContent = 'Codex ' + pair.codexThread + '  ' + '↔' + '  DSH ' + pair.dshSessionId
    text.appendChild(strong)
    text.appendChild(detail)
    if (pair.codexThreadName) {
      const name = document.createElement('div')
      name.className = 'muted'
      name.textContent = pair.codexThreadName
      text.appendChild(name)
    }
    if (pair.onboarding) {
      const info = document.createElement('div')
      info.className = 'muted'
      const label = (entry) => entry?.state === 'delivered' ? '已投递' : entry ? '待核实' : '待发送'
      info.textContent = '使用说明：Codex ' + label(pair.onboarding.sides?.codex) + ' · DeepSeek ' + label(pair.onboarding.sides?.dsh)
      text.appendChild(info)
    }
    row.appendChild(text)
    const actions = document.createElement('div')
    const guide = document.createElement('button')
    guide.className = 'secondary'
    guide.textContent = '重新发送使用说明'
    guide.addEventListener('click', async () => {
      guide.disabled = true
      try {
        const response = await fetch('/api/onboard', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pairId: pair.id, force: true }) })
        const result = await response.json()
        if (!result.ok) throw new Error(result.error || '部分投递未确认，请查看说明状态')
        toast('使用说明已投递给双方')
        await loadPairs()
      } catch (error) { toast('说明投递未完成: ' + error.message, true) }
      finally { guide.disabled = false }
    })
    actions.appendChild(guide)
    const remove = document.createElement('button')
    remove.className = 'danger'
    remove.textContent = '解除连接'
    remove.addEventListener('click', async () => {
      if (!confirm('解除连接 ' + pair.id + ' ？（不会删除任何会话，只解除配对）')) return
      try {
        const response = await fetch('/api/pairs/' + encodeURIComponent(pair.id), { method: 'DELETE' })
        const body = await response.json()
        if (!body.ok) throw new Error(body.error || 'failed')
        toast('已解除 ' + pair.id)
        await loadPairs()
      } catch (error) { toast('解除失败: ' + error.message, true) }
    })
    actions.appendChild(remove)
    row.appendChild(actions)
    container.appendChild(row)
  }
}

function renderAll() {
  renderList($('codexList'), filter(state.codex, $('codexFilter').value), 'codex')
  renderList($('dshList'), filter(state.dsh, $('dshFilter').value), 'dsh')
  renderSelection()
}

function filter(sessions, needle) {
  const q = (needle || '').trim().toLowerCase()
  if (!q) return sessions
  return sessions.filter((s) => (s.id + ' ' + (s.title || '')).toLowerCase().includes(q))
}

async function loadSessions() {
  $('codexList').innerHTML = '<div class="row muted">加载中…</div>'
  $('dshList').innerHTML = '<div class="row muted">加载中…</div>'
  try {
    const response = await fetch('/api/sessions')
    const body = await response.json()
    state.codex = body.codex?.sessions ?? []
    state.dsh = body.dsh?.sessions ?? []
    $('codexCount').textContent = state.codex.length + ' 条 · ' + (body.codex?.source ?? '?')
    $('dshCount').textContent = state.dsh.length + ' 条 · ' + (body.dsh?.source ?? '?')
    const warnings = []
    if (body.codex?.warning) warnings.push('Codex 发现告警: ' + body.codex.warning)
    if (body.dsh?.warning) warnings.push('DSH 发现告警: ' + body.dsh.warning)
    $('warn').innerHTML = warnings.length ? '<div class="warn">' + warnings.join('\\n') + '</div>' : ''
    renderAll()
  } catch (error) {
    $('warn').innerHTML = '<div class="warn">无法读取会话列表: ' + error.message + '</div>'
  }
}

async function loadPairs() {
  try {
    const response = await fetch('/api/pairs')
    const body = await response.json()
    state.pairs = body.pairs ?? []
  } catch { state.pairs = [] }
  renderPairs()
}

async function loadDiagnostics() {
  try {
    const response = await fetch('/api/diagnostics')
    const body = await response.json()
    $('env').textContent = 'DSH ' + body.dshUrl + ' · state ' + (body.statePath || '')
    $('diagBody').textContent = JSON.stringify(body, null, 2)
    return body
  } catch (error) {
    $('diagBody').textContent = '诊断读取失败: ' + error.message
  }
}

$('refresh').addEventListener('click', loadSessions)
$('diagBtn').addEventListener('click', async () => {
  const body = await loadDiagnostics()
  $('diag').open = true
  if (body) toast('诊断已更新')
})
$('codexFilter').addEventListener('input', renderAll)
$('dshFilter').addEventListener('input', renderAll)

$('connect').addEventListener('click', async () => {
  if (!state.selectedCodex || !state.selectedDsh) return
  const codexSession = state.codex.find((s) => s.id === state.selectedCodex)
  const dshSession = state.dsh.find((s) => s.id === state.selectedDsh)
  const label = '建立连接？\\n\\n  Codex: ' + state.selectedCodex + '\\n         ' + (codexSession?.title || '') +
    '\\n  DSH  : ' + state.selectedDsh + '\\n         ' + (dshSession?.title || '') +
    '\\n\\n只绑定这两个已有会话，不会新建、不会改动任何会话内容。'
  if (!confirm(label)) return
  try {
    const response = await fetch('/api/pairs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codex: state.selectedCodex, dsh: state.selectedDsh })
    })
    const body = await response.json()
    if (!body.ok) throw new Error((body.error || 'failed') + (body.candidates ? ' 候选: ' + body.candidates.map((c) => c.id).join(', ') : ''))
    toast(body.warning || ('已连接，使用说明已投递: ' + body.pair.id), !!body.warning)
    await loadPairs()
  } catch (error) { toast('连接失败: ' + error.message, true) }
})

loadDiagnostics().then(loadSessions)
loadPairs()
</script>
</body>
</html>`
}

/**
 * Build the service.
 *
 * @param {object} options
 * @param {string} [options.statePath] - pairing state file.
 * @param {object} [options.env] - resolved environment (from resolveEnvironment).
 * @param {(message: string) => void} [options.log] - log sink.
 * @returns {Promise<{server: import('node:http').Server, env: object, close: () => Promise<void>}>} the service.
 */
export async function createSessionServer(options = {}) {
  const statePath = options.statePath ?? process.env.DSH_BRIDGE_STATE ?? DEFAULT_STATE
  const log = options.log ?? ((message) => console.log(message))
  const env = options.env ?? (await resolveEnvironment(options))

  const dsh = options.dsh ?? new DshClient({ baseUrl: env.dshUrl, dshHome: env.dshHome.path })
  const brokerUrl = options.brokerUrl ?? process.env.DSH_BRIDGE_BROKER_URL ?? `http://127.0.0.1:${DEFAULT_BROKER_PORT}`
  const readState = () => loadState(statePath)
  const mutate = (operation) =>
    withStateLock(statePath, async () => {
      const fresh = loadState(statePath)
      await operation(fresh)
      saveState(fresh, statePath)
    })

  /**
   * Is the relay broker running?
   *
   * The broker owns relaying (it polls turn boundaries and delivers task replies),
   * and it holds the same state file. This service therefore never relays: running
   * two writers would let one overwrite the other's cursor, which is exactly the
   * duplicate-delivery bug already seen once. Sending goes THROUGH the broker when
   * it is up, so a task opened from this page is still correlated and relayed.
   *
   * @returns {Promise<boolean>} true when the broker answers.
   */
  const brokerAlive = async () => {
    try {
      const response = await fetch(`${brokerUrl}/status`, { signal: AbortSignal.timeout(3000) })
      return response.ok
    } catch {
      return false
    }
  }

  const sendJson = (response, status, body) => {
    const text = JSON.stringify(body)
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(text)
  }
  const readJsonBody = async (request) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    try {
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = renderPage()
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(html)
        return
      }

      if (request.method === 'GET' && url.pathname === '/api/sessions') {
        const filter = url.searchParams.get('filter') ?? undefined
        const [codex, dshList] = await Promise.all([
          listCodexSessions({ filter: filter ?? undefined, codexHome: env.codexHome.path }),
          listDshSessions(dsh, { filter: filter ?? undefined })
        ])
        sendJson(response, 200, { ok: true, codex, dsh: dshList })
        return
      }

      if (request.method === 'GET' && url.pathname === '/api/diagnostics') {
        sendJson(response, 200, {
          ok: true,
          statePath,
          dshUrl: env.dshUrl,
          codexHome: env.codexHome,
          codexExe: env.codexExe,
          stateDb: env.stateDb,
          dshHome: env.dshHome,
          dshRoot: env.dshRoot,
          dshLayout: env.dshLayout,
          counts: env.counts,
          paths: env.diagnostics
        })
        return
      }

      if (request.method === 'GET' && url.pathname === '/api/pairs') {
        const state = readState()
        sendJson(response, 200, {
          ok: true,
          pairs: Object.values(state.pairs).map((pair) => ({
            id: pair.id,
            codexThread: pair.codexThread,
            codexThreadName: pair.codexThreadName,
            dshSessionId: pair.dshSessionId,
            dshCwd: pair.dshCwd,
            createdAt: pair.createdAt,
            autoForward: pair.autoForward === true,
            legacyAutoForward: pair.legacyAutoForward === true,
            onboarding: pair.onboarding
          }))
        })
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/pairs') {
        const body = await readJsonBody(request)
        if (typeof body.codex !== 'string' || typeof body.dsh !== 'string') {
          sendJson(response, 400, { ok: false, error: 'codex and dsh exact ids are required' })
          return
        }
        // Exact-id resolution on both sides before anything is written.
        const codexResolved = await resolveExactSession('codex', body.codex, { dsh, codexHome: env.codexHome.path })
        if (!codexResolved.ok) {
          sendJson(response, 400, { ok: false, error: codexResolved.error, candidates: codexResolved.candidates })
          return
        }
        const dshResolved = await resolveExactSession('dsh', body.dsh, { dsh })
        if (!dshResolved.ok) {
          sendJson(response, 400, { ok: false, error: dshResolved.error, candidates: dshResolved.candidates })
          return
        }
        const pairId = typeof body.pairId === 'string' && body.pairId !== '' ? body.pairId : `pair-${Date.now()}`
        let bound
        await mutate((state) => {
          const existing = state.pairs[pairId]
          state.pairs[pairId] = {
            id: pairId,
            dshSessionId: dshResolved.session.id,
            dshCwd: dshResolved.session.workspace === 'unknown' ? process.cwd() : dshResolved.session.workspace,
            codexThread: codexResolved.session.id,
            codexThreadName: codexResolved.session.title,
            autoForward: false,
            legacyAutoForward: false,
            onboardingEnabled: true,
            onboarding: existing?.onboarding,
            lastTurn: existing?.lastTurn ?? 0,
            createdAt: existing?.createdAt ?? Date.now()
          }
          bound = state.pairs[pairId]
          return true
        })
        log(`[pair] connected ${pairId}: codex=${bound.codexThread} dsh=${bound.dshSessionId}`)
        let guide
        try {
          const result = await fetch(`${brokerUrl}/onboard`, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pairId }), signal: AbortSignal.timeout(30_000) })
          guide = await result.json()
        } catch (error) {
          guide = { ok: false, pending: true, error: '连接已保存；中继恢复后自动投递说明。' }
        }
        sendJson(response, 200, { ok: true, pair: bound, guide,
          warning: guide.ok ? undefined : (guide.error ?? '连接已保存，部分使用说明投递未确认。') })
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/onboard') {
        const body = await readJsonBody(request)
        if (typeof body.pairId !== 'string' || !readState().pairs[body.pairId]) {
          return sendJson(response, 404, { ok: false, error: 'unknown pairId' })
        }
        const result = await fetch(`${brokerUrl}/onboard`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pairId: body.pairId, force: body.force === true }), signal: AbortSignal.timeout(30_000) })
        return sendJson(response, result.status, await result.json())
      }

      if (request.method === 'DELETE' && url.pathname.startsWith('/api/pairs/')) {
        const pairId = decodeURIComponent(url.pathname.slice('/api/pairs/'.length))
        let removed = false
        await mutate((state) => {
          if (state.pairs[pairId] !== undefined) {
            delete state.pairs[pairId]
            removed = true
          }
          return true
        })
        if (!removed) {
          sendJson(response, 404, { ok: false, error: `unknown pair ${pairId}` })
          return
        }
        log(`[pair] disconnected ${pairId}`)
        sendJson(response, 200, { ok: true })
        return
      }

      // Send a message into a paired DSH session from the page.
      if (request.method === 'POST' && url.pathname === '/api/send') {
        const body = await readJsonBody(request)
        const pair = readState().pairs[body.pairId]
        if (pair === undefined) {
          sendJson(response, 404, { ok: false, error: `unknown pair ${body.pairId}` })
          return
        }
        if (typeof body.text !== 'string' || body.text.trim() === '') {
          sendJson(response, 400, { ok: false, error: 'text is required' })
          return
        }
        // A direct prompt would bypass task registration and lose reply relay.
        // Leave the request unsent when the relay owner is unavailable.
        if (await brokerAlive()) {
          const relayed = await fetch(`${brokerUrl}/send-task`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pairId: body.pairId, text: body.text, taskId: body.taskId, mode: body.mode }),
            signal: AbortSignal.timeout(60_000)
          })
          const relayedBody = await relayed.json()
          const accepted = relayed.ok && relayedBody.ok === true
          sendJson(response, accepted ? 200 : 502, {
            ...relayedBody,
            ok: accepted,
            via: 'broker',
            relayed: accepted
          })
          return
        }
        sendJson(response, 503, {
          ok: false,
          code: 'BROKER_UNAVAILABLE',
          relayed: false,
          error: '中继服务未运行，任务尚未发送；启动中继服务后重试。'
        })
        return
      }

      if (request.method === 'GET' && url.pathname === '/api/broker') {
        const alive = await brokerAlive()
        sendJson(response, 200, { ok: true, url: brokerUrl, alive })
        return
      }

      sendJson(response, 404, { ok: false, error: `no route ${request.method} ${url.pathname}` })
    } catch (error) {
      log(`[error] ${request.method} ${url.pathname}: ${error?.message ?? error}`)
      sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  return {
    server,
    env,
    statePath,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

/**
 * Build a full self-contained HTML snapshot of a session list.
 *
 * Exported so a diagnostics dump can be produced without opening the browser.
 *
 * @param {object} env - resolved environment.
 * @returns {string} diagnostics HTML fragment.
 */
export function diagnosticsFragment(env) {
  return `<pre>${escapeHtml(JSON.stringify(env.diagnostics, null, 2))}</pre>`
}

/** CLI entry: `node session-server.mjs [--port 8792] [--broker-port 8791] [--codex-home P] [--dsh-home P] [--open]`. */
async function main() {
  const argv = process.argv.slice(2)
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) flags[key] = true
    else {
      flags[key] = next
      index += 1
    }
  }
  const port = Number(flags.port ?? DEFAULT_PORT)
  const log = createLogger(typeof flags.log === 'string' ? flags.log : undefined)
  const env = await resolveEnvironment({
    codexHome: typeof flags['codex-home'] === 'string' ? flags['codex-home'] : undefined,
    dshHome: typeof flags['dsh-home'] === 'string' ? flags['dsh-home'] : undefined,
    codexExe: typeof flags['codex-exe'] === 'string' ? flags['codex-exe'] : undefined,
    dshRoot: typeof flags['dsh-root'] === 'string' ? flags['dsh-root'] : undefined,
    dshUrl: typeof flags['dsh-url'] === 'string' ? flags['dsh-url'] : undefined
  })

  // `--broker-port` must reach the broker URL, otherwise a broker started on a
  // non-default port would otherwise be invisible to this console.
  const brokerPort = Number(flags['broker-port'] ?? DEFAULT_BROKER_PORT)
  const built = await createSessionServer({
    env,
    log,
    statePath: typeof flags.state === 'string' ? flags.state : undefined,
    brokerUrl: typeof flags['broker-url'] === 'string' ? flags['broker-url'] : `http://127.0.0.1:${brokerPort}`
  })
  await new Promise((resolve) => built.server.listen(port, '127.0.0.1', resolve))

  const url = `http://127.0.0.1:${built.server.address().port}/`
  log(`Codex ↔ DSH 连接台: ${url}`)
  log(`  Codex home : ${env.codexHome.path ?? '(not found)'}  [${env.codexHome.source}]`)
  log(`  Codex exe  : ${env.codexExe.path ?? '(not found)'}  [${env.codexExe.source}]`)
  log(`  state db   : ${env.stateDb.path ?? '(not found)'}  [${env.stateDb.detail}]`)
  log(`  DSH home   : ${env.dshHome.path ?? '(not found)'}  [${env.dshHome.source}]`)
  log(`  DSH root   : ${env.dshRoot.path ?? '(not found)'}  [${env.dshRoot.source}]`)
  log(`  DSH web    : ${env.dshUrl}`)
  log(`  state file : ${built.statePath}`)

  if (flags.open === true) {
    const { execFile } = await import('node:child_process')
    execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true }, () => {})
  }
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  await main()
}
