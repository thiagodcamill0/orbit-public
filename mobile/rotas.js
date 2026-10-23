// Orbit no celular: rotas da casca (onda 2). Hash → pilha de telas, transições de empurrar/voltar (WAAPI, só transform e
// opacity), barra de baixo (Início · Sessões · Aprovações com badge · Mais), títulos grandes, registro das telas e os
// ganchos do voltar pela borda (gestos.js). Sem innerHTML e sem nada inline (CSP). API: contrato "App do celular".
(() => {
'use strict';
const OM = (window.OM = window.OM || {});
const doc = document;
const $ = (id) => doc.getElementById(id);
const h = (...a) => OM.h(...a);

const RAIZES = ['inicio', 'sessoes', 'aprovacoes', 'mais'];
const NOMES = { inicio: 'Início', sessoes: 'Sessões', aprovacoes: 'Aprovações', mais: 'Mais', conversa: 'Conversa', parear: 'Parear' };
const RESERVADOS = new Set([...RAIZES, 'conversa', 'parear']);
const RE_NOME = /^[a-z][a-z0-9-]{0,39}$/;
const DUR = { empurrar: 300, voltar: 250, trocar: 150, reduzido: 120 };

const defs = new Map();   // nome → { montar, mostrar?, esconder?, atualizar?, desmontar?, titulo?, tituloGrande?, semBarra? }
const vivas = new Map();  // chave → instância
let cadeia = [];          // instâncias da raiz ao topo
let abaAtual = '';
let trans = null;         // transição em curso: { anims, fim }
let arrasto = null;       // voltar pela borda em curso
let semAnimProx = false;

const reduzido = () => (OM.reduzido ? OM.reduzido() : false);
const topo = () => cadeia[cadeia.length - 1] || null;

// ───────────────────────────── hash → cadeia ─────────────────────────────
function decod(s) { try { return decodeURIComponent(s); } catch { return null; } }
const raiz = (n) => ({ nome: n, params: {}, hash: '#' + n });
function ler(hash) {
  if (OM.estado && OM.estado.modo === 'parear') return [{ nome: 'parear', params: {}, hash: '' }];
  const hs = String(hash || '').replace(/^#/, '');
  if (!hs) return [raiz('inicio')];
  if (RAIZES.includes(hs)) return [raiz(hs)];
  let m = /^s=([^/]+)(?:\/([a-z][a-z0-9-]{0,39}))?$/.exec(hs);
  if (m) {
    const id = decod(m[1]);
    if (!id || id.length > 200) return null;
    const base = raiz(abaAtual || 'sessoes');
    const conv = { nome: 'conversa', params: { id }, hash: '#s=' + m[1] };
    if (!m[2]) return [base, conv];
    return [base, conv, { nome: m[2], params: { id, sub: m[2] }, hash: conv.hash + '/' + m[2] }];
  }
  m = /^mais\/([a-z][a-z0-9-]{0,39})$/.exec(hs);
  if (m && !RESERVADOS.has(m[1])) return [raiz('mais'), { nome: m[1], params: { sub: m[1] }, hash: '#mais/' + m[1] }];
  if (RE_NOME.test(hs) && !RESERVADOS.has(hs) && defs.has(hs)) return [raiz(abaAtual || 'inicio'), { nome: hs, params: {}, hash: '#' + hs }];
  return null;
}
const chaveDe = (it) => (Object.keys(it.params).length ? it.nome + '|' + JSON.stringify(it.params) : it.nome);
const hashDe = (url) => { try { return new URL(url).hash; } catch { return ''; } };

// ───────────────────────────── instâncias ─────────────────────────────
function chama(t, fase, ...args) {
  const fn = t.def && t.def[fase];
  if (typeof fn !== 'function') return;
  try { fn.apply(t.def, args); } catch (e) { console.error('OM.telas.' + t.nome + '.' + fase, e); }
}
function valor(v, t) { return typeof v === 'function' ? v(t.item.params) : v; }
function tituloDe(t) {
  const v = t.def ? valor(t.def.titulo, t) : null;
  return v != null && v !== '' ? String(v) : NOMES[t.nome] || t.nome.charAt(0).toUpperCase() + t.nome.slice(1).replace(/-/g, ' ');
}
function definirTitulo(t, s) {
  const v = s == null ? '' : String(s);
  OM.txt(t.cabTit, v);
  if (t.titG) { OM.txt(t.titG, v); t.limTit = -1; }
  t.el.setAttribute('aria-label', v);
}

function criar(item, nivel) {
  const def = defs.get(item.nome) || null;
  const grande = RAIZES.includes(item.nome) || !!(def && valor(def.tituloGrande, { item }));
  const el = h('section', { class: 'tela', tabindex: '-1', dados: { tela: item.nome }, hidden: true });
  const voltarBtn = nivel > 0
    ? h('button', { class: 'btn-icone cab-voltar', type: 'button', 'aria-label': 'Voltar', onclick: () => voltar() }, OM.icone('chevron-esq', 20))
    : null;
  const cabTit = h('div', { class: 'cab-tit', 'aria-hidden': 'true' });
  const acoes = h('div', { class: 'cab-dir' });
  const cab = h('header', { class: grande ? 'tela-cab' : 'tela-cab sempre' }, h('div', { class: 'cab-esq' }, voltarBtn), cabTit, acoes);
  const titG = grande ? h('h1', { class: 'tit-grande' }) : null;
  const cont = h('div', { class: 'tela-cont' });
  const corpo = h('div', { class: 'tela-corpo' }, titG, cont);
  if (!grande) cabTit.removeAttribute('aria-hidden');
  if (!grande) cabTit.setAttribute('role', 'heading');
  if (!grande) cabTit.setAttribute('aria-level', '1');
  el.append(corpo, cab);
  const t = { item, nome: item.nome, chave: chaveDe(item), def: null, el, cab, cabTit, acoes, corpo, cont, titG, nivel, scroll: 0, montada: false, veioDe: '', enc: -1, limTit: -1 };
  t.ctx = {
    nome: item.nome, tela: el, corpo, cab, acoes, cont,
    get params() { return t.item.params; },
    titulo: (s) => definirTitulo(t, s),
    voltar: () => voltar(),
    ir: (hash, op) => ir(hash, op),
  };
  let quadro = 0;
  corpo.addEventListener('scroll', () => { if (!quadro) quadro = requestAnimationFrame(() => { quadro = 0; rolou(t); }); }, { passive: true });
  return t;
}

// Título grande: some ao rolar e o pequeno aparece no cabeçalho (classe .rolada); --enc (0..1) encolhe o grande.
function rolou(t) {
  const y = Math.max(0, t.corpo.scrollTop);
  if (t.titG) {
    const enc = Math.min(1, y / 56);
    if (Math.abs(enc - t.enc) > 0.01) { t.enc = enc; t.titG.style.setProperty('--enc', enc.toFixed(3)); }
    // o limite só muda com título/largura (definirTitulo e resize o invalidam): lê o layout uma vez, não a cada quadro
    if (t.limTit < 0) {
      const lim = t.titG.offsetTop + t.titG.offsetHeight - t.cab.offsetHeight;
      if (t.titG.offsetHeight) t.limTit = lim; else { t.el.classList.toggle('rolada', y > lim); return; }
    }
    t.el.classList.toggle('rolada', y > t.limTit);
  } else t.el.classList.toggle('rolada', y > 2);
}

window.addEventListener('resize', () => { for (const t of vivas.values()) t.limTit = -1; }, { passive: true });

function placeholder() {
  return h('div', { class: 'tela-vazia' },
    h('span', { class: 'esq esq-l1', 'aria-hidden': 'true' }),
    h('span', { class: 'esq esq-l2', 'aria-hidden': 'true' }),
    h('span', { class: 'esq esq-l3', 'aria-hidden': 'true' }),
    h('p', { class: 'tela-vazia-txt' }, 'Em construção'));
}

function montar(t) {
  t.def = defs.get(t.nome) || null;
  t.montada = true;
  t.cont.replaceChildren();
  t.acoes.replaceChildren();
  definirTitulo(t, tituloDe(t));
  if (!t.def) { t.cont.append(placeholder()); return; }
  try { t.def.montar(t.cont, t.item.params, t.ctx); } catch (e) {
    console.error('OM.telas.' + t.nome + '.montar', e);
    t.cont.append(h('p', { class: 'tela-erro' }, 'Não deu para abrir esta tela.'));
  }
}

function destruir(t) {
  if (t.montada) chama(t, 'desmontar', t.ctx);
  t.el.remove();
  vivas.delete(t.chave);
}
function limparTudo() {
  terminar();
  arrasto = null;
  for (const t of [...vivas.values()]) destruir(t);
  cadeia = [];
}

// Depois da transição: só o topo à mostra; empurradas fora da cadeia saem (raízes ficam, com o scroll salvo).
function arrumar() {
  const tp = topo();
  for (const t of [...vivas.values()]) {
    if (cadeia.includes(t)) { t.el.hidden = t !== tp; continue; }
    if (RAIZES.includes(t.nome)) t.el.hidden = true; else destruir(t);
  }
}

// ───────────────────────────── transições ─────────────────────────────
function terminar() {
  if (!trans) return;
  const tr = trans;
  trans = null;
  for (const a of tr.anims) { try { a.finish(); } catch {} }
  tr.fim();
}
function animar(pares, dur, fim) {
  terminar();
  const ease = (OM.cssVar && OM.cssVar('--ease-press')) || 'cubic-bezier(.23, 1, .32, 1)';
  const anims = [];
  for (const [el, kf] of pares) {
    if (!el || typeof el.animate !== 'function') continue;
    try { anims.push(el.animate(kf, { duration: dur, easing: ease, fill: 'forwards' })); } catch {}
  }
  const tr = { anims, fim: () => { fim(); for (const a of anims) { try { a.cancel(); } catch {} } } };
  if (!anims.length) { tr.fim(); return; }
  trans = tr;
  let faltam = anims.length;
  const um = () => { if (trans === tr && --faltam <= 0) terminar(); };
  for (const a of anims) a.finished.then(um, um);
}
const X = (p) => ({ transform: `translate3d(${p}%, 0, 0)` });

function transicao(tipo, de, para) {
  if (tipo === 'nada' || !de || !para) { arrumar(); return; }
  if (reduzido()) {
    if (tipo === 'voltar') animar([[de.el, [{ opacity: 1 }, { opacity: 0 }]]], DUR.reduzido, arrumar);
    else animar([[para.el, [{ opacity: 0 }, { opacity: 1 }]]], DUR.reduzido, arrumar);
    return;
  }
  if (tipo === 'empurrar') {
    animar([
      [para.el, [X(100), X(0)]],
      [de.el, [{ ...X(0), opacity: 1 }, { ...X(-28), opacity: 0.6 }]],
    ], DUR.empurrar, arrumar);
  } else if (tipo === 'voltar') {
    animar([
      [de.el, [X(0), X(100)]],
      [para.el, [{ ...X(-28), opacity: 0.6 }, { ...X(0), opacity: 1 }]],
    ], DUR.voltar, arrumar);
  } else {
    de.el.hidden = true;
    animar([[para.el, [{ opacity: 0 }, { opacity: 1 }]]], DUR.trocar, arrumar);
  }
}

// ───────────────────────────── aplicar ─────────────────────────────
function aplicar(op = {}) {
  if (!OM.estado || OM.estado.modo === 'carregando') return;
  const pilha = $('pilha');
  if (!pilha) return;
  const itens = ler(location.hash);
  if (!itens) { history.replaceState(null, '', '#inicio'); aplicar(); return; }
  terminar();
  if (arrasto) cancelarArrasto();
  const velha = cadeia;
  const nova = itens.map((it, i) => {
    const k = chaveDe(it);
    let t = vivas.get(k);
    if (!t) { t = criar(it, i); vivas.set(k, t); } else t.item = it;
    return t;
  });
  const de = velha[velha.length - 1] || null;
  const para = nova[nova.length - 1];
  let tipo = 'nada';
  if (de && de !== para && de.el.isConnected && !de.el.hidden) {
    const iv = velha.indexOf(para);
    const iN = nova.indexOf(de);
    if (iv >= 0 && iv < velha.length - 1 && iN < 0) tipo = 'voltar';
    else if (iN >= 0 && iN < nova.length - 1) tipo = 'empurrar';
    else tipo = 'trocar';
  }
  if (semAnimProx) { semAnimProx = false; tipo = 'nada'; }
  if (de && de !== para) {
    if (op.de != null && tipo === 'empurrar') para.veioDe = op.de;
    else if (op.herda && para.nivel === de.nivel && !para.montada) para.veioDe = de.veioDe;
  }
  const focoDentro = !!(de && de.el.contains(doc.activeElement));
  if (de && de !== para && vivas.get(de.chave) === de) { de.scroll = de.corpo.scrollTop; chama(de, 'esconder', de.ctx); }

  cadeia = nova;
  if (RAIZES.includes(nova[0].nome)) abaAtual = nova[0].nome;
  nova.forEach((t, i) => {
    t.nivel = i;
    t.el.style.zIndex = String(i + 1);
    if (!t.el.isConnected) pilha.append(t.el);
  });
  if (para !== de) {
    para.el.hidden = false;
    if (!para.montada) montar(para); else para.corpo.scrollTop = para.scroll;
    rolou(para);
    chama(para, 'mostrar', para.ctx);
    chama(para, 'atualizar', OM.estado, para.ctx);
    if (focoDentro) { try { para.el.focus({ preventScroll: true }); } catch {} }
  } else if (!para.montada) { para.el.hidden = false; montar(para); chama(para, 'mostrar', para.ctx); chama(para, 'atualizar', OM.estado, para.ctx); }
  transicao(tipo, de, para);
  pintarBarra();
  OM.emitir && OM.emitir('rota', atual());
}

// ───────────────────────────── navegação ─────────────────────────────
function ir(hash, op = {}) {
  let hs = String(hash || '#inicio');
  if (hs[0] !== '#') hs = '#' + hs;
  if (op.substituir) { history.replaceState(null, '', hs); aplicar({ herda: true }); return; }
  if (location.hash === hs) { aplicar(); return; }
  location.hash = hs;
}
// Volta um nível: se o hash anterior do histórico é o pai, history.back(); senão troca o hash no lugar.
function voltar() {
  if (cadeia.length < 2) return false;
  const t = topo(), pai = cadeia[cadeia.length - 2];
  if (t.veioDe && t.veioDe === pai.item.hash) history.back();
  else { history.replaceState(null, '', pai.item.hash); aplicar(); }
  return true;
}
function atual() {
  const t = topo();
  return t ? { nome: t.nome, params: { ...t.item.params }, hash: t.item.hash, nivel: t.nivel, cadeia: cadeia.map((c) => c.nome), aba: abaAtual } : null;
}

// ───────────────────────────── voltar pela borda (gestos.js) ─────────────────────────────
function cancelarArrasto() {
  const a = arrasto;
  arrasto = null;
  if (!a) return;
  for (const el of [a.topo.el, a.baixo.el]) { el.style.transform = ''; el.style.opacity = ''; el.classList.remove('arrastando'); }
  if (topo() !== a.baixo) a.baixo.el.hidden = true;
}
const borda = {
  inicio() {
    if (cadeia.length < 2 || trans || arrasto) return false;
    const app = $('app');
    if (app && (app.inert || app.hasAttribute('inert'))) return false;
    const t = topo(), b = cadeia[cadeia.length - 2];
    b.el.hidden = false;
    b.corpo.scrollTop = b.scroll;
    t.el.classList.add('arrastando');
    b.el.classList.add('arrastando');
    arrasto = { topo: t, baixo: b, p: 0 };
    borda.mover(0);
    return true;
  },
  mover(p) {
    const a = arrasto;
    if (!a) return;
    a.p = Math.max(0, Math.min(1, Number(p) || 0));
    if (reduzido()) { a.topo.el.style.opacity = String(1 - a.p * 0.7); return; }
    a.topo.el.style.transform = `translate3d(${(a.p * 100).toFixed(2)}%, 0, 0)`;
    a.baixo.el.style.transform = `translate3d(${(-28 * (1 - a.p)).toFixed(2)}%, 0, 0)`;
    a.baixo.el.style.opacity = String(0.6 + 0.4 * a.p);
  },
  fim(confirmar) {
    const a = arrasto;
    if (!a) return;
    const p = a.p;
    const red = reduzido();
    const ini = (el) => ({ transform: el.style.transform || 'none', opacity: el.style.opacity || '1' });
    const pares = red
      ? [[a.topo.el, [{ opacity: a.topo.el.style.opacity || '1' }, { opacity: confirmar ? 0 : 1 }]]]
      : [
          [a.topo.el, [ini(a.topo.el), { ...X(confirmar ? 100 : 0), opacity: 1 }]],
          [a.baixo.el, [ini(a.baixo.el), confirmar ? { ...X(0), opacity: 1 } : { ...X(-28), opacity: 0.6 }]],
        ];
    const dur = red ? DUR.reduzido : Math.round(Math.max(120, (confirmar ? 1 - p : p) * DUR.voltar));
    for (const el of [a.topo.el, a.baixo.el]) { el.style.transform = ''; el.style.opacity = ''; }
    animar(pares, dur, () => {
      if (arrasto !== a) return;
      arrasto = null;
      a.topo.el.classList.remove('arrastando');
      a.baixo.el.classList.remove('arrastando');
      if (confirmar) { a.topo.el.hidden = true; semAnimProx = true; voltar(); } else a.baixo.el.hidden = true;
    });
  },
};

// ───────────────────────────── barra ─────────────────────────────
function pintarBarra() {
  const barra = $('barra');
  if (!barra) return;
  const t = topo();
  const aba = OM.estado && OM.estado.modo === 'app' && cadeia[0] ? cadeia[0].nome : '';
  for (const a of barra.querySelectorAll('.barra-aba')) {
    if (a.dataset.aba === aba) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  doc.body.classList.toggle('sem-barra', !!(t && t.def && valor(t.def.semBarra, t)));
}
function pintarBadge(n) {
  const barra = $('barra');
  const a = barra && barra.querySelector('.barra-aba[data-aba="aprovacoes"]');
  if (!a) return;
  const b = a.querySelector('.barra-badge');
  const v = Math.max(0, Number(n) || 0);
  if (b) { b.hidden = !v; OM.txt(b, v > 99 ? '99+' : String(v)); }
  a.setAttribute('aria-label', v ? `Aprovações, ${v} pendente${v > 1 ? 's' : ''}` : 'Aprovações');
}
function ligarBarra() {
  const barra = $('barra');
  if (!barra) return;
  for (const a of barra.querySelectorAll('.barra-aba')) {
    const ico = a.querySelector('.barra-ico');
    if (ico && !ico.firstChild && ico.dataset.ico) ico.append(OM.icone(ico.dataset.ico, 22));
    a.addEventListener('click', (ev) => {
      if (ev.defaultPrevented || ev.button || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      const aba = a.dataset.aba;
      if (cadeia[0] && cadeia[0].nome === aba && cadeia.length === 1) {
        cadeia[0].corpo.scrollTo({ top: 0, behavior: reduzido() ? 'auto' : 'smooth' });
      } else ir('#' + aba);
    });
  }
  pintarBadge(OM.estado ? OM.estado.pendentes : 0);
}

// ───────────────────────────── registro ─────────────────────────────
function registrar(nome, def) {
  if (!RE_NOME.test(String(nome)) || !def || typeof def.montar !== 'function') throw new Error('OM.telas.registrar(nome, { montar }): nome ou montar inválido');
  defs.set(nome, def);
  const tp = topo();
  for (const t of vivas.values()) {
    if (t.nome !== nome || !t.montada) continue;
    if (t.def) chama(t, 'desmontar', t.ctx);
    montar(t);
    if (t === tp) { chama(t, 'mostrar', t.ctx); chama(t, 'atualizar', OM.estado, t.ctx); }
  }
  pintarBarra();
}

function ligar() {
  ligarBarra();
  addEventListener('hashchange', (ev) => aplicar({ de: hashDe(ev.oldURL) }));
  if (OM.ouvir) {
    OM.ouvir('modo', (m) => { limparTudo(); if (m !== 'carregando') aplicar(); else pintarBarra(); });
    OM.ouvir('pendentes', pintarBadge);
    OM.ouvir('estado', (e) => { const t = topo(); if (t && t.montada) chama(t, 'atualizar', e, t.ctx); });
  }
  aplicar();
}

OM.telas = { registrar, registradas: () => [...defs.keys()] };
OM.rotas = { ir, voltar, aplicar: () => aplicar(), atual, podeVoltar: () => cadeia.length > 1, borda };

if ($('pilha')) ligar(); else doc.addEventListener('DOMContentLoaded', ligar, { once: true });
})();
