// Orbit — Whiteboard, etapa 3: setas que se prendem aos elementos. Tipo e ferramenta 'seta' (A, ordem 41).
// Carregado depois de whiteboard.js e whiteboard-formas.js. Excalidraw (MIT) só como referência de técnica
// (ponto de ancoragem relativo, folga, foco); traço limpo, sem efeito "à mão".
//   Criar: arrastar = seta reta (Shift trava em 15°); clicar-clicar = seta com vários pontos (Enter, Esc ou clicar de novo
//     no último ponto termina). Começar/terminar sobre um elemento com caixa prende a ponta (realce suave no alvo).
//   Formato: el.pontos (relativos a x, y), el.ligacoes = { inicio: { id, foco: [fx, fy] } | null, fim: … },
//     el.pontas = { inicio: 'nenhuma' | 'seta', fim: 'nenhuma' | 'seta' } (a etapa de estilo troca). O alvo guarda em
//     ligacoes a lista dos ids das setas presas. foco = ponto de mira relativo à caixa do alvo (0..1, sem rotação).
//   Ponta presa: entrada do segmento (ponto vizinho → mira) na borda do alvo (retângulo, elipse, losango; caixa nos
//     demais tipos, inclusive cards HTML), recuada uma folga pequena.
//   Manter presas: recálculo idempotente por mutação direta (sem eventos nem confirmar) ao desenhar a seta, no evento
//     'mudanca' do núcleo e num pointerup em captura (antes do confirmar do núcleo). Seta movida sozinha (alvo parado)
//     solta a ponta. Alvo apagado solta a ponta (a seta fica onde estava).
//   Editar: com uma seta selecionada, arrastar uma ponta solta ou prende de novo (Shift 15°, Esc cancela).
//   API: Whiteboard.setas (apelido: window.WhiteboardSetas) = { reconciliar(ids), recalcular(id),
//     alvoEm(x, y) }. reconciliar(ids): ids = elementos recém-copiados (duplicar/colar) — seta copiada presa a alvo fora
//     da cópia é solta; sem ids só acerta as listas. Sempre deixa listas e ligações coerentes.
(() => {
  'use strict';
  const W = window.Whiteboard;
  if (!W || !W.registrarTipo || !W.registrarFerramenta || !W.nucleo) { console.warn('whiteboard-setas: núcleo ausente'); return; }
  const N = W.nucleo;
  const { aplicarTraco, caixaNormal, girarPonto } = N.util;

  const PADRAO = { cor: '#e5e5e5', traco: { largura: 2, estilo: 'solido' }, opacidade: 1 };
  const PASSO_ANGULO = Math.PI / 12; // 15°
  const FOLGA = 4;                   // + meia espessura do alvo
  const RAIO_PONTA = 10;             // px na tela para pegar uma ponta
  const NUM = (v, d = 0) => (Number.isFinite(v) ? v : d);
  const larg = (el) => NUM(el && el.traco && el.traco.largura, 2);
  const zoom = () => { try { return N.camera().zoom || 1; } catch { return 1; } };
  let Ed = null; // edição de ponta em andamento: { id, k, idx, orig, moveu, alvo, sx0, sy0, pid }

  function estilo() {
    let s = null;
    try { s = N.estiloAtual ? N.estiloAtual() : null; } catch { s = null; }
    s = s || PADRAO;
    const t = s.traco || PADRAO.traco;
    return { cor: s.cor || PADRAO.cor, traco: { largura: NUM(t.largura, 2), estilo: t.estilo || 'solido' }, opacidade: NUM(s.opacidade, 1) };
  }

  // ── Geometria básica ──
  function distSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function caixaPontos(el) {
    const P = el.pontos;
    if (!P || !P.length) return { x: el.x, y: el.y, w: el.w, h: el.h };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [dx, dy] of P) { x0 = Math.min(x0, dx); y0 = Math.min(y0, dy); x1 = Math.max(x1, dx); y1 = Math.max(y1, dy); }
    return { x: el.x + x0, y: el.y + y0, w: x1 - x0, h: y1 - y0 };
  }
  // Pontos da seta no mundo (com a rotação do elemento, se houver).
  function pontosMundo(s) {
    const b = caixaPontos(s), cx = b.x + b.w / 2, cy = b.y + b.h / 2, a = NUM(s.angulo);
    return (s.pontos || []).map(([dx, dy]) => (a ? girarPonto(s.x + dx, s.y + dy, cx, cy, a) : [s.x + dx, s.y + dy]));
  }
  // Grava pontos do mundo na seta (sem rotação). Mutação direta; devolve true se mudou algo.
  function gravar(s, pw) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pw) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const pontos = pw.map(([x, y]) => [x - x0, y - y0]);
    const velhos = s.pontos || [];
    let mudou = NUM(s.angulo) !== 0 || Math.abs(s.x - x0) > 1e-3 || Math.abs(s.y - y0) > 1e-3 || Math.abs(s.w - (x1 - x0)) > 1e-3 || Math.abs(s.h - (y1 - y0)) > 1e-3 || velhos.length !== pontos.length;
    if (!mudou) for (let i = 0; i < pontos.length; i++) if (Math.abs(velhos[i][0] - pontos[i][0]) > 1e-3 || Math.abs(velhos[i][1] - pontos[i][1]) > 1e-3) { mudou = true; break; }
    if (mudou) Object.assign(s, { x: x0, y: y0, w: x1 - x0, h: y1 - y0, angulo: 0, pontos });
    return mudou;
  }

  // ── Alvos ──
  const ehSeta = (el) => !!el && el.tipo === 'seta';
  // Pode receber ponta: qualquer elemento com caixa (não seta, linha nem mão livre). Esmaecido (borracha) não recebe nova.
  const podeSerAlvo = (el) => !!el && !ehSeta(el) && !(Array.isArray(el.pontos) && el.pontos.length);
  const elegivel = (el) => podeSerAlvo(el) && !el._esmaecer;
  const forma = (el) => (el.tipo === 'elipse' ? 'elipse' : el.tipo === 'losango' ? 'losango' : 'caixa');
  // Ponto do mundo → referencial do alvo (rotação desfeita) e volta.
  function local(alvo, x, y) {
    const b = caixaNormal(alvo), a = NUM(alvo.angulo);
    return a ? girarPonto(x, y, b.x + b.w / 2, b.y + b.h / 2, -a) : [x, y];
  }
  function mundo(alvo, x, y) {
    const b = caixaNormal(alvo), a = NUM(alvo.angulo);
    return a ? girarPonto(x, y, b.x + b.w / 2, b.y + b.h / 2, a) : [x, y];
  }
  // Ponto local dentro da forma, com margem m (pode ser negativa).
  function dentroForma(alvo, lx, ly, m = 0) {
    const b = caixaNormal(alvo), cx = b.x + b.w / 2, cy = b.y + b.h / 2, a = b.w / 2 + m, c = b.h / 2 + m;
    if (a <= 0 || c <= 0) return false;
    const f = forma(alvo);
    if (f === 'elipse') return ((lx - cx) / a) ** 2 + ((ly - cy) / c) ** 2 <= 1;
    if (f === 'losango') return Math.abs(lx - cx) / a + Math.abs(ly - cy) / c <= 1;
    return Math.abs(lx - cx) <= a && Math.abs(ly - cy) <= c;
  }
  // Elemento que recebe a ponta no ponto (x, y) do mundo: o de cima entre os elegíveis.
  function alvoEm(x, y, excluir) {
    const fora = new Set([].concat(excluir || []));
    const m = 8 / zoom(), lista = N.elementos();
    for (let i = lista.length - 1; i >= 0; i--) {
      const el = lista[i];
      if (fora.has(el.id) || !elegivel(el)) continue;
      const [lx, ly] = local(el, x, y);
      if (dentroForma(el, lx, ly, m)) return el;
    }
    return null;
  }
  function focoEm(alvo, x, y) {
    const b = caixaNormal(alvo), [lx, ly] = local(alvo, x, y);
    const c = (v) => Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000;
    return [b.w ? c((lx - b.x) / b.w) : 0.5, b.h ? c((ly - b.y) / b.h) : 0.5];
  }
  // Mira (local): ponto do foco, puxado para dentro da forma se cair fora (cantos da elipse/losango).
  function miraLocal(alvo, foco) {
    const b = caixaNormal(alvo), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const f = Array.isArray(foco) ? foco : [0.5, 0.5];
    let x = b.x + NUM(f[0], 0.5) * b.w, y = b.y + NUM(f[1], 0.5) * b.h;
    const a = b.w / 2, c = b.h / 2, tipo = forma(alvo);
    if (a > 0 && c > 0 && tipo !== 'caixa') {
      const v = tipo === 'elipse' ? Math.sqrt(((x - cx) / a) ** 2 + ((y - cy) / c) ** 2) : Math.abs(x - cx) / a + Math.abs(y - cy) / c;
      if (v > 0.98) { const k = 0.98 / v; x = cx + (x - cx) * k; y = cy + (y - cy) * k; }
    }
    return [x, y];
  }
  const mira = (alvo, foco) => { const [x, y] = miraLocal(alvo, foco); return mundo(alvo, x, y); };
  // Menor t em [0, 1] em que o segmento F → A (local) entra na forma; null se não cruza.
  function entrada(alvo, F, A) {
    const b = caixaNormal(alvo), dx = A[0] - F[0], dy = A[1] - F[1], tipo = forma(alvo);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    if (tipo === 'elipse') {
      const a = Math.max(b.w / 2, 1e-6), c = Math.max(b.h / 2, 1e-6);
      const ox = (F[0] - cx) / a, oy = (F[1] - cy) / c, vx = dx / a, vy = dy / c;
      const qa = vx * vx + vy * vy, qb = 2 * (ox * vx + oy * vy), qc = ox * ox + oy * oy - 1;
      const disc = qb * qb - 4 * qa * qc;
      if (qa < 1e-12 || disc < 0) return null;
      const t = (-qb - Math.sqrt(disc)) / (2 * qa);
      return t >= -1e-9 && t <= 1 ? Math.max(0, t) : null;
    }
    if (tipo === 'losango') {
      const V = [[cx, b.y], [b.x + b.w, cy], [cx, b.y + b.h], [b.x, cy]];
      let melhor = null;
      for (let i = 0; i < 4; i++) {
        const p = V[i], q = V[(i + 1) % 4], ex = q[0] - p[0], ey = q[1] - p[1];
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((p[0] - F[0]) * ey - (p[1] - F[1]) * ex) / den, u = ((p[0] - F[0]) * dy - (p[1] - F[1]) * dx) / den;
        if (t >= -1e-9 && t <= 1 && u >= -1e-9 && u <= 1 + 1e-9 && (melhor === null || t < melhor)) melhor = Math.max(0, t);
      }
      return melhor;
    }
    let t0 = 0, t1 = 1;
    for (const [p, d, lo, hi] of [[F[0], dx, b.x, b.x + b.w], [F[1], dy, b.y, b.y + b.h]]) {
      if (Math.abs(d) < 1e-12) { if (p < lo || p > hi) return null; continue; }
      let ta = (lo - p) / d, tb = (hi - p) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return null;
    }
    return t0;
  }
  // Ponta na borda do alvo: vinda de ref (mundo) mirando o foco; recuada a folga.
  function borda(alvo, foco, ref) {
    const A = miraLocal(alvo, foco), b = caixaNormal(alvo), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const P = local(alvo, ref[0], ref[1]);
    let ux = P[0] - A[0], uy = P[1] - A[1], d = Math.hypot(ux, uy);
    if (d < 1e-6) { ux = A[0] - cx; uy = A[1] - cy; d = Math.hypot(ux, uy); if (d < 1e-6) { ux = 0; uy = -1; d = 1; } }
    ux /= d; uy /= d;
    const longe = b.w + b.h + 20;
    const F = !dentroForma(alvo, P[0], P[1]) && Math.hypot(P[0] - A[0], P[1] - A[1]) > 1e-6 ? P : [A[0] + ux * longe, A[1] + uy * longe];
    const t = entrada(alvo, F, A);
    if (t === null) return mundo(alvo, A[0], A[1]);
    const qx = F[0] + (A[0] - F[0]) * t, qy = F[1] + (A[1] - F[1]) * t;
    const vx = F[0] - A[0], vy = F[1] - A[1], vl = Math.hypot(vx, vy) || 1, f = FOLGA + larg(alvo) / 2;
    return mundo(alvo, qx + (vx / vl) * f, qy + (vy / vl) * f);
  }

  // ── Ligações ──
  const ligacoesDe = (s) => (s.ligacoes && typeof s.ligacoes === 'object' && !Array.isArray(s.ligacoes) ? s.ligacoes : (s.ligacoes = { inicio: null, fim: null }));
  function alvoDe(lig) {
    if (!lig || typeof lig.id !== 'string') return null;
    const el = N.elemento(lig.id);
    return podeSerAlvo(el) ? el : null;
  }
  const assinatura = (el) => [el.x, el.y, el.w, el.h, NUM(el.angulo)].map((v) => Math.round(NUM(v) * 100)).join(',') + forma(el);
  function anotar(s) {
    const L = ligacoesDe(s), a = {};
    for (const k of ['inicio', 'fim']) { const t = alvoDe(L[k]); if (t) a[k] = assinatura(t); }
    s._sig = { x: s.x, y: s.y, alvos: a };
  }
  function tirarDaLista(alvoId, setaId) {
    const t = N.elemento(alvoId);
    if (!t || !Array.isArray(t.ligacoes)) return;
    const l = t.ligacoes.filter((id) => id !== setaId);
    t.ligacoes = l.length ? l : null;
  }
  function porNaLista(alvo, setaId) {
    const l = Array.isArray(alvo.ligacoes) ? alvo.ligacoes : [];
    if (!l.includes(setaId)) alvo.ligacoes = l.concat(setaId);
  }
  function soltar(s, k) {
    const L = ligacoesDe(s), lig = L[k];
    L[k] = null;
    if (lig && lig.id) { const o = L[k === 'inicio' ? 'fim' : 'inicio']; if (!o || o.id !== lig.id) tirarDaLista(lig.id, s.id); }
  }
  function prender(s, k, alvo, foco) {
    const L = ligacoesDe(s), velho = L[k];
    L[k] = { id: alvo.id, foco };
    if (velho && velho.id && velho.id !== alvo.id) { const o = L[k === 'inicio' ? 'fim' : 'inicio']; if (!o || o.id !== velho.id) tirarDaLista(velho.id, s.id); }
    if (N.elemento(s.id)) porNaLista(alvo, s.id);
  }
  // Recalcula as pontas presas da seta. Mutação direta; devolve true se mudou.
  function recalcular(s) {
    if (!ehSeta(s) || !Array.isArray(s.pontos) || s.pontos.length < 2) return false;
    const L = ligacoesDe(s);
    let mudou = false;
    for (const k of ['inicio', 'fim']) if (L[k] && !alvoDe(L[k])) { soltar(s, k); mudou = true; }
    // Seta movida sozinha (pela seleção ou teclado): solta a ponta cujo alvo ficou parado.
    const sig = s._sig;
    if (sig && (Math.abs(s.x - sig.x) > 0.01 || Math.abs(s.y - sig.y) > 0.01)) {
      for (const k of ['inicio', 'fim']) { const t = alvoDe(L[k]); if (t && sig.alvos[k] === assinatura(t)) { soltar(s, k); mudou = true; } }
    }
    const ti = alvoDe(L.inicio), tf = alvoDe(L.fim);
    if (ti || tf) {
      const pw = pontosMundo(s), n = pw.length;
      const mi = ti && mira(ti, L.inicio.foco), mf = tf && mira(tf, L.fim.foco);
      const refI = n === 2 ? (mf || pw[1]) : pw[1], refF = n === 2 ? (mi || pw[0]) : pw[n - 2];
      if (ti) pw[0] = borda(ti, L.inicio.foco, refI);
      if (tf) pw[n - 1] = borda(tf, L.fim.foco, refF);
      if (gravar(s, pw)) mudou = true;
    }
    anotar(s);
    return mudou;
  }
  function recalcularTodas() {
    let mudou = false;
    for (const el of [...N.elementos()]) if (ehSeta(el) && el.ligacoes && (el.ligacoes.inicio || el.ligacoes.fim) && recalcular(el)) mudou = true;
    if (mudou) N.redesenhar();
    return mudou;
  }
  function recalcularAfetadas(ids) {
    let mudou = false;
    const feitas = new Set();
    const fazer = (s) => { if (!s || feitas.has(s.id)) return; feitas.add(s.id); if (recalcular(s)) mudou = true; };
    for (const id of ids || []) {
      const el = N.elemento(id);
      if (!el) continue;
      if (ehSeta(el)) fazer(el);
      else if (Array.isArray(el.ligacoes)) for (const sid of [...el.ligacoes]) fazer(N.elemento(sid));
    }
    if (mudou) N.redesenhar();
    return mudou;
  }
  // Deixa listas e ligações coerentes. ids = cópia recém-criada: seta da cópia presa a alvo fora dela é solta.
  function reconciliar(ids) {
    const copia = new Set([].concat(ids || []).filter((id) => N.elemento(id)));
    const todos = [...N.elementos()];
    for (const s of todos) {
      if (!ehSeta(s)) continue;
      const L = ligacoesDe(s);
      for (const k of ['inicio', 'fim']) {
        const lig = L[k];
        if (!lig) continue;
        const t = alvoDe(lig);
        if (!t || (copia.has(s.id) && !copia.has(t.id))) { L[k] = null; continue; }
        if (!Array.isArray(lig.foco)) lig.foco = [0.5, 0.5];
      }
    }
    for (const el of todos) {
      if (ehSeta(el) || !Array.isArray(el.ligacoes)) continue;
      const l = el.ligacoes.filter((sid, i, a) => {
        const s = N.elemento(sid);
        return a.indexOf(sid) === i && ehSeta(s) && s.ligacoes && ((s.ligacoes.inicio && s.ligacoes.inicio.id === el.id) || (s.ligacoes.fim && s.ligacoes.fim.id === el.id));
      });
      el.ligacoes = l.length ? l : null;
    }
    for (const s of todos) {
      if (!ehSeta(s)) continue;
      const L = ligacoesDe(s);
      for (const k of ['inicio', 'fim']) { const t = alvoDe(L[k]); if (t) porNaLista(t, s.id); }
      if (copia.has(s.id)) delete s._sig;
      recalcular(s);
    }
    N.redesenhar();
  }

  // ── Desenho ──
  function cabeca(ctx, de, ate, el) {
    const dx = ate[0] - de[0], dy = ate[1] - de[1], d = Math.hypot(dx, dy);
    if (d < 0.5) return;
    const l = Math.min(7 + larg(el) * 2.4, d * 0.7), ang = Math.atan2(dy, dx), ab = 0.47;
    ctx.save();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(ate[0] - l * Math.cos(ang - ab), ate[1] - l * Math.sin(ang - ab));
    ctx.lineTo(ate[0], ate[1]);
    ctx.lineTo(ate[0] - l * Math.cos(ang + ab), ate[1] - l * Math.sin(ang + ab));
    ctx.stroke();
    ctx.restore();
  }
  function caminhoForma(ctx, alvo, m) {
    const b = caixaNormal(alvo), cx = b.x + b.w / 2, cy = b.y + b.h / 2, a = b.w / 2 + m, c = b.h / 2 + m, tipo = forma(alvo);
    ctx.beginPath();
    if (tipo === 'elipse') ctx.ellipse(cx, cy, Math.max(a, 0.1), Math.max(c, 0.1), 0, 0, Math.PI * 2);
    else if (tipo === 'losango') { ctx.moveTo(cx, cy - c); ctx.lineTo(cx + a, cy); ctx.lineTo(cx, cy + c); ctx.lineTo(cx - a, cy); ctx.closePath(); }
    else {
      const r = Math.min(10, a, c), x = cx - a, y = cy - c, w = 2 * a, h = 2 * c;
      if (r <= 0.5 || !ctx.roundRect) ctx.rect(x, y, w, h); else ctx.roundRect(x, y, w, h, r);
    }
  }
  // Realce suave do alvo (ctx no mundo, sem rotação).
  function desenharRealce(ctx, alvo, z) {
    if (!alvo) return;
    const b = caixaNormal(alvo), cx = b.x + b.w / 2, cy = b.y + b.h / 2, a = NUM(alvo.angulo);
    let cor = '#6366f1';
    try { cor = N.cores().acento || cor; } catch {}
    ctx.save();
    if (a) { ctx.translate(cx, cy); ctx.rotate(a); ctx.translate(-cx, -cy); }
    ctx.globalAlpha = 0.45; ctx.strokeStyle = cor; ctx.lineWidth = 4 / z; ctx.setLineDash([]); ctx.lineJoin = 'round';
    caminhoForma(ctx, alvo, 4 / z + larg(alvo) / 2);
    ctx.stroke();
    ctx.restore();
  }
  function tracar(ctx, el, pw) {
    if (pw.length < 2 || !aplicarTraco(ctx, el)) return;
    ctx.beginPath(); ctx.moveTo(pw[0][0], pw[0][1]);
    for (let i = 1; i < pw.length; i++) ctx.lineTo(pw[i][0], pw[i][1]);
    ctx.stroke();
    const p = el.pontas || {}, n = pw.length;
    if (p.fim !== 'nenhuma') cabeca(ctx, pw[n - 2], pw[n - 1], el);
    if (p.inicio === 'seta') cabeca(ctx, pw[1], pw[0], el);
  }
  function desenharSeta(ctx, el, info) {
    const angAntes = NUM(el.angulo);
    if (recalcular(el) && angAntes) N.redesenhar(); // o ctx veio girado pelo ângulo antigo: mais um quadro
    const P = el.pontos;
    if (!P || P.length < 2) return;
    tracar(ctx, el, P.map(([dx, dy]) => [el.x + dx, el.y + dy]));
    const z = (info && info.zoom) || 1;
    if (Ed && Ed.id === el.id) {
      ctx.save();
      if (NUM(el.angulo)) { const b = caixaPontos(el), cx = b.x + b.w / 2, cy = b.y + b.h / 2; ctx.translate(cx, cy); ctx.rotate(-el.angulo); ctx.translate(-cx, -cy); }
      desenharRealce(ctx, Ed.alvo, z);
      ctx.restore();
    }
    // Seta com vários pontos: o núcleo mostra a caixa; marcamos as pontas que podem ser arrastadas.
    if (info && info.selecionado && P.length > 2 && N.selecao().length === 1 && !N.travado(el)) {
      let cor = '#6366f1';
      try { cor = N.cores().acento || cor; } catch {}
      ctx.save(); ctx.globalAlpha = 1; ctx.setLineDash([]);
      for (const i of [0, P.length - 1]) {
        ctx.beginPath(); ctx.arc(el.x + P[i][0], el.y + P[i][1], 4.5 / z, 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 1.5 / z; ctx.strokeStyle = cor; ctx.stroke();
      }
      ctx.restore();
    }
  }
  function distPontos(el, px, py) {
    const P = el.pontos || [];
    if (P.length < 2) return Infinity;
    let m = Infinity;
    for (let i = 0; i < P.length - 1; i++) m = Math.min(m, distSeg(px, py, el.x + P[i][0], el.y + P[i][1], el.x + P[i + 1][0], el.y + P[i + 1][1]));
    return m;
  }
  W.registrarTipo('seta', {
    desenhar: desenharSeta,
    caixa: caixaPontos,
    testarClique: (el, px, py, tol) => distPontos(el, px, py) <= tol + larg(el) / 2,
  });

  // ── Ferramenta ──
  const ICONE = [['path', { d: 'M3.5 12.5 12.5 3.5' }], ['path', { d: 'M7 3.5h5.5V9' }]];
  // S: pontos no mundo, ligações das pontas (início fixo ao começar; fim pela posição atual), alvo sob o ponteiro.
  const S = { pts: null, cur: null, primeiro: false, arrastou: false, sx: 0, sy: 0, lsx: 0, lsy: 0, ini: null, pairar: null };
  const zerar = () => { S.pts = null; S.cur = null; S.primeiro = false; S.arrastou = false; S.ini = null; };
  function restringir(p, base) {
    if (!p.evento || !p.evento.shiftKey || !base) return [p.x, p.y];
    const dx = p.x - base[0], dy = p.y - base[1], len = Math.hypot(dx, dy);
    const ang = Math.round(Math.atan2(dy, dx) / PASSO_ANGULO) * PASSO_ANGULO;
    return [base[0] + len * Math.cos(ang), base[1] + len * Math.sin(ang)];
  }
  const ultimo = () => S.pts[S.pts.length - 1];
  function ligacaoEm(x, y, excluir) {
    const t = alvoEm(x, y, excluir);
    return t ? { id: t.id, foco: focoEm(t, x, y) } : null;
  }
  // Fim: não prende no mesmo alvo do início numa seta de 2 pontos.
  const excluirFim = (n) => (S.ini && n <= 2 ? [S.ini.id] : []);
  function montar(pts, fim) {
    let x0 = Infinity, y0 = Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); }
    const s = {
      tipo: 'seta', x: x0, y: y0, w: 0, h: 0, angulo: 0, ...estilo(), preenchimento: null,
      pontos: pts.map(([x, y]) => [x - x0, y - y0]),
      ligacoes: { inicio: S.ini ? { ...S.ini, foco: [...S.ini.foco] } : null, fim: fim || null },
      pontas: { inicio: 'nenhuma', fim: 'seta' },
    };
    gravar(s, pts);
    return s;
  }
  function finalizar(trocar) {
    const pts = (S.pts || []).filter((q, i, a) => !i || Math.hypot(q[0] - a[i - 1][0], q[1] - a[i - 1][1]) > 0.01);
    const fim = pts.length >= 2 ? ligacaoEm(pts[pts.length - 1][0], pts[pts.length - 1][1], excluirFim(pts.length)) : null;
    const ini = S.ini;
    zerar(); S.pairar = null;
    if (pts.length < 2) { N.redesenhar(); return; }
    S.ini = ini;
    const dados = montar(pts, fim);
    S.ini = null;
    const criado = N.adicionar(dados);
    for (const k of ['inicio', 'fim']) {
      const lig = criado.ligacoes && criado.ligacoes[k], t = alvoDe(lig);
      if (lig && !t) criado.ligacoes[k] = null;
      if (t && !(Array.isArray(t.ligacoes) && t.ligacoes.includes(criado.id))) N.atualizar(t.id, { ligacoes: (Array.isArray(t.ligacoes) ? t.ligacoes : []).concat(criado.id) });
    }
    recalcular(criado);
    if (trocar) { N.selecionar([criado.id]); N.definirFerramenta('selecionar'); }
    N.confirmar('criar seta');
  }
  function previa(ctx) {
    if (!S.pts || !S.cur) return;
    const pts = S.pts.concat([S.cur]);
    const c = N.camera();
    ctx.save();
    ctx.translate(-c.x * c.zoom, -c.y * c.zoom); ctx.scale(c.zoom, c.zoom);
    if (pts.length >= 2 && Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) + (pts.length - 2) > 0.01) {
      const fim = ligacaoEm(S.cur[0], S.cur[1], excluirFim(pts.length));
      const s = { ...montar(pts, fim), id: '_previa' };
      recalcular(s);
      ctx.globalAlpha = Math.max(0, Math.min(1, NUM(s.opacidade, 1)));
      tracar(ctx, s, pontosMundo(s));
      ctx.globalAlpha = 1;
      if (fim) desenharRealce(ctx, N.elemento(fim.id), c.zoom);
    }
    if (S.ini) desenharRealce(ctx, N.elemento(S.ini.id), c.zoom);
    ctx.restore();
  }
  W.registrarFerramenta('seta', {
    rotulo: 'Seta', icone: ICONE, tecla: 'a', ordem: 41, cursor: 'crosshair',
    aoDescer(p) {
      if (!S.pts) {
        S.pts = [[p.x, p.y]]; S.cur = [p.x, p.y]; S.primeiro = true; S.arrastou = false;
        S.sx = p.sx; S.sy = p.sy; S.lsx = p.sx; S.lsy = p.sy;
        S.ini = ligacaoEm(p.x, p.y);
        return;
      }
      if (Math.hypot(p.sx - S.lsx, p.sy - S.lsy) < 5) { finalizar(true); return; } // clique de novo no último ponto
      const q = restringir(p, ultimo());
      S.pts.push(q); S.cur = q;
      const t = N.mundoParaTela(q[0], q[1]); S.lsx = t.sx; S.lsy = t.sy;
    },
    aoMover(p) {
      if (!S.pts) return;
      if (S.primeiro && !S.arrastou && Math.hypot(p.sx - S.sx, p.sy - S.sy) >= 3) S.arrastou = true;
      if (S.primeiro && !S.arrastou) return;
      S.cur = restringir(p, ultimo());
    },
    aoSubir(p) {
      if (!S.pts || !S.primeiro) return;
      S.primeiro = false;
      if (S.arrastou) { S.pts.push(restringir(p, ultimo())); finalizar(true); }
    },
    aoPairar(p) {
      if (S.pts && !S.primeiro) { S.cur = restringir(p, ultimo()); N.redesenhar(); return; }
      const t = S.pts ? null : alvoEm(p.x, p.y);
      const id = t ? t.id : null;
      if (id !== S.pairar) { S.pairar = id; N.redesenhar(); }
    },
    aoTecla(e) {
      if (!S.pts || (e.key !== 'Enter' && e.key !== 'Escape')) return false;
      finalizar(true);
      return true;
    },
    aoCancelar() { if (S.primeiro) zerar(); },
    aoAtivar() { S.pairar = null; },
    aoDesativar() { if (S.pts) finalizar(false); S.pairar = null; },
    aoDesenhar(ctx) {
      if (!S.pts && S.pairar) {
        const c = N.camera(), t = N.elemento(S.pairar);
        if (!t) { S.pairar = null; return; }
        ctx.save(); ctx.translate(-c.x * c.zoom, -c.y * c.zoom); ctx.scale(c.zoom, c.zoom);
        desenharRealce(ctx, t, c.zoom);
        ctx.restore();
        return;
      }
      previa(ctx);
    },
  });

  // ── Editar a ponta de uma seta selecionada (assume o arrasto antes do núcleo) ──
  const palco = () => { const h = N.camadaHtml && N.camadaHtml(); return h ? h.parentElement : null; };
  function pontoDe(e) {
    const r = palco().getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    const m = N.telaParaMundo(sx, sy);
    return { sx, sy, x: m.x, y: m.y };
  }
  function pontaSob(e) {
    const pl = palco();
    if (!pl || !pl.contains(e.target) || e.target.closest('textarea, input, [contenteditable="true"], button')) return null;
    if (N.ferramenta() !== 'selecionar' || e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey) return null;
    const sel = N.selecao();
    if (sel.length !== 1) return null;
    const s = N.elemento(sel[0]);
    if (!ehSeta(s) || !s.pontos || s.pontos.length < 2 || N.travado(s)) return null;
    const p = pontoDe(e), pw = pontosMundo(s), n = pw.length;
    let melhor = null;
    for (const [k, idx] of [['inicio', 0], ['fim', n - 1]]) {
      const t = N.mundoParaTela(pw[idx][0], pw[idx][1]), d = Math.hypot(t.sx - p.sx, t.sy - p.sy);
      if (d <= RAIO_PONTA && (!melhor || d < melhor.d)) melhor = { k, idx, d };
    }
    return melhor ? { s, ...melhor, p } : null;
  }
  const copiar = (s) => ({ x: s.x, y: s.y, w: s.w, h: s.h, angulo: s.angulo, pontos: JSON.parse(JSON.stringify(s.pontos)), ligacoes: JSON.parse(JSON.stringify(ligacoesDe(s))) });
  function aoDescerCaptura(e) {
    if (Ed) return;
    const h = pontaSob(e);
    if (!h) return;
    e.stopPropagation(); e.preventDefault();
    try { palco().focus({ preventScroll: true }); } catch {}
    const L = ligacoesDe(h.s);
    Ed = { id: h.s.id, k: h.k, idx: h.idx, orig: copiar(h.s), moveu: false, alvo: alvoDe(L[h.k]), sx0: h.p.sx, sy0: h.p.sy, pid: e.pointerId };
    N.cursor('crosshair');
  }
  function aoMoverCaptura(e) {
    if (!Ed || e.pointerId !== Ed.pid) return;
    e.stopPropagation();
    const s = N.elemento(Ed.id);
    if (!s) { Ed = null; return; }
    const p = pontoDe(e);
    if (!Ed.moveu) { if (Math.hypot(p.sx - Ed.sx0, p.sy - Ed.sy0) < 2) return; Ed.moveu = true; }
    const pw = pontosMundo(s), n = pw.length, viz = pw[Ed.idx === 0 ? 1 : n - 2];
    const q = restringir({ x: p.x, y: p.y, evento: e }, viz);
    const L = ligacoesDe(s), outro = L[Ed.k === 'inicio' ? 'fim' : 'inicio'];
    const t = alvoEm(q[0], q[1], n <= 2 && outro ? [outro.id] : []);
    pw[Ed.idx] = q;
    delete s._sig;
    if (t) prender(s, Ed.k, t, focoEm(t, q[0], q[1])); else soltar(s, Ed.k);
    gravar(s, pw);
    recalcular(s);
    Ed.alvo = t;
    N.redesenhar();
  }
  function aoSubirCaptura(e) {
    if (!Ed || e.pointerId !== Ed.pid) { if (!Ed) recalcularTodas(); return; }
    e.stopPropagation();
    const ed = Ed; Ed = null;
    N.cursor(null);
    const s = N.elemento(ed.id);
    if (!s || !ed.moveu) { N.redesenhar(); return; }
    if (e.type === 'pointercancel') { restaurar(s, ed.orig); return; }
    N.atualizar(s.id, { x: s.x, y: s.y, w: s.w, h: s.h, angulo: s.angulo, pontos: s.pontos, ligacoes: s.ligacoes });
    N.confirmar(ligacoesDe(s)[ed.k] ? 'prender seta' : 'mover ponta');
  }
  function restaurar(s, o) {
    const L = ligacoesDe(s);
    for (const k of ['inicio', 'fim']) {
      const t = alvoDe(o.ligacoes[k]);
      if (t) prender(s, k, t, o.ligacoes[k].foco); else if (L[k]) soltar(s, k);
    }
    Object.assign(s, { x: o.x, y: o.y, w: o.w, h: o.h, angulo: o.angulo, pontos: o.pontos });
    delete s._sig;
    recalcular(s);
    N.redesenhar();
  }
  function aoTeclaCaptura(e) {
    if (!Ed || e.key !== 'Escape') return;
    e.stopPropagation(); e.preventDefault();
    const ed = Ed; Ed = null;
    N.cursor(null);
    const s = N.elemento(ed.id);
    if (s && ed.moveu) restaurar(s, ed.orig);
  }
  document.addEventListener('pointerdown', aoDescerCaptura, true);
  window.addEventListener('pointermove', aoMoverCaptura, true);
  window.addEventListener('pointerup', aoSubirCaptura, true);
  window.addEventListener('pointercancel', aoSubirCaptura, true);
  document.addEventListener('keydown', aoTeclaCaptura, true);

  // ── Evento de mudança do núcleo (protegido: sem ele, o desenho e o pointerup mantêm as pontas presas) ──
  function aoMudar(d) {
    if (!d) return;
    const tipo = d.tipo, ids = Array.isArray(d.ids) ? d.ids : [];
    if (tipo === 'carregar' || tipo === 'desfazer') { for (const el of N.elementos()) delete el._sig; reconciliar(); return; }
    if (tipo === 'remover' || tipo === 'adicionar') { reconciliar(); return; }
    recalcularAfetadas(ids);
  }
  try { if (typeof N.on === 'function') { N.on('mudanca', aoMudar); N.on('quadro', () => { Ed = null; zerar(); }); } } catch (e) { console.warn('whiteboard-setas: on', e); }

  const API = Object.freeze({
    reconciliar,
    recalcular: (id) => { const s = N.elemento(id); const m = s ? recalcular(s) : false; if (m) N.redesenhar(); return m; },
    recalcularTodas,
    alvoEm: (x, y) => { const t = alvoEm(x, y); return t ? t.id : null; },
  });
  window.WhiteboardSetas = API;
  W.estender('setas', API);
})();
