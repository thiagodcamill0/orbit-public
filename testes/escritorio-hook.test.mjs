// Hook PreToolUse dos escritórios (escritorio-hook.mjs) rodando como processo, com stdin JSON.
// Servidor falso só nas portas 47822–47826 (testes/porta-livre.mjs).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escolherPorta, portaLivre, FAIXA } from './porta-livre.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'escritorio-hook.mjs');

let servidor;
let porta;
let portaMuda; // porta da faixa em que ninguém escuta (servidor "não responde")
let resposta = { permitido: true, limite: 2, ativos: 0 };
let statusResp = { status: 'rodando' };
let consultas = [];
const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');

async function subir() {
  for (let t = 0; t < 8; t++) {
    porta = await escolherPorta(47822);
    servidor = http.createServer((req, res) => {
      consultas.push(req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(/^\/escritorios\/[^/]+\/status/.test(req.url) ? statusResp : resposta));
    });
    const ok = await new Promise((resolve) => {
      servidor.once('error', () => resolve(false));
      servidor.listen(porta, '127.0.0.1', () => resolve(true));
    });
    if (ok) return;
  }
  throw new Error('sem porta livre em 47822–47826');
}

before(async () => {
  await subir();
  for (const p of FAIXA) if (p !== porta && (await portaLivre(p))) { portaMuda = p; break; }
});
after(async () => {
  await new Promise((r) => servidor?.close(r));
});

function rodar(ev, env = {}, bruto) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const filho = spawn(process.execPath, [HOOK], {
      env: { ...process.env, ORBIT_ESCRITORIO: 'esc1', ORBIT_EXECUCAO: 'ex1', ORBIT_PAPEL: 'orquestrador', ORBIT_PORTA: String(porta), ORBIT_EXTERNAS: '[]', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    filho.stdout.on('data', (c) => (out += c));
    filho.stderr.on('data', (c) => (err += c));
    filho.on('close', (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
    filho.stdin.on('error', () => {});
    filho.stdin.end(bruto !== undefined ? bruto : JSON.stringify(ev));
  });
}

const evento = (tool_name, tool_input = {}, extra = {}) => ({
  session_id: 'sessao-orq-1',
  transcript_path: 'x.jsonl',
  cwd: process.cwd(),
  hook_event_name: 'PreToolUse',
  tool_name,
  tool_input,
  tool_use_id: 'toolu_1',
  ...extra,
});

const convidados = () => consultas.filter((u) => u.includes('/convidados'));
const decisao = (out) => JSON.parse(out).hookSpecificOutput;

test('ação externa (Bash) devolve ask com "Ação externa: ..."', async () => {
  const r = await rodar(evento('Bash', { command: 'git push origin main' }));
  assert.equal(r.code, 0);
  const d = decisao(r.out);
  assert.equal(d.hookEventName, 'PreToolUse');
  assert.equal(d.permissionDecision, 'ask');
  assert.equal(d.permissionDecisionReason, 'Ação externa: git push');
  assert.ok(r.ms < 3000, `demorou ${r.ms} ms`);
});

test('ação externa (PowerShell e MCP) devolve ask', async () => {
  let r = await rodar(evento('PowerShell', { command: 'Invoke-RestMethod https://a.com/x -Method Post -Body "a=1"' }));
  assert.equal(decisao(r.out).permissionDecision, 'ask');
  assert.match(decisao(r.out).permissionDecisionReason, /^Ação externa: Invoke-RestMethod/);
  r = await rodar(evento('mcp__claude_ai_Trello__trelloWriteCard', { action: 'create' }));
  assert.equal(decisao(r.out).permissionDecision, 'ask');
  assert.match(decisao(r.out).permissionDecisionReason, /^Ação externa: .*trelloWriteCard/);
  assert.ok(r.ms < 3000);
});

test('extras do ORBIT_EXTERNAS valem (lista e objeto { extras })', async () => {
  for (const ext of [JSON.stringify(['publicar-site']), JSON.stringify({ extras: ['publicar-site'] })]) {
    const r = await rodar(evento('Bash', { command: 'publicar-site prod' }), { ORBIT_EXTERNAS: ext });
    assert.equal(decisao(r.out).permissionDecision, 'ask');
    assert.match(decisao(r.out).permissionDecisionReason, /^Ação externa: padrão extra/);
  }
  const sem = await rodar(evento('Bash', { command: 'publicar-site prod' }), { ORBIT_EXTERNAS: 'isto não é json' });
  assert.equal(sem.out, '');
});

test('nada impresso quando não é externa', async () => {
  for (const [tool, input] of [
    ['Bash', { command: 'git status' }], ['Bash', { command: 'npm test' }], ['Bash', { command: 'git add -A && git commit -m x' }],
    ['Bash', { command: 'git diff | head; git log' }], ['Bash', { command: 'ls -la; cat a; grep -rn x .; rg x' }],
    ['Bash', { command: 'mkdir -p a && cp a b && mv b c' }], ['Bash', { command: 'npm install' }],
    ['Bash', { command: 'npm ci && tsc --noEmit && pytest' }], ['Edit', { file_path: 'src/app.js' }], ['Write', { file_path: 'notas.md' }], ['PowerShell', { command: 'Get-ChildItem' }],
    ['mcp__pixellab__get_balance', {}], ['mcp__claude_ai_Trello__trelloReadBoard', {}], ['Read', { file_path: 'a' }],
  ]) {
    const r = await rodar(evento(tool, input));
    assert.equal(r.code, 0, tool);
    assert.equal(r.out, '', `${tool} ${JSON.stringify(input)}`);
    assert.ok(r.ms < 3000);
  }
});

test('Agent: servidor responde permitido:true → nada impresso, e a consulta leva a sessão', async () => {
  resposta = { escritorio: 'esc1', limite: 2, ativos: 1, permitido: true };
  consultas = [];
  const r = await rodar(evento('Agent', { description: 'x', prompt: 'y', subagent_type: 'general-purpose' }));
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.deepEqual(convidados(), ['/escritorios/convidados?sessao=sessao-orq-1']);
  assert.ok(r.ms < 3000, `demorou ${r.ms} ms`);
});

test('Task também passa pela consulta', async () => {
  resposta = { escritorio: 'esc1', limite: 2, ativos: 0, permitido: true };
  consultas = [];
  const r = await rodar(evento('Task', { prompt: 'y' }));
  assert.equal(r.out, '');
  assert.equal(convidados().length, 1);
});

test('Agent: servidor responde permitido:false → deny com o limite', async () => {
  resposta = { escritorio: 'esc1', limite: 2, ativos: 2, permitido: false };
  const r = await rodar(evento('Agent', { description: 'x', prompt: 'y' }));
  assert.equal(r.code, 0);
  const d = decisao(r.out);
  assert.equal(d.hookEventName, 'PreToolUse');
  assert.equal(d.permissionDecision, 'deny');
  assert.equal(d.permissionDecisionReason, 'Limite de convidados do escritório atingido (2).');
  assert.ok(r.ms < 3000);
});

test('Agent: resposta sem permitido ou com lixo → deny (falha fechada)', async () => {
  resposta = { limite: 1 };
  let r = await rodar(evento('Agent', { prompt: 'y' }));
  assert.equal(decisao(r.out).permissionDecision, 'deny');
  assert.match(decisao(r.out).permissionDecisionReason, /\(1\)/);
  resposta = 'texto solto';
  r = await rodar(evento('Agent', { prompt: 'y' }));
  assert.equal(decisao(r.out).permissionDecision, 'deny');
  resposta = { permitido: true, limite: 2, ativos: 0 };
});

test('Agent: servidor não responde → deny, rápido', async (t) => {
  if (!portaMuda) return t.skip('sem outra porta livre na faixa 47822–47826');
  assert.ok(await portaLivre(portaMuda), 'a porta muda deveria estar livre');
  const r = await rodar(evento('Agent', { prompt: 'y' }), { ORBIT_PORTA: String(portaMuda) });
  assert.equal(r.code, 0);
  const d = decisao(r.out);
  assert.equal(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /^Limite de convidados do escritório atingido \(\d+\)\.$/);
  assert.ok(r.ms < 3000, `demorou ${r.ms} ms`);
});

test('Agent: servidor que aceita e não responde → deny antes de 3 s', async () => {
  const mudo = http.createServer(() => {}); // nunca responde
  let p = null;
  for (const c of FAIXA) {
    if (c === porta || !(await portaLivre(c))) continue;
    if (await new Promise((res) => { mudo.once('error', () => res(false)); mudo.listen(c, '127.0.0.1', () => res(true)); })) { p = c; break; }
  }
  if (!p) return; // faixa ocupada por outros testes: o caso acima já cobre a porta fechada
  try {
    const r = await rodar(evento('Agent', { prompt: 'y' }), { ORBIT_PORTA: String(p) });
    assert.equal(decisao(r.out).permissionDecision, 'deny');
    assert.ok(r.ms < 3000, `demorou ${r.ms} ms`);
  } finally {
    mudo.closeAllConnections?.();
    await new Promise((res) => mudo.close(res));
  }
});

test('Agent: papel diferente de orquestrador → deny sem consultar o servidor', async () => {
  resposta = { permitido: true, limite: 2, ativos: 0 };
  for (const papel of ['designer', 'dev-backend', '', undefined]) {
    consultas = [];
    const env = papel === undefined ? { ORBIT_PAPEL: '' } : { ORBIT_PAPEL: papel };
    const r = await rodar(evento('Agent', { prompt: 'y' }), env);
    assert.equal(decisao(r.out).permissionDecision, 'deny', String(papel));
    assert.match(decisao(r.out).permissionDecisionReason, /convidados/);
    assert.deepEqual(convidados(), []);
  }
});

test('membros continuam sujeitos ao ask de ação externa', async () => {
  const r = await rodar(evento('Bash', { command: 'npm publish' }), { ORBIT_PAPEL: 'designer' });
  assert.equal(decisao(r.out).permissionDecision, 'ask');
});

test('entrada vazia, inválida ou truncada: sai 0 sem imprimir', async () => {
  for (const bruto of ['', '   ', 'não é json', '{"tool_name":"Bash","tool_input":{"command":"git pu']) {
    const r = await rodar(null, {}, bruto);
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.ok(r.ms < 3000);
  }
});

test('tempo total abaixo de 3 s mesmo com comando enorme', async () => {
  const r = await rodar(evento('Bash', { command: 'echo ' + 'a '.repeat(100000) + '; git push' }));
  assert.ok(r.ms < 3000, `demorou ${r.ms} ms`);
  assert.ok(r.out === '' || decisao(r.out).permissionDecision === 'ask');
});

// ── F1: trava reforçada ──
const ask = (r) => {
  assert.equal(r.code, 0);
  const d = decisao(r.out);
  assert.equal(d.permissionDecision, 'ask');
  assert.ok(r.ms < 3000, `demorou ${r.ms} ms`);
  return d.permissionDecisionReason;
};

test('F1: código que a trava não enxerga → ask "Ação externa possível: executa código"', async () => {
  for (const cmd of [
    'node -e "fetch(\'https://a.com/x\',{method:\'POST\'})"', 'python -c "import urllib.request"', 'node scripts/publicar.mjs', 'python3 publicar.py',
    'npm run deploy', "bash <<'EOF'\ngit push\nEOF", 'cat x | sh', 'eval "$X"', 'deno run a.ts',
  ]) {
    assert.match(ask(await rodar(evento('Bash', { command: cmd }))), /^Ação externa possível: executa código/, cmd);
  }
  for (const cmd of ['powershell -EncodedCommand ZQBjAGgAbwA=', 'pwsh -File x.ps1', 'iex $x', 'Start-Process x.exe']) {
    assert.match(ask(await rodar(evento('PowerShell', { command: cmd }))), /^Ação externa possível: executa código/, cmd);
  }
  assert.match(ask(await rodar(evento('Bash', { command: 'git -c alias.p=push p' }))), /^Ação externa/);
  assert.equal(ask(await rodar(evento('Bash', { command: 'npx vercel --prod' }))), 'Ação externa: vercel deploy');
});

test('F1: API do Orbit em loopback é externa; outra porta local não', async () => {
  const r = await rodar(evento('Bash', { command: `curl -X POST http://127.0.0.1:${porta}/escritorios/esc1/liberar` }));
  assert.equal(ask(r), 'Ação externa: API do Orbit');
  const o = await rodar(evento('Bash', { command: `curl -X POST http://127.0.0.1:${porta + 100}/x` }));
  assert.equal(o.out, '');
});

test('F1: Monitor é tratado como Bash', async () => {
  assert.match(ask(await rodar(evento('Monitor', { command: 'until curl -X POST https://api.exemplo.com/x; do sleep 5; done' }))), /^Ação externa/);
  assert.equal((await rodar(evento('Monitor', { command: 'tail -f log.txt' }))).out, '');
});

test('F1: Edit/Write em arquivos da trava → ask; outros arquivos passam', async () => {
  for (const [tool, p] of [['Edit', '.claude/settings.local.json'], ['Write', 'C:\\proj\\.claude\\settings.json'], ['MultiEdit', '.mcp.json'], ['Edit', 'escritorio-hook.mjs'], ['Edit', 'membro.mjs']]) {
    assert.match(ask(await rodar(evento(tool, { file_path: p }))), /^Ação externa/, p);
  }
  assert.equal((await rodar(evento('Edit', { file_path: 'src/x.js' }))).out, '');
});

test('F1: MCP com escrita (sql DELETE) → ask', async () => {
  assert.match(ask(await rodar(evento('mcp__banco__query', { sql: 'DELETE FROM t' }))), /^Ação externa/);
});

test('F1: membro.mjs exato sem rótulo; qualquer variação é rotulada', async () => {
  assert.equal((await rodar(evento('Bash', { command: `node "${RAIZ}/membro.mjs" enviar x y` }))).out, '');
  assert.match(ask(await rodar(evento('Bash', { command: 'node outro/membro.mjs enviar x y' }))), /executa código/);
});

test('F1: escritório pausado → deny em Bash, Write, Agent e MCP', async () => {
  statusResp = { status: 'pausada' };
  try {
    for (const [tool, input] of [['Bash', { command: 'ls' }], ['Write', { file_path: 'a.txt' }], ['Agent', { prompt: 'y' }], ['mcp__pixellab__get_balance', {}]]) {
      const r = await rodar(evento(tool, input));
      assert.equal(r.code, 0);
      const d = decisao(r.out);
      assert.equal(d.permissionDecision, 'deny', tool);
      assert.match(d.permissionDecisionReason, /^Escritório pausado/);
      assert.ok(r.ms < 3000);
    }
  } finally {
    statusResp = { status: 'rodando' };
  }
});

test('F1: o status é consultado pelo id do escritório', async () => {
  consultas = [];
  await rodar(evento('Bash', { command: 'ls' }), { ORBIT_ESCRITORIO: 'esc9' });
  assert.ok(consultas.includes('/escritorios/esc9/status'), JSON.stringify(consultas));
});

test('F1: servidor fora → ask em Bash/MCP e deny em Agent', async (t) => {
  if (!portaMuda) return t.skip('sem outra porta livre na faixa 47822–47826');
  const env = { ORBIT_PORTA: String(portaMuda) };
  assert.equal(ask(await rodar(evento('Bash', { command: 'ls' }), env)), 'Ação externa: a trava não conseguiu avaliar');
  assert.match(ask(await rodar(evento('mcp__pixellab__get_balance', {}), env)), /^Ação externa: a trava não conseguiu avaliar/);
  const r = await rodar(evento('Agent', { prompt: 'y' }), env);
  assert.equal(decisao(r.out).permissionDecision, 'deny');
  assert.ok(r.ms < 3000);
});

test('F1: servidor que aceita e não responde → ask no Bash, deny no Agent, antes de 3 s', async () => {
  const mudo = http.createServer(() => {});
  let p = null;
  for (const c of FAIXA) {
    if (c === porta || !(await portaLivre(c))) continue;
    if (await new Promise((res) => { mudo.once('error', () => res(false)); mudo.listen(c, '127.0.0.1', () => res(true)); })) { p = c; break; }
  }
  if (!p) return;
  try {
    const env = { ORBIT_PORTA: String(p) };
    assert.match(ask(await rodar(evento('Bash', { command: 'ls' }), env)), /não conseguiu avaliar/);
    const r = await rodar(evento('Agent', { prompt: 'y' }), env);
    assert.equal(decisao(r.out).permissionDecision, 'deny');
    assert.ok(r.ms < 3000, `demorou ${r.ms} ms`);
  } finally {
    mudo.closeAllConnections?.();
    await new Promise((res) => mudo.close(res));
  }
});
