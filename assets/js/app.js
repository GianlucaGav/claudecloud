import * as S from './stats.js';

// ---------------------------------------------------------------------------
// Configuración y estado
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  shopOdds: {
    1: [100, 0, 0, 0, 0], 2: [100, 0, 0, 0, 0], 3: [75, 25, 0, 0, 0], 4: [55, 30, 15, 0, 0],
    5: [45, 33, 20, 2, 0], 6: [30, 40, 25, 5, 0], 7: [19, 30, 40, 10, 1], 8: [18, 25, 32, 22, 3],
    9: [10, 20, 25, 35, 10], 10: [5, 10, 20, 40, 25], 11: [1, 2, 12, 50, 35],
  },
  copiesPerChampion: { 1: 30, 2: 25, 3: 18, 4: 10, 5: 9 },
  championsPerCostFallback: { 1: 13, 2: 13, 3: 13, 4: 12, 5: 8 },
  rerollCost: 2,
  lpByPlacement: [40, 30, 20, 10, -10, -20, -30, -40],
  priorStrength: 25,
  tiers: [
    { tier: 'S', maxAvg: 4.1 }, { tier: 'A', maxAvg: 4.3 }, { tier: 'B', maxAvg: 4.5 },
    { tier: 'C', maxAvg: 4.7 }, { tier: 'D', maxAvg: 99 },
  ],
};

const STYLE_LABEL = { reroll: 'Reroll', fast8: 'Fast 8', fast9: 'Fast 9', standard: 'Estándar' };
const ROLE_LABEL = { carry: 'Carry', carry2: 'Segundo carry', tank: 'Tanque' };
const TIER_LABEL = { challenger: 'Challenger', grandmaster: 'Gran Maestro', master: 'Maestro' };
const TRAIT_STYLE = { 1: 'bronce', 2: 'plata', 3: 'oro', 4: 'prismático' };
const PLATFORM_LABEL = {
  euw1: 'EUW', eun1: 'EUNE', na1: 'NA', kr: 'KR', br1: 'BR', la1: 'LAN', la2: 'LAS', jp1: 'JP',
  oc1: 'OCE', tr1: 'TR', ru: 'RU', me1: 'ME', sg2: 'SEA', tw2: 'TW', vn2: 'VN', th2: 'TH', ph2: 'PH',
};

const state = {
  meta: null,
  config: DEFAULT_CONFIG,
  demo: false,
  loadError: null,
  k: 25,
  sort: 'rec',
  style: 'all',
  minGames: 0,
  query: '',
  open: new Set(),
  calc: null,
};

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`tftmeta:${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`tftmeta:${key}`, JSON.stringify(value)); } catch { /* sin almacenamiento */ }
  },
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const nf = {};
const fmt = (x, d = 0) => {
  if (!Number.isFinite(x)) return '–';
  nf[d] ??= new Intl.NumberFormat('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });
  return nf[d].format(x);
};
const pct = (x, d = 0) => (Number.isFinite(x) ? `${fmt(x * 100, d)} %` : '–');
const prob = (x) => (x > 0.995 ? '>\u00a099\u00a0%' : x < 0.005 ? '<\u00a01\u00a0%' : pct(x));
const signed = (x, d = 1) => (Number.isFinite(x) ? `${x > 0 ? '+' : x < 0 ? '−' : '±'}${fmt(Math.abs(x), d)}` : '–');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

function pretty(api) {
  return String(api || '?').replace(/^TFT\d*_(Item_)?/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
}
const champ = (id) => state.meta?.static?.champions?.[id] || { name: pretty(id), cost: 0 };
const trait = (id) => state.meta?.static?.traits?.[id] || { name: pretty(id) };
const item = (id) => state.meta?.static?.items?.[id] || { name: pretty(id) };

function initials(name) {
  return String(name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

function img(src, name, cls) {
  const ph = esc(initials(name));
  if (!src) return `<span class="${cls} ph" aria-hidden="true">${ph}</span>`;
  return `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" decoding="async" data-ph="${ph}">`;
}

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

function ageText(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const h = ms / 3.6e6;
  if (h < 1) return `hace ${Math.max(1, Math.round(ms / 6e4))} min`;
  if (h < 48) return `hace ${Math.round(h)} h`;
  return `hace ${Math.round(h / 24)} días`;
}

const CHEVRON = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 5l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---------------------------------------------------------------------------
// Arranque, rutas, tema y tooltip
// ---------------------------------------------------------------------------

async function boot() {
  initTheme();
  initTooltip();
  state.demo = new URLSearchParams(location.search).has('demo');
  state.config = await getJSON('data/game-config.json').catch(() => DEFAULT_CONFIG);
  state.k = store.get('k', state.config.priorStrength ?? 25);
  try {
    state.meta = await getJSON(state.demo ? 'data/demo/meta.json' : 'data/meta.json');
    if (!state.meta?.comps?.length) state.meta = null;
  } catch (err) {
    state.loadError = err;
  }
  window.addEventListener('hashchange', render);
  render();
}

function route() {
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: ['comps', 'calc', 'metodo'].includes(name) ? name : 'comps', arg };
}

function render() {
  const r = route();
  $$('.tabs a').forEach((a) => {
    if (a.dataset.route === r.name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const view = $('#view');
  $('#tooltip').hidden = true;
  if (r.name === 'calc') {
    view.innerHTML = calcHTML(r.arg);
    bindCalc();
  } else if (r.name === 'metodo') {
    view.innerHTML = methodHTML();
    bindMethod();
  } else if (!state.meta) {
    view.innerHTML = emptyHTML();
  } else {
    view.innerHTML = heroHTML() + controlsHTML() + '<div id="list"></div>';
    bindControls();
    renderList();
  }
}

function initTheme() {
  const btn = $('#theme-btn');
  const icons = {
    auto: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>',
    light: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></g></svg>',
    dark: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" fill="currentColor"/></svg>',
  };
  const labels = { auto: 'Tema: automático', light: 'Tema: claro', dark: 'Tema: oscuro' };
  let theme = store.get('theme', 'auto');
  const apply = () => {
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    btn.innerHTML = icons[theme];
    btn.title = labels[theme];
    btn.setAttribute('aria-label', `${labels[theme]} (pulsa para cambiar)`);
  };
  apply();
  btn.addEventListener('click', () => {
    theme = theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto';
    store.set('theme', theme);
    apply();
  });
}

const tooltip = {
  el: null,
  show(html, x, y) {
    this.el.innerHTML = html;
    this.el.hidden = false;
    this.move(x, y);
  },
  move(x, y) {
    const pad = 14;
    const r = this.el.getBoundingClientRect();
    let left = x + pad;
    let top = y + pad;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - pad;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - pad;
    this.el.style.left = `${Math.max(8, left)}px`;
    this.el.style.top = `${Math.max(8, top)}px`;
  },
  hide() { this.el.hidden = true; },
};

function initTooltip() {
  tooltip.el = $('#tooltip');
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el) tooltip.show(el.dataset.tip, e.clientX, e.clientY);
  });
  document.addEventListener('pointermove', (e) => {
    if (!tooltip.el.hidden && e.target.closest?.('[data-tip]')) tooltip.move(e.clientX, e.clientY);
  });
  document.addEventListener('pointerout', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el && !el.contains(e.relatedTarget)) tooltip.hide();
  });
  // Iconos que no cargan: se sustituyen por sus iniciales.
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t.tagName === 'IMG' && t.dataset.ph !== undefined) {
      const span = document.createElement('span');
      span.className = `${t.className} ph`;
      span.setAttribute('aria-hidden', 'true');
      span.textContent = t.dataset.ph;
      t.replaceWith(span);
    }
  }, true);
}

// ---------------------------------------------------------------------------
// Composiciones
// ---------------------------------------------------------------------------

function statOptions() {
  return {
    k: state.k,
    lpTable: state.config.lpByPlacement,
    tiers: state.config.tiers,
    totalBoards: state.meta.sample.boards,
  };
}

const searchIndex = new WeakMap();
function searchText(c) {
  if (!searchIndex.has(c)) {
    const parts = [c.name, STYLE_LABEL[c.style]];
    c.units.forEach((u) => parts.push(champ(u.id).name));
    c.traits.forEach((t) => parts.push(trait(t.id).name));
    Object.values(c.items).forEach((info) => info.items.forEach((i) => parts.push(item(i.id).name)));
    searchIndex.set(c, norm(parts.join(' ')));
  }
  return searchIndex.get(c);
}

const SORTS = {
  rec: (a, b) => a.st.adj - b.st.adj,
  top4: (a, b) => b.st.top4Adj - a.st.top4Adj,
  win: (a, b) => b.st.winAdj - a.st.winAdj,
  lp: (a, b) => b.st.lp - a.st.lp,
  pick: (a, b) => b.st.n - a.st.n,
};

function rows() {
  const opts = statOptions();
  const q = norm(state.query).trim();
  return state.meta.comps
    .map((comp) => ({ comp, st: S.compStats(comp, opts) }))
    .filter(({ comp, st }) => (state.style === 'all' || comp.style === state.style)
      && st.n >= state.minGames
      && (!q || q.split(/\s+/).every((w) => searchText(comp).includes(w))))
    .sort(SORTS[state.sort]);
}

function heroHTML() {
  const m = state.meta;
  const s = m.sample;
  const hours = (Date.now() - Date.parse(m.generated_at)) / 3.6e6;
  const stale = !state.demo && hours > 36;
  const platforms = Object.keys(s.platforms || {}).map((p) => PLATFORM_LABEL[p] || p.toUpperCase()).join(', ');
  const tiers = (s.tiers || []).map((t) => TIER_LABEL[t] || t).join(', ');
  const days = s.from && s.to ? `${new Date(s.from).toLocaleDateString('es-ES')} – ${new Date(s.to).toLocaleDateString('es-ES')}` : '';
  const demo = state.demo
    ? `<div class="banner"><b>Modo demostración.</b> Campeones, rasgos y resultados inventados para enseñar cómo funciona la web: no es el meta real. <a href="./#/comps">Volver a los datos reales</a></div>`
    : '';
  return `
    <section class="hero">
      <h1>Mejores composiciones · Set ${esc(m.set?.number ?? '?')}</h1>
      <p>Ordenadas por posición media ajustada (bayesiana) en partidas clasificatorias de alto elo. Pulsa una composición para ver el detalle.</p>
      <div class="sample">
        <span><b>${fmt(s.matches)}</b> partidas</span>
        <span><b>${fmt(s.boards)}</b> tableros (${pct(s.assigned / s.boards)} agrupados en composiciones)</span>
        ${(s.versions || []).some((v) => v !== '?') ? `<span>Versión ${esc(s.versions.filter((v) => v !== '?').join(', '))}</span>` : ''}
        <span>${esc(tiers)}${platforms ? ` · ${esc(platforms)}` : ''}</span>
        ${days ? `<span>${esc(days)}</span>` : ''}
        <span class="${stale ? 'stale' : ''}">Actualizado ${esc(ageText(m.generated_at))}${stale ? ' (¿ha fallado el Action?)' : ''}</span>
      </div>
      ${demo}
    </section>`;
}

function controlsHTML() {
  const styles = ['all', 'reroll', 'fast8', 'fast9'];
  const sorts = [
    ['rec', 'Recomendación (media ajustada)'], ['top4', 'Top 4'], ['win', 'Victorias'],
    ['lp', 'LP esperados'], ['pick', 'Popularidad'],
  ];
  const mins = [0, 30, 100, 250, 500];
  return `
    <div class="controls">
      <input type="search" id="q" placeholder="Buscar campeón, rasgo u objeto…" aria-label="Buscar" value="${esc(state.query)}">
      <div class="seg" role="group" aria-label="Estilo de juego">
        ${styles.map((s) => `<button type="button" data-style="${s}" aria-pressed="${state.style === s}">${s === 'all' ? 'Todas' : STYLE_LABEL[s]}</button>`).join('')}
      </div>
      <label>Ordenar <select id="sort">${sorts.map(([v, l]) => `<option value="${v}" ${state.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Mín. partidas <select id="min">${mins.map((v) => `<option value="${v}" ${state.minGames === v ? 'selected' : ''}>${v || 'Todas'}</option>`).join('')}</select></label>
    </div>
    <p class="result-count" id="count" aria-live="polite"></p>`;
}

function bindControls() {
  $('#q').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; renderList(); });
  $('#min').addEventListener('change', (e) => { state.minGames = Number(e.target.value); renderList(); });
  $$('.seg button').forEach((b) => b.addEventListener('click', () => {
    state.style = b.dataset.style;
    $$('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderList();
  }));
  $('#list').addEventListener('click', (e) => {
    if (e.target.closest('a, .comp-body')) return;
    const head = e.target.closest('.comp-head');
    if (head) toggleComp(head.closest('.comp'));
  });
}

function toggleComp(article) {
  const id = article.dataset.id;
  const body = $('.comp-body', article);
  const open = !state.open.has(id);
  if (open) {
    state.open.add(id);
    const comp = state.meta.comps.find((c) => c.id === id);
    body.innerHTML = detailHTML(comp, S.compStats(comp, statOptions()));
  } else {
    state.open.delete(id);
  }
  body.hidden = !open;
  article.classList.toggle('open', open);
  $('.toggle', article).setAttribute('aria-expanded', String(open));
}

function renderList() {
  const list = rows();
  $('#count').textContent = `${list.length} de ${state.meta.comps.length} composiciones`;
  let html = '';
  if (!list.length) {
    html = '<p class="muted">Ninguna composición coincide con los filtros.</p>';
  } else if (state.sort === 'rec') {
    for (const { tier, maxAvg } of state.config.tiers) {
      const group = list.filter((r) => r.st.tier === tier);
      if (!group.length) continue;
      const prev = state.config.tiers[state.config.tiers.findIndex((t) => t.tier === tier) - 1];
      const range = prev ? `media ajustada ${fmt(prev.maxAvg, 2)}–${fmt(Math.min(maxAvg, 8), 2)}` : `media ajustada ≤ ${fmt(maxAvg, 2)}`;
      html += `<section class="tier-section" aria-label="Tier ${tier}">
        <div class="tier-heading"><span class="tier tier-${tier}">${tier}</span><h2>${group.length} ${group.length === 1 ? 'composición' : 'composiciones'} · ${range}</h2></div>
        ${group.map(cardHTML).join('')}
      </section>`;
    }
  } else {
    html = list.map(cardHTML).join('');
  }
  $('#list').innerHTML = html;
}

function modeStars(u) {
  if (!u?.stars) return 1;
  const total = sum(u.stars) || 1;
  return (u.stars[2] + (u.stars[3] || 0)) / total >= 0.4 ? 3 : 0;
}

function avgStars(u) {
  const total = sum(u.stars) || 1;
  return u.stars.reduce((acc, c, i) => acc + c * (i + 1), 0) / total;
}

function topItems(info) {
  if (!info) return [];
  return info.builds?.[0]?.items || info.items.slice(0, 3).map((i) => i.id);
}

function unitHTML(id, { stars = 0, items = [], carry = false } = {}) {
  const c = champ(id);
  const itemIcons = items.map((i) => img(item(i).icon, item(i).name, 'item-img')).join('');
  const tip = `<div class="tt-title">${esc(c.name)}</div>Coste ${esc(c.cost)}${items.length ? `<br>${items.map((i) => esc(item(i).name)).join(' · ')}` : ''}`;
  return `<figure class="unit cost-${c.cost || 0}${carry ? ' carry' : ''}" data-tip="${esc(tip)}">
    ${stars >= 3 ? '<span class="stars" aria-label="3 estrellas">★★★</span>' : ''}
    ${img(c.icon, c.name, 'unit-img')}
    ${itemIcons ? `<span class="unit-items">${itemIcons}</span>` : ''}
    <figcaption>${esc(c.name)}</figcaption>
  </figure>`;
}

function boardHTML(c) {
  const byId = Object.fromEntries(c.units.map((u) => [u.id, u]));
  const ids = [...c.board].sort((a, b) => (champ(a).cost - champ(b).cost) || champ(a).name.localeCompare(champ(b).name));
  return ids.map((id) => unitHTML(id, {
    stars: modeStars(byId[id]),
    items: c.items[id] ? topItems(c.items[id]) : [],
    carry: id === c.carry || id === c.carry2,
  })).join('');
}

/** Mini gráfico de intervalo: posición media ajustada con su IC 95 % en la escala 3–6. */
function ciBar(st) {
  const W = 84, H = 12, lo = 3, hi = 6;
  const x = (v) => 4 + ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (W - 8);
  const tip = `<div class="tt-title">Posición media ajustada</div>${fmt(st.adj, 2)} (IC 95 %: ${fmt(st.adjLo, 2)} – ${fmt(st.adjHi, 2)})<br>Media real: ${fmt(st.mean, 2)}<br>La marca vertical es 4,5 (una composición media). Menos es mejor.`;
  return `<svg class="ci-bar" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" data-tip="${esc(tip)}" role="img" aria-label="Intervalo de confianza ${fmt(st.adjLo, 2)} a ${fmt(st.adjHi, 2)}">
    <line x1="4" x2="${W - 4}" y1="6" y2="6" stroke="var(--grid)" stroke-width="2" stroke-linecap="round"/>
    <line x1="${x(4.5)}" x2="${x(4.5)}" y1="1" y2="11" stroke="var(--ink-2)" stroke-width="1"/>
    <line x1="${x(st.adjLo)}" x2="${x(st.adjHi)}" y1="6" y2="6" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"/>
    <circle cx="${x(st.adj)}" cy="6" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>
  </svg>`;
}

function cardHTML({ comp: c, st }) {
  const open = state.open.has(c.id);
  const tipAdj = `<div class="tt-title">Media ajustada</div>Posición media corregida por tamaño de muestra (prior bayesiano de ${fmt(state.k)} partidas). Menos es mejor.`;
  return `<article class="comp${open ? ' open' : ''}" data-id="${esc(c.id)}">
    <div class="comp-head">
      <span class="tier tier-${st.tier}" data-tip="${esc(`Tier ${st.tier} · probabilidad de ser mejor que la media: ${prob(st.pBetter)}`)}">${st.tier}</span>
      <div class="comp-title">
        <h3>${esc(c.name)}</h3>
        <div class="meta-line"><span class="tag">${STYLE_LABEL[c.style] || c.style}</span><span>${fmt(st.n)} partidas</span></div>
      </div>
      <div class="board">${boardHTML(c)}</div>
      <dl class="kpis">
        <div><dt data-tip="${esc(tipAdj)}">Media aj.</dt><dd>${fmt(st.adj, 2)}</dd>${ciBar(st)}</div>
        <div><dt>Top 4</dt><dd>${pct(st.top4)}</dd></div>
        <div><dt>Victoria</dt><dd>${pct(st.win)}</dd></div>
        <div><dt>Juego</dt><dd>${pct(st.pickRate, 1)}</dd></div>
      </dl>
      <button class="toggle" type="button" aria-expanded="${open}" aria-controls="body-${esc(c.id)}" aria-label="Ver detalles de ${esc(c.name)}">${CHEVRON}</button>
    </div>
    <div class="comp-body" id="body-${esc(c.id)}"${open ? '' : ' hidden'}>${open ? detailHTML(c, st) : ''}</div>
  </article>`;
}

function deltaHTML(d, what = 'la composición') {
  if (!Number.isFinite(d)) return '<span class="delta muted">–</span>';
  if (Math.abs(d) < 0.03) return '<span class="delta muted" title="Sin diferencia apreciable">± 0,00</span>';
  const good = d < 0;
  const tip = `${fmt(Math.abs(d), 2)} posiciones ${good ? 'mejor' : 'peor'} que la media de ${what}`;
  return `<span class="delta ${good ? 'good' : 'bad'}" data-tip="${esc(tip)}"><span aria-hidden="true">${good ? '▲' : '▼'}</span> ${fmt(Math.abs(d), 2)}<span class="sr-only"> ${good ? 'mejor' : 'peor'}</span></span>`;
}

function tile(label, value, sub = '') {
  return `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
}

function placementChart(c) {
  const n = sum(c.placements) || 1;
  const vals = c.placements.map((v) => v / n);
  const W = 360, H = 170, L = 36, R = 44, T = 10, B = 24;
  const maxV = Math.max(0.2, Math.ceil(Math.max(...vals) * 20) / 20);
  const band = (W - L - R) / 8;
  const bw = Math.min(24, band * 0.62);
  const y = (v) => T + (1 - v / maxV) * (H - T - B);
  const yb = y(0);
  let grid = '';
  const step = maxV > 0.3 ? 0.1 : 0.05;
  for (let v = 0; v <= maxV + 1e-9; v += step) {
    grid += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end">${fmt(v * 100)} %</text>`;
  }
  let bars = '';
  vals.forEach((v, i) => {
    const cx = L + band * (i + 0.5);
    const x0 = cx - bw / 2, x1 = cx + bw / 2, top = y(v);
    const r = Math.min(4, (yb - top) / 2, bw / 2);
    const d = `M${x0},${yb} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x1 - r} Q${x1},${top} ${x1},${top + r} V${yb} Z`;
    const tip = `<div class="tt-title">${i + 1}º puesto</div>${pct(v, 1)} de las partidas (${fmt(c.placements[i])})`;
    bars += `<rect class="hit" x="${cx - band / 2}" y="${T}" width="${band}" height="${H - T - B}" data-tip="${esc(tip)}"/>`;
    bars += `<path class="bar" d="${d}" fill="var(--p${i + 1})" pointer-events="none"/>`;
    bars += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${i + 1}º</text>`;
  });
  const ref = y(0.125);
  const table = `<div class="sr-only"><table><caption>Distribución de posiciones</caption><tr>${vals.map((v, i) => `<th>${i + 1}º</th><td>${pct(v, 1)}</td>`).join('')}</tr></table></div>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Distribución de posiciones finales">
    ${grid}
    <line class="axis" x1="${L}" x2="${W - R}" y1="${yb}" y2="${yb}"/>
    ${bars}
    <line class="ref" x1="${L}" x2="${W - R}" y1="${ref}" y2="${ref}" pointer-events="none"/>
    <text class="ref-label" x="${W - R + 4}" y="${ref + 3.5}">azar</text>
  </svg>${table}`;
}

function detailHTML(c, st) {
  const mean = st.mean;
  const k = state.k;

  // Unidades
  const unitRows = c.units.map((u) => {
    const ch = champ(u.id);
    const d = S.shrunkMean(u.ps, u.n, k, mean) - mean;
    return `<tr>
      <td><div class="cell-unit cost-${ch.cost || 0}">${img(ch.icon, ch.name, 'unit-img')}<span>${esc(ch.name)} <span class="muted">· ${esc(ch.cost)}</span></span></div></td>
      <td><div class="freq"><div class="freq-track"><div class="freq-fill" style="width:${(u.n / st.n) * 100}%"></div></div><span class="num">${pct(u.n / st.n)}</span></div></td>
      <td class="num">${fmt(avgStars(u), 1)}★</td>
      <td class="num">${u.n / st.n > 0.97 ? '<span class="muted">núcleo</span>' : deltaHTML(d)}</td>
    </tr>`;
  }).join('');

  // Objetos
  const itemsBlocks = Object.entries(c.items).map(([uid, info]) => {
    const ch = champ(uid);
    const base = info.ps / Math.max(info.n, 1);
    const builds = info.builds.slice(0, 4).map((b) => {
      const d = S.shrunkMean(b.ps, b.n, k, base) - base;
      return `<div class="build"><div class="icons">${b.items.map((i) => `<span data-tip="${esc(item(i).name)}">${img(item(i).icon, item(i).name, 'item-img')}</span>`).join('')}</div>
        <div class="stat"><div>${pct(b.n / info.n)} <span class="muted">(${fmt(b.n)})</span></div><div>${deltaHTML(d, `${ch.name} en esta comp`)}</div></div></div>`;
    }).join('');
    const chips = info.items.slice(0, 8).map((i) => {
      const d = S.shrunkMean(i.ps, i.n, k, base) - base;
      return `<span class="chip">${img(item(i.id).icon, item(i.id).name, 'item-img')}${esc(item(i.id).name)} <span class="muted num">${pct(i.n / info.n)}</span> ${deltaHTML(d, `${ch.name} en esta comp`)}</span>`;
    }).join('');
    return `<div class="items-unit">
      <header>${img(ch.icon, ch.name, 'unit-img')}<div><b>${esc(ch.name)}</b><div class="muted" style="font-size:12px">${ROLE_LABEL[info.role] || ''} · con objetos en ${fmt(info.n)} partidas</div></div></header>
      ${builds ? `<div class="muted" style="font-size:12px;margin-bottom:4px">Builds completas más jugadas</div>${builds}` : ''}
      <div class="muted" style="font-size:12px;margin:10px 0 6px">Objetos sueltos</div><div class="chips">${chips}</div>
    </div>`;
  }).join('');

  // Rasgos y nivel
  const traits = c.traits.map((t) => {
    const tr = trait(t.id);
    const tip = `${esc(tr.name)} (${t.units} unidades) activo en ${pct(t.n / st.n)} de las partidas · nivel ${TRAIT_STYLE[t.style] || '-'}`;
    return `<span class="chip tstyle-${t.style || 0}" data-tip="${esc(tip)}"><span class="trait-dot" aria-hidden="true"></span><b>${esc(t.units)}</b> ${esc(tr.name)}</span>`;
  }).join('');
  const levelTotal = sum(Object.values(c.levels));
  const levels = Object.entries(c.levels).filter(([, v]) => v / levelTotal >= 0.02).map(([lvl, v]) => `
    <div class="row"><span>Nivel ${esc(lvl)}</span><div class="track"><div class="fill" style="width:${(v / levelTotal) * 100}%"></div></div><span class="num">${pct(v / levelTotal)}</span></div>`).join('');

  const augments = (c.augments || []).slice(0, 12).map((a) => {
    const d = S.shrunkMean(a.ps, a.n, k, mean) - mean;
    return `<span class="chip">${img(item(a.id).icon, item(a.id).name, 'item-img')}${esc(item(a.id).name)} <span class="muted num">${pct(a.n / st.n)}</span> ${deltaHTML(d)}</span>`;
  }).join('');

  const contested = st.contestedRate === null ? '' : tile(
    'Carry disputado',
    pct(st.contestedRate),
    `Media ${fmt(st.contestedAvg, 2)} si otro jugador lo tiene a 2★+, ${fmt(st.freeAvg, 2)} si no`,
  );
  const carry = champ(c.carry);

  return `
    <div class="detail-grid">
      <section class="panel">
        <h4>Distribución de posiciones</h4>
        ${placementChart(c)}
        <div class="tiles">
          ${tile('Media ajustada', fmt(st.adj, 2), `IC 95 %: ${fmt(st.adjLo, 2)} – ${fmt(st.adjHi, 2)} · real ${fmt(st.mean, 2)}`)}
          ${tile('Top 4', pct(st.top4, 1), `IC 95 %: ${pct(st.top4CI[0])} – ${pct(st.top4CI[1])}`)}
          ${tile('Victoria', pct(st.win, 1), `IC 95 %: ${pct(st.winCI[0])} – ${pct(st.winCI[1])}`)}
          ${tile('Mejor que la media', prob(st.pBetter), 'Probabilidad de que su media real sea < 4,5')}
          ${tile('LP esperados', signed(st.lp), 'Por partida (aproximado)')}
          ${contested}
        </div>
      </section>
      <section class="panel">
        <h4>Unidades</h4>
        <table class="data">
          <thead><tr><th>Unidad</th><th>Presencia</th><th class="num">★ media</th><th class="num" data-tip="Posición media cuando la unidad está en el tablero, comparada con la media de la composición. ▲ mejor · ▼ peor. Ojo: las unidades que se añaden tarde (nivel 9) salen favorecidas porque solo las tienen quienes sobreviven.">Con ella</th></tr></thead>
          <tbody>${unitRows}</tbody>
        </table>
      </section>
    </div>
    <section class="panel">
      <h4>Objetos</h4>
      <div class="items-block">${itemsBlocks || '<p class="muted">Sin datos de objetos.</p>'}</div>
    </section>
    <div class="detail-grid">
      <section class="panel"><h4>Rasgos activos</h4><div class="chips">${traits}</div></section>
      <section class="panel"><h4>Nivel final</h4><div class="bars-list">${levels}</div></section>
    </div>
    ${augments ? `<section class="panel"><h4>Aumentos</h4><div class="chips">${augments}</div></section>` : ''}
    <div class="actions">
      <a class="btn" href="#/calc/${esc(c.id)}">Probabilidad de conseguir a ${esc(carry.name)}</a>
    </div>`;
}

// ---------------------------------------------------------------------------
// Calculadora de probabilidades de tienda
// ---------------------------------------------------------------------------

function suggestLevel(style, cost) {
  if (style === 'reroll') return { 1: 6, 2: 6, 3: 7 }[cost] || 8;
  if (style === 'fast9' || cost >= 5) return 9;
  return 8;
}

function calcState(arg) {
  let c = state.calc || { champ: null, cost: 4, level: 8, target: 3, owned: 1, others: 0, sameCost: 0, gold: 50, odds: null, copies: null, champs: null };
  const comp = arg && state.meta?.comps.find((x) => x.id === arg);
  if (comp) {
    const cost = champ(comp.carry).cost || 4;
    const reroll = comp.style === 'reroll';
    c = { ...c, champ: comp.carry, cost, level: suggestLevel(comp.style, cost), target: reroll ? 9 : 3, owned: reroll ? 3 : 1, others: 0, sameCost: 0, odds: null, copies: null, champs: null };
  }
  state.calc = c;
  return c;
}

function poolFor(c) {
  const cfg = state.config;
  const odds = c.odds || cfg.shopOdds[c.level] || cfg.shopOdds[8];
  const copies = c.copies ?? cfg.copiesPerChampion[c.cost];
  const champs = c.champs ?? (state.meta?.pool?.championsPerCost?.[c.cost] || cfg.championsPerCostFallback[c.cost]);
  return { odds, copies, champs };
}

function calcHTML(arg) {
  const c = calcState(arg);
  const { odds, copies, champs } = poolFor(c);
  const champsList = Object.entries(state.meta?.static?.champions || {})
    .sort(([, a], [, b]) => a.cost - b.cost || a.name.localeCompare(b.name));
  const groups = [1, 2, 3, 4, 5].map((cost) => {
    const opts = champsList.filter(([, ch]) => ch.cost === cost)
      .map(([id, ch]) => `<option value="${esc(id)}" ${c.champ === id ? 'selected' : ''}>${esc(ch.name)}</option>`).join('');
    return opts ? `<optgroup label="Coste ${cost}">${opts}</optgroup>` : '';
  }).join('');
  const levelOpts = Array.from({ length: 11 }, (_, i) => i + 1)
    .map((l) => `<option value="${l}" ${c.level === l ? 'selected' : ''}>${l}</option>`).join('');
  const demo = state.demo ? '<div class="banner"><b>Modo demostración.</b> Los campeones de la lista son inventados.</div>' : '';
  return `
    <section class="hero">
      <h1>Calculadora de probabilidades de roll</h1>
      <p>¿Cuánto oro necesitas para encontrar a tu carry? Cálculo exacto (cadena de Markov) casilla a casilla, con el pool compartido entre los 8 jugadores.</p>
      ${demo}
    </section>
    <div class="calc">
      <form class="card" id="calc-form" autocomplete="off" onsubmit="return false">
        ${champsList.length ? `<label class="field"><span>Campeón</span><select name="champ"><option value="">— Elegir solo el coste —</option>${groups}</select></label>` : ''}
        <div class="field-row">
          <label class="field"><span>Coste</span><select name="cost">${[1, 2, 3, 4, 5].map((v) => `<option value="${v}" ${c.cost === v ? 'selected' : ''}>${v} de oro</option>`).join('')}</select></label>
          <label class="field"><span>Tu nivel</span><select name="level">${levelOpts}</select></label>
        </div>
        <label class="field"><span>Objetivo</span><select name="target">
          <option value="3" ${c.target === 3 ? 'selected' : ''}>★★ (3 copias)</option>
          <option value="9" ${c.target === 9 ? 'selected' : ''}>★★★ (9 copias)</option>
        </select></label>
        <div class="field-row">
          <label class="field"><span>Copias que ya tienes</span><input type="number" name="owned" min="0" max="9" value="${c.owned}"></label>
          <label class="field"><span>En otros tableros</span><input type="number" name="others" min="0" max="30" value="${c.others}"></label>
        </div>
        <label class="field"><span>Otras cartas de ese coste fuera del pool</span><input type="number" name="sameCost" min="0" max="300" value="${c.sameCost}">
          <span class="hint">Unidades distintas del mismo coste en todos los tableros y banquillos. Cuantas más, más fácil encontrar la tuya.</span></label>
        <label class="field"><span>Oro para tirar y comprar</span><input type="number" name="gold" min="0" max="500" value="${c.gold}"></label>
        <details class="adv">
          <summary>Probabilidades de tienda y pool</summary>
          <p class="hint">Valores de <code>data/game-config.json</code>. Si un parche los cambia, edítalos aquí o en ese archivo.</p>
          <div class="field"><span>Probabilidad por coste a nivel <span id="odds-level">${c.level}</span> (%)</span>
            <div class="odds-inputs">${odds.map((v, i) => `<input type="number" name="odds${i}" min="0" max="100" step="1" value="${v}" aria-label="Coste ${i + 1}">`).join('')}</div>
            <span class="hint">Coste 1 · 2 · 3 · 4 · 5</span></div>
          <div class="field-row">
            <label class="field"><span>Copias por campeón</span><input type="number" name="copies" min="1" max="60" value="${copies}"></label>
            <label class="field"><span>Campeones de ese coste</span><input type="number" name="champs" min="1" max="30" value="${champs}"></label>
          </div>
          <button type="button" class="btn secondary" id="calc-reset">Restablecer valores del parche</button>
        </details>
      </form>
      <div id="calc-out"></div>
    </div>`;
}

function readCalcForm(form, changed) {
  const c = state.calc;
  const v = (name) => form.elements[name]?.value;
  const int = (name, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v(name)) || 0)));
  if (changed === 'champ') {
    c.champ = v('champ') || null;
    if (c.champ) {
      c.cost = champ(c.champ).cost || c.cost;
      form.elements.cost.value = String(c.cost);
    }
  }
  if (changed === 'cost') {
    c.cost = int('cost', 1, 5);
    if (c.champ && champ(c.champ).cost !== c.cost && form.elements.champ) {
      c.champ = null;
      form.elements.champ.value = '';
    }
  }
  if (changed === 'champ' || changed === 'cost') { c.copies = null; c.champs = null; }
  if (changed === 'level') { c.level = int('level', 1, 11); c.odds = null; }
  c.target = Number(v('target')) || 3;
  c.owned = int('owned', 0, 9);
  c.others = int('others', 0, 60);
  c.sameCost = int('sameCost', 0, 400);
  c.gold = int('gold', 0, 1000);
  if (/^odds\d$/.test(changed || '')) c.odds = [0, 1, 2, 3, 4].map((i) => Math.max(0, Number(v(`odds${i}`)) || 0));
  if (changed === 'copies') c.copies = int('copies', 1, 60);
  if (changed === 'champs') c.champs = int('champs', 1, 30);
  // Refleja en el formulario los valores derivados (probabilidades del nivel, pool del coste).
  const { odds, copies, champs } = poolFor(c);
  if (!/^odds\d$/.test(changed || '')) odds.forEach((o, i) => { form.elements[`odds${i}`].value = o; });
  if (changed !== 'copies') form.elements.copies.value = copies;
  if (changed !== 'champs') form.elements.champs.value = champs;
  $('#odds-level').textContent = c.level;
}

function bindCalc() {
  const form = $('#calc-form');
  form.addEventListener('input', (e) => { readCalcForm(form, e.target.name); renderCalcOut(); });
  form.addEventListener('change', (e) => { if (e.target.tagName === 'SELECT') { readCalcForm(form, e.target.name); renderCalcOut(); } });
  $('#calc-reset').addEventListener('click', () => {
    Object.assign(state.calc, { odds: null, copies: null, champs: null });
    readCalcForm(form, 'reset');
    renderCalcOut();
  });
  readCalcForm(form, null);
  renderCalcOut();
}

function chainFor(c, level) {
  const { copies, champs } = poolFor(c);
  const odds = level === c.level ? poolFor(c).odds : (state.config.shopOdds[level] || [0, 0, 0, 0, 0]);
  const need = Math.max(0, c.target - c.owned);
  const chain = S.rollChain({
    costOdds: odds[c.cost - 1], copies, champions: champs, owned: c.owned,
    othersTaken: c.others, sameCostTaken: c.sameCost, need, maxShops: 500,
  });
  const target = copies - c.owned - c.others;
  const tier = copies * champs - c.owned - c.others - c.sameCost;
  const perSlot = tier > 0 ? (odds[c.cost - 1] / 100) * Math.max(0, target) / tier : 0;
  return { chain, need, perSlot, perShop: 1 - (1 - perSlot) ** 5 };
}

function renderCalcOut() {
  const c = state.calc;
  const rc = state.config.rerollCost ?? 2;
  const main = chainFor(c, c.level);
  const name = c.champ ? champ(c.champ).name : `un campeón de coste ${c.cost}`;
  const starText = c.target === 9 ? '★★★' : '★★';
  const out = $('#calc-out');

  if (main.need === 0) {
    out.innerHTML = `<div class="card"><div class="big-figure">100 %</div><p>Ya tienes las copias necesarias para ${esc(name)} ${starText}.</p></div>`;
    return;
  }
  const p = S.probWithGold(main.chain, c.gold, c.cost, main.need, rc);
  const g = (q) => S.goldForProb(main.chain, q, c.cost, main.need, rc);
  const expGold = main.chain.possible ? main.chain.expectedShops * rc + c.cost * main.need : null;
  const impossible = !main.chain.possible;

  // Niveles a comparar. El color va ligado al papel: tu nivel siempre usa la serie 1.
  const roles = [[c.level, 's1', ' (tú)'], [c.level - 1, 's2', ' (−1)'], [c.level + 1, 's3', ' (+1)']];
  const series = roles
    .filter(([l]) => l >= 1 && l <= 11 && ((l === c.level ? poolFor(c).odds : state.config.shopOdds[l]) || [])[c.cost - 1] > 0)
    .map(([l, slot, tag]) => ({ level: l, color: `var(--${slot})`, tag, ...chainFor(c, l) }))
    .sort((a, b) => a.level - b.level);
  const g95 = g(0.95);
  const maxGold = Math.min(400, Math.max(40, Math.ceil((Math.max(g95 ?? 0, c.gold * 1.2, g(0.8) ?? 0) * 1.1) / 10) * 10));

  const tableLevels = [];
  for (let l = Math.max(1, c.level - 2); l <= Math.min(11, c.level + 2); l++) tableLevels.push(l);
  const tableRows = tableLevels.map((l) => {
    const r = chainFor(c, l);
    const pl = S.probWithGold(r.chain, c.gold, c.cost, r.need, rc);
    const g50 = S.goldForProb(r.chain, 0.5, c.cost, r.need, rc);
    const g80 = S.goldForProb(r.chain, 0.8, c.cost, r.need, rc);
    const cur = l === c.level;
    return `<tr${cur ? ' style="font-weight:650"' : ''}><td>Nivel ${l}${cur ? ' (tú)' : ''}</td>
      <td class="num">${pct(r.perSlot, 2)}</td><td class="num">${pct(r.perShop, 1)}</td>
      <td class="num">${r.chain.possible ? prob(pl) : '0 %'}</td><td class="num">${g50 === null ? '—' : fmt(g50)}</td><td class="num">${g80 === null ? '—' : fmt(g80)}</td></tr>`;
  }).join('');

  out.innerHTML = `
    <div class="card">
      <div class="calc-summary">
        <div><div class="big-figure">${impossible ? '0 %' : prob(p)}</div></div>
        <p style="margin:0;max-width:420px">de conseguir <b>${esc(name)} ${starText}</b> con <b>${fmt(c.gold)} de oro</b> a nivel ${c.level}
          (te faltan ${main.need} ${main.need === 1 ? 'copia' : 'copias'}).</p>
      </div>
      ${impossible ? `<p class="stale">Imposible: no quedan suficientes copias en el pool (o a este nivel no salen campeones de coste ${c.cost}).</p>` : `
      <div class="tiles">
        ${tile('Oro para 50 %', g(0.5) === null ? '—' : fmt(g(0.5)))}
        ${tile('Oro para 80 %', g(0.8) === null ? '—' : fmt(g(0.8)))}
        ${tile('Oro para 95 %', g95 === null ? '—' : fmt(g95))}
        ${tile('Oro medio', fmt(expGold), `${fmt(main.chain.expectedShops, 1)} tiendas de media`)}
        ${tile('Por tienda', pct(main.perShop, 1), 'Prob. de ver al menos una copia')}
      </div>`}
    </div>
    ${impossible ? '' : `<div class="card" style="margin-top:18px">
      <h4 style="font-size:13px;text-transform:uppercase;letter-spacing:.4px;color:var(--ink-2)">Probabilidad acumulada según el oro gastado</h4>
      <div class="legend">${series.map((s) => `<span><span class="key" style="background:${s.color}"></span>Nivel ${s.level}${s.tag}</span>`).join('')}</div>
      ${probChart(series, c, maxGold)}
    </div>`}
    <div class="card" style="margin-top:18px">
      <h4 style="font-size:13px;text-transform:uppercase;letter-spacing:.4px;color:var(--ink-2);margin-bottom:8px">¿Subo de nivel o tiro aquí?</h4>
      <table class="data">
        <thead><tr><th>Nivel</th><th class="num">Por casilla</th><th class="num">Por tienda</th><th class="num">Con ${fmt(c.gold)} de oro</th><th class="num">Oro 50 %</th><th class="num">Oro 80 %</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
      <p class="hint" style="margin-top:8px">No descuenta el oro que cuesta subir de nivel. Supone que compras cada copia que ves y que las tiendas son independientes; no incluye aumentos ni efectos especiales del set.</p>
    </div>`;
  bindProbChart(series, c, maxGold);
}

function probChart(series, c, maxGold) {
  const W = 640, H = 260, L = 44, R = 16, T = 12, B = 30;
  const rc = state.config.rerollCost ?? 2;
  const x = (g) => L + (g / maxGold) * (W - L - R);
  const y = (p) => T + (1 - p) * (H - T - B);
  const stepX = maxGold > 200 ? 50 : maxGold > 80 ? 20 : 10;
  let grid = '';
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    grid += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}"/><text x="${L - 8}" y="${y(p) + 3.5}" text-anchor="end">${fmt(p * 100)} %</text>`;
  }
  for (let g = 0; g <= maxGold; g += stepX) grid += `<text x="${x(g)}" y="${H - 10}" text-anchor="middle">${g}</text>`;
  let lines = '';
  for (const s of series) {
    const pts = [];
    for (let g = 0; g <= maxGold; g++) pts.push([x(g), y(S.probWithGold(s.chain, g, c.cost, s.need, rc))]);
    const d = `M${pts.map((p) => p.join(',')).join(' L')}`;
    if (s.level === c.level) lines = `<path class="area" d="${d} L${x(maxGold)},${y(0)} L${x(0)},${y(0)} Z" fill="${s.color}" opacity="0.1"/>` + lines;
    lines += `<path class="line" d="${d}" stroke="${s.color}"/>`;
  }
  const you = series.find((s) => s.level === c.level);
  let youMark = '';
  if (you && c.gold <= maxGold) {
    const p = S.probWithGold(you.chain, c.gold, c.cost, you.need, rc);
    const anchor = x(c.gold) > W - 120 ? 'end' : 'start';
    const dx = anchor === 'end' ? -8 : 8;
    youMark = `<line class="you" x1="${x(c.gold)}" x2="${x(c.gold)}" y1="${T}" y2="${y(0)}"/>
      <circle class="dot" cx="${x(c.gold)}" cy="${y(p)}" r="5" fill="${you.color}"/>
      <text class="you-label" x="${x(c.gold) + dx}" y="${Math.max(T + 12, y(p) - 8)}" text-anchor="${anchor}">Tu oro: ${pct(p)}</text>`;
  }
  return `<svg class="chart" id="prob-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Probabilidad acumulada de conseguir el campeón según el oro gastado">
    ${grid}
    <line class="axis" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>
    <text x="${W - R}" y="${H - 10}" text-anchor="end" style="display:none">oro</text>
    ${lines}
    ${youMark}
    <line class="cross" id="cross" x1="0" x2="0" y1="${T}" y2="${y(0)}" visibility="hidden"/>
    <rect id="prob-hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
  </svg>
  <p class="hint">Eje horizontal: oro total gastado (tiradas de ${rc} de oro + compra de las copias).</p>`;
}

function bindProbChart(series, c, maxGold) {
  const svg = $('#prob-chart');
  if (!svg) return;
  const hit = $('#prob-hit', svg);
  const cross = $('#cross', svg);
  const rc = state.config.rerollCost ?? 2;
  const W = 640, L = 44, R = 16;
  const move = (e) => {
    const box = svg.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * W;
    const g = Math.round(Math.min(maxGold, Math.max(0, ((sx - L) / (W - L - R)) * maxGold)));
    const gx = L + (g / maxGold) * (W - L - R);
    cross.setAttribute('x1', gx);
    cross.setAttribute('x2', gx);
    cross.setAttribute('visibility', 'visible');
    const rowsHtml = series.map((s) => `<div class="tt-row"><span class="key" style="background:${s.color}"></span>Nivel ${s.level}${s.tag}<b>${pct(S.probWithGold(s.chain, g, c.cost, s.need, rc))}</b></div>`).join('');
    tooltip.show(`<div class="tt-title">${g} de oro</div>${rowsHtml}`, e.clientX, e.clientY);
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tooltip.hide(); });
}

// ---------------------------------------------------------------------------
// Metodología y estado vacío
// ---------------------------------------------------------------------------

function methodHTML() {
  const cfg = state.config;
  const tiers = cfg.tiers.map((t, i) => `${t.tier}: ${i === cfg.tiers.length - 1 ? `> ${fmt(cfg.tiers[i - 1].maxAvg, 2)}` : `≤ ${fmt(t.maxAvg, 2)}`}`).join(' · ');
  const lp = cfg.lpByPlacement.map((v, i) => `${i + 1}º ${signed(v, 0)}`).join(' · ');
  return `<article class="prose">
    <section class="hero"><h1>Metodología</h1><p>Cómo se calculan los números de esta web y qué limitaciones tienen.</p></section>

    <h2>1. De dónde salen los datos</h2>
    <p>Un GitHub Action se ejecuta cada 6 horas: pide a la <b>API oficial de Riot</b> los mejores jugadores (Challenger, Gran Maestro y Maestro) de varias regiones, descarga sus partidas clasificatorias recientes y guarda el tablero final de cada jugador (unidades, estrellas, objetos, rasgos, nivel y posición). Solo se usan partidas del set actual y del parche más reciente; si la muestra es pequeña (justo tras un parche) se añaden partidas del parche anterior y la cabecera lo indica.</p>

    <h2>2. Cómo se detectan las composiciones</h2>
    <p>No hay una lista hecha a mano: las composiciones salen de los datos.</p>
    <ol>
      <li>En cada tablero se identifica el <b>carry</b> (la unidad con más objetos ofensivos, deducido de los componentes de cada objeto) y el <b>rasgo principal</b>.</li>
      <li>Los tableros con el mismo carry y rasgo forman semillas; las semillas casi idénticas se fusionan.</li>
      <li>Después se hace un <i>k-modes</i>: cada tablero se reasigna al grupo cuyo perfil de unidades se le parece más (Jaccard ponderado), varias veces. Los tableros que no se parecen a nada no se cuentan.</li>
      <li>Se descartan los grupos con muy pocas partidas.</li>
    </ol>

    <h2>3. Posición media ajustada (bayesiana)</h2>
    <p>Una composición con 12 partidas y media 3,2 probablemente ha tenido suerte. Para no premiar muestras pequeñas, la media se "encoge" hacia 4,5 (lo que haría una composición cualquiera) como si tuviera <b>k</b> partidas imaginarias de media 4,5:</p>
    <code class="formula">media ajustada = (suma de posiciones + k · 4,5) / (n + k)</code>
    <p>Con muchas partidas el prior casi no influye; con pocas, domina. El intervalo que se muestra (IC 95 %) es <code>media ± 1,96 · σ / √(n + k)</code>.</p>
    <div class="card" style="margin:12px 0">
      <label class="field"><span>Fuerza del prior (k): <b id="k-val">${fmt(state.k)}</b> partidas</span>
        <input type="range" id="k" min="0" max="100" step="5" value="${state.k}"></label>
      <p class="hint" id="k-example"></p>
    </div>

    <h2>4. Probabilidad de ser mejor que la media</h2>
    <p>Con la distribución a posteriori de la media (aproximación normal) se calcula <code>P(media real &lt; 4,5)</code>. Un 97 % significa que es casi seguro que la composición está por encima de la media; un 60 %, que los datos aún no lo tienen claro.</p>

    <h2>5. Top 4 y victorias</h2>
    <p>Se muestran con el <b>intervalo de Wilson</b> al 95 %, que funciona bien con pocas partidas y porcentajes extremos. Para ordenar se usan versiones encogidas hacia 50 % y 12,5 %.</p>

    <h2>6. LP esperados</h2>
    <p>Distribución de Dirichlet sobre las 8 posiciones con prior uniforme de fuerza k: <code>p<sub>i</sub> = (c<sub>i</sub> + k/8) / (n + k)</code>, multiplicada por una tabla de LP aproximada (${lp}). Es orientativo: los LP reales dependen de tu MMR.</p>

    <h2>7. Tiers</h2>
    <p>Por media ajustada: ${tiers}. Se configuran en <code>data/game-config.json</code>.</p>

    <h2>8. Carry disputado</h2>
    <p>Porcentaje de partidas en las que otro jugador del mismo lobby tenía al carry a 2★ o más, y la media en cada caso. Si la diferencia es grande, la composición depende mucho de jugarla sin competencia.</p>

    <h2>9. Calculadora de roll</h2>
    <p>Cadena de Markov exacta sobre el número de copias encontradas: en cada casilla de la tienda sale el coste del campeón con la probabilidad del nivel y, dentro de ese coste, tu campeón con probabilidad <code>copias restantes / cartas restantes de ese coste</code>. Cada copia comprada sale del pool. El oro total es <code>2 · tiendas + coste · copias</code>. Está validada contra una simulación Monte Carlo.</p>

    <h2>10. Limitaciones</h2>
    <ul>
      <li><b>Sesgo de supervivencia:</b> quien queda 8º tiene un tablero incompleto. Las unidades de nivel 9 y los objetos "de final de partida" parecen mejores de lo que son.</li>
      <li><b>Correlación, no causalidad:</b> los buenos jugadores eligen ciertas composiciones y objetos; eso infla sus números.</li>
      <li><b>Alto elo:</b> el meta de Challenger no es igual al de Oro o Platino.</li>
      <li>Las probabilidades de tienda y el tamaño del pool vienen de <code>data/game-config.json</code>: revísalos si un parche los cambia.</li>
    </ul>
  </article>`;
}

function bindMethod() {
  const input = $('#k');
  const update = () => {
    state.k = Number(input.value);
    store.set('k', state.k);
    $('#k-val').textContent = fmt(state.k);
    const ex = S.posterior([6, 3, 1, 1, 1, 0, 0, 0], state.k); // 12 partidas, media 2,0
    const ex2 = S.posterior([60, 55, 50, 45, 30, 25, 20, 15], state.k);
    $('#k-example').textContent = `Ejemplo: 12 partidas con media real 2,00 → media ajustada ${fmt(ex.mean, 2)}. `
      + `300 partidas con media real ${fmt(S.summarize([60, 55, 50, 45, 30, 25, 20, 15]).mean, 2)} → ${fmt(ex2.mean, 2)}.`;
  };
  input.addEventListener('input', update);
  update();
}

function emptyHTML() {
  const detail = state.loadError ? `<p class="hint">Detalle técnico: ${esc(state.loadError.message)}</p>` : '';
  return `<section class="empty card">
    <h1 style="font-size:24px;margin-bottom:8px">Aún no hay datos del meta</h1>
    <p>Esta web lee <code>data/meta.json</code>, que genera automáticamente un GitHub Action cada 6 horas con partidas reales de la API de Riot. Para activarlo:</p>
    <ol>
      <li>Consigue una clave en <a href="https://developer.riotgames.com" target="_blank" rel="noopener">developer.riotgames.com</a> (para uso continuado, solicita una <i>Personal API Key</i>: la de desarrollo caduca cada 24 h).</li>
      <li>En GitHub: <b>Settings → Secrets and variables → Actions → New repository secret</b>, con nombre <code>RIOT_API_KEY</code>.</li>
      <li>En la pestaña <b>Actions</b>, abre “Actualizar meta TFT” y pulsa <b>Run workflow</b>. En unos 15 minutos tendrás datos.</li>
    </ol>
    <p>Mientras tanto puedes ver cómo funciona con datos inventados o usar la calculadora de probabilidades:</p>
    <p class="actions"><a class="btn" href="?demo#/comps">Ver demo (datos inventados)</a><a class="btn secondary" href="#/calc">Abrir la calculadora</a></p>
    ${detail}
  </section>`;
}

boot();
