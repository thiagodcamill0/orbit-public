// Navegador headless dos testes de interface: onde ele está (por sistema) e como fechá-lo.
// Fecha um Edge headless de teste e apaga o perfil dele.
// O msedge.exe que o spawn abre repassa para outro processo, e nem kill() nem taskkill no pid
// alcançam a árvore. Em 15/10 os órfãos e os perfis (~170 MB cada) encheram o C: (87 GB).
// Uso: `spawn(caminhoNavegador(), [...])` e, no finally do teste, `await fecharEdge(portaCdp, perfil)`.
// As capturas ficam; o perfil sai.
// No Mac (16/10): Edge ou Chrome em /Applications ou ~/Applications; sem eles, o Chromium headless
// do Playwright (~/Library/Caches/ms-playwright/chromium_headless_shell-*). ORBIT_NAVEGADOR força um.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN = process.platform === 'win32';
const EDGE_WIN = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

// Pastas do Playwright, a de versão mais alta primeiro (chromium_headless_shell-1234 > -1100).
function doPlaywright(raiz, prefixo, rel) {
  let nomes = [];
  try { nomes = fs.readdirSync(raiz).filter((n) => n.startsWith(prefixo + '-')); } catch { return []; }
  nomes.sort((a, b) => (Number(b.slice(prefixo.length + 1)) || 0) - (Number(a.slice(prefixo.length + 1)) || 0));
  const saida = [];
  for (const n of nomes) for (const r of rel) saida.push(path.join(raiz, n, r));
  return saida;
}

export function candidatosNavegador(so = process.platform, env = process.env, home = os.homedir()) {
  if (so === 'win32') return [EDGE_WIN];
  const pw = env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0'
    ? env.PLAYWRIGHT_BROWSERS_PATH
    : (so === 'darwin' ? path.join(home, 'Library', 'Caches', 'ms-playwright') : path.join(home, '.cache', 'ms-playwright'));
  if (so === 'darwin') {
    const apps = [];
    for (const raiz of ['/Applications', path.join(home, 'Applications')]) {
      apps.push(path.join(raiz, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'));
      apps.push(path.join(raiz, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'));
      apps.push(path.join(raiz, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
    }
    return [...apps,
      ...doPlaywright(pw, 'chromium_headless_shell', ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell']),
      ...doPlaywright(pw, 'chromium', ['chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'])];
  }
  return ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    ...doPlaywright(pw, 'chromium_headless_shell', ['chrome-headless-shell-linux64/chrome-headless-shell']),
    ...doPlaywright(pw, 'chromium', ['chrome-linux/chrome'])];
}

// O executável do navegador dos testes. No Windows é sempre o Edge de sempre (o mesmo caminho).
export function caminhoNavegador() {
  if (process.env.ORBIT_NAVEGADOR) return process.env.ORBIT_NAVEGADOR;
  if (WIN) return EDGE_WIN;
  const c = candidatosNavegador();
  const achado = c.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!achado) throw new Error('nenhum navegador para os testes de interface (Edge, Chrome, Chromium ou o headless do Playwright: npx playwright install chromium-headless-shell); ou defina ORBIT_NAVEGADOR');
  return achado;
}

// Mac/Linux: os pids do navegador que usa ESTE perfil (conferido na linha de comando) e os filhos
// dele (gpu, rede, renderizadores não repetem o --user-data-dir). Nunca o navegador do usuário.
export function pidsDoPerfil(perfil, linhasPs) {
  const procs = [];
  for (const l of linhasPs.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    if (m) procs.push({ pid: +m[1], ppid: +m[2], cmd: m[3] });
  }
  const marca = '--user-data-dir=' + perfil;
  const raiz = new Set(procs.filter((p) => {
    const i = p.cmd.indexOf(marca);
    return i >= 0 && /^(\s|$|["'])/.test(p.cmd.slice(i + marca.length));
  }).map((p) => p.pid));
  const todos = new Set(raiz);
  for (let mudou = true; mudou;) {
    mudou = false;
    for (const p of procs) if (!todos.has(p.pid) && todos.has(p.ppid)) { todos.add(p.pid); mudou = true; }
  }
  todos.delete(process.pid);
  return [...todos];
}

export async function fecharEdge(portaCdp, perfil) {
  try {
    const v = await (await fetch(`http://127.0.0.1:${portaCdp}/json/version`)).json();
    const b = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((r, x) => { b.onopen = r; b.onerror = x; });
    b.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await dormir(1500);
  } catch {}
  if (WIN) {
    // Reserva: qualquer msedge que ainda use este perfil (só este; nunca o Edge do usuário).
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${perfil.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
    { stdio: 'ignore', windowsHide: true, timeout: 20000 });
  } else {
    // Reserva (Mac/Linux): por pid, só a árvore do navegador deste perfil.
    const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 10000 });
    for (const pid of pidsDoPerfil(perfil, ps.stdout || '')) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
  await dormir(800);
  try { fs.rmSync(perfil, { recursive: true, force: true }); } catch {}
  if (WIN) { try { limparTempNavegador(); } catch {} }
}

// Windows (21/10): o Edge de teste baixa componentes para o %TEMP% (<guid>.tmp com cabeçalho Cr24, ~70 MB) e
// cria scoped_dir<pid>_*; fechado à força, larga tudo lá (67 GB em uma semana). Apaga só o abandonado:
// scoped_dir cujo processo dono já não existe e <guid>.tmp Cr24 parado há mais de 30 min. O que um
// navegador vivo (de teste, do usuário ou o Brave) está usando fica.
const GUID_TMP = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

function pidsAtivos() {
  const r = spawnSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (r.status !== 0 || !r.stdout) return null;
  const pids = new Set();
  for (const l of r.stdout.split('\n')) { const m = /^"[^"]*","(\d+)"/.exec(l); if (m) pids.add(+m[1]); }
  return pids.size ? pids : null;
}

export function limparTempNavegador({ pasta = os.tmpdir(), pidsVivos = pidsAtivos(), agora = Date.now(), idadeMs = 30 * 60e3 } = {}) {
  const saida = { pastas: 0, arquivos: 0, bytes: 0 };
  let nomes = [];
  try { nomes = fs.readdirSync(pasta, { withFileTypes: true }); } catch { return saida; }
  for (const d of nomes) {
    const alvo = path.join(pasta, d.name);
    const dono = /^scoped_dir(\d+)_/.exec(d.name);
    if (d.isDirectory() && dono) {
      if (!pidsVivos || pidsVivos.has(+dono[1])) continue;   // sem lista de processos, não arrisca
      try { fs.rmSync(alvo, { recursive: true }); saida.pastas++; } catch {}
    } else if (d.isFile() && GUID_TMP.test(d.name)) {
      try {
        const st = fs.statSync(alvo);
        if (!st.size || agora - st.mtimeMs < idadeMs) continue;
        const cab = Buffer.alloc(4);
        const fd = fs.openSync(alvo, 'r');
        try { fs.readSync(fd, cab, 0, 4, 0); } finally { fs.closeSync(fd); }
        if (cab.toString('latin1') !== 'Cr24') continue;
        fs.unlinkSync(alvo); saida.arquivos++; saida.bytes += st.size;
      } catch {}
    }
  }
  return saida;
}
