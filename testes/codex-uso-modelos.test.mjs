// Testes da etapa 4 do Codex no servidor: modelos/esforço (model/list), compactar (thread/compact/start), janela de contexto e
// uso do plano (account/rateLimits/read + rollouts) com SSE `usoCodex`.
// Rodar:  node --test testes/codex-uso-modelos.test.mjs
// Servidor real em porta de escolherPorta (47822–47826, nunca a 47821), GERENCIADOR_DADOS e CODEX_HOME temporários
// (apagados no fim) e o Codex FALSO (ORBIT_CODEX_EXE=testes/codex-falso.mjs). Nunca o codex real, nunca ~/.codex.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escolherPorta, desligarSeMeu } from './porta-livre.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FALSO = path.join(RAIZ, 'testes', 'codex-falso.mjs');
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let PORTA, TMP, DADOS, HOME, TRABALHO, PASTA, QUEBRADO;
let filho = null;
let sse = null;
const eventos = []; // SSE global { tipo, dados }
const respostas = []; // texto de TODA resposta HTTP/SSE (para provar que nenhum e-mail vaza)
const pids = new Set();

function pedir(metodo, rota, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
    const headers = { 'x-gerenciador': '1' };
    if (dados !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(dados); }
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers, timeout: 10000 }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const t = Buffer.concat(partes).toString('utf8');
        respostas.push(t);
        let json = null; try { json = JSON.parse(t); } catch {}
        resolve({ status: res.statusCode, json, texto: t });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (dados !== undefined) req.write(dados);
    req.end();
  });
}
const get = (r) => pedir('GET', r);
const post = (r, c) => pedir('POST', r, c ?? {});

function abrirSSE(rota, lista) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: rota, headers: { accept: 'text/event-stream' } }, (res) => {
      res.setEncoding('utf8');
      let resto = '';
      res.on('data', (c) => {
        resto += c;
        let i;
        while ((i = resto.indexOf('\n\n')) >= 0) {
          const bloco = resto.slice(0, i); resto = resto.slice(i + 2);
          const tipo = /^event: (.*)$/m.exec(bloco)?.[1];
          const data = bloco.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (!tipo) continue;
          respostas.push(data);
          let dados = null; try { dados = JSON.parse(data); } catch {}
          lista.push({ tipo, dados });
        }
      });
      resolve({ req, status: res.statusCode });
    });
    req.on('error', reject);
  });
}
async function esperarEm(lista, pred, ms = 8000, desde = 0) {
  const t0 = Date.now();
  for (;;) {
    const e = lista.slice(desde).find(pred);
    if (e) return e;
    if (Date.now() - t0 > ms) throw new Error('tempo esgotado esperando o evento SSE');
    await espera(40);
  }
}
const esperarEvento = (pred, ms, desde) => esperarEm(eventos, pred, ms, desde);
const acaoEv = (id, pred = () => true) => (e) => e.tipo === 'acao' && e.dados?.id === id && pred(e.dados);
const usoEv = (pred = () => true) => (e) => e.tipo === 'usoCodex' && pred(e.dados);
const sessaoDe = async (id) => (await get('/estado')).json.sessoes.find((x) => x.id === id);
async function esperarSessao(id, pred, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const s = await sessaoDe(id);
    if (s && pred(s)) return s;
    if (Date.now() - t0 > ms) throw new Error(`tempo esgotado esperando a sessão ${id}: ${JSON.stringify(s && { status: s.status, contexto: s.contexto, controle: s.controle })}`);
    await espera(60);
  }
}

async function subir(extraEnv = {}) {
  const env = {
    ...process.env,
    GERENCIADOR_PORTA: String(PORTA),
    GERENCIADOR_DADOS: DADOS,
    GERENCIADOR_SESSOES_DIR: path.join(TMP, 'sessoes'),
    ORBIT_PROJETOS_DIR: path.join(TMP, 'projetos'),
    CODEX_HOME: HOME,
    ORBIT_CODEX_EXE: FALSO,
    CODEX_FALSO_ATRASO_MS: '30',
    ORBIT_CODEX_INTERVALO_MS: '150',
    GERENCIADOR_TICK_MS: '300',
    ORBIT_MOTOR: '0',
    ...(process.platform === 'win32' ? {} : { HOME: path.join(TMP, 'home') }),
    ...extraEnv,
  };
  delete env.CLAUDE_CODE_HOST_SESSION_ID;
  filho = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env, stdio: process.env.ORBIT_TESTE_LOG ? ['ignore', fs.openSync(process.env.ORBIT_TESTE_LOG, 'a'), fs.openSync(process.env.ORBIT_TESTE_LOG, 'a')] : 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (filho.exitCode != null) throw new Error(`o servidor do teste saiu (código ${filho.exitCode})`);
    try { const r = await get('/saude'); if (r.json?.pid === filho.pid) return; } catch {}
    await espera(100);
  }
  throw new Error('servidor não subiu');
}
async function descer() {
  try { sse?.destroy(); } catch {}
  const p = filho;
  if (!p) return;
  filho = null;
  if (p.exitCode != null) return;
  const saiu = new Promise((r) => p.once('exit', r));
  await desligarSeMeu(PORTA, p.pid);
  await Promise.race([saiu, espera(4000)]);
  if (p.exitCode == null) { try { p.kill(); } catch {} await Promise.race([saiu, espera(3000)]); }
}

function vivoPid(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function morreu(pid, ms = 4000) {
  const t0 = Date.now();
  while (vivoPid(pid)) { if (Date.now() - t0 > ms) return false; await espera(50); }
  return true;
}
function logFalso() {
  try { return fs.readFileSync(path.join(HOME, 'falso-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
const recebidos = (metodo) => logFalso().filter((l) => l.dir === 'recebido' && l.method === metodo);

// rollout escrito à mão (o monitor só lê): com rate_limits
const p2 = (n) => String(n).padStart(2, '0');
let ordinal = 0;
const lin = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), ordinal: ordinal++, type, payload }) + '\n';
function escreverRollout(id) {
  const d = new Date();
  const dir = path.join(HOME, 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const t = Math.floor(Date.now() / 1000);
  const tok = { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 5010 };
  fs.writeFileSync(path.join(dir, `rollout-${d.toISOString().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`),
    lin('session_meta', { id, cwd: PASTA, originator: 'codex_cli_rs', cli_version: '0.163.0', source: 'cli' }) +
    lin('turn_context', { turn_id: 't1', cwd: PASTA, approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' }, model: 'gpt-5-codex', effort: 'medium' }) +
    lin('event_msg', { type: 'task_started', turn_id: 't1', model_context_window: 258400 }) +
    lin('event_msg', { type: 'token_count', info: { total_token_usage: tok, last_token_usage: tok, model_context_window: 258400 },
      rate_limits: { primary: { used_percent: 41, window_minutes: 300, resets_at: t + 7200 }, secondary: { used_percent: 17, window_minutes: 10080, resets_at: t + 200000 }, plan_type: 'pro' } }) +
    lin('event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: 'ok', duration_ms: 10 }));
}

before(async () => {
  PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47822);
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-codex-usomod-'));
  DADOS = path.join(TMP, 'dados');
  HOME = path.join(TMP, 'codex-home');
  TRABALHO = path.join(TMP, 'trabalho');
  PASTA = path.join(TRABALHO, 'proj-u');
  QUEBRADO = path.join(TMP, 'codex-quebrado.mjs');
  for (const d of [DADOS, HOME, TRABALHO, path.join(TMP, 'sessoes'), path.join(TMP, 'projetos'), PASTA]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(QUEBRADO, 'process.exit(1);\n');
});
after(async () => {
  await descer();
  for (const pid of pids) { try { process.kill(pid); } catch {} }
  fs.rmSync(TMP, { recursive: true, force: true });
});

let ID;
const ID_ROLLOUT = crypto.randomUUID();

test('chave desligada: /codex/modelos, /codex/uso e as rotas novas são 404', async () => {
  escreverRollout(ID_ROLLOUT);
  await subir();
  assert.equal((await get('/codex/modelos')).status, 404);
  assert.equal((await get('/codex/uso')).status, 404);
  assert.equal((await post('/codex/uso/atualizar')).status, 404);
  assert.equal((await post('/codex/sessao/x/compactar')).status, 404);
  sse = (await abrirSSE('/fluxo', eventos)).req;
  await esperarEvento((e) => e.tipo === 'inicio');
  assert.ok(!eventos.some((e) => e.tipo === 'usoCodex'));
});

test('uso sem processo: vem do último rate_limits do rollout (fonte rollout) e sai no SSE usoCodex', async () => {
  const desde = eventos.length;
  assert.equal((await post('/config', { codex: { ativo: true } })).status, 200);
  const e = await esperarEvento(usoEv(), 8000, desde);
  const u = (await get('/codex/uso')).json;
  assert.deepEqual(e.dados, u);
  assert.equal(u.fonte, 'rollout');
  assert.equal(u.cincoHoras.pct, 41);
  assert.equal(u.semanal.pct, 17);
  assert.equal(u.plano, 'pro');
  assert.ok(u.cincoHoras.renova > Date.now() && u.cincoHoras.renova < Date.now() + 8000 * 1000, 'renova em ms');
  assert.ok(u.semanal.renova > u.cincoHoras.renova);
  assert.ok(Number.isFinite(u.atualizado));
  assert.equal(recebidos('account/rateLimits/read').length, 0, 'não subiu o app-server só para ler o uso');
  assert.equal((await post('/codex/uso')).status, 405);
  assert.equal((await get('/codex/uso/atualizar')).status, 405);
});

test('GET /codex/modelos: formato do /modelos do Claude, cache de 6 h (um model/list só)', async () => {
  const r = await get('/codex/modelos');
  assert.equal(r.status, 200);
  assert.ok(Number.isFinite(r.json.atualizado));
  assert.deepEqual(r.json.modelos.map((m) => m.valor), ['gpt-5-codex', 'gpt-5', 'gpt-5-mini']);
  for (const m of r.json.modelos) {
    assert.deepEqual(Object.keys(m).slice(0, 5), ['valor', 'modelo', 'nome', 'descricao', 'esforcos']);
    assert.equal(typeof m.nome, 'string');
    assert.ok(Array.isArray(m.esforcos) && m.esforcos.length);
  }
  const g5 = r.json.modelos.find((m) => m.valor === 'gpt-5');
  assert.deepEqual(g5.esforcos, ['minimal', 'low', 'medium', 'high']);
  assert.equal(g5.nome, 'GPT-5');
  assert.equal((await get('/codex/modelos')).json.atualizado, r.json.atualizado);
  assert.equal(recebidos('model/list').length, 1);
  assert.equal((await post('/codex/modelos')).status, 405);
});

test('criar com modelo/esforço: inválidos dão 400 (nada vai ao Codex), válidos chegam no thread/start e no turn/start', async () => {
  const antes = recebidos('thread/start').length;
  for (const c of [{ modelo: 'gpt-9' }, { modelo: 'gpt-5-mini', esforco: 'high' }, { modelo: 'gpt-5-codex', esforco: 'minimal' }, { esforco: 'xhigh' }, { modelo: 7 }, { esforco: 'baixo demais' }]) {
    const r = await post('/codex/instancias', { pasta: PASTA, ...c });
    assert.equal(r.status, 400, JSON.stringify(c));
    assert.ok(r.json.erro);
  }
  assert.equal(recebidos('thread/start').length, antes, 'inválidos não criam thread');

  const r = await post('/codex/instancias', { pasta: PASTA, nome: 'Uso', modelo: 'gpt-5-mini', esforco: 'low', texto: 'Diga olá' });
  assert.equal(r.status, 202);
  ID = r.json.sessao;
  assert.equal(recebidos('thread/start').at(-1).model, 'gpt-5-mini');
  const s = await esperarSessao(ID, (x) => x.status === 'concluida' && x.contexto?.tokens > 0);
  assert.equal(s.controle.modelo, 'gpt-5-mini');
  assert.equal(s.controle.esforco, 'low');
  const t1 = recebidos('turn/start').at(-1);
  assert.equal(t1.model, 'gpt-5-mini');
  assert.equal(t1.effort, 'low');
  assert.ok(s.controle.pid);
  pids.add(s.controle.pid);
});

test('janela de contexto: vem do modelContextWindow do tokenUsage (pct = tokens/janela)', async () => {
  const s = await sessaoDe(ID);
  assert.equal(s.contexto.janela, 258400);
  assert.ok(s.contexto.tokens > 0);
  assert.equal(s.contexto.pct, Math.min(100, Math.round((s.contexto.tokens / 258400) * 100)));
});

test('trocar modelo/esforço: Acao conclui na hora; o próximo turn/start leva os valores novos', async () => {
  const antes = recebidos('turn/start').length;
  let r = await post(`/codex/sessao/${ID}/modelo`, { modelo: 'gpt-5' });
  assert.equal(r.status, 202);
  assert.equal(r.json.acao.tipo, 'modelo');
  assert.equal(r.json.acao.estado, 'sucesso');
  assert.equal(r.json.acao.resultado.modelo, 'gpt-5');
  assert.match(r.json.acao.resultado.nota, /próximo turno/);
  assert.equal(recebidos('turn/start').length, antes, 'trocar não inicia turno');
  assert.equal((await sessaoDe(ID)).controle.modelo, 'gpt-5');

  r = await post(`/codex/sessao/${ID}/esforco`, { esforco: 'minimal' });
  assert.equal(r.status, 202);
  assert.equal(r.json.acao.estado, 'sucesso');
  assert.equal(r.json.acao.resultado.esforco, 'minimal');
  assert.equal((await sessaoDe(ID)).controle.esforco, 'minimal');

  // inválidos
  assert.equal((await post(`/codex/sessao/${ID}/modelo`, { modelo: 'gpt-9' })).status, 400);
  assert.equal((await post(`/codex/sessao/${ID}/modelo`, {})).status, 400);
  assert.equal((await post(`/codex/sessao/${ID}/esforco`, { esforco: 'xhigh' })).status, 400);
  assert.equal((await post(`/codex/sessao/${ID}/esforco`, {})).status, 400);
  assert.equal((await get(`/codex/sessao/${ID}/modelo`)).status, 405);
  assert.equal((await post('/codex/sessao/inexistente/modelo', { modelo: 'gpt-5' })).status, 404);
  assert.equal((await sessaoDe(ID)).controle.modelo, 'gpt-5', 'inválido não mexe no que valia');

  const ms = await post(`/codex/sessao/${ID}/mensagem`, { texto: 'Mais uma' });
  assert.equal(ms.status, 202);
  await esperarSessao(ID, (x) => x.status === 'concluida' && x.controle?.ocupada === false && recebidos('turn/start').length === antes + 1);
  const t = recebidos('turn/start').at(-1);
  assert.equal(t.model, 'gpt-5');
  assert.equal(t.effort, 'minimal');
  const j = await esperarSessao(ID, (x) => x.contexto?.tokens > 0);
  assert.equal(j.contexto.janela, 258400);

  // modelo novo sem o esforço atual: volta ao padrão do modelo (esforço vazio)
  r = await post(`/codex/sessao/${ID}/modelo`, { modelo: 'gpt-5-codex' });
  assert.equal(r.status, 202);
  assert.equal(r.json.acao.resultado.esforco, '');
  assert.equal((await sessaoDe(ID)).controle.modelo, 'gpt-5-codex');
});

test('compactar: Acao sucesso em thread/compacted, os tokens do contexto caem, foco é ignorado e avisado', async () => {
  const antes = (await sessaoDe(ID)).contexto.tokens;
  assert.ok(antes > 0);
  const desde = eventos.length;
  const r = await post(`/codex/sessao/${ID}/compactar`, { foco: 'só o essencial' });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(r.json.acao.tipo, 'compactar');
  const aid = r.json.acao.id;
  const ini = await esperarEvento(acaoEv(aid, (a) => /foco/.test(a.etapa || '')), 8000, desde);
  assert.match(ini.dados.etapa, /foco/);
  const fim = await esperarEvento(acaoEv(aid, (a) => a.estado === 'sucesso'), 8000, desde);
  assert.equal(fim.dados.resultado.foco, 'ignorado');
  assert.equal(fim.dados.resultado.pre, antes);
  const s = await esperarSessao(ID, (x) => x.contexto?.tokens < antes && x.status === 'concluida');
  assert.equal(s.contexto.janela, 258400);
  assert.equal(s.contexto.tokens, 0);
  assert.equal(recebidos('thread/compact/start').length, 1);
  assert.ok(!(await get(`/codex/sessao/${ID}/acoes`)).json.some((a) => a.estado === 'erro'));
  // validações
  assert.equal((await post(`/codex/sessao/${ID}/compactar`, { foco: 5 })).status, 400);
  assert.equal((await get(`/codex/sessao/${ID}/compactar`)).status, 405);
  assert.equal((await post('/codex/sessao/inexistente/compactar')).status, 404);
});

test('compactar com turno ativo: 409 claro; depois de parar, compacta', async () => {
  const ms = await post(`/codex/sessao/${ID}/mensagem`, { texto: '[demorar] segura aí' });
  assert.equal(ms.status, 202);
  await esperarSessao(ID, (x) => x.status === 'trabalhando');
  const n = recebidos('thread/compact/start').length;
  const r = await post(`/codex/sessao/${ID}/compactar`);
  assert.equal(r.status, 409);
  assert.match(r.json.erro, /trabalhando/);
  assert.equal(r.json.codigo, 'ocupada');
  assert.equal(recebidos('thread/compact/start').length, n, 'nada foi ao Codex');
  assert.equal((await post(`/codex/sessao/${ID}/parar`)).status, 202);
  await esperarSessao(ID, (x) => x.status === 'interrompida');
  const ok = await post(`/codex/sessao/${ID}/compactar`);
  assert.equal(ok.status, 202);
  await esperarEvento(acaoEv(ok.json.acao.id, (a) => a.estado === 'sucesso'));
  assert.equal(recebidos('thread/compact/start').length, n + 1);
});

test('uso pelo app-server: POST /codex/uso/atualizar (fonte app-server) e o account/rateLimits/updated vai no SSE', async () => {
  const desde = eventos.length;
  const r = await post('/codex/uso/atualizar');
  assert.equal(r.status, 200);
  const u = r.json;
  assert.equal(u.fonte, 'app-server');
  assert.equal(u.plano, 'plus');
  assert.ok(Number.isInteger(u.cincoHoras.pct) && u.cincoHoras.pct !== 41);
  assert.ok(Number.isInteger(u.semanal.pct));
  assert.ok(u.cincoHoras.renova > Date.now());
  assert.ok(u.semanal.renova > u.cincoHoras.renova);
  assert.deepEqual((await get('/codex/uso')).json, u);
  // o falso já avisou (account/rateLimits/updated) ao fim do turno anterior: o snapshot do POST pode não mudar nada
  const e = await esperarEvento(usoEv((d) => d.fonte === 'app-server'), 8000);
  assert.equal(e.dados.plano, 'plus');
  assert.ok(recebidos('account/rateLimits/read').length >= 1);
  assert.ok(recebidos('account/read').length >= 1, 'account/read só para o tipo de plano');

  // um turno novo: o app-server avisa (account/rateLimits/updated) e o SSE traz o pct maior
  const depois = eventos.length;
  await post(`/codex/sessao/${ID}/mensagem`, { texto: 'mais um para subir o uso' });
  const e2 = await esperarEvento(usoEv((d) => d.fonte === 'app-server' && d.cincoHoras.pct > u.cincoHoras.pct), 8000, depois);
  assert.equal((await get('/codex/uso')).json.cincoHoras.pct, e2.dados.cincoHoras.pct);
});

test('nenhum e-mail nem id de conta em respostas, SSE ou estado', async () => {
  await esperarSessao(ID, (x) => x.status === 'concluida');
  const tudo = respostas.join('\n') + '\n' + JSON.stringify(eventos);
  assert.ok(tudo.length > 1000);
  assert.ok(!tudo.includes('falso@example.com'));
  assert.ok(!/"email"/i.test(tudo));
  assert.ok(!/accountId|chatgptAccountId/.test(tudo));
});

test('lista fechada: só métodos da lista; e erro do Codex vira 503/502 nas rotas novas', async () => {
  const lista = logFalso().filter((l) => l.dir === 'recebido');
  assert.ok(!lista.some((l) => l.fora_da_lista));
  const permitidos = new Set(['initialize', 'initialized', 'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt', 'thread/compact/start', 'model/list', 'account/read', 'account/rateLimits/read']);
  for (const l of lista) assert.ok(permitidos.has(l.method), `método inesperado: ${l.method}`);

  // sem executável que funcione: modelos 503 (como o /modelos do Claude), uso/atualizar 502, criar com modelo 503/502
  assert.equal((await post('/config', { codex: { ativo: false } })).status, 200);
  for (const pid of pids) assert.ok(await morreu(pid, 6000), `pid ${pid} ainda vivo`);
  await descer();
  await subir({ ORBIT_CODEX_EXE: QUEBRADO });
  assert.equal((await post('/config', { codex: { ativo: true } })).status, 200);
  const m = await get('/codex/modelos');
  assert.equal(m.status, 503);
  assert.ok(m.json.erro);
  const u = await post('/codex/uso/atualizar');
  assert.ok(u.status === 502 || u.status === 503, `uso/atualizar: ${u.status}`);
  const c = await post('/codex/instancias', { pasta: PASTA, modelo: 'gpt-5' });
  assert.ok(c.status === 502 || c.status === 503, `criar com modelo: ${c.status}`);
  assert.equal((await post('/config', { codex: { ativo: false } })).status, 200);
});
