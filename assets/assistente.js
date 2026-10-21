/* Assistente da primeira vez (servidor: assistente.mjs). Uma tela só: nome, pasta de projetos, conta do Claude,
 * GitHub (opcional), integração com o Claude Code (hooks, abrir sozinho, aviso aos subagentes e a skill
 * liderar-time, cada um com permissão explícita) e celular (opcional).
 *
 * Abre sozinho enquanto o GET /assistente disser `feito: false`. "Pular por agora" marca como feito sem mudar
 * nada; Configurações → Servidor → "Refazer" abre de novo (window.OrbitAssistente.abrir()).
 * O login do Claude e o GitHub usam as rotas de sempre (/conta/claude/entrar e /perfil/github), como o menu de
 * perfil. O token do GitHub só passa por aqui uma vez, do campo para o POST, e o campo é limpo logo depois.
 * Texto vindo do servidor entra só por textContent.
 */
(function () {
  'use strict';

  const URL_NOVO_TOKEN = 'https://github.com/settings/personal-access-tokens/new?name=Orbit&description=' +
    encodeURIComponent('Orbit: repositórios dos meus projetos');
  const MS_CLAUDE = 2000;

  const st = { aberto: false, est: null, claude: null, github: null, enviando: false, ghEnviando: false, ghErro: '', resultado: null };
  const ui = {};
  let claudeT = 0;

  function h(tag, props, ...filhos) {
    const e = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (v === true) e.setAttribute(k, '');
        else e.setAttribute(k, v);
      }
    }
    for (const f of filhos.flat()) if (f != null && f !== false) e.append(f);
    return e;
  }

  async function pedir(metodo, rota, corpo) {
    const op = { method: metodo, cache: 'no-store', headers: { 'x-gerenciador': '1' } };
    if (corpo !== undefined) { op.headers['content-type'] = 'application/json'; op.body = JSON.stringify(corpo); }
    const r = await fetch(rota, op);
    let j = null;
    try { j = await r.json(); } catch {}
    if (!r.ok) throw new Error((j && j.erro) || 'HTTP ' + r.status);
    return j;
  }

  // ───────────────────────────── montagem ─────────────────────────────
  function opcao(id, titulo, texto, extra, selo) {
    const caixa = h('input', { type: 'checkbox', id, class: 'as-caixa' });
    const tit = h('b', null, h('span', { text: titulo }), selo ? h('span', { class: 'as-selo', text: selo }) : null);
    const linha = h('label', { class: 'as-opcao', for: id }, caixa, h('span', { class: 'as-opcao-txt' }, tit, h('small', { text: texto }), extra || null));
    return { caixa, linha };
  }

  function montar() {
    if (ui.camada) return;
    ui.nome = h('input', { type: 'text', id: 'as-nome', class: 'as-campo', maxlength: '60', autocomplete: 'off' });
    ui.pasta = h('input', { type: 'text', id: 'as-pasta', class: 'as-campo', maxlength: '500', spellcheck: 'false', autocomplete: 'off' });

    ui.claudeTxt = h('span', { class: 'as-status', role: 'status', 'aria-live': 'polite' });
    ui.claudeBtn = h('button', { type: 'button', class: 'btn p', id: 'as-claude-entrar', onclick: entrarClaude }, 'Entrar');
    ui.claudeCancelar = h('button', { type: 'button', class: 'btn p', hidden: true, onclick: cancelarClaude }, 'Cancelar');

    ui.ghTxt = h('span', { class: 'as-status', role: 'status', 'aria-live': 'polite' });
    ui.ghToken = h('input', { type: 'password', id: 'as-gh-token', class: 'as-campo', placeholder: 'github_pat_…', autocomplete: 'off', spellcheck: 'false' });
    ui.ghBtn = h('button', { type: 'button', class: 'btn p', id: 'as-gh-conectar', onclick: conectarGithub }, 'Conectar');
    ui.ghForm = h('div', { class: 'as-linha-ctl' }, ui.ghToken, ui.ghBtn,
      h('a', { href: URL_NOVO_TOKEN, target: '_blank', rel: 'noopener noreferrer', class: 'as-link' }, 'Criar um token'));

    ui.hooksAlerta = h('span', { class: 'as-alerta', id: 'as-hooks-alerta', role: 'note',
      text: 'Sem eles, as suas sessões do Claude Code (terminal e VS Code) não aparecem no Orbit. Só aparecem as que você abrir pelo próprio Orbit.' });
    const hooks = opcao('as-hooks', 'Monitorar as sessões do Claude Code',
      'Grava hooks no seu ~/.claude/settings.json (a configuração do Claude Code) para o Orbit receber os eventos de todas as sessões: terminal, VS Code e as do próprio Orbit. Rodam em segundo plano e não atrasam nada. Desmarcar aqui tira tudo o que é do Orbit.',
      ui.hooksAlerta, 'Recomendado');
    const subir = opcao('as-subir', 'Abrir o Orbit sozinho',
      'Quando uma sessão mandar um evento e o Orbit estiver fechado, o hook abre o servidor em segundo plano. Sem isso, o Orbit só recebe os eventos enquanto estiver aberto.');
    const aviso = opcao('as-aviso', 'Avisar os subagentes acima do limite de contexto',
      'Um hook a mais, que roda a cada ferramenta de todas as sessões (cerca de 50 ms cada vez). Quando um subagente passa do limite da compactação automática (140 mil tokens, ajustável nas Configurações), ele é avisado para salvar o progresso num arquivo e pedir para ser trocado, e o agente principal recebe a explicação de como trocá-lo por um novo. O progresso fica na pasta de dados do Orbit, nunca nos seus projetos, e é apagado no fim.');
    const liderar = opcao('as-liderar', 'Instalar a skill liderar-time',
      'Uma skill pessoal em ~/.claude/skills/liderar-time que ensina o Claude a dividir o trabalho entre subagentes: uma entrega por subagente, o modelo certo para cada tarefa, teto de contexto, progresso em arquivo e respostas curtas. Vale em todos os seus projetos. Se você já tiver uma skill com esse nome, ela fica como está.');
    const celular = opcao('as-celular', 'Usar o Orbit no celular',
      'Liga o acesso pelo celular pela sua rede do Tailscale (gratuito, precisa estar no PC e no celular). Depois de concluir, termine em Configurações → Acesso pelo celular.');
    ui.hooks = hooks.caixa; ui.subir = subir.caixa; ui.aviso = aviso.caixa; ui.liderar = liderar.caixa; ui.celular = celular.caixa;
    ui.hooks.addEventListener('change', sincronizarDependentes);
    ui.subOpcoes = h('div', { class: 'as-sub' }, subir.linha, aviso.linha);

    ui.resultado = h('div', { class: 'as-resultado', role: 'status', 'aria-live': 'polite', hidden: true });
    ui.concluir = h('button', { type: 'button', class: 'btn solido', id: 'as-concluir', onclick: concluir }, 'Concluir');
    ui.pular = h('button', { type: 'button', class: 'btn', id: 'as-pular', onclick: pular }, 'Pular por agora');
    ui.fechar = h('button', { type: 'button', class: 'btn', id: 'as-fechar', hidden: true, onclick: fechar }, 'Fechar');

    const secao = (titulo, ...filhos) => h('section', { class: 'as-sec' }, h('h3', { text: titulo }), ...filhos);
    ui.modal = h('div', { class: 'modal as-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'as-titulo' },
      h('div', { class: 'modal-cab' },
        h('div', null, h('h2', { id: 'as-titulo', text: 'Bem-vindo ao Orbit' }), h('p', { text: 'Configure uma vez. Tudo dá para mudar depois nas Configurações.' }))),
      h('div', { class: 'modal-corpo' },
        secao('Você',
          h('label', { class: 'as-rot', for: 'as-nome' }, 'Seu nome'), ui.nome,
          h('label', { class: 'as-rot', for: 'as-pasta' }, 'Pasta dos seus projetos'), ui.pasta,
          h('small', { class: 'as-dica', text: 'Caminho completo. É onde o Orbit procura seus projetos e para onde vão os clones do GitHub.' })),
        secao('Conta do Claude',
          h('div', { class: 'as-linha-ctl' }, ui.claudeTxt, h('span', { class: 'as-espaco' }), ui.claudeCancelar, ui.claudeBtn),
          h('small', { class: 'as-dica', text: 'O login abre no navegador e vale para o Claude Code inteiro neste usuário do Windows (terminal, VS Code e Orbit).' })),
        secao('GitHub (opcional)', ui.ghTxt, ui.ghForm,
          h('small', { class: 'as-dica', text: 'Para clonar e sincronizar os seus repositórios. O token fica cifrado neste usuário do Windows, fora da pasta do Orbit.' })),
        secao('Integração com o Claude Code', hooks.linha, ui.subOpcoes, liderar.linha),
        secao('Celular (opcional)', celular.linha),
        ui.resultado),
      h('div', { class: 'as-rodape' }, ui.pular, h('span', { class: 'as-espaco' }), ui.fechar, ui.concluir));
    ui.camada = h('div', { id: 'camada-assistente', class: 'camada as-camada', hidden: true }, ui.modal);
    document.body.append(ui.camada);
  }

  function sincronizarDependentes() {
    const on = ui.hooks.checked;
    for (const c of [ui.subir, ui.aviso]) {
      c.disabled = !on;
      if (!on) c.checked = false;
    }
    ui.subOpcoes.classList.toggle('desligado', !on);
    ui.hooksAlerta.hidden = on;
  }

  // ───────────────────────────── estado ─────────────────────────────
  function preencher() {
    const e = st.est;
    if (!e) return;
    ui.nome.value = e.nome || '';
    ui.nome.placeholder = e.nomeSistema || 'Seu nome';
    ui.pasta.value = e.pastaProjetos || '';
    const i = e.instalacao || {};
    ui.hooks.checked = !!i.hooks;
    ui.subir.checked = !!i.subir;
    ui.aviso.checked = !!i.aviso;
    ui.liderar.checked = i.liderar === 'orbit';
    ui.celular.checked = !!e.celular;
    sincronizarDependentes();
  }

  function desenharClaude() {
    const c = st.claude;
    ui.claudeCancelar.hidden = true;
    ui.claudeBtn.hidden = false;
    ui.claudeBtn.disabled = false;
    if (!c) { ui.claudeTxt.textContent = 'Conferindo…'; ui.claudeBtn.hidden = true; return; }
    if (c.entrando) {
      ui.claudeTxt.textContent = 'Termine o login na janela do navegador que abriu.';
      ui.claudeBtn.hidden = true;
      ui.claudeCancelar.hidden = false;
      return;
    }
    if (c.logado) {
      ui.claudeTxt.textContent = 'Conectado' + (c.email ? ' como ' + c.email : '') + (c.plano ? ' (' + c.plano + ')' : '') + '.';
      ui.claudeBtn.hidden = true;
      return;
    }
    if (c.logado === null) {
      ui.claudeTxt.textContent = c.falha || 'Não achei o Claude Code neste PC. Instale-o e volte aqui.';
      ui.claudeBtn.hidden = true;
    } else ui.claudeTxt.textContent = c.falha || 'Não conectado.';
  }

  function desenharGithub() {
    const g = st.github;
    ui.ghForm.hidden = !!(g && !g.expirado);
    ui.ghBtn.disabled = st.ghEnviando;
    if (st.ghErro) ui.ghTxt.textContent = st.ghErro;
    else if (g && g.expirado) ui.ghTxt.textContent = 'O token de @' + g.login + ' expirou. Cole um novo.';
    else if (g) ui.ghTxt.textContent = 'Conectado como @' + g.login + '.';
    else ui.ghTxt.textContent = 'Não conectado.';
  }

  async function lerClaude() {
    clearTimeout(claudeT);
    try { st.claude = await pedir('GET', '/conta/claude'); } catch { st.claude = { logado: null }; }
    if (!st.aberto) return;
    desenharClaude();
    if (st.claude && st.claude.entrando) claudeT = setTimeout(lerClaude, MS_CLAUDE);
  }
  async function lerGithub() {
    try { st.github = (await pedir('GET', '/perfil')).github || null; } catch { st.github = null; }
    if (st.aberto) desenharGithub();
  }

  async function entrarClaude() {
    ui.claudeBtn.disabled = true;
    try { st.claude = await pedir('POST', '/conta/claude/entrar', {}); }
    catch (e) { st.claude = { ...(st.claude || {}), falha: e.message }; }
    desenharClaude();
    claudeT = setTimeout(lerClaude, MS_CLAUDE);
  }
  async function cancelarClaude() {
    try { st.claude = await pedir('POST', '/conta/claude/entrar/cancelar', {}); } catch {}
    desenharClaude();
  }

  async function conectarGithub() {
    const token = ui.ghToken.value.trim();
    ui.ghToken.value = '';
    if (!token) { st.ghErro = 'Cole o token do GitHub no campo.'; desenharGithub(); return; }
    st.ghEnviando = true; st.ghErro = '';
    desenharGithub();
    try { st.github = (await pedir('POST', '/perfil/github', { token })).github || null; }
    catch (e) { st.ghErro = e.message; }
    st.ghEnviando = false;
    desenharGithub();
  }

  // ───────────────────────────── ações ─────────────────────────────
  async function concluir() {
    if (st.enviando) return;
    st.enviando = true;
    ui.concluir.disabled = true;
    ui.concluir.textContent = 'Aplicando…';
    const corpo = {
      nome: ui.nome.value,
      pastaProjetos: ui.pasta.value,
      hooks: ui.hooks.checked,
      subir: ui.subir.checked,
      aviso: ui.aviso.checked,
      liderar: ui.liderar.checked,
      celular: ui.celular.checked,
    };
    let r = null;
    try { r = await pedir('POST', '/assistente/concluir', corpo); }
    catch (e) { r = { passos: [{ passo: 'erro', ok: false, texto: e.message }] }; }
    st.enviando = false;
    ui.concluir.disabled = false;
    ui.concluir.textContent = 'Concluir';
    if (r.estado) st.est = r.estado;
    mostrarResultado(r.passos || []);
    if (r.estado && r.estado.feito) {
      ui.concluir.hidden = true;
      ui.pular.hidden = true;
      ui.fechar.hidden = false;
      ui.fechar.focus();
    }
  }

  const NOMES = { nome: 'Nome', pasta: 'Pasta de projetos', instalar: 'Integração', skill: 'Skill liderar-time', celular: 'Celular', erro: 'Erro' };
  function mostrarResultado(passos) {
    ui.resultado.replaceChildren();
    const falhas = passos.filter((p) => !p.ok);
    ui.resultado.append(h('p', { class: 'as-res-tit ' + (falhas.length ? 'ruim' : 'bom'), text: falhas.length ? 'Algumas escolhas não foram aplicadas. Corrija e conclua de novo.' : 'Pronto. Tudo aplicado.' }));
    for (const p of passos) {
      ui.resultado.append(h('div', { class: 'as-res ' + (p.ok ? 'bom' : 'ruim') }, h('b', { text: (NOMES[p.passo] || p.passo) + ': ' }), h('span', { text: p.texto || (p.ok ? 'ok' : 'falhou') })));
    }
    ui.resultado.hidden = false;
    ui.resultado.scrollIntoView({ block: 'nearest' });
  }

  async function pular() {
    try { await pedir('POST', '/assistente/pular', {}); } catch {}
    fechar();
  }

  function fechar() {
    st.aberto = false;
    clearTimeout(claudeT);
    if (ui.camada) ui.camada.hidden = true;
  }

  // `fresco`: relê o estado (Refazer, pelas Configurações); "Pular por agora" ali não muda nada.
  async function abrir(fresco) {
    montar();
    if (!st.est || fresco) { try { st.est = await pedir('GET', '/assistente'); } catch { return; } }
    st.aberto = true;
    st.resultado = null;
    ui.resultado.hidden = true;
    ui.concluir.hidden = false;
    ui.pular.hidden = false;
    ui.fechar.hidden = true;
    preencher();
    st.claude = null;
    desenharClaude();
    desenharGithub();
    ui.camada.hidden = false;
    lerClaude();
    lerGithub();
    setTimeout(() => ui.nome.focus(), 0);
  }

  window.OrbitAssistente = Object.freeze({ abrir: () => abrir(true) });

  // Configurações → Servidor → Refazer.
  const refazer = document.getElementById('cfg-assistente');
  if (refazer) refazer.addEventListener('click', () => abrir(true));

  // Primeira vez: abre sozinho.
  pedir('GET', '/assistente').then((e) => { st.est = e; if (e && !e.feito) abrir(false); }).catch(() => {});
})();
