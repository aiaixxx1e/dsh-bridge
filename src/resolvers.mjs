// dsh-bridge/resolvers.mjs
//
// Install-location discovery for both agents.
//
// The service must work on machines where Codex and DeepSeek Harness are NOT in
// their default locations, and where the user never set CODEX_HOME / DSH_HOME.
// So nothing here relies on a default path. Each root is resolved through an
// ordered chain of *evidence*, and every resolution reports how it was found and
// what failed, so the web UI can explain a failure instead of showing an empty
// list.
//
// Chains, in order of reliability:
//
//   1. an explicit override (service config)
//   2. an environment variable
//   3. the running application's own process information (its executable path is
//      authoritative: it is where the app actually is, whatever the installer did)
//   4. probe-based scanning of known and adjacent parents
//
// Stability rules learned from the real install:
//
//   - the Codex CLI lives in a RANDOM hash directory whose siblings may lack the
//     executable entirely (4 sibling dirs, only 1 had codex.exe), so a version
//     directory is chosen by "contains the executable", never by name order;
//   - the Codex state database carries a schema version in its NAME
//     (state_5.sqlite), which will change on upgrade, so the database is chosen by
//     PROBING for the table we need, never by file name;
//   - the DSH home is not implied by the install path, and vice versa.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** How a root was found, for display and diagnosis. */
export const SOURCE = {
  override: 'explicit override',
  env: 'environment variable',
  process: 'running process',
  probe: 'probed location',
  default: 'conventional default',
  missing: 'not found'
}

/**
 * Normalize a Windows path from a command line.
 *
 * Command lines quote paths and often carry the `\\?\` extended-length prefix,
 * which breaks `join` and `existsSync` on some APIs; strip both.
 *
 * @param {string} value - raw path text.
 * @returns {string} a plain absolute path.
 */
export function normalizePath(value) {
  return value.replace(/^\\\\\?\\/u, '').replace(/^"|"$/gu, '').trim()
}

/**
 * Read the CommandLine and ExecutablePath of running processes by name.
 *
 * This is the most location-independent evidence available: whatever an
 * installer did, the running process knows where its own executable is.
 *
 * @param {string[]} names - process names to match, case-insensitively.
 * @returns {Array<{pid: number, name: string, exe: string, commandLine: string}>} matches.
 */
export function readProcesses(names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress -Depth 2'
  let raw
  try {
    raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024
    })
  } catch {
    return []
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows
    .filter((row) => row?.Name !== undefined && wanted.has(String(row.Name).toLowerCase()))
    .map((row) => ({
      pid: Number(row.ProcessId),
      name: String(row.Name),
      exe: row.ExecutablePath === undefined || row.ExecutablePath === null ? '' : normalizePath(String(row.ExecutablePath)),
      commandLine: row.CommandLine === undefined || row.CommandLine === null ? '' : String(row.CommandLine)
    }))
}

/**
 * Collect candidate directories from a seed path: itself, its parents, and the
 * parents' immediate children.
 *
 * Used when the exact directory is unknown but a neighbouring one is known — for
 * example deriving the DSH install root from the launched executable, or finding
 * a profile whose name the user chose.
 *
 * @param {string} seed - starting directory.
 * @param {number} [levels] - how many parent levels to include.
 * @returns {string[]} unique candidate directories, nearest first.
 */
export function neighbourDirs(seed, levels = 2) {
  const seen = new Set()
  const result = []
  let current = seed
  for (let level = 0; level <= levels; level += 1) {
    if (current === '' || !existsSync(current)) break
    if (!seen.has(current)) {
      seen.add(current)
      result.push(current)
    }
    let children = []
    try {
      children = readdirSync(current, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(current, entry.name))
    } catch {
      children = []
    }
    for (const child of children) {
      if (!seen.has(child)) {
        seen.add(child)
        result.push(child)
      }
    }
    const parent = current.replace(/[\\/][^\\/]+$/u, '')
    if (parent === current || parent === '') break
    current = parent
  }
  return result
}

/**
 * Pick the newest entry from a list of candidate directories.
 *
 * "Newest" is by modification time, not by name: the Codex CLI directory is a
 * random hash, so lexical order is meaningless.
 *
 * @param {string[]} dirs - candidate directories.
 * @returns {string | undefined} the newest existing directory.
 */
export function newestDir(dirs) {
  let best
  let bestTime = -Infinity
  for (const dir of dirs) {
    try {
      const info = statSync(dir)
      if (!info.isDirectory()) continue
      if (info.mtimeMs > bestTime) {
        bestTime = info.mtimeMs
        best = dir
      }
    } catch {
      // Missing candidate: skip.
    }
  }
  return best
}

/**
 * Resolve the CODEX_HOME directory (~/.codex by default, but user-configurable).
 *
 * Chain: override -> $CODEX_HOME -> the running Codex process's own config ->
 * conventional default.
 *
 * @param {object} [options]
 * @param {string} [options.override] - explicit path from service config.
 * @param {Array<{exe: string, commandLine: string}>} [options.processes] - pre-read processes.
 * @returns {{path?: string, source: string, tried: string[], detail: string}} resolution.
 */
export function resolveCodexHome(options = {}) {
  const tried = []
  if (options.override) {
    tried.push(options.override)
    if (existsSync(join(options.override, 'config.toml'))) {
      return { path: options.override, source: SOURCE.override, tried, detail: `${options.override} (override)` }
    }
  }
  if (process.env.CODEX_HOME) {
    tried.push(process.env.CODEX_HOME)
    if (existsSync(process.env.CODEX_HOME)) {
      return { path: process.env.CODEX_HOME, source: SOURCE.env, tried, detail: `$CODEX_HOME=${process.env.CODEX_HOME}` }
    }
  }

  // Conventional default, plus the profile-relative form some tools use.
  const defaults = [join(homedir(), '.codex')]
  for (const candidate of defaults) {
    tried.push(candidate)
    if (existsSync(candidate)) {
      return { path: candidate, source: SOURCE.default, tried, detail: candidate }
    }
  }

  // Last resort: the running Codex process names its own CODEX_HOME in its
  // environment block almost nowhere, but its executable sits under the install
  // root, whose sibling `..\..` does not contain the home. Report honestly.
  return {
    source: SOURCE.missing,
    tried,
    detail: `no Codex home found; tried ${tried.join(', ')}. Set CODEX_HOME or pass --codex-home.`
  }
}

/**
 * Resolve the DSH home directory.
 *
 * Chain: override -> $DSH_HOME -> conventional default. The DSH install root is
 * resolved separately and never implies the home.
 *
 * @param {object} [options]
 * @param {string} [options.override] - explicit path from service config.
 * @returns {{path?: string, source: string, tried: string[], detail: string}} resolution.
 */
export function resolveDshHome(options = {}) {
  const tried = []
  if (options.override) {
    tried.push(options.override)
    if (existsSync(options.override)) {
      return { path: options.override, source: SOURCE.override, tried, detail: `${options.override} (override)` }
    }
  }
  if (process.env.DSH_HOME) {
    tried.push(process.env.DSH_HOME)
    if (existsSync(process.env.DSH_HOME)) {
      return { path: process.env.DSH_HOME, source: SOURCE.env, tried, detail: `$DSH_HOME=${process.env.DSH_HOME}` }
    }
  }
  const fallback = join(homedir(), '.dsh')
  tried.push(fallback)
  if (existsSync(fallback)) {
    return { path: fallback, source: SOURCE.default, tried, detail: fallback }
  }
  return {
    source: SOURCE.missing,
    tried,
    detail: `no DSH home found; tried ${tried.join(', ')}. Set DSH_HOME or pass --dsh-home.`
  }
}

/**
 * Resolve the Codex CLI executable.
 *
 * Chain, in order of reliability:
 *   1. explicit override
 *   2. $CODEX_CLI_PATH (what the Codex app exports to its own children)
 *   3. the RUNNING Codex process's executable path — authoritative regardless of
 *      where it was installed
 *   4. probe the install root's `bin` directory, choosing the directory that
 *      actually contains the executable (never by name order: the directory name
 *      is a random hash)
 *
 * @param {object} [options]
 * @param {string} [options.override] - explicit path.
 * @param {Array<{exe: string, commandLine: string}>} [options.processes] - pre-read processes.
 * @returns {{path?: string, source: string, tried: string[], detail: string}} resolution.
 */
export function resolveCodexExe(options = {}) {
  const tried = []
  const usable = (candidate) => candidate !== undefined && candidate !== '' && existsSync(candidate)

  if (options.override) {
    tried.push(options.override)
    if (usable(options.override)) return { path: options.override, source: SOURCE.override, tried, detail: `${options.override} (override)` }
  }
  if (process.env.CODEX_CLI_PATH) {
    tried.push(process.env.CODEX_CLI_PATH)
    if (usable(process.env.CODEX_CLI_PATH)) {
      return { path: process.env.CODEX_CLI_PATH, source: SOURCE.env, tried, detail: `$CODEX_CLI_PATH=${process.env.CODEX_CLI_PATH}` }
    }
  }

  // The running process is the strongest evidence: it is where the app really is.
  for (const proc of options.processes ?? []) {
    if (proc.exe === '') continue
    tried.push(proc.exe)
    if (proc.exe.toLowerCase().endsWith('codex.exe') && usable(proc.exe)) {
      return { path: proc.exe, source: SOURCE.process, tried, detail: `${proc.exe} (pid ${proc.pid})` }
    }
  }

  // Probe the install roots. LOCALAPPDATA and PROGRAMFILES cover per-user and
  // machine-wide installs; the extra roots cover a relocated install.
  const roots = [
    join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex'),
    join(process.env.ProgramFiles ?? '', 'Codex'),
    join(process.env['ProgramFiles(x86)'] ?? '', 'Codex'),
    join(homedir(), 'AppData', 'Local', 'OpenAI', 'Codex'),
    join(homedir(), '.codex', 'bin')
  ].filter((root) => root !== '')

  for (const root of roots) {
    const binDir = join(root, 'bin')
    tried.push(binDir)
    if (!existsSync(binDir)) {
      // Some layouts place the executable directly under the root.
      const direct = join(root, 'codex.exe')
      tried.push(direct)
      if (usable(direct)) return { path: direct, source: SOURCE.probe, tried, detail: direct }
      continue
    }
    let versionDirs = []
    try {
      versionDirs = readdirSync(binDir)
        .map((name) => join(binDir, name))
        .filter((dir) => existsSync(join(dir, 'codex.exe')))
    } catch {
      versionDirs = []
    }
    const chosen = newestDir(versionDirs)
    if (chosen !== undefined) {
      const exe = join(chosen, 'codex.exe')
      tried.push(exe)
      return { path: exe, source: SOURCE.probe, tried, detail: `${exe} (newest of ${versionDirs.length} candidate dir(s))` }
    }
  }

  return {
    source: SOURCE.missing,
    tried,
    detail: `no Codex executable found; tried ${tried.join(', ')}. Set CODEX_CLI_PATH or pass --codex-exe.`
  }
}

/**
 * Resolve the DSH installation root (the Electron app directory).
 *
 * Chain: override -> the running app's executable directory -> probe common roots.
 * The DSH CLI and its runtime live under this root, and the profile/bundle files
 * live under the DSH home, so the two must be resolved independently.
 *
 * @param {object} [options]
 * @param {string} [options.override] - explicit path.
 * @param {Array<{exe: string, commandLine: string, name: string}>} [options.processes] - pre-read processes.
 * @returns {{path?: string, source: string, tried: string[], detail: string}} resolution.
 */
export function resolveDshRoot(options = {}) {
  const tried = []
  if (options.override) {
    tried.push(options.override)
    if (existsSync(options.override)) return { path: options.override, source: SOURCE.override, tried, detail: `${options.override} (override)` }
  }
  for (const proc of options.processes ?? []) {
    if (proc.exe === '') continue
    const dir = proc.exe.replace(/[\\/][^\\/]+$/u, '')
    tried.push(dir)
    if (!existsSync(join(dir, 'resources'))) continue
    // Prefer the ROOT app process: utility/renderer children share the same
    // executable, but only the root has no --type= switch.
    const isHelper = /--type=/u.test(proc.commandLine)
    if (!isHelper) return { path: dir, source: SOURCE.process, tried, detail: `${dir} (pid ${proc.pid})` }
  }
  const roots = [
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness'),
    join(process.env.ProgramFiles ?? '', 'DeepSeek Harness'),
    join(process.env['ProgramFiles(x86)'] ?? '', 'DeepSeek Harness')
  ].filter((root) => root !== '')
  for (const root of roots) {
    tried.push(root)
    if (existsSync(join(root, 'resources'))) return { path: root, source: SOURCE.probe, tried, detail: root }
  }
  return { source: SOURCE.missing, tried, detail: `no DSH install root found; tried ${tried.join(', ')}` }
}

/**
 * Resolve the layout of the DSH runner: the CLI, its Electron launcher, and the
 * runtime node used by helper scripts.
 *
 * @param {string | undefined} installRoot - result of {@link resolveDshRoot}.
 * @returns {{cli?: string, launcherExe?: string, runtimeNode?: string, detail: string}} layout.
 */
export function resolveDshLayout(installRoot) {
  if (installRoot === undefined) return { detail: 'no install root' }
  const cli = join(installRoot, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
  const launcherExe = join(installRoot, 'DeepSeek Harness.exe')
  const runtimeNode = join(installRoot, 'resources', 'runtime', 'bin', 'node.exe')
  return {
    ...existsSync(cli) ? { cli } : {},
    ...existsSync(launcherExe) ? { launcherExe } : {},
    ...existsSync(runtimeNode) ? { runtimeNode } : {},
    detail: `cli=${existsSync(cli) ? 'found' : 'missing'}, launcher=${existsSync(launcherExe) ? 'found' : 'missing'}, runtimeNode=${existsSync(runtimeNode) ? 'found' : 'missing'}`
  }
}

/**
 * Report every candidate for a root, with existence and a resolved real path.
 *
 * This is what the web UI shows when discovery fails, so a user on an unusual
 * install can see exactly what was tried instead of a bare error.
 *
 * @param {string[]} candidates - paths to report on.
 * @returns {Array<{path: string, exists: boolean, realPath?: string}>} diagnostics.
 */
export function diagnose(candidates) {
  return candidates.map((candidate) => {
    if (!existsSync(candidate)) return { path: candidate, exists: false }
    try {
      return { path: candidate, exists: true, realPath: realpathSync(candidate) }
    } catch {
      return { path: candidate, exists: true }
    }
  })
}
