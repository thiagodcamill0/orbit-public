// Orbit — Whiteboard (ajustes, entrega B: card de navegador). Carregado depois de whiteboard.js (e de -agentes/-times).
// Tipo 'web' só com `html` (camada HTML): um site fixo no quadro. Elemento:
//   { tipo: 'web', x, y, w: 480, h: 340, web: { url, titulo } }   (mínimo 240×180)
// O que o card mostra (a exportação da etapa 6 vai precisar desenhar isto; não há tipo.desenhar de propósito):
//   · cabeçalho de 34 px: ícone de globo (Navegador.icone), título (web.titulo ou Navegador.titulo(url) = host + último trecho)
//     e quatro botões: Interagir, Recarregar, Editar endereço, Abrir no navegador;
//   · corpo: a página num iframe (só quando o card está na vista e o zoom >= 20%) ou, fora disso, o "cartão-resumo"
//     (globo grande + host + endereço legível); ou o aviso de site que não abre (mesmo texto do navegador interno).
//   Uma captura do site NÃO existe (o Orbit não lê a página embutida), então a exportação deve usar o cartão-resumo.
// Proteções do iframe = as do navegador interno (assets/navegador.js:15-16,139), repetidas aqui porque window.Navegador não as
// expõe: mesmo sandbox, mesmo allow, mesmo referrerpolicy. Endereço: Navegador.normalizar (só http/https, sem controle, ≤ 2048),
// recusa o próprio Orbit. Antes de carregar: POST /navegador/checar {url} (x-gerenciador: 1); rota inexistente (404) = carrega direto.
// Interação: por padrão o iframe fica sob uma "película" (pointer-events: none): arrastar/selecionar/rolar vão para o quadro.
// Duplo clique no corpo (ou botão Interagir) liga o modo interação (contorno de destaque); Esc ou clique fora desliga.
// Duplo clique no cabeçalho edita o endereço (atualizar + confirmar('Navegador')). Soltar um link (text/uri-list) cria o card.
// Sem ferramenta na barra. Publica Whiteboard.web = { adicionar(url, x, y) → id, pedirEndereco(x, y) }.
(() => {
  'use strict';
  const W = window.Whiteboard;
  if (!W || !W.registrarTipo || !W.nucleo) return;
  const N = W.nucleo;
  const LARG = 480, ALT = 340, MIN_W = 240, MIN_H = 180, HCAB = 34;
  const ZOOM_CARGA = 0.2;      // abaixo disso o card vira cartão-resumo
  const DESCARGA = 8000;       // fora da vista por este tempo: o iframe é descarregado
  const TEMPO_CARGA = 20000;
  const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation';
  const PERMITIR = 'clipboard-read; clipboard-write; fullscreen; autoplay; display-capture; web-share';
  const CAB = { 'content-type': 'application/json', 'x-gerenciador': '1' };
  const NS = 'http://www.w3.org/2000/svg';
  const ICONES = {
    globo: ['M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11z', 'M2.5 8h11', 'M8 2.5c1.6 1.5 2.4 3.3 2.4 5.5S9.6 12 8 13.5C6.4 12 5.6 10.2 5.6 8S6.4 4 8 2.5z'],
    recarregar: ['M12.5 8a4.5 4.5 0 1 1-1.4-3.3', 'M12.5 2.8v2.6H9.9'],
    fora: ['M9 3h4v4', 'M13 3L7.5 8.5', 'M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5'],
    editar: ['M3 13l.6-2.6L10.8 3.2a1.2 1.2 0 0 1 1.7 0l.3.3a1.2 1.2 0 0 1 0 1.7L5.6 12.4z', 'M9.6 4.4l2 2'],
    interagir: ['M5 2.8l6.4 5-3 .6 1.7 3.2-1.4.8-1.7-3.2-2.2 1.9z'],
    cadeado: ['M4.5 7.5h7v5h-7z', 'M6 7.5V6a2 2 0 0 1 4 0v1.5'],
    aviso: ['M8 2.8l5.6 9.7H2.4z', 'M8 6.6v2.6', 'M8 11h0'],
    plug: ['M6 2v3', 'M10 2v3', 'M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0z', 'M8 11v3'],
    desligado: ['M8 2.5v5', 'M4.6 4.6a4.8 4.8 0 1 0 6.8 0'],
  };
  function icone(nome, tam = 16) {
    if (nome === 'globo' && window.Navegador && typeof window.Navegador.icone === 'function') { try { return window.Navegador.icone(tam); } catch {} }
    const s = document.createElementNS(NS, 'svg');
    for (const [k, v] of [['width', tam], ['height', tam], ['viewBox', '0 0 16 16'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.3'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]) s.setAttribute(k, v);
    for (const d of ICONES[nome] || []) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p); }
    return s;
  }
  const h = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const botao = (cls, titulo, ic) => { const b = h('button', cls); b.type = 'button'; b.title = titulo; b.setAttribute('aria-label', titulo); if (ic) b.append(icone(ic, 14)); return b; };

  // ── endereços ──
  function normalizar(bruto) {
    if (window.Navegador && typeof window.Navegador.normalizar === 'function') return window.Navegador.normalizar(bruto);
    if (typeof bruto !== 'string') return null;
    let s = bruto.trim();
    if (!s || s.length > 2048 || /[\u0000-\u001f]/.test(s)) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:/]+:\d/.test(s)) return null;
      s = 'http://' + s;
    }
    try { const u = new URL(s); return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? u.href : null; } catch { return null; }
  }
  const LOCAIS = ['127.0.0.1', 'localhost', '[::1]'];
  function ehProprio(href) {
    try {
      const u = new URL(href), l = location;
      const pu = u.port || (u.protocol === 'https:' ? '443' : '80'), pl = l.port || (l.protocol === 'https:' ? '443' : '80');
      return u.origin === l.origin || (LOCAIS.includes(u.hostname.toLowerCase()) && LOCAIS.includes(l.hostname.toLowerCase()) && pu === pl);
    } catch { return false; }
  }
  // Devolve { href } ou { erro } (texto para o usuário).
  function validar(bruto) {
    const href = normalizar(bruto);
    if (!href) return { erro: 'Use um endereço http:// ou https://, como exemplo.com.' };
    if (ehProprio(href)) return { erro: 'O Orbit não abre dentro de si mesmo.' };
    return { href };
  }
  const hostDe = (href) => { try { return new URL(href).host; } catch { return ''; } };
  const legivel = (href) => {
    if (window.Navegador && window.Navegador.legivel) { try { return window.Navegador.legivel(href); } catch {} }
    return hostDe(href) || href || '';
  };
  const tituloDe = (el) => {
    const w = el.web || {};
    if (w.titulo) return String(w.titulo);
    if (window.Navegador && window.Navegador.titulo) { try { return window.Navegador.titulo({ url: w.url }); } catch {} }
    return hostDe(w.url) || String(w.url || 'Site');
  };
  // Mesmos textos de navegador.js mensagem().
  function mensagem(r, href) {
    const host = hostDe(href);
    switch (r.estado) {
      case 'bloqueado': return { ic: 'cadeado', tit: 'Este site não abre dentro do Orbit', p: host + ' não permite ser exibido dentro de outra página' + (r.bloqueio === 'frame-ancestors' ? ' (CSP frame-ancestors).' : ' (X-Frame-Options).'), forcar: true };
      case 'fora-do-ar': return { ic: 'desligado', tit: 'Nada respondendo em ' + host, p: r.local ? 'O servidor do projeto pode estar parado ou ainda subindo.' : 'O servidor recusou a conexão.' };
      case 'nao-encontrado': return { ic: 'aviso', tit: 'Endereço não encontrado', p: 'Não deu para achar ' + host + '. Confira o endereço.' };
      case 'sem-resposta': return { ic: 'aviso', tit: host + ' não respondeu', p: 'A página demorou demais para responder.', forcar: true };
      case 'certificado': return { ic: 'cadeado', tit: 'Certificado não confiável', p: 'O certificado de ' + host + ' não foi aceito. Abra no navegador para ver os detalhes.', forcar: true };
      case 'orbit': return { ic: 'aviso', tit: 'Este é o próprio Orbit', p: 'O Orbit não abre dentro de si mesmo.' };
      case 'invalido': return { ic: 'aviso', tit: 'Endereço inválido', p: 'Use um endereço http:// ou https://, como localhost:5173.' };
      default: return { ic: 'aviso', tit: 'Não deu para abrir', p: 'A conferência do endereço falhou.', forcar: true };
    }
  }

  // ── rede ──
  // null = rota inexistente (carrega direto); lança em erro de rede.
  async function checar(url) {
    const r = await fetch('/navegador/checar', { method: 'POST', headers: CAB, body: JSON.stringify({ url }) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('checar ' + r.status);
    return r.json();
  }
  function abrirFora(url) {
    const v = validar(url);
    if (v.erro) return;
    url = v.href;
    try { fetch('/navegador/externo', { method: 'POST', headers: CAB, body: JSON.stringify({ url }) }).catch(() => {}); } catch {}
  }

  // ── utilidades do quadro ──
  const ehWeb = (el) => !!el && el.tipo === 'web' && !!el.web && typeof el.web.url === 'string';
  const webs = () => N.elementos().filter(ehWeb);
  const noDe = (el) => { const c = N.camadaHtml(); return c ? c.querySelector(`.wb-no[data-id="${CSS.escape(el.id)}"]`) : null; };
  const palco = () => { const c = N.camadaHtml(); return c ? c.closest('.wb-palco') : null; };
  let avisoT = 0;
  function avisar(txt) {
    const pl = palco(), a = pl && pl.parentNode && pl.parentNode.querySelector('.wb-aviso');
    if (!a) return;
    a.textContent = txt; a.hidden = false;
    clearTimeout(avisoT);
    avisoT = setTimeout(() => { a.hidden = true; }, 4000);
  }

  // ── card (DOM) ──
  function montar(el) {
    const no = h('div', 'wb-web');
    const c = h('div', 'wb-web-c');
    const cab = h('div', 'wb-web-cab');
    const fav = h('span', 'wb-web-fav'); fav.append(icone('globo', 14));
    const tit = h('span', 'wb-web-tit');
    const bts = h('span', 'wb-web-bts');
    const bInt = botao('wb-web-bt wb-web-b-int', 'Interagir com a página', 'interagir');
    const bRec = botao('wb-web-bt wb-web-b-rec', 'Recarregar', 'recarregar');
    const bEd = botao('wb-web-bt wb-web-b-ed', 'Editar endereço', 'editar');
    const bFora = botao('wb-web-bt wb-web-b-fora', 'Abrir no navegador', 'fora');
    bts.append(bInt, bRec, bEd, bFora);
    cab.append(fav, tit, bts);
    const corpo = h('div', 'wb-web-corpo');
    const resumo = h('div', 'wb-web-resumo');
    const ric = h('span', 'wb-web-resumo-ic'); ric.append(icone('globo', 28));
    resumo.append(ric, h('span', 'wb-web-resumo-host'), h('span', 'wb-web-resumo-url'));
    const aviso = h('div', 'wb-web-aviso'); aviso.hidden = true; aviso.setAttribute('role', 'status');
    corpo.append(resumo, aviso);
    c.append(cab, corpo);
    no.append(c);
    no._id = el.id;
    criarAlca(no);
    no._w = { url: null, estado: 'resumo', seq: 0, vivo: true, timerDesc: 0, timerCarga: 0, iframe: null };
    no.dataset.estado = 'resumo';
    // Botões: não deixam o pointerdown chegar ao núcleo (senão iniciaria arrastar e capturaria o clique).
    for (const b of [bInt, bRec, bEd, bFora]) for (const t of ['pointerdown', 'dblclick']) b.addEventListener(t, (e) => e.stopPropagation());
    const el_ = () => N.elemento(no._id);
    bInt.addEventListener('click', () => { if (INT.id === no._id) sairInteracao(); else entrarInteracao(no._id); });
    bRec.addEventListener('click', () => { const e = el_(); if (e) carregar(no, true); });
    bEd.addEventListener('click', () => { const e = el_(); if (e) editarEndereco(e); });
    bFora.addEventListener('click', () => { const e = el_(); if (e && e.web.url) abrirFora(e.web.url); });
    return no;
  }
  const q = (no, s) => no.querySelector(s);
  function setEstado(no, estado) {
    no._w.estado = estado; no.dataset.estado = estado;
    const ifr = no._w.iframe;
    if (ifr) ifr.hidden = !(estado === 'carregando' || estado === 'pronto');
    q(no, '.wb-web-resumo').hidden = !(estado === 'resumo' || estado === 'checando');
    q(no, '.wb-web-aviso').hidden = estado !== 'aviso';
    q(no, '.wb-web-resumo-url').textContent = estado === 'checando' ? 'Abrindo…' : (no._w.url ? legivel(no._w.url) : '');
  }
  function removerIframe(no) {
    const w = no._w;
    clearTimeout(w.timerCarga); clearTimeout(w.timerDesc); w.timerDesc = 0;
    if (w.iframe) { try { w.iframe.src = 'about:blank'; } catch {} w.iframe.remove(); w.iframe = null; }
  }
  // Valida SEMPRE no ponto de uso (o endereço pode vir de arquivo/área de transferência): devolve o href seguro ou null.
  function estadoInvalido(bruto) {
    const href = normalizar(bruto);
    return href && ehProprio(href) ? 'orbit' : 'invalido';
  }
  function mostrar(no, bruto) {
    const w = no._w;
    removerIframe(no);
    const v = validar(bruto);
    if (v.erro) { telaAviso(no, { estado: estadoInvalido(bruto) }, bruto); return; }
    const href = v.href;
    const f = document.createElement('iframe');
    f.className = 'wb-web-quadro';
    f.setAttribute('sandbox', SANDBOX); f.setAttribute('allow', PERMITIR); f.setAttribute('allowfullscreen', '');
    f.setAttribute('title', 'Página'); f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    f.addEventListener('load', () => { if (w.iframe === f && w.estado === 'carregando') { clearTimeout(w.timerCarga); setEstado(no, 'pronto'); } });
    w.iframe = f;
    q(no, '.wb-web-corpo').prepend(f);
    setEstado(no, 'carregando');
    w.timerCarga = setTimeout(() => { if (w.iframe === f && w.estado === 'carregando') setEstado(no, 'pronto'); }, TEMPO_CARGA);
    f.src = href; // atribuir de novo recarrega
  }
  function telaAviso(no, r, href) {
    removerIframe(no);
    const m = mensagem(r, href), a = q(no, '.wb-web-aviso');
    const ic = h('div', 'wb-web-aviso-ic'); ic.append(icone(m.ic, 22));
    const acoes = h('div', 'wb-web-aviso-acoes');
    if (r.estado !== 'invalido' && r.estado !== 'orbit') {
      const fora = h('button', 'wb-web-bt-p wb-web-a-fora'); fora.type = 'button';
      fora.append(icone('fora', 14), document.createTextNode('Abrir no navegador'));
      fora.addEventListener('click', () => abrirFora(href));
      acoes.append(fora);
    }
    if (r.estado === 'fora-do-ar' || r.estado === 'sem-resposta' || r.estado === 'erro') {
      const de = h('button', 'wb-web-bt-s wb-web-a-de'); de.type = 'button';
      de.append(icone('recarregar', 14), document.createTextNode('Tentar de novo'));
      de.addEventListener('click', () => carregar(no, true));
      acoes.append(de);
    }
    if (m.forcar && r.estado !== 'fora-do-ar') {
      const forc = h('button', 'wb-web-link wb-web-a-forcar', 'Tentar mostrar mesmo assim'); forc.type = 'button';
      forc.addEventListener('click', () => mostrar(no, href));
      acoes.append(forc);
    }
    a.replaceChildren(ic, h('h2', null, m.tit), h('p', null, m.p), h('p', 'wb-web-aviso-url', legivel(href)), acoes);
    a.dataset.estado = r.estado;
    setEstado(no, 'aviso');
  }
  // Confere no servidor e mostra a página (ou o aviso). seq descarta respostas atrasadas.
  async function carregar(no, manual) {
    const w = no._w, href = w.url;
    if (!href) return;
    const n = ++w.seq;
    removerIframe(no);
    if (validar(href).erro) { telaAviso(no, { estado: estadoInvalido(href) }, href); return; }
    setEstado(no, 'checando');
    let r = null;
    try { r = await checar(validar(href).href); } catch { r = { estado: 'erro' }; }
    if (!w.vivo || n !== w.seq) return;
    if (!r || r.estado === 'ok') return mostrar(no, href);
    telaAviso(no, r, href);
  }

  // ── visibilidade: o iframe só existe com o card na vista e zoom razoável ──
  function naVista(el) {
    const t = N.tamanho(), cam = N.camera();
    if (cam.zoom < ZOOM_CARGA) return false;
    try { if (!W.estado().ativo) return false; } catch {}
    const b = N.caixaMundo(el), a = N.mundoParaTela(b.x, b.y), z = N.mundoParaTela(b.x + b.w, b.y + b.h);
    return z.sx > 0 && a.sx < t.w && z.sy > 0 && a.sy < t.h;
  }
  function avaliar(no, el) {
    const w = no._w;
    if (!w.vivo || !el) return;
    if (naVista(el)) {
      clearTimeout(w.timerDesc); w.timerDesc = 0;
      if (w.estado === 'resumo' && w.url) carregar(no, false);
    } else if (w.iframe && !w.timerDesc && INT.id !== el.id) {
      w.timerDesc = setTimeout(() => {
        w.timerDesc = 0;
        const e = N.elemento(no._id);
        if (!w.vivo || !w.iframe || (e && naVista(e)) || INT.id === no._id) return;
        w.seq++; removerIframe(no); setEstado(no, 'resumo');
      }, DESCARGA);
    }
  }
  function pintar(no, el) {
    if (!no || !el || !ehWeb(el)) return;
    const w = no._w, url = el.web.url;
    const t = tituloDe(el);
    const tit = q(no, '.wb-web-tit');
    if (tit.textContent !== t) { tit.textContent = t; }
    tit.title = url;
    if (w.url !== url) {
      w.url = url; w.seq++;
      removerIframe(no);
      q(no, '.wb-web-resumo-host').textContent = hostDe(url) || url;
      if (validar(url).erro) telaAviso(no, { estado: estadoInvalido(url) }, url); // nunca vira iframe
      else setEstado(no, 'resumo');
    }
    avaliar(no, el);
  }
  function marcarSelecao() {
    const sel = new Set(N.selecao());
    for (const el of webs()) { const no = noDe(el); if (no) no.classList.toggle('wb-web-sel', sel.has(el.id)); }
  }
  function reavaliarTodos() {
    for (const el of webs()) { const no = noDe(el); if (no && no._w) avaliar(no, el); }
  }
  let rafAv = 0;
  const pedirAvaliar = () => { if (rafAv) return; rafAv = requestAnimationFrame(() => { rafAv = 0; reavaliarTodos(); }); };

  W.registrarTipo('web', {
    html: {
      criar(el) { return montar(el); },
      atualizar(no, el) { pintar(no, el); no.classList.toggle('wb-web-sel', N.selecao().includes(el.id)); no.classList.toggle('wb-lig-trav', travadoEl(el)); },
      remover(no) { if (no._w) { no._w.vivo = false; removerIframe(no); } if (INT.id === no._id) sairInteracao(); },
    },
    // Duplo clique: no cabeçalho edita o endereço; no corpo liga a interação.
    editar(el) {
      if (!ehWeb(el) || (N.travado && N.travado(el))) return;
      const d = ultDuplo, noCab = d && performance.now() - d.t < 600 && emCabecalho(el, d.cx, d.cy);
      if (noCab) editarEndereco(el); else entrarInteracao(el.id);
    },
    aoRedimensionar(el, campos) {
      const ww = campos && campos.w != null ? campos.w : el.w, hh = campos && campos.h != null ? campos.h : el.h;
      const aj = {};
      if (Math.abs(ww) < MIN_W) aj.w = ww < 0 ? -MIN_W : MIN_W;
      if (Math.abs(hh) < MIN_H) aj.h = hh < 0 ? -MIN_H : MIN_H;
      return Object.keys(aj).length ? aj : undefined;
    },
  });

  // ── interação ──
  const INT = { id: null };
  function entrarInteracao(id) {
    const el = N.elemento(id);
    if (!ehWeb(el)) return false;
    if (INT.id && INT.id !== id) sairInteracao();
    fecharCampo();
    INT.id = id;
    N.selecionar([id]);
    const no = noDe(el);
    if (no) { no.classList.add('wb-web-int'); const b = q(no, '.wb-web-b-int'); b.setAttribute('aria-pressed', 'true'); b.title = 'Sair da interação (Esc)'; }
    return true;
  }
  function sairInteracao() {
    const id = INT.id;
    INT.id = null;
    const el = id && N.elemento(id), no = el && noDe(el);
    if (no) { no.classList.remove('wb-web-int'); const b = q(no, '.wb-web-b-int'); b.setAttribute('aria-pressed', 'false'); b.title = 'Interagir com a página'; }
    for (const n of document.querySelectorAll('.wb-web.wb-web-int')) n.classList.remove('wb-web-int');
    try { const p = palco(); if (p) p.focus({ preventScroll: true }); } catch {}
  }
  document.addEventListener('pointerdown', (e) => {
    if (!INT.id) return;
    const el = N.elemento(INT.id), no = el && noDe(el);
    if (no && no.contains(e.target)) return;
    sairInteracao();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !INT.id) return;
    e.preventDefault(); e.stopPropagation();
    sairInteracao();
  }, true);
  // Como o iframe só recebe eventos quando o card está em interação, o clique no palco já o tira de lá (pointerdown acima);
  // o clique dentro do iframe não chega ao documento — por isso há o botão Interagir (alterna) e o Esc com o foco no quadro.

  // Posição do último duplo clique (capturado antes do núcleo) para separar cabeçalho de corpo.
  let ultDuplo = null;
  function emCabecalho(el, cx, cy) {
    const pl = palco();
    if (!pl) return false;
    const r = pl.getBoundingClientRect(), m = N.telaParaMundo(cx - r.left, cy - r.top);
    const ang = +el.angulo || 0, c = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
    const dx = m.x - c.x, dy = m.y - c.y, co = Math.cos(-ang), si = Math.sin(-ang);
    const ly = dx * si + dy * co + el.h / 2;
    return ly >= 0 && ly <= HCAB;
  }

  // ── campo flutuante de endereço (espaço de tela, dentro do palco) ──
  const CAMPO = { no: null, modo: null };
  function fecharCampo() {
    const c = CAMPO.no;
    CAMPO.no = null; CAMPO.modo = null;
    if (c && c.parentNode) c.remove();
  }
  // opcoes: { sx, sy (px no palco), largura, valor, rotulo, aoConfirmar(href) }
  function abrirCampo(o) {
    const pl = palco();
    if (!pl) return null;
    fecharCampo();
    const c = h('div', 'wb-web-campo');
    c.setAttribute('role', 'dialog'); c.setAttribute('aria-label', o.rotulo);
    const inp = h('input', 'wb-web-campo-in');
    inp.type = 'text'; inp.spellcheck = false; inp.autocomplete = 'off'; inp.placeholder = 'Endereço do site, como exemplo.com';
    inp.setAttribute('aria-label', o.rotulo); inp.value = o.valor || '';
    const dica = h('div', 'wb-web-campo-dica', 'Enter confirma · Esc cancela');
    c.append(inp, dica);
    for (const t of ['pointerdown', 'dblclick', 'wheel', 'contextmenu']) c.addEventListener(t, (e) => { e.stopPropagation(); });
    inp.addEventListener('input', () => { c.removeAttribute('data-erro'); dica.textContent = 'Enter confirma · Esc cancela'; });
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); fecharCampo(); try { pl.focus({ preventScroll: true }); } catch {} return; }
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      const v = validar(inp.value);
      if (v.erro) { c.dataset.erro = '1'; dica.textContent = v.erro; return; }
      fecharCampo();
      try { pl.focus({ preventScroll: true }); } catch {}
      o.aoConfirmar(v.href);
    });
    const t = N.tamanho(), larg = Math.max(220, Math.min(o.largura || 320, t.w - 16));
    c.style.width = larg + 'px';
    c.style.left = Math.round(Math.max(8, Math.min(t.w - larg - 8, o.sx))) + 'px';
    c.style.top = Math.round(Math.max(8, Math.min(t.h - 72, o.sy))) + 'px';
    pl.append(c);
    CAMPO.no = c; CAMPO.modo = o.modo;
    inp.focus(); inp.select();
    return c;
  }
  document.addEventListener('pointerdown', (e) => { if (CAMPO.no && !CAMPO.no.contains(e.target)) fecharCampo(); }, true);

  function editarEndereco(el) {
    if (!ehWeb(el)) return false;
    if (N.travado && N.travado(el)) return false;
    const a = N.mundoParaTela(el.x, el.y), z = N.camera().zoom;
    const id = el.id;
    return !!abrirCampo({
      modo: 'editar', rotulo: 'Editar endereço', valor: el.web.url, sx: a.sx + 8, sy: a.sy + 4, largura: Math.max(320, (el.w - 16) * z),
      aoConfirmar(href) {
        const e = N.elemento(id);
        if (!e || href === e.web.url) return;
        N.atualizar(id, { web: { ...e.web, url: href, titulo: '' } });
        N.confirmar('Navegador');
      },
    });
  }

  // ── criar ──
  function adicionar(url, x, y) {
    if (!W.quadro()) return null;
    const v = validar(url);
    if (v.erro) { avisar(v.erro); return null; }
    const el = N.adicionar({ tipo: 'web', x: x - LARG / 2, y: y - ALT / 2, w: LARG, h: ALT, angulo: 0, cor: '#e5e5e5', traco: { largura: 2, estilo: 'solido' }, preenchimento: null, opacidade: 1, web: { url: v.href, titulo: '' } });
    if (N.ferramenta() !== 'selecionar') N.definirFerramenta('selecionar');
    N.selecionar([el.id]);
    N.confirmar('Navegador');
    return el.id;
  }
  function pedirEndereco(x, y) {
    if (!W.quadro() || !palco()) return false;
    const a = N.mundoParaTela(+x || 0, +y || 0);
    return !!abrirCampo({ modo: 'novo', rotulo: 'Novo card de site', valor: '', sx: a.sx, sy: a.sy, largura: 340, aoConfirmar: (href) => { adicionar(href, +x || 0, +y || 0); } });
  }

  // ── palco: soltar link, duplo clique, observador ──
  let ligado = null;
  const temLink = (e) => { try { const t = [...e.dataTransfer.types]; return t.includes('text/uri-list') && !t.includes('application/x-orbit-sessao'); } catch { return false; } };
  function ligarPalco() {
    const pl = palco();
    if (!pl || ligado === pl) return;
    ligado = pl;
    const realce = (on) => pl.classList.toggle('wb-web-alvo', on);
    const aceitar = (e) => { if (!temLink(e)) return; e.preventDefault(); try { e.dataTransfer.dropEffect = 'link'; } catch {} realce(true); };
    pl.addEventListener('dragenter', aceitar);
    pl.addEventListener('dragover', aceitar);
    pl.addEventListener('dragleave', (e) => { if (e.relatedTarget && pl.contains(e.relatedTarget)) return; realce(false); });
    document.addEventListener('dragend', () => realce(false));
    pl.addEventListener('drop', (e) => {
      realce(false);
      if (!temLink(e)) return;
      e.preventDefault();
      let txt = '';
      try { txt = e.dataTransfer.getData('text/uri-list') || ''; } catch {}
      const linha = txt.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('#'));
      if (!linha) return;
      const r = pl.getBoundingClientRect(), m = N.telaParaMundo(e.clientX - r.left, e.clientY - r.top);
      adicionar(linha, m.x, m.y);
      try { pl.focus({ preventScroll: true }); } catch {}
    });
    pl.addEventListener('dblclick', (e) => { ultDuplo = { t: performance.now(), cx: e.clientX, cy: e.clientY }; }, true);
  }

  // Descarrega TODOS os iframes (sair da vista / trocar de quadro): nada de vídeo tocando ou página viva fora de uso.
  function descarregarTodos() {
    sairInteracao();
    const c = N.camadaHtml();
    if (!c) return;
    for (const no of c.querySelectorAll('.wb-web')) {
      const w = no._w;
      if (!w) continue;
      if (w.iframe || w.estado === 'checando') { w.seq++; removerIframe(no); setEstado(no, 'resumo'); }
    }
  }
  N.on('ativo', (d) => { if (d && d.ativo) pedirAvaliar(); else descarregarTodos(); });
  N.on('quadro', () => { sairInteracao(); fecharCampo(); descarregarTodos(); ligarPalco(); requestAnimationFrame(() => { marcarSelecao(); pedirAvaliar(); }); });
  N.on('camera', () => { if (CAMPO.no) fecharCampo(); pedirAvaliar(); });
  N.on('selecao', (ids) => {
    if (INT.id && !(ids.length === 1 && ids[0] === INT.id)) sairInteracao();
    requestAnimationFrame(marcarSelecao);
  });
  N.on('mudanca', (d) => {
    if (INT.id && !N.elemento(INT.id)) sairInteracao();
    requestAnimationFrame(() => { marcarSelecao(); pedirAvaliar(); });
  });
  ligarPalco();

  // ═══════════════ Ligação card de site ↔ card de agente (ajustes, entrega E) ═══════════════
  // Dado: el.web.agentes = [{ id: <sessão>, avisadoEm: ms | null }] (ausente = sem ligações). A linha é DERIVADA (não é elemento):
  // aparece só quando o card de agente com sessao.id === id está no quadro; apagar um dos cards a esconde sem mexer nos dados
  // (o desfazer traz tudo de volta). Desenho: <svg> na camada HTML sob os cards (z-index -1) + um "plug" no meio acima deles.
  // Ligar = atualizar + confirmar('Ligar') e depois POST /sessao/<id>/mensagem { texto, prioridade: 'next' } ("avisar ao ligar").
  // Desfazer/refazer/carregar/colar/duplicar NUNCA enviam nada. avisadoEm é gravado em silêncio (sem passo de histórico).
  // A cópia (colar/duplicar) não leva as ligações: mudanca 'adicionar' limpa web.agentes do card recém-criado.
  // API: Whiteboard.ligacao = { ligar, desligar, reenviar, escolher, cancelar, escolhendo, doWeb, doAgente, focarWeb, linhas, geometria }.
  const travadoEl = (e) => !!(e && N.travado && N.travado(e));
  const ligs = (el) => {
    const a = el && el.web && Array.isArray(el.web.agentes) ? el.web.agentes : [];
    const vistos = new Set(), r = [];
    for (const l of a) { if (l && typeof l.id === 'string' && l.id && !vistos.has(l.id)) { vistos.add(l.id); r.push({ id: l.id, avisadoEm: Number.isFinite(l.avisadoEm) ? l.avisadoEm : null }); } }
    return r;
  };
  const agentePorSessao = (id) => N.elementos().find((e) => e.tipo === 'agente' && e.sessao && e.sessao.id === id) || null;
  const agenteValido = (e) => !!e && e.tipo === 'agente' && !!e.sessao && !!e.sessao.id;
  function obterSessao(id) {
    const f = window.OrbitFonteSessoes;
    if (!f || typeof f.obter !== 'function' || !id) return null;
    try { return f.obter(id) || null; } catch { return null; }
  }
  function nomeSessao(id) {
    const r = obterSessao(id), ag = agentePorSessao(id);
    return (r && r.nome) || (ag && ag.sessao.resumo && ag.sessao.resumo.nome) || 'a sessão';
  }

  // ── aviso flutuante (texto + ação opcional) ──
  const TOAST = { no: null, t: 0, fixo: false };
  function toast(txt, acao, fixo) {
    const pl = palco(), pai = pl && pl.parentNode;
    if (!pai) return;
    if (!TOAST.no || !TOAST.no.isConnected) { TOAST.no = h('div', 'wb-lig-toast'); TOAST.no.setAttribute('role', 'status'); pai.append(TOAST.no); }
    const n = TOAST.no;
    n.replaceChildren(h('span', 'wb-lig-toast-t', txt));
    if (acao) { const b = h('button', 'wb-lig-toast-b', acao.rotulo); b.type = 'button'; b.addEventListener('click', () => { fecharToast(); acao.fn(); }); n.append(b); }
    n.hidden = false; TOAST.fixo = !!fixo;
    clearTimeout(TOAST.t);
    if (!fixo) TOAST.t = setTimeout(fecharToast, acao ? 9000 : 5000);
  }
  function fecharToast() { clearTimeout(TOAST.t); TOAST.fixo = false; if (TOAST.no) TOAST.no.hidden = true; }

  // ── gravar sem passo de histórico: reaplica a câmera (o salvamento leva os elementos junto), como o módulo de agentes ──
  let marcaT = 0, marcando = false, ultCam = 0;
  function marcarGravar(ms = 300) {
    if (marcaT) return;
    marcaT = setTimeout(() => {
      marcaT = 0;
      if (!W.quadro()) return;
      if (performance.now() - ultCam < 500) { marcarGravar(600); return; }
      marcando = true;
      try { N.definirCamera(N.camera(), { animar: false }); } finally { marcando = false; }
    }, ms);
  }
  N.on('camera', () => { if (!marcando) ultCam = performance.now(); });
  function gravarAviso(webId, sessaoId, ms) {
    const el = N.elemento(webId), reg = el && el.web && Array.isArray(el.web.agentes) && el.web.agentes.find((l) => l && l.id === sessaoId);
    if (!reg) return false;
    reg.avisadoEm = ms; marcarGravar();
    return true;
  }

  // ── aviso à sessão ──
  const textoAviso = (el) => `Ferramenta fixa ligada no Whiteboard do Orbit: ${el.web.titulo || hostDe(el.web.url) || el.web.url} — ${el.web.url}. Use este site como referência nesta tarefa quando fizer sentido (você pode ler a página com WebFetch).`;
  async function avisarSessao(webId, sessaoId) {
    let el = N.elemento(webId);
    if (!ehWeb(el)) return 'invalido';
    const nome = nomeSessao(sessaoId);
    if (!obterSessao(sessaoId)) { gravarAviso(webId, sessaoId, null); toast('Sessão encerrada: ligação só visual'); return 'encerrada'; }
    const tentar = () => { avisarSessao(webId, sessaoId); };
    let r = null, corpo = null;
    try {
      r = await fetch('/sessao/' + encodeURIComponent(sessaoId) + '/mensagem', { method: 'POST', headers: CAB, body: JSON.stringify({ texto: textoAviso(el), prioridade: 'next' }) });
      try { corpo = await r.json(); } catch {}
    } catch { r = null; }
    el = N.elemento(webId);
    if (!ehWeb(el) || !ligs(el).some((l) => l.id === sessaoId)) return 'desfeita'; // desligou/desfez enquanto o pedido voltava
    if (r && r.ok) { gravarAviso(webId, sessaoId, Date.now()); toast('Aviso enviado a ' + nome); return 'enviado'; }
    if (r && r.status === 409 && corpo && (corpo.codigo === 'nao_assumida' || corpo.erro === 'nao_assumida')) {
      gravarAviso(webId, sessaoId, null);
      toast(`Ligado, mas ${nome} não recebe mensagens do Orbit (abra pelo Orbit ou assuma a sessão)`);
      return 'nao_assumida';
    }
    toast(`Não deu para avisar ${nome}` + (corpo && corpo.erro && corpo.erro !== 'nao_assumida' ? ` (${corpo.erro})` : ''), { rotulo: 'Tentar de novo', fn: tentar });
    return 'erro';
  }

  // ── ligar / desligar ──
  function ligar(webId, sessaoId) {
    const el = N.elemento(webId), ag = agentePorSessao(sessaoId);
    if (!ehWeb(el) || !ag) return 'invalido';
    if (travadoEl(el) || travadoEl(ag)) { toast('Card travado: destrave para ligar'); return 'travado'; }
    const lista = ligs(el);
    if (lista.some((l) => l.id === sessaoId)) { toast('Este site já está ligado a ' + nomeSessao(sessaoId)); return 'duplicada'; }
    N.atualizar(webId, { web: { ...el.web, agentes: [...lista, { id: sessaoId, avisadoEm: null }] } });
    N.confirmar('Ligar');
    avisarSessao(webId, sessaoId);
    return 'ligado';
  }
  function desligar(webId, sessaoId) {
    const el = N.elemento(webId), ag = agentePorSessao(sessaoId);
    if (!ehWeb(el) || !ligs(el).some((l) => l.id === sessaoId)) return false;
    if (travadoEl(el) || travadoEl(ag)) { toast('Card travado: destrave para desligar'); return false; }
    N.atualizar(webId, { web: { ...el.web, agentes: ligs(el).filter((l) => l.id !== sessaoId) } });
    N.confirmar('Desligar');
    return true;
  }
  function reenviar(webId, sessaoId) {
    const el = N.elemento(webId);
    if (!ehWeb(el) || !ligs(el).some((l) => l.id === sessaoId)) return Promise.resolve('invalido');
    return avisarSessao(webId, sessaoId);
  }
  function tentarAlvo(webId, alvo) { // alvo = elemento sob o ponteiro (ou null); usado pelo arrasto e pelo modo de escolha
    if (agenteValido(alvo)) return ligar(webId, alvo.sessao.id);
    if (alvo && (alvo.tipo === 'subagente' || alvo.tipo === 'time')) { toast('Só cards de agente (sessões) aceitam ligação'); return 'recusado'; }
    return null;
  }

  // ── geometria (compartilhada com a exportação) ──
  function geometria(w, a) {
    const bw = N.caixaMundo(w), ba = N.caixaMundo(a);
    let x0, y0, x1, y1, c1, c2;
    if (bw.x + bw.w < ba.x || ba.x + ba.w < bw.x) {
      const dir = bw.x + bw.w < ba.x;
      x0 = dir ? bw.x + bw.w : bw.x; x1 = dir ? ba.x : ba.x + ba.w; y0 = bw.y + bw.h / 2; y1 = ba.y + ba.h / 2;
      const dx = Math.max(40, Math.abs(x1 - x0) * 0.5) * (dir ? 1 : -1);
      c1 = [x0 + dx, y0]; c2 = [x1 - dx, y1];
    } else {
      const baixo = bw.y + bw.h / 2 <= ba.y + ba.h / 2;
      x0 = bw.x + bw.w / 2; x1 = ba.x + ba.w / 2; y0 = baixo ? bw.y + bw.h : bw.y; y1 = baixo ? ba.y : ba.y + ba.h;
      const dy = Math.max(40, Math.abs(y1 - y0) * 0.5) * (baixo ? 1 : -1);
      c1 = [x0, y0 + dy]; c2 = [x1, y1 - dy];
    }
    const r = (n) => Math.round(n * 100) / 100;
    return { d: `M${r(x0)} ${r(y0)} C${r(c1[0])} ${r(c1[1])} ${r(c2[0])} ${r(c2[1])} ${r(x1)} ${r(y1)}`,
      mx: (x0 + 3 * c1[0] + 3 * c2[0] + x1) / 8, my: (y0 + 3 * c1[1] + 3 * c2[1] + y1) / 8 };
  }
  // Ligações visíveis: [{ web, agente, sessao, d, mx, my }] (só quando os dois cards existem). ids (opcional) limita aos cards dessa lista.
  function linhasLig(ids) {
    const ok = ids ? new Set(ids) : null, r = [];
    for (const w of webs()) {
      for (const l of ligs(w)) {
        const a = agentePorSessao(l.id);
        if (!a || (ok && !(ok.has(w.id) && ok.has(a.id)))) continue;
        try { r.push({ web: w.id, agente: a.id, sessao: l.id, ...geometria(w, a) }); } catch {}
      }
    }
    return r;
  }

  // ── desenho (SVG sob os cards + plugs) ──
  const SV = { svg: null, plugs: null, fio: null };
  function camadas() {
    const c = N.camadaHtml();
    if (!c) return false;
    if (!SV.svg || SV.svg.parentNode !== c) {
      SV.svg = document.createElementNS(NS, 'svg');
      SV.svg.setAttribute('class', 'wb-lig-svg'); SV.svg.setAttribute('width', '1'); SV.svg.setAttribute('height', '1'); SV.svg.setAttribute('aria-hidden', 'true');
      SV.plugs = h('div', 'wb-lig-plugs');
      SV.fio = null;
      c.append(SV.svg, SV.plugs);
    }
    return true;
  }
  const chaveLig = (l) => l.web + '|' + l.sessao;
  function desenharLig() {
    if (!camadas()) return;
    const ls = linhasLig(), vivos = new Set(ls.map(chaveLig));
    for (const n of [...SV.svg.querySelectorAll('.wb-lig-linha')]) if (!vivos.has(n.dataset.chave)) n.remove();
    for (const n of [...SV.plugs.children]) if (!vivos.has(n.dataset.chave)) n.remove();
    const sel = new Set(N.selecao());
    for (const l of ls) {
      const k = chaveLig(l);
      let p = [...SV.svg.querySelectorAll('.wb-lig-linha')].find((n) => n.dataset.chave === k);
      if (!p) { p = document.createElementNS(NS, 'path'); p.setAttribute('class', 'wb-lig-linha'); p.dataset.chave = k; p.dataset.web = l.web; p.dataset.sessao = l.sessao; SV.svg.insertBefore(p, SV.fio); }
      p.setAttribute('d', l.d);
      p.classList.toggle('wb-lig-destaque', sel.has(l.web) || sel.has(l.agente));
      let g = [...SV.plugs.children].find((n) => n.dataset.chave === k);
      if (!g) { g = h('div', 'wb-lig-plug'); g.dataset.chave = k; g.dataset.web = l.web; g.dataset.sessao = l.sessao; g.append(icone('plug', 13)); SV.plugs.append(g); }
      g.style.transform = `translate(${l.mx - 11}px, ${l.my - 11}px)`;
      g.title = 'Ligação: ' + tituloDe(N.elemento(l.web)) + ' ↔ ' + nomeSessao(l.sessao);
    }
  }
  let rafLig = 0;
  const pedirLig = () => { if (rafLig) return; rafLig = requestAnimationFrame(() => { rafLig = 0; try { desenharLig(); } catch (e) { console.warn('whiteboard-web: ligação', e); } }); };
  function fioTemp(webId, x, y) { // linha provisória do arrasto (mundo)
    if (!camadas()) return;
    const w = N.elemento(webId); if (!w) return;
    const b = N.caixaMundo(w), x0 = b.x + b.w + 14, y0 = b.y + b.h / 2, dx = Math.max(40, Math.abs(x - x0) * 0.5);
    if (!SV.fio) { SV.fio = document.createElementNS(NS, 'path'); SV.fio.setAttribute('class', 'wb-lig-fio'); SV.svg.append(SV.fio); }
    SV.fio.setAttribute('d', `M${x0} ${y0} C${x0 + dx} ${y0} ${x - dx} ${y} ${x} ${y}`);
  }
  function limparFio() { if (SV.fio) { SV.fio.remove(); SV.fio = null; } }

  // ── arrastar a alça "plug" (ou modo de escolha pelo menu) ──
  const ARR = { webId: null, pid: null, alvo: null };
  const ESCOLHA = { webId: null };
  const pontoMundo = (e) => { const r = palco().getBoundingClientRect(); return N.telaParaMundo(e.clientX - r.left, e.clientY - r.top); };
  function marcarAlvo(el) {
    const id = el && agenteValido(el) && !travadoEl(el) ? el.id : null;
    if (ARR.alvo === id) return;
    const c = N.camadaHtml();
    if (c) for (const n of c.querySelectorAll('.wb-lig-alvo')) n.classList.remove('wb-lig-alvo');
    ARR.alvo = id;
    const no = id && noDe(el); if (no) no.classList.add('wb-lig-alvo');
  }
  function fimArrasto() {
    ARR.webId = null; ARR.pid = null; marcarAlvo(null); limparFio();
    document.removeEventListener('pointermove', moverArrasto, true);
    document.removeEventListener('pointerup', soltarArrasto, true);
    document.removeEventListener('pointercancel', cancelarArrasto, true);
    const p = palco(); if (p) p.classList.remove('wb-lig-arrastando');
  }
  function moverArrasto(e) {
    if (!ARR.webId || (ARR.pid != null && e.pointerId !== ARR.pid)) return;
    const m = pontoMundo(e);
    fioTemp(ARR.webId, m.x, m.y);
    marcarAlvo(N.elementoEm(m.x, m.y));
  }
  function soltarArrasto(e) {
    if (!ARR.webId || (ARR.pid != null && e.pointerId !== ARR.pid)) return;
    const webId = ARR.webId, m = pontoMundo(e), alvo = N.elementoEm(m.x, m.y);
    e.preventDefault(); e.stopPropagation();
    fimArrasto();
    tentarAlvo(webId, alvo);
  }
  function cancelarArrasto() { if (ARR.webId) fimArrasto(); }
  function iniciarArrasto(e, webId) {
    const el = N.elemento(webId);
    if (e.button !== 0 || !ehWeb(el)) return;
    e.stopPropagation(); e.preventDefault();
    if (travadoEl(el)) { toast('Card travado: destrave para ligar'); return; }
    cancelarEscolha(); fecharCampo();
    ARR.webId = webId; ARR.pid = e.pointerId;
    document.addEventListener('pointermove', moverArrasto, true);
    document.addEventListener('pointerup', soltarArrasto, true);
    document.addEventListener('pointercancel', cancelarArrasto, true);
    const p = palco(); if (p) p.classList.add('wb-lig-arrastando');
    moverArrasto(e);
  }

  function escolher(webId) {
    const el = N.elemento(webId);
    if (!ehWeb(el) || !palco()) return false;
    if (travadoEl(el)) { toast('Card travado: destrave para ligar'); return false; }
    cancelarArrasto(); cancelarEscolha();
    ESCOLHA.webId = webId;
    palco().classList.add('wb-lig-escolhendo');
    toast('Clique num card de agente · Esc cancela', null, true);
    return true;
  }
  function cancelarEscolha() {
    if (!ESCOLHA.webId) return false;
    ESCOLHA.webId = null;
    const p = palco(); if (p) p.classList.remove('wb-lig-escolhendo');
    if (TOAST.fixo) fecharToast();
    return true;
  }
  document.addEventListener('pointerdown', (e) => {
    if (!ESCOLHA.webId) return;
    const pl = palco();
    if (!pl || !pl.contains(e.target) || e.button !== 0) { cancelarEscolha(); return; }
    e.preventDefault(); e.stopPropagation();
    const webId = ESCOLHA.webId, m = pontoMundo(e), alvo = N.elementoEm(m.x, m.y);
    cancelarEscolha();
    tentarAlvo(webId, alvo);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !(ESCOLHA.webId || ARR.webId)) return;
    e.preventDefault(); e.stopPropagation();
    cancelarEscolha(); cancelarArrasto();
  }, true);

  // ── alça nos cards (hover: o nó não recebe ponteiro, então o palco acompanha o mouse) ──
  let hoverId = null, rafHov = 0;
  function atualizarHover(cx, cy) {
    const pl = palco(); if (!pl || ARR.webId) return;
    const r = pl.getBoundingClientRect(), m = N.telaParaMundo(cx - r.left, cy - r.top), e = N.elementoEm(m.x, m.y);
    const id = ehWeb(e) ? e.id : null;
    if (id === hoverId) return;
    const a = hoverId && N.elemento(hoverId), na = a && noDe(a); if (na) na.classList.remove('wb-lig-hover');
    hoverId = id;
    const nb = id && noDe(e); if (nb) nb.classList.add('wb-lig-hover');
  }
  function ligarHover() {
    const pl = palco(); if (!pl || pl._ligHover) return;
    pl._ligHover = true;
    pl.addEventListener('pointermove', (e) => { const cx = e.clientX, cy = e.clientY; if (rafHov) return; rafHov = requestAnimationFrame(() => { rafHov = 0; atualizarHover(cx, cy); }); });
    pl.addEventListener('pointerleave', () => { const a = hoverId && N.elemento(hoverId), na = a && noDe(a); if (na) na.classList.remove('wb-lig-hover'); hoverId = null; });
  }
  function criarAlca(no) {
    const b = botao('wb-lig-alca', 'Arraste até um card de agente para ligar', 'plug');
    b.addEventListener('pointerdown', (e) => iniciarArrasto(e, no._id));
    for (const t of ['dblclick', 'click', 'contextmenu']) b.addEventListener(t, (e) => e.stopPropagation());
    no.append(b);
  }

  // ── eventos do núcleo ──
  N.on('mudanca', (d) => {
    if (d && d.tipo === 'adicionar') for (const id of d.ids || []) { const e = N.elemento(id); if (ehWeb(e) && Array.isArray(e.web.agentes) && e.web.agentes.length) e.web.agentes = []; } // cópia sem ligações
    pedirLig();
  });
  N.on('quadro', () => { cancelarEscolha(); cancelarArrasto(); ligarHover(); pedirLig(); });
  N.on('selecao', pedirLig);
  N.on('camera', pedirLig);
  ligarHover(); pedirLig();

  function doWeb(webId) {
    const el = N.elemento(webId);
    return ehWeb(el) ? ligs(el).map((l) => ({ sessao: l.id, nome: nomeSessao(l.id), avisadoEm: l.avisadoEm, noQuadro: !!agentePorSessao(l.id) })) : [];
  }
  function doAgente(agId) {
    const ag = N.elemento(agId), sid = ag && ag.tipo === 'agente' && ag.sessao && ag.sessao.id;
    if (!sid) return [];
    return webs().filter((w) => ligs(w).some((l) => l.id === sid)).map((w) => ({ web: w.id, titulo: w.web.titulo || hostDe(w.web.url) || w.web.url, url: w.web.url }));
  }
  function focarWeb(id) {
    const el = N.elemento(id);
    if (!ehWeb(el)) return false;
    const b = N.caixaMundo(el), t = N.tamanho(), z = N.camera().zoom;
    N.selecionar([id]);
    N.definirCamera({ x: b.x + b.w / 2 - t.w / 2 / z, y: b.y + b.h / 2 - t.h / 2 / z, zoom: z }, { animar: true });
    return true;
  }
  W.estender('ligacao', Object.freeze({ ligar, desligar, reenviar, escolher, cancelar: () => { cancelarEscolha(); cancelarArrasto(); }, escolhendo: () => !!ESCOLHA.webId, doWeb, doAgente, focarWeb, linhas: linhasLig, geometria }));

  W.estender('web', Object.freeze({
    adicionar: (url, x, y) => adicionar(url, +x || 0, +y || 0),
    pedirEndereco,
    abrirExterno: (id) => { const e = N.elemento(id); if (!ehWeb(e)) return false; abrirFora(e.web.url); return true; },
    editarEndereco: (id) => editarEndereco(N.elemento(id)),
  }));
})();
