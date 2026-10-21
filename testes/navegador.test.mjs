// Testes do navegador interno, lado do servidor (navegador.mjs). Rodar:  node testes/navegador.test.mjs
// Sites falsos em portas livres de 127.0.0.1; dados numa pasta temporária; o "abrir fora" e as portas do
// sistema são trocados por funções de teste (nada abre no Windows de verdade).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { criarNavegador, normalizarUrl, ehLocal, ehDoOrbit, bloqueioDeQuadro, lerLsof, lerPs, lerPortasMac } from '../navegador.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-nav-'));
const servidores = [];
after(() => {
  for (const s of servidores) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function site(rotas) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const f = rotas[req.url] || rotas['*'];
      if (!f) { res.writeHead(404); return res.end(); }
      f(req, res);
    });
    servidores.push(s);
    s.listen(0, '127.0.0.1', () => resolve(s.address().port));
  });
}
const resp = (cab = {}, status = 200) => (req, res) => { res.writeHead(status, { 'content-type': 'text/html', ...cab }); res.end('<p>oi</p>'); };

// Pedido e resposta falsos para as rotas.
function pedido(method, corpo) {
  const req = Readable.from(corpo == null ? [] : [Buffer.from(JSON.stringify(corpo))]);
  req.method = method;
  req.headers = {};
  return req;
}
function resposta() {
  const r = { status: 0, corpo: null, headersSent: false };
  r.writeHead = (s) => { r.status = s; r.headersSent = true; };
  r.end = (t) => { r.corpo = t ? JSON.parse(t) : null; };
  return r;
}
async function lerJSONCorpo(req) {
  let t = '';
  for await (const c of req) t += c;
  return t ? JSON.parse(t) : {};
}
async function chamar(nav, method, rota, corpo, busca = '') {
  const res = resposta();
  const url = new URL('http://127.0.0.1' + rota + busca);
  const ok = await nav.rota(pedido(method, corpo), res, rota, url);
  return { ok, status: res.status, corpo: res.corpo };
}

test('normalizarUrl: http/https, sem esquema vira http, o resto é recusado', () => {
  assert.equal(normalizarUrl('localhost:5173'), 'http://localhost:5173/');
  assert.equal(normalizarUrl('  https://exemplo.com/a?b=1 '), 'https://exemplo.com/a?b=1');
  assert.equal(normalizarUrl('github.com/x'), 'http://github.com/x');
  for (const ruim of ['javascript:alert(1)', 'file:///C:/x', 'data:text/html,x', 'mailto:a@b', 'ftp://x', '', '   ', null, 'http://', 'a\nb', 'x'.repeat(3000)]) {
    assert.equal(normalizarUrl(ruim), null, String(ruim).slice(0, 30));
  }
});

test('ehLocal: localhost, 127.x e [::1]', () => {
  for (const u of ['http://localhost:3000/', 'http://127.0.0.1:8000/', 'http://127.1.2.3/', 'http://[::1]:5173/', 'http://app.localhost/']) assert.ok(ehLocal(u), u);
  for (const u of ['https://github.com/', 'http://192.168.0.2/', 'http://localhost.exemplo.com/']) assert.ok(!ehLocal(u), u);
});

test('bloqueioDeQuadro: X-Frame-Options e frame-ancestors', () => {
  const P = 47821;
  assert.equal(bloqueioDeQuadro({}, P), null);
  assert.equal(bloqueioDeQuadro({ 'x-frame-options': 'DENY' }, P), 'x-frame-options');
  assert.equal(bloqueioDeQuadro({ 'x-frame-options': 'sameorigin' }, P), 'x-frame-options');
  assert.equal(bloqueioDeQuadro({ 'x-frame-options': 'ALLOW-FROM https://x' }, P), null); // o Chromium ignora
  assert.equal(bloqueioDeQuadro({ 'content-security-policy': "frame-ancestors 'none'" }, P), 'frame-ancestors');
  assert.equal(bloqueioDeQuadro({ 'content-security-policy': "frame-ancestors 'self'" }, P), 'frame-ancestors');
  assert.equal(bloqueioDeQuadro({ 'content-security-policy': "default-src 'self'; frame-ancestors *" }, P), null);
  assert.equal(bloqueioDeQuadro({ 'content-security-policy': "frame-ancestors 'self' http://127.0.0.1:*" }, P), null);
  assert.equal(bloqueioDeQuadro({ 'content-security-policy': 'frame-ancestors http://127.0.0.1:47821' }, P), null);
  assert.equal(bloqueioDeQuadro({ 'content-security-policy': 'frame-ancestors https://127.0.0.1:47821' }, P), 'frame-ancestors');
  assert.equal(bloqueioDeQuadro({ 'content-security-policy': 'frame-ancestors http://localhost:47821' }, P), 'frame-ancestors');
  assert.equal(bloqueioDeQuadro({ 'content-security-policy': 'frame-ancestors http:' }, P), null);
  // Com frame-ancestors que aceita, o X-Frame-Options é ignorado (como no navegador).
  assert.equal(bloqueioDeQuadro({ 'content-security-policy': 'frame-ancestors *', 'x-frame-options': 'DENY' }, P), null);
  // Só a CSP sem frame-ancestors não bloqueia.
  assert.equal(bloqueioDeQuadro({ 'content-security-policy': "default-src 'none'" }, P), null);
});

test('checar: ok, bloqueado, redirecionamento, fora do ar e o próprio Orbit', async () => {
  const p = await site({
    '/': resp(),
    '/negado': resp({ 'x-frame-options': 'DENY' }),
    '/csp': resp({ 'content-security-policy': "frame-ancestors 'none'" }),
    '/vai': (req, res) => { res.writeHead(302, { location: '/negado' }); res.end(); },
    '/erro': resp({}, 500),
  });
  const nav = criarNavegador({ dados: path.join(tmp, 'a'), porta: 47821, teste: true, lerJSONCorpo });
  let r = await nav.checar(`127.0.0.1:${p}`);
  assert.equal(r.estado, 'ok');
  assert.equal(r.local, true);
  r = await nav.checar(`http://127.0.0.1:${p}/negado`);
  assert.equal(r.estado, 'bloqueado');
  assert.equal(r.bloqueio, 'x-frame-options');
  r = await nav.checar(`http://127.0.0.1:${p}/csp`);
  assert.equal(r.bloqueio, 'frame-ancestors');
  r = await nav.checar(`http://127.0.0.1:${p}/vai`);
  assert.equal(r.estado, 'bloqueado', 'o bloqueio depois do redirecionamento conta');
  assert.equal(r.final, `http://127.0.0.1:${p}/negado`);
  r = await nav.checar(`http://127.0.0.1:${p}/erro`);
  assert.equal(r.estado, 'ok', 'erro 500 ainda é página para mostrar');
  assert.equal(r.status, 500);

  // Porta fechada: abre e fecha um servidor para ter uma porta sem ninguém.
  const livre = await new Promise((res) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => res(n)); }); });
  r = await nav.checar(`http://127.0.0.1:${livre}/`);
  assert.equal(r.estado, 'fora-do-ar');

  assert.equal((await nav.checar('http://localhost:47821/')).estado, 'orbit');
  assert.equal((await nav.checar('http://127.0.0.1:47821/x')).estado, 'orbit');
  assert.equal((await nav.checar('javascript:alert(1)')).estado, 'invalido');
});

test('o próprio Orbit nunca abre no iframe: porta da página, porta remota, host do Tailscale e redirecionamento (P2-4)', async () => {
  const O = { portas: [47821, 47820], hosts: ['pc.exemplo.ts.net'] };
  for (const u of ['http://127.0.0.1:47821/', 'http://localhost:47821/x', 'http://[::1]:47821/', 'http://127.0.0.2:47821/',
    'http://app.localhost:47821/', 'http://0.0.0.0:47821/', 'http://127.0.0.1:47820/m', 'https://pc.exemplo.ts.net/m', 'https://PC.exemplo.ts.net/']) {
    assert.ok(ehDoOrbit(u, O), u);
  }
  for (const u of ['http://127.0.0.1:5173/', 'http://192.168.0.2:47821/', 'https://exemplo.com:47821/', 'https://outro.ts.net/', 'lixo']) {
    assert.ok(!ehDoOrbit(u, O), u);
  }

  const alvo = await site({ '/': resp() });
  const p = await site({ '/vai-orbit': (req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${alvo}/` }); res.end(); } });
  const nav = criarNavegador({ dados: path.join(tmp, 'o'), porta: 47821, teste: true, lerJSONCorpo,
    enderecosOrbit: () => ({ portas: [47820, alvo], hosts: ['pc.exemplo.ts.net'] }) });
  for (const u of ['127.0.0.1:47820', 'http://localhost:47820/m', 'https://pc.exemplo.ts.net/m', `http://127.0.0.1:${alvo}/`]) {
    const r = await nav.checar(u);
    assert.equal(r.estado, 'orbit', u);
    assert.equal(r.motivo, 'Este é o endereço do próprio Orbit.');
  }
  assert.equal((await nav.checar(`http://127.0.0.1:${p}/vai-orbit`)).estado, 'orbit', 'redirecionar para o Orbit também é recusado');
  // A prévia do projeto não guarda o endereço do Orbit.
  const r = await chamar(nav, 'POST', '/navegador/previa', { pasta: path.join(tmp, 'P'), url: 'localhost:47821' });
  assert.equal(r.status, 400);
  assert.equal(r.corpo.motivo, 'orbit');
  // enderecosOrbit que falha: a porta da página continua valendo.
  const nav2 = criarNavegador({ dados: path.join(tmp, 'o2'), porta: 47821, teste: true, lerJSONCorpo, enderecosOrbit: () => { throw new Error('x'); } });
  assert.equal((await nav2.checar('http://127.0.0.1:47821/')).estado, 'orbit');
});

test('rotas: prévias por pasta, gravadas e difundidas', async () => {
  const dados = path.join(tmp, 'b');
  const difundidos = [];
  const nav = criarNavegador({ dados, teste: true, lerJSONCorpo, difundir: (t, d) => difundidos.push([t, d]) });
  let r = await chamar(nav, 'GET', '/navegador/previas');
  assert.deepEqual(r.corpo, { previas: [] });
  const pasta = path.join(tmp, 'Projeto X');
  r = await chamar(nav, 'POST', '/navegador/previa', { pasta, url: 'localhost:5173' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.corpo.previas, [{ pasta: path.resolve(pasta), url: 'http://localhost:5173/' }]);
  assert.equal(difundidos.at(-1)[0], 'previas');
  // Mesma pasta com outra caixa e barra no fim: substitui.
  r = await chamar(nav, 'POST', '/navegador/previa', { pasta: pasta.toUpperCase() + path.sep, url: 'http://127.0.0.1:3000' });
  assert.equal(r.corpo.previas.length, 1);
  assert.equal(r.corpo.previas[0].url, 'http://127.0.0.1:3000/');
  // Inválido.
  r = await chamar(nav, 'POST', '/navegador/previa', { pasta, url: 'javascript:alert(1)' });
  assert.equal(r.status, 400);
  r = await chamar(nav, 'POST', '/navegador/previa', { url: 'http://x' });
  assert.equal(r.status, 400);
  // Relê do disco num módulo novo.
  const nav2 = criarNavegador({ dados, teste: true, lerJSONCorpo });
  r = await chamar(nav2, 'GET', '/navegador/previas');
  assert.equal(r.corpo.previas[0].url, 'http://127.0.0.1:3000/');
  // Vazio remove.
  r = await chamar(nav2, 'POST', '/navegador/previa', { pasta, url: '' });
  assert.deepEqual(r.corpo.previas, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dados, 'previas.json'), 'utf8')).previas, {});
  // Rota de fora do módulo não é dele.
  assert.equal((await chamar(nav2, 'GET', '/projetos')).ok, false);
});

test('rotas: abrir fora (servidor de teste só registra) e checar', async () => {
  const abertos = [];
  const nav = criarNavegador({ dados: path.join(tmp, 'c'), lerJSONCorpo, abrirFora: (u) => abertos.push(u) });
  let r = await chamar(nav, 'POST', '/navegador/externo', { url: 'localhost:3000/a' });
  assert.equal(r.status, 200);
  assert.deepEqual(abertos, ['http://localhost:3000/a']);
  r = await chamar(nav, 'POST', '/navegador/externo', { url: 'file:///C:/Windows' });
  assert.equal(r.status, 400);
  assert.equal(abertos.length, 1);
  const navT = criarNavegador({ dados: path.join(tmp, 'c2'), lerJSONCorpo, teste: true });
  await chamar(navT, 'POST', '/navegador/externo', { url: 'https://exemplo.com' });
  assert.deepEqual((await chamar(navT, 'GET', '/navegador/abertos')).corpo.abertos, ['https://exemplo.com/']);
  // Fora do modo de teste, /navegador/abertos não existe.
  assert.equal((await chamar(nav, 'GET', '/navegador/abertos')).ok, false);
});

test('portas: só o que responde HTTP, marcado pelo projeto cuja pasta aparece na linha de comando', async () => {
  const pv = await site({ '*': resp() });
  const pOutro = await site({ '*': resp() });
  const proj = 'D:\\Projetos\\Loja';
  const listarPortas = async () => ({
    conexoes: [
      { LocalAddress: '127.0.0.1', LocalPort: pv, OwningProcess: 101 },
      { LocalAddress: '0.0.0.0', LocalPort: pOutro, OwningProcess: 202 },
      { LocalAddress: '127.0.0.1', LocalPort: 1, OwningProcess: 303 },       // abaixo de 1024
      { LocalAddress: '192.168.0.9', LocalPort: 5555, OwningProcess: 404 },  // fora do loopback
      { LocalAddress: '127.0.0.1', LocalPort: 47821, OwningProcess: 505 },   // o próprio Orbit
      { LocalAddress: '127.0.0.1', LocalPort: 7777, OwningProcess: 606 },    // svchost
    ],
    processos: [
      { ProcessId: 100, ParentProcessId: 1, Name: 'cmd.exe', CommandLine: 'cmd /c npm run dev' },
      { ProcessId: 101, ParentProcessId: 100, Name: 'node.exe', CommandLine: 'node "D:\\Projetos\\Loja\\node_modules\\vite\\bin\\vite.js"' },
      { ProcessId: 202, ParentProcessId: 1, Name: 'node.exe', CommandLine: 'node D:\\Projetos\\Loja2\\server.js' },
      { ProcessId: 606, ParentProcessId: 1, Name: 'svchost.exe', CommandLine: 'svchost' },
    ],
  });
  // so: 'win32' — os caminhos são do Windows (D:\…); no Windows é o padrão, no Mac simula o PC.
  const nav = criarNavegador({ dados: path.join(tmp, 'd'), lerJSONCorpo, listarPortas, faixaPortas: [1024, 65536], so: 'win32' });
  const r = await chamar(nav, 'GET', '/navegador/portas', null, '?pasta=' + encodeURIComponent(proj) + '&pasta=' + encodeURIComponent('D:\\Outra'));
  const lista = r.corpo.portas;
  assert.deepEqual(lista.map((x) => x.porta), [pv, pOutro], 'só as duas que respondem e passam no filtro');
  assert.equal(lista[0].doProjeto, true);
  assert.equal(lista[0].pasta, proj);
  assert.equal(lista[0].url, `http://localhost:${pv}/`);
  assert.equal(lista[1].doProjeto, false, 'D:\\Projetos\\Loja2 não é D:\\Projetos\\Loja');
  // Sem a lista do sistema: erro amigável, sem quebrar.
  const nav2 = criarNavegador({ dados: path.join(tmp, 'e'), lerJSONCorpo, listarPortas: async () => null });
  const r2 = await chamar(nav2, 'GET', '/navegador/portas');
  assert.deepEqual(r2.corpo.portas, []);
  assert.ok(r2.corpo.erro);
});

// ── Mac simulado (16/10): saídas falsas do lsof e do ps, so 'darwin'; nada roda no Mac de verdade ──
const LSOF_CAB = 'COMMAND              PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME';

test('Mac: lerLsof e lerPs entendem a saída do lsof/ps', () => {
  const { conexoes, nomes } = lerLsof([
    LSOF_CAB,
    'launchd                1   root    7u  IPv6 0x11      0t0  TCP *:22 (LISTEN)',
    'node                 101 usuario  23u  IPv4 0x22      0t0  TCP 127.0.0.1:5173 (LISTEN)',
    'node                 101 usuario  24u  IPv6 0x23      0t0  TCP [::1]:5173 (LISTEN)',
    'Google\\x20Chrome     700 usuario  30u  IPv4 0x33      0t0  TCP *:9222 (LISTEN)',
    'Code Helper          800 usuario  31u  IPv4 0x34      0t0  TCP 127.0.0.1:9333 (LISTEN)', // nome com espaço cru
    'lixo sem formato',
    'node                 101 usuario  25u  IPv4 0x24      0t0  TCP 127.0.0.1:5174->127.0.0.1:6000 (ESTABLISHED)',
  ].join('\n'));
  assert.deepEqual(conexoes, [
    { LocalAddress: '::', LocalPort: 22, OwningProcess: 1 },
    { LocalAddress: '127.0.0.1', LocalPort: 5173, OwningProcess: 101 },
    { LocalAddress: '::1', LocalPort: 5173, OwningProcess: 101 },
    { LocalAddress: '0.0.0.0', LocalPort: 9222, OwningProcess: 700 },
    { LocalAddress: '127.0.0.1', LocalPort: 9333, OwningProcess: 800 },
  ]);
  assert.equal(nomes.get(700), 'Google Chrome', 'o \\x20 do lsof vira espaço');
  assert.equal(nomes.get(800), 'Code Helper', 'nome com espaço cru também');
  const procs = lerPs('  101   100 node /Users/t/Loja/vite.js --port 5173\n  100     1 /bin/zsh -c npm run dev\n  999     1\nlixo\n', nomes);
  assert.deepEqual(procs, [
    { ProcessId: 101, ParentProcessId: 100, Name: 'node', CommandLine: 'node /Users/t/Loja/vite.js --port 5173' },
    { ProcessId: 100, ParentProcessId: 1, Name: 'zsh', CommandLine: '/bin/zsh -c npm run dev' },
    { ProcessId: 999, ParentProcessId: 1, Name: '', CommandLine: '' },
  ]);
});

test('Mac: lerPortasMac chama lsof e ps com os argumentos certos; nada escutando não chama o ps', async () => {
  const chamadas = [];
  const rodar = async (cmd, args) => { chamadas.push([cmd, args]); return cmd.endsWith('lsof') ? '' : 'nao devia'; };
  assert.deepEqual(await lerPortasMac(rodar), { conexoes: [], processos: [] });
  assert.deepEqual(chamadas, [['/usr/sbin/lsof', ['+c', '0', '-nP', '-iTCP', '-sTCP:LISTEN']]]);
  assert.equal(await lerPortasMac(async () => null), null, 'lsof falhou → null (erro amigável na rota)');
});

test('Mac: portas pelo lsof/ps, sem os processos do sistema, marcadas pela pasta do projeto', async () => {
  const pv = await site({ '*': resp() });
  const pOutro = await site({ '*': resp() });
  const pRap = await site({ '*': resp() });
  const pChrome = await site({ '*': resp() });
  const lsof = [
    LSOF_CAB,
    `node                 101 usuario  23u  IPv4 0x22      0t0  TCP 127.0.0.1:${pv} (LISTEN)`,
    `node                 202 usuario  23u  IPv4 0x44      0t0  TCP *:${pOutro} (LISTEN)`,
    `rapportd             512 usuario   9u  IPv4 0x55      0t0  TCP *:${pRap} (LISTEN)`,
    `Google\\x20Chrome     700 usuario  30u  IPv4 0x33      0t0  TCP 127.0.0.1:${pChrome} (LISTEN)`,
    'node                 303 usuario  23u  IPv4 0x66      0t0  TCP 192.168.0.9:5555 (LISTEN)',
  ].join('\n');
  const ps = [
    '  100     1 /bin/zsh -c npm run dev',
    '  101   100 node /Users/usuario/Projetos/Loja/node_modules/vite/bin/vite.js',
    '  202     1 node /Users/usuario/Projetos/Loja2/server.js',
    '  512     1 /usr/libexec/rapportd',
    '  700     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222',
  ].join('\n');
  const chamadas = [];
  const rodar = async (cmd, args) => { chamadas.push(cmd); return cmd === '/usr/sbin/lsof' ? lsof : cmd === '/bin/ps' ? ps : null; };
  const nav = criarNavegador({ dados: path.join(tmp, 'mac'), lerJSONCorpo, so: 'darwin', rodar, faixaPortas: [1024, 65536] });
  const proj = '/Users/Usuario/Projetos/Loja'; // maiúscula diferente: o disco do Mac não diferencia
  const r = await chamar(nav, 'GET', '/navegador/portas', null, '?pasta=' + encodeURIComponent(proj));
  const lista = r.corpo.portas;
  assert.deepEqual(chamadas, ['/usr/sbin/lsof', '/bin/ps']);
  assert.deepEqual(lista.map((x) => x.porta), [pv, pOutro], 'rapportd e Google Chrome ficam de fora; 192.168.* também');
  assert.equal(lista[0].doProjeto, true);
  assert.equal(lista[0].pasta, proj);
  assert.equal(lista[0].nome, 'node');
  assert.equal(lista[1].doProjeto, false, '/Users/usuario/Projetos/Loja2 não é .../Loja');
  // lsof indisponível: erro amigável, sem quebrar.
  const nav2 = criarNavegador({ dados: path.join(tmp, 'mac2'), lerJSONCorpo, so: 'darwin', rodar: async () => null });
  const r2 = await chamar(nav2, 'GET', '/navegador/portas');
  assert.deepEqual(r2.corpo.portas, []);
  assert.ok(r2.corpo.erro);
});
