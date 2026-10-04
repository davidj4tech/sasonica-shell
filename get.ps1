<#
  get.ps1 — Sasonica Shell on Windows in one line, from nothing:

      irm https://sasonica.com/install.ps1 | iex

  (sasonica.com/install.ps1 redirects here.) No git, no Cloudflare account:
  it downloads this repository as a zip into %LOCALAPPDATA%\sasonica\shell,
  then runs install.ps1 -Hosted, which gets Node if it is missing and joins
  the hosted relay — a link and a code to sign in with a Sasonica account.

  Run it again to update: the files are replaced, the config in
  %APPDATA%\sasonica (keys, runner token) is kept, and a machine that has
  joined stays joined.

  $env:SASONICA_SELF_HOSTED = '1'   your own Worker in your own Cloudflare
                                     account instead of the hosted relay
  $env:SASONICA_GET_ONLY = '1'      download and unpack, install nothing (CI)
  $env:SASONICA_GET_ZIP = '<url>'   a different zip (a branch, a fork)
#>

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'     # Invoke-WebRequest's bar makes it many times slower
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$zip = if ($env:SASONICA_GET_ZIP) { $env:SASONICA_GET_ZIP } else { 'https://github.com/davidj4tech/sasonica-shell/archive/refs/heads/main.zip' }
$dest = Join-Path $env:LOCALAPPDATA 'sasonica\shell'

Write-Host "`n==> Downloading Sasonica Shell"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("sasonica-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $file = Join-Path $tmp 'shell.zip'
  Invoke-WebRequest -UseBasicParsing -Uri $zip -OutFile $file
  Expand-Archive -Path $file -DestinationPath $tmp -Force
  $src = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
  if (-not $src -or -not (Test-Path (Join-Path $src.FullName 'install.ps1'))) { throw "the download from $zip has no install.ps1" }

  # What a self-hosted install wrote into the tree, kept across an update.
  $keep = @('worker\wrangler.jsonc', 'install.conf')
  $saved = @{}
  foreach ($k in $keep) {
    $p = Join-Path $dest $k
    if (Test-Path $p) { $saved[$k] = Get-Content -Raw -Path $p }
  }
  if (Test-Path $dest) { Remove-Item -Recurse -Force -Path $dest }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
  Move-Item -Path $src.FullName -Destination $dest
  foreach ($k in $saved.Keys) { Set-Content -NoNewline -Path (Join-Path $dest $k) -Value $saved[$k] }
  Write-Host "    unpacked to $dest"
} finally {
  Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue
}

if ($env:SASONICA_GET_ONLY -eq '1') { return }

# A file of its own, run by Windows PowerShell with the policy relaxed for
# that one process: `iex` brought this script in as text, and a machine's
# execution policy would otherwise refuse install.ps1 as a downloaded file.
$installArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $dest 'install.ps1'))
if ($env:SASONICA_SELF_HOSTED -ne '1') { $installArgs += '-Hosted' }
& powershell.exe @installArgs
if ($LASTEXITCODE -ne 0) { throw "the installer stopped (exit $LASTEXITCODE)" }
