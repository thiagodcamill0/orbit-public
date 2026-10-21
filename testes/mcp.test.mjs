// Conexões MCP (mcp.mjs) sem servidor: leitura dos .mcp.json (pasta e as de cima) e do ~/.claude.json, aprovação,
// chaves no cofre (falso, em memória), ativo/inativo, proteger e remover, e a proteção de cada lançamento.
// Rodar:  node --test testes/mcp.test.mjs
// Tudo numa pasta temporária: "casa" (com o .claude.json), dados do Orbit e o projeto. Nada do ~/.claude real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { criarMcp, dividirComando, textoPuro, hashServidor, variaveisDe, nomeVariavel } from '../mcp.mjs';
import { comSettings } from '../controle.mjs';

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mcp-'));
const CASA = path.join(BASE, 'casa');
const DADOS = path.join(BASE, 'dados');
const RAIZ = path.join(BASE, 'raiz'); // pasta de cima do projeto (tem um .mcp.json herdado)
const PROJ = path.join(RAIZ, 'proj');
for (const d of [CASA, DADOS, PROJ]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(DADOS, 'projetos.json'), JSON.stringify({ lista: [{ nome: 'proj', pasta: PROJ }] }));
const CJ = path.join(CASA, '.claude.json');
const cjInicial = { numStartups: 3, projects: { [PROJ.replace(/\\/g, '/')]: { allowedTools: [], mcpServers: { meu: { type: 'stdio', command: 'node', args: ['meu.js'] } } } }, mcpServers: { global1: { type: 'http', url: 'https://g.exemplo/mcp' } } };
fs.writeFileSync(CJ, JSON.stringify(cjInicial, null, 2));
fs.writeFileSync(path.join(RAIZ, '.mcp.json'), JSON.stringify({ mcpServers: { herdado: { command: 'node', args: ['h.js'] } } }));
fs.writeFileSync(path.join(PROJ, '.mcp.json'), JSON.stringify({ mcpServers: { clonado: { type: 'stdio', command: 'npx', args: ['-y', 'pacote-x'], env: { API_KEY: 'segredo-literal-123456' } } } }, null, 2));

let cofreTexto = '';
const cofre = { ler: async () => cofreTexto, guardar: async (t) => { cofreTexto = t; } };
const sondados = [];
const mcp = criarMcp({
  pastaOrbit: null,
  dados: DADOS,
  casa: CASA,
  lerJSONCorpo: async (req) => req.corpo,
  sondar: async (pasta, prot) => {
    sondados.push({ pasta, prot });
    return [
      { name: 'meu', status: 'connected', scope: 'local', config: {} },
      { name: 'global1', status: 'failed', error: 'HTTP 401', scope: 'user', config: { type: 'http', url: 'https://g.exemplo/mcp' } },
      { name: 'plugin:x:y', status: 'connected', scope: 'plugin', config: { type: 'stdio', command: 'node', args: ['p.js'] } },
    ];
  },
  cofre,
});

async function chamar(metodo, rota, corpo, q = {}) {
  const url = new URL('http://x' + rota + '?' + new URLSearchParams(q));
  let status = 0, texto = '';
  const res = { headersSent: false, writeHead(c) { status = c; }, end(t) { texto = t; } };
  const tratou = await mcp.rota({ method: metodo, url: url.pathname + url.search, corpo }, res, url.pathname, url);
  assert.ok(tratou, 'a rota não tratou ' + rota);
  return { status, json: JSON.parse(texto) };
}
const lerArq = (a) => JSON.parse(fs.readFileSync(a, 'utf8'));
const tudoNaPasta = (d) => fs.readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => fs.readFileSync(path.join(e.parentPath ?? e.path, e.name), 'utf8')).join('\n');

test('utilidades: comando, texto puro, hash, variáveis e --settings', () => {
  assert.deepEqual(dividirComando('npx -y @x/y --dir "C:\\Meus docs" \'a b\''), ['npx', '-y', '@x/y', '--dir', 'C:\\Meus docs', 'a b']);
  assert.deepEqual(dividirComando('  '), []);
  assert.throws(() => dividirComando('node "x'), /aspas/);
  assert.equal(hashServidor({ a: 1, b: [1, { c: 2, d: 3 }] }), hashServidor({ b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.notEqual(hashServidor({ command: 'a' }), hashServidor({ command: 'b' }));
  assert.deepEqual(variaveisDe({ command: '${A}', args: ['x${B:-y}'], env: { K: '${C}' }, headers: { H: 'Bearer ${D}' } }).sort(), ['A', 'B', 'C', 'D']);
  assert.deepEqual(textoPuro({ env: { API_KEY: 'abcdefgh12', MODO: 'producao-1', TOKEN: '${T}' } }), [{ onde: 'env', chave: 'API_KEY' }]);
  assert.deepEqual(textoPuro({ headers: { Authorization: 'Bearer abcdefghij' } }), [{ onde: 'header', chave: 'Authorization' }]);
  assert.deepEqual(textoPuro({ args: ['--token=abcdefgh12', '--api-key', 'zzzzzzzzzz', 'ghp_' + 'a'.repeat(30), '--dir', 'C:/x'] }), [{ onde: 'arg', indice: 0 }, { onde: 'arg', indice: 2 }, { onde: 'arg', indice: 3 }]);
  assert.deepEqual(textoPuro({ url: 'https://u:p@x.com/mcp?api_key=abcdefgh12&modo=1' }), [{ onde: 'url' }, { onde: 'url', chave: 'api_key' }]);
  assert.match(nomeVariavel('meu-banco', 'Authorization'), /^ORBIT_MCP_MEU_BANCO_AUTHORIZATION_[0-9A-F]{4}$/);
  assert.deepEqual(comSettings(['-p'], { disabledMcpjsonServers: ['a'] }), ['-p', '--settings', '{"disabledMcpjsonServers":["a"]}']);
  assert.deepEqual(comSettings(['--settings', '{"disableAllHooks":true,"disabledMcpjsonServers":["x"]}'], { disabledMcpjsonServers: ['a', 'x'] }), ['--settings', '{"disableAllHooks":true,"disabledMcpjsonServers":["x","a"]}']);
});

test('GET /mcp: projeto (com o herdado de cima), pessoais e pendentes; a proteção bloqueia os não aprovados', async () => {
  const r = await chamar('GET', '/mcp', undefined, { pasta: PROJ });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const por = Object.fromEntries(r.json.servidores.map((s) => [s.onde + ':' + s.nome, s]));
  assert.deepEqual(Object.keys(por).sort(), ['local:meu', 'pessoal:global1', 'projeto:clonado', 'projeto:herdado']);
  assert.equal(por['projeto:clonado'].status, 'pendente');
  assert.equal(por['projeto:clonado'].comando, 'npx -y pacote-x');
  assert.deepEqual(por['projeto:clonado'].env, ['API_KEY']);
  assert.deepEqual(por['projeto:clonado'].textoPuro, [{ onde: 'env', chave: 'API_KEY' }]);
  assert.equal(JSON.stringify(r.json).includes('segredo-literal'), false, 'valor do env nunca vai para a página');
  assert.equal(por['projeto:herdado'].herdado, true);
  assert.equal(por['projeto:herdado'].transporte, 'stdio');
  assert.equal(r.json.pendentes, 2);
  const p = await mcp.protecao(PROJ);
  assert.deepEqual(p.bloquear.sort(), ['clonado', 'herdado']);
  assert.deepEqual(p.env, {});
});

test('verificar: a sonda recebe a proteção e o status vem por nome e escopo; plugin entra só leitura', async () => {
  const r = await chamar('POST', '/mcp/verificar', { pasta: PROJ });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(sondados.at(-1).prot.bloquear.sort(), ['clonado', 'herdado']);
  const por = Object.fromEntries(r.json.servidores.map((s) => [s.onde + ':' + s.nome, s]));
  assert.equal(por['local:meu'].status, 'connected');
  assert.equal(por['pessoal:global1'].status, 'failed');
  assert.equal(por['pessoal:global1'].erro, 'HTTP 401');
  assert.equal(por['plugin:plugin:x:y'].editavel, false);
  assert.equal(por['projeto:clonado'].status, 'pendente');
  assert.equal(r.json.sonda.ok, true);
});

test('aprovar: hash diferente é recusado; com o certo, deixa de ser bloqueado; mudou o arquivo, volta a pendente', async () => {
  const l = await chamar('GET', '/mcp', undefined, { pasta: PROJ });
  const s = l.json.servidores.find((x) => x.nome === 'clonado');
  assert.equal((await chamar('POST', '/mcp/aprovar', { pasta: PROJ, arquivo: s.arquivo, nome: 'clonado', hash: 'x' })).status, 409);
  const ok = await chamar('POST', '/mcp/aprovar', { pasta: PROJ, arquivo: s.arquivo, nome: 'clonado', hash: s.hash });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.servidores.find((x) => x.nome === 'clonado').aprovacao, 'aprovado');
  assert.deepEqual((await mcp.protecao(PROJ)).bloquear, ['herdado']);
  // Alguém muda o comando no arquivo (um pull, por exemplo): volta a pendente e a ser bloqueado.
  const j = lerArq(path.join(PROJ, '.mcp.json'));
  j.mcpServers.clonado.args.push('--malicioso');
  fs.writeFileSync(path.join(PROJ, '.mcp.json'), JSON.stringify(j, null, 2));
  const de = await chamar('GET', '/mcp', undefined, { pasta: PROJ });
  assert.equal(de.json.servidores.find((x) => x.nome === 'clonado').aprovacao, 'alterado');
  assert.deepEqual((await mcp.protecao(PROJ)).bloquear.sort(), ['clonado', 'herdado']);
  const s2 = de.json.servidores.find((x) => x.nome === 'clonado');
  assert.equal((await chamar('POST', '/mcp/aprovar', { pasta: PROJ, arquivo: s2.arquivo, nome: 'clonado', hash: s2.hash })).status, 200);
});

test('proteger: a chave em texto puro vai para o cofre e o arquivo fica com ${ORBIT_MCP_…}; a aprovação segue', async () => {
  const arq = path.join(PROJ, '.mcp.json');
  const r = await chamar('POST', '/mcp/proteger', { pasta: PROJ, arquivo: arq, nome: 'clonado' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const env = lerArq(arq).mcpServers.clonado.env;
  assert.match(env.API_KEY, /^\$\{ORBIT_MCP_CLONADO_API_KEY_[0-9A-F]{4}\}$/);
  assert.equal(tudoNaPasta(PROJ).includes('segredo-literal-123456'), false);
  const v = env.API_KEY.slice(2, -1);
  assert.equal(JSON.parse(cofreTexto)[v], 'segredo-literal-123456');
  const s = r.json.servidores.find((x) => x.nome === 'clonado');
  assert.equal(s.aprovacao, 'aprovado');
  assert.deepEqual(s.textoPuro, []);
  assert.deepEqual(s.chaves, [{ variavel: v, guardada: true, chave: 'API_KEY' }]);
  assert.deepEqual((await mcp.protecao(PROJ)).env, { [v]: 'segredo-literal-123456' });
});

test('adicionar no projeto: chave no cofre, só ${…} no .mcp.json, já aprovado; chave no comando é recusada', async () => {
  const ruim = await chamar('POST', '/mcp/adicionar', { pasta: PROJ, nome: 'x', tipo: 'local', comando: 'node s.js --token=abcdefgh123' });
  assert.equal(ruim.status, 400);
  assert.equal(ruim.json.codigo, 'chave_em_texto');
  assert.equal((await chamar('POST', '/mcp/adicionar', { pasta: PROJ, nome: 'a b', tipo: 'local', comando: 'node' })).status, 400);
  assert.equal((await chamar('POST', '/mcp/adicionar', { pasta: PROJ, nome: 'r', tipo: 'remoto', url: 'ftp://x' })).status, 400);
  const r = await chamar('POST', '/mcp/adicionar', { pasta: PROJ, nome: 'busca', tipo: 'remoto', url: 'https://mcp.busca.exemplo/mcp', chaves: [{ chave: 'Authorization', valor: 'Bearer chave-secreta-999' }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const cfg = lerArq(path.join(PROJ, '.mcp.json')).mcpServers.busca;
  assert.equal(cfg.type, 'http');
  assert.match(cfg.headers.Authorization, /^\$\{ORBIT_MCP_BUSCA_AUTHORIZATION_[0-9A-F]{4}\}$/);
  assert.equal(tudoNaPasta(PROJ).includes('chave-secreta-999'), false);
  assert.equal(fs.readFileSync(path.join(DADOS, 'mcp-orbit.json'), 'utf8').includes('chave-secreta-999'), false, 'o índice não guarda o valor');
  const s = r.json.servidores.find((x) => x.nome === 'busca');
  assert.equal(s.aprovacao, 'aprovado');
  assert.equal(s.tipo, 'remoto');
  assert.equal((await mcp.protecao(PROJ)).env[cfg.headers.Authorization.slice(2, -1)], 'Bearer chave-secreta-999');
  assert.equal((await chamar('POST', '/mcp/adicionar', { pasta: PROJ, nome: 'busca', tipo: 'local', comando: 'node' })).status, 409);
});

test('pessoal: sem confirmação, 428 e o ~/.claude.json fica igual; com ela, local e user', async () => {
  const antes = fs.readFileSync(CJ, 'utf8');
  for (const onde of ['local', 'pessoal']) {
    const r = await chamar('POST', '/mcp/adicionar', { pasta: PROJ, nome: 'p-' + onde, tipo: 'local', comando: 'node p.js', onde });
    assert.equal(r.status, 428);
    assert.equal(r.json.codigo, 'confirmar_pessoal');
  }
  assert.equal((await chamar('POST', '/mcp/ativo', { pasta: PROJ, onde: 'local', nome: 'meu', ativo: false })).status, 428);
  assert.equal((await chamar('POST', '/mcp/remover', { pasta: PROJ, onde: 'pessoal', nome: 'global1' })).status, 428);
  assert.equal(fs.readFileSync(CJ, 'utf8'), antes);
  const r = await chamar('POST', '/mcp/adicionar', { pasta: PROJ, nome: 'p-local', tipo: 'local', comando: 'node p.js', onde: 'local', confirmarPessoal: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const g = await chamar('POST', '/mcp/adicionar', { pasta: PROJ, nome: 'p-user', tipo: 'remoto', url: 'https://u.exemplo/mcp', onde: 'pessoal', confirmarPessoal: true });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  const cj = lerArq(CJ);
  assert.equal(cj.numStartups, 3, 'o resto do arquivo fica');
  assert.deepEqual(cj.projects[PROJ.replace(/\\/g, '/')].mcpServers['p-local'], { type: 'stdio', command: 'node', args: ['p.js'] });
  assert.deepEqual(cj.mcpServers['p-user'], { type: 'http', url: 'https://u.exemplo/mcp' });
});

test('ativo: projeto no .claude/settings.json; pessoal só neste projeto, no disabledMcpServers', async () => {
  const des = await chamar('POST', '/mcp/ativo', { pasta: PROJ, onde: 'projeto', nome: 'busca', ativo: false });
  assert.equal(des.status, 200, JSON.stringify(des.json));
  assert.deepEqual(lerArq(path.join(PROJ, '.claude', 'settings.json')), { disabledMcpjsonServers: ['busca'] });
  assert.equal(des.json.servidores.find((x) => x.nome === 'busca').status, 'desativado');
  assert.equal(Object.keys((await mcp.protecao(PROJ)).env).some((v) => v.includes('BUSCA')), false, 'desativado não recebe a chave');
  assert.equal((await chamar('POST', '/mcp/ativo', { pasta: PROJ, onde: 'projeto', nome: 'busca', ativo: true })).status, 200);
  assert.deepEqual(lerArq(path.join(PROJ, '.claude', 'settings.json')), {});
  const p = await chamar('POST', '/mcp/ativo', { pasta: PROJ, onde: 'pessoal', nome: 'global1', ativo: false, confirmarPessoal: true });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const cj = lerArq(CJ);
  assert.deepEqual(cj.projects[PROJ.replace(/\\/g, '/')].disabledMcpServers, ['global1']);
  assert.equal(cj.mcpServers.global1.url, 'https://g.exemplo/mcp', 'o servidor pessoal continua para os outros projetos');
  assert.equal(p.json.servidores.find((x) => x.nome === 'global1').status, 'desativado');
});

test('remover: tira do .mcp.json, da aprovação e do cofre; o herdado de cima não se remove daqui', async () => {
  const arq = path.join(PROJ, '.mcp.json');
  const v = lerArq(arq).mcpServers.busca.headers.Authorization.slice(2, -1);
  const r = await chamar('POST', '/mcp/remover', { pasta: PROJ, onde: 'projeto', arquivo: arq, nome: 'busca' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal('busca' in lerArq(arq).mcpServers, false);
  assert.equal(v in JSON.parse(cofreTexto), false);
  assert.equal(v in lerArq(path.join(DADOS, 'mcp-orbit.json')).segredos, false);
  assert.equal((await chamar('POST', '/mcp/remover', { pasta: PROJ, onde: 'projeto', arquivo: path.join(RAIZ, '.mcp.json'), nome: 'herdado' })).status, 409);
  assert.equal((await chamar('POST', '/mcp/remover', { pasta: PROJ, onde: 'projeto', arquivo: path.join(BASE, 'outro.json'), nome: 'x' })).status, 400);
  assert.equal((await chamar('GET', '/mcp', undefined, { pasta: path.join(BASE, 'desconhecida') })).status, 404);
  fs.rmSync(BASE, { recursive: true, force: true });
});
