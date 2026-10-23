// Testes do monitoramento do Codex no servidor (etapa 1): rollouts -> sessões com provedor 'codex'.
// Rodar:  node --test testes/codex-monitor.test.mjs
// Servidor real em porta de escolherPorta (47822–47826, nunca a 47821), GERENCIADOR_DADOS e CODEX_HOME temporários
// (apagados no fim). Rollouts escritos à mão e pelo Codex falso (codex-falso.mjs via codex-rpc.mjs). Nunca o codex real,
// nunca ~/.codex nem ~/.claude.
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
import { abrirCodex } from '../codex-rpc.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FALSO = path.join(RAIZ, 'testes', 'codex-falso.mjs');
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let PORTA, TMP, DADOS, HOME, TRABALHO;
let filho = null;
let sse = null;
const eventos = []; // { tipo, dados } do /fluxo

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

function abrirSSE() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: '/fluxo', headers: { accept: 'text/event-stream' } }, (res) => {
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
          eventos.push({ tipo, dados });
        }
      });
      resolve(req);
    });
    req.on('error', reject);
  });
}
async function esperarEvento(pred, ms = 8000, desde = 0) {
  const t0 = Date.now();
  for (;;) {
    const e = eventos.slice(desde).find(pred);
    if (e) return e;
    if (Date.now() - t0 > ms) throw new Error('tempo esgotado esperando o evento SSE');
    await espera(40);
  }
}
const sessaoEv = (id, pred = () => true) => (e) => e.tipo === 'sessao' && e.dados?.id === id && pred(e.dados);

async function subir() {
  const env = {
    ...process.env,
    GERENCIADOR_PORTA: String(PORTA),
    GERENCIADOR_DADOS: DADOS,
    GERENCIADOR_SESSOES_DIR: path.join(TMP, 'sessoes'),
    ORBIT_PROJETOS_DIR: path.join(TMP, 'projetos'),
    CODEX_HOME: HOME,
    ORBIT_CODEX_INTERVALO_MS: '150',
    GERENCIADOR_TICK_MS: '300',
    ORBIT_MOTOR: '0',
    ...(process.platform === 'win32' ? {} : { HOME: path.join(TMP, 'home') }),
  };
  delete env.ORBIT_CODEX_EXE;
  delete env.CLAUDE_CODE_HOST_SESSION_ID;
  filho = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env, stdio: 'ignore' });
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

// ---- rollout escrito à mão ----
const p2 = (n) => String(n).padStart(2, '0');
function pastaDoDia() {
  const d = new Date();
  const dir = path.join(HOME, 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const ID_A = crypto.randomUUID();
let ordinal = 0;
const lin = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), ordinal: ordinal++, type, payload }) + '\n';
const ev = (tipo, resto = {}) => lin('event_msg', { type: tipo, ...resto });
const ARQ_A = () => path.join(pastaDoDia(), `rollout-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}-${ID_A}.jsonl`);
let arquivoA = null;

const estadoCodex = async () => (await get('/estado')).json.sessoes.filter((s) => s.provedor === 'codex');
const estadoDisco = () => { try { return JSON.parse(fs.readFileSync(path.join(DADOS, 'estado.json'), 'utf8')); } catch { return null; } };

before(async () => {
  PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47822);
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-codex-monitor-'));
  DADOS = path.join(TMP, 'dados');
  HOME = path.join(TMP, 'codex-home');
  TRABALHO = path.join(TMP, 'trabalho');
  for (const d of [DADOS, HOME, TRABALHO, path.join(TMP, 'sessoes'), path.join(TMP, 'projetos'), path.join(TRABALHO, 'proj-a'), path.join(TRABALHO, 'proj-falso')]) fs.mkdirSync(d, { recursive: true });
});
after(async () => {
  await descer();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('chave desligada: rollout existente não vira sessão, /estado sem provedor e /codex/* é 404', async () => {
  arquivoA = ARQ_A();
  fs.writeFileSync(arquivoA,
    lin('session_meta', { id: ID_A, cwd: path.join(TRABALHO, 'proj-a'), originator: 'codex_cli_rs', cli_version: '0.163.0', source: 'cli' }) +
    lin('turn_context', { turn_id: 't1', cwd: path.join(TRABALHO, 'proj-a'), approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' }, model: 'gpt-5-codex', effort: 'medium' }) +
    ev('task_started', { turn_id: 't1', model_context_window: 258400 }) +
    ev('item_completed', { item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'Arrume o teste do login' }] } }));
  await subir();
  await espera(1200); // vários ciclos do monitor, se existisse
  const e = await get('/estado');
  assert.equal(e.status, 200);
  assert.ok(!e.texto.includes('"provedor"'), '/estado sem o campo provedor');
  assert.ok(!e.json.sessoes.some((s) => s.id === ID_A));
  assert.equal((await get(`/codex/sessao/${ID_A}/conversa`)).status, 404);
  assert.equal((await get('/codex/estado')).status, 404);
  const disco = estadoDisco();
  assert.ok(!disco || !JSON.stringify(disco).includes('"provedor"'));
});

test('ligar a chave: a sessão aparece com provedor codex, trabalhando, contexto e SSE sessao', async () => {
  sse = await abrirSSE();
  await esperarEvento((e) => e.tipo === 'inicio');
  const desde = eventos.length;
  const r = await post('/config', { codex: { ativo: true } });
  assert.equal(r.status, 200);
  const e = await esperarEvento(sessaoEv(ID_A), 8000, desde);
  const s = e.dados;
  assert.equal(s.provedor, 'codex');
  assert.equal(s.status, 'trabalhando');
  assert.equal(s.projeto, 'proj-a');
  assert.equal(s.cwd, path.join(TRABALHO, 'proj-a'));
  assert.equal(s.titulo, 'Arrume o teste do login');
  assert.equal(s.pedido, 'Arrume o teste do login');
  assert.equal(s.modelo, 'gpt-5-codex');
  assert.equal(s.esforco, 'medium');
  assert.equal(s.contexto?.janela, 258400);
  assert.equal(s.contadores.turnos, 1);
  assert.deepEqual(s.controle, { modo: 'nenhum', provedor: 'codex' });
  assert.ok(!('_hook' in s) && !('_transcript' in s), 'campos internos não saem');
  const lista = await estadoCodex();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].id, ID_A);
});

test('turno concluído: status concluida, ultimaResposta, contexto real, alerta concluida', async () => {
  const desde = eventos.length;
  fs.appendFileSync(arquivoA,
    ev('item_completed', { item: { type: 'CommandExecution', id: 'c1', command: ['bash', '-lc', 'npm test'], status: 'completed', exit_code: 0 } }) +
    ev('item_completed', { item: { type: 'AgentMessage', id: 'a1', phase: 'final_answer', content: [{ type: 'Text', text: 'Pronto: o teste do login passa.' }] } }) +
    ev('token_count', { info: { total_token_usage: { input_tokens: 20000, total_tokens: 20500 }, last_token_usage: { input_tokens: 20000, cached_input_tokens: 5000, output_tokens: 500, reasoning_output_tokens: 100, total_tokens: 20500 }, model_context_window: 258400 }, rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 }, plan_type: 'plus' } }) +
    ev('task_complete', { turn_id: 't1', last_agent_message: 'Pronto: o teste do login passa.' }));
  const e = await esperarEvento(sessaoEv(ID_A, (s) => s.status === 'concluida'), 8000, desde);
  const s = e.dados;
  assert.equal(s.ultimaResposta, 'Pronto: o teste do login passa.');
  assert.equal(s.contexto.tokens, 20000);
  assert.equal(s.contexto.janela, 258400);
  assert.equal(s.contexto.pct, 8);
  assert.equal(s.contadores.ferramentas, 1);
  assert.equal(s.ferramenta, null, 'ferramenta só enquanto trabalhando');
  const alerta = await esperarEvento((x) => x.tipo === 'alerta' && x.dados?.sessao?.id === ID_A && x.dados.tipo === 'concluida', 4000, desde);
  assert.equal(alerta.dados.sessao.status, 'concluida');
  // o histórico guarda o alerta (mesmo caminho do Claude)
  const ini = (await get('/estado')).json;
  assert.ok(ini.resumoDia, 'resumo do dia presente');
});

test('conversa: itens no formato do Claude, paginação por cursor e validação', async () => {
  const r = await get(`/codex/sessao/${ID_A}/conversa`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.itens.map((i) => i.tipo), ['usuario', 'ferramenta', 'assistente']);
  assert.equal(r.json.itens[0].texto, 'Arrume o teste do login');
  assert.equal(r.json.itens[1].nome, 'CommandExecution');
  assert.equal(r.json.itens[1].resumo, 'npm test');
  assert.equal(r.json.itens[2].texto, 'Pronto: o teste do login passa.');
  assert.ok(r.json.itens.every((i) => i.id && typeof i.ts === 'number'));
  assert.equal(r.json.cursorAntigo, null);
  assert.ok(Number.isInteger(r.json.cursorNovo));
  const p1 = await get(`/codex/sessao/${ID_A}/conversa?limite=1`);
  assert.deepEqual(p1.json.itens.map((i) => i.tipo), ['assistente']);
  assert.ok(p1.json.cursorAntigo, 'há itens anteriores');
  const p2r = await get(`/codex/sessao/${ID_A}/conversa?limite=1&antes=${p1.json.cursorAntigo}`);
  assert.deepEqual(p2r.json.itens.map((i) => i.tipo), ['ferramenta']);
  const p3 = await get(`/codex/sessao/${ID_A}/conversa?limite=5&antes=${p2r.json.cursorAntigo}`);
  assert.deepEqual(p3.json.itens.map((i) => i.tipo), ['usuario']);
  assert.equal(p3.json.cursorAntigo, null);
  assert.equal((await get(`/codex/sessao/${ID_A}/conversa?limite=0`)).status, 400);
  assert.equal((await get(`/codex/sessao/${ID_A}/conversa?antes=abc`)).status, 400);
  const nenhuma = await get('/codex/sessao/nao-existe/conversa');
  assert.equal(nenhuma.status, 200);
  assert.deepEqual(nenhuma.json.itens, []);
});

test('pelo Codex falso (codex-rpc): turno concluído e turno interrompido', async () => {
  const cli = await abrirCodex({ exe: process.execPath, args: [FALSO, 'app-server'], env: { CODEX_HOME: HOME }, cwd: TRABALHO });
  try {
    const cwd = path.join(TRABALHO, 'proj-falso');
    const texto = (t) => [{ type: 'text', text: t, text_elements: [] }];
    // 1) turno normal
    const t1 = (await cli.pedir('thread/start', { cwd })).thread;
    const desde1 = eventos.length;
    await cli.pedir('turn/start', { threadId: t1.id, input: texto('oi falso') });
    const fim1 = await esperarEvento(sessaoEv(t1.id, (s) => s.status === 'concluida'), 10000, desde1);
    assert.equal(fim1.dados.provedor, 'codex');
    assert.equal(fim1.dados.projeto, 'proj-falso');
    assert.match(fim1.dados.ultimaResposta, /Codex falso/);
    assert.ok(fim1.dados.contexto?.janela > 0 && fim1.dados.contexto.tokens > 0, 'contexto vem do token_count');
    assert.equal(fim1.dados.contadores.turnos, 1);
    // 2) turno longo, depois interrompido
    const t2 = (await cli.pedir('thread/start', { cwd })).thread;
    const desde2 = eventos.length;
    const ini2 = await cli.pedir('turn/start', { threadId: t2.id, input: texto('[demorar] fique um tempo') });
    await esperarEvento(sessaoEv(t2.id, (s) => s.status === 'trabalhando'), 10000, desde2);
    await cli.pedir('turn/interrupt', { threadId: t2.id, turnId: ini2.turn.id });
    const fim2 = await esperarEvento(sessaoEv(t2.id, (s) => s.status === 'interrompida'), 10000, desde2);
    assert.equal(fim2.dados.provedor, 'codex');
    await esperarEvento((x) => x.tipo === 'alerta' && x.dados?.sessao?.id === t2.id && x.dados.tipo === 'interrompida', 4000, desde2);
    const conv = await get(`/codex/sessao/${t1.id}/conversa`);
    assert.deepEqual(conv.json.itens.map((i) => i.tipo), ['usuario', 'assistente']);
    assert.match(conv.json.itens[1].texto, /Codex falso/);
    assert.equal((await estadoCodex()).length, 3);
  } finally { await cli.fechar(); }
});

test('desligar a chave: sessões somem (SSE remover), estado.json sem Codex, rotas 404', async () => {
  await espera(900); // dá tempo do salvar() do servidor
  const antes = estadoDisco();
  assert.ok(antes?.sessoes?.some((s) => s.provedor === 'codex'), 'o estado.json guardava as sessões do Codex');
  const ids = (await estadoCodex()).map((s) => s.id);
  assert.equal(ids.length, 3);
  const desde = eventos.length;
  const r = await post('/config', { codex: { ativo: false } });
  assert.equal(r.status, 200);
  for (const id of ids) await esperarEvento((e) => e.tipo === 'remover' && e.dados?.id === id, 5000, desde);
  assert.equal((await estadoCodex()).length, 0);
  assert.ok(!(await get('/estado')).texto.includes('"provedor"'));
  assert.equal((await get('/codex/estado')).status, 404);
  assert.equal((await get(`/codex/sessao/${ID_A}/conversa`)).status, 404);
  await espera(900);
  const depois = estadoDisco();
  assert.ok(!depois.sessoes.some((s) => s.provedor === 'codex'), 'estado.json sem sessões do Codex');
  // o monitor parou: nada volta sozinho
  assert.equal((await estadoCodex()).length, 0);
});

test('religar a chave: as sessões voltam', async () => {
  const desde = eventos.length;
  await post('/config', { codex: { ativo: true } });
  const e = await esperarEvento(sessaoEv(ID_A, (s) => s.status === 'concluida'), 8000, desde);
  assert.equal(e.dados.provedor, 'codex');
  assert.equal(e.dados.ultimaResposta, 'Pronto: o teste do login passa.');
  await espera(600);
  assert.equal((await estadoCodex()).length, 3);
});
