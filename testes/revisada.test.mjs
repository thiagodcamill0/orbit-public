// "Revisada" no servidor (21/10): POST /sessao/:id/revisada {revisada: boolean} grava s.revisadaEm (ms) ou apaga.
// Aparece em GET /estado, GET /sessao/:id e no SSE `sessao`; persiste num reinício; zera quando a sessão muda de status de novo.
// Servidor de teste numa porta livre (47822–47826), dados fora da pasta do Orbit. (A rota do celular está em remoto.test.mjs.)
// node testes/revisada.test.mjs   (~10 s)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escolherPorta, desligarSeMeu } from './porta-livre.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47823);
const BASE = `http://127.0.0.1:${PORTA}`;
const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-revisada-'));
const CWD = path.join(DADOS, 'cwd', 'proj');
for (const d of ['sessoes', 'projetos', 'casa', 'cwd/proj']) fs.mkdirSync(path.join(DADOS, d), { recursive: true });
const ENV = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_TICK_MS: '250',
  GERENCIADOR_PID_MS: '300',
  GERENCIADOR_SESSOES_DIR: path.join(DADOS, 'sessoes'),
  GERENCIADOR_CASA: path.join(DADOS, 'casa'),
  ORBIT_PROJETOS_DIR: path.join(DADOS, 'projetos'),
  ORBIT_MODELOS: '0',
  CLAUDE_CODE_ENTRYPOINT: 'teste',
};
delete ENV.CLAUDE_CODE_HOST_SESSION_ID;
delete ENV.CLAUDECODE;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let proc = null;
async function subir() {
  proc = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => process.stderr.write('[servidor] ' + d));
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/saude'); if (r.ok && (await r.json()).pid === proc.pid) return; } catch {}
    await espera(150);
  }
  throw new Error('servidor de teste não subiu');
}
async function derrubar() {
  const saiu = new Promise((r) => proc.once('exit', r));
  await desligarSeMeu(PORTA, proc.pid);
  await Promise.race([saiu, espera(5000)]);
  if (proc.exitCode == null) proc.kill();
}
const pedir = async (metodo, rota, corpo, cab = true) => {
  const r = await fetch(BASE + rota, { method: metodo, headers: { ...(cab ? { 'x-gerenciador': '1' } : {}), ...(corpo !== undefined ? { 'content-type': 'application/json' } : {}) }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const hook = (id, nome, extra = {}) => pedir('POST', '/evento', { session_id: id, hook_event_name: nome, cwd: CWD, ts: Date.now(), ...extra });
const daSessao = async (id) => (await pedir('GET', '/estado')).json.sessoes.find((s) => s.id === id);
async function esperarQue(cond, ms = 6000, rotulo = 'condição') {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { const v = await cond(); if (v) return v; await espera(60); }
  throw new Error(`${rotulo} não aconteceu em ${ms} ms`);
}

// SSE do PC: guarda os eventos `sessao`.
const eventos = [];
const ctl = new AbortController();
async function ouvir() {
  const r = await fetch(BASE + '/fluxo', { signal: ctl.signal });
  const dec = new TextDecoder();
  let sobra = '';
  (async () => {
    try {
      for await (const c of r.body) {
        sobra += dec.decode(c, { stream: true });
        let i;
        while ((i = sobra.indexOf('\n\n')) >= 0) {
          const bloco = sobra.slice(0, i);
          sobra = sobra.slice(i + 2);
          const tipo = /^event: (.+)$/m.exec(bloco)?.[1];
          const dados = /^data: (.+)$/m.exec(bloco)?.[1];
          if (tipo === 'sessao' && dados) { try { eventos.push(JSON.parse(dados)); } catch {} }
        }
      }
    } catch {}
  })();
}

after(async () => {
  ctl.abort();
  if (proc && proc.exitCode == null) await derrubar();
  await espera(300);
  try { fs.rmSync(DADOS, { recursive: true, force: true }); } catch {}
});

const ID = 'sessao-revisada-1';
let marca = 0;

test('sobe o servidor de teste e cria uma sessão concluída', async () => {
  await subir();
  await ouvir();
  assert.equal((await hook(ID, 'UserPromptSubmit', { prompt: 'faça algo' })).status, 200);
  await espera(20);
  assert.equal((await hook(ID, 'Stop', { last_assistant_message: 'pronto' })).status, 200);
  const s = await esperarQue(async () => { const x = await daSessao(ID); return x?.status === 'concluida' ? x : null; }, 6000, 'sessão concluída');
  assert.ok(!('revisadaEm' in s), 'nasce sem revisadaEm');
});

test('rota: exige o cabeçalho da 47821, boolean no corpo e sessão existente', async () => {
  assert.equal((await pedir('POST', `/sessao/${ID}/revisada`, { revisada: true }, false)).status, 403);
  for (const corpo of [{}, { revisada: 'sim' }, { revisada: 1 }, { revisada: null }]) assert.equal((await pedir('POST', `/sessao/${ID}/revisada`, corpo)).status, 400, JSON.stringify(corpo));
  assert.equal((await pedir('POST', '/sessao/nao-existe/revisada', { revisada: true })).status, 404);
  assert.ok(!('revisadaEm' in (await daSessao(ID))), 'os erros não marcaram nada');
});

test('marca: grava revisadaEm >= desde e aparece em /estado, /sessao/:id e no SSE', async () => {
  const antes = await daSessao(ID);
  const n = eventos.length;
  const r = await pedir('POST', `/sessao/${ID}/revisada`, { revisada: true });
  assert.equal(r.status, 200);
  marca = r.json.sessao.revisadaEm;
  assert.equal(typeof marca, 'number');
  assert.ok(marca >= antes.desde, 'revisadaEm >= fim da última volta (desde)');
  assert.equal((await daSessao(ID)).revisadaEm, marca);
  assert.equal((await pedir('GET', `/sessao/${ID}`)).json.sessao.revisadaEm, marca);
  await esperarQue(() => eventos.slice(n).find((e) => e.id === ID && e.revisadaEm === marca), 4000, 'SSE sessao com revisadaEm');
});

test('persiste num reinício do servidor', async () => {
  await espera(900); // o salvar() do estado é adiado em 500 ms
  await derrubar();
  const gravado = JSON.parse(fs.readFileSync(path.join(DADOS, 'estado.json'), 'utf8')).sessoes.find((s) => s.id === ID);
  assert.equal(gravado.revisadaEm, marca, 'estado.json guarda revisadaEm');
  await subir();
  const s = await esperarQue(() => daSessao(ID), 6000, 'sessão depois do reinício');
  assert.equal(s.revisadaEm, marca);
  assert.equal(s.status, 'concluida');
});

test('zera quando a sessão trabalha e termina de novo', async () => {
  ctl.abort(); // o SSE antigo morreu com o reinício
  await espera(30);
  assert.equal((await hook(ID, 'UserPromptSubmit', { prompt: 'mais uma' })).status, 200);
  const s1 = await esperarQue(async () => { const x = await daSessao(ID); return x?.status === 'trabalhando' ? x : null; }, 6000, 'voltou a trabalhar');
  assert.ok(!('revisadaEm' in s1), 'voltou a trabalhar: sem revisadaEm');
  await espera(20);
  assert.equal((await hook(ID, 'Stop', { last_assistant_message: 'feito de novo' })).status, 200);
  const s2 = await esperarQue(async () => { const x = await daSessao(ID); return x?.status === 'concluida' ? x : null; }, 6000, 'concluída de novo');
  assert.ok(!('revisadaEm' in s2), 'terminou de novo: volta para Concluídas');
});

test('marcar de novo, o fim do turno seguinte zera, e desmarcar apaga', async () => {
  const r = await pedir('POST', `/sessao/${ID}/revisada`, { revisada: true });
  assert.equal(r.status, 200);
  const m2 = r.json.sessao.revisadaEm;
  assert.ok(m2 > marca);
  // um Stop repetido depois da marca também zera (o "desde" passa da marca)
  await espera(20);
  await hook(ID, 'Stop', { last_assistant_message: 'repetido' });
  await esperarQue(async () => !('revisadaEm' in (await daSessao(ID))), 4000, 'Stop depois da marca zera');
  // desmarcar sem marca é inofensivo; marcar e desmarcar apaga o campo
  assert.equal((await pedir('POST', `/sessao/${ID}/revisada`, { revisada: false })).status, 200);
  assert.equal((await pedir('POST', `/sessao/${ID}/revisada`, { revisada: true })).status, 200);
  assert.equal(typeof (await daSessao(ID)).revisadaEm, 'number');
  const d = await pedir('POST', `/sessao/${ID}/revisada`, { revisada: false });
  assert.equal(d.status, 200);
  assert.ok(!('revisadaEm' in d.json.sessao));
  assert.ok(!('revisadaEm' in (await daSessao(ID))));
});
