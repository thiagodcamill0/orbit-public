// Dados do Grafo: varre uma pasta de notas .md e devolve nós e links (estilo Obsidian).
// GET /grafo/dados?pasta=<caminho absoluto>  (sem pasta = cofre)
import fsp from 'node:fs/promises';
import path from 'node:path';

const IGNORADAS = new Set(['.obsidian', '.git', 'node_modules', '.trash']);
const LIMITE_ARQUIVOS = 5000;

function responder(res, codigo, corpo) {
  if (res.headersSent) return;
  res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

const semMd = (s) => s.replace(/\.md$/i, '');
const chave = (s) => s.toLowerCase();

// Remove blocos ``` / ~~~ e `código inline` (para não contar links neles).
export function removerCodigo(texto) {
  const saida = [];
  let cerca = null;
  for (const linha of texto.split('\n')) {
    const m = /^[ \t]*(```+|~~~+)/.exec(linha);
    if (cerca) { if (m && m[1][0] === cerca[0] && m[1].length >= cerca.length) cerca = null; saida.push(''); continue; }
    if (m) { cerca = m[1]; saida.push(''); continue; }
    saida.push(linha);
  }
  let t = saida.join('\n');
  t = t.replace(/(`+)[^`][\s\S]*?\1(?!`)/g, ' ');
  return t;
}

function separarFrontmatter(texto) {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(texto);
  return m ? { fm: m[1], corpo: texto.slice(m[0].length) } : { fm: '', corpo: texto };
}

function tagsDoFrontmatter(fm) {
  const tags = [];
  const linhas = fm.split(/\r?\n/);
  for (let i = 0; i < linhas.length; i++) {
    const m = /^tags?\s*:\s*(.*)$/i.exec(linhas[i]);
    if (!m) continue;
    let v = m[1].trim();
    if (v) {
      v = v.replace(/^\[|\]$/g, '');
      for (const p of v.split(',')) { const t = p.trim().replace(/^["']|["']$/g, '').replace(/^#/, ''); if (t) tags.push(t); }
    } else {
      while (i + 1 < linhas.length && /^\s*-\s+/.test(linhas[i + 1])) {
        i++;
        const t = linhas[i].replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, '').replace(/^#/, '');
        if (t) tags.push(t);
      }
    }
  }
  return tags;
}

// Extrai { tags, links } de uma nota. Cada link: { alvo, md } (md = veio de link markdown relativo).
export function analisarNota(texto) {
  const { fm, corpo } = separarFrontmatter(texto);
  const limpo = removerCodigo(corpo);
  const tags = new Set(tagsDoFrontmatter(fm));
  for (const m of limpo.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_\/-]*[\p{L}_\/-][\p{L}\p{N}_\/-]*)/gu)) tags.add(m[1]);
  const links = [];
  const semFm = removerCodigo(fm) + '\n' + limpo;
  for (const m of semFm.matchAll(/!?\[\[([^\]\n]+?)\]\]/g)) {
    let alvo = m[1].split('|')[0];
    alvo = alvo.split('#')[0].split('^')[0].trim();
    if (alvo) links.push({ alvo, md: false });
  }
  // [x](caminho) relativo; ignora URLs e âncoras
  for (const m of semFm.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) {
    let alvo = m[1].replace(/^<|>$/g, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(alvo) || alvo.startsWith('#')) continue;
    alvo = alvo.split('#')[0].split('?')[0];
    try { alvo = decodeURIComponent(alvo); } catch { /* mantém */ }
    alvo = alvo.trim();
    if (alvo) links.push({ alvo, md: true });
  }
  return { tags: [...tags], links };
}

async function varrer(raiz) {
  const arquivos = []; // caminhos relativos com /
  let truncado = false;
  const pilha = [''];
  while (pilha.length && !truncado) {
    const rel = pilha.pop();
    let itens;
    try { itens = await fsp.readdir(path.join(raiz, rel), { withFileTypes: true }); } catch { continue; }
    itens.sort((a, b) => a.name.localeCompare(b.name));
    for (const it of itens) {
      if (it.isDirectory()) {
        if (it.name.startsWith('.') || IGNORADAS.has(it.name)) continue;
        pilha.push(rel ? rel + '/' + it.name : it.name);
      } else if (it.isFile()) {
        if (arquivos.length >= LIMITE_ARQUIVOS) { truncado = true; break; }
        arquivos.push(rel ? rel + '/' + it.name : it.name);
      }
    }
  }
  return { arquivos, truncado };
}

const profundidade = (p) => p.split('/').length;
const menor = (a, b) => profundidade(a) - profundidade(b) || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

export async function montarGrafo(raiz) {
  const { arquivos, truncado } = await varrer(raiz);
  const porCaminho = new Map(); // chave(caminho) -> caminho
  const notasPorNome = new Map(); // chave(nome sem .md) -> [caminhos]
  const arqPorNome = new Map(); // chave(nome com extensão) -> [caminhos]
  const add = (m, k, v) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
  for (const a of arquivos) {
    porCaminho.set(chave(a), a);
    const base = a.slice(a.lastIndexOf('/') + 1);
    add(arqPorNome, chave(base), a);
    if (/\.md$/i.test(base)) add(notasPorNome, chave(semMd(base)), a);
  }
  for (const m of [notasPorNome, arqPorNome]) for (const l of m.values()) l.sort(menor);

  const resolver = (alvo, origem, md) => {
    const norm = alvo.replace(/\\/g, '/').replace(/^\/+/, '');
    const tentar = (rel) => {
      const k = chave(rel);
      return porCaminho.get(k) ?? porCaminho.get(k + '.md');
    };
    if (norm.includes('/') || md) {
      if (md || norm.startsWith('./') || norm.startsWith('../')) {
        const dir = origem.includes('/') ? origem.slice(0, origem.lastIndexOf('/')) : '';
        const rel = path.posix.normalize(dir ? dir + '/' + norm : norm);
        if (!rel.startsWith('..')) { const r = tentar(rel); if (r) return r; }
      }
      const r = tentar(path.posix.normalize(norm));
      if (r) return r;
      if (!norm.includes('/')) { /* cai no nome */ } else {
        // caminho parcial (ex.: "pasta/nota" dentro de subpasta): sufixo, o mais curto
        const suf = '/' + chave(norm);
        const achados = [...porCaminho.values()].filter((p) => chave(p).endsWith(suf) || chave(p).endsWith(suf + '.md')).sort(menor);
        if (achados.length) return achados[0];
      }
    }
    const base = norm.slice(norm.lastIndexOf('/') + 1);
    const n = notasPorNome.get(chave(semMd(base)));
    if (n) return n[0];
    const a = arqPorNome.get(chave(base));
    return a ? a[0] : null;
  };

  const nos = new Map(); // id -> nó
  const links = [];
  const vistos = new Set();
  const notas = arquivos.filter((a) => /\.md$/i.test(a));
  for (const n of notas) nos.set(n, { id: n, nome: semMd(n.slice(n.lastIndexOf('/') + 1)), tipo: 'nota', tags: [] });

  // leitura assíncrona em lotes
  const LOTE = 64;
  for (let i = 0; i < notas.length; i += LOTE) {
    const lote = notas.slice(i, i + LOTE);
    const textos = await Promise.all(lote.map((n) => fsp.readFile(path.join(raiz, n), 'utf8').catch(() => '')));
    lote.forEach((origem, j) => {
      const { tags, links: ls } = analisarNota(textos[j]);
      nos.get(origem).tags = tags;
      for (const { alvo, md } of ls) {
        let destino = resolver(alvo, origem, md);
        if (destino) {
          if (!nos.has(destino)) nos.set(destino, { id: destino, nome: destino.slice(destino.lastIndexOf('/') + 1), tipo: 'anexo', tags: [] });
        } else {
          destino = semMd(alvo.replace(/\\/g, '/'));
          if (!nos.has(destino)) nos.set(destino, { id: destino, nome: destino, tipo: 'inexistente', tags: [] });
        }
        if (destino === origem) continue;
        const k = origem + '\u0000' + destino;
        if (vistos.has(k)) continue;
        vistos.add(k);
        links.push({ origem, destino });
      }
    });
  }
  return { pasta: raiz, nos: [...nos.values()], links, truncado };
}

export function criarGrafo(deps = {}) {
  const cofre = deps.cofre;

  async function rota(req, res, a, b) {
    const url = b ?? (typeof a === 'object' ? a : null);
    const caminho = typeof a === 'string' ? a : url?.pathname;
    // Widget "Grafo do projeto" (21/10): o projeto do próprio Orbit já vem com o cofre como brain.
    if (caminho === '/grafo/padrao' && req.method === 'GET') { responder(res, 200, { projeto: deps.projetoPadrao || '', pasta: cofre ? path.resolve(cofre) : '' }); return true; }
    if (caminho === '/grafo/nota' && req.method === 'GET') { // prévia do texto de uma nota: ?pasta=&id= (id relativo à pasta)
      try {
        const pasta = path.resolve(url?.searchParams?.get('pasta') || cofre || '');
        const alvo = path.resolve(pasta, String(url?.searchParams?.get('id') || ''));
        const rel = path.relative(pasta, alvo);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { responder(res, 403, { erro: 'fora da pasta' }); return true; }
        const st = await fsp.stat(alvo);
        if (!st.isFile() || st.size > 400000) { responder(res, 400, { erro: 'arquivo não pode ser lido' }); return true; }
        responder(res, 200, { id: rel.split(path.sep).join('/'), texto: await fsp.readFile(alvo, 'utf8') });
      } catch (e) {
        responder(res, e.code === 'ENOENT' ? 404 : 500, { erro: e.message || 'erro' });
      }
      return true;
    }
    if (caminho !== '/grafo/dados') return false;
    if (req.method !== 'GET') return false;
    try {
      const pedida = url?.searchParams?.get('pasta');
      const pasta = pedida ? path.resolve(pedida) : cofre && path.resolve(cofre);
      if (!pasta) { responder(res, 400, { erro: 'pasta não informada' }); return true; }
      let st;
      try { st = await fsp.stat(pasta); } catch { st = null; }
      if (!st || !st.isDirectory()) { responder(res, 404, { erro: 'pasta não encontrada' }); return true; }
      responder(res, 200, await montarGrafo(pasta));
    } catch (e) {
      responder(res, e.status || 500, { erro: e.message || 'erro' });
    }
    return true;
  }

  return { rota };
}
