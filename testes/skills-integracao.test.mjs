// Skills de ponta a ponta no servidor (skills.mjs + controle.mjs): a sonda get_skills_dialog, o ativo/inativo
// no .claude/settings.json do projeto e a allowlist da Nova instância no initialize (também ao retomar).
// Rodar:  node --test testes/skills-integracao.test.mjs
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
const PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47823);
const WIN = process.platform === 'win32';
const realDe = (d) => (fs.mkdirSync(d, { recursive: true }), WIN ? d : fs.realpathSync(d));
const BASE = realDe(path.resolve(process.env.GERENCIADOR_DADOS || path.join(os.tmpdir(), 'gerenciador-testes')));
const DADOS = path.join(BASE, `skills-${Date.now()}`);
const SESSOES = path.join(DADOS, 'sessoes');
const PROJETOS = path.join(DADOS, 'projetos');
const CASA = path.join(DADOS, 'casa');
const PROJ = realDe(path.join(DADOS, 'meu-proj'));
const LOG_INIT = path.join(DADOS, 'init.log');
for (const d of [SESSOES, PROJETOS, CASA]) fs.mkdirSync(d, { recursive: true });

function skill(dir, nome, desc) {
  fs.mkdirSync(path.join(dir, nome), { recursive: true });
  fs.writeFileSync(path.join(dir, nome, 'SKILL.md'), `---\nname: ${nome}\ndescription: ${desc}\n---\n\nFaça.\n`);
}
const PROJ_SK = path.join(PROJ, '.claude', 'skills');
const PESS_SK = path.join(CASA, '.claude', 'skills');
skill(PROJ_SK, 'alfa', 'Primeira');
skill(PROJ_SK, 'beta', 'Segunda');
skill(PROJ_SK, 'dup', 'Do projeto');
skill(PESS_SK, 'dup', 'Pessoal');
fs.writeFileSync(path.join(PROJ, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }, null, 2));
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
  ORBIT_LIXEIRA_FALSA: path.join(DADOS, 'lixeira'),
  FALSO_LOG_INIT: LOG_INIT,
  FALSO_SKILLS_PESSOAIS: PESS_SK,
  FALSO_SKILLS_PLUGIN: 'plug:x',
  FALSO_DEMORA_MS: '300',
};
delete ENV.CLAUDE_CODE_HOST_SESSION_ID;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
function pedir(metodo, rota, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
    const headers = { 'x-gerenciador': '1' };
    if (dados !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados) });
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers, timeout: 20000 }, (res) => {
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
const inits = () => { try { return fs.readFileSync(LOG_INIT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const argDe = (argv, n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const initsDa = (id) => inits().filter((e) => argDe(e.argv, '--session-id') === id || argDe(e.argv, '--resume') === id);
const controleDe = async (id) => (await get(`/sessao/${encodeURIComponent(id)}`)).json?.sessao?.controle;

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

test('GET /skills: a sonda (get_skills_dialog na pasta) dá o estado, a trava do plugin e a sombreada', async () => {
  const r = await get('/skills' + qs({ pasta: PROJ }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.sonda.ok, true, r.json.sonda.erro);
  const por = Object.fromEntries(r.json.skills.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(por).sort(), ['pessoal:dup', 'plugin:plug:x', 'projeto:alfa', 'projeto:beta', 'projeto:dup']);
  assert.equal(por['plugin:plug:x'].travada, 'plugin');
  assert.equal(por['projeto:dup'].sombreada, true);
  assert.equal(por['projeto:dup'].anunciada, false);
  assert.equal(por['projeto:alfa'].estado, 'on');
  // Sem o cabeçalho próprio, POST é recusado (como todo POST do Orbit).
  const sem = await new Promise((ok) => {
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: '/skills/estado', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); ok(res.statusCode); });
    req.end(JSON.stringify({ pasta: PROJ, chave: 'alfa', estado: 'off' }));
  });
  assert.equal(sem, 403);
});

test('POST /skills/estado: desliga no .claude/settings.json do projeto e a sonda seguinte vê', async () => {
  const r = await post('/skills/estado', { pasta: PROJ, chave: 'alfa', estado: 'off' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(PROJ, '.claude', 'settings.json'), 'utf8')), { hooks: {}, skillOverrides: { alfa: 'off' } });
  const l = await get('/skills' + qs({ pasta: PROJ }));
  assert.equal(l.json.skills.find((s) => s.id === 'projeto:alfa').estado, 'off');
  assert.equal((await post('/skills/estado', { pasta: PROJ, chave: 'plug:x', estado: 'off' })).status, 409);
  await post('/skills/estado', { pasta: PROJ, chave: 'alfa', estado: 'on' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(PROJ, '.claude', 'settings.json'), 'utf8')), { hooks: {} });
});

test('pessoal sem confirmação: 428 e nada muda na pasta pessoal', async () => {
  const r = await post('/skills/salvar', { pasta: PROJ, origem: 'pessoal', nome: 'nova', descricao: 'x', corpo: '' });
  assert.equal(r.status, 428);
  assert.equal(fs.existsSync(path.join(PESS_SK, 'nova')), false);
  const ex = await post('/skills/excluir', { pasta: PROJ, origem: 'projeto', nome: 'beta' });
  assert.equal(ex.status, 200, JSON.stringify(ex.json));
  assert.equal(fs.existsSync(path.join(PROJ_SK, 'beta')), false);
  assert.equal(fs.readdirSync(path.join(DADOS, 'lixeira')).length, 1);
  skill(PROJ_SK, 'beta', 'Segunda'); // de volta para os próximos testes
});

test('Nova instância: a allowlist vai no initialize, fica no controle e volta ao retomar', async () => {
  for (const ruim of ['alfa', [1], ['a b'], Array.from({ length: 301 }, (_, i) => 's' + i)]) {
    const r = await post('/instancias', { pasta: PROJ, skills: ruim });
    assert.equal(r.status, 400, JSON.stringify(ruim).slice(0, 40));
  }
  const r = await post('/instancias', { pasta: PROJ, skills: ['beta', 'beta', ' plug:x '] });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const id = r.json.sessao;
  criadas.push(id);
  const ini = await esperarQue(async () => initsDa(id)[0], 10000, 'initialize da instância');
  assert.deepEqual(ini.skills, ['beta', 'plug:x']);
  await esperarQue(async () => (await controleDe(id))?.processo === 'vivo', 10000, 'instância viva');
  assert.deepEqual((await controleDe(id)).skills, ['beta', 'plug:x']);
  const us = await get('/skills/sessao' + qs({ id }));
  assert.deepEqual(us.json.permitidas, ['beta', 'plug:x']);
  // Dorme e retoma: o --resume manda a mesma allowlist (ela não fica no transcript). O falso só cria o
  // transcript na 1ª mensagem, e sem ele não há o que retomar.
  await post(`/sessao/${encodeURIComponent(id)}/mensagem`, { texto: 'oi' });
  await esperarQue(async () => { const c = await controleDe(id); return c && !c.ocupada && fs.existsSync(path.join(PROJETOS, PROJ.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)); }, 10000, 'volta terminada');
  const en = await post(`/sessao/${encodeURIComponent(id)}/encerrar`, { forcar: true });
  assert.ok([200, 202].includes(en.status), JSON.stringify(en.json));
  await esperarQue(async () => (await controleDe(id))?.processo === 'dormindo', 10000, 'dormindo');
  assert.deepEqual((await controleDe(id)).skills, ['beta', 'plug:x'], 'o registro guarda a lista');
  const rt = await post(`/sessao/${encodeURIComponent(id)}/retomar`);
  assert.ok([200, 202].includes(rt.status), JSON.stringify(rt.json));
  const de2 = await esperarQue(async () => initsDa(id).find((e) => argDe(e.argv, '--resume') === id), 10000, 'initialize do retomar');
  assert.deepEqual(de2.skills, ['beta', 'plug:x']);

  // Sem `skills` no pedido: o initialize vai sem allowlist (todas as do projeto).
  const r2 = await post('/instancias', { pasta: PROJ });
  assert.equal(r2.status, 202);
  criadas.push(r2.json.sessao);
  const ini2 = await esperarQue(async () => initsDa(r2.json.sessao)[0], 10000, 'initialize da 2ª');
  assert.equal(ini2.skills, null);
  await esperarQue(async () => (await controleDe(r2.json.sessao))?.processo === 'vivo', 10000, '2ª viva');
  assert.equal((await controleDe(r2.json.sessao)).skills, undefined);
});
