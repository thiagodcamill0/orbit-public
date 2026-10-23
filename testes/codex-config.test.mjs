// Testes da chave do Codex no servidor (config.codex + codex.mjs, Etapa 0).
// Rodar:  node --test testes/codex-config.test.mjs
// Sobe servidores próprios (porta por escolherPorta, 47822–47826, nunca a 47821) com GERENCIADOR_DADOS temporário e
// ORBIT_CODEX_EXE apontando para o Codex falso. Nunca roda o codex real nem toca ~/.codex ou ~/.claude.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escolherPorta, desligarSeMeu } from './porta-livre.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FALSO = path.join(RAIZ, 'testes', 'codex-falso.mjs');
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let PORTA;
let TMP;
let DADOS;
let filho = null;

function pedir(metodo, rota, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
    const headers = { 'x-gerenciador': '1' };
    if (dados !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(dados);
    }
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers, timeout: 8000 }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const t = Buffer.concat(partes).toString('utf8');
        let json = null;
        try { json = JSON.parse(t); } catch {}
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

async function subir(extraEnv = {}) {
  const env = {
    ...process.env,
    GERENCIADOR_PORTA: String(PORTA),
    GERENCIADOR_DADOS: DADOS,
    GERENCIADOR_SESSOES_DIR: path.join(TMP, 'sessoes'),
    ORBIT_PROJETOS_DIR: path.join(TMP, 'projetos'),
    CODEX_HOME: path.join(TMP, 'codex-home'),
    ORBIT_MOTOR: '0',
    ...(process.platform === 'win32' ? {} : { HOME: path.join(TMP, 'home') }),
    ...extraEnv,
  };
  if (!extraEnv.ORBIT_CODEX_EXE) delete env.ORBIT_CODEX_EXE;
  delete env.CLAUDE_CODE_HOST_SESSION_ID;
  filho = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (filho.exitCode != null) throw new Error(`o servidor do teste saiu (código ${filho.exitCode})`);
    try {
      const r = await get('/saude');
      if (r.json?.pid === filho.pid) return;
    } catch {}
    await espera(100);
  }
  throw new Error('servidor não subiu');
}

async function descer() {
  const p = filho;
  if (!p) return;
  filho = null;
  if (p.exitCode != null) return;
  const saiu = new Promise((r) => p.once('exit', r));
  await desligarSeMeu(PORTA, p.pid);
  await Promise.race([saiu, espera(4000)]);
  if (p.exitCode == null) { try { p.kill(); } catch {} await Promise.race([saiu, espera(3000)]); }
}

const lerConfigDisco = () => {
  try { return JSON.parse(fs.readFileSync(path.join(DADOS, 'config.json'), 'utf8')); } catch { return null; }
};

before(async () => {
  PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47822);
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-codex-config-'));
  DADOS = path.join(TMP, 'dados');
  for (const d of [DADOS, path.join(TMP, 'sessoes'), path.join(TMP, 'projetos'), path.join(TMP, 'codex-home')]) fs.mkdirSync(d, { recursive: true });
});
after(async () => {
  await descer();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('sem chave: /codex/estado é 404 e /config não tem o campo codex', async () => {
  await subir({ ORBIT_CODEX_EXE: FALSO });
  const e = await get('/codex/estado');
  assert.equal(e.status, 404);
  const c = await get('/config');
  assert.equal(c.status, 200);
  assert.ok(!('codex' in c.json), 'config sem o campo codex');
  assert.equal((await get('/codex/qualquer')).status, 404);
  assert.equal((await post('/codex/estado')).status, 404);
});

test('config.json em disco não tem codex antes de ligar (nem depois de salvar outra coisa)', async () => {
  await post('/config', { som: { ativo: false } });
  const c = await get('/config');
  assert.ok(!('codex' in c.json));
  // Sem campos válidos no bloco codex, nada é gravado.
  const r = await post('/config', { codex: { ativo: 'sim', exe: 5 } });
  assert.equal(r.status, 200);
  assert.ok(!('codex' in r.json));
  assert.equal((await get('/codex/estado')).status, 404);
  const disco = lerConfigDisco();
  assert.ok(disco === null || !('codex' in disco), 'config.json sem codex');
});

test('ligar pela config: /codex/estado responde 200 com o exe', async () => {
  const r = await post('/config', { codex: { ativo: true } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.codex, { ativo: true, exe: '' });
  const e = await get('/codex/estado');
  assert.equal(e.status, 200);
  assert.equal(e.json.ativo, true);
  assert.equal(e.json.exe.exe, FALSO);
  assert.equal(e.json.exe.origem, 'env');
  assert.equal((await post('/codex/estado')).status, 404, 'só GET existe');
  assert.equal((await get('/codex/outra')).status, 404);
  assert.equal((await get('/config')).json.codex.ativo, true);
});

test('exe relativo ou inválido é descartado; absoluto .exe é aceito', async () => {
  const invalidos = ['codex.exe', 'pasta/codex.exe', '..\\codex.exe', 'x'.repeat(501), 'C:\\a\0b\\codex.exe', ' \n '];
  if (process.platform === 'win32') invalidos.push('C:\\pasta\\codex.cmd', 'C:\\pasta\\codex');
  for (const exe of invalidos) {
    const r = await post('/config', { codex: { exe } });
    assert.equal(r.status, 200);
    assert.equal(r.json.codex.exe, '', `descartado: ${JSON.stringify(exe).slice(0, 40)}`);
    assert.equal(r.json.codex.ativo, true, 'ativo não muda');
  }
  assert.equal((await post('/config', { codex: { exe: 42 } })).json.codex.exe, '');
  const ok = path.join(TMP, 'codex.exe');
  const r = await post('/config', { codex: { exe: ok } });
  assert.equal(r.json.codex.exe, ok);
  // Inválido depois de válido não apaga o válido; '' limpa.
  assert.equal((await post('/config', { codex: { exe: 'relativo.exe' } })).json.codex.exe, ok);
  assert.equal((await post('/config', { codex: { exe: '' } })).json.codex.exe, '');
  // Campos desconhecidos do bloco são ignorados.
  const x = await post('/config', { codex: { intruso: 1 } });
  assert.deepEqual(Object.keys(x.json.codex).sort(), ['ativo', 'exe']);
});

test('desligar: 404 de novo e o módulo para; religar volta a 200', async () => {
  const r = await post('/config', { codex: { ativo: false } });
  assert.equal(r.json.codex.ativo, false);
  assert.equal((await get('/codex/estado')).status, 404);
  assert.equal((await post('/config', { codex: { ativo: true } })).status, 200);
  assert.equal((await get('/codex/estado')).status, 200);
});

test('chave e caminho manual persistem no disco e valem depois de reiniciar (sem env)', async () => {
  const falsoExe = path.join(TMP, 'codex.exe');
  fs.writeFileSync(falsoExe, 'x'); // só precisa existir: nunca é executado
  assert.equal((await post('/config', { codex: { exe: falsoExe } })).json.codex.exe, falsoExe);
  await descer();
  const disco = lerConfigDisco();
  assert.deepEqual(disco?.codex, { ativo: true, exe: falsoExe });
  await subir(); // sem ORBIT_CODEX_EXE: vale o caminho manual
  const e = await get('/codex/estado');
  assert.equal(e.status, 200);
  assert.equal(e.json.exe.exe, falsoExe);
  assert.equal(e.json.exe.origem, 'manual');
  // Manual que não existe: sem exe e com o motivo.
  await post('/config', { codex: { exe: path.join(TMP, 'sumiu', 'codex.exe') } });
  const f = await get('/codex/estado');
  assert.equal(f.status, 200);
  assert.equal(f.json.exe.exe, null);
  assert.match(f.json.exe.motivo, /manual/);
  // Desligado no disco: depois de reiniciar, 404.
  await post('/config', { codex: { ativo: false } });
  await descer();
  await subir();
  assert.equal((await get('/codex/estado')).status, 404);
});

test('o servidor não importa codex.mjs estaticamente', () => {
  const fonte = fs.readFileSync(path.join(RAIZ, 'servidor.mjs'), 'utf8');
  assert.ok(!/^\s*import[^;\n]*['"]\.\/codex[^'"]*['"]/m.test(fonte), 'sem import estático de codex*');
  assert.ok(/await import\(['"]\.\/codex\.mjs['"]\)/.test(fonte), 'import dinâmico');
});
