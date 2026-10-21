// Orbit — repositórios do GitHub por projeto (rodada 7).
//
// Rotas (o servidor.mjs só encaixa: criarRepos(deps) e rota()):
//   GET  /repos/projetos            { projetos, pastaClones, github: { conectado, login, expirado } }
//   GET  /repos/projeto?pasta=      { projeto }, status fresco
//   GET  /repos/branches?pasta=     { atual, locais, remotos }
//   GET  /repos/github?forcar=1     { login, repos, lidoEm }
//   POST /repos/adicionar · remover · clonar · vincular · desvincular · criar · commit · buscar ·
//        push · pull · branch · ignorar · concluir · cancelar-juncao   (o que devolve projeto devolve { ok:true, projeto, … })
//   POST /repos/previa              { arquivos, lista, sugestao, sensiveis, credenciais, grandes, enormes, geradas }
//        prévia do commit de tudo, só leitura (card Sincronização da Visão geral, 18/10)
// Erros: { erro (texto para o usuário), codigo?, … }. Confirmação: 409 { codigo:'confirmar', titulo,
// mensagem, itens?, botao, perigo? } sem mudar nada; a página repete o corpo com confirmar:true.
//
// Regras (rodada 7):
//  - nada que descarte trabalho: não há force, reset --hard, clean, restore, stash drop, apagar branch,
//    pasta ou arquivo do projeto;
//  - as pastas acima da do Orbit (um repositório nelas levaria o Orbit e os outros projetos juntos) ficam fora do git: 403 'orbit';
//    a própria pasta do Orbit e as de dentro podem ter git desde 15/10 (decisão do usuário: o Orbit vai para o GitHub);
//  - o token só no ambiente do git (GIT_CONFIG_*, preso a https://github.com/) e no cabeçalho da API;
//    nunca em argv, arquivo, .git/config, log ou resposta. Toda saída do git passa por filtrar();
//  - uma operação por pasta; GIT_CEILING_DIRECTORIES = pasta-mãe (nunca age num repositório de cima);
//  - status com --no-optional-locks; fetch só por ação do usuário (no máximo 1 a cada 3 min no /buscar).
// ORBIT_GIT_BASE (remotos file:// no lugar de https://github.com/), ORBIT_GIT_LOG (grava o argv de
// cada git) e ORBIT_REPOS_PRAZO_MS (prazo curto das escritas) só valem junto com ORBIT_GITHUB_API.

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { WIN, MAC, acharNoPath, gitsPadrao, matarArvore, pathAmpliado } from './plataforma.mjs';

const API = String(process.env.ORBIT_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
const API_FALSA = !!process.env.ORBIT_GITHUB_API;
const BASE_GIT = API_FALSA && process.env.ORBIT_GIT_BASE ? String(process.env.ORBIT_GIT_BASE).replace(/\/*$/, '/') : 'https://github.com/';
const LOG_GIT = API_FALSA ? String(process.env.ORBIT_GIT_LOG || '') : '';
const PRAZO_TESTE = API_FALSA ? Number(process.env.ORBIT_REPOS_PRAZO_MS) || 0 : 0;
const CABECALHO_GIT = 'http.https://github.com/.extraheader';
// Mensagens com exemplo do sistema certo (16/10: o Orbit também roda no Mac).
export function textosDoSistema(so = process.platform) {
  if (so === 'win32') {
    return {
      exemploPasta: 'D:\\Projetos\\app',
      semGit: 'Não achei o Git neste computador. Instale o Git for Windows (git-scm.com) e tente de novo. Nada mudou.',
      usuario: 'outro usuário do Windows',
    };
  }
  return {
    exemploPasta: so === 'darwin' ? '/Users/voce/Projetos/app' : '/home/voce/projetos/app',
    semGit: so === 'darwin'
      ? 'Não achei o Git neste Mac. Instale com "xcode-select --install" (ou "brew install git") e tente de novo. Nada mudou.'
      : 'Não achei o Git neste computador. Instale o git pelo gerenciador de pacotes e tente de novo. Nada mudou.',
    usuario: 'outro usuário do sistema',
  };
}
const TXT = textosDoSistema();

const MS = { leitura: 20e3, escrita: PRAZO_TESTE || 120e3, clone: 15 * 60e3, api: 15e3 };
const MS_CACHE_STATUS = 2e3;
const MS_CACHE_SUB = 10e3;
const MS_CACHE_GITHUB = 60e3;
const MS_ENTRE_FETCH = 3 * 60e3;
const MS_PROGRESSO = 250;
const MAX_ARQUIVOS = 300;
const MAX_SAIDA = 16 * 1024 * 1024;
const MAX_PAGINAS = 10;
const PARALELO = 4;
const MAX_SUB = 20;

const DONO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NOME_REPO = /^[A-Za-z0-9._-]{1,100}$/;
const RESERVADO_WIN = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;
const ORIGENS = new Set(['manual', 'clone', 'criado']);

// Variáveis herdadas que mudariam o repositório, a identidade ou o idioma do git (ou abririam janela).
const ENV_FORA = /^(?:GIT_TRACE\w*|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_COMMON_DIR|GIT_NAMESPACE|GIT_PREFIX|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM|GIT_ASKPASS|SSH_ASKPASS|GIT_TERMINAL_PROMPT|GCM_INTERACTIVE|GIT_AUTHOR_\w+|GIT_COMMITTER_\w+|GIT_LITERAL_PATHSPECS|GIT_GLOB_PATHSPECS|GIT_NOGLOB_PATHSPECS|GIT_ICASE_PATHSPECS|GIT_QUARANTINE_PATH|GIT_REDIRECT_\w+|GIT_MERGE_AUTOEDIT|GIT_OPTIONAL_LOCKS|LC_ALL|LC_MESSAGES|LANG|LANGUAGE)$/i;

// ───────────────────────── utilidades ─────────────────────────

function encurtar(t, max) {
  const s = String(t ?? '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function erroHttp(status, erro, codigo, extra) {
  const e = new Error(erro);
  e.status = status;
  if (codigo) e.codigo = codigo;
  if (extra) e.extra = extra;
  return e;
}

// 409 da primeira etapa: nada foi feito; a página mostra o diálogo e repete com confirmar:true.
function pedirConfirmacao({ titulo, mensagem, itens, botao, perigo, analise }) {
  const e = new Error(titulo);
  e.status = 409;
  e.codigo = 'confirmar';
  e.corpo = { codigo: 'confirmar', titulo, mensagem, ...(itens && itens.length ? { itens } : {}), botao, ...(perigo ? { perigo: true } : {}), ...(analise ? { analise } : {}) };
  return e;
}

function responder(res, codigo, corpo) {
  if (res.headersSent) return;
  res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

// Apaga o token (puro e no base64 do cabeçalho) e toda linha/registro com "authorization:".
function filtrar(texto, token) {
  let s = String(texto ?? '');
  if (token) {
    s = s.split(token).join('***');
    s = s.split(Buffer.from('x-access-token:' + token).toString('base64')).join('***');
  }
  return s.replace(/[^\n\0]*authorization\s*:[^\n\0]*/gi, '');
}

// A linha que explica a falha (fatal:/error:), sem dicas nem avisos de fim de linha.
function resumoGit(r, max = 300) {
  const linhas = `${r.err || ''}\n${r.out || ''}`.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^hint:/i.test(l) && !/^warning: in the working copy/i.test(l) && !/^remote: (Enumerating|Counting|Compressing|Total)/i.test(l));
  const fatal = linhas.find((l) => /^(fatal|error):/i.test(l));
  const linha = fatal || linhas[linhas.length - 1] || `o git saiu com ${r.codigo}`;
  return encurtar(linha.replace(/^(fatal|error):\s*/i, '').replace(/\.$/, ''), max);
}

// ───────────────────────── pastas ─────────────────────────

// Só caminhos absolutos com letra de unidade (nada de UNC, \\?\, relativos ou dispositivos).
function resolverPasta(bruta) {
  if (typeof bruta !== 'string') return null;
  const s = bruta.trim();
  if (!s || s.length > 500 || /[\0\r\n]/.test(s)) return null;
  if (/^[\\/]{2}/.test(s)) return null;
  if (WIN ? !/^[A-Za-z]:[\\/]/.test(s) : !path.isAbsolute(s)) return null;
  let p = path.resolve(s);
  if (p.length > path.parse(p).root.length) p = p.replace(/[\\/]+$/, '');
  return p;
}

// Chave do projeto sem diferenciar maiúsculas no Windows e no Mac (o APFS padrão também não diferencia; 16/10:
// a página casa o "vinculadoA" e as pastas pelas chaves, como no Windows). O Linux diferencia.
const chaveDe = (p) => (WIN || MAC ? p.toLowerCase() : p);
const nomeDe = (p) => path.basename(p) || p;

function mesmaPasta(a, b) {
  const real = (x) => {
    try { return chaveDe(fs.realpathSync.native(path.resolve(x))); } catch { return chaveDe(path.resolve(x)); }
  };
  try {
    return chaveDe(path.resolve(a)) === chaveDe(path.resolve(b)) || real(a) === real(b);
  } catch {
    return false;
  }
}

async function ehPasta(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

async function pastaVazia(p) {
  try {
    const d = await fsp.opendir(p);
    const x = await d.read();
    await d.close();
    return !x;
  } catch {
    return false;
  }
}

const existe = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

// O remote.origin.url lido direto do config do repositório (sem rodar o git; o worktree segue o commondir).
function origemRapida(pasta) {
  try {
    let dir = path.join(pasta, '.git');
    if (fs.statSync(dir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dir, 'utf8'));
      if (!m) return null;
      dir = path.resolve(pasta, m[1].trim());
      const comum = path.join(dir, 'commondir');
      if (existe(comum)) dir = path.resolve(dir, fs.readFileSync(comum, 'utf8').trim());
    }
    const m = /^\s*\[remote "origin"\][^[]*?^\s*url\s*=\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(dir, 'config'), 'utf8'));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Um .git numa pasta de cima (só para avisar; o Orbit nunca age nele).
function repoAcima(pasta) {
  let d = path.dirname(pasta);
  for (let i = 0; i < 40; i++) {
    if (existe(path.join(d, '.git'))) return d;
    const cima = path.dirname(d);
    if (cima === d) return null;
    d = cima;
  }
  return null;
}

function nomePastaValido(n) {
  return typeof n === 'string' && n.length >= 1 && n.length <= 100 && !/[<>:"/\\|?*\x00-\x1f]/.test(n) &&
    n !== '.' && n !== '..' && !/[. ]$/.test(n) && !/^\s/.test(n) && !RESERVADO_WIN.test(n);
}

function caminhoValido(p) {
  return typeof p === 'string' && p.length >= 1 && p.length <= 4096 && !/[\0\\]/.test(p) && !/^\//.test(p) &&
    !/^[A-Za-z]:/.test(p) && !p.split('/').includes('..');
}

// Arquivos que costumam guardar segredo (pedem confirmação no commit e aparecem no aviso do criar).
function sensivel(caminho) {
  const b = String(caminho).replace(/\/+$/, '').split('/').pop().toLowerCase();
  return b.startsWith('.env') || b.endsWith('.pem') || b.endsWith('.key') || b.startsWith('id_rsa') ||
    b.endsWith('.pfx') || /^credentials.*\.json$/.test(b) || b.endsWith('.keystore');
}

// Credenciais procuradas nas linhas novas de um commit (18/10). O valor
// nunca sai daqui: só arquivo, linha e tipo.
const CREDENCIAIS = [
  ['token do GitHub', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['token do GitHub', /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['chave da Anthropic', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['chave da OpenAI', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['chave da AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['chave do Google', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['chave do Stripe', /\b[sr]k_live_[A-Za-z0-9]{20,}/],
  ['token do Slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['chave privada', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
];
// Tokens falsos de testes (repetições, "EXEMPLO"…) só valem em arquivos de teste.
const FALSO_DE_TESTE = /(.)\1{9,}|T3st|FALSO|falso|EXEMPLO|EXAMPLE|example|dummy|fake/;
const ARQUIVO_DE_TESTE = /(?:^|\/)(?:testes?|tests?|__tests__|spec|fixtures?)\/|\.(?:test|spec)\.[^/]+$/i;
// O que não costuma ir para o git: lixo do sistema e pastas geradas por ferramentas (dependências, build, cache).
const LIXO_SISTEMA = /^(?:\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
const PASTAS_GERADAS = new Set(['node_modules', 'pods', 'deriveddata', '.gradle', '.next', '.nuxt', '.expo', '.turbo', '.parcel-cache', '.cache',
  '__pycache__', '.venv', 'venv', '.pytest_cache', 'coverage', '.dart_tool', 'build', 'dist']);
const MB = 1024 * 1024;
const LIMITE_GITHUB = 100 * MB; // o GitHub recusa o push com arquivo acima disso
const ARQUIVO_GRANDE = 50 * MB; // o GitHub avisa acima disso
const MAX_LER = { arquivo: MB, total: 32 * MB, arquivos: 3000 };
const MAX_ACHADOS = 50;
// Padrão de .gitignore aceito pelo /repos/ignorar: caminho simples, sem "..", sem "!" e sem quebra de linha.
const padraoIgnoravel = (x) => typeof x === 'string' && x.length >= 1 && x.length <= 200 && /^[\w.\-/ *@+]+$/.test(x) && !x.split('/').includes('..') && x.replace(/[/*]/g, '') !== '';

// Caminho de arquivo não rastreado (como o git status mostra) para o /repos/ignorar local: relativo, sem ".." e sem
// quebra de linha. padraoExato vira a linha do info/exclude que casa só com ele (ancorada, curingas escapados).
const caminhoIgnoravel = (x) => typeof x === 'string' && x.length >= 1 && x.length <= 500 && !/[\0-\x1f]/.test(x)
  && !x.startsWith('/') && !x.split('/').includes('..') && x.replace(/\//g, '') !== '';
const padraoExato = (x) => '/' + x.replace(/[\\*?[\]!#]/g, '\\$&').replace(/ $/, '\\ ');

// ───────────────────────── remotos ─────────────────────────

const urlDoRepo = (dono, nome) => `${BASE_GIT}${dono}/${nome}.git`;

function repoDe(dono, nome) {
  nome = String(nome).replace(/\.git$/i, '');
  if (!DONO.test(dono) || !NOME_REPO.test(nome) || nome === '.' || nome === '..') return null;
  return { completo: `${dono}/${nome}`, dono, nome, url: `https://github.com/${dono}/${nome}` };
}

// dono/nome a partir da URL do origin (https, ssh ou, em teste, ORBIT_GIT_BASE).
function repoDaUrl(url) {
  const u = String(url || '').trim();
  let m = /^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)\/?$/i.exec(u) ||
    /^(?:ssh:\/\/)?git@(?:ssh\.)?github\.com(?::443)?[:/]([^/]+)\/([^/]+?)\/?$/i.exec(u);
  if (!m && BASE_GIT !== 'https://github.com/' && u.toLowerCase().startsWith(BASE_GIT.toLowerCase())) {
    m = /^([^/]+)\/([^/]+?)\/?$/.exec(u.slice(BASE_GIT.length));
  }
  return m ? repoDe(m[1], m[2]) : null;
}

const ehSsh = (url) => /^ssh:\/\//i.test(url) || /^[\w.-]+@[\w.-]+:/.test(url);
const semCredenciais = (url) => String(url || '').replace(/^(https?:\/\/)[^@/]*@/i, '$1');

function exigirRepo(bruto) {
  const m = typeof bruto === 'string' ? /^([^/\s]+)\/([^/\s]+)$/.exec(bruto.trim()) : null;
  const r = m && !/\.git$/i.test(m[2]) ? repoDe(m[1], m[2]) : null;
  if (!r) throw erroHttp(400, 'Repositório inválido: use dono/nome. Nada mudou.', 'repo');
  return r;
}

// ───────────────────────── git ─────────────────────────

let gitAchado = { exe: undefined, em: 0 };
function acharGit() {
  if (gitAchado.exe) return gitAchado.exe;
  if (gitAchado.exe === null && Date.now() - gitAchado.em < 30e3) return null;
  let achado = null;
  // PATH (no Mac, o ampliado: o launchd sobe o Orbit sem o Homebrew no PATH), depois os lugares de costume.
  // No Windows só vale o git.exe: um git.cmd não roda sem shell.
  const doPath = acharNoPath('git');
  if (doPath && path.isAbsolute(doPath) && (!WIN || /\.exe$/i.test(doPath))) achado = doPath;
  for (const c of achado ? [] : gitsPadrao()) {
    try { if (fs.statSync(c).isFile()) { achado = c; break; } } catch {}
  }
  gitAchado = { exe: achado, em: Date.now() };
  return achado;
}

function ambiente({ cwd, token, identidade, ssh }) {
  const env = {};
  let n = 0;
  for (const [k, v] of Object.entries(process.env)) {
    if (ENV_FORA.test(k)) continue;
    if (/^GIT_CONFIG_COUNT$/i.test(k)) { n = /^\s*\d{1,4}\s*$/.test(String(v)) ? Number(v) : 0; continue; }
    env[k] = v;
  }
  if (!WIN) env.PATH = pathAmpliado(); // hooks e credential helpers do Homebrew no Mac
  // Os do usuário (se houver) ficam; os nossos vão depois deles.
  const cfg = [['credential.helper', ''], ['core.askPass', ''], ['core.quotePath', 'false']];
  if (token) cfg.push([CABECALHO_GIT, 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + token).toString('base64')]);
  for (const [k, v] of cfg) {
    env[`GIT_CONFIG_KEY_${n}`] = k;
    env[`GIT_CONFIG_VALUE_${n}`] = v;
    n++;
  }
  env.GIT_CONFIG_COUNT = String(n);
  env.GIT_CEILING_DIRECTORIES = path.dirname(cwd);
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  env.GIT_ASKPASS = '';
  env.SSH_ASKPASS = '';
  env.LC_ALL = 'C';
  env.GIT_MERGE_AUTOEDIT = 'no';
  if (ssh) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  if (identidade) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = identidade.nome;
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = identidade.email;
  }
  return env;
}

// Mata o git e a árvore dele (Windows: taskkill /T /F; Mac: SIGKILL nos descendentes). Se ele ainda estiver
// vivo depois (taskkill não rodou, por exemplo), o kill direto.
function matar(p) {
  const direto = () => { if (p.exitCode === null && p.signalCode === null) { try { p.kill('SIGKILL'); } catch {} } };
  if (!p.pid) return direto();
  matarArvore(p.pid).then(direto, direto);
}

// Roda o git sem shell, com argv em array. Devolve { codigo, out, err, estourou } já filtrados.
// op: { cwd, token, entrada, prazo, identidade, ssh, aoErro(chunk) }
function git(args, op) {
  const exe = acharGit();
  if (!exe) return Promise.reject(erroHttp(503, TXT.semGit, 'sem-git'));
  const cwd = op.cwd;
  const token = op.token || '';
  const env = ambiente({ cwd, token, identidade: op.identidade, ssh: op.ssh });
  if (LOG_GIT) {
    try { fs.appendFileSync(LOG_GIT, JSON.stringify({ cwd, args }) + '\n'); } catch {}
  }
  return new Promise((resolve) => {
    let fim = false;
    let estourou = false;
    let prazo = null;
    const out = [];
    const err = [];
    let tOut = 0;
    let tErr = 0;
    const acabar = (codigo, extra = '') => {
      if (fim) return;
      fim = true;
      clearTimeout(prazo);
      resolve({
        codigo,
        estourou,
        out: filtrar(Buffer.concat(out).toString('utf8'), token),
        err: filtrar(Buffer.concat(err).toString('utf8') + extra, token),
      });
    };
    let p;
    try {
      p = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      acabar(-1, String(e?.message || e));
      return;
    }
    // No estouro: mata a árvore e responde logo. Um neto (ex.: `sleep` de um hook do sh do Git) pode
    // escapar do taskkill e segurar os pipes; por isso não espera o 'close' depois de matar.
    const largar = () => {
      try { p.stdout.destroy(); } catch {}
      try { p.stderr.destroy(); } catch {}
      acabar(-1);
    };
    prazo = setTimeout(() => {
      estourou = true;
      matar(p);
      setTimeout(largar, 3000).unref?.();
    }, op.prazo || MS.leitura);
    p.on('exit', () => { if (estourou) setTimeout(largar, 300); });
    p.stdout.on('data', (c) => { if (tOut < MAX_SAIDA) { out.push(c); tOut += c.length; } });
    p.stderr.on('data', (c) => {
      if (tErr < MAX_SAIDA) { err.push(c); tErr += c.length; }
      if (op.aoErro) { try { op.aoErro(c); } catch {} }
    });
    p.on('error', (e) => acabar(-1, '\n' + (e?.message || e)));
    p.on('close', (codigo) => acabar(codigo ?? -1));
    p.stdin.on('error', () => {});
    p.stdin.end(op.entrada != null ? op.entrada : undefined);
  });
}

// Classifica a falha do git num erro para o usuário. ctx: { token, faltando, mudou, aposPrazo }
function erroGit(r, ctx = {}) {
  const nada = ctx.mudou ?? 'Nada mudou.';
  if (r.estourou) return erroHttp(504, `O git demorou demais e foi interrompido. ${ctx.aposPrazo || nada}`.trim(), 'prazo');
  const t = `${r.err}\n${r.out}`;
  if (/Repository not found|repository '[^']*' not found|returned error: 404|does not appear to be a git repository/i.test(t)) {
    if (!ctx.token) return erroHttp(409, `O GitHub não mostrou o repositório. Se ele for privado, conecte o GitHub pelo botão de perfil. ${nada}`.trim(), 'sem-github');
    const faltando = ctx.faltando || ['contents:read'];
    return erroHttp(403, `O GitHub não achou o repositório ou o token não tem acesso a ele (falta ${faltando.join(', ')}). ${nada}`.trim(), 'permissao', { faltando });
  }
  if (/returned error: 403|Permission to \S+ denied|Write access to repository not granted|permission denied to/i.test(t)) {
    const faltando = ctx.faltando || ['contents:write'];
    return erroHttp(403, `O token do GitHub não tem permissão para isso (falta ${faltando.join(', ')}). ${nada}`.trim(), 'permissao', { faltando });
  }
  if (/Authentication failed|returned error: 401|could not read (Username|Password)|terminal prompts disabled|Invalid username or (password|token)/i.test(t)) {
    if (ctx.token) {
      const e = erroHttp(401, `O GitHub recusou o token (vencido ou revogado). Conecte de novo pelo botão de perfil. ${nada}`.trim(), 'expirado');
      e.verificar = true;
      return e;
    }
    return erroHttp(409, `O servidor pediu login. Conecte o GitHub pelo botão de perfil. ${nada}`.trim(), 'sem-github');
  }
  if (/Permission denied \(publickey|Host key verification failed/i.test(t)) {
    return erroHttp(403, `O SSH recusou a chave deste computador para este remote. ${nada}`.trim(), 'ssh');
  }
  if (/Could not resolve host|Failed to connect|Connection (timed out|refused|reset)|Operation timed out|early EOF|RPC failed|SSL|schannel|gnutls|Network is unreachable/i.test(t)) {
    return erroHttp(502, `Não consegui falar com o GitHub. Confira a internet e tente de novo. ${nada}`.trim(), 'rede');
  }
  if (/detected dubious ownership/i.test(t)) {
    return erroHttp(409, `O git não confia nesta pasta porque ela pertence a ${TXT.usuario}. ${nada}`.trim(), 'dono');
  }
  if (/index\.lock|Unable to create '[^']*\.lock'|cannot lock ref/i.test(t)) {
    return erroHttp(409, `Outro programa está usando o git nesta pasta agora. Espere um pouco e tente de novo. ${nada}`.trim(), 'travado');
  }
  return erroHttp(500, `O git falhou: ${resumoGit(r)}. ${nada}`.trim(), 'git');
}

// Arquivos da mensagem "would be overwritten by merge/checkout" (o git recusou e nada mudou).
function arquivosSobrescritos(r) {
  const t = `${r.err}\n${r.out}`;
  if (!/would be (overwritten|removed|lost) by/i.test(t)) return null;
  const arquivos = [];
  let dentro = false;
  for (const l of t.split(/\r?\n/)) {
    if (/would be (overwritten|removed|lost) by/i.test(l)) { dentro = true; continue; }
    if (dentro && /^\t/.test(l)) { arquivos.push(l.trim()); continue; }
    if (dentro && l.trim()) dentro = false;
  }
  return arquivos.slice(0, MAX_ARQUIVOS);
}

function separarCampos(l, n) {
  const partes = [];
  let i = 0;
  for (let k = 0; k < n; k++) {
    const j = l.indexOf(' ', i);
    if (j < 0) return null;
    partes.push(l.slice(i, j));
    i = j + 1;
  }
  partes.push(l.slice(i));
  return partes;
}

function entradaComum(xy, caminho) {
  const X = xy[0];
  const Y = xy[1];
  let tipo = 'modificado';
  if (X === 'A') tipo = 'novo';
  if (X === 'D' || Y === 'D') tipo = 'apagado';
  return { caminho, tipo, preparado: X !== '.' };
}

const NOME_OPERACAO = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' };
const erroOperacao = (op) => erroHttp(409, `Há um ${NOME_OPERACAO[op] || op} em andamento nesta pasta. Termine ou cancele no editor ou no terminal antes. Nada mudou.`, 'operacao');
const erroOrbit = () => erroHttp(403, 'Esta pasta contém o Orbit e outros projetos; um repositório nela levaria todos juntos. Nada mudou.', 'orbit');

// ───────────────────────── módulo ─────────────────────────

export function criarRepos(deps) {
  const { difundir = () => {}, lerJSONCorpo, log = () => {} } = deps;
  const sessoes = typeof deps.sessoes === 'function' ? deps.sessoes : () => [];
  const github = deps.github || {};
  const pastaOrbit = path.resolve(deps.pastaOrbit);
  const chaveOrbit = chaveDe(pastaOrbit);
  const ARQ = path.join(path.resolve(deps.dados), 'repos.json');

  // ── registro (repos.json) ──
  const registro = { projetos: {}, pastaClones: null };
  try {
    const j = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
    for (const v of Object.values(j?.projetos || {})) {
      const p = resolverPasta(v?.pasta);
      if (p && ORIGENS.has(v.origem)) registro.projetos[chaveDe(p)] = { pasta: p, adicionado: Number(v.adicionado) || Date.now(), origem: v.origem };
    }
    registro.pastaClones = resolverPasta(j?.pastaClones) || null;
  } catch {}

  let filaGravar = Promise.resolve();
  function salvarRegistro() {
    const dados = JSON.stringify(registro, null, 2);
    filaGravar = filaGravar.then(async () => {
      await fsp.mkdir(path.dirname(ARQ), { recursive: true });
      const tmp = `${ARQ}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, dados);
      await fsp.rename(tmp, ARQ);
    }).catch((e) => log('repos: gravar repos.json:', e?.message || e));
    return filaGravar;
  }

  const pastaClones = () => registro.pastaClones || path.dirname(pastaOrbit);
  const avisarLista = () => difundir('repos', { tipo: 'lista' });
  const avisarProjeto = (projeto) => difundir('repos', { tipo: 'projeto', projeto });

  // Só as pastas acima da do Orbit (um repositório nelas incluiria o Orbit e os projetos vizinhos).
  function relacaoOrbit(chave) {
    if (chave === chaveOrbit || chave.startsWith(chaveOrbit + path.sep)) return false;
    const raiz = chave.endsWith(path.sep) ? chave : chave + path.sep;
    return chaveOrbit.startsWith(raiz);
  }

  // Mac (20/10): a pasta do projeto Orbit é a de cima da do código (Tudo/Orbit, com app/ e brain/,
  // cada um um clone do repositório do Orbit), e não a própria pasta do código como no PC. Ela segue sem git (um repositório nela
  // levaria os clones juntos), mas mostra os repositórios de dentro como um projeto comum, desde que todos sejam do mesmo
  // repositório do GitHub que o Orbit: a pasta de projetos do PC, com outros repositórios, continua de fora.
  function maeDoOrbit(chave) {
    if (chave !== chaveDe(path.dirname(pastaOrbit))) return false;
    const doGithub = (p) => repoDaUrl(origemRapida(p) || '')?.completo.toLowerCase() || null;
    const alvo = doGithub(pastaOrbit);
    const subs = subrepos(path.dirname(pastaOrbit), chave);
    return !!alvo && subs.some((p) => chaveDe(p) === chaveOrbit) && subs.every((p) => doGithub(p) === alvo);
  }

  // Repositórios nas subpastas de um projeto (18/10): a pasta de um projeto tem um clone por
  // branch (app/, brain/, main/) e o card da Visão geral mostra todos. Só um nível, sem pastas ocultas, atalhos
  // nem node_modules; guardado por 10 s.
  const cacheSub = new Map(); // chave → { em, pastas }
  function subrepos(pasta, chave) {
    const c = cacheSub.get(chave);
    if (c && Date.now() - c.em < MS_CACHE_SUB) return c.pastas;
    let pastas = [];
    try {
      pastas = fs.readdirSync(pasta, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && existe(path.join(pasta, d.name, '.git')))
        .map((d) => path.join(pasta, d.name))
        .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }))
        .slice(0, MAX_SUB);
    } catch {}
    cacheSub.set(chave, { em: Date.now(), pastas });
    return pastas;
  }

  // Projetos = pastas das sessões conhecidas ∪ projetos da lateral ∪ registro ∪ repositórios das subpastas deles.
  function entradas() {
    const mapa = new Map();
    try {
      for (const s of sessoes()) {
        const p = resolverPasta(s?.cwd);
        if (!p) continue;
        const c = chaveDe(p);
        if (!mapa.has(c)) mapa.set(c, { chave: c, pasta: p, origem: 'sessao', sessao: true });
      }
    } catch {}
    try {
      for (const l of deps.lateral?.() || []) {
        const p = l && l.existe !== false ? resolverPasta(l.pasta) : null;
        if (!p) continue;
        const c = chaveDe(p);
        if (!mapa.has(c)) mapa.set(c, { chave: c, pasta: p, origem: 'lateral', sessao: false });
      }
    } catch {}
    for (const [c, r] of Object.entries(registro.projetos)) {
      mapa.set(c, { chave: c, pasta: r.pasta, origem: r.origem, sessao: mapa.has(c) });
    }
    for (const e of [...mapa.values()]) {
      if (relacaoOrbit(e.chave) && !maeDoOrbit(e.chave)) continue;
      for (const p of subrepos(e.pasta, e.chave)) {
        const c = chaveDe(p);
        if (!mapa.has(c)) mapa.set(c, { chave: c, pasta: p, origem: 'subpasta', sessao: false, mae: e.pasta });
      }
    }
    return [...mapa.values()];
  }

  function exigirPasta(bruta) {
    const p = resolverPasta(bruta);
    if (!p) throw erroHttp(400, `Pasta inválida: use o caminho completo (ex.: ${TXT.exemploPasta}). Nada mudou.`, 'pasta');
    return p;
  }

  function exigirProjeto(bruta) {
    const pasta = exigirPasta(bruta);
    const chave = chaveDe(pasta);
    if (relacaoOrbit(chave)) throw erroOrbit();
    const ent = entradas().find((e) => e.chave === chave);
    if (!ent) throw erroHttp(404, 'Esta pasta não está na lista de projetos. Adicione-a primeiro. Nada mudou.', 'desconhecida');
    return ent;
  }

  // ── GitHub (conta e token vêm do perfil.mjs, na hora) ──
  let expiradoVisto = null; // login cuja conta o GitHub recusou (até reconectar)

  function contaSegura() {
    try { return github.conta?.() || null; } catch { return null; }
  }

  async function tokenSeHouver() {
    try { return (await github.token?.()) || null; } catch { return null; }
  }

  // Só pede o token quando o remote é do GitHub (o cabeçalho fica preso a https://github.com/).
  const tokenPara = (url) => (repoDaUrl(url) ? tokenSeHouver() : Promise.resolve(null));

  function estadoGithub() {
    try {
      const pub = github.publico?.();
      if (pub && 'github' in pub) {
        const g = pub.github;
        return { conectado: !!g, login: g?.login || null, expirado: !!g?.expirado };
      }
    } catch {}
    const c = contaSegura();
    if (c) {
      expiradoVisto = null;
      return { conectado: true, login: c.login, expirado: false };
    }
    return { conectado: !!expiradoVisto, login: expiradoVisto, expirado: !!expiradoVisto };
  }

  async function exigirGithub() {
    const conta = contaSegura();
    if (!conta) {
      if (expiradoVisto) throw erroHttp(401, 'O token do GitHub não vale mais. Conecte de novo pelo botão de perfil. Nada mudou.', 'expirado');
      throw erroHttp(409, 'Conecte o GitHub pelo botão de perfil para usar esta função. Nada mudou.', 'sem-github');
    }
    const token = await tokenSeHouver();
    if (!token) {
      const e = erroHttp(401, 'O token do GitHub não abriu ou não vale mais. Conecte de novo pelo botão de perfil. Nada mudou.', 'expirado');
      e.verificar = true;
      throw e;
    }
    return { conta, token };
  }

  // O token só vai para a origem da API (nem redirecionamento, nem "next" de outro host).
  async function pedirGithub(url, { metodo = 'GET', token, corpo } = {}) {
    if (new URL(url).origin !== new URL(API).origin) throw erroHttp(502, 'O GitHub mandou um endereço inesperado. Nada mudou.', 'rede');
    try {
      return await fetch(url, {
        method: metodo,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: 'Bearer ' + token,
          'user-agent': 'Orbit',
          'x-github-api-version': '2022-11-28',
          ...(corpo ? { 'content-type': 'application/json' } : {}),
        },
        body: corpo ? JSON.stringify(corpo) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(MS.api),
      });
    } catch {
      throw erroHttp(502, 'Não consegui falar com o GitHub. Confira a internet e tente de novo. Nada mudou.', 'rede');
    }
  }

  function permissoesDoCabecalho(v) {
    if (!v) return null;
    const lista = String(v).split(';')[0].split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => { const [k, n] = s.split('='); return k && n ? `${k.trim()}:${n.trim()}` : null; }).filter(Boolean);
    return lista.length ? lista : null;
  }

  function erroApi(r, faltandoPadrao, nada = 'Nada mudou.') {
    if (r.status === 401) {
      const e = erroHttp(401, `O GitHub recusou o token (vencido ou revogado). Conecte de novo pelo botão de perfil. ${nada}`, 'expirado');
      e.verificar = true;
      return e;
    }
    if (r.status === 429 || (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0')) {
      return erroHttp(502, `O GitHub limitou os pedidos agora. Tente de novo em alguns minutos. ${nada}`, 'rede');
    }
    if (r.status === 403 || r.status === 404) {
      const faltando = permissoesDoCabecalho(r.headers.get('x-accepted-github-permissions')) || faltandoPadrao;
      return erroHttp(403, `O token do GitHub não tem permissão para isso (falta ${faltando.join(', ')}). ${nada}`, 'permissao', { faltando });
    }
    return erroHttp(502, `O GitHub respondeu ${r.status}. Tente de novo. ${nada}`, 'rede');
  }

  function repoDaApi(x) {
    if (!x || typeof x !== 'object') return null;
    const base = repoDe(x.owner?.login, x.name);
    if (!base) return null;
    const vis = x.visibility === 'public' ? 'publico' : x.visibility === 'internal' ? 'interno' : x.visibility === 'private' ? 'privado' : x.private ? 'privado' : 'publico';
    return {
      id: Number(x.id) || 0,
      completo: base.completo,
      dono: base.dono,
      nome: base.nome,
      descricao: typeof x.description === 'string' ? encurtar(x.description, 500) : '',
      visibilidade: vis,
      branchPadrao: typeof x.default_branch === 'string' && x.default_branch ? x.default_branch : 'main',
      atualizado: Date.parse(x.pushed_at || x.updated_at) || 0,
      url: base.url,
      arquivado: !!x.archived,
      fork: !!x.fork,
      linguagem: typeof x.language === 'string' ? x.language : null,
      podeEnviar: x.permissions?.push === true,
      vinculadoA: [],
    };
  }

  async function repoNoGithub(alvo, token) {
    const r = await pedirGithub(`${API}/repos/${alvo.dono}/${alvo.nome}`, { token });
    if (!r.ok) throw erroApi(r, ['metadata:read']);
    const repo = repoDaApi(await r.json().catch(() => null));
    if (!repo) throw erroHttp(502, 'O GitHub mandou uma resposta inesperada. Nada mudou.', 'rede');
    return repo;
  }

  function proximaPagina(link) {
    for (const parte of String(link || '').split(',')) {
      const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(parte);
      if (!m) continue;
      try {
        const u = new URL(m[1]);
        return u.origin === new URL(API).origin ? u.href : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  let cacheGithub = null; // { login, repos, lidoEm }
  async function listarGithub(forcar) {
    const { conta, token } = await exigirGithub();
    if (forcar || !cacheGithub || cacheGithub.login !== conta.login || Date.now() - cacheGithub.lidoEm > MS_CACHE_GITHUB) {
      let url = `${API}/user/repos?per_page=100&sort=pushed&direction=desc&affiliation=owner,collaborator,organization_member`;
      const repos = [];
      const vistos = new Set();
      for (let pag = 0; pag < MAX_PAGINAS && url; pag++) {
        const r = await pedirGithub(url, { token });
        if (!r.ok) throw erroApi(r, ['metadata:read']);
        const lista = await r.json().catch(() => null);
        if (!Array.isArray(lista)) throw erroHttp(502, 'O GitHub mandou uma resposta inesperada. Tente de novo.', 'rede');
        for (const x of lista) {
          const repo = repoDaApi(x);
          if (repo && !vistos.has(repo.completo.toLowerCase())) { vistos.add(repo.completo.toLowerCase()); repos.push(repo); }
        }
        url = proximaPagina(r.headers.get('link'));
      }
      repos.sort((a, b) => b.atualizado - a.atualizado);
      cacheGithub = { login: conta.login, repos, lidoEm: Date.now() };
    }
    // "Vinculado a": o origin de cada projeto (status em cache de 2 s).
    const porRepo = new Map();
    for (const p of await listarProjetos()) {
      if (!p.repo) continue;
      const k = p.repo.completo.toLowerCase();
      if (!porRepo.has(k)) porRepo.set(k, []);
      porRepo.get(k).push(p.chave);
    }
    return {
      login: cacheGithub.login,
      repos: cacheGithub.repos.map((r) => ({ ...r, vinculadoA: porRepo.get(r.completo.toLowerCase()) || [] })),
      lidoEm: cacheGithub.lidoEm,
    };
  }

  // ── leitura do git (sem travas: outras sessões usam os mesmos repositórios) ──
  const ultimoFetch = new Map(); // chave → ms

  async function inspecionar(pasta) {
    const r = await git(['rev-parse', '--show-toplevel', '--git-path', 'MERGE_HEAD', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply',
      '--git-path', 'CHERRY_PICK_HEAD', '--git-path', 'REVERT_HEAD', '--git-path', 'FETCH_HEAD', '--git-path', 'hooks'], { cwd: pasta });
    if (r.estourou) throw erroHttp(504, 'O git demorou demais para ler esta pasta.', 'prazo');
    if (r.codigo !== 0) {
      if (/dubious ownership/i.test(r.err)) return { git: false, erro: `O git não confia nesta pasta (ela pertence a ${TXT.usuario}).` };
      if (/not a git repository/i.test(r.err)) {
        return existe(path.join(pasta, '.git')) ? { git: false, quebrado: true, erro: `A pasta tem .git, mas o git não a abriu: ${resumoGit(r)}.` } : { git: false };
      }
      return { git: false, quebrado: existe(path.join(pasta, '.git')), erro: `O git não leu esta pasta: ${resumoGit(r)}.` };
    }
    const l = r.out.split(/\r?\n/);
    // Regra 9: git:true só quando o repositório é o da própria pasta.
    if (l.length < 9 || !mesmaPasta(l[0], pasta)) return { git: false, quebrado: true, erro: 'O repositório git desta pasta começa em outra pasta.' };
    const abs = (x) => path.resolve(pasta, x);
    let operacao = null;
    if (existe(abs(l[2])) || existe(abs(l[3]))) operacao = 'rebase';
    else if (existe(abs(l[1]))) operacao = 'merge';
    else if (existe(abs(l[4]))) operacao = 'cherry-pick';
    else if (existe(abs(l[5]))) operacao = 'revert';
    let fetchHead = 0;
    try { fetchHead = fs.statSync(abs(l[6])).mtimeMs; } catch {}
    return { git: true, operacao, fetchHead, hooks: abs(l[7]), mergeHead: abs(l[1]) };
  }

  async function lerStatus(pasta, info, todos = false) {
    const r = await git(['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', todos ? '--untracked-files=all' : '--untracked-files=normal'], { cwd: pasta });
    if (r.estourou) throw erroHttp(504, 'O git demorou demais para ler o status desta pasta.', 'prazo');
    if (r.codigo !== 0) throw erroGit(r, { mudou: '' });
    const st = { branch: null, oid: null, upstream: null, adiante: 0, atras: 0, semCommits: false, arquivos: [], operacao: info?.operacao || null, lidoEm: Date.now() };
    const partes = r.out.split('\0');
    for (let i = 0; i < partes.length; i++) {
      const l = partes[i];
      if (!l) continue;
      if (l.startsWith('# ')) {
        const sp = l.indexOf(' ', 2);
        const k = sp < 0 ? l.slice(2) : l.slice(2, sp);
        const v = sp < 0 ? '' : l.slice(sp + 1);
        if (k === 'branch.oid') { if (v === '(initial)') st.semCommits = true; else st.oid = v; }
        else if (k === 'branch.head') st.branch = v === '(detached)' ? null : v;
        else if (k === 'branch.upstream') st.upstream = v || null;
        else if (k === 'branch.ab') {
          const m = /^\+(\d+) -(\d+)$/.exec(v);
          if (m) { st.adiante = Number(m[1]); st.atras = Number(m[2]); }
        }
        continue;
      }
      if (l[0] === '1') {
        const c = separarCampos(l, 8);
        if (c) st.arquivos.push(entradaComum(c[1], c[8]));
      } else if (l[0] === '2') {
        const c = separarCampos(l, 9);
        const de = partes[++i] || '';
        if (c) st.arquivos.push({ caminho: c[9], de, tipo: c[1][0] === 'C' ? 'novo' : 'renomeado', preparado: c[1][0] !== '.' });
      } else if (l[0] === 'u') {
        const c = separarCampos(l, 10);
        if (c) st.arquivos.push({ caminho: c[10], tipo: 'conflito', preparado: false });
      } else if (l[0] === '?') {
        st.arquivos.push({ caminho: l.slice(2), tipo: 'nao-rastreado', preparado: false });
      }
    }
    return st;
  }

  function statusPublico(st, chave, info) {
    return {
      branch: st.branch,
      destacado: st.branch === null && st.oid ? st.oid.slice(0, 7) : null,
      upstream: st.upstream,
      adiante: st.adiante,
      atras: st.atras,
      semCommits: st.semCommits,
      alteracoes: st.arquivos.length,
      arquivos: st.arquivos.slice(0, MAX_ARQUIVOS),
      truncado: st.arquivos.length > MAX_ARQUIVOS,
      operacao: st.operacao,
      buscadoEm: Math.max(ultimoFetch.get(chave) || 0, Math.round(info?.fetchHead || 0)) || null,
      lidoEm: st.lidoEm,
    };
  }

  // Primeiro branch (local, senão do GitHub) que contém o commit, ou null.
  async function branchQueContem(pasta, oid) {
    for (const refs of ['refs/heads', 'refs/remotes']) {
      const r = await git(['for-each-ref', '--count=1', '--format=%(refname:short)', '--contains', oid, refs], { cwd: pasta });
      const nome = r.codigo === 0 ? r.out.trim() : '';
      if (nome) return nome;
    }
    return null;
  }

  async function lerOrigin(pasta) {
    const r = await git(['config', '--get', 'remote.origin.url'], { cwd: pasta });
    return r.codigo === 0 ? r.out.trim() || null : null;
  }

  // Último commit do HEAD: { hash, msg, quando } ou null (sem commits ou o git falhou).
  async function lerUltimoCommit(pasta) {
    const r = await git(['--no-optional-locks', 'log', '-1', '--format=%H%x1f%s%x1f%cI'], { cwd: pasta });
    if (r.codigo !== 0 || r.estourou) return null;
    const [hash = '', msg = '', quando = ''] = r.out.trim().split('\x1f');
    return hash ? { hash, msg: encurtar(msg, 300), quando } : null;
  }

  async function refExiste(pasta, ref) {
    const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: pasta });
    return r.codigo === 0;
  }

  async function montarAgora(ent) {
    const p = { chave: ent.chave, nome: nomeDe(ent.pasta), pasta: ent.pasta, existe: false, origem: ent.origem, bloqueado: null, git: false, repo: null, remoto: null, status: null, subrepos: [], mae: ent.mae || null };
    p.existe = await ehPasta(ent.pasta);
    if (relacaoOrbit(ent.chave)) {
      p.bloqueado = 'orbit'; // sem git, sem status, sem ações
      if (p.existe && maeDoOrbit(ent.chave)) p.subrepos = subrepos(ent.pasta, ent.chave);
      return p;
    }
    if (!p.existe) return p;
    p.subrepos = subrepos(ent.pasta, ent.chave);
    try {
      const info = await inspecionar(ent.pasta);
      if (info.erro) p.erro = info.erro;
      if (!info.git) return p;
      p.git = true;
      const [st, url, ultimo] = await Promise.all([lerStatus(ent.pasta, info), lerOrigin(ent.pasta), lerUltimoCommit(ent.pasta)]);
      p.status = statusPublico(st, ent.chave, info);
      p.status.ultimo = ultimo; // card Sincronização da Visão geral com o projeto filtrado (17/10)
      // Commit solto (20/10): o branch que já guarda o commit (como o app-build de um projeto, um worktree parado num
      // commit da app). Com ele, o card não pede atenção: não há nada que só exista nesta pasta.
      if (!st.branch && st.oid) p.status.destacadoEm = await branchQueContem(ent.pasta, st.oid);
      if (url) {
        p.repo = repoDaUrl(url);
        p.remoto = { url: semCredenciais(url), github: !!p.repo };
      }
    } catch (e) {
      p.erro = String(e?.message || e);
    }
    return p;
  }

  const cacheStatus = new Map(); // chave → { em, projeto }
  const lendo = new Map(); // chave → Promise (leituras em curso, para não repetir)
  function montar(ent, { fresco = false } = {}) {
    if (!fresco) {
      const c = cacheStatus.get(ent.chave);
      if (c && Date.now() - c.em < MS_CACHE_STATUS) return Promise.resolve({ ...c.projeto, origem: ent.origem, pasta: ent.pasta, mae: ent.mae || null });
      if (lendo.has(ent.chave)) return lendo.get(ent.chave);
    }
    const prom = montarAgora(ent).then((projeto) => {
      cacheStatus.set(ent.chave, { em: Date.now(), projeto });
      return projeto;
    }).finally(() => { if (lendo.get(ent.chave) === prom) lendo.delete(ent.chave); });
    if (!fresco) lendo.set(ent.chave, prom);
    return prom;
  }

  async function listarProjetos() {
    const ents = entradas();
    const res = new Array(ents.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(PARALELO, ents.length) }, async () => {
      while (i < ents.length) {
        const k = i++;
        res[k] = await montar(ents[k]);
      }
    }));
    return res.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }) || a.chave.localeCompare(b.chave));
  }

  async function listarBranches(ent) {
    await exigirGit(ent.pasta);
    const [r, cab] = await Promise.all([
      git(['for-each-ref', '--sort=-committerdate', '--format=%(HEAD)%00%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:raw)', 'refs/heads', 'refs/remotes/origin'], { cwd: ent.pasta }),
      git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: ent.pasta }),
    ]);
    if (r.codigo !== 0 || r.estourou) throw erroGit(r, { mudou: '' });
    const locais = [];
    const remotos = [];
    for (const linha of r.out.split('\n')) {
      if (!linha) continue;
      const [, ref = '', up = '', track = '', data = ''] = linha.split('\0');
      const ms = (Number(String(data).split(' ')[0]) || 0) * 1000 || null;
      if (ref.startsWith('refs/heads/')) {
        const a = /ahead (\d+)/.exec(track);
        const b = /behind (\d+)/.exec(track);
        locais.push({ nome: ref.slice(11), upstream: up || null, adiante: a ? Number(a[1]) : 0, atras: b ? Number(b[1]) : 0, data: ms });
      } else if (ref.startsWith('refs/remotes/origin/') && ref !== 'refs/remotes/origin/HEAD') {
        remotos.push({ nome: ref.slice(20), data: ms });
      }
    }
    const nomes = new Set(locais.map((l) => l.nome));
    // Clone de um branch só (git clone --single-branch): o fetch não traz os outros branches do GitHub.
    const rs = await git(['config', '--get-all', 'remote.origin.fetch'], { cwd: ent.pasta });
    const soUm = rs.codigo === 0 && !!rs.out.trim() && !rs.out.includes('*');
    return { atual: cab.codigo === 0 ? cab.out.trim() || null : null, locais, remotos: remotos.filter((x) => !nomes.has(x.nome)), soUm };
  }

  // ── auxiliares das ações ──
  const ocupadas = new Map(); // chave → nome da operação

  async function comTrava(chave, nome, fn) {
    if (ocupadas.has(chave)) throw erroHttp(409, `Já tem uma operação (${ocupadas.get(chave)}) em andamento nesta pasta. Espere terminar.`, 'ocupado');
    ocupadas.set(chave, nome);
    try {
      return await fn();
    } finally {
      ocupadas.delete(chave);
    }
  }

  // Valida a pasta (Orbit → 403 antes de tudo), trava, roda e devolve o projeto fresco (e avisa as abas).
  async function acaoNoProjeto(nome, corpo, fn) {
    const ent = exigirProjeto(corpo?.pasta);
    if (!(await ehPasta(ent.pasta))) throw erroHttp(400, 'Esta pasta não existe mais. Nada mudou.', 'sem-pasta');
    return comTrava(ent.chave, nome, async () => {
      let extra;
      try {
        extra = await fn(ent);
      } catch (e) {
        if (e?.codigo !== 'confirmar') {
          if (e?.status >= 500 || e?.status === 422 || e?.status === 409) log('repos:', nome, ent.pasta, '→', e.codigo || e.status, encurtar(e.message, 300));
          const projeto = await montar(ent, { fresco: true }).catch(() => null);
          if (projeto) {
            avisarProjeto(projeto);
            if (['parcial', 'resolver', 'conflito', 'marcas', 'rejeitado', 'divergiu'].includes(e?.codigo)) e.extra = { ...(e.extra || {}), projeto }; // o card mostra o estado novo na hora
          }
        }
        throw e;
      }
      log('repos:', nome, ent.pasta, 'ok');
      const projeto = await montar(ent, { fresco: true });
      avisarProjeto(projeto);
      return { ok: true, projeto, ...(extra || {}) };
    });
  }

  async function exigirGit(pasta) {
    const info = await inspecionar(pasta);
    if (!info.git) throw erroHttp(400, info.erro ? `${info.erro} Nada mudou.` : 'Esta pasta ainda não usa git. Vincule ou crie um repositório primeiro. Nada mudou.', 'nao-git');
    return info;
  }

  async function exigirOrigin(pasta) {
    const url = await lerOrigin(pasta);
    if (!url) throw erroHttp(400, 'Esta pasta não está vinculada a um repositório (sem origin). Nada mudou.', 'sem-origin');
    return url;
  }

  // Sem user.email (repo e global): o login do GitHub, por variável de ambiente, sem gravar config.
  async function identidadePara(pasta) {
    const r = await git(['config', '--get', 'user.email'], { cwd: pasta });
    if (r.codigo === 0 && r.out.trim()) return null;
    const c = contaSegura();
    if (!c?.login) return null;
    return { nome: c.login, email: c.id ? `${c.id}+${c.login}@users.noreply.github.com` : `${c.login}@users.noreply.github.com` };
  }

  // GIT_SSH_COMMAND em BatchMode só se o usuário não escolheu o próprio ssh.
  async function sshEmLote(pasta, url) {
    if (!ehSsh(url)) return false;
    if (Object.keys(process.env).some((k) => /^GIT_SSH(_COMMAND)?$/i.test(k))) return false;
    const r = await git(['config', '--get', 'core.sshCommand'], { cwd: pasta });
    return !(r.codigo === 0 && r.out.trim());
  }

  async function buscarOrigin(ent, url, ctx = {}) {
    const token = await tokenPara(url);
    const ssh = await sshEmLote(ent.pasta, url);
    const r = await git(['fetch', '--prune', 'origin'], { cwd: ent.pasta, token, ssh, prazo: MS.escrita });
    if (r.codigo !== 0 || r.estourou) throw erroGit(r, { token: !!token, faltando: ['contents:read'], mudou: ctx.mudou ?? 'Nada mudou.' });
    ultimoFetch.set(ent.chave, Date.now());
  }

  // HEAD sem commits: aponta o branch para origin/<b> e lê a árvore só no índice (reset misto).
  // Os arquivos da pasta não mudam; o que difere do GitHub aparece como alteração.
  async function apontarParaRemoto(pasta, b, mudou) {
    if (!(await refExiste(pasta, `refs/remotes/origin/${b}`))) return false; // GitHub vazio: fica sem commits
    if (await refExiste(pasta, 'HEAD')) return false; // nunca move um HEAD que já existe
    const cab = await git(['symbolic-ref', '-q', 'HEAD'], { cwd: pasta });
    if (cab.out.trim() !== `refs/heads/${b}`) {
      const s = await git(['symbolic-ref', 'HEAD', `refs/heads/${b}`], { cwd: pasta, prazo: MS.escrita });
      if (s.codigo !== 0) throw erroGit(s, { mudou });
    }
    let r = await git(['reset', '--mixed', '-q', `refs/remotes/origin/${b}`, '--'], { cwd: pasta, prazo: MS.escrita });
    if (r.codigo !== 0) {
      // Plano B, equivalente ao reset misto: cria o branch (só se não existir) e lê a árvore no índice.
      r = await git(['update-ref', `refs/heads/${b}`, `refs/remotes/origin/${b}`, ''], { cwd: pasta, prazo: MS.escrita });
      if (r.codigo === 0) r = await git(['read-tree', `refs/heads/${b}`], { cwd: pasta, prazo: MS.escrita });
      if (r.codigo !== 0) throw erroGit(r, { mudou });
    }
    await git(['branch', `--set-upstream-to=origin/${b}`, b], { cwd: pasta, prazo: MS.escrita });
    return true;
  }

  // Depois de ligar o origin: upstream do branch atual (se origin/<atual> existir) ou, num repositório
  // sem commits e com índice vazio, o mesmo passo do "sem git".
  async function ligarBranch(pasta, branchPadrao, mudou) {
    const st = await lerStatus(pasta, null);
    if (st.semCommits) {
      const idx = await git(['ls-files', '-z', '--cached'], { cwd: pasta });
      if (idx.codigo !== 0 || idx.out) return;
      const b = st.branch && (await refExiste(pasta, `refs/remotes/origin/${st.branch}`)) ? st.branch : branchPadrao;
      if (b) await apontarParaRemoto(pasta, b, mudou);
      return;
    }
    if (!st.branch) return;
    const upOk = st.upstream && (!st.upstream.startsWith('origin/') || (await refExiste(pasta, `refs/remotes/${st.upstream}`)));
    if (!upOk && (await refExiste(pasta, `refs/remotes/origin/${st.branch}`))) {
      await git(['branch', `--set-upstream-to=origin/${st.branch}`, st.branch], { cwd: pasta, prazo: MS.escrita });
    }
  }

  // Arquivos que o `add -A` do primeiro commit pegaria (respeita .gitignore). Sem git, usa um
  // repositório temporário só para ler a pasta (nada é escrito nela).
  async function arquivosDoPrimeiroCommit(pasta, ehGit) {
    if (ehGit) {
      const r = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: pasta });
      return r.codigo === 0 ? r.out.split('\0').filter(Boolean) : [];
    }
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-contar-'));
    try {
      let r = await git(['init', '-q', '--bare', tmp], { cwd: tmp });
      if (r.codigo !== 0) return [];
      r = await git([`--git-dir=${tmp}`, `--work-tree=${pasta}`, 'ls-files', '-z', '--others', '--exclude-standard'], { cwd: pasta });
      return r.codigo === 0 ? r.out.split('\0').filter(Boolean) : [];
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  function temHook(pastaHooks) {
    return !!pastaHooks && ['pre-commit', 'prepare-commit-msg', 'commit-msg'].some((h) => existe(path.join(pastaHooks, h)));
  }

  function erroCommit(r, info, nada = 'Nada foi commitado.') {
    if (r.estourou) return erroHttp(504, `O commit demorou demais (um hook do repositório?) e foi interrompido. ${nada} Se o git reclamar de index.lock, espere um pouco e tente de novo.`, 'prazo');
    const t = `${r.err}\n${r.out}`;
    if (/nothing to commit|nothing added to commit|no changes added to commit/i.test(t)) return erroHttp(400, 'Não há alterações para commitar. Nada mudou.', 'nada');
    if (/Author identity unknown|Please tell me who you are|empty ident name|unable to auto-detect email/i.test(t)) {
      return erroHttp(409, `O git não sabe quem é o autor do commit. Conecte o GitHub ou configure user.name e user.email. ${nada}`, 'identidade');
    }
    if (/index\.lock/i.test(t)) return erroGit(r, { mudou: nada });
    if (temHook(info?.hooks)) {
      const saida = `${r.err}\n${r.out}`.replace(/\r/g, '').split('\n').filter((l) => !/^warning: in the working copy/i.test(l)).join('\n').trim();
      const frase = nada ? `Um hook do repositório recusou o commit; ${nada[0].toLowerCase()}${nada.slice(1)}` : 'Um hook do repositório recusou o commit.';
      return erroHttp(422, encurtar(`${frase}${saida ? '\n' + saida : ''}`, 2000), 'hook');
    }
    return erroGit(r, { mudou: nada });
  }

  // ── ações ──

  async function adicionar(corpo) {
    const pasta = exigirPasta(corpo.pasta);
    const chave = chaveDe(pasta);
    if (relacaoOrbit(chave)) throw erroOrbit();
    if (!(await ehPasta(pasta))) throw erroHttp(400, 'Essa pasta não existe (ou não é uma pasta). Nada mudou.', 'sem-pasta');
    if (!registro.projetos[chave]) {
      registro.projetos[chave] = { pasta, adicionado: Date.now(), origem: 'manual' };
      await salvarRegistro();
      avisarLista();
      log('repos: pasta adicionada', pasta);
    }
    const ent = entradas().find((e) => e.chave === chave);
    return { ok: true, projeto: await montar(ent, { fresco: true }) };
  }

  async function remover(corpo) {
    const pasta = exigirPasta(corpo.pasta);
    const chave = chaveDe(pasta);
    if (registro.projetos[chave]) {
      delete registro.projetos[chave]; // só o registro: nenhum arquivo é tocado
      cacheStatus.delete(chave);
      await salvarRegistro();
      avisarLista();
      log('repos: pasta removida da lista', pasta);
      return { ok: true };
    }
    const ent = entradas().find((e) => e.chave === chave);
    if (ent?.origem === 'subpasta') {
      throw erroHttp(400, `Esta pasta é um repositório dentro de ${nomeDe(ent.mae)}; ela sai daqui quando ${nomeDe(ent.mae)} sair da lista. Nada mudou.`, 'subpasta');
    }
    if (ent) {
      throw erroHttp(400, 'Esta pasta vem de uma sessão do Claude ou da lista de projetos da lateral; ela sai daqui quando sair de lá. Nada mudou.', 'sessao');
    }
    throw erroHttp(404, 'Esta pasta não está na lista. Nada mudou.', 'desconhecida');
  }

  async function clonar(corpo) {
    const alvo = exigirRepo(corpo.repo);
    const destino = corpo.destino == null || corpo.destino === '' ? pastaClones() : exigirPasta(corpo.destino);
    if (!(await ehPasta(destino))) throw erroHttp(400, 'A pasta de destino não existe. Nada mudou.', 'sem-pasta');
    const nomePasta = corpo.nomePasta == null || corpo.nomePasta === '' ? alvo.nome : String(corpo.nomePasta).trim();
    if (!nomePastaValido(nomePasta)) throw erroHttp(400, 'Nome de pasta inválido (sem \\ / : * ? " < > |). Nada mudou.', 'nome');
    const final = path.join(destino, nomePasta);
    const chave = chaveDe(final);
    if (relacaoOrbit(chave)) throw erroOrbit();
    return comTrava(chave, 'clonar', async () => {
      if (existe(final) && (!(await ehPasta(final)) || !(await pastaVazia(final)))) {
        throw erroHttp(409, `Já existe "${nomePasta}" com arquivos em ${destino}. Escolha outro nome. Nada mudou.`, 'existe');
      }
      const token = await tokenSeHouver();
      // Progresso pelo SSE, no máximo ~4×/s; pct é o total (0–100), fase é a etapa do git.
      let ultimo = 0;
      let pct = 0;
      let fase = 'iniciando';
      let pendente = null;
      const emitir = () => {
        pendente = null;
        ultimo = Date.now();
        difundir('repos', { tipo: 'progresso', op: 'clonar', pasta: final, fase, pct });
      };
      const agendar = () => {
        if (pendente) return;
        const falta = MS_PROGRESSO - (Date.now() - ultimo);
        if (falta <= 0) emitir();
        else pendente = setTimeout(emitir, falta);
      };
      const FASES = {
        'Enumerating objects': ['preparando', 0, 2], 'Counting objects': ['preparando', 2, 3], 'Compressing objects': ['preparando', 5, 5],
        'Receiving objects': ['recebendo', 10, 70], 'Resolving deltas': ['resolvendo', 80, 15], 'Updating files': ['arquivos', 95, 5],
      };
      let resto = '';
      const aoErro = (c) => {
        resto += c.toString('utf8');
        const partes = resto.split(/[\r\n]/);
        resto = partes.pop().slice(-500);
        for (const l of partes) {
          const m = /(Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files):\s+(\d{1,3})%/.exec(l);
          if (!m) continue;
          const [nomeFase, ini, peso] = FASES[m[1]];
          const novo = Math.min(99, Math.round(ini + (peso * Math.min(100, Number(m[2]))) / 100));
          if (novo > pct || nomeFase !== fase) {
            pct = Math.max(pct, novo);
            fase = nomeFase;
            agendar();
          }
        }
      };
      emitir();
      const r = await git(['clone', '--progress', '--', urlDoRepo(alvo.dono, alvo.nome), final], { cwd: destino, token, prazo: MS.clone, aoErro });
      clearTimeout(pendente);
      if (r.codigo !== 0 || r.estourou) {
        fase = 'erro';
        emitir();
        log('repos: clonar', alvo.completo, '→', encurtar(resumoGit(r), 200));
        throw erroGit(r, {
          token: !!token,
          faltando: ['contents:read'],
          mudou: 'Nada foi clonado.',
          aposPrazo: `O clone passou de 15 min e foi interrompido. A pasta ${final} pode ter ficado pela metade: confira antes de tentar de novo.`,
        });
      }
      fase = 'concluido';
      pct = 100;
      emitir();
      registro.projetos[chave] = { pasta: final, adicionado: Date.now(), origem: 'clone' };
      registro.pastaClones = destino;
      await salvarRegistro();
      avisarLista();
      log('repos: clonado', alvo.completo, 'em', final);
      const ent = entradas().find((e) => e.chave === chave);
      const projeto = await montar(ent, { fresco: true });
      avisarProjeto(projeto);
      return { ok: true, projeto };
    });
  }

  function vincular(corpo) {
    return acaoNoProjeto('vincular', corpo, async (ent) => {
      const alvo = exigirRepo(corpo.repo);
      const pasta = ent.pasta;
      const info = await inspecionar(pasta);
      const origin = info.git ? await lerOrigin(pasta) : null;
      const atual = origin ? repoDaUrl(origin) : null;
      if (info.git && atual && atual.completo.toLowerCase() === alvo.completo.toLowerCase()) {
        // Já é o origin. Se o vínculo ficou pela metade (sem commits, índice vazio), completa.
        const st = await lerStatus(pasta, info);
        if (st.semCommits) {
          const idx = await git(['ls-files', '-z', '--cached'], { cwd: pasta });
          if (idx.codigo === 0 && !idx.out) {
            await buscarOrigin(ent, origin, { mudou: 'O vínculo continua como estava.' });
            await ligarBranch(pasta, null, 'O vínculo continua como estava.');
          }
        }
        return {};
      }
      const { token } = await exigirGithub();
      const meta = await repoNoGithub(alvo, token);
      const url = urlDoRepo(meta.dono, meta.nome);

      if (!info.git) {
        if (info.quebrado || existe(path.join(pasta, '.git'))) {
          throw erroHttp(409, 'Esta pasta tem um .git que o git não conseguiu abrir. Confira a pasta no terminal. Nada mudou.', 'git-quebrado');
        }
        const chk = await git(['check-ref-format', '--branch', meta.branchPadrao], { cwd: pasta });
        if (chk.codigo !== 0) throw erroHttp(502, `O branch padrão do GitHub ("${encurtar(meta.branchPadrao, 80)}") não é um nome válido para o git. Nada mudou.`, 'rede');
        if (!corpo.confirmar) {
          const acima = repoAcima(pasta);
          throw pedirConfirmacao({
            titulo: 'Iniciar o git nesta pasta?',
            mensagem: `A pasta ${nomeDe(pasta)} ainda não usa git. O Orbit vai iniciar o git, ligar a ${meta.completo} (branch ${meta.branchPadrao}) e comparar com o GitHub. Os arquivos da pasta não mudam: o que for diferente do GitHub aparece como alteração.`,
            itens: acima ? [`Esta pasta fica dentro de outro repositório (${acima}); o Orbit cria um repositório separado só para ela.`] : undefined,
            botao: 'Iniciar e vincular',
          });
        }
        const b = meta.branchPadrao;
        let r = await git(['init', '-b', b], { cwd: pasta, prazo: MS.escrita });
        if (r.codigo !== 0) throw erroGit(r, { mudou: 'Nada mudou.' });
        const meio = 'O git foi iniciado na pasta, mas o vínculo ficou pela metade; os arquivos não mudaram. Tente Vincular de novo.';
        r = await git(['remote', 'add', 'origin', url], { cwd: pasta, prazo: MS.escrita });
        if (r.codigo !== 0) throw erroGit(r, { mudou: meio });
        await buscarOrigin(ent, url, { mudou: meio });
        await apontarParaRemoto(pasta, b, meio);
        return {};
      }

      if (origin) {
        if (!corpo.confirmar) {
          throw pedirConfirmacao({
            titulo: 'Trocar o repositório vinculado?',
            mensagem: `O origin aponta para ${atual?.completo || semCredenciais(origin)}; trocar por ${meta.completo}? O histórico local e os arquivos ficam como estão.`,
            botao: 'Trocar',
          });
        }
        const r = await git(['remote', 'set-url', 'origin', url], { cwd: pasta, prazo: MS.escrita });
        if (r.codigo !== 0) throw erroGit(r, { mudou: 'Nada mudou.' });
        try {
          await buscarOrigin(ent, url, { mudou: '' });
        } catch (e) {
          const volta = await git(['remote', 'set-url', 'origin', origin], { cwd: pasta, prazo: MS.escrita }); // desfaz a nossa troca
          e.message = `${e.message} ${volta.codigo === 0 ? 'O origin voltou a ser o anterior. Nada mudou.' : `Atenção: o origin ficou apontando para ${meta.completo}.`}`;
          throw e;
        }
        await ligarBranch(pasta, meta.branchPadrao, 'O origin já foi trocado; os arquivos não mudaram.');
        return {};
      }

      // Repositório git sem origin.
      const r = await git(['remote', 'add', 'origin', url], { cwd: pasta, prazo: MS.escrita });
      if (r.codigo !== 0) throw erroGit(r, { mudou: 'Nada mudou.' });
      try {
        await buscarOrigin(ent, url, { mudou: '' });
      } catch (e) {
        const volta = await git(['remote', 'remove', 'origin'], { cwd: pasta, prazo: MS.escrita }); // desfaz o origin que acabamos de pôr
        e.message = `${e.message} ${volta.codigo === 0 ? 'Nada mudou.' : `Atenção: o origin ficou apontando para ${meta.completo}.`}`;
        throw e;
      }
      await ligarBranch(pasta, meta.branchPadrao, 'O origin foi adicionado; os arquivos não mudaram.');
      return {};
    });
  }

  function desvincular(corpo) {
    return acaoNoProjeto('desvincular', corpo, async (ent) => {
      const info = await inspecionar(ent.pasta);
      const origin = info.git ? await lerOrigin(ent.pasta) : null;
      if (!origin) throw erroHttp(400, 'Esta pasta não está vinculada a nenhum repositório. Nada mudou.', 'nada');
      const repo = repoDaUrl(origin);
      if (!corpo.confirmar) {
        throw pedirConfirmacao({
          titulo: 'Desvincular do GitHub?',
          mensagem: `O origin (${repo?.completo || semCredenciais(origin)}) sai desta pasta. O histórico local e os arquivos ficam; nada muda no GitHub.`,
          botao: 'Desvincular',
        });
      }
      const r = await git(['remote', 'remove', 'origin'], { cwd: ent.pasta, prazo: MS.escrita });
      if (r.codigo !== 0) throw erroGit(r, { mudou: 'Nada mudou.' });
      return {};
    });
  }

  function criar(corpo) {
    return acaoNoProjeto('criar', corpo, async (ent) => {
      const pasta = ent.pasta;
      const nome = typeof corpo.nome === 'string' ? corpo.nome.trim() : '';
      if (!NOME_REPO.test(nome) || nome === '.' || nome === '..' || /\.git$/i.test(nome)) {
        throw erroHttp(400, 'Nome inválido: use letras, números, ".", "-" e "_" (até 100). Nada mudou.', 'nome');
      }
      if (corpo.descricao != null && typeof corpo.descricao !== 'string') throw erroHttp(400, 'Descrição inválida. Nada mudou.', 'descricao');
      const descricao = encurtar(String(corpo.descricao || '').replace(/[\r\n]+/g, ' ').trim(), 350);
      if (corpo.privado != null && typeof corpo.privado !== 'boolean') throw erroHttp(400, 'O campo "privado" precisa ser verdadeiro ou falso. Nada mudou.', 'privado');
      const privado = corpo.privado !== false;

      const info = await inspecionar(pasta);
      if (!info.git && (info.quebrado || existe(path.join(pasta, '.git')))) {
        throw erroHttp(409, 'Esta pasta tem um .git que o git não conseguiu abrir. Confira a pasta no terminal. Nada mudou.', 'git-quebrado');
      }
      let st = null;
      if (info.git) {
        if (await lerOrigin(pasta)) throw erroHttp(409, 'Esta pasta já está vinculada (tem origin). Desvincule antes de criar outro repositório. Nada mudou.', 'ja-vinculado');
        st = await lerStatus(pasta, info);
        if (!st.branch) throw erroHttp(409, 'O git está num commit solto (HEAD destacado). Volte para um branch antes de criar o repositório. Nada mudou.', 'destacado');
      }
      const { conta, token } = await exigirGithub();
      const completo = `${conta.login}/${nome}`;
      const branch = st ? st.branch : 'main';
      const primeiro = !st || st.semCommits;
      const arquivos = primeiro ? await arquivosDoPrimeiroCommit(pasta, info.git) : [];
      const sensiveis = arquivos.filter(sensivel);

      if (!corpo.confirmar) {
        const partes = [`Cria ${completo} (${privado ? 'privado' : 'público'}) no GitHub e envia o branch ${branch}.`];
        if (!info.git) partes.push('O git será iniciado nesta pasta.');
        if (primeiro) partes.push(arquivos.length ? `${plural(arquivos.length, 'arquivo entra', 'arquivos entram')} no primeiro commit ("Primeiro commit").` : 'A pasta está vazia: o repositório fica sem commits.');
        else partes.push(`Os commits do branch ${branch} sobem para o GitHub.`);
        if (sensiveis.length) partes.push('Atenção: há arquivos que costumam guardar senhas ou chaves; depois de enviados, ficam no histórico.');
        throw pedirConfirmacao({
          titulo: 'Criar repositório no GitHub?',
          mensagem: partes.join(' '),
          itens: sensiveis.slice(0, 50).map((a) => `Arquivo sensível: ${a}`),
          botao: 'Criar e enviar',
          perigo: sensiveis.length > 0 || !privado,
        });
      }

      // 1. GitHub
      const r = await pedirGithub(`${API}/user/repos`, { metodo: 'POST', token, corpo: { name: nome, ...(descricao ? { description: descricao } : {}), private: privado, auto_init: false } });
      if (r.status === 422) throw erroHttp(422, `Já existe um repositório ${completo} no GitHub. Escolha outro nome. Nada mudou.`, 'nome-em-uso');
      if (!r.ok) throw erroApi(r, ['administration:write']);
      const criado = repoDaApi(await r.json().catch(() => null)) || { ...repoDe(conta.login, nome) };
      cacheGithub = null;
      log('repos: criado no GitHub', criado.completo);
      if (!registro.projetos[ent.chave]) {
        registro.projetos[ent.chave] = { pasta, adicionado: Date.now(), origem: 'criado' };
        await salvarRegistro();
        avisarLista();
      }
      const url = urlDoRepo(criado.dono, criado.nome);
      const feito = [`Criei ${criado.completo} no GitHub`];
      const ETAPAS = { init: 'iniciar o git', commit: 'o primeiro commit', remote: 'ligar a pasta a ele', push: 'o envio' };
      // Falha depois de criar no GitHub: 502 'parcial' dizendo o que já foi feito e o que fazer.
      const parcial = (etapa, falha, ctx, fazer) => {
        const eg = falha instanceof Error ? falha : erroGit(falha, { ...ctx, mudou: '' });
        const motivo = eg.message.trim().replace(/[.;]$/, '');
        return erroHttp(502, `${feito.join(', ')}, mas ${ETAPAS[etapa]} falhou (${motivo}). ${fazer}`, 'parcial', { etapa, ...(eg.extra?.faltando ? { faltando: eg.extra.faltando } : {}) });
      };

      // 2. git init
      if (!info.git) {
        const ri = await git(['init', '-b', 'main'], { cwd: pasta, prazo: MS.escrita });
        if (ri.codigo !== 0) throw parcial('init', ri, {}, 'Use "Vincular repositório" para ligar a pasta a ele depois.');
        feito.push('iniciei o git');
      }

      // 3. primeiro commit (se não houver commit)
      let temCommit = !primeiro;
      let falhaCommit = null;
      if (primeiro && arquivos.length) {
        const ra = await git(['add', '-A'], { cwd: pasta, prazo: MS.escrita });
        if (ra.codigo !== 0) falhaCommit = erroGit(ra, { mudou: '' });
        else {
          const rc = await git(['commit', '-F', '-'], { cwd: pasta, entrada: 'Primeiro commit', identidade: await identidadePara(pasta), prazo: MS.escrita });
          if (rc.codigo !== 0 || rc.estourou) falhaCommit = erroCommit(rc, await inspecionar(pasta).catch(() => info), '');
          else { temCommit = true; feito.push('fiz o primeiro commit'); }
        }
      }

      // 4. origin (mesmo com o commit falhando: a pasta já fica ligada ao repositório novo)
      const rr = await git(['remote', 'add', 'origin', url], { cwd: pasta, prazo: MS.escrita });
      if (rr.codigo !== 0) {
        if (falhaCommit) throw parcial('commit', falhaCommit, {}, 'Faça o commit pelo Orbit e depois use "Vincular repositório" e Enviar.');
        throw parcial('remote', rr, {}, 'Use "Vincular repositório" para tentar de novo.');
      }
      if (falhaCommit) {
        feito.push('liguei a pasta a ele');
        throw parcial('commit', falhaCommit, {}, 'Faça o commit pelo Orbit e depois use Enviar.');
      }
      feito.push('liguei a pasta a ele');

      // 5. push
      if (temCommit) {
        // A URL montada é https (ou file:// em teste): sem ssh.
        const rp = await git(['push', '-u', 'origin', 'HEAD'], { cwd: pasta, token, prazo: MS.escrita });
        if (rp.codigo !== 0 || rp.estourou) throw parcial('push', rp, { token: true, faltando: ['contents:write'] }, 'Use Enviar no projeto para tentar de novo.');
      }
      return { repo: { completo: criado.completo, url: `https://github.com/${criado.completo}` } };
    });
  }

  // ── segurança do commit (18/10, card da Visão geral) ──
  // Olha o que vai entrar num commit antes de fazê-lo: arquivos sensíveis pelo nome, credenciais nas linhas novas,
  // arquivos grandes (acima de 100 MB o GitHub recusa o push) e pastas geradas ou lixo do sistema que ainda não
  // estão no git (sugere o padrão do .gitignore). Só leitura.
  async function analisarCommit(pasta, st, escolhidos) {
    const vivos = escolhidos.filter((a) => a.tipo !== 'apagado');
    const sensiveis = vivos.filter((a) => sensivel(a.caminho)).map((a) => a.caminho);
    const grandes = [], enormes = [], credenciais = [];
    const tamanhos = new Map();
    for (let i = 0; i < vivos.length; i += 64) {
      await Promise.all(vivos.slice(i, i + 64).map(async (a) => {
        try {
          const s = await fsp.stat(path.join(pasta, a.caminho));
          if (!s.isFile()) return;
          tamanhos.set(a.caminho, s.size);
          const mb = Math.round((s.size / MB) * 10) / 10;
          if (s.size > LIMITE_GITHUB) enormes.push({ arquivo: a.caminho, mb });
          else if (s.size > ARQUIVO_GRANDE) grandes.push({ arquivo: a.caminho, mb });
        } catch {}
      }));
    }
    const achou = (arquivo, linha, texto) => {
      for (const [tipo, re] of CREDENCIAIS) {
        const m = re.exec(texto);
        if (!m) continue;
        if (ARQUIVO_DE_TESTE.test(arquivo) && FALSO_DE_TESTE.test(m[0])) continue;
        credenciais.push({ arquivo, linha, tipo });
        return;
      }
    };
    // Linhas novas dos arquivos já rastreados: o diff da árvore contra o HEAD (inclui o que já está preparado).
    const rastreados = new Set(vivos.filter((a) => a.tipo !== 'nao-rastreado').map((a) => a.caminho));
    const ler = st.semCommits ? vivos : vivos.filter((a) => a.tipo === 'nao-rastreado');
    if (!st.semCommits && rastreados.size) {
      const d = await git(['diff', 'HEAD', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--diff-filter=AM', '--src-prefix=a/', '--dst-prefix=b/'], { cwd: pasta });
      let arquivo = null, linha = 0;
      for (const l of d.codigo === 0 ? d.out.split('\n') : []) {
        if (credenciais.length >= MAX_ACHADOS) break;
        if (l.startsWith('+++ ')) {
          let n = l.slice(4).replace(/\t$/, '');
          if (n.startsWith('"')) n = n.slice(1, -1).replace(/\\(.)/g, '$1');
          n = n === '/dev/null' ? null : n.replace(/^b\//, '');
          arquivo = n && rastreados.has(n) ? n : null;
          continue;
        }
        if (l.startsWith('@@')) { const m = /\+(\d+)/.exec(l); linha = m ? Number(m[1]) : 0; continue; }
        if (!arquivo || l.startsWith('---')) continue;
        if (l.startsWith('+')) { achou(arquivo, linha, l.slice(1)); linha++; }
      }
    }
    // Arquivos novos (e todos, num repositório sem commits): lidos do disco, só texto e até 1 MB cada.
    let lidos = 0, total = 0;
    for (const a of ler) {
      if (credenciais.length >= MAX_ACHADOS || lidos >= MAX_LER.arquivos || total >= MAX_LER.total) break;
      const tam = tamanhos.get(a.caminho);
      if (tam == null || tam > MAX_LER.arquivo) continue;
      let buf;
      try { buf = await fsp.readFile(path.join(pasta, a.caminho)); } catch { continue; }
      lidos++; total += buf.length;
      if (buf.subarray(0, 8000).includes(0)) continue; // binário
      buf.toString('utf8').split('\n').forEach((t, i) => { if (credenciais.length < MAX_ACHADOS) achou(a.caminho, i + 1, t); });
    }
    // Pastas geradas e lixo do sistema, só entre os arquivos novos. Expo: ios/ e android/ fora do git são as pastas
    // nativas que o prebuild recria a partir do app.json.
    let expo = false;
    try {
      const pk = JSON.parse(await fsp.readFile(path.join(pasta, 'package.json'), 'utf8'));
      expo = !!(pk?.dependencies?.expo || pk?.devDependencies?.expo);
    } catch {}
    const nativaRastreada = new Map();
    const grupos = new Map(); // padrão → { padrao, motivo, arquivos }
    for (const a of vivos) {
      if (a.tipo !== 'nao-rastreado') continue;
      const segs = a.caminho.split('/');
      const nome = segs[segs.length - 1];
      let padrao = null, motivo = '';
      if (expo && segs.length > 1 && (segs[0] === 'ios' || segs[0] === 'android')) {
        if (!nativaRastreada.has(segs[0])) {
          const r = await git(['ls-files', '--', segs[0] + '/'], { cwd: pasta });
          nativaRastreada.set(segs[0], r.codigo !== 0 || !!r.out.trim());
        }
        if (!nativaRastreada.get(segs[0])) { padrao = '/' + segs[0] + '/'; motivo = 'pasta nativa que o Expo gera a partir do app.json'; }
      }
      if (!padrao && LIXO_SISTEMA.test(nome)) { padrao = nome; motivo = 'arquivo que o sistema cria sozinho'; }
      if (!padrao) {
        const i = segs.findIndex((x, k) => k < segs.length - 1 && PASTAS_GERADAS.has(x.toLowerCase()));
        if (i >= 0) { padrao = '/' + segs.slice(0, i + 1).join('/') + '/'; motivo = 'pasta gerada (dependências, build ou cache)'; }
      }
      if (!padrao) continue;
      const g = grupos.get(padrao) || { padrao, motivo, arquivos: 0 };
      g.arquivos++;
      grupos.set(padrao, g);
    }
    return { sensiveis, credenciais, grandes, enormes, geradas: [...grupos.values()] };
  }

  // Sugestão de mensagem: as pastas mais mexidas (sem as genéricas como src/ e components/), fora o que é gerado.
  // O usuário edita no balão.
  const PASTAS_GENERICAS = new Set(['src', 'app', 'lib', 'libs', 'components', 'features', 'screens', 'pages', 'assets', 'ui', 'utils', 'public', 'source', 'packages']);
  function sugerirMensagem(escolhidos, geradas = []) {
    const fora = geradas.map((g) => g.padrao);
    const conta = new Map();
    for (const a of escolhidos) {
      if (fora.some((p) => (p.startsWith('/') ? ('/' + a.caminho).startsWith(p) : a.caminho.split('/').pop() === p))) continue;
      const segs = a.caminho.split('/');
      const dirs = segs.slice(0, -1).filter((x) => !PASTAS_GENERICAS.has(x.toLowerCase()) && !/^[.(_]/.test(x));
      const k = dirs[dirs.length - 1] || segs[segs.length - 1].replace(/^\.+/, '').replace(/\.[^.]+$/, '') || segs[segs.length - 1];
      conta.set(k, (conta.get(k) || 0) + 1);
    }
    if (!conta.size) return '';
    const top = [...conta.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
    const novos = escolhidos.every((a) => a.tipo === 'nao-rastreado' || a.tipo === 'novo');
    const lista = top.length > 1 ? top.slice(0, -1).join(', ') + (conta.size > 3 ? ', ' + top[top.length - 1] + ' e mais' : ' e ' + top[top.length - 1]) : top[0];
    return encurtar(`${novos ? 'Adiciona' : 'Atualiza'} ${lista}`, 120);
  }

  // Prévia do commit de tudo (sem trava, só leitura): quantos arquivos, os avisos e uma sugestão de mensagem.
  async function previaCommit(corpo) {
    const ent = exigirProjeto(corpo?.pasta);
    const info = await exigirGit(ent.pasta);
    const st = await lerStatus(ent.pasta, info, true);
    const an = await analisarCommit(ent.pasta, st, st.arquivos);
    return {
      ok: true, branch: st.branch, upstream: st.upstream, adiante: st.adiante, atras: st.atras, semCommits: st.semCommits, operacao: info.operacao || null,
      arquivos: st.arquivos.length, conflitos: st.arquivos.filter((a) => a.tipo === 'conflito').length,
      lista: st.arquivos.slice(0, 20).map((a) => `${a.caminho} (${a.tipo === 'nao-rastreado' ? 'novo' : a.tipo})`),
      sugestao: sugerirMensagem(st.arquivos, an.geradas), ...an,
    };
  }

  // Acrescenta padrões ao .gitignore da pasta (cria se não houver). Só acrescenta: nada é apagado nem tirado do git.
  // local:true + arquivos (20/10: um botão para ignorar o que não vai para o GitHub): os arquivos
  // não rastreados entram, como caminho exato, no info/exclude do repositório (vale só neste computador e para os
  // worktrees dele, e não vira alteração nova como o .gitignore viraria).
  function ignorar(corpo) {
    if (corpo?.local) return ignorarLocal(corpo);
    return acaoNoProjeto('ignorar', corpo, async (ent) => {
      const padroes = Array.isArray(corpo.padroes) ? [...new Set(corpo.padroes)] : [];
      if (!padroes.length || padroes.length > 50 || !padroes.every(padraoIgnoravel)) throw erroHttp(400, 'Padrões inválidos para o .gitignore. Nada mudou.', 'padroes');
      await exigirGit(ent.pasta);
      const arq = path.join(ent.pasta, '.gitignore');
      let atual = '';
      try { atual = await fsp.readFile(arq, 'utf8'); } catch {}
      const ja = new Set(atual.split(/\r?\n/).map((l) => l.trim()));
      const novos = padroes.filter((x) => !ja.has(x));
      if (!novos.length) return { ignorados: [] };
      if (!corpo.confirmar) {
        throw pedirConfirmacao({
          titulo: 'Ignorar no git?',
          mensagem: `O Orbit acrescenta ${plural(novos.length, 'linha', 'linhas')} ao .gitignore de ${nomeDe(ent.pasta)}. Os arquivos continuam no disco; o git só deixa de oferecê-los para commit.`,
          itens: novos,
          botao: 'Ignorar',
        });
      }
      const eol = /\r\n/.test(atual) ? '\r\n' : '\n';
      const sep = atual && !/\n$/.test(atual) ? eol : '';
      await fsp.writeFile(arq, `${atual}${sep}${atual ? eol : ''}# Gerados e arquivos do sistema (Orbit, ${new Date().toISOString().slice(0, 10)})${eol}${novos.join(eol)}${eol}`);
      return { ignorados: novos };
    });
  }

  function ignorarLocal(corpo) {
    return acaoNoProjeto('ignorar', corpo, async (ent) => {
      const pedidos = Array.isArray(corpo.arquivos) ? [...new Set(corpo.arquivos)] : [];
      if (!pedidos.length || pedidos.length > 200 || !pedidos.every(caminhoIgnoravel)) throw erroHttp(400, 'Arquivos inválidos para ignorar. Nada mudou.', 'arquivos');
      await exigirGit(ent.pasta);
      const st = await lerStatus(ent.pasta);
      const porCaminho = new Map(st.arquivos.map((a) => [a.caminho, a]));
      // Novos vão para o info/exclude; os que o git já acompanha (mexidos ou apagados só aqui, como os da build de
      // iOS no Mac) ganham skip-worktree: o git passa a fingir que estão iguais ao commit. Os dois valem só nesta pasta.
      const soltos = pedidos.filter((x) => porCaminho.get(x)?.tipo === 'nao-rastreado');
      const rastreados = pedidos.filter((x) => { const a = porCaminho.get(x); return a && !a.preparado && (a.tipo === 'modificado' || a.tipo === 'apagado'); });
      const fora = pedidos.filter((x) => !soltos.includes(x) && !rastreados.includes(x));
      if (fora.length) {
        throw erroHttp(400, `Estes não dá para ignorar (não aparecem como alteração, estão preparados para commit, renomeados ou em conflito): ${fora.slice(0, 5).join(', ')}${fora.length > 5 ? '…' : ''}. Nada mudou.`, 'rastreados', { arquivos: fora.slice(0, 50) });
      }
      const r = await git(['rev-parse', '--git-path', 'info/exclude'], { cwd: ent.pasta });
      if (r.codigo !== 0) throw erroGit(r, { mudou: '' });
      const arq = path.resolve(ent.pasta, r.out.trim());
      let atual = '';
      try { atual = await fsp.readFile(arq, 'utf8'); } catch {}
      const ja = new Set(atual.split(/\r?\n/));
      const novos = soltos.map(padraoExato).filter((x) => !ja.has(x));
      if (!novos.length && !rastreados.length) return { ignorados: [] };
      if (!corpo.confirmar) {
        throw pedirConfirmacao({
          titulo: 'Ignorar neste computador?',
          mensagem: `${plural(pedidos.length, 'O item fica', 'Os itens ficam')} no disco como está, mas o git deixa de ${pedidos.length === 1 ? 'oferecê-lo' : 'oferecê-los'} para commit em ${nomeDe(ent.pasta)}. Vale só nesta pasta deste computador: nada vai para o GitHub.`
            + (rastreados.length ? ` ${plural(rastreados.length, 'Um arquivo que o git já acompanha fica', 'Arquivos que o git já acompanha ficam')} com a versão daqui; para voltar a acompanhar: git update-index --no-skip-worktree <arquivo>.` : ''),
          itens: pedidos,
          botao: 'Ignorar',
        });
      }
      if (novos.length) {
        await fsp.mkdir(path.dirname(arq), { recursive: true });
        const sep = atual && !/\n$/.test(atual) ? '\n' : '';
        await fsp.writeFile(arq, `${atual}${sep}# Ignorados pelo Orbit (${new Date().toISOString().slice(0, 10)})\n${novos.join('\n')}\n`);
      }
      if (rastreados.length) {
        const u = await git(['update-index', '--skip-worktree', '--', ...rastreados], { cwd: ent.pasta });
        if (u.codigo !== 0) throw erroGit(u, { mudou: novos.length ? 'Os arquivos novos já foram ignorados.' : undefined });
      }
      return { ignorados: pedidos };
    });
  }

  // ── junção aberta para resolver no editor (18/10) ──
  // Concluir: só os arquivos que estavam em conflito entram (git add de cada um, nunca add -A), e só se não houver
  // mais marcas de conflito neles; o commit de merge usa a mensagem que o git preparou.
  async function arquivosEmConflito(pasta) {
    const u = await git(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: pasta });
    return u.codigo === 0 ? u.out.split('\0').filter(Boolean) : [];
  }
  function concluirJuncao(corpo) {
    return acaoNoProjeto('concluir', corpo, async (ent) => {
      const pasta = ent.pasta;
      const info = await exigirGit(pasta);
      if (info.operacao !== 'merge') throw erroHttp(409, 'Não há junção (merge) aberta nesta pasta. Nada mudou.', 'sem-juncao');
      const pendentes = await arquivosEmConflito(pasta);
      const comMarcas = [];
      for (const a of pendentes) {
        let t = '';
        try { t = await fsp.readFile(path.join(pasta, a), 'utf8'); } catch { continue; } // apagado de propósito
        if (/^<{7}(?: |$)|^>{7}(?: |$)/m.test(t)) comMarcas.push(a);
      }
      if (comMarcas.length) {
        throw erroHttp(409, `Ainda há trechos com <<<<<<< em ${comMarcas.slice(0, 5).join(', ')}${comMarcas.length > 5 ? '…' : ''}. Escolha o que fica, apague as marcas, salve e conclua de novo. Nada mudou.`, 'marcas', { arquivos: comMarcas.slice(0, 50) });
      }
      if (pendentes.length) {
        const ra = await git(['--literal-pathspecs', 'add', '-A', '--', ...pendentes], { cwd: pasta, prazo: MS.escrita });
        if (ra.codigo !== 0 || ra.estourou) throw erroGit(ra, { mudou: 'A junção continua aberta.' });
      }
      const identidade = await identidadePara(pasta);
      const rc = await git(['commit', '--no-edit'], { cwd: pasta, identidade, prazo: MS.escrita });
      if (rc.codigo !== 0 || rc.estourou) throw erroCommit(rc, info, 'A junção continua aberta.');
      const h = await git(['log', '-1', '--format=%h'], { cwd: pasta });
      return { commit: { sha: h.out.trim() }, resolvidos: pendentes.length };
    });
  }
  function cancelarJuncao(corpo) {
    return acaoNoProjeto('cancelar-juncao', corpo, async (ent) => {
      const info = await exigirGit(ent.pasta);
      if (info.operacao !== 'merge') throw erroHttp(409, 'Não há junção (merge) aberta nesta pasta. Nada mudou.', 'sem-juncao');
      if (!corpo.confirmar) {
        throw pedirConfirmacao({
          titulo: 'Cancelar a junção?',
          mensagem: 'A pasta volta a ficar como antes da junção: os seus commits continuam, e o que veio do GitHub sai. O que você editou para resolver os conflitos se perde.',
          botao: 'Cancelar junção',
          perigo: true,
        });
      }
      const r = await git(['merge', '--abort'], { cwd: ent.pasta, prazo: MS.escrita });
      if (r.codigo !== 0 || r.estourou) throw erroGit(r, { mudou: 'A junção continua aberta.' });
      return {};
    });
  }

  function commit(corpo) {
    return acaoNoProjeto('commit', corpo, async (ent) => {
      const pasta = ent.pasta;
      const mensagem = typeof corpo.mensagem === 'string' ? corpo.mensagem.replace(/\r\n?/g, '\n').trim() : '';
      if (!mensagem || mensagem.length > 5000) throw erroHttp(400, 'Escreva a mensagem do commit (até 5000 caracteres). Nada mudou.', 'mensagem');
      let pedidos = null;
      if (corpo.arquivos != null) {
        if (!Array.isArray(corpo.arquivos) || corpo.arquivos.length > 20000 || !corpo.arquivos.every(caminhoValido)) {
          throw erroHttp(400, 'Lista de arquivos inválida. Nada mudou.', 'arquivos');
        }
        pedidos = [...new Set(corpo.arquivos)];
        if (!pedidos.length) throw erroHttp(400, 'Escolha pelo menos um arquivo. Nada mudou.', 'nada');
      }
      const info = await exigirGit(pasta);
      if (info.operacao) throw erroOperacao(info.operacao);
      const st = await lerStatus(pasta, info, true); // todos os arquivos (pastas novas abertas), para achar os sensíveis
      if (st.arquivos.some((a) => a.tipo === 'conflito')) throw erroHttp(409, 'Há arquivos em conflito nesta pasta. Resolva os conflitos antes de commitar. Nada mudou.', 'operacao');

      let escolhidos = st.arquivos;
      let pathspecs = null;
      if (pedidos) {
        const naoAchados = [];
        const vistos = new Set();
        escolhidos = [];
        for (const p of pedidos) {
          const dir = p.endsWith('/');
          const casam = st.arquivos.filter((a) => a.caminho === p || a.de === p || (dir && a.caminho.startsWith(p)));
          if (!casam.length) naoAchados.push(p);
          for (const a of casam) if (!vistos.has(a)) { vistos.add(a); escolhidos.push(a); }
        }
        if (naoAchados.length) {
          throw erroHttp(400, `Sem alterações em: ${naoAchados.slice(0, 5).join(', ')}${naoAchados.length > 5 ? '…' : ''}. Nada mudou.`, 'arquivos', { arquivos: naoAchados.slice(0, 50) });
        }
        // Renomeado vai inteiro (o nome antigo sai, o novo entra).
        pathspecs = [...new Set([...pedidos, ...escolhidos.flatMap((a) => (a.de ? [a.de, a.caminho] : []))])];
      }
      if (!escolhidos.length) throw erroHttp(400, 'Não há alterações para commitar. Nada mudou.', 'nada');
      const an = await analisarCommit(pasta, st, escolhidos);
      if (an.enormes.length) {
        throw erroHttp(400, `O GitHub recusa arquivos acima de 100 MB: ${an.enormes.slice(0, 5).map((a) => `${a.arquivo} (${a.mb} MB)`).join(', ')}. Tire do commit ou ponha no .gitignore. Nada mudou.`, 'grande', { arquivos: an.enormes });
      }
      const avisos = [
        an.credenciais.length && 'Há algo com cara de senha ou chave nas linhas novas.',
        an.sensiveis.length && 'Há arquivos que costumam guardar senhas ou chaves.',
        an.grandes.length && 'Há arquivos grandes (o GitHub avisa acima de 50 MB).',
        an.geradas.length && 'Há pastas geradas ou arquivos do sistema que costumam ficar no .gitignore.',
      ].filter(Boolean);
      if (avisos.length && !corpo.confirmar) {
        const soSensiveis = avisos.length === 1 && an.sensiveis.length;
        throw pedirConfirmacao({
          titulo: soSensiveis ? 'Commitar arquivos sensíveis?' : 'Commitar mesmo assim?',
          mensagem: `${avisos.join(' ')} Depois de enviados ao GitHub, ficam no histórico.`,
          itens: [
            ...an.sensiveis,
            ...an.credenciais.map((c) => `${c.arquivo}:${c.linha} (${c.tipo})`),
            ...an.grandes.map((g) => `${g.arquivo} (${g.mb} MB)`),
            ...an.geradas.map((g) => `${g.padrao} (${plural(g.arquivos, 'arquivo', 'arquivos')}: ${g.motivo})`),
          ].slice(0, 80),
          botao: 'Commitar mesmo assim',
          perigo: true,
          analise: an,
        });
      }
      const identidade = await identidadePara(pasta);
      let tmp = null;
      try {
        let ra;
        let rc;
        if (pathspecs) {
          // A mensagem vai pelo stdin; a lista, por um arquivo temporário fora do projeto.
          tmp = path.join(os.tmpdir(), `orbit-commit-${process.pid}-${crypto.randomBytes(6).toString('hex')}.txt`);
          await fsp.writeFile(tmp, pathspecs.join('\0') + '\0');
          ra = await git(['--literal-pathspecs', 'add', '-A', `--pathspec-from-file=${tmp}`, '--pathspec-file-nul'], { cwd: pasta, prazo: MS.escrita });
          if (ra.codigo !== 0 || ra.estourou) throw erroGit(ra, { mudou: 'Nada foi commitado.' });
          rc = await git(['--literal-pathspecs', 'commit', '-F', '-', `--pathspec-from-file=${tmp}`, '--pathspec-file-nul'], { cwd: pasta, entrada: mensagem, identidade, prazo: MS.escrita });
        } else {
          ra = await git(['add', '-A'], { cwd: pasta, prazo: MS.escrita });
          if (ra.codigo !== 0 || ra.estourou) throw erroGit(ra, { mudou: 'Nada foi commitado.' });
          rc = await git(['commit', '-F', '-'], { cwd: pasta, entrada: mensagem, identidade, prazo: MS.escrita });
        }
        if (rc.codigo !== 0 || rc.estourou) throw erroCommit(rc, info, 'Nada foi commitado; os arquivos ficaram preparados (staged).');
      } finally {
        if (tmp) await fsp.rm(tmp, { force: true }).catch(() => {});
      }
      const h = await git(['log', '-1', '--format=%h%x09%s'], { cwd: pasta });
      const [sha = '', ...tit] = h.out.trim().split('\t');
      return { commit: { sha, titulo: tit.join('\t') } };
    });
  }

  function buscar(corpo) {
    return acaoNoProjeto('buscar', corpo, async (ent) => {
      const info = await exigirGit(ent.pasta);
      const url = await exigirOrigin(ent.pasta);
      const ultimo = Math.max(ultimoFetch.get(ent.chave) || 0, info.fetchHead || 0);
      if (Date.now() - ultimo < MS_ENTRE_FETCH) return { buscou: false }; // limite: 1 fetch a cada 3 min por pasta
      await buscarOrigin(ent, url);
      return { buscou: true };
    });
  }

  function push(corpo) {
    return acaoNoProjeto('push', corpo, async (ent) => {
      const pasta = ent.pasta;
      const info = await exigirGit(pasta);
      const url = await exigirOrigin(pasta);
      const st = await lerStatus(pasta, info);
      if (!st.branch) throw erroHttp(409, 'O git está num commit solto (HEAD destacado). Troque para um branch antes de enviar. Nada mudou.', 'destacado');
      if (st.semCommits) throw erroHttp(400, 'Este branch ainda não tem commits. Faça um commit antes de enviar. Nada mudou.', 'nada');
      const upOrigin = st.upstream && st.upstream.startsWith('origin/') ? st.upstream.slice(7) : null;
      const destino = upOrigin || st.branch;
      const remotoExiste = await refExiste(pasta, `refs/remotes/origin/${destino}`);
      const intervalo = remotoExiste ? [`refs/remotes/origin/${destino}..HEAD`] : ['HEAD', '--not', '--remotes=origin'];
      const [lg, cnt] = await Promise.all([
        git(['log', '--format=%h%x09%s', '-n', '20', ...intervalo, '--'], { cwd: pasta }),
        git(['rev-list', '--count', ...intervalo, '--'], { cwd: pasta }),
      ]);
      if (cnt.codigo !== 0) throw erroGit(cnt, { mudou: 'Nada foi enviado.' });
      const n = Number(cnt.out.trim()) || 0;
      // Sem upstream (ou com o do GitHub apagado) o envio ainda cria/liga o branch; com upstream em dia, nada a fazer.
      if (n === 0 && upOrigin && remotoExiste) {
        throw erroHttp(400, `Não há commits para enviar: origin/${destino} já está em dia. Nada mudou.`, 'nada');
      }
      const itens = lg.out.split('\n').filter(Boolean).map((l) => { const [h, ...s] = l.split('\t'); return `${h} ${s.join('\t')}`; });
      if (!corpo.confirmar) {
        let mensagem = `${plural(n, 'commit vai', 'commits vão')} para origin/${destino} no GitHub.`;
        if (!remotoExiste) mensagem += ` O branch ${destino} será criado no GitHub.`;
        else if (!upOrigin) mensagem += ` O branch ${st.branch} passa a acompanhar origin/${destino}.`;
        if (n > itens.length) mensagem += ` (mostrando os ${itens.length} mais recentes)`;
        throw pedirConfirmacao({ titulo: 'Enviar para o GitHub?', mensagem, itens, botao: 'Enviar' });
      }
      const token = await tokenPara(url);
      const ssh = await sshEmLote(pasta, url);
      const args = upOrigin ? ['push', 'origin', `HEAD:refs/heads/${destino}`] : ['push', '-u', 'origin', `HEAD:refs/heads/${destino}`];
      const r = await git(args, { cwd: pasta, token, ssh, prazo: MS.escrita });
      if (r.codigo !== 0 || r.estourou) {
        const t = `${r.err}\n${r.out}`;
        if (!r.estourou && /\[remote rejected\]|protected branch|GH006|pre-receive hook declined/i.test(t)) {
          throw erroHttp(409, `O GitHub recusou o envio: ${resumoGit(r)}. Nada mudou no GitHub.`, 'recusado');
        }
        if (!r.estourou && /\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(t)) {
          throw erroHttp(409, 'O GitHub tem commits que você ainda não tem. Receba antes de enviar.', 'rejeitado');
        }
        throw erroGit(r, { token: !!token, faltando: ['contents:write'], mudou: 'Nada foi enviado.', aposPrazo: 'Confira no GitHub se o envio chegou antes de tentar de novo.' });
      }
      return { enviados: n };
    });
  }

  function pull(corpo) {
    return acaoNoProjeto('pull', corpo, async (ent) => {
      const pasta = ent.pasta;
      const mesclar = corpo.mesclar === true;
      const info = await exigirGit(pasta);
      const url = await exigirOrigin(pasta);
      if (info.operacao) throw erroOperacao(info.operacao);
      const st = await lerStatus(pasta, info);
      if (!st.branch) throw erroHttp(409, 'O git está num commit solto (HEAD destacado). Troque para um branch antes de receber. Nada mudou.', 'destacado');
      if (!st.upstream) throw erroHttp(409, `O branch ${st.branch} não acompanha nenhum branch do GitHub. Envie primeiro para criar o vínculo. Nada mudou.`, 'sem-upstream');
      if (st.arquivos.some((a) => a.tipo === 'conflito')) throw erroHttp(409, 'Há arquivos em conflito nesta pasta. Resolva os conflitos antes. Nada mudou.', 'operacao');
      const rastreadas = st.arquivos.filter((a) => a.tipo !== 'nao-rastreado').length;
      if (mesclar) {
        if (rastreadas > 0) throw erroHttp(409, `Há ${plural(rastreadas, 'alteração não commitada', 'alterações não commitadas')}. Faça o commit antes de mesclar. Nada mudou.`, 'sujo');
        if (!corpo.confirmar) {
          throw pedirConfirmacao({
            titulo: 'Mesclar com o GitHub?',
            mensagem: `O seu ${st.branch} e o ${st.upstream} têm commits diferentes (${st.adiante} seus, ${st.atras} do GitHub, na última busca). O Orbit junta os dois num commit de merge. Se houver conflito, ele desfaz e nada muda.`,
            botao: 'Mesclar',
          });
        }
      } else if (st.arquivos.length > 0 && !corpo.confirmar) {
        throw pedirConfirmacao({
          titulo: 'Receber com alterações locais?',
          mensagem: `Você tem ${plural(st.arquivos.length, 'alteração não commitada', 'alterações não commitadas')}. O Orbit só recebe se o git conseguir sem mexer nelas; se algum arquivo conflitar, nada muda.`,
          botao: 'Receber',
        });
      }
      await buscarOrigin(ent, url);
      const cont = await git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], { cwd: pasta });
      if (cont.codigo !== 0) throw erroHttp(409, `O branch ${st.upstream} não existe mais no GitHub. Nada mudou.`, 'sem-upstream');
      const [adiante = 0, atras = 0] = cont.out.trim().split(/\s+/).map(Number);
      if (atras === 0) return { recebidos: 0 };
      if (!mesclar) {
        if (adiante > 0) {
          throw erroHttp(409, `Seu branch e o do GitHub divergiram (${adiante} seus, ${atras} do GitHub). Use Mesclar para juntar. Nada mudou.`, 'divergiu', { adiante, atras });
        }
        const r = await git(['merge', '--ff-only', '@{upstream}'], { cwd: pasta, prazo: MS.escrita });
        if (r.codigo !== 0 || r.estourou) {
          const arqs = arquivosSobrescritos(r);
          if (arqs) throw erroHttp(409, 'O git não recebeu para não pisar nas suas alterações nestes arquivos. Nada mudou.', 'sobrescreveria', { arquivos: arqs });
          throw erroGit(r, { mudou: 'Confira o status da pasta.' });
        }
        return { recebidos: atras };
      }
      const identidade = await identidadePara(pasta);
      const r = await git(['merge', '--no-edit', '@{upstream}'], { cwd: pasta, identidade, prazo: MS.escrita });
      if (r.codigo !== 0 || r.estourou) {
        const arqs = arquivosSobrescritos(r);
        if (arqs) throw erroHttp(409, 'O git não mesclou para não pisar nestes arquivos. Nada mudou.', 'sobrescreveria', { arquivos: arqs });
        if (existe(info.mergeHead) || /CONFLICT|Automatic merge failed/i.test(`${r.out}\n${r.err}`)) {
          const u = await git(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: pasta });
          const arquivos = u.out.split('\0').filter(Boolean).slice(0, MAX_ARQUIVOS);
          // manterConflito (card, 18/10): o usuário pediu para resolver no editor; o merge fica aberto com as marcas
          // <<<<<<< nos arquivos e o card oferece Concluir junção ou Cancelar junção.
          if (corpo.manterConflito === true && arquivos.length && /CONFLICT|Automatic merge failed/i.test(`${r.out}\n${r.err}`)) {
            throw erroHttp(409, `A junção ficou aberta com conflito em ${plural(arquivos.length, 'arquivo', 'arquivos')}. Resolva os trechos marcados com <<<<<<< no editor, salve e conclua.`, 'resolver', { arquivos });
          }
          const ab = await git(['merge', '--abort'], { cwd: pasta, prazo: MS.escrita });
          if (ab.codigo !== 0) {
            throw erroHttp(500, `O merge parou com conflito e não consegui desfazer (${resumoGit(ab)}). Resolva no editor ou rode "git merge --abort".`, 'conflito-aberto', { arquivos });
          }
          if (!/CONFLICT|Automatic merge failed/i.test(`${r.out}\n${r.err}`)) throw erroGit(r, { mudou: 'O Orbit desfez o merge. Nada mudou.' });
          throw erroHttp(409, 'A mesclagem daria conflito nestes arquivos, então o Orbit desfez tudo. Nada mudou.', 'conflito', { arquivos });
        }
        throw erroGit(r, { mudou: 'Confira o status da pasta.' });
      }
      return { recebidos: atras };
    });
  }

  function branch(corpo) {
    return acaoNoProjeto('branch', corpo, async (ent) => {
      const pasta = ent.pasta;
      const bruto = typeof corpo.nome === 'string' ? corpo.nome.trim() : '';
      const invalido = () => erroHttp(400, 'Nome de branch inválido (use letras, números, "-", "_", "." e "/"). Nada mudou.', 'nome');
      if (!bruto || bruto.length > 200 || bruto.startsWith('-') || bruto.includes('@{') || /[\0-\x20\x7f]/.test(bruto)) throw invalido();
      const info = await exigirGit(pasta);
      const chk = await git(['check-ref-format', '--branch', bruto], { cwd: pasta });
      if (chk.codigo !== 0) throw invalido();
      const nome = bruto;
      if (info.operacao) throw erroOperacao(info.operacao);
      const st = await lerStatus(pasta, info);
      if (st.branch === nome) return {};
      const [local, remoto] = await Promise.all([refExiste(pasta, `refs/heads/${nome}`), refExiste(pasta, `refs/remotes/origin/${nome}`)]);
      if (!local && !remoto && corpo.criar !== true) throw erroHttp(404, `Não existe o branch "${nome}". Nada mudou.`, 'sem-branch');
      if (st.arquivos.length > 0 && !corpo.confirmar) {
        throw pedirConfirmacao({
          titulo: `Trocar para ${nome}?`,
          mensagem: st.arquivos.length === 1 ? `A alteração não commitada vai junto para ${nome}.` : `As ${st.arquivos.length} alterações não commitadas vão junto para ${nome}.`,
          itens: st.arquivos.slice(0, 20).map((a) => a.caminho),
          botao: 'Trocar',
        });
      }
      const args = local ? ['switch', '--no-guess', nome]
        : remoto ? ['switch', '--no-guess', '--track', '-c', nome, `origin/${nome}`]
          : ['switch', '--no-guess', '-c', nome];
      const r = await git(args, { cwd: pasta, prazo: MS.escrita });
      if (r.codigo !== 0 || r.estourou) {
        const arqs = arquivosSobrescritos(r);
        if (arqs) throw erroHttp(409, `O git não trocou para ${nome} para não pisar nas suas alterações nestes arquivos. Nada mudou.`, 'sobrescreveria', { arquivos: arqs });
        throw erroGit(r, { mudou: 'Nada mudou.' });
      }
      return {};
    });
  }

  const ACOES = {
    '/repos/adicionar': adicionar,
    '/repos/remover': remover,
    '/repos/clonar': clonar,
    '/repos/vincular': vincular,
    '/repos/desvincular': desvincular,
    '/repos/criar': criar,
    '/repos/commit': commit,
    '/repos/previa': previaCommit,
    '/repos/ignorar': ignorar,
    '/repos/concluir': concluirJuncao,
    '/repos/cancelar-juncao': cancelarJuncao,
    '/repos/buscar': buscar,
    '/repos/push': push,
    '/repos/pull': pull,
    '/repos/branch': branch,
  };

  async function responderErro(res, e) {
    if (e?.verificar) {
      const c = contaSegura();
      if (c) expiradoVisto = c.login;
      try { await github.verificar?.(); } catch {}
    }
    if (e?.corpo) return responder(res, e.status || 409, e.corpo);
    const status = Number(e?.status) || 500;
    if (status >= 500 && !e?.codigo) log('repos: erro', e?.stack || e);
    responder(res, status, { erro: String(e?.message || e), ...(e?.codigo ? { codigo: e.codigo } : {}), ...(e?.extra || {}) });
  }

  async function rota(req, res, caminho, url) {
    if (typeof caminho !== 'string' || !caminho.startsWith('/repos/')) return false;
    try {
      if (req.method === 'GET') {
        const q = url?.searchParams || new URLSearchParams();
        if (caminho === '/repos/projetos') {
          responder(res, 200, { projetos: await listarProjetos(), pastaClones: pastaClones(), github: estadoGithub() });
          return true;
        }
        if (caminho === '/repos/projeto') {
          const pasta = exigirPasta(q.get('pasta'));
          const ent = entradas().find((e) => e.chave === chaveDe(pasta));
          if (!ent) throw erroHttp(404, 'Esta pasta não está na lista de projetos.', 'desconhecida');
          responder(res, 200, { projeto: await montar(ent, { fresco: true }) });
          return true;
        }
        if (caminho === '/repos/branches') {
          responder(res, 200, await listarBranches(exigirProjeto(q.get('pasta'))));
          return true;
        }
        if (caminho === '/repos/github') {
          responder(res, 200, await listarGithub(q.get('forcar') === '1'));
          return true;
        }
        return false;
      }
      if (req.method !== 'POST') return false;
      const fn = ACOES[caminho];
      if (!fn) return false;
      const corpo = await lerJSONCorpo(req);
      if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) throw erroHttp(400, 'Corpo inválido. Nada mudou.');
      responder(res, 200, await fn(corpo));
    } catch (e) {
      await responderErro(res, e);
    }
    return true;
  }

  // Assistente da primeira vez (assistente.mjs): a pasta de projetos do usuário vira a pasta dos clones.
  // Pode conter o Orbit (é o padrão); dentro dele, não. Se não existir, é criada.
  async function definirPastaClones(bruta) {
    const p = exigirPasta(bruta);
    const chave = chaveDe(p);
    if (chave === chaveOrbit || chave.startsWith(chaveOrbit + path.sep)) throw erroHttp(400, 'Escolha uma pasta fora da pasta do Orbit. Nada mudou.', 'pasta');
    await fsp.mkdir(p, { recursive: true });
    if (!(await fsp.stat(p)).isDirectory()) throw erroHttp(400, 'Esse caminho não é uma pasta. Nada mudou.', 'pasta');
    registro.pastaClones = p;
    await salvarRegistro();
    avisarLista();
    return p;
  }

  return { rota, pastaClones, definirPastaClones };
}
