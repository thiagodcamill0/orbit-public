// Orbit — GitHub falso para os testes da rodada 7 (repos.mjs): API em 127.0.0.1 + remotos *bare* numa
// pasta temporária (file://, para ORBIT_GIT_BASE). Nunca fala com o GitHub de verdade.
//
//   import { subirGithubFalso, definirRaizTeste, gitTeste } from './github-falso.mjs';
//   definirRaizTeste(SAIDA);   // gitTeste só roda dentro desta pasta
//   const gh = await subirGithubFalso({ porta, remotos, sementes, token });
//   gh.url   → ORBIT_GITHUB_API          gh.base → ORBIT_GIT_BASE (file:///…/remotos/)
//   gh.semear('nome', { 'a.txt': 'a\n' }, { branches: { outro: { 'o.txt': 'o\n' } } })  → { bare, dir, url }
//   gh.avancar('nome', { 'a.txt': 'novo\n' }, 'mensagem')   → commit novo no remoto (pela semente)
//   gh.adicionar({ nome, … })   só os metadados (repos de enchimento, para a paginação)
//   gh.negar.listar = 'metadata=read'   → 403 com x-accepted-github-permissions (idem negar.criar, negar.repo)
//   gh.estado.tokenVale = false         → 401 em tudo
//   gh.chamadas                          → ['GET /user/repos', 'POST /user/repos', …]
//
// Rotas: GET /user · GET /user/repos (paginado, cabeçalho Link) · GET /repos/:dono/:nome ·
//        POST /user/repos (cria o bare em <remotos>/<login>/<nome>.git; 422 se o nome existe).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

let RAIZ = null;
const chave = (p) => path.resolve(p).toLowerCase();

// gitTeste só age dentro da pasta de saída do teste (nunca em D:\Dev\Projetos\* nem no Orbit).
export function definirRaizTeste(raiz) {
  RAIZ = path.resolve(raiz);
}

export function envGitTeste(teto) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_TRACE\w*|GIT_CEILING_DIRECTORIES|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_AUTHOR_\w+|GIT_COMMITTER_\w+|GIT_ASKPASS|SSH_ASKPASS|LC_ALL|LANG|LANGUAGE)$/i.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    GIT_AUTHOR_NAME: 'Semente', GIT_AUTHOR_EMAIL: 'semente@teste.local',
    GIT_COMMITTER_NAME: 'Semente', GIT_COMMITTER_EMAIL: 'semente@teste.local',
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C',
    // sem o gitconfig do usuário nem do sistema (autocrlf, gpgsign, hooks globais…): o resultado não depende da máquina
    GIT_CONFIG_GLOBAL: os.devnull, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'init.defaultBranch', GIT_CONFIG_VALUE_1: 'main',
    GIT_CONFIG_KEY_2: 'advice.detachedHead', GIT_CONFIG_VALUE_2: 'false',
  });
  if (teto) env.GIT_CEILING_DIRECTORIES = teto;
  return env;
}

export function gitTeste(cwd, args, { entrada } = {}) {
  if (!RAIZ) throw new Error('gitTeste: chame definirRaizTeste(pasta-de-saída) antes');
  const c = chave(cwd);
  if (c !== chave(RAIZ) && !c.startsWith(chave(RAIZ) + path.sep)) throw new Error('gitTeste fora da pasta de teste: ' + cwd);
  return execFileSync('git', args, { cwd, env: envGitTeste(path.dirname(path.resolve(cwd))), encoding: 'utf8', windowsHide: true, input: entrada, stdio: ['pipe', 'pipe', 'pipe'] });
}

export function escrever(dir, arquivos) {
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    const alvo = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(alvo), { recursive: true });
    fs.writeFileSync(alvo, conteudo);
  }
}

function lerCorpo(req) {
  return new Promise((ok) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok(null); } });
    req.on('error', () => ok(null));
  });
}

export async function subirGithubFalso({ porta, remotos, sementes, token, login = 'orbit-teste', id = 42, nome = 'Orbit Teste' }) {
  fs.mkdirSync(path.join(remotos, login), { recursive: true });
  fs.mkdirSync(sementes, { recursive: true });
  const base = pathToFileURL(path.resolve(remotos)).href.replace(/\/*$/, '/');
  const repos = [];
  const estado = { tokenVale: true };
  const negar = { listar: null, criar: null, repo: null };
  const chamadas = [];
  let seq = 1000;
  let portaReal = porta;
  const inicio = Date.now();

  function adicionar({ nome: n, dono = login, privado = true, descricao = '', branch = 'main', pushedAt = null, linguagem = null, push = true, arquivado = false, fork = false }) {
    const i = ++seq;
    const quando = new Date(pushedAt ?? inicio - (i - 1000) * 60e3).toISOString();
    const meta = {
      id: i, name: n, full_name: `${dono}/${n}`, owner: { login: dono }, private: privado, visibility: privado ? 'private' : 'public',
      description: descricao || null, default_branch: branch, pushed_at: quando, updated_at: quando,
      html_url: `https://github.com/${dono}/${n}`, archived: arquivado, fork, language: linguagem,
      permissions: { admin: dono === login, push, pull: true },
    };
    repos.push(meta);
    return meta;
  }

  const acharRepo = (dono, n) => repos.find((r) => r.full_name.toLowerCase() === `${dono}/${n}`.toLowerCase());

  function semear(n, arquivos, opc = {}) {
    const bare = path.join(remotos, login, n + '.git');
    gitTeste(remotos, ['init', '-q', '--bare', '-b', 'main', bare]);
    const dir = path.join(sementes, n);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    gitTeste(sementes, ['clone', '-q', bare, dir]);
    escrever(dir, arquivos);
    gitTeste(dir, ['add', '-A']);
    gitTeste(dir, ['commit', '-q', '-m', 'inicial']);
    gitTeste(dir, ['push', '-q', 'origin', 'main']);
    for (const [b, arqs] of Object.entries(opc.branches || {})) {
      gitTeste(dir, ['switch', '-q', '-c', b, 'main']);
      escrever(dir, arqs);
      gitTeste(dir, ['add', '-A']);
      gitTeste(dir, ['commit', '-q', '-m', 'branch ' + b]);
      gitTeste(dir, ['push', '-q', 'origin', b]);
      gitTeste(dir, ['switch', '-q', 'main']);
    }
    if (!acharRepo(login, n)) adicionar({ nome: n, privado: opc.privado !== false, descricao: opc.descricao || '', pushedAt: Date.now() - repos.length });
    return { bare, dir, url: `${base}${login}/${n}.git` };
  }

  // Commit novo no remoto, feito pela semente (que primeiro se alinha ao remoto).
  function avancar(n, arquivos, mensagem = 'commit do GitHub', branch = 'main') {
    const dir = path.join(sementes, n);
    gitTeste(dir, ['fetch', '-q', 'origin']);
    gitTeste(dir, ['switch', '-q', branch]);
    gitTeste(dir, ['reset', '-q', '--hard', `origin/${branch}`]); // só na semente do teste
    escrever(dir, arquivos);
    gitTeste(dir, ['add', '-A']);
    gitTeste(dir, ['commit', '-q', '-m', mensagem]);
    gitTeste(dir, ['push', '-q', 'origin', branch]);
    return gitTeste(dir, ['rev-parse', 'HEAD']).trim();
  }

  const json = (r, status, corpo, cab = {}) => {
    r.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...cab });
    r.end(JSON.stringify(corpo));
  };
  const proibido = (r, perm) => json(r, 403, { message: 'Resource not accessible by personal access token' }, { 'x-accepted-github-permissions': perm });

  const srv = http.createServer(async (req, r) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    chamadas.push(`${req.method} ${u.pathname}`);
    const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (tok !== token || !estado.tokenVale) return json(r, 401, { message: 'Bad credentials' });

    if (req.method === 'GET' && u.pathname === '/user') return json(r, 200, { login, id, name: nome, avatar_url: '' });

    if (req.method === 'GET' && u.pathname === '/user/repos') {
      if (negar.listar) return proibido(r, negar.listar);
      const por = Math.min(100, Math.max(1, Number(u.searchParams.get('per_page')) || 30));
      const pag = Math.max(1, Number(u.searchParams.get('page')) || 1);
      const lista = [...repos].sort((a, b) => Date.parse(b.pushed_at) - Date.parse(a.pushed_at));
      const total = Math.max(1, Math.ceil(lista.length / por));
      const link = (p) => {
        const x = new URL(u.pathname + u.search, `http://127.0.0.1:${portaReal}`);
        x.searchParams.set('page', String(p));
        return `<${x.href}>`;
      };
      const partes = [];
      if (pag < total) partes.push(`${link(pag + 1)}; rel="next"`, `${link(total)}; rel="last"`);
      if (pag > 1) partes.push(`${link(pag - 1)}; rel="prev"`, `${link(1)}; rel="first"`);
      return json(r, 200, lista.slice((pag - 1) * por, pag * por), partes.length ? { link: partes.join(', ') } : {});
    }

    const m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (req.method === 'GET' && m) {
      if (negar.repo) return proibido(r, negar.repo);
      const x = acharRepo(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      return x ? json(r, 200, x) : json(r, 404, { message: 'Not Found' });
    }

    if (req.method === 'POST' && u.pathname === '/user/repos') {
      if (negar.criar) return proibido(r, negar.criar);
      const corpo = await lerCorpo(req);
      const n = corpo && typeof corpo.name === 'string' ? corpo.name : '';
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(n)) return json(r, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'invalid' }] });
      if (acharRepo(login, n)) {
        return json(r, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
      }
      gitTeste(remotos, ['init', '-q', '--bare', '-b', 'main', path.join(remotos, login, n + '.git')]);
      const meta = adicionar({ nome: n, privado: corpo.private !== false, descricao: corpo.description || '', pushedAt: Date.now() });
      return json(r, 201, meta);
    }

    json(r, 404, { message: 'Not Found' });
  });

  await new Promise((ok, falha) => {
    srv.once('error', falha);
    srv.listen(porta, '127.0.0.1', ok);
  });
  portaReal = srv.address().port;
  return {
    porta: portaReal,
    url: `http://127.0.0.1:${portaReal}`,
    base,
    login,
    id,
    repos,
    estado,
    negar,
    chamadas,
    adicionar,
    semear,
    avancar,
    fechar: () => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(() => ok()); }),
  };
}
