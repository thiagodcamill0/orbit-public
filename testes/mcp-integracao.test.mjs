// Conexões MCP de ponta a ponta no servidor (mcp.mjs + controle.mjs): a instância do Orbit não conecta o servidor
// pendente do .mcp.json (vai no disabledMcpjsonServers do --settings), recebe no env só as chaves dos aprovados, e a
// sonda mcp_status (que espera sair do "pending") dá o status. Cofre real: DPAPI no Windows.
// Rodar:  node --test testes/mcp-integracao.test.mjs
// Servidor próprio numa porta livre de 47822–47826 (nunca a 47821), dados e "pasta pessoal" falsos; o claude é
// o testes/claude-falso.mjs. Nada do ~/.claude real é lido ou gravado.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { matarArvore } from '../plataforma.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47824);
const WIN = process.platform === 'win32';
const realDe = (d) => (fs.mkdirSync(d, { recursive: true }), WIN ? d : fs.realpathSync(d));
const BASE = realDe(path.resolve(process.env.GERENCIADOR_DADOS || path.join(os.tmpdir(), 'gerenciador-testes')));
const DADOS = path.join(BASE, `mcp-${Date.now()}`);
const SESSOES = path.join(DADOS, 'sessoes');
const PROJETOS = path.join(DADOS, 'projetos');
const CASA = path.join(DADOS, 'casa');
const PROJ = realDe(path.join(DADOS, 'meu-proj'));
const LOG_MCP = path.join(DADOS, 'mcp.log');
for (const d of [SESSOES, PROJETOS, CASA]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(PROJ, '.mcp.json'), JSON.stringify({ mcpServers: { clonado: { command: 'node', args: ['servidor-do-repo.js'] } } }, null, 2));
fs.writeFileSync(path.join(CASA, '.claude.json'), JSON.stringify({ projects: {}, mcpServers: { pessoal1: { type: 'stdio', command: 'node', args: ['p.js'] } } }, null, 2));
fs.writeFileSync(path.join(DADOS, 'projetos.json'), JSON.stringify({ lista: [{ nome: 'meu-proj', pasta: PROJ, desde: 1 }], ocultos: [] }));

const ENV = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_SESSOES_DIR: SESSOES,
  GERENCIADOR_CASA: CASA,
  ORBIT_PROJETOS_DIR: PROJETOS,
  ...(WIN ? {} : { HOME: path.join(DADOS, 'home') }),
  ORBIT_CLAUDE_BIN: path.join(RAIZ, 'testes', 'claude-falso.mjs'),
  ORBIT_MS_INICIO: '4000',
  ORBIT_MS_MODELOS_INICIO: '300',
  FALSO_LOG_MCP: LOG_MCP,
  FALSO_MCP_PLUGIN: 'plugin:falso:x',
  FALSO_DEMORA_MS: '300',
};
delete ENV.CLAUDE_CODE_HOST_SESSION_ID;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
function pedir(metodo, rota, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
    const headers = { 'x-gerenciador': '1' };
    if (dados !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados) });
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers, timeout: 30000 }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (dados !== undefined) req.write(dados);
    req.end();
  });
}
const get = (r) => pedir('GET', r);
const post = (r, c = {}) => pedir('POST', r, c);
const qs = (o) => '?' + new URLSearchParams(o);
async function esperarQue(cond, ms = 8000, rotulo = 'condição') {
  const fim = Date.now() + ms;
  let ultimo;
  while (Date.now() < fim) {
    ultimo = await cond();
    if (ultimo) return ultimo;
    await espera(80);
  }
  throw new Error(`${rotulo} não aconteceu em ${ms} ms (último: ${JSON.stringify(ultimo)})`);
}
const argDe = (argv, n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const registros = () => { try { return fs.readFileSync(LOG_MCP, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const semPlugin = (e) => e && { ...e, conectaria: e.conectaria.filter((n) => !n.startsWith('plugin:')) };
const daSessao = (id) => semPlugin(registros().find((e) => argDe(e.argv, '--session-id') === id && !e.argv.includes('--no-session-persistence')));

let proc;
const antes = await get('/saude').catch(() => ({}));
if (antes.status) throw new Error(`porta ${PORTA} ocupada por outro servidor`);
proc = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
proc.stdout.on('data', () => {});
proc.stderr.on('data', (d) => process.stderr.write('[servidor] ' + d));
await esperarQue(async () => {
  if (proc.exitCode != null) throw new Error(`o servidor do teste saiu (código ${proc.exitCode})`);
  const r = await get('/saude').catch(() => ({}));
  return r.status === 200 && r.json?.pid === proc.pid;
}, 10000, 'servidor do teste no ar');

const criadas = [];
after(async () => {
  for (const id of criadas) await post(`/sessao/${encodeURIComponent(id)}/encerrar`, { forcar: true }).catch(() => {});
  await espera(500);
  const r = await get('/saude').catch(() => ({}));
  if (r.json?.pid === proc.pid) await post('/desligar').catch(() => {});
  await espera(400);
  try { proc.kill(); } catch {}
  try {
    const m = JSON.parse(fs.readFileSync(path.join(DADOS, 'motor.json'), 'utf8'));
    if (m?.pid) {
      if (WIN) execFileSync('taskkill', ['/PID', String(m.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else await matarArvore(m.pid);
    }
  } catch {}
});

async function novaInstancia() {
  const r = await post('/instancias', { pasta: PROJ });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  criadas.push(r.json.sessao);
  return esperarQue(async () => daSessao(r.json.sessao), 10000, 'instância lançada');
}

test('o clonado do .mcp.json fica pendente e a instância do Orbit não o conecta', async () => {
  const l = await get('/mcp' + qs({ pasta: PROJ }));
  assert.equal(l.status, 200, JSON.stringify(l.json));
  assert.equal(l.json.pendentes, 1);
  const e = await novaInstancia();
  assert.deepEqual(e.conectaria, ['pessoal1']);
  assert.deepEqual(JSON.parse(argDe(e.argv, '--settings')).disabledMcpjsonServers, ['clonado']);
});

test('verificar: a sonda espera sair do pending; status por servidor e o plugin só leitura', async () => {
  const r = await post('/mcp/verificar', { pasta: PROJ });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.sonda.ok, true, r.json.sonda.erro);
  const por = Object.fromEntries(r.json.servidores.map((s) => [s.nome, s]));
  assert.equal(por.pessoal1.status, 'connected');
  assert.equal(por.clonado.status, 'pendente');
  assert.equal(por['plugin:falso:x'].status, 'connected');
  assert.equal(por['plugin:falso:x'].editavel, false);
  const sonda = semPlugin(registros().find((x) => x.argv.includes('--no-session-persistence') && x.cwd === PROJ));
  assert.ok(sonda, 'a sonda rodou na pasta do projeto');
  assert.deepEqual(sonda.conectaria, ['pessoal1'], 'a sonda também não conecta o pendente');
});

test('aprovar: a instância seguinte conecta o clonado', async () => {
  const l = await get('/mcp' + qs({ pasta: PROJ }));
  const s = l.json.servidores.find((x) => x.nome === 'clonado');
  const r = await post('/mcp/aprovar', { pasta: PROJ, arquivo: s.arquivo, nome: 'clonado', hash: s.hash });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const e = await novaInstancia();
  assert.deepEqual(e.conectaria.sort(), ['clonado', 'pessoal1']);
  assert.equal(argDe(e.argv, '--settings'), undefined, 'sem nada para bloquear, sem --settings');
});

test('chave de acesso: cifrada fora do projeto, e só a instância do Orbit recebe o valor', { skip: !WIN && 'cofre real só no Windows (DPAPI); no Mac o Chaveiro fica desligado no servidor de teste' }, async () => {
  const valor = 'chave-de-teste-' + Date.now();
  const r = await post('/mcp/adicionar', { pasta: PROJ, nome: 'com-chave', tipo: 'local', comando: 'node c.js', chaves: [{ chave: 'API_KEY', valor }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const cfg = JSON.parse(fs.readFileSync(path.join(PROJ, '.mcp.json'), 'utf8')).mcpServers['com-chave'];
  const v = cfg.env.API_KEY.slice(2, -1);
  assert.match(v, /^ORBIT_MCP_COM_CHAVE_API_KEY_[0-9A-F]{4}$/);
  const cofre = fs.readFileSync(path.join(DADOS, 'mcp-chaves.dat'), 'utf8');
  assert.equal(cofre.includes(valor), false, 'o cofre é cifrado');
  for (const a of ['mcp-orbit.json', 'mcp-chaves.dat']) assert.equal(fs.readFileSync(path.join(DADOS, a), 'utf8').includes(valor), false, a);
  const e = await novaInstancia();
  assert.ok(e.conectaria.includes('com-chave'));
  assert.equal(e.env[v], valor.length);
  // O log do servidor não leva o valor.
  const logs = fs.readdirSync(DADOS).filter((n) => /\.log$/.test(n) && n !== 'mcp.log');
  for (const n of logs) assert.equal(fs.readFileSync(path.join(DADOS, n), 'utf8').includes(valor), false, n);
});

test('desativar no projeto: a instância seguinte não conecta nem recebe a chave', async () => {
  const r = await post('/mcp/ativo', { pasta: PROJ, onde: 'projeto', nome: 'clonado', ativo: false });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const e = await novaInstancia();
  assert.equal(e.conectaria.includes('clonado'), false);
  assert.equal((await post('/mcp/ativo', { pasta: PROJ, onde: 'pessoal', nome: 'pessoal1', ativo: false })).status, 428);
});
