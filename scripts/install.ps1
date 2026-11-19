$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$marker = Join-Path $PSScriptRoot '.install-done'
Remove-Item $marker -ErrorAction SilentlyContinue
Set-Location $root
Write-Host '== Medidor Claude: instalando dependencias (electron, electron-builder) ==' -ForegroundColor Cyan
try {
  npm install --save-dev electron@latest electron-builder@latest --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { throw "npm install falhou ($LASTEXITCODE)" }
  'ok' | Out-File $marker -Encoding utf8
  Write-Host ''
  Write-Host 'Pronto. Pode fechar esta janela.' -ForegroundColor Green
} catch {
  "erro: $_" | Out-File $marker -Encoding utf8
  Write-Host "ERRO: $_" -ForegroundColor Red
}
Read-Host 'Enter para fechar'
