/* Sincronia — card "Sincronização" da Visão geral: o repositório do projeto escolhido no filtro (servidor: repos.mjs, /repos/*).
 *
 * window.Sincronia = { montarCard(el, api), projetoMudou() }
 *   el  = o #sincronia-card do index.html;
 *   api = { get, post, confirmar, perguntar, projeto } (ver montarCard). A página chama projetoMudou() a cada render().
 *
 * Nada aqui resolve conflito: o card mostra o estado e manda para a aba Repositórios / o editor.
 * Texto vindo do servidor entra só por textContent.
 */
(function () {
  'use strict';

  const MS_RELOGIO = 30e3;
  const MAX_ARQS = 6;
  const st = { api: null, acao: '', linhaAcao: '' };

  // ───────────────────────────── utilidades ─────────────────────────────
  function h(tag, props, ...filhos) {
    const e = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const f of filhos) if (f != null && f !== false) e.append(f);
    return e;
  }
  const NS = 'http://www.w3.org/2000/svg';
  const ICONES = {
    nuvem: [['path', { d: 'M4.5 12.5h7a2.75 2.75 0 0 0 .4-5.47A4 4 0 0 0 4.2 7.6 2.5 2.5 0 0 0 4.5 12.5Z' }]],
    girar: [['path', { d: 'M13 8a5 5 0 1 1-1.46-3.54' }], ['path', { d: 'M13 2.8v2.7h-2.7' }]],
    enviar: [['path', { d: 'M8 12.5V3.5M4.5 7 8 3.5 11.5 7' }]],
    baixar: [['path', { d: 'M8 3.5v9M4.5 9 8 12.5 11.5 9' }]],
    alerta: [['path', { d: 'M8 2.5 14 13H2z' }], ['path', { d: 'M8 6.5v3' }], ['circle', { cx: 8, cy: 11.3, r: .5, fill: 'currentColor', stroke: 'none' }]],
    check: [['path', { d: 'M3.5 8.5l3 3 6-7' }]],
    fechar: [['path', { d: 'M4.5 4.5l7 7M11.5 4.5l-7 7' }]],
    seta: [['path', { d: 'M6 3.5 10.5 8 6 12.5' }]],
  };
  function icone(nome, tam = 14) {
    const v = document.createElementNS(NS, 'svg');
    const attrs = { viewBox: '0 0 16 16', width: tam, height: tam, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' };
    for (const k in attrs) v.setAttribute(k, String(attrs[k]));
    for (const [t, a] of ICONES[nome] || []) {
      const e = document.createElementNS(NS, t);
      for (const k in a) e.setAttribute(k, String(a[k]));
      v.append(e);
    }
    return v;
  }
  const plural = (n, um, varios) => n + ' ' + (n === 1 ? um : varios);
  function haQuanto(iso) {
    const t = Date.parse(iso || '');
    if (!t) return '';
    const min = Math.round((Date.now() - t) / 60e3);
    if (min < 1) return 'agora há pouco';
    if (min < 60) return 'há ' + min + ' min';
    const hs = Math.round(min / 60);
    if (hs < 24) return 'há ' + hs + ' h';
    return 'há ' + plural(Math.round(hs / 24), 'dia', 'dias');
  }
  const pendentes = (r) => (r.totalAlteracoes != null ? r.totalAlteracoes : (r.alteracoes || []).length) + (r.aFrente || 0);
  const render = () => renderCard();

  function textoErro(e) {
    const c = e && e.corpo;
    if (c && typeof c.erro === 'string' && c.erro) return c.erro;
    return (e && e.message) || 'Não deu para falar com o servidor do Orbit.';
  }
  // ───────────────────────────── card da Visão geral ─────────────────────────────
  // Coluna da direita, abaixo do Uso de contexto, no esqueleto do index.html (#sincronia-card, os filhos ficam
  // fixos para o ResizeObserver da Home). Mostra o repositório do projeto escolhido no filtro da Visão geral:
  //  - topo: o rótulo e, à direita, o estado geral numa palavra;
  //  - identidade: logo do GitHub, o repositório (dono/nome, do origin) com o selo Privado/Público e a conta
  //    conectada (avatar e usuário, do /perfil e do evento 'perfil');
  //  - uma linha por pasta com git: ponto do estado, nome, branch; embaixo, a mensagem do último commit com o hash;
  //    embaixo, só os números que não são zero (alterações, commits, para puxar) ou "Igual ao GitHub";
  //  - pé: "Buscado há…", Sincronizar e Enviar/Puxar. Os botões mostram sincronizando, concluído e erro.
  // Destaque discreto (laranja dos gráficos): algo pendente há mais de CARD_VELHO_MS desde o último envio, ou
  // CARD_MUITAS alterações + commits num repositório.
  const CARD_VELHO_MS = 24 * 3600e3;
  const CARD_MUITAS = 20;
  const CARD_MSG_MS = 6e3;
  const CARD_FIM_MS = 2600; // quanto tempo o botão fica em "Sincronizado"/"Enviado" (o erro fica 4 s)
  const card = { el: null, msg: '', erro: false, abertos: new Set(), tMsg: 0, fim: null, tFim: 0, perfil: undefined };
  const cui = {};

  ICONES.github = [['path', { fill: 'currentColor', stroke: 'none', d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z' }]];
  ICONES.cadeado = [['rect', { x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.6 }], ['path', { d: 'M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7' }]];
  ICONES.aberto = [['rect', { x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.6 }], ['path', { d: 'M5.5 7V5.2a2.5 2.5 0 0 1 4.8-1' }]];
  ICONES.branch = [['circle', { cx: 5, cy: 3.8, r: 1.6 }], ['circle', { cx: 5, cy: 12.2, r: 1.6 }], ['circle', { cx: 11, cy: 5.2, r: 1.6 }], ['path', { d: 'M5 5.4v5.2M11 6.8c0 2.6-6 1.8-6 3.8' }]];
  ICONES.commit = [['circle', { cx: 8, cy: 8, r: 2.4 }], ['path', { d: 'M1.5 8h4.1M10.4 8h4.1' }]];
  ICONES.mais = [['path', { d: 'M8 3.5v9M3.5 8h9' }]];
  ICONES.externo = [['path', { d: 'M9.5 2.5h4v4M13.5 2.5 7.8 8.2' }], ['path', { d: 'M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3' }]];

  const alteracoesDe = (r) => (r.totalAlteracoes != null ? r.totalAlteracoes : (r.alteracoes || []).length);
  const velho = (r) => pendentes(r) > 0 && !!Date.parse(r.ultimoEnvio || '') && Date.now() - Date.parse(r.ultimoEnvio) > CARD_VELHO_MS;
  const muitas = (r) => pendentes(r) >= CARD_MUITAS;
  const dataHora = (iso) => { try { return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); } catch { return ''; } };

  function avisoCard(msg, erro) {
    card.msg = msg || '';
    card.erro = !!erro;
    clearTimeout(card.tMsg);
    // O "deu certo" some sozinho; o erro fica até a próxima ação.
    if (card.msg && !card.erro) card.tMsg = setTimeout(() => { card.msg = ''; renderCard(); }, CARD_MSG_MS);
  }
  // Fim de uma ação no botão dela: { qual: 'sinc' | 'enviar', ok }. Some sozinho.
  function fimCard(qual, ok) {
    clearTimeout(card.tFim);
    card.fim = qual ? { qual, ok: !!ok } : null;
    if (card.fim) card.tFim = setTimeout(() => { card.fim = null; renderCard(); }, ok ? CARD_FIM_MS : 4000);
  }

  // api = { get(rota), post(rota, corpo) (fora de 2xx rejeita um Error com .status e .corpo), confirmar({...}),
  //         perguntar({...}), projeto() → { nome, pastas } }.
  function montarCard(el, api) {
    if (!el || card.el) return;
    card.el = el;
    st.api = api || {};
    for (const k of ['estado', 'id', 'repos', 'msg', 'lido', 'enviar', 'sinc']) cui[k] = el.querySelector('[data-gs="' + k + '"]');
    const aoEnviar = () => (cui.enviar && cui.enviar.dataset.acao === 'puxar' ? puxarProjeto() : enviarProjeto());
    for (const [b, ico, rot, fn] of [[cui.sinc, 'girar', 'Sincronizar', sincronizarProjeto], [cui.enviar, 'enviar', 'Enviar', aoEnviar]]) {
      if (!b) continue;
      b.dataset.icone = ico;
      b.replaceChildren(icone(ico, 14), h('span', { text: rot }));
      b.addEventListener('click', fn);
    }
    // A conta do GitHub vem do perfil (assets/perfil.js usa a mesma fonte): o GET agora e o evento 'perfil' depois.
    const gapi = window.GerenciadorAPI;
    if (gapi && typeof gapi.on === 'function') gapi.on('perfil', (p) => { card.perfil = p || null; renderCard(); });
    fetch('/perfil', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((p) => { if (card.perfil === undefined) { card.perfil = p; renderCard(); } }, () => {});
    setInterval(() => { if (proj.nome && !st.acao) lerProjeto(); else renderCard(); }, MS_RELOGIO);
    projetoMudou();
    renderCard();
  }

  // ───────────── card com o projeto filtrado (17/10) ─────────────
  // Com a Visão geral filtrada por um projeto, o card mostra o repositório desse projeto (o mesmo /repos/* da aba
  // Repositórios). Sincronizar = buscar no GitHub e receber quando dá para avançar sem mesclar; Enviar = push com a
  // confirmação do servidor. Commit, mesclar e branch ficam na aba Repositórios. Sem projeto no filtro, o card
  // avisa para escolher um.
  // Subpastas com repositório próprio (18/10: um projeto pode ter um clone por branch em app/, brain/
  // e main/): uma linha por subpasta, com o nome dela e o branch; os botões agem em todas. Aí a pasta do projeto só
  // entra se tiver commits (o .git vazio de um vínculo pela metade não conta).
  const proj = { nome: '', pastas: '', p: null, filhos: [], completo: '', privado: null, lendo: false, erro: '', lidoEm: 0, seq: 0 };
  const chavePasta = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

  // O index.html chama a cada render(); só faz algo quando o filtro (ou as pastas das sessões dele) muda.
  function projetoMudou() {
    if (!card.el) return;
    const f = st.api && typeof st.api.projeto === 'function' ? st.api.projeto() : null;
    const nome = (f && f.nome) || '';
    const pastas = ((f && f.pastas) || []).join('\n');
    if (nome === proj.nome && pastas === proj.pastas) return;
    if (nome !== proj.nome) {
      fecharMenu();
      Object.assign(proj, { p: null, filhos: [], completo: '', privado: null, erro: '', lidoEm: 0 });
      card.abertos.clear();
      if (!st.acao) { avisoCard(''); fimCard(null); }
    }
    proj.nome = nome;
    proj.pastas = pastas;
    if (nome) lerProjeto(); else proj.seq++;
    renderCard();
  }

  async function lerProjeto() {
    const seq = ++proj.seq, nome = proj.nome;
    const pastas = proj.pastas ? proj.pastas.split('\n').map(chavePasta) : [];
    proj.lendo = true;
    try {
      const d = await st.api.get('/repos/projetos');
      if (seq !== proj.seq) return;
      const lista = d && Array.isArray(d.projetos) ? d.projetos.filter((p) => p && typeof p.pasta === 'string') : [];
      // A pasta com o nome do projeto (a de uma sessão dele, se houver mais de uma); senão, a pasta que contém mais
      // sessões do projeto (empate: a mais funda). As subpastas de outro projeto só valem se não houver outra.
      const sessoesEm = (p) => { const k = chavePasta(p.pasta); return pastas.filter((c) => c === k || c.startsWith(k + '/')).length; };
      const mesmoNome = lista.filter((p) => String(p.nome || '').toLowerCase() === nome.toLowerCase());
      let achado = mesmoNome.find((p) => sessoesEm(p) > 0) || mesmoNome[0] || null;
      for (const grupo of [lista.filter((p) => p.origem !== 'subpasta'), lista]) {
        let melhor = 0, tam = -1;
        for (const p of achado ? [] : grupo) {
          const n = sessoesEm(p), k = chavePasta(p.pasta).length;
          if (n > melhor || (n && n === melhor && k > tam)) { achado = p; melhor = n; tam = k; }
        }
      }
      const subs = new Set(((achado && achado.subrepos) || []).map(chavePasta));
      proj.p = achado;
      proj.filhos = subs.size ? lista.filter((p) => subs.has(chavePasta(p.pasta))) : [];
      proj.erro = '';
      proj.lidoEm = Date.now();
      const comRepo = [achado, ...proj.filhos].find((p) => p && p.repo);
      const completo = comRepo ? comRepo.repo.completo : '';
      if (completo !== proj.completo) Object.assign(proj, { completo, privado: null });
      if (completo && proj.privado === null) lerPrivado(seq, completo);
    } catch (e) {
      if (seq === proj.seq) proj.erro = textoErro(e);
    } finally {
      if (seq === proj.seq) { proj.lendo = false; renderCard(); }
    }
  }

  // Privado/Público vem da lista do GitHub (cache de 60 s no servidor). Sem token ou sem o repositório: sem selo.
  async function lerPrivado(seq, completo) {
    proj.privado = undefined;
    try {
      const d = await st.api.get('/repos/github');
      if (seq !== proj.seq && proj.completo !== completo) return;
      const r = (d && Array.isArray(d.repos) ? d.repos : []).find((x) => x && String(x.completo).toLowerCase() === completo.toLowerCase());
      if (r) { proj.privado = r.visibilidade !== 'publico'; renderCard(); }
    } catch {}
  }

  // Resposta do servidor com um projeto fresco: troca a pasta certa (a do projeto ou a de uma subpasta).
  function guardarProjeto(q) {
    if (!q || typeof q.pasta !== 'string') return;
    if (proj.p && proj.p.pasta === q.pasta) { proj.p = q; return; }
    const i = proj.filhos.findIndex((f) => f.pasta === q.pasta);
    if (i >= 0) proj.filhos[i] = q;
  }

  // As pastas do card: as subpastas com git (e a do projeto, se tiver commits) ou só a do projeto.
  function pastasProjeto() {
    const p = proj.p;
    if (!p) return { sub: false, lista: [] };
    const filhos = proj.filhos.filter((f) => f.git && f.status);
    if (!filhos.length) return { sub: false, lista: p.git && p.status ? [p] : [] };
    return { sub: true, lista: [...(p.git && p.status && !p.status.semCommits ? [p] : []), ...filhos] };
  }
  function paresProjeto() {
    const { sub, lista } = pastasProjeto();
    return { sub, pares: lista.map((p) => ({ p, r: repoDoProjeto(p, sub) })) };
  }

  // Uma pasta no formato das linhas do card.
  function repoDoProjeto(p, sub) {
    const s = p.status || {};
    const u = s.ultimo;
    const arqs = Array.isArray(s.arquivos) ? s.arquivos : [];
    const r = {
      id: sub ? 'projeto-' + chavePasta(p.pasta).replace(/[^\w-]/g, '_') : 'projeto', projeto: true,
      nome: sub ? p.nome : 'Código', branch: s.branch || s.destacado || '',
      aFrente: s.adiante || 0, atras: s.atras || 0, totalAlteracoes: s.alteracoes || 0,
      alteracoes: arqs.filter((a) => a && typeof a.caminho === 'string').map((a) => ({ arquivo: a.caminho, tipo: a.tipo === 'nao-rastreado' ? 'novo' : a.tipo })),
      commit: u && u.hash ? { msg: u.msg, hash: u.hash, quando: u.quando } : null,
      remoto: p.repo ? p.repo.completo : '',
      privado: p.repo && p.repo.completo === proj.completo && typeof proj.privado === 'boolean' ? proj.privado : undefined,
    };
    const aviso = (a, detalhe) => { r.aviso = a; r.detalhe = detalhe; };
    const emConflito = arqs.filter((a) => a && a.tipo === 'conflito').map((a) => a.caminho);
    if (s.operacao === 'merge') {
      aviso('conflito', emConflito.length
        ? 'Junção aberta com conflito em ' + emConflito.slice(0, 3).join(', ') + (emConflito.length > 3 ? ' e mais ' + (emConflito.length - 3) : '') + '. No editor, escolha o que fica nos trechos marcados com <<<<<<<, apague as marcas, salve e clique Concluir.'
        : 'Junção aberta, sem conflitos pendentes: clique Concluir.');
    } else if (s.operacao) aviso('conflito', 'Há um ' + s.operacao + ' em andamento nesta pasta. Termine ou cancele no editor ou no terminal.');
    else if (arqs.some((a) => a && a.tipo === 'conflito')) aviso('conflito', 'Há arquivos em conflito nesta pasta. Resolva no editor.');
    else if (!p.remoto) aviso('sem-origin', 'Esta pasta não está ligada a um repositório. Vincule ou crie um pela aba Repositórios.');
    else if (!p.repo) aviso('sem-origin', 'O origin desta pasta não é do GitHub (' + (p.remoto.url || '') + ').');
    else if (s.semCommits) aviso('sem-upstream', 'Ainda não há commits. Faça o primeiro pela aba Repositórios.');
    else if (s.destacado) {
      // Commit solto que já está num branch (um worktree de build, por exemplo): nada só daqui, então nada a avisar.
      if (!s.destacadoEm) aviso('sem-upstream', 'O git está num commit solto (' + s.destacado + '). Troque para um branch pela aba Repositórios.');
    }
    else if (!s.upstream) aviso('sem-upstream', 'O branch ' + s.branch + ' ainda não está no GitHub: o Enviar cria e liga o branch.');
    else if (r.aFrente && r.atras) aviso('divergiu', 'Seu branch e o do GitHub divergiram (' + r.aFrente + ' seus, ' + r.atras + ' do GitHub). Mescle pela aba Repositórios.');
    return r;
  }
  const podeEnviarProjeto = (p, r) => !!(p.repo && p.status && p.status.branch && !p.status.semCommits && !p.status.operacao && r.aviso !== 'conflito' && r.aviso !== 'divergiu' && !r.atras && (r.aFrente > 0 || !p.status.upstream));
  const podeSincProjeto = (p, r) => !!(p.repo && r.aviso !== 'conflito');
  const podePuxarProjeto = (p, r) => !!(p.repo && p.status && p.status.upstream && p.status.branch && !p.status.operacao && r.aviso !== 'conflito' && r.aviso !== 'divergiu');

  function estadoProjeto(rs) {
    if (st.acao === 'proj-sinc') return { tom: 'ocupado', texto: 'Sincronizando…' };
    if (st.acao === 'proj-enviar') return { tom: 'ocupado', texto: 'Enviando…' };
    if (st.acao === 'proj-puxar') return { tom: 'ocupado', texto: 'Puxando…' };
    if (st.acao.startsWith('linha:')) return { tom: 'ocupado', texto: LINHA_EM_CURSO[st.linhaAcao] || 'Trabalhando…' };
    const com = (av) => rs.some((r) => r.aviso === av);
    if (com('conflito')) return { tom: 'perigo', texto: 'Conflito' };
    if (com('divergiu')) return { tom: 'aviso', texto: 'Divergiu' };
    if (rs.every((r) => r.aviso === 'sem-origin')) return { tom: 'neutro', texto: 'Sem GitHub' };
    if (rs.some((r) => r.atras)) return { tom: 'atras', texto: 'Novidades no GitHub' };
    if (rs.some((r) => pendentes(r) || r.aviso === 'sem-upstream')) return { tom: rs.some(muitas) ? 'quente' : 'neutro', texto: 'Para enviar' };
    return { tom: 'ok', texto: 'Em dia' };
  }

  function renderCardProjeto() {
    const p = proj.p;
    cui.msg.textContent = card.msg;
    cui.msg.className = 'gs-msg' + (card.msg ? (card.erro ? ' erro' : ' ok') : '');
    const { sub, pares } = paresProjeto();
    if (!pares.length) {
      const lendo = !!proj.nome && !p && !proj.erro && (proj.lendo || !proj.lidoEm);
      const texto = !proj.nome ? 'Escolha um projeto no filtro da Visão geral para ver o repositório dele.'
        : proj.erro ?'Não deu para ler os projetos: ' + proj.erro
        : lendo ? 'Lendo o repositório de ' + proj.nome + '…'
          : !p ? 'Não achei a pasta de ' + proj.nome + ' entre os projetos.'
            : p.bloqueado ? 'Esta pasta contém o Orbit e outros projetos: o Orbit não usa git nela.'
              : !p.existe ? 'A pasta de ' + proj.nome + ' não existe mais.'
                : p.erro || proj.nome + ' ainda não tem git. Crie ou vincule um repositório pela aba Repositórios.';
      cui.estado.dataset.tom = lendo ? 'ocupado' : proj.erro ? 'perigo' : 'neutro';
      cui.estado.lastChild.textContent = lendo ? 'Lendo…' : proj.erro ? 'Falha' : !proj.nome ? 'Sem projeto' : 'Sem git';
      cui.estado.title = '';
      renderId([]);
      cui.repos.replaceChildren(h('p', { class: 'gc-vazio', text: texto }));
      cui.enviar.hidden = true;
      cui.sinc.hidden = true;
      cui.lido.textContent = '';
      return;
    }
    const rs = pares.map((x) => x.r);
    proj.porId = new Map(pares.map((x) => [x.r.id, x.p]));
    const geral = estadoProjeto(rs);
    cui.estado.dataset.tom = geral.tom;
    cui.estado.lastChild.textContent = geral.texto;
    renderId(rs);
    for (const id of card.abertos) if (!rs.some((r) => r.id === id && r.alteracoes.length)) card.abertos.delete(id);
    // Várias subpastas (20/10): as iguais ao GitHub saem da lista e viram uma linha só embaixo.
    // A que está no meio de uma ação fica até ela terminar.
    const emDia = (r) => !r.totalAlteracoes && !r.aFrente && !r.atras && !r.aviso && st.acao !== 'linha:' + r.id;
    const visiveis = sub ? rs.filter((r) => !emDia(r)) : rs;
    const ocultas = sub ? rs.filter(emDia) : [];
    cui.repos.replaceChildren(...visiveis.map(linhaCard), ...(ocultas.length ? [linhaEmDia(ocultas, !visiveis.length)] : []));

    const ocupado = !!st.acao;
    const fim = card.fim;
    const completo = proj.completo || 'o GitHub';
    const nomes = (f) => pares.filter((x) => f(x.p, x.r)).map((x) => x.p.nome).join(', ');
    cui.sinc.hidden = false;
    cui.sinc.disabled = ocupado || !pares.some((x) => podeSincProjeto(x.p, x.r));
    estadoBotao(cui.sinc, st.acao === 'proj-sinc' ? { ico: 'girar', rot: 'Sincronizando…', girando: true }
      : fim && fim.qual === 'sinc' ? (fim.ok ? { ico: 'check', rot: 'Sincronizado', tom: 'ok' } : { ico: 'alerta', rot: 'Tentar de novo', tom: 'erro' })
        : { ico: 'girar', rot: 'Sincronizar' });
    cui.sinc.title = proj.completo ? 'Busca as novidades de ' + completo + (sub ? ' (' + nomes(podeSincProjeto) + ')' : '') + ' e recebe quando dá para avançar sem mesclar. Nada é enviado.' : 'Esta pasta não está ligada a um repositório do GitHub.';
    const pode = pares.some((x) => podeEnviarProjeto(x.p, x.r));
    const podePuxar = pares.some((x) => podePuxarProjeto(x.p, x.r));
    const atras = rs.reduce((n, r) => n + (r.atras || 0), 0);
    const semCommit = rs.some((r) => r.totalAlteracoes);
    const detalhe = (rs.find((r) => r.detalhe) || {}).detalhe;
    botaoEnviarOuPuxar({
      pode, podePuxar, novidades: atras, enviando: st.acao === 'proj-enviar', puxando: st.acao === 'proj-puxar',
      tituloEnviar: 'Envia os commits de ' + (sub ? nomes(podeEnviarProjeto) : proj.nome) + ' para ' + completo + ', depois de confirmar',
      tituloPuxar: !podePuxar ? (detalhe || 'Nada para enviar nem para puxar')
        : (atras ? 'Traz ' + plural(atras, 'commit', 'commits') + ' de ' + completo : 'Busca e traz as novidades de ' + completo) + ' sem mesclar. Nada para enviar' + (semCommit ? ' (as alterações sem commit vão pela aba Repositórios)' : '') + '.',
    });

    const buscas = pares.map((x) => Number(x.p.status.buscadoEm) || 0).filter(Boolean);
    const busca = buscas.length ? Math.min(...buscas) : 0;
    cui.lido.replaceChildren(...(busca ? [h('span', { class: 'gs-lido-pre', text: 'Buscado ' }), haQuanto(new Date(busca).toISOString())] : []));
    cui.lido.title = busca ? 'Última busca no GitHub: ' + new Date(busca).toLocaleString('pt-BR') : '';
    cui.estado.title = proj.nome + ': ' + geral.texto;
  }

  // A linha das pastas iguais ao GitHub: cada nome é um botão que abre o menu Branch dela (o mesmo da linha cheia).
  function linhaEmDia(rs, todas) {
    const bts = rs.map((r) => {
      const p = proj.porId && proj.porId.get(r.id);
      const b = h('button', { type: 'button', class: 'gs-emdia-item', 'data-repo': r.id, title: (r.nome || r.id) + (r.branch ? ' (branch ' + r.branch + ')' : '') + ': trocar de branch ou criar um novo' },
        h('span', { text: r.nome || r.id }), r.branch && r.branch !== r.nome ? h('code', { text: r.branch }) : null);
      b.disabled = !!st.acao || !(p && p.git);
      b.addEventListener('click', (ev) => { ev.stopPropagation(); if (p) abrirMenuBranch(p, r, b); });
      return b;
    });
    return h('div', { class: 'gs-emdia' }, icone('check', 12), h('span', { class: 'gs-emdia-rot', text: todas ? 'Tudo igual ao GitHub:' : 'Iguais ao GitHub:' }), ...bts);
  }

  // POST que o servidor pode responder com 409 'confirmar' (sem mudar nada): pergunta no balão e repete com
  // confirmar:true. null = o usuário cancelou.
  async function postarConfirmando(rota, corpo, ancora) {
    try {
      return await st.api.post(rota, corpo);
    } catch (e) {
      const c = e && e.corpo;
      if (!(e && e.status === 409 && c && c.codigo === 'confirmar')) throw e;
      const ok = await st.api.confirmar({ titulo: c.titulo, mensagem: c.mensagem, itens: c.itens || [], botao: c.botao || 'Confirmar', ancora });
      if (!ok) return null;
      return st.api.post(rota, Object.assign({}, corpo, { confirmar: true }));
    }
  }

  // O mesmo POST em várias pastas: os pedidos de confirmação viram um balão só e cada
  // pasta é repetida com confirmar:true. Devolve { feitos: [{ p, d }], falhas: [{ p, e }], cancelado }.
  async function postarEmLote(rota, alvos, ancora) {
    const feitos = [], falhas = [], pedir = [];
    const guardar = (p, e) => { guardarProjeto(e && e.corpo && e.corpo.projeto); falhas.push({ p, e }); };
    for (const p of alvos) {
      try {
        const d = await st.api.post(rota, { pasta: p.pasta });
        guardarProjeto(d && d.projeto);
        feitos.push({ p, d });
      } catch (e) {
        const c = e && e.corpo;
        if (e && e.status === 409 && c && c.codigo === 'confirmar') pedir.push({ p, c }); else guardar(p, e);
      }
    }
    if (!pedir.length) return { feitos, falhas, cancelado: false };
    const dois = pedir.length > 1;
    const igual = (k) => pedir.every((x) => x.c[k] === pedir[0].c[k]);
    const ok = await st.api.confirmar({
      titulo: !dois || igual('titulo') ? pedir[0].c.titulo : 'Confirmar em ' + pedir.length + ' pastas?',
      mensagem: pedir.map((x) => (dois ? x.p.nome + ': ' : '') + x.c.mensagem).join('\n'),
      itens: pedir.flatMap((x) => (x.c.itens || []).map((i) => (dois ? x.p.nome + ' · ' : '') + i)),
      botao: (!dois || igual('botao')) && pedir[0].c.botao ? pedir[0].c.botao : 'Confirmar',
      ancora,
    });
    if (!ok) return { feitos, falhas, cancelado: true };
    for (const x of pedir) {
      try {
        const d = await st.api.post(rota, { pasta: x.p.pasta, confirmar: true });
        guardarProjeto(d && d.projeto);
        feitos.push({ p: x.p, d });
      } catch (e) {
        guardar(x.p, e);
      }
    }
    return { feitos, falhas, cancelado: false };
  }

  // Mensagem do fim de uma ação: uma pasta fala como antes; várias, "Recebido do GitHub: app (3 commits), …".
  function resumoLote(sub, { rotulo, itens, falhas, nada }) {
    const erros = falhas.map((f) => (sub ? f.p.nome + ': ' : '') + (f.texto || textoErro(f.e)));
    const ok = itens.length ? rotulo + ': ' + itens.map(([p, t]) => (sub ? p.nome + ' (' + t + ')' : t)).join(', ') + '.' : '';
    return { msg: [ok, ...erros].filter(Boolean).join(' ') || nada, erro: erros.length > 0 };
  }

  async function acaoProjeto(qual, fn) {
    if (st.acao || !proj.p || !st.api || typeof st.api.post !== 'function') return;
    const nome = proj.nome;
    const { sub, pares } = paresProjeto();
    st.acao = 'proj-' + qual;
    avisoCard('');
    fimCard(null);
    renderCard();
    let fim = null;
    try {
      const r = await fn(pares, sub);
      if (r && proj.nome === nome) {
        avisoCard(r.msg, !!r.erro);
        fim = !r.erro;
      }
    } catch (e) {
      if (proj.nome === nome) {
        guardarProjeto(e && e.corpo && e.corpo.projeto);
        avisoCard(textoErro(e), true);
        fim = false;
      }
    } finally {
      st.acao = '';
      if (fim !== null) fimCard(qual, fim);
      render();
      if (proj.nome) lerProjeto(); else renderCard();
    }
  }

  const commits = (n) => plural(n, 'commit', 'commits');

  function sincronizarProjeto() {
    return acaoProjeto('sinc', async (pares, sub) => {
      const falhas = [], receber = [];
      let buscou = false;
      for (const { p } of pares.filter((x) => podeSincProjeto(x.p, x.r))) {
        try {
          const d = await st.api.post('/repos/buscar', { pasta: p.pasta });
          const q = (d && d.projeto) || p;
          guardarProjeto(q);
          if (!d || d.buscou !== false) buscou = true;
          const s = q.status || {};
          if (s.atras > 0 && s.adiante > 0) falhas.push({ p, texto: 'Seu branch e o do GitHub divergiram (' + s.adiante + ' seus, ' + s.atras + ' do GitHub). Mescle pela aba Repositórios.' });
          else if (s.atras > 0 && s.upstream) receber.push(q);
        } catch (e) {
          guardarProjeto(e && e.corpo && e.corpo.projeto);
          falhas.push({ p, e });
        }
      }
      const lote = receber.length ? await postarEmLote('/repos/pull', receber, cui.sinc) : { feitos: [], falhas: [], cancelado: false };
      // Cancelado sem nada feito: o botão volta ao normal (a busca feita aparece no lerProjeto).
      if (lote.cancelado && !lote.feitos.length && !falhas.length && !lote.falhas.length) return null;
      const itens = lote.feitos.map(({ p, d }) => [p, commits((d && d.recebidos) || (p.status && p.status.atras) || 0)]);
      return resumoLote(sub, { rotulo: 'Recebido do GitHub', itens, falhas: [...falhas, ...lote.falhas], nada: buscou ? 'Nada novo no GitHub.' : 'Em dia com a busca de há pouco.' });
    });
  }

  // Puxar: o /repos/pull já busca no GitHub e só avança sem mesclar (divergiu → 409 com a mensagem do servidor).
  function puxarProjeto() {
    return acaoProjeto('puxar', async (pares, sub) => {
      const lote = await postarEmLote('/repos/pull', pares.filter((x) => podePuxarProjeto(x.p, x.r)).map((x) => x.p), cui.enviar);
      if (lote.cancelado && !lote.feitos.length && !lote.falhas.length) return null;
      const itens = lote.feitos.filter(({ d }) => d && d.recebidos).map(({ p, d }) => [p, commits(d.recebidos)]);
      return resumoLote(sub, { rotulo: 'Recebido do GitHub', itens, falhas: lote.falhas, nada: 'Nada novo no GitHub.' });
    });
  }

  function enviarProjeto() {
    return acaoProjeto('enviar', async (pares, sub) => {
      const lote = await postarEmLote('/repos/push', pares.filter((x) => podeEnviarProjeto(x.p, x.r)).map((x) => x.p), cui.enviar);
      if (lote.cancelado && !lote.feitos.length && !lote.falhas.length) return null; // cancelado: o botão volta ao normal
      const itens = lote.feitos.map(({ p, d }) => [p, d && d.enviados ? (sub ? commits(d.enviados) : commits(d.enviados) + ' para o GitHub') : sub ? 'branch criado' : 'branch enviado para o GitHub']);
      const r = resumoLote(sub, { rotulo: 'Enviado', itens, falhas: lote.falhas, nada: 'Não há nada para enviar.' });
      // Uma pasta, só o branch: "Branch enviado para o GitHub." (como antes).
      if (!sub && itens.length === 1 && !(lote.feitos[0].d && lote.feitos[0].d.enviados) && !r.erro) r.msg = 'Branch enviado para o GitHub.';
      return r;
    });
  }


  // ───────────── ações de cada linha do projeto (18/10) ─────────────
  // Versionar pelo card, em qualquer projeto: cada linha (uma pasta com git, ou seja, um branch) tem os botões do
  // estado dela. Salvar e enviar = prévia no servidor (avisos de credencial, arquivo grande, pasta gerada), balão com
  // a mensagem do commit, commit e envio; se o GitHub andou, junta antes (merge que se desfaz sozinho se der
  // conflito). Enviar, Receber, Juntar e enviar e o menu Branch (trocar ou criar). Nada descarta trabalho: sem
  // force, reset ou stash; o servidor confirma o que leva alterações junto.
  const LINHA_EM_CURSO = { ignorar: 'Ignorando…', salvar: 'Salvando…', enviar: 'Enviando…', receber: 'Recebendo…', juntar: 'Juntando…', branch: 'Trocando…', concluir: 'Concluindo…', cancelar: 'Cancelando…' };
  const prefixoLinha = (p) => (pastasProjeto().sub ? p.nome + ': ' : '');
  const linhaEl = (r) => cui.repos && cui.repos.querySelector('.gs-repo[data-repo="' + r.id + '"]');
  const rastreadasDe = (p) => ((p.status && p.status.arquivos) || []).filter((a) => a && a.tipo !== 'nao-rastreado').length;
  // O que o Ignorar leva: os novos e os acompanhados que mudaram só aqui (sem preparar), como os da build de iOS no Mac.
  const ignoraveisDe = (p) => ((p.status && p.status.arquivos) || []).filter((a) => a && typeof a.caminho === 'string'
    && (a.tipo === 'nao-rastreado' || (!a.preparado && (a.tipo === 'modificado' || a.tipo === 'apagado')))).map((a) => a.caminho);

  function acoesLinha(r) {
    const p = proj.porId && proj.porId.get(r.id);
    if (!p || !p.status) return null;
    const s = p.status;
    const minha = st.acao === 'linha:' + r.id ? st.linhaAcao : '';
    const travado = r.aviso === 'conflito' || !!s.operacao;
    const bts = [];
    const bt = (qual, ico, rot, titulo, fn, solido) => {
      const gira = minha === qual;
      const b = h('button', { type: 'button', class: 'btn gs-mini' + (solido ? ' solido' : '') + (gira ? ' gs-girando' : ''), 'data-acao': qual, title: titulo, 'aria-busy': gira ? 'true' : null },
        icone(gira ? 'girar' : ico, 12), h('span', { text: gira ? LINHA_EM_CURSO[qual] : rot }));
      b.disabled = !!st.acao;
      b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(p, r, b); });
      bts.push(b);
    };
    if (s.operacao === 'merge') {
      bt('concluir', 'check', p.repo && s.upstream ? 'Concluir e enviar' : 'Concluir junção', 'Fecha a junção com o que você resolveu' + (p.repo && s.upstream ? ' e envia para ' + s.upstream : ''), concluirLinha, true);
      bt('cancelar', 'fechar', 'Cancelar junção', 'Volta a pasta para antes da junção (os seus commits ficam)', cancelarLinha, false);
    } else if (!travado) {
      if (r.totalAlteracoes) {
        bt('salvar', p.repo ? 'enviar' : 'check', p.repo ? 'Salvar e enviar' : 'Salvar',
          p.repo ? 'Faz um commit com as alterações de ' + p.nome + ' (você escreve a mensagem) e envia para o GitHub' : 'Faz um commit com as alterações de ' + p.nome + ' (esta pasta não está ligada ao GitHub)', salvarLinha, true);
        if (ignoraveisDe(p).length) bt('ignorar', 'fechar', 'Ignorar', 'O git deixa de oferecer as alterações de ' + p.nome + ' para commit (só nesta pasta deste computador; os arquivos ficam no disco como estão)', ignorarLinha, false);
      } else if (r.aFrente && r.atras && p.repo && s.upstream) {
        bt('juntar', 'girar', 'Juntar e enviar', 'Junta os seus ' + commits(r.aFrente) + ' com os ' + r.atras + ' do GitHub (desfaz se der conflito) e envia', juntarLinha, true);
      } else if (podeEnviarProjeto(p, r)) {
        bt('enviar', 'enviar', r.aFrente ? 'Enviar ' + commits(r.aFrente) : 'Criar branch no GitHub', 'Envia para ' + (s.upstream || 'o GitHub') + ', depois de confirmar', enviarLinha, true);
      }
      if (r.atras && !r.aFrente && podePuxarProjeto(p, r)) {
        bt('receber', 'baixar', 'Receber ' + r.atras, 'Traz ' + commits(r.atras) + ' de ' + s.upstream + ' sem mesclar', receberLinha, false);
      }
    }
    if (p.git && !s.operacao) bt('branch', 'branch', 'Branch', 'Trocar de branch ou criar um novo em ' + p.nome, abrirMenuBranch, false);
    return bts.length ? h('div', { class: 'gs-linha-acoes' }, ...bts) : null;
  }

  async function acaoLinha(r, qual, fn) {
    if (st.acao || !st.api || typeof st.api.post !== 'function') return;
    const nome = proj.nome;
    fecharMenu();
    st.acao = 'linha:' + r.id;
    st.linhaAcao = qual;
    avisoCard('');
    fimCard(null);
    renderCard();
    try {
      const res = await fn();
      if (res && proj.nome === nome) avisoCard(res.msg, !!res.erro);
    } catch (e) {
      if (proj.nome === nome) {
        guardarProjeto(e && e.corpo && e.corpo.projeto);
        avisoCard(textoErro(e), true);
      }
    } finally {
      st.acao = '';
      st.linhaAcao = '';
      render();
      if (proj.nome) lerProjeto(); else renderCard();
    }
  }

  // Envia (push confirmado); se o GitHub recusar por ter commits novos, junta (merge que se desfaz no conflito) e
  // tenta de novo. juntarAntes: a última busca já viu commits novos no GitHub.
  async function enviarJuntando(p, juntarAntes, sha) {
    const pre = prefixoLinha(p);
    const salvo = sha ? 'Salvo neste computador (commit ' + sha + ')' : 'Os commits ficaram neste computador';
    const juntar = async () => {
      try {
        const d = await st.api.post('/repos/pull', { pasta: p.pasta, mesclar: true, confirmar: true });
        guardarProjeto(d && d.projeto);
        return null;
      } catch (e) {
        const c = (e && e.corpo) || {};
        guardarProjeto(c.projeto);
        const arqs = Array.isArray(c.arquivos) ? c.arquivos : [];
        if (c.codigo !== 'conflito') return pre + salvo + ', mas não deu para juntar com o GitHub: ' + textoErro(e);
        const lista = (arqs.slice(0, 3).join(', ') || 'alguns arquivos') + (arqs.length > 3 ? ' e mais ' + (arqs.length - 3) : '');
        // Conflito: o Orbit já desfez. Pergunta se abre a junção para o usuário resolver no editor.
        const abrir = await st.api.confirmar({
          titulo: 'Resolver o conflito no editor?',
          mensagem: 'O GitHub e este computador mudaram as mesmas linhas de ' + lista + '. O Orbit desfez a tentativa e nada se perdeu. Ele pode abrir a junção com os dois lados marcados no arquivo (<<<<<<<) para você escolher o que fica; depois é só clicar Concluir.',
          botao: 'Abrir para resolver',
          ancora: cui.repos,
        });
        if (!abrir) return pre + salvo + '. O envio ficou para depois: o GitHub mudou as mesmas linhas de ' + lista + '.';
        try {
          const d2 = await st.api.post('/repos/pull', { pasta: p.pasta, mesclar: true, confirmar: true, manterConflito: true });
          guardarProjeto(d2 && d2.projeto);
          return null; // juntou sem conflito desta vez (o GitHub mudou de novo): segue para o envio
        } catch (e2) {
          const c2 = (e2 && e2.corpo) || {};
          guardarProjeto(c2.projeto);
          if (c2.codigo === 'resolver') return { aberto: true, msg: pre + 'junção aberta. Resolva os trechos marcados com <<<<<<< em ' + lista + ', salve e clique Concluir e enviar.' };
          return pre + salvo + ', mas não deu para abrir a junção: ' + textoErro(e2);
        }
      }
    };
    const falhou = (f) => (typeof f === 'object' ? { erro: false, msg: f.msg } : { erro: true, msg: f });
    if (juntarAntes) { const f = await juntar(); if (f) return falhou(f); }
    const empurrar = () => st.api.post('/repos/push', { pasta: p.pasta, confirmar: true });
    let d;
    try {
      d = await empurrar();
    } catch (e) {
      const c = (e && e.corpo) || {};
      if (c.codigo !== 'rejeitado') return { erro: true, msg: pre + salvo + ', mas não deu para enviar: ' + textoErro(e) };
      const f = await juntar();
      if (f) return falhou(f);
      try { d = await empurrar(); } catch (e2) { return { erro: true, msg: pre + salvo + ', mas não deu para enviar: ' + textoErro(e2) }; }
    }
    guardarProjeto(d && d.projeto);
    const up = (d && d.projeto && d.projeto.status && d.projeto.status.upstream) || 'o GitHub';
    return { msg: pre + (sha ? 'salvo e enviado para ' + up + ' (commit ' + sha + ').' : 'enviado para ' + up + '.') };
  }

  function salvarLinha(p, r) {
    return acaoLinha(r, 'salvar', async () => {
      const pre = prefixoLinha(p);
      const enviar = !!p.repo;
      const ancora = () => linhaEl(r) || cui.repos;
      let prev = await st.api.post('/repos/previa', { pasta: p.pasta });
      if (prev.operacao || prev.conflitos) return { erro: true, msg: pre + 'há um merge ou conflito em andamento. Termine no editor antes de salvar.' };
      if (prev.geradas && prev.geradas.length) {
        const ok = await st.api.confirmar({
          titulo: 'Deixar fora do git?',
          mensagem: 'Estes itens são gerados ou do sistema e costumam ficar no .gitignore. O Orbit acrescenta ao .gitignore de ' + p.nome + ' (os arquivos continuam no disco) e segue com o resto. Para commitar junto, use a aba Repositórios.',
          itens: prev.geradas.map((g) => g.padrao + ' — ' + plural(g.arquivos, 'arquivo', 'arquivos') + ', ' + g.motivo),
          botao: 'Ignorar e seguir',
          ancora: ancora(),
        });
        if (!ok) return null;
        await st.api.post('/repos/ignorar', { pasta: p.pasta, padroes: prev.geradas.map((g) => g.padrao), confirmar: true });
        prev = await st.api.post('/repos/previa', { pasta: p.pasta });
      }
      if (prev.enormes && prev.enormes.length) {
        return { erro: true, msg: pre + 'o GitHub recusa arquivos acima de 100 MB: ' + prev.enormes.slice(0, 3).map((a) => a.arquivo + ' (' + a.mb + ' MB)').join(', ') + '. Ponha no .gitignore antes de salvar.' };
      }
      let sha = '';
      if (prev.arquivos) {
        const avisos = [
          ...(prev.credenciais || []).map((c) => '⚠ ' + c.arquivo + ':' + c.linha + ' parece ter ' + c.tipo),
          ...(prev.sensiveis || []).map((a) => '⚠ ' + a + ' costuma guardar senha ou chave'),
          ...(prev.grandes || []).map((a) => '⚠ ' + a.arquivo + ' tem ' + a.mb + ' MB'),
        ];
        const destino = !enviar ? '' : prev.upstream ? ' e vão para ' + prev.upstream : ' e criam o branch ' + prev.branch + ' no GitHub';
        const texto = [
          plural(prev.arquivos, 'arquivo vai', 'arquivos vão') + ' num commit no branch ' + (prev.branch || '(solto)') + destino + '.',
          enviar && prev.atras ? 'O GitHub tem ' + commits(prev.atras) + ' novos: o Orbit junta antes de enviar; se der conflito, desfaz e avisa.' : '',
          ...avisos.slice(0, 6),
          ...(prev.lista || []).slice(0, avisos.length ? 4 : 8).map((i) => '· ' + i),
          prev.arquivos > 8 ? '… e mais ' + (prev.arquivos - Math.min(8, (prev.lista || []).length)) : '',
        ].filter(Boolean).join('\n');
        const resp = await st.api.perguntar({
          titulo: (enviar ? 'Salvar e enviar ' : 'Salvar ') + p.nome + '?', texto,
          campo: { valor: prev.sugestao || '', dica: 'Descreva o que mudou', max: 300 },
          sim: avisos.length ? (enviar ? 'Salvar e enviar mesmo assim' : 'Salvar mesmo assim') : enviar ? 'Salvar e enviar' : 'Salvar',
          perigo: avisos.length > 0, ancora: ancora(),
        });
        if (!resp || !resp.ok) return null;
        const mensagem = String(resp.valor || '').trim() || prev.sugestao || 'Atualização';
        const c = await st.api.post('/repos/commit', { pasta: p.pasta, mensagem, confirmar: true });
        guardarProjeto(c && c.projeto);
        sha = (c && c.commit && c.commit.sha) || '';
        if (!enviar) return { msg: pre + 'salvo neste computador (commit ' + sha + ').' };
      } else if (!prev.adiante || !enviar) {
        return { msg: pre + 'nada para salvar.' };
      }
      return enviarJuntando(p, prev.atras > 0, sha);
    });
  }

  // Ignorar (20/10): os arquivos novos vão para o info/exclude do git e os já acompanhados ganham skip-worktree; os
  // dois valem só nesta pasta e não viram alteração, então o card fica Em dia. O que estiver preparado fica.
  function ignorarLinha(p, r) {
    return acaoLinha(r, 'ignorar', async () => {
      const pre = prefixoLinha(p);
      const arquivos = ignoraveisDe(p);
      if (!arquivos.length) return { msg: pre + 'nada para ignorar.' };
      const d = await postarConfirmando('/repos/ignorar', { pasta: p.pasta, local: true, arquivos }, linhaEl(r) || cui.repos);
      if (!d) return null;
      guardarProjeto(d.projeto);
      const rest = (d.projeto && d.projeto.status && d.projeto.status.alteracoes) || 0;
      return { msg: pre + plural(arquivos.length, 'item ignorado', 'itens ignorados') + ' neste computador.' + (rest ? ' ' + plural(rest, 'alteração preparada continua', 'alterações preparadas continuam') + ': salve ou desfaça no editor.' : '') };
    });
  }

  function enviarLinha(p, r) {
    return acaoLinha(r, 'enviar', async () => {
      const lote = await postarEmLote('/repos/push', [p], linhaEl(r) || cui.enviar);
      if (lote.cancelado) return null;
      if (lote.falhas.length) return { erro: true, msg: prefixoLinha(p) + textoErro(lote.falhas[0].e) };
      const d = lote.feitos[0] && lote.feitos[0].d;
      return { msg: prefixoLinha(p) + (d && d.enviados ? 'enviado: ' + commits(d.enviados) + ' para o GitHub.' : 'branch criado no GitHub.') };
    });
  }

  function receberLinha(p, r) {
    return acaoLinha(r, 'receber', async () => {
      const lote = await postarEmLote('/repos/pull', [p], linhaEl(r) || cui.enviar);
      if (lote.cancelado) return null;
      if (lote.falhas.length) return { erro: true, msg: prefixoLinha(p) + textoErro(lote.falhas[0].e) };
      const d = lote.feitos[0] && lote.feitos[0].d;
      return { msg: prefixoLinha(p) + (d && d.recebidos ? 'recebido do GitHub: ' + commits(d.recebidos) + '.' : 'nada novo no GitHub.') };
    });
  }

  function juntarLinha(p, r) {
    return acaoLinha(r, 'juntar', async () => {
      if (rastreadasDe(p)) return { erro: true, msg: prefixoLinha(p) + 'há alterações sem commit: use Salvar e enviar.' };
      const ok = await st.api.confirmar({
        titulo: 'Juntar com o GitHub e enviar?',
        mensagem: 'O seu ' + p.status.branch + ' tem ' + commits(r.aFrente) + ' que o GitHub não tem, e o GitHub tem ' + r.atras + ' que este computador não tem. O Orbit junta os dois num commit de merge e envia. Se der conflito, ele desfaz e nada muda.',
        botao: 'Juntar e enviar',
        ancora: linhaEl(r) || cui.enviar,
      });
      if (!ok) return null;
      return enviarJuntando(p, true, '');
    });
  }

  function concluirLinha(p, r) {
    return acaoLinha(r, 'concluir', async () => {
      const pre = prefixoLinha(p);
      let c;
      try {
        c = await st.api.post('/repos/concluir', { pasta: p.pasta });
      } catch (e) {
        const corpo = (e && e.corpo) || {};
        guardarProjeto(corpo.projeto);
        return { erro: true, msg: pre + textoErro(e) };
      }
      guardarProjeto(c && c.projeto);
      const sha = (c && c.commit && c.commit.sha) || '';
      const s = (c && c.projeto && c.projeto.status) || p.status || {};
      if (!p.repo || !s.upstream) return { msg: pre + 'junção concluída (commit ' + sha + ').' };
      return enviarJuntando(p, false, sha);
    });
  }

  function cancelarLinha(p, r) {
    return acaoLinha(r, 'cancelar', async () => {
      const d = await postarConfirmando('/repos/cancelar-juncao', { pasta: p.pasta }, linhaEl(r) || cui.repos);
      if (!d) return null;
      guardarProjeto(d.projeto);
      return { msg: prefixoLinha(p) + 'junção cancelada: a pasta voltou a ficar como antes dela.' };
    });
  }

  // ── menu Branch: os branches da pasta (os locais e os que só existem no GitHub) e "Novo branch…" ──
  const menu = { el: null, pasta: '', ancora: null };
  function fecharMenu() {
    if (!menu.el) return;
    menu.el.remove();
    menu.el = null;
    menu.pasta = '';
    document.removeEventListener('pointerdown', foraDoMenu, true);
    document.removeEventListener('keydown', teclaNoMenu, true);
    window.removeEventListener('resize', fecharMenu);
    const a = menu.ancora;
    menu.ancora = null;
    if (a && a.isConnected && menu.devolverFoco) a.focus({ preventScroll: true });
  }
  function foraDoMenu(ev) {
    if (menu.el && !menu.el.contains(ev.target) && !(menu.ancora && menu.ancora.contains(ev.target))) { menu.devolverFoco = false; fecharMenu(); }
  }
  function teclaNoMenu(ev) {
    if (!menu.el) return;
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); menu.devolverFoco = true; fecharMenu(); return; }
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const itens = [...menu.el.querySelectorAll('button:not([disabled])')];
    if (!itens.length) return;
    ev.preventDefault();
    const i = itens.indexOf(document.activeElement);
    itens[(i + (ev.key === 'ArrowDown' ? 1 : -1) + itens.length) % itens.length].focus();
  }
  function posicionarMenu() {
    const el = menu.el, a = menu.ancora;
    if (!el || !a || !a.isConnected) return;
    const r = a.getBoundingClientRect(), m = 8, w = el.offsetWidth, alt = el.offsetHeight;
    const x = Math.max(m, Math.min(r.left, innerWidth - w - m));
    const y = r.bottom + 6 + alt <= innerHeight - m ? r.bottom + 6 : Math.max(m, r.top - 6 - alt);
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
  }

  async function abrirMenuBranch(p, r, ancora) {
    if (menu.el && menu.pasta === p.pasta) { menu.devolverFoco = true; fecharMenu(); return; }
    fecharMenu();
    const corpo = h('div', { class: 'gs-menu-corpo' }, h('p', { class: 'gs-menu-nota', text: 'Lendo os branches…' }));
    const el = h('div', { class: 'gs-menu', role: 'menu', 'aria-label': 'Branches de ' + p.nome }, h('p', { class: 'gs-menu-tit', text: 'Branches de ' + p.nome }), corpo);
    document.body.append(el);
    Object.assign(menu, { el, pasta: p.pasta, ancora, devolverFoco: false });
    posicionarMenu();
    document.addEventListener('pointerdown', foraDoMenu, true);
    document.addEventListener('keydown', teclaNoMenu, true);
    window.addEventListener('resize', fecharMenu);
    let d;
    try {
      d = await st.api.get('/repos/branches?pasta=' + encodeURIComponent(p.pasta));
    } catch (e) {
      if (menu.el === el) { corpo.replaceChildren(h('p', { class: 'gs-menu-nota erro', text: textoErro(e) })); posicionarMenu(); }
      return;
    }
    if (menu.el !== el) return;
    const item = (nome, info, atual, fn) => h('button', { type: 'button', class: 'gs-menu-item' + (atual ? ' atual' : ''), role: 'menuitem', 'aria-current': atual ? 'true' : null, title: atual ? 'Branch atual' : 'Trocar para ' + nome, onclick: fn },
      h('span', { class: 'gs-menu-marca', 'aria-hidden': 'true' }, atual ? icone('check', 12) : null), h('span', { class: 'gs-menu-nome', text: nome }), info ? h('span', { class: 'gs-menu-info', text: info }) : null);
    const filhos = [];
    for (const b of d.locais || []) {
      const info = !b.upstream ? 'só aqui' : [b.adiante ? '↑' + b.adiante : '', b.atras ? '↓' + b.atras : ''].filter(Boolean).join(' ');
      const atual = b.nome === d.atual;
      filhos.push(item(b.nome, info, atual, atual ? () => { menu.devolverFoco = true; fecharMenu(); } : () => trocarBranch(p, r, b.nome, false)));
    }
    if ((d.remotos || []).length) {
      filhos.push(h('p', { class: 'gs-menu-sec', text: 'Só no GitHub' }));
      for (const b of d.remotos) filhos.push(item(b.nome, 'baixar', false, () => trocarBranch(p, r, b.nome, false)));
    }
    if (!filhos.length) filhos.push(h('p', { class: 'gs-menu-nota', text: 'Ainda não há branches com commits.' }));
    if (d.soUm) filhos.push(h('p', { class: 'gs-menu-nota', text: 'Esta pasta acompanha só o branch ' + (d.atual || 'atual') + ' do GitHub (clone de um branch só); os outros não aparecem aqui.' }));
    filhos.push(h('div', { class: 'gs-menu-sep', 'aria-hidden': 'true' }));
    filhos.push(h('button', { type: 'button', class: 'gs-menu-item gs-menu-novo', role: 'menuitem', onclick: () => novoBranch(p, r) },
      h('span', { class: 'gs-menu-marca', 'aria-hidden': 'true' }, icone('mais', 12)), h('span', { class: 'gs-menu-nome', text: 'Novo branch…' })));
    corpo.replaceChildren(...filhos);
    posicionarMenu();
    const foco = corpo.querySelector('.gs-menu-item.atual') || corpo.querySelector('.gs-menu-item');
    if (foco) foco.focus({ preventScroll: true });
  }

  function trocarBranch(p, r, nome, criar) {
    return acaoLinha(r, 'branch', async () => {
      const d = await postarConfirmando('/repos/branch', Object.assign({ pasta: p.pasta, nome }, criar ? { criar: true } : {}), linhaEl(r) || cui.repos);
      if (!d) return null;
      guardarProjeto(d.projeto);
      return { msg: prefixoLinha(p) + (criar ? 'branch ' + nome + ' criado; o Enviar o cria também no GitHub.' : 'agora no branch ' + nome + '.') };
    });
  }

  async function novoBranch(p, r) {
    fecharMenu();
    const atual = (p.status && (p.status.branch || p.status.destacado)) || '';
    const resp = await st.api.perguntar({
      titulo: 'Novo branch em ' + p.nome,
      texto: 'Começa a partir de ' + (atual || 'o commit atual') + '. As alterações sem commit vão junto para o branch novo.',
      campo: { valor: '', dica: 'nome-do-branch', max: 100 },
      sim: 'Criar e trocar',
      ancora: linhaEl(r) || cui.repos,
    });
    const nome = resp && resp.ok ? String(resp.valor || '').trim().replace(/\s+/g, '-') : '';
    if (nome) trocarBranch(p, r, nome, true);
  }

  // Botão com ícone + rótulo; durante a ação o ícone "girar" roda. tom: '' | 'ok' | 'erro' (fim da ação).
  function estadoBotao(b, { ico, rot, girando = false, tom = '' }) {
    if (!b) return;
    if (b.dataset.icone !== ico) {
      b.dataset.icone = ico;
      b.firstChild.replaceWith(icone(ico, 14));
    }
    b.classList.toggle('gs-girando', girando);
    if (girando) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
    if (tom) b.dataset.tom = tom; else delete b.dataset.tom;
    b.lastChild.textContent = rot;
  }

  // Identidade: logo do GitHub, repositório (dono/nome) com Privado/Público e a conta conectada.
  function renderId(rs) {
    const completo = (rs.find((r) => r.remoto) || {}).remoto || '';
    const [dono, nomeRepo] = completo ? completo.split('/') : ['', ''];
    const privado = rs.find((r) => r.remoto === completo && typeof r.privado === 'boolean');
    const gh = card.perfil && card.perfil.github;
    const login = gh && gh.login ? gh.login : '';
    const filhos = [h('span', { class: 'gs-gh', 'aria-hidden': 'true' }, icone('github', 18))];
    // Linha do repositório: o dono só aparece quando não é a conta conectada (aí a linha de baixo já diz quem é).
    const linhaRepo = h('span', { class: 'gs-id-repo' });
    if (completo) {
      linhaRepo.title = 'github.com/' + completo;
      if (dono && dono !== login) linhaRepo.append(h('span', { class: 'gs-dono', text: dono + '/' }));
      linhaRepo.append(h('b', { text: nomeRepo }));
      if (privado) {
        linhaRepo.append(h('span', { class: 'gs-vis' + (privado.privado ? ' privado' : ''), title: privado.privado ? 'Repositório privado: só você e quem você convidar veem' : 'Repositório público: qualquer pessoa vê' },
          icone(privado.privado ? 'cadeado' : 'aberto', 11), privado.privado ? 'Privado' : 'Público'));
      }
    } else {
      linhaRepo.append(h('b', { text: 'GitHub' }));
    }
    const conta = h('span', { class: 'gs-conta' });
    if (login) {
      if (gh.avatar) conta.append(h('img', { class: 'gs-av', src: gh.avatar, alt: '', width: 16, height: 16, decoding: 'async' }));
      else conta.append(h('span', { class: 'gs-av gs-av-letra', 'aria-hidden': 'true', text: login[0].toUpperCase() }));
      conta.append(h('span', { class: 'gs-login', text: login }));
      if (gh.expirado) { conta.classList.add('expirado'); conta.append(h('span', { class: 'gs-conta-nota', text: '· conexão expirou' })); }
      conta.title = (gh.nome ? gh.nome + ' · ' : '') + 'conta do GitHub conectada no Orbit' + (gh.expirado ? ' (o token expirou: conecte de novo pelo perfil)' : '');
    } else {
      conta.classList.add('sem');
      conta.append(h('span', { text: card.perfil === undefined ? 'Lendo a conta…' : 'GitHub não conectado' }));
      if (card.perfil !== undefined) conta.title = 'Conecte o GitHub pelo botão de perfil, no pé da lateral.';
    }
    filhos.push(h('span', { class: 'gs-id-txt' }, linhaRepo, conta));
    if (completo) {
      filhos.push(h('a', { class: 'gs-abrir', href: 'https://github.com/' + completo, target: '_blank', rel: 'noopener noreferrer', title: 'Abrir ' + completo + ' no GitHub', 'aria-label': 'Abrir ' + completo + ' no GitHub' }, icone('externo', 14)));
    }
    cui.id.replaceChildren(...filhos);
  }

  // Botão da direita (17/10): Enviar quando há o que enviar; sem nada para enviar, vira Puxar
  // só se a última busca já viu novidades; sem nenhuma das duas, some. Durante e logo depois de uma ação, fica a ação em curso.
  function botaoEnviarOuPuxar({ pode, podePuxar, novidades, enviando, puxando, tituloEnviar, tituloPuxar }) {
    const fim = card.fim;
    const ocupado = !!st.acao;
    const puxar = puxando || (fim ? fim.qual === 'puxar' : !pode && !enviando);
    const b = cui.enviar;
    b.dataset.acao = puxar ? 'puxar' : 'enviar';
    const emCurso = puxar ? puxando : enviando;
    const meuFim = fim && fim.qual === (puxar ? 'puxar' : 'enviar') ? fim : null;
    // Igual ao GitHub (nada para enviar nem novidades vistas): só o Sincronizar fica (20/10).
    b.hidden = puxar && !emCurso && !meuFim && !(novidades > 0);
    if (b.hidden) return;
    b.disabled = ocupado || (puxar ? !podePuxar : !pode);
    b.classList.toggle('solido', emCurso || !!(meuFim && meuFim.ok) || (puxar ? podePuxar && novidades > 0 : pode));
    estadoBotao(b, emCurso ? { ico: 'girar', rot: puxar ? 'Puxando…' : 'Enviando…', girando: true }
      : meuFim ? (meuFim.ok ? { ico: 'check', rot: puxar ? 'Atualizado' : 'Enviado', tom: 'ok' } : { ico: 'alerta', rot: 'Tentar de novo', tom: 'erro' })
        : puxar ? { ico: 'baixar', rot: 'Puxar' } : { ico: 'enviar', rot: 'Enviar' });
    b.title = puxar ? tituloPuxar : tituloEnviar;
  }

  function linhaCard(r) {
    if (r.ausente) {
      return h('div', { class: 'gs-repo', 'data-repo': r.id },
        h('div', { class: 'gs-alvo' },
          h('span', { class: 'gs-cab' }, h('span', { class: 'sc-ponto', 'aria-hidden': 'true' }), h('b', { class: 'gs-nome', text: r.nome || r.id }), h('span', { class: 'gs-envio', text: 'sem git nesta pasta' }))));
    }
    const tom = r.aviso === 'conflito' || r.aviso === 'credencial' || r.aviso === 'erro' ? 'perigo'
      : r.aviso && r.aviso !== 'alteracoes' ? 'aviso' : r.atras ? 'atras' : pendentes(r) ? 'neutro' : 'ok';
    const alt = alteracoesDe(r), com = r.aFrente || 0, atr = r.atras || 0;
    const quente = muitas(r);
    const envioIso = Date.parse(r.ultimoEnvio || '') ? r.ultimoEnvio : '';
    // Projeto filtrado: o Orbit não registra os envios dele, então a linha fica sem o "enviado há…".
    const envio = r.projeto ? null : h('span', { class: 'gs-envio' + (velho(r) ? ' quente' : ''), text: envioIso ? 'enviado ' + haQuanto(envioIso) : 'sem envio registrado' });
    if (envio && envioIso) envio.title = 'Último envio deste computador: ' + dataHora(envioIso);

    const pilula = (n, um, varios, extra, ico) => h('span', { class: 'gs-chip' + (extra || '') },
      ico ? icone(ico, 12) : null, h('b', { text: String(n) }), ' ' + (n === 1 ? um : varios));
    const chips = [];
    if (alt) chips.push(pilula(alt, 'alteração', 'alterações', quente ? ' quente' : ''));
    if (com) chips.push(pilula(com, 'commit', 'commits', quente ? ' quente' : ''));
    if (atr) chips.push(pilula(atr, 'para puxar', 'para puxar', ' atras', 'baixar'));
    if (!chips.length && !(r.projeto && r.aviso)) chips.push(h('span', { class: 'gs-chip ok' }, icone('check', 12), 'Igual ao GitHub'));

    const arqs = r.alteracoes || [];
    const abre = arqs.length > 0;
    const aberto = abre && card.abertos.has(r.id);
    const idLista = 'gs-arqs-' + r.id;
    const rotulo = (r.nome || r.id) + ', branch ' + (r.branch || '') + ': ' + plural(alt, 'alteração', 'alterações') + ', ' + plural(com, 'commit não enviado', 'commits não enviados') + ', ' + plural(atr, 'novidade', 'novidades') + ' para puxar';
    const cab = h('span', { class: 'gs-cab' },
      h('span', { class: 'sc-ponto', 'data-tom': tom, 'aria-hidden': 'true' }),
      h('b', { class: 'gs-nome', text: r.nome || r.id }),
      r.branch ? h('code', { class: 'gs-branch', title: 'Branch ' + r.branch }, icone('branch', 11), h('span', { text: r.branch })) : null,
      envio,
      abre ? h('span', { class: 'gs-seta', 'aria-hidden': 'true' }, icone('seta', 12)) : null);
    const corpo = [cab];
    // Último commit: a mensagem (cortada com reticências; inteira no title), o hash e quando foi feito.
    const c = r.commit;
    if (c && (c.msg || c.hash)) {
      const quando = Date.parse(c.quando || '') ? c.quando : '';
      corpo.push(h('span', { class: 'gs-commit', title: 'Último commit: ' + (c.msg || '') + (c.hash ? ' · ' + c.hash : '') + (quando ? ' · ' + dataHora(quando) : '') },
        icone('commit', 12),
        h('span', { class: 'gs-commit-msg', text: c.msg || '(sem mensagem)' }),
        c.hash ? h('code', { class: 'gs-hash', text: c.hash.slice(0, 7) }) : null,
        quando ? h('span', { class: 'gs-commit-quando', text: haQuanto(quando) }) : null));
    }
    corpo.push(h('span', { class: 'gs-chips' }, ...chips));
    const alvo = abre
      ? h('button', { type: 'button', class: 'gs-alvo', 'aria-expanded': String(aberto), 'aria-controls': idLista, 'aria-label': rotulo + (aberto ? '' : '. Mostrar os arquivos') }, ...corpo)
      : h('div', { class: 'gs-alvo', 'aria-label': rotulo }, ...corpo);
    if (abre) {
      alvo.addEventListener('click', () => {
        if (card.abertos.has(r.id)) card.abertos.delete(r.id); else card.abertos.add(r.id);
        renderCard();
        const novo = cui.repos.querySelector('.gs-repo[data-repo="' + r.id + '"] .gs-alvo');
        if (novo) novo.focus({ preventScroll: true });
      });
    }
    const filhos = [alvo];
    if (r.aviso && r.aviso !== 'alteracoes' && r.detalhe) {
      filhos.push(h('p', { class: 'gs-aviso', 'data-tom': tom, title: r.detalhe }, icone(tom === 'perigo' ? 'alerta' : 'nuvem', 13), h('span', { text: r.detalhe })));
    }
    if (r.projeto) filhos.push(acoesLinha(r));
    if (aberto) {
      const ul = h('ul', { class: 'sc-arqs gs-arqs', id: idLista }, ...arqs.slice(0, MAX_ARQS).map((a) =>
        h('li', { title: a.arquivo }, h('span', { class: 'sc-arq', text: a.arquivo }), h('span', { class: 'sc-tipo', 'data-tipo': a.tipo, text: a.tipo }))));
      if (alt > MAX_ARQS) ul.append(h('li', { class: 'sc-mais', text: '+ ' + (alt - MAX_ARQS) + ' ' + (alt - MAX_ARQS === 1 ? 'outro' : 'outros') }));
      filhos.push(ul);
    }
    return h('div', { class: 'gs-repo' + (aberto ? ' aberto' : ''), 'data-repo': r.id, 'data-tom': tom }, ...filhos);
  }

  // Sem projeto no filtro o card fica à vista, com um aviso; com projeto, mostra o repositório dele.
  function renderCard() {
    if (!card.el) return;
    renderCardProjeto();
  }

  window.Sincronia = { montarCard, projetoMudou };
})();
