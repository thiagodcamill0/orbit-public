/* Orbit — painel de Escritórios (V1): barra no topo da Visão de Office + gaveta lateral de cadastro.
 * Fala com as rotas da §3 do contrato (escritorios-etapa1-contrato) e com GET /modelos.
 *
 *   window.EscritoriosPainel = {
 *     montar(elemento, { base = '', selecionado, onSelecionar(id|null), onVoltar(), onMudou({tipo,id}), onSumiu(id) }),  // barra dentro de `elemento`; a gaveta vai no <body>
 *     desmontar(),
 *     atualizar(evento),   // evento SSE `escritorio`: { id, resumo | null }; sem argumento, recarrega tudo
 *     selecionar(id),      // opcional: troca o escritório selecionado por fora
 *     abrirGaveta(modo, id?, { canvas: {x,y} }?),  // modo 'novo'|'editar'; 'editar' usa `id` (padrão: o selecionado); 'novo' envia `canvas` no POST. Promise<boolean> (abriu?)
 *     duplicar(id),        // Promise do resumo da cópia (rejeita com { status, mensagem }); não muda o selecionado
 *     excluir(id),         // abre o diálogo "Manter / Excluir de vez"; Promise<boolean> (true = excluído); o 409 do servidor aparece no diálogo
 *     gavetaSuja(),        // true se há gaveta aberta com alterações não salvas
 *     descartarGaveta(),   // Promise<boolean>: sem gaveta ou sem alterações fecha direto; com alterações pergunta "Descartar alterações?" (Manter / Descartar); true = pode seguir
 *   }
 *
 * `onSumiu(id)` roda quando o escritório selecionado some (excluído aqui ou por SSE, ou inexistente depois da lista chegar), ANTES de o painel
 * escolher o substituto: a página pode voltar ao canvas. `selecionar(id)` antes de a lista chegar guarda o id e aplica quando ela chegar.
 * Abrir outra gaveta com a atual suja pergunta antes de descartar; a abertura mais recente vence (um GET antigo não mexe na gaveta atual).
 * Sem a faixa à vista (canvas ou "Sessões"), as mensagens do painel saem num aviso flutuante no canto inferior (aria-live).
 * `onSelecionar` roda sempre que o escritório selecionado muda (inclusive na montagem) e com null quando não sobra nenhum.
 * `onVoltar` (opcional) mostra o botão "← Escritórios" no início da faixa. `onMudou` roda após cada ação que deu certo:
 * {tipo:'criado'|'salvo'|'duplicado'|'excluido', id} (em 'duplicado', o id é o da cópia).
 * A gaveta e o diálogo vivem no <body>: abrirGaveta/duplicar/excluir funcionam com a faixa escondida (hidden), mas exigem o painel montado.
 * Estilos: assets/escritorios-painel.css (prefixo esc-pn-). Sem dependências; a gaveta lê o formulário direto do DOM ao salvar. */
(() => {
  'use strict';

  const MAX_MEMBROS = 8;
  const MAX_EXTRAS = 20;
  const CHAVE_SEL = 'orbit.escritorios.sel';
  const STATUS = { ociosa: 'Ociosa', rodando: 'Rodando', pausada: 'Pausada', concluida: 'Concluída', erro: 'Erro' };
  const MOTIVO = { 'orcamento-execucao': 'orçamento da execução', 'orcamento-dia': 'orçamento do dia', manual: 'manual' };
  const MAC = /Mac/i.test(navigator.platform || navigator.userAgent || '');
  const PLACEHOLDER_PASTA = MAC ? '/Users/voce/Projetos/minha-pasta' : 'D:\\Projetos\\minha-pasta';

  let E = null; // estado da montagem
  let uid = 0;

  // ───────────────────────── utilidades ─────────────────────────

  function h(tag, attrs, ...filhos) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
    const por = (f) => {
      if (Array.isArray(f)) f.forEach(por);
      else if (f !== null && f !== undefined && f !== false) el.append(f instanceof Node ? f : document.createTextNode(String(f)));
    };
    filhos.forEach(por);
    return el;
  }

  const usd = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const novoId = (p) => `esc-pn-${p}-${++uid}`;

  function slug(t) {
    const s = String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s.slice(0, 30).replace(/-+$/, '');
  }

  const PADRAO_ERRO = {
    0: 'Não consegui falar com o servidor do Orbit.',
    400: 'Os dados enviados não são válidos.',
    403: 'O servidor recusou o pedido.',
    404: 'Escritório não encontrado.',
    409: 'A ação conflita com o estado atual do escritório.',
    429: 'O limite de instâncias de escritório está cheio; tente de novo daqui a pouco.',
    503: 'O servidor ainda não está pronto; tente de novo em alguns segundos.',
  };

  async function api(caminho, { corpo, post = false } = {}) {
    const init = post
      ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-gerenciador': '1' }, body: JSON.stringify(corpo || {}) }
      : { cache: 'no-store' };
    let r;
    try { r = await fetch(E.base + caminho, init); } catch { throw { status: 0, mensagem: PADRAO_ERRO[0] }; }
    let j = null;
    try { j = await r.json(); } catch { /* sem corpo */ }
    if (!r.ok) throw { status: r.status, mensagem: (j && typeof j.erro === 'string' && j.erro) || PADRAO_ERRO[r.status] || `Erro ${r.status} no servidor.` };
    return j || {};
  }
  const textoErro = (e) => (e && e.mensagem) || (e && e.message) || 'Algo deu errado.';

  function guardarSel(id) {
    try { id ? localStorage.setItem(CHAVE_SEL, id) : localStorage.removeItem(CHAVE_SEL); } catch { /* sem armazenamento */ }
  }
  function lerSel() {
    try { return localStorage.getItem(CHAVE_SEL) || ''; } catch { return ''; }
  }

  // ───────────────────────── barra ─────────────────────────

  function criarBarra() {
    const u = {};
    u.sel = h('select', { class: 'esc-pn-campo esc-pn-sel', id: novoId('sel'), 'aria-label': 'Escritório' });
    u.sel.addEventListener('change', () => escolher(u.sel.value, true));
    u.voltar = typeof E.onVoltar === 'function'
      ? h('button', { type: 'button', class: 'esc-pn-btn esc-pn-voltar', onclick: () => { try { E.onVoltar(); } catch { /* a página decide */ } } }, '← Escritórios')
      : null;
    u.novo = h('button', { type: 'button', class: 'esc-pn-btn', onclick: () => abrirGavetaInterna('novo', { abridor: u.novo }) }, 'Novo escritório');
    u.cfg = h('button', { type: 'button', class: 'esc-pn-btn', onclick: () => abrirGavetaInterna('editar', { id: E.sel, abridor: u.cfg }) }, 'Configurar');
    u.status = h('span', { class: 'esc-pn-status', role: 'status', 'aria-live': 'polite', 'data-status': 'ociosa' });
    u.pausa = h('button', { type: 'button', class: 'esc-pn-btn', hidden: true, onclick: () => alternarPausa() }, 'Pausar');
    u.tarefa = h('input', { class: 'esc-pn-campo esc-pn-tarefa', id: novoId('tarefa'), type: 'text', 'aria-label': 'Tarefa para o escritório', placeholder: 'Descreva a tarefa para acionar o escritório', maxlength: 4000, autocomplete: 'off' });
    u.tarefa.addEventListener('input', () => atualizarBarra());
    u.tarefa.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); acionar(); } });
    u.acionar = h('button', { type: 'button', class: 'esc-pn-btn esc-pn-solido', onclick: () => acionar() }, 'Acionar');
    u.gasto = h('span', { class: 'esc-pn-gasto', 'data-nivel': '0' });
    u.aviso = h('div', { class: 'esc-pn-aviso', role: 'alert', hidden: true });
    u.avisoTx = h('span', { class: 'esc-pn-aviso-tx' });
    u.avisoX = h('button', { type: 'button', class: 'esc-pn-x', 'aria-label': 'Dispensar aviso', onclick: () => avisar('') }, '×');
    u.aviso.append(u.avisoTx, u.avisoX);

    const raiz = h('div', { class: 'esc-pn-barra', role: 'toolbar', 'aria-label': 'Escritórios' },
      h('div', { class: 'esc-pn-linha' },
        u.voltar, h('label', { class: 'esc-pn-barra-rot', for: u.sel.id }, 'Escritório'), u.sel, u.novo, u.cfg,
        h('span', { class: 'esc-pn-esp' }), u.status, u.pausa),
      h('div', { class: 'esc-pn-linha' }, u.tarefa, u.acionar),
      h('div', { class: 'esc-pn-linha esc-pn-linha-gasto' }, u.gasto),
      u.aviso);
    E.ui = u;
    return raiz;
  }

  // Aviso flutuante do painel (canto inferior, aria-live): usado quando a faixa está escondida (canvas ou "Sessões").
  // O contêiner (a região viva) fica sempre no <body>; só a caixa aparece e some.
  function criarToast() {
    const t = {};
    t.tx = h('span', { class: 'esc-pn-toast-tx' });
    t.x = h('button', { type: 'button', class: 'esc-pn-x', 'aria-label': 'Dispensar aviso', onclick: () => avisar('') }, '×');
    t.caixa = h('div', { class: 'esc-pn-toast-caixa', hidden: true }, t.tx, t.x);
    t.el = h('div', { class: 'esc-pn-toast', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, t.caixa);
    document.body.append(t.el);
    E.toast = t;
  }

  // A faixa só mostra o aviso se estiver na tela (fora de um ancestral hidden/display:none).
  const faixaVisivel = () => !!E && E.barra.getClientRects().length > 0;

  let timerAviso = 0;
  function avisar(texto, tipo = 'erro') {
    if (!E) return;
    const u = E.ui;
    const t = E.toast;
    const flutuar = !!texto && !faixaVisivel();
    clearTimeout(timerAviso);
    u.aviso.hidden = !texto || flutuar;
    u.aviso.dataset.tipo = tipo;
    u.avisoTx.textContent = texto && !flutuar ? texto : '';
    t.caixa.hidden = !flutuar;
    t.caixa.dataset.tipo = tipo;
    t.tx.textContent = flutuar ? texto : '';
    const eu = E;
    const ms = !texto ? 0 : tipo === 'ok' ? 6000 : flutuar && tipo !== 'pausa' ? 12000 : 0; // a pausa por orçamento fica até ser dispensada
    if (ms) timerAviso = setTimeout(() => { if (E === eu) avisar(''); }, ms);
  }

  function resumoAtual() { return E.lista.find((x) => x.id === E.sel) || null; }

  function atualizarBarra() {
    if (!E) return;
    const u = E.ui;
    const r = resumoAtual();
    const tem = !!r;
    u.sel.replaceChildren(...(E.lista.length
      ? E.lista.map((x) => h('option', { value: x.id }, x.nome))
      : [h('option', { value: '' }, 'Nenhum escritório')]));
    u.sel.value = tem ? r.id : '';
    u.sel.disabled = !E.lista.length;
    u.cfg.disabled = !tem;

    const st = r ? r.status || 'ociosa' : 'ociosa';
    let tx = r ? STATUS[st] || st : 'Sem escritório';
    const motivo = st === 'pausada' && E.det && E.det.id === r.id ? MOTIVO[E.det.execucao?.motivoPausa] : '';
    if (motivo) tx += ` (${motivo})`;
    else if (st === 'rodando' && r.ativos > 0) tx += ` · ${r.ativos} ${r.ativos === 1 ? 'ativo' : 'ativos'}`;
    u.status.textContent = tx;
    u.status.dataset.status = r ? st : 'nenhum';

    u.pausa.hidden = !(st === 'rodando' || st === 'pausada');
    u.pausa.textContent = st === 'pausada' ? 'Liberar' : 'Pausar';
    u.pausa.disabled = E.ocupado;

    u.tarefa.disabled = !tem;
    u.acionar.disabled = !tem || st === 'rodando' || E.ocupado || !u.tarefa.value.trim();
    u.acionar.title = st === 'rodando' ? 'O escritório já está rodando' : '';

    const c = r && r.custo;
    if (c) {
      const aviso = E.det && E.det.id === r.id ? E.det.escritorio?.orcamento?.avisoPct || 80 : 80;
      const pct = Math.max(c.limiteExecucaoUsd > 0 ? (c.execucaoUsd / c.limiteExecucaoUsd) * 100 : 0, c.limiteDiaUsd > 0 ? (c.diaUsd / c.limiteDiaUsd) * 100 : 0);
      u.gasto.dataset.nivel = pct >= 100 ? '2' : pct >= aviso ? '1' : '0';
      // "≈" por linha (parcela do Codex estimada pelos tokens): estimadoExecucao/estimadoDia quando existem; senão `estimado` nas duas
      const flag = (esp) => (typeof esp === 'boolean' ? esp : !!c.estimado);
      const estExec = flag(c.estimadoExecucao);
      const estDia = flag(c.estimadoDia);
      u.gasto.textContent = `${estExec ? '≈ ' : ''}US$ ${usd(c.execucaoUsd)} de ${usd(c.limiteExecucaoUsd)} (execução) · ${estDia ? '≈ ' : ''}US$ ${usd(c.diaUsd)} de ${usd(c.limiteDiaUsd)} (dia) · ≈ ${Math.round(Number(c.planoPct) || 0)}% do plano`;
      if (estExec || estDia) u.gasto.title = 'Inclui estimativa do Codex pelos tokens'; else u.gasto.removeAttribute('title');
    } else {
      u.gasto.removeAttribute('title');
      u.gasto.dataset.nivel = '0';
      u.gasto.textContent = tem ? '' : 'Crie um escritório para começar.';
    }
  }

  // ───────────────────────── dados ─────────────────────────

  const ordenar = () => E.lista.sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));

  // O escritório selecionado sumiu (excluído aqui ou em outra aba, ou apagado antes de a lista chegar): a página decide o que fazer
  // (o index volta ao canvas, nunca para outro escritório) antes de o painel escolher o substituto.
  function sumiu(id) {
    if (!id || !E.onSumiu) return;
    try { E.onSumiu(id); } catch { /* a página decide */ }
  }

  async function recarregar() {
    const eu = E;
    const g = ++E.g;
    try {
      const j = await api('/escritorios');
      if (E !== eu || g !== E.g) return;
      E.lista = Array.isArray(j.escritorios) ? j.escritorios : [];
      E.carregou = true;
      ordenar();
    } catch (e) {
      if (E === eu && g === E.g) avisar(textoErro(e));
      return;
    }
    if (E.pendente) { // a página entrou num escritório antes de a lista chegar: a lista confirma e o painel acompanha
      const alvo = E.pendente;
      E.pendente = '';
      if (E.lista.some((x) => x.id === alvo)) { await escolher(alvo, true); return; }
      sumiu(alvo);
      if (E !== eu) return;
    }
    if (!E.lista.some((x) => x.id === E.sel)) {
      const antigo = E.sel;
      if (antigo) sumiu(antigo);
      if (E !== eu) return;
      const novo = E.lista.length ? E.lista[0].id : '';
      await escolher(novo, true);
    } else {
      atualizarBarra();
      if (!E.inicial) { E.inicial = true; try { E.onSelecionar(E.sel); } catch { /* a página decide */ } }
      carregarDetalhe(E.sel);
    }
  }

  async function carregarDetalhe(id) {
    if (!id) { E.det = null; return; }
    const eu = E;
    const g = ++E.gd;
    try {
      const j = await api(`/escritorios/${encodeURIComponent(id)}`);
      if (E !== eu || g !== E.gd || id !== E.sel) return;
      E.det = { id, escritorio: j.escritorio, execucao: j.execucao };
      atualizarBarra();
    } catch { /* o resumo da lista basta para a barra */ }
  }

  async function escolher(id, notificar) {
    const mudou = id !== E.sel;
    E.inicial = true;
    E.pendente = '';
    E.sel = id || '';
    E.det = null;
    guardarSel(E.sel);
    atualizarBarra();
    if (mudou || notificar) { try { E.onSelecionar(E.sel || null); } catch { /* a página decide */ } }
    if (E) await carregarDetalhe(E.sel);
  }

  async function carregarModelos(forcar) {
    const eu = E;
    if (eu.modelos && !forcar) return eu.modelos;
    let modelos = [];
    let erro = '';
    try {
      const j = await api('/modelos');
      modelos = Array.isArray(j.modelos) ? j.modelos : [];
    } catch (e) {
      erro = textoErro(e);
    }
    if (E !== eu) return modelos; // o painel foi desmontado no meio do pedido
    E.modelos = modelos;
    E.modelosErro = erro;
    if (E.gaveta) E.gaveta.pares.forEach((p) => p.desenhar());
    if (E.gaveta && E.gaveta.notaModelos) E.gaveta.notaModelos.hidden = !E.modelosErro;
    return E.modelos;
  }

  // ───────────────────────── ações da barra ─────────────────────────

  async function executar(fn) {
    if (E.ocupado) return;
    const eu = E;
    eu.ocupado = true;
    atualizarBarra();
    try { return await fn(eu); } catch (e) { if (E === eu) avisar(textoErro(e)); } finally { if (E === eu) { E.ocupado = false; atualizarBarra(); } }
  }

  function acionar() {
    const r = resumoAtual();
    const tarefa = E.ui.tarefa.value.trim();
    if (!r || !tarefa) return;
    return executar(async (eu) => {
      avisar('');
      await api(`/escritorios/${encodeURIComponent(r.id)}/acionar`, { post: true, corpo: { tarefa, origem: 'manual' } });
      if (E !== eu) return; // desmontado no meio do pedido
      E.ui.tarefa.value = '';
      avisar(`Execução iniciada em "${r.nome}".`, 'ok');
      await recarregar();
    });
  }

  function alternarPausa() {
    const r = resumoAtual();
    if (!r) return;
    const liberar = r.status === 'pausada';
    return executar(async (eu) => {
      avisar('');
      await api(`/escritorios/${encodeURIComponent(r.id)}/${liberar ? 'liberar' : 'pausar'}`, { post: true });
      if (E !== eu) return;
      avisar(liberar ? 'Escritório liberado.' : 'Escritório pausado.', 'ok');
      await recarregar();
    });
  }

  // ───────────────────────── gaveta: peças do formulário ─────────────────────────

  function campo(rotulo, el, dica) {
    if (!el.id) el.id = novoId('c');
    const filhos = [h('label', { class: 'esc-pn-rot', for: el.id }, rotulo)];
    filhos.push(el);
    if (dica) {
      const d = h('p', { class: 'esc-pn-dica', id: el.id + '-dica' }, dica);
      el.setAttribute('aria-describedby', d.id);
      filhos.push(d);
    }
    return h('div', { class: 'esc-pn-grupo' }, filhos);
  }

  const entrada = (attrs) => h('input', { class: 'esc-pn-campo', type: 'text', autocomplete: 'off', spellcheck: 'false', ...attrs });
  const area = (attrs) => h('textarea', { class: 'esc-pn-campo esc-pn-area', rows: 3, spellcheck: 'false', ...attrs });

  // Par modelo/esforço: as opções vêm de GET /modelos. Valor atual que a lista não conhece continua escolhível.
  // `fonte` (opcional) = { lista(), padrao() }: o membro do Codex usa a lista do Codex no lugar da do Claude.
  function criarPar(modelo, esforco, rotuloQuem, fonte = null) {
    const p = { modelo: modelo || '', esforco: esforco || '' };
    const listaAtual = () => (fonte ? fonte.lista() : E.modelos) || [];
    p.sm = h('select', { class: 'esc-pn-campo', id: novoId('mod'), 'aria-label': `Modelo ${rotuloQuem}`.trim() });
    p.se = h('select', { class: 'esc-pn-campo', id: novoId('esf'), 'aria-label': `Esforço ${rotuloQuem}`.trim() });
    p.desenhar = () => {
      const lista = listaAtual();
      const opcoes = [['', fonte ? fonte.padrao() : 'Padrão da conta'], ...lista.map((m) => [m.valor, m.nome || m.valor])];
      if (p.modelo && !lista.some((m) => m.valor === p.modelo)) opcoes.push([p.modelo, p.modelo]);
      p.sm.replaceChildren(...opcoes.map(([v, t]) => h('option', { value: v }, t)));
      p.sm.value = p.modelo;
      const m = lista.find((x) => x.valor === p.modelo);
      const niveis = m ? m.esforcos || [] : [];
      const ops = [['', 'Padrão'], ...niveis.map((n) => [n, n])];
      if (p.esforco && !niveis.includes(p.esforco)) ops.push([p.esforco, p.esforco]);
      p.se.replaceChildren(...ops.map(([v, t]) => h('option', { value: v }, t)));
      p.se.value = p.esforco;
      p.se.disabled = !p.modelo || (!niveis.length && !p.esforco);
    };
    p.sm.addEventListener('change', () => {
      p.modelo = p.sm.value;
      const m = listaAtual().find((x) => x.valor === p.modelo);
      if (!m || !(m.esforcos || []).includes(p.esforco)) p.esforco = '';
      p.desenhar();
    });
    p.se.addEventListener('change', () => { p.esforco = p.se.value; });
    p.desenhar();
    p.el = h('div', { class: 'esc-pn-dupla' }, campo('Modelo', p.sm), campo('Esforço', p.se));
    p.ler = () => ({ modelo: p.modelo, esforco: p.esforco });
    return p;
  }

  // Lista de modelos do Codex (GET /codex/modelos): 404 = Codex desligado; outro erro = indisponível por ora.
  const MSG_CODEX_DESLIGADO = 'O Codex está desligado nas Configurações: ligue-o para usar membros do Codex.';
  async function carregarCodex(forcar) {
    const eu = E;
    if (eu.codex.estado === 'ok' && !forcar) return eu.codex;
    let codex;
    try {
      const j = await api('/codex/modelos');
      codex = { estado: 'ok', modelos: Array.isArray(j.modelos) ? j.modelos : [], aviso: '' };
    } catch (e) {
      codex = e && e.status === 404
        ? { estado: 'desligado', modelos: [], aviso: MSG_CODEX_DESLIGADO }
        : { estado: 'indisponivel', modelos: [], aviso: `O Codex não está disponível agora: ${textoErro(e)}` };
    }
    if (E !== eu) return codex; // o painel foi desmontado no meio do pedido
    E.codex = codex;
    if (E.gaveta) E.gaveta.membros.forEach((m) => m.desenharIA());
    return E.codex;
  }

  function cartaoMembro(g, d, aberto) {
    const m = { pos: 0 };
    const n = ++uid;
    const corpoId = `esc-pn-mc-${n}`;
    m.id = entrada({ maxlength: 30, value: d.id || '', placeholder: 'ex.: redator' });
    m.papel = entrada({ maxlength: 40, value: d.papel || '', placeholder: 'ex.: Redator' });
    m.nome = entrada({ maxlength: 40, value: d.nome || '', placeholder: 'Se vazio, usa o rótulo' });
    m.prompt = area({ maxlength: 8000, rows: 4, placeholder: 'O que este membro faz e como deve trabalhar' });
    m.prompt.value = d.prompt || '';
    m.provedor = d.provedor === 'codex' ? 'codex' : 'claude';
    m.eraCodex = m.provedor === 'codex'; // membro Codex já salvo: continua visível e editável mesmo com o Codex fora do ar
    m.par = criarPar(d.modelo, d.esforco, 'do membro', {
      lista: () => (m.provedor === 'codex' ? E.codex.modelos : E.modelos),
      padrao: () => (m.provedor === 'codex' ? 'Padrão do Codex' : 'Padrão da conta'),
    });
    g.pares.push(m.par);
    m.prov = h('select', { class: 'esc-pn-campo esc-pn-prov', id: novoId('ia'), 'aria-label': 'IA do membro' },
      h('option', { value: 'claude' }, 'Claude'), h('option', { value: 'codex' }, 'Codex'));
    m.avisoIA = h('p', { class: 'esc-pn-dica esc-pn-aviso-ia', hidden: true });
    m.prov.addEventListener('change', () => {
      m.provedor = m.prov.value === 'codex' ? 'codex' : 'claude';
      m.par.modelo = ''; m.par.esforco = ''; // as listas são diferentes: volta ao padrão da IA escolhida
      m.desenharIA();
    });
    m.manual = !!d.id; // o id acompanha o rótulo até a pessoa mexer nele
    m.id.addEventListener('input', () => { m.manual = true; titulo(); });
    m.papel.addEventListener('input', () => {
      if (!m.manual) m.id.value = idUnico(g, slug(m.papel.value), m);
      titulo();
    });
    m.cab = h('button', { type: 'button', class: 'esc-pn-membro-cab', 'aria-expanded': aberto ? 'true' : 'false', 'aria-controls': corpoId });
    m.sobe = h('button', { type: 'button', class: 'esc-pn-mini', onclick: () => mover(g, m, -1) }, '↑');
    m.desce = h('button', { type: 'button', class: 'esc-pn-mini', onclick: () => mover(g, m, 1) }, '↓');
    m.tira = h('button', { type: 'button', class: 'esc-pn-mini esc-pn-mini-perigo', onclick: () => remover(g, m) }, 'Remover');
    m.corpo = h('div', { class: 'esc-pn-membro-corpo', id: corpoId, hidden: !aberto },
      h('div', { class: 'esc-pn-dupla' }, campo('Rótulo', m.papel), campo('Id do papel', m.id, 'Minúsculas, números e hífen (até 30). Vira o nome do arquivo de notas.')),
      campo('Nome', m.nome),
      campo('Prompt', m.prompt),
      (() => { const gr = campo('IA', m.prov); m.prov.setAttribute('aria-describedby', (m.avisoIA.id = m.prov.id + '-aviso')); gr.append(m.avisoIA); return gr; })(),
      m.par.el);
    m.cab.addEventListener('click', () => {
      const abre = m.cab.getAttribute('aria-expanded') !== 'true';
      m.cab.setAttribute('aria-expanded', String(abre));
      m.corpo.hidden = !abre;
    });
    function titulo() {
      const pap = m.papel.value.trim() || 'Novo membro';
      m.cab.textContent = '';
      m.cab.append(h('span', { class: 'esc-pn-membro-tit' }, pap), ...(m.provedor === 'codex' ? [h('span', { class: 'esc-pn-selo' }, 'Codex')] : []), h('span', { class: 'esc-pn-membro-id' }, m.id.value.trim()));
      m.sobe.setAttribute('aria-label', `Subir ${pap}`);
      m.desce.setAttribute('aria-label', `Descer ${pap}`);
      m.tira.setAttribute('aria-label', `Remover ${pap}`);
    }
    m.titulo = titulo;
    // IA do membro: a opção Codex só vale com o Codex ligado (ou para quem já era Codex); o aviso explica o porquê.
    m.desenharIA = () => {
      const ok = E.codex.estado === 'ok';
      const fora = E.codex.estado === 'desligado' || E.codex.estado === 'indisponivel';
      m.prov.value = m.provedor;
      m.prov.options[1].disabled = !ok && !m.eraCodex && m.provedor !== 'codex';
      m.avisoIA.textContent = fora ? E.codex.aviso : '';
      m.avisoIA.hidden = !fora;
      m.par.desenhar();
      titulo();
    };
    m.desenharIA();
    m.el = h('li', { class: 'esc-pn-membro' }, h('div', { class: 'esc-pn-membro-topo' }, m.cab, h('div', { class: 'esc-pn-membro-acoes' }, m.sobe, m.desce, m.tira)), m.corpo);
    m.ler = () => ({
      id: m.id.value.trim(),
      papel: m.papel.value.trim(),
      nome: m.nome.value.trim() || undefined,
      prompt: m.prompt.value,
      provedor: m.provedor,
      ...m.par.ler(),
    });
    return m;
  }

  function idUnico(g, base, exceto) {
    const b = base || 'membro';
    const usados = new Set(g.membros.filter((x) => x !== exceto).map((x) => x.id.value.trim()));
    if (!usados.has(b)) return b;
    for (let i = 2; i < 20; i++) {
      const c = `${b.slice(0, 26)}-${i}`;
      if (!usados.has(c)) return c;
    }
    return b;
  }

  function redesenharMembros(g) {
    g.lista.replaceChildren(...g.membros.map((m) => m.el));
    g.membros.forEach((m, i) => { m.sobe.disabled = i === 0; m.desce.disabled = i === g.membros.length - 1; });
    g.vazio.hidden = g.membros.length > 0;
    g.add.disabled = g.membros.length >= MAX_MEMBROS;
    g.contador.textContent = `${g.membros.length} de ${MAX_MEMBROS}`;
  }

  function mover(g, m, delta) {
    const i = g.membros.indexOf(m);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= g.membros.length) return;
    g.membros.splice(i, 1);
    g.membros.splice(j, 0, m);
    g.sujo = true;
    redesenharMembros(g);
    // o foco acompanha o botão que a pessoa usou (ou o vizinho, se o botão ficou desabilitado)
    const alvo = delta < 0 ? (m.sobe.disabled ? m.desce : m.sobe) : (m.desce.disabled ? m.sobe : m.desce);
    alvo.focus();
    g.anunciar(`${m.papel.value.trim() || 'Membro'} agora é o membro ${j + 1} de ${g.membros.length}.`);
  }

  function remover(g, m) {
    const i = g.membros.indexOf(m);
    if (i < 0) return;
    const pap = m.papel.value.trim() || 'Membro';
    g.membros.splice(i, 1);
    g.sujo = true;
    g.pares = g.pares.filter((p) => p !== m.par);
    redesenharMembros(g);
    const vizinho = g.membros[i] || g.membros[i - 1];
    (vizinho ? vizinho.cab : g.add).focus();
    g.anunciar(`${pap} removido.`);
  }

  function adicionar(g, d = {}, abrir = true) {
    if (g.membros.length >= MAX_MEMBROS) return null;
    const m = cartaoMembro(g, d, abrir);
    g.membros.push(m);
    redesenharMembros(g);
    return m;
  }

  // ───────────────────────── gaveta ─────────────────────────

  function secao(titulo, ...filhos) {
    return h('fieldset', { class: 'esc-pn-sec' }, h('legend', { class: 'esc-pn-leg' }, titulo), ...filhos);
  }

  function valoresIniciais(esc) {
    const o = esc && esc.orquestrador ? esc.orquestrador : {};
    return {
      nome: esc?.nome || '', funcao: esc?.funcao || '', pasta: esc?.pasta || '',
      orq: { nome: o.nome || '', prompt: o.prompt || '', modelo: o.modelo || '', esforco: o.esforco || '' },
      membros: Array.isArray(esc?.membros) ? esc.membros : [],
      limite: esc?.convidados?.limite ?? 2,
      porExec: esc?.orcamento?.porExecucaoUsd ?? 2,
      porDia: esc?.orcamento?.porDiaUsd ?? 10,
      aviso: esc?.orcamento?.avisoPct ?? 80,
      extras: Array.isArray(esc?.externas?.extras) ? esc.externas.extras : [],
    };
  }

  // Abre a gaveta e devolve true se abriu. Em 'editar' carrega o detalhe de `id` (não depende do selecionado).
  // A abertura mais recente vence: cada pedido leva um número e, depois de qualquer espera (o GET do editar, a pergunta de descarte),
  // só segue se ainda for o último; um pedido antigo nunca fecha nem sobrescreve a gaveta atual.
  async function abrirGavetaInterna(modo, { id = '', abridor = null, canvas = null } = {}) {
    if (!E) return false;
    const eu = E;
    if (modo !== 'novo' && modo !== 'editar') return false;
    if (modo === 'editar' && !id) return false;
    const minha = ++eu.seqGaveta;
    const vale = () => E === eu && eu.seqGaveta === minha;
    let esc = null;
    if (modo === 'editar') {
      try {
        esc = (await api(`/escritorios/${encodeURIComponent(id)}`)).escritorio;
      } catch (e) { if (vale()) avisar(textoErro(e)); return false; }
      if (!vale()) return false;
    }
    if (eu.gaveta && !(await descartarGaveta())) return false; // gaveta com alterações não salvas: pergunta antes
    if (!vale()) return false;
    if (E.gaveta) fecharGaveta(false);
    const v = valoresIniciais(esc);
    const g = { modo, id: esc ? esc.id : null, abridor, canvas, pares: [], membros: [], ocupado: false, sujo: false };
    E.gaveta = g;
    const tituloId = novoId('tit');

    g.nome = entrada({ maxlength: 60, value: v.nome, placeholder: 'ex.: Marketing' });
    g.funcao = area({ maxlength: 500, rows: 3, placeholder: 'Para que serve este escritório' });
    g.funcao.value = v.funcao;
    g.pasta = entrada({ value: v.pasta, placeholder: PLACEHOLDER_PASTA });
    g.orqNome = entrada({ maxlength: 40, value: v.orq.nome, placeholder: 'Orquestrador' });
    g.orqPrompt = area({ maxlength: 8000, rows: 5, placeholder: 'Como o orquestrador lidera o time e decide quem faz o quê' });
    g.orqPrompt.value = v.orq.prompt;
    g.orqPar = criarPar(v.orq.modelo, v.orq.esforco, 'do orquestrador');
    g.pares.push(g.orqPar);
    g.limite = entrada({ type: 'number', min: 0, max: 6, step: 1, value: v.limite, inputmode: 'numeric' });
    g.porExec = entrada({ type: 'number', min: 0.01, step: 0.5, value: v.porExec, inputmode: 'decimal' });
    g.porDia = entrada({ type: 'number', min: 0.01, step: 0.5, value: v.porDia, inputmode: 'decimal' });
    g.aviso = entrada({ type: 'number', min: 50, max: 95, step: 1, value: v.aviso, inputmode: 'numeric' });
    g.extras = area({ rows: 3, placeholder: 'um padrão por linha, ex.: \\bterraform\\s+apply\\b' });
    g.extras.value = v.extras.join('\n');
    g.anuncio = h('p', { class: 'esc-pn-sr', role: 'status', 'aria-live': 'polite' });
    g.anunciar = (t) => { g.anuncio.textContent = ''; setTimeout(() => { g.anuncio.textContent = t; }, 30); };

    g.lista = h('ol', { class: 'esc-pn-membros', 'aria-label': 'Membros do escritório' });
    g.vazio = h('p', { class: 'esc-pn-dica esc-pn-membros-vazio' }, 'Nenhum membro: o orquestrador trabalha sozinho e usa convidados, se o limite permitir.');
    g.contador = h('span', { class: 'esc-pn-contador' });
    g.add = h('button', { type: 'button', class: 'esc-pn-btn', onclick: () => {
      const m = adicionar(g, {}, true);
      if (m) { g.sujo = true; m.papel.focus(); m.el.scrollIntoView?.({ block: 'nearest' }); }
    } }, 'Adicionar membro');
    v.membros.forEach((d) => adicionar(g, d, false));
    redesenharMembros(g);

    g.notaModelos = h('p', { class: 'esc-pn-dica esc-pn-nota-modelos', hidden: true },
      'Não consegui ler a lista de modelos: ', h('span', { class: 'esc-pn-nota-tx' }), ' ',
      h('button', { type: 'button', class: 'esc-pn-link', onclick: () => carregarModelos(true) }, 'Tentar de novo'));
    const atualizaNota = () => { if (E === eu) g.notaModelos.querySelector('.esc-pn-nota-tx').textContent = E.modelosErro || ''; };

    g.erro = h('div', { class: 'esc-pn-erro', role: 'alert', hidden: true });
    g.salvar = h('button', { type: 'submit', class: 'esc-pn-btn esc-pn-solido' }, modo === 'novo' ? 'Criar escritório' : 'Salvar');
    g.cancelar = h('button', { type: 'button', class: 'esc-pn-btn', onclick: () => fecharGaveta(true) }, 'Cancelar');
    g.acoesEsq = h('div', { class: 'esc-pn-rodape-esq' });
    if (modo === 'editar') {
      g.dup = h('button', { type: 'button', class: 'esc-pn-btn', onclick: () => duplicarDaGaveta(g) }, 'Duplicar');
      g.exc = h('button', { type: 'button', class: 'esc-pn-btn esc-pn-perigo', onclick: () => confirmarExcluir(g) }, 'Excluir');
      g.acoesEsq.append(g.dup, g.exc);
    }
    g.confirma = h('div', { class: 'esc-pn-confirma', role: 'alertdialog', 'aria-label': 'Confirmar exclusão', hidden: true });
    g.botoes = h('div', { class: 'esc-pn-rodape-btns' }, g.acoesEsq, h('span', { class: 'esc-pn-esp' }), g.cancelar, g.salvar);

    g.corpo = h('div', { class: 'esc-pn-gaveta-corpo' },
      secao('Escritório',
        campo('Nome', g.nome),
        campo('Função', g.funcao, 'Em uma frase: o que o time entrega.'),
        campo('Pasta de trabalho', g.pasta, 'Caminho absoluto de uma pasta que já existe. Notas e progresso dos membros ficam nela.')),
      secao('Orquestrador',
        campo('Nome do orquestrador', g.orqNome),
        campo('Prompt do orquestrador', g.orqPrompt),
        g.orqPar.el),
      secao('Membros',
        h('div', { class: 'esc-pn-membros-cab' }, g.contador, g.add),
        g.vazio, g.lista, g.notaModelos),
      secao('Convidados',
        campo('Limite de convidados', g.limite, 'Subagentes que o orquestrador pode abrir ao mesmo tempo (0 a 6).')),
      secao('Orçamento (US$)',
        h('div', { class: 'esc-pn-dupla' },
          campo('Por execução', g.porExec),
          campo('Por dia', g.porDia)),
        campo('Aviso em % do orçamento', g.aviso, 'Entre 50 e 95. Ao chegar em 100% a execução pausa sozinha.')),
      secao('Ações externas',
        campo('Padrões extras', g.extras, 'Expressões regulares testadas contra comandos Bash e PowerShell, uma por linha (até 20). O que bater pede a sua aprovação.')),
      g.anuncio);

    g.titulo = h('h2', { class: 'esc-pn-gaveta-tit', id: tituloId }, modo === 'novo' ? 'Novo escritório' : `Configurar: ${esc.nome}`);
    g.fechar = h('button', { type: 'button', class: 'esc-pn-x', 'aria-label': 'Fechar gaveta (Esc)', onclick: () => fecharGaveta(true) }, '×');
    g.form = h('form', { class: 'esc-pn-form', novalidate: true },
      h('header', { class: 'esc-pn-gaveta-cab' }, g.titulo, g.fechar),
      g.corpo,
      h('footer', { class: 'esc-pn-rodape' }, g.erro, g.confirma, g.botoes));
    g.form.addEventListener('submit', (ev) => { ev.preventDefault(); salvar(g); });
    const sujar = () => { g.sujo = true; };
    g.form.addEventListener('input', sujar);
    g.form.addEventListener('change', sujar);
    g.el = h('aside', { class: 'esc-pn-gaveta', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': tituloId, 'data-aberto': '1' }, g.form);
    g.teclas = (ev) => { if (ev.key === 'Escape' && !ev.defaultPrevented) { ev.preventDefault(); fecharGaveta(true); } };
    document.addEventListener('keydown', g.teclas);
    document.body.append(g.el);

    if (!E.modelos || E.modelosErro) {
      carregarModelos(true).then(atualizaNota);
    }
    atualizaNota();
    g.notaModelos.hidden = !E.modelosErro;
    carregarCodex(true); // refaz a lista a cada abertura: o Codex pode ter sido ligado/desligado nas Configurações
    g.nome.focus();
    return true;
  }

  function fecharGaveta(devolverFoco) {
    const g = E && E.gaveta;
    if (!g) return;
    document.removeEventListener('keydown', g.teclas);
    g.el.remove();
    E.gaveta = null;
    if (devolverFoco && g.abridor && g.abridor.isConnected && !g.abridor.disabled) g.abridor.focus();
  }

  // Gaveta com alterações não salvas?
  const gavetaSuja = () => !!(E && E.gaveta && E.gaveta.sujo);

  // Diálogo "Descartar alterações?" (Manter / Descartar). Resolve true só se a pessoa descartar.
  function perguntarDescartar() {
    return new Promise((resolve) => {
      const eu = E;
      if (eu.dialogo) eu.dialogo.fechar(false, false); // um pedido mais novo substitui a pergunta anterior
      const antes = document.activeElement;
      const d = { fechado: false };
      const txId = novoId('dlg-tx');
      d.nao = h('button', { type: 'button', class: 'esc-pn-btn', onclick: () => d.fechar(false) }, 'Manter');
      d.sim = h('button', { type: 'button', class: 'esc-pn-btn esc-pn-perigo', onclick: () => d.fechar(true) }, 'Descartar');
      d.caixa = h('div', { class: 'esc-pn-dialogo-caixa', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': 'Descartar alterações', 'aria-describedby': txId },
        h('p', { class: 'esc-pn-dialogo-tx', id: txId }, h('strong', null, 'Descartar alterações?'), ' O formulário tem mudanças que ainda não foram salvas.'),
        h('div', { class: 'esc-pn-dialogo-btns' }, d.nao, d.sim));
      d.el = h('div', { class: 'esc-pn-dialogo', 'data-pergunta': 'descartar' }, d.caixa);
      d.el.addEventListener('mousedown', (ev) => { if (ev.target === d.el) d.fechar(false); });
      d.teclas = (ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); d.fechar(false); return; }
        if (ev.key === 'Tab') { // mantém o foco dentro do diálogo
          ev.preventDefault();
          const bs = [d.nao, d.sim];
          const i = bs.indexOf(document.activeElement);
          bs[ev.shiftKey ? (i <= 0 ? bs.length - 1 : i - 1) : (i < 0 || i === bs.length - 1 ? 0 : i + 1)].focus();
        }
      };
      d.fechar = (resultado, devolverFoco = true) => {
        if (d.fechado) return;
        d.fechado = true;
        document.removeEventListener('keydown', d.teclas, true);
        d.el.remove();
        if (eu.dialogo === d) eu.dialogo = null;
        if (devolverFoco && antes && antes.isConnected && !antes.disabled && typeof antes.focus === 'function') antes.focus();
        resolve(resultado);
      };
      eu.dialogo = d;
      document.addEventListener('keydown', d.teclas, true);
      document.body.append(d.el);
      d.nao.focus();
    });
  }

  // Pode seguir sem a gaveta? Sem gaveta ou sem alterações, fecha direto (síncrono); com alterações pergunta.
  // Resolve true quando a gaveta foi fechada (ou não havia), false se a pessoa quis manter (ou o painel desmontou).
  async function descartarGaveta() {
    const eu = E;
    const g = eu && eu.gaveta;
    if (!g) return true;
    if (g.sujo) {
      const sim = await perguntarDescartar();
      if (E !== eu) return false;
      if (!sim) return false;
    }
    if (E.gaveta === g) fecharGaveta(false);
    return true;
  }

  function mostrarErroGaveta(g, texto) {
    g.erro.hidden = !texto;
    g.erro.textContent = texto || '';
    if (texto) g.erro.scrollIntoView?.({ block: 'nearest' });
  }

  function travar(g, sim) {
    g.ocupado = sim;
    for (const b of [g.salvar, g.cancelar, g.dup, g.exc, g.add]) if (b) b.disabled = sim || (b === g.add && g.membros.length >= MAX_MEMBROS);
    g.salvar.textContent = sim ? 'Salvando…' : g.modo === 'novo' ? 'Criar escritório' : 'Salvar';
  }

  const numOuNada = (el) => (el.value.trim() === '' ? undefined : Number(el.value));

  function corpoDoForm(g) {
    return {
      nome: g.nome.value.trim(),
      funcao: g.funcao.value.trim(),
      pasta: g.pasta.value.trim(),
      orquestrador: { nome: g.orqNome.value.trim(), prompt: g.orqPrompt.value, ...g.orqPar.ler() },
      membros: g.membros.map((m) => m.ler()),
      convidados: { limite: numOuNada(g.limite) },
      orcamento: { porExecucaoUsd: numOuNada(g.porExec), porDiaUsd: numOuNada(g.porDia), avisoPct: numOuNada(g.aviso) },
      externas: { extras: g.extras.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) },
    };
  }

  async function salvar(g) {
    if (g.ocupado) return;
    mostrarErroGaveta(g, '');
    const corpo = corpoDoForm(g);
    if (corpo.externas.extras.length > MAX_EXTRAS) { mostrarErroGaveta(g, `Use até ${MAX_EXTRAS} padrões de ação externa.`); return; }
    if (g.modo === 'novo' && g.canvas) corpo.canvas = g.canvas;
    travar(g, true);
    const eu = E;
    try {
      const j = await api(g.modo === 'novo' ? '/escritorios' : `/escritorios/${encodeURIComponent(g.id)}`, { post: true, corpo });
      if (E !== eu) return;
      const id = j.escritorio && j.escritorio.id;
      if (E.gaveta === g) fecharGaveta(true);
      avisar(g.modo === 'novo' ? `Escritório "${j.escritorio?.nome}" criado.` : 'Alterações salvas.', 'ok');
      await recarregar();
      if (E !== eu) return;
      if (g.modo === 'novo' && id && E.lista.some((x) => x.id === id)) await escolher(id, true);
      else if (id === E.sel) carregarDetalhe(id);
      if (E !== eu) return;
      if (id) notificar(g.modo === 'novo' ? 'criado' : 'salvo', id);
    } catch (e) {
      if (E === eu && E.gaveta === g) { travar(g, false); mostrarErroGaveta(g, textoErro(e)); }
    }
  }

  function notificar(tipo, id) {
    try { if (E) E.onMudou({ tipo, id }); } catch { /* a página decide */ }
  }

  // Núcleo de "duplicar": chama o servidor, atualiza a lista e devolve o resumo da cópia. Não muda a seleção nem avisa a página.
  async function duplicarNoServidor(id) {
    const eu = E;
    const j = await api(`/escritorios/${encodeURIComponent(id)}/duplicar`, { post: true });
    if (E !== eu) return j.escritorio || null;
    avisar(`Duplicado como "${j.escritorio?.nome}".`, 'ok');
    await recarregar();
    return (E && E.lista.find((x) => x.id === j.escritorio?.id)) || j.escritorio || null;
  }

  async function duplicarDaGaveta(g) {
    if (g.ocupado) return;
    mostrarErroGaveta(g, '');
    travar(g, true);
    const eu = E;
    try {
      const j = await api(`/escritorios/${encodeURIComponent(g.id)}/duplicar`, { post: true });
      if (E !== eu) return;
      if (E.gaveta === g) fecharGaveta(true);
      avisar(`Duplicado como "${j.escritorio?.nome}".`, 'ok');
      await recarregar();
      if (E !== eu) return;
      const novoId = j.escritorio?.id;
      if (novoId && E.lista.some((x) => x.id === novoId)) await escolher(novoId, true);
      if (E !== eu) return;
      if (novoId) notificar('duplicado', novoId);
    } catch (e) {
      if (E === eu && E.gaveta === g) { travar(g, false); mostrarErroGaveta(g, textoErro(e)); }
    }
  }

  const textoConfirma = (nome) => `Excluir "${nome}"? O cadastro e o gasto do dia somem; as notas na pasta de trabalho ficam. Não dá para desfazer.`;

  // Núcleo de "excluir": chama o servidor e tira o escritório da lista (fecha a gaveta dele; troca o selecionado se preciso).
  async function excluirNoServidor(id) {
    const eu = E;
    await api(`/escritorios/${encodeURIComponent(id)}/excluir`, { post: true });
    if (E !== eu) return;
    if (E.gaveta && E.gaveta.id === id) fecharGaveta(false);
    E.lista = E.lista.filter((x) => x.id !== id);
    if (E.sel === id) {
      sumiu(id); // dentro dele? a página volta ao canvas antes de o painel escolher o substituto
      if (E === eu) await escolher(E.lista.length ? E.lista[0].id : '', true);
    } else atualizarBarra();
    notificar('excluido', id);
  }

  function confirmarExcluir(g) {
    if (g.ocupado) return;
    mostrarErroGaveta(g, '');
    const nome = g.titulo.textContent.replace(/^Configurar:\s*/, '');
    const sim = h('button', { type: 'button', class: 'esc-pn-btn esc-pn-perigo', onclick: () => excluirDaGaveta(g) }, 'Excluir de vez');
    const nao = h('button', { type: 'button', class: 'esc-pn-btn', onclick: () => { g.confirma.hidden = true; g.botoes.hidden = false; g.exc.focus(); } }, 'Manter');
    g.confirma.replaceChildren(
      h('p', { class: 'esc-pn-confirma-tx' }, textoConfirma(nome)),
      h('div', { class: 'esc-pn-confirma-btns' }, nao, sim));
    g.confirma.hidden = false;
    g.botoes.hidden = true;
    nao.focus();
  }

  async function excluirDaGaveta(g) {
    if (g.ocupado) return;
    g.ocupado = true;
    g.confirma.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      const nome = g.titulo.textContent.replace(/^Configurar:\s*/, '');
      const eu = E;
      await excluirNoServidor(g.id);
      if (E !== eu) return;
      avisar(`Escritório "${nome}" excluído.`, 'ok');
      E.ui.novo.focus();
    } catch (e) {
      if (E && E.gaveta === g) {
        g.ocupado = false;
        g.confirma.hidden = true;
        g.botoes.hidden = false;
        mostrarErroGaveta(g, textoErro(e));
        g.exc.focus();
      }
    }
  }

  // Diálogo próprio de confirmação (fora da gaveta): mesmo texto e botões. Resolve true só se o servidor excluiu.
  function dialogoExcluir(id, nome) {
    return new Promise((resolve) => {
      const eu = E;
      const antes = document.activeElement;
      const d = { ocupado: false, fechado: false };
      const txId = novoId('dlg-tx');
      d.erro = h('div', { class: 'esc-pn-erro', role: 'alert', hidden: true });
      d.nao = h('button', { type: 'button', class: 'esc-pn-btn', onclick: () => d.fechar(false) }, 'Manter');
      d.sim = h('button', { type: 'button', class: 'esc-pn-btn esc-pn-perigo', onclick: () => confirmar() }, 'Excluir de vez');
      d.caixa = h('div', { class: 'esc-pn-dialogo-caixa', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': 'Confirmar exclusão', 'aria-describedby': txId },
        h('p', { class: 'esc-pn-dialogo-tx', id: txId }, textoConfirma(nome)), d.erro,
        h('div', { class: 'esc-pn-dialogo-btns' }, d.nao, d.sim));
      d.el = h('div', { class: 'esc-pn-dialogo' }, d.caixa);
      d.el.addEventListener('mousedown', (ev) => { if (ev.target === d.el && !d.ocupado) d.fechar(false); });
      d.teclas = (ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); if (!d.ocupado) d.fechar(false); return; }
        if (ev.key === 'Tab') { // mantém o foco dentro do diálogo
          const bs = [d.nao, d.sim].filter((b) => !b.disabled);
          ev.preventDefault();
          if (!bs.length) return;
          const i = bs.indexOf(document.activeElement);
          bs[ev.shiftKey ? (i <= 0 ? bs.length - 1 : i - 1) : (i < 0 || i === bs.length - 1 ? 0 : i + 1)].focus();
        }
      };
      d.fechar = (resultado, devolverFoco = true) => {
        if (d.fechado) return;
        d.fechado = true;
        document.removeEventListener('keydown', d.teclas, true);
        d.el.remove();
        if (eu && eu.dialogo === d) eu.dialogo = null;
        if (devolverFoco && antes && antes.isConnected && !antes.disabled && typeof antes.focus === 'function') antes.focus();
        resolve(resultado);
      };
      async function confirmar() {
        if (d.ocupado) return;
        d.ocupado = true;
        d.sim.disabled = true; d.nao.disabled = true;
        d.erro.hidden = true;
        try {
          await excluirNoServidor(id);
          if (E === eu) avisar(`Escritório "${nome}" excluído.`, 'ok');
          d.fechar(true);
        } catch (e) {
          d.ocupado = false;
          d.sim.disabled = false; d.nao.disabled = false;
          d.erro.textContent = textoErro(e);
          d.erro.hidden = false;
          d.nao.focus();
        }
      }
      eu.dialogo = d;
      document.addEventListener('keydown', d.teclas, true);
      document.body.append(d.el);
      d.nao.focus();
    });
  }

  // ───────────────────────── API pública ─────────────────────────

  function montar(elemento, opcoes = {}) {
    if (E) desmontar();
    if (!(elemento instanceof Element)) throw new Error('EscritoriosPainel.montar: informe o elemento onde a barra vai.');
    E = {
      raiz: elemento, base: String(opcoes.base || '').replace(/\/+$/, ''),
      onSelecionar: typeof opcoes.onSelecionar === 'function' ? opcoes.onSelecionar : () => {},
      onVoltar: typeof opcoes.onVoltar === 'function' ? opcoes.onVoltar : null,
      onMudou: typeof opcoes.onMudou === 'function' ? opcoes.onMudou : () => {},
      onSumiu: typeof opcoes.onSumiu === 'function' ? opcoes.onSumiu : null,
      carregou: false, pendente: '', seqGaveta: 0, toast: null,
      lista: [], sel: opcoes.selecionado || lerSel() || '', det: null, modelos: null, modelosErro: '', codex: { estado: 'desconhecido', modelos: [], aviso: '' },
      ocupado: false, gaveta: null, dialogo: null, g: 0, gd: 0, ui: null,
    };
    E.barra = criarBarra();
    elemento.append(E.barra);
    criarToast();
    atualizarBarra();
    carregarModelos(false);
    return recarregar();
  }

  function desmontar() {
    if (!E) return;
    clearTimeout(timerAviso);
    fecharGaveta(false);
    if (E.dialogo) E.dialogo.fechar(false, false);
    E.barra.remove();
    if (E.toast) E.toast.el.remove();
    E.g++; E.gd++; E.seqGaveta++;
    E = null;
  }

  // Alerta de orçamento (`alerta:{tipo:'aviso'|'pausa', texto}` no evento): faixa âmbar (aviso) ou vermelha (pausa)
  // e, se a permissão de notificações já estiver concedida (nunca pede), Notification do sistema cujo clique
  // foca a janela e seleciona o escritório.
  function mostrarAlerta(id, ev) {
    const tipo = ev.alerta.tipo === 'pausa' ? 'pausa' : 'aviso';
    const texto = String(ev.alerta.texto || '').trim() || (tipo === 'pausa' ? 'Escritório pausado.' : 'Orçamento do escritório perto do limite.');
    const nome = (ev.resumo && ev.resumo.nome) || (E.lista.find((x) => x.id === id) || {}).nome || '';
    avisar(texto, tipo);
    try {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const n = new Notification(nome ? `Orbit · ${nome}` : 'Orbit · Escritório', { body: texto, tag: `escritorio-${id}-${tipo}` });
      n.onclick = () => {
        try { window.focus(); n.close(); } catch { /* sem foco */ }
        if (E) selecionar(id);
      };
    } catch { /* notificação é só um extra */ }
  }

  function atualizar(ev) {
    if (!E) return;
    if (!ev || typeof ev !== 'object') { recarregar(); return; }
    const id = ev.id || (ev.resumo && ev.resumo.id);
    if (!id) { recarregar(); return; }
    if (ev.alerta && typeof ev.alerta === 'object') mostrarAlerta(id, ev);
    if (ev.resumo === null) { // excluído
      E.lista = E.lista.filter((x) => x.id !== id);
      if (E.gaveta && E.gaveta.id === id) fecharGaveta(false);
      if (E.sel === id) {
        sumiu(id);
        if (E) escolher(E.lista.length ? E.lista[0].id : '', true);
      } else atualizarBarra();
      return;
    }
    if (!ev.resumo || typeof ev.resumo !== 'object') { recarregar(); return; }
    const i = E.lista.findIndex((x) => x.id === id);
    if (i >= 0) E.lista[i] = ev.resumo; else E.lista.push(ev.resumo);
    ordenar();
    if (E.pendente === id) { escolher(id, true); return; } // a entrada pedida antes da lista chegar apareceu por aqui
    if (!E.sel && E.lista.length) { escolher(E.lista[0].id, true); return; }
    atualizarBarra();
    if (id === E.sel) carregarDetalhe(id);
  }

  // Selecionar por fora. Se a lista ainda não chegou, guarda o id (pendente) e aplica quando ela chegar; enquanto isso a faixa
  // não aponta para outro escritório (sem seleção, "Acionar" fica desligado).
  function selecionar(id) {
    if (!E || !id) return;
    if (E.lista.some((x) => x.id === id)) { escolher(id, true); return; }
    if (E.carregou) return;
    E.pendente = String(id);
    E.sel = '';
    E.det = null;
    atualizarBarra();
  }

  // ───────────────────────── API para o canvas (funciona com a faixa escondida) ─────────────────────────

  const canvasValido = (c) => (c && Number.isFinite(Number(c.x)) && Number.isFinite(Number(c.y)) ? { x: Number(c.x), y: Number(c.y) } : null);
  const focado = () => (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);

  function abrirGaveta(modo, id, opcoes) {
    if (!E) return Promise.resolve(false);
    const ref = modo === 'editar' ? String(id || E.sel || '') : '';
    return abrirGavetaInterna(modo, { id: ref, abridor: focado(), canvas: modo === 'novo' ? canvasValido(opcoes && opcoes.canvas) : null });
  }

  async function duplicar(id) {
    if (!E) throw { status: 0, mensagem: 'O painel de escritórios não está montado.' };
    if (!id) throw { status: 400, mensagem: PADRAO_ERRO[400] };
    try {
      const resumo = await duplicarNoServidor(String(id));
      if (resumo && resumo.id) notificar('duplicado', resumo.id);
      return resumo;
    } catch (e) {
      if (E) avisar(textoErro(e));
      throw e;
    }
  }

  async function excluir(id) {
    if (!E || !id) return false;
    id = String(id);
    if (E.dialogo) E.dialogo.fechar(false, false);
    let nome = (E.lista.find((x) => x.id === id) || {}).nome;
    if (!nome) {
      const eu = E;
      try { nome = (await api(`/escritorios/${encodeURIComponent(id)}`)).escritorio?.nome; } catch { /* usa o id */ }
      if (E !== eu) return false;
    }
    return dialogoExcluir(id, nome || id);
  }

  window.EscritoriosPainel = { montar, desmontar, atualizar, selecionar, abrirGaveta, duplicar, excluir, gavetaSuja, descartarGaveta };
})();
