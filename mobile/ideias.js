// Orbit no celular — tela "ideias" (#mais/ideias, onda 3): o bloco de notas de ideias do Orbit. API no contrato.
// Rotas (corpos exatos; o remoto dá 400 com campo a mais): GET /ideias · POST /ideias/nova {texto} · /ideias/editar {id, texto}
// · /ideias/feita {id, feita} · /ideias/apagar {id}. Apagar só vai ao servidor depois do toast "Desfazer".
(function () {
'use strict';
const OM = window.OM;
if (!OM || !OM.telas) return;
const { h, txt, api, ouvir, icone, toast } = OM;

const MAX = 20000;            // limite de caracteres do texto (contrato)
const MS_DESFAZER = 5000;     // vida do toast "Desfazer"; o servidor só é chamado depois dele

let inst = null;

// ───────────── texto e data ─────────────
// A ideia é Markdown do Obsidian; no celular a lista mostra texto simples (o editor mostra o original).
function simples(t) {
  return String(t || '').replace(/<[^>]*>/g, '').replace(/==/g, '').replace(/\*\*|__/g, '').replace(/^(\s*)[-*]\s+/gm, '$1• ').trim();
}
// "AAAA-MM-DD HH:MM" (hora local do PC) → "hoje 14:30", "ontem 09:12" ou "21/10/2026".
function quandoIdeia(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return '';
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  const hora = m[4] ? ' ' + m[4] + ':' + m[5] : '';
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const dia = new Date(d); dia.setHours(0, 0, 0, 0);
  const dif = Math.round((hoje - dia) / 86400e3);
  if (dif === 0) return 'hoje' + hora;
  if (dif === 1) return 'ontem' + hora;
  return String(+m[3]).padStart(2, '0') + '/' + m[2] + (+m[1] !== hoje.getFullYear() ? '/' + m[1] : '');
}
const mensagem = (e) => (e && e.rede ? 'Sem conexão com o Orbit. Confira se o PC está ligado.' : e && e.status ? 'Não deu certo. Tente de novo em instantes.' : (e && e.message) || 'Algo deu errado.');

OM.telas.registrar('ideias', {
  titulo: 'Ideias',
  montar(cont, params, ctx) {
    let lista = [];                  // ideias (ordem da nota; a mais nova no topo)
    let estadoCarga = 'carregando';  // carregando | ok | erro
    let msgErro = '';
    let seq = 0;                     // descarta respostas de leituras antigas
    let feitasAbertas = false;
    let pend = null;                 // { item, indice, timer }: apagada que ainda pode ser desfeita
    const offsLinhas = [];

    const aviso = h('div', { class: 'id-aviso', role: 'status', hidden: true });
    const esqueleto = h('div', { class: 'id-esqueleto', 'aria-hidden': 'true' },
      h('div', { class: 'esq id-esq' }), h('div', { class: 'esq id-esq' }), h('div', { class: 'esq id-esq id-esq-c' }));
    const erroEl = h('div', { class: 'id-vazio', hidden: true, role: 'alert' });
    const vazio = h('div', { class: 'id-vazio', hidden: true },
      h('span', { class: 'id-vazio-ico' }, icone('lampada', 32)),
      h('p', { class: 'id-vazio-tit', text: 'Nenhuma ideia ainda' }),
      h('p', { class: 'id-vazio-txt', text: 'Anote aqui o que passar pela cabeça. Ela aparece também no Orbit do PC.' }),
      h('button', { class: 'btn solido toque', type: 'button', onclick: () => abrirEditor(null) }, icone('mais', 18), h('span', { text: 'Anotar uma ideia' })));
    const ativas = h('div', { class: 'id-cartao', hidden: true });
    const feitasCab = h('button', { class: 'id-feitas toque', type: 'button', 'aria-expanded': 'false', hidden: true, onclick: () => { feitasAbertas = !feitasAbertas; render(); } });
    const feitasEl = h('div', { class: 'id-cartao id-cartao-feitas', hidden: true });
    cont.append(h('div', { class: 'id-tela' }, aviso, esqueleto, erroEl, vazio, ativas, feitasCab, feitasEl));

    const botaoNova = h('button', { class: 'btn-icone toque', type: 'button', 'aria-label': 'Nova ideia', onclick: () => abrirEditor(null) }, icone('mais', 22));
    ctx.acoes.append(botaoNova);

    // ───────── desenho ─────────
    function linha(it, feita) {
      const marcar = h('button', { class: 'id-check toque', type: 'button', 'aria-pressed': feita ? 'true' : 'false', 'aria-label': feita ? 'Reabrir a ideia' : 'Marcar como feita', onclick: (e) => { e.stopPropagation(); marcarFeita(it.id, !feita); } },
        h('span', { class: 'id-bola' }, feita ? icone('check', 14) : null));
      const corpo = h('button', { class: 'id-corpo', type: 'button', onclick: () => abrirEditor(it) },
        h('span', { class: 'id-texto', text: simples(it.texto) || '(vazia)' }),
        h('span', { class: 'id-data', text: quandoIdeia(it.data) }));
      return h('div', { class: 'id-item' + (feita ? ' feita' : ''), dados: { id: it.id } }, marcar, corpo);
    }
    function preencher(caixa, itens, feita) {
      caixa.replaceChildren();
      for (const it of itens) {
        const li = linha(it, feita);
        caixa.append(li);
        if (OM.gestos && OM.gestos.deslizar) {
          const g = OM.gestos.deslizar(li, {
            esquerda: [{ rotulo: feita ? 'Reabrir' : 'Feita', icone: 'check', tipo: 'sucesso', acao: () => marcarFeita(it.id, !feita) }],
            direita: [{ rotulo: 'Apagar', icone: 'lixeira', tipo: 'perigo', acao: () => apagar(it.id) }],
          });
          if (g && g.off) offsLinhas.push(g.off);
        }
      }
    }
    function render() {
      while (offsLinhas.length) { try { offsLinhas.pop()(); } catch {} }
      const conexao = OM.estado.conexao;
      const semPc = conexao === 'pc' || conexao === 'offline';
      aviso.hidden = !semPc;
      if (semPc) aviso.replaceChildren(icone('aparelho', 18), h('div', null, h('strong', { text: conexao === 'pc' ? 'PC desconectado' : 'Sem conexão' }),
        h('span', { text: lista.length ? 'Mostrando as ideias que já estavam aqui; as mudanças ficam para quando voltar.' : 'As ideias voltam quando a conexão voltar.' })));

      const carregando = estadoCarga === 'carregando' && !lista.length;
      const falhou = estadoCarga === 'erro' && !lista.length && !semPc;   // sem o PC, só o aviso de cima
      esqueleto.hidden = !carregando;
      erroEl.hidden = !falhou;
      if (falhou) erroEl.replaceChildren(h('span', { class: 'id-vazio-ico' }, icone('alerta', 32)),
        h('p', { class: 'id-vazio-tit', text: semPc ? 'Sem conexão com o PC' : 'Não deu para carregar' }),
        h('p', { class: 'id-vazio-txt', text: msgErro || 'Tente de novo em instantes.' }),
        h('button', { class: 'btn toque', type: 'button', onclick: () => carregar() }, icone('atualizar', 18), h('span', { text: 'Tentar de novo' })));
      const pendId = pend && pend.item.id;
      const ok = lista.filter((x) => x.id !== pendId);
      const abertas = ok.filter((x) => !x.feita), feitas = ok.filter((x) => x.feita);
      vazio.hidden = !(estadoCarga === 'ok' && !ok.length);
      ativas.hidden = !abertas.length;
      if (abertas.length) preencher(ativas, abertas, false); else ativas.replaceChildren();
      feitasCab.hidden = !feitas.length;
      feitasCab.setAttribute('aria-expanded', String(feitasAbertas));
      feitasCab.replaceChildren(icone(feitasAbertas ? 'chevron-cima' : 'chevron-baixo', 16), h('span', { text: 'Feitas · ' + feitas.length }));
      feitasEl.hidden = !(feitas.length && feitasAbertas);
      if (!feitasEl.hidden) preencher(feitasEl, feitas, true); else feitasEl.replaceChildren();
    }

    // ───────── dados ─────────
    function aplicar(r) { if (r && Array.isArray(r.ideias)) { lista = r.ideias; estadoCarga = 'ok'; } }
    async function carregar() {
      const meu = ++seq;
      if (!lista.length) { estadoCarga = 'carregando'; render(); }
      try {
        const r = await api('GET', '/ideias');
        if (meu !== seq) return;
        aplicar(r); if (!(r && Array.isArray(r.ideias))) { estadoCarga = 'ok'; lista = []; }
      } catch (e) {
        if (meu !== seq) return;
        msgErro = mensagem(e);
        if (!lista.length) estadoCarga = 'erro'; else toast('Não deu para atualizar as ideias');
      }
      render();
    }
    async function marcarFeita(id, feita) {
      const it = lista.find((x) => x.id === id);
      if (!it) return;
      const antes = it.feita;
      it.feita = feita; render();
      try { aplicar(await api('POST', '/ideias/feita', { id, feita })); render(); toast(feita ? 'Marcada como feita' : 'Ideia reaberta'); }
      catch (e) {
        if (e.status === 404) { toast('Essa ideia não está mais na nota'); carregar(); return; }
        it.feita = antes; render(); toast(mensagem(e));
      }
    }
    function apagar(id) {
      commitApagar();
      const indice = lista.findIndex((x) => x.id === id);
      if (indice < 0) return;
      const item = lista[indice];
      pend = { item, indice, timer: setTimeout(commitApagar, MS_DESFAZER + 300) };
      render();
      toast('Ideia apagada', { ms: MS_DESFAZER, acao: { rotulo: 'Desfazer', fn: desfazer } });
    }
    function desfazer() {
      if (!pend) return;
      clearTimeout(pend.timer);
      const { item, indice } = pend; pend = null;
      if (!lista.some((x) => x.id === item.id)) lista.splice(Math.min(indice, lista.length), 0, item);
      render();
    }
    async function commitApagar() {
      const p = pend;
      if (!p) return;
      clearTimeout(p.timer); pend = null;
      try { aplicar(await api('POST', '/ideias/apagar', { id: p.item.id })); lista = lista.filter((x) => x.id !== p.item.id); }
      catch (e) {
        if (e.status === 404) { lista = lista.filter((x) => x.id !== p.item.id); }
        else if (!lista.some((x) => x.id === p.item.id)) { lista.splice(Math.min(p.indice, lista.length), 0, p.item); toast('Não deu para apagar a ideia'); }
      }
      if (ctx.cont.isConnected) render();
    }

    // ───────── folha de nova/edição ─────────
    function abrirEditor(it) {
      const editando = !!it;
      OM.folha.abrir({
        titulo: editando ? 'Editar ideia' : 'Nova ideia',
        paradas: ['auto'],
        conteudo: (corpo, f) => {
          const campo = h('textarea', { class: 'id-campo', rows: '6', maxlength: String(MAX), placeholder: 'Escreva a ideia…', 'aria-label': 'Texto da ideia', autocapitalize: 'sentences', enterkeyhint: 'enter' });
          campo.value = editando ? it.texto : '';
          const erro = h('p', { class: 'id-erro', role: 'alert', hidden: true });
          const salvar = h('button', { class: 'btn solido toque', type: 'button' }, h('span', { text: editando ? 'Salvar' : 'Anotar' }));
          const cancelar = h('button', { class: 'btn toque', type: 'button', onclick: () => f.fechar('botao') }, h('span', { text: 'Cancelar' }));
          const acoes = [cancelar];
          if (editando) acoes.unshift(h('button', { class: 'btn perigo toque', type: 'button', onclick: () => { f.fechar('botao'); apagar(it.id); } }, icone('lixeira', 16), h('span', { text: 'Apagar' })));
          acoes.push(salvar);
          const checar = () => { salvar.disabled = !campo.value.trim() || campo.value.length > MAX || (editando && campo.value.trim() === String(it.texto).trim()); };
          campo.addEventListener('input', () => { checar(); erro.hidden = true; });
          let enviando = false;
          salvar.addEventListener('click', async () => {
            const texto = campo.value.trim();
            if (enviando || !texto) return;
            enviando = true; salvar.disabled = true; erro.hidden = true;
            try {
              const r = editando ? await api('POST', '/ideias/editar', { id: it.id, texto }) : await api('POST', '/ideias/nova', { texto });
              aplicar(r); render();
              f.fechar('salvo');
              toast(editando ? 'Ideia salva' : 'Ideia anotada');
            } catch (e) {
              enviando = false;
              if (e.status === 404) { f.fechar('sumiu'); toast('Essa ideia não está mais na nota'); carregar(); return; }
              erro.textContent = e.status === 400 ? 'O texto não foi aceito (vazio ou grande demais).' : mensagem(e);
              erro.hidden = false; checar();
            }
          });
          corpo.append(campo, erro, h('div', { class: 'folha-acoes id-acoes' }, ...acoes));
          checar();
          setTimeout(() => { try { campo.focus({ preventScroll: true }); } catch {} }, 60);
        },
      });
    }

    const offs = [
      ouvir('conexao', () => { if (ctx.cont.isConnected) render(); }),
      OM.gestos && OM.gestos.puxar ? OM.gestos.puxar(ctx.corpo, async () => { await carregar(); }) : null,
    ];
    const aoOcultar = () => { if (document.hidden) commitApagar(); };
    document.addEventListener('visibilitychange', aoOcultar);
    inst = {
      mostrar() { carregar(); },
      conexao() { render(); },
      esconder() { commitApagar(); },
      limpar() {
        commitApagar();
        document.removeEventListener('visibilitychange', aoOcultar);
        while (offsLinhas.length) { try { offsLinhas.pop()(); } catch {} }
        for (const o of offs) if (o) o();
      },
    };
    render();
  },
  mostrar() { if (inst) inst.mostrar(); },
  esconder() { if (inst) inst.esconder(); },
  desmontar() { if (inst) { inst.limpar(); inst = null; } },
});
})();
