// Orbit — Whiteboard: painel lateral de sessões (ajustes, entrega A). Whiteboard.painel.
// Painel recolhível na borda direita da vista, com todas as sessões de window.OrbitFonteSessoes.lista() (lida sempre na hora),
// agrupadas por projeto e, dentro de cada um, por status (Precisa de você, Trabalhando, Recentes, Encerradas — mesma ordem do Orbit).
// Arrastar uma linha para o palco usa o drop de whiteboard-agentes.js (TIPO_DT); duplo clique/Enter adiciona no centro da vista
// (Whiteboard.times.soltar se a sessão tem time, senão Whiteboard.agentes.adicionar). Sessão já no quadro vem marcada; clicar foca.
// Atalho: Shift+A. Estado aberto/fechado em localStorage 'orbit.whiteboard.painel'. API: Whiteboard.painel { abrir, fechar, alternar, aberto }.
(() => {
  'use strict';
  const W = window.Whiteboard;
  if (!W || !W.nucleo || typeof W.estender !== 'function') return;
  const N = W.nucleo;
  const CHAVE = 'orbit.whiteboard.painel';
  const TIPO_DT = 'application/x-orbit-sessao';
  const GRUPO_DE = { aguardando: 'precisa', erro: 'precisa', trabalhando: 'trabalhando', concluida: 'recentes', interrompida: 'recentes', nova: 'recentes', encerrada: 'encerradas' };
  const GRUPOS = [
    { chave: 'precisa', titulo: 'Precisa de você' },
    { chave: 'trabalhando', titulo: 'Trabalhando' },
    { chave: 'recentes', titulo: 'Recentes' },
    { chave: 'encerradas', titulo: 'Encerradas' },
  ];
  const SEM_PROJETO = 'Sem projeto';
  const ICONE_PESSOAS = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M17 14.2c2.4.1 4.2 2.1 4.2 4.6"/></svg>';
  const ICONE_BUSCA = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>';
  const ICONE_SETA = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const ICONE_NO_QUADRO = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

  const fonte = () => window.OrbitFonteSessoes || null;
  const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const h = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  function lerSessoes() {
    const f = fonte();
    if (!f || typeof f.lista !== 'function') return null;
    try { const l = f.lista(); return Array.isArray(l) ? l.filter((s) => s && s.id) : []; } catch (e) { console.warn('whiteboard-painel: lista', e); return []; }
  }

  // ── estado ──
  const P = { vista: null, btn: null, no: null, busca: null, limpar: null, lista: null, vazio: null, aberto: false, visivel: false, desligar: null, q: '', fechados: new Set(), pendente: 0, io: null };
  try { P.aberto = localStorage.getItem(CHAVE) === '1'; } catch {}
  const guardar = () => { try { localStorage.setItem(CHAVE, P.aberto ? '1' : '0'); } catch {} };

  // ── sessões no quadro ──
  function noQuadro() {
    const s = new Set();
    for (const el of N.elementos()) {
      if (el.tipo === 'agente' && el.sessao && el.sessao.id) s.add(el.sessao.id);
      if (el.subagente && el.subagente.sessao) s.add(el.subagente.sessao);
      if (el.time && el.time.raiz) s.add(el.time.raiz);
    }
    try { const T = W.times; if (T && typeof T.quadros === 'function') for (const q of T.quadros()) if (q && q.raiz) s.add(q.raiz); } catch {}
    return s;
  }

  // ── ações ──
  // Ponto (centro de um card CW x CH) sem sobreposição, em espiral de anéis quadrados a partir do centro da vista.
  const CW = 260, CH = 120, FOLGA = 24;
  function pontoLivre(c) {
    let caixas = [];
    try { caixas = N.elementos().map((e) => N.caixaMundo(e)).filter((b) => b && isFinite(b.x + b.y + b.w + b.h)); } catch {}
    const livre = (x, y) => caixas.every((b) => x - CW / 2 >= b.x + b.w + 4 || x + CW / 2 <= b.x - 4 || y - CH / 2 >= b.y + b.h + 4 || y + CH / 2 <= b.y - 4);
    const px = CW + FOLGA, py = CH + FOLGA;
    if (livre(c.x, c.y)) return c;
    for (let r = 1; r <= 12; r++) {
      for (let i = -r; i <= r; i++) {
        for (const [dx, dy] of [[i, -r], [i, r], [-r, i], [r, i]]) {
          if (livre(c.x + dx * px, c.y + dy * py)) return { x: c.x + dx * px, y: c.y + dy * py };
        }
      }
    }
    return c;
  }
  function adicionarCentro(id) {
    const t = N.tamanho(), c = pontoLivre(N.telaParaMundo(t.w / 2, t.h / 2));
    let tratou = false;
    const T = W.times;
    if (T && typeof T.soltar === 'function') { try { tratou = !!T.soltar(id, c.x, c.y); } catch (e) { console.warn('whiteboard-painel: times.soltar', e); } }
    if (!tratou && W.agentes && typeof W.agentes.adicionar === 'function') W.agentes.adicionar(id, c.x, c.y);
    agendar(true);
  }
  function focarSessao(id) {
    const A = W.agentes, T = W.times;
    if (A && typeof A.cards === 'function' && A.cards().some((c) => c.sessao === id)) { A.focar(id); return; }
    if (T && typeof T.focar === 'function') { try { if (T.focar(id)) return; } catch {} }
    if (A && typeof A.focar === 'function') A.focar(id);
  }

  // ── lista ──
  function casa(s, q) {
    if (!q) return true;
    const alvo = norm([s.nome, s.projeto, s.statusTexto, s.status].join(' '));
    return q.split(/\s+/).every((p) => alvo.includes(p));
  }
  function linha(s, marcada) {
    const li = h('li', 'wb-pn-lin');
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.draggable = true;
    li.dataset.sessao = s.id;
    li.dataset.status = s.status || '';
    if (marcada) li.dataset.noquadro = '1';
    li.setAttribute('aria-label', `${s.nome || s.id}, ${s.statusTexto || s.status || ''}${marcada ? ', no quadro' : ''}`);
    li.title = marcada ? 'No quadro — clique para localizar' : 'Arraste para o quadro (ou clique duas vezes)';
    const img = h('img', 'wb-pn-spr');
    img.alt = ''; img.draggable = false; img.decoding = 'async';
    if (s.sprite) img.src = s.sprite;
    const tx = h('span', 'wb-pn-tx');
    tx.append(h('span', 'wb-pn-nome', s.nome || s.id), h('span', 'wb-pn-st', s.statusTexto || s.status || ''));
    li.append(img, tx);
    const selo = h('span', 'wb-pn-selo');
    selo.innerHTML = ICONE_NO_QUADRO;
    selo.hidden = !marcada;
    selo.title = 'No quadro';
    li.append(selo);
    return li;
  }
  function desenhar() {
    P.pendente = 0;
    if (!P.lista) return;
    const todas = lerSessoes();
    const tinhaFoco = P.lista.contains(document.activeElement);
    P.lista.textContent = '';
    if (tinhaFoco) { try { P.no.focus({ preventScroll: true }); } catch {} } // a linha focada some no redesenho: o foco fica no painel (Esc continua fechando)
    if (todas === null) { P.vazio.textContent = 'Sessões indisponíveis'; P.vazio.hidden = false; P.busca.disabled = true; atualizarBotao(); return; }
    P.busca.disabled = false;
    const marcadas = noQuadro(), q = norm(P.q).trim();
    const vis = todas.filter((s) => casa(s, q));
    P.vazio.hidden = vis.length > 0;
    if (!vis.length) P.vazio.textContent = todas.length ? 'Nenhuma sessão encontrada' : 'Nenhuma sessão aberta';
    const projetos = new Map();
    for (const s of vis) { const p = String(s.projeto || '').trim() || SEM_PROJETO; if (!projetos.has(p)) projetos.set(p, []); projetos.get(p).push(s); }
    const nomes = [...projetos.keys()].sort((a, b) => (a === SEM_PROJETO) - (b === SEM_PROJETO) || a.localeCompare(b, 'pt-BR'));
    for (const nome of nomes) {
      const itens = projetos.get(nome), fechado = !q && P.fechados.has(nome);
      const sec = h('li', 'wb-pn-proj');
      sec.dataset.projeto = nome;
      const cab = h('button', 'wb-pn-proj-cab');
      cab.type = 'button';
      cab.setAttribute('aria-expanded', fechado ? 'false' : 'true');
      const seta = h('span', 'wb-pn-seta'); seta.innerHTML = ICONE_SETA;
      cab.append(seta, h('span', 'wb-pn-proj-nome', nome), h('span', 'wb-pn-cont', String(itens.length)));
      const corpo = h('ul', 'wb-pn-corpo');
      corpo.setAttribute('role', 'list');
      corpo.hidden = fechado;
      for (const g of GRUPOS) {
        const do_g = itens.filter((s) => (GRUPO_DE[s.status] || 'recentes') === g.chave);
        if (!do_g.length) continue;
        const t = h('li', 'wb-pn-grupo-tit', g.titulo);
        t.dataset.grupo = g.chave;
        corpo.append(t);
        for (const s of do_g) corpo.append(linha(s, marcadas.has(s.id)));
      }
      sec.append(cab, corpo);
      P.lista.append(sec);
    }
    atualizarBotao();
  }
  function marcar() {
    P.pendente = 0;
    if (!P.lista) return;
    const m = noQuadro();
    for (const li of P.lista.querySelectorAll('.wb-pn-lin')) {
      const on = m.has(li.dataset.sessao);
      if (on === (li.dataset.noquadro === '1')) continue;
      if (on) li.dataset.noquadro = '1'; else delete li.dataset.noquadro;
      const selo = li.querySelector('.wb-pn-selo'); if (selo) selo.hidden = !on;
      const nome = li.querySelector('.wb-pn-nome'), st = li.querySelector('.wb-pn-st');
      li.setAttribute('aria-label', `${nome ? nome.textContent : ''}, ${st ? st.textContent : ''}${on ? ', no quadro' : ''}`);
      li.title = on ? 'No quadro — clique para localizar' : 'Arraste para o quadro (ou clique duas vezes)';
    }
  }
  let rafId = 0, refazerTudo = false;
  function agendar(tudo) {
    if (!P.aberto || !P.visivel) return;
    if (tudo) refazerTudo = true;
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; if (refazerTudo) { refazerTudo = false; desenhar(); } else marcar(); });
  }

  // ── escuta da fonte: só com o painel aberto e a vista visível ──
  function revisarEscuta() {
    const quer = P.aberto && P.visivel;
    if (quer && !P.desligar) {
      const f = fonte();
      if (f && typeof f.ouvir === 'function') {
        try { const d = f.ouvir(() => agendar(true)); P.desligar = typeof d === 'function' ? d : () => {}; } catch (e) { console.warn('whiteboard-painel: ouvir', e); }
      }
      desenhar(); // eventos perdidos enquanto desligado
    } else if (!quer && P.desligar) {
      try { P.desligar(); } catch {}
      P.desligar = null;
    }
  }

  // ── abrir / fechar ──
  function atualizarBotao() {
    if (!P.btn) return;
    const sem = !fonte() || typeof fonte().lista !== 'function';
    P.btn.disabled = sem && !P.aberto;
    P.btn.setAttribute('aria-expanded', P.aberto ? 'true' : 'false');
    P.btn.title = sem && !P.aberto ? 'Sessões indisponíveis' : (P.aberto ? 'Fechar painel de sessões (Shift+A)' : 'Painel de sessões (Shift+A)');
    P.btn.setAttribute('aria-label', P.btn.title);
  }
  function aplicar(foco) {
    if (!P.no) return;
    P.no.dataset.aberto = P.aberto ? '1' : '0';
    P.no.setAttribute('aria-hidden', P.aberto ? 'false' : 'true');
    if (P.vista) { if (P.aberto) P.vista.dataset.painel = 'aberto'; else delete P.vista.dataset.painel; }
    atualizarBotao();
    revisarEscuta();
    if (P.aberto && foco && P.visivel) { try { P.busca.focus({ preventScroll: true }); } catch {} }
  }
  function abrir() { if (P.aberto) return true; P.aberto = true; guardar(); aplicar(true); return true; }
  function fechar() {
    if (!P.aberto) return false;
    const tinhaFoco = P.no && P.no.contains(document.activeElement);
    P.aberto = false; guardar(); aplicar(false);
    if (tinhaFoco && P.btn && !P.btn.disabled) { try { P.btn.focus({ preventScroll: true }); } catch {} }
    return true;
  }
  const alternar = () => (P.aberto ? fechar() : abrir());

  // ── montagem (a vista só existe depois de Whiteboard.entrar) ──
  function montar() {
    const c = N.camadaHtml();
    const vista = c && c.closest('.wb-vista');
    if (!vista) return;
    if (P.no && P.vista === vista && vista.contains(P.no)) return;
    if (P.io) { P.io.disconnect(); P.io = null; }
    P.vista = vista;
    P.btn = h('button', 'wb-pn-btn');
    P.btn.type = 'button';
    P.btn.innerHTML = ICONE_PESSOAS;
    P.btn.setAttribute('aria-controls', 'wb-pn-painel');
    P.btn.addEventListener('click', alternar);
    const no = P.no = h('aside', 'wb-pn');
    no.id = 'wb-pn-painel';
    no.setAttribute('aria-label', 'Sessões');
    no.tabIndex = -1;
    const cab = h('div', 'wb-pn-cab');
    const campo = h('label', 'wb-pn-campo');
    const lupa = h('span', 'wb-pn-lupa'); lupa.innerHTML = ICONE_BUSCA;
    P.busca = h('input', 'wb-pn-busca');
    P.busca.type = 'text'; P.busca.placeholder = 'Buscar sessão'; P.busca.autocomplete = 'off'; P.busca.spellcheck = false;
    P.busca.setAttribute('aria-label', 'Buscar sessão por nome, projeto ou status');
    P.limpar = h('button', 'wb-pn-limpar', '×');
    P.limpar.type = 'button'; P.limpar.hidden = true; P.limpar.setAttribute('aria-label', 'Limpar busca'); P.limpar.title = 'Limpar busca';
    campo.append(lupa, P.busca, P.limpar);
    cab.append(campo);
    P.lista = h('ul', 'wb-pn-lista');
    P.lista.setAttribute('role', 'list');
    P.vazio = h('p', 'wb-pn-vazio'); P.vazio.hidden = true;
    P.vazio.setAttribute('role', 'status');
    no.append(cab, P.lista, P.vazio);
    vista.append(P.btn, no);
    ligarEventos();
    P.io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => { const v = es.some((x) => x.isIntersecting); if (v !== P.visivel) { P.visivel = v; revisarEscuta(); } }) : null;
    if (P.io) P.io.observe(no); else { P.visivel = true; }
    aplicar(false);
  }

  function ligarEventos() {
    const no = P.no;
    P.busca.addEventListener('input', () => { P.q = P.busca.value; P.limpar.hidden = !P.q; desenhar(); });
    P.limpar.addEventListener('click', () => { P.busca.value = ''; P.q = ''; P.limpar.hidden = true; desenhar(); P.busca.focus(); });
    P.busca.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        if (P.busca.value) { P.busca.value = ''; P.q = ''; P.limpar.hidden = true; desenhar(); } else fechar();
      } else if (e.key === 'ArrowDown') {
        const l = no.querySelector('.wb-pn-lin'); if (l) { e.preventDefault(); l.focus(); }
      }
    });
    no.addEventListener('click', (e) => {
      const cab = e.target.closest('.wb-pn-proj-cab');
      if (cab) {
        const sec = cab.parentElement, nome = sec.dataset.projeto, fecha = cab.getAttribute('aria-expanded') === 'true';
        if (fecha) P.fechados.add(nome); else P.fechados.delete(nome);
        cab.setAttribute('aria-expanded', fecha ? 'false' : 'true');
        sec.querySelector('.wb-pn-corpo').hidden = fecha;
        return;
      }
      const li = e.target.closest('.wb-pn-lin');
      if (li && li.dataset.noquadro === '1') focarSessao(li.dataset.sessao);
    });
    no.addEventListener('dblclick', (e) => {
      const li = e.target.closest('.wb-pn-lin');
      if (li && li.dataset.noquadro !== '1') adicionarCentro(li.dataset.sessao);
    });
    no.addEventListener('keydown', (e) => {
      const li = e.target.closest && e.target.closest('.wb-pn-lin');
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fechar(); return; }
      if (!li) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (li.dataset.noquadro === '1') focarSessao(li.dataset.sessao); else adicionarCentro(li.dataset.sessao);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const ls = [...no.querySelectorAll('.wb-pn-corpo:not([hidden]) .wb-pn-lin')], i = ls.indexOf(li) + (e.key === 'ArrowDown' ? 1 : -1);
        if (i < 0) P.busca.focus(); else if (ls[i]) ls[i].focus();
      }
    });
    no.addEventListener('dragstart', (e) => {
      const li = e.target.closest && e.target.closest('.wb-pn-lin');
      if (!li || !e.dataTransfer) { e.preventDefault(); return; }
      try {
        e.dataTransfer.setData(TIPO_DT, li.dataset.sessao);
        e.dataTransfer.setData('text/plain', li.dataset.sessao);
        e.dataTransfer.effectAllowed = 'copy';
      } catch {}
      li.classList.add('wb-pn-arrasto');
    });
    no.addEventListener('dragend', (e) => { const li = e.target.closest && e.target.closest('.wb-pn-lin'); if (li) li.classList.remove('wb-pn-arrasto'); agendar(false); });
  }

  // Atalho Shift+A (letras sem Shift são das ferramentas; o núcleo ignora Shift+letra). Só com a vista visível e fora de campos.
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyA' || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (!P.vista || !P.vista.offsetParent && P.vista.getClientRects().length === 0) return;
    const a = e.target;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    if (W.dialogo) return;
    if (!P.btn || (P.btn.disabled && !P.aberto)) return;
    e.preventDefault(); e.stopPropagation();
    alternar();
  }, true);

  N.on('quadro', () => { montar(); atualizarBotao(); agendar(true); });
  N.on('mudanca', () => agendar(false));
  montar();

  W.estender('painel', Object.freeze({ abrir, fechar, alternar, aberto: () => P.aberto }));
})();
