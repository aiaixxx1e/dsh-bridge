# dsh-bridge/start-console.ps1
#
# Start the Codex <-> DSH connection console.
#
#   pwsh -NoProfile -File start-console.ps1            # start, print the URL
#   pwsh -NoProfile -File start-console.ps1 -Open      # also open the browser
#
# Re-running is safe: an instance already listening on the port is reused instead
# of starting a second one. Two instances would be harmless for reads but would
# race on the pairing file, so there is exactly one.
#
# Note: this launcher must NOT use -RedirectStandardOutput. PowerShell waits for a
# redirected stream to close, which only happens when the child exits, so the
# launcher would hang for the server's whole lifetime. The server writes its own
# log via --log instead.

[CmdletBinding()]
param(
  [int]$Port = 8792,
  [int]$BrokerPort = 8791,
  [string]$StatePath = "$PSScriptRoot\state.json",
  [string]$CodexHome,
  [string]$DshHome,
  [string]$DshUrl,
  [string]$LogPath = "$PSScriptRoot\console.log",
  [switch]$Open
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-Listening {
  param([int]$CandidatePort)
  try {
    return $null -ne (Get-NetTCPConnection -LocalPort $CandidatePort -State Listen -ErrorAction Stop)
  } catch {
    return $false
  }
}

$url = "http://127.0.0.1:$Port/"

if (Test-Listening -CandidatePort $Port) {
  Write-Output "connection console already listening: $url"
  if ($Open) { Start-Process $url }
  exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node was not found on PATH' }

$script = Join-Path $PSScriptRoot 'session-server.mjs'
if (-not (Test-Path $script)) { throw "session-server.mjs not found at $script" }

$env:DSH_BRIDGE_STATE = $StatePath
$env:DSH_BRIDGE_BROKER_URL = "http://127.0.0.1:$BrokerPort"

# Resolve the DSH home the same way the service does, so a launcher started from a
# shell without DSH_HOME still finds the session logs.
if (-not $env:DSH_HOME) { $env:DSH_HOME = Join-Path $env:USERPROFILE '.dsh' }

$arguments = @($script, '--port', "$Port", '--log', $LogPath)
if ($PSBoundParameters.ContainsKey('CodexHome') -and $CodexHome) { $arguments += @('--codex-home', $CodexHome) }
if ($PSBoundParameters.ContainsKey('DshHome') -and $DshHome) { $arguments += @('--dsh-home', $DshHome) }
if ($PSBoundParameters.ContainsKey('DshUrl') -and $DshUrl) { $arguments += @('--dsh-url', $DshUrl) }

$process = Start-Process -FilePath $node -ArgumentList $arguments -WindowStyle Hidden -PassThru

for ($attempt = 0; $attempt -lt 40; $attempt++) {
  Start-Sleep -Milliseconds 250
  if (Test-Listening -CandidatePort $Port) {
    Write-Output "connection console started (pid $($process.Id)): $url"
    Write-Output "  state : $StatePath"
    Write-Output "  broker: http://127.0.0.1:$BrokerPort (relay owner)"
    Write-Output "  log   : $LogPath"
    if ($Open) { Start-Process $url }
    exit 0
  }
  if ($process.HasExited) { break }
}

Write-Output "console did not bind port $Port (exited=$($process.HasExited))"
if (Test-Path $LogPath) { Get-Content $LogPath -Tail 30 }
exit 1
