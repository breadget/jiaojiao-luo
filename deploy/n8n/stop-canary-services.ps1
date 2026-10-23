param([Parameter(Mandatory=$true)][string]$CloneRoot)
$ErrorActionPreference = 'Stop'
$clonePath = (Resolve-Path -LiteralPath $CloneRoot).Path
$marker = Get-Content -Raw -LiteralPath (Join-Path $clonePath 'graph-runtime-clone.json') | ConvertFrom-Json
if ($env:URTORIS_CLONE_CANARY -ne '1' -or $marker.marker -ne 'isolated-urtoris-graph-canary') { throw 'CLONE_MARKER_REQUIRED' }
$manifestPath = Join-Path $clonePath 'canary-processes.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.cloneRoot -ne $clonePath -or $manifest.marker -ne $marker.marker) { throw 'PROCESS_MANIFEST_MISMATCH' }
$stopped = @()
function Stop-RecordedTree([int]$processId, [long]$startedTicks) {
  $current = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $current) { return }
  if ($current.StartTime.ToUniversalTime().Ticks -ne $startedTicks) {
    Write-Warning "Recorded process already exited; skipping reused PID $processId"
    return
  }
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$processId" | ForEach-Object {
    $child = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if ($child -and $child.StartTime.ToUniversalTime().Ticks -ge $startedTicks) {
      @{ pid = $child.Id; ticks = $child.StartTime.ToUniversalTime().Ticks }
    }
  })
  # Stop the verified launcher first, then only the children captured from its process tree.
  Stop-Process -Id $current.Id
  $script:stopped += $current.Id
  foreach ($child in $children) { Stop-RecordedTree $child.pid $child.ticks }
}
foreach ($entry in @($manifest.processes)) { Stop-RecordedTree $entry.pid ([datetimeoffset]$entry.startedAt).UtcDateTime.Ticks }
$report = @{ marker = $marker.marker; stoppedAt = [datetime]::UtcNow.ToString('o'); processIds = $stopped; databaseDeleted = $false }
$report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $clonePath 'stopped-services.json') -Encoding utf8
# Retain the manifest as evidence, under a new file name. No database/configuration deletion.
$archivePath = [System.IO.Path]::GetFullPath((Join-Path $clonePath ('stopped-processes-' + [datetime]::UtcNow.ToString('yyyyMMddHHmmss') + '.json')))
if (-not $archivePath.StartsWith($clonePath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'ARCHIVE_OUTSIDE_CLONE' }
Move-Item -LiteralPath $manifestPath -Destination $archivePath
Write-Output 'Stopped recorded clone process trees; retained database, configuration and evidence.'
