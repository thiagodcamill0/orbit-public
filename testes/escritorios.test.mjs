// Teste dos Escritórios (escritorios.mjs) com controle FALSO (interface do contrato §4) e req/res falsos.
// node --test testes/escritorios.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { criarEscritorios, anexoOrquestrador, anexoMembro, configuracaoHook, ambienteDe, MATCHER_HOOK } from '../escritorios.mjs';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-escritorios-'));
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

let seq = 0;

async function lerJSONCorpo(req, limite) {
  let tam = 0; const partes = [];
  for await (const c of req) {
    tam += c.length;
    if (tam > limite) { const e = new Error('corpo grande demais'); e.status = 413; throw e; }
    partes.push(c);
  }
  const bruto = Buffer.concat(partes).toString('utf8');
  try { return bruto.trim() ? JSON.parse(bruto) : {}; } catch { const e = new Error('JSON inválido'); e.status = 400; throw e; }
}

// Controle falso: guarda as chamadas e deixa o teste disparar o evento `result`.
function controleFalso() {
  const c = {
    n: 0, teto: 99, sessoes: new Map(), ouvintes: [], ocupadas: new Set(), chamadas: [],
    async criarInstancia(b) {
      c.chamadas.push(['criarInstancia', b]);
      if (c.sessoes.size >= c.teto) { const e = new Error('Teto de instâncias de escritório atingido.'); e.status = 429; throw e; }
      const id = `sess-${++c.n}`;
      c.sessoes.set(id, { b, viva: true });
      return { sessao: id, acao: {} };
    },
    enviarMensagem(id, t) { c.chamadas.push(['enviarMensagem', id, t]); return !!c.sessoes.get(id)?.viva; },
    interromper(id) { c.chamadas.push(['interromper', id]); return true; },
    encerrar(id) { c.chamadas.push(['encerrar', id]); const s = c.sessoes.get(id); if (s) s.viva = false; return true; },
    avisarLider(id, t) { c.chamadas.push(['avisarLider', id, t]); return !!c.sessoes.get(id)?.viva; },
    ouvirResultado(fn) { c.ouvintes.push(fn); return () => { c.ouvintes = c.ouvintes.filter((x) => x !== fn); }; },
    estado(id) { return c.sessoes.has(id) ? { ocupada: c.ocupadas.has(id) } : null; },
    adormecer(id) { c.chamadas.push(['adormecer', id]); return true; },
    listarEscritorio() { return [...c.sessoes].filter(([, s]) => s.viva && s.b.escritorio).map(([id, s]) => ({ id, escritorio: s.b.escritorio, processo: 1 })); },
    resultado(id, r = {}) { for (const f of c.ouvintes) f(id, { custoUsd: 0, texto: '', erro: false, ...r }); },
    de(nome) { return c.chamadas.filter((x) => x[0] === nome); },
  };
  return c;
}

// Ambiente de um teste: pasta própria, controle falso, relógio manual.
function ambiente(extra = {}) {
  const dir = path.join(TMP, `t${++seq}`);
  const projeto = path.join(dir, 'projeto');
  fs.mkdirSync(projeto, { recursive: true });
  const ctl = controleFalso();
  const eventos = [], alertas = [], celular = [];
  const alertasSse = () => eventos.filter(([t, d]) => t === 'escritorio' && d.alerta).map(([, d]) => ({ id: d.id, ...d.alerta }));
  const relogio = { agora: new Date(2026, 9, 21, 10, 0, 0) };
  let plano = 10;
  const deps = {
    pasta: path.join(dir, 'escritorios'), raizOrbit: RAIZ, porta: 47822, lerJSONCorpo, log: () => {},
    publicar: (tipo, d) => eventos.push([tipo, d]),
    alertar: (tipo, d) => alertas.push([tipo, d]),
    notificarCelular: (id, nome, t) => celular.push([id, nome, t]),
    sessao: (id) => ctl.sessoes.get(id)?.dados || null,
    usoPlano: () => ({ cincoHoras: { pct: plano } }),
    validarModelo: (m, e) => (m === 'ruim' ? false : e === 'ruim' ? 'Esforço inválido' : true),
    controle: ctl, relogio: () => relogio.agora, atrasoFim: 0, vigiaMs: 0, ...extra,
  };
  const esc = criarEscritorios(deps);
  async function chamar(metodo, caminho, corpo, headers = {}) {
    const url = new URL(caminho, 'http://127.0.0.1');
    const req = Readable.from(corpo !== undefined ? [Buffer.from(typeof corpo === 'string' ? corpo : JSON.stringify(corpo))] : []);
    req.method = metodo;
    req.headers = metodo === 'POST' ? { 'x-gerenciador': '1', ...headers } : { ...headers };
    const out = { status: 0, texto: '' };
    const res = { headersSent: false, writeHead(s) { out.status = s; this.headersSent = true; }, end(t) { out.texto = t; } };
    const tratou = await esc.tratar(req, res, url);
    await esc.aguardar();
    return { tratou, status: out.status, corpo: out.texto ? JSON.parse(out.texto) : null };
  }
  const base = (extra2 = {}) => ({
    nome: 'Marketing', funcao: 'Cuida do marketing', pasta: projeto,
    orquestrador: { prompt: 'Você lidera o marketing.' },
    membros: [
      { id: 'redator', papel: 'Redator', nome: 'Rê', prompt: 'Escreva textos.' },
      { id: 'revisor', papel: 'Revisor', prompt: 'Revise textos.' },
    ],
    ...extra2,
  });
  async function criar(extra2) {
    const r = await chamar('POST', '/escritorios', base(extra2));
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    return r.corpo.escritorio;
  }
  async function acionar(id, tarefa = 'Faça a campanha') {
    const r = await chamar('POST', `/escritorios/${id}/acionar`, { tarefa });
    assert.equal(r.status, 202, JSON.stringify(r.corpo));
    return r.corpo.execucao;
  }
  const enviar = (id, membro, orq, tarefa = 'Escreva o texto') =>
    chamar('POST', `/escritorios/${id}/membro/${membro}/enviar`, { tarefa }, { 'x-orbit-sessao': orq });
  return { dir, projeto, ctl, eventos, alertas, celular, alertasSse, relogio, esc, chamar, base, criar, acionar, enviar, deps, setPlano: (p) => { plano = p; } };
}

// ───────────────────────── validação ─────────────────────────

test('validação do cadastro e valores padrão', async () => {
  const a = ambiente();
  const ok = await a.criar();
  assert.match(ok.id, /^[a-z0-9-]+$/);
  assert.equal(ok.versao, 1);
  assert.deepEqual(ok.canvas, { x: 0, y: 0 });
  assert.equal(ok.orquestrador.nome, 'Orquestrador');
  assert.equal(ok.orquestrador.prompt, 'Você lidera o marketing.');
  assert.deepEqual(ok.convidados, { limite: 2 });
  assert.deepEqual(ok.orcamento, { porExecucaoUsd: 2, porDiaUsd: 10, avisoPct: 80 });
  assert.deepEqual(ok.externas, { extras: [] });
  assert.equal(ok.membros[1].nome, 'Revisor', 'nome do membro herda o papel');
  assert.equal(ok.membros[0].provedor, 'claude');
  assert.ok(ok.criado && ok.atualizado);

  const falha = async (corpo, parte, status = 400) => {
    const r = await a.chamar('POST', '/escritorios', corpo);
    assert.equal(r.status, status, `${parte}: ${JSON.stringify(r.corpo)}`);
    assert.ok(r.corpo.erro, parte);
  };
  const mem = (o) => ({ id: 'x', papel: 'X', ...o });
  await falha(a.base({ nome: '' }), 'nome vazio');
  await falha(a.base({ nome: undefined }), 'sem nome');
  await falha(a.base({ nome: 'n'.repeat(61) }), 'nome 61');
  await falha(a.base({ funcao: 'f'.repeat(501) }), 'função 501');
  await falha(a.base({ pasta: 'relativa/pasta' }), 'pasta relativa');
  await falha(a.base({ pasta: path.join(a.dir, 'nao-existe') }), 'pasta inexistente');
  await falha(a.base({ pasta: path.join(a.projeto, '..', 'projeto', 'x.txt') }), 'pasta que é arquivo (inexistente)');
  await falha(a.base({ orquestrador: { nome: 'n'.repeat(41) } }), 'nome do orquestrador 41');
  await falha(a.base({ orquestrador: { prompt: 'p'.repeat(8001) } }), 'prompt 8001');
  await falha(a.base({ orquestrador: { modelo: 'ruim' } }), 'modelo recusado por validarModelo');
  await falha(a.base({ orquestrador: { modelo: 'ok', esforco: 'ruim' } }), 'esforço recusado');
  await falha(a.base({ membros: [mem({ id: 'Maiúsculo' })] }), 'id com maiúscula');
  await falha(a.base({ membros: [mem({ id: 'a'.repeat(31) })] }), 'id 31');
  await falha(a.base({ membros: [mem({ id: 'orquestrador' })] }), 'id reservado');
  await falha(a.base({ membros: [mem(), mem()] }), 'id repetido');
  await falha(a.base({ membros: [mem({ papel: '' })] }), 'sem papel');
  await falha(a.base({ membros: [mem({ provedor: 'codex' })] }), 'provedor codex');
  await falha(a.base({ membros: Array.from({ length: 9 }, (_, i) => mem({ id: `m${i}` })) }), '9 membros');
  await falha(a.base({ convidados: { limite: 7 } }), 'convidados 7');
  await falha(a.base({ convidados: { limite: -1 } }), 'convidados -1');
  await falha(a.base({ convidados: { limite: 1.5 } }), 'convidados fracionado');
  await falha(a.base({ orcamento: { porExecucaoUsd: 0 } }), 'orçamento 0');
  await falha(a.base({ orcamento: { porDiaUsd: -1 } }), 'orçamento dia negativo');
  await falha(a.base({ orcamento: { avisoPct: 49 } }), 'aviso 49');
  await falha(a.base({ orcamento: { avisoPct: 96 } }), 'aviso 96');
  await falha(a.base({ externas: { extras: ['a'.repeat(201)] } }), 'texto 201');
  await falha(a.base({ externas: { extras: 'x' } }), 'extras não é lista');
  await falha('[1]', 'corpo lista');
  await falha('{quebrado', 'JSON inválido');

  // limites que passam
  const lim = await a.chamar('POST', '/escritorios', a.base({
    nome: 'n'.repeat(60), orquestrador: { nome: 'o'.repeat(40) }, convidados: { limite: 0 }, orcamento: { avisoPct: 95, porDiaUsd: 0.5 },
    membros: Array.from({ length: 8 }, (_, i) => mem({ id: `m${i}` })), externas: { extras: ['^foo\\b', '(abre'] },
  }));
  assert.equal(lim.status, 200, JSON.stringify(lim.corpo));
  assert.deepEqual(lim.corpo.escritorio.externas.extras, ['^foo\\b', '(abre'], 'extras é texto literal, sem regex');
  assert.equal(lim.corpo.escritorio.membros.length, 8);

  // POST sem o cabeçalho
  const sem = await a.chamar('POST', '/escritorios', a.base(), { 'x-gerenciador': '0' });
  assert.equal(sem.status, 403);
  // não é rota nossa
  assert.equal((await a.chamar('GET', '/outra-coisa')).tratou, false);
  assert.equal((await a.chamar('DELETE', '/escritorios')).tratou, false);
});

// ───────────────────────── criar / salvar / duplicar / excluir ─────────────────────────

test('criar, listar, salvar, duplicar e excluir (gravação em disco)', async () => {
  const a = ambiente();
  const e1 = await a.criar();
  const arq = path.join(a.deps.pasta, `${e1.id}.json`);
  assert.ok(fs.existsSync(arq));
  assert.deepEqual(JSON.parse(fs.readFileSync(arq, 'utf8')), e1);
  assert.equal(fs.readdirSync(a.deps.pasta).filter((n) => n.endsWith('.tmp')).length, 0, 'sem tmp sobrando');

  const lista = await a.chamar('GET', '/escritorios');
  assert.equal(lista.corpo.escritorios.length, 1);
  assert.deepEqual(lista.corpo.escritorios[0], {
    id: e1.id, nome: 'Marketing', funcao: 'Cuida do marketing', criado: e1.criado, membros: 2, status: 'ociosa', ativos: 0,
    canvas: { x: 0, y: 0 },
    agentes: [
      { id: 'orquestrador', nome: 'Orquestrador', papel: 'Orquestrador', provedor: 'claude', estado: 'dormindo' },
      { id: 'redator', nome: 'Rê', papel: 'Redator', provedor: 'claude', estado: 'dormindo' },
      { id: 'revisor', nome: 'Revisor', papel: 'Revisor', provedor: 'claude', estado: 'dormindo' },
    ],
    convidados: 0,
    custo: { execucaoUsd: 0, diaUsd: 0, limiteExecucaoUsd: 2, limiteDiaUsd: 10, planoPct: 0 },
  });
  assert.ok(a.eventos.some(([t, d]) => t === 'escritorio' && d.id === e1.id && d.resumo.nome === 'Marketing'));

  const det = await a.chamar('GET', `/escritorios/${e1.id}`);
  assert.equal(det.status, 200);
  assert.equal(det.corpo.escritorio.id, e1.id);
  assert.equal(det.corpo.execucao.status, 'ociosa');
  assert.equal((await a.chamar('GET', '/escritorios/naoexiste')).status, 404);
  assert.equal((await a.chamar('GET', '/escritorios/Inválido!')).status, 400);

  // salvar: troca só o que veio; o resto fica
  await new Promise((r) => setTimeout(r, 5));
  const sv = await a.chamar('POST', `/escritorios/${e1.id}`, { nome: 'Marketing 2', orcamento: { porDiaUsd: 20 }, membros: [{ id: 'redator', papel: 'Redator' }] });
  assert.equal(sv.status, 200, JSON.stringify(sv.corpo));
  assert.equal(sv.corpo.escritorio.nome, 'Marketing 2');
  assert.deepEqual(sv.corpo.escritorio.orcamento, { porExecucaoUsd: 2, porDiaUsd: 20, avisoPct: 80 });
  assert.equal(sv.corpo.escritorio.membros.length, 1);
  assert.equal(sv.corpo.escritorio.funcao, 'Cuida do marketing');
  assert.equal(sv.corpo.escritorio.criado, e1.criado);
  assert.notEqual(sv.corpo.escritorio.atualizado, e1.atualizado);
  assert.equal(sv.corpo.escritorio.id, e1.id, 'o id não muda');
  assert.equal((await a.chamar('POST', `/escritorios/${e1.id}`, { nome: '' })).status, 400);
  assert.equal(JSON.parse(fs.readFileSync(arq, 'utf8')).nome, 'Marketing 2', 'salvar inválido não grava');
  assert.equal((await a.chamar('POST', '/escritorios/naoexiste', { nome: 'x' })).status, 404);

  // duplicar
  const dup = await a.chamar('POST', `/escritorios/${e1.id}/duplicar`, {});
  assert.equal(dup.status, 200);
  const e2 = dup.corpo.escritorio;
  assert.notEqual(e2.id, e1.id);
  assert.equal(e2.nome, 'Marketing 2 (cópia)');
  assert.deepEqual(e2.membros, sv.corpo.escritorio.membros);
  assert.ok(fs.existsSync(path.join(a.deps.pasta, `${e2.id}.json`)));
  const dup2 = await a.chamar('POST', `/escritorios/${e1.id}/duplicar`, {});
  assert.equal(dup2.corpo.escritorio.nome, 'Marketing 2 (cópia) 2');
  assert.equal((await a.chamar('GET', '/escritorios')).corpo.escritorios.length, 3);

  // excluir
  const ex = await a.chamar('POST', `/escritorios/${e2.id}/excluir`, {});
  assert.equal(ex.status, 200);
  assert.ok(!fs.existsSync(path.join(a.deps.pasta, `${e2.id}.json`)));
  assert.equal((await a.chamar('GET', `/escritorios/${e2.id}`)).status, 404);
  assert.equal((await a.chamar('POST', `/escritorios/${e2.id}/excluir`, {})).status, 404);
  assert.ok(a.eventos.some(([t, d]) => t === 'escritorio' && d.id === e2.id && d.resumo === null));
  assert.equal((await a.chamar('GET', '/escritorios')).corpo.escritorios.length, 2);
});

test('excluir dá 409 com o escritório rodando', async () => {
  const a = ambiente();
  const e = await a.criar();
  await a.acionar(e.id);
  const r = await a.chamar('POST', `/escritorios/${e.id}/excluir`, {});
  assert.equal(r.status, 409);
  assert.ok(fs.existsSync(path.join(a.deps.pasta, `${e.id}.json`)));
  // pausado pode excluir (e as sessões são encerradas)
  await a.chamar('POST', `/escritorios/${e.id}/pausar`, {});
  assert.equal((await a.chamar('POST', `/escritorios/${e.id}/excluir`, {})).status, 200);
  assert.ok(a.ctl.de('encerrar').some((x) => x[1] === 'sess-1'));
});

// ───────────────────────── acionar ─────────────────────────

test('acionar cria o orquestrador com escritório, anexo, configuração e env', async () => {
  const a = ambiente();
  const e = await a.criar({ externas: { extras: ['meu-deploy'] }, orquestrador: { nome: 'Chefe', modelo: 'sonnet', esforco: 'medium' } });
  const exec = await a.acionar(e.id, '  Faça a campanha de outubro  ');
  assert.equal(exec.status, 'rodando');
  assert.equal(exec.origem, 'manual');
  assert.equal(exec.tarefa, 'Faça a campanha de outubro');
  assert.equal(exec.orquestrador, 'sess-1');
  assert.deepEqual(exec.membros, {});
  assert.match(exec.execucao, /^[0-9a-f-]{36}$/);
  assert.equal(exec.custo.execucaoUsd, 0);
  assert.equal(exec.custo.dia, '2026-10-21');
  assert.equal(exec.custo.planoPctInicio, 10);

  const [[, b]] = a.ctl.de('criarInstancia');
  assert.equal(b.pasta, a.projeto);
  assert.equal(b.texto, 'Faça a campanha de outubro');
  assert.equal(b.modelo, 'sonnet');
  assert.equal(b.esforco, 'medium');
  assert.equal(b.nome, 'Marketing · Chefe');
  assert.equal(b.pai, undefined, 'o orquestrador não tem sessão-mãe');
  assert.deepEqual(b.escritorio, { id: e.id, execucao: exec.execucao, papel: 'orquestrador', papelNome: 'Chefe' });
  assert.equal(b.anexoSistema, anexoOrquestrador(e, { raizOrbit: RAIZ }));
  assert.ok(b.anexoSistema.length <= 20000);
  assert.deepEqual(b.configuracao, configuracaoHook(RAIZ, e.pasta));
  assert.deepEqual(b.ambiente, {
    ORBIT_ESCRITORIO: e.id, ORBIT_EXECUCAO: exec.execucao, ORBIT_PAPEL: 'orquestrador', ORBIT_PORTA: '47822',
    ORBIT_EXTERNAS: JSON.stringify(['meu-deploy']),
  });
  assert.equal(b.permissao, undefined, 'o controle força o modo default');

  const lista = (await a.chamar('GET', '/escritorios')).corpo.escritorios[0];
  assert.equal(lista.status, 'rodando');
  assert.equal(lista.ativos, 1);
  const det = (await a.chamar('GET', `/escritorios/${e.id}`)).corpo;
  assert.equal(det.execucao.execucao, exec.execucao);
  assert.ok(a.eventos.filter(([t, d]) => t === 'escritorio' && d.resumo?.status === 'rodando').length >= 1);
});

test('acionar: erros de entrada, já rodando e origem', async () => {
  const a = ambiente();
  const e = await a.criar();
  assert.equal((await a.chamar('POST', `/escritorios/${e.id}/acionar`, {})).status, 400);
  assert.equal((await a.chamar('POST', `/escritorios/${e.id}/acionar`, { tarefa: '   ' })).status, 400);
  assert.equal((await a.chamar('POST', `/escritorios/${e.id}/acionar`, { tarefa: 'x'.repeat(4001) })).status, 400);
  assert.equal((await a.chamar('POST', `/escritorios/${e.id}/acionar`, { tarefa: 'x', origem: 'outra' })).status, 400);
  assert.equal((await a.chamar('POST', '/escritorios/naoexiste/acionar', { tarefa: 'x' })).status, 404);
  assert.equal(a.ctl.de('criarInstancia').length, 0);
  const auto = await a.chamar('POST', `/escritorios/${e.id}/acionar`, { tarefa: 'rotina', origem: 'automacao' });
  assert.equal(auto.status, 202);
  assert.equal(auto.corpo.execucao.origem, 'automacao');
  const dois = await a.chamar('POST', `/escritorios/${e.id}/acionar`, { tarefa: 'de novo' });
  assert.equal(dois.status, 409);
  assert.equal(a.ctl.de('criarInstancia').length, 1);
});

test('teto próprio cheio devolve 429 e não deixa execução pendurada', async () => {
  const a = ambiente();
  const e = await a.criar();
  a.ctl.teto = 0;
  const r = await a.chamar('POST', `/escritorios/${e.id}/acionar`, { tarefa: 'x' });
  assert.equal(r.status, 429);
  assert.match(r.corpo.erro, /Teto/);
  const det = (await a.chamar('GET', `/escritorios/${e.id}`)).corpo;
  assert.equal(det.execucao.status, 'ociosa');
  a.ctl.teto = 99;
  assert.equal((await a.chamar('POST', `/escritorios/${e.id}/acionar`, { tarefa: 'x' })).status, 202, 'depois do teto liberar, aciona');

  // 429 também ao criar um membro
  const orq = 'sess-1';
  a.ctl.teto = a.ctl.sessoes.size;
  const m = await a.enviar(e.id, 'redator', orq);
  assert.equal(m.status, 429);
  const det2 = (await a.chamar('GET', `/escritorios/${e.id}`)).corpo;
  assert.deepEqual(det2.execucao.membros, {});
  assert.equal(det2.execucao.status, 'rodando');
  assert.equal(det2.execucao.estados.redator, undefined);
});

// ───────────────────────── enviar a membro ─────────────────────────

test('só o orquestrador da execução atual envia; o membro nasce uma vez por execução', async () => {
  const a = ambiente();
  const e = await a.criar();

  // sem execução: 403
  assert.equal((await a.enviar(e.id, 'redator', 'sess-qualquer')).status, 403);
  const exec = await a.acionar(e.id);
  const orq = exec.orquestrador;

  assert.equal((await a.chamar('POST', `/escritorios/${e.id}/membro/redator/enviar`, { tarefa: 'x' })).status, 403, 'sem cabeçalho de sessão');
  assert.equal((await a.enviar(e.id, 'redator', 'outra-sessao')).status, 403);
  assert.equal((await a.enviar(e.id, 'redator', 'sess-1x')).status, 403);
  assert.equal((await a.enviar(e.id, 'naoexiste', orq)).status, 404);
  assert.equal((await a.chamar('POST', `/escritorios/${e.id}/membro/redator/enviar`, { tarefa: ' ' }, { 'x-orbit-sessao': orq })).status, 400);
  assert.equal(a.ctl.de('criarInstancia').length, 1, 'nada criado nas tentativas inválidas');

  const r1 = await a.enviar(e.id, 'redator', orq, 'Escreva o título');
  assert.equal(r1.status, 200, JSON.stringify(r1.corpo));
  assert.equal(r1.corpo.sessao, 'sess-2');
  const [, b] = a.ctl.de('criarInstancia')[1];
  assert.equal(b.texto, 'Escreva o título');
  assert.equal(b.pai, orq);
  assert.equal(b.nome, 'Marketing · Rê');
  assert.deepEqual(b.escritorio, { id: e.id, execucao: exec.execucao, papel: 'redator', papelNome: 'Rê' });
  assert.equal(b.anexoSistema, anexoMembro(e, e.membros[0]));
  assert.deepEqual(b.configuracao, configuracaoHook(RAIZ, e.pasta));
  assert.equal(b.ambiente.ORBIT_PAPEL, 'redator');
  assert.equal(b.ambiente.ORBIT_EXECUCAO, exec.execucao);
  assert.equal(b.ambiente.ORBIT_ESCRITORIO, e.id);

  // 2ª tarefa ao mesmo membro: reaproveita a sessão
  const r2 = await a.enviar(e.id, 'redator', orq, 'Agora o corpo');
  assert.equal(r2.corpo.sessao, 'sess-2');
  assert.equal(a.ctl.de('criarInstancia').length, 2);
  assert.deepEqual(a.ctl.de('enviarMensagem'), [['enviarMensagem', 'sess-2', 'Agora o corpo']]);

  // outro membro: sessão própria
  const r3 = await a.enviar(e.id, 'revisor', orq);
  assert.equal(r3.corpo.sessao, 'sess-3');

  // o membro não pode enviar a ninguém (nem a si)
  assert.equal((await a.enviar(e.id, 'revisor', 'sess-2')).status, 403);

  // estado do membro
  const st = (await a.chamar('GET', `/escritorios/${e.id}/membro/redator/estado`)).corpo;
  assert.equal(st.status, 'trabalhando');
  assert.equal(st.sessao, 'sess-2');
  assert.equal(st.resumo, '');
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}/membro/naoexiste/estado`)).status, 404);
  const det = (await a.chamar('GET', `/escritorios/${e.id}`)).corpo;
  assert.deepEqual(det.execucao.membros, { redator: 'sess-2', revisor: 'sess-3' });
  assert.equal((await a.chamar('GET', '/escritorios')).corpo.escritorios[0].ativos, 3);

  // membro ainda não iniciado
  const e2 = await a.criar({ nome: 'Outro' });
  assert.equal((await a.chamar('GET', `/escritorios/${e2.id}/membro/redator/estado`)).corpo.status, 'inexistente');

  // membro aguardando aprovação
  a.ctl.sessoes.get('sess-2').dados = { status: 'aguardando' };
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}/membro/redator/estado`)).corpo.status, 'aguardando');
});

test('o membro é recriado se a sessão dele morreu', async () => {
  const a = ambiente();
  const e = await a.criar();
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  a.ctl.sessoes.get('sess-2').viva = false;
  const r = await a.enviar(e.id, 'redator', exec.orquestrador, 'de novo');
  assert.equal(r.corpo.sessao, 'sess-3');
  assert.equal(a.ctl.de('criarInstancia').length, 3);
});

// ───────────────────────── fim do membro / da execução ─────────────────────────

test('fim do membro avisa o líder e guarda o resumo', async () => {
  const a = ambiente();
  const e = await a.criar();
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  const longo = 'resultado '.repeat(100);
  a.ctl.resultado('sess-2', { custoUsd: 0.1, texto: longo });
  await a.esc.aguardar();
  const av = a.ctl.de('avisarLider');
  assert.equal(av.length, 1);
  assert.equal(av[0][1], exec.orquestrador);
  assert.match(av[0][2], /^Membro redator concluiu: resultado/);
  assert.ok(av[0][2].length <= 'Membro redator concluiu: '.length + 300);
  const st = (await a.chamar('GET', `/escritorios/${e.id}/membro/redator/estado`)).corpo;
  assert.equal(st.status, 'concluida');
  assert.ok(st.resumo.length > 0 && st.resumo.length <= 300);

  // erro do membro
  await a.enviar(e.id, 'revisor', exec.orquestrador);
  a.ctl.resultado('sess-3', { texto: 'quebrou', erro: true });
  await a.esc.aguardar();
  assert.match(a.ctl.de('avisarLider')[1][2], /^Membro revisor falhou: quebrou/);
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}/membro/revisor/estado`)).corpo.status, 'erro');

  // evento de sessão desconhecida é ignorado
  a.ctl.resultado('sess-999', { custoUsd: 5, texto: 'x' });
  await a.esc.aguardar();
  assert.equal(a.ctl.de('avisarLider').length, 2);
});

test('fim da execução: orquestrador conclui, nenhum membro ativo → membros encerrados', async () => {
  const a = ambiente();
  const e = await a.criar();
  const exec = await a.acionar(e.id);
  const orq = exec.orquestrador;
  await a.enviar(e.id, 'redator', orq);
  await a.enviar(e.id, 'revisor', orq);

  // o orquestrador acaba a volta com os dois trabalhando: segue rodando
  a.ctl.resultado(orq, { custoUsd: 0.05, texto: 'esperando' });
  await a.esc.aguardar();
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}`)).corpo.execucao.status, 'rodando');

  // um membro termina; o outro ainda trabalha
  a.ctl.resultado('sess-3', { texto: 'revisado' });
  await a.esc.aguardar();
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}`)).corpo.execucao.status, 'rodando');
  assert.equal(a.ctl.de('encerrar').length, 0);

  // o último termina → avisa o líder (que acorda): ainda rodando
  a.ctl.resultado('sess-2', { texto: 'escrito' });
  await a.esc.aguardar();
  assert.equal(a.ctl.de('avisarLider').length, 2);
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}`)).corpo.execucao.status, 'rodando', 'o líder foi acordado pelo aviso');

  // o líder fecha a volta: execução concluída, membros encerrados, orquestrador fica
  a.ctl.resultado(orq, { custoUsd: 0.1, texto: 'pronto' });
  await a.esc.aguardar();
  const det = (await a.chamar('GET', `/escritorios/${e.id}`)).corpo;
  assert.equal(det.execucao.status, 'concluida');
  assert.ok(det.execucao.fim);
  assert.deepEqual(a.ctl.de('encerrar').map((x) => x[1]).sort(), ['sess-2', 'sess-3']);
  assert.equal(a.ctl.sessoes.get(orq).viva, true);
  assert.equal((await a.chamar('GET', '/escritorios')).corpo.escritorios[0].status, 'concluida');

  // nova execução: sessão nova, e a anterior (orquestrador) é encerrada
  const exec2 = await a.acionar(e.id, 'segunda');
  assert.notEqual(exec2.execucao, exec.execucao);
  assert.equal(exec2.orquestrador, 'sess-4');
  assert.equal(a.ctl.sessoes.get(orq).viva, false);
  // e os membros nascem de novo
  const novo = await a.enviar(e.id, 'redator', exec2.orquestrador);
  assert.equal(novo.corpo.sessao, 'sess-5');
});

test('fim da execução: orquestrador com erro → status erro; sem membros, termina na hora', async () => {
  const a = ambiente();
  const e = await a.criar({ membros: [] });
  const exec = await a.acionar(e.id);
  a.ctl.resultado(exec.orquestrador, { erro: true, texto: 'falhou' });
  await a.esc.aguardar();
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}`)).corpo.execucao.status, 'erro');
  const exec2 = await a.acionar(e.id);
  a.ctl.resultado(exec2.orquestrador, { texto: 'ok' });
  await a.esc.aguardar();
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}`)).corpo.execucao.status, 'concluida');
});

test('fim da execução espera o controle se o orquestrador ainda está ocupado (mensagem na fila)', async () => {
  const a = ambiente();
  const e = await a.criar({ membros: [] });
  const exec = await a.acionar(e.id);
  a.ctl.ocupadas.add(exec.orquestrador);
  a.ctl.resultado(exec.orquestrador, { texto: 'volta 1' });
  await a.esc.aguardar();
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}`)).corpo.execucao.status, 'rodando');
  a.ctl.ocupadas.delete(exec.orquestrador);
  a.ctl.resultado(exec.orquestrador, { texto: 'volta 2' });
  await a.esc.aguardar();
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}`)).corpo.execucao.status, 'concluida');
});

test('fim da execução com atraso: o timer confere de novo antes de encerrar', async () => {
  const a = ambiente({ atrasoFim: 250 });
  const e = await a.criar({ membros: [] });
  const exec = await a.acionar(e.id);
  a.ctl.resultado(exec.orquestrador, { texto: 'volta' });
  await a.esc.aguardar();
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}`)).corpo.execucao.status, 'rodando', 'ainda no atraso');
  await new Promise((r) => setTimeout(r, 500));
  await a.esc.aguardar();
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}`)).corpo.execucao.status, 'concluida');
  a.esc.parar();
});

test('o orquestrador pode reabrir a execução concluída ao enviar tarefa a um membro', async () => {
  const a = ambiente();
  const e = await a.criar();
  const exec = await a.acionar(e.id);
  a.ctl.resultado(exec.orquestrador, { texto: 'pronto' });
  await a.esc.aguardar();
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}`)).corpo.execucao.status, 'concluida');
  // P2-3: sem o orquestrador ocupado (volta terminada) a execução concluída não reabre
  const fechado = await a.enviar(e.id, 'redator', exec.orquestrador);
  assert.equal(fechado.status, 409, JSON.stringify(fechado.corpo));
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}`)).corpo.execucao.status, 'concluida');
  assert.equal(a.ctl.de('criarInstancia').length, 1, 'nenhum membro criado na tentativa recusada');
  // o orquestrador voltou a trabalhar (ocupado): reabre
  a.ctl.ocupadas.add(exec.orquestrador);
  const r = await a.enviar(e.id, 'redator', exec.orquestrador);
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}`)).corpo.execucao.status, 'rodando');
});

// ───────────────────────── convidados ─────────────────────────

test('rota de convidados: limite, ativos (subagentes trabalhando/aguardando) e permitido', async () => {
  const a = ambiente();
  const e = await a.criar({ convidados: { limite: 2 } });
  assert.equal((await a.chamar('GET', '/escritorios/convidados?sessao=sess-9')).status, 404, 'sessão fora de escritório');
  assert.equal((await a.chamar('GET', '/escritorios/convidados')).status, 400);
  const exec = await a.acionar(e.id);
  const orq = exec.orquestrador;
  const url = (s) => `/escritorios/convidados?sessao=${s}`;

  let r = await a.chamar('GET', url(orq));
  assert.equal(r.status, 200);
  assert.deepEqual(r.corpo, { escritorio: e.id, limite: 2, ativos: 0, permitido: true });

  const ags = (...st) => st.map((status, i) => ({ id: `ag${i}`, status }));
  a.ctl.sessoes.get(orq).dados = { agentes: ags('trabalhando', 'concluido', 'aguardando', 'erro') };
  r = await a.chamar('GET', url(orq));
  assert.deepEqual(r.corpo, { escritorio: e.id, limite: 2, ativos: 2, permitido: false });
  a.ctl.sessoes.get(orq).dados = { agentes: ags('trabalhando', 'concluido') };
  assert.equal((await a.chamar('GET', url(orq))).corpo.permitido, true);

  // membro nunca é convidante
  await a.enviar(e.id, 'redator', orq);
  assert.equal((await a.chamar('GET', url('sess-2'))).corpo.permitido, false);

  // limite 0
  await a.chamar('POST', `/escritorios/${e.id}`, { convidados: { limite: 0 } });
  assert.deepEqual((await a.chamar('GET', url(orq))).corpo, { escritorio: e.id, limite: 0, ativos: 1, permitido: false });

  // pausado: não permite
  await a.chamar('POST', `/escritorios/${e.id}`, { convidados: { limite: 5 } });
  a.ctl.sessoes.get(orq).dados = { agentes: [] };
  assert.equal((await a.chamar('GET', url(orq))).corpo.permitido, true);
  await a.chamar('POST', `/escritorios/${e.id}/pausar`, {});
  assert.equal((await a.chamar('GET', url(orq))).corpo.permitido, false);
});

// ───────────────────────── pausar / liberar ─────────────────────────

test('pausar interrompe tudo; liberar retoma e avisa o líder', async () => {
  const a = ambiente();
  const e = await a.criar();
  assert.equal((await a.chamar('POST', `/escritorios/${e.id}/pausar`, {})).status, 409, 'nada rodando');
  assert.equal((await a.chamar('POST', `/escritorios/${e.id}/liberar`, {})).status, 409, 'nada pausado');
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  const p = await a.chamar('POST', `/escritorios/${e.id}/pausar`, {});
  assert.equal(p.status, 200);
  assert.equal(p.corpo.execucao.status, 'pausada');
  assert.equal(p.corpo.execucao.motivoPausa, 'manual');
  assert.deepEqual(a.ctl.de('interromper').map((x) => x[1]).sort(), ['sess-1', 'sess-2']);
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}/membro/redator/estado`)).corpo.status, 'interrompida');
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}/membro/redator/estado`)).corpo.escritorio, 'pausada');
  // não dá para acionar nem enviar pausado
  assert.equal((await a.chamar('POST', `/escritorios/${e.id}/acionar`, { tarefa: 'x' })).status, 409);
  const env = await a.enviar(e.id, 'revisor', exec.orquestrador);
  assert.equal(env.status, 409);
  assert.equal(env.corpo.pausado, true);
  // resultados das sessões interrompidas não acordam o líder nem concluem
  a.ctl.resultado('sess-2', { erro: true, texto: 'interrompido' });
  await a.esc.aguardar();
  assert.equal(a.ctl.de('avisarLider').length, 0);
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}`)).corpo.execucao.status, 'pausada');

  const l = await a.chamar('POST', `/escritorios/${e.id}/liberar`, {});
  assert.equal(l.status, 200);
  assert.equal(l.corpo.execucao.status, 'rodando');
  assert.equal(l.corpo.execucao.motivoPausa, undefined);
  assert.match(a.ctl.de('avisarLider')[0][2], /liberado/i);
  // depois de liberar o líder pode mandar para o membro de novo
  assert.equal((await a.enviar(e.id, 'redator', exec.orquestrador)).status, 200);
});

// ───────────────────────── orçamento ─────────────────────────

test('orçamento: custo por diferença, aviso em 80% e pausa em 100% da execução', async () => {
  const a = ambiente();
  const e = await a.criar({ orcamento: { porExecucaoUsd: 1, porDiaUsd: 100, avisoPct: 80 } });
  const exec = await a.acionar(e.id);
  const orq = exec.orquestrador;
  await a.enviar(e.id, 'redator', orq);
  await a.enviar(e.id, 'revisor', orq); // segue trabalhando: a execução não conclui sozinha

  // o custo é acumulado na sessão: 0.3, depois 0.5 (+0.2), membro 0.1 → 0.6 no total
  a.ctl.resultado(orq, { custoUsd: 0.3 });
  a.ctl.resultado(orq, { custoUsd: 0.5 });
  await a.esc.aguardar();
  let det = (await a.chamar('GET', `/escritorios/${e.id}`)).corpo;
  assert.equal(det.execucao.custo.execucaoUsd, 0.5);
  assert.equal(det.execucao.custo.diaUsd, 0.5);
  a.ctl.resultado('sess-2', { custoUsd: 0.1, texto: 'a' });
  await a.esc.aguardar();
  det = (await a.chamar('GET', `/escritorios/${e.id}`)).corpo;
  assert.equal(det.execucao.custo.execucaoUsd, 0.6);
  assert.equal(a.alertasSse().length, 0);

  // plano: o % de agora menos o do início
  a.setPlano(14);
  a.ctl.resultado(orq, { custoUsd: 0.5 }); // sem diferença
  await a.esc.aguardar();

  // cruza 80%: alerta + aviso ao líder, uma vez
  a.ctl.resultado(orq, { custoUsd: 0.75 });
  await a.esc.aguardar();
  assert.equal(a.alertasSse().length, 1);
  assert.equal(a.alertasSse()[0].id, e.id);
  assert.equal(a.alertasSse()[0].tipo, 'aviso');
  assert.equal(a.alertasSse()[0].aviso, 'execucao');
  assert.equal(a.alertasSse()[0].pct, 85);
  assert.equal(a.celular.length, 0, 'aviso de 80% não vai ao celular');
  assert.equal(a.alertas.length, 0, 'o canal antigo alertar não é mais usado');
  const avs = a.ctl.de('avisarLider').filter((x) => /Orçamento em/.test(x[2]));
  assert.equal(avs.length, 1);
  assert.equal(avs[0][1], orq);
  assert.equal(avs[0][2], 'Orçamento em 85%: feche e entregue o que já tem.');
  a.ctl.resultado(orq, { custoUsd: 0.8 });
  await a.esc.aguardar();
  assert.equal(a.alertasSse().length, 1, 'sem aviso repetido');
  det = (await a.chamar('GET', `/escritorios/${e.id}`)).corpo;
  assert.equal(det.execucao.status, 'rodando');
  assert.equal(det.execucao.custo.planoPctAgora, 14);
  const lista = (await a.chamar('GET', '/escritorios')).corpo.escritorios[0];
  assert.equal(lista.custo.execucaoUsd, 0.9);
  assert.equal(lista.custo.limiteExecucaoUsd, 1);
  assert.equal(lista.custo.planoPct, 4);

  // chega em 100%: interrompe todos, pausa, alerta urgente
  a.ctl.resultado(orq, { custoUsd: 0.9 });
  await a.esc.aguardar();
  det = (await a.chamar('GET', `/escritorios/${e.id}`)).corpo;
  assert.equal(det.execucao.status, 'pausada');
  assert.equal(det.execucao.motivoPausa, 'orcamento-execucao');
  assert.deepEqual(a.ctl.de('interromper').map((x) => x[1]).sort(), ['sess-1', 'sess-2', 'sess-3']);
  const urg = a.alertasSse().filter((x) => x.tipo === 'pausa');
  assert.equal(urg.length, 1);
  assert.match(urg[0].texto, /orçamento da execução acabou/);
  assert.equal(a.celular.length, 1);
  assert.deepEqual(a.celular[0].slice(0, 2), [e.id, 'Marketing']);
  assert.equal(a.celular[0][2], urg[0].texto);
  assert.deepEqual(a.ctl.de('encerrar').map((x) => x[1]).sort(), ['sess-2', 'sess-3'], 'pausa de orçamento encerra os membros');
  assert.equal(a.ctl.sessoes.get(orq).viva, true, 'o orquestrador fica');
  assert.equal((await a.chamar('GET', '/escritorios')).corpo.escritorios[0].status, 'pausada');
  assert.equal((await a.enviar(e.id, 'revisor', orq)).status, 409);

  // liberar: a pausa de orçamento da execução cai e a conta da execução recomeça
  const l = await a.chamar('POST', `/escritorios/${e.id}/liberar`, {});
  assert.equal(l.status, 200);
  assert.equal(l.corpo.execucao.status, 'rodando');
  assert.equal(l.corpo.execucao.custo.execucaoUsd, 0);
  assert.equal(l.corpo.execucao.custo.execucaoTotalUsd, 1);
  assert.equal(l.corpo.execucao.custo.diaUsd, 1, 'o dia continua contando');
});

test('orçamento do dia: pausa em 100% do dia, 409 ao acionar, e o dia vira à meia-noite local', async () => {
  const a = ambiente({ prazoMin: 0 }); // o relógio salta 14 h: sem prazo máximo, para isolar o orçamento
  const e = await a.criar({ orcamento: { porExecucaoUsd: 5, porDiaUsd: 1.5, avisoPct: 80 } });
  const exec = await a.acionar(e.id);
  const orq = exec.orquestrador;
  a.relogio.agora = new Date(2026, 9, 21, 23, 50);

  a.ctl.resultado(orq, { custoUsd: 1.3 }); // 86% do dia, 26% da execução
  await a.esc.aguardar();
  assert.equal(a.alertasSse().length, 1);
  assert.equal(a.alertasSse()[0].tipo, 'aviso');
  assert.equal(a.alertasSse()[0].aviso, 'dia');
  assert.equal(a.alertasSse()[0].pct, 86);

  a.ctl.resultado(orq, { custoUsd: 1.6 });
  await a.esc.aguardar();
  let det = (await a.chamar('GET', `/escritorios/${e.id}`)).corpo;
  assert.equal(det.execucao.status, 'pausada');
  assert.equal(det.execucao.motivoPausa, 'orcamento-dia');
  assert.equal(a.alertasSse().filter((x) => x.tipo === 'pausa').length, 1);
  assert.equal(a.celular.length, 1);
  assert.match(a.celular[0][2], /orçamento do dia/);
  assert.deepEqual(a.ctl.de('interromper').map((x) => x[1]), ['sess-1']);

  // o gasto do dia foi para o disco
  const estadoArq = path.join(a.deps.pasta, `${e.id}.estado.json`);
  const gravado = JSON.parse(fs.readFileSync(estadoArq, 'utf8'));
  assert.equal(gravado.dia, '2026-10-21');
  assert.equal(gravado.diaUsd, 1.6);
  // a lista de escritórios não confunde o arquivo de estado com um escritório
  assert.equal((await a.chamar('GET', '/escritorios')).corpo.escritorios.length, 1);

  // no mesmo dia: não aciona nem libera
  assert.equal((await a.chamar('POST', `/escritorios/${e.id}/acionar`, { tarefa: 'x' })).status, 409);
  assert.equal((await a.chamar('POST', `/escritorios/${e.id}/liberar`, {})).status, 409);

  // outro processo do Orbit lê o gasto do dia do disco
  const b = ambiente({ pasta: a.deps.pasta });
  assert.equal((await b.chamar('POST', `/escritorios/${e.id}/acionar`, { tarefa: 'x' })).status, 409, 'o estado persistiu');
  b.esc.parar();

  // vira o dia: zera o gasto do dia (a lista já mostra 0) e libera o acionamento
  a.relogio.agora = new Date(2026, 9, 22, 0, 1);
  const lista = (await a.chamar('GET', '/escritorios')).corpo.escritorios[0];
  assert.equal(lista.custo.diaUsd, 0);
  const nova = await a.chamar('POST', `/escritorios/${e.id}/acionar`, { tarefa: 'dia novo' });
  assert.equal(nova.status, 202, JSON.stringify(nova.corpo));
  assert.equal(nova.corpo.execucao.custo.dia, '2026-10-22');
  assert.equal(nova.corpo.execucao.custo.diaUsd, 0);
  assert.equal(nova.corpo.execucao.custo.execucaoUsd, 0);
  assert.equal(a.ctl.de('criarInstancia').length, 2);
  assert.equal(a.ctl.sessoes.get(orq).viva, false, 'o orquestrador pausado do dia velho foi encerrado');
  // o resultado tardio da sessão velha não mexe na execução nova
  a.ctl.resultado(orq, { custoUsd: 1.7 });
  await a.esc.aguardar();
  det = (await a.chamar('GET', `/escritorios/${e.id}`)).corpo;
  assert.equal(det.execucao.execucao, nova.corpo.execucao.execucao);
  assert.equal(det.execucao.status, 'rodando');
  assert.equal(JSON.parse(fs.readFileSync(estadoArq, 'utf8')).dia, '2026-10-22');
});

test('liberar após orçamento do dia só vale quando o dia virar', async () => {
  const a = ambiente();
  const e = await a.criar({ orcamento: { porExecucaoUsd: 5, porDiaUsd: 1 } });
  const exec = await a.acionar(e.id);
  a.ctl.resultado(exec.orquestrador, { custoUsd: 1.2 });
  await a.esc.aguardar();
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}`)).corpo.execucao.motivoPausa, 'orcamento-dia');
  assert.equal((await a.chamar('POST', `/escritorios/${e.id}/liberar`, {})).status, 409);
  a.relogio.agora = new Date(2026, 9, 22, 8, 0);
  const l = await a.chamar('POST', `/escritorios/${e.id}/liberar`, {});
  assert.equal(l.status, 200, JSON.stringify(l.corpo));
  assert.equal(l.corpo.execucao.status, 'rodando');
  assert.equal(l.corpo.execucao.custo.diaUsd, 0);
  assert.equal(l.corpo.execucao.custo.execucaoUsd, 1.2, 'o custo da execução continua; só o dia virou');
});

test('custo por diferença entre sessões da mesma execução', async () => {
  const a = ambiente();
  const e = await a.criar({ orcamento: { porExecucaoUsd: 10, porDiaUsd: 100 } });
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  await a.enviar(e.id, 'revisor', exec.orquestrador);
  for (const [s, c] of [[exec.orquestrador, 0.1], ['sess-2', 0.2], ['sess-3', 0.3], [exec.orquestrador, 0.4], ['sess-2', 0.2], ['sess-3', 0.35]]) {
    a.ctl.resultado(s, { custoUsd: c });
  }
  await a.esc.aguardar();
  const det = (await a.chamar('GET', `/escritorios/${e.id}`)).corpo;
  assert.equal(det.execucao.custo.execucaoUsd, 0.95); // 0.4 + 0.2 + 0.35
});

// ───────────────────────── textos e configuração ─────────────────────────

test('anexo do orquestrador traz função, membros, comandos, convidados, regras e orçamento', () => {
  const esc = {
    id: 'abc', nome: 'Marketing', funcao: 'Cuida do marketing', pasta: 'D:\\Projetos\\Marca',
    orquestrador: { nome: 'Chefe', prompt: 'Lidere com calma.' },
    membros: [{ id: 'redator', papel: 'Redator', nome: 'Rê' }, { id: 'revisor', papel: 'Revisor', nome: 'Rev' }],
    convidados: { limite: 3 }, orcamento: { porExecucaoUsd: 2, porDiaUsd: 10, avisoPct: 80 },
  };
  const t = anexoOrquestrador(esc, { raizOrbit: 'D:\\Dev\\Projetos\\Orbit' });
  assert.match(t, /Chefe/);
  assert.match(t, /Cuida do marketing/);
  assert.match(t, /Lidere com calma\./);
  assert.match(t, /`redator`.*Redator.*Rê/);
  assert.match(t, /`revisor`/);
  for (const cmd of ['enviar', 'esperar', 'estado', 'lista']) assert.ok(t.includes(`membro.mjs" ${cmd}`), cmd);
  assert.ok(t.includes('node "D:/Dev/Projetos/Orbit/membro.mjs"'));
  assert.match(t, /Agent/);
  assert.match(t, /no máximo 3/);
  assert.match(t, /Uma entrega por membro/);
  assert.match(t, /140 mil tokens/);
  assert.ok(t.includes('D:/Projetos/Marca/_progresso/<membro>.md'));
  assert.match(t, /no máximo 5 linhas/);
  assert.match(t, /ação externa[\s\S]*aprovação do usuário/i);
  assert.match(t, /Limite por execução: US\$ 2\.00/);
  assert.match(t, /limite por dia: US\$ 10\.00/);
  assert.match(t, /80%/);
  assert.ok(t.length <= 20000);

  assert.match(anexoOrquestrador({ ...esc, convidados: { limite: 0 } }), /limite de convidados deste escritório é 0/);
  assert.match(anexoOrquestrador({ ...esc, membros: [] }), /nenhum membro/);
  // nunca passa de 20000, mesmo com prompt enorme
  assert.ok(anexoOrquestrador({ ...esc, orquestrador: { nome: 'x', prompt: 'p'.repeat(30000) } }).length <= 20000);
});

test('anexo do membro traz o prompt, memória em notas/, progresso, retorno curto e regras', () => {
  const esc = { id: 'abc', nome: 'Marketing', funcao: 'Cuida do marketing', pasta: 'D:\\Projetos\\Marca', orquestrador: { nome: 'Chefe' } };
  const m = { id: 'redator', papel: 'Redator', nome: 'Rê', prompt: 'Escreva textos curtos.' };
  const t = anexoMembro(esc, m);
  assert.match(t, /Escreva textos curtos\./);
  assert.match(t, /Rê/);
  assert.ok(t.includes('D:/Projetos/Marca/notas/redator.md'));
  assert.match(t, /INÍCIO[\s\S]*FIM/);
  assert.ok(t.includes('D:/Projetos/Marca/_progresso/redator.md'));
  assert.match(t, /no máximo 5 linhas/);
  assert.match(t, /Chefe/);
  assert.match(t, /aprovação do usuário/);
  assert.match(t, /não crie subagentes/i);
  assert.match(t, /140 mil tokens/);
  assert.ok(t.length <= 20000);
});

test('configuração de hooks e ambiente ORBIT_*', () => {
  const cfg = configuracaoHook('D:\\Dev\\Projetos\\Orbit', 'D:\\Projetos\\Marca');
  const exe = process.execPath.replace(/\\/g, '/');
  assert.deepEqual(cfg, {
    disableAllHooks: false, // o --settings vale mais que o settings.local da pasta: o membro não desliga a trava
    hooks: { PreToolUse: [{ matcher: MATCHER_HOOK, hooks: [{ type: 'command', command: `"${exe}" "D:/Dev/Projetos/Orbit/escritorio-hook.mjs"` }] }] },
    permissions: {
      allow: [
        'Bash(node "D:/Dev/Projetos/Orbit/membro.mjs":*)',
        'Write(//d/Projetos/Marca/notas/**)', 'Edit(//d/Projetos/Marca/notas/**)',
        'Write(//d/Projetos/Marca/_progresso/**)', 'Edit(//d/Projetos/Marca/_progresso/**)',
      ],
    },
  });
  // matcher cobre as ferramentas que escrevem/executam (P1-2)
  for (const f of ['Bash', 'PowerShell', 'Monitor', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'mcp__.*']) assert.ok(MATCHER_HOOK.split('|').includes(f), f);
  // sem pasta: só a regra do membro.mjs (nada de escrita liberada)
  assert.deepEqual(configuracaoHook('D:\\Dev\\Projetos\\Orbit').permissions.allow, ['Bash(node "D:/Dev/Projetos/Orbit/membro.mjs":*)']);
  assert.deepEqual(ambienteDe({ id: 'e1', externas: { extras: ['a', 'b'] } }, 'ex1', 'orquestrador', 47821), {
    ORBIT_ESCRITORIO: 'e1', ORBIT_EXECUCAO: 'ex1', ORBIT_PAPEL: 'orquestrador', ORBIT_PORTA: '47821', ORBIT_EXTERNAS: '["a","b"]',
  });
  assert.equal(ambienteDe({ id: 'e1' }, 'x', 'redator', 1).ORBIT_EXTERNAS, '[]');
  for (const k of Object.keys(ambienteDe({ id: 'e1' }, 'x', 'p', 1))) assert.match(k, /^ORBIT_/);
});

// ───────────────────────── F2: casos novos por item da revisão ─────────────────────────

const detalhe = async (a, id) => (await a.chamar('GET', `/escritorios/${id}`)).corpo;

test('P0-1c / P1-2: instâncias levam a configuração com disableAllHooks:false, node do Orbit e allow de notas/_progresso', async () => {
  const a = ambiente();
  const e = await a.criar();
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  const exe = process.execPath.replace(/\\/g, '/');
  for (const [, b] of a.ctl.de('criarInstancia')) {
    const cfg = b.configuracao;
    assert.equal(cfg.disableAllHooks, false);
    assert.equal(cfg.hooks.PreToolUse[0].matcher, MATCHER_HOOK);
    assert.ok(cfg.hooks.PreToolUse[0].hooks[0].command.startsWith(`"${exe}" `), 'comando com o execPath, sem depender do PATH');
    assert.ok(cfg.hooks.PreToolUse[0].hooks[0].command.endsWith('escritorio-hook.mjs"'));
    const allow = cfg.permissions.allow;
    assert.ok(allow.some((r) => r.startsWith('Bash(node "') && r.includes('membro.mjs')), 'membro.mjs liberado');
    assert.equal(allow.filter((r) => /^(Write|Edit)\(\/\/.*\/(notas|_progresso)\/\*\*\)$/.test(r)).length, 4, 'escrita só em notas/ e _progresso/');
    assert.equal(allow.length, 5, 'nenhuma outra regra');
  }
});

test('P1-4: criarInstancia recebe orcamentoUsd = o que resta da execução', async () => {
  const a = ambiente();
  const e = await a.criar({ orcamento: { porExecucaoUsd: 2, porDiaUsd: 100 } });
  const exec = await a.acionar(e.id);
  assert.equal(a.ctl.de('criarInstancia')[0][1].orcamentoUsd, 2);
  await a.enviar(e.id, 'redator', exec.orquestrador); // mantém a execução aberta
  assert.equal(a.ctl.de('criarInstancia')[1][1].orcamentoUsd, 2);
  a.ctl.resultado(exec.orquestrador, { custoUsd: 0.5 });
  await a.esc.aguardar();
  await a.enviar(e.id, 'revisor', exec.orquestrador);
  assert.equal(a.ctl.de('criarInstancia')[2][1].orcamentoUsd, 1.5);
});

test('P1-1 / P2-4: pastaValida recusa raiz do disco, home, Orbit, dados, escritórios e ancestrais; aceita subpasta', async () => {
  const casa = fs.mkdtempSync(path.join(TMP, 'home-'));
  fs.mkdirSync(path.join(casa, 'proj'), { recursive: true });
  const a = ambiente({ home: casa });
  fs.mkdirSync(a.deps.pasta, { recursive: true });
  const recusa = async (pasta, parte) => {
    const r = await a.chamar('POST', '/escritorios', a.base({ pasta }));
    assert.equal(r.status, 400, `${parte}: ${JSON.stringify(r.corpo)}`);
    assert.ok(r.corpo.erro, parte);
  };
  await recusa(path.parse(a.dir).root, 'raiz do disco');
  await recusa(casa, 'home');
  await recusa(path.dirname(casa), 'ancestral da home');
  await recusa(RAIZ, 'raiz do Orbit');
  await recusa(path.dirname(RAIZ), 'ancestral da raiz do Orbit');
  await recusa(a.dir, 'pasta de dados (dirname dos escritórios)');
  await recusa(a.deps.pasta, 'a pasta dos escritórios');
  await recusa(path.dirname(a.dir), 'ancestral dos dados');
  const ok = await a.chamar('POST', '/escritorios', a.base({ pasta: path.join(casa, 'proj') }));
  assert.equal(ok.status, 200, JSON.stringify(ok.corpo));
  assert.equal(ok.corpo.escritorio.pasta, fs.realpathSync(path.join(casa, 'proj')), 'guarda o realpath');
  const sub = await a.chamar('POST', '/escritorios', a.base({ pasta: path.join(RAIZ, 'testes') }));
  assert.equal(sub.status, 200, 'subpasta do Orbit é uma pasta de trabalho válida');
  // salvar também valida, e não troca a pasta com o escritório rodando
  const e = ok.corpo.escritorio;
  assert.equal((await a.chamar('POST', `/escritorios/${e.id}`, { pasta: RAIZ })).status, 400);
  await a.acionar(e.id);
  const troca = await a.chamar('POST', `/escritorios/${e.id}`, { pasta: a.projeto });
  assert.equal(troca.status, 409, JSON.stringify(troca.corpo));
  assert.equal((await a.chamar('POST', `/escritorios/${e.id}`, { pasta: path.join(casa, 'proj') })).status, 200, 'a mesma pasta (pelo realpath) passa');
});

test('P1-5: result que chega com a execução pausada interrompe a sessão de novo; pausa manual não encerra membros', async () => {
  const a = ambiente();
  const e = await a.criar();
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  await a.chamar('POST', `/escritorios/${e.id}/pausar`, {});
  assert.equal(a.ctl.de('interromper').filter((x) => x[1] === 'sess-2').length, 1);
  assert.equal(a.ctl.de('encerrar').length, 0, 'pausa manual mantém os membros (liberar retoma)');
  a.ctl.resultado('sess-2', { texto: 'terminou depois da pausa' });
  await a.esc.aguardar();
  assert.equal(a.ctl.de('interromper').filter((x) => x[1] === 'sess-2').length, 2, 'interrompida de novo');
  a.ctl.resultado(exec.orquestrador, { texto: 'volta tardia' });
  await a.esc.aguardar();
  assert.equal(a.ctl.de('interromper').filter((x) => x[1] === 'sess-1').length, 2);
  assert.equal((await detalhe(a, e.id)).execucao.status, 'pausada');
  assert.equal(a.ctl.de('adormecer').length, 0, 'pausado não adormece membro');
});

test('P1-5: rota GET /escritorios/:id/status devolve só o status da execução', async () => {
  const a = ambiente();
  const e = await a.criar();
  assert.deepEqual((await a.chamar('GET', `/escritorios/${e.id}/status`)).corpo, { status: 'ociosa' });
  await a.acionar(e.id);
  assert.deepEqual((await a.chamar('GET', `/escritorios/${e.id}/status`)).corpo, { status: 'rodando' });
  await a.chamar('POST', `/escritorios/${e.id}/pausar`, {});
  assert.deepEqual((await a.chamar('GET', `/escritorios/${e.id}/status`)).corpo, { status: 'pausada' });
  assert.equal((await a.chamar('GET', '/escritorios/naoexiste/status')).status, 404);
  assert.equal((await a.chamar('GET', '/escritorios/Inválido!/status')).status, 400);
});

test('P1-6: o custo é por sessão:geração (processo novo da mesma sessão conta o total inteiro)', async () => {
  const a = ambiente();
  const e = await a.criar({ orcamento: { porExecucaoUsd: 10, porDiaUsd: 100 } });
  const exec = await a.acionar(e.id);
  const orq = exec.orquestrador;
  a.ctl.resultado(orq, { custoUsd: 0.5, geracao: 'g1' });
  a.ctl.resultado(orq, { custoUsd: 0.7, geracao: 'g1' }); // +0.2
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.custo.execucaoUsd, 0.7);
  a.ctl.resultado(orq, { custoUsd: 0.3, geracao: 'g2' }); // processo novo: o contador recomeçou, soma os 0.3
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.custo.execucaoUsd, 1);
  a.ctl.resultado(orq, { custoUsd: 0.4, geracao: 'g2' }); // +0.1
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.custo.execucaoUsd, 1.1);
});

test('P1-7: membro que acaba a volta é adormecido (se não ocupado); orquestrador e pausa não', async () => {
  const a = ambiente();
  const e = await a.criar();
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  await a.enviar(e.id, 'revisor', exec.orquestrador);
  a.ctl.resultado('sess-2', { texto: 'ok' });
  await a.esc.aguardar();
  assert.deepEqual(a.ctl.de('adormecer'), [['adormecer', 'sess-2']]);
  a.ctl.ocupadas.add('sess-3'); // já recebeu outra mensagem na fila: não pode dormir
  a.ctl.resultado('sess-3', { texto: 'ok' });
  await a.esc.aguardar();
  assert.equal(a.ctl.de('adormecer').length, 1);
  a.ctl.resultado(exec.orquestrador, { texto: 'volta' });
  await a.esc.aguardar();
  assert.equal(a.ctl.de('adormecer').some((x) => x[1] === exec.orquestrador), false, 'o orquestrador não dorme');
});

test('P1-7: sem adormecer no controle o fim da volta segue normal (defensivo)', async () => {
  const ctl = controleFalso();
  delete ctl.adormecer;
  const a = ambiente({ controle: ctl });
  const e = await a.criar();
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  ctl.resultado('sess-2', { texto: 'ok' });
  await a.esc.aguardar();
  assert.equal(ctl.de('adormecer').length, 0);
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}/membro/redator/estado`)).corpo.status, 'concluida');
});

test('P1-7: prazo máximo por execução pausa com motivo "tempo", encerra membros, alerta e libera recomeça o prazo', async () => {
  const a = ambiente({ prazoMin: 1 });
  const e = await a.criar();
  const exec = await a.acionar(e.id);
  const orq = exec.orquestrador;
  await a.enviar(e.id, 'redator', orq);
  await a.enviar(e.id, 'revisor', orq);
  a.ctl.resultado(orq, { custoUsd: 0.01 });
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.status, 'rodando', 'dentro do prazo');
  a.relogio.agora = new Date(2026, 9, 21, 10, 2); // 2 min depois
  a.ctl.resultado(orq, { custoUsd: 0.02 });
  await a.esc.aguardar();
  let det = await detalhe(a, e.id);
  assert.equal(det.execucao.status, 'pausada');
  assert.equal(det.execucao.motivoPausa, 'tempo');
  assert.deepEqual(a.ctl.de('encerrar').map((x) => x[1]).sort(), ['sess-2', 'sess-3']);
  const p = a.alertasSse().filter((x) => x.tipo === 'pausa');
  assert.equal(p.length, 1);
  assert.match(p[0].texto, /prazo máximo de 1 min/);
  assert.equal(a.celular.length, 1);
  // liberar: o prazo recomeça a contar da liberação
  const l = await a.chamar('POST', `/escritorios/${e.id}/liberar`, {});
  assert.equal(l.status, 200, JSON.stringify(l.corpo));
  a.ctl.resultado(orq, { custoUsd: 0.03 });
  await a.esc.aguardar();
  det = await detalhe(a, e.id);
  assert.notEqual(det.execucao.status, 'pausada', 'não pausa de novo logo depois de liberar (prazo recomeçou)');
  assert.equal(det.execucao.motivoPausa, undefined);
  assert.equal(a.alertasSse().filter((x) => x.tipo === 'pausa').length, 1);
  a.esc.parar();
});

test('P2-1: reserva de convidados: consultas seguidas não furam o limite; a reserva expira e dá baixa quando o agente aparece', async () => {
  const a = ambiente();
  const e = await a.criar({ convidados: { limite: 2 } });
  const exec = await a.acionar(e.id);
  const orq = exec.orquestrador;
  const consulta = async () => (await a.chamar('GET', `/escritorios/convidados?sessao=${orq}`)).corpo;
  assert.equal((await consulta()).permitido, true);
  assert.equal((await consulta()).permitido, true);
  const terceira = await consulta();
  assert.deepEqual(terceira, { escritorio: e.id, limite: 2, ativos: 0, permitido: false }, 'três hooks em paralelo, limite 2: a 3ª é negada');
  a.relogio.agora = new Date(a.relogio.agora.getTime() + 31000);
  assert.equal((await consulta()).permitido, true, 'reservas de 30 s expiraram');

  // baixa: quando os agentes aparecem em s.agentes a reserva vira ativo (sem contar duas vezes)
  const b = ambiente();
  const e2 = await b.criar({ convidados: { limite: 3 } });
  const orq2 = (await b.acionar(e2.id)).orquestrador;
  const c2 = async () => (await b.chamar('GET', `/escritorios/convidados?sessao=${orq2}`)).corpo;
  assert.equal((await c2()).permitido, true);
  assert.equal((await c2()).permitido, true); // 2 reservas
  b.ctl.sessoes.get(orq2).dados = { agentes: [{ id: 'g1', status: 'trabalhando' }, { id: 'g2', status: 'trabalhando' }] };
  const apos = await c2();
  assert.equal(apos.ativos, 2);
  assert.equal(apos.permitido, true, '2 ativos (as 2 reservas baixaram) + 0 reservas < 3');
  assert.equal((await c2()).permitido, false, '2 ativos + 1 reserva = 3');
});

test('P0-2: reinício casa a execução ativa com o controle, reidrata e a pausa continua funcionando', async () => {
  const a = ambiente();
  const e = await a.criar();
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  a.ctl.resultado(exec.orquestrador, { custoUsd: 0.3 });
  await a.esc.aguardar();
  const gravado = JSON.parse(fs.readFileSync(path.join(a.deps.pasta, `${e.id}.estado.json`), 'utf8'));
  assert.equal(gravado.exec.execucao, exec.execucao);
  assert.equal(gravado.exec.status, 'rodando');
  assert.equal(gravado.rt.estados.redator, 'trabalhando');
  assert.equal(gravado.sessoes['sess-2'].papel, 'redator');
  a.esc.parar();

  a.ctl.ocupadas.add(exec.orquestrador); // o orquestrador ainda está no meio da volta
  const b = ambiente({ pasta: a.deps.pasta, controle: a.ctl });
  await b.esc.pronto;
  await b.esc.aguardar();
  const det = await detalhe(b, e.id);
  assert.equal(det.execucao.status, 'rodando');
  assert.equal(det.execucao.execucao, exec.execucao);
  assert.deepEqual(det.execucao.membros, { redator: 'sess-2' });
  assert.equal(det.execucao.custo.execucaoUsd, 0.3);
  assert.equal(a.ctl.de('encerrar').length, 0, 'nada foi encerrado: a execução foi reassumida');
  // result da sessão reassumida volta a ser processado
  a.ctl.resultado('sess-2', { custoUsd: 0.1, texto: 'feito' });
  await b.esc.aguardar();
  assert.equal((await b.chamar('GET', `/escritorios/${e.id}/membro/redator/estado`)).corpo.status, 'concluida');
  // pausar funciona na instância nova
  const p = await b.chamar('POST', `/escritorios/${e.id}/pausar`, {});
  assert.equal(p.status, 200, JSON.stringify(p.corpo));
  assert.ok(a.ctl.de('interromper').some((x) => x[1] === exec.orquestrador));
  b.esc.parar();
});

test('P0-2: execução que não casa com o controle vira erro/reinicio e as sessões são interrompidas e encerradas', async () => {
  const a = ambiente();
  const e = await a.criar();
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  a.esc.parar();

  const ctl2 = controleFalso();
  delete ctl2.listarEscritorio; // controle que não sabe listar (ou sessões que não voltaram)
  const b = ambiente({ pasta: a.deps.pasta, controle: ctl2 });
  await b.esc.pronto;
  await b.esc.aguardar();
  const det = await detalhe(b, e.id);
  assert.equal(det.execucao.status, 'erro');
  assert.equal(det.execucao.motivoErro, 'reinicio');
  for (const s of ['sess-1', 'sess-2']) {
    assert.ok(ctl2.de('interromper').some((x) => x[1] === s), `interrompe ${s}`);
    assert.ok(ctl2.de('encerrar').some((x) => x[1] === s), `encerra ${s}`);
  }
  assert.equal(det.execucao.estados.redator, 'interrompida');
  // acionar de novo é possível (não fica travado)
  assert.equal((await b.chamar('POST', `/escritorios/${e.id}/acionar`, { tarefa: 'de novo' })).status, 202);
  b.esc.parar();
});

test('P0-2: sessão de escritório órfã no controle é encerrada; execução pausada reassumida segue pausada', async () => {
  const a = ambiente();
  const e = await a.criar();
  const exec = await a.acionar(e.id);
  await a.chamar('POST', `/escritorios/${e.id}/pausar`, {});
  a.esc.parar();
  a.ctl.sessoes.set('sess-orfa', { b: { escritorio: { id: 'outro-escritorio', execucao: 'x', papel: 'orquestrador' } }, viva: true });
  const b = ambiente({ pasta: a.deps.pasta, controle: a.ctl });
  await b.esc.pronto;
  await b.esc.aguardar();
  assert.ok(a.ctl.de('encerrar').some((x) => x[1] === 'sess-orfa'), 'órfã encerrada');
  assert.ok(a.ctl.de('interromper').some((x) => x[1] === 'sess-orfa'));
  assert.equal(a.ctl.sessoes.get(exec.orquestrador).viva, true, 'a execução casada não é tocada');
  const det = await detalhe(b, e.id);
  assert.equal(det.execucao.status, 'pausada');
  assert.equal(det.execucao.motivoPausa, 'manual');
  b.esc.parar();
});

// ───────────────────────── B0: resumo ampliado (canvas, agentes, convidados) e POST parcial ─────────────────────────

const resumoDoId = async (a, id) => (await a.chamar('GET', '/escritorios')).corpo.escritorios.find((x) => x.id === id);
const estadosDe = (r) => Object.fromEntries(r.agentes.map((x) => [x.id, x.estado]));

test('B0: resumo traz canvas, agentes (orquestrador primeiro) e convidados; sem execução tudo dorme', async () => {
  const a = ambiente();
  const e = await a.criar({ canvas: { x: 120, y: 80 } });
  const r = await resumoDoId(a, e.id);
  assert.deepEqual(r.canvas, { x: 120, y: 80 });
  assert.deepEqual(r.agentes, [
    { id: 'orquestrador', nome: 'Orquestrador', papel: 'Orquestrador', provedor: 'claude', estado: 'dormindo' },
    { id: 'redator', nome: 'Rê', papel: 'Redator', provedor: 'claude', estado: 'dormindo' },
    { id: 'revisor', nome: 'Revisor', papel: 'Revisor', provedor: 'claude', estado: 'dormindo' },
  ]);
  assert.equal(r.convidados, 0);
  assert.equal(r.membros, 2);
  const ev = a.eventos.filter(([t, d]) => t === 'escritorio' && d.id === e.id).pop();
  assert.deepEqual(ev[1].resumo.agentes.map((x) => x.id), ['orquestrador', 'redator', 'revisor'], 'o SSE leva o mesmo resumo');
  assert.deepEqual(ev[1].resumo.canvas, { x: 120, y: 80 });
});

test('B0: estado por agente acompanha a execução (trabalhando, aguardando, ocioso, erro, dormindo)', async () => {
  const a = ambiente();
  const e = await a.criar({ orquestrador: { nome: 'Chefe' } });
  const exec = await a.acionar(e.id);
  let r = await resumoDoId(a, e.id);
  assert.equal(r.agentes[0].nome, 'Chefe');
  assert.deepEqual(estadosDe(r), { orquestrador: 'trabalhando', redator: 'dormindo', revisor: 'dormindo' });

  await a.enviar(e.id, 'redator', exec.orquestrador);
  r = await resumoDoId(a, e.id);
  assert.equal(estadosDe(r).redator, 'trabalhando');
  assert.equal(estadosDe(r).revisor, 'dormindo');

  // pedido de aprovação pendente (sessão aguardando) → aguardando
  const sidRed = (await detalhe(a, e.id)).execucao.membros.redator;
  a.ctl.sessoes.get(sidRed).dados = { status: 'aguardando' };
  assert.equal(estadosDe(await resumoDoId(a, e.id)).redator, 'aguardando');
  a.ctl.sessoes.get(sidRed).dados = { status: 'trabalhando' };

  // membro conclui: ocioso
  a.ctl.resultado(sidRed, { texto: 'pronto' });
  await a.esc.aguardar();
  r = await resumoDoId(a, e.id);
  assert.equal(estadosDe(r).redator, 'ocioso');

  // processo dormindo no controle → dormindo
  const original = a.ctl.estado;
  a.ctl.estado = (id) => (id === sidRed ? { processo: 'dormindo', ocupada: false } : original(id));
  assert.equal(estadosDe(await resumoDoId(a, e.id)).redator, 'dormindo');
  a.ctl.estado = original;

  // erro no membro
  await a.enviar(e.id, 'revisor', exec.orquestrador);
  const sidRev = (await detalhe(a, e.id)).execucao.membros.revisor;
  assert.equal(estadosDe(await resumoDoId(a, e.id)).revisor, 'trabalhando');
  a.ctl.resultado(sidRev, { erro: true, texto: 'falhou' });
  await a.esc.aguardar();
  assert.equal(estadosDe(await resumoDoId(a, e.id)).revisor, 'erro');

  // o orquestrador termina a volta e a execução fecha: ocioso
  a.ctl.resultado(exec.orquestrador, {});
  await a.esc.aguardar();
  r = await resumoDoId(a, e.id);
  assert.equal(r.status, 'concluida');
  assert.equal(estadosDe(r).orquestrador, 'ocioso');
});

test('B0: convidados = subagentes ativos do orquestrador, só com a execução rodando', async () => {
  const a = ambiente();
  const e = await a.criar();
  assert.equal((await resumoDoId(a, e.id)).convidados, 0);
  const exec = await a.acionar(e.id);
  a.ctl.sessoes.get(exec.orquestrador).dados = { status: 'trabalhando', agentes: [{ status: 'trabalhando' }, { status: 'aguardando' }, { status: 'concluido' }] };
  assert.equal((await resumoDoId(a, e.id)).convidados, 2);
  a.ctl.sessoes.get(exec.orquestrador).dados = { status: 'trabalhando', agentes: [] };
  assert.equal((await resumoDoId(a, e.id)).convidados, 0);
});

test('B0: o SSE `escritorio` sai quando o estado de um agente muda, uma vez só por mudança', async () => {
  const a = ambiente({ vigiaMs: 20 });
  try {
    const e = await a.criar();
    const exec = await a.acionar(e.id);
    await a.enviar(e.id, 'redator', exec.orquestrador);
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    await espera(80);
    const mudancas = () => a.eventos.filter(([t, d]) => t === 'escritorio' && d.id === e.id).length;
    const antes = mudancas();
    await espera(100);
    assert.equal(mudancas(), antes, 'sem mudança, nada é publicado');
    a.ctl.sessoes.get(exec.orquestrador).dados = { status: 'trabalhando', agentes: [{ status: 'trabalhando' }] };
    await espera(100);
    assert.equal(mudancas(), antes + 1, 'um evento para a mudança');
    const ultimo = a.eventos.filter(([t, d]) => t === 'escritorio' && d.id === e.id).pop()[1];
    assert.equal(ultimo.resumo.convidados, 1);
    const sidRed = (await detalhe(a, e.id)).execucao.membros.redator;
    a.ctl.sessoes.get(sidRed).dados = { status: 'aguardando' };
    await espera(100);
    assert.equal(mudancas(), antes + 2);
    assert.equal(a.eventos.filter(([t, d]) => t === 'escritorio' && d.id === e.id).pop()[1].resumo.agentes[1].estado, 'aguardando');
  } finally { a.esc.parar(); }
});

test('B0: POST /escritorios/:id aceita corpo parcial sem perder nem exigir os outros campos', async () => {
  const a = ambiente();
  const e = await a.criar({ canvas: { x: 10, y: 20 }, convidados: { limite: 4 }, orcamento: { porExecucaoUsd: 3 } });
  let r = await a.chamar('POST', `/escritorios/${e.id}`, { canvas: { x: 300, y: 40 } });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.deepEqual(r.corpo.escritorio.canvas, { x: 300, y: 40 });
  assert.equal(r.corpo.escritorio.nome, 'Marketing');
  assert.equal(r.corpo.escritorio.membros.length, 2);
  assert.equal(r.corpo.escritorio.convidados.limite, 4);
  assert.equal(r.corpo.escritorio.orcamento.porExecucaoUsd, 3);
  assert.equal(r.corpo.escritorio.pasta, e.pasta);

  r = await a.chamar('POST', `/escritorios/${e.id}`, { canvas: { x: 5 } });
  assert.deepEqual(r.corpo.escritorio.canvas, { x: 5, y: 40 }, 'canvas parcial mantém o eixo que faltou');

  r = await a.chamar('POST', `/escritorios/${e.id}`, { nome: 'Vendas' });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.escritorio.nome, 'Vendas');
  assert.deepEqual(r.corpo.escritorio.canvas, { x: 5, y: 40 });
  assert.equal(r.corpo.escritorio.membros[0].nome, 'Rê');
  assert.equal(r.corpo.escritorio.orquestrador.prompt, 'Você lidera o marketing.');

  const salvo = (await detalhe(a, e.id)).escritorio;
  assert.equal(salvo.nome, 'Vendas');
  assert.equal(salvo.funcao, 'Cuida do marketing');
  const ev = a.eventos.filter(([t, d]) => t === 'escritorio' && d.id === e.id).pop()[1];
  assert.equal(ev.resumo.nome, 'Vendas');
  assert.deepEqual(ev.resumo.canvas, { x: 5, y: 40 });

  r = await a.chamar('POST', `/escritorios/${e.id}`, { canvas: { x: 'a', y: 1 } });
  assert.equal(r.status, 400, 'canvas inválido segue recusado');
  assert.deepEqual((await detalhe(a, e.id)).escritorio.canvas, { x: 5, y: 40 });
});

// ───────────────────────── B1b: membros do Codex (ponte falsa injetada) ─────────────────────────

const MSG_CODEX_OFF = 'O Codex está desligado nas Configurações: ligue-o para usar membros do Codex.';

// Ponte falsa do Codex (a API de codex.ponte: criar/enviar/interromper/encerrar/estado/listarEscritorio/ouvirFim/vincular).
function ponteFalsa() {
  const p = {
    n: 0, threads: new Map(), ouvintes: new Set(), ouvintesUso: new Set(), chamadas: [], falharCriar: null,
    async criar(b) {
      p.chamadas.push(['criar', b]);
      if (p.falharCriar) throw p.falharCriar;
      const id = `cx-${++p.n}`;
      p.threads.set(id, { b, viva: true, ocupada: true });
      return { sessao: id, acao: {} };
    },
    enviar(id, t) { p.chamadas.push(['enviar', id, t]); if (!p.threads.get(id)?.viva) throw new Error('sessão não encontrada'); p.threads.get(id).ocupada = true; return {}; },
    async interromper(id) { p.chamadas.push(['interromper', id]); return true; },
    async encerrar(id) { p.chamadas.push(['encerrar', id]); const t = p.threads.get(id); if (t) t.viva = false; return {}; },
    estado(id) { const t = p.threads.get(id); return t && t.viva ? { ocupada: !!t.ocupada, processo: 'vivo', provedor: 'codex' } : null; },
    listarEscritorio() { return [...p.threads].filter(([, t]) => t.viva).map(([id, t]) => ({ id, escritorio: { ...t.b.escritorio }, processo: 'vivo' })); },
    ouvirFim(fn) { p.ouvintes.add(fn); return () => p.ouvintes.delete(fn); },
    ouvirUso(fn) { p.ouvintesUso.add(fn); return () => p.ouvintesUso.delete(fn); },
    vincular(id, o) { p.chamadas.push(['vincular', id, o]); return true; },
    de(nome) { return p.chamadas.filter((x) => x[0] === nome); },
    // thread/tokenUsage/updated de um thread de escritório (o que o motor entrega ao ouvirUso): tokens ACUMULADOS do thread
    uso(id, tokens, ev = {}) {
      const t = p.threads.get(id);
      for (const f of [...p.ouvintesUso]) f({ sessao: id, tokens, modelo: '', geracao: 'g1', escritorio: t ? { ...t.b.escritorio } : undefined, ...ev });
    },
    // fim de turno de um thread (o que o motor do Codex entrega ao ouvirFim)
    fim(id, ev = {}) {
      const t = p.threads.get(id);
      if (t) t.ocupada = false;
      for (const f of [...p.ouvintes]) f({ sessao: id, texto: '', erro: null, tokens: null, modelo: '', geracao: 'g1', status: 'completed', escritorio: t ? { ...t.b.escritorio } : undefined, ...ev });
    },
  };
  return p;
}

// Ambiente com o Codex ligado: a ponte falsa entra nas deps; `ligado.v` liga/desliga o Codex e `ligado.ponte` tira a ponte.
function ambienteCodex(extra = {}) {
  const ponte = extra.ponte || ponteFalsa();
  const ligado = { v: !extra.desligado, ponte: !extra.desligado };
  const validados = [];
  const a = ambiente({
    codex: () => (ligado.ponte ? ponte : null),
    codexAtivo: () => ligado.v,
    validarModeloCodex: (m, e) => {
      validados.push([m, e]);
      if (m === 'inexistente') return false;
      if (e === 'ruim') return 'O esforço "ruim" não existe para o modelo do Codex.';
      if (m === 'normaliza') return { modelo: 'gpt-5.2-codex', esforco: 'medium' };
      if (m === 'lanca') throw new Error('Codex fora do ar');
      return true;
    },
    esperarCodex: async () => {},
    ...extra.deps,
  });
  const membrosCx = [
    { id: 'redator', papel: 'Redator', nome: 'Rê', prompt: 'Escreva textos.', provedor: 'codex', modelo: 'gpt-5.2-codex', esforco: 'medium' },
    { id: 'revisor', papel: 'Revisor', prompt: 'Revise textos.' },
  ];
  return { ...a, ponte, ligado, validados, membrosCx };
}
const postEsc = (a, id, corpo) => a.chamar('POST', `/escritorios/${id}`, corpo);
const orcGrande = { porExecucaoUsd: 50, porDiaUsd: 100, avisoPct: 80 };
const tk = (entrada, saida = 0, cacheEntrada = 0, raciocinio = 0) => ({ entrada, cacheEntrada, saida, raciocinio, total: entrada + saida });

test('Codex: criar e salvar membro do Codex; provedor aparece no detalhe e no resumo', async () => {
  const a = ambienteCodex();
  const e = await a.criar({ membros: a.membrosCx });
  assert.equal(e.membros[0].provedor, 'codex');
  assert.equal(e.membros[0].modelo, 'gpt-5.2-codex');
  assert.equal(e.membros[0].esforco, 'medium');
  assert.equal(e.membros[1].provedor, 'claude', 'sem provedor = Claude');
  assert.deepEqual(a.validados, [['gpt-5.2-codex', 'medium']], 'só o membro do Codex passa pelo validador do Codex');
  assert.equal((await detalhe(a, e.id)).escritorio.membros[0].provedor, 'codex');
  const resumo = (await a.chamar('GET', '/escritorios')).corpo.escritorios[0];
  assert.deepEqual(resumo.agentes.map((x) => x.provedor), ['claude', 'codex', 'claude']);
  // o validador pode normalizar modelo/esforço
  const r = await postEsc(a, e.id, { membros: [{ ...a.membrosCx[0], modelo: 'normaliza', esforco: 'low' }, a.membrosCx[1]] });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.escritorio.membros[0].modelo, 'gpt-5.2-codex');
  assert.equal(r.corpo.escritorio.membros[0].esforco, 'medium');
  // trocar o provedor de um membro do Claude para o Codex e voltar
  const r2 = await postEsc(a, e.id, { membros: [a.membrosCx[0], { ...a.membrosCx[1], provedor: 'codex', modelo: 'gpt-5.2-codex', esforco: 'high' }] });
  assert.equal(r2.status, 200, JSON.stringify(r2.corpo));
  assert.equal(r2.corpo.escritorio.membros[1].provedor, 'codex');
  const r3 = await postEsc(a, e.id, { membros: [a.membrosCx[0], { id: 'revisor', papel: 'Revisor', provedor: 'claude' }] });
  assert.equal(r3.corpo.escritorio.membros[1].provedor, 'claude');
});

test('Codex: recusas (líder do Codex, provedor inválido, Codex desligado, modelo inválido) e membro inalterado passa', async () => {
  const a = ambienteCodex();
  const e = await a.criar({ membros: a.membrosCx });

  // o líder é sempre do Claude (na criação e no salvar)
  let r = await a.chamar('POST', '/escritorios', a.base({ orquestrador: { prompt: 'x', provedor: 'codex' } }));
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /líder do escritório é sempre do Claude/);
  r = await postEsc(a, e.id, { orquestrador: { provedor: 'codex' } });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /sempre do Claude/);
  r = await postEsc(a, e.id, { orquestrador: { provedor: 'claude' } });
  assert.equal(r.status, 200, 'provedor claude no líder é aceito');

  // provedor desconhecido
  r = await postEsc(a, e.id, { membros: [{ ...a.membrosCx[0], provedor: 'gemini' }] });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /'claude' ou 'codex'/);

  // modelo inválido pelo validarModeloCodex: false, texto de regra, exceção
  r = await postEsc(a, e.id, { membros: [{ ...a.membrosCx[0], modelo: 'inexistente' }] });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /Modelo\/esforço de o membro redator inválidos/);
  r = await postEsc(a, e.id, { membros: [{ ...a.membrosCx[0], esforco: 'ruim' }] });
  assert.equal(r.status, 400);
  assert.equal(r.corpo.erro, 'O esforço "ruim" não existe para o modelo do Codex.');
  r = await postEsc(a, e.id, { membros: [{ ...a.membrosCx[0], modelo: 'lanca' }] });
  assert.equal(r.status, 400);
  assert.equal(r.corpo.erro, 'Codex fora do ar');
  assert.equal((await detalhe(a, e.id)).escritorio.membros[0].modelo, 'gpt-5.2-codex', 'recusa não grava nada');
  // o validador do Claude NÃO vale para membro do Codex (no Claude 'ruim' é recusado; no Codex 'gpt-5.1' passa) e vice-versa
  r = await postEsc(a, e.id, { membros: [{ ...a.membrosCx[0], modelo: 'gpt-5.1' }] });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.escritorio.membros[0].modelo, 'gpt-5.1');
  r = await postEsc(a, e.id, { membros: [a.membrosCx[0], { id: 'revisor', papel: 'Revisor', modelo: 'ruim' }] });
  assert.equal(r.status, 400, 'membro do Claude continua no validarModelo do Claude');

  // Codex desligado: membro novo ou com modelo/esforço mudado é recusado com a mensagem do Codex
  a.ligado.v = false;
  r = await a.chamar('POST', '/escritorios', a.base({ membros: a.membrosCx }));
  assert.equal(r.status, 400);
  assert.equal(r.corpo.erro, MSG_CODEX_OFF);
  r = await postEsc(a, e.id, { membros: [{ ...a.membrosCx[0], esforco: 'high' }] });
  assert.equal(r.status, 400);
  assert.equal(r.corpo.erro, MSG_CODEX_OFF);
  r = await postEsc(a, e.id, { membros: [{ id: 'novo', papel: 'Novo', provedor: 'codex' }] });
  assert.equal(r.status, 400);
  assert.equal(r.corpo.erro, MSG_CODEX_OFF);
  // ...mas o membro do Codex que não mudou (renomear, mover no canvas) passa mesmo com o Codex desligado
  a.ligado.v = true;
  r = await postEsc(a, e.id, { membros: [a.membrosCx[0]] }); // volta ao modelo da lista
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  a.ligado.v = false;
  const n = a.validados.length;
  r = await postEsc(a, e.id, { nome: 'Outro nome', canvas: { x: 9, y: 9 }, membros: [{ ...a.membrosCx[0], nome: 'Ré', prompt: 'Novo prompt.' }] });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.escritorio.membros[0].provedor, 'codex');
  assert.equal(r.corpo.escritorio.membros[0].nome, 'Ré');
  // sem repetir o provedor, o membro do Codex continua do Codex
  r = await postEsc(a, e.id, { membros: [{ id: 'redator', papel: 'Redator', modelo: 'gpt-5.2-codex', esforco: 'medium' }] });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.escritorio.membros[0].provedor, 'codex');
  assert.equal(a.validados.length, n, 'membro inalterado não chama o validador do Codex');

  // sem a dep codexAtivo, vale "há ponte"
  const b = ambienteCodex({ deps: { codexAtivo: undefined } });
  b.ligado.ponte = false;
  r = await b.chamar('POST', '/escritorios', b.base({ membros: b.membrosCx }));
  assert.equal(r.status, 400);
  assert.equal(r.corpo.erro, MSG_CODEX_OFF);
});

test('Codex: delegar ao membro cria o thread pela ponte (escritorio, travas, instruções) e reaproveita nas tarefas seguintes', async () => {
  const a = ambienteCodex();
  const e = await a.criar({ membros: a.membrosCx, externas: { extras: ['^foo\\b'] } });
  const exec = await a.acionar(e.id);
  const r = await a.enviar(e.id, 'redator', exec.orquestrador, 'Escreva o texto');
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.sessao, 'cx-1');
  assert.equal(a.ctl.de('criarInstancia').length, 1, 'só o orquestrador nasceu no controle do Claude');
  const [, b] = a.ponte.de('criar')[0];
  assert.deepEqual(b.escritorio, { id: e.id, execucao: exec.execucao, papel: 'redator' });
  assert.equal(b.pasta, a.projeto);
  assert.equal(b.nome, 'Marketing · Rê');
  assert.equal(b.modelo, 'gpt-5.2-codex');
  assert.equal(b.esforco, 'medium');
  assert.equal(b.texto, 'Escreva o texto');
  assert.equal(b.pai, undefined, 'o aviso ao líder é do escritório, não da ponte');
  assert.equal(b.avisarLider, undefined);
  assert.deepEqual(b.travas.extras, ['^foo\\b']);
  assert.equal(b.travas.porta, 47822);
  assert.equal(typeof b.travas.raiz, 'string');
  assert.ok(b.travas.raiz.length > 0 && !b.travas.raiz.includes('\\'), 'raiz do Orbit com barras normais');
  assert.equal(typeof b.travas.pausado, 'function');
  assert.equal(b.travas.pausado(), false, 'execução rodando: não pausado');
  assert.match(b.instrucoes, /Escreva textos\./, 'o prompt do papel vai nas instruções');
  assert.match(b.instrucoes, /## Ambiente do escritório/);
  assert.match(b.instrucoes, new RegExp(`ORBIT_ESCRITORIO=${e.id}`));
  assert.match(b.instrucoes, new RegExp(`ORBIT_EXECUCAO=${exec.execucao}`));
  assert.match(b.instrucoes, /ORBIT_PAPEL=redator/);
  assert.match(b.instrucoes, /ORBIT_PORTA=47822/);
  assert.match(b.instrucoes, /ORBIT_EXTERNAS=/);
  // o do Claude não leva o bloco de ambiente (usa variáveis de ambiente de verdade)
  const d0 = (await detalhe(a, e.id)).escritorio;
  assert.doesNotMatch(anexoMembro(d0, d0.membros[1]), /Ambiente do escritório/);

  // estado do membro e do agente
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}/membro/redator/estado`)).corpo.status, 'trabalhando');
  const ag = (await a.chamar('GET', '/escritorios')).corpo.escritorios[0].agentes.find((x) => x.id === 'redator');
  assert.deepEqual([ag.provedor, ag.estado], ['codex', 'trabalhando']);
  assert.equal((await detalhe(a, e.id)).execucao.membros.redator, 'cx-1');
  // o snapshot guarda o provedor da sessão (para a reidratação)
  const gravado = JSON.parse(fs.readFileSync(path.join(a.deps.pasta, `${e.id}.estado.json`), 'utf8'));
  assert.equal(gravado.sessoes['cx-1'].provedor, 'codex');
  assert.equal(gravado.sessoes[exec.orquestrador].provedor, undefined);

  // 2ª tarefa: mesma sessão, enviada pela ponte (nunca pelo controle do Claude)
  const r2 = await a.enviar(e.id, 'redator', exec.orquestrador, 'Agora revise');
  assert.equal(r2.corpo.sessao, 'cx-1');
  assert.deepEqual(a.ponte.de('enviar'), [['enviar', 'cx-1', 'Agora revise']]);
  assert.equal(a.ponte.de('criar').length, 1);
  assert.equal(a.ctl.de('enviarMensagem').length, 0);
});

test('Codex: fim de turno avisa o líder e conta o custo estimado em US$ (estimado:true), só a diferença', async () => {
  const a = ambienteCodex();
  const e = await a.criar({ membros: a.membrosCx, orcamento: orcGrande });
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  assert.equal((await a.chamar('GET', '/escritorios')).corpo.escritorios[0].custo.estimado, undefined, 'antes de qualquer custo do Codex não há ≈');

  // gpt-5.2-codex: 1,75 / 14 por milhão → 1M de entrada + 100 mil de saída = 1,75 + 1,40
  a.ponte.fim('cx-1', { texto: 'Texto pronto', modelo: 'gpt-5.2-codex', tokens: tk(1_000_000, 100_000) });
  await a.esc.aguardar();
  const avs = a.ctl.de('avisarLider').filter((x) => /^Membro redator/.test(x[2]));
  assert.deepEqual(avs, [['avisarLider', exec.orquestrador, 'Membro redator concluiu: Texto pronto']]);
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}/membro/redator/estado`)).corpo.status, 'concluida');
  let det = await detalhe(a, e.id);
  assert.equal(det.execucao.custo.execucaoUsd, 3.15);
  assert.equal(det.execucao.custo.diaUsd, 3.15);
  assert.equal(det.execucao.custo.estimado, true);
  assert.equal(det.execucao.custo.semPreco, undefined, 'modelo da tabela: sem aviso de preço');
  let lista = (await a.chamar('GET', '/escritorios')).corpo.escritorios[0];
  assert.equal(lista.custo.execucaoUsd, 3.15);
  assert.equal(lista.custo.estimado, true);
  // persistido (o reinício mantém o ≈)
  let gravado = JSON.parse(fs.readFileSync(path.join(a.deps.pasta, `${e.id}.estado.json`), 'utf8'));
  assert.equal(gravado.exec.custo.estimado, true);
  assert.equal(gravado.exec.custo.execucaoUsd, 3.15);

  // 2º turno: os tokens são ACUMULADOS no thread → soma só a diferença (mais 1M de entrada = 1,75)
  a.ponte.fim('cx-1', { modelo: 'gpt-5.2-codex', tokens: tk(2_000_000, 100_000) });
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.custo.execucaoUsd, 4.9);
  // evento repetido (mesmo acumulado, mesma geração) não soma de novo
  a.ponte.fim('cx-1', { modelo: 'gpt-5.2-codex', tokens: tk(2_000_000, 100_000) });
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.custo.execucaoUsd, 4.9);
  // P1-2: processo novo (outra geração, resume que semeia o total do rollout): a base é o total JÁ COBRADO do thread, nunca 0
  a.ponte.fim('cx-1', { modelo: 'gpt-5.2-codex', geracao: 'g2', tokens: tk(2_000_000, 100_000) });
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.custo.execucaoUsd, 4.9, 'mesma base na geração nova: nada de cobrar o acumulado de novo');
  a.ponte.fim('cx-1', { modelo: 'gpt-5.2-codex', geracao: 'g2', tokens: tk(2_500_000, 100_000) });
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.custo.execucaoUsd, 5.775, 'só os 500 mil novos de entrada (0,875)');

  // fim com erro: o líder é avisado da falha; sem tokens não soma nada
  a.ponte.fim('cx-1', { erro: 'O turno falhou', texto: 'sem rede', tokens: null });
  await a.esc.aguardar();
  assert.ok(a.ctl.de('avisarLider').some((x) => x[2] === 'Membro redator falhou: O turno falhou — sem rede'));
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}/membro/redator/estado`)).corpo.status, 'erro');
  assert.equal((await detalhe(a, e.id)).execucao.custo.execucaoUsd, 5.775);
  // fim de um thread que não é de membro nenhum é ignorado
  a.ponte.fim('cx-99', { tokens: tk(5_000_000), modelo: 'gpt-5.2-codex' });
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.custo.execucaoUsd, 5.775);
  gravado = JSON.parse(fs.readFileSync(path.join(a.deps.pasta, `${e.id}.estado.json`), 'utf8'));
  assert.equal(gravado.diaUsd, 5.775);
  lista = (await a.chamar('GET', '/escritorios')).corpo.escritorios[0];
  assert.equal(lista.custo.diaUsd, 5.775);
});

test('Codex: a conta do Claude e a do Codex somam no mesmo orçamento; só Claude não ganha ≈', async () => {
  const a = ambienteCodex();
  const e = await a.criar({ membros: a.membrosCx, orcamento: orcGrande });
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  a.ctl.resultado(exec.orquestrador, { custoUsd: 0.5 });
  await a.esc.aguardar();
  assert.equal((await a.chamar('GET', '/escritorios')).corpo.escritorios[0].custo.estimado, undefined, 'só Claude: valor exato');
  a.ponte.fim('cx-1', { modelo: 'gpt-5.1-codex-mini', tokens: tk(1_000_000) });
  await a.esc.aguardar();
  const c = (await a.chamar('GET', '/escritorios')).corpo.escritorios[0].custo;
  assert.equal(c.execucaoUsd, 0.75); // 0,50 do Claude + 0,25 estimado do Codex
  assert.equal(c.estimado, true);
});

test('Codex: preço sobrescrito por precosCodex (objeto ou função) vale no lugar do padrão; cache entra mais barato', async () => {
  const precos = { 'GPT-5.2-Codex': { entrada: 10, cacheEntrada: 1, saida: 20 } };
  for (const dep of [precos, () => precos]) {
    const a = ambienteCodex({ deps: { precosCodex: dep } });
    const e = await a.criar({ membros: a.membrosCx, orcamento: orcGrande });
    const exec = await a.acionar(e.id);
    await a.enviar(e.id, 'redator', exec.orquestrador);
    // 1M de entrada (500 mil em cache) + 100 mil de saída = 5 + 0,5 + 2
    a.ponte.fim('cx-1', { modelo: 'gpt-5.2-codex', tokens: tk(1_000_000, 100_000, 500_000) });
    await a.esc.aguardar();
    const det = await detalhe(a, e.id);
    assert.equal(det.execucao.custo.execucaoUsd, 7.5);
    assert.equal(det.execucao.custo.estimado, true);
    assert.equal(det.execucao.custo.semPreco, undefined);
  }
  // preço inválido na config é ignorado: vale o padrão
  const b = ambienteCodex({ deps: { precosCodex: { 'gpt-5.2-codex': { entrada: -1, saida: 'x' } } } });
  const e = await b.criar({ membros: b.membrosCx, orcamento: orcGrande });
  const exec = await b.acionar(e.id);
  await b.enviar(e.id, 'redator', exec.orquestrador);
  b.ponte.fim('cx-1', { modelo: 'gpt-5.2-codex', tokens: tk(1_000_000, 100_000) });
  await b.esc.aguardar();
  assert.equal((await detalhe(b, e.id)).execucao.custo.execucaoUsd, 3.15);
});

test('Codex: modelo sem preço usa o preço MAIS ALTO da tabela (nunca 0) e fica marcado em semPreco', async () => {
  const a = ambienteCodex();
  const e = await a.criar({
    membros: [{ ...a.membrosCx[0], modelo: 'gpt-5.2-codex' }, { id: 'sem', papel: 'Sem modelo', provedor: 'codex' }],
    orcamento: orcGrande,
  });
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  await a.enviar(e.id, 'sem', exec.orquestrador);
  // o mais caro da tabela padrão é gpt-5.2 (1,75 / 14): 1M de entrada = 1,75 mesmo com modelo desconhecido
  // P2-5: o modelo do membro tem preço (senão 400 ao salvar); o preço mais alto fica de reserva p/ o modelo REAL mudar em execução
  a.ponte.fim('cx-1', { modelo: 'gpt-novo', tokens: tk(1_000_000) });
  await a.esc.aguardar();
  let det = await detalhe(a, e.id);
  assert.equal(det.execucao.custo.execucaoUsd, 1.75);
  assert.ok(det.execucao.custo.execucaoUsd > 0);
  assert.deepEqual(det.execucao.custo.semPreco, ['gpt-novo']);
  assert.equal(det.execucao.custo.estimado, true);
  // nenhum modelo (padrão do Codex): também o preço mais alto, marcado como "(sem modelo)"
  a.ponte.fim('cx-2', { modelo: '', tokens: tk(1_000_000, 100_000) });
  await a.esc.aguardar();
  det = await detalhe(a, e.id);
  assert.equal(det.execucao.custo.execucaoUsd, 4.9);
  assert.deepEqual(det.execucao.custo.semPreco, ['gpt-novo', '(sem modelo)']);
  const lista = (await a.chamar('GET', '/escritorios')).corpo.escritorios[0];
  assert.deepEqual(lista.custo.semPreco, ['gpt-novo', '(sem modelo)']);
  // o modelo REAL que o motor informa vale mais que o pedido (aqui é da tabela: preço próprio, sem novo semPreco); só a diferença
  a.ponte.fim('cx-1', { modelo: 'gpt-5.1-codex-mini', geracao: 'g2', tokens: tk(4_000_000) });
  await a.esc.aguardar();
  det = await detalhe(a, e.id);
  assert.equal(det.execucao.custo.execucaoUsd, 5.65, '4,90 + 3M (4M menos 1M já cobrado) × 0,25');
  assert.deepEqual(det.execucao.custo.semPreco, ['gpt-novo', '(sem modelo)']);
});

test('Codex: pausa por orçamento interrompe/encerra o Codex, travas.pausado() vira verdadeiro e o resumo traz motivoPausa', async () => {
  const a = ambienteCodex();
  const e = await a.criar({ membros: a.membrosCx, orcamento: { porExecucaoUsd: 1, porDiaUsd: 100, avisoPct: 80 } });
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  await a.enviar(e.id, 'revisor', exec.orquestrador);
  const pausado = a.ponte.de('criar')[0][1].travas.pausado;
  assert.equal(pausado(), false);
  let lista = (await a.chamar('GET', '/escritorios')).corpo.escritorios[0];
  assert.equal(lista.motivoPausa, undefined, 'rodando: sem motivoPausa');

  // 1M de entrada em gpt-5.2-codex = US$ 1,75 ≥ 1 → pausa na hora
  a.ponte.fim('cx-1', { texto: 'x', modelo: 'gpt-5.2-codex', tokens: tk(1_000_000) });
  await a.esc.aguardar();
  const det = await detalhe(a, e.id);
  assert.equal(det.execucao.status, 'pausada');
  assert.equal(det.execucao.motivoPausa, 'orcamento-execucao');
  assert.equal(pausado(), true, 'a trava do thread enxerga a pausa');
  assert.ok(a.ponte.de('interromper').some((x) => x[1] === 'cx-1'), 'o thread do Codex foi interrompido pela ponte');
  assert.ok(a.ponte.de('encerrar').some((x) => x[1] === 'cx-1'), 'e encerrado (a pausa de orçamento encerra os membros)');
  assert.ok(a.ctl.de('interromper').some((x) => x[1] === exec.orquestrador));
  assert.ok(a.ctl.de('encerrar').some((x) => x[1] === 'sess-2'), 'o membro do Claude também');
  assert.ok(!a.ctl.de('interromper').some((x) => x[1] === 'cx-1'), 'o controle do Claude nunca recebe o id do Codex');
  lista = (await a.chamar('GET', '/escritorios')).corpo.escritorios[0];
  assert.equal(lista.status, 'pausada');
  assert.equal(lista.motivoPausa, 'orcamento-execucao');
  assert.equal(lista.custo.estimado, true);
  const ev = a.eventos.filter(([t, d]) => t === 'escritorio' && d.id === e.id).pop()[1];
  assert.equal(ev.resumo.motivoPausa, 'orcamento-execucao');
  assert.equal((await a.enviar(e.id, 'redator', exec.orquestrador)).status, 409);

  // liberar tira o motivoPausa do resumo
  const l = await a.chamar('POST', `/escritorios/${e.id}/liberar`, {});
  assert.equal(l.status, 200, JSON.stringify(l.corpo));
  lista = (await a.chamar('GET', '/escritorios')).corpo.escritorios[0];
  assert.equal(lista.motivoPausa, undefined);
});

test('Codex: pausa manual interrompe o thread do Codex (sem encerrar); resumo com motivoPausa "manual"; liberar destrava a trava', async () => {
  const a = ambienteCodex();
  const e = await a.criar({ membros: a.membrosCx });
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  const pausado = a.ponte.de('criar')[0][1].travas.pausado;
  const p = await a.chamar('POST', `/escritorios/${e.id}/pausar`, {});
  assert.equal(p.status, 200, JSON.stringify(p.corpo));
  assert.ok(a.ponte.de('interromper').some((x) => x[1] === 'cx-1'));
  assert.equal(a.ponte.de('encerrar').length, 0, 'pausa manual não encerra membros');
  assert.equal(pausado(), true);
  assert.equal((await a.chamar('GET', '/escritorios')).corpo.escritorios[0].motivoPausa, 'manual');
  await a.chamar('POST', `/escritorios/${e.id}/liberar`, {});
  assert.equal(pausado(), false, 'liberada: a MESMA função de trava volta a dizer que não está pausado');
});

test('Codex: o teto de instâncias vivas conta os membros do Codex junto com os do Claude', async () => {
  const a = ambienteCodex({ deps: { tetoEscritorios: 2 } });
  const e = await a.criar({ membros: [a.membrosCx[0], a.membrosCx[1], { id: 'outro', papel: 'Outro', provedor: 'codex' }] });
  const exec = await a.acionar(e.id); // orquestrador = 1 viva do Claude
  let r = await a.enviar(e.id, 'redator', exec.orquestrador);
  assert.equal(r.status, 200, JSON.stringify(r.corpo)); // 1 do Claude + 0 do Codex antes de criar
  // a 3ª instância (do Claude ou do Codex) bate no teto: 429
  r = await a.enviar(e.id, 'revisor', exec.orquestrador);
  assert.equal(r.status, 429, JSON.stringify(r.corpo));
  assert.match(r.corpo.erro, /2 instâncias vivas \(o teto deles, contando os membros do Codex\)/);
  assert.equal(r.corpo.codigo, 'limite_escritorio');
  r = await a.enviar(e.id, 'outro', exec.orquestrador);
  assert.equal(r.status, 429, 'o 429 propaga: não vira falha da tarefa do membro');
  assert.equal(a.ponte.de('criar').length, 1);
  assert.equal(a.ctl.de('criarInstancia').length, 1);
  // thread do Codex encerrado libera a vaga: o membro é recriado
  await a.ponte.encerrar('cx-1');
  r = await a.enviar(e.id, 'redator', exec.orquestrador);
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.sessao, 'cx-2');
});

test('Codex: reidratação vincula o thread que casa (instruções + travas) e encerra o órfão', async () => {
  const a = ambienteCodex();
  const e = await a.criar({ membros: a.membrosCx });
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  assert.equal(a.ponte.ouvintes.size, 1);
  a.esc.parar();
  assert.equal(a.ponte.ouvintes.size, 0, 'parar solta o ouvirFim da ponte');
  assert.equal(a.ponte.ouvintesUso.size, 0, 'e o ouvirUso');
  // thread de escritório que ninguém reivindica (execução velha) e outro de escritório que não existe mais
  a.ponte.threads.set('cx-9', { b: { escritorio: { id: e.id, execucao: 'exec-velha', papel: 'redator' } }, viva: true, ocupada: false });
  a.ponte.threads.set('cx-8', { b: { escritorio: { id: 'sumiu', execucao: 'x', papel: 'redator' } }, viva: true, ocupada: false });
  a.ponte.chamadas.length = 0;
  a.ctl.ocupadas.add(exec.orquestrador);
  let esperou = 0;
  const b = ambienteCodex({ ponte: a.ponte, deps: { pasta: a.deps.pasta, controle: a.ctl, esperarCodex: async () => { esperou++; } } });
  await b.esc.pronto;
  await b.esc.aguardar();
  assert.equal(esperou, 1, 'espera o módulo do Codex antes de listar os threads');
  assert.equal(a.ponte.ouvintes.size, 1, 'a instância nova assina o ouvirFim (uma vez só)');
  const det = await detalhe(b, e.id);
  assert.equal(det.execucao.status, 'rodando');
  assert.deepEqual(det.execucao.membros, { redator: 'cx-1' });
  // o que casa é vinculado: instruções do membro + travas novas (pausado = função)
  const vs = a.ponte.de('vincular');
  assert.equal(vs.length, 1);
  assert.equal(vs[0][1], 'cx-1');
  assert.match(vs[0][2].instrucoes, /Escreva textos\./);
  assert.match(vs[0][2].instrucoes, new RegExp(`ORBIT_EXECUCAO=${exec.execucao}`));
  assert.match(vs[0][2].instrucoes, /ORBIT_PAPEL=redator/);
  assert.equal(vs[0][2].travas.porta, 47822);
  assert.deepEqual(vs[0][2].travas.extras, []);
  assert.equal(vs[0][2].travas.pausado(), false);
  // os órfãos (e só eles) são interrompidos e encerrados PELA PONTE; nada do Codex vai ao controle do Claude
  assert.deepEqual(a.ponte.de('encerrar').map((x) => x[1]).sort(), ['cx-8', 'cx-9']);
  assert.deepEqual(a.ponte.de('interromper').map((x) => x[1]).sort(), ['cx-8', 'cx-9']);
  assert.equal(a.ponte.threads.get('cx-1').viva, true);
  assert.ok(!a.ctl.de('encerrar').some((x) => /^cx-/.test(x[1])) && !a.ctl.de('interromper').some((x) => /^cx-/.test(x[1])));
  // o fim de turno do thread reassumido volta a ser processado (custo estimado e aviso ao líder)
  a.ponte.fim('cx-1', { texto: 'depois do reinício', modelo: 'gpt-5.2-codex', tokens: tk(1_000_000) });
  await b.esc.aguardar();
  assert.equal((await detalhe(b, e.id)).execucao.custo.execucaoUsd, 1.75);
  assert.ok(a.ctl.de('avisarLider').some((x) => x[2] === 'Membro redator concluiu: depois do reinício'));
  // pausar na instância nova: a trava vinculada enxerga a pausa e o thread é interrompido pela ponte
  const pausado = vs[0][2].travas.pausado;
  await b.chamar('POST', `/escritorios/${e.id}/pausar`, {});
  assert.equal(pausado(), true);
  assert.ok(a.ponte.de('interromper').some((x) => x[1] === 'cx-1'));
  b.esc.parar();
});

test('Codex: reinício com o Codex desligado não trava: a execução é reassumida e o membro não fica "trabalhando" para sempre', async () => {
  const a = ambienteCodex();
  const e = await a.criar({ membros: a.membrosCx });
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  a.esc.parar();
  a.ctl.ocupadas.add(exec.orquestrador);
  const antes = a.ponte.chamadas.length;
  const b = ambienteCodex({ ponte: a.ponte, desligado: true, deps: { pasta: a.deps.pasta, controle: a.ctl } });
  await b.esc.pronto;
  await b.esc.aguardar();
  const det = await detalhe(b, e.id);
  assert.equal(det.execucao.status, 'rodando', 'o líder é do Claude: a execução é reassumida');
  assert.equal(a.ponte.chamadas.length, antes, 'sem ponte nada é chamado nela');
  const ag = (await b.chamar('GET', '/escritorios')).corpo.escritorios[0].agentes.find((x) => x.id === 'redator');
  assert.notEqual(ag.estado, 'trabalhando');
  assert.ok(!a.ctl.chamadas.some((x) => /^cx-/.test(String(x[1]))), 'nada do Codex vai ao controle do Claude');
  b.esc.parar();
});

test('Codex: Codex indisponível no meio da execução → só a tarefa do membro falha, o líder é avisado e o resto segue', async () => {
  const a = ambienteCodex();
  const e = await a.criar({ membros: a.membrosCx });
  const exec = await a.acionar(e.id);
  a.ligado.v = false; // o usuário desliga o Codex depois de acionar
  let r = await a.enviar(e.id, 'redator', exec.orquestrador, 'Escreva');
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.deepEqual(r.corpo, { sessao: null, falhou: true, erro: MSG_CODEX_OFF });
  assert.equal(a.ponte.de('criar').length, 0);
  assert.ok(a.ctl.de('avisarLider').some((x) => x[1] === exec.orquestrador && x[2] === `Membro redator falhou: ${MSG_CODEX_OFF}`));
  const est = (await a.chamar('GET', `/escritorios/${e.id}/membro/redator/estado`)).corpo;
  assert.equal(est.status, 'erro');
  assert.equal(est.sessao, null);
  assert.equal(est.resumo, MSG_CODEX_OFF);
  const ag = (await a.chamar('GET', '/escritorios')).corpo.escritorios[0].agentes;
  assert.equal(ag.find((x) => x.id === 'redator').estado, 'erro');
  let det = await detalhe(a, e.id);
  assert.equal(det.execucao.status, 'rodando', 'a execução não cai');
  assert.deepEqual(det.execucao.membros, {});
  // o membro do Claude continua funcionando
  r = await a.enviar(e.id, 'revisor', exec.orquestrador);
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.sessao, 'sess-2');
  // com o Codex de volta, o mesmo membro nasce normalmente na próxima tarefa
  a.ligado.v = true;
  r = await a.enviar(e.id, 'redator', exec.orquestrador, 'Tente de novo');
  assert.equal(r.corpo.sessao, 'cx-1');
  assert.equal((await a.chamar('GET', `/escritorios/${e.id}/membro/redator/estado`)).corpo.status, 'trabalhando');

  // o criar da ponte quebra, ou a ponte some (codex() = null): a mesma regra
  const b = ambienteCodex();
  const e2 = await b.criar({ membros: b.membrosCx });
  const x2 = await b.acionar(e2.id);
  b.ponte.falharCriar = new Error('codex: executável não encontrado');
  r = await b.enviar(e2.id, 'redator', x2.orquestrador);
  assert.equal(r.status, 200);
  assert.equal(r.corpo.falhou, true);
  assert.match(r.corpo.erro, /executável não encontrado/);
  assert.ok(b.ctl.de('avisarLider').some((x) => /^Membro redator falhou: codex: executável não encontrado/.test(x[2])));
  b.ponte.falharCriar = null;
  b.ligado.ponte = false;
  r = await b.enviar(e2.id, 'redator', x2.orquestrador);
  assert.equal(r.corpo.falhou, true);
  assert.equal(r.corpo.erro, MSG_CODEX_OFF);
  det = await detalhe(b, e2.id);
  assert.equal(det.execucao.status, 'rodando');
});

test('Codex: thread do membro sumiu no meio (enviar na ponte falha) → o membro é recriado', async () => {
  const a = ambienteCodex();
  const e = await a.criar({ membros: a.membrosCx });
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  a.ponte.threads.get('cx-1').viva = false;
  const r = await a.enviar(e.id, 'redator', exec.orquestrador, 'De novo');
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.sessao, 'cx-2');
  assert.ok(a.ponte.de('encerrar').some((x) => x[1] === 'cx-1'));
  assert.equal(a.ponte.de('criar').length, 2);
});

// ───────────────────────── C2: custo/orçamento do Codex (dobro na geração, corte no meio do turno, preço obrigatório) ─────────────────────────

const esperaMs = (ms) => new Promise((r) => setTimeout(r, ms));
const lerEstado = (a, id) => JSON.parse(fs.readFileSync(path.join(a.deps.pasta, `${id}.estado.json`), 'utf8'));

test('C2 P1-2: mudar a geração (resume) ou o preço/modelo não cobra o acumulado do thread de novo; o total cobrado persiste e vale após o reinício', async () => {
  const a = ambienteCodex();
  const e = await a.criar({ membros: a.membrosCx, orcamento: orcGrande });
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  a.ponte.fim('cx-1', { modelo: 'gpt-5.2-codex', geracao: 'g1', tokens: tk(1_000_000, 100_000) });
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.custo.execucaoUsd, 3.15);
  // resume numa geração nova: o Codex semeia o total do rollout → o 1º fim traz 1M+100k de novo (+ um pouco): só o pouco é cobrado
  a.ponte.fim('cx-1', { modelo: 'gpt-5.2-codex', geracao: 'g2', tokens: tk(1_200_000, 100_000) });
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.custo.execucaoUsd, 3.5, '200 mil de entrada novos = 0,35, não 4,2');
  // modelo real mais barato no mesmo total: nada novo
  a.ponte.fim('cx-1', { modelo: 'gpt-5.1-codex-mini', geracao: 'g2', tokens: tk(1_200_000, 100_000) });
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.custo.execucaoUsd, 3.5);
  // o total cobrado fica no estado do escritório
  const gravado = lerEstado(a, e.id);
  assert.equal(gravado.rt.cobrados['cx-1'].entrada, 1_200_000);
  assert.equal(gravado.rt.cobrados['cx-1'].saida, 100_000);
  // reinício do Orbit: a instância nova reidrata a base cobrada; o resume traz o total antigo de novo → nada em dobro
  a.esc.parar();
  a.ctl.ocupadas.add(exec.orquestrador);
  const b = ambienteCodex({ ponte: a.ponte, deps: { pasta: a.deps.pasta, controle: a.ctl } });
  await b.esc.pronto;
  await b.esc.aguardar();
  a.ponte.fim('cx-1', { modelo: 'gpt-5.2-codex', geracao: 'g3', tokens: tk(1_200_000, 100_000) });
  await b.esc.aguardar();
  assert.equal((await detalhe(b, e.id)).execucao.custo.execucaoUsd, 3.5, 'geração nova depois do reinício: base = total já cobrado');
  a.ponte.fim('cx-1', { modelo: 'gpt-5.2-codex', geracao: 'g3', tokens: tk(1_300_000, 100_000) });
  await b.esc.aguardar();
  assert.equal((await detalhe(b, e.id)).execucao.custo.execucaoUsd, 3.675);
  b.esc.parar();
});

test('C2 P1-3: o uso no MEIO do turno soma, avisa e PAUSA na hora (interrompe o Codex), sem esperar o fim do turno', async () => {
  const a = ambienteCodex({ deps: { usoMs: 20 } });
  const e = await a.criar({ membros: a.membrosCx, orcamento: { porExecucaoUsd: 4, porDiaUsd: 100, avisoPct: 80 } });
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  assert.equal(a.ponte.ouvintesUso.size, 1, 'assina o ouvirUso uma vez só');
  // 1M de entrada em gpt-5.2-codex = 1,75 (44%): sem fim de turno, o custo já aparece
  a.ponte.uso('cx-1', tk(1_000_000), { modelo: 'gpt-5.2-codex' });
  await a.esc.aguardar();
  let det = await detalhe(a, e.id);
  assert.equal(det.execucao.custo.execucaoUsd, 1.75);
  assert.equal(det.execucao.custo.estimado, true);
  assert.equal(det.execucao.status, 'rodando');
  assert.equal(a.ponte.de('interromper').length, 0);
  // 80%: aviso ao líder, ainda rodando
  await esperaMs(40);
  a.ponte.uso('cx-1', tk(2_000_000), { modelo: 'gpt-5.2-codex' }); // 3,50 = 87%
  await a.esc.aguardar();
  assert.ok(a.ctl.de('avisarLider').some((x) => /Orçamento em 87%/.test(x[2])), 'aviso de orçamento no meio do turno');
  assert.equal((await detalhe(a, e.id)).execucao.status, 'rodando');
  // estourou: pausa SEM fim de turno; o thread do Codex é interrompido pela ponte
  await esperaMs(40);
  a.ponte.uso('cx-1', tk(2_500_000), { modelo: 'gpt-5.2-codex' }); // 4,375 ≥ 4
  await a.esc.aguardar();
  det = await detalhe(a, e.id);
  assert.equal(det.execucao.status, 'pausada');
  assert.equal(det.execucao.motivoPausa, 'orcamento-execucao');
  assert.ok(a.ponte.de('interromper').some((x) => x[1] === 'cx-1'), 'o Codex foi interrompido no meio do turno');
  // o turno interrompido termina com o mesmo acumulado: não soma de novo
  a.ponte.fim('cx-1', { erro: 'Interrompida', status: 'interrupted', modelo: 'gpt-5.2-codex', tokens: tk(2_500_000) });
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.custo.execucaoUsd, 4.375);
  // uso de thread que não é de membro (ou sem tokens) é ignorado
  a.ponte.uso('cx-99', tk(9_000_000), { modelo: 'gpt-5.2-codex' });
  a.ponte.uso('cx-1', null);
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.custo.execucaoUsd, 4.375);
});

test('C2 P1-3: no máximo uma checagem por janela por thread, e o último uso retido roda no fim da janela (nada se perde)', async () => {
  const a = ambienteCodex({ deps: { usoMs: 150 } });
  const e = await a.criar({ membros: a.membrosCx, orcamento: orcGrande });
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  a.ponte.uso('cx-1', tk(1_000_000), { modelo: 'gpt-5.2-codex' }); // passa na hora
  for (const n of [1_100_000, 1_200_000, 1_300_000, 2_000_000]) a.ponte.uso('cx-1', tk(n), { modelo: 'gpt-5.2-codex' }); // retidos: só o último vale
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.custo.execucaoUsd, 1.75, 'dentro da janela só a 1ª checagem rodou');
  await esperaMs(260);
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.custo.execucaoUsd, 3.5, 'o último uso (2M) foi somado no fim da janela');
});

test('C2: tokenUsage que chega DEPOIS do turn/completed também é contado (o último turno não fica sem custo)', async () => {
  const a = ambienteCodex({ deps: { usoMs: 0 } });
  const e = await a.criar({ membros: a.membrosCx, orcamento: orcGrande });
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  // o fim do turno chega ANTES do uso final (ordem do app-server): o fim traz o que havia
  a.ponte.fim('cx-1', { texto: 'pronto', modelo: 'gpt-5.2-codex', tokens: tk(1_000_000) });
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.custo.execucaoUsd, 1.75);
  a.ponte.uso('cx-1', tk(1_400_000, 40_000), { modelo: 'gpt-5.2-codex' }); // 400 mil de entrada + 40 mil de saída = 0,7 + 0,56
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.custo.execucaoUsd, 3.01);
  // um fim repetido com o mesmo acumulado não cobra de novo
  a.ponte.fim('cx-1', { texto: 'pronto', modelo: 'gpt-5.2-codex', tokens: tk(1_400_000, 40_000) });
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.custo.execucaoUsd, 3.01);
  const gravado = lerEstado(a, e.id);
  assert.equal(gravado.exec.custo.execucaoUsd, 3.01);
  assert.equal(gravado.diaUsd, 3.01);
});

test('C2 P2-5: membro do Codex com modelo sem preço (tabela e precosCodex) → 400 com o nome do modelo; com preço em precosCodex passa', async () => {
  const a = ambienteCodex();
  const e = await a.criar({ membros: a.membrosCx });
  let r = await postEsc(a, e.id, { membros: [{ ...a.membrosCx[0], modelo: 'gpt-novo' }] });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /gpt-novo/);
  assert.match(r.corpo.erro, /precosCodex/);
  assert.equal((await detalhe(a, e.id)).escritorio.membros[0].modelo, 'gpt-5.2-codex', 'recusa não grava nada');
  r = await a.chamar('POST', '/escritorios', a.base({ membros: [{ ...a.membrosCx[0], modelo: 'gpt-novo' }] }));
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /gpt-novo/);
  // sem modelo (padrão do Codex) continua valendo; o modelo normalizado pelo validador é o conferido
  r = await postEsc(a, e.id, { membros: [{ ...a.membrosCx[0], modelo: '', esforco: '' }] });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  r = await postEsc(a, e.id, { membros: [{ ...a.membrosCx[0], modelo: 'normaliza', esforco: 'medium' }] });
  assert.equal(r.status, 200, 'normaliza → gpt-5.2-codex (da tabela)');
  // com preço em precosCodex (função, lida a cada uso) o mesmo modelo passa
  const precos = {};
  const b = ambienteCodex({ deps: { precosCodex: () => precos } });
  const eb = await b.criar({ membros: b.membrosCx });
  r = await postEsc(b, eb.id, { membros: [{ ...b.membrosCx[0], modelo: 'gpt-novo' }] });
  assert.equal(r.status, 400);
  precos['gpt-novo'] = { entrada: 3, cacheEntrada: 0.3, saida: 20 };
  r = await postEsc(b, eb.id, { membros: [{ ...b.membrosCx[0], modelo: 'gpt-novo' }] });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  // e passa a ser cobrado pelo preço informado (não pelo mais alto da tabela)
  const exec = await b.acionar(eb.id);
  await b.enviar(eb.id, 'redator', exec.orquestrador);
  b.ponte.fim('cx-1', { modelo: 'gpt-novo', tokens: tk(1_000_000, 100_000) });
  await b.esc.aguardar();
  const det = await detalhe(b, eb.id);
  assert.equal(det.execucao.custo.execucaoUsd, 5, '3 + 0,1M × 20');
  assert.equal(det.execucao.custo.semPreco, undefined);
  // membro inalterado (renomear/mover) não é barrado de novo, mesmo que o preço tenha sumido
  delete precos['gpt-novo'];
  r = await postEsc(b, eb.id, { nome: 'Outro nome' });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
});

// ───────────────────────── C3: ciclo de vida do membro do Codex ─────────────────────────

const rapido = { codexMs: 15, semTurnoMs: 60 };
const estadoMembro = async (a, id, membro) => (await a.chamar('GET', `/escritorios/${id}/membro/${membro}/estado`)).corpo;
const avisos = (a, re) => a.ctl.de('avisarLider').filter((x) => re.test(x[2]));

test('C3 P1-4: a Acao do envio que falha depois de aceito derruba o membro (erro + aviso ao líder) e a execução ainda termina', async () => {
  const a = ambienteCodex({ deps: rapido });
  const e = await a.criar({ membros: a.membrosCx });
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  a.ponte.fim('cx-1', { texto: 'primeira', modelo: 'gpt-5.2-codex', tokens: tk(1000) });
  await a.esc.aguardar();
  // o thread é reaproveitado, mas o app-server aceita a mensagem e a Acao falha depois
  const acao = { estado: 'em_andamento' };
  a.ponte.enviar = (id, t) => { a.ponte.chamadas.push(['enviar', id, t]); return acao; };
  const r = await a.enviar(e.id, 'redator', exec.orquestrador, 'Segunda tarefa');
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.sessao, 'cx-1', 'reaproveitou o thread');
  a.ponte.threads.get('cx-1').ocupada = false;
  assert.equal((await estadoMembro(a, e.id, 'redator')).status, 'trabalhando');
  await esperaMs(40); // Acao ainda em andamento: nada acontece
  assert.equal((await estadoMembro(a, e.id, 'redator')).status, 'trabalhando');
  acao.estado = 'erro';
  acao.erro = 'sandbox recusou';
  await esperaMs(80);
  await a.esc.aguardar();
  const est = await estadoMembro(a, e.id, 'redator');
  assert.equal(est.status, 'erro');
  assert.match(est.resumo, /^O Codex recusou a mensagem: sandbox recusou/);
  assert.equal(avisos(a, /^Membro redator falhou: O Codex recusou a mensagem/).length, 1, 'o líder é avisado uma vez');
  assert.equal(a.ponte.de('interromper').filter((x) => x[1] === 'cx-1').length, 1, 'o turno que sobrou é cortado');
  assert.equal((await detalhe(a, e.id)).execucao.status, 'rodando');
  // o líder acorda com o aviso e fecha a volta: a execução termina
  a.ctl.resultado(exec.orquestrador, { texto: 'fechei' });
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.status, 'concluida');
  assert.equal(avisos(a, /^Membro redator falhou/).length, 1, 'sem aviso repetido');
});

test('C3 P1-4: membro "trabalhando" sem turno aberto no Codex por semTurnoMs vira erro; com turno aberto ou dentro do prazo, não', async () => {
  const a = ambienteCodex({ deps: rapido });
  const e = await a.criar({ membros: a.membrosCx });
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  await esperaMs(150); // turno aberto (ocupada): o prazo nem começa a contar
  assert.equal((await estadoMembro(a, e.id, 'redator')).status, 'trabalhando');
  assert.equal(avisos(a, /falhou/).length, 0);
  a.ponte.threads.get('cx-1').ocupada = false; // o turno sumiu sem fim
  await esperaMs(25);
  assert.equal((await estadoMembro(a, e.id, 'redator')).status, 'trabalhando', 'ainda dentro do prazo');
  await esperaMs(200);
  await a.esc.aguardar();
  const est = await estadoMembro(a, e.id, 'redator');
  assert.equal(est.status, 'erro');
  assert.match(est.resumo, /parou sem concluir a volta/);
  assert.equal(avisos(a, /^Membro redator falhou: O Codex parou sem concluir/).length, 1);
  assert.ok(a.ponte.de('interromper').some((x) => x[1] === 'cx-1'));
});

test('C3 P1-4: Codex desligado no meio da volta → o membro vira erro, o líder é avisado e a execução continua e termina', async () => {
  const a = ambienteCodex({ deps: rapido });
  const e = await a.criar({ membros: a.membrosCx });
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  a.ligado.ponte = false;
  a.ligado.v = false;
  await esperaMs(100);
  await a.esc.aguardar();
  const est = await estadoMembro(a, e.id, 'redator');
  assert.equal(est.status, 'erro');
  assert.match(est.resumo, /desligado/);
  assert.equal(avisos(a, /^Membro redator falhou: .*desligado/).length, 1);
  assert.equal((await detalhe(a, e.id)).execucao.status, 'rodando');
  a.ctl.resultado(exec.orquestrador, { texto: 'fechei' });
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.status, 'concluida');
  assert.equal(avisos(a, /falhou/).length, 1);
});

test('C3 P1-6/P2-4: o teto só conta thread do Codex com turno ou pedido aberto; reaproveitar thread ocioso também ocupa vaga (429 sem encerrar)', async () => {
  const a = ambienteCodex({ deps: { tetoEscritorios: 2 } });
  const e = await a.criar({ membros: [a.membrosCx[0], a.membrosCx[1], { id: 'outro', papel: 'Outro', provedor: 'codex' }] });
  const exec = await a.acionar(e.id); // 1 viva do Claude
  let r = await a.enviar(e.id, 'redator', exec.orquestrador);
  assert.equal(r.status, 200, JSON.stringify(r.corpo)); // cx-1 ocupado: 2 de 2
  r = await a.enviar(e.id, 'outro', exec.orquestrador);
  assert.equal(r.status, 429, 'líder + redator ocupado = teto');
  // o redator termina o turno: o thread fica ocioso e libera a vaga
  a.ponte.fim('cx-1', { texto: 'ok', modelo: 'gpt-5.2-codex', tokens: tk(1000) });
  await a.esc.aguardar();
  r = await a.enviar(e.id, 'outro', exec.orquestrador);
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.sessao, 'cx-2');
  assert.equal(a.ponte.threads.get('cx-1').viva, true, 'o ocioso segue vivo (só não ocupa vaga)');
  // reaproveitar o cx-1 ocioso precisa de vaga: líder + cx-2 ocupado = teto → 429 e o thread NÃO é encerrado
  r = await a.enviar(e.id, 'redator', exec.orquestrador, 'De novo');
  assert.equal(r.status, 429, JSON.stringify(r.corpo));
  assert.equal(a.ponte.de('encerrar').length, 0);
  assert.equal(a.ponte.threads.get('cx-1').viva, true);
  assert.equal(a.ponte.de('enviar').length, 0, 'a mensagem nem foi enviada');
  // pedido de aprovação aberto (sem turno) também ocupa a vaga do cx-2
  a.ponte.threads.get('cx-2').ocupada = false;
  let permissao = true;
  const estadoOrig = a.ponte.estado.bind(a.ponte);
  a.ponte.estado = (id) => { const s = estadoOrig(id); return s && id === 'cx-2' && permissao ? { ...s, permissao: true } : s; };
  r = await a.enviar(e.id, 'redator', exec.orquestrador, 'De novo');
  assert.equal(r.status, 429, 'permissão aberta conta como vaga');
  permissao = false;
  r = await a.enviar(e.id, 'redator', exec.orquestrador, 'De novo');
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.sessao, 'cx-1', 'reaproveitou o thread ocioso');
  assert.equal(a.ponte.de('enviar').length, 1);
});

test('C3 P2-4: duas criações simultâneas de thread do Codex não passam juntas pelo teto; a vaga reservada é solta se a criação falha', async () => {
  const a = ambienteCodex({ deps: { tetoEscritorios: 3 } });
  const e1 = await a.criar({ membros: a.membrosCx });
  const e2 = await a.criar({ membros: a.membrosCx });
  const x1 = await a.acionar(e1.id);
  const x2 = await a.acionar(e2.id); // 2 vivas do Claude: sobra 1 vaga
  const criarOrig = a.ponte.criar.bind(a.ponte);
  a.ponte.criar = async (b) => { await esperaMs(50); return criarOrig(b); };
  const rs = await Promise.all([a.enviar(e1.id, 'redator', x1.orquestrador), a.enviar(e2.id, 'redator', x2.orquestrador)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 429], JSON.stringify(rs.map((r) => r.corpo)));
  assert.equal(a.ponte.de('criar').length, 1);
  const perdedor = rs[0].status === 429 ? [e1, x1] : [e2, x2];
  // a criação do vencedor acabou e o turno terminou: a vaga volta
  a.ponte.fim('cx-1', { texto: 'ok', modelo: 'gpt-5.2-codex', tokens: tk(1000) });
  await a.esc.aguardar();
  // criação que falha solta a vaga que reservou
  a.ponte.falharCriar = new Error('app-server caiu');
  let r = await a.enviar(perdedor[0].id, 'redator', perdedor[1].orquestrador);
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.falhou, true);
  a.ponte.falharCriar = null;
  r = await a.enviar(perdedor[0].id, 'redator', perdedor[1].orquestrador);
  assert.equal(r.status, 200, 'sem vaga vazada, o perdedor consegue');
  assert.ok(r.corpo.sessao);
});

test('C3 P2-1: ponte que aparece depois da reidratação → vincula só o thread reivindicado, encerra o órfão e o de escritório apagado, uma vez só', async () => {
  const a = ambienteCodex({ deps: rapido });
  const e = await a.criar({ membros: a.membrosCx });
  const e2 = await a.criar({ nome: 'Outro', membros: a.membrosCx });
  const x = await a.acionar(e.id);
  const x2 = await a.acionar(e2.id);
  await a.enviar(e.id, 'redator', x.orquestrador); // cx-1
  await a.enviar(e2.id, 'redator', x2.orquestrador); // cx-2
  assert.deepEqual([...a.ponte.threads.keys()], ['cx-1', 'cx-2']);
  a.esc.parar();
  fs.rmSync(path.join(a.deps.pasta, `${e2.id}.json`)); // escritório apagado com o Orbit fora
  a.ponte.threads.set('cx-9', { b: { escritorio: { id: e.id, execucao: 'exec-velha', papel: 'redator' } }, viva: true, ocupada: false });
  a.ponte.chamadas.length = 0;
  a.ctl.ocupadas.add(x.orquestrador);
  a.ctl.ocupadas.add(x2.orquestrador);
  const b = ambienteCodex({ ponte: a.ponte, desligado: true, deps: { ...rapido, pasta: a.deps.pasta, controle: a.ctl } });
  await b.esc.pronto;
  await b.esc.aguardar();
  assert.equal(a.ponte.chamadas.length, 0, 'sem ponte nada é chamado nela');
  assert.equal((await detalhe(b, e.id)).execucao.status, 'rodando');
  // a ponte aparece (o Codex foi ligado depois): a vigia reconcilia
  b.ligado.v = true;
  b.ligado.ponte = true;
  await esperaMs(80);
  await b.esc.aguardar();
  const vs = a.ponte.de('vincular');
  assert.deepEqual(vs.map((v) => v[1]), ['cx-1'], 'só o thread que a execução reivindica é vinculado');
  assert.match(vs[0][2].instrucoes, /ORBIT_PAPEL=redator/);
  assert.equal(typeof vs[0][2].travas.pausado, 'function');
  assert.equal(vs[0][2].travas.pausado(), false);
  assert.deepEqual(a.ponte.de('encerrar').map((v) => v[1]).sort(), ['cx-2', 'cx-9']);
  assert.equal(a.ponte.threads.get('cx-1').viva, true);
  await b.chamar('POST', `/escritorios/${e.id}/pausar`, {});
  assert.equal(vs[0][2].travas.pausado(), true, 'a trava vinculada tardiamente enxerga a pausa');
  assert.ok(a.ponte.de('interromper').some((v) => v[1] === 'cx-1'));
  // não repete a reconciliação
  await esperaMs(80);
  assert.equal(a.ponte.de('vincular').length, 1);
  assert.equal(a.ponte.de('encerrar').length, 2);
  b.esc.parar();
});

for (const desligado of [false, true]) {
  test(`C3 P2-2: reinício com turno do Codex no meio (${desligado ? 'Codex desligado' : 'Codex ligado'}) → membro em erro + aviso ao líder, execução reassumida`, async () => {
    const a = ambienteCodex({ deps: rapido });
    const e = await a.criar({ membros: a.membrosCx });
    const exec = await a.acionar(e.id);
    await a.enviar(e.id, 'redator', exec.orquestrador);
    a.esc.parar();
    a.ponte.threads.get('cx-1').ocupada = false; // o turno do Codex morreu com o Orbit
    a.ctl.ocupadas.add(exec.orquestrador);
    const b = ambienteCodex({ ponte: a.ponte, desligado, deps: { ...rapido, pasta: a.deps.pasta, controle: a.ctl } });
    await b.esc.pronto;
    await b.esc.aguardar();
    const est = await estadoMembro(b, e.id, 'redator');
    assert.equal(est.status, 'erro');
    assert.match(est.resumo, /reinício do Orbit/);
    assert.equal(avisos(a, /^Membro redator falhou: Interrompido pelo reinício do Orbit/).length, 1);
    assert.equal((await detalhe(b, e.id)).execucao.status, 'rodando');
    await esperaMs(100); // a vigia não o repete nem o derruba de novo
    assert.equal(avisos(a, /falhou/).length, 1);
    b.esc.parar();
  });
}

test('C3 P2-11: custo estimado do Codex separa execução e dia (estimadoExecucao / estimadoDia); estimado = OU', async () => {
  const a = ambienteCodex();
  const e = await a.criar({ membros: a.membrosCx, orcamento: orcGrande });
  const exec = await a.acionar(e.id);
  await a.enviar(e.id, 'redator', exec.orquestrador);
  const custoResumo = async () => (await a.chamar('GET', '/escritorios')).corpo.escritorios[0].custo;
  assert.equal((await detalhe(a, e.id)).execucao.custo.estimado, undefined);
  for (const c of [await custoResumo()]) {
    assert.equal(c.estimado, undefined);
    assert.equal(c.estimadoExecucao, undefined);
    assert.equal(c.estimadoDia, undefined);
  }
  a.ponte.fim('cx-1', { texto: 'ok', modelo: 'gpt-5.2-codex', tokens: tk(1_000_000) });
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.custo.estimado, true);
  for (const c of [await custoResumo()]) {
    assert.equal(c.execucaoUsd, 1.75);
    assert.equal(c.estimadoExecucao, true);
    assert.equal(c.estimadoDia, true);
    assert.equal(c.estimado, true);
  }
  // fecha a execução e aciona de novo: a execução nova não tem Codex, mas o dia ainda tem
  a.ctl.resultado(exec.orquestrador, { texto: 'fechei' });
  await a.esc.aguardar();
  assert.equal((await detalhe(a, e.id)).execucao.status, 'concluida');
  await a.acionar(e.id, 'Outra campanha');
  assert.equal((await detalhe(a, e.id)).execucao.custo.estimado, undefined);
  for (const c of [await custoResumo()]) {
    assert.equal(c.estimadoExecucao, undefined, 'a execução nova ainda não gastou no Codex');
    assert.equal(c.estimadoDia, true, 'o dia carrega a parcela estimada da execução anterior');
    assert.equal(c.estimado, true);
    assert.equal(c.diaUsd, 1.75);
  }
});

test('C3: o resumo traz `criado` (GET e SSE) e `motivoPausa` quando pausada', async () => {
  const a = ambiente();
  const e = await a.criar();
  const ultimoSse = () => a.eventos.filter(([t, d]) => t === 'escritorio' && d.id === e.id && d.resumo).at(-1)?.[1].resumo;
  const exec = await a.acionar(e.id);
  let r = (await a.chamar('GET', '/escritorios')).corpo.escritorios[0];
  assert.equal(r.criado, e.criado);
  assert.equal(r.motivoPausa, undefined, 'só aparece quando pausada');
  assert.equal(ultimoSse().criado, e.criado);
  assert.equal(ultimoSse().motivoPausa, undefined);
  assert.equal((await a.chamar('POST', `/escritorios/${e.id}/pausar`, {})).status, 200);
  r = (await a.chamar('GET', '/escritorios')).corpo.escritorios[0];
  assert.equal(r.status, 'pausada');
  assert.equal(r.motivoPausa, 'manual');
  assert.equal(ultimoSse().status, 'pausada');
  assert.equal(ultimoSse().motivoPausa, 'manual');
  assert.equal(ultimoSse().criado, e.criado);
  await a.chamar('POST', `/escritorios/${e.id}/liberar`, {});
  assert.equal((await a.chamar('GET', '/escritorios')).corpo.escritorios[0].motivoPausa, undefined);
  assert.ok(exec.execucao);
});
