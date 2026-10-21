// Terminal integrado: shells reais (PTY) que vivem no servidor e falam com a página por WebSocket.
//
// Os processos seguem rodando com o painel minimizado, ao trocar de tela e no F5: a página reconecta e
// recebe a lista e os últimos 256 KB de saída de cada terminal (replay). Nada vai para o disco, salvo a
// pasta temporária da integração do zsh (apagada no parar()).
//
// Segurança: o WebSocket não passa por CORS, então o upgrade confere sozinho Host, Origin (presente e
// exato), bilhete de uso único (30 s, POST /terminal/bilhete) e a versão 13. O cliente manda só o id do
// shell (da lista daqui) e o nome do projeto (da lista do servidor); nunca caminho de executável ou pasta.
//
// O servidor de WebSocket é escrito à mão (RFC 6455, sem dependência): quadros de texto com JSON,
// fragmentação, ping/pong e close. Quadro acima de 1 MB fecha com 1009; quadro sem máscara, com 1002.
//
// Integração com o shell: o prompt emite a marca ESC ]6973;P;<cwd> BEL (ou ESC \). Ela sai da saída e do
// buffer e diz que o comando acabou (ocupado = false) e qual a pasta atual. Enter com o shell livre liga
// o ocupado. Sem marca nenhuma, ocupado fica sempre false.
//
// Rotas: GET /terminal/shells · GET /terminal/lista · GET /terminal/vendor/<arquivo> ·
// POST /terminal/bilhete · GET /terminal/ws?bilhete=… (Upgrade). Protocolo e Meta: descritos abaixo.

import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathAmpliado, matarArvore as matarArvorePlat } from './plataforma.mjs';

// Sem o node-pty (pacote ausente ou binário quebrado), criarTerminal lança e o servidor segue sem terminal.
let pty = null;
let erroPty = null;
try {
  pty = (await import('@lydell/node-pty')).default;
} catch (e) {
  erroPty = e;
}

const WIN = process.platform === 'win32';

// node-pty 1.1.0 no Windows: o pty.kill() faz fork do conpty_console_list_agent para listar os processos do
// console. Como o Orbit já matou a árvore (matarArvore, abaixo), ele cai com "AttachConsole failed" no stderr,
// sem efeito (o node-pty libera o console depois de 5 s). Esse fork sai com o stderr num pipe: a mensagem é
// descartada e qualquer outra saída segue para o stderr do servidor.
const AGENTE_LISTA = /conpty_console_list_agent(.js)?$/;
export function silenciarListaDoConsole(cp = childProcess) {
  const original = cp.fork;
  if (original.orbitSilencia) return;
  const fork = function (modulo, args, opcoes) {
    if (!AGENTE_LISTA.test(String(modulo))) return original.apply(this, arguments);
    if (!Array.isArray(args)) [args, opcoes] = [[], args];
    const filho = original.call(this, modulo, args, { ...(opcoes || {}), silent: true });
    let erro = '';
    filho.stdout?.pipe(process.stdout, { end: false });
    filho.stderr?.setEncoding('utf8');
    filho.stderr?.on('data', (d) => { if (erro.length < 64 * 1024) erro += d; });
    filho.on('close', () => {
      if (erro && !/AttachConsole failed/.test(erro)) try { process.stderr.write(erro); } catch {}
    });
    return filho;
  };
  fork.orbitSilencia = true;
  cp.fork = fork;
}
if (WIN && pty) silenciarListaDoConsole();
const PASTA = path.dirname(fileURLToPath(import.meta.url));
const MAX_TERMINAIS = 16;
const MAX_BUFFER = 256 * 1024; // replay por terminal (unidades UTF-16, ≈ KB de texto)
const MAX_QUADRO = 1024 * 1024;
const AGRUPAR_MS = 8;
const ESPERA_RESTO_MS = 150; // marca partida: quanto esperar o resto antes de soltar como veio
const VALIDADE_BILHETE = 30000;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const VENDOR = {
  'xterm.js': ['@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8'],
  'xterm.css': ['@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'],
  'addon-fit.js': ['@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8'],
  'addon-web-links.js': ['@xterm/addon-web-links/lib/addon-web-links.js', 'text/javascript; charset=utf-8'],
  'addon-unicode11.js': ['@xterm/addon-unicode11/lib/addon-unicode11.js', 'text/javascript; charset=utf-8'],
};

function responder(res, codigo, corpo) {
  if (res.headersSent) return;
  res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

const ehArquivo = (f) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};
const ehPasta = (p) => {
  try {
    return typeof p === 'string' && !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// Mac/Linux: o PATH ampliado (o launchd sobe o Orbit sem o Homebrew no PATH).
function noPath(nome) {
  for (const d of String(WIN ? process.env.PATH || '' : pathAmpliado()).split(path.delimiter)) {
    if (!d) continue;
    const f = path.join(d.replace(/^"|"$/g, ''), nome);
    if (ehArquivo(f)) return f;
  }
  return null;
}

// ---------- shells ----------

// { id, nome, curto, exe, tipo: 'powershell'|'cmd'|'bash'|'zsh'|null, gitBash }
function detectarShells() {
  const lista = [];
  if (WIN) {
    const raiz = process.env.SystemRoot || 'C:\\Windows';
    const pfs = [...new Set([process.env.ProgramW6432, process.env.ProgramFiles, 'C:\\Program Files'].filter(Boolean))];
    let pwsh = noPath('pwsh.exe');
    for (const pf of pfs) {
      if (pwsh) break;
      const base = path.join(pf, 'PowerShell');
      let versoes = [];
      try {
        versoes = fs.readdirSync(base).sort().reverse();
      } catch {}
      for (const v of versoes) {
        const f = path.join(base, v, 'pwsh.exe');
        if (ehArquivo(f)) {
          pwsh = f;
          break;
        }
      }
    }
    if (pwsh) lista.push({ id: 'pwsh', nome: 'PowerShell 7', curto: 'PowerShell', exe: pwsh, tipo: 'powershell' });
    const ps = path.join(raiz, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    lista.push({ id: 'powershell', nome: 'Windows PowerShell', curto: 'PowerShell', exe: ehArquivo(ps) ? ps : noPath('powershell.exe') || 'powershell.exe', tipo: 'powershell' });
    lista.push({ id: 'cmd', nome: 'Prompt de Comando', curto: 'CMD', exe: process.env.ComSpec || path.join(raiz, 'System32', 'cmd.exe'), tipo: 'cmd' });
    // Git Bash: nunca o bash.exe do System32 (é o WSL).
    const cands = pfs.map((pf) => path.join(pf, 'Git', 'bin', 'bash.exe'));
    const git = noPath('git.exe');
    if (git) cands.push(path.resolve(path.dirname(git), '..', 'bin', 'bash.exe'), path.resolve(path.dirname(git), '..', '..', 'bin', 'bash.exe'));
    const bash = cands.find(ehArquivo);
    if (bash) lista.push({ id: 'bash', nome: 'Git Bash', curto: 'Git Bash', exe: bash, tipo: 'bash', gitBash: true });
  } else {
    let doUsuario = process.env.SHELL;
    if (!doUsuario) {
      try {
        doUsuario = os.userInfo().shell; // o launchd nem sempre passa o SHELL
      } catch {}
    }
    const real = (f) => {
      try {
        return fs.realpathSync(f);
      } catch {
        return f;
      }
    };
    lista.push(...shellsPosix({ shell: doUsuario, existe: ehArquivo, achar: noPath, real }));
  }
  const padrao = WIN ? (lista.find((s) => s.id === 'pwsh') || lista.find((s) => s.id === 'powershell')) : lista[0];
  for (const s of lista) s.padrao = s === padrao;
  return lista;
}

// Mac/Linux: o shell do usuário (SHELL ou o da conta) primeiro e, se existirem e forem outros, bash e zsh
// (do PATH ampliado ou de /bin). Puro para os testes: `existe`, `achar` e `real` entram de fora.
function shellsPosix({ shell, existe, achar, real = (f) => f }) {
  const sh = shell && existe(shell) ? shell : existe('/bin/zsh') ? '/bin/zsh' : '/bin/sh';
  const base = path.posix.basename(sh);
  const tipoDe = (b) => (b === 'bash' ? 'bash' : b === 'zsh' ? 'zsh' : null);
  const lista = [{ id: 'padrao', nome: base, curto: base, exe: sh, tipo: tipoDe(base) }];
  for (const nome of ['bash', 'zsh']) {
    const f = achar(nome) || (existe(`/bin/${nome}`) ? `/bin/${nome}` : null);
    if (f && real(f) !== real(sh) && base !== nome) lista.push({ id: nome, nome, curto: nome, exe: f, tipo: nome });
  }
  return lista;
}

// PowerShell: embrulha o prompt que existir depois do perfil (o -EncodedCommand roda depois dele).
const SCRIPT_PS = [
  'if (-not $global:__orbitP) { $global:__orbitP = $function:prompt }',
  'function global:prompt {',
  '  $__c = $executionContext.SessionState.Path.CurrentLocation.ProviderPath',
  '  "$([char]27)]6973;P;$__c$([char]7)" + (& $global:__orbitP)',
  '}',
].join('\n');

const MARCA_SH = "printf '\\033]6973;P;%s\\007' \"$PWD\"";
// Git Bash: o pwd -W do MSYS dá o caminho do Windows (C:/x), inclusive nos pontos de montagem (/tmp).
const MARCA_GIT_BASH = "printf '\\033]6973;P;%s\\007' \"$(pwd -W 2>/dev/null || pwd)\"";

// process.env sem as variáveis do Orbit, do VS Code e do Claude Code.
function ambienteBase() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    const K = k.toUpperCase();
    if (K === 'ELECTRON_RUN_AS_NODE' || K === 'CLAUDECODE' || K.startsWith('VSCODE_') || K.startsWith('CLAUDE_CODE_') || K.startsWith('GERENCIADOR_')) continue;
    env[k] = v;
  }
  por(env, 'TERM_PROGRAM', 'orbit');
  por(env, 'COLORTERM', 'truecolor');
  por(env, 'ORBIT_TERMINAL', '1');
  if (!WIN) {
    por(env, 'TERM', 'xterm-256color');
    por(env, 'PATH', pathAmpliado()); // o shell de login do Mac ainda passa pelo path_helper e pelo .zprofile
  }
  return env;
}

// Argumentos de cada tipo de shell (sem o da integração do PowerShell). No Mac, bash e zsh abrem como
// shell de login, como no Terminal do macOS: o /etc/zprofile (path_helper) e o ~/.zprofile/~/.bash_profile
// (o Homebrew põe o PATH ali) rodam. No Linux, interativo sem login, como os terminais de lá.
function argsDoShell(s, so = process.platform) {
  if (s.tipo === 'bash') return s.gitBash || so === 'darwin' ? ['--login', '-i'] : ['-i'];
  if (s.tipo === 'zsh') return so === 'darwin' ? ['-l', '-i'] : ['-i'];
  if (s.tipo === null && so === 'darwin') return ['-l']; // sh, fish, ksh…: todos aceitam -l
  return [];
}

// No Windows o nome da variável não diferencia maiúsculas: troca qualquer grafia.
function por(env, k, v) {
  for (const x of Object.keys(env)) if (x.toUpperCase() === k.toUpperCase()) delete env[x];
  env[k] = v;
}
function ler(env, k) {
  const x = Object.keys(env).find((x) => x.toUpperCase() === k.toUpperCase());
  return x ? env[x] : undefined;
}

// Git Bash: C:/x → C:\x e, se vier do $PWD, /d/Dev → D:\Dev.
function caminhoGitBash(p) {
  if (/^[a-zA-Z]:\//.test(p)) return p.replace(/\//g, '\\');
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:${(m[2] || '\\').replace(/\//g, '\\')}` : p;
}

// ---------- filtro da saída ----------

const RE_MARCA = /\x1b\]6973;P;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const RE_TITULO = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const RE_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{1,5}(?:\/[^\s'"<>`\\]*)?/gi;

// Onde começa um fim incompleto que pode ser a marca partida: OSC sem terminador ou ESC solto no fim.
function inicioIncompleto(s) {
  const o = s.lastIndexOf('\x1b]');
  if (o >= 0 && s.length - o <= 4096 && !/\x07|\x1b\\/.test(s.slice(o + 2))) return o;
  return s.endsWith('\x1b') ? s.length - 1 : -1;
}

// Pedaço novo → peças na ordem: textos (string) e marcas ({ cwd }). Guarda em f.resto o fim incompleto;
// com forcar, solta o resto como veio.
function filtrar(f, d, forcar = false) {
  let s = f.resto + d;
  f.resto = '';
  if (!forcar) {
    const i = inicioIncompleto(s);
    if (i >= 0) {
      f.resto = s.slice(i);
      s = s.slice(0, i);
    }
  }
  const pecas = [];
  let i = 0;
  let m;
  RE_MARCA.lastIndex = 0;
  while ((m = RE_MARCA.exec(s))) {
    if (m.index > i) pecas.push(s.slice(i, m.index));
    pecas.push({ cwd: m[1] });
    i = m.index + m[0].length;
  }
  if (i < s.length) pecas.push(s.slice(i));
  return pecas;
}

// Fim da sequência de escape que começa em e (ou e, se não der para saber).
function fimEscape(b, e) {
  const x = b[e + 1];
  if (x === '[') {
    const m = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(b.slice(e, e + 256));
    return m ? e + m[0].length : e;
  }
  if (x === ']' || x === 'P' || x === '_' || x === '^') {
    const re = /\x07|\x1b\\/g;
    re.lastIndex = e + 2;
    const m = re.exec(b);
    return m ? m.index + m[0].length : e;
  }
  return e + 2;
}

// Últimos `limite` caracteres, cortados de preferência logo após uma quebra de linha; senão fora de
// sequência de escape e sem partir par UTF-16.
function aparar(b, limite = MAX_BUFFER) {
  if (b.length <= limite) return b;
  let c = b.length - limite;
  const nl = b.indexOf('\n', c);
  if (nl >= 0 && nl - c < 16384) return b.slice(nl + 1);
  const e = b.lastIndexOf('\x1b', c);
  if (e >= 0 && c - e < 4096) {
    const fim = fimEscape(b, e);
    if (fim > c) c = fim;
  }
  const k = b.charCodeAt(c);
  if (k >= 0xdc00 && k <= 0xdfff) c++;
  return b.slice(c);
}

// Texto visível para achar URLs: cor some; movimento de cursor vira quebra (o ConPTY redesenha a tela
// com posicionamento em vez de \n).
function semAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*([@-~])/g, (_, f) => (f === 'm' ? '' : '\n'))
    .replace(/\x1b[@-_]/g, '');
}

// ---------- WebSocket (RFC 6455) ----------

function quadro(op, dados) {
  const n = dados.length;
  let cab;
  if (n < 126) {
    cab = Buffer.alloc(2);
    cab[1] = n;
  } else if (n < 65536) {
    cab = Buffer.alloc(4);
    cab[1] = 126;
    cab.writeUInt16BE(n, 2);
  } else {
    cab = Buffer.alloc(10);
    cab[1] = 127;
    cab.writeUInt32BE(Math.floor(n / 2 ** 32), 2);
    cab.writeUInt32BE(n >>> 0, 6);
  }
  cab[0] = 0x80 | op;
  return Buffer.concat([cab, dados]);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

export function criarTerminal(deps) {
  if (!pty) throw new Error('node-pty indisponível: ' + (erroPty?.message || 'sem o pacote @lydell/node-pty'));
  const { porta, projetos = () => [], log = () => {} } = deps;
  const hostsOk = [`127.0.0.1:${porta}`, `localhost:${porta}`];
  const origensOk = [`http://127.0.0.1:${porta}`, `http://localhost:${porta}`];

  let shellsCache = null;
  const shells = () => (shellsCache ||= detectarShells());

  const terminais = new Map(); // id → t
  const conexoes = new Set();
  let bilhetes = []; // { buf, vence }
  let seq = 0;
  let parado = false;
  let pastaZsh = null;

  // ---------- difusão ----------

  function enviarBruto(c, q) {
    if (c.fechado || c.socket.destroyed) return;
    // Página travada que não lê: não acumula memória sem fim.
    if (c.socket.writableLength > 32 * MAX_QUADRO) return c.socket.destroy();
    try {
      c.socket.write(q);
    } catch {}
  }
  const enviar = (c, obj) => enviarBruto(c, quadro(1, Buffer.from(JSON.stringify(obj))));
  function difundir(obj) {
    if (!conexoes.size) return;
    const q = quadro(1, Buffer.from(JSON.stringify(obj)));
    for (const c of conexoes) enviarBruto(c, q);
  }

  // ---------- terminais ----------

  const meta = (t) => ({
    id: t.id,
    nome: t.nome,
    shell: t.shell.id,
    shellNome: t.shell.nome,
    projeto: t.projeto,
    cwd: t.cwd,
    pid: t.pid,
    vivo: t.vivo,
    codigo: t.codigo,
    ocupado: t.ocupado,
    desde: t.desde,
    integracao: t.integracao,
    titulo: t.titulo,
    urls: t.urls.slice(),
    criado: t.criado,
  });

  function nomeLivre(base) {
    const usados = new Set([...terminais.values()].map((t) => t.nome));
    if (!usados.has(base)) return base;
    for (let n = 2; ; n++) if (!usados.has(`${base} ${n}`)) return `${base} ${n}`;
  }

  function prepararZsh() {
    if (pastaZsh && ehPasta(pastaZsh)) return pastaZsh;
    pastaZsh = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-zsh-'));
    const usuario = '"${ORBIT_ZDOTDIR:-$HOME}"';
    fs.writeFileSync(
      path.join(pastaZsh, '.zshenv'),
      ['__orbit_z="$ZDOTDIR"', `ZDOTDIR=${usuario}`, '[[ -f "$ZDOTDIR/.zshenv" ]] && . "$ZDOTDIR/.zshenv"', 'ZDOTDIR="$__orbit_z"', ''].join('\n'),
    );
    // Shell de login (Mac): o .zprofile do usuário roda antes do .zshrc (o Homebrew põe o PATH ali). O
    // .zlogin vem depois do .zshrc, que já devolveu o ZDOTDIR do usuário: o zsh o acha sozinho.
    fs.writeFileSync(
      path.join(pastaZsh, '.zprofile'),
      ['__orbit_z="$ZDOTDIR"', `ZDOTDIR=${usuario}`, '[[ -f "$ZDOTDIR/.zprofile" ]] && . "$ZDOTDIR/.zprofile"', 'ZDOTDIR="$__orbit_z"', ''].join('\n'),
    );
    fs.writeFileSync(
      path.join(pastaZsh, '.zshrc'),
      [
        `ZDOTDIR=${usuario}`,
        '[[ -f "$ZDOTDIR/.zshrc" ]] && . "$ZDOTDIR/.zshrc"',
        `__orbit_precmd() { ${MARCA_SH}; }`,
        'precmd_functions+=(__orbit_precmd)',
        'unset ORBIT_ZDOTDIR __orbit_z',
        '',
      ].join('\n'),
    );
    return pastaZsh;
  }

  // Executável, argumentos e ambiente de cada tipo de shell, com a integração.
  function comando(s) {
    const env = ambienteBase();
    let args = argsDoShell(s);
    if (s.tipo === 'powershell') {
      args = ['-NoLogo', '-NoExit', '-EncodedCommand', Buffer.from(SCRIPT_PS, 'utf16le').toString('base64')];
    } else if (s.tipo === 'cmd') {
      por(env, 'PROMPT', '$e]6973;P;$p$e\\$p$g');
    } else if (s.tipo === 'bash') {
      const antes = ler(env, 'PROMPT_COMMAND');
      const marca = s.gitBash ? MARCA_GIT_BASH : MARCA_SH;
      por(env, 'PROMPT_COMMAND', antes ? `${antes}\n${marca}` : marca);
    } else if (s.tipo === 'zsh') {
      por(env, 'ORBIT_ZDOTDIR', process.env.ZDOTDIR || os.homedir());
      por(env, 'ZDOTDIR', prepararZsh());
    }
    return { exe: s.exe, args, env };
  }

  // Abre (ou reabre) o processo do terminal t. Lança com mensagem para o usuário.
  function iniciar(t) {
    const { exe, args, env } = comando(t.shell);
    // Mac/Linux: o PWD herdado é a pasta do servidor; com o da pasta do terminal, o zsh e o bash mantêm o
    // caminho como foi escolhido (sem trocar um link como /tmp por /private/tmp) no prompt e na marca.
    if (!WIN) por(env, 'PWD', t.pasta);
    let proc;
    try {
      proc = pty.spawn(exe, args, { name: 'xterm-256color', cols: t.cols, rows: t.rows, cwd: t.pasta, env, useConpty: true });
    } catch (e) {
      throw new Error(`Não deu para abrir o ${t.shell.nome}: ${e?.message || e}`);
    }
    // No Windows o pid só chega quando o ConPTY conecta (antes do primeiro dado): vai num meta depois.
    Object.assign(t, { proc, pid: proc.pid || null, vivo: true, codigo: null, ocupado: false, desde: null, integracao: false, titulo: '', urls: [], linha: '' });
    t.filtro = { resto: '' };
    // Sem ouvinte de 'error', o node-pty relança erro do pipe e derruba o processo.
    proc.on('error', (e) => log(`terminal: erro no pty de ${t.nome}: ${e?.message || e}`));
    proc.onData((d) => {
      if (t.proc !== proc || t.removido) return;
      if (!t.pid && proc.pid) {
        t.pid = proc.pid;
        t.metaMudou = true;
      }
      receberSaida(t, d);
    });
    proc.onExit(({ exitCode }) => {
      if (t.proc !== proc || t.removido) return;
      clearTimeout(t.timerResto);
      if (t.filtro.resto) aplicar(t, filtrar(t.filtro, '', true));
      despejar(t);
      Object.assign(t, { vivo: false, codigo: exitCode ?? null, ocupado: false, desde: null, urls: [] });
      log(`terminal: ${t.nome} saiu (código ${t.codigo})`);
      difundir({ t: 'meta', term: meta(t) });
      difundir({ t: 'saiu', id: t.id, codigo: t.codigo });
    });
    log(`terminal: ${t.nome} aberto (${t.shell.nome}, ${t.pasta})`);
  }

  function receberSaida(t, d) {
    clearTimeout(t.timerResto);
    aplicar(t, filtrar(t.filtro, d));
    // Marca partida: espera o resto um pouco; se não vier, solta como veio.
    if (t.filtro.resto) {
      t.timerResto = setTimeout(() => {
        if (t.filtro.resto && !t.removido) aplicar(t, filtrar(t.filtro, '', true));
      }, ESPERA_RESTO_MS);
    }
  }

  function aplicar(t, pecas) {
    for (const p of pecas) {
      if (typeof p === 'string') {
        t.pendente += p;
        olhar(t, p);
      } else {
        const cwd = t.shell.gitBash ? caminhoGitBash(p.cwd) : p.cwd;
        if (cwd && cwd !== t.cwd) t.cwd = cwd;
        Object.assign(t, { ocupado: false, desde: null, integracao: true, urls: [] });
        t.metaMudou = true;
      }
    }
    if (!t.timer && (t.pendente || t.metaMudou)) t.timer = setTimeout(() => despejar(t), AGRUPAR_MS);
  }

  // Título (OSC 0/2) e URLs locais. URL só conta com comando rodando (ou sem integração): com o shell
  // livre, o texto é o prompt e o que a pessoa digita.
  function olhar(t, s) {
    RE_TITULO.lastIndex = 0;
    let m;
    let titulo = null;
    while ((m = RE_TITULO.exec(s))) titulo = m[1];
    if (titulo !== null && titulo !== t.titulo) {
      t.titulo = titulo;
      t.metaMudou = true;
    }
    t.linha += semAnsi(s);
    const linhas = t.linha.split(/\r\n|\n|\r/);
    t.linha = linhas.pop().slice(-1024);
    if (t.integracao && !t.ocupado) return;
    for (const l of linhas) {
      RE_URL.lastIndex = 0;
      while ((m = RE_URL.exec(l))) {
        const url = m[0].replace(/[.,;:!?)\]]+$/, '').replace(/^(https?:\/\/)0\.0\.0\.0/i, '$1localhost');
        if (t.urls[0] === url) continue;
        t.urls = [url, ...t.urls.filter((u) => u !== url)].slice(0, 3);
        t.metaMudou = true;
      }
    }
  }

  function despejar(t) {
    clearTimeout(t.timer);
    t.timer = null;
    if (t.pendente) {
      const d = t.pendente;
      t.pendente = '';
      t.buffer += d;
      if (t.buffer.length > MAX_BUFFER * 1.125) t.buffer = aparar(t.buffer);
      difundir({ t: 'saida', id: t.id, d });
    }
    if (t.metaMudou) {
      t.metaMudou = false;
      difundir({ t: 'meta', term: meta(t) });
    }
  }

  // Mata a árvore do processo (plataforma.matarArvore: taskkill /T /F no Windows; no Mac/Linux, SIGKILL nos
  // descendentes lidos pelo ps e no shell) antes do pty.kill(): com a raiz já morta, a árvore não acha os
  // filhos (o node de um npm run dev). No máximo 3 s. Devolve uma promessa que resolve quando acabou.
  function matarArvore(proc) {
    const pid = proc?.pid;
    const fim = () => {
      try {
        proc.kill();
      } catch {}
    };
    if (!pid) {
      fim();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let feito = false;
      const pronto = () => {
        if (feito) return;
        feito = true;
        clearTimeout(limite);
        fim();
        resolve();
      };
      const limite = setTimeout(pronto, 3000);
      matarArvorePlat(pid).then(pronto, pronto);
    });
  }

  function remover(t) {
    t.removido = true;
    clearTimeout(t.timer);
    clearTimeout(t.timerResto);
    terminais.delete(t.id);
    return t.vivo ? matarArvore(t.proc) : Promise.resolve();
  }

  // ---------- mensagens ----------

  const limitar = (v, min, max, padrao) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : padrao);

  function criar(c, msg) {
    const ref = msg.ref;
    if (terminais.size >= MAX_TERMINAIS) return enviar(c, { t: 'erro', ref, msg: `Limite de ${MAX_TERMINAIS} terminais. Feche um para abrir outro.` });
    const lista = shells();
    const s = msg.shell == null || msg.shell === '' ? lista.find((x) => x.padrao) : lista.find((x) => x.id === msg.shell);
    if (!s) return enviar(c, { t: 'erro', ref, msg: 'Esse shell não está disponível nesta máquina.' });
    let projeto = null;
    let pasta = os.homedir();
    if (typeof msg.projeto === 'string' && msg.projeto) {
      let lista = [];
      try {
        lista = projetos() || [];
      } catch {}
      const p = lista.find((x) => x && x.nome === msg.projeto);
      if (p && ehPasta(p.pasta)) {
        projeto = p.nome;
        pasta = p.pasta;
      }
    }
    const pedido = typeof msg.nome === 'string' ? msg.nome.trim().slice(0, 40) : '';
    const t = {
      id: 't' + ++seq,
      nome: pedido || nomeLivre(s.curto),
      shell: s,
      projeto,
      pasta,
      cwd: pasta,
      cols: limitar(msg.cols, 2, 500, 80),
      rows: limitar(msg.rows, 1, 300, 24),
      criado: Date.now(),
      buffer: '',
      pendente: '',
      metaMudou: false,
      timer: null,
      timerResto: null,
    };
    try {
      iniciar(t);
    } catch (e) {
      log(`terminal: ${e.message}`);
      return enviar(c, { t: 'erro', ref, msg: e.message });
    }
    terminais.set(t.id, t);
    difundir({ t: 'criado', ref, term: meta(t) });
  }

  function mensagem(c, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'ping') return enviar(c, { t: 'pong' });
    if (msg.t === 'criar') return criar(c, msg);
    const t = terminais.get(msg.id);
    if (!t) {
      if (['renomear', 'reiniciar', 'fechar'].includes(msg.t)) enviar(c, { t: 'erro', id: msg.id, msg: 'Esse terminal não existe mais.' });
      return;
    }
    switch (msg.t) {
      case 'entrada':
        if (!t.vivo || typeof msg.d !== 'string' || !msg.d) return;
        if (msg.d.includes('\r') && !t.ocupado && t.integracao) {
          t.ocupado = true;
          t.desde = Date.now();
          difundir({ t: 'meta', term: meta(t) });
        }
        try {
          t.proc.write(msg.d);
        } catch {}
        return;
      case 'tamanho':
        t.cols = limitar(msg.cols, 2, 500, t.cols);
        t.rows = limitar(msg.rows, 1, 300, t.rows);
        if (t.vivo) {
          try {
            t.proc.resize(t.cols, t.rows);
          } catch {}
        }
        return;
      case 'renomear': {
        const nome = typeof msg.nome === 'string' ? msg.nome.trim() : '';
        if (!nome || nome.length > 40) return enviar(c, { t: 'erro', id: t.id, msg: 'O nome precisa ter de 1 a 40 caracteres.' });
        if (nome !== t.nome) {
          t.nome = nome;
          difundir({ t: 'meta', term: meta(t) });
        }
        return;
      }
      case 'reiniciar':
        if (t.vivo) return;
        try {
          iniciar(t);
        } catch (e) {
          log(`terminal: ${e.message}`);
          return enviar(c, { t: 'erro', id: t.id, msg: e.message });
        }
        difundir({ t: 'meta', term: meta(t) });
        return;
      case 'fechar':
        remover(t);
        log(`terminal: ${t.nome} fechado`);
        difundir({ t: 'removido', id: t.id });
        return;
    }
  }

  // ---------- conexões ----------

  function fecharConexao(c, codigo) {
    if (c.fechado) return;
    c.fechado = true;
    conexoes.delete(c);
    try {
      const corpo = Buffer.alloc(2);
      corpo.writeUInt16BE(codigo, 0);
      c.socket.end(quadro(8, corpo));
    } catch {}
    setTimeout(() => c.socket.destroy(), 2000).unref();
  }

  function receberDados(c, dados) {
    c.buf = c.buf.length ? Buffer.concat([c.buf, dados]) : dados;
    while (!c.fechado) {
      const b = c.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const rsv = b[0] & 0x70;
      const op = b[0] & 0x0f;
      const mascarado = (b[1] & 0x80) !== 0;
      let tam = b[1] & 0x7f;
      let pos = 2;
      if (tam === 126) {
        if (b.length < 4) return;
        tam = b.readUInt16BE(2);
        pos = 4;
      } else if (tam === 127) {
        if (b.length < 10) return;
        if (b.readUInt32BE(2) !== 0) return fecharConexao(c, 1009);
        tam = b.readUInt32BE(6);
        pos = 10;
      }
      if (rsv || !mascarado) return fecharConexao(c, 1002);
      const controle = op >= 8;
      if (controle && (!fin || tam > 125)) return fecharConexao(c, 1002);
      // O tamanho já se sabe pelo cabeçalho: recusa antes de juntar o corpo.
      if (tam > MAX_QUADRO || (op === 0 && c.fragTam + tam > MAX_QUADRO)) return fecharConexao(c, 1009);
      if (b.length < pos + 4 + tam) return;
      const chave = b.subarray(pos, pos + 4);
      pos += 4;
      const corpo = Buffer.from(b.subarray(pos, pos + tam));
      for (let i = 0; i < tam; i++) corpo[i] ^= chave[i & 3];
      c.buf = b.subarray(pos + tam);

      if (op === 8) {
        const codigo = corpo.length >= 2 ? corpo.readUInt16BE(0) : 1000;
        return fecharConexao(c, codigo >= 1000 && codigo < 5000 && ![1004, 1005, 1006, 1015].includes(codigo) ? codigo : 1000);
      }
      if (op === 9) {
        enviarBruto(c, quadro(10, corpo));
        continue;
      }
      if (op === 10) continue;
      if (op === 1 || op === 2) {
        if (c.frag) return fecharConexao(c, 1002);
        if (fin) mensagemBruta(c, op, corpo);
        else {
          c.frag = [corpo];
          c.fragOp = op;
          c.fragTam = tam;
        }
        continue;
      }
      if (op === 0) {
        if (!c.frag) return fecharConexao(c, 1002);
        c.frag.push(corpo);
        c.fragTam += tam;
        if (fin) {
          const tudo = Buffer.concat(c.frag);
          const opIni = c.fragOp;
          c.frag = null;
          c.fragTam = 0;
          mensagemBruta(c, opIni, tudo);
        }
        continue;
      }
      return fecharConexao(c, 1002);
    }
  }

  function mensagemBruta(c, op, corpo) {
    if (op !== 1) return; // binário: o protocolo é só texto
    let texto;
    try {
      texto = utf8.decode(corpo);
    } catch {
      return fecharConexao(c, 1007);
    }
    let msg;
    try {
      msg = JSON.parse(texto);
    } catch {
      return; // JSON inválido é ignorado
    }
    try {
      mensagem(c, msg);
    } catch (e) {
      log(`terminal: erro na mensagem ${msg?.t}: ${e?.message || e}`);
    }
  }

  // ---------- bilhetes ----------

  // deps.validadeBilhete: só para o teste encurtar.
  const validadeBilhete = () => (Number(deps.validadeBilhete) > 0 ? Number(deps.validadeBilhete) : VALIDADE_BILHETE);

  function novoBilhete() {
    const agora = Date.now();
    const validade = validadeBilhete();
    const bilhete = crypto.randomBytes(32).toString('base64url');
    bilhetes = bilhetes.filter((b) => b.vence > agora).slice(-63);
    bilhetes.push({ buf: Buffer.from(bilhete), vence: agora + validade });
    return bilhete;
  }

  // Uso único: o bilhete apresentado sai da lista, valha ou não o resto do pedido.
  function consumirBilhete(texto) {
    if (typeof texto !== 'string' || texto.length !== 43) return false;
    const b = Buffer.from(texto);
    const agora = Date.now();
    let ok = false;
    bilhetes = bilhetes.filter((x) => {
      const igual = x.buf.length === b.length && crypto.timingSafeEqual(x.buf, b);
      if (igual) ok = x.vence > agora;
      return !igual && x.vence > agora;
    });
    return ok;
  }

  // ---------- API ----------

  async function rota(req, res, rota) {
    if (rota !== '/terminal' && !rota.startsWith('/terminal/')) return false;
    const r = (codigo, corpo) => {
      responder(res, codigo, corpo);
      return true;
    };
    if (rota === '/terminal/bilhete') {
      if (req.method !== 'POST') return r(405, { erro: 'use POST' });
      req.resume();
      return r(200, { bilhete: novoBilhete(), validade: validadeBilhete() });
    }
    if (req.method !== 'GET') return r(405, { erro: 'método não permitido' });
    if (rota === '/terminal/shells') {
      return r(200, { shells: shells().map((s) => ({ id: s.id, nome: s.nome, padrao: s.padrao })), plataforma: process.platform });
    }
    if (rota === '/terminal/lista') return r(200, { terminais: [...terminais.values()].map(meta) });
    if (rota.startsWith('/terminal/vendor/')) {
      const item = Object.hasOwn(VENDOR, rota.slice(17)) ? VENDOR[rota.slice(17)] : null;
      if (!item) return r(404, { erro: 'não encontrado' });
      try {
        const dados = await fsp.readFile(path.join(PASTA, 'node_modules', ...item[0].split('/')));
        if (!res.headersSent) {
          res.writeHead(200, { 'content-type': item[1], 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
          res.end(dados);
        }
      } catch {
        responder(res, 404, { erro: 'não encontrado' });
      }
      return true;
    }
    if (rota === '/terminal/ws') return r(426, { erro: 'precisa de WebSocket' });
    return r(404, { erro: 'não encontrado' });
  }

  function upgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      return false;
    }
    if (url.pathname !== '/terminal/ws') return false;
    socket.on('error', () => {});

    const h = req.headers;
    const bilheteOk = consumirBilhete(url.searchParams.get('bilhete')); // sempre consome
    const ok =
      !parado &&
      req.method === 'GET' &&
      hostsOk.includes(String(h.host || '').toLowerCase()) &&
      typeof h.origin === 'string' &&
      origensOk.includes(h.origin) &&
      /\bwebsocket\b/i.test(String(h.upgrade || '')) &&
      String(h['sec-websocket-version'] || '') === '13' &&
      /^[A-Za-z0-9+/]{21}[AQgw]==$/.test(String(h['sec-websocket-key'] || '')) &&
      bilheteOk;
    if (!ok) {
      try {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
      } catch {
        socket.destroy();
      }
      setTimeout(() => socket.destroy(), 1000).unref();
      return true;
    }

    const aceite = crypto.createHash('sha1').update(h['sec-websocket-key'] + GUID).digest('base64');
    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${aceite}\r\n\r\n`);

    const c = { socket, buf: Buffer.alloc(0), frag: null, fragOp: 0, fragTam: 0, fechado: false };
    // Quem já está conectado recebe o que estava agrupado; o novo começa do buffer (sem repetir).
    for (const t of terminais.values()) despejar(t);
    conexoes.add(c);
    enviar(c, { t: 'lista', terminais: [...terminais.values()].map(meta) });
    for (const t of terminais.values()) if (t.buffer) enviar(c, { t: 'saida', id: t.id, d: aparar(t.buffer), replay: true });

    socket.on('data', (d) => {
      try {
        receberDados(c, d);
      } catch (e) {
        log(`terminal: erro no WebSocket: ${e?.message || e}`);
        fecharConexao(c, 1011);
      }
    });
    const sair = () => {
      c.fechado = true;
      conexoes.delete(c);
    };
    socket.on('close', sair);
    socket.on('end', () => {
      sair();
      socket.destroy();
    });
    if (head && head.length) receberDados(c, Buffer.from(head));
    return true;
  }

  // Mata todos os terminais (com a árvore) e fecha as conexões. A promessa resolve quando os taskkill acabam.
  function parar() {
    parado = true;
    const esperas = [...terminais.values()].map(remover);
    for (const c of [...conexoes]) fecharConexao(c, 1001);
    if (pastaZsh) {
      try {
        fs.rmSync(pastaZsh, { recursive: true, force: true });
      } catch {}
      pastaZsh = null;
    }
    return Promise.all(esperas).then(() => {});
  }

  const rodando = () => [...terminais.values()].filter((t) => t.vivo && t.ocupado).length;

  return {
    rota,
    upgrade,
    parar,
    estado: () => ({ total: terminais.size, rodando: rodando() }),
    bloqueios: () => ({ rodando: rodando() }),
  };
}

// Só para os testes: peças puras do filtro da saída.
export const _teste = { filtrar, aparar, inicioIncompleto, caminhoGitBash, semAnsi, shellsPosix, argsDoShell };
