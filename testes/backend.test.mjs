// Testes do backend do Gerenciador de instâncias (servidor.mjs, hook.mjs, instalar.mjs).
// Rodar:  node testes/backend.test.mjs
// Sobe um servidor próprio na porta GERENCIADOR_PORTA (padrão 47822 — nunca 47821)
// com uma pasta de dados nova dentro de GERENCIADOR_DADOS (padrão: pasta temporária).
// Não toca no ~/.claude/settings.json: o instalar.mjs é testado numa cópia.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nodeDoHook } from '../instalar.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = Number(process.env.GERENCIADOR_PORTA || 47822);
if (PORTA === 47821) throw new Error('A porta 47821 é a de produção; use outra.');
const BASE = path.resolve(process.env.GERENCIADOR_DADOS || path.join(os.tmpdir(), 'gerenciador-testes'));
const DADOS = path.join(BASE, `rodada-${Date.now()}`);
fs.mkdirSync(DADOS, { recursive: true });
// Registro de sessões falso (o real é ~/.claude/sessions, nunca tocado aqui).
const SESSOES = path.join(DADOS, 'sessoes');
fs.mkdirSync(SESSOES, { recursive: true });

const TICK = 250;
const OCIOSO = 600;
const ENV = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_TICK_MS: String(TICK),
  GERENCIADOR_PID_MS: '300',
  GERENCIADOR_SESSOES_DIR: SESSOES,
  GERENCIADOR_OCIOSO_MS: String(OCIOSO),
};
delete ENV.CLAUDE_CODE_HOST_SESSION_ID; // rodando de dentro de uma sessão dependente, não vaza para os testes

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const novoId = (p = 's') => `${p}-${Date.now().toString(36)}-${++seq}`;

// ───────── HTTP ─────────

function pedir(metodo, rota, corpo, { cabecalho = true, host, cru, conexaoNova } = {}) {
  return new Promise((resolve, reject) => {
    const dados = cru !== undefined ? cru : corpo === undefined ? undefined : JSON.stringify(corpo);
    const headers = {};
    if (cabecalho) headers['x-gerenciador'] = '1';
    if (host) headers.host = host;
    if (dados !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(dados);
    }
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers, timeout: 5000, ...(conexaoNova ? { agent: false } : {}) }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        let json;
        try { json = JSON.parse(texto); } catch {}
        resolve({ status: res.statusCode, json, texto });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? resolve({ status: 'reset' }) : reject(e)));
    if (dados !== undefined) req.write(dados);
    req.end();
  });
}
const get = (rota, o) => pedir('GET', rota, undefined, o);
const post = (rota, corpo, o) => pedir('POST', rota, corpo, o);
// Pasta de sessão do sistema: no Windows 'C:\\proj\\demo', como sempre; no Mac '/proj/demo' (o projeto é o
// último nome do caminho, e um caminho do Windows no Mac seria um nome só).
const pastaSO = (p) => (process.platform === 'win32' ? p : p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/'));
const evento = (ev) => post('/evento', { ts: Date.now(), cwd: pastaSO('C:\\proj\\demo'), ...ev });
const sessao = async (id) => (await get(`/sessao/${encodeURIComponent(id)}`)).json;

async function esperarQue(cond, ms = 4000, passo = 50) {
  const fim = Date.now() + ms;
  let ultimo;
  while (Date.now() < fim) {
    ultimo = await cond();
    if (ultimo) return ultimo;
    await espera(passo);
  }
  return ultimo;
}

// ───────── servidor ─────────

// Nunca falar com (nem desligar) o servidor de outra sessão que esteja na mesma porta: o /saude devolve
// o pid, e o servidor do teste grava "<pid> Orbit (gerenciador..." no log da pasta de dados DESTE teste.
// Conexão nova: o keep-alive do Node (padrão desde o 19) reaproveitaria o socket do servidor que acabou de
// sair, e o ECONNRESET dele parecia "porta ocupada" (visto no Mac, logo depois do descer()).
const portaOcupada = () => get('/saude', { conexaoNova: true }).then((r) => r.status !== 'reset', () => false);
const pidNaPorta = () => get('/saude', { conexaoNova: true }).then((r) => Number(r.json?.pid) || 0, () => 0);
function ehDoTeste(pid) {
  try {
    return !!pid && fs.readFileSync(path.join(DADOS, 'logs', 'servidor.log'), 'utf8').includes(` ${pid} Orbit (gerenciador`);
  } catch {
    return false;
  }
}
const erroPorta = () => new Error(`porta ${PORTA} ocupada por outro servidor; use GERENCIADOR_PORTA=<livre> (47822–47826, conferida antes)`);

let proc = null;
async function subir(extraEnv = {}) {
  // A porta pode levar um instante para ficar livre depois do descer(); ocupada além disso, nunca é nossa.
  if (await portaOcupada() && !(await esperarQue(async () => !(await portaOcupada()), 2000))) throw erroPorta();
  const p = (proc = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env: { ...ENV, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] }));
  p.saida = '';
  // O processo local, não o `proc` global: o descer() zera o global antes da última linha ("desligando").
  p.stdout.on('data', (c) => (p.saida += c));
  p.stderr.on('data', (c) => (p.saida += c));
  const ok = await esperarQue(async () => p.exitCode == null && (await pidNaPorta()) === p.pid, 5000);
  assert.ok(ok, p.exitCode != null ? `o servidor do teste saiu (código ${p.exitCode}); a porta ${PORTA} foi tomada?` : 'servidor não subiu');
}
async function descer() {
  if (!proc) return;
  const p = proc;
  proc = null;
  if (p.exitCode != null) return;
  const saiu = new Promise((r) => p.once('exit', r));
  // Só desliga o processo que este teste criou.
  if ((await pidNaPorta()) === p.pid) try { await post('/desligar', {}); } catch {}
  await Promise.race([saiu, espera(3000)]);
  if (p.exitCode != null || p.signalCode != null) return;
  try { p.kill(); } catch {}
  await Promise.race([saiu, espera(3000)]);
}

// ───────── SSE ─────────

class Fluxo {
  constructor() {
    this.eventos = [];
    this.buf = '';
  }
  abrir() {
    return new Promise((resolve, reject) => {
      this.req = http.get({ host: '127.0.0.1', port: PORTA, path: '/fluxo' }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (c) => {
          this.buf += c;
          let i;
          while ((i = this.buf.indexOf('\n\n')) >= 0) {
            const bloco = this.buf.slice(0, i);
            this.buf = this.buf.slice(i + 2);
            let tipo = 'message';
            let dados = '';
            for (const l of bloco.split('\n')) {
              if (l.startsWith('event: ')) tipo = l.slice(7);
              else if (l.startsWith('data: ')) dados += l.slice(6);
            }
            if (dados) this.eventos.push({ tipo, dados: JSON.parse(dados) });
          }
        });
        resolve();
      });
      this.req.on('error', reject);
    });
  }
  async esperar(pred, ms = 4000) {
    return esperarQue(() => this.eventos.find(pred), ms, 20);
  }
  fechar() {
    try { this.req.destroy(); } catch {}
  }
}

after(async () => {
  await descer();
});

// ───────── testes ─────────

test('sobe e responde /saude com versão 2', async () => {
  await subir();
  const r = await get('/saude');
  assert.equal(r.status, 200);
  assert.equal(r.json.versao, '2');
  assert.equal(typeof r.json.desde, 'number');
  assert.equal(r.json.sessoes, 0);
});

test('segurança: POST sem cabeçalho → 403; Host estranho → 403', async () => {
  assert.equal((await post('/evento', { session_id: 'x' }, { cabecalho: false })).status, 403);
  assert.equal((await post('/limpar', {}, { cabecalho: false })).status, 403);
  assert.equal((await get('/estado', { host: 'malicioso.exemplo:47822' })).status, 403);
});

test('entrada inválida: JSON quebrado, sem session_id, corpo enorme, campos malformados', async () => {
  assert.equal((await post('/evento', undefined, { cru: '{isso não é json' })).status, 400);
  assert.equal((await post('/evento', undefined, { cru: '[1,2]' })).status, 400);
  assert.equal((await post('/evento', { hook_event_name: 'Stop' })).status, 400);
  assert.equal((await post('/evento', { session_id: { a: 1 } })).status, 400);
  const enorme = await post('/evento', { session_id: 'grande', prompt: 'x'.repeat(400 * 1024) });
  assert.ok(enorme.status === 413 || enorme.status === 'reset', `esperava 413, veio ${enorme.status}`);
  // Malformado mas com session_id: não pode derrubar o servidor.
  const r = await post('/evento', {
    session_id: 'malformado',
    hook_event_name: 'PreToolUse',
    ts: 'abc',
    cwd: 123,
    tool_name: { x: 1 },
    tool_input: 'texto',
    pid: 'nan',
    agent_id: 5,
    transcript_path: 42,
  });
  assert.equal(r.status, 200);
  await post('/evento', { session_id: 'malformado', hook_event_name: 'Notification', message: null, notification_type: 7 });
  await post('/evento', { session_id: 'malformado', hook_event_name: 'StopFailure', error: { codigo: 1 } });
  await post('/evento', { session_id: 'malformado', hook_event_name: 'Inventado' });
  assert.equal((await post('/evento', { session_id: 'futuro', hook_event_name: 'Stop', ts: Date.now() + 9e9 })).status, 200);
  assert.equal((await get('/saude')).json.ok, true);
  assert.equal((await get('/sessao/%E0%A4%A')).status, 404);
  assert.equal((await get('/nada')).status, 404);
  await post('/remover', { id: 'malformado' });
  await post('/remover', { id: 'futuro' });
});

test('ciclo completo: nova → trabalhando → aguardando → trabalhando → concluída, com SSE', async () => {
  const f = new Fluxo();
  await f.abrir();
  const ini = await f.esperar((e) => e.tipo === 'inicio');
  assert.ok(ini, 'sem evento inicio');
  for (const k of ['sessoes', 'config', 'resumoDia', 'historico']) assert.ok(k in ini.dados, `inicio sem ${k}`);

  const id = novoId();
  const T = Date.now();
  await evento({ session_id: id, hook_event_name: 'SessionStart', source: 'startup', ts: T, pid: process.pid });
  let s = (await sessao(id)).sessao;
  assert.equal(s.status, 'nova');
  assert.equal(s.projeto, 'demo');
  assert.equal(s.vivo, true);
  assert.equal(s.pid, process.pid);

  await evento({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'Arrumar o   botão\nde voltar', ts: T + 100 });
  s = (await sessao(id)).sessao;
  assert.equal(s.status, 'trabalhando');
  assert.equal(s.tarefa, 'Arrumar o botão de voltar');
  assert.equal(s.primeira, s.tarefa);
  assert.deepEqual(s.turno, { inicio: T + 100, ferramentas: 0 });
  assert.equal(s.contadores.turnos, 1);

  await evento({ session_id: id, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'npm test' }, ts: T + 200 });
  s = (await sessao(id)).sessao;
  assert.deepEqual(s.ferramenta, { nome: 'Bash', alvo: 'npm test', desde: T + 200 });
  assert.equal(s.turno.ferramentas, 1);

  await evento({ session_id: id, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' }, ts: T + 300 });
  s = (await sessao(id)).sessao;
  assert.equal(s.status, 'aguardando');
  assert.equal(s.detalhe, 'Aprovar Bash: npm test');
  const al = await f.esperar((e) => e.tipo === 'alerta' && e.dados.sessao.id === id && e.dados.tipo === 'aguardando');
  assert.ok(al, 'sem alerta aguardando');
  assert.equal(al.dados.notificar, true);
  assert.equal(typeof al.dados.id, 'number');

  // Notification de permissão logo depois não duplica o aviso.
  const r = await evento({ session_id: id, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission', ts: T + 350 });
  assert.equal(r.json.alerta, null);

  await evento({ session_id: id, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu1', ts: T + 1300 });
  s = (await sessao(id)).sessao;
  assert.equal(s.status, 'trabalhando');
  assert.equal(s.ferramenta, null);

  await evento({ session_id: id, hook_event_name: 'Stop', last_assistant_message: 'Pronto: o botão volta.', ts: T + 2300 });
  const det = await sessao(id);
  s = det.sessao;
  assert.equal(s.status, 'concluida');
  assert.equal(s.desde, T + 2300);
  assert.equal(s.ultimaResposta, 'Pronto: o botão volta.');
  assert.equal(s.contadores.esperas, 1);
  assert.equal(s.contadores.msAguardando, 1000);
  assert.equal(s.contadores.msTrabalhando, 1200); // 100→300 e 1300→2300
  assert.ok(await f.esperar((e) => e.tipo === 'alerta' && e.dados.sessao.id === id && e.dados.tipo === 'concluida'));
  assert.ok(await f.esperar((e) => e.tipo === 'resumo'));
  const tipos = det.eventos.map((e) => e.tipo);
  assert.deepEqual(tipos, ['inicio', 'prompt', 'ferramenta', 'permissao', 'concluida']);
  // Campos internos não vazam.
  assert.ok(!Object.keys(s).some((k) => k.startsWith('_')));
  for (const k of ['id', 'status', 'desde', 'titulo', 'apelido', 'projeto', 'cwd', 'tarefa', 'primeira', 'detalhe', 'ferramenta', 'turno', 'ultimaResposta', 'contexto', 'subagentes', 'contadores', 'fixada', 'silenciada', 'pid', 'vivo', 'inicio', 'atividade']) {
    assert.ok(k in s, `Sessao sem ${k}`);
  }
  f.fechar();
});

test('pergunta e plano viram aguardando; elicitação também', async () => {
  const id = novoId();
  const T = Date.now();
  await evento({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'p', ts: T });
  let r = await evento({ session_id: id, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Qual cor?' }] }, ts: T + 10 });
  assert.equal(r.json.alerta, 'aguardando');
  assert.equal((await sessao(id)).sessao.detalhe, 'Pergunta: Qual cor?');
  await evento({ session_id: id, hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', ts: T + 20 });
  r = await evento({ session_id: id, hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', ts: T + 30 });
  assert.equal(r.json.alerta, 'aguardando');
  await evento({ session_id: id, hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', ts: T + 40 });
  r = await evento({ session_id: id, hook_event_name: 'Notification', notification_type: 'elicitation_dialog', message: 'MCP quer saber', ts: T + 50 });
  assert.equal(r.json.alerta, 'aguardando');
  const { eventos } = await sessao(id);
  assert.deepEqual(eventos.map((e) => e.tipo), ['prompt', 'pergunta', 'plano', 'pergunta']);
});

test('fora de ordem: evento atrasado não muda o status; Post antes do Pre não deixa ferramenta aberta', async () => {
  const id = novoId();
  const T = Date.now();
  await evento({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'p', ts: T });
  await evento({ session_id: id, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'x1', ts: T + 60 });
  await evento({ session_id: id, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'x1', tool_input: { file_path: 'a.ts' }, ts: T + 50 });
  assert.equal((await sessao(id)).sessao.ferramenta, null);
  await evento({ session_id: id, hook_event_name: 'Stop', ts: T + 500 });
  await evento({ session_id: id, hook_event_name: 'PostToolUse', tool_name: 'Read', ts: T + 400 });
  await evento({ session_id: id, hook_event_name: 'PermissionRequest', tool_name: 'Bash', ts: T + 450 });
  const { sessao: s, eventos } = await sessao(id);
  assert.equal(s.status, 'concluida');
  // A linha do tempo fica em ordem de ts.
  const ts = eventos.map((e) => e.ts);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
});

test('subagentes: contam, não mudam o status; permissão de subagente prende a sessão', async () => {
  const id = novoId();
  const T = Date.now();
  await evento({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'p', ts: T });
  await evento({ session_id: id, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore', ts: T + 10 });
  await evento({ session_id: id, hook_event_name: 'SubagentStart', agent_id: 'a2', agent_type: 'Plan', ts: T + 11 });
  assert.equal((await sessao(id)).sessao.subagentes, 2);
  await evento({ session_id: id, hook_event_name: 'Stop', ts: T + 20 });
  // Subagente em segundo plano trabalhando depois do Stop: a sessão segue concluída.
  await evento({ session_id: id, hook_event_name: 'PreToolUse', agent_id: 'a1', agent_type: 'Explore', tool_name: 'Grep', tool_input: { pattern: 'foo' }, ts: T + 30 });
  await evento({ session_id: id, hook_event_name: 'PostToolUse', agent_id: 'a1', agent_type: 'Explore', tool_name: 'Grep', ts: T + 40 });
  let s = (await sessao(id)).sessao;
  assert.equal(s.status, 'concluida');
  assert.equal(s.ferramenta, null);
  assert.equal(s.contadores.ferramentas, 1);
  // Permissão pedida pelo subagente: aguardando (o usuário precisa agir).
  const r = await evento({ session_id: id, hook_event_name: 'PermissionRequest', agent_id: 'a1', agent_type: 'Explore', tool_name: 'Bash', tool_input: { command: 'ls' }, ts: T + 50 });
  assert.equal(r.json.alerta, 'aguardando');
  // Aprovada, o subagente segue; a mãe volta ao que era (concluída — o subagente é de segundo plano).
  await evento({ session_id: id, hook_event_name: 'PostToolUse', agent_id: 'a1', tool_name: 'Bash', ts: T + 60 });
  assert.equal((await sessao(id)).sessao.status, 'concluida');
  await evento({ session_id: id, hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Explore', last_assistant_message: 'achei', ts: T + 70 });
  await evento({ session_id: id, hook_event_name: 'SubagentStop', agent_id: 'a2', agent_type: 'Plan', ts: T + 80 });
  s = (await sessao(id)).sessao;
  assert.equal(s.subagentes, 0);
  assert.equal(s.status, 'concluida');
  assert.deepEqual(s.agentes.map((a) => [a.id, a.status]), [['a1', 'concluido'], ['a2', 'concluido']]);
  const { eventos } = await sessao(id);
  assert.equal(eventos.filter((e) => e.tipo === 'subagente').length, 4);
});

test('agentes: descrição vinda do PreToolUse de Agent, ferramenta, espera, falha e poda no próximo prompt', async () => {
  const f = new Fluxo();
  await f.abrir();
  const id = novoId('mae');
  const T = Date.now();
  const ev = (o) => evento({ session_id: id, ...o });
  await ev({ hook_event_name: 'UserPromptSubmit', prompt: 'monta o time', ts: T });
  // Lançamentos pelo agente principal (Agent/Task), na ordem.
  await ev({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tA', tool_input: { description: 'Pesquisar contrato', subagent_type: 'Explore' }, ts: T + 10 });
  await ev({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tB', tool_input: { description: 'Desenhar plano', subagent_type: 'Plan' }, ts: T + 11 });
  await ev({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: 'tC', tool_input: { description: 'Segunda busca', subagent_type: 'Explore' }, ts: T + 12 });
  let s = (await sessao(id)).sessao;
  assert.deepEqual(s.ferramenta, { nome: 'Task', alvo: 'Segunda busca', desde: T + 12 });
  // SubagentStart casa pelo tipo e pela ordem.
  await ev({ hook_event_name: 'SubagentStart', agent_id: 'x1', agent_type: 'Explore', ts: T + 20 });
  await ev({ hook_event_name: 'SubagentStart', agent_id: 'x2', agent_type: 'Plan', ts: T + 21 });
  await ev({ hook_event_name: 'SubagentStart', agent_id: 'x3', agent_type: 'Explore', ts: T + 22 });
  await ev({ hook_event_name: 'SubagentStart', agent_id: 'x4', agent_type: 'Tester', ts: T + 23 }); // sem lançamento casável
  // Fora de ordem: SubagentStart antes do PreToolUse de Agent (sem subagent_type = general-purpose).
  await ev({ hook_event_name: 'SubagentStart', agent_id: 'x5', agent_type: 'general-purpose', ts: T + 30 });
  await ev({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tE', tool_input: { description: 'Geral' }, ts: T + 29 });
  s = (await sessao(id)).sessao;
  const porId = Object.fromEntries(s.agentes.map((a) => [a.id, a]));
  assert.equal(porId.x1.descricao, 'Pesquisar contrato');
  assert.equal(porId.x2.descricao, 'Desenhar plano');
  assert.equal(porId.x3.descricao, 'Segunda busca');
  assert.equal(porId.x4.descricao, '');
  assert.equal(porId.x5.descricao, 'Geral');
  assert.equal(s.subagentes, 5);
  for (const k of ['id', 'tipo', 'descricao', 'status', 'inicio', 'fim', 'ferramenta', 'ferramentas', 'atividade']) assert.ok(k in porId.x1, `agente sem ${k}`);
  assert.deepEqual([porId.x1.tipo, porId.x1.status, porId.x1.inicio, porId.x1.fim], ['Explore', 'trabalhando', T + 20, null]);

  // Ferramenta do subagente: aparece nele, não na sessão.
  await ev({ hook_event_name: 'PreToolUse', agent_id: 'x1', agent_type: 'Explore', tool_name: 'Grep', tool_input: { pattern: 'porHora' }, ts: T + 40 });
  s = (await sessao(id)).sessao;
  let x1 = s.agentes.find((a) => a.id === 'x1');
  assert.deepEqual(x1.ferramenta, { nome: 'Grep', alvo: 'porHora', desde: T + 40 });
  assert.equal(x1.ferramentas, 1);
  assert.equal(x1.atividade, T + 40);
  assert.equal(s.ferramenta?.nome, 'Agent'); // a da mãe segue sendo a última dela
  await ev({ hook_event_name: 'PostToolUse', agent_id: 'x1', tool_name: 'Grep', ts: T + 50 });
  assert.equal((await sessao(id)).sessao.agentes.find((a) => a.id === 'x1').ferramenta, null);

  // Subagente pede aprovação: sessão aguardando, alerta com `agente`, notifica.
  let r = await ev({ hook_event_name: 'PermissionRequest', agent_id: 'x1', agent_type: 'Explore', tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, ts: T + 60 });
  assert.equal(r.json.alerta, 'aguardando');
  s = (await sessao(id)).sessao;
  assert.equal(s.status, 'aguardando');
  assert.equal(s.detalhe, 'Aprovar Bash: rm -rf build');
  assert.equal(s.agentes.find((a) => a.id === 'x1').status, 'aguardando');
  const al = await f.esperar((e) => e.tipo === 'alerta' && e.dados.sessao.id === id && e.dados.agente?.id === 'x1');
  assert.ok(al, 'sem alerta do subagente');
  assert.deepEqual(al.dados.agente, { id: 'x1', tipo: 'Explore', descricao: 'Pesquisar contrato' });
  assert.equal(al.dados.notificar, true);
  // Outro subagente pedindo enquanto a sessão já espera: alerta próprio.
  r = await ev({ hook_event_name: 'PermissionRequest', agent_id: 'x2', agent_type: 'Plan', tool_name: 'Write', tool_input: { file_path: 'plano.md' }, ts: T + 70 });
  assert.equal(r.json.alerta, 'aguardando');
  // x2 aprovado e seguindo: a sessão volta a trabalhar.
  await ev({ hook_event_name: 'PostToolUse', agent_id: 'x2', tool_name: 'Write', ts: T + 80 });
  s = (await sessao(id)).sessao;
  assert.equal(s.status, 'trabalhando');
  assert.equal(s.agentes.find((a) => a.id === 'x2').status, 'trabalhando');

  // Concluído, e falha do lançamento (PostToolUseFailure da ferramenta Agent) → erro.
  await ev({ hook_event_name: 'SubagentStop', agent_id: 'x1', agent_type: 'Explore', ts: T + 90 });
  await ev({ hook_event_name: 'PostToolUseFailure', tool_name: 'Agent', tool_use_id: 'tB', ts: T + 95 });
  s = (await sessao(id)).sessao;
  x1 = s.agentes.find((a) => a.id === 'x1');
  assert.deepEqual([x1.status, x1.fim, x1.ferramenta], ['concluido', T + 90, null]);
  const x2 = s.agentes.find((a) => a.id === 'x2');
  assert.deepEqual([x2.status, x2.fim], ['erro', T + 95]);
  assert.equal(s.subagentes, 3);
  // Concluídos e com erro não notificam (e nem geram alerta).
  const h = (await get('/historico')).json.filter((a) => a.sessao.id === id);
  assert.deepEqual(h.map((a) => a.tipo), ['aguardando', 'aguardando']);

  // A entrega automática do subagente (chega como prompt) não tira ninguém: o concluído continua visível.
  await ev({ hook_event_name: 'UserPromptSubmit', prompt: '<agent-message from="x1">\n[Subagent hand-back] pronto', ts: T + 97 });
  await ev({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>b1</task-id>', ts: T + 98 });
  s = (await sessao(id)).sessao;
  assert.deepEqual(s.agentes.map((a) => a.id).sort(), ['x1', 'x2', 'x3', 'x4', 'x5']);
  // Próximo prompt da mãe tira os terminados; os ativos ficam.
  await ev({ hook_event_name: 'UserPromptSubmit', prompt: 'e agora?', ts: T + 100 });
  s = (await sessao(id)).sessao;
  assert.deepEqual(s.agentes.map((a) => a.id).sort(), ['x3', 'x4', 'x5']);
  // SessionEnd: ativos viram erro.
  await ev({ hook_event_name: 'SessionEnd', reason: 'other', ts: T + 200 });
  s = (await sessao(id)).sessao;
  assert.ok(s.agentes.every((a) => a.status === 'erro'));
  assert.equal(s.subagentes, 0);
  f.fechar();
});

test('agentes: no máximo 20 na lista (sai primeiro o concluído mais antigo)', async () => {
  const id = novoId('muitos');
  const T = Date.now();
  await evento({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'p', ts: T });
  await evento({ session_id: id, hook_event_name: 'SubagentStart', agent_id: 'velho', agent_type: 'Explore', ts: T + 1 });
  await evento({ session_id: id, hook_event_name: 'SubagentStop', agent_id: 'velho', agent_type: 'Explore', ts: T + 2 });
  for (let i = 0; i < 21; i++) await evento({ session_id: id, hook_event_name: 'SubagentStart', agent_id: `n${i}`, agent_type: 'Explore', ts: T + 10 + i });
  const s = (await sessao(id)).sessao;
  assert.equal(s.agentes.length, 20);
  assert.ok(!s.agentes.some((a) => a.id === 'velho'));
  assert.ok(s.agentes.some((a) => a.id === 'n20'));
});

// ───────── subagentes ao vivo (acoes, texto) ─────────

const semCamposInternos = (o) => !JSON.stringify(o).match(/"_(uid|arq|mtime|fechadas|pedido)"/);

test('agentes ao vivo: feed de ações (paralelas, fora de ordem, falha, sem tool_use_id), SSE a cada evento, nada interno na API', async () => {
  const f = new Fluxo();
  await f.abrir();
  const id = novoId('vivo');
  const T = Date.now();
  const ev = (o) => evento({ session_id: id, ...o });
  const ag = async () => (await sessao(id)).sessao.agentes.find((a) => a.id === 'y1');
  await ev({ hook_event_name: 'UserPromptSubmit', prompt: 'time', ts: T });
  await ev({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tY', tool_input: { description: 'Testar o servidor', subagent_type: 'general-purpose' }, ts: T + 1 });
  await ev({ hook_event_name: 'SubagentStart', agent_id: 'y1', agent_type: 'general-purpose', ts: T + 2 });
  let a = await ag();
  assert.deepEqual([a.acoes, a.texto, a.textoTs], [[], '', 0]);

  // Duas ferramentas em paralelo: a em curso é a aberta mais nova.
  await ev({ hook_event_name: 'PreToolUse', agent_id: 'y1', agent_type: 'general-purpose', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'D:\\proj\\servidor.mjs' }, ts: T + 10 });
  const sse = await f.esperar((e) => e.tipo === 'sessao' && e.dados.id === id && e.dados.agentes?.find((x) => x.id === 'y1')?.ferramenta?.nome === 'Read');
  assert.ok(sse, 'o PreToolUse do subagente não foi difundido por SSE');
  assert.ok(semCamposInternos(sse.dados), 'SSE vazou campo interno do agente');
  await ev({ hook_event_name: 'PreToolUse', agent_id: 'y1', agent_type: 'general-purpose', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test' }, ts: T + 20 });
  a = await ag();
  assert.deepEqual(a.ferramenta, { nome: 'Bash', alvo: 'npm test', desde: T + 20 });
  await ev({ hook_event_name: 'PostToolUse', agent_id: 'y1', tool_name: 'Read', tool_use_id: 'r1', ts: T + 30 });
  a = await ag();
  assert.deepEqual(a.ferramenta, { nome: 'Bash', alvo: 'npm test', desde: T + 20 }, 'fechar o Read não pode apagar o Bash em curso');
  assert.deepEqual(a.acoes[0], { nome: 'Read', alvo: 'D:\\proj\\servidor.mjs', ts: T + 10, fim: T + 30 });
  await ev({ hook_event_name: 'PostToolUseFailure', agent_id: 'y1', tool_name: 'Bash', tool_use_id: 'b1', ts: T + 40 });
  a = await ag();
  assert.equal(a.ferramenta, null);
  assert.deepEqual(a.acoes[1], { nome: 'Bash', alvo: 'npm test', ts: T + 20, fim: T + 40, erro: true });
  assert.equal(a.status, 'trabalhando');

  // Post antes do Pre (hooks assíncronos): a ação entra fechada e não prende a ferramenta.
  await ev({ hook_event_name: 'PostToolUse', agent_id: 'y1', tool_name: 'Grep', tool_use_id: 'g1', ts: T + 60 });
  await ev({ hook_event_name: 'PreToolUse', agent_id: 'y1', tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'agentes' }, ts: T + 50 });
  a = await ag();
  assert.equal(a.ferramenta, null);
  assert.deepEqual(a.acoes[2], { nome: 'Grep', alvo: 'agentes', ts: T + 50, fim: T + 50 });

  // Sem tool_use_id (formato antigo): casa pelo nome.
  await ev({ hook_event_name: 'PreToolUse', agent_id: 'y1', tool_name: 'Glob', tool_input: { pattern: '**/*.mjs' }, ts: T + 70 });
  assert.equal((await ag()).ferramenta.nome, 'Glob');
  await ev({ hook_event_name: 'PostToolUse', agent_id: 'y1', tool_name: 'Glob', ts: T + 80 });
  a = await ag();
  assert.equal(a.ferramenta, null);
  assert.equal(a.acoes[3].fim, T + 80);

  // Feed curto: só as 8 mais novas, em ordem de tempo.
  for (let i = 0; i < 6; i++) {
    await ev({ hook_event_name: 'PreToolUse', agent_id: 'y1', tool_name: 'Edit', tool_use_id: `e${i}`, tool_input: { file_path: `f${i}.mjs` }, ts: T + 100 + i * 10 });
    await ev({ hook_event_name: 'PostToolUse', agent_id: 'y1', tool_name: 'Edit', tool_use_id: `e${i}`, ts: T + 105 + i * 10 });
  }
  a = await ag();
  assert.equal(a.acoes.length, 8);
  assert.deepEqual(a.acoes.map((x) => x.alvo), ['agentes', '**/*.mjs', 'f0.mjs', 'f1.mjs', 'f2.mjs', 'f3.mjs', 'f4.mjs', 'f5.mjs']);
  assert.equal(a.ferramentas, 10);

  // Permissão pendente: aguardando e sem ferramenta em curso; a ação continua aberta no feed.
  await ev({ hook_event_name: 'PreToolUse', agent_id: 'y1', tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: 'novo.mjs' }, ts: T + 200 });
  await ev({ hook_event_name: 'PermissionRequest', agent_id: 'y1', tool_name: 'Write', tool_input: { file_path: 'novo.mjs' }, ts: T + 201 });
  a = await ag();
  assert.deepEqual([a.status, a.ferramenta, a.acoes.at(-1).fim], ['aguardando', null, null]);

  // SubagentStop: fecha o que ficou aberto e guarda a mensagem final.
  await ev({ hook_event_name: 'SubagentStop', agent_id: 'y1', agent_type: 'general-purpose', last_assistant_message: '  Pronto:\n3 testes novos,   todos passam.  ', ts: T + 300 });
  a = await ag();
  assert.deepEqual([a.status, a.ferramenta, a.acoes.at(-1).fim], ['concluido', null, T + 300]);
  assert.equal(a.texto, 'Pronto: 3 testes novos, todos passam.');
  assert.equal(a.textoTs, T + 300);
  // Nada interno na API (detalhe, /estado).
  assert.ok(semCamposInternos((await sessao(id)).sessao));
  assert.ok(semCamposInternos((await get('/estado')).json));
  f.fechar();
});

test('agentes ao vivo: última mensagem de texto lida do transcript do subagente; persiste no reinício', async () => {
  const id = novoId('txt');
  const principal = path.join(DADOS, `${id}.jsonl`);
  const pasta = path.join(DADOS, id, 'subagents');
  fs.mkdirSync(pasta, { recursive: true });
  const arq = path.join(pasta, 'agent-z1.jsonl');
  const T = Date.now();
  const msg = (content, dt) => linhaTranscript({ type: 'assistant', isSidechain: true, agentId: 'z1', uuid: 'u' + dt, timestamp: new Date(T + dt).toISOString(), message: { role: 'assistant', model: 'claude-opus-5-5', content } });
  fs.writeFileSync(principal, linhaTranscript({ type: 'user', message: { role: 'user', content: 'oi' }, uuid: 'p1', timestamp: new Date(T).toISOString() }));
  fs.writeFileSync(arq,
    linhaTranscript({ type: 'user', isSidechain: true, message: { role: 'user', content: 'tarefa do agente' }, uuid: 'z0', timestamp: new Date(T).toISOString() }) +
    msg([{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: 'Vou ler o servidor.' }], 10) +
    msg([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'servidor.mjs' } }], 20));
  const f = new Fluxo();
  await f.abrir();
  const ev = (o) => evento({ session_id: id, transcript_path: principal, ...o });
  await ev({ hook_event_name: 'UserPromptSubmit', prompt: 'oi', ts: T });
  await ev({ hook_event_name: 'SubagentStart', agent_id: 'z1', agent_type: 'Explore', ts: T + 5 });
  // Agente com id estranho (sem arquivo): não quebra nada.
  await ev({ hook_event_name: 'SubagentStart', agent_id: '../fora', agent_type: 'Explore', ts: T + 6 });
  const ag = async (aid = 'z1') => (await sessao(id)).sessao.agentes.find((a) => a.id === aid);
  let a = await esperarQue(async () => ((await ag())?.texto ? ag() : null));
  assert.ok(a, 'texto do subagente não foi lido do transcript');
  assert.equal(a.texto, 'Vou ler o servidor.');
  assert.equal(a.textoTs, T + 10);

  // Texto novo e longo: chega por SSE, resumido (≤ 280, com reticências).
  const longo = 'Achei a causa: ' + 'a página esconde a coluna Agora dos filhos. '.repeat(15);
  fs.appendFileSync(arq, msg([{ type: 'text', text: longo }], 30));
  const sse = await f.esperar((e) => e.tipo === 'sessao' && e.dados.id === id && e.dados.agentes?.find((x) => x.id === 'z1')?.texto.startsWith('Achei a causa'), 4000);
  assert.ok(sse, 'texto novo não foi difundido');
  a = sse.dados.agentes.find((x) => x.id === 'z1');
  assert.ok(a.texto.length <= 280 && a.texto.endsWith('…'), `texto não resumido: ${a.texto.length}`);
  assert.equal(a.textoTs, T + 30);
  assert.ok(semCamposInternos(sse.dados));

  // Linha só com ferramenta não apaga o último texto.
  fs.appendFileSync(arq, msg([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } }], 40));
  await espera(TICK * 3);
  assert.ok((await ag()).texto.startsWith('Achei a causa'));
  assert.equal((await ag('../fora')).texto, '');

  // Ações e texto sobrevivem ao reinício (sem vazar os campos internos).
  await ev({ hook_event_name: 'PreToolUse', agent_id: 'z1', tool_name: 'Bash', tool_use_id: 'k1', tool_input: { command: 'ls' }, ts: T + 50 });
  f.fechar();
  await descer();
  await subir();
  a = await ag();
  assert.ok(a.texto.startsWith('Achei a causa'));
  assert.deepEqual(a.ferramenta, { nome: 'Bash', alvo: 'ls', desde: T + 50 });
  assert.deepEqual(a.acoes.map((x) => [x.nome, x.fim]), [['Bash', null]]);
  assert.ok(semCamposInternos((await sessao(id)).sessao));
  // Depois do reinício o Post ainda casa com a ação certa (o tool_use_id persistiu por dentro).
  await ev({ hook_event_name: 'PostToolUse', agent_id: 'z1', tool_name: 'Bash', tool_use_id: 'k1', ts: T + 60 });
  a = await ag();
  assert.deepEqual([a.ferramenta, a.acoes[0].fim], [null, T + 60]);
});

test('detalhe do subagente: pedido, resposta inteira, linha do tempo e métricas do transcript dele', async () => {
  const id = novoId('det');
  const principal = path.join(DADOS, `${id}.jsonl`);
  const pasta = path.join(DADOS, id, 'subagents');
  fs.mkdirSync(pasta, { recursive: true });
  const arq = path.join(pasta, 'agent-d1.jsonl');
  const T = Date.now();
  const iso = (dt) => new Date(T + dt).toISOString();
  const msg = (mid, content, dt) => linhaTranscript({ type: 'assistant', isSidechain: true, agentId: 'd1', uuid: 'u' + dt, timestamp: iso(dt),
    message: { id: mid, role: 'assistant', model: 'claude-opus-5-5', content, usage: { input_tokens: 2, cache_read_input_tokens: 40000, cache_creation_input_tokens: 998 } } });
  const resultado = (uid, erro, dt) => linhaTranscript({ type: 'user', isSidechain: true, uuid: 'r' + dt, timestamp: iso(dt), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: uid, is_error: erro, content: 'x' }] } });
  const longo = 'Relatório final. ' + 'Linha de conclusão detalhada. '.repeat(40);
  fs.writeFileSync(principal, linhaTranscript({ type: 'user', message: { role: 'user', content: 'oi' }, uuid: 'p1', timestamp: iso(0) }));
  fs.writeFileSync(arq,
    linhaTranscript({ type: 'user', isSidechain: true, message: { role: 'user', content: 'Investigue o servidor.\n\nDetalhe em duas partes.' }, uuid: 'd0', timestamp: iso(5) }) +
    msg('m1', [{ type: 'text', text: 'Vou ler.' }], 10) +
    msg('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'servidor.mjs' } }], 11) +
    resultado('t1', false, 15) +
    msg('m2', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }], 20) +
    resultado('t2', true, 25) +
    msg('m3', [{ type: 'text', text: longo }], 30));
  const ev = (o) => evento({ session_id: id, transcript_path: principal, ...o });
  await ev({ hook_event_name: 'UserPromptSubmit', prompt: 'oi', ts: T });
  await ev({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tA', tool_input: { description: 'Investigar', subagent_type: 'Explore', prompt: 'Investigue o servidor.' }, ts: T + 1 });
  await ev({ hook_event_name: 'SubagentStart', agent_id: 'd1', agent_type: 'Explore', ts: T + 2 });

  const r = await get(`/sessao/${id}/agente/d1`);
  assert.equal(r.status, 200);
  const d = r.json;
  assert.equal(d.sessao.id, id);
  assert.deepEqual([d.agente.id, d.agente.descricao, d.transcript, d.parcial], ['d1', 'Investigar', true, false]);
  assert.equal(d.pedido, 'Investigue o servidor.\n\nDetalhe em duas partes.');
  assert.equal(d.pedidoTs, T + 5);
  assert.equal(d.resposta, longo.trim()); // inteira, não os 280 do feed
  assert.equal(d.respostaTs, T + 30);
  assert.deepEqual(d.metricas, { ferramentas: 2, chamadas: 3, erros: 1 });
  assert.deepEqual(d.contexto, { tokens: 41000, modelo: 'claude-opus-5-5', janela: 1000000, pct: 4 }); // 20/10: janela real do modelo
  assert.deepEqual(d.eventos.map((e) => [e.tipo, e.ts - T]), [['prompt', 5], ['fala', 10], ['ferramenta', 11], ['ferramenta', 20], ['erro', 25], ['fala', 30]]);
  assert.equal(d.eventos[2].texto, 'Read: servidor.mjs');
  assert.equal(d.eventos[4].texto, 'Falhou Bash');
  assert.ok(semCamposInternos(d));

  // Ao vivo: o arquivo cresce, o detalhe acompanha; o fim entra na linha do tempo.
  fs.appendFileSync(arq, msg('m4', [{ type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: 'agente' } }], 40));
  await ev({ hook_event_name: 'SubagentStop', agent_id: 'd1', agent_type: 'Explore', ts: T + 50 });
  const d2 = (await get(`/sessao/${id}/agente/d1`)).json;
  assert.equal(d2.metricas.ferramentas, 3);
  assert.equal(d2.agente.status, 'concluido');
  assert.deepEqual(d2.eventos.slice(-2).map((e) => [e.tipo, e.ts - T]), [['ferramenta', 40], ['concluida', 50]]);

  // Sem transcript: o que os hooks deram (prompt do Agent e as ações).
  await ev({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tB', tool_input: { description: 'Sem arquivo', subagent_type: 'Plan', prompt: 'Planeje.' }, ts: T + 60 });
  await ev({ hook_event_name: 'SubagentStart', agent_id: 'd2', agent_type: 'Plan', ts: T + 61 });
  await ev({ hook_event_name: 'PreToolUse', agent_id: 'd2', tool_name: 'Glob', tool_use_id: 'g1', tool_input: { pattern: '*.md' }, ts: T + 62 });
  const d3 = (await get(`/sessao/${id}/agente/d2`)).json;
  assert.deepEqual([d3.transcript, d3.pedido, d3.metricas.ferramentas], [false, 'Planeje.', 1]);
  assert.deepEqual(d3.eventos.map((e) => [e.tipo, e.texto]), [['prompt', 'Planeje.'], ['ferramenta', 'Glob: *.md']]);
  assert.ok(semCamposInternos(d3));

  // Inexistente, id estranho e sessão desconhecida: 404, sem quebrar.
  assert.equal((await get(`/sessao/${id}/agente/nada`)).status, 404);
  assert.equal((await get(`/sessao/${id}/agente/..%2Ffora`)).status, 404);
  assert.equal((await get('/sessao/nao-existe/agente/d1')).status, 404);
});

test('sessão dependente (host_session_id): pai, só aguardando notifica, alerta traz sessao.pai', async () => {
  const mae = novoId('mae');
  const dep = novoId('dep');
  const T = Date.now();
  await evento({ session_id: mae, hook_event_name: 'UserPromptSubmit', prompt: 'p', ts: T });
  await evento({ session_id: dep, host_session_id: mae, hook_event_name: 'UserPromptSubmit', prompt: 'sou o Tester', ts: T + 10 });
  assert.equal((await sessao(dep)).sessao.pai, mae);
  assert.equal((await sessao(mae)).sessao.pai, null);
  // Mesmo id que o próprio: ignorado.
  await evento({ session_id: mae, host_session_id: mae, hook_event_name: 'PostToolUse', tool_name: 'Read', ts: T + 11 });
  assert.equal((await sessao(mae)).sessao.pai, null);

  const ultimo = async () => {
    const h = (await get('/historico')).json.filter((a) => a.sessao.id === dep);
    return h[h.length - 1];
  };
  await evento({ session_id: dep, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' }, ts: T + 20 });
  let a = await ultimo();
  assert.deepEqual([a.tipo, a.notificar, a.sessao.pai], ['aguardando', true, mae]);
  assert.ok(!('agente' in a));
  await evento({ session_id: dep, hook_event_name: 'Stop', ts: T + 30 });
  a = await ultimo();
  assert.deepEqual([a.tipo, a.notificar], ['concluida', false]);
  await evento({ session_id: dep, hook_event_name: 'UserPromptSubmit', prompt: 'de novo', ts: T + 40 });
  await evento({ session_id: dep, hook_event_name: 'StopFailure', error: 'rate_limit', ts: T + 50 });
  a = await ultimo();
  assert.deepEqual([a.tipo, a.notificar], ['erro', false]);
  // A mãe (não dependente) segue notificando a conclusão.
  await evento({ session_id: mae, hook_event_name: 'Stop', ts: T + 60 });
  const hm = (await get('/historico')).json.filter((x) => x.sessao.id === mae);
  assert.equal(hm[hm.length - 1].notificar, true);
  // Silenciada continua mandando, mesmo em aguardando.
  await post(`/sessao/${dep}`, { silenciada: true });
  await evento({ session_id: dep, hook_event_name: 'UserPromptSubmit', prompt: 'x', ts: T + 70 });
  await evento({ session_id: dep, hook_event_name: 'PermissionRequest', tool_name: 'Bash', ts: T + 80 });
  assert.equal((await ultimo()).notificar, false);
});

test('config: GET, merge parcial validado, difusão e persistência', async () => {
  const f = new Fluxo();
  await f.abrir();
  const c0 = (await get('/config')).json;
  assert.equal(c0.lembreteMin, 5);
  assert.equal(c0.notificar.interrompida, false);
  const r = await post('/config', { som: { volume: 0.3 }, naoPerturbe: { inicio: '23:30', fim: '99:99' }, lembreteMin: -1, inventado: 1, notificar: { erro: 'sim', concluida: false } });
  assert.equal(r.status, 200);
  assert.equal(r.json.som.volume, 0.3);
  assert.equal(r.json.som.ativo, true);
  assert.equal(r.json.naoPerturbe.inicio, '23:30');
  assert.equal(r.json.naoPerturbe.fim, '07:00');
  assert.equal(r.json.lembreteMin, 5);
  assert.equal(r.json.notificar.erro, true);
  assert.equal(r.json.notificar.concluida, false);
  assert.ok(!('inventado' in r.json));
  assert.ok(await f.esperar((e) => e.tipo === 'config' && e.dados.som.volume === 0.3));
  assert.equal((await post('/config', undefined, { cru: '"x"' })).status, 400);
  await espera(400);
  const disco = JSON.parse(fs.readFileSync(path.join(DADOS, 'config.json'), 'utf8'));
  assert.equal(disco.som.volume, 0.3);
  await post('/config', { notificar: { concluida: true } });
  f.fechar();
});

test('config.projetos: ícone e tag validados, merge por campo, null restaura', async () => {
  assert.deepEqual((await get('/config')).json.projetos, {});
  let r = await post('/config', { projetos: { Orbit: { icone: 'foguete', cor: '#22C55E' }, Ruim: { icone: '<b>', cor: 'red' }, __proto__x: 1 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.projetos.Orbit, { icone: 'foguete', cor: '#22c55e' });
  assert.ok(!('Ruim' in r.json.projetos));
  r = await post('/config', { projetos: { Orbit: { cor: '' }, Outro: { icone: 'txt:🚀' } } });
  assert.deepEqual(r.json.projetos.Orbit, { icone: 'foguete', cor: '' });
  assert.equal(r.json.projetos.Outro.icone, 'txt:🚀');
  // Foto da galeria: data URL de imagem aceita; outro tipo, HTML ou grande demais, não
  const foto = 'img:data:image/webp;base64,UklGRhYAAABXRUJQVlA4' + 'A'.repeat(40) + '==';
  r = await post('/config', { projetos: { Foto: { icone: foto }, Svg: { icone: 'img:data:image/svg+xml;base64,PHN2Zz4=' },
    Js: { icone: 'img:data:image/png;base64,AAAA"><script>' }, Grande: { icone: 'img:data:image/png;base64,' + 'A'.repeat(60004) } } });
  assert.equal(r.json.projetos.Foto.icone, foto);
  for (const n of ['Svg', 'Js', 'Grande']) assert.ok(!(n in r.json.projetos), n);
  r = await post('/config', { projetos: { Foto: null } });
  r = await post('/config', { projetos: JSON.parse('{"__proto__": {"icone": "pasta"}, "Orbit": null, "Outro": {"icone": "", "cor": ""}}') });
  assert.deepEqual(r.json.projetos, {});
  assert.equal(({}).icone, undefined);
  // 20/10: rotulo = nome de exibição (espaços juntados, até 60); vazio ou igual ao nome da pasta tira o rótulo
  r = await post('/config', { projetos: { Orbit: { rotulo: '  Painel   de\tteste' }, Longo: { rotulo: 'x'.repeat(80) }, Mesmo: { rotulo: 'Mesmo' } } });
  assert.deepEqual(r.json.projetos.Orbit, { icone: '', cor: '', rotulo: 'Painel de teste' });
  assert.equal(r.json.projetos.Longo.rotulo.length, 60);
  assert.ok(!('Mesmo' in r.json.projetos));
  r = await post('/config', { projetos: { Orbit: { cor: '#3b82f6' } } });
  assert.equal(r.json.projetos.Orbit.rotulo, 'Painel de teste');
  r = await post('/config', { projetos: { Orbit: { rotulo: '', cor: '' }, Longo: { rotulo: ' ' } } });
  assert.deepEqual(r.json.projetos, {});
});

test('notificar: config por tipo, sessão silenciada, não perturbe manual e agendado (cruzando a meia-noite)', async () => {
  const id = novoId();
  let T = Date.now();
  const ciclo = async () => {
    T += 1000;
    await evento({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'p', ts: T });
    await evento({ session_id: id, hook_event_name: 'Stop', ts: T + 1 });
    const h = (await get('/historico')).json;
    return h[h.length - 1];
  };
  let a = await ciclo();
  assert.equal(a.tipo, 'concluida');
  assert.equal(a.notificar, true);
  assert.equal(a.sessao.id, id);

  await post(`/sessao/${id}`, { silenciada: true });
  assert.equal((await ciclo()).notificar, false);
  await post(`/sessao/${id}`, { silenciada: false });

  await post('/config', { notificar: { concluida: false } });
  assert.equal((await ciclo()).notificar, false);
  await post('/config', { notificar: { concluida: true } });

  await post('/config', { naoPerturbe: { ativo: true } });
  assert.equal((await ciclo()).notificar, false);
  await post('/config', { naoPerturbe: { ativo: false } });

  // Janela agendada que contém agora e cruza a meia-noite: começa 1 h antes, termina 1 min antes de agora.
  const d = new Date();
  const hhmm = (m) => {
    m = ((m % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };
  const agora = d.getHours() * 60 + d.getMinutes();
  await post('/config', { naoPerturbe: { agendado: true, inicio: hhmm(agora - 60), fim: hhmm(agora - 1) } });
  assert.equal((await ciclo()).notificar, true, 'fora da janela (que cruza a meia-noite) deveria notificar');
  await post('/config', { naoPerturbe: { agendado: true, inicio: hhmm(agora + 2), fim: hhmm(agora + 1) } });
  assert.equal((await ciclo()).notificar, false, 'dentro da janela (de 23h59) não deveria notificar');
  await post('/config', { naoPerturbe: { agendado: true, inicio: hhmm(agora - 1), fim: hhmm(agora + 2) } });
  assert.equal((await ciclo()).notificar, false);
  await post('/config', { naoPerturbe: { agendado: false, inicio: '22:00', fim: '07:00' } });
  assert.equal((await ciclo()).notificar, true);
});

test('lembrete: um único alerta quando continua aguardando além de lembreteMin', async () => {
  await post('/config', { lembreteMin: 0.01 }); // 0,6 s
  const id = novoId();
  await evento({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'p' });
  await evento({ session_id: id, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm x' } });
  const lembretes = async () => (await get('/historico')).json.filter((a) => a.tipo === 'lembrete' && a.sessao.id === id);
  assert.ok(await esperarQue(async () => (await lembretes()).length === 1, 4000), 'sem lembrete');
  await espera(1500);
  assert.equal((await lembretes()).length, 1, 'lembrete repetido');
  // Nova espera reabre o lembrete.
  await evento({ session_id: id, hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  await evento({ session_id: id, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm y' } });
  assert.ok(await esperarQue(async () => (await lembretes()).length === 2, 4000), 'sem segundo lembrete');
  await post('/config', { lembreteMin: 0 });
  await evento({ session_id: id, hook_event_name: 'Stop' });
});

function linhaTranscript(o) {
  return JSON.stringify({ isSidechain: false, sessionId: 'x', ...o }) + '\n';
}

test('transcript: título, contexto, atividade e interrupção (Esc) → interrompida', async () => {
  const id = novoId();
  const arq = path.join(DADOS, `${id}.jsonl`);
  const T = Date.now();
  fs.writeFileSync(
    arq,
    linhaTranscript({ type: 'user', message: { role: 'user', content: 'faz X' }, uuid: 'u1', timestamp: new Date(T).toISOString() }) +
      linhaTranscript({ type: 'ai-title', aiTitle: 'Título da IA' }) +
      linhaTranscript({ type: 'assistant', uuid: 'a1', timestamp: new Date(T + 100).toISOString(), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300, output_tokens: 50 } } }) +
      linhaTranscript({ type: 'assistant', isSidechain: true, uuid: 'a2', message: { role: 'assistant', model: 'outro', usage: { input_tokens: 9 } } }),
  );
  const f = new Fluxo();
  await f.abrir();
  await evento({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'faz X', transcript_path: arq, ts: T });
  const s1 = await esperarQue(async () => {
    const s = (await sessao(id)).sessao;
    return s.contexto ? s : null;
  });
  assert.ok(s1, 'contexto não lido');
  assert.deepEqual(s1.contexto, { tokens: 1302, modelo: 'claude-opus-5-5', janela: 1000000, pct: 0 }); // 20/10: janela real do modelo
  assert.equal(s1.titulo, 'Título da IA');
  assert.equal(s1.status, 'trabalhando');

  // /rename vence o título da IA, mesmo com ai-title mais novo depois.
  fs.appendFileSync(arq, linhaTranscript({ type: 'custom-title', customTitle: 'Meu nome' }) + linhaTranscript({ type: 'ai-title', aiTitle: 'Outro da IA' }));
  assert.ok(await esperarQue(async () => (await sessao(id)).sessao.titulo === 'Meu nome'));

  // Esc: entrada de usuário com o texto da interrupção depois da última resposta.
  const tEsc = Date.now();
  fs.appendFileSync(arq, linhaTranscript({ type: 'user', uuid: 'esc1', timestamp: new Date(tEsc).toISOString(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }));
  const s2 = await esperarQue(async () => {
    const s = (await sessao(id)).sessao;
    return s.status === 'interrompida' ? s : null;
  });
  assert.ok(s2, 'interrupção não detectada');
  assert.equal(s2.desde, tEsc);
  const al = await f.esperar((e) => e.tipo === 'alerta' && e.dados.tipo === 'interrompida' && e.dados.sessao.id === id);
  assert.ok(al);
  assert.equal(al.dados.notificar, false, 'interrompida não notifica por padrão');
  assert.ok(s2.contadores.msTrabalhando >= tEsc - T - 50);

  // Post atrasado da ferramenta interrompida não "desinterrompe".
  await evento({ session_id: id, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', ts: Date.now() });
  assert.equal((await sessao(id)).sessao.status, 'interrompida');

  // Prompt novo (ainda não gravado no transcript): volta a trabalhar e não reinterrompe.
  await espera(20);
  await evento({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'segue', transcript_path: arq });
  await espera(TICK * 4);
  assert.equal((await sessao(id)).sessao.status, 'trabalhando');
  // Outra interrupção depois, essa sim conta (uuid diferente).
  fs.appendFileSync(arq, linhaTranscript({ type: 'user', uuid: 'esc2', timestamp: new Date().toISOString(), message: { role: 'user', content: '[Request interrupted by user]' } }));
  assert.ok(await esperarQue(async () => (await sessao(id)).sessao.status === 'interrompida'));
  const { eventos } = await sessao(id);
  assert.equal(eventos.filter((e) => e.tipo === 'interrompida').length, 2);
  f.fechar();
});

test('transcript: sem UserPromptSubmit (hooks ausentes), o pedido vem do transcript e acompanha; o hook depois manda', async () => {
  const id = novoId();
  const arq = path.join(DADOS, `${id}.jsonl`);
  const usuario = (uuid, content) => linhaTranscript({ type: 'user', uuid, timestamp: new Date().toISOString(), message: { role: 'user', content } });
  fs.writeFileSync(arq, usuario('u1', 'primeiro pedido\n\ncom dois parágrafos'));
  await evento({ session_id: id, hook_event_name: 'SessionStart', transcript_path: arq });
  assert.ok(await esperarQue(async () => (await sessao(id)).sessao.pedido === 'primeiro pedido\n\ncom dois parágrafos'), 'pedido não lido do transcript');

  fs.appendFileSync(arq, usuario('u2', [{ type: 'text', text: 'segundo pedido' }]));
  assert.ok(await esperarQue(async () => (await sessao(id)).sessao.pedido === 'segundo pedido'), 'pedido não acompanhou o transcript');

  // Chegou o hook: ele manda, e o transcript não sobrescreve mais.
  await evento({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'pelo hook', transcript_path: arq });
  fs.appendFileSync(arq, usuario('u3', 'outro do arquivo'));
  await espera(TICK * 4);
  const s = (await sessao(id)).sessao;
  assert.deepEqual([s.pedido, s.tarefa], ['pelo hook', 'pelo hook']);
});

test('vida do processo: pid inexistente → encerrada "processo terminou"; pid vivo segue', async () => {
  const morto = novoId();
  const vivo = novoId();
  await evento({ session_id: morto, hook_event_name: 'UserPromptSubmit', prompt: 'p', pid: 4_000_000 });
  await evento({ session_id: vivo, hook_event_name: 'UserPromptSubmit', prompt: 'p', pid: process.pid });
  const s = await esperarQue(async () => {
    const x = (await sessao(morto)).sessao;
    return x.status === 'encerrada' ? x : null;
  }, 3000);
  assert.ok(s, 'pid morto não detectado');
  assert.equal(s.detalhe, 'processo terminou');
  assert.equal(s.vivo, false);
  await espera(700);
  const v = (await sessao(vivo)).sessao;
  assert.equal(v.status, 'trabalhando');
  assert.equal(v.vivo, true);
  // Evento novo do mesmo id (retomada noutro processo) revive.
  await evento({ session_id: morto, hook_event_name: 'UserPromptSubmit', prompt: 'de novo', pid: process.pid });
  const r = (await sessao(morto)).sessao;
  assert.equal(r.status, 'trabalhando');
  assert.equal(r.vivo, true);
  await evento({ session_id: vivo, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
  const e = (await sessao(vivo)).sessao;
  assert.equal(e.status, 'encerrada');
  assert.equal(e.detalhe, 'prompt_input_exit');
});

// ───────── registro de sessões (~/.claude/sessions falso) ─────────

let arqReg = 900000;
function registro(dados, arquivo = `${++arqReg}.json`) {
  const agora = Date.now();
  const r = { pid: process.pid, cwd: pastaSO('C:\\proj\\registrado'), startedAt: agora - 60e3, kind: 'interactive', entrypoint: 'claude-vscode', status: 'idle', updatedAt: agora, statusUpdatedAt: agora, ...dados };
  fs.writeFileSync(path.join(SESSOES, arquivo), JSON.stringify(r));
  return arquivo;
}
const esperarSessao = (id, cond, ms = 3000) =>
  esperarQue(async () => {
    const r = await get(`/sessao/${encodeURIComponent(id)}`);
    return r.status === 200 && cond(r.json.sessao) ? r.json.sessao : null;
  }, ms);

test('registro: cria a sessão (busy → trabalhando), preenche nome/pai/vivo/registro; arquivo de processo morto não cria', async () => {
  const id = novoId('reg');
  const morta = novoId('regmorta');
  const ini = Date.now() - 60e3;
  const busy = Date.now() - 2000;
  registro({ sessionId: id, name: 'registrado-1a', status: 'busy', statusUpdatedAt: busy, startedAt: ini, hostSessionId: 'mae-do-registro' });
  registro({ sessionId: morta, pid: 4_000_000, name: 'morta' });
  // Lixo na pasta não atrapalha (e .key nunca é lido).
  fs.writeFileSync(path.join(SESSOES, '123.json'), '{ quebrado');
  fs.writeFileSync(path.join(SESSOES, '123.abc.key'), 'segredo');
  const s = await esperarSessao(id, () => true);
  assert.ok(s, 'registro não criou a sessão');
  assert.equal(s.status, 'trabalhando');
  assert.equal(s.desde, busy);
  assert.equal(s.inicio, ini);
  assert.equal(s.nome, 'registrado-1a');
  assert.equal(s.pai, 'mae-do-registro');
  assert.equal(s.projeto, 'registrado');
  assert.equal(s.vivo, true);
  assert.equal(s.pid, process.pid);
  assert.deepEqual(s.registro, { status: 'busy', waitingFor: null, atualizado: busy });
  fs.unlinkSync(path.join(SESSOES, '123.json')); // com um arquivo ilegível a rodada não conclui "sumiu"
  await espera(TICK * 3);
  assert.equal((await get(`/sessao/${morta}`)).status, 404, 'arquivo de processo morto criou sessão');
});

test('registro: sessão só do registro espelha busy/idle sem alerta; waitingFor aparece em registro', async () => {
  const id = novoId('regso');
  const arq = registro({ sessionId: id, status: 'busy', statusUpdatedAt: Date.now() - 1000 });
  assert.ok(await esperarSessao(id, (s) => s.status === 'trabalhando'));
  registro({ sessionId: id, status: 'busy', waitingFor: 'permission', statusUpdatedAt: Date.now() }, arq);
  assert.ok(await esperarSessao(id, (s) => s.registro?.waitingFor === 'permission'));
  const tIdle = Date.now();
  registro({ sessionId: id, status: 'idle', statusUpdatedAt: tIdle }, arq);
  const s = await esperarSessao(id, (x) => x.status === 'concluida', OCIOSO + 2000);
  assert.ok(s, 'idle não virou concluída');
  assert.equal(s.desde, tIdle);
  assert.equal((await get('/historico')).json.filter((a) => a.sessao.id === id).length, 0);
});

test('registro: idle há mais de 10 s (aqui 0,6 s) com a sessão trabalhando e sem Stop → interrompida', async () => {
  const id = novoId('regidle');
  const T = Date.now();
  await evento({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'p', ts: T });
  const tIdle = T + 50;
  registro({ sessionId: id, status: 'idle', statusUpdatedAt: tIdle, name: 'ociosa-1' });
  // Antes do prazo, nada muda.
  await espera(TICK * 2);
  assert.equal((await sessao(id)).sessao.status, 'trabalhando');
  const s = await esperarSessao(id, (x) => x.status === 'interrompida', OCIOSO + 2000);
  assert.ok(s, 'idle não virou interrompida');
  assert.equal(s.desde, tIdle);
  assert.equal(s.nome, 'ociosa-1');
  const h = (await get('/historico')).json.filter((a) => a.sessao.id === id);
  assert.deepEqual(h.map((a) => [a.tipo, a.notificar, a.sessao.nome]), [['interrompida', false, 'ociosa-1']]);
});

test('registro: nunca contradiz um evento de hook mais novo que statusUpdatedAt', async () => {
  const id = novoId('regnovo');
  const T = Date.now();
  registro({ sessionId: id, status: 'idle', statusUpdatedAt: T - 5000 });
  await evento({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'p', ts: T });
  await espera(OCIOSO + TICK * 4);
  assert.equal((await sessao(id)).sessao.status, 'trabalhando');
  // Também não "desconclui": busy antigo depois de um Stop mais novo.
  const id2 = novoId('regstop');
  await evento({ session_id: id2, hook_event_name: 'UserPromptSubmit', prompt: 'p', ts: T });
  await evento({ session_id: id2, hook_event_name: 'Stop', ts: T + 100 });
  registro({ sessionId: id2, status: 'busy', statusUpdatedAt: T + 50 });
  await espera(TICK * 4);
  assert.equal((await sessao(id2)).sessao.status, 'concluida');
});

test('registro: sumiu com o processo vivo → registro null; sumiu e o processo morreu → encerrada', async () => {
  const filho = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  await espera(200);
  const id = novoId('regfim');
  const arq = registro({ sessionId: id, pid: filho.pid, status: 'busy', statusUpdatedAt: Date.now() });
  assert.ok(await esperarSessao(id, (s) => s.vivo === true && s.pid === filho.pid));
  fs.unlinkSync(path.join(SESSOES, arq));
  const s = await esperarSessao(id, (x) => x.registro === null);
  assert.ok(s);
  assert.equal(s.status, 'trabalhando');
  filho.kill();
  const e = await esperarSessao(id, (x) => x.status === 'encerrada', 4000);
  assert.ok(e, 'processo morto não encerrou');
  assert.equal(e.detalhe, 'processo terminou');
  assert.equal(e.vivo, false);
});

test('registro: sessão tirada da lista não volta pelo registro; volta por evento de hook', async () => {
  const id = novoId('regtirada');
  registro({ sessionId: id, status: 'idle' });
  assert.ok(await esperarSessao(id, () => true));
  await post('/remover', { id });
  await espera(TICK * 4);
  assert.equal((await get(`/sessao/${id}`)).status, 404, 'registro recriou a sessão removida');
  await evento({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'voltei' });
  const s = (await sessao(id)).sessao;
  assert.equal(s.status, 'trabalhando');
  assert.ok(await esperarSessao(id, (x) => x.registro?.status === 'idle'));
});

test('ações: POST /sessao/:id (validação), /remover, /limpar respeita fixadas', async () => {
  const a = novoId();
  const b = novoId();
  const c = novoId();
  await evento({ session_id: a, hook_event_name: 'Stop' });
  await evento({ session_id: b, hook_event_name: 'Stop' });
  await evento({ session_id: c, hook_event_name: 'UserPromptSubmit', prompt: 'p' });
  assert.equal((await post(`/sessao/${a}`, { fixada: 'sim' })).status, 400);
  assert.equal((await post(`/sessao/${a}`, { apelido: 3 })).status, 400);
  assert.equal((await post('/sessao/nao-existe', { fixada: true })).status, 404);
  const r = await post(`/sessao/${a}`, { fixada: true, apelido: '  Backend   do gerenciador  ' });
  assert.equal(r.status, 200);
  assert.equal(r.json.sessao.apelido, 'Backend do gerenciador');
  assert.equal(r.json.sessao.fixada, true);
  const l = await post('/limpar', {});
  assert.ok(l.json.removidas >= 1);
  const ids = (await get('/estado')).json.sessoes.map((s) => s.id);
  assert.ok(ids.includes(a), 'fixada saiu');
  assert.ok(!ids.includes(b), 'concluída ficou');
  assert.ok(ids.includes(c), 'trabalhando saiu');
  assert.equal((await post('/remover', { id: c })).json.removida, true);
  assert.equal((await post('/remover', {})).status, 400);
  assert.equal((await get(`/sessao/${c}`)).status, 404);
});

test('resumoDia e histórico', async () => {
  const est = (await get('/estado')).json;
  const r = est.resumoDia;
  const d = new Date();
  assert.equal(r.data, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  assert.ok(r.turnos > 5);
  assert.ok(r.esperas > 0);
  assert.ok(r.msTrabalhando > 0);
  assert.ok(r.sessoes > 3);
  assert.ok(!('_ids' in r));
  const h = (await get('/historico')).json;
  assert.ok(h.length > 5);
  const ids = h.map((a) => a.id);
  assert.deepEqual(ids, [...ids].sort((x, y) => x - y));
  for (const a of h) assert.ok(['concluida', 'aguardando', 'erro', 'lembrete', 'interrompida'].includes(a.tipo));
  // porHora: 24 posições, e as somas batem com os totais do dia.
  const p = r.porHora;
  for (const k of ['trabalhandoMs', 'concluidas', 'esperas', 'aguardandoMs']) assert.equal(p[k].length, 24, `porHora.${k}`);
  const soma = (v) => v.reduce((x, y) => x + y, 0);
  assert.equal(soma(p.trabalhandoMs), r.msTrabalhando);
  assert.equal(soma(p.aguardandoMs), r.msAguardando);
  assert.equal(soma(p.esperas), r.esperas);
  assert.ok(p.concluidas[d.getHours()] >= 1);
});

test('porHora: trecho que cruza a virada da hora é repartido entre as duas', async (t) => {
  const agora = new Date();
  if (agora.getHours() === 0) return t.skip('a hora anterior é de ontem');
  const virada = new Date(agora);
  virada.setMinutes(0, 0, 0);
  const T0 = virada.getTime();
  const h = agora.getHours();
  const antes = (await get('/estado')).json.resumoDia.porHora;
  const id = novoId('hora');
  await evento({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'p', ts: T0 - 1500 });
  await evento({ session_id: id, hook_event_name: 'PermissionRequest', tool_name: 'Bash', ts: T0 + 2500 });
  await evento({ session_id: id, hook_event_name: 'Stop', ts: T0 + 4000 });
  const depois = (await get('/estado')).json.resumoDia.porHora;
  assert.equal(depois.trabalhandoMs[h - 1] - antes.trabalhandoMs[h - 1], 1500);
  assert.equal(depois.trabalhandoMs[h] - antes.trabalhandoMs[h], 2500);
  assert.equal(depois.aguardandoMs[h] - antes.aguardandoMs[h], 1500);
  assert.equal(depois.esperas[h] - antes.esperas[h], 1);
  assert.equal(depois.concluidas[h] - antes.concluidas[h], 1);
});

test('persistência: reinício preserva estado, config, histórico; limpeza de antigas; JSON corrompido', async () => {
  // Esvazia o registro falso: senão ele recria as sessões depois do JSON corrompido.
  for (const n of fs.readdirSync(SESSOES)) fs.unlinkSync(path.join(SESSOES, n));
  const velha = novoId('velha');
  const velhaFixa = novoId('velhafixa');
  const encerradaVelha = novoId('enc');
  const ha49h = Date.now() - 49 * 3600e3;
  await evento({ session_id: velha, hook_event_name: 'Stop', ts: ha49h });
  await evento({ session_id: velhaFixa, hook_event_name: 'Stop', ts: ha49h });
  await post(`/sessao/${velhaFixa}`, { fixada: true });
  await evento({ session_id: encerradaVelha, hook_event_name: 'SessionEnd', ts: Date.now() - 13 * 3600e3 });
  await post('/config', { som: { volume: 0.25 } });
  const antes = (await get('/estado')).json.sessoes.length;
  const hAntes = (await get('/historico')).json.length;
  await descer();
  assert.ok(!fs.readdirSync(DADOS).some((n) => n.endsWith('.tmp')), 'sobrou .tmp');

  await subir();
  const depois = (await get('/estado')).json.sessoes;
  const ids = depois.map((s) => s.id);
  assert.ok(!ids.includes(velha), 'parada há 48 h ficou');
  assert.ok(!ids.includes(encerradaVelha), 'encerrada há 12 h ficou');
  assert.ok(ids.includes(velhaFixa), 'fixada saiu sozinha');
  assert.equal(depois.length, antes - 2);
  assert.equal((await get('/config')).json.som.volume, 0.25);
  assert.equal((await get('/historico')).json.length, hAntes);
  const comEventos = await sessao(velhaFixa);
  assert.equal(comEventos.eventos.length, 1);
  await descer();

  // JSON corrompido: sobe vazio, guarda o arquivo ruim de lado.
  fs.writeFileSync(path.join(DADOS, 'estado.json'), '{"sessoes": [ {"id": "x", ');
  fs.writeFileSync(path.join(DADOS, 'config.json'), 'lixo');
  await subir();
  assert.equal((await get('/estado')).json.sessoes.length, 0);
  assert.equal((await get('/config')).json.lembreteMin, 5);
  assert.ok(fs.readdirSync(DADOS).some((n) => n.startsWith('estado.json.corrompido-')));
  await evento({ session_id: novoId(), hook_event_name: 'UserPromptSubmit', prompt: 'p' });
  assert.equal((await get('/estado')).json.sessoes.length, 1);
});

test('estado da v1 (sem campos novos) é migrado na carga', async () => {
  await descer();
  const v1 = {
    sessoes: [
      { id: 'v1-a', status: 'concluida', inicio: Date.now() - 5000, ts: Date.now() - 1000, atividade: Date.now() - 1000, titulo: 'Antiga', tarefa: 't', primeira: 'p', detalhe: '', cwd: pastaSO('C:\\x\\app'), projeto: 'app' },
    ],
  };
  fs.writeFileSync(path.join(DADOS, 'estado.json'), JSON.stringify(v1));
  await subir();
  const s = (await sessao('v1-a')).sessao;
  assert.equal(s.status, 'concluida');
  assert.equal(s.titulo, 'Antiga');
  assert.equal(s.contadores.turnos, 0);
  assert.equal(s.fixada, false);
  assert.equal(s.vivo, null);
  assert.ok(!('ts' in s));
});

test('estado da rodada 1 (_subs) vira agentes; resumo sem porHora ganha porHora', async () => {
  await descer();
  const agora = Date.now();
  const r1 = {
    versao: 2,
    sessoes: [
      { id: 'r1-a', status: 'trabalhando', desde: agora - 1000, inicio: agora - 5000, atividade: agora - 1000, subagentes: 1, _subs: { ag1: { tipo: 'Explore', desde: agora - 900, visto: agora - 800 } }, contadores: { turnos: 1, ferramentas: 2, esperas: 0, msTrabalhando: 10, msAguardando: 0 } },
    ],
    resumo: { data: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })(), turnos: 3, msTrabalhando: 50, msAguardando: 0, esperas: 0, sessoes: 1, _ids: ['r1-a'] },
  };
  fs.writeFileSync(path.join(DADOS, 'estado.json'), JSON.stringify(r1));
  await subir();
  const s = (await sessao('r1-a')).sessao;
  assert.equal(s.subagentes, 1);
  assert.deepEqual(s.agentes.map((a) => [a.id, a.tipo, a.status, a.descricao]), [['ag1', 'Explore', 'trabalhando', '']]);
  assert.equal(s.nome, '');
  assert.equal(s.pai, null);
  assert.equal(s.registro, null);
  const r = (await get('/estado')).json.resumoDia;
  assert.equal(r.turnos, 3);
  assert.equal(r.porHora.trabalhandoMs.length, 24);
});

// ───────── uso do plano (status line) ─────────

test('uso: POST /uso guarda cincoHoras/semanal (renova em ms), difunde SSE uso, aparece em /estado e no inicio', async () => {
  const f = new Fluxo();
  await f.abrir();
  assert.equal((await post('/uso', { rate_limits: {} }, { cabecalho: false })).status, 403);
  assert.equal((await post('/uso', undefined, { cru: '[1]' })).status, 400);
  assert.equal((await post('/uso', undefined, { cru: '{quebrado' })).status, 400);
  const T = Date.now();
  const r = await post('/uso', {
    ts: T,
    rate_limits: { five_hour: { used_percentage: 34.25, resets_at: 1791990000 }, seven_day: { used_percentage: 12, resets_at: 1792400000 } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.uso, true);
  const esperado = { cincoHoras: { pct: 34.3, renova: 1791990000000 }, semanal: { pct: 12, renova: 1792400000000 }, atualizado: T };
  const ev = await f.esperar((e) => e.tipo === 'uso');
  assert.ok(ev, 'sem SSE uso');
  assert.deepEqual(ev.dados, esperado);
  assert.deepEqual((await get('/estado')).json.uso, esperado);
  assert.deepEqual((await get('/uso')).json, esperado);
  // Mais velho que o atual (outra sessão atrasada): ignorado.
  await post('/uso', { ts: T - 5000, rate_limits: { five_hour: { used_percentage: 99, resets_at: 1791990000 } } });
  assert.equal((await get('/uso')).json.cincoHoras.pct, 34.3);
  // Só uma das janelas: a outra vira null; sem rate_limits o uso não muda.
  await post('/uso', { ts: T + 10, rate_limits: { seven_day: { used_percentage: 13, resets_at: 1792400000 } } });
  assert.deepEqual((await get('/uso')).json, { cincoHoras: null, semanal: { pct: 13, renova: 1792400000000 }, atualizado: T + 10 });
  await post('/uso', { ts: T + 20, context_window: { context_window_size: 200000 } });
  assert.equal((await get('/uso')).json.atualizado, T + 10);
  await post('/uso', { ts: T + 30, rate_limits: { five_hour: { used_percentage: 40, resets_at: 1791990000 }, seven_day: { used_percentage: 13, resets_at: 1792400000 } } });
  f.fechar();
  const g = new Fluxo();
  await g.abrir();
  const ini = await g.esperar((e) => e.tipo === 'inicio');
  assert.deepEqual(ini.dados.uso.cincoHoras, { pct: 40, renova: 1791990000000 });
  g.fechar();
  // Persistido no estado.json.
  await espera(700);
  const disco = JSON.parse(fs.readFileSync(path.join(DADOS, 'estado.json'), 'utf8'));
  assert.equal(disco.uso.cincoHoras.pct, 40);
});

test('uso: context_window da status line vira contexto.janela/pct; o transcript depois recalcula o pct', async () => {
  const id = novoId('ctx');
  const arq = path.join(DADOS, `${id}.jsonl`);
  const linha = (tokens) =>
    linhaTranscript({ type: 'assistant', uuid: `a${tokens}`, timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'claude-opus-5-5', content: [], usage: { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  fs.writeFileSync(arq, linha(1000));
  await evento({ session_id: id, hook_event_name: 'UserPromptSubmit', prompt: 'p', transcript_path: arq });
  assert.ok(await esperarQue(async () => (await sessao(id)).sessao.contexto?.tokens === 1000));
  // Sessão desconhecida: a status line não cria sessão.
  await post('/uso', { session_id: 'fantasma-' + id, context_window: { context_window_size: 200000, used_percentage: 3 } });
  assert.equal((await get(`/sessao/fantasma-${id}`)).status, 404);
  const r = await post('/uso', { session_id: id, model: { id: 'claude-opus-5-5[1m]' }, context_window: { total_input_tokens: 122000, context_window_size: 1000000, used_percentage: 12 } });
  assert.equal(r.json.sessao, true);
  let s = (await sessao(id)).sessao;
  assert.deepEqual(s.contexto, { tokens: 122000, modelo: 'claude-opus-5-5', janela: 1000000, pct: 12 });
  // Transcript com mais tokens: pct recalculado pela janela da status line.
  await espera(20); // mtime novo
  fs.appendFileSync(arq, linha(500000));
  s = await esperarQue(async () => {
    const x = (await sessao(id)).sessao;
    return x.contexto.tokens === 500000 ? x : null;
  });
  assert.ok(s, 'transcript não atualizou o contexto');
  assert.deepEqual(s.contexto, { tokens: 500000, modelo: 'claude-opus-5-5', janela: 1000000, pct: 50 });
  // used_percentage null: pct calculado pelos tokens conhecidos.
  await post('/uso', { session_id: id, context_window: { total_input_tokens: 0, context_window_size: 2000000, used_percentage: null } });
  s = (await sessao(id)).sessao;
  assert.deepEqual([s.contexto.tokens, s.contexto.janela, s.contexto.pct], [500000, 2000000, 25]);
});

// ───────── hook.mjs ─────────

function rodarHook(entrada, env = ENV, args = []) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const p = spawn(process.execPath, [path.join(RAIZ, 'hook.mjs'), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('exit', (codigo) => resolve({ codigo, out, err, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    p.stdin.end(typeof entrada === 'string' ? entrada : JSON.stringify(entrada));
  });
}

test('hook: manda os campos do contrato, pid = processo pai, sem stdout, exit 0, rápido', async () => {
  const id = novoId('hook');
  const arq = path.join(DADOS, `${id}.jsonl`);
  fs.writeFileSync(arq, linhaTranscript({ type: 'ai-title', aiTitle: 'Pelo hook' }));
  const r = await rodarHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: id,
    cwd: pastaSO('C:\\proj\\hookdemo'),
    transcript_path: arq,
    prompt: 'y'.repeat(1000),
  });
  assert.equal(r.codigo, 0);
  assert.equal(r.out, '');
  let s = (await sessao(id)).sessao;
  assert.equal(s.status, 'trabalhando');
  assert.equal(s.pid, process.pid, 'pid deveria ser o ppid do hook (este processo)');
  assert.equal(s.titulo, 'Pelo hook');
  assert.equal(s.tarefa.length, 140);

  await rodarHook({ hook_event_name: 'PreToolUse', session_id: id, tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: 'C:/a/b.ts', content: 'z'.repeat(50000) } });
  s = (await sessao(id)).sessao;
  assert.deepEqual([s.ferramenta?.nome, s.ferramenta?.alvo], ['Write', 'C:/a/b.ts']);
  // Lançamento de subagente: o hook manda descrição e tipo (o prompt não) e o SubagentStart casa.
  await rodarHook({ hook_event_name: 'PreToolUse', session_id: id, tool_name: 'Agent', tool_use_id: 'ag-t1', tool_input: { description: 'Revisar o backend', subagent_type: 'Explore', prompt: 'p'.repeat(20000) } });
  await rodarHook({ hook_event_name: 'SubagentStart', session_id: id, agent_id: 'ag1', agent_type: 'Explore' });
  s = (await sessao(id)).sessao;
  assert.equal(s.subagentes, 1);
  assert.deepEqual(s.agentes.map((a) => [a.id, a.tipo, a.descricao]), [['ag1', 'Explore', 'Revisar o backend']]);
  assert.equal(s.pai, null);
  // Sessão dependente: o hook lê CLAUDE_CODE_HOST_SESSION_ID do ambiente.
  const dep = novoId('hookdep');
  await rodarHook({ hook_event_name: 'SessionStart', session_id: dep, source: 'startup' }, { ...ENV, CLAUDE_CODE_HOST_SESSION_ID: id });
  assert.equal((await sessao(dep)).sessao.pai, id);
  await rodarHook({ hook_event_name: 'Stop', session_id: id, last_assistant_message: 'r'.repeat(25000) });
  s = (await sessao(id)).sessao;
  assert.equal(s.status, 'concluida');
  assert.equal(s.ultimaResposta.length, 20000);

  // Entrada ruim: sai 0, sem stdout.
  for (const ruim of ['', 'não é json', '[]', '{"hook_event_name":"Stop"}']) {
    const x = await rodarHook(ruim);
    assert.equal(x.codigo, 0);
    assert.equal(x.out, '');
  }

  // Tempo com o servidor no ar (comparado com um node vazio).
  const vazio = [];
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    spawnSync(process.execPath, ['-e', '0']);
    vazio.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const tempos = [];
  for (let i = 0; i < 10; i++) {
    tempos.push((await rodarHook({ hook_event_name: i % 2 ? 'PostToolUse' : 'PreToolUse', session_id: id, tool_name: 'Read', tool_input: { file_path: 'x' } })).ms);
  }
  const titulos = [];
  const grande = path.join(DADOS, `${id}-grande.jsonl`);
  fs.writeFileSync(grande, linhaTranscript({ type: 'x', texto: 'a'.repeat(2_000_000) }) + linhaTranscript({ type: 'ai-title', aiTitle: 'Fim' }));
  for (let i = 0; i < 5; i++) {
    titulos.push((await rodarHook({ hook_event_name: 'Stop', session_id: id, transcript_path: grande })).ms);
  }
  const med = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  console.log(`# tempo do hook (mediana): node vazio ${med(vazio).toFixed(0)} ms · ferramenta ${med(tempos).toFixed(0)} ms (máx ${Math.max(...tempos).toFixed(0)}) · Stop com transcript de 2 MB ${med(titulos).toFixed(0)} ms`);
  assert.ok(med(tempos) < 1000, 'hook lento demais');
  assert.ok(Math.max(...titulos) < 1000, 'hook com título lento demais');
});

test('hook com --subir (permissão "abrir sozinho"): servidor fora do ar → sobe o servidor e entrega o evento', async () => {
  await descer();
  if (await portaOcupada()) throw erroPorta(); // o hook entregaria o evento ao servidor de outra sessão
  const id = novoId('auto');
  const r = await rodarHook({ hook_event_name: 'UserPromptSubmit', session_id: id, prompt: 'acorda' }, ENV, ['--subir']);
  assert.equal(r.codigo, 0);
  assert.equal(r.out, '');
  const saude = await esperarQue(async () => {
    try {
      return (await get('/saude')).json;
    } catch {
      return null;
    }
  });
  assert.ok(saude, 'servidor não subiu pelo hook');
  assert.equal(saude.versao, '2');
  assert.equal((await sessao(id)).sessao.status, 'trabalhando');
  console.log(`# hook com servidor fora: ${r.ms.toFixed(0)} ms até entregar`);
  assert.ok(ehDoTeste(saude.pid), 'o servidor na porta não é o que o hook subiu para este teste; não desligo');
  await post('/desligar', {});
  await esperarQue(async () => {
    try {
      await get('/saude');
      return false;
    } catch {
      return true;
    }
  });
});

// ───────── statusline.mjs ─────────

// Formato que o Claude Code 2.1.296 monta para a status line (conferido no binário).
const STATUS_REAL = {
  session_id: 'sessao-status',
  transcript_path: 'C:/x.jsonl',
  cwd: 'C:\\proj',
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  workspace: { current_dir: 'C:\\proj', project_dir: 'C:\\proj', added_dirs: [] },
  version: '2.1.296',
  output_style: { name: 'default' },
  cost: { total_cost_usd: 1.23, total_duration_ms: 1000, total_api_duration_ms: 500, total_lines_added: 3, total_lines_removed: 1 },
  context_window: { total_input_tokens: 122000, total_output_tokens: 900, context_window_size: 200000, current_usage: {}, used_percentage: 61, remaining_percentage: 39 },
  exceeds_200k_tokens: false,
  rate_limits: { five_hour: { used_percentage: 34.2, resets_at: 1791990000 }, seven_day: { used_percentage: 12, resets_at: 1792400000 } },
};

function rodarStatus(entrada, env = ENV) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const p = spawn(process.execPath, [path.join(RAIZ, 'statusline.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.on('exit', (codigo) => resolve({ codigo, out, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    p.stdin.end(typeof entrada === 'string' ? entrada : JSON.stringify(entrada));
  });
}

test('statusline: servidor fora → imprime a linha e sai rápido, sem subir o servidor', async () => {
  const tempos = [];
  for (let i = 0; i < 7; i++) {
    const r = await rodarStatus(STATUS_REAL);
    assert.equal(r.codigo, 0);
    assert.equal(r.out, '● 5h 34% · sem 12% · ctx 61%\n');
    tempos.push(r.ms);
  }
  const vazio = [];
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    spawnSync(process.execPath, ['-e', '0']);
    vazio.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const med = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  console.log(`# statusline com servidor fora (do spawn à saída, mediana): ${med(tempos).toFixed(0)} ms (máx ${Math.max(...tempos).toFixed(0)}) · node vazio ${med(vazio).toFixed(0)} ms`);
  assert.ok(med(tempos) < 150, 'statusline lenta');
  await espera(500);
  let subiu = true;
  try {
    await get('/saude');
  } catch {
    subiu = false;
  }
  assert.equal(subiu, false, 'statusline subiu o servidor');
  // Variações: sem rate_limits (chave de API / antes da 1ª resposta), lixo, vazio.
  assert.equal((await rodarStatus({ model: { display_name: 'Opus 5.5' }, context_window: { context_window_size: 200000, used_percentage: null } })).out, '● Opus 5.5\n');
  assert.equal((await rodarStatus({ context_window: { total_input_tokens: 50000, context_window_size: 200000 } })).out, '● ctx 25%\n');
  for (const ruim of ['', 'lixo', '[]', 'null']) {
    const r = await rodarStatus(ruim);
    assert.equal(r.codigo, 0);
    assert.equal(r.out, '●\n');
  }
});

test('statusline: servidor no ar → repassa uso e contexto (POST /uso)', async () => {
  await subir();
  await evento({ session_id: 'sessao-status', hook_event_name: 'UserPromptSubmit', prompt: 'p' });
  const tempos = [];
  for (let i = 0; i < 5; i++) {
    const r = await rodarStatus(STATUS_REAL);
    assert.equal(r.out, '● 5h 34% · sem 12% · ctx 61%\n');
    tempos.push(r.ms);
  }
  const med = [...tempos].sort((a, b) => a - b)[2];
  console.log(`# statusline com servidor no ar (mediana): ${med.toFixed(0)} ms`);
  assert.ok(med < 150);
  const uso = (await get('/uso')).json;
  assert.deepEqual([uso.cincoHoras, uso.semanal], [{ pct: 34.2, renova: 1791990000000 }, { pct: 12, renova: 1792400000000 }]);
  const s = (await sessao('sessao-status')).sessao;
  assert.deepEqual([s.contexto.tokens, s.contexto.janela, s.contexto.pct], [122000, 200000, 61]);
});

// ───────── instalar.mjs ─────────

test('instalar.mjs: 12 eventos, PreToolUse sem matcher, idempotente, backup só na primeira, --remover preserva o resto', () => {
  const arq = path.join(DADOS, 'settings.json');
  const original = {
    model: 'x',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'echo outro' }] }],
      PreToolUse: [
        { matcher: 'AskUserQuestion|ExitPlanMode', hooks: [{ type: 'command', command: 'node', args: [path.join(RAIZ, 'hook.mjs').replace(/\\/g, '/')], timeout: 10, async: true }] },
      ],
      // O aviso ao subagente já instalado (opcional): reinstalar sem opção o mantém.
      PostToolUse: [{ hooks: [{ type: 'command', command: 'node', args: [path.join(RAIZ, 'aviso-subagente.mjs').replace(/\\/g, '/')], timeout: 5 }] }],
    },
  };
  const textoOriginal = JSON.stringify(original, null, 2);
  fs.writeFileSync(arq, textoOriginal);
  const env = { ...process.env, GERENCIADOR_SETTINGS: arq, GERENCIADOR_SKILLS: path.join(DADOS, 'skills-teste') }; // nunca o ~/.claude
  const rodar = (...a) => spawnSync(process.execPath, [path.join(RAIZ, 'instalar.mjs'), ...a], { env, encoding: 'utf8' });

  let r = rodar();
  assert.equal(r.status, 0, r.stderr);
  let c = JSON.parse(fs.readFileSync(arq, 'utf8'));
  const eventos = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'SessionEnd'];
  for (const e of eventos) {
    const nossos = (c.hooks[e] || []).filter((g) => g.hooks.some((h) => (h.args || []).some((x) => x.endsWith('hook.mjs'))));
    assert.equal(nossos.length, 1, `${e} deveria ter 1 entrada nossa`);
    assert.equal(nossos[0].matcher, undefined, `${e} não deveria ter matcher`);
    assert.equal(nossos[0].hooks[0].async, true);
    assert.equal(nossos[0].hooks[0].timeout, 10);
  }
  // O aviso ao subagente (opcional): já instalado, fica; síncrono, grupo à parte do PostToolUse, sem matcher.
  const comAviso = (gs) => gs.filter((g) => g.hooks.some((h) => (h.args || []).some((x) => x.endsWith('aviso-subagente.mjs'))));
  const avisos = () => Object.entries(JSON.parse(fs.readFileSync(arq, 'utf8')).hooks || {}).flatMap(([e, gs]) => comAviso(gs).map((g) => [e, g]));
  const AVISO_ESPERADO = { hooks: [{ type: 'command', command: nodeDoHook(), args: [path.join(RAIZ, 'aviso-subagente.mjs').replace(/\\/g, '/')], timeout: 5 }] };
  assert.deepEqual(avisos(), [['PostToolUse', AVISO_ESPERADO]]);
  assert.equal(r.stdout.includes('aviso aos subagentes'), true, r.stdout);
  assert.equal(rodar('--sem-aviso-subagente').status, 0);
  assert.deepEqual(avisos(), [], '--sem-aviso-subagente tira');
  assert.equal(rodar().status, 0);
  assert.deepEqual(avisos(), [], 'sem opção, continua sem');
  assert.equal(rodar('--aviso-subagente').status, 0);
  assert.deepEqual(avisos(), [['PostToolUse', AVISO_ESPERADO]], '--aviso-subagente põe (uma vez)');
  // O projeto não tem mais o aviso no .claude/settings.json (ele é opcional e global).
  const doProjeto = path.join(RAIZ, '.claude', 'settings.json');
  assert.ok(!fs.existsSync(doProjeto) || !fs.readFileSync(doProjeto, 'utf8').includes('aviso-subagente'));
  c = JSON.parse(fs.readFileSync(arq, 'utf8'));
  assert.equal(c.model, 'x');
  assert.ok(c.hooks.Stop.some((g) => g.hooks[0].command === 'echo outro'), 'hook alheio sumiu');
  assert.equal(fs.readFileSync(arq + '.bak-gerenciador', 'utf8'), textoOriginal);

  const instalado = fs.readFileSync(arq, 'utf8');
  r = rodar();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Nada a mudar/);
  assert.equal(fs.readFileSync(arq, 'utf8'), instalado);
  assert.equal(fs.readFileSync(arq + '.bak-gerenciador', 'utf8'), textoOriginal, 'backup reescrito');

  r = rodar('--remover');
  assert.equal(r.status, 0);
  c = JSON.parse(fs.readFileSync(arq, 'utf8'));
  assert.deepEqual(Object.keys(c.hooks), ['Stop']);
  assert.equal(c.hooks.Stop.length, 1);
  assert.equal(c.statusLine, undefined, '--remover deixou a nossa statusLine');

  fs.writeFileSync(arq, '{ quebrado');
  r = rodar();
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(arq, 'utf8'), '{ quebrado');
});

test('instalar.mjs: skill liderar-time só com --liderar-time, com a pasta de progresso; nunca a do usuário', () => {
  const arq = path.join(DADOS, 'settings-skill.json');
  const skills = path.join(DADOS, 'skills-teste');
  const dadosOrbit = path.join(DADOS, 'dados-orbit');
  const env = { ...process.env, GERENCIADOR_SETTINGS: arq, GERENCIADOR_SKILLS: skills, GERENCIADOR_DADOS: dadosOrbit };
  const rodar = (...a) => spawnSync(process.execPath, [path.join(RAIZ, 'instalar.mjs'), ...a], { env, encoding: 'utf8' });
  const skill = path.join(skills, 'liderar-time', 'SKILL.md');
  assert.equal(rodar().status, 0);
  assert.equal(fs.existsSync(skill), false, 'sem a opção, nada de skill');
  const r = rodar('--liderar-time');
  assert.equal(r.status, 0, r.stderr);
  const t = fs.readFileSync(skill, 'utf8');
  assert.ok(t.startsWith('---\nname: liderar-time\n') || t.startsWith('---\r\nname: liderar-time\r\n'));
  assert.ok(t.includes(path.join(dadosOrbit, 'progresso').replace(/\\/g, '/') + '/<nome da pasta do projeto>/'), 'pasta de progresso trocada');
  assert.ok(!t.includes('{{PROGRESSO}}') && !/brain|_progresso/.test(t));
  assert.match(rodar('--liderar-time').stdout, /já instalada/);
  assert.equal(rodar('--sem-liderar-time').status, 0);
  assert.equal(fs.existsSync(skill), false, '--sem-liderar-time tira');
  // Uma liderar-time do próprio usuário nunca é trocada nem apagada.
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, 'minha skill');
  assert.match(rodar('--liderar-time').stdout, /já existe uma skill liderar-time sua/);
  assert.equal(rodar('--remover').status, 0);
  assert.equal(fs.readFileSync(skill, 'utf8'), 'minha skill');
});

test('instalar.mjs: statusLine instalada sem args (formato do schema) quando não há outra; a do usuário nunca é tocada', () => {
  const STATUS = path.join(RAIZ, 'statusline.mjs').replace(/\\/g, '/');
  // Windows: `node "<caminho>"`, como sempre. Mac: o node com caminho completo e aspas simples do sh (o Claude
  // Code aberto pelo Dock pode não ter o Homebrew no PATH).
  const WIN = process.platform === 'win32';
  const node = nodeDoHook();
  if (!WIN) assert.ok(path.isAbsolute(node) && fs.statSync(node).isFile(), `node do hook: ${node}`);
  const nossa = { type: 'command', command: WIN ? `node "${STATUS}"` : `'${node}' '${STATUS}'` };
  const arq = path.join(DADOS, 'settings-status.json');
  const env = { ...process.env, GERENCIADOR_SETTINGS: arq, GERENCIADOR_SKILLS: path.join(DADOS, 'skills-teste') }; // nunca o ~/.claude
  const rodar = (...a) => spawnSync(process.execPath, [path.join(RAIZ, 'instalar.mjs'), ...a], { env, encoding: 'utf8' });
  const ler = () => JSON.parse(fs.readFileSync(arq, 'utf8'));

  // Sem statusLine: instala a nossa; reinstalar não muda nada; a nossa com padding é atualizada, não duplicada.
  fs.writeFileSync(arq, JSON.stringify({ model: 'x' }));
  let r = rodar();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ler().statusLine, nossa);
  assert.match(r.stdout, WIN ? /Status line: node/ : /Status line: '\/.*node' '.*statusline\.mjs'/);
  assert.match(rodar().stdout, /Nada a mudar/);
  const comPadding = ler();
  comPadding.statusLine.padding = 1;
  fs.writeFileSync(arq, JSON.stringify(comPadding, null, 2) + '\n');
  assert.match(rodar().stdout, /Nada a mudar/);
  assert.deepEqual(ler().statusLine, { ...nossa, padding: 1 });
  // --remover tira só a nossa.
  r = rodar('--remover');
  assert.equal(r.status, 0);
  assert.equal(ler().statusLine, undefined);
  assert.equal(ler().model, 'x');

  // Com statusLine do usuário: mantida, com aviso; os hooks são instalados mesmo assim.
  const doUsuario = { type: 'command', command: 'bash ~/.claude/minha-linha.sh', padding: 0 };
  fs.writeFileSync(arq, JSON.stringify({ statusLine: doUsuario }));
  r = rodar();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Aviso: já existe uma statusLine do usuário/);
  assert.deepEqual(ler().statusLine, doUsuario);
  assert.ok(ler().hooks.Stop, 'hooks não instalados');
  r = rodar();
  assert.match(r.stdout, /Nada a mudar/);
  assert.match(r.stdout, /Aviso: já existe uma statusLine do usuário/);
  r = rodar('--remover');
  assert.equal(r.status, 0);
  assert.deepEqual(ler().statusLine, doUsuario, '--remover tirou a statusLine do usuário');
  assert.equal(ler().hooks, undefined);
});
