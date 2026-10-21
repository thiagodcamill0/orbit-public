// Teste do perfil + GitHub (perfil.mjs, assets/perfil.js): servidor de teste e GitHub falso em portas livres de
// 47822–47826 (preferidas 47823 e 47824), Edge headless mudo. Nunca toca a 47821, o GitHub de verdade nem o token
// guardado do usuário (ORBIT_PERFIL_DIR e GERENCIADOR_DADOS vão para a pasta de saída).
// Antes do servidor, o Mac simulado: o perfil.mjs no próprio processo com so:'darwin' e um `security` falso
// (o Chaveiro de verdade nunca é chamado).
// No Mac de verdade, o servidor de teste guarda o token num Chaveiro falso (ORBIT_SECURITY = um security falso
// escrito na pasta de saída, que guarda os itens num JSON e anota cada chamada); nunca no Chaveiro do usuário.
// node testes/perfil.test.mjs <pasta-de-saida>   (~1 min; capturas 01–11 na pasta de saída)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { fecharEdge } from './edge.mjs';
import { escolherPorta } from './porta-livre.mjs';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAIDA = path.resolve(process.argv[2] || path.join(process.env.TEMP || '.', 'orbit-perfil-teste'));
fs.mkdirSync(SAIDA, { recursive: true });
const PORTA_GH = await escolherPorta(47824);
const DADOS = path.join(SAIDA, 'dados'), PERFIL = path.join(SAIDA, 'perfil'), SESS = path.join(SAIDA, 'sessoes');
// Só as subpastas que o teste cria (nunca a pasta de saída inteira).
for (const d of [DADOS, PERFIL, SESS, path.join(SAIDA, 'edge'), path.join(SAIDA, 'casa'), path.join(SAIDA, 'auth.json')]) fs.rmSync(d, { recursive: true, force: true });
for (const d of [DADOS, PERFIL, SESS]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(DADOS, 'config.json'), '{}\n'); // config padrão de teste (nunca a do usuário)
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const VALIDO = 'github_pat_' + 'A1b2C3d4E5f6G7h8I9j0K1_' + 'x'.repeat(59);
const REVOGADO = 'ghp_' + 'R'.repeat(36);
const res = { ok: [], falhas: [] };
const MAC = process.platform === 'darwin';
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };

// GitHub falso
let validoVale = true;
const avatarPng = fs.readFileSync(path.join(PROJ, 'assets', 'robot-done-app.png'));
const gh = http.createServer((req, r) => {
  if (req.url.startsWith('/avatar.png')) { r.writeHead(200, { 'content-type': 'image/png' }); return r.end(avatarPng); }
  if (req.url === '/user') {
    const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (tok === VALIDO && validoVale) {
      r.writeHead(200, { 'content-type': 'application/json' });
      return r.end(JSON.stringify({ login: 'orbit-teste', id: 42, name: 'Orbit Teste da Silva', avatar_url: `http://127.0.0.1:${PORTA_GH}/avatar.png?v=4` }));
    }
    r.writeHead(401, { 'content-type': 'application/json' });
    return r.end('{"message":"Bad credentials"}');
  }
  r.writeHead(404); r.end();
});
await new Promise((ok) => gh.listen(PORTA_GH, '127.0.0.1', ok));
const PORTA = await escolherPorta(47823); // depois do GitHub falso já escutando: nunca a mesma
const BASE = `http://127.0.0.1:${PORTA}`;

// ── Mac simulado: token no Chaveiro (security falso), nunca na linha de comando nem no disco ──
async function testeMac() {
  const PERFIL_MAC = path.join(SAIDA, 'perfil-mac');
  fs.rmSync(PERFIL_MAC, { recursive: true, force: true });
  fs.mkdirSync(PERFIL_MAC, { recursive: true });
  const antes = { dir: process.env.ORBIT_PERFIL_DIR, api: process.env.ORBIT_GITHUB_API };
  process.env.ORBIT_PERFIL_DIR = PERFIL_MAC;
  process.env.ORBIT_GITHUB_API = `http://127.0.0.1:${PORTA_GH}`;
  const { criarPerfil, aspasSecurity, rodarSecurity } = await import('../perfil.mjs');
  for (const [k, v] of [['ORBIT_PERFIL_DIR', antes.dir], ['ORBIT_GITHUB_API', antes.api]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }

  // Chaveiro falso. A linha do `security -i` é lida como o security lê: separa por espaço; entre aspas duplas, \" e \\.
  const chaves = new Map();
  const chamadas = [];
  let recusar = false;
  const separar = (linha) => {
    const out = [];
    let i = 0;
    while (i < linha.length) {
      while (linha[i] === ' ') i++;
      if (i >= linha.length) break;
      let a = '';
      if (linha[i] === '"') {
        i++;
        while (i < linha.length && linha[i] !== '"') { if (linha[i] === '\\') i++; a += linha[i++]; }
        i++;
      } else while (i < linha.length && linha[i] !== ' ') a += linha[i++];
      out.push(a);
    }
    return out;
  };
  const security = async (args, entrada = '') => {
    chamadas.push({ args: [...args], entrada });
    let a = args;
    if (args[0] === '-i') {
      const linhas = entrada.split('\n').filter(Boolean);
      if (linhas.length !== 1) return { codigo: 1, saida: '', erro: 'mais de uma linha' };
      a = separar(linhas[0]);
    }
    const opc = (f) => a[a.indexOf(f) + 1];
    const chave = `${opc('-a')}|${opc('-s')}`;
    if (a[0] === 'add-generic-password') {
      if (recusar) return { codigo: 0, saida: '', erro: 'security: SecKeychainItemCreateFromContent: User interaction is not allowed.\n' };
      chaves.set(chave, opc('-w'));
      return { codigo: 0, saida: '', erro: '' };
    }
    if (a[0] === 'find-generic-password') return chaves.has(chave) ? { codigo: 0, saida: chaves.get(chave) + '\n', erro: '' } : { codigo: 44, saida: '', erro: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n' };
    if (a[0] === 'delete-generic-password') return { codigo: chaves.delete(chave) ? 0 : 44, saida: '', erro: '' };
    return { codigo: 2, saida: '', erro: 'comando desconhecido' };
  };
  const CONTA = 'thi "a\\go'; // espaço, aspas e barra: o escape do -i tem de devolver o mesmo nome
  const CHAVE = `${CONTA}|Orbit GitHub`;
  const novo = () => criarPerfil({ lerJSONCorpo: async (req) => req.corpo, so: 'darwin', security, conta: CONTA });
  const chamar = async (p, method, rota, corpo) => {
    const r = { headersSent: false, status: 0, corpo: null };
    r.writeHead = (c) => { r.status = c; r.headersSent = true; };
    r.end = (t) => { r.corpo = typeof t === 'string' ? JSON.parse(t) : t; };
    try { await p.rota({ method, corpo }, r, rota); } catch (e) { return { status: e.status || 500, corpo: { erro: e.message } }; }
    return r;
  };

  let p = novo();
  let r = await chamar(p, 'GET', '/perfil');
  conferir(r.status === 200 && r.corpo.seguro === true && r.corpo.github === null, 'Mac: GET /perfil → seguro:true, sem conta', r.corpo);
  r = await chamar(p, 'POST', '/perfil/github', { token: VALIDO });
  conferir(r.status === 200 && r.corpo.github?.login === 'orbit-teste', 'Mac: conectar → 200', r);
  conferir(chaves.get(CHAVE) === VALIDO && chaves.size === 1, 'Mac: token no Chaveiro (serviço "Orbit GitHub", conta com aspas/espaço/barra)', [...chaves.keys()]);
  conferir(chamadas.every((c) => !c.args.join(' ').includes(VALIDO)), 'Mac: token nunca na linha de comando do security', chamadas.map((c) => c.args));
  conferir(chamadas.some((c) => c.args[0] === '-i' && c.entrada.includes(VALIDO) && c.entrada.startsWith('add-generic-password -U ')), 'Mac: token só no stdin do security -i');
  const arquivos = fs.readdirSync(PERFIL_MAC);
  conferir(!arquivos.includes('github.token') && arquivos.every((a) => !fs.readFileSync(path.join(PERFIL_MAC, a)).toString('latin1').includes(VALIDO)), 'Mac: nada do token no disco', arquivos);
  conferir((await p.token()) === VALIDO, 'Mac: token() lê do Chaveiro');
  r = await chamar(p, 'POST', '/perfil/github/verificar', { forcar: true });
  conferir(r.corpo?.github?.expirado === false, 'Mac: verificar → válido', r.corpo);
  // "Reinício": outra instância lê o github.json; sem o item no Chaveiro, a conta vira expirada.
  p = novo();
  r = await chamar(p, 'GET', '/perfil');
  conferir(r.corpo.github?.login === 'orbit-teste', 'Mac: continua conectado depois de reiniciar', r.corpo);
  chaves.clear();
  r = await chamar(p, 'POST', '/perfil/github/verificar', { forcar: true });
  conferir(r.corpo?.github?.expirado === true && (await p.token()) === null, 'Mac: item apagado do Chaveiro → expirado', r.corpo);
  r = await chamar(p, 'POST', '/perfil/github', { token: VALIDO });
  conferir(r.status === 200 && chaves.get(CHAVE) === VALIDO, 'Mac: conectar de novo troca o item (-U)');
  r = await chamar(p, 'POST', '/perfil/github/desconectar', {});
  conferir(r.status === 200 && r.corpo.github === null && chaves.size === 0 && !fs.existsSync(path.join(PERFIL_MAC, 'github.json')), 'Mac: desconectar apaga o item e o github.json', { chaves: chaves.size });
  // Chaveiro recusa (o security sai 0, mas o item não aparece): erro claro e nada salvo.
  recusar = true;
  r = await chamar(p, 'POST', '/perfil/github', { token: VALIDO });
  conferir(r.status === 500 && /neste Mac \(Chaveiro\)\. Nada foi salvo/.test(r.corpo?.erro) && !fs.existsSync(path.join(PERFIL_MAC, 'github.json')), 'Mac: Chaveiro recusou → 500, nada salvo', r);
  recusar = false;
  // Reinício sem o item no Chaveiro (apagado por fora): como o Windows sem o github.token, a conta some
  // (o github.json fica no disco, como lá). Chaveiro com erro (não "não existe") mantém a conta.
  r = await chamar(p, 'POST', '/perfil/github', { token: VALIDO });
  conferir(r.status === 200, 'Mac: conectar de novo', r);
  chaves.clear();
  p = novo();
  r = await chamar(p, 'GET', '/perfil');
  conferir(r.corpo.github === null && (await p.token()) === null && fs.existsSync(path.join(PERFIL_MAC, 'github.json')), 'Mac: reinício sem o item no Chaveiro → desconectado (como o Windows sem o github.token)', r.corpo);
  const securityTrancado = async (args, entrada) => (args[0] === 'find-generic-password' ? { codigo: 51, saida: '', erro: 'security: User interaction is not allowed.' } : security(args, entrada));
  p = criarPerfil({ lerJSONCorpo: async (req) => req.corpo, so: 'darwin', security: securityTrancado, conta: CONTA });
  r = await chamar(p, 'GET', '/perfil');
  conferir(r.corpo.github?.login === 'orbit-teste', 'Mac: Chaveiro trancado no reinício → a conta fica (expira no verificar)', r.corpo);
  r = await chamar(p, 'POST', '/perfil/github/verificar', { forcar: true });
  conferir(r.corpo.github?.expirado === true, 'Mac: Chaveiro trancado → verificar marca expirado', r.corpo);
  await chamar(novo(), 'POST', '/perfil/github/desconectar', {});
  // Processo de teste (ORBIT_PERFIL_DIR) sem ORBIT_SECURITY: o security de verdade nunca roda.
  const g = await rodarSecurity(['find-generic-password', '-a', 'orbit-teste-inexistente', '-s', 'Orbit Teste Inexistente']);
  conferir(g.codigo === 1 && /desligado/.test(g.erro), 'Mac: em teste, sem ORBIT_SECURITY, o Chaveiro real nunca é chamado', g);
  let recusou = false;
  try { aspasSecurity('a\nb'); } catch { recusou = true; }
  conferir(recusou && aspasSecurity('a"b\\c') === '"a\\"b\\\\c"', 'Mac: escape do security -i (aspas, barra, sem quebra de linha)');
  fs.rmSync(PERFIL_MAC, { recursive: true, force: true });
}

// ── Chaveiro falso do servidor (só no Mac): `node security-falso.mjs <args>`, como o /usr/bin/security ──
const CHAVEIRO = path.join(SAIDA, 'chaveiro-falso.json');
const SECURITY_FALSO = path.join(SAIDA, 'security-falso.mjs');
const CONTA_MAC = (() => { try { return os.userInfo().username; } catch { return 'orbit'; } })();
const chaveiro = () => { try { return JSON.parse(fs.readFileSync(CHAVEIRO, 'utf8')); } catch { return {}; } };
const chamadasChaveiro = () => { try { return fs.readFileSync(CHAVEIRO + '.log', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
if (MAC) {
  for (const f of [CHAVEIRO, CHAVEIRO + '.log']) fs.rmSync(f, { force: true });
  fs.writeFileSync(SECURITY_FALSO, `import fs from 'node:fs';
const ARQ = process.env.FALSO_CHAVEIRO;
const ler = () => { try { return JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch { return {}; } };
// A linha do -i como o security lê: separa por espaço; entre aspas duplas, \\" e \\\\.
const separar = (linha) => {
  const out = []; let i = 0;
  while (i < linha.length) {
    while (linha[i] === ' ') i++;
    if (i >= linha.length) break;
    let a = '';
    if (linha[i] === '"') { i++; while (i < linha.length && linha[i] !== '"') { if (linha[i] === '\\\\') i++; a += linha[i++]; } i++; }
    else while (i < linha.length && linha[i] !== ' ') a += linha[i++];
    out.push(a);
  }
  return out;
};
const args = process.argv.slice(2);
const entrada = args[0] === '-i' ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(ARQ + '.log', JSON.stringify({ args, entrada }) + '\\n');
let codigo = 0;
for (const a of args[0] === '-i' ? entrada.split('\\n').filter(Boolean).map(separar) : [args]) {
  const opc = (f) => (a.indexOf(f) >= 0 ? a[a.indexOf(f) + 1] : undefined);
  const chave = opc('-a') + '|' + opc('-s');
  const itens = ler();
  if (a[0] === 'add-generic-password') {
    if (itens[chave] !== undefined && !a.includes('-U')) { process.stderr.write('security: SecKeychainItemCreateFromContent: The specified item already exists in the keychain.\\n'); codigo = 45; continue; }
    itens[chave] = opc('-w'); fs.writeFileSync(ARQ, JSON.stringify(itens));
  } else if (a[0] === 'find-generic-password') {
    if (itens[chave] === undefined) { process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n'); codigo = 44; continue; }
    process.stdout.write(a.includes('-w') ? itens[chave] + '\\n' : 'keychain: "falso"\\nclass: "genp"\\n');
  } else if (a[0] === 'delete-generic-password') {
    if (itens[chave] === undefined) { process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n'); codigo = 44; continue; }
    delete itens[chave]; fs.writeFileSync(ARQ, JSON.stringify(itens)); process.stderr.write('password has been deleted.\\n');
  } else { codigo = 2; }
}
process.exit(codigo);
`);
}

let srv;
async function subir() {
  srv = spawn(process.execPath, [path.join(PROJ, 'servidor.mjs')], {
    cwd: PROJ, stdio: 'ignore',
    // Conta do Claude (19/10): o claude-falso deslogado e uma casa vazia; o claude e o login de verdade nunca rodam.
    env: { ...process.env, GERENCIADOR_PORTA: String(PORTA), GERENCIADOR_DADOS: DADOS, GERENCIADOR_SESSOES_DIR: SESS, ORBIT_PERFIL_DIR: PERFIL, ORBIT_GITHUB_API: `http://127.0.0.1:${PORTA_GH}`,
      ORBIT_CLAUDE_BIN: path.join(PROJ, 'testes', 'claude-falso.mjs'), GERENCIADOR_CLAUDE_HOME: path.join(SAIDA, 'casa'), FALSO_AUTH: path.join(SAIDA, 'auth.json'),
      ...(MAC ? { ORBIT_SECURITY: SECURITY_FALSO, FALSO_CHAVEIRO: CHAVEIRO } : {}) },
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/saude')).ok) return; } catch {} await dormir(150); }
  throw new Error('servidor de teste não subiu');
}
const get = async (p) => { const r = await fetch(BASE + p, { cache: 'no-store' }); return { status: r.status, tipo: r.headers.get('content-type'), corpo: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.arrayBuffer() }; };
const post = async (p, b, cab = true) => { const r = await fetch(BASE + p, { method: 'POST', headers: cab ? { 'x-gerenciador': '1', 'content-type': 'application/json' } : { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); return { status: r.status, corpo: await r.json().catch(() => null) }; };

let pcdp;
await testeMac().catch((e) => res.falhas.push('Mac simulado: ' + (e?.stack || e)));
try {
  await subir();
  // ── API ──
  let r = await get('/perfil');
  conferir(r.status === 200 && r.corpo.github === null && r.corpo.seguro === true, 'GET /perfil sem conta', r);
  conferir(typeof r.corpo.nome === 'string' && r.corpo.nome.length > 0, 'nome local: ' + r.corpo.nome);
  r = await post('/perfil/github', { token: VALIDO }, false);
  conferir(r.status === 403, 'POST sem x-gerenciador → 403', r);
  r = await post('/perfil/github', { token: 'senha123' });
  conferir(r.status === 400 && /não parece/.test(r.corpo?.erro), 'token mal formado → 400', r);
  r = await post('/perfil/github', { token: REVOGADO });
  conferir(r.status === 422 && /recusou/.test(r.corpo?.erro), 'token recusado → 422', r);
  conferir(!fs.existsSync(path.join(PERFIL, 'github.token')) && (!MAC || Object.keys(chaveiro()).length === 0), 'recusado não grava nada');
  r = await post('/perfil/github', { token: '  ' + VALIDO + '\n' });
  conferir(r.status === 200 && r.corpo.github?.login === 'orbit-teste' && r.corpo.github.avatar?.startsWith('/perfil/avatar?v='), 'conectar → 200', r);
  conferir(!JSON.stringify(r.corpo).includes(VALIDO), 'resposta não traz o token');
  if (!MAC) {
    const blob = fs.readFileSync(path.join(PERFIL, 'github.token'), 'utf8');
    const b64 = Buffer.from(VALIDO).toString('base64');
    conferir(!blob.includes(VALIDO) && !blob.includes(b64.slice(0, 40)), 'token cifrado em disco (nem texto nem base64)');
  } else {
    // Mac: no Chaveiro (o falso), serviço "Orbit GitHub", conta = usuário do sistema; nada no disco; só no stdin.
    const arquivos = fs.readdirSync(PERFIL);
    conferir(!arquivos.includes('github.token') && arquivos.every((a) => !fs.readFileSync(path.join(PERFIL, a)).toString('latin1').includes(VALIDO)), 'Mac: nada do token no disco', arquivos);
    conferir(chaveiro()[`${CONTA_MAC}|Orbit GitHub`] === VALIDO && Object.keys(chaveiro()).length === 1, 'Mac: token no Chaveiro (serviço "Orbit GitHub", conta do sistema)', Object.keys(chaveiro()));
    const ch = chamadasChaveiro();
    conferir(ch.length > 0 && ch.every((c) => !c.args.join(' ').includes(VALIDO)), 'Mac: token nunca na linha de comando do security', ch.map((c) => c.args));
    conferir(ch.some((c) => c.args[0] === '-i' && c.entrada.startsWith('add-generic-password -U ') && c.entrada.includes(VALIDO)), 'Mac: token só no stdin do security -i');
  }
  const json = fs.readFileSync(path.join(PERFIL, 'github.json'), 'utf8');
  conferir(!json.includes(VALIDO), 'github.json sem token');
  let a = await get('/perfil/avatar?v=1');
  conferir(a.status === 200 && a.tipo === 'image/png' && a.corpo.byteLength === avatarPng.length, 'avatar servido pelo Orbit', { s: a.status, t: a.tipo });
  // Reinício: continua conectado e o token ainda abre (DPAPI)
  srv.kill(); await dormir(600); await subir();
  r = await get('/perfil');
  conferir(r.corpo.github?.login === 'orbit-teste' && !r.corpo.github.expirado, 'continua conectado depois de reiniciar', r.corpo);
  r = await post('/perfil/github/verificar', { forcar: true });
  conferir(r.status === 200 && r.corpo.github?.expirado === false, 'verificar (decifra e confere) → válido', r);
  validoVale = false;
  r = await post('/perfil/github/verificar', { forcar: true });
  conferir(r.corpo.github?.expirado === true, 'token revogado → expirado', r);
  validoVale = true;
  r = await post('/perfil/github/verificar', { forcar: true });
  conferir(r.corpo.github?.expirado === false, 'token volta a valer → não expirado', r);
  r = await post('/perfil/github/verificar', {});
  conferir(r.status === 200, 'verificar sem forçar respeita o intervalo');

  // ── Página ──
  const EDGE = (await import('./edge.mjs')).caminhoNavegador(); // no Windows, o Edge de sempre; no Mac, ver edge.mjs
  pcdp = 9800 + Math.floor(Math.random() * 150);
  spawn(EDGE, ['--headless=new', `--remote-debugging-port=${pcdp}`, `--user-data-dir=${path.join(SAIDA, 'edge')}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  let ws, seq = 0; const pend = new Map(); const consoleErros = [];
  let alvo;
  for (let i = 0; i < 60 && !alvo; i++) { try { alvo = (await (await fetch(`http://127.0.0.1:${pcdp}/json`)).json()).find((x) => x.type === 'page'); } catch {} if (!alvo) await dormir(200); }
  ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((ok) => (ws.onopen = ok));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') consoleErros.push(d.params.args.map((x) => x.value ?? x.description).join(' '));
    if (d.method === 'Runtime.exceptionThrown') consoleErros.push('exceção: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !/favicon|\/perfil\/github$|\/modelos$/.test(d.params.entry.url || '')) consoleErros.push('log: ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
  };
  const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
  const av = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const foto = async (nome, clip) => { const r2 = await cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 2 } } : {}) }); fs.writeFileSync(path.join(SAIDA, nome + '.png'), Buffer.from(r2.result.data, 'base64')); };
  const tam = async (w, hgt) => { await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: hgt, deviceScaleFactor: 1, mobile: false }); await dormir(400); };
  const clicar = async (sel) => {
    const c = await av(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!c) throw new Error('sem ' + sel);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    await dormir(250);
  };
  const tecla = async (key, code, vk) => { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }); await dormir(200); };
  await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Page.enable');
  await tam(1440, 900);
  // Começa desconectado
  await post('/perfil/github/desconectar');
  await cdp('Page.navigate', { url: BASE + '/' });
  await dormir(2200);
  const estadoBotao = () => av(`(() => { const b = document.getElementById('btn-perfil'); const r = b.getBoundingClientRect(); const lat = document.getElementById('lateral').getBoundingClientRect();
    return { nome: b.querySelector('.perfil-nome').textContent, sub: b.querySelector('.perfil-sub').textContent, av: b.querySelector('.perfil-av').textContent, img: !!b.querySelector('.perfil-av img'), selo: !!b.querySelector('.pf-selo'),
      x: r.x, y: r.y, w: r.width, h: r.height, latBottom: lat.bottom, latW: lat.width, rolagemH: document.documentElement.scrollWidth > innerWidth, aria: b.getAttribute('aria-label') }; })()`);
  let b = await estadoBotao();
  conferir(b.nome.length > 0 && b.sub === 'Conta local' && !b.img && /^[A-Z]{1,2}$/.test(b.av), '1440: botão local (' + b.nome + ', ' + b.av + ')', b);
  conferir(Math.abs(b.y + b.h + 10 - b.latBottom) <= 2, '1440: botão colado no pé da lateral', b);
  await foto('01-lateral-local', { x: 0, y: 560, width: 240, height: 340 });
  await clicar('#btn-perfil');
  let pop = await av(`(() => { const p = document.getElementById('perfil-pop'); const r = p.getBoundingClientRect(); return { aberto: !p.hidden, x: r.x, y: r.y, w: r.width, h: r.height, foco: document.activeElement?.textContent, exp: document.getElementById('btn-perfil').getAttribute('aria-expanded') }; })()`);
  conferir(pop.aberto && pop.exp === 'true' && /Entrar no Claude/.test(pop.foco), 'abre o popover com foco no primeiro item (Entrar no Claude, o claude-falso deslogado)', pop);
  await foto('02-popover-local', { x: 0, y: Math.max(0, pop.y - 10), width: 340, height: 900 - Math.max(0, pop.y - 10) });
  await clicar('.perfil-pop .pf-item[aria-controls="pf-form"]');
  conferir(await av(`document.activeElement?.id === 'pf-token' && !document.getElementById('pf-form').hidden`), 'formulário abre com foco no campo');
  await cdp('Input.insertText', { text: REVOGADO });
  await tecla('Enter', 'Enter', 13);
  await dormir(600);
  const erro = await av(`document.getElementById('pf-erro').textContent`);
  conferir(/recusou/.test(erro), 'erro do GitHub aparece no popover: ' + erro);
  await foto('03-erro', { x: 0, y: 380, width: 340, height: 520 });
  await av(`(() => { const c = document.getElementById('pf-token'); c.select(); })()`);
  await cdp('Input.insertText', { text: VALIDO });
  await clicar('.pf-acoes .btn');
  await dormir(2500);
  b = await estadoBotao();
  conferir(b.nome === 'orbit-teste' && b.sub === 'GitHub' && b.img && b.selo, 'depois de conectar: login, foto e selo no botão', b);
  conferir(await av(`!document.documentElement.outerHTML.includes(${JSON.stringify(VALIDO)}) && document.getElementById('pf-token').value === ''`), 'token não fica no DOM');
  const imgOk = await av(`(() => { const i = document.querySelector('#btn-perfil img'); return i && i.complete && i.naturalWidth > 0; })()`);
  conferir(imgOk, 'foto carregou');
  pop = await av(`(() => { const p = document.getElementById('perfil-pop'); const r = p.getBoundingClientRect(); return { aberto: !p.hidden, y: r.y, txt: p.innerText }; })()`);
  conferir(pop.aberto && /Vinculada/.test(pop.txt) && /Desconectar/.test(pop.txt), 'popover mostra conta vinculada', pop.txt);
  await foto('04-popover-conectado', { x: 0, y: Math.max(0, pop.y - 10), width: 340, height: 900 - Math.max(0, pop.y - 10) });
  // Esc fecha e devolve o foco
  await tecla('Escape', 'Escape', 27);
  conferir(await av(`document.getElementById('perfil-pop').hidden && document.activeElement?.id === 'btn-perfil'`), 'Esc fecha e devolve o foco');
  await foto('05-lateral-github', { x: 0, y: 560, width: 240, height: 340 });
  // Clique fora fecha
  await clicar('#btn-perfil');
  await clicar('#h1');
  conferir(await av(`document.getElementById('perfil-pop').hidden`), 'clique fora fecha');
  // Recolhida
  await clicar('#recolher');
  await dormir(400);
  b = await estadoBotao();
  conferir(b.latW <= 70 && b.w <= 50, 'recolhida: só o avatar', b);
  await foto('06-recolhida', { x: 0, y: 600, width: 120, height: 300 });
  await clicar('#btn-perfil');
  pop = await av(`(() => { const r = document.getElementById('perfil-pop').getBoundingClientRect(); return { x: r.x, bottom: r.bottom }; })()`);
  conferir(pop.x >= 64, 'recolhida: popover à direita', pop);
  await foto('07-recolhida-popover', { x: 0, y: 380, width: 420, height: 520 });
  await tecla('Escape', 'Escape', 27);
  await clicar('#recolher');
  // 420
  await tam(420, 860);
  b = await estadoBotao();
  conferir(!b.rolagemH && b.w <= 34 && b.y < 60, '420: avatar na barra do topo, sem rolagem horizontal', b);
  await foto('08-estreita');
  await clicar('#btn-perfil');
  pop = await av(`(() => { const r = document.getElementById('perfil-pop').getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, w: innerWidth, rol: document.documentElement.scrollWidth > innerWidth }; })()`);
  conferir(pop.x >= 12 && pop.right <= pop.w - 11 && !pop.rol, '420: popover dentro da tela', pop);
  await foto('09-estreita-popover');
  // Desconectar em dois cliques
  await clicar('#pf-gh-sair');
  const armado = await av(`document.getElementById('pf-gh-sair').textContent`);
  conferir(/de novo/.test(armado) && (await get('/perfil')).corpo.github, 'primeiro clique só arma', armado);
  await foto('10-confirmar');
  await clicar('#pf-gh-sair');
  await dormir(800);
  b = await estadoBotao();
  const txtPop = await av(`document.getElementById('perfil-pop').innerText`);
  conferir(!b.img && b.sub === 'Conta local' && /Desconectado/.test(txtPop), 'desconecta no segundo clique', { b, txtPop });
  conferir(!fs.existsSync(path.join(PERFIL, 'github.token')) && !fs.existsSync(path.join(PERFIL, 'github.json')) && (!MAC || Object.keys(chaveiro()).length === 0), MAC ? 'arquivos e item do Chaveiro apagados' : 'arquivos apagados');
  await foto('11-desconectado');
  await tam(1440, 900);
  // SSE: outra aba conecta → esta atualiza
  await post('/perfil/github', { token: VALIDO });
  await dormir(1200);
  b = await estadoBotao();
  conferir(b.nome === 'orbit-teste', 'evento perfil pelo /fluxo atualiza a página', b);
  await post('/perfil/github/desconectar');
  conferir(consoleErros.length === 0, 'console sem erros', consoleErros);
  ws.close();
} catch (e) {
  res.falhas.push('exceção: ' + (e.stack || e));
} finally {
  try { srv.kill(); } catch {}
  if (pcdp) await fecharEdge(pcdp, path.join(SAIDA, 'edge')); // o perfil sai; as capturas ficam
  gh.close();
  // O token falso não pode ter ido para o log nem para os dados
  const log = path.join(DADOS, 'logs', 'servidor.log');
  const todo = [log, path.join(DADOS, 'estado.json'), path.join(DADOS, 'config.json')].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  conferir(!todo.includes(VALIDO) && !todo.includes(REVOGADO), 'token fora do log e dos dados');
  console.log(JSON.stringify({ ok: res.ok.length, falhas: res.falhas, passou: res.ok }, null, 1));
  process.exit(res.falhas.length ? 1 : 0);
}
