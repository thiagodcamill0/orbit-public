// Orbit no celular — tela detalhe (onda 3). Arquivo reservado ao dono da tela; API no contrato, "App do celular".
// Aberta por #s=<id>/detalhe (params { id, sub }). Mostra a sessão, deixa mudar apelido/fixar/silenciar/compactação
// automática/revisada, retomar e encerrar (sempre o encerrar normal: nunca manda `forcar`) e lista agentes e tarefas.
// Tudo otimista: o valor novo aparece na hora (sobreposição local `ovr`), reverte com toast se o servidor recusar e some
// quando o estado ao vivo (SSE → `atualizar`) confirma o mesmo valor. Sem innerHTML com dado do servidor.
(function () {
'use strict';
const OM = window.OM;
if (!OM || !OM.telas) return;
const { h } = OM;

const ESFORCO = { low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo' };
const MODOS = { default: 'Padrão', acceptEdits: 'Aceitar edições', plan: 'Planejar', auto: 'Auto', bypassPermissions: 'Sem permissões', dontAsk: 'Não perguntar' };
const TIPO_TAREFA = { local_bash: 'Comando', local_agent: 'Agente', remote_agent: 'Agente remoto', monitor: 'Monitor' };
const ST_PARADA = new Set(['concluida', 'interrompida']);
const PRAZO_OVR = 5000;

// Lista de modelos (GET /modelos) para mostrar o nome em vez do código; uma busca só, compartilhada.
let modelos = null, modelosPedido = null;
function carregarModelos() {
  if (modelos || modelosPedido) return modelosPedido;
  modelosPedido = OM.api('GET', '/modelos').then((d) => {
    const l = Array.isArray(d) ? d : Array.isArray(d && d.modelos) ? d.modelos : [];
    modelos = l.filter((m) => m && m.valor);
  }).catch(() => { modelosPedido = null; });
  return modelosPedido;
}
function rotuloModelo(c, s) {
  const v = (c && c.modelo) || '';
  if (!v) return (s.contexto && s.contexto.modelo) || '';
  const m = (modelos || []).find((x) => x.valor === v);
  if (!m) return v === 'default' ? 'Padrão' : v;
  if (v !== 'default') return m.nome || v;
  const alvo = (modelos || []).find((x) => x.valor !== 'default' && x.modelo === m.modelo);
  return 'Padrão · ' + ((alvo && alvo.nome) || m.descricao || m.modelo || 'recomendado');
}

const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',').replace(/,0$/, '') + ' mi' : n >= 1e3 ? Math.round(n / 1e3) + ' mil' : String(n));
function ctxPct(s) {
  const c = s.contexto;
  if (!c || !Number(c.tokens)) return null;
  const p = c.pct != null && isFinite(Number(c.pct)) ? Number(c.pct) / 100 : Number(c.janela) > 0 ? Number(c.tokens) / Number(c.janela) : null;
  return p == null ? null : Math.min(1, Math.max(0, p));
}
const rota = (id, sufixo) => '/sessao/' + encodeURIComponent(id) + (sufixo || '');
const encerrada = (s) => s.status === 'encerrada' || !!(s.controle && s.controle.processo === 'dormindo');

function spriteDe(s) {
  const B = OM.base;
  if (!B) return '';
  const st = s.status in B.ROTULO_STATUS ? s.status : 'nova';
  const ags = Array.isArray(s.agentes) ? s.agentes : [];
  const revisada = !!s.revisadaEm && ST_PARADA.has(st);
  const e = B.estadoSprite(st, { ferramenta: s.ferramenta, subTrabalhando: ags.some((a) => a && a.status === 'trabalhando'),
    tokens: st === 'trabalhando' && s.contexto ? Number(s.contexto.tokens) || 0 : 0, revisada });
  const l = B.SPRITE[e] || B.SPRITE.dormindo;
  let x = 0;
  const k = String(s.id) + '|' + (Number(s.desde) || 0) + '|' + e;
  for (let i = 0; i < k.length; i++) x = (x * 31 + k.charCodeAt(i)) | 0;
  const nome = l[l.length === 1 ? 0 : Math.abs(x) % l.length];
  return /-parado$/.test(nome) ? '/assets/' + nome + '.png' : nome; // "-parado" é PNG; os demais, GIF
}

const VIVAS = new WeakMap();   // ctx → estado da instância da tela
function montar(cont, params, ctx) {
  const id = String(params.id || '');
  const v = { id, ovr: {}, pend: {}, timer: 0, sig: {}, refs: {} };
  VIVAS.set(ctx, v);
  cont.classList.add('dt');

  // ── cabeçalho ──
  const spr = h('img', { class: 'dt-spr', alt: '', width: 56, height: 56, decoding: 'async' });
  spr.addEventListener('error', () => { spr.classList.add('sem'); });
  const nome = h('h2', { class: 'dt-nome' });
  const proj = h('p', { class: 'dt-proj' });
  const pilulaBox = h('span', { class: 'dt-pilula' });
  const det = h('p', { class: 'dt-det' });
  const hero = h('header', { class: 'dt-hero' }, h('span', { class: 'dt-av' }, spr),
    h('div', { class: 'dt-hero-txt' }, proj, nome, h('div', { class: 'dt-hero-l3' }, pilulaBox), det));

  // ── informações ──
  const linhas = {};
  const linha = (chave, rotulo) => {
    const val = h('div', { class: 'dt-val' });
    const el = h('div', { class: 'dt-linha', role: 'listitem' }, h('span', { class: 'dt-rot' }, rotulo), val);
    linhas[chave] = { el, val };
    return el;
  };
  const infos = h('div', { class: 'dt-cartao', role: 'list' },
    linha('projeto', 'Projeto'), linha('modelo', 'Modelo'), linha('esforco', 'Esforço'), linha('modo', 'Modo'),
    linha('ctx', 'Contexto'), linha('atividade', 'Última atividade'), linha('neste', 'Neste status'), linha('inicio', 'Início'), linha('turnos', 'Turnos'));

  // ── ajustes ──
  const apelidoVal = h('span', { class: 'dt-apelido' });
  const btnApelido = h('button', { class: 'dt-item toque', type: 'button', 'aria-haspopup': 'dialog' },
    h('span', { class: 'dt-item-txt' }, h('span', { class: 'dt-item-t' }, 'Apelido'), apelidoVal), OM.icone('lapis', 18));
  btnApelido.addEventListener('click', () => editarApelido(v));
  const chave = (campo, titulo, sub) => {
    const input = h('input', { class: 'chave', type: 'checkbox', role: 'switch', 'aria-label': titulo });
    const subEl = h('span', { class: 'dt-item-s' }, sub);
    const el = h('label', { class: 'dt-item dt-chave' }, h('span', { class: 'dt-item-txt' }, h('span', { class: 'dt-item-t' }, titulo), subEl), input);
    input.addEventListener('change', () => alternar(v, campo, input.checked, input));
    v.refs[campo] = { el, input, subEl };
    return el;
  };
  const ajustes = h('div', { class: 'dt-cartao' }, btnApelido,
    chave('fixada', 'Fixar no topo', 'Mantém a sessão no alto da lista'),
    chave('silenciada', 'Silenciar avisos', 'Não avisa quando ela terminar ou precisar de você'),
    chave('autocompactar', 'Compactação automática', 'Compacta a conversa sozinha quando o contexto enche'));

  // ── ações ──
  const btnRev = h('button', { class: 'btn toque dt-btn', type: 'button' });
  btnRev.addEventListener('click', () => alternar(v, 'revisada', !v.vista.rev, null));
  const btnRetomar = h('button', { class: 'btn toque dt-btn', type: 'button' }, OM.icone('play', 16), h('span', null, 'Retomar'));
  btnRetomar.addEventListener('click', () => retomar(v));
  const btnEncerrar = h('button', { class: 'btn toque perigo dt-btn', type: 'button' }, OM.icone('parar', 16), h('span', null, 'Encerrar instância'));
  btnEncerrar.addEventListener('click', () => encerrar(v));
  const acoes = h('div', { class: 'dt-acoes' }, btnRev, btnRetomar, btnEncerrar);

  // ── agentes e tarefas ──
  const listaAg = h('div', { class: 'dt-lista' });
  const secAg = h('section', { class: 'dt-sec' }, h('h3', { class: 'dt-sec-t' }, 'Agentes'), listaAg);
  const listaTa = h('div', { class: 'dt-lista' });
  const secTa = h('section', { class: 'dt-sec' }, h('h3', { class: 'dt-sec-t' }, 'Tarefas em segundo plano'), listaTa);

  const vazio = h('div', { class: 'dt-vazio', hidden: true }, h('p', { class: 'dt-vazio-t' }, 'Esta sessão não está mais no Orbit.'),
    h('button', { class: 'btn toque', type: 'button', onclick: () => ctx.voltar() }, 'Voltar'));
  const carregando = h('div', { class: 'dt-carr' }, h('div', { class: 'esq dt-esq1' }), h('div', { class: 'esq dt-esq2' }), h('div', { class: 'esq dt-esq2' }));
  const conteudo = h('div', { class: 'dt-conteudo', hidden: true }, hero,
    h('section', { class: 'dt-sec' }, h('h3', { class: 'dt-sec-t' }, 'Informações'), infos),
    h('section', { class: 'dt-sec' }, h('h3', { class: 'dt-sec-t' }, 'Ajustes'), ajustes),
    h('section', { class: 'dt-sec dt-sec-acoes' }, acoes), secAg, secTa);
  cont.append(carregando, vazio, conteudo);
  Object.assign(v.refs, { spr, nome, proj, pilulaBox, det, linhas, apelidoVal, btnRev, btnRetomar, btnEncerrar, acoes, listaAg, secAg, listaTa, secTa, vazio, carregando, conteudo, cont, ctx });
  carregarModelos().then(() => { if (v.vista) render(v); });
}

// ── estado visto = estado do servidor + sobreposições otimistas ainda válidas ──
function vista(v, s) {
  const c = s.controle || null;
  const real = {
    fixada: !!s.fixada, silenciada: !!s.silenciada, apelido: s.apelido || '',
    autocompactar: !!(c && c.autoCompactar && c.autoCompactar.ligada),
    revisada: !!s.revisadaEm && ST_PARADA.has(s.status),
  };
  const agora = Date.now();
  const o = {};
  for (const k of Object.keys(v.ovr)) {
    const e = v.ovr[k];
    if (real[k] === e.valor || agora > e.ate) delete v.ovr[k];
    else o[k] = e.valor;
  }
  const f = { ...real, ...o };
  return { s, c, apelido: f.apelido, fixada: f.fixada, silenciada: f.silenciada, auto: f.autocompactar, rev: f.revisada, enc: encerrada(s) };
}

function textoLinha(l, texto) {
  l.el.hidden = !texto;
  if (texto && l.val.textContent !== texto) l.val.textContent = texto;
}

function render(v) {
  const s = OM.sessao(v.id);
  const R = v.refs;
  const temEstado = OM.estado.modo === 'app' && (OM.estado.sessoes.size > 0 || OM.estado.conexao === 'vivo');
  R.carregando.hidden = !!s || temEstado;
  R.vazio.hidden = !!s || !temEstado;
  R.conteudo.hidden = !s;
  if (!s) { v.vista = null; return; }
  const x = vista(v, s);
  v.vista = x;
  const { c } = x;
  const orbit = !!(c && c.modo === 'orbit');
  const st = s.status in (OM.base ? OM.base.ROTULO_STATUS : {}) ? s.status : 'nova';
  const titulo = OM.fmt.titulo({ ...s, apelido: x.apelido });

  // cabeçalho
  const sp = spriteDe(s);
  if (sp && R.spr.dataset.gif !== sp) {
    R.spr.classList.remove('sem');
    if (OM.sprites) OM.sprites.definir(R.spr, sp); else { R.spr.dataset.gif = sp; R.spr.src = sp.startsWith('/') ? sp : '/assets/' + sp + '.gif'; }
  }
  if (R.nome.textContent !== titulo) R.nome.textContent = titulo;
  R.proj.textContent = OM.fmt.projeto(s);
  if (v.sig.st !== st + '|' + x.rev && OM.base) {
    v.sig.st = st + '|' + x.rev;
    R.pilulaBox.replaceChildren(OM.base.pilula(st, x.rev && st === 'concluida' ? 'Revisada' : undefined));
  }
  const det = OM.fmt.limpo(s.detalhe);
  R.det.hidden = !det;
  if (det) R.det.textContent = det;

  // informações
  const L = R.linhas;
  textoLinha(L.projeto, OM.fmt.projeto(s));
  textoLinha(L.modelo, orbit ? rotuloModelo(c, s) : (s.contexto && s.contexto.modelo) || '');
  textoLinha(L.esforco, orbit && c.esforco ? ESFORCO[c.esforco] || c.esforco : '');
  textoLinha(L.modo, orbit && c.modoPermissao ? MODOS[c.modoPermissao] || c.modoPermissao : '');
  const pct = ctxPct(s);
  L.ctx.el.hidden = pct == null;
  if (pct != null) {
    const info = Math.round(pct * 100) + '% · ' + fmtTokens(Number(s.contexto.tokens)) + (Number(s.contexto.janela) > 0 ? ' de ' + fmtTokens(Number(s.contexto.janela)) : '');
    const sigC = info;
    if (v.sig.ctx !== sigC) {
      v.sig.ctx = sigC;
      const b = OM.base.barraUso(pct, info);
      const fill = b.querySelector('.ctx-b i');
      if (fill && OM.base.corEscala) fill.style.background = OM.base.corEscala(pct);
      L.ctx.val.replaceChildren(b);
    }
  }
  tempos(v);
  textoLinha(L.inicio, s.inicio ? OM.fmt.quando(s.inicio) : '');
  const ct = s.contadores || {};
  textoLinha(L.turnos, Number(ct.turnos) > 0 ? ct.turnos + (Number(ct.ferramentas) > 0 ? ' · ' + ct.ferramentas + ' ferramentas' : '') : '');

  // ajustes
  R.apelidoVal.textContent = x.apelido || 'Sem apelido';
  R.apelidoVal.classList.toggle('vazio', !x.apelido);
  for (const [campo, val] of [['fixada', x.fixada], ['silenciada', x.silenciada], ['autocompactar', x.auto]]) {
    const r = v.refs[campo];
    if (r.input.checked !== val) r.input.checked = val;
  }
  const ac = v.refs.autocompactar;
  ac.el.hidden = !orbit;
  const au = c && c.autoCompactar;
  ac.subEl.textContent = au && au.ultima && au.ultima.quando ? 'Última: ' + OM.fmt.quando(au.ultima.quando) + ' (' + fmtTokens(au.ultima.antes) + ' → ' + fmtTokens(au.ultima.depois) + ')'
    : 'Compacta a conversa sozinha quando o contexto enche';

  // ações
  const podeRev = ST_PARADA.has(st);
  R.btnRev.hidden = !podeRev;
  if (podeRev) {
    const t = x.rev ? 'Desmarcar como revisada' : 'Marcar como revisada';
    const ic = x.rev ? 'check-duplo' : 'check';
    if (R.btnRev.dataset.t !== t) { R.btnRev.dataset.t = t; R.btnRev.replaceChildren(OM.icone(ic, 16), h('span', null, t)); }
    R.btnRev.classList.toggle('feito', x.rev);
  }
  if (v.pend.encerrar && x.enc) v.pend.encerrar = 0;
  if (v.pend.retomar && !x.enc) v.pend.retomar = 0;
  R.btnRetomar.hidden = !(orbit && x.enc);
  R.btnEncerrar.hidden = !(orbit && !x.enc);
  R.btnRetomar.disabled = !!v.pend.retomar;
  R.btnEncerrar.disabled = !!v.pend.encerrar;
  rotuloBotao(R.btnRetomar, v.pend.retomar ? 'Retomando…' : 'Retomar');
  rotuloBotao(R.btnEncerrar, v.pend.encerrar ? 'Encerrando…' : 'Encerrar instância');
  R.acoes.hidden = R.btnRev.hidden && R.btnRetomar.hidden && R.btnEncerrar.hidden;
  R.acoes.parentElement.hidden = R.acoes.hidden;

  // agentes e tarefas
  const ags = (Array.isArray(s.agentes) ? s.agentes : []).filter((a) => a && a.id);
  const sigAg = JSON.stringify(ags.map((a) => [a.id, a.status, a.tipo, a.descricao, a.ferramentas, a.ferramenta && a.ferramenta.nome, a.ferramenta && a.ferramenta.alvo]));
  R.secAg.hidden = !ags.length;
  if (v.sig.ag !== sigAg) { v.sig.ag = sigAg; R.listaAg.replaceChildren(...ags.map(cartaoAgente)); }
  const tas = c && Array.isArray(c.tarefas) ? c.tarefas.filter((t) => t && t.id) : [];
  const sigTa = JSON.stringify(tas.map((t) => [t.id, t.tipo, t.descricao]));
  R.secTa.hidden = !tas.length;
  if (v.sig.ta !== sigTa) { v.sig.ta = sigTa; R.listaTa.replaceChildren(...tas.map(cartaoTarefa)); }
  tempos(v);
}

function rotuloBotao(btn, texto) {
  const sp = btn.lastElementChild;
  if (sp && sp.textContent !== texto) sp.textContent = texto;
}

// Tempos que correm sozinhos (a cada 30 s e a cada render).
function tempos(v) {
  const s = OM.sessao(v.id), L = v.refs.linhas;
  if (!s) return;
  const atv = Number(s.atividade) || Number(s.desde) || 0;
  textoLinha(L.atividade, atv ? 'há ' + OM.fmt.tempo(atv).replace(/^agora$/, 'instantes') : '');
  textoLinha(L.neste, s.desde ? OM.fmt.duracao(Date.now() - OM.fmt.emMs(s.desde)) : '');
  for (const el of v.refs.cont.querySelectorAll('[data-ini]')) {
    const ini = Number(el.dataset.ini), fim = Number(el.dataset.fim) || 0;
    const t = OM.fmt.duracao((fim || Date.now()) - ini);
    if (el.textContent !== t) el.textContent = t;
  }
}

function cartaoAgente(a) {
  const st = a.status === 'trabalhando' || a.status === 'aguardando' || a.status === 'erro' ? a.status : 'concluido';
  const ferr = a.ferramenta && a.ferramenta.nome ? a.ferramenta.nome + (a.ferramenta.alvo ? ' · ' + OM.fmt.basename(a.ferramenta.alvo) : '') : '';
  const meta = [];
  if (Number(a.ferramentas) > 0) meta.push(a.ferramentas + ' ferramentas');
  const dur = h('span', { dados: { ini: String(OM.fmt.emMs(a.inicio) || Date.now()), fim: a.fim ? String(OM.fmt.emMs(a.fim)) : '' } });
  return h('div', { class: 'dt-ag', dados: { s: st } },
    h('div', { class: 'dt-ag-l1' }, h('span', { class: 'dt-ag-tipo' }, a.tipo || 'Agente'), OM.base ? OM.base.pilula(st, OM.base.ROTULO_AGENTE[st], true) : ''),
    a.descricao ? h('p', { class: 'dt-ag-desc' }, OM.fmt.limpo(a.descricao)) : '',
    h('p', { class: 'dt-ag-meta' }, ferr && st === 'trabalhando' ? h('span', { class: 'dt-ag-ferr' }, ferr) : '', ...(meta.length ? [meta.join(' · '), ' · '] : []), dur));
}
function cartaoTarefa(t) {
  return h('div', { class: 'dt-ta' }, h('span', { class: 'dt-ta-ico' }, OM.icone(t.tipo === 'local_bash' ? 'terminal' : 'robo', 18)),
    h('div', { class: 'dt-ta-txt' }, h('span', { class: 'dt-ta-tipo' }, TIPO_TAREFA[t.tipo] || OM.fmt.limpo(t.tipo) || 'Tarefa'),
      h('p', { class: 'dt-ta-desc' }, OM.fmt.limpo(t.descricao) || 'Sem descrição')));
}

// ───────────────────────────── ações (otimistas, com reversão) ─────────────────────────────
function erroTexto(e, padrao) {
  if (e && e.rede) return e.message;
  if (e && e.status === 409 && e.codigo === 'ocupada') return 'A instância está respondendo ou com tarefas em segundo plano. Pare a resposta pela conversa e tente de novo.';
  if (e && e.status === 404) return 'Esta sessão não está mais no Orbit.';
  if (e && e.status === 400 && e.codigo === 'campo_nao_permitido') return 'O Orbit recusou esse campo pelo celular.';
  return (e && e.message && /\s/.test(e.message) && e.message) || padrao;
}
function sobrepor(v, campo, valor) { v.ovr[campo] = { valor, ate: Date.now() + PRAZO_OVR }; render(v); }
function reverter(v, campo) { delete v.ovr[campo]; render(v); }

// Aplica o valor na hora e confirma no servidor; no erro volta ao valor de antes e avisa.
async function alternar(v, campo, valor, input) {
  if (!OM.sessao(v.id)) return;
  const seq = (v.pend[campo] = (v.pend[campo] || 0) + 1);
  sobrepor(v, campo, valor);
  const [caminho, corpo] = campo === 'autocompactar' ? [rota(v.id, '/autocompactar'), { ativo: valor }]
    : campo === 'revisada' ? [rota(v.id, '/revisada'), { revisada: valor }]
      : [rota(v.id), { [campo]: valor }];
  try {
    await OM.api('POST', caminho, corpo);
  } catch (e) {
    if (seq !== v.pend[campo]) return;      // outro toque mais novo vale
    reverter(v, campo);
    if (input) input.checked = !valor;
    OM.toast(erroTexto(e, 'Não deu para salvar. Tente de novo.'));
  }
}

function editarApelido(v) {
  const s = OM.sessao(v.id);
  if (!s || !OM.folha) return;
  const atual = (v.vista && v.vista.apelido) || '';
  OM.folha.abrir({
    titulo: 'Apelido da sessão', paradas: ['auto'],
    conteudo: (corpo, f) => {
      const campo = h('input', { class: 'dt-campo', type: 'text', maxlength: 60, value: atual, placeholder: OM.fmt.titulo({ ...s, apelido: '' }), autocomplete: 'off', autocapitalize: 'sentences', enterkeyhint: 'done', 'aria-label': 'Apelido' });
      const cont = h('span', { class: 'dt-cont' });
      const conta = () => { cont.textContent = campo.value.length + '/60'; };
      conta();
      campo.addEventListener('input', conta);
      const salvar = () => {
        const novo = campo.value.replace(/\s+/g, ' ').trim().slice(0, 60);
        f.fechar('botao');
        if (novo !== atual) salvarApelido(v, novo, atual);
      };
      campo.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); salvar(); } });
      const cancelar = h('button', { class: 'btn toque', type: 'button', onclick: () => f.fechar('botao') }, 'Cancelar');
      const ok = h('button', { class: 'btn toque solido', type: 'button', onclick: salvar }, 'Salvar');
      corpo.append(h('p', { class: 'folha-texto' }, 'Um nome só seu para achar a sessão na lista. Deixe vazio para voltar ao título original.'),
        h('div', { class: 'dt-campo-box' }, campo, cont), h('div', { class: 'folha-acoes' }, cancelar, ok));
    },
  });
}
async function salvarApelido(v, novo, antes) {
  const seq = (v.pend.apelido = (v.pend.apelido || 0) + 1);
  sobrepor(v, 'apelido', novo);
  try {
    await OM.api('POST', rota(v.id), { apelido: novo });
  } catch (e) {
    if (seq !== v.pend.apelido) return;
    reverter(v, 'apelido');
    OM.toast(erroTexto(e, 'Não deu para salvar o apelido.'));
  }
  void antes;
}

async function retomar(v) {
  if (v.pend.retomar) return;
  v.pend.retomar = 1;
  render(v);
  try {
    await OM.api('POST', rota(v.id, '/retomar'), {});
    setTimeout(() => { if (v.pend.retomar) { v.pend.retomar = 0; if (v.vista) render(v); } }, 10000);
  } catch (e) {
    v.pend.retomar = 0;
    render(v);
    OM.toast(erroTexto(e, 'Não deu para retomar a instância.'));
  }
}
async function encerrar(v) {
  if (v.pend.encerrar) return;
  const ok = await OM.confirmar({ titulo: 'Encerrar a instância?', texto: 'O processo do Claude Code desta sessão será encerrado. Você pode retomá-lo depois.', sim: 'Encerrar', nao: 'Cancelar', perigo: true });
  if (!ok) return;
  v.pend.encerrar = 1;
  render(v);
  try {
    await OM.api('POST', rota(v.id, '/encerrar'), {});   // nunca `forcar`: o remoto apaga e responde 409 se estiver ocupada
    setTimeout(() => { if (v.pend.encerrar) { v.pend.encerrar = 0; if (v.vista) render(v); } }, 10000);
  } catch (e) {
    v.pend.encerrar = 0;
    render(v);
    OM.toast(erroTexto(e, 'Não deu para encerrar a instância.'));
  }
}

OM.telas.registrar('detalhe', {
  titulo: () => 'Detalhes',
  semBarra: false,
  montar,
  mostrar(ctx) {
    const v = VIVAS.get(ctx);
    if (!v) return;
    clearInterval(v.timer);
    v.timer = setInterval(() => { if (!document.hidden) tempos(v); }, 30000);
    render(v);
  },
  esconder(ctx) { const v = VIVAS.get(ctx); if (v) clearInterval(v.timer); },
  atualizar(_estado, ctx) { const v = VIVAS.get(ctx); if (v) render(v); },
  desmontar(ctx) { const v = VIVAS.get(ctx); if (v) { clearInterval(v.timer); VIVAS.delete(ctx); } },
});
})();
