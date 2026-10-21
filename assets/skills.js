/* Skills — aba da lateral (servidor: skills.mjs). Pesquisa: cofre, 06 Referências/Claude Code por dentro.
 *
 * Integração: o index.html tem o item da lateral (e o botão da faixa estreita) com data-skills, o provedor
 * da aba `skills` (Skills.criarAba) e repassa o SSE "skills" (Skills.receber). O detalhe da sessão chama
 * Skills.peek(sessao, secao) para a seção "Skills usadas".
 *
 * Regras que a página segue (o servidor confere de novo):
 *   - criar e duplicar vão para o PROJETO por padrão; a pasta pessoal (~/.claude/skills) só com a confirmação
 *     explícita do modal, que diz que vale para todos os projetos;
 *   - ativar/desativar grava no .claude/settings.json do projeto escolhido (vai para o git e para o Mac);
 *   - excluir manda para a Lixeira do sistema.
 * Texto que vem do servidor entra só por textContent / value / title.
 */
(function () {
  'use strict';

  const botoes = [...document.querySelectorAll('[data-skills]')];
  const MAC = /Mac/i.test(navigator.platform || navigator.userAgent || '');
  const CHAVE_PASTA = 'gi.skills.pasta';
  const ORIGEM = {
    projeto: ['Projeto', 'Neste projeto, em .claude/skills'],
    pessoal: ['Pessoal', 'Pessoais e globais, em ~/.claude/skills: valem para todos os projetos'],
    'claude.ai': ['claude.ai', 'Sincronizadas da sua conta do claude.ai (só leitura)'],
    plugin: ['Plugin', 'Vêm de plugins instalados (só leitura)'],
    embutida: ['Embutida', 'Vêm com o Claude Code (só leitura)'],
  };
  const GRUPOS = [['projeto', 'Projeto'], ['pessoal', 'Pessoais · globais'], ['claude.ai', 'claude.ai'], ['plugin', 'Plugins'], ['embutida', 'Embutidas']];
  const ICONE_ORIGEM = { projeto: 'pasta', pessoal: 'globo', 'claude.ai': 'balao', plugin: 'cubo', embutida: 'raio' };
  const CHAVE_FAV = 'gi.skills.favoritas';
  const ESTADOS = [
    ['on', 'Ativa', 'O Claude vê a skill e a usa quando ela combina com o pedido'],
    ['name-only', 'Só o nome', 'Aparece para o Claude sem a descrição (gasta menos contexto)'],
    ['user-invocable-only', 'Só por /nome', 'O Claude não usa sozinho; você chama com /nome'],
    ['off', 'Inativa', 'Some para o Claude e para o /nome neste projeto'],
  ];
  // Filtro de estado: "Ativa" junta on e name-only (as duas o Claude usa sozinho). Sem chip marcado = todas.
  const FILTRO_ESTADO = [['ativa', 'Ativas'], ['barra', 'Só por /nome'], ['inativa', 'Inativas']];
  const classeEstado = (s) => (s.estado === 'off' ? 'inativa' : s.estado === 'user-invocable-only' ? 'barra' : 'ativa');
  const RE_NOME = /^[a-z0-9][a-z0-9-]{0,63}$/;
  const MAX_DESC = 1500;

  const st = {
    visivel: false, carregando: false, erro: '', semRota: false, dados: null, pasta: lerPasta(), filtro: '',
    fOrigem: '', fEstado: '', fFav: false, // filtros da barra
    fav: lerFav(),      // ids favoritados (valem em todos os projetos; ficam no navegador)
    projetosReserva: null, // lista do /projetos, para o seletor quando o /skills não responde
    sel: null,          // id da skill aberta no editor (ou '+novo')
    ed: null,           // { origem, nomeAntigo, base: {...}, editavel, arquivos }
    arq: null,          // { caminho, base, novo }
    aba: 'editar',      // aba das instruções: 'editar' ou 'previa'
    salvando: false, geracao: 0,
  };
  const ui = {};

  // ───────────────────────────── utilidades ─────────────────────────────
  function h(tag, props, ...filhos) {
    const e = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'value') e.value = v;
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const f of filhos) if (f != null && f !== false) e.append(f);
    return e;
  }
  function icone(nome, tam = 16) {
    try { const f = window.Orbit && window.Orbit.icone; if (f) return f(nome, tam); } catch {}
    const s = document.createElement('span');
    s.setAttribute('data-icone', nome);
    return s;
  }
  function toast(t) { try { if (window.Orbit && window.Orbit.toast) return window.Orbit.toast(t); } catch {} }
  function lerPasta() { try { return localStorage.getItem(CHAVE_PASTA) || ''; } catch { return ''; } }
  function gravarPasta(v) { try { localStorage.setItem(CHAVE_PASTA, v); } catch {} }
  function lerFav() { try { const l = JSON.parse(localStorage.getItem(CHAVE_FAV) || '[]'); return new Set(Array.isArray(l) ? l.map(String) : []); } catch { return new Set(); } }
  function alternarFav(s) {
    if (st.fav.has(s.id)) st.fav.delete(s.id); else st.fav.add(s.id);
    try { localStorage.setItem(CHAVE_FAV, JSON.stringify([...st.fav])); } catch {}
    renderLista();
  }
  // Ícone do cartão: um desenho pelo tema do nome (e, sem tema no nome, da descrição) e uma cor de destaque própria,
  // fixa por skill, tirada das cores de projeto do Orbit (CORES_PROJ do index.html). O resto do cartão fica neutro.
  const CORES = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899'];
  const TEMAS = [ // a primeira regra que casa vence: git e tarefas antes de "escrever" e "análise"
    [/git|commit|\bpr\b|-pr\b|pull|branch|merge|revis|review|changelog|diff/, 'branch'],
    [/trello|tarefa|task|kanban|plano|todo/, 'lista'],
    [/pdf|docx?\b|docs\b|word|documento|readme|markdown|escrev|texto|carta|relat/, 'doc'],
    [/xlsx|planilha|sheet|excel|csv|dados|grafico|chart|metric|financ|orcamento/, 'grafico'],
    [/pptx|slide|apresenta|design|paleta|figma|visual|imagem|image|marca/, 'paleta'],
    [/deploy|publica|release|build|vercel|lanca/, 'foguete'],
    [/test|\bqa\b|-qa\b|bug|verific|valid/, 'check'],
    [/browser|chrome|naveg|web\b|site|url/, 'globo'],
    [/research|pesquis|busca|search|investig|analis/, 'busca'],
    [/terminal|shell|bash|comando|computer|desktop|\bcli\b/, 'terminal'],
    [/memor|cofre|nota|diario|resumo|brief|morning|agenda|calend/, 'livro'],
    [/mobile|android|\bios\b/, 'cubo'],
    [/skill|creator|template|modelo/, 'varinha'],
  ];
  function hashTxt(t) { let n = 0; for (const c of String(t)) n = (n * 31 + c.codePointAt(0)) >>> 0; return n; }
  function visualSkill(s) {
    const nome = String(s.nome || '').toLowerCase();
    const desc = String(s.descricao || '').toLowerCase();
    const achar = (t) => (TEMAS.find(([re]) => re.test(t)) || [])[1];
    return { ic: achar(nome) || achar(desc.slice(0, 160)) || 'varinha', cor: CORES[hashTxt(String(s.nome || '').split(':').pop()) % CORES.length] };
  }
  function iconeSkill(s, classe, tam) {
    const v = visualSkill(s);
    const el = h('span', { class: classe, 'aria-hidden': 'true' }, icone(v.ic, tam));
    el.style.setProperty('--c', v.cor);
    return el;
  }
  const nomeProj = (pasta) => {
    const p = st.dados && (st.dados.projetos || []).find((x) => x.pasta === pasta);
    return p ? p.nome : String(pasta || '').split(/[\\/]/).filter(Boolean).pop() || '';
  };
  const casaTxt = MAC ? '~/.claude/skills' : '%USERPROFILE%\\.claude\\skills';

  async function pedir(caminho, corpo) {
    const r = await fetch(caminho, corpo === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
    let d = null;
    try { d = await r.json(); } catch {}
    if (!r.ok) {
      // 404 sem o JSON do skills.mjs (ou com o "não encontrado" genérico do servidor): a rota não existe,
      // o servidor em execução é anterior à aba Skills (ou o módulo não carregou).
      const semRota = r.status === 404 && (!d || !d.erro || d.erro === 'não encontrado');
      const e = new Error(semRota ? 'O servidor do Orbit em execução ainda não tem a aba Skills. Reinicie o Orbit para carregar.' : (d && d.erro) || 'O servidor respondeu ' + r.status + '.');
      e.status = r.status;
      e.codigo = semRota ? 'sem_rota' : d && d.codigo;
      throw e;
    }
    return d;
  }
  // POST que mexe na pasta pessoal: pergunta antes; se o servidor pedir confirmação (428), pergunta e repete.
  async function pedirComGlobal(caminho, corpo, global, acao) {
    if (global && !(await confirmarGlobal(acao))) return null;
    try {
      return await pedir(caminho, global ? { ...corpo, confirmarGlobal: true } : corpo);
    } catch (e) {
      if (e.codigo !== 'confirmar_global' || global) throw e;
      if (!(await confirmarGlobal(acao))) return null;
      return pedir(caminho, { ...corpo, confirmarGlobal: true });
    }
  }

  // ───────────────────────────── modal ─────────────────────────────
  function modal({ titulo, texto, campos = [], ok = 'Confirmar', perigo = false, nota }) {
    return new Promise((resolve) => {
      const anterior = document.activeElement;
      const fim = (v) => { fundo.remove(); try { anterior && anterior.focus({ preventScroll: true }); } catch {} resolve(v); };
      const bOk = h('button', { type: 'button', class: 'btn' + (perigo ? ' sk-perigo' : ' solido') }, ok);
      const bNao = h('button', { type: 'button', class: 'btn contorno' }, 'Cancelar');
      const caixa = h('div', { class: 'sk-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': titulo },
        h('h3', null, titulo),
        texto ? h('p', null, texto) : null,
        ...campos.map((c) => c.el),
        nota ? h('p', { class: 'sk-modal-nota' }, nota) : null,
        h('div', { class: 'sk-modal-pe' }, bNao, bOk));
      const fundo = h('div', { class: 'sk-veu' }, caixa);
      bOk.addEventListener('click', () => fim(true));
      bNao.addEventListener('click', () => fim(false));
      fundo.addEventListener('pointerdown', (e) => { if (e.target === fundo) fim(false); });
      caixa.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); fim(false); }
        else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') { e.preventDefault(); fim(true); }
      });
      document.body.append(fundo);
      (campos[0] && campos[0].foco ? campos[0].foco : bNao).focus();
    });
  }
  function confirmarGlobal(acao) {
    return modal({
      titulo: acao + ' nas skills pessoais?',
      texto: 'Isso muda ' + casaTxt + ', a pasta global do Claude Code. A mudança vale para todos os projetos e também para o Claude Code fora do Orbit (VS Code e terminal).',
      nota: 'O padrão do Orbit é o projeto. Só confirme se quer mesmo a skill em todos os projetos.',
      ok: 'Confirmar mudança global',
      perigo: true,
    });
  }

  // ───────────────────────────── estrutura ─────────────────────────────
  function montar() {
    if (ui.vista) return;
    ui.proj = listaSelect(h('select', { class: 'sk-campo sk-sel', 'aria-label': 'Projeto' }));
    ui.busca = h('input', { class: 'sk-campo sk-busca', type: 'search', placeholder: 'Buscar por nome ou descrição', 'aria-label': 'Buscar skills', spellcheck: 'false', autocomplete: 'off' });
    ui.nova = h('button', { type: 'button', class: 'btn solido sk-nova' }, icone('mais', 14), h('span', null, 'Nova skill'));
    ui.n = h('p', { class: 'sk-n' });
    ui.filtros = h('div', { class: 'sk-filtros', role: 'toolbar', 'aria-label': 'Filtros' });
    // Rodapé discreto: onde o ativo/inativo fica gravado e os avisos do servidor, num lugar só.
    ui.info = h('footer', { class: 'sk-info' });
    ui.lista = h('div', { class: 'sk-lista', role: 'list', 'aria-label': 'Skills' });
    ui.ed = h('section', { class: 'sk-ed', 'aria-label': 'Editor da skill', hidden: true });
    ui.corpo = h('div', { class: 'sk-corpo' }, ui.lista, ui.ed);
    ui.vista = h('div', { class: 'sk', tabindex: '-1' },
      h('header', { class: 'sk-cab' },
        h('div', { class: 'sk-tit' }, h('h1', null, 'Skills'), ui.n),
        h('div', { class: 'sk-ferr' },
          h('label', { class: 'sk-proj', title: 'Projeto' }, icone('pasta', 14), ui.proj, h('span', { class: 'sk-sel-seta', 'aria-hidden': 'true' }, icone('chevron', 12))),
          h('label', { class: 'sk-busca-w' }, icone('busca', 14), ui.busca),
          ui.nova)),
      ui.filtros,
      ui.corpo,
      ui.info);
    ui.proj.addEventListener('change', async () => {
      if (!(await podeSair())) { ui.proj.value = st.pasta; return; }
      st.pasta = ui.proj.value;
      gravarPasta(st.pasta);
      fecharEditor();
      carregar();
    });
    ui.busca.addEventListener('input', () => { st.filtro = ui.busca.value.trim().toLowerCase(); renderLista(); });
    ui.busca.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.busca.value) { e.preventDefault(); ui.busca.value = ''; st.filtro = ''; renderLista(); } });
    ui.nova.addEventListener('click', () => abrirNova());
    ui.vista.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); if (st.arq) salvarArquivo(); else if (st.ed && st.ed.editavel) salvar(); return; }
      // Nada daqui dispara os atalhos globais da lista (j/k, Enter, Espaço…).
      if (e.target !== ui.vista) e.stopPropagation();
    });
    window.addEventListener('resize', () => { if (st.visivel && ui.fCorpo) crescer(ui.fCorpo); });
    renderEditor();
  }

  function criarAba(painel) {
    montar();
    painel.classList.add('aba-skills');
    painel.append(ui.vista);
    // O realce do item da lateral é do index.html (focoDasAbas), como o das Ideias.
    const mostrar = () => { st.visivel = true; carregar(); };
    const esconder = () => { st.visivel = false; };
    mostrar();
    return {
      mostrar,
      esconder,
      destruir: () => { esconder(); ui.vista.remove(); st.sel = null; st.ed = null; st.arq = null; renderEditor(); },
      focar: () => { if (!ui.vista.contains(document.activeElement)) ui.vista.focus({ preventScroll: true }); },
    };
  }
  for (const b of botoes) b.addEventListener('click', () => { try { window.Orbit && window.Orbit.abrirSkills && window.Orbit.abrirSkills(); } catch (e) { console.warn('skills', e); } });
  try { window.Orbit.pedirConfirmacaoAoFechar('skills', () => sujo()); } catch {}

  // ───────────────────────────── dados ─────────────────────────────
  async function carregar() {
    const g = ++st.geracao;
    st.carregando = true;
    if (!st.dados) {
      renderProjetos();
      renderLista();
      // A 1ª leitura espera a sonda do Claude Code (alguns segundos): o seletor já mostra os projetos da lateral.
      carregarReserva().then(() => { if (!st.dados && g === st.geracao) renderProjetos(); });
    }
    try {
      const d = await pedir('/skills' + (st.pasta ? '?pasta=' + encodeURIComponent(st.pasta) : ''));
      if (g !== st.geracao) return;
      st.dados = d;
      st.erro = '';
      st.semRota = false;
      if (d.pasta && d.pasta !== st.pasta) { st.pasta = d.pasta; gravarPasta(d.pasta); }
    } catch (e) {
      if (g !== st.geracao) return;
      // Pasta guardada que não é mais conhecida (ou noutra grafia): volta para a primeira. Só com o código do
      // skills.mjs; o 404 genérico é o servidor sem a rota e repetir não adianta.
      if ((e.codigo === 'pasta_desconhecida' || /^Pasta desconhecida/.test(e.message)) && st.pasta) { st.pasta = ''; return carregar(); }
      st.erro = e.message;
      st.semRota = e.codigo === 'sem_rota';
      if (st.semRota) st.dados = null;
      if (!st.dados) await carregarReserva();
      if (g !== st.geracao) return;
    }
    st.carregando = false;
    renderProjetos();
    renderLista();
    // A skill aberta continua aberta (e some do editor se foi excluída por fora).
    if (st.sel && st.sel !== '+novo' && !sujo() && !skillPorId(st.sel)) fecharEditor();
  }
  function receber(d) {
    if (!st.visivel) return; // a aba relê ao aparecer
    if (!d || !d.pasta || d.pasta === st.pasta) carregar();
  }
  const skillPorId = (id) => (st.dados && st.dados.skills || []).find((s) => s.id === id);

  // ───────────────────────────── lista ─────────────────────────────
  // Seletor de projeto: a lista do /skills; sem ela (servidor sem a rota, erro), a do /projetos da lateral,
  // para o seletor nunca ficar vazio. A pasta guardada pode vir noutra grafia (maiúsculas no Windows).
  async function carregarReserva() {
    if (st.projetosReserva) return;
    try {
      const r = await fetch('/projetos', { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (j && Array.isArray(j.projetos)) st.projetosReserva = j.projetos.filter((p) => p && p.pasta && p.existe !== false).map((p) => ({ pasta: String(p.pasta), nome: String(p.nome || p.pasta) }));
    } catch {}
  }
  const mesmaPasta = (a, b) => {
    const n = (x) => String(x || '').replace(/[\\/]+$/, '');
    return MAC ? n(a) === n(b) : n(a).replace(/\//g, '\\').toLowerCase() === n(b).replace(/\//g, '\\').toLowerCase();
  };
  function renderProjetos() {
    const daLista = st.dados && Array.isArray(st.dados.projetos) && st.dados.projetos.length ? st.dados.projetos : null;
    const l = daLista || st.projetosReserva || [];
    const ops = l.map((p) => h('option', { value: p.pasta, title: p.pasta }, p.nome || nomeProj(p.pasta)));
    if (!ops.length) ops.push(h('option', { value: '', disabled: true }, st.carregando ? 'Carregando projetos…' : 'Nenhum projeto'));
    ui.proj.replaceChildren(...ops);
    const achado = l.find((p) => mesmaPasta(p.pasta, st.pasta));
    if (achado && achado.pasta !== st.pasta && daLista) { st.pasta = achado.pasta; gravarPasta(st.pasta); }
    ui.proj.value = achado ? achado.pasta : l[0] ? l[0].pasta : '';
    ui.proj.title = ui.proj.value || 'Projeto';
    ui.proj.disabled = !l.length;
  }
  function ativa(s) { return s.estado !== 'off' && s.estado !== 'user-invocable-only' && !s.sombreada; }
  const rotEstado = (v) => (ESTADOS.find(([x]) => x === v) || [])[1] || 'Ativa';
  const dicaEstado = (v) => (ESTADOS.find(([x]) => x === v) || [])[2] || '';
  const casaBusca = (s, f) => !f || s.nome.toLowerCase().includes(f) || (s.descricao || '').toLowerCase().includes(f) || (s.chave || '').toLowerCase().includes(f);

  // Filtros: chips sólidos, como os selos do app. Um por vez em cada grupo; clicar de novo desmarca (sem chip = todas).
  function renderFiltros(todas) {
    const porOrigem = (o) => todas.filter((s) => s.origem === o).length;
    const porEstado = (v) => todas.filter((s) => classeEstado(s) === v).length;
    const nFav = todas.filter((s) => st.fav.has(s.id)).length;
    if (st.fFav && !nFav) st.fFav = false;
    const origens = GRUPOS.filter(([o]) => porOrigem(o) || st.fOrigem === o).map(([o]) => [o, (ORIGEM[o] || [o])[0]]);
    if (st.fOrigem && !origens.some(([o]) => o === st.fOrigem)) st.fOrigem = '';
    const chip = (rot, n, marcado, dica, clique, ic) => h('button', {
      type: 'button', class: 'sk-chip', 'aria-pressed': String(marcado), title: dica || null,
      onclick: () => { clique(); renderLista(); },
    }, ic ? icone(ic, 12) : null, h('span', null, rot), h('span', { class: 'sk-chip-n num' }, String(n)));
    const grupo = (rot, ...filhos) => h('div', { class: 'sk-chips', role: 'group', 'aria-label': rot }, ...filhos);
    const partes = [];
    if (nFav) partes.push(grupo('Favoritas', chip('Favoritas', nFav, st.fFav, 'Só as que você marcou com a estrela', () => { st.fFav = !st.fFav; }, 'estrela')));
    if (origens.length > 1 || st.fOrigem) {
      partes.push(grupo('Origem', ...origens.map(([o, r]) => chip(r, porOrigem(o), st.fOrigem === o, (ORIGEM[o] || [])[1], () => { st.fOrigem = st.fOrigem === o ? '' : o; }))));
    }
    partes.push(grupo('Estado', ...FILTRO_ESTADO.filter(([v]) => porEstado(v) || st.fEstado === v).map(([v, r]) => chip(r, porEstado(v), st.fEstado === v, null, () => { st.fEstado = st.fEstado === v ? '' : v; }))));
    const algum = st.fOrigem || st.fEstado || st.fFav;
    const filhos = [];
    partes.forEach((p, i) => { if (i) filhos.push(h('span', { class: 'sk-chips-sep', 'aria-hidden': 'true' })); filhos.push(p); });
    if (algum) filhos.push(h('button', { type: 'button', class: 'sk-limpar', onclick: () => { st.fOrigem = st.fEstado = ''; st.fFav = false; renderLista(); } }, icone('x', 12), 'Limpar'));
    ui.filtros.replaceChildren(...filhos);
    ui.filtros.hidden = !todas.length;
  }
  function limparFiltros() {
    st.fOrigem = st.fEstado = st.filtro = '';
    st.fFav = false;
    ui.busca.value = '';
    renderLista();
  }

  function esqueleto() {
    return h('div', { class: 'sk-grupo', role: 'presentation', 'aria-busy': 'true' },
      h('div', { class: 'sk-grupo-tit sk-esq-tit' }, h('span', { class: 'sk-esq sk-esq-l' })),
      h('div', { class: 'sk-cards', role: 'presentation' }, ...[0, 1, 2, 3].map(() => h('div', { class: 'sk-item sk-item-esq', 'aria-hidden': 'true' },
        h('span', { class: 'sk-esq sk-esq-ic' }), h('span', { class: 'sk-esq sk-esq-a' }), h('span', { class: 'sk-esq sk-esq-b' })))));
  }
  // Estado vazio da aba: o que são skills e como criar a primeira.
  function vazioAmigavel() {
    const passo = (n, t, d) => h('li', null, h('span', { class: 'sk-boas-n num' }, String(n)), h('div', null, h('b', null, t), h('span', null, d)));
    return h('div', { class: 'sk-boas' },
      h('span', { class: 'sk-boas-ic', 'aria-hidden': 'true' }, icone('varinha', 22)),
      h('h2', null, 'Nenhuma skill por aqui ainda'),
      h('p', { class: 'sk-boas-txt' }, 'Skills são instruções prontas que o Claude carrega quando o pedido combina com a descrição delas, ou quando você chama ', h('code', null, '/nome'), '. Cada uma é uma pasta com um SKILL.md e, se precisar, scripts e modelos de apoio.'),
      h('ol', { class: 'sk-boas-passos' },
        passo(1, 'Dê um nome curto', 'minúsculas e hífen, como revisar-pr; vira o /revisar-pr'),
        passo(2, 'Descreva quando usar', 'é pela descrição que o Claude decide chamar a skill'),
        passo(3, 'Escreva os passos', 'em Markdown, do jeito que você explicaria a alguém do time')),
      h('div', { class: 'sk-boas-acoes' },
        h('button', { type: 'button', class: 'btn solido', onclick: () => abrirNova() }, icone('mais', 14), h('span', null, 'Criar a primeira skill'))),
      h('p', { class: 'sk-boas-nota mono' }, '.claude/skills/<nome>/SKILL.md · em ' + (nomeProj(st.pasta) || 'este projeto')));
  }
  // Grupo "Projeto" sem skills (com outras origens na lista): convite para criar a primeira do projeto.
  function vazioProjeto() {
    const proj = nomeProj(st.pasta) || 'este projeto';
    return h('div', { class: 'sk-vazio-proj' },
      h('div', { class: 'sk-vp-arte', 'aria-hidden': 'true' },
        h('span', { class: 'sk-vp-ic' }, icone('varinha', 20)),
        h('span', { class: 'sk-vp-mais' }, icone('mais', 11))),
      h('div', { class: 'sk-vp-txt' },
        h('h3', null, 'Nenhuma skill em ' + proj + ' ainda'),
        h('p', null, 'Ensine ao Claude um jeito de trabalhar só deste projeto. A skill fica em ', h('code', null, '.claude/skills'), ' e vai junto no git.')),
      h('button', { type: 'button', class: 'btn solido sk-vp-btn', onclick: () => abrirNova() }, icone('mais', 14), h('span', null, 'Criar a primeira')));
  }
  function painelErro() {
    return h('div', { class: 'sk-boas sk-boas-erro', role: 'alert' },
      h('span', { class: 'sk-boas-ic', 'aria-hidden': 'true' }, icone('alerta', 20)),
      h('h2', null, st.semRota ? 'A aba Skills ainda não está no servidor' : 'Não deu para ler as skills'),
      h('p', { class: 'sk-boas-txt' }, st.erro),
      h('div', { class: 'sk-boas-acoes' }, h('button', { type: 'button', class: 'btn contorno', onclick: () => carregar() }, 'Tentar de novo')));
  }

  function renderLista() {
    const d = st.dados;
    ui.corpo.classList.toggle('com-ed', !!st.ed);
    if (!d) {
      ui.lista.replaceChildren(st.erro ? painelErro() : esqueleto());
      ui.info.replaceChildren();
      ui.filtros.replaceChildren();
      ui.filtros.hidden = true;
      ui.n.textContent = st.erro ? '' : 'Carregando…';
      return;
    }
    const todas = d.skills || [];
    const nAtivas = todas.filter(ativa).length;
    const nOff = todas.filter((s) => s.estado === 'off').length;
    const resumo = [h('span', null, h('b', { class: 'num' }, String(todas.length)), todas.length === 1 ? ' skill' : ' skills')];
    if (todas.length) resumo.push(h('span', null, h('b', { class: 'num' }, String(nAtivas)), nAtivas === 1 ? ' ativa' : ' ativas'));
    if (nOff) resumo.push(h('span', null, h('b', { class: 'num' }, String(nOff)), nOff === 1 ? ' inativa' : ' inativas'));
    ui.n.replaceChildren(...resumo);
    renderFiltros(todas);
    // Rodapé: a regra do ativo/inativo e, abaixo, os avisos (com o ponto âmbar), tudo no mesmo lugar.
    const info = [h('p', { class: 'sk-info-l' }, icone('info', 13), h('span', null, 'Ativar e desativar vale só para ', h('b', null, nomeProj(st.pasta) || 'o projeto'), ' e fica gravado em ', h('code', null, '.claude/settings.json'), ', que vai junto no git.'))];
    const avisos = [];
    if (d.sonda && !d.sonda.ok) avisos.push(['Sem a leitura do Claude Code: plugins e o estado efetivo podem faltar.', d.sonda.erro || '']);
    for (const a of d.avisos || []) avisos.push([a, '']);
    if (st.erro) avisos.push([st.erro, '']);
    for (const [t, dica] of avisos) info.push(h('p', { class: 'sk-info-l sk-aviso', title: dica || null }, h('i', { class: 'sk-ponto', 'aria-hidden': 'true' }), h('span', null, t)));
    ui.info.replaceChildren(...info);
    ui.info.hidden = false;
    if (!todas.length) {
      ui.lista.replaceChildren(st.ed ? h('div', { class: 'sk-vazio-mini' },
        h('span', { class: 'sk-vazio-mini-ic', 'aria-hidden': 'true' }, icone('varinha', 15)),
        h('div', null, h('b', null, 'Nenhuma skill ainda'), h('span', null, 'A que você criar aparece aqui.'))) : vazioAmigavel());
      return;
    }
    const f = st.filtro;
    const filtrando = !!(f || st.fOrigem || st.fEstado || st.fFav);
    const vis = todas.filter((s) => casaBusca(s, f) && (!st.fOrigem || s.origem === st.fOrigem) && (!st.fEstado || classeEstado(s) === st.fEstado) && (!st.fFav || st.fav.has(s.id)));
    // Favoritas primeiro dentro de cada grupo; o resto na ordem do servidor.
    const ordenar = (l) => l.filter((s) => st.fav.has(s.id)).concat(l.filter((s) => !st.fav.has(s.id)));
    const titulo = (rot, l, dica) => {
      const ro = l.length > 0 && l.every((s) => !s.editavel);
      return h('h2', { class: 'sk-grupo-tit', title: dica || '' }, rot, h('span', { class: 'num' }, String(l.length)),
        ro ? h('span', { class: 'sk-grupo-ro', title: 'Só leitura: duplique no projeto para editar' }, icone('cadeado', 11), 'só leitura') : null);
    };
    const blocos = [];
    for (const [origem, rot] of GRUPOS) {
      const l = ordenar(vis.filter((s) => s.origem === origem));
      if (!l.length && !(origem === 'projeto' && !filtrando)) continue;
      const grupoRo = l.length > 0 && l.every((s) => !s.editavel);
      blocos.push(h('div', { class: 'sk-grupo', role: 'presentation' },
        titulo(rot, l, (ORIGEM[origem] || [])[1]),
        l.length ? h('div', { class: 'sk-cards', role: 'presentation' }, ...l.map((s) => cartao(s, grupoRo)))
          : vazioProjeto()));
    }
    const outras = vis.filter((x) => !GRUPOS.some(([o]) => o === x.origem));
    if (outras.length) blocos.push(h('div', { class: 'sk-grupo', role: 'presentation' }, titulo('Outras', outras), h('div', { class: 'sk-cards', role: 'presentation' }, ...ordenar(outras).map((s) => cartao(s, false)))));
    if (!blocos.length) {
      blocos.push(h('div', { class: 'sk-sem-res' },
        icone('busca', 18),
        h('p', null, f ? 'Nenhuma skill com “' + st.filtro + '”' + (st.fOrigem || st.fEstado ? ' nesses filtros.' : '.') : 'Nenhuma skill nesses filtros.'),
        h('button', { type: 'button', class: 'btn contorno', onclick: () => limparFiltros() }, 'Limpar filtros')));
    }
    ui.lista.replaceChildren(...blocos);
  }
  // Cartão: monograma em destaque, nome e uma linha de descrição. Nos cantos, só o essencial: favorito e menu "⋯"
  // (aparecem no hover; a estrela fica se marcada) e o interruptor. Origem e estado viram indicadores sutis: o grupo
  // já diz a origem, o interruptor diz ativa/inativa e só as exceções ganham marca (só por /nome, escondida, só
  // leitura fora de um grupo só leitura). O resto vai no title do cartão e no editor.
  function cartao(s, grupoRo) {
    const ligada = s.estado !== 'off';
    const chave = h('input', { type: 'checkbox', class: 'chave sk-chave', 'aria-label': (ligada ? 'Desativar ' : 'Ativar ') + s.nome + ' neste projeto' });
    chave.checked = ligada;
    if (s.travada) { chave.disabled = true; chave.title = s.motivoTrava || 'Não muda pelo projeto'; }
    else chave.title = ligada ? 'Desativar neste projeto' : 'Ativar neste projeto';
    chave.addEventListener('click', (e) => e.stopPropagation());
    chave.addEventListener('keydown', (e) => e.stopPropagation());
    chave.addEventListener('change', () => mudarEstado(s, chave.checked ? 'on' : 'off', chave));
    const fav = st.fav.has(s.id);
    const bFav = h('button', { type: 'button', class: 'sk-acao sk-fav' + (fav ? ' on' : ''), 'aria-pressed': String(fav), title: fav ? 'Tirar dos favoritos' : 'Favoritar', 'aria-label': (fav ? 'Tirar dos favoritos: ' : 'Favoritar: ') + s.nome }, icone('estrela', 13));
    bFav.addEventListener('click', (e) => { e.stopPropagation(); alternarFav(s); });
    const bMenu = h('button', { type: 'button', class: 'sk-acao sk-mais', title: 'Mais ações', 'aria-label': 'Mais ações: ' + s.nome, 'aria-haspopup': 'menu' }, icone('pontos', 14));
    bMenu.addEventListener('click', (e) => { e.stopPropagation(); menuCartao(s, bMenu); });
    for (const b of [bFav, bMenu]) b.addEventListener('keydown', (e) => e.stopPropagation());
    // Marcas das exceções, ao lado do nome
    const marcas = [];
    if (s.estado === 'user-invocable-only') marcas.push(h('span', { class: 'sk-marca mono', title: dicaEstado(s.estado) }, '/nome'));
    if (s.sombreada) marcas.push(h('span', { class: 'sk-marca-ic sk-m-aviso', title: 'Há uma skill pessoal com o mesmo nome; no Claude Code a pessoal vence e esta fica escondida. Renomeie uma das duas.' }, icone('alerta', 12), h('span', { class: 'sk-sr' }, 'escondida pela pessoal')));
    if (!s.editavel && !grupoRo) marcas.push(h('span', { class: 'sk-marca-ic', title: 'Só leitura: duplique no projeto para editar' }, icone('cadeado', 11), h('span', { class: 'sk-sr' }, 'só leitura')));
    const org = (ORIGEM[s.origem] || [s.origem])[0];
    const dica = [s.nome, org + ' · ' + rotEstado(s.estado) + (s.editavel ? '' : ' · só leitura') + (s.travada ? ' · ' + (s.motivoTrava || 'travada') : ''), s.descricao || ''].filter(Boolean).join('\n');
    const it = h('div', { class: 'sk-item' + (st.sel === s.id ? ' sel' : '') + (ligada ? '' : ' off') + (s.sombreada ? ' somb' : '') + (fav ? ' fav' : ''), role: 'listitem', tabindex: '0', 'data-id': s.id, 'aria-current': st.sel === s.id ? 'true' : null, title: dica },
      h('div', { class: 'sk-item-topo' },
        iconeSkill(s, 'sk-item-ic', 18),
        h('span', { class: 'sk-item-ctl' }, bFav, bMenu, chave)),
      h('div', { class: 'sk-item-txt' },
        h('div', { class: 'sk-nome-l' }, h('span', { class: 'sk-nome' }, s.nome), ...marcas),
        h('p', { class: 'sk-desc' }, s.descricao || 'Sem descrição')),
      h('span', { class: 'sk-sr' }, org + ', ' + rotEstado(s.estado) + (s.editavel ? '' : ', só leitura')));
    it.addEventListener('click', () => abrir(s.id));
    it.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === it) { e.preventDefault(); abrir(s.id); }
      else if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && e.target === it) { e.preventDefault(); menuCartao(s, bMenu); }
    });
    it.addEventListener('contextmenu', (e) => { e.preventDefault(); menuCartao(s, bMenu, e); });
    return it;
  }

  // Menu "⋯" do cartão (e do botão direito): no estilo do menu da árvore de arquivos.
  let menuAberto = null;
  function fecharMenu(devolverFoco) {
    if (!menuAberto) return;
    const { el, origem, limpar } = menuAberto;
    menuAberto = null;
    limpar();
    el.remove();
    origem.removeAttribute('aria-expanded');
    if (devolverFoco) try { origem.focus({ preventScroll: true }); } catch {}
  }
  function menuCartao(s, botao, ev) {
    if (menuAberto && menuAberto.origem === botao && !ev) return fecharMenu(true);
    fecharMenu();
    const fav = st.fav.has(s.id);
    const itens = [
      [s.editavel ? 'Editar' : 'Abrir', 'lapis', () => abrir(s.id)],
      ['Copiar /' + s.nome, 'copiar', async () => { try { await navigator.clipboard.writeText('/' + s.nome); toast('Copiado: /' + s.nome); } catch { toast('Não deu para copiar.'); } }],
      [fav ? 'Tirar dos favoritos' : 'Favoritar', 'estrela', () => alternarFav(s)],
    ];
    if (s.caminho) itens.push([s.editavel ? 'Duplicar' : 'Duplicar no projeto', 'copiar', () => duplicar(s)]);
    if (s.editavel) itens.push(null, ['Excluir', 'lixeira', () => excluir(s), true]);
    const el = h('div', { class: 'sk-menu', role: 'menu', 'aria-label': 'Ações de ' + s.nome },
      ...itens.map((x) => x ? h('button', { type: 'button', role: 'menuitem', class: 'sk-mi' + (x[3] ? ' perigo' : ''), tabindex: '-1', onclick: (e) => { e.stopPropagation(); fecharMenu(!x[3]); x[2](); } }, icone(x[1], 13), h('span', null, x[0]))
        : h('div', { class: 'sk-menu-sep', role: 'separator' })));
    mostrarMenu(el, botao, ev, false);
  }
  // Lista dos <select> da aba: o <select> continua (valor, evento change, teclado), mas a lista que abre é a do
  // Orbit, no estilo do menu "⋯", em vez da lista nativa do sistema.
  function listaSelect(sel) {
    const abrirLista = () => {
      if (sel.disabled) return;
      if (menuAberto && menuAberto.origem === sel) return fecharMenu(true);
      fecharMenu();
      const ops = [...sel.options];
      if (!ops.length) return;
      const el = h('div', { class: 'sk-menu sk-lista-sel', role: 'listbox', 'aria-label': sel.getAttribute('aria-label') || 'Opções' },
        ...ops.map((o) => h('button', {
          type: 'button', role: 'option', class: 'sk-mi sk-op' + (o.selected ? ' on' : ''), tabindex: '-1',
          'aria-selected': o.selected ? 'true' : 'false', disabled: o.disabled ? true : null,
          onclick: (e) => {
            e.stopPropagation();
            fecharMenu(true);
            if (sel.value !== o.value) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
          },
        }, h('span', { class: 'sk-op-txt' }, h('span', null, o.textContent), o.title ? h('small', null, o.title) : null), o.selected ? icone('check', 13) : null)));
      el.style.minWidth = sel.getBoundingClientRect().width + 'px';
      mostrarMenu(el, sel, null, true);
    };
    sel.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { sel.focus({ preventScroll: true }); } catch {}
      abrirLista();
    });
    sel.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || !['Enter', ' ', 'ArrowDown', 'ArrowUp', 'F4'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation(); // dentro do modal, o Enter abre a lista em vez de confirmar
      abrirLista();
    });
    return sel;
  }
  // Põe o menu na tela abaixo da origem (alinhado à esquerda ou à direita, ou no ponto do clique direito), sem sair
  // da janela, e liga o teclado (setas, Esc, Tab) e o fechar ao clicar fora, rolar ou redimensionar.
  function mostrarMenu(el, origem, ev, aEsquerda) {
    document.body.append(el);
    const r = origem.getBoundingClientRect(), w = el.offsetWidth, hh = el.offsetHeight;
    let x = ev ? ev.clientX : aEsquerda ? r.left : r.right - w, y = ev ? ev.clientY : r.bottom + 6;
    x = Math.max(8, Math.min(x, innerWidth - w - 8));
    if (y + hh > innerHeight - 8) y = Math.max(8, (ev ? ev.clientY : r.top - 6) - hh);
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    origem.setAttribute('aria-expanded', 'true');
    const botoesMenu = [...el.querySelectorAll('.sk-mi:not(:disabled)')];
    // Clicar na própria origem não conta como "fora": quem trata é ela (abre e fecha no mesmo botão).
    const fora = (e) => { if (!el.contains(e.target) && !origem.contains(e.target)) fecharMenu(); };
    const tecla = (e) => {
      const i = botoesMenu.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); fecharMenu(true); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = botoesMenu.length; botoesMenu[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n].focus(); }
      else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); botoesMenu[e.key === 'Home' ? 0 : botoesMenu.length - 1].focus(); }
      else if (e.key === 'Tab') fecharMenu();
      e.stopPropagation();
    };
    const sair = (e) => { if (!(e && e.type === 'scroll' && el.contains(e.target))) fecharMenu(); };
    document.addEventListener('pointerdown', fora, true);
    el.addEventListener('keydown', tecla);
    window.addEventListener('resize', sair);
    window.addEventListener('scroll', sair, true);
    menuAberto = { el, origem, limpar: () => { document.removeEventListener('pointerdown', fora, true); window.removeEventListener('resize', sair); window.removeEventListener('scroll', sair, true); } };
    const foco = el.querySelector('.sk-mi.on:not(:disabled)') || botoesMenu[0];
    if (foco) { foco.focus({ preventScroll: true }); foco.scrollIntoView({ block: 'nearest' }); }
  }

  async function mudarEstado(s, estado, controle) {
    if (controle) controle.disabled = true;
    try {
      const r = await pedir('/skills/estado', { pasta: st.pasta, chave: s.chave, estado });
      toast((estado === 'off' ? 'Desativada' : estado === 'on' ? 'Ativada' : 'Estado mudado') + ': ' + s.nome + ' em ' + nomeProj(st.pasta) + (r && r.local ? ' (a entrada do settings.local.json saiu)' : ''));
    } catch (e) {
      toast(e.message);
    }
    await carregar();
    if (st.sel === s.id) renderEditor();
  }

  // ───────────────────────────── editor ─────────────────────────────
  function sujo() {
    if (st.arq && ui.arqTexto && ui.arqTexto.value !== st.arq.base) return true;
    if (!st.ed || !st.ed.editavel || !ui.fNome) return false;
    const b = st.ed.base;
    return ui.fNome.value !== b.nome || ui.fDesc.value !== b.descricao || ui.fCorpo.value !== b.corpo || ui.fExtra.value !== b.extra || (st.sel === '+novo' && ui.fOrigem && ui.fOrigem.value !== 'projeto');
  }
  async function podeSair() {
    if (!sujo()) return true;
    return modal({ titulo: 'Descartar as alterações?', texto: 'A skill tem alterações que ainda não foram salvas.', ok: 'Descartar', perigo: true });
  }
  function fecharEditor() {
    st.sel = null;
    st.ed = null;
    st.arq = null;
    renderEditor();
    renderLista();
  }
  async function abrir(id) {
    if (st.sel === id) return;
    if (!(await podeSair())) return;
    const s = skillPorId(id);
    if (!s) return;
    st.sel = id;
    st.arq = null;
    st.ed = { carregando: true, s };
    renderLista();
    renderEditor();
    if (!s.caminho) { st.ed = { s, editavel: false, base: { nome: s.nome, descricao: s.descricao || '', corpo: '', extra: '' }, arquivos: [], semConteudo: true }; renderEditor(); return; }
    try {
      const d = await pedir('/skills/ler?' + new URLSearchParams({ pasta: st.pasta, origem: s.origem, nome: s.nome }));
      if (st.sel !== id) return;
      st.ed = { s, origem: s.origem, nomeAntigo: s.nome, editavel: !!d.editavel, base: { nome: s.nome, descricao: d.descricao, corpo: d.corpo, extra: d.extra }, arquivos: d.arquivos || [], caminho: d.caminho, aviso: d.nomeCabecalho && d.nomeCabecalho !== s.nome ? 'O name do cabeçalho ("' + d.nomeCabecalho + '") é diferente da pasta. Ao salvar, o Orbit usa o nome da pasta.' : '' };
    } catch (e) {
      if (st.sel !== id) return;
      st.ed = { s, erro: e.message };
    }
    renderEditor();
  }
  async function abrirNova() {
    if (!(await podeSair())) return;
    st.sel = '+novo';
    st.arq = null;
    st.aba = 'editar';
    st.ed = { novo: true, origem: 'projeto', nomeAntigo: null, editavel: true, base: { nome: '', descricao: '', corpo: '# Quando usar\n\n# Passos\n\n1. \n', extra: '' }, arquivos: [] };
    renderLista();
    renderEditor();
    if (ui.fNome) ui.fNome.focus();
  }

  function campo(rot, el, dica, lado) {
    return h('label', { class: 'sk-f' }, h('span', { class: 'sk-f-rot' }, h('span', null, rot), dica ? h('small', null, dica) : null, lado ? h('span', { class: 'sk-f-lado' }, lado) : null), el);
  }
  function secao(titulo, sub, ...filhos) {
    return h('section', { class: 'sk-sec' }, h('div', { class: 'sk-sec-cab' }, h('h3', null, titulo), sub ? h('p', null, sub) : null), ...filhos);
  }

  // ── realce do Markdown (instruções e prévia do SKILL.md) ──
  // Por linha: cabeçalho YAML, cercas de código, títulos, listas, citações; dentro da linha: `código`,
  // **negrito**, *itálico*, [link](url) e as variáveis da skill ($ARGUMENTS, $0, ${CLAUDE_SKILL_DIR}).
  // Só textContent: o texto da skill nunca vira HTML.
  const RE_INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\s][^*\n]*\*|(?<![\w])_[^_\s][^_\n]*_(?![\w]))|(\[[^\]\n]+\]\([^)\n]*\))|(\$\{[A-Z_][A-Z0-9_]*\}|\$(?:ARGUMENTS|[0-9]+)\b)|(!`[^`\n]+`)/g;
  function inline(alvo, txt) {
    let i = 0;
    RE_INLINE.lastIndex = 0;
    for (let m; (m = RE_INLINE.exec(txt));) {
      if (m.index > i) alvo.append(txt.slice(i, m.index));
      const cls = m[1] ? 'md-cod' : m[2] ? 'md-neg' : m[3] ? 'md-ita' : m[4] ? 'md-link' : m[5] ? 'md-var' : 'md-cmd';
      alvo.append(h('span', { class: cls }, m[0]));
      i = m.index + m[0].length;
    }
    if (i < txt.length) alvo.append(txt.slice(i));
  }
  function realcar(alvo, texto, comCabecalho) {
    const linhas = String(texto || '').replace(/\r\n/g, '\n').split('\n');
    const fr = document.createDocumentFragment();
    let cerca = false, yaml = comCabecalho && linhas[0] === '---';
    linhas.forEach((l, n) => {
      if (n) fr.append('\n');
      let m;
      if (yaml) {
        if (n > 0 && l === '---') { yaml = false; fr.append(h('span', { class: 'md-marca' }, l)); return; }
        if (n === 0) { fr.append(h('span', { class: 'md-marca' }, l)); return; }
        if ((m = /^([A-Za-z_][\w-]*)(:)(.*)$/.exec(l))) { fr.append(h('span', { class: 'md-chave' }, m[1]), h('span', { class: 'md-marca' }, m[2]), h('span', { class: 'md-valor' }, m[3])); return; }
        fr.append(h('span', { class: 'md-valor' }, l));
        return;
      }
      if (/^\s*(```|~~~)/.test(l)) { cerca = !cerca; fr.append(h('span', { class: 'md-cerca' }, l)); return; }
      if (cerca) { fr.append(h('span', { class: 'md-bloco' }, l)); return; }
      if ((m = /^(#{1,6})(\s+)(.*)$/.exec(l))) {
        const t = h('span', { class: 'md-tit md-t' + m[1].length });
        inline(t, m[3]);
        fr.append(h('span', { class: 'md-marca' }, m[1]), m[2], t);
        return;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { fr.append(h('span', { class: 'md-marca' }, l)); return; }
      if ((m = /^(\s*>+)(.*)$/.exec(l))) {
        const t = h('span', { class: 'md-cit' });
        inline(t, m[2]);
        fr.append(h('span', { class: 'md-marca' }, m[1]), t);
        return;
      }
      if ((m = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s)?(.*)$/.exec(l))) {
        fr.append(m[1], h('span', { class: 'md-lista' }, m[2]), m[3]);
        if (m[4]) fr.append(h('span', { class: 'md-lista' }, m[4]));
        inline(fr, m[5]);
        return;
      }
      inline(fr, l);
    });
    fr.append('\n '); // a última linha vazia do textarea também ocupa altura
    alvo.replaceChildren(fr);
  }
  // O mesmo SKILL.md que o servidor grava (skills.mjs, montarSkillMd).
  function yamlEscalar(v) {
    const s = String(v ?? '').replace(/\s+/g, ' ').trim();
    if (s && !/^[\s!&*?|>'"%@`#,[\]{}-]|: | #|[\u0000-\u001f]/.test(s) && !/^(true|false|null|yes|no|~|[\d.+-]+)$/i.test(s)) return s;
    return JSON.stringify(s);
  }
  function montarSkillMd({ nome, descricao, extra, corpo }) {
    const cab = ['name: ' + nome, 'description: ' + yamlEscalar(descricao)];
    const ex = String(extra || '').replace(/\r\n/g, '\n').trim();
    if (ex) cab.push(ex);
    const c = String(corpo || '').replace(/\r\n/g, '\n').replace(/^\n+/, '');
    return '---\n' + cab.join('\n') + '\n---\n\n' + c + (c.endsWith('\n') ? '' : '\n');
  }
  const textoSkillMd = () => montarSkillMd({ nome: ui.fNome.value.trim() || 'nome', descricao: ui.fDesc.value, extra: ui.fExtra.value, corpo: ui.fCorpo.value });
  function crescer(t) {
    if (!t || !t.isConnected || t.offsetParent === null) return;
    t.style.height = 'auto';
    t.style.height = t.scrollHeight + 2 + 'px';
  }
  function atualizarRealce() {
    if (!ui.fCorpo || !ui.realce) return;
    realcar(ui.realce, ui.fCorpo.value, false);
    crescer(ui.fCorpo);
    if (st.aba === 'previa' && ui.previa) realcar(ui.previa, textoSkillMd(), true);
  }
  function mudarAba(aba) {
    st.aba = aba;
    if (!ui.abas) return;
    for (const b of ui.abas.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.aba === aba));
    ui.mdEd.hidden = aba !== 'editar';
    ui.mdPrev.hidden = aba !== 'previa';
    if (aba === 'previa') realcar(ui.previa, textoSkillMd(), true);
    else { crescer(ui.fCorpo); }
  }

  function renderEditor() {
    const e = st.ed;
    ui.fNome = ui.fDesc = ui.fCorpo = ui.fExtra = ui.fOrigem = ui.arqTexto = ui.realce = ui.previa = ui.abas = ui.edMsg = null;
    ui.ed.hidden = !e;
    ui.corpo.classList.toggle('com-ed', !!e);
    if (!e) { ui.ed.replaceChildren(); return; }
    if (e.carregando) { ui.ed.replaceChildren(h('div', { class: 'sk-ed-rolo' }, h('p', { class: 'sk-vazio' }, 'Abrindo…'))); return; }
    if (e.erro) { ui.ed.replaceChildren(h('div', { class: 'sk-ed-rolo' }, h('p', { class: 'sk-vazio' }, e.erro))); return; }
    const s = e.s || {};
    const atual = e.novo ? null : skillPorId(st.sel) || s;
    // Cabeçalho do editor
    const acoes = [];
    if (!e.novo && atual && atual.caminho) acoes.push(h('button', { type: 'button', class: 'btn contorno', title: e.editavel ? 'Duplicar' : 'Duplicar no projeto para editar', onclick: () => duplicar(atual) }, icone('copiar', 14), h('span', null, e.editavel ? 'Duplicar' : 'Duplicar no projeto')));
    if (!e.novo && e.editavel) acoes.push(h('button', { type: 'button', class: 'btn-icone sk-excluir', title: 'Excluir (vai para a Lixeira)', 'aria-label': 'Excluir', onclick: () => excluir(atual) }, icone('lixeira', 15)));
    acoes.push(h('button', { type: 'button', class: 'btn-icone', title: 'Fechar', 'aria-label': 'Fechar', onclick: async () => { if (await podeSair()) fecharEditor(); } }, icone('x', 15)));
    const origem = e.novo ? 'projeto' : s.origem;
    // Linha de detalhes: origem · só leitura · tokens · caminho (o estado tem o bloco próprio logo abaixo).
    const meta = [h('span', { title: (ORIGEM[origem] || [])[1] || '' }, icone(ICONE_ORIGEM[origem] || 'varinha', 12), (ORIGEM[origem] || [origem])[0])];
    if (!e.editavel) meta.push(h('span', { title: 'Duplique no projeto para editar' }, icone('cadeado', 11), 'Só leitura'));
    if (atual && !e.novo && Number.isFinite(atual.tokens)) meta.push(h('span', { class: 'num', title: 'O que a skill ocupa na lista de skills do Claude' }, '~' + atual.tokens + ' tokens'));
    if (e.novo) meta.push(h('span', null, 'em .claude/skills de ' + (nomeProj(st.pasta) || 'este projeto')));
    const cab = h('div', { class: 'sk-ed-cab' },
      e.novo ? h('span', { class: 'sk-ed-ic sk-ed-ic-novo', 'aria-hidden': 'true' }, icone('mais', 18)) : iconeSkill(s, 'sk-ed-ic', 19),
      h('div', { class: 'sk-ed-tit' },
        h('h2', null, e.novo ? 'Nova skill' : s.nome),
        h('div', { class: 'sk-ed-sub' }, ...meta),
        !e.novo && e.caminho ? h('p', { class: 'mono sk-cam', title: e.caminho }, e.caminho) : null),
      h('div', { class: 'sk-ed-acoes' }, ...acoes));
    const partes = [cab];
    if (atual && !e.novo) partes.push(blocoEstado(atual));
    if (e.aviso) partes.push(h('p', { class: 'sk-aviso sk-aviso-ed' }, icone('info', 13), e.aviso));
    if (e.semConteudo) {
      partes.push(secao('Descrição', null, h('p', { class: 'sk-desc-long' }, s.descricao || 'Sem descrição')),
        h('p', { class: 'sk-nota-ro' }, icone('cadeado', 13), 'O conteúdo desta skill fica no ' + (s.origem === 'plugin' ? 'plugin' : 'Claude Code') + ' e não é editável pelo Orbit.'));
      ui.ed.replaceChildren(h('div', { class: 'sk-ed-rolo' }, ...partes));
      return;
    }
    const ro = !e.editavel;
    ui.fNome = h('input', { class: 'sk-campo mono', type: 'text', maxlength: 64, spellcheck: 'false', autocomplete: 'off', placeholder: 'revisar-pr', value: e.base.nome });
    ui.fDesc = h('textarea', { class: 'sk-campo sk-desc-ed', rows: 3, maxlength: MAX_DESC, placeholder: 'O que a skill faz e quando o Claude deve usá-la. Ex.: Revisa pull requests deste app; use quando pedirem revisão de PR.', value: e.base.descricao });
    ui.fCorpo = h('textarea', { class: 'sk-campo sk-corpo-ed mono', rows: 14, spellcheck: 'false', wrap: 'soft', value: e.base.corpo, placeholder: 'Instruções em Markdown' });
    ui.fExtra = h('textarea', { class: 'sk-campo mono', rows: 3, spellcheck: 'false', value: e.base.extra, placeholder: 'allowed-tools: Read, Grep\nargument-hint: [arquivo]' });
    for (const c of [ui.fNome, ui.fDesc, ui.fCorpo, ui.fExtra]) { c.readOnly = ro; c.addEventListener('input', atualizarPe); }
    ui.fCorpo.addEventListener('input', atualizarRealce);
    ui.fCorpo.addEventListener('keydown', (ev) => {
      // Tab recua com dois espaços (Shift+Tab sai do campo, como de costume).
      if (ev.key !== 'Tab' || ev.shiftKey || ro) return;
      ev.preventDefault();
      const t = ui.fCorpo, a = t.selectionStart, b = t.selectionEnd;
      t.setRangeText('  ', a, b, 'end');
      t.dispatchEvent(new Event('input', { bubbles: true }));
    });
    ui.nomeDica = h('small', null);
    ui.descConta = h('span', { class: 'sk-conta num' });
    const ident = [];
    if (e.novo) {
      ui.fOrigem = h('select', { class: 'sk-campo sk-sel', 'aria-label': 'Onde salvar' },
        h('option', { value: 'projeto' }, 'Projeto · ' + (nomeProj(st.pasta) || 'este projeto') + ' (padrão)'),
        h('option', { value: 'pessoal' }, 'Pessoal · global, todos os projetos'));
      listaSelect(ui.fOrigem).addEventListener('change', atualizarPe);
      ident.push(campo('Onde salvar', h('span', { class: 'sk-sel-w' }, ui.fOrigem, h('span', { class: 'sk-sel-seta', 'aria-hidden': 'true' }, icone('chevron', 12)))));
    }
    ident.push(
      h('label', { class: 'sk-f' }, h('span', { class: 'sk-f-rot' }, h('span', null, 'Nome'), h('span', { class: 'sk-f-lado' }, ui.nomeDica)), h('span', { class: 'sk-nome-w' }, h('span', { class: 'sk-nome-barra mono', 'aria-hidden': 'true' }, '/'), ui.fNome)),
      campo('Descrição', ui.fDesc, null, ui.descConta));
    // Instruções: editor com realce e prévia do SKILL.md inteiro
    ui.realce = h('pre', { class: 'sk-md-realce mono', 'aria-hidden': 'true' });
    ui.mdEd = h('div', { class: 'sk-md' + (ro ? ' ro' : '') }, ui.realce, ui.fCorpo);
    ui.previa = h('pre', { class: 'sk-previa mono', tabindex: '0', 'aria-label': 'Prévia do SKILL.md' });
    const copiar = h('button', { type: 'button', class: 'btn-icone sk-copiar', title: 'Copiar o SKILL.md', 'aria-label': 'Copiar o SKILL.md', onclick: async () => { try { await navigator.clipboard.writeText(textoSkillMd()); toast('SKILL.md copiado'); } catch { toast('Não deu para copiar.'); } } }, icone('copiar', 13));
    ui.mdPrev = h('div', { class: 'sk-prev-w' },
      h('div', { class: 'sk-prev-topo' }, icone('arquivo', 13), h('span', { class: 'mono' }, '.claude/skills/' + (e.base.nome || 'nome') + '/SKILL.md'), h('span', { class: 'espaco' }), copiar),
      ui.previa);
    ui.abas = h('div', { class: 'seg-filtro sk-abas', role: 'group', 'aria-label': 'Instruções' },
      h('button', { type: 'button', 'data-aba': 'editar', onclick: () => mudarAba('editar') }, icone('lapis', 12), ro ? 'Instruções' : 'Editar'),
      h('button', { type: 'button', 'data-aba': 'previa', onclick: () => mudarAba('previa') }, icone('doc', 12), 'Prévia do SKILL.md'));
    const instr = h('section', { class: 'sk-sec' },
      h('div', { class: 'sk-sec-cab sk-sec-cab-l' },
        h('h3', null, 'Instruções', h('span', { class: 'sk-ajuda', tabindex: '0', title: 'Em Markdown. $ARGUMENTS recebe o texto escrito depois do /nome; $0, $1… recebem cada palavra.', 'aria-label': 'Ajuda: Markdown e $ARGUMENTS' }, icone('ajuda', 12))),
        ui.abas),
      ui.mdEd, ui.mdPrev,
      h('details', { class: 'sk-avanc', open: e.base.extra ? true : null }, h('summary', { title: 'allowed-tools, argument-hint, model…' }, icone('chevron', 11), h('span', null, 'Cabeçalho avançado')), ui.fExtra));
    partes.push(secao('Identidade', null, h('div', { class: 'sk-form' }, ...ident)), instr);
    if (!e.novo) partes.push(blocoArquivos(e, ro));
    const rolo = h('div', { class: 'sk-ed-rolo' }, ...partes);
    ui.edMsg = h('span', { class: 'sk-msg', role: 'status' });
    ui.edSalvar = h('button', { type: 'button', class: 'btn solido', onclick: () => salvar() }, e.novo ? 'Criar skill' : 'Salvar');
    ui.edDesc = h('button', { type: 'button', class: 'btn contorno', onclick: () => descartar() }, e.novo ? 'Cancelar' : 'Descartar');
    const pe = ro ? null : h('div', { class: 'sk-pe' }, ui.edMsg, h('kbd', { class: 'sk-kbd' }, MAC ? '⌘S' : 'Ctrl+S'), ui.edDesc, ui.edSalvar);
    ui.ed.replaceChildren(rolo, pe || '');
    mudarAba(st.aba === 'previa' ? 'previa' : 'editar');
    atualizarRealce();
    atualizarPe();
  }
  function blocoEstado(s) {
    const sel = h('select', { class: 'sk-campo sk-sel', 'aria-label': 'Estado neste projeto', disabled: s.travada ? true : null, title: s.travada ? s.motivoTrava : '' },
      ...ESTADOS.map(([v, rot, dica]) => h('option', { value: v, title: dica }, rot)));
    sel.value = s.estado || 'on';
    listaSelect(sel).addEventListener('change', () => mudarEstado(s, sel.value, sel));
    const extra = [];
    if (s.travada) extra.push(h('span', null, icone('cadeado', 12), s.motivoTrava));
    if (s.sombreada) extra.push(h('span', { class: 'sk-m-aviso' }, icone('alerta', 12), 'Uma skill pessoal tem o mesmo nome e vence no Claude Code; esta fica escondida.'));
    if (s.noLocal) extra.push(h('span', null, icone('info', 12), 'settings.local.json deste projeto: ' + s.noLocal + ' (sai ao mudar aqui).'));
    if (s.noPessoal && !s.noProjeto) extra.push(h('span', null, icone('info', 12), 'Vem do settings pessoal: ' + s.noPessoal + '.'));
    return h('div', { class: 'sk-estado sk-est-' + classeEstado(s) },
      h('div', { class: 'sk-estado-l' },
        h('span', { class: 'sk-estado-rot' }, h('i', { 'aria-hidden': 'true' }), rotEstado(s.estado), h('span', { class: 'sk-estado-onde' }, 'em ' + (nomeProj(st.pasta) || 'este projeto'))),
        h('p', { class: 'sk-estado-dica' }, dicaEstado(s.estado))),
      h('span', { class: 'sk-sel-w' }, sel, h('span', { class: 'sk-sel-seta', 'aria-hidden': 'true' }, s.travada ? icone('cadeado', 12) : icone('chevron', 12))),
      extra.length ? h('p', { class: 'sk-estado-extra' }, ...extra) : null);
  }
  function atualizarPe() {
    if (ui.fNome) {
      const n = ui.fNome.value.trim();
      const ruim = !!n && !RE_NOME.test(n);
      ui.fNome.classList.toggle('sk-invalido', ruim);
      if (ui.nomeDica) ui.nomeDica.textContent = ruim ? 'use minúsculas, números e hífen' : 'vira /' + (n || 'nome') + ' no Claude Code';
      if (ui.nomeDica) ui.nomeDica.classList.toggle('sk-ruim', ruim);
    }
    if (ui.fDesc && ui.descConta) {
      const n = ui.fDesc.value.length;
      ui.descConta.textContent = n + '/' + MAX_DESC;
      ui.descConta.classList.toggle('perto', n > MAX_DESC * 0.85);
    }
    if (!ui.edMsg) return;
    const e = st.ed;
    const s = sujo();
    ui.edMsg.textContent = st.salvando ? 'Salvando…' : s ? 'Alterações não salvas' : '';
    ui.edMsg.classList.toggle('sujo', s && !st.salvando);
    ui.edSalvar.disabled = st.salvando || (!s && !e.novo);
  }
  function descartar() {
    if (st.ed && st.ed.novo) return fecharEditor();
    if (!st.ed) return;
    renderEditor();
  }
  async function salvar() {
    const e = st.ed;
    if (!e || !e.editavel || st.salvando) return;
    const nome = ui.fNome.value.trim();
    if (!RE_NOME.test(nome)) { ui.edMsg.textContent = 'Use no nome só letras minúsculas, números e hífen (até 64).'; ui.fNome.focus(); return; }
    if (!ui.fDesc.value.trim()) { ui.edMsg.textContent = 'Escreva a descrição.'; ui.fDesc.focus(); return; }
    const origem = e.novo ? ui.fOrigem.value : e.origem;
    st.salvando = true;
    atualizarPe();
    try {
      const r = await pedirComGlobal('/skills/salvar', { pasta: st.pasta, origem, nome, nomeAntigo: e.nomeAntigo, descricao: ui.fDesc.value, corpo: ui.fCorpo.value, extra: ui.fExtra.value }, origem === 'pessoal', e.novo ? 'Criar' : 'Editar');
      st.salvando = false;
      if (!r) { atualizarPe(); return; }
      const sk = r.skill;
      st.sel = sk.origem + ':' + sk.nome;
      st.ed = { s: { id: st.sel, nome: sk.nome, origem: sk.origem }, origem: sk.origem, nomeAntigo: sk.nome, editavel: true, base: { nome: sk.nome, descricao: sk.descricao, corpo: sk.corpo, extra: sk.extra }, arquivos: sk.arquivos, caminho: sk.caminho };
      toast((e.novo ? 'Skill criada: ' : 'Skill salva: ') + sk.nome);
      await carregar();
      const atual = skillPorId(st.sel);
      if (atual) st.ed.s = atual;
      renderEditor();
    } catch (x) {
      st.salvando = false;
      atualizarPe();
      ui.edMsg.textContent = x.message;
    }
  }
  async function duplicar(s) {
    const nome = h('input', { class: 'sk-campo mono', type: 'text', maxlength: 64, spellcheck: 'false', autocomplete: 'off', value: (s.nome.split(':').pop() + '-copia').slice(0, 64) });
    const destino = h('select', { class: 'sk-campo sk-sel', 'aria-label': 'Onde salvar' },
      h('option', { value: 'projeto' }, 'Projeto · ' + (nomeProj(st.pasta) || 'este projeto') + ' (padrão)'),
      h('option', { value: 'pessoal' }, 'Pessoal · global, todos os projetos'));
    listaSelect(destino);
    const ok = await modal({ titulo: 'Duplicar ' + s.nome, campos: [{ el: campo('Nome da cópia', nome), foco: nome }, { el: campo('Onde salvar', h('span', { class: 'sk-sel-w' }, destino, h('span', { class: 'sk-sel-seta', 'aria-hidden': 'true' }, icone('chevron', 12)))) }], ok: 'Duplicar' });
    if (!ok) return;
    const novoNome = nome.value.trim();
    if (!RE_NOME.test(novoNome)) return toast('Use no nome só letras minúsculas, números e hífen (até 64).');
    try {
      const r = await pedirComGlobal('/skills/duplicar', { pasta: st.pasta, origem: s.origem, nome: s.nome, destino: destino.value, novoNome }, destino.value === 'pessoal', 'Criar');
      if (!r) return;
      toast('Cópia criada: ' + novoNome);
      await carregar();
      st.sel = null;
      await abrir(r.skill.origem + ':' + r.skill.nome);
    } catch (e) { toast(e.message); }
  }
  async function excluir(s) {
    const global = s.origem === 'pessoal';
    const ok = await modal({ titulo: 'Excluir ' + s.nome + '?', texto: 'A pasta da skill, com os arquivos de apoio, vai para a Lixeira' + (MAC ? '' : ' do Windows') + '. Dá para restaurar de lá.' + (global ? ' É uma skill pessoal: some de todos os projetos.' : ''), ok: 'Excluir', perigo: true });
    if (!ok) return;
    try {
      const r = await pedir('/skills/excluir', { pasta: st.pasta, origem: s.origem, nome: s.nome, ...(global ? { confirmarGlobal: true } : {}) });
      if (!r) return;
      toast('Skill na Lixeira: ' + s.nome);
      fecharEditor();
      carregar();
    } catch (e) { toast(e.message); }
  }

  // ── arquivos de apoio ──
  function blocoArquivos(e, ro) {
    const l = e.arquivos || [];
    const itens = l.map((a) => h('li', { class: 'sk-arq' + (st.arq && st.arq.caminho === a.caminho ? ' sel' : '') },
      h('button', { type: 'button', class: 'sk-arq-nome mono', disabled: a.texto ? null : true, title: a.texto ? 'Abrir' : 'Não é texto: abra pela árvore de arquivos', onclick: () => abrirArquivo(a.caminho) }, icone('arquivo', 13), a.caminho),
      h('span', { class: 'sk-arq-tam num' }, tamanho(a.tamanho)),
      ro ? null : h('button', { type: 'button', class: 'btn-icone sk-arq-x', title: 'Excluir (vai para a Lixeira)', 'aria-label': 'Excluir ' + a.caminho, onclick: () => excluirArquivo(a.caminho) }, icone('lixeira', 13))));
    const partes = [h('div', { class: 'sk-arqs-cab sk-sec-cab' }, h('h3', { title: 'Scripts, modelos e referências que as instruções citam' }, 'Arquivos de apoio', l.length ? h('span', { class: 'num' }, String(l.length)) : null),
      ro ? null : h('button', { type: 'button', class: 'btn contorno sk-arq-novo', onclick: () => novoArquivo() }, icone('mais', 13), 'Arquivo'))];
    partes.push(l.length ? h('ul', { class: 'sk-arqs' }, ...itens) : h('p', { class: 'sk-vazio sk-vazio-g' }, 'Nenhum arquivo além do SKILL.md.'));
    if (st.arq) {
      ui.arqTexto = h('textarea', { class: 'sk-campo mono sk-arq-ed', rows: 12, spellcheck: 'false', value: st.arq.base, readonly: ro ? true : null });
      ui.arqTexto.addEventListener('input', () => { if (ui.arqMsg) ui.arqMsg.textContent = ui.arqTexto.value !== st.arq.base ? 'Alterações não salvas' : ''; });
      ui.arqMsg = h('span', { class: 'sk-msg' });
      partes.push(h('div', { class: 'sk-arq-painel' },
        h('div', { class: 'sk-arq-topo' }, h('span', { class: 'mono' }, st.arq.caminho), h('span', { class: 'espaco' }), ui.arqMsg,
          ro ? null : h('button', { type: 'button', class: 'btn solido', onclick: () => salvarArquivo() }, 'Salvar arquivo'),
          h('button', { type: 'button', class: 'btn-icone', title: 'Fechar o arquivo', 'aria-label': 'Fechar o arquivo', onclick: async () => { if (ui.arqTexto.value === st.arq.base || await modal({ titulo: 'Descartar as alterações do arquivo?', ok: 'Descartar', perigo: true })) { st.arq = null; renderEditor(); } } }, icone('x', 14))),
        ui.arqTexto));
    }
    return h('div', { class: 'sk-arqs-bloco' }, ...partes);
  }
  const tamanho = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  // Re-desenhar o editor perde o que está nos campos de cima: guarda e devolve.
  function redesenharMantendo() {
    const v = ui.fNome ? { n: ui.fNome.value, d: ui.fDesc.value, c: ui.fCorpo.value, x: ui.fExtra.value } : null;
    renderEditor();
    if (v && ui.fNome) { ui.fNome.value = v.n; ui.fDesc.value = v.d; ui.fCorpo.value = v.c; ui.fExtra.value = v.x; atualizarRealce(); atualizarPe(); }
  }
  async function abrirArquivo(caminho) {
    const e = st.ed;
    if (st.arq && ui.arqTexto && ui.arqTexto.value !== st.arq.base && !(await modal({ titulo: 'Descartar as alterações do arquivo?', ok: 'Descartar', perigo: true }))) return;
    try {
      const d = await pedir('/skills/arquivo?' + new URLSearchParams({ pasta: st.pasta, origem: e.origem, nome: e.nomeAntigo, arq: caminho }));
      st.arq = { caminho: d.caminho, base: d.texto };
      redesenharMantendo();
      if (ui.arqTexto) ui.arqTexto.focus();
    } catch (x) { toast(x.message); }
  }
  async function novoArquivo() {
    const cam = h('input', { class: 'sk-campo mono', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: 'scripts/ajuda.mjs' });
    if (!(await modal({ titulo: 'Novo arquivo de apoio', campos: [{ el: campo('Caminho dentro da skill', cam), foco: cam }], ok: 'Criar' }))) return;
    const e = st.ed;
    try {
      const r = await pedirComGlobal('/skills/arquivo', { pasta: st.pasta, origem: e.origem, nome: e.nomeAntigo, caminho: cam.value.trim(), texto: '', novo: true }, e.origem === 'pessoal', 'Editar');
      if (!r) return;
      e.arquivos = r.arquivos;
      const rel = cam.value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
      st.arq = { caminho: rel, base: '' };
      redesenharMantendo();
      if (ui.arqTexto) ui.arqTexto.focus();
    } catch (x) { toast(x.message); }
  }
  async function salvarArquivo() {
    const e = st.ed;
    if (!st.arq || !ui.arqTexto || !e.editavel) return;
    const texto = ui.arqTexto.value;
    try {
      const r = await pedirComGlobal('/skills/arquivo', { pasta: st.pasta, origem: e.origem, nome: e.nomeAntigo, caminho: st.arq.caminho, texto }, e.origem === 'pessoal', 'Editar');
      if (!r) return;
      e.arquivos = r.arquivos;
      st.arq.base = texto;
      redesenharMantendo();
      toast('Arquivo salvo: ' + st.arq.caminho);
    } catch (x) { toast(x.message); }
  }
  async function excluirArquivo(caminho) {
    const e = st.ed;
    const global = e.origem === 'pessoal';
    if (!(await modal({ titulo: 'Excluir ' + caminho + '?', texto: 'O arquivo vai para a Lixeira.' + (global ? ' É de uma skill pessoal (global).' : ''), ok: 'Excluir', perigo: true }))) return;
    try {
      const r = await pedir('/skills/arquivo/excluir', { pasta: st.pasta, origem: e.origem, nome: e.nomeAntigo, caminho, ...(global ? { confirmarGlobal: true } : {}) });
      e.arquivos = r.arquivos;
      if (st.arq && st.arq.caminho === caminho) st.arq = null;
      redesenharMantendo();
    } catch (x) { toast(x.message); }
  }

  // ───────────────────────────── detalhe da sessão ─────────────────────────────
  // Seção "Skills" do detalhe: as que a sessão usou (transcript) e, nas instâncias do Orbit com escolha na
  // Nova instância, as permitidas. Relê no máximo a cada 5 s por sessão.
  const pk = { id: '', quando: 0, sig: '', pr: null };
  function peek(s, sec) {
    if (!sec) return;
    const corpo = sec.querySelector('.pk-skills');
    if (!s) { sec.hidden = true; return; }
    if (pk.id !== s.id) { pk.id = s.id; pk.quando = 0; pk.sig = ''; corpo.replaceChildren(); sec.hidden = true; }
    if (Date.now() - pk.quando < 5000 || pk.pr) return;
    pk.quando = Date.now();
    const id = s.id;
    pk.pr = pedir('/skills/sessao?id=' + encodeURIComponent(id)).then((d) => {
      if (pk.id !== id) return;
      const sig = JSON.stringify(d);
      if (sig === pk.sig) return;
      pk.sig = sig;
      const usadas = d.usadas || [];
      const fmt = (t) => { try { return new Date(t).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
      const partes = [];
      if (usadas.length) {
        partes.push(h('div', { class: 'pk-sk-lista' }, ...usadas.map((u) => h('span', {
          class: 'pk-sk', title: (u.por.includes('voce') && u.por.includes('modelo') ? 'Chamada por você e pelo Claude' : u.por.includes('voce') ? 'Chamada por você (/' + u.nome + ')' : 'Chamada pelo Claude') + (u.ultima ? ' · última: ' + fmt(u.ultima) : ''),
        }, h('span', { class: 'mono' }, u.nome), u.vezes > 1 ? h('span', { class: 'num pk-sk-n' }, '×' + u.vezes) : null, u.por.includes('voce') ? h('span', { class: 'pk-sk-voce' }, '/') : null))));
      } else partes.push(h('p', { class: 'pk-sk-vazio' }, d.semTranscript ? 'Sem o transcript da sessão.' : 'Nenhuma skill usada ainda.'));
      if (Array.isArray(d.permitidas)) partes.push(h('p', { class: 'pk-sk-perm', title: d.permitidas.join(', ') }, d.permitidas.length ? 'Escolhidas na criação: ' + d.permitidas.length + (d.permitidas.length === 1 ? ' skill' : ' skills') + ' (' + d.permitidas.slice(0, 6).join(', ') + (d.permitidas.length > 6 ? '…' : '') + ')' : 'Criada sem nenhuma skill.'));
      partes.push(h('p', { class: 'pk-sk-nota' }, 'Conta o que a sessão principal chamou; os subagentes ficam de fora.'));
      corpo.replaceChildren(...partes);
      sec.hidden = false;
      const n = sec.querySelector('.pk-sk-total');
      if (n) n.textContent = usadas.length ? String(usadas.length) : '';
      if (n) n.hidden = !usadas.length;
    }).catch(() => {}).finally(() => { pk.pr = null; });
  }

  window.Skills = Object.freeze({ criarAba, receber, peek, _estado: () => ({ pasta: st.pasta, sel: st.sel, n: st.dados ? st.dados.skills.length : null, sujo: sujo() }) });
})();
