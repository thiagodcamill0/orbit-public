// Testes do cliente JSON-RPC do Codex (codex-rpc.mjs) contra o Codex falso (testes/codex-falso.mjs), só stdio:
// nunca o codex real, nunca ~/.codex (CODEX_HOME é uma pasta temporária, apagada no fim). Rodar:
//   node --test testes/codex-rpc.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { abrirCodex, METODOS_PERMITIDOS, PEDIDOS_DO_SERVIDOR_ACEITOS } from '../codex-rpc.mjs';

const FALSO = fileURLToPath(new URL('./codex-falso.mjs', import.meta.url));
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-codex-rpc-'));
after(() => { fs.rmSync(raiz, { recursive: true, force: true }); });

const texto = (t) => [{ type: 'text', text: t, text_elements: [] }];
const lerJsonl = (arq) => { try { return fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
async function ate(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) { const r = fn(); if (r) return r; if (Date.now() - t0 > ms) throw new Error('tempo esgotado esperando a condição'); await new Promise((r2) => setTimeout(r2, 10)); }
}
function rollouts(home) {
  const r = [];
  const andar = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) andar(p); else if (/^rollout-.*\.jsonl$/.test(e.name)) r.push(p); } };
  andar(path.join(home, 'sessions'));
  return r;
}

// Sobe o falso com um CODEX_HOME novo; `aoPedir` é trocável por teste; sempre fecha no fim.
async function comCodex(fn, { aoPedir, home = fs.mkdtempSync(path.join(raiz, 'h-')), ...resto } = {}) {
  const notifs = [], pedidos = [], logs = [];
  const ctx = { home, notifs, pedidos, logs, log: () => lerJsonl(path.join(home, 'falso-log.jsonl')) };
  ctx.aoPedir = aoPedir || (async (m) => { throw Object.assign(new Error('sem resposta'), { code: -1 }); });
  const cli = await abrirCodex({
    exe: process.execPath, args: [FALSO, 'app-server'], env: { CODEX_HOME: home }, cwd: raiz,
    aoNotificar: (method, params) => notifs.push({ method, params }),
    aoPedir: async (method, params) => { pedidos.push({ method, params }); return ctx.aoPedir(method, params); },
    log: (t, d) => logs.push([t, d]), ...resto,
  });
  ctx.cli = cli;
  try { return await fn(ctx); } finally { await cli.fechar(); }
}
const novaThread = async (c, p = {}) => (await c.cli.pedir('thread/start', { cwd: raiz, ...p })).thread;
const turno = (c, thread, t) => c.cli.pedir('turn/start', { threadId: thread.id, input: texto(t) });
const fimDoTurno = (c, id) => ate(() => c.notifs.find((n) => n.method === 'turn/completed' && n.params.turn.id === id));

test('constantes: a lista fechada da decisão, congelada', () => {
  assert.deepEqual([...METODOS_PERMITIDOS].sort(), ['account/rateLimits/read', 'account/read', 'config/read', 'initialize', 'mcpServerStatus/list', 'model/list', 'thread/compact/start', 'thread/list', 'thread/read', 'thread/resume', 'thread/start', 'thread/unsubscribe', 'turn/interrupt', 'turn/start']);
  assert.deepEqual([...PEDIDOS_DO_SERVIDOR_ACEITOS].sort(), ['applyPatchApproval', 'execCommandApproval', 'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput']);
  assert.ok(Object.isFrozen(METODOS_PERMITIDOS) && Object.isFrozen(PEDIDOS_DO_SERVIDOR_ACEITOS));
});

test('handshake: initialize com clientInfo do Orbit e depois initialized, sem campo jsonrpc', async () => {
  await comCodex(async (c) => {
    assert.match(c.cli.info.userAgent, /orbit|falso/);
    assert.equal(c.cli.info.codexHome, c.home);
    assert.ok(c.cli.pid > 0);
    const l = await ate(() => { const x = c.log(); return x.length >= 2 && x; });
    assert.deepEqual(l.slice(0, 2).map((x) => x.method), ['initialize', 'initialized']);
    assert.equal(l[0].id, 1);
    assert.equal(l[1].id, undefined, 'initialized é notificação (sem id)');
  });
});

test('o clientInfo enviado é name orbit, title Orbit e a versão do package', async () => {
  // O falso ecoa o initialize cru no log só pelo método; confere o clientInfo com um servidor mínimo.
  const eco = path.join(raiz, 'eco.mjs');
  fs.writeFileSync(eco, `import rl from 'node:readline';
rl.createInterface({ input: process.stdin }).on('line', (l) => { const m = JSON.parse(l);
  if (m.method === 'initialize') process.stdout.write(JSON.stringify({ id: m.id, result: { eco: m, bruto: l } }) + '\\n'); });`);
  const c = await abrirCodex({ exe: process.execPath, args: [eco], versao: '9.9.9' });
  try {
    assert.deepEqual(c.info.eco.params, { clientInfo: { name: 'orbit', title: 'Orbit', version: '9.9.9' } });
    assert.ok(!('jsonrpc' in c.info.eco), 'sem jsonrpc');
  } finally { await c.fechar(); }
  const padrao = await abrirCodex({ exe: process.execPath, args: [eco] });
  try { assert.match(padrao.info.eco.params.clientInfo.version, /^\d+\.\d+\.\d+/); } finally { await padrao.fechar(); }
});

test('cada método permitido responde e o falso registra todos', async () => {
  await comCodex(async (c) => {
    const t = await novaThread(c, { model: 'gpt-5', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    assert.match(t.id, /^[0-9a-f-]{36}$/);
    assert.equal(t.cwd, raiz);
    await ate(() => c.notifs.find((n) => n.method === 'thread/started' && n.params.thread.id === t.id));

    const ini = await turno(c, t, 'oi');
    assert.equal(ini.turn.status, 'inProgress');
    const fim = await fimDoTurno(c, ini.turn.id);
    assert.equal(fim.params.turn.status, 'completed');
    assert.ok(c.notifs.some((n) => n.method === 'item/agentMessage/delta' && n.params.itemId));
    assert.ok(c.notifs.some((n) => n.method === 'item/completed' && n.params.item.type === 'agentMessage' && n.params.item.text.includes('Codex falso')));
    const uso = c.notifs.find((n) => n.method === 'thread/tokenUsage/updated').params.tokenUsage;
    assert.ok(uso.total.totalTokens > 0 && uso.modelContextWindow > 0);

    const lista = await c.cli.pedir('thread/list', { limit: 10 });
    assert.ok(lista.data.some((x) => x.id === t.id && x.preview === 'oi'));
    const lida = await c.cli.pedir('thread/read', { threadId: t.id, includeTurns: true });
    assert.equal(lida.thread.turns.length, 1);
    assert.deepEqual(lida.thread.turns[0].items.map((i) => i.type), ['userMessage', 'agentMessage']);
    const ret = await c.cli.pedir('thread/resume', { threadId: t.id });
    assert.equal(ret.thread.id, t.id);
    assert.equal(ret.sandbox.type, 'workspaceWrite');

    const m = await c.cli.pedir('model/list', {});
    assert.ok(m.data.length >= 2 && m.data.length <= 3);
    assert.equal(m.data.filter((x) => x.isDefault).length, 1);
    assert.ok(m.data.every((x) => x.supportedReasoningEfforts.length > 0 && x.supportedReasoningEfforts[0].reasoningEffort));
    const conta = await c.cli.pedir('account/read', {});
    assert.equal(conta.account.type, 'chatgpt');
    assert.equal(conta.requiresOpenaiAuth, false);
    const lim = await c.cli.pedir('account/rateLimits/read');
    assert.equal(lim.rateLimits.primary.windowDurationMins, 300);
    assert.equal(lim.rateLimits.secondary.windowDurationMins, 10080);
    assert.ok(lim.rateLimits.primary.usedPercent > 12, 'o turno consumiu um pouco do limite');

    const I = await turno(c, t, '[demorar]');
    await c.cli.pedir('turn/interrupt', { threadId: t.id, turnId: I.turn.id });
    await c.cli.pedir('thread/compact/start', { threadId: t.id });
    await fimDoTurno(c, I.turn.id);
    // C1: leituras da falha fechada do escritório e o unsubscribe
    const cr = await c.cli.pedir('config/read', { cwd: process.cwd() });
    assert.ok(cr.config && typeof cr.config === 'object');
    const ms = await c.cli.pedir('mcpServerStatus/list', { threadId: t.id, detail: 'toolsAndAuthOnly' });
    assert.ok(Array.isArray(ms.data));
    assert.equal((await c.cli.pedir('thread/unsubscribe', { threadId: t.id })).status, 'unsubscribed');

    const recebidos = new Set(c.log().filter((x) => x.dir === 'recebido').map((x) => x.method));
    for (const mt of METODOS_PERMITIDOS) assert.ok(recebidos.has(mt), `o falso não recebeu ${mt}`);
    assert.ok(!c.log().some((x) => x.fora_da_lista), 'nada fora da lista chegou ao falso');
  });
});

test('método fora da lista: recusa local, nada é enviado ao processo', async () => {
  await comCodex(async (c) => {
    const antes = (await ate(() => { const x = c.log(); return x.length >= 2 && x; })).length; // initialize + initialized
    for (const m of ['thread/delete', 'thread/fork', 'command/exec', 'fs/readFile', 'config/value/write', 'initialized', 'item/tool/call', '']) {
      await assert.rejects(c.cli.pedir(m, {}), (e) => e.codigo === 'FORA_DA_LISTA' && e.method === m);
    }
    await assert.rejects(c.cli.pedir('toString'), (e) => e.codigo === 'FORA_DA_LISTA');
    // um pedido válido depois prova que o canal segue vivo, e o log só ganha ele
    await c.cli.pedir('model/list', {});
    const novos = (await ate(() => { const x = c.log(); return x.length > antes && x; })).slice(antes);
    assert.deepEqual(novos.map((x) => x.method), ['model/list']);
  });
});

test('o próprio falso responde -32601 a método desconhecido e registra (protocolo cru)', async () => {
  const home = fs.mkdtempSync(path.join(raiz, 'h-'));
  const p = spawn(process.execPath, [FALSO, 'app-server'], { env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const respostas = [];
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { respostas.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const env = (o) => p.stdin.write(JSON.stringify(o) + '\n');
  try {
    env({ id: 1, method: 'model/list', params: {} });          // antes do initialize
    env({ id: 2, method: 'initialize', params: { clientInfo: { name: 't', version: '1' } } });
    env({ id: 3, method: 'initialize', params: { clientInfo: { name: 't', version: '1' } } });
    env({ method: 'initialized' });
    env({ id: 4, method: 'thread/delete', params: {} });
    await ate(() => respostas.length >= 4);
    const por = Object.fromEntries(respostas.map((r) => [r.id, r]));
    assert.equal(por[1].error.code, -32002, 'sem initialize: Not initialized');
    assert.ok(por[2].result);
    assert.equal(por[3].error.message, 'Already initialized');
    assert.equal(por[4].error.code, -32601);
    assert.ok(!('jsonrpc' in por[4]));
    const reg = lerJsonl(path.join(home, 'falso-log.jsonl'));
    assert.ok(reg.some((x) => x.method === 'thread/delete' && x.fora_da_lista === true));
  } finally { p.stdin.end(); await new Promise((r) => p.once('exit', r)); }
});

test('pedido do servidor fora da lista: erro -32601 sem chamar aoPedir', async () => {
  await comCodex(async (c) => {
    const t = await novaThread(c);
    const ini = await turno(c, t, '[proibido] faz isso');
    const fim = await fimDoTurno(c, ini.turn.id);
    assert.equal(fim.params.turn.status, 'completed');
    assert.ok(!c.pedidos.some((p) => p.method === 'item/tool/call'), 'aoPedir não foi chamado');
    assert.equal(c.pedidos.length, 0);
    const r = c.log().find((x) => x.dir === 'resposta-do-cliente' && x.method === 'item/tool/call');
    assert.equal(r.error.code, -32601);
    const msg = fim.params.turn.items.find((i) => i.type === 'agentMessage').text;
    assert.match(msg, /recusado \(-32601\)/);
    assert.ok(c.logs.some(([tipo, d]) => tipo === 'pedido-recusado' && d.method === 'item/tool/call'));
  }, { aoPedir: async () => ({ ok: true }) });
});

test('aprovação de comando: aceita executa, recusada segue, cancelar interrompe', async () => {
  let decisao = 'accept';
  await comCodex(async (c) => {
    const t = await novaThread(c);
    const a = await turno(c, t, '[comando] rode');
    const fa = await fimDoTurno(c, a.turn.id);
    const ped = c.pedidos.find((p) => p.method === 'item/commandExecution/requestApproval');
    assert.equal(ped.params.threadId, t.id);
    assert.equal(ped.params.command, 'echo orbit');
    assert.deepEqual(fa.params.turn.items.map((i) => i.type), ['userMessage', 'commandExecution', 'agentMessage']);
    assert.equal(fa.params.turn.items[1].status, 'completed');
    assert.match(fa.params.turn.items[2].text, /executado/);

    decisao = 'decline';
    const b = await turno(c, t, '[comando] de novo');
    const fb = await fimDoTurno(c, b.turn.id);
    assert.equal(fb.params.turn.status, 'completed');
    assert.equal(fb.params.turn.items.find((i) => i.type === 'commandExecution').status, 'declined');
    assert.match(fb.params.turn.items.at(-1).text, /recusado/);

    decisao = 'cancel';
    const d = await turno(c, t, '[comando] cancela');
    assert.equal((await fimDoTurno(c, d.turn.id)).params.turn.status, 'interrupted');
    const regs = c.log().filter((x) => x.dir === 'resposta-do-cliente' && x.method === 'item/commandExecution/requestApproval');
    assert.deepEqual(regs.map((x) => x.result.decision), ['accept', 'decline', 'cancel']);
  }, { aoPedir: async () => ({ decision: decisao }) });
});

test('aprovação de arquivo: aceita grava, recusada segue', async () => {
  let decisao = 'accept';
  await comCodex(async (c) => {
    const t = await novaThread(c);
    const a = await turno(c, t, '[arquivo] grave');
    const fa = await fimDoTurno(c, a.turn.id);
    assert.ok(c.pedidos.some((p) => p.method === 'item/fileChange/requestApproval'));
    assert.equal(fa.params.turn.items.find((i) => i.type === 'fileChange').status, 'completed');
    decisao = 'decline';
    const b = await turno(c, t, '[arquivo] outra vez');
    const fb = await fimDoTurno(c, b.turn.id);
    assert.equal(fb.params.turn.items.find((i) => i.type === 'fileChange').status, 'declined');
    assert.match(fb.params.turn.items.at(-1).text, /recusado/);
  }, { aoPedir: async () => ({ decision: decisao }) });
});

test('erro no tratador vira erro JSON-RPC -32603 para o servidor e o turno segue', async () => {
  await comCodex(async (c) => {
    const t = await novaThread(c);
    const a = await turno(c, t, '[comando] x');
    const f = await fimDoTurno(c, a.turn.id);
    assert.equal(f.params.turn.status, 'completed');
    const r = c.log().find((x) => x.dir === 'resposta-do-cliente');
    assert.equal(r.error.code, -1, 'o código do erro do tratador é repassado');
  });
  await comCodex(async (c) => {
    const t = await novaThread(c);
    const a = await turno(c, t, '[comando] x');
    await fimDoTurno(c, a.turn.id);
    assert.equal(c.log().find((x) => x.dir === 'resposta-do-cliente').error.code, -32603);
  }, { aoPedir: async () => { throw new Error('quebrou'); } });
});

test('pergunta ao usuário: a resposta volta ao servidor', async () => {
  await comCodex(async (c) => {
    const t = await novaThread(c);
    const a = await turno(c, t, '[pergunta] cor?');
    const f = await fimDoTurno(c, a.turn.id);
    const ped = c.pedidos.find((p) => p.method === 'item/tool/requestUserInput');
    assert.equal(ped.params.questions[0].id, 'q1');
    assert.ok(ped.params.questions[0].options.length >= 2);
    assert.match(f.params.turn.items.at(-1).text, /Resposta recebida: verde/);
  }, { aoPedir: async () => ({ answers: { q1: { answers: ['verde'] } } }) });
});

test('interrupt: o turno longo termina interrupted e o rollout ganha turn_aborted', async () => {
  await comCodex(async (c) => {
    const t = await novaThread(c);
    const a = await turno(c, t, '[demorar]');
    await ate(() => c.notifs.some((n) => n.method === 'turn/started'));
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!c.notifs.some((n) => n.method === 'turn/completed'), 'ainda rodando');
    await c.cli.pedir('turn/interrupt', { threadId: t.id, turnId: a.turn.id });
    const f = await fimDoTurno(c, a.turn.id);
    assert.equal(f.params.turn.status, 'interrupted');
    await assert.rejects(c.cli.pedir('turn/interrupt', { threadId: t.id, turnId: a.turn.id }), (e) => /não está em andamento/.test(e.message) && e.codigo === -32600);
    const evs = lerJsonl(rollouts(c.home)[0]).filter((l) => l.type === 'event_msg').map((l) => l.payload);
    const ab = evs.find((e) => e.type === 'turn_aborted');
    assert.equal(ab.reason, 'interrupted');
    assert.ok(!evs.some((e) => e.type === 'task_complete'));
    // depois de interrompido, outro turno funciona
    const b = await turno(c, t, 'segue');
    assert.equal((await fimDoTurno(c, b.turn.id)).params.turn.status, 'completed');
  });
});

test('compactar: thread/compacted e o uso de tokens cai', async () => {
  await comCodex(async (c) => {
    const t = await novaThread(c);
    for (const m of ['um texto razoável para gastar tokens', 'outro']) { const x = await turno(c, t, m); await fimDoTurno(c, x.turn.id); }
    const antes = c.notifs.filter((n) => n.method === 'thread/tokenUsage/updated').at(-1).params.tokenUsage.total.totalTokens;
    assert.deepEqual(await c.cli.pedir('thread/compact/start', { threadId: t.id }), {});
    const comp = await ate(() => c.notifs.find((n) => n.method === 'thread/compacted'));
    assert.equal(comp.params.threadId, t.id);
    const depois = await ate(() => { const u = c.notifs.filter((n) => n.method === 'thread/tokenUsage/updated'); return u.length >= 3 && u.at(-1).params.tokenUsage.total.totalTokens; });
    assert.ok(depois < antes / 2, `${depois} deveria ser bem menor que ${antes}`);
    assert.ok(lerJsonl(rollouts(c.home)[0]).some((l) => l.type === 'compacted'));
    await assert.rejects(c.cli.pedir('thread/compact/start', { threadId: 'nao-existe' }), (e) => e.codigo === -32600);
  });
});

test('rollouts: formato do codex-plano (session_meta, turn_context, event_msg, response_item)', async () => {
  await comCodex(async (c) => {
    const t = await novaThread(c);
    const a = await turno(c, t, 'olá codex');
    await fimDoTurno(c, a.turn.id);
    const arqs = rollouts(c.home);
    assert.equal(arqs.length, 1);
    const rel = path.relative(path.join(c.home, 'sessions'), arqs[0]).split(path.sep);
    assert.match(rel[0], /^\d{4}$/); assert.match(rel[1], /^\d{2}$/); assert.match(rel[2], /^\d{2}$/);
    assert.match(rel[3], new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${t.id}\\.jsonl$`));
    assert.equal(t.path, arqs[0]);

    const ls = lerJsonl(arqs[0]);
    assert.ok(ls.every((l, i) => l.ordinal === i && l.timestamp && l.type && l.payload), 'timestamp, ordinal sequencial, type, payload');
    const meta = ls[0];
    assert.equal(meta.type, 'session_meta');
    assert.equal(meta.payload.id, t.id);
    assert.equal(meta.payload.cwd, raiz);
    for (const k of ['session_id', 'originator', 'cli_version', 'source', 'thread_source', 'model_provider']) assert.ok(meta.payload[k], k);
    const ctx = ls.find((l) => l.type === 'turn_context').payload;
    assert.equal(ctx.turn_id, a.turn.id);
    assert.equal(ctx.approval_policy, 'on-request');
    assert.equal(ctx.sandbox_policy.type, 'workspace-write');
    assert.deepEqual(ctx.sandbox_policy.writable_roots, [raiz]);
    assert.ok(ctx.model && ctx.effort);

    const ev = ls.filter((l) => l.type === 'event_msg').map((l) => l.payload);
    assert.deepEqual(ev.map((e) => e.type), ['thread_settings_applied', 'task_started', 'item_completed', 'item_completed', 'token_count', 'task_complete']);
    assert.equal(ev[1].turn_id, a.turn.id);
    assert.ok(ev[1].model_context_window > 0);
    assert.deepEqual(ev.filter((e) => e.type === 'item_completed').map((e) => e.item.type), ['UserMessage', 'AgentMessage']);
    const tc = ev.find((e) => e.type === 'token_count');
    for (const k of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']) {
      assert.equal(typeof tc.info.total_token_usage[k], 'number', k);
      assert.equal(typeof tc.info.last_token_usage[k], 'number', k);
    }
    assert.ok(tc.info.model_context_window > 0);
    for (const j of ['primary', 'secondary']) {
      assert.equal(typeof tc.rate_limits[j].used_percent, 'number');
      assert.ok(tc.rate_limits[j].window_minutes > 0 && tc.rate_limits[j].resets_at > 0);
    }
    assert.equal(tc.rate_limits.plan_type, 'plus');
    const tk = ev.find((e) => e.type === 'task_complete');
    assert.equal(tk.turn_id, a.turn.id);
    assert.ok(tk.last_agent_message.includes('falso') && tk.duration_ms >= 0);
    const msgs = ls.filter((l) => l.type === 'response_item').map((l) => `${l.payload.role}:${l.payload.content[0].text}`);
    assert.equal(msgs[0], 'user:olá codex');
    assert.match(msgs[1], /^assistant:/);
  });
});

test('retomar depois de reiniciar o falso: thread/list e thread/resume leem o rollout em disco', async () => {
  const home = fs.mkdtempSync(path.join(raiz, 'h-'));
  let id;
  await comCodex(async (c) => { const t = await novaThread(c); id = t.id; const a = await turno(c, t, 'primeira'); await fimDoTurno(c, a.turn.id); }, { home });
  await comCodex(async (c) => {
    const lista = await c.cli.pedir('thread/list', {});
    assert.deepEqual(lista.data.map((x) => x.id), [id]);
    assert.equal(lista.data[0].preview, 'primeira');
    const r = await c.cli.pedir('thread/resume', { threadId: id });
    assert.equal(r.thread.id, id);
    const a = await turno(c, r.thread, 'segunda');
    assert.equal((await fimDoTurno(c, a.turn.id)).params.turn.status, 'completed');
    assert.equal(rollouts(home).length, 1, 'continua no mesmo rollout');
    assert.ok(lerJsonl(rollouts(home)[0]).filter((l) => l.type === 'event_msg' && l.payload.type === 'task_started').length === 2);
    await assert.rejects(c.cli.pedir('thread/resume', { threadId: 'x' }), (e) => e.codigo === -32600);
  }, { home });
});

test('saída do processo com pedido pendente: rejeita, avisa e novos pedidos falham', async () => {
  let saida = null;
  await comCodex(async (c) => {
    const t = await novaThread(c);
    const pendente = c.cli.pedir('turn/start', { threadId: t.id, input: texto('[morrer]') });
    const lento = c.cli.pedir('model/list', {}, { timeoutMs: 5000 });
    lento.catch(() => {});
    await assert.rejects(pendente, (e) => e.codigo === 'CODEX_SAIU' && e.method === 'turn/start');
    const r = await c.cli.saida;
    assert.equal(r.codigo, 3);
    assert.equal(c.cli.saiu, true);
    assert.deepEqual(saida, r, 'aoSair recebeu o mesmo resultado');
    await assert.rejects(c.cli.pedir('model/list', {}), (e) => e.codigo === 'CODEX_SAIU');
    assert.deepEqual(await c.cli.fechar(), r, 'fechar depois da saída é idempotente');
  }, { aoSair: (r) => { saida = r; } });
});

test('timeout por pedido e do handshake; exe inexistente', async () => {
  const mudo = path.join(raiz, 'mudo.mjs');
  fs.writeFileSync(mudo, 'setInterval(() => {}, 1000);');
  // handshake sem resposta
  const t0 = Date.now();
  await assert.rejects(abrirCodex({ exe: process.execPath, args: [mudo], timeoutInicioMs: 200 }), (e) => e.codigo === 'TIMEOUT' && e.method === 'initialize');
  assert.ok(Date.now() - t0 < 4000, 'o processo mudo foi encerrado, não ficou esperando');
  // pedido com timeout menor que a demora do servidor: o servidor responde o initialize e depois fica mudo
  const meio = path.join(raiz, 'meio.mjs');
  fs.writeFileSync(meio, `import rl from 'node:readline';
rl.createInterface({ input: process.stdin }).on('line', (l) => { const m = JSON.parse(l); if (m.method === 'initialize') process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\\n'); });`);
  const c = await abrirCodex({ exe: process.execPath, args: [meio], timeoutMs: 150 });
  try {
    await assert.rejects(c.pedir('model/list'), (e) => e.codigo === 'TIMEOUT' && e.method === 'model/list');
    await assert.rejects(c.pedir('model/list', {}, { timeoutMs: 50 }), (e) => e.codigo === 'TIMEOUT');
  } finally { await c.fechar(); }
  await assert.rejects(abrirCodex({ exe: path.join(raiz, 'nao-existe.exe') }), (e) => e.codigo === 'SPAWN');
  await assert.rejects(abrirCodex({}), (e) => e.codigo === 'SEM_EXE');
});

test('fechar encerra o processo e rejeita o que estava pendente', async () => {
  const home = fs.mkdtempSync(path.join(raiz, 'h-'));
  const c = await abrirCodex({ exe: process.execPath, args: [FALSO, 'app-server'], env: { CODEX_HOME: home } });
  const t = (await c.pedir('thread/start', { cwd: raiz })).thread;
  await c.pedir('turn/start', { threadId: t.id, input: texto('[demorar]') });
  const r = await c.fechar();
  assert.ok(r.codigo === 0 || r.sinal, 'saiu');
  assert.equal(c.saiu, true);
  await assert.rejects(c.pedir('model/list'), (e) => e.codigo === 'CODEX_SAIU');
});

test('cada instância usa o próprio CODEX_HOME; sem CODEX_HOME o falso se recusa a rodar', async () => {
  const a = fs.mkdtempSync(path.join(raiz, 'h-')), b = fs.mkdtempSync(path.join(raiz, 'h-'));
  await comCodex(async (c) => { await novaThread(c); }, { home: a });
  await comCodex(async () => {}, { home: b });
  assert.equal(rollouts(a).length, 1);
  assert.equal(rollouts(b).length, 0);
  const env = { ...process.env }; delete env.CODEX_HOME;
  await new Promise((res) => {
    const p = spawn(process.execPath, [FALSO], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => { assert.equal(code, 2); assert.match(err, /CODEX_HOME/); res(); });
  });
});
