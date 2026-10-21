// Navegador interno (16/10): abas com páginas, foco nas locais (localhost). Página: assets/navegador.js.
//
// A página mostra o endereço num iframe. Este módulo faz o que o iframe não consegue saber sozinho:
//   - conferir, antes de abrir, se o endereço responde e se aceita ser embutido (X-Frame-Options e
//     frame-ancestors do CSP), para a aba mostrar uma mensagem em vez de uma tela em branco;
//   - abrir o endereço no navegador padrão do sistema (abrirExterno do plataforma.mjs);
//   - guardar o endereço da prévia de cada projeto (<DADOS>/previas.json, por pasta) e sugerir as portas
//     locais em uso pelo projeto (processo escutando cuja linha de comando cita a pasta do projeto).
// Sem proxy: a página embutida é de outra origem, e o Orbit não lê o endereço nem o título dela.
//
// Rotas: GET /navegador/previas · GET /navegador/portas?pasta=…&pasta=…
//        POST /navegador/checar {url} · /navegador/externo {url} · /navegador/previa {pasta, url}
// SSE: "previas" { previas: [{ pasta, url }] }.

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { SO, abrirExterno, pathAmpliado } from './plataforma.mjs';

const MAX_URL = 2048;
const TEMPO_CHECAR = 6000;
const TEMPO_PORTA = 900;
const MAX_SALTOS = 5;
const CACHE_PORTAS = 4000;
const AGENTE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Orbit';
// Processos do sistema que escutam portas e nunca são prévia de projeto.
const SISTEMA = new Set(['system', 'idle', 'svchost.exe', 'lsass.exe', 'wininit.exe', 'services.exe', 'spoolsv.exe',
  'smss.exe', 'csrss.exe', 'winlogon.exe', 'searchindexer.exe', 'msedge.exe', 'chrome.exe', 'firefox.exe']);
// No Mac (nome do executável, minúsculo): serviços do sistema e navegadores.
const SISTEMA_MAC = new Set(['launchd', 'rapportd', 'controlcenter', 'sharingd', 'identityservicesd', 'mdnsresponder',
  'airplayxpchelper', 'remoted', 'apsd', 'cupsd', 'sshd', 'screensharingd', 'universalcontrol', 'remotepairingd',
  'netbiosd', 'smbd', 'coreaudiod', 'webkit.networking', 'com.apple.webkit.networking', 'safari',
  'google chrome', 'google chrome helper', 'chromium', 'chromium helper', 'firefox', 'microsoft edge', 'microsoft edge helper', 'brave browser',
  'arc', 'spotify', 'dropbox']);

function responder(res, codigo, corpo) {
  if (res.headersSent) return;
  res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
}
function erro(status, msg, motivo) {
  const e = new Error(msg);
  e.status = status;
  if (motivo) e.motivo = motivo;
  return e;
}
const chavePasta = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();

// Endereço aceito pelo navegador interno: http ou https, até 2048 caracteres. Sem esquema, assume http://.
export function normalizarUrl(bruto) {
  if (typeof bruto !== 'string') return null;
  let s = bruto.trim();
  if (!s || s.length > MAX_URL || /[\u0000-\u001f]/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:/]+:\d/.test(s)) return null; // javascript:, file:, data:…
    s = 'http://' + s;
  }
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return u.href;
}
export function ehLocal(href) {
  try {
    const h = new URL(href).hostname.toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
  } catch { return false; }
}
// Endereço do próprio Orbit (auditoria P2-4): o iframe da página tem allow-scripts + allow-same-origin, então o
// Orbit embutido nele teria a API inteira. Local (ou 0.0.0.0) numa das portas do Orbit (a da página e a remota do
// celular), ou um dos hosts dele (o do Tailscale).
export function ehDoOrbit(href, { portas = [], hosts = [] } = {}) {
  let u;
  try { u = new URL(href); } catch { return false; }
  const h = u.hostname.toLowerCase();
  if (hosts.some((x) => x && String(x).toLowerCase() === h)) return true;
  const porta = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  return (ehLocal(href) || h === '0.0.0.0' || h === '[::]') && portas.some((p) => Number(p) === porta);
}

// frame-ancestors: a origem do Orbit (http://127.0.0.1:<porta>) cabe em alguma fonte?
function fonteAceita(fonte, porta) {
  const f = fonte.trim().toLowerCase();
  if (!f) return false;
  if (f === '*' || f === 'http:') return true;
  if (f.startsWith("'")) return false; // 'none', 'self' (a origem da página, nunca a do Orbit)
  const m = /^(?:(https?):\/\/)?([^/:]+)(?::(\d+|\*))?(?:\/.*)?$/.exec(f);
  if (!m) return false;
  const [, esquema, host, p] = m;
  if (esquema && esquema !== 'http') return false;
  const hostOk = host === '*' || host === '127.0.0.1';
  const portaOk = p === '*' || Number(p) === porta;
  return hostOk && portaOk;
}
// Lê os cabeçalhos de uma resposta e diz se o navegador vai recusar mostrá-la num iframe do Orbit.
export function bloqueioDeQuadro(cabecalhos, porta) {
  const csp = String(cabecalhos['content-security-policy'] || '');
  let temAncestrais = false;
  for (const politica of csp.split(',')) {
    for (const diretiva of politica.split(';')) {
      const partes = diretiva.trim().split(/\s+/);
      if ((partes[0] || '').toLowerCase() !== 'frame-ancestors') continue;
      temAncestrais = true;
      if (!partes.slice(1).some((f) => fonteAceita(f, porta))) return 'frame-ancestors';
    }
  }
  if (temAncestrais) return null; // com frame-ancestors, o navegador ignora o X-Frame-Options
  const xfo = String(cabecalhos['x-frame-options'] || '').toLowerCase();
  if (xfo.split(',').some((v) => v.trim() === 'deny' || v.trim() === 'sameorigin')) return 'x-frame-options';
  return null;
}

function motivoDeRede(e) {
  const c = (e && (e.cause && e.cause.code)) || (e && e.code) || '';
  if (e && e.name === 'AbortError') return 'sem-resposta';
  if (c === 'ECONNREFUSED' || c === 'ECONNRESET' || c === 'EADDRNOTAVAIL') return 'fora-do-ar';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'nao-encontrado';
  if (/CERT|SSL|TLS|SELF_SIGNED/i.test(c)) return 'certificado';
  if (c === 'UND_ERR_CONNECT_TIMEOUT' || c === 'ETIMEDOUT') return 'sem-resposta';
  return 'erro';
}

// Um GET que só lê os cabeçalhos (o corpo é descartado), sem seguir redirecionamento.
async function cabecalhosDe(href, tempo) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), tempo);
  try {
    const r = await fetch(href, {
      method: 'GET', redirect: 'manual', signal: ctl.signal,
      headers: { 'user-agent': AGENTE, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'sec-fetch-dest': 'iframe' },
    });
    const cab = {};
    r.headers.forEach((v, k) => { cab[k] = v; });
    try { await r.body?.cancel(); } catch {}
    return { status: r.status, cab };
  } finally {
    clearTimeout(t);
  }
}

// ───────── portas em uso no Mac: lsof + ps (separado para os testes, com saída falsa) ─────────
// Os dois viram o mesmo formato do Windows: { conexoes: [{ LocalAddress, LocalPort, OwningProcess }],
// processos: [{ ProcessId, ParentProcessId, Name, CommandLine }] }.

// `lsof +c 0 -nP -iTCP -sTCP:LISTEN`: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME (LISTEN).
// O lsof escreve espaço no nome do comando como \x20.
export function lerLsof(texto) {
  const conexoes = [];
  const nomes = new Map();
  for (const linha of String(texto || '').split(/\r?\n/)) {
    const t = linha.trim().split(/\s+/);
    if (t.length < 9 || t[0] === 'COMMAND' || !/^\(LISTEN\)$/i.test(t[t.length - 1])) continue;
    // Ancorado na coluna TYPE (… PID USER FD TYPE): vale mesmo se o nome do comando vier com espaço.
    const iTipo = t.findIndex((x) => x === 'IPv4' || x === 'IPv6');
    if (iTipo < 4) continue;
    const tipo = t[iTipo];
    const pid = Number(t[iTipo - 3]);
    if (!(pid > 0)) continue;
    const nome = t[t.length - 2];
    const m = /^(.*):(\d+)$/.exec(nome);
    if (!m) continue;
    let end = m[1].replace(/^\[(.*)\]$/, '$1');
    if (end === '*') end = tipo === 'IPv6' ? '::' : '0.0.0.0';
    conexoes.push({ LocalAddress: end, LocalPort: Number(m[2]), OwningProcess: pid });
    nomes.set(pid, t.slice(0, iTipo - 3).join(' ').replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))));
  }
  return { conexoes, nomes };
}

// `ps -A -ww -o pid=,ppid=,args=`: pid, pai e a linha de comando inteira.
export function lerPs(texto, nomes = new Map()) {
  const processos = [];
  for (const linha of String(texto || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(linha);
    if (!m) continue;
    const pid = Number(m[1]);
    const args = m[3].trim();
    // Nome: o do lsof (quem escuta); senão, o executável da linha (sem a pasta).
    const nome = nomes.get(pid) || path.posix.basename(args.split(/\s+/)[0] || '');
    processos.push({ ProcessId: pid, ParentProcessId: Number(m[2]), Name: nome, CommandLine: args });
  }
  return processos;
}

// rodar(cmd, args) → Promise<string | null> (null = falhou).
export async function lerPortasMac(rodar) {
  const lsof = await rodar('/usr/sbin/lsof', ['+c', '0', '-nP', '-iTCP', '-sTCP:LISTEN']);
  if (lsof == null) return null;
  const { conexoes, nomes } = lerLsof(lsof);
  if (!conexoes.length) return { conexoes, processos: [] };
  const ps = await rodar('/bin/ps', ['-A', '-ww', '-o', 'pid=,ppid=,args=']);
  if (ps == null) return null;
  return { conexoes, processos: lerPs(ps, nomes) };
}

function rodarComando(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, PATH: pathAmpliado() } }, (e, saida) => {
      // lsof sai com 1 quando nada escuta: vale a saída (vazia), não é erro.
      if (e && !(e.code === 1 && typeof saida === 'string')) return resolve(null);
      resolve(String(saida || ''));
    });
  });
}

export function criarNavegador(deps) {
  const {
    dados, porta = 47821, difundir = () => {}, lerJSONCorpo, log = () => {}, teste = false,
    enderecosOrbit = () => ({}), // { portas: [remota], hosts: [o do Tailscale] }; a `porta` sempre entra
    listarPortas = null, abrirFora = null, faixaPortas = [1024, 49152],
    so = SO, rodar = rodarComando, // os testes simulam o Mac com so: 'darwin' e um rodar falso (lsof/ps)
  } = deps;
  const MAC = so === 'darwin';
  const P = so === 'win32' ? path.win32 : path.posix;
  const sistema = MAC ? SISTEMA_MAC : SISTEMA;
  const arquivo = path.join(dados, 'previas.json');
  let previas = null; // Map chavePasta → { pasta, url, em }
  let fila = Promise.resolve();
  const abertosEmTeste = []; // servidor de teste: o "abrir fora" só registra
  let cachePortas = null; // { em, lista }

  function emFila(fn) {
    const p = fila.then(() => fn());
    fila = p.catch(() => {});
    return p;
  }
  async function carregar() {
    if (previas) return previas;
    const m = new Map();
    try {
      const j = JSON.parse(await fsp.readFile(arquivo, 'utf8'));
      for (const x of Object.values((j && j.previas) || {})) {
        const url = x && normalizarUrl(x.url);
        if (url && typeof x.pasta === 'string') m.set(chavePasta(x.pasta), { pasta: x.pasta, url, em: x.em || null });
      }
    } catch (e) {
      if (e.code !== 'ENOENT') log('navegador: previas.json ilegível, recomeçando', e?.message || e);
    }
    if (!previas) previas = m;
    return previas;
  }
  async function gravar() {
    await fsp.mkdir(dados, { recursive: true });
    const tmp = `${arquivo}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const corpo = { v: 1, previas: Object.fromEntries(previas) };
    await fsp.writeFile(tmp, JSON.stringify(corpo, null, 2) + '\n', 'utf8');
    await fsp.rename(tmp, arquivo);
  }
  const publicas = () => [...previas.values()].map((x) => ({ pasta: x.pasta, url: x.url }));

  function doOrbit(href) {
    let e = {};
    try { e = enderecosOrbit() || {}; } catch {}
    return ehDoOrbit(href, { portas: [porta, ...(e.portas || [])], hosts: e.hosts || [] });
  }
  const recusaOrbit = (href) => ({ estado: 'orbit', url: href, motivo: 'Este é o endereço do próprio Orbit.' });

  // ───────── conferir antes de abrir ─────────
  async function checar(bruto) {
    const href = normalizarUrl(bruto);
    if (!href) return { estado: 'invalido', motivo: 'Endereço inválido. Use http:// ou https://.' };
    if (doOrbit(href)) return recusaOrbit(href);
    let atual = href;
    try {
      for (let salto = 0; salto <= MAX_SALTOS; salto++) {
        const { status, cab } = await cabecalhosDe(atual, TEMPO_CHECAR);
        if (status >= 300 && status < 400 && cab.location) {
          const prox = normalizarUrl(new URL(cab.location, atual).href);
          if (!prox) return { estado: 'ok', url: href, final: atual, status, local: ehLocal(href) };
          if (doOrbit(prox)) return recusaOrbit(href); // um redirecionamento para o Orbit também não abre
          atual = prox;
          continue;
        }
        const bloqueio = bloqueioDeQuadro(cab, porta);
        if (bloqueio) return { estado: 'bloqueado', url: href, final: atual, status, bloqueio, local: ehLocal(href) };
        return { estado: 'ok', url: href, final: atual, status, local: ehLocal(href) };
      }
      return { estado: 'ok', url: href, final: atual, local: ehLocal(href), saltos: true };
    } catch (e) {
      return { estado: motivoDeRede(e), url: href, final: atual, local: ehLocal(href) };
    }
  }

  // ───────── abrir no navegador padrão ─────────
  function externo(bruto) {
    const href = normalizarUrl(bruto);
    if (!href) throw erro(400, 'Endereço inválido.', 'invalido');
    if (abrirFora) { abrirFora(href); return href; }
    if (teste) { abertosEmTeste.push(href); return href; }
    // Windows: url.dll recebe a URL como um argumento só (sem o cmd interpretar & e ^). Mac: open <url>.
    abrirExterno(href).catch((e) => log('navegador: abrir fora', e?.message || e));
    return href;
  }

  // ───────── portas locais em uso ─────────
  function lerPortasDoSistema() {
    if (MAC) return lerPortasMac(rodar);
    if (so !== 'win32') return Promise.resolve(null);
    return new Promise((resolve) => {
      const script = [
        '$ErrorActionPreference = "SilentlyContinue"',
        '$c = @(Get-NetTCPConnection -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess)',
        '$p = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine)',
        '[pscustomobject]@{ c = $c; p = $p } | ConvertTo-Json -Depth 3 -Compress',
      ].join('; ');
      let saida = '';
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
      const t = setTimeout(() => { try { ps.kill(); } catch {} }, 10000);
      ps.stdout.setEncoding('utf8');
      ps.stdout.on('data', (d) => { saida += d; });
      ps.on('error', () => { clearTimeout(t); resolve(null); });
      ps.on('close', () => {
        clearTimeout(t);
        try {
          const j = JSON.parse(saida);
          resolve({ conexoes: [].concat(j.c || []), processos: [].concat(j.p || []) });
        } catch { resolve(null); }
      });
    });
  }
  // A linha de comando cita a pasta? (a pasta inteira: D:\proj não casa com D:\proj2)
  function citaPasta(linha, pasta) {
    if (!linha || !pasta) return false;
    // Barras normais nos dois lados e sem diferenciar maiúsculas (o disco do Mac também não diferencia).
    const l = String(linha).toLowerCase().replace(/\\/g, '/');
    const p = P.resolve(String(pasta)).replace(/[\\/]+$/, '').toLowerCase().replace(/\\/g, '/');
    let i = l.indexOf(p);
    while (i >= 0) {
      const prox = l[i + p.length];
      if (prox === undefined || prox === '/' || prox === '"' || prox === "'" || prox === ' ') return true;
      i = l.indexOf(p, i + 1);
    }
    return false;
  }
  // pastas: as dos projetos; cada porta diz de qual projeto é (pasta) ou null.
  async function portas(pastas = []) {
    if (typeof pastas === 'string') pastas = pastas ? [pastas] : [];
    let base = cachePortas && Date.now() - cachePortas.em < CACHE_PORTAS ? cachePortas.lista : null;
    if (!base) {
      const sis = listarPortas ? await listarPortas() : await lerPortasDoSistema();
      if (!sis) return { portas: [], erro: 'Não deu para listar as portas em uso.' };
      const procs = new Map(sis.processos.map((p) => [Number(p.ProcessId), p]));
      const porPorta = new Map();
      for (const c of sis.conexoes) {
        const n = Number(c.LocalPort), pid = Number(c.OwningProcess);
        const end = String(c.LocalAddress || '');
        if (!(n >= faixaPortas[0] && n < faixaPortas[1]) || n === porta || pid === process.pid || pid <= 4) continue;
        const loop = end === '0.0.0.0' || end === '::' || end === '::1' || end.startsWith('127.');
        if (!loop) continue;
        const pr = procs.get(pid);
        const nome = String((pr && pr.Name) || '').toLowerCase();
        if (sistema.has(nome)) continue;
        const ant = porPorta.get(n) || { porta: n, pid, nome: (pr && pr.Name) || '', v4: false, v6: false, cadeia: [] };
        if (end === '::1' || end === '::') ant.v6 = true; else ant.v4 = true;
        if (!ant.cadeia.length) {
          // A própria linha e a de até 3 ancestrais (npm run dev → node vite.js).
          let q = pr, k = 0;
          while (q && k < 4) { if (q.CommandLine) ant.cadeia.push(String(q.CommandLine)); q = procs.get(Number(q.ParentProcessId)); k++; }
        }
        porPorta.set(n, ant);
      }
      // Só fica o que responde HTTP.
      const cand = [...porPorta.values()].sort((a, b) => a.porta - b.porta).slice(0, 40);
      const vivos = await Promise.all(cand.map(async (x) => {
        const url = `http://${x.v4 ? '127.0.0.1' : '[::1]'}:${x.porta}/`;
        try { await cabecalhosDe(url, TEMPO_PORTA); return x; } catch { return null; }
      }));
      base = vivos.filter(Boolean);
      cachePortas = { em: Date.now(), lista: base };
    }
    const lista = base.map((x) => {
      const pasta = pastas.find((p) => x.cadeia.some((l) => citaPasta(l, p))) || null;
      return { porta: x.porta, pid: x.pid, nome: x.nome, url: `http://localhost:${x.porta}/`, pasta, doProjeto: !!pasta };
    });
    lista.sort((a, b) => (b.doProjeto - a.doProjeto) || (a.porta - b.porta));
    return { portas: lista };
  }

  // ───────── rotas ─────────
  async function rota(req, res, r, url) {
    if (!r.startsWith('/navegador/')) return false;
    try {
      if (req.method === 'GET') {
        if (r === '/navegador/previas') { await carregar(); responder(res, 200, { previas: publicas() }); return true; }
        if (r === '/navegador/portas') {
          const pastas = url ? url.searchParams.getAll('pasta').filter((p) => p && p.length <= 1024).slice(0, 50) : [];
          responder(res, 200, await portas(pastas));
          return true;
        }
        if (r === '/navegador/abertos' && teste) { responder(res, 200, { abertos: abertosEmTeste }); return true; }
        return false;
      }
      if (req.method !== 'POST') return false;
      if (r === '/navegador/checar') {
        const corpo = await lerJSONCorpo(req);
        responder(res, 200, await checar(corpo && corpo.url));
        return true;
      }
      if (r === '/navegador/externo') {
        const corpo = await lerJSONCorpo(req);
        responder(res, 200, { ok: true, url: externo(corpo && corpo.url) });
        return true;
      }
      if (r === '/navegador/previa') {
        const corpo = await lerJSONCorpo(req);
        const pasta = corpo && corpo.pasta;
        if (typeof pasta !== 'string' || !pasta.trim() || pasta.length > 1024) throw erro(400, 'Falta a pasta do projeto.', 'pasta');
        const vazio = corpo.url == null || (typeof corpo.url === 'string' && !corpo.url.trim());
        const href = vazio ? null : normalizarUrl(corpo.url);
        if (!vazio && !href) throw erro(400, 'Endereço inválido. Use http:// ou https://.', 'invalido');
        if (href && doOrbit(href)) throw erro(400, 'Este é o endereço do próprio Orbit.', 'orbit');
        await emFila(async () => {
          await carregar();
          const k = chavePasta(pasta);
          if (href) previas.set(k, { pasta: path.resolve(pasta), url: href, em: new Date().toISOString() });
          else previas.delete(k);
          await gravar();
        });
        difundir('previas', { previas: publicas() });
        responder(res, 200, { ok: true, previas: publicas() });
        return true;
      }
      return false;
    } catch (e) {
      responder(res, e.status || 500, { erro: e.status ? e.message : 'Erro no navegador interno.', motivo: e.motivo || null });
      if (!e.status) log('navegador:', e?.message || e);
      return true;
    }
  }

  return { rota, checar, portas, externo };
}
