// Testes do monitoramento por rollouts (codex-rollouts.mjs): rollouts sintéticos em pasta temporária (apagada no fim)
// e o que o Codex falso (testes/codex-falso.mjs) grava. Nunca ~/.codex nem o codex real. Rodar:
//   node --test testes/codex-rollouts.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrirCodex } from '../codex-rpc.mjs';
import { resumirRollout, criarMonitorRollouts, aplicarInatividade, diasParaVarrer, textoReal } from '../codex-rollouts.mjs';

const FALSO = fileURLToPath(new URL('./codex-falso.mjs', import.meta.url));
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-codex-roll-'));
after(() => { fs.rmSync(raiz, { recursive: true, force: true }); });

const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const p2 = (n) => String(n).padStart(2, '0');
let seq = 0;
const novaHome = () => fs.mkdtempSync(path.join(raiz, 'h-'));
const pastaDoDia = (home, d = new Date()) => path.join(home, 'sessions', String(d.getUTCFullYear()), p2(d.getUTCMonth() + 1), p2(d.getUTCDate()));
const L = (type, payload, ts = Date.now()) => JSON.stringify({ timestamp: new Date(ts).toISOString(), ordinal: seq++, type, payload }) + '\n';
const ev = (tipo, resto = {}, ts) => L('event_msg', { type: tipo, ...resto }, ts);
const meta = (id, extra = {}, ts) => L('session_meta', { id, session_id: id, cwd: 'C:\\dev\\meu-projeto', originator: 'codex_vscode', cli_version: '0.163.0', source: 'vscode', thread_source: 'user', ...extra }, ts);
const usuario = (texto, ts) => ev('item_completed', { item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text: texto }] } }, ts);
const agente = (texto, phase, ts) => ev('item_completed', { item: { type: 'AgentMessage', id: 'a', phase, content: [{ type: 'Text', text: texto }] } }, ts);
function arquivo(home, id, linhas, d = new Date()) {
  const dir = pastaDoDia(home, d);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `rollout-${d.toISOString().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`);
  fs.writeFileSync(f, linhas.join(''));
  return f;
}
const lin = (s) => s.split('\n').filter(Boolean);

// Monitor determinístico: sem timer útil, varre à mão.
function monitor(home, opcoes = {}) {
  const mudancas = [], usos = [];
  const m = criarMonitorRollouts({ home, intervaloMs: 1e9, aoMudar: (r) => mudancas.push(r), aoUso: (u) => usos.push(u), ...opcoes });
  return { m, mudancas, usos, ultimo: () => mudancas.at(-1) };
}

// ---------- Parte pura ----------
test('resumirRollout: turno completo, contexto, uso, contadores e última ferramenta', () => {
  const t0 = Date.parse('2026-10-21T10:00:00.000Z');
  const linhas = lin(
    meta(UUID(1), {}, t0)
    + L('turn_context', { turn_id: 't1', cwd: 'C:\\dev\\meu-projeto', approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write', writable_roots: [] }, model: 'gpt-5-codex', effort: 'high' }, t0 + 1000)
    + ev('task_started', { turn_id: 't1', model_context_window: 258400 }, t0 + 1100)
    + usuario('# Files mentioned by the user:\n\n## a.js\n\n## My request for Codex:\nArrume o bug do login', t0 + 1200)
    + ev('item_completed', { item: { type: 'CommandExecution', command: ['bash', '-lc', 'npm test'], status: 'completed' } }, t0 + 2000)
    + ev('item_completed', { item: { type: 'FileChange', changes: [{ path: 'C:\\dev\\meu-projeto\\login.js' }] } }, t0 + 3000)
    + ev('item_completed', { item: { type: 'McpToolCall', server: 'figma', tool: 'get_node' } }, t0 + 3500)
    + agente('pensando...', 'commentary', t0 + 3600)
    + agente('Corrigi o bug.', 'final_answer', t0 + 3700)
    + ev('token_count', { info: { total_token_usage: { total_tokens: 99999 }, last_token_usage: { input_tokens: 40000, cached_input_tokens: 30000, output_tokens: 500, reasoning_output_tokens: 100, total_tokens: 40500 }, model_context_window: 258400 }, rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: 1792000000 }, secondary: { used_percent: 5, window_minutes: 10080, resets_at: 1792500000 }, plan_type: 'plus' } }, t0 + 4000)
    + ev('task_complete', { turn_id: 't1', last_agent_message: 'Corrigi o bug do login.', duration_ms: 3000 }, t0 + 5000),
  );
  const r = resumirRollout(null, linhas);
  assert.equal(r.id, UUID(1));
  assert.equal(r.projeto, 'meu-projeto');
  assert.equal(r.originador, 'codex_vscode');
  assert.equal(r.fonte, 'vscode');
  assert.equal(r.subagente, null);
  assert.equal(r.inicio, t0);
  assert.equal(r.atividade, t0 + 5000);
  assert.equal(r.status, 'concluida');
  assert.equal(r.turnoAtivo, null);
  assert.equal(r.primeira, 'Arrume o bug do login');
  assert.equal(r.pedido, 'Arrume o bug do login');
  assert.equal(r.ultimaResposta, 'Corrigi o bug do login.');
  assert.equal(r.modelo, 'gpt-5-codex');
  assert.equal(r.esforco, 'high');
  assert.equal(r.aprovacao, 'on-request');
  assert.equal(r.sandbox, 'workspace-write');
  assert.equal(r.contexto.tokens, 40000);
  assert.equal(r.contexto.janela, 258400);
  assert.equal(r.contexto.pct, 15);
  assert.deepEqual(r.uso.primario, { pct: 12, janelaMin: 300, renova: 1792000000 * 1000 });
  assert.equal(r.uso.secundario.pct, 5);
  assert.equal(r.uso.plano, 'plus');
  assert.equal(r.uso.ts, t0 + 4000);
  assert.deepEqual(r.contadores, { turnos: 1, ferramentas: 3 });
  assert.deepEqual(r.ultimaFerramenta, { nome: 'figma/get_node', alvo: 'figma', ts: t0 + 3500 });
});

test('resumirRollout: incremental é equivalente a processar tudo e não altera o estado anterior', () => {
  const todas = lin(meta(UUID(2)) + ev('task_started', { turn_id: 'a' }) + usuario('oi') + ev('task_complete', { turn_id: 'a', last_agent_message: 'ok' }) + ev('task_started', { turn_id: 'b' }) + usuario('mais uma'));
  const inteiro = resumirRollout(null, todas);
  const parte1 = resumirRollout(null, todas.slice(0, 3));
  const congelado = JSON.stringify(parte1);
  const parte2 = resumirRollout(parte1, todas.slice(3));
  assert.equal(JSON.stringify(parte1), congelado, 'estado anterior intacto');
  assert.deepEqual(parte2, inteiro);
  assert.equal(inteiro.status, 'trabalhando');
  assert.equal(inteiro.turnoAtivo, 'b');
  assert.equal(inteiro.primeira, 'oi');
  assert.equal(inteiro.pedido, 'mais uma');
  assert.equal(inteiro.contadores.turnos, 2);
});

test('resumirRollout: linhas malformadas, parciais e vazias são ignoradas sem lançar', () => {
  const ruins = ['', '   ', 'isto não é json', '{"timestamp":"2026-10-21T10:00:00.000Z","type":"event_msg","payload":{"type":"task_st', '[1,2]', 'null', '{"type":"event_msg"}', '{"type":"event_msg","payload":5}', 123, null, undefined, { type: 'event_msg', payload: null }];
  const r = resumirRollout(null, [...ruins, ...lin(meta(UUID(3))), ...ruins]);
  assert.equal(r.id, UUID(3));
  assert.equal(r.status, 'nova');
  assert.doesNotThrow(() => resumirRollout(null, 'não é lista'));
  assert.doesNotThrow(() => resumirRollout(undefined, undefined));
});

test('resumirRollout: aborto, erro e blocos injetados fora da primeira mensagem', () => {
  let r = resumirRollout(null, lin(
    meta(UUID(4))
    + usuario('<environment_context>\n<cwd>x</cwd>\n</environment_context>')
    + usuario('<app-context>\nabc\n</app-context>\n\nFaça o deploy')
    + ev('task_started', { turn_id: 't' }) + ev('turn_aborted', { turn_id: 't', reason: 'interrupted' }),
  ));
  assert.equal(r.status, 'interrompida');
  assert.equal(r.motivo, 'interrupted');
  assert.equal(r.turnoAtivo, null);
  assert.equal(r.primeira, 'Faça o deploy');
  r = resumirRollout(r, lin(ev('task_started', { turn_id: 't2' }) + ev('error', { message: 'falhou a rede' })));
  assert.equal(r.status, 'erro');
  assert.match(r.motivo, /falhou/);
  r = resumirRollout(r, lin(ev('task_started', { turn_id: 't3' })));
  assert.equal(r.status, 'trabalhando');
  assert.equal(r.motivo, null);
  assert.equal(textoReal('# Files mentioned by the user:\n\n## x.js'), '');
  assert.equal(textoReal('<environment_context>a</environment_context>'), '');
});

test('resumirRollout: limites de tamanho (primeira/pedido 300, resposta 1000)', () => {
  const r = resumirRollout(null, lin(meta(UUID(5)) + usuario('x'.repeat(2000)) + ev('task_complete', { last_agent_message: 'y'.repeat(5000) })));
  assert.equal(r.primeira.length, 300);
  assert.equal(r.pedido.length, 300);
  assert.equal(r.ultimaResposta.length, 1000);
});

test('resumirRollout: origem de subagente (thread_spawn com pai, guardian, string)', () => {
  const sp = resumirRollout(null, lin(meta(UUID(6), { source: { subagent: { thread_spawn: { parent_thread_id: UUID(1), depth: 1, agent_nickname: 'Ana', agent_role: 'explorer' } } } })));
  assert.equal(sp.fonte, 'subagent');
  assert.deepEqual(sp.subagente, { tipo: 'thread_spawn', pai: UUID(1), apelido: 'Ana', papel: 'explorer' });
  assert.deepEqual(resumirRollout(null, lin(meta(UUID(7), { source: { subagent: { other: 'guardian' } } }))).subagente, { tipo: 'guardian' });
  assert.deepEqual(resumirRollout(null, lin(meta(UUID(8), { source: { subagent: 'review' } }))).subagente, { tipo: 'review' });
});

test('aplicarInatividade e diasParaVarrer', () => {
  const r = { status: 'trabalhando', atividade: 1000, turnoAtivo: 'x' };
  assert.equal(aplicarInatividade(r, { agora: 1000 + 60000, inativoMs: 120000 }), r);
  const v = aplicarInatividade(r, { agora: 1000 + 31 * 60000 });
  assert.equal(v.status, 'interrompida');
  assert.match(v.motivo, /sem atividade/);
  assert.equal(aplicarInatividade({ status: 'concluida', atividade: 1 }, { agora: 1e12 }).status, 'concluida');
  const dias = diasParaVarrer(Date.parse('2026-10-21T12:00:00Z'), 24);
  assert.ok(dias.includes('2026/10/21') && dias.includes('2026/10/20'));
  assert.ok(!dias.includes('2026/10/19'));
});

// ---------- Monitor ----------
test('monitor: novo arquivo, crescimento incremental e só avisa quando muda', () => {
  const home = novaHome();
  const f = arquivo(home, UUID(10), [meta(UUID(10)), ev('task_started', { turn_id: 'a' })]);
  const { m, mudancas, ultimo } = monitor(home);
  m.varrer();
  assert.equal(mudancas.length, 1);
  assert.equal(ultimo().id, UUID(10));
  assert.equal(ultimo().status, 'trabalhando');
  assert.equal(ultimo().arquivo, f);
  m.varrer();
  assert.equal(mudancas.length, 1, 'sem mudança, sem aviso');
  fs.appendFileSync(f, usuario('faça X') + ev('task_complete', { turn_id: 'a', last_agent_message: 'feito' }));
  m.varrer();
  assert.equal(mudancas.length, 2);
  assert.equal(ultimo().status, 'concluida');
  assert.equal(ultimo().pedido, 'faça X');
  assert.equal(m.resumos().length, 1);
  m.parar();
});

test('monitor: lê só os bytes novos (offset por arquivo) e guarda a linha parcial', () => {
  const home = novaHome();
  const aberturas = [];
  const fsEspia = new Proxy(fs, { get: (alvo, k) => (k === 'readSync' ? (fd, buf, off, len, pos) => { aberturas.push({ len, pos }); return alvo.readSync(fd, buf, off, len, pos); } : alvo[k]) });
  const primeira = meta(UUID(11));
  const f = arquivo(home, UUID(11), [primeira]);
  const { m, mudancas, ultimo } = monitor(home, { fs: fsEspia });
  m.varrer();
  const tam1 = Buffer.byteLength(primeira);
  assert.equal(aberturas.length, 1);
  const inteira = ev('task_started', { turn_id: 'p' }) + usuario('mensagem com acentuação ç ã é');
  const [a, b] = [inteira.slice(0, 60), inteira.slice(60)];
  fs.appendFileSync(f, a); // linha cortada no meio
  m.varrer();
  assert.equal(aberturas.at(-1).pos, tam1, 'leu a partir do offset');
  assert.equal(ultimo().status, 'nova', 'linha parcial não conta');
  fs.appendFileSync(f, b);
  m.varrer();
  assert.equal(ultimo().status, 'trabalhando');
  assert.equal(ultimo().pedido, 'mensagem com acentuação ç ã é');
  assert.equal(aberturas.at(-1).pos, tam1 + Buffer.byteLength(a));
  const n = mudancas.length;
  m.varrer();
  assert.equal(mudancas.length, n);
  assert.equal(aberturas.at(-1).pos, tam1 + Buffer.byteLength(a), 'arquivo sem bytes novos nem é reaberto');
  m.parar();
});

test('monitor: UTF-8 cortado no meio de um caractere não corrompe o texto', () => {
  const home = novaHome();
  const linha = usuario('ação');
  const buf = Buffer.from(linha);
  const corte = buf.indexOf(Buffer.from('ç')) + 1; // no meio dos 2 bytes de "ç"
  const f = arquivo(home, UUID(12), [meta(UUID(12))]);
  fs.appendFileSync(f, buf.subarray(0, corte));
  const { m, ultimo } = monitor(home);
  m.varrer();
  fs.appendFileSync(f, buf.subarray(corte));
  m.varrer();
  assert.equal(ultimo().pedido, 'ação');
  m.parar();
});

test('monitor: aborto e linha malformada no meio do arquivo', () => {
  const home = novaHome();
  const f = arquivo(home, UUID(13), [meta(UUID(13)), ev('task_started', { turn_id: 'a' }), '{lixo sem fechar\n', 'texto solto\n', ev('turn_aborted', { turn_id: 'a', reason: 'interrupted' })]);
  const { m, ultimo } = monitor(home);
  m.varrer();
  assert.equal(ultimo().status, 'interrompida');
  assert.equal(ultimo().motivo, 'interrupted');
  fs.appendFileSync(f, ev('task_started', { turn_id: 'b' }));
  m.varrer();
  assert.equal(ultimo().status, 'trabalhando');
  m.parar();
});

test('monitor: inatividade (trabalhando sem escrita há mais de inativoMs vira interrompida)', () => {
  const home = novaHome();
  arquivo(home, UUID(14), [meta(UUID(14)), ev('task_started', { turn_id: 'a' })]);
  let relogio = Date.now();
  const { m, ultimo, mudancas } = monitor(home, { inativoMs: 30 * 60000, agora: () => relogio });
  m.varrer();
  assert.equal(ultimo().status, 'trabalhando');
  relogio += 29 * 60000;
  m.varrer();
  assert.equal(ultimo().status, 'trabalhando');
  assert.equal(mudancas.length, 1);
  relogio += 2 * 60000;
  m.varrer();
  assert.equal(ultimo().status, 'interrompida');
  assert.match(ultimo().motivo, /sem atividade/);
  assert.equal(mudancas.length, 2);
  assert.equal(m.resumos()[0].status, 'interrompida');
  m.parar();
});

test('monitor: uso do plano (rate_limits) chega por aoUso, só quando muda', () => {
  const home = novaHome();
  const tc = (p, s, ts) => ev('token_count', { info: { last_token_usage: { input_tokens: 10 }, model_context_window: 1000 }, rate_limits: { primary: { used_percent: p, window_minutes: 300, resets_at: 1792000000 }, secondary: { used_percent: s, window_minutes: 10080, resets_at: 1792500000 }, plan_type: 'pro' } }, ts);
  const t = Date.now();
  const f = arquivo(home, UUID(15), [meta(UUID(15)), tc(10, 3, t)]);
  const { m, usos } = monitor(home);
  m.varrer(); m.varrer();
  assert.equal(usos.length, 1);
  assert.equal(usos[0].primario.pct, 10);
  assert.equal(usos[0].plano, 'pro');
  fs.appendFileSync(f, tc(11, 3, t + 1000));
  m.varrer();
  assert.equal(usos.length, 2);
  assert.equal(usos[1].primario.pct, 11);
  // outro arquivo com uso mais antigo não substitui o mais novo
  arquivo(home, UUID(16), [meta(UUID(16)), tc(1, 1, t - 60000)]);
  m.varrer();
  assert.equal(usos.length, 2);
  m.parar();
});

test('monitor: guardian é ignorado; outros subagentes vêm com subagente e pai', () => {
  const home = novaHome();
  arquivo(home, UUID(17), [meta(UUID(17), { source: { subagent: { other: 'guardian' } } }), ev('task_started', { turn_id: 'g' })]);
  arquivo(home, UUID(18), [meta(UUID(18), { source: { subagent: { thread_spawn: { parent_thread_id: UUID(19), depth: 1 } } } }), ev('task_started', { turn_id: 's' })]);
  arquivo(home, UUID(19), [meta(UUID(19)), ev('task_started', { turn_id: 'p' })]);
  const { m, mudancas } = monitor(home);
  m.varrer();
  const ids = mudancas.map((r) => r.id).sort();
  assert.deepEqual(ids, [UUID(18), UUID(19)]);
  assert.deepEqual(mudancas.find((r) => r.id === UUID(18)).subagente, { tipo: 'thread_spawn', pai: UUID(19) });
  assert.equal(mudancas.find((r) => r.id === UUID(19)).subagente, null);
  assert.equal(m.resumos().length, 2);
  m.parar();
});

test('monitor: varre o dia anterior (arquivo recente) e ignora dias antigos e arquivos velhos', () => {
  const home = novaHome();
  const ontem = new Date(Date.now() - 20 * 3600000);
  arquivo(home, UUID(20), [meta(UUID(20))], ontem);
  const velhoDir = new Date(Date.now() - 5 * 86400000);
  arquivo(home, UUID(21), [meta(UUID(21))], velhoDir);
  // arquivo de ontem, mas com mtime de 3 dias atrás: fora da janela
  const f = arquivo(home, UUID(22), [meta(UUID(22))], new Date(Date.now() - 22 * 3600000));
  const antigo = new Date(Date.now() - 3 * 86400000);
  fs.utimesSync(f, antigo, antigo);
  const { m, mudancas } = monitor(home);
  m.varrer();
  assert.deepEqual(mudancas.map((r) => r.id), [UUID(20)]);
  m.parar();
});

test('monitor: nunca escreve em home e tolera home inexistente', () => {
  const home = novaHome();
  arquivo(home, UUID(23), [meta(UUID(23))]);
  const proibidos = /write|append|mkdir|rm|unlink|rename|truncate|utimes|chmod|copy|symlink|link/i;
  const chamados = [];
  const fsEspia = new Proxy(fs, { get: (alvo, k) => { if (typeof k === 'string' && proibidos.test(k) && typeof alvo[k] === 'function') return () => { chamados.push(k); throw new Error('escrita proibida'); }; return alvo[k]; } });
  const antes = JSON.stringify(fs.readdirSync(pastaDoDia(home)).map((n) => [n, fs.statSync(path.join(pastaDoDia(home), n)).mtimeMs]));
  const { m, mudancas } = monitor(home, { fs: fsEspia });
  m.varrer(); m.varrer();
  assert.equal(mudancas.length, 1);
  assert.deepEqual(chamados, []);
  assert.equal(JSON.stringify(fs.readdirSync(pastaDoDia(home)).map((n) => [n, fs.statSync(path.join(pastaDoDia(home), n)).mtimeMs])), antes);
  m.parar();
  const vazio = monitor(path.join(raiz, 'nao-existe'));
  assert.doesNotThrow(() => vazio.m.varrer());
  assert.equal(vazio.mudancas.length, 0);
  vazio.m.parar();
});

test('monitor: arquivo que encolhe (recriado) é relido do começo', () => {
  const home = novaHome();
  const f = arquivo(home, UUID(24), [meta(UUID(24)), usuario('um texto bem comprido para ocupar bytes no arquivo'), ev('task_started', { turn_id: 'a' })]);
  const { m, ultimo } = monitor(home);
  m.varrer();
  assert.equal(ultimo().status, 'trabalhando');
  fs.writeFileSync(f, meta(UUID(24)) + ev('task_complete', { turn_id: 'a', last_agent_message: 'z' }));
  m.varrer();
  assert.equal(ultimo().status, 'concluida');
  m.parar();
});

test('monitor: o timer interno varre sozinho e parar() encerra', async () => {
  const home = novaHome();
  arquivo(home, UUID(25), [meta(UUID(25))]);
  const vistos = [];
  const m = criarMonitorRollouts({ home, intervaloMs: 20, aoMudar: (r) => vistos.push(r) });
  const t0 = Date.now();
  while (!vistos.length && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
  assert.equal(vistos[0]?.id, UUID(25));
  m.parar();
  const n = vistos.length;
  arquivo(home, UUID(26), [meta(UUID(26))]);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(vistos.length, n);
});

// ---------- Contra o que o Codex falso grava ----------
test('falso: o monitor entende o rollout gravado pelo Codex falso (turno, comando, aborto, uso)', async () => {
  const home = novaHome();
  const cli = await abrirCodex({
    exe: process.execPath, args: [FALSO, 'app-server'], env: { CODEX_HOME: home, CODEX_FALSO_ATRASO_MS: '5' }, cwd: raiz,
    aoNotificar: (method, params) => { if (method === 'turn/completed') fim.push(params.turn); },
    aoPedir: async () => ({ decision: 'accept' }),
  });
  const fim = [];
  const ate = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('tempo esgotado'); await new Promise((r) => setTimeout(r, 10)); } };
  const { m, ultimo, usos } = monitor(home);
  try {
    const thread = (await cli.pedir('thread/start', { cwd: path.join(raiz, 'projeto-falso') })).thread;
    m.varrer();
    assert.equal(ultimo().id, thread.id);
    assert.equal(ultimo().status, 'nova');
    assert.equal(ultimo().projeto, 'projeto-falso');
    assert.equal(ultimo().originador, 'orbit');
    assert.equal(ultimo().fonte, 'exec');
    assert.equal(ultimo().modelo, 'gpt-5-codex');
    assert.equal(ultimo().esforco, 'medium');

    const texto = (t) => [{ type: 'text', text: t, text_elements: [] }];
    await cli.pedir('turn/start', { threadId: thread.id, input: texto('Rode o teste [comando]') });
    await ate(() => fim.length === 1);
    m.varrer();
    const r = ultimo();
    assert.equal(r.status, 'concluida');
    assert.equal(r.primeira, 'Rode o teste [comando]');
    assert.equal(r.pedido, 'Rode o teste [comando]');
    assert.equal(r.ultimaResposta, 'Comando executado.');
    assert.equal(r.contadores.turnos, 1);
    assert.equal(r.contadores.ferramentas, 1);
    assert.equal(r.ultimaFerramenta.nome, 'CommandExecution');
    assert.equal(r.ultimaFerramenta.alvo, 'echo orbit');
    assert.equal(r.aprovacao, 'on-request');
    assert.equal(r.sandbox, 'workspace-write');
    assert.equal(r.contexto.janela, 258400);
    assert.ok(r.contexto.tokens > 0);
    assert.equal(r.uso.primario.janelaMin, 300);
    assert.equal(r.uso.secundario.janelaMin, 10080);
    assert.equal(r.uso.plano, 'plus');
    assert.ok(r.uso.primario.renova > Date.now());
    assert.ok(usos.length >= 1 && usos.at(-1).primario.pct >= 12);

    // segundo turno: comentário não vira ultimaResposta; interrupção vira 'interrompida'
    const t2 = await cli.pedir('turn/start', { threadId: thread.id, input: texto('Demore [demorar]') });
    await ate(() => { m.varrer(); return ultimo().status === 'trabalhando' && ultimo().turnoAtivo === t2.turn.id && ultimo().contadores.turnos === 2; });
    assert.equal(ultimo().ultimaResposta, 'Comando executado.', 'o comentário do agente não substitui a resposta final');
    assert.equal(ultimo().pedido, 'Demore [demorar]');
    assert.equal(ultimo().primeira, 'Rode o teste [comando]');
    await cli.pedir('turn/interrupt', { threadId: thread.id, turnId: t2.turn.id });
    await ate(() => fim.length === 2);
    m.varrer();
    assert.equal(ultimo().status, 'interrompida');
    assert.equal(ultimo().motivo, 'interrupted');
    assert.equal(ultimo().turnoAtivo, null);
  } finally { m.parar(); await cli.fechar(); }
});
