// Whiteboard — quadros livres do Orbit (lateral → Whiteboard). Página: assets/whiteboard.js (outro módulo).
//
// Cada quadro é um arquivo <DADOS>/whiteboard/<id>.json, global (não ligado a projeto):
//   { id, nome, criado, atualizado, versao: 1, camera: {x, y, zoom}, elementos: [] }
// O servidor não interpreta os elementos: o formato é do front. Gravação atômica (tmp + rename).
//
// Rotas: GET /whiteboard/lista · GET /whiteboard/quadro?id= · POST /whiteboard/novo {nome?} ·
//        /whiteboard/salvar {id, camera, elementos} · /whiteboard/renomear {id, nome} ·
//        /whiteboard/duplicar {id} · /whiteboard/excluir {id}.

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const LIMITE_CORPO = 20 * 1024 * 1024;
const ID_OK = /^[a-z0-9-]{1,64}$/;
const NOME_PADRAO = 'Quadro sem título';
const MAX_NOME = 80;

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

const agora = () => new Date().toISOString();
const num = (n) => typeof n === 'number' && Number.isFinite(n);

export function criarWhiteboard(deps) {
  const { pasta, lerJSONCorpo, log = () => {} } = deps;

  let fila = Promise.resolve();
  function emFila(fn) {
    const p = fila.then(() => fn());
    fila = p.catch(() => {});
    return p;
  }

  const arquivoDe = (id) => path.join(pasta, id + '.json');

  function validarId(id) {
    if (typeof id !== 'string' || !ID_OK.test(id)) throw erro(400, 'id inválido');
    return id;
  }

  async function gravar(q) {
    await fsp.mkdir(pasta, { recursive: true });
    const alvo = arquivoDe(q.id);
    const tmp = `${alvo}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    const texto = JSON.stringify(q);
    try {
      await fsp.writeFile(tmp, texto, 'utf8');
      await fsp.rename(tmp, alvo);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      log('whiteboard: gravação atômica falhou, gravando direto:', e.code || e.message);
      await fsp.writeFile(alvo, texto, 'utf8');
    }
  }

  async function ler(id) {
    validarId(id);
    let bruto;
    try {
      bruto = await fsp.readFile(arquivoDe(id), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') throw erro(404, 'quadro não encontrado');
      throw e;
    }
    try {
      const q = JSON.parse(bruto);
      if (!q || typeof q !== 'object' || !Array.isArray(q.elementos)) throw new Error('formato');
      return q;
    } catch {
      throw erro(500, 'quadro ilegível');
    }
  }

  async function todos() {
    let nomes = [];
    try { nomes = await fsp.readdir(pasta); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const lista = [];
    for (const n of nomes) {
      if (!n.endsWith('.json')) continue;
      const id = n.slice(0, -5);
      if (!ID_OK.test(id)) continue;
      try { lista.push(await ler(id)); } catch { /* arquivo estranho: ignora */ }
    }
    return lista;
  }

  function novoId(usados) {
    let id;
    do id = crypto.randomBytes(6).toString('hex');
    while (usados.has(id));
    return id;
  }

  function nomeLivre(base, existentes) {
    const usados = new Set(existentes.map((q) => q.nome));
    if (!usados.has(base)) return base;
    for (let n = 2; ; n++) {
      const c = `${base} ${n}`;
      if (!usados.has(c)) return c;
    }
  }

  function limparNome(n) {
    if (typeof n !== 'string') throw erro(400, 'nome inválido');
    const t = n.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || t.length > MAX_NOME) throw erro(400, `O nome deve ter de 1 a ${MAX_NOME} caracteres.`);
    return t;
  }

  async function criar(nome, camera, elementos) {
    const existentes = await todos();
    const q = {
      id: novoId(new Set(existentes.map((x) => x.id))),
      nome,
      criado: agora(),
      atualizado: agora(),
      versao: 1,
      camera: camera || { x: 0, y: 0, zoom: 1 },
      elementos: elementos || [],
    };
    await gravar(q);
    return q;
  }

  async function rota(req, res, caminho, url) {
    if (!caminho.startsWith('/whiteboard/')) return false;
    try {
      if (req.method === 'GET') {
        if (caminho === '/whiteboard/lista') {
          const qs = await todos();
          qs.sort((a, b) => String(b.atualizado).localeCompare(String(a.atualizado)));
          responder(res, 200, { quadros: qs.map((q) => ({ id: q.id, nome: q.nome, criado: q.criado, atualizado: q.atualizado, total: q.elementos.length })) });
          return true;
        }
        if (caminho === '/whiteboard/quadro') {
          const id = url?.searchParams?.get('id');
          responder(res, 200, await ler(id));
          return true;
        }
        return false;
      }
      if (req.method !== 'POST') return false;
      if (!['novo', 'salvar', 'renomear', 'duplicar', 'excluir'].includes(caminho.slice('/whiteboard/'.length))) return false;
      const corpo = await lerJSONCorpo(req, LIMITE_CORPO);
      if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) throw erro(400, 'corpo inválido');

      const r = await emFila(async () => {
        if (caminho === '/whiteboard/novo') {
          let nome = NOME_PADRAO;
          if (corpo.nome !== undefined && corpo.nome !== null && corpo.nome !== '') nome = limparNome(corpo.nome);
          return criar(nomeLivre(nome, await todos()));
        }
        const id = validarId(corpo.id);
        if (caminho === '/whiteboard/salvar') {
          const c = corpo.camera;
          if (!Array.isArray(corpo.elementos)) throw erro(400, 'elementos deve ser uma lista');
          if (!c || typeof c !== 'object' || !num(c.x) || !num(c.y) || !num(c.zoom)) throw erro(400, 'camera inválida');
          const q = await ler(id);
          q.camera = { x: c.x, y: c.y, zoom: c.zoom };
          q.elementos = corpo.elementos;
          q.atualizado = agora();
          await gravar(q);
          return { ok: true, atualizado: q.atualizado };
        }
        if (caminho === '/whiteboard/renomear') {
          const nome = limparNome(corpo.nome);
          const q = await ler(id);
          q.nome = nome;
          q.atualizado = agora();
          await gravar(q);
          return { ok: true };
        }
        if (caminho === '/whiteboard/duplicar') {
          const q = await ler(id);
          const base = `${q.nome} (cópia)`.slice(0, MAX_NOME);
          return criar(nomeLivre(base, await todos()), q.camera, q.elementos);
        }
        // excluir
        await ler(id);
        await fsp.rm(arquivoDe(id), { force: true });
        return { ok: true };
      });
      responder(res, 200, r);
      return true;
    } catch (e) {
      const status = Number.isInteger(e?.status) ? e.status : 500;
      if (status >= 500) log('whiteboard:', e?.message || e);
      responder(res, status, { erro: status >= 500 && !e?.status ? 'erro interno' : e.message });
      return true;
    }
  }

  return { rota, pasta };
}
