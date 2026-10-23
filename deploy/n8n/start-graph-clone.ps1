param([Parameter(Mandatory=$true)][string]$CloneRoot)
$ErrorActionPreference = 'Stop'
$clonePath = (Resolve-Path -LiteralPath $CloneRoot).Path
$marker = Get-Content -Raw -LiteralPath (Join-Path $clonePath 'graph-runtime-clone.json') | ConvertFrom-Json
if ($env:URTORIS_CLONE_CANARY -ne '1' -or $marker.marker -ne 'isolated-urtoris-graph-canary' -or $marker.n8nVersion -ne '2.38.6') { throw 'CLONE_MARKER_REQUIRED' }
$n8nPackage = Get-Content -Raw -LiteralPath (Join-Path $clonePath 'node_modules/n8n/package.json') | ConvertFrom-Json
if ($n8nPackage.version -ne '2.38.6') { throw 'N8N_VERSION_MISMATCH' }
$env:N8N_USER_FOLDER = Join-Path $clonePath 'clone-data'
$env:DB_TYPE = 'sqlite'
$env:DB_SQLITE_DATABASE = 'database.sqlite'
$env:EXECUTIONS_MODE = 'regular'
$env:N8N_RUNNERS_MODE = 'internal'
$env:N8N_HOST = '127.0.0.1'
$env:WEBHOOK_URL = 'http://127.0.0.1:5679/'
$env:N8N_EDITOR_BASE_URL = 'http://127.0.0.1:5679/'
$env:N8N_PORT = '5679'
$env:N8N_LISTEN_ADDRESS = '127.0.0.1'
$env:N8N_RUNNERS_BROKER_PORT = '5680'
$env:N8N_DIAGNOSTICS_ENABLED = 'false'
$env:N8N_PUBLIC_API_DISABLED = 'true'
$env:N8N_COMMUNITY_PACKAGES_ENABLED = 'false'
$env:N8N_TEMPLATES_ENABLED = 'false'
$env:N8N_VERSION_NOTIFICATIONS_ENABLED = 'false'
$env:EXECUTIONS_DATA_SAVE_ON_SUCCESS = 'all'
$env:EXECUTIONS_DATA_SAVE_ON_ERROR = 'all'
$env:EXECUTIONS_DATA_PRUNE = 'false'
$env:N8N_SECURE_COOKIE = 'false'
node (Join-Path $clonePath 'node_modules/n8n/bin/n8n') start
exit $LASTEXITCODE
