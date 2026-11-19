$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$marker = Join-Path $PSScriptRoot '.install-build-done'
Remove-Item $marker -ErrorAction SilentlyContinue
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Set-Location $root
Write-Host '== Medidor Claude: gerando o instalador .exe (baixa NSIS na 1a vez) ==' -ForegroundColor Cyan
try {
  npx electron-builder --win nsis
  if ($LASTEXITCODE -ne 0) { throw "build falhou ($LASTEXITCODE)" }
  'ok' | Out-File $marker -Encoding utf8
  Write-Host ''
  Write-Host 'Instalador pronto na pasta dist.' -ForegroundColor Green
} catch {
  "erro: $_" | Out-File $marker -Encoding utf8
  Write-Host "ERRO: $_" -ForegroundColor Red
}
Read-Host 'Enter para fechar'
