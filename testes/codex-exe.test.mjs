// Testes de codex-exe.mjs: árvores falsas em pasta temporária, nunca o Codex real.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acharCodex, limparCacheCodex } from '../codex-exe.mjs';

let raiz;
const bin = () => path.join(raiz, 'OpenAI', 'Codex', 'bin');

function pasta(nome, { codex = true, mtime } = {}) {
  const d = path.join(bin(), nome);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'rg.exe'), 'x');
  if (codex) {
    const exe = path.join(d, 'codex.exe');
    fs.writeFileSync(exe, 'x');
    if (mtime) fs.utimesSync(exe, mtime, mtime);
  }
}

before(() => {
  raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-codex-exe-'));
});
after(() => {
  fs.rmSync(raiz, { recursive: true, force: true });
});
beforeEach(() => {
  delete process.env.ORBIT_CODEX_EXE;
  limparCacheCodex();
  fs.rmSync(path.join(raiz, 'OpenAI'), { recursive: true, force: true });
});

const T = (s) => new Date(2026, 0, 1, 0, 0, s);

test('env vence tudo', () => {
  process.env.ORBIT_CODEX_EXE = 'C:\falso\codex.exe';
  pasta('aaa', { mtime: T(1) });
  const r = acharCodex({ caminhoManual: 'x', localAppData: raiz, so: 'win32' });
  assert.deepEqual(r, { exe: 'C:\falso\codex.exe', origem: 'env', versaoPasta: null });
});

test('manual existente vence o automático', () => {
  pasta('aaa', { mtime: T(1) });
  const manual = path.join(raiz, 'meu-codex.exe');
  fs.writeFileSync(manual, 'x');
  const r = acharCodex({ caminhoManual: manual, localAppData: raiz, so: 'win32' });
  assert.equal(r.exe, manual);
  assert.equal(r.origem, 'manual');
});

test('manual inexistente não cai no automático, mas sugere', () => {
  pasta('aaa', { mtime: T(1) });
  const r = acharCodex({ caminhoManual: path.join(raiz, 'nao.exe'), localAppData: raiz, so: 'win32' });
  assert.equal(r.exe, null);
  assert.equal(r.motivo, 'caminho manual não encontrado');
  assert.equal(r.auto, path.win32.join(raiz, 'OpenAI', 'Codex', 'bin', 'aaa', 'codex.exe'));
});

test('automático escolhe o codex.exe mais recente e ignora pasta sem ele', () => {
  pasta('antiga', { mtime: T(10) });
  pasta('nova', { mtime: T(50) });
  pasta('so-rg', { codex: false });
  pasta('media', { mtime: T(30) });
  const r = acharCodex({ localAppData: raiz, so: 'win32' });
  assert.equal(r.origem, 'auto');
  assert.equal(r.versaoPasta, 'nova');
  assert.equal(r.exe, path.win32.join(raiz, 'OpenAI', 'Codex', 'bin', 'nova', 'codex.exe'));
});

test('só pastas sem codex.exe, ou nenhuma pasta: não encontrado', () => {
  assert.equal(acharCodex({ localAppData: raiz, so: 'win32' }).exe, null);
  pasta('so-rg', { codex: false });
  const r = acharCodex({ localAppData: raiz, so: 'win32' });
  assert.equal(r.exe, null);
  assert.match(r.motivo, /não encontrado/);
});

test('darwin: Mac depois', () => {
  pasta('aaa', { mtime: T(1) });
  assert.deepEqual(acharCodex({ localAppData: raiz, so: 'darwin' }), { exe: null, motivo: 'Mac depois' });
});

test('fs injetado nunca executa nada e não usa cache', () => {
  let estado = 'a';
  const falso = {
    readdirSync: () => ['h'],
    statSync: () => {
      if (estado === 'x') throw new Error('sem');
      return { isFile: () => true, mtimeMs: 1 };
    },
  };
  assert.equal(acharCodex({ localAppData: 'C:\L', so: 'win32', fs: falso }).versaoPasta, 'h');
  estado = 'x';
  assert.equal(acharCodex({ localAppData: 'C:\L', so: 'win32', fs: falso }).exe, null);
});
