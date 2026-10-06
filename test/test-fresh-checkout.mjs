// Exercise the published artifact with no dependencies, runtime files, or agent env.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
assert.ok(existsSync(join(repo, 'src', 'broker.mjs')), 'Run this test from the generated/public repository')
const clean = mkdtempSync(join(tmpdir(), 'bridge-fresh-'))
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (/^(DSH_|CODEX_|BRIDGE_)/i.test(key)) delete env[key]
}
try {
  for (const item of ['src', 'test', 'scripts', 'plugin', 'README.md', 'LICENSE']) {
    cpSync(join(repo, item), join(clean, item), { recursive: true })
  }
  assert.equal(existsSync(join(clean, 'node_modules')), false)
  assert.equal(existsSync(join(clean, 'state.json')), false)
  for (const suite of ['test-v2.mjs', 'test-console.mjs', 'test-poll.mjs', 'test-onboarding.mjs']) {
    const result = spawnSync(process.execPath, [join('test', suite)], { cwd: clean, env, encoding: 'utf8', timeout: 90000 })
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 0, `${suite}\n${result.stdout}\n${result.stderr}`)
    process.stdout.write(result.stdout)
  }
  console.log('PASS fresh artifact: independent directory, no dependencies/state/env; isolated transports only')
} finally {
  rmSync(clean, { recursive: true, force: true })
}
