// Medidor Claude: mostra o uso do Claude (sessão de 5h e semana) na bandeja do Windows.
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, session, Notification, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const MOCK = process.argv.includes('--mock');
const SHOT = process.argv.includes('--screenshot');
const PROBE = process.argv.includes('--probe'); // teste: abre o login real, fotografa e fecha
const BASE = 'https://claude.ai';
const POLL_MS = 2 * 60 * 1000;
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.ico');
const shotsDir = () => app.isPackaged ? path.join(app.getPath('temp'), 'medidor-claude-shots') : path.join(__dirname, '..', 'shots');
const THRESHOLDS = [50, 80, 90];

app.setAppUserModelId('com.local.medidorclaude');
if (!app.requestSingleInstanceLock()) { app.quit(); }

let tray = null, panel = null, loginWin = null, ses = null;
let pollTimer = null, blinkTimer = null, loginCheckTimer = null;
let lastHide = 0;
let refreshing = null;

// ---------- persistência ----------
const dataDir = () => app.getPath('userData');
function load(name, fallback) {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(path.join(dataDir(), name), 'utf8')) }; }
  catch { return { ...fallback }; }
}
function save(name, obj) {
  try { fs.writeFileSync(path.join(dataDir(), name), JSON.stringify(obj)); } catch (e) { console.error('save', name, e.message); }
}

let settings, store;
const state = { status: 'loading', session: null, week: null, updatedAt: null, error: null, source: null, loginReason: null, hasClaudeCode: false, hasClaudeCli: false };

// ---------- acesso ao claude.ai ----------
class AuthError extends Error {}

async function fetchJson(url) {
  let status = 0, text = '';
  try {
    const r = await ses.fetch(url, { headers: { accept: 'application/json' }, credentials: 'include' });
    status = r.status; text = await r.text();
  } catch (e) { throw new Error('rede: ' + e.message); }
  let data = null;
  try { data = JSON.parse(text); } catch { /* página HTML, ex.: desafio do Cloudflare */ }
  if (data === null && status !== 401 && status !== 403) {
    return hiddenFetch(url);
  }
  return { status, data };
}

// Plano B: abre a URL numa janela invisível com o mesmo login e lê o JSON da página.
async function hiddenFetch(url) {
  const w = new BrowserWindow({ show: false, webPreferences: { session: ses } });
  try {
    await w.loadURL(url);
    for (let i = 0; i < 6; i++) {
      const text = await w.webContents.executeJavaScript('document.body ? document.body.innerText : ""');
      try { return { status: 200, data: JSON.parse(text) }; } catch { await new Promise(r => setTimeout(r, 1500)); }
    }
    throw new Error('resposta inesperada do claude.ai');
  } finally { w.destroy(); }
}

async function resolveOrg() {
  const r = await fetchJson(`${BASE}/api/organizations`);
  if (r.status === 401 || r.status === 403) throw new AuthError('sem login');
  if (!Array.isArray(r.data) || r.data.length === 0) throw new Error('nenhuma organização encontrada');
  const cookies = await ses.cookies.get({ url: BASE, name: 'lastActiveOrg' });
  const active = cookies[0] && r.data.find(o => o.uuid === cookies[0].value);
  const chat = r.data.find(o => Array.isArray(o.capabilities) && o.capabilities.includes('chat'));
  return (active || chat || r.data[0]).uuid;
}

function parseUsage(d) {
  const pick = o => (o && typeof o.utilization === 'number')
    ? { pct: Math.max(0, Math.min(1, o.utilization / 100)), resetsAt: o.resets_at || null }
    : null;
  return { session: pick(d && d.five_hour), week: pick(d && d.seven_day) };
}

async function fetchUsage() {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!settings.orgId) { settings.orgId = await resolveOrg(); save('settings.json', settings); }
    const r = await fetchJson(`${BASE}/api/organizations/${settings.orgId}/usage`);
    if (r.status >= 200 && r.status < 300 && r.data) return parseUsage(r.data);
    settings.orgId = null; // conta trocada ou org inválida: descobre de novo
    if (attempt === 1) {
      if (r.status === 401 || r.status === 403) throw new AuthError('sem login');
      throw new Error(`claude.ai respondeu ${r.status}`);
    }
  }
}

// ---------- login do Claude Code já instalado no PC ----------
// Lê o login salvo pelo Claude Code. Só lê: nunca renova nem altera o arquivo,
// para não deslogar o Claude Code.
function claudeCodeCredPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(require('os').homedir(), '.claude');
  return path.join(dir, '.credentials.json');
}
function readClaudeCode() {
  try {
    const o = JSON.parse(fs.readFileSync(claudeCodeCredPath(), 'utf8')).claudeAiOauth;
    if (!o || !o.accessToken) return null;
    return { token: o.accessToken, expiresAt: Number(o.expiresAt) || 0 };
  } catch { return null; }
}

class ExpiredError extends Error {}

async function fetchUsageClaudeCode(cred) {
  if (cred.expiresAt && cred.expiresAt < Date.now() + 30e3) throw new ExpiredError('login do Claude Code expirado');
  let r;
  try {
    r = await net.fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${cred.token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
    });
  } catch (e) { throw new Error('rede: ' + e.message); }
  if (r.status === 401 || r.status === 403) throw new ExpiredError('login do Claude Code expirado');
  if (!r.ok) throw new Error(`api respondeu ${r.status}`);
  return parseUsage(await r.json());
}

// Ordem: login do Claude Code (se existir) e, como alternativa, login feito no site.
async function fetchAny() {
  const cred = settings.source === 'web' ? null : readClaudeCode();
  if (cred) {
    try { const u = await fetchUsageClaudeCode(cred); state.source = 'claude-code'; return u; }
    catch (e) {
      if (!(e instanceof ExpiredError)) throw e;
      try { const u = await fetchUsage(); state.source = 'web'; return u; }
      catch (e2) { if (e2 instanceof AuthError) throw e; throw e2; }
    }
  }
  const u = await fetchUsage(); state.source = 'web'; return u;
}

// ---------- dados de teste ----------
function mockUsage() {
  const now = Date.now();
  const nextWed = new Date(); nextWed.setDate(nextWed.getDate() + ((3 - nextWed.getDay() + 7) % 7 || 7)); nextWed.setHours(23, 0, 0, 0);
  const pct = Number(process.env.MOCK_PCT || 20) / 100;
  return { session: { pct, resetsAt: new Date(now + 4.4 * 3600e3).toISOString() }, week: { pct: 0.31, resetsAt: nextWed.toISOString() } };
}
function mockHistory(u) {
  const now = Date.now(), out = [];
  const sStart = Date.parse(u.session.resetsAt) - 5 * 3600e3;
  const wStart = Date.parse(u.week.resetsAt) - 7 * 86400e3;
  for (let i = 0; i <= 40; i++) {
    const f = i / 40, wobble = Math.sin(i * 1.7) * 0.01;
    out.push({ t: wStart + (now - wStart) * f, w: Math.max(0, u.week.pct * f + wobble), s: null });
  }
  for (let i = 0; i <= 30; i++) {
    const f = i / 30;
    out.push({ t: sStart + (now - sStart) * f, s: Math.max(0, u.session.pct * Math.pow(f, 1.3) + Math.sin(i) * 0.006), w: null });
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---------- ciclo de atualização ----------
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      state.hasClaudeCode = !!readClaudeCode();
      const u = MOCK ? (state.source = 'claude-code', mockUsage()) : await fetchAny();
      state.session = u.session; state.week = u.week; state.loginReason = null;
      state.status = (u.session || u.week) ? 'ok' : 'nodata';
      state.updatedAt = Date.now(); state.error = null;
      addHistory(u);
      checkAlerts(u);
    } catch (e) {
      if (e instanceof AuthError || e instanceof ExpiredError) {
        state.status = 'login'; state.session = state.week = null;
        state.loginReason = (e instanceof ExpiredError || (state.hasClaudeCode && settings.source !== 'web')) ? 'expired' : 'none';
      }
      else { state.error = e.message; if (state.status === 'loading') state.status = 'error'; }
      console.error('refresh:', e.message);
    } finally {
      refreshing = null;
      await pushState();
    }
  })();
  return refreshing;
}

function addHistory(u) {
  if (MOCK) { store.history = mockHistory(u); return; }
  const now = Date.now();
  store.history.push({ t: now, s: u.session ? u.session.pct : null, w: u.week ? u.week.pct : null });
  store.history = store.history.filter(h => now - h.t < 8 * 86400e3).slice(-6000);
  save('store.json', store);
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, POLL_MS);
}

// ---------- avisos ----------
function checkAlerts(u) {
  const now = Date.now();
  for (const [kind, label] of [['session', 'Sessão'], ['week', 'Semana']]) {
    const d = u[kind]; if (!d) continue;
    const win = d.resetsAt ? Math.round(Date.parse(d.resetsAt) / 3600e3) : 0;
    for (const th of THRESHOLDS) {
      if (!settings.alerts[th] || d.pct * 100 < th) continue;
      const key = `${kind}:${th}:${win}`;
      if (store.alerted[key]) continue;
      store.alerted[key] = now;
      // só o aviso mais alto de cada vez
      const higher = THRESHOLDS.filter(t => t > th && settings.alerts[t] && d.pct * 100 >= t);
      if (higher.length) continue;
      notify(`${label} do Claude em ${Math.round(d.pct * 100)}%`, d.resetsAt ? `Zera ${fmtReset(d.resetsAt, kind)}.` : '');
    }
  }
  for (const k of Object.keys(store.alerted)) if (now - store.alerted[k] > 9 * 86400e3) delete store.alerted[k];
  if (!MOCK) save('store.json', store);
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: ICON_PATH, silent: true }).show();
  if (settings.sound && panel) panel.webContents.send('chime');
}

function fmtReset(iso, kind) {
  const d = new Date(Math.round(Date.parse(iso) / 60e3) * 60e3), now = new Date();
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.toDateString() === now.toDateString();
  if (kind === 'session' && sameDay) return `às ${hm}`;
  const wd = d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
  return `${wd} às ${hm}`;
}

// ---------- bandeja ----------
async function iconFor(pct, blinkOff, mode) {
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  const size = Math.round(16 * scale);
  const url = await panel.webContents.executeJavaScript(`window.renderIcon(${pct}, ${!!blinkOff}, ${size}, ${JSON.stringify(mode)})`);
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: scale, dataURL: url });
  return img;
}

async function updateTray() {
  if (!tray || !panel) return;
  clearInterval(blinkTimer); blinkTimer = null;
  const s = state.session;
  let mode = 'ok';
  if (state.status === 'login') mode = 'login';
  else if (!s) mode = state.status === 'error' ? 'error' : 'empty';
  const pct = s ? s.pct : 0;
  const on = await iconFor(pct, false, mode);
  tray.setImage(on);
  if (mode === 'ok' && pct >= 0.9) {
    const off = await iconFor(pct, true, mode);
    let flip = false;
    blinkTimer = setInterval(() => { flip = !flip; tray.setImage(flip ? off : on); }, 700);
  }
  tray.setToolTip(tooltipText());
}

function tooltipText() {
  if (state.status === 'login') return 'Medidor Claude\nClique para entrar na sua conta';
  if (state.status === 'loading') return 'Medidor Claude\nCarregando...';
  const line = (label, d, kind) => d ? `${label} ${Math.round(d.pct * 100)}%${d.resetsAt ? ' · zera ' + fmtReset(d.resetsAt, kind) : ''}` : `${label} sem dados`;
  let t = `Uso do Claude\n${line('Sessão', state.session, 'session')}\n${line('Semana', state.week, 'week')}`;
  if (state.error) t += '\nSem conexão agora';
  return t.slice(0, 127);
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Abrir painel', click: showPanel },
    { label: 'Atualizar agora', click: () => refresh() },
    { type: 'separator' },
    { label: 'Iniciar com o Windows', type: 'checkbox', checked: settings.autostart, click: m => setSetting('autostart', m.checked) },
    { label: 'Som do aviso', type: 'checkbox', checked: settings.sound, click: m => setSetting('sound', m.checked) },
    { type: 'separator' },
    ...(state.source === 'claude-code' ? [{ label: 'Conectado pelo Claude Code', enabled: false }] : []),
    ...(state.hasClaudeCli ? [{ label: 'Entrar pelo navegador principal', click: loginBrowser }] : []),
    { label: state.status === 'login' ? 'Entrar nesta janela (site do Claude)' : (state.source === 'claude-code' ? 'Usar outra conta (entrar pelo site)' : 'Sair da conta / trocar conta'), click: () => state.status === 'login' ? openLogin() : logout() },
    ...(settings.source === 'web' && state.hasClaudeCode ? [{ label: 'Voltar a usar o login do Claude Code', click: useClaudeCode }] : []),
    { label: 'Fechar o Medidor', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

// ---------- painel ----------
const PANEL_W = 420, PANEL_H = 560;

function createPanel() {
  panel = new BrowserWindow({
    width: PANEL_W, height: PANEL_H, show: false, frame: false, transparent: true, resizable: false,
    skipTaskbar: true, alwaysOnTop: true, fullscreenable: false, maximizable: false, minimizable: false,
    backgroundColor: '#00000000', hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, contextIsolation: true },
  });
  panel.loadFile(path.join(__dirname, 'panel.html'));
  panel.on('blur', () => { if (!SHOT && panel.isVisible()) { panel.hide(); lastHide = Date.now(); } });
  panel.on('close', e => { if (!app.isQuitting) { e.preventDefault(); panel.hide(); } });
  return new Promise(r => panel.webContents.once('did-finish-load', r));
}

function positionPanel() {
  const pt = tray ? tray.getBounds() : null;
  const disp = pt && pt.width ? screen.getDisplayNearestPoint({ x: pt.x, y: pt.y }) : screen.getPrimaryDisplay();
  const wa = disp.workArea;
  panel.setPosition(Math.round(wa.x + wa.width - PANEL_W - 4), Math.round(wa.y + wa.height - PANEL_H - 4));
}

function showPanel() {
  positionPanel();
  panel.show(); panel.focus();
  panel.webContents.send('opened');
  if (!state.updatedAt || Date.now() - state.updatedAt > 30e3) refresh();
}

function togglePanel() {
  if (panel.isVisible()) { panel.hide(); return; }
  if (Date.now() - lastHide < 300) return; // o clique que tirou o foco já fechou
  showPanel();
}

async function pushState() {
  if (panel) panel.webContents.send('state', publicState());
  await updateTray();
  if (tray) tray.setContextMenu(trayMenu());
}

function publicState() {
  return { ...state, history: store.history, settings, pollMs: POLL_MS };
}

// ---------- login ----------
function openLogin() {
  if (loginWin) { loginWin.show(); loginWin.focus(); return; }
  loginWin = new BrowserWindow({
    width: 500, height: 760, title: 'Entrar no Claude', icon: ICON_PATH, autoHideMenuBar: true,
    webPreferences: { session: ses },
  });
  loginWin.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { session: ses } } }));
  loginWin.loadURL(`${BASE}/login`);
  const check = async () => {
    try { await resolveOrg(); } catch { return; }
    clearInterval(loginCheckTimer);
    if (loginWin) loginWin.close();
    settings.orgId = null;
    await refresh();
    showPanel();
  };
  loginWin.webContents.on('did-navigate', check);
  loginWin.webContents.on('did-navigate-in-page', check);
  clearInterval(loginCheckTimer);
  loginCheckTimer = setInterval(check, 3000);
  loginWin.on('closed', () => { loginWin = null; clearInterval(loginCheckTimer); });
}

// Login no navegador principal: roda "claude auth login" num terminal visível.
// O Claude Code abre o navegador e também mostra o link para copiar.
// Quando o login termina, o arquivo de login muda e o medidor atualiza sozinho.
function detectClaudeCli() {
  exec('where claude', { windowsHide: true }, (err, out) => { state.hasClaudeCli = !err && !!String(out).trim(); pushState(); });
}
function loginBrowser() {
  settings.source = 'auto'; save('settings.json', settings);
  exec('start "Entrar no Claude" cmd /k "echo Abrindo o login do Claude no seu navegador... & echo Se nao abrir, copie o link que aparecer abaixo e cole no navegador. & echo. & claude auth login & echo. & echo Pronto. Pode fechar esta janela."', { windowsHide: false });
}

async function useClaudeCode() {
  settings.source = 'auto'; save('settings.json', settings);
  store.history = []; save('store.json', store);
  await refresh();
}

async function logout() {
  if (state.source === 'claude-code') {
    // não dá para deslogar o Claude Code daqui: passa a usar o login do site
    settings.source = 'web'; save('settings.json', settings);
    store.history = []; save('store.json', store);
    state.status = 'login'; state.loginReason = 'none'; state.session = state.week = null; state.source = null;
    await pushState();
    showPanel(); // mostra as opções de login no painel
    return;
  }
  settings.source = 'auto';
  await ses.clearStorageData();
  await ses.clearCache();
  settings.orgId = null; save('settings.json', settings);
  store.history = []; save('store.json', store);
  state.status = 'login'; state.session = state.week = null; state.error = null; state.source = null; state.loginReason = 'none';
  await pushState();
  showPanel();
}

// ---------- configurações ----------
function applyAutostart() {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!settings.autostart });
}

function setSetting(key, value) {
  if (key.startsWith('alert')) settings.alerts[key.slice(5)] = !!value;
  else settings[key] = value;
  save('settings.json', settings);
  if (key === 'autostart') applyAutostart();
  pushState();
}

ipcMain.handle('get-state', () => publicState());
ipcMain.handle('refresh', () => refresh());
ipcMain.handle('logout', () => logout());
ipcMain.handle('use-claude-code', () => useClaudeCode());
ipcMain.handle('login-browser', () => { panel.hide(); loginBrowser(); });
ipcMain.handle('login', () => { panel.hide(); openLogin(); });
ipcMain.handle('set-setting', (_e, k, v) => setSetting(k, v));
ipcMain.handle('test-alert', () => notify('Teste do Medidor Claude', 'É assim que o aviso vai aparecer.'));
ipcMain.handle('hide', () => panel.hide());
ipcMain.handle('quit', () => { app.isQuitting = true; app.quit(); });

// ---------- modo screenshot (testes) ----------
async function screenshots() {
  const out = shotsDir(); fs.mkdirSync(out, { recursive: true });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const cap = async name => { panel.webContents.invalidate(); await wait(300); fs.writeFileSync(path.join(out, name), (await panel.webContents.capturePage()).toPNG()); };
  panel.setPosition(40, 40); panel.showInactive(); await wait(900);
  if (process.env.MEDIDOR_DEBUG) console.log('debug', JSON.stringify({ cli: state.hasClaudeCli, cc: state.hasClaudeCode, src: state.source }),
    await panel.webContents.executeJavaScript(`[...document.querySelectorAll('.card[data-kind=session] .seg')].slice(0,3).map(s=>s.style.background+'|'+getComputedStyle(s).backgroundColor).join(' ; ')`));
  await cap('panel.png');
  panel.webContents.send('show-view', 'settings'); await wait(400);
  await cap('settings.png');
  state.status = 'login'; panel.webContents.send('state', publicState()); panel.webContents.send('show-view', 'main'); await wait(400);
  await cap('login.png');
  for (const p of [0, 0.1, 0.2, 0.5, 0.8, 0.95, 1]) {
    for (const size of [16, 24, 64]) {
      const url = await panel.webContents.executeJavaScript(`window.renderIcon(${p}, false, ${size}, "ok")`);
      fs.writeFileSync(path.join(out, `icon-${Math.round(p * 100)}-${size}.png`), Buffer.from(url.split(',')[1], 'base64'));
    }
  }
  app.isQuitting = true; app.quit();
}

// ---------- início ----------
app.on('second-instance', () => panel && showPanel());
app.on('window-all-closed', e => e.preventDefault());

app.whenReady().then(async () => {
  settings = load('settings.json', { alerts: { 50: true, 80: true, 90: true }, sound: true, autostart: true, orgId: null, source: 'auto' });
  store = load('store.json', { history: [], alerted: {} });
  ses = session.fromPartition('persist:claude');
  ses.setUserAgent(UA);
  detectClaudeCli();
  app.userAgentFallback = UA;
  applyAutostart();

  await createPanel();
  tray = new Tray(nativeImage.createFromPath(ICON_PATH));
  tray.setToolTip('Medidor Claude');
  tray.on('click', togglePanel);
  await refresh();
  startPolling();
  // quando o Claude Code renovar o login, atualiza na hora
  fs.watchFile(claudeCodeCredPath(), { interval: 10e3 }, () => { if (settings.source !== 'web') refresh(); });

  if (SHOT) return screenshots();
  if (state.status === 'login' && !state.hasClaudeCode) openLogin();
  if (PROBE) {
    console.log('probe status:', state.status, state.error || '');
    setTimeout(async () => {
      const out = shotsDir(); fs.mkdirSync(out, { recursive: true });
      if (loginWin) {
        console.log('probe login url:', loginWin.webContents.getURL());
        try { fs.writeFileSync(path.join(out, 'login-window.png'), (await loginWin.webContents.capturePage()).toPNG()); }
        catch (e) { console.log('probe capture falhou:', e.message); }
      }
      app.isQuitting = true; app.quit();
    }, 12000);
  }
});
