param([Parameter(Mandatory=$true)][string]$CloneRoot, [ValidateSet('all','forwarder','observation')][string]$Only = 'all')
$ErrorActionPreference = 'Stop'
$clonePath = (Resolve-Path -LiteralPath $CloneRoot).Path
$repoPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$marker = Get-Content -Raw -LiteralPath (Join-Path $clonePath 'graph-runtime-clone.json') | ConvertFrom-Json
if ($env:URTORIS_CLONE_CANARY -ne '1' -or $marker.marker -ne 'isolated-urtoris-graph-canary') { throw 'CLONE_MARKER_REQUIRED' }
$processFile = Join-Path $clonePath 'canary-processes.json'
if ($Only -eq 'all' -and (Test-Path -LiteralPath $processFile)) { throw 'PROCESS_MANIFEST_EXISTS: inspect and stop previous clone services first' }
$cloneSecrets = Get-Content -Raw -LiteralPath (Join-Path $clonePath 'test-secrets.json') | ConvertFrom-Json
$env:URTORIS_INTERNAL_TOKEN = $cloneSecrets.internal
$nodePath = (Get-Command node).Source
$shellPath = (Get-Process -Id $PID).Path
$processes = @()
if ($Only -ne 'all' -and (Test-Path -LiteralPath $processFile)) {
  $previous = Get-Content -Raw -LiteralPath $processFile | ConvertFrom-Json
  if ($previous.cloneRoot -ne $clonePath -or $previous.marker -ne $marker.marker) { throw 'PROCESS_MANIFEST_MISMATCH' }
  foreach ($entry in $previous.processes) {
    if ($entry.name -eq $Only) {
      $existing = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
      if ($existing -and $existing.StartTime.ToUniversalTime().Ticks -eq ([datetimeoffset]$entry.startedAt).UtcDateTime.Ticks) { throw 'HELPER_ALREADY_RUNNING' }
    } else { $processes += $entry }
  }
}
function Start-CanaryHelper([string]$name, [string]$program, [string[]]$arguments) {
  # Windows paths cannot contain quotes; quote every argument for Start-Process's command line.
  $quoted = $arguments | ForEach-Object { '"' + $_ + '"' }
  $process = Start-Process -FilePath $program -ArgumentList $quoted -WorkingDirectory $repoPath -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $clonePath "$name.stdout.log") -RedirectStandardError (Join-Path $clonePath "$name.stderr.log")
  $script:processes += @{ name = $name; pid = $process.Id; startedAt = $process.StartTime.ToUniversalTime().ToString('o') }
  @{ marker = $marker.marker; cloneRoot = $clonePath; repoRoot = $repoPath; processes = $script:processes } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $processFile -Encoding utf8
}
if ($Only -eq 'all') {
  Start-CanaryHelper 'site' $nodePath @('node_modules/vinext/dist/cli.js', 'dev', '--hostname', '127.0.0.1', '--port', '3000')
  Start-CanaryHelper 'n8n' $shellPath @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'start-graph-clone.ps1'), '-CloneRoot', $clonePath)
  Start-CanaryHelper 'provider' $nodePath @('--import', 'tsx', 'deploy/n8n/local-qwen-substitute.ts', $clonePath)
}
if ($Only -in 'all','forwarder') {
  $ready = $false
  for ($attempt = 0; $attempt -lt 25; $attempt++) {
    try { $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/api/state' -TimeoutSec 2; $ready = $response.StatusCode -eq 200 } catch { $ready = $false }
    if ($ready) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw 'SITE_NOT_READY: inspect logs before restarting forwarder' }
  Start-CanaryHelper 'forwarder' $nodePath @('--import', 'tsx', 'deploy/n8n/forward-graph-executions.ts', $clonePath)
}
if ($Only -eq 'observation') { Start-CanaryHelper 'observation' $nodePath @('--import', 'tsx', 'deploy/n8n/observe-graph-clone.ts', $clonePath) }
Write-Output 'Started hidden clone services; inspect canary-processes.json and per-service logs. Start observation only after readiness checks.'
