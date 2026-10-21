// Testes do acesso remoto pelo celular (remoto.mjs + porta remota do servidor.mjs).
// Rodar:  node --test testes/remoto.test.mjs
// Sobe um servidor próprio: a porta local E a porta remota (config.remoto.porta) saem de 47822–47826, conferidas livres
// (nunca a 47821). Dados, registro de sessões, projetos e o Tailscale são falsos (ORBIT_TAILSCALE_FALSO: nada chama a
// CLI de verdade); o claude é o testes/claude-falso.mjs. No fim, desliga só o processo (e o motor) que subiu e apaga
// a pasta temporária.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escolherPorta, portaLivre, desligarSeMeu, FAIXA } from './porta-livre.mjs';
import { matarArvore } from '../plataforma.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47824);
let PORTA_R = 0;
for (const p of FAIXA) if (p !== PORTA && (await portaLivre(p))) { PORTA_R = p; break; }
if (!PORTA_R) throw new Error('sem 2ª porta livre em 47822–47826 para a porta remota');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-remoto-'));
const SESSOES = path.join(DADOS, 'sessoes');
const PROJETOS = path.join(DADOS, 'projetos');
const PROJ = path.join(DADOS, 'cwd', 'proj');
const FORA = path.join(DADOS, 'cwd', 'fora');
for (const d of [SESSOES, PROJETOS, PROJ, FORA]) fs.mkdirSync(d, { recursive: true });
const HOST = 'orbit-teste.exemplo.ts.net';
const DONO = 'usuario@exemplo.com';
const ORIGEM = `https://${HOST}`;
const PEDIDO_MS = 2000;
const BLOQUEIO_MS = 1500;
const BLOQUEIO_GLOBAL_MS = 2500; // 10 erros na janela (em produção, 1 h que dobra)
const RENOVAR_MS = 1500; // reemissão do cookie (em produção, 1x/dia)
const TS = path.join(DADOS, 'tailscale-falso.json');
fs.writeFileSync(TS, JSON.stringify({
  status: { BackendState: 'Running', Self: { DNSName: HOST + '.', UserID: 7 }, User: { 7: { LoginName: DONO } } },
  serve: {},
}));
// host e dono vazios: a detecção (falsa) preenche ao ligar.
fs.writeFileSync(path.join(DADOS, 'config.json'), JSON.stringify({ remoto: { porta: PORTA_R } }));
fs.writeFileSync(path.join(DADOS, 'projetos.json'), JSON.stringify({ lista: [{ nome: 'proj', pasta: PROJ, desde: new Date().toISOString() }], ocultos: [] }));

const ENV = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_TICK_MS: '250',
  GERENCIADOR_PID_MS: '300',
  GERENCIADOR_SESSOES_DIR: SESSOES,
  ORBIT_PROJETOS_DIR: PROJETOS,
  ...(WIN ? {} : { HOME: path.join(DADOS, 'home') }),
  ORBIT_CLAUDE_BIN: path.join(RAIZ, 'testes', 'claude-falso.mjs'),
  ORBIT_MODELOS: '0',
  ORBIT_MS_REGISTRO: '200',
  ORBIT_MS_VIGIA: '100',
  ORBIT_MS_INICIO: '4000',
  ORBIT_TAILSCALE_FALSO: TS,
  ORBIT_REMOTO_PEDIDO_MS: String(PEDIDO_MS),
  ORBIT_REMOTO_BLOQUEIO_MS: String(BLOQUEIO_MS),
  ORBIT_REMOTO_BLOQUEIO_GLOBAL_MS: String(BLOQUEIO_GLOBAL_MS),
  ORBIT_REMOTO_RENOVAR_MS: String(RENOVAR_MS),
  CLAUDE_CODE_ENTRYPOINT: 'teste',
};
delete ENV.CLAUDE_CODE_HOST_SESSION_ID;
delete ENV.CLAUDECODE;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function pedirEm(porta, metodo, rota, { headers = {}, corpo } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    const dados = corpo === undefined ? undefined : typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
    if (dados !== undefined) h['content-length'] = Buffer.byteLength(dados);
    const req = http.request({ host: '127.0.0.1', port: porta, path: rota, method: metodo, headers: h, timeout: 20000, agent: false }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        let json;
        try { json = JSON.parse(texto); } catch {}
        resolve({ status: res.statusCode, json, texto, headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (dados !== undefined) req.write(dados);
    req.end();
  });
}
// Porta local (gestão, como a página do PC).
const local = (metodo, rota, corpo) => pedirEm(PORTA, metodo, rota, { headers: { 'x-gerenciador': '1', ...(corpo !== undefined ? { 'content-type': 'application/json' } : {}) }, corpo });
// Porta remota, como o Safari atrás do tailscale serve (que manda o login do dono; null tira o cabeçalho).
function remoto(metodo, rota, { cookie, corpo, headers = {} } = {}) {
  const h = { host: HOST, 'tailscale-user-login': DONO, ...(cookie ? { cookie: `__Host-orbit=${cookie}` } : {}) };
  if (metodo === 'POST') Object.assign(h, { origin: ORIGEM, 'content-type': 'application/json' });
  Object.assign(h, headers);
  for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
  return pedirEm(PORTA_R, metodo, rota, { headers: h, corpo: metodo === 'POST' ? (corpo ?? {}) : corpo });
}

// SSE na porta remota: guarda os eventos; `fechou` resolve quando o servidor derruba a conexão.
function sse(rota, cookie) {
  const eventos = [];
  let fechar;
  const fechou = new Promise((r) => (fechar = r));
  const pronto = new Promise((ok, ko) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA_R, path: rota, agent: false, headers: { host: HOST, 'tailscale-user-login': DONO, cookie: `__Host-orbit=${cookie}`, accept: 'text/event-stream' } }, (res) => {
      ok({ status: res.statusCode, req });
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const bloco = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const tipo = /^event: (.*)$/m.exec(bloco)?.[1];
          const dado = /^data: (.*)$/m.exec(bloco)?.[1];
          if (tipo) eventos.push({ tipo, dados: dado ? JSON.parse(dado) : null });
        }
      });
      res.on('close', () => fechar('close'));
      res.on('end', () => fechar('end'));
    });
    req.on('error', (e) => { fechar('erro'); ko(e); });
  });
  return { eventos, fechou, pronto };
}

async function esperarQue(cond, ms = 8000, rotulo = 'condição') {
  const fim = Date.now() + ms;
  let ultimo;
  while (Date.now() < fim) {
    ultimo = await cond();
    if (ultimo) return ultimo;
    await espera(60);
  }
  throw new Error(`${rotulo} não aconteceu em ${ms} ms (último: ${JSON.stringify(ultimo)})`);
}

const tokenDe = (r) => /__Host-orbit=([^;]+)/.exec(String(r.headers['set-cookie'] || ''))?.[1];
async function parear(nome = 'iPhone teste') {
  const p = await remoto('POST', '/remoto/parear/pedir', { corpo: { nome } });
  assert.equal(p.status, 200, p.texto);
  const codigo = (await local('GET', '/remoto/estado')).json.pedido.codigo;
  const c = await remoto('POST', '/remoto/parear/confirmar', { corpo: { pedido: p.json.pedido, codigo } });
  assert.equal(c.status, 200, c.texto);
  return { token: tokenDe(c), aparelho: c.json.aparelho };
}

let proc = null;
const abertos = [];
const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
after(async () => {
  for (const r of abertos) try { r.destroy(); } catch {}
  if (proc) {
    const saiu = new Promise((r) => proc.once('exit', r));
    await desligarSeMeu(PORTA, proc.pid);
    await Promise.race([saiu, espera(4000)]);
    if (proc.exitCode == null) { try { proc.kill(); } catch {} }
  }
  let m = null;
  try { m = JSON.parse(fs.readFileSync(path.join(DADOS, 'motor.json'), 'utf8')); } catch {}
  if (m?.pid && vivo(m.pid)) {
    try {
      if (WIN) execFileSync('taskkill', ['/PID', String(m.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else await matarArvore(m.pid);
    } catch {}
  }
  await espera(300);
  try { fs.rmSync(DADOS, { recursive: true, force: true }); } catch {}
});

test('sobe o servidor de teste; desligado, a porta remota fica fechada', async () => {
  proc = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => process.stderr.write('[servidor] ' + d));
  await esperarQue(async () => (await local('GET', '/saude').catch(() => ({}))).json?.pid === proc.pid, 10000, 'servidor no ar');
  const e = (await local('GET', '/remoto/estado')).json;
  assert.equal(e.ativo, false);
  assert.equal(e.porta, PORTA_R);
  assert.deepEqual(e.aparelhos, []);
  assert.equal(e.pedido, null);
  assert.equal(await portaLivre(PORTA_R), true, 'a porta remota não pode estar aberta');
  await assert.rejects(remoto('GET', '/m'), /ECONNREFUSED/);
});

test('ligar abre a porta sem reiniciar e a detecção preenche host e dono', async () => {
  const r = await local('POST', '/remoto/config', { ativo: true, criarInstancias: true });
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.ativo, true);
  assert.equal(r.json.host, HOST);
  assert.equal(r.json.endereco, `https://${HOST}/m`);
  assert.deepEqual(r.json.tailscale, { instalado: true, logado: true, host: HOST, dono: DONO, serve: false });
  assert.equal(r.json.opcoes.criarInstancias, true);
  const cfg = (await local('GET', '/config')).json.remoto;
  assert.equal(cfg.dono, DONO);
  assert.equal(cfg.ativo, true);
  assert.equal((await remoto('GET', '/m')).status, 200);
  // o mesmo processo segue servindo a 47821 de teste
  assert.equal((await local('GET', '/saude')).json.pid, proc.pid);
  // tailscale serve pelo executor falso (nunca a CLI real)
  const s = await local('POST', '/remoto/tailscale/serve', { ligar: true });
  assert.equal(s.status, 200, s.texto);
  const cmds = fs.readFileSync(TS + '.log', 'utf8');
  assert.ok(cmds.includes(JSON.stringify(['serve', '--bg', '--https=443', `http://127.0.0.1:${PORTA_R}`])), cmds);
});

test('sem cookie: 401 nas rotas de dados; só as públicas respondem; / → /m; cabeçalhos de segurança', async () => {
  for (const rota of ['/estado', '/fluxo', '/uso', '/config', '/sessao/x', '/remoto/eu', '/index.html', '/assets/office/fundo.png', '/assets/widgets.css', '/assets/comum/outro.css', '/assets/sprites/outro.gif', '/assets/sprites/sprite-work.exe', '/assets/sprites/', '/assets/sprites/sub/sprite-work.gif', '/m/index.html', '/m/manifest-m.webmanifest', '/terminal/shells', '/qualquer']) {
    const r = await remoto('GET', rota);
    assert.equal(r.status, 401, rota);
    assert.deepEqual(r.json, { erro: 'nao_pareado' }, rota);
  }
  assert.equal((await remoto('POST', '/sessao/x/mensagem', { corpo: { texto: 'oi' } })).status, 401);
  const raiz = await remoto('GET', '/');
  assert.equal(raiz.status, 302);
  assert.equal(raiz.headers.location, '/m');
  const m = await remoto('GET', '/m');
  assert.equal(m.status, 200);
  assert.equal(m.texto, fs.readFileSync(path.join(RAIZ, 'mobile', 'index.html'), 'utf8'), '/m é o mobile/index.html, nunca o index.html do PC');
  for (const rota of ['/sw.js', '/m/mobile.css', '/m/mobile.js', '/assets/comum/base.css', '/assets/comum/base.js', '/assets/sprites/sprite-work.gif', '/assets/sprites/sprite-done-parado.png', '/offline.html']) assert.equal((await remoto('GET', rota)).status, 200, rota);
  const mani = await remoto('GET', '/manifest-m.webmanifest');
  assert.equal(mani.status, 200, 'manifesto do celular (mobile/manifest-m.webmanifest)');
  const off = await remoto('GET', '/offline.html');
  assert.ok(!off.texto.includes(RAIZ), 'a tela offline não leva a pasta do Orbit ao celular');
  // /offline.html: CSP própria, que libera só os blocos inline dela pelo hash (nunca 'unsafe-inline')
  const hash = (tag) => [...off.texto.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi'))].map((x) => `'sha256-${crypto.createHash('sha256').update(x[1]).digest('base64')}'`);
  const cspOff = off.headers['content-security-policy'];
  assert.ok(!cspOff.includes('unsafe-inline'));
  for (const h of hash('script')) assert.ok(new RegExp(`script-src 'self'[^;]*${h.replace(/[+/=]/g, '\\$&')}`).test(cspOff), `script ${h}`);
  for (const h of hash('style')) assert.ok(new RegExp(`style-src 'self'[^;]*${h.replace(/[+/=]/g, '\\$&')}`).test(cspOff), `style ${h}`);
  assert.ok(cspOff.includes("frame-ancestors 'none'") && cspOff.includes("default-src 'self'"));
  for (const r of [raiz, m, await remoto('GET', '/estado')]) {
    assert.equal(r.headers['content-security-policy'], CSP);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
  }
  // a 47821 não ganhou os cabeçalhos nem as rotas do celular
  assert.equal((await local('GET', '/m')).status, 404);
});

test('Host errado, Origin errado, text/plain e outro login do Tailscale → recusa', async () => {
  for (const host of ['evil.ts.net', `127.0.0.1:${PORTA_R}`, `localhost:${PORTA_R}`, `127.0.0.1:${PORTA}`]) {
    assert.equal((await remoto('GET', '/m', { headers: { host } })).status, 403, host);
  }
  const pedir = (headers) => remoto('POST', '/remoto/parear/pedir', { corpo: { nome: 'x' }, headers });
  for (const origin of ['https://evil.ts.net', `http://${HOST}`, 'null', `https://${HOST}.evil.com`, null]) {
    const r = await pedir({ origin });
    assert.equal(r.status, 403, String(origin));
    assert.deepEqual(r.json, { erro: 'origem não permitida' });
  }
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', null]) {
    assert.equal((await pedir({ 'content-type': ct })).status, 415, String(ct));
  }
  assert.equal((await remoto('GET', '/m', { headers: { 'tailscale-user-login': 'outro@exemplo.com' } })).status, 403);
  assert.equal((await remoto('GET', '/m', { headers: { 'tailscale-user-login': DONO } })).status, 200);
  // P2-3: com dono definido, sem o cabeçalho (nó com tag) também é recusado, inclusive no pareamento
  assert.deepEqual((await remoto('GET', '/m', { headers: { 'tailscale-user-login': null } })).json, { erro: 'usuario_nao_permitido' });
  assert.equal((await pedir({ 'tailscale-user-login': null })).status, 403);
  assert.equal((await pedir({ 'tailscale-user-login': 'outro@exemplo.com' })).status, 403);
  assert.equal((await remoto('GET', '/m', { headers: { 'tailscale-user-login': 'Usuario@Exemplo.com' } })).status, 200, 'maiúsculas não importam');
  for (const metodo of ['PUT', 'DELETE', 'OPTIONS']) assert.equal((await remoto(metodo, '/estado')).status, 405, metodo);
  assert.equal((await local('GET', '/remoto/estado')).json.pedido, null, 'nenhuma recusa criou pedido');
});

let token;
let aparelho;
test('pareamento completo: código só no PC, 1 pedido por vez, cookie __Host-orbit e token só como hash', async () => {
  const p = await remoto('POST', '/remoto/parear/pedir', { corpo: { nome: 'iPhone de teste' } });
  assert.equal(p.status, 200, p.texto);
  assert.equal(typeof p.json.pedido, 'string');
  assert.ok(p.json.expiraEm > Date.now());
  assert.equal(p.json.codigo, undefined, 'o código nunca vai ao celular');
  assert.equal((await remoto('POST', '/remoto/parear/pedir', { corpo: { nome: 'outro' } })).status, 409);
  const e = (await local('GET', '/remoto/estado')).json;
  assert.match(e.pedido.codigo, /^\d{6}$/);
  assert.equal(e.pedido.nome, 'iPhone de teste');
  const errado = String((Number(e.pedido.codigo) + 1) % 1e6).padStart(6, '0');
  const x = await remoto('POST', '/remoto/parear/confirmar', { corpo: { pedido: p.json.pedido, codigo: errado } });
  assert.equal(x.status, 400);
  assert.deepEqual(x.json, { erro: 'codigo_errado', restantes: 4 });
  assert.equal((await remoto('POST', '/remoto/parear/confirmar', { corpo: { pedido: 'outro', codigo: e.pedido.codigo } })).status, 410);
  const c = await remoto('POST', '/remoto/parear/confirmar', { corpo: { pedido: p.json.pedido, codigo: e.pedido.codigo } });
  assert.equal(c.status, 200, c.texto);
  assert.equal(c.json.ok, true);
  assert.equal(c.json.aparelho.nome, 'iPhone de teste');
  const sc = String(c.headers['set-cookie']);
  assert.match(sc, /^__Host-orbit=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=7776000$/);
  token = tokenDe(c);
  aparelho = c.json.aparelho;
  // uso único
  assert.equal((await remoto('POST', '/remoto/parear/confirmar', { corpo: { pedido: p.json.pedido, codigo: e.pedido.codigo } })).status, 410);
  const eu = await remoto('GET', '/remoto/eu', { cookie: token });
  assert.equal(eu.status, 200, eu.texto);
  assert.deepEqual(eu.json.aparelho, aparelho);
  assert.deepEqual(eu.json.opcoes, { criarInstancias: true });
  assert.equal(typeof eu.json.vapidPublica, 'string');
  assert.equal(Buffer.from(eu.json.vapidPublica, 'base64url').length, 65);
  // remoto.json: só o hash
  const bruto = fs.readFileSync(path.join(DADOS, 'remoto.json'), 'utf8');
  assert.ok(!bruto.includes(token), 'o token não pode estar em texto puro');
  const salvo = JSON.parse(bruto).aparelhos;
  assert.equal(salvo.length, 1);
  assert.equal(salvo[0].hash, crypto.createHash('sha256').update(token).digest('hex'));
  // a chave privada VAPID não fica em texto puro: o json só tem a pública
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(DADOS, 'remoto-vapid.json'), 'utf8'))), ['publica']);
  const est = (await local('GET', '/remoto/estado')).json;
  assert.equal(est.pedido, null);
  assert.deepEqual(est.aparelhos.map((a) => [a.id, a.nome, a.push]), [[aparelho.id, aparelho.nome, false]]);
  assert.equal(JSON.stringify(est).includes(salvo[0].hash), false, 'o hash não sai na API');
  // cookie inválido ou adulterado
  assert.equal((await remoto('GET', '/estado', { cookie: token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A') })).status, 401);
});

test('5 códigos errados → o pedido cai e o pareamento bloqueia; depois do prazo volta', async () => {
  const p = await remoto('POST', '/remoto/parear/pedir', { corpo: { nome: 'ataque' } });
  assert.equal(p.status, 200);
  const certo = (await local('GET', '/remoto/estado')).json.pedido.codigo;
  const errado = String((Number(certo) + 1) % 1e6).padStart(6, '0');
  for (let i = 1; i <= 4; i++) {
    const r = await remoto('POST', '/remoto/parear/confirmar', { corpo: { pedido: p.json.pedido, codigo: errado } });
    assert.equal(r.status, 400);
    assert.equal(r.json.restantes, 5 - i);
  }
  const quinto = await remoto('POST', '/remoto/parear/confirmar', { corpo: { pedido: p.json.pedido, codigo: 'abc' } });
  assert.equal(quinto.status, 429);
  assert.equal(quinto.json.erro, 'bloqueado');
  assert.equal((await remoto('POST', '/remoto/parear/confirmar', { corpo: { pedido: p.json.pedido, codigo: certo } })).status, 429, 'nem o código certo passa');
  assert.equal((await remoto('POST', '/remoto/parear/pedir', { corpo: {} })).status, 429);
  const e = (await local('GET', '/remoto/estado')).json;
  assert.equal(e.pedido, null);
  assert.ok(e.bloqueadoAte > Date.now());
  assert.equal(e.aparelhos.length, 1);
  await espera(BLOQUEIO_MS + 150);
  const de = await remoto('POST', '/remoto/parear/pedir', { corpo: {} });
  assert.equal(de.status, 200);
  // o PC recusa o pedido
  const rc = await local('POST', '/remoto/parear/recusar', { pedido: de.json.pedido });
  assert.equal(rc.status, 200);
  assert.equal(rc.json.pedido, null);
});

test('o pedido expira em 2 min (encurtado no teste)', async () => {
  const p = await remoto('POST', '/remoto/parear/pedir', { corpo: { nome: 'lento' } });
  assert.equal(p.status, 200);
  const codigo = (await local('GET', '/remoto/estado')).json.pedido.codigo;
  await espera(PEDIDO_MS + 200);
  assert.equal((await local('GET', '/remoto/estado')).json.pedido, null);
  const c = await remoto('POST', '/remoto/parear/confirmar', { corpo: { pedido: p.json.pedido, codigo } });
  assert.equal(c.status, 410);
  assert.deepEqual(c.json, { erro: "expirado" });
  assert.equal((await local('GET', '/remoto/estado')).json.aparelhos.length, 1);
});

test('10 erros na janela (mesmo em pedidos diferentes) → bloqueio maior que o do pedido, que dobra na reincidência', async () => {
  // Pedido novo; erra até o bloqueio. Já há 6 erros na janela (1 do pareamento + 5 do teste dos 5 códigos): 4 bastam.
  async function errarAteBloquear(max) {
    const p = await remoto('POST', '/remoto/parear/pedir', { corpo: { nome: 'janela' } });
    assert.equal(p.status, 200, p.texto);
    const certo = (await local('GET', '/remoto/estado')).json.pedido.codigo;
    const errado = String((Number(certo) + 1) % 1e6).padStart(6, '0');
    for (let i = 1; i <= max; i++) {
      const r = await remoto('POST', '/remoto/parear/confirmar', { corpo: { pedido: p.json.pedido, codigo: errado } });
      if (r.status === 429) return { r, tentativas: i };
      assert.equal(r.status, 400);
    }
    assert.fail(`sem bloqueio em ${max} erros`);
  }
  const { r, tentativas } = await errarAteBloquear(4);
  assert.equal(tentativas, 4, 'o 10º erro na janela bloqueia, com o pedido ainda com tentativas');
  assert.equal(r.json.erro, 'bloqueado');
  assert.ok(r.json.ate - Date.now() > BLOQUEIO_MS, 'bloqueio global é maior que o do pedido');
  assert.ok(r.json.ate - Date.now() <= BLOQUEIO_GLOBAL_MS);
  const e = (await local('GET', '/remoto/estado')).json;
  assert.equal(e.pedido, null);
  assert.equal(e.bloqueadoAte, r.json.ate);
  assert.equal((await remoto('POST', '/remoto/parear/pedir', { corpo: {} })).status, 429);
  // passado o prazo, volta
  await espera(r.json.ate - Date.now() + 150);
  const de = await remoto('POST', '/remoto/parear/pedir', { corpo: {} });
  assert.equal(de.status, 200, de.texto);
  assert.equal((await local('POST', '/remoto/parear/recusar', { pedido: de.json.pedido })).status, 200);
  // reincidência: o nível subiu, o próximo bloqueio global dobra. 5 erros no pedido (bloqueio curto), prazo, mais 5 → 10 na janela.
  const a = await errarAteBloquear(5);
  assert.equal(a.tentativas, 5);
  assert.ok(a.r.json.ate - Date.now() <= BLOQUEIO_MS, 'ainda o bloqueio do pedido (5 erros na janela)');
  await espera(a.r.json.ate - Date.now() + 150);
  const b = await errarAteBloquear(5);
  assert.equal(b.tentativas, 5);
  assert.ok(b.r.json.ate - Date.now() > BLOQUEIO_GLOBAL_MS * 1.5, `dobrou: ${b.r.json.ate - Date.now()} ms`);
  await espera(b.r.json.ate - Date.now() + 150);
  const fim = await remoto('POST', '/remoto/parear/pedir', { corpo: {} });
  assert.equal(fim.status, 200, fim.texto);
  assert.equal((await local('POST', '/remoto/parear/recusar', { pedido: fim.json.pedido })).status, 200);
});

test('com cookie: terminal, arquivos, repos, config, reiniciar, perfil e o resto fora da lista → 403', async () => {
  const gets = ['/config', '/historico', '/saude', '/perfil', '/perfil/avatar', '/uso/conta', '/projetos', '/arquivos/lista', '/arquivos/ler', '/repos', '/terminal/shells', '/terminal/lista', '/ideias', '/disco', '/regras', '/skills', '/mcp', '/reinicio', '/temas', '/midia', '/navegador/portas', '/index.html', '/remoto/estado', '/remoto/projetos-x', '/modulo-futuro', '/sessao/x/agente/y', '/sessao/x/assumir'];
  for (const rota of gets) {
    const r = await remoto('GET', rota, { cookie: token });
    assert.equal(r.status, 403, `GET ${rota}`);
    assert.deepEqual(r.json, { erro: 'bloqueado_no_celular' }, rota);
  }
  const posts = ['/config', '/reiniciar', '/desligar', '/evento', '/limpar', '/remover', '/nova-instancia', '/terminal/bilhete', '/perfil/conectar', '/conta/claude/sair', '/repos/clonar', '/arquivos/criar', '/projetos', '/ideias', '/mcp/adicionar', '/skills/salvar', '/uso', '/uso/atualizar', '/remoto/config', '/remoto/revogar', '/remoto/tailscale/serve', '/modulo-futuro', '/sessao/x', '/sessao/x/assumir', '/sessao/x/devolver', '/sessao/x/compactar', '/sessao/x/limpar', '/sessao/x/encerrar'];
  for (const rota of posts) {
    const r = await remoto('POST', rota, { cookie: token, corpo: { todos: true, ativo: false } });
    assert.equal(r.status, 403, `POST ${rota}`);
    assert.deepEqual(r.json, { erro: 'bloqueado_no_celular' }, rota);
  }
  // nada passou: o servidor segue no ar, o celular segue ligado e pareado
  assert.equal((await local('GET', '/saude')).json.pid, proc.pid);
  const e = (await local('GET', '/remoto/estado')).json;
  assert.equal(e.ativo, true);
  assert.equal(e.aparelhos.length, 1);
  // terminal (WebSocket) nunca abre na porta remota
  const up = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORTA_R, path: '/terminal/ws', agent: false, headers: { host: HOST, cookie: `__Host-orbit=${token}`, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    req.on('upgrade', (res, s) => { s.destroy(); resolve('upgrade'); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve('fechado'));
    req.end();
  });
  assert.equal(up, 'fechado');
});

test('cookie reemitido no máximo 1x por prazo (os 90 dias contam do último uso) e persistido em cookieEm', async () => {
  const cookieCheio = `__Host-orbit=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=7776000`;
  await espera(RENOVAR_MS + 150);
  const t0 = Date.now();
  const r1 = await remoto('GET', '/remoto/eu', { cookie: token });
  assert.equal(r1.status, 200, r1.texto);
  assert.equal(String(r1.headers['set-cookie']), cookieCheio);
  const r2 = await remoto('GET', '/remoto/eu', { cookie: token });
  assert.equal(r2.status, 200);
  assert.equal(r2.headers['set-cookie'], undefined, 'dentro do prazo não reemite');
  const cookieEm = () => JSON.parse(fs.readFileSync(path.join(DADOS, 'remoto.json'), 'utf8')).aparelhos.find((a) => a.id === aparelho.id)?.cookieEm;
  const salvo = await esperarQue(() => { const v = cookieEm(); return v >= t0 - 50 ? v : 0; }, 3000, 'cookieEm gravado');
  assert.ok(salvo <= Date.now());
  // /remoto/sair continua apagando o cookie (a reemissão não o sobrescreve)
  const outro = await parear('sair-apos-renovar');
  await espera(RENOVAR_MS + 150);
  const s = await remoto('POST', '/remoto/sair', { cookie: outro.token });
  assert.equal(s.status, 200);
  assert.match(String(s.headers['set-cookie']), /^__Host-orbit=; .*Max-Age=0/);
});

test('GET remoto com Sec-Fetch-Site cross-site/same-site → 403, salvo navegação de topo às páginas', async () => {
  const get = (rota, sec) => remoto('GET', rota, { cookie: token, headers: sec });
  for (const site of ['same-site', 'cross-site']) {
    const r = await get('/estado', { 'sec-fetch-site': site });
    assert.equal(r.status, 403, site);
    assert.deepEqual(r.json, { erro: 'origem não permitida' });
    assert.equal((await get('/estado', { 'sec-fetch-site': site, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).status, 403, `${site} cors`);
    // navegação de topo: só as páginas
    const topo = { 'sec-fetch-site': site, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    assert.equal((await get('/m', topo)).status, 200, `${site} /m`);
    assert.equal((await get('/offline.html', topo)).status, 200, `${site} /offline.html`);
    assert.equal((await get('/', topo)).status, 302, `${site} /`);
    assert.equal((await get('/estado', topo)).status, 403, `${site} /estado navegando`);
    assert.equal((await get('/remoto/eu', topo)).status, 403, `${site} /remoto/eu navegando`);
    assert.equal((await get('/m/mobile.css', topo)).status, 403, `${site} asset navegando`);
    // sem cookie também: a recusa vem antes da autenticação
    assert.equal((await remoto('GET', '/estado', { headers: { 'sec-fetch-site': site } })).status, 403, `${site} sem cookie`);
  }
  for (const site of ['same-origin', 'none']) assert.equal((await get('/estado', { 'sec-fetch-site': site })).status, 200, site);
  assert.equal((await get('/estado', {})).status, 200, 'sem o cabeçalho (cliente que não manda) segue valendo');
});

let nativaId;
test('só nativas: a do VS Code some de /estado, /fluxo e /sessao (404); a criada pelo Orbit aparece', async () => {
  // sessão do VS Code (pelo hook, na 47821)
  const ev = (id, extra = {}) => local('POST', '/evento', { session_id: id, hook_event_name: 'UserPromptSubmit', cwd: PROJ, prompt: 'oi', ts: Date.now(), ...extra });
  assert.equal((await ev('vscode-1')).status, 200);
  // POST /instancias pelo celular: só pasta cadastrada (pasta e cwd)
  assert.equal((await remoto('POST', '/instancias', { cookie: token, corpo: { pasta: PROJ, cwd: FORA } })).status, 403, 'cwd também é conferido');
  assert.equal((await remoto('POST', '/instancias', { cookie: token, corpo: { pasta: FORA } })).status, 403);
  assert.equal((await remoto('POST', '/instancias', { cookie: token, corpo: { pasta: PROJ, permissao: 'bypassPermissions' } })).status, 403);
  const proj = await remoto('GET', '/remoto/projetos', { cookie: token });
  assert.equal(proj.status, 200);
  assert.deepEqual(proj.json, [{ pasta: PROJ, nome: 'proj' }]);
  const cr = await remoto('POST', '/instancias', { cookie: token, corpo: { pasta: PROJ, cwd: PROJ, permissao: 'default', nome: 'do celular' } });
  assert.equal(cr.status, 202, cr.texto);
  nativaId = cr.json.sessao;
  assert.equal(typeof nativaId, 'string');
  // a 47821 vê as duas; o celular, só a nativa
  const pc = (await local('GET', '/estado')).json.sessoes.map((s) => s.id);
  assert.ok(pc.includes('vscode-1') && pc.includes(nativaId));
  const est = (await remoto('GET', '/estado', { cookie: token })).json;
  assert.deepEqual(Object.keys(est).sort(), ['sessoes', 'uso']);
  assert.deepEqual(est.sessoes.map((s) => s.id), [nativaId]);
  for (const r of ['', '/conversa', '/acoes', '/comandos']) {
    assert.equal((await remoto('GET', `/sessao/vscode-1${r}`, { cookie: token })).status, 404, r);
  }
  for (const r of ['/mensagem', '/permissao', '/parar', '/modelo', '/esforco', '/modo']) {
    assert.equal((await remoto('POST', `/sessao/vscode-1${r}`, { cookie: token, corpo: { texto: 'x', modo: 'plan' } })).status, 404, r);
  }
  const det = await remoto('GET', `/sessao/${encodeURIComponent(nativaId)}`, { cookie: token });
  assert.equal(det.status, 200, det.texto);
  assert.equal(det.json.sessao.id, nativaId);
  assert.equal((await remoto('GET', `/sessao/${encodeURIComponent(nativaId)}/acoes`, { cookie: token })).status, 200);
  const inst = await remoto('GET', '/instancias', { cookie: token });
  assert.equal(inst.status, 200);
  assert.deepEqual(Object.keys(inst.json).sort(), ['dormindo', 'vivas']);

  // /fluxo: o início e os eventos só das nativas e de uso
  const f = sse('/fluxo', token);
  const { status, req } = await f.pronto;
  abertos.push(req);
  assert.equal(status, 200);
  await esperarQue(() => f.eventos.find((e) => e.tipo === 'inicio'), 4000, 'evento inicio');
  const ini = f.eventos.find((e) => e.tipo === 'inicio').dados;
  assert.deepEqual(Object.keys(ini).sort(), ['sessoes', 'uso']);
  assert.deepEqual(ini.sessoes.map((s) => s.id), [nativaId]);
  await ev('vscode-1', { hook_event_name: 'Stop' });
  await ev(nativaId, { prompt: 'pelo hook' });
  await local('POST', '/config', { som: { volume: 0.3 } });
  await local('POST', '/remoto/parear/recusar', {});
  await local('POST', '/uso', { cincoHoras: { pct: 12 } });
  await esperarQue(() => f.eventos.some((e) => e.tipo === 'sessao' && e.dados.id === nativaId), 4000, 'evento da nativa');
  await espera(600);
  const tipos = new Set(f.eventos.map((e) => e.tipo));
  for (const t of tipos) assert.ok(['inicio', 'sessao', 'acao', 'alerta', 'uso', 'remover'].includes(t), `evento ${t} não pode ir ao celular`);
  for (const e of f.eventos) {
    const id = e.tipo === 'sessao' ? e.dados.id : e.tipo === 'acao' ? e.dados.sessao : e.tipo === 'alerta' ? e.dados.sessao?.id : null;
    if (id) assert.equal(id, nativaId, `${e.tipo} de ${id}`);
  }
  assert.ok(!JSON.stringify(f.eventos).includes('vscode-1'));
  req.destroy();
});

test('/modo: bypassPermissions (e qualquer modo fora da lista) é recusado', async () => {
  const rota = `/sessao/${encodeURIComponent(nativaId)}/modo`;
  for (const modo of ['bypassPermissions', 'dontAsk', '', undefined]) {
    const r = await remoto('POST', rota, { cookie: token, corpo: { modo } });
    assert.equal(r.status, 403, String(modo));
    assert.deepEqual(r.json, { erro: 'modo_nao_permitido' });
  }
  const ok = await remoto('POST', rota, { cookie: token, corpo: { modo: 'plan' } });
  assert.notEqual(ok.status, 403, ok.texto);
  // o log tem a ação, o aparelho e a sessão, sem o conteúdo das mensagens
  const lg = fs.readFileSync(path.join(DADOS, 'logs', 'servidor.log'), 'utf8');
  assert.ok(lg.includes(`remoto iPhone de teste [${aparelho.id}] modo sessão ${nativaId}`), 'log da ação remota');
  assert.ok(lg.includes(`remoto iPhone de teste [${aparelho.id}] nova instância em ${PROJ}`));
});

test('push: assinatura só de serviço de push conhecido; cancelar apaga', async () => {
  const chave = Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)]).toString('base64url');
  const auth = crypto.randomBytes(16).toString('base64url');
  // P2-4: hosts exatos (nada de googleapis.com inteiro), sem porta e sem usuário/senha
  for (const endpoint of ['http://web.push.apple.com/x', 'https://127.0.0.1/x', 'https://evil.example/x', 'nada', 'https://storage.googleapis.com/x', 'https://web.push.apple.com:8443/x', 'https://u:p@web.push.apple.com/x', 'https://web.push.apple.com.evil.com/x', 'https://evil.notify.windows.com.evil.com/x', 'https://notify.windows.com/x']) {
    const r = await remoto('POST', '/remoto/push/assinar', { cookie: token, corpo: { assinatura: { endpoint, keys: { p256dh: chave, auth } } } });
    assert.equal(r.status, 400, endpoint);
  }
  // o WNS tem subdomínio por região: esse passa
  const wns = await remoto('POST', '/remoto/push/assinar', { cookie: token, corpo: { assinatura: { endpoint: 'https://db5.notify.windows.com/w/?token=abc', keys: { p256dh: chave, auth } } } });
  assert.equal(wns.status, 200, wns.texto);
  const ok = await remoto('POST', '/remoto/push/assinar', { cookie: token, corpo: { assinatura: { endpoint: 'https://web.push.apple.com/QGx-teste', keys: { p256dh: chave, auth } } } });
  assert.equal(ok.status, 200, ok.texto);
  assert.equal((await local('GET', '/remoto/estado')).json.aparelhos[0].push, true);
  assert.equal((await remoto('POST', '/remoto/push/cancelar', { cookie: token })).status, 200);
  assert.equal((await local('GET', '/remoto/estado')).json.aparelhos[0].push, false);
  assert.equal((await remoto('POST', '/remoto/push/teste', { cookie: token })).status, 409); // sem assinatura: nada sai
});

// O procStart como o Claude Code grava: Windows, FILETIME; Mac, o `ps -o lstart=` com LC_ALL=C e TZ=UTC.
function inicioDoProcesso(pid) {
  if (!WIN) return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).trim();
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`], { encoding: 'utf8', windowsHide: true }).trim();
}
// tool_result mais recente do transcript da sessão (texto já sem o escape do JSON).
function ultimoResultado(id) {
  const arq = fs.readdirSync(PROJETOS).map((d) => path.join(PROJETOS, d, `${id}.jsonl`)).find((c) => fs.existsSync(c));
  if (!arq) return '';
  const rs = fs.readFileSync(arq, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : [])).filter((b) => b.type === 'tool_result');
  return JSON.stringify(rs.pop() ?? '').replaceAll('\\"', '"');
}

test('P2-5: "Permitir sempre" no celular vale só na sessão; P1-1: nativa devolvida/aberta fora do Orbit some do celular', async () => {
  const cr = await remoto('POST', '/instancias', { cookie: token, corpo: { pasta: PROJ, cwd: PROJ, permissao: 'default', nome: 'permissão' } });
  assert.equal(cr.status, 202, cr.texto);
  const id = cr.json.sessao;
  const rota = (fim = '') => `/sessao/${encodeURIComponent(id)}${fim}`;
  const controleRemoto = async () => (await remoto('GET', rota(), { cookie: token })).json?.sessao?.controle;
  const controleLocal = async () => (await local('GET', rota())).json?.sessao?.controle;
  const livre = () => esperarQue(async () => { const c = await controleRemoto(); return c && !c.ocupada && !c.permissao ? c : null; }, 8000, 'sessão livre');
  // 1ª mensagem (409 enquanto a instância inicia)
  await esperarQue(async () => (await remoto('POST', rota('/mensagem'), { cookie: token, corpo: { texto: 'PERMISSAO GLOBAL' } })).status < 300, 8000, 'mensagem aceita');

  // pelo celular: a sugestão "para todos os projetos" é rebaixada para a sessão
  const pend = await esperarQue(async () => (await controleRemoto())?.permissao, 6000, 'pedido de permissão');
  assert.equal(pend.tipo, 'ferramenta');
  assert.ok(pend.sugestoes.some((s) => s.indice === 0));
  const ok = await remoto('POST', rota('/permissao'), { cookie: token, corpo: { id: pend.id, decisao: 'permitir', sugestao: 0 } });
  assert.equal(ok.status, 200, ok.texto);
  await livre();
  const viaCelular = await esperarQue(() => { const t = ultimoResultado(id); return t.includes('updatedPermissions') ? t : ''; }, 4000, 'tool_result do celular');
  assert.ok(viaCelular.includes('"destination":"session"'), viaCelular);
  assert.ok(!viaCelular.includes('userSettings'), `a regra global não pode ser gravada: ${viaCelular}`);

  // contraste: pelo PC (47821 de teste) a mesma sugestão segue global, então o teste acima prova a correção
  assert.ok((await local('POST', rota('/mensagem'), { texto: 'PERMISSAO GLOBAL de novo' })).status < 300);
  const pend2 = await esperarQue(async () => { const c = await controleLocal(); return c?.permissao && c.permissao.id !== pend.id ? c.permissao : null; }, 6000, 'segundo pedido');
  assert.equal((await local('POST', rota('/permissao'), { id: pend2.id, decisao: 'permitir', sugestao: 0 })).status, 200);
  await livre();
  const viaPc = await esperarQue(() => { const t = ultimoResultado(id); return t !== viaCelular && t.includes('updatedPermissions') ? t : ''; }, 4000, 'tool_result do PC');
  assert.ok(viaPc.includes('"destination":"userSettings"'), viaPc);

  // P1-1: devolvida (a nativa dorme), ainda é do Orbit; aberta por outro processo, o Orbit larga o controle
  const dev = await local('POST', rota('/devolver'), {});
  assert.equal(dev.status, 202, dev.texto);
  await esperarQue(async () => (await local('GET', rota('/acoes'))).json?.find((a) => a.id === dev.json.acao.id)?.estado === 'sucesso', 8000, 'devolver concluído');
  assert.equal((await remoto('GET', rota(), { cookie: token })).status, 200, 'dormindo no Orbit segue nativa');
  const filho = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore', windowsHide: true });
  const arqReg = path.join(SESSOES, `${filho.pid}.json`);
  try {
    fs.writeFileSync(arqReg, JSON.stringify({ pid: filho.pid, sessionId: id, cwd: PROJ, startedAt: Date.now(), procStart: inicioDoProcesso(filho.pid), kind: 'interactive', entrypoint: 'claude-vscode', status: 'idle', messagingSocketPath: '', updatedAt: Date.now(), statusUpdatedAt: Date.now() }));
    await esperarQue(async () => (await remoto('GET', rota(), { cookie: token })).status === 404, 8000, 'celular perde a sessão aberta fora do Orbit');
    for (const fim of ['/conversa', '/acoes', '/comandos']) assert.equal((await remoto('GET', rota(fim), { cookie: token })).status, 404, fim);
    for (const fim of ['/mensagem', '/permissao', '/parar', '/encerrar']) assert.equal((await remoto('POST', rota(fim), { cookie: token, corpo: { texto: 'x', id: 'x', decisao: 'negar' } })).status, fim === '/encerrar' ? 403 : 404, fim);
    const est = (await remoto('GET', '/estado', { cookie: token })).json;
    assert.ok(!est.sessoes.some((s) => s.id === id), '/estado do celular sem a sessão');
    assert.ok(est.sessoes.some((s) => s.id === nativaId), 'a outra nativa continua');
  } finally {
    try { filho.kill(); } catch {}
    try { fs.rmSync(arqReg, { force: true }); } catch {}
  }
});

test('revogar derruba na hora o SSE do aparelho (fluxo e conversa) e o cookie deixa de valer', async () => {
  const outro = await parear('iPad');
  const f = sse('/fluxo', token);
  const c = sse(`/sessao/${encodeURIComponent(nativaId)}/conversa/fluxo`, token);
  const g = sse('/fluxo', outro.token);
  for (const x of [f, c, g]) { const { status, req } = await x.pronto; abertos.push(req); assert.equal(status, 200); }
  await espera(200);
  const r = await local('POST', '/remoto/revogar', { id: aparelho.id });
  assert.equal(r.status, 200, r.texto);
  const t0 = Date.now();
  const fins = await Promise.race([Promise.all([f.fechou, c.fechou]), espera(3000).then(() => 'não fechou')]);
  assert.notEqual(fins, 'não fechou');
  assert.ok(Date.now() - t0 < 2000);
  assert.equal((await remoto('GET', '/estado', { cookie: token })).status, 401);
  // o outro aparelho segue conectado
  const ainda = await Promise.race([g.fechou.then(() => 'fechou'), espera(300).then(() => 'aberto')]);
  assert.equal(ainda, 'aberto');
  assert.equal((await remoto('GET', '/estado', { cookie: outro.token })).status, 200);
  // sair: o próprio aparelho se revoga e o cookie é apagado
  const s = await remoto('POST', '/remoto/sair', { cookie: outro.token });
  assert.equal(s.status, 200);
  assert.match(String(s.headers['set-cookie']), /^__Host-orbit=; .*Max-Age=0/);
  assert.equal(await Promise.race([g.fechou.then(() => 'fechou'), espera(2000).then(() => 'aberto')]), 'fechou');
  assert.equal((await remoto('GET', '/estado', { cookie: outro.token })).status, 401);
  assert.deepEqual((await local('GET', '/remoto/estado')).json.aparelhos, []);
});

test('desligar fecha a porta remota sem reiniciar o servidor', async () => {
  const p = await parear('último');
  const f = sse('/fluxo', p.token);
  const { req } = await f.pronto;
  abertos.push(req);
  const r = await local('POST', '/remoto/config', { ativo: false });
  assert.equal(r.status, 200);
  assert.equal(r.json.ativo, false);
  assert.equal(await Promise.race([f.fechou.then(() => 'fechou'), espera(2000).then(() => 'aberto')]), 'fechou');
  await esperarQue(() => portaLivre(PORTA_R), 3000, 'porta remota fechada');
  await assert.rejects(remoto('GET', '/m'), /ECONNREFUSED/);
  assert.equal((await local('GET', '/saude')).json.pid, proc.pid);
  // o aparelho continua pareado (desligar não revoga) e volta a valer ao ligar de novo
  await local('POST', '/remoto/config', { ativo: true });
  assert.equal((await remoto('GET', '/remoto/eu', { cookie: p.token })).status, 200);
  await local('POST', '/remoto/config', { ativo: false });
  await esperarQue(() => portaLivre(PORTA_R), 3000, 'porta remota fechada');
});
