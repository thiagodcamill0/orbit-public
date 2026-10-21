// Compactação automática das instâncias do Orbit (20/10).
// Rodar:  node --test testes/autocompactar.test.mjs
// Sobe um servidor próprio numa porta livre de 47822–47826 (nunca a 47821), com dados, registro de sessões e
// projetos falsos numa pasta temporária. O claude.exe é o testes/claude-falso.mjs, com o contexto da resposta
// trocado pelo <cwd>/falso-ctx.txt. Confere: config padrão (ligada, 140 mil, foco) e validação; compacta sozinha
// depois da volta que passou do limite, com o foco; marca o item da conversa e o Sessao.controle; relê os arquivos
// de progresso; espera os subagentes; desligada por instância e nas Configurações não compacta.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { escolherPorta } from './porta-livre.mjs';
import { matarArvore } from '../plataforma.mjs';
import { AUTO_COMPACTAR_PADRAO } from '../controle.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47822);
const WIN = process.platform === 'win32';
const realDe = (d) => (fs.mkdirSync(d, { recursive: true }), WIN ? d : fs.realpathSync(d));
const BASE = realDe(path.resolve(process.env.GERENCIADOR_DADOS || path.join(os.tmpdir(), 'gerenciador-testes')));
const DADOS = path.join(BASE, `autocompactar-${Date.now()}`);
const SESSOES = path.join(DADOS, 'sessoes');
const PROJETOS = path.join(DADOS, 'projetos');
for (const d of [SESSOES, PROJETOS]) fs.mkdirSync(d, { recursive: true });

const ENV = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_TICK_MS: '250',
  GERENCIADOR_PID_MS: '300',
  GERENCIADOR_SESSOES_DIR: SESSOES,
  ORBIT_PROJETOS_DIR: PROJETOS,
  ...(WIN ? {} : { HOME: path.join(DADOS, 'home') }),
  ORBIT_CLAUDE_BIN: path.join(RAIZ, 'testes', 'claude-falso.mjs'),
  ORBIT_MS_REGISTRO: '200',
  ORBIT_MS_VIGIA: '100',
  ORBIT_MS_INICIO: '2500',
  ORBIT_MS_MODELOS_INICIO: '300',
  ORBIT_MS_AUTO_QUIETO: '400',
  ORBIT_MS_TIQUE_AUTO: '100',
  CLAUDE_CODE_ENTRYPOINT: 'teste',
};
delete ENV.CLAUDE_CODE_HOST_SESSION_ID;
delete ENV.CLAUDECODE;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function pedir(metodo, rota, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
    const headers = { 'x-gerenciador': '1' };
    if (dados !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados) });
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers, timeout: 8000 }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        let json;
        try { json = JSON.parse(texto); } catch {}
        resolve({ status: res.statusCode, json, texto });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (dados !== undefined) req.write(dados);
    req.end();
  });
}
const get = (r) => pedir('GET', r);
const post = (r, c = {}) => pedir('POST', r, c);
const rs = (id, resto = '') => `/sessao/${encodeURIComponent(id)}${resto}`;
const controleDe = async (id) => (await get(rs(id))).json?.sessao?.controle;

async function esperarQue(cond, ms = 8000, rotulo = 'condição') {
  const fim = Date.now() + ms;
  let ultimo;
  while (Date.now() < fim) {
    ultimo = await cond();
    if (ultimo) return ultimo;
    await espera(80);
  }
  throw new Error(`${rotulo} não aconteceu em ${ms} ms (último: ${JSON.stringify(ultimo)})`);
}

// Ações pelo SSE /fluxo (evento `acao`).
const acoes = [];
let fluxoReq;
function ouvirFluxo() {
  return new Promise((ok, ko) => {
    fluxoReq = http.get({ host: '127.0.0.1', port: PORTA, path: '/fluxo' }, (res) => {
      ok();
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const bloco = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^event: acao$/m.test(bloco)) acoes.push(JSON.parse(/^data: (.*)$/m.exec(bloco)[1]));
        }
      });
    });
    fluxoReq.on('error', ko);
  });
}
const acoesDe = (id, tipo, via) => acoes.filter((a) => a.sessao === id && a.tipo === tipo && (!via || a.via === via));
const finais = (id, tipo, via) => {
  const m = new Map();
  for (const a of acoesDe(id, tipo, via)) if (a.estado !== 'em_andamento') m.set(a.id, a);
  return [...m.values()];
};

// O último estado de cada ação (o SSE manda a mesma ação a cada etapa).
const emAndamento = (id) => [...new Map(acoes.filter((a) => a.sessao === id).map((a) => [a.id, a])).values()].some((a) => a.estado === 'em_andamento');

let proc;
async function subir() {
  const antes = await get('/saude').catch(() => ({}));
  if (antes.status) throw new Error(`porta ${PORTA} ocupada por outro servidor`);
  proc = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write('[servidor] ' + d));
  await esperarQue(async () => {
    if (proc.exitCode != null) throw new Error(`o servidor do teste saiu (código ${proc.exitCode})`);
    const r = await get('/saude').catch(() => ({}));
    return r.status === 200 && r.json?.pid === proc.pid;
  }, 8000, 'servidor do teste no ar');
  await ouvirFluxo();
}
const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
after(async () => {
  fluxoReq?.destroy();
  const r = await get('/saude').catch(() => ({}));
  if (proc && r.json?.pid === proc.pid) await post('/desligar').catch(() => {});
  await espera(300);
  try { proc?.kill(); } catch {}
  let m = null;
  try { m = JSON.parse(fs.readFileSync(path.join(DADOS, 'motor.json'), 'utf8')); } catch {}
  if (m?.pid && vivo(m.pid)) {
    try {
      if (WIN) execFileSync('taskkill', ['/PID', String(m.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else await matarArvore(m.pid);
    } catch {}
  }
  await espera(300);
  try { fs.rmSync(DADOS, { recursive: true, force: true }); } catch {}
});

let nPasta = 0;
function pastaNova(ctx) {
  const cwd = path.join(DADOS, 'cwd', `inst${++nPasta}`);
  fs.mkdirSync(cwd, { recursive: true });
  if (ctx) grande(cwd, ctx);
  return cwd;
}
// A próxima resposta do claude-falso sai com esse contexto (o arquivo é apagado ao ser lido).
const grande = (cwd, ctx = 150000) => fs.writeFileSync(path.join(cwd, 'falso-ctx.txt'), String(ctx));
const transcriptDe = (cwd, id) => path.join(PROJETOS, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
const lerTranscript = (cwd, id) => { try { return fs.readFileSync(transcriptDe(cwd, id), 'utf8'); } catch { return ''; } };

async function criar(pasta, texto = 'Olá') {
  const r = await post('/instancias', { pasta, texto });
  assert.equal(r.status, 202, r.texto);
  return r.json.sessao;
}
// A volta da mensagem terminou (result): a ação 'mensagem' concluiu e a instância não está ocupada.
async function mandar(id, texto) {
  const r = await post(rs(id, '/mensagem'), { texto });
  assert.equal(r.status, 202, r.texto);
  return r.json.acao.id;
}

await subir();

test('config: padrão ligada, 140 mil, foco; validação do POST /config; foco vazio volta ao padrão', async () => {
  const c = (await get('/config')).json;
  assert.deepEqual(c.instancias.autoCompactar, { ativo: true, limite: 140000, foco: AUTO_COMPACTAR_PADRAO.foco });
  assert.match(c.instancias.autoCompactar.foco, /^Preserve o pedido original do usuário/);
  await post('/config', { instancias: { ...c.instancias, autoCompactar: { ativo: 'sim', limite: 5, foco: 'x'.repeat(501) } } });
  assert.deepEqual((await get('/config')).json.instancias.autoCompactar, { ativo: true, limite: 140000, foco: AUTO_COMPACTAR_PADRAO.foco });
  await post('/config', { instancias: { autoCompactar: { limite: 90000, foco: '  Só   o essencial ' } } });
  let ac = (await get('/config')).json.instancias;
  assert.deepEqual(ac.autoCompactar, { ativo: true, limite: 90000, foco: 'Só o essencial' });
  assert.equal(ac.dormirApos, 30); // o resto de instancias segue
  await post('/config', { instancias: { autoCompactar: { limite: 140000, foco: '' } } });
  ac = (await get('/config')).json.instancias;
  assert.deepEqual(ac.autoCompactar, { ativo: true, limite: 140000, foco: AUTO_COMPACTAR_PADRAO.foco });
});

test('passou do limite: compacta sozinha depois da volta, com o foco; controle e conversa mostram; relê o progresso', async () => {
  const pasta = pastaNova(150000);
  // Progresso na pasta de dados (<dados>/progresso/<nome da pasta do projeto>), nunca no projeto.
  const prog = path.join(DADOS, 'progresso', path.basename(pasta));
  fs.mkdirSync(path.join(prog, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(prog, 'tarefa.md'), '# Progresso\n');
  fs.writeFileSync(path.join(prog, 'sub', 'b.md'), '# B\n');
  fs.writeFileSync(path.join(prog, '.oculto'), 'x');
  const id = await criar(pasta, 'Primeira tarefa');
  const [comp] = await esperarQue(() => { const f = finais(id, 'compactar', 'auto'); return f.length ? f : null; }, 10000, 'compactação automática');
  assert.equal(comp.estado, 'sucesso', JSON.stringify(comp));
  assert.deepEqual(comp.resultado, { pre: 150510, pos: 1146 });
  const t = lerTranscript(pasta, id);
  assert.ok(t.includes(`<command-args>${AUTO_COMPACTAR_PADRAO.foco}</command-args>`), 'o /compact leva o foco padrão');
  // Controle: a última automática com o horário, antes e depois.
  const c = await controleDe(id);
  assert.equal(c.autoCompactar.ligada, true);
  assert.equal(c.autoCompactar.limite, 140000);
  assert.equal(c.autoCompactar.ultima.antes, 150510);
  assert.equal(c.autoCompactar.ultima.depois, 1146);
  assert.ok(Math.abs(c.autoCompactar.ultima.quando - Date.now()) < 15000);
  assert.ok(!c.autoCompactar.pendente && !c.autoCompactar.compactando);
  // Contexto da sessão: o de depois (1146), ou já o da volta da releitura, que vem logo em seguida.
  const s = (await get(rs(id))).json.sessao;
  assert.ok([1146, 1510].includes(s.contexto?.tokens), JSON.stringify(s.contexto));
  // Conversa: o divisor é marcado como automático.
  const conv = (await get(rs(id, '/conversa'))).json;
  const it = conv.itens.filter((x) => x.tipo === 'compactacao');
  assert.equal(it.length, 1);
  assert.equal(it[0].auto, true);
  // Progresso: uma mensagem do Orbit pede a releitura dos arquivos (sem o oculto), depois da compactação.
  const [msg] = await esperarQue(() => { const f = finais(id, 'mensagem', 'auto'); return f.length ? f : null; }, 8000, 'mensagem de releitura');
  assert.equal(msg.estado, 'sucesso');
  const t2 = lerTranscript(pasta, id);
  const linhaMsg = t2.split('\n').find((l) => l.includes('[Orbit] A conversa acabou de ser compactada automaticamente'));
  assert.ok(linhaMsg, 'a mensagem de releitura está no transcript');
  const progBarra = prog.replace(/\\/g, '/');
  const naMsg = (s) => linhaMsg.includes(s) || linhaMsg.includes(s.replace(/\//g, '\\\\')); // o transcript é JSON
  assert.ok(naMsg(`${progBarra}/sub/b.md`) && naMsg(`${progBarra}/tarefa.md`) && !linhaMsg.includes('.oculto'), linhaMsg);
  assert.ok(t2.indexOf('compact_boundary') < t2.indexOf('[Orbit] A conversa acabou'), 'a releitura vem depois da compactação');
  // Contexto pequeno: a volta da releitura não compacta de novo.
  await espera(1200);
  assert.equal(finais(id, 'compactar', 'auto').length, 1);
});

test('espera os subagentes terminarem; sem progresso, não manda mensagem', async () => {
  const pasta = pastaNova(150000);
  const id = await criar(pasta, 'Oi');
  await esperarQue(() => finais(id, 'compactar', 'auto').length, 10000, '1ª compactação');
  await esperarQue(async () => (await controleDe(id))?.ocupada === false && !emAndamento(id), 8000, 'livre');
  // Um subagente começa (hook) e a próxima volta passa do limite: fica pendente, esperando o subagente.
  await post('/evento', { session_id: id, hook_event_name: 'SubagentStart', agent_id: 'ag-1', agent_type: 'Explore', cwd: pasta, ts: Date.now() });
  grande(pasta);
  await mandar(id, 'Segunda');
  const pend = await esperarQue(async () => (await controleDe(id))?.autoCompactar?.pendente?.esperando, 8000, 'pendente esperando');
  assert.equal(pend, 'os subagentes terminarem');
  await espera(800);
  assert.equal(finais(id, 'compactar', 'auto').length, 1, 'não compacta com o subagente trabalhando');
  await post('/evento', { session_id: id, hook_event_name: 'SubagentStop', agent_id: 'ag-1', agent_type: 'Explore', cwd: pasta, ts: Date.now() });
  await esperarQue(() => finais(id, 'compactar', 'auto').length === 2, 8000, '2ª compactação depois do subagente');
  await espera(800);
  assert.equal(finais(id, 'mensagem', 'auto').length, 0, 'sem arquivo de progresso, nada de releitura');
});

test('desligada na instância não compacta; null volta a seguir a config; desligada nas Configurações não compacta', async () => {
  const pasta = pastaNova(150000);
  const id = await criar(pasta, 'Oi');
  await esperarQue(() => finais(id, 'compactar', 'auto').length, 10000, '1ª compactação');
  // Validação e sessão fora do Orbit.
  assert.equal((await post(rs(id, '/autocompactar'), { ativo: 'nao' })).status, 400);
  assert.equal((await post(rs('00000000-0000-0000-0000-000000000000', '/autocompactar'), { ativo: false })).status, 404);
  let r = await post(rs(id, '/autocompactar'), { ativo: false });
  assert.equal(r.status, 200);
  assert.equal(r.json.autoCompactar.ligada, false);
  assert.equal(r.json.autoCompactar.propria, false);
  await esperarQue(async () => (await controleDe(id))?.ocupada === false, 8000, 'livre');
  grande(pasta);
  await mandar(id, 'Segunda');
  await esperarQue(async () => finais(id, 'mensagem').length >= 2 && (await controleDe(id))?.ocupada === false, 8000, 'volta 2');
  await espera(1200);
  assert.equal(finais(id, 'compactar', 'auto').length, 1, 'desligada na instância');
  assert.ok(!(await controleDe(id)).autoCompactar.pendente);
  // null: segue a config (ligada) e, como o contexto já passou, compacta.
  r = await post(rs(id, '/autocompactar'), { ativo: null });
  assert.equal(r.json.autoCompactar.ligada, true);
  assert.equal(r.json.autoCompactar.propria, undefined);
  await esperarQue(() => finais(id, 'compactar', 'auto').length === 2, 8000, 'compacta ao voltar a seguir a config');
  // Desligada nas Configurações.
  const cfg = (await get('/config')).json.instancias;
  await post('/config', { instancias: { ...cfg, autoCompactar: { ...cfg.autoCompactar, ativo: false } } });
  assert.equal((await controleDe(id)).autoCompactar.ligada, false);
  await esperarQue(async () => (await controleDe(id))?.ocupada === false, 8000, 'livre');
  grande(pasta);
  await mandar(id, 'Terceira');
  await esperarQue(async () => finais(id, 'mensagem').length >= 3 && (await controleDe(id))?.ocupada === false, 8000, 'volta 3');
  await espera(1200);
  assert.equal(finais(id, 'compactar', 'auto').length, 2, 'desligada nas Configurações');
  // Ligada na instância vence a config desligada.
  r = await post(rs(id, '/autocompactar'), { ativo: true });
  assert.equal(r.json.autoCompactar.ligada, true);
  await esperarQue(() => finais(id, 'compactar', 'auto').length === 3, 8000, 'ligada na instância vence a config');
  await post('/config', { instancias: { ...cfg, autoCompactar: { ...cfg.autoCompactar, ativo: true } } });
});

test('com pedido de permissão aberto, espera a resposta e o fim da volta', async () => {
  const cfg = (await get('/config')).json.instancias;
  await post('/config', { instancias: { ...cfg, autoCompactar: { ...cfg.autoCompactar, ativo: false } } });
  const pasta = pastaNova(150000);
  const id = await criar(pasta, 'Oi');
  await esperarQue(async () => (await controleDe(id))?.ocupada === false && !emAndamento(id), 8000, 'livre');
  grande(pasta);
  await mandar(id, 'PERMISSAO para gravar');
  const perm = await esperarQue(async () => (await controleDe(id))?.permissao, 8000, 'pedido de permissão');
  // Liga só nesta instância com o contexto já acima do limite (da 1ª volta): fica pendente, esperando a permissão.
  const r = await post(rs(id, '/autocompactar'), { ativo: true });
  assert.equal(r.json.autoCompactar.ligada, true);
  const esp = await esperarQue(async () => (await controleDe(id))?.autoCompactar?.pendente?.esperando, 8000, 'pendente');
  assert.equal(esp, 'o pedido de permissão ser respondido');
  await espera(600);
  assert.equal(finais(id, 'compactar', 'auto').length, 0);
  assert.equal((await post(rs(id, '/permissao'), { id: perm.id, decisao: 'permitir' })).status, 200);
  const [comp] = await esperarQue(() => { const f = finais(id, 'compactar', 'auto'); return f.length ? f : null; }, 8000, 'compactação depois da volta');
  assert.equal(comp.estado, 'sucesso');
  const t = lerTranscript(pasta, id);
  assert.ok(t.lastIndexOf('tool_result') < t.lastIndexOf('compact_boundary'), 'compacta só depois da ferramenta');
  await post('/config', { instancias: { ...cfg, autoCompactar: { ...cfg.autoCompactar, ativo: true } } });
});
