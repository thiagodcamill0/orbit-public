// Orbit — Whiteboard (etapa 1 de 6: a base). window.Whiteboard.
// Canvas infinito próprio (decisão de 2026-10-21; Excalidraw, MIT, só como referência de técnica; tldraw proibido).
// Um <canvas> 2D desenha as formas (devicePixelRatio; redesenho por requestAnimationFrame só quando sujo) e uma camada
// HTML por cima, transformada pela mesma câmera, recebe o que precisa de DOM (cards de agentes, edição de texto).
// Servidor: whiteboard.mjs (contrato "Whiteboard"). Ligação no index.html: item da lateral, <section id="whiteboard">,
// e a ponte em mostrarVista / provedor de abas (Whiteboard.entrar ao abrir, Whiteboard.sair ao sair).
//
// ── Formato de um elemento (o servidor não interpreta; quem define é este arquivo) ──────────────────────────────
//   { id, tipo, x, y, w, h, angulo, cor, traco, preenchimento, opacidade, grupo, z, pontos, texto, ligacoes, sessao }
//   id             texto único no quadro ('e' + aleatório)
//   tipo           nome registrado com registrarTipo ('retangulo', ...). Tipo desconhecido é preservado e aparece
//                  como caixa tracejada.
//   x, y, w, h     caixa no mundo (1 unidade = 1 px a 100%); (x, y) = canto superior esquerdo antes da rotação.
//                  Em linhas/setas/mão livre é a caixa dos pontos (manter atualizada ao editar os pontos).
//   angulo         radianos, em torno do centro da caixa
//   cor            cor do traço e do texto (CSS)
//   traco          { largura, estilo: 'solido' | 'tracejado' | 'pontilhado' } (largura em unidades do mundo)
//   preenchimento  null | cor CSS
//   opacidade      0..1
//   grupo          null | id do grupo (um nível; clicar num membro seleciona o grupo)
//   z              ordem de pintura (maior por cima); a lista fica sempre ordenada por z
//   pontos         null | [[dx, dy], ...] relativos a (x, y) — mover o elemento é só mudar x, y
//   texto          null | { valor, tamanho, alinhar: 'esquerda' | 'centro' | 'direita' }
//   ligacoes       linha/seta: { inicio: { id } | null, fim: { id } | null }; outras formas: [ids das setas presas] | null
//   sessao         null | { id, resumo: { nome, projeto, status } } — card de agente (etapa 4). O resumo só é usado
//                  quando a sessão não existe mais em est.sessoes; enquanto existir, os dados vêm sempre ao vivo.
//   Campos com prefixo "_" são só de execução e não vão para o servidor. _esmaecer = true: o render desenha o elemento a 25% da opacidade (borracha).
//
// ── Câmera ── { x, y, zoom }: (x, y) = ponto do mundo no canto superior esquerdo da vista.
//   tela = (mundo − cam) × zoom   ·   mundo = tela / zoom + cam   ·   zoom de 0,1 (10%) a 8 (800%).
//
// ── Partes deste arquivo ── 1 utilidades/ícones · 2 estado e modelo · 3 câmera · 4 render · 5 entrada ·
//   6 persistência · 7 interface (cabeçalho, painel de quadros, diálogo, barra, zoom) · 8 tipos e ferramentas padrão · 9 API.
//
// ── Extensão (etapas 2–6) ──
//   registrarTipo(nome, { desenhar(ctx, el, info), testarClique?(el, px, py, tol), caixa?(el),
//                         html?: { criar(el, nucleo) → HTMLElement, atualizar?(no, el, nucleo), remover?(no, el) } })
//     desenhar: ctx já no espaço do mundo, com a rotação do elemento aplicada; info = { zoom, nucleo, selecionado }.
//       Tipo só com `html` (sem desenhar) não passa pelo canvas: vira um nó na camada HTML (left/top 0, transform com
//       x, y e angulo, width/height = w/h, z-index pela ordem). A camada HTML fica sempre acima do canvas.
//     testarClique: ponto já no referencial do elemento (rotação desfeita); tol em unidades do mundo.
//     caixa: {x, y, w, h} sem rotação (padrão: x, y, w, h normalizados); o núcleo gira e faz a caixa do mundo.
//   registrarFerramenta(nome, { rotulo, icone: [[tag, attrs], ...] | nome de ícone daqui, tecla, ordem, separarAntes,
//                               cursor, arrastaCamera, aoAtivar, aoDesativar, aoDescer(p), aoMover(p), aoSubir(p),
//                               aoPairar(p), aoCancelar(), aoTecla(e, nucleo) → true se tratou, aoDesenhar(ctx, nucleo) })
//     p = { x, y (mundo), sx, sy (px na vista), evento, nucleo }. aoDesenhar desenha por cima, em px de tela.
//     Ordem sugerida: selecionar 10, mao 20, retangulo 30, elipse 31, losango 32, linha 40, seta 41, livre 50,
//     texto 60, nota 70, borracha 80. A barra se monta sozinha pelo registro (ferramenta nova aparece nela).
//   nucleo (Whiteboard.nucleo): elementos() (lista viva, não mude direto), elemento(id), adicionar(el),
//     atualizar(id, campos), remover(ids), selecao(), selecionar(ids), elementoEm(x, y), caixaMundo(el),
//     telaParaMundo(sx, sy), mundoParaTela(x, y), camera(), definirCamera(c, {animar}), zoomEm(z, sx, sy, animar),
//     ajustar(animar, soSelecao), confirmar(rotulo), redesenhar(), cursor(c), ferramenta(), definirFerramenta(n),
//     estiloAtual() → { cor, traco: { largura, estilo }, preenchimento, opacidade }; definirEstilo(parcial) (emite 'estilo'),
//     on(evento, fn) → desligar, util { aplicarTraco, caixaNormal, dentro, girarPonto }.
//     Toda mudança de ferramenta termina em confirmar(rotulo): marca para gravar (espera de 600 ms) e emite
//     'confirmar' { rotulo } — é aí que o desfazer/refazer (etapa 3) tira o retrato. Outros eventos: 'quadro'
//     (aberto), 'selecao', 'camera', 'estilo', 'mudanca' ({ ids, tipo: 'adicionar'|'atualizar'|'remover'|'carregar'|'desfazer' };
//     'desfazer' vale também para refazer), 'historico' ({ podeDesfazer, podeRefazer, passos, indice }).
//   Evento 'ferramenta' ({ ferramenta }) quando a ferramenta muda.
//   Whiteboard.estender(nome, obj) → boolean: módulos publicam seu objeto (acoes, setas…) uma vez; não sobrescreve a API do núcleo.
//   Alt+arrastar na ferramenta selecionar chama Whiteboard.acoes.duplicar() (se existir) antes de mover a seleção.
//   Histórico (etapa 3): a cada confirmar tira-se um retrato dos elementos (sem campos "_") com a seleção; até 100 passos;
//     nucleo.desfazer()/refazer() → boolean, podeDesfazer()/podeRefazer(); Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y (vista ativa, fora de
//     campos editáveis) e botões junto do zoom. Desfazer/refazer também marcam para gravar. Abrir outro quadro zera o histórico.
//   Seleção: alças (8 + rotação; linha de 2 pontos = 2 extremos) redimensionam/giram (Shift proporcional ou 15°, Alt pelo
//     centro); tipo pode ter aoRedimensionar(el, campos, nucleo) e editar(el, nucleo) (duplo clique; no vazio chama
//     ferramenta 'texto'.criarEm({x, y, nucleo})); setas movem 1 px (Shift 10).
(() => {
  'use strict';

  // ═══════════════ 1. Utilidades e ícones ═══════════════
  const NS = 'http://www.w3.org/2000/svg';
  const ZMIN = 0.1, ZMAX = 8;
  const ESPERA = 600, ESPERA_CAMERA = 2000, ESPERA_ERRO = 4000;
  const LS_ULTIMO = 'orbit.whiteboard.ultimo';
  const KEEPALIVE_MAX = 60000; // fetch keepalive aceita até 64 KB de corpo
  const COR_PADRAO = '#d4d4d4';

  const limitar = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const novoId = () => 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const reduzido = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  const lerLS = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const gravarLS = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  function h(tag, at, ...filhos) {
    const e = document.createElement(tag);
    if (at) for (const [k, v] of Object.entries(at)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const f of filhos.flat()) if (f != null && f !== false) e.append(f.nodeType ? f : String(f));
    return e;
  }

  // Mesmo traço dos ícones do app (16×16, linha 1,5, pontas redondas).
  const ICONES = {
    selecionar: [['path', { d: 'M4 2.6 12.4 8l-3.9.9-1.7 3.7z' }]],
    mao: [['path', { d: 'M5.4 8.4V4.2a1 1 0 0 1 2 0V7.6M7.4 7.4V3.1a1 1 0 0 1 2 0v4.5M9.4 7.6V4.3a1 1 0 0 1 2 0v4.9c0 2.7-1.7 4.6-4.3 4.6-1.5 0-2.6-.6-3.5-1.9L2.3 9.6a1 1 0 0 1 1.5-1.3l1.6 1.5' }]],
    mais: [['path', { d: 'M8 3v10M3 8h10' }]],
    menos: [['path', { d: 'M3 8h10' }]],
    desfazer: [['path', { d: 'M5.5 3 2.8 5.7 5.5 8.4M3 5.7h5.2a4 4 0 0 1 0 8H6' }]],
    refazer: [['path', { d: 'M10.5 3l2.7 2.7-2.7 2.7M13 5.7H7.8a4 4 0 0 0 0 8H10' }]],
    ajustar: [['path', { d: 'M2.5 5.8V2.5h3.3M10.2 2.5h3.3v3.3M13.5 10.2v3.3h-3.3M5.8 13.5H2.5v-3.3' }]],
    chevron: [['path', { d: 'M4.5 6.3 8 9.8l3.5-3.5' }]],
    lapis: [['path', { d: 'M10.6 2.9a1.5 1.5 0 0 1 2.1 0l.4.4a1.5 1.5 0 0 1 0 2.1L6 12.5l-3.2.7.7-3.2z' }], ['path', { d: 'M9.3 4.2l2.5 2.5' }]],
    copiar: [['rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }], ['path', { d: 'M10.5 5.5V3.8a1.3 1.3 0 0 0-1.3-1.3H3.8a1.3 1.3 0 0 0-1.3 1.3v5.4a1.3 1.3 0 0 0 1.3 1.3h1.7' }]],
    lixeira: [['path', { d: 'M2.8 4.3h10.4M6.3 4.3V3a.8.8 0 0 1 .8-.8h1.8a.8.8 0 0 1 .8.8v1.3M4.2 4.3l.6 8.6a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.6' }]],
    quadro: [['rect', { x: 2, y: 2.8, width: 12, height: 8.4, rx: 1.5 }], ['path', { d: 'M5.6 14l1.1-2.8M10.4 14l-1.1-2.8M4.8 8.4l2-2 1.6 1.4 2.8-2.6' }]],
  };
  function icone(def, tam = 16) {
    const v = document.createElementNS(NS, 'svg');
    for (const [k, val] of Object.entries({ viewBox: '0 0 16 16', width: tam, height: tam, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) v.setAttribute(k, val);
    for (const [t, a] of (typeof def === 'string' ? ICONES[def] : def) || []) {
      const p = document.createElementNS(NS, t);
      for (const [k, val] of Object.entries(a)) p.setAttribute(k, val);
      v.append(p);
    }
    return v;
  }

  // Geometria
  const caixaNormal = (el) => ({ x: Math.min(el.x, el.x + el.w), y: Math.min(el.y, el.y + el.h), w: Math.abs(el.w), h: Math.abs(el.h) });
  const dentro = (b, px, py, tol = 0) => px >= b.x - tol && px <= b.x + b.w + tol && py >= b.y - tol && py <= b.y + b.h + tol;
  const cruza = (a, b) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
  function girarPonto(px, py, cx, cy, ang) {
    const c = Math.cos(ang), s = Math.sin(ang), dx = px - cx, dy = py - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  }
  const centro = (el) => [el.x + el.w / 2, el.y + el.h / 2];

  // ═══════════════ 2. Estado e modelo ═══════════════
  const W = {
    raiz: null, el: {}, ctx: null, montado: false, ativo: false,
    quadros: null, quadro: null, // quadro = { id, nome, criado, atualizado, versao }
    elementos: [], porId: new Map(), sel: new Set(),
    cam: { x: 0, y: 0, zoom: 1 }, anim: 0, centrarAoMedir: false,
    larg: 0, alt: 0, dpr: 1,
    raf: 0, htmlSujo: true, nos: new Map(),
    ferramenta: 'selecionar', ferramentas: new Map(), tipos: new Map(),
    gesto: null, toques: new Map(), espaco: false, cursorTemp: null,
    rev: 0, revSalva: 0, camRev: 0, camRevSalva: 0, timer: 0, timerAte: 0, salvando: null, erroSalvar: '',
    seqAbrir: 0, inicio: null, ouvintes: new Map(), cores: {}, painel: null, dialogo: null, avisoT: 0,
  };

  const HIST_MAX = 100; // passos de desfazer guardados
  const H = { pilha: [], i: -1, aplicando: false, sujo: false }; // pilha de retratos; i = retrato atual

  function emitir(ev, d) {
    const fs = W.ouvintes.get(ev);
    if (fs) for (const f of [...fs]) { try { f(d); } catch (e) { console.warn('whiteboard: ouvinte', ev, e); } }
  }
  function on(ev, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!W.ouvintes.has(ev)) W.ouvintes.set(ev, new Set());
    W.ouvintes.get(ev).add(fn);
    return () => W.ouvintes.get(ev).delete(fn);
  }

  const num = (v, p = 0) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : p);
  const proximoZ = () => (W.elementos.length ? W.elementos[W.elementos.length - 1].z + 1 : 1);
  function normalizar(e) {
    const el = Object.assign({}, e);
    el.id = typeof el.id === 'string' && el.id ? el.id : novoId();
    el.tipo = typeof el.tipo === 'string' && el.tipo ? el.tipo : 'desconhecido';
    for (const k of ['x', 'y', 'w', 'h', 'angulo']) el[k] = num(el[k]);
    if (typeof el.cor !== 'string' || !el.cor) el.cor = COR_PADRAO;
    if (!el.traco || typeof el.traco !== 'object') el.traco = { largura: 2, estilo: 'solido' };
    if (el.preenchimento === undefined) el.preenchimento = null;
    el.opacidade = limitar(num(el.opacidade, 1), 0, 1);
    for (const k of ['grupo', 'pontos', 'texto', 'ligacoes', 'sessao']) if (el[k] === undefined) el[k] = null;
    el.z = num(el.z, proximoZ());
    if (el.travado === true) el.travado = true; else delete el.travado;
    return el;
  }
  function ordenar() { W.elementos.sort((a, b) => a.z - b.z); }
  function mudouModelo() { W.htmlSujo = true; H.sujo = true; pedirQuadro(); }
  function adicionar(e) {
    const el = normalizar({ z: proximoZ(), ...e });
    if (W.porId.has(el.id)) el.id = novoId();
    W.elementos.push(el); W.porId.set(el.id, el);
    ordenar(); mudouModelo();
    emitir('mudanca', { ids: [el.id], tipo: 'adicionar' });
    return el;
  }
  function atualizar(id, campos) {
    const el = W.porId.get(id);
    if (!el || !campos) return null;
    if (el.travado && !('travado' in campos)) { // travado: estilo não muda
      campos = Object.assign({}, campos);
      for (const k of ['cor', 'traco', 'preenchimento', 'opacidade', 'texto']) delete campos[k];
    }
    Object.assign(el, campos, { id: el.id });
    if ('travado' in campos && campos.travado !== true) delete el.travado;
    if ('z' in campos) ordenar();
    mudouModelo();
    emitir('mudanca', { ids: [el.id], tipo: 'atualizar' });
    return el;
  }
  function remover(ids) {
    const fora = new Set([].concat(ids || []));
    if (!fora.size) return;
    const existiam = [...fora].filter((id) => W.porId.has(id));
    W.elementos = W.elementos.filter((el) => !fora.has(el.id));
    for (const id of fora) { W.porId.delete(id); W.sel.delete(id); }
    mudouModelo();
    emitir('selecao', [...W.sel]);
    if (existiam.length) emitir('mudanca', { ids: existiam, tipo: 'remover' });
  }
  function selecionar(ids) {
    W.sel = new Set([].concat(ids || []).filter((id) => W.porId.has(id)));
    pedirQuadro();
    emitir('selecao', [...W.sel]);
  }
  const travado = (el) => !!(el && el.travado === true);
  // Membros do grupo de um elemento (ou só ele).
  const membros = (el) => (el.grupo ? W.elementos.filter((o) => o.grupo === el.grupo).map((o) => o.id) : [el.id]);

  function caixaBase(el) { const t = W.tipos.get(el.tipo); return (t && t.caixa && t.caixa(el)) || caixaNormal(el); }
  function cantos(el) {
    const b = caixaBase(el), [cx, cy] = centro(el);
    const cs = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
    return el.angulo ? cs.map(([x, y]) => girarPonto(x, y, cx, cy, el.angulo)) : cs;
  }
  function caixaMundo(el) {
    if (!el.angulo) return caixaBase(el);
    const cs = cantos(el), xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  function uniao(lista) {
    if (!lista.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const el of lista) { const c = caixaMundo(el); x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h); }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function elementoEm(x, y, tol = 6 / W.cam.zoom) {
    for (let i = W.elementos.length - 1; i >= 0; i--) {
      const el = W.elementos[i];
      if (!dentro(caixaMundo(el), x, y, tol)) continue;
      const [cx, cy] = centro(el);
      const [lx, ly] = el.angulo ? girarPonto(x, y, cx, cy, -el.angulo) : [x, y];
      const t = W.tipos.get(el.tipo);
      let ok = false;
      try { ok = t && t.testarClique ? !!t.testarClique(el, lx, ly, tol) : dentro(caixaBase(el), lx, ly, tol); } catch (e) { console.warn('whiteboard: testarClique', el.tipo, e); }
      if (ok) return el;
    }
    return null;
  }

  // Estilo atual: o que as ferramentas de criar usam em elementos novos (a paleta da etapa 3 grava aqui).
  const ESTILO_PADRAO = { cor: '#e5e5e5', traco: { largura: 2, estilo: 'solido' }, preenchimento: null, opacidade: 1 };
  W.estilo = JSON.parse(JSON.stringify(ESTILO_PADRAO));
  const estiloAtual = () => JSON.parse(JSON.stringify(W.estilo));
  function definirEstilo(parcial) {
    if (!parcial || typeof parcial !== 'object') return estiloAtual();
    const e = W.estilo;
    if (typeof parcial.cor === 'string' && parcial.cor) e.cor = parcial.cor;
    if (parcial.traco && typeof parcial.traco === 'object') {
      if (Number.isFinite(+parcial.traco.largura) && +parcial.traco.largura > 0) e.traco.largura = +parcial.traco.largura;
      if (['solido', 'tracejado', 'pontilhado'].includes(parcial.traco.estilo)) e.traco.estilo = parcial.traco.estilo;
    }
    if (parcial.preenchimento === null || typeof parcial.preenchimento === 'string') e.preenchimento = parcial.preenchimento || null;
    if (Number.isFinite(+parcial.opacidade)) e.opacidade = limitar(+parcial.opacidade, 0, 1);
    const r = estiloAtual();
    emitir('estilo', r);
    return r;
  }

  // ═══════════════ 3. Câmera ═══════════════
  const telaParaMundo = (sx, sy) => ({ x: sx / W.cam.zoom + W.cam.x, y: sy / W.cam.zoom + W.cam.y });
  const mundoParaTela = (x, y) => ({ sx: (x - W.cam.x) * W.cam.zoom, sy: (y - W.cam.y) * W.cam.zoom });
  function pararAnimacao() { if (W.anim) cancelAnimationFrame(W.anim); W.anim = 0; }
  function aplicarCamera(c, marcar = true) {
    W.cam = { x: c.x, y: c.y, zoom: limitar(c.zoom, ZMIN, ZMAX) };
    if (marcar) { W.camRev++; agendarSalvar(ESPERA_CAMERA, false); }
    pedirQuadro(); atualizarZoomUI();
    emitir('camera', { ...W.cam });
  }
  // Transição suave: zoom interpolado em escala log e centro da vista em linha reta no mundo.
  function definirCamera(c, { animar = false, dur = 300 } = {}) {
    const alvo = { x: num(c.x), y: num(c.y), zoom: limitar(num(c.zoom, 1), ZMIN, ZMAX) };
    pararAnimacao();
    if (!animar || reduzido() || !W.ativo || !W.larg) { aplicarCamera(alvo); return Promise.resolve(); }
    const de = { ...W.cam }, t0 = performance.now(), mw = W.larg / 2, mh = W.alt / 2;
    const c0 = [de.x + mw / de.zoom, de.y + mh / de.zoom], c1 = [alvo.x + mw / alvo.zoom, alvo.y + mh / alvo.zoom];
    return new Promise((ok) => {
      const passo = (t) => {
        const k = limitar((t - t0) / dur, 0, 1), e = 1 - Math.pow(1 - k, 3);
        if (k >= 1) { W.anim = 0; aplicarCamera(alvo); ok(); return; }
        const z = Math.exp(lerp(Math.log(de.zoom), Math.log(alvo.zoom), e));
        aplicarCamera({ x: lerp(c0[0], c1[0], e) - mw / z, y: lerp(c0[1], c1[1], e) - mh / z, zoom: z });
        W.anim = requestAnimationFrame(passo);
      };
      W.anim = requestAnimationFrame(passo);
    });
  }
  // Zoom mantendo o ponto (sx, sy) da vista parado sob o ponteiro.
  function zoomEm(z, sx = W.larg / 2, sy = W.alt / 2, animar = false) {
    const zz = limitar(z, ZMIN, ZMAX), m = telaParaMundo(sx, sy);
    return definirCamera({ x: m.x - sx / zz, y: m.y - sy / zz, zoom: zz }, { animar });
  }
  function ajustar(animar = true, soSelecao = false) {
    const lista = soSelecao && W.sel.size ? W.elementos.filter((el) => W.sel.has(el.id)) : W.elementos;
    const b = uniao(lista);
    if (!b) return definirCamera({ x: -W.larg / 2, y: -W.alt / 2, zoom: 1 }, { animar });
    const mx = 64, mTopo = 72, mBase = 64;
    const z = limitar(Math.min((W.larg - 2 * mx) / Math.max(b.w, 1), (W.alt - mTopo - mBase) / Math.max(b.h, 1), 1), ZMIN, ZMAX);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    return definirCamera({ x: cx - W.larg / 2 / z, y: cy - (mTopo + (W.alt - mTopo - mBase) / 2) / z, zoom: z }, { animar });
  }
  const zoom100 = () => zoomEm(1, W.larg / 2, W.alt / 2, true);
  const zoomPasso = (f) => zoomEm(W.cam.zoom * f, W.larg / 2, W.alt / 2, true);

  // ═══════════════ 4. Render ═══════════════
  function pedirQuadro() { if (!W.raf && W.ativo && W.ctx) W.raf = requestAnimationFrame(desenharTudo); }
  function medir() {
    if (!W.el.palco) return;
    const r = W.el.palco.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (r.width === W.larg && r.height === W.alt && dpr === W.dpr) return;
    W.larg = r.width; W.alt = r.height; W.dpr = dpr;
    W.el.canvas.width = Math.max(1, Math.round(r.width * dpr));
    W.el.canvas.height = Math.max(1, Math.round(r.height * dpr));
    W.el.canvas.style.width = r.width + 'px';
    W.el.canvas.style.height = r.height + 'px';
    if (W.centrarAoMedir && W.larg) { W.centrarAoMedir = false; aplicarCamera({ x: -W.larg / 2, y: -W.alt / 2, zoom: 1 }, false); }
    pedirQuadro();
  }
  function lerCores() {
    const cs = getComputedStyle(W.raiz), v = (n, p) => cs.getPropertyValue(n).trim() || p;
    W.cores = { acento: v('--acento', '#6366f1'), foco: v('--foco', v('--acento', '#6366f1')), t3: v('--t3', '#5c5c5c'), ponto: 'rgba(255, 255, 255, .085)' };
  }
  function desenharTudo() {
    W.raf = 0;
    if (!W.ativo || !W.ctx) return;
    if (!W.larg) { medir(); if (!W.larg) return; }
    const { ctx, dpr, cam } = W, z = cam.zoom;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W.larg, W.alt);
    desenharGrade(ctx);
    ctx.setTransform(dpr * z, 0, 0, dpr * z, -cam.x * z * dpr, -cam.y * z * dpr);
    const vis = { x: cam.x, y: cam.y, w: W.larg / z, h: W.alt / z };
    for (const el of W.elementos) {
      const t = W.tipos.get(el.tipo);
      if (t && t.html && !t.desenhar) continue;
      if (!cruza(caixaMundo(el), vis)) continue;
      ctx.save();
      ctx.globalAlpha = el._esmaecer ? el.opacidade * 0.25 : el.opacidade;
      if (el.angulo) { const [cx, cy] = centro(el); ctx.translate(cx, cy); ctx.rotate(el.angulo); ctx.translate(-cx, -cy); }
      try { (t && t.desenhar ? t.desenhar : desenharDesconhecido)(ctx, el, { zoom: z, nucleo, selecionado: W.sel.has(el.id) }); } catch (e) { console.warn('whiteboard: desenhar', el.tipo, e); }
      ctx.restore();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    desenharSelecao(ctx);
    desenharAlcas(ctx);
    const f = W.ferramentas.get(W.ferramenta);
    if (f && f.aoDesenhar) { ctx.save(); try { f.aoDesenhar(ctx, nucleo); } catch (e) { console.warn('whiteboard: aoDesenhar', e); } ctx.restore(); }
    posicionarHtml();
  }
  // Grade de pontos: um nível firme (24–48 px na tela) e um mais fino que aparece aos poucos (12–24 px).
  function desenharGrade(ctx) {
    const { zoom: z, x: cx, y: cy } = W.cam;
    let passo = 24;
    while (passo * z < 12) passo *= 2;
    while (passo * z >= 24) passo /= 2;
    const fino = limitar((passo * z - 12) / 12, 0, 1);
    const k0 = Math.ceil(cx / passo), k1 = Math.floor((cx + W.larg / z) / passo);
    const m0 = Math.ceil(cy / passo), m1 = Math.floor((cy + W.alt / z) / passo);
    const r = 1.1, d = r * 2;
    ctx.fillStyle = W.cores.ponto;
    for (const nivel of fino > 0.02 ? [1, 0] : [1]) {
      ctx.globalAlpha = nivel ? 1 : fino;
      for (let k = k0; k <= k1; k++) {
        const kPar = (k & 1) === 0, sx = (k * passo - cx) * z - r;
        for (let m = m0; m <= m1; m++) {
          if ((kPar && (m & 1) === 0) !== !!nivel) continue;
          ctx.fillRect(sx, (m * passo - cy) * z - r, d, d);
        }
      }
    }
    ctx.globalAlpha = 1;
  }
  function desenharDesconhecido(ctx, el, info) {
    const b = caixaNormal(el);
    ctx.setLineDash([6 / info.zoom, 4 / info.zoom]);
    ctx.lineWidth = 1 / info.zoom;
    ctx.strokeStyle = W.cores.t3;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
  }
  function caminho(ctx, pts) { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
  // Cadeado pequeno no canto superior direito da caixa de seleção (px de tela, cor de seleção).
  function desenharCadeado(ctx, t) {
    const x = Math.round(t.sx) + 2, y = Math.round(t.sy) - 16;
    ctx.save();
    ctx.fillStyle = W.cores.acento; ctx.strokeStyle = W.cores.acento; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.rect(x, y + 6, 10, 8); ctx.fill();
    ctx.beginPath(); ctx.arc(x + 5, y + 6, 3.5, Math.PI, 0); ctx.stroke();
    ctx.restore();
    W.cadeados = (W.cadeados || 0) + 1;
  }
  function desenharSelecao(ctx) {
    if (!W.sel.size) return;
    const sel = W.elementos.filter((el) => W.sel.has(el.id));
    const tela = (pts) => pts.map(([x, y]) => { const p = mundoParaTela(x, y); return [Math.round(p.sx) + 0.5, Math.round(p.sy) + 0.5]; });
    ctx.strokeStyle = W.cores.acento; ctx.lineWidth = 1;
    for (const el of sel) {
      const pad = 4 / W.cam.zoom, b = caixaBase(el), [cx, cy] = centro(el);
      let cs = [[b.x - pad, b.y - pad], [b.x + b.w + pad, b.y - pad], [b.x + b.w + pad, b.y + b.h + pad], [b.x - pad, b.y + b.h + pad]];
      if (el.angulo) cs = cs.map(([x, y]) => girarPonto(x, y, cx, cy, el.angulo));
      caminho(ctx, tela(cs)); ctx.stroke();
      if (travado(el)) desenharCadeado(ctx, mundoParaTela(cs[1][0], cs[1][1]));
    }
    if (sel.length > 1) {
      const u = uniao(sel), pad = 8 / W.cam.zoom;
      ctx.setLineDash([4, 3]);
      caminho(ctx, tela([[u.x - pad, u.y - pad], [u.x + u.w + pad, u.y - pad], [u.x + u.w + pad, u.y + u.h + pad], [u.x - pad, u.y + u.h + pad]]));
      ctx.stroke(); ctx.setLineDash([]);
    }
  }
  // Camada HTML: a câmera vai no transform do contêiner; cada nó fica nas coordenadas do mundo.
  function posicionarHtml() {
    const { x, y, zoom } = W.cam;
    W.el.html.style.transform = `translate(${-x * zoom}px, ${-y * zoom}px) scale(${zoom})`;
    if (!W.htmlSujo) return;
    W.htmlSujo = false;
    const vistos = new Set();
    W.elementos.forEach((el, i) => {
      const t = W.tipos.get(el.tipo);
      if (!t || !t.html) return;
      let no = W.nos.get(el.id);
      try {
        if (!no) {
          no = t.html.criar(el, nucleo);
          no.classList.add('wb-no'); no.dataset.id = el.id; no.dataset.tipo = el.tipo;
          W.el.html.append(no); W.nos.set(el.id, no);
        }
        const s = no.style;
        s.width = Math.abs(el.w) + 'px'; s.height = Math.abs(el.h) + 'px';
        s.transform = `translate(${Math.min(el.x, el.x + el.w)}px, ${Math.min(el.y, el.y + el.h)}px)` + (el.angulo ? ` rotate(${el.angulo}rad)` : '');
        s.opacity = String(el._esmaecer ? el.opacidade * 0.25 : el.opacidade); s.zIndex = String(i);
        if (t.html.atualizar) t.html.atualizar(no, el, nucleo);
        vistos.add(el.id);
      } catch (e) { console.warn('whiteboard: html', el.tipo, e); }
    });
    for (const [id, no] of W.nos) {
      if (vistos.has(id)) continue;
      const t = W.tipos.get(no.dataset.tipo);
      try { if (t && t.html && t.html.remover) t.html.remover(no); } catch {}
      no.remove(); W.nos.delete(id);
    }
  }

  // ═══════════════ 5. Entrada (ponteiro, rolagem, teclado) ═══════════════
  function ponto(e) {
    const r = W.el.palco.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    return { sx, sy, x: sx / W.cam.zoom + W.cam.x, y: sy / W.cam.zoom + W.cam.y, evento: e, nucleo };
  }
  const ferramentaAtual = () => W.ferramentas.get(W.ferramenta);
  function chamar(nome, ...args) {
    const f = ferramentaAtual();
    if (f && typeof f[nome] === 'function') { try { return f[nome](...args); } catch (e) { console.warn('whiteboard: ferramenta', W.ferramenta, nome, e); } }
  }
  function atualizarCursor() {
    if (!W.el.palco) return;
    const f = ferramentaAtual(), g = W.gesto;
    W.el.palco.style.cursor = g && g.tipo === 'pan' ? 'grabbing'
      : W.espaco || (f && f.arrastaCamera) ? 'grab'
      : W.cursorTemp || (f && f.cursor) || 'default';
  }
  function cancelarGesto() {
    const g = W.gesto;
    W.gesto = null;
    if (g && g.tipo === 'ferramenta') chamar('aoCancelar', nucleo);
    atualizarCursor(); pedirQuadro();
  }
  function capturar(e) { try { W.el.palco.setPointerCapture(e.pointerId); } catch {} }
  function centroToques() {
    const ps = [...W.toques.values()].slice(0, 2);
    return { sx: (ps[0].sx + ps[1].sx) / 2, sy: (ps[0].sy + ps[1].sy) / 2, d: Math.hypot(ps[0].sx - ps[1].sx, ps[0].sy - ps[1].sy) || 1 };
  }
  function aoDescer(e) {
    if (W.painel) fecharPainel(false);
    try { W.el.palco.focus({ preventScroll: true }); } catch {}
    const p = ponto(e);
    if (e.pointerType === 'touch') {
      W.toques.set(e.pointerId, { sx: p.sx, sy: p.sy });
      capturar(e);
      if (W.toques.size === 2) {
        cancelarGesto(); pararAnimacao();
        const c = centroToques();
        W.gesto = { tipo: 'pinca', d0: c.d, z0: W.cam.zoom, m: telaParaMundo(c.sx, c.sy) };
        return;
      }
      if (W.toques.size > 2) return;
    }
    const f = ferramentaAtual();
    if (e.button === 1 || (e.button === 0 && (W.espaco || (f && f.arrastaCamera)))) {
      e.preventDefault(); pararAnimacao(); capturar(e);
      W.gesto = { tipo: 'pan', id: e.pointerId, sx: p.sx, sy: p.sy, cx: W.cam.x, cy: W.cam.y };
      atualizarCursor();
      return;
    }
    if (e.button !== 0 || !f || !f.aoDescer) return;
    capturar(e);
    W.gesto = { tipo: 'ferramenta', id: e.pointerId };
    chamar('aoDescer', p);
    pedirQuadro();
  }
  function aoMover(e) {
    const g = W.gesto, p = ponto(e);
    if (e.pointerType === 'touch' && W.toques.has(e.pointerId)) W.toques.set(e.pointerId, { sx: p.sx, sy: p.sy });
    if (g && g.tipo === 'pinca') {
      if (W.toques.size < 2) return;
      const c = centroToques(), z = limitar(g.z0 * c.d / g.d0, ZMIN, ZMAX);
      aplicarCamera({ x: g.m.x - c.sx / z, y: g.m.y - c.sy / z, zoom: z });
      return;
    }
    if (g && g.tipo === 'pan' && g.id === e.pointerId) {
      aplicarCamera({ x: g.cx - (p.sx - g.sx) / W.cam.zoom, y: g.cy - (p.sy - g.sy) / W.cam.zoom, zoom: W.cam.zoom });
      return;
    }
    if (g && g.tipo === 'ferramenta' && g.id === e.pointerId) { chamar('aoMover', p); pedirQuadro(); return; }
    if (!g && e.pointerType !== 'touch') chamar('aoPairar', p);
  }
  function aoSubir(e) {
    const g = W.gesto;
    if (e.pointerType === 'touch') {
      W.toques.delete(e.pointerId);
      if (g && g.tipo === 'pinca') { if (W.toques.size < 2) W.gesto = null; return; }
    }
    if (!g) return;
    if (g.tipo === 'pan' && g.id === e.pointerId) { W.gesto = null; atualizarCursor(); return; }
    if (g.tipo === 'ferramenta' && g.id === e.pointerId) {
      W.gesto = null;
      if (e.type === 'pointercancel') chamar('aoCancelar', nucleo); else chamar('aoSubir', ponto(e));
      atualizarCursor(); pedirQuadro();
    }
  }
  // Ctrl+rolagem e pinça do trackpad (chega como wheel com ctrlKey) = zoom no ponteiro; rolagem pura = deslocar.
  function aoRolar(e) {
    e.preventDefault();
    pararAnimacao();
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; } else if (e.deltaMode === 2) { dx *= W.larg; dy *= W.alt; }
    const p = ponto(e);
    if (e.ctrlKey || e.metaKey) { zoomEm(W.cam.zoom * Math.exp(-limitar(dy, -40, 40) * 0.0075), p.sx, p.sy); return; }
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    aplicarCamera({ x: W.cam.x + dx / W.cam.zoom, y: W.cam.y + dy / W.cam.zoom, zoom: W.cam.zoom });
  }
  const editavel = (t) => !!(t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
  function consumir(e) { e.preventDefault(); e.stopPropagation(); }
  function aoTecla(e) {
    if (!W.ativo || !W.montado || e.defaultPrevented) return;
    const alvo = e.target;
    if (alvo !== document.body && alvo !== document.documentElement && !W.raiz.contains(alvo)) return;
    if (alvo.closest && alvo.closest('.wb-veu, .wb-pn, [role="dialog"]')) return; // exportar e painel de sessões cuidam das próprias teclas
    if (W.dialogo || editavel(alvo)) return; // o diálogo e os campos cuidam das próprias teclas
    if (W.painel) { if (e.key === 'Escape') { consumir(e); fecharPainel(true); } return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && ((e.key.toLowerCase() === 'z') || (e.key.toLowerCase() === 'y' && !e.shiftKey))) {
      consumir(e);
      if (e.key.toLowerCase() === 'y' || e.shiftKey) refazer(); else desfazer();
      return;
    }
    if (chamar('aoTecla', e, nucleo) === true) { consumir(e); return; }
    if (e.code === 'Space') {
      if (W.raiz.contains(alvo) && alvo !== W.el.palco && alvo.tagName === 'BUTTON') return; // espaço num botão = clicar
      consumir(e);
      if (!e.repeat && !W.espaco) { W.espaco = true; atualizarCursor(); }
      return;
    }
    if (e.shiftKey && !mod && !e.altKey && e.code === 'Digit1') { consumir(e); ajustar(true); return; }
    if (e.shiftKey && !mod && !e.altKey && e.code === 'Digit2') { consumir(e); ajustar(true, true); return; }
    if ((mod && !e.shiftKey && e.key === '0') || (e.shiftKey && !mod && e.code === 'Digit0')) { consumir(e); zoom100(); return; }
    if (mod && (e.key === '=' || e.key === '+')) { consumir(e); zoomPasso(1.25); return; }
    if (mod && e.key === '-') { consumir(e); zoomPasso(1 / 1.25); return; }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'a') { consumir(e); selecionar(W.elementos.filter((el) => !travado(el)).map((el) => el.id)); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && W.sel.size && !mod) { consumir(e); const ids = [...W.sel].filter((id) => !travado(W.porId.get(id))); if (ids.length) { remover(ids); confirmar('excluir'); } return; }
    if (e.key === 'Escape' && (W.sel.size || W.gesto)) { consumir(e); if (W.gesto) cancelarGesto(); selecionar([]); return; }
    if (!mod && !e.altKey && W.sel.size && !W.gesto && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
      consumir(e);
      const d = e.shiftKey ? 10 : 1, dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
      for (const el of W.elementos) if (W.sel.has(el.id) && !travado(el)) { el.x += dx; el.y += dy; }
      if (W.elementos.some((el) => W.sel.has(el.id) && !travado(el))) { mudouModelo(); confirmar('mover'); }
      return;
    }
    if (!mod && !e.altKey && !e.shiftKey && e.key.length === 1) {
      const k = e.key.toLowerCase();
      for (const [nome, f] of W.ferramentas) if (f.tecla === k) { consumir(e); definirFerramenta(nome); return; }
    }
  }
  // Duplo clique (ferramenta selecionar): em elemento com tipo.editar chama-o; no vazio pede texto novo à ferramenta 'texto'.
  function aoDuplo(e) {
    if (!W.ativo || W.ferramenta !== 'selecionar' || e.button !== 0) return;
    const p = ponto(e);
    if (hitAlca(p.sx, p.sy)) return;
    const el = elementoEm(p.x, p.y);
    try {
      if (el) { const t = W.tipos.get(el.tipo); if (travado(el) && el.tipo !== 'agente' && el.tipo !== 'subagente') return; if (t && typeof t.editar === 'function') { e.preventDefault(); t.editar(el, nucleo); } }
      else { const f = W.ferramentas.get('texto'); if (f && typeof f.criarEm === 'function') { e.preventDefault(); f.criarEm({ x: p.x, y: p.y, nucleo }); } }
    } catch (err) { console.warn('whiteboard: duplo clique', err); }
  }
  function aoSoltar(e) {
    if (e.code !== 'Space' || !W.espaco) return;
    W.espaco = false; atualizarCursor();
    if (W.ativo && (e.target === document.body || W.raiz.contains(e.target))) e.preventDefault();
  }

  // ═══════════════ 6. Persistência ═══════════════
  const CAB = { 'content-type': 'application/json', 'x-gerenciador': '1' }; // o servidor exige o x-gerenciador nos POST
  async function pedir(url, corpo) {
    const init = corpo !== undefined ? { method: 'POST', headers: CAB, body: JSON.stringify(corpo) } : { cache: 'no-store' };
    let r;
    try { r = await fetch(url, init); } catch { const e = new Error('Sem conexão com o Orbit.'); e.status = 0; throw e; }
    let j = null;
    try { j = await r.json(); } catch {}
    if (!r.ok) { const e = new Error((j && typeof j.erro === 'string' && j.erro) || 'Erro ' + r.status + '.'); e.status = r.status; throw e; }
    return j && typeof j === 'object' ? j : {};
  }
  const limpo = (el) => { const o = {}; for (const k in el) if (k[0] !== '_') o[k] = el[k]; return o; };
  const corpoSalvar = () => ({ id: W.quadro.id, camera: { ...W.cam }, elementos: W.elementos.map(limpo) });
  const pendente = () => !!W.quadro && (W.rev !== W.revSalva || W.camRev !== W.camRevSalva);
  const resumoDe = (q) => ({ id: q.id, nome: q.nome, criado: q.criado, atualizado: q.atualizado, total: Array.isArray(q.elementos) ? q.elementos.length : num(q.total) });
  const itemLista = (id) => (W.quadros || []).find((q) => q.id === id);

  function limparTimer() { if (W.timer) clearTimeout(W.timer); W.timer = 0; W.timerAte = 0; }
  // reiniciar: mudança de elementos (espera conta de novo a cada mudança). Câmera: não adia um salvamento já marcado.
  function agendarSalvar(ms, reiniciar) {
    if (!W.quadro) return;
    const ate = Date.now() + ms;
    if (W.timer && !reiniciar && W.timerAte <= ate) return;
    limparTimer();
    W.timerAte = ate;
    W.timer = setTimeout(() => { W.timer = 0; salvarAgora(); }, ms);
    definirStatus();
  }
  function confirmar(rotulo) {
    if (!W.quadro) return;
    W.rev++;
    const it = itemLista(W.quadro.id);
    if (it) it.total = W.elementos.length;
    agendarSalvar(ESPERA, true);
    if (!H.aplicando) empurrarRetrato();
    emitir('confirmar', { rotulo: rotulo || '' });
  }

  // ── Histórico (desfazer/refazer): retrato dos elementos (sem campos "_") + seleção a cada confirmar ──
  const retratoAgora = () => ({ str: JSON.stringify(W.elementos.map(limpo)), sel: [...W.sel], selDepois: [...W.sel] });
  // sel = seleção que valia neste estado antes da próxima ação (alvo do desfazer); selDepois = a do momento do confirmar (alvo do refazer).
  on('selecao', (ids) => { const a = H.pilha[H.i]; if (a && !H.sujo && !H.aplicando) a.sel = [...ids]; });
  function avisarHistorico() {
    if (W.montado) {
      W.el.desfazer.disabled = !podeDesfazer(); W.el.refazer.disabled = !podeRefazer();
    }
    emitir('historico', { podeDesfazer: podeDesfazer(), podeRefazer: podeRefazer(), passos: Math.max(0, H.pilha.length - 1), indice: H.i });
  }
  function zerarHistorico() {
    H.pilha = W.quadro ? [retratoAgora()] : []; H.i = H.pilha.length - 1; H.sujo = false;
    avisarHistorico();
  }
  function empurrarRetrato() {
    const r = retratoAgora(), atual = H.pilha[H.i];
    H.sujo = false;
    if (atual && atual.str === r.str) { atual.sel = r.sel; atual.selDepois = r.sel; return; } // nada mudou nos elementos
    H.pilha.length = H.i + 1; H.pilha.push(r);
    if (H.pilha.length > HIST_MAX + 1) H.pilha.splice(0, H.pilha.length - HIST_MAX - 1);
    H.i = H.pilha.length - 1;
    avisarHistorico();
  }
  const podeDesfazer = () => !!W.quadro && H.i > 0;
  const podeRefazer = () => !!W.quadro && H.i < H.pilha.length - 1;
  function irPara(i, rotulo) {
    if (!W.quadro || W.gesto || i < 0 || i >= H.pilha.length || i === H.i) return false;
    const alvo = H.pilha[i], atual = H.pilha[H.i];
    const antes = new Map(W.elementos.map((el) => [el.id, JSON.stringify(limpo(el))]));
    let lista;
    try { lista = JSON.parse(alvo.str); } catch { return false; }
    const novos = lista.map((e) => normalizar(e));
    const ids = new Set();
    for (const el of novos) { const s = JSON.stringify(limpo(el)); if (antes.get(el.id) !== s) ids.add(el.id); antes.delete(el.id); }
    for (const id of antes.keys()) ids.add(id);
    W.elementos = novos; W.porId = new Map(novos.map((el) => [el.id, el]));
    ordenar();
    let sel = (i < H.i ? alvo.sel : alvo.selDepois).filter((id) => W.porId.has(id));
    if (!sel.length && i < H.i) sel = atual.selDepois.filter((id) => W.porId.has(id));
    W.sel = new Set(sel);
    H.i = i;
    H.aplicando = true;
    try { mudouModelo(); atualizarVazio(); emitir('selecao', [...W.sel]); emitir('mudanca', { ids: [...ids], tipo: 'desfazer' }); confirmar(rotulo); }
    finally { H.aplicando = false; H.sujo = false; }
    avisarHistorico();
    return true;
  }
  const desfazer = () => (podeDesfazer() ? irPara(H.i - 1, 'desfazer') : false);
  const refazer = () => (podeRefazer() ? irPara(H.i + 1, 'refazer') : false);
  async function salvarAgora() {
    limparTimer();
    if (W.salvando) { try { await W.salvando; } catch {} }
    if (!pendente()) return;
    const q = W.quadro, rev = W.rev, camRev = W.camRev, corpo = corpoSalvar();
    const p = pedir('/whiteboard/salvar', corpo).then((j) => {
      if (W.quadro !== q) return;
      W.revSalva = rev; W.camRevSalva = camRev; W.erroSalvar = '';
      if (j.atualizado) q.atualizado = j.atualizado;
      const it = itemLista(q.id);
      if (it) { it.atualizado = q.atualizado; it.total = corpo.elementos.length; }
    }, (e) => {
      if (W.quadro !== q) return;
      W.erroSalvar = e.message || 'Não foi possível salvar.';
      agendarSalvar(ESPERA_ERRO, false);
    });
    W.salvando = p;
    definirStatus();
    await p;
    if (W.salvando === p) W.salvando = null;
    definirStatus();
  }
  // Saída da página: fetch keepalive (o sendBeacon não manda o cabeçalho x-gerenciador). Acima de ~60 KB o keepalive
  // não vale; vai um fetch comum (melhor esforço).
  function descarregar() {
    if (!pendente()) return;
    const corpo = JSON.stringify(corpoSalvar());
    const init = { method: 'POST', headers: CAB, body: corpo };
    try { const r = fetch('/whiteboard/salvar', corpo.length < KEEPALIVE_MAX ? { ...init, keepalive: true } : init); if (r && r.catch) r.catch(() => {}); } catch {}
    W.revSalva = W.rev; W.camRevSalva = W.camRev; // beforeunload + pagehide não mandam duas vezes
  }

  async function carregarLista() {
    const j = await pedir('/whiteboard/lista');
    W.quadros = Array.isArray(j.quadros) ? j.quadros.filter((q) => q && typeof q.id === 'string') : [];
    renderPainel();
    return W.quadros;
  }
  function carregar(q) {
    pararAnimacao();
    if (W.gesto) cancelarGesto();
    limparTimer();
    W.quadro = { id: q.id, nome: String(q.nome || 'Quadro sem título'), criado: q.criado, atualizado: q.atualizado, versao: num(q.versao, 1) };
    W.elementos = []; W.porId = new Map(); W.sel = new Set();
    for (const e of Array.isArray(q.elementos) ? q.elementos : []) {
      if (!e || typeof e !== 'object') continue;
      const el = normalizar(e);
      if (W.porId.has(el.id)) el.id = novoId();
      W.elementos.push(el); W.porId.set(el.id, el);
    }
    ordenar();
    for (const no of W.nos.values()) no.remove();
    W.nos.clear(); W.htmlSujo = true;
    const c = q.camera;
    if (c && Number.isFinite(+c.x) && Number.isFinite(+c.y) && +c.zoom > 0) aplicarCamera({ x: +c.x, y: +c.y, zoom: +c.zoom }, false);
    else if (W.larg) aplicarCamera({ x: -W.larg / 2, y: -W.alt / 2, zoom: 1 }, false);
    else W.centrarAoMedir = true;
    W.rev = W.revSalva = W.camRev = W.camRevSalva = 0; W.erroSalvar = '';
    gravarLS(LS_ULTIMO, q.id);
    const it = itemLista(q.id);
    if (it) Object.assign(it, { nome: W.quadro.nome, total: W.elementos.length }); else if (W.quadros) W.quadros.unshift(resumoDe(q));
    atualizarCabecalho(); renderPainel(); definirStatus(); atualizarVazio(); pedirQuadro();
    zerarHistorico();
    emitir('quadro', { ...W.quadro });
    emitir('selecao', []);
    emitir('mudanca', { ids: W.elementos.map((el) => el.id), tipo: 'carregar' });
  }
  async function abrirQuadro(id) {
    const seq = ++W.seqAbrir;
    await salvarAgora();
    if (seq !== W.seqAbrir) return;
    let q;
    try { q = await pedir('/whiteboard/quadro?id=' + encodeURIComponent(id)); } catch (e) {
      if (seq !== W.seqAbrir) return;
      if (e.status === 404) { // sumiu (outra janela apagou): tira da lista e abre outro
        W.quadros = (W.quadros || []).filter((x) => x.id !== id);
        if (W.quadro && W.quadro.id === id) W.quadro = null;
        renderPainel();
        return abrirOutro();
      }
      aviso(e.message);
      return;
    }
    if (seq !== W.seqAbrir) return;
    carregar(q);
  }
  async function abrirOutro() {
    const prox = (W.quadros || [])[0];
    if (prox) return abrirQuadro(prox.id);
    return novoQuadro();
  }
  async function novoQuadro(nome) {
    await salvarAgora();
    try {
      const q = await pedir('/whiteboard/novo', nome ? { nome } : {});
      if (W.quadros) W.quadros = [resumoDe(q), ...W.quadros.filter((x) => x.id !== q.id)];
      carregar(q);
      return q;
    } catch (e) { aviso(e.message); return null; }
  }
  async function renomearQuadro(id, nome) {
    nome = String(nome || '').trim();
    if (!nome) throw new Error('Dê um nome ao quadro.');
    await pedir('/whiteboard/renomear', { id, nome });
    const it = itemLista(id);
    if (it) it.nome = nome;
    if (W.quadro && W.quadro.id === id) { W.quadro.nome = nome; atualizarCabecalho(); }
    renderPainel();
  }
  async function duplicarQuadro(id) {
    if (W.quadro && W.quadro.id === id) await salvarAgora();
    try {
      const q = await pedir('/whiteboard/duplicar', { id });
      W.quadros = [resumoDe(q), ...(W.quadros || []).filter((x) => x.id !== q.id)];
      carregar(q);
      return q;
    } catch (e) { aviso(e.message); return null; }
  }
  async function excluirQuadro(id) {
    await pedir('/whiteboard/excluir', { id });
    W.quadros = (W.quadros || []).filter((x) => x.id !== id);
    if (lerLS(LS_ULTIMO) === id) { try { localStorage.removeItem(LS_ULTIMO); } catch {} }
    if (W.quadro && W.quadro.id === id) {
      limparTimer();
      W.quadro = null; W.rev = W.revSalva = W.camRev = W.camRevSalva = 0; zerarHistorico();
      await abrirOutro();
    }
    renderPainel();
  }

  // ═══════════════ 7. Interface ═══════════════
  function montar(raiz) {
    if (W.montado) return;
    W.raiz = raiz;
    raiz.classList.add('wb-vista');
    raiz.textContent = '';
    const E = W.el;
    E.canvas = h('canvas', { class: 'wb-canvas', 'aria-hidden': 'true' });
    E.html = h('div', { class: 'wb-html' });
    E.palco = h('div', { class: 'wb-palco', tabindex: '-1', role: 'application', 'aria-label': 'Quadro' }, E.canvas, E.html);
    E.nome = h('span', { class: 'wb-nome' }, 'Whiteboard');
    E.quadroBtn = h('button', { class: 'wb-quadro-btn', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Quadros' },
      icone('quadro', 15), E.nome, h('span', { class: 'wb-seta' }, icone('chevron', 14)));
    E.status = h('span', { class: 'wb-status', role: 'status', 'aria-live': 'polite' });
    E.status.addEventListener('click', () => { if (W.erroSalvar) salvarAgora(); });
    E.topo = h('div', { class: 'wb-topo' }, E.quadroBtn, E.status);
    E.barra = h('div', { class: 'wb-barra', role: 'toolbar', 'aria-label': 'Ferramentas' });
    E.zoomPct = h('button', { class: 'wb-zoom-pct', type: 'button', title: 'Voltar a 100% (Shift+0)' }, '100%');
    E.desfazer = h('button', { class: 'wb-ib', type: 'button', title: 'Desfazer (Ctrl+Z)', 'aria-label': 'Desfazer', 'data-hist': 'desfazer', disabled: true }, icone('desfazer', 15));
    E.refazer = h('button', { class: 'wb-ib', type: 'button', title: 'Refazer (Ctrl+Shift+Z)', 'aria-label': 'Refazer', 'data-hist': 'refazer', disabled: true }, icone('refazer', 15));
    E.zoom = h('div', { class: 'wb-zoom', role: 'group', 'aria-label': 'Zoom e histórico' },
      E.desfazer, E.refazer,
      h('span', { class: 'wb-sep', 'aria-hidden': 'true' }),
      h('button', { class: 'wb-ib', type: 'button', title: 'Diminuir zoom (Ctrl+−)', 'aria-label': 'Diminuir zoom', 'data-zoom': 'menos' }, icone('menos', 15)),
      E.zoomPct,
      h('button', { class: 'wb-ib', type: 'button', title: 'Aumentar zoom (Ctrl++)', 'aria-label': 'Aumentar zoom', 'data-zoom': 'mais' }, icone('mais', 15)),
      h('span', { class: 'wb-sep', 'aria-hidden': 'true' }),
      h('button', { class: 'wb-ib', type: 'button', title: 'Ajustar à tela (Shift+1)', 'aria-label': 'Ajustar à tela', 'data-zoom': 'ajustar' }, icone('ajustar', 15)));
    E.vazio = h('p', { class: 'wb-vazio', hidden: true }, 'Arraste com o botão do meio, ou Espaço + arrastar, para mover · Ctrl + rolagem para o zoom');
    E.aviso = h('div', { class: 'wb-aviso', role: 'alert', hidden: true });
    raiz.append(E.palco, E.topo, E.barra, E.zoom, E.vazio, E.aviso);

    W.ctx = E.canvas.getContext('2d');
    lerCores();
    new ResizeObserver(medir).observe(E.palco);
    E.palco.addEventListener('pointerdown', aoDescer);
    E.palco.addEventListener('pointermove', aoMover);
    E.palco.addEventListener('pointerup', aoSubir);
    E.palco.addEventListener('pointercancel', aoSubir);
    E.palco.addEventListener('wheel', aoRolar, { passive: false });
    E.palco.addEventListener('dblclick', aoDuplo);
    E.palco.addEventListener('contextmenu', (e) => e.preventDefault());
    E.palco.addEventListener('pointerleave', () => { if (!W.gesto && W.cursorTemp) { W.cursorTemp = null; atualizarCursor(); } });
    E.zoom.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b === E.desfazer) desfazer();
      else if (b === E.refazer) refazer();
      else if (b === E.zoomPct) zoom100();
      else if (b.dataset.zoom === 'mais') zoomPasso(1.25);
      else if (b.dataset.zoom === 'menos') zoomPasso(1 / 1.25);
      else if (b.dataset.zoom === 'ajustar') ajustar(true);
    });
    E.quadroBtn.addEventListener('click', () => (W.painel ? fecharPainel(true) : abrirPainel()));
    E.quadroBtn.addEventListener('dblclick', () => { if (W.quadro) { abrirPainel(); editarNome(W.quadro.id); } });
    document.addEventListener('keydown', aoTecla, true);
    document.addEventListener('keyup', aoSoltar, true);
    window.addEventListener('blur', () => { if (W.espaco) { W.espaco = false; atualizarCursor(); } });
    document.addEventListener('pointerdown', (e) => {
      if (W.painel && !W.painel.contains(e.target) && !E.quadroBtn.contains(e.target)) fecharPainel(false);
    }, true);
    window.addEventListener('beforeunload', descarregar);
    window.addEventListener('pagehide', descarregar);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && pendente()) salvarAgora(); });
    W.montado = true;
    montarBarra(); atualizarCabecalho(); definirStatus(); atualizarZoomUI(); atualizarCursor();
  }

  function atualizarCabecalho() {
    if (!W.montado) return;
    W.el.nome.textContent = W.quadro ? W.quadro.nome : 'Whiteboard';
    W.el.quadroBtn.title = W.quadro ? W.quadro.nome + ' · Quadros' : 'Quadros';
  }
  function definirStatus() {
    if (!W.montado) return;
    const s = W.el.status;
    let estado = '', txt = '';
    if (W.quadro) {
      if (W.erroSalvar) { estado = 'erro'; txt = 'Não salvo'; }
      else if (W.salvando || W.rev !== W.revSalva) { estado = 'salvando'; txt = 'Salvando…'; }
      else { estado = 'salvo'; txt = 'Salvo'; }
    }
    s.dataset.estado = estado;
    s.title = W.erroSalvar ? W.erroSalvar + ' Clique para tentar de novo.' : '';
    if (s.textContent !== txt) s.textContent = txt;
  }
  function atualizarZoomUI() { if (W.montado) W.el.zoomPct.textContent = Math.round(W.cam.zoom * 100) + '%'; }
  function atualizarVazio() { if (W.montado) W.el.vazio.hidden = !W.quadro || W.elementos.length > 0; }
  function aviso(txt) {
    if (!W.montado || !txt) return;
    W.el.aviso.textContent = txt; W.el.aviso.hidden = false;
    clearTimeout(W.avisoT);
    W.avisoT = setTimeout(() => { W.el.aviso.hidden = true; }, 4000);
  }

  // Barra de ferramentas: montada a partir do registro.
  function montarBarra() {
    if (!W.montado) return;
    const b = W.el.barra;
    b.textContent = '';
    const lista = [...W.ferramentas.entries()].sort((a, c) => (a[1].ordem ?? 999) - (c[1].ordem ?? 999));
    lista.forEach(([nome, f], i) => {
      if (f.separarAntes && i) b.append(h('span', { class: 'wb-sep', 'aria-hidden': 'true' }));
      const rot = (f.rotulo || nome) + (f.tecla ? ' — ' + f.tecla.toUpperCase() : '');
      const bt = h('button', { class: 'wb-ferr', type: 'button', 'data-ferramenta': nome, 'aria-pressed': String(nome === W.ferramenta), title: rot, 'aria-label': f.rotulo || nome },
        icone(f.icone || 'selecionar', 16), f.tecla ? h('span', { class: 'wb-tecla', 'aria-hidden': 'true' }, f.tecla.toUpperCase()) : null);
      bt.addEventListener('click', () => { definirFerramenta(nome); try { W.el.palco.focus({ preventScroll: true }); } catch {} });
      b.append(bt);
    });
  }
  function definirFerramenta(nome) {
    if (!W.ferramentas.has(nome) || nome === W.ferramenta) return;
    if (W.gesto) cancelarGesto();
    chamar('aoDesativar', nucleo);
    W.ferramenta = nome; W.cursorTemp = null;
    chamar('aoAtivar', nucleo);
    if (W.montado) for (const bt of W.el.barra.querySelectorAll('.wb-ferr')) bt.setAttribute('aria-pressed', String(bt.dataset.ferramenta === nome));
    atualizarCursor(); pedirQuadro();
    emitir('ferramenta', { ferramenta: nome });
  }

  // Painel de quadros: criar, abrir, renomear, duplicar, excluir.
  function quando(v) {
    const t = typeof v === 'number' ? v : Date.parse(v);
    if (!Number.isFinite(t)) return '';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'agora';
    if (s < 3600) return 'há ' + Math.floor(s / 60) + ' min';
    if (s < 86400) return 'há ' + Math.floor(s / 3600) + ' h';
    if (s < 172800) return 'ontem';
    return new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  }
  function abrirPainel() {
    if (W.painel) return;
    const novo = h('button', { class: 'wb-novo', type: 'button' }, icone('mais', 14), 'Novo quadro');
    novo.addEventListener('click', async () => { novo.disabled = true; await novoQuadro(); novo.disabled = false; fecharPainel(false); });
    W.el.lista = h('div', { class: 'wb-lista', role: 'list' });
    W.el.painelErro = h('p', { class: 'wb-painel-erro', hidden: true });
    W.painel = h('div', { class: 'wb-painel', role: 'dialog', 'aria-label': 'Quadros' },
      h('div', { class: 'wb-painel-cab' }, h('span', { class: 'wb-painel-tit' }, 'Quadros'), novo), W.el.lista, W.el.painelErro);
    W.painel.addEventListener('keydown', teclaPainel);
    W.raiz.append(W.painel);
    W.el.quadroBtn.setAttribute('aria-expanded', 'true');
    renderPainel();
    const atual = W.painel.querySelector('.wb-item[aria-current="true"] .wb-item-abrir') || novo;
    try { atual.focus({ preventScroll: true }); } catch {}
    carregarLista().catch(() => {});
  }
  function fecharPainel(focarBotao) {
    if (!W.painel) return;
    const p = W.painel;
    W.painel = null;
    W.el.quadroBtn.setAttribute('aria-expanded', 'false');
    p.classList.add('saindo');
    setTimeout(() => p.remove(), reduzido() ? 0 : 160);
    if (focarBotao) try { W.el.quadroBtn.focus({ preventScroll: true }); } catch {}
  }
  function erroPainel(txt) { if (W.el.painelErro && W.painel) { W.el.painelErro.textContent = txt || ''; W.el.painelErro.hidden = !txt; } }
  function renderPainel() {
    if (!W.painel || W.el.lista.querySelector('.wb-campo')) return; // não atrapalha um renomear em curso
    const L = W.el.lista;
    L.textContent = '';
    const lista = W.quadros || [];
    if (!lista.length) { L.append(h('p', { class: 'wb-lista-vazia' }, W.quadros ? 'Nenhum quadro ainda.' : 'Carregando…')); return; }
    for (const q of lista) {
      const atual = W.quadro && W.quadro.id === q.id;
      const n = num(q.total);
      const abrir = h('button', { class: 'wb-item-abrir', type: 'button' },
        h('span', { class: 'wb-item-nome' }, q.nome || 'Quadro sem título'),
        h('span', { class: 'wb-item-meta' }, n + (n === 1 ? ' elemento' : ' elementos') + (quando(q.atualizado) ? ' · ' + quando(q.atualizado) : '')));
      abrir.addEventListener('click', () => { fecharPainel(false); if (!atual) abrirQuadro(q.id); });
      const acao = (ic, rot, fn) => { const b = h('button', { class: 'wb-ib wb-acao', type: 'button', title: rot, 'aria-label': rot + ': ' + (q.nome || ''), 'data-acao': ic }, icone(ic, 14)); b.addEventListener('click', fn); return b; };
      L.append(h('div', { class: 'wb-item', role: 'listitem', 'data-id': q.id, 'aria-current': atual ? 'true' : null },
        abrir,
        h('div', { class: 'wb-item-acoes' },
          acao('lapis', 'Renomear', () => editarNome(q.id)),
          acao('copiar', 'Duplicar', async () => { fecharPainel(false); await duplicarQuadro(q.id); }),
          acao('lixeira', 'Excluir', () => pedirExclusao(q)))));
    }
  }
  function teclaPainel(e) {
    if (e.target.classList.contains('wb-campo')) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const bs = [...W.painel.querySelectorAll('.wb-item-abrir')];
    const i = bs.indexOf(document.activeElement);
    const j = limitar(i + (e.key === 'ArrowDown' ? 1 : -1), 0, bs.length - 1);
    if (bs[j]) { e.preventDefault(); bs[j].focus(); }
  }
  function editarNome(id) {
    if (!W.painel) return;
    const linha = [...W.el.lista.querySelectorAll('.wb-item')].find((x) => x.dataset.id === id);
    const q = itemLista(id);
    if (!linha || !q) return;
    const campo = h('input', { class: 'wb-campo', type: 'text', maxlength: '80', 'aria-label': 'Nome do quadro', spellcheck: 'false' });
    campo.value = q.nome || '';
    const abrir = linha.querySelector('.wb-item-abrir');
    abrir.replaceWith(campo);
    linha.classList.add('editando');
    campo.focus(); campo.select();
    let feito = false;
    const fim = async (gravar) => {
      if (feito) return;
      const nome = campo.value.trim();
      if (gravar && nome && nome !== q.nome) {
        feito = true;
        try { await renomearQuadro(id, nome); erroPainel(''); } catch (e) { feito = false; erroPainel(e.message); campo.focus(); return; }
      }
      feito = true;
      campo.remove();
      renderPainel();
      const b = W.painel && [...W.el.lista.querySelectorAll('.wb-item')].find((x) => x.dataset.id === id);
      if (b) b.querySelector('.wb-item-abrir').focus({ preventScroll: true });
    };
    campo.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); fim(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); erroPainel(''); fim(false); }
    });
    campo.addEventListener('blur', () => setTimeout(() => { if (!feito && W.painel) fim(true); }, 0));
  }

  // Diálogo de confirmação (excluir quadro). Foco começa em Cancelar; Esc cancela; Tab fica nos dois botões.
  function pedirExclusao(q) {
    fecharPainel(false);
    const n = num(q.total);
    const cancelar = h('button', { class: 'wb-btn', type: 'button' }, 'Cancelar');
    const ok = h('button', { class: 'wb-btn wb-btn-perigo', type: 'button' }, 'Excluir quadro');
    const erro = h('p', { class: 'wb-dialogo-erro', hidden: true });
    const caixa = h('div', { class: 'wb-dialogo', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'wb-dlg-tit' },
      h('h2', { id: 'wb-dlg-tit' }, 'Excluir quadro?'),
      h('p', { class: 'wb-dialogo-msg' }, '“' + (q.nome || 'Quadro sem título') + '”' + (n ? ' e ' + (n === 1 ? 'o elemento dele será apagado' : 'os ' + n + ' elementos dele serão apagados') : ' será apagado') + '. Isso não pode ser desfeito.'),
      erro,
      h('div', { class: 'wb-dialogo-acoes' }, cancelar, ok));
    const veu = h('div', { class: 'wb-veu' }, caixa);
    const fechar = () => { if (W.dialogo !== veu) return; W.dialogo = null; veu.classList.add('saindo'); setTimeout(() => veu.remove(), reduzido() ? 0 : 160); try { W.el.palco.focus({ preventScroll: true }); } catch {} };
    cancelar.addEventListener('click', fechar);
    veu.addEventListener('pointerdown', (e) => { if (e.target === veu) fechar(); });
    ok.addEventListener('click', async () => {
      ok.disabled = cancelar.disabled = true;
      try { await excluirQuadro(q.id); fechar(); } catch (e) { erro.textContent = e.message; erro.hidden = false; ok.disabled = cancelar.disabled = false; ok.focus(); }
    });
    veu.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); fechar(); }
      else if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === cancelar ? ok : cancelar).focus(); }
    });
    W.dialogo = veu;
    W.raiz.append(veu);
    cancelar.focus();
  }

  // ═══════════════ 8. Tipos e ferramentas padrão ═══════════════
  function aplicarTraco(ctx, el) {
    const t = el.traco || {}, l = num(t.largura);
    if (l <= 0) return false;
    ctx.lineWidth = l; ctx.strokeStyle = el.cor; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.setLineDash(t.estilo === 'tracejado' ? [l * 4, l * 3] : t.estilo === 'pontilhado' ? [0.001, l * 2.5] : []);
    return true;
  }
  function registrarTipo(nome, def) {
    if (typeof nome !== 'string' || !def || typeof def !== 'object') throw new Error('registrarTipo(nome, def)');
    W.tipos.set(nome, def);
    W.htmlSujo = true; pedirQuadro();
  }
  function registrarFerramenta(nome, def) {
    if (typeof nome !== 'string' || !def || typeof def !== 'object') throw new Error('registrarFerramenta(nome, def)');
    if (def.tecla) def.tecla = String(def.tecla).toLowerCase();
    W.ferramentas.set(nome, def);
    montarBarra();
  }

  // Retângulo: referência mínima de tipo (a etapa 2 pode substituir com registrarTipo('retangulo', ...)).
  registrarTipo('retangulo', {
    desenhar(ctx, el) {
      const b = caixaNormal(el);
      ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h);
      if (el.preenchimento) { ctx.fillStyle = el.preenchimento; ctx.fill(); }
      if (aplicarTraco(ctx, el)) ctx.stroke();
    },
    testarClique(el, px, py, tol) {
      const b = caixaNormal(el);
      if (el.preenchimento) return dentro(b, px, py, tol);
      const m = tol + num(el.traco && el.traco.largura) / 2;
      return dentro(b, px, py, m) && !(b.w > 2 * m && b.h > 2 * m && dentro(b, px, py, -m));
    },
  });

  // ── Alças de seleção (tamanho constante na tela): 8 de redimensionar, 1 de rotação; linha de 2 pontos = 2 extremos ──
  const ALCA_ROT = 24, ALCA_MIN = 4, PASSO_ROT = Math.PI / 12;
  const DIRS = { nw: [-1, -1], ne: [1, -1], se: [1, 1], sw: [-1, 1], n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };
  const ehLinha2 = (el) => Array.isArray(el.pontos) && el.pontos.length === 2;
  function modeloAlcas() {
    if (W.ferramenta !== 'selecionar' || !W.sel.size || (S.arr && S.arr.moveu) || S.laco) return null;
    const sel = W.elementos.filter((el) => W.sel.has(el.id) && !travado(el));
    if (!sel.length) return null;
    const z = W.cam.zoom;
    if (sel.length === 1 && ehLinha2(sel[0])) {
      const el = sel[0], [cx, cy] = centro(el);
      const pts = el.pontos.map(([dx, dy]) => girarPonto(el.x + dx, el.y + dy, cx, cy, el.angulo));
      return { modo: 'linha', el, alcas: pts.map(([x, y], i) => ({ id: 'p' + i, idx: i, x, y })) };
    }
    const um = sel.length === 1 ? sel[0] : null;
    const b = um ? caixaBase(um) : uniao(sel);
    const ang = um ? um.angulo : 0, C = um ? centro(um) : [b.x + b.w / 2, b.y + b.h / 2];
    const pad = (um ? 4 : 8) / z, alcas = [];
    const loc = (lx, ly) => (ang ? girarPonto(lx, ly, C[0], C[1], ang) : [lx, ly]);
    for (const id of ['nw', 'ne', 'se', 'sw', 'rot', 'n', 'e', 's', 'w']) {
      if (id === 'rot') { const [x, y] = loc(b.x + b.w / 2, b.y - pad - ALCA_ROT / z); alcas.push({ id, rot: true, x, y }); continue; }
      const [dx, dy] = DIRS[id];
      if (dx === 0 && b.w * z < 28) continue;
      if (dy === 0 && b.h * z < 28) continue;
      const [x, y] = loc(b.x + b.w * (1 + dx) / 2 + dx * pad, b.y + b.h * (1 + dy) / 2 + dy * pad);
      alcas.push({ id, dx, dy, x, y });
    }
    return { modo: 'caixa', sel, um, b, ang, C, pad, alcas };
  }
  function hitAlca(sx, sy) {
    const m = modeloAlcas();
    if (!m) return null;
    const raio = m.modo === 'linha' ? 9 : 7;
    for (const a of m.alcas) {
      const t = mundoParaTela(a.x, a.y);
      if (Math.abs(t.sx - sx) <= raio && Math.abs(t.sy - sy) <= raio) return { m, a };
    }
    return null;
  }
  function desenharAlcas(ctx) {
    const m = modeloAlcas();
    if (!m) return;
    ctx.save();
    ctx.strokeStyle = W.cores.foco; ctx.fillStyle = '#fff'; ctx.lineWidth = 1.5;
    if (m.modo === 'caixa') {
      const r = m.alcas.find((a) => a.rot);
      const [tx, ty] = m.ang ? girarPonto(m.b.x + m.b.w / 2, m.b.y - m.pad, m.C[0], m.C[1], m.ang) : [m.b.x + m.b.w / 2, m.b.y - m.pad];
      const a = mundoParaTela(tx, ty), c = mundoParaTela(r.x, r.y);
      ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(c.sx, c.sy); ctx.stroke(); ctx.lineWidth = 1.5;
    }
    for (const al of m.alcas) {
      const t = mundoParaTela(al.x, al.y);
      ctx.beginPath();
      if (al.rot || m.modo === 'linha') ctx.arc(t.sx, t.sy, 4.5, 0, Math.PI * 2); else ctx.rect(t.sx - 4, t.sy - 4, 8, 8);
      ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
  function cursorAlca(h) {
    if (h.a.rot) return 'grab';
    if (h.m.modo === 'linha') return 'crosshair';
    const t = Math.atan2(h.a.dy, h.a.dx) + h.m.ang, k = ((Math.round(t / (Math.PI / 4)) % 4) + 4) % 4;
    return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][k];
  }
  const fotografar = (el) => ({ x: el.x, y: el.y, w: el.w, h: el.h, angulo: el.angulo, pontos: el.pontos ? JSON.parse(JSON.stringify(el.pontos)) : null, texto: el.texto ? { ...el.texto } : null });
  function iniciarAlca(h, p) {
    const m = h.m, orig = new Map();
    for (const el of (m.sel || [m.el])) orig.set(el.id, fotografar(el));
    S.alca = { m, a: h.a, orig, moveu: false, sx0: p.sx, sy0: p.sy, a0: m.C ? Math.atan2(p.y - m.C[1], p.x - m.C[0]) : 0 };
    W.cursorTemp = h.a.rot ? 'grabbing' : cursorAlca(h); atualizarCursor();
  }
  function moverAlca(p) {
    const A = S.alca, m = A.m;
    if (!A.moveu) { if (Math.hypot(p.sx - A.sx0, p.sy - A.sy0) < 2) return; A.moveu = true; }
    if (m.modo === 'linha') moverPonto(A, p);
    else if (A.a.rot) girarSelecao(A, p);
    else redimensionar(A, p, p.evento);
  }
  function moverPonto(A, p) {
    const el = W.porId.get(A.m.el.id), o = A.orig.get(el.id);
    const c0 = [o.x + o.w / 2, o.y + o.h / 2];
    const pw = o.pontos.map(([dx, dy]) => girarPonto(o.x + dx, o.y + dy, c0[0], c0[1], o.angulo));
    let [nx, ny] = [p.x, p.y];
    const fixo = pw[1 - A.a.idx];
    if (p.evento.shiftKey) { const d = Math.hypot(nx - fixo[0], ny - fixo[1]), an = Math.round(Math.atan2(ny - fixo[1], nx - fixo[0]) / PASSO_ROT) * PASSO_ROT; nx = fixo[0] + d * Math.cos(an); ny = fixo[1] + d * Math.sin(an); }
    pw[A.a.idx] = [nx, ny];
    const M = [(pw[0][0] + pw[1][0]) / 2, (pw[0][1] + pw[1][1]) / 2];
    const loc = pw.map(([x, y]) => (o.angulo ? girarPonto(x, y, M[0], M[1], -o.angulo) : [x, y]));
    const x0 = Math.min(loc[0][0], loc[1][0]), y0 = Math.min(loc[0][1], loc[1][1]);
    atualizar(el.id, { x: x0, y: y0, w: Math.abs(loc[0][0] - loc[1][0]), h: Math.abs(loc[0][1] - loc[1][1]), pontos: loc.map(([x, y]) => [x - x0, y - y0]) });
  }
  function girarSelecao(A, p) {
    const m = A.m, e = p.evento, [cx, cy] = m.C;
    let d = Math.atan2(p.y - cy, p.x - cx) - A.a0;
    if (m.um) {
      let n = A.orig.get(m.um.id).angulo + d;
      if (e.shiftKey) n = Math.round(n / PASSO_ROT) * PASSO_ROT;
      atualizar(m.um.id, { angulo: n });
      return;
    }
    if (e.shiftKey) d = Math.round(d / PASSO_ROT) * PASSO_ROT;
    for (const [id, o] of A.orig) {
      const [nx, ny] = girarPonto(o.x + o.w / 2, o.y + o.h / 2, cx, cy, d);
      atualizar(id, { x: nx - o.w / 2, y: ny - o.h / 2, angulo: o.angulo + d });
    }
  }
  function redimensionar(A, p, e) {
    const m = A.m, { b, ang, C, pad } = m, [dx, dy] = DIRS[A.a.id];
    const q = ang ? girarPonto(p.x, p.y, C[0], C[1], -ang) : [p.x, p.y];
    const bc = [b.x + b.w / 2, b.y + b.h / 2];
    const ax = e.altKey || dx === 0 ? bc[0] : dx > 0 ? b.x : b.x + b.w;
    const ay = e.altKey || dy === 0 ? bc[1] : dy > 0 ? b.y : b.y + b.h;
    const minx = b.w > 1e-6 ? ALCA_MIN / b.w : 0, miny = b.h > 1e-6 ? ALCA_MIN / b.h : 0;
    const fator = (d, borda, a, c, tam, min) => {
      if (d === 0 || tam <= 1e-6) return 1;
      const novo = e.altKey ? 2 * d * (borda - c) : d * (borda - a);
      return Math.max(novo / tam, min);
    };
    let sx = fator(dx, q[0] - dx * pad, ax, bc[0], b.w, minx);
    let sy = fator(dy, q[1] - dy * pad, ay, bc[1], b.h, miny);
    if (e.shiftKey || (m.um && m.um.tipo === 'texto' && m.um.texto)) {
      let s = dx && dy ? Math.max(sx, sy) : dx ? sx : sy;
      s = Math.max(s, minx, miny);
      sx = sy = s;
    }
    for (const [id, o] of A.orig) {
      const el = W.porId.get(id);
      if (!el) continue;
      const nc = [ax + (o.x + o.w / 2 - ax) * sx, ay + (o.y + o.h / 2 - ay) * sy];
      const cw = ang ? girarPonto(nc[0], nc[1], C[0], C[1], ang) : nc;
      const w = o.w * sx, h = o.h * sy;
      const campos = { x: cw[0] - w / 2, y: cw[1] - h / 2, w, h };
      if (o.pontos) campos.pontos = o.pontos.map(([px, py]) => [px * sx, py * sy]);
      if (el.tipo === 'texto' && o.texto && Number.isFinite(+o.texto.tamanho)) campos.texto = { ...o.texto, tamanho: Math.max(1, o.texto.tamanho * Math.sqrt(sx * sy)) };
      const t = W.tipos.get(el.tipo);
      if (t && typeof t.aoRedimensionar === 'function') {
        try { const r = t.aoRedimensionar(el, campos, nucleo); if (r && typeof r === 'object') Object.assign(campos, r); } catch (err) { console.warn('whiteboard: aoRedimensionar', el.tipo, err); }
      }
      atualizar(id, campos);
    }
  }

  // Selecionar: clique seleciona (Shift/Ctrl soma ou tira), arrastar move a seleção, arrastar no vazio faz o laço;
  // alças: redimensionar/girar (ver acima).
  const S = { arr: null, laco: null, alca: null };
  registrarFerramenta('selecionar', {
    rotulo: 'Selecionar', icone: 'selecionar', tecla: 'v', ordem: 10, cursor: 'default',
    aoDescer(p) {
      const e = p.evento, somar = e.shiftKey || e.ctrlKey || e.metaKey;
      const hal = hitAlca(p.sx, p.sy);
      if (hal) { iniciarAlca(hal, p); return; }
      const alvo = elementoEm(p.x, p.y);
      if (alvo) {
        const ids = membros(alvo);
        if (somar && W.sel.has(alvo.id)) { selecionar([...W.sel].filter((id) => !ids.includes(id))); return; }
        if (somar) selecionar([...W.sel, ...ids]);
        else if (!W.sel.has(alvo.id)) selecionar(ids);
        if (e.altKey && !somar && window.Whiteboard && window.Whiteboard.acoes && typeof window.Whiteboard.acoes.duplicar === 'function') { // Alt+arrastar: duplica a seleção e arrasta as cópias
          try { window.Whiteboard.acoes.duplicar(); } catch (err) { console.warn('whiteboard: duplicar', err); }
        }
        if (travado(alvo)) return; // travado: seleciona, mas arrastar não move nada nem inicia laço
        S.arr = { x0: p.x, y0: p.y, orig: new Map(W.elementos.filter((el) => W.sel.has(el.id) && !travado(el)).map((el) => [el.id, [el.x, el.y]])), moveu: false };
      } else {
        S.laco = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, base: somar ? new Set(W.sel) : new Set() };
        if (!somar) selecionar([]);
      }
    },
    aoMover(p) {
      if (S.alca) { moverAlca(p); return; }
      if (S.arr) {
        const dx = p.x - S.arr.x0, dy = p.y - S.arr.y0;
        if (!S.arr.moveu && Math.hypot(dx, dy) * W.cam.zoom < 3) return;
        S.arr.moveu = true;
        for (const [id, [x, y]] of S.arr.orig) { const el = W.porId.get(id); if (el) { el.x = x + dx; el.y = y + dy; } }
        mudouModelo();
      } else if (S.laco) {
        S.laco.x1 = p.x; S.laco.y1 = p.y;
        const r = { x: Math.min(S.laco.x0, p.x), y: Math.min(S.laco.y0, p.y), w: Math.abs(p.x - S.laco.x0), h: Math.abs(p.y - S.laco.y0) };
        const ids = new Set(S.laco.base);
        for (const el of W.elementos) {
          const c = caixaMundo(el);
          if (!travado(el) && c.x >= r.x && c.y >= r.y && c.x + c.w <= r.x + r.w && c.y + c.h <= r.y + r.h) for (const id of membros(el)) ids.add(id);
        }
        selecionar([...ids]);
      }
    },
    aoSubir() {
      if (S.alca) {
        if (S.alca.moveu) confirmar(S.alca.m.modo === 'linha' ? 'mover ponto' : S.alca.a.rot ? 'girar' : 'redimensionar');
        S.alca = null; W.cursorTemp = null; atualizarCursor();
      }
      if (S.arr && S.arr.moveu) confirmar('mover');
      S.arr = null; S.laco = null;
    },
    aoCancelar() {
      if (S.alca) {
        for (const [id, o] of S.alca.orig) if (W.porId.has(id)) atualizar(id, JSON.parse(JSON.stringify(o)));
        S.alca = null; W.cursorTemp = null; atualizarCursor();
      }
      if (S.arr && S.arr.moveu) { for (const [id, [x, y]] of S.arr.orig) { const el = W.porId.get(id); if (el) { el.x = x; el.y = y; } } mudouModelo(); }
      S.arr = null; S.laco = null;
    },
    aoPairar(p) {
      const hal = hitAlca(p.sx, p.sy);
      const c = hal ? cursorAlca(hal) : elementoEm(p.x, p.y) ? 'move' : null;
      if (c !== W.cursorTemp) { W.cursorTemp = c; atualizarCursor(); }
    },
    aoDesativar() { S.arr = null; S.laco = null; S.alca = null; },
    aoDesenhar(ctx) {
      if (!S.laco) return;
      const a = mundoParaTela(S.laco.x0, S.laco.y0), b = mundoParaTela(S.laco.x1, S.laco.y1);
      const x = Math.round(Math.min(a.sx, b.sx)) + 0.5, y = Math.round(Math.min(a.sy, b.sy)) + 0.5;
      const w = Math.round(Math.abs(b.sx - a.sx)), hh = Math.round(Math.abs(b.sy - a.sy));
      ctx.fillStyle = 'rgba(99, 102, 241, .08)'; ctx.fillRect(x, y, w, hh);
      ctx.strokeStyle = W.cores.acento; ctx.lineWidth = 1; ctx.strokeRect(x, y, w, hh);
    },
  });
  // Mão: arrastar move a câmera (o núcleo trata arrastaCamera; também vale botão do meio e Espaço + arrastar).
  registrarFerramenta('mao', { rotulo: 'Mão', icone: 'mao', tecla: 'h', ordem: 20, cursor: 'grab', arrastaCamera: true });

  // ═══════════════ 9. API ═══════════════
  const nucleo = Object.freeze({
    elementos: () => W.elementos, elemento: (id) => W.porId.get(id) || null,
    adicionar: (e) => { const el = adicionar(e); atualizarVazio(); return el; },
    atualizar, remover: (ids) => { remover(ids); atualizarVazio(); },
    selecao: () => [...W.sel], selecionar, elementoEm, caixaMundo,
    telaParaMundo, mundoParaTela, camera: () => ({ ...W.cam }), definirCamera, zoomEm, ajustar,
    confirmar: (r) => { confirmar(r); atualizarVazio(); }, redesenhar: () => { W.htmlSujo = true; pedirQuadro(); },
    cursor: (c) => { W.cursorTemp = c || null; atualizarCursor(); },
    ferramenta: () => W.ferramenta, definirFerramenta, on,
    tamanho: () => ({ w: W.larg, h: W.alt }), camadaHtml: () => W.el.html || null, cores: () => ({ ...W.cores }),
    estiloAtual, definirEstilo, travado, tipo: (nome) => W.tipos.get(nome) || null,
    desfazer, refazer, podeDesfazer, podeRefazer,
    util: Object.freeze({ aplicarTraco, caixaNormal, dentro, girarPonto }),
  });

  // Abre a vista: monta na 1ª vez, mede e abre o último quadro (ou o mais recente; sem nenhum, cria um).
  async function entrar(raiz) {
    if (!W.montado) { if (!raiz) return; montar(raiz); }
    W.ativo = true;
    emitir('ativo', { ativo: true });
    W.larg = 0; medir(); pedirQuadro();
    try { W.el.palco.focus({ preventScroll: true }); } catch {}
    if (W.inicio) return W.inicio;
    if (W.quadro) { carregarLista().catch(() => {}); return; }
    W.inicio = (async () => {
      try {
        const lista = await carregarLista();
        const ultimo = lerLS(LS_ULTIMO);
        const id = lista.some((q) => q.id === ultimo) ? ultimo : lista[0] && lista[0].id;
        if (id) await abrirQuadro(id); else await novoQuadro();
      } catch (e) { aviso(e.message); } finally { W.inicio = null; }
    })();
    return W.inicio;
  }
  // Sai da vista: para o desenho e grava o que faltar.
  async function sair() {
    if (!W.montado) return;
    W.ativo = false;
    emitir('ativo', { ativo: false });
    if (W.raf) cancelAnimationFrame(W.raf);
    W.raf = 0;
    pararAnimacao();
    if (W.gesto) cancelarGesto();
    W.toques.clear(); W.espaco = false;
    fecharPainel(false);
    await salvarAgora();
  }

  const API = {
    entrar, sair, salvarAgora, registrarTipo, registrarFerramenta, nucleo,
    abrirQuadro, novoQuadro, renomearQuadro, duplicarQuadro, excluirQuadro,
    quadro: () => (W.quadro ? { ...W.quadro } : null),
    quadros: () => (W.quadros ? W.quadros.map((q) => ({ ...q })) : null),
    estado: () => ({ ativo: W.ativo, ferramenta: W.ferramenta, status: W.el.status ? W.el.status.dataset.estado : '', pendente: pendente(), camera: { ...W.cam }, total: W.elementos.length, cadeados: W.cadeados || 0 }),
    // Módulos publicam seu objeto (Whiteboard.acoes, Whiteboard.setas…): define uma vez, nunca sobrescreve a API do núcleo.
    estender: (nome, obj) => {
      if (typeof nome !== 'string' || !nome || Object.prototype.hasOwnProperty.call(API, nome)) return false;
      Object.defineProperty(API, nome, { value: obj, enumerable: true, writable: false, configurable: false });
      return true;
    },
  };
  for (const k of Object.keys(API)) Object.defineProperty(API, k, { writable: false, configurable: false });
  window.Whiteboard = API;
})();
