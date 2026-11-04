# DCP gray-test: isolated opencode instance with the LOCAL plugin build.
#
# Creates a throwaway XDG home (config + data) that loads the local dist via a
# file URL, so you can exercise the real opencode/provider path WITHOUT touching
# the production @latest plugin cache or the real profile.
#
# Usage:
#   pwsh -File scripts/gray-instance.ps1            # set up + print launch cmd
#   pwsh -File scripts/gray-instance.ps1 -Launch    # set up + headless smoke run
#   pwsh -File scripts/gray-instance.ps1 -Clean     # remove the throwaway home
param(
    [switch]$Launch,
    [switch]$Clean,
    [string]$Repo = "D:\LearnMT\useful_tools\skills\opencode-dynamic-context-pruning",
    [string]$Prompt = "reply with the single word: gray-ok"
)

$ErrorActionPreference = "Stop"
$gray = Join-Path $env:TEMP "opencode-gray"
$grayConfig = Join-Path $gray "config\opencode"
$grayData = Join-Path $gray "data\opencode"
$grayCache = Join-Path $gray "cache"
$realConfig = Join-Path $HOME ".config\opencode"
$realData = Join-Path $HOME ".local\share\opencode"
$dist = Join-Path $Repo "dist\index.js"

if ($Clean) {
    if (Test-Path -LiteralPath $gray) { Remove-Item -LiteralPath $gray -Recurse -Force }
    Write-Host "removed $gray"
    exit 0
}

if (-not (Test-Path -LiteralPath $dist)) {
    throw "Local dist not found: $dist  (run: npx tsup)"
}

# fresh throwaway home
if (Test-Path -LiteralPath $gray) { Remove-Item -LiteralPath $gray -Recurse -Force }
New-Item -ItemType Directory -Path $grayConfig -Force | Out-Null
New-Item -ItemType Directory -Path $grayData -Force | Out-Null
New-Item -ItemType Directory -Path $grayCache -Force | Out-Null

# copy only the top-level config files (skip node_modules/skills/plugins/agents)
Get-ChildItem -LiteralPath $realConfig -File -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $grayConfig $_.Name) -Force
}

# copy auth so the isolated instance can talk to providers
$auth = Join-Path $realData "auth.json"
if (Test-Path -LiteralPath $auth) {
    Copy-Item -LiteralPath $auth -Destination (Join-Path $grayData "auth.json") -Force
}

# point the DCP plugin entry at the local build
$ocPath = Join-Path $grayConfig "opencode.json"
$oc = Get-Content -LiteralPath $ocPath -Raw | ConvertFrom-Json
$fileUrl = "file:///" + ($dist -replace "\\", "/")
$oc.plugin = @($fileUrl)
$oc | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $ocPath -Encoding utf8

# make sure the isolated dcp.jsonc never auto-updates
$dcpPath = Join-Path $grayConfig "dcp.jsonc"
if (Test-Path -LiteralPath $dcpPath) {
    $raw = Get-Content -LiteralPath $dcpPath -Raw
    if ($raw -notmatch '"autoUpdate"') {
        $raw = $raw -replace "\{", "{`n  ""autoUpdate"": false,"
        Set-Content -LiteralPath $dcpPath -Value $raw -Encoding utf8
    } else {
        $raw = $raw -replace '"autoUpdate"\s*:\s*true', '"autoUpdate": false'
        Set-Content -LiteralPath $dcpPath -Value $raw -Encoding utf8
    }
}

Write-Host "gray home ready: $gray"
Write-Host "  config: $grayConfig  (plugin -> $fileUrl)"
Write-Host "  data:   $grayData"
Write-Host "  cache:  $grayCache"
Write-Host ""
Write-Host "Launch it (does NOT touch the production cache):"
Write-Host "  `$env:XDG_CONFIG_HOME = `"$($gray)\config`""
Write-Host "  `$env:XDG_DATA_HOME   = `"$($gray)\data`""
Write-Host "  `$env:XDG_CACHE_HOME  = `"$grayCache`""
Write-Host "  opencode"
Write-Host ""

if ($Launch) {
    $env:XDG_CONFIG_HOME = Join-Path $gray "config"
    $env:XDG_DATA_HOME = Join-Path $gray "data"
    $env:XDG_CACHE_HOME = $grayCache
    Write-Host "headless smoke run: opencode run --print-logs `"$Prompt`""
    & opencode run --print-logs $Prompt
}
