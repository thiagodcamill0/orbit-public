// Orbit — Whiteboard (etapa 5: times). Carregado depois de whiteboard-agentes.js. Contrato: whiteboard-etapa5.
// Quadro de time = tipo 'time' (canvas: fundo, borda e linhas líder → membros; HTML: só o cabeçalho "nome · N ativos"), sempre
// com o z mais baixo ao nascer, atrás dos cards. Elemento:
//   { tipo: 'time', x, y, w, h, time: { raiz, nome, removidos: ['s:<sessão>' | 'a:<subagente>', ...] } }
// Membros (cards dentro do quadro): cards 'agente' (etapa 4) com `time: { raiz }` e cards 'subagente' (subagente do Task, não é sessão):
//   { tipo: 'subagente', w: 220, h: 84, subagente: { id, sessao (dona), raiz, resumo: { tipo, descricao, status } }, time: { raiz } }
// A caixa do quadro é derivada: união dos membros + margem + cabeçalho, recalculada por mutação direta (sem passo de histórico) no
// desenho, na caixa (hit-test), em 'mudanca' e no pointerup — mesma técnica das pontas presas das setas. Por isso mover um card só
// faz o quadro se expandir/encolher para contê-lo; redimensionar/girar o quadro não tem efeito.
// Arrastar o quadro (cabeçalho ou borda): no pointerdown (captura) a seleção vira quadro + membros antes do núcleo, que move todos
// num passo só ('mover'); no pointerup a seleção volta a ser só o quadro. Setas do teclado: o mesmo, no keydown (captura).
// Apagar o quadro apaga os membros no mesmo passo (dentro do evento 'mudanca' remover, antes do confirmar). Apagar um membro com o
// quadro presente grava a chave em time.removidos (no mesmo passo) e o membro não volta sozinho.
// Ao vivo: window.OrbitFonteSessoes.time(id) lida na hora (pode faltar → o drop vira card solto da etapa 4). Escuta ligada com a
// vista visível e algum quadro/subagente no quadro. Membro/subagente novo entra sozinho (N.adicionar sem confirmar → sem passo de
// histórico; gravação marcada reaplicando a câmera, como na etapa 4). Publica Whiteboard.times (ver o fim do arquivo).
(() => {
  'use strict';
  const W = window.Whiteboard;
  if (!W || !W.registrarTipo || !W.nucleo) return;
  const N = W.nucleo;
  const PAD = 24, CAB = 44, GAP = 20, VAO = 56, COLS = 3, RAIO = 16, MIN_QW = 300;
  const AG_W = 260, AG_H = 120, SA_W = 220, SA_H = 84, SA_MIN_W = 180, SA_MIN_H = 72;
  const base = (() => { try { return document.currentScript && document.currentScript.src; } catch { return ''; } })();
  const sprite = (n) => { try { return new URL('sprites/sprite-' + n + '.gif', base || location.href).href; } catch { return 'assets/sprites/sprite-' + n + '.gif'; } };
  const SPRITE_FIM = sprite('sleep');
  const SPRITE_ST = { trabalhando: 'work', aguardando: 'needu', concluido: 'done', erro: 'sleep' };
  const ROTULO = { trabalhando: 'Trabalhando', aguardando: 'Aguardando', concluido: 'Concluído', erro: 'Erro', encerrado: 'Encerrado' };
  const reduzido = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  const h = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  // ── fonte (sempre lida na hora) ──
  const fonte = () => window.OrbitFonteSessoes || null;
  function lerTime(id) {
    const f = fonte();
    if (!f || typeof f.time !== 'function' || !id) return null;
    try { const t = f.time(id); return t && t.raiz ? t : null; } catch (e) { console.warn('whiteboard-times: time', e); return null; }
  }
  function obter(id) {
    const f = fonte();
    if (!f || typeof f.obter !== 'function' || !id) return null;
    try { return f.obter(id) || null; } catch { return null; }
  }
  function abrirConversa(id) {
    const f = fonte();
    if (!f || typeof f.abrir !== 'function' || !id) return false;
    try { f.abrir(id); return true; } catch (e) { console.warn('whiteboard-times: abrir', e); return false; }
  }

  // ── modelo ──
  const ehQuadro = (el) => !!el && el.tipo === 'time' && !!el.time && !!el.time.raiz;
  const ehSub = (el) => !!el && el.tipo === 'subagente' && !!el.subagente && !!el.subagente.id;
  const ehMembro = (el) => !!el && !!el.time && !!el.time.raiz && ((el.tipo === 'agente' && !!el.sessao && !!el.sessao.id) || ehSub(el));
  const chaveDe = (el) => (ehSub(el) ? 'a:' + el.subagente.id : 's:' + el.sessao.id);
  const quadros = () => N.elementos().filter(ehQuadro);
  const quadroDe = (raiz) => N.elementos().find((el) => ehQuadro(el) && el.time.raiz === raiz) || null;
  const membrosDe = (raiz) => N.elementos().filter((el) => ehMembro(el) && el.time.raiz === raiz);
  const liderDe = (raiz, ms = membrosDe(raiz)) => ms.find((m) => m.tipo === 'agente' && m.sessao.id === raiz) || null;
  const subs = () => N.elementos().filter(ehSub);
  const noDe = (id) => { const c = N.camadaHtml(); return c ? c.querySelector(`.wb-no[data-id="${CSS.escape(id)}"]`) : null; };
  const palco = () => { const c = N.camadaHtml(); return c ? c.closest('.wb-palco') : null; };

  // Cache do time() por raiz (renovado a cada sincronização). A raiz pode ser fantasma (time(raiz) → null): tenta pelos membros.
  const VIVO = new Map();
  function consultar(raiz) {
    const ids = [raiz];
    for (const m of membrosDe(raiz)) ids.push(ehSub(m) ? m.subagente.sessao : m.sessao.id);
    for (const id of new Set(ids)) { const t = lerTime(id); if (t && t.raiz === raiz) return t; }
    return null;
  }
  function timeDe(raiz) {
    if (!VIVO.has(raiz)) VIVO.set(raiz, consultar(raiz));
    return VIVO.get(raiz);
  }
  function entradas(t) {
    const out = [];
    if (t.lider) out.push({ chave: 's:' + (t.lider.id || t.raiz), tipo: 'lider', id: t.lider.id || t.raiz, r: t.lider });
    for (const m of Array.isArray(t.membros) ? t.membros : []) if (m && m.id) out.push({ chave: 's:' + m.id, tipo: 'membro', id: m.id, r: m });
    for (const s of Array.isArray(t.subagentes) ? t.subagentes : []) if (s && s.id) out.push({ chave: 'a:' + s.id, tipo: 'sub', id: s.id, r: s });
    return out;
  }

  // ── caixa derivada do quadro ──
  function encaixe(q) {
    const ms = membrosDe(q.time.raiz);
    if (!ms.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const m of ms) { const b = N.caixaMundo(m); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
    return { x: x0 - PAD, y: y0 - PAD - CAB, w: Math.max(MIN_QW, x1 - x0 + 2 * PAD), h: y1 - y0 + 2 * PAD + CAB };
  }
  function ajustar(q) {
    const b = encaixe(q);
    let mudou = false;
    if (b) for (const k of ['x', 'y', 'w', 'h']) if (Math.abs(q[k] - b[k]) > 0.01) { q[k] = b[k]; mudou = true; }
    if (q.angulo) { q.angulo = 0; mudou = true; }
    return mudou;
  }
  const ajustarTodos = () => { let m = false; for (const q of quadros()) if (ajustar(q)) m = true; return m; };

  // ── gravar sem passo de histórico (técnica da etapa 4: reaplicar a câmera atual) ──
  let marcaT = 0, marcando = false, ultCamera = 0;
  function agendarMarca(ms) {
    if (marcaT) return;
    marcaT = setTimeout(() => {
      marcaT = 0;
      if (!W.quadro()) return;
      if (performance.now() - ultCamera < 500) { agendarMarca(600); return; }
      marcando = true;
      try { N.definirCamera(N.camera(), { animar: false }); } finally { marcando = false; }
    }, ms);
  }

  // ── desenho do quadro (fundo, borda, linhas) ──
  const SURGIU = new Map(); // id do membro → início da animação da linha
  const DUR_LINHA = 520;
  let pedido = false;
  const pedir = () => { if (pedido) return; pedido = true; requestAnimationFrame(() => { pedido = false; N.redesenhar(); }); };
  const suave = (k) => 1 - Math.pow(1 - Math.max(0, Math.min(1, k)), 3);
  function caixaVista(q) {
    const alvo = { x: q.x, y: q.y, w: q.w, h: q.h };
    const v = q._vis;
    if (!v || !q._crescer || reduzido()) { q._vis = alvo; q._crescer = false; return alvo; }
    const n = {};
    let perto = true;
    for (const k of ['x', 'y', 'w', 'h']) { n[k] = v[k] + (alvo[k] - v[k]) * 0.2; if (Math.abs(alvo[k] - n[k]) > 0.5) perto = false; }
    if (perto) { q._vis = alvo; q._crescer = false; return alvo; }
    q._vis = n; pedir();
    return n;
  }
  function retang(ctx, b, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(b.x, b.y, b.w, b.h, r); else ctx.rect(b.x, b.y, b.w, b.h);
  }
  function desenharQuadro(ctx, q, info) {
    ajustar(q);
    const z = info.zoom || 1, b = caixaVista(q), agora = performance.now();
    ctx.save();
    retang(ctx, b, RAIO);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.026)'; ctx.fill();
    ctx.lineWidth = 1.25 / z; ctx.strokeStyle = info.selecionado ? 'rgba(255, 255, 255, 0.2)' : 'rgba(255, 255, 255, 0.1)'; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(b.x + RAIO, b.y + CAB); ctx.lineTo(b.x + b.w - RAIO, b.y + CAB);
    ctx.lineWidth = 1 / z; ctx.strokeStyle = 'rgba(255, 255, 255, 0.045)'; ctx.stroke();
    if (q._pulso) {
      const k = (agora - q._pulso) / 1300;
      if (k >= 1) q._pulso = 0;
      else { retang(ctx, b, RAIO); ctx.globalAlpha = 1 - k; ctx.lineWidth = (2 + 6 * Math.sin(Math.PI * Math.min(1, k * 1.6))) / z; ctx.strokeStyle = (N.cores && N.cores().acento) || '#6366f1'; ctx.stroke(); ctx.globalAlpha = 1; pedir(); }
    }
    ctx.restore();
    desenharLinhas(ctx, q, z, agora);
  }
  function linhasDe(q) {
    const ms = membrosDe(q.time.raiz), lid = liderDe(q.time.raiz, ms);
    if (!lid) return [];
    // Subagente liga na sessão dona quando o card dela está no quadro (hierarquia real; a linha não cruza o card do membro).
    const porSessao = new Map(ms.filter((m) => m.tipo === 'agente').map((m) => [m.sessao.id, m]));
    return ms.filter((m) => m !== lid).map((m) => ({ de: (ehSub(m) && porSessao.get(m.subagente.sessao)) || lid, para: m }));
  }
  function desenharLinhas(ctx, q, z, agora) {
    const ls = linhasDe(q);
    if (!ls.length) return;
    ctx.save();
    ctx.lineCap = 'round';
    for (const { de, para } of ls) {
      const lb = N.caixaMundo(de), mb = N.caixaMundo(para);
      const acima = mb.y + mb.h < lb.y;
      const x0 = lb.x + lb.w / 2, y0 = acima ? lb.y : lb.y + lb.h, x1 = mb.x + mb.w / 2, y1 = acima ? mb.y + mb.h : mb.y;
      const dy = Math.max(30, Math.abs(y1 - y0) * 0.5) * (acima ? -1 : 1);
      const t0 = SURGIU.get(para.id);
      let p = 1;
      if (t0 != null) { p = suave((agora - t0) / DUR_LINHA); if (p >= 1) SURGIU.delete(para.id); else pedir(); }
      const fim = ehSub(para) && /^(concluido|erro)$/.test(String((noDe(para.id) || {}).dataset?.status || ''));
      ctx.globalAlpha = (fim ? 0.5 : 1) * (0.35 + 0.65 * p);
      ctx.strokeStyle = ehSub(para) ? 'rgba(255, 255, 255, 0.13)' : 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 1.5 / z;
      ctx.setLineDash(ehSub(para) ? [5 / z, 4 / z] : []);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      const c1 = [x0, y0 + dy], c2 = [x1, y1 - dy];
      if (p >= 1) ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], x1, y1);
      else {
        const n = 28, ate = Math.max(1, Math.round(n * p));
        for (let i = 1; i <= ate; i++) {
          const t = i / n, u = 1 - t;
          ctx.lineTo(u * u * u * x0 + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * x1, u * u * u * y0 + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * y1);
        }
      }
      ctx.stroke();
      if (p >= 1) { ctx.setLineDash([]); ctx.beginPath(); ctx.arc(x1, y1, 2.5 / z, 0, Math.PI * 2); ctx.fillStyle = ctx.strokeStyle; ctx.fill(); }
    }
    ctx.restore();
  }

  // ── cabeçalho (HTML) ──
  function pintarQuadro(no, q) {
    if (!no || !q) return;
    const t = timeDe(q.time.raiz);
    const n = t ? Math.max(0, +t.ativos || 0) : null;
    const nome = q.time.nome || (t && t.nome) || 'Time';
    const txt = n == null ? 'Encerrado' : `${n} ${n === 1 ? 'ativo' : 'ativos'}`;
    const chave = nome + '\u0001' + txt;
    if (no._chave === chave) return;
    no._chave = chave;
    no.dataset.ativos = n == null ? '' : String(n);
    no.classList.toggle('wb-tm-vivo', !!n);
    const nm = no.querySelector('.wb-tm-nome');
    nm.textContent = nome; nm.title = nome;
    no.querySelector('.wb-tm-n').textContent = txt;
  }
  W.registrarTipo('time', {
    desenhar: desenharQuadro,
    caixa(el) { ajustar(el); return { x: el.x, y: el.y, w: el.w, h: el.h }; },
    // Só o cabeçalho e a borda pegam o clique; o miolo fica livre (laço, desenhar dentro).
    testarClique(el, px, py, tol) {
      const b = { x: el.x, y: el.y, w: el.w, h: el.h }, m = Math.max(tol, 8 / N.camera().zoom);
      if (px < b.x - m || px > b.x + b.w + m || py < b.y - m || py > b.y + b.h + m) return false;
      if (py <= b.y + CAB) return true;
      return px <= b.x + m || px >= b.x + b.w - m || py >= b.y + b.h - m;
    },
    html: {
      criar() {
        const no = h('div', 'wb-tm'), cab = h('div', 'wb-tm-cab'), at = h('span', 'wb-tm-ativos');
        at.append(h('i', 'wb-tm-ponto'), h('span', 'wb-tm-n'));
        cab.append(h('span', 'wb-tm-nome'), at);
        no.append(cab);
        return no;
      },
      atualizar(no, el) { pintarQuadro(no, el); },
    },
    editar(el) { focarQuadro(el, null, true); },
    aoRedimensionar(el) { const b = encaixe(el); return b || undefined; },
  });

  // ── card de subagente ──
  function sincronizarSub(el, s) {
    const novo = { tipo: String(s.tipo || ''), descricao: String(s.descricao || ''), status: String(s.status || '') };
    const a = el.subagente.resumo || {};
    if (a.tipo === novo.tipo && a.descricao === novo.descricao && a.status === novo.status) return;
    el.subagente = { ...el.subagente, resumo: novo }; // mutação silenciosa (decisão 4 da etapa 4)
    agendarMarca(1200);
  }
  function dadosSub(el) {
    const sa = el.subagente, t = timeDe(sa.raiz || (el.time && el.time.raiz));
    const s = t && Array.isArray(t.subagentes) ? t.subagentes.find((x) => x && x.id === sa.id) || null : null;
    if (s) sincronizarSub(el, s);
    const res = el.subagente.resumo || {};
    if (!s) return { vivo: false, tipo: res.tipo || 'Subagente', desc: res.descricao || '', status: 'encerrado', stTexto: ROTULO.encerrado, sprite: SPRITE_FIM, ativ: '', s: null, t };
    const st = String(s.status || '');
    return { vivo: true, tipo: s.tipo || res.tipo || 'Subagente', desc: s.descricao || res.descricao || '', status: st, stTexto: s.statusTexto || ROTULO[st] || st, sprite: s.sprite || sprite(SPRITE_ST[st] || 'think'), ativ: s.atividade || '', s, t };
  }
  function montarSub() {
    const no = h('div', 'wb-sa'), c = h('div', 'wb-sa-c'), topo = h('div', 'wb-sa-topo'), id = h('span', 'wb-sa-ident');
    id.append(h('span', 'wb-sa-tipo'), h('span', 'wb-sa-desc'));
    topo.append(h('span', 'wb-sa-spr'), id);
    const linha = h('div', 'wb-sa-linha'), st = h('span', 'wb-sa-st');
    st.append(h('i', 'wb-sa-ponto'), h('span', 'wb-sa-st-t'));
    linha.append(st, h('span', 'wb-sa-ativ'));
    c.append(topo, linha);
    no.append(c);
    return no;
  }
  function trocarSprite(no, url) {
    const caixa = no.querySelector('.wb-sa-spr');
    if (!caixa || no.dataset.sprite === url) return;
    no.dataset.sprite = url;
    const img = new Image();
    img.className = 'wb-sa-img'; img.alt = ''; img.draggable = false; img.decoding = 'async'; img.src = url;
    caixa.textContent = ''; caixa.append(img);
  }
  function pintarSub(no, el) {
    if (!no || !el) return;
    const d = dadosSub(el);
    const chave = [d.vivo, d.tipo, d.desc, d.status, d.stTexto, d.sprite, d.ativ].join('\u0001');
    if (no._chave === chave) return;
    no._chave = chave;
    no.dataset.status = d.status; no.dataset.vivo = d.vivo ? '1' : '0';
    no.classList.toggle('wb-sa-fim', !d.vivo || d.status === 'concluido' || d.status === 'erro');
    const q = (s) => no.querySelector(s);
    q('.wb-sa-tipo').textContent = d.tipo; q('.wb-sa-tipo').title = d.tipo;
    q('.wb-sa-desc').textContent = d.desc; q('.wb-sa-desc').title = d.desc;
    q('.wb-sa-st-t').textContent = d.stTexto;
    q('.wb-sa-ativ').textContent = d.ativ; q('.wb-sa-ativ').title = d.ativ;
    trocarSprite(no, d.sprite);
  }
  W.registrarTipo('subagente', {
    html: {
      criar() { return montarSub(); },
      atualizar(no, el) { pintarSub(no, el); no.classList.toggle('wb-sa-sel', N.selecao().includes(el.id)); },
    },
    editar(el) { fecharPop(); abrirConversa(el.subagente && el.subagente.sessao); },
    aoRedimensionar(el, campos) {
      const w = campos && campos.w != null ? campos.w : el.w, hh = campos && campos.h != null ? campos.h : el.h, aj = {};
      if (Math.abs(w) < SA_MIN_W) aj.w = w < 0 ? -SA_MIN_W : SA_MIN_W;
      if (Math.abs(hh) < SA_MIN_H) aj.h = hh < 0 ? -SA_MIN_H : SA_MIN_H;
      return Object.keys(aj).length ? aj : undefined;
    },
  });
  function pintarTodos() {
    for (const el of N.elementos()) {
      if (ehSub(el)) { const no = noDe(el.id); if (no) { no._chave = ''; pintarSub(no, el); } }
      else if (ehQuadro(el)) { const no = noDe(el.id); if (no) { no._chave = ''; pintarQuadro(no, el); } }
    }
    if (POP.id) preencherPop();
    N.redesenhar();
  }
  function marcarSelecao() {
    const sel = new Set(N.selecao());
    for (const el of subs()) { const no = noDe(el.id); if (no) no.classList.toggle('wb-sa-sel', sel.has(el.id)); }
  }

  // ── criar cards e o quadro ──
  function entrar(id, tentativa = 0) {
    if (reduzido()) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const no = noDe(id);
      if (!no) { if (tentativa < 3) entrar(id, tentativa + 1); return; }
      no.classList.remove('wb-tm-entra'); void no.offsetWidth; no.classList.add('wb-tm-entra');
      clearTimeout(no._eT); no._eT = setTimeout(() => no.classList.remove('wb-tm-entra'), 600);
    }));
  }
  function criarCard(e, raiz, pos, animar) {
    const comum = { angulo: 0, cor: '#e5e5e5', traco: { largura: 2, estilo: 'solido' }, preenchimento: null, opacidade: 1, time: { raiz } };
    let el;
    if (e.tipo === 'sub') {
      const s = e.r;
      el = N.adicionar({ tipo: 'subagente', x: pos.x, y: pos.y, w: SA_W, h: SA_H, ...comum, subagente: { id: e.id, sessao: String(s.sessao || raiz), raiz, resumo: { tipo: String(s.tipo || ''), descricao: String(s.descricao || ''), status: String(s.status || '') } } });
    } else {
      const r = e.r || {};
      el = N.adicionar({ tipo: 'agente', x: pos.x, y: pos.y, w: AG_W, h: AG_H, ...comum, sessao: { id: e.id, resumo: { nome: String(r.nome || ''), projeto: String(r.projeto || ''), status: String(r.status || '') } } });
    }
    if (animar) { SURGIU.set(el.id, performance.now()); entrar(el.id); }
    return el;
  }
  function layoutInicial(ents, cx, cy) {
    const lid = ents.find((e) => e.tipo === 'lider'), mem = ents.filter((e) => e.tipo === 'membro'), sas = ents.filter((e) => e.tipo === 'sub');
    const larg = (n, w) => (n ? Math.min(COLS, n) * w + (Math.min(COLS, n) - 1) * GAP : 0);
    const gw = Math.max(lid ? AG_W : 0, larg(mem.length, AG_W), larg(sas.length, SA_W));
    const pos = new Map();
    let y = 0;
    if (lid) { pos.set(lid.chave, { x: gw / 2 - AG_W / 2, y: 0 }); y = AG_H + VAO; }
    const linhas = (lista, w, hh) => {
      for (let i = 0; i < lista.length; i += COLS) {
        const fila = lista.slice(i, i + COLS), fw = larg(fila.length, w);
        fila.forEach((e, j) => pos.set(e.chave, { x: (gw - fw) / 2 + j * (w + GAP), y }));
        y += hh + GAP;
      }
    };
    linhas(mem, AG_W, AG_H);
    if (mem.length && sas.length) y += GAP;
    linhas(sas, SA_W, SA_H);
    const dx = cx - gw / 2, dy = cy - (lid ? AG_H / 2 : 0);
    for (const p of pos.values()) { p.x += dx; p.y += dy; }
    return pos;
  }
  // Vaga para um membro novo: primeira posição da grade (abaixo do líder) que não encosta em nenhum card do time.
  function vaga(q, tipo) {
    const raiz = q.time.raiz, ms = membrosDe(raiz), lid = liderDe(raiz, ms), outros = ms.filter((m) => m !== lid);
    const caixas = ms.map((m) => N.caixaMundo(m));
    const w = tipo === 'sub' ? SA_W : AG_W, hh = tipo === 'sub' ? SA_H : AG_H;
    const lb = lid && N.caixaMundo(lid);
    const x0 = outros.length ? Math.min(...outros.map((m) => N.caixaMundo(m).x)) : lb ? lb.x + lb.w / 2 - w / 2 : q.x + PAD;
    const y0 = lb ? lb.y + lb.h + VAO : outros.length ? Math.min(...outros.map((m) => N.caixaMundo(m).y)) : q.y + CAB + PAD;
    const livre = (x, y) => caixas.every((b) => x + w + GAP / 2 <= b.x || x >= b.x + b.w + GAP / 2 || y + hh + GAP / 2 <= b.y || y >= b.y + b.h + GAP / 2);
    for (let r = 0; r < 400; r++) for (let c = 0; c < COLS; c++) { const x = x0 + c * (w + GAP), y = y0 + r * (hh + GAP); if (livre(x, y)) return { x, y }; }
    return { x: x0, y: y0 };
  }
  function criarTime(t, cx, cy) {
    VIVO.set(t.raiz, t);
    const ents = entradas(t), pos = layoutInicial(ents, cx, cy);
    const zMin = N.elementos().reduce((m, el) => Math.min(m, el.z), Infinity);
    const q = N.adicionar({ tipo: 'time', x: cx - MIN_QW / 2, y: cy - CAB, w: MIN_QW, h: CAB + 2 * PAD, angulo: 0, cor: '#e5e5e5', traco: { largura: 1, estilo: 'solido' }, preenchimento: null, opacidade: 1,
      z: Number.isFinite(zMin) ? zMin - 1 : 0, time: { raiz: t.raiz, nome: String(t.nome || (t.lider && t.lider.nome) || ''), removidos: [] } });
    for (const e of ents) {
      const p = pos.get(e.chave);
      // Card solto (etapa 4) da mesma sessão, fora de qualquer time: entra no quadro em vez de duplicar.
      const solto = e.tipo !== 'sub' && N.elementos().find((el) => el.tipo === 'agente' && el.sessao && el.sessao.id === e.id && !N.travado(el) && !(el.time && quadroDe(el.time.raiz)));
      if (solto) { N.atualizar(solto.id, { x: p.x, y: p.y, w: AG_W, h: AG_H, angulo: 0, time: { raiz: t.raiz } }); SURGIU.set(solto.id, performance.now()); }
      else criarCard(e, t.raiz, p, true);
    }
    ajustar(q); q._vis = null;
    indexar();
    if (N.ferramenta() !== 'selecionar') N.definirFerramenta('selecionar');
    N.selecionar([q.id]);
    N.confirmar('adicionar time');
    revisarEscuta();
    return q;
  }
  function destacar(id) {
    const no = id && noDe(id);
    if (!no) return;
    no.classList.remove('wb-ag-destaque'); void no.offsetWidth; no.classList.add('wb-ag-destaque');
    clearTimeout(no._dT); no._dT = setTimeout(() => no.classList.remove('wb-ag-destaque'), 1400);
  }
  function focarQuadro(q, sessaoId, caber) {
    if (!q) return null;
    ajustar(q);
    const b = N.caixaMundo(q), t = N.tamanho(), cam = N.camera();
    let z = cam.zoom;
    const zf = Math.min(t.w / (b.w + 96), t.h / (b.h + 96));
    if (caber || zf < z) z = Math.max(0.1, Math.min(caber ? 1 : z, zf));
    N.selecionar([q.id]);
    N.definirCamera({ x: b.x + b.w / 2 - t.w / 2 / z, y: b.y + b.h / 2 - t.h / 2 / z, zoom: z }, { animar: true });
    q._pulso = performance.now();
    N.redesenhar();
    if (sessaoId) { const c = membrosDe(q.time.raiz).find((m) => m.tipo === 'agente' && m.sessao.id === sessaoId); if (c) requestAnimationFrame(() => destacar(c.id)); }
    return q;
  }
  // Drop de uma sessão (chamado por whiteboard-agentes.js): true = tratou (criou o time ou focou o existente).
  function soltar(id, x, y) {
    id = String(id || '').trim();
    if (!id || !W.quadro()) return false;
    const t = lerTime(id);
    if (!t) return false;
    const ex = quadroDe(t.raiz);
    if (ex) { focarQuadro(ex, id); return true; }
    const temTime = (Array.isArray(t.membros) && t.membros.length > 0) || (Array.isArray(t.subagentes) && t.subagentes.length > 0);
    if (!temTime) return false;
    criarTime(t, x, y);
    return true;
  }

  // ── sincronização ao vivo ──
  function sincronizar(q) {
    const raiz = q.time.raiz, t = consultar(raiz);
    VIVO.set(raiz, t);
    if (!t) return false;
    let mudou = false;
    const nome = String(t.nome || '');
    if (nome && nome !== q.time.nome) { q.time = { ...q.time, nome }; mudou = true; }
    const rem = new Set(q.time.removidos || []), tem = new Set(membrosDe(raiz).map(chaveDe));
    for (const e of entradas(t)) {
      if (tem.has(e.chave) || rem.has(e.chave)) continue;
      criarCard(e, raiz, vaga(q, e.tipo === 'sub' ? 'sub' : 'sessao'), true);
      tem.add(e.chave);
      q._crescer = true;
      mudou = true;
    }
    ajustar(q);
    return mudou;
  }
  let sincT = 0;
  function sincronizarTodos() {
    if (!W.quadro()) return;
    VIVO.clear();
    let mudou = false;
    for (const q of quadros()) if (sincronizar(q)) mudou = true;
    indexar();
    pintarTodos();
    if (mudou) agendarMarca(1200);
  }
  const agendarSinc = () => { if (!sincT) sincT = setTimeout(() => { sincT = 0; sincronizarTodos(); }, 0); };

  let desligar = null, visivel = false;
  function revisarEscuta() {
    const quer = visivel && N.elementos().some((el) => ehQuadro(el) || ehSub(el));
    if (quer && !desligar) {
      const f = fonte();
      if (!f || typeof f.ouvir !== 'function') return;
      try { const d = f.ouvir(() => agendarSinc()); desligar = typeof d === 'function' ? d : () => {}; } catch (e) { console.warn('whiteboard-times: ouvir', e); return; }
      agendarSinc(); // eventos perdidos enquanto desligado
    } else if (!quer && desligar) {
      try { desligar(); } catch {}
      desligar = null;
    }
  }

  // ── índice id → { raiz, chave, quadro } (o evento 'remover' só traz ids) ──
  let REG = new Map();
  function indexar() {
    const m = new Map();
    for (const el of N.elementos()) {
      if (ehQuadro(el)) m.set(el.id, { raiz: el.time.raiz, quadro: true });
      else if (ehMembro(el)) m.set(el.id, { raiz: el.time.raiz, chave: chaveDe(el) });
    }
    REG = m;
  }
  function aoRemover(ids) {
    const foraQ = new Set(), porQ = new Map();
    for (const id of ids) {
      const inf = REG.get(id);
      if (!inf) continue;
      if (inf.quadro) foraQ.add(inf.raiz);
      else { if (!porQ.has(inf.raiz)) porQ.set(inf.raiz, []); porQ.get(inf.raiz).push(inf.chave); }
    }
    for (const raiz of foraQ) {
      if (quadroDe(raiz)) continue; // havia outro quadro do mesmo time
      const todosM = membrosDe(raiz), ms = todosM.filter((m) => !N.travado(m)).map((m) => m.id);
      for (const m of todosM) if (N.travado(m)) N.atualizar(m.id, { time: null }); // travado não é apagado: sai do time
      if (ms.length) N.remover(ms); // mesmo passo: ainda antes do confirmar de quem apagou
    }
    for (const [raiz, chaves] of porQ) {
      if (foraQ.has(raiz)) continue;
      const q = quadroDe(raiz);
      if (!q) continue;
      q.time = { ...q.time, removidos: [...new Set([...(q.time.removidos || []), ...chaves])] };
    }
  }
  function aoAdicionar(ids) {
    for (const id of ids) {
      const el = N.elemento(id);
      if (ehQuadro(el) && N.elementos().some((o) => o !== el && ehQuadro(o) && o.time.raiz === el.time.raiz)) { N.remover([el.id]); continue; } // cópia de um quadro que já existe
      if (ehMembro(el)) {
        const k = chaveDe(el);
        if (N.elementos().some((o) => o !== el && ehMembro(o) && o.time.raiz === el.time.raiz && chaveDe(o) === k)) el.time = null; // cópia de um membro: vira card solto
      }
    }
  }

  // ── popover de detalhes do subagente (mesmo visual do .wb-ag-pop da etapa 4) ──
  const POP = { no: null, id: null };
  function relativo(ms) {
    const t = +ms;
    if (!Number.isFinite(t) || t <= 0) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 45) return 'agora';
    const m = Math.round(s / 60);
    if (m < 60) return `há ${m} min`;
    const hr = Math.round(m / 60);
    return hr < 24 ? `há ${hr} h` : `há ${Math.round(hr / 24)} d`;
  }
  function duracao(a, b) {
    const d = Math.round((+b - +a) / 1000);
    if (!Number.isFinite(d) || d < 0) return '';
    return d < 60 ? `${d} s` : d < 3600 ? `${Math.round(d / 60)} min` : `${Math.round(d / 360) / 10} h`;
  }
  function preencherPop() {
    const el = POP.id && N.elemento(POP.id);
    if (!ehSub(el) || !POP.no) { fecharPop(); return; }
    const d = dadosSub(el), p = POP.no, s = d.s;
    p.dataset.vivo = d.vivo ? '1' : '0';
    p.querySelector('.wb-ag-pop-nome').textContent = d.tipo;
    p.querySelector('.wb-ag-pop-proj').textContent = d.desc;
    const dl = p.querySelector('dl');
    dl.textContent = '';
    const linha = (rot, val) => { if (val != null && val !== '') dl.append(h('dt', null, rot), h('dd', null, String(val))); };
    const st = h('dd', 'wb-ag-pop-st'); st.dataset.status = d.status; st.append(h('i', 'wb-sa-ponto'), document.createTextNode(d.stTexto));
    dl.append(h('dt', null, 'Status'), st);
    const dona = obter(el.subagente.sessao);
    linha('Sessão', dona ? dona.nome : '');
    if (s) {
      linha('Atividade', s.atividade);
      linha('Início', relativo(s.inicio));
      if (s.fim) linha('Duração', duracao(s.inicio, s.fim));
    } else linha('Detalhe', 'O subagente não aparece mais na sessão; mostrando o último resumo guardado.');
    p.querySelector('.wb-ag-pop-abrir').disabled = !fonte();
    posicionarPop();
  }
  function posicionarPop() {
    const el = POP.id && N.elemento(POP.id), p = POP.no;
    if (!el || !p) return;
    const b = N.caixaMundo(el), t = N.tamanho();
    const a = N.mundoParaTela(b.x + b.w / 2, b.y + b.h), topo = N.mundoParaTela(b.x, b.y);
    const pw = p.offsetWidth || 260, ph = p.offsetHeight || 160, m = 8;
    let left = a.sx - pw / 2, top = a.sy + m;
    if (top + ph > t.h - m && topo.sy - m - ph >= m) { top = topo.sy - m - ph; p.dataset.lado = 'cima'; } else p.dataset.lado = 'baixo';
    p.style.left = Math.round(Math.max(m, Math.min(t.w - pw - m, left))) + 'px';
    p.style.top = Math.round(Math.max(m, Math.min(t.h - ph - m, top))) + 'px';
  }
  function abrirPop(id) {
    const pl = palco(), el = N.elemento(id);
    if (!pl || !ehSub(el)) return false;
    if (!POP.no) {
      const p = h('div', 'wb-ag-pop wb-tm-pop');
      p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'Detalhes do subagente');
      const cab = h('div', 'wb-ag-pop-cab');
      cab.append(h('span', 'wb-ag-pop-nome'), h('span', 'wb-ag-pop-proj'));
      const bt = h('button', 'wb-ag-pop-abrir', 'Abrir conversa');
      bt.type = 'button';
      bt.addEventListener('click', () => { const e = N.elemento(POP.id); if (ehSub(e)) { abrirConversa(e.subagente.sessao); fecharPop(); } });
      p.append(cab, h('dl'), bt);
      for (const t of ['pointerdown', 'dblclick', 'wheel', 'dragover']) p.addEventListener(t, (e) => e.stopPropagation());
      POP.no = p;
    }
    POP.id = id;
    if (POP.no.parentNode !== pl) pl.append(POP.no);
    preencherPop();
    return true;
  }
  function fecharPop() { POP.id = null; if (POP.no && POP.no.parentNode) POP.no.remove(); }
  document.addEventListener('pointerdown', (e) => { if (POP.no && POP.id && !POP.no.contains(e.target)) fecharPop(); }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && POP.id) { e.preventDefault(); e.stopPropagation(); fecharPop(); return; }
    // Setas do teclado com um quadro selecionado: o time inteiro se move (a seleção é ampliada só durante o evento).
    if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
    ampliarSelecao();
  }, true);

  // Seleção = quadro(s) + todos os membros (o núcleo move tudo junto); devolve a seleção original para restaurar depois.
  let ampliada = null;
  function ampliarSelecao() {
    const sel = N.selecao(), extra = [];
    for (const id of sel) { const el = N.elemento(id); if (ehQuadro(el) && !N.travado(el)) for (const m of membrosDe(el.time.raiz)) if (!sel.includes(m.id) && !extra.includes(m.id)) extra.push(m.id); }
    if (!extra.length) return false;
    const todos = [...sel, ...extra];
    N.selecionar(todos);
    ampliada = { antes: sel, todos };
    setTimeout(restaurarSelecao, 0);
    return true;
  }
  function restaurarSelecao() {
    if (!ampliada || W.nucleo.ferramenta() !== 'selecionar') { ampliada = null; return; }
    if (arrastando) return; // volta no pointerup
    const atual = N.selecao(), a = ampliada;
    ampliada = null;
    if (atual.length === a.todos.length && a.todos.every((id) => atual.includes(id))) N.selecionar(a.antes.filter((id) => N.elemento(id)));
  }

  // ── palco: arrastar o quadro, clique no subagente, visibilidade ──
  let ligado = null, arrastando = false;
  // Perto de uma alça (cantos/meios da caixa, que é a mesma da seleção ampliada): não amplia, senão o núcleo redimensionaria o time.
  function pertoDeAlca(q, sx, sy) {
    const b = N.caixaMundo(q), xs = [b.x, b.x + b.w / 2, b.x + b.w], ys = [b.y, b.y + b.h / 2, b.y + b.h];
    for (const x of xs) for (const y of ys) { const t = N.mundoParaTela(x, y); if (Math.abs(t.sx - sx) <= 10 && Math.abs(t.sy - sy) <= 10) return true; }
    return false;
  }
  function ligarPalco() {
    const pl = palco();
    if (!pl || ligado === pl) return;
    ligado = pl;
    let toque = null;
    pl.addEventListener('pointerdown', (e) => {
      toque = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
      if (e.button !== 0 || N.ferramenta() !== 'selecionar' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const r = pl.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, m = N.telaParaMundo(sx, sy);
      const alvo = N.elementoEm(m.x, m.y);
      if (!ehQuadro(alvo) || pertoDeAlca(alvo, sx, sy)) return;
      if (!N.selecao().includes(alvo.id)) N.selecionar([alvo.id]);
      arrastando = true;
      ampliarSelecao();
    }, true);
    const subir = (e) => {
      ajustarTodos();
      if (arrastando) { arrastando = false; setTimeout(restaurarSelecao, 0); }
      const t = toque; toque = null;
      if (!t || e.type !== 'pointerup' || e.button !== 0 || Math.hypot(e.clientX - t.x, e.clientY - t.y) > 4 || N.ferramenta() !== 'selecionar') return;
      const r = pl.getBoundingClientRect(), m = N.telaParaMundo(e.clientX - r.left, e.clientY - r.top);
      setTimeout(() => {
        const s = N.selecao(), alvo = N.elementoEm(m.x, m.y);
        if (s.length === 1 && alvo && alvo.id === s[0] && ehSub(alvo)) abrirPop(alvo.id);
      }, 0);
    };
    window.addEventListener('pointerup', subir, true);
    window.addEventListener('pointercancel', subir, true);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((es) => { const v = es.some((x) => x.isIntersecting); if (v !== visivel) { visivel = v; if (!v) fecharPop(); revisarEscuta(); } }).observe(pl);
    } else { visivel = true; revisarEscuta(); }
  }

  N.on('quadro', () => { fecharPop(); VIVO.clear(); SURGIU.clear(); indexar(); ligarPalco(); revisarEscuta(); if (desligar) agendarSinc(); requestAnimationFrame(marcarSelecao); });
  N.on('camera', () => { if (marcando) return; ultCamera = performance.now(); if (POP.id) fecharPop(); });
  N.on('selecao', (ids) => { if (POP.id && !(ids.length === 1 && ids[0] === POP.id)) fecharPop(); requestAnimationFrame(marcarSelecao); });
  N.on('mudanca', (d) => {
    const ids = (d && d.ids) || [], tipo = d && d.tipo;
    if (tipo === 'remover') aoRemover(ids);
    else if (tipo === 'adicionar') aoAdicionar(ids);
    indexar();
    ajustarTodos();
    if (POP.id && (ids.includes(POP.id) || !N.elemento(POP.id))) fecharPop();
    if (tipo === 'carregar' || tipo === 'desfazer') { VIVO.clear(); if (desligar) agendarSinc(); }
    if (tipo !== 'atualizar') revisarEscuta();
    requestAnimationFrame(marcarSelecao);
  });
  ligarPalco();

  const resumoEl = (m) => { const b = N.caixaMundo(m); return { id: m.id, tipo: m.tipo, chave: chaveDe(m), sessao: ehSub(m) ? m.subagente.sessao : m.sessao.id, subagente: ehSub(m) ? m.subagente.id : null, x: b.x, y: b.y, w: b.w, h: b.h }; };
  W.estender('times', Object.freeze({
    soltar: (id, x, y) => soltar(id, +x || 0, +y || 0),
    adicionar: (id, x, y) => { if (!soltar(id, +x || 0, +y || 0)) return null; const t = lerTime(id), q = t && quadroDe(t.raiz); return q ? q.id : null; },
    quadros: () => quadros().map((q) => {
      ajustar(q);
      const t = timeDe(q.time.raiz);
      return { id: q.id, raiz: q.time.raiz, nome: q.time.nome, removidos: [...(q.time.removidos || [])], ativos: t ? +t.ativos || 0 : null, total: t ? +t.total || 0 : null, x: q.x, y: q.y, w: q.w, h: q.h, membros: membrosDe(q.time.raiz).map(resumoEl) };
    }),
    linhas: (raiz) => { const q = quadroDe(raiz); return q ? linhasDe(q).map((l) => ({ de: l.de.id, para: l.para.id, animando: SURGIU.has(l.para.id) })) : []; },
    subagentes: () => subs().map((el) => { const no = noDe(el.id), b = N.caixaMundo(el); return { id: el.id, subagente: el.subagente.id, sessao: el.subagente.sessao, raiz: el.subagente.raiz, time: el.time ? el.time.raiz : null, resumo: { ...(el.subagente.resumo || {}) }, vivo: no ? no.dataset.vivo === '1' : null, status: no ? no.dataset.status : null, esmaecido: no ? no.classList.contains('wb-sa-fim') : null, x: b.x, y: b.y, w: b.w, h: b.h }; }),
    focar: (id) => { const el = N.elemento(id); const q = ehQuadro(el) ? el : quadroDe(id) || (() => { const t = lerTime(id); return t && quadroDe(t.raiz); })(); return focarQuadro(q, id) ? q.id : null; },
    detalhes: (id) => abrirPop(id),
    fecharDetalhes: fecharPop,
    detalhesAbertos: () => POP.id,
    sincronizar: () => sincronizarTodos(),
    ouvindo: () => !!desligar,
  }));
})();
