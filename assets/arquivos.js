// Orbit — projetos e arquivos na barra lateral (rodada 8, Projetos e arquivos na lateral).
// window.Arquivos: montar(api, ganchos) · renderLateral(dados) · montarVista(el) · pausar() · retomar() · projetos().
// Lista de projetos (GET /projetos + SSE "projetos"), árvore como o explorador do VS Code (carga sob demanda, SSE
// "arquivos"), menu de botão direito, atalhos, novo/renomear inline, excluir para a Lixeira com confirmação, seletor de
// pasta, prévia (#arquivo) e "Localizar na pasta". Só textContent/createElement; nada de innerHTML com dado.
(() => {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const SEP = '\u001f';
  const LS_ABERTOS = 'orbit.arquivos.abertos';
  const LS_QUEBRA = 'orbit.arquivos.quebra';
  const col = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

  // Rótulos do gerenciador de arquivos do sistema: o servidor diz a plataforma no GET /projetos.
  const noMac = () => E.plataforma === 'darwin';
  const nomeExplorador = () => (noMac() ? 'Finder' : 'Explorador');
  const rotRevelar = () => (noMac() ? 'Mostrar no Finder' : 'Revelar no Explorador');

  const E = {
    plataforma: '', api: null, g: {}, lista: null, listaSig: '', semRota: false,
    dados: { contagens: {}, alertas: [], ativo: '' },
    caixa: null, linhas: new Map(),
    abertos: new Set(lerLS(LS_ABERTOS, []).filter((k) => typeof k === 'string')),
    cache: new Map(), carregando: new Map(), repetir: new Set(), erros: new Map(), agendados: new Set(),
    sel: new Set(), ancora: null, focoPendente: null, focoProj: null,
    clip: null, edicao: null, menu: null, pilha: [],
    // Vistas (prévia/busca): a principal (montarVista, #arquivo) e as das abas (criarVista), cada uma com estado próprio.
    vistas: new Set(), vp: null, quebra: !!lerLS(LS_QUEBRA, false), ativo: null,
    busca: { texto: '', maiusculas: false, palavra: false, regex: false },
    toasts: null,
    tema: { ic: null, sig: '', seq: 0 },
  };

  // ───────────── utilidades ─────────────
  function lerLS(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } }
  function gravarLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  const chave = (p, c) => p + SEP + c;
  const partir = (k) => { const i = k.indexOf(SEP); return [k.slice(0, i), k.slice(i + 1)]; };
  const paiDe = (c) => (c.includes('/') ? c.slice(0, c.lastIndexOf('/')) : '');
  const baseDe = (c) => c.slice(c.lastIndexOf('/') + 1);
  const juntar = (a, b) => (a ? a + '/' + b : b);
  const qs = (o) => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const proj = (nome) => (E.lista ? E.lista.find((p) => p.nome === nome) || null : null);
  const salvarAbertos = () => gravarLS(LS_ABERTOS, [...E.abertos].slice(-800));

  function h(tag, at, ...filhos) {
    const el = document.createElement(tag);
    if (at) for (const [k, v] of Object.entries(at)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const f of filhos.flat()) if (f != null && f !== false) el.append(f instanceof Node ? f : document.createTextNode(String(f)));
    return el;
  }
  function chamar(nome, ...args) {
    const fn = E.g && E.g[nome];
    if (typeof fn !== 'function') return undefined;
    try { return fn(...args); } catch (e) { console.warn('Arquivos: gancho ' + nome, e); return undefined; }
  }
  // 20/10: nome de exibição do projeto (o index.html guarda o rótulo); a chave segue sendo o nome da pasta.
  function rotulo(nome) { const r = chamar('nomeProjeto', nome); return typeof r === 'string' && r ? r : nome; }
  function tamanhoTxt(n) {
    if (!Number.isFinite(n)) return '';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB']; let v = n / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toLocaleString('pt-BR', { maximumFractionDigits: v < 10 ? 1 : 0 }) + ' ' + u[i];
  }
  function absoluto(nome, caminho) {
    const p = proj(nome);
    const raiz = String(p ? p.pasta : '').replace(/[\\/]+$/, '');
    // Mac (16/10): caminho com barras normais, como o Finder e o Terminal copiam.
    if (noMac()) return caminho ? raiz + '/' + caminho : raiz || '/';
    const r = /^[A-Za-z]:$/.test(raiz) ? raiz + '\\' : raiz;
    if (!caminho) return r;
    return (r.endsWith('\\') ? r : r + '\\') + caminho.replace(/\//g, '\\');
  }
  const relativo = (c) => (c ? (noMac() ? c : c.replace(/\//g, '\\')) : '.');

  async function pedir(url, corpo) {
    const init = corpo !== undefined
      ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify(corpo) }
      : { cache: 'no-store' };
    let r;
    try { r = await fetch(url, init); } catch { const e = new Error('Sem conexão com o Orbit.'); e.status = 0; throw e; }
    let j = null;
    try { j = await r.json(); } catch {}
    if (!r.ok) {
      const e = new Error((j && typeof j.erro === 'string' && j.erro) || ('Erro ' + r.status + '.'));
      e.status = r.status; e.motivo = j && j.motivo; throw e;
    }
    j = j && typeof j === 'object' ? j : {};
    Object.defineProperty(j, '_status', { value: r.status, enumerable: false });
    return j;
  }

  // ───────────── ícones (SVG próprio, 16×16) ─────────────
  function svg(partes, tam = 16) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('width', tam); s.setAttribute('height', tam);
    s.setAttribute('fill', 'none'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    for (const p of partes) {
      const el = document.createElementNS(NS, p.c ? 'circle' : 'path');
      if (p.c) { el.setAttribute('cx', p.c[0]); el.setAttribute('cy', p.c[1]); el.setAttribute('r', p.c[2]); } else el.setAttribute('d', p.d);
      if (p.f) el.setAttribute('fill', p.f);
      if (!p.f || p.s) {
        el.setAttribute('stroke', p.s || 'currentColor'); el.setAttribute('stroke-width', p.w || 1.25);
        el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round');
      }
      if (p.o) el.setAttribute('opacity', p.o);
      s.append(el);
    }
    return s;
  }
  const DOC = 'M3.75 2.25c0-.28.22-.5.5-.5h4.5l3.5 3.5v8.5c0 .28-.22.5-.5.5h-7.5a.5.5 0 0 1-.5-.5z';
  const DOBRA = 'M8.75 1.75v3.5h3.5';
  const COR = { js: '#e2c26b', ts: '#6ea8f0', json: '#d9a35c', md: '#7fb0e8', html: '#e88a5e', css: '#a78bfa', py: '#6cb4d9',
    svg: '#e0b35a', imagem: '#5fbfa7', config: '#9aa5b1', lock: '#c7a35f', zip: '#b39770', pdf: '#ef7272', pasta: '#8f9aab' };
  const GLIFO = {
    js: (c) => [{ d: 'M7 7.25c-.75 0-1 .35-1 .9v.6c0 .45-.25.75-.75.75.5 0 .75.3.75.75v.6c0 .55.25.9 1 .9', s: c, w: 1.15 }, { d: 'M9 7.25c.75 0 1 .35 1 .9v.6c0 .45.25.75.75.75-.5 0-.75.3-.75.75v.6c0 .55-.25.9-1 .9', s: c, w: 1.15 }],
    json: (c) => [{ c: [6.25, 8.75, 0.75], f: c }, { d: 'M8 8.75h2.5', s: c }, { c: [6.25, 11.25, 0.75], f: c }, { d: 'M8 11.25h2.5', s: c }],
    md: (c) => [{ d: 'M5.4 12V8.3l1.45 1.7 1.45-1.7V12', s: c, w: 1.1 }, { d: 'M10.4 8.3V12m-.95-.95.95.95.95-.95', s: c, w: 1.1 }],
    html: (c) => [{ d: 'M6.6 8.1 5 9.75l1.6 1.65', s: c }, { d: 'M9.4 8.1 11 9.75l-1.6 1.65', s: c }],
    css: (c) => [{ d: 'M6.9 7.6 6.3 12.1M9.4 7.6l-.6 4.5M5.4 9.1h5M5.1 10.6h5', s: c, w: 1.05 }],
    py: (c) => [{ d: 'M8 7.5H6.9c-.75 0-1.05.3-1.05 1.05V9.6H8.6', s: c, w: 1.1 }, { d: 'M8 12.3h1.1c.75 0 1.05-.3 1.05-1.05V10.2H7.4', s: c, w: 1.1 }],
    txt: () => [{ d: 'M5.75 8.25h4.5M5.75 10.25h4.5M5.75 12.25h2.75', o: 0.8 }],
    config: (c) => [{ c: [8, 10, 1.15], s: c, w: 1.1 }, { d: 'M8 7.3v.8M8 11.9v.8M5.3 10h.8M9.9 10h.8M6.1 8.1l.55.55M9.35 11.35l.55.55M9.9 8.1l-.55.55M6.65 11.35l-.55.55', s: c, w: 1 }],
    lock: (c) => [{ d: 'M5.75 9.6h4.5v2.9h-4.5z', s: c, w: 1.1 }, { d: 'M6.8 9.6v-1a1.2 1.2 0 0 1 2.4 0v1', s: c, w: 1.1 }],
    zip: (c) => [{ d: 'M8 5.6v.9M8 7.4v.9M8 9.2v.9', s: c, w: 1.1 }, { d: 'M7.1 10.9h1.8v1.6H7.1z', s: c, w: 1.1 }],
    pdf: (c) => [{ d: 'M5.25 9.1h5.5v2.6h-5.5z', f: c, o: 0.85 }],
    svg: (c) => [{ d: 'M5.6 12c.45-2.7 1.9-4.2 4.6-4.4', s: c, w: 1.1 }, { d: 'M4.9 11.3h1.4v1.4H4.9zM9.7 6.9h1.4v1.4H9.7z', f: c }],
  };
  function tipoArq(nome) {
    const n = nome.toLowerCase();
    const ext = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : '';
    if (/(^|[.-])lock$|-lock\.(json|ya?ml)$|\.lockb$/.test(n)) return 'lock';
    if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) return 'js';
    if (['ts', 'mts', 'cts', 'tsx'].includes(ext)) return 'ts';
    if (['json', 'jsonc', 'json5'].includes(ext)) return 'json';
    if (['md', 'markdown', 'mdx'].includes(ext)) return 'md';
    if (['html', 'htm'].includes(ext)) return 'html';
    if (['css', 'scss', 'sass', 'less'].includes(ext)) return 'css';
    if (['py', 'pyw', 'pyi'].includes(ext)) return 'py';
    if (ext === 'svg') return 'svg';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'].includes(ext)) return 'imagem';
    if (['txt', 'log'].includes(ext)) return 'txt';
    if (['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz'].includes(ext)) return 'zip';
    if (ext === 'pdf') return 'pdf';
    if (n.startsWith('.') || ['yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env', 'properties'].includes(ext) || /(^|\.)config\.[a-z]+$/.test(n)) return 'config';
    return 'outro';
  }
  function iconeItem(nome, tipo, aberto, tam = 16) {
    const el = h('span', { class: 'arq-ico', 'aria-hidden': 'true' });
    const doTema = iconeDoTema(nome, tipo, aberto, tam);
    if (doTema) { el.classList.add('arq-ico-tema'); el.append(doTema); return el; }
    if (tipo === 'pasta') {
      const c = COR.pasta;
      el.append(svg(aberto
        ? [{ d: 'M1.75 11.9V4.5c0-.55.45-1 1-1h3.07c.27 0 .52.11.71.29L7.75 5h4.5c.55 0 1 .45 1 1v1.1', s: c }, { d: 'M2.05 12.45 3.6 8.1c.14-.38.5-.6.9-.6h9.25c.66 0 1.14.66.93 1.3l-1.25 3.7c-.14.4-.51.65-.93.65H2.7c-.45 0-.78-.36-.65-.7z', s: c, f: 'rgba(143,154,171,.16)' }]
        : [{ d: 'M1.75 4.5c0-.55.45-1 1-1h3.07c.27 0 .52.11.71.29L7.75 5h5.5c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z', s: c, f: 'rgba(143,154,171,.16)' }], tam));
      return el;
    }
    const t = tipoArq(nome);
    el.dataset.t = t;
    if (t === 'imagem') {
      const c = COR.imagem;
      el.append(svg([{ d: 'M2.25 3.75c0-.55.45-1 1-1h9.5c.55 0 1 .45 1 1v8.5c0 .55-.45 1-1 1h-9.5c-.55 0-1-.45-1-1z' }, { d: 'M2.6 11.6 5.8 8.4l2.4 2.4 1.5-1.5 3.6 3.1', s: c }, { c: [10.5, 6, 1.1], f: c }], tam));
      return el;
    }
    const glifo = GLIFO[t === 'ts' ? 'js' : t];
    el.append(svg([{ d: DOC }, { d: DOBRA }, ...(glifo ? glifo(COR[t]) : [])], tam));
    return el;
  }
  const UI = {
    seta: [{ d: 'M6 4l4 4-4 4', w: 1.5 }],
    copiar: [{ d: 'M5.5 5.5V3.25c0-.55.45-1 1-1h6.25c.55 0 1 .45 1 1V9.5c0 .55-.45 1-1 1H10.5' }, { d: 'M2.25 6.5c0-.55.45-1 1-1H9.5c.55 0 1 .45 1 1v6.25c0 .55-.45 1-1 1H3.25c-.55 0-1-.45-1-1z' }],
    revelar: [{ d: 'M1.75 12V4.5c0-.55.45-1 1-1h3.07c.27 0 .52.11.71.29L7.75 5h5.5c.55 0 1 .45 1 1v2' }, { d: 'M1.75 12c0 .55.45 1 1 1h5' }, { d: 'M10.5 13.5l3-3m0 0h-2.4m2.4 0v2.4' }],
    quebra: [{ d: 'M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H8.5m0 0 1.5-1.5M8.5 12l1.5 1.5M2.5 12h3' }],
    fechar: [{ d: 'M4 4l8 8M12 4l-8 8', w: 1.4 }],
    busca: [{ c: [7, 7, 4.25] }, { d: 'M10.2 10.2 13.5 13.5' }],
    mais: [{ d: 'M8 3.25v9.5M3.25 8h9.5', w: 1.4 }],
    acima: [{ d: 'M8 12.75V3.5m0 0L4.25 7.25M8 3.5l3.75 3.75' }],
    casa: [{ d: 'M2.5 7.25 8 2.75l5.5 4.5V13c0 .28-.22.5-.5.5H9.75V10h-3.5v3.5H3c-.28 0-.5-.22-.5-.5z' }],
    unidade: [{ d: 'M2 9.25 3.6 4c.13-.45.54-.75 1-.75h6.8c.46 0 .87.3 1 .75L14 9.25V12c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1z' }, { d: 'M2 9.25h12' }, { c: [11.25, 11.1, 0.55], f: 'currentColor' }],
    lixeira: [{ d: 'M2.75 4.25h10.5M6.25 4.25V3c0-.41.34-.75.75-.75h2c.41 0 .75.34.75.75v1.25M4 4.25l.6 8.6c.04.52.48.9 1 .9h4.8c.52 0 .96-.38 1-.9l.6-8.6' }],
    projeto: [{ d: 'M1.75 4.5c0-.55.45-1 1-1h3.07c.27 0 .52.11.71.29L7.75 5h5.5c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z' }, { d: 'M8 7.5v3.5M6.25 9.25h3.5' }],
    info: [{ c: [8, 8, 5.75] }, { d: 'M8 7.25v3.5' }, { c: [8, 5.1, 0.6], f: 'currentColor' }],
  };
  const ico = (n, tam = 16) => svg(UI[n], tam);

  // ───────────── tema do VS Code (temas do VS Code, temas.mjs) ─────────────
  // Ícones do tema de ícones ativo no VS Code (GET /temas/icones) e cores do texto do tema de cores (GET
  // /arquivos/realce). Sem o mapa ou sem um ícone para o item, fica o SVG próprio acima; sem realce, o texto puro.
  function carregarTema() {
    const seq = ++E.tema.seq;
    return fetch('/temas/icones', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((j) => {
        if (seq !== E.tema.seq) return;
        const ok = !!(j && j.ok && j.defs && typeof j.defs === 'object');
        const sig = ok ? String(j.versao || '') : '';
        if (sig === E.tema.sig && E.tema.ic) return;
        E.tema.ic = ok ? j : null; E.tema.sig = sig;
        pintarFontesTema();
        redesenharIcones();
      });
  }
  function pintarFontesTema() {
    let st = document.getElementById('arq-tema-fontes');
    const T = E.tema.ic;
    const css = T && Array.isArray(T.fontes) ? T.fontes.filter((f) => Number.isInteger(f.i)).map((f) =>
      `@font-face{font-family:"orbit-ico-${f.i}";src:url("/temas/fonte/${f.i}?v=${encodeURIComponent(T.versao || '')}") format("${String(f.formato || 'woff').replace(/[^a-z0-9]/gi, '')}");` +
      `font-weight:${String(f.peso || 'normal').replace(/[^a-z0-9]/gi, '')};font-style:${String(f.estilo || 'normal').replace(/[^a-z]/gi, '')};font-display:block}`).join('\n') : '';
    if (!css) { if (st) st.remove(); return; }
    if (!st) { st = document.createElement('style'); st.id = 'arq-tema-fontes'; document.head.append(st); }
    st.textContent = css;
  }
  function redesenharIcones() {
    for (const [nome, ent] of E.linhas) if (ent.filhos) desenharProjeto(nome);
    for (const V of [...E.vistas]) if (V.v) desenharVista(V, true);
  }
  // Mesma ordem do VS Code: nome do arquivo > extensão (a mais longa primeiro) > linguagem > ícone padrão.
  function idIconeTema(nome, tipo, aberto) {
    const T = E.tema.ic;
    const n = String(nome || '').toLowerCase();
    if (tipo === 'pasta') {
      return (n && aberto && T.folderNamesExpanded[n]) || (n && T.folderNames[n]) || (aberto && T.folderExpanded) || T.folder;
    }
    if (n && T.fileNames[n]) return T.fileNames[n];
    const segs = n.split('.');
    const exts = segs.slice(1).map((_, i) => segs.slice(i + 1).join('.')).filter(Boolean);
    for (const x of exts) if (T.fileExtensions[x]) return T.fileExtensions[x];
    const lang = (n && T.langNome[n]) || exts.map((x) => T.langExt[x]).find(Boolean);
    if (lang && T.languageIds[lang]) return T.languageIds[lang];
    return T.file;
  }
  function iconeDoTema(nome, tipo, aberto, tam) {
    const T = E.tema.ic;
    if (!T) return null;
    const def = T.defs[idIconeTema(nome, tipo, aberto)];
    if (!def) return null;
    if (def.u) {
      const img = h('img', { class: 'arq-ico-img', src: def.u + '?v=' + encodeURIComponent(T.versao || ''), width: tam, height: tam, alt: '', draggable: 'false', decoding: 'async' });
      // Ícone que não carregou: volta para o SVG próprio do Orbit.
      img.addEventListener('error', () => { const pai = img.parentElement; if (!pai) return; const novo = iconeItemOrbit(nome, tipo, aberto, tam); pai.classList.remove('arq-ico-tema'); pai.replaceChildren(...novo.childNodes); }, { once: true });
      return img;
    }
    if (Number.isInteger(def.f)) {
      const f = (T.fontes || []).find((x) => x.i === def.f);
      const s = h('span', { class: 'arq-ico-glifo', text: def.ch });
      s.style.fontFamily = '"orbit-ico-' + def.f + '"';
      const escala = /^\d+(\.\d+)?%$/.test(String(def.tam || (f && f.tam) || '')) ? parseFloat(def.tam || f.tam) / 100 : 1;
      s.style.fontSize = Math.round(tam * escala) + 'px';
      if (typeof def.cor === 'string' && /^#[0-9a-f]{3,8}$/i.test(def.cor)) s.style.color = def.cor;
      return s;
    }
    return null;
  }
  function iconeItemOrbit(nome, tipo, aberto, tam) {
    const ic = E.tema.ic;
    E.tema.ic = null;
    try { return iconeItem(nome, tipo, aberto, tam); } finally { E.tema.ic = ic; }
  }
  async function pedirRealce(v) {
    const d = v && v.dados;
    if (!d || d.tipo !== 'texto') return null;
    try {
      const r = await fetch('/arquivos/realce?' + qs({ projeto: v.proj, caminho: v.caminho }), { cache: 'no-store' });
      if (!r.ok) return null;
      const j = await r.json();
      const re = j && j.realce;
      // Só vale para o mesmo conteúdo que está na tela.
      if (!re || re.mtime !== d.mtime || re.tamanho !== d.tamanho || !Array.isArray(re.linhas) || !Array.isArray(re.cores)) return null;
      return re;
    } catch { return null; }
  }
  function corValida(c) { return typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : null; }
  function preencherLinha(tx, tokens, cores) {
    for (const t of tokens) {
      if (!Array.isArray(t) || typeof t[0] !== 'string') continue;
      const c = t[1] > 0 ? corValida(cores[t[1]]) : null;
      const e = Number(t[2]) || 0;
      if (!c && !e) { tx.append(t[0]); continue; }
      const s = document.createElement('span');
      s.textContent = t[0];
      if (c) s.style.color = c;
      if (e) s.className = (e & 1 ? 'tk-i ' : '') + (e & 2 ? 'tk-b ' : '') + (e & 4 ? 'tk-u ' : '') + (e & 8 ? 'tk-s' : '');
      tx.append(s);
    }
  }

  // ───────────── lista de projetos ─────────────
  async function carregarLista() {
    let r;
    try { r = await fetch('/projetos', { cache: 'no-store' }); } catch { return; }
    if (r.status === 404) { if (!E.lista) E.semRota = true; return; }
    if (!r.ok) return;
    let j = null;
    try { j = await r.json(); } catch { return; }
    if (j && typeof j.plataforma === 'string') E.plataforma = j.plataforma;
    if (j && Array.isArray(j.projetos)) definirLista(j.projetos);
  }
  function definirLista(arr) {
    if (!Array.isArray(arr)) return;
    const nova = arr.filter((p) => p && typeof p.nome === 'string' && p.nome)
      .map((p) => ({ nome: p.nome, pasta: String(p.pasta || ''), existe: p.existe !== false }))
      .sort((a, b) => col.compare(a.nome, b.nome) || (a.nome < b.nome ? -1 : a.nome > b.nome ? 1 : 0));
    const sig = JSON.stringify(nova);
    const primeira = !E.lista;
    E.semRota = false;
    if (sig === E.listaSig && !primeira) return;
    E.listaSig = sig;
    const antes = E.lista ? E.lista.map((p) => p.nome) : [];
    E.lista = nova;
    const nomes = new Set(nova.map((p) => p.nome));
    const sairam = antes.filter((n) => !nomes.has(n));
    const fora = (k) => !nomes.has(partir(k)[0]);
    for (const k of [...E.cache.keys()]) if (fora(k)) E.cache.delete(k);
    for (const k of [...E.erros.keys()]) if (fora(k)) E.erros.delete(k);
    for (const k of [...E.sel]) if (fora(k)) E.sel.delete(k);
    if (E.clip) {
      E.clip.itens = E.clip.itens.filter((it) => nomes.has(it.projeto));
      E.clip.chaves = new Set(E.clip.itens.map((it) => chave(it.projeto, it.caminho)));
      if (!E.clip.itens.length) E.clip = null;
    }
    if (E.edicao && !nomes.has(E.edicao.proj)) E.edicao = null;
    if (E.ativo && !nomes.has(partir(E.ativo)[0])) E.ativo = null;
    for (const n of sairam) chamar('projetoSaiu', n);
    // Vista de projeto que saiu: a principal fecha como hoje; a da aba esvazia e pede para fechar.
    for (const V of [...E.vistas]) {
      if (!V.v || !V.v.proj || nomes.has(V.v.proj)) continue;
      limparVista(V); desenharVista(V);
      if (V.principal) chamar('vistaFechada');
      else if (typeof V.op.fechar === 'function') { try { V.op.fechar(); } catch (e) { console.warn('Arquivos: fechar', e); } }
    }
    // Vista criada antes da lista (aba restaurada no F5): o caminho absoluto do cabeçalho só existe agora.
    if (primeira) for (const V of [...E.vistas]) if (V.v) desenharVista(V, true);
    if (typeof (E.g && E.g.listaMudou) === 'function') chamar('listaMudou');
    else renderLateral();
  }

  // ───────────── lateral ─────────────
  function renderLateral(d) {
    if (d && typeof d === 'object') {
      E.dados = {
        contagens: d.contagens && typeof d.contagens === 'object' ? d.contagens : {},
        alertas: Array.isArray(d.alertas) ? d.alertas : [],
        ativo: typeof d.ativo === 'string' ? d.ativo : '',
      };
    }
    const caixa = document.getElementById('projetos');
    if (!caixa || !E.lista) return;
    if (E.caixa !== caixa) { E.caixa = caixa; E.linhas.clear(); }
    for (const filho of [...caixa.children]) if (!filho._arq) filho.remove();
    // Só os projetos do GET /projetos: nomes das contagens fora da lista (removidos, pastas temporárias) não aparecem.
    const ordem = E.lista.map((p) => p.nome).sort((a, b) => col.compare(rotulo(a), rotulo(b)) || col.compare(a, b));
    const naOrdem = new Set(ordem);
    const alertas = new Set(E.dados.alertas);
    for (const [nome, ent] of [...E.linhas]) if (!naOrdem.has(nome)) { ent.wrap.remove(); E.linhas.delete(nome); }
    ordem.forEach((nome, i) => {
      const p = proj(nome);
      let ent = E.linhas.get(nome);
      if (!ent || ent.solto !== !p) { if (ent) ent.wrap.remove(); ent = criarLinhaProjeto(nome, !p); E.linhas.set(nome, ent); }
      atualizarLinhaProjeto(ent, p, Number(E.dados.contagens[nome]) || 0, alertas.has(nome), E.dados.ativo === nome);
      const atual = caixa.children[i];
      if (atual !== ent.wrap) caixa.insertBefore(ent.wrap, atual || null);
    });
    if (E.focoProj && E.linhas.has(E.focoProj)) {
      const b = E.linhas.get(E.focoProj).botao;
      E.focoProj = null;
      b.focus({ preventScroll: true });
      b.scrollIntoView({ block: 'nearest' });
    }
  }
  function criarLinhaProjeto(nome, solto) {
    const wrap = h('div', { class: 'arq-proj' + (solto ? ' arq-solto' : ''), 'data-proj': nome });
    wrap._arq = true;
    const seta = solto ? null : h('span', { class: 'arq-seta', 'aria-hidden': 'true' }, ico('seta', 12));
    const av = h('span', { class: 'av' });
    const nomeEl = h('span', { class: 'nome', text: nome });
    const n = h('span', { class: 'n' });
    const al = h('span', { class: 'alerta-p', 'aria-hidden': 'true', hidden: true });
    const botao = h('button', { type: 'button', class: 'proj-item' + (solto ? '' : ' arq-com-seta'), 'data-proj': nome }, seta, av, nomeEl, n, al);
    wrap.append(botao);
    wrap.addEventListener('click', aoClicar);
    wrap.addEventListener('contextmenu', aoMenu);
    wrap.addEventListener('keydown', aoTecla);
    wrap.addEventListener('dblclick', aoDuplo);
    return { nome, solto, wrap, botao, seta, av, nomeEl, n, al, filhos: null, avSig: null };
  }
  function atualizarLinhaProjeto(ent, p, cont, alerta, ativo) {
    const b = ent.botao;
    b.setAttribute('aria-pressed', String(ativo));
    const rot = rotulo(ent.nome);
    if (ent.nomeEl.textContent !== rot) ent.nomeEl.textContent = rot;
    const dica = (ativo ? 'Tirar o filtro de ' + rot : 'Mostrar só ' + rot);
    if (p) {
      const aberto = p.existe && E.abertos.has(chave(ent.nome, ''));
      b.setAttribute('aria-expanded', String(aberto));
      b.classList.toggle('arq-sumiu', !p.existe);
      b.title = p.existe ? dica + '\n' + p.pasta + '\nSeta: arquivos · botão direito: menu' : dica + '\nA pasta não existe mais: ' + p.pasta;
      if (aberto && !ent.filhos) desenharProjeto(ent.nome);
      else if (!aberto && ent.filhos) desenharProjeto(ent.nome);
    } else {
      b.removeAttribute('aria-expanded');
      b.title = dica + '\nSessões numa pasta fora da lista de projetos';
    }
    const nTxt = cont ? String(cont) : '';
    if (ent.n.textContent !== nTxt) ent.n.textContent = nTxt;
    ent.n.hidden = !cont;
    ent.al.hidden = !alerta;
    // Ícone: o gancho pinta numa cópia; troca só se mudou.
    const tmp = h('span', { class: 'av' });
    if (E.g && typeof E.g.pintarIcone === 'function') chamar('pintarIcone', tmp, ent.nome, 13);
    else tmp.textContent = ent.nome.slice(0, 1).toUpperCase();
    const sig = tmp.className + '|' + (tmp.getAttribute('style') || '') + '|' + tmp.innerHTML;
    if (sig !== ent.avSig) { ent.avSig = sig; ent.av.replaceWith(tmp); ent.av = tmp; }
  }

  // Árvore de um projeto (reconstruída por inteiro; com o campo inline no DOM, espera ele sair).
  function desenharProjeto(nome, forcar) {
    const ent = E.linhas.get(nome);
    if (!ent || ent.solto) return;
    const ed = E.edicao;
    if (!forcar && ed && ed.proj === nome && ed.caixa.isConnected) return;
    const p = proj(nome);
    const aberto = !!(p && p.existe && E.abertos.has(chave(nome, '')));
    ent.botao.setAttribute('aria-expanded', String(aberto));
    const ativo = document.activeElement;
    const focoK = ativo && ent.filhos && ent.filhos.contains(ativo) && ativo.dataset ? ativo.dataset.k || null : null;
    if (!aberto) {
      if (ent.filhos) { ent.filhos.remove(); ent.filhos = null; if (focoK) ent.botao.focus({ preventScroll: true }); }
      return;
    }
    const novo = nivel(nome, '', 0);
    novo.classList.add('arq-arvore');
    novo.setAttribute('role', 'tree');
    novo.setAttribute('aria-label', 'Arquivos de ' + nome);
    if (ent.filhos) ent.filhos.replaceWith(novo); else ent.wrap.append(novo);
    ent.filhos = novo;
    juntarSel(novo);
    if (E.edicao && E.edicao.proj === nome && E.edicao.precisaFoco && E.edicao.caixa.isConnected) {
      E.edicao.precisaFoco = false;
      const inp = E.edicao.input;
      inp.focus({ preventScroll: true });
      inp.scrollIntoView({ block: 'nearest' });
      const v = inp.value, ponto = E.edicao.modo === 'renomear' && E.edicao.tipo !== 'pasta' ? v.lastIndexOf('.') : -1;
      inp.setSelectionRange(0, ponto > 0 ? ponto : v.length);
      return;
    }
    const pend = E.focoPendente && partir(E.focoPendente)[0] === nome ? E.focoPendente : null;
    const alvoK = pend || focoK;
    if (alvoK) {
      const el = acharLinha(alvoK);
      if (el) {
        el.focus({ preventScroll: true });
        if (pend) { E.focoPendente = null; el.scrollIntoView({ block: 'nearest' }); }
      } else if (focoK && !pend) ent.botao.focus({ preventScroll: true });
    }
  }
  function agendar(nome) {
    if (E.agendados.has(nome)) return;
    E.agendados.add(nome);
    requestAnimationFrame(() => { E.agendados.delete(nome); desenharProjeto(nome); });
  }
  function nivel(nome, caminho, d) {
    const k = chave(nome, caminho);
    const caixa = h('div', { class: 'arq-filhos', role: 'group' });
    caixa.style.setProperty('--g', d);
    const dados = E.cache.get(k);
    const ed = E.edicao;
    if (!dados) {
      const erro = E.erros.get(k);
      if (erro) caixa.append(linhaAviso(erro, d + 1, 'erro'));
      else { caixa.append(linhaAviso('Carregando…', d + 1, 'carregando')); carregar(nome, caminho); }
      return caixa;
    }
    const itens = dados.itens;
    let novoIdx = -1;
    if (ed && ed.modo === 'novo' && ed.proj === nome && ed.pasta === caminho) {
      novoIdx = ed.tipo === 'pasta' ? 0 : itens.findIndex((it) => it.tipo !== 'pasta');
      if (novoIdx < 0) novoIdx = itens.length;
    }
    itens.forEach((it, i) => {
      if (i === novoIdx) caixa.append(linhaNova(ed, d + 1));
      const c = juntar(caminho, it.nome);
      caixa.append(linhaItem(nome, c, it, d + 1));
      if (it.tipo === 'pasta' && E.abertos.has(chave(nome, c))) caixa.append(nivel(nome, c, d + 1));
    });
    if (novoIdx === itens.length) caixa.append(linhaNova(ed, d + 1));
    if (dados.truncado) caixa.append(linhaAviso('Mais itens não mostrados (limite de 5000)', d + 1));
    return caixa;
  }
  function linhaItem(nome, c, it, d) {
    const k = chave(nome, c);
    const pasta = it.tipo === 'pasta';
    const aberto = pasta && E.abertos.has(k);
    const row = h('div', {
      class: 'arq-no' + (E.clip && E.clip.modo === 'mover' && E.clip.chaves.has(k) ? ' arq-recortado' : '') + (E.ativo === k && !pasta ? ' arq-ativo' : ''),
      role: 'treeitem', tabindex: '-1', 'data-k': k, 'data-tipo': pasta ? 'pasta' : 'arquivo',
      'aria-level': d + 1, 'aria-expanded': pasta ? String(aberto) : null, 'aria-selected': String(E.sel.has(k)), 'aria-current': E.ativo === k && !pasta ? 'true' : null,
      title: absoluto(nome, c),
    });
    row.style.setProperty('--d', d);
    row.append(h('span', { class: 'arq-seta' + (pasta ? '' : ' vazia'), 'aria-hidden': 'true' }, pasta ? ico('seta', 12) : null), iconeItem(it.nome, it.tipo, aberto));
    if (E.edicao && E.edicao.modo === 'renomear' && E.edicao.k === k) { row.classList.add('arq-editando'); row.append(E.edicao.caixa); }
    else row.append(h('span', { class: 'arq-nome', text: it.nome }));
    return row;
  }
  function linhaNova(ed, d) {
    const row = h('div', { class: 'arq-no arq-novo arq-editando', role: 'none' });
    row.style.setProperty('--d', d);
    row.append(h('span', { class: 'arq-seta vazia', 'aria-hidden': 'true' }), iconeItem('', ed.tipo, false), ed.caixa);
    return row;
  }
  function linhaAviso(texto, d, tipo) {
    const row = h('div', { class: 'arq-aviso' + (tipo ? ' ' + tipo : ''), role: tipo === 'erro' ? 'alert' : 'none', title: texto });
    row.style.setProperty('--d', d);
    row.append(h('span', { class: 'arq-nome', text: texto }));
    return row;
  }
  function acharLinha(k) {
    const [nome, c] = partir(k);
    if (!c) { const ent = E.linhas.get(nome); return ent ? ent.botao : null; }
    if (!E.caixa) return null;
    for (const el of E.caixa.querySelectorAll('.arq-no[data-k]')) if (el.dataset.k === k) return el;
    return null;
  }
  function linhasVisiveis() {
    if (!E.caixa) return [];
    return [...E.caixa.querySelectorAll('.proj-item.arq-com-seta, .arq-no[data-k]')].filter((el) => el.getClientRects().length);
  }
  function marcarSel() {
    if (!E.caixa) return;
    for (const el of E.caixa.querySelectorAll('.arq-no[data-k]')) el.setAttribute('aria-selected', String(E.sel.has(el.dataset.k)));
    juntarSel(E.caixa);
  }
  // Selecionadas em sequência formam um bloco: cada linha sabe se a de cima/baixo (na ordem visível) também está.
  function juntarSel(raiz) {
    const linhas = raiz.querySelectorAll('.proj-item, .arq-no, .arq-aviso');
    const sel = (el) => !!el && el.matches('.arq-no[aria-selected="true"]:not(.arq-editando)');
    linhas.forEach((el, i) => {
      if (!el.classList.contains('arq-no')) return;
      const s = sel(el);
      el.classList.toggle('arq-sel-cima', s && sel(linhas[i - 1]));
      el.classList.toggle('arq-sel-baixo', s && sel(linhas[i + 1]));
    });
  }
  function marcarRecortados() {
    if (!E.caixa) return;
    for (const el of E.caixa.querySelectorAll('.arq-no[data-k]')) el.classList.toggle('arq-recortado', !!(E.clip && E.clip.modo === 'mover' && E.clip.chaves.has(el.dataset.k)));
  }
  function visivel(nome, c) {
    if (!E.abertos.has(chave(nome, ''))) return false;
    let p = c;
    while (p) { if (!E.abertos.has(chave(nome, p))) return false; p = paiDe(p); }
    return true;
  }

  function carregar(nome, caminho) {
    const k = chave(nome, caminho);
    if (E.carregando.has(k)) { E.repetir.add(k); return E.carregando.get(k); }
    const pr = pedir('/arquivos/lista?' + qs({ projeto: nome, caminho }))
      .then((j) => {
        const itens = (Array.isArray(j.itens) ? j.itens : []).filter((it) => it && typeof it.nome === 'string' && it.nome)
          .map((it) => ({ nome: it.nome, tipo: it.tipo === 'pasta' ? 'pasta' : 'arquivo', tamanho: it.tamanho, mtime: it.mtime }));
        E.cache.set(k, { itens, truncado: !!j.truncado });
        E.erros.delete(k);
      })
      .catch((e) => {
        if (e.status === 404 && caminho) { E.cache.delete(k); E.abertos.delete(k); salvarAbertos(); E.erros.delete(k); }
        else if (!E.cache.has(k)) E.erros.set(k, e.message || 'Não deu para ler a pasta.');
      })
      .finally(() => {
        E.carregando.delete(k);
        if (E.repetir.delete(k)) carregar(nome, caminho);
        agendar(nome);
      });
    E.carregando.set(k, pr);
    return pr;
  }
  function alternar(nome, caminho, abrir) {
    const p = proj(nome);
    if (!p || !p.existe) return;
    const k = chave(nome, caminho);
    const ab = abrir == null ? !E.abertos.has(k) : !!abrir;
    if (ab === E.abertos.has(k)) return;
    if (ab) E.abertos.add(k); else E.abertos.delete(k);
    salvarAbertos();
    if (!ab) {
      const ativo = document.activeElement;
      if (ativo && ativo.dataset && ativo.dataset.k && ativo.dataset.k !== k) {
        const [n2, c2] = partir(ativo.dataset.k);
        if (n2 === nome && (caminho === '' || c2.startsWith(caminho + '/'))) E.focoPendente = k;
      }
      if (caminho === '' && E.linhas.get(nome) && E.linhas.get(nome).filhos && E.linhas.get(nome).filhos.contains(ativo)) E.focoPendente = k;
    }
    desenharProjeto(nome);
  }
  function abrirCaminho(nome, caminho) {
    E.abertos.add(chave(nome, ''));
    let acc = '';
    for (const parte of caminho ? caminho.split('/') : []) { acc = juntar(acc, parte); E.abertos.add(chave(nome, acc)); }
    salvarAbertos();
  }

  // SSE "arquivos": recarrega só pastas abertas; esquece as fechadas; atualiza a prévia.
  function aoArquivos(d) {
    if (!d || typeof d.projeto !== 'string') return;
    const nome = d.projeto;
    const pastas = Array.isArray(d.pastas) ? d.pastas.filter((x) => typeof x === 'string') : [];
    const arqs = Array.isArray(d.arquivos) ? d.arquivos.filter((x) => typeof x === 'string') : [];
    recarregarPastas(nome, pastas);
    for (const V of [...E.vistas]) {
      const v = V.v;
      if (v && v.modo === 'previa' && v.proj === nome && (arqs.includes(v.caminho) || [...arqs, ...pastas].some((p) => p && v.caminho.startsWith(p + '/')))) {
        if (V.pausado) v.sujo = true; else carregarPrevia(V, true, true);
      }
    }
  }
  // Da raiz para dentro: uma pasta que sumiu da listagem da mãe é esquecida sem pedir a lista dela (nada de 404).
  async function recarregarPastas(nome, pastas) {
    const prof = (c) => (c ? c.split('/').length : 0);
    for (const c of [...new Set(pastas)].sort((a, b) => prof(a) - prof(b))) {
      const k = chave(nome, c);
      if (!E.cache.has(k) && !E.erros.has(k)) continue;
      if (!visivel(nome, c)) { E.cache.delete(k); E.erros.delete(k); continue; }
      if (c) {
        const mae = E.cache.get(chave(nome, paiDe(c)));
        if (mae && !mae.itens.some((it) => it.tipo === 'pasta' && it.nome === baseDe(c))) { esquecer(nome, c); agendar(nome); continue; }
      }
      try { await carregar(nome, c); } catch {}
    }
  }
  function esquecer(nome, c) {
    for (const mapa of [E.cache, E.erros]) for (const k of [...mapa.keys()]) { const [n, x] = partir(k); if (n === nome && (x === c || x.startsWith(c + '/'))) mapa.delete(k); }
    E.abertos.delete(chave(nome, c)); salvarAbertos();
  }
  // O arquivo ainda existe? Confere pelas listagens, da raiz até a pasta-mãe, sem nunca pedir o próprio arquivo.
  async function existe(nome, caminho) {
    const partes = caminho.split('/');
    let acc = '';
    for (let i = 0; i < partes.length; i++) {
      let j;
      try { j = await pedir('/arquivos/lista?' + qs({ projeto: nome, caminho: acc })); } catch { return false; }
      const itens = Array.isArray(j.itens) ? j.itens : [];
      const ultimo = i === partes.length - 1;
      if (!itens.some((it) => it && it.nome === partes[i] && (ultimo ? it.tipo !== 'pasta' : it.tipo === 'pasta'))) return false;
      acc = juntar(acc, partes[i]);
    }
    return true;
  }
  function marcarSumiu(V) {
    const v = V && V.v;
    if (!v || v.modo !== 'previa') return;
    V.seqV++;
    if (v.url) { try { URL.revokeObjectURL(v.url); } catch {} v.url = null; }
    v.dados = null; v.carregando = false; v.sujo = false;
    v.erro = Object.assign(new Error('Este arquivo foi apagado ou movido'), { status: 404, sumiu: true });
    desenharVista(V, true);
  }
  // As vistas com prévia em algum destes caminhos (ou dentro de uma pasta deles).
  function previaEm(itens) {
    return [...E.vistas].filter((V) => {
      const v = V.v;
      return v && v.modo === 'previa' && itens.some(([n, c]) => n === v.proj && (v.caminho === c || v.caminho.startsWith(c + '/')));
    });
  }
  function aoConexao(estado) {
    if (estado !== 'vivo') return;
    carregarLista();
    carregarTema();
    for (const k of [...E.cache.keys(), ...E.erros.keys()]) {
      const [nome, c] = partir(k);
      if (visivel(nome, c)) carregar(nome, c); else { E.cache.delete(k); E.erros.delete(k); }
    }
    for (const V of [...E.vistas]) if (V.v && V.v.modo === 'previa') { if (V.pausado) V.v.sujo = true; else carregarPrevia(V, true, true); }
  }

  // ───────────── cliques e teclado da lateral ─────────────
  function contexto(row) {
    if (!row) return null;
    if (row.classList.contains('proj-item')) {
      const nome = row.dataset.proj;
      return { row, nome, caminho: '', tipo: proj(nome) ? 'projeto' : 'solto', k: chave(nome, '') };
    }
    if (!row.dataset.k) return null;
    const [nome, caminho] = partir(row.dataset.k);
    return { row, nome, caminho, tipo: row.dataset.tipo, k: row.dataset.k };
  }
  function aoClicar(e) {
    e.stopPropagation();
    if (e.target.closest('.arq-edita, .arq-novo')) return;
    const row = e.target.closest('.arq-no[data-k]');
    if (row) { clicarLinha(row, e); return; }
    const b = e.target.closest('.proj-item');
    if (!b) return;
    const nome = b.dataset.proj;
    if (e.target.closest('.arq-seta') && proj(nome)) { alternar(nome, ''); return; }
    if (E.sel.size) { E.sel.clear(); marcarSel(); }
    chamar('filtrarProjeto', nome);
  }
  function clicarLinha(row, e) {
    const cx = contexto(row);
    if (e.ctrlKey || e.metaKey) {
      if (E.sel.has(cx.k)) E.sel.delete(cx.k); else E.sel.add(cx.k);
      E.ancora = cx.k; marcarSel(); row.focus({ preventScroll: true }); return;
    }
    if (e.shiftKey && E.ancora) { selecionarFaixa(E.ancora, cx.k); row.focus({ preventScroll: true }); return; }
    E.sel = new Set([cx.k]); E.ancora = cx.k; marcarSel();
    row.focus({ preventScroll: true });
    if (cx.tipo === 'pasta') alternar(cx.nome, cx.caminho);
    // Com abas, o 2º clique de um duplo clique não reabre a prévia: quem fixa é o dblclick.
    else if (!(temAbas() && e.detail > 1)) abrir(cx.nome, cx.caminho, null, true);
  }
  // Duplo clique num arquivo: com abas, abre fixo (o 1º clique já abriu a prévia). Sem abas, nada a mais (como hoje).
  function aoDuplo(e) {
    e.stopPropagation();
    if (!temAbas() || e.ctrlKey || e.metaKey || e.shiftKey || e.target.closest('.arq-edita, .arq-novo')) return;
    const row = e.target.closest('.arq-no[data-k]');
    const cx = contexto(row);
    if (cx && cx.tipo === 'arquivo') abrir(cx.nome, cx.caminho, null, false);
  }
  function selecionarFaixa(de, ate) {
    const ls = linhasVisiveis().filter((el) => el.dataset.k);
    const i = ls.findIndex((el) => el.dataset.k === de), j = ls.findIndex((el) => el.dataset.k === ate);
    if (i < 0 || j < 0) { E.sel = new Set([ate]); marcarSel(); return; }
    E.sel = new Set(ls.slice(Math.min(i, j), Math.max(i, j) + 1).map((el) => el.dataset.k));
    marcarSel();
  }
  function focarLinha(el, estender) {
    if (!el) return;
    el.focus();
    if (el.dataset.k) {
      if (estender && E.ancora) selecionarFaixa(E.ancora, el.dataset.k);
      else { E.sel = new Set([el.dataset.k]); E.ancora = el.dataset.k; marcarSel(); }
    } else if (!estender && E.sel.size) { E.sel.clear(); marcarSel(); }
    el.scrollIntoView({ block: 'nearest' });
  }
  function aoTecla(e) {
    if (e.isComposing || e.target.closest('.arq-edita')) return;
    const row = e.target.closest('.arq-no[data-k], .proj-item');
    const cx = contexto(row);
    if (!cx || cx.tipo === 'solto') return;
    const ehProj = cx.tipo === 'projeto';
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    const letra = (e.code || '').startsWith('Key') ? e.code.slice(3).toLowerCase() : k.toLowerCase();
    let feito = true;
    if ((k === 'ArrowDown' || k === 'ArrowUp') && !ctrl && !e.altKey) {
      const ls = linhasVisiveis(); const i = ls.indexOf(row);
      focarLinha(ls[i + (k === 'ArrowDown' ? 1 : -1)], e.shiftKey);
    } else if ((k === 'Home' || k === 'End') && !ctrl) {
      const ls = linhasVisiveis(); focarLinha(k === 'Home' ? ls[0] : ls[ls.length - 1], e.shiftKey);
    } else if (k === 'ArrowRight' && !ctrl && !e.altKey) {
      if (ehProj || cx.tipo === 'pasta') {
        if (!E.abertos.has(cx.k)) alternar(cx.nome, cx.caminho, true);
        else { const ls = linhasVisiveis(); const prox = ls[ls.indexOf(row) + 1]; if (prox && prox.dataset.k && paiDe(partir(prox.dataset.k)[1]) === cx.caminho && partir(prox.dataset.k)[0] === cx.nome) focarLinha(prox); }
      }
    } else if (k === 'ArrowLeft' && !ctrl && !e.altKey) {
      if ((ehProj || cx.tipo === 'pasta') && E.abertos.has(cx.k)) alternar(cx.nome, cx.caminho, false);
      else if (!ehProj) focarLinha(acharLinha(chave(cx.nome, paiDe(cx.caminho))));
    } else if (k === 'Enter' && !ehProj && !ctrl) {
      if (cx.tipo === 'pasta') alternar(cx.nome, cx.caminho); else abrir(cx.nome, cx.caminho, null, true);
    } else if (k === 'F2') {
      if (!ehProj) iniciarRenomear(cx.k);
    } else if (k === 'Delete' && !ctrl && !e.altKey) {
      if (!ehProj) excluir(selecaoDe(cx));
    } else if (noMac() && k === 'Backspace' && e.metaKey && !e.altKey) {
      // Mac: o teclado não tem Delete; Cmd+Backspace manda para a Lixeira, como no Finder e no VS Code.
      if (!ehProj) excluir(selecaoDe(cx));
    } else if (ctrl && !e.altKey && !e.shiftKey && (letra === 'c' || letra === 'x')) {
      if (ehProj) feito = false; else definirClip(letra === 'x' ? 'mover' : 'copiar', selecaoDe(cx));
    } else if (ctrl && !e.altKey && !e.shiftKey && letra === 'v') {
      colar(cx.nome, cx.tipo === 'arquivo' ? paiDe(cx.caminho) : cx.caminho);
    } else if (e.shiftKey && e.altKey && !ctrl && letra === 'c') {
      copiarCaminhos(cx, false);
    } else if (k === 'Escape' && E.clip && E.clip.modo === 'mover') {
      E.clip = null; marcarRecortados();
    } else if (k === 'ContextMenu' || (e.shiftKey && k === 'F10')) {
      const r = row.getBoundingClientRect();
      abrirMenuDe(cx, r.left + 24, r.bottom - 2);
    } else feito = false;
    if (feito) { e.preventDefault(); e.stopPropagation(); }
  }
  function aoMenu(e) {
    const row = e.target.closest('.arq-no[data-k], .proj-item');
    const cx = contexto(row);
    if (!cx || e.target.closest('.arq-edita, .arq-novo')) { if (cx) e.stopPropagation(); return; }
    e.preventDefault(); e.stopPropagation();
    if (cx.tipo === 'solto') return;
    abrirMenuDe(cx, e.clientX, e.clientY);
  }
  function selecaoDe(cx) {
    if (!cx.caminho) return [];
    if (!E.sel.has(cx.k)) { E.sel = new Set([cx.k]); E.ancora = cx.k; marcarSel(); }
    return [...E.sel].filter((k) => partir(k)[1]);
  }

  // ───────────── menu de botão direito ─────────────
  function abrirMenuDe(cx, x, y) {
    if (cx.tipo !== 'projeto' && !E.sel.has(cx.k)) { E.sel = new Set([cx.k]); E.ancora = cx.k; marcarSel(); }
    const { nome, caminho } = cx;
    const p = proj(nome);
    const existe = !!(p && p.existe);
    const semClip = !E.clip;
    const copiarC = { rot: 'Copiar caminho', acao: () => copiarCaminhos(cx, false) };
    const copiarR = { rot: 'Copiar caminho relativo', acao: () => copiarCaminhos(cx, true) };
    let itens;
    if (cx.tipo === 'projeto') {
      itens = [
        { rot: 'Editar projeto', acao: () => { const ent = E.linhas.get(nome); chamar('editarProjeto', nome, ent ? ent.botao : null); } },
        // Navegador interno (16/10): "Abrir prévia" e o endereço dela vêm da página (ganchos.itensProjeto).
        ...(() => { const ent = E.linhas.get(nome); const x = chamar('itensProjeto', nome, ent ? ent.botao : null); return Array.isArray(x) ? x.filter((i) => i && typeof i.acao === 'function') : []; })(), '-',
        { rot: 'Novo arquivo', des: !existe, acao: () => iniciarNovo(nome, '', 'arquivo') },
        { rot: 'Nova pasta', des: !existe, acao: () => iniciarNovo(nome, '', 'pasta') }, '-',
        { rot: 'Localizar na pasta', des: !existe, acao: () => localizar(nome, '') }, '-',
        { rot: 'Colar', des: semClip || !existe, acao: () => colar(nome, '') }, '-',
        copiarC, copiarR, '-',
        { rot: 'Abrir na pasta', des: !existe, acao: () => abrirNaPasta(nome, '') },
        { rot: rotRevelar(), des: !existe, acao: () => revelar(nome, '') },
        { rot: 'Remover projeto da lista', acao: () => removerProjeto(nome) },
      ];
    } else if (cx.tipo === 'pasta') {
      itens = [
        { rot: 'Novo arquivo', acao: () => iniciarNovo(nome, caminho, 'arquivo') },
        { rot: 'Nova pasta', acao: () => iniciarNovo(nome, caminho, 'pasta') }, '-',
        { rot: 'Localizar na pasta', acao: () => localizar(nome, caminho) }, '-',
        { rot: 'Recortar', acao: () => definirClip('mover', selecaoDe(cx)) },
        { rot: 'Copiar', acao: () => definirClip('copiar', selecaoDe(cx)) },
        { rot: 'Colar', des: semClip, acao: () => colar(nome, caminho) }, '-',
        copiarC, copiarR, '-',
        { rot: 'Abrir na pasta', acao: () => abrirNaPasta(nome, caminho) },
        { rot: 'Renomear', acao: () => iniciarRenomear(cx.k) },
        { rot: 'Excluir', acao: () => excluir(selecaoDe(cx)) },
      ];
    } else {
      itens = [
        { rot: 'Abrir', acao: () => abrir(nome, caminho, null, false) }, '-',
        { rot: 'Recortar', acao: () => definirClip('mover', selecaoDe(cx)) },
        { rot: 'Copiar', acao: () => definirClip('copiar', selecaoDe(cx)) }, '-',
        copiarC, copiarR, '-',
        { rot: rotRevelar(), acao: () => revelar(nome, caminho) },
        { rot: 'Renomear', acao: () => iniciarRenomear(cx.k) },
        { rot: 'Excluir', acao: () => excluir(selecaoDe(cx)) },
      ];
    }
    abrirMenu(itens, x, y, cx.row, cx.tipo === 'projeto' ? 'Projeto ' + nome : baseDe(caminho));
  }
  function abrirMenu(itens, x, y, origem, rotulo) {
    fecharMenu(false);
    const el = h('div', { class: 'arq-menu', role: 'menu', 'aria-label': rotulo || 'Ações', 'data-arq-menu': '' });
    for (const it of itens) {
      if (it === '-') { el.append(h('div', { class: 'arq-menu-sep', role: 'separator' })); continue; }
      const b = h('button', { type: 'button', class: 'arq-mi', role: 'menuitem', tabindex: '-1', 'aria-disabled': it.des ? 'true' : null },
        h('span', { class: 'arq-mi-rot', text: it.rot }));
      b.addEventListener('click', (e) => { e.stopPropagation(); if (it.des) return; fecharMenu(true); it.acao(); });
      b.addEventListener('pointermove', () => { if (!it.des && document.activeElement !== b) b.focus({ preventScroll: true }); });
      el.append(b);
    }
    el.addEventListener('keydown', teclaMenu);
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
    document.body.append(el);
    const w = el.offsetWidth, a = el.offsetHeight, m = 8;
    let L = x, T = y;
    if (L + w > innerWidth - m) L = Math.max(m, innerWidth - w - m);
    if (T + a > innerHeight - m) T = Math.max(m, Math.min(y - a, innerHeight - a - m));
    el.style.left = Math.round(L) + 'px';
    el.style.top = Math.round(T) + 'px';
    E.menu = { el, origem };
    const primeiro = el.querySelector('.arq-mi:not([aria-disabled])');
    if (primeiro) primeiro.focus({ preventScroll: true }); else el.focus();
  }
  function fecharMenu(devolver) {
    if (!E.menu) return;
    const { el, origem } = E.menu;
    E.menu = null;
    el.remove();
    if (devolver && origem && origem.isConnected) origem.focus({ preventScroll: true });
  }
  function teclaMenu(e) {
    e.stopPropagation();
    const itens = [...E.menu.el.querySelectorAll('.arq-mi:not([aria-disabled])')];
    const i = itens.indexOf(document.activeElement);
    let alvo = null;
    if (e.key === 'ArrowDown') alvo = itens[(i + 1) % itens.length];
    else if (e.key === 'ArrowUp') alvo = itens[(i - 1 + itens.length) % itens.length];
    else if (e.key === 'Home') alvo = itens[0];
    else if (e.key === 'End') alvo = itens[itens.length - 1];
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); fecharMenu(true); return; }
    else if (e.key === 'Enter' || e.key === ' ') return;
    else { if (e.key.length === 1 || /^F\d+$|Delete|Backspace/.test(e.key)) e.preventDefault(); return; }
    e.preventDefault();
    if (alvo) alvo.focus({ preventScroll: true });
  }
  document.addEventListener('pointerdown', (e) => { if (E.menu && !E.menu.el.contains(e.target)) fecharMenu(false); }, true);
  addEventListener('resize', () => fecharMenu(false));
  addEventListener('blur', () => fecharMenu(false));
  document.addEventListener('scroll', (e) => { if (E.menu && !E.menu.el.contains(e.target)) fecharMenu(false); }, true);

  // ───────────── área de transferência, caminhos, revelar ─────────────
  function definirClip(modo, chaves) {
    if (!chaves.length) return;
    const itens = chaves.map((k) => { const [projeto, caminho] = partir(k); return { projeto, caminho, tipo: tipoDe(projeto, caminho) }; });
    E.clip = { modo, itens, chaves: new Set(chaves) };
    marcarRecortados();
    const n = itens.length === 1 ? '"' + baseDe(itens[0].caminho) + '"' : itens.length + ' itens';
    toast((modo === 'mover' ? 'Recortado: ' : 'Copiado: ') + n + '. Cole numa pasta.');
  }
  async function colar(nome, destino) {
    if (!E.clip) return;
    const { modo, itens } = E.clip;
    try {
      const j = await pedir('/arquivos/colar', { projeto: nome, destino, modo, itens: itens.map((it) => ({ projeto: it.projeto, caminho: it.caminho })) });
      const caminhos = Array.isArray(j.caminhos) ? j.caminhos.filter((c) => typeof c === 'string') : [];
      if (modo === 'mover') {
        E.clip = null;
        // Movido dentro do mesmo projeto: as vistas acompanham e a página fica sabendo (renomeado). Para outro projeto:
        // a prévia fica no estado "apagado ou movido".
        const alinhado = caminhos.length === itens.length;
        const fora = [];
        itens.forEach((it, i) => {
          const para = alinhado ? caminhos[i] : null;
          if (para && it.projeto === nome) {
            if (para !== it.caminho) { seguirVistas(nome, it.caminho, para); chamar('renomeado', { proj: nome, de: it.caminho, para, tipo: it.tipo || 'arquivo' }); }
          } else fora.push([it.projeto, it.caminho]);
        });
        for (const V of previaEm(fora)) marcarSumiu(V);
        for (const it of itens) carregar(it.projeto, paiDe(it.caminho));
      }
      abrirCaminho(nome, destino);
      if (caminhos.length) { E.sel = new Set(caminhos.map((c) => chave(nome, c))); E.ancora = chave(nome, caminhos[0]); E.focoPendente = E.ancora; }
      await carregar(nome, destino);
      marcarRecortados();
    } catch (e) { toast(e.message, true); }
  }
  function copiarCaminhos(cx, rel) {
    const ks = cx.caminho && E.sel.has(cx.k) ? [...E.sel] : [cx.k];
    const txt = ks.map((k) => { const [n, c] = partir(k); return rel ? relativo(c) : absoluto(n, c); }).join(noMac() ? '\n' : '\r\n');
    copiarTexto(txt, ks.length > 1 ? ks.length + ' caminhos copiados' : (rel ? 'Caminho relativo copiado' : 'Caminho copiado'));
  }
  async function copiarTexto(t, aviso) {
    let ok = false;
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(t); ok = true; } } catch {}
    if (!ok) {
      const antes = document.activeElement;
      const ta = h('textarea', { 'aria-hidden': 'true', readonly: true, class: 'arq-oculto' });
      ta.value = t;
      document.body.append(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
      if (antes && antes.isConnected && typeof antes.focus === 'function') antes.focus({ preventScroll: true });
    }
    toast(ok ? aviso : 'Não deu para copiar.', !ok);
  }
  async function revelar(nome, caminho) {
    try { await pedir('/arquivos/revelar', { projeto: nome, caminho }); toast('Abrindo no ' + nomeExplorador()); }
    catch (e) { toast(e.message, true); }
  }
  async function abrirNaPasta(nome, caminho) {
    try { await pedir('/arquivos/abrir-pasta', { projeto: nome, caminho }); toast('Abrindo no ' + nomeExplorador()); }
    catch (e) { toast(e.message, true); }
  }

  // ───────────── novo / renomear (campo inline) ─────────────
  function criarCaixaEdicao(valor, rotulo) {
    const input = h('input', { class: 'arq-input', type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': rotulo });
    input.value = valor;
    const erro = h('div', { class: 'arq-erro-campo', role: 'alert', hidden: true });
    const caixa = h('span', { class: 'arq-edita' }, input, erro);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); confirmarEdicao(false); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelarEdicao(); }
    });
    input.addEventListener('input', () => { erro.hidden = true; input.removeAttribute('aria-invalid'); });
    input.addEventListener('blur', () => {
      const ed = E.edicao;
      if (!ed || ed.input !== input || ed.ocupado) return;
      setTimeout(() => {
        if (E.edicao !== ed || ed.ocupado || document.activeElement === input) return;
        if (!document.hasFocus()) return;
        if (!erro.hidden) cancelarEdicao(); else confirmarEdicao(true);
      }, 0);
    });
    ['click', 'dblclick', 'pointerdown', 'contextmenu'].forEach((t) => caixa.addEventListener(t, (e) => e.stopPropagation()));
    return { caixa, input, erro };
  }
  function iniciarRenomear(k) {
    const [nome, c] = partir(k);
    if (!c) return;
    if (E.edicao) cancelarEdicao();
    const row = acharLinha(k);
    const tipo = row ? row.dataset.tipo : 'arquivo';
    const antigo = baseDe(c);
    E.edicao = { modo: 'renomear', proj: nome, k, caminho: c, antigo, tipo, precisaFoco: true, ...criarCaixaEdicao(antigo, 'Novo nome de ' + antigo) };
    desenharProjeto(nome, true);
  }
  function iniciarNovo(nome, pasta, tipo) {
    if (E.edicao) cancelarEdicao();
    abrirCaminho(nome, pasta);
    E.edicao = { modo: 'novo', proj: nome, pasta, tipo, precisaFoco: true, ...criarCaixaEdicao('', tipo === 'pasta' ? 'Nome da nova pasta' : 'Nome do novo arquivo') };
    desenharProjeto(nome, true);
  }
  function cancelarEdicao() {
    const ed = E.edicao;
    if (!ed) return;
    E.edicao = null;
    E.focoPendente = ed.modo === 'renomear' ? ed.k : chave(ed.proj, ed.pasta);
    desenharProjeto(ed.proj, true);
  }
  async function confirmarEdicao(viaBlur) {
    const ed = E.edicao;
    if (!ed || ed.ocupado) return;
    const nomeV = ed.input.value.trim();
    if (!nomeV || (ed.modo === 'renomear' && nomeV === ed.antigo)) { cancelarEdicao(); return; }
    ed.ocupado = true;
    ed.input.setAttribute('aria-busy', 'true');
    try {
      if (ed.modo === 'novo') {
        const j = await pedir('/arquivos/novo', { projeto: ed.proj, pasta: ed.pasta, nome: nomeV, tipo: ed.tipo });
        if (E.edicao !== ed) return;
        const nc = typeof j.caminho === 'string' ? j.caminho : juntar(ed.pasta, nomeV);
        E.edicao = null;
        const k = chave(ed.proj, nc);
        E.sel = new Set([k]); E.ancora = k; E.focoPendente = k;
        desenharProjeto(ed.proj, true);
        await carregar(ed.proj, ed.pasta);
        if (ed.tipo === 'arquivo') abrir(ed.proj, nc, null, false);
      } else {
        const j = await pedir('/arquivos/renomear', { projeto: ed.proj, caminho: ed.caminho, nome: nomeV });
        if (E.edicao !== ed) return;
        const nc = typeof j.caminho === 'string' ? j.caminho : juntar(paiDe(ed.caminho), nomeV);
        E.edicao = null;
        trocarPrefixo(ed.proj, ed.caminho, nc);
        if (nc !== ed.caminho) chamar('renomeado', { proj: ed.proj, de: ed.caminho, para: nc, tipo: ed.tipo === 'pasta' ? 'pasta' : 'arquivo' });
        const k = chave(ed.proj, nc);
        E.sel = new Set([k]); E.ancora = k; E.focoPendente = k;
        const pasta = paiDe(ed.caminho);
        const dados = E.cache.get(chave(ed.proj, pasta));
        if (dados) { const it = dados.itens.find((x) => x.nome === ed.antigo); if (it) it.nome = baseDe(nc); }
        desenharProjeto(ed.proj, true);
        carregar(ed.proj, pasta);
      }
    } catch (e) {
      ed.ocupado = false;
      ed.input.removeAttribute('aria-busy');
      if (E.edicao !== ed) return;
      if (viaBlur) { cancelarEdicao(); toast(e.message, true); return; }
      ed.erro.textContent = e.message;
      ed.erro.hidden = false;
      ed.input.setAttribute('aria-invalid', 'true');
      ed.input.focus({ preventScroll: true });
    }
  }
  function trocarPrefixo(nome, de, para) {
    const map = (k) => {
      const [n, c] = partir(k);
      if (n !== nome) return k;
      if (c === de) return chave(n, para);
      if (c.startsWith(de + '/')) return chave(n, para + c.slice(de.length));
      return k;
    };
    E.abertos = new Set([...E.abertos].map(map)); salvarAbertos();
    E.sel = new Set([...E.sel].map(map));
    for (const k of [...E.cache.keys()]) if (map(k) !== k) E.cache.delete(k);
    if (E.clip) { E.clip.itens = E.clip.itens.map((it) => { const [n, c] = partir(map(chave(it.projeto, it.caminho))); return { projeto: n, caminho: c, tipo: it.tipo }; }); E.clip.chaves = new Set(E.clip.itens.map((it) => chave(it.projeto, it.caminho))); }
    if (E.ativo) E.ativo = map(E.ativo);
    seguirVistas(nome, de, para);
  }
  // Prévias em `de` (ou dentro dela, se for pasta) passam a mostrar `para`; buscas com escopo dentro dela também.
  function seguirVistas(nome, de, para) {
    const troca = (c) => (c === de ? para : c && c.startsWith(de + '/') ? para + c.slice(de.length) : c);
    for (const V of [...E.vistas]) {
      const v = V.v;
      if (!v || v.proj !== nome) continue;
      if (v.modo === 'previa') { const nv = troca(v.caminho); if (nv !== v.caminho) { v.caminho = nv; desenharVista(V, true); } }
      else if (v.modo === 'busca') { const ne = troca(v.escopo); if (ne !== v.escopo) { v.escopo = ne; desenharVista(V, true); } }
    }
  }
  function tipoDe(nome, c) {
    const d = E.cache.get(chave(nome, paiDe(c)));
    const it = d && d.itens.find((x) => x.nome === baseDe(c));
    if (it) return it.tipo;
    const row = acharLinha(chave(nome, c));
    return row && row.dataset.tipo === 'pasta' ? 'pasta' : 'arquivo';
  }

  // ───────────── excluir, remover, adicionar ─────────────
  function excluir(chaves) {
    const itens = chaves.map(partir).filter(([, c]) => c);
    if (!itens.length) return;
    const um = itens.length === 1;
    const rotulo = um ? baseDe(itens[0][1]) : itens.length + ' itens';
    const lista = um ? null : h('ul', { class: 'arq-itens' }, ...itens.slice(0, 6).map(([, c]) => h('li', { title: c, text: c })), itens.length > 6 ? h('li', { class: 'mais', text: 'e mais ' + (itens.length - 6) }) : null);
    confirmar({
      titulo: 'Mover para a Lixeira?', sub: rotulo, icone: 'lixeira', perigo: true,
      msg: um ? '"' + rotulo + '" vai para a Lixeira do Windows.' : rotulo + ' vão para a Lixeira do Windows.',
      extra: lista, nota: 'Dá para restaurar pela Lixeira. Nada é apagado de vez.',
      botao: 'Mover para a Lixeira', ocupado: 'Movendo…',
      acao: async () => {
        const porProj = new Map();
        for (const [n, c] of itens) { if (!porProj.has(n)) porProj.set(n, []); porProj.get(n).push(c); }
        for (const [n, cs] of porProj) {
          await pedir('/arquivos/excluir', { projeto: n, caminhos: cs });
          for (const c of cs) {
            const k = chave(n, c);
            E.sel.delete(k);
            if (E.clip && E.clip.chaves.has(k)) { E.clip.chaves.delete(k); E.clip.itens = E.clip.itens.filter((it) => !(it.projeto === n && it.caminho === c)); if (!E.clip.itens.length) E.clip = null; }
            E.abertos.delete(k);
          }
          salvarAbertos();
          const pais = new Set(cs.map(paiDe));
          E.focoPendente = chave(n, [...pais][0]);
          for (const c of cs) esquecer(n, c);
          for (const p of pais) carregar(n, p);
          for (const V of previaEm(cs.map((c) => [n, c]))) marcarSumiu(V);
        }
      },
    });
  }
  function removerProjeto(nome) {
    const p = proj(nome);
    confirmar({
      titulo: 'Remover da lista?', sub: nome, icone: 'info',
      msg: '"' + nome + '" sai só da barra lateral do Orbit. Nenhum arquivo é apagado: a pasta continua como está.',
      nota: p ? p.pasta : null, notaMono: true,
      botao: 'Remover da lista', ocupado: 'Removendo…',
      acao: async () => {
        const j = await pedir('/projetos/remover', { nome });
        if (Array.isArray(j.projetos)) definirLista(j.projetos);
        toast('"' + nome + '" saiu da lista. Os arquivos continuam na pasta.');
      },
    });
  }

  // ───────────── diálogos ─────────────
  function focaveis(raiz) {
    return [...raiz.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.getClientRects().length);
  }
  function dialogo(cfg) {
    const anterior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    fecharMenu(false);
    const id = 'arq-dlg-' + Math.random().toString(36).slice(2, 8);
    const corpo = h('div', { class: 'arq-modal-corpo' });
    const pe = h('div', { class: 'arq-modal-pe' });
    const raiz = h('div', { class: 'arq-modal' + (cfg.largo ? ' largo' : ''), role: cfg.alerta ? 'alertdialog' : 'dialog', 'aria-modal': 'true', 'aria-labelledby': id, tabindex: '-1' },
      h('div', { class: 'arq-modal-cab' },
        h('span', { class: 'arq-quad' + (cfg.perigo ? ' perigo' : '') }, ico(cfg.icone || 'info', 16)),
        h('div', { class: 'arq-modal-tit' }, h('h2', { id, text: cfg.titulo, title: cfg.titulo }), cfg.sub ? h('p', { text: cfg.sub, title: cfg.sub }) : null)),
      corpo, pe);
    const camada = h('div', { class: 'arq-camada', 'data-arq-dialogo': '' }, raiz);
    const dlg = { raiz, corpo, pe, camada, fechado: false };
    dlg.fechar = () => {
      if (dlg.fechado) return;
      dlg.fechado = true;
      camada.remove();
      const i = E.pilha.indexOf(dlg);
      if (i >= 0) E.pilha.splice(i, 1);
      if (anterior && anterior.isConnected) anterior.focus({ preventScroll: true });
    };
    dlg.cancelar = () => (cfg.aoCancelar ? cfg.aoCancelar() : dlg.fechar());
    camada.addEventListener('mousedown', (e) => { if (e.target === camada) dlg.cancelar(); });
    camada.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); dlg.cancelar(); }
      else if (e.key === 'Tab') {
        const f = focaveis(raiz);
        if (!f.length) { e.preventDefault(); return; }
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    });
    camada.addEventListener('contextmenu', (e) => e.stopPropagation());
    E.pilha.push(dlg);
    document.body.append(camada);
    return dlg;
  }
  function botao(rot, classe, onclick) { return h('button', { type: 'button', class: 'arq-btn' + (classe ? ' ' + classe : ''), onclick }, rot); }
  function confirmar(cfg) {
    return new Promise((resolve) => {
      let feito = false;
      const dlg = dialogo({ titulo: cfg.titulo, sub: cfg.sub, icone: cfg.icone, perigo: cfg.perigo, alerta: true, aoCancelar: () => fim(false) });
      function fim(v) { if (feito) return; feito = true; dlg.fechar(); resolve(v); }
      if (cfg.msg) dlg.corpo.append(h('p', { class: 'arq-modal-msg', text: cfg.msg }));
      if (cfg.extra) dlg.corpo.append(cfg.extra);
      if (cfg.nota) dlg.corpo.append(h('p', { class: 'arq-modal-nota' + (cfg.notaMono ? ' mono' : ''), text: cfg.nota, title: cfg.nota }));
      const erro = h('p', { class: 'arq-erro', role: 'alert', hidden: true });
      dlg.corpo.append(erro);
      const nao = botao('Cancelar', 'arq-b-cancelar', () => fim(false));
      const sim = botao(cfg.botao || 'Confirmar', (cfg.perigo ? 'perigo' : 'solido') + ' arq-b-confirmar', async () => {
        if (!cfg.acao) { fim(true); return; }
        if (sim.getAttribute('aria-busy') === 'true') return;
        sim.setAttribute('aria-busy', 'true'); nao.disabled = true;
        const rot = sim.textContent; sim.textContent = cfg.ocupado || rot;
        erro.hidden = true;
        try { await cfg.acao(); fim(true); }
        catch (e) {
          sim.removeAttribute('aria-busy'); nao.disabled = false; sim.textContent = rot;
          erro.textContent = e.message; erro.hidden = false; sim.focus({ preventScroll: true });
        }
      });
      dlg.pe.append(nao, sim);
      nao.focus({ preventScroll: true });
    });
  }

  // Seletor de pasta (botão + do rótulo "Projetos").
  function seletorPasta() {
    const dlg = dialogo({ titulo: 'Adicionar projeto', sub: 'Escolha a pasta do projeto. Nada é criado nela.', icone: 'projeto', largo: true });
    const campo = h('input', { class: 'arq-campo mono', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: 'Cole ou digite o caminho, ex.: ' + (noMac() ? '/Users/voce/Projetos/meu-app' : 'D:\\Projetos\\meu-app'), 'aria-label': 'Caminho da pasta' });
    const ir = h('button', { type: 'button', class: 'arq-btn', title: 'Ir para o caminho' }, 'Ir');
    const acima = h('button', { type: 'button', class: 'arq-btn-ico', title: 'Pasta acima', 'aria-label': 'Pasta acima' }, ico('acima', 15));
    const atalhos = h('div', { class: 'arq-sp-atalhos', role: 'group', 'aria-label': 'Atalhos e unidades' });
    const lista = h('div', { class: 'arq-sp-lista', role: 'listbox', 'aria-label': 'Pastas', tabindex: '0' });
    const erro = h('p', { class: 'arq-erro', role: 'alert', hidden: true });
    dlg.corpo.append(h('div', { class: 'arq-sp-linha' }, acima, campo, ir), atalhos, lista, erro);
    const nao = botao('Cancelar', '', () => dlg.fechar());
    const sim = botao('Adicionar', 'solido arq-b-confirmar', adicionar);
    // Mac: a janela "Escolher pasta" do próprio sistema (POST /arquivos/escolher-pasta). No Windows não aparece.
    if (noMac()) {
      const finder = botao('Escolher no Finder', 'arq-b-finder', async () => {
        if (finder.getAttribute('aria-busy') === 'true') return;
        finder.setAttribute('aria-busy', 'true');
        mostrarErro('');
        try {
          const j = await pedir('/arquivos/escolher-pasta', {});
          if (!dlg.fechado && !j.cancelado && typeof j.caminho === 'string' && j.caminho) await navegar(j.caminho);
        } catch (e) { if (!dlg.fechado) mostrarErro(e.message); }
        finally { finder.removeAttribute('aria-busy'); }
      });
      finder.style.marginRight = 'auto';
      dlg.pe.append(finder);
    }
    dlg.pe.append(nao, sim);
    const st = { atual: null, pai: null, itens: [], sel: -1, inicio: { unidades: [], atalhos: [] }, seq: 0 };
    const norm = (arr) => (Array.isArray(arr) ? arr : []).map((x) => (typeof x === 'string' ? { nome: x, caminho: x } : x && typeof x.caminho === 'string' ? { nome: String(x.nome || x.caminho), caminho: x.caminho } : null)).filter(Boolean);
    function mostrarErro(msg) { erro.textContent = msg || ''; erro.hidden = !msg; }
    function desenharAtalhos() {
      const todos = [...st.inicio.atalhos.map((a) => ({ ...a, ico: 'casa' })), ...st.inicio.unidades.map((u) => ({ ...u, ico: 'unidade' }))];
      atalhos.replaceChildren(...todos.map((a) => h('button', { type: 'button', class: 'arq-chip', title: a.caminho, onclick: () => navegar(a.caminho) }, ico(a.ico, 13), h('span', { text: a.nome }))));
      atalhos.hidden = st.atual == null || !todos.length;
    }
    function desenharLista() {
      const linhas = st.itens.map((it, i) => {
        const el = h('div', { class: 'arq-sp-item', role: 'option', tabindex: '-1', 'aria-selected': String(i === st.sel), title: it.caminho, 'data-i': i },
          it.grupo ? null : (it.ico ? h('span', { class: 'arq-ico' }, ico(it.ico, 15)) : iconeItem(it.nome, 'pasta', false, 15)), h('span', { class: 'arq-nome', text: it.nome }));
        if (it.grupo) { el.className = 'arq-sp-grupo'; el.removeAttribute('role'); el.removeAttribute('tabindex'); el.removeAttribute('aria-selected'); }
        return el;
      });
      if (!st.itens.length) linhas.push(h('div', { class: 'arq-sp-vazio', text: st.atual == null ? 'Nada para mostrar.' : 'Nenhuma subpasta aqui. Dá para adicionar esta mesma.' }));
      lista.replaceChildren(...linhas);
      acima.disabled = st.atual == null;
      lista.scrollTop = 0;
    }
    function selecionar(i, focar) {
      if (i < 0 || i >= st.itens.length || st.itens[i].grupo) return;
      st.sel = i;
      for (const el of lista.querySelectorAll('.arq-sp-item')) el.setAttribute('aria-selected', String(Number(el.dataset.i) === i));
      const el = lista.querySelector('.arq-sp-item[data-i="' + i + '"]');
      if (el) { el.scrollIntoView({ block: 'nearest' }); if (focar) el.focus({ preventScroll: true }); }
      campo.value = st.itens[i].caminho;
      mostrarErro('');
    }
    async function inicio() {
      const seq = ++st.seq;
      try {
        const j = await pedir('/arquivos/pastas');
        if (seq !== st.seq || dlg.fechado) return;
        st.inicio = { unidades: norm(j.unidades || j.drives), atalhos: norm(j.atalhos) };
      } catch (e) { if (seq === st.seq) mostrarErro(e.message); }
      st.atual = null; st.pai = null; st.sel = -1;
      const at = st.inicio.atalhos.map((a) => ({ ...a, ico: 'casa' })), un = st.inicio.unidades.map((u) => ({ ...u, ico: 'unidade' }));
      st.itens = [...(at.length ? [{ nome: 'Atalhos', grupo: true }] : []), ...at, ...(un.length ? [{ nome: 'Unidades', grupo: true }] : []), ...un];
      campo.value = '';
      desenharAtalhos(); desenharLista();
    }
    async function navegar(caminho) {
      caminho = String(caminho || '').trim().replace(/^"(.*)"$/, '$1');
      if (!caminho) { inicio(); return; }
      const seq = ++st.seq;
      try {
        const j = await pedir('/arquivos/pastas?' + qs({ caminho }));
        if (seq !== st.seq || dlg.fechado) return;
        st.atual = typeof j.caminho === 'string' ? j.caminho : caminho;
        st.pai = typeof j.pai === 'string' && j.pai ? j.pai : null;
        st.itens = norm(j.pastas);
        st.sel = -1;
        campo.value = st.atual;
        mostrarErro('');
        desenharAtalhos(); desenharLista();
      } catch (e) {
        if (seq !== st.seq) return;
        mostrarErro(e.status === 404 ? (e.message && !/^Erro/.test(e.message) ? e.message : 'Essa pasta não existe.') : e.message);
      }
    }
    function subir() { if (st.atual == null) return; if (st.pai) navegar(st.pai); else inicio(); }
    async function adicionar() {
      const pasta = campo.value.trim().replace(/^"(.*)"$/, '$1') || st.atual || '';
      if (!pasta) { mostrarErro('Escolha uma pasta ou cole o caminho dela.'); campo.focus(); return; }
      if (sim.getAttribute('aria-busy') === 'true') return;
      sim.setAttribute('aria-busy', 'true'); sim.textContent = 'Adicionando…';
      try {
        const j = await pedir('/projetos/adicionar', { pasta });
        const nome = j.projeto && typeof j.projeto === 'object' ? j.projeto.nome : typeof j.projeto === 'string' ? j.projeto : null;
        dlg.fechar();
        if (nome) E.focoProj = nome;
        if (Array.isArray(j.projetos)) definirLista(j.projetos);
        toast(j._status === 200 ? (nome ? '"' + nome + '" já estava na lista.' : 'Essa pasta já estava na lista.') : (nome ? '"' + nome + '" entrou na lista de projetos.' : 'Projeto adicionado.'));
        if (nome) renderLateral();
      } catch (e) {
        sim.removeAttribute('aria-busy'); sim.textContent = 'Adicionar';
        mostrarErro(e.status === 404 ? (e.message && !/^Erro/.test(e.message) ? e.message : 'Essa pasta não existe.') : e.message);
      }
    }
    campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); navegar(campo.value); } });
    campo.addEventListener('input', () => mostrarErro(''));
    ir.addEventListener('click', () => navegar(campo.value));
    acima.addEventListener('click', subir);
    lista.addEventListener('click', (e) => { const el = e.target.closest('.arq-sp-item'); if (el) selecionar(Number(el.dataset.i), true); });
    lista.addEventListener('dblclick', (e) => { const el = e.target.closest('.arq-sp-item'); if (el) navegar(st.itens[Number(el.dataset.i)].caminho); });
    lista.addEventListener('keydown', (e) => {
      const n = st.itens.length;
      const proximo = (de, dir) => { let i = de; do { i += dir; } while (i >= 0 && i < n && st.itens[i].grupo); return i >= 0 && i < n ? i : de; };
      if (e.key === 'ArrowDown') selecionar(proximo(st.sel, 1), true);
      else if (e.key === 'ArrowUp') selecionar(proximo(st.sel < 0 ? n : st.sel, -1), true);
      else if (e.key === 'Home') selecionar(proximo(-1, 1), true);
      else if (e.key === 'End') selecionar(proximo(n, -1), true);
      else if (e.key === 'Enter') { if (st.sel >= 0) navegar(st.itens[st.sel].caminho); else adicionar(); }
      else if (e.key === 'Backspace') subir();
      else return;
      e.preventDefault();
    });
    lista.addEventListener('focus', () => { if (st.sel < 0) { const i = st.itens.findIndex((it) => !it.grupo); if (i >= 0) selecionar(i, true); } });
    campo.focus();
    inicio();
    return dlg;
  }

  // ───────────── toasts ─────────────
  function toast(msg, erro) {
    if (!E.toasts || !E.toasts.isConnected) { E.toasts = h('div', { class: 'arq-toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(E.toasts); }
    const t = h('div', { class: 'arq-toast' + (erro ? ' erro' : ''), role: erro ? 'alert' : null, title: msg }, h('span', { text: msg }));
    E.toasts.append(t);
    while (E.toasts.children.length > 2) E.toasts.firstElementChild.remove();
    setTimeout(() => { t.classList.add('saindo'); setTimeout(() => t.remove(), 200); }, erro ? 4200 : 2200);
  }

  // ───────────── vistas: prévia e busca (#arquivo e abas) ─────────────
  // Uma vista = { el, op, emAba, principal, v (estado da prévia ou da busca), seqV, seqB, tBusca, pausado, busca, tecla }.
  // A principal (montarVista, #arquivo) é a de sempre; criarVista faz outras, uma por aba. O SSE "arquivos", o "temas" e
  // a conexão valem para todas.
  function novaVista(op, principal) {
    const V = { el: null, op: op || {}, emAba: !!(op && op.emAba), principal: !!principal, v: null, seqV: 0, seqB: 0, tBusca: 0,
      pausado: false, busca: principal ? E.busca : { ...E.busca }, tecla: null };
    E.vistas.add(V);
    return V;
  }
  E.vp = novaVista(null, true);
  function temAbas() { return !!(E.g && typeof E.g.abrirAba === 'function'); }
  // Todo abrir da árvore e da busca passa por aqui: com abas, é um pedido à página; sem, abre na vista (como hoje).
  function abrir(nome, caminho, op, previa, V) {
    const linha = op && Number(op.linha) > 0 ? Number(op.linha) : 0;
    if (temAbas()) { chamar('abrirAba', { tipo: 'arquivo', proj: nome, caminho, ...(linha ? { linha } : {}), previa: !!previa }); return; }
    abrirArquivo(V || E.vp, nome, caminho, linha ? { linha } : {});
  }
  function localizar(nome, escopo) {
    if (temAbas()) { chamar('abrirAba', { tipo: 'busca', proj: nome, escopo }); return; }
    abrirBusca(E.vp, nome, escopo);
  }
  function limparVista(V) {
    const v = V.v;
    if (v && v.url) { try { URL.revokeObjectURL(v.url); } catch {} }
    clearTimeout(V.tBusca);
    V.v = null;
  }
  function fecharVista(V) {
    limparVista(V); desenharVista(V);
    if (V.principal) chamar('vistaFechada');
    else if (typeof V.op.fechar === 'function') { try { V.op.fechar(); } catch (e) { console.warn('Arquivos: fechar', e); } }
  }
  function abrirArquivo(V, nome, caminho, op = {}) {
    const ant = V.v;
    if (ant && ant.modo === 'previa' && ant.proj === nome && ant.caminho === caminho && ant.dados && !op.linha) { if (V.principal) chamar('mostrarVista'); return; }
    limparVista(V);
    V.v = { modo: 'previa', proj: nome, caminho, linha: Number(op.linha) || 0, dados: null, erro: null, carregando: true, sujo: false, rolou: false };
    desenharVista(V);
    if (V.principal) chamar('mostrarVista');
    carregarPrevia(V, false);
  }
  async function carregarPrevia(V, manter, conferir) {
    const v = V.v;
    if (!v || v.modo !== 'previa') return;
    const seq = ++V.seqV;
    v.seq = seq; v.sujo = false;
    if (conferir) {
      const ok = await existe(v.proj, v.caminho);
      if (V.v !== v || v.seq !== seq) return;
      if (!ok) { marcarSumiu(V); return; }
    }
    let dados = null, erro = null, url = null;
    try {
      dados = await pedir('/arquivos/ler?' + qs({ projeto: v.proj, caminho: v.caminho }));
      if (dados.tipo === 'imagem') {
        try {
          const r = await fetch('/arquivos/bruto?' + qs({ projeto: v.proj, caminho: v.caminho }), { cache: 'no-store' });
          if (r.ok) url = URL.createObjectURL(await r.blob());
        } catch {}
      }
    } catch (e) { erro = e; }
    if (V.v !== v || v.seq !== seq) { if (url) URL.revokeObjectURL(url); return; }
    if (v.url) { try { URL.revokeObjectURL(v.url); } catch {} }
    const texto = !erro && dados && dados.tipo === 'texto';
    // Ao atualizar um arquivo já aberto, espera um pouco pelas cores para a tela não piscar sem elas.
    const pedido = texto ? pedirRealce({ ...v, dados }) : null;
    let realce;
    if (pedido && manter) {
      realce = await Promise.race([pedido, new Promise((r) => setTimeout(() => r(undefined), 1500))]);
      if (V.v !== v || v.seq !== seq) { if (url) URL.revokeObjectURL(url); return; }
    }
    v.url = url; v.dados = dados; v.erro = erro; v.carregando = false; v.realce = realce || null;
    desenharVista(V, manter);
    if (pedido && realce === undefined) {
      const re = await pedido;
      if (re && V.v === v && v.seq === seq) { v.realce = re; desenharVista(V, true); }
    }
  }
  function ligarVista(V, el) {
    if (V.el && V.tecla) V.el.removeEventListener('keydown', V.tecla);
    V.el = el;
    el.classList.add('arq-vista');
    el.classList.toggle('arq-em-aba', V.emAba);
    V.tecla = (e) => {
      if (e.target.closest('input')) return;
      if (V.v && V.v.modo === 'previa' && e.altKey && !e.ctrlKey && e.code === 'KeyZ') { e.preventDefault(); alternarQuebra(); }
    };
    el.addEventListener('keydown', V.tecla);
  }
  function montarVista(el) {
    if (!el) return;
    ligarVista(E.vp, el);
    desenharVista(E.vp);
  }
  // Vista própria numa aba (rodada 9). op = { emAba: true, fechar() }: sem o × do cabeçalho; o Esc não fecha.
  function criarVista(el, op) {
    if (!el || !(el instanceof Element)) throw new TypeError('Arquivos.criarVista: falta o elemento');
    const V = novaVista(op && typeof op === 'object' ? op : {}, false);
    ligarVista(V, el);
    desenharVista(V);
    const viva = () => E.vistas.has(V);
    return Object.freeze({
      abrirArquivo: (p, c, o) => { if (viva() && typeof p === 'string' && p && typeof c === 'string' && c) abrirArquivo(V, p, c, o && typeof o === 'object' ? o : {}); },
      abrirBusca: (p, escopo) => { if (viva() && typeof p === 'string' && p) abrirBusca(V, p, typeof escopo === 'string' ? escopo : ''); },
      estado: () => estadoVista(V),
      pausar: () => { V.pausado = true; },
      retomar: () => { if (viva()) retomarVista(V); },
      destruir: () => destruirVista(V),
    });
  }
  function estadoVista(V) {
    const v = V.v;
    if (!v) return { modo: null, proj: null, caminho: null, linha: 0 };
    if (v.modo === 'busca') return { modo: 'busca', proj: v.proj, escopo: v.escopo, linha: 0 };
    return { modo: 'previa', proj: v.proj, caminho: v.caminho, linha: v.linha || 0, sumiu: !!(v.erro && v.erro.status === 404) };
  }
  function retomarVista(V) {
    V.pausado = false;
    const v = V.v;
    if (v && v.modo === 'previa' && v.sujo) carregarPrevia(V, true, true);
    else requestAnimationFrame(() => rolarParaLinha(V));
  }
  function destruirVista(V) {
    if (V.principal || !E.vistas.has(V)) return;
    limparVista(V);
    V.seqV++; V.seqB++;
    E.vistas.delete(V);
    if (V.el) {
      if (V.tecla) V.el.removeEventListener('keydown', V.tecla);
      V.el.classList.remove('arq-vista', 'arq-em-aba');
      V.el.replaceChildren();
    }
    V.el = null; V.tecla = null;
  }
  function botaoIco(nomeIco, rot, onclick, extra) {
    return h('button', { type: 'button', class: 'arq-btn-ico', title: rot, 'aria-label': rot, onclick, ...(extra || {}) }, ico(nomeIco, 15));
  }
  function alternarQuebra() {
    E.quebra = !E.quebra; gravarLS(LS_QUEBRA, E.quebra);
    for (const V of E.vistas) {
      if (!V.el) continue;
      const c = V.el.querySelector('.arq-codigo');
      if (c) c.classList.toggle('quebra', E.quebra);
      const b = V.el.querySelector('.arq-b-quebra');
      if (b) b.setAttribute('aria-pressed', String(E.quebra));
    }
  }
  function estadoVazio(icoEl, titulo, texto, ...acoes) {
    return h('div', { class: 'arq-vazio' }, h('span', { class: 'arq-quad grande' }, icoEl), h('h3', { text: titulo }), texto ? h('p', { text: texto }) : null, acoes.length ? h('div', { class: 'arq-vazio-acoes' }, ...acoes) : null);
  }
  // Caminho da prévia: na vista principal, "projeto › pasta\arquivo"; na aba, migalhas como o VS Code (projeto › pasta › …).
  function caminhoCab(V, nome, caminho, abs) {
    if (!V.emAba) return h('p', { class: 'arq-cab-cam', title: abs }, h('span', { class: 'arq-cab-proj', text: nome }), h('span', { class: 'arq-cab-sep', text: '›' }), h('span', { class: 'arq-cab-rel', text: relativo(caminho) }));
    const segs = caminho ? caminho.split('/') : [];
    const rel = h('span', { class: 'arq-cab-rel' });
    segs.slice(0, -1).forEach((s) => rel.append(h('span', { class: 'arq-cab-sep', 'aria-hidden': 'true', text: '›' }), h('span', { class: 'arq-cab-seg', text: s })));
    return h('p', { class: 'arq-cab-cam arq-migalha', title: abs, 'aria-label': 'Caminho: ' + abs }, h('span', { class: 'arq-cab-proj', text: nome }), rel);
  }
  function desenharVista(V, manter) {
    const el = V && V.el;
    if (!el) return;
    const v = V.v;
    if (!v) {
      el.replaceChildren(h('div', { class: 'arq-corpo' }, estadoVazio(ico('projeto', 20), 'Nenhum arquivo aberto', 'Abra a seta de um projeto na barra lateral e escolha um arquivo para ver a prévia.')));
      return;
    }
    if (v.modo === 'busca') { desenharBusca(V); return; }
    const rolagem = manter ? lerRolagem(el) : null;
    const nome = baseDe(v.caminho);
    const abs = absoluto(v.proj, v.caminho);
    const d = v.dados;
    const meta = [];
    if (d && Number.isFinite(d.tamanho)) meta.push(tamanhoTxt(d.tamanho));
    if (d && d.tipo === 'texto' && typeof d.linguagem === 'string' && d.linguagem) meta.push(d.linguagem);
    let linhas = null;
    if (d && d.tipo === 'texto' && typeof d.conteudo === 'string') {
      linhas = d.conteudo.split(/\r\n|\r|\n/);
      if (linhas.length > 1 && linhas[linhas.length - 1] === '') linhas.pop();
      meta.push(linhas.length.toLocaleString('pt-BR') + (linhas.length === 1 ? ' linha' : ' linhas'));
    }
    const acoes = [];
    if (linhas) acoes.push(botaoIco('quebra', 'Quebra de linha', alternarQuebra, { class: 'arq-btn-ico arq-b-quebra', 'aria-pressed': String(E.quebra) }));
    acoes.push(botaoIco('copiar', 'Copiar caminho', () => copiarTexto(abs, 'Caminho copiado'), { class: 'arq-btn-ico arq-b-copiar' }));
    acoes.push(botaoIco('revelar', rotRevelar(), () => revelar(v.proj, v.caminho), { class: 'arq-btn-ico arq-b-revelar' }));
    if (!V.emAba) acoes.push(botaoIco('fechar', 'Fechar', () => fecharVista(V), { class: 'arq-btn-ico arq-b-fechar' }));
    const cab = V.emAba
      ? h('header', { class: 'arq-cab arq-cab-aba' },
        h('div', { class: 'arq-cab-txt' }, caminhoCab(V, v.proj, v.caminho, abs),
          h('span', { class: 'arq-cab-sep', 'aria-hidden': 'true', text: '›' }),
          h('span', { class: 'arq-cab-arq' }, iconeItem(nome, 'arquivo', false, 16), h('h2', { class: 'arq-cab-nome', text: nome, title: nome }))),
        meta.length ? h('span', { class: 'arq-cab-meta', text: meta.join(' · '), title: meta.join(' · ') }) : null,
        h('div', { class: 'arq-cab-acoes' }, ...acoes))
      : h('header', { class: 'arq-cab' },
        iconeItem(nome, 'arquivo', false, 18),
        h('div', { class: 'arq-cab-txt' }, h('h2', { class: 'arq-cab-nome', text: nome, title: nome }), caminhoCab(V, v.proj, v.caminho, abs)),
        meta.length ? h('span', { class: 'arq-cab-meta', text: meta.join(' · '), title: meta.join(' · ') }) : null,
        h('div', { class: 'arq-cab-acoes' }, ...acoes));
    let corpo;
    if (v.carregando && !d) corpo = h('div', { class: 'arq-corpo' }, h('div', { class: 'arq-carregando', text: 'Carregando…' }));
    else if (v.erro) {
      const sumiu = v.erro.status === 404;
      corpo = h('div', { class: 'arq-corpo' }, estadoVazio(ico(sumiu ? 'lixeira' : 'info', 20), sumiu ? 'Este arquivo foi apagado ou movido' : 'Não deu para abrir', sumiu ? 'Ele saiu desta pasta: foi para a Lixeira, mudou de lugar ou de nome.' : v.erro.message));
    } else if (d.tipo === 'imagem') {
      const img = h('img', { class: 'arq-img', alt: nome, src: v.url || null });
      const legenda = h('p', { class: 'arq-img-leg', text: meta.join(' · ') });
      img.addEventListener('load', () => { if (img.naturalWidth) legenda.textContent = [img.naturalWidth + ' × ' + img.naturalHeight + ' px', ...meta].join(' · '); });
      corpo = h('div', { class: 'arq-corpo arq-corpo-img' }, v.url ? h('div', { class: 'arq-img-caixa' }, img) : estadoVazio(ico('info', 20), 'Não deu para carregar a imagem', null), legenda);
    } else if (d.tipo === 'binario' || d.tipo === 'grande') {
      const grande = d.tipo === 'grande';
      corpo = h('div', { class: 'arq-corpo' }, estadoVazio(iconeItem(nome, 'arquivo', false, 20),
        grande ? 'Grande demais para a prévia' : 'Arquivo binário',
        grande ? 'Tem ' + tamanhoTxt(d.tamanho) + '; a prévia mostra textos de até 2 MB. Abra no editor ou no ' + nomeExplorador() + '.' : 'Este arquivo não é texto, então não há prévia. Abra no programa dele pelo ' + nomeExplorador() + '.',
        h('button', { type: 'button', class: 'arq-btn', onclick: () => revelar(v.proj, v.caminho) }, ico('revelar', 15), rotRevelar())));
    } else if (linhas) {
      const dig = String(linhas.length).length;
      const R = v.realce;
      const cod = h('div', { class: 'arq-codigo' + (E.quebra ? ' quebra' : '') + (R ? ' arq-realce' : ''), role: 'region', 'aria-label': 'Conteúdo de ' + nome, tabindex: '0',
        'data-tema': R && R.tema ? R.tema : null });
      cod.style.setProperty('--dig', dig);
      // Com o realce, o texto sem cor própria usa a cor padrão do tema; o fundo continua o do Orbit.
      if (R && corValida(R.fg)) cod.style.color = R.fg;
      const box = h('div', { class: 'arq-linhas' });
      const frag = document.createDocumentFragment();
      linhas.forEach((t, i) => {
        const l = document.createElement('div');
        l.className = 'arq-l' + (v.linha === i + 1 ? ' arq-destaque' : '');
        const n = document.createElement('span'); n.className = 'arq-ln'; n.textContent = String(i + 1);
        const tx = document.createElement('span'); tx.className = 'arq-lt';
        const tk = R && R.linhas[i];
        if (Array.isArray(tk) && tk.reduce((a, x) => a + (Array.isArray(x) && typeof x[0] === 'string' ? x[0].length : 0), 0) === t.length) preencherLinha(tx, tk, R.cores);
        else tx.textContent = t;
        l.append(n, tx);
        frag.append(l);
      });
      box.append(frag);
      cod.append(box);
      corpo = h('div', { class: 'arq-corpo' }, linhas.length === 1 && linhas[0] === '' ? estadoVazio(iconeItem(nome, 'arquivo', false, 20), 'Arquivo vazio', null) : cod);
    } else corpo = h('div', { class: 'arq-corpo' }, estadoVazio(ico('info', 20), 'Sem prévia', null));
    el.replaceChildren(cab, corpo);
    if (rolagem) aplicarRolagem(el, rolagem);
    else if (!manter) { const r = rolador(el); if (r) r.scrollTop = 0; }
    rolarParaLinha(V);
  }
  function rolador(el) { let p = el.parentElement; while (p && p !== document.body) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight) return p; p = p.parentElement; } return el.closest('.principal') || document.scrollingElement; }
  function lerRolagem(el) { const r = rolador(el); const c = el.querySelector('.arq-codigo'); return { y: r ? r.scrollTop : 0, x: c ? c.scrollLeft : 0 }; }
  function aplicarRolagem(el, s) { const r = rolador(el); if (r) r.scrollTop = s.y; const c = el.querySelector('.arq-codigo'); if (c) c.scrollLeft = s.x; }
  function rolarParaLinha(V) {
    const v = V && V.v;
    if (!v || !v.linha || v.rolou || V.pausado || !V.el || !V.el.getClientRects().length) return;
    const l = V.el.querySelector('.arq-l.arq-destaque');
    if (!l) return;
    v.rolou = true;
    l.scrollIntoView({ block: 'center' });
  }

  function abrirBusca(V, nome, caminho) {
    limparVista(V);
    V.v = { modo: 'busca', proj: nome, escopo: caminho, res: null, erro: null, carregando: false, ui: null };
    desenharVista(V);
    if (V.principal) chamar('mostrarVista');
    requestAnimationFrame(() => { const v = V.v; if (v && v.ui && V.el && V.el.getClientRects().length) { v.ui.input.focus({ preventScroll: true }); v.ui.input.select(); } });
    if (V.busca.texto) buscar(V);
  }
  function desenharBusca(V) {
    const v = V.v, el = V.el, B = V.busca;
    const tinhaFoco = !!(v.ui && document.activeElement === v.ui.input);
    const escopo = v.escopo ? v.proj + '/' + v.escopo + '/' : v.proj + '/';
    const input = h('input', { class: 'arq-busca-input', type: 'search', spellcheck: 'false', autocomplete: 'off', placeholder: 'Localizar', 'aria-label': 'Texto a localizar em ' + escopo });
    input.value = B.texto;
    const opcao = (chaveOp, rot, dica) => {
      const b = h('button', { type: 'button', class: 'arq-op arq-op-' + chaveOp, 'aria-pressed': String(B[chaveOp]), title: dica, 'aria-label': dica }, rot);
      b.addEventListener('click', () => { B[chaveOp] = !B[chaveOp]; b.setAttribute('aria-pressed', String(B[chaveOp])); buscar(V); input.focus({ preventScroll: true }); });
      return b;
    };
    const ops = [opcao('maiusculas', 'Aa', 'Diferenciar maiúsculas'), opcao('palavra', 'ab', 'Palavra inteira'), opcao('regex', '.*', 'Expressão regular')];
    ops[1].classList.add('sublinhado');
    input.addEventListener('input', () => { B.texto = input.value; agendarBusca(V); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(V.tBusca); buscar(V); return; }
      if (e.altKey && !e.ctrlKey) {
        const m = { KeyC: 0, KeyW: 1, KeyR: 2 }[e.code];
        if (m != null) { e.preventDefault(); ops[m].click(); }
      }
    });
    const status = h('p', { class: 'arq-busca-status', role: 'status', 'aria-live': 'polite' });
    const lista = h('div', { class: 'arq-res' });
    const cab = h('header', { class: 'arq-cab arq-cab-busca' + (V.emAba ? ' arq-cab-aba' : '') },
      h('span', { class: 'arq-ico' }, ico('busca', V.emAba ? 16 : 18)),
      h('div', { class: 'arq-cab-txt' },
        h('h2', { class: 'arq-cab-nome', text: 'Localizar na pasta' }),
        h('p', { class: 'arq-cab-cam', title: absoluto(v.proj, v.escopo) }, h('span', { class: 'arq-cab-proj', text: 'em' }), h('span', { class: 'arq-cab-rel', text: escopo }))),
      V.emAba ? null : h('div', { class: 'arq-cab-acoes' }, botaoIco('fechar', 'Fechar', () => fecharVista(V), { class: 'arq-btn-ico arq-b-fechar' })));
    const campo = h('div', { class: 'arq-busca-campo' }, ico('busca', 14), input, h('div', { class: 'arq-ops' }, ...ops));
    el.replaceChildren(cab, h('div', { class: 'arq-corpo arq-corpo-busca' }, campo, status, lista));
    v.ui = { input, status, lista };
    if (tinhaFoco) input.focus({ preventScroll: true });
    desenharResultados(V);
  }
  function agendarBusca(V) { clearTimeout(V.tBusca); V.tBusca = setTimeout(() => buscar(V), 250); }
  async function buscar(V) {
    const v = V.v;
    if (!v || v.modo !== 'busca') return;
    const B = V.busca;
    const texto = B.texto;
    const seq = ++V.seqB;
    if (!texto) { v.res = null; v.erro = null; v.carregando = false; desenharResultados(V); return; }
    v.carregando = true; desenharResultados(V, true);
    try {
      const j = await pedir('/arquivos/buscar', { projeto: v.proj, caminho: v.escopo, texto, maiusculas: B.maiusculas, palavra: B.palavra, regex: B.regex });
      if (seq !== V.seqB || V.v !== v) return;
      v.res = j; v.erro = null;
    } catch (e) {
      if (seq !== V.seqB || V.v !== v) return;
      v.res = null; v.erro = e.message;
    }
    v.carregando = false;
    desenharResultados(V);
  }
  function desenharResultados(V, soStatus) {
    const v = V.v;
    if (!v || !v.ui) return;
    const { status, lista } = v.ui;
    status.classList.toggle('erro', !!v.erro);
    if (v.carregando) { status.textContent = 'Procurando…'; if (soStatus) return; }
    if (soStatus) return;
    if (v.erro) { status.textContent = v.erro; lista.replaceChildren(); return; }
    if (!v.res) { status.textContent = 'Digite para procurar nos arquivos de texto (pula .git, node_modules e binários).'; lista.replaceChildren(); return; }
    const res = (Array.isArray(v.res.resultados) ? v.res.resultados : []).filter((r) => r && typeof r.caminho === 'string');
    const oc = Number(v.res.ocorrencias) || res.reduce((a, r) => a + (Array.isArray(r.linhas) ? r.linhas.length : 0), 0);
    status.textContent = !res.length ? 'Nenhum resultado.' : oc.toLocaleString('pt-BR') + (oc === 1 ? ' ocorrência' : ' ocorrências') + ' em ' + res.length.toLocaleString('pt-BR') + (res.length === 1 ? ' arquivo' : ' arquivos') + (v.res.truncado ? ' · busca parcial (limite de tempo ou de resultados)' : '');
    const grupos = res.map((r) => {
      const nome = baseDe(r.caminho);
      const dir = paiDe(r.caminho);
      const ls = (Array.isArray(r.linhas) ? r.linhas : []).filter((l) => l && typeof l.texto === 'string');
      const cabG = h('button', { type: 'button', class: 'arq-res-cab', title: absoluto(v.proj, r.caminho), onclick: () => abrir(v.proj, r.caminho, null, true, V) },
        iconeItem(nome, 'arquivo', false, 15), h('span', { class: 'arq-res-nome', text: nome }), dir ? h('span', { class: 'arq-res-dir', text: relativo(dir) }) : null, h('span', { class: 'arq-res-n', text: String(ls.length) }));
      const linhasEl = ls.map((l) => {
        const t = l.texto, ini = Math.max(0, Math.min(t.length, Number(l.ini) || 0)), fim = Math.max(ini, Math.min(t.length, Number(l.fim) || ini));
        return h('button', { type: 'button', class: 'arq-res-linha', title: 'Linha ' + l.n + ': ' + t.trim(), onclick: () => abrir(v.proj, r.caminho, { linha: l.n }, true, V) },
          h('span', { class: 'arq-res-ln', text: String(l.n) }),
          h('span', { class: 'arq-res-t' }, t.slice(0, ini), h('mark', { text: t.slice(ini, fim) }), t.slice(fim)));
      });
      return h('section', { class: 'arq-res-grupo' }, cabG, ...linhasEl);
    });
    lista.replaceChildren(...grupos);
  }

  // ───────────── API pública ─────────────
  let montado = false;
  function montar(api, ganchos) {
    E.api = api || null;
    E.g = ganchos || {};
    if (montado) return;
    montado = true;
    if (api && typeof api.on === 'function') {
      api.on('projetos', (d) => { if (d && Array.isArray(d.projetos)) definirLista(d.projetos); });
      api.on('arquivos', aoArquivos);
      api.on('conexao', aoConexao);
      // Temas do VS Code: trocou o tema no VS Code → novos ícones e novas cores nas prévias abertas (todas as vistas).
      api.on('temas', () => {
        carregarTema();
        for (const V of [...E.vistas]) {
          const v = V.v;
          if (v && v.modo === 'previa' && v.dados) { if (V.pausado) v.sujo = true; else carregarPrevia(V, true); }
        }
      });
    }
    carregarTema();
    const add = document.getElementById('proj-add');
    if (add && !add._arq) {
      add._arq = true;
      add.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); seletorPasta(); });
      if (!add.firstElementChild || !add.querySelector('svg')) add.replaceChildren(ico('mais', 14));
    }
    carregarLista();
  }
  function pausar() { E.vp.pausado = true; fecharMenu(false); }
  function retomar() { retomarVista(E.vp); }
  function projetos() { return E.lista ? E.lista.map((p) => ({ ...p })) : null; }
  // O mesmo ícone da árvore (com o tema de ícones do VS Code, quando houver), para as abas.
  function icone(nome, tipo = 'arquivo', tam = 16) {
    const t = Number(tam);
    return iconeItem(String(nome == null ? '' : nome), tipo === 'pasta' ? 'pasta' : 'arquivo', false, t > 0 && t <= 64 ? t : 16);
  }
  function absolutoPub(nome, caminho) { return absoluto(String(nome || ''), String(caminho || '')); }
  // Marca discreta na linha da árvore do arquivo da aba em foco (sem abrir pastas nem rolar); null tira.
  function marcarAtivo(nome, caminho) {
    const k = typeof nome === 'string' && nome && typeof caminho === 'string' && caminho ? chave(nome, caminho) : null;
    E.ativo = k;
    if (!E.caixa) return;
    for (const el of E.caixa.querySelectorAll('.arq-no.arq-ativo')) { el.classList.remove('arq-ativo'); el.removeAttribute('aria-current'); }
    const el = k ? acharLinha(k) : null;
    if (el && el.dataset.tipo !== 'pasta') { el.classList.add('arq-ativo'); el.setAttribute('aria-current', 'true'); }
  }

  window.Arquivos = Object.freeze({ montar, renderLateral, montarVista, criarVista, pausar, retomar, projetos, icone, absoluto: absolutoPub, marcarAtivo });
})();
