// Testa o membro.mjs contra um servidor HTTP falso que imita as rotas da §3 do contrato dos escritórios.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { escolherPorta } from './porta-livre.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'membro.mjs');
const ORQ = 'sessao-orq';
let porta, servidor;
let reqs = [];
let membros; // estado por membro
let execucao; // status da execução

const escritorio = {
  id: 'esc1', nome: 'Agência',
  membros: [{ id: 'dev', papel: 'Desenvolvedor', nome: 'Ana' }, { id: 'rev', papel: 'Revisor', nome: 'Beto' }],
};

function responder(res, codigo, obj) {
  res.writeHead(codigo, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

before(async () => {
  porta = await escolherPorta(47822);
  servidor = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => (corpo += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      let json = null;
      try { json = corpo ? JSON.parse(corpo) : null; } catch {}
      reqs.push({ metodo: req.method, caminho: url.pathname, headers: req.headers, corpo: json });
      let m;
      if (req.method === 'GET' && url.pathname === '/escritorios/esc1') {
        return responder(res, 200, { escritorio, execucao: { status: execucao, membros: { dev: 's-dev' } } });
      }
      if (req.method === 'POST' && (m = url.pathname.match(/^\/escritorios\/esc1\/membro\/([^/]+)\/enviar$/))) {
        if (req.headers['x-gerenciador'] !== '1' || req.headers['x-orbit-sessao'] !== ORQ) return responder(res, 403, { erro: 'não é o orquestrador' });
        if (!membros[m[1]]) return responder(res, 404, { erro: 'membro não encontrado' });
        return responder(res, 200, { sessao: 's-' + m[1] });
      }
      if (req.method === 'GET' && (m = url.pathname.match(/^\/escritorios\/esc1\/membro\/([^/]+)\/estado$/))) {
        const e = membros[m[1]];
        if (!e) return responder(res, 404, { erro: 'membro não encontrado' });
        const prox = Array.isArray(e) ? (e.length > 1 ? e.shift() : e[0]) : e;
        return responder(res, 200, { status: prox.status, sessao: 's-' + m[1], resumo: prox.resumo || '' });
      }
      responder(res, 404, { erro: 'rota inexistente' });
    });
  });
  await new Promise((r) => servidor.listen(porta, '127.0.0.1', r));
});

after(() => new Promise((r) => servidor.close(() => r())));

function rodar(args, { env = {}, stdin } = {}) {
  reqs = [];
  return new Promise((resolve) => {
    const e = { ...process.env, ORBIT_PORTA: String(porta), ORBIT_ESCRITORIO: 'esc1', CLAUDE_CODE_HOST_SESSION_ID: ORQ, ORBIT_SESSAO: undefined, ORBIT_ESPERA_MS: '20', ...env };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    const p = spawn(process.execPath, [CLI, ...args], { env: e, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (codigo) => resolve({ codigo, out, err }));
    p.stdin.end(stdin || '');
  });
}

function reset() {
  execucao = 'rodando';
  membros = { dev: { status: 'trabalhando' }, rev: { status: 'trabalhando' } };
}

test('enviar: manda os cabeçalhos x-gerenciador e x-orbit-sessao e o corpo {tarefa}', async () => {
  reset();
  const r = await rodar(['enviar', 'dev', 'faça', 'o', 'login']);
  assert.equal(r.codigo, 0, r.err);
  assert.match(r.out, /enviada ao membro dev/);
  const q = reqs.find((x) => x.metodo === 'POST');
  assert.equal(q.caminho, '/escritorios/esc1/membro/dev/enviar');
  assert.equal(q.headers['x-gerenciador'], '1');
  assert.equal(q.headers['x-orbit-sessao'], ORQ);
  assert.deepEqual(q.corpo, { tarefa: 'faça o login' });
});

test('enviar: "-" lê a tarefa do stdin', async () => {
  reset();
  const r = await rodar(['enviar', 'dev', '-'], { stdin: 'tarefa longa\ncom linhas' });
  assert.equal(r.codigo, 0, r.err);
  assert.equal(reqs.find((x) => x.metodo === 'POST').corpo.tarefa, 'tarefa longa\ncom linhas');
});

test('enviar: 403 → saída 1 com mensagem clara', async () => {
  reset();
  const r = await rodar(['enviar', 'dev', 'oi'], { env: { CLAUDE_CODE_HOST_SESSION_ID: 'outra-sessao' } });
  assert.equal(r.codigo, 1);
  assert.match(r.err, /403/);
  assert.match(r.err, /orquestrador/);
});

test('enviar: ORBIT_SESSAO sozinho funciona (o claude do Orbit não recebe CLAUDE_*) e vence a reserva', async () => {
  reset();
  let r = await rodar(['enviar', 'dev', 'oi'], { env: { CLAUDE_CODE_HOST_SESSION_ID: undefined, ORBIT_SESSAO: ORQ } });
  assert.equal(r.codigo, 0, r.err);
  assert.equal(reqs.find((x) => x.metodo === 'POST').headers['x-orbit-sessao'], ORQ);
  r = await rodar(['enviar', 'dev', 'oi'], { env: { CLAUDE_CODE_HOST_SESSION_ID: 'outra-sessao', ORBIT_SESSAO: ORQ } });
  assert.equal(r.codigo, 0, r.err);
  r = await rodar(['enviar', 'dev', 'oi'], { env: { CLAUDE_CODE_HOST_SESSION_ID: undefined } });
  assert.equal(r.codigo, 1);
  assert.match(r.err, /ORBIT_SESSAO/);
  assert.match(r.err, /CLAUDE_CODE_HOST_SESSION_ID/);
});

test('enviar: membro inexistente → saída 1 com a mensagem do servidor', async () => {
  reset();
  const r = await rodar(['enviar', 'fantasma', 'oi']);
  assert.equal(r.codigo, 1);
  assert.match(r.err, /membro não encontrado/);
});

test('enviar: sem texto ou sem membro → saída 1', async () => {
  reset();
  assert.equal((await rodar(['enviar', 'dev'])).codigo, 1);
  assert.equal((await rodar(['enviar'])).codigo, 1);
  assert.equal(reqs.length, 0);
});

test('esperar: concluída → saída 0 com status e resumo curto (≤300)', async () => {
  reset();
  membros.dev = [{ status: 'trabalhando' }, { status: 'concluida', resumo: 'x'.repeat(500) }];
  const r = await rodar(['esperar', 'dev', '--max', '10']);
  assert.equal(r.codigo, 0, r.err);
  const [l1, l2] = r.out.trim().split('\n');
  assert.equal(l1, 'status: concluida');
  assert.ok(l2.length <= 300, `resumo com ${l2.length} caracteres`);
});

test('esperar: erro → saída 2', async () => {
  reset();
  membros.dev = { status: 'erro', resumo: 'falhou o build' };
  const r = await rodar(['esperar', 'dev']);
  assert.equal(r.codigo, 2);
  assert.match(r.err, /deu erro: falhou o build/);
});

test('esperar: interrompida → saída 2', async () => {
  reset();
  membros.dev = { status: 'interrompida' };
  const r = await rodar(['esperar', 'dev']);
  assert.equal(r.codigo, 2);
  assert.match(r.err, /interrompido/);
});

test('esperar: aguardando aprovação → saída 3', async () => {
  reset();
  membros.dev = { status: 'aguardando', resumo: 'git push' };
  const r = await rodar(['esperar', 'dev']);
  assert.equal(r.codigo, 3);
  assert.match(r.err, /aprovação/);
});

test('esperar: escritório pausado → saída 5', async () => {
  reset();
  execucao = 'pausada';
  const r = await rodar(['esperar', 'dev', '--max', '10']);
  assert.equal(r.codigo, 5);
  assert.match(r.err, /pausado/);
});

test('esperar: tempo esgotado → saída 4', async () => {
  reset();
  const r = await rodar(['esperar', 'dev', '--max', '0.3']);
  assert.equal(r.codigo, 4);
  assert.match(r.err, /ainda trabalha/);
});

test('esperar: --max inválido ou sem valor → saída 1', async () => {
  reset();
  assert.equal((await rodar(['esperar', 'dev', '--max', 'abc'])).codigo, 1);
  assert.equal((await rodar(['esperar', 'dev', '--max'])).codigo, 1);
  assert.equal((await rodar(['esperar'])).codigo, 1);
});

test('estado <membro>: status e resumo', async () => {
  reset();
  membros.dev = { status: 'concluida', resumo: 'tudo pronto' };
  const r = await rodar(['estado', 'dev']);
  assert.equal(r.codigo, 0, r.err);
  assert.match(r.out, /status: concluida/);
  assert.match(r.out, /resumo: tudo pronto/);
});

test('estado sem membro: visão do escritório e dos membros ativos', async () => {
  reset();
  membros.dev = { status: 'trabalhando', resumo: 'codando' };
  const r = await rodar(['estado']);
  assert.equal(r.codigo, 0, r.err);
  assert.match(r.out, /execução: rodando/);
  assert.match(r.out, /dev: trabalhando — codando/);
  assert.match(r.out, /rev: sem tarefa/);
});

test('lista: um membro por linha', async () => {
  reset();
  const r = await rodar(['lista']);
  assert.equal(r.codigo, 0, r.err);
  const linhas = r.out.trim().split('\n');
  assert.equal(linhas.length, 2);
  assert.match(linhas[0], /^dev — Desenvolvedor \(Ana\)$/);
  assert.match(linhas[1], /^rev — Revisor \(Beto\)$/);
});

test('uso errado → saída 1 (sem comando e comando desconhecido)', async () => {
  const a = await rodar([]);
  assert.equal(a.codigo, 1);
  assert.match(a.err, /Uso:/);
  const b = await rodar(['dançar']);
  assert.equal(b.codigo, 1);
  assert.match(b.err, /Comando desconhecido/);
  const c = await rodar(['estado', '--foo']);
  assert.equal(c.codigo, 1);
});

test('sem ORBIT_ESCRITORIO → saída 1 com mensagem', async () => {
  for (const cmd of [['lista'], ['estado'], ['enviar', 'dev', 'oi'], ['esperar', 'dev']]) {
    const r = await rodar(cmd, { env: { ORBIT_ESCRITORIO: undefined } });
    assert.equal(r.codigo, 1, cmd.join(' '));
    assert.match(r.err, /ORBIT_ESCRITORIO/);
  }
});

test('servidor fora do ar → saída 1 com mensagem clara', async () => {
  const r = await rodar(['lista'], { env: { ORBIT_PORTA: '1' } });
  assert.equal(r.codigo, 1);
  assert.match(r.err, /Não consegui falar com o Orbit/);
});
