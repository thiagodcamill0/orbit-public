// Testes do skills.mjs (aba Skills). Rodar:  node testes/skills.test.mjs
// Só pastas temporárias: a "pasta pessoal" é falsa e nenhum .claude de verdade é lido ou gravado. A sonda
// (get_skills_dialog) e a Lixeira são falsas.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { criarSkills, lerSkillMd, montarSkillMd, novaLeituraUso, lerLinhasUso, resumoUso } from '../skills.mjs';

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-skills-'));
after(() => fs.rmSync(RAIZ, { recursive: true, force: true }));
const CASA = path.join(RAIZ, 'casa');
const ORBIT = path.join(RAIZ, 'orbit');
const PROJ = path.join(RAIZ, 'proj');
const DADOS = path.join(RAIZ, 'dados');
const LIXO = path.join(RAIZ, 'lixo');
for (const d of [CASA, ORBIT, PROJ, DADOS, LIXO]) fs.mkdirSync(d, { recursive: true });

function skill(dir, nome, desc, corpo = 'Faça X.\n', extra = '') {
  fs.mkdirSync(path.join(dir, nome), { recursive: true });
  fs.writeFileSync(path.join(dir, nome, 'SKILL.md'), `---\nname: ${nome}\ndescription: ${desc}\n${extra}---\n\n${corpo}`);
}
const PROJ_SK = path.join(PROJ, '.claude', 'skills');
const PESS_SK = path.join(CASA, '.claude', 'skills');
skill(PROJ_SK, 'revisar', 'Revisa o código do projeto');
skill(PROJ_SK, 'dup', 'VERSAO-PROJETO');
skill(PESS_SK, 'dup', 'VERSAO-PESSOAL');
skill(PESS_SK, 'minha', 'Uma pessoal');
skill(path.join(PESS_SK, 'synced', 'balde1'), 'docs', "'Docs do claude.ai: ''aspas'''");
fs.mkdirSync(path.join(PESS_SK, '.trash', 'x'), { recursive: true });
fs.writeFileSync(path.join(PROJ, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [] } }, null, 2));
const SET_PESS = path.join(CASA, '.claude', 'settings.json');
fs.writeFileSync(SET_PESS, JSON.stringify({ skillOverrides: { minha: 'off' } }));
const pessoalAntes = fs.readFileSync(SET_PESS, 'utf8');
fs.writeFileSync(path.join(DADOS, 'projetos.json'), JSON.stringify({ lista: [{ nome: 'proj', pasta: PROJ }] }));

let linhasSonda = null; // null = sonda falha
let sondadas = 0;
const lixeira = [];
const SESSOES = new Map();
const sk = criarSkills({
  sessoes: () => [{ cwd: CASA }, { cwd: PROJ, projeto: 'proj' }],
  sessao: (id) => SESSOES.get(id),
  pastaOrbit: ORBIT,
  dados: DADOS,
  lerJSONCorpo: async (req) => {
    let t = '';
    for await (const c of req) t += c;
    return t ? JSON.parse(t) : null;
  },
  casa: CASA,
  sondar: async () => {
    sondadas++;
    if (!linhasSonda) throw new Error('sonda falsa desligada');
    return linhasSonda;
  },
  lixeira: async (abs) => {
    for (const a of abs) {
      const alvo = path.join(LIXO, `${lixeira.length}-${path.basename(a)}`);
      fs.renameSync(a, alvo);
      lixeira.push(a);
    }
    return abs;
  },
  permitidas: (id) => (id === 'orbit-1' ? ['revisar'] : null),
});

async function chamar(metodo, rota, corpo) {
  const req = Readable.from(metodo === 'POST' ? [JSON.stringify(corpo ?? {})] : []);
  req.method = metodo;
  const u = new URL('http://x' + rota);
  const res = { status: 0, corpo: null, headersSent: false, writeHead(s) { this.status = s; this.headersSent = true; }, end(t) { this.corpo = JSON.parse(t); } };
  const tratou = await sk.rota(req, res, u.pathname, u);
  return { tratou, status: res.status, corpo: res.corpo };
}
const qs = (o) => '?' + new URLSearchParams(o).toString();

// ───────────────────────── cabeçalho ─────────────────────────
test('lerSkillMd: aspas, bloco e o resto do cabeçalho intacto', () => {
  const f = lerSkillMd("---\nname: x\ndescription: 'diz ''oi'': ok'\nallowed-tools: Read, Grep\nhooks:\n  Stop: []\n---\n\n# Corpo\n");
  assert.equal(f.campos.name, 'x');
  assert.equal(f.campos.description, "diz 'oi': ok");
  assert.equal(f.extra, 'allowed-tools: Read, Grep\nhooks:\n  Stop: []');
  assert.equal(f.corpo, '\n# Corpo\n');
  assert.equal(lerSkillMd('---\nname: y\ndescription: >\n  linha um\n  linha dois\n---\nc').campos.description, 'linha um linha dois');
  assert.equal(lerSkillMd('sem cabeçalho').semCabecalho, true);
});

test('montarSkillMd: ida e volta, com descrição que precisa de aspas', () => {
  const md = montarSkillMd({ nome: 'a-b', descricao: 'Use quando: "algo" #1', extra: 'allowed-tools: Read', corpo: 'Passo 1' });
  const f = lerSkillMd(md);
  assert.equal(f.campos.name, 'a-b');
  assert.equal(f.campos.description, 'Use quando: "algo" #1');
  assert.equal(f.extra, 'allowed-tools: Read');
  assert.equal(f.corpo.trim(), 'Passo 1');
  assert.match(montarSkillMd({ nome: 'z', descricao: 'Simples e direta', corpo: '' }), /^---\nname: z\ndescription: Simples e direta\n---\n/);
});

// ───────────────────────── lista ─────────────────────────
test('lista sem sonda: projeto e pessoais das pastas, sombreada e estado lido dos settings', async () => {
  linhasSonda = null;
  const r = await chamar('GET', '/skills' + qs({ pasta: PROJ }));
  assert.equal(r.status, 200);
  assert.equal(r.corpo.sonda.ok, false);
  const ids = r.corpo.skills.map((s) => s.id);
  assert.deepEqual(ids, ['projeto:dup', 'projeto:revisar', 'pessoal:dup', 'pessoal:minha', 'claude.ai:docs']);
  const dup = r.corpo.skills.find((s) => s.id === 'projeto:dup');
  assert.equal(dup.sombreada, true, 'a pessoal com o mesmo nome vence');
  assert.equal(r.corpo.skills.find((s) => s.id === 'pessoal:minha').estado, 'off');
  assert.equal(r.corpo.skills.find((s) => s.id === 'claude.ai:docs').editavel, false);
  assert.equal(r.corpo.skills.find((s) => s.id === 'claude.ai:docs').descricao, "Docs do claude.ai: 'aspas'");
  // Pastas: Orbit, a da lateral e a das sessões; nunca a pessoal.
  assert.deepEqual(r.corpo.projetos.map((p) => p.pasta), [path.resolve(ORBIT), path.resolve(PROJ)]);
  assert.equal((await chamar('GET', '/skills' + qs({ pasta: CASA }))).status, 403);
  assert.equal((await chamar('GET', '/skills' + qs({ pasta: path.join(RAIZ, 'nada') }))).status, 404);
});

test('lista com sonda: nome canônico, plugin travado e o que a sonda não viu', async () => {
  sk.invalidar();
  linhasSonda = [
    { name: 'dup', display_name: 'dup', description: 'VERSAO-PROJETO', source: 'project', tokens: 10, state: 'on', advertised: false, handles: {} },
    { name: 'dup', display_name: 'dup', description: 'VERSAO-PESSOAL', source: 'user', tokens: 10, state: 'on', advertised: true, handles: {} },
    { name: 'minha', display_name: 'minha', description: 'Uma pessoal', source: 'user', tokens: 7, state: 'off', advertised: false, handles: {} },
    { name: 'anthropic-skills:docs', display_name: 'docs', description: 'Docs', source: 'claude.ai sync', tokens: 30, state: 'on', advertised: true, handles: { unqualified_name: 'docs' } },
    { name: 'prod:start', display_name: 'prod:start', description: 'Plugin', source: 'plugin', tokens: 5, state: 'on', locked_by: 'plugin', advertised: true, handles: {} },
  ];
  const r = await chamar('GET', '/skills' + qs({ pasta: PROJ }));
  assert.equal(r.corpo.sonda.ok, true);
  const por = Object.fromEntries(r.corpo.skills.map((s) => [s.id, s]));
  assert.equal(por['claude.ai:docs'].chave, 'anthropic-skills:docs');
  assert.ok(por['claude.ai:docs'].caminho.endsWith(path.join('balde1', 'docs')));
  assert.equal(por['plugin:prod:start'].travada, 'plugin');
  assert.equal(por['plugin:prod:start'].editavel, false);
  assert.equal(por['projeto:revisar'].foraDaSonda, true);
  assert.equal(por['projeto:dup'].anunciada, false);
  assert.equal(por['projeto:dup'].sombreada, true);
  // A lista da sonda vale 30 s.
  const n = sondadas;
  await chamar('GET', '/skills' + qs({ pasta: PROJ }));
  assert.equal(sondadas, n);
});

// ───────────────────────── criar, editar, duplicar, excluir ─────────────────────────
test('criar no projeto; nome inválido e repetido recusados', async () => {
  const r = await chamar('POST', '/skills/salvar', { pasta: PROJ, origem: 'projeto', nome: 'nova-skill', descricao: 'Faz a coisa nova', corpo: '# Passos\n1. a\n', extra: 'allowed-tools: Read' });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  const md = fs.readFileSync(path.join(PROJ_SK, 'nova-skill', 'SKILL.md'), 'utf8');
  assert.match(md, /^---\nname: nova-skill\ndescription: Faz a coisa nova\nallowed-tools: Read\n---\n\n# Passos/);
  assert.equal((await chamar('POST', '/skills/salvar', { pasta: PROJ, origem: 'projeto', nome: 'Nova Skill', descricao: 'x', corpo: '' })).status, 400);
  assert.equal((await chamar('POST', '/skills/salvar', { pasta: PROJ, origem: 'projeto', nome: 'nova-skill', descricao: 'x', corpo: '' })).status, 409);
  assert.equal((await chamar('POST', '/skills/salvar', { pasta: PROJ, origem: 'projeto', nome: 'sem-desc', descricao: ' ', corpo: '' })).status, 400);
  assert.equal((await chamar('POST', '/skills/salvar', { pasta: PROJ, origem: 'projeto', nome: 'cab', descricao: 'x', extra: 'name: outro' })).status, 400);
});

test('pessoal: sem confirmarGlobal responde 428 e não grava nada', async () => {
  const r = await chamar('POST', '/skills/salvar', { pasta: PROJ, origem: 'pessoal', nome: 'global-x', descricao: 'x', corpo: '' });
  assert.equal(r.status, 428);
  assert.equal(r.corpo.codigo, 'confirmar_global');
  assert.equal(fs.existsSync(path.join(PESS_SK, 'global-x')), false);
  for (const [rota, corpo] of [
    ['/skills/excluir', { pasta: PROJ, origem: 'pessoal', nome: 'minha' }],
    ['/skills/duplicar', { pasta: PROJ, origem: 'projeto', nome: 'revisar', destino: 'pessoal', novoNome: 'rev-global' }],
    ['/skills/arquivo', { pasta: PROJ, origem: 'pessoal', nome: 'minha', caminho: 'a.txt', texto: 'x' }],
  ]) assert.equal((await chamar('POST', rota, corpo)).status, 428, rota);
  assert.ok(fs.existsSync(path.join(PESS_SK, 'minha', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(PESS_SK, 'rev-global')), false);
  const ok = await chamar('POST', '/skills/salvar', { pasta: PROJ, origem: 'pessoal', nome: 'global-x', descricao: 'x', corpo: '', confirmarGlobal: true });
  assert.equal(ok.status, 200);
  assert.ok(fs.existsSync(path.join(PESS_SK, 'global-x', 'SKILL.md')));
});

test('editar e renomear (a pasta e o name do cabeçalho juntos)', async () => {
  const lida = await chamar('GET', '/skills/ler' + qs({ pasta: PROJ, origem: 'projeto', nome: 'nova-skill' }));
  assert.equal(lida.corpo.extra, 'allowed-tools: Read');
  const r = await chamar('POST', '/skills/salvar', { pasta: PROJ, origem: 'projeto', nomeAntigo: 'nova-skill', nome: 'renomeada', descricao: 'Outra descrição', corpo: lida.corpo.corpo + 'mais\n', extra: lida.corpo.extra });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(fs.existsSync(path.join(PROJ_SK, 'nova-skill')), false);
  const f = lerSkillMd(fs.readFileSync(path.join(PROJ_SK, 'renomeada', 'SKILL.md'), 'utf8'));
  assert.equal(f.campos.name, 'renomeada');
  assert.match(f.corpo, /mais/);
  assert.equal((await chamar('POST', '/skills/salvar', { pasta: PROJ, origem: 'projeto', nomeAntigo: 'some', nome: 'some', descricao: 'x' })).status, 404);
});

test('duplicar a do claude.ai para o projeto (cópia editável, com os arquivos)', async () => {
  fs.mkdirSync(path.join(PESS_SK, 'synced', 'balde1', 'docs', 'ref'), { recursive: true });
  fs.writeFileSync(path.join(PESS_SK, 'synced', 'balde1', 'docs', 'ref', 'guia.md'), 'guia');
  const r = await chamar('POST', '/skills/duplicar', { pasta: PROJ, origem: 'claude.ai', nome: 'docs', destino: 'projeto', novoNome: 'docs-meu' });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(lerSkillMd(fs.readFileSync(path.join(PROJ_SK, 'docs-meu', 'SKILL.md'), 'utf8')).campos.name, 'docs-meu');
  assert.equal(fs.readFileSync(path.join(PROJ_SK, 'docs-meu', 'ref', 'guia.md'), 'utf8'), 'guia');
  assert.deepEqual(r.corpo.skill.arquivos.map((a) => a.caminho), ['ref/guia.md']);
  // A sincronizada não se edita nem se exclui.
  assert.equal((await chamar('POST', '/skills/salvar', { pasta: PROJ, origem: 'claude.ai', nome: 'docs', descricao: 'x' })).status, 400);
  assert.equal((await chamar('POST', '/skills/excluir', { pasta: PROJ, origem: 'claude.ai', nome: 'docs' })).status, 400);
});

test('arquivos de apoio: criar, ler, recusar caminho fora da skill, excluir para a Lixeira', async () => {
  const base = { pasta: PROJ, origem: 'projeto', nome: 'renomeada' };
  const r = await chamar('POST', '/skills/arquivo', { ...base, caminho: 'scripts/ajuda.mjs', texto: 'console.log(1)\n', novo: true });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.deepEqual(r.corpo.arquivos.map((a) => [a.caminho, a.texto]), [['scripts/ajuda.mjs', true]]);
  assert.equal((await chamar('POST', '/skills/arquivo', { ...base, caminho: 'scripts/ajuda.mjs', texto: 'x', novo: true })).status, 409);
  const lido = await chamar('GET', '/skills/arquivo' + qs({ ...base, arq: 'scripts/ajuda.mjs' }));
  assert.equal(lido.corpo.texto, 'console.log(1)\n');
  for (const mau of ['../fora.txt', 'a/../../b', path.join(RAIZ, 'abs.txt'), 'C:/x.txt', 'SKILL.md', 'a//b']) {
    assert.equal((await chamar('POST', '/skills/arquivo', { ...base, caminho: mau, texto: 'x' })).status, 400, mau);
  }
  assert.equal(fs.existsSync(path.join(PROJ_SK, 'fora.txt')), false);
  fs.writeFileSync(path.join(PROJ_SK, 'renomeada', 'img.bin'), Buffer.from([1, 0, 2]));
  assert.equal((await chamar('GET', '/skills/arquivo' + qs({ ...base, arq: 'img.bin' }))).status, 415);
  const ex = await chamar('POST', '/skills/arquivo/excluir', { ...base, caminho: 'scripts/ajuda.mjs' });
  assert.equal(ex.status, 200);
  assert.ok(lixeira.some((a) => a.endsWith('ajuda.mjs')));
});

test('excluir manda a pasta da skill para a Lixeira', async () => {
  const r = await chamar('POST', '/skills/excluir', { pasta: PROJ, origem: 'projeto', nome: 'docs-meu' });
  assert.equal(r.status, 200);
  assert.equal(fs.existsSync(path.join(PROJ_SK, 'docs-meu')), false);
  assert.ok(lixeira.some((a) => a.endsWith('docs-meu')));
  assert.equal((await chamar('POST', '/skills/excluir', { pasta: PROJ, origem: 'projeto', nome: '../proj' })).status, 400);
});

// ───────────────────────── ativo / inativo ─────────────────────────
test('estado: grava só o skillOverrides do .claude/settings.json do projeto', async () => {
  linhasSonda = null;
  sk.invalidar();
  const arq = path.join(PROJ, '.claude', 'settings.json');
  let r = await chamar('POST', '/skills/estado', { pasta: PROJ, chave: 'revisar', estado: 'off' });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  let j = JSON.parse(fs.readFileSync(arq, 'utf8'));
  assert.deepEqual(j, { hooks: { SessionStart: [] }, skillOverrides: { revisar: 'off' } });
  // Ligar apaga a chave (e o skillOverrides vazio sai).
  r = await chamar('POST', '/skills/estado', { pasta: PROJ, chave: 'revisar', estado: 'on' });
  j = JSON.parse(fs.readFileSync(arq, 'utf8'));
  assert.deepEqual(j, { hooks: { SessionStart: [] } });
  // Ligar o que o settings pessoal desliga: grava "on" no projeto (vence o pessoal).
  await chamar('POST', '/skills/estado', { pasta: PROJ, chave: 'minha', estado: 'on' });
  assert.equal(JSON.parse(fs.readFileSync(arq, 'utf8')).skillOverrides.minha, 'on');
  assert.equal(fs.readFileSync(SET_PESS, 'utf8'), pessoalAntes, 'o settings pessoal não muda');
  // Uma entrada no settings.local.json do projeto sai junto.
  const loc = path.join(PROJ, '.claude', 'settings.local.json');
  fs.writeFileSync(loc, JSON.stringify({ permissions: { allow: ['Read'] }, skillOverrides: { revisar: 'on' } }));
  r = await chamar('POST', '/skills/estado', { pasta: PROJ, chave: 'revisar', estado: 'off' });
  assert.equal(r.corpo.local, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(loc, 'utf8')), { permissions: { allow: ['Read'] } });
  const l = await chamar('GET', '/skills' + qs({ pasta: PROJ }));
  assert.equal(l.corpo.skills.find((s) => s.id === 'projeto:revisar').estado, 'off');
  assert.equal(l.corpo.skills.find((s) => s.id === 'projeto:revisar').noProjeto, 'off');
  assert.equal((await chamar('POST', '/skills/estado', { pasta: PROJ, chave: 'revisar', estado: 'talvez' })).status, 400);
  assert.equal((await chamar('POST', '/skills/estado', { pasta: CASA, chave: 'revisar', estado: 'off' })).status, 403);
});

test('estado: travada (plugin) e JSON inválido recusam sem gravar', async () => {
  sk.invalidar();
  linhasSonda = [{ name: 'prod:start', display_name: 'prod:start', description: 'P', source: 'plugin', tokens: 5, state: 'on', locked_by: 'plugin', advertised: true, handles: {} }];
  const arq = path.join(PROJ, '.claude', 'settings.json');
  const antes = fs.readFileSync(arq, 'utf8');
  const r = await chamar('POST', '/skills/estado', { pasta: PROJ, chave: 'prod:start', estado: 'off' });
  assert.equal(r.status, 409);
  assert.equal(r.corpo.codigo, 'travada');
  assert.equal(fs.readFileSync(arq, 'utf8'), antes);
  fs.writeFileSync(arq, '{ ruim');
  assert.equal((await chamar('POST', '/skills/estado', { pasta: PROJ, chave: 'revisar', estado: 'on' })).status, 409);
  assert.equal(fs.readFileSync(arq, 'utf8'), '{ ruim');
  fs.writeFileSync(arq, antes);
  linhasSonda = null;
  sk.invalidar();
});

// ───────────────────────── usadas por sessão ─────────────────────────
const L = (o) => JSON.stringify(o) + '\n';
test('uso: Skill do modelo, /skill digitada (e /clear não conta)', () => {
  const est = novaLeituraUso();
  lerLinhasUso(est, [
    L({ type: 'assistant', timestamp: '2026-10-17T01:00:00Z', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'dataviz' } }] } }),
    L({ type: 'user', timestamp: '2026-10-17T01:01:00Z', message: { content: '<command-name>/clear</command-name>' } }),
    L({ type: 'user', timestamp: '2026-10-17T01:01:01Z', message: { content: 'oi' } }),
    L({ type: 'user', timestamp: '2026-10-17T01:02:00Z', message: { content: '<command-message>claud-brain</command-message>\n<command-name>/claud-brain</command-name>\n<command-args>sync</command-args>' } }),
    L({ type: 'user', timestamp: '2026-10-17T01:02:00Z', message: { content: [{ type: 'text', text: 'Base directory for this skill: D:\\x\n# claud-brain' }] } }),
    L({ type: 'assistant', timestamp: '2026-10-17T01:03:00Z', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'dataviz', args: 'x' } }] } }),
  ].join(''));
  assert.deepEqual(resumoUso(est), [
    { nome: 'dataviz', vezes: 2, primeira: '2026-10-17T01:00:00Z', ultima: '2026-10-17T01:03:00Z', por: ['modelo'] },
    { nome: 'claud-brain', vezes: 1, primeira: '2026-10-17T01:02:00Z', ultima: '2026-10-17T01:02:00Z', por: ['voce'] },
  ]);
});

test('GET /skills/sessao: leitura incremental do transcript e a allowlist da instância', async () => {
  const arq = path.join(RAIZ, 't.jsonl');
  fs.writeFileSync(arq, L({ type: 'assistant', timestamp: '2026-10-17T02:00:00Z', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'revisar' } }] } }) + '{"type":"assist');
  SESSOES.set('orbit-1', { id: 'orbit-1', _transcript: arq });
  let r = await chamar('GET', '/skills/sessao' + qs({ id: 'orbit-1' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.corpo.usadas.map((u) => [u.nome, u.vezes]), [['revisar', 1]]);
  assert.deepEqual(r.corpo.permitidas, ['revisar']);
  // A linha que estava pela metade termina depois.
  fs.appendFileSync(arq, 'ant","timestamp":"2026-10-17T02:05:00Z","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"revisar"}}]}}\n');
  r = await chamar('GET', '/skills/sessao' + qs({ id: 'orbit-1' }));
  assert.deepEqual(r.corpo.usadas.map((u) => [u.nome, u.vezes]), [['revisar', 2]]);
  SESSOES.set('fora', { id: 'fora', _transcript: '' });
  r = await chamar('GET', '/skills/sessao' + qs({ id: 'fora' }));
  assert.deepEqual(r.corpo, { id: 'fora', usadas: [], permitidas: null, semTranscript: true });
  assert.equal((await chamar('GET', '/skills/sessao' + qs({ id: 'nao' }))).status, 404);
  assert.equal((await chamar('GET', '/outra')).tratou, false);
});
