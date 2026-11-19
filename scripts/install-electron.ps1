$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$marker = Join-Path $PSScriptRoot '.install-electron-done'
Remove-Item $marker -ErrorAction SilentlyContinue
Set-Location $root
Write-Host '== Medidor Claude: baixando o Electron (~100 MB) ==' -ForegroundColor Cyan
try {
  node node_modules/electron/install.js
  if ($LASTEXITCODE -ne 0) { throw "download falhou ($LASTEXITCODE)" }
  'ok' | Out-File $marker -Encoding utf8
  Write-Host 'Pronto. Pode fechar esta janela.' -ForegroundColor Green
} catch {
  "erro: $_" | Out-File $marker -Encoding utf8
  Write-Host "ERRO: $_" -ForegroundColor Red
}
Read-Host 'Enter para fechar'
