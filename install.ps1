<#
  install.ps1 — make sure Node is here, then hand over to install.mjs, which is
  the installer on every platform.

      Set-ExecutionPolicy -Scope Process Bypass; .\install.ps1
      .\install.ps1 -NoService      # everything except registering the runner
      .\install.ps1 -PrintUrl       # print this machine's connector URL and exit
      .\install.ps1 -Hosted         # no Cloudflare account: join the hosted relay

  Everything this script used to do itself is in install.mjs now, shared with
  Linux and macOS. What is left is the one thing that cannot be written in
  Node: getting Node. Windows runs natively; WSL2 is not used or required.

  -Lib dot-sources the helpers without installing anything, for
  tests\check-windows-install.ps1.
#>
[CmdletBinding()]
param(
  [switch]$NoService,
  [switch]$PrintUrl,
  [switch]$Hosted,
  [switch]$Lib
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Note { param([string]$m) Write-Host "    $m" }

# Node 20+ is the only dependency. winget if it is missing, else say so
# plainly: a silent failure here looks like the installer being broken.
function Install-NodeIfMissing {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    $major = [int](((& node -v) -replace '^v','') -split '\.')[0]
    if ($major -ge 20) { return (Get-Command node).Source }
  }
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Note 'installing Node 22 (winget)'
    & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path','User')
  }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    throw 'Node 20+ is required. Install it from https://nodejs.org (LTS), reopen PowerShell, and re-run .\install.ps1'
  }
  $node.Source
}

if ($Lib) { return }

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeExe = Install-NodeIfMissing
$argv = @()
if ($NoService) { $argv += '--no-service' }
if ($PrintUrl)  { $argv += '--print-url' }
if ($Hosted)    { $argv += '--hosted' }
& $NodeExe (Join-Path $Here 'install.mjs') @argv
exit $LASTEXITCODE
