// Testes da regra de origem do servidor.mjs (etapa 0, anti-CSRF): ver a regra de origem no servidor.mjs.
// Rodar:  node testes/origem.test.mjs
// Sobe um servidor próprio numa porta de teste (47822–47826, conferida livre; nunca a 47821) com uma
// pasta de dados temporária, e desliga só o processo que subiu.

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
const PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47823);
const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-origem-'));
const SESSOES = path.join(DADOS, 'sessoes');
fs.mkdirSync(SESSOES, { recursive: true });
const ENV = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_SESSOES_DIR: SESSOES,
};
delete ENV.CLAUDE_CODE_HOST_SESSION_ID;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCAL = `http://127.0.0.1:${PORTA}`;
const LOCALHOST = `http://localhost:${PORTA}`;
const FORA = 'https://site-qualquer.example';
const cwd = process.platform === 'win32' ? 'C:\\proj\\origem' : '/proj/origem';

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
        resolve({ status: res.statusCode, json, texto, cab: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (corpo !== undefined) req.write(corpo);
    req.end();
  });
}
// POST "simples" como o de um site qualquer: corpo JSON mandado como text/plain. x-gerenciador só entra se pedido
// (um site de fora não consegue mandá-lo sem preflight, mas aqui isolamos a regra de origem).
const postar = (rota, headers = {}, corpo = { ts: Date.now() }) =>
  pedir('POST', rota, { headers: { 'content-type': 'text/plain', 'x-gerenciador': '1', ...headers }, corpo: JSON.stringify(corpo) });
const evento = (id, h = {}) => postar('/evento', h, { session_id: id, hook_event_name: 'UserPromptSubmit', cwd, ts: Date.now(), prompt: 'oi' });

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

test('sobe o servidor de teste', async () => {
  proc = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env: ENV, stdio: 'ignore' });
  let ok = false;
  for (let i = 0; i < 100 && !ok; i++) {
    try { ok = (await pedir('GET', '/saude')).json?.pid === proc.pid; } catch {}
    if (!ok) await espera(50);
  }
  assert.ok(ok, 'servidor não subiu');
});

test('POST com Origin de outro site → 403', async () => {
  for (const o of [FORA, 'null', `http://127.0.0.1:${PORTA + 1}`, `http://localhost:${PORTA + 1}`, `${LOCAL}/`, `https://127.0.0.1:${PORTA}`, `http://127.0.0.1.evil.example:${PORTA}`, `http://127.0.0.1`]) {
    const r = await evento('x-fora', { origin: o });
    assert.equal(r.status, 403, `Origin ${o}`);
    assert.deepEqual(r.json, { erro: 'origem não permitida' });
  }
  // não gravou nada
  assert.equal((await pedir('GET', '/sessao/x-fora')).status, 404);
  // vale para qualquer rota que mude coisa, e também sem o x-gerenciador
  assert.equal((await postar('/limpar', { origin: FORA })).status, 403);
  assert.equal((await pedir('POST', '/evento', { headers: { origin: FORA, 'content-type': 'text/plain' }, corpo: '{"session_id":"y"}' })).status, 403);
});

test('POST com Origin local passa (127.0.0.1 e localhost)', async () => {
  for (const o of [LOCAL, LOCALHOST]) {
    const r = await evento('x-local', { origin: o });
    assert.equal(r.status, 200, `Origin ${o}`);
    assert.equal(r.json.ok, true);
  }
  assert.equal((await pedir('GET', '/sessao/x-local')).status, 200);
});

test('POST sem Origin e sem Sec-Fetch-Site (estilo hook) passa', async () => {
  const r = await evento('x-hook');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  // e continua exigindo o x-gerenciador
  const sem = await pedir('POST', '/evento', { headers: { 'content-type': 'application/json' }, corpo: '{"session_id":"z"}' });
  assert.equal(sem.status, 403);
  assert.equal(sem.json.erro, 'cabeçalho ausente');
});

test('POST sem Origin: Sec-Fetch-Site same-origin/none passa; cross-site/same-site → 403', async () => {
  assert.equal((await evento('x-sfs1', { 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await evento('x-sfs2', { 'sec-fetch-site': 'none' })).status, 200);
  for (const v of ['cross-site', 'same-site', 'Cross-Site', 'qualquer-coisa']) {
    const r = await evento('x-sfs3', { 'sec-fetch-site': v });
    assert.equal(r.status, 403, v);
    assert.deepEqual(r.json, { erro: 'origem não permitida' });
  }
  // Origin local vale mesmo com Sec-Fetch-Site (a página em same-origin manda os dois)
  assert.equal((await evento('x-sfs4', { origin: LOCAL, 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await pedir('GET', '/sessao/x-sfs3')).status, 404);
});

test('GET /estado: normal e same-origin/none → 200; cross-site/same-site → 403', async () => {
  const r = await pedir('GET', '/estado');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.sessoes));
  assert.equal((await pedir('GET', '/estado', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
  assert.equal((await pedir('GET', '/estado', { headers: { 'sec-fetch-site': 'none' } })).status, 200);
  for (const v of ['cross-site', 'same-site']) {
    const x = await pedir('GET', '/estado', { headers: { 'sec-fetch-site': v } });
    assert.equal(x.status, 403, v);
    assert.deepEqual(x.json, { erro: 'origem não permitida' });
  }
  // dados sensíveis e rotas com efeito colateral por GET
  for (const rota of ['/config', '/historico', '/uso', '/saude', '/perfil', '/assets/Geist-Variable.woff2', '/sw.js', '/manifest.webmanifest']) {
    assert.equal((await pedir('GET', rota, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' } })).status, 403, rota);
  }
});

test('GET: só a navegação de topo para a própria página é exceção', async () => {
  const nav = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  assert.equal((await pedir('GET', '/', { headers: nav })).status, 200);
  assert.equal((await pedir('GET', '/index.html', { headers: nav })).status, 200);
  assert.notEqual((await pedir('GET', '/offline.html', { headers: nav })).status, 403);
  // navegação de topo para dados continua barrada, e iframe até para a página
  assert.equal((await pedir('GET', '/estado', { headers: nav })).status, 403);
  assert.equal((await pedir('GET', '/fluxo', { headers: nav })).status, 403);
  assert.equal((await pedir('GET', '/', { headers: { ...nav, 'sec-fetch-dest': 'iframe' } })).status, 403);
  assert.equal((await pedir('GET', '/', { headers: { ...nav, 'sec-fetch-mode': 'cors' } })).status, 403);
});

test('quadro (iframe, frame, embed, object) nunca abre o Orbit, nem da própria origem; a página sai com frame-ancestors (P2-4)', async () => {
  for (const dest of ['iframe', 'frame', 'embed', 'object']) {
    for (const site of ['same-origin', 'none', 'cross-site']) {
      for (const rota of ['/', '/estado', '/assets/assistente.js']) {
        const r = await pedir('GET', rota, { headers: { 'sec-fetch-site': site, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': dest } });
        assert.equal(r.status, 403, `${dest} ${site} ${rota}`);
        assert.deepEqual(r.json, { erro: 'o Orbit não abre dentro de um quadro' });
      }
    }
  }
  const r = await pedir('POST', '/evento', { headers: { origin: LOCAL, 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'iframe', 'content-type': 'application/json' }, corpo: '{}' });
  assert.equal(r.status, 403);
  const pag = await pedir('GET', '/', { headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
  assert.equal(pag.status, 200);
  assert.equal(pag.cab['content-security-policy'], "frame-ancestors 'none'");
  assert.equal(pag.cab['x-frame-options'], 'DENY');
});

test('página same-origin: abre a página, o SSE (/fluxo), o sw.js e o manifesto', async () => {
  const same = { 'sec-fetch-site': 'same-origin' };
  const pag = await pedir('GET', '/', { headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
  assert.equal(pag.status, 200);
  assert.match(pag.texto, /<html/i);
  assert.equal((await pedir('GET', '/sw.js', { headers: same })).status, 200);
  assert.equal((await pedir('GET', '/manifest.webmanifest', { headers: same })).status, 200);
  const status = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: '/fluxo', headers: { ...same, accept: 'text/event-stream' }, agent: false }, (res) => {
      res.once('data', () => { resolve(res.statusCode); req.destroy(); });
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? undefined : reject(e)));
    setTimeout(() => { resolve('sem dados'); req.destroy(); }, 4000).unref();
  });
  assert.equal(status, 200);
  const cross = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORTA, path: '/fluxo', headers: { 'sec-fetch-site': 'cross-site', accept: 'text/event-stream' }, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(cross, 403);
});

test('Host estranho continua 403 (checagem anterior intacta)', async () => {
  assert.equal((await pedir('GET', '/estado', { headers: { host: `malicioso.exemplo:${PORTA}` } })).status, 403);
});

test('upgrade do terminal não passa pelo bloqueio de origem (resposta é do terminal.mjs)', async () => {
  // Upgrade sem Origin/bilhete: quem recusa é o terminal.mjs (403 próprio, ou socket destruído se não houver
  // terminal neste servidor). Nunca devolve o JSON de origem do handler de pedidos.
  const r = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORTA, path: '/terminal/ws', agent: false, timeout: 4000,
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-fetch-site': 'cross-site' },
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode }); });
    req.on('response', (res) => { const p = []; res.on('data', (c) => p.push(c)); res.on('end', () => resolve({ status: res.statusCode, texto: Buffer.concat(p).toString() })); });
    req.on('error', () => resolve({ status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0 }); });
    req.end();
  });
  assert.ok(r.status === 403 || r.status === 0, `status ${r.status}`);
  assert.ok(!String(r.texto || '').includes('origem não permitida'));
});

test('hook.mjs de verdade continua entregando /evento', async () => {
  const id = `origem-hook-${Date.now()}`;
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(RAIZ, 'hook.mjs')], { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.on('exit', (codigo) => resolve({ codigo, out }));
    p.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: id, cwd, prompt: 'pelo hook' }));
  });
  assert.equal(r.codigo, 0);
  assert.equal(r.out, '');
  let s;
  for (let i = 0; i < 40 && !s; i++) {
    const g = await pedir('GET', `/sessao/${id}`);
    if (g.status === 200) s = g.json.sessao;
    else await espera(50);
  }
  assert.ok(s, 'o evento do hook não chegou');
  assert.equal(s.status, 'trabalhando');
});

test('statusline.mjs de verdade continua falando com o servidor', async () => {
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(RAIZ, 'statusline.mjs')], { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.on('exit', (codigo) => resolve({ codigo, out }));
    p.stdin.end(JSON.stringify({ session_id: 'origem-sl', cwd, model: { id: 'claude-x', display_name: 'X' }, rate_limits: { five_hour: { used_percentage: 10, resets_at: Math.floor(Date.now() / 1000) + 3600 } } }));
  });
  assert.equal(r.codigo, 0);
  let u;
  for (let i = 0; i < 40 && !u?.json?.cincoHoras; i++) { u = await pedir('GET', '/uso'); if (!u.json?.cincoHoras) await espera(50); }
  assert.ok(u.json?.cincoHoras, 'o uso da statusline não chegou: ' + u.texto);
});
