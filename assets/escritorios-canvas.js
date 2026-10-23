/* Orbit — canvas de escritórios (Etapa 2).
   window.EscritoriosCanvas = { montar(el, {base, miniatura, tempoAlertaMs, onEntrar(id|'sessoes'), onCriar({x,y} já na vaga livre), onEditar(id), onDuplicar(id), onExcluir(id)}),
                                desmontar(), atualizar(ev SSE 'escritorio' {id, resumo|null, alerta?:{tipo:'aviso'|'pausa', texto}}), recarregar(), camera(),
                                aviso(texto, tipo='aviso'|'pausa') (faixa de alerta no topo), focar(id) (seleciona, foca e mostra o card) }
   Toque: segurar ~400 ms arma o arraste (antes disso o dedo move a vista); toque simples seleciona e mostra o card com "Entrar";
   duplo toque entra (no vazio, cria); pinça dá zoom; segurar e soltar sem mexer abre o menu.
   Mundo em px; um ladrilho por escritório (miniatura 240x150 + rodapé) e um ladrilho fixo "Sessões".
   Câmera: matemática copiada do Whiteboard (assets/whiteboard.js, seção "3. Câmera" e gestos). Estilo: assets/escritorios-canvas.css (prefixo esc-cv-).
   Dados: GET {base}/escritorios -> {escritorios:[resumo]}; POST {base}/escritorios/:id (cabeçalho x-gerenciador: 1) com {canvas:{x,y}} ou {nome}. */
(function () {
  'use strict';

  const TW = 240, TH = 200, MH = 150;      // ladrilho: largura, altura total, altura da miniatura (rodapé = 50)
  const GRADE = 20, ESPACO = 20;           // encaixe em px e intervalo mínimo entre ladrilhos
  const ZMIN = 0.25, ZMAX = 2;
  const LIMITE_MUNDO = 100000;
  const CHAVE_CAM = 'orbit.escritorios.canvas.cam';
  const CHAVE_SESSOES = 'orbit.escritorios.canvas.sessoes';
  const CX = TW + ESPACO, CY = TH + ESPACO; // passo de colisão (260 x 220)
  const TEMPO_ALERTA = 8000;               // um alerta 'aviso' se apaga sozinho; 'pausa' fica até fechar
  const HOLD_MS = 400, DUPLO_TOQUE_MS = 350, TOQUE_TOL = 8;
  const STATUS = { ociosa: 'Ociosa', rodando: 'Rodando', pausada: 'Pausada', concluida: 'Concluída', erro: 'Erro' };
  const MOTIVO = { 'orcamento-execucao': 'orçamento da execução', 'orcamento-dia': 'orçamento do dia', manual: 'manual' };
  const ESTADO = { trabalhando: 'Trabalhando', aguardando: 'Aguardando', ocioso: 'Ocioso', erro: 'Com erro', dormindo: 'Dormindo' };
  const MAIS_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="3.5" cy="8" r="1.4" fill="currentColor"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="12.5" cy="8" r="1.4" fill="currentColor"/></svg>';

  let C = null; // estado da montagem (uma só)

  // ───────────────────────── utilidades ─────────────────────────
  const limitar = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
  const snap = (v) => Math.round(v / GRADE) * GRADE;
  const reduzido = () => { try { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; } };
  const mundoOk = (v) => limitar(num(v), -LIMITE_MUNDO, LIMITE_MUNDO);

  function h(tag, attrs, ...filhos) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') e.className = v; else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const f of filhos) if (f !== null && f !== undefined && f !== false) e.append(f);
    return e;
  }

  // Todo listener passa por aqui: desmontar() remove todos.
  function ouvir(alvo, tipo, fn, opcoes) {
    alvo.addEventListener(tipo, fn, opcoes);
    const fim = () => alvo.removeEventListener(tipo, fn, opcoes);
    C.ouvintes.push(fim);
    return fim;
  }
  function chamar(nome, ...args) {
    const f = C && C.op && C.op[nome];
    if (typeof f !== 'function') return;
    try { f(...args); } catch (e) { console.error('EscritoriosCanvas: ' + nome + ' falhou:', e); }
  }
  function guardar(chave, valor) { try { localStorage.setItem(chave, JSON.stringify(valor)); } catch { /* sem armazenamento */ } }
  function ler(chave) { try { return JSON.parse(localStorage.getItem(chave) || 'null'); } catch { return null; } }

  const usd = (v) => {
    const n = num(v);
    if (n > 0 && n < 0.01) return 'menos de US$ 0,01';
    return 'US$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  // Estimado (parcela do Codex calculada pelos tokens): o valor ganha "≈" (também no "menos de US$ 0,01").
  const usdE = (v, est) => (est && num(v) > 0 ? '≈ ' + usd(v) : usd(v));
  // "≈" por linha: custo.estimadoExecucao / custo.estimadoDia quando existirem; senão custo.estimado nas duas.
  const estimadoDe = (c, chave) => (c && c[chave] !== undefined && c[chave] !== null ? !!c[chave] : !!(c && c.estimado));
  const dprAtual = () => Math.min(3, Math.max(1, Math.round(Number(window.devicePixelRatio) || 1)));
  let seqCard = 0;
  const achar = (id) => (C ? C.lista.find((r) => r.id === id) || null : null);
  const nomeDe = (id) => (id === 'sessoes' ? 'Sessões' : (achar(id) || {}).nome || id);

  function agentesDe(r) { return Array.isArray(r.agentes) ? r.agentes : []; }
  function totalAgentes(r) { const a = agentesDe(r).length; return a || num(r.membros) + 1; }
  function ativosDe(r) {
    if (Number.isFinite(r.ativos)) return r.ativos;
    return agentesDe(r).filter((a) => a.estado === 'trabalhando' || a.estado === 'aguardando').length;
  }
  const statusDe = (r) => (r.status && STATUS[r.status] ? r.status : r.status || 'ociosa');
  const textoStatus = (r) => STATUS[statusDe(r)] || String(statusDe(r));
  function motivoDe(r) {
    const m = r.motivoPausa || (r.pausa && r.pausa.motivo) || (r.execucao && r.execucao.motivoPausa) || '';
    return m ? MOTIVO[m] || String(m) : '';
  }
  const textoConvidados = (n) => (n === 1 ? '1 convidado' : n + ' convidados');

  // ───────────────────────── posições (grade, sem sobrepor) ─────────────────────────
  // Ocupação com hash espacial (células de 260 x 220): colide() olha só as 9 células vizinhas, então 100+ ladrilhos não pesam.
  const chaveCel = (a, b) => (a + 1000) * 2048 + (b + 1000);
  function ocupacao(pontos) {
    const oc = { g: new Map() };
    for (const p of pontos || []) somarOc(oc, p);
    return oc;
  }
  function somarOc(oc, p) {
    const k = chaveCel(Math.floor(p.x / CX), Math.floor(p.y / CY));
    const l = oc.g.get(k);
    if (l) l.push(p); else oc.g.set(k, [p]);
  }
  function colide(x, y, oc) {
    const a = Math.floor(x / CX), b = Math.floor(y / CY);
    for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) {
      const l = oc.g.get(chaveCel(a + da, b + db));
      if (l) for (const p of l) if (Math.abs(x - p.x) < CX && Math.abs(y - p.y) < CY) return true;
    }
    return false;
  }
  const ocupacaoSem = (id) => ocupacao([...C.pos].filter(([k]) => k !== id).map(([, p]) => p));

  // Deslocamentos em células de ladrilho (260 x 220), do centro para fora (direita antes da esquerda); gerados uma vez.
  let ESPIRAL = null;
  function espiral() {
    if (ESPIRAL) return ESPIRAL;
    const l = [], R = 30;
    for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) l.push([i, j, (i * 200) ** 2 + (j * 220) ** 2]);
    l.sort((a, b) => a[2] - b[2] || (a[1] < 0) - (b[1] < 0) || (a[0] < 0) - (b[0] < 0) || a[1] - b[1] || a[0] - b[0]);
    ESPIRAL = l;
    return l;
  }

  // Posição encaixada; se cair em cima de outro, o espaço livre mais próximo (anéis em volta, em células da grade).
  // semOrigem: (0,0) vale "sem posição" no servidor, então um escritório nunca é posto nele.
  function maisLivre(x, y, oc, semOrigem) {
    const livre = (cx, cy) => !(semOrigem && cx === 0 && cy === 0) && !colide(cx, cy, oc);
    x = snap(mundoOk(x)); y = snap(mundoOk(y));
    if (livre(x, y)) return { x, y };
    let melhor = null, limite = 60;
    for (let r = 1; r <= limite; r++) {
      for (let i = -r; i <= r; i++) {
        const passo = Math.abs(i) === r ? 1 : 2 * r;
        for (let j = -r; j <= r; j += passo) {
          const cx = x + i * GRADE, cy = y + j * GRADE;
          if (!livre(cx, cy)) continue;
          const d = i * i + j * j;
          if (!melhor || d < melhor.d) melhor = { x: cx, y: cy, d };
        }
      }
      if (melhor && limite === 60) limite = Math.min(60, Math.ceil(r * 1.4143) + 1); // um candidato do anel seguinte pode estar mais perto
    }
    if (melhor) return { x: melhor.x, y: melhor.y };
    for (const [i, j] of espiral()) { // muito cheio em volta: passo de ladrilho inteiro
      const cx = snap(x + i * CX), cy = snap(y + j * CY);
      if (livre(cx, cy)) return { x: cx, y: cy };
    }
    return { x, y };
  }
  // Vaga para um escritório novo ou arrastado: nunca em cima de outro e nunca em (0,0).
  const vagaLivre = (x, y) => maisLivre(x, y, ocupacao([...C.pos.values()]), true);

  function canvasDe(r) {
    const c = r.canvas;
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return null;
    if (c.x === 0 && c.y === 0) return null; // padrão do servidor = ainda sem posição própria
    return { x: mundoOk(c.x), y: mundoOk(c.y) };
  }

  // Ordem estável de quem chegou primeiro: `criado` (quando o resumo trouxer), senão a ordem em que o canvas viu o escritório
  // (primeira carga: por id; depois, quem aparece fica por último). NUNCA `atualizado`.
  const cmpCriado = (a, b) => (a.criado && b.criado && a.criado !== b.criado ? (a.criado < b.criado ? -1 : 1) : 0);
  function numerar() {
    const novos = C.lista.filter((r) => !C.visto.has(r.id));
    if (!novos.length) return;
    novos.sort((a, b) => cmpCriado(a, b) || (a.id < b.id ? -1 : 1));
    for (const r of novos) C.visto.set(r.id, ++C.nVisto);
  }
  const cmpOrdem = (a, b) => cmpCriado(a, b) || (C.visto.get(a.id) || 0) - (C.visto.get(b.id) || 0);

  function sigLayout() {
    let s = C.sessoes ? C.sessoes.x + ',' + C.sessoes.y : '-';
    for (const r of C.lista) { const c = r.canvas; s += ';' + r.id + '|' + (c ? c.x + ',' + c.y : '') + '|' + (r.criado || ''); }
    return s;
  }

  // Posições resolvidas de todos: Sessões (se guardada) e os escritórios com posição primeiro, em ordem estável (quem chegou
  // antes fica; o outro vai ao livre mais próximo); depois os sem posição, nas vagas de ladrilho inteiro a partir da origem.
  function recalcular() {
    const oc = ocupacao([]), pos = new Map();
    const por = (id, x, y, esc) => { const p = maisLivre(x, y, oc, esc); somarOc(oc, p); pos.set(id, p); };
    const itens = C.lista.map((r) => ({ id: r.id, des: canvasDe(r), r })).sort((a, b) => cmpOrdem(a.r, b.r));
    if (C.sessoes) por('sessoes', C.sessoes.x, C.sessoes.y, false);
    for (const it of itens) if (it.des) por(it.id, it.des.x, it.des.y, true);
    let k = 0;
    const vaga = (id) => {
      const lista = espiral(), esc = id !== 'sessoes';
      for (; k < lista.length; k++) {
        const x = lista[k][0] * CX, y = lista[k][1] * CY;
        if (esc && x === 0 && y === 0) continue;
        if (!colide(x, y, oc)) { const p = { x, y }; somarOc(oc, p); pos.set(id, p); k++; return; }
      }
      por(id, 0, 0, esc);
    };
    if (!C.sessoes) vaga('sessoes');
    for (const it of itens) if (!it.des) vaga(it.id);
    C.pos = pos;
  }

  // ───────────────────────── câmera (copiada do Whiteboard) ─────────────────────────
  const telaParaMundo = (sx, sy) => ({ x: sx / C.cam.zoom + C.cam.x, y: sy / C.cam.zoom + C.cam.y });

  function pintarCamera() {
    const { x, y, zoom: z } = C.cam, v = C.ui.vista;
    C.ui.mundo.style.transform = `translate(${-x * z}px, ${-y * z}px) scale(${z})`;
    let passo = GRADE * z;
    while (passo < 14) passo *= 2;
    v.style.backgroundSize = `${passo}px ${passo}px`;
    v.style.backgroundPosition = `${-x * z - passo / 2}px ${-y * z - passo / 2}px`;
    C.ui.zoomRot.textContent = Math.round(z * 100) + '%';
    if (z > 1) C.ui.raiz.dataset.amp = '1'; else delete C.ui.raiz.dataset.amp; // ampliado: miniatura em pixels nítidos (CSS)
    C.ui.mais.disabled = z >= ZMAX - 1e-6;
    C.ui.menos.disabled = z <= ZMIN + 1e-6;
  }
  function agendarSalvarCam() {
    clearTimeout(C.timerCam);
    C.timerCam = setTimeout(salvarCam, 250);
  }
  function salvarCam() {
    if (!C) return;
    clearTimeout(C.timerCam); C.timerCam = 0;
    guardar(CHAVE_CAM, { x: C.cam.x, y: C.cam.y, zoom: C.cam.zoom });
  }
  function aplicarCamera(c, salvar = true) {
    C.cam = { x: num(c.x), y: num(c.y), zoom: limitar(num(c.zoom, 1), ZMIN, ZMAX) };
    pintarCamera();
    if (salvar) agendarSalvarCam();
    esconderCard();
  }
  function pararAnim() { if (C && C.anim) cancelAnimationFrame(C.anim); if (C) C.anim = 0; }
  // Transição suave: zoom interpolado em escala log e centro da vista em linha reta no mundo.
  function definirCamera(c, { animar = false, dur = 260 } = {}) {
    const alvo = { x: num(c.x), y: num(c.y), zoom: limitar(num(c.zoom, 1), ZMIN, ZMAX) };
    pararAnim();
    if (!animar || reduzido() || !C.larg) { aplicarCamera(alvo); return; }
    const de = { ...C.cam }, t0 = performance.now(), mw = C.larg / 2, mh = C.alt / 2;
    const c0 = [de.x + mw / de.zoom, de.y + mh / de.zoom], c1 = [alvo.x + mw / alvo.zoom, alvo.y + mh / alvo.zoom];
    const lerp = (a, b, k) => a + (b - a) * k;
    const passo = (t) => {
      if (!C) return;
      const k = limitar((t - t0) / dur, 0, 1), e = 1 - Math.pow(1 - k, 3);
      if (k >= 1) { C.anim = 0; aplicarCamera(alvo); return; }
      const z = Math.exp(lerp(Math.log(de.zoom), Math.log(alvo.zoom), e));
      aplicarCamera({ x: lerp(c0[0], c1[0], e) - mw / z, y: lerp(c0[1], c1[1], e) - mh / z, zoom: z });
      C.anim = requestAnimationFrame(passo);
    };
    C.anim = requestAnimationFrame(passo);
  }
  // Zoom mantendo o ponto (sx, sy) da vista parado sob o ponteiro.
  function zoomEm(z, sx = C.larg / 2, sy = C.alt / 2, animar = false) {
    const zz = limitar(z, ZMIN, ZMAX), m = telaParaMundo(sx, sy);
    definirCamera({ x: m.x - sx / zz, y: m.y - sy / zz, zoom: zz }, { animar });
  }
  const zoomPasso = (f) => zoomEm(C.cam.zoom * f, C.larg / 2, C.alt / 2, true);

  function ajustar(animar = true) {
    if (!C.larg || !C.alt) { C.pendAjuste = true; return; }
    C.pendAjuste = false;
    const rs = [...C.pos.values()].map((p) => ({ x: p.x, y: p.y, w: TW, h: TH }));
    if (!rs.length) return definirCamera({ x: -C.larg / 2, y: -C.alt / 2, zoom: 1 }, { animar });
    const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
    const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
    // Sem escritórios: reserva espaço à direita do ladrilho Sessões para a mensagem central.
    const b = { x: x0, y: y0, w: Math.max(x1 - x0, C.lista.length ? 0 : TW * 4), h: y1 - y0 };
    const mx = 64, mTopo = 72, mBase = 64;
    const z = limitar(Math.min((C.larg - 2 * mx) / Math.max(b.w, 1), (C.alt - mTopo - mBase) / Math.max(b.h, 1), 1), ZMIN, ZMAX);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    definirCamera({ x: cx - C.larg / 2 / z, y: cy - (mTopo + (C.alt - mTopo - mBase) / 2) / z, zoom: z }, { animar });
  }

  function garantirVisivel(id) {
    const p = C.pos.get(id);
    if (!p || !C.larg) return;
    const z = C.cam.zoom, m = 24, topo = 64;
    let { x, y } = C.cam;
    const vw = C.larg / z, vh = C.alt / z;
    if (p.x < x + m / z) x = p.x - m / z; else if (p.x + TW > x + vw - m / z) x = p.x + TW - vw + m / z;
    if (p.y < y + topo / z) y = p.y - topo / z; else if (p.y + TH > y + vh - m / z) y = p.y + TH - vh + m / z;
    if (x !== C.cam.x || y !== C.cam.y) aplicarCamera({ x, y, zoom: z });
  }

  // ───────────────────────── interface ─────────────────────────
  function criarUI() {
    const u = {};
    u.novo = h('button', { type: 'button', class: 'esc-cv-btn esc-cv-solido' }, 'Novo escritório');
    u.ajustar = h('button', { type: 'button', class: 'esc-cv-btn', 'aria-label': 'Ajustar a vista a todos os ladrilhos' }, 'Ajustar');
    u.menos = h('button', { type: 'button', class: 'esc-cv-btn esc-cv-icone', 'aria-label': 'Afastar' }, '−');
    u.zoomRot = h('span', { class: 'esc-cv-zoom', 'aria-hidden': 'true' }, '100%');
    u.mais = h('button', { type: 'button', class: 'esc-cv-btn esc-cv-icone', 'aria-label': 'Aproximar' }, '+');
    u.barra = h('div', { class: 'esc-cv-barra', role: 'toolbar', 'aria-label': 'Canvas de escritórios' },
      h('span', { class: 'esc-cv-titulo' }, 'Escritórios'), u.novo, h('span', { class: 'esc-cv-sep' }), u.ajustar, u.menos, u.zoomRot, u.mais);

    u.mundo = h('div', { class: 'esc-cv-mundo' });
    u.alvo = h('div', { class: 'esc-cv-alvo', hidden: true });
    u.mundo.append(u.alvo);
    u.vista = h('div', { class: 'esc-cv-vista', role: 'region', 'aria-label': 'Canvas de escritórios: arraste o fundo para mover, role para deslocar, Ctrl e roda para ampliar' }, u.mundo);

    u.card = h('div', { class: 'esc-cv-card', id: 'esc-cv-card-' + (++seqCard), role: 'tooltip', hidden: true });
    u.vazioTitulo = h('p', { class: 'esc-cv-vazio-tit' });
    u.vazioSub = h('p', { class: 'esc-cv-vazio-sub' });
    u.vazioNovo = h('button', { type: 'button', class: 'esc-cv-btn esc-cv-solido' }, 'Novo escritório');
    u.vazioTentar = h('button', { type: 'button', class: 'esc-cv-btn', hidden: true }, 'Tentar de novo');
    u.vazio = h('div', { class: 'esc-cv-vazio', hidden: true }, u.vazioTitulo, u.vazioSub, h('div', { class: 'esc-cv-vazio-acoes' }, u.vazioNovo, u.vazioTentar));
    u.aviso = h('div', { class: 'esc-cv-aviso', role: 'status', 'aria-live': 'polite', hidden: true });

    u.alertaTxt = h('button', { type: 'button', class: 'esc-cv-alerta-txt' });
    u.alertaFechar = h('button', { type: 'button', class: 'esc-cv-alerta-fechar', 'aria-label': 'Fechar aviso' }, '×');
    u.alerta = h('div', { class: 'esc-cv-alerta', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', hidden: true }, u.alertaTxt, u.alertaFechar);

    // barra antes da vista: Tab chega nos botões primeiro e os ladrilhos (um só tab stop) vêm depois
    u.raiz = h('div', { class: 'esc-cv', 'data-mini': 'carregando' }, u.barra, u.vista, u.vazio, u.card, u.alerta, u.aviso);
    return u;
  }

  function aviso(texto) {
    const a = C.ui.aviso;
    clearTimeout(C.timerAviso);
    a.textContent = texto || '';
    a.hidden = !texto;
    if (texto) C.timerAviso = setTimeout(() => { if (C) { C.ui.aviso.hidden = true; C.timerAviso = 0; } }, 6000);
  }

  // ── ladrilhos ──
  function criarLadrilho(id) {
    const sess = id === 'sessoes';
    const t = { id };
    t.cv = h('canvas', { class: 'esc-cv-mini', width: TW * C.dpr, height: MH * C.dpr, 'aria-hidden': 'true' });
    t.nome = h('span', { class: 'esc-cv-nome' });
    // "⋯" fora da ordem de Tab (o ladrilho é o único tab stop): pelo teclado o menu abre com a tecla de menu, Shift+F10 ou Alt+Seta para baixo
    t.mais = h('button', { type: 'button', class: 'esc-cv-mais', 'aria-haspopup': 'menu', tabindex: '-1' });
    t.mais.innerHTML = MAIS_SVG;
    t.pontos = h('span', { class: 'esc-cv-pontos' });
    t.pilula = h('span', { class: 'esc-cv-pilula' });
    t.sub = h('span', { class: 'esc-cv-sub' }, 'Office de sempre');
    t.selo = h('span', { class: 'esc-cv-selo', 'aria-hidden': 'true', hidden: true });
    t.el = h('div', { class: 'esc-cv-ladrilho' + (sess ? ' esc-cv-sessoes' : ''), role: 'button', 'aria-roledescription': sess ? 'atalho' : 'escritório', tabindex: '-1', 'data-id': id },
      t.cv, t.selo,
      h('div', { class: 'esc-cv-rodape' },
        h('div', { class: 'esc-cv-linha' }, t.nome, t.mais),
        h('div', { class: 'esc-cv-linha' }, ...(sess ? [t.sub] : [t.pontos, t.pilula]))));
    return t;
  }

  function pintarLadrilho(t, r) {
    if (t.id === 'sessoes') {
      t.nome.textContent = 'Sessões';
      t.mais.setAttribute('aria-label', 'Mais ações de Sessões');
      t.el.setAttribute('aria-label', 'Sessões. Abre o Office de sempre, com os times e as sessões fora de escritório. Enter para entrar; tecla de menu para mais ações.');
      return;
    }
    const st = statusDe(r), ativos = ativosDe(r), total = totalAgentes(r), conv = num(r.convidados);
    t.nome.textContent = r.nome || r.id;
    t.el.dataset.status = st;
    t.mais.setAttribute('aria-label', 'Mais ações de ' + (r.nome || r.id));
    t.pilula.textContent = textoStatus(r);
    t.pilula.dataset.status = st;
    const ags = agentesDe(r), vis = ags.slice(0, 12);
    t.pontos.replaceChildren(...vis.map((a) => {
      const est = ESTADO[a.estado] ? a.estado : 'ocioso';
      const p = h('span', { class: 'esc-cv-ponto', 'data-estado': est, title: `${a.nome || a.id} · ${a.papel || 'agente'} · ${ESTADO[est]}${a.provedor === 'codex' ? ' · Codex' : ''}` });
      return p;
    }));
    if (ags.length > vis.length) t.pontos.append(h('span', { class: 'esc-cv-mais-n' }, '+' + (ags.length - vis.length)));
    if (conv > 0) t.pontos.append(h('span', { class: 'esc-cv-conv', title: textoConvidados(conv) + ' ativos' }, '+' + conv));
    const motivo = st === 'pausada' ? motivoDe(r) : '';
    t.rotulo = `Escritório ${r.nome || r.id}. ${textoStatus(r)}${motivo ? ' (' + motivo + ')' : ''}. ${ativos} de ${total} ${total === 1 ? 'agente ativo' : 'agentes ativos'}${conv ? ', ' + textoConvidados(conv) : ''}. Enter para entrar; tecla de menu para mais ações.`;
    pintarMarca(t.id);
  }

  // Marca do ladrilho (alerta do servidor): data-alerta + selo + texto no rótulo acessível, até o status mudar.
  function pintarMarca(id) {
    const t = C.tiles.get(id);
    if (!t || id === 'sessoes') return;
    const m = C.marcas.get(id), rot = m ? (m.tipo === 'pausa' ? 'Pausa' : 'Aviso') : '';
    if (m) t.el.dataset.alerta = m.tipo; else delete t.el.dataset.alerta;
    t.selo.hidden = !m;
    t.selo.textContent = rot;
    if (t.rotulo) t.el.setAttribute('aria-label', m ? `${t.rotulo} ${rot}: ${m.texto}.` : t.rotulo);
  }

  function fecharAlerta() {
    if (!C) return;
    clearTimeout(C.timerAlerta); C.timerAlerta = 0;
    C.alerta = null;
    C.ui.alerta.hidden = true;
  }
  function mostrarAlerta(tipo, texto, id) {
    const u = C.ui, a = { tipo, texto, id: id || null };
    clearTimeout(C.timerAlerta); C.timerAlerta = 0;
    C.alerta = a;
    u.alerta.dataset.tipo = tipo;
    u.alerta.setAttribute('role', tipo === 'pausa' ? 'alert' : 'status');
    u.alerta.setAttribute('aria-live', tipo === 'pausa' ? 'assertive' : 'polite');
    u.alertaTxt.textContent = texto;
    u.alertaTxt.disabled = !a.id || a.id === 'sessoes';
    u.alerta.hidden = false;
    if (a.id && a.id !== 'sessoes') {
      const r = achar(a.id);
      C.marcas.set(a.id, { tipo, texto, status: r ? statusDe(r) : '' });
      pintarMarca(a.id);
    }
    if (tipo === 'aviso') C.timerAlerta = setTimeout(() => { if (C && C.alerta === a) fecharAlerta(); }, C.tempoAlerta);
  }

  // Seleciona, leva à vista, foca e mostra o card do ladrilho. false se o ladrilho não existe.
  function focar(id) {
    if (!C || typeof id !== 'string') return false;
    const t = C.tiles.get(id);
    if (!t) return false;
    selecionar(id); garantirVisivel(id);
    t.el.focus({ preventScroll: true });
    mostrarCard(id);
    return true;
  }

  function posicionar(t, p) {
    if (!p) return;
    t.el.style.left = p.x + 'px';
    t.el.style.top = p.y + 'px';
    t.el.dataset.x = p.x;
    t.el.dataset.y = p.y;
  }

  function desenharMini(t) {
    if (!C.mini) return;
    // o canvas tem TW×MH × devicePixelRatio pixels e aparece em TW×MH CSS px; a miniatura vem na mesma resolução
    const cw = TW * C.dpr, ch = MH * C.dpr;
    if (t.cv.width !== cw || t.cv.height !== ch) { t.cv.width = cw; t.cv.height = ch; }
    try { t.cv.getContext('2d').drawImage(C.mini, 0, 0, cw, ch); } catch { /* fundo liso */ }
  }

  // Pede a miniatura em largura×altura × devicePixelRatio (arredondado, teto 3). Se o ratio mudar (zoom do navegador, outra tela),
  // pede de novo; enquanto isso a anterior segue na tela.
  function carregarMini() {
    const c = C, d = dprAtual();
    c.dpr = d;
    Promise.resolve()
      .then(() => (typeof c.op.miniatura === 'function' ? c.op.miniatura({ largura: TW * d, altura: MH * d }) : null))
      .then((cv) => {
        if (c !== C || c.dpr !== d) return;
        if (cv && cv.width > 0 && cv.height > 0) {
          c.mini = cv;
          for (const t of c.tiles.values()) desenharMini(t);
          c.ui.raiz.dataset.mini = cv.dataset && cv.dataset.mapa ? cv.dataset.mapa : 'ok';
        } else if (!c.mini) c.ui.raiz.dataset.mini = 'liso';
      })
      .catch(() => { if (c === C && !c.mini) c.ui.raiz.dataset.mini = 'liso'; });
  }
  function aoRedimensionarJanela() { if (C && dprAtual() !== C.dpr) carregarMini(); }

  // Tabindex itinerante: só o ladrilho atual (último focado, senão Sessões) entra na ordem de Tab; as setas movem entre os demais.
  function ajustarTab(id) {
    if (id && C.tiles.has(id)) C.tabId = id;
    if (!C.tiles.has(C.tabId)) C.tabId = C.tiles.has('sessoes') ? 'sessoes' : ([...C.tiles.keys()][0] || '');
    for (const [k, t] of C.tiles) {
      const v = k === C.tabId ? '0' : '-1';
      if (t.el.getAttribute('tabindex') !== v) t.el.setAttribute('tabindex', v);
    }
  }
  // O card é descrição do ladrilho a que pertence, enquanto estiver visível.
  function ligarCard() {
    for (const [k, t] of C.tiles) {
      if (!C.ui.card.hidden && k === C.cardId) t.el.setAttribute('aria-describedby', C.ui.card.id);
      else if (t.el.hasAttribute('aria-describedby')) t.el.removeAttribute('aria-describedby');
    }
  }

  function arrastandoId() { return C.gesto && C.gesto.tipo === 'tile' && C.gesto.movido ? C.gesto.id : null; }

  // Incremental: só repinta o ladrilho cujo resumo mudou (JSON) e só reposiciona quem mudou de lugar. `somente` = ids que
  // acabaram de mudar (SSE/renomear/arrastar); sem ele (carga, remontar) confere todos, mas ainda sem repintar os iguais.
  function sincronizar(somente) {
    if (!C) return;
    numerar();
    let layout = false;
    const sig = sigLayout();
    if (sig !== C.sigLayout) { recalcular(); C.sigLayout = sig; layout = true; }
    if (fixarSessoes()) { C.sigLayout = sigLayout(); layout = true; }
    const ids = new Set(['sessoes']);
    for (const r of C.lista) ids.add(r.id);
    for (const [id, t] of C.tiles) {
      if (ids.has(id)) continue;
      if (C.menu && C.menu.id === id) fecharMenu(false);
      if (C.cardId === id) esconderCard();
      if (C.sel === id) C.sel = null;
      if (C.gesto && C.gesto.id === id) { C.gesto = null; C.ui.alvo.hidden = true; }
      C.voando.delete(id); C.nomeando.delete(id); C.marcas.delete(id);
      if (C.alerta && C.alerta.id === id) fecharAlerta();
      t.el.remove(); C.tiles.delete(id);
    }
    const arr = arrastandoId();
    let mudouCard = layout;
    for (const id of ids) {
      let t = C.tiles.get(id), novoT = false;
      if (!t) {
        t = criarLadrilho(id); C.tiles.set(id, t); C.ui.mundo.append(t.el); desenharMini(t); novoT = true;
        t.el.classList.toggle('esc-cv-sel', C.sel === id);
      }
      if (novoT || !somente || somente.has(id)) {
        const r = id === 'sessoes' ? null : achar(id);
        const js = r ? JSON.stringify(r) : '';
        if (t.sig !== js || novoT) { t.sig = js; pintarLadrilho(t, r); if (C.cardId === id) mudouCard = true; }
      }
      if (id !== arr) {
        const p = C.pos.get(id);
        if (p && (t.px !== p.x || t.py !== p.y)) { posicionar(t, p); t.px = p.x; t.py = p.y; }
      }
    }
    if (C.cardId && achar(C.cardId)) { if (mudouCard) mostrarCard(C.cardId); } else if (C.cardId && C.cardId !== 'sessoes') esconderCard();
    const vazio = C.carregado && !C.lista.length;
    if (C.ui.vazio.hidden === vazio) {
      C.ui.vazio.hidden = !vazio;
      if (vazio) {
        C.ui.vazioTitulo.textContent = C.erroCarga ? 'Não foi possível carregar os escritórios' : 'Nenhum escritório ainda';
        C.ui.vazioSub.textContent = C.erroCarga ? 'Confira a conexão com o servidor e tente de novo.' : 'Crie o primeiro para reunir agentes numa mesma tarefa.';
        C.ui.vazioTentar.hidden = !C.erroCarga;
      }
    }
    const qtd = String(C.lista.length);
    if (C.ui.raiz.dataset.qtd !== qtd) C.ui.raiz.dataset.qtd = qtd;
    if (C.ajusteInicial && C.carregado && C.larg) { C.ajusteInicial = false; ajustar(false); }
    ajustarTab();
    if (C.cardId) ligarCard();
    persistirPosicoes();
  }

  // Sessões sem posição guardada: assim que a lista chega, a vaga calculada vira a posição guardada (nunca mais reembaralha).
  function fixarSessoes() {
    if (C.sessoes || !C.carregado || C.erroCarga) return false;
    const p = C.pos.get('sessoes');
    if (!p) return false;
    C.sessoes = { x: p.x, y: p.y };
    guardar(CHAVE_SESSOES, C.sessoes);
    return true;
  }

  // Posição calculada pelo canvas (escritório sem posição ou empurrado por colisão) é gravada UMA vez no servidor, em fila
  // serial; assim a vila não reembaralha depois e outro cliente enxerga o mesmo lugar. Falha: silenciosa (não repete).
  function persistirPosicoes() {
    if (!C.carregado || C.erroCarga) return;
    const arr = arrastandoId();
    for (const r of C.lista) {
      const p = C.pos.get(r.id);
      if (!p || r.id === arr || C.voando.has(r.id)) continue;
      const c = r.canvas;
      if (c && c.x === p.x && c.y === p.y) continue;
      const chave = p.x + ',' + p.y;
      if (C.auto.get(r.id) === chave) continue;
      C.auto.set(r.id, chave);
      C.fila = C.fila.filter((f) => f.id !== r.id);
      C.fila.push({ id: r.id, x: p.x, y: p.y });
    }
    if (C.fila.length && !C.filaRodando) rodarFila();
  }
  async function rodarFila() {
    const c = C;
    c.filaRodando = true;
    while (c === C && c.fila.length) {
      const f = c.fila.shift(), r = achar(f.id), p = c.pos.get(f.id);
      if (!r || !p || c.voando.has(f.id) || arrastandoId() === f.id) continue;
      try {
        await postar(f.id, { canvas: { x: p.x, y: p.y } });
        if (c !== C) return;
        const a = achar(f.id);
        if (a && !c.voando.has(f.id)) { a.canvas = { x: p.x, y: p.y }; sincronizar(new Set([f.id])); }
      } catch { /* silencioso: a posição só fica local */ }
    }
    if (c === C) c.filaRodando = false;
  }

  function selecionar(id) {
    C.sel = id || null;
    for (const [k, t] of C.tiles) t.el.classList.toggle('esc-cv-sel', k === C.sel);
  }

  // ── card de resumo ──
  function mostrarCard(id, toque) {
    const card = C.ui.card;
    if (toque === undefined) toque = C.cardId === id && C.cardToque;
    const r = id === 'sessoes' ? null : achar(id);
    if (id !== 'sessoes' && !r) return esconderCard();
    const linha = (rot, ...v) => [h('dt', {}, rot), h('dd', {}, ...v)];
    const itens = [];
    if (!r) {
      card.replaceChildren(h('div', { class: 'esc-cv-card-tit' }, 'Sessões'),
        h('p', { class: 'esc-cv-card-fn' }, 'Entra no Office de sempre, com os times e as sessões que não pertencem a nenhum escritório.'));
    } else {
      const st = statusDe(r), conv = num(r.convidados), c = r.custo || {};
      const motivo = st === 'pausada' ? motivoDe(r) : '';
      itens.push(...linha('Agentes', `${ativosDe(r)} de ${totalAgentes(r)} ativos`, conv > 0 ? ` · ${textoConvidados(conv)}` : ''));
      itens.push(...linha('Status', textoStatus(r) + (motivo ? ` · ${motivo}` : '')));
      const sp = Array.isArray(c.semPreco) && c.semPreco.length ? ' Sem preço cadastrado (cobrado pelo mais alto): ' + c.semPreco.join(', ') + '.' : '';
      const custoLinha = (rot, v, lim, est) => {
        const l = linha(rot, lim > 0 ? `${usdE(v, est)} de ${usd(lim)}` : usdE(v, est));
        const tit = (est ? 'Inclui estimativa do Codex pelos tokens.' : '') + sp;
        if (tit) l[1].title = tit.trim();
        return l;
      };
      itens.push(...custoLinha('Execução', c.execucaoUsd, c.limiteExecucaoUsd, estimadoDe(c, 'estimadoExecucao')));
      itens.push(...custoLinha('Dia', c.diaUsd, c.limiteDiaUsd, estimadoDe(c, 'estimadoDia')));
      itens.push(...linha('Plano', num(c.planoPct).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%'));
      card.replaceChildren(h('div', { class: 'esc-cv-card-tit' }, r.nome || r.id),
        r.funcao ? h('p', { class: 'esc-cv-card-fn' }, r.funcao) : null,
        h('dl', { class: 'esc-cv-card-dl', 'data-status': st }, ...itens));
    }
    C.cardToque = !!toque;
    card.classList.toggle('esc-cv-card-toque', !!toque);
    if (toque) {
      card.setAttribute('role', 'group'); card.setAttribute('aria-label', 'Resumo de ' + nomeDe(id));
      const ent = h('button', { type: 'button', class: 'esc-cv-btn esc-cv-solido esc-cv-card-entrar' }, 'Entrar');
      ent.addEventListener('click', () => { esconderCard(); chamar('onEntrar', id); });
      card.append(ent);
    } else { card.setAttribute('role', 'tooltip'); card.removeAttribute('aria-label'); }
    card.hidden = false;
    C.cardId = id;
    ligarCard();
    const t = C.tiles.get(id);
    if (t) posCard(t.el);
  }
  function posCard(tile) {
    const card = C.ui.card, rr = C.ui.raiz.getBoundingClientRect(), tr = tile.getBoundingClientRect();
    const w = card.offsetWidth, hh = card.offsetHeight, m = 8, gap = 12;
    let x = tr.right - rr.left + gap;
    if (x + w > rr.width - m) x = tr.left - rr.left - gap - w;
    x = limitar(x, m, Math.max(m, rr.width - w - m));
    const y = limitar(tr.top - rr.top, m, Math.max(m, rr.height - hh - m));
    card.style.left = x + 'px';
    card.style.top = y + 'px';
  }
  function esconderCard() {
    if (!C) return;
    C.cardId = ''; C.cardToque = false;
    C.ui.card.hidden = true;
    ligarCard();
  }

  // ───────────────────────── dados ─────────────────────────
  async function postar(id, corpo) {
    const r = await fetch(`${C.base}/escritorios/${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify(corpo),
    });
    let j = null;
    try { j = await r.json(); } catch { /* sem corpo */ }
    if (!r.ok) throw new Error((j && typeof j.erro === 'string' && j.erro) || `Erro ${r.status} no servidor.`);
    return j;
  }

  async function recarregar() {
    const c = C;
    if (!c) return;
    const n = ++c.seq;
    let lista = null, falha = '';
    try {
      const r = await fetch(c.base + '/escritorios', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      lista = Array.isArray(j && j.escritorios) ? j.escritorios.filter((x) => x && typeof x.id === 'string') : [];
    } catch { falha = 'Não foi possível carregar os escritórios.'; }
    if (c !== C || n !== c.seq) return;
    if (lista) c.lista = lista;
    c.erroCarga = falha;
    c.carregado = true;
    if (falha && c.lista.length) aviso(falha);
    sincronizar();
  }

  function atualizar(ev) {
    if (!C || !ev || typeof ev.id !== 'string') return;
    const i = C.lista.findIndex((r) => r.id === ev.id);
    if (ev.resumo === null) {
      if (i >= 0) C.lista.splice(i, 1);
      C.auto.delete(ev.id); C.marcas.delete(ev.id);
      if (C.alerta && C.alerta.id === ev.id) fecharAlerta();
      sincronizar(new Set([ev.id]));
      return;
    }
    const al = ev.alerta;
    const temAlerta = !!al && typeof al === 'object' && typeof al.texto === 'string' && al.texto.trim() !== '';
    if (!ev.resumo || typeof ev.resumo !== 'object') {
      if (temAlerta) mostrarAlerta(al.tipo === 'pausa' ? 'pausa' : 'aviso', al.texto.trim(), ev.id);
      return;
    }
    const antigo = i >= 0 ? C.lista[i] : null;
    const novo = { ...ev.resumo, id: ev.id };
    const vo = C.voando.get(ev.id), no = C.nomeando.get(ev.id);
    if (vo) novo.canvas = vo.canvas;
    else if (!novo.canvas && antigo) novo.canvas = antigo.canvas;
    if (no) novo.nome = no.nome;
    if (i >= 0) C.lista[i] = novo; else C.lista.push(novo);
    // o status mudou: a marca do ladrilho sai; o alerta de pausa deste escritório sai se ele deixou de estar pausado
    const mc = C.marcas.get(ev.id), st = statusDe(novo);
    if (mc && mc.status !== st) { C.marcas.delete(ev.id); pintarMarca(ev.id); }
    if (C.alerta && C.alerta.id === ev.id && C.alerta.tipo === 'pausa' && st !== 'pausada') fecharAlerta();
    sincronizar(new Set([ev.id]));
    if (temAlerta) mostrarAlerta(al.tipo === 'pausa' ? 'pausa' : 'aviso', al.texto.trim(), ev.id);
  }

  // Vários arrastes seguidos do mesmo ladrilho: cada POST tem seu número; só o último decide o desfecho (sucesso apaga o
  // "voando"; falha restaura a última posição confirmada, `base`). Um SSE no meio não desfaz o arraste (atualizar usa voando).
  async function gravarPosicao(id, p) {
    const c = C;
    if (id === 'sessoes') { c.sessoes = { x: p.x, y: p.y }; guardar(CHAVE_SESSOES, c.sessoes); sincronizar(); return; }
    const r = achar(id);
    if (!r) return;
    let v = c.voando.get(id);
    if (!v) { v = { canvas: null, n: 0, base: r.canvas }; c.voando.set(id, v); }
    const n = ++v.n, meu = { x: p.x, y: p.y };
    v.canvas = meu;
    r.canvas = meu;
    c.auto.set(id, meu.x + ',' + meu.y);
    sincronizar(new Set([id]));
    try {
      await postar(id, { canvas: meu });
      if (c !== C || c.voando.get(id) !== v) return;
      if (v.n === n) c.voando.delete(id); else v.base = meu;
    } catch (e) {
      if (c !== C || c.voando.get(id) !== v) return;
      if (v.n !== n) return;
      c.voando.delete(id);
      c.auto.delete(id);
      const atual = achar(id);
      if (atual) atual.canvas = v.base;
      sincronizar(new Set([id]));
      aviso('Não foi possível salvar a posição: ' + (e.message || 'erro desconhecido'));
    }
  }

  // ── renomear inline ──
  function iniciarRenomear(id) {
    const t = C.tiles.get(id), r = achar(id);
    if (!t || !r || id === 'sessoes' || t.editando) return;
    fecharMenu(false); esconderCard();
    t.editando = true;
    const inp = h('input', { class: 'esc-cv-nome-in', type: 'text', maxlength: '60', value: r.nome || '', autocomplete: 'off', 'aria-label': 'Novo nome do escritório ' + (r.nome || '') });
    t.nome.hidden = true;
    t.nome.after(inp);
    let feito = false;
    const valido = () => { const v = inp.value.trim(); return v.length >= 1 && v.length <= 60; };
    const fechar = (gravar, devolverFoco) => {
      if (feito) return;
      feito = true; t.editando = false;
      const v = inp.value.trim();
      inp.remove(); t.nome.hidden = false;
      if (devolverFoco) t.el.focus({ preventScroll: true });
      if (gravar && v !== r.nome) renomear(id, v);
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!valido()) { inp.setAttribute('aria-invalid', 'true'); aviso('O nome precisa ter de 1 a 60 caracteres.'); return; }
        fechar(true, true);
      } else if (e.key === 'Escape') { e.preventDefault(); fechar(false, true); }
    });
    inp.addEventListener('input', () => inp.removeAttribute('aria-invalid'));
    inp.addEventListener('blur', () => fechar(valido(), false));
    for (const tipo of ['pointerdown', 'dblclick', 'click', 'contextmenu']) inp.addEventListener(tipo, (e) => e.stopPropagation());
    inp.focus(); inp.select();
  }

  async function renomear(id, nome) {
    const c = C, r = achar(id);
    if (!r) return;
    let v = c.nomeando.get(id);
    if (!v) { v = { nome, n: 0, base: r.nome }; c.nomeando.set(id, v); }
    const n = ++v.n;
    v.nome = nome;
    r.nome = nome;
    sincronizar(new Set([id]));
    try {
      await postar(id, { nome });
      if (c !== C || c.nomeando.get(id) !== v) return;
      if (v.n === n) c.nomeando.delete(id); else v.base = nome;
    } catch (e) {
      if (c !== C || c.nomeando.get(id) !== v) return;
      if (v.n === n) {
        c.nomeando.delete(id);
        const atual = achar(id);
        if (atual) { atual.nome = v.base; sincronizar(new Set([id])); }
      }
      aviso('Não foi possível renomear: ' + (e.message || 'erro desconhecido'));
    }
  }

  // ───────────────────────── menu de contexto ─────────────────────────
  function fecharMenu(devolverFoco) {
    const m = C && C.menu;
    if (!m) return;
    C.menu = null;
    m.fins.forEach((f) => f());
    m.el.remove();
    if (devolverFoco) {
      const t = C.tiles.get(m.id);
      if (t) t.el.focus({ preventScroll: true });
    }
  }

  function abrirMenu(id, ancora) {
    fecharMenu(false); esconderCard();
    const sess = id === 'sessoes';
    const defs = sess
      ? [['Entrar', 'entrar', 'Enter']]
      : [['Entrar', 'entrar', 'Enter'], ['Renomear', 'renomear', 'F2'], ['Editar', 'editar'], ['Duplicar', 'duplicar'], '-', ['Excluir', 'excluir', '', true]];
    const el = h('div', { class: 'menu-flut esc-cv-menu no-ponto', role: 'menu', 'aria-label': 'Ações de ' + nomeDe(id) }, h('div', { class: 'menu-tit cab' }, nomeDe(id)));
    for (const d of defs) {
      if (d === '-') { el.append(h('div', { class: 'menu-sep', role: 'separator' })); continue; }
      const b = h('button', { type: 'button', class: 'menu-item' + (d[3] ? ' perigo' : ''), role: 'menuitem', 'data-acao': d[1] }, h('span', { class: 'mi-rot' }, d[0]), d[2] ? h('span', { class: 'mi-atalho' }, d[2]) : null);
      b.addEventListener('click', () => executarAcao(d[1], id));
      el.append(b);
    }
    document.body.append(el);
    const m = { id, el, fins: [] };
    C.menu = m;
    const rm = (f) => m.fins.push(f);
    const sair = () => fecharMenu(false);
    const fora = (e) => { if (!el.contains(e.target)) fecharMenu(false); };
    document.addEventListener('pointerdown', fora, true); rm(() => document.removeEventListener('pointerdown', fora, true));
    window.addEventListener('wheel', sair, { passive: true }); rm(() => window.removeEventListener('wheel', sair));
    window.addEventListener('resize', sair); rm(() => window.removeEventListener('resize', sair));
    window.addEventListener('blur', sair); rm(() => window.removeEventListener('blur', sair));
    const tecla = (e) => {
      const itens = [...el.querySelectorAll('.menu-item')], i = itens.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); itens[(i + 1) % itens.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); itens[(i - 1 + itens.length) % itens.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); itens[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); itens[itens.length - 1].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fecharMenu(true); }
      else if (e.key === 'Tab') { e.preventDefault(); fecharMenu(true); }
    };
    el.addEventListener('keydown', tecla);
    // posição: no ponteiro (clique direito) ou sob o botão/ladrilho; sempre dentro da janela
    let ax, ay;
    if (ancora && typeof ancora.getBoundingClientRect === 'function') { const r = ancora.getBoundingClientRect(); ax = r.left; ay = r.bottom + 4; }
    else { ax = ancora.x; ay = ancora.y; }
    const w = el.offsetWidth, hh = el.offsetHeight, mg = 8;
    el.style.left = limitar(ax, mg, Math.max(mg, window.innerWidth - w - mg)) + 'px';
    el.style.top = limitar(ay, mg, Math.max(mg, window.innerHeight - hh - mg)) + 'px';
    const primeiro = el.querySelector('.menu-item');
    if (primeiro) primeiro.focus();
  }

  function executarAcao(acao, id) {
    // O foco volta ao ladrilho ANTES do callback: quem abre gaveta/diálogo guarda o elemento focado para devolver o foco ao fechar.
    // Renomear leva o foco para o campo de edição.
    fecharMenu(acao !== 'renomear');
    if (acao !== 'renomear') esconderCard();
    if (acao === 'entrar') return chamar('onEntrar', id);
    if (acao === 'renomear') return iniciarRenomear(id);
    if (acao === 'editar') return chamar('onEditar', id);
    if (acao === 'duplicar') return chamar('onDuplicar', id);
    if (acao === 'excluir') return chamar('onExcluir', id);
  }

  // ───────────────────────── gestos ─────────────────────────
  function ponto(e) {
    const r = C.ui.vista.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }
  function capturar(e) { try { C.ui.vista.setPointerCapture(e.pointerId); } catch { /* sem captura */ } }
  function centroToques() {
    const ps = [...C.toques.values()].slice(0, 2);
    return { sx: (ps[0].sx + ps[1].sx) / 2, sy: (ps[0].sy + ps[1].sy) / 2, d: Math.hypot(ps[0].sx - ps[1].sx, ps[0].sy - ps[1].sy) || 1 };
  }
  function cancelarGesto() {
    const g = C.gesto;
    if (g && g.timer) { clearTimeout(g.timer); g.timer = 0; }
    if (g && g.tipo === 'tile') fimTile(g, true);
    C.gesto = null;
    C.ui.vista.classList.remove('esc-cv-movendo');
  }

  function aoDescer(e) {
    if (e.target.closest('.esc-cv-mais, .esc-cv-nome-in')) return;
    C.houveArraste = false;
    C.teclado = false;
    const p = ponto(e);
    if (e.pointerType === 'touch') {
      C.toques.set(e.pointerId, { sx: p.sx, sy: p.sy });
      if (C.toques.size === 2) {
        cancelarGesto(); pararAnim(); capturar(e);
        const c = centroToques();
        C.gesto = { tipo: 'pinca', d0: c.d, z0: C.cam.zoom, m: telaParaMundo(c.sx, c.sy) };
        return;
      }
      if (C.toques.size > 2) return;
    }
    const alvoEl = e.target.closest('.esc-cv-ladrilho');
    if (e.button === 1 || (e.button === 0 && !alvoEl)) {
      e.preventDefault(); pararAnim(); capturar(e); esconderCard();
      if (e.button === 0) { selecionar(null); const a = document.activeElement; if (a && C.ui.raiz.contains(a) && a.blur) a.blur(); }
      C.gesto = { tipo: 'pan', id: e.pointerId, sx: p.sx, sy: p.sy, cx: C.cam.x, cy: C.cam.y, moveu: false, dmax: 0, toque: e.pointerType === 'touch' };
      C.ui.vista.classList.add('esc-cv-movendo');
      return;
    }
    if (e.button === 0 && alvoEl) {
      const id = alvoEl.dataset.id, pos = C.pos.get(id);
      selecionar(id);
      if (!alvoEl.contains(document.activeElement)) alvoEl.focus({ preventScroll: true });
      if (!pos) return;
      const g = { tipo: 'tile', id, pid: e.pointerId, sx: p.sx, sy: p.sy, origem: { x: pos.x, y: pos.y }, cur: { x: pos.x, y: pos.y }, movido: false, oc: null, toque: false, armado: false, timer: 0, nome: false };
      if (e.pointerType === 'touch') {
        // toque: o dedo só arrasta o ladrilho depois de segurar HOLD_MS; antes disso mover (> TOQUE_TOL) vira pan da vista
        g.toque = true; g.nome = !!e.target.closest('.esc-cv-nome');
        g.timer = setTimeout(() => {
          g.timer = 0;
          if (C && C.gesto === g && !g.movido) { g.armado = true; const t = C.tiles.get(id); if (t) t.el.classList.add('esc-cv-armado'); }
        }, HOLD_MS);
      }
      C.gesto = g;
    }
  }

  function aoMover(e) {
    let g = C.gesto;
    const p = ponto(e);
    if (e.pointerType === 'touch' && C.toques.has(e.pointerId)) C.toques.set(e.pointerId, { sx: p.sx, sy: p.sy });
    if (!g) return;
    if (g.tipo === 'tile' && g.toque && !g.armado && g.pid === e.pointerId) {
      const d = Math.hypot(p.sx - g.sx, p.sy - g.sy);
      if (d <= TOQUE_TOL) return;
      // moveu antes de segurar: não é arraste do ladrilho, é pan da vista
      clearTimeout(g.timer); g.timer = 0;
      pararAnim(); capturar(e); esconderCard();
      g = C.gesto = { tipo: 'pan', id: e.pointerId, sx: g.sx, sy: g.sy, cx: C.cam.x, cy: C.cam.y, moveu: true, dmax: d, toque: true };
      C.ui.vista.classList.add('esc-cv-movendo');
    }
    if (g.tipo === 'pinca') {
      if (C.toques.size < 2) return;
      const c = centroToques(), z = limitar(g.z0 * c.d / g.d0, ZMIN, ZMAX);
      aplicarCamera({ x: g.m.x - c.sx / z, y: g.m.y - c.sy / z, zoom: z });
      return;
    }
    if (g.tipo === 'pan' && g.id === e.pointerId) {
      const dp = Math.hypot(p.sx - g.sx, p.sy - g.sy);
      if (dp > g.dmax) g.dmax = dp;
      if (dp > 3) g.moveu = true;
      aplicarCamera({ x: g.cx - (p.sx - g.sx) / C.cam.zoom, y: g.cy - (p.sy - g.sy) / C.cam.zoom, zoom: C.cam.zoom });
      return;
    }
    if (g.tipo === 'tile' && g.pid === e.pointerId) {
      if (!g.movido) {
        if (Math.hypot(p.sx - g.sx, p.sy - g.sy) < 4) return;
        g.movido = true; capturar(e); esconderCard(); fecharMenu(false);
        const t = C.tiles.get(g.id);
        if (t) t.el.classList.add('esc-cv-arrastando');
        C.ui.vista.classList.add('esc-cv-movendo');
      }
      g.cur = { x: g.origem.x + (p.sx - g.sx) / C.cam.zoom, y: g.origem.y + (p.sy - g.sy) / C.cam.zoom };
      const t = C.tiles.get(g.id);
      if (t) { t.el.style.left = g.cur.x + 'px'; t.el.style.top = g.cur.y + 'px'; }
      if (!g.oc) g.oc = ocupacaoSem(g.id);
      const d = maisLivre(g.cur.x, g.cur.y, g.oc, g.id !== 'sessoes');
      C.ui.alvo.style.left = d.x + 'px'; C.ui.alvo.style.top = d.y + 'px';
      C.ui.alvo.hidden = false;
    }
  }

  function fimTile(g, cancelar) {
    const t = C.tiles.get(g.id);
    C.ui.alvo.hidden = true;
    if (t) t.el.classList.remove('esc-cv-arrastando', 'esc-cv-armado');
    if (!g.movido) return;
    C.houveArraste = true;
    const destino = cancelar ? g.origem : maisLivre(g.cur.x, g.cur.y, g.oc || ocupacaoSem(g.id), g.id !== 'sessoes');
    C.pos.set(g.id, destino);
    if (t) { posicionar(t, destino); t.px = destino.x; t.py = destino.y; }
    if (!cancelar && (destino.x !== g.origem.x || destino.y !== g.origem.y)) gravarPosicao(g.id, destino);
  }

  function aoSubir(e) {
    if (!C) return;
    const g = C.gesto;
    if (e.pointerType === 'touch') {
      C.toques.delete(e.pointerId);
      if (g && g.tipo === 'pinca') { if (C.toques.size < 2) C.gesto = null; return; }
    }
    if (!g || (g.id !== e.pointerId && g.pid !== e.pointerId)) return;
    C.gesto = null;
    if (g.timer) { clearTimeout(g.timer); g.timer = 0; }
    C.ui.vista.classList.remove('esc-cv-movendo');
    const cancelou = e.type === 'pointercancel';
    if (g.tipo === 'tile') fimTile(g, cancelou);
    else if (g.tipo === 'pan') C.houveArraste = g.moveu;
    if (g.toque && !cancelou) {
      C.tqFim = performance.now();
      if (g.tipo === 'tile' && !g.movido) {
        if (g.armado) { selecionar(g.id); const t = C.tiles.get(g.id); if (t) abrirMenu(g.id, t.el); } // segurou e soltou sem mexer: menu
        else toqueNoLadrilho(g);
      } else if (g.tipo === 'pan' && g.dmax <= TOQUE_TOL) toqueNoVazio(ponto(e));
    }
  }

  // Toque simples seleciona e abre o card com "Entrar"; o segundo toque (< DUPLO_TOQUE_MS, mesmo ladrilho) entra.
  function toqueNoLadrilho(g) {
    const agora = performance.now(), u = C.tqUp;
    if (u && u.id === g.id && agora - u.t < DUPLO_TOQUE_MS) {
      C.tqUp = null;
      esconderCard();
      if (g.id !== 'sessoes' && g.nome) iniciarRenomear(g.id); else chamar('onEntrar', g.id);
      return;
    }
    C.tqUp = { t: agora, id: g.id, sx: 0, sy: 0 };
    selecionar(g.id);
    mostrarCard(g.id, true);
  }
  function toqueNoVazio(p) {
    const agora = performance.now(), u = C.tqUp;
    if (u && u.id === '' && agora - u.t < DUPLO_TOQUE_MS && Math.hypot(u.sx - p.sx, u.sy - p.sy) <= 30) {
      C.tqUp = null;
      const m = telaParaMundo(p.sx, p.sy);
      chamar('onCriar', vagaLivre(snap(m.x), snap(m.y)));
      return;
    }
    C.tqUp = { t: agora, id: '', sx: p.sx, sy: p.sy };
  }

  // Ctrl/Cmd+rolagem e pinça do trackpad (wheel com ctrlKey) = zoom no ponteiro; rolagem pura = deslocar.
  function aoRolar(e) {
    e.preventDefault();
    pararAnim();
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; } else if (e.deltaMode === 2) { dx *= C.larg; dy *= C.alt; }
    const p = ponto(e);
    if (e.ctrlKey || e.metaKey) { zoomEm(C.cam.zoom * Math.exp(-limitar(dy, -40, 40) * 0.0075), p.sx, p.sy); return; }
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    aplicarCamera({ x: C.cam.x + dx / C.cam.zoom, y: C.cam.y + dy / C.cam.zoom, zoom: C.cam.zoom });
  }

  function aoDuploClique(e) {
    if (e.target.closest('.esc-cv-mais, .esc-cv-nome-in') || C.houveArraste) return;
    if (performance.now() - C.tqFim < 800) return; // dblclick sintético de um toque: o módulo já tratou o duplo toque
    const tile = e.target.closest('.esc-cv-ladrilho');
    if (tile) {
      const id = tile.dataset.id;
      if (id !== 'sessoes' && e.target.closest('.esc-cv-nome')) iniciarRenomear(id);
      else chamar('onEntrar', id);
      return;
    }
    const p = ponto(e), m = telaParaMundo(p.sx, p.sy);
    chamar('onCriar', vagaLivre(snap(m.x), snap(m.y)));
  }

  function aoMenuContexto(e) {
    const tile = e.target.closest('.esc-cv-ladrilho');
    if (!tile) return;
    e.preventDefault();
    // toque: o "segurar" do navegador não abre menu (segurar e soltar sem mexer já abre o nosso, e o arraste não pode ser interrompido)
    if (e.pointerType === 'touch' || (C.gesto && C.gesto.toque) || performance.now() - C.tqFim < 800) return;
    if (e.target.closest('.esc-cv-nome-in')) return;
    selecionar(tile.dataset.id);
    abrirMenu(tile.dataset.id, e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : tile);
  }

  function vizinho(id, tecla) {
    const p = C.pos.get(id);
    if (!p) return null;
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[tecla];
    let melhor = null;
    for (const [k, q] of C.pos) {
      if (k === id) continue;
      const dx = q.x - p.x, dy = q.y - p.y;
      const prim = dx * dir[0] + dy * dir[1], orto = Math.abs(dx * dir[1] + dy * dir[0]);
      if (prim <= 1) continue;
      const nota = prim + 2 * orto;
      if (!melhor || nota < melhor.nota) melhor = { id: k, nota };
    }
    return melhor && melhor.id;
  }

  function aoTecla(e) {
    C.teclado = true;
    const tile = e.target.closest && e.target.closest('.esc-cv-ladrilho');
    if (e.key === 'Escape' && C.gesto && C.gesto.tipo === 'tile' && C.gesto.movido) { e.preventDefault(); cancelarGesto(); return; }
    if (!tile || e.target !== tile) return;
    const id = tile.dataset.id;
    if (e.key === 'Enter') { e.preventDefault(); chamar('onEntrar', id); }
    else if (e.key === 'F2') { e.preventDefault(); iniciarRenomear(id); }
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey) || (e.key === 'ArrowDown' && e.altKey)) { e.preventDefault(); selecionar(id); abrirMenu(id, tile); }
    else if (e.key.startsWith('Arrow') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const v = vizinho(id, e.key);
      if (v) { e.preventDefault(); const t = C.tiles.get(v); selecionar(v); garantirVisivel(v); t.el.focus({ preventScroll: true }); }
    }
  }

  function aoSobre(e) {
    if (e.pointerType === 'touch' || C.gesto) return;
    const tile = e.target.closest('.esc-cv-ladrilho');
    if (!tile || (C.menu && C.menu.id)) return;
    if (C.cardId === tile.dataset.id && !C.ui.card.hidden) return;
    mostrarCard(tile.dataset.id);
  }
  function aoSair(e) {
    if (e.pointerType === 'touch') return; // ao levantar o dedo o pointerout não deve apagar o card do toque
    const tile = e.target.closest('.esc-cv-ladrilho');
    if (!tile || (e.relatedTarget && tile.contains(e.relatedTarget))) return;
    if (tile.matches(':focus-visible')) return;
    if (C.cardId === tile.dataset.id) esconderCard();
  }
  function aoFocar(e) {
    const tile = e.target.closest('.esc-cv-ladrilho');
    if (tile) ajustarTab(tile.dataset.id); // o ladrilho que recebeu o foco passa a ser o tab stop
    if (!tile || e.target !== tile || C.menu || C.gesto) return;
    if (!tile.matches(':focus-visible')) return;
    garantirVisivel(tile.dataset.id);
    mostrarCard(tile.dataset.id);
  }
  function aoDesfocar(e) {
    const tile = e.target.closest('.esc-cv-ladrilho');
    if (!tile || (e.relatedTarget && (tile.contains(e.relatedTarget) || C.ui.card.contains(e.relatedTarget)))) return;
    if (C.cardToque && C.cardId === tile.dataset.id) return; // card do toque só sai com toque no fundo, em outro ladrilho ou Esc
    if (C.cardId === tile.dataset.id) esconderCard();
  }

  // ───────────────────────── montar / desmontar ─────────────────────────
  function medir() {
    const r = C.ui.vista.getBoundingClientRect();
    C.larg = r.width; C.alt = r.height;
    if (C.larg > 0 && C.alt > 0) {
      if (C.pendAjuste && !C.ajusteInicial) ajustar(false);
      if (C.ajusteInicial && C.carregado) { C.ajusteInicial = false; ajustar(false); }
    }
  }

  function montar(el, opcoes = {}) {
    desmontar();
    if (!el) throw new Error('EscritoriosCanvas.montar: elemento ausente');
    const ui = criarUI();
    C = {
      el, op: opcoes || {}, base: String((opcoes && opcoes.base) || '').replace(/\/+$/, ''), ui,
      lista: [], carregado: false, erroCarga: '', sessoes: null, pos: new Map(), tiles: new Map(), voando: new Map(),
      cam: { x: 0, y: 0, zoom: 1 }, larg: 0, alt: 0, sel: null, gesto: null, toques: new Map(), menu: null, cardId: '',
      anim: 0, timerCam: 0, timerAviso: 0, ouvintes: [], ro: null, mini: null, seq: 0, houveArraste: false, teclado: false,
      ajusteInicial: false, pendAjuste: false, marcas: new Map(), alerta: null, timerAlerta: 0, cardToque: false, tqUp: null, tqFim: -1e9,
      tempoAlerta: Number(opcoes && opcoes.tempoAlertaMs) > 0 ? Number(opcoes.tempoAlertaMs) : TEMPO_ALERTA,
      dpr: dprAtual(), tabId: 'sessoes', visto: new Map(), nVisto: 0, sigLayout: '', nomeando: new Map(), auto: new Map(), fila: [], filaRodando: false,
    };
    const s = ler(CHAVE_SESSOES);
    if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) C.sessoes = { x: mundoOk(s.x), y: mundoOk(s.y) };
    const cam = ler(CHAVE_CAM);
    if (cam && Number.isFinite(cam.x) && Number.isFinite(cam.y) && Number.isFinite(cam.zoom)) C.cam = { x: cam.x, y: cam.y, zoom: limitar(cam.zoom, ZMIN, ZMAX) };
    else C.ajusteInicial = true;

    el.append(ui.raiz);
    pintarCamera();
    medir();

    const v = ui.vista;
    ouvir(v, 'pointerdown', aoDescer);
    ouvir(v, 'pointermove', aoMover);
    ouvir(window, 'pointerup', aoSubir);
    ouvir(window, 'pointercancel', aoSubir);
    ouvir(v, 'wheel', aoRolar, { passive: false });
    ouvir(v, 'dblclick', aoDuploClique);
    ouvir(v, 'contextmenu', aoMenuContexto);
    ouvir(v, 'keydown', aoTecla);
    ouvir(v, 'pointerover', aoSobre);
    ouvir(v, 'pointerout', aoSair);
    ouvir(v, 'focusin', aoFocar);
    ouvir(v, 'focusout', aoDesfocar);
    // clique no "⋯" (delegado: o botão é recriado só com o ladrilho)
    ouvir(v, 'click', (e) => {
      const b = e.target.closest('.esc-cv-mais');
      if (!b) return;
      e.stopPropagation();
      const id = b.closest('.esc-cv-ladrilho').dataset.id;
      selecionar(id);
      if (C.menu && C.menu.id === id) fecharMenu(true); else abrirMenu(id, b);
    });
    const criar = () => {
      const m = telaParaMundo(C.larg / 2, C.alt / 2);
      chamar('onCriar', vagaLivre(snap(m.x - TW / 2), snap(m.y - TH / 2)));
    };
    ouvir(ui.novo, 'click', criar);
    ouvir(ui.vazioNovo, 'click', criar);
    ouvir(ui.vazioTentar, 'click', () => recarregar());
    ouvir(ui.alertaFechar, 'click', () => fecharAlerta());
    ouvir(ui.alertaTxt, 'click', () => { if (C.alerta && C.alerta.id) focar(C.alerta.id); });
    ouvir(ui.ajustar, 'click', () => ajustar(true));
    ouvir(ui.mais, 'click', () => zoomPasso(1.25));
    ouvir(ui.menos, 'click', () => zoomPasso(1 / 1.25));

    if (typeof ResizeObserver === 'function') { C.ro = new ResizeObserver(() => { if (C) medir(); }); C.ro.observe(v); }
    else ouvir(window, 'resize', medir);

    ouvir(window, 'resize', aoRedimensionarJanela); // mudança de devicePixelRatio (zoom do navegador, outra tela)
    sincronizar();
    carregarMini();
    recarregar();
  }

  function desmontar() {
    if (!C) return;
    const c = C;
    pararAnim();
    if (c.timerCam) salvarCam();
    clearTimeout(c.timerAviso); clearTimeout(c.timerAlerta);
    if (c.gesto && c.gesto.timer) clearTimeout(c.gesto.timer);
    fecharMenu(false);
    if (c.ro) c.ro.disconnect();
    for (const fim of c.ouvintes) fim();
    c.ouvintes.length = 0;
    c.ui.raiz.remove();
    C = null;
  }

  window.EscritoriosCanvas = {
    montar, desmontar, atualizar, recarregar,
    camera: () => (C ? { ...C.cam } : null),
    aviso: (texto, tipo) => { if (C && typeof texto === 'string' && texto.trim()) mostrarAlerta(tipo === 'pausa' ? 'pausa' : 'aviso', texto.trim(), null); },
    focar: (id) => focar(id),
  };
})();
