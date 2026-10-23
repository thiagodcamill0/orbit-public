// Testes do Codex como membro de time (etapa 5, servidor): `pai`/`avisarLider` no POST /codex/instancias, subagentes do
// próprio Codex em agentes[] da mãe e o CLI codex-membro.mjs. Rodar:  node --test testes/codex-times.test.mjs
// Servidor real em porta de escolherPorta (47822–47826, nunca a 47821), GERENCIADOR_DADOS e CODEX_HOME temporários
// (apagados no fim), Codex FALSO (ORBIT_CODEX_EXE) e Claude FALSO (ORBIT_CLAUDE_BIN) como líder. Nunca o codex real.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escolherPorta, desligarSeMeu } from './porta-livre.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FALSO = path.join(RAIZ, 'testes', 'codex-falso.mjs');
const CLI = path.join(RAIZ, 'codex-membro.mjs');
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const RESPOSTA = 'Feito (resposta do Codex falso).';

let PORTA, TMP, DADOS, HOME, TRABALHO, PROJETOS;
let filho = null;
const pids = new Set(); // pids dos falsos (codex e claude) vistos: nenhum pode sobrar

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

async function esperarQue(cond, ms = 10000, rotulo = 'condição') {
  const fim = Date.now() + ms;
  let ultimo;
  while (Date.now() < fim) {
    ultimo = await cond();
    if (ultimo) return ultimo;
    await espera(60);
  }
  throw new Error(`${rotulo} não aconteceu em ${ms} ms (último: ${JSON.stringify(ultimo)})`);
}
const sessaoDe = async (id) => (await get('/estado')).json.sessoes.find((x) => x.id === id);
const esperarSessao = (id, pred, ms, rotulo = `sessão ${id}`) => esperarQue(async () => { const s = await sessaoDe(id); if (s) { if (s.controle?.pid) pids.add(s.controle.pid); if (pred(s)) return s; } return null; }, ms, rotulo);
const livre = (s) => s.controle?.ocupada === false && ['concluida', 'erro', 'interrompida'].includes(s.status);

async function subir() {
  const env = {
    ...process.env,
    GERENCIADOR_PORTA: String(PORTA),
    GERENCIADOR_DADOS: DADOS,
    GERENCIADOR_SESSOES_DIR: path.join(TMP, 'sessoes'),
    ORBIT_PROJETOS_DIR: PROJETOS,
    CODEX_HOME: HOME,
    ORBIT_CODEX_EXE: FALSO,
    ORBIT_CLAUDE_BIN: path.join(RAIZ, 'testes', 'claude-falso.mjs'),
    CODEX_FALSO_ATRASO_MS: '30',
    ORBIT_CODEX_INTERVALO_MS: '150',
    GERENCIADOR_TICK_MS: '300',
    ORBIT_MOTOR: '0',
    CLAUDE_CODE_ENTRYPOINT: 'teste',
    ...(process.platform === 'win32' ? {} : { HOME: path.join(TMP, 'home') }),
  };
  delete env.CLAUDE_CODE_HOST_SESSION_ID;
  delete env.ORBIT_SESSAO; // rodando dentro de uma instância do Orbit
  delete env.CLAUDECODE;
  filho = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env, stdio: process.env.ORBIT_TESTE_LOG ? ['ignore', fs.openSync(process.env.ORBIT_TESTE_LOG, 'a'), fs.openSync(process.env.ORBIT_TESTE_LOG, 'a')] : 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (filho.exitCode != null) throw new Error(`o servidor do teste saiu (código ${filho.exitCode})`);
    try { const r = await get('/saude'); if (r.json?.pid === filho.pid) return; } catch {}
    await espera(100);
  }
  throw new Error('servidor não subiu');
}
async function descer() {
  const p = filho;
  if (!p) return;
  filho = null;
  if (p.exitCode != null) return;
  const saiu = new Promise((r) => p.once('exit', r));
  await desligarSeMeu(PORTA, p.pid);
  await Promise.race([saiu, espera(4000)]);
  if (p.exitCode == null) { try { p.kill(); } catch {} await Promise.race([saiu, espera(3000)]); }
}
const vivoPid = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// CLI: devolve { codigo, saida, erro }.
function cli(args, env = {}, ms = 30000) {
  return new Promise((resolve) => {
    const e = { ...process.env, GERENCIADOR_PORTA: String(PORTA), ...env };
    if (env.CLAUDE_CODE_HOST_SESSION_ID === undefined) delete e.CLAUDE_CODE_HOST_SESSION_ID;
    if (env.ORBIT_SESSAO === undefined) delete e.ORBIT_SESSAO; // idem: a CLI a usa como líder
    const p = execFile(process.execPath, [CLI, ...args], { env: e, timeout: ms, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ codigo: err ? (typeof err.code === 'number' ? err.code : 99) : 0, saida: String(stdout).trim(), erro: String(stderr).trim() });
    });
    p.stdin?.end();
  });
}

// Líder do Claude por /evento (como o backend.test faz).
async function lider(id, extra = {}) {
  const r = await post('/evento', { ts: Date.now(), cwd: path.join(TRABALHO, 'lider-evento'), session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'monta o time', ...extra });
  assert.equal(r.status, 200, r.texto);
  return id;
}

// Rollouts escritos à mão.
const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const p2 = (n) => String(n).padStart(2, '0');
let seq = 0;
const L = (type, payload, ts = Date.now()) => JSON.stringify({ timestamp: new Date(ts).toISOString(), ordinal: seq++, type, payload }) + '\n';
const ev = (tipo, resto = {}) => L('event_msg', { type: tipo, ...resto });
const meta = (id, extra = {}) => L('session_meta', { id, session_id: id, cwd: TRABALHO, originator: 'codex_vscode', cli_version: '0.163.0', source: 'vscode', thread_source: 'user', ...extra });
const usuario = (texto) => ev('item_completed', { item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text: texto }] } });
const agenteMsg = (texto) => ev('item_completed', { item: { type: 'AgentMessage', id: 'a', phase: 'final_answer', content: [{ type: 'Text', text: texto }] } });
function rollout(id, linhas) {
  const d = new Date();
  const dir = path.join(HOME, 'sessions', String(d.getUTCFullYear()), p2(d.getUTCMonth() + 1), p2(d.getUTCDate()));
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `rollout-${d.toISOString().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`);
  fs.writeFileSync(f, linhas.join(''));
  return f;
}

before(async () => {
  PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47822);
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-codex-times-'));
  DADOS = path.join(TMP, 'dados');
  HOME = path.join(TMP, 'codex-home');
  TRABALHO = path.join(TMP, 'trabalho');
  PROJETOS = path.join(TMP, 'projetos');
  for (const d of [DADOS, HOME, TRABALHO, PROJETOS, path.join(TMP, 'sessoes'), path.join(TRABALHO, 'lider-evento'), path.join(TRABALHO, 'membro'), path.join(TRABALHO, 'lider-orbit')]) fs.mkdirSync(d, { recursive: true });
});
after(async () => {
  await descer();
  await espera(300);
  for (const pid of pids) { try { process.kill(pid); } catch {} }
  fs.rmSync(TMP, { recursive: true, force: true });
});

const MEMBRO = () => path.join(TRABALHO, 'membro');
const LIDER_EVENTO = 'lider-evento-1';
let MEMBRO_ID; // membro criado com pai válido

test('chave desligada: /codex/instancias é 404 (com ou sem pai)', async () => {
  await subir();
  await lider(LIDER_EVENTO);
  assert.equal((await post('/codex/instancias', { pasta: MEMBRO(), pai: LIDER_EVENTO })).status, 404);
  assert.equal((await post('/config', { codex: { ativo: true } })).status, 200);
});

test('criar com pai válido: 202, /estado mostra o membro com pai e o líder continua sem pai', async () => {
  const r = await post('/codex/instancias', { pasta: MEMBRO(), pai: LIDER_EVENTO, nome: 'Revisor', texto: 'olá' });
  assert.equal(r.status, 202, r.texto);
  MEMBRO_ID = r.json.sessao;
  const s = await esperarSessao(MEMBRO_ID, (x) => x.status === 'concluida' && livre(x), 10000, 'membro concluído');
  assert.equal(s.provedor, 'codex');
  assert.equal(s.pai, LIDER_EVENTO);
  assert.equal(s.origem, 'orbit');
  assert.equal(s.ultimaResposta, RESPOSTA);
  const l = await sessaoDe(LIDER_EVENTO);
  assert.ok(!l.pai, 'o líder não tem pai');
  assert.ok(!l.provedor, 'o líder é do Claude');
});

test('validação: pai inexistente, pai Codex, pai/avisarLider mal formados → 400 e nenhum thread criado', async () => {
  const antes = (await get('/estado')).json.sessoes.length;
  const base = { pasta: MEMBRO() };
  for (const [corpo, re] of [
    [{ ...base, pai: 'nao-existe' }, /não existe/],
    [{ ...base, pai: MEMBRO_ID }, /não pode ser líder/],
    [{ ...base, pai: 42 }, /pai inválido/],
    [{ ...base, pai: 'x'.repeat(101) }, /pai inválido/],
    [{ ...base, pai: LIDER_EVENTO, avisarLider: 'sim' }, /avisarLider/],
    [{ ...base, avisarLider: true }, /precisa de um pai/],
  ]) {
    const r = await post('/codex/instancias', corpo);
    assert.equal(r.status, 400, JSON.stringify(corpo));
    assert.match(r.json.erro, re);
  }
  assert.equal((await get('/estado')).json.sessoes.length, antes);
});

test('nenhuma sessão recebe pai = sessão Codex (evento de hook com host_session_id do Codex)', async () => {
  await lider('dependente-de-codex', { host_session_id: MEMBRO_ID });
  const s = await sessaoDe('dependente-de-codex');
  assert.ok(s, 'a sessão do Claude existe');
  assert.ok(!s.pai, 'sem pai: o Codex nunca é líder');
  await lider('dependente-ok', { host_session_id: LIDER_EVENTO });
  assert.equal((await sessaoDe('dependente-ok')).pai, LIDER_EVENTO, 'pai do Claude segue funcionando');
});

// ───────── aviso ao líder (instância do Orbit com o Claude falso) ─────────
const transcriptDe = (cwd, id) => path.join(PROJETOS, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
const avisosNoLider = (cwd, id) => {
  let t = ''; try { t = fs.readFileSync(transcriptDe(cwd, id), 'utf8'); } catch {}
  return t.split('\n').filter((l) => l.includes('Membro Codex'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e?.type === 'user' && typeof e.message?.content === 'string')
    .map((e) => e.message.content);
};

test('avisarLider: o líder (instância do Orbit) recebe a linha ao fim do turno; sem avisarLider, nada', async () => {
  const cwd = path.join(TRABALHO, 'lider-orbit');
  const r = await post('/instancias', { pasta: cwd, texto: 'Monte o time' });
  assert.equal(r.status, 202, r.texto);
  const lid = r.json.sessao;
  await esperarSessao(lid, (s) => s.controle?.modo === 'orbit' && s.controle?.ocupada === false && /assistant/.test(fs.existsSync(transcriptDe(cwd, lid)) ? fs.readFileSync(transcriptDe(cwd, lid), 'utf8') : ''), 15000, 'líder livre');

  const m = await post('/codex/instancias', { pasta: MEMBRO(), pai: lid, avisarLider: true, nome: 'Ana', texto: 'faça a revisão' });
  assert.equal(m.status, 202, m.texto);
  assert.equal((await sessaoDe(m.json.sessao)).pai, lid);
  await esperarQue(() => avisosNoLider(cwd, lid).length >= 1, 15000, 'aviso no líder');
  const a = avisosNoLider(cwd, lid);
  assert.equal(a.length, 1);
  assert.equal(a[0], `Membro Codex Ana concluiu: ${RESPOSTA}`);

  // Sem avisarLider: nada chega ao líder (espera o membro acabar e um pouco mais).
  const sem = await post('/codex/instancias', { pasta: MEMBRO(), pai: lid, nome: 'Beto', texto: 'outra' });
  assert.equal(sem.status, 202, sem.texto);
  await esperarSessao(sem.json.sessao, (s) => s.status === 'concluida' && livre(s), 10000, 'Beto concluído');
  await espera(1200);
  assert.equal(avisosNoLider(cwd, lid).length, 1, 'sem avisarLider, o líder não recebe nada');

  // Segundo turno do mesmo membro com aviso: nova linha.
  assert.equal((await post(`/codex/sessao/${m.json.sessao}/mensagem`, { texto: 'mais uma' })).status, 202);
  await esperarQue(() => avisosNoLider(cwd, lid).length >= 2, 15000, 'segundo aviso');

  // Turno interrompido também avisa.
  assert.equal((await post(`/codex/sessao/${m.json.sessao}/mensagem`, { texto: '[demorar] segura' })).status, 202);
  await esperarSessao(m.json.sessao, (s) => s.status === 'trabalhando', 8000, 'membro trabalhando');
  assert.equal((await post(`/codex/sessao/${m.json.sessao}/parar`, {})).status, 202);
  await esperarQue(() => avisosNoLider(cwd, lid).some((t) => /Ana foi interrompido/.test(t)), 15000, 'aviso de interrompido');
});

// ───────── CLI ─────────
let CLI_ID;
test('CLI: sem CLAUDE_CODE_HOST_SESSION_ID, criar dá erro claro e nada é criado', async () => {
  const antes = (await get('/estado')).json.sessoes.length;
  const r = await cli(['criar', '--pasta', MEMBRO(), 'oi']);
  assert.equal(r.codigo, 1);
  assert.match(r.erro, /CLAUDE_CODE_HOST_SESSION_ID/);
  assert.equal((await get('/estado')).json.sessoes.length, antes);
  assert.notEqual((await cli(['criar', '--pasta', MEMBRO()], { CLAUDE_CODE_HOST_SESSION_ID: '' })).codigo, 0);
});

test('CLI: criar → esperar → estado → enviar → esperar', async () => {
  const env = { CLAUDE_CODE_HOST_SESSION_ID: LIDER_EVENTO };
  let r = await cli(['criar', '--pasta', MEMBRO(), '--nome', 'ViaCli', 'faça a tarefa'], env);
  assert.equal(r.codigo, 0, r.erro);
  const m = /id: (\S+)/.exec(r.saida);
  assert.ok(m, r.saida);
  CLI_ID = m[1];
  assert.equal((await sessaoDe(CLI_ID)).pai, LIDER_EVENTO, 'pai = CLAUDE_CODE_HOST_SESSION_ID');

  r = await cli(['esperar', CLI_ID, '--max', '20'], env);
  assert.equal(r.codigo, 0, r.erro);
  assert.equal(r.saida, RESPOSTA);

  r = await cli(['estado', CLI_ID]);
  assert.equal(r.codigo, 0, r.erro);
  assert.match(r.saida, /status: concluida/);
  assert.match(r.saida, new RegExp(`líder: ${LIDER_EVENTO}`));
  assert.match(r.saida, /resposta: Feito/);

  r = await cli(['enviar', CLI_ID, 'segunda', 'tarefa']);
  assert.equal(r.codigo, 0, r.erro);
  r = await cli(['esperar', CLI_ID, '--max', '20']);
  assert.equal(r.codigo, 0, r.erro);
  assert.equal(r.saida, RESPOSTA);
  const rolls = (await get(`/codex/sessao/${CLI_ID}/acoes`)).json.filter((a) => a.tipo === 'mensagem');
  assert.ok(rolls.length >= 2, 'duas mensagens: a do criar e a do enviar');
});

test('CLI: erros → código ≠ 0 e mensagem curta (id inexistente, sem texto, tempo esgotado, opção ruim, Orbit fora do ar)', async () => {
  let r = await cli(['estado', 'nao-existe']);
  assert.equal(r.codigo, 1); assert.match(r.erro, /não encontrado/);
  r = await cli(['esperar', 'nao-existe', '--max', '2']);
  assert.equal(r.codigo, 1);
  r = await cli(['enviar', CLI_ID]);
  assert.equal(r.codigo, 1); assert.match(r.erro, /texto/);
  r = await cli(['enviar', 'nao-existe', 'oi']);
  assert.equal(r.codigo, 1); assert.match(r.erro, /sessão/i);
  r = await cli(['criar', '--bobagem'], { CLAUDE_CODE_HOST_SESSION_ID: LIDER_EVENTO });
  assert.equal(r.codigo, 1); assert.match(r.erro, /desconhecida/);
  r = await cli(['criar', '--pasta', path.join(TMP, 'nao-existe'), 'oi'], { CLAUDE_CODE_HOST_SESSION_ID: LIDER_EVENTO });
  assert.equal(r.codigo, 1); assert.match(r.erro, /não existe/);
  r = await cli([]);
  assert.equal(r.codigo, 1);
  // Turno longo + --max curto: sai com 4; depois para o turno.
  assert.equal((await cli(['enviar', CLI_ID, '[demorar] devagar'])).codigo, 0);
  await esperarSessao(CLI_ID, (s) => s.status === 'trabalhando', 8000, 'ViaCli trabalhando');
  r = await cli(['esperar', CLI_ID, '--max', '2']);
  assert.equal(r.codigo, 4); assert.match(r.erro, /ainda trabalha/);
  assert.equal((await post(`/codex/sessao/${CLI_ID}/parar`, {})).status, 202);
  r = await cli(['esperar', CLI_ID, '--max', '20']);
  assert.equal(r.codigo, 2, r.saida + r.erro); assert.match(r.erro, /interrompido/);
  // Orbit fora do ar: porta que ninguém escuta (efêmera, não a 47821).
  const livrePorta = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  r = await cli(['estado', CLI_ID], { GERENCIADOR_PORTA: String(livrePorta) });
  assert.equal(r.codigo, 1); assert.match(r.erro, /Orbit/);
});

// ───────── subagentes do próprio Codex ─────────
test('subagente do Codex (thread_spawn com pai) vira agentes[] da mãe; guardian não; o sub-thread não é sessão', async () => {
  const MAE = UUID(501), SUB = UUID(502), GUARD = UUID(503);
  rollout(MAE, [meta(MAE), ev('task_started', { turn_id: 'tm', model_context_window: 258400 }), usuario('Coordene a revisão'), agenteMsg('Lancei um revisor.'), ev('task_complete', { turn_id: 'tm', last_agent_message: 'Lancei um revisor.', duration_ms: 10 })]);
  const arqSub = rollout(SUB, [
    meta(SUB, { source: { subagent: { thread_spawn: { parent_thread_id: MAE, depth: 1, agent_nickname: 'Ana', agent_role: 'explorer' } } }, thread_source: 'subagent' }),
    ev('task_started', { turn_id: 'ts', model_context_window: 258400 }), usuario('Procure o bug do login'),
  ]);
  rollout(GUARD, [meta(GUARD, { source: { subagent: { other: 'guardian' } }, thread_source: 'subagent', parent_thread_id: MAE }), ev('task_started', { turn_id: 'tg' }), usuario('revisão automática')]);

  const mae = await esperarQue(async () => { const s = await sessaoDe(MAE); return s?.agentes?.length ? s : null; }, 10000, 'agente na mãe');
  assert.equal(mae.provedor, 'codex');
  assert.equal(mae.agentes.length, 1, 'só o subagente, sem o guardian');
  const a = mae.agentes[0];
  assert.equal(a.id, SUB);
  assert.equal(a.tipo, 'explorer');
  assert.equal(a.status, 'trabalhando');
  assert.match(a.descricao, /^Ana: Procure o bug do login/);
  assert.equal(typeof a.inicio, 'number');
  assert.equal(a.fim, null);
  for (const k of ['id', 'tipo', 'descricao', 'status', 'inicio', 'fim', 'ferramenta', 'ferramentas', 'atividade', 'acoes', 'texto']) assert.ok(k in a, `campo ${k}`);
  assert.ok(!Object.keys(a).some((k) => k[0] === '_'), 'sem campos internos');
  assert.equal(mae.subagentes, 1);
  const todas = (await get('/estado')).json.sessoes;
  assert.ok(!todas.some((s) => s.id === SUB || s.id === GUARD), 'sub-thread e guardian não viram sessão');

  // O subagente termina: status concluido, ativos = 0.
  fs.appendFileSync(arqSub, agenteMsg('Achei: falta validar o token.') + ev('task_complete', { turn_id: 'ts', last_agent_message: 'Achei: falta validar o token.', duration_ms: 5 }));
  const fim = await esperarQue(async () => { const s = await sessaoDe(MAE); return s?.agentes?.[0]?.status === 'concluido' ? s : null; }, 10000, 'subagente concluído');
  assert.equal(fim.subagentes, 0);
  assert.equal(fim.agentes[0].texto, 'Achei: falta validar o token.');
  assert.ok(fim.agentes[0].fim >= fim.agentes[0].inicio);
  assert.ok(!(await sessaoDe(MAE)).pai, 'a mãe não ganha pai por ter subagentes');
});

// ───────── fim ─────────
test('chave desligada de novo: o CLI avisa "Codex desligado" e nenhum processo falso sobra', async () => {
  assert.equal((await post('/config', { codex: { ativo: false } })).status, 200);
  await espera(300);
  const r = await cli(['criar', '--pasta', MEMBRO(), 'oi'], { CLAUDE_CODE_HOST_SESSION_ID: LIDER_EVENTO });
  assert.equal(r.codigo, 1);
  assert.match(r.erro, /Codex desligado/);
  assert.ok(!(await get('/estado')).json.sessoes.some((s) => s.provedor === 'codex'));
  await descer();
  for (const pid of pids) assert.ok(await esperarQue(() => !vivoPid(pid), 5000, `pid ${pid} encerrado`).catch(() => false), `processo falso ${pid} sobrou`);
});
