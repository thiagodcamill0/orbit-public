/* Conversa — aba "Conversa" do painel de detalhe (rodada 5).
 *
 * Integração (index.html carrega sob demanda, como a Visão de Office):
 *   window.Conversa.montar(el, api)          monta dentro de `el` (a <section id="pk-conversa">)
 *   window.Conversa.abrir(id)                mostra a conversa da sessão (idempotente)
 *   window.Conversa.parar()                  fecha o fluxo (aba Resumo, painel fechado)
 *   window.Conversa.executar(id, tipo, op)   'compactar' {foco} | 'limpar' pelo Orbit (botões do Resumo)
 *   window.Conversa.criar(el, api)           rodada 9: instância independente (aba de conversa) →
 *     { abrir(id), parar(), executar(id, tipo, op), focar(), destruir(), _debug() }. Os ids dos elementos levam
 *     sufixo (cv-pop-2, cv-cmd-2-0…); os de cima são a instância principal (painel de detalhe), ids sem sufixo.
 *     Com a classe `cv-em-aba` no `el` (altura definida), a conversa ocupa o painel todo, em coluna centrada.
 *
 * `api`: sessao(id), on(tipo, fn) com 'sessao' | 'acao' | 'remover' | 'conexao', selecionar(id),
 * confirmar(texto, sim) → Promise<boolean>, toast(texto), md(texto) → nós, icone(nome, tam),
 * ponto(status, tam), nome(id), visivel(), abrirVSCode(id), selecionada().
 * Rodada 6 (etapa 2), opcionais: modelos(forcar) → Promise<{modelos, atualizado}>, nomeModelo(id).
 * Com eles, a instância `orbit` ganha os seletores de modelo e esforço no pé do compositor.
 * Rodada 6 (etapa 3), modo `orbit`: botão Parar (e Esc no compositor) com a Acao 'parar', seletor do modo de
 * permissão (POST /modo), cartões por `controle.permissao.tipo` (ferramenta | pergunta | plano) com
 * `controle.pendentes`, chip de `controle.tarefas` e o texto ao vivo pelo `event: parcial` do SSE da conversa.
 *
 * Segurança: todo texto vindo do servidor (transcript) entra só por textContent; o markdown do
 * assistente passa pelo mdRender da página, que cria apenas nós DOM.
 */
(function () {
  'use strict';

  // Fábrica: cada chamada é uma Conversa independente (estado, nós, fluxo, temporizadores e ouvintes próprios).
  // SUF = '' na principal (painel de detalhe, ids de sempre) e '-2', '-3'… nas criadas por Conversa.criar.
  function nova(SUF) {
    const LIMITE = 150;     // itens por página do GET
    const MAX_NOS = 360;    // acima disso, com o usuário no fim, os mais antigos saem do DOM
    const MANTER = 220;     // quantos ficam depois da poda
    const PERTO = 56;       // px do fim que ainda contam como "no fim"
    const LONGA = 1400;     // caracteres a partir dos quais a bolha do usuário recolhe

    let api = null;
    let raiz = null;
    const ui = {};
    const st = {
      id: null, gen: 0, itens: [], porId: new Map(), nos: new Map(), ini: 0, cursor: null,
      carregando: false, erroCarga: '', es: null, esTimer: 0, reiniciado: '',
      novas: 0, abertos: new Set(), controle: null, sigControle: '', acoes: new Map(), minhas: new Map(),
      estadoTimer: 0, rascunhos: new Map(), anexosRasc: new Map(), permResp: '', seqLocal: 0, ultimoCorpo: new Map(),
      // Rodada 6: modelo e esforço (modo orbit). efetivo: id → { modelo, esforco, sig } devolvido pelo servidor.
      modelos: null, modelosCarga: false, modelosErro: '', modelosDepois: 0, efetivo: new Map(), ajPend: '', ajSig: '', ajTimer: 0,
      // Etapa 3: modo de permissão efetivo (id → { modo, sig }), texto parcial ao vivo e tarefas em segundo plano.
      ultimoErro: {}, faixaRetomada: '', ajPendentes: new Map(), modoEf: new Map(), modoPend: false, modoSig: '', parcPend: new Set(), parcRaf: 0, parcTimer: 0, ocupAntes: false, tarSig: '',
      // Comandos com barra: lista do servidor por sessão (null = o servidor não tem a rota) e o menu.
      cmds: new Map(), cmdsCarga: new Set(), menu: { itens: [], ativo: -1, dispensado: null }, enviando: 0,
      // Menu flutuante dos seletores: '' | 'modo' | 'modelo'; maisVersoes = a seção "Outras versões" aberta.
      pop: '', popSig: '', maisVersoes: false,
    };
    const PARCIAL_ORFAO_MS = 6000; // depois que a volta termina, o parcial sem item final vira "incompleto"
    // Ids por instância: idDe('cv-pop') → 'cv-pop' na principal, 'cv-pop-2' nas outras; PRE vai no meio dos
    // ids com parte variável ('cv-cmd-' + PRE + i → 'cv-cmd-0' / 'cv-cmd-2-0').
    const idDe = (base) => base + SUF;
    const PRE = SUF ? SUF.slice(1) + '-' : '';
    // Ouvintes de document/window e assinaturas api.on: tudo o que destruir() desfaz.
    let limpezas = [];
    let vivo = true;
    function ouvir(alvo, tipo, fn, op) { alvo.addEventListener(tipo, fn, op); limpezas.push(() => alvo.removeEventListener(tipo, fn, op)); }
    function assinar(tipo, fn) { const c = api.on(tipo, fn); if (typeof c === 'function') limpezas.push(c); }

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
    const ponto = (s, t = 12) => { try { return api.ponto(s, t); } catch { return document.createTextNode(''); } };
    const enc = encodeURIComponent;
    function fmtK(n) {
      n = Number(n) || 0;
      if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',').replace(',0', '') + 'M';
      if (n >= 1000) return Math.round(n / 1000) + 'k';
      return String(n);
    }
    function hora(ts) {
      const d = new Date(Number(ts) || 0);
      if (!ts || isNaN(d)) return '';
      const hoje = new Date();
      const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      return d.toDateString() === hoje.toDateString() ? hm : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + hm;
    }
    const reduzido = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
    // Seta para cima do Enviar (o conjunto de ícones da página não tem).
    function svgSeta() {
      const ns = 'http://www.w3.org/2000/svg';
      const v = document.createElementNS(ns, 'svg');
      for (const [k, x] of Object.entries({ viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) v.setAttribute(k, x);
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', 'M8 13V3.5M3.8 7.6 8 3.4l4.2 4.2');
      v.append(p);
      return v;
    }
    // Botão de um seletor do compositor (ícone + rótulo + seta); a lista abre no menu flutuante (.cv-pop).
    function gatilho(classe, icone, rotulo) {
      const b = h('button', { type: 'button', class: 'cv-sel ' + classe, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': idDe('cv-pop'), 'aria-label': rotulo },
        h('span', { class: 'cv-sel-ico', 'aria-hidden': 'true' }, ico(icone, 13)), h('span', { class: 'cv-sel-rot' }));
      b._ico = b.firstChild;
      b._rot = b.lastChild;
      return b;
    }
    // Marca de seleção dos itens do menu.
    function svgCheck() {
      const ns = 'http://www.w3.org/2000/svg';
      const v = document.createElementNS(ns, 'svg');
      for (const [k, x] of Object.entries({ viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) v.setAttribute(k, x);
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', 'M3.5 8.5l3 3 6-7');
      v.append(p);
      return v;
    }

    async function pedir(caminho, corpo) {
      let r;
      try {
        r = await fetch(caminho, corpo === undefined
          ? { cache: 'no-store' }
          : { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
      } catch {
        const e = new Error('Sem resposta do servidor. Confira se o Orbit está rodando e tente de novo.');
        e.rede = true;
        throw e;
      }
      let d = null;
      try { d = await r.json(); } catch {}
      if (!r.ok) {
        const e = new Error((d && typeof d.erro === 'string' && d.erro) || (r.status === 404 ? 'Rota não encontrada neste servidor.' : 'O servidor respondeu ' + r.status + '.'));
        e.status = r.status;
        e.codigo = d && d.codigo;
        throw e;
      }
      return d || {};
    }
    const rotaSessao = (id, resto) => '/sessao/' + enc(id) + '/' + resto;

    // ───────────────────────────── regras dos modos ─────────────────────────────
    const ROTULO_ACAO = {
      mensagem: ['Enviando mensagem', 'Mensagem entregue', 'Mensagem não entregue'],
      compactar: ['Compactando', 'Contexto compactado', 'Não deu para compactar'],
      limpar: ['Limpando a conversa', 'Conversa limpa', 'Não deu para limpar'],
      assumir: ['Assumindo no Orbit', 'Sessão assumida pelo Orbit', 'Não deu para assumir'],
      devolver: ['Devolvendo a sessão', 'Sessão devolvida', 'Não deu para devolver'],
      criar: ['Iniciando a instância', 'Instância pronta', 'Não deu para iniciar a instância'], // rodada 6
      parar: ['Parando a volta', 'Volta interrompida', 'Não deu para parar'], // rodada 6, etapa 3
      encerrar: ['Encerrando a instância', 'Instância encerrada', 'Não deu para encerrar'], // etapa 4
      retomar: ['Retomando a instância', 'Instância retomada', 'Não deu para retomar'], // etapa 4
      compactarAuto: ['Compactando automaticamente', 'Contexto compactado automaticamente', 'A compactação automática falhou'], // 20/10 (via 'auto')
    };
    const rotuloAcao = (a) => ROTULO_ACAO[a.tipo === 'compactar' && a.via === 'auto' ? 'compactarAuto' : a.tipo];
    // Modos de permissão oferecidos (bypassPermissions não é oferecido; se vier, aparece só como valor atual).
    const MODOS = [
      ['default', 'Padrão', 'Pede sua permissão antes de editar arquivos e rodar comandos'],
      ['acceptEdits', 'Aceitar edições', 'Edita arquivos sem pedir; comandos ainda pedem permissão'],
      ['plan', 'Planejar', 'Só planeja: não edita nem roda nada até você aprovar o plano'],
      ['auto', 'Auto', 'Age sem pedir; um verificador barra as ações arriscadas'],
    ];
    const MODO_OUTRO = { bypassPermissions: 'Sem permissões', dontAsk: 'Não perguntar' };
    const ICONE_MODO = { default: 'cadeado', acceptEdits: 'lapis', plan: 'lista', bypassPermissions: 'raio', dontAsk: 'raio', auto: 'raio' };
    const rotuloModo = (m) => { const x = MODOS.find((y) => y[0] === m); return x ? x[1] : MODO_OUTRO[m] || m || 'Padrão'; };
    const TIPO_TAREFA = { local_bash: 'Comando', bash: 'Comando', shell: 'Comando', local_agent: 'Agente', agent: 'Agente', remote_agent: 'Agente remoto', monitor: 'Monitor' };
    function modoAtual() {
      const c = st.controle;
      return c && (c.modo === 'orbit' || c.modo === 'canal') ? c.modo : 'nenhum';
    }
    function emAndamento() {
      for (const a of st.acoes.values()) if (a.sessao === st.id && a.tipo !== 'mensagem' && a.estado === 'em_andamento') return a;
      return null;
    }
    // null = liberado; texto = por que está desabilitado.
    function regras() {
      const c = st.controle;
      const modo = modoAtual();
      const r = { modo, envio: null, compactar: null, limpar: null, assumir: null };
      if (!c) {
        const m = 'Este servidor ainda não tem o controle das sessões.';
        return { modo, envio: m, compactar: m, limpar: m, assumir: m, semControle: true };
      }
      if (modo === 'nenhum') r.envio = 'Sem processo vivo. Assuma no Orbit para conversar daqui.';
      if (modo !== 'orbit') r.compactar = r.limpar = 'Assuma no Orbit para compactar e limpar sem abrir o VS Code.';
      // No orbit o `motivo` vem preenchido ("Já está no Orbit" / "Iniciando no Orbit"); ocupada = iniciando,
      // volta em andamento ou permissão pendente.
      const iniciando = modo === 'orbit' && (c.processo === 'iniciando' || /inician/i.test(c.motivo || ''));
      const tipoPerm = c.permissao ? tipoPermissao(c.permissao) : '';
      const ocupada = tipoPerm === 'pergunta' ? 'Responda a pergunta do agente primeiro.'
        : tipoPerm === 'plano' ? 'Responda ao plano primeiro: aprovar ou continuar planejando.'
        : c.permissao ? 'Responda o pedido de permissão primeiro.'
        : iniciando ? c.motivo + '…'
        : 'A sessão está trabalhando; espere a volta terminar.';
      if (modo === 'orbit' && c.ocupada) r.compactar = r.limpar = r.assumir = ocupada;
      if (iniciando) r.envio = (c.processo === 'iniciando' && !/inician/i.test(c.motivo || '') ? 'Iniciando no Orbit' : c.motivo) + '…';
      if (modo !== 'orbit') r.assumir = c.podeAssumir ? null : (c.motivo || 'Não dá para assumir esta sessão agora.');
      const andando = emAndamento();
      if (andando) {
        const m = 'Espere terminar: ' + rotuloAcao(andando)[0].replace(/^./, (c) => c.toLowerCase()) + '.';
        r.compactar = r.limpar = r.assumir = m;
        if (andando.tipo === 'assumir' || andando.tipo === 'devolver' || andando.tipo === 'criar') r.envio = m;
      }
      // Etapa 3: Parar aparece enquanto há volta (ou pedido) em andamento numa instância do Orbit.
      r.pararVisivel = modo === 'orbit' && !!c.ocupada && !iniciando;
      r.parar = andando && andando.tipo === 'parar' ? 'Já estou parando a volta.' : null;
      // Etapa 4: dormindo (o processo fechou; a sessão continua do Orbit). Enviar, compactar e limpar acordam.
      r.dormindo = modo === 'orbit' && c.processo === 'dormindo';
      r.retomarVisivel = r.dormindo || (!!andando && andando.tipo === 'retomar');
      r.retomar = andando ? (andando.tipo === 'retomar' ? 'Já estou retomando a instância.' : 'Espere terminar: ' + rotuloAcao(andando)[0].replace(/^./, (x) => x.toLowerCase()) + '.') : null;
      r.encerrarVisivel = modo === 'orbit' && !r.dormindo && !iniciando && !(andando && andando.tipo === 'retomar');
      r.encerrar = andando && andando.tipo !== 'parar' ? 'Espere terminar: ' + rotuloAcao(andando)[0].replace(/^./, (x) => x.toLowerCase()) + '.' : null;
      if (andando && (andando.tipo === 'encerrar' || andando.tipo === 'retomar')) r.envio = r.envio || (andando.tipo === 'encerrar' ? 'Espere a instância encerrar; depois é só escrever para retomar.' : null);
      return r;
    }
    function origemOrbit() { try { const s = api.sessao(st.id); return !!s && s.origem === 'orbit'; } catch { return false; } }
    // Texto do porquê dormiu (o mesmo do chip da lista).
    const MOTIVO_DORMIU = { ocioso: 'Fechada por ociosidade', manual: 'Fechada por você', limite: 'Fechada para abrir espaço', reinicio: 'Pausada: o PC reiniciou', saiu: 'O processo terminou' };
    function textoDormiu(c) {
      const d = (c && c.dormiu) || {};
      const em = typeof d.em === 'number' ? d.em : Date.parse(d.em || '');
      let t = MOTIVO_DORMIU[d.motivo] || 'Dormindo';
      if (d.motivo === 'ocioso' && em) { const m = Math.max(0, Math.round((Date.now() - em) / 60000)); t += m < 1 ? ' agora há pouco' : m < 60 ? ' há ' + m + ' min' : ' há ' + Math.floor(m / 60) + ' h'; }
      return t;
    }

    // ───────────────────────────── montagem ─────────────────────────────
    function botao(classe, icone, rotulo, onclick, extra) {
      const rot = h('span', { class: 'cv-rot' }, rotulo);
      const b = h('button', { type: 'button', class: 'btn p ' + classe, ...extra }, ico(icone, 14), rot);
      b._rot = rot;
      b._ico = b.firstChild;
      b.addEventListener('click', (e) => {
        if (b.getAttribute('aria-disabled') === 'true') { e.preventDefault(); mostrarMotivo(b._motivo); return; }
        onclick(e);
      });
      return b;
    }
    function montar(el, a) {
      if (raiz) desmontar(); // montar de novo (a página recarregou o painel): sem ouvintes em dobro
      vivo = true;
      api = a;
      raiz = el;
      raiz.classList.add('cv');
      raiz.replaceChildren();

      ui.compactar = botao('cv-b-compactar', 'comprimir', 'Compactar', () => abrirFoco(), typeof api.balao === 'function' ? { 'aria-haspopup': 'dialog' } : undefined);
      ui.limpar = botao('cv-b-limpar', 'borracha', 'Limpar', () => limpar());
      ui.assumir = botao('cv-b-assumir', 'raio', 'Assumir no Orbit', () => (modoAtual() === 'orbit' ? acionar('devolver', {}) : acionar('assumir', {})));
      ui.motivo = h('p', { class: 'cv-motivo', id: idDe('cv-motivo'), 'aria-live': 'polite' });
      ui.focoTxt = h('input', { class: 'ctx-foco cv-foco-txt', type: 'text', maxlength: 500, placeholder: 'Foco da compactação (opcional)', 'aria-label': 'Foco da compactação (opcional)', spellcheck: 'false', autocomplete: 'off' });
      ui.focoOk = h('button', { type: 'button', class: 'btn p cv-primario' }, ico('comprimir', 14), 'Compactar agora');
      ui.focoNao = h('button', { type: 'button', class: 'btn p contorno' }, 'Cancelar');
      ui.foco = h('div', { class: 'cv-foco', hidden: true }, ui.focoTxt, h('div', { class: 'cv-foco-b' }, ui.focoNao, ui.focoOk));
      ui.estado = h('div', { class: 'cv-estado', role: 'status', 'aria-live': 'polite', hidden: true });
      ui.topo = h('div', { class: 'cv-topo' },
        h('div', { class: 'cv-acoes', role: 'toolbar', 'aria-label': 'Ações da conversa' }, ui.compactar, ui.limpar, h('span', { class: 'cv-esp' }),
          // Etapa 4: Retomar (dormindo) e Encerrar (viva).
          ui.retomar = botao('cv-b-retomar', 'play', 'Retomar', () => retomar(), { hidden: true }),
          ui.encerrar = botao('cv-b-encerrar', 'lua', 'Encerrar', () => encerrar(), { hidden: true }),
          ui.assumir),
        ui.motivo, ui.foco);

      ui.anteriores = h('button', { type: 'button', class: 'link cv-anteriores', hidden: true }, 'Carregar anteriores');
      ui.inicio = h('p', { class: 'cv-inicio', hidden: true }, 'Início da conversa');
      ui.itens = h('div', { class: 'cv-itens' });
      ui.vazio = h('div', { class: 'cv-vazio', hidden: true });
      ui.lista = h('div', { class: 'cv-lista', tabindex: '0', role: 'region', 'aria-label': 'Mensagens da conversa' }, ui.anteriores, ui.inicio, ui.itens, ui.vazio);
      ui.novas = h('button', { type: 'button', class: 'cv-novas', hidden: true }, 'Novas mensagens ↓');
      ui.corpo = h('div', { class: 'cv-corpo' }, ui.lista, ui.novas);

      ui.perm = h('div', { class: 'cv-perm', role: 'group', 'aria-labelledby': idDe('cv-perm-t'), hidden: true });

      ui.texto = h('textarea', { class: 'cv-texto', rows: 1, maxlength: 20000, 'aria-label': 'Mensagem para a sessão', spellcheck: 'true',
        role: 'combobox', 'aria-autocomplete': 'list', 'aria-controls': idDe('cv-cmds'), 'aria-expanded': 'false', 'aria-haspopup': 'listbox' });
      ui.enviar = h('button', { type: 'button', class: 'cv-enviar', 'aria-label': 'Enviar mensagem', 'aria-keyshortcuts': 'Enter' }, svgSeta(), h('span', { class: 'cv-gira', 'aria-hidden': 'true' }));
      // Rodada 6: modo, modelo e esforço da instância `orbit` (valem a partir da próxima resposta). O modo fica à
      // esquerda; modelo e esforço dividem um botão e um menu (lista de modelos + esforço em degraus).
      ui.selModo = gatilho('cv-sel-modo', 'cadeado', 'Modo de permissão desta sessão'); // etapa 3
      ui.selModelo = gatilho('cv-sel-modelo', 'cubo', 'Modelo e esforço desta sessão');
      ui.nivel = h('span', { class: 'cv-nivel', 'aria-hidden': 'true' });
      ui.selModelo.append(ui.nivel);
      ui.ajustes = h('span', { class: 'cv-ajustes', role: 'group', 'aria-label': 'Modo de permissão', hidden: true }, ui.selModo);
      ui.ajustesDir = h('span', { class: 'cv-ajustes', role: 'group', 'aria-label': 'Modelo e esforço', hidden: true }, ui.selModelo);
      ui.pop = h('div', { class: 'cv-pop', id: idDe('cv-pop'), role: 'menu', hidden: true });
      // Menu dos comandos com barra (abre ao digitar "/" no começo da mensagem).
      ui.cmds = h('div', { class: 'cv-cmds', id: idDe('cv-cmds'), role: 'listbox', 'aria-label': 'Comandos', hidden: true });
      ui.ajAviso = h('p', { class: 'cv-aj-aviso', role: 'status', 'aria-live': 'polite', hidden: true });
      // Etapa 3: Parar (só enquanto ocupada) e o chip das tarefas em segundo plano.
      ui.parar = botao('cv-b-parar', 'parar', 'Parar', () => pararVolta(), { hidden: true, 'aria-keyshortcuts': 'Escape' });
      ui.tarefasBtn = h('button', { type: 'button', class: 'cv-tarefas', 'aria-expanded': 'false', 'aria-controls': idDe('cv-tarefas-lista') }, ico('atividade', 13), h('span', { class: 'cv-rot' }));
      ui.tarefasLista = h('div', { class: 'cv-tarefas-lista', id: idDe('cv-tarefas-lista') });
      ui.tarefas = h('span', { class: 'cv-tarefas-wrap', hidden: true }, ui.tarefasBtn, ui.tarefasLista);
      ui.topo.firstChild.insertBefore(ui.tarefas, ui.topo.firstChild.querySelector('.cv-esp'));
      // Imagens anexadas (16/10, assets/anexos.js): botão, arrastar para o painel e Ctrl+V. Sem o módulo, só texto.
      ui.ax = window.Anexos ? window.Anexos.criar({ alvo: raiz, campo: ui.texto, max: window.Anexos.MAX, aoMudar: () => { if (vivo) atualizarEnvio(); }, aoAviso: (t) => { if (vivo) mostrarMotivo(t); } }) : null;
      // O aviso da ação (Compactando…, Limpando…) fica logo acima do campo de mensagem.
      ui.compor = h('div', { class: 'cv-compor' }, ui.cmds, ui.pop, ui.estado,
        ui.campo = h('div', { class: 'cv-campo' }, ui.ax && ui.ax.faixa, ui.texto,
          h('div', { class: 'cv-barra' }, ui.ax && ui.ax.botao, ui.ajustes, h('span', { class: 'cv-esp' }), ui.ajustesDir, ui.parar, ui.enviar)),
        ui.ajAviso);
      ui.anuncio = h('div', { class: 'cv-sr', 'aria-live': 'polite', role: 'status' });

      raiz.append(ui.topo, ui.corpo, ui.perm, ui.compor, ui.anuncio);

      ui.focoOk.addEventListener('click', confirmarFoco);
      ui.focoNao.addEventListener('click', fecharFoco);
      ui.focoTxt.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); confirmarFoco(); }
        else if (e.key === 'Escape') { e.preventDefault(); fecharFoco(); }
      });
      ui.anteriores.addEventListener('click', carregarAnteriores);
      ui.novas.addEventListener('click', () => rolarFim(true));
      ui.lista.addEventListener('scroll', aoRolar, { passive: true });
      ui.enviar.addEventListener('click', () => {
        if (ui.enviar.getAttribute('aria-disabled') === 'true') { mostrarMotivo(ui.enviar._motivo); return; }
        enviar(ui.texto.value);
      });
      ui.texto.addEventListener('keydown', (e) => {
        if (teclaMenu(e)) return; // menu de comandos aberto: setas, Enter, Tab e Esc são dele
        if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          if (ui.enviar.getAttribute('aria-disabled') === 'true') { if (ui.texto.value.trim() || nImagens()) mostrarMotivo(ui.enviar._motivo); return; }
          enviar(ui.texto.value);
        } else if (e.key === 'Escape' && !e.isComposing) {
          // Etapa 3: Esc para a volta em andamento (e não fecha o painel). Sem volta, segue o Esc de sempre.
          const r = regras();
          if (r.pararVisivel) { e.preventDefault(); e.stopPropagation(); if (!r.parar) pararVolta(); }
        }
      });
      ui.selModo.addEventListener('click', () => alternarPop('modo'));
      ui.selModelo.addEventListener('click', () => alternarPop('modelo'));
      ui.pop.addEventListener('click', cliquePop);
      ui.pop.addEventListener('keydown', teclaPop);
      for (const b of [ui.selModo, ui.selModelo]) b.addEventListener('keydown', (e) => {
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !b.disabled) { e.preventDefault(); e.stopPropagation(); abrirPop(b === ui.selModo ? 'modo' : 'modelo'); }
        else if (e.key === 'Escape' && st.pop) { e.preventDefault(); e.stopPropagation(); fecharPop(); }
      });
      ouvir(document, 'click', (e) => { if (st.pop && !ui.pop.contains(e.target) && !ui.selModo.contains(e.target) && !ui.selModelo.contains(e.target)) fecharPop(); }, true);
      ouvir(window, 'resize', () => { if (st.pop) posicionarPop(); });
      ui.tarefasBtn.addEventListener('click', () => abrirTarefas(ui.tarefasBtn.getAttribute('aria-expanded') !== 'true'));
      ui.tarefas.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.tarefasBtn.getAttribute('aria-expanded') === 'true') { e.preventDefault(); e.stopPropagation(); abrirTarefas(false); ui.tarefasBtn.focus(); } });
      ouvir(document, 'click', (e) => { if (ui.tarefasBtn.getAttribute('aria-expanded') === 'true' && !ui.tarefas.contains(e.target)) abrirTarefas(false); }, true);
      ui.texto.addEventListener('input', () => { ajustarAltura(); if (st.id) st.rascunhos.set(st.id, ui.texto.value); atualizarEnvio(); atualizarMenu(); });
      ui.texto.addEventListener('blur', () => fecharMenu());
      ui.texto.addEventListener('click', () => atualizarMenu());
      // O clique no item não tira o foco do campo (o blur fecharia o menu antes do click).
      ui.cmds.addEventListener('mousedown', (e) => e.preventDefault());
      ui.cmds.addEventListener('click', (e) => { const o = e.target.closest('.cv-cmd'); if (o) escolherComando(Number(o.dataset.i), 'clique'); });
      ui.cmds.addEventListener('mousemove', (e) => { const o = e.target.closest('.cv-cmd'); if (o && Number(o.dataset.i) !== st.menu.ativo) marcarComando(Number(o.dataset.i), false); });
      // Teclas de rolagem e Enter/Espaço dentro do painel não disparam os atalhos globais da lista.
      raiz.addEventListener('keydown', (e) => {
        const k = e.key;
        const t = e.target;
        if (t === ui.texto || t === ui.focoTxt) return;
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Enter'].includes(k)) e.stopPropagation();
      });

      assinar('sessao', (s) => { if (s && s.id === st.id) aplicarSessao(s); });
      assinar('acao', receberAcao);
      assinar('conexao', (estado) => { if (estado === 'vivo' && st.id) buscarAcoes(st.id, st.gen); });
      atualizarControles();
    }

    // ───────────────────────────── abrir / parar ─────────────────────────────
    function abrir(id) {
      if (!raiz || !id) return;
      st.parado = false;
      if (id === st.id && (st.es || st.carregando)) return;
      if (id === st.id && !st.erroCarga && st.itens.length) { retomarFluxo(id, st.gen); return; }
      abrirInterno(id);
    }
    function abrirInterno(id) {
      pararFluxo();
      const gen = ++st.gen;
      if (st.id && st.id !== id) st.rascunhos.set(st.id, ui.texto.value);
      if (ui.ax && st.id !== id) {
        if (st.id) st.anexosRasc.set(st.id, ui.ax.guardar());
        ui.ax.repor(st.anexosRasc.get(id) || []);
        st.anexosRasc.delete(id);
      }
      soltarLocais(st.itens);
      st.id = id;
      st.itens = [];
      st.porId = new Map();
      st.nos = new Map();
      st.ini = 0;
      st.cursor = null;
      st.novas = 0;
      st.erroCarga = '';
      st.permResp = '';
      ui.perm._id = null;
      ui.itens.replaceChildren();
      ui.novas.hidden = true;
      ocultarEstado(true);
      fecharFoco();
      fecharMenu();
      fecharPop();
      st.menu.dispensado = null;
      ui.texto.value = st.rascunhos.get(id) || '';
      ajustarAltura();
      const s = api.sessao(id);
      st.controle = s ? s.controle || null : null;
      st.sigControle = '';
      limparParciais();
      st.ocupAntes = !!(st.controle && st.controle.ocupada);
      abrirTarefas(false);
      esconderAviso();
      atualizarControles();
      mostrarVazio('carregando');
      st.reiniciado = '';
      st.carregando = true;
      carregarInicio(id, gen);
      buscarAcoes(id, gen);
    }
    // Aba escondida / painel fechado: sem fluxo até o próximo abrir (nem quando a carga em voo terminar).
    function parar() { st.parado = true; pararFluxo(); }
    function pararFluxo() {
      clearTimeout(st.esTimer);
      if (st.es) { try { st.es.close(); } catch {} st.es = null; }
    }

    async function carregarInicio(id, gen) {
      try {
        const d = await pedir(rotaSessao(id, 'conversa?limite=' + LIMITE));
        if (gen !== st.gen) return;
        st.carregando = false;
        const itens = Array.isArray(d.itens) ? d.itens : [];
        st.cursor = d.cursorAntigo || null;
        for (const it of itens) if (it && it.id != null && !st.porId.has(String(it.id))) { st.itens.push(it); st.porId.set(String(it.id), it); }
        renderTudo();
        rolarFim();
        conectar(id, gen, d.cursorNovo);
        requestAnimationFrame(() => { if (gen === st.gen) rolarFim(); });
      } catch (e) {
        if (gen !== st.gen) return;
        st.carregando = false;
        st.erroCarga = e.status === 404 && !/sess[aã]o/i.test(e.message)
          ? 'A conversa ainda não está disponível neste servidor.'
          : 'Não deu para carregar a conversa. ' + e.message;
        mostrarVazio('erro');
        pararFluxo();
      }
    }

    // SSE desde o cursor do GET (cursorNovo): nada se perde entre a carga e o fluxo.
    function conectar(id, gen, desde) {
      pararFluxo();
      if (st.parado || !vivo) return;
      let es;
      try { es = new EventSource(rotaSessao(id, 'conversa/fluxo') + (desde != null && desde !== '' ? '?desde=' + enc(desde) : '')); } catch { return; }
      st.es = es;
      const ler = (fn) => (ev) => { if (gen !== st.gen || st.es !== es) return; let d; try { d = JSON.parse(ev.data); } catch { return; } try { fn(d); } catch (err) { console.warn('Conversa', err); } };
      es.addEventListener('itens', ler((d) => receberItens(Array.isArray(d && d.itens) ? d.itens : [])));
      es.addEventListener('parcial', ler((d) => receberParcial(d))); // etapa 3: resposta sendo escrita
      es.addEventListener('reinicio', ler((d) => {
        // limpeza: o fluxo segue no arquivo novo desde o começo (os itens chegam por aqui, sem GET).
        if (d && d.motivo === 'limpeza') reiniciarLimpeza(d.novaSessao || st.id);
        else abrirInterno(st.id);
      }));
      es.onerror = () => {
        if (gen !== st.gen || st.es !== es) return;
        // Fecha e retoma pelo GET: a reconexão nativa repetiria o `desde` antigo.
        try { es.close(); } catch {}
        st.es = null;
        clearTimeout(st.esTimer);
        st.esTimer = setTimeout(() => { if (gen === st.gen && raiz && !raiz.hidden) retomarFluxo(st.id, gen); }, 2500);
      };
    }
    // Depois de uma queda (ou ao voltar para a aba): busca o fim, junta pelo id e reabre o fluxo.
    // (Antes chamava `retomar`, o mesmo nome do botão Retomar da etapa 4, que a sobrepunha: reabrir a conversa
    // e cair o SSE não reconectavam. Rodada 9.)
    async function retomarFluxo(id, gen) {
      try {
        const d = await pedir(rotaSessao(id, 'conversa?limite=' + LIMITE));
        if (gen !== st.gen || st.carregando || st.id !== id) return;
        receberItens(Array.isArray(d.itens) ? d.itens : [], true);
        conectar(id, gen, d.cursorNovo);
      } catch {
        if (gen !== st.gen) return;
        clearTimeout(st.esTimer);
        st.esTimer = setTimeout(() => { if (gen === st.gen && raiz && !raiz.hidden) retomarFluxo(id, gen); }, 4000);
      }
    }
    // /clear: a lista recomeça (o divisor "Conversa limpa" chega pelo SSE); o controle passa ao id novo.
    function reiniciarLimpeza(novo) {
      if (!novo || st.reiniciado === novo) return;
      const antigo = st.id;
      st.reiniciado = novo;
      if (antigo && antigo !== novo && st.rascunhos.has(antigo)) st.rascunhos.set(novo, st.rascunhos.get(antigo));
      st.id = novo;
      soltarLocais(st.itens.filter((x) => !(x.local && x.estado !== 'erro')));
      st.itens = st.itens.filter((x) => x.local && x.estado !== 'erro');
      limparParciais();
      st.porId = new Map(st.itens.map((x) => [String(x.id), x]));
      st.nos = new Map();
      st.ini = 0;
      st.cursor = null;
      st.novas = 0;
      st.permResp = '';
      ui.perm._id = null;
      ui.novas.hidden = true;
      const frag = document.createDocumentFragment();
      for (const it of st.itens) { const n = noItem(it); st.nos.set(String(it.id), n); frag.append(n); }
      ui.itens.replaceChildren(frag);
      const s = api.sessao(novo);
      if (s) st.controle = s.controle || st.controle;
      atualizarControles();
      mostrarVazio();
      atualizarTopo();
      anunciar('Conversa limpa. A sessão segue com um id novo.');
      if (antigo !== novo) selecionarQuandoChegar(novo, () => st.id === novo);
    }
    async function buscarAcoes(id, gen) {
      try {
        const l = await pedir(rotaSessao(id, 'acoes'));
        if (gen !== st.gen || !Array.isArray(l)) return;
        for (const a of l) if (a && a.id) guardarAcao(a);
        const andando = emAndamento();
        if (andando) mostrarEstado(andando);
        atualizarControles();
      } catch {}
    }
    // A sessão nova chega pelo SSE `sessao` logo depois; tenta selecionar por até 6 s.
    function selecionarQuandoChegar(novo, aindaVale) {
      let n = 0;
      const tentar = () => {
        if (!vivo || !aindaVale()) return;
        let ok = false;
        try { ok = api.selecionar(novo); } catch {}
        if (!ok && ++n < 20) setTimeout(tentar, 300);
      };
      tentar();
    }

    // ───────────────────────────── controle e sessão ─────────────────────────────
    function aplicarSessao(s) {
      const sig = JSON.stringify(s.controle || null);
      if (sig === st.sigControle) return;
      st.controle = s.controle || null;
      atualizarControles();
      // Etapa 3: a volta terminou → o parcial que não ganhou o item final vira "incompleto" depois de um tempo.
      const ocup = !!(st.controle && st.controle.ocupada);
      if (ocup) clearTimeout(st.parcTimer);
      else if (st.ocupAntes) { clearTimeout(st.parcTimer); st.parcTimer = setTimeout(marcarIncompletos, PARCIAL_ORFAO_MS); }
      st.ocupAntes = ocup;
    }
    function definirBotao(b, motivo, rotulo, ocupado, semDescricao) {
      b.setAttribute('aria-disabled', motivo ? 'true' : 'false');
      b._motivo = motivo || '';
      if (motivo) b.title = motivo; else b.removeAttribute('title');
      if (rotulo != null) txt(b._rot, rotulo);
      b.classList.toggle('cv-ocupado', !!ocupado);
      if (ocupado) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
      if (motivo && !semDescricao) b.setAttribute('aria-describedby', idDe('cv-motivo')); else b.removeAttribute('aria-describedby');
    }
    function atualizarControles() {
      if (!raiz) return;
      st.sigControle = JSON.stringify(st.controle || null);
      const r = regras();
      const andando = emAndamento();
      const t = andando && andando.tipo;
      definirBotao(ui.compactar, r.compactar, t === 'compactar' ? 'Compactando…' : 'Compactar', t === 'compactar');
      definirBotao(ui.limpar, r.limpar, t === 'limpar' ? 'Limpando…' : 'Limpar', t === 'limpar');
      const orbit = r.modo === 'orbit';
      definirBotao(ui.assumir, r.assumir,
        t === 'assumir' ? 'Assumindo…' : t === 'devolver' ? 'Devolvendo…' : orbit ? 'Devolver' : 'Assumir no Orbit',
        t === 'assumir' || t === 'devolver');
      ui.assumir.classList.toggle('cv-primario', !orbit && !r.assumir);
      // Etapa 4: numa instância criada pelo Orbit, Devolver é igual a Encerrar; fica só o Encerrar.
      ui.assumir.hidden = orbit && origemOrbit() && t !== 'devolver';
      const retomando = t === 'retomar', encerrando = t === 'encerrar';
      ui.retomar.hidden = !r.retomarVisivel;
      definirBotao(ui.retomar, r.retomar, retomando ? 'Retomando…' : 'Retomar', retomando);
      ui.retomar.classList.toggle('cv-primario', r.dormindo && !r.retomar);
      if (!r.retomar) ui.retomar.title = 'Abrir o processo de novo (--resume), sem mandar mensagem';
      ui.encerrar.hidden = !r.encerrarVisivel && !encerrando;
      definirBotao(ui.encerrar, r.encerrar, encerrando ? 'Encerrando…' : 'Encerrar', encerrando);
      if (!r.encerrar) ui.encerrar.title = 'Fechar o processo; a sessão continua aqui e acorda quando você escrever';
      // Motivos visíveis (sem depender do hover): um por linha de raciocínio, sem repetir.
      const motivos = [...new Set([r.compactar, r.assumir].filter(Boolean))];
      if (r.dormindo) {
        const c = st.controle || {};
        motivos.length = 0;
        motivos.push(textoDormiu(c) + (c.interrompida ? '. A última resposta foi interrompida' : '') + '. Escreva para retomar.'
          + ((c.dormiu || {}).motivo === 'reinicio' ? ' Tarefas em segundo plano e agendamentos de antes se perderam.' : ''));
      }
      if (andando) motivos.length = 0;
      txt(ui.motivo, motivos.join(' · '));
      ui.motivo.hidden = !motivos.length;
      if (r.compactar && !ui.foco.hidden) fecharFoco();
      ui.texto.placeholder = r.semControle ? 'Só leitura neste servidor' : r.envio ? (r.modo === 'nenhum' ? 'Assuma no Orbit para conversar' : 'Espere a ação terminar') : r.modo === 'canal' ? 'Mensagem pelo canal…' : r.dormindo ? 'Escreva para retomar, ou / para comandos' : r.modo === 'orbit' ? 'Mensagem para o agente, ou / para comandos' : 'Mensagem para o agente…';
      // Etapa 3: Parar.
      const parando = t === 'parar';
      ui.parar.hidden = !r.pararVisivel && !parando;
      definirBotao(ui.parar, r.parar, parando ? 'Parando…' : 'Parar', parando, true);
      ui.parar.title = parando ? 'Parando a volta…' : 'Interromper a volta em andamento';
      if (!comandosValem()) fecharMenu(); else if (!ui.cmds.hidden) atualizarMenu();
      atualizarAnexos(r);
      atualizarEnvio();
      renderPermissao();
      renderAjustes();
      renderTarefas();
    }
    function atualizarEnvio() {
      const r = regras();
      const nImg = nImagens();
      const vazio = !ui.texto.value.trim() && !nImg;
      const motivo = r.envio || (vazio ? 'Escreva a mensagem primeiro.' : null) || (nImg ? motivoImagens(r) : null);
      definirBotao(ui.enviar, motivo, null, st.enviando > 0, true);
      if (!motivo) ui.enviar.title = st.controle && st.controle.ocupada ? 'Enviar · entra na fila, depois da resposta atual' : 'Enviar';
    }
    // Imagens (16/10): só vão para a sessão no Orbit (o canal leva só texto).
    function nImagens() { return ui.ax ? ui.ax.contagem() : 0; }
    function motivoImagens(r) {
      if (r.modo === 'canal') return 'Imagens só vão para sessões no Orbit. Assuma no Orbit para enviar imagens.';
      if (ui.ax.pendentes()) return 'Espere as imagens ficarem prontas.';
      return null;
    }
    function atualizarAnexos(r) {
      if (!ui.ax) return;
      const m = r.semControle || r.modo === 'nenhum' ? r.envio : r.modo === 'canal' ? motivoImagens(r) : null;
      ui.ax.habilitar(!m, m);
    }
    function mostrarMotivo(m) {
      if (!m) return;
      txt(ui.motivo, m);
      ui.motivo.hidden = false;
      ui.motivo.classList.remove('cv-pisca');
      void ui.motivo.offsetWidth;
      ui.motivo.classList.add('cv-pisca');
    }

    // ───────────────────────────── modelo e esforço (rodada 6) ─────────────────────────────
    const baseModelo = (x) => String(x || '').toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
    const sigAj = (c) => (c && c.modelo || '') + '|' + (c && c.esforco || '');
    const ESFORCO = { low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo', auto: 'Automático' };
    const rotuloEsforco = (n) => (n ? ESFORCO[n] || n : '');
    function nomeModelo(id) { try { return api.nomeModelo(id) || id; } catch { return id; } }
    function opcaoModelo(m) {
      const l = st.modelos || [];
      if (!m) return null;
      return l.find((x) => x.valor === m) || l.find((x) => x.valor !== 'default' && baseModelo(x.modelo) === baseModelo(m)) || null;
    }
    function rotuloOpcao(m) {
      if (m.valor !== 'default') return m.nome || m.valor;
      const alvo = (st.modelos || []).find((x) => x.valor !== 'default' && x.modelo === m.modelo);
      return 'Padrão · ' + ((alvo && alvo.nome) || m.descricao || 'recomendado');
    }
    function carregarModelos() {
      if (st.modelos || st.modelosCarga || Date.now() < st.modelosDepois || typeof api.modelos !== 'function') return;
      st.modelosCarga = true;
      Promise.resolve().then(() => api.modelos(false))
        .then((d) => { st.modelos = (d && Array.isArray(d.modelos) ? d.modelos : []).filter((m) => m && typeof m.valor === 'string' && m.valor); st.modelosErro = ''; })
        .catch((e) => { st.modelosErro = (e && e.message) || 'Lista de modelos indisponível.'; st.modelosDepois = Date.now() + 30e3; })
        .finally(() => { st.modelosCarga = false; st.ajSig = ''; renderAjustes(); });
    }
    // O que mostrar: o efetivo devolvido pelo servidor (enquanto o controle não mudar depois dele), senão o
    // escolhido no controle, senão o da última resposta do transcript.
    function valorAjustes() {
      const c = st.controle || {};
      const ef = st.efetivo.get(st.id);
      if (ef && ef.sig === sigAj(c)) return ef;
      let s = null;
      try { s = api.sessao(st.id); } catch {}
      s = s || {};
      return { modelo: c.modelo || s.modelo || '', esforco: c.modelo ? c.esforco || '' : c.esforco || s.esforco || '' };
    }
    function renderAjustes() {
      if (!ui.ajustes) return;
      const orbit = !!st.id && !!st.controle && modoAtual() === 'orbit';
      ui.ajustes.hidden = !orbit;
      renderModo(orbit);
      if (orbit && st.controle.processo !== 'dormindo' && st.ajPendentes.has(st.id)) { st.ajPendentes.delete(st.id); if (ui.ajAviso._pendente) esconderAviso(); }
      else if (orbit && st.controle.processo === 'dormindo' && ui.ajAviso.hidden) mostrarNotaPendente();
      const ativo = orbit && typeof api.modelos === 'function';
      ui.ajustesDir.hidden = !ativo;
      if (!orbit || (!ativo && st.pop === 'modelo')) fecharPop();
      if (!ativo) { st.ajSig = ''; if (!orbit) esconderAviso(); return; }
      carregarModelos();
      const v = valorAjustes();
      const l = st.modelos || [];
      const sig = JSON.stringify([st.id, l.length, st.modelosErro, v.modelo, v.esforco, st.ajPend]);
      if (sig === st.ajSig) return;
      st.ajSig = sig;
      const atual = opcaoModelo(v.modelo);
      const semLista = !l.length;
      // Botão: o nome do modelo e, ao lado, os degraus do esforço (cheios até o nível atual).
      const b = ui.selModelo;
      txt(b._rot, atual ? nomeCurto(atual) : v.modelo ? nomeModelo(v.modelo) : semLista ? (st.modelosErro ? 'Modelo padrão' : 'Modelos…') : 'Modelo');
      b.dataset.valor = atual ? atual.valor : '';
      const niveis = niveisDe(atual);
      const i = niveis.indexOf(v.esforco);
      b.dataset.esforco = i >= 0 ? v.esforco : '';
      ui.nivel.hidden = !niveis.length;
      ui.nivel.replaceChildren(...niveis.map((_, k) => h('i', { class: k <= i ? 'cv-on' : null })));
      b.disabled = semLista;
      b.title = semLista && st.modelosErro ? st.modelosErro
        : 'Modelo' + (atual ? ': ' + rotuloOpcao(atual) : '') + (i >= 0 ? ' · esforço ' + rotuloEsforco(v.esforco).toLowerCase() : '') + ' · vale a partir da próxima resposta';
      b.setAttribute('aria-label', 'Modelo e esforço desta sessão: ' + (atual ? rotuloOpcao(atual) : b._rot.textContent) + (i >= 0 ? ', esforço ' + rotuloEsforco(v.esforco).toLowerCase() : ''));
      if (st.ajPend) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
      renderPop();
    }
    // "Default (recommended)" do binário aparece como "Padrão"; no botão, o nome do modelo que ele resolve.
    function nomeCurto(m) {
      if (m.valor !== 'default') return m.nome || m.valor;
      const alvo = (st.modelos || []).find((x) => x.valor !== 'default' && x.modelo === m.modelo);
      return (alvo && alvo.nome) || m.descricao || 'Padrão';
    }
    const niveisDe = (m) => (m && Array.isArray(m.esforcos) ? m.esforcos.filter((x) => typeof x === 'string') : []);
    // As descrições vêm em inglês do Claude Code; as conhecidas ganham a versão em português.
    const DESC_MODELO = {
      'for complex work and everyday tasks': 'Para trabalho complexo e o dia a dia',
      'for your toughest challenges': 'Para os desafios mais difíceis',
      'most efficient for simpler tasks': 'O mais eficiente para tarefas simples',
      'fastest for quick answers': 'O mais rápido, para respostas curtas',
      'efficient for routine tasks': 'Eficiente para tarefas de rotina',
      'best for everyday, complex tasks': 'Para tarefas complexas do dia a dia',
      'most capable for your hardest and longest-running tasks': 'O mais capaz, para tarefas longas e difíceis',
    };
    function descModelo(m) {
      if (m.valor === 'default') { const alvo = nomeCurto(m); return 'Recomendado' + (alvo && alvo !== 'Padrão' ? ' · ' + alvo : ''); }
      const d = String(m.descricao || '').trim();
      return DESC_MODELO[d.toLowerCase().replace(/\.$/, '')] || d;
    }
    // Os apelidos (default, opus, sonnet…) ficam em cima; as versões fixas (claude-opus-4-8…) em "Outras versões".
    const versaoFixa = (m) => m.valor !== 'default' && /[-.\d]/.test(m.valor);

    // ───────────────────────────── menu flutuante dos seletores ─────────────────────────────
    const gatilhoPop = () => (st.pop === 'modo' ? ui.selModo : ui.selModelo);
    function alternarPop(qual) { if (st.pop === qual) fecharPop(true); else abrirPop(qual); }
    function abrirPop(qual, foco) {
      const b = qual === 'modo' ? ui.selModo : ui.selModelo;
      if (b.disabled || b.closest('[hidden]')) { mostrarMotivo(b.title || 'Este seletor não está disponível agora.'); return; }
      fecharMenu();
      if (st.pop && st.pop !== qual) fecharPop();
      st.pop = qual;
      st.popSig = '';
      ui.pop.dataset.qual = qual;
      ui.pop.setAttribute('aria-label', qual === 'modo' ? 'Modo de permissão' : 'Modelo e esforço');
      renderPop();
      ui.pop.hidden = false;
      b.setAttribute('aria-expanded', 'true');
      b.classList.add('cv-aberto');
      posicionarPop();
      const alvo = (foco === 'esforco' && (ui.pop.querySelector('.cv-degrau[aria-checked="true"]') || ui.pop.querySelector('.cv-degrau')))
        || ui.pop.querySelector('.cv-pop-i[aria-checked="true"]') || ui.pop.querySelector('.cv-pop-i');
      if (alvo) { alvo.focus({ preventScroll: true }); alvo.scrollIntoView({ block: 'nearest' }); }
    }
    function fecharPop(focar) {
      if (!st.pop) return;
      const b = gatilhoPop();
      st.pop = '';
      st.popSig = '';
      ui.pop.hidden = true;
      ui.pop.replaceChildren();
      for (const x of [ui.selModo, ui.selModelo]) { x.setAttribute('aria-expanded', 'false'); x.classList.remove('cv-aberto'); }
      if (focar && b && !b.closest('[hidden]')) b.focus();
    }
    // Sobre o cartão, alinhado ao botão (o do modo à esquerda, o do modelo à direita), sem sair do painel.
    function posicionarPop() {
      if (!st.pop) return;
      const c = ui.compor.getBoundingClientRect(), b = gatilhoPop().getBoundingClientRect(), topo = raiz.getBoundingClientRect().top;
      ui.pop.style.bottom = Math.round(c.bottom - b.top + 6) + 'px';
      ui.pop.style.maxHeight = Math.max(160, Math.min(460, Math.round(b.top - topo - 14))) + 'px';
      const w = ui.pop.offsetWidth;
      const esq = st.pop === 'modo' ? b.left - c.left : b.right - c.left - w;
      ui.pop.style.left = Math.round(Math.max(8, Math.min(esq, c.width - w - 8))) + 'px';
    }
    function itemPop(tipo, valor, marcado, rotulo, desc, extra) {
      return h('button', { type: 'button', class: 'cv-pop-i', role: 'menuitemradio', tabindex: '-1', 'aria-checked': String(!!marcado), 'data-tipo': tipo, 'data-valor': valor, 'aria-disabled': extra && extra.desabilitado ? 'true' : null },
        extra && extra.icone ? h('span', { class: 'cv-pop-ico', 'aria-hidden': 'true' }, ico(extra.icone, 14)) : null,
        h('span', { class: 'cv-pop-txt' }, h('span', { class: 'cv-pop-rot' }, rotulo), desc ? h('span', { class: 'cv-pop-desc' }, desc) : null),
        h('span', { class: 'cv-pop-check' }, svgCheck()));
    }
    function renderPop() {
      if (!st.pop || !ui.pop) return;
      const modo = st.pop === 'modo';
      const v = modo ? valorModo() : valorAjustes();
      const sig = JSON.stringify([st.pop, st.id, v, st.modoPend, st.ajPend, st.maisVersoes, (st.modelos || []).length]);
      if (sig === st.popSig) return;
      st.popSig = sig;
      const focado = ui.pop.contains(document.activeElement) ? document.activeElement : null;
      const chave = focado && (focado.dataset.tipo + '|' + (focado.dataset.valor || ''));
      const filhos = [];
      if (modo) {
        filhos.push(h('div', { class: 'cv-pop-tit', 'aria-hidden': 'true' }, 'Modo de permissão'));
        if (!MODOS.some((m) => m[0] === v)) filhos.push(itemPop('modo', v, true, rotuloModo(v), 'Definido fora do Orbit', { icone: ICONE_MODO[v] || 'raio', desabilitado: true }));
        for (const [valor, rot, desc] of MODOS) filhos.push(itemPop('modo', valor, valor === v, rot, desc, { icone: ICONE_MODO[valor], desabilitado: st.modoPend }));
      } else {
        const l = st.modelos || [];
        const atual = opcaoModelo(v.modelo);
        const principais = l.filter((m) => !versaoFixa(m)), outras = l.filter(versaoFixa);
        const abertas = st.maisVersoes || (!!atual && versaoFixa(atual));
        const item = (m) => itemPop('modelo', m.valor, !!atual && atual.valor === m.valor, m.valor === 'default' ? 'Padrão' : m.nome || m.valor, descModelo(m), { desabilitado: !!st.ajPend });
        filhos.push(h('div', { class: 'cv-pop-tit', 'aria-hidden': 'true' }, 'Modelo'));
        filhos.push(h('div', { role: 'group', 'aria-label': 'Modelos' }, ...principais.map(item)));
        if (outras.length) {
          filhos.push(h('button', { type: 'button', class: 'cv-pop-i cv-pop-mais', role: 'menuitem', tabindex: '-1', 'data-tipo': 'mais', 'aria-expanded': String(abertas) },
            h('span', { class: 'cv-pop-txt' }, h('span', { class: 'cv-pop-rot' }, 'Outras versões')), h('span', { class: 'cv-pop-qtd' }, String(outras.length))));
          if (abertas) filhos.push(h('div', { class: 'cv-pop-versoes', role: 'group', 'aria-label': 'Outras versões' }, ...outras.map(item)));
        }
        // Esforço do modelo escolhido, em degraus (cheios até o nível atual).
        if (atual) {
          const niveis = niveisDe(atual);
          const i = niveis.indexOf(v.esforco);
          const cab = h('div', { class: 'cv-esf-cab' }, h('span', { id: idDe('cv-esf-t') }, 'Esforço'),
            h('span', { class: 'cv-esf-val' }, niveis.length ? (i >= 0 ? rotuloEsforco(v.esforco) : 'Padrão') : 'Não se aplica'));
          const corpo = niveis.length
            ? h('div', { class: 'cv-degraus', role: 'group', 'aria-labelledby': idDe('cv-esf-t'), 'aria-busy': st.ajPend === 'esforco' ? 'true' : null },
              ...niveis.map((n, k) => h('button', { type: 'button', class: 'cv-degrau' + (k <= i ? ' cv-on' : ''), role: 'menuitemradio', tabindex: '-1', 'aria-checked': String(k === i),
                'aria-label': rotuloEsforco(n), title: rotuloEsforco(n), 'data-tipo': 'esforco', 'data-valor': n, 'aria-disabled': st.ajPend ? 'true' : null })))
            : h('p', { class: 'cv-esf-nao' }, (atual.nome || atual.valor) + ' não tem nível de esforço.');
          filhos.push(h('div', { class: 'cv-pop-sep', role: 'separator' }), h('div', { class: 'cv-esf' }, cab, corpo));
        }
      }
      ui.pop.replaceChildren(...filhos);
      if (chave) {
        const [tipo, valor] = chave.split('|');
        const de = [...ui.pop.querySelectorAll('[data-tipo]')].find((x) => x.dataset.tipo === tipo && (x.dataset.valor || '') === valor);
        if (de) de.focus({ preventScroll: true });
      }
      posicionarPop();
    }
    function cliquePop(e) {
      const it = e.target.closest('[data-tipo]');
      if (!it || !ui.pop.contains(it)) return;
      if (it.getAttribute('aria-disabled') === 'true') return;
      const { tipo, valor } = it.dataset;
      if (tipo === 'mais') {
        const atual = opcaoModelo(valorAjustes().modelo);
        st.maisVersoes = !(st.maisVersoes || (!!atual && versaoFixa(atual)));
        renderPop();
        return;
      }
      if (tipo === 'modo') { fecharPop(true); trocarModo(valor); return; }
      const v = valorAjustes();
      if (tipo === 'modelo') {
        fecharPop(true);
        const atual = opcaoModelo(v.modelo);
        if (!atual || atual.valor !== valor) trocarAjuste('modelo', valor);
        return;
      }
      if (tipo === 'esforco') { it.focus(); if (v.esforco !== valor) trocarAjuste('esforco', valor); }
    }
    // Setas para cima/baixo andam pelos itens (o esforço conta como uma parada); esquerda/direita, pelos degraus.
    function teclaPop(e) {
      const k = e.key;
      if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); fecharPop(true); return; }
      if (k === 'Tab') { e.preventDefault(); fecharPop(true); return; }
      const atual = document.activeElement;
      const degraus = [...ui.pop.querySelectorAll('.cv-degrau')];
      if ((k === 'ArrowLeft' || k === 'ArrowRight') && degraus.includes(atual)) {
        e.preventDefault();
        const i = degraus.indexOf(atual) + (k === 'ArrowRight' ? 1 : -1);
        if (degraus[i]) degraus[i].focus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(k)) return;
      e.preventDefault();
      const rep = degraus.find((x) => x.getAttribute('aria-checked') === 'true') || degraus[0];
      const paradas = [...ui.pop.querySelectorAll('.cv-pop-i')];
      if (rep) paradas.push(rep);
      if (!paradas.length) return;
      let i = degraus.includes(atual) ? paradas.length - 1 : paradas.indexOf(atual);
      i = k === 'Home' ? 0 : k === 'End' ? paradas.length - 1 : (i + (k === 'ArrowDown' ? 1 : -1) + paradas.length) % paradas.length;
      paradas[i].focus();
      paradas[i].scrollIntoView({ block: 'nearest' });
    }
    // Etapa 4: trocas feitas com a instância dormindo ficam anotadas até ela acordar ("vale ao retomar").
    function notaPendente(id, t) {
      const l = (st.ajPendentes.get(id) || []).filter((x) => x.split(':')[0] !== t.split(':')[0]);
      l.push(t);
      st.ajPendentes.set(id, l);
      if (id === st.id) mostrarNotaPendente();
    }
    function mostrarNotaPendente() {
      const l = st.ajPendentes.get(st.id);
      if (!l || !l.length) return;
      clearTimeout(st.ajTimer);
      txt(ui.ajAviso, l.join(' · ') + ' · vale ao retomar.');
      ui.ajAviso.classList.add('cv-aj-info');
      ui.ajAviso.hidden = false;
      ui.ajAviso._pendente = true;
    }
    function mostrarAviso(t, info) {
      ui.ajAviso._pendente = false;
      clearTimeout(st.ajTimer);
      txt(ui.ajAviso, t);
      ui.ajAviso.classList.toggle('cv-aj-info', !!info);
      ui.ajAviso.hidden = false;
      st.ajTimer = setTimeout(esconderAviso, info ? 6000 : 12000);
    }
    function esconderAviso() {
      clearTimeout(st.ajTimer);
      if (ui.ajAviso && !ui.ajAviso.hidden) { ui.ajAviso.hidden = true; txt(ui.ajAviso, ''); }
    }
    async function trocarAjuste(tipo, valor) {
      const id = st.id, gen = st.gen;
      if (!id || !valor || st.ajPend) { st.ajSig = ''; renderAjustes(); return; }
      st.ajPend = tipo;
      esconderAviso();
      renderAjustes();
      try {
        const d = await pedir(rotaSessao(id, tipo), tipo === 'modelo' ? { modelo: valor } : { esforco: valor });
        let modelo = typeof d.modelo === 'string' ? d.modelo : '';
        const esforco = typeof d.esforco === 'string' ? d.esforco : '';
        // "default" e "fable" resolvem para o mesmo id: se o efetivo é o modelo pedido, fica o valor pedido.
        const pedido = tipo === 'modelo' ? opcaoModelo(valor) : null;
        if (pedido && modelo && modelo !== valor && baseModelo(pedido.modelo) === baseModelo(modelo)) modelo = valor;
        let ctl = null;
        if (gen === st.gen) ctl = st.controle; else { try { const s = api.sessao(id); ctl = s && s.controle; } catch {} }
        st.efetivo.set(id, { modelo, esforco, sig: sigAj(ctl) });
        if (gen !== st.gen) return;
        const ok = tipo === 'modelo' ? (opcaoModelo(modelo) || {}).valor === valor : esforco === valor;
        const nomeEf = tipo === 'modelo' ? (opcaoModelo(modelo) ? rotuloOpcao(opcaoModelo(modelo)) : nomeModelo(modelo) || 'o anterior') : rotuloEsforco(esforco) || 'o padrão';
        // Etapa 4: instância dormindo → o servidor grava e devolve `pendente: true` (vale ao retomar).
        if (d.pendente) notaPendente(id, (tipo === 'modelo' ? 'Modelo: ' : 'Esforço: ') + nomeEf);
        else if (!ok) mostrarAviso('O Claude Code ficou com ' + nomeEf + (tipo === 'modelo' ? '.' : ' de esforço.'), true);
        if (ok || d.pendente) anunciar((tipo === 'modelo' ? 'Modelo: ' : 'Esforço: ') + nomeEf + (d.pendente ? ', vale ao retomar.' : ', a partir da próxima resposta.'));
      } catch (e) {
        if (gen === st.gen) mostrarAviso((tipo === 'modelo' ? 'O modelo não mudou: ' : 'O esforço não mudou: ') + e.message);
      } finally {
        if (st.ajPend === tipo) st.ajPend = '';
        st.ajSig = '';
        if (gen === st.gen) renderAjustes(); // volta ao efetivo (inclusive depois de um erro)
      }
    }

    // ───────────────────────────── modo de permissão (etapa 3) ─────────────────────────────
    // Mostra o efetivo devolvido pelo POST /modo enquanto o controle não mudar depois dele; senão o do controle.
    function valorModo() {
      const c = st.controle || {};
      const ef = st.modoEf.get(st.id);
      if (ef && ef.sig === (c.modoPermissao || '')) return ef.modo;
      return c.modoPermissao || 'default';
    }
    function renderModo(orbit) {
      if (!orbit) { st.modoSig = ''; return; }
      const v = valorModo();
      const iniciando = /inician/i.test((st.controle && st.controle.motivo) || '');
      const sig = JSON.stringify([st.id, v, st.modoPend, iniciando]);
      if (sig === st.modoSig) return;
      st.modoSig = sig;
      // O botão mostra o ícone e o nome do modo; a lista (nome, descrição e marca) abre no menu flutuante.
      const desligado = st.modoPend || iniciando;
      const atual = MODOS.find((m) => m[0] === v);
      const b = ui.selModo;
      txt(b._rot, rotuloModo(v));
      b.disabled = desligado;
      b.title = iniciando ? 'Espere a instância iniciar' : 'Modo de permissão: ' + rotuloModo(v) + (atual ? ' · ' + atual[2] : '');
      b.setAttribute('aria-label', 'Modo de permissão desta sessão: ' + rotuloModo(v));
      b.dataset.modo = v;
      b._ico.replaceChildren(ico(ICONE_MODO[v] || 'cadeado', 13));
      if (desligado && st.pop === 'modo') fecharPop();
      renderPop();
    }
    async function trocarModo(valor) {
      const id = st.id, gen = st.gen;
      if (!id || !valor || st.modoPend || valor === valorModo()) { st.modoSig = ''; renderAjustes(); return; }
      st.modoPend = true;
      esconderAviso();
      renderAjustes();
      try {
        const d = await pedir(rotaSessao(id, 'modo'), { modo: valor });
        const modo = typeof d.modo === 'string' && d.modo ? d.modo : valor;
        let ctl = null;
        if (gen === st.gen) ctl = st.controle; else { try { const s = api.sessao(id); ctl = s && s.controle; } catch {} }
        st.modoEf.set(id, { modo, sig: (ctl && ctl.modoPermissao) || '' });
        if (gen !== st.gen) return;
        if (d.pendente) notaPendente(id, 'Modo: ' + rotuloModo(modo)); // etapa 4
        if (modo !== valor && !d.pendente) mostrarAviso('O Claude Code ficou no modo ' + rotuloModo(modo) + '.', true);
        else anunciar('Modo de permissão: ' + rotuloModo(modo) + (d.pendente ? ', vale ao retomar.' : '.'));
      } catch (e) {
        if (gen === st.gen) mostrarAviso('O modo não mudou: ' + e.message);
      } finally {
        st.modoPend = false;
        st.modoSig = '';
        if (gen === st.gen) renderAjustes();
      }
    }

    // ───────────────────────────── tarefas em segundo plano (etapa 3) ─────────────────────────────
    function listaTarefas() {
      const c = st.controle;
      if (!c || c.modo !== 'orbit' || !Array.isArray(c.tarefas)) return [];
      return c.tarefas.filter((t) => t && typeof t === 'object');
    }
    const descTarefa = (t) => String(t.descricao || t.id || 'Tarefa sem descrição');
    const tipoTarefa = (t) => TIPO_TAREFA[t.tipo] || (t.tipo ? String(t.tipo).replace(/_/g, ' ') : 'Tarefa');
    function renderTarefas() {
      if (!ui.tarefas) return;
      const l = listaTarefas();
      const sig = JSON.stringify(l.map((t) => [t.id, t.tipo, t.descricao]));
      if (sig === st.tarSig) return;
      st.tarSig = sig;
      ui.tarefas.hidden = !l.length;
      if (!l.length) { abrirTarefas(false); ui.tarefasLista.replaceChildren(); return; }
      const n = l.length;
      const rot = n === 1 ? '1 tarefa' : n + ' tarefas';
      txt(ui.tarefasBtn.lastChild, rot);
      ui.tarefasBtn.setAttribute('aria-label', rot + ' em segundo plano');
      ui.tarefasBtn.title = 'Em segundo plano:\n' + l.map((t) => '• ' + tipoTarefa(t) + ': ' + descTarefa(t)).join('\n');
      ui.tarefasLista.replaceChildren(
        h('p', { class: 'cv-tarefas-tit' }, 'Em segundo plano'),
        h('ul', null, ...l.map((t) => h('li', null, h('span', { class: 'cv-tarefas-tipo' }, tipoTarefa(t)), h('span', { class: 'cv-tarefas-desc' }, descTarefa(t))))));
    }
    function abrirTarefas(abrir) {
      if (!ui.tarefasBtn) return;
      ui.tarefasBtn.setAttribute('aria-expanded', String(!!abrir));
      ui.tarefas.classList.toggle('cv-aberto', !!abrir);
    }

    // ───────────────────────────── parar (etapa 3) ─────────────────────────────
    function pararVolta() {
      const r = regras();
      if (!r.pararVisivel) return;
      if (r.parar) { mostrarMotivo(r.parar); return; }
      acionar('parar', {});
    }

    // ───────────────────────────── retomar e encerrar (etapa 4) ─────────────────────────────
    function retomar() {
      const r = regras();
      if (!r.retomarVisivel) return;
      if (r.retomar) { mostrarMotivo(r.retomar); return; }
      acionar('retomar', {});
    }
    async function encerrar() {
      const r = regras();
      if (!r.encerrarVisivel) return;
      if (r.encerrar) { mostrarMotivo(r.encerrar); return; }
      const c = st.controle || {};
      const sessao = st.id;
      if (c.ocupada || c.permissao || listaTarefas().length) {
        if (!(await confirmarEncerrar(sessao))) return;
        acionar('encerrar', { forcar: true }, sessao);
        return;
      }
      const a = await acionar('encerrar', {}, sessao);
      // Corrida: começou uma volta entre o clique e o pedido (409 ocupada) → pergunta e força.
      if (!a && st.id === sessao && st.ultimoErro.encerrar === 'ocupada' && (await confirmarEncerrar(sessao))) acionar('encerrar', { forcar: true }, sessao);
    }
    async function confirmarEncerrar(sessao) {
      const tarefas = listaTarefas().length;
      const texto = 'A resposta em andamento para' + (tarefas ? ' e as tarefas em segundo plano se perdem' : '') + '. Escreva para retomar.';
      try { return !!(await api.confirmar(texto, 'Interromper e encerrar', 'Encerrar a instância?', ancora(ui.encerrar, sessao))); } catch { return window.confirm(texto); }
    }

    // ───────────────────────────── ações ─────────────────────────────
    function guardarAcao(a) {
      const ant = st.acoes.get(a.id);
      // Um evento atrasado "em andamento" não desfaz um estado final já recebido.
      if (ant && ant.estado !== 'em_andamento' && a.estado === 'em_andamento') return ant;
      st.acoes.set(a.id, a);
      if (st.acoes.size > 80) st.acoes.delete(st.acoes.keys().next().value);
      return a;
    }
    function receberAcao(a) {
      if (!a || !a.id) return;
      const ac = guardarAcao(a);
      const minha = st.minhas.get(a.id);
      const final = ac.estado !== 'em_andamento';
      if (ac.tipo === 'mensagem') {
        const local = st.itens.find((x) => x.local && x.acao === ac.id);
        if (local) aplicarAcaoLocal(local, ac);
        faixaRetomada(ac);
      } else {
        const nova = ac.tipo === 'limpar' && ac.estado === 'sucesso' && ac.resultado && ac.resultado.novaSessao;
        if (nova && st.id === ac.sessao && raiz && !raiz.hidden) reiniciarLimpeza(nova); // o mesmo fluxo segue no arquivo novo
        else if (nova && minha) { const velho = ac.sessao; selecionarQuandoChegar(nova, () => { try { return api.selecionada() === velho; } catch { return false; } }); }
        if (ac.sessao === st.id || (nova && nova === st.id)) mostrarEstado(ac);
      }
      if (final && minha) {
        st.minhas.delete(a.id);
        if (!visivelPara(ac.sessao) && !(ac.resultado && visivelPara(ac.resultado.novaSessao)) && ac.tipo !== 'mensagem') { try { api.toast(textoFinal(ac)); } catch {} }
      }
      if (ac.sessao === st.id || (st.id && ac.resultado && ac.resultado.novaSessao === st.id)) atualizarControles();
    }
    // Etapa 4: a mensagem para uma instância dormindo acorda o processo primeiro ("Retomando a instância…" na
    // etapa da Acao). A faixa de estado mostra a retomada; depois a bolha segue com o estado da mensagem.
    function faixaRetomada(ac) {
      if (ac.sessao !== st.id) return;
      const retomando = ac.estado === 'em_andamento' && /retomando/i.test(ac.etapa || '');
      if (retomando) {
        st.faixaRetomada = ac.id;
        mostrarEstado({ id: ac.id, sessao: ac.sessao, tipo: 'retomar', estado: 'em_andamento', etapa: 'Depois sua mensagem segue' });
      } else if (st.faixaRetomada === ac.id) {
        st.faixaRetomada = '';
        if (ac.estado === 'erro') mostrarEstado({ id: ac.id, sessao: ac.sessao, tipo: 'retomar', estado: 'erro', erro: ac.erro || 'A instância não voltou.', codigo: 'mensagem' });
        else ocultarEstado(true);
      }
    }
    function textoFinal(a) {
      const [, ok, ruim] = rotuloAcao(a) || ['', 'Pronto', 'Falhou'];
      if (a.estado === 'erro') return ruim + ': ' + (a.erro || 'erro sem detalhe');
      if (a.tipo === 'compactar' && a.resultado && a.resultado.pre && a.resultado.pos) return ok + ' · ' + fmtK(a.resultado.pre) + ' → ' + fmtK(a.resultado.pos);
      if (a.tipo === 'limpar') return ok + ' · a sessão segue com um id novo';
      if (a.tipo === 'assumir') return ok + ' · dá para conversar, compactar e limpar daqui';
      if (a.tipo === 'devolver') return ok + ' · para continuar no VS Code, use "Abrir no VS Code"';
      if (a.tipo === 'parar') return ok + ' · o agente espera a próxima mensagem';
      if (a.tipo === 'encerrar') return ok + ' · escreva para retomar';
      if (a.tipo === 'retomar') return ok + ' · o processo está de volta';
      return ok;
    }
    async function acionar(tipo, corpo, sessao = st.id) {
      if (!sessao) return null;
      if (sessao === st.id) {
        const r = regras();
        const m = tipo === 'compactar' ? r.compactar : tipo === 'limpar' ? r.limpar : tipo === 'parar' ? r.parar : tipo === 'encerrar' ? r.encerrar : tipo === 'retomar' ? r.retomar : r.assumir;
        if (m) { mostrarMotivo(m); return null; }
        mostrarEstado({ id: '', sessao, tipo, estado: 'em_andamento', etapa: 'Enviando o pedido' });
      }
      st.ultimoCorpo.set(tipo, corpo);
      st.ultimoErro[tipo] = '';
      try {
        const d = await pedir(rotaSessao(sessao, tipo), corpo);
        const a = d && d.acao;
        if (!a || !a.id) throw new Error('O servidor não devolveu a ação.');
        st.minhas.set(a.id, { sessao, tipo });
        const ac = guardarAcao(a);
        receberAcao(ac);
        return ac;
      } catch (e) {
        st.ultimoErro[tipo] = e.codigo || '';
        const falha = { id: '', sessao, tipo, estado: 'erro', erro: e.message, codigo: e.codigo };
        if (sessao === st.id) { mostrarEstado(falha); atualizarControles(); }
        else { try { api.toast(textoFinal(falha)); } catch {} }
        return null;
      }
    }
    async function limpar(sessao = st.id) {
      const ok = await confirmarLimpeza(sessao);
      if (ok) return acionar('limpar', { confirmar: true }, sessao);
      return null;
    }
    async function confirmarLimpeza(sessao) {
      const texto = 'O agente perde o contexto atual. O histórico continua salvo.';
      try { return !!(await api.confirmar(texto, 'Limpar conversa', 'Limpar a conversa?', ancora(ui.limpar, sessao))); } catch { return window.confirm(texto); }
    }
    // Com a conversa à vista, o balão de confirmação fica logo acima do cartão do prompt (o botão que abriu é o
    // gatilho: clicar de novo só fecha). Senão, a página ancora no elemento com o foco (ex.: o botão do Resumo).
    function ancora(b, sessao) { return sessao === st.id && raiz && !raiz.hidden ? { ancora: ui.campo, gatilho: b, lado: 'cima' } : {}; }
    // Botões de contexto do Resumo, em sessão `orbit`.
    async function executar(id, tipo, op = {}) {
      if (!id) return null;
      let a;
      if (tipo === 'limpar') {
        if (!(await confirmarLimpeza(id))) return null;
        a = await acionar('limpar', { confirmar: true }, id);
      } else {
        const foco = String(op.foco || '').trim().slice(0, 500);
        a = await acionar('compactar', foco ? { foco } : {}, id);
      }
      if (a && a.estado === 'em_andamento' && !visivelPara(id)) toastInicio(tipo === 'limpar' ? 'Limpando pelo Orbit…' : 'Compactando pelo Orbit…');
      return a;
    }
    function visivelPara(id) { try { return !!api.visivel() && st.id === id; } catch { return false; } }
    function toastInicio(t) { try { api.toast(t); } catch {} }

    // 16/10: com o balão da página, o foco da compactação é um campo dentro dele, ancorado no Compactar.
    // Sem o balão (página antiga), fica o painel embutido no topo.
    async function abrirFoco() {
      if (typeof api.balao === 'function') {
        const sessao = st.id;
        ui.compactar.setAttribute('aria-expanded', 'true');
        let r = null;
        try {
          r = await api.balao({ ...ancora(ui.compactar, sessao), titulo: 'Compactar o contexto?', texto: 'O agente resume a conversa para liberar espaço. O histórico continua salvo.',
            sim: 'Compactar', campo: { dica: 'Foco da compactação (opcional)', max: 500 } });
        } catch {} finally { ui.compactar.setAttribute('aria-expanded', 'false'); }
        if (r && r.ok && st.id === sessao) acionar('compactar', r.valor ? { foco: r.valor } : {});
        return;
      }
      ui.foco.hidden = false;
      ui.compactar.setAttribute('aria-expanded', 'true');
      ui.focoTxt.focus();
    }
    function fecharFoco() {
      if (!ui.foco || ui.foco.hidden) return;
      const tinhaFoco = ui.foco.contains(document.activeElement);
      ui.foco.hidden = true;
      ui.compactar.setAttribute('aria-expanded', 'false');
      if (tinhaFoco) ui.compactar.focus();
    }
    function confirmarFoco() {
      const foco = ui.focoTxt.value.trim();
      fecharFoco();
      ui.focoTxt.value = '';
      acionar('compactar', foco ? { foco } : {});
    }

    // Faixa de estado (aria-live): a ação de controle mais recente desta sessão.
    function mostrarEstado(a) {
      clearTimeout(st.estadoTimer);
      const [andando] = rotuloAcao(a) || ['Ação'];
      const el = ui.estado;
      el.dataset.estado = a.estado;
      const partes = [];
      if (a.estado === 'em_andamento') {
        partes.push(h('span', { class: 'cv-chip', 'data-estado': 'em_andamento' }, ponto('trabalhando', 11), andando + '…'));
        if (a.etapa) partes.push(h('span', { class: 'cv-estado-txt' }, a.etapa));
      } else if (a.estado === 'sucesso') {
        partes.push(h('span', { class: 'cv-chip', 'data-estado': 'sucesso' }, ponto('concluida', 11), textoFinal(a)));
        if (a.tipo === 'devolver') {
          const abrir = h('button', { type: 'button', class: 'link' }, 'Abrir no VS Code');
          abrir.addEventListener('click', () => { try { api.abrirVSCode(a.sessao); } catch {} });
          partes.push(abrir);
        }
        st.estadoTimer = setTimeout(() => ocultarEstado(), 9000);
      } else {
        const [, , ruim] = rotuloAcao(a) || ['', '', 'Falhou'];
        partes.push(h('span', { class: 'cv-chip', 'data-estado': 'erro' }, ponto('erro', 11), ruim));
        partes.push(h('span', { class: 'cv-estado-txt cv-estado-erro' }, a.erro || 'O servidor não explicou o erro.'));
        const pode = !['trabalhando', 'ja_assumida', 'nao_assumida', 'sem_transcript', 'parada', 'mensagem'].includes(a.codigo);
        if (pode) {
          const tentar = h('button', { type: 'button', class: 'link' }, 'Tentar de novo');
          tentar.addEventListener('click', () => {
            const corpo = st.ultimoCorpo.get(a.tipo) || (a.tipo === 'limpar' ? { confirmar: true } : {});
            if (a.tipo === 'limpar') limpar(); else acionar(a.tipo, corpo);
          });
          partes.push(tentar);
        }
      }
      const fechar = h('button', { type: 'button', class: 'btn-icone cv-estado-x', 'aria-label': 'Fechar aviso', title: 'Fechar aviso' }, ico('x', 13));
      fechar.addEventListener('click', () => ocultarEstado());
      if (a.estado !== 'em_andamento') partes.push(fechar);
      el.replaceChildren(...partes);
      el.hidden = false;
    }
    function ocultarEstado(seco) {
      clearTimeout(st.estadoTimer);
      if (!ui.estado) return;
      const tinhaFoco = ui.estado.contains(document.activeElement);
      ui.estado.hidden = true;
      ui.estado.replaceChildren();
      if (tinhaFoco && !seco) ui.lista.focus({ preventScroll: true });
    }

    // ───────────────────────────── permissão (etapa 3: ferramenta | pergunta | plano) ─────────────────────────────
    function tipoPermissao(p) {
      if (p.tipo === 'pergunta' || p.tipo === 'plano' || p.tipo === 'ferramenta') return p.tipo;
      if (p.ferramenta === 'AskUserQuestion' && Array.isArray(p.perguntas)) return 'pergunta';
      if (p.ferramenta === 'ExitPlanMode') return 'plano';
      return 'ferramenta';
    }
    const textoFila = (n) => 'mais ' + n + (n === 1 ? ' pedido na fila' : ' pedidos na fila');
    const ehAceitarEdicoes = (s) => s && (s.modo === 'acceptEdits' || /aceit\w*\s+(as\s+)?edi[cç]/i.test(String(s.rotulo || '')));
    function sugestoesDe(p) {
      return (Array.isArray(p.sugestoes) ? p.sugestoes : []).filter((s) => s && s.indice != null && String(s.rotulo || '').trim());
    }
    // Botão do cartão: guarda o rótulo para voltar depois de um erro.
    function btPerm(classe, icone, rotulo, extra) {
      const rot = h('span', { class: 'cv-rot' }, rotulo);
      const b = h('button', { type: 'button', class: 'btn p ' + classe, ...extra }, icone ? ico(icone, 13) : null, rot);
      b._rot = rot;
      b._txt = rotulo;
      return b;
    }
    function renderPermissao() {
      const c = st.controle;
      const p = c && c.modo === 'orbit' && c.permissao && c.permissao.id != null && c.permissao.id !== st.permResp ? c.permissao : null;
      if (!p) {
        if (!ui.perm.hidden) { ui.perm.hidden = true; ui.perm.replaceChildren(); ui.perm._id = null; delete ui.perm.dataset.tipo; }
        return;
      }
      const fila = Math.max(0, (Number(c.pendentes) || 1) - 1);
      if (ui.perm._id === p.id) {
        if (ui.perm._fila) { txt(ui.perm._fila, textoFila(fila)); ui.perm._fila.hidden = !fila; }
        return;
      }
      ui.perm._id = p.id;
      const tipo = tipoPermissao(p);
      const cartao = { p, tipo, id: st.id, gen: st.gen };
      cartao.erro = h('p', { class: 'cv-perm-erro', role: 'alert', hidden: true });
      cartao.fila = h('span', { class: 'cv-perm-fila', hidden: !fila }, textoFila(fila));
      ui.perm._fila = cartao.fila;
      let partes;
      try {
        partes = tipo === 'pergunta' ? cartaoPergunta(cartao) : tipo === 'plano' ? cartaoPlano(cartao) : cartaoFerramenta(cartao);
      } catch (e) {
        console.warn('Conversa: permissão', e);
        partes = cartaoFerramenta(cartao);
      }
      const [icone, titulo, chip, corpo, extra, botoes] = partes;
      ui.perm.dataset.tipo = tipo;
      ui.perm.replaceChildren(
        h('div', { class: 'cv-perm-cab' }, ico(icone, 14), h('strong', { id: idDe('cv-perm-t') }, titulo), cartao.fila,
          chip ? h('span', { class: 'cv-ferr-nome', title: chip }, chip) : null),
        corpo && corpo.childNodes.length ? corpo : null,
        ...(extra || []),
        cartao.erro,
        botoes);
      ui.perm.hidden = false;
      ui.perm.scrollTop = 0;
      anunciar(tipo === 'pergunta' ? 'O agente fez uma pergunta.' : tipo === 'plano' ? 'O agente terminou o plano e pede sua aprovação.' : 'A sessão pede permissão para usar ' + String(p.ferramenta || 'uma ferramenta') + '.');
    }
    // Envia a resposta; `botao` mostra "Enviando…". 404/409 = alguém respondeu antes.
    async function responderPermissao(cartao, corpo, botao, aviso) {
      const { p, id, gen } = cartao;
      if (gen !== st.gen || ui.perm._id !== p.id) return;
      const controles = [...ui.perm.querySelectorAll('button, input, textarea')];
      for (const x of controles) x.disabled = true;
      ui.perm.setAttribute('aria-busy', 'true');
      cartao.erro.hidden = true;
      if (botao && botao._rot) txt(botao._rot, 'Enviando…');
      const destravar = () => {
        for (const x of controles) x.disabled = false;
        ui.perm.removeAttribute('aria-busy');
        if (botao && botao._rot) txt(botao._rot, botao._txt);
        if (cartao.validar) cartao.validar();
      };
      try {
        await pedir(rotaSessao(id, 'permissao'), { id: p.id, ...corpo });
        if (gen !== st.gen) return;
        st.permResp = p.id;
        ui.perm.removeAttribute('aria-busy');
        anunciar(aviso);
        const tinhaFoco = ui.perm.contains(document.activeElement);
        renderPermissao();
        if (tinhaFoco) ui.texto.focus();
      } catch (e) {
        if (gen !== st.gen) return;
        if (e.status === 404 || e.status === 409) {
          st.permResp = p.id;
          ui.perm.removeAttribute('aria-busy');
          anunciar('Esse pedido já foi respondido.');
          mostrarMotivo('Esse pedido já foi respondido.');
          renderPermissao();
          return;
        }
        destravar();
        txt(cartao.erro, 'Não deu para responder: ' + e.message);
        cartao.erro.hidden = false;
      }
    }
    // Campo de texto que abre sob demanda (motivo da negativa, comentário do plano).
    function campoOpcional(cartao, rotulo, placeholder, multilinha) {
      const campo = multilinha
        ? h('textarea', { class: 'cv-perm-txt', rows: 2, maxlength: 2000, placeholder, 'aria-label': rotulo, spellcheck: 'true' })
        : h('input', { class: 'ctx-foco cv-perm-txt', type: 'text', maxlength: 2000, placeholder, 'aria-label': rotulo, spellcheck: 'true', autocomplete: 'off' });
      const caixa = h('div', { class: 'cv-perm-campo', hidden: true }, campo);
      return { caixa, campo, aberto: () => !caixa.hidden, valor: () => (caixa.hidden ? '' : campo.value.trim().slice(0, 2000)) };
    }

    // Ferramenta: resumo, entrada recolhível, Permitir, uma opção por sugestão, Negar com motivo opcional.
    function cartaoFerramenta(cartao) {
      const { p } = cartao;
      let entrada = '';
      try { entrada = p.entrada == null ? '' : typeof p.entrada === 'string' ? p.entrada : JSON.stringify(p.entrada, null, 2); } catch {}
      const corpo = h('div', { class: 'cv-perm-corpo' },
        p.resumo ? h('p', { class: 'cv-perm-resumo', title: String(p.resumo) }, String(p.resumo)) : null,
        entrada ? h('details', { class: 'cv-perm-det' }, h('summary', null, 'Ver a entrada completa'), h('pre', null, entrada)) : null);
      const sugs = sugestoesDe(p).map((s) => {
        const b = btPerm('contorno cv-perm-sug', 'check', String(s.rotulo));
        b.title = String(s.rotulo);
        b.addEventListener('click', () => responderPermissao(cartao, { decisao: 'permitir', sugestao: s.indice }, b, 'Permitido: ' + String(s.rotulo) + '.'));
        if (!s.libera) return b;
        // Regra de terminal ampliada pelo servidor: o que ela libera fica escrito embaixo do botão.
        const id = 'cv-lib-' + PRE + String(p.id).replace(/[^\w-]/g, '_') + '-' + s.indice;
        b.setAttribute('aria-describedby', id);
        return h('div', { class: 'cv-perm-sug-item' }, b, h('p', { class: 'cv-perm-libera', id }, String(s.libera)));
      });
      const motivo = campoOpcional(cartao, 'Motivo da negativa (opcional)', 'Motivo (opcional): o agente recebe este texto');
      const comMotivo = h('button', { type: 'button', class: 'link cv-perm-link', 'aria-expanded': 'false' }, 'Negar com motivo…');
      const negar = btPerm('contorno', 'x', 'Negar');
      const permitir = btPerm('cv-primario', 'check', 'Permitir');
      const enviarNegar = () => {
        const m = motivo.valor();
        responderPermissao(cartao, m ? { decisao: 'negar', mensagem: m } : { decisao: 'negar' }, negar, m ? 'Negado, com o motivo.' : 'Negado.');
      };
      comMotivo.addEventListener('click', () => {
        const abrir = motivo.caixa.hidden;
        motivo.caixa.hidden = !abrir;
        comMotivo.setAttribute('aria-expanded', String(abrir));
        txt(comMotivo, abrir ? 'Sem motivo' : 'Negar com motivo…');
        negar._txt = abrir ? 'Negar com o motivo' : 'Negar';
        txt(negar._rot, negar._txt);
        if (abrir) motivo.campo.focus(); else { motivo.campo.value = ''; negar.focus(); }
      });
      motivo.campo.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); enviarNegar(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); comMotivo.click(); }
      });
      negar.addEventListener('click', enviarNegar);
      permitir.addEventListener('click', () => responderPermissao(cartao, { decisao: 'permitir' }, permitir, 'Permitido.'));
      const extra = [];
      if (sugs.length) extra.push(h('div', { class: 'cv-perm-sugs', role: 'group', 'aria-label': 'Permitir com uma regra' }, ...sugs));
      extra.push(motivo.caixa);
      const botoes = h('div', { class: 'cv-perm-b' }, comMotivo, h('span', { class: 'cv-esp' }), negar, permitir);
      return ['cadeado', 'Permissão pedida', String(p.ferramenta || 'Ferramenta'), corpo, extra, botoes];
    }

    // Pergunta (AskUserQuestion): um bloco por pergunta, opções como botões (caixas na múltipla) e "Outra resposta".
    function cartaoPergunta(cartao) {
      const { p } = cartao;
      const perguntas = (Array.isArray(p.perguntas) ? p.perguntas : []).filter((q) => q && String(q.pergunta || '').trim());
      if (!perguntas.length) return cartaoFerramenta(cartao);
      const nome = 'cv-q-' + PRE + String(p.id).replace(/[^\w-]/g, '_');
      const estado = perguntas.map(() => ({ sel: new Set(), outra: false }));
      const corpo = h('div', { class: 'cv-perm-corpo' });
      const responder = btPerm('cv-primario', 'check', 'Responder');
      const pular = btPerm('contorno', 'x', 'Não responder');
      const livres = [];
      perguntas.forEach((q, qi) => {
        const multipla = !!q.multipla;
        const tituloId = nome + '-' + qi + '-t';
        const opcoes = (Array.isArray(q.opcoes) ? q.opcoes : []).filter((o) => o && String(o.rotulo || '').trim());
        const ops = h('div', { class: 'cv-q-ops', role: multipla ? 'group' : 'radiogroup', 'aria-labelledby': tituloId });
        const livre = h('input', { class: 'ctx-foco cv-q-livre', type: 'text', maxlength: 2000, placeholder: 'Escreva a sua resposta', 'aria-label': 'Outra resposta para: ' + String(q.pergunta), autocomplete: 'off', spellcheck: 'true', hidden: true });
        livres[qi] = livre;
        const opcao = (rotulo, descricao, chave) => {
          const input = h('input', { type: multipla ? 'checkbox' : 'radio', name: nome + '-' + qi, class: multipla ? 'cv-op-caixa' : 'cv-sr', value: String(chave) });
          const lab = h('label', { class: 'cv-op' + (chave === 'outra' ? ' cv-op-outra' : '') }, input,
            h('span', { class: 'cv-op-txt' }, h('span', { class: 'cv-op-rot' }, rotulo), descricao ? h('span', { class: 'cv-op-desc' }, descricao) : null));
          input.addEventListener('change', () => {
            const e = estado[qi];
            if (!multipla) { e.sel.clear(); e.outra = false; }
            if (chave === 'outra') e.outra = input.checked;
            else if (input.checked) e.sel.add(chave); else e.sel.delete(chave);
            for (const l of ops.querySelectorAll('.cv-op')) l.classList.toggle('cv-marcada', l.firstChild.checked);
            livre.hidden = !e.outra;
            if (e.outra && chave === 'outra') livre.focus();
            validar();
          });
          return lab;
        };
        opcoes.forEach((o, oi) => ops.append(opcao(String(o.rotulo), o.descricao ? String(o.descricao) : '', oi)));
        ops.append(opcao('Outra resposta', '', 'outra'));
        livre.addEventListener('input', validar);
        livre.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); responder.click(); } });
        corpo.append(h('div', { class: 'cv-q', role: 'group', 'aria-labelledby': tituloId },
          h('div', { class: 'cv-q-cab' },
            q.cabecalho ? h('span', { class: 'cv-q-tag' }, String(q.cabecalho)) : null,
            multipla ? h('span', { class: 'cv-q-dica' }, 'Escolha uma ou mais') : null),
          h('p', { class: 'cv-q-txt', id: tituloId }, String(q.pergunta)),
          ops, livre));
      });
      // Resposta de cada pergunta: rótulo, texto livre ou (na múltipla) os rótulos unidos por ", ".
      function respostas() {
        const r = {};
        let faltam = 0;
        perguntas.forEach((q, qi) => {
          const e = estado[qi];
          const opcoes = (Array.isArray(q.opcoes) ? q.opcoes : []).filter((o) => o && String(o.rotulo || '').trim());
          const partes = [...e.sel].sort((a, b) => a - b).map((i) => String(opcoes[i].rotulo));
          const livre = e.outra ? livres[qi].value.trim() : '';
          if (livre) partes.push(livre);
          if (!partes.length) { faltam++; return; }
          r[String(q.pergunta)] = q.multipla ? partes.join(', ') : partes[0];
        });
        return { r, faltam };
      }
      function validar() {
        const { faltam } = respostas();
        const motivo = !faltam ? '' : perguntas.length === 1 ? 'Escolha uma resposta primeiro.' : faltam === 1 ? 'Falta responder 1 pergunta.' : 'Faltam ' + faltam + ' perguntas.';
        responder.setAttribute('aria-disabled', motivo ? 'true' : 'false');
        responder._motivo = motivo;
        if (motivo) responder.title = motivo; else responder.removeAttribute('title');
      }
      cartao.validar = validar;
      validar();
      responder.addEventListener('click', () => {
        if (responder.getAttribute('aria-disabled') === 'true') { txt(cartao.erro, responder._motivo); cartao.erro.hidden = false; return; }
        const { r } = respostas();
        responderPermissao(cartao, { decisao: 'permitir', respostas: r }, responder, 'Resposta enviada.');
      });
      pular.addEventListener('click', () => responderPermissao(cartao, { decisao: 'negar' }, pular, 'Pergunta recusada.'));
      const titulo = perguntas.length > 1 ? 'O agente tem ' + perguntas.length + ' perguntas' : 'Pergunta do agente';
      const botoes = h('div', { class: 'cv-perm-b' }, h('span', { class: 'cv-esp' }), pular, responder);
      return ['ajuda', titulo, null, corpo, [], botoes];
    }

    // Plano (ExitPlanMode): markdown, Aprovar, "Aprovar e aceitar edições" e "Continuar planejando" com comentário.
    function cartaoPlano(cartao) {
      const { p } = cartao;
      let plano = typeof p.plano === 'string' ? p.plano : '';
      if (!plano && p.entrada && typeof p.entrada.plan === 'string') plano = p.entrada.plan;
      const md = h('div', { class: 'cv-plano md' });
      try { md.append(api.md(plano || '_O agente não mandou o texto do plano._')); } catch { md.textContent = plano; }
      const corpo = h('div', { class: 'cv-perm-corpo' }, md);
      const sugs = sugestoesDe(p);
      const aceitar = sugs.find(ehAceitarEdicoes);
      const outras = sugs.filter((s) => s !== aceitar).map((s) => {
        const b = btPerm('contorno cv-perm-sug', 'check', String(s.rotulo));
        b.title = String(s.rotulo);
        b.addEventListener('click', () => responderPermissao(cartao, { decisao: 'permitir', sugestao: s.indice }, b, 'Plano aprovado: ' + String(s.rotulo) + '.'));
        return b;
      });
      const comentario = campoOpcional(cartao, 'Comentário sobre o plano (opcional)', 'O que mudar no plano (opcional): o agente recebe este texto', true);
      const continuar = btPerm('contorno', 'lapis', 'Continuar planejando', { 'aria-expanded': 'false' });
      const aprovar = btPerm('cv-primario', 'check', 'Aprovar');
      let aprovarEd = null;
      if (aceitar) {
        aprovarEd = btPerm('contorno', 'check', 'Aprovar e aceitar edições');
        aprovarEd.title = String(aceitar.rotulo);
        aprovarEd.addEventListener('click', () => responderPermissao(cartao, { decisao: 'permitir', sugestao: aceitar.indice }, aprovarEd, 'Plano aprovado; edições aceitas sem perguntar.'));
      }
      const fecharComentario = () => {
        comentario.caixa.hidden = true;
        comentario.campo.value = '';
        continuar.setAttribute('aria-expanded', 'false');
        continuar._txt = 'Continuar planejando';
        txt(continuar._rot, continuar._txt);
      };
      const enviarComentario = () => {
        const m = comentario.valor();
        responderPermissao(cartao, m ? { decisao: 'negar', mensagem: m } : { decisao: 'negar' }, continuar, 'O agente continua planejando.');
      };
      continuar.addEventListener('click', () => {
        if (comentario.caixa.hidden) {
          comentario.caixa.hidden = false;
          continuar.setAttribute('aria-expanded', 'true');
          continuar._txt = 'Enviar e continuar planejando';
          txt(continuar._rot, continuar._txt);
          comentario.campo.focus();
          return;
        }
        enviarComentario();
      });
      comentario.campo.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); enviarComentario(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fecharComentario(); continuar.focus(); }
      });
      aprovar.addEventListener('click', () => responderPermissao(cartao, { decisao: 'permitir' }, aprovar, 'Plano aprovado.'));
      const extra = [];
      if (outras.length) extra.push(h('div', { class: 'cv-perm-sugs', role: 'group', 'aria-label': 'Aprovar com uma regra' }, ...outras));
      extra.push(comentario.caixa);
      const botoes = h('div', { class: 'cv-perm-b' }, continuar, h('span', { class: 'cv-esp' }), aprovarEd, aprovar);
      return ['lista', 'Plano para aprovar', null, corpo, extra, botoes];
    }

    // ───────────────────────────── comandos com barra ─────────────────────────────
    // Só valem numa instância do Orbit (viva ou dormindo): é ela que lê a mensagem como entrada do Claude Code.
    // Pelo canal a mensagem chega como texto de outra sessão, e o comando não roda.
    // [argumentos, descrição]. Os do Orbit rodam com as ações dele (confirmação, progresso, seletores).
    const CMD_ORBIT = {
      clear: ['', 'Limpa a conversa e recomeça o contexto (pede confirmação)'],
      compact: ['[foco]', 'Resume a conversa para liberar contexto; o texto depois vira o foco'],
      model: ['[modelo]', 'Troca o modelo desta sessão'],
      effort: ['[low|medium|high|xhigh|max]', 'Troca o nível de esforço desta sessão'],
      help: ['', 'Mostra os comandos disponíveis'],
    };
    // Do Claude Code que respondem neste modo (testados na 2.1.300); a saída aparece na conversa.
    const CMD_CLAUDE = {
      context: ['', 'Mostra quanto do contexto está em uso'],
      usage: ['', 'Mostra o uso do plano e os limites'],
      rename: ['[nome]', 'Renomeia a conversa'],
      recap: ['', 'Resume a sessão em uma linha'],
      goal: ['[condição]', 'Define uma meta: o agente segue até cumpri-la'],
      init: ['', 'Cria o CLAUDE.md com a documentação do projeto'],
      advisor: ['[fable|opus|sonnet|off]', 'Consulta um modelo mais forte nos momentos-chave'],
      autocompact: ['[auto|tokens]', 'Ajusta quando a compactação automática acontece'],
      'output-style': ['[estilo]', 'Lista ou troca o estilo das respostas'],
      config: ['chave=valor', 'Muda uma configuração do Claude Code'],
      mcp: ['[reconnect|enable|disable]', 'Resumo e controle dos servidores MCP'],
      'reload-skills': ['', 'Recarrega as skills do disco'],
      'reload-plugins': ['', 'Ativa as mudanças pendentes de plugins'],
      'skill-doctor': ['', 'Mostra as skills carregadas e as que não são usadas'],
    };
    // Não respondem sem o terminal (/status, /focus, /fast…), foram removidos ou são internos.
    const CMD_FORA = new Set(['status', 'focus', 'fast', 'agents', 'color', 'heapdump', 'extra-usage', 'ultrareview', '__remote-workflow', 'workflow-launch-exec', 'auto-mode-setup']);
    const CMD_RECARGA = 5 * 60e3;
    const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    function descCurta(d) {
      const t = String(d || '').replace(/\s+/g, ' ').trim();
      const f = (/^(.{12,}?[.!?])\s/.exec(t) || [, t])[1];
      return f.length > 96 ? f.slice(0, 95).trimEnd() + '…' : f;
    }
    function comandosValem() { return !!st.id && !!st.controle && modoAtual() === 'orbit'; }
    function carregarComandos() {
      const id = st.id;
      const ent = st.cmds.get(id);
      if (!id || st.cmdsCarga.has(id) || (ent && Date.now() - ent.em < (ent.lista ? CMD_RECARGA : 15e3))) return;
      st.cmdsCarga.add(id);
      pedir(rotaSessao(id, 'comandos'))
        .then((d) => st.cmds.set(id, { lista: Array.isArray(d.comandos) ? d.comandos.filter((c) => c && typeof c.nome === 'string' && c.nome) : null, em: Date.now() }))
        .catch(() => st.cmds.set(id, { lista: null, em: Date.now() })) // servidor sem a rota: só o catálogo
        .finally(() => { st.cmdsCarga.delete(id); if (id === st.id && !ui.cmds.hidden) { st.menu.sig = ''; atualizarMenu(); } });
    }
    // Orbit, depois os do Claude Code (os da lista do processo, quando ela veio), depois skills e plugins.
    function listaComandos() {
      const ent = st.cmds.get(st.id);
      const srv = ent && ent.lista;
      const tem = srv ? new Set(srv.map((c) => c.nome)) : null;
      const out = [];
      for (const [nome, [args, desc]] of Object.entries(CMD_ORBIT)) out.push({ nome, args, desc, grupo: 0 });
      for (const [nome, [args, desc]] of Object.entries(CMD_CLAUDE)) if (!tem || tem.has(nome)) out.push({ nome, args, desc, grupo: 0 });
      if (srv) {
        const ja = new Set(out.map((c) => c.nome));
        srv.filter((c) => !ja.has(c.nome) && !CMD_FORA.has(c.nome)).sort((a, b) => a.nome.localeCompare(b.nome))
          .forEach((c) => out.push({ nome: c.nome, args: String(c.args || ''), desc: descCurta(c.descricao), grupo: 1 }));
      }
      return out;
    }
    function filtrarComandos(q) {
      const l = listaComandos();
      if (!q) return l;
      const a = q.toLowerCase();
      const sa = semAcento(q);
      const nota = (c) => {
        const n = c.nome.toLowerCase();
        const dp = n.indexOf(':');
        if (n.startsWith(a) || (dp >= 0 && n.slice(dp + 1).startsWith(a))) return 0;
        if (n.includes(a)) return 1;
        if (sa.length >= 3 && semAcento(c.desc).includes(sa)) return 2;
        return -1;
      };
      return l.map((c, i) => ({ c, i, n: nota(c) })).filter((x) => x.n >= 0).sort((x, y) => x.c.grupo - y.c.grupo || x.n - y.n || x.i - y.i).map((x) => x.c);
    }
    function atualizarMenu() {
      const v = ui.texto.value;
      if (v[0] !== '/') st.menu.dispensado = null;
      if (!comandosValem() || !/^\/\S*$/.test(v) || v === st.menu.dispensado || document.activeElement !== ui.texto) { fecharMenu(); return; }
      carregarComandos();
      const q = v.slice(1);
      const itens = filtrarComandos(q);
      const ent = st.cmds.get(st.id);
      const sig = JSON.stringify([q, itens.length, ent ? ent.em : 0, st.cmdsCarga.has(st.id)]);
      if (sig === st.menu.sig && !ui.cmds.hidden) return;
      st.menu.sig = sig;
      const antes = st.menu.itens[st.menu.ativo];
      st.menu.itens = itens;
      const frag = [];
      const titulos = itens.some((x) => x.grupo === 1);
      let grupo = -1;
      itens.forEach((c, i) => {
        if (titulos && c.grupo !== grupo) frag.push(h('div', { class: 'cv-cmds-tit', role: 'presentation' }, c.grupo ? 'Skills e plugins' : 'Comandos'));
        grupo = c.grupo;
        const nome = h('span', { class: 'cv-cmd-nome' }, '/');
        const n = c.nome;
        const k = q && n.toLowerCase().startsWith(q.toLowerCase()) ? q.length : 0;
        if (k) nome.append(h('b', null, n.slice(0, k)), n.slice(k)); else nome.append(n);
        frag.push(h('div', { class: 'cv-cmd', role: 'option', id: 'cv-cmd-' + PRE + i, 'data-i': i, 'aria-selected': 'false' },
          h('span', { class: 'cv-cmd-cab' }, nome, c.args ? h('span', { class: 'cv-cmd-args' }, c.args) : null),
          c.desc ? h('span', { class: 'cv-cmd-desc' }, c.desc) : null));
      });
      if (!itens.length) frag.push(h('div', { class: 'cv-cmds-vazio', role: 'presentation' }, 'Nenhum comando com "' + q + '" · envia como texto'));
      else if (st.cmdsCarga.has(st.id) && !ent) frag.push(h('div', { class: 'cv-cmds-vazio', role: 'presentation' }, 'Carregando os comandos do projeto…'));
      ui.cmds.replaceChildren(...frag);
      ui.cmds.hidden = false;
      ui.texto.setAttribute('aria-expanded', 'true');
      const manter = antes ? itens.findIndex((c) => c.nome === antes.nome) : -1;
      marcarComando(itens.length ? Math.max(0, manter) : -1, true);
    }
    function fecharMenu() {
      if (!ui.cmds || ui.cmds.hidden) return;
      ui.cmds.hidden = true;
      st.menu.ativo = -1;
      st.menu.sig = '';
      ui.texto.setAttribute('aria-expanded', 'false');
      ui.texto.removeAttribute('aria-activedescendant');
    }
    function marcarComando(i, rolar) {
      const ant = ui.cmds.querySelector('.cv-cmd[aria-selected="true"]');
      if (ant) ant.setAttribute('aria-selected', 'false');
      st.menu.ativo = i;
      const el = i >= 0 ? ui.cmds.querySelector('#cv-cmd-' + PRE + i) : null;
      if (!el) { ui.texto.removeAttribute('aria-activedescendant'); return; }
      el.setAttribute('aria-selected', 'true');
      ui.texto.setAttribute('aria-activedescendant', el.id);
      if (rolar) el.scrollIntoView({ block: 'nearest' });
    }
    // Tab completa; Enter (ou clique) roda o comando sem argumentos e completa o que pede argumentos.
    function escolherComando(i, via) {
      const c = st.menu.itens[i];
      if (!c) return;
      const completar = via === 'tab' || !!c.args;
      ui.texto.value = '/' + c.nome + (completar ? ' ' : '');
      if (st.id) st.rascunhos.set(st.id, ui.texto.value);
      ajustarAltura();
      atualizarEnvio();
      fecharMenu();
      ui.texto.focus();
      const fim = ui.texto.value.length;
      ui.texto.setSelectionRange(fim, fim);
      if (!completar) enviar(ui.texto.value);
    }
    function teclaMenu(e) {
      if (!ui.cmds || ui.cmds.hidden || e.isComposing) return false;
      const n = st.menu.itens.length;
      const k = e.key;
      if ((k === 'ArrowDown' || k === 'ArrowUp') && n && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        marcarComando((st.menu.ativo + (k === 'ArrowDown' ? 1 : -1) + n) % n, true);
        return true;
      }
      if (((k === 'Enter' && !e.shiftKey && !e.altKey) || (k === 'Tab' && !e.shiftKey)) && st.menu.ativo >= 0) {
        e.preventDefault();
        e.stopPropagation();
        escolherComando(st.menu.ativo, k === 'Tab' ? 'tab' : 'enter');
        return true;
      }
      if (k === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        st.menu.dispensado = ui.texto.value;
        fecharMenu();
        return true;
      }
      return false;
    }
    function acharModelo(arg) {
      const l = st.modelos || [];
      const a = arg.toLowerCase();
      const nome = (m) => String(m.nome || '').toLowerCase();
      return l.find((m) => m.valor.toLowerCase() === a) || l.find((m) => nome(m) === a)
        || l.find((m) => m.valor !== 'default' && baseModelo(m.modelo) === baseModelo(a))
        || l.find((m) => m.valor !== 'default' && nome(m).startsWith(a)) || null;
    }
    // true = o Orbit tratou (ou explicou por que não dá); false = vai ao processo como mensagem.
    async function comandoDoOrbit(texto) {
      const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(texto);
      if (!m) return false;
      const nome = m[1].toLowerCase();
      const arg = (m[2] || '').trim();
      const esvaziar = () => { ui.texto.value = ''; if (st.id) st.rascunhos.delete(st.id); ajustarAltura(); atualizarEnvio(); };
      const r = regras();
      if (nome === 'help') {
        ui.texto.value = '/';
        st.menu.dispensado = null;
        ajustarAltura();
        atualizarEnvio();
        ui.texto.focus();
        atualizarMenu();
        return true;
      }
      if (nome === 'clear') {
        if (r.limpar) { mostrarMotivo(r.limpar); return true; }
        if (await limpar()) esvaziar();
        return true;
      }
      if (nome === 'compact') {
        if (r.compactar) { mostrarMotivo(r.compactar); return true; }
        const foco = arg.replace(/\s+/g, ' ');
        if (foco.length > 500) { mostrarMotivo('O foco da compactação passa de 500 caracteres.'); return true; }
        esvaziar();
        acionar('compactar', foco ? { foco } : {});
        return true;
      }
      if ((nome === 'model' || nome === 'effort') && typeof api.modelos === 'function') {
        // Sem argumento, abre o menu do modelo (no /effort, já com o foco no esforço).
        if (!arg) { esvaziar(); abrirPop('modelo', nome === 'effort' ? 'esforco' : ''); return true; }
        if (st.ajPend) { mostrarMotivo('Espere a troca anterior terminar.'); return true; }
        const l = st.modelos || [];
        if (!l.length) { mostrarMotivo(st.modelosErro || 'A lista de modelos ainda está carregando; tente de novo em instantes.'); return true; }
        if (nome === 'model') {
          const alvo = acharModelo(arg);
          if (!alvo) { mostrarMotivo('Não achei o modelo "' + arg + '". Use: ' + l.filter((x) => x.valor !== 'default').map((x) => x.valor).join(', ') + '.'); return true; }
          esvaziar();
          trocarAjuste('modelo', alvo.valor);
          return true;
        }
        const atual = opcaoModelo(valorAjustes().modelo);
        const niveis = atual && Array.isArray(atual.esforcos) ? atual.esforcos.filter((x) => typeof x === 'string') : [];
        const n = arg.toLowerCase();
        if (!niveis.includes(n)) {
          mostrarMotivo(!atual ? 'Não sei o modelo atual para conferir os níveis de esforço.' : !niveis.length ? (atual.nome || atual.valor) + ' não tem nível de esforço.' : 'Esforço "' + arg + '" não existe para ' + (atual.nome || atual.valor) + '. Use: ' + niveis.join(', ') + '.');
          return true;
        }
        esvaziar();
        trocarAjuste('esforco', n);
        return true;
      }
      return false;
    }

    // ───────────────────────────── mensagens ─────────────────────────────
    async function enviar(bruto) {
      const r = regras();
      if (r.envio) { mostrarMotivo(r.envio); return; }
      const texto = String(bruto || '').replace(/\s+$/, '').replace(/^\s*\n/, '');
      const nImg = nImagens();
      if (!texto.trim() && !nImg) return;
      if (texto.length > 20000) { mostrarMotivo('A mensagem passa de 20 000 caracteres.'); return; }
      if (nImg) {
        const m = motivoImagens(r) || (texto.trim()[0] === '/' ? 'Comandos com barra não levam imagens. Tire as imagens ou escreva sem a barra.' : null);
        if (m) { mostrarMotivo(m); return; }
      }
      fecharMenu();
      // /clear, /compact, /model, /effort e /help viram as ações do próprio Orbit; o resto vai ao processo.
      if (comandosValem() && texto.trim()[0] === '/' && (await comandoDoOrbit(texto.trim()))) return;
      const sessao = st.id;
      const local = { id: 'local-' + ++st.seqLocal, ts: Date.now(), tipo: r.modo === 'canal' ? 'par' : 'usuario', texto, local: true, estado: 'em_andamento', etapa: 'Enviando', via: r.modo };
      if (nImg) {
        // As miniaturas passam para a bolha otimista (as URLs blob: são soltas quando ela sai); o base64 fica para o
        // "Tentar de novo".
        local.imagens = ui.ax.miniaturas();
        local.envio = ui.ax.lista();
        ui.ax.entregar();
      }
      ui.texto.value = '';
      st.rascunhos.delete(sessao);
      ajustarAltura();
      atualizarEnvio();
      adicionar([local]);
      rolarFim();
      await postarLocal(local, sessao);
    }
    async function postarLocal(local, sessao) {
      st.enviando++;
      atualizarEnvio();
      try {
        const d = await pedir(rotaSessao(sessao, 'mensagem'), local.envio ? { texto: local.texto, imagens: local.envio } : { texto: local.texto }).finally(() => { st.enviando = Math.max(0, st.enviando - 1); atualizarEnvio(); });
        const a = d && d.acao;
        if (!a || !a.id) throw new Error('O servidor não devolveu a ação.');
        local.acao = a.id;
        st.minhas.set(a.id, { sessao, tipo: 'mensagem' });
        const ac = guardarAcao(a);
        if (st.id === sessao) { aplicarAcaoLocal(local, ac); faixaRetomada(ac); }
      } catch (e) {
        if (st.id !== sessao) return;
        aplicarAcaoLocal(local, { estado: 'erro', erro: e.message, codigo: e.codigo });
      }
    }
    function aplicarAcaoLocal(local, a) {
      const antes = local.estado;
      local.estado = a.estado;
      local.etapa = a.etapa || '';
      local.erro = a.erro || '';
      local.codigo = a.codigo || '';
      atualizarNo(local);
      if (antes !== a.estado) {
        if (a.estado === 'sucesso') anunciar('Mensagem entregue.');
        else if (a.estado === 'erro') anunciar('Mensagem não entregue: ' + (a.erro || 'erro sem detalhe'));
      }
    }
    function tentarDeNovo(local) {
      if (regras().envio) { mostrarMotivo(regras().envio); return; }
      local.estado = 'em_andamento';
      local.etapa = 'Enviando';
      local.erro = '';
      local.acao = null;
      atualizarNo(local);
      postarLocal(local, st.id);
    }
    function descartar(local) {
      remover(local.id);
      ui.texto.focus();
    }
    const normal = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    function casarLocal(it) {
      const alvo = normal(it.texto);
      const n = (it.imagens || []).length;
      if (!alvo && !n) return;
      const l = st.itens.find((x) => x.local && x.estado !== 'erro' && (x.imagens || []).length === n
        && (alvo ? normal(x.texto) === alvo || alvo.includes(normal(x.texto)) : !normal(x.texto)));
      if (l) remover(l.id);
    }
    // As miniaturas da bolha otimista são URLs blob: (cópias na memória): saem com ela.
    function soltarLocais(lista) {
      if (!window.Anexos) return;
      for (const x of lista) if (x.local && x.imagens) window.Anexos.soltar(x.imagens);
    }

    // ───────────────────────────── lista ─────────────────────────────
    function pertoDoFim() { const l = ui.lista; return l.scrollHeight - l.scrollTop - l.clientHeight < PERTO; }
    function rolarFim(suave) {
      const l = ui.lista;
      if (suave && !reduzido()) l.scrollTo({ top: l.scrollHeight, behavior: 'smooth' });
      else l.scrollTop = l.scrollHeight;
      st.novas = 0;
      ui.novas.hidden = true;
    }
    function aoRolar() {
      if (!ui.novas.hidden && pertoDoFim()) { st.novas = 0; ui.novas.hidden = true; }
    }
    const contaComoNova = (it) => it.tipo === 'assistente' || it.tipo === 'usuario' || it.tipo === 'par' || it.tipo === 'erro' || it.tipo === 'compactacao' || it.tipo === 'limpeza';

    function receberItens(lista, silencioso) {
      if (!Array.isArray(lista) || !lista.length) return;
      const fim = pertoDoFim();
      const novos = [];
      for (const it of lista) {
        if (!it || it.id == null || typeof it !== 'object') continue;
        const id = String(it.id);
        const ex = st.porId.get(id);
        if (ex) {
          const i = st.itens.indexOf(ex);
          if (i >= 0) st.itens[i] = it;
          st.porId.set(id, it);
          atualizarNo(it);
          continue;
        }
        if (it.tipo === 'usuario' || it.tipo === 'par' || it.tipo === 'comando') casarLocal(it); // comando com barra: o eco é a linha do comando
        novos.push(it);
      }
      if (novos.length) {
        adicionar(novos);
        if (!fim && !silencioso && novos.some(contaComoNova)) { st.novas += novos.filter(contaComoNova).length; ui.novas.hidden = false; }
      }
      if (fim) rolarFim();
      podar();
    }
    // Acrescenta no fim, mantendo a cauda em ordem: itens do transcript, depois o parcial ao vivo (etapa 3),
    // depois os otimistas (locais). Um item que chega atrasado entra antes do parcial que está sendo escrito.
    const camada = (x) => (x.local ? 2 : x.parcial && !x.incompleta ? 1 : 0);
    function adicionar(itens) {
      for (const it of itens) {
        const c = camada(it);
        let i = st.itens.length;
        while (i > st.ini && camada(st.itens[i - 1]) > c) i--;
        st.itens.splice(i, 0, it);
        st.porId.set(String(it.id), it);
        const n = noItem(it);
        st.nos.set(String(it.id), n);
        const depois = st.itens[i + 1] ? st.nos.get(String(st.itens[i + 1].id)) : null;
        if (depois && depois.parentNode === ui.itens) ui.itens.insertBefore(n, depois);
        else ui.itens.append(n);
      }
      mostrarVazio();
      atualizarTopo();
    }

    // ───────────────────────────── texto ao vivo (etapa 3) ─────────────────────────────
    // `event: parcial {id, texto}`: `texto` é o acumulado da resposta. O item `assistente` final, com o mesmo id,
    // substitui o parcial pelo caminho normal (receberItens → atualizarNo), no mesmo lugar.
    function receberParcial(d) {
      if (!d || d.id == null) return;
      const id = String(d.id);
      const texto = typeof d.texto === 'string' ? d.texto : '';
      const ex = st.porId.get(id);
      if (ex) {
        if (!ex.parcial) return; // o item final já chegou; parcial atrasado não volta atrás
        if (ex.texto === texto && !ex.incompleta) return;
        ex.texto = texto;
        if (ex.incompleta) { ex.incompleta = false; atualizarNo(ex); return; }
        st.parcPend.add(id);
        if (!st.parcRaf) st.parcRaf = requestAnimationFrame(aplicarParciais);
        return;
      }
      receberItens([{ id: d.id, ts: Date.now(), tipo: 'assistente', texto, parcial: true }]);
    }
    // Um quadro por vez: só troca o conteúdo do markdown (o nó do item fica), e a rolagem segue a regra da lista.
    function aplicarParciais() {
      st.parcRaf = 0;
      if (!st.parcPend.size) return;
      const fim = pertoDoFim();
      for (const id of st.parcPend) {
        const it = st.porId.get(id);
        const n = st.nos.get(id);
        if (it && it.parcial && n && n._md) preencherMd(n._md, it.texto);
      }
      st.parcPend.clear();
      if (fim) rolarFim();
    }
    function preencherMd(el, texto) {
      try { el.replaceChildren(api.md(String(texto || ''))); } catch { el.textContent = String(texto || ''); }
    }
    function marcarIncompletos() {
      if (st.controle && st.controle.ocupada) return;
      const fim = pertoDoFim();
      let algum = false;
      for (const it of st.itens) if (it.parcial && !it.incompleta) { it.incompleta = true; atualizarNo(it); algum = true; }
      if (algum && fim) rolarFim();
    }
    function limparParciais() {
      clearTimeout(st.parcTimer);
      if (st.parcRaf) cancelAnimationFrame(st.parcRaf);
      st.parcRaf = 0;
      st.parcPend.clear();
    }
    function remover(id) {
      id = String(id);
      const it = st.porId.get(id);
      if (!it) return;
      soltarLocais([it]);
      const i = st.itens.indexOf(it);
      if (i >= 0) { st.itens.splice(i, 1); if (i < st.ini) st.ini--; }
      st.porId.delete(id);
      const n = st.nos.get(id);
      if (n) n.remove();
      st.nos.delete(id);
      mostrarVazio();
    }
    function atualizarNo(it) {
      const id = String(it.id);
      const velho = st.nos.get(id);
      if (!velho) return;
      const novo = noItem(it);
      const tinhaFoco = velho.contains(document.activeElement);
      velho.replaceWith(novo);
      st.nos.set(id, novo);
      if (tinhaFoco) { const b = novo.querySelector('button, summary'); if (b) b.focus({ preventScroll: true }); }
    }
    function renderTudo() {
      st.ini = Math.max(0, st.itens.length - LIMITE);
      st.nos = new Map();
      const frag = document.createDocumentFragment();
      for (let i = st.ini; i < st.itens.length; i++) { const it = st.itens[i]; const n = noItem(it); st.nos.set(String(it.id), n); frag.append(n); }
      ui.itens.replaceChildren(frag);
      mostrarVazio();
      atualizarTopo();
    }
    // Lista longa: com o usuário no fim, os nós mais antigos saem do DOM (os dados ficam).
    function podar() {
      const n = st.itens.length - st.ini;
      if (n <= MAX_NOS || !pertoDoFim()) return;
      const ate = st.itens.length - MANTER;
      for (let i = st.ini; i < ate; i++) {
        const id = String(st.itens[i].id);
        const no = st.nos.get(id);
        if (no) no.remove();
        st.nos.delete(id);
      }
      st.ini = ate;
      atualizarTopo();
      rolarFim();
    }
    function atualizarTopo() {
      const mais = st.ini > 0 || !!st.cursor;
      ui.anteriores.hidden = !mais;
      ui.inicio.hidden = mais || !st.itens.length || st.carregando;
    }
    async function carregarAnteriores() {
      if (ui.anteriores.disabled) return;
      const l = ui.lista;
      const h0 = l.scrollHeight;
      const t0 = l.scrollTop;
      const fixar = () => { const d = l.scrollHeight - h0; if (Math.abs(l.scrollTop - t0) < 1 && d > 0) l.scrollTop = t0 + d; };
      if (st.ini > 0) {
        const novoIni = Math.max(0, st.ini - LIMITE);
        const frag = document.createDocumentFragment();
        for (let i = novoIni; i < st.ini; i++) { const it = st.itens[i]; const n = noItem(it); st.nos.set(String(it.id), n); frag.append(n); }
        ui.itens.prepend(frag);
        st.ini = novoIni;
        fixar();
        atualizarTopo();
        return;
      }
      if (!st.cursor) return;
      const gen = st.gen;
      const id = st.id;
      ui.anteriores.disabled = true;
      txt(ui.anteriores, 'Carregando…');
      try {
        const d = await pedir(rotaSessao(id, 'conversa?antes=' + enc(st.cursor) + '&limite=' + LIMITE));
        if (gen !== st.gen) return;
        const velhos = (Array.isArray(d.itens) ? d.itens : []).filter((it) => it && it.id != null && !st.porId.has(String(it.id)));
        st.cursor = d.cursorAntigo || null;
        for (const it of velhos) st.porId.set(String(it.id), it);
        st.itens.unshift(...velhos);
        const frag = document.createDocumentFragment();
        for (const it of velhos) { const n = noItem(it); st.nos.set(String(it.id), n); frag.append(n); }
        ui.itens.prepend(frag);
        fixar();
      } catch (e) {
        if (gen === st.gen) mostrarMotivo('Não deu para carregar as anteriores. ' + e.message);
      } finally {
        if (gen === st.gen) { ui.anteriores.disabled = false; txt(ui.anteriores, 'Carregar anteriores'); atualizarTopo(); }
      }
    }
    function mostrarVazio(modo) {
      const v = ui.vazio;
      if (modo === 'carregando') {
        v.replaceChildren(ponto('trabalhando', 16), h('p', null, 'Carregando a conversa…'));
        v.hidden = false;
        ui.inicio.hidden = true;
        ui.anteriores.hidden = true;
        return;
      }
      if (modo === 'erro') {
        const tentar = h('button', { type: 'button', class: 'btn p' }, ico('historico', 14), 'Tentar de novo');
        tentar.addEventListener('click', () => abrirInterno(st.id));
        v.replaceChildren(h('p', null, st.erroCarga), tentar);
        v.hidden = false;
        return;
      }
      if (st.carregando) return;
      if (!st.itens.length) {
        v.replaceChildren(h('p', null, 'Nenhuma mensagem nesta conversa ainda.'));
        v.hidden = false;
      } else v.hidden = true;
    }
    function anunciar(t) {
      txt(ui.anuncio, '');
      requestAnimationFrame(() => txt(ui.anuncio, t));
    }
    function ajustarAltura() {
      const t = ui.texto;
      t.style.height = 'auto';
      t.style.height = Math.min(t.scrollHeight + 2, 168) + 'px';
    }

    // ───────────────────────────── itens ─────────────────────────────
    function noItem(it) {
      let el;
      try {
        switch (it.tipo) {
          case 'usuario': case 'par': el = bolha(it); break;
          case 'assistente': el = it.parcial ? parcial(it) : assistente(it); break;
          case 'pensamento': el = pensamento(it); break;
          case 'ferramenta': el = ferramenta(it); break;
          case 'compactacao': {
            const nums = it.pre && it.pos ? ' · ' + fmtK(it.pre) + ' → ' + fmtK(it.pos) : '';
            // 20/10: a compactação automática do Orbit diz que foi sozinha e quando.
            const quando = it.auto && it.ts ? ' às ' + hora(it.ts) : '';
            el = divisor('comprimir', (it.auto ? 'Compactado automaticamente' + quando : 'Contexto compactado') + nums, it.foco ? 'Foco: ' + it.foco : '');
            if (it.auto) el.classList.add('cv-div-auto');
            break;
          }
          case 'limpeza': el = divisor('borracha', 'Conversa limpa', 'O contexto recomeçou daqui'); break;
          case 'interrupcao': el = h('div', { class: 'cv-item cv-nota' }, ico('parar', 12), 'Interrompido pelo usuário'); break;
          case 'comando': el = h('div', { class: 'cv-item cv-comando' }, ico('terminal', 12), h('code', null, String(it.texto || ''))); break;
          case 'saida': el = saida(it); break;
          case 'erro': el = h('div', { class: 'cv-item cv-erro', role: 'note' }, ico('alerta', 13), h('span', null, String(it.texto || 'Erro sem detalhe'))); break;
          default: el = h('div', { class: 'cv-item cv-nota' }, String(it.texto || it.tipo || 'item'));
        }
      } catch (e) {
        console.warn('Conversa: item', e);
        el = h('div', { class: 'cv-item cv-nota' }, 'Item que não deu para mostrar');
      }
      el.dataset.id = String(it.id);
      return el;
    }
    // Imagens da mensagem: as do transcript pelo GET /imagem; as da bolha otimista pelas URLs blob:. Clique amplia.
    function galeria(it) {
      const imgs = (it.imagens || []).map((x) => ({ url: x.url || (x.o != null ? rotaSessao(st.id, 'imagem') + '?o=' + x.o + '&i=' + x.i : '') })).filter((x) => x.url);
      if (!imgs.length) return null;
      const g = h('div', { class: 'ax-galeria' + (imgs.length > 1 ? ' ax-varias' : '') });
      imgs.forEach((x, k) => {
        const b = h('button', { type: 'button', class: 'ax-vista', 'aria-label': 'Ampliar imagem ' + (k + 1) + ' de ' + imgs.length, title: 'Ampliar' });
        const img = h('img', { src: x.url, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
        img.addEventListener('error', () => {
          b.classList.add('ax-falhou');
          b.disabled = true;
          b.removeAttribute('title');
          b.replaceChildren('Imagem indisponível');
        }, { once: true });
        b.append(img);
        b.addEventListener('click', () => { if (window.Anexos) window.Anexos.ampliar(imgs, k); });
        g.append(b);
      });
      return g;
    }
    function bolha(it) {
      const texto = String(it.texto || '');
      const corpo = h('div', { class: 'cv-bolha', hidden: !texto && (it.imagens || []).length ? true : null }, texto);
      const meta = h('div', { class: 'cv-meta' });
      if (it.tipo === 'par') meta.append(h('span', { class: 'cv-tag', title: 'Chegou pelo canal, como mensagem de outra sessão' }, 'pelo canal'));
      if (it.local) {
        if (it.estado === 'em_andamento') meta.append(h('span', { class: 'cv-msg-est' }, ponto('trabalhando', 10), it.etapa || 'Enviando'));
        else if (it.estado === 'sucesso') meta.append(h('span', { class: 'cv-msg-est ok' }, ico('check', 11), 'Entregue'));
        else if (it.estado === 'erro') meta.append(h('span', { class: 'cv-msg-est erro' }, ico('alerta', 11), 'Não entregue'));
      } else if (it.ts) meta.append(h('time', { datetime: new Date(it.ts).toISOString() }, hora(it.ts)));
      const el = h('div', { class: 'cv-item cv-usuario' + (it.tipo === 'par' ? ' cv-par' : '') + (it.local ? ' cv-local' : ''), 'data-estado': it.local ? it.estado : null }, galeria(it), corpo, meta);
      if (it.local && it.estado === 'erro') {
        const tentar = h('button', { type: 'button', class: 'link' }, 'Tentar de novo');
        const fora = h('button', { type: 'button', class: 'link' }, 'Descartar');
        tentar.addEventListener('click', () => tentarDeNovo(it));
        fora.addEventListener('click', () => descartar(it));
        // Sem processo vivo (409 nao_assumida): oferece assumir; depois é só tentar de novo.
        let assumir = null;
        if (it.codigo === 'nao_assumida' && modoAtual() !== 'orbit') {
          assumir = h('button', { type: 'button', class: 'link' }, 'Assumir no Orbit');
          assumir.addEventListener('click', () => acionar('assumir', {}));
        }
        el.append(h('div', { class: 'cv-msg-erro', role: 'alert' }, h('span', null, it.erro || 'O servidor não explicou o erro.'), h('span', { class: 'cv-msg-erro-b' }, assumir, tentar, fora)));
      }
      if (texto.length > LONGA || texto.split('\n').length > 16) {
        const chave = String(it.id);
        const aberta = st.abertos.has(chave);
        corpo.classList.toggle('cv-recolhida', !aberta);
        const b = h('button', { type: 'button', class: 'link cv-mais', 'aria-expanded': String(aberta) }, aberta ? 'Recolher' : 'Ver mensagem completa');
        b.addEventListener('click', () => {
          const abrir = !st.abertos.has(chave);
          if (abrir) st.abertos.add(chave); else st.abertos.delete(chave);
          corpo.classList.toggle('cv-recolhida', !abrir);
          b.setAttribute('aria-expanded', String(abrir));
          txt(b, abrir ? 'Recolher' : 'Ver mensagem completa');
        });
        meta.prepend(b);
      }
      return el;
    }
    function assistente(it) {
      const el = h('div', { class: 'cv-item cv-assist md' });
      try { el.append(api.md(String(it.texto || ''))); } catch { el.textContent = String(it.texto || ''); }
      return el;
    }
    // Etapa 3: resposta sendo escrita (ou que ficou pela metade). O conteúdo fica num filho .md trocado no lugar.
    function parcial(it) {
      const md = h('div', { class: 'md cv-parcial-txt' });
      preencherMd(md, it.texto);
      const meta = it.incompleta
        ? h('div', { class: 'cv-parcial-meta', title: 'A volta terminou sem o texto final desta resposta. Ele aparece aqui se chegar ao transcript.' }, ico('alerta', 11), 'Resposta incompleta')
        : h('div', { class: 'cv-parcial-meta' }, ponto('trabalhando', 10), 'Escrevendo…');
      const el = h('div', { class: 'cv-item cv-assist cv-parcial' + (it.incompleta ? ' cv-incompleta' : ''), 'aria-busy': it.incompleta ? null : 'true' }, md, meta);
      el._md = md;
      return el;
    }
    function pensamento(it) {
      const texto = String(it.texto || '').trim();
      if (!texto) return h('div', { class: 'cv-item cv-pens cv-pens-vazio' }, ico('balao', 12), 'Pensou');
      const chave = String(it.id);
      const d = h('details', { class: 'cv-item cv-pens' }, h('summary', null, ico('balao', 12), h('span', null, 'Pensamento'), ico('chevron', 12)), h('div', { class: 'cv-pens-txt' }, texto));
      if (st.abertos.has(chave)) d.open = true;
      d.addEventListener('toggle', () => { if (d.open) st.abertos.add(chave); else st.abertos.delete(chave); });
      return d;
    }
    function ferramenta(it) {
      const res = it.resultado;
      const estado = !res ? 'andando' : res.erro ? 'erro' : 'ok';
      const chave = String(it.id);
      const aberta = st.abertos.has(chave);
      const marca = estado === 'andando' ? ponto('trabalhando', 10) : ico(estado === 'erro' ? 'x' : 'check', 11);
      const rotEstado = estado === 'andando' ? 'rodando' : estado === 'erro' ? 'com erro' : 'concluída';
      const resumo = String(it.resumo || '');
      const cab = h('button', { type: 'button', class: 'cv-ferr-cab', 'aria-expanded': String(aberta), title: (it.nome || '') + (resumo ? ' · ' + resumo : '') + ' (' + rotEstado + ')' },
        h('span', { class: 'cv-ferr-marca', 'aria-hidden': 'true' }, marca),
        h('span', { class: 'cv-ferr-nome' }, String(it.nome || 'Ferramenta')),
        h('span', { class: 'cv-ferr-resumo' }, resumo),
        h('span', { class: 'cv-sr' }, ', ' + rotEstado),
        ico('chevron', 12));
      const corpo = h('div', { class: 'cv-ferr-corpo', hidden: !aberta });
      const preencher = () => {
        if (corpo._ok) return;
        corpo._ok = true;
        if (!res) corpo.append(h('p', { class: 'cv-ferr-vazio' }, 'Ainda rodando…'));
        else if (!String(res.texto || '').trim()) corpo.append(h('p', { class: 'cv-ferr-vazio' }, res.erro ? 'Falhou sem mensagem.' : 'Sem saída.'));
        else corpo.append(h('pre', null, String(res.texto)));
      };
      if (aberta) preencher();
      cab.addEventListener('click', () => {
        const abrir = corpo.hidden;
        if (abrir) { preencher(); st.abertos.add(chave); } else st.abertos.delete(chave);
        corpo.hidden = !abrir;
        cab.setAttribute('aria-expanded', String(abrir));
      });
      return h('div', { class: 'cv-item cv-ferr', 'data-estado': estado }, cab, corpo);
    }
    // Saída de um comando local (/context, /usage…). Markdown quando parece markdown; senão, texto como veio.
    function saida(it) {
      const texto = String(it.texto || '');
      const md = /^#{1,4} |^\|.*\|\s*$|\*\*[^*\n]+\*\*/m.test(texto);
      const corpo = h('div', { class: 'cv-saida-txt' + (md ? ' md' : '') });
      if (md) preencherSaida(corpo, texto); else corpo.textContent = texto;
      return h('div', { class: 'cv-item cv-saida' + (it.erro ? ' cv-saida-erro' : ''), role: 'note', 'aria-label': 'Saída do comando' }, corpo);
    }
    // O markdown da página não monta tabelas: os blocos "| a | b |" viram <table> aqui; o resto vai ao md.
    function preencherSaida(el, texto) {
      const linhas = texto.split('\n');
      const celulas = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const sep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
      let resto = [];
      const soltar = () => { if (resto.join('').trim()) { const d = h('div'); preencherMd(d, resto.join('\n')); el.append(...d.childNodes); } resto = []; };
      for (let i = 0; i < linhas.length; i++) {
        if (/^\s*\|/.test(linhas[i]) && i + 1 < linhas.length && sep(linhas[i + 1])) {
          soltar();
          const cab = celulas(linhas[i]);
          const corpo = [];
          i += 2;
          while (i < linhas.length && /^\s*\|/.test(linhas[i])) corpo.push(celulas(linhas[i++]));
          i--;
          el.append(h('table', { class: 'cv-saida-tab' }, h('thead', null, h('tr', null, ...cab.map((c) => h('th', null, c)))),
            h('tbody', null, ...corpo.map((l) => h('tr', null, ...l.map((c) => h('td', null, c)))))));
        } else resto.push(linhas[i]);
      }
      soltar();
    }
    function divisor(icone, texto, sub) {
      return h('div', { class: 'cv-item cv-div', role: 'separator', 'aria-label': texto + (sub ? '. ' + sub : '') },
        h('span', { class: 'cv-div-rot' }, ico(icone, 12), h('span', null, texto)),
        sub ? h('span', { class: 'cv-div-sub', title: sub }, sub) : null);
    }

    // ───────────────────────────── fim da instância ─────────────────────────────
    // Desliga fluxo, temporizadores e ouvintes globais (o DOM fica). Usado por destruir() e por um montar repetido.
    function desmontar() {
      vivo = false;
      st.gen++; // respostas em voo (GET, ações, modelos) caem na conferência de geração
      pararFluxo();
      for (const t of ['estadoTimer', 'ajTimer', 'parcTimer']) { clearTimeout(st[t]); st[t] = 0; }
      if (st.parcRaf) { cancelAnimationFrame(st.parcRaf); st.parcRaf = 0; }
      st.parcPend.clear();
      fecharPop();
      fecharMenu();
      const l = limpezas;
      limpezas = [];
      for (const f of l) { try { f(); } catch {} }
    }
    // Desfaz tudo e esvazia `el`. Os ouvintes que o Anexos pôs no `el` (arrastar/colar) não têm como sair por
    // aqui (anexos.js não tem destruir): o controlador fica desabilitado e os avisos dele caem no `vivo`.
    function destruir() {
      if (!raiz) return;
      desmontar();
      soltarLocais(st.itens);
      if (ui.ax) { try { ui.ax.limpar(); ui.ax.habilitar(false, ''); } catch {} }
      if (window.Anexos) for (const g of st.anexosRasc.values()) { try { window.Anexos.soltar(g); } catch {} }
      st.anexosRasc.clear();
      st.rascunhos.clear();
      st.id = null;
      st.itens = [];
      st.porId = new Map();
      st.nos = new Map();
      raiz.replaceChildren();
      raiz.classList.remove('cv', 'ax-arrastando');
      raiz = null;
    }
    function focar() { if (ui.texto && raiz) ui.texto.focus(); }
    function _debug() {
      return { id: st.id, itens: st.itens.length, nos: ui.itens ? ui.itens.childElementCount : 0, ini: st.ini, cursor: st.cursor, modo: modoAtual(), es: !!st.es,
        parciais: st.itens.filter((x) => x.parcial).map((x) => ({ id: x.id, n: String(x.texto || '').length, incompleta: !!x.incompleta })),
        // rodada 9: o que esta instância mantém ligado (destruir zera tudo)
        sufixo: SUF, montada: !!raiz, ouvintes: limpezas.length,
        rascunho: ui.texto ? ui.texto.value : '', anexos: ui.ax ? ui.ax.contagem() : 0 };
    }

    return { montar, abrir, parar, executar, destruir, focar, _debug };
  }

  // ───────────────────────────── instâncias ─────────────────────────────
  let principal = null; // o painel de detalhe (ids sem sufixo)
  const P = () => principal || (principal = nova(''));
  let seqInst = 1;
  function criar(el, a) {
    if (!el || !a) throw new Error('Conversa.criar(el, api): el e api são obrigatórios');
    const inst = nova('-' + ++seqInst);
    inst.montar(el, a);
    return Object.freeze({ abrir: inst.abrir, parar: inst.parar, executar: inst.executar, focar: inst.focar, destruir: inst.destruir, _debug: inst._debug });
  }

  window.Conversa = Object.freeze({
    montar: (el, a) => P().montar(el, a),
    abrir: (id) => P().abrir(id),
    parar: () => P().parar(),
    executar: (id, tipo, op) => P().executar(id, tipo, op),
    focar: () => P().focar(),
    _debug: () => P()._debug(),
    criar,
  });
})();
