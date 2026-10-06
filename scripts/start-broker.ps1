# dsh-bridge/start-broker.ps1
#
# Start the dsh-bridge broker as an independent background process.
#
# Why a detached process: the bridge must keep relaying after the DSH session
# that happened to start it has ended, and after the terminal that ran it is
# closed. The broker needs no interactive desktop — it serves loopback HTTP and
# shells out to `codex queue` — so a plain detached process (or a scheduled task)
# is enough.
#
# Re-running this script is safe: an existing broker on the port is reused
# instead of starting a second one. Two brokers would share one state file and
# could double-forward a turn.
#
# Note on redirection: this launcher must NOT use `-RedirectStandardOutput`.
# PowerShell waits for the redirected stream to close before returning, which
# only happens when the child exits, so the launcher would hang for the broker's
# whole lifetime. The broker writes its own log via `--log` instead.

[CmdletBinding()]
param(
  [int]$Port = 8791,
  [int]$IntervalMs = 3000,
  [string]$StatePath = "$PSScriptRoot\state.json",
  [string]$LogPath = "$PSScriptRoot\broker.log"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Resolve the DSH home the same way the broker does, so an environment without
# DSH_HOME still finds the session logs.
if (-not $env:DSH_HOME) { $env:DSH_HOME = Join-Path $env:USERPROFILE '.dsh' }
$env:DSH_BRIDGE_STATE = $StatePath

function Test-BrokerListening {
  param([int]$CandidatePort)
  try {
    $connection = Get-NetTCPConnection -LocalPort $CandidatePort -State Listen -ErrorAction Stop
    return $null -ne $connection
  } catch {
    return $false
  }
}

if (Test-BrokerListening -CandidatePort $Port) {
  Write-Output "dsh-bridge broker already listening on port $Port; nothing to do."
  exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node was not found on PATH' }

$broker = Join-Path $PSScriptRoot 'broker.mjs'
if (-not (Test-Path $broker)) { throw "broker not found at $broker" }

$arguments = @(
  $broker,
  'serve',
  '--port', "$Port",
  '--interval-ms', "$IntervalMs",
  '--log', $LogPath
)

$process = Start-Process -FilePath $node -ArgumentList $arguments -WindowStyle Hidden -PassThru

# Give the server a moment to bind, then confirm it is actually serving.
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Milliseconds 250
  if (Test-BrokerListening -CandidatePort $Port) {
    Write-Output "dsh-bridge broker started (pid $($process.Id)) on http://127.0.0.1:$Port"
    Write-Output "  log: $LogPath"
    exit 0
  }
  if ($process.HasExited) { break }
}

Write-Output "broker did not bind port $Port (pid $($process.Id), exited=$($process.HasExited))"
if (Test-Path $LogPath) { Get-Content $LogPath -Tail 20 }
exit 1
