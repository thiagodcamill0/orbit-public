// Orbit no celular — tela nova (onda 3). Arquivo reservado ao dono da tela; API no contrato, "App do celular".
// Aberta por #nova. Cria uma instância do Claude Code no PC: projeto, modelo, esforço, modo de permissão, nome opcional e a
// 1ª mensagem (com fotos, pelo OM.composer). O POST /instancias leva SÓ as chaves permitidas pelo remoto:
// pasta, cwd, modelo, esforco, permissao, nome, texto, imagens (qualquer outra → 400 campo_nao_permitido).
(function () {
'use strict';
const OM = window.OM;
if (!OM || !OM.telas) return;
const { h } = OM;

const ESFORCO = { low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo' };
// Os mesmos modos do PC (assets/instancias.js); o padrão do PC é Auto. "Sem permissões" nunca aparece no celular.
const MODOS = [
  ['default', 'Padrão', 'Pede sua permissão antes de editar arquivos e rodar comandos'],
  ['acceptEdits', 'Aceitar edições', 'Edita arquivos sem pedir; comandos ainda pedem permissão'],
  ['plan', 'Planejar', 'Só planeja: não edita nem roda nada até você aprovar o plano'],
  ['auto', 'Auto', 'Age sem pedir; um verificador barra as ações arriscadas'],
];
const MODO_PADRAO = 'auto';
const CHAVE_PASTA = 'orbit-m-nova-pasta';
const AVISO_DESLIGADO = 'Criar instâncias pelo celular está desligado nas Configurações do Orbit no PC';

const lembrar = (v) => { try { if (v === undefined) return localStorage.getItem(CHAVE_PASTA) || ''; localStorage.setItem(CHAVE_PASTA, v); } catch { /* sem armazenamento */ } return ''; };
const ligado = () => !!(OM.estado.eu && OM.estado.eu.opcoes && OM.estado.eu.opcoes.criarInstancias);

function rotuloModelo(m, todos) {
  if (m.valor !== 'default') return m.nome || m.valor;
  const alvo = todos.find((x) => x.valor !== 'default' && x.modelo === m.modelo);
  return 'Padrão · ' + ((alvo && alvo.nome) || m.descricao || m.modelo || 'recomendado');
}

function textoErro(e) {
  if (!e) return 'Não deu para criar a instância.';
  if (e.rede) return e.message;
  if (e.status === 403 && e.codigo === 'comando_nao_permitido') return 'Esse comando com barra não é permitido pelo celular. Só /compact, /clear e as skills ou comandos do projeto passam. Tire a barra do começo ou use um deles.';
  if (e.status === 400 && e.codigo === 'campo_nao_permitido') return 'O Orbit recusou um dado do pedido (campo não permitido pelo celular). Atualize o app e tente de novo.';
  if (e.status === 403) return AVISO_DESLIGADO + '.';
  if (e.status === 413) return 'O pedido ficou grande demais (fotos ou texto). Tire alguma foto e tente de novo.';
  if (e.status === 503) return 'O Orbit ainda não conseguiu abrir o Claude Code. Espere uns segundos e tente de novo.';
  return (e.message && /\s/.test(e.message) && e.message) || 'Não deu para criar a instância (o servidor respondeu ' + (e.status || 'sem resposta') + ').';
}

const VIVAS = new WeakMap();

function montar(cont, params, ctx) {
  const v = { ctx, projetos: null, modelos: null, pasta: '', modelo: '', esforco: '', permissao: MODO_PADRAO, ocupado: false, carga: 0, comp: null, ta: null, refs: {}, falhou: '' };
  VIVAS.set(ctx, v);
  cont.classList.add('nv');
  const R = v.refs;

  R.aviso = h('div', { class: 'nv-aviso', role: 'status', hidden: true }, OM.icone('info', 20), h('p', null, AVISO_DESLIGADO + '.'));

  // projeto, modelo
  R.selProj = h('select', { class: 'nv-sel', 'aria-label': 'Projeto' });
  R.selProj.addEventListener('change', () => { v.pasta = R.selProj.value; lembrar(v.pasta); });
  R.selMod = h('select', { class: 'nv-sel', 'aria-label': 'Modelo' });
  R.selMod.addEventListener('change', () => { v.modelo = R.selMod.value; esforcosDe(v); });
  R.esfBox = h('div', { class: 'seg-filtro nv-esf', role: 'group', 'aria-label': 'Esforço' });
  R.modoBox = h('div', { class: 'nv-modos', role: 'radiogroup', 'aria-label': 'Modo de permissão' });
  R.modoBtns = MODOS.map(([valor, rot, desc]) => {
    const b = h('button', { class: 'nv-modo toque', type: 'button', role: 'radio', 'aria-checked': 'false', dados: { v: valor } },
      h('span', { class: 'nv-modo-ponto', 'aria-hidden': 'true' }), h('span', { class: 'nv-modo-txt' }, h('span', { class: 'nv-modo-t' }, rot), h('span', { class: 'nv-modo-d' }, desc)));
    b.addEventListener('click', () => { v.permissao = valor; marcarModo(v); });
    return b;
  });
  R.modoBox.append(...R.modoBtns);
  marcarModo(v);

  R.nome = h('input', { class: 'nv-campo', type: 'text', maxlength: 60, placeholder: 'Opcional', autocomplete: 'off', autocapitalize: 'sentences', enterkeyhint: 'next', 'aria-label': 'Nome da instância' });

  // 1ª mensagem: o composer (com fotos); sem ele, um textarea simples
  R.slot = h('div', { class: 'nv-slot' });
  R.erro = h('div', { class: 'nv-erro', role: 'alert', hidden: true });
  R.btnCriar = h('button', { class: 'btn solido toque nv-criar', type: 'button' }, OM.icone('mais', 16), h('span', null, 'Criar instância'));
  R.btnCriar.addEventListener('click', () => enviar(v));
  R.recarregar = h('button', { class: 'btn toque nv-recarregar', type: 'button', hidden: true }, 'Tentar de novo');
  R.recarregar.addEventListener('click', () => carregar(v, true));
  R.carregando = h('div', { class: 'nv-carr', hidden: true }, h('div', { class: 'esq nv-esq' }), h('div', { class: 'esq nv-esq' }), h('div', { class: 'esq nv-esq' }));
  R.errCarga = h('div', { class: 'nv-erro', role: 'alert', hidden: true });

  const campo = (rotulo, ...filhos) => h('section', { class: 'nv-sec' }, h('h3', { class: 'nv-sec-t' }, rotulo), ...filhos);
  R.form = h('div', { class: 'nv-form', hidden: true },
    campo('Projeto', R.selProj),
    campo('Modelo', R.selMod),
    R.secEsf = campo('Esforço', R.esfBox),
    campo('Modo de permissão', R.modoBox),
    campo('Nome', R.nome),
    campo('Primeira mensagem', R.slot),
    R.erro,
    R.btnCriar);
  cont.append(R.aviso, R.carregando, R.errCarga, R.recarregar, R.form);
}

function montarComposer(v) {
  const R = v.refs;
  if (v.comp || v.ta) return;
  if (OM.composer && typeof OM.composer.montar === 'function') {
    try {
      v.comp = OM.composer.montar(R.slot, { nova: true, aoEnviar: (dado) => criar(v, dado || {}) }) || true;
      return;
    } catch (e) { console.error('OM.composer.montar', e); R.slot.replaceChildren(); }
  }
  v.ta = h('textarea', { class: 'nv-texto', rows: 4, maxlength: 20000, placeholder: 'O que a nova instância deve fazer? (opcional)', 'aria-label': 'Primeira mensagem' });
  R.slot.append(v.ta);
}

function marcarModo(v) {
  for (const b of v.refs.modoBtns) {
    const on = b.dataset.v === v.permissao;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.classList.toggle('on', on);
  }
}

function esforcosDe(v) {
  const R = v.refs;
  const m = (v.modelos || []).find((x) => x.valor === v.modelo);
  const l = m && Array.isArray(m.esforcos) ? m.esforcos : [];
  if (v.esforco && !l.includes(v.esforco)) v.esforco = '';
  R.secEsf.hidden = !l.length;
  const itens = [['', 'Padrão'], ...l.map((e) => [e, ESFORCO[e] || e])];
  R.esfBox.replaceChildren(...itens.map(([valor, rot]) => {
    const b = h('button', { type: 'button', 'aria-pressed': valor === v.esforco ? 'true' : 'false' }, rot);
    b.addEventListener('click', () => { v.esforco = valor; esforcosDe(v); });
    return b;
  }));
}

// Projetos e modelos (uma carga só; "Tentar de novo" repete).
async function carregar(v, forcar) {
  const R = v.refs;
  if (!ligado()) return;
  if (!forcar && v.projetos) return;
  const n = ++v.carga;
  v.buscando = true;
  R.errCarga.hidden = true;
  R.recarregar.hidden = true;
  R.carregando.hidden = false;
  R.form.hidden = true;
  const [pr, mo] = await Promise.allSettled([OM.api('GET', '/remoto/projetos'), OM.api('GET', '/modelos')]);
  if (n !== v.carga) return;
  v.buscando = false;
  R.carregando.hidden = true;
  if (pr.status !== 'fulfilled') {
    const e = pr.reason;
    if (e && e.status === 403) { R.aviso.hidden = false; return; }
    R.errCarga.textContent = 'Não deu para listar os projetos: ' + ((e && e.message) || 'erro desconhecido');
    R.errCarga.hidden = false;
    R.recarregar.hidden = false;
    return;
  }
  const lista = (Array.isArray(pr.value) ? pr.value : (pr.value && pr.value.projetos) || []).filter((p) => p && p.pasta);
  v.projetos = lista;
  R.selProj.replaceChildren(...(lista.length ? lista.map((p) => h('option', { value: p.pasta }, p.nome || OM.fmt.basename(p.pasta))) : [h('option', { value: '' }, 'Nenhum projeto cadastrado')]));
  const ultimo = lembrar();
  v.pasta = lista.some((p) => p.pasta === (v.pasta || ultimo)) ? (v.pasta || ultimo) : (lista[0] ? lista[0].pasta : '');
  R.selProj.value = v.pasta;
  if (mo.status === 'fulfilled') {
    const l = (Array.isArray(mo.value) ? mo.value : (mo.value && mo.value.modelos) || []).filter((m) => m && m.valor);
    v.modelos = l;
    R.selMod.replaceChildren(...l.map((m) => h('option', { value: m.valor }, rotuloModelo(m, l))));
    v.modelo = l.some((m) => m.valor === v.modelo) ? v.modelo : (l[0] ? l[0].valor : '');
    R.selMod.value = v.modelo;
    R.selMod.disabled = false;
  } else {
    v.modelos = [];
    v.modelo = '';
    R.selMod.replaceChildren(h('option', { value: '' }, 'Modelo padrão'));
    R.selMod.disabled = true;
  }
  esforcosDe(v);
  R.form.hidden = false;
  montarComposer(v);
  ocupar(v, v.ocupado);
}

function mostrarErro(v, t) {
  const el = v.refs.erro;
  el.hidden = !t;
  el.textContent = t || '';
}

function ocupar(v, sim) {
  const R = v.refs;
  v.ocupado = sim;
  R.form.classList.toggle('ocupado', sim);
  for (const el of [R.selProj, R.selMod, R.nome]) el.disabled = sim || (el === R.selMod && !(v.modelos && v.modelos.length));
  for (const b of R.esfBox.children) b.disabled = sim;
  for (const b of R.modoBtns) b.disabled = sim;
  if (v.ta) v.ta.disabled = sim;
  R.btnCriar.disabled = sim || !v.pasta;
  R.btnCriar.setAttribute('aria-busy', sim ? 'true' : 'false');
  R.btnCriar.replaceChildren(sim ? h('span', { class: 'gira-btn', 'aria-hidden': 'true' }) : OM.icone('mais', 16), h('span', null, sim ? 'Criando…' : 'Criar instância'));
  if (v.comp && v.comp !== true && typeof v.comp.ocupado === 'function') { try { v.comp.ocupado(sim); } catch { /* composer sem esse gancho */ } }
}

// Botão "Criar": pede ao composer para enviar (ele chama aoEnviar com texto e fotos) ou lê o textarea.
function enviar(v) {
  if (v.ocupado) return;
  if (v.comp && v.comp !== true && typeof v.comp.enviar === 'function') { v.comp.enviar(); return; }
  if (v.comp) {
    const b = v.refs.slot.querySelector('.cp-enviar');
    // A 1ª mensagem é opcional: o Enviar do composer nasce desabilitado sem texto e sem foto; aí cria direto.
    const vazio = !(v.refs.slot.querySelector('textarea') || {}).value?.trim() && !v.refs.slot.querySelector('.cp-mini');
    if (b && !(b.disabled && vazio)) { b.click(); return; }
    criar(v, { texto: '', imagens: [] });
    return;
  }
  criar(v, { texto: v.ta ? v.ta.value : '', imagens: [] });
}

// POST /instancias só com as chaves permitidas. Devolve true (criou) ou false (erro mostrado na tela).
async function criar(v, dado) {
  if (v.ocupado) return false;
  const R = v.refs;
  if (!v.pasta) { mostrarErro(v, 'Escolha um projeto.'); return false; }
  const texto = String(dado.texto == null ? '' : dado.texto).slice(0, 20000);
  const imagens = Array.isArray(dado.imagens) ? dado.imagens.filter(Boolean) : [];
  const corpo = { pasta: v.pasta, cwd: v.pasta, permissao: v.permissao || MODO_PADRAO };
  if (v.modelo) corpo.modelo = v.modelo;
  if (v.esforco) corpo.esforco = v.esforco;
  const nome = R.nome.value.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (nome) corpo.nome = nome;
  if (texto.trim()) corpo.texto = texto;
  if (imagens.length) corpo.imagens = imagens;
  mostrarErro(v, '');
  ocupar(v, true);
  try {
    const d = await OM.api('POST', '/instancias', corpo);
    const s = d && d.sessao;
    const id = typeof s === 'string' ? s : (s && s.id) || (d && d.acao && d.acao.sessao) || (d && d.id) || '';
    OM.toast('Instância criada.');
    ocupar(v, false);
    R.nome.value = '';
    if (v.ta) v.ta.value = '';
    OM.rotas.ir(id ? '#s=' + encodeURIComponent(id) : '#sessoes', { substituir: true });
    return true;
  } catch (e) {
    mostrarErro(v, textoErro(e));
    ocupar(v, false);
    return false;
  }
}

function render(v) {
  const R = v.refs;
  if (!OM.estado.eu) { R.aviso.hidden = true; R.carregando.hidden = false; R.form.hidden = true; return; }   // ainda sem /remoto/eu
  const on = ligado();
  R.aviso.hidden = on;
  if (!on) {
    R.form.hidden = true; R.carregando.hidden = true; R.errCarga.hidden = true; R.recarregar.hidden = true;
    return;
  }
  if (v.projetos) R.form.hidden = false;
  else if (!v.buscando && R.errCarga.hidden) carregar(v, false);   // erro de carga: só o botão "Tentar de novo" repete
}

OM.telas.registrar('nova', {
  titulo: () => 'Nova instância',
  semBarra: true,
  montar,
  mostrar(ctx) { const v = VIVAS.get(ctx); if (v) render(v); },
  atualizar(_estado, ctx) { const v = VIVAS.get(ctx); if (v) render(v); },
  desmontar(ctx) { const v = VIVAS.get(ctx); if (v) { v.carga++; VIVAS.delete(ctx); } },
});
})();
