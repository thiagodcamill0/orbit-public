/* Instâncias — popover "Nova instância" do Orbit (rodada 6, etapa 2).
 *
 * Integração (index.html carrega sob demanda, no 1º clique em "Nova instância"):
 *   window.Instancias.montar(api)     prepara o módulo (não mostra nada)
 *   window.Instancias.abrir(ancora)   abre o popover junto ao botão; se já está aberto, fecha
 *   window.Instancias.fechar()        fecha (sem perder o rascunho)
 *   window.Instancias.aberto()        true com o popover na tela
 *
 * `api`: sessoes(), config(), projetoFiltro(), projetos() → [{nome, pasta, existe}] (opcional), modelos(forcar) → Promise<{modelos, atualizado}>,
 * nomeModelo(id), criada(id) (seleciona e abre a Conversa), abrirVSCode(projeto) (fluxo antigo,
 * POST /nova-instancia), ocupadoVSCode(), toast(texto), icone(nome, tam).
 *
 * Segurança: todo texto que vem do servidor entra só por textContent / value / title.
 */
(function () {
  'use strict';

  const OUTRA = '\u0000outra';
  // A página roda no navegador da própria máquina: no Mac, os exemplos de caminho são do Mac (16/10).
  const MAC = /Mac/i.test(navigator.platform || navigator.userAgent || '');
  const ESFORCO_ROT = { low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo' };
  const PERMISSOES = [
    ['default', 'Padrão', 'Pede sua permissão antes de editar arquivos e rodar comandos'],
    ['acceptEdits', 'Aceitar edições', 'Edita arquivos sem pedir; comandos ainda pedem permissão'],
    ['plan', 'Planejar', 'Só planeja: não edita nem roda nada até você aprovar o plano'],
    ['auto', 'Auto', 'Age sem pedir; um verificador barra as ações arriscadas'],
  ];
  // Modo com que o popover começa: o padrão das Configurações (config.instancias.modoPadrao, padrão auto).
  function modoPadrao() {
    let m = '';
    try { const c = api.config(); m = c && c.instancias ? c.instancias.modoPadrao : ''; } catch {}
    return PERMISSOES.some(([v]) => v === m) ? m : 'auto';
  }

  let api = null;
  const ui = {};
  const st = {
    pastas: [],          // [{ projeto, pasta, n }]
    modelos: null,       // lista do GET /modelos (null = indisponível)
    erroModelos: '',
    pasta: '', outra: '', modelo: '', esforco: '', permissao: 'auto', modoVisto: '',
    iniciado: false, enviando: false, ancora: null, geracao: 0,
    // Skills da instância (17/10): as ativas do projeto (GET /skills), todas marcadas. Com alguma desmarcada,
    // a lista vai no POST como allowlist (skills no initialize); com todas marcadas, nada vai (= todas).
    sk: { pasta: '', lista: null, marcadas: new Set(), aberto: false, erro: '', g: 0 },
  };

  // ───────────────────────────── utilidades ─────────────────────────────
  function h(tag, props, ...filhos) {
    const e = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const f of filhos) if (f != null && f !== false) e.append(f);
    return e;
  }
  function txt(el, v) { const t = v == null ? '' : String(v); if (el.textContent !== t) el.textContent = t; }
  const ico = (n, t = 14) => { try { return api.icone(n, t); } catch { return document.createTextNode(''); } };
  const norm = (p) => String(p || '').trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  const baseDe = (p) => String(p || '').trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || '');

  // Projetos conhecidos: a pasta mais usada de cada projeto (só sessões principais).
  function pastasConhecidas() {
    const porProj = new Map();
    let sessoes = [];
    try { sessoes = api.sessoes() || []; } catch {}
    for (const s of sessoes) {
      if (!s || s.pai || !s.cwd || typeof s.cwd !== 'string') continue;
      const p = s.projeto || baseDe(s.cwd);
      let x = porProj.get(p);
      if (!x) porProj.set(p, (x = { projeto: p, n: 0, cwds: new Map() }));
      x.n++;
      x.cwds.set(s.cwd, (x.cwds.get(s.cwd) || 0) + 1);
    }
    const l = [...porProj.values()].map((x) => ({ projeto: x.projeto, n: x.n, pasta: [...x.cwds.entries()].sort((a, b) => b[1] - a[1])[0][0] }));
    // Projetos da lateral (GET /projetos) ainda sem sessão também entram, com a pasta cadastrada (17/10).
    let regs = [];
    try { regs = (api.projetos && api.projetos()) || []; } catch {}
    for (const r of regs) {
      if (!r || !r.nome || !r.pasta || r.existe === false || porProj.has(r.nome)) continue;
      if (l.some((p) => norm(p.pasta) === norm(r.pasta))) continue;
      l.push({ projeto: r.nome, n: 0, pasta: String(r.pasta) });
    }
    l.sort((a, b) => b.n - a.n || a.projeto.localeCompare(b.projeto, 'pt-BR'));
    return l;
  }
  function cfgNova() {
    try { const c = api.config(); return c && c.novaInstancia && typeof c.novaInstancia === 'object' ? c.novaInstancia : {}; } catch { return {}; }
  }
  function listaAberta(alvo) {
    const s = alvo && alvo.closest ? alvo.closest('select') : null;
    try { return !!s && s.matches(':open'); } catch { return false; } // navegador sem :open
  }
  function modeloPorValor(v) { return (st.modelos || []).find((m) => m.valor === v) || null; }
  function rotuloModelo(m) {
    if (m.valor !== 'default') return m.nome || m.valor;
    // "Default (recommended)" do binário: mostra o modelo que ele resolve.
    const alvo = (st.modelos || []).find((x) => x.valor !== 'default' && x.modelo === m.modelo);
    return 'Padrão · ' + ((alvo && alvo.nome) || m.descricao || m.modelo || 'recomendado');
  }

  // ───────────────────────────── montagem ─────────────────────────────
  function montar(a) {
    api = a;
    const el = h('div', { class: 'ni-pop', id: 'ni-pop', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'ni-tit', hidden: true });

    ui.fechar = h('button', { type: 'button', class: 'btn-icone ni-x', title: 'Fechar', 'aria-label': 'Fechar' }, ico('x', 14));
    const cab = h('div', { class: 'ni-cab' },
      h('span', { class: 'ni-marca', 'aria-hidden': 'true' }, ico('mais', 16)),
      h('div', { class: 'ni-cab-txt' }, h('b', { id: 'ni-tit' }, 'Nova instância'), h('small', null, 'Claude Code no Orbit, sem abrir o VS Code')),
      ui.fechar);

    // Pasta
    ui.pasta = h('select', { class: 'ni-campo ni-sel', id: 'ni-pasta', 'aria-describedby': 'ni-caminho' });
    ui.caminho = h('p', { class: 'ni-caminho', id: 'ni-caminho' });
    ui.outra = h('input', { class: 'ni-campo', id: 'ni-outra', type: 'text', placeholder: MAC ? '/Users/voce/Projetos/minha-pasta' : 'D:\\Projetos\\minha-pasta', 'aria-label': 'Caminho completo da pasta', spellcheck: 'false', autocomplete: 'off', hidden: true });

    // Modelo e esforço
    ui.modelo = h('select', { class: 'ni-campo ni-sel', id: 'ni-modelo' });
    ui.esforco = h('select', { class: 'ni-campo ni-sel', id: 'ni-esforco' });
    ui.avisoModelos = h('p', { class: 'ni-nota', hidden: true });

    // Permissão
    ui.perm = h('div', { class: 'ni-seg', role: 'radiogroup', 'aria-labelledby': 'ni-rot-perm' },
      ...PERMISSOES.map(([v, rot, dica]) => h('button', { type: 'button', role: 'radio', 'data-v': v, 'aria-checked': 'false', title: dica, tabindex: '-1' }, rot)));
    ui.permDica = h('p', { class: 'ni-nota', id: 'ni-perm-dica' });

    // Skills
    ui.skResumo = h('span', { class: 'ni-sk-resumo', id: 'ni-sk-resumo' });
    ui.skBtn = h('button', { type: 'button', class: 'link ni-sk-btn', 'aria-expanded': 'false', 'aria-controls': 'ni-sk-lista' }, 'Escolher');
    ui.skLista = h('div', { class: 'ni-sk-lista', id: 'ni-sk-lista', role: 'group', 'aria-labelledby': 'ni-rot-sk', hidden: true });

    // Nome e 1ª mensagem
    ui.nome = h('input', { class: 'ni-campo', id: 'ni-nome', type: 'text', maxlength: 60, placeholder: 'Opcional · aparece na lista', spellcheck: 'false', autocomplete: 'off' });
    ui.texto = h('textarea', { class: 'ni-campo ni-texto', id: 'ni-texto', rows: 3, maxlength: 20000, placeholder: 'Opcional · o que a instância faz primeiro', spellcheck: 'true' });
    // Imagens da 1ª mensagem (16/10, assets/anexos.js): botão, arrastar para o popover e Ctrl+V.
    ui.ax = window.Anexos ? window.Anexos.criar({ alvo: el, campo: ui.texto, max: window.Anexos.MAX, aoMudar: () => { limparErro(); posicionar(); }, aoAviso: (t) => mostrarErro(t) }) : null;
    if (ui.ax) ui.ax.botao.append(h('span', null, 'Imagens'));

    ui.erro = h('p', { class: 'ni-erro', role: 'alert', hidden: true });
    // Etapa 5: só o Orbit no popover; o fluxo antigo (VS Code) fica em "Nova no VS Code", no menu do projeto.
    ui.vscode = h('button', { type: 'button', class: 'link ni-vscode', hidden: true }, ico('externo', 13), h('span', null, 'Abrir no VS Code'));
    ui.criarRot = h('span', null, 'Criar');
    ui.criar = h('button', { type: 'button', class: 'btn ni-criar' }, ico('mais', 14), ui.criarRot);

    ui.form = h('div', { class: 'ni-form' },
      h('label', { class: 'ni-rot', for: 'ni-pasta' }, 'Pasta'), ui.pasta, ui.outra, ui.caminho,
      h('div', { class: 'ni-par' },
        h('div', { class: 'ni-col' }, h('label', { class: 'ni-rot', for: 'ni-modelo' }, 'Modelo'), ui.modelo),
        h('div', { class: 'ni-col' }, h('label', { class: 'ni-rot', for: 'ni-esforco' }, 'Esforço'), ui.esforco)),
      ui.avisoModelos,
      h('div', { class: 'ni-rot', id: 'ni-rot-perm' }, 'Permissão'), ui.perm, ui.permDica,
      h('div', { class: 'ni-rot', id: 'ni-rot-sk' }, 'Skills'), h('div', { class: 'ni-sk' }, ui.skResumo, ui.skBtn), ui.skLista,
      h('label', { class: 'ni-rot', for: 'ni-nome' }, 'Nome', h('span', null, 'opcional')), ui.nome,
      h('label', { class: 'ni-rot', for: 'ni-texto' }, '1ª mensagem', h('span', null, 'opcional')), ui.texto,
      ui.ax && h('div', { class: 'ni-anexos' }, ui.ax.botao, ui.ax.faixa));

    el.append(cab, ui.form, ui.erro, h('div', { class: 'ni-pe' }, ui.vscode, ui.criar));
    document.body.append(el);
    ui.el = el;

    ui.fechar.addEventListener('click', () => fechar(true));
    ui.pasta.addEventListener('change', () => { st.pasta = ui.pasta.value; aplicarPasta(true); limparErro(); });
    ui.outra.addEventListener('input', () => { st.outra = ui.outra.value; atualizarVSCode(); limparErro(); });
    ui.modelo.addEventListener('change', () => { st.modelo = ui.modelo.value; preencherEsforco(); limparErro(); });
    ui.esforco.addEventListener('change', () => { st.esforco = ui.esforco.value; limparErro(); });
    ui.perm.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) { definirPermissao(b.dataset.v); b.focus(); } });
    ui.perm.addEventListener('keydown', (e) => {
      const passo = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!passo) return;
      e.preventDefault();
      const i = PERMISSOES.findIndex(([v]) => v === st.permissao);
      const v = PERMISSOES[(i + passo + PERMISSOES.length) % PERMISSOES.length][0];
      definirPermissao(v);
      ui.perm.querySelector('[data-v="' + v + '"]').focus();
    });
    ui.criar.addEventListener('click', criar);
    ui.skBtn.addEventListener('click', () => { st.sk.aberto = !st.sk.aberto; renderSkills(); posicionar(); });
    ui.skLista.addEventListener('change', (e) => {
      const c = e.target.closest('input[data-chave]');
      if (!c) return;
      if (c.checked) st.sk.marcadas.add(c.dataset.chave); else st.sk.marcadas.delete(c.dataset.chave);
      renderSkills(true);
    });
    ui.vscode.addEventListener('click', abrirNoVSCode);
    el.addEventListener('keydown', (e) => {
      // Lista de um seletor aberta (base-select): Esc e Enter são dela; Esc fecha só a lista, não o popover.
      if (listaAberta(e.target)) { e.stopPropagation(); return; }
      if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); fechar(true); return; }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); e.stopPropagation(); criar(); return; }
      if (e.key === 'Enter' && !e.shiftKey && e.target === ui.outra) { e.preventDefault(); }
      // Nada daqui dispara os atalhos globais da lista (j/k, Enter, Espaço…).
      e.stopPropagation();
    });
    document.addEventListener('pointerdown', (e) => {
      if (ui.el.hidden || ui.el.contains(e.target)) return;
      if (st.ancora && st.ancora.contains(e.target)) return; // o próprio botão alterna
      if (e.target.closest && e.target.closest('.ax-visor')) return; // imagem ampliada por cima do popover
      fechar(false);
    }, true);
    addEventListener('resize', posicionar);
    // A rolagem de dentro do popover (ou da 1ª mensagem) não reposiciona.
    addEventListener('scroll', (e) => { if (!ui.el.hidden && !ui.el.contains(e.target)) posicionar(); }, true);
  }

  // ───────────────────────────── abrir / fechar ─────────────────────────────
  function abrir(ancora) {
    if (!ui.el) return;
    if (!ui.el.hidden) { fechar(true); return; }
    st.ancora = ancora || null;
    preparar();
    ui.el.hidden = false;
    if (st.ancora) st.ancora.setAttribute('aria-expanded', 'true');
    if (st.ancora) st.ancora.setAttribute('aria-controls', 'ni-pop');
    posicionar();
    // Com a pasta já escolhida, o próximo passo natural é escrever o pedido.
    const alvo = st.pasta && st.pasta !== OUTRA ? ui.texto : st.pasta === OUTRA ? ui.outra : ui.pasta;
    alvo.focus({ preventScroll: true });
    carregarModelos(false);
  }
  function fechar(devolverFoco) {
    if (!ui.el || ui.el.hidden) return;
    ui.el.hidden = true;
    if (st.ancora) {
      st.ancora.setAttribute('aria-expanded', 'false');
      if (devolverFoco && st.ancora.isConnected) st.ancora.focus({ preventScroll: true });
    }
  }
  function aberto() { return !!ui.el && !ui.el.hidden; }

  function posicionar() {
    if (!ui.el || ui.el.hidden) return;
    const m = 12, vw = innerWidth, vh = innerHeight;
    const w = ui.el.offsetWidth;
    const a = ui.el.scrollHeight + 2; // altura natural, mesmo com o max-height aplicado
    let x = m, y = 64;
    if (st.ancora && st.ancora.isConnected) {
      const r = st.ancora.getBoundingClientRect();
      x = r.right - w;          // alinhado à direita do botão
      y = r.bottom + 8;
      if (y + a > vh - m && r.top - 8 - a >= m) y = r.top - 8 - a;
      else if (y + a > vh - m) y = Math.max(m, vh - m - a); // não cabe embaixo nem em cima: sobe o quanto der
    }
    y = Math.max(m, Math.min(y, vh - m - 120));
    ui.el.style.left = Math.round(Math.max(m, Math.min(x, vw - w - m))) + 'px';
    ui.el.style.top = Math.round(y) + 'px';
    ui.el.style.maxHeight = Math.max(160, vh - y - m) + 'px';
  }

  // ───────────────────────────── preencher ─────────────────────────────
  function preparar() {
    const cfg = cfgNova();
    st.pastas = pastasConhecidas();
    if (!st.iniciado) {
      st.iniciado = true;
      st.modelo = typeof cfg.modelo === 'string' ? cfg.modelo : '';
      st.esforco = typeof cfg.esforco === 'string' ? cfg.esforco : '';
      st.pasta = '';
    }
    // Permissão: o padrão das Configurações; a escolha do rascunho vale até esse padrão mudar.
    const mp = modoPadrao();
    if (mp !== st.modoVisto) st.permissao = st.modoVisto = mp;
    // Pasta: a do filtro de projeto > a que já estava escolhida > a última usada > a mais usada.
    let filtro = '';
    try { filtro = api.projetoFiltro() || ''; } catch {}
    const doFiltro = filtro && st.pastas.find((p) => p.projeto === filtro);
    const ultima = typeof cfg.pasta === 'string' && cfg.pasta.trim() ? cfg.pasta.trim() : '';
    if (ultima && !st.pastas.some((p) => norm(p.pasta) === norm(ultima))) st.pastas.push({ projeto: baseDe(ultima), pasta: ultima, n: 0, ultima: true });
    const existe = (v) => v === OUTRA || st.pastas.some((p) => p.pasta === v);
    if (doFiltro) st.pasta = doFiltro.pasta;
    else if (!st.pasta || !existe(st.pasta)) {
      const u = ultima && st.pastas.find((p) => norm(p.pasta) === norm(ultima));
      st.pasta = u ? u.pasta : st.pastas.length ? st.pastas[0].pasta : OUTRA;
    }
    ui.pasta.replaceChildren(
      ...st.pastas.map((p) => h('option', { value: p.pasta, title: p.pasta }, p.projeto + (p.ultima ? ' (última usada)' : ''))),
      h('option', { value: OUTRA, class: 'ni-op-outra' }, 'Outra pasta…'));
    ui.pasta.value = st.pasta;
    ui.outra.value = st.outra;
    aplicarPasta(false);
    preencherModelos();
    definirPermissao(st.permissao);
    limparErro();
    definirEnviando(false);
  }
  function aplicarPasta(focar) {
    const outra = st.pasta === OUTRA;
    ui.outra.hidden = !outra;
    ui.caminho.hidden = outra;
    ui.pasta.title = outra ? '' : st.pasta;
    if (!outra) {
      txt(ui.caminho, st.pasta);
      ui.caminho.title = st.pasta;
    }
    if (outra && focar) ui.outra.focus();
    atualizarVSCode();
    carregarSkills(outra ? '' : st.pasta);
    posicionar();
  }

  // ───────────────────────────── skills ─────────────────────────────
  // Ativas = as que o Claude pode usar sozinho no projeto (nem desativadas, nem "só por você", nem escondidas).
  async function carregarSkills(pasta) {
    const k = st.sk;
    if (pasta === k.pasta && (k.lista || k.erro)) { renderSkills(); return; }
    const g = ++k.g;
    k.pasta = pasta;
    k.lista = null;
    k.erro = '';
    k.marcadas = new Set();
    renderSkills();
    if (!pasta) return;
    try {
      const r = await fetch('/skills?pasta=' + encodeURIComponent(pasta), { cache: 'no-store' });
      const d = await r.json().catch(() => null);
      if (g !== k.g) return;
      if (!r.ok) throw new Error(r.status === 404 && d && d.erro ? 'Pasta fora dos projetos conhecidos: a instância usa todas as skills.' : (d && d.erro) || 'Não deu para ler as skills.');
      k.lista = (d.skills || []).filter((s) => s.estado !== 'off' && s.estado !== 'user-invocable-only' && !s.sombreada && s.chave)
        .map((s) => ({ chave: s.chave, nome: s.nome, origem: s.origem, descricao: s.descricao || '' }));
      k.marcadas = new Set(k.lista.map((s) => s.chave));
      k.parcial = !(d.sonda && d.sonda.ok);
    } catch (e) {
      if (g !== k.g) return;
      k.erro = e.message;
    }
    renderSkills();
    posicionar();
  }
  const ORIGEM_SK = { projeto: 'projeto', pessoal: 'pessoal', 'claude.ai': 'claude.ai', plugin: 'plugin', embutida: 'embutida' };
  function renderSkills(soResumo) {
    const k = st.sk;
    const l = k.lista;
    ui.skBtn.hidden = !l || !l.length;
    ui.skBtn.setAttribute('aria-expanded', String(!!k.aberto && !!l));
    txt(ui.skBtn, k.aberto ? 'Fechar' : 'Escolher');
    if (!k.pasta) txt(ui.skResumo, 'Todas as skills da pasta');
    else if (k.erro) txt(ui.skResumo, k.erro);
    else if (!l) txt(ui.skResumo, 'Lendo as skills do projeto…');
    else if (!l.length) txt(ui.skResumo, 'Nenhuma skill ativa no projeto');
    else {
      const n = l.filter((s) => k.marcadas.has(s.chave)).length;
      txt(ui.skResumo, n === l.length ? 'Todas as ativas do projeto (' + l.length + ')' : n ? n + ' de ' + l.length + ' ativas' : 'Nenhuma (a instância fica sem skills)');
    }
    ui.skLista.hidden = !k.aberto || !l || !l.length;
    if (soResumo || ui.skLista.hidden) return;
    const todas = h('button', { type: 'button', class: 'link' }, 'Todas');
    const nenhuma = h('button', { type: 'button', class: 'link' }, 'Nenhuma');
    todas.addEventListener('click', () => { k.marcadas = new Set(l.map((s) => s.chave)); renderSkills(); });
    nenhuma.addEventListener('click', () => { k.marcadas = new Set(); renderSkills(); });
    ui.skLista.replaceChildren(
      h('div', { class: 'ni-sk-topo' }, todas, nenhuma),
      ...l.map((s) => {
        const c = h('input', { type: 'checkbox', 'data-chave': s.chave });
        c.checked = k.marcadas.has(s.chave);
        c.disabled = st.enviando;
        return h('label', { class: 'ni-sk-item', title: s.descricao }, c, h('span', { class: 'ni-sk-nome' }, s.nome), h('span', { class: 'ni-sk-org' }, ORIGEM_SK[s.origem] || s.origem));
      }),
      h('p', { class: 'ni-nota' }, h('span', null, 'Só as marcadas ficam disponíveis para o Claude nesta instância.' + (k.parcial ? ' Sem a leitura do Claude Code, plugins e skills do claude.ai podem faltar na lista.' : ''))));
  }
  function projetoEscolhido() {
    if (st.pasta === OUTRA) return null;
    const p = st.pastas.find((x) => x.pasta === st.pasta);
    return p && !p.ultima ? p.projeto : null;
  }
  function atualizarVSCode() {
    let ocupado = false;
    try { ocupado = !!api.ocupadoVSCode(); } catch {}
    const proj = projetoEscolhido();
    const motivo = ocupado ? 'Já há uma instância abrindo no VS Code.'
      : !proj ? 'O VS Code abre só os projetos que já têm sessão na lista.'
      : st.enviando ? 'Espere a criação terminar.' : '';
    ui.vscode.setAttribute('aria-disabled', motivo ? 'true' : 'false');
    ui.vscode.title = motivo || 'Abre uma conversa nova na extensão do VS Code, em ' + proj + ' (sem modelo, esforço nem 1ª mensagem)';
  }

  function preencherModelos() {
    const l = st.modelos;
    if (!l || !l.length) {
      ui.modelo.replaceChildren(h('option', { value: '' }, st.erroModelos ? 'Padrão do Claude Code' : 'Carregando modelos…'));
      ui.modelo.value = '';
      ui.modelo.disabled = true;
      ui.modelo.title = st.erroModelos || '';
      preencherEsforco();
      return;
    }
    ui.modelo.disabled = st.enviando;
    ui.modelo.replaceChildren(...l.map((m) => h('option', { value: m.valor, title: m.descricao || m.modelo || '' }, rotuloModelo(m))));
    if (!modeloPorValor(st.modelo)) st.modelo = modeloPorValor('default') ? 'default' : l[0].valor;
    ui.modelo.value = st.modelo;
    preencherEsforco();
  }
  function preencherEsforco() {
    const m = modeloPorValor(st.modelo);
    const niveis = m && Array.isArray(m.esforcos) ? m.esforcos.filter((x) => typeof x === 'string') : [];
    if (!m || !niveis.length) {
      const rot = !st.modelos ? (st.erroModelos ? 'Padrão' : '…') : 'Sem esforço';
      ui.esforco.replaceChildren(h('option', { value: '' }, rot));
      ui.esforco.value = '';
      ui.esforco.disabled = true;
      ui.esforco.title = m ? (m.nome || m.valor) + ' não tem nível de esforço' : '';
      ui.modelo.title = m ? m.descricao || '' : ui.modelo.title;
      return;
    }
    ui.esforco.disabled = st.enviando;
    ui.esforco.title = 'Quanto o modelo pensa antes de agir';
    ui.modelo.title = m.descricao || '';
    ui.esforco.replaceChildren(
      h('option', { value: '' }, 'Padrão do modelo'),
      ...niveis.map((n) => h('option', { value: n }, (ESFORCO_ROT[n] || n) + ' · ' + n)));
    // O nível que o modelo não aceita volta ao padrão do modelo.
    if (st.esforco && !niveis.includes(st.esforco)) st.esforco = '';
    ui.esforco.value = st.esforco;
  }
  function definirPermissao(v) {
    st.permissao = v;
    for (const b of ui.perm.querySelectorAll('button[data-v]')) {
      const sim = b.dataset.v === v;
      b.setAttribute('aria-checked', String(sim));
      b.tabIndex = sim ? 0 : -1;
    }
    const p = PERMISSOES.find(([x]) => x === v);
    txt(ui.permDica, p ? p[2] : '');
  }

  async function carregarModelos(forcar) {
    const g = ++st.geracao;
    if (!st.modelos) { st.erroModelos = ''; ui.avisoModelos.hidden = true; preencherModelos(); }
    try {
      const d = await api.modelos(forcar);
      if (g !== st.geracao) return;
      const l = d && Array.isArray(d.modelos) ? d.modelos.filter((m) => m && typeof m.valor === 'string' && m.valor) : [];
      if (!l.length) throw new Error('O servidor não devolveu nenhum modelo.');
      st.modelos = l;
      st.erroModelos = '';
      ui.avisoModelos.hidden = true;
    } catch (e) {
      if (g !== st.geracao) return;
      if (st.modelos) return; // fica com a lista que já tinha
      st.erroModelos = e && e.status === 404 ? 'Este servidor ainda não lista os modelos.'
        : e && e.status === 503 ? 'O servidor ainda está lendo os modelos.'
        : (e && e.message) || 'Não deu para ler os modelos.';
      const tentar = h('button', { type: 'button', class: 'link' }, 'Tentar de novo');
      tentar.addEventListener('click', () => carregarModelos(true));
      ui.avisoModelos.replaceChildren(ico('info', 13), h('span', null, st.erroModelos + ' A instância usa o modelo padrão.'), e && e.status === 404 ? null : tentar);
      ui.avisoModelos.hidden = false;
    }
    preencherModelos();
    posicionar();
  }

  // ───────────────────────────── criar ─────────────────────────────
  function mostrarErro(t, campo) {
    txt(ui.erro, t);
    ui.erro.hidden = false;
    posicionar();
    if (campo) campo.focus();
  }
  function limparErro() { if (!ui.erro.hidden) { ui.erro.hidden = true; txt(ui.erro, ''); posicionar(); } }
  function definirEnviando(v) {
    st.enviando = v;
    ui.el.setAttribute('aria-busy', String(v));
    ui.criar.classList.toggle('ni-ocupado', v);
    ui.criar.setAttribute('aria-disabled', String(v));
    txt(ui.criarRot, v ? 'Criando…' : 'Criar');
    const sp = ui.criar.querySelector('.ni-gira');
    if (v && !sp) ui.criar.firstChild.replaceWith(h('span', { class: 'ni-gira', 'aria-hidden': 'true' }));
    if (!v && sp) sp.replaceWith(ico('mais', 14));
    for (const c of [ui.pasta, ui.outra, ui.nome, ui.texto]) c.disabled = v;
    if (ui.ax) { ui.ax.desabilitar(v); ui.ax.habilitar(!v, 'Criando a instância…'); }
    for (const b of ui.perm.querySelectorAll('button')) b.disabled = v;
    if (st.modelos && st.modelos.length) ui.modelo.disabled = v;
    if (!v) preencherEsforco(); else ui.esforco.disabled = true;
    atualizarVSCode();
  }
  function pastaFinal() { return st.pasta === OUTRA ? ui.outra.value.trim() : st.pasta; }

  async function criar() {
    if (st.enviando) return;
    limparErro();
    const pasta = pastaFinal();
    if (!pasta) { mostrarErro('Digite o caminho completo da pasta.', ui.outra); return; }
    if (st.pasta === OUTRA && !/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(pasta)) { mostrarErro(`Use o caminho completo da pasta, como ${MAC ? '/Users/voce/Projetos/app' : 'D:\\Projetos\\app'}.`, ui.outra); return; }
    const corpo = { pasta, permissao: st.permissao };
    const m = st.modelos ? modeloPorValor(st.modelo) : null;
    if (m) corpo.modelo = m.valor;
    if (m && st.esforco && (m.esforcos || []).includes(st.esforco)) corpo.esforco = st.esforco;
    const nome = ui.nome.value.trim();
    if (nome) corpo.nome = nome.slice(0, 60);
    const texto = ui.texto.value;
    if (texto.trim()) corpo.texto = texto.slice(0, 20000);
    if (ui.ax && ui.ax.pendentes()) { mostrarErro('Espere as imagens ficarem prontas.'); return; }
    if (ui.ax && ui.ax.contagem()) corpo.imagens = ui.ax.lista();
    const sk = st.sk;
    if (sk.lista && sk.lista.length && sk.lista.some((s) => !sk.marcadas.has(s.chave))) corpo.skills = sk.lista.filter((s) => sk.marcadas.has(s.chave)).map((s) => s.chave);

    definirEnviando(true);
    let r = null, d = null;
    try {
      r = await fetch('/instancias', { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
      try { d = await r.json(); } catch {}
    } catch {
      definirEnviando(false);
      mostrarErro('Sem resposta do servidor. Confira se o Orbit está rodando e tente de novo.');
      return;
    }
    definirEnviando(false);
    if (!r.ok) {
      const erro = d && typeof d.erro === 'string' && d.erro.trim() ? d.erro.trim() : '';
      const codigo = d && d.codigo;
      if (r.status === 409 || codigo === 'limite') {
        mostrarErro(erro || 'O Orbit já controla o máximo de instâncias. Devolva ou encerre uma antes de criar outra.');
      } else if (r.status === 400) {
        const campo = /pasta|caminho/i.test(erro) ? (st.pasta === OUTRA ? ui.outra : ui.pasta) : /esfor/i.test(erro) ? ui.esforco : /modelo/i.test(erro) ? ui.modelo : null;
        mostrarErro(erro ? 'Não deu para criar: ' + erro : 'Não deu para criar. Confira a pasta, o modelo e o esforço.', campo && !campo.disabled ? campo : null);
      } else if (r.status === 404 && !erro) {
        mostrarErro('Este servidor ainda não cria instâncias pelo Orbit. Use "Nova no VS Code" no menu do projeto (o lápis ao lado do nome).');
      } else {
        mostrarErro('Não deu para criar a instância' + (erro ? ': ' + erro : ' (o servidor respondeu ' + r.status + ').'));
      }
      return;
    }
    const s = d && d.sessao;
    const id = typeof s === 'string' ? s : (s && s.id) || (d && d.acao && d.acao.sessao) || '';
    // Rascunho entregue: o próximo popover começa limpo e relê a última escolha do servidor.
    ui.nome.value = '';
    ui.texto.value = '';
    if (ui.ax) ui.ax.limpar(); // o servidor já tem as imagens: as cópias da memória saem
    st.iniciado = false;
    st.outra = '';
    st.sk.pasta = ''; // o próximo popover relê as skills (e volta a marcar todas)
    st.sk.aberto = false;
    fechar(false);
    if (id) { try { api.criada(id); } catch (e) { console.warn('Instâncias', e); } }
    else { try { api.toast('Instância criada. Ela entra na lista em instantes.'); } catch {} }
  }

  function abrirNoVSCode() {
    if (ui.vscode.getAttribute('aria-disabled') === 'true') { mostrarErro(ui.vscode.title); return; }
    const proj = projetoEscolhido();
    if (!proj) return;
    fechar(false);
    try { api.abrirVSCode(proj); } catch (e) { console.warn('Instâncias', e); }
  }

  window.Instancias = Object.freeze({
    montar, abrir, fechar, aberto,
    _debug: () => ({ pasta: st.pasta, modelo: st.modelo, esforco: st.esforco, permissao: st.permissao, modelos: st.modelos ? st.modelos.length : null }),
  });
})();
