// Painel do Medidor Claude: desenha medidores, gráficos e o ícone da bandeja.
const api = window.medidor;
const $ = s => document.querySelector(s);

// azul-claro -> azul -> amarelo -> vermelho -> vermelho escuro
const STOPS = [[0, [215, 240, 255]], [0.25, [96, 180, 255]], [0.5, [255, 210, 40]], [0.8, [255, 70, 60]], [1, [190, 20, 30]]];
function col(v) {
  v = Math.max(0, Math.min(1, v));
  for (let i = 1; i < STOPS.length; i++) {
    const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i];
    if (v <= b) { const t = (v - a) / (b - a); return ca.map((x, k) => Math.round(x + (cb[k] - x) * t)); }
  }
  return STOPS[STOPS.length - 1][1];
}
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const SEGS = 20;
const litCount = (pct, n) => pct <= 0 ? 0 : Math.min(n, Math.ceil(pct * n - 1e-6));

// ---------- ícone da bandeja (chamado pelo processo principal) ----------
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
window.renderIcon = function (pct, blinkOff, size, mode) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  roundRect(g, 0.5, 0.5, size - 1, size - 1, size * 0.22);
  g.fillStyle = 'rgb(36,36,40)'; g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = Math.max(1, size / 24); g.stroke();
  let text, color;
  if (mode === 'login') { text = '?'; color = '#9aa3b2'; }
  else if (mode !== 'ok') { text = '–'; color = '#9aa3b2'; }
  else { text = String(Math.round(pct * 100)); color = blinkOff ? 'rgb(110,20,25)' : rgb(col(pct)); }
  const nw = size * 0.66;
  const fs = size * (text.length < 3 ? 0.58 : 0.42);
  g.font = `700 ${fs}px "Segoe UI Variable Display", "Segoe UI", sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = color;
  g.fillText(text, nw / 2 + size * 0.02, size * 0.53, nw - size * 0.06);
  const n = 6, bw = Math.max(2, size * 0.18), bx = nw + (size - nw - bw) / 2 - size * 0.03;
  const by = size * 0.17, bh = size * 0.66, sh = bh / n, gap = Math.max(1, sh * 0.25);
  const lit = (mode === 'ok' && !blinkOff) ? litCount(pct, n) : 0;
  for (let i = 0; i < n; i++) {
    const y = by + bh - (i + 1) * sh + gap / 2;
    roundRect(g, bx, y, bw, sh - gap, Math.min(bw, sh - gap) / 2);
    g.fillStyle = i < lit ? rgb(col(pct)) : 'rgba(255,255,255,0.16)';
    g.fill();
  }
  return c.toDataURL('image/png');
};

// ---------- medidores ----------
function buildMeters() {
  document.querySelectorAll('.card').forEach(card => {
    const m = card.querySelector('.meter');
    for (let i = 0; i < SEGS; i++) m.appendChild(Object.assign(document.createElement('div'), { className: 'seg' }));
    const sc = card.querySelector('.scale');
    for (let k = 0; k <= 100; k += 10) {
      const s = document.createElement('span'); s.textContent = k; s.dataset.k = k; sc.appendChild(s);
    }
  });
}

function fmtTime(ms) { return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
function fmtReset(iso, kind) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const hm = fmtTime(d);
  if (kind === 'session' && d.toDateString() === now.toDateString()) return `zera às ${hm}`;
  return `zera ${d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')} ${hm}`;
}

function drawCard(card, d, history) {
  const kind = card.dataset.kind;
  const pct = d ? d.pct : 0;
  const c = col(pct);
  card.querySelector('.reset').textContent = d ? fmtReset(d.resetsAt, kind) : 'sem dados';

  const lit = d ? litCount(pct, SEGS) : 0;
  card.querySelectorAll('.seg').forEach((s, i) => {
    s.style.background = i < lit ? rgb(c) : '';
    s.style.boxShadow = i < lit ? `0 0 6px ${rgb(c, 0.55)}` : '';
  });

  const wrap = card.querySelector('.meter-wrap');
  const h = wrap.clientHeight - 12;
  const pill = card.querySelector('.pill');
  const ps = pill.querySelector('span');
  pill.style.bottom = `${6 + h * pct}px`;
  pill.style.color = rgb(c);
  ps.textContent = d ? `${Math.round(pct * 100)}%` : '—';
  ps.style.background = rgb(c, 0.14); ps.style.borderColor = rgb(c, 0.6);
  card.querySelectorAll('.scale span').forEach(s => {
    const y = h * s.dataset.k / 100;
    s.style.bottom = `${y}px`;
    s.style.visibility = Math.abs(y - h * pct) < 9 ? 'hidden' : 'visible';
  });

  drawChart(card, kind, d, history, c);
}

function drawChart(card, kind, d, history, c) {
  const svg = card.querySelector('svg');
  const W = svg.clientWidth || 240, H = svg.clientHeight || 110;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const key = kind === 'session' ? 's' : 'w';
  const span = kind === 'session' ? 5 * 3600e3 : 7 * 86400e3;
  const now = Date.now();
  const start = d && d.resetsAt ? Date.parse(d.resetsAt) - span : now - span;
  const pts = history.filter(p => p[key] != null && p.t >= start && p.t <= now).map(p => [p.t, p[key]]);
  if (d) pts.push([now, d.pct]);
  const X = t => (t - start) / Math.max(1, now - start) * W;
  const Y = v => H - 2 - (H - 4) * Math.max(0, Math.min(1, v));
  let grid = '';
  for (const k of [0.25, 0.5, 0.75]) grid += `<line x1="0" x2="${W}" y1="${Y(k)}" y2="${Y(k)}" stroke="rgba(255,255,255,0.09)" stroke-dasharray="3 4"/>`;
  if (pts.length < 2) {
    svg.innerHTML = grid + (d ? '' : `<text class="empty-chart" x="${W / 2}" y="${H / 2}" text-anchor="middle">sem dados ainda</text>`);
    return;
  }
  const line = pts.map(([t, v], i) => `${i ? 'L' : 'M'}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const lastX = X(pts[pts.length - 1][0]), firstX = X(pts[0][0]);
  const id = `g-${kind}`;
  svg.innerHTML = `
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${rgb(c, 0.42)}"/><stop offset="1" stop-color="${rgb(c, 0)}"/>
    </linearGradient></defs>
    ${grid}
    <path d="${line} L${lastX},${H} L${firstX},${H} Z" fill="url(#${id})"/>
    <path d="${line}" fill="none" stroke="${rgb(c)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lastX}" cy="${Y(pts[pts.length - 1][1])}" r="4" fill="${rgb(c)}" stroke="#202126" stroke-width="2"/>`;
}

// ---------- estado ----------
let current = null;
function render(st) {
  current = st;
  const upd = $('#updated');
  upd.classList.toggle('err', !!st.error);
  if (st.status === 'loading') upd.textContent = 'Carregando...';
  else if (st.error) upd.textContent = st.updatedAt ? `Sem conexão · ${fmtTime(st.updatedAt)}` : 'Sem conexão';
  else upd.textContent = st.updatedAt ? `Atualizado ${fmtTime(st.updatedAt)}` : '';

  const login = st.status === 'login';
  if (!$('#view-settings').hidden && !login) { /* fica nas configurações */ }
  else { $('#view-main').hidden = login; $('#view-login').hidden = !login; $('#view-settings').hidden = true; }
  $('#footer').hidden = login || !$('#view-settings').hidden;
  $('#btn-refresh').hidden = login;

  if (!login) {
    drawCard(document.querySelector('.card[data-kind="session"]'), st.session, st.history || []);
    drawCard(document.querySelector('.card[data-kind="week"]'), st.week, st.history || []);
  }
  document.querySelectorAll('[data-setting]').forEach(inp => {
    const k = inp.dataset.setting;
    inp.checked = k.startsWith('alert') ? !!st.settings.alerts[k.slice(5)] : !!st.settings[k];
  });
}

function showView(v) {
  const login = current && current.status === 'login';
  $('#view-settings').hidden = v !== 'settings';
  $('#view-main').hidden = v === 'settings' || login;
  $('#view-login').hidden = v === 'settings' || !login;
  $('#footer').hidden = v === 'settings' || login;
  if (v !== 'settings' && current) render(current);
}

// ---------- som do aviso ----------
function chime() {
  try {
    const ac = new AudioContext();
    [[880, 0], [1318.5, 0.16]].forEach(([f, t0]) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, ac.currentTime + t0);
      g.gain.linearRampToValueAtTime(0.25, ac.currentTime + t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + t0 + 0.45);
      o.connect(g).connect(ac.destination); o.start(ac.currentTime + t0); o.stop(ac.currentTime + t0 + 0.5);
    });
    setTimeout(() => ac.close(), 1200);
  } catch (e) { console.error(e); }
}

// ---------- eventos ----------
buildMeters();
$('#btn-refresh').onclick = async () => {
  const b = $('#btn-refresh'); b.classList.add('spin');
  try { await api.refresh(); } finally { b.classList.remove('spin'); }
};
$('#btn-settings').onclick = () => showView($('#view-settings').hidden ? 'settings' : 'main');
$('#btn-back').onclick = () => showView('main');
$('#btn-login').onclick = () => api.login();
$('#btn-logout').onclick = () => api.logout();
$('#btn-logout-footer').onclick = () => api.logout();
$('#btn-quit').onclick = () => api.quit();
$('#btn-test').onclick = () => api.testAlert();
document.querySelectorAll('[data-setting]').forEach(inp => inp.addEventListener('change', () => api.setSetting(inp.dataset.setting, inp.checked)));
document.addEventListener('keydown', e => { if (e.key === 'Escape') api.hide(); });

api.on('state', render);
api.on('chime', chime);
api.on('opened', () => current && render(current));
api.on('show-view', showView);
api.getState().then(render);
