// Orbit no celular — tela "uso" (#mais/uso, onda 3): uso do plano em detalhe. API no contrato, "App do celular".
// Dados: OM.estado.uso (+ evento `uso` do SSE) e POST /uso/atualizar (200 aplica; 409 lendo|rodando; 502 erro).
// Visual do card "Uso do plano" do PC: barra de 8 px com marca em 80% e a escala de cores de OrbitBase.degradeEscala.
(function () {
'use strict';
const OM = window.OM;
if (!OM || !OM.telas) return;
const { h, txt, api, ouvir, icone, toast, fmt } = OM;

const USO_PERTO = 80;            // % a partir do qual a janela está "perto do limite"
const USO_VELHO = 30 * 60e3;     // leitura mais velha que isso: "pode ter mudado"
const JANELA_5H = 5 * 3600e3;
const CHAVE_AMOSTRAS = 'orbit.m.usoAmostras';
const JANELAS = [
  { k: 'cincoHoras', rot: 'Sessão', janela: 'janela de 5 h' },
  { k: 'semanal', rot: 'Semana', janela: 'janela de 7 dias' },
];

// ───────────── formatação ─────────────
const msAbs = (t) => fmt.emMs(t);
function durRen(ms) {
  const m = Math.floor(Math.max(0, ms) / 60e3);
  if (m < 1) return 'menos de 1 min';
  if (m < 60) return m + ' min';
  const hr = Math.floor(m / 60);
  if (hr < 24) return hr + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  return Math.floor(hr / 24) + ' d' + (hr % 24 ? ' ' + (hr % 24) + ' h' : '');
}
const quandoUso = (ms, agora) => fmt.quando(ms, agora);
const finito = (n) => typeof n === 'number' && isFinite(n);

// Linhas das janelas: { rot, janela, tem, pct (null = sem dado/renovou), r, renovou }.
function linha(j, base) {
  const tem = !!j && finito(j.pct);
  const r = tem ? msAbs(j.renova) : 0;
  return { ...base, tem, r, renovou: !!r && r <= Date.now(), bruto: tem ? j.pct : null };
}
function linhas(u, agora) {
  return JANELAS.map((x) => {
    const l = linha(u && u[x.k], x);
    l.renovou = !!l.r && l.r <= agora;
    l.pct = l.tem && !l.renovou ? Math.max(0, Math.min(100, Math.round(l.bruto))) : null;
    return l;
  });
}
// Uso por modelo, quando o servidor mandar (lista ou mapa); sem isso, nada aparece.
function porModelo(u) {
  const m = u && (u.modelos || u.porModelo);
  const lista = Array.isArray(m) ? m : m && typeof m === 'object' ? Object.entries(m).map(([nome, v]) => ({ nome, ...(v || {}) })) : [];
  const agora = Date.now();
  return lista.filter((x) => x && finito(x.pct)).slice(0, 6).map((x) => {
    const l = linha(x, { rot: OM.fmt.limpo(x.nome || x.modelo) || 'Modelo', janela: '' });
    l.renovou = !!l.r && l.r <= agora;
    l.pct = l.renovou ? null : Math.max(0, Math.min(100, Math.round(x.pct)));
    return l;
  });
}

// ───────────── amostras para a previsão (mesma chave do app antigo) ─────────────
let amostras = [];
try { const a = JSON.parse(localStorage.getItem(CHAVE_AMOSTRAS) || '[]'); if (Array.isArray(a)) amostras = a.filter((x) => x && finito(x.t) && finito(x.p) && finito(x.r)); } catch {}
function guardarAmostra(t, p, r) {
  const ult = amostras[amostras.length - 1];
  if (ult && ult.t === t) return;
  amostras.push({ t, p, r });
  const corte = Date.now() - 6 * 3600e3;
  amostras = amostras.filter((x) => x.t >= corte).slice(-60);
  try { localStorage.setItem(CHAVE_AMOSTRAS, JSON.stringify(amostras)); } catch {}
}
// Previsão da sessão de 5 h no ritmo atual → { cls, partes (texto ou { b }) } ou null.
function previsao(j, lido, agora) {
  if (!j || !finito(j.pct)) return null;
  const r = msAbs(j.renova);
  if (!r || r <= agora) return null;
  const pct = Math.max(0, j.pct);
  if (pct >= 100) return { cls: 'limite', partes: ['Limite da sessão atingido. Libera em ', { b: durRen(r - agora) }, '.'] };
  const base = lido || agora;
  let ritmo = null;
  const primeira = amostras.filter((x) => Math.abs(x.r - r) < 120e3 && x.t <= base && base - x.t <= 90 * 60e3)[0];
  if (primeira && base - primeira.t >= 15 * 60e3 && pct >= primeira.p) ritmo = (pct - primeira.p) / (base - primeira.t);
  else { const dec = base - (r - JANELA_5H); if (dec >= 10 * 60e3) ritmo = pct / dec; }
  if (ritmo == null) return { cls: 'neutro', partes: ['Pouco uso nesta sessão para prever o ritmo.'] };
  const fim = pct + ritmo * (r - base);
  if (ritmo <= 0 || fim < 100) return { cls: '', partes: ['No ritmo atual, a sessão fecha em ', { b: '~' + Math.max(Math.round(pct), Math.round(fim)) + '%' }, ' e não atinge o limite antes de renovar.'] };
  const bate = base + (100 - pct) / ritmo;
  return { cls: 'aviso', partes: ['No ritmo atual, atinge o limite em ', { b: '~' + durRen(bate - agora) }, ', ', durRen(r - bate), ' antes de renovar.'] };
}
const partes = (lista) => lista.map((p) => (typeof p === 'string' ? p : h('b', { text: p.b })));

// ───────────── cartão de uma janela (criado uma vez, atualizado no lugar) ─────────────
function cartao(x) {
  const val = h('div', { class: 'uso-val' });
  const barra = h('i');
  const trilho = h('div', { class: 'uso-trilho', role: 'meter', 'aria-label': x.rot + (x.janela ? ', ' + x.janela : ''), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, barra);
  const marca = h('span', { class: 'uso-marca', 'aria-hidden': 'true', text: USO_PERTO + '%' });
  const ren = h('p', { class: 'uso-ren' });
  const el = h('div', { class: 'uso-cartao' + (x.janela ? '' : ' uso-modelo') },
    h('div', { class: 'uso-l1' }, h('div', { class: 'uso-nome' }, h('span', { text: x.rot }), x.janela ? h('small', { text: x.janela }) : null), val),
    h('div', { class: 'uso-pista' }, marca, trilho), ren);
  return { el, val, barra, trilho, ren };
}
function pintarCartao(c, x, agora) {
  const pct = x.pct;
  txt(c.val, pct == null ? '—' : pct + '%');
  c.barra.style.setProperty('--p', String((pct == null ? 0 : Math.max(2, pct)) / 100));
  if (pct != null) OM.base.degradeEscala(c.barra, pct / 100); else c.barra.style.background = '';
  c.trilho.setAttribute('aria-valuenow', String(pct == null ? 0 : pct));
  c.el.classList.toggle('perto', pct != null && pct >= USO_PERTO);
  c.el.classList.toggle('limite', pct != null && pct >= 100);
  if (!x.tem) c.ren.replaceChildren('sem dados');
  else if (!x.r) c.ren.replaceChildren();
  else if (x.renovou) c.ren.replaceChildren('renovou ' + quandoUso(x.r, agora));
  else c.ren.replaceChildren('renova em ', h('b', { text: durRen(x.r - agora) }), ' · ' + quandoUso(x.r, agora).replace(/^às /, ''));
}

// ───────────── tela ─────────────
let inst = null;
OM.telas.registrar('uso', {
  titulo: 'Uso do plano',
  montar(cont, params, ctx) {
    let dado = OM.estado.uso || null, visto = dado;
    let lendo = false;           // POST /uso/atualizar em andamento
    let bloqueio = null;         // { motivo, texto } depois de um 409
    let falha = '';              // mensagem do 502 / erro de rede
    let timer = 0, timerBloqueio = 0;
    const cartoes = JANELAS.map((x) => cartao(x));
    let cartoesModelo = [], sigModelos = '';

    const aviso = h('div', { class: 'uso-aviso', role: 'status', hidden: true });
    const avisoLimite = h('div', { class: 'uso-aviso', 'data-tipo': 'limite', role: 'status', hidden: true });
    const avisoPc = h('div', { class: 'uso-aviso', 'data-tipo': 'pc', role: 'status', hidden: true });
    const prevTxt = h('span');
    const prev = h('div', { class: 'uso-prev', hidden: true }, prevTxt);
    const listaJanelas = h('div', { class: 'uso-lista' }, ...cartoes.map((c) => c.el));
    const tituloModelos = h('h2', { class: 'uso-sec', text: 'Por modelo', hidden: true });
    const listaModelos = h('div', { class: 'uso-lista', hidden: true });
    const lido = h('p', { class: 'uso-lido' });
    const botao = h('button', { class: 'btn solido toque uso-atualizar', type: 'button', onclick: () => atualizarAgora() }, icone('atualizar', 18), h('span', { text: 'Atualizar agora' }));
    const botaoCab = h('button', { class: 'btn-icone toque uso-cab', type: 'button', 'aria-label': 'Atualizar o uso do plano', onclick: () => atualizarAgora() }, icone('atualizar', 20));
    ctx.acoes.append(botaoCab);

    const esqueleto = h('div', { class: 'uso-esqueleto', 'aria-hidden': 'true' },
      h('div', { class: 'esq uso-esq-cartao' }), h('div', { class: 'esq uso-esq-cartao' }), h('div', { class: 'esq uso-esq-linha' }));
    const vazio = h('div', { class: 'uso-vazio', hidden: true },
      h('span', { class: 'uso-vazio-ico' }, icone('uso', 32)),
      h('p', { class: 'uso-vazio-tit', text: 'Ainda sem leitura do uso' }),
      h('p', { class: 'uso-vazio-txt', text: 'Ela chega quando o Orbit ou o terminal do PC usar o Claude. Dá para pedir agora.' }));
    const corpoReal = h('div', { class: 'uso-real' }, listaJanelas, prev, tituloModelos, listaModelos);
    cont.append(h('div', { class: 'uso-tela' }, aviso, avisoLimite, avisoPc, esqueleto, vazio, corpoReal, lido, botao));

    function limparBloqueio() { bloqueio = null; clearTimeout(timerBloqueio); }

    function pintar() {
      const agora = Date.now();
      const conexao = OM.estado.conexao;
      const semPc = conexao === 'pc' || conexao === 'offline';
      const real = dado && (dado.cincoHoras || dado.semanal) ? dado : null;
      const carregando = !real && !dado && (conexao === 'conectando' || OM.estado.modo === 'carregando');

      esqueleto.hidden = !carregando;
      vazio.hidden = carregando || !!real;
      corpoReal.hidden = !real;
      lido.hidden = carregando;

      // PC desconectado
      avisoPc.hidden = !semPc;
      if (semPc) avisoPc.replaceChildren(icone('aparelho', 18), h('div', null, h('strong', { text: conexao === 'pc' ? 'PC desconectado' : 'Sem conexão' }),
        h('span', { text: real ? 'Mostrando a última leitura recebida.' : 'O uso volta quando a conexão voltar.' })));

      // Bloqueio (409) ou falha (502/rede)
      const msg = bloqueio || (falha ? { motivo: 'falha', titulo: 'Não deu para ler o uso', texto: falha } : null);
      aviso.hidden = !msg;
      if (msg) {
        aviso.dataset.tipo = msg.motivo === 'falha' ? 'erro' : 'bloqueio';
        aviso.replaceChildren(icone(msg.motivo === 'falha' ? 'alerta' : 'ampulheta', 18),
          h('div', null, h('strong', { text: msg.titulo }), h('span', { text: msg.texto })));
      }

      let lins = [];
      if (real) {
        lins = linhas(real, agora);
        lins.forEach((x, i) => pintarCartao(cartoes[i], x, agora));
        // Limite atingido
        const topo = lins.find((x) => x.pct != null && x.pct >= 100);
        avisoLimite.hidden = !topo;
        if (topo) avisoLimite.replaceChildren(icone('alerta', 18), h('div', null,
          h('strong', { text: 'Limite ' + (topo.rot === 'Sessão' ? 'da sessão' : 'da semana') + ' atingido' }),
          h('span', { text: topo.r ? 'Libera em ' + durRen(topo.r - agora) + ' · ' + quandoUso(topo.r, agora).replace(/^às /, '') + '.' : 'O uso volta quando a janela renovar.' })));
        // Previsão (só a sessão de 5 h; no limite o aviso acima já diz tudo)
        const lidoMs = Number(real.atualizado) || 0;
        if (lidoMs && real.cincoHoras && finito(real.cincoHoras.pct)) guardarAmostra(lidoMs, real.cincoHoras.pct, msAbs(real.cincoHoras.renova));
        const pv = topo && topo.k === 'cincoHoras' ? null : previsao(real.cincoHoras, lidoMs, agora);
        prev.hidden = !pv;
        if (pv) { prev.dataset.cls = pv.cls; prevTxt.replaceChildren(...partes(pv.partes)); }
        // Por modelo
        const ms = porModelo(real);
        const sig = ms.map((m) => m.rot).join('|');
        if (sig !== sigModelos) {
          sigModelos = sig;
          cartoesModelo = ms.map((m) => cartao(m));
          listaModelos.replaceChildren(...cartoesModelo.map((c) => c.el));
        }
        ms.forEach((m, i) => cartoesModelo[i] && pintarCartao(cartoesModelo[i], m, agora));
        tituloModelos.hidden = listaModelos.hidden = !ms.length;
      } else { avisoLimite.hidden = true; }

      // Rodapé: quando foi lido
      const lidoMs = real ? Number(real.atualizado) || 0 : 0;
      const velho = !!lidoMs && agora - lidoMs > USO_VELHO;
      lido.classList.toggle('velho', velho);
      txt(lido, lidoMs ? (agora - lidoMs < 60e3 ? 'Lido agora' : 'Lido há ' + durRen(agora - lidoMs)) + (velho ? ' · pode ter mudado' : '') + ' · ' + quandoUso(lidoMs, agora) : '');

      // Botões
      for (const b of [botao, botaoCab]) {
        b.disabled = lendo;
        b.classList.toggle('lendo', lendo);
        b.setAttribute('aria-busy', lendo ? 'true' : 'false');
      }
      txt(botao.lastChild, lendo ? 'Lendo…' : 'Atualizar agora');
    }

    async function atualizarAgora() {
      if (lendo) return;
      lendo = true; falha = ''; limparBloqueio(); pintar();
      try {
        const r = await api('POST', '/uso/atualizar');
        if (r && r.uso && typeof r.uso === 'object') dado = r.uso;
        toast('Uso atualizado');
      } catch (e) {
        if (e && e.status === 409) {
          const motivo = e.dados && e.dados.motivo === 'rodando' ? 'rodando' : 'lendo';
          bloqueio = motivo === 'rodando'
            ? { motivo, titulo: 'Leitura adiada', texto: 'Há uma instância trabalhando agora. A leitura sob demanda fica para quando tudo parar; o uso também se atualiza sozinho.' }
            : { motivo, titulo: 'Já está lendo o uso do plano', texto: 'Aguarde alguns segundos: o resultado aparece aqui sozinho.' };
          toast(motivo === 'rodando' ? 'Leitura adiada: há uma instância trabalhando' : 'Já está lendo o uso do plano');
          if (motivo === 'lendo') timerBloqueio = setTimeout(() => { bloqueio = null; pintar(); }, 8000);
        } else if (e && e.status === 502) {
          falha = 'A leitura falhou no PC. Tente de novo em instantes.';
        } else if (e && e.rede) {
          falha = 'Sem conexão com o Orbit. Confira se o PC está ligado.';
        } else {
          falha = (e && e.message) || 'Erro ao ler o uso.';
        }
      } finally { lendo = false; pintar(); }
    }

    const offs = [
      ouvir('uso', () => { dado = OM.estado.uso || dado; visto = OM.estado.uso; falha = ''; if (bloqueio && bloqueio.motivo === 'lendo') limparBloqueio(); if (!ctx.cont.isConnected) return; pintar(); }),
      ouvir('conexao', () => { if (ctx.cont.isConnected) pintar(); }),
      OM.gestos && OM.gestos.puxar ? OM.gestos.puxar(ctx.corpo, atualizarAgora) : null,
    ];
    const iniciarRelogio = () => { clearInterval(timer); timer = setInterval(() => { if (!document.hidden) pintar(); }, 30e3); };
    inst = { pintar, sincronizar() { if (OM.estado.uso !== visto) { visto = OM.estado.uso; dado = visto || dado; } pintar(); }, relogio: iniciarRelogio, parar() { clearInterval(timer); }, limpar() { clearInterval(timer); clearTimeout(timerBloqueio); for (const o of offs) if (o) o(); } };
    pintar();
  },
  mostrar() { const u = inst; if (u) { u.sincronizar(); u.relogio(); } },
  atualizar() { const u = inst; if (u) u.sincronizar(); },
  esconder() { const u = inst; if (u) u.parar(); },
  desmontar() { const u = inst; if (u) { u.limpar(); inst = null; } },
});
})();
