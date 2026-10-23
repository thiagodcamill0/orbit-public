// Orbit — Whiteboard (etapa 4: cards de agentes). Carregado depois de whiteboard.js (e de -setas/-edicao/-estilo).
// Tipo 'agente' só com `html` (camada HTML): card vivo de uma sessão do Claude Code. Elemento:
//   { tipo: 'agente', x, y, w: 260, h: 120, sessao: { id, resumo: { nome, projeto, status } } }
// Dados ao vivo: window.OrbitFonteSessoes (contrato whiteboard-etapa4), lida sempre na
// hora do uso; pode não existir → o card mostra só o resumo guardado (encerrado, esmaecido, sprite "dormindo").
// Arrastar uma sessão (dataTransfer 'application/x-orbit-sessao') para o palco cria o card no ponto solto; se a sessão já
// está no quadro, a câmera vai até o card existente e ele pisca. Clique (Selecionar) = popover de detalhes; duplo clique =
// fonte.abrir(id). Sem ferramenta nova na barra. Publica Whiteboard.agentes = { adicionar(id, x, y), cards(), focar(id),
// detalhes(id), fecharDetalhes(), atualizar(id?), ouvindo() }.
// Resumo guardado: enquanto a sessão existe, sessao.resumo é atualizado por mutação silenciosa (sem passo de histórico) e o
// quadro é marcado para gravar reaplicando a câmera atual (definirCamera(camera()) → salvamento da câmera, que leva os
// elementos junto). O núcleo não tem "marcar para gravar" sem confirmar; esta é a via sem mexer nele.
(() => {
  'use strict';
  const W = window.Whiteboard;
  if (!W || !W.registrarTipo || !W.nucleo) return;
  const N = W.nucleo;
  const LARG = 260, ALT = 120, MIN_W = 200, MIN_H = 104;
  const TIPO_DT = 'application/x-orbit-sessao';
  const base = (() => { try { return document.currentScript && document.currentScript.src; } catch { return ''; } })();
  const SPRITE_FIM = (() => { try { return new URL('sprites/sprite-sleep.gif', base || location.href).href; } catch { return 'assets/sprites/sprite-sleep.gif'; } })();
  const ROTULO = { nova: 'Nova', trabalhando: 'Trabalhando', aguardando: 'Aguardando você', concluida: 'Concluída', concluido: 'Concluído', erro: 'Erro', interrompida: 'Interrompida', encerrada: 'Encerrada' };
  const reduzido = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

  // ── fonte de sessões (sempre lida na hora) ──
  const fonte = () => window.OrbitFonteSessoes || null;
  function obter(id) {
    const f = fonte();
    if (!f || typeof f.obter !== 'function' || !id) return null;
    try { return f.obter(id) || null; } catch (e) { console.warn('whiteboard-agentes: obter', e); return null; }
  }
  function abrirConversa(id) {
    const f = fonte();
    if (!f || typeof f.abrir !== 'function' || !id) return false;
    try { f.abrir(id); return true; } catch (e) { console.warn('whiteboard-agentes: abrir', e); return false; }
  }

  // ── utilidades ──
  const ehCard = (el) => !!el && el.tipo === 'agente' && !!el.sessao && !!el.sessao.id;
  const cards = () => N.elementos().filter(ehCard);
  const cardDe = (id) => cards().find((el) => el.sessao.id === id) || null;
  const noDe = (el) => { const c = N.camadaHtml(); return c ? c.querySelector(`.wb-no[data-id="${CSS.escape(el.id)}"]`) : null; };
  const palco = () => { const c = N.camadaHtml(); return c ? c.closest('.wb-palco') : null; };
  const h = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  // Fração de uso do contexto (0..1, como no base.js); tokens/limite tem preferência; pct > 1,5 sem tokens = porcentagem.
  function fracao(ctx) {
    if (!ctx) return null;
    const t = +ctx.tokens, l = +ctx.limite;
    if (Number.isFinite(t) && Number.isFinite(l) && l > 0) return t / l;
    const p = +ctx.pct;
    if (!Number.isFinite(p)) return null;
    return p > 1.5 ? p / 100 : p;
  }
  const faixa = (f) => (f > 0.85 ? 'alto' : f > 0.6 ? 'medio' : '');
  const nomeFerr = (f) => (!f ? '' : typeof f === 'string' ? f : f.nome || '');
  const milhar = (n) => { const v = +n; if (!Number.isFinite(v)) return '—'; return v >= 1000 ? (Math.round(v / 100) / 10).toLocaleString('pt-BR') + ' mil' : String(Math.round(v)); };
  function relativo(ms) {
    const t = +ms;
    if (!Number.isFinite(t) || t <= 0) return '—';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 45) return 'agora';
    const m = Math.round(s / 60);
    if (m < 60) return `há ${m} min`;
    const hr = Math.round(m / 60);
    if (hr < 24) return `há ${hr} h`;
    const d = Math.round(hr / 24);
    return `há ${d} ${d === 1 ? 'dia' : 'dias'}`;
  }
  // Dados mostrados no card: vivos (resumo da fonte) ou guardados (encerrado).
  function dados(el) {
    const id = el.sessao && el.sessao.id, r = obter(id);
    if (r) sincronizarResumo(el, r);
    const res = (el.sessao && el.sessao.resumo) || {};
    if (!r) return { vivo: false, nome: res.nome || 'Sessão', projeto: res.projeto || '', status: 'encerrada', stTexto: 'Encerrada', sprite: SPRITE_FIM, frac: null, ativ: 'Sessão encerrada', r: null };
    const st = r.status || '';
    return { vivo: true, nome: r.nome || res.nome || 'Sessão', projeto: r.projeto || '', status: st, stTexto: r.statusTexto || ROTULO[st] || st, sprite: r.sprite || SPRITE_FIM, frac: fracao(r.contexto), ativ: r.atividade || '', r };
  }

  // ── resumo guardado: mutação silenciosa + marcar para gravar (pela câmera) ──
  let marcaT = 0, marcando = false, ultCamera = 0;
  function sincronizarResumo(el, r) {
    const novo = { nome: String(r.nome || ''), projeto: String(r.projeto || ''), status: String(r.status || '') };
    const a = (el.sessao && el.sessao.resumo) || {};
    if (a.nome === novo.nome && a.projeto === novo.projeto && a.status === novo.status) return;
    el.sessao = { ...el.sessao, resumo: novo }; // direto no objeto: sem 'mudanca' nem passo de histórico
    agendarMarca(1200);
  }
  function agendarMarca(ms) {
    if (marcaT) return;
    marcaT = setTimeout(() => {
      marcaT = 0;
      if (!W.quadro()) return;
      if (performance.now() - ultCamera < 500) { agendarMarca(600); return; } // não interrompe câmera em movimento
      marcando = true;
      try { N.definirCamera(N.camera(), { animar: false }); } finally { marcando = false; }
    }, ms);
  }

  // ── card (DOM) ──
  function montarCard() {
    const no = h('div', 'wb-ag');
    const c = h('div', 'wb-ag-c');
    const topo = h('div', 'wb-ag-topo');
    const spr = h('span', 'wb-ag-spr');
    const ident = h('span', 'wb-ag-ident');
    ident.append(h('span', 'wb-ag-nome'), h('span', 'wb-ag-proj'));
    topo.append(spr, ident);
    const linha = h('div', 'wb-ag-linha');
    const st = h('span', 'wb-ag-st');
    st.append(h('i', 'wb-ag-ponto'), h('span', 'wb-ag-st-t'));
    const ctx = h('span', 'wb-ag-ctx');
    const barra = h('span', 'wb-ag-barra'); barra.append(h('i'));
    ctx.append(barra, h('span', 'wb-ag-pct'));
    linha.append(st, ctx);
    c.append(topo, linha, h('div', 'wb-ag-ativ'));
    no.append(c);
    return no;
  }
  function trocarSprite(no, url) {
    const caixa = no.querySelector('.wb-ag-spr');
    if (!caixa || no.dataset.sprite === url) return;
    const primeira = !no.dataset.sprite;
    no.dataset.sprite = url;
    const img = new Image();
    img.className = 'wb-ag-img'; img.alt = ''; img.draggable = false; img.decoding = 'async';
    img.src = url;
    const velhas = [...caixa.querySelectorAll('.wb-ag-img')];
    if (primeira || reduzido()) { velhas.forEach((v) => v.remove()); caixa.append(img); return; }
    img.classList.add('entra');
    caixa.append(img);
    requestAnimationFrame(() => requestAnimationFrame(() => img.classList.remove('entra')));
    setTimeout(() => velhas.forEach((v) => v.remove()), 220);
  }
  function pintar(no, el) {
    if (!no || !el) return;
    const d = dados(el);
    const chave = [d.vivo, d.nome, d.projeto, d.status, d.stTexto, d.sprite, d.frac == null ? '' : Math.round(d.frac * 1000), d.ativ].join('\u0001');
    if (no._chave === chave) return;
    no._chave = chave;
    no.dataset.status = d.status; no.dataset.vivo = d.vivo ? '1' : '0';
    no.classList.toggle('wb-ag-fim', !d.vivo);
    const q = (s) => no.querySelector(s);
    q('.wb-ag-nome').textContent = d.nome; q('.wb-ag-nome').title = d.nome;
    q('.wb-ag-proj').textContent = d.projeto;
    q('.wb-ag-st-t').textContent = d.stTexto;
    const ctx = q('.wb-ag-ctx');
    ctx.hidden = d.frac == null;
    if (d.frac != null) {
      const pct = Math.round(d.frac * 100);
      ctx.className = 'wb-ag-ctx' + (faixa(d.frac) ? ' ' + faixa(d.frac) : '');
      q('.wb-ag-barra i').style.width = Math.max(3, Math.min(100, pct)) + '%';
      q('.wb-ag-pct').textContent = pct + '%';
    }
    const at = q('.wb-ag-ativ');
    at.textContent = d.ativ; at.title = d.ativ;
    trocarSprite(no, d.sprite);
  }
  function marcarSelecao() {
    const sel = new Set(N.selecao());
    for (const el of cards()) { const no = noDe(el); if (no) no.classList.toggle('wb-ag-sel', sel.has(el.id)); }
  }
  // Repinta só os cards da sessão id (ou todos sem id), sem redesenhar o quadro.
  function atualizar(id) {
    for (const el of cards()) {
      if (id && el.sessao.id !== id) continue;
      const no = noDe(el);
      if (no) { no._chave = ''; pintar(no, el); }
    }
    if (POP.id && (!id || (N.elemento(POP.id) && N.elemento(POP.id).sessao.id === id))) preencherPop();
  }

  W.registrarTipo('agente', {
    html: {
      criar() { return montarCard(); },
      atualizar(no, el) { pintar(no, el); no.classList.toggle('wb-ag-sel', N.selecao().includes(el.id)); },
    },
    editar(el) { fecharPop(); abrirConversa(el.sessao && el.sessao.id); },
    aoRedimensionar(el, campos) {
      const w = campos && campos.w != null ? campos.w : el.w, hh = campos && campos.h != null ? campos.h : el.h;
      const aj = {};
      if (Math.abs(w) < MIN_W) aj.w = w < 0 ? -MIN_W : MIN_W;
      if (Math.abs(hh) < MIN_H) aj.h = hh < 0 ? -MIN_H : MIN_H;
      return Object.keys(aj).length ? aj : undefined;
    },
  });

  // ── criar / focar ──
  function destacar(el) {
    const no = noDe(el);
    if (!no) return;
    no.classList.remove('wb-ag-destaque');
    void no.offsetWidth;
    no.classList.add('wb-ag-destaque');
    clearTimeout(no._dT);
    no._dT = setTimeout(() => no.classList.remove('wb-ag-destaque'), 1400);
  }
  function focar(id) {
    const el = typeof id === 'string' ? cardDe(id) : id;
    if (!el) return null;
    const b = N.caixaMundo(el), cam = N.camera(), t = N.tamanho();
    N.selecionar([el.id]);
    N.definirCamera({ x: b.x + b.w / 2 - t.w / 2 / cam.zoom, y: b.y + b.h / 2 - t.h / 2 / cam.zoom, zoom: cam.zoom }, { animar: true });
    N.redesenhar();
    requestAnimationFrame(() => destacar(el));
    return el;
  }
  function adicionar(id, x, y) {
    id = String(id || '').trim();
    if (!id || !W.quadro()) return null;
    const ex = cardDe(id);
    if (ex) { focar(ex); return ex; }
    const r = obter(id);
    const resumo = r ? { nome: String(r.nome || ''), projeto: String(r.projeto || ''), status: String(r.status || '') } : { nome: id, projeto: '', status: '' };
    const el = N.adicionar({ tipo: 'agente', x: x - LARG / 2, y: y - ALT / 2, w: LARG, h: ALT, angulo: 0, cor: '#e5e5e5', traco: { largura: 2, estilo: 'solido' }, preenchimento: null, opacidade: 1, sessao: { id, resumo } });
    if (N.ferramenta() !== 'selecionar') N.definirFerramenta('selecionar');
    N.selecionar([el.id]);
    N.confirmar('adicionar agente');
    revisarEscuta();
    return el;
  }

  // ── popover de detalhes (espaço de tela, dentro do palco) ──
  const POP = { no: null, id: null };
  function linhaPop(dl, rot, val) {
    if (val == null || val === '') return;
    dl.append(h('dt', null, rot), h('dd', null, String(val)));
  }
  function preencherPop() {
    const el = POP.id && N.elemento(POP.id);
    if (!el || !POP.no) { fecharPop(); return; }
    const d = dados(el), r = d.r, p = POP.no;
    p.dataset.vivo = d.vivo ? '1' : '0';
    p.querySelector('.wb-ag-pop-nome').textContent = d.nome;
    p.querySelector('.wb-ag-pop-proj').textContent = d.projeto;
    const dl = p.querySelector('dl');
    dl.textContent = '';
    const st = h('dd', 'wb-ag-pop-st'); st.dataset.status = d.status; st.append(h('i', 'wb-ag-ponto'), document.createTextNode(d.stTexto));
    dl.append(h('dt', null, 'Status'), st);
    if (r) {
      linhaPop(dl, 'Detalhe', r.detalhe);
      linhaPop(dl, 'Ferramenta', nomeFerr(r.ferramenta));
      linhaPop(dl, 'Desde', relativo(r.desde));
      const c = r.contexto;
      if (c) { const f = fracao(c); linhaPop(dl, 'Contexto', `${milhar(c.tokens)} / ${milhar(c.limite)}${f != null ? ' (' + Math.round(f * 100) + '%)' : ''}`); }
      linhaPop(dl, 'Subagentes', String(+r.agentes || 0));
    } else {
      linhaPop(dl, 'Detalhe', 'A sessão não existe mais; mostrando o último resumo guardado.');
    }
    try { const fx = W.ligacao && W.ligacao.doAgente(el.id); if (fx && fx.length) linhaPop(dl, 'Ferramentas fixas', fx.map((x) => x.titulo).join(', ')); } catch {} // ligações do card de site (whiteboard-web.js)
    p.querySelector('.wb-ag-pop-abrir').disabled = !fonte();
    posicionarPop();
  }
  function posicionarPop() {
    const el = POP.id && N.elemento(POP.id), p = POP.no;
    if (!el || !p) return;
    const b = N.caixaMundo(el), t = N.tamanho();
    const a = N.mundoParaTela(b.x + b.w / 2, b.y + b.h), topo = N.mundoParaTela(b.x, b.y);
    const pw = p.offsetWidth || 260, ph = p.offsetHeight || 180, m = 8;
    let left = a.sx - pw / 2, top = a.sy + m;
    if (top + ph > t.h - m && topo.sy - m - ph >= m) { top = topo.sy - m - ph; p.dataset.lado = 'cima'; } else p.dataset.lado = 'baixo';
    left = Math.max(m, Math.min(t.w - pw - m, left));
    top = Math.max(m, Math.min(t.h - ph - m, top));
    p.style.left = Math.round(left) + 'px'; p.style.top = Math.round(top) + 'px';
  }
  function abrirPop(id) {
    const pl = palco(), el = N.elemento(id);
    if (!pl || !ehCard(el)) return false;
    if (!POP.no) {
      const p = h('div', 'wb-ag-pop');
      p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'Detalhes do agente');
      const cab = h('div', 'wb-ag-pop-cab');
      cab.append(h('span', 'wb-ag-pop-nome'), h('span', 'wb-ag-pop-proj'));
      const bt = h('button', 'wb-ag-pop-abrir', 'Abrir conversa');
      bt.type = 'button';
      bt.addEventListener('click', () => { const e = N.elemento(POP.id); if (e) { abrirConversa(e.sessao.id); fecharPop(); } });
      p.append(cab, h('dl'), bt);
      for (const t of ['pointerdown', 'dblclick', 'wheel', 'dragover']) p.addEventListener(t, (e) => e.stopPropagation());
      POP.no = p;
    }
    POP.id = id;
    if (POP.no.parentNode !== pl) pl.append(POP.no);
    POP.no.classList.remove('saindo');
    preencherPop();
    return true;
  }
  function fecharPop() {
    const p = POP.no;
    POP.id = null;
    if (p && p.parentNode) p.remove();
  }

  // ── escuta da fonte: ligada enquanto a vista está visível e há cards no quadro ──
  let desligar = null, visivel = false;
  function aoEvento(ev) {
    if (!ev || !ev.id) return;
    atualizar(ev.id);
  }
  function revisarEscuta() {
    const quer = visivel && cards().length > 0;
    if (quer && !desligar) {
      const f = fonte();
      if (!f || typeof f.ouvir !== 'function') return;
      try { const d = f.ouvir(aoEvento); desligar = typeof d === 'function' ? d : () => {}; } catch (e) { console.warn('whiteboard-agentes: ouvir', e); return; }
      atualizar(); // eventos perdidos enquanto desligado
    } else if (!quer && desligar) {
      try { desligar(); } catch {}
      desligar = null;
    }
  }

  // ── palco: arrastar/soltar, clique, observador de visibilidade ──
  let ligado = null;
  const temSessao = (e) => { try { return !!e.dataTransfer && [...e.dataTransfer.types].includes(TIPO_DT); } catch { return false; } };
  function ligarPalco() {
    const pl = palco();
    if (!pl || ligado === pl) return;
    ligado = pl;
    const realce = (on) => pl.classList.toggle('wb-ag-alvo', on);
    const aceitar = (e) => { if (!temSessao(e)) return; e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch {} realce(true); };
    pl.addEventListener('dragenter', aceitar);
    pl.addEventListener('dragover', aceitar);
    pl.addEventListener('dragleave', (e) => { if (e.relatedTarget && pl.contains(e.relatedTarget)) return; realce(false); });
    document.addEventListener('dragend', () => realce(false));
    pl.addEventListener('drop', (e) => {
      realce(false);
      if (!temSessao(e)) return;
      e.preventDefault();
      let id = '';
      try { id = e.dataTransfer.getData(TIPO_DT) || e.dataTransfer.getData('text/plain'); } catch {}
      if (!id) return;
      const r = pl.getBoundingClientRect(), m = N.telaParaMundo(e.clientX - r.left, e.clientY - r.top);
      // Etapa 5: sessão de um time vira quadro de time (Whiteboard.times.soltar → true se tratou); sem time, card solto.
      let tratou = false;
      const T = W.times;
      if (T && typeof T.soltar === 'function') { try { tratou = !!T.soltar(id, m.x, m.y); } catch (err) { console.warn('whiteboard-agentes: times.soltar', err); } }
      if (!tratou) adicionar(id, m.x, m.y);
      try { pl.focus({ preventScroll: true }); } catch {}
    });
    // Clique simples (sem arrastar) num card com a ferramenta Selecionar abre os detalhes.
    let toque = null;
    pl.addEventListener('pointerdown', (e) => { toque = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; });
    pl.addEventListener('pointerup', (e) => {
      const t = toque; toque = null;
      if (!t || e.button !== 0 || Math.hypot(e.clientX - t.x, e.clientY - t.y) > 4 || N.ferramenta() !== 'selecionar') return;
      const r = pl.getBoundingClientRect(), m = N.telaParaMundo(e.clientX - r.left, e.clientY - r.top);
      setTimeout(() => {
        const s = N.selecao(), alvo = N.elementoEm(m.x, m.y);
        if (s.length === 1 && alvo && alvo.id === s[0] && ehCard(alvo)) abrirPop(alvo.id);
      }, 0);
    });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((es) => { const v = es.some((x) => x.isIntersecting); if (v !== visivel) { visivel = v; if (!v) fecharPop(); revisarEscuta(); } }).observe(pl);
    } else { visivel = true; revisarEscuta(); }
  }
  // Fora do popover (inclusive fora do palco) fecha; Esc fecha antes de o núcleo desmarcar.
  document.addEventListener('pointerdown', (e) => { if (POP.no && POP.id && !POP.no.contains(e.target)) fecharPop(); }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !POP.id) return;
    e.preventDefault(); e.stopPropagation();
    fecharPop();
  }, true);

  N.on('quadro', () => { fecharPop(); ligarPalco(); revisarEscuta(); requestAnimationFrame(marcarSelecao); });
  N.on('camera', () => { if (marcando) return; ultCamera = performance.now(); if (POP.id) fecharPop(); });
  N.on('selecao', (ids) => {
    if (POP.id && !(ids.length === 1 && ids[0] === POP.id)) fecharPop();
    requestAnimationFrame(marcarSelecao);
  });
  N.on('mudanca', (d) => {
    const ids = (d && d.ids) || [];
    if (POP.id && (ids.includes(POP.id) || !N.elemento(POP.id))) fecharPop();
    if (d && d.tipo !== 'atualizar') revisarEscuta();
    requestAnimationFrame(marcarSelecao);
  });
  ligarPalco();

  W.estender('agentes', Object.freeze({
    adicionar: (id, x, y) => { const el = adicionar(id, +x || 0, +y || 0); return el ? el.id : null; },
    cards: () => cards().map((el) => { const no = noDe(el), r = obter(el.sessao.id); return { id: el.id, sessao: el.sessao.id, resumo: { ...(el.sessao.resumo || {}) }, vivo: !!r, x: el.x, y: el.y, w: el.w, h: el.h, status: no ? no.dataset.status : null, sprite: no ? no.dataset.sprite : null }; }),
    focar: (id) => { const el = focar(id); return el ? el.id : null; },
    detalhes: (id) => { const el = cardDe(id) || N.elemento(id); return el ? abrirPop(el.id) : false; },
    fecharDetalhes: fecharPop,
    detalhesAbertos: () => POP.id,
    atualizar: (id) => atualizar(id),
    ouvindo: () => !!desligar,
    TIPO_DT,
  }));
})();
