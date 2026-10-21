// Tailscale (tailscale.mjs) com saídas JSON falsas: instalado/logado, deslogado, parado, ausente, serve ligado,
// comandos montados sem shell e falhas que não lançam. Não chama o Tailscale real.
// Rodar:  node --test testes/tailscale.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { criarTailscale, executarCli, acharNoPath } from '../tailscale.mjs';

const ok = (saida) => ({ codigo: 0, saida: JSON.stringify(saida), erro: '', ausente: false });
const STATUS_LOGADO = {
  BackendState: 'Running',
  Self: { ID: 'n1', UserID: 1234, DNSName: 'meu-pc.tail1234.ts.net.', HostName: 'meu-pc' },
  User: { 1234: { ID: 1234, LoginName: 'usuario@exemplo.com', DisplayName: 'Usuario' } },
};
const SERVE_LIGADO = { TCP: { 443: { HTTPS: true } }, Web: { 'meu-pc.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:47820' } } } } };

// Executor falso: registra as chamadas e responde por "status" / "serve status" / outros.
function falso({ status, serve = {}, outros, ausente = false } = {}) {
  const chamadas = [];
  const executar = async (exe, args) => {
    chamadas.push({ exe, args });
    if (ausente) return { codigo: null, saida: '', erro: 'ENOENT', ausente: true };
    if (args[0] === 'status') return status;
    if (args[0] === 'serve' && args[1] === 'status') return serve;
    return outros || ok({});
  };
  return { executar, chamadas };
}

test('detectar: instalado e logado, com host sem ponto final, dono e serve ligado', async () => {
  const f = falso({ status: ok(STATUS_LOGADO), serve: ok(SERVE_LIGADO) });
  const ts = criarTailscale({ executar: f.executar, so: 'linux' });
  assert.deepEqual(await ts.detectar(), { instalado: true, logado: true, host: 'meu-pc.tail1234.ts.net', dono: 'usuario@exemplo.com', serve: true });
  assert.deepEqual(f.chamadas.map((c) => c.args), [['status', '--json'], ['serve', 'status', '--json']]);
  // com a porta: só conta se o serve aponta para ela
  assert.equal((await ts.detectar(47820)).serve, true);
  assert.equal((await ts.detectar(47999)).serve, false);
});

test('detectar: logado com serve desligado ({}), ou serve de outro tipo, dá serve=false', async () => {
  const sem = criarTailscale({ executar: falso({ status: ok(STATUS_LOGADO), serve: ok({}) }).executar, so: 'linux' });
  assert.equal((await sem.detectar()).serve, false);
  const outra = { TCP: { 8443: { HTTPS: true } }, Web: { 'meu-pc.tail1234.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:1' } } } } };
  assert.equal((await criarTailscale({ executar: falso({ status: ok(STATUS_LOGADO), serve: ok(outra) }).executar, so: 'linux' }).detectar()).serve, false);
  const lixo = criarTailscale({ executar: falso({ status: ok(STATUS_LOGADO), serve: { codigo: 1, saida: 'não é json', erro: 'x' } }).executar, so: 'linux' });
  assert.equal((await lixo.detectar()).serve, false);
});

test('detectar: deslogado (NeedsLogin) e parado (Stopped) não são "logado" e não consultam o serve', async () => {
  for (const estado of ['NeedsLogin', 'Stopped', 'NoState', 'NeedsMachineAuth']) {
    const f = falso({ status: { codigo: 1, saida: JSON.stringify({ BackendState: estado, Self: { DNSName: 'x.ts.net.' } }), erro: '', ausente: false } });
    const r = await criarTailscale({ executar: f.executar, so: 'linux' }).detectar();
    assert.deepEqual(r, { instalado: true, logado: false, host: '', dono: '', serve: false }, estado);
    assert.equal(f.chamadas.length, 1);
  }
});

test('detectar: ausente (ENOENT), saída que não é JSON e executor que lança não lançam', async () => {
  const f = falso({ ausente: true });
  assert.deepEqual(await criarTailscale({ executar: f.executar, so: 'win32' }).detectar(), { instalado: false, logado: false, host: '', dono: '', serve: false });
  // no Windows tenta o Program Files e depois o PATH (o nome nu nunca acha um tailscale.exe no cwd)
  assert.deepEqual(f.chamadas.map((c) => c.exe), ['C:\\Program Files\\Tailscale\\tailscale.exe', 'tailscale']);

  const m = falso({ ausente: true });
  await criarTailscale({ executar: m.executar, so: 'darwin' }).detectar();
  assert.deepEqual(m.chamadas.map((c) => c.exe), ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'tailscale']);

  const naoJson = criarTailscale({ executar: falso({ status: { codigo: 0, saida: 'ops', erro: '', ausente: false } }).executar, so: 'linux' });
  assert.deepEqual(await naoJson.detectar(), { instalado: true, logado: false, host: '', dono: '', serve: false });

  const lanca = criarTailscale({ executar: async () => { throw new Error('explodiu'); }, so: 'linux' });
  assert.equal((await lanca.detectar()).logado, false);
});

test('detectar: achado só no 2º caminho (fora do PATH) usa esse executável', async () => {
  const chamadas = [];
  const executar = async (exe, args) => {
    chamadas.push(exe);
    if (exe === 'tailscale') return { codigo: null, saida: '', erro: 'ENOENT', ausente: true };
    return args[0] === 'status' ? ok(STATUS_LOGADO) : ok({});
  };
  const r = await criarTailscale({ executar, so: 'win32' }).detectar();
  assert.equal(r.logado, true);
  assert.equal(chamadas.at(-1), 'C:\\Program Files\\Tailscale\\tailscale.exe');
});

test('ligarServe / desligarServe: comandos exatos do contrato e falhas viram { ok:false }', async () => {
  const f = falso({});
  const ts = criarTailscale({ executar: f.executar, so: 'linux' });
  assert.deepEqual(await ts.ligarServe(47820), { ok: true });
  assert.deepEqual(f.chamadas.at(-1).args, ['serve', '--bg', '--https=443', 'http://127.0.0.1:47820']);
  assert.deepEqual(await ts.desligarServe(), { ok: true });
  assert.deepEqual(f.chamadas.at(-1).args, ['serve', '--https=443', 'off']);

  // porta inválida: nem chama a CLI
  const n = f.chamadas.length;
  for (const ruim of [0, -1, 70000, 'abc', '47820; rm -rf', null, 1.5]) assert.equal((await ts.ligarServe(ruim)).ok, false);
  assert.equal(f.chamadas.length, n);

  const falha = criarTailscale({ executar: falso({ outros: { codigo: 1, saida: '', erro: 'Serve is not enabled on your tailnet.\nTo enable, visit: https://login.tailscale.com/f/serve', ausente: false } }).executar, so: 'linux' });
  const r = await falha.ligarServe(47820);
  assert.equal(r.ok, false);
  assert.match(r.erro, /Serve is not enabled/);
  assert.equal(r.erro.includes('\n'), false);

  const ausente = criarTailscale({ executar: falso({ ausente: true }).executar, so: 'linux' });
  assert.equal((await ausente.ligarServe(47820)).ok, false);
  assert.equal((await ausente.desligarServe()).ok, false);
});

test('executarCli real: executável inexistente vira { ausente:true } sem lançar', async () => {
  const r = await executarCli('orbit-nao-existe-tailscale-xyz', ['status']);
  assert.equal(r.ausente, true);
  assert.notEqual(r.codigo, 0);
});

test('acharNoPath: o nome nu só sai de diretório absoluto do PATH, nunca do cwd nem de diretório relativo', () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-ts-path-'));
  try {
    const cwd = path.join(raiz, 'orbit');
    const bin = path.join(raiz, 'bin');
    fs.mkdirSync(cwd);
    fs.mkdirSync(bin);
    const nome = process.platform === 'win32' ? 'tailscale.exe' : 'tailscale';
    fs.writeFileSync(path.join(cwd, nome), 'plantado');
    const sep = process.platform === 'win32' ? ';' : ':';
    const so = process.platform;
    // só o cwd (absoluto, relativo e '.') no PATH: não acha
    assert.equal(acharNoPath('tailscale', { so, cwd, env: { PATH: [cwd, '.', 'orbit', ''].join(sep) } }), null);
    fs.writeFileSync(path.join(bin, nome), 'de verdade');
    assert.equal(acharNoPath('tailscale', { so, cwd, env: { PATH: ['.', cwd, bin].join(sep) } }), path.join(bin, nome));
  } finally {
    fs.rmSync(raiz, { recursive: true, force: true });
  }
});
