// Orbit no celular — composer (campo de envio), onda 3. Dono: tela composer. API no contrato, "App do celular".
//   OM.composer.montar(cont, opcoes) → { el, focar(), limpar(), desmontar() }
//   opcoes: { id }                              sessão: POST /sessao/:id/mensagem, Parar, chips de modelo/esforço/modo, menu "/"
//           { nova: true, aoEnviar({ texto, imagens }) → Promise }   tela Nova instância: só texto + fotos
//   opcional: placeholder (texto), aoEnviado(resposta, { texto, imagens: n }) depois de uma mensagem aceita (sessão).
//   imagens = [{ tipo: 'image/jpeg', dados: base64 }] (o formato do corpo do POST).
// Nada de innerHTML; tudo com OM.h. Visual: tokens de base.css + peças comuns (assets/comum/componentes.css).
(() => {
  'use strict';
  const OM = window.OM;
  if (!OM || !OM.h) return;
  const { h } = OM;

  const MAX_FOTOS = 6;                       // o servidor aceita 10; no celular 6 bastam e o corpo fica leve
  const MAX_ORIGEM = 40 * 1024 * 1024;       // foto de origem (antes de reduzir)
  const LADO = 1600;                         // px do lado maior depois de reduzir
  const MAX_FOTO_B = 3.4 * 1024 * 1024;      // bytes do JPEG por foto (~4,5 MB em base64; a API aceita 5)
  const MAX_TOTAL_B64 = 18 * 1024 * 1024;    // base64 somado por mensagem (o servidor aceita 24)
  const MAX_TEXTO = 20000;
  const LINHAS = 6;

  const TXT_CONEXAO = {
    conectando: 'Conectando ao Orbit…',
    reconectando: 'Reconectando ao Orbit…',
    pc: 'O PC está desligado ou fora da rede.',
    offline: 'Sem internet no celular.',
    revogado: 'Este aparelho foi desconectado.',
  };
  const MODOS = [
    ['default', 'Padrão', 'Pede sua permissão antes de editar arquivos e rodar comandos'],
    ['acceptEdits', 'Aceitar edições', 'Edita arquivos sem pedir; comandos ainda pedem permissão'],
    ['plan', 'Planejar', 'Só planeja: não edita nem roda nada até você aprovar o plano'],
    ['auto', 'Auto', 'Age sem pedir; um verificador barra as ações arriscadas'],
  ];
  const MODO_OUTRO = { bypassPermissions: 'Sem permissões', dontAsk: 'Não perguntar' };
  const ICONE_MODO = { default: 'cadeado', acceptEdits: 'lapis', plan: 'lista', bypassPermissions: 'raio', dontAsk: 'raio', auto: 'raio' };
  const ESFORCO = { none: 'Nenhum', minimal: 'Mínimo', low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo', auto: 'Automático' };
  const rotuloModo = (m) => { const x = MODOS.find((y) => y[0] === m); return x ? x[1] : MODO_OUTRO[m] || m || 'Padrão'; };
  const rotuloEsforco = (n) => (n ? ESFORCO[n] || n : '');

  // Comandos embutidos do Claude Code: nunca aparecem no menu (o servidor também barra: remoto.mjs, EMBUTIDOS).
  // /compact e /clear são os dois embutidos permitidos. Manter igual à lista do remoto.mjs.
  const EMBUTIDOS = new Set(('add-dir agents allowed-tools approved-tools bashes bug chrome clear compact config context cost desktop doctor exit export '
    + 'extra-usage fast feedback help hooks ide init install-github-app install-slack-app login logout loop mcp memory migrate-installer model output-style '
    + 'permissions plugin plugins pr-comments privacy-settings release-notes remote-control remote-env rename resume review rewind sandbox security-review '
    + 'settings status statusline tasks terminal-setup theme todos upgrade usage vim reset new quit continue checkpoint marketplace skills plan copy '
    + 'keybindings stats debug files mobile ios android teleport stickers passes think-back thinkback-play insights color tag fork btw heapdump '
    + 'reload-plugins web-setup rate-limit-options effort diff voice session pr_comments ultrareview ultraplan setup-bedrock setup-vertex workflows '
    + 'autofix-pr update-config fewer-permission-prompts schedule keybindings-help').split(/\s+/));
  const NOME_OK = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
  const FIXOS = [
    { nome: 'compact', descricao: 'Resumir a conversa para liberar contexto', args: '[foco]' },
    { nome: 'clear', descricao: 'Limpar a conversa e começar do zero', args: '' },
  ];
  const comandoPermitido = (nome) => nome === 'compact' || nome === 'clear' || (NOME_OK.test(nome) && !EMBUTIDOS.has(nome.toLowerCase()));

  // ───────────────────────────── modelos (cache do módulo) ─────────────────────────────
  let cacheModelos = null, cacheEm = 0, cargaModelos = null;
  function carregarModelos(forcar) {
    if (!forcar && cacheModelos && Date.now() - cacheEm < 5 * 60e3) return Promise.resolve(cacheModelos);
    if (cargaModelos) return cargaModelos;
    cargaModelos = OM.api('GET', '/modelos').then((d) => {
      const l = (Array.isArray(d) ? d : d && Array.isArray(d.modelos) ? d.modelos : []).filter((m) => m && typeof m.valor === 'string' && m.valor);
      if (!l.length) throw new Error('A lista de modelos veio vazia.');
      cacheModelos = l;
      cacheEm = Date.now();
      return l;
    }).finally(() => { cargaModelos = null; });
    return cargaModelos;
  }
  const baseModelo = (v) => String(v || '').replace(/\[[^\]]*\]$/, '').toLowerCase();
  function opcaoModelo(v, lista = cacheModelos || []) {
    if (!v) return null;
    return lista.find((x) => x.valor === v) || lista.find((x) => x.valor !== 'default' && baseModelo(x.modelo) === baseModelo(v)) || null;
  }
  function enfeitar(id) { // 'claude-opus-4-8' → 'Opus 4.8'
    const p = String(id || '').replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[[^\]]*\]$/, '').split('-').filter(Boolean);
    if (!p.length) return '';
    const nome = p.filter((x) => !/^\d+$/.test(x)), num = p.filter((x) => /^\d+$/.test(x));
    return [nome.map((x) => x[0].toUpperCase() + x.slice(1)).join(' '), num.join('.')].filter(Boolean).join(' ');
  }
  function nomeCurto(m) {
    if (m.valor !== 'default') return m.nome || m.valor;
    const alvo = (cacheModelos || []).find((x) => x.valor !== 'default' && x.modelo === m.modelo);
    return alvo ? alvo.nome || 'Padrão' : 'Padrão';
  }
  function rotuloOpcao(m) {
    if (m.valor !== 'default') return m.nome || m.valor;
    const alvo = (cacheModelos || []).find((x) => x.valor !== 'default' && x.modelo === m.modelo);
    return 'Padrão · ' + ((alvo && alvo.nome) || m.descricao || 'recomendado');
  }

  // ───────────────────────────── fotos ─────────────────────────────
  const blobBase64 = (blob) => new Promise((ok, falha) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] || '');
    r.onerror = () => falha(new Error('leitura da foto'));
    r.readAsDataURL(blob);
  });
  async function imagemDe(file) {
    try { return await createImageBitmap(file); } catch {}
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((ok, falha) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => falha(new Error('imagem')); i.src = url; });
    } finally { URL.revokeObjectURL(url); }
  }
  // Reduz para no máximo 1600 px e vira JPEG (fotos do iPhone passam de 5 MB e podem vir em HEIC); se ainda ficar
  // grande, reduz mais um pouco.
  async function prepararImagem(file) {
    const img = await imagemDe(file);
    const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) throw new Error('imagem vazia');
    let lado = LADO, q = 0.85, blob = null;
    for (let i = 0; i < 4; i++) {
      const esc = Math.min(1, lado / Math.max(w0, h0));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w0 * esc));
      c.height = Math.max(1, Math.round(h0 * esc));
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', q));
      if (!blob) throw new Error('conversão');
      if (blob.size <= MAX_FOTO_B) break;
      lado = Math.round(lado * 0.75);
      q = 0.7;
    }
    if (img.close) img.close();
    if (blob.size > MAX_FOTO_B) throw new Error('grande');
    return { tipo: 'image/jpeg', dados: await blobBase64(blob), url: URL.createObjectURL(blob) };
  }

  // ───────────────────────────── erros ─────────────────────────────
  function msgErro(e) {
    if (!e) return 'Não deu para enviar.';
    if (e.status === 403 && e.codigo === 'comando_nao_permitido') return 'Esse comando não pode ser usado pelo celular. Daqui só valem /compact, /clear e as suas skills e comandos.';
    if (e.status === 413) return 'As fotos passam do tamanho que o Orbit aceita. Mande menos fotos por vez.';
    if (e.status === 0) return e.message || 'Sem conexão com o Orbit.';
    return e.message || 'Não deu para enviar.';
  }

  let seq = 0;

  // ───────────────────────────── montar ─────────────────────────────
  function montar(cont, opcoes = {}) {
    const nova = !!opcoes.nova;
    const id = nova ? '' : String(opcoes.id || '');
    const uid = 'cp' + (++seq);
    const chaveRascunho = 'om-rascunho:' + (nova ? 'nova' : id);
    const st = {
      fotos: [], enviando: false, morto: false, parando: false,
      aviso: null, avisoT: 0,
      comandos: null, comandosEm: 0, cargaComandos: null,
      menu: { itens: [], ativo: 0, aberto: false },
      ov: null,            // efetivo devolvido pelo servidor: { modelo?, esforco?, modo?, t }
      pend: '',            // 'modelo' | 'esforco' | 'modo' enquanto o POST está no ar
      sig: '', agendado: 0,
    };
    const offs = [];

    // — elementos —
    const ta = h('textarea', {
      class: 'cp-texto', rows: 1, enterkeyhint: 'enter', autocomplete: 'off', autocapitalize: 'sentences',
      'aria-label': 'Mensagem', 'aria-controls': uid + '-menu', placeholder: opcoes.placeholder || 'Escreva uma mensagem',
    });
    const entrada = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'cp-arquivo', tabindex: -1, 'aria-hidden': 'true' });
    const faixa = h('div', { class: 'cp-fotos', hidden: true, role: 'list', 'aria-label': 'Fotos anexadas' });
    const aviso = h('p', { class: 'cp-aviso', hidden: true, role: 'status', 'aria-live': 'polite' });
    const menu = h('div', { class: 'cp-menu', id: uid + '-menu', role: 'listbox', 'aria-label': 'Comandos', hidden: true });
    const btnFoto = h('button', { type: 'button', class: 'cp-foto toque', 'aria-label': 'Anexar foto', title: 'Anexar foto', onclick: () => escolherFotos() }, OM.icone('foto', 20));
    const btnParar = h('button', { type: 'button', class: 'cp-parar toque', 'aria-label': 'Parar a volta', title: 'Interromper a volta em andamento', hidden: true, onclick: () => parar() },
      OM.icone('parar', 14), h('span', { text: 'Parar' }));
    const btnEnviar = h('button', { type: 'button', class: 'cp-enviar btn solido toque', 'aria-label': 'Enviar', title: 'Enviar', disabled: true, onclick: () => enviar() },
      OM.icone('enviar', 18), h('span', { class: 'cp-gira', 'aria-hidden': 'true' }));
    const barra = h('div', { class: 'cp-barra' }, btnFoto, h('span', { class: 'cp-esp' }), btnParar, btnEnviar);
    const campo = h('div', { class: 'cp-campo' }, faixa, ta, barra);

    const chip = (tipo, rotulo, fn) => {
      const rot = h('span', { class: 'cp-chip-rot' });
      const b = h('button', { type: 'button', class: 'cp-chip toque', dados: { tipo }, 'aria-haspopup': 'dialog', onclick: fn },
        h('span', { class: 'cp-chip-ico', 'aria-hidden': 'true' }), rot, OM.icone('chevron-baixo', 12));
      b._rot = rot; b._ico = b.firstChild; b._rotulo = rotulo;
      return b;
    };
    const chModelo = chip('modelo', 'Modelo', () => abrirModelo());
    const chEsforco = chip('esforco', 'Esforço', () => abrirEsforco());
    const chModo = chip('modo', 'Modo de permissão', () => abrirModo());
    const chips = h('div', { class: 'cp-chips', role: 'group', 'aria-label': 'Ajustes da sessão', hidden: true }, chModelo, chEsforco, chModo);

    const el = h('div', { class: 'cp', dados: { nova: nova ? '1' : null } }, aviso, menu, chips, campo, entrada);
    if (nova) chips.remove();
    cont.append(el);

    // ───────────── estado da sessão → regras ─────────────
    function sessao() {
      if (nova || !id) return null;
      try { return (OM.estado.sessao && OM.estado.sessao(id)) || OM.estado.sessoes.get(id) || null; } catch { return null; }
    }
    function regras() {
      const r = { bloqueio: '', fotos: true, fotosMotivo: '', chips: false, parar: false, dormindo: false, orbit: false, s: null, c: null };
      const con = OM.estado.conexao;
      if (con !== 'vivo') r.bloqueio = TXT_CONEXAO[con] || 'Sem conexão com o PC.';
      if (nova) return r;
      const s = sessao(), c = s && s.controle;
      r.s = s; r.c = c;
      if (!c) return r;
      const modo = c.modo || 'nenhum';
      const cdx = c.provedor === 'codex';
      const iniciando = modo === 'orbit' && (c.processo === 'iniciando' || /inician/i.test(c.motivo || ''));
      r.orbit = modo === 'orbit';
      if (!r.bloqueio) {
        if (modo === 'nenhum') r.bloqueio = 'Sem processo vivo. Assuma a sessão no Orbit, pelo PC, para conversar daqui.';
        else if (iniciando) r.bloqueio = 'Iniciando a instância…';
      }
      if (cdx) { r.fotos = false; r.fotosMotivo = 'O Codex ainda não recebe fotos por aqui.'; }
      else if (modo !== 'orbit') { r.fotos = false; r.fotosMotivo = 'Fotos só vão para instâncias do Orbit. Assuma a sessão no Orbit para enviar fotos.'; }
      r.chips = modo === 'orbit' && !cdx;
      r.parar = modo === 'orbit' && !!c.ocupada && !iniciando;
      r.dormindo = modo === 'orbit' && c.processo === 'dormindo';
      return r;
    }
    const prontas = () => st.fotos.filter((f) => !f.preparando);
    const preparando = () => st.fotos.some((f) => f.preparando);

    // ───────────── aviso ─────────────
    function mostrarAviso(texto, tipo = 'erro', ms = 9000) {
      clearTimeout(st.avisoT);
      st.aviso = { texto, tipo };
      if (ms) st.avisoT = setTimeout(() => { st.aviso = null; renderAviso(); }, ms);
      renderAviso();
    }
    function limparAviso() { clearTimeout(st.avisoT); if (st.aviso) { st.aviso = null; renderAviso(); } }
    function renderAviso(r) {
      r = r || regras();
      const a = st.aviso;
      const texto = a ? a.texto : r.bloqueio || (r.dormindo ? 'Instância dormindo: ao enviar, ela acorda.' : '');
      const tipo = a ? a.tipo : 'info';
      aviso.hidden = !texto;
      OM.txt(aviso, texto);
      aviso.classList.toggle('cp-erro', tipo === 'erro');
    }

    // ───────────── render geral ─────────────
    function valores(r) {
      const c = r.c || {}, s = r.s || {};
      const ov = st.ov;
      let modelo = c.modelo || s.modelo || '';
      let esforco = c.modelo ? c.esforco || '' : c.esforco || s.esforco || '';
      let modo = c.modoPermissao || 'default';
      if (ov) {
        const cedo = Date.now() - ov.t < 4000;
        if (ov.modelo !== undefined) { if (cedo && !(opcaoModelo(modelo) && opcaoModelo(modelo) === opcaoModelo(ov.modelo))) modelo = ov.modelo; }
        if (ov.esforco !== undefined && cedo && esforco !== ov.esforco) esforco = ov.esforco;
        if (ov.modo !== undefined && cedo && modo !== ov.modo) modo = ov.modo;
        if (!cedo) st.ov = null;
      }
      return { modelo, esforco, modo };
    }
    function renderChips(r) {
      chips.hidden = nova || !r.chips;
      if (nova || !r.chips) return;
      const v = valores(r);
      const op = opcaoModelo(v.modelo);
      const niveis = op && Array.isArray(op.esforcos) ? op.esforcos.filter((x) => typeof x === 'string') : null;
      const ocupado = !!st.pend;
      // modelo
      OM.txt(chModelo._rot, op ? nomeCurto(op) : v.modelo ? enfeitar(v.modelo) || v.modelo : 'Modelo');
      chModelo.title = 'Modelo' + (op ? ': ' + rotuloOpcao(op) : '') + ' · vale a partir da próxima resposta';
      chModelo.setAttribute('aria-label', 'Modelo desta sessão: ' + (op ? rotuloOpcao(op) : chModelo._rot.textContent));
      // esforço: escondido se o modelo sabidamente não tem; aparece com o valor atual ou "Esforço"
      const semEsforco = !!niveis && !niveis.length;
      chEsforco.hidden = semEsforco;
      const i = niveis ? niveis.indexOf(v.esforco) : -1;
      OM.txt(chEsforco._rot, v.esforco ? rotuloEsforco(v.esforco) : 'Esforço');
      chEsforco.setAttribute('aria-label', 'Esforço desta sessão: ' + (v.esforco ? rotuloEsforco(v.esforco).toLowerCase() : 'padrão'));
      chEsforco.title = 'Esforço' + (v.esforco ? ': ' + rotuloEsforco(v.esforco).toLowerCase() : '') + ' · vale a partir da próxima resposta';
      const nivelEl = niveis && niveis.length ? niveis.map((_, k) => h('i', { class: k <= i ? 'cp-on' : null })) : [h('i', { class: v.esforco ? 'cp-on' : null }), h('i'), h('i')];
      const novoNivel = h('span', { class: 'cp-nivel', 'aria-hidden': 'true' }, nivelEl);
      chEsforco._ico.replaceChildren(novoNivel);
      // modo
      OM.txt(chModo._rot, rotuloModo(v.modo));
      chModo.dataset.modo = v.modo;
      chModo.title = 'Modo de permissão: ' + rotuloModo(v.modo);
      chModo.setAttribute('aria-label', 'Modo de permissão desta sessão: ' + rotuloModo(v.modo));
      const nomeIco = ICONE_MODO[v.modo] || 'cadeado';
      if (chModo._ico.dataset.n !== nomeIco) { chModo._ico.dataset.n = nomeIco; chModo._ico.replaceChildren(OM.icone(nomeIco, 14)); }
      for (const b of [chModelo, chEsforco, chModo]) {
        b.disabled = !!r.bloqueio || ocupado;
        if (st.pend === b.dataset.tipo) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
      }
    }
    function ajustarAltura() {
      ta.style.height = 'auto';
      const cs = getComputedStyle(ta);
      const lh = parseFloat(cs.lineHeight) || 22;
      const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const max = Math.round(lh * LINHAS + pad);
      const alvo = Math.min(ta.scrollHeight, max);
      ta.style.height = Math.max(Math.round(lh + pad), alvo) + 'px';
      ta.style.overflowY = ta.scrollHeight > max + 1 ? 'auto' : 'hidden';
    }
    function renderFotos() {
      faixa.hidden = !st.fotos.length;
      faixa.replaceChildren(...st.fotos.map((f, n) => h('div', { class: ['cp-mini', f.preparando ? 'cp-prep' : ''], role: 'listitem' },
        f.preparando
          ? h('div', { class: 'cp-vista' }, h('span', { class: 'cp-gira2', 'aria-label': 'Preparando a foto', role: 'img' }))
          : h('div', { class: 'cp-vista' }, h('img', { src: f.url, alt: 'Foto ' + (n + 1) + ' anexada', draggable: 'false' })),
        h('button', { type: 'button', class: 'cp-tirar toque', 'aria-label': 'Remover foto ' + (n + 1), onclick: () => removerFoto(f) }, h('span', { class: 'cp-tirar-bola' }, OM.icone('x', 12))))));
    }
    function removerFoto(f) {
      st.fotos = st.fotos.filter((x) => x !== f);
      if (f.url) URL.revokeObjectURL(f.url);
      f.removida = true;
      renderFotos();
      atualizar();
    }
    function atualizar() {
      if (st.morto) return;
      const r = regras();
      const bloq = !!r.bloqueio;
      ta.disabled = bloq;
      const rotPadrao = opcoes.placeholder || (nova ? 'Escreva a primeira mensagem' : 'Escreva uma mensagem');
      ta.placeholder = bloq ? r.bloqueio : r.dormindo ? 'Instância dormindo: ao enviar, ela acorda' : rotPadrao;
      // foto
      const fotoOk = r.fotos && !bloq;
      btnFoto.setAttribute('aria-disabled', fotoOk ? 'false' : 'true');
      btnFoto.classList.toggle('cp-inativo', !fotoOk);
      btnFoto.classList.toggle('cp-tem', st.fotos.length > 0);
      btnFoto.disabled = bloq;
      // enviar / parar
      const temConteudo = !!ta.value.trim() || prontas().length > 0;
      const trabalhando = !nova && r.parar;
      btnParar.hidden = !trabalhando;
      btnParar.disabled = bloq || st.parando;
      btnParar.classList.toggle('cp-ocupado', st.parando);
      OM.txt(btnParar.lastChild, st.parando ? 'Parando…' : 'Parar');
      btnEnviar.hidden = trabalhando && !temConteudo && !st.enviando;
      btnEnviar.disabled = bloq || !temConteudo || preparando() || st.enviando;
      btnEnviar.classList.toggle('cp-ocupado', st.enviando);
      const rotEnviar = trabalhando ? 'Enviar (entra na fila)' : 'Enviar';
      btnEnviar.setAttribute('aria-label', rotEnviar);
      btnEnviar.title = rotEnviar;
      if (st.enviando) btnEnviar.setAttribute('aria-busy', 'true'); else btnEnviar.removeAttribute('aria-busy');
      el.classList.toggle('cp-bloqueado', bloq);
      renderChips(r);
      renderAviso(r);
      if (bloq && st.menu.aberto) fecharMenu();
    }
    function agendar() {
      if (st.agendado || st.morto) return;
      st.agendado = requestAnimationFrame(() => { st.agendado = 0; atualizar(); });
    }

    // ───────────── rascunho ─────────────
    function salvarRascunho() { try { if (ta.value) sessionStorage.setItem(chaveRascunho, ta.value); else sessionStorage.removeItem(chaveRascunho); } catch {} }
    function lerRascunho() { try { return sessionStorage.getItem(chaveRascunho) || ''; } catch { return ''; } }
    function apagarRascunho() { try { sessionStorage.removeItem(chaveRascunho); } catch {} }

    // ───────────── menu "/" ─────────────
    const RE_BARRA = /^\s*\/([^\s]*)$/;
    function listaComandos() {
      const vistos = new Set(FIXOS.map((x) => x.nome));
      const extra = (st.comandos || []).filter((x) => x && typeof x.nome === 'string' && comandoPermitido(x.nome) && !vistos.has(x.nome) && vistos.add(x.nome));
      extra.sort((a, b) => a.nome.localeCompare(b.nome));
      return [...FIXOS, ...extra];
    }
    function carregarComandos() {
      if (nova || !id || st.cargaComandos || (st.comandos && Date.now() - st.comandosEm < 60e3)) return;
      st.cargaComandos = OM.api('GET', '/sessao/' + encodeURIComponent(id) + '/comandos').then((d) => {
        st.comandos = d && Array.isArray(d.comandos) ? d.comandos : [];
        st.comandosEm = Date.now();
      }).catch(() => { st.comandos = st.comandos || []; st.comandosEm = Date.now() - 45e3; }).finally(() => { st.cargaComandos = null; if (!st.morto) atualizarMenu(); });
    }
    function atualizarMenu() {
      if (st.morto) return;
      const m = RE_BARRA.exec(ta.value);
      if (nova || !m || ta.disabled) { fecharMenu(); return; }
      carregarComandos();
      const q = m[1].toLowerCase();
      const todos = listaComandos();
      const itens = q ? [...todos.filter((x) => x.nome.toLowerCase().startsWith(q)), ...todos.filter((x) => !x.nome.toLowerCase().startsWith(q) && x.nome.toLowerCase().includes(q))] : todos;
      st.menu.itens = itens;
      st.menu.ativo = Math.min(st.menu.ativo, Math.max(0, itens.length - 1));
      st.menu.aberto = true;
      menu.hidden = false;
      ta.setAttribute('aria-expanded', 'true');
      if (!itens.length) {
        menu.replaceChildren(h('p', { class: 'cp-menu-vazio' }, 'Nenhum comando permitido com esse nome. Daqui só valem /compact, /clear e as suas skills e comandos.'));
        return;
      }
      menu.replaceChildren(...itens.map((x, k) => h('button', {
        type: 'button', class: ['cp-cmd', 'toque', k === st.menu.ativo ? 'cp-ativo' : ''], role: 'option', 'aria-selected': k === st.menu.ativo ? 'true' : 'false',
        onmousedown: (ev) => ev.preventDefault(), onpointerdown: (ev) => { if (ev.pointerType === 'mouse') ev.preventDefault(); },
        onclick: () => escolherComando(x),
      }, h('span', { class: 'cp-cmd-nome' }, '/' + x.nome, x.args ? h('span', { class: 'cp-cmd-args' }, ' ' + x.args) : null),
      x.descricao ? h('span', { class: 'cp-cmd-desc' }, String(x.descricao).replace(/^\([^)]*\)\s*/, '')) : null)));
      const at = menu.querySelector('.cp-ativo');
      if (at && at.scrollIntoView && st.menu.teclado) at.scrollIntoView({ block: 'nearest' });
    }
    function fecharMenu() {
      st.menu.aberto = false;
      st.menu.ativo = 0;
      st.menu.teclado = false;
      if (!menu.hidden) { menu.hidden = true; menu.replaceChildren(); }
      ta.removeAttribute('aria-expanded');
    }
    function escolherComando(x) {
      ta.value = '/' + x.nome + ' ';
      fecharMenu();
      salvarRascunho();
      ajustarAltura();
      atualizar();
      ta.focus();
      try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
    }

    // ───────────── fotos: escolher e preparar ─────────────
    function escolherFotos() {
      const r = regras();
      if (r.bloqueio) { mostrarAviso(r.bloqueio, 'info'); return; }
      if (!r.fotos) { mostrarAviso(r.fotosMotivo, 'info'); return; }
      if (st.fotos.length >= MAX_FOTOS) { mostrarAviso('No máximo ' + MAX_FOTOS + ' fotos por mensagem.'); return; }
      entrada.value = '';
      entrada.click();
    }
    async function adicionarFotos(files) {
      limparAviso();
      for (const f of files) {
        if (st.morto) return;
        const eImagem = /^image\//i.test(f.type) || (!f.type && /\.(heic|heif|jpe?g|png|gif|webp)$/i.test(f.name || ''));
        if (!eImagem) { mostrarAviso('Só dá para anexar imagens.'); continue; }
        if (st.fotos.length >= MAX_FOTOS) { mostrarAviso('No máximo ' + MAX_FOTOS + ' fotos por mensagem.'); break; }
        if (f.size > MAX_ORIGEM) { mostrarAviso('Essa foto é grande demais (máximo ' + Math.round(MAX_ORIGEM / 1048576) + ' MB).'); continue; }
        const marca = { preparando: true };
        st.fotos.push(marca);
        renderFotos();
        atualizar();
        try {
          const pronta = await prepararImagem(f);
          if (st.morto || marca.removida) { URL.revokeObjectURL(pronta.url); continue; }
          const total = prontas().reduce((s, x) => s + x.dados.length, 0) + pronta.dados.length;
          if (total > MAX_TOTAL_B64) {
            URL.revokeObjectURL(pronta.url);
            st.fotos = st.fotos.filter((x) => x !== marca);
            mostrarAviso('As fotos somam demais para uma mensagem. Mande menos fotos por vez.');
            continue;
          }
          Object.assign(marca, pronta);
          marca.preparando = false;
        } catch {
          st.fotos = st.fotos.filter((x) => x !== marca);
          if (!st.morto) mostrarAviso('Não consegui usar essa foto. Tente outra.');
        }
        if (st.morto) return;
        renderFotos();
        atualizar();
      }
    }

    // ───────────── envio ─────────────
    function esvaziar(revogar) {
      ta.value = '';
      apagarRascunho();
      if (revogar) for (const f of st.fotos) if (f.url) URL.revokeObjectURL(f.url);
      st.fotos = [];
      fecharMenu();
      renderFotos();
      ajustarAltura();
    }
    async function enviar() {
      if (st.enviando || st.morto) return;
      const r = regras();
      if (r.bloqueio) { mostrarAviso(r.bloqueio, 'info'); return; }
      if (preparando()) { mostrarAviso('Espere as fotos ficarem prontas.', 'info'); return; }
      const texto = ta.value.replace(/\s+$/, '').replace(/^\s*\n/, '');
      const fotos = prontas();
      if (!texto.trim() && !fotos.length) return;
      if (texto.length > MAX_TEXTO) { mostrarAviso('A mensagem passa de 20 000 caracteres.'); return; }
      const barra = texto.trim()[0] === '/';
      if (barra && fotos.length) { mostrarAviso('Comandos com barra não levam fotos. Tire as fotos ou escreva sem a barra.'); return; }
      const imagens = fotos.map((f) => ({ tipo: f.tipo, dados: f.dados }));
      let fazer;
      let comoMensagem = false;
      if (nova) {
        if (typeof opcoes.aoEnviar !== 'function') return;
        fazer = () => opcoes.aoEnviar({ texto, imagens });
      } else {
        const rota = (a) => '/sessao/' + encodeURIComponent(id) + '/' + a;
        const m = barra && r.orbit ? /^\/(\S+)\s*([\s\S]*)$/.exec(texto.trim()) : null;
        if (m && m[1] === 'clear' && !m[2].trim()) {
          // /clear apaga a conversa: pede confirmação (e usa a ação própria, que acorda a instância se preciso)
          const sim = await OM.confirmar({ titulo: 'Limpar a conversa?', texto: 'O agente começa do zero, sem lembrar desta conversa. Isso não pode ser desfeito.', sim: 'Limpar', nao: 'Cancelar', perigo: true });
          if (!sim || st.morto) return;
          fazer = () => OM.api('POST', rota('limpar'), { confirmar: true });
        } else if (m && m[1] === 'compact') {
          const foco = m[2].trim().slice(0, 500);
          fazer = () => OM.api('POST', rota('compactar'), foco ? { foco } : {});
        } else {
          comoMensagem = true;
          fazer = () => OM.api('POST', rota('mensagem'), imagens.length ? { texto, imagens } : { texto });
        }
      }
      // Limpa já (a mensagem aparece na conversa pelo fluxo); se falhar, devolve o texto e as fotos.
      const guardado = { texto: ta.value, fotos: st.fotos };
      const temp = 'tmp-' + Date.now().toString(36) + '-' + (++seq);
      const emite = !nova && comoMensagem;
      // o pedido sai primeiro (a chamada só devolve a promessa); a bolha otimista nasce logo depois, no mesmo instante
      let pedido; try { pedido = fazer(); } catch (e) { pedido = Promise.reject(e); }
      if (emite) OM.emitir('composer:enviado', { id, temp, texto, imagens: fotos.map((f) => 'data:' + f.tipo + ';base64,' + f.dados) });
      st.enviando = true;
      limparAviso();
      esvaziar(false);
      atualizar();
      try {
        const resp = await pedido;
        if (emite) OM.emitir('composer:ok', { id, temp });
        for (const f of guardado.fotos) if (f.url) URL.revokeObjectURL(f.url);
        if (!st.morto && !nova && typeof opcoes.aoEnviado === 'function') { try { opcoes.aoEnviado(resp, { texto, imagens: imagens.length }); } catch (e) { console.warn('composer.aoEnviado', e); } }
      } catch (e) {
        if (emite) OM.emitir('composer:falhou', { id, temp, erro: msgErro(e) });
        if (st.morto) { for (const f of guardado.fotos) if (f.url) URL.revokeObjectURL(f.url); return; }
        if (!ta.value) { ta.value = guardado.texto; salvarRascunho(); }
        st.fotos = [...guardado.fotos, ...st.fotos];
        renderFotos();
        ajustarAltura();
        const t = msgErro(e);
        mostrarAviso(t, 'erro', 12000);
        if (e && e.status === 403 && e.codigo === 'comando_nao_permitido') OM.toast(t);
        else if (!nova) OM.toast(t.length > 110 ? 'Não deu para enviar.' : t);
      } finally {
        st.enviando = false;
        atualizar();
      }
    }
    async function parar() {
      if (nova || st.parando || !id) return;
      st.parando = true;
      atualizar();
      try {
        await OM.api('POST', '/sessao/' + encodeURIComponent(id) + '/parar', {});
      } catch (e) {
        if (e && e.status === 409) OM.toast('A sessão já parou.');
        else OM.toast(msgErro(e));
      } finally {
        st.parando = false;
        atualizar();
      }
    }

    // ───────────── ajustes (folhas) ─────────────
    function listaOpcoes(corpo, f, titulo, itens, atual, escolher) {
      corpo.replaceChildren(...(titulo ? [h('p', { class: 'cp-op-dica' }, titulo)] : []), h('div', { class: 'cp-ops', role: 'listbox' }, ...itens.map((it) => h('button', {
        type: 'button', class: ['cp-op', 'toque', it.valor === atual ? 'cp-atual' : ''], role: 'option', 'aria-selected': it.valor === atual ? 'true' : 'false',
        onclick: () => { f.fechar('escolha'); escolher(it.valor); },
      }, it.icone ? h('span', { class: 'cp-op-ico', 'aria-hidden': 'true' }, OM.icone(it.icone, 18)) : null,
      h('span', { class: 'cp-op-txt' }, h('span', { class: 'cp-op-nome' }, it.nome), it.desc ? h('span', { class: 'cp-op-desc' }, it.desc) : null),
      h('span', { class: 'cp-op-ok', 'aria-hidden': 'true' }, it.valor === atual ? OM.icone('check', 16) : null)))));
    }
    async function comLista(tipo) {
      if (cacheModelos) return cacheModelos;
      st.pend = tipo; atualizar();
      try { return await carregarModelos(); } catch (e) { OM.toast('A lista de modelos não carregou: ' + (e.message || 'tente de novo em instantes.')); return null; } finally { st.pend = ''; atualizar(); }
    }
    async function abrirModelo() {
      const r = regras();
      if (!r.chips || r.bloqueio || st.pend) return;
      ta.blur();
      const lista = await comLista('modelo');
      if (!lista || st.morto) return;
      const v = valores(regras());
      const atual = opcaoModelo(v.modelo, lista);
      OM.folha.abrir({
        titulo: 'Modelo', paradas: ['auto'],
        conteudo: (corpo, f) => listaOpcoes(corpo, f, 'Vale a partir da próxima resposta, inclusive com a volta em andamento.',
          lista.map((m) => ({ valor: m.valor, nome: rotuloOpcao(m), desc: m.descricao && m.valor !== 'default' ? m.descricao : '' })), atual ? atual.valor : '',
          (valor) => trocar('modelo', valor)),
      });
    }
    async function abrirEsforco() {
      const r = regras();
      if (!r.chips || r.bloqueio || st.pend) return;
      ta.blur();
      const lista = await comLista('esforco');
      if (!lista || st.morto) return;
      const v = valores(regras());
      const op = opcaoModelo(v.modelo, lista);
      const niveis = op && Array.isArray(op.esforcos) ? op.esforcos.filter((x) => typeof x === 'string') : [];
      if (!niveis.length) { OM.toast((op ? nomeCurto(op) : 'Este modelo') + ' não tem nível de esforço.'); return; }
      OM.folha.abrir({
        titulo: 'Esforço', paradas: ['auto'],
        conteudo: (corpo, f) => listaOpcoes(corpo, f, 'Quanto o modelo pensa antes de responder. Vale a partir da próxima resposta.',
          niveis.map((n) => ({ valor: n, nome: rotuloEsforco(n) })), v.esforco, (valor) => trocar('esforco', valor)),
      });
    }
    function abrirModo() {
      const r = regras();
      if (!r.chips || r.bloqueio || st.pend) return;
      ta.blur();
      const v = valores(r);
      const itens = MODOS.map(([valor, nome, desc]) => ({ valor, nome, desc, icone: ICONE_MODO[valor] }));
      if (!itens.some((x) => x.valor === v.modo)) itens.unshift({ valor: v.modo, nome: rotuloModo(v.modo), desc: 'Definido no PC', icone: ICONE_MODO[v.modo] || 'cadeado' });
      OM.folha.abrir({
        titulo: 'Modo de permissão', paradas: ['auto'],
        conteudo: (corpo, f) => listaOpcoes(corpo, f, '', itens, v.modo, (valor) => trocar('modo', valor)),
      });
    }
    async function trocar(tipo, valor) {
      if (st.pend || !id || !valor) return;
      const r0 = regras();
      const v0 = valores(r0);
      if ((tipo === 'modelo' && opcaoModelo(v0.modelo) && opcaoModelo(v0.modelo).valor === valor) || (tipo === 'esforco' && v0.esforco === valor) || (tipo === 'modo' && v0.modo === valor)) return;
      st.pend = tipo;
      atualizar();
      const corpo = tipo === 'modelo' ? { modelo: valor } : tipo === 'esforco' ? { esforco: valor } : { modo: valor };
      try {
        const d = await OM.api('POST', '/sessao/' + encodeURIComponent(id) + '/' + tipo, corpo);
        if (st.morto) return;
        if (tipo === 'modo') {
          const modo = d && typeof d.modo === 'string' && d.modo ? d.modo : valor;
          st.ov = { modo, t: Date.now() };
          if (d && d.pendente) OM.toast('Modo: ' + rotuloModo(modo) + ' · vale ao retomar.');
          else if (modo !== valor) OM.toast('O Claude Code ficou no modo ' + rotuloModo(modo) + '.');
        } else {
          let modelo = d && typeof d.modelo === 'string' ? d.modelo : '';
          const esforco = d && typeof d.esforco === 'string' ? d.esforco : '';
          const pedido = tipo === 'modelo' ? opcaoModelo(valor) : null;
          // "default" e um modelo explícito podem resolver para o mesmo id: se bate, fica o valor pedido
          if (pedido && modelo && modelo !== valor && baseModelo(pedido.modelo) === baseModelo(modelo)) modelo = valor;
          st.ov = { modelo: modelo || undefined, esforco, t: Date.now() };
          const ok = tipo === 'modelo' ? !!opcaoModelo(modelo) && opcaoModelo(modelo) === opcaoModelo(valor) : esforco === valor;
          const nomeEf = tipo === 'modelo' ? (opcaoModelo(modelo) ? rotuloOpcao(opcaoModelo(modelo)) : enfeitar(modelo) || 'o anterior') : rotuloEsforco(esforco) || 'o padrão';
          if (d && d.pendente) OM.toast((tipo === 'modelo' ? 'Modelo: ' : 'Esforço: ') + nomeEf + ' · vale ao retomar.');
          else if (!ok) OM.toast('O Claude Code ficou com ' + nomeEf + (tipo === 'modelo' ? '.' : ' de esforço.'));
        }
      } catch (e) {
        if (!st.morto) OM.toast((tipo === 'modelo' ? 'O modelo não mudou: ' : tipo === 'esforco' ? 'O esforço não mudou: ' : 'O modo não mudou: ') + msgErro(e));
      } finally {
        st.pend = '';
        atualizar();
      }
    }

    // ───────────── eventos ─────────────
    ta.addEventListener('input', () => {
      ajustarAltura();
      salvarRascunho();
      if (st.aviso && st.aviso.tipo === 'erro') limparAviso();
      st.menu.ativo = 0;
      atualizarMenu();
      atualizar();
    });
    ta.addEventListener('keydown', (ev) => {
      if (st.menu.aberto && st.menu.itens.length && !ev.isComposing) {
        const n = st.menu.itens.length;
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          st.menu.ativo = (st.menu.ativo + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n;
          st.menu.teclado = true;
          atualizarMenu();
          return;
        }
        if ((ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) || ev.key === 'Tab') { ev.preventDefault(); escolherComando(st.menu.itens[st.menu.ativo]); return; }
      }
      if (ev.key === 'Escape' && st.menu.aberto) { ev.preventDefault(); fecharMenu(); return; }
      // No celular o Enter quebra linha; Ctrl/Cmd+Enter (teclado físico) envia.
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && !ev.isComposing) { ev.preventDefault(); enviar(); }
    });
    ta.addEventListener('paste', (ev) => {
      const imgs = [...(ev.clipboardData ? ev.clipboardData.files : [])].filter((f) => /^image\//i.test(f.type));
      if (!imgs.length) return;
      ev.preventDefault();
      const r = regras();
      if (!r.fotos) { mostrarAviso(r.fotosMotivo || r.bloqueio, 'info'); return; }
      adicionarFotos(imgs);
    });
    entrada.addEventListener('change', () => { const l = [...entrada.files]; entrada.value = ''; if (l.length) adicionarFotos(l); });
    // O botão de enviar não rouba o foco do campo (o teclado do iPhone não fecha entre uma mensagem e outra).
    for (const b of [btnEnviar, btnParar, btnFoto]) b.addEventListener('mousedown', (ev) => ev.preventDefault());

    if (!nova) {
      offs.push(OM.ouvir('sessao', agendar), OM.ouvir('inicio', agendar), OM.ouvir('estado', agendar));
    }
    offs.push(OM.ouvir('conexao', agendar));

    // — começo —
    const rasc = lerRascunho();
    if (rasc) ta.value = rasc;
    ajustarAltura();
    atualizar();
    // o campo ainda não tinha largura na montagem (tela entrando): reajusta quando aparecer
    let ro = null;
    if (window.ResizeObserver) { let larg = 0; ro = new ResizeObserver(() => { const w = ta.clientWidth; if (w !== larg) { larg = w; ajustarAltura(); } }); ro.observe(ta); }

    return {
      el,
      focar() { if (!ta.disabled) { try { ta.focus({ preventScroll: true }); } catch { ta.focus(); } } },
      limpar() { esvaziar(true); limparAviso(); atualizar(); },
      desmontar() {
        if (st.morto) return;
        st.morto = true;
        for (const o of offs) { try { o(); } catch {} }
        if (ro) ro.disconnect();
        if (st.agendado) cancelAnimationFrame(st.agendado);
        clearTimeout(st.avisoT);
        for (const f of st.fotos) if (f.url) URL.revokeObjectURL(f.url);
        st.fotos = [];
        el.remove();
      },
    };
  }

  OM.composer = { montar };
})();
