// Testes da ponte do Codex para escritórios (B1a): criarCodex(deps).ponte, IN-PROCESS (sem servidor HTTP, sem porta).
// Rodar:  node --test testes/codex-escritorio.test.mjs
// CODEX_HOME e dados em pasta temporária (apagada no fim, nunca ~/.codex), Codex FALSO (ORBIT_CODEX_EXE). Nunca o codex real.
// O que o falso registra em CODEX_HOME/falso-log.jsonl (approvalPolicy, sandbox, sandboxPolicy, developerInstructions, config,
// disabledPluginIds) prova o que o Orbit ENVIOU; o efeito real no Codex (MCP/plugins desligados etc.) não é testado aqui.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FALSO = path.join(RAIZ, 'testes', 'codex-falso.mjs');
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let TMP, HOME, PASTA, ARQ_ESC, criarCodex;
const motores = new Set();
const ENV_ANTES = {};
const ESC = { id: 'esc-1', execucao: 'exec-1', papel: 'dev' };
const CONFIG_TOML = [
  '[mcp_servers.node_repl]', 'command = "node"', '',
  '[mcp_servers."pixel-lab"]', 'command = "x"', '',
  '[plugins."github@openai-curated"]', 'enabled = true', '',
].join('\n');

before(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-codex-esc-'));
  HOME = path.join(TMP, 'codex-home');
  PASTA = path.join(TMP, 'projeto');
  ARQ_ESC = path.join(TMP, 'dados', 'codex-escritorio.json');
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(PASTA, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.toml'), CONFIG_TOML);
  for (const [k, v] of Object.entries({ CODEX_HOME: HOME, ORBIT_CODEX_EXE: FALSO, CODEX_FALSO_ATRASO_MS: '2', ORBIT_CODEX_INTERVALO_MS: '60000', GERENCIADOR_DADOS: path.join(TMP, 'dados') })) {
    ENV_ANTES[k] = process.env[k];
    process.env[k] = v;
  }
  ({ criarCodex } = await import('../codex.mjs'));
});

after(async () => {
  for (const m of [...motores]) { try { await m.codex.parar(); } catch {} }
  for (const [k, v] of Object.entries(ENV_ANTES)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// Motor novo (deps falsos como as do servidor). `sessoes` pode ser reaproveitado para simular o mesmo servidor.
function novoMotor() {
  const sessoes = new Map();
  const deps = {
    config: () => ({ ativo: true }),
    log: () => {},
    sessaoCodex: (id, campos) => { sessoes.set(id, { ...(sessoes.get(id) || {}), id, provedor: 'codex', ...campos }); },
    sessao: (id) => sessoes.get(id),
    difundir: () => {}, difundirSessao: () => {}, removerSessao: (id) => { sessoes.delete(id); },
    responder: (res, codigo, corpo) => { res.status = codigo; res.corpo = corpo; },
    lerJSONCorpo: async (req) => req.corpo,
    arquivoEscritorio: ARQ_ESC,
  };
  const codex = criarCodex(deps);
  const fins = [];
  const off = codex.ponte.ouvirFim((e) => fins.push(e));
  const m = { codex, ponte: codex.ponte, fins, off, sessoes };
  motores.add(m);
  return m;
}
async function pararMotor(m) { try { m.off(); } catch {} try { await m.codex.parar(); } catch {} motores.delete(m); }

async function esperarQue(cond, ms = 10000, rotulo = 'condição') {
  const fim = Date.now() + ms;
  let ultimo;
  while (Date.now() < fim) { ultimo = await cond(); if (ultimo) return ultimo; await espera(20); }
  throw new Error(`${rotulo} não aconteceu em ${ms} ms (último: ${JSON.stringify(ultimo)})`);
}
const fimN = (m, sessao, n) => esperarQue(() => { const l = m.fins.filter((e) => e.sessao === sessao); return l.length >= n ? l : null; }, 10000, `fim #${n} de ${sessao}`);
const permissaoDe = (m, sessao) => esperarQue(() => m.ponte.estado(sessao)?.permissao, 10000, 'pedido de permissão');
function post(m, sessao, rota, corpo) {
  const res = {};
  return m.codex.rota({ method: 'POST', corpo }, res, `/codex/sessao/${encodeURIComponent(sessao)}/${rota}`).then(() => res);
}

function lerLog() {
  try { return fs.readFileSync(path.join(HOME, 'falso-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
const recebidos = (method) => lerLog().filter((l) => l.dir === 'recebido' && l.method === method);
const respostasCliente = (method) => lerLog().filter((l) => l.dir === 'resposta-do-cliente' && l.method === method);
function limparLog() { try { fs.rmSync(path.join(HOME, 'falso-log.jsonl'), { force: true }); } catch {} }

const criarEsc = (m, extra = {}) => m.ponte.criar({ pasta: PASTA, nome: 'Dev', escritorio: ESC, instrucoes: 'Você é o dev do escritório.', ...extra });

test('thread/start e turn/start de escritório: untrusted, sandbox sem rede, instruções, MCP/plugins desligados', async () => {
  limparLog();
  const m = novoMotor();
  try {
    const { sessao, acao } = await criarEsc(m, { texto: 'faça algo' });
    assert.equal(acao.tipo, 'criar');
    const [fim] = await fimN(m, sessao, 1);
    const ts = recebidos('thread/start');
    assert.equal(ts.length, 1);
    assert.equal(ts[0].approvalPolicy, 'untrusted');
    assert.equal(ts[0].sandbox, 'workspace-write');
    assert.equal(ts[0].developerInstructions, 'Você é o dev do escritório.');
    const cfg = ts[0].config;
    assert.deepEqual(cfg.mcp_servers, { node_repl: { enabled: false }, 'pixel-lab': { enabled: false } });
    assert.deepEqual(cfg.plugins, { 'github@openai-curated': { enabled: false } });
    assert.deepEqual(cfg.apps, { _default: { enabled: false } });
    assert.equal(cfg.web_search, 'disabled');
    assert.deepEqual(cfg.sandbox_workspace_write, { network_access: false });
    const tu = recebidos('turn/start');
    assert.equal(tu.length, 1);
    assert.equal(tu[0].approvalPolicy, 'untrusted');
    assert.deepEqual(tu[0].sandboxPolicy, { type: 'workspaceWrite', networkAccess: false });
    assert.deepEqual(tu[0].disabledPluginIds, ['github@openai-curated']);
    // ouvirFim
    assert.equal(fim.status, 'completed');
    assert.equal(fim.erro, null);
    assert.equal(fim.texto, 'Feito (resposta do Codex falso).');
    assert.deepEqual(fim.escritorio, ESC);
    assert.ok(fim.geracao && fim.modelo);
    assert.ok(fim.tokens && fim.tokens.total > 0 && fim.tokens.entrada > 0 && fim.tokens.saida > 0, JSON.stringify(fim.tokens));
    // vínculo persistido, sem função
    const arq = JSON.parse(fs.readFileSync(ARQ_ESC, 'utf8'));
    assert.equal(arq.threads[sessao].escritorio.id, 'esc-1');
    assert.equal(arq.threads[sessao].instrucoes, 'Você é o dev do escritório.');
    assert.ok(!('pausado' in arq.threads[sessao].travas));
    assert.deepEqual(m.ponte.listarEscritorio(), [{ id: sessao, escritorio: ESC, processo: 'vivo' }]);
    const e = m.ponte.estado(sessao);
    assert.equal(e.modo, 'orbit');
    assert.deepEqual(e.escritorio, ESC);
    assert.equal(e.ultimaResposta, 'Feito (resposta do Codex falso).');
    assert.equal(e.status, 'concluida');
    assert.ok(e.tokens.total > 0);
    await m.ponte.encerrar(sessao);
  } finally { await pararMotor(m); }
});

test('ouvirFim: tokens são o acumulado do thread (crescem a cada turno) e há 1 evento por turno', async () => {
  const m = novoMotor();
  try {
    const { sessao } = await criarEsc(m, { texto: 'um' });
    const [f1] = await fimN(m, sessao, 1);
    const acao = m.ponte.enviar(sessao, 'dois');
    assert.equal(acao.tipo, 'mensagem');
    const [, f2] = await fimN(m, sessao, 2);
    assert.ok(f2.tokens.total > f1.tokens.total, `${f1.tokens.total} -> ${f2.tokens.total}`);
    assert.ok(f2.tokens.entrada > f1.tokens.entrada);
    assert.equal(f1.geracao, f2.geracao);
    // off() para de receber
    const outros = [];
    const off = m.ponte.ouvirFim((e) => outros.push(e));
    off();
    m.ponte.enviar(sessao, 'tres');
    await fimN(m, sessao, 3);
    assert.equal(outros.length, 0);
    assert.throws(() => m.ponte.ouvirFim('x'), TypeError);
    await m.ponte.encerrar(sessao);
  } finally { await pararMotor(m); }
});

test('Codex comum (sem escritorio) fica inalterado: on-request, sem config, item/tool/call e elicitação seguem -32601', async () => {
  limparLog();
  const m = novoMotor();
  try {
    const { sessao } = await m.ponte.criar({ pasta: PASTA, nome: 'Comum', texto: 'oi' });
    const [f0] = await fimN(m, sessao, 1);
    assert.equal(f0.escritorio, undefined);
    const ts = recebidos('thread/start')[0];
    assert.equal(ts.approvalPolicy, 'on-request');
    assert.equal(ts.sandbox, 'workspace-write');
    for (const k of ['config', 'developerInstructions', 'disabledPluginIds', 'sandboxPolicy']) assert.equal(ts[k], undefined, k);
    const tu = recebidos('turn/start')[0];
    for (const k of ['approvalPolicy', 'sandboxPolicy', 'disabledPluginIds']) assert.equal(tu[k], undefined, k);
    m.ponte.enviar(sessao, '[proibido] x');
    const [, f1] = await fimN(m, sessao, 2);
    assert.match(f1.texto, /recusado \(-32601\)/);
    m.ponte.enviar(sessao, '[elicitacao] x');
    const [, , f2] = await fimN(m, sessao, 3);
    assert.match(f2.texto, /"error":-32601/);
    assert.deepEqual(m.ponte.listarEscritorio(), []);
    assert.equal(fs.existsSync(ARQ_ESC) ? Object.keys(JSON.parse(fs.readFileSync(ARQ_ESC, 'utf8')).threads).includes(sessao) : false, false);
    await m.ponte.encerrar(sessao);
  } finally { await pararMotor(m); }
});

test('ação externa ([push]): só "permitir uma vez"; sugestão recusada com codigo externa; sem sugestões no estado', async () => {
  const m = novoMotor();
  try {
    const { sessao } = await criarEsc(m, { texto: '[push] subir' });
    const p = await permissaoDe(m, sessao);
    assert.equal(p.externa, true);
    assert.match(p.motivo, /^Ação externa: /);
    assert.equal(p.sugestoes, undefined);
    assert.equal(m.ponte.estado(sessao).status, 'aguardando');
    // sugestão em externa: 400 e o pedido continua
    const r1 = await post(m, sessao, 'permissao', { id: p.id, decisao: 'permitir', sugestao: 0 });
    assert.equal(r1.status, 400);
    assert.equal(r1.corpo.codigo, 'externa');
    assert.equal(m.ponte.estado(sessao).permissao?.id, p.id);
    // permitir uma vez
    const r2 = await post(m, sessao, 'permissao', { id: p.id, decisao: 'permitir' });
    assert.equal(r2.status, 200);
    const [f] = await fimN(m, sessao, 1);
    assert.equal(f.texto, 'Comando executado.');
    assert.deepEqual(respostasCliente('item/commandExecution/requestApproval')[0].result, { decision: 'accept' });
    // negar a externa
    m.ponte.enviar(sessao, '[push] de novo');
    const p2 = await permissaoDe(m, sessao);
    assert.equal(p2.externa, true);
    assert.equal((await post(m, sessao, 'permissao', { id: p2.id, decisao: 'negar' })).status, 200);
    const [, f2] = await fimN(m, sessao, 2);
    assert.equal(f2.texto, 'Comando recusado.');
    await m.ponte.encerrar(sessao);
  } finally { await pararMotor(m); }
});

test('comando comum de escritório ([comando]) não é externo: tem sugestão e aceita acceptForSession', async () => {
  limparLog();
  const m = novoMotor();
  try {
    const { sessao } = await criarEsc(m, { texto: '[comando] ok' });
    const p = await permissaoDe(m, sessao);
    assert.ok(!p.externa);
    assert.ok(Array.isArray(p.sugestoes) && p.sugestoes.length > 0, JSON.stringify(p));
    assert.equal((await post(m, sessao, 'permissao', { id: p.id, decisao: 'permitir', sugestao: 0 })).status, 200);
    const [f] = await fimN(m, sessao, 1);
    assert.equal(f.texto, 'Comando executado.');
    assert.equal(respostasCliente('item/commandExecution/requestApproval')[0].result.decision, 'acceptForSession');
    await m.ponte.encerrar(sessao);
  } finally { await pararMotor(m); }
});

test('escritório pausado nega tudo sem esperar; travas.pausado que falha nega (falha fechada); despausar volta a perguntar', async () => {
  limparLog();
  const m = novoMotor();
  let pausado = true;
  try {
    const { sessao } = await criarEsc(m, { travas: { pausado: () => pausado } });
    m.ponte.enviar(sessao, '[comando] pausado');
    const [f] = await fimN(m, sessao, 1);
    assert.equal(f.texto, 'Comando recusado.');
    assert.equal(m.ponte.estado(sessao).permissao, null);
    assert.deepEqual(respostasCliente('item/commandExecution/requestApproval')[0].result, { decision: 'decline' });
    // função que lança = pausado
    m.ponte.vincular(sessao, { travas: { pausado: () => { throw new Error('boom'); } } });
    m.ponte.enviar(sessao, '[push] pausado');
    const [, f2] = await fimN(m, sessao, 2);
    assert.equal(f2.texto, 'Comando recusado.');
    // despausado
    pausado = false;
    m.ponte.vincular(sessao, { travas: { pausado: () => pausado } });
    m.ponte.enviar(sessao, '[comando] solto');
    const p = await permissaoDe(m, sessao);
    assert.ok(p.id);
    await post(m, sessao, 'permissao', { id: p.id, decisao: 'negar' });
    await fimN(m, sessao, 3);
    await m.ponte.encerrar(sessao);
  } finally { await pararMotor(m); }
});

test('item/tool/call e mcpServer/elicitation/request em escritório: recusa válida (success:false / decline), sem erro -32601', async () => {
  const m = novoMotor();
  try {
    const { sessao } = await criarEsc(m);
    m.ponte.enviar(sessao, '[proibido] ferramenta');
    const [f1] = await fimN(m, sessao, 1);
    assert.equal(f1.texto, 'Pedido fora da lista recusado (success:false).');
    const r = respostasCliente('item/tool/call')[0].result;
    assert.equal(r.success, false);
    assert.equal(r.contentItems[0].type, 'inputText');
    m.ponte.enviar(sessao, '[elicitacao] mcp');
    const [, f2] = await fimN(m, sessao, 2);
    assert.equal(f2.texto, 'Elicitação: {"action":"decline"}');
    assert.deepEqual(respostasCliente('mcpServer/elicitation/request')[0].result, { action: 'decline' });
    assert.equal(m.ponte.estado(sessao).permissao, null);
    await m.ponte.encerrar(sessao);
  } finally { await pararMotor(m); }
});

test('interromper cancela o turno ([demorar]); fim com status interrupted e erro "Interrompida"; sem turno devolve false', async () => {
  const m = novoMotor();
  try {
    const { sessao } = await criarEsc(m);
    m.ponte.enviar(sessao, '[demorar] muito');
    await esperarQue(() => m.ponte.estado(sessao)?.ocupada && m.ponte.estado(sessao).status === 'trabalhando', 10000, 'trabalhando');
    assert.equal(await m.ponte.interromper(sessao), true);
    const [f] = await fimN(m, sessao, 1);
    assert.equal(f.status, 'interrupted');
    assert.equal(f.erro, 'Interrompida');
    assert.equal(await m.ponte.interromper(sessao), false);
    await m.ponte.encerrar(sessao);
  } finally { await pararMotor(m); }
});

test('reinício: novo motor lista o thread dormindo; vincular devolve travas/instruções; enviar faz thread/resume com instruções e override; encerrar limpa o vínculo', async () => {
  limparLog();
  const a = novoMotor();
  const { sessao } = await criarEsc(a, { texto: 'primeiro', travas: { extras: ['rm -rf'], porta: 47822, raiz: PASTA } });
  const [fa] = await fimN(a, sessao, 1);
  await pararMotor(a); // o servidor reinicia: sem processo do Codex
  assert.equal(JSON.parse(fs.readFileSync(ARQ_ESC, 'utf8')).threads[sessao].travas.porta, 47822);
  limparLog();
  const b = novoMotor();
  try {
    assert.deepEqual(b.ponte.listarEscritorio(), [{ id: sessao, escritorio: ESC, processo: 'dormindo' }]);
    assert.equal(b.ponte.estado(sessao).processo, 'dormindo');
    assert.equal(b.ponte.vincular(sessao, { instrucoes: 'Instruções novas.', travas: { pausado: () => false } }), true);
    assert.throws(() => b.ponte.vincular('nao-existe', {}), (e) => e.status === 404);
    b.ponte.enviar(sessao, 'depois do reinício');
    const [fb] = await fimN(b, sessao, 1);
    assert.equal(fb.texto, 'Feito (resposta do Codex falso).');
    assert.notEqual(fb.geracao, fa.geracao, 'geração nova depois do reinício');
    assert.deepEqual(fb.escritorio, ESC);
    const rs = recebidos('thread/resume');
    assert.equal(rs.length, 1);
    assert.equal(rs[0].approvalPolicy, 'untrusted');
    assert.equal(rs[0].sandbox, 'workspace-write');
    assert.equal(rs[0].developerInstructions, 'Instruções novas.');
    assert.deepEqual(rs[0].config.mcp_servers, { node_repl: { enabled: false }, 'pixel-lab': { enabled: false } });
    assert.equal(rs[0].config.web_search, 'disabled');
    const tu = recebidos('turn/start')[0];
    assert.equal(tu.approvalPolicy, 'untrusted');
    assert.deepEqual(tu.sandboxPolicy, { type: 'workspaceWrite', networkAccess: false });
    assert.equal(b.ponte.listarEscritorio()[0].processo, 'vivo');
    // a trava vinculada vale (pausado: false, mas porta/extras persistidos foram trocados pelas novas: sem extras)
    await b.ponte.encerrar(sessao);
    assert.deepEqual(b.ponte.listarEscritorio(), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(ARQ_ESC, 'utf8')).threads, {});
    assert.equal(b.ponte.estado(sessao), null);
    assert.throws(() => b.ponte.enviar(sessao, 'x'), (e) => e.status === 404);
  } finally { await pararMotor(b); }
});

test('C3 P2-1: vínculo carregado do disco e ainda não religado (sem vincular) = pausado (falha fechada); vincular libera', async () => {
  limparLog();
  const a = novoMotor();
  const { sessao } = await criarEsc(a, { texto: 'primeiro', travas: { porta: 47822, raiz: PASTA } });
  await fimN(a, sessao, 1);
  await pararMotor(a);
  const b = novoMotor();
  try {
    b.ponte.enviar(sessao, '[comando] sem vinculo');
    const [f] = await fimN(b, sessao, 1);
    assert.equal(f.texto, 'Comando recusado.', 'sem vincular, o thread carregado do disco nega tudo');
    assert.equal(b.ponte.estado(sessao).permissao, null);
    assert.deepEqual(respostasCliente('item/commandExecution/requestApproval')[0].result, { decision: 'decline' });
    b.ponte.vincular(sessao, { travas: { pausado: () => false } });
    b.ponte.enviar(sessao, '[comando] solto');
    const p = await permissaoDe(b, sessao);
    assert.ok(p.id, 'depois de vincular volta a perguntar');
    await post(b, sessao, 'permissao', { id: p.id, decisao: 'negar' });
    await fimN(b, sessao, 2);
    await b.ponte.encerrar(sessao);
  } finally { await pararMotor(b); }
});

test('validações da ponte.criar: instrucoes/travas sem escritorio, escritorio inválido, pasta inexistente, sessão alheia', async () => {
  const m = novoMotor();
  try {
    const rejeita = (b, status) => assert.rejects(m.ponte.criar(b), (e) => e.status === status, JSON.stringify(Object.keys(b)));
    await rejeita({ pasta: PASTA, instrucoes: 'x' }, 400);
    await rejeita({ pasta: PASTA, travas: {} }, 400);
    await rejeita({ pasta: PASTA, escritorio: 'x' }, 400);
    await rejeita({ pasta: PASTA, escritorio: { id: 'a', execucao: 'b' } }, 400);
    await rejeita({ pasta: PASTA, escritorio: ESC, travas: { porta: 70000 } }, 400);
    await rejeita({ pasta: PASTA, escritorio: ESC, travas: { pausado: 'sim' } }, 400);
    await rejeita({ pasta: PASTA, escritorio: ESC, instrucoes: 5 }, 400);
    await rejeita({ pasta: path.join(PASTA, 'nao-existe'), escritorio: ESC }, 400);
    assert.deepEqual(m.ponte.listarEscritorio(), []);
    assert.equal(m.ponte.estado('qualquer'), null);
    assert.throws(() => m.ponte.enviar('qualquer', 'x'), (e) => e.status === 404);
    await assert.rejects(m.ponte.interromper('qualquer'), (e) => e.status === 404);
    // prioridade inválida
    const { sessao } = await criarEsc(m);
    assert.throws(() => m.ponte.enviar(sessao, 'x', 'agora'), (e) => e.status === 400);
    await m.ponte.encerrar(sessao);
  } finally { await pararMotor(m); }
});

test('ouvirUso (C2): cada thread/tokenUsage/updated de thread de escritório chega com o acumulado do thread; Codex comum não; off() solta', async () => {
  const m = novoMotor();
  try {
    const usos = [];
    const off = m.ponte.ouvirUso((e) => usos.push(e));
    const outros = [];
    const off2 = m.ponte.ouvirUso((e) => outros.push(e));
    off2();
    assert.throws(() => m.ponte.ouvirUso('x'), TypeError);
    // thread comum: não avisa ninguém (o uso é só dos escritórios)
    const comum = await m.ponte.criar({ pasta: PASTA, nome: 'Comum', texto: 'oi' });
    await esperarQue(() => m.fins.some((f) => f.sessao === comum.sessao), 10000, 'fim do thread comum');
    assert.equal(usos.length, 0);
    const { sessao } = await criarEsc(m, { texto: 'um' });
    await fimN(m, sessao, 1);
    assert.ok(usos.length >= 1, 'o uso do turno chegou');
    const u1 = usos[usos.length - 1];
    assert.equal(u1.sessao, sessao);
    assert.ok(u1.tokens.total > 0 && u1.tokens.entrada > 0);
    assert.ok(u1.geracao);
    assert.ok(u1.escritorio && u1.escritorio.id);
    const n1 = usos.length;
    m.ponte.enviar(sessao, 'dois');
    await fimN(m, sessao, 2);
    assert.ok(usos.length > n1);
    assert.ok(usos[usos.length - 1].tokens.total > u1.tokens.total, 'acumulado do thread cresce');
    assert.equal(outros.length, 0, 'ouvinte solto não recebe');
    off();
    const n2 = usos.length;
    m.ponte.enviar(sessao, 'tres');
    await fimN(m, sessao, 3);
    assert.equal(usos.length, n2);
    await m.ponte.encerrar(sessao);
    await m.ponte.encerrar(comum.sessao);
  } finally { await pararMotor(m); }
});

// ───────── C1: segurança do membro Codex (falha fechada, TOML real, ações em .codex/CODEX_HOME/.git, pausa) ─────────
// Ambiente por teste: troca o config.toml do CODEX_HOME e o falso-config.json (config efetiva + MCP "do Codex real"), cria
// arquivos extras e restaura tudo no fim (o CONFIG_TOML padrão vale para os testes antigos).
function ambiente({ toml, falso, arquivos = {} } = {}) {
  const criados = [];
  const cfgToml = path.join(HOME, 'config.toml');
  const cfgFalso = path.join(HOME, 'falso-config.json');
  if (toml !== undefined) fs.writeFileSync(cfgToml, toml);
  if (falso !== undefined) fs.writeFileSync(cfgFalso, JSON.stringify(falso));
  for (const [arq, txt] of Object.entries(arquivos)) { fs.mkdirSync(path.dirname(arq), { recursive: true }); fs.writeFileSync(arq, txt); criados.push(arq); }
  limparLog();
  return () => {
    fs.writeFileSync(cfgToml, CONFIG_TOML);
    try { fs.rmSync(cfgFalso, { force: true }); } catch {}
    for (const a of criados) { try { fs.rmSync(a, { force: true }); } catch {} }
  };
}
const rejeitaCom = (p, status, codigo) => assert.rejects(p, (e) => e.status === status && e.codigo === codigo, `esperava ${status} ${codigo}`);

test('C1: MCP em tabela inline, chave pontilhada e profile (config.toml do CODEX_HOME) vão todos desligados no override', async () => {
  const fim = ambiente({
    toml: ['mcp_servers.dot.command = "y"', '', '[mcp_servers]', 'gh = { command = "x", args = ["a", "b"] }', '', '[profiles.p.mcp_servers.pf]', 'command = "z"', ''].join('\n'),
    falso: { servidores: ['gh', 'dot', 'pf'] },
  });
  const m = novoMotor();
  try {
    const { sessao } = await criarEsc(m, { texto: 'oi' });
    await fimN(m, sessao, 1);
    const cfg = recebidos('thread/start')[0].config;
    assert.deepEqual(cfg.mcp_servers, { gh: { enabled: false }, dot: { enabled: false }, pf: { enabled: false } });
    assert.ok(!('notify' in cfg), 'sem notify na config, sem override de notify');
    assert.ok(recebidos('mcpServerStatus/list').length >= 1);
    await m.ponte.encerrar(sessao);
  } finally { await pararMotor(m); fim(); }
});

test('C1: `.codex/config.toml` de pasta-mãe (até a raiz com .git) entra no override; sem .git acima só vale a própria pasta', async () => {
  const REPO = path.join(TMP, 'repo');
  const SUB = path.join(REPO, 'sub');
  const SOLTO = path.join(TMP, 'solto');
  const fim = ambiente({
    falso: { servidores: ['mae', 'avo'] },
    arquivos: {
      [path.join(REPO, '.git', 'HEAD')]: 'ref: refs/heads/main\n',
      [path.join(REPO, '.codex', 'config.toml')]: '[mcp_servers.mae]\ncommand = "m"\n',
      [path.join(SUB, 'x.txt')]: 'x',
      // fora do repositório: o .codex da pasta-mãe de uma pasta sem .git NÃO é lido
      [path.join(SOLTO, 'filha', 'x.txt')]: 'x',
      [path.join(SOLTO, '.codex', 'config.toml')]: '[mcp_servers.avo]\ncommand = "a"\n',
    },
  });
  const m = novoMotor();
  try {
    // "avo" só existe no falso (a pasta-mãe sem .git não é lida) → aqui "mae" entra no override e "avo" fica ativo → recusa
    await rejeitaCom(criarEsc(m, { pasta: SUB, texto: 'oi' }), 409, 'mcp_ativo');
    const cfg = recebidos('thread/start')[0].config;
    assert.deepEqual(cfg.mcp_servers.mae, { enabled: false });
    assert.ok(!cfg.mcp_servers.avo, 'a pasta-mãe sem .git não foi lida');
    // sem "avo" no falso, só "mae": aceito
    fs.writeFileSync(path.join(HOME, 'falso-config.json'), JSON.stringify({ servidores: ['mae'] }));
    const { sessao } = await criarEsc(m, { pasta: SUB, texto: 'oi' });
    await fimN(m, sessao, 1);
    await m.ponte.encerrar(sessao);
  } finally { await pararMotor(m); fim(); try { fs.rmSync(REPO, { recursive: true, force: true }); fs.rmSync(SOLTO, { recursive: true, force: true }); } catch {} }
});

test('C1: MCP que o Codex mantém ativo no thread (fora do TOML e da config efetiva) = criar recusa 409 mcp_ativo e descarrega o thread', async () => {
  const fim = ambiente({ falso: { servidores: ['node_repl', 'fantasma'] } });
  const m = novoMotor();
  try {
    await rejeitaCom(criarEsc(m, { texto: 'oi' }), 409, 'mcp_ativo');
    assert.equal(recebidos('thread/unsubscribe').length, 1, 'thread descarregado');
    assert.equal(recebidos('turn/start').length, 0, 'nenhum turno rodou');
    assert.deepEqual(m.ponte.listarEscritorio(), [], 'nada vinculado');
  } finally { await pararMotor(m); fim(); }
});

test('C1: verificação indisponível = recusado (mcpServerStatus/list falha, config/read falha, TOML inválido no CODEX_HOME e no projeto)', async () => {
  const m = novoMotor();
  try {
    let fim = ambiente({ falso: { falharStatus: true } });
    await rejeitaCom(criarEsc(m, { texto: 'oi' }), 409, 'verificacao_indisponivel');
    assert.equal(recebidos('thread/unsubscribe').length, 1);
    fim();
    fim = ambiente({ falso: { falharConfig: true } });
    await rejeitaCom(criarEsc(m, { texto: 'oi' }), 409, 'verificacao_indisponivel');
    assert.equal(recebidos('thread/start').length, 0, 'nem chegou a abrir o thread');
    fim();
    fim = ambiente({ toml: '[mcp_servers.x\ncommand = ' });
    await rejeitaCom(criarEsc(m, { texto: 'oi' }), 409, 'verificacao_indisponivel');
    assert.equal(recebidos('thread/start').length, 0);
    fim();
    fim = ambiente({ arquivos: { [path.join(PASTA, '.codex', 'config.toml')]: 'isto = não é toml [' } });
    await rejeitaCom(criarEsc(m, { texto: 'oi' }), 409, 'verificacao_indisponivel');
    fim();
    assert.deepEqual(m.ponte.listarEscritorio(), []);
  } finally { await pararMotor(m); }
});

test('C1: notify no config.toml do CODEX_HOME (ou na config efetiva) NÃO recusa: vai o override notify=[]', async () => {
  const fim = ambiente({ toml: 'notify = ["codex-computer-use.exe", "turn-ended"]\n\n' + CONFIG_TOML });
  const m = novoMotor();
  try {
    const { sessao } = await criarEsc(m, { texto: 'oi' });
    await fimN(m, sessao, 1);
    assert.deepEqual(recebidos('thread/start')[0].config.notify, []);
    await m.ponte.encerrar(sessao);
  } finally { await pararMotor(m); fim(); }
  // só a config efetiva (managed/requirements) com notify: também aceito, com override
  const fim2 = ambiente({ falso: { efetivo: { notify: ['x'] } } });
  const m2 = novoMotor();
  try {
    const { sessao } = await criarEsc(m2, { texto: 'oi' });
    await fimN(m2, sessao, 1);
    assert.deepEqual(recebidos('thread/start')[0].config.notify, []);
    await m2.ponte.encerrar(sessao);
  } finally { await pararMotor(m2); fim2(); }
});

test('C1: notify em `.codex/config.toml` da pasta do escritório, de pasta-mãe ou em profile de lá = recusado (notify_ativo)', async () => {
  const REPO = path.join(TMP, 'repo2');
  const SUB = path.join(REPO, 'sub');
  const m = novoMotor();
  try {
    let fim = ambiente({ arquivos: { [path.join(PASTA, '.codex', 'config.toml')]: 'notify = ["rodar-isto"]\n' } });
    await rejeitaCom(criarEsc(m, { texto: 'oi' }), 409, 'notify_ativo');
    assert.equal(recebidos('thread/start').length, 0);
    fim();
    fim = ambiente({ arquivos: { [path.join(PASTA, '.codex', 'config.toml')]: '[profiles.p]\nnotify = ["rodar-isto"]\n' } });
    await rejeitaCom(criarEsc(m, { texto: 'oi' }), 409, 'notify_ativo');
    fim();
    fim = ambiente({ arquivos: {
      [path.join(REPO, '.git', 'HEAD')]: 'ref: refs/heads/main\n',
      [path.join(REPO, '.codex', 'config.toml')]: 'notify = ["rodar-isto"]\n',
      [path.join(SUB, 'x.txt')]: 'x',
    } });
    await rejeitaCom(criarEsc(m, { pasta: SUB, texto: 'oi' }), 409, 'notify_ativo');
    fim();
    // notify vazio no projeto não incomoda
    fim = ambiente({ arquivos: { [path.join(PASTA, '.codex', 'config.toml')]: 'notify = []\n' } });
    const { sessao } = await criarEsc(m, { texto: 'oi' });
    await fimN(m, sessao, 1);
    await m.ponte.encerrar(sessao);
    fim();
  } finally { await pararMotor(m); try { fs.rmSync(REPO, { recursive: true, force: true }); } catch {} }
});

test('C1: resume (thread dormindo) com MCP ativo = a mensagem falha, o thread é descarregado e continua dormindo', async () => {
  const a = novoMotor();
  const { sessao } = await criarEsc(a, { texto: 'primeiro' });
  await fimN(a, sessao, 1);
  await pararMotor(a);
  const fim = ambiente({ falso: { servidores: ['node_repl', 'surgiu'] } });
  const b = novoMotor();
  try {
    const acao = b.ponte.enviar(sessao, 'depois do reinício');
    await esperarQue(() => acao.estado === 'erro', 10000, 'Acao com erro');
    assert.match(acao.erro, /surgiu/);
    assert.equal(recebidos('thread/unsubscribe').length, 1);
    assert.equal(recebidos('turn/start').length, 0);
    assert.equal(b.ponte.listarEscritorio()[0].processo, 'dormindo');
    // corrigido o ambiente, o mesmo thread volta a funcionar
    fs.writeFileSync(path.join(HOME, 'falso-config.json'), JSON.stringify({ servidores: ['node_repl'] }));
    b.ponte.enviar(sessao, 'de novo');
    const [f] = await fimN(b, sessao, 1);
    assert.equal(f.status, 'completed');
    await b.ponte.encerrar(sessao);
  } finally { await pararMotor(b); fim(); }
});

test('C1: FileChange em `.codex/`, `.git/`, CODEX_HOME ou fora do cwd = ação externa (sem sugestões); arquivo comum não', async () => {
  const fim = ambiente();
  const m = novoMotor();
  try {
    const { sessao } = await criarEsc(m, { texto: 'oi' });
    await fimN(m, sessao, 1);
    const alvos = ['.codex/config.toml', '.codex/hooks.json', '.git/config', '../fora.txt', path.join(HOME, 'config.toml'), path.join(HOME, 'hooks.json')];
    let n = 1;
    for (const alvo of alvos) {
      m.ponte.enviar(sessao, `[arquivo-em:${alvo}] mexer`);
      const p = await permissaoDe(m, sessao);
      assert.equal(p.externa, true, `${alvo} deveria ser externa: ${JSON.stringify(p)}`);
      assert.equal(p.sugestoes, undefined, alvo);
      const r = await post(m, sessao, 'permissao', { id: p.id, decisao: 'permitir', sugestao: 0 });
      assert.equal(r.status, 400, alvo);
      assert.equal(r.corpo.codigo, 'externa');
      assert.equal((await post(m, sessao, 'permissao', { id: p.id, decisao: 'negar' })).status, 200);
      await fimN(m, sessao, ++n);
    }
    // arquivo comum dentro do cwd: pergunta normal, não externa
    m.ponte.enviar(sessao, '[arquivo-em:ok.txt] gravar');
    const p = await permissaoDe(m, sessao);
    assert.ok(!p.externa, JSON.stringify(p));
    await post(m, sessao, 'permissao', { id: p.id, decisao: 'negar' });
    await fimN(m, sessao, ++n);
    await m.ponte.encerrar(sessao);
  } finally { await pararMotor(m); fim(); }
});

test('C1: permissão respondida depois que o escritório foi pausado = negada (409 pausado) e a decisão chega ao Codex como decline', async () => {
  const fim = ambiente();
  const m = novoMotor();
  let pausado = false;
  try {
    const { sessao } = await criarEsc(m, { travas: { pausado: () => pausado } });
    m.ponte.enviar(sessao, '[comando] vai pedir');
    const p = await permissaoDe(m, sessao);
    assert.ok(p.id);
    pausado = true; // o pedido já estava aberto quando a pausa começou
    const r = await post(m, sessao, 'permissao', { id: p.id, decisao: 'permitir' });
    assert.equal(r.status, 409);
    assert.equal(r.corpo.codigo, 'pausado');
    const [f] = await fimN(m, sessao, 1);
    assert.equal(f.texto, 'Comando recusado.');
    assert.deepEqual(respostasCliente('item/commandExecution/requestApproval')[0].result, { decision: 'decline' });
    assert.equal(m.ponte.estado(sessao).permissao, null);
    await m.ponte.encerrar(sessao);
  } finally { await pararMotor(m); fim(); }
});

test('C1: helpers puros: nomesDoToml (inline, pontilhada, profile), lerToml com erro, notifyAtivo, arquivoSensivel', async () => {
  const { nomesDoToml, notifyAtivo, arquivoSensivel, lerToml } = await import('../codex-instancias.mjs');
  const n = nomesDoToml(['notify = ["a"]', 'mcp_servers.a.command = "x"', '[mcp_servers]', 'b = { command = "y" }', '[plugins."c@d"]', 'enabled = true', '[profiles.p.mcp_servers.e]', 'command = "z"'].join('\n'));
  assert.deepEqual([...n.mcp].sort(), ['a', 'b', 'e']);
  assert.deepEqual(n.plugins, ['c@d']);
  assert.equal(n.notify, true);
  assert.equal(nomesDoToml('notify = []\n').notify, false);
  assert.equal(nomesDoToml('[profiles.p]\nnotify = ["x"]\n').notify, true);
  assert.throws(() => lerToml('a = '));
  assert.throws(() => lerToml('[x\n'));
  assert.equal(notifyAtivo([]), false);
  assert.equal(notifyAtivo(['x']), true);
  assert.equal(notifyAtivo(undefined), false);
  const ctx = { cwd: path.join(TMP, 'p'), home: path.join(TMP, 'h') };
  assert.ok(arquivoSensivel(path.join(ctx.cwd, '.codex', 'config.toml'), ctx));
  assert.ok(arquivoSensivel(path.join(ctx.cwd, 'sub', '.git', 'config'), ctx));
  assert.ok(arquivoSensivel(path.join(ctx.home, 'config.toml'), ctx));
  assert.ok(arquivoSensivel(path.join(TMP, 'fora.txt'), ctx));
  assert.ok(!arquivoSensivel(path.join(ctx.cwd, 'src', 'a.js'), ctx));
});
