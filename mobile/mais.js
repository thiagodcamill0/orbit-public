// Orbit no celular — tela mais (onda 3): lista "Mais", subtela Notificações (#mais/notificacoes) e subtela Este aparelho
// (#mais/aparelho). Uso do plano, Ideias e Histórico de avisos (#mais/uso|ideias|historico) são de outros donos.
// API no contrato, "App do celular". Nada de innerHTML com dado do servidor; só tokens do design system do PC.
(() => {
  'use strict';
  const OM = window.OM;
  if (!OM || !OM.telas) return;
  const { h, txt } = OM;

  const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;   // a mesma do /config do PC
  const min = (hhmm) => { const [a, b] = String(hhmm).split(':'); return Number(a) * 60 + Number(b); };

  // ───────────────────────────── notificações: estado compartilhado (a lista Mais mostra o valor ao vivo) ─────────────────────────────
  // naoPerturbe: { ativo, agendado, inicio, fim } e notificar: { precisa, terminou }, como o GET /remoto/notificacoes.
  const NOTIF = { dados: null, push: null };

  // Mesma regra do PC (servidor.mjs, naoPerturbeAgora): ligado agora, ou agendado dentro da janela (que pode cruzar a meia-noite).
  function npAgora(np, t = Date.now()) {
    if (!np) return false;
    if (np.ativo) return true;
    if (!np.agendado || !HORA.test(np.inicio) || !HORA.test(np.fim)) return false;
    const d = new Date(t);
    const agora = d.getHours() * 60 + d.getMinutes();
    const ini = min(np.inicio), fim = min(np.fim);
    if (ini === fim) return false;
    return ini < fim ? agora >= ini && agora < fim : agora >= ini || agora < fim;
  }

  async function lerNotificacoes() {
    const d = await OM.api('GET', '/remoto/notificacoes');
    const np = d && d.naoPerturbe && typeof d.naoPerturbe === 'object' ? d.naoPerturbe : {};
    const n = d && d.notificar && typeof d.notificar === 'object' ? d.notificar : {};
    NOTIF.dados = {
      naoPerturbe: {
        ativo: !!np.ativo, agendado: !!np.agendado,
        inicio: HORA.test(np.inicio) ? np.inicio : '22:00', fim: HORA.test(np.fim) ? np.fim : '07:00',
      },
      notificar: { precisa: !!n.precisa, terminou: !!n.terminou },
    };
    return NOTIF.dados;
  }
  async function lerPush() {
    try { NOTIF.push = await OM.push.situacao(); } catch { NOTIF.push = null; }
    return NOTIF.push;
  }

  // ───────────────────────────── peças ─────────────────────────────
  const ic = (nome, tam) => h('span', { class: 'mais-ico', 'aria-hidden': 'true' }, OM.icone(nome, tam || 18));

  // Linha de navegação: ícone, rótulo, valor à direita e chevron.
  function linhaNav({ icone, rotulo, hash, valor }) {
    const v = h('span', { class: 'mais-valor' }, valor || '');
    const el = h('button', { class: 'mais-linha toque', type: 'button', dados: { destino: hash }, onclick: () => OM.rotas.ir(hash) },
      ic(icone),
      h('span', { class: 'mais-rot' }, rotulo),
      v,
      h('span', { class: 'mais-chev', 'aria-hidden': 'true' }, OM.icone('chevron', 16)));
    return { el, valor: (t) => txt(v, t || '') };
  }

  // Linha com chave (input.chave dentro de label: a linha inteira é o alvo de toque). Devolve { el, input, hint }.
  function linhaChave({ rotulo, sub, id }) {
    const input = h('input', { class: 'chave', type: 'checkbox', id: id || null });
    const hint = h('small', { class: 'mais-sub' }, sub || '');
    if (!sub) hint.hidden = true;
    const el = h('label', { class: 'mais-linha mais-linha-chave' },
      h('span', { class: 'mais-rot mais-rot-bloco' }, h('span', null, rotulo), hint),
      input);
    return { el, input, hint };
  }

  const cartao = (titulo, ...filhos) => h('section', { class: 'mais-cartao' }, titulo ? h('h3', { class: 'mais-tit' }, titulo) : null, ...filhos);

  // Botão de ação 44 px.
  const botao = (rotulo, classe, fn) => h('button', { class: ['btn', 'mais-btn', 'toque', classe], type: 'button', onclick: fn }, rotulo);

  const erroTxt = (e) => (e && e.message) || 'tente de novo';

  // ═════════════════════════════ MAIS (raiz) ═════════════════════════════
  OM.telas.registrar('mais', {
    titulo: 'Mais',
    tituloGrande: true,
    montar(cont, params, ctx) {
      const uso = linhaNav({ icone: 'uso', rotulo: 'Uso do plano', hash: '#mais/uso' });
      const ideias = linhaNav({ icone: 'lampada', rotulo: 'Ideias', hash: '#mais/ideias' });
      const hist = linhaNav({ icone: 'historico', rotulo: 'Histórico de avisos', hash: '#mais/historico' });
      const grafo = linhaNav({ icone: 'grafo', rotulo: 'Grafo do brain', hash: '#mais/grafo' });
      const notif = linhaNav({ icone: 'sino', rotulo: 'Notificações', hash: '#mais/notificacoes' });
      const apar = linhaNav({ icone: 'aparelho', rotulo: 'Este aparelho', hash: '#mais/aparelho' });
      ctx.mais = { uso, notif, apar, notificacoesReq: 0 };
      cont.append(
        h('div', { class: 'mais-lista' },
          h('div', { class: 'mais-grupo' }, uso.el, ideias.el, hist.el, grafo.el),
          h('div', { class: 'mais-grupo' }, notif.el, apar.el)));
      ctx.mais.pintar = () => pintarMais(ctx.mais);
    },
    mostrar(ctx) {
      const m = ctx.mais;
      if (!m) return;
      m.pintar();
      // valores que vêm do PC (Não perturbe) e do aparelho (push) são lidos ao voltar para a lista
      const req = ++m.notificacoesReq;
      Promise.allSettled([lerNotificacoes(), lerPush()]).then(() => { if (req === m.notificacoesReq) m.pintar(); });
    },
    atualizar(estado, ctx) { if (ctx.mais) ctx.mais.pintar(); },
    desmontar(ctx) { if (ctx.mais) ctx.mais.notificacoesReq = -1; },
  });

  function pintarMais(m) {
    const u = OM.estado.uso;
    const pct = u && u.cincoHoras && Number.isFinite(Number(u.cincoHoras.pct)) ? Math.round(Number(u.cincoHoras.pct)) : null;
    m.uso.valor(pct == null ? '' : pct + '%');
    const d = NOTIF.dados;
    let v = '';
    if (d && npAgora(d.naoPerturbe)) v = 'Não perturbe';
    else if (NOTIF.push) v = NOTIF.push.ativa ? 'Ligadas' : NOTIF.push.instalado ? 'Desligadas' : 'Instalar';
    m.notif.valor(v);
    const eu = OM.estado.eu;
    m.apar.valor(eu && eu.aparelho && eu.aparelho.nome ? String(eu.aparelho.nome) : '');
  }

  // ═════════════════════════════ NOTIFICAÇÕES ═════════════════════════════
  const PASSOS_IOS = [
    'Abra o Orbit no Safari e toque em Compartilhar.',
    'Escolha "Adicionar à Tela de Início".',
    'Abra o Orbit pelo ícone novo e volte para esta tela.',
  ];

  OM.telas.registrar('notificacoes', {
    titulo: 'Notificações',
    montar(cont, params, ctx) {
      const S = ctx.n = {
        morta: false, sit: null, ocupado: false,
        // push
        pushEstado: h('div', { class: 'mais-estado' }),
        pushAcoes: h('div', { class: 'mais-acoes' }),
        pushTxt: h('p', { class: 'mais-nota' }),
        passos: h('ol', { class: 'mais-passos' }),
        // avisos
        precisa: linhaChave({ rotulo: 'Avisar quando precisar de mim', sub: 'Permissão ou pergunta esperando resposta', id: 'mais-n-precisa' }),
        terminou: linhaChave({ rotulo: 'Avisar quando terminar', sub: 'A sessão acabou o que estava fazendo', id: 'mais-n-terminou' }),
        // não perturbe
        np: linhaChave({ rotulo: 'Ligado agora', sub: 'Sem aviso no celular; a lista segue ao vivo', id: 'mais-np' }),
        ag: linhaChave({ rotulo: 'Todo dia, no horário', sub: '', id: 'mais-np-ag' }),
        ini: h('input', { class: 'mais-hora', type: 'time', id: 'mais-np-ini', 'aria-label': 'Início do não perturbe', required: true }),
        fim: h('input', { class: 'mais-hora', type: 'time', id: 'mais-np-fim', 'aria-label': 'Fim do não perturbe', required: true }),
        aviso: h('p', { class: 'mais-nota mais-erro', hidden: true, role: 'alert' }),
        carregando: h('div', { class: 'mais-carregando esq' }),
        corpo: null,
        off: [],
      };
      S.horas = h('div', { class: 'mais-linha mais-linha-horas' },
        h('span', { class: 'mais-rot' }, 'Das'),
        h('div', { class: 'mais-horas' }, S.ini, h('span', { class: 'mais-ate' }, 'às'), S.fim));
      S.corpo = h('div', { class: 'mais-pilha' },
        cartao('Neste aparelho', S.pushEstado, S.pushTxt, S.passos, S.pushAcoes),
        cartao('Avisar', S.precisa.el, S.terminou.el,
          h('p', { class: 'mais-nota' }, 'Vale para todos os aparelhos pareados. Só sessões abertas pelo Orbit avisam.')),
        cartao('Não perturbe', S.np.el, S.ag.el, S.horas, S.aviso),
        h('p', { class: 'mais-nota mais-nota-solta' }, 'No iPhone as notificações não vibram nem têm botões; tocar nelas abre o Orbit.'));
      S.corpo.hidden = true;
      cont.append(S.carregando, S.corpo);

      S.precisa.input.addEventListener('change', () => gravarAviso(S, 'precisa', S.precisa.input));
      S.terminou.input.addEventListener('change', () => gravarAviso(S, 'terminou', S.terminou.input));
      S.np.input.addEventListener('change', () => gravarNp(S, { ativo: S.np.input.checked }));
      S.ag.input.addEventListener('change', () => gravarNp(S, { agendado: S.ag.input.checked }));
      S.ini.addEventListener('change', () => gravarHora(S, 'inicio', S.ini));
      S.fim.addEventListener('change', () => gravarHora(S, 'fim', S.fim));
      S.off.push(OM.ouvir('visivel', () => { if (OM.rotas.atual().nome === 'notificacoes') carregarNotificacoes(S); }));
      S.off.push(OM.ouvir('conexao', () => { if (OM.rotas.atual().nome === 'notificacoes' && OM.estado.conexao === 'vivo') carregarNotificacoes(S); }));
    },
    mostrar(ctx) { if (ctx.n) carregarNotificacoes(ctx.n); },
    desmontar(ctx) { const S = ctx.n; if (!S) return; S.morta = true; for (const o of S.off) { try { o(); } catch {} } },
  });

  async function carregarNotificacoes(S) {
    if (S.morta) return;
    const [r] = await Promise.allSettled([lerNotificacoes(), lerPush()]);
    if (S.morta) return;
    if (r.status === 'rejected' && !NOTIF.dados) {
      S.carregando.replaceChildren();
      S.carregando.className = 'tela-erro';
      txt(S.carregando, 'Não deu para ler as notificações do PC. ' + erroTxt(r.reason));
      S.carregando.hidden = false; S.corpo.hidden = true;
      return;
    }
    S.carregando.hidden = true; S.corpo.hidden = false;
    pintarNotificacoes(S);
  }

  function pintarNotificacoes(S) {
    const d = NOTIF.dados;
    if (d) {
      S.precisa.input.checked = d.notificar.precisa;
      S.terminou.input.checked = d.notificar.terminou;
      S.np.input.checked = d.naoPerturbe.ativo;
      S.ag.input.checked = d.naoPerturbe.agendado;
      if (document.activeElement !== S.ini) S.ini.value = d.naoPerturbe.inicio;
      if (document.activeElement !== S.fim) S.fim.value = d.naoPerturbe.fim;
      S.ini.disabled = S.fim.disabled = !d.naoPerturbe.agendado;
      S.horas.classList.toggle('inativa', !d.naoPerturbe.agendado);
      const agora = npAgora(d.naoPerturbe);
      txt(S.ag.hint, d.naoPerturbe.agendado ? (agora && !d.naoPerturbe.ativo ? 'Ativo agora' : 'Fora do horário agora') : '');
      S.ag.hint.hidden = !d.naoPerturbe.agendado;
    }
    pintarPush(S);
  }

  // Estado do push: sem suporte · precisa instalar na Tela de Início · bloqueado · desligado · ligado.
  function pintarPush(S) {
    const sit = NOTIF.push;
    S.pushEstado.replaceChildren(); S.pushAcoes.replaceChildren(); S.passos.replaceChildren(); S.passos.hidden = true;
    const linha = (rot, valor, tipo) => S.pushEstado.append(h('div', { class: 'mais-linha mais-linha-info' },
      h('span', { class: 'mais-rot' }, rot), h('span', { class: ['mais-chip', tipo ? 'mais-chip-' + tipo : ''] }, valor)));
    if (!sit) { linha('Notificações push', 'Indisponível', 'off'); txt(S.pushTxt, 'Não deu para ler o estado das notificações deste aparelho.'); return; }
    if (!sit.instalado) {
      linha('Notificações push', 'Precisa instalar', 'aviso');
      txt(S.pushTxt, 'No iPhone, os avisos só chegam com o Orbit instalado na Tela de Início:');
      for (const p of PASSOS_IOS) S.passos.append(h('li', null, p));
      S.passos.hidden = false;
      return;
    }
    if (!sit.suportado) {
      linha('Notificações push', 'Sem suporte', 'off');
      txt(S.pushTxt, 'Este navegador não tem suporte a notificações push. Atualize o iOS (16.4 ou mais novo) e abra o Orbit pela Tela de Início.');
      return;
    }
    if (sit.permissao === 'denied') {
      linha('Notificações push', 'Bloqueadas', 'erro');
      txt(S.pushTxt, 'O aparelho bloqueou as notificações do Orbit. Libere em Ajustes › Notificações › Orbit e volte aqui.');
      return;
    }
    if (sit.ativa) {
      linha('Notificações push', 'Ligadas', 'ok');
      txt(S.pushTxt, 'Este aparelho recebe os avisos escolhidos abaixo.');
      S.pushAcoes.append(botao('Enviar teste', 'contorno', () => testarPush(S)), botao('Desativar', 'perigo', () => desativarPush(S)));
      return;
    }
    linha('Notificações push', 'Desligadas', 'off');
    txt(S.pushTxt, 'Ative para receber aviso quando uma sessão precisar de você ou terminar.');
    S.pushAcoes.append(botao('Ativar notificações', 'solido-claro', () => ativarPush(S)));
  }

  // Executa uma ação do push com os botões travados; recarrega o estado ao fim.
  async function acaoPush(S, fn, okTxt, falhaTxt) {
    if (S.ocupado) return;
    S.ocupado = true;
    const bs = S.pushAcoes.querySelectorAll('button');
    bs.forEach((b) => { b.disabled = true; });
    try {
      await fn();
      if (okTxt) OM.toast(okTxt);
    } catch (e) {
      OM.toast(falhaTxt + ' ' + erroTxt(e));
    } finally {
      S.ocupado = false;
      await lerPush();
      if (!S.morta) pintarPush(S);
    }
  }
  // O iOS só aceita pedir permissão direto de um toque: ativar() é chamado de dentro do onclick, sem await antes.
  const ativarPush = (S) => acaoPush(S, () => OM.push.ativar(), 'Notificações ligadas neste aparelho.', 'Não deu para ativar.');
  const testarPush = (S) => acaoPush(S, () => OM.push.testar(), 'Enviada. Ela deve chegar em alguns segundos.', 'Não deu para testar.');
  async function desativarPush(S) {
    const ok = await OM.confirmar({ titulo: 'Desativar notificações?', texto: 'Este aparelho deixa de receber avisos do Orbit até você ativar de novo.', sim: 'Desativar', nao: 'Cancelar', perigo: true });
    if (ok) acaoPush(S, () => OM.push.desativar(), 'Notificações desativadas.', 'Não deu para desativar.');
  }

  // Chave "avisar": otimista com reversão + toast. POST /remoto/notificar { precisa? | terminou? }.
  async function gravarAviso(S, chave, input) {
    const novo = input.checked;
    input.disabled = true;
    try {
      const r = await OM.api('POST', '/remoto/notificar', { [chave]: novo });
      if (NOTIF.dados) NOTIF.dados.notificar[chave] = r && r.notificar && typeof r.notificar[chave] === 'boolean' ? r.notificar[chave] : novo;
    } catch (e) {
      input.checked = !novo;
      OM.toast('Não deu para salvar o aviso. ' + erroTxt(e));
    } finally { input.disabled = false; }
  }

  // Não perturbe: sempre manda os 4 campos (o PC valida como no /config). `mudar` é o que o usuário alterou agora.
  let gravandoNp = false;
  async function gravarNp(S, mudar, reverter) {
    const atual = NOTIF.dados && NOTIF.dados.naoPerturbe;
    if (!atual) return;
    if (gravandoNp) { pintarNotificacoes(S); return; }
    const corpo = { ativo: atual.ativo, agendado: atual.agendado, inicio: atual.inicio, fim: atual.fim, ...mudar };
    if (typeof corpo.ativo !== 'boolean' || typeof corpo.agendado !== 'boolean' || !HORA.test(corpo.inicio) || !HORA.test(corpo.fim)) {
      pintarNotificacoes(S); OM.toast('Informe início e fim no formato HH:MM.'); return;
    }
    gravandoNp = true;
    // otimista: o que o usuário mexeu já aparece; a resposta confirma
    NOTIF.dados.naoPerturbe = { ativo: corpo.ativo, agendado: corpo.agendado, inicio: corpo.inicio, fim: corpo.fim };
    pintarNotificacoes(S);
    try {
      const r = await OM.api('POST', '/remoto/nao-perturbe', corpo);
      const np = r && r.naoPerturbe;
      if (np && HORA.test(np.inicio) && HORA.test(np.fim)) NOTIF.dados.naoPerturbe = { ativo: !!np.ativo, agendado: !!np.agendado, inicio: np.inicio, fim: np.fim };
    } catch (e) {
      NOTIF.dados.naoPerturbe = atual;
      OM.toast('Não deu para salvar o Não perturbe. ' + erroTxt(e));
    } finally { gravandoNp = false; if (!S.morta) pintarNotificacoes(S); }
  }

  function gravarHora(S, campo, input) {
    const v = input.value;
    const np = NOTIF.dados && NOTIF.dados.naoPerturbe;
    if (!np) return;
    const outro = campo === 'inicio' ? np.fim : np.inicio;
    const msg = !v || !HORA.test(v) ? 'Informe o horário de ' + (campo === 'inicio' ? 'início' : 'fim') + '.'
      : v === outro ? 'Início e fim não podem ser iguais.' : '';
    S.aviso.hidden = !msg; txt(S.aviso, msg);
    if (msg) { input.value = np[campo]; return; }
    gravarNp(S, { [campo]: v });
  }

  // ═════════════════════════════ ESTE APARELHO ═════════════════════════════
  const CONEXAO = {
    vivo: ['Conectado', 'ok'], conectando: ['Conectando…', 'aviso'], reconectando: ['Reconectando…', 'aviso'],
    pc: ['PC desconectado', 'erro'], offline: ['Sem internet', 'erro'], revogado: ['Desconectado', 'erro'],
  };
  const dataPareado = (ms) => {
    try {
      const d = new Date(Number(ms));
      return d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' }) + ', ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  };
  // "Versão": a do cache da casca (orbit-casca-m-vN), quando o navegador deixa ler.
  async function versaoApp() {
    try {
      const chaves = await caches.keys();
      const k = chaves.find((x) => /^orbit-casca-m-v\d+/.test(x));
      return k ? k.replace(/^orbit-casca-m-/, '') : '';
    } catch { return ''; }
  }

  const infoLinha = (rot, valor, id) => {
    const v = h('span', { class: 'mais-valor mais-valor-solto', id: id || null }, valor || '');
    return { el: h('div', { class: 'mais-linha mais-linha-info' }, h('span', { class: 'mais-rot' }, rot), v), v };
  };

  OM.telas.registrar('aparelho', {
    titulo: 'Este aparelho',
    montar(cont, params, ctx) {
      const A = ctx.a = {
        nome: infoLinha('Nome', '', 'mais-ap-nome'),
        desde: infoLinha('Pareado em', '', 'mais-ap-desde'),
        inst: infoLinha('Instalado como app', '', 'mais-ap-inst'),
        versao: infoLinha('Versão do app', '', 'mais-ap-versao'),
        conexao: infoLinha('Conexão', '', 'mais-ap-conexao'),
        push: linhaNav({ icone: 'sino', rotulo: 'Notificações', hash: '#mais/notificacoes' }),
        saindo: false, off: [], morta: false,
      };
      A.conexao.chip = h('span', { class: 'mais-chip' });
      A.conexao.v.append(A.conexao.chip);
      const sair = botao('Sair deste aparelho', 'perigo mais-sair', () => sairDoAparelho(A, sair));
      sair.id = 'mais-ap-sair';
      A.sair = sair;
      cont.append(h('div', { class: 'mais-pilha' },
        cartao('Aparelho', A.nome.el, A.desde.el, A.inst.el, A.versao.el, A.conexao.el),
        h('div', { class: 'mais-grupo' }, A.push.el),
        h('div', { class: 'mais-cartao mais-saida' },
          sair,
          h('p', { class: 'mais-nota' }, 'Desconecta este aparelho do Orbit. Para voltar, será preciso um novo código de 6 dígitos mostrado no PC.'))));
      A.off.push(OM.ouvir('conexao', () => pintarAparelho(A)));
    },
    mostrar(ctx) {
      const A = ctx.a; if (!A) return;
      pintarAparelho(A);
      versaoApp().then((v) => { if (!A.morta) { txt(A.versao.v, v); A.versao.el.hidden = !v; } });
      lerPush().then(() => { if (!A.morta) pintarAparelho(A); });
    },
    atualizar(estado, ctx) { if (ctx.a) pintarAparelho(ctx.a); },
    desmontar(ctx) { const A = ctx.a; if (!A) return; A.morta = true; for (const o of A.off) { try { o(); } catch {} } },
  });

  function pintarAparelho(A) {
    const eu = OM.estado.eu;
    const ap = (eu && eu.aparelho) || {};
    txt(A.nome.v, ap.nome ? String(ap.nome) : 'Este aparelho');
    // criadoEm só vem do PC quando o /remoto/eu o devolver (PEDIDO AO LÍDER); sem ele, a linha some
    const criado = Number(ap.criadoEm);
    A.desde.el.hidden = !(criado > 0);
    if (criado > 0) txt(A.desde.v, dataPareado(criado));
    txt(A.inst.v, OM.push.instalado() ? 'Sim' : 'Não, aberto no navegador');
    const [rot, tipo] = CONEXAO[OM.estado.conexao] || ['', ''];
    txt(A.conexao.chip, rot);
    A.conexao.chip.className = 'mais-chip' + (tipo ? ' mais-chip-' + tipo : '');
    const s = NOTIF.push;
    A.push.valor(!s ? '' : s.ativa ? 'Ligadas' : s.instalado ? 'Desligadas' : 'Instalar');
  }

  async function sairDoAparelho(A, botaoSair) {
    if (A.saindo) return;
    const ok = await OM.confirmar({
      titulo: 'Sair deste aparelho?',
      texto: 'O Orbit deixa de funcionar aqui e as notificações são desligadas. Para voltar, pareie de novo com um código do PC.',
      sim: 'Sair', nao: 'Cancelar', perigo: true,
    });
    if (!ok) return;
    A.saindo = true; botaoSair.disabled = true;
    try { await OM.sair(); }   // volta à tela de parear (modo parear desmonta esta tela)
    catch (e) { OM.toast('Não deu para sair. ' + erroTxt(e)); }
    finally { A.saindo = false; botaoSair.disabled = false; }
  }
})();
