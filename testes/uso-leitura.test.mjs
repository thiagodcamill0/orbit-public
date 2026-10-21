// Orbit — teste da leitura do uso do plano sob demanda (uso-leitura.mjs + POST /uso/atualizar).
// node testes/uso-leitura.test.mjs
// Usa um claude falso (nunca gasta o plano) e um servidor próprio numa porta livre conferida de 47822–47826
// (testes/porta-livre.mjs); no fim, desliga só esse servidor. Dados e registro de sessões ficam no tmp.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escolherPorta, desligarSeMeu } from './porta-livre.mjs';
import { usoDoEvento, lerUsoAgora } from '../uso-leitura.mjs';

const PASTA = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-uso-teste-'));
const DADOS = path.join(BASE, 'dados');
const SESSOES = path.join(BASE, 'sessoes');
fs.mkdirSync(DADOS);
fs.mkdirSync(SESSOES);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// claude falso: grava o registro (como o claude real faz no ~/.claude/sessions), manda init, o
// rate_limit_event e o result; FALSO_MODO=sem-uso omite o evento, FALSO_MODO=erro sai com código 1.
const FALSO = path.join(BASE, 'claude-uso-falso.mjs');
fs.writeFileSync(FALSO, `
import fs from 'node:fs';
import path from 'node:path';
const a = process.argv.slice(2);
const id = a[a.indexOf('--session-id') + 1];
fs.writeFileSync(path.join(process.env.GERENCIADOR_SESSOES_DIR, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: id, cwd: process.cwd(), startedAt: Date.now(), status: 'busy' }));
fs.writeFileSync(path.join(process.env.FALSO_SAIDA, 'args.json'), JSON.stringify({ a, cwd: process.cwd(), claude: Object.keys(process.env).filter((k) => /^CLAUDE/i.test(k)) }));
const modo = process.env.FALSO_MODO || '';
if (modo === 'erro') { process.stderr.write('falha de login\\n'); process.exit(1); }
const out = (j) => process.stdout.write(JSON.stringify(j) + '\\n');
setTimeout(() => {
  out({ type: 'system', subtype: 'init', session_id: id });
  if (modo !== 'sem-uso') out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.29, resetsAt: Number(process.env.FALSO_RENOVA) }, seven_day: { utilization: 0.61, resetsAt: 1792062000 } } }, session_id: id });
  out({ type: 'result', subtype: 'success', total_cost_usd: 0.0006, session_id: id });
  setTimeout(() => process.exit(0), Number(process.env.FALSO_DEMORA || 400));
}, 150);
`);

const PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47824);
const ENV = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_SESSOES_DIR: SESSOES,
  GERENCIADOR_TICK_MS: '200',
  GERENCIADOR_PID_MS: '200',
  ORBIT_CLAUDE_BIN: FALSO,
  FALSO_SAIDA: BASE,
  FALSO_RENOVA: String(Math.round(Date.now() / 1000) + 3 * 3600),
  CLAUDECODE: '1', // tem de sumir do ambiente do filho (envLimpo)
};
delete ENV.CLAUDE_CODE_HOST_SESSION_ID;

function pedir(metodo, rota, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
    const headers = { 'x-gerenciador': '1' };
    if (dados !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers, timeout: 20000 }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(s); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (dados !== undefined) req.write(dados);
    req.end();
  });
}

let srv = null;
async function subir() {
  srv = spawn(process.execPath, [path.join(PASTA, 'servidor.mjs')], { cwd: PASTA, env: ENV, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    await espera(100);
    const r = await pedir('GET', '/saude').catch(() => null);
    if (r?.json?.pid === srv.pid) return;
    if (srv.exitCode != null) break;
  }
  throw new Error(`o servidor do teste não subiu na ${PORTA}`);
}
async function descer() {
  if (srv && srv.exitCode == null) {
    if (!(await desligarSeMeu(PORTA, srv.pid))) srv.kill();
    for (let i = 0; i < 30 && srv.exitCode == null; i++) await espera(100);
  }
}

test.after(async () => {
  await descer();
  fs.rmSync(BASE, { recursive: true, force: true });
});

test('usoDoEvento: utilization 0–1 vira used_percentage; sem janelas, null', () => {
  const r = usoDoEvento({ unifiedWindows: { five_hour: { utilization: 0.32, resetsAt: 1792067400 }, seven_day: { utilization: 0.56, resetsAt: 1792062000 } } });
  assert.equal(Math.round(r.five_hour.used_percentage), 32);
  assert.equal(r.five_hour.resets_at, 1792067400);
  assert.equal(Math.round(r.seven_day.used_percentage), 56);
  assert.deepEqual(usoDoEvento({ unifiedWindows: { five_hour: { utilization: 0.4 } } }).seven_day, undefined);
  assert.equal(usoDoEvento({ unifiedWindows: {} }), null);
  assert.equal(usoDoEvento({ status: 'allowed' }), null);
  assert.equal(usoDoEvento(null), null);
});

test('lerUsoAgora: argumentos mínimos, ambiente limpo, pasta fora do projeto', async () => {
  const antes = process.env.GERENCIADOR_SESSOES_DIR;
  process.env.GERENCIADOR_SESSOES_DIR = SESSOES;
  process.env.FALSO_SAIDA = BASE;
  process.env.FALSO_RENOVA = ENV.FALSO_RENOVA;
  process.env.CLAUDECODE = '1';
  try {
    const l = await lerUsoAgora({ sessionId: 'id-fixo', bin: { cmd: process.execPath, pre: [FALSO] } });
    assert.equal(Math.round(l.rate_limits.five_hour.used_percentage), 29);
    assert.equal(l.custo, 0.0006);
    const { a, cwd, claude } = JSON.parse(fs.readFileSync(path.join(BASE, 'args.json'), 'utf8'));
    for (const f of ['-p', '--safe-mode', '--no-session-persistence', '--strict-mcp-config', '--output-format']) assert.ok(a.includes(f), f);
    assert.equal(a[a.indexOf('--model') + 1], 'haiku');
    assert.equal(a[a.indexOf('--tools') + 1], '');
    assert.equal(a[a.indexOf('--session-id') + 1], 'id-fixo');
    assert.ok(!path.resolve(cwd).toLowerCase().startsWith(PASTA.toLowerCase()), 'roda fora da pasta do projeto');
    assert.deepEqual(claude, [], 'nada CLAUDE* herdado');

    process.env.FALSO_MODO = 'sem-uso';
    await assert.rejects(lerUsoAgora({ bin: { cmd: process.execPath, pre: [FALSO] } }), /sem o uso do plano/);
    process.env.FALSO_MODO = 'erro';
    await assert.rejects(lerUsoAgora({ bin: { cmd: process.execPath, pre: [FALSO] } }), /código 1: falha de login/);
    // Travado depois da leitura: devolve o que leu e encerra o processo. Travado sem leitura: erro.
    process.env.FALSO_MODO = '';
    process.env.FALSO_DEMORA = '5000';
    const t0 = Date.now();
    assert.equal(Math.round((await lerUsoAgora({ bin: { cmd: process.execPath, pre: [FALSO] }, limiteMs: 800 })).rate_limits.seven_day.used_percentage), 61);
    assert.ok(Date.now() - t0 < 2000, 'não esperou o processo travado');
    process.env.FALSO_MODO = 'sem-uso';
    await assert.rejects(lerUsoAgora({ bin: { cmd: process.execPath, pre: [FALSO] }, limiteMs: 800 }), /não respondeu/);
  } finally {
    delete process.env.FALSO_MODO;
    delete process.env.FALSO_DEMORA;
    if (antes === undefined) delete process.env.GERENCIADOR_SESSOES_DIR;
    else process.env.GERENCIADOR_SESSOES_DIR = antes;
  }
});

test('POST /uso/atualizar: lê, guarda, difunde; a sonda nunca entra na lista; lê com janela ativa', async () => {
  await subir();
  assert.equal((await pedir('GET', '/uso')).json, null);

  ENV.FALSO_DEMORA = '1200'; // o registro da sonda fica vivo por mais de um tique do servidor
  const r = await pedir('POST', '/uso/atualizar', {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.uso.cincoHoras.pct, 29);
  assert.equal(r.json.uso.semanal.pct, 61);
  await espera(1500);
  const est = (await pedir('GET', '/estado')).json;
  assert.equal(est.sessoes.length, 0, 'a sessão da sonda não pode aparecer');
  assert.equal(est.uso.cincoHoras.pct, 29);

  // Janela de 5h ativa pela última leitura: lê de novo (liberado em 19/10).
  const b = await pedir('POST', '/uso/atualizar', {});
  assert.equal(b.status, 200, JSON.stringify(b.json));
  assert.equal(b.json.uso.cincoHoras.pct, 29);

  // Leitura vazia (sem nenhuma janela) não apaga a boa.
  await pedir('POST', '/uso', { ts: Date.now(), rate_limits: { five_hour: undefined, seven_day: null } });
  assert.equal((await pedir('GET', '/uso')).json.cincoHoras.pct, 29);

  // A leitura sobrevive a reiniciar o servidor (estado.json).
  await descer();
  await subir();
  const u = (await pedir('GET', '/uso')).json;
  assert.equal(u.cincoHoras.pct, 29);
  assert.ok(u.atualizado > 0);
});

test('POST /uso/atualizar: instância trabalhando bloqueia; erro do claude vira 502', async () => {
  // Janela já fechada pela última leitura: o bloqueio que sobra é o da instância.
  await pedir('POST', '/uso', { ts: Date.now() + 1000, rate_limits: { five_hour: { used_percentage: 50, resets_at: Math.round(Date.now() / 1000) - 60 } } });
  await pedir('POST', '/evento', { session_id: 'trabalhando-1', hook_event_name: 'UserPromptSubmit', cwd: BASE, prompt: 'oi' });
  const b = await pedir('POST', '/uso/atualizar', {});
  assert.equal(b.status, 409, JSON.stringify(b.json));
  assert.equal(b.json.motivo, 'rodando');
  await pedir('POST', '/evento', { session_id: 'trabalhando-1', hook_event_name: 'Stop', cwd: BASE });

  await descer();
  ENV.FALSO_MODO = 'erro';
  await subir();
  const e = await pedir('POST', '/uso/atualizar', {});
  assert.equal(e.status, 502, JSON.stringify(e.json));
  assert.match(e.json.erro, /falha de login/);
  assert.equal((await pedir('GET', '/uso')).json.cincoHoras.pct, 50, 'a falha não mexe na última leitura');
});
