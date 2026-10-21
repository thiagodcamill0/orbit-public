// Plano e conta do Claude (conta-claude.mjs): nome do plano, leitura só dos campos sem segredo e omissão sem quebrar.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nomeDoPlano, lerContaClaude, statusDe, urlDoLogin } from '../conta-claude.mjs';

test('statusDe: o `claude auth status --json` (2.1.272) sem orgId; deslogado sem plano; lixo → null', () => {
  const j = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'a@b.com', orgId: 'org-123', orgName: "A's Organization", subscriptionType: 'max' };
  assert.deepEqual(statusDe(j), { logado: true, metodo: 'claude.ai', email: 'a@b.com', org: "A's Organization", plano: 'Max' });
  assert.equal(statusDe(j, 'Max 5x').plano, 'Max 5x');
  assert.ok(!JSON.stringify(statusDe(j)).includes('org-123'));
  assert.deepEqual(statusDe({ loggedIn: false, authMethod: 'none' }), { logado: false, metodo: 'none', email: null, org: null, plano: null });
  assert.equal(statusDe(null), null);
  assert.equal(statusDe('texto'), null);
});

test('urlDoLogin: a primeira https da saída, sem pontuação no fim', () => {
  assert.equal(urlDoLogin('Opening browser…\nvisit: https://claude.ai/oauth/authorize?code=true&state=x).\n'), 'https://claude.ai/oauth/authorize?code=true&state=x');
  assert.equal(urlDoLogin('http://inseguro.com'), null);
  assert.equal(urlDoLogin(''), null);
});

test('nomeDoPlano: assinatura, nível e tipo da organização', () => {
  assert.equal(nomeDoPlano({ assinatura: 'max', nivel: 'default_claude_max_5x' }), 'Max 5x');
  assert.equal(nomeDoPlano({ nivel: 'default_claude_max_20x' }), 'Max 20x');
  assert.equal(nomeDoPlano({ tipoOrg: 'claude_max' }), 'Max');
  assert.equal(nomeDoPlano({ assinatura: 'pro', nivel: 'default_claude_ai' }), 'Pro');
  assert.equal(nomeDoPlano({ tipoOrg: 'claude_team' }), 'Team');
  assert.equal(nomeDoPlano({}), null);
  assert.equal(nomeDoPlano({ assinatura: 'desconhecido', tipoOrg: 'x' }), null);
});

test('lerContaClaude: lê plano e e-mail, nunca os tokens; sem arquivos devolve nulls', () => {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-conta-'));
  assert.deepEqual(lerContaClaude({ home: casa }), { plano: null, conta: null });
  fs.mkdirSync(path.join(casa, '.claude'));
  fs.writeFileSync(path.join(casa, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.com', organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' } }));
  fs.writeFileSync(path.join(casa, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'segredo', refreshToken: 'segredo', subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } }));
  const r = lerContaClaude({ home: casa });
  assert.deepEqual(r, { plano: 'Max 5x', conta: 'a@b.com' });
  assert.ok(!JSON.stringify(r).includes('segredo'));
  // JSON quebrado: omite sem lançar.
  fs.writeFileSync(path.join(casa, '.claude.json'), '{ quebrado');
  fs.rmSync(path.join(casa, '.claude', '.credentials.json'));
  assert.deepEqual(lerContaClaude({ home: casa }), { plano: null, conta: null });
  fs.rmSync(casa, { recursive: true, force: true });
});
