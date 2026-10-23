// Teste dos dados do Grafo (grafo.mjs + assets/grafo-dados.js): cofre falso em pasta temporária apagada no fim.
// node testes/grafo.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { criarGrafo } = await import(pathToFileURL(path.join(PROJ, 'grafo.mjs')).href);
await import(pathToFileURL(path.join(PROJ, 'assets', 'grafo-dados.js')).href);
const GrafoDados = globalThis.GrafoDados;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-grafo-'));
const COFRE = path.join(TMP, 'cofre');
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };

function w(rel, txt) {
  const p = path.join(COFRE, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, txt);
}

async function chamar(g, pasta, metodo = 'GET') {
  const url = new URL('/grafo/dados' + (pasta === undefined ? '' : '?pasta=' + encodeURIComponent(pasta)), 'http://127.0.0.1');
  const out = { status: 0, texto: '' };
  const r = { headersSent: false, writeHead(s) { out.status = s; this.headersSent = true; }, end(t) { out.texto = t; } };
  const tratou = await g.rota({ method: metodo, headers: {} }, r, url.pathname, url);
  return { tratou, status: out.status, corpo: out.texto ? JSON.parse(out.texto) : null };
}

const tem = (d, o, x) => d.links.some((l) => l.origem === o && l.destino === x);
const no = (d, id) => d.nos.find((n) => n.id === id);

try {
  w('Inicio.md', [
    '---', 'tags: [projeto, "area/x"]', '---',
    'Texto #ativo e #2024 (não é tag) e # titulo.',
    '[[Alfa]] [[Alfa|apelido]] [[Alfa#Seção]] [[Alfa^bloco]]',
    '![[img.png]] ![[Beta]]',
    '[md](Sub/Gama.md) [esp](Sub/Com%20Espaco.md) [web](https://x.com/a.md) [anc](#topo)',
    '[[Fantasma]] [[Inicio]] [[sub/Gama]] [[PDF Doc.pdf]]',
    '```', '[[DentroBloco]]', '```',
    'e `[[DentroInline]]` fim',
  ].join('\n'));
  w('Alfa.md', '---\ntags:\n  - lista1\n  - lista2\n---\nvolta [[Inicio]] e [[Dup]]\n');
  w('Beta.md', 'vazio #solta');
  w('Sub/Gama.md', 'liga [[Alfa]] e [[Dup]]');
  w('Sub/Com Espaco.md', 'x');
  w('Dup.md', 'raiz');
  w('Sub/Fundo/Dup.md', 'fundo');
  w('img.png', 'x'); w('nao-citado.png', 'x'); w('PDF Doc.pdf', 'x');
  w('.obsidian/config.md', '[[Inicio]]');
  w('.git/x.md', '[[Inicio]]');
  w('node_modules/m.md', '[[Inicio]]');
  w('.trash/t.md', '[[Inicio]]');
  w('.oculta/o.md', '[[Inicio]]');

  const g = criarGrafo({ cofre: COFRE });
  conferir((await chamar(g, undefined, 'POST')).tratou === false, 'POST não é tratado');
  const rr = await chamar(g, undefined);
  conferir(rr.tratou && rr.status === 200, 'sem pasta = cofre (200)', rr.status);
  const d = rr.corpo;
  conferir(d.pasta === path.resolve(COFRE), 'campo pasta');
  const ids = d.nos.map((n) => n.id);
  conferir(!ids.some((i) => /obsidian|\.git|node_modules|\.trash|\.oculta/.test(i)), 'pastas ignoradas', ids);
  conferir(no(d, 'Inicio.md')?.tipo === 'nota' && no(d, 'Inicio.md').nome === 'Inicio', 'nó nota');
  conferir(no(d, 'img.png')?.tipo === 'anexo', 'anexo citado');
  conferir(no(d, 'PDF Doc.pdf')?.tipo === 'anexo', 'anexo citado com espaço');
  conferir(!no(d, 'nao-citado.png'), 'anexo não citado fora');
  conferir(no(d, 'Fantasma')?.tipo === 'inexistente' && no(d, 'Fantasma').nome === 'Fantasma', 'inexistente');
  conferir(!no(d, 'DentroBloco') && !no(d, 'DentroInline'), 'links em código ignorados');
  conferir(tem(d, 'Inicio.md', 'Alfa.md'), 'wikilink simples');
  conferir(d.links.filter((l) => l.origem === 'Inicio.md' && l.destino === 'Alfa.md').length === 1, 'duplicados contam uma vez (alias, #, ^)');
  conferir(!no(d, 'Alfa#Seção') && !no(d, 'Alfa|apelido'), 'sem nós lixo de alias/seção');
  conferir(tem(d, 'Inicio.md', 'Beta.md'), 'embed de nota');
  conferir(tem(d, 'Inicio.md', 'img.png'), 'embed de imagem');
  conferir(tem(d, 'Inicio.md', 'Sub/Gama.md'), 'link markdown relativo');
  conferir(d.links.filter((l) => l.destino === 'Sub/Gama.md' && l.origem === 'Inicio.md').length === 1, '[[sub/Gama]] caso-insensível = mesmo par, uma vez');
  conferir(tem(d, 'Inicio.md', 'Sub/Com Espaco.md'), 'markdown com %20 decodificado');
  conferir(!d.links.some((l) => l.origem === 'Inicio.md' && l.destino === 'Inicio.md'), 'auto-link ignorado');
  conferir(!d.nos.some((n) => /x\.com|topo/.test(n.id)), 'URL e âncora ignoradas');
  conferir(tem(d, 'Alfa.md', 'Dup.md') && !tem(d, 'Alfa.md', 'Sub/Fundo/Dup.md'), 'ambiguidade → mais perto da raiz');
  conferir(tem(d, 'Sub/Gama.md', 'Dup.md'), 'ambiguidade a partir de subpasta');
  conferir(no(d, 'Inicio.md').tags.includes('projeto') && no(d, 'Inicio.md').tags.includes('area/x'), 'tags do frontmatter (colchetes)', no(d, 'Inicio.md').tags);
  conferir(no(d, 'Inicio.md').tags.includes('ativo') && !no(d, 'Inicio.md').tags.includes('2024') && !no(d, 'Inicio.md').tags.includes('titulo'), 'tags do texto', no(d, 'Inicio.md').tags);
  conferir(no(d, 'Alfa.md').tags.join() === 'lista1,lista2', 'tags do frontmatter (lista)', no(d, 'Alfa.md').tags);
  conferir(no(d, 'Beta.md').tags.join() === 'solta', 'tag no texto');

  // pasta explícita (subpasta): resolve só dentro dela
  const sub = await chamar(g, path.join(COFRE, 'Sub'));
  conferir(sub.status === 200 && sub.corpo.pasta === path.join(COFRE, 'Sub') && no(sub.corpo, 'Gama.md'), 'pasta explícita', sub.corpo?.nos);
  // pasta inexistente
  const nx = await chamar(g, path.join(TMP, 'nao-existe'));
  conferir(nx.status === 404 && typeof nx.corpo.erro === 'string', 'pasta inexistente → 404 {erro}', nx);
  // arquivo no lugar de pasta
  const arq = await chamar(g, path.join(COFRE, 'Beta.md'));
  conferir(arq.status === 404, 'arquivo no lugar de pasta → 404');

  // limite de 5000 arquivos
  fs.mkdirSync(path.join(TMP, 'muitos'), { recursive: true });
  for (let i = 0; i < 5100; i++) fs.writeFileSync(path.join(TMP, 'muitos', `n${i}.md`), '');
  const mu = await chamar(g, path.join(TMP, 'muitos'));
  conferir(mu.status === 200 && mu.corpo.nos.length === 5000, 'limite 5000 arquivos', mu.corpo?.nos?.length);

  // GrafoDados.local: cadeia a -> b -> c -> d, e -> b, b -> e? (b<->... ) e link entre vizinhos
  const D = {
    nos: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, nome: id, tipo: 'nota', tags: [] })),
    links: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['e', 'a'], ['b', 'e'], ['f', 'd']].map(([origem, destino]) => ({ origem, destino })),
  };
  const sid = (r) => r.nos.map((n) => n.id).sort().join('');
  const L = (o) => GrafoDados.local(D, 'a', o);
  conferir(sid(L()) === 'abe', 'local padrão (prof 1, entrada+saída)', sid(L()));
  conferir(sid(L({ profundidade: 2 })) === 'abce', 'local prof 2', sid(L({ profundidade: 2 })));
  conferir(sid(L({ profundidade: 3 })) === 'abcde', 'local prof 3', sid(L({ profundidade: 3 })));
  conferir(sid(L({ saida: false })) === 'ae', 'local só entrada', sid(L({ saida: false })));
  conferir(sid(L({ entrada: false })) === 'ab', 'local só saída', sid(L({ entrada: false })));
  conferir(sid(L({ entrada: false, saida: false })) === 'a', 'local sem direção = só central');
  conferir(L().links.length === 3, 'local mantém link entre vizinhos', L().links);
  conferir(L({ vizinhos: false }).links.length === 2 && sid(L({ vizinhos: false })) === 'abe', 'vizinhos=false remove links entre não-centrais', L({ vizinhos: false }).links);
  const ni = GrafoDados.local(D, 'zzz');
  conferir(ni.nos.length === 0 && ni.links.length === 0, 'id inexistente → vazio');
  conferir(D.nos.length === 6 && D.links.length === 6, 'não altera os dados de entrada');
} catch (e) {
  res.falhas.push('exceção: ' + (e.stack || e));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

// cofre real (só leitura)
try {
  const COFRE_REAL = process.env.ORBIT_COFRE || ''; // opcional: uma pasta de notas de verdade
  if (COFRE_REAL && fs.existsSync(COFRE_REAL)) {
    const t0 = Date.now();
    const r = await chamar(criarGrafo({ cofre: COFRE_REAL }), undefined);
    const d = r.corpo;
    const por = (t) => d.nos.filter((n) => n.tipo === t).length;
    const idsN = new Set(d.nos.map((n) => n.id));
    console.log(`cofre real: ${d.nos.length} nós (nota ${por('nota')}, anexo ${por('anexo')}, inexistente ${por('inexistente')}), ${d.links.length} links, ${Date.now() - t0} ms`);
    conferir(r.status === 200 && por('nota') > 0 && d.links.length > 0, 'cofre real gera nós e links');
    conferir(d.links.every((l) => idsN.has(l.origem) && idsN.has(l.destino) && l.origem !== l.destino), 'cofre real: links coerentes');
    conferir(idsN.size === d.nos.length, 'cofre real: ids únicos');
  }
} catch (e) { res.falhas.push('cofre real: ' + (e.stack || e)); }

// A2: padroes / casa / filtrar
{
  const P = GrafoDados.padroes();
  conferir(P.busca === '' && P.orfaos === true && P.distancia === 250 && P.local.profundidade === 1 && Array.isArray(P.grupos), 'padroes: valores do plano');
  P.grupos.push(1); P.local.entrada = false;
  conferir(GrafoDados.padroes().grupos.length === 0 && GrafoDados.padroes().local.entrada === true, 'padroes: cópia nova a cada chamada');
  const N = { id: 'Pasta/Água Viva.md', nome: 'Água Viva', tipo: 'nota', tags: ['#ideia', 'x/y'] };
  const C = (q) => GrafoDados.casa(N, q);
  conferir(C('') && C('   '), 'casa: consulta vazia casa tudo');
  conferir(C('agua') && C('ÁGUA') && C('viva'), 'casa: sem diferenciar maiúsculas/acentos');
  conferir(C('agua viva') && !C('agua zebra'), 'casa: termos separados são E');
  conferir(C('"água viva"') && !C('"viva água"'), 'casa: frase entre aspas');
  conferir(C('pasta/') && C('.md'), 'casa: caminho também casa');
  conferir(!C('-agua') && C('-zebra') && C('viva -zebra') && !C('viva -agua'), 'casa: -termo nega');
  conferir(!C('-"água viva"'), 'casa: negação de frase');
  conferir(C('path:pasta') && !C('path:zebra') && !GrafoDados.casa({ id: 'x.md', nome: 'pasta' }, 'path:pasta'), 'casa: path: só no caminho');
  conferir(C('file:viva') && !C('file:pasta'), 'casa: file: só no nome');
  conferir(C('-path:zebra') && !C('-path:pasta'), 'casa: negação com prefixo');
  conferir(C('tag:#ideia') && C('tag:ideia') && C('tag:#x') && C('tag:#x/y') && !C('tag:#outra'), 'casa: tag:');
  conferir(C('zebra OR viva') && C('viva OR zebra') && !C('zebra OR gato'), 'casa: OR');
  conferir(C('zebra gato OR agua viva') && !C('zebra gato OR agua gato'), 'casa: OR separa grupos de E');
  conferir(C('"a OR b" OR viva') && !C('"a OR b"'), 'casa: OR entre aspas é texto');
  conferir(GrafoDados.casa({ id: '#ideia', nome: '#ideia', tipo: 'tag' }, 'tag:#ideia'), 'casa: nó de tag casa tag:');
  conferir(GrafoDados.casa({ id: 'a.md', nome: 'a' }, 'a') && !GrafoDados.casa({ id: 'a.md', nome: 'a' }, 'tag:#q'), 'casa: nó sem tags');

  const D = {
    nos: [
      { id: 'a.md', nome: 'a', tipo: 'nota', tags: ['t1'] },
      { id: 'b.md', nome: 'b', tipo: 'nota', tags: ['#t1', 't2'] },
      { id: 'c.md', nome: 'c', tipo: 'nota', tags: [] },
      { id: 'img.png', nome: 'img', tipo: 'anexo', tags: [] },
      { id: 'fantasma', nome: 'fantasma', tipo: 'inexistente', tags: [] },
      { id: 'orf.md', nome: 'orf', tipo: 'nota', tags: [] },
    ],
    links: [
      { origem: 'a.md', destino: 'b.md' }, { origem: 'b.md', destino: 'c.md' },
      { origem: 'a.md', destino: 'img.png' }, { origem: 'c.md', destino: 'fantasma' },
    ],
  };
  const copia = JSON.stringify(D);
  const F = (o) => GrafoDados.filtrar(D, o);
  const ids = (r) => r.nos.map((n) => n.id).sort().join(',');
  let r = F({});
  conferir(ids(r) === 'a.md,b.md,c.md,fantasma,orf.md' && r.links.length === 3, 'filtrar: padrão tira anexos, mantém o resto', ids(r));
  r = F({ anexos: true });
  conferir(r.nos.some((n) => n.id === 'img.png') && r.links.length === 4, 'filtrar: anexos=true mantém anexos e links');
  r = F({ soExistentes: true });
  conferir(!r.nos.some((n) => n.id === 'fantasma') && r.links.length === 2, 'filtrar: soExistentes tira inexistentes e seus links');
  r = F({ orfaos: false });
  conferir(ids(r) === 'a.md,b.md,c.md,fantasma', 'filtrar: orfaos=false tira nós sem link', ids(r));
  r = F({ orfaos: false, anexos: true, soExistentes: true });
  conferir(ids(r) === 'a.md,b.md,c.md,img.png', 'filtrar: órfãos avaliados depois dos outros filtros', ids(r));
  r = F({ busca: 'path:a.md OR path:b.md' });
  conferir(ids(r) === 'a.md,b.md' && r.links.length === 1 && r.links[0].destino === 'b.md', 'filtrar: busca mantém nós e links entre eles', ids(r));
  r = F({ busca: 'tag:#t2' });
  conferir(ids(r) === 'b.md' && r.links.length === 0, 'filtrar: busca por tag');
  r = F({ busca: 'zzz' });
  conferir(r.nos.length === 0 && r.links.length === 0, 'filtrar: busca sem resultado');
  r = F({ tags: true });
  const tg = r.nos.filter((n) => n.tipo === 'tag');
  conferir(tg.map((n) => n.id).sort().join() === '#t1,#t2' && tg.every((n) => n.nome === n.id), 'filtrar: tags cria nós #tag únicos', tg);
  conferir(r.links.filter((l) => l.destino === '#t1').map((l) => l.origem).sort().join() === 'a.md,b.md' && r.links.some((l) => l.origem === 'b.md' && l.destino === '#t2'), 'filtrar: tags liga notas às tags');
  r = F({ tags: true, orfaos: false });
  conferir(!r.nos.some((n) => n.id === 'orf.md') && r.nos.some((n) => n.id === '#t2'), 'filtrar: tags + órfãos');
  r = F({ tags: true, busca: 'path:a.md' });
  conferir(ids(r) === '#t1,a.md', 'filtrar: tags só das notas que sobraram', ids(r));
  r = F({ corPorPasta: false, tags: true, grupos: [{ consulta: 'tag:#t1', cor: '#ff0000' }, { consulta: 'a', cor: '#00ff00' }] });
  const cor = (id) => r.nos.find((n) => n.id === id).cor;
  conferir(cor('a.md') === '#ff0000' && cor('b.md') === '#ff0000' && cor('#t1') === '#ff0000' && cor('c.md') === undefined, 'filtrar: grupos, primeiro que casa');
  r = F({ corPorPasta: false, grupos: [{ consulta: 'file:c', cor: '#0000ff' }] });
  conferir(r.nos.find((n) => n.id === 'c.md').cor === '#0000ff' && r.nos.find((n) => n.id === 'a.md').cor === undefined, 'filtrar: grupo colore só quem casa');
  conferir(JSON.stringify(D) === copia, 'filtrar: não muta a entrada');
  conferir(GrafoDados.filtrar(null, null).nos.length === 0 && F(undefined).nos.length === 5, 'filtrar: entrada vazia/sem opções');

  {
  // grupos automáticos por pasta
  const NN = (id, tipo) => ({ id, nome: id.split('/').pop(), tipo: tipo || 'nota' });
  const P = { nos: [NN('raiz.md'), NN('Projeto/p.md'), NN('02 Decisões/d1.md'), NN('02 Decisões/d2.md'), NN('03 Tarefas/t.md'), NN('06 Referências/r.md'),
    NN('04 Padrões/p.md'), NN('Diário/x.md'), NN('_arquivo/a.md'), NN('_modelos/m.md'), NN('Zeta/z1.md'), NN('Zeta/z2.md'), NN('Beta/b.md'), NN('Alfa/a.md'), NN('Omega/o.md'), NN('img.png', 'anexo'), NN('fantasma', 'inexistente')], links: [] };
  const A = GrafoDados.filtrar(P, { anexos: true });
  const g = (id) => A.nos.find((n) => n.id === id);
  conferir(GrafoDados.padroes().corPorPasta === true, 'padroes: corPorPasta ligado');
  conferir(g('raiz.md').grupo === 'gestor' && g('Projeto/p.md').grupo === 'gestor' && g('raiz.md').grupoRotulo === 'Gestor e projeto' && g('raiz.md').cor === 'var(--grafo-g6)', 'grupos: raiz e Projeto = Gestor e projeto (violeta)');
  conferir(g('02 Decisões/d1.md').grupoRotulo === 'Decisões' && g('02 Decisões/d1.md').cor === 'var(--grafo-g1)' && g('03 Tarefas/t.md').cor === 'var(--grafo-g2)' && g('06 Referências/r.md').cor === 'var(--grafo-g3)' && g('04 Padrões/p.md').cor === 'var(--grafo-g4)' && g('Diário/x.md').cor === 'var(--grafo-g5)', 'grupos: nomes conhecidos têm cor fixa, rótulo sem prefixo');
  conferir(g('_arquivo/a.md').grupo === 'bastidores' && g('_modelos/m.md').grupo === 'bastidores' && g('_arquivo/a.md').cor === 'var(--grafo-g-bastidores)', 'grupos: pastas _ viram Bastidores cinza');
  conferir(['Zeta/z1.md', 'Beta/b.md', 'Alfa/a.md', 'Omega/o.md'].every((id) => g(id).grupo === 'outras' && g(id).cor === 'var(--grafo-g-outras)'), 'grupos: sem cor livre, desconhecidas vão para Outras');
  conferir(g('img.png').cor === undefined && g('fantasma').cor === undefined && g('img.png').grupo === undefined, 'grupos: anexo/inexistente mantêm cor de tipo');
  const Q = GrafoDados.filtrar({ nos: [NN('Zeta/z1.md'), NN('Zeta/z2.md'), NN('Beta/b.md'), NN('Alfa/a.md')], links: [] }, {});
  const qc = (id) => Q.nos.find((n) => n.id === id).cor;
  conferir(qc('Zeta/z1.md') === 'var(--grafo-g1)' && qc('Alfa/a.md') === 'var(--grafo-g2)' && qc('Beta/b.md') === 'var(--grafo-g3)', 'grupos: desconhecidas por tamanho, depois nome, sem repetir', [qc('Zeta/z1.md'), qc('Alfa/a.md'), qc('Beta/b.md')]);
  conferir(GrafoDados.filtrar(P, { corPorPasta: false }).nos.every((n) => n.cor === undefined), 'grupos: corPorPasta=false volta ao neutro');
  const U = GrafoDados.filtrar(P, { grupos: [{ consulta: 'file:d1', cor: '#123456' }] });
  conferir(U.nos.find((n) => n.id === '02 Decisões/d1.md').cor === '#123456' && U.nos.find((n) => n.id === '02 Decisões/d2.md').cor === 'var(--grafo-g1)', 'grupos: grupo do usuário tem prioridade');

  }
}

console.log(`${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('FALHA: ' + f);
process.exit(res.falhas.length ? 1 : 0);
