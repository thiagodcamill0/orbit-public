// Escritórios no servidor.mjs real: /escritorios e /escritorios/* ligados ao escritorios.mjs.
// Rodar:  node testes/escritorios-servidor.test.mjs
// Sobe um servidor próprio numa porta de teste (47822–47826, conferida livre; nunca a 47821) com uma pasta de
// dados temporária, e desliga só o processo que subiu.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escolherPorta, desligarSeMeu } from './porta-livre.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47824);
const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-escsrv-'));
const SESSOES = path.join(DADOS, 'sessoes');
const PROJ = path.join(DADOS, 'proj');
fs.mkdirSync(SESSOES, { recursive: true });
fs.mkdirSync(PROJ, { recursive: true });
const ENV = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_SESSOES_DIR: SESSOES,
};
delete ENV.CLAUDE_CODE_HOST_SESSION_ID;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function pedir(metodo, rota, { headers = {}, corpo } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (corpo !== undefined) h['content-length'] = Buffer.byteLength(corpo);
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers: h, timeout: 5000, agent: false }, (res) => {
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
    if (corpo !== undefined) req.write(corpo);
    req.end();
  });
}
const get = (rota) => pedir('GET', rota);
const post = (rota, corpo = {}, headers = { 'x-gerenciador': '1' }) =>
  pedir('POST', rota, { headers: { 'content-type': 'application/json', ...headers }, corpo: JSON.stringify(corpo) });

let proc = null;
after(async () => {
  if (proc) {
    const saiu = new Promise((r) => proc.once('exit', r));
    await desligarSeMeu(PORTA, proc.pid);
    await Promise.race([saiu, espera(3000)]);
    if (proc.exitCode == null) { try { proc.kill(); } catch {} }
  }
  try { fs.rmSync(DADOS, { recursive: true, force: true }); } catch {}
});

const def = (nome, extra = {}) => ({
  nome, funcao: 'Escritório de teste do servidor', pasta: PROJ,
  orquestrador: { prompt: 'Você lidera o escritório de teste.' },
  membros: [{ id: 'redator', papel: 'Redator', nome: 'Rê', prompt: 'Escreva textos curtos.' }],
  ...extra,
});

let id;

test('sobe o servidor de teste', async () => {
  proc = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env: ENV, stdio: 'ignore' });
  let ok = false;
  for (let i = 0; i < 100 && !ok; i++) {
    try { ok = (await get('/saude')).json?.pid === proc.pid; } catch {}
    if (!ok) await espera(50);
  }
  assert.ok(ok, 'servidor não subiu');
});

test('GET /escritorios → 200 {escritorios: []}', async () => {
  const r = await get('/escritorios');
  assert.equal(r.status, 200, r.texto);
  assert.deepEqual(r.json, { escritorios: [] });
});

test('POST sem o cabeçalho → 403 e nada é criado', async () => {
  const r = await post('/escritorios', def('Sem cabeçalho'), {});
  assert.equal(r.status, 403, r.texto);
  assert.deepEqual((await get('/escritorios')).json, { escritorios: [] });
});

test('criar → 200 com o escritório; aparece na lista e na leitura', async () => {
  const c = await post('/escritorios', def('Servidor A'));
  assert.equal(c.status, 200, c.texto);
  id = c.json.escritorio.id;
  assert.ok(id);
  assert.equal(c.json.escritorio.nome, 'Servidor A');
  const l = await get('/escritorios');
  assert.equal(l.json.escritorios.length, 1);
  assert.equal(l.json.escritorios[0].id, id);
  assert.equal(l.json.escritorios[0].membros, 1);
  const g = await get(`/escritorios/${id}`);
  assert.equal(g.status, 200, g.texto);
  assert.equal(g.json.escritorio.nome, 'Servidor A');
  assert.ok('execucao' in g.json);
});

test('salvar → 200 e a mudança persiste (também no disco)', async () => {
  const s = await post(`/escritorios/${id}`, def('Servidor A2'));
  assert.equal(s.status, 200, s.texto);
  assert.equal(s.json.escritorio.nome, 'Servidor A2');
  assert.equal((await get(`/escritorios/${id}`)).json.escritorio.nome, 'Servidor A2');
  assert.ok(fs.readdirSync(path.join(DADOS, 'escritorios')).some((a) => a.includes(id)), 'arquivo do escritório na pasta de dados');
});

test('GET /escritorios/convidados de sessão que não é de escritório → 404 (rota do hook)', async () => {
  const r = await get('/escritorios/convidados?sessao=nenhuma');
  assert.equal(r.status, 404, r.texto);
  assert.deepEqual(r.json, { erro: 'sessão fora de um escritório' });
});

test('alerta de orçamento não vira entrada no histórico (sem sessão de mentira); o celular vem por notificarCelular', async () => {
  const h = await get('/historico');
  assert.equal(h.status, 200, h.texto);
  assert.ok(Array.isArray(h.json));
  assert.equal(h.json.filter((a) => String(a.sessao?.id || '').startsWith('escritorio:')).length, 0, 'nenhum alerta de escritório no histórico');
  const trecho = fs.readFileSync(path.join(RAIZ, 'servidor.mjs'), 'utf8').split('criarEscritorios({')[1]?.split('});')[0] || '';
  assert.match(trecho, /notificarCelular:/, 'servidor liga a dep notificarCelular');
  assert.doesNotMatch(trecho, /\balertar:/, 'servidor não passa mais o alertar ao criarEscritorios');
});

test('config.escritorios (precosCodex, tetoInstancias): validada, gravada e preservada ao gravar outra parte da config', async () => {
  const arq = path.join(DADOS, 'config.json');
  let r = await post('/config', {
    escritorios: {
      precosCodex: {
        'gpt-novo': { entrada: 3, cacheEntrada: 0.3, saida: 20 },
        'sem-cache': { entrada: 2, saida: 8 },
        'negativo': { entrada: -1, saida: 5 },
        'texto': { entrada: 'x', saida: 5 },
      },
      tetoInstancias: 3,
    },
  });
  assert.equal(r.status, 200, r.texto);
  assert.deepEqual(r.json.escritorios, {
    precosCodex: { 'gpt-novo': { entrada: 3, cacheEntrada: 0.3, saida: 20 }, 'sem-cache': { entrada: 2, cacheEntrada: 2, saida: 8 } },
    tetoInstancias: 3,
  }, 'preço inválido é descartado; cacheEntrada ausente = a entrada');
  // teto fora de 1..20 ou não inteiro é ignorado (mantém o 3)
  for (const t of [0, 21, 2.5, '4', null]) {
    r = await post('/config', { escritorios: { tetoInstancias: t } });
    assert.equal(r.json.escritorios.tetoInstancias, 3, `teto ${JSON.stringify(t)} ignorado`);
  }
  // gravar OUTRA coisa (som, Codex) não apaga config.escritorios — nem em memória nem no config.json
  r = await post('/config', { som: { volume: 0.2 } });
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.som.volume, 0.2);
  assert.equal(r.json.escritorios.tetoInstancias, 3);
  assert.equal(r.json.escritorios.precosCodex['gpt-novo'].saida, 20);
  r = await post('/config', { escritorios: { tetoInstancias: 5 } });
  assert.equal(r.json.escritorios.tetoInstancias, 5);
  assert.equal(r.json.escritorios.precosCodex['gpt-novo'].entrada, 3, 'mandar só o teto preserva os preços');
  assert.equal((await get('/config')).json.escritorios.tetoInstancias, 5);
  await espera(400); // o servidor grava o config.json com um pequeno atraso
  const disco = JSON.parse(fs.readFileSync(arq, 'utf8'));
  assert.equal(disco.escritorios.tetoInstancias, 5);
  assert.ok(disco.escritorios.precosCodex['sem-cache']);
  // escritorios inválido (lista, texto) é ignorado
  r = await post('/config', { escritorios: [1] });
  assert.equal(r.json.escritorios.tetoInstancias, 5);
});

test('excluir → 200 e some; ler de novo → 404', async () => {
  const e = await post(`/escritorios/${id}/excluir`, {});
  assert.equal(e.status, 200, e.texto);
  assert.equal((await get(`/escritorios/${id}`)).status, 404);
  assert.deepEqual((await get('/escritorios')).json, { escritorios: [] });
});
