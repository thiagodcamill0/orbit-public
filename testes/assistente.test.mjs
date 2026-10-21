// Testes do assistente da primeira vez (assistente.mjs) e do hook que só abre o servidor com permissão.
// Rodar:  node testes/assistente.test.mjs
// Sobe um servidor próprio numa porta de teste (47822–47826, conferida livre; nunca a 47821), com a pasta de dados,
// a pasta pessoal, o settings do Claude e as skills todos temporários (nunca o ~/.claude de quem roda), e desliga
// só o processo que subiu. O celular só é testado desligado (ligar abriria a porta do celular).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escolherPorta, desligarSeMeu, portaLivre, FAIXA } from './porta-livre.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47824);
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-assistente-'));
const DADOS = path.join(BASE, 'dados');
const CASA = path.join(BASE, 'casa');
const SETTINGS = path.join(BASE, 'claude', 'settings.json');
const SKILLS = path.join(BASE, 'claude', 'skills');
const PROJETOS = path.join(BASE, 'meus projetos');
for (const p of [DADOS, CASA, path.join(DADOS, 'sessoes'), path.join(BASE, 'local')]) fs.mkdirSync(p, { recursive: true });
const ENV = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_SESSOES_DIR: path.join(DADOS, 'sessoes'),
  GERENCIADOR_SETTINGS: SETTINGS,
  GERENCIADOR_SKILLS: SKILLS,
  GERENCIADOR_CLAUDE_HOME: CASA,
  ORBIT_ASSISTENTE: '1', // servidor de teste com o assistente por fazer
  USERPROFILE: CASA,
  HOME: CASA,
  LOCALAPPDATA: path.join(BASE, 'local'),
  APPDATA: path.join(BASE, 'local'),
};
delete ENV.CLAUDE_CODE_HOST_SESSION_ID;
delete ENV.CLAUDE_PROJECT_DIR;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const barra = (p) => p.replace(/\\/g, '/').toLowerCase();
const HOOK = barra(path.join(RAIZ, 'hook.mjs'));
const AVISO = barra(path.join(RAIZ, 'aviso-subagente.mjs'));

function pedir(metodo, rota, corpo) {
  return new Promise((resolve, reject) => {
    const h = { 'x-gerenciador': '1' };
    const txt = corpo === undefined ? undefined : JSON.stringify(corpo);
    if (txt !== undefined) Object.assign(h, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(txt) });
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers: h, timeout: 40000, agent: false }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        let json;
        try { json = JSON.parse(texto); } catch {}
        resolve({ status: res.statusCode, json, texto });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (txt !== undefined) req.write(txt);
    req.end();
  });
}

// Hooks do Orbit no settings de teste: { hooks, subir, aviso }.
function lerSettings() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch {}
  const todos = Object.values(c.hooks || {}).flat().flatMap((g) => g.hooks || []);
  const doHook = todos.filter((h) => (h.args || []).some((x) => barra(x) === HOOK));
  return { n: doHook.length, subir: doHook.filter((h) => h.args.includes('--subir')).length, aviso: todos.filter((h) => (h.args || []).some((x) => barra(x) === AVISO)).length };
}
const arqSkill = path.join(SKILLS, 'liderar-time', 'SKILL.md');

let proc = null;
after(async () => {
  if (proc) {
    const saiu = new Promise((r) => proc.once('exit', r));
    await desligarSeMeu(PORTA, proc.pid);
    await Promise.race([saiu, espera(3000)]);
    if (proc.exitCode == null) { try { proc.kill(); } catch {} }
  }
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
});

test('sobe o servidor de teste', async () => {
  proc = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env: ENV, stdio: 'ignore' });
  let ok = false;
  for (let i = 0; i < 200 && !ok; i++) {
    try { ok = (await pedir('GET', '/saude')).json?.pid === proc.pid; } catch {}
    if (!ok) await espera(50);
  }
  assert.ok(ok, 'servidor não subiu');
});

test('primeira vez: assistente por fazer, nada instalado, celular desligado', async () => {
  const r = await pedir('GET', '/assistente');
  assert.equal(r.status, 200);
  assert.equal(r.json.feito, false);
  assert.equal(r.json.nome, '');
  assert.ok(r.json.nomeSistema, 'nome da conta do sistema');
  assert.equal(barra(r.json.pastaProjetos), barra(path.dirname(RAIZ)), 'padrão: a pasta de cima da do Orbit');
  assert.deepEqual(r.json.instalacao, { hooks: false, subir: false, aviso: false, liderar: 'nao' });
  assert.equal(r.json.celular, false);
});

test('concluir: nome, pasta de projetos, hooks com aviso e skill, sem abrir sozinho', async () => {
  const r = await pedir('POST', '/assistente/concluir', { nome: '  Ana  ', pastaProjetos: PROJETOS, hooks: true, aviso: true, subir: false, liderar: true, celular: false });
  assert.equal(r.status, 200, r.texto);
  assert.ok(r.json.passos.every((p) => p.ok), JSON.stringify(r.json.passos));
  assert.equal(r.json.estado.feito, true);
  assert.equal(r.json.estado.nome, 'Ana');
  assert.deepEqual(r.json.estado.instalacao, { hooks: true, subir: false, aviso: true, liderar: 'orbit' });
  const s = lerSettings();
  assert.equal(s.n, 12, '12 eventos');
  assert.equal(s.subir, 0, 'sem --subir');
  assert.equal(s.aviso, 1);
  assert.ok(fs.statSync(PROJETOS).isDirectory(), 'pasta de projetos criada');
  assert.equal(barra((await pedir('GET', '/repos/projetos')).json.pastaClones), barra(PROJETOS));
  assert.equal((await pedir('GET', '/perfil')).json.nome, 'Ana', 'o perfil usa o nome do assistente');
  const skill = fs.readFileSync(arqSkill, 'utf8');
  assert.ok(skill.includes(path.join(DADOS, 'progresso').replace(/\\/g, '/')), 'skill com a pasta de progresso dos dados');
  assert.ok(!skill.includes('{{PROGRESSO}}'));
  assert.equal((await pedir('GET', '/config')).json.remoto.ativo, false);
});

test('concluir de novo: abrir sozinho sim, aviso e skill não', async () => {
  const r = await pedir('POST', '/assistente/concluir', { hooks: true, aviso: false, subir: true, liderar: false });
  assert.ok(r.json.passos.every((p) => p.ok), JSON.stringify(r.json.passos));
  assert.deepEqual(r.json.estado.instalacao, { hooks: true, subir: true, aviso: false, liderar: 'nao' });
  const s = lerSettings();
  assert.equal(s.n, 12);
  assert.equal(s.subir, 12);
  assert.equal(s.aviso, 0);
  assert.ok(!fs.existsSync(arqSkill));
  assert.equal(r.json.estado.nome, 'Ana', 'sem nome no corpo, o nome fica');
});

test('skill de usuário com o mesmo nome nunca é tocada', async () => {
  fs.mkdirSync(path.dirname(arqSkill), { recursive: true });
  fs.writeFileSync(arqSkill, 'minha skill');
  const r = await pedir('POST', '/assistente/concluir', { hooks: true, aviso: false, subir: true, liderar: true });
  assert.equal(fs.readFileSync(arqSkill, 'utf8'), 'minha skill');
  assert.equal(r.json.estado.instalacao.liderar, 'usuario');
  fs.rmSync(path.dirname(arqSkill), { recursive: true, force: true });
});

test('sem hooks: tira os do Orbit; a skill sozinha vale', async () => {
  const r = await pedir('POST', '/assistente/concluir', { hooks: false, aviso: true, subir: true, liderar: true });
  assert.ok(r.json.passos.every((p) => p.ok), JSON.stringify(r.json.passos));
  assert.deepEqual(r.json.estado.instalacao, { hooks: false, subir: false, aviso: false, liderar: 'orbit' });
  assert.deepEqual(lerSettings(), { n: 0, subir: 0, aviso: 0 });
  const r2 = await pedir('POST', '/assistente/concluir', { hooks: false, liderar: false });
  assert.equal(r2.json.estado.instalacao.liderar, 'nao');
});

test('pasta de projetos dentro do Orbit ou inválida: recusa e não marca como feito', async () => {
  await pedir('POST', '/assistente/refazer', {});
  for (const p of [path.join(RAIZ, 'sub'), 'relativa/pasta']) {
    const r = await pedir('POST', '/assistente/concluir', { pastaProjetos: p });
    const passo = r.json.passos.find((x) => x.passo === 'pasta');
    assert.equal(passo.ok, false, p);
    assert.equal(r.json.estado.feito, false);
  }
  assert.ok(!fs.existsSync(path.join(RAIZ, 'sub')));
  assert.equal(barra((await pedir('GET', '/repos/projetos')).json.pastaClones), barra(PROJETOS), 'a pasta antiga fica');
});

test('refazer e pular; nome vazio volta ao da conta do sistema', async () => {
  assert.equal((await pedir('POST', '/assistente/refazer', {})).json.feito, false);
  assert.equal((await pedir('GET', '/config')).json.assistente.feito, false);
  assert.equal((await pedir('POST', '/assistente/pular', {})).json.feito, true);
  const r = await pedir('POST', '/assistente/concluir', { nome: '' });
  assert.equal(r.json.estado.nome, '');
  assert.equal((await pedir('GET', '/perfil')).json.nome, r.json.estado.nomeSistema);
});

test('hook sem --subir não abre o servidor quando ele está fechado', async () => {
  let livre = 0;
  for (const p of FAIXA) if (p !== PORTA && (await portaLivre(p))) { livre = p; break; }
  assert.ok(livre, 'uma porta de teste livre');
  const dadosHook = path.join(BASE, 'dados-hook');
  const p = spawn(process.execPath, [path.join(RAIZ, 'hook.mjs')], { env: { ...ENV, GERENCIADOR_PORTA: String(livre), GERENCIADOR_DADOS: dadosHook }, stdio: ['pipe', 'ignore', 'ignore'] });
  const t0 = Date.now();
  p.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'sem-subir', cwd: BASE, prompt: 'oi' }));
  const codigo = await new Promise((r) => p.on('exit', r));
  assert.equal(codigo, 0);
  assert.ok(Date.now() - t0 < 1500, 'desiste logo');
  await espera(1500);
  assert.equal(await portaLivre(livre), true, 'nenhum servidor subiu');
  assert.ok(!fs.existsSync(dadosHook), 'nada gravado');
});
