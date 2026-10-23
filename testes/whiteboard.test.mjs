// Teste do servidor do Whiteboard (whiteboard.mjs): usa o módulo direto, numa pasta temporária apagada no fim.
// node testes/whiteboard.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { criarWhiteboard } = await import(pathToFileURL(path.join(PROJ, 'whiteboard.mjs')).href);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-whiteboard-'));
const PASTA = path.join(TMP, 'whiteboard');
const res = { ok: [], falhas: [] };
const conferir = (cond, nome, extra) => { (cond ? res.ok : res.falhas).push(nome + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra))); };

// lerJSONCorpo mínimo, com o mesmo contrato do servidor (JSON inválido → 400; passou do limite → 413).
async function lerJSONCorpo(req, limite) {
  let tam = 0; const partes = [];
  for await (const c of req) {
    tam += c.length;
    if (tam > limite) { const e = new Error('corpo grande demais'); e.status = 413; throw e; }
    partes.push(c);
  }
  const bruto = Buffer.concat(partes).toString('utf8');
  try { return bruto.trim() ? JSON.parse(bruto) : {}; } catch { const e = new Error('JSON inválido'); e.status = 400; throw e; }
}

const wb = criarWhiteboard({ pasta: PASTA, lerJSONCorpo });

async function chamar(metodo, caminho, corpo, brutoCorpo) {
  const url = new URL(caminho, 'http://127.0.0.1');
  const req = Readable.from(brutoCorpo !== undefined ? [Buffer.from(brutoCorpo)] : corpo !== undefined ? [Buffer.from(JSON.stringify(corpo))] : []);
  req.method = metodo;
  req.headers = {};
  const out = { status: 0, texto: '' };
  const r = { headersSent: false, writeHead(s) { out.status = s; this.headersSent = true; }, end(t) { out.texto = t; } };
  const tratou = await wb.rota(req, r, url.pathname, url);
  return { tratou, status: out.status, corpo: out.texto ? JSON.parse(out.texto) : null };
}
const get = (p) => chamar('GET', p);
const post = (p, b) => chamar('POST', p, b);

try {
  // fora do prefixo
  conferir((await get('/ideias')).tratou === false, 'rota alheia não é tratada');

  // lista vazia (pasta ainda nem existe)
  let r = await get('/whiteboard/lista');
  conferir(r.status === 200 && Array.isArray(r.corpo.quadros) && r.corpo.quadros.length === 0, 'lista vazia', r);

  // criar
  r = await post('/whiteboard/novo', {});
  const q1 = r.corpo;
  conferir(r.status === 200 && q1.nome === 'Quadro sem título' && /^[a-z0-9-]{1,64}$/.test(q1.id) && q1.versao === 1 && Array.isArray(q1.elementos) && q1.camera.zoom === 1, 'novo com nome padrão', r);
  r = await post('/whiteboard/novo', {});
  const q2 = r.corpo;
  conferir(q2.nome === 'Quadro sem título 2' && q2.id !== q1.id, 'nome padrão não repete', q2);
  r = await post('/whiteboard/novo', { nome: '  Meu   plano ' });
  const q3 = r.corpo;
  conferir(q3.nome === 'Meu plano', 'novo com nome aparado', q3);
  conferir((await post('/whiteboard/novo', { nome: 'x'.repeat(81) })).status === 400, 'novo com nome longo → 400');
  conferir(fs.existsSync(path.join(PASTA, q1.id + '.json')), 'arquivo do quadro existe');
  conferir(fs.readdirSync(PASTA).every((n) => n.endsWith('.json')), 'sem temporários sobrando', fs.readdirSync(PASTA));

  // ler
  r = await get('/whiteboard/quadro?id=' + q1.id);
  conferir(r.status === 200 && r.corpo.id === q1.id && r.corpo.elementos.length === 0, 'ler quadro', r);
  conferir((await get('/whiteboard/quadro?id=nao-existe')).status === 404, 'quadro inexistente → 404');

  // salvar
  const els = [{ t: 'ret', x: 1 }, { t: 'txt', s: 'olá' }, { qualquer: { coisa: [1, 2] } }];
  await new Promise((ok) => setTimeout(ok, 5));
  r = await post('/whiteboard/salvar', { id: q1.id, camera: { x: 10, y: -20, zoom: 1.5 }, elementos: els });
  conferir(r.status === 200 && r.corpo.ok === true && typeof r.corpo.atualizado === 'string', 'salvar', r);
  r = await get('/whiteboard/quadro?id=' + q1.id);
  conferir(JSON.stringify(r.corpo.elementos) === JSON.stringify(els) && r.corpo.camera.x === 10 && r.corpo.camera.zoom === 1.5, 'salvar guarda elementos e câmera sem mexer', r.corpo);
  conferir(r.corpo.atualizado > r.corpo.criado, 'atualizado avança');

  // listar: mais recente primeiro, total
  r = await get('/whiteboard/lista');
  conferir(r.corpo.quadros.length === 3 && r.corpo.quadros[0].id === q1.id && r.corpo.quadros[0].total === 3, 'lista: salvo mais recente primeiro, total', r.corpo);
  conferir(Object.keys(r.corpo.quadros[0]).sort().join() === 'atualizado,criado,id,nome,total', 'lista: campos do contrato');

  // renomear
  r = await post('/whiteboard/renomear', { id: q1.id, nome: '  Roadmap  ' });
  conferir(r.status === 200 && r.corpo.ok === true, 'renomear', r);
  conferir((await get('/whiteboard/quadro?id=' + q1.id)).corpo.nome === 'Roadmap', 'renomear aparou o nome');
  conferir((await post('/whiteboard/renomear', { id: q1.id, nome: '   ' })).status === 400, 'renomear vazio → 400');
  conferir((await post('/whiteboard/renomear', { id: q1.id, nome: 'y'.repeat(81) })).status === 400, 'renomear longo → 400');
  conferir((await post('/whiteboard/renomear', { id: q1.id, nome: 5 })).status === 400, 'renomear nome não texto → 400');
  conferir((await post('/whiteboard/renomear', { id: 'nao-existe', nome: 'a' })).status === 404, 'renomear inexistente → 404');

  // duplicar
  r = await post('/whiteboard/duplicar', { id: q1.id });
  const cp = r.corpo;
  conferir(r.status === 200 && cp.nome === 'Roadmap (cópia)' && cp.id !== q1.id && JSON.stringify(cp.elementos) === JSON.stringify(els) && cp.camera.zoom === 1.5, 'duplicar', r);
  r = await post('/whiteboard/duplicar', { id: q1.id });
  conferir(r.corpo.nome === 'Roadmap (cópia) 2', 'duplicar de novo não repete nome', r.corpo.nome);
  conferir((await post('/whiteboard/duplicar', { id: 'nao-existe' })).status === 404, 'duplicar inexistente → 404');

  // excluir
  r = await post('/whiteboard/excluir', { id: cp.id });
  conferir(r.status === 200 && r.corpo.ok === true && !fs.existsSync(path.join(PASTA, cp.id + '.json')), 'excluir', r);
  conferir((await get('/whiteboard/quadro?id=' + cp.id)).status === 404, 'quadro excluído some');
  conferir((await post('/whiteboard/excluir', { id: cp.id })).status === 404, 'excluir de novo → 404');

  // id inválido (inclusive tentativa de sair da pasta)
  for (const id of ['../x', '..\\x', 'A', 'a/b', '', 'a'.repeat(65), 'a.b', null, 7]) {
    conferir((await post('/whiteboard/excluir', { id })).status === 400, 'excluir id inválido → 400: ' + JSON.stringify(id));
  }
  conferir((await get('/whiteboard/quadro?id=../servidor')).status === 400, 'ler id com ../ → 400');
  conferir((await get('/whiteboard/quadro')).status === 400, 'ler sem id → 400');
  conferir((await post('/whiteboard/salvar', { camera: { x: 0, y: 0, zoom: 1 }, elementos: [] })).status === 400, 'salvar sem id → 400');

  // corpo inválido
  const cam = { x: 0, y: 0, zoom: 1 };
  conferir((await post('/whiteboard/salvar', { id: q1.id, camera: cam, elementos: {} })).status === 400, 'salvar elementos não-lista → 400');
  conferir((await post('/whiteboard/salvar', { id: q1.id, camera: cam })).status === 400, 'salvar sem elementos → 400');
  conferir((await post('/whiteboard/salvar', { id: q1.id, camera: { x: 'a', y: 0, zoom: 1 }, elementos: [] })).status === 400, 'salvar câmera com texto → 400');
  conferir((await post('/whiteboard/salvar', { id: q1.id, camera: { x: 0, y: 0 }, elementos: [] })).status === 400, 'salvar câmera sem zoom → 400');
  conferir((await post('/whiteboard/salvar', { id: q1.id, elementos: [] })).status === 400, 'salvar sem câmera → 400');
  conferir((await chamar('POST', '/whiteboard/salvar', undefined, '{quebrado')).status === 400, 'JSON quebrado → 400');
  conferir((await chamar('POST', '/whiteboard/salvar', undefined, '[1,2]')).status === 400, 'corpo array → 400');
  conferir((await chamar('POST', '/whiteboard/salvar', undefined, 'null')).status === 400, 'corpo null → 400');
  conferir((await get('/whiteboard/quadro?id=' + q1.id)).corpo.elementos.length === 3, 'corpo inválido não estragou o quadro');
  conferir((await chamar('POST', '/whiteboard/salvar', undefined, '{"id":"' + q1.id + '","pad":"' + 'x'.repeat(21 * 1024 * 1024) + '"}')).status === 413, 'corpo acima de 20 MB → 413');

  // rota desconhecida / método
  conferir((await post('/whiteboard/inexistente', {})).tratou === false, 'POST desconhecido não é tratado');
  conferir((await get('/whiteboard/novo')).tratou === false, 'GET em rota de POST não é tratado');
} catch (e) {
  res.falhas.push('exceção: ' + (e?.stack || e));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`${res.ok.length} ok, ${res.falhas.length} falhas`);
for (const f of res.falhas) console.log('FALHA: ' + f);
process.exit(res.falhas.length ? 1 : 0);
