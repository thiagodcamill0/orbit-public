// Testes do terminal integrado (terminal.mjs): node testes/terminal.test.mjs <pastaSaida>
//
// Ainda sem o encaixe no servidor.mjs: sobe um http.createServer mínimo que imita o encaixe do contrato
// (Host local, x-gerenciador: 1 no POST, terminal.rota e o upgrade) numa porta de teste (47822–47826).
// Cliente: o WebSocket do Node (aceita Origin próprio) e, para as recusas e os quadros crus, http.request.
// Shells reais: Windows PowerShell e CMD (Windows); no Mac, o shell do usuário (zsh) e o bash, com os mesmos
// passos (comandos equivalentes de cada shell na tabela SH). Os nomes das seções são os do Windows.

import childProcess from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { escolherPorta } from './porta-livre.mjs';
import { criarTerminal, _teste } from '../terminal.mjs';

const saida = process.argv[2];
if (!saida) {
  console.error('uso: node testes/terminal.test.mjs <pastaSaida>');
  process.exit(2);
}
fs.mkdirSync(saida, { recursive: true });
const pastaProj = path.join(saida, 'proj-terminal');
fs.mkdirSync(pastaProj, { recursive: true });

let oks = 0;
let falhas = 0;
function conferir(cond, nome, extra = '') {
  if (cond) {
    oks++;
    console.log('  ok  ' + nome);
  } else {
    falhas++;
    console.log('  FALHA  ' + nome + (extra ? ' — ' + extra : ''));
  }
}
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const vivoPid = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const mesmaPasta = (a, b) => path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase();

// Comandos e nomes de cada sistema. No Windows, exatamente os de antes.
const WIN = process.platform === 'win32';
const SH = WIN
  ? {
      um: 'powershell',
      dois: 'cmd',
      nomeUm: 'PowerShell',
      nomeDois: 'CMD',
      dormir15: 'Start-Sleep -Milliseconds 1500',
      url: "Write-Output ('http://0.0.0.0:' + '5173/app'); Start-Sleep -Milliseconds 1200",
      tamanho: '$Host.UI.RawUI.WindowSize.Width; $Host.UI.RawUI.WindowSize.Height',
      grande: "'z' * 70000",
      titulo: null,
      dormirDois: 'ping -n 3 127.0.0.1',
      fora: 'C:\\Windows\\System32\\calc.exe',
    }
  : {
      um: 'padrao',
      dois: 'bash',
      nomeUm: path.basename(process.env.SHELL || '/bin/zsh'),
      nomeDois: 'bash',
      dormir15: 'sleep 1.5',
      url: "printf 'http://0.0.0.0:%s\\n' '5173/app'; sleep 1.2",
      tamanho: 'tput cols; tput lines',
      grande: "head -c 70000 /dev/zero | tr '\\0' z; echo",
      titulo: "printf '\\033]0;%s\\007' orbit-titulo",
      dormirDois: 'sleep 2',
      fora: '/bin/sh',
    };

const limiteGeral = setTimeout(() => {
  console.log('FALHA: o teste passou de 90 s');
  process.exit(1);
}, 90000);

// ---------- peças puras ----------
console.log('filtro da saída');
{
  const { filtrar, aparar, caminhoGitBash } = _teste;
  const f = { resto: '' };
  const a = filtrar(f, 'abc\x1b]69');
  const b = filtrar(f, '73;P;C:\\x\x07def');
  conferir(a.join('') === 'abc' && f.resto === '' && b[0]?.cwd === 'C:\\x' && b[1] === 'def', 'marca partida entre dois pedaços sai inteira', JSON.stringify([a, b]));
  const c = filtrar(f, 'x\x1b]6973;P;D:\\y\x1b');
  const d = filtrar(f, '\\z');
  conferir(c.join('') === 'x' && d[0]?.cwd === 'D:\\y' && d[1] === 'z', 'marca com ESC \\ partida no terminador', JSON.stringify([c, d]));
  const e = filtrar(f, 'fim\x1b');
  const g = filtrar(f, '[31mvermelho');
  conferir(e.join('') === 'fim' && g.join('') === '\x1b[31mvermelho', 'ESC solto no fim espera o próximo pedaço');
  const h = filtrar(f, 'meio\x1b]0;tit');
  const i = filtrar(f, '', true);
  conferir(h.join('') === 'meio' && i.join('') === '\x1b]0;tit', 'resto incompleto é solto quando forçado');
  const grande = 'a'.repeat(300000) + '\n' + 'b'.repeat(1000);
  conferir(aparar(grande).length <= 262144 && aparar(grande).startsWith('a'), 'buffer aparado em 256 KB');
  const semNl = 'x'.repeat(262140) + '\x1b[38;2;10;20;30m' + 'y'.repeat(100);
  const ap = aparar('z'.repeat(150) + semNl);
  conferir(!/^[0-9;]*m/.test(ap) && ap.length <= 262144, 'corte não parte sequência de escape', JSON.stringify(ap.slice(0, 20)));
  const sur = 'q'.repeat(10) + '😀'.repeat(140000);
  const aps = aparar(sur);
  const k = aps.charCodeAt(0);
  conferir(!(k >= 0xdc00 && k <= 0xdfff), 'corte não parte par UTF-16');
  conferir(caminhoGitBash('/d/Dev/x') === 'D:\\Dev\\x' && caminhoGitBash('/c') === 'C:\\' && caminhoGitBash('/usr/bin') === '/usr/bin' && caminhoGitBash('C:/Users/x') === 'C:\\Users\\x', 'caminho do Git Bash vira caminho do Windows');
}

// ---------- servidor mínimo (imita o encaixe) ----------
const porta = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47822);
const deps = {
  porta,
  projetos: () => [
    { nome: 'proj', pasta: pastaProj },
    { nome: 'sumiu', pasta: path.join(saida, 'nao-existe') },
  ],
  log: () => {},
  lerJSONCorpo: async () => ({}),
};
const terminal = criarTerminal(deps);
const srv = http.createServer(async (req, res) => {
  const h = String(req.headers.host || '').toLowerCase();
  if (h !== `127.0.0.1:${porta}` && h !== `localhost:${porta}`) {
    res.writeHead(403);
    return res.end();
  }
  if (req.method === 'POST' && req.headers['x-gerenciador'] !== '1') {
    res.writeHead(403);
    return res.end();
  }
  const url = new URL(req.url, `http://127.0.0.1:${porta}`);
  try {
    if (await terminal.rota(req, res, url.pathname, url)) return;
  } catch (e) {
    res.writeHead(500);
    return res.end(String(e));
  }
  res.writeHead(404);
  res.end();
});
srv.on('upgrade', (req, s, h) => {
  if (!terminal.upgrade(req, s, h)) s.destroy();
});
await new Promise((r) => srv.listen(porta, '127.0.0.1', r));
console.log(`servidor de teste na ${porta}`);

const ORIGEM = `http://127.0.0.1:${porta}`;

function pedir(metodo, caminho, cab = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, headers: cab }, (res) => {
      const partes = [];
      res.on('data', (d) => partes.push(d));
      res.on('end', () => {
        const corpo = Buffer.concat(partes).toString();
        let json = null;
        try {
          json = JSON.parse(corpo);
        } catch {}
        resolve({ status: res.statusCode, cab: res.headers, corpo, json });
      });
    });
    req.on('error', (e) => resolve({ status: 0, erro: e.message }));
    req.end();
  });
}
const bilhete = async () => (await pedir('POST', '/terminal/bilhete', { 'x-gerenciador': '1' })).json?.bilhete;

// Upgrade cru: devolve { status, socket?, head? }.
function upgradeCru({ caminho, host = `127.0.0.1:${porta}`, origin = ORIGEM, versao = '13', manter = false } = {}) {
  return new Promise((resolve) => {
    const cab = { host, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': versao, 'sec-websocket-key': crypto.randomBytes(16).toString('base64') };
    if (origin) cab.origin = origin;
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, headers: cab });
    req.on('upgrade', (res, socket, head) => {
      if (manter) return resolve({ status: 101, socket, head });
      socket.destroy();
      resolve({ status: 101 });
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on('error', (e) => resolve({ status: 0, erro: e.code || e.message }));
    req.end();
  });
}

// Quadro de cliente (mascarado, salvo se mascarar = false).
function quadroCliente(op, dados, { fin = true, mascarar = true } = {}) {
  const corpo = Buffer.from(dados);
  const n = corpo.length;
  const cab = n < 126 ? Buffer.from([0, n]) : Buffer.from([0, 126, n >> 8, n & 255]);
  cab[0] = (fin ? 0x80 : 0) | op;
  if (!mascarar) return Buffer.concat([cab, corpo]);
  cab[1] |= 0x80;
  const chave = crypto.randomBytes(4);
  for (let i = 0; i < n; i++) corpo[i] ^= chave[i & 3];
  return Buffer.concat([cab, chave, corpo]);
}

// Lê os quadros do servidor (sem máscara) de um socket cru.
function leitorQuadros(socket, head) {
  const q = [];
  let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
  const ler = () => {
    for (;;) {
      if (buf.length < 2) return;
      let tam = buf[1] & 0x7f;
      let pos = 2;
      if (tam === 126) {
        if (buf.length < 4) return;
        tam = buf.readUInt16BE(2);
        pos = 4;
      } else if (tam === 127) {
        if (buf.length < 10) return;
        tam = buf.readUInt32BE(6);
        pos = 10;
      }
      if (buf.length < pos + tam) return;
      q.push({ op: buf[0] & 0x0f, mascara: (buf[1] & 0x80) !== 0, dados: buf.subarray(pos, pos + tam) });
      buf = buf.subarray(pos + tam);
    }
  };
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    ler();
  });
  ler();
  return q;
}

async function ate(cond, ms = 8000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    const v = cond();
    if (v) return v;
    await dormir(25);
  }
  return cond();
}

// Cliente com o WebSocket do Node.
async function conectar() {
  const b = await bilhete();
  const ws = new WebSocket(`ws://127.0.0.1:${porta}/terminal/ws?bilhete=${b}`, { headers: { origin: ORIGEM } });
  const c = { ws, msgs: [], fechou: null };
  ws.onmessage = (e) => c.msgs.push(JSON.parse(e.data));
  ws.onclose = (e) => (c.fechou = e.code);
  const abriu = await new Promise((r) => {
    ws.onopen = () => r(true);
    ws.onerror = () => r(false);
  });
  if (!abriu) throw new Error('WebSocket não abriu');
  c.enviar = (o) => ws.send(JSON.stringify(o));
  c.marca = () => c.msgs.length;
  c.achar = (pred, de = 0) => c.msgs.slice(de).find(pred);
  c.esperar = (pred, ms = 8000, de = 0) => ate(() => c.achar(pred, de), ms);
  c.texto = (id, de = 0) => c.msgs.slice(de).filter((m) => m.t === 'saida' && m.id === id).map((m) => m.d).join('');
  // Último pid visto do terminal (no Windows ele chega num meta logo depois do criado).
  c.pid = (id, ms = 8000, de = 0) => ate(() => c.msgs.slice(de).filter((m) => (m.t === 'meta' || m.t === 'criado') && m.term.id === id && m.term.pid > 0).map((m) => m.term.pid).pop(), ms);
  return c;
}

const pids = new Set();
try {
  // ---------- rotas ----------
  console.log('rotas');
  const sh = await pedir('GET', '/terminal/shells');
  const ids = (sh.json?.shells || []).map((s) => s.id);
  const padrao = sh.json?.shells?.find((s) => s.padrao)?.id;
  if (WIN) conferir(sh.status === 200 && ids.includes('powershell') && ids.includes('cmd') && sh.json.plataforma === 'win32' && (padrao === 'pwsh' || padrao === 'powershell') && sh.cab['cache-control'] === 'no-store', 'GET /terminal/shells', JSON.stringify(sh.json));
  else {
    // Mac: o shell do usuário é o padrão; o bash do sistema também aparece (o usuário aqui usa zsh).
    const nomePadrao = sh.json?.shells?.find((x) => x.padrao)?.nome;
    conferir(sh.status === 200 && padrao === 'padrao' && nomePadrao === SH.nomeUm && ids.includes('bash') && sh.json.plataforma === process.platform && sh.cab['cache-control'] === 'no-store', 'GET /terminal/shells', JSON.stringify(sh.json));
  }
  conferir(!sh.cab['access-control-allow-origin'], 'GET de leitura sem CORS');
  const vx = await pedir('GET', '/terminal/vendor/xterm.js');
  conferir(vx.status === 200 && /javascript/.test(vx.cab['content-type']) && vx.cab['x-content-type-options'] === 'nosniff' && vx.cab['cache-control'] === 'no-cache' && vx.corpo.length > 10000, 'vendor xterm.js');
  const vc = await pedir('GET', '/terminal/vendor/xterm.css');
  conferir(vc.status === 200 && /text\/css/.test(vc.cab['content-type']), 'vendor xterm.css');
  let todos = true;
  for (const n of ['addon-fit.js', 'addon-web-links.js', 'addon-unicode11.js']) todos &&= (await pedir('GET', '/terminal/vendor/' + n)).status === 200;
  conferir(todos, 'vendor dos três addons');
  const fora = [await pedir('GET', '/terminal/vendor/..%2Fpackage.json'), await pedir('GET', '/terminal/vendor/xterm.mjs'), await pedir('GET', '/terminal/vendor/toString')];
  conferir(fora.every((r) => r.status === 404), 'vendor fora da lista → 404', fora.map((r) => r.status).join(','));
  const bl = await pedir('POST', '/terminal/bilhete', { 'x-gerenciador': '1' });
  conferir(bl.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(bl.json?.bilhete || '') && bl.json.validade === 30000, 'POST /terminal/bilhete');
  conferir((await pedir('GET', '/terminal/bilhete')).status === 405, 'GET /terminal/bilhete → 405');
  conferir((await pedir('POST', '/terminal/bilhete')).status === 403, 'POST sem x-gerenciador barrado (encaixe)');
  const ls0 = await pedir('GET', '/terminal/lista');
  conferir(ls0.status === 200 && Array.isArray(ls0.json?.terminais) && ls0.json.terminais.length === 0, 'GET /terminal/lista vazia');
  conferir((await pedir('GET', '/outra')).status === 404, 'rota fora de /terminal não é do módulo');

  // ---------- segurança do upgrade ----------
  console.log('segurança do WebSocket');
  const caminho = async () => `/terminal/ws?bilhete=${await bilhete()}`;
  conferir((await upgradeCru({ caminho: await caminho(), origin: null })).status === 403, 'sem Origin → 403');
  conferir((await upgradeCru({ caminho: await caminho(), origin: 'http://evil.example' })).status === 403, 'Origin de fora → 403');
  conferir((await upgradeCru({ caminho: await caminho(), origin: ORIGEM + '/' })).status === 403, 'Origin quase igual → 403');
  conferir((await upgradeCru({ caminho: await caminho(), host: `evil.example:${porta}` })).status === 403, 'Host errado → 403');
  conferir((await upgradeCru({ caminho: '/terminal/ws' })).status === 403, 'sem bilhete → 403');
  conferir((await upgradeCru({ caminho: '/terminal/ws?bilhete=' + 'A'.repeat(43) })).status === 403, 'bilhete inventado → 403');
  conferir((await upgradeCru({ caminho: await caminho(), versao: '8' })).status === 403, 'versão diferente de 13 → 403');
  const usado = await caminho();
  const u1 = await upgradeCru({ caminho: usado });
  const u2 = await upgradeCru({ caminho: usado });
  conferir(u1.status === 101 && u2.status === 403, 'bilhete reusado → 403', `${u1.status}/${u2.status}`);
  deps.validadeBilhete = 150;
  const vencido = await caminho();
  delete deps.validadeBilhete;
  await dormir(300);
  conferir((await upgradeCru({ caminho: vencido })).status === 403, 'bilhete vencido → 403');
  const outra = await upgradeCru({ caminho: '/outra-rota' });
  conferir(outra.status === 0, 'upgrade de outra rota: socket destruído', JSON.stringify(outra));
  const ok101 = await upgradeCru({ caminho: await caminho(), host: `localhost:${porta}`, origin: `http://localhost:${porta}` });
  conferir(ok101.status === 101, 'Host e Origin localhost aceitos');

  // ---------- PowerShell ----------
  console.log('PowerShell');
  const A = await conectar();
  const lista0 = await A.esperar((m) => m.t === 'lista');
  conferir(lista0 && lista0.terminais.length === 0, 'ao conectar: lista vazia');
  A.enviar({ t: 'ping' });
  conferir(await A.esperar((m) => m.t === 'pong'), 'ping → pong');
  A.enviar({ t: 'criar', ref: 'r1', shell: SH.um, projeto: 'proj', cols: 100, rows: 30 });
  const cr = await A.esperar((m) => m.t === 'criado' && m.ref === 'r1', 10000);
  const ps = cr?.term;
  conferir(ps && ps.nome === SH.nomeUm && ps.shell === SH.um && ps.shellNome === (WIN ? 'Windows PowerShell' : SH.nomeUm) && ps.projeto === 'proj' && mesmaPasta(ps.cwd, pastaProj) && ps.vivo && ps.integracao === false, 'criar PowerShell no projeto', JSON.stringify(ps));
  if (!ps) throw new Error('sem terminal PowerShell');
  const psPid = await A.pid(ps.id);
  conferir(psPid > 0, 'pid do shell chega num meta', String(psPid));
  pids.add(psPid);
  const integ = await A.esperar((m) => m.t === 'meta' && m.term.id === ps.id && m.term.integracao, 15000);
  conferir(integ && mesmaPasta(integ.term.cwd, pastaProj) && !integ.term.ocupado, 'marca do prompt: integração ligada com o cwd', JSON.stringify(integ?.term));

  let de = A.marca();
  A.enviar({ t: 'entrada', id: ps.id, d: 'echo orbit-eco-1\r' });
  const ocu = await A.esperar((m) => m.t === 'meta' && m.term.id === ps.id && m.term.ocupado, 3000, de);
  conferir(ocu && ocu.term.desde > 0, 'Enter liga o ocupado');
  conferir(await ate(() => /orbit-eco-1[\s\S]*orbit-eco-1/.test(A.texto(ps.id, de)), 8000), 'entrada e saída com eco');
  conferir(await A.esperar((m) => m.t === 'meta' && m.term.id === ps.id && !m.term.ocupado, 8000, de), 'prompt de volta desliga o ocupado');

  de = A.marca();
  const t0 = Date.now();
  A.enviar({ t: 'entrada', id: ps.id, d: SH.dormir15 + '\r' });
  await A.esperar((m) => m.t === 'meta' && m.term.id === ps.id && m.term.ocupado, 3000, de);
  const livre = await A.esperar((m) => m.t === 'meta' && m.term.id === ps.id && !m.term.ocupado, 10000, de);
  conferir(livre && Date.now() - t0 >= 1300, 'ocupado dura o comando (Start-Sleep 1,5 s)', `${Date.now() - t0} ms`);

  de = A.marca();
  A.enviar({ t: 'entrada', id: ps.id, d: SH.url + '\r' });
  const comUrl = await A.esperar((m) => m.t === 'meta' && m.term.id === ps.id && m.term.urls.length, 8000, de);
  conferir(comUrl && comUrl.term.urls[0] === 'http://localhost:5173/app' && comUrl.term.ocupado, 'URL local detectada (0.0.0.0 → localhost)', JSON.stringify(comUrl?.term.urls));
  const semUrl = await A.esperar((m) => m.t === 'meta' && m.term.id === ps.id && !m.term.ocupado && !m.term.urls.length, 8000, de);
  conferir(semUrl, 'URLs limpas quando o comando acaba');

  de = A.marca();
  A.enviar({ t: 'tamanho', id: ps.id, cols: 123, rows: 41 });
  await dormir(150);
  A.enviar({ t: 'entrada', id: ps.id, d: SH.tamanho + '\r' });
  conferir(await ate(() => /123[\s\S]*41/.test(_teste.semAnsi(A.texto(ps.id, de)).replace(/WindowSize/g, '')), 8000), 'tamanho chega ao shell (123×41)');
  await A.esperar((m) => m.t === 'meta' && m.term.id === ps.id && !m.term.ocupado, 8000, de);

  de = A.marca();
  A.enviar({ t: 'entrada', id: ps.id, d: SH.grande + '\r' });
  conferir(await ate(() => (A.texto(ps.id, de).match(/z/g) || []).length >= 70000, 10000), 'saída grande (70 mil caracteres) chega inteira');
  await A.esperar((m) => m.t === 'meta' && m.term.id === ps.id && !m.term.ocupado, 8000, de);

  // Mac: o zsh sem tema não põe título sozinho (o PowerShell põe): o comando manda o OSC 0.
  if (SH.titulo) {
    de = A.marca();
    A.enviar({ t: 'entrada', id: ps.id, d: SH.titulo + '\r' });
    await A.esperar((m) => m.t === 'meta' && m.term.id === ps.id && !m.term.ocupado, 8000, de);
  }
  conferir(!A.msgs.some((m) => m.t === 'saida' && m.d.includes('6973')), 'marca nunca aparece na saída');
  conferir(A.achar((m) => m.t === 'meta' && m.term.id === ps.id && m.term.titulo), 'título (OSC 0/2) vira titulo');

  // ---------- replay e difusão ----------
  console.log('replay e difusão');
  const B = await conectar();
  const listaB = await B.esperar((m) => m.t === 'lista');
  conferir(listaB && listaB.terminais.some((t) => t.id === ps.id && t.nome === SH.nomeUm), 'segunda conexão recebe a lista');
  const rep = await B.esperar((m) => m.t === 'saida' && m.id === ps.id && m.replay);
  conferir(rep && rep.d.includes('orbit-eco-1') && !rep.d.includes('6973'), 'replay com a saída guardada, sem a marca');
  conferir(B.msgs.indexOf(listaB) < B.msgs.indexOf(rep), 'lista chega antes do replay');
  A.enviar({ t: 'renomear', id: ps.id, nome: '  Meu terminal  ' });
  const renA = await A.esperar((m) => m.t === 'meta' && m.term.nome === 'Meu terminal');
  const renB = await B.esperar((m) => m.t === 'meta' && m.term.nome === 'Meu terminal');
  conferir(renA && renB, 'renomear vai para as duas conexões');
  de = A.marca();
  A.enviar({ t: 'renomear', id: ps.id, nome: '   ' });
  A.enviar({ t: 'renomear', id: ps.id, nome: 'x'.repeat(41) });
  await A.esperar((m) => m.t === 'erro' && m.id === ps.id, 3000, de);
  conferir(A.msgs.slice(de).filter((m) => m.t === 'erro').length === 2 && !B.achar((m) => m.t === 'erro'), 'nome inválido → erro só para quem pediu');
  B.ws.close();
  de = A.marca();
  A.ws.send('{isto não é json');
  A.enviar({ t: 'ping' });
  conferir(await A.esperar((m) => m.t === 'pong', 3000, de), 'JSON inválido é ignorado (conexão segue)');

  // ---------- CMD ----------
  console.log('CMD');
  A.enviar({ t: 'criar', ref: 'r2', shell: SH.dois, projeto: 'sumiu', cols: 90, rows: 25 });
  const cmd = (await A.esperar((m) => m.t === 'criado' && m.ref === 'r2', 10000))?.term;
  conferir(cmd && cmd.nome === SH.nomeDois && cmd.projeto === null && mesmaPasta(cmd.cwd, os.homedir()), 'criar CMD (projeto sem pasta → pasta pessoal)', JSON.stringify(cmd));
  if (!cmd) throw new Error('sem terminal CMD');
  const cmdPid = await A.pid(cmd.id);
  pids.add(cmdPid);
  conferir(await A.esperar((m) => m.t === 'meta' && m.term.id === cmd.id && m.term.integracao, 10000), 'CMD: marca do PROMPT');
  de = A.marca();
  const t1 = Date.now();
  A.enviar({ t: 'entrada', id: cmd.id, d: SH.dormirDois + '\r' });
  conferir(await A.esperar((m) => m.t === 'meta' && m.term.id === cmd.id && m.term.ocupado, 3000, de), 'CMD: ocupado com ping');
  const cmdLivre = await A.esperar((m) => m.t === 'meta' && m.term.id === cmd.id && !m.term.ocupado, 10000, de);
  conferir(cmdLivre && Date.now() - t1 >= 1500, 'CMD: livre quando o ping acaba', `${Date.now() - t1} ms`);
  conferir(!A.msgs.some((m) => m.t === 'saida' && m.d.includes('6973')), 'CMD: marca fora da saída');

  de = A.marca();
  A.enviar({ t: 'entrada', id: cmd.id, d: 'exit 3\r' });
  const saiu = await A.esperar((m) => m.t === 'saiu' && m.id === cmd.id, 8000, de);
  const metaSaiu = A.achar((m) => m.t === 'meta' && m.term.id === cmd.id && !m.term.vivo, de);
  conferir(saiu && saiu.codigo === 3 && metaSaiu && metaSaiu.term.codigo === 3, 'exit 3 → saiu com código 3 (terminal fica)', JSON.stringify(saiu));
  conferir((await pedir('GET', '/terminal/lista')).json.terminais.some((t) => t.id === cmd.id && !t.vivo), 'terminal que saiu continua na lista');
  de = A.marca();
  A.enviar({ t: 'reiniciar', id: cmd.id });
  const rein = await A.esperar((m) => m.t === 'meta' && m.term.id === cmd.id && m.term.vivo, 8000, de);
  const reinPid = await A.pid(cmd.id, 8000, de);
  conferir(rein && rein.term.nome === SH.nomeDois && reinPid > 0 && reinPid !== cmdPid && rein.term.codigo === null && mesmaPasta(rein.term.cwd, os.homedir()), 'reiniciar: mesmo shell, nome e pasta, pid novo');
  if (reinPid) pids.add(reinPid);
  await A.esperar((m) => m.t === 'meta' && m.term.id === cmd.id && m.term.integracao, 10000, de);

  // Processo filho (fica rodando) para conferir que o parar() mata a árvore.
  de = A.marca();
  A.enviar({ t: 'entrada', id: cmd.id, d: 'node -e "console.log(\'PIDFI\'+\'LHO=\'+process.pid);setInterval(()=>{},1000)"\r' });
  const mFilho = await ate(() => /PIDFILHO=(\d+)/.exec(_teste.semAnsi(A.texto(cmd.id, de))), 8000);
  const pidFilho = mFilho ? Number(mFilho[1]) : 0;
  conferir(pidFilho && vivoPid(pidFilho), 'processo filho rodando no CMD', String(pidFilho));
  const est = terminal.estado();
  conferir(est.total === 2 && est.rodando === 1 && terminal.bloqueios().rodando === 1, 'estado() e bloqueios() contam o comando rodando', JSON.stringify(est));

  // ---------- fechar e limite ----------
  console.log('fechar e limite');
  de = A.marca();
  A.enviar({ t: 'criar', ref: 'r3', cols: 80, rows: 24 });
  const p2 = (await A.esperar((m) => m.t === 'criado' && m.ref === 'r3', 10000))?.term;
  conferir(p2 && p2.shell === padrao && p2.nome === SH.nomeUm, 'sem shell vai o padrão; nome livre', JSON.stringify(p2 && { shell: p2.shell, nome: p2.nome }));
  if (p2) {
    const p2Pid = await A.pid(p2.id);
    pids.add(p2Pid);
    A.enviar({ t: 'fechar', id: p2.id });
    conferir(await A.esperar((m) => m.t === 'removido' && m.id === p2.id, 5000, de), 'fechar → removido');
    conferir(await ate(() => p2Pid > 0 && !vivoPid(p2Pid), 6000), 'fechar mata o processo');
  }
  de = A.marca();
  const extras = [];
  for (let i = 0; i < 14; i++) A.enviar({ t: 'criar', ref: 'L' + i, shell: SH.dois, cols: 80, rows: 24 });
  await A.esperar((m) => m.t === 'criado' && m.ref === 'L13', 15000, de);
  for (const m of A.msgs.slice(de)) if (m.t === 'criado') extras.push(m.term);
  for (const t of extras) pids.add(await A.pid(t.id, 3000));
  conferir(extras.length === 14 && extras[0].nome === `${SH.nomeDois} 2` && extras[1].nome === `${SH.nomeDois} 3`, 'nomes repetidos ganham número (CMD 2, CMD 3)', extras.slice(0, 2).map((t) => t.nome).join(','));
  A.enviar({ t: 'criar', ref: 'L-demais', shell: SH.dois, cols: 80, rows: 24 });
  const lim = await A.esperar((m) => m.t === 'erro' && m.ref === 'L-demais', 5000, de);
  conferir(lim && /Limite de 16 terminais/.test(lim.msg) && terminal.estado().total === 16, 'limite de 16 terminais', lim?.msg);
  for (const t of extras) A.enviar({ t: 'fechar', id: t.id });
  await ate(() => terminal.estado().total === 2, 5000);
  A.enviar({ t: 'criar', ref: 'r-ruim2', shell: SH.fora, cols: 80, rows: 24 });
  const ruim = await A.esperar((m) => m.t === 'erro' && m.ref === 'r-ruim2', 3000, de);
  conferir(ruim && /não está disponível/.test(ruim.msg), 'shell fora da lista é recusado', ruim?.msg);

  // ---------- Git Bash (se houver) ----------
  if (WIN && ids.includes('bash')) {
    console.log('Git Bash');
    de = A.marca();
    A.enviar({ t: 'criar', ref: 'r-bash', shell: 'bash', projeto: 'proj', cols: 100, rows: 30 });
    const gb = (await A.esperar((m) => m.t === 'criado' && m.ref === 'r-bash', 10000, de))?.term;
    conferir(gb && gb.nome === 'Git Bash' && gb.shellNome === 'Git Bash', 'criar Git Bash');
    if (gb) {
      pids.add(await A.pid(gb.id));
      const gi = await A.esperar((m) => m.t === 'meta' && m.term.id === gb.id && m.term.integracao, 15000, de);
      conferir(gi && mesmaPasta(gi.term.cwd, pastaProj), 'Git Bash: marca do PROMPT_COMMAND com o cwd do Windows', gi?.term.cwd);
      const d2 = A.marca();
      A.enviar({ t: 'entrada', id: gb.id, d: 'sleep 1\r' });
      conferir(await A.esperar((m) => m.t === 'meta' && m.term.id === gb.id && m.term.ocupado, 3000, d2), 'Git Bash: ocupado com sleep');
      conferir(await A.esperar((m) => m.t === 'meta' && m.term.id === gb.id && !m.term.ocupado, 8000, d2), 'Git Bash: livre quando acaba');
      A.enviar({ t: 'fechar', id: gb.id });
      await A.esperar((m) => m.t === 'removido' && m.id === gb.id, 5000, d2);
    }
  } else console.log(WIN ? 'Git Bash: não instalado, pulado' : 'Git Bash: só no Windows (o bash do Mac foi o segundo shell)');

  // ---------- quadros ----------
  console.log('quadros do WebSocket');
  const C = await conectar();
  C.ws.send('x'.repeat(1024 * 1024 + 10));
  conferir((await ate(() => C.fechou, 5000)) === 1009, 'quadro maior que 1 MB → close 1009', String(C.fechou));

  const cru = await upgradeCru({ caminho: await caminho(), manter: true });
  const q = leitorQuadros(cru.socket, cru.head);
  await ate(() => q.some((x) => x.op === 1 && x.dados.length > 65535), 3000);
  const lst = q.find((x) => x.op === 1);
  conferir(lst && !lst.mascara && JSON.parse(lst.dados.toString()).t === 'lista', 'quadro do servidor sem máscara (lista)');
  conferir(q.some((x) => x.op === 1 && x.dados.length > 65535) && q.some((x) => x.op === 1 && x.dados.length > 125 && x.dados.length < 65536), 'quadros com tamanho de 16 e 64 bits (replay grande)', q.map((x) => x.dados.length).join(','));
  cru.socket.write(quadroCliente(9, 'oi'));
  const pong = await ate(() => q.find((x) => x.op === 10), 3000);
  conferir(pong && pong.dados.toString() === 'oi', 'ping de protocolo → pong com o mesmo corpo');
  const n0 = q.length;
  cru.socket.write(Buffer.concat([quadroCliente(1, '{"t":"pi', { fin: false }), quadroCliente(0, 'ng"}')]));
  const pongJson = await ate(() => q.slice(n0).find((x) => x.op === 1 && x.dados.toString() === '{"t":"pong"}'), 3000);
  conferir(pongJson, 'mensagem fragmentada (texto + continuação)');
  cru.socket.write(quadroCliente(1, '{"t":"ping"}', { mascarar: false }));
  const fechou = await ate(() => q.find((x) => x.op === 8), 3000);
  conferir(fechou && fechou.dados.readUInt16BE(0) === 1002, 'quadro sem máscara → close 1002', fechou && String(fechou.dados.readUInt16BE(0)));
  cru.socket.destroy();

  // ---------- agente de lista do console (node-pty 1.1.0) ----------
  if (WIN) {
    console.log('agente de lista do console');
    conferir(childProcess.fork.orbitSilencia === true, 'fork do agente do node-pty passa pelo filtro');
    const dirAg = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-agente-'));
    const agente = (sub, txt) => {
      const p = path.join(dirAg, sub, 'conpty_console_list_agent.js');
      fs.mkdirSync(path.dirname(p));
      fs.writeFileSync(p, `process.stderr.write(${JSON.stringify(txt)}); process.send({ consoleProcessList: [] }); process.exit(1);`);
      return p;
    };
    const escrito = [];
    const escrever = process.stderr.write;
    process.stderr.write = function (d) { escrito.push(String(d)); return true; };
    try {
      const rodar = (p) => new Promise((r) => { const c = childProcess.fork(p, ['1']); c.on('close', () => setTimeout(r, 50)); });
      await rodar(agente('a', 'Error: AttachConsole failed\n    at Object.<anonymous> (conpty_console_list_agent.js:10:29)\n'));
      await rodar(agente('b', 'outra saida do agente\n'));
    } finally {
      process.stderr.write = escrever;
      fs.rmSync(dirAg, { recursive: true, force: true });
    }
    const tudo = escrito.join('');
    conferir(!/AttachConsole failed/.test(tudo), '"AttachConsole failed" do agente não vai para o log', tudo);
    conferir(/outra saida do agente/.test(tudo), 'outra saída do agente segue para o stderr', tudo);
  }

  // ---------- parar ----------
  console.log('parar()');
  const pidsVivos = [...pids].filter(vivoPid);
  await terminal.parar();
  const mortos = await ate(() => [...pids, pidFilho].every((p) => !p || !vivoPid(p)), 6000);
  conferir(mortos, 'parar() não deixa processo (shells e o node filho)', [...pids, pidFilho].filter((p) => p && vivoPid(p)).join(','));
  conferir(pidsVivos.length >= 2, 'havia shells vivos antes do parar()', String(pidsVivos.length));
  conferir((await ate(() => A.fechou, 3000)) === 1001, 'parar() fecha as conexões (1001)', String(A.fechou));
  conferir((await upgradeCru({ caminho: await caminho() })).status === 403, 'depois do parar(), upgrade recusado');
  conferir(terminal.estado().total === 0, 'nenhum terminal depois do parar()');
} catch (e) {
  falhas++;
  console.log('  FALHA  exceção: ' + (e?.stack || e));
  try {
    await terminal.parar();
  } catch {}
}

clearTimeout(limiteGeral);
srv.close();
fs.rmSync(pastaProj, { recursive: true, force: true });
console.log(`\n${oks} ok / ${falhas} falhas`);
process.exit(falhas ? 1 : 0);
