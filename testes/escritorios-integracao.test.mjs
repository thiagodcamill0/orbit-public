// Integração dos escritórios (Etapa 1, 21/10): liga DE VERDADE escritorios.mjs (+ orçamento), controle.mjs,
// membro.mjs (processo) e escritorio-hook.mjs (processo), sem o servidor.mjs. Só o claude é falso.
// Rodar:  node --test testes/escritorios-integracao.test.mjs
// Um HTTP mínimo (porta 47822–47826, nunca 47821) monta criarControle + criarEscritorios({controle}) e repassa
// /escritorios/* ao escritorios.tratar e o resto ao controle.rota. O claude é o testes/claude-falso.mjs atrás de
// um envoltório temporário que: anota argv, ORBIT_* e as mensagens recebidas; e põe total_cost_usd no `result`
// (custo acumulado por sessão; cada mensagem pode trazer CUSTO:<usd> = quanto aquela volta soma; padrão 0.01).
// Os cenários: execução A (orquestrador + 2 membros, membro.mjs, fim da volta, fim da execução, hook de
// convidados/ações externas) e escritório B (orçamento: aviso e pausa com interromper).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { escolherPorta } from './porta-livre.mjs';
import { matarArvore } from '../plataforma.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47824);
const WIN = process.platform === 'win32';
const realDe = (d) => (fs.mkdirSync(d, { recursive: true }), WIN ? d : fs.realpathSync(d));
const DADOS = realDe(path.join(os.tmpdir(), 'gerenciador-testes', `esc-integracao-${Date.now()}`));
const PASTA = realDe(path.join(DADOS, 'proj'));
const LOG = path.join(DADOS, 'envolto.log');
const ENVOLTO = path.join(DADOS, 'claude-envolto.mjs');
for (const d of ['sessoes', 'projetos']) fs.mkdirSync(path.join(DADOS, d), { recursive: true });

fs.writeFileSync(
  ENVOLTO,
  `import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
const argv = process.argv.slice(2);
const opc = (n) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : '');
const sessao = opc('--session-id') || opc('--resume');
const anotar = (o) => fs.appendFileSync(process.env.ENVOLTO_LOG, JSON.stringify({ sessao, ...o }) + '\\n');
anotar({ argv, orbit: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ORBIT_'))) });
const ch = spawn(process.execPath, [process.env.ENVOLTO_FALSO, ...argv], { stdio: ['pipe', 'pipe', 'inherit'] });
const custos = []; // fila: quanto cada volta soma ao total acumulado da sessão
let total = 0;
const ent = readline.createInterface({ input: process.stdin });
ent.on('line', (l) => {
  if (l.includes('"type":"user"')) {
    anotar({ entrada: l });
    custos.push(Number(/CUSTO:([0-9.]+)/.exec(l)?.[1]) || 0.01);
  }
  ch.stdin.write(l + '\\n');
});
ent.on('close', () => ch.stdin.end());
readline.createInterface({ input: ch.stdout }).on('line', (l) => {
  let j;
  try { j = JSON.parse(l); } catch { return process.stdout.write(l + '\\n'); }
  if (j.type === 'result') Object.assign(j, { total_cost_usd: (total += custos.shift() ?? 0.01), usage: { input_tokens: 10, output_tokens: 3 } });
  process.stdout.write(JSON.stringify(j) + '\\n');
});
ch.on('close', (c) => { process.exitCode = c ?? 0; process.stdin.destroy(); });
`,
);

Object.assign(process.env, {
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_SESSOES_DIR: path.join(DADOS, 'sessoes'),
  ORBIT_PROJETOS_DIR: path.join(DADOS, 'projetos'),
  ORBIT_CLAUDE_BIN: ENVOLTO,
  ORBIT_MOTOR: '0',
  ORBIT_MODELOS: '0',
  ORBIT_MOTOR_MAX: '2',
  ORBIT_MS_INICIO: '5000',
  ENVOLTO_FALSO: path.join(RAIZ, 'testes', 'claude-falso.mjs'),
  ENVOLTO_LOG: LOG,
  FALSO_DEMORA_MS: '1500',
});
delete process.env.ORBIT_CLAUDE_ARGS;
delete process.env.CLAUDE_CODE_HOST_SESSION_ID;

const { criarControle } = await import('../controle.mjs');
const { criarEscritorios, MATCHER_HOOK } = await import('../escritorios.mjs');

const lerJSONCorpo = (req) =>
  new Promise((ok, ko) => {
    let t = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (t += d));
    req.on('end', () => {
      try { ok(JSON.parse(t || '{}')); } catch (e) { ko(e); }
    });
  });

const sessoes = new Map();
const controle = criarControle({
  sessao: (id) => sessoes.get(id),
  sessoes: () => sessoes.values(),
  difundir: () => {},
  difundirSessao: () => {},
  lerJSONCorpo,
  log: () => {},
  lerConfig: () => ({}),
  criarSessao: (o) => sessoes.set(o.id, { id: o.id, cwd: o.cwd, apelido: o.apelido, transcript: o.transcript, status: 'parada' }),
  mcpProtecao: async () => ({ bloquear: ['srv-pendente'], env: {} }),
  tetoEscritorios: 4,
});

// O escritório enxerga o controle por um espião: registra as chamadas e delega ao controle de verdade.
const chamadas = [];
const espiao = {};
for (const f of ['criarInstancia', 'enviarMensagem', 'interromper', 'encerrar', 'avisarLider', 'estado', 'adormecer', 'listarEscritorio']) {
  espiao[f] = (...a) => { chamadas.push([f, ...a]); return controle[f](...a); };
}
espiao.ouvirResultado = (fn) => controle.ouvirResultado(fn);

const alertas = []; // alertas do evento SSE `escritorio` (campo `alerta`): {id, tipo:'aviso'|'pausa', texto, ...}
const celular = []; // notificarCelular(id, nome, texto)
const eventos = [];
let planoPct = 10;
const escritorios = criarEscritorios({
  pasta: path.join(DADOS, 'escritorios'),
  raizOrbit: RAIZ,
  porta: PORTA,
  lerJSONCorpo,
  log: () => {},
  publicar: (tipo, d) => { eventos.push([tipo, d]); if (tipo === 'escritorio' && d.alerta) alertas.push({ id: d.id, ...d.alerta }); },
  notificarCelular: (id, nome, texto) => celular.push([id, nome, texto]),
  sessao: (id) => sessoes.get(id),
  usoPlano: () => ({ cincoHoras: { pct: planoPct } }),
  validarModelo: () => true,
  controle: espiao,
  atrasoFim: 300,
});

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORTA}`);
  if (url.pathname === '/saude') return res.end(JSON.stringify({ pid: process.pid }));
  try {
    if (url.pathname === '/escritorios' || url.pathname.startsWith('/escritorios/')) {
      if (await escritorios.tratar(req, res, url)) return;
    }
    if (!(await controle.rota(req, res, url.pathname, url))) res.writeHead(404).end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(500);
    res.end(e.message);
  }
});
await new Promise((r) => servidor.listen(PORTA, '127.0.0.1', r));

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
after(async () => {
  escritorios.parar();
  const pids = [...controle._procs.values()].map((p) => p.pid).filter(Boolean);
  controle.encerrarTudo();
  await espera(800);
  for (const pid of pids) await Promise.resolve(matarArvore(pid)).catch(() => {});
  await new Promise((r) => servidor.close(r));
  await espera(300);
  fs.rmSync(DADOS, { recursive: true, force: true });
});

// ───────── utilidades ─────────
async function aguardar(fn, ms = 15000, rotulo = 'condição') {
  const fim = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > fim) throw new Error(`tempo esgotado esperando ${rotulo}`);
    await espera(50);
  }
}
const linhas = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const lancamentos = (id) => linhas().filter((l) => l.sessao === id && l.argv);
const entradas = (id) => linhas().filter((l) => l.sessao === id && l.entrada).map((l) => l.entrada);
const opc = (argv, n) => argv[argv.indexOf(n) + 1];
function req(metodo, rota, corpo) {
  return new Promise((ok, ko) => {
    const d = corpo === undefined ? null : JSON.stringify(corpo);
    const q = http.request({
      host: '127.0.0.1', port: PORTA, path: rota, method: metodo,
      headers: { 'x-gerenciador': '1', ...(d ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } : {}) },
    }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => ok({ status: res.statusCode, json: t ? JSON.parse(t) : null }));
    });
    q.on('error', ko);
    q.end(d);
  });
}
const post = (rota, corpo = {}) => req('POST', rota, corpo);
const getJ = async (rota) => (await req('GET', rota)).json;
function processo(args, env, entrada) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, args, { cwd: RAIZ, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (codigo) => ok({ codigo, out, err }));
    p.stdin.end(entrada ?? '');
  });
}
const base = (nome, extra = {}) => ({
  nome, funcao: 'Escritório de teste de integração', pasta: PASTA,
  orquestrador: { prompt: 'Você lidera o escritório de integração.' },
  membros: [
    { id: 'redator', papel: 'Redator', nome: 'Rê', prompt: 'Escreva textos curtos.' },
    { id: 'revisor', papel: 'Revisor', nome: 'Rv', prompt: 'Revise os textos.' },
  ],
  ...extra,
});

// ───────── cenário A: orquestrador + 2 membros ─────────
let A; // id do escritório A
let orq; // sessão do orquestrador da 1ª execução
let envOrq; // ORBIT_* do orquestrador, como o claude o recebeu
let sessRedator;
const doMembro = (...args) => processo(['membro.mjs', ...args], { ...envOrq, CLAUDE_CODE_HOST_SESSION_ID: orq, ORBIT_ESPERA_MS: '200' });

test('A: cria o escritório e aciona: orquestrador nasce com anexo, --settings do hook e ORBIT_*', async () => {
  const c = await post('/escritorios', base('Integração A', { convidados: { limite: 1 }, orcamento: { porExecucaoUsd: 5, porDiaUsd: 50, avisoPct: 80 } }));
  assert.equal(c.status, 200, JSON.stringify(c.json));
  A = c.json.escritorio.id;
  const r = await post(`/escritorios/${A}/acionar`, { tarefa: 'DEMORA:6000 CUSTO:0.1 coordene o trabalho' });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const g = await getJ(`/escritorios/${A}`);
  orq = g.execucao.orquestrador;
  assert.ok(orq);
  assert.equal(g.execucao.status, 'rodando');
  await aguardar(() => lancamentos(orq).length >= 1, 10000, 'o orquestrador subir');
  const l = lancamentos(orq)[0];
  assert.match(opc(l.argv, '--append-system-prompt'), /Você lidera o escritório de integração\./);
  assert.match(opc(l.argv, '--append-system-prompt'), /membro\.mjs/);
  assert.equal(opc(l.argv, '--permission-mode'), 'default');
  const st = JSON.parse(opc(l.argv, '--settings'));
  assert.equal(st.hooks.PreToolUse[0].matcher, MATCHER_HOOK);
  assert.equal(st.disableAllHooks, false);
  assert.ok(st.permissions.allow.some((r) => /membro.mjs/.test(r)), 'allow do membro.mjs no --settings');
  assert.match(st.hooks.PreToolUse[0].hooks[0].command, /escritorio-hook\.mjs/);
  assert.ok(JSON.stringify(st).includes('srv-pendente'), 'o --settings do escritório mescla o bloqueio de MCP do controle');
  envOrq = l.orbit;
  assert.equal(envOrq.ORBIT_ESCRITORIO, A);
  assert.equal(envOrq.ORBIT_EXECUCAO, g.execucao.execucao);
  assert.equal(envOrq.ORBIT_PAPEL, 'orquestrador');
  assert.equal(envOrq.ORBIT_PORTA, String(PORTA));
  const e = controle.estado(orq);
  assert.equal(e.escritorio.id, A);
  assert.equal(e.pai ?? null, null, 'o orquestrador não leva pai');
});

test('A: membro.mjs lista e enviar; o membro nasce com pai, anexo, hook e env próprios', async () => {
  const lst = await doMembro('lista');
  assert.equal(lst.codigo, 0, lst.err);
  assert.match(lst.out, /redator/);
  assert.match(lst.out, /revisor/);
  const env = await doMembro('enviar', 'redator', 'CUSTO:0.1 escreva o texto');
  assert.equal(env.codigo, 0, env.err + env.out);
  assert.match(env.out, /Tarefa enviada ao membro redator/);
  const g = await getJ(`/escritorios/${A}`);
  sessRedator = g.execucao.membros.redator;
  assert.ok(sessRedator);
  await aguardar(() => lancamentos(sessRedator).length >= 1, 10000, 'o membro subir');
  const l = lancamentos(sessRedator)[0];
  assert.match(opc(l.argv, '--append-system-prompt'), /Escreva textos curtos\./);
  assert.equal(opc(l.argv, '--permission-mode'), 'default');
  assert.ok(opc(l.argv, '--settings'));
  assert.equal(l.orbit.ORBIT_PAPEL, 'redator');
  assert.equal(l.orbit.ORBIT_ESCRITORIO, A);
  const e = controle.estado(sessRedator);
  assert.equal(e.pai, orq, 'o membro nasce com pai = orquestrador');
  assert.equal(e.escritorio.papel, 'redator');
  // quem não é o orquestrador não envia (403)
  const r = await new Promise((ok, ko) => {
    const q = http.request({ host: '127.0.0.1', port: PORTA, path: `/escritorios/${A}/membro/revisor/enviar`, method: 'POST', headers: { 'x-gerenciador': '1', 'content-type': 'application/json', 'x-orbit-sessao': sessRedator } }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); });
    q.on('error', ko);
    q.end('{"tarefa":"x"}');
  });
  assert.equal(r, 403);
});

test('A: membro.mjs esperar/estado; fim da volta do membro avisa o líder', async () => {
  const e = await doMembro('esperar', 'redator', '--max', '20');
  assert.equal(e.codigo, 0, e.err + e.out);
  assert.match(e.out, /status: concluida/);
  const s = await doMembro('estado', 'redator');
  assert.equal(s.codigo, 0, s.err);
  assert.match(s.out, /status: concluida/);
  const geral = await doMembro('estado');
  assert.equal(geral.codigo, 0, geral.err);
  assert.match(geral.out, /execução: rodando/);
  assert.match(geral.out, /redator: /);
  assert.match(geral.out, /revisor: sem tarefa/);
  // o líder recebeu "Membro redator concluiu: ..." (entra na fila da volta dele, que está ocupada)
  await aguardar(() => entradas(orq).some((t) => t.includes('Membro redator concluiu')), 8000, 'o aviso ao líder');
  assert.ok(chamadas.some((c) => c[0] === 'avisarLider' && c[1] === orq && /Membro redator concluiu/.test(c[2])));
});

test('A: fim da execução encerra os membros e conclui', async () => {
  const fim = await aguardar(async () => {
    const g = await getJ(`/escritorios/${A}`);
    return g.execucao.status === 'concluida' ? g : null;
  }, 20000, 'a execução concluir');
  assert.equal(fim.execucao.status, 'concluida');
  await aguardar(() => chamadas.some((c) => c[0] === 'encerrar' && c[1] === sessRedator), 5000, 'encerrar o membro');
  await aguardar(() => controle.estado(sessRedator)?.processo !== 'vivo', 10000, 'o membro parar');
  assert.equal(controle.estado(sessRedator).processo, 'dormindo');
  assert.ok(!chamadas.some((c) => c[0] === 'encerrar' && c[1] === orq), 'o orquestrador não é encerrado');
  const resumo = (await getJ('/escritorios')).escritorios.find((x) => x.id === A);
  assert.ok(resumo.custo.execucaoUsd > 0.2, `custo somado das sessões: ${resumo.custo.execucaoUsd}`);
  assert.ok(eventos.some(([t, d]) => t === 'escritorio' && d.id === A));
});

test('A: hook como processo: convidados (limite 1), membro, ação externa', async () => {
  const r = await post(`/escritorios/${A}/acionar`, { tarefa: 'DEMORA:15000 segure a execução' });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const g = await getJ(`/escritorios/${A}`);
  const orq2 = g.execucao.orquestrador;
  assert.notEqual(orq2, orq, 'sessão nova a cada execução');
  await aguardar(() => lancamentos(orq2).length >= 1, 10000, 'o orquestrador 2 subir');
  const env = { ...lancamentos(orq2)[0].orbit };
  const agente = (extra = {}) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'x' }, session_id: orq2, ...extra });
  const decisao = (s) => (s.out.trim() ? JSON.parse(s.out).hookSpecificOutput : null);

  sessoes.get(orq2).agentes = [];
  let h = await processo(['escritorio-hook.mjs'], env, agente());
  assert.equal(h.codigo, 0, h.err);
  assert.equal(h.out.trim(), '', 'abaixo do limite: sem decisão');

  sessoes.get(orq2).agentes = [{ id: 'ag1', status: 'trabalhando' }];
  h = await processo(['escritorio-hook.mjs'], env, agente());
  assert.equal(h.codigo, 0, h.err);
  assert.equal(decisao(h).permissionDecision, 'deny');
  assert.match(decisao(h).permissionDecisionReason, /Limite de convidados do escritório atingido \(1\)/);

  sessoes.get(orq2).agentes = [{ id: 'ag1', status: 'concluido' }];
  h = await processo(['escritorio-hook.mjs'], env, agente({ tool_name: 'Task' }));
  assert.equal(h.out.trim(), '', 'convidado concluído não conta');

  h = await processo(['escritorio-hook.mjs'], { ...env, ORBIT_PAPEL: 'redator' }, agente());
  assert.equal(decisao(h).permissionDecision, 'deny');
  assert.match(decisao(h).permissionDecisionReason, /Membros/);

  h = await processo(['escritorio-hook.mjs'], env, agente({ session_id: 'sessao-que-nao-existe' }));
  assert.equal(decisao(h).permissionDecision, 'deny', 'sessão fora de escritório: falha fechada');

  h = await processo(['escritorio-hook.mjs'], env, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin main' }, session_id: orq2 }));
  assert.equal(decisao(h).permissionDecision, 'ask');
  assert.match(decisao(h).permissionDecisionReason, /^Ação externa: /);
  h = await processo(['escritorio-hook.mjs'], env, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' }, session_id: orq2 }));
  assert.equal(h.out.trim(), '');

  // a execução 2 acaba pausada e liberada só para limpar
  const p = await post(`/escritorios/${A}/pausar`);
  assert.equal(p.status, 200, JSON.stringify(p.json));
  // servidor mudo → deny (falha fechada)
  h = await processo(['escritorio-hook.mjs'], { ...env, ORBIT_PORTA: '47826' }, agente());
  if (PORTA !== 47826) assert.equal(decisao(h).permissionDecision, 'deny');
  // com a execução pausada o Agent também é negado
  h = await processo(['escritorio-hook.mjs'], env, agente());
  assert.equal(decisao(h).permissionDecision, 'deny');
});

// ───────── cenário B: orçamento ─────────
test('B: orçamento: aviso em 50% (alerta + avisarLider) e pausa em 100% com interromper', async () => {
  const c = await post('/escritorios', base('Integração B', { orcamento: { porExecucaoUsd: 1, porDiaUsd: 50, avisoPct: 50 } }));
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const B = c.json.escritorio.id;
  const r = await post(`/escritorios/${B}/acionar`, { tarefa: 'DEMORA:3000 CUSTO:0.6 comece' });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const orqB = (await getJ(`/escritorios/${B}`)).execucao.orquestrador;
  await aguardar(() => controle.estado(orqB)?.ocupada, 10000, 'a volta do orquestrador B');
  // enfileira uma 2ª volta (CUSTO:0.5) enquanto a 1ª demora; o aviso de 50% entra depois dela
  assert.ok(controle.enviarMensagem(orqB, 'CUSTO:0.5 mais um pouco'));
  // 1ª volta termina com 0.6 de 1.0 (60%): aviso
  await aguardar(() => alertas.some((d) => d.id === B && d.tipo === 'aviso'), 15000, 'o alerta de aviso');
  const aviso = alertas.find((d) => d.id === B && d.tipo === 'aviso');
  assert.ok(aviso.pct >= 50 && aviso.pct < 100, `pct ${aviso.pct}`);
  await aguardar(() => chamadas.some((x) => x[0] === 'avisarLider' && x[1] === orqB && /Orçamento em \d+%/.test(x[2])), 5000, 'o avisarLider do orçamento');
  // 2ª volta: 1.1 de 1.0: pausa
  const pausada = await aguardar(async () => {
    const g = await getJ(`/escritorios/${B}`);
    return g.execucao.status === 'pausada' ? g : null;
  }, 15000, 'a pausa por orçamento');
  assert.equal(pausada.execucao.motivoPausa, 'orcamento-execucao');
  assert.ok(chamadas.some((x) => x[0] === 'interromper' && x[1] === orqB));
  assert.ok(alertas.some((d) => d.id === B && d.tipo === 'pausa'), 'alerta de pausa no evento escritorio');
  assert.ok(celular.some(([id]) => id === B), 'notificarCelular chamado na pausa');
  // pausado: membro.mjs esperar sai com 5 e o envio é recusado (409)
  const env = { ...lancamentos(orqB)[0].orbit, CLAUDE_CODE_HOST_SESSION_ID: orqB, ORBIT_ESPERA_MS: '200' };
  const w = await processo(['membro.mjs', 'esperar', 'redator', '--max', '5'], env);
  assert.equal(w.codigo, 5, w.err + w.out);
  const en = await processo(['membro.mjs', 'enviar', 'redator', 'continue'], env);
  assert.equal(en.codigo, 1);
  assert.match(en.err, /pausado/i);
  const lista = (await getJ('/escritorios')).escritorios.find((x) => x.id === B);
  assert.equal(lista.status, 'pausada');
  assert.ok(lista.custo.execucaoUsd >= 1);
});
