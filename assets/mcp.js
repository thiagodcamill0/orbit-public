/* Configurações → Conexões MCP (mcp.mjs no servidor).
 *
 * Lista os servidores MCP de um projeto: os do .mcp.json (também os herdados das pastas de cima), os pessoais do
 * ~/.claude.json e, depois da verificação, os de plugin e do claude.ai (só leitura). Mostra o tipo, onde estão
 * salvos e o status; adiciona (no projeto por padrão), remove, ativa e desativa. O que é pessoal pergunta antes.
 * Servidor novo ou alterado no .mcp.json fica pendente até ser aprovado aqui, com o comando ou a URL à vista.
 *
 * window.Mcp = { montar({el, toast, icone, balao}), atualizar(), receber(d) }. O index.html carrega este arquivo
 * na primeira abertura das Configurações e repassa o SSE "mcp".
 */
(function () {
  'use strict';
  const ONDE = {
    projeto: ['Projeto', '.mcp.json do projeto, vai para o git'],
    local: ['Pessoal · este projeto', '~/.claude.json, só neste projeto'],
    pessoal: ['Pessoal · todos', '~/.claude.json, vale em todos os projetos'],
    plugin: ['Plugin', 'Vem de um plugin (/plugin)'],
    'claude.ai': ['claude.ai', 'Conector da sua conta no claude.ai'],
    gerenciado: ['Gerenciado', 'Definido por uma política da organização'],
    dynamic: ['Sessão', 'Adicionado por outra ferramenta ao abrir a sessão'],
  };
  const STATUS = {
    connected: ['ok', 'Conectado'],
    failed: ['erro', 'Falhou'],
    'needs-auth': ['aviso', 'Precisa autenticar: rode /mcp numa sessão do Claude Code'],
    pending: ['neutro', 'Ainda conectando'],
    pendente: ['aviso', 'Aguardando sua aprovação'],
    desativado: ['off', 'Desativado neste projeto'],
    disabled: ['off', 'Desativado'],
    ausente: ['off', 'Não apareceu na verificação'],
  };
  const CHAVE_PASTA = 'gi.mcp-pasta';
  const st = {
    el: null, toast: () => {}, icone: () => null, balao: null,
    pasta: lerLocal(CHAVE_PASTA), dados: null, ocupado: false, verificando: false, erro: '', form: null, auto: new Set(),
  };

  function lerLocal(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }
  function gravarLocal(k, v) { try { localStorage.setItem(k, v); } catch {} }

  function h(tag, props, ...filhos) {
    const e = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'value') e.value = v;
        else if (k === 'checked') e.checked = !!v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const f of filhos) if (f != null && f !== false) e.append(f);
    return e;
  }

  async function pedir(caminho, corpo) {
    const r = await fetch(caminho, corpo === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
    let d = null;
    try { d = await r.json(); } catch {}
    if (!r.ok) {
      const e = new Error((d && d.erro) || 'HTTP ' + r.status);
      e.status = r.status;
      e.codigo = d && d.codigo;
      throw e;
    }
    return d;
  }

  // Confirmação em balão (o do index.html); sem ele, a do navegador.
  async function confirmar(cfg) {
    if (st.balao) return (await st.balao(cfg)).ok;
    return window.confirm((cfg.titulo || '') + '\n\n' + (cfg.texto || ''));
  }
  function confirmarPessoal(onde, acao, gatilho) {
    const todos = onde === 'pessoal';
    return confirmar({
      titulo: acao + ' na configuração pessoal?',
      texto: 'Isso muda o ' + ((st.dados && st.dados.claudeJson) || '~/.claude.json') + ', o arquivo pessoal do Claude Code. '
        + (todos ? 'Vale para todos os projetos e também para o Claude Code fora do Orbit.' : 'Vale só para este projeto, mas também no Claude Code fora do Orbit.'),
      sim: 'Confirmar',
      perigo: true,
      gatilho,
    });
  }

  // ───────────────────────────── desenho ─────────────────────────────
  const chaveFoco = (el) => (el && el.closest && el.closest('[data-k]') ? el.closest('[data-k]').dataset.k : '');

  function render() {
    const el = st.el;
    if (!el) return;
    const focoK = el.contains(document.activeElement) ? chaveFoco(document.activeElement) : '';
    const d = st.dados;
    const filhos = [cabecalho(d)];
    filhos.push(h('p', { class: 'mcp-nota' }, 'Os servidores novos vão para o .mcp.json do projeto. As chaves de acesso ficam cifradas fora do projeto e só chegam às instâncias abertas pelo Orbit.'));
    if (st.erro) filhos.push(h('p', { class: 'mcp-erro', role: 'alert' }, st.erro));
    if (d && d.avisos && d.avisos.length) for (const a of d.avisos) filhos.push(h('p', { class: 'mcp-erro' }, a));
    if (d && d.pendentes) {
      filhos.push(h('p', { class: 'mcp-pend', role: 'status' }, st.icone('alerta', 14),
        h('span', null, (d.pendentes === 1 ? '1 servidor do .mcp.json espera' : d.pendentes + ' servidores do .mcp.json esperam') + ' sua aprovação. As instâncias do Orbit não os conectam antes disso.')));
    }
    if (st.form) filhos.push(formulario());
    if (!d) filhos.push(h('p', { class: 'mcp-vazio' }, st.erro ? '' : 'Carregando…'));
    else if (!d.pasta) filhos.push(h('p', { class: 'mcp-vazio' }, 'Nenhum projeto conhecido ainda.'));
    else if (!d.servidores.length) filhos.push(h('p', { class: 'mcp-vazio' }, st.verificando ? 'Verificando as conexões…' : 'Nenhum servidor MCP neste projeto.'));
    else filhos.push(h('ul', { class: 'mcp-lista', 'aria-label': 'Servidores MCP' }, ...d.servidores.map(servidor)));
    if (d && d.pasta) filhos.push(h('p', { class: 'mcp-rodape' }, 'Desativar um servidor do projeto grava no .claude/settings.json dele. Um pessoal é desativado só neste projeto. As sessões abertas só veem as mudanças quando reiniciam.'));
    el.replaceChildren(...filhos);
    el.setAttribute('aria-busy', String(st.ocupado || st.verificando));
    if (focoK) {
      const alvo = el.querySelector('[data-k="' + CSS.escape(focoK) + '"]');
      if (alvo) alvo.focus();
    }
  }

  function cabecalho(d) {
    const sel = h('select', { class: 'mcp-campo mcp-sel', 'aria-label': 'Projeto', 'data-k': 'projeto', disabled: !d || !d.projetos || !d.projetos.length || st.ocupado,
      onchange: (e) => { st.pasta = e.target.value; gravarLocal(CHAVE_PASTA, st.pasta); st.form = null; atualizar(); } });
    for (const p of (d && d.projetos) || []) sel.append(h('option', { value: p.pasta, title: p.pasta }, p.nome || p.pasta));
    if (d && d.pasta) sel.value = d.pasta;
    const quando = d && d.sonda && d.sonda.quando ? new Date(d.sonda.quando) : null;
    return h('div', { class: 'mcp-cab' },
      h('span', { class: 'mcp-sel-w' }, sel),
      h('span', { class: 'mcp-quando', title: quando ? 'Última verificação: ' + quando.toLocaleString() : '' },
        st.verificando ? 'Verificando…' : quando ? 'Verificado às ' + quando.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''),
      h('button', { type: 'button', class: 'btn p', 'data-k': 'verificar', disabled: !d || !d.pasta || st.verificando || st.ocupado, onclick: () => verificar(true),
        title: 'Sobe os servidores ativos e aprovados por um instante para ver se conectam' }, st.icone('atividade', 13), h('span', null, 'Verificar')),
      h('button', { type: 'button', class: 'btn p', 'data-k': 'adicionar', disabled: !d || !d.pasta || st.ocupado || !!st.form, onclick: abrirForm }, st.icone('mais', 13), h('span', null, 'Adicionar')));
  }

  function statusDe(s) {
    if (s.status) return STATUS[s.status] || ['neutro', s.status];
    return st.verificando ? ['neutro', 'Verificando…'] : ['neutro', 'Ainda não verificado'];
  }

  function servidor(s) {
    const [tom, rot] = statusDe(s);
    const [ondeRot, ondeDica] = ONDE[s.onde] || [s.onde, ''];
    const alvo = s.tipo === 'remoto' ? s.url || '' : s.comando || '';
    const k = s.id;
    const linhas = [
      h('div', { class: 'mcp-l1' },
        h('strong', { class: 'mcp-nome', title: s.nome }, s.nome),
        h('span', { class: 'mcp-chip', title: s.tipo === 'remoto' ? 'Remoto: conecta por ' + String(s.transporte || 'http').toUpperCase() : 'Local: roda um comando na sua máquina' }, s.tipo === 'remoto' ? 'Remoto' : 'Local'),
        h('span', { class: 'mcp-chip', title: ondeDica + (s.arquivo ? ' · ' + s.arquivo : '') }, s.herdado ? ondeRot + ' · pasta de cima' : ondeRot)),
      h('div', { class: 'mcp-l2 mcp-' + tom }, h('span', { class: 'mcp-ponto', 'aria-hidden': 'true' }), h('span', null, rot + (s.erro ? ': ' + s.erro : ''))),
    ];
    if (alvo && !(s.status === 'pendente')) linhas.push(h('code', { class: 'mcp-cmd', title: alvo }, alvo));
    if (s.chaves && s.chaves.length) {
      linhas.push(h('div', { class: 'mcp-chaves' }, ...s.chaves.map((c) => h('span', {
        class: 'mcp-chave-it' + (c.guardada ? '' : ' mcp-falta'),
        title: c.guardada ? 'Valor cifrado no cofre do Orbit; o arquivo tem só ${' + c.variavel + '}' : 'O arquivo pede ${' + c.variavel + '}, mas o cofre desta máquina não tem o valor',
      }, st.icone(c.guardada ? 'cadeado' : 'alerta', 12), (c.chave || c.variavel) + (c.guardada ? ' no cofre' : ' sem valor nesta máquina')))));
    }
    if (s.variaveis && s.variaveis.length) linhas.push(h('p', { class: 'mcp-dica' }, 'Usa variáveis do ambiente: ' + s.variaveis.join(', ') + '. Se faltarem, o servidor sobe sem elas.'));
    const tp = s.textoPuro || [];
    if (tp.length) {
      const prot = tp.filter((x) => x.onde === 'env' || x.onde === 'header');
      linhas.push(h('div', { class: 'mcp-alerta' },
        h('span', null, 'Chave em texto puro no ' + (s.onde === 'projeto' ? 'projeto' : 'arquivo pessoal') + ': '
          + tp.map((x) => x.chave || (x.onde === 'arg' ? 'argumento do comando' : 'URL')).join(', ') + '.'
          + (prot.length < tp.length ? ' Tire do comando ou da URL à mão e use "Chaves de acesso".' : '')),
        s.onde === 'projeto' && prot.length && !s.herdado && s.editavel
          ? h('button', { type: 'button', class: 'btn p', 'data-k': 'proteger' + k, disabled: st.ocupado, onclick: (e) => proteger(s, e.currentTarget) }, st.icone('cadeado', 12), h('span', null, 'Proteger'))
          : null));
    }
    if (s.status === 'pendente') {
      linhas.push(h('div', { class: 'mcp-aprovar' },
        h('p', null, s.aprovacao === 'alterado' ? 'A configuração mudou desde a sua aprovação. Confira o que vai rodar:' : 'Novo no .mcp.json. Confira o que vai rodar antes de aprovar:'),
        h('code', { class: 'mcp-cmd mcp-cmd-todo' }, alvo || '(sem comando)'),
        (s.env && s.env.length) || (s.cabecalhos && s.cabecalhos.length)
          ? h('p', { class: 'mcp-dica' }, (s.env && s.env.length ? 'Variáveis: ' + s.env.join(', ') + '. ' : '') + (s.cabecalhos && s.cabecalhos.length ? 'Cabeçalhos: ' + s.cabecalhos.join(', ') + '.' : ''))
          : null,
        s.arquivo ? h('p', { class: 'mcp-dica', title: s.arquivo }, 'Arquivo: ' + s.arquivo) : null,
        h('div', { class: 'mcp-aprovar-b' },
          h('button', { type: 'button', class: 'btn p solido', 'data-k': 'aprovar' + k, disabled: st.ocupado, onclick: () => aprovar(s) }, st.icone('check', 12), h('span', null, 'Aprovar')))));
    }
    const podeMudar = s.editavel !== false;
    const acoes = h('div', { class: 'mcp-acoes' },
      h('input', {
        type: 'checkbox', class: 'chave mcp-tg', 'data-k': 'tg' + k, checked: !s.desativado,
        disabled: !podeMudar || st.ocupado,
        title: !podeMudar ? (s.onde === 'plugin' ? 'Vem de um plugin: mude pelo /plugin' : 'Conector do claude.ai: mude nas configurações da conta ou pelo /mcp') : s.desativado ? 'Ativar neste projeto' : 'Desativar neste projeto',
        'aria-label': (s.desativado ? 'Ativar ' : 'Desativar ') + s.nome,
        onchange: (e) => alternar(s, e.currentTarget),
      }),
      podeMudar && !s.herdado
        ? h('button', { type: 'button', class: 'btn-icone mcp-x', 'data-k': 'rm' + k, disabled: st.ocupado, title: 'Remover ' + s.nome, 'aria-label': 'Remover ' + s.nome, onclick: (e) => remover(s, e.currentTarget) }, st.icone('lixeira', 13))
        : h('span', { class: 'mcp-x-vago' }));
    return h('li', { class: 'mcp-srv' + (s.desativado ? ' mcp-srv-off' : '') + (s.status === 'pendente' ? ' mcp-srv-pend' : '') },
      h('span', { class: 'mcp-mono', 'aria-hidden': 'true' }, st.icone(s.tipo === 'remoto' ? 'globo' : 'terminal', 14)),
      h('div', { class: 'mcp-meio' }, ...linhas),
      acoes);
  }

  // ───────────────────────────── formulário ─────────────────────────────
  function abrirForm() {
    st.form = { nome: '', tipo: 'local', comando: '', url: '', transporte: 'http', chaves: [], onde: 'projeto', erro: '' };
    render();
    const n = st.el.querySelector('[data-k="f-nome"]');
    if (n) n.focus();
  }
  function formulario() {
    const f = st.form;
    const campo = (k, props) => h('input', { class: 'mcp-campo' + (props.mono ? ' mono' : ''), 'data-k': 'f-' + k, value: f[k], spellcheck: 'false', autocomplete: 'off',
      oninput: (e) => { f[k] = e.target.value; }, ...props, mono: null });
    const tipoBtn = (t, rot) => h('button', { type: 'button', class: 'mcp-seg-b', 'data-k': 'f-tipo-' + t, 'aria-pressed': String(f.tipo === t),
      onclick: () => { f.tipo = t; render(); } }, rot);
    const linhaChave = (c, i) => h('div', { class: 'mcp-f-chave' },
      h('input', { class: 'mcp-campo mono', 'data-k': 'f-ck' + i, value: c.chave, placeholder: f.tipo === 'local' ? 'API_KEY' : 'Authorization', 'aria-label': 'Nome da chave ' + (i + 1), spellcheck: 'false', autocomplete: 'off', oninput: (e) => { c.chave = e.target.value; } }),
      h('input', { class: 'mcp-campo mono', type: 'password', 'data-k': 'f-cv' + i, value: c.valor, placeholder: f.tipo === 'local' ? 'valor' : 'Bearer …', 'aria-label': 'Valor da chave ' + (i + 1), autocomplete: 'new-password', oninput: (e) => { c.valor = e.target.value; } }),
      h('button', { type: 'button', class: 'btn-icone mcp-x', 'data-k': 'f-cx' + i, title: 'Tirar esta chave', 'aria-label': 'Tirar a chave ' + (i + 1), onclick: () => { f.chaves.splice(i, 1); render(); } }, st.icone('x', 12)));
    const ondeSel = h('select', { class: 'mcp-campo mcp-sel', 'data-k': 'f-onde', 'aria-label': 'Salvar em', onchange: (e) => { f.onde = e.target.value; render(); } },
      h('option', { value: 'projeto' }, 'Projeto (.mcp.json) · padrão'),
      h('option', { value: 'local' }, 'Pessoal · só este projeto'),
      h('option', { value: 'pessoal' }, 'Pessoal · todos os projetos'));
    ondeSel.value = f.onde;
    return h('form', { class: 'mcp-form', 'aria-label': 'Adicionar servidor MCP', onsubmit: (e) => { e.preventDefault(); adicionar(e.submitter || null); } },
      h('div', { class: 'mcp-f-linha' }, h('label', { for: 'mcp-f-nome' }, 'Nome'), campo('nome', { id: 'mcp-f-nome', placeholder: 'github', maxlength: '64', mono: true })),
      h('div', { class: 'mcp-f-linha' }, h('span', { class: 'mcp-f-rot' }, 'Tipo'),
        h('div', { class: 'mcp-seg', role: 'group', 'aria-label': 'Tipo' }, tipoBtn('local', 'Local · comando'), tipoBtn('remoto', 'Remoto · URL'))),
      f.tipo === 'local'
        ? h('div', { class: 'mcp-f-linha' }, h('label', { for: 'mcp-f-cmd' }, 'Comando'), campo('comando', { id: 'mcp-f-cmd', placeholder: 'npx -y @modelcontextprotocol/server-memory', mono: true }))
        : h('div', { class: 'mcp-f-linha' }, h('label', { for: 'mcp-f-url' }, 'URL'),
          h('div', { class: 'mcp-f-url' }, campo('url', { id: 'mcp-f-url', placeholder: 'https://mcp.exemplo.com/mcp', mono: true, inputmode: 'url' }),
            (() => { const s = h('select', { class: 'mcp-campo mcp-sel', 'data-k': 'f-tr', 'aria-label': 'Transporte', onchange: (e) => { f.transporte = e.target.value; } }, h('option', { value: 'http' }, 'HTTP'), h('option', { value: 'sse' }, 'SSE')); s.value = f.transporte; return s; })())),
      f.tipo === 'local' ? h('p', { class: 'mcp-dica' }, 'Roda na sua máquina, na pasta do projeto. No Windows, comandos com npx costumam precisar de cmd /c na frente.') : null,
      h('div', { class: 'mcp-f-linha mcp-f-topo' }, h('span', { class: 'mcp-f-rot' }, 'Chaves de acesso'),
        h('div', { class: 'mcp-f-chaves' },
          ...f.chaves.map(linhaChave),
          h('button', { type: 'button', class: 'btn p mcp-f-mais', 'data-k': 'f-mais', disabled: f.chaves.length >= 20, onclick: () => { f.chaves.push({ chave: '', valor: '' }); render(); const c = st.el.querySelector('[data-k="f-ck' + (f.chaves.length - 1) + '"]'); if (c) c.focus(); } },
            st.icone('mais', 12), h('span', null, f.chaves.length ? 'Outra chave' : 'Adicionar chave')),
          h('p', { class: 'mcp-dica' }, (f.tipo === 'local' ? 'Cada chave vira uma variável de ambiente do servidor.' : 'Cada chave vira um cabeçalho HTTP.') + ' O valor vai cifrado para o cofre do Orbit e o arquivo recebe só ${ORBIT_MCP_…}. Sessões fora do Orbit (VS Code, terminal) não recebem a chave.'))),
      h('div', { class: 'mcp-f-linha' }, h('label', { for: 'mcp-f-onde' }, 'Salvar em'), h('span', { class: 'mcp-sel-w' }, (ondeSel.id = 'mcp-f-onde', ondeSel))),
      f.onde !== 'projeto' ? h('p', { class: 'mcp-dica mcp-dica-aviso' }, 'Vai para o seu ~/.claude.json, fora do projeto. O Orbit pede confirmação antes de gravar.') : null,
      f.erro ? h('p', { class: 'mcp-erro', role: 'alert' }, f.erro) : null,
      h('div', { class: 'mcp-f-b' },
        h('button', { type: 'button', class: 'btn p', 'data-k': 'f-cancelar', onclick: () => { st.form = null; render(); const a = st.el.querySelector('[data-k="adicionar"]'); if (a) a.focus(); } }, 'Cancelar'),
        h('button', { type: 'submit', class: 'btn p solido', 'data-k': 'f-ok', disabled: st.ocupado }, 'Adicionar')));
  }

  // ───────────────────────────── ações ─────────────────────────────
  // A resposta (a lista nova) entra antes do redesenho do finally.
  async function acao(fn) {
    if (st.ocupado) return null;
    st.ocupado = true;
    st.erro = '';
    render();
    try {
      const d = await fn();
      receberLista(d);
      return d;
    } catch (e) {
      st.erro = 'Não deu: ' + e.message;
      if (e.status === 404) await atualizar(true);
      return null;
    } finally {
      st.ocupado = false;
      render();
    }
  }
  function receberLista(d) {
    if (!d || !Array.isArray(d.servidores)) return;
    st.dados = d;
    if (d.pasta && d.pasta !== st.pasta) { st.pasta = d.pasta; gravarLocal(CHAVE_PASTA, d.pasta); }
  }

  async function adicionar(gatilho) {
    const f = st.form;
    if (!f || st.ocupado) return;
    f.erro = '';
    const chaves = f.chaves.filter((c) => c.chave.trim() || c.valor.trim()).map((c) => ({ chave: c.chave.trim(), valor: c.valor }));
    if (!f.nome.trim()) { f.erro = 'Dê um nome ao servidor.'; render(); return; }
    if (f.tipo === 'local' ? !f.comando.trim() : !f.url.trim()) { f.erro = f.tipo === 'local' ? 'Escreva o comando.' : 'Escreva a URL.'; render(); return; }
    let pessoal = false;
    if (f.onde !== 'projeto') {
      if (!(await confirmarPessoal(f.onde, 'Adicionar ' + f.nome.trim(), gatilho || st.el.querySelector('[data-k="f-ok"]')))) return;
      pessoal = true;
    }
    const corpo = { pasta: st.pasta, nome: f.nome.trim(), tipo: f.tipo, onde: f.onde, chaves, ...(f.tipo === 'local' ? { comando: f.comando } : { url: f.url.trim(), transporte: f.transporte }), ...(pessoal ? { confirmarPessoal: true } : {}) };
    st.ocupado = true;
    render();
    try {
      const d = await pedir('/mcp/adicionar', corpo);
      receberLista(d);
      st.form = null;
      st.toast('Servidor ' + corpo.nome + ' adicionado' + (f.onde === 'projeto' ? ' ao .mcp.json' : ' à configuração pessoal') + (chaves.length ? '; ' + (chaves.length === 1 ? 'a chave foi' : 'as chaves foram') + ' para o cofre' : '') + '. Vale para as sessões novas.');
      st.ocupado = false;
      verificar(false);
    } catch (e) {
      f.erro = e.message;
    } finally {
      st.ocupado = false;
      render();
      if (!st.form) { const a = st.el.querySelector('[data-k="adicionar"]'); if (a) a.focus(); }
    }
  }

  async function alternar(s, input) {
    const ligar = input.checked;
    input.checked = !ligar; // só muda de verdade quando o servidor confirmar
    let pessoal = false;
    if (s.onde !== 'projeto') {
      if (!(await confirmarPessoal(s.onde, (ligar ? 'Ativar ' : 'Desativar ') + s.nome, input))) return;
      pessoal = true;
    }
    const d = await acao(() => pedir('/mcp/ativo', { pasta: st.pasta, onde: s.onde, nome: s.nome, ativo: ligar, ...(pessoal ? { confirmarPessoal: true } : {}) }));
    if (!d) return;
    st.toast((ligar ? 'Ativado: ' : 'Desativado: ') + s.nome + ' neste projeto. Vale para as sessões novas.');
    verificar(false); // toda escrita invalida o status do projeto no servidor
  }

  async function remover(s, botao) {
    const pessoal = s.onde !== 'projeto';
    const ok = await confirmar({
      titulo: 'Remover ' + s.nome + '?',
      texto: (pessoal ? 'Sai do ' + ((st.dados && st.dados.claudeJson) || '~/.claude.json') + ', a configuração pessoal do Claude Code' + (s.onde === 'pessoal' ? ', e deixa de valer em todos os projetos.' : ' para este projeto.') : 'Sai do .mcp.json do projeto.')
        + (s.chaves && s.chaves.length ? ' As chaves dele saem do cofre do Orbit.' : ''),
      sim: 'Remover',
      perigo: true,
      gatilho: botao,
    });
    if (!ok) return;
    const d = await acao(() => pedir('/mcp/remover', { pasta: st.pasta, onde: s.onde, nome: s.nome, arquivo: s.arquivo, ...(pessoal ? { confirmarPessoal: true } : {}) }));
    if (!d) return;
    st.toast('Removido: ' + s.nome + '.');
    verificar(false);
    requestAnimationFrame(() => { const a = st.el.querySelector('.mcp-x:not([disabled])') || st.el.querySelector('[data-k="adicionar"]'); if (a) a.focus(); });
  }

  async function aprovar(s) {
    const d = await acao(() => pedir('/mcp/aprovar', { pasta: st.pasta, arquivo: s.arquivo, nome: s.nome, hash: s.hash }));
    if (!d) return;
    st.toast('Aprovado: ' + s.nome + '. As próximas instâncias do Orbit conectam este servidor.');
    verificar(false);
  }

  async function proteger(s, botao) {
    const ok = await confirmar({
      titulo: 'Levar as chaves de ' + s.nome + ' para o cofre?',
      texto: 'O valor sai do .mcp.json, vai cifrado para o cofre do Orbit e o arquivo fica com ${ORBIT_MCP_…}. Se o arquivo já foi para o git, a chave antiga continua no histórico: troque-a no serviço.',
      sim: 'Proteger',
      gatilho: botao,
    });
    if (!ok) return;
    const d = await acao(() => pedir('/mcp/proteger', { pasta: st.pasta, arquivo: s.arquivo, nome: s.nome }));
    if (!d) return;
    st.toast(d.protegidas === 1 ? 'A chave foi para o cofre.' : d.protegidas + ' chaves foram para o cofre.');
    verificar(false);
  }

  async function verificar(manual) {
    if (!st.pasta) return;
    if (st.verificando) { st.deNovo = true; return; }
    st.verificando = true;
    render();
    const pasta = st.pasta;
    try {
      const d = await pedir('/mcp/verificar', { pasta });
      if (st.pasta === pasta) receberLista(d);
      if (manual && d && d.sonda && !d.sonda.ok && d.sonda.erro) st.erro = 'A verificação falhou: ' + d.sonda.erro;
    } catch (e) {
      if (manual) st.erro = 'A verificação falhou: ' + e.message;
    } finally {
      st.verificando = false;
      render();
      if (st.deNovo) { st.deNovo = false; if (st.pasta !== pasta) verificar(false); }
    }
  }

  async function atualizar(semRender) {
    try {
      receberLista(await pedir('/mcp' + (st.pasta ? '?pasta=' + encodeURIComponent(st.pasta) : '')));
    } catch (e) {
      if (e.codigo === 'pasta_desconhecida' && st.pasta) { st.pasta = ''; gravarLocal(CHAVE_PASTA, ''); return atualizar(semRender); }
      st.erro = e.status === 404 ? 'Este servidor ainda não tem as Conexões MCP (reinicie o Orbit).' : 'Não deu para ler as conexões: ' + e.message;
    }
    if (!semRender) render();
    // Status na abertura: uma verificação por projeto em cada abertura das Configurações.
    const d = st.dados;
    if (d && d.pasta && !d.sonda.ok && !d.sonda.rodando && !st.auto.has(d.pasta) && d.servidores.length) {
      st.auto.add(d.pasta);
      verificar(false);
    }
  }

  window.Mcp = Object.freeze({
    montar(o) {
      st.el = o.el;
      if (typeof o.toast === 'function') st.toast = o.toast;
      if (typeof o.icone === 'function') st.icone = o.icone;
      if (typeof o.balao === 'function') st.balao = o.balao;
      render();
    },
    atualizar: () => { st.erro = ''; st.auto.clear(); return atualizar(); },
    receber(d) {
      if (st.ocupado || st.verificando || st.form) return;
      if (d && d.pasta && st.pasta && d.pasta.toLowerCase() !== st.pasta.toLowerCase()) return;
      atualizar();
    },
  });
})();
