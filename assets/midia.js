/* Música tocando — widget no pé da lateral e a chave das Configurações (servidor: midia.mjs).
 *
 * Integração: o index.html tem #midia-widget (dentro de #perfil-pe, acima do botão do perfil) e #cfg-midia
 * (Configurações) e carrega este arquivo depois do script principal. Da página só se usa
 * window.GerenciadorAPI.on('midia' | 'conexao').
 *
 * A música vem dos controles de mídia do sistema (Windows) ou do app do Spotify (Mac), pelo servidor. Os
 * controles (anterior, play/pause, próxima) aparecem no hover e vão para POST /midia/comando. A capa vem do
 * próprio Orbit (/midia/capa). Texto vindo do servidor entra só por textContent.
 */
(function () {
  'use strict';

  const widget = document.getElementById('midia-widget');
  const cfg = document.getElementById('cfg-midia');
  if (!widget && !cfg) return;
  const api = window.GerenciadorAPI;

  const MS_TROCA = 680; // a transição mais longa do CSS (texto: 0,46 s + 0,16 s de atraso), com folga

  const st = { m: null, antigo: false, enviando: false };
  const ui = {};

  // ───────────────────────────── utilidades ─────────────────────────────
  function h(tag, props, ...filhos) {
    const e = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const f of filhos) if (f != null && f !== false) e.append(f);
    return e;
  }
  function txt(el, v) {
    const t = v == null ? '' : String(v);
    if (el.textContent !== t) el.textContent = t;
  }

  // Mesmo traço dos ícones da página (16 × 16, linha 1,5); play, pause e os pulos são preenchidos.
  const NS = 'http://www.w3.org/2000/svg';
  const CHEIO = { fill: 'currentColor', stroke: 'none' };
  const ICONES = {
    nota: [['path', { d: 'M6 12.2V3.6l7-1.4v8.4' }], ['circle', { cx: 4.3, cy: 12.2, r: 1.7 }], ['circle', { cx: 11.3, cy: 10.6, r: 1.7 }]],
    play: [['path', { d: 'M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5Z', ...CHEIO }]],
    pause: [['rect', { x: 4, y: 3, width: 2.8, height: 10, rx: .8, ...CHEIO }], ['rect', { x: 9.2, y: 3, width: 2.8, height: 10, rx: .8, ...CHEIO }]],
    proxima: [['path', { d: 'M3.5 3.6v8.8a.5.5 0 0 0 .8.4l6.2-4.4a.5.5 0 0 0 0-.8L4.3 3.2a.5.5 0 0 0-.8.4Z', ...CHEIO }], ['rect', { x: 11, y: 3, width: 1.8, height: 10, rx: .6, ...CHEIO }]],
    anterior: [['path', { d: 'M12.5 3.6v8.8a.5.5 0 0 1-.8.4L5.5 8.4a.5.5 0 0 1 0-.8l6.2-4.4a.5.5 0 0 1 .8.4Z', ...CHEIO }], ['rect', { x: 3.2, y: 3, width: 1.8, height: 10, rx: .6, ...CHEIO }]],
  };
  function icone(nome, tam = 16) {
    const v = document.createElementNS(NS, 'svg');
    const attrs = { viewBox: '0 0 16 16', width: tam, height: tam, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' };
    for (const k in attrs) v.setAttribute(k, String(attrs[k]));
    for (const [t, a] of ICONES[nome] || []) {
      const e = document.createElementNS(NS, t);
      for (const k in a) e.setAttribute(k, String(a[k]));
      v.append(e);
    }
    return v;
  }

  async function postar(caminho, corpo) {
    let r;
    try {
      r = await fetch(caminho, { method: 'POST', cache: 'no-store', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify(corpo || {}) });
    } catch {
      throw new Error('Sem conexão com o servidor do Orbit.');
    }
    let d = null;
    try { d = await r.json(); } catch {}
    if (!r.ok) throw new Error((d && typeof d.erro === 'string' && d.erro) || 'O servidor do Orbit respondeu ' + r.status + '.');
    return d;
  }

  // ───────────────────────────── estado ─────────────────────────────
  function valido(p) {
    return p && typeof p === 'object' && typeof p.ativo === 'boolean' && (p.midia == null || typeof p.midia === 'object');
  }
  function aplicar(p) {
    if (!valido(p)) return;
    st.m = p;
    st.antigo = false;
    renderWidget();
    renderCfg();
  }
  async function carregar() {
    try {
      const r = await fetch('/midia', { cache: 'no-store' });
      if (r.status === 404) { st.antigo = true; renderCfg(); return; }
      if (r.ok) aplicar(await r.json());
    } catch {}
  }

  // ───────────────────────────── widget ─────────────────────────────
  // O cartão fica parado (altura, posição, barrinhas): só a capa e o texto trocam, em camadas no mesmo lugar.
  let atual = null; // { id, nada }
  let pedido = 0;

  // Nunca tocou nada desde que o widget existe: um estado discreto.
  const NADA = { id: '', titulo: 'Nada tocando', artista: 'Música', album: '', capa: null, nada: true, estado: 'pausado', controles: { play: false, prox: false, ant: false } };

  function camadas(t) {
    const capa = h('span', { class: 'sp-capa-c' });
    if (t.capa) {
      const img = h('img', { alt: '', decoding: 'async', draggable: 'false' });
      img.addEventListener('error', () => img.replaceWith(icone('nota', 14)), { once: true });
      img.src = t.capa;
      capa.append(img);
    } else capa.append(icone('nota', 14));
    const quem = t.artista || t.album || t.app || '';
    const texto = h('span', { class: 'sp-txt-c' }, h('span', { class: 'sp-titulo', text: t.titulo }), h('span', { class: 'sp-artista', text: quem }));
    return { capa, texto };
  }
  function estadoFaixa(t) {
    ui.faixa.classList.toggle('sp-vazio', !!t.nada);
    ui.faixa.classList.toggle('pausado', !t.nada && t.estado !== 'tocando');
  }

  // Espera a capa nova carregar (no máximo 1,5 s) para a troca não piscar um quadrado vazio.
  function preparar(url) {
    if (!url) return Promise.resolve();
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    const pronto = img.decode ? img.decode().catch(() => {}) : new Promise((ok) => { img.onload = img.onerror = ok; });
    return Promise.race([pronto, new Promise((ok) => setTimeout(ok, 1500))]);
  }

  function renderControles(t) {
    const c = t.controles || {};
    const tocando = t.estado === 'tocando';
    ui.ctl.hidden = !!t.nada;
    const rotPlay = tocando ? 'Pausar' : t.lembranca ? 'Abrir o Spotify e tocar' : 'Tocar';
    if (ui.play._icone !== (tocando ? 'pause' : 'play')) {
      ui.play._icone = tocando ? 'pause' : 'play';
      ui.play.replaceChildren(icone(ui.play._icone, 14));
    }
    ui.play.title = rotPlay;
    ui.play.setAttribute('aria-label', rotPlay);
    ui.play.disabled = !c.play || st.enviando;
    ui.ant.disabled = !c.ant;
    ui.prox.disabled = !c.prox;
  }

  async function renderWidget() {
    if (!widget) return;
    const m = st.m;
    const n = ++pedido;
    // Fica visível com a chave ligada; só a chave das Configurações esconde.
    if (!m || !m.ativo || m.suportado === false) {
      widget.classList.remove('on');
      widget.setAttribute('aria-hidden', 'true');
      widget.removeAttribute('title');
      return;
    }
    const t = m.midia || NADA;
    const via = t.app && !t.spotify ? ' (' + t.app + ')' : '';
    const rotulo = t.nada ? 'Nada tocando'
      : (t.lembranca ? 'Última música: ' : t.estado === 'tocando' ? 'Tocando: ' : 'Pausado: ') + t.titulo + (t.artista ? ' — ' + t.artista : '') + via;
    ui.palco.title = t.nada ? 'Nada tocando' : t.titulo + (t.artista ? ' — ' + t.artista : '') + (t.album ? '\n' + t.album : '')
      + '\n' + (t.lembranca ? 'Última música' : t.estado === 'tocando' ? 'Tocando' : 'Pausado') + (t.app ? ' · ' + t.app : '');
    txt(ui.anuncio, rotulo);
    renderControles(t);
    if (atual && atual.id === t.id && !atual.nada === !t.nada) {
      // Mesma música: só alterna tocando ↔ pausado, sem trocar de camada.
      estadoFaixa(t);
      widget.classList.add('on');
      widget.removeAttribute('aria-hidden');
      return;
    }
    await preparar(t.capa);
    if (n !== pedido) return; // chegou outra mudança enquanto a capa carregava
    const novo = camadas(t);
    estadoFaixa(t);
    if (widget.classList.contains('on') && atual) {
      // A nova entra por cima enquanto a antiga sai; trocas seguidas só empilham camadas que já estão saindo.
      const velhas = [...ui.capa.children, ...ui.txt.children].filter((e) => !e.classList.contains('saindo'));
      novo.capa.classList.add('entrando');
      novo.texto.classList.add('entrando');
      ui.capa.append(novo.capa);
      ui.txt.append(novo.texto);
      for (const v of velhas) { v.classList.add('saindo'); setTimeout(() => v.remove(), MS_TROCA); }
      requestAnimationFrame(() => requestAnimationFrame(() => { novo.capa.classList.remove('entrando'); novo.texto.classList.remove('entrando'); }));
    } else {
      ui.capa.replaceChildren(novo.capa);
      ui.txt.replaceChildren(novo.texto);
    }
    atual = { id: t.id, nada: !!t.nada };
    widget.classList.add('on');
    widget.removeAttribute('aria-hidden');
  }

  async function comando(acao) {
    const m = st.m && st.m.midia;
    if (!m || st.enviando) return;
    // Play/pause muda na hora; o servidor confirma pelo /fluxo em ~0,3 s.
    if (acao === 'alternar' && !m.lembranca && atual && atual.id === m.id) {
      m.estado = m.estado === 'tocando' ? 'pausado' : 'tocando';
      estadoFaixa(m);
      renderControles(m);
    }
    st.enviando = acao === 'alternar' && m.lembranca; // abrir o Spotify leva alguns segundos
    if (st.enviando) renderControles(m);
    try {
      // A resposta ainda é de antes do player reagir: a confirmação chega pelo /fluxo (evento midia).
      await postar('/midia/comando', { acao });
    } catch (e) {
      carregar();
    } finally {
      if (st.enviando) { st.enviando = false; if (st.m && st.m.midia) renderControles(st.m.midia); }
    }
  }

  function montarWidget() {
    if (!widget) return;
    const bt = (acao, nome, rot, extra) => h('button', { type: 'button', class: 'sp-bt' + (extra ? ' ' + extra : ''), title: rot, 'aria-label': rot, onclick: () => comando(acao) }, icone(nome, 14));
    ui.ant = bt('anterior', 'anterior', 'Anterior');
    ui.play = bt('alternar', 'play', 'Tocar', 'principal');
    ui.play._icone = 'play';
    ui.prox = bt('proxima', 'proxima', 'Próxima');
    ui.ctl = h('div', { class: 'sp-ctl', role: 'group', 'aria-label': 'Controles da música' }, ui.ant, ui.play, ui.prox);
    ui.capa = h('span', { class: 'sp-capa' });
    ui.txt = h('span', { class: 'sp-txt' });
    ui.faixa = h('div', { class: 'sp-faixa' }, ui.capa, ui.txt, h('span', { class: 'sp-eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
    ui.palco = h('div', { class: 'sp-palco' }, ui.faixa, ui.ctl);
    ui.anuncio = h('span', { role: 'status', style: 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap' });
    widget.replaceChildren(h('div', { class: 'sp-dentro' }, ui.palco, ui.anuncio));
    widget.setAttribute('aria-hidden', 'true');
    widget.setAttribute('aria-label', 'Música tocando');
    widget.setAttribute('role', 'region');
    widget.hidden = false;
  }

  // ───────────────────────────── Configurações ─────────────────────────────
  function montarCfg() {
    if (!cfg) return;
    ui.ativo = h('input', { id: 'cfg-midia-ativo', class: 'chave', type: 'checkbox' });
    ui.ativo.addEventListener('change', () => {
      const v = ui.ativo.checked;
      postar('/midia/ativo', { ativo: v }).then(aplicar).catch(() => { ui.ativo.checked = !v; });
    });
    ui.ativoSub = h('small');
    cfg.replaceChildren(h('div', { class: 'cfg-linha' },
      h('label', { for: 'cfg-midia-ativo' }, 'Mostrar a música tocando', ui.ativoSub),
      ui.ativo));
  }

  function renderCfg() {
    if (!cfg) return;
    const m = st.m;
    ui.ativo.disabled = st.antigo || !m || m.suportado === false;
    ui.ativo.checked = !!(m && m.ativo);
    txt(ui.ativoSub, st.antigo ? 'Reinicie o servidor do Orbit para usar.'
      : m && m.suportado === false ? 'Este sistema não tem controles de mídia que o Orbit saiba usar.'
      : 'Na lateral, acima do perfil. Lê os controles de mídia do sistema, com o Spotify na frente.');
  }

  montarWidget();
  montarCfg();
  renderCfg();
  carregar();
  if (api && typeof api.on === 'function') {
    api.on('midia', aplicar);
    api.on('conexao', (estado) => { if (estado === 'vivo') carregar(); });
  }
})();
