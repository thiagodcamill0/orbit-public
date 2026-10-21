// Ideias — bloco de notas rápido do Orbit (lateral → Ideias, atalho i). Página: assets/ideias.js.
//
// As ideias moram numa nota Markdown própria (padrão: <pasta de dados>/notas/Ideias.md), cada uma um item
// de lista de tarefas no formato do Obsidian (dá para abrir a nota no Obsidian ou em qualquer editor):
//
//   - [ ] 2026-10-15 18:42 · texto da ideia ^i-k3j2h1
//   - [x] 2026-10-14 09:10 · outra ideia, já feita ^i-a8f0c2
//   - [ ] 2026-10-16 10:05 · ideia com **formatação** e mais linhas
//   	segunda linha
//   	- item de lista ^i-0c1d2e3f
//
// O texto é Markdown do Obsidian (a página converte: assets/ideias.js). A 1ª linha vai no item e as outras
// ficam recuadas (tab) embaixo dele; o "^i-…" vai no fim da última, onde o Obsidian o reconhece. Texto que
// começa por uma lista deixa a 1ª linha só com a data.
//
// Cada mudança relê o arquivo, troca só a linha da ideia e grava de volta: o resto da nota (texto,
// títulos, linhas escritas à mão) fica como está. Linha sem "^i-…" ganha um id estável pelo próprio
// conteúdo, e o id próprio entra na primeira vez que o Orbit mexe nela.
//
// Rotas: GET /ideias · POST /ideias/nova {texto} · /ideias/editar {id, texto} ·
//        /ideias/feita {id, feita} · /ideias/apagar {id}. Toda mudança difunde o SSE "ideias".

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_TEXTO = 20000;
const ITEM = /^(\s*)- \[([ xX])\](?: (.*))?$/;
const RECUO = /^[ \t]+/;
const BLOCO = /^(?:[-*+]|\d{1,9}[.)])(?: |$)/; // linha que o Markdown leria como item de lista
const DATA = /^(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?) · /;
const ID = /\s+\^(i-[a-z0-9]+)$/;

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

const doisDig = (n) => String(n).padStart(2, '0');
function carimbo(d = new Date()) {
  return `${d.getFullYear()}-${doisDig(d.getMonth() + 1)}-${doisDig(d.getDate())} ${doisDig(d.getHours())}:${doisDig(d.getMinutes())}`;
}

// Várias linhas valem: sai o espaço do fim de cada uma, as linhas vazias das pontas e o que passar de
// uma linha vazia seguida. Um "^i-…" no fim de uma linha seria lido como id: perde o "^".
function limparTexto(t) {
  if (typeof t !== 'string') return '';
  return t.replace(/\r\n?/g, '\n').split('\n')
    .map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+$/, '').replace(/\^(i-[a-z0-9]+)$/, '$1'))
    .join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '').trimEnd().slice(0, MAX_TEXTO);
}

// Largura do recuo (tab = 4 colunas), para tirar o recuo comum das linhas de continuação.
function largura(recuo) {
  let n = 0;
  for (const c of recuo) n = c === '\t' ? n + 4 - (n % 4) : n + 1;
  return n;
}
function tirarRecuo(linha, n) {
  let col = 0, i = 0;
  while (i < linha.length && col < n && (linha[i] === ' ' || linha[i] === '\t')) {
    col = linha[i] === '\t' ? col + 4 - (col % 4) : col + 1;
    i++;
  }
  return linha.slice(i);
}

function cabecalhoNovo() {
  return [
    '---',
    'tipo: ideias',
    `atualizado: ${carimbo().slice(0, 10)}`,
    '---',
    '',
    '# Ideias',
    '',
    'Anotadas no Orbit (lateral → **Ideias**, atalho `i`). Não são para agora: ficam aqui até o',
    'gestor levar alguma para o [[Backlog]]. O Orbit mexe só nas linhas de ideia; dá para editar à',
    'mão mantendo o formato `- [ ] AAAA-MM-DD HH:MM · texto` (linhas a mais ficam recuadas embaixo).',
    '',
  ];
}

export function criarIdeias(deps) {
  const { arquivo, difundir = () => {}, lerJSONCorpo, log = () => {} } = deps;

  // Uma escrita de cada vez.
  let fila = Promise.resolve();
  function emFila(fn) {
    const p = fila.then(() => fn());
    fila = p.catch(() => {});
    return p;
  }

  async function ler() {
    let bruto = '';
    try {
      bruto = await fsp.readFile(arquivo, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const eol = bruto.includes('\r\n') ? '\r\n' : '\n';
    const linhas = bruto ? bruto.replace(/^﻿/, '').split(/\r?\n/) : [];
    const ideias = [];
    const vistos = new Map();
    for (let i = 0; i < linhas.length; i++) {
      const m = ITEM.exec(linhas[i]);
      if (!m || m[1]) continue; // só itens do primeiro nível
      // O item vai até a primeira linha sem recuo (as vazias no meio contam se vier linha recuada depois).
      let fim = i + 1;
      for (let j = i + 1; j < linhas.length; j++) {
        if (!linhas[j].trim()) continue;
        if (!RECUO.test(linhas[j])) break;
        fim = j + 1;
      }
      const cont = linhas.slice(i + 1, fim);
      const recuo = Math.min(...cont.filter((l) => l.trim()).map((l) => largura(RECUO.exec(l)[0])));
      const partes = [m[3] || '', ...cont.map((l) => (l.trim() ? tirarRecuo(l, recuo) : ''))];
      let id = '';
      for (let k = partes.length - 1; k >= 0 && !id; k--) {
        const mi = ID.exec(partes[k]);
        if (mi) { id = mi[1]; partes[k] = partes[k].slice(0, mi.index); }
      }
      let data = '';
      const md = DATA.exec(partes[0] + ' ');
      if (md) {
        data = md[1];
        partes[0] = partes[0].slice(md[0].length);
      }
      if (!id) {
        // Sem id próprio: um id estável pelo conteúdo (o mesmo texto repetido ganha sufixo).
        const base = 'h-' + crypto.createHash('sha1').update(linhas.slice(i, fim).map((l) => l.trim()).join('\n')).digest('hex').slice(0, 10);
        const n = (vistos.get(base) || 0) + 1;
        vistos.set(base, n);
        id = n > 1 ? `${base}-${n}` : base;
      }
      const texto = partes.map((l) => l.replace(/\s+$/, '')).join('\n').replace(/^\s+/, '').trimEnd();
      ideias.push({ id, texto, data, feita: m[2] !== ' ', linha: i, fim });
      i = fim - 1;
    }
    return { linhas, eol, ideias, existe: !!bruto };
  }

  // As linhas do item na nota: a 1ª no "- [ ]", as outras recuadas, o id no fim da última.
  function linhasDe(ideia) {
    const partes = String(ideia.texto).split('\n');
    if (BLOCO.test(partes[0])) partes.unshift(''); // começa por uma lista: a 1ª linha fica só com a data
    const out = partes.map((l, k) => (k ? (l ? '\t' + l : '') : `- [${ideia.feita ? 'x' : ' '}] ${ideia.data ? ideia.data + ' · ' : ''}${l}`.trimEnd()));
    out[out.length - 1] += ` ^${ideia.id}`;
    return out;
  }

  function idNovo(usados) {
    let id;
    do id = 'i-' + crypto.randomBytes(4).toString('hex');
    while (usados.has(id));
    return id;
  }

  function publico(ideias) {
    return ideias.map(({ id, texto, data, feita }) => ({ id, texto, data, feita }));
  }

  async function gravar(linhas, eol) {
    // Atualiza o "atualizado:" do frontmatter, se houver.
    if (linhas[0] === '---') {
      for (let i = 1; i < linhas.length && linhas[i] !== '---'; i++) {
        if (/^atualizado:/.test(linhas[i])) linhas[i] = `atualizado: ${carimbo().slice(0, 10)}`;
      }
    }
    let texto = linhas.join(eol);
    if (!texto.endsWith(eol)) texto += eol;
    await fsp.mkdir(path.dirname(arquivo), { recursive: true });
    const tmp = `${arquivo}.${process.pid}.tmp`;
    try {
      await fsp.writeFile(tmp, texto, 'utf8');
      await fsp.rename(tmp, arquivo);
    } catch (e) {
      // No Windows o rename falha se outro programa (o Obsidian) segura o arquivo: grava direto.
      await fsp.rm(tmp, { force: true }).catch(() => {});
      log('ideias: gravação atômica falhou, gravando direto:', e.code || e.message);
      await fsp.writeFile(arquivo, texto, 'utf8');
    }
  }

  async function mudar(fn) {
    return emFila(async () => {
      const doc = await ler();
      fn(doc);
      await gravar(doc.linhas, doc.eol);
      const lista = publico((await ler()).ideias);
      difundir('ideias', lista);
      return lista;
    });
  }

  function achar(ideias, id) {
    const it = typeof id === 'string' ? ideias.find((x) => x.id === id) : null;
    if (!it) throw erro(404, 'Essa ideia não está mais na nota (talvez tenha sido mudada fora do Orbit). A lista foi recarregada.');
    return it;
  }

  // Ideia sem id próprio ganha um ao ser mexida (o id por conteúdo mudaria junto com o texto).
  function fixarId(ideias, it) {
    if (it.id.startsWith('i-')) return;
    it.id = idNovo(new Set(ideias.map((x) => x.id)));
  }

  async function rota(req, res, caminho) {
    if (caminho !== '/ideias' && !caminho.startsWith('/ideias/')) return false;
    if (req.method === 'GET') {
      if (caminho !== '/ideias') return false;
      const { ideias } = await ler();
      responder(res, 200, { ideias: publico(ideias), nota: path.basename(arquivo) });
      return true;
    }
    if (req.method !== 'POST') return false;
    const corpo = await lerJSONCorpo(req);
    if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) throw erro(400, 'corpo inválido');
    let criada = null;
    let r;
    if (caminho === '/ideias/nova') {
      const texto = limparTexto(corpo.texto);
      if (!texto) throw erro(400, 'A ideia está vazia.');
      r = await mudar(({ linhas, ideias }) => {
        criada = { id: idNovo(new Set(ideias.map((x) => x.id))), texto, data: carimbo(), feita: false };
        // A mais nova vai para o topo da lista; sem lista ainda, para o fim da nota.
        if (!linhas.length) linhas.push(...cabecalhoNovo());
        if (ideias.length) linhas.splice(ideias[0].linha, 0, ...linhasDe(criada));
        else {
          while (linhas.length && linhas[linhas.length - 1] === '') linhas.pop();
          linhas.push('', ...linhasDe(criada));
        }
      });
    } else if (caminho === '/ideias/editar') {
      const texto = limparTexto(corpo.texto);
      if (!texto) throw erro(400, 'A ideia está vazia. Para tirar da lista, use apagar.');
      r = await mudar(({ linhas, ideias }) => {
        const it = achar(ideias, corpo.id);
        fixarId(ideias, it);
        it.texto = texto;
        linhas.splice(it.linha, it.fim - it.linha, ...linhasDe(it));
        criada = it;
      });
    } else if (caminho === '/ideias/feita') {
      r = await mudar(({ linhas, ideias }) => {
        const it = achar(ideias, corpo.id);
        fixarId(ideias, it);
        it.feita = !!corpo.feita;
        linhas.splice(it.linha, it.fim - it.linha, ...linhasDe(it));
        criada = it;
      });
    } else if (caminho === '/ideias/apagar') {
      r = await mudar(({ linhas, ideias }) => {
        const it = achar(ideias, corpo.id);
        linhas.splice(it.linha, it.fim - it.linha);
      });
    } else return false;
    responder(res, 200, { ok: true, id: criada?.id || null, ideias: r });
    return true;
  }

  return { rota, arquivo };
}
