// Testes de permissões e perguntas do Codex no servidor (etapa 3): fila de pedidos, POST /codex/sessao/:id/permissao,
// respostas ao app-server (accept/acceptForSession/decline, permissions scope turn, answers) e bloqueios automáticos.
// Rodar:  node --test testes/codex-permissoes.test.mjs
// Servidor real em porta de escolherPorta (47822–47826, nunca a 47821), GERENCIADOR_DADOS e CODEX_HOME temporários
// (apagados no fim) e o Codex FALSO (ORBIT_CODEX_EXE=testes/codex-falso.mjs). Nunca o codex real, nunca ~/.codex.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escolherPorta, desligarSeMeu } from './porta-livre.mjs';
import { traduzirPedido, dentroDe, recusar } from '../codex-instancias.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FALSO = path.join(RAIZ, 'testes', 'codex-falso.mjs');
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let PORTA, TMP, DADOS, HOME, TRABALHO;
let filho = null;
let sse = null;
const eventos = []; // SSE global { tipo, dados }
const abertos = []; // streams SSE de conversa/fluxo
const pids = new Set(); // pids do Codex falso vistos (para provar que nenhum sobra)

function pedir(metodo, rota, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
    const headers = { 'x-gerenciador': '1' };
    if (dados !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(dados); }
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers, timeout: 8000 }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const t = Buffer.concat(partes).toString('utf8');
        let json = null; try { json = JSON.parse(t); } catch {}
        resolve({ status: res.statusCode, json, texto: t });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (dados !== undefined) req.write(dados);
    req.end();
  });
}
const get = (r) => pedir('GET', r);
const post = (r, c) => pedir('POST', r, c ?? {});

// SSE: acumula { tipo, dados } em `lista`.
function abrirSSE(rota, lista) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: rota, headers: { accept: 'text/event-stream' } }, (res) => {
      res.setEncoding('utf8');
      let resto = '';
      res.on('data', (c) => {
        resto += c;
        let i;
        while ((i = resto.indexOf('\n\n')) >= 0) {
          const bloco = resto.slice(0, i); resto = resto.slice(i + 2);
          const tipo = /^event: (.*)$/m.exec(bloco)?.[1];
          const data = bloco.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (!tipo) continue;
          let dados = null; try { dados = JSON.parse(data); } catch {}
          lista.push({ tipo, dados });
        }
      });
      resolve({ req, status: res.statusCode });
    });
    req.on('error', reject);
  });
}
async function esperarEm(lista, pred, ms = 8000, desde = 0) {
  const t0 = Date.now();
  for (;;) {
    const e = lista.slice(desde).find(pred);
    if (e) return e;
    if (Date.now() - t0 > ms) throw new Error('tempo esgotado esperando o evento SSE');
    await espera(40);
  }
}
const esperarEvento = (pred, ms, desde) => esperarEm(eventos, pred, ms, desde);
const sessaoEv = (id, pred = () => true) => (e) => e.tipo === 'sessao' && e.dados?.id === id && pred(e.dados);
const acaoEv = (id, pred = () => true) => (e) => e.tipo === 'acao' && e.dados?.id === id && pred(e.dados);

async function esperarSessao(id, pred, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const todas = (await get('/estado')).json.sessoes;
    const s = todas.find((x) => x.id === id);
    if (s && pred(s)) return s;
    if (Date.now() - t0 > ms) throw new Error(`tempo esgotado esperando a sessão ${id}: ${JSON.stringify(s && { status: s.status, controle: s.controle })} (sessões: ${todas.map((x) => `${x.id.slice(0, 8)}:${x.status}`).join(', ')})`);
    await espera(60);
  }
}
const sessaoDe = async (id) => (await get('/estado')).json.sessoes.find((x) => x.id === id);

async function subir() {
  const env = {
    ...process.env,
    GERENCIADOR_PORTA: String(PORTA),
    GERENCIADOR_DADOS: DADOS,
    GERENCIADOR_SESSOES_DIR: path.join(TMP, 'sessoes'),
    ORBIT_PROJETOS_DIR: path.join(TMP, 'projetos'),
    CODEX_HOME: HOME,
    ORBIT_CODEX_EXE: FALSO,
    CODEX_FALSO_ATRASO_MS: '30',
    ORBIT_CODEX_INTERVALO_MS: '150',
    GERENCIADOR_TICK_MS: '300',
    ORBIT_MOTOR: '0',
    ...(process.platform === 'win32' ? {} : { HOME: path.join(TMP, 'home') }),
  };
  delete env.CLAUDE_CODE_HOST_SESSION_ID;
  filho = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env, stdio: process.env.ORBIT_TESTE_LOG ? ['ignore', fs.openSync(process.env.ORBIT_TESTE_LOG, 'a'), fs.openSync(process.env.ORBIT_TESTE_LOG, 'a')] : 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (filho.exitCode != null) throw new Error(`o servidor do teste saiu (código ${filho.exitCode})`);
    try { const r = await get('/saude'); if (r.json?.pid === filho.pid) return; } catch {}
    await espera(100);
  }
  throw new Error('servidor não subiu');
}
async function descer() {
  try { sse?.destroy(); } catch {}
  for (const a of abertos) { try { a.destroy(); } catch {} }
  const p = filho;
  if (!p) return;
  filho = null;
  if (p.exitCode != null) return;
  const saiu = new Promise((r) => p.once('exit', r));
  await desligarSeMeu(PORTA, p.pid);
  await Promise.race([saiu, espera(4000)]);
  if (p.exitCode == null) { try { p.kill(); } catch {} await Promise.race([saiu, espera(3000)]); }
}

function vivoPid(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function morreu(pid, ms = 4000) {
  const t0 = Date.now();
  while (vivoPid(pid)) { if (Date.now() - t0 > ms) return false; await espera(50); }
  return true;
}

function logFalso() {
  try { return fs.readFileSync(path.join(HOME, 'falso-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
const recebidos = (metodo) => logFalso().filter((l) => l.dir === 'recebido' && l.method === metodo);

before(async () => {
  PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47822);
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-codex-permissoes-'));
  DADOS = path.join(TMP, 'dados');
  HOME = path.join(TMP, 'codex-home');
  TRABALHO = path.join(TMP, 'trabalho');
  for (const d of [DADOS, HOME, TRABALHO, path.join(TMP, 'sessoes'), path.join(TMP, 'projetos'), path.join(TRABALHO, 'proj-p')]) fs.mkdirSync(d, { recursive: true });
});
after(async () => {
  await descer();
  for (const pid of pids) { try { process.kill(pid); } catch {} }
  fs.rmSync(TMP, { recursive: true, force: true });
});


let ID, PASTA;
const M_CMD = 'item/commandExecution/requestApproval';
const M_ARQ = 'item/fileChange/requestApproval';
const M_PERM = 'item/permissions/requestApproval';
const M_PERG = 'item/tool/requestUserInput';

const respostasCli = (metodo) => logFalso().filter((l) => l.dir === 'resposta-do-cliente' && l.method === metodo);
const rotaPerm = () => `/codex/sessao/${ID}/permissao`;
// Manda a mensagem e espera o pedido aparecer na sessão (status aguardando + controle.permissao).
async function pedirTurno(texto) {
  const desde = eventos.length;
  const r = await post(`/codex/sessao/${ID}/mensagem`, { texto });
  assert.equal(r.status, 202);
  const s = await esperarSessao(ID, (x) => x.status === 'aguardando' && x.controle.permissao);
  return { desde, s };
}
// Espera o turno acabar com a resposta final dada.
const fimDoTurno = (desde, resposta) => esperarEvento(sessaoEv(ID, (s) => s.status === 'concluida' && s.ultimaResposta === resposta), 8000, desde);
const semAguardando = (desde) => !eventos.slice(desde).some((e) => e.tipo === 'sessao' && e.dados?.id === ID && e.dados.status === 'aguardando');

test('chave desligada: a rota de permissão é 404; ligada, cria a sessão', async () => {
  await subir();
  assert.equal((await post('/codex/sessao/x/permissao', { id: '1', decisao: 'negar' })).status, 404);
  sse = (await abrirSSE('/fluxo', eventos)).req;
  await esperarEvento((e) => e.tipo === 'inicio');
  assert.equal((await post('/config', { codex: { ativo: true } })).status, 200);
  PASTA = path.join(TRABALHO, 'proj-p');
  const r = await post('/codex/instancias', { pasta: PASTA, nome: 'Permissões' });
  assert.equal(r.status, 202);
  ID = r.json.sessao;
  const s = await esperarSessao(ID, (x) => x.controle?.modo === 'orbit' && x.controle.processo === 'vivo');
  pids.add(s.controle.pid);
  assert.equal(s.controle.permissao, null);
  assert.equal(s.controle.pendentes, 0);
});

test('[comando]: aguardando + permissão (ferramenta CommandExecution) + alerta; permitir -> executado, decision accept', async () => {
  const { desde, s } = await pedirTurno('rode [comando]');
  const p = s.controle.permissao;
  assert.equal(p.tipo, 'ferramenta');
  assert.equal(p.ferramenta, 'CommandExecution');
  assert.equal(p.resumo, 'echo orbit');
  assert.equal(p.entrada.command, 'echo orbit');
  assert.ok(typeof p.id === 'string' && p.id);
  assert.deepEqual(p.sugestoes, [{ indice: 0, rotulo: 'Permitir este comando nesta sessão' }]);
  assert.equal(s.controle.pendentes, 1);
  assert.match(s.detalhe || '', /Aprovar echo orbit/);
  const al = await esperarEvento((e) => e.tipo === 'alerta' && e.dados?.tipo === 'aguardando' && e.dados?.sessao?.id === ID, 4000, desde);
  assert.ok(al);
  const r = await post(rotaPerm(), { id: p.id, decisao: 'permitir' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  await fimDoTurno(desde, 'Comando executado.');
  assert.equal(respostasCli(M_CMD).at(-1).result.decision, 'accept');
  const fim = await sessaoDe(ID);
  assert.equal(fim.controle.permissao, null);
  assert.equal(fim.controle.pendentes, 0);
  // a mesma decisão de novo: o pedido já foi respondido
  assert.equal((await post(rotaPerm(), { id: p.id, decisao: 'permitir' })).status, 404);
});

test('[comando] com sugestao 0 -> acceptForSession (só o cache da sessão)', async () => {
  const { desde, s } = await pedirTurno('rode [comando] de novo');
  const r = await post(rotaPerm(), { id: s.controle.permissao.id, decisao: 'permitir', sugestao: 0 });
  assert.equal(r.status, 200);
  await fimDoTurno(desde, 'Comando executado.');
  assert.equal(respostasCli(M_CMD).at(-1).result.decision, 'acceptForSession');
});

test('[comando] negar com mensagem -> Comando recusado, decision decline', async () => {
  const { desde, s } = await pedirTurno('rode [comando] e vou negar');
  const r = await post(rotaPerm(), { id: s.controle.permissao.id, decisao: 'negar', mensagem: 'Não pode rodar isso.' });
  assert.equal(r.status, 200);
  await fimDoTurno(desde, 'Comando recusado.');
  assert.deepEqual(respostasCli(M_CMD).at(-1).result, { decision: 'decline' }); // o esquema não carrega mensagem: descartada
});

test('[arquivo]: permitir -> gravado; negar -> recusado; sugestao 0 -> acceptForSession', async () => {
  let t = await pedirTurno('grave [arquivo]');
  const p = t.s.controle.permissao;
  assert.equal(p.ferramenta, 'FileChange');
  assert.equal(p.tipo, 'ferramenta');
  assert.equal(p.sugestoes.length, 1);
  await post(rotaPerm(), { id: p.id, decisao: 'permitir' });
  await fimDoTurno(t.desde, 'Arquivo gravado.');
  assert.equal(respostasCli(M_ARQ).at(-1).result.decision, 'accept');

  t = await pedirTurno('grave [arquivo] 2');
  await post(rotaPerm(), { id: t.s.controle.permissao.id, decisao: 'negar' });
  await fimDoTurno(t.desde, 'Arquivo recusado.');
  assert.equal(respostasCli(M_ARQ).at(-1).result.decision, 'decline');

  t = await pedirTurno('grave [arquivo] 3');
  await post(rotaPerm(), { id: t.s.controle.permissao.id, decisao: 'permitir', sugestao: 0 });
  await fimDoTurno(t.desde, 'Arquivo gravado.');
  assert.equal(respostasCli(M_ARQ).at(-1).result.decision, 'acceptForSession');
});

test('[pergunta]: tipo pergunta; sem respostas 400; com respostas -> answers.q1; negar -> answers vazio', async () => {
  let t = await pedirTurno('pergunte [pergunta]');
  const p = t.s.controle.permissao;
  assert.equal(p.tipo, 'pergunta');
  assert.equal(p.ferramenta, 'request_user_input');
  assert.deepEqual(p.perguntas, [{ pergunta: 'Qual cor?', cabecalho: 'Cor', multipla: false, opcoes: [{ rotulo: 'azul', descricao: 'Azul' }, { rotulo: 'verde', descricao: 'Verde' }] }]);
  assert.match((await sessaoDe(ID)).detalhe || '', /Fez uma pergunta/);
  const sem = await post(rotaPerm(), { id: p.id, decisao: 'permitir' });
  assert.equal(sem.status, 400);
  const vazia = await post(rotaPerm(), { id: p.id, decisao: 'permitir', respostas: { 'Qual cor?': '  ' } });
  assert.equal(vazia.status, 400);
  assert.match(vazia.json.erro, /Falta responder: Qual cor\?/);
  assert.equal((await sessaoDe(ID)).controle.permissao?.id, p.id, 'o pedido continua aberto depois do 400');
  const ok = await post(rotaPerm(), { id: p.id, decisao: 'permitir', respostas: { 'Qual cor?': 'verde' } });
  assert.equal(ok.status, 200);
  await fimDoTurno(t.desde, 'Resposta recebida: verde.');
  assert.deepEqual(respostasCli(M_PERG).at(-1).result.answers.q1.answers, ['verde']);

  t = await pedirTurno('pergunte [pergunta] 2');
  await post(rotaPerm(), { id: t.s.controle.permissao.id, decisao: 'negar' });
  await fimDoTurno(t.desde, 'Resposta recebida: (vazia).');
  assert.deepEqual(respostasCli(M_PERG).at(-1).result, { answers: {} });
});

test('[dois]: fila de 2 pedidos (pendentes 2 -> 1 -> 0), cada um na sua ordem', async () => {
  const desde = eventos.length;
  await post(`/codex/sessao/${ID}/mensagem`, { texto: 'rode [dois]' });
  const a = await esperarSessao(ID, (x) => x.status === 'aguardando' && x.controle.pendentes === 2);
  assert.equal(a.controle.permissao.resumo, 'echo 1');
  assert.equal((await post(rotaPerm(), { id: a.controle.permissao.id, decisao: 'permitir' })).status, 200);
  const b = await esperarSessao(ID, (x) => x.status === 'aguardando' && x.controle.pendentes === 1);
  assert.equal(b.controle.permissao.resumo, 'echo 2');
  assert.notEqual(b.controle.permissao.id, a.controle.permissao.id);
  assert.equal((await post(rotaPerm(), { id: b.controle.permissao.id, decisao: 'negar' })).status, 200);
  await fimDoTurno(desde, 'Decisões: accept,decline');
  assert.equal((await sessaoDe(ID)).controle.pendentes, 0);
});

test('interromper com pedido aberto: fila limpa, interrompida, id velho 404', async () => {
  const { desde, s } = await pedirTurno('rode [comando] e pare');
  const velho = s.controle.permissao.id;
  const r = await post(`/codex/sessao/${ID}/parar`);
  assert.equal(r.status, 202);
  await esperarEvento(acaoEv(r.json.acao.id, (x) => x.estado === 'sucesso'), 8000, desde);
  const f = await esperarSessao(ID, (x) => x.status === 'interrompida');
  assert.equal(f.controle.permissao, null);
  assert.equal(f.controle.pendentes, 0);
  assert.equal(f.controle.ocupada, false);
  assert.equal((await post(rotaPerm(), { id: velho, decisao: 'permitir' })).status, 404);
});

test('depois de interromper, um turno novo com pedido funciona e a fila vem limpa', async () => {
  const { desde, s } = await pedirTurno('rode [comando] outra vez');
  assert.equal(s.controle.pendentes, 1);
  await post(rotaPerm(), { id: s.controle.permissao.id, decisao: 'negar' });
  await fimDoTurno(desde, 'Comando recusado.');
  assert.equal((await sessaoDe(ID)).controle.pendentes, 0);
});

test('validações da rota: 400 (id, decisao, mensagem, sugestão), 404, 405', async () => {
  const { desde, s } = await pedirTurno('rode [comando] validar');
  const id = s.controle.permissao.id;
  assert.equal((await post(rotaPerm(), { decisao: 'permitir' })).status, 400);
  assert.equal((await post(rotaPerm(), { id: 5, decisao: 'permitir' })).status, 400);
  assert.equal((await post(rotaPerm(), { id })).status, 400);
  assert.equal((await post(rotaPerm(), { id, decisao: 'talvez' })).status, 400);
  assert.equal((await post(rotaPerm(), { id, decisao: 'negar', mensagem: 'x'.repeat(2001) })).status, 400);
  assert.equal((await post(rotaPerm(), { id, decisao: 'permitir', sugestao: 7 })).status, 400);
  assert.equal((await post(rotaPerm(), { id, decisao: 'permitir', sugestao: '0' })).status, 400);
  assert.equal((await post(rotaPerm(), { id: 'nao-existe', decisao: 'permitir' })).status, 404);
  assert.equal((await post('/codex/sessao/inexistente/permissao', { id, decisao: 'permitir' })).status, 404);
  assert.equal((await get(rotaPerm())).status, 405);
  assert.equal((await sessaoDe(ID)).controle.permissao?.id, id, 'nada disso respondeu o pedido');
  await post(rotaPerm(), { id, decisao: 'negar' });
  await fimDoTurno(desde, 'Comando recusado.');
});

test('[proibido] segue recusado (-32601) e nunca vira "aguardando"', async () => {
  const desde = eventos.length;
  await post(`/codex/sessao/${ID}/mensagem`, { texto: 'faça [proibido]' });
  await fimDoTurno(desde, 'Pedido fora da lista recusado (-32601).');
  assert.ok(semAguardando(desde));
  assert.equal(respostasCli('item/tool/call').at(-1).error.code, -32601);
});

test('[permissao]: aguardando; permitir devolve o perfil pedido só com scope turn; negar devolve vazio', async () => {
  let t = await pedirTurno('preciso de [permissao]');
  const p = t.s.controle.permissao;
  assert.equal(p.ferramenta, 'Permissions');
  assert.match(p.resumo, /escrever no projeto/);
  assert.ok(!/FORA/.test(p.resumo));
  assert.equal(p.sugestoes, undefined, 'sem "sempre permitir" nas permissões');
  await post(rotaPerm(), { id: p.id, decisao: 'permitir' });
  await esperarEvento(sessaoEv(ID, (s) => s.status === 'concluida' && /^Resposta: /.test(s.ultimaResposta || '')), 8000, t.desde);
  let res = respostasCli(M_PERM).at(-1).result;
  assert.equal(res.scope, 'turn');
  assert.deepEqual(res.permissions, { fileSystem: { entries: [{ access: 'write', path: { type: 'special', value: { kind: 'project_roots', subpath: null } } }] } });

  t = await pedirTurno('preciso de [permissao] 2');
  await post(rotaPerm(), { id: t.s.controle.permissao.id, decisao: 'negar' });
  await fimDoTurno(t.desde, `Resposta: ${JSON.stringify({ permissions: {}, scope: 'turn' })}`);
  res = respostasCli(M_PERM).at(-1).result;
  assert.deepEqual(res, { permissions: {}, scope: 'turn' });
});

test('[permissao-ampla], [permissao-fora] e [raiz] são recusados sozinhos (sem aguardando)', async () => {
  let desde = eventos.length;
  await post(`/codex/sessao/${ID}/mensagem`, { texto: 'quero [permissao-ampla]' });
  await fimDoTurno(desde, `Resposta: ${JSON.stringify({ permissions: {}, scope: 'turn' })}`);
  assert.ok(semAguardando(desde));
  assert.deepEqual(respostasCli(M_PERM).at(-1).result, { permissions: {}, scope: 'turn' });

  desde = eventos.length; // caminho fora da pasta do projeto (decisão de 21/10: só o projeto)
  await post(`/codex/sessao/${ID}/mensagem`, { texto: 'quero [permissao-fora]' });
  await fimDoTurno(desde, `Resposta: ${JSON.stringify({ permissions: {}, scope: 'turn' })}`);
  assert.ok(semAguardando(desde));
  assert.deepEqual(respostasCli(M_PERM).at(-1).result, { permissions: {}, scope: 'turn' });

  desde = eventos.length;
  await post(`/codex/sessao/${ID}/mensagem`, { texto: 'quero [raiz]' });
  await fimDoTurno(desde, `Resposta: ${JSON.stringify({ decision: 'decline' })}`);
  assert.ok(semAguardando(desde));
  assert.deepEqual(respostasCli(M_ARQ).at(-1).result, { decision: 'decline' });
  assert.equal((await sessaoDe(ID)).controle.pendentes, 0);
});

test('[legado] execCommandApproval: approved / approved_for_session / denied com a mensagem', async () => {
  let t = await pedirTurno('rode [legado]');
  const p = t.s.controle.permissao;
  assert.equal(p.ferramenta, 'CommandExecution');
  assert.equal(p.resumo, 'echo legado');
  await post(rotaPerm(), { id: p.id, decisao: 'permitir' });
  await fimDoTurno(t.desde, `Resposta: ${JSON.stringify({ decision: 'approved' })}`);

  t = await pedirTurno('rode [legado] 2');
  await post(rotaPerm(), { id: t.s.controle.permissao.id, decisao: 'permitir', sugestao: 0 });
  await fimDoTurno(t.desde, `Resposta: ${JSON.stringify({ decision: 'approved_for_session' })}`);

  t = await pedirTurno('rode [legado] 3');
  await post(rotaPerm(), { id: t.s.controle.permissao.id, decisao: 'negar', mensagem: 'Nada disso.' });
  await fimDoTurno(t.desde, `Resposta: ${JSON.stringify({ decision: { denied: { rejection: 'Nada disso.' } } })}`);

  t = await pedirTurno('rode [legado] 4');
  await post(rotaPerm(), { id: t.s.controle.permissao.id, decisao: 'negar' });
  await fimDoTurno(t.desde, `Resposta: ${JSON.stringify({ decision: { denied: { rejection: 'O usuário negou pelo Orbit.' } } })}`);
});

test('unit: traduzirPedido e dentroDe', () => {
  const cwd = path.resolve(TRABALHO, 'proj-p');
  assert.ok(dentroDe(cwd, path.join(cwd, 'a', 'b')));
  assert.ok(dentroDe(cwd, cwd));
  assert.ok(!dentroDe(cwd, path.join(cwd, '..', 'outro')));
  assert.ok(!dentroDe(cwd, path.dirname(cwd)));
  assert.ok(!dentroDe('', cwd));

  // rede: sem sugestão "nesta sessão"
  const rede = traduzirPedido(M_CMD, { command: 'curl x', networkApprovalContext: { host: 'exemplo.com', protocol: 'https' } }, { cwd });
  assert.match(rede.resumo, /^Acesso à rede: exemplo\.com/);
  assert.deepEqual(rede.sugestoes, []);
  assert.deepEqual(rede.aprovar, { decision: 'accept' });
  // emendas de política/rede propostas pelo servidor são ignoradas
  const em = traduzirPedido(M_CMD, { command: 'git push', proposedExecpolicyAmendment: ['git', 'push'], proposedNetworkPolicyAmendments: [{ host: 'x', action: 'allow' }], availableDecisions: ['acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment'] }, { cwd });
  assert.deepEqual(em.cruas, [{ decision: 'acceptForSession' }]);
  assert.ok(!JSON.stringify([em.aprovar, em.cruas, em.negar()]).includes('Amendment'));
  // fileChange: grantRoot fora bloqueia; dentro não; sem grantRoot ganha sugestão
  assert.ok(traduzirPedido(M_ARQ, { grantRoot: path.join(cwd, '..', 'fora') }, { cwd }).bloquear);
  assert.ok(!traduzirPedido(M_ARQ, { grantRoot: path.join(cwd, 'sub') }, { cwd }).bloquear);
  const fc = traduzirPedido(M_ARQ, { itemId: 'i' }, { cwd, item: { changes: [{ path: 'a.txt' }, { path: 'b.txt' }] } });
  assert.equal(fc.resumo, 'Editar a.txt, b.txt');
  assert.equal(fc.sugestoes.length, 1);
  // applyPatch (legado)
  const ap = traduzirPedido('applyPatchApproval', { fileChanges: { 'x.js': {} }, conversationId: 'c', callId: 'k' }, { cwd });
  assert.equal(ap.resumo, 'Editar x.js');
  assert.deepEqual(ap.aprovar, { decision: 'approved' });
  assert.deepEqual(ap.negar('não'), { decision: { denied: { rejection: 'não' } } });
  assert.ok(traduzirPedido('applyPatchApproval', { fileChanges: {}, grantRoot: path.dirname(cwd) }, { cwd }).bloquear);
  // permissões: nunca scope session; raiz/glob/vazio bloqueiam; rede e fora do projeto ficam para o usuário
  const pr = traduzirPedido(M_PERM, { permissions: { fileSystem: { entries: [{ access: 'write', path: { type: 'path', path: path.join(cwd, 'x') } }] } } }, { cwd });
  assert.ok(!pr.bloquear);
  assert.equal(pr.aprovar.scope, 'turn');
  assert.deepEqual(pr.negar(), { permissions: {}, scope: 'turn' });
  assert.ok(traduzirPedido(M_PERM, { permissions: { fileSystem: { entries: [{ access: 'write', path: { type: 'glob_pattern', pattern: '**' } }] } } }, { cwd }).bloquear);
  assert.ok(traduzirPedido(M_PERM, { permissions: {} }, { cwd }).bloquear);
  const fora = traduzirPedido(M_PERM, { permissions: { fileSystem: { entries: [{ access: 'read', path: { type: 'path', path: path.dirname(cwd) } }] }, network: { enabled: true } } }, { cwd });
  assert.ok(fora.bloquear); // arquivo fora da pasta do projeto: recusado sozinho (decisão de 21/10)
  assert.match(fora.resumo, /FORA do projeto/);
  assert.match(fora.resumo, /rede/);
  const soRede = traduzirPedido(M_PERM, { permissions: { network: { enabled: true } } }, { cwd });
  assert.ok(!soRede.bloquear); // rede não é escrita: vai para o usuário
  assert.match(soRede.resumo, /rede/);
  assert.equal(fora.aprovar.scope, 'turn');
  // pergunta
  const pg = traduzirPedido(M_PERG, { questions: [{ id: 'a', header: 'H', question: 'Q1?', options: [{ label: 'x', description: 'd' }] }, { id: 'b', header: 'H2', question: 'Q2?' }] }, { cwd });
  assert.equal(pg.tipo, 'pergunta');
  assert.deepEqual(pg.responder({ 'Q1?': 'x', 'Q2?': ['y', 'z'] }), { answers: { a: { answers: ['x'] }, b: { answers: ['y', 'z'] } } });
  assert.throws(() => pg.responder({ 'Q1?': 'x' }), /Falta responder: Q2\?/);
  assert.throws(() => traduzirPedido(M_PERG, { questions: [] }, { cwd }));
  // fora da lista: sem tradução / recusa genérica
  assert.throws(() => traduzirPedido('item/tool/call', {}, { cwd }), (e) => e.code === -32601);
  assert.throws(() => recusar('item/tool/call'), (e) => e.code === -32601);
  assert.deepEqual(recusar('execCommandApproval'), { decision: { denied: { rejection: 'Recusado pelo Orbit.' } } });
});

test('lista fechada: só métodos permitidos e nenhuma resposta que amplie o acesso', async () => {
  const lista = logFalso().filter((l) => l.dir === 'recebido');
  assert.ok(lista.length > 5);
  assert.ok(!lista.some((l) => l.fora_da_lista), 'nenhum fora_da_lista');
  const permitidos = new Set(['initialize', 'initialized', 'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt']);
  for (const l of lista) assert.ok(permitidos.has(l.method), `método inesperado: ${l.method}`);
  const respostas = logFalso().filter((l) => l.dir === 'resposta-do-cliente');
  assert.ok(respostas.length >= 15);
  const texto = JSON.stringify(respostas);
  assert.ok(!/ExecpolicyAmendment|NetworkPolicyAmendment/.test(texto));
  assert.ok(!/"scope":"session"/.test(texto), 'nunca scope session');
  assert.ok(!/"decision":"cancel"/.test(texto), 'o Orbit nunca cancela o turno por conta própria');
});

test('desligar a chave: o processo encerra e nenhum pid do falso sobra', async () => {
  const s = await esperarSessao(ID, (x) => x.controle.processo === 'vivo');
  pids.add(s.controle.pid);
  assert.equal((await post('/config', { codex: { ativo: false } })).status, 200);
  for (const p of pids) assert.ok(await morreu(p, 6000), `pid ${p} ainda vivo`);
  assert.ok(!(await get('/estado')).json.sessoes.some((x) => x.provedor === 'codex'));
  assert.equal((await post(rotaPerm(), { id: '1', decisao: 'negar' })).status, 404);
});
