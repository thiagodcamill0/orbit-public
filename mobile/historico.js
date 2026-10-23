// Orbit no celular — tela "historico" (#mais/historico, onda 3): histórico de avisos, agrupado por dia.
// Dados: GET /remoto/historico → [{ id, tipo, quando, notificar, agente?, sessao:{ id, titulo, apelido, projeto, status, detalhe, tarefa… } }].
// Toque no aviso abre a sessão (#s=<id>). Visual do Histórico do PC: rótulo e ponto do tipo (OrbitBase.pontoStatus).
(function () {
'use strict';
const OM = window.OM;
if (!OM || !OM.telas) return;
const { h, api, ouvir, icone, toast, fmt } = OM;

const ROTULO = { concluida: 'Concluída', aguardando: 'Aguardando você', erro: 'Erro', lembrete: 'Ainda aguardando', interrompida: 'Interrompida' };
const MAX_ITENS = 300;
let inst = null;

const mensagem = (e) => (e && e.rede ? 'Sem conexão com o Orbit. Confira se o PC está ligado.' : e && e.status ? 'Não deu certo. Tente de novo em instantes.' : (e && e.message) || 'Algo deu errado.');
const inicioDoDia = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
function nomeDia(ms, agora) {
  const dif = Math.round((inicioDoDia(agora) - inicioDoDia(ms)) / 86400e3);
  if (dif <= 0) return 'Hoje';
  if (dif === 1) return 'Ontem';
  try {
    const t = new Date(ms).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', ...(new Date(ms).getFullYear() !== new Date(agora).getFullYear() ? { year: 'numeric' } : {}) });
    return t.charAt(0).toUpperCase() + t.slice(1);
  } catch { return new Date(ms).toLocaleDateString('pt-BR'); }
}
// Quem pediu: a sessão ou um subagente dela.
function quem(a) {
  const s = a.sessao || {};
  const sessao = fmt.titulo(s);
  if (a.agente && (a.agente.tipo || a.agente.descricao)) return { nome: 'Agente ' + fmt.limpo(a.agente.descricao || a.agente.tipo), mae: sessao };
  if (s.pai) return { nome: 'Agente ' + (fmt.limpo(s.nome) || sessao), mae: '' };
  return { nome: sessao, mae: '' };
}

OM.telas.registrar('historico', {
  titulo: 'Histórico de avisos',
  montar(cont, params, ctx) {
    let itens = [];
    let carga = 'carregando';   // carregando | ok | erro
    let msgErro = '';
    let seq = 0, timerAlerta = 0;

    const aviso = h('div', { class: 'hi-aviso', role: 'status', hidden: true });
    const esqueleto = h('div', { class: 'hi-esqueleto', 'aria-hidden': 'true' },
      h('div', { class: 'esq hi-esq-t' }), h('div', { class: 'esq hi-esq' }), h('div', { class: 'esq hi-esq' }), h('div', { class: 'esq hi-esq hi-esq-c' }));
    const estado = h('div', { class: 'hi-vazio', hidden: true });
    const grupos = h('div', { class: 'hi-grupos', hidden: true });
    cont.append(h('div', { class: 'hi-tela' }, aviso, esqueleto, estado, grupos));

    function item(a) {
      const s = a.sessao || {};
      const tipo = a.tipo in ROTULO ? a.tipo : 'concluida';
      const q = quem(a);
      const ms = fmt.emMs(a.quando);
      const detalhe = fmt.limpo(s.detalhe) || fmt.limpo(s.tarefa);
      const hora = h('time', { class: 'hi-hora', text: fmt.hora(ms), title: new Date(ms).toLocaleString('pt-BR') });
      hora.dateTime = new Date(ms).toISOString();
      return h('button', { class: 'hi-item toque', type: 'button', dados: { tipo }, 'aria-label': (ROTULO[tipo] + ': ' + q.nome + ', ' + fmt.hora(ms)), onclick: () => abrir(s.id) },
        h('span', { class: 'hi-ico', 'aria-hidden': 'true' }, OM.base.pontoStatus(tipo === 'lembrete' ? 'aguardando' : tipo, 16)),
        h('span', { class: 'hi-corpo' },
          h('span', { class: 'hi-tit', text: q.nome }),
          h('span', { class: 'hi-sub' },
            h('span', { class: 'hi-tipo', text: ROTULO[tipo] }),
            h('span', { text: [q.mae && 'do time de ' + q.mae, fmt.limpo(s.projeto)].filter(Boolean).join(' · ') })),
          detalhe ? h('span', { class: 'hi-det', text: detalhe }) : null),
        h('span', { class: 'hi-fim' }, hora, a.notificar === false ? h('span', { class: 'hi-mudo', title: 'Não avisou' }, icone('sino-mudo', 14)) : null));
    }
    function render() {
      const conexao = OM.estado.conexao;
      const semPc = conexao === 'pc' || conexao === 'offline';
      aviso.hidden = !semPc;
      if (semPc) aviso.replaceChildren(icone('aparelho', 18), h('div', null, h('strong', { text: conexao === 'pc' ? 'PC desconectado' : 'Sem conexão' }),
        h('span', { text: itens.length ? 'Mostrando os avisos que já estavam aqui.' : 'Os avisos voltam quando a conexão voltar.' })));
      esqueleto.hidden = !(carga === 'carregando' && !itens.length);
      const falhou = carga === 'erro' && !itens.length && !semPc;   // sem o PC, só o aviso de cima
      const vazio = carga === 'ok' && !itens.length;
      estado.hidden = !(falhou || vazio);
      if (falhou) estado.replaceChildren(h('span', { class: 'hi-vazio-ico' }, icone('alerta', 32)),
        h('p', { class: 'hi-vazio-tit', text: semPc ? 'Sem conexão com o PC' : 'Não deu para carregar' }),
        h('p', { class: 'hi-vazio-txt', text: msgErro || 'Tente de novo em instantes.' }),
        h('button', { class: 'btn toque', type: 'button', onclick: () => carregar() }, icone('atualizar', 18), h('span', { text: 'Tentar de novo' })));
      else if (vazio) estado.replaceChildren(h('span', { class: 'hi-vazio-ico' }, icone('historico', 32)),
        h('p', { class: 'hi-vazio-tit', text: 'Nenhum aviso ainda' }),
        h('p', { class: 'hi-vazio-txt', text: 'Quando uma sessão concluir ou pedir você, o aviso aparece aqui.' }));
      grupos.hidden = !itens.length;
      if (!itens.length) { grupos.replaceChildren(); return; }
      const agora = Date.now();
      const mapa = new Map();
      for (const a of itens) {
        const k = inicioDoDia(fmt.emMs(a.quando));
        if (!mapa.has(k)) mapa.set(k, []);
        mapa.get(k).push(a);
      }
      grupos.replaceChildren(...[...mapa.entries()].sort((x, y) => y[0] - x[0]).map(([k, lista]) => h('section', { class: 'hi-grupo', 'aria-label': nomeDia(k, agora) },
        h('h2', { class: 'hi-dia', text: nomeDia(k, agora) }),
        h('div', { class: 'hi-cartao' }, ...lista.map(item)))));
    }

    function abrir(id) {
      if (!id) return;
      if (OM.estado.sessoes && OM.estado.sessoes.size && !OM.estado.sessoes.has(String(id))) { toast('Essa sessão já saiu da lista'); return; }
      OM.rotas.ir('#s=' + encodeURIComponent(id));
    }
    async function carregar() {
      const meu = ++seq;
      if (!itens.length) { carga = 'carregando'; render(); }
      try {
        const r = await api('GET', '/remoto/historico');
        if (meu !== seq) return;
        const lista = Array.isArray(r) ? r : r && Array.isArray(r.historico) ? r.historico : [];
        itens = lista.filter((a) => a && typeof a === 'object').sort((a, b) => fmt.emMs(b.quando) - fmt.emMs(a.quando)).slice(0, MAX_ITENS);
        carga = 'ok';
      } catch (e) {
        if (meu !== seq) return;
        msgErro = mensagem(e);
        if (!itens.length) carga = 'erro'; else toast('Não deu para atualizar o histórico');
      }
      render();
    }

    const offs = [
      ouvir('alerta', () => { clearTimeout(timerAlerta); timerAlerta = setTimeout(() => { if (ctx.cont.isConnected && inst) carregar(); }, 400); }),
      ouvir('conexao', () => { if (ctx.cont.isConnected) render(); }),
      OM.gestos && OM.gestos.puxar ? OM.gestos.puxar(ctx.corpo, async () => { await carregar(); }) : null,
    ];
    inst = { carregar, limpar() { clearTimeout(timerAlerta); for (const o of offs) if (o) o(); } };
    render();
  },
  mostrar() { if (inst) inst.carregar(); },
  desmontar() { if (inst) { inst.limpar(); inst = null; } },
});
})();
