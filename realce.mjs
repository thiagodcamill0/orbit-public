// Orbit — realce de código da prévia. Roda num Worker criado pelo temas.mjs: tokenizar um arquivo
// grande leva tempo e não pode travar o servidor. Usa o Shiki (@shikijs/primitive + motor Oniguruma, o mesmo do
// VS Code) com o tema de cores que o temas.mjs montou a partir da extensão ativa no VS Code.
// Mensagens: { tipo: 'tema', tema } troca o tema; { tipo: 'realcar', id, texto, lang } devolve { id, realce }.
// realce: { fg, cores: [fg, ...], linhas: [[[texto, cor] | [texto, cor, estilo], ...], ...] }
// cor é índice em cores (0 = cor padrão do texto); estilo: 1 itálico, 2 negrito, 4 sublinhado, 8 riscado.

import { parentPort } from 'node:worker_threads';
import { createShikiPrimitiveAsync, codeToTokensBase } from '@shikijs/primitive';
import { createOnigurumaEngine } from '@shikijs/engine-oniguruma';

// O Shiki não troca um tema já carregado com o mesmo nome: cada versão do tema ganha um nome novo.
let shiki = null;
let tema = null;
let nomeTema = '';
let seqTema = 0;
const carregadas = new Set();
let fila = Promise.resolve();

async function iniciar() {
  if (!shiki) shiki = await createShikiPrimitiveAsync({ themes: [], langs: [], engine: createOnigurumaEngine(import('@shikijs/engine-oniguruma/wasm-inlined')) });
  return shiki;
}

async function realcar(texto, lang) {
  if (!tema) return null;
  const p = await iniciar();
  if (!carregadas.has(lang)) {
    // lang já vem da lista de gramáticas instaladas (temas.mjs confere antes); o módulo traz as embutidas junto.
    const mod = await import(`@shikijs/langs/${lang}`);
    await p.loadLanguage(mod.default);
    carregadas.add(lang);
  }
  // Mesmos limites do VS Code: linha acima de 20 mil caracteres não é tokenizada.
  const linhas = codeToTokensBase(p, texto.replace(/\r\n?/g, '\n'), { lang, theme: nomeTema, tokenizeMaxLineLength: 20000, tokenizeTimeLimit: 500 });
  const fg = p.getTheme(nomeTema).fg.toLowerCase();
  const cores = [fg];
  const idx = new Map([[fg, 0]]);
  const corDe = (c) => {
    const k = (c || fg).toLowerCase();
    let i = idx.get(k);
    if (i === undefined) { i = cores.length; cores.push(k); idx.set(k, i); }
    return i;
  };
  const estiloDe = (f) => (f > 0 ? f & 15 : 0);
  const saida = linhas.map((tokens) => {
    const l = [];
    for (const t of tokens) {
      const c = corDe(t.color);
      const e = estiloDe(t.fontStyle);
      const ult = l[l.length - 1];
      // Junta pedaços vizinhos com a mesma aparência (o JSON fica bem menor).
      if (ult && ult[1] === c && (ult[2] || 0) === e) ult[0] += t.content;
      else l.push(e ? [t.content, c, e] : [t.content, c]);
    }
    return l;
  });
  return { fg, cores, linhas: saida };
}

parentPort.on('message', (m) => {
  fila = fila.then(async () => {
    if (!m || typeof m !== 'object') return;
    if (m.tipo === 'tema') {
      try {
        const p = await iniciar();
        const nome = 'orbit-vscode-' + ++seqTema;
        await p.loadTheme({ ...m.tema, name: nome });
        tema = m.tema; nomeTema = nome;
        parentPort.postMessage({ tipo: 'tema', ok: true });
      } catch (e) {
        tema = null;
        parentPort.postMessage({ tipo: 'tema', ok: false, erro: String(e?.message || e) });
      }
      return;
    }
    if (m.tipo === 'realcar') {
      try {
        parentPort.postMessage({ tipo: 'realce', id: m.id, realce: await realcar(String(m.texto || ''), m.lang) });
      } catch (e) {
        parentPort.postMessage({ tipo: 'realce', id: m.id, realce: null, erro: String(e?.message || e) });
      }
    }
  });
});
