// Testes das regras de permissão: a regra ampla do "Permitir sempre" (controle.mjs) e o regras.mjs
// (Configurações). Rodar:  node testes/regras.test.mjs
// Só pastas temporárias: a "pasta pessoal" é falsa e nenhum .claude de verdade é lido ou gravado.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ampliarComando, ampliarSugestao, atualizacoesDe, sugestoesDe } from '../controle.mjs';
import { criarRegras } from '../regras.mjs';

// ───────────────────────── regra ampla do cartão ─────────────────────────
test('ampliarComando: só comando de execução vira prefixo com " *"', () => {
  const casos = {
    'node testes/fumaca.mjs': 'node testes/fumaca.mjs *',
    'python -m pytest tests/x.py': 'python -m pytest *',
    'npm test': 'npm test *',
    'npm run lint -- --fix': 'npm run lint *',
    'cargo build --release': 'cargo build *',
    'go vet ./...': 'go vet *',
    // O prefixo que o próprio claude sugere passa como veio.
    'git diff:*': 'git diff *',
    'git status *': 'git status *',
  };
  for (const [c, esperado] of Object.entries(casos)) assert.equal(ampliarComando(c).regra, esperado, c);
  assert.equal(ampliarComando('npm test -- x').base, 'npm test');
});

test('ampliarComando: comando de leitura fica exato (e marcado como leitura)', () => {
  for (const c of [
    'git diff --stat HEAD~1', 'git status', 'git log --oneline -5', 'git diff --output=x.txt', 'ls -la src', 'cat a.txt',
    'rg --pre x foo', 'tree -o saida.txt', 'Get-ChildItem -Recurse assets', 'Get-Content index.html -TotalCount 5',
    'npm ls', 'cargo tree', 'pip list', 'echo oi',
  ]) {
    const a = ampliarComando(c);
    assert.equal(a.ampla, false, c);
    assert.equal(a.regra, c, c);
    assert.equal(a.leitura, true, c);
  }
  for (const c of ['gh pr view 12', 'gh pr merge 12', 'docker ps', 'docker build .']) assert.equal(ampliarComando(c).ampla, false, c);
});

test('ampliarComando: o que altera, apaga, instala, faz push ou reinicia fica exato', () => {
  for (const c of [
    'rm -rf build', 'Remove-Item a.txt', 'git push origin main', 'git reset --hard', 'git commit -m x', 'git checkout -- a',
    'git branch -D x', 'npm install left-pad', 'npm i', 'pip install x', 'cargo publish', 'npm run deploy', 'npm start',
    'Stop-Process -Id 1', 'taskkill /pid 1', 'Set-Content a.txt x', 'docker run x', 'curl https://x', 'mv a b', 'cp a b',
    'git status && rm a', 'cat a > b', 'Get-ChildItem | Remove-Item', 'node -e "1"', 'FOO=1 node x.mjs', 'powershell -Command x',
    'git -C pasta status', 'sed -i s/a/b/ x', 'find . -delete', 'Restart-Service x', 'Invoke-WebRequest x',
    'ri a.txt', 'ni x', 'mkdir x', 'touch x', 'irm http://127.0.0.1:47821/desligar', 'iniciar.cmd', 'npm run prod-build',
  ]) {
    const a = ampliarComando(c);
    assert.equal(a.ampla, false, c);
    assert.equal(a.regra, c, c);
  }
});

test('ampliarSugestao: regra de terminal ampla, no projeto, com o que libera', () => {
  const sg = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test -- --watch=false' }], behavior: 'allow', destination: 'localSettings' };
  const { sg: nova, libera } = ampliarSugestao(sg);
  assert.deepEqual(nova.rules, [{ toolName: 'Bash', ruleContent: 'npm test *' }]);
  assert.equal(nova.destination, 'localSettings');
  assert.match(libera, /npm test com qualquer argumento/);
  assert.match(libera, /neste projeto/);
  // Global vira projeto.
  assert.equal(ampliarSugestao({ ...sg, destination: 'userSettings' }).sg.destination, 'localSettings');
  // Comando arriscado: exato, e o texto avisa.
  const r = ampliarSugestao({ ...sg, rules: [{ toolName: 'PowerShell', ruleContent: 'Remove-Item a.txt' }] });
  assert.equal(r.sg.rules[0].ruleContent, 'Remove-Item a.txt');
  assert.match(r.libera, /só Remove-Item a\.txt \(variações seguem pedindo\)/);
  // Leitura: exata, e o texto diz por quê; nada de negação junto.
  const l = ampliarSugestao({ ...sg, rules: [{ toolName: 'Bash', ruleContent: 'git diff --output=x.txt' }] });
  assert.deepEqual(l.sg.rules, [{ toolName: 'Bash', ruleContent: 'git diff --output=x.txt' }]);
  assert.match(l.libera, /comando de leitura: o Orbit não amplia/);
  assert.equal(atualizacoesDe(l.sg).length, 1);
  // Duas regras que viram a mesma: uma só.
  const d = ampliarSugestao({ ...sg, rules: [{ toolName: 'Bash', ruleContent: 'cargo build' }, { toolName: 'Bash', ruleContent: 'cargo build --release' }] });
  assert.equal(d.sg.rules.length, 1);
  // Outras ferramentas passam iguais.
  const w = { type: 'addRules', rules: [{ toolName: 'Write', ruleContent: 'a.txt' }], behavior: 'allow', destination: 'session' };
  assert.equal(ampliarSugestao(w).sg, w);
  assert.equal(ampliarSugestao(w).libera, null);
  // Negar e setMode passam iguais.
  assert.equal(ampliarSugestao({ ...sg, behavior: 'deny' }).libera, null);
  assert.equal(ampliarSugestao({ type: 'setMode', mode: 'acceptEdits', destination: 'session' }).libera, null);
});

test('git diff/log/show * sugerido pelo claude: a negação do --output vai junto no updatedPermissions', () => {
  const sg = { type: 'addRules', rules: [{ toolName: 'PowerShell', ruleContent: 'git show:*' }], behavior: 'allow', destination: 'localSettings' };
  const { sg: nova, libera } = ampliarSugestao(sg);
  assert.match(libera, /menos --output/);
  assert.deepEqual(atualizacoesDe(nova), [
    { type: 'addRules', rules: [{ toolName: 'PowerShell', ruleContent: 'git show *' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'addRules', rules: [{ toolName: 'PowerShell', ruleContent: 'git show *--output*' }], behavior: 'deny', destination: 'localSettings' },
  ]);
  // Na sessão, a negação também fica na sessão; git status não grava arquivo, nada vai junto.
  assert.equal(atualizacoesDe(ampliarSugestao({ ...sg, destination: 'session' }).sg)[1].destination, 'session');
  const st = ampliarSugestao({ ...sg, rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }] });
  assert.equal(atualizacoesDe(st.sg).length, 1);
  assert.doesNotMatch(st.libera, /--output/);
  assert.deepEqual(atualizacoesDe({ type: 'setMode', mode: 'acceptEdits', destination: 'session' }), [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
});

test('sugestoesDe: a lista crua (que volta ao claude) já leva a regra ampla', () => {
  const cruas = [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'node testes/fumaca.mjs --rapido' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ];
  const { cruas: l, sugestoes } = sugestoesDe(cruas, 'ferramenta');
  assert.equal(l[0].rules[0].ruleContent, 'node testes/fumaca.mjs *');
  assert.equal(sugestoes[0].rotulo, 'Permitir sempre: node testes/fumaca.mjs * neste projeto (só nesta máquina)');
  assert.match(sugestoes[0].libera, /node testes\/fumaca\.mjs com qualquer argumento/);
  assert.equal(sugestoes[1].libera, undefined);
  assert.equal(cruas[0].rules[0].ruleContent, 'node testes/fumaca.mjs --rapido', 'não muda o objeto recebido');
  // Write segue com o rótulo de antes.
  const w = sugestoesDe([{ type: 'addRules', rules: [{ toolName: 'Write', ruleContent: 'a.txt' }], behavior: 'allow', destination: 'session' }], 'ferramenta');
  assert.equal(w.sugestoes[0].rotulo, 'Permitir sempre Write(a.txt) nesta sessão');
});

// ───────────────────────── regras.mjs ─────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-regras-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const CASA = path.join(TMP, 'casa');
const ORBIT = path.join(TMP, 'orbit');
const PROJ = path.join(CASA, 'proj');
const FORA = path.join(TMP, 'fora');
for (const p of [CASA, ORBIT, PROJ, FORA]) fs.mkdirSync(p, { recursive: true });
fs.mkdirSync(path.join(CASA, '.claude'), { recursive: true });
const GLOBAL = path.join(CASA, '.claude', 'settings.json');
fs.writeFileSync(GLOBAL, '{"permissions":{"allow":["Bash(segredo)"]}}');
fs.mkdirSync(path.join(PROJ, '.claude'));
fs.writeFileSync(path.join(PROJ, '.claude', 'settings.json'), JSON.stringify({ hooks: { x: 1 }, permissions: { allow: ['Bash(npm test *)'], deny: ['Bash(rm *)'] } }, null, 2));
fs.writeFileSync(path.join(PROJ, '.claude', 'settings.local.json'), JSON.stringify({ outro: true, permissions: { allow: ['Bash(npm test *)'], deny: ['Bash(git diff *--output*)'] } }, null, 2));

const difundidos = [];
const regras = criarRegras({
  sessoes: () => [{ cwd: PROJ, projeto: 'proj' }, { cwd: CASA, projeto: 'casa' }, { cwd: TMP, projeto: 'acima' }, { cwd: path.join(TMP, 'sumiu') }],
  pastaOrbit: ORBIT,
  casa: CASA,
  difundir: (t, d) => difundidos.push([t, d]),
  lerJSONCorpo: async (req) => JSON.parse(await new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s)); })),
});

async function chamar(metodo, rota, corpo) {
  const req = Readable.from(corpo === undefined ? [] : [JSON.stringify(corpo)]);
  req.method = metodo;
  const res = { status: 0, corpo: null, headersSent: false, writeHead(s) { this.status = s; this.headersSent = true; }, end(t) { this.corpo = JSON.parse(t); } };
  try {
    const tratou = await regras.rota(req, res, rota);
    return { tratou, status: res.status, corpo: res.corpo };
  } catch (e) {
    return { tratou: true, status: e.status || 500, corpo: { erro: e.message } };
  }
}

test('regras: lista só pastas de projeto (nunca a pessoal nem as de cima)', async () => {
  const r = await chamar('GET', '/regras');
  assert.equal(r.status, 200);
  const pastas = r.corpo.projetos.map((p) => p.pasta);
  assert.deepEqual(pastas, [path.resolve(ORBIT), path.resolve(PROJ)]);
  assert.equal(r.corpo.projetos[0].nome, 'Orbit');
  const proj = r.corpo.projetos[1];
  assert.deepEqual(proj.arquivos.map((a) => a.arquivo), ['local', 'projeto']);
  assert.deepEqual(proj.arquivos[0].regras, [{ tipo: 'allow', regra: 'Bash(npm test *)' }, { tipo: 'deny', regra: 'Bash(git diff *--output*)' }]);
  assert.deepEqual(proj.arquivos[1].regras, [{ tipo: 'allow', regra: 'Bash(npm test *)' }, { tipo: 'deny', regra: 'Bash(rm *)' }]);
  assert.equal((await chamar('GET', '/outra')).tratou, false);
});

test('regras: não há mais pacote de leitura', async () => {
  const r = await chamar('POST', '/regras/leitura', { pasta: PROJ });
  assert.equal(r.tratou, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(PROJ, '.claude', 'settings.local.json'), 'utf8')).permissions.allow.length, 1);
});

test('regras: remover tira só a regra e mantém o resto do arquivo', async () => {
  const arq = path.join(PROJ, '.claude', 'settings.json');
  const r = await chamar('POST', '/regras/remover', { pasta: PROJ, arquivo: 'projeto', tipo: 'deny', regra: 'Bash(rm *)' });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.deepEqual(JSON.parse(fs.readFileSync(arq, 'utf8')), { hooks: { x: 1 }, permissions: { allow: ['Bash(npm test *)'], deny: [] } });
  assert.ok(difundidos.some(([t]) => t === 'regras'));
  const r2 = await chamar('POST', '/regras/remover', { pasta: PROJ, arquivo: 'local', tipo: 'deny', regra: 'Bash(git diff *--output*)' });
  assert.equal(r2.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(PROJ, '.claude', 'settings.local.json'), 'utf8')), { outro: true, permissions: { allow: ['Bash(npm test *)'], deny: [] } });
  // Já removida: 404.
  assert.equal((await chamar('POST', '/regras/remover', { pasta: PROJ, arquivo: 'local', tipo: 'deny', regra: 'Bash(git diff *--output*)' })).status, 404);
  assert.equal(JSON.parse(fs.readFileSync(GLOBAL, 'utf8')).permissions.allow.length, 1, 'o global não muda');
});

test('regras: recusa a pasta pessoal, as de cima, pastas desconhecidas e JSON inválido', async () => {
  const rem = (pasta, extra = {}) => chamar('POST', '/regras/remover', { pasta, arquivo: 'projeto', tipo: 'allow', regra: 'Bash(segredo)', ...extra });
  assert.equal((await rem(CASA)).status, 403);
  assert.equal((await rem(TMP)).status, 403);
  assert.equal((await rem(FORA)).status, 404);
  assert.equal((await rem(PROJ, { arquivo: '../x' })).status, 400);
  assert.equal(JSON.parse(fs.readFileSync(GLOBAL, 'utf8')).permissions.allow[0], 'Bash(segredo)');
  fs.mkdirSync(path.join(ORBIT, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ORBIT, '.claude', 'settings.local.json'), '{ quebrado');
  assert.equal((await rem(ORBIT, { arquivo: 'local' })).status, 409);
  assert.equal(fs.readFileSync(path.join(ORBIT, '.claude', 'settings.local.json'), 'utf8'), '{ quebrado', 'não regrava');
  const l = await chamar('GET', '/regras');
  assert.equal(l.corpo.projetos[0].arquivos[0].erro, 'JSON inválido');
});
