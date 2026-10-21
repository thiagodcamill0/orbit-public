// Espaço em disco: card "Espaço em disco" da Home (coluna direita do index.html).
//
// A cada 10 min mede o espaço usado na unidade do sistema, C: no Windows e / no Mac (fs.statfs, instantâneo) e o
// tamanho da pasta temporária do Claude (%TEMP%\claude; no Mac /tmp/claude-<uid>), onde os agentes deixam
// scratchpads e perfis de navegador de teste. A pasta é varrida sem seguir links nem junções, um arquivo de cada
// vez: leve para o pool de E/S do servidor (≈ 1 s para 14 mil arquivos). Se uma varredura ainda está rodando, a próxima não começa.
//
// O histórico é um arquivo só (disco.json, na pasta de dados), regravado inteiro a cada medida, sempre pelo
// mesmo .tmp: nada se acumula em disco. Arquivo ilegível é sobrescrito, sem cópia de reserva.
// Retenção: de 10 em 10 min nas últimas 48 h; de 48 h a 31 dias, uma amostra por hora; o resto sai.
// ≈ 288 + 696 ≈ 1 000 amostras, ≈ 45 KB.
//
// Amostra: [quando (ms), usado no C: (bytes), total do C: (bytes), pasta do Claude (bytes | null)].
// Rota: GET /disco → { amostras, intervalo, unidade, pasta }. Cada medida nova difunde o SSE "disco"
// com { amostra }.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { raizDisco } from './plataforma.mjs';

const HORA = 3600e3;
const DIA = 24 * HORA;
export const RETER_FINO = 48 * HORA; // até aqui, todas as amostras
export const RETER_TUDO = 31 * DIA; // além disso, nada
const VERSAO_ARQ = 1;

function responder(res, codigo, corpo) {
  if (res.headersSent) return;
  res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

function amostraValida(a) {
  return Array.isArray(a) && a.length === 4 && [a[0], a[1], a[2]].every((n) => Number.isFinite(n) && n >= 0)
    && (a[3] === null || (Number.isFinite(a[3]) && a[3] >= 0));
}

// Mais antigo que 48 h: fica a primeira amostra de cada hora. Mais antigo que 31 dias: sai.
export function podar(amostras, agora = Date.now()) {
  const fino = agora - RETER_FINO, corte = agora - RETER_TUDO;
  const fora = [];
  let horaAnt = -1;
  for (const a of amostras) {
    if (a[0] < corte || a[0] > agora + HORA) continue; // relógio adiantado também não fica
    if (a[0] < fino) {
      const h = Math.floor(a[0] / HORA);
      if (h === horaAnt) continue;
      horaAnt = h;
    }
    fora.push(a);
  }
  return fora;
}

// Tamanho de uma pasta: soma dos arquivos, sem seguir links simbólicos nem junções (o Dirent os marca
// como link). Pasta que some no meio da varredura (um agente apagando o scratchpad) só deixa de contar.
export async function tamanhoPasta(raiz) {
  try {
    if (!(await fsp.lstat(raiz)).isDirectory()) return 0;
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
  let total = 0;
  const pilha = [raiz];
  while (pilha.length) {
    const dir = pilha.pop();
    let itens;
    try { itens = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const it of itens) {
      if (it.isSymbolicLink()) continue;
      const p = path.join(dir, it.name);
      if (it.isDirectory()) pilha.push(p);
      else if (it.isFile()) {
        try { total += (await fsp.lstat(p)).size; } catch {}
      }
    }
  }
  return total;
}

// Pasta temporária do Claude Code. Windows: %TEMP%\claude. Mac (16/10, visto no Mac de verdade): o Claude Code
// usa /tmp/claude-<uid> (com uma subpasta por projeto, como no Windows), não o $TMPDIR (/var/folders/…).
export function pastaClaudePadrao(so = process.platform) {
  if (so === 'win32') return path.join(os.tmpdir(), 'claude');
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  return path.posix.join('/tmp', `claude-${uid}`);
}

export function criarDisco(deps = {}) {
  const {
    arquivo,
    unidade = raizDisco(), // Windows: a unidade do sistema (C:\); Mac: /
    pastaClaude = pastaClaudePadrao(),
    intervaloMs = 10 * 60e3,
    difundir = () => {},
    log = () => {},
    statfs = (p) => fsp.statfs(p),
    tamanho = tamanhoPasta,
    agora = () => Date.now(),
  } = deps;

  let amostras = [];
  let medindo = null;
  let timer = null, primeiro = null;

  function carregar() {
    try {
      const d = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
      if (d && Array.isArray(d.amostras)) amostras = podar(d.amostras.filter(amostraValida).sort((a, b) => a[0] - b[0]), agora());
    } catch (e) {
      if (e.code !== 'ENOENT') log('disco: histórico ilegível, recomeçando:', e.message);
      amostras = [];
    }
  }

  // Sempre o mesmo .tmp: um desligamento no meio da escrita deixa no máximo um arquivo a mais, que a
  // próxima gravação reaproveita.
  async function gravar() {
    const tmp = arquivo + '.tmp';
    const corpo = JSON.stringify({ v: VERSAO_ARQ, amostras });
    try {
      await fsp.writeFile(tmp, corpo);
      try {
        await fsp.rename(tmp, arquivo);
      } catch {
        await fsp.writeFile(arquivo, corpo); // Windows: antivírus ou indexador segurando o destino
        await fsp.rm(tmp, { force: true });
      }
    } catch (e) {
      log('disco: falha ao gravar o histórico:', e.message);
    }
  }

  async function medirAgora() {
    const t = agora();
    const s = await statfs(unidade);
    const total = Number(s.bsize) * Number(s.blocks);
    const usado = total - Number(s.bsize) * Number(s.bfree);
    let claude = null;
    try { claude = await tamanho(pastaClaude); } catch (e) { log('disco: não deu para medir a pasta do Claude:', e.message); }
    const a = [t, Math.max(0, usado), total, claude];
    amostras.push(a);
    amostras = podar(amostras, agora());
    await gravar();
    difundir('disco', { amostra: a });
    return a;
  }

  function medir() {
    if (medindo) return medindo;
    medindo = medirAgora()
      .catch((e) => { log('disco: falha na medida:', e?.message || e); return null; })
      .finally(() => { medindo = null; });
    return medindo;
  }

  // Ao subir, a primeira medida espera o intervalo desde a última gravada (reinícios seguidos não
  // empilham amostras), com no mínimo 15 s para não disputar o disco com a subida do servidor.
  function iniciar() {
    carregar();
    const ult = amostras.length ? amostras[amostras.length - 1][0] : 0;
    const espera = Math.max(15e3, ult + intervaloMs - agora());
    primeiro = setTimeout(() => {
      medir();
      timer = setInterval(medir, intervaloMs);
      timer.unref?.();
    }, Math.min(espera, intervaloMs));
    primeiro.unref?.();
  }

  function parar() {
    clearTimeout(primeiro);
    clearInterval(timer);
  }

  function publico() {
    return { amostras, intervalo: intervaloMs, unidade: unidade.replace(/\\$/, ''), pasta: pastaClaude, medindo: !!medindo };
  }

  async function rota(req, res, r) {
    if (r !== '/disco') return false;
    if (req.method !== 'GET') { responder(res, 405, { erro: 'método não permitido' }); return true; }
    responder(res, 200, publico());
    return true;
  }

  return { iniciar, parar, medir, rota, publico, carregar };
}
