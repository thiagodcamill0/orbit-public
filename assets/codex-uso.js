/* Uso do plano do Codex (etapa 4), dentro do cartão "Uso do plano" da Home, abaixo do bloco do Claude.
 *
 * Só existe com a chave `codex` ligada: sem ela este arquivo nem é carregado e nada entra no DOM. Lê GET /codex/uso e
 * se atualiza pelo SSE `usoCodex`; o botão faz POST /codex/uso/atualizar. Visual do bloco do Claude (mesmas classes
 * gu-*), sem logo nem cor própria: só o selo neutro "Codex" e o plano.
 *
 * window.CodexUso = { montar({cartao, h, txt, corCtx, degradeCtx, durRen, quandoUso, hora, dur, icone, toast}),
 *                     ligar(forcar), desligar(), receber(uso) }
 * Nada do servidor entra por innerHTML.
 */
(function () {
  'use strict';
  const PERTO = 80;
  const JANELAS = [
    { k: 'cincoHoras', rot: 'Sessão', janela: 'janela de 5 h', dica: 'Limite da janela de 5 h do Codex' },
    { k: 'semanal', rot: 'Semana', janela: 'janela de 7 dias', dica: 'Limite semanal do Codex' },
  ];
  const st = { api: null, cartao: null, raiz: null, ligado: false, uso: null, lendo: false, tempo: 0, seq: 0 };

  const ms = (v) => { let r = Number(v) || 0; if (r && r < 1e12) r *= 1000; return r; };

  function linha(x, j, agora) {
    const a = st.api, h = a.h;
    const tem = !!j && typeof j.pct === 'number' && isFinite(j.pct);
    const r = tem ? ms(j.renova) : 0;
    const renovou = !!r && r <= agora;
    const pct = tem && !renovou ? Math.max(0, Math.min(100, Math.round(j.pct))) : null;
    const ren = !tem ? ['sem dados'] : !r ? [] : renovou ? ['renovou ' + a.quandoUso(r, agora)]
      : ['renova em ', h('b', null, a.durRen(r - agora)), ' · ' + a.quandoUso(r, agora).replace(/^às /, '')];
    const renTxt = ren.map((p) => (typeof p === 'string' ? p : p.textContent)).join('');
    const i = h('i');
    i.style.width = (pct != null ? Math.max(2, pct) : 0) + '%';
    if (pct != null) a.degradeCtx(i, pct / 100);
    const val = h('span', { class: 'gu-val' }, pct != null ? pct + '%' : '—');
    if (pct != null) val.style.color = a.corCtx(pct / 100);
    return h('div', {
      class: 'gu-linha' + (pct != null && pct >= PERTO ? ' perto' : ''),
      'data-janela': x.k,
      title: x.dica + '.\n' + (pct != null ? pct + '% usado' : renovou ? 'Renovou depois da última leitura' : 'Sem dados') + (renTxt && tem ? ' · ' + renTxt : ''),
    }, h('span', { class: 'gu-nome' }, x.rot, h('small', null, x.janela)), val,
    h('span', { class: 'gc-trilho', role: 'meter', 'aria-label': 'Codex, ' + x.rot + ', ' + x.janela, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct != null ? pct : 0), 'aria-valuetext': pct != null ? null : 'sem leitura' }, i),
    h('span', { class: 'gu-info' }, h('span', { class: 'gu-ren' }, ...ren),
      h('span', { class: 'gu-marca', title: 'Marca de ' + PERTO + '%: a partir daqui a janela está perto do limite (100% no fim da barra)' }, PERTO + '%')));
  }

  function plano(u) {
    const p = u && typeof u.plano === 'string' ? u.plano.trim() : '';
    return p ? p.charAt(0).toUpperCase() + p.slice(1) : '';
  }

  function desenhar() {
    if (!st.ligado || !st.raiz) return;
    const a = st.api, u = st.uso, agora = Date.now();
    const real = u && (u.cincoHoras || u.semanal) ? u : null;
    const t = real ? Number(u.atualizado) || 0 : 0;
    const p = plano(u);
    txt(st.ui.plano, p || 'plano não informado');
    st.ui.plano.hidden = !p;
    st.ui.caixa.replaceChildren(...(real ? JANELAS.map((x) => linha(x, u[x.k], agora)) : [a.h('p', { class: 'cdx-uso-vazio' }, u ? 'O Codex ainda não informou o uso.' : 'Lendo o uso do Codex…')]));
    txt(st.ui.lido, !real ? 'Nenhuma leitura ainda' : !t ? 'Lido' : agora - t < 60e3 ? 'Lido agora' : 'Lido há ' + a.dur(agora - t));
    st.ui.lido.title = real && t ? 'Última leitura: ' + a.hora(t) + (u.fonte ? ' (' + (u.fonte === 'rollout' ? 'registro da sessão' : 'Codex') + ')' : '') + '.' : 'O Codex informa o uso quando uma sessão roda ou ao atualizar.';
    const b = st.ui.botao;
    b.setAttribute('aria-busy', st.lendo ? 'true' : 'false');
    b.setAttribute('aria-disabled', st.lendo ? 'true' : 'false');
    b.title = st.lendo ? 'Lendo o uso do Codex…' : 'Ler o uso do Codex agora (pede o valor ao Codex, sem gastar tokens)';
  }

  function txt(el, t) { if (el.textContent !== t) el.textContent = t; }

  function montarDom() {
    const a = st.api, h = a.h;
    const ui = {
      plano: h('span', { class: 'cdx-uso-plano' }),
      caixa: h('div', { class: 'gu-barras cdx-uso-barras' }),
      lido: h('span', { class: 'gu-lido' }),
      botao: h('button', { class: 'btn-icone gu-atualizar cdx-uso-atualizar', type: 'button', 'aria-label': 'Ler o uso do Codex agora' }),
    };
    ui.botao.append(a.icone('atualizar', 14));
    ui.botao.addEventListener('click', atualizar);
    st.ui = ui;
    st.raiz = h('div', { class: 'cdx-uso', role: 'group', 'aria-label': 'Uso do plano do Codex' },
      h('div', { class: 'cdx-uso-topo' }, h('span', { class: 'cdx-selo cdx-uso-selo', title: 'Uso do plano do Codex' }, 'Codex'), ui.plano),
      ui.caixa,
      h('div', { class: 'gu-pe' }, ui.lido, ui.botao));
    const pe = st.cartao.querySelector(':scope > .gu-pe'); // logo abaixo do rodapé do Claude (a alça do widget fica por último)
    if (pe) pe.after(st.raiz); else st.cartao.append(st.raiz);
  }

  function pedir(url, opc) {
    return fetch(url, opc).then(async (r) => { let j = null; try { j = await r.json(); } catch { /* sem corpo */ } return { ok: r.ok, status: r.status, j }; });
  }

  function ler() {
    const n = ++st.seq;
    pedir('/codex/uso').then((r) => {
      if (!st.ligado || n !== st.seq) return;
      if (r.ok && r.j) st.uso = r.j;
      else if (!st.uso) st.uso = {};
      desenhar();
    }).catch(() => { if (st.ligado && !st.uso) { st.uso = {}; desenhar(); } });
  }

  async function atualizar() {
    if (st.lendo || !st.ligado) return;
    st.lendo = true;
    desenhar();
    try {
      const r = await pedir('/codex/uso/atualizar', { method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json' }, body: '{}' });
      if (r.ok && r.j) { st.uso = r.j; }
      else st.api.toast((r.j && r.j.erro) || 'Não deu para ler o uso do Codex.');
    } catch { st.api.toast('Não deu para ler o uso do Codex. O servidor está no ar?'); }
    st.lendo = false;
    desenhar();
  }

  function ligar(forcar) {
    if (!st.api) return;
    if (st.ligado && !forcar) return;
    if (!st.ligado) {
      st.ligado = true;
      montarDom();
      st.tempo = setInterval(desenhar, 30e3);
      desenhar();
    }
    ler();
  }

  function desligar() {
    if (!st.ligado) return;
    st.ligado = false;
    st.seq++;
    clearInterval(st.tempo);
    if (st.raiz) st.raiz.remove();
    st.raiz = null;
    st.ui = null;
    st.uso = null;
    st.lendo = false;
  }

  function receber(u) {
    if (!st.ligado || !u || typeof u !== 'object') return;
    st.uso = u;
    desenhar();
  }

  window.CodexUso = {
    montar(api) {
      st.api = api;
      st.cartao = api.cartao;
    },
    ligar, desligar, receber,
  };
})();
