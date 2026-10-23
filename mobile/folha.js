// Orbit no celular: folha (bottom sheet) da casca (onda 2). Define OM.folha { abrir, fecharTodas, abertas } e
// OM.confirmar. Sobe de baixo, pontos de parada (meia/inteira/auto), arrastar para fechar com velocidade, fundo que
// fecha ao tocar, foco preso, Esc e o "voltar" do navegador fecham. Só transform/opacity; sem nada inline (CSP).
// API: contrato "App do celular". CSS em /m/folha.css.
(() => {
'use strict';

const OM = (window.OM = window.OM || {});
const doc = document;

const VEL = 0.5;          // px/ms: soltar mais rápido que isso vai à próxima parada (ou fecha)
const LIMIAR = 6;         // px até decidir se é arrasto
const MS_REDUZIDO = 120;  // movimento reduzido: só fade
const MS_SAIDA = 200;     // = --dur-2 (saída da folha)
const pilha = [];         // folhas abertas, a do topo é a última
let ignorarPop = 0;       // history.back() feitos por nós (fechar pela UI)
let seq = 0;

const reduzido = () => (OM.reduzido ? OM.reduzido() : !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches));
const msTrans = () => {
  const v = OM.cssVar ? OM.cssVar('--dur-3', '.3s') : '.3s';
  const n = parseFloat(v);
  return Number.isFinite(n) ? (v.endsWith('ms') ? n : n * 1000) : 300;
};
function el(tag, attrs, ...filhos) {
  if (OM.h) return OM.h(tag, attrs, ...filhos);
  const e = doc.createElement(tag);
  for (const k in attrs || {}) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'text') e.textContent = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] != null && attrs[k] !== false) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
  }
  for (const f of filhos) if (f != null) e.append(f);
  return e;
}
const icone = (nome, tam) => (OM.icone ? OM.icone(nome, tam) : el('span', { 'aria-hidden': 'true', text: '×' }));
const FOCAVEIS = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
const visivel = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);

function atualizarInert() {
  const app = doc.getElementById('app');
  if (app) app.inert = pilha.length > 0;
  pilha.forEach((f, i) => { const ativo = i === pilha.length - 1; f.el.inert = !ativo; f.fundo.inert = !ativo; });
}

// ───────────────────────────── abrir ─────────────────────────────
// abrir({ titulo, conteudo: Node | fn(corpo, f) | texto, paradas: ['meia','inteira'] | ['auto'] | ['inteira'],
//         aoFechar(motivo), rotulo }) → { fechar(motivo?) → Promise, el, corpo, irPara(parada), parada() }
// motivos: 'botao' 'fundo' 'arrasto' 'esc' 'voltar' 'rota' 'todas' 'codigo'.
function abrir(op = {}) {
  const id = 'f' + (++seq);
  let paradas = (Array.isArray(op.paradas) && op.paradas.length ? op.paradas : ['auto'])
    .filter((p) => p === 'meia' || p === 'inteira' || p === 'auto');
  if (!paradas.length) paradas = ['auto'];
  const titId = 'folha-tit-' + id;
  const titulo = op.titulo ? el('h2', { class: 'folha-tit', id: titId, text: op.titulo }) : null;
  const btFechar = el('button', { class: 'btn-icone folha-x', type: 'button', 'aria-label': 'Fechar' }, icone('x', 20));
  const alca = el('div', { class: 'folha-alca', 'aria-hidden': 'true' });
  const cab = el('header', { class: 'folha-cab' }, titulo || el('span', { class: 'folha-tit' }), btFechar);
  const corpo = el('div', { class: 'folha-corpo' });
  const sec = el('section', {
    class: 'folha' + (paradas.includes('inteira') ? ' alta' : ''), role: 'dialog', 'aria-modal': 'true', tabindex: '-1',
    'aria-labelledby': titulo ? titId : null, 'aria-label': titulo ? null : (op.rotulo || 'Painel'),
  }, alca, cab, corpo);
  const fundo = el('div', { class: 'folha-fundo', 'aria-hidden': 'true' });

  const f = {
    id, el: sec, fundo, corpo, paradas, atual: paradas[0], y: 0, H: 0, fechando: null, aoFechar: op.aoFechar,
    focoAntes: doc.activeElement, temHist: false,
  };
  const api = { el: sec, corpo, fechar: (m) => fechar(f, m || 'codigo'), irPara: (p) => irPara(f, p), parada: () => f.atual };
  f.api = api;

  const c = op.conteudo;
  if (typeof c === 'function') { try { c(corpo, api); } catch (e) { console.error(e); } }
  else if (c instanceof Node) corpo.append(c);
  else if (c != null) corpo.append(el('p', { class: 'folha-texto', text: String(c) }));

  sec.classList.add('sem-trans');
  doc.body.append(fundo, sec);
  pilha.push(f);
  atualizarInert();
  medir(f);
  const red = reduzido();
  const destino = alvo(f, f.atual);
  if (red) { pos(f, destino); sec.style.opacity = '0'; } else pos(f, f.H);
  void sec.offsetHeight; // fixa o ponto de partida antes de ligar a transição
  sec.classList.remove('sem-trans');
  requestAnimationFrame(() => {
    if (f.fechando) return;
    fundo.classList.add('visivel');
    if (red) sec.style.opacity = '1'; else pos(f, destino);
  });
  try { sec.focus({ preventScroll: true }); } catch {}

  try { history.pushState(Object.assign({}, history.state, { omFolha: id }), '', location.href); f.temHist = true; } catch {}

  fundo.addEventListener('click', () => fechar(f, 'fundo'));
  btFechar.addEventListener('click', () => fechar(f, 'botao'));
  ligarArrasto(f, alca, cab, corpo);
  return api;
}

function medir(f) {
  f.H = f.el.offsetHeight || Math.round(innerHeight * 0.9);
}
function altura(f, p) {
  if (p === 'meia') return Math.min(f.H, Math.round((window.visualViewport ? visualViewport.height : innerHeight) * 0.5));
  return f.H; // inteira/auto: a folha inteira
}
const alvo = (f, p) => Math.max(0, f.H - altura(f, p));
function pos(f, y) { f.y = y; f.el.style.transform = 'translateY(' + Math.round(y) + 'px)'; }
function irPara(f, p) {
  if (f.fechando || !f.paradas.includes(p)) return;
  f.atual = p;
  pos(f, alvo(f, p));
  marcarExpandir(f);
}
function marcarExpandir(f) {
  // fora da parada mais alta, arrastar o corpo para cima expande a folha (em vez de rolar)
  const maisAlta = Math.min(...f.paradas.map((p) => alvo(f, p)));
  f.corpo.classList.toggle('expandir', alvo(f, f.atual) > maisAlta + 1);
}

// ───────────────────────────── fechar ─────────────────────────────
function fechar(f, motivo, semHist) {
  if (f.fechando) return f.fechando;
  const i = pilha.indexOf(f);
  if (i >= 0) pilha.splice(i, 1);
  const red = reduzido();
  f.fechando = new Promise((ok) => {
    f.fundo.classList.remove('visivel');
    if (red) f.el.style.opacity = '0';
    else {
      // sair da tela usa a curva de saída (a de entrada fica para abrir)
      f.el.style.transition = 'transform var(--dur-2) var(--ease-saida), opacity var(--dur-1) var(--ease)';
      pos(f, f.H + 8);
    }
    setTimeout(() => { f.el.remove(); f.fundo.remove(); ok(); }, red ? MS_REDUZIDO : MS_SAIDA);
  });
  atualizarInert();
  if (!semHist && f.temHist && history.state && history.state.omFolha === f.id) {
    ignorarPop++;
    try { history.back(); } catch { ignorarPop--; }
  }
  if (!pilha.length) {
    const a = f.focoAntes;
    if (a && a.isConnected && typeof a.focus === 'function') { try { a.focus({ preventScroll: true }); } catch {} }
  } else {
    try { pilha[pilha.length - 1].el.focus({ preventScroll: true }); } catch {}
  }
  if (typeof f.aoFechar === 'function') { try { f.aoFechar(motivo); } catch (e) { console.error(e); } }
  return f.fechando;
}
function fecharTodas(motivo = 'todas') {
  return Promise.all(pilha.slice().reverse().map((f) => fechar(f, motivo, motivo === 'rota' || motivo === 'voltar')));
}

// ───────────────────────────── arrasto ─────────────────────────────
function ligarArrasto(f, alca, cab, corpo) {
  let g = null; // gesto em curso
  const noTopo = () => corpo.scrollTop <= 0;
  const marcarTopo = () => corpo.classList.toggle('no-topo', noTopo());
  corpo.addEventListener('scroll', marcarTopo, { passive: true });
  marcarTopo();
  marcarExpandir(f);

  function inicio(e, origem) {
    if (f.fechando || g || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (origem === 'cab' && e.target.closest('button, a, input, select, textarea')) return;
    g = { id: e.pointerId, origem, x0: e.clientX, y0: e.clientY, yIni: f.y, modo: 'talvez', amostras: [[e.timeStamp || performance.now(), e.clientY]] };
    addEventListener('pointermove', mover, true);
    addEventListener('pointerup', soltar, true);
    addEventListener('pointercancel', cancelar, true);
  }
  function mover(e) {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (g.modo === 'talvez') {
      if (Math.abs(dy) < LIMIAR && Math.abs(dx) < LIMIAR) return;
      const vertical = Math.abs(dy) > Math.abs(dx);
      const podeCorpo = g.origem !== 'corpo' || (dy > 0 && noTopo()) || (dy < 0 && corpo.classList.contains('expandir'));
      if (!vertical || !podeCorpo) { parar(); return; }
      g.modo = 'arrasto';
      f.el.classList.add('arrastando');
      try { e.target.setPointerCapture(e.pointerId); } catch {}
    }
    const min = Math.min(...f.paradas.map((p) => alvo(f, p)));
    let y = g.yIni + dy;
    if (y < min) y = min - (min - y) * 0.25; // resistência acima da parada mais alta
    pos(f, y);
    g.amostras.push([e.timeStamp || performance.now(), e.clientY]);
    if (g.amostras.length > 6) g.amostras.shift();
    if (e.cancelable) e.preventDefault();
  }
  function velocidade() {
    const a = g.amostras;
    if (a.length < 2) return 0;
    const [t1, y1] = a[a.length - 1];
    let k = a.length - 2;
    while (k > 0 && t1 - a[k][0] < 60) k--;
    const dt = t1 - a[k][0];
    return dt > 0 ? (y1 - a[k][1]) / dt : 0;
  }
  function soltar(e) {
    if (!g || e.pointerId !== g.id) return;
    if (g.modo !== 'arrasto') { parar(); return; }
    g.amostras.push([e.timeStamp || performance.now(), e.clientY]);
    const v = velocidade();
    parar(true);
    const pontos = f.paradas.map((p) => ({ p, y: alvo(f, p) })).concat({ p: null, y: f.H }).sort((a, b) => a.y - b.y);
    let escolha;
    if (v > VEL) escolha = pontos.find((q) => q.y > f.y + 1) || pontos[pontos.length - 1];
    else if (v < -VEL) escolha = pontos.slice().reverse().find((q) => q.y < f.y - 1) || pontos[0];
    else escolha = pontos.reduce((m, q) => (Math.abs(q.y - f.y) < Math.abs(m.y - f.y) ? q : m));
    if (escolha.p == null) fechar(f, 'arrasto');
    else irPara(f, escolha.p);
  }
  function cancelar(e) {
    if (!g || e.pointerId !== g.id) return;
    const era = g.modo === 'arrasto';
    parar(era);
    if (era) irPara(f, f.atual);
  }
  function parar(arrastou) {
    removeEventListener('pointermove', mover, true);
    removeEventListener('pointerup', soltar, true);
    removeEventListener('pointercancel', cancelar, true);
    f.el.classList.remove('arrastando');
    if (arrastou) suprimirClique();
    g = null;
  }
  alca.addEventListener('pointerdown', (e) => inicio(e, 'alca'));
  cab.addEventListener('pointerdown', (e) => inicio(e, 'cab'));
  corpo.addEventListener('pointerdown', (e) => inicio(e, 'corpo'));
  // iOS ignora pan-down: segura a rolagem nativa enquanto a folha está sendo arrastada
  corpo.addEventListener('touchmove', (e) => { if (g && g.modo === 'arrasto' && e.cancelable) e.preventDefault(); }, { passive: false });
}

function suprimirClique() {
  const fn = (e) => { e.preventDefault(); e.stopPropagation(); };
  addEventListener('click', fn, { capture: true, once: true });
  setTimeout(() => removeEventListener('click', fn, true), 100);
}

// ───────────────────────────── teclado, voltar, rota ─────────────────────────────
doc.addEventListener('keydown', (e) => {
  const f = pilha[pilha.length - 1];
  if (!f) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fechar(f, 'esc'); return; }
  if (e.key !== 'Tab') return;
  const lista = [...f.el.querySelectorAll(FOCAVEIS)].filter(visivel);
  if (!lista.length) { e.preventDefault(); f.el.focus(); return; }
  const prim = lista[0], ult = lista[lista.length - 1], at = doc.activeElement;
  if (!f.el.contains(at)) { e.preventDefault(); (e.shiftKey ? ult : prim).focus(); }
  else if (e.shiftKey && (at === prim || at === f.el)) { e.preventDefault(); ult.focus(); }
  else if (!e.shiftKey && at === ult) { e.preventDefault(); prim.focus(); }
}, true);
doc.addEventListener('focusin', (e) => {
  const f = pilha[pilha.length - 1];
  if (f && !f.el.contains(e.target)) { try { f.el.focus({ preventScroll: true }); } catch {} }
});

// folha.js carrega antes de rotas.js: este popstate roda primeiro e esconde da rota o "voltar" que só fechou a folha
addEventListener('popstate', (e) => {
  if (ignorarPop > 0) { ignorarPop--; e.stopImmediatePropagation(); return; }
  const f = pilha[pilha.length - 1];
  if (!f) return;
  e.stopImmediatePropagation();
  fechar(f, 'voltar', true);
});
addEventListener('hashchange', () => { if (pilha.length) fecharTodas('rota'); });
addEventListener('resize', () => {
  for (const f of pilha) {
    f.el.classList.add('sem-trans');
    medir(f);
    pos(f, alvo(f, f.atual));
    marcarExpandir(f);
    void f.el.offsetHeight;
    f.el.classList.remove('sem-trans');
  }
});

// ───────────────────────────── confirmar ─────────────────────────────
// confirmar(texto | { titulo, texto, sim, nao, perigo }) → Promise<boolean>
function confirmar(pedido) {
  const o = typeof pedido === 'object' && pedido ? pedido : { texto: pedido };
  return new Promise((resolver) => {
    let feito = false;
    const fim = (v) => { if (!feito) { feito = true; resolver(v); } };
    const folha = abrir({
      titulo: o.titulo || 'Confirmar',
      paradas: ['auto'],
      aoFechar: () => fim(false),
      conteudo: (corpo, ff) => {
        if (o.texto) corpo.append(el('p', { class: 'folha-texto', text: String(o.texto) }));
        const nao = el('button', { class: 'btn toque', type: 'button', text: o.nao || 'Cancelar' });
        const sim = el('button', { class: 'btn toque ' + (o.perigo ? 'perigo' : 'solido'), type: 'button', text: o.sim || 'Confirmar' });
        nao.addEventListener('click', () => { fim(false); ff.fechar('botao'); });
        sim.addEventListener('click', () => { fim(true); ff.fechar('botao'); });
        corpo.append(el('div', { class: 'folha-acoes' }, nao, sim));
      },
    });
    void folha;
  });
}

OM.folha = { abrir, fecharTodas, abertas: () => pilha.length };
OM.confirmar = confirmar;
})();
