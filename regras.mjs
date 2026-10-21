// Regras de permissão dos projetos (Configurações → Permissões dos agentes). Página: assets/regras.js.
//
// Lê e muda só os arquivos do PROJETO: <pasta>/.claude/settings.local.json (só nesta máquina, fora do
// git) e <pasta>/.claude/settings.json (compartilhado). Nunca o ~/.claude/settings.json (global): a pasta
// pessoal e as de cima dela são recusadas. As pastas válidas são as das sessões conhecidas e a do Orbit.
//
// Cada mudança relê o arquivo, mexe só em permissions.allow/ask/deny e grava de volta (o resto fica).
// Arquivo com JSON inválido não é regravado: a rota responde 409.
//
// Rotas: GET /regras · POST /regras/remover {pasta, arquivo, tipo, regra}. Toda mudança difunde o SSE "regras".
// Não há pacote de regras de leitura: o claude 2.1.300 já roda sozinho os comandos simples de leitura nos
// dois terminais, e uma regra ampla (git diff *) passaria por cima da checagem dele (deixou passar
// git diff --"output"=x, testado em 15/10). As regras nascem do "Permitir sempre" do cartão (controle.mjs).

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ARQUIVOS = { local: 'settings.local.json', projeto: 'settings.json' };
const TIPOS = ['allow', 'ask', 'deny'];

function responder(res, codigo, corpo) {
  if (res.headersSent) return;
  res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

function erro(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

const chave = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

export function criarRegras(deps) {
  const { sessoes = () => [], pastaOrbit, difundir = () => {}, lerJSONCorpo, log = () => {}, casa = os.homedir() } = deps;
  const casaK = chave(casa);

  // Uma escrita de cada vez.
  let fila = Promise.resolve();
  function emFila(fn) {
    const p = fila.then(() => fn());
    fila = p.catch(() => {});
    return p;
  }

  // A pasta pessoal e as de cima (C:\, C:\Users) teriam o .claude global ou valeriam para tudo.
  function proibida(k) {
    return k === casaK || casaK.startsWith(k.endsWith(path.sep) ? k : k + path.sep) || path.parse(k).root === k;
  }

  // Pastas de projeto conhecidas: a do Orbit e o cwd de cada sessão, sem repetir.
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
    for (const s of sessoes()) pos(s?.cwd, s?.projeto);
    return m;
  }

  function pastaValida(p) {
    if (typeof p !== 'string' || !p) throw erro(400, 'pasta ausente');
    const k = chave(p);
    if (proibida(k)) throw erro(403, 'Essa pasta é a pessoal (ou uma de cima dela): regra ali valeria para todos os projetos.');
    const it = pastas().get(k);
    if (!it) throw erro(404, 'Pasta desconhecida: só valem as pastas das sessões do Orbit.');
    return it.pasta;
  }

  async function lerArquivo(arq) {
    let bruto;
    try {
      bruto = await fsp.readFile(arq, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return { json: {}, existe: false };
      throw e;
    }
    const texto = bruto.replace(/^\uFEFF/, '');
    if (!texto.trim()) return { json: {}, existe: true };
    let json;
    try { json = JSON.parse(texto); } catch { return { invalido: true, existe: true }; }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { invalido: true, existe: true };
    return { json, existe: true, eol: bruto.includes('\r\n') ? '\r\n' : '\n' };
  }

  async function gravar(arq, json, eol = '\n') {
    await fsp.mkdir(path.dirname(arq), { recursive: true });
    const texto = JSON.stringify(json, null, 2).replace(/\n/g, eol) + eol;
    const tmp = `${arq}.${process.pid}.tmp`;
    try {
      await fsp.writeFile(tmp, texto, 'utf8');
      await fsp.rename(tmp, arq);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      log('regras: gravação atômica falhou, gravando direto:', e.code || e.message);
      await fsp.writeFile(arq, texto, 'utf8');
    }
  }

  const caminho = (pasta, arquivo) => path.join(pasta, '.claude', ARQUIVOS[arquivo]);

  async function listar() {
    const projetos = [];
    for (const { pasta, nome } of pastas().values()) {
      const arquivos = [];
      for (const arquivo of Object.keys(ARQUIVOS)) {
        const arq = caminho(pasta, arquivo);
        let r;
        try { r = await lerArquivo(arq); } catch (e) { arquivos.push({ arquivo, caminho: arq, erro: e.code || e.message, regras: [] }); continue; }
        if (!r.existe) continue;
        if (r.invalido) { arquivos.push({ arquivo, caminho: arq, erro: 'JSON inválido', regras: [] }); continue; }
        const perm = r.json.permissions && typeof r.json.permissions === 'object' ? r.json.permissions : {};
        const regras = [];
        for (const tipo of TIPOS) for (const regra of Array.isArray(perm[tipo]) ? perm[tipo] : []) if (typeof regra === 'string') regras.push({ tipo, regra });
        arquivos.push({ arquivo, caminho: arq, regras });
      }
      projetos.push({ pasta, nome, arquivos });
    }
    return { projetos };
  }

  async function mudar(arq, fn) {
    return emFila(async () => {
      const r = await lerArquivo(arq);
      if (r.invalido) throw erro(409, `O arquivo ${arq} tem JSON inválido; corrija à mão antes.`);
      const json = r.json;
      if (!json.permissions || typeof json.permissions !== 'object' || Array.isArray(json.permissions)) json.permissions = {};
      const res = fn(json.permissions);
      await gravar(arq, json, r.eol);
      const lista = await listar();
      difundir('regras', lista);
      return { ...res, ...lista };
    });
  }

  async function rota(req, res, rotaUrl) {
    if (rotaUrl !== '/regras' && !rotaUrl.startsWith('/regras/')) return false;
    if (req.method === 'GET') {
      if (rotaUrl !== '/regras') return false;
      responder(res, 200, await listar());
      return true;
    }
    if (req.method !== 'POST') return false;
    const corpo = await lerJSONCorpo(req);
    if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) throw erro(400, 'corpo inválido');
    if (rotaUrl === '/regras/remover') {
      const pasta = pastaValida(corpo.pasta);
      if (!ARQUIVOS[corpo.arquivo]) throw erro(400, 'arquivo deve ser "local" ou "projeto"');
      if (!TIPOS.includes(corpo.tipo)) throw erro(400, 'tipo deve ser allow, ask ou deny');
      if (typeof corpo.regra !== 'string' || !corpo.regra) throw erro(400, 'regra ausente');
      const arq = caminho(pasta, corpo.arquivo);
      const r = await mudar(arq, (perm) => {
        const l = Array.isArray(perm[corpo.tipo]) ? perm[corpo.tipo] : [];
        const i = l.indexOf(corpo.regra);
        if (i < 0) throw erro(404, 'Essa regra não está mais no arquivo. A lista foi recarregada.');
        l.splice(i, 1);
        perm[corpo.tipo] = l;
        return { removida: corpo.regra };
      });
      log('regras:', `removida ${corpo.tipo} ${corpo.regra} de ${arq}`);
      responder(res, 200, { ok: true, ...r });
      return true;
    }
    return false;
  }

  return { rota, listar };
}
