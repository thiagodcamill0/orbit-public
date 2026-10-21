// Gatilhos do push do celular (servidor.mjs → alertar → remoto.notificar → push.mjs) com instâncias nativas de verdade
// (claude-falso).
// Rodar:  node --test testes/remoto-push.test.mjs
// Sobe um servidor próprio (porta local, porta remota e o servidor de push falso saem de 47822–47826, conferidas livres;
// nunca a 47821). O "serviço de push" é um http.createServer local: o servidor de teste aceita endpoint http://127.0.0.1
// só com ORBIT_PUSH_HTTP_TESTE=1 e dados fora da pasta do Orbit (produção nunca aceita). O teste decifra o corpo como o
// navegador faria (RFC 8291) e confere o payload. No fim, desliga só o que subiu e apaga a pasta temporária.

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
const livres = [];
for (const p of FAIXA) if (p !== PORTA && livres.length < 2 && (await portaLivre(p))) livres.push(p);
if (livres.length < 2) throw new Error('sem 2 portas livres em 47822–47826 (porta remota e push falso)');
const [PORTA_R, PORTA_PUSH] = livres;

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-remoto-push-'));
const SESSOES = path.join(DADOS, 'sessoes');
const PROJETOS = path.join(DADOS, 'projetos');
const PROJ = path.join(DADOS, 'cwd', 'proj');
for (const d of [SESSOES, PROJETOS, PROJ]) fs.mkdirSync(d, { recursive: true });
const HOST = 'orbit-teste.exemplo.ts.net';
const ORIGEM = `https://${HOST}`;
const TS = path.join(DADOS, 'tailscale-falso.json');
fs.writeFileSync(TS, JSON.stringify({ status: { BackendState: 'Running', Self: { DNSName: HOST + '.', UserID: 7 }, User: { 7: { LoginName: 'usuario@exemplo.com' } } }, serve: {} }));
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
  ORBIT_PUSH_HTTP_TESTE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'teste',
};
delete ENV.CLAUDE_CODE_HOST_SESSION_ID;
delete ENV.CLAUDECODE;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
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

function pedirEm(porta, metodo, rota, { headers = {}, corpo } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
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
const local = (metodo, rota, corpo) => pedirEm(PORTA, metodo, rota, { headers: { 'x-gerenciador': '1', ...(corpo !== undefined ? { 'content-type': 'application/json' } : {}) }, corpo });
function remoto(metodo, rota, { cookie, corpo } = {}) {
  // como o tailscale serve: Host e o login do dono (obrigatório com dono definido)
  const h = { host: HOST, 'tailscale-user-login': 'usuario@exemplo.com', ...(cookie ? { cookie: `__Host-orbit=${cookie}` } : {}) };
  if (metodo === 'POST') Object.assign(h, { origin: ORIGEM, 'content-type': 'application/json' });
  return pedirEm(PORTA_R, metodo, rota, { headers: h, corpo: metodo === 'POST' ? (corpo ?? {}) : undefined });
}

// ───────── o "assinante" (navegador do iPhone) e o serviço de push falso ─────────
const b64u = (b) => Buffer.from(b).toString('base64url');
const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();
const ASSINANTE = { privada: ecdh.getPrivateKey(), publica: ecdh.getPublicKey(), auth: crypto.randomBytes(16) };
const ASSINATURA = { endpoint: `http://127.0.0.1:${PORTA_PUSH}/push/aparelho-1`, keys: { p256dh: b64u(ASSINANTE.publica), auth: b64u(ASSINANTE.auth) } };

// Decifra o corpo aes128gcm como o navegador faria (RFC 8291 §3.4).
function decifrar(corpo) {
  const salt = corpo.subarray(0, 16);
  const idlen = corpo[20];
  const asPublica = corpo.subarray(21, 21 + idlen);
  const texto = corpo.subarray(21 + idlen);
  const e = crypto.createECDH('prime256v1');
  e.setPrivateKey(ASSINANTE.privada);
  const segredo = e.computeSecret(asPublica);
  const info = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), ASSINANTE.publica, asPublica]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', segredo, ASSINANTE.auth, info, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(texto.subarray(texto.length - 16));
  const claro = Buffer.concat([d.update(texto.subarray(0, texto.length - 16)), d.final()]);
  return claro.subarray(0, claro.length - 1).toString('utf8');
}

const recebidos = []; // { caminho, headers, bruto (texto decifrado), payload }
const servicoPush = http.createServer((req, res) => {
  const partes = [];
  req.on('data', (c) => partes.push(c));
  req.on('end', () => {
    let bruto = '';
    let payload = null;
    try { bruto = decifrar(Buffer.concat(partes)); payload = JSON.parse(bruto); } catch {}
    recebidos.push({ caminho: req.url, headers: req.headers, bruto, payload });
    res.writeHead(201);
    res.end();
  });
});
await new Promise((ok) => servicoPush.listen(PORTA_PUSH, '127.0.0.1', ok));

let proc = null;
const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
after(async () => {
  servicoPush.close();
  servicoPush.closeAllConnections?.();
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

// ───────── ajudantes do cenário ─────────
let token;
let nativaId;
const rs = (resto = '') => `/sessao/${encodeURIComponent(nativaId)}${resto}`;
const controleDe = async () => (await local('GET', rs())).json?.sessao?.controle;
const statusDe = async (id = nativaId) => (await local('GET', `/sessao/${encodeURIComponent(id)}`)).json?.sessao?.status;
const evento = (id, extra = {}) => local('POST', '/evento', { session_id: id, hook_event_name: 'UserPromptSubmit', cwd: PROJ, prompt: 'oi', ts: Date.now(), ...extra });
const titulos = () => recebidos.map((r) => r.payload?.titulo);
async function mensagem(texto) {
  let r;
  await esperarQue(async () => { r = await local('POST', rs('/mensagem'), { texto }); return r.status === 202 || r.status === 200; }, 10000, `mensagem "${texto}" aceita`);
  return r;
}
async function pedidoPendente(idAntigo) {
  return esperarQue(async () => { const c = await controleDe(); return c?.permissao && c.permissao.id !== idAntigo ? c.permissao : null; }, 6000, 'pedido pendente no controle');
}
const livre = () => esperarQue(async () => { const c = await controleDe(); return c && !c.ocupada && !c.permissao; }, 6000, 'instância livre');
async function esperarPushes(n, ms = 5000) {
  await esperarQue(() => recebidos.length >= n, ms, `${n} push(es) recebido(s) (tem ${recebidos.length}: ${JSON.stringify(titulos())})`);
}
// Nenhum push novo nos próximos `ms` (o envio é assíncrono: espera para provar a ausência).
async function semPushNovo(antes, ms = 900) {
  await espera(ms);
  assert.equal(recebidos.length, antes, `push inesperado: ${JSON.stringify(titulos().slice(antes))}`);
}

test('sobe o servidor, liga o acesso, pareia e assina o push (só endpoints permitidos)', async () => {
  proc = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => process.stderr.write('[servidor] ' + d));
  await esperarQue(async () => (await local('GET', '/saude').catch(() => ({}))).json?.pid === proc.pid, 10000, 'servidor no ar');
  const l = await local('POST', '/remoto/config', { ativo: true, criarInstancias: true });
  assert.equal(l.status, 200, l.texto);
  const p = await remoto('POST', '/remoto/parear/pedir', { corpo: { nome: 'iPhone teste' } });
  const codigo = (await local('GET', '/remoto/estado')).json.pedido.codigo;
  const c = await remoto('POST', '/remoto/parear/confirmar', { corpo: { pedido: p.json.pedido, codigo } });
  assert.equal(c.status, 200, c.texto);
  token = /__Host-orbit=([^;]+)/.exec(String(c.headers['set-cookie']))[1];
  // endpoints que não são de um serviço de push conhecido (ou http fora do 127.0.0.1) continuam recusados
  for (const endpoint of ['https://exemplo.com/push/x', `http://localhost:${PORTA_PUSH}/x`, 'http://127.0.0.2/x', 'http://exemplo.com/x', 'ftp://127.0.0.1/x']) {
    const r = await remoto('POST', '/remoto/push/assinar', { cookie: token, corpo: { assinatura: { ...ASSINATURA, endpoint } } });
    assert.equal(r.status, 400, endpoint);
  }
  const ok = await remoto('POST', '/remoto/push/assinar', { cookie: token, corpo: { assinatura: ASSINATURA } });
  assert.equal(ok.status, 200, ok.texto);
  assert.equal((await local('GET', '/remoto/estado')).json.aparelhos[0].push, true);
  assert.equal(recebidos.length, 0);
});

test('o http://127.0.0.1 do push só existe no servidor de teste (produção recusa)', () => {
  const srv = fs.readFileSync(path.join(RAIZ, 'servidor.mjs'), 'utf8');
  assert.match(srv, /permitirHttp: DADOS !== PASTA && process\.env\.ORBIT_PUSH_HTTP_TESTE === '1'/);
  const rem = fs.readFileSync(path.join(RAIZ, 'remoto.mjs'), 'utf8');
  assert.match(rem, /permitirHttp = false/);
});

test('cria a instância nativa pelo celular', async () => {
  const cr = await remoto('POST', '/instancias', { cookie: token, corpo: { pasta: PROJ, cwd: PROJ, permissao: 'default', nome: 'do celular' } });
  assert.equal(cr.status, 202, cr.texto);
  nativaId = cr.json.sessao;
  await esperarQue(async () => (await local('GET', rs())).status === 200, 5000, 'sessão nativa');
  assert.equal(recebidos.length, 0);
});

test('permissão pedida pelo stream → "precisa de você", um aviso só, sem texto do agente', async () => {
  await mensagem('PERMISSAO permitir');
  const pend = await pedidoPendente();
  assert.equal(pend.tipo, 'ferramenta');
  await esperarPushes(1);
  const r = recebidos[0];
  assert.equal(r.caminho, '/push/aparelho-1');
  assert.match(String(r.headers.authorization), /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.deepEqual(Object.keys(r.payload).sort(), ['corpo', 'tag', 'titulo', 'url']);
  assert.equal(r.payload.titulo, 'Orbit · proj · precisa de você');
  assert.equal(r.payload.corpo, '');
  assert.equal(r.payload.url, `/m#s=${encodeURIComponent(nativaId)}`);
  assert.equal(r.payload.tag, `s-${nativaId}`);
  assert.equal(await statusDe(), 'aguardando', 'a sessão entra em aguardando');
  // os hooks que o claude interativo mandaria para o mesmo pedido não repetem o aviso
  await evento(nativaId, { hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: 'a.txt' } });
  await evento(nativaId, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Write' });
  await semPushNovo(1);
  // responder devolve a sessão ao trabalho (e a volta termina)
  assert.equal((await local('POST', rs('/permissao'), { id: pend.id, decisao: 'permitir' })).status, 200);
  await esperarQue(async () => (await statusDe()) !== 'aguardando', 4000, 'saiu de aguardando');
  await livre();
  await semPushNovo(1, 300);
});

test('fim da volta (Stop) → "terminou"; o texto do agente nunca vai no push', async () => {
  await evento(nativaId, { hook_event_name: 'Stop', last_assistant_message: 'SEGREDO-DO-AGENTE: a senha é 1234' });
  await esperarPushes(2);
  const r = recebidos[1];
  assert.equal(r.payload.titulo, 'Orbit · proj · terminou');
  assert.equal(r.payload.corpo, '');
  assert.equal(r.payload.tag, `s-${nativaId}`);
  for (const x of recebidos) assert.ok(!x.bruto.includes('SEGREDO') && !x.bruto.includes('1234'), 'nada do agente no push');
  await semPushNovo(2, 500);
});

test('pergunta e plano pedidos pelo stream também avisam, uma vez cada', async () => {
  for (const [palavra, tipo] of [['PERGUNTA um', 'pergunta'], ['PLANO um', 'plano']]) {
    const antes = recebidos.length;
    await mensagem(palavra);
    const pend = await pedidoPendente();
    assert.equal(pend.tipo, tipo);
    await esperarPushes(antes + 1);
    assert.equal(recebidos[antes].payload.titulo, 'Orbit · proj · precisa de você', tipo);
    assert.equal(await statusDe(), 'aguardando', tipo);
    await semPushNovo(antes + 1, 500);
    assert.equal((await local('POST', rs('/permissao'), { id: pend.id, decisao: 'negar' })).status, 200);
    await livre();
  }
});

test('hook do AskUserQuestion antes do pedido do stream: um aviso só (ordem real dos eventos)', async () => {
  await evento(nativaId, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'tu-x' }); // volta a trabalhando
  await esperarQue(async () => (await statusDe()) === 'trabalhando', 3000, 'trabalhando');
  const antes = recebidos.length;
  await evento(nativaId, { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'tu-1', tool_input: { questions: [{ question: 'Qual cor?' }] } });
  await esperarPushes(antes + 1);
  assert.equal(recebidos[antes].payload.titulo, 'Orbit · proj · precisa de você');
  await mensagem('PERGUNTA dois'); // o stream pede a mesma pergunta logo depois do hook
  const pend = await pedidoPendente();
  assert.equal(pend.tipo, 'pergunta');
  await semPushNovo(antes + 1, 800);
  await local('POST', rs('/permissao'), { id: pend.id, decisao: 'negar' });
  await livre();
});

test('config.remoto.notificar liga e desliga cada tipo', async () => {
  assert.equal((await local('POST', '/remoto/config', { notificar: { precisa: false, terminou: true } })).status, 200);
  let antes = recebidos.length;
  await mensagem('PERMISSAO negar');
  let pend = await pedidoPendente();
  await semPushNovo(antes, 700);
  await local('POST', rs('/permissao'), { id: pend.id, decisao: 'negar' });
  await livre();
  await evento(nativaId, { hook_event_name: 'Stop' });
  await esperarPushes(antes + 1);
  assert.equal(recebidos[antes].payload.titulo, 'Orbit · proj · terminou', '"terminou" segue ligado');

  assert.equal((await local('POST', '/remoto/config', { notificar: { precisa: true, terminou: false } })).status, 200);
  antes = recebidos.length;
  await evento(nativaId, { hook_event_name: 'Stop' });
  await semPushNovo(antes, 700);
  await mensagem('PERMISSAO negar');
  pend = await pedidoPendente(pend.id);
  await esperarPushes(antes + 1);
  assert.equal(recebidos[antes].payload.titulo, 'Orbit · proj · precisa de você', '"precisa" segue ligado');
  await local('POST', rs('/permissao'), { id: pend.id, decisao: 'negar' });
  await livre();
  assert.equal((await local('POST', '/remoto/config', { notificar: { precisa: true, terminou: true } })).status, 200);
});

test('Não perturbe segura o push e, ao desligar, ele volta', async () => {
  assert.equal((await local('POST', '/config', { naoPerturbe: { ativo: true } })).status, 200);
  let antes = recebidos.length;
  await mensagem('PERMISSAO negar');
  const pend = await pedidoPendente();
  await evento(nativaId, { hook_event_name: 'Stop' });
  await semPushNovo(antes, 900);
  await local('POST', rs('/permissao'), { id: pend.id, decisao: 'negar' });
  await livre();
  assert.equal((await local('POST', '/config', { naoPerturbe: { ativo: false } })).status, 200);
  antes = recebidos.length;
  await evento(nativaId, { hook_event_name: 'Stop' });
  await esperarPushes(antes + 1);
  assert.equal(recebidos[antes].payload.titulo, 'Orbit · proj · terminou', 'desligado o Não perturbe, o aviso volta');
});

test('sessão que não é nativa (VS Code) nunca gera push', async () => {
  const antes = recebidos.length;
  await evento('vscode-1');
  await evento('vscode-1', { hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: 'a.txt' } });
  await evento('vscode-1', { hook_event_name: 'Stop' });
  await evento('vscode-1', { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_use_id: 'tu-p', tool_input: {} });
  await semPushNovo(antes, 900);
});

test('o título usa o nome editável do projeto (rótulo), senão o da pasta', async () => {
  const r = await local('POST', '/config', { projetos: { proj: { rotulo: 'Meu Painel' } } });
  assert.equal(r.status, 200, r.texto);
  assert.equal((await local('GET', '/config')).json.projetos.proj.rotulo, 'Meu Painel');
  const antes = recebidos.length;
  await evento(nativaId, { hook_event_name: 'Stop' });
  await esperarPushes(antes + 1);
  assert.equal(recebidos[antes].payload.titulo, 'Orbit · Meu Painel · terminou');
  await mensagem('PERMISSAO negar');
  const pend = await pedidoPendente();
  await esperarPushes(antes + 2);
  assert.equal(recebidos[antes + 1].payload.titulo, 'Orbit · Meu Painel · precisa de você');
  await local('POST', rs('/permissao'), { id: pend.id, decisao: 'negar' });
  await livre();
});

test('com o acesso pelo celular desligado nada é enviado', async () => {
  // desligado: nada sai
  assert.equal((await local('POST', '/remoto/config', { ativo: false })).status, 200);
  let antes = recebidos.length;
  await evento(nativaId, { hook_event_name: 'Stop' });
  await semPushNovo(antes, 700);
});
