// Conexões MCP (Configurações → Conexões MCP). Página: assets/mcp.js. Pesquisa e testes do 2.1.300: cofre,
// 06 Referências/Claude Code por dentro, seção MCP (17/10).
//
// Onde moram (o que o Orbit lê):
//   - projeto: <pasta>/.mcp.json e os .mcp.json das pastas de cima (o claude lê todos, testado);
//   - pessoal deste projeto ("local" do claude): projects[<pasta>].mcpServers do ~/.claude.json;
//   - pessoal de todos os projetos ("user"): mcpServers do ~/.claude.json;
//   - plugins e claude.ai: só pela sonda (mcp_status), só leitura.
//
// Decisões do usuário (17/10):
//   - adicionar vai para o .mcp.json do projeto por padrão; o ~/.claude.json só com `confirmarPessoal: true`
//     (sem ele, 428 `confirmar_pessoal` e nada muda);
//   - chaves de acesso nunca no projeto: o valor vai cifrado para o cofre do Orbit (perfil.criarCofreTexto: DPAPI
//     no Windows, Chaveiro no Mac) e o arquivo leva só ${ORBIT_MCP_…}. Só as instâncias do Orbit recebem o valor
//     (no env do processo, ver protecao()); o VS Code e o terminal não;
//   - aprovação como a do VS Code, mas no Orbit: servidor novo ou alterado num .mcp.json fica pendente e as
//     instâncias do Orbit não o conectam (vai no disabledMcpjsonServers do --settings do processo) até a
//     aprovação aqui. A aprovação guarda o hash da configuração, por arquivo e nome, em <dados>/mcp-orbit.json;
//     mudou a configuração, volta a pendente. Vale para qualquer pasta, também para repositório clonado;
//   - desativar: projeto no disabledMcpjsonServers do <pasta>/.claude/settings.json; pessoal no
//     projects[<pasta>].disabledMcpServers do ~/.claude.json (só aquele projeto, com confirmação).
//
// Rotas: GET /mcp?pasta · POST /mcp/verificar · /mcp/adicionar · /mcp/remover · /mcp/ativo · /mcp/aprovar ·
// /mcp/proteger. Toda mudança difunde o SSE "mcp" {pasta}.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const RE_NOME = /^[A-Za-z0-9_-]{1,64}$/; // o claude só aceita estes no nome (e nas listas de aprovação)
const RE_ENV = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RE_CABECALHO = /^[A-Za-z0-9-]{1,64}$/;
const RE_VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;
const PREFIXO = 'ORBIT_MCP_';
const MAX_CHAVES = 20;
const MAX_VALOR = 8192;
const MS_COFRE = 10 * 60e3; // o mapa decifrado fica em memória por até 10 min (como o token do GitHub)
const MS_SONDA_VALE = 60e3;
const ONDES = ['projeto', 'local', 'pessoal'];
const SENSIVEL = /token|secret|senha|password|passwd|api[_-]?key|apikey|(^|[_-])key($|[_-])|auth|credential|bearer|private[_-]?key|access[_-]?key|client[_-]?secret/i;
const CABECALHO_SENSIVEL = /^(authorization|proxy-authorization|cookie)$/i;
const FORMATO_CHAVE = /^(sk-[A-Za-z0-9_-]{16,}|sk_(live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|Bearer\s+\S{8,})/i;

function responder(res, codigo, corpo) {
  if (res.headersSent) return;
  res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
}
function erro(status, msg, codigo) {
  const e = new Error(msg);
  e.status = status;
  if (codigo) e.codigo = codigo;
  return e;
}
const chave = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const encurtar = (t, max) => { const s = String(t ?? ''); return s.length > max ? s.slice(0, max - 1) + '…' : s; };
const lista = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const objeto = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// ───────────── utilidades puras (testadas em mcp.test.mjs) ─────────────

// "npx -y @x/y --dir \"C:\\Meus docs\"" → ['npx', '-y', '@x/y', '--dir', 'C:\\Meus docs']. Aspas simples ou
// duplas agrupam; a barra invertida é literal (caminhos do Windows).
export function dividirComando(texto) {
  const out = [];
  let atual = '', aspas = null, tem = false;
  for (const ch of String(texto ?? '')) {
    if (aspas) {
      if (ch === aspas) aspas = null;
      else atual += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { aspas = ch; tem = true; continue; }
    if (/\s/.test(ch)) {
      if (tem) out.push(atual);
      atual = '';
      tem = false;
      continue;
    }
    atual += ch;
    tem = true;
  }
  if (aspas) throw erro(400, 'Há aspas sem fechar no comando.');
  if (tem) out.push(atual);
  return out;
}

// O que identifica a configuração para a aprovação: o JSON com as chaves em ordem (o mesmo servidor escrito
// com outra ordem continua aprovado; qualquer valor diferente volta a pendente).
function ordenado(v) {
  if (Array.isArray(v)) return v.map(ordenado);
  if (objeto(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, ordenado(v[k])]));
  return v;
}
export function hashServidor(cfg) {
  return crypto.createHash('sha256').update(JSON.stringify(ordenado(cfg ?? null))).digest('hex').slice(0, 32);
}

export const transporteDe = (cfg) => (typeof cfg?.type === 'string' && cfg.type ? cfg.type : cfg?.url && !cfg?.command ? 'http' : 'stdio');

// Variáveis ${X} usadas na configuração (command, args, env, url e headers: onde o claude expande).
export function variaveisDe(cfg) {
  const s = new Set();
  const ver = (v) => { if (typeof v === 'string') for (const m of v.matchAll(RE_VAR)) s.add(m[1]); };
  ver(cfg?.command);
  ver(cfg?.url);
  for (const a of lista(cfg?.args)) ver(a);
  for (const v of Object.values(objeto(cfg?.env) ? cfg.env : {})) ver(v);
  for (const v of Object.values(objeto(cfg?.headers) ? cfg.headers : {})) ver(v);
  return [...s];
}

// Valores que parecem chave escritos direto no arquivo (sem ${…}). Devolve onde: env/header (com `chave`, dá para
// proteger), arg (com `indice`) e url (com `chave` do parâmetro, ou sem ela para usuário:senha na URL).
const literal = (v) => typeof v === 'string' && v.length >= 8 && !v.includes('${') && !/^(true|false|null|\d+)$/i.test(v);
export function textoPuro(cfg) {
  const out = [];
  if (!objeto(cfg)) return out;
  for (const [k, v] of Object.entries(objeto(cfg.env) ? cfg.env : {})) if (literal(v) && (SENSIVEL.test(k) || FORMATO_CHAVE.test(v))) out.push({ onde: 'env', chave: k });
  for (const [k, v] of Object.entries(objeto(cfg.headers) ? cfg.headers : {})) if (literal(v) && (CABECALHO_SENSIVEL.test(k) || SENSIVEL.test(k) || FORMATO_CHAVE.test(v))) out.push({ onde: 'header', chave: k });
  const args = lista(cfg.args);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = /^--?([\w.-]+)=(.*)$/.exec(a);
    if (m) { if (SENSIVEL.test(m[1]) && literal(m[2])) out.push({ onde: 'arg', indice: i }); continue; }
    if (/^--?[\w.-]+$/.test(a) && SENSIVEL.test(a) && i + 1 < args.length && !args[i + 1].startsWith('-') && literal(args[i + 1])) { out.push({ onde: 'arg', indice: i + 1 }); i++; continue; }
    if (FORMATO_CHAVE.test(a)) out.push({ onde: 'arg', indice: i });
  }
  if (typeof cfg.url === 'string') {
    let u = null;
    try { u = new URL(cfg.url); } catch {}
    if (u) {
      if (u.username || u.password) out.push({ onde: 'url' });
      for (const [k, v] of u.searchParams) if (SENSIVEL.test(k) && literal(v)) out.push({ onde: 'url', chave: k });
    }
  }
  return out;
}

// ORBIT_MCP_<SERVIDOR>_<CHAVE>_<4 hex>: o sufixo aleatório separa dois projetos com o mesmo servidor.
export function nomeVariavel(servidor, chaveNome) {
  const slug = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'X';
  return `${PREFIXO}${slug(servidor)}_${slug(chaveNome)}_${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

// O que a página mostra do comando: aspas onde há espaço e •••• no que parece chave.
function textoComando(cfg) {
  const ocultos = new Set(textoPuro(cfg).filter((x) => x.onde === 'arg').map((x) => x.indice));
  const q = (s) => (/[\s"]/.test(s) || s === '' ? `"${s.replace(/"/g, '\\"')}"` : s);
  const partes = [typeof cfg.command === 'string' ? q(cfg.command) : '?'];
  lista(cfg.args).forEach((a, i) => {
    if (!ocultos.has(i)) { partes.push(q(a)); return; }
    const m = /^(--?[\w.-]+=)/.exec(a);
    partes.push((m ? m[1] : '') + '••••••');
  });
  return partes.join(' ');
}
function textoUrl(cfg) {
  if (typeof cfg.url !== 'string') return '';
  try {
    const u = new URL(cfg.url);
    if (u.username) u.username = '••••';
    if (u.password) u.password = '••••';
    for (const [k, v] of [...u.searchParams]) if (SENSIVEL.test(k) && literal(v)) u.searchParams.set(k, '••••');
    return decodeURI(u.toString());
  } catch {
    return encurtar(cfg.url, 500);
  }
}

// ───────────── módulo ─────────────
export function criarMcp(deps) {
  const {
    sessoes = () => [],
    pastaOrbit,
    dados,
    difundir = () => {},
    lerJSONCorpo,
    log = () => {},
    casa = os.homedir(),
    sondar = null, // (pasta, {bloquear, env}) => Promise<mcp_status.mcpServers>
    cofre = null, // { ler(): Promise<string>, guardar(texto) } (perfil.criarCofreTexto)
  } = deps;
  const casaK = chave(casa);
  const CLAUDE_JSON = path.join(casa, '.claude.json');
  const ARQ_ESTADO = path.join(dados, 'mcp-orbit.json');

  let fila = Promise.resolve();
  function emFila(fn) {
    const p = fila.then(() => fn());
    fila = p.catch(() => {});
    return p;
  }

  // ── pastas (as mesmas regras das skills: a pessoal e as de cima dela ficam de fora) ──
  function proibida(k) {
    return k === casaK || casaK.startsWith(k.endsWith(path.sep) ? k : k + path.sep) || path.parse(k).root === k;
  }
  function pastas() {
    const m = new Map();
    const pos = (p, nome) => {
      if (typeof p !== 'string' || !p) return;
      const k = chave(p);
      if (m.has(k) || proibida(k)) return;
      try { if (!fs.statSync(p).isDirectory()) return; } catch { return; }
      m.set(k, { pasta: path.resolve(p), nome: nome || path.basename(p) });
    };
    if (pastaOrbit) pos(pastaOrbit, 'Orbit');
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dados, 'projetos.json'), 'utf8'));
      for (const it of Array.isArray(j?.lista) ? j.lista : []) pos(it?.pasta, it?.nome);
    } catch {}
    for (const s of sessoes()) pos(s?.cwd, s?.projeto);
    return m;
  }
  function pastaValida(p) {
    if (typeof p !== 'string' || !p) throw erro(400, 'pasta ausente');
    const k = chave(p);
    if (proibida(k)) throw erro(403, 'Essa pasta é a pessoal (ou uma de cima dela).');
    const it = pastas().get(k);
    if (!it) throw erro(404, 'Pasta desconhecida: só valem as pastas dos projetos e das sessões do Orbit.', 'pasta_desconhecida');
    return it.pasta;
  }

  // ── arquivos JSON ──
  async function lerJson(arq) {
    let bruto;
    try { bruto = await fsp.readFile(arq, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { json: {}, existe: false };
      throw e;
    }
    const texto = bruto.replace(/^﻿/, '');
    if (!texto.trim()) return { json: {}, existe: true };
    let json;
    try { json = JSON.parse(texto); } catch { return { invalido: true, existe: true }; }
    if (!objeto(json)) return { invalido: true, existe: true };
    return { json, existe: true, eol: bruto.includes('\r\n') ? '\r\n' : '\n' };
  }
  async function gravarAtomico(arq, texto) {
    await fsp.mkdir(path.dirname(arq), { recursive: true });
    const tmp = `${arq}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(tmp, texto, 'utf8');
      await fsp.rename(tmp, arq);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      log('mcp: gravação atômica falhou, gravando direto:', e.code || e.message);
      await fsp.writeFile(arq, texto, 'utf8');
    }
  }
  const gravarJson = (arq, json, eol = '\n') => gravarAtomico(arq, JSON.stringify(json, null, 2).replace(/\n/g, eol) + eol);

  // ── estado do Orbit: aprovações e o índice (sem valor) das chaves guardadas ──
  function lerEstado() {
    try {
      const j = JSON.parse(fs.readFileSync(ARQ_ESTADO, 'utf8'));
      return { aprovados: objeto(j?.aprovados) ? j.aprovados : {}, segredos: objeto(j?.segredos) ? j.segredos : {} };
    } catch {
      return { aprovados: {}, segredos: {} };
    }
  }
  const gravarEstado = (e) => gravarJson(ARQ_ESTADO, { versao: 1, aprovados: e.aprovados, segredos: e.segredos });
  function aprovacaoDe(est, arq, nome, hash) {
    const a = est.aprovados[chave(arq)]?.[nome];
    if (!a) return 'pendente';
    return a.hash === hash ? 'aprovado' : 'alterado';
  }
  function aprovar(est, arq, nome, hash) {
    const k = chave(arq);
    est.aprovados[k] = { ...(est.aprovados[k] || {}), [nome]: { hash, quando: new Date().toISOString() } };
  }

  // ── cofre (um mapa VARIÁVEL → valor, cifrado inteiro) ──
  let mem = null;
  async function lerCofre() {
    if (!cofre) throw erro(501, 'O cofre das chaves não está disponível neste servidor.');
    if (mem && mem.ate > Date.now()) return { ...mem.mapa };
    const t = await cofre.ler();
    let mapa = {};
    if (t) {
      try { mapa = JSON.parse(t); } catch { throw erro(500, 'O cofre das chaves MCP não abriu (conteúdo inválido).'); }
      if (!objeto(mapa)) mapa = {};
    }
    mem = { mapa, ate: Date.now() + MS_COFRE };
    return { ...mapa };
  }
  async function gravarCofre(mapa) {
    await cofre.guardar(JSON.stringify(mapa));
    mem = { mapa: { ...mapa }, ate: Date.now() + MS_COFRE };
  }

  // ── leitura das configurações ──
  function cadeia(pasta) {
    const l = [];
    let d = path.resolve(pasta);
    for (;;) {
      l.push(path.join(d, '.mcp.json'));
      const p = path.dirname(d);
      if (p === d) break;
      d = p;
    }
    return l;
  }
  async function lerProjeto(pasta) {
    const r = [];
    for (const arq of cadeia(pasta)) {
      const j = await lerJson(arq).catch(() => ({ invalido: true, existe: true }));
      if (j.existe) r.push({ arq, ...j });
    }
    return r;
  }
  const servidoresDe = (j) => (objeto(j?.mcpServers) ? Object.entries(j.mcpServers).filter(([, c]) => objeto(c)) : []);
  async function desativadosProjeto(pasta) {
    const s = await lerJson(path.join(pasta, '.claude', 'settings.json')).catch(() => ({ invalido: true }));
    const l = await lerJson(path.join(pasta, '.claude', 'settings.local.json')).catch(() => ({ invalido: true }));
    return { projeto: lista(s.json?.disabledMcpjsonServers), local: lista(l.json?.disabledMcpjsonServers), invalido: !!s.invalido };
  }
  // ~/.claude.json: a chave do projeto é a pasta com barra normal ('d:/Dev/...'); no Windows, sem caixa.
  const normProj = (p) => path.resolve(p).replace(/\\/g, '/');
  function chaveProjeto(json, pasta) {
    const alvo = normProj(pasta);
    const igual = process.platform === 'win32' ? (a) => a.replace(/\\/g, '/').toLowerCase() === alvo.toLowerCase() : (a) => a === alvo;
    return Object.keys(objeto(json?.projects) ? json.projects : {}).find(igual) || null;
  }
  async function lerPessoal(pasta) {
    const cj = await lerJson(CLAUDE_JSON).catch(() => ({ invalido: true, existe: true }));
    const k = cj.invalido ? null : chaveProjeto(cj.json, pasta);
    const pj = k ? cj.json.projects[k] : null;
    return {
      cj,
      local: objeto(pj) ? servidoresDe(pj) : [],
      pessoal: cj.invalido ? [] : servidoresDe(cj.json),
      desativados: objeto(pj) ? lista(pj.disabledMcpServers) : [],
    };
  }

  function linha(o) {
    const { cfg } = o;
    const transporte = transporteDe(cfg);
    const est = o.est;
    const vars = variaveisDe(cfg);
    return {
      id: `${o.onde}:${o.arquivo ? chave(o.arquivo) : ''}:${o.nome}`,
      nome: o.nome,
      onde: o.onde,
      ...(o.arquivo ? { arquivo: o.arquivo } : {}),
      ...(o.herdado ? { herdado: true } : {}),
      tipo: transporte === 'stdio' ? 'local' : 'remoto',
      transporte,
      ...(transporte === 'stdio' ? { comando: textoComando(cfg) } : { url: textoUrl(cfg) }),
      ...(objeto(cfg.env) && Object.keys(cfg.env).length ? { env: Object.keys(cfg.env).slice(0, 40) } : {}),
      ...(objeto(cfg.headers) && Object.keys(cfg.headers).length ? { cabecalhos: Object.keys(cfg.headers).slice(0, 40) } : {}),
      chaves: vars.filter((v) => v.startsWith(PREFIXO)).map((v) => ({ variavel: v, guardada: !!est.segredos[v], ...(est.segredos[v]?.chave ? { chave: est.segredos[v].chave } : {}) })),
      variaveis: vars.filter((v) => !v.startsWith(PREFIXO)),
      textoPuro: textoPuro(cfg),
      ...(o.onde === 'projeto' ? { hash: o.hash, aprovacao: o.aprovacao } : {}),
      desativado: !!o.desativado,
      editavel: true,
    };
  }

  // ── sonda (status), por pasta ──
  const sondas = new Map(); // chave da pasta → { quando, lista, erro } ou { pr }
  function invalidar(pasta) {
    if (pasta) sondas.delete(chave(pasta));
    else sondas.clear();
  }
  function rodarSonda(pasta) {
    const k = chave(pasta);
    const atual = sondas.get(k);
    if (atual?.pr) return atual.pr;
    const pr = (async () => {
      if (!sondar) return { quando: Date.now(), lista: null, erro: 'sem sonda neste servidor' };
      try {
        const l = await sondar(pasta, await protecao(pasta));
        return { quando: Date.now(), lista: Array.isArray(l) ? l : [], erro: '' };
      } catch (e) {
        return { quando: Date.now(), lista: null, erro: encurtar(e?.message || e, 300) };
      }
    })().then((r) => { if (sondas.get(k)?.pr === pr) sondas.set(k, r); return r; });
    sondas.set(k, { ...(atual || {}), pr });
    return pr;
  }

  async function listar(pasta) {
    const est = lerEstado();
    const [proj, des, pess] = await Promise.all([lerProjeto(pasta), desativadosProjeto(pasta), lerPessoal(pasta)]);
    const servidores = [];
    const avisos = [];
    for (const f of proj) {
      if (f.invalido) { avisos.push(`O arquivo ${f.arq} tem JSON inválido: o Orbit não lê nem muda os servidores dele.`); continue; }
      for (const [nome, cfg] of servidoresDe(f.json)) {
        const hash = hashServidor(cfg);
        servidores.push(linha({
          est, onde: 'projeto', arquivo: f.arq, herdado: chave(path.dirname(f.arq)) !== chave(pasta), nome, cfg, hash,
          aprovacao: aprovacaoDe(est, f.arq, nome, hash),
          desativado: des.projeto.includes(nome) || des.local.includes(nome),
        }));
      }
    }
    for (const [nome, cfg] of pess.local) servidores.push(linha({ est, onde: 'local', nome, cfg, desativado: pess.desativados.includes(nome) }));
    for (const [nome, cfg] of pess.pessoal) servidores.push(linha({ est, onde: 'pessoal', nome, cfg, desativado: pess.desativados.includes(nome) }));
    if (pess.cj.invalido) avisos.push(`O ${CLAUDE_JSON} não pôde ser lido: os servidores pessoais não aparecem.`);
    if (des.invalido) avisos.push('O .claude/settings.json deste projeto tem JSON inválido: o Orbit não muda o ativo/inativo até ele ser corrigido.');

    // Status: o da última sonda (até 60 s). Pendente e desativado não conectam, então não vêm da sonda.
    const s = sondas.get(chave(pasta));
    const sonda = s && !s.pr && Date.now() - s.quando < MS_SONDA_VALE ? s : null;
    const escopo = { project: 'projeto', local: 'local', user: 'pessoal' };
    const usados = new Set();
    for (const v of servidores) {
      if (v.onde === 'projeto' && v.aprovacao !== 'aprovado') { v.status = 'pendente'; continue; }
      if (v.desativado) { v.status = 'desativado'; continue; }
      if (!sonda?.lista) continue;
      const e = sonda.lista.find((x) => !usados.has(x) && x?.name === v.nome && escopo[x.scope] === v.onde);
      if (!e) { v.status = 'ausente'; continue; }
      usados.add(e);
      v.status = String(e.status || 'desconhecido');
      if (e.error) v.erro = encurtar(e.error, 300);
    }
    // O que só a sonda vê (plugins, conectores do claude.ai): só leitura.
    if (sonda?.lista) {
      for (const e of sonda.lista) {
        if (usados.has(e) || !e || typeof e.name !== 'string' || escopo[e.scope]) continue;
        const cfg = objeto(e.config) ? e.config : {};
        const transporte = transporteDe(cfg);
        servidores.push({
          id: `${e.scope || 'outro'}::${e.name}`,
          nome: e.name,
          // No 2.1.300 os de plugin vêm com o nome "plugin:<plugin>:<servidor>" (escopo dynamic ou plugin).
          onde: e.scope === 'claudeai' ? 'claude.ai' : e.scope === 'plugin' || e.name.startsWith('plugin:') ? 'plugin' : e.scope === 'managed' || e.scope === 'enterprise' ? 'gerenciado' : String(e.scope || 'outro'),
          tipo: transporte === 'stdio' ? 'local' : 'remoto',
          transporte,
          ...(transporte === 'stdio' && cfg.command ? { comando: textoComando(cfg) } : cfg.url ? { url: textoUrl(cfg) } : {}),
          chaves: [], variaveis: [], textoPuro: [],
          desativado: e.status === 'disabled',
          status: String(e.status || 'desconhecido'),
          ...(e.error ? { erro: encurtar(e.error, 300) } : {}),
          editavel: false,
        });
      }
    }
    const ordem = { projeto: 0, local: 1, pessoal: 2, plugin: 3, 'claude.ai': 4 };
    servidores.sort((a, b) => (a.status === 'pendente' ? 0 : 1) - (b.status === 'pendente' ? 0 : 1) || (ordem[a.onde] ?? 9) - (ordem[b.onde] ?? 9) || a.nome.localeCompare(b.nome));
    return {
      pasta,
      projetos: [...pastas().values()],
      servidores,
      pendentes: servidores.filter((v) => v.status === 'pendente').length,
      sonda: { ok: !!sonda?.lista, erro: sonda && !sonda.lista ? sonda.erro : '', quando: sonda ? new Date(sonda.quando).toISOString() : null, rodando: !!s?.pr },
      cofre: !!cofre,
      claudeJson: CLAUDE_JSON,
      avisos,
    };
  }

  // ── proteção de cada lançamento (controle.mjs): o que bloquear e as chaves que vão no env ──
  async function protecao(cwd) {
    const est = lerEstado();
    const bloquear = new Set();
    const precisa = new Set();
    const des = await desativadosProjeto(cwd);
    for (const f of await lerProjeto(cwd)) {
      if (f.invalido) continue;
      for (const [nome, cfg] of servidoresDe(f.json)) {
        if (aprovacaoDe(est, f.arq, nome, hashServidor(cfg)) !== 'aprovado') { bloquear.add(nome); continue; }
        if (des.projeto.includes(nome) || des.local.includes(nome)) continue;
        for (const v of variaveisDe(cfg)) if (v.startsWith(PREFIXO)) precisa.add(v);
      }
    }
    const pess = await lerPessoal(cwd);
    for (const [nome, cfg] of [...pess.local, ...pess.pessoal]) {
      if (pess.desativados.includes(nome)) continue;
      for (const v of variaveisDe(cfg)) if (v.startsWith(PREFIXO)) precisa.add(v);
    }
    const env = {};
    if (precisa.size && cofre) {
      let mapa = {};
      try { mapa = await lerCofre(); } catch (e) { log('mcp: o cofre das chaves não abriu; as instâncias sobem sem elas:', e?.message || e); }
      for (const v of precisa) if (typeof mapa[v] === 'string') env[v] = mapa[v];
    }
    return { bloquear: [...bloquear], env };
  }

  // ── escrita ──
  function exigirPessoal(onde, c, acao) {
    if (onde === 'projeto' || c.confirmarPessoal === true) return;
    const alcance = onde === 'pessoal' ? 'vale para todos os projetos' : 'vale só para este projeto, mas fica no seu arquivo pessoal';
    throw erro(428, `${acao} muda o ${CLAUDE_JSON}, a configuração pessoal do Claude Code (${alcance}). Confirme para seguir.`, 'confirmar_pessoal');
  }
  function mudou(pasta) {
    invalidar(pasta);
    difundir('mcp', { pasta: pasta || null });
  }
  function arquivoDaCadeia(pasta, arq) {
    if (typeof arq !== 'string' || !arq) throw erro(400, 'arquivo ausente');
    const achado = cadeia(pasta).find((a) => chave(a) === chave(arq));
    if (!achado) throw erro(400, 'Esse arquivo não é um .mcp.json deste projeto.');
    return achado;
  }
  async function claudeJsonParaEscrever() {
    const cj = await lerJson(CLAUDE_JSON);
    if (cj.invalido) throw erro(409, `O ${CLAUDE_JSON} não pôde ser lido como JSON; o Orbit não regrava.`);
    return cj;
  }
  function destinoPessoal(cj, onde, pasta, criar) {
    if (onde === 'pessoal') return cj.json;
    const p = cj.json.projects = objeto(cj.json.projects) ? cj.json.projects : {};
    const k = chaveProjeto(cj.json, pasta) || normProj(pasta);
    if (!objeto(p[k])) { if (!criar) return null; p[k] = {}; }
    return p[k];
  }
  function lerChaves(c, tipo) {
    const l = c.chaves == null ? [] : c.chaves;
    if (!Array.isArray(l) || l.length > MAX_CHAVES) throw erro(400, `Use até ${MAX_CHAVES} chaves de acesso.`);
    const vistos = new Set();
    return l.map((x) => {
      const nome = typeof x?.chave === 'string' ? x.chave.trim() : '';
      const valor = typeof x?.valor === 'string' ? x.valor.trim() : '';
      if (tipo === 'local' ? !RE_ENV.test(nome) : !RE_CABECALHO.test(nome)) {
        throw erro(400, tipo === 'local' ? 'O nome da chave é uma variável de ambiente: letras, números e _ (como API_KEY).' : 'O nome da chave é um cabeçalho HTTP: letras, números e hífen (como Authorization).');
      }
      if (!valor) throw erro(400, `Escreva o valor da chave ${nome}.`);
      if (valor.length > MAX_VALOR || /[\r\n\0]/.test(valor)) throw erro(400, `O valor da chave ${nome} é inválido (uma linha, até 8 KB).`);
      const k = tipo === 'local' ? nome.toUpperCase() : nome.toLowerCase();
      if (vistos.has(k)) throw erro(400, `A chave ${nome} aparece duas vezes.`);
      vistos.add(k);
      return { chave: nome, valor };
    });
  }
  const avisoChave = (tp) => {
    const onde = tp.onde === 'url' ? 'na URL' : 'no comando';
    return `Parece haver uma chave de acesso ${onde}. Tire-a dali e coloque em "Chaves de acesso": lá ela fica cifrada fora do projeto.`;
  };

  async function adicionar(c) {
    const pasta = pastaValida(c.pasta);
    const nome = typeof c.nome === 'string' ? c.nome.trim() : '';
    if (!RE_NOME.test(nome)) throw erro(400, 'Use no nome só letras, números, hífen e _ (até 64), como github ou meu-banco.');
    if (c.tipo !== 'local' && c.tipo !== 'remoto') throw erro(400, 'O tipo deve ser "local" ou "remoto".');
    const onde = c.onde ?? 'projeto';
    if (!ONDES.includes(onde)) throw erro(400, 'Salvar em: projeto, local ou pessoal.');
    exigirPessoal(onde, c, 'Adicionar um servidor pessoal');
    const chaves = lerChaves(c, c.tipo);
    let cfg;
    if (c.tipo === 'local') {
      const partes = dividirComando(c.comando);
      if (!partes.length || !partes[0]) throw erro(400, 'Escreva o comando que sobe o servidor, como npx -y @modelcontextprotocol/server-memory.');
      if (String(c.comando).length > 4000) throw erro(400, 'O comando é longo demais.');
      cfg = { type: 'stdio', command: partes[0], args: partes.slice(1) };
    } else {
      const bruta = typeof c.url === 'string' ? c.url.trim() : '';
      let u;
      try { u = new URL(bruta); } catch {}
      if (!u || !/^https?:$/.test(u.protocol) || bruta.length > 2000) throw erro(400, 'Use uma URL completa com http:// ou https://, como https://mcp.exemplo.com/mcp.');
      const transporte = c.transporte == null ? 'http' : c.transporte;
      if (transporte !== 'http' && transporte !== 'sse') throw erro(400, 'O transporte remoto deve ser http ou sse.');
      cfg = { type: transporte, url: bruta };
    }
    const tp = textoPuro(cfg);
    if (tp.length) throw erro(400, avisoChave(tp[0]), 'chave_em_texto');
    const novas = {};
    const indice = {};
    if (chaves.length) {
      const campo = c.tipo === 'local' ? 'env' : 'headers';
      cfg[campo] = {};
      for (const k of chaves) {
        const v = nomeVariavel(nome, k.chave);
        cfg[campo][k.chave] = '${' + v + '}';
        novas[v] = k.valor;
        indice[v] = { pasta, servidor: nome, chave: k.chave, onde, quando: new Date().toISOString() };
      }
    }
    return emFila(async () => {
      // Confere o destino antes de guardar a chave (nome repetido ou JSON inválido não deixam lixo no cofre).
      let gravar;
      if (onde === 'projeto') {
        const arq = path.join(pasta, '.mcp.json');
        const r = await lerJson(arq);
        if (r.invalido) throw erro(409, `O ${arq} tem JSON inválido; corrija à mão antes.`);
        const json = r.json;
        json.mcpServers = objeto(json.mcpServers) ? json.mcpServers : {};
        if (Object.prototype.hasOwnProperty.call(json.mcpServers, nome)) throw erro(409, `Já existe um servidor "${nome}" no .mcp.json deste projeto.`, 'existe');
        json.mcpServers[nome] = cfg;
        gravar = async () => {
          await gravarJson(arq, json, r.eol);
          const est = lerEstado();
          aprovar(est, arq, nome, hashServidor(cfg)); // quem adicionou pelo Orbit já viu o comando
          Object.assign(est.segredos, indice);
          await gravarEstado(est);
        };
      } else {
        const cj = await claudeJsonParaEscrever();
        const alvo = destinoPessoal(cj, onde, pasta, true);
        alvo.mcpServers = objeto(alvo.mcpServers) ? alvo.mcpServers : {};
        if (Object.prototype.hasOwnProperty.call(alvo.mcpServers, nome)) throw erro(409, `Já existe um servidor pessoal "${nome}"${onde === 'local' ? ' neste projeto' : ''}.`, 'existe');
        alvo.mcpServers[nome] = cfg;
        gravar = async () => {
          await gravarJson(CLAUDE_JSON, cj.json, cj.eol);
          const est = lerEstado();
          Object.assign(est.segredos, indice);
          await gravarEstado(est);
        };
      }
      let mapa = null;
      if (chaves.length) {
        mapa = await lerCofre();
        await gravarCofre({ ...mapa, ...novas });
      }
      try {
        await gravar();
      } catch (e) {
        if (mapa) await gravarCofre(mapa).catch(() => {});
        throw e;
      }
      log('mcp:', `adicionado ${onde} ${nome} (${c.tipo})${chaves.length ? `, ${chaves.length} chave(s) no cofre` : ''} em ${onde === 'projeto' ? path.join(pasta, '.mcp.json') : CLAUDE_JSON}`);
      mudou(onde === 'projeto' || onde === 'local' ? pasta : null);
      return { ok: true, ...(await listar(pasta)) };
    });
  }

  async function esquecerChaves(cfg) {
    const vars = variaveisDe(cfg).filter((v) => v.startsWith(PREFIXO));
    if (!vars.length) return;
    const est = lerEstado();
    let mexeu = false;
    for (const v of vars) if (est.segredos[v]) { delete est.segredos[v]; mexeu = true; }
    if (mexeu) await gravarEstado(est);
    if (!cofre) return;
    try {
      const mapa = await lerCofre();
      if (vars.some((v) => v in mapa)) {
        for (const v of vars) delete mapa[v];
        await gravarCofre(mapa);
      }
    } catch (e) {
      log('mcp: não consegui tirar as chaves do cofre:', e?.message || e);
    }
  }

  async function remover(c) {
    const pasta = pastaValida(c.pasta);
    const onde = c.onde;
    const nome = typeof c.nome === 'string' ? c.nome : '';
    if (!ONDES.includes(onde)) throw erro(400, 'Esse servidor não se remove pelo Orbit (plugin ou claude.ai).');
    exigirPessoal(onde, c, 'Remover um servidor pessoal');
    return emFila(async () => {
      let cfg;
      if (onde === 'projeto') {
        const arq = arquivoDaCadeia(pasta, c.arquivo);
        if (chave(path.dirname(arq)) !== chave(pasta)) throw erro(409, `Esse servidor vem de ${path.dirname(arq)}, uma pasta de cima; abra aquele projeto para remover.`);
        const r = await lerJson(arq);
        if (r.invalido) throw erro(409, `O ${arq} tem JSON inválido; corrija à mão antes.`);
        cfg = objeto(r.json.mcpServers) ? r.json.mcpServers[nome] : undefined;
        if (!objeto(cfg)) throw erro(404, 'Esse servidor não está mais no .mcp.json.');
        delete r.json.mcpServers[nome];
        await gravarJson(arq, r.json, r.eol);
        const est = lerEstado();
        const k = chave(arq);
        if (est.aprovados[k]) { delete est.aprovados[k][nome]; if (!Object.keys(est.aprovados[k]).length) delete est.aprovados[k]; }
        await gravarEstado(est);
        // Sem outro servidor com o mesmo nome, o nome sai da lista de desativados do projeto (um servidor novo
        // com esse nome não nasceria desligado sem aviso).
        const resta = (await lerProjeto(pasta)).some((f) => !f.invalido && servidoresDe(f.json).some(([n]) => n === nome));
        if (!resta) await tirarDesativado(pasta, nome);
      } else {
        const cj = await claudeJsonParaEscrever();
        const alvo = destinoPessoal(cj, onde, pasta, false);
        cfg = objeto(alvo?.mcpServers) ? alvo.mcpServers[nome] : undefined;
        if (!objeto(cfg)) throw erro(404, 'Esse servidor pessoal não existe mais.');
        delete alvo.mcpServers[nome];
        await gravarJson(CLAUDE_JSON, cj.json, cj.eol);
      }
      await esquecerChaves(cfg);
      log('mcp:', `removido ${onde} ${nome}`);
      mudou(onde === 'pessoal' ? null : pasta);
      return { ok: true, ...(await listar(pasta)) };
    });
  }

  async function tirarDesativado(pasta, nome) {
    for (const n of ['settings.json', 'settings.local.json']) {
      const arq = path.join(pasta, '.claude', n);
      const r = await lerJson(arq).catch(() => ({ invalido: true }));
      if (r.invalido || !r.existe || !lista(r.json.disabledMcpjsonServers).includes(nome)) continue;
      const l = lista(r.json.disabledMcpjsonServers).filter((x) => x !== nome);
      if (l.length) r.json.disabledMcpjsonServers = l;
      else delete r.json.disabledMcpjsonServers;
      await gravarJson(arq, r.json, r.eol);
    }
  }

  async function ativo(c) {
    const pasta = pastaValida(c.pasta);
    const onde = c.onde;
    const nome = typeof c.nome === 'string' ? c.nome : '';
    if (!/^[^\u0000-\u001f]{1,200}$/.test(nome) || nome === '__proto__') throw erro(400, 'Servidor inválido.');
    if (typeof c.ativo !== 'boolean') throw erro(400, 'ativo deve ser true ou false.');
    if (!ONDES.includes(onde)) throw erro(400, 'Esse servidor não muda pelo Orbit (plugin ou claude.ai: use /mcp ou /plugin).');
    exigirPessoal(onde, c, c.ativo ? 'Ativar um servidor pessoal' : 'Desativar um servidor pessoal');
    return emFila(async () => {
      if (onde === 'projeto') {
        if (c.ativo) await tirarDesativado(pasta, nome);
        else {
          const arq = path.join(pasta, '.claude', 'settings.json');
          const r = await lerJson(arq);
          if (r.invalido) throw erro(409, `O ${arq} tem JSON inválido; corrija à mão antes.`);
          r.json.disabledMcpjsonServers = [...new Set([...lista(r.json.disabledMcpjsonServers), nome])];
          await gravarJson(arq, r.json, r.eol);
        }
      } else {
        const cj = await claudeJsonParaEscrever();
        const alvo = destinoPessoal(cj, 'local', pasta, !c.ativo);
        if (alvo) {
          const l = lista(alvo.disabledMcpServers).filter((x) => x !== nome);
          alvo.disabledMcpServers = c.ativo ? l : [...l, nome];
          await gravarJson(CLAUDE_JSON, cj.json, cj.eol);
        }
      }
      log('mcp:', `${c.ativo ? 'ativado' : 'desativado'} ${onde} ${nome} em ${pasta}`);
      mudou(pasta);
      return { ok: true, ...(await listar(pasta)) };
    });
  }

  async function aprovarRota(c) {
    const pasta = pastaValida(c.pasta);
    const nome = typeof c.nome === 'string' ? c.nome : '';
    return emFila(async () => {
      const arq = arquivoDaCadeia(pasta, c.arquivo);
      const r = await lerJson(arq);
      if (r.invalido) throw erro(409, `O ${arq} tem JSON inválido.`);
      const cfg = objeto(r.json.mcpServers) ? r.json.mcpServers[nome] : undefined;
      if (!objeto(cfg)) throw erro(404, 'Esse servidor não está mais no .mcp.json.');
      const hash = hashServidor(cfg);
      if (hash !== c.hash) throw erro(409, 'O servidor mudou no .mcp.json desde que a lista abriu. Confira o comando de novo antes de aprovar.', 'mudou');
      const est = lerEstado();
      aprovar(est, arq, nome, hash);
      await gravarEstado(est);
      log('mcp:', `aprovado ${nome} de ${arq}`);
      mudou(pasta);
      return { ok: true, ...(await listar(pasta)) };
    });
  }

  // Leva para o cofre os valores sensíveis escritos direto no env/headers de um servidor do .mcp.json.
  async function proteger(c) {
    const pasta = pastaValida(c.pasta);
    const nome = typeof c.nome === 'string' ? c.nome : '';
    if (!cofre) throw erro(501, 'O cofre das chaves não está disponível neste servidor.');
    return emFila(async () => {
      const arq = arquivoDaCadeia(pasta, c.arquivo);
      if (chave(path.dirname(arq)) !== chave(pasta)) throw erro(409, `Esse servidor vem de ${path.dirname(arq)}; abra aquele projeto para proteger.`);
      const r = await lerJson(arq);
      if (r.invalido) throw erro(409, `O ${arq} tem JSON inválido.`);
      const cfg = objeto(r.json.mcpServers) ? r.json.mcpServers[nome] : undefined;
      if (!objeto(cfg)) throw erro(404, 'Esse servidor não está mais no .mcp.json.');
      const alvo = textoPuro(cfg).filter((x) => x.onde === 'env' || x.onde === 'header');
      if (!alvo.length) throw erro(409, 'Não há chave em texto puro no env nem nos cabeçalhos desse servidor.');
      const est = lerEstado();
      const antes = aprovacaoDe(est, arq, nome, hashServidor(cfg));
      const mapa = await lerCofre();
      const novas = {};
      for (const x of alvo) {
        const campo = x.onde === 'env' ? 'env' : 'headers';
        const v = nomeVariavel(nome, x.chave);
        novas[v] = cfg[campo][x.chave];
        cfg[campo][x.chave] = '${' + v + '}';
        est.segredos[v] = { pasta, servidor: nome, chave: x.chave, onde: 'projeto', quando: new Date().toISOString() };
      }
      await gravarCofre({ ...mapa, ...novas });
      try {
        await gravarJson(arq, r.json, r.eol);
      } catch (e) {
        await gravarCofre(mapa).catch(() => {});
        throw e;
      }
      if (antes === 'aprovado') aprovar(est, arq, nome, hashServidor(cfg)); // a mudança foi do próprio Orbit
      await gravarEstado(est);
      log('mcp:', `protegidas ${alvo.length} chave(s) de ${nome} em ${arq}`);
      mudou(pasta);
      return { ok: true, protegidas: alvo.length, ...(await listar(pasta)) };
    });
  }

  async function verificar(c) {
    const pasta = pastaValida(c.pasta);
    await rodarSonda(pasta);
    return listar(pasta);
  }

  async function rota(req, res, rotaUrl, url) {
    if (rotaUrl !== '/mcp' && !rotaUrl.startsWith('/mcp/')) return false;
    try {
      if (req.method === 'GET') {
        if (rotaUrl !== '/mcp') return false;
        const q = url?.searchParams || new URL(req.url, 'http://x').searchParams;
        const pedida = q.get('pasta');
        if (!pedida) {
          const primeira = pastas().values().next().value;
          if (!primeira) return responder(res, 200, { pasta: null, projetos: [], servidores: [], pendentes: 0, sonda: { ok: false }, cofre: !!cofre, avisos: [] }), true;
          responder(res, 200, await listar(primeira.pasta));
          return true;
        }
        responder(res, 200, await listar(pastaValida(pedida)));
        return true;
      }
      if (req.method !== 'POST') return false;
      const corpo = await lerJSONCorpo(req, 256 * 1024);
      if (!objeto(corpo)) throw erro(400, 'corpo inválido');
      const acoes = { '/mcp/verificar': verificar, '/mcp/adicionar': adicionar, '/mcp/remover': remover, '/mcp/ativo': ativo, '/mcp/aprovar': aprovarRota, '/mcp/proteger': proteger };
      const fn = acoes[rotaUrl];
      if (!fn) return false;
      responder(res, 200, await fn(corpo));
      return true;
    } catch (e) {
      if (!e.status) log('mcp:', rotaUrl, e?.stack || e?.message || e);
      responder(res, e.status || 500, { erro: e.status ? e.message : `Falhou: ${e.message}`, ...(e.codigo ? { codigo: e.codigo } : {}) });
      return true;
    }
  }

  return { rota, listar, protecao, invalidar };
}
