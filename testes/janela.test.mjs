// Janela de contexto de cada modelo (20/10): janela.mjs, a cópia do index.html e o detalhe do subagente.
// Rodar:  node --test testes/janela.test.mjs
// Sobe um servidor próprio numa porta livre de 47822–47826 (nunca a 47821), com dados numa pasta temporária.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { escolherPorta } from './porta-livre.mjs';
import { janelaDoModelo, comJanela } from '../janela.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CASOS = {
  'claude-opus-5-5': 1e6,
  'claude-sonnet-5-5': 1e6,
  'claude-haiku-5-5': 1e6,
  'claude-fable-5-1': 1e6,
  'claude-mythos-5-1': 1e6,
  'claude-opus-5': 1e6,
  'claude-sonnet-5': 1e6,
  'claude-opus-4-8': 1e6,
  'claude-opus-4-6': 1e6,
  'claude-sonnet-4-6': 1e6,
  'claude-haiku-4-5': 2e5,
  'claude-haiku-4-5-20251001': 2e5,
  'claude-sonnet-4-5-20250929': 2e5,
  'claude-opus-4-5-20251101': 2e5,
  'claude-sonnet-4-20250514': 2e5,
  'claude-3-5-sonnet-20241022': 2e5,
  'claude-sonnet-4-5[1m]': 1e6,
  'CLAUDE-OPUS-5-5': 1e6,
  '<synthetic>': null,
  'gpt-x': null,
  '': null,
};

test('janelaDoModelo: 1M na geração 5, Fable/Mythos e Opus/Sonnet 4.6+; 200k no resto; desconhecido → null', () => {
  for (const [m, j] of Object.entries(CASOS)) assert.equal(janelaDoModelo(m), j, m);
});

test('a cópia do index.html dá a mesma janela que o janela.mjs', () => {
  const html = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');
  const fonte = /function janelaDoModelo\(modelo\) \{[\s\S]*?\n\}\n/.exec(html)?.[0];
  assert.ok(fonte, 'janelaDoModelo no index.html');
  const daPagina = new Function(`${fonte}; return janelaDoModelo;`)();
  for (const m of Object.keys(CASOS)) assert.equal(daPagina(m), janelaDoModelo(m), m);
  assert.ok(html.includes('janela || janelaDoModelo(modelo) || LIMITE_CTX'), 'o 200k fixo só fica como reserva de modelo desconhecido');
});

test('comJanela: o subagente Sonnet de 348 mil fica em 35% de 1M', () => {
  assert.deepEqual(comJanela({ tokens: 348284, modelo: 'claude-sonnet-5-5' }), { tokens: 348284, modelo: 'claude-sonnet-5-5', janela: 1e6, pct: 35 });
  assert.deepEqual(comJanela({ tokens: 150000, modelo: 'claude-haiku-4-5' }), { tokens: 150000, modelo: 'claude-haiku-4-5', janela: 2e5, pct: 75 });
  assert.deepEqual(comJanela({ tokens: 10, modelo: 'outro' }), { tokens: 10, modelo: 'outro' });
});

// ───────── servidor ─────────

const PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47822);
const DADOS = path.join(os.tmpdir(), 'gerenciador-testes', `janela-${Date.now()}`);
fs.mkdirSync(path.join(DADOS, 'sessoes'), { recursive: true });
const ENV = { ...process.env, GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_TICK_MS: '250', GERENCIADOR_SESSOES_DIR: path.join(DADOS, 'sessoes') };
delete ENV.CLAUDE_CODE_HOST_SESSION_ID;

function pedir(metodo, rota, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
    const headers = { 'x-gerenciador': '1' };
    if (dados !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados) });
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers, timeout: 5000 }, (res) => {
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
    req.on('error', reject);
    if (dados !== undefined) req.write(dados);
    req.end();
  });
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let proc;
after(async () => {
  await pedir('POST', '/desligar').catch(() => {});
  await espera(300);
  try { proc?.kill(); } catch {}
  await espera(200);
  try { fs.rmSync(DADOS, { recursive: true, force: true }); } catch {}
});

test('detalhe do subagente: contexto com a janela real do modelo e a porcentagem sobre ela', async () => {
  if ((await pedir('GET', '/saude').catch(() => ({}))).status) throw new Error(`porta ${PORTA} ocupada`);
  proc = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => process.stderr.write('[servidor] ' + d));
  for (let i = 0; i < 80 && (await pedir('GET', '/saude').catch(() => ({}))).json?.pid !== proc.pid; i++) await espera(100);

  const id = `jan-${Date.now().toString(36)}`;
  const principal = path.join(DADOS, `${id}.jsonl`);
  const pasta = path.join(DADOS, id, 'subagents');
  fs.mkdirSync(pasta, { recursive: true });
  const linha = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(principal, linha({ type: 'user', message: { role: 'user', content: 'oi' }, uuid: 'p1', timestamp: new Date().toISOString() }));
  const resposta = (modelo, tokens) => linha({ type: 'assistant', isSidechain: true, uuid: 'a' + tokens, timestamp: new Date().toISOString(),
    message: { id: 'm' + tokens, role: 'assistant', model: modelo, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 4, cache_read_input_tokens: tokens - 1004, cache_creation_input_tokens: 1000 } } });
  fs.writeFileSync(path.join(pasta, 'agent-s1.jsonl'), resposta('claude-sonnet-5-5', 348284));
  fs.writeFileSync(path.join(pasta, 'agent-h1.jsonl'), resposta('claude-haiku-4-5-20251001', 150000));
  const ev = (o) => pedir('POST', '/evento', { session_id: id, transcript_path: principal, cwd: DADOS, ts: Date.now(), ...o });
  await ev({ hook_event_name: 'UserPromptSubmit', prompt: 'oi' });
  await ev({ hook_event_name: 'SubagentStart', agent_id: 's1', agent_type: 'general-purpose' });
  await ev({ hook_event_name: 'SubagentStart', agent_id: 'h1', agent_type: 'Explore' });

  const s1 = (await pedir('GET', `/sessao/${id}/agente/s1`)).json;
  assert.deepEqual(s1.contexto, { tokens: 348284, modelo: 'claude-sonnet-5-5', janela: 1e6, pct: 35 });
  const h1 = (await pedir('GET', `/sessao/${id}/agente/h1`)).json;
  assert.deepEqual(h1.contexto, { tokens: 150000, modelo: 'claude-haiku-4-5-20251001', janela: 2e5, pct: 75 });
});
