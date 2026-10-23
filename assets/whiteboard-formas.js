// Orbit — Whiteboard, etapa 2: formas. Tipos retangulo, elipse, losango, linha, livre e as ferramentas que os criam.
// Carregado depois de whiteboard.js (usa window.Whiteboard.registrarTipo / registrarFerramenta / nucleo).
// Traço limpo e geométrico (sem efeito "à mão"). Excalidraw (MIT) só como referência de técnica.
//   retangulo R · elipse O · losango D: arrastar desenha (Shift = proporcional, Alt = a partir do centro);
//     clique sem arrastar cria o tamanho padrão centrado no clique.
//   linha L: arrastar = segmento; clicar-clicar = polilinha (Enter, Esc ou clicar de novo no último ponto termina);
//     Shift trava o ângulo em passos de 15°.
//   livre P: mão livre; suavizada ao desenhar e simplificada (Ramer-Douglas-Peucker) ao soltar.
// Depois de criar volta para "selecionar" com o novo elemento selecionado (livre fica ativa).
(() => {
  'use strict';
  const W = window.Whiteboard;
  if (!W || !W.registrarTipo || !W.registrarFerramenta || !W.nucleo) { console.warn('whiteboard-formas: núcleo ausente'); return; }
  const N = W.nucleo;
  const { aplicarTraco, caixaNormal, dentro } = N.util;

  const PADRAO = { cor: '#e5e5e5', traco: { largura: 2, estilo: 'solido' }, preenchimento: null, opacidade: 1 };
  const TAM_PADRAO = { w: 160, h: 100 };
  const PASSO_ANGULO = Math.PI / 12; // 15°
  const NUM = (v, d = 0) => (Number.isFinite(v) ? v : d);

  function estilo() {
    let s = null;
    try { s = N.estiloAtual ? N.estiloAtual() : null; } catch { s = null; }
    s = s || PADRAO;
    const t = s.traco || PADRAO.traco;
    return {
      cor: s.cor || PADRAO.cor,
      traco: { largura: NUM(t.largura, 2), estilo: t.estilo || 'solido' },
      preenchimento: s.preenchimento === undefined ? null : s.preenchimento,
      opacidade: NUM(s.opacidade, 1),
    };
  }

  // ── Ícones (16×16, mesmo traço dos ICONES do núcleo) ──
  const ICONE = {
    retangulo: [['rect', { x: 2.5, y: 3.5, width: 11, height: 9, rx: 2 }]],
    elipse: [['ellipse', { cx: 8, cy: 8, rx: 5.8, ry: 4.8 }]],
    losango: [['path', { d: 'M8 2.2 13.8 8 8 13.8 2.2 8z' }]],
    linha: [['path', { d: 'M3.5 12.5 12.5 3.5' }]],
    livre: [['path', { d: 'M2.5 11.2c1.4-4.2 2.9-6.1 4.4-4.7s1.1 4 3.1 3 2-3.4 3.5-5.2' }]],
  };

  // ── Geometria ──
  function distSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function distPontos(el, px, py) {
    const P = el.pontos || [];
    if (!P.length) return Infinity;
    if (P.length === 1) return Math.hypot(px - el.x - P[0][0], py - el.y - P[0][1]);
    let m = Infinity;
    for (let i = 0; i < P.length - 1; i++) m = Math.min(m, distSeg(px, py, el.x + P[i][0], el.y + P[i][1], el.x + P[i + 1][0], el.y + P[i + 1][1]));
    return m;
  }
  const meiaLarg = (el) => NUM(el.traco && el.traco.largura, 2) / 2;
  function caixaPontos(el) {
    const P = el.pontos;
    if (!P || !P.length) return { x: el.x, y: el.y, w: el.w, h: el.h };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [dx, dy] of P) { x0 = Math.min(x0, dx); y0 = Math.min(y0, dy); x1 = Math.max(x1, dx); y1 = Math.max(y1, dy); }
    return { x: el.x + x0, y: el.y + y0, w: x1 - x0, h: y1 - y0 };
  }

  // ── Desenho (cada função recebe o ctx já no mundo) ──
  function caminhoRetangulo(ctx, b) {
    const r = Math.min(8, b.w / 4, b.h / 4);
    ctx.beginPath();
    if (r <= 0.5) { ctx.rect(b.x, b.y, b.w, b.h); return; }
    ctx.moveTo(b.x + r, b.y);
    ctx.arcTo(b.x + b.w, b.y, b.x + b.w, b.y + b.h, r);
    ctx.arcTo(b.x + b.w, b.y + b.h, b.x, b.y + b.h, r);
    ctx.arcTo(b.x, b.y + b.h, b.x, b.y, r);
    ctx.arcTo(b.x, b.y, b.x + b.w, b.y, r);
    ctx.closePath();
  }
  function pintar(ctx, el) {
    if (el.preenchimento) { ctx.fillStyle = el.preenchimento; ctx.fill(); }
    if (aplicarTraco(ctx, el)) ctx.stroke();
  }
  function desenharRetangulo(ctx, el) { caminhoRetangulo(ctx, caixaNormal(el)); pintar(ctx, el); }
  function desenharElipse(ctx, el) {
    const b = caixaNormal(el);
    ctx.beginPath(); ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
    pintar(ctx, el);
  }
  function desenharLosango(ctx, el) {
    const b = caixaNormal(el), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    ctx.beginPath(); ctx.moveTo(cx, b.y); ctx.lineTo(b.x + b.w, cy); ctx.lineTo(cx, b.y + b.h); ctx.lineTo(b.x, cy); ctx.closePath();
    pintar(ctx, el);
  }
  function desenharLinha(ctx, el) {
    const P = el.pontos;
    if (!P || P.length < 2) return;
    ctx.beginPath(); ctx.moveTo(el.x + P[0][0], el.y + P[0][1]);
    for (let i = 1; i < P.length; i++) ctx.lineTo(el.x + P[i][0], el.y + P[i][1]);
    if (aplicarTraco(ctx, el)) ctx.stroke();
  }
  function desenharLivre(ctx, el) {
    const P = el.pontos;
    if (!P || !P.length) return;
    const X = (i) => el.x + P[i][0], Y = (i) => el.y + P[i][1], n = P.length;
    if (n === 1) {
      ctx.beginPath(); ctx.arc(X(0), Y(0), Math.max(0.5, meiaLarg(el)), 0, Math.PI * 2);
      ctx.fillStyle = el.cor; ctx.fill(); return;
    }
    ctx.beginPath(); ctx.moveTo(X(0), Y(0));
    if (n === 2) ctx.lineTo(X(1), Y(1));
    else {
      for (let i = 1; i < n - 1; i++) ctx.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2);
      ctx.lineTo(X(n - 1), Y(n - 1));
    }
    if (aplicarTraco(ctx, el)) ctx.stroke();
  }

  // ── Tipos ──
  W.registrarTipo('retangulo', {
    desenhar: desenharRetangulo,
    testarClique(el, px, py, tol) {
      const b = caixaNormal(el);
      if (el.preenchimento) return dentro(b, px, py, tol);
      const m = tol + meiaLarg(el);
      return dentro(b, px, py, m) && !(b.w > 2 * m && b.h > 2 * m && dentro(b, px, py, -m));
    },
  });
  W.registrarTipo('elipse', {
    desenhar: desenharElipse,
    testarClique(el, px, py, tol) {
      const b = caixaNormal(el), cx = b.x + b.w / 2, cy = b.y + b.h / 2, m = tol + meiaLarg(el);
      const ext = ((px - cx) / (b.w / 2 + m || 1)) ** 2 + ((py - cy) / (b.h / 2 + m || 1)) ** 2;
      if (ext > 1) return false;
      if (el.preenchimento) return true;
      const a = b.w / 2 - m, c = b.h / 2 - m;
      if (a <= 0 || c <= 0) return true;
      return ((px - cx) / a) ** 2 + ((py - cy) / c) ** 2 >= 1;
    },
  });
  W.registrarTipo('losango', {
    desenhar: desenharLosango,
    testarClique(el, px, py, tol) {
      const b = caixaNormal(el), cx = b.x + b.w / 2, cy = b.y + b.h / 2, m = tol + meiaLarg(el);
      const V = [[cx, b.y], [b.x + b.w, cy], [cx, b.y + b.h], [b.x, cy]];
      for (let i = 0; i < 4; i++) { const a = V[i], c = V[(i + 1) % 4]; if (distSeg(px, py, a[0], a[1], c[0], c[1]) <= m) return true; }
      return !!el.preenchimento && b.w > 0 && b.h > 0 && Math.abs(px - cx) / (b.w / 2) + Math.abs(py - cy) / (b.h / 2) <= 1;
    },
  });
  W.registrarTipo('linha', {
    desenhar: desenharLinha,
    caixa: caixaPontos,
    testarClique: (el, px, py, tol) => distPontos(el, px, py) <= tol + meiaLarg(el),
  });
  W.registrarTipo('livre', {
    desenhar: desenharLivre,
    caixa: caixaPontos,
    testarClique: (el, px, py, tol) => distPontos(el, px, py) <= tol + meiaLarg(el),
  });
  const DESENHO = { retangulo: desenharRetangulo, elipse: desenharElipse, losango: desenharLosango, linha: desenharLinha, livre: desenharLivre };

  // ── Criação ──
  const ROTULO = { retangulo: 'retângulo', elipse: 'elipse', losango: 'losango', linha: 'linha', livre: 'mão livre' };
  function novoElemento(tipo, caixa, extra) {
    return { tipo, x: caixa.x, y: caixa.y, w: caixa.w, h: caixa.h, angulo: 0, pontos: null, ...estilo(), ...extra };
  }
  function concluir(el, trocar) {
    const criado = N.adicionar(el);
    if (trocar) { N.selecionar([criado.id]); N.definirFerramenta('selecionar'); }
    N.confirmar('criar ' + ROTULO[el.tipo]);
    return criado;
  }
  // Pré-visualização: ctx em px de tela → aplica a câmera e usa a mesma função de desenho do tipo.
  function previa(ctx, el) {
    const c = N.camera();
    ctx.save();
    ctx.translate(-c.x * c.zoom, -c.y * c.zoom); ctx.scale(c.zoom, c.zoom);
    ctx.globalAlpha = Math.max(0, Math.min(1, NUM(el.opacidade, 1)));
    try { DESENHO[el.tipo](ctx, el); } finally { ctx.restore(); }
  }

  // Caixa de arrasto com Shift (proporcional) e Alt (a partir do centro).
  function caixaArrasto(x0, y0, x1, y1, ev) {
    let dx = x1 - x0, dy = y1 - y0;
    if (ev && ev.shiftKey) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = (dx < 0 ? -1 : 1) * m; dy = (dy < 0 ? -1 : 1) * m; }
    if (ev && ev.altKey) return { x: x0 - Math.abs(dx), y: y0 - Math.abs(dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 };
    return { x: Math.min(x0, x0 + dx), y: Math.min(y0, y0 + dy), w: Math.abs(dx), h: Math.abs(dy) };
  }

  function ferramentaForma(tipo, tecla, ordem) {
    let d = null;
    W.registrarFerramenta(tipo, {
      rotulo: ROTULO[tipo][0].toUpperCase() + ROTULO[tipo].slice(1), icone: ICONE[tipo], tecla, ordem, cursor: 'crosshair',
      aoDescer(p) { d = { x0: p.x, y0: p.y, sx: p.sx, sy: p.sy, x1: p.x, y1: p.y, ev: p.evento, moveu: false }; },
      aoMover(p) {
        if (!d) return;
        if (!d.moveu && Math.hypot(p.sx - d.sx, p.sy - d.sy) < 3) return;
        d.moveu = true; d.x1 = p.x; d.y1 = p.y; d.ev = p.evento;
      },
      aoSubir(p) {
        if (!d) return;
        const g = d; d = null;
        const caixa = g.moveu
          ? caixaArrasto(g.x0, g.y0, p.x, p.y, p.evento)
          : { x: g.x0 - TAM_PADRAO.w / 2, y: g.y0 - TAM_PADRAO.h / 2, w: TAM_PADRAO.w, h: TAM_PADRAO.h };
        concluir(novoElemento(tipo, caixa), true);
      },
      aoCancelar() { d = null; },
      aoDesativar() { d = null; },
      aoDesenhar(ctx) {
        if (!d || !d.moveu) return;
        previa(ctx, { ...novoElemento(tipo, caixaArrasto(d.x0, d.y0, d.x1, d.y1, d.ev)), id: '_previa' });
      },
    });
  }
  ferramentaForma('retangulo', 'r', 30);
  ferramentaForma('elipse', 'o', 31);
  ferramentaForma('losango', 'd', 32);

  // ── Linha / polilinha ──
  const Li = { pts: null, cur: null, primeiro: false, arrastou: false, sx: 0, sy: 0, lsx: 0, lsy: 0 };
  const zerarLinha = () => { Li.pts = null; Li.cur = null; Li.primeiro = false; Li.arrastou = false; };
  function restringir(p) {
    const u = Li.pts[Li.pts.length - 1];
    if (!p.evento || !p.evento.shiftKey) return [p.x, p.y];
    const dx = p.x - u[0], dy = p.y - u[1], len = Math.hypot(dx, dy);
    const ang = Math.round(Math.atan2(dy, dx) / PASSO_ANGULO) * PASSO_ANGULO;
    return [u[0] + len * Math.cos(ang), u[1] + len * Math.sin(ang)];
  }
  function elementoLinha(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return novoElemento('linha', { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, { preenchimento: null, pontos: pts.map(([x, y]) => [x - x0, y - y0]) });
  }
  function finalizarLinha(trocar) {
    const pts = (Li.pts || []).filter((q, i, a) => !i || Math.hypot(q[0] - a[i - 1][0], q[1] - a[i - 1][1]) > 0.01);
    zerarLinha();
    if (pts.length >= 2) concluir(elementoLinha(pts), trocar);
    else N.redesenhar();
  }
  W.registrarFerramenta('linha', {
    rotulo: 'Linha', icone: ICONE.linha, tecla: 'l', ordem: 40, cursor: 'crosshair',
    aoDescer(p) {
      if (!Li.pts) { Li.pts = [[p.x, p.y]]; Li.cur = [p.x, p.y]; Li.primeiro = true; Li.arrastou = false; Li.sx = p.sx; Li.sy = p.sy; Li.lsx = p.sx; Li.lsy = p.sy; return; }
      if (Math.hypot(p.sx - Li.lsx, p.sy - Li.lsy) < 5) { finalizarLinha(true); return; } // clique de novo no último ponto
      const q = restringir(p);
      Li.pts.push(q); Li.cur = q;
      const t = N.mundoParaTela(q[0], q[1]); Li.lsx = t.sx; Li.lsy = t.sy;
    },
    aoMover(p) {
      if (!Li.pts) return;
      if (Li.primeiro && !Li.arrastou && Math.hypot(p.sx - Li.sx, p.sy - Li.sy) >= 3) Li.arrastou = true;
      if (Li.primeiro && !Li.arrastou) return;
      Li.cur = restringir(p);
    },
    aoSubir(p) {
      if (!Li.pts || !Li.primeiro) return;
      Li.primeiro = false;
      if (Li.arrastou) { Li.pts.push(restringir(p)); finalizarLinha(true); }
    },
    aoPairar(p) { if (Li.pts && !Li.primeiro) { Li.cur = restringir(p); N.redesenhar(); } },
    aoTecla(e) {
      if (!Li.pts || (e.key !== 'Enter' && e.key !== 'Escape')) return false;
      finalizarLinha(true);
      return true;
    },
    aoCancelar() { if (Li.primeiro) zerarLinha(); },
    aoDesativar() { if (Li.pts) finalizarLinha(false); },
    aoDesenhar(ctx) {
      if (!Li.pts || !Li.cur) return;
      const pts = Li.pts.concat([Li.cur]);
      if (pts.length < 2) return;
      previa(ctx, { ...elementoLinha(pts), id: '_previa' });
    },
  });

  // ── Mão livre ──
  const Lv = { pts: null, pressoes: [], caneta: false };
  // Ramer-Douglas-Peucker iterativo.
  function simplificar(P, eps) {
    if (P.length < 3) return P.slice();
    const manter = new Uint8Array(P.length); manter[0] = manter[P.length - 1] = 1;
    const pilha = [[0, P.length - 1]];
    while (pilha.length) {
      const [a, b] = pilha.pop();
      let max = 0, idx = -1;
      for (let i = a + 1; i < b; i++) { const dd = distSeg(P[i][0], P[i][1], P[a][0], P[a][1], P[b][0], P[b][1]); if (dd > max) { max = dd; idx = i; } }
      if (idx >= 0 && max > eps) { manter[idx] = 1; pilha.push([a, idx], [idx, b]); }
    }
    return P.filter((_, i) => manter[i]);
  }
  function elementoLivre(pts, extra) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return novoElemento('livre', { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, { preenchimento: null, pontos: pts.map(([x, y]) => [x - x0, y - y0]), ...extra });
  }
  function somarPonto(x, y) {
    const u = Lv.pts[Lv.pts.length - 1];
    if (Math.hypot(x - u[0], y - u[1]) * N.camera().zoom < 1.5) return;
    Lv.pts.push([x, y]);
  }
  const r1 = (v) => Math.round(v * 10) / 10;
  function finalizarLivre() {
    if (!Lv.pts) return;
    const zoom = N.camera().zoom;
    let pts = Lv.pts.length > 1 ? simplificar(Lv.pts, Math.max(0.4, 0.8 / zoom)) : Lv.pts.slice();
    const est = estilo();
    let largura = est.traco.largura;
    if (Lv.caneta && Lv.pressoes.length) largura = r1(largura * (0.6 + 0.8 * (Lv.pressoes.reduce((a, b) => a + b, 0) / Lv.pressoes.length)));
    Lv.pts = null; Lv.pressoes = [];
    let el = elementoLivre(pts, { traco: { ...est.traco, largura } });
    el = { ...el, x: r1(el.x), y: r1(el.y), pontos: el.pontos.map(([a, b]) => [r1(a), r1(b)]) };
    concluir(el, false);
  }
  W.registrarFerramenta('livre', {
    rotulo: 'Mão livre', icone: ICONE.livre, tecla: 'p', ordem: 50, cursor: 'crosshair',
    aoDescer(p) {
      Lv.pts = [[p.x, p.y]]; Lv.pressoes = []; Lv.caneta = !!(p.evento && p.evento.pointerType === 'pen');
      if (Lv.caneta) Lv.pressoes.push(p.evento.pressure || 0.5);
    },
    aoMover(p) {
      if (!Lv.pts) return;
      const e = p.evento, ox = e.clientX - p.sx, oy = e.clientY - p.sy;
      const lista = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ce of lista.length ? lista : [e]) {
        const q = N.telaParaMundo(ce.clientX - ox, ce.clientY - oy);
        somarPonto(q.x, q.y);
        if (Lv.caneta && ce.pressure) Lv.pressoes.push(ce.pressure);
      }
    },
    aoSubir(p) {
      if (!Lv.pts) return;
      if (Lv.pts.length > 1) somarPonto(p.x, p.y);
      finalizarLivre();
    },
    aoCancelar() { Lv.pts = null; Lv.pressoes = []; },
    aoDesativar() { Lv.pts = null; Lv.pressoes = []; },
    aoDesenhar(ctx) {
      if (!Lv.pts) return;
      previa(ctx, { ...elementoLivre(Lv.pts), id: '_previa' });
    },
  });
})();
