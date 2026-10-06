// Real HTTP servers, isolated state, injected agent transport. Never sends to agents.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSessionServer } from '../src/session-server.mjs'

const root = mkdtempSync(join(tmpdir(), 'bridge-console-'))
const statePath = join(root, 'state.json')
writeFileSync(statePath, JSON.stringify({ pairs: { demo: { id: 'demo', dshSessionId: 'session-fixture', codexThread: 'fixture' } } }))
const original = readFileSync(statePath, 'utf8')
let directCalls = 0
let requestBody
let reject = false
const broker = createServer(async (req, res) => {
  if (req.url === '/status') return res.end('{"ok":true}')
  assert.equal(req.url, '/send-task')
  let body = ''
  for await (const chunk of req) body += chunk
  requestBody = JSON.parse(body)
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(reject ? { ok: false, error: 'fixture rejected' } : { ok: true, accepted: true, taskId: 'fixture-task' }))
})
await new Promise(resolve => broker.listen(0, '127.0.0.1', resolve))
const brokerUrl = `http://127.0.0.1:${broker.address().port}`
const consoleApp = await createSessionServer({
  statePath, brokerUrl,
  env: { dshHome: { path: root }, dshUrl: 'http://invalid.fixture' },
  dsh: { prompt: async () => { directCalls++; throw new Error('Direct transport must never run') } }
})
await new Promise(resolve => consoleApp.server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${consoleApp.server.address().port}`
const send = body => fetch(`${url}/api/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
try {
  assert.equal((await fetch(url)).status, 200)
  const text = '中文\n"quoted"\\path ' + 'x'.repeat(40030)
  let response = await send({ pairId: 'demo', text, taskId: 'fixture-task', mode: 'queue' })
  let result = await response.json()
  assert.equal(result.relayed, true)
  assert.equal(result.via, 'broker')
  assert.deepEqual(requestBody, { pairId: 'demo', text, taskId: 'fixture-task', mode: 'queue' })
  reject = true
  result = await (await send({ pairId: 'demo', text: 'reject' })).json()
  assert.equal(result.relayed, false)
  assert.equal(result.ok, false)
  await new Promise(resolve => broker.close(resolve))
  response = await send({ pairId: 'demo', text: 'offline' })
  result = await response.json()
  assert.equal(response.status, 503)
  assert.equal(result.code, 'BROKER_UNAVAILABLE')
  assert.equal(result.relayed, false)
  assert.equal(directCalls, 0)
  assert.equal(readFileSync(statePath, 'utf8'), original)
  // Exercise the actual CLI, without reading installed agent credentials/state.
  writeFileSync(join(root, '.credentials.yaml'), `client-connection/browser-session:\n  secret: ${Buffer.alloc(32, 7).toString('base64url')}\n`)
  const cliEnv = { ...process.env }
  for (const key of Object.keys(cliEnv)) if (/^(DSH_|CODEX_|BRIDGE_)/i.test(key)) delete cliEnv[key]
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/session-server.mjs', import.meta.url)),
    '--port', '0', '--broker-port', String(new URL(brokerUrl).port), '--state', statePath,
    '--codex-home', root, '--dsh-home', root, '--codex-exe', process.execPath, '--dsh-root', root],
    { env: cliEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let errors = ''
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.stderr.on('data', chunk => { errors += chunk })
  try {
    const childUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CLI startup timeout: ${errors}`)), 20000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited ${code}: ${errors}`)) })
      child.stdout.on('data', chunk => {
        output += chunk
        const match = /连接台: (http:\/\/127\.0\.0\.1:\d+\/)/u.exec(output)
        if (match && output.includes('state file :')) { clearTimeout(timer); resolve(match[1]) }
      })
    })
    assert.ok(output.includes(`state file : ${statePath}`))
    const health = await (await fetch(`${childUrl}api/broker`)).json()
    assert.equal(health.url, brokerUrl)
    const pairs = await (await fetch(`${childUrl}api/pairs`)).json()
    assert.ok(JSON.stringify(pairs).includes('demo'))
  } finally {
    child.kill()
    await exited
  }
  console.log('PASS console: custom broker port, long JSON body, rejection, offline refusal, unchanged state')
  console.log('PASS console CLI: isolated homes, ephemeral port, custom broker port and state path')
} finally {
  await consoleApp.close()
  if (broker.listening) await new Promise(resolve => broker.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
