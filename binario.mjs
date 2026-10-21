// Orbit — o claude.exe próprio do Orbit (decisão D2, 15/10: "Orbit sem VS Code").
// Copia o binário mais novo da máquina (extensão do VS Code ou instalação própria em ~/.local/bin)
// para bin/claude-<versão>.exe e guarda as 2 últimas versões. Assim as instâncias do Orbit não
// dependem da pasta da extensão (que some quando ela é atualizada ou removida). Nada global muda.
// Mac/Linux (16/10): fontes também no Homebrew (/opt/homebrew/bin), em /usr/local/bin, no npm global
// (~/.npm-global/bin, nvm) e no PATH ampliado. Só binário nativo (Mach-O/ELF/PE) é copiado; o `claude` do
// npm que é um script (#!/usr/bin/env node → cli.js) depende dos arquivos do pacote: roda no lugar, com o
// node do Orbit (o launchd não põe o node no PATH).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pastasExtrasPath, acharNoPath, pathAmpliado } from './plataforma.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';
export const BIN_DIR = path.resolve(process.env.ORBIT_BIN_DIR || path.join(PASTA, 'bin'));
const EXTENSOES_DIR = path.resolve(process.env.ORBIT_EXTENSOES_DIR || path.join(os.homedir(), '.vscode', 'extensions'));
const LOCAL_BIN = path.resolve(process.env.ORBIT_LOCAL_BIN || path.join(os.homedir(), '.local', 'bin', 'claude' + EXE));
const MANTER = 2;

const RE_EXT = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/;
const RE_COPIA = new RegExp(`^claude-(\\d+)\\.(\\d+)\\.(\\d+)${EXE.replace('.', '\\.')}$`);
const comparar = (a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]; // mais nova primeiro
const texto = (v) => v.join('.');

function lerDir(d) {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
}

// Cópias do Orbit em bin/, da mais nova para a mais velha.
export function copias() {
  return lerDir(BIN_DIR)
    .map((n) => ({ n, m: RE_COPIA.exec(n) }))
    .filter((x) => x.m)
    .map((x) => ({ versao: [+x.m[1], +x.m[2], +x.m[3]], caminho: path.join(BIN_DIR, x.n) }))
    .sort((a, b) => comparar(a.versao, b.versao));
}

function daExtensao() {
  return lerDir(EXTENSOES_DIR)
    .map((n) => ({ n, m: RE_EXT.exec(n) }))
    .filter((x) => x.m)
    .map((x) => ({ versao: [+x.m[1], +x.m[2], +x.m[3]], caminho: path.join(EXTENSOES_DIR, x.n, 'resources', 'native-binary', 'claude' + EXE), origem: 'extensão', tipo: 'nativo' }))
    .filter((x) => fs.existsSync(x.caminho))
    .sort((a, b) => comparar(a.versao, b.versao));
}

// Onde procurar o `claude` instalado na máquina (além da extensão), na ordem de preferência.
// Windows: só ~/.local/bin (como sempre foi). Mac/Linux: + Homebrew, /usr/local, npm global, nvm e PATH.
// `o = { so, home, env, localBin, nvm }` só para os testes.
export function candidatosClaude(o = {}) {
  const so = o.so || process.platform;
  const home = o.home || os.homedir();
  const env = o.env || process.env;
  const p = so === 'win32' ? path.win32 : path.posix;
  // O LOCAL_BIN (com o ORBIT_LOCAL_BIN dos testes) só quando é esta máquina e esta pasta pessoal; com
  // `o.home` de outra pessoa (teste no Mac), o ~/.local/bin dela.
  const local = so === process.platform && !o.home ? LOCAL_BIN : p.join(home, '.local', 'bin', so === 'win32' ? 'claude.exe' : 'claude');
  const lista = [o.localBin || local];
  if (so === 'win32') return lista;
  for (const d of pastasExtrasPath({ so, home, env })) lista.push(p.join(d, 'claude'));
  // nvm: o npm global de cada versão do node (o launchd não carrega o nvm).
  const nvm = o.nvm ?? lerDir(p.join(home, '.nvm', 'versions', 'node')).sort().reverse();
  for (const v of nvm) lista.push(p.join(home, '.nvm', 'versions', 'node', v, 'bin', 'claude'));
  const noPath = o.acharNoPath ? o.acharNoPath('claude') : acharNoPath('claude', { so, home, env });
  if (noPath) lista.push(noPath);
  return [...new Set(lista)];
}

// Primeiros bytes → 'nativo' (PE "MZ", ELF, Mach-O fino ou universal), 'script' ("#!") ou null.
export function tipoDoArquivo(buf) {
  if (!buf || buf.length < 2) return null;
  if (buf[0] === 0x23 && buf[1] === 0x21) return 'script';
  if (buf[0] === 0x4d && buf[1] === 0x5a) return 'nativo';
  if (buf.length >= 4) {
    const m = buf.readUInt32BE(0);
    if ([0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(m)) return 'nativo';
  }
  return null;
}

function tipoDe(caminho) {
  let fd;
  try {
    fd = fs.openSync(caminho, 'r');
    const b = Buffer.alloc(4);
    const n = fs.readSync(fd, b, 0, 4, 0);
    return tipoDoArquivo(b.subarray(0, n));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function caminhoReal(f) {
  try {
    return fs.realpathSync(f);
  } catch {
    return f;
  }
}

// Como rodar um claude da máquina: script → o node do Orbit com o arquivo real (cli.js); senão, direto.
export function comandoDe(fonte, node = process.execPath) {
  return fonte.tipo === 'script' ? { cmd: node, pre: [fonte.real || fonte.caminho] } : { cmd: fonte.caminho, pre: [] };
}

// `claude --version` → [a, b, c] ou null. Sem atualizar nada (DISABLE_AUTOUPDATER).
function versaoDoArquivo(exe, pre = []) {
  return new Promise((resolve) => {
    const env = { ...process.env, DISABLE_AUTOUPDATER: '1' };
    if (!WIN) env.PATH = pathAmpliado();
    execFile(exe, [...pre, '--version'], { windowsHide: true, timeout: 20000, env }, (err, out) => {
      const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(out || ''));
      resolve(!err && m ? [+m[1], +m[2], +m[3]] : null);
    });
  });
}

// A versão de uma instalação da máquina muda sem o nome do arquivo mudar: guarda por caminho real +
// tamanho + mtime. caminho → { chave, versao, tipo, real }.
const versoesMaquina = new Map();
async function daMaquina() {
  const achadas = [];
  for (const caminho of candidatosClaude()) {
    let st;
    try {
      st = await fsp.stat(caminho);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    const real = caminhoReal(caminho);
    const chave = `${real}:${st.size}:${st.mtimeMs}`;
    let c = versoesMaquina.get(caminho);
    if (!c || c.chave !== chave) {
      // Windows: o claude.exe de ~/.local/bin, como sempre (tipo desconhecido conta como nativo).
      const tipo = tipoDe(real) || 'nativo';
      const { cmd, pre } = comandoDe({ caminho, real, tipo });
      c = { chave, tipo, real, versao: await versaoDoArquivo(cmd, pre) };
      versoesMaquina.set(caminho, c);
    }
    if (c.versao) achadas.push({ versao: c.versao, caminho, real: c.real, tipo: c.tipo, origem: caminho === LOCAL_BIN ? 'instalação própria' : `instalação em ${path.dirname(caminho)}` });
  }
  return achadas.sort((a, b) => comparar(a.versao, b.versao));
}

const NOME = WIN ? 'claude.exe' : 'claude';

// O binário que o Orbit usa agora: override de teste → cópia do Orbit → fonte da máquina (enquanto a
// cópia não fica pronta). Síncrono porque é chamado na hora de lançar o processo.
export function binarioClaude() {
  const b = process.env.ORBIT_CLAUDE_BIN;
  if (b) return /\.(mjs|cjs|js)$/i.test(b) ? { cmd: process.execPath, pre: [b] } : { cmd: b, pre: [] };
  const c = copias()[0];
  if (c) return { cmd: c.caminho, pre: [], versao: texto(c.versao) };
  const ext = daExtensao()[0];
  if (ext) return { cmd: ext.caminho, pre: [], versao: texto(ext.versao) };
  // As da máquina já sondadas (atualizarBinario roda na subida), a mais nova primeiro.
  const maquina = [...versoesMaquina.entries()]
    .filter(([caminho, v]) => v.versao && fs.existsSync(caminho))
    .map(([caminho, v]) => ({ caminho, ...v }))
    .sort((a, b) => comparar(a.versao, b.versao));
  if (maquina[0]) return { ...comandoDe(maquina[0]), versao: texto(maquina[0].versao) };
  throw new Error(`não achei o ${NOME} nesta máquina (nem a cópia do Orbit, nem a extensão, nem ${WIN ? '~/.local/bin' : '~/.local/bin, Homebrew, /usr/local/bin ou npm global'})`);
}

let atualizando = null;

// Copia a fonte mais nova para bin/ se ela for mais nova que a cópia atual e apaga as cópias velhas
// (mantém MANTER; a que estiver em uso não sai — o Windows não deixa apagar um exe rodando).
export function atualizarBinario(log = () => {}) {
  if (!atualizando) atualizando = atualizar(log).finally(() => (atualizando = null));
  return atualizando;
}

async function atualizar(log) {
  // Só binário nativo vira cópia: o script do npm não roda fora da pasta do pacote.
  const fontes = [...daExtensao(), ...(await daMaquina()).filter((f) => f.tipo === 'nativo')];
  fontes.sort((a, b) => comparar(a.versao, b.versao));
  const nova = fontes[0];
  const atual = copias()[0];
  let copiou = null;
  if (nova && (!atual || comparar(nova.versao, atual.versao) < 0)) {
    const destino = path.join(BIN_DIR, `claude-${texto(nova.versao)}${EXE}`);
    const tmp = path.join(BIN_DIR, `.copiando-${process.pid}-${Date.now()}${EXE}`);
    try {
      await fsp.mkdir(BIN_DIR, { recursive: true });
      await fsp.copyFile(nova.caminho, tmp);
      if (!WIN) await fsp.chmod(tmp, 0o755); // a cópia precisa ser executável
      const [a, b] = await Promise.all([fsp.stat(nova.caminho), fsp.stat(tmp)]);
      if (a.size !== b.size) throw new Error(`cópia incompleta (${b.size} de ${a.size} bytes)`);
      const v = await versaoDoArquivo(tmp);
      if (!v || comparar(v, nova.versao) !== 0) throw new Error(`a cópia respondeu ${v ? texto(v) : 'nada'} no --version`);
      if (fs.existsSync(destino)) await fsp.rm(tmp, { force: true });
      else await fsp.rename(tmp, destino);
      copiou = { versao: texto(nova.versao), origem: nova.origem, caminho: destino };
      log('binário', `claude ${copiou.versao} copiado da ${nova.origem} para ${destino}`);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      log('binário', `não consegui copiar o claude ${texto(nova.versao)}: ${e.message}`);
    }
  }
  // Restos de cópias interrompidas e versões além das MANTER mais novas.
  for (const n of lerDir(BIN_DIR)) if (n.startsWith('.copiando-')) await fsp.rm(path.join(BIN_DIR, n), { force: true }).catch(() => {});
  for (const c of copias().slice(MANTER)) await fsp.rm(c.caminho, { force: true }).catch(() => {});
  const usada = copias()[0];
  return { copiou, atual: usada ? texto(usada.versao) : null, fonte: nova ? { versao: texto(nova.versao), origem: nova.origem } : null };
}
