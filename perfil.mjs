// Orbit — perfil no pé da lateral e conta do GitHub vinculada.
//
// Rotas (o servidor.mjs só encaixa: criarPerfil(deps) e rota()):
//   GET  /perfil                       { nome, seguro, github: null | { login, nome, url, avatar, desde, verificado, expirado } }
//   GET  /perfil/avatar                avatar do GitHub guardado aqui (a página nunca fala com o GitHub)
//   POST /perfil/github                { token } → valida no GitHub, guarda cifrado e devolve o perfil
//   POST /perfil/github/verificar      reconfere o token (no máximo 1 vez a cada 10 min)
//   POST /perfil/github/desconectar    apaga o token, o perfil e o avatar guardados
// Toda mudança vai também pelo /fluxo (evento `perfil`), para as outras abas.
//
// O token:
//  - nunca fica em texto puro nem dentro da pasta do projeto.
//    Windows: cifrado pela DPAPI (escopo do usuário, com entropia própria) em <pastaLocal()>\github.token
//    (%LOCALAPPDATA%\Orbit Public): só este usuário do Windows, nesta máquina, consegue abrir.
//    Mac (16/10): no Chaveiro do usuário (/usr/bin/security, serviço "Orbit GitHub", conta = usuário do
//    sistema). NÃO TESTADO num Mac de verdade (só com o security trocado por um falso).
//  - nunca vai pela linha de comando (que aparece na lista de processos): entra e sai do PowerShell pelo
//    stdin/stdout; no Mac, vai no stdin do `security -i`;
//  - nunca volta para a página e nunca vai para o log.
// ORBIT_PERFIL_DIR e ORBIT_GITHUB_API existem para os testes (pasta e API falsas); `so`, `security` e
// `conta` em criarPerfil(deps) também (Mac simulado).
// Mac, servidor de teste (16/10, primeiro teste no Mac de verdade): o Chaveiro é um só por usuário, e um
// servidor de teste trocou o token real do usuário pelo falso do teste. Por isso, com GERENCIADOR_DADOS ou
// ORBIT_PERFIL_DIR (só os testes usam), o Chaveiro de verdade nunca é chamado: só o falso de ORBIT_SECURITY
// (`node <arquivo> <args>`); sem ele, o Chaveiro responde "desligado". E, sem ORBIT_PERFIL_DIR, o perfil do
// servidor de teste fica em <GERENCIADOR_DADOS>/perfil, nunca no github.json real.

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SO, pastaLocal } from './plataforma.mjs';

// Servidor de teste (GERENCIADOR_DADOS fora da pasta do Orbit, a mesma regra do servidor.mjs).
const DADOS_TESTE = process.env.GERENCIADOR_DADOS && path.resolve(process.env.GERENCIADOR_DADOS) !== path.dirname(fileURLToPath(import.meta.url))
  ? path.resolve(process.env.GERENCIADOR_DADOS) : '';
const PASTA = path.resolve(process.env.ORBIT_PERFIL_DIR || (SO === 'darwin' && DADOS_TESTE ? path.join(DADOS_TESTE, 'perfil') : pastaLocal()));
const ARQ_TOKEN = path.join(PASTA, 'github.token');
const ARQ_GITHUB = path.join(PASTA, 'github.json');
const ARQ_AVATAR = path.join(PASTA, 'github-avatar');
const API = String(process.env.ORBIT_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
const API_FALSA = !!process.env.ORBIT_GITHUB_API;
const ENTROPIA = 'Orbit.github.v1';
const MS_REDE = 10e3;
const MS_DPAPI = 20e3;
const MS_VERIFICAR = 10 * 60e3;
const MAX_AVATAR = 1024 * 1024;
const TOKEN = /^(?:gh[pousr]_[A-Za-z0-9]{20,251}|github_pat_[A-Za-z0-9_]{20,251})$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TIPOS_AVATAR = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const SERVICO_GITHUB = 'Orbit GitHub';
const MS_CHAVEIRO = 20e3;

// ───────────────────────── utilidades ─────────────────────────

function encurtar(t, max) {
  const s = String(t ?? '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function erroHttp(status, erro, codigo) {
  const e = new Error(erro);
  e.status = status;
  e.codigo = codigo;
  return e;
}

function responder(res, codigo, corpo) {
  if (res.headersSent) return;
  res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

async function gravar(arquivo, dados) {
  await fsp.mkdir(PASTA, { recursive: true });
  const tmp = `${arquivo}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, dados);
  await fsp.rename(tmp, arquivo);
}

// Nome de exibição da conta do Windows (o da tela de login); no Mac, o nome completo da conta (`id -F`, o
// mesmo da tela de login); sem ele, o nome de usuário.
let nomeCache = '';
export function nomeLocal(so) {
  if (nomeCache) return nomeCache;
  let nome = '';
  if (so === 'win32' && process.platform === 'win32') {
    try {
      const r = spawnSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Authentication\\LogonUI', '/v', 'LastLoggedOnDisplayName'],
        { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      nome = (/LastLoggedOnDisplayName\s+REG_SZ\s+(.+)/.exec(r.stdout || '') || [])[1]?.trim() || '';
    } catch {}
  } else if (so === 'darwin' && process.platform === 'darwin') {
    try {
      const r = spawnSync('/usr/bin/id', ['-F'], { encoding: 'utf8', timeout: 3000 });
      if (r.status === 0) nome = String(r.stdout || '').trim();
    } catch {}
  }
  if (!nome) {
    try { nome = os.userInfo().username; } catch {}
  }
  nomeCache = encurtar(nome || 'Você', 80);
  return nomeCache;
}

// ───────────────────────── DPAPI (Windows) ─────────────────────────

// A entropia é sempre uma constante do código (nunca texto de fora): entra direto no script.
const psPrep = (entropia) => `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$e=[Text.Encoding]::UTF8.GetBytes('${entropia}');$d=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());$s=[Security.Cryptography.DataProtectionScope]::CurrentUser;`;
const psCifrar = (entropia) => psPrep(entropia) + '[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($d,$e,$s)))';
const psDecifrar = (entropia) => psPrep(entropia) + '[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($d,$e,$s)))';

// Entrada e saída em base64: o stdin do PowerShell usa a página de código do console.
function dpapi(script, entradaB64) {
  if (process.platform !== 'win32') return Promise.reject(erroHttp(501, 'Guardar o token com segurança só funciona no Windows (DPAPI) e no macOS (Chaveiro).'));
  const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const p = spawn(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const prazo = setTimeout(() => { try { p.kill(); } catch {} }, MS_DPAPI);
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', (e) => { clearTimeout(prazo); reject(e); });
    p.on('close', (codigo) => {
      clearTimeout(prazo);
      const b64 = out.trim();
      if (codigo === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(b64)) resolve(b64);
      else reject(new Error(encurtar(err.trim() || `powershell saiu com ${codigo}`, 300)));
    });
    p.stdin.on('error', () => {});
    p.stdin.end(entradaB64);
  });
}

const cifrarTexto = (texto, entropia) => dpapi(psCifrar(entropia), Buffer.from(texto, 'utf8').toString('base64'));
const decifrarTexto = async (blob, entropia) => Buffer.from(await dpapi(psDecifrar(entropia), blob.trim()), 'base64').toString('utf8');
const cifrar = (token) => cifrarTexto(token, ENTROPIA);
const decifrar = (blob) => decifrarTexto(blob, ENTROPIA);

// ───────────────────────── Chaveiro (macOS) ─────────────────────────

// Roda o /usr/bin/security com `args` e `entrada` no stdin: { codigo, saida, erro }. É o único ponto que
// fala com o Chaveiro; os testes passam um falso em criarPerfil({ security }).
// Nos testes (GERENCIADOR_DADOS ou ORBIT_PERFIL_DIR), só o falso de ORBIT_SECURITY; nunca o Chaveiro real.
const SECURITY_FALSO = process.env.ORBIT_SECURITY || '';
const CHAVEIRO_DE_TESTE = !!(DADOS_TESTE || process.env.ORBIT_PERFIL_DIR);
export function rodarSecurity(args, entrada = '') {
  if (CHAVEIRO_DE_TESTE && !SECURITY_FALSO) return Promise.resolve({ codigo: 1, saida: '', erro: 'Chaveiro desligado no servidor de teste (sem ORBIT_SECURITY)' });
  return new Promise((resolve, reject) => {
    const [cmd, a] = SECURITY_FALSO ? [process.execPath, [SECURITY_FALSO, ...args]] : ['/usr/bin/security', args];
    const p = spawn(cmd, a, { stdio: ['pipe', 'pipe', 'pipe'] });
    let saida = '';
    let erro = '';
    const prazo = setTimeout(() => { try { p.kill(); } catch {} }, MS_CHAVEIRO);
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (c) => { saida += c; });
    p.stderr.on('data', (c) => { erro += c; });
    p.on('error', (e) => { clearTimeout(prazo); reject(e); });
    p.on('close', (codigo) => { clearTimeout(prazo); resolve({ codigo, saida, erro }); });
    p.stdin.on('error', () => {});
    p.stdin.end(entrada);
  });
}

// Um argumento numa linha do `security -i` (separa por espaço; entre aspas duplas aceita \" e \\).
// Quebra de linha encerraria o comando: recusa.
export function aspasSecurity(s) {
  const t = String(s);
  if (/[\r\n\0]/.test(t)) throw new Error('quebra de linha num argumento do security');
  return '"' + t.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function chaveiro(security, conta, SERVICO_CHAVEIRO = SERVICO_GITHUB) {
  const falhou = (r) => new Error(encurtar(String(r?.erro || '').trim() || `security saiu com ${r?.codigo}`, 300));
  const ler = async () => {
    const r = await security(['find-generic-password', '-a', conta, '-s', SERVICO_CHAVEIRO, '-w']);
    if (r.codigo !== 0) throw falhou(r);
    return String(r.saida || '').replace(/\r?\n$/, '');
  };
  return {
    // -U troca a senha se o item já existe. O token vai só no stdin; depois confere lendo de volta
    // (o `security -i` nem sempre põe no código de saída a falha do comando).
    async guardar(token) {
      const linha = ['add-generic-password', '-U', '-a', aspasSecurity(conta), '-s', aspasSecurity(SERVICO_CHAVEIRO), '-l', aspasSecurity(SERVICO_CHAVEIRO), '-w', aspasSecurity(token)].join(' ');
      const r = await security(['-i'], linha + '\n');
      const lido = await ler().catch(() => '');
      if (lido !== token) {
        const e = falhou(r);
        e.message = e.message.split(token).join('[token]'); // se o security ecoar a linha, o token não vai para o log
        throw e;
      }
    },
    ler,
    // Só os atributos (sem -w): não abre o segredo, não pede permissão. false só com "não existe" (44).
    existe: async () => (await security(['find-generic-password', '-a', conta, '-s', SERVICO_CHAVEIRO])).codigo !== 44,
    // Sem o item (código 44), não é erro.
    apagar: () => security(['delete-generic-password', '-a', conta, '-s', SERVICO_CHAVEIRO]).catch(() => null),
  };
}

// Cofre de um texto para outros módulos (17/10: as chaves das Conexões MCP, mcp.mjs), com a mesma proteção do
// token do GitHub: Windows, cifrado pela DPAPI em `arquivo` (fora do projeto); Mac, no Chaveiro, no serviço
// `servico`. ler() devolve '' quando ainda não há nada guardado. O texto nunca vai para o log.
export function criarCofreTexto({ arquivo, entropia, servico, so = SO, security = rodarSecurity, conta } = {}) {
  if (so === 'darwin') {
    const kc = chaveiro(security, conta || (() => { try { return os.userInfo().username; } catch { return 'orbit'; } })(), servico);
    return {
      ler: async () => {
        try { return await kc.ler(); } catch (e) {
          if (!(await kc.existe().catch(() => true))) return '';
          throw e;
        }
      },
      guardar: (texto) => kc.guardar(texto),
      apagar: () => kc.apagar(),
    };
  }
  return {
    ler: async () => {
      let blob;
      try { blob = await fsp.readFile(arquivo, 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') return '';
        throw e;
      }
      return blob.trim() ? decifrarTexto(blob, entropia) : '';
    },
    guardar: async (texto) => {
      const c = await cifrarTexto(texto, entropia);
      await fsp.mkdir(path.dirname(arquivo), { recursive: true });
      const tmp = `${arquivo}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, c);
      await fsp.rename(tmp, arquivo);
    },
    apagar: () => fsp.rm(arquivo, { force: true }),
  };
}

// ───────────────────────── GitHub ─────────────────────────

async function consultarUsuario(token) {
  let r;
  try {
    r = await fetch(API + '/user', {
      headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + token, 'user-agent': 'Orbit', 'x-github-api-version': '2022-11-28' },
      redirect: 'error',
      signal: AbortSignal.timeout(MS_REDE),
    });
  } catch {
    throw erroHttp(502, 'Não consegui falar com o GitHub. Confira a internet e tente de novo.', 'rede');
  }
  if (r.status === 401) throw erroHttp(422, 'O GitHub recusou este token. Confira se ele foi copiado inteiro e se ainda vale.', 'token-recusado');
  if (r.status === 403 || r.status === 429) throw erroHttp(502, 'O GitHub limitou os pedidos agora. Tente de novo em alguns minutos.', 'rede');
  if (!r.ok) throw erroHttp(502, `O GitHub respondeu ${r.status}. Tente de novo.`, 'rede');
  const u = await r.json().catch(() => null);
  if (!u || typeof u.login !== 'string' || !LOGIN.test(u.login)) throw erroHttp(502, 'O GitHub mandou uma resposta inesperada.', 'rede');
  return {
    id: Number(u.id) || null,
    login: u.login,
    nome: typeof u.name === 'string' ? encurtar(u.name.trim(), 80) : '',
    avatarUrl: typeof u.avatar_url === 'string' ? u.avatar_url : '',
  };
}

// Só o host de avatares do GitHub (ou a API falsa dos testes). O token nunca vai junto.
function urlDoAvatar(bruta) {
  let u;
  try { u = new URL(bruta); } catch { return null; }
  const doGitHub = u.protocol === 'https:' && (u.hostname === 'githubusercontent.com' || u.hostname.endsWith('.githubusercontent.com'));
  if (!doGitHub && !(API_FALSA && u.origin === new URL(API).origin)) return null;
  u.searchParams.set('s', '96');
  return u;
}

async function baixarAvatar(bruta) {
  const u = urlDoAvatar(bruta);
  if (!u) return null;
  try {
    const r = await fetch(u, { headers: { 'user-agent': 'Orbit' }, signal: AbortSignal.timeout(MS_REDE) });
    const tipo = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!r.ok || !TIPOS_AVATAR.has(tipo)) return null;
    const dados = Buffer.from(await r.arrayBuffer());
    return dados.length && dados.length <= MAX_AVATAR ? { dados, tipo } : null;
  } catch {
    return null;
  }
}

// ───────────────────────── perfil ─────────────────────────

export function criarPerfil(deps) {
  const { lerJSONCorpo, difundir = () => {}, log = () => {}, so = SO, security = rodarSecurity } = deps;
  const MAC = so === 'darwin';
  const nomeDoSistema = MAC ? 'Mac (Chaveiro)' : 'Windows';
  const usuario = deps.conta || (() => { try { return os.userInfo().username; } catch { return 'orbit'; } })();
  const kc = MAC ? chaveiro(security, usuario, SERVICO_GITHUB) : null;

  // Onde o token fica: Windows, cifrado em github.token; Mac, no Chaveiro (nada no disco).
  // guardar() prepara (cifra, ou grava no Chaveiro) e devolve o passo que fecha a gravação.
  const cofre = MAC
    ? {
        existe: () => true, // o Chaveiro responde na hora de ler; sem o item, a conta fica "expirada"
        guardar: async (t) => { await kc.guardar(t); return async () => {}; },
        ler: () => kc.ler(),
        apagar: () => Promise.all([kc.apagar(), fsp.rm(ARQ_TOKEN, { force: true })]),
      }
    : {
        existe: () => fs.existsSync(ARQ_TOKEN),
        guardar: async (t) => { const c = await cifrar(t); return () => gravar(ARQ_TOKEN, c); },
        ler: async () => decifrar(await fsp.readFile(ARQ_TOKEN, 'utf8')),
        apagar: () => fsp.rm(ARQ_TOKEN, { force: true }),
      };

  let gh = null; // { id, login, nome, avatarUrl, avatarTipo, avatarVersao, desde, verificado, expirado }
  let avatar = null; // Buffer em memória, lido do disco na primeira vez
  try {
    const salvo = JSON.parse(fs.readFileSync(ARQ_GITHUB, 'utf8'));
    if (salvo && typeof salvo.login === 'string' && LOGIN.test(salvo.login) && cofre.existe()) gh = salvo;
  } catch {}
  // Mac: o mesmo que o Windows faz sem o github.token (conta desconectada, github.json fica): sem o item
  // no Chaveiro, gh volta a null. A conferência é assíncrona; GET /perfil, token() e a fila esperam por ela.
  // Erro do Chaveiro (trancado, sem resposta) não é "não existe": a conta fica e expira no verificar.
  let pronto = null;
  if (MAC && gh) {
    const doDisco = gh;
    pronto = kc.existe().then((tem) => {
      if (!tem && gh === doDisco) { gh = null; log('perfil: o token não está no Chaveiro; conta desconectada'); avisar(); }
    }, () => {}).finally(() => { pronto = null; });
  }

  // Uma operação de cada vez (conectar, verificar, desconectar).
  let fila = pronto || Promise.resolve();
  function emFila(fn) {
    const p = fila.then(() => fn());
    fila = p.catch(() => {});
    return p;
  }

  function publico() {
    return {
      nome: (typeof deps.nome === 'function' && deps.nome()) || nomeLocal(so), // o do assistente da primeira vez, se houver
      seguro: so === 'win32' || MAC,
      ...(MAC ? { guardado: 'chaveiro' } : {}), // Mac: a página diz "no Chaveiro deste Mac" (no Windows, sem o campo)
      github: gh && {
        login: gh.login,
        nome: gh.nome || '',
        url: 'https://github.com/' + gh.login,
        avatar: gh.avatarTipo ? `/perfil/avatar?v=${gh.avatarVersao || 0}` : null,
        desde: gh.desde || null,
        verificado: gh.verificado || null,
        expirado: !!gh.expirado,
      },
    };
  }

  const salvarGh = () => gravar(ARQ_GITHUB, JSON.stringify(gh, null, 2));
  const avisar = () => difundir('perfil', publico());

  async function trocarAvatar(url) {
    const av = await baixarAvatar(url);
    if (!av) return;
    await gravar(ARQ_AVATAR, av.dados);
    avatar = av.dados;
    gh.avatarTipo = av.tipo;
    gh.avatarVersao = Date.now();
  }

  async function conectar(bruto) {
    const token = typeof bruto === 'string' ? bruto.trim() : '';
    if (!TOKEN.test(token)) throw erroHttp(400, 'Isso não parece um token do GitHub. Ele começa com github_pat_ ou ghp_.');
    const u = await consultarUsuario(token);
    let fecharGravacao;
    try {
      fecharGravacao = await cofre.guardar(token);
    } catch (e) {
      if (e.status) throw e;
      log(`perfil: ${MAC ? 'Chaveiro (guardar)' : 'DPAPI (cifrar)'} falhou:`, e?.message || e);
      throw erroHttp(500, `Não consegui guardar o token com segurança neste ${nomeDoSistema}. Nada foi salvo.`);
    }
    const agora = Date.now();
    const antes = gh;
    gh = { id: u.id, login: u.login, nome: u.nome, avatarUrl: u.avatarUrl, avatarTipo: '', avatarVersao: 0, desde: agora, verificado: agora, expirado: false };
    try {
      await fecharGravacao();
      await trocarAvatar(u.avatarUrl);
      if (!gh.avatarTipo) { avatar = null; await fsp.rm(ARQ_AVATAR, { force: true }); }
      await salvarGh();
    } catch (e) {
      gh = antes;
      throw e;
    }
    tokenMem = null;
    log('perfil: GitHub conectado como', u.login);
    avisar();
    return publico();
  }

  async function verificar(forcar) {
    if (!gh || (!forcar && Date.now() - (gh.verificado || 0) < MS_VERIFICAR)) return publico();
    const antes = JSON.stringify(publico());
    gh.verificado = Date.now();
    let token = '';
    try {
      token = await cofre.ler();
    } catch (e) {
      // Sem o arquivo (ou o item do Chaveiro), ou cifrado por outro usuário/máquina: precisa conectar de novo.
      log('perfil: o token guardado não abriu:', e?.message || e);
    }
    if (!TOKEN.test(token)) gh.expirado = true;
    else {
      try {
        const u = await consultarUsuario(token);
        const trocouAvatar = u.avatarUrl !== gh.avatarUrl || !gh.avatarTipo;
        Object.assign(gh, { id: u.id, login: u.login, nome: u.nome, avatarUrl: u.avatarUrl, expirado: false });
        if (trocouAvatar) await trocarAvatar(u.avatarUrl);
      } catch (e) {
        if (e.codigo === 'token-recusado') gh.expirado = true;
        // Rede ou limite do GitHub: fica como estava e tenta na próxima.
      }
    }
    await salvarGh().catch((e) => log('perfil: gravar github.json:', e?.message || e));
    if (JSON.stringify(publico()) !== antes) avisar();
    return publico();
  }

  // Para o repos.mjs (rodada 7), só dentro do servidor: o token decifrado fica em memória por até
  // 10 min (a DPAPI passa pelo PowerShell e leva ~0,5 s; o Chaveiro, pelo security). Nunca vai para a página nem para o log.
  let tokenMem = null; // { token, ate, login }
  async function token() {
    if (pronto) await pronto;
    if (!gh || gh.expirado) return null;
    if (tokenMem && tokenMem.login === gh.login && tokenMem.ate > Date.now()) return tokenMem.token;
    let t = '';
    try {
      t = await cofre.ler();
    } catch (e) {
      log('perfil: o token guardado não abriu:', e?.message || e);
    }
    if (!TOKEN.test(t)) return null;
    tokenMem = { token: t, ate: Date.now() + MS_VERIFICAR, login: gh.login };
    return t;
  }
  // Mac: enquanto o Chaveiro não confirma que o item existe (`pronto`), a conta não aparece para os outros módulos.
  const conta = () => (!pronto && gh && !gh.expirado ? { id: gh.id || null, login: gh.login, nome: gh.nome || '' } : null);

  async function desconectar() {
    const login = gh?.login;
    gh = null;
    avatar = null;
    tokenMem = null;
    await Promise.all([cofre.apagar(), ...[ARQ_GITHUB, ARQ_AVATAR].map((a) => fsp.rm(a, { force: true }))]);
    if (login) log('perfil: GitHub desconectado de', login);
    avisar();
    return publico();
  }

  async function rota(req, res, caminho) {
    if (caminho !== '/perfil' && !caminho.startsWith('/perfil/')) return false;
    if (req.method === 'GET') {
      if (caminho === '/perfil') {
        if (pronto) await pronto;
        responder(res, 200, publico());
        return true;
      }
      if (caminho === '/perfil/avatar') {
        if (gh?.avatarTipo && !avatar) avatar = await fsp.readFile(ARQ_AVATAR).catch(() => null);
        if (!gh?.avatarTipo || !avatar) {
          responder(res, 404, { erro: 'sem avatar' });
          return true;
        }
        // A URL muda (?v=) quando o avatar muda.
        res.writeHead(200, { 'content-type': gh.avatarTipo, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
        res.end(avatar);
        return true;
      }
      return false;
    }
    if (req.method !== 'POST') return false;
    if (caminho === '/perfil/github') {
      const b = await lerJSONCorpo(req);
      responder(res, 200, await emFila(() => conectar(b?.token)));
      return true;
    }
    if (caminho === '/perfil/github/verificar') {
      const b = await lerJSONCorpo(req);
      responder(res, 200, await emFila(() => verificar(b?.forcar === true)));
      return true;
    }
    if (caminho === '/perfil/github/desconectar') {
      responder(res, 200, await emFila(() => desconectar()));
      return true;
    }
    return false;
  }

  return { rota, publico, token, conta, verificar: () => emFila(() => verificar(true)) };
}
