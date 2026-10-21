// Orbit — navegador interno numa aba (16/10). Expõe window.Navegador. Servidor: navegador.mjs.
// A página fica num iframe isolado (sandbox sem navegação do topo). Antes de abrir, o servidor confere se o endereço
// responde e se aceita ser embutido; se não aceitar, a aba mostra a mensagem com "Abrir no navegador".
// Limite conhecido (sem proxy): o Orbit não lê o endereço nem o título da página embutida, então Voltar, Avançar e
// Recarregar valem para os endereços abertos pela barra, e os cliques dentro da página não mudam a barra.
// Sem dependências. Dado de fora entra só por textContent/atributos.
(() => {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const MAX_HIST = 30;
  const TEMPO_CARGA = 20000;    // a barra de progresso some depois disso, mesmo sem o "load"
  const REPETIR_LOCAL = 3000;   // servidor local fora do ar: tenta de novo enquanto a aba está à vista
  const REPETIR_MAX = 10 * 60 * 1000;
  const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation';
  const PERMITIR = 'clipboard-read; clipboard-write; fullscreen; autoplay; display-capture; web-share';

  function el(tag, cls, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    return n;
  }
  function txt(tag, cls, t) { const n = el(tag, cls); n.textContent = t; return n; }
  // Ícones fixos (traços constantes, nunca dado), no traço dos ícones das abas.
  const ICONES = {
    voltar: ['M9.5 3.5L5 8l4.5 4.5'],
    avancar: ['M6.5 3.5L11 8l-4.5 4.5'],
    recarregar: ['M12.5 8a4.5 4.5 0 1 1-1.4-3.3', 'M12.5 2.8v2.6H9.9'],
    parar: ['M4.5 4.5l7 7M11.5 4.5l-7 7'],
    fora: ['M9 3h4v4', 'M13 3L7.5 8.5', 'M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5'],
    globo: ['M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11z', 'M2.5 8h11', 'M8 2.5c1.6 1.5 2.4 3.3 2.4 5.5S9.6 12 8 13.5C6.4 12 5.6 10.2 5.6 8S6.4 4 8 2.5z'],
    local: ['M2.5 3.5h11v7h-11z', 'M6 13h4', 'M8 10.5V13'],
    cadeado: ['M4.5 7.5h7v5h-7z', 'M6 7.5V6a2 2 0 0 1 4 0v1.5'],
    aviso: ['M8 2.8l5.6 9.7H2.4z', 'M8 6.6v2.6', 'M8 11h0'],
    desligado: ['M8 2.5v5', 'M4.6 4.6a4.8 4.8 0 1 0 6.8 0'],
  };
  function icone(nome, tam = 16) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', tam); s.setAttribute('height', tam); s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.3');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    for (const d of ICONES[nome] || []) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p); }
    return s;
  }

  // ───────── endereços ─────────
  function normalizar(bruto) {
    if (typeof bruto !== 'string') return null;
    let s = bruto.trim();
    if (!s || s.length > 2048 || /[\u0000-\u001f]/.test(s)) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:/]+:\d/.test(s)) return null; // javascript:, file:, data:…
      if (/^\d{2,5}$/.test(s)) s = 'localhost:' + s; // "5173" → localhost:5173
      s = 'http://' + s;
    }
    let u;
    try { u = new URL(s); } catch { return null; }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
    return u.href;
  }
  function ehLocal(href) {
    try {
      const h = new URL(href).hostname.toLowerCase();
      return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
    } catch { return false; }
  }
  // O próprio Orbit (auditoria P2-4): o iframe tem allow-scripts + allow-same-origin, então nunca recebe um endereço
  // local na porta desta página, mesmo sem a conferência do servidor (que também recusa a porta do celular).
  function doOrbit(href) {
    try {
      const u = new URL(href);
      const h = u.hostname.toLowerCase();
      const porta = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
      return (ehLocal(href) || h === '0.0.0.0' || h === '[::]') && porta === Number(location.port || (location.protocol === 'https:' ? 443 : 80));
    } catch { return true; }
  }
  // Mostrar na barra: sem o "http://" e sem a barra final sozinha.
  function legivel(href) {
    if (!href) return '';
    try {
      const u = new URL(href);
      let s = (u.protocol === 'https:' ? 'https://' : '') + u.host + (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
      return s;
    } catch { return href; }
  }
  function titulo(dados) {
    const url = dados && dados.url;
    if (!url) return 'Nova aba';
    try {
      const u = new URL(url);
      const cam = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
      return u.host + (cam ? ' ' + decodeURIComponent(cam.split('/').pop()) : '');
    } catch { return url; }
  }
  const mesmaPagina = (a, b) => { try { const x = new URL(a), y = new URL(b); x.hash = ''; y.hash = ''; return x.href === y.href; } catch { return a === b; } };

  // Textos das mensagens por estado da conferência.
  function mensagem(r, href) {
    let host = '';
    try { host = new URL(href).host; } catch {}
    switch (r.estado) {
      case 'bloqueado': return {
        ic: 'cadeado', tit: 'Este site não abre dentro do Orbit',
        p: host + ' não permite ser exibido dentro de outra página' + (r.bloqueio === 'frame-ancestors' ? ' (CSP frame-ancestors).' : ' (X-Frame-Options).'),
        forcar: true,
      };
      case 'fora-do-ar': return {
        ic: 'desligado', tit: 'Nada respondendo em ' + host,
        p: r.local ? 'O servidor do projeto pode estar parado ou ainda subindo. A aba tenta de novo sozinha.' : 'O servidor recusou a conexão.',
      };
      case 'nao-encontrado': return { ic: 'aviso', tit: 'Endereço não encontrado', p: 'Não deu para achar ' + host + '. Confira o endereço.' };
      case 'sem-resposta': return { ic: 'aviso', tit: host + ' não respondeu', p: 'A página demorou demais para responder.', forcar: true };
      case 'certificado': return { ic: 'cadeado', tit: 'Certificado não confiável', p: 'O certificado de ' + host + ' não foi aceito. Abra no navegador para ver os detalhes.', forcar: true };
      case 'orbit': return { ic: 'aviso', tit: 'Este é o próprio Orbit', p: 'O Orbit não abre dentro de si mesmo.' };
      case 'invalido': return { ic: 'aviso', tit: 'Endereço inválido', p: 'Use um endereço http:// ou https://, como localhost:5173.' };
      default: return { ic: 'aviso', tit: 'Não deu para abrir', p: 'A conferência do endereço falhou.', forcar: true };
    }
  }

  // ───────── a aba ─────────
  // op = { checar(url) → Promise<r|null>, externo(url), salvar(), inicio() → Promise<{ previas, rodando, outras }>,
  //        novaAba(url) }
  function criar(painel, aba, op = {}) {
    const d = aba.dados && typeof aba.dados === 'object' ? aba.dados : {};
    if (!Array.isArray(d.hist)) d.hist = d.url ? [d.url] : [];
    if (!Number.isInteger(d.pos) || d.pos < 0 || d.pos >= d.hist.length) d.pos = d.hist.length - 1;
    const st = { visivel: true, vivo: true, seq: 0, timerCarga: 0, timerRepetir: 0, repetirDesde: 0, estado: 'nada' };

    painel.classList.add('aba-web');
    const raiz = el('div', 'nav-raiz');
    const barra = el('div', 'nav-barra');
    const bVoltar = el('button', 'nav-btn', { type: 'button', title: 'Voltar', 'aria-label': 'Voltar' });
    const bAvancar = el('button', 'nav-btn', { type: 'button', title: 'Avançar', 'aria-label': 'Avançar' });
    const bRecarregar = el('button', 'nav-btn', { type: 'button', title: 'Recarregar', 'aria-label': 'Recarregar' });
    bVoltar.append(icone('voltar')); bAvancar.append(icone('avancar')); bRecarregar.append(icone('recarregar'));
    const caixa = el('label', 'nav-endereco');
    const icEnd = el('span', 'nav-end-ic', { 'aria-hidden': 'true' });
    const campo = el('input', 'nav-campo', {
      type: 'text', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', enterkeyhint: 'go',
      'aria-label': 'Endereço', placeholder: 'Digite um endereço, como localhost:5173',
    });
    caixa.append(icEnd, campo);
    const bFora = el('button', 'nav-btn', { type: 'button', title: 'Abrir no navegador', 'aria-label': 'Abrir no navegador' });
    bFora.append(icone('fora'));
    barra.append(bVoltar, bAvancar, bRecarregar, caixa, bFora);
    const prog = el('div', 'nav-prog', { 'aria-hidden': 'true' });
    const corpo = el('div', 'nav-corpo');
    const quadro = el('iframe', 'nav-quadro', { sandbox: SANDBOX, allow: PERMITIR, allowfullscreen: '', title: 'Página', referrerpolicy: 'strict-origin-when-cross-origin' });
    quadro.hidden = true;
    const aviso = el('div', 'nav-aviso', { role: 'status' });
    aviso.hidden = true;
    const inicio = el('div', 'nav-inicio');
    inicio.hidden = true;
    corpo.append(quadro, aviso, inicio);
    raiz.append(barra, prog, corpo);
    painel.append(raiz);

    const atual = () => (d.pos >= 0 ? d.hist[d.pos] : null);
    function salvar() { d.url = atual(); try { if (op.salvar) op.salvar(); } catch (e) { console.warn('navegador', e); } }
    function botoes() {
      bVoltar.disabled = d.pos <= 0;
      bAvancar.disabled = d.pos < 0 || d.pos >= d.hist.length - 1;
      bRecarregar.disabled = !atual();
      bFora.disabled = !atual();
      const carregando = st.estado === 'checando' || st.estado === 'carregando';
      bRecarregar.replaceChildren(icone(carregando ? 'parar' : 'recarregar'));
      bRecarregar.title = carregando ? 'Parar' : 'Recarregar';
      bRecarregar.setAttribute('aria-label', bRecarregar.title);
      const u = atual();
      icEnd.replaceChildren(icone(!u ? 'globo' : ehLocal(u) ? 'local' : u.startsWith('https:') ? 'cadeado' : 'globo', 14));
      caixa.classList.toggle('local', !!u && ehLocal(u));
    }
    function mostrarCampo() { if (document.activeElement !== campo) campo.value = legivel(atual()); }
    function progresso(liga) {
      clearTimeout(st.timerCarga);
      prog.classList.toggle('on', !!liga);
      if (liga) st.timerCarga = setTimeout(() => { prog.classList.remove('on'); if (st.estado === 'carregando') { st.estado = 'pronto'; botoes(); } }, TEMPO_CARGA);
    }
    function pararRepetir() { clearTimeout(st.timerRepetir); st.timerRepetir = 0; }

    function telaAviso(r, href) {
      const m = mensagem(r, href);
      if (quadro.getAttribute('src') && quadro.getAttribute('src') !== 'about:blank') quadro.src = 'about:blank'; // a página antiga não segue rodando por trás
      quadro.hidden = true;
      inicio.hidden = true;
      const ic = el('div', 'nav-aviso-ic'); ic.append(icone(m.ic, 22));
      const acoes = el('div', 'nav-aviso-acoes');
      if (r.estado !== 'invalido' && r.estado !== 'orbit') {
        const fora = el('button', 'btn nav-primario', { type: 'button' });
        fora.append(icone('fora', 14), document.createTextNode('Abrir no navegador'));
        fora.addEventListener('click', () => abrirFora());
        acoes.append(fora);
      }
      if (r.estado === 'fora-do-ar' || r.estado === 'sem-resposta' || r.estado === 'erro') {
        const de = el('button', 'btn', { type: 'button' });
        de.append(icone('recarregar', 14), document.createTextNode('Tentar de novo'));
        de.addEventListener('click', () => carregar());
        acoes.append(de);
      }
      if (m.forcar && r.estado !== 'fora-do-ar') {
        const forc = txt('button', 'nav-link', 'Tentar mostrar mesmo assim');
        forc.type = 'button';
        forc.addEventListener('click', () => mostrarQuadro(href));
        acoes.append(forc);
      }
      const end = txt('p', 'nav-aviso-url', r.estado === 'invalido' ? href : legivel(href));
      aviso.replaceChildren(ic, txt('h2', null, m.tit), txt('p', null, m.p), end, acoes);
      aviso.hidden = false;
      aviso.dataset.estado = r.estado;
    }
    function mostrarQuadro(href) {
      if (doOrbit(href)) { progresso(false); st.estado = 'aviso'; telaAviso({ estado: 'orbit' }, href); botoes(); return; }
      aviso.hidden = true;
      inicio.hidden = true;
      quadro.hidden = false;
      st.estado = 'carregando';
      progresso(true);
      // Atribuir o src de novo recarrega, mesmo quando é o mesmo endereço.
      quadro.src = href;
      botoes();
    }
    // Confere no servidor e mostra a página (ou a mensagem). seq descarta respostas atrasadas.
    async function carregar({ repetindo = false } = {}) {
      const href = atual();
      pararRepetir();
      if (!repetindo) st.repetirDesde = 0;
      if (!href) return telaInicio();
      const n = ++st.seq;
      st.estado = 'checando';
      if (!repetindo) progresso(true);
      botoes();
      let r = null;
      try { r = op.checar ? await op.checar(href) : null; } catch { r = null; }
      if (!st.vivo || n !== st.seq) return;
      // Sem a conferência (servidor antigo, rede), tenta mostrar direto.
      if (!r || r.estado === 'ok') return mostrarQuadro(href);
      progresso(false);
      st.estado = 'aviso';
      telaAviso(r, href);
      botoes();
      if (r.estado === 'fora-do-ar' && r.local) {
        if (!st.repetirDesde) st.repetirDesde = Date.now();
        if (Date.now() - st.repetirDesde < REPETIR_MAX) {
          st.timerRepetir = setTimeout(() => { if (st.vivo && st.visivel && st.estado === 'aviso') carregar({ repetindo: true }); }, REPETIR_LOCAL);
        }
      }
    }
    function navegar(bruto) {
      const href = normalizar(bruto);
      if (!href) { campo.select(); telaAviso({ estado: 'invalido' }, String(bruto || '')); st.estado = 'aviso'; botoes(); return; }
      if (atual() && mesmaPagina(atual(), href) && st.estado !== 'aviso') { mostrarCampo(); return carregar(); }
      d.hist = d.hist.slice(0, d.pos + 1);
      d.hist.push(href);
      if (d.hist.length > MAX_HIST) d.hist = d.hist.slice(-MAX_HIST);
      d.pos = d.hist.length - 1;
      salvar();
      campo.value = legivel(href);
      carregar();
    }
    function ir(delta) {
      const p = d.pos + delta;
      if (p < 0 || p >= d.hist.length) return;
      d.pos = p;
      salvar();
      campo.value = legivel(atual());
      carregar();
    }
    function parar() {
      st.seq++;
      progresso(false);
      try { quadro.contentWindow && quadro.contentWindow.stop && quadro.contentWindow.stop(); } catch {}
      if (st.estado === 'checando' || st.estado === 'carregando') st.estado = quadro.hidden ? 'nada' : 'pronto';
      botoes();
    }
    function abrirFora(href = atual()) {
      if (!href) return;
      Promise.resolve(op.externo ? op.externo(href) : Promise.reject())
        .catch(() => { try { window.open(href, '_blank', 'noopener,noreferrer'); } catch {} });
    }

    // Página da aba nova: prévias salvas e o que está rodando agora.
    async function telaInicio() {
      st.estado = 'nada';
      quadro.hidden = true;
      aviso.hidden = true;
      inicio.hidden = false;
      progresso(false);
      botoes();
      const n = ++st.seq;
      const cab = el('div', 'nav-ini-cab');
      const ic = el('div', 'nav-ini-ic'); ic.append(icone('globo', 22));
      cab.append(ic, txt('h2', null, 'Nova aba'), txt('p', null, 'Digite um endereço na barra ou abra a prévia de um projeto.'));
      const listas = el('div', 'nav-ini-listas');
      listas.append(txt('p', 'nav-ini-carregando', 'Procurando o que está rodando…'));
      const nota = txt('p', 'nav-ini-nota', 'Se o login de um projeto local não funcionar aqui, troque localhost por 127.0.0.1 no endereço.');
      inicio.replaceChildren(cab, listas, nota);
      let dadosIni = null;
      try { dadosIni = op.inicio ? await op.inicio() : null; } catch { dadosIni = null; }
      if (!st.vivo || n !== st.seq) return;
      listas.replaceChildren();
      const secao = (rot, itens, cls) => {
        if (!itens || !itens.length) return;
        const s = el('section', 'nav-ini-sec' + (cls ? ' ' + cls : ''));
        s.append(txt('h3', null, rot));
        const ul = el('ul', 'nav-ini-lista');
        for (const it of itens) {
          const li = el('li');
          const b = el('button', 'nav-ini-item', { type: 'button', title: it.url });
          const ic2 = el('span', 'nav-ini-item-ic'); ic2.append(icone(ehLocal(it.url) ? 'local' : 'globo', 14));
          b.append(ic2, txt('span', 'nav-ini-nome', it.nome || legivel(it.url)), txt('span', 'nav-ini-url', it.nome ? legivel(it.url) : (it.detalhe || '')));
          if (it.vivo != null) { const p = el('span', 'nav-ini-vivo' + (it.vivo ? ' on' : ''), { title: it.vivo ? 'Respondendo agora' : 'Não está respondendo' }); b.append(p); }
          b.addEventListener('click', () => navegar(it.url));
          li.append(b);
          ul.append(li);
        }
        s.append(ul);
        listas.append(s);
      };
      if (dadosIni) {
        secao('Prévias dos projetos', dadosIni.previas);
        secao('Rodando agora', dadosIni.rodando);
        if (dadosIni.outras && dadosIni.outras.length) {
          const det = el('details', 'nav-ini-outras');
          det.append(txt('summary', null, 'Outras portas locais (' + dadosIni.outras.length + ')'));
          const antes = listas.childElementCount;
          secao('', dadosIni.outras, 'nav-ini-sem-tit');
          if (listas.childElementCount > antes) det.append(listas.lastElementChild);
          listas.append(det);
        }
      }
      if (!listas.childElementCount) listas.append(txt('p', 'nav-ini-carregando', 'Nenhuma prévia salva e nada rodando nas portas locais.'));
    }

    // ───────── eventos ─────────
    quadro.addEventListener('load', () => {
      if (quadro.hidden || !quadro.src || quadro.src === 'about:blank') return;
      progresso(false);
      if (st.estado === 'carregando') st.estado = 'pronto';
      botoes();
    });
    campo.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); navegar(campo.value); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); campo.value = legivel(atual()); campo.blur(); }
    });
    campo.addEventListener('focus', () => { requestAnimationFrame(() => { if (document.activeElement === campo) campo.select(); }); });
    campo.addEventListener('blur', () => { if (!campo.value.trim()) campo.value = legivel(atual()); });
    bVoltar.addEventListener('click', () => ir(-1));
    bAvancar.addEventListener('click', () => ir(1));
    bRecarregar.addEventListener('click', () => { if (st.estado === 'checando' || st.estado === 'carregando') parar(); else carregar(); });
    bFora.addEventListener('click', () => abrirFora());
    // Clique do meio num item da página inicial: abre em outra aba.
    inicio.addEventListener('auxclick', (e) => {
      const b = e.button === 1 && e.target.closest('.nav-ini-item');
      if (b && op.novaAba) { e.preventDefault(); op.novaAba(b.title); }
    });

    // 1ª ativação aqui: o abas.js só chama mostrar() nas próximas vezes.
    mostrarCampo();
    botoes();
    if (atual()) carregar(); else telaInicio();
    if (!atual()) setTimeout(() => { if (st.vivo && st.visivel) campo.focus({ preventScroll: true }); }, 0);

    return {
      mostrar() {
        st.visivel = true;
        if (st.estado === 'aviso' && aviso.dataset.estado === 'fora-do-ar') carregar({ repetindo: true });
        else if (!atual() && !inicio.hidden) telaInicio();
      },
      esconder() { st.visivel = false; pararRepetir(); },
      destruir() {
        st.vivo = false;
        pararRepetir();
        clearTimeout(st.timerCarga);
        try { quadro.src = 'about:blank'; } catch {}
        raiz.remove();
      },
      focar() { if (!atual() || quadro.hidden) campo.focus({ preventScroll: true }); else try { quadro.focus(); } catch {} },
      navegar,
      url: atual,
    };
  }

  window.Navegador = Object.freeze({ criar, normalizar, ehLocal, titulo, legivel, icone: (tam) => icone('globo', tam), mesmaPagina });
})();
