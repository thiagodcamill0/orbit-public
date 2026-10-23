// Correções de segurança do app do celular, bloco 4 (22/10): filtrarComandos que fecha (N1), sessão sem pasta (N2),
// cache e teto das skills (P2-2), SKILL.md que não é arquivo (P2-3) e o cache do service worker só do /m (N3).
// Rodar:  node --test testes/remoto-seg.test.mjs
// Não sobe o servidor do Orbit: liga o criarRemoto de verdade a um http falso (porta 47822–47826 conferida livre, nunca a
// 47821) com dados, projetos e casa temporários; o "roteamento comum" do servidor é um manipulador falso por caso.
// O service worker roda num contexto `vm` com self/caches/clients falsos (sem navegador).

import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escolherPorta } from './porta-livre.mjs';
import { criarRemoto } from '../remoto.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const PORTA = await escolherPorta(47824);

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-remoto-seg-'));
const PROJ = path.join(DADOS, 'cwd', 'proj'); // cadastrado, com a skill skill-proj
const GRANDE = path.join(DADOS, 'cwd', 'grande'); // 3001 skills
const CASA = path.join(DADOS, 'casa');
for (const d of [path.join(DADOS, 'd'), PROJ, GRANDE, CASA]) fs.mkdirSync(d, { recursive: true });
const skill = (raiz, nome) => {
  fs.mkdirSync(path.join(raiz, '.claude', 'skills', nome), { recursive: true });
  fs.writeFileSync(path.join(raiz, '.claude', 'skills', nome, 'SKILL.md'), `---\nname: ${nome}\ndescription: teste\n---\ncorpo\n`);
};
skill(PROJ, 'skill-proj');
skill(CASA, 'skill-casa');
fs.mkdirSync(path.join(PROJ, '.claude', 'skills', 'skill-pasta', 'SKILL.md'), { recursive: true }); // SKILL.md é uma pasta
for (let i = 0; i <= 3000; i++) skill(GRANDE, `s${String(i).padStart(4, '0')}`);
process.env.GERENCIADOR_CASA = CASA; // só vale porque `dados` fica fora da pasta do Orbit (deTeste)

const HOST = 'orbit-teste.exemplo.ts.net';
const DONO = 'dono@exemplo.com';
const TOKEN = crypto.randomBytes(32).toString('base64url');
const agora = Date.now();
fs.writeFileSync(path.join(DADOS, 'd', 'remoto.json'), JSON.stringify({ aparelhos: [{ id: 'aparelho1', nome: 'iPhone', hash: crypto.createHash('sha256').update(TOKEN).digest('hex'), criadoEm: agora, ultimoAcesso: agora, cookieEm: agora }] }));

let pastaDaSessao = () => PROJ; // trocado por caso
const padrao = (req, res) => { res.writeHead(202, { 'content-type': 'application/json' }); res.end('{"ok":true}'); };
let manipulador = padrao;
beforeEach(() => { manipulador = padrao; });
const remoto = criarRemoto({
  dados: path.join(DADOS, 'd'),
  pasta: RAIZ,
  config: () => ({ host: HOST, dono: DONO, criarInstancias: true }),
  mudarConfig: async () => {},
  difundirLocal: () => {},
  nativa: () => true,
  pastaDaSessao: (id) => pastaDaSessao(id),
  projetos: () => [{ nome: 'proj', pasta: PROJ }, { nome: 'grande', pasta: GRANDE }],
  lerCorpo: (req, limite) => new Promise((resolve, reject) => {
    const partes = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limite) { reject(new Error('grande')); req.destroy(); } else partes.push(c); });
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  }),
  lerJSONCorpo: async () => ({}),
});
const servidor = http.createServer(async (req, res) => {
  try {
    const r = await remoto.atender(req, res, new URL(req.url, 'http://x').pathname);
    if (!r) return;
    manipulador(req, res);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(e?.message || e));
  }
});
await new Promise((r) => servidor.listen(PORTA, '127.0.0.1', r));
after(async () => {
  remoto.fechar();
  servidor.closeAllConnections?.();
  await new Promise((r) => servidor.close(r));
  try { fs.rmSync(DADOS, { recursive: true, force: true }); } catch {}
});

function pedir(metodo, rota, corpo, ms = 4000) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
    const h = { host: HOST, 'tailscale-user-login': DONO, cookie: `__Host-orbit=${TOKEN}` };
    if (metodo === 'POST') Object.assign(h, { origin: `https://${HOST}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados ?? '{}') });
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers: h, timeout: ms, agent: false }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        let json;
        try { json = JSON.parse(texto); } catch {}
        resolve({ status: res.statusCode, json, texto, headers: res.headers });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timeout de ${ms} ms em ${metodo} ${rota}`)));
    req.on('error', reject);
    req.end(metodo === 'POST' ? (dados ?? '{}') : undefined);
  });
}
const msg = (texto) => pedir('POST', '/sessao/s1/mensagem', { texto });
const comandos = () => pedir('GET', '/sessao/s1/comandos');
const TODOS = [{ nome: 'context' }, { nome: 'config' }, { nome: 'compact' }, { nome: 'clear' }, { nome: 'skill-proj' }, { nome: 'skill-casa' }];
const nomesDe = (r) => (r.json?.comandos || []).map((c) => c.nome);
const nao_vaza = (r) => assert.ok(!/context|"config"/.test(r.texto), `a lista inteira vazou: ${r.texto}`);

test('N1: o corpo escrito por res.write também sai filtrado (nada cru)', async () => {
  manipulador = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.write('{"comandos":[{"nome":"context"},{"nome":"config"},');
    res.end('{"nome":"compact"},{"nome":"skill-proj"}]}');
  };
  const r = await comandos();
  assert.equal(r.status, 200, r.texto);
  assert.deepEqual(nomesDe(r), ['compact', 'skill-proj']);
  nao_vaza(r);
});

test('N1: corpo que não é JSON não sai cru; vira { comandos: null }', async () => {
  manipulador = (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('context\nconfig\ncompact'); };
  const r = await comandos();
  assert.equal(r.status, 200, r.texto);
  assert.deepEqual(r.json, { comandos: null });
  nao_vaza(r);
});

test('N1: content-length posto antes e cabeçalhos em lista não penduram nem truncam a resposta filtrada', async () => {
  const corpo = JSON.stringify({ comandos: TODOS });
  manipulador = (req, res) => {
    res.setHeader('content-length', Buffer.byteLength(corpo)); // o tamanho do corpo ANTES do filtro
    res.writeHead(200, ['content-type', 'application/json; charset=utf-8']);
    res.end(corpo);
  };
  const r = await comandos(); // sem a correção: o corpo filtrado é menor que o content-length e a resposta fica pendurada
  assert.equal(r.status, 200, r.texto);
  assert.deepEqual(nomesDe(r), ['compact', 'clear', 'skill-proj', 'skill-casa']);
  nao_vaza(r);
});

test('N1: o caminho de hoje segue igual (writeHead com objeto + end com texto)', async () => {
  const corpo = JSON.stringify({ comandos: TODOS, extra: 1 });
  manipulador = (req, res) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(corpo) }); res.end(corpo); };
  const r = await comandos();
  assert.equal(r.status, 200, r.texto);
  assert.deepEqual(nomesDe(r), ['compact', 'clear', 'skill-proj', 'skill-casa']);
  assert.equal(r.json.extra, 1);
  manipulador = (req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"erro":"sessão não encontrada"}'); };
  const e = await comandos();
  assert.equal(e.status, 404);
  assert.deepEqual(e.json, { erro: 'sessão não encontrada' });
});

test('N2: sessão sem pasta no registro: nenhuma skill de projeto vale (só /compact, /clear e as de ~/.claude)', async () => {
  pastaDaSessao = () => '';
  try {
    for (const t of ['/skill-proj', '/s0000']) {
      const r = await msg(t);
      assert.equal(r.status, 403, `${t}: ${r.texto}`);
      assert.deepEqual(r.json, { erro: 'comando_nao_permitido' });
    }
    for (const t of ['/compact', '/clear', '/skill-casa', 'texto normal']) assert.equal((await msg(t)).status, 202, t);
    manipulador = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ comandos: TODOS })); };
    assert.deepEqual(nomesDe(await comandos()), ['compact', 'clear', 'skill-casa']);
  } finally { pastaDaSessao = () => PROJ; manipulador = padrao; }
  // com a pasta da sessão, as do projeto valem
  assert.equal((await msg('/skill-proj')).status, 202);
});

test('P2-3: SKILL.md que é uma pasta não vale como skill (403 sem erro)', async () => {
  const r = await msg('/skill-pasta');
  assert.equal(r.status, 403, r.texto);
  assert.deepEqual(r.json, { erro: 'comando_nao_permitido' });
});

test('P2-3: SKILL.md que é FIFO não trava a leitura (403 em menos de 2 s)', { skip: WIN ? 'mkfifo não existe no Windows (não testado aqui)' : false }, async () => {
  fs.mkdirSync(path.join(PROJ, '.claude', 'skills', 'fifo'), { recursive: true });
  execFileSync('mkfifo', [path.join(PROJ, '.claude', 'skills', 'fifo', 'SKILL.md')]);
  const t = Date.now();
  const r = await msg('/fifo');
  assert.equal(r.status, 403, r.texto);
  assert.ok(Date.now() - t < 2000, 'travou no FIFO');
});

test('P2-2: teto de 3000 skills por raiz e resposta rápida', async () => {
  pastaDaSessao = () => GRANDE;
  try {
    const nomes = fs.readdirSync(path.join(GRANDE, '.claude', 'skills')); // a mesma ordem do readdir do servidor
    assert.equal(nomes.length, 3001);
    const t = Date.now();
    const ultima = await msg(`/${nomes.at(-1)}`);
    assert.ok(Date.now() - t < 2000, `levou ${Date.now() - t} ms`);
    assert.equal(ultima.status, 403, `a 3001ª skill não podia valer: ${ultima.texto}`);
    assert.equal((await msg(`/${nomes[0]}`)).status, 202);
  } finally { pastaDaSessao = () => PROJ; }
});

test('P2-2: as skills da raiz ficam em cache por 5 s (a criada agora só vale depois)', async () => {
  skill(PROJ, 'skill-tardia');
  const cedo = await msg('/skill-tardia');
  assert.equal(cedo.status, 403, 'dentro dos 5 s a lista em cache não conhece a skill nova');
  await new Promise((r) => setTimeout(r, 5300));
  assert.equal((await msg('/skill-tardia')).status, 202, 'passados os 5 s, a skill nova vale');
});

// ───────────────────────── service worker (N3) ─────────────────────────
function criarSW() {
  const ouvintes = {};
  const guardados = new Map(); // nome do cache → Set de chaves
  const buscas = [];
  const clientes = new Map(); // clientId → { url }
  const caches = {
    keys: async () => [...guardados.keys()],
    delete: async (k) => guardados.delete(k),
    open: async (nome) => ({
      put: async (k) => { if (!guardados.has(nome)) guardados.set(nome, new Set()); guardados.get(nome).add(typeof k === 'string' ? k : new URL(k.url).pathname); },
      addAll: async () => {},
    }),
    match: async (k, o) => (o?.cacheName && guardados.get(o.cacheName)?.has(k) ? new Response('do cache') : undefined),
  };
  const self = {
    location: { origin: 'http://127.0.0.1:47821' },
    addEventListener: (tipo, fn) => { ouvintes[tipo] = fn; },
    clients: { get: async (id) => clientes.get(id), matchAll: async () => [], claim: async () => {}, openWindow: async () => {} },
    registration: {},
  };
  const ctx = vm.createContext({ self, caches, URL, Request, Response, console, Promise, fetch: async (req) => { buscas.push(req.url); return new Response('rede', { status: 200 }); } });
  vm.runInContext(fs.readFileSync(path.join(RAIZ, 'pwa', 'sw.js'), 'utf8'), ctx, { filename: 'sw.js' });
  async function pedir(caminho, { clientId = '', modo = 'no-cors' } = {}) {
    let resposta = null;
    const esperas = [];
    const ev = {
      request: { method: 'GET', url: `http://127.0.0.1:47821${caminho}`, mode: modo },
      clientId,
      preloadResponse: Promise.resolve(undefined),
      respondWith: (p) => { resposta = p; },
      waitUntil: (p) => { esperas.push(p); },
    };
    ouvintes.fetch(ev);
    const r = resposta ? await resposta : null;
    await Promise.all(esperas);
    return { interceptou: !!resposta, r };
  }
  return { pedir, guardados, clientes, buscas };
}

test('N3: o SW guarda /assets/comum/* só para pedidos do /m; o PC passa direto, sem cache', async () => {
  const sw = criarSW();
  sw.clientes.set('janela-pc', { url: 'http://127.0.0.1:47821/' });
  sw.clientes.set('janela-m', { url: 'http://127.0.0.1:47821/m' });
  const c = () => [...(sw.guardados.get('orbit-casca-m-v1') || [])];
  // PC: sem cliente e com a janela do PC
  await sw.pedir('/assets/comum/base.js');
  await sw.pedir('/assets/comum/base.css', { clientId: 'janela-pc' });
  await sw.pedir('/assets/comum/icones.js', { clientId: 'desconhecida' });
  assert.deepEqual(c(), [], 'o PC não pode deixar nada na casca do celular');
  // celular: janela /m e os arquivos do próprio /m
  await sw.pedir('/assets/comum/base.js', { clientId: 'janela-m' });
  await sw.pedir('/m', { modo: 'navigate' });
  await sw.pedir('/m/nucleo.js');
  await sw.pedir('/manifest-m.webmanifest');
  assert.deepEqual(c().sort(), ['/assets/comum/base.js', '/m', '/m/nucleo.js', '/manifest-m.webmanifest'].sort());
  // o resto continua passando direto (nada de API/estado na casca)
  assert.equal((await sw.pedir('/estado', { clientId: 'janela-m' })).interceptou, false);
  assert.equal((await sw.pedir('/remoto/eu', { clientId: 'janela-m' })).interceptou, false);
  assert.equal(c().length, 4);
});
