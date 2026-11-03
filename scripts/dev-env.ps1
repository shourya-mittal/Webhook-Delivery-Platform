# Local toolchain without Docker: Node 22 + Postgres 17 from a project-local
# conda env in .tools/. Dot-source it so PATH changes stick in your shell:
#
#   . .\scripts\dev-env.ps1          # put Node 22 + Postgres on PATH, start Postgres on :5433
#   . .\scripts\dev-env.ps1 -Stop    # stop Postgres
#
# One-time setup (already done if .tools/ exists):
#   conda create -y -p .tools -c conda-forge --override-channels nodejs=22 postgresql=17
#   .tools\Library\bin\initdb -D .tools\pgdata -U postgres -A trust -E UTF8
param([switch]$Stop)

$tools = Join-Path (Split-Path $PSScriptRoot -Parent) ".tools"
if (-not (Test-Path $tools)) { throw "No .tools env found; run the one-time setup above." }
$env:PATH = "$tools;$tools\Library\bin;$env:PATH"
$data = Join-Path $tools "pgdata"

if ($Stop) {
  pg_ctl -D $data stop
  return
}

pg_ctl -D $data status *> $null
if ($LASTEXITCODE -ne 0) {
  # Listen on loopback only; the cluster uses trust auth.
  pg_ctl -D $data -l (Join-Path $tools "pg.log") -o "-p 5433 -h 127.0.0.1" -w start
}
Write-Host "node $(node -v), Postgres on 127.0.0.1:5433"
