// Orbit no celular: gestos da casca (onda 2). Define OM.gestos { voltarBorda, puxar, deslizar, ZONA_BORDA }.
// Pointer events com touch-action certo (a rolagem vertical nunca trava), setPointerCapture sempre em try/catch,
// clique suprimido depois de arrasto. A borda esquerda (≤ 24 px) é do "voltar"; deslizar-item ignora início nela.
// Só transform/opacity; movimento reduzido sem deslocamento animado. API: contrato "App do celular".
(() => {
'use strict';

const OM = (window.OM = window.OM || {});
const doc = document;
const ZONA_BORDA = 24;
const LIMIAR = 8;

const reduzido = () => (OM.reduzido ? OM.reduzido() : !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches));
const toqueOuCaneta = (e) => e.pointerType === 'touch' || e.pointerType === 'pen';
const agora = (e) => (e && e.timeStamp) || performance.now();
function el(tag, cls) { const e = doc.createElement(tag); if (cls) e.className = cls; return e; }

function suprimirClique() {
  const fn = (e) => { e.preventDefault(); e.stopPropagation(); };
  addEventListener('click', fn, { capture: true, once: true });
  setTimeout(() => removeEventListener('click', fn, true), 100);
}
// velocidade (px/ms) pelas amostras [t, v] dos últimos ~60 ms
function velocidade(a) {
  if (a.length < 2) return 0;
  const [t1, v1] = a[a.length - 1];
  let k = a.length - 2;
  while (k > 0 && t1 - a[k][0] < 60) k--;
  const dt = t1 - a[k][0];
  return dt > 0 ? (v1 - a[k][1]) / dt : 0;
}
// liga move/up/cancel na janela (captura) durante um gesto; devolve o desligar
function seguir(mover, soltar, cancelar) {
  addEventListener('pointermove', mover, true);
  addEventListener('pointerup', soltar, true);
  addEventListener('pointercancel', cancelar, true);
  return () => {
    removeEventListener('pointermove', mover, true);
    removeEventListener('pointerup', soltar, true);
    removeEventListener('pointercancel', cancelar, true);
  };
}

// ───────────────────────────── voltar pela borda ─────────────────────────────
// voltarBorda(ganchos?) → off. Sem argumento usa OM.rotas.borda = { inicio() → false cancela, mover(p 0..1),
// fim(confirmado) } lido na hora; sem borda, confirma chamando OM.rotas.voltar() se OM.rotas.podeVoltar().
// Confirma com p > .35 ou velocidade > .4 px/ms para a direita. Já vem ligado; chamar de novo troca os ganchos.
let offBorda = null;
function voltarBorda(ganchos) {
  if (offBorda) offBorda();
  const pegar = () => ganchos || (OM.rotas && OM.rotas.borda) || null;
  let g = null;
  function baixo(e) {
    if (g || !toqueOuCaneta(e) || e.clientX > ZONA_BORDA) return;
    if (OM.folha && OM.folha.abertas && OM.folha.abertas() > 0) return;
    if (e.target.closest && e.target.closest('.folha, [data-sem-borda]')) return;
    g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, ativo: false, h: null, amostras: [[agora(e), e.clientX]], off: seguir(mover, soltar, cancelar) };
  }
  function mover(e) {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.ativo) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) return parar(false);
      if (dx < LIMIAR || dx < Math.abs(dy) * 1.2) { if (dx < -LIMIAR) parar(false); return; }
      const h = pegar();
      if (h && typeof h.inicio === 'function') { if (h.inicio() === false) return parar(false); }
      else if (!(OM.rotas && (typeof OM.rotas.podeVoltar !== 'function' || OM.rotas.podeVoltar()))) return parar(false);
      g.h = h; g.ativo = true;
      doc.body.classList.add('borda-ativa');
      try { e.target.setPointerCapture(e.pointerId); } catch {}
    }
    g.amostras.push([agora(e), e.clientX]);
    if (g.amostras.length > 6) g.amostras.shift();
    g.p = Math.max(0, Math.min(1, dx / (innerWidth || 1)));
    if (g.h && typeof g.h.mover === 'function') g.h.mover(g.p);
  }
  function soltar(e) {
    if (!g || e.pointerId !== g.id) return;
    if (!g.ativo) return parar(false);
    g.amostras.push([agora(e), e.clientX]);
    g.p = Math.max(0, Math.min(1, (e.clientX - g.x0) / (innerWidth || 1)));
    const v = velocidade(g.amostras);
    parar(g.p > 0.35 || (v > 0.4 && g.p > 0.05));
  }
  function cancelar(e) { if (g && e.pointerId === g.id) parar(false); }
  function parar(confirmado) {
    const era = g;
    g = null;
    if (!era) return;
    era.off();
    if (!era.ativo) return;
    doc.body.classList.remove('borda-ativa');
    suprimirClique();
    if (era.h && typeof era.h.fim === 'function') era.h.fim(!!confirmado);
    else if (confirmado && OM.rotas && typeof OM.rotas.voltar === 'function') OM.rotas.voltar();
  }
  addEventListener('pointerdown', baixo, true);
  offBorda = () => { removeEventListener('pointerdown', baixo, true); if (g) parar(false); offBorda = null; };
  return offBorda;
}

// ───────────────────────────── puxar para atualizar ─────────────────────────────
// puxar(el, async fn) → off. el = o elemento que rola (ex.: .tela-corpo). Indicador .puxar-ind no pai.
const PUXAR_LIMIAR = 64, PUXAR_RESIST = 0.5, PUXAR_MAX = 120, PUXAR_SEGURA = 56;
function puxar(alvo, fn) {
  if (!alvo || typeof fn !== 'function') return () => {};
  alvo.classList.add('puxavel');
  const pai = alvo.parentElement || alvo;
  const ind = el('div', 'puxar-ind');
  ind.setAttribute('aria-hidden', 'true');
  const anel = el('span', 'puxar-anel');
  ind.append(anel);
  pai.append(ind);
  let g = null, rodando = false;
  const noTopo = () => alvo.scrollTop <= 0;
  const marcar = () => alvo.classList.toggle('no-topo', noTopo());
  marcar();

  function topoInd() {
    const cab = pai.querySelector(':scope > .tela-cab');
    ind.style.top = (alvo.offsetTop + (cab ? cab.offsetHeight : 0)) + 'px';
  }
  function mostrar(d, prog) {
    ind.style.opacity = String(Math.min(1, prog * 1.2));
    if (reduzido()) return;
    ind.style.transform = 'translate(-50%, ' + Math.round(d - 40) + 'px)';
    anel.style.transform = 'rotate(' + Math.round(prog * 300) + 'deg)';
    alvo.style.transform = d > 0 ? 'translateY(' + Math.round(d) + 'px)' : '';
  }
  function recolher() {
    const red = reduzido();
    alvo.classList.toggle('puxar-volta', !red);
    ind.classList.toggle('puxar-volta', !red);
    ind.classList.remove('girando', 'pronto');
    ind.style.opacity = '0';
    if (!red) ind.style.transform = 'translate(-50%, -40px)';
    alvo.style.transform = '';
    setTimeout(() => { alvo.classList.remove('puxar-volta'); ind.classList.remove('puxar-volta'); }, 320);
  }
  async function rodar() {
    rodando = true;
    ind.classList.add('girando');
    ind.setAttribute('aria-busy', 'true');
    alvo.classList.add('puxar-volta');
    ind.classList.add('puxar-volta');
    mostrar(reduzido() ? 0 : PUXAR_SEGURA, 1);
    try { await fn(); } catch (e) { console.error(e); }
    ind.removeAttribute('aria-busy');
    rodando = false;
    recolher();
  }

  function baixo(e) {
    if (g || rodando || !toqueOuCaneta(e) || !noTopo() || e.clientX <= ZONA_BORDA) return;
    g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, ativo: false, d: 0, off: seguir(mover, soltar, cancelar) };
  }
  function mover(e) {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.ativo) {
      if (Math.abs(dy) < LIMIAR && Math.abs(dx) < LIMIAR) return;
      if (dy <= 0 || Math.abs(dx) > dy || !noTopo()) return parar();
      g.ativo = true;
      topoInd();
      alvo.classList.remove('puxar-volta');
      ind.classList.remove('puxar-volta');
      try { e.target.setPointerCapture(e.pointerId); } catch {}
    }
    g.d = Math.max(0, Math.min(PUXAR_MAX, dy * PUXAR_RESIST));
    const prog = Math.min(1, g.d / PUXAR_LIMIAR);
    ind.classList.toggle('pronto', g.d >= PUXAR_LIMIAR);
    mostrar(g.d, prog);
  }
  function soltar(e) {
    if (!g || e.pointerId !== g.id) return;
    const era = g;
    parar();
    if (!era.ativo) return;
    suprimirClique();
    if (era.d >= PUXAR_LIMIAR) rodar(); else recolher();
  }
  function cancelar(e) {
    if (!g || e.pointerId !== g.id) return;
    const era = g;
    parar();
    if (era.ativo) recolher();
  }
  function parar() { if (g) { g.off(); g = null; } }
  // iOS ignora pan-down: segura a rolagem nativa enquanto o puxar está ativo
  const tm = (e) => { if (g && g.ativo && e.cancelable) e.preventDefault(); };
  alvo.addEventListener('pointerdown', baixo);
  alvo.addEventListener('scroll', marcar, { passive: true });
  alvo.addEventListener('touchmove', tm, { passive: false });
  return () => {
    parar();
    alvo.removeEventListener('pointerdown', baixo);
    alvo.removeEventListener('scroll', marcar);
    alvo.removeEventListener('touchmove', tm);
    alvo.classList.remove('puxavel', 'no-topo', 'puxar-volta');
    alvo.style.transform = '';
    ind.remove();
  };
}

// ───────────────────────────── deslizar item ─────────────────────────────
// deslizar(item, { esquerda: [ação], direita: [ação] }) → { fechar, abrir(lado 'esquerda'|'direita'), off, el }
// ação = { rotulo, icone?, tipo: 'perigo'|'aviso'|'sucesso'|'acento'|'neutro', acao(item) }. `esquerda` fica à esquerda
// (aparece ao deslizar para a direita); `direita` à direita (deslizar para a esquerda). Um aberto por vez; toque fora,
// rolagem ou Esc fecha; no teclado (foco no item) ← abre a direita, → abre a esquerda.
const LARG_ACAO = 76;
let aberto = null; // { fechar, el }
function deslizar(item, op = {}) {
  const esq = Array.isArray(op.esquerda) ? op.esquerda : [];
  const dir = Array.isArray(op.direita) ? op.direita : [];
  const caixa = el('div', 'desl');
  item.replaceWith(caixa);
  item.classList.add('desl-frente');
  const fazerLado = (lista, lado) => {
    const c = el('div', 'desl-acoes desl-' + lado); // nunca 'esq' sozinho: é a classe do esqueleto (componentes.css)
    c.inert = true;
    for (const a of lista) {
      const b = el('button', 'desl-acao toque');
      b.type = 'button';
      b.dataset.tipo = a.tipo || 'neutro';
      if (a.icone && OM.icone) b.append(OM.icone(a.icone, 20));
      const r = el('span', 'desl-rot'); r.textContent = a.rotulo || '';
      b.append(r);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fechar();
        try { if (typeof a.acao === 'function') a.acao(item); } catch (err) { console.error(err); }
      });
      c.append(b);
    }
    return c;
  };
  const cEsq = fazerLado(esq, 'esq'), cDir = fazerLado(dir, 'dir');
  caixa.append(cEsq, cDir, item);
  const W = { esq: esq.length * LARG_ACAO, dir: dir.length * LARG_ACAO };
  let x = 0, g = null;

  const eu = { el: caixa, fechar: () => fechar() };
  function pos(v, animar) {
    x = v;
    item.classList.toggle('desl-anima', !!animar && !reduzido());
    caixa.dataset.lado = v > 0 ? 'esq' : v < 0 ? 'dir' : '';
    item.style.transform = v ? 'translateX(' + Math.round(v) + 'px)' : '';
  }
  function abrir(lado) {
    const l = lado === 'esquerda' || lado === 'esq' ? 'esq' : 'dir';
    if (!W[l]) return;
    if (aberto && aberto !== eu) aberto.fechar();
    aberto = eu;
    pos(l === 'esq' ? W.esq : -W.dir, true);
    cEsq.inert = l !== 'esq'; cDir.inert = l !== 'dir';
    caixa.classList.add('aberto');
  }
  function fechar() {
    if (aberto === eu) aberto = null;
    cEsq.inert = true; cDir.inert = true;
    caixa.classList.remove('aberto');
    if (x) pos(0, true);
  }

  function baixo(e) {
    if (g || !toqueOuCaneta(e)) return;
    if (e.clientX <= ZONA_BORDA && !x) return; // a borda é do "voltar"
    if (aberto && aberto !== eu) aberto.fechar();
    g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, xIni: x, ativo: false, amostras: [[agora(e), e.clientX]], off: seguir(mover, soltar, cancelar) };
  }
  function mover(e) {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.ativo) {
      if (Math.abs(dx) < LIMIAR && Math.abs(dy) < LIMIAR) return;
      if (Math.abs(dy) * 1.2 >= Math.abs(dx)) return parar(); // vertical: deixa rolar
      g.ativo = true;
      item.classList.remove('desl-anima');
      try { e.target.setPointerCapture(e.pointerId); } catch {}
    }
    g.amostras.push([agora(e), e.clientX]);
    if (g.amostras.length > 6) g.amostras.shift();
    let v = g.xIni + dx;
    const max = W.esq, min = -W.dir;
    if (v > max) v = max + (v - max) * 0.2;
    if (v < min) v = min + (v - min) * 0.2;
    pos(v, false);
  }
  function soltar(e) {
    if (!g || e.pointerId !== g.id) return;
    const era = g;
    if (!era.ativo) {
      parar();
      if (x) { suprimirClique(); fechar(); } // toque no item aberto só fecha
      return;
    }
    era.amostras.push([agora(e), e.clientX]);
    const v = velocidade(era.amostras);
    parar();
    suprimirClique();
    let lado = null;
    if (v > 0.4) lado = x > 0 ? 'esq' : null;
    else if (v < -0.4) lado = x < 0 ? 'dir' : null;
    else if (x > W.esq / 2 && W.esq) lado = 'esq';
    else if (x < -W.dir / 2 && W.dir) lado = 'dir';
    if (lado) abrir(lado); else fechar();
  }
  function cancelar(e) {
    if (!g || e.pointerId !== g.id) return;
    const era = g;
    parar();
    if (era.ativo) { if (era.xIni) abrir(era.xIni > 0 ? 'esq' : 'dir'); else fechar(); }
  }
  function parar() { if (g) { g.off(); g = null; } }
  function tecla(e) {
    if (e.target !== item) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); if (x > 0) fechar(); else abrir('dir'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (x < 0) fechar(); else abrir('esq'); }
    else if (e.key === 'Escape' && x) { e.preventDefault(); e.stopPropagation(); fechar(); item.focus(); }
  }
  function teclaAcao(e) { if (e.key === 'Escape' && x) { e.preventDefault(); e.stopPropagation(); fechar(); item.focus(); } }
  item.addEventListener('pointerdown', baixo);
  item.addEventListener('keydown', tecla);
  cEsq.addEventListener('keydown', teclaAcao);
  cDir.addEventListener('keydown', teclaAcao);
  eu.abrir = abrir;
  eu.off = () => {
    parar();
    if (aberto === eu) aberto = null;
    item.removeEventListener('pointerdown', baixo);
    item.removeEventListener('keydown', tecla);
    item.classList.remove('desl-frente', 'desl-anima');
    item.style.transform = '';
    if (caixa.parentNode) caixa.replaceWith(item);
  };
  return eu;
}
// toque fora ou rolagem fecha o item aberto
addEventListener('pointerdown', (e) => { if (aberto && !aberto.el.contains(e.target)) aberto.fechar(); }, true);
addEventListener('scroll', (e) => { if (aberto && e.target instanceof Node && !aberto.el.contains(e.target)) aberto.fechar(); }, { capture: true, passive: true });

OM.gestos = { voltarBorda, puxar, deslizar, ZONA_BORDA };
voltarBorda();
})();
