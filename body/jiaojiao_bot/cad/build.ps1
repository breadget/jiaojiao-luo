param(
    [string]$OpenSCAD = "D:\tools\OpenSCAD-2021.01\openscad-2021.01\openscad.com",
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "stl"),
    [switch]$Preview
)

$ErrorActionPreference = "Stop"
$exe = Get-Command $OpenSCAD -ErrorAction SilentlyContinue
if (-not $exe) {
    throw "OpenSCAD was not found. Put the portable package on D: or pass its path, for example: .\build.ps1 -OpenSCAD 'D:\tools\OpenSCAD-2021.01\openscad-2021.01\openscad.com'"
}

$source = Join-Path $PSScriptRoot "jiaojiao_bot.scad"
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$parts = @("adapter_frame", "base_shell", "logo_badge", "torso_support", "chest_shell", "arm_left", "arm_right")

Push-Location $PSScriptRoot
try {
    foreach ($name in $parts) {
        $target = Join-Path $OutputDirectory "$name.stl"
        & $exe.Source -o $target -D "part=`"$name`"" $source
        if ($LASTEXITCODE -ne 0) { throw "OpenSCAD export failed for $name (exit $LASTEXITCODE)" }
        if (-not (Test-Path -LiteralPath $target) -or (Get-Item -LiteralPath $target).Length -lt 84) {
            throw "OpenSCAD produced an empty or invalid STL for $name"
        }
        Write-Host "Exported $target"
    }

    if ($Preview) {
        $previewDirectory = Join-Path $PSScriptRoot "preview"
        $previewTarget = Join-Path $previewDirectory "jiaojiao_bot.png"
        New-Item -ItemType Directory -Path $previewDirectory -Force | Out-Null
        & $exe.Source -o $previewTarget --imgsize=1200,900 --projection=ortho --camera=0,0,0,55,0,225,850 -D 'part="assembly"' $source
        if ($LASTEXITCODE -ne 0) { throw "OpenSCAD preview export failed (exit $LASTEXITCODE)" }
        if (-not (Test-Path -LiteralPath $previewTarget) -or (Get-Item -LiteralPath $previewTarget).Length -lt 1000) {
            throw "OpenSCAD produced an empty preview image"
        }
        Write-Host "Exported $previewTarget"
    }
}
finally {
    Pop-Location
}
