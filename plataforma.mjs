// Orbit — o que muda de um sistema para o outro (Windows e macOS; Linux como reserva).
// Decisão (16/10): o Orbit roda no PC e no Mac, sem caminho fixo do Windows nos módulos.
// Os módulos perguntam aqui onde ficam as coisas e como abrir um link ou uma pasta.
//
// Toda função aceita `o = { so, env, home }` para os testes simularem outro sistema sem trocar
// o process.platform. O padrão é a máquina atual.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFile } from 'node:child_process';

export const SO = process.platform;
export const WIN = SO === 'win32';
export const MAC = SO === 'darwin';

const opcoes = (o = {}) => ({ so: o.so || SO, env: o.env || process.env, home: o.home || os.homedir() });
// path do sistema simulado: num teste do Mac rodando no Windows, os caminhos saem com "/".
const caminho = (so) => (so === 'win32' ? path.win32 : path.posix);

// Dados locais do Orbit fora do projeto (token, cache da mídia). Nunca vão para o GitHub.
// Windows: %LOCALAPPDATA%\Orbit Public · Mac: ~/Library/Application Support/Orbit Public · Linux: ~/.local/share/Orbit Public
// Nome próprio desta cópia: nunca lê nem grava a pasta local de outro Orbit instalado na mesma conta.
export const NOME_LOCAL = 'Orbit Public';
export function pastaLocal(o) {
  const { so, env, home } = opcoes(o);
  const p = caminho(so);
  if (so === 'win32') return p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), NOME_LOCAL);
  if (so === 'darwin') return p.join(home, 'Library', 'Application Support', NOME_LOCAL);
  return p.join(env.XDG_DATA_HOME || p.join(home, '.local', 'share'), NOME_LOCAL);
}

// Pasta de configurações do usuário do VS Code (settings.json, temas escolhidos).
export function pastaUsuarioVSCode(o) {
  const { so, env, home } = opcoes(o);
  const p = caminho(so);
  if (so === 'win32') return p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'Code', 'User');
  if (so === 'darwin') return p.join(home, 'Library', 'Application Support', 'Code', 'User');
  return p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'Code', 'User');
}

// Pastas candidatas da instalação do VS Code: cada uma tem resources/app (Windows/Linux) ou
// Contents/Resources/app (Mac). Devolve só a pasta "app", que tem extensions/ e bin/.
export function appsVSCode(o) {
  const { so, env, home } = opcoes(o);
  const p = caminho(so);
  if (so === 'win32') {
    const bases = [env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Programs'), env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
    return [...new Set(bases.map((b) => p.join(b, 'Microsoft VS Code', 'resources', 'app')))];
  }
  if (so === 'darwin') {
    const padrao = ['/Applications', p.join(home, 'Applications')].map((b) => p.join(b, 'Visual Studio Code.app', 'Contents', 'Resources', 'app'));
    // Fora do lugar padrão (16/10: o VS Code do usuário está em ~/Downloads e o `code` não está no PATH): o `code`
    // do PATH ampliado (symlink resolvido até o .app) e o Spotlight pelo bundle id. Os dois só olham a máquina de
    // verdade: num sistema simulado (outro `so` ou `home`) só entram se o teste der `o.mdfind`.
    const real = so === SO && home === os.homedir();
    const extras = [];
    // Achou no lugar padrão: não procura mais (o mdfind é síncrono e o servidor pergunta a cada troca de tema).
    if ((real || o?.mdfind) && !padrao.some((a) => fs.existsSync(a))) {
      const cli = acharNoPath('code', o);
      if (cli) extras.push(appDoCli(cli));
      for (const app of (o?.mdfind || mdfindVSCode)()) extras.push(p.join(app, 'Contents', 'Resources', 'app'));
    }
    return [...new Set([...padrao, ...extras.filter(Boolean)])];
  }
  return ['/usr/share/code/resources/app', '/opt/visual-studio-code/resources/app', '/snap/code/current/usr/share/code/resources/app'];
}

// Mac: de .../Visual Studio Code.app/Contents/Resources/app/bin/code (ou um symlink para ele) à pasta "app".
function appDoCli(cli) {
  let real = cli;
  try { real = fs.realpathSync(cli); } catch {}
  const m = /^(.*?\.app)\/Contents\/Resources\/app\/bin\/code$/.exec(real);
  return m ? m[1] + '/Contents/Resources/app' : null;
}

// Mac: os VS Code que o Spotlight conhece (bundle id com.microsoft.VSCode), fora a Lixeira. Rápido (~0,1 s),
// com tempo limite de 3 s. Cache: o que achou vale enquanto existir; sem nada, pergunta de novo depois de 5 min.
let cacheMdfind = { quando: 0, apps: [] };
export function mdfindVSCode() {
  if (cacheMdfind.apps.length && cacheMdfind.apps.every((a) => fs.existsSync(a))) return cacheMdfind.apps;
  if (!cacheMdfind.apps.length && Date.now() - cacheMdfind.quando < 5 * 60 * 1000) return cacheMdfind.apps;
  let apps = [];
  try {
    const r = spawnSync('/usr/bin/mdfind', ["kMDItemCFBundleIdentifier == 'com.microsoft.VSCode'"], { encoding: 'utf8', timeout: 3000 });
    apps = String(r.stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.app') && !l.includes('/.Trash/'));
  } catch {}
  cacheMdfind = { quando: Date.now(), apps };
  return apps;
}

// O comando `code` do VS Code fora do PATH (no Mac, o launchd sobe o Orbit com um PATH mínimo).
export function codeCli(o) {
  const { so } = opcoes(o);
  const p = caminho(so);
  if (so === 'win32') return null; // no Windows o Orbit acha o Code.exe pelo registro e pelo PATH (servidor.mjs)
  for (const app of appsVSCode(o)) {
    const c = p.join(app, 'bin', 'code');
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// Pastas extras que o PATH do Orbit precisa no Mac: o launchd e o Finder sobem os processos só com
// /usr/bin:/bin:/usr/sbin:/sbin, sem o Homebrew nem o ~/.local/bin do Claude Code.
export function pastasExtrasPath(o) {
  const { so, home } = opcoes(o);
  if (so === 'win32') return [];
  const p = caminho(so);
  return ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', p.join(home, '.local', 'bin'), p.join(home, '.npm-global', 'bin')];
}

// PATH ampliado (sem repetir pastas), para pôr no env dos processos filhos e na busca de executáveis.
export function pathAmpliado(o) {
  const { so, env } = opcoes(o);
  const sep = so === 'win32' ? ';' : ':';
  const atual = String(env.PATH || env.Path || '').split(sep).filter(Boolean);
  return [...new Set([...atual, ...pastasExtrasPath(o)])].join(sep);
}

// Procura um executável no PATH ampliado. `nome` sem extensão; no Windows tenta .exe e .cmd.
export function acharNoPath(nome, o) {
  const { so } = opcoes(o);
  const p = caminho(so);
  const sep = so === 'win32' ? ';' : ':';
  const exts = so === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const d of pathAmpliado(o).split(sep)) {
    const dir = d.replace(/^"|"$/g, '');
    for (const e of exts) {
      const c = p.join(dir, nome + e);
      try {
        if (fs.statSync(c).isFile()) return c;
      } catch {}
    }
  }
  return null;
}

// Onde o git costuma estar quando não está no PATH.
export function gitsPadrao(o) {
  const { so, env } = opcoes(o);
  if (so === 'win32') {
    const p = path.win32;
    return [env.ProgramW6432, env.ProgramFiles, 'C:\\Program Files'].filter(Boolean).map((b) => p.join(b, 'Git', 'cmd', 'git.exe'));
  }
  return ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'];
}

// Raiz do disco do sistema (para o espaço livre).
export function raizDisco(o) {
  const { so, env } = opcoes(o);
  return so === 'win32' ? `${(env.SystemDrive || 'C:').replace(/\\?$/, '')}\\` : '/';
}

// Comando que abre um link ou arquivo no programa padrão do sistema: { cmd, args }.
export function comandoAbrir(alvo, o) {
  const { so } = opcoes(o);
  if (so === 'win32') return { cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', String(alvo)] };
  if (so === 'darwin') return { cmd: '/usr/bin/open', args: [String(alvo)] };
  return { cmd: 'xdg-open', args: [String(alvo)] };
}

// Comando que mostra um arquivo selecionado no Explorer/Finder: { cmd, args, verbatim }.
export function comandoMostrar(abs, o) {
  const { so } = opcoes(o);
  if (so === 'win32') return { cmd: 'explorer.exe', args: [`/select,"${abs}"`], verbatim: true };
  if (so === 'darwin') return { cmd: '/usr/bin/open', args: ['-R', String(abs)] };
  return { cmd: 'xdg-open', args: [caminho(so).dirname(String(abs))] };
}

// Comando que abre a própria pasta (por dentro) no Explorer/Finder: { cmd, args, verbatim }.
export function comandoAbrirPasta(abs, o) {
  const { so } = opcoes(o);
  if (so === 'win32') return { cmd: 'explorer.exe', args: [`"${abs}"`], verbatim: true };
  if (so === 'darwin') return { cmd: '/usr/bin/open', args: [String(abs)] };
  return { cmd: 'xdg-open', args: [String(abs)] };
}

// Roda um comando destacado, sem janela, e esquece. Devolve uma Promise que rejeita se não abriu.
export function soltar({ cmd, args, verbatim }) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: !!verbatim });
    } catch (e) {
      return reject(e);
    }
    p.once('error', reject);
    p.once('spawn', () => {
      p.unref();
      resolve();
    });
  });
}

export const abrirExterno = (alvo) => soltar(comandoAbrir(alvo));
export const mostrarNaPasta = (abs) => soltar(comandoMostrar(abs));
export const abrirPastaSO = (abs) => soltar(comandoAbrirPasta(abs));

// Lê "pid ppid" de todos os processos (macOS/Linux). Separado para os testes.
export function lerArvorePosix() {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-A', '-o', 'pid=,ppid='], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (e, out) => {
      if (e) return resolve([]);
      resolve(
        String(out)
          .split('\n')
          .map((l) => l.trim().split(/\s+/).map(Number))
          .filter(([a, b]) => a > 0 && b >= 0),
      );
    });
  });
}

// Descendentes de `pid` (sem ele), a partir da lista [pid, ppid].
export function descendentes(pid, pares) {
  const filhos = new Map();
  for (const [p, pp] of pares) {
    if (!filhos.has(pp)) filhos.set(pp, []);
    filhos.get(pp).push(p);
  }
  const out = [];
  const fila = [Number(pid)];
  const visto = new Set(fila);
  while (fila.length) {
    for (const f of filhos.get(fila.shift()) || []) {
      if (visto.has(f)) continue;
      visto.add(f);
      out.push(f);
      fila.push(f);
    }
  }
  return out;
}

// Mata o processo e toda a árvore dele. Windows: taskkill /T /F. Mac/Linux: SIGKILL nos
// descendentes (lidos antes) e no próprio pid. Sempre resolve (nunca rejeita).
export function matarArvore(pid, { timeout = 15000 } = {}) {
  pid = Number(pid);
  if (!(pid > 0)) return Promise.resolve();
  if (WIN) {
    const tk = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    return new Promise((resolve) => execFile(tk, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout }, () => resolve()));
  }
  return lerArvorePosix().then((pares) => {
    for (const p of [...descendentes(pid, pares).reverse(), pid]) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {}
    }
  });
}
