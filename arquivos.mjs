// Projetos e arquivos na lateral (rodada 8), como o explorador do VS Code. Página: assets/arquivos.js.
//
// Lista de projetos em <DADOS>/projetos.json: { lista: [{ nome, pasta, desde }], ocultos: [pastaNormalizada] }.
// A lista nasce das sessões conhecidas e cresce pela descoberta (sessaoVista): pasta real, fora das raízes
// temporárias e fora de "ocultos". Remover da lista não mexe em arquivo nenhum.
//
// Toda operação de arquivo é confinada à pasta de um projeto registrado (resolve + realpath, sem diferenciar
// maiúsculas). Excluir só manda para a Lixeira do Windows (API do Shell), com pré-checagem da unidade e da
// Lixeira e conferência depois. No Mac (16/10), para a Lixeira pelo Finder (osascript), restaurável pelo Finder.
// Este arquivo não apaga nada de vez: nenhuma chamada de remoção do fs.
//
// Rotas: GET /projetos · POST /projetos/adicionar {pasta} · /projetos/remover {nome}
//        GET /arquivos/pastas · /arquivos/lista · /arquivos/ler · /arquivos/bruto
//        POST /arquivos/novo · /renomear · /colar · /excluir · /buscar · /revelar · /escolher-pasta (só no Mac)
// SSE: "projetos" { projetos } e "arquivos" { projeto, pastas, arquivos } (vigia fs.watch, ~300 ms).
// GET /projetos e /arquivos/pastas trazem `plataforma` ('win32' | 'darwin' | …): a página troca o rótulo
// "Revelar no Explorador" por "Mostrar no Finder" no Mac.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { SO, mostrarNaPasta, pathAmpliado } from './plataforma.mjs';

const MAX_LISTA = 5000;
const MAX_TEXTO = 2 * 1024 * 1024;
const MAX_BUSCA_ARQ = 1024 * 1024;
const MAX_BUSCA_LIDOS = 5000;
const MAX_OCORRENCIAS = 1000;
const MAX_LINHA = 300;
const TEMPO_BUSCA = 5000;
const VIGIA_OCIOSO = 10 * 60 * 1000;
const VIGIA_ATRASO = 300;

const ESCONDIDOS = new Set(['.git', '.svn', '.hg', 'cvs', '.ds_store', 'thumbs.db']);
const BUSCA_PULA = new Set(['.git', 'node_modules', '.svn', '.hg']);
const IMAGENS = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
};
const LINGUAGENS = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  json: 'json', md: 'markdown', html: 'html', htm: 'html', css: 'css', py: 'python', txt: 'texto',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', xml: 'xml', sh: 'shell', ps1: 'powershell',
  bat: 'bat', cmd: 'bat', sql: 'sql', rs: 'rust', go: 'go', java: 'java', cs: 'csharp', c: 'c', h: 'c',
  cpp: 'cpp', php: 'php', rb: 'ruby', lua: 'lua', svg: 'xml', csv: 'csv', env: 'ini',
};
const RESERVADOS = new Set(['con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);

const colar = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

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

// Chave de comparação de caminho no Windows: absoluto, sem barra no fim, minúsculo.
function chave(p) {
  let s = path.resolve(String(p));
  if (s.length > 3) s = s.replace(/[\\/]+$/, '');
  return s.toLowerCase();
}
function dentroDe(filho, pai) {
  const f = chave(filho);
  const p = chave(pai);
  if (f === p) return true;
  return f.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}
const paraRel = (raiz, abs) => path.relative(raiz, abs).split(path.sep).join('/');

function nomeValido(nome) {
  if (typeof nome !== 'string') return false;
  if (!nome || nome.length > 255) return false;
  if (/[<>:"/\\|?*\x00-\x1f]/.test(nome)) return false;
  if (/[. ]$/.test(nome)) return false;
  const base = nome.split('.')[0].trim().toLowerCase();
  if (RESERVADOS.has(base)) return false;
  return true;
}
function exigirNome(nome) {
  if (!nomeValido(nome)) {
    throw erro(400, 'Nome inválido no Windows (vazio, com < > : " / \\ | ? *, reservado como CON/NUL, ou terminando em ponto ou espaço).', 'nome');
  }
  return nome;
}

const extDe = (nome) => path.extname(nome).slice(1).toLowerCase();

// "nome copy.ext", "nome copy 2.ext"… como o VS Code.
function nomeCopia(nome, n, pasta) {
  const ext = pasta ? '' : path.extname(nome);
  const base = ext ? nome.slice(0, -ext.length) : nome;
  return `${base} copy${n > 1 ? ' ' + n : ''}${ext}`;
}

async function existe(p) {
  try { await fsp.lstat(p); return true; } catch { return false; }
}

// Tamanho total sem seguir junções/links (o que a Lixeira vai receber).
async function tamanhoDe(abs) {
  let total = 0;
  const pilha = [abs];
  let n = 0;
  while (pilha.length) {
    const p = pilha.pop();
    let st;
    try { st = await fsp.lstat(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      let ds = [];
      try { ds = await fsp.readdir(p); } catch {}
      for (const d of ds) pilha.push(path.join(p, d));
    } else total += st.size;
    if (++n % 500 === 0) await new Promise((r) => setImmediate(r));
  }
  return total;
}

// ───────────── PowerShell (Lixeira e seletor de pastas) ─────────────
// O script é fixo; os dados vão por variável de ambiente, nunca interpolados no texto.

function rodarPS(script, env, ms = 120000) {
  return new Promise((resolve, reject) => {
    const cod = Buffer.from('[Console]::OutputEncoding = [Text.Encoding]::UTF8\n' + script, 'utf16le').toString('base64');
    let filho;
    try {
      filho = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', cod], {
        env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return reject(e);
    }
    let saida = '';
    let errs = '';
    filho.stdout.setEncoding('utf8');
    filho.stderr.setEncoding('utf8');
    const t = setTimeout(() => { try { filho.kill(); } catch {} }, ms);
    filho.stdout.on('data', (c) => (saida += c));
    filho.stderr.on('data', (c) => (errs += c));
    filho.on('error', (e) => { clearTimeout(t); reject(e); });
    filho.on('close', (codigo) => {
      clearTimeout(t);
      const linha = saida.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
      try {
        resolve(JSON.parse(linha));
      } catch {
        reject(new Error(`PowerShell falhou (código ${codigo}): ${(errs || saida).trim().slice(0, 400)}`));
      }
    });
  });
}

const PS_LIXEIRA = String.raw`
$ErrorActionPreference = 'Stop'
$bruto = $env:ORBIT_LIXEIRA_ITENS | ConvertFrom-Json
$itens = @($bruto | ForEach-Object { $_ })
function Saida($o) { ConvertTo-Json -InputObject $o -Compress -Depth 5 }
function Politica() {
  foreach ($raiz in @('HKCU:', 'HKLM:')) {
    $k = $raiz + '\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer'
    if (Test-Path -LiteralPath $k) {
      $v = (Get-ItemProperty -LiteralPath $k).NukeOnDelete
      if ($v -eq 1) { return $true }
    }
  }
  return $false
}
function Checar($c, $tam) {
  if ($c -notmatch '^[A-Za-z]:\\') { return 'o caminho não está numa unidade local' }
  $letra = $c.Substring(0, 2).ToUpper()
  $d = New-Object System.IO.DriveInfo($letra)
  if ($d.DriveType -ne [System.IO.DriveType]::Fixed) { return ('a unidade ' + $letra + ' não é fixa local') }
  $mv = (& mountvol.exe ($letra + '\') /L | Out-String)
  if ($mv -notmatch '\{[0-9a-fA-F-]{36}\}') { return ('não deu para achar o volume da unidade ' + $letra) }
  $guid = $Matches[0]
  if (Politica) { return 'a política do Windows apaga sem passar pela Lixeira' }
  $k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\' + $guid
  if (-not (Test-Path -LiteralPath $k)) { return ('a Lixeira da unidade ' + $letra + ' não tem configuração conhecida') }
  $p = Get-ItemProperty -LiteralPath $k
  if ($p.NukeOnDelete -eq 1) { return ('a Lixeira da unidade ' + $letra + ' está desligada (apaga de vez)') }
  if ($null -eq $p.MaxCapacity) { return ('não deu para ler a capacidade da Lixeira da unidade ' + $letra) }
  $cap = [double]$p.MaxCapacity * 1048576
  if ([double]$tam -ge $cap * 0.95) { return ('o item é grande demais para a Lixeira da unidade ' + $letra) }
  return $null
}
function NaLixeira($c, $desde) {
  $letra = $c.Substring(0, 2)
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $dir = Join-Path ($letra + '\') ('$Recycle.Bin\' + $sid)
  if (-not (Test-Path -LiteralPath $dir)) { return $false }
  $fs = @(Get-ChildItem -LiteralPath $dir -Force -Filter '$I*' | Where-Object { $_.LastWriteTime -ge $desde })
  foreach ($f in $fs) {
    try {
      $b = [System.IO.File]::ReadAllBytes($f.FullName)
      $ver = [BitConverter]::ToInt64($b, 0)
      $orig = ''
      if ($ver -eq 2) {
        $n = [BitConverter]::ToInt32($b, 24)
        $orig = [Text.Encoding]::Unicode.GetString($b, 28, [Math]::Max(0, ($n - 1) * 2))
      } else {
        $orig = [Text.Encoding]::Unicode.GetString($b, 24, [Math]::Min(520, $b.Length - 24)).TrimEnd([char]0)
      }
      if ($orig -ieq $c) { return $true }
    } catch {}
  }
  return $false
}
foreach ($i in $itens) {
  $m = Checar $i.caminho $i.tamanho
  if ($m) { Saida @{ ok = $false; motivo = 'sem-lixeira'; erro = $m; caminho = $i.caminho }; exit 0 }
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OrbitLixeira {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct OP {
    public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags;
    [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "SHFileOperationW")]
  static extern int SHFileOperationW(ref OP op);
  public static int Enviar(string caminho) {
    OP op = new OP();
    op.wFunc = 3;
    op.pFrom = caminho + "\0\0";
    op.fFlags = 0x0454;
    int r = SHFileOperationW(ref op);
    if (r == 0 && op.fAnyOperationsAborted) return -1;
    return r;
  }
}
'@
$enviados = @()
foreach ($i in $itens) {
  $desde = (Get-Date).AddSeconds(-5)
  $r = [OrbitLixeira]::Enviar($i.caminho)
  if ($r -ne 0) { Saida @{ ok = $false; motivo = 'falhou'; erro = ('o Windows recusou enviar para a Lixeira (código ' + $r + ')'); caminho = $i.caminho; enviados = $enviados }; exit 0 }
  if (Test-Path -LiteralPath $i.caminho) { Saida @{ ok = $false; motivo = 'falhou'; erro = 'o item continua no lugar depois do envio'; caminho = $i.caminho; enviados = $enviados }; exit 0 }
  if (-not (NaLixeira $i.caminho $desde)) { Saida @{ ok = $false; motivo = 'nao-conferido'; erro = 'o item saiu do lugar mas não foi achado na Lixeira'; caminho = $i.caminho; enviados = $enviados }; exit 0 }
  $enviados += $i.caminho
}
Saida @{ ok = $true; enviados = $enviados }
`;

const PS_PASTAS = String.raw`
$ErrorActionPreference = 'Stop'
$oculto = [System.IO.FileAttributes]::Hidden -bor [System.IO.FileAttributes]::System
$nomes = @(Get-ChildItem -LiteralPath $env:ORBIT_PASTA -Directory -Force -ErrorAction SilentlyContinue |
  Where-Object { -not ($_.Attributes -band $oculto) } | ForEach-Object { $_.Name })
ConvertTo-Json -InputObject @{ nomes = $nomes } -Compress
`;

// ───────────── Mac: osascript (Lixeira pelo Finder e seletor de pastas) ─────────────
// O script é fixo; o caminho vai como argumento do osascript (on run argv), nunca concatenado no texto.

// Devolve o caminho do item na Lixeira (~/.Trash/… ou /Volumes/X/.Trashes/<uid>/…), para a conferência.
export const OSA_LIXEIRA = [
  'on run argv',
  '  set a to (POSIX file (item 1 of argv)) as alias',
  '  tell application "Finder"',
  '    set t to (delete a) as alias',
  '  end tell',
  '  return POSIX path of t',
  'end run',
];

// Janela "Escolher pasta" do macOS; cancelar sai com o erro -128.
export const OSA_ESCOLHER = [
  'on run argv',
  '  activate',
  '  set p to choose folder with prompt (item 1 of argv)',
  '  return POSIX path of p',
  'end run',
];

// Roda o osascript sem shell: { codigo, saida, erro }. Nunca rejeita.
export function rodarOsascript(linhas, args = [], ms = 120000) {
  const argv = [];
  for (const l of linhas) argv.push('-e', l);
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', [...argv, ...args.map(String)], { timeout: ms, maxBuffer: 1024 * 1024, encoding: 'utf8', env: { ...process.env, PATH: pathAmpliado() } },
      (e, saida, errs) => resolve({ codigo: e ? (typeof e.code === 'number' ? e.code : -1) : 0, saida: String(saida || ''), erro: String(errs || (e && !e.code ? e.message : '') || '') }));
  });
}

// Pastas que o Finder esconde (além das que começam com "."): as do sistema na raiz e a Biblioteca do usuário.
// 16/10, no Mac de verdade: na raiz também Volumes, home e pkg (todas com a marca "oculto"; os volumes já vêm
// nas unidades do seletor).
const OCULTAS_RAIZ_MAC = new Set(['bin', 'sbin', 'usr', 'etc', 'var', 'tmp', 'private', 'cores', 'dev', 'opt', 'volumes', 'home', 'pkg']);

// Roda um comando sem shell e devolve a saída (null se falhou). Nunca rejeita.
function saidaDe(cmd, args, ms = 5000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: ms, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (e, saida) => resolve(e ? null : String(saida || '')));
    } catch { resolve(null); }
  });
}

// Saída do `mount`: os pontos de montagem com nobrowse, que o Finder não mostra (Recovery, volumes do sistema).
export function lerMontagensOcultas(texto) {
  const ocultas = new Set();
  for (const l of String(texto || '').split('\n')) {
    const m = /^.+? on (.+) \(([^)]*)\)\s*$/.exec(l);
    if (m && m[2].split(',').some((x) => x.trim() === 'nobrowse')) ocultas.add(m[1]);
  }
  return ocultas;
}
const montagensOcultasMac = async () => lerMontagensOcultas(await saidaDe('/sbin/mount', []));

// Itens com a marca "oculto" do Finder (chflags hidden, UF_HIDDEN = 0x8000; ex.: ~/Library), sem seguir links:
// é o equivalente Mac do atributo Oculto/Sistema que o seletor do Windows pula. Um `stat` por lote; se ele
// falhar ou a contagem não bater, o lote fica sem marca (vale o filtro por nome).
async function ocultosPorMarcaMac(caminhos) {
  const ocultos = new Set();
  for (let i = 0; i < caminhos.length; i += 400) {
    const lote = caminhos.slice(i, i + 400);
    const linhas = String((await saidaDe('/usr/bin/stat', ['-f', '%Xf', '--', ...lote])) ?? '').split('\n').filter(Boolean);
    if (linhas.length !== lote.length) continue;
    lote.forEach((c, k) => { if (parseInt(linhas[k], 16) & 0x8000) ocultos.add(c); });
  }
  return ocultos;
}

// Lixeira do volume do item: o da pasta do usuário tem (~/.Trash); outro volume só se tiver .Trashes na raiz.
// Sem isso (volume de rede, por exemplo) o Finder apagaria de vez: o Orbit não envia.
export async function checarLixeiraMac(abs, home) {
  let st;
  try { st = await fsp.lstat(abs); } catch { return 'o item não existe'; }
  try { if ((await fsp.stat(home)).dev === st.dev) return null; } catch {}
  let dir = abs;
  for (;;) {
    const pai = path.dirname(dir);
    if (pai === dir) break;
    let dev;
    try { dev = (await fsp.stat(pai)).dev; } catch { break; }
    if (dev !== st.dev) break;
    dir = pai;
  }
  if (await existe(path.join(dir, '.Trashes'))) return null;
  return `o volume ${dir} não tem Lixeira (o Finder apagaria de vez)`;
}

// Manda para a Lixeira do Mac, um item por vez, e confere: saiu do lugar e o Finder diz onde está na Lixeira.
// Pré-checa todos antes de enviar o primeiro (como no Windows). Devolve os enviados.
export async function lixeiraMac(absolutos, { osascript = rodarOsascript, home = os.homedir() } = {}) {
  for (const abs of absolutos) {
    if (!path.isAbsolute(abs)) throw erro(409, 'Só dá para mandar para a Lixeira itens com caminho completo.', 'sem-lixeira');
    const m = await checarLixeiraMac(abs, home);
    if (m) throw erro(409, `Nada foi excluído: ${m}. O Orbit não envia o que o macOS apagaria de vez.`, 'sem-lixeira');
  }
  const enviados = [];
  for (const abs of absolutos) {
    const n = enviados.length;
    const pre = n ? `${n} ${n === 1 ? 'item foi' : 'itens foram'} para a Lixeira; ` : '';
    const r = await osascript(OSA_LIXEIRA, [abs], 300000);
    if (r.codigo !== 0) {
      const t = `${r.erro} ${r.saida}`;
      if (/-1743|not authori[sz]ed|não autorizad/i.test(t)) {
        throw erro(409, `${pre}O macOS não deixou o Orbit usar o Finder. Libere em Ajustes do Sistema > Privacidade e Segurança > Automação.`, 'sem-permissao');
      }
      throw erro(500, `${pre}${path.basename(abs)}: o Finder recusou enviar para a Lixeira (${t.trim().slice(0, 200) || 'código ' + r.codigo}).`, 'falhou');
    }
    const destino = r.saida.trim();
    if (await existe(abs)) throw erro(500, `${pre}${path.basename(abs)}: o item continua no lugar depois do envio.`, 'falhou');
    if (!/\/\.Trash(?:es)?\//.test(destino)) throw erro(500, `${pre}${path.basename(abs)}: o item saiu do lugar mas o Finder não disse onde ficou na Lixeira.`, 'nao-conferido');
    enviados.push(abs);
  }
  return enviados;
}

// ───────────── busca (roda dentro de um Worker com eval: true) ─────────────
// Autossuficiente: é serializada com toString(); não usa nada de fora além do workerData.
// Pula .git/node_modules, links/junções, binários e arquivos acima do limite.

function trabalhoBusca() {
  const { parentPort, workerData: w } = require('node:worker_threads');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const colar = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
  const re = new RegExp(w.fonte, w.flags);
  const pula = new Set(w.pula);
  const imagens = new Set(w.imagens);
  const ini = Date.now();
  const rel = (abs) => path.relative(w.raiz, abs).split(path.sep).join('/');
  function trecho(linha, n, a, b) {
    let i = 0;
    while (i < a && (linha[i] === ' ' || linha[i] === '\t')) i++;
    let f = linha.length;
    if (f - i > w.maxLinha) {
      const antes = Math.min(a - i, Math.max(40, Math.floor((w.maxLinha - (b - a)) / 3)));
      i = Math.max(i, a - antes);
      f = Math.min(linha.length, i + w.maxLinha);
    }
    return { n, texto: linha.slice(i, f), ini: a - i, fim: Math.min(b, f) - i };
  }
  (async () => {
    let lidos = 0;
    let ocorr = 0;
    let truncado = false;
    const pilha = [w.base];
    fora: while (pilha.length) {
      const dir = pilha.pop();
      let ds;
      try {
        if ((await fsp.lstat(dir)).isSymbolicLink() && dir !== w.base) continue;
        ds = await fsp.readdir(dir, { withFileTypes: true });
      } catch { continue; }
      ds.sort((a, b) => colar.compare(a.name, b.name));
      const subpastas = [];
      const arqs = [];
      for (const d of ds) {
        if (d.isSymbolicLink()) continue;
        if (d.isDirectory()) { if (!pula.has(d.name.toLowerCase())) subpastas.push(path.join(dir, d.name)); }
        else if (d.isFile()) arqs.push(path.join(dir, d.name));
      }
      for (const arq of arqs) {
        if (Date.now() - ini > w.tempo || lidos >= w.maxLidos || ocorr >= w.maxOcorr) { truncado = true; break fora; }
        let st;
        try { st = await fsp.stat(arq); } catch { continue; }
        if (st.size > w.maxArq) continue;
        if (imagens.has(path.extname(arq).slice(1).toLowerCase())) continue;
        let buf;
        try { buf = await fsp.readFile(arq); } catch { continue; }
        lidos++;
        if (buf.subarray(0, 8192).includes(0)) continue;
        let s = buf.toString('utf8');
        if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
        const linhas = [];
        const ls = s.split(/\r?\n/);
        for (let n = 0; n < ls.length && ocorr < w.maxOcorr; n++) {
          const linha = ls[n];
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(linha))) {
            if (m[0] === '') { re.lastIndex++; if (re.lastIndex > linha.length) break; continue; }
            linhas.push(trecho(linha, n + 1, m.index, m.index + m[0].length));
            if (++ocorr >= w.maxOcorr) break;
          }
          if (n % 2000 === 1999 && Date.now() - ini > w.tempo) { truncado = true; break; }
        }
        if (linhas.length) parentPort.postMessage({ arquivo: rel(arq), linhas });
        if (truncado) break fora;
      }
      for (let i = subpastas.length - 1; i >= 0; i--) pilha.push(subpastas[i]);
    }
    if (ocorr >= w.maxOcorr) truncado = true;
    parentPort.postMessage({ fim: true, truncado });
  })().catch(() => parentPort.postMessage({ fim: true, truncado: true }));
}

// ───────────────────────── módulo ─────────────────────────

export function criarArquivos(deps) {
  const { dados, sessoes = () => [], difundir = () => {}, lerJSONCorpo, log = () => {}, teste = false, realce = null } = deps;
  // Sistema e comandos dele: os testes simulam o Mac (so: 'darwin', osascript e mostrar falsos, home e
  // pasta de volumes temporárias) sem trocar o process.platform.
  const {
    so = SO, osascript = rodarOsascript, mostrar = mostrarNaPasta, home = os.homedir(), volumes = '/Volumes',
    montagensOcultas = montagensOcultasMac, ocultosPorMarca = ocultosPorMarcaMac,
  } = deps;
  const MAC = so === 'darwin';
  const nomeSO = MAC ? 'O macOS' : 'O Windows';
  const arquivoLista = path.join(dados, 'projetos.json');

  let estado = null; // { lista, ocultos }
  let semeadoDoZero = false; // 1ª carga sem arquivo: semear de novo na 1ª rota (o servidor carrega as sessões depois)
  let fila = Promise.resolve();
  const vigias = new Map(); // nome → { watcher, raiz, timer, ocioso, pastas:Set, arquivos:Set }
  let parado = false;

  function emFila(fn) {
    const p = fila.then(() => fn());
    fila = p.catch(() => {});
    return p;
  }

  function raizesTemp() {
    const env = process.env.ORBIT_PASTAS_TEMP;
    const lista = env != null && env !== ''
      ? env.split(';')
      : [os.tmpdir(), process.env.TEMP, process.env.TMP, ...(so === 'win32' ? [] : ['/tmp'])];
    const raizes = lista.map((s) => String(s || '').trim()).filter(Boolean).map((s) => path.resolve(s));
    // Mac: /tmp e o $TMPDIR (/var/folders/…) são links para /private/…, e o projeto entra pelo caminho real;
    // vale também o real. O /tmp é a pasta temporária do Claude Code no Mac (/tmp/claude-<uid>), como o
    // %TEMP%\claude no Windows.
    if (so !== 'win32') for (const r of [...raizes]) { const real = pastaReal(r); if (real) raizes.push(real); }
    return [...new Set(raizes)];
  }
  const temporaria = (p) => raizesTemp().some((r) => dentroDe(p, r));

  function pastaReal(p) {
    try {
      const r = fs.realpathSync.native(p);
      return fs.statSync(r).isDirectory() ? r : null;
    } catch {
      return null;
    }
  }
  const nomeDaPasta = (p) => path.basename(String(p).replace(/[\\/]+$/, ''));

  async function gravar() {
    await fsp.mkdir(dados, { recursive: true });
    const tmp = `${arquivoLista}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(estado, null, 2) + '\n', 'utf8');
    await fsp.rename(tmp, arquivoLista);
  }

  // Tenta pôr a pasta na lista (descoberta e semente). Devolve true se entrou.
  function tentarEntrar(cwd) {
    if (typeof cwd !== 'string' || !cwd.trim()) return false;
    const real = pastaReal(cwd);
    if (!real || temporaria(real) || temporaria(cwd)) return false;
    const nome = nomeDaPasta(real);
    if (!nome) return false;
    const k = chave(real);
    if (estado.ocultos.includes(k)) return false;
    if (estado.lista.some((p) => chave(p.pasta) === k)) return false;
    if (estado.lista.some((p) => p.nome.toLowerCase() === nome.toLowerCase())) return false;
    estado.lista.push({ nome, pasta: real, desde: new Date().toISOString() });
    return true;
  }

  function semear() {
    let mudou = false;
    try {
      for (const s of sessoes() || []) if (s && tentarEntrar(s.cwd)) mudou = true;
    } catch (e) {
      log('arquivos: semente', e?.message || e);
    }
    return mudou;
  }

  async function carregar() {
    if (estado) return estado;
    let lido = null;
    try {
      lido = JSON.parse(await fsp.readFile(arquivoLista, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') log('arquivos: projetos.json ilegível, recomeçando', e?.message || e);
    }
    if (estado) return estado;
    if (lido && typeof lido === 'object') {
      estado = {
        lista: (Array.isArray(lido.lista) ? lido.lista : [])
          .filter((p) => p && typeof p.nome === 'string' && typeof p.pasta === 'string')
          .map((p) => ({ nome: p.nome, pasta: p.pasta, desde: p.desde || null })),
        ocultos: (Array.isArray(lido.ocultos) ? lido.ocultos : []).filter((s) => typeof s === 'string').map((s) => chave(s)),
      };
    } else {
      estado = { lista: [], ocultos: [] };
      semeadoDoZero = true;
      semear();
      await gravar();
    }
    return estado;
  }

  function publicos() {
    return [...estado.lista]
      .sort((a, b) => colar.compare(a.nome, b.nome))
      .map((p) => ({ nome: p.nome, pasta: p.pasta, existe: !!pastaReal(p.pasta) }));
  }
  const difundirProjetos = () => difundir('projetos', { projetos: publicos() });

  function projetoPorNome(nome) {
    if (typeof nome !== 'string' || !nome) throw erro(400, 'Falta o projeto.');
    const p = estado.lista.find((x) => x.nome === nome) || estado.lista.find((x) => x.nome.toLowerCase() === nome.toLowerCase());
    if (!p) throw erro(404, `O projeto "${nome}" não está na lista.`, 'projeto');
    const raiz = pastaReal(p.pasta);
    if (!raiz) throw erro(404, `A pasta do projeto "${p.nome}" não existe mais.`, 'sem-pasta');
    return { ...p, raiz };
  }

  // Resolve "caminho" (relativo, com /) dentro do projeto. Junção/link que escapa → 403.
  async function resolver(nomeProj, rel, { deveExistir = true } = {}) {
    const proj = projetoPorNome(nomeProj);
    if (rel == null) rel = '';
    if (typeof rel !== 'string') throw erro(400, 'Caminho inválido.');
    if (rel.includes('\0')) throw erro(400, 'Caminho inválido.');
    const fora = () => erro(403, 'Esse caminho fica fora da pasta do projeto.', 'fora');
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || /^[\\/]/.test(rel) || rel.includes(':')) throw fora();
    const partes = rel.split(/[\\/]+/).filter(Boolean);
    if (partes.some((s) => s === '..' || s === '.')) throw fora();
    const abs = path.resolve(proj.raiz, ...partes);
    if (!dentroDe(abs, proj.raiz)) throw fora();
    const raiz = chave(abs) === chave(proj.raiz);
    // Pai real dentro do projeto.
    if (!raiz) {
      let paiReal;
      try { paiReal = await fsp.realpath(path.dirname(abs)); } catch { throw erro(404, 'A pasta não existe.', 'nao-existe'); }
      if (!dentroDe(paiReal, proj.raiz)) throw fora();
    }
    let st = null;
    try { st = await fsp.lstat(abs); } catch {}
    if (st) {
      let real;
      try { real = await fsp.realpath(abs); } catch { real = null; }
      if (st.isSymbolicLink() && (!real || !dentroDe(real, proj.raiz))) throw fora();
      if (real && !dentroDe(real, proj.raiz)) throw fora();
    } else if (deveExistir) {
      throw erro(404, 'Esse item não existe (pode ter sido movido ou apagado).', 'nao-existe');
    }
    return { proj, abs, rel: paraRel(proj.raiz, abs), raiz, st };
  }

  // ───────────── Lixeira ─────────────

  async function enviarLixeira(absolutos) {
    if (!absolutos.length) return [];
    const falsa = 'lixeiraFalsa' in deps ? deps.lixeiraFalsa : process.env.ORBIT_LIXEIRA_FALSA;
    if (falsa) {
      await fsp.mkdir(falsa, { recursive: true });
      const enviados = [];
      for (const abs of absolutos) {
        const alvo = path.join(falsa, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${path.basename(abs)}`);
        try {
          await fsp.rename(abs, alvo);
        } catch (e) {
          throw erro(500, `Não deu para mover para a Lixeira de teste: ${e.message}`, 'falhou');
        }
        if ((await existe(abs)) || !(await existe(alvo))) throw erro(500, 'A conferência da Lixeira de teste falhou.', 'nao-conferido');
        enviados.push(abs);
      }
      return enviados;
    }
    if (MAC) return lixeiraMac(absolutos, { osascript, home });
    if (so !== 'win32') throw erro(409, 'A Lixeira só funciona no Windows e no Mac.', 'sem-lixeira');
    const itens = [];
    for (const abs of absolutos) {
      if (!/^[a-zA-Z]:\\/.test(abs)) throw erro(409, 'Só dá para mandar para a Lixeira itens numa unidade local.', 'sem-lixeira');
      itens.push({ caminho: abs, tamanho: await tamanhoDe(abs) });
    }
    let r;
    try {
      r = await rodarPS(PS_LIXEIRA, { ORBIT_LIXEIRA_ITENS: JSON.stringify(itens) }, 300000);
    } catch (e) {
      throw erro(500, `Não deu para falar com a Lixeira do Windows: ${e.message}`, 'falhou');
    }
    if (!r?.ok) {
      const n = Array.isArray(r?.enviados) ? r.enviados.length : 0;
      const pre = n ? `${n} ${n === 1 ? 'item foi' : 'itens foram'} para a Lixeira; ` : '';
      if (r?.motivo === 'sem-lixeira') throw erro(409, `Nada foi excluído: ${r.erro}. O Windows apagaria de vez, então o Orbit não envia.`, 'sem-lixeira');
      throw erro(500, `${pre}${path.basename(r?.caminho || '')}: ${r?.erro || 'falha desconhecida'}.`, r?.motivo || 'falhou');
    }
    return Array.isArray(r.enviados) ? r.enviados : [];
  }

  // ───────────── vigia ─────────────

  function pararVigia(nome) {
    const v = vigias.get(nome);
    if (!v) return;
    vigias.delete(nome);
    clearTimeout(v.timer);
    clearTimeout(v.ocioso);
    try { v.watcher.close(); } catch {}
  }

  function despejar(nome) {
    const v = vigias.get(nome);
    if (!v) return;
    v.timer = null;
    if (!v.pastas.size && !v.arquivos.size) return;
    const corpo = { projeto: nome, pastas: [...v.pastas], arquivos: [...v.arquivos] };
    v.pastas.clear();
    v.arquivos.clear();
    try { difundir('arquivos', corpo); } catch (e) { log('arquivos: difundir', e?.message || e); }
  }

  function tocarVigia(proj) {
    if (parado) return;
    let v = vigias.get(proj.nome);
    if (v && chave(v.raiz) !== chave(proj.raiz)) { pararVigia(proj.nome); v = null; }
    if (!v) {
      let watcher;
      try {
        watcher = fs.watch(proj.raiz, { recursive: true, persistent: false });
      } catch (e) {
        log('arquivos: vigia não ligou', proj.nome, e?.code || e?.message || e);
        return;
      }
      v = { watcher, raiz: proj.raiz, timer: null, ocioso: null, pastas: new Set(), arquivos: new Set() };
      vigias.set(proj.nome, v);
      const nome = proj.nome;
      watcher.on('error', (e) => {
        log('arquivos: vigia caiu', nome, e?.code || e?.message || e);
        pararVigia(nome);
      });
      watcher.on('change', (_tipo, arq) => {
        const atual = vigias.get(nome);
        if (atual !== v) return;
        if (arq == null) {
          v.pastas.add('');
        } else {
          const rel = String(arq).split(/[\\/]+/).filter(Boolean).join('/');
          const primeiro = rel.split('/')[0].toLowerCase();
          if (primeiro === '.git') return;
          if (!rel) v.pastas.add('');
          else {
            v.arquivos.add(rel);
            const i = rel.lastIndexOf('/');
            v.pastas.add(i < 0 ? '' : rel.slice(0, i));
          }
        }
        if (!v.timer) {
          v.timer = setTimeout(() => despejar(nome), VIGIA_ATRASO);
          v.timer.unref?.();
        }
      });
    }
    clearTimeout(v.ocioso);
    v.ocioso = setTimeout(() => pararVigia(proj.nome), VIGIA_OCIOSO);
    v.ocioso.unref?.();
  }

  // ───────────── rotas de projetos ─────────────

  async function adicionar(corpo) {
    const pasta = typeof corpo.pasta === 'string' ? corpo.pasta.trim().replace(/^"(.*)"$/, '$1') : '';
    if (!pasta || !path.isAbsolute(pasta)) throw erro(400, 'Informe o caminho completo da pasta.');
    const real = pastaReal(pasta);
    if (!real) throw erro(404, 'Essa pasta não existe.', 'nao-existe');
    if (temporaria(real) || temporaria(pasta)) throw erro(400, 'Pastas temporárias não entram na lista de projetos.', 'temporaria');
    const nome = nomeDaPasta(real);
    if (!nome) throw erro(400, 'A raiz de uma unidade não pode ser um projeto.', 'nome');
    const k = chave(real);
    return emFila(async () => {
      const ja = estado.lista.find((p) => chave(p.pasta) === k);
      if (ja) return { status: 200, corpo: { ok: true, projeto: { nome: ja.nome, pasta: ja.pasta, existe: true }, projetos: publicos() } };
      const outro = estado.lista.find((p) => p.nome.toLowerCase() === nome.toLowerCase());
      if (outro) throw erro(409, `Já existe um projeto chamado "${outro.nome}" (${outro.pasta}).`, 'nome');
      estado.ocultos = estado.ocultos.filter((o) => o !== k);
      const novo = { nome, pasta: real, desde: new Date().toISOString() };
      estado.lista.push(novo);
      await gravar();
      difundirProjetos();
      return { status: 201, corpo: { ok: true, projeto: { nome, pasta: real, existe: true }, projetos: publicos() } };
    });
  }

  async function remover(corpo) {
    const nome = typeof corpo.nome === 'string' ? corpo.nome : '';
    return emFila(async () => {
      const p = estado.lista.find((x) => x.nome === nome) || estado.lista.find((x) => x.nome.toLowerCase() === nome.toLowerCase());
      if (!p) throw erro(404, `O projeto "${nome}" não está na lista.`, 'projeto');
      estado.lista = estado.lista.filter((x) => x !== p);
      const k = chave(p.pasta);
      if (!estado.ocultos.includes(k)) estado.ocultos.push(k);
      pararVigia(p.nome);
      await gravar();
      difundirProjetos();
      return { status: 200, corpo: { ok: true, projetos: publicos() } };
    });
  }

  // ───────────── rotas de arquivos ─────────────

  function atalhos() {
    const casa = home;
    const primeiro = (...cs) => cs.find((c) => c && pastaReal(c)) || null;
    const od = process.env.OneDrive || path.join(casa, 'OneDrive');
    const lista = [
      { nome: 'Pasta do usuário', caminho: casa },
      { nome: 'Área de Trabalho', caminho: primeiro(path.join(casa, 'Desktop'), path.join(od, 'Desktop'), path.join(od, 'Área de Trabalho')) },
      { nome: 'Documentos', caminho: primeiro(path.join(casa, 'Documents'), path.join(od, 'Documents'), path.join(od, 'Documentos')) },
    ];
    return lista.filter((a) => a.caminho && pastaReal(a.caminho));
  }

  async function pastas(q) {
    const c = q.get('caminho');
    if (!c) {
      const unidades = [];
      if (MAC) {
        // Mac: os volumes montados (/Volumes/*, inclusive o do sistema, que aponta para /), sem os que o Finder
        // não mostra (nobrowse, como o Recovery).
        const ds = await fsp.readdir(volumes, { withFileTypes: true }).catch(() => []);
        const semFinder = await montagensOcultas().catch(() => new Set());
        for (const d of ds) {
          if (d.name.startsWith('.')) continue;
          const caminho = path.join(volumes, d.name);
          if (semFinder.has(caminho)) continue;
          if (pastaReal(caminho)) unidades.push({ nome: d.name, caminho });
        }
        unidades.sort((a, b) => colar.compare(a.nome, b.nome));
      } else {
        for (let i = 65; i <= 90; i++) {
          const u = `${String.fromCharCode(i)}:\\`;
          try { if (fs.existsSync(u)) unidades.push({ nome: u, caminho: u }); } catch {}
        }
      }
      return { caminho: '', pai: null, unidades, atalhos: atalhos(), pastas: [], plataforma: so };
    }
    if (!path.isAbsolute(c)) throw erro(400, 'Informe um caminho completo.');
    const abs = path.resolve(c);
    let st;
    try { st = await fsp.stat(abs); } catch { throw erro(404, 'Essa pasta não existe.', 'nao-existe'); }
    if (!st.isDirectory()) throw erro(400, 'Isso não é uma pasta.');
    let nomes;
    if (MAC) {
      // Mac: leitura direta, sem as que começam com "." e sem as que o Finder esconde (sistema na raiz,
      // Biblioteca do usuário, marca "oculto", montagens nobrowse). Link para pasta conta como pasta, como no
      // Finder. A raiz e a pasta do usuário valem também pelo caminho real (/Volumes/Macintosh HD é a raiz).
      const ds = await fsp.readdir(abs, { withFileTypes: true }).catch(() => []);
      const real = pastaReal(abs) || abs;
      const ocultas = chave(real) === chave(path.parse(real).root) ? OCULTAS_RAIZ_MAC
        : chave(real) === chave(pastaReal(home) || home) ? new Set(['library']) : null;
      const semFinder = await montagensOcultas().catch(() => new Set());
      nomes = [];
      for (const d of ds) {
        if (d.name.startsWith('.') || ocultas?.has(d.name.toLowerCase()) || semFinder.has(path.join(abs, d.name))) continue;
        if (d.isDirectory() || (d.isSymbolicLink() && pastaReal(path.join(abs, d.name)))) nomes.push(d.name);
      }
      const marcados = await ocultosPorMarca(nomes.map((n) => path.join(abs, n))).catch(() => new Set());
      nomes = nomes.filter((n) => !marcados.has(path.join(abs, n)));
    } else try {
      nomes = (await rodarPS(PS_PASTAS, { ORBIT_PASTA: abs }, 20000)).nomes || [];
    } catch (e) {
      // Sem o PowerShell: leitura direta, sem as que começam com . ou $ (aproximação de ocultas/sistema).
      log('arquivos: seletor sem PowerShell', e?.message || e);
      const ds = await fsp.readdir(abs, { withFileTypes: true }).catch(() => []);
      nomes = ds.filter((d) => d.isDirectory() && !/^[.$]/.test(d.name)).map((d) => d.name);
    }
    if (!Array.isArray(nomes)) nomes = [nomes];
    nomes = nomes.filter((n) => typeof n === 'string').sort((a, b) => colar.compare(a, b));
    const pai = path.dirname(abs);
    return {
      caminho: abs,
      pai: chave(pai) === chave(abs) ? null : pai,
      pastas: nomes.map((nome) => ({ nome, caminho: path.join(abs, nome) })),
      plataforma: so,
    };
  }

  async function lista(q) {
    const r = await resolver(q.get('projeto'), q.get('caminho') || '');
    if (!r.st.isDirectory() && !(await fsp.stat(r.abs).catch(() => null))?.isDirectory()) throw erro(400, 'Isso não é uma pasta.');
    tocarVigia(r.proj);
    const ds = await fsp.readdir(r.abs, { withFileTypes: true });
    const visiveis = ds.filter((d) => !ESCONDIDOS.has(d.name.toLowerCase()));
    const truncado = visiveis.length > MAX_LISTA;
    const itens = [];
    const LOTE = 200;
    for (let i = 0; i < visiveis.length; i += LOTE) {
      const parte = await Promise.all(visiveis.slice(i, i + LOTE).map(async (d) => {
        const p = path.join(r.abs, d.name);
        let st = null;
        try { st = await fsp.stat(p); } catch { try { st = await fsp.lstat(p); } catch {} }
        const pasta = st ? st.isDirectory() : d.isDirectory();
        return { nome: d.name, tipo: pasta ? 'pasta' : 'arquivo', tamanho: pasta ? 0 : (st?.size || 0), mtime: st ? Math.round(st.mtimeMs) : 0 };
      }));
      itens.push(...parte);
    }
    itens.sort((a, b) => (a.tipo === b.tipo ? colar.compare(a.nome, b.nome) : a.tipo === 'pasta' ? -1 : 1));
    const corpo = { projeto: r.proj.nome, caminho: r.rel, itens: itens.slice(0, MAX_LISTA) };
    if (truncado) corpo.truncado = true;
    return corpo;
  }

  async function ler(q) {
    const r = await resolver(q.get('projeto'), q.get('caminho') || '');
    const st = await fsp.stat(r.abs);
    if (st.isDirectory()) throw erro(400, 'Isso é uma pasta.');
    tocarVigia(r.proj);
    const base = { tamanho: st.size, mtime: Math.round(st.mtimeMs) };
    const ext = extDe(r.abs);
    if (IMAGENS[ext]) return { tipo: 'imagem', ...base };
    if (st.size > MAX_TEXTO) return { tipo: 'grande', ...base };
    const buf = await fsp.readFile(r.abs);
    if (buf.subarray(0, 8192).includes(0)) return { tipo: 'binario', ...base };
    let conteudo = buf.toString('utf8');
    if (conteudo.charCodeAt(0) === 0xfeff) conteudo = conteudo.slice(1);
    const nome = path.basename(r.abs).toLowerCase();
    const linguagem = LINGUAGENS[ext] || (nome.startsWith('.') ? 'ini' : 'texto');
    return { tipo: 'texto', ...base, conteudo, linguagem };
  }

  // Temas do VS Code: cores do tema do VS Code para a prévia (temas.mjs). Lê o mesmo texto que o /arquivos/ler devolve;
  // mtime e tamanho deixam a página conferir que as cores são do conteúdo que está na tela.
  async function realcarArquivo(q) {
    if (!realce || typeof realce.realcar !== 'function') return { realce: null };
    const d = await ler(q);
    if (d.tipo !== 'texto') return { realce: null };
    const r = await realce.realcar(d.conteudo, path.basename(String(q.get('caminho') || '')));
    return { realce: r && Array.isArray(r.linhas) ? { ...r, mtime: d.mtime, tamanho: d.tamanho } : null, ...(r && r.semRealce ? { semRealce: r.semRealce } : {}) };
  }

  async function bruto(q, res) {
    const r = await resolver(q.get('projeto'), q.get('caminho') || '');
    const st = await fsp.stat(r.abs);
    const tipo = st.isFile() ? IMAGENS[extDe(r.abs)] : null;
    if (!tipo) throw erro(415, 'Só imagens podem ser abertas assim.', 'tipo');
    const cab = { 'content-type': tipo, 'content-length': st.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (tipo === 'image/svg+xml') cab['content-security-policy'] = 'sandbox';
    await new Promise((resolve) => {
      const s = fs.createReadStream(r.abs);
      s.once('open', () => { res.writeHead(200, cab); s.pipe(res); });
      s.once('error', (e) => {
        if (!res.headersSent) responder(res, 500, { erro: `Não deu para ler: ${e.message}` });
        else res.destroy();
        resolve();
      });
      s.once('end', resolve);
      res.once('close', resolve);
    });
  }

  async function novo(corpo) {
    const nome = exigirNome(corpo.nome);
    const tipo = corpo.tipo === 'pasta' ? 'pasta' : corpo.tipo === 'arquivo' ? 'arquivo' : null;
    if (!tipo) throw erro(400, 'Tipo inválido (arquivo ou pasta).');
    const dir = await resolver(corpo.projeto, corpo.pasta || '');
    if (!(await fsp.stat(dir.abs)).isDirectory()) throw erro(400, 'O destino não é uma pasta.');
    const alvo = await resolver(dir.proj.nome, dir.rel ? `${dir.rel}/${nome}` : nome, { deveExistir: false });
    if (alvo.st) throw erro(409, `Já existe "${nome}" nesta pasta.`, 'existe');
    try {
      if (tipo === 'pasta') await fsp.mkdir(alvo.abs);
      else await (await fsp.open(alvo.abs, 'wx')).close();
    } catch (e) {
      if (e.code === 'EEXIST') throw erro(409, `Já existe "${nome}" nesta pasta.`, 'existe');
      throw e;
    }
    return { status: 201, corpo: { ok: true, caminho: alvo.rel } };
  }

  async function renomear(corpo) {
    const nome = exigirNome(corpo.nome);
    const r = await resolver(corpo.projeto, corpo.caminho);
    if (r.raiz) throw erro(400, 'A pasta do projeto não pode ser renomeada aqui.', 'raiz');
    const destino = path.join(path.dirname(r.abs), nome);
    const relDest = paraRel(r.proj.raiz, destino);
    if (destino === r.abs) return { ok: true, caminho: r.rel };
    const soMaiusculas = chave(destino) === chave(r.abs);
    if (!soMaiusculas && (await existe(destino))) throw erro(409, `Já existe "${nome}" nesta pasta.`, 'existe');
    await fsp.rename(r.abs, destino);
    return { ok: true, caminho: relDest };
  }

  async function nomeLivre(dir, nome, pasta) {
    if (!(await existe(path.join(dir, nome)))) return nome;
    for (let n = 1; n < 10000; n++) {
      const c = nomeCopia(nome, n, pasta);
      if (!(await existe(path.join(dir, c)))) return c;
    }
    throw erro(409, 'Cópias demais com esse nome.', 'existe');
  }

  async function colarItens(corpo) {
    const modo = corpo.modo === 'mover' ? 'mover' : corpo.modo === 'copiar' ? 'copiar' : null;
    if (!modo) throw erro(400, 'Modo inválido (copiar ou mover).');
    if (!Array.isArray(corpo.itens) || !corpo.itens.length) throw erro(400, 'Nada para colar.');
    if (corpo.itens.length > 1000) throw erro(400, 'Itens demais de uma vez.');
    const dest = await resolver(corpo.projeto, corpo.destino || '');
    if (!(await fsp.stat(dest.abs)).isDirectory()) throw erro(400, 'O destino não é uma pasta.');
    const destReal = await fsp.realpath(dest.abs);
    const origens = [];
    for (const it of corpo.itens) {
      const o = await resolver(it?.projeto ?? corpo.projeto, it?.caminho);
      if (o.raiz) throw erro(400, 'A pasta do projeto não pode ser copiada nem movida.', 'raiz');
      const ehPasta = (await fsp.lstat(o.abs)).isDirectory();
      const real = await fsp.realpath(o.abs);
      if (ehPasta && dentroDe(destReal, real)) throw erro(400, `Não dá para pôr "${path.basename(o.abs)}" dentro dela mesma.`, 'dentro');
      origens.push({ ...o, ehPasta });
    }
    const caminhos = [];
    for (const o of origens) {
      const nome = path.basename(o.abs);
      if (modo === 'copiar') {
        const livre = await nomeLivre(dest.abs, nome, o.ehPasta);
        const alvo = path.join(dest.abs, livre);
        await fsp.cp(o.abs, alvo, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true });
        caminhos.push(paraRel(dest.proj.raiz, alvo));
        continue;
      }
      // mover
      if (chave(path.dirname(await fsp.realpath(o.abs))) === chave(destReal)) {
        caminhos.push(paraRel(dest.proj.raiz, path.join(dest.abs, nome)));
        continue;
      }
      const alvo = path.join(dest.abs, nome);
      if (await existe(alvo)) throw erro(409, `Já existe "${nome}" no destino.`, 'existe');
      try {
        await fsp.rename(o.abs, alvo);
      } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        // Entre unidades: copia e manda a origem para a Lixeira (nunca apaga).
        await fsp.cp(o.abs, alvo, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true });
        try {
          await enviarLixeira([o.abs]);
        } catch (e2) {
          throw erro(e2.status || 500, `A cópia de "${nome}" foi feita, mas a origem ficou no lugar: ${e2.message}`, e2.motivo || 'falhou');
        }
      }
      caminhos.push(paraRel(dest.proj.raiz, alvo));
    }
    return { ok: true, caminhos };
  }

  async function excluir(corpo) {
    if (!Array.isArray(corpo.caminhos) || !corpo.caminhos.length) throw erro(400, 'Nada para excluir.');
    if (corpo.caminhos.length > 1000) throw erro(400, 'Itens demais de uma vez.');
    const rs = [];
    for (const c of corpo.caminhos) {
      const r = await resolver(corpo.projeto, c);
      if (r.raiz) throw erro(400, 'A pasta do projeto não pode ser excluída por aqui.', 'raiz');
      rs.push(r);
    }
    // Sem repetidos e sem itens que já vão dentro de uma pasta da lista.
    const unicos = rs.filter((r, i) => rs.findIndex((x) => chave(x.abs) === chave(r.abs)) === i);
    const finais = unicos.filter((r) => !unicos.some((x) => x !== r && dentroDe(r.abs, x.abs)));
    const enviados = await enviarLixeira(finais.map((r) => r.abs));
    const caminhos = finais.filter((r) => enviados.some((e) => chave(e) === chave(r.abs))).map((r) => r.rel);
    return { ok: true, enviados: caminhos.length, caminhos };
  }

  async function buscar(corpo) {
    const texto = typeof corpo.texto === 'string' ? corpo.texto : '';
    const vazio = { resultados: [], arquivos: 0, ocorrencias: 0, truncado: false };
    if (!texto) return vazio;
    if (texto.length > 1000) throw erro(400, 'Texto de busca longo demais.');
    let fonte = corpo.regex ? texto : texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (corpo.palavra) fonte = `\\b(?:${fonte})\\b`;
    let re;
    try {
      re = new RegExp(fonte, corpo.maiusculas ? 'g' : 'gi');
    } catch (e) {
      throw erro(400, `Expressão regular inválida: ${e.message}`, 'regex');
    }
    const base = await resolver(corpo.projeto, corpo.caminho || '');
    // A busca roda num Worker: uma regex catastrófica trava só o worker, que é encerrado no limite de tempo.
    // Os achados chegam por postMessage arquivo a arquivo; no limite, devolve o parcial com truncado.
    return new Promise((resolve) => {
      const resultados = [];
      let ocorrencias = 0;
      let acabou = false;
      let worker;
      const fim = (truncado) => {
        if (acabou) return;
        acabou = true;
        clearTimeout(limite);
        try { worker?.terminate(); } catch {}
        if (ocorrencias >= MAX_OCORRENCIAS) truncado = true;
        resolve({ resultados, arquivos: resultados.length, ocorrencias, truncado: !!truncado });
      };
      const limite = setTimeout(() => fim(true), TEMPO_BUSCA);
      try {
        worker = new Worker(`(${trabalhoBusca.toString()})()`, {
          eval: true,
          workerData: {
            base: base.abs, raiz: base.proj.raiz, fonte, flags: corpo.maiusculas ? 'g' : 'gi',
            tempo: TEMPO_BUSCA, maxArq: MAX_BUSCA_ARQ, maxLidos: MAX_BUSCA_LIDOS, maxOcorr: MAX_OCORRENCIAS,
            maxLinha: MAX_LINHA, pula: [...BUSCA_PULA], imagens: Object.keys(IMAGENS).filter((e) => e !== 'svg'),
          },
          resourceLimits: { maxOldGenerationSizeMb: 256 },
        });
      } catch (e) {
        log('arquivos: worker da busca não subiu', e?.message || e);
        return fim(true);
      }
      worker.on('message', (m) => {
        if (acabou || !m) return;
        if (m.arquivo) {
          const linhas = m.linhas.slice(0, Math.max(0, MAX_OCORRENCIAS - ocorrencias));
          if (linhas.length) { resultados.push({ caminho: m.arquivo, linhas }); ocorrencias += linhas.length; }
        } else if (m.fim) fim(m.truncado);
      });
      worker.on('error', (e) => { log('arquivos: busca', e?.message || e); fim(true); });
      worker.on('exit', () => setTimeout(() => fim(true), 50));
    });
  }

  async function revelar(corpo) {
    const r = await resolver(corpo.projeto, corpo.caminho || '');
    if (teste && !deps.mostrar) return { ok: true };
    // Windows: explorer /select,"…" (o caminho não tem aspas no Windows); Mac: open -R. Ver plataforma.mjs.
    try {
      await mostrar(r.abs);
    } catch (e) {
      log('arquivos: mostrar na pasta', e?.message || e);
      throw erro(500, `Não deu para abrir o ${MAC ? 'Finder' : 'Explorador'}: ${e.message}`);
    }
    return { ok: true };
  }

  // Mac: a janela "Escolher pasta" do Finder, para o seletor de projeto. No Windows o seletor é o da página.
  async function escolherPasta(corpo) {
    if (!MAC) throw erro(409, 'A janela do sistema para escolher pasta só existe no Mac; use o seletor da página.', 'sem-seletor');
    // Servidor de teste sem osascript falso: nunca abre a janela de verdade (ela esperaria um clique).
    if (teste && !deps.osascript) return { ok: true, cancelado: true };
    const titulo = typeof corpo.titulo === 'string' && corpo.titulo.trim() ? corpo.titulo.trim().slice(0, 200) : 'Escolha a pasta do projeto';
    const r = await osascript(OSA_ESCOLHER, [titulo], 10 * 60e3);
    if (r.codigo !== 0) {
      if (/-128/.test(`${r.erro} ${r.saida}`)) return { ok: true, cancelado: true };
      throw erro(500, `A janela de escolher pasta falhou: ${`${r.erro} ${r.saida}`.trim().slice(0, 200) || 'código ' + r.codigo}.`, 'falhou');
    }
    let caminho = r.saida.trim();
    if (caminho.length > 1) caminho = caminho.replace(/\/+$/, '');
    if (!caminho || !path.isAbsolute(caminho)) throw erro(500, 'A janela de escolher pasta não devolveu um caminho.', 'falhou');
    return { ok: true, caminho };
  }

  const POSTS = {
    '/projetos/adicionar': adicionar,
    '/projetos/remover': remover,
    '/arquivos/novo': novo,
    '/arquivos/renomear': renomear,
    '/arquivos/colar': colarItens,
    '/arquivos/excluir': excluir,
    '/arquivos/buscar': buscar,
    '/arquivos/revelar': revelar,
    '/arquivos/escolher-pasta': escolherPasta,
  };

  async function rota(req, res, caminho, url) {
    if (typeof caminho !== 'string') return false;
    if (caminho !== '/projetos' && !caminho.startsWith('/projetos/') && !caminho.startsWith('/arquivos/')) return false;
    const q = url?.searchParams || new URLSearchParams();
    try {
      if (req.method === 'GET') {
        const gets = ['/projetos', '/arquivos/pastas', '/arquivos/lista', '/arquivos/ler', '/arquivos/realce', '/arquivos/bruto'];
        if (!gets.includes(caminho)) return false;
        await carregar();
        if (semeadoDoZero) {
          semeadoDoZero = false;
          if (semear()) { await emFila(gravar); difundirProjetos(); }
        }
        if (caminho === '/projetos') responder(res, 200, { projetos: publicos(), plataforma: so });
        else if (caminho === '/arquivos/pastas') responder(res, 200, await pastas(q));
        else if (caminho === '/arquivos/lista') responder(res, 200, await lista(q));
        else if (caminho === '/arquivos/ler') responder(res, 200, await ler(q));
        else if (caminho === '/arquivos/realce') responder(res, 200, await realcarArquivo(q));
        else await bruto(q, res);
        return true;
      }
      if (req.method !== 'POST') return false;
      const fn = POSTS[caminho];
      if (!fn) return false;
      if (req.headers['x-gerenciador'] !== '1') {
        responder(res, 403, { erro: 'Pedido sem o cabeçalho do Orbit.', motivo: 'cabecalho' });
        return true;
      }
      await carregar();
      if (semeadoDoZero) {
        semeadoDoZero = false;
        if (semear()) { await emFila(gravar); difundirProjetos(); }
      }
      const corpo = await lerJSONCorpo(req);
      if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) throw erro(400, 'Corpo inválido. Nada mudou.');
      const r = await fn(corpo);
      if (r && typeof r.status === 'number' && r.corpo) responder(res, r.status, r.corpo);
      else responder(res, 200, r);
    } catch (e) {
      let status = Number(e?.status) || 0;
      let msg = String(e?.message || e);
      if (!status) {
        if (e?.code === 'ENOENT') { status = 404; msg = 'Esse item não existe (pode ter sido movido ou apagado).'; }
        else if (e?.code === 'EEXIST') { status = 409; msg = 'Já existe um item com esse nome.'; }
        else if (e?.code === 'EPERM' || e?.code === 'EACCES' || e?.code === 'EBUSY') { status = 423; msg = `${nomeSO} não deixou (${e.code}): o item pode estar aberto em outro programa.`; }
        else status = 500;
      }
      if (status >= 500) log('arquivos: erro', caminho, e?.stack || e);
      responder(res, status, { erro: msg, ...(e?.motivo ? { motivo: e.motivo } : {}) });
    }
    return true;
  }

  function sessaoVista(s) {
    if (parado || !s || typeof s.cwd !== 'string' || !s.cwd) return;
    const cwd = s.cwd;
    carregar()
      .then(() => emFila(async () => {
        if (tentarEntrar(cwd)) {
          await gravar();
          difundirProjetos();
        }
      }))
      .catch((e) => log('arquivos: descoberta', e?.message || e));
  }

  function parar() {
    parado = true;
    for (const nome of [...vigias.keys()]) pararVigia(nome);
  }

  // projetos: a lista da lateral, também para a aba Repositórios e o card Sincronização (repos.mjs, 18/10).
  return { rota, sessaoVista, parar, lixeira: enviarLixeira, projetos: publicos }; // lixeira: também a da aba Skills (skills.mjs)
}
