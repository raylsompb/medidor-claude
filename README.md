# Medidor Claude

Ícone na bandeja do Windows que mostra o uso do Claude (sessão de 5 horas e semana), com painel, gráfico, avisos em 50/80/90% e som.

## Usar
1. Rode `dist/MedidorClaude-Setup-<versão>.exe`. Instala só para o usuário atual, sem pedir administrador.
2. Entre com a conta do Claude na janela que abre.
3. Clique no ícone da bandeja para abrir o painel. Botão direito: atualizar, sair da conta, iniciar com o Windows.

## Desenvolver
- `scripts/install.ps1` e `scripts/install-electron.ps1`: instalam as dependências (o npm atual não roda o download do Electron sozinho).
- `npm start`: roda o app. `npm run mock`: roda com dados de exemplo.
- `npx electron . --mock --screenshot`: salva prints do painel e dos ícones em `shots/`.
- `scripts/build.ps1`: gera o instalador em `dist/`.
- Se o terminal tiver `ELECTRON_RUN_AS_NODE=1` (terminal do VS Code), desative antes de rodar.

## Como funciona
O login acontece na própria página do claude.ai, numa sessão separada do app. A cada 2 minutos o app lê `claude.ai/api/organizations/<org>/usage`, o mesmo dado da tela Configurações > Uso. Esse endereço não é documentado e pode mudar.
