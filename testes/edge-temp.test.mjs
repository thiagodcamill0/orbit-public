// Faxina do %TEMP% depois do Edge de teste (21/10): limparTempNavegador em testes/edge.mjs.
// Rodar:  node --test testes/edge-temp.test.mjs
// Usa uma pasta falsa no temp do sistema (apagada no fim); não toca no %TEMP% de verdade nem em processo algum.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { limparTempNavegador } from './edge.mjs';

const PASTA = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-edge-temp-'));
after(() => { try { fs.rmSync(PASTA, { recursive: true, force: true }); } catch {} });

const AGORA = Date.now();
const VELHO = new Date(AGORA - 2 * 3600e3);
const crx = Buffer.concat([Buffer.from('Cr24'), Buffer.alloc(1000)]);
function arquivo(nome, conteudo, quando = VELHO) {
  const p = path.join(PASTA, nome);
  fs.writeFileSync(p, conteudo);
  fs.utimesSync(p, quando, quando);
  return p;
}
function pastaScoped(nome) {
  const p = path.join(PASTA, nome);
  fs.mkdirSync(p);
  fs.writeFileSync(path.join(p, 'x.tmp'), crx);
  return p;
}

test('apaga só o abandonado: Cr24 velho e scoped_dir de processo morto', () => {
  const lixo = arquivo('0d7d1414-fff3-4cbe-980d-4e6c274d0eaf.tmp', crx);
  const recente = arquivo('13b11b0e-9839-4942-bf64-94ff6a9d1d11.tmp', crx, new Date(AGORA - 60e3));
  const vazio = arquivo('1c7ffcd9-cc01-4c49-89b3-98808c7caf9b.tmp', '');
  const outroTipo = arquivo('30f0587e-668b-4b90-9829-eabffc21f65d.tmp', 'PK\x03\x04qualquer');
  const nomeQualquer = arquivo('meu-arquivo.tmp', crx);
  const morto = pastaScoped('scoped_dir999991_123');
  const vivo = pastaScoped('scoped_dir4242_456');
  const perfil = pastaScoped('orbit-grafo-ui-TZhFD6');

  const r = limparTempNavegador({ pasta: PASTA, pidsVivos: new Set([4242]), agora: AGORA });

  assert.deepEqual(r, { pastas: 1, arquivos: 1, bytes: crx.length });
  assert.ok(!fs.existsSync(lixo), 'Cr24 parado há 2 h sai');
  assert.ok(!fs.existsSync(morto), 'scoped_dir de processo morto sai');
  for (const fica of [recente, vazio, outroTipo, nomeQualquer, vivo, perfil]) assert.ok(fs.existsSync(fica), fica);
});

test('sem a lista de processos, não apaga nenhuma scoped_dir', () => {
  const p = pastaScoped('scoped_dir999992_789');
  limparTempNavegador({ pasta: PASTA, pidsVivos: null, agora: AGORA });
  assert.ok(fs.existsSync(p));
});

test('pasta inexistente não quebra', () => {
  assert.deepEqual(limparTempNavegador({ pasta: path.join(PASTA, 'nao-existe'), pidsVivos: new Set() }), { pastas: 0, arquivos: 0, bytes: 0 });
});
