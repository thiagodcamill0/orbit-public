// Testes do motor de instâncias (motor.mjs, rodada 6, etapa 1).
// Rodar:  node testes/motor.test.mjs   (ou node --test testes/motor.test.mjs)
// Cada teste sobe um motor próprio com GERENCIADOR_DADOS numa pasta nova (dentro de GERENCIADOR_DADOS ou
// da pasta temporária): pipe e motor.json são do teste, nunca os da produção. Os filhos são o
// testes/claude-falso.mjs. Não usa porta HTTP; só fala com o motor cujo motor.json tem o pid do spawn
// (nunca com o motor de outra sessão ou da produção).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipeDoMotor, VERSAO } from '../motor.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOTOR = path.join(RAIZ, 'motor.mjs');
const FALSO = path.join(RAIZ, 'testes', 'claude-falso.mjs');
const BASE = path.resolve(process.env.GERENCIADOR_DADOS || path.join(os.tmpdir(), 'gerenciador-testes'));
const RAIZ_TESTE = path.join(BASE, `motor-${Date.now()}`);
const WIN = process.platform === 'win32';
// Mac: o socket do motor de uma pasta de dados de teste fica nela (ou, longo demais, na pasta temporária),
// nunca em ~/Library/Application Support/Orbit. O HOME do teste é uma segunda trava.
const HOME_TESTE = path.join(RAIZ_TESTE, 'home');
const ENV_SO = WIN ? {} : { HOME: HOME_TESTE };
const pipeDoTeste = (dados) => (WIN ? pipeDoMotor(dados) : pipeDoMotor(dados, { home: HOME_TESTE }));
const PROJETOS = path.join(RAIZ_TESTE, 'projetos');
const PROJ = path.join(PROJETOS, 'proj');
const SESSOES = path.join(RAIZ_TESTE, 'sessoes');
const CWD = path.join(RAIZ_TESTE, 'cwd');
for (const d of [PROJ, SESSOES, CWD]) fs.mkdirSync(d, { recursive: true });

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const vivo = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function esperarQue(cond, ms = 5000, rotulo = 'condição') {
  const fim = Date.now() + ms;
  let ultimo;
  while (Date.now() < fim) {
    ultimo = await cond();
    if (ultimo) return ultimo;
    await espera(50);
  }
  throw new Error(`${rotulo} não aconteceu em ${ms} ms (último: ${JSON.stringify(ultimo)})`);
}
const comPrazo = (p, ms, rotulo = 'promessa') => Promise.race([p, espera(ms).then(() => Promise.reject(new Error(`${rotulo}: sem resposta em ${ms} ms`)))]);
const faixa = (de, ate) => Array.from({ length: ate - de + 1 }, (_, i) => de + i);

// ───────── motor ─────────

const motores = new Set();
after(() => {
  // Matar o motor mata os filhos (job do libuv): nada fica para trás.
  for (const m of motores) if (m.exitCode == null) try { m.kill(); } catch {}
});

const lerInfo = (dados) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dados, 'motor.json'), 'utf8'));
  } catch {
    return null;
  }
};

let nDados = 0;
async function subirMotor(env = {}) {
  const dados = path.join(RAIZ_TESTE, `dados${++nDados}`);
  fs.mkdirSync(dados, { recursive: true });
  assert.notEqual(path.resolve(dados).toLowerCase(), RAIZ.toLowerCase(), 'pasta de dados da produção');
  const m = spawn(process.execPath, [MOTOR], { env: { ...process.env, ...ENV_SO, GERENCIADOR_DADOS: dados, ...env }, stdio: 'ignore', windowsHide: true });
  motores.add(m);
  m.saiu = new Promise((r) => m.on('exit', (codigo) => r(codigo)));
  const info = await esperarQue(() => {
    const i = lerInfo(dados);
    return i && i.pid === m.pid ? i : null;
  }, 5000, 'motor.json');
  return { m, dados, info };
}

// Cliente do pipe: JSON por linha; guarda tudo o que chega.
function cliente(info) {
  const c = net.connect(info.pipe);
  const msgs = [];
  const ouvintes = new Set();
  let buf = '';
  let n = 0;
  c.setEncoding('utf8');
  c.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const j = JSON.parse(l);
      msgs.push(j);
      for (const f of [...ouvintes]) f(j);
    }
  });
  c.on('error', () => {});
  const fechou = new Promise((r) => c.on('close', r));
  const k = {
    msgs,
    fechou,
    bruto: (o) => c.write(JSON.stringify(o) + '\n'),
    esperar(pred, ms = 5000, rotulo = 'mensagem') {
      const ja = msgs.find(pred);
      if (ja) return Promise.resolve(ja);
      return new Promise((ok, ko) => {
        const t = setTimeout(() => (ouvintes.delete(f), ko(new Error(`sem ${rotulo} em ${ms} ms`))), ms);
        const f = (j) => pred(j) && (clearTimeout(t), ouvintes.delete(f), ok(j));
        ouvintes.add(f);
      });
    },
    pedir(op, dados = {}) {
      const req = `r${++n}`;
      k.bruto({ ...dados, op, req });
      return k.esperar((j) => j.req === req, 8000, `resposta de ${op}`);
    },
    // Linhas do stdout recebidas para a instância, já parseadas, com o seq.
    linhas: (id) => msgs.filter((j) => j.ev === 'linha' && j.id === id).map((j) => ({ seq: j.seq, ...JSON.parse(j.linha) })),
    linhaQue: (id, pred, ms = 5000, rotulo = 'linha') => k.esperar((j) => j.ev === 'linha' && j.id === id && pred(JSON.parse(j.linha)), ms, rotulo),
    fechar: () => c.destroy(),
  };
  return k;
}
async function conectar(info) {
  const k = cliente(info);
  const r = await k.pedir('auth', { token: info.token });
  assert.equal(r.ok, true);
  assert.equal(r.versao, VERSAO);
  return k;
}

// ───────── sessões do claude-falso ─────────

function novaSessao() {
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(PROJ, `${id}.jsonl`), JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: 'oi' }, sessionId: id, cwd: CWD }) + '\n');
  return id;
}
function envFalso() {
  const e = {};
  for (const k in process.env) if (!/^CLAUDE/i.test(k)) e[k] = process.env[k];
  return { ...e, ORBIT_PROJETOS_DIR: PROJETOS, GERENCIADOR_SESSOES_DIR: SESSOES, FALSO_DEMORA_MS: '1500' };
}
const lancar = (k, id, extra = {}) =>
  k.pedir('lancar', {
    id,
    cmd: process.execPath,
    args: [FALSO, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--resume', id],
    cwd: CWD,
    env: envFalso(),
    meta: { sessao: id, n: 1 },
    ...extra,
  });
const escrever = (k, id, o) => k.pedir('escrever', { id, linha: JSON.stringify(o) });
const user = (texto) => ({ type: 'user', message: { role: 'user', content: texto } });
const listar = async (k, id) => (await k.pedir('listar')).instancias.find((i) => i.id === id);
async function iniciar(k, id, rid = 'ini-' + id.slice(0, 8)) {
  assert.equal((await escrever(k, id, { type: 'control_request', request_id: rid, request: { subtype: 'initialize' } })).ok, true);
  await k.linhaQue(id, (j) => j.type === 'control_response' && j.response?.request_id === rid, 5000, 'resposta do initialize');
}

// ───────── testes ─────────

test('lancar, escrever, fechar e saiu; estado mínimo, seq e meta; sair só sem processos vivos', async () => {
  const { m, dados, info } = await subirMotor();
  assert.equal(info.pipe, pipeDoTeste(dados));
  if (WIN) assert.match(info.pipe, /^\\\\\.\\pipe\\orbit-motor-[0-9a-f]{12}$/);
  else {
    // Mac: socket Unix só do usuário; o caminho cabe no sun_path (104 bytes no macOS).
    assert.match(path.basename(info.pipe), /^(orbit-)?motor-[0-9a-f]{12}\.sock$/);
    assert.ok(Buffer.byteLength(info.pipe) <= 100, info.pipe);
    assert.ok(!info.pipe.includes('/Library/Application Support/'), `socket de teste na pasta local: ${info.pipe}`);
    assert.equal(fs.statSync(info.pipe).mode & 0o777, 0o600);
  }
  assert.match(info.token, /^[0-9a-f]{64}$/);
  assert.equal(info.versao, VERSAO);
  assert.ok(info.desde > 0);
  const k = await conectar(info);
  const id = novaSessao();
  const r = await lancar(k, id);
  assert.equal(r.ok, true, r.erro);
  assert.ok(r.pid > 0 && vivo(r.pid));
  let i = await listar(k, id);
  assert.equal(i.vivo, true);
  assert.equal(i.pid, r.pid);
  assert.deepEqual(i.meta, { sessao: id, n: 1 });
  assert.deepEqual(i.estado, { ocupada: false, sessao: null, iniciado: false, permissoes: [] });

  await iniciar(k, id);
  assert.equal((await listar(k, id)).estado.iniciado, true);
  await escrever(k, id, user('DEMORA olá motor'));
  assert.equal((await listar(k, id)).estado.ocupada, true, 'ocupada liga quando o cliente escreve o user');
  await k.linhaQue(id, (j) => j.type === 'result', 5000, 'result');
  i = await listar(k, id);
  assert.equal(i.estado.ocupada, false);
  assert.equal(i.estado.sessao, id);
  const ls = k.linhas(id);
  assert.deepEqual(ls.map((l) => l.type), ['control_response', 'system', 'user', 'assistant', 'result']);
  assert.deepEqual(ls.map((l) => l.seq), faixa(1, ls.length));
  assert.equal(i.seq, ls.length);
  assert.equal(ls.at(-1).result, 'Resposta: DEMORA olá motor');

  assert.equal((await k.pedir('meta', { id, meta: { x: 2 } })).ok, true);
  assert.deepEqual((await listar(k, id)).meta, { x: 2 });
  // Pedidos recusados.
  assert.equal((await k.pedir('sair')).ok, false);
  assert.equal((await k.pedir('escrever', { id: 'nao-existe', linha: '{}' })).ok, false);
  assert.equal((await lancar(k, id)).codigo, 'existe');
  const ruim = await lancar(k, 'outro', { cmd: path.join(RAIZ_TESTE, 'nao-existe.exe') });
  assert.equal(ruim.ok, false);
  assert.ok(ruim.erro);
  assert.equal((await k.pedir('voar')).ok, false);

  // fechar → EOF no stdin → saiu com 0; a morta continua no listar, com o código.
  assert.equal((await k.pedir('fechar', { id })).ok, true);
  const saiu = await k.esperar((j) => j.ev === 'saiu' && j.id === id, 5000, 'saiu');
  assert.equal(saiu.codigo, 0);
  i = await listar(k, id);
  assert.equal(i.vivo, false);
  assert.equal(i.codigo, 0);
  assert.equal((await escrever(k, id, user('x'))).ok, false);

  // Sem processos vivos, sair obedece e apaga o motor.json.
  assert.equal((await k.pedir('sair')).ok, true);
  assert.equal(await comPrazo(m.saiu, 4000, 'saída do motor'), 0);
  assert.equal(lerInfo(dados), null);
  if (!WIN) assert.ok(!fs.existsSync(info.pipe), 'Mac: o motor saiu e deixou o arquivo do socket');
});

test('token errado (ou sem auth) é recusado e não derruba o cliente atual', async () => {
  const { info } = await subirMotor();
  const bom = await conectar(info);
  const mau = cliente(info);
  mau.bruto({ op: 'auth', token: 'f'.repeat(64), req: 'a' });
  await comPrazo(mau.fechou, 3000, 'fechar a conexão com token errado');
  assert.equal(mau.msgs.length, 0);
  const semAuth = cliente(info);
  semAuth.bruto({ op: 'listar', req: '1' });
  await comPrazo(semAuth.fechou, 3000, 'fechar a conexão sem auth');
  assert.equal(semAuth.msgs.length, 0);
  assert.equal((await bom.pedir('listar')).ok, true, 'o cliente certo caiu');
  assert.ok(!bom.msgs.some((j) => j.ev === 'substituido'));
});

test('segundo motor na mesma pasta de dados sai com 0 e não mexe no motor.json', async () => {
  const { m, dados, info } = await subirMotor();
  const m2 = spawn(process.execPath, [MOTOR], { env: { ...process.env, ...ENV_SO, GERENCIADOR_DADOS: dados }, stdio: 'ignore', windowsHide: true });
  motores.add(m2);
  const codigo = await comPrazo(new Promise((r) => m2.on('exit', r)), 5000, 'saída do segundo motor');
  assert.equal(codigo, 0);
  assert.deepEqual(lerInfo(dados), info);
  assert.ok(vivo(m.pid));
  assert.equal((await (await conectar(info)).pedir('listar')).ok, true);
});

test('o cliente cai e volta: listar mostra o processo vivo, assinar desde entrega o que se perdeu; a conexão nova derruba a antiga', async () => {
  const { info } = await subirMotor();
  const a = await conectar(info);
  const id = novaSessao();
  assert.equal((await lancar(a, id)).ok, true);
  await iniciar(a, id);
  await escrever(a, id, user('DEMORA:1200 enquanto cai'));
  const eco = await a.linhaQue(id, (j) => j.type === 'user', 5000, 'eco do user');
  const visto = eco.seq;
  a.fechar();
  await a.fechou;
  await espera(1800); // a volta termina sem cliente

  const b = await conectar(info);
  const i = await listar(b, id);
  assert.equal(i.vivo, true);
  assert.equal(i.estado.ocupada, false);
  assert.ok(i.seq >= visto + 2, `seq ${i.seq}, visto ${visto}`);
  const r = await b.pedir('assinar', { id, desde: visto });
  assert.equal(r.ok, true);
  assert.equal(r.seq, i.seq);
  const perdidas = await esperarQue(() => (b.linhas(id).length >= i.seq - visto ? b.linhas(id) : null), 3000, 'linhas perdidas');
  assert.deepEqual(perdidas.map((l) => l.seq), faixa(visto + 1, i.seq));
  assert.deepEqual(perdidas.map((l) => l.type), ['assistant', 'result']);
  assert.equal(perdidas.at(-1).result, 'Resposta: DEMORA:1200 enquanto cai');
  // Depois de assinar, segue ao vivo.
  await escrever(b, id, user('depois de voltar'));
  await b.linhaQue(id, (j) => j.type === 'result' && j.result === 'Resposta: depois de voltar', 5000, 'resposta ao vivo');

  // A conexão nova derruba a antiga (com aviso); sem assinar, não recebe as linhas da instância.
  const c = await conectar(info);
  await b.esperar((j) => j.ev === 'substituido', 3000, 'aviso de substituído');
  await comPrazo(b.fechou, 3000, 'fechar a conexão antiga');
  const antes = (await listar(c, id)).seq;
  await escrever(c, id, user('sem assinatura'));
  await esperarQue(async () => (await listar(c, id)).seq >= antes + 3, 5000, 'volta sem assinatura');
  assert.equal(c.linhas(id).length, 0);
  // O saiu chega ao cliente atual mesmo sem assinatura.
  await c.pedir('fechar', { id });
  assert.equal((await c.esperar((j) => j.ev === 'saiu' && j.id === id, 5000, 'saiu')).codigo, 0);
});

test('permissão pendente sobrevive à troca de cliente e some depois de respondida', async () => {
  const { info } = await subirMotor();
  const a = await conectar(info);
  const id = novaSessao();
  assert.equal((await lancar(a, id)).ok, true);
  await iniciar(a, id);
  await escrever(a, id, user('PERMISSAO motor'));
  const pedido = JSON.parse((await a.linhaQue(id, (j) => j.type === 'control_request' && j.request?.subtype === 'can_use_tool', 5000, 'pedido de permissão')).linha);
  a.fechar();
  await a.fechou;

  const b = await conectar(info);
  let i = await listar(b, id);
  assert.equal(i.estado.ocupada, true);
  assert.equal(i.estado.permissoes.length, 1);
  assert.deepEqual(i.estado.permissoes[0], pedido); // o control_request cru
  assert.equal(i.estado.permissoes[0].request.tool_name, 'Write');
  await b.pedir('assinar', { id, desde: i.seq });
  await escrever(b, id, { type: 'control_response', response: { subtype: 'success', request_id: pedido.request_id, response: { behavior: 'allow', updatedInput: pedido.request.input } } });
  assert.deepEqual((await listar(b, id)).estado.permissoes, []);
  const fim = await b.linhaQue(id, (j) => j.type === 'result', 5000, 'result');
  assert.equal(JSON.parse(fim.linha).result, 'Feito.');
  i = await listar(b, id);
  assert.equal(i.estado.ocupada, false);
  assert.deepEqual(i.estado.permissoes, []);
  // control_cancel_request do processo também tira o pedido do estado.
  await escrever(b, id, user('PERMISSAO CANCELA'));
  await b.linhaQue(id, (j) => j.type === 'control_request' && j.request?.subtype === 'can_use_tool' && j.request_id !== pedido.request_id, 5000, 'segundo pedido');
  assert.equal((await listar(b, id)).estado.permissoes.length, 1);
  await b.linhaQue(id, (j) => j.type === 'control_cancel_request', 5000, 'cancelamento');
  assert.deepEqual((await listar(b, id)).estado.permissoes, []);
  await b.linhaQue(id, (j) => j.type === 'result' && j.result === 'Não tive permissão.', 5000, 'result negado');
  await b.pedir('fechar', { id });
});

test('o motor sai sozinho quando ocioso (sem processos vivos e sem cliente), e só então', async () => {
  const { m, dados, info } = await subirMotor({ ORBIT_MOTOR_OCIOSO_MS: '700' });
  const k = await conectar(info);
  const id = novaSessao();
  assert.equal((await lancar(k, id)).ok, true);
  k.fechar();
  await k.fechou;
  await espera(1400);
  assert.ok(vivo(m.pid), 'saiu com processo vivo');
  const k2 = await conectar(info);
  await k2.pedir('fechar', { id });
  await k2.esperar((j) => j.ev === 'saiu' && j.id === id, 5000, 'saiu');
  await espera(1400);
  assert.ok(vivo(m.pid), 'saiu com cliente conectado');
  k2.fechar();
  assert.equal(await comPrazo(m.saiu, 4000, 'saída por ociosidade'), 0);
  assert.equal(lerInfo(dados), null);
});

test('limite de 5 processos vivos, matar, e matar o motor mata os filhos', async () => {
  const { m, info } = await subirMotor();
  const k = await conectar(info);
  const ids = Array.from({ length: 6 }, novaSessao);
  const pids = [];
  for (const id of ids.slice(0, 5)) {
    const r = await lancar(k, id);
    assert.equal(r.ok, true, r.erro);
    pids.push(r.pid);
  }
  const r6 = await lancar(k, ids[5]);
  assert.equal(r6.ok, false);
  assert.equal(r6.codigo, 'limite');
  assert.equal((await k.pedir('matar', { id: ids[0] })).ok, true);
  await k.esperar((j) => j.ev === 'saiu' && j.id === ids[0], 5000, 'saiu do morto');
  assert.ok(!vivo(pids[0]));
  const r6b = await lancar(k, ids[5]);
  assert.equal(r6b.ok, true, r6b.erro);
  const filhos = [...pids.slice(1), r6b.pid];
  assert.ok(filhos.every(vivo));
  m.kill(); // TerminateProcess só no motor (sem /T): os filhos morrem pelo job dele (Mac: SIGTERM, o motor mata a árvore deles)
  await comPrazo(m.saiu, 4000, 'morte do motor');
  await esperarQue(() => filhos.every((p) => !vivo(p)), 5000, 'filhos mortos junto com o motor');
});

// Mac: sem o job do Windows. Morto à força (SIGKILL), o motor não roda código nenhum: os filhos saem pelo fim
// do stdin, e o arquivo do socket fica no disco; o próximo motor da mesma pasta de dados o apaga e escuta.
test('Mac: motor morto com SIGKILL — filhos saem pelo fim do stdin; o socket velho é apagado e reaproveitado', { skip: WIN && 'só fora do Windows' }, async () => {
  const { m, dados, info } = await subirMotor();
  const k = await conectar(info);
  const id = novaSessao();
  const r = await lancar(k, id);
  assert.equal(r.ok, true, r.erro);
  assert.ok(vivo(r.pid));
  m.kill('SIGKILL');
  await comPrazo(m.saiu, 4000, 'morte do motor');
  await esperarQue(() => !vivo(r.pid), 5000, 'filho sem stdin encerrado');
  assert.ok(fs.existsSync(info.pipe), 'o socket velho deveria ficar no disco depois do SIGKILL');
  const m2 = spawn(process.execPath, [MOTOR], { env: { ...process.env, ...ENV_SO, GERENCIADOR_DADOS: dados }, stdio: 'ignore', windowsHide: true });
  motores.add(m2);
  const info2 = await esperarQue(() => {
    const i = lerInfo(dados);
    return i && i.pid === m2.pid ? i : null;
  }, 5000, 'motor.json do segundo motor');
  assert.equal(info2.pipe, info.pipe);
  assert.equal((await (await conectar(info2)).pedir('listar')).ok, true);
});

test('Mac: o caminho do socket respeita o sun_path com HOME curto, longo e com espaço', { skip: WIN && 'só fora do Windows' }, () => {
  for (const home of ['/Users/t', '/Users/' + 'x'.repeat(60), '/Users/Meu Nome', HOME_TESTE]) {
    const dados = path.join(RAIZ_TESTE, 'dados');
    for (const s of [pipeDoMotor(dados, { home, pasta: dados }), pipeDoMotor(dados, { home })]) assert.ok(Buffer.byteLength(s) <= 100, s);
  }
});
