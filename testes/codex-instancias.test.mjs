// Testes das instâncias do Codex no servidor (etapa 2): criar, conversar, enfileirar, interromper, retomar, dormir/acordar.
// Rodar:  node --test testes/codex-instancias.test.mjs
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

let PORTA, TMP, DADOS, HOME, TRABALHO;
let filho = null;
let sse = null;
const eventos = []; // SSE global { tipo, dados }
const abertos = []; // streams SSE de conversa/fluxo
const pids = new Set(); // pids do Codex falso vistos (para provar que nenhum sobra)

function pedir(metodo, rota, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
    const headers = { 'x-gerenciador': '1' };
    if (dados !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(dados); }
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers, timeout: 8000 }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const t = Buffer.concat(partes).toString('utf8');
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

// SSE: acumula { tipo, dados } em `lista`.
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
const sessaoEv = (id, pred = () => true) => (e) => e.tipo === 'sessao' && e.dados?.id === id && pred(e.dados);
const acaoEv = (id, pred = () => true) => (e) => e.tipo === 'acao' && e.dados?.id === id && pred(e.dados);

async function esperarSessao(id, pred, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const todas = (await get('/estado')).json.sessoes;
    const s = todas.find((x) => x.id === id);
    if (s && pred(s)) return s;
    if (Date.now() - t0 > ms) throw new Error(`tempo esgotado esperando a sessão ${id}: ${JSON.stringify(s && { status: s.status, controle: s.controle })} (sessões: ${todas.map((x) => `${x.id.slice(0, 8)}:${x.status}`).join(', ')})`);
    await espera(60);
  }
}
const sessaoDe = async (id) => (await get('/estado')).json.sessoes.find((x) => x.id === id);

async function subir() {
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
  for (const a of abertos) { try { a.destroy(); } catch {} }
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

before(async () => {
  PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47822);
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-codex-instancias-'));
  DADOS = path.join(TMP, 'dados');
  HOME = path.join(TMP, 'codex-home');
  TRABALHO = path.join(TMP, 'trabalho');
  for (const d of [DADOS, HOME, TRABALHO, path.join(TMP, 'sessoes'), path.join(TMP, 'projetos'), path.join(TRABALHO, 'proj-i')]) fs.mkdirSync(d, { recursive: true });
});
after(async () => {
  await descer();
  for (const pid of pids) { try { process.kill(pid); } catch {} }
  fs.rmSync(TMP, { recursive: true, force: true });
});

let ID, PASTA;

test('chave desligada: /codex/instancias é 404', async () => {
  await subir();
  assert.equal((await post('/codex/instancias', { pasta: TRABALHO })).status, 404);
  assert.equal((await post('/codex/sessao/x/mensagem', { texto: 'oi' })).status, 404);
  sse = (await abrirSSE('/fluxo', eventos)).req;
  await esperarEvento((e) => e.tipo === 'inicio');
  const r = await post('/config', { codex: { ativo: true } });
  assert.equal(r.status, 200);
  PASTA = path.join(TRABALHO, 'proj-i');
});

test('validação: pasta, método, sessão inexistente', async () => {
  assert.equal((await post('/codex/instancias', {})).status, 400);
  assert.equal((await post('/codex/instancias', { pasta: 'relativa/x' })).status, 400);
  assert.equal((await post('/codex/instancias', { pasta: path.join(TRABALHO, 'nao-existe') })).status, 400);
  assert.equal((await post('/codex/instancias', { pasta: PASTA, modelo: 'x y; rm' })).status, 400);
  assert.equal((await get('/codex/instancias')).status, 405);
  assert.equal((await post('/codex/sessao/inexistente/mensagem', { texto: 'oi' })).status, 404);
  assert.equal((await get('/codex/sessao/inexistente/conversa/fluxo')).status, 404);
  assert.equal(recebidos('thread/start').length, 0, 'validação barra antes de falar com o Codex');
});

test('criar com texto: Acao sucesso, origem orbit, trabalhando -> concluida, ultimaResposta, política segura', async () => {
  const desde = eventos.length;
  const r = await post('/codex/instancias', { pasta: PASTA, nome: 'Teste Orbit', texto: 'Diga olá' });
  assert.equal(r.status, 202);
  assert.equal(r.json.acao.tipo, 'criar');
  assert.equal(r.json.acao.estado, 'sucesso');
  ID = r.json.sessao;
  assert.match(ID, /^[0-9a-f-]{36}$/);

  const trab = await esperarEvento(sessaoEv(ID, (s) => s.status === 'trabalhando'), 8000, desde);
  assert.equal(trab.dados.provedor, 'codex');
  assert.equal(trab.dados.origem, 'orbit');
  assert.equal(trab.dados.controle.modo, 'orbit');
  assert.equal(trab.dados.controle.provedor, 'codex');
  const fim = await esperarEvento(sessaoEv(ID, (s) => s.status === 'concluida'), 8000, desde);
  assert.equal(fim.dados.ultimaResposta, 'Feito (resposta do Codex falso).');
  assert.ok(eventos.indexOf(trab) < eventos.indexOf(fim), 'trabalhando vem antes de concluida');

  // a mensagem do texto inicial é uma Acao própria
  const msg = await esperarEvento((e) => e.tipo === 'acao' && e.dados?.sessao === ID && e.dados.tipo === 'mensagem' && e.dados.estado === 'sucesso', 8000, desde);
  assert.ok(msg);

  const s = await sessaoDe(ID);
  assert.equal(s.provedor, 'codex');
  assert.equal(s.origem, 'orbit');
  assert.equal(s.cwd, PASTA);
  assert.equal(s.controle.processo, 'vivo');
  assert.ok(s.controle.pid > 0);
  pids.add(s.controle.pid);
  assert.equal(s.controle.podeAssumir, false);

  // política fixa: on-request + workspace-write (o rollout do falso grava o que o cliente pediu)
  const arqs = [];
  const andar = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) andar(p); else if (e.name.endsWith(`${ID}.jsonl`)) arqs.push(p); } };
  andar(path.join(HOME, 'sessions'));
  assert.equal(arqs.length, 1);
  const ctx = fs.readFileSync(arqs[0], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type === 'turn_context');
  assert.ok(ctx.length >= 1);
  for (const c of ctx) {
    assert.equal(c.payload.approval_policy, 'on-request');
    assert.equal(c.payload.sandbox_policy.type, 'workspace-write');
  }
});

test('conversa/fluxo: emite parcial (texto ao vivo) e itens', async () => {
  const lista = [];
  const { req, status } = await abrirSSE(`/codex/sessao/${ID}/conversa/fluxo`, lista);
  abertos.push(req);
  assert.equal(status, 200);
  const r = await post(`/codex/sessao/${ID}/mensagem`, { texto: 'Responda de novo' });
  assert.equal(r.status, 202);
  assert.equal(r.json.acao.tipo, 'mensagem');
  const p = await esperarEm(lista, (e) => e.tipo === 'parcial', 8000);
  assert.ok(p.dados.id && typeof p.dados.texto === 'string' && p.dados.texto.length > 0);
  const it = await esperarEm(lista, (e) => e.tipo === 'itens' && e.dados.itens.some((i) => i.tipo === 'assistente'), 8000);
  assert.ok(it.dados.itens.length >= 1);
  await esperarSessao(ID, (s) => s.status === 'concluida' && s.controle.ocupada === false);
  req.destroy();
});

test("'next' durante um turno enfileira e roda depois; sem fila perdida", async () => {
  const antes = recebidos('turn/start').length;
  const desde = eventos.length;
  const a = await post(`/codex/sessao/${ID}/mensagem`, { texto: 'primeira volta' });
  const b = await post(`/codex/sessao/${ID}/mensagem`, { texto: 'segunda volta', prioridade: 'next' });
  assert.equal(b.status, 202);
  await esperarEvento(acaoEv(b.json.acao.id, (x) => x.etapa === 'Na fila'), 8000, desde);
  assert.equal(recebidos('turn/start').length, antes + 1, 'a segunda ainda não foi enviada');
  await esperarEvento(acaoEv(b.json.acao.id, (x) => x.estado === 'sucesso'), 10000, desde);
  await esperarEvento(acaoEv(a.json.acao.id, (x) => x.estado === 'sucesso'), 1000, desde);
  assert.equal(recebidos('turn/start').length, antes + 2);
  const s = await esperarSessao(ID, (x) => x.status === 'concluida' && x.controle.ocupada === false);
  assert.equal(s.controle.processo, 'vivo');
  assert.equal((await post(`/codex/sessao/${ID}/mensagem`, { texto: 'x', prioridade: 'depois' })).status, 400);
  assert.equal((await post(`/codex/sessao/${ID}/mensagem`, { texto: '  ' })).status, 400);
});

test("'now' interrompe o turno em curso e envia a mensagem sem passar por interrompida", async () => {
  const desde = eventos.length;
  await post(`/codex/sessao/${ID}/mensagem`, { texto: 'comece [demorar]' });
  await esperarSessao(ID, (s) => s.status === 'trabalhando');
  const ints = recebidos('turn/interrupt').length;
  const r = await post(`/codex/sessao/${ID}/mensagem`, { texto: 'mude de rumo', prioridade: 'now' });
  assert.equal(r.status, 202);
  await esperarEvento(acaoEv(r.json.acao.id, (x) => x.estado === 'sucesso'), 10000, desde);
  const s = await esperarSessao(ID, (x) => x.status === 'concluida' && x.controle.ocupada === false);
  assert.equal(s.ultimaResposta, 'Feito (resposta do Codex falso).');
  assert.equal(recebidos('turn/interrupt').length, ints + 1);
  assert.ok(!eventos.slice(desde).some(sessaoEv(ID, (x) => x.status === 'interrompida')), "'now' não passa por interrompida");
});

test('parar: Acao sucesso, status interrompida, fila cancelada', async () => {
  const desde = eventos.length;
  await post(`/codex/sessao/${ID}/mensagem`, { texto: 'longa [demorar]' });
  await esperarSessao(ID, (s) => s.status === 'trabalhando');
  const f = await post(`/codex/sessao/${ID}/mensagem`, { texto: 'depois', prioridade: 'next' });
  await esperarEvento(acaoEv(f.json.acao.id, (x) => x.etapa === 'Na fila'), 8000, desde);
  const r = await post(`/codex/sessao/${ID}/parar`);
  assert.equal(r.status, 202);
  assert.equal(r.json.acao.tipo, 'parar');
  await esperarEvento(acaoEv(r.json.acao.id, (x) => x.estado === 'sucesso'), 10000, desde);
  const fe = await esperarEvento(acaoEv(f.json.acao.id, (x) => x.estado === 'erro'), 4000, desde);
  assert.match(fe.dados.erro, /Cancelada/);
  const s = await esperarSessao(ID, (x) => x.status === 'interrompida');
  assert.equal(s.controle.ocupada, false);
  // parar sem turno: a Acao falha com mensagem clara
  const r2 = await post(`/codex/sessao/${ID}/parar`);
  const e2 = await esperarEvento(acaoEv(r2.json.acao.id, (x) => x.estado === 'erro'), 4000, desde);
  assert.match(e2.dados.erro, /não está trabalhando/);
  const lista = (await get(`/codex/sessao/${ID}/acoes`)).json;
  assert.ok(Array.isArray(lista) && lista.some((x) => x.tipo === 'parar'));
});

test('pedido de comando fica aguardando o usuário; negar devolve decline (etapa 3)', async () => {
  const desde = eventos.length;
  await post(`/codex/sessao/${ID}/mensagem`, { texto: 'rode [comando]' });
  const ag = await esperarSessao(ID, (s) => s.status === 'aguardando' && s.controle.permissao);
  const r = await post(`/codex/sessao/${ID}/permissao`, { id: ag.controle.permissao.id, decisao: 'negar' });
  assert.equal(r.status, 200);
  await esperarEvento(sessaoEv(ID, (s) => s.status === 'concluida' && s.ultimaResposta === 'Comando recusado.'), 8000, desde);
  const resp = logFalso().filter((l) => l.dir === 'resposta-do-cliente' && l.method === 'item/commandExecution/requestApproval');
  assert.ok(resp.length >= 1);
  assert.equal(resp.at(-1).result.decision, 'decline');
});

test('matar o processo durante o turno: dormindo + interrompida; a próxima mensagem acorda com thread/resume', async () => {
  await post(`/codex/sessao/${ID}/mensagem`, { texto: 'vai morrer [demorar]' });
  const vivo = await esperarSessao(ID, (s) => s.status === 'trabalhando' && s.controle.processo === 'vivo');
  const pid = vivo.controle.pid;
  pids.add(pid);
  const resumes = recebidos('thread/resume').length;
  process.kill(pid);
  const s = await esperarSessao(ID, (x) => x.controle.processo === 'dormindo');
  assert.equal(s.status, 'interrompida');
  assert.match(s.detalhe || '', /processo do Codex parou/);
  assert.equal(s.controle.pid, undefined);
  assert.ok(await morreu(pid));

  const r = await post(`/codex/sessao/${ID}/mensagem`, { texto: 'acorde' });
  assert.equal(r.status, 202);
  const fim = await esperarSessao(ID, (x) => x.status === 'concluida' && x.controle.processo === 'vivo' && x.controle.ocupada === false);
  assert.ok(fim.controle.pid && fim.controle.pid !== pid, 'processo novo');
  pids.add(fim.controle.pid);
  assert.equal(recebidos('thread/resume').length, resumes + 1);
  assert.equal(fim.ultimaResposta, 'Feito (resposta do Codex falso).');
});

test('matar o processo parado: dormindo sem mexer no status; /retomar acorda', async () => {
  const antes = await sessaoDe(ID);
  const pid = antes.controle.pid;
  const resumes = recebidos('thread/resume').length;
  process.kill(pid);
  const s = await esperarSessao(ID, (x) => x.controle.processo === 'dormindo');
  assert.equal(s.status, 'concluida');
  assert.ok(await morreu(pid));
  const r = await post(`/codex/sessao/${ID}/retomar`);
  assert.equal(r.status, 202);
  assert.equal(r.json.acao.tipo, 'retomar');
  const v = await esperarSessao(ID, (x) => x.controle.processo === 'vivo');
  pids.add(v.controle.pid);
  assert.equal(recebidos('thread/resume').length, resumes + 1);
});

test('sessão só monitorada: mensagem/parar = 409 nao_assumida; /retomar assume e depois conversa', async () => {
  const idB = crypto.randomUUID();
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const dir = path.join(HOME, 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  let ord = 0;
  const lin = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), ordinal: ord++, type, payload }) + '\n';
  const cwd = path.join(TRABALHO, 'proj-i');
  fs.writeFileSync(path.join(dir, `rollout-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}-${idB}.jsonl`),
    lin('session_meta', { id: idB, cwd, originator: 'codex_cli_rs', cli_version: '0.163.0', source: 'cli' }) +
    lin('turn_context', { turn_id: 't1', cwd, approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' }, model: 'gpt-5-codex', effort: 'medium' }) +
    lin('event_msg', { type: 'task_started', turn_id: 't1', model_context_window: 258400 }) +
    lin('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'Feito no terminal' }] } }) +
    lin('event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: 'ok' }));
  const mon = await esperarSessao(idB, () => true);
  assert.deepEqual(mon.controle, { modo: 'nenhum', provedor: 'codex' });
  const m = await post(`/codex/sessao/${idB}/mensagem`, { texto: 'oi' });
  assert.equal(m.status, 409);
  assert.equal(m.json.codigo, 'nao_assumida');
  assert.equal((await post(`/codex/sessao/${idB}/parar`)).status, 409);
  const r = await post(`/codex/sessao/${idB}/retomar`);
  assert.equal(r.status, 202);
  const as = await esperarSessao(idB, (x) => x.controle?.modo === 'orbit' && x.controle.processo === 'vivo');
  pids.add(as.controle.pid);
  const m2 = await post(`/codex/sessao/${idB}/mensagem`, { texto: 'agora sim' });
  assert.equal(m2.status, 202);
  await esperarSessao(idB, (x) => x.ultimaResposta === 'Feito (resposta do Codex falso).' && x.status === 'concluida');

  // encerrar: só esquece no Orbit (SSE remover); o processo e a outra sessão continuam
  const desde = eventos.length;
  const e = await post(`/codex/sessao/${idB}/encerrar`);
  assert.equal(e.status, 202);
  await esperarEvento((x) => x.tipo === 'remover' && x.dados?.id === idB, 8000, desde);
  assert.ok(!(await get('/estado')).json.sessoes.some((x) => x.id === idB));
  assert.ok(await sessaoDe(ID));
});

test('desligar a chave: o processo do Codex encerra e as sessões saem; nenhum processo sobra', async () => {
  const s = await esperarSessao(ID, (x) => x.controle.processo === 'vivo');
  const pid = s.controle.pid;
  assert.ok(vivoPid(pid));
  const r = await post('/config', { codex: { ativo: false } });
  assert.equal(r.status, 200);
  assert.ok(await morreu(pid, 6000), 'o app-server do Codex falso encerrou');
  assert.ok(!(await get('/estado')).json.sessoes.some((x) => x.provedor === 'codex'));
  assert.equal((await post('/codex/instancias', { pasta: PASTA })).status, 404);
  for (const p of pids) assert.ok(await morreu(p, 3000), `pid ${p} ainda vivo`);
});

test('lista fechada: o falso nunca recebeu método fora da lista', async () => {
  const lista = logFalso().filter((l) => l.dir === 'recebido');
  assert.ok(lista.length > 5);
  assert.ok(!lista.some((l) => l.fora_da_lista), 'nenhum fora_da_lista');
  const permitidos = new Set(['initialize', 'initialized', 'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt']);
  for (const l of lista) assert.ok(permitidos.has(l.method), `método inesperado: ${l.method}`);
  for (const m of ['thread/start', 'thread/resume', 'turn/start', 'turn/interrupt']) assert.ok(lista.some((l) => l.method === m), m);
});
