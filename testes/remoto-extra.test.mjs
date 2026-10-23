// Rotas remotas novas do celular premium (onda 1, Backend): ideias, histórico, resumoDia, uso, notificações, grafo e
// arquivos do app. Ver o contrato "Celular premium" > "Rotas remotas novas". Rodar:  node --test testes/remoto-extra.test.mjs
// Sobe um servidor próprio em 47822–47826 (porta local e remota conferidas livres, nunca a 47821); dados, projetos,
// brain e Tailscale são falsos e ficam fora da pasta do Orbit. No fim desliga só o que subiu e apaga a pasta temporária.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escolherPorta, portaLivre, desligarSeMeu, FAIXA } from './porta-livre.mjs';
import { matarArvore } from '../plataforma.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47823);
let PORTA_R = 0;
for (const p of FAIXA) if (p !== PORTA && (await portaLivre(p))) { PORTA_R = p; break; }
if (!PORTA_R) throw new Error('sem 2ª porta livre em 47822–47826 para a porta remota');

const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-remoto-extra-'));
const SESSOES = path.join(DADOS, 'sessoes');
const PROJETOS = path.join(DADOS, 'projetos');
const PROJ = path.join(DADOS, 'cwd', 'proj'); // cadastrado, com brain próprio
const SEM = path.join(DADOS, 'cwd', 'sem'); // cadastrado, sem brain
const DONO_ORBIT = path.join(DADOS, 'cwd', path.basename(RAIZ)); // cadastrado com o nome do projeto do Orbit: usa o cofre padrão
const FORA = path.join(DADOS, 'cwd', 'fora'); // não cadastrado
const BRAIN = path.join(DADOS, 'brain-proj');
const COFRE = path.join(DADOS, 'cofre');
const CASA = path.join(DADOS, 'casa');
for (const d of [SESSOES, PROJETOS, PROJ, SEM, DONO_ORBIT, FORA, BRAIN, COFRE, CASA]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(BRAIN, 'a.md'), '# A\nveja [[b]]\n');
fs.writeFileSync(path.join(BRAIN, 'b.md'), '# B\n');
fs.mkdirSync(path.join(BRAIN, '.oculta'));
fs.writeFileSync(path.join(BRAIN, '.oculta', 'x.md'), 'segredo');
fs.writeFileSync(path.join(DADOS, 'segredo.md'), 'fora do brain');
fs.writeFileSync(path.join(COFRE, 'cofre.md'), '# Cofre\n');
const HOST = 'orbit-teste.exemplo.ts.net';
const DONO = 'dono@exemplo.com';
const ORIGEM = `https://${HOST}`;
const TS = path.join(DADOS, 'tailscale-falso.json');
fs.writeFileSync(TS, JSON.stringify({
  status: { BackendState: 'Running', Self: { DNSName: HOST + '.', UserID: 7 }, User: { 7: { LoginName: DONO } } },
  serve: {},
}));
const agora = new Date().toISOString();
fs.writeFileSync(path.join(DADOS, 'config.json'), JSON.stringify({ remoto: { porta: PORTA_R, criarInstancias: true }, projetos: { proj: { brain: BRAIN } } }));
fs.writeFileSync(path.join(DADOS, 'projetos.json'), JSON.stringify({ lista: [
  { nome: 'proj', pasta: PROJ, desde: agora },
  { nome: 'sem', pasta: SEM, desde: agora },
  { nome: path.basename(RAIZ), pasta: DONO_ORBIT, desde: agora },
], ocultos: [] }));
const ENV = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_TICK_MS: '250',
  GERENCIADOR_PID_MS: '300',
  GERENCIADOR_SESSOES_DIR: SESSOES,
  GERENCIADOR_CASA: CASA,
  ORBIT_PROJETOS_DIR: PROJETOS,
  ORBIT_COFRE: COFRE,
  ...(WIN ? {} : { HOME: path.join(DADOS, 'home') }),
  ORBIT_CLAUDE_BIN: path.join(RAIZ, 'testes', 'claude-falso.mjs'),
  ORBIT_MODELOS: '0',
  ORBIT_MS_REGISTRO: '200',
  ORBIT_MS_VIGIA: '100',
  ORBIT_MS_INICIO: '4000',
  ORBIT_TAILSCALE_FALSO: TS,
  CLAUDE_CODE_ENTRYPOINT: 'teste',
};
delete ENV.CLAUDE_CODE_HOST_SESSION_ID;
delete ENV.CLAUDECODE;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function pedirEm(porta, metodo, rota, { headers = {}, corpo } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    const dados = corpo === undefined ? undefined : typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
    if (dados !== undefined) h['content-length'] = Buffer.byteLength(dados);
    const req = http.request({ host: '127.0.0.1', port: porta, path: rota, method: metodo, headers: h, timeout: 20000, agent: false }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        let json;
        try { json = JSON.parse(texto); } catch {}
        resolve({ status: res.statusCode, json, texto, headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (dados !== undefined) req.write(dados);
    req.end();
  });
}
const local = (metodo, rota, corpo) => pedirEm(PORTA, metodo, rota, { headers: { 'x-gerenciador': '1', ...(corpo !== undefined ? { 'content-type': 'application/json' } : {}) }, corpo });
let token = '';
function remoto(metodo, rota, { corpo, headers = {}, semCookie = false } = {}) {
  const h = { host: HOST, 'tailscale-user-login': DONO, ...(token && !semCookie ? { cookie: `__Host-orbit=${token}` } : {}) };
  if (metodo === 'POST') Object.assign(h, { origin: ORIGEM, 'content-type': 'application/json' });
  Object.assign(h, headers);
  return pedirEm(PORTA_R, metodo, rota, { headers: h, corpo: metodo === 'POST' ? (corpo ?? {}) : corpo });
}
async function esperarQue(cond, ms = 8000, rotulo = 'condição') {
  const fim = Date.now() + ms;
  let ultimo;
  while (Date.now() < fim) {
    ultimo = await cond();
    if (ultimo) return ultimo;
    await espera(60);
  }
  throw new Error(`${rotulo} não aconteceu em ${ms} ms (último: ${JSON.stringify(ultimo)})`);
}

let proc = null;
const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
after(async () => {
  if (proc) {
    const saiu = new Promise((r) => proc.once('exit', r));
    await desligarSeMeu(PORTA, proc.pid);
    await Promise.race([saiu, espera(4000)]);
    if (proc.exitCode == null) { try { proc.kill(); } catch {} }
  }
  let m = null;
  try { m = JSON.parse(fs.readFileSync(path.join(DADOS, 'motor.json'), 'utf8')); } catch {}
  if (m?.pid && vivo(m.pid)) {
    try {
      if (WIN) execFileSync('taskkill', ['/PID', String(m.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else await matarArvore(m.pid);
    } catch {}
  }
  await espera(300);
  try { fs.rmSync(DADOS, { recursive: true, force: true }); } catch {}
});

test('sobe o servidor, liga o remoto e pareia um aparelho', async () => {
  proc = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => process.stderr.write('[servidor] ' + d));
  await esperarQue(async () => (await local('GET', '/saude').catch(() => ({}))).json?.pid === proc.pid, 10000, 'servidor no ar');
  const r = await local('POST', '/remoto/config', { ativo: true, criarInstancias: true });
  assert.equal(r.status, 200, r.texto);
  const p = await remoto('POST', '/remoto/parear/pedir', { corpo: { nome: 'iPhone extra' }, semCookie: true });
  assert.equal(p.status, 200, p.texto);
  const codigo = (await local('GET', '/remoto/estado')).json.pedido.codigo;
  const c = await remoto('POST', '/remoto/parear/confirmar', { corpo: { pedido: p.json.pedido, codigo }, semCookie: true });
  assert.equal(c.status, 200, c.texto);
  token = /__Host-orbit=([^;]+)/.exec(String(c.headers['set-cookie'] || ''))?.[1];
  assert.ok(token);
});

test('sem cookie, as rotas novas dão 401', async () => {
  for (const [m, r] of [['GET', '/ideias'], ['GET', '/remoto/historico'], ['GET', '/remoto/notificacoes'], ['GET', `/remoto/grafo?projeto=${encodeURIComponent(PROJ)}`], ['POST', '/ideias/nova'], ['POST', '/uso/atualizar'], ['POST', '/remoto/nao-perturbe'], ['POST', '/remoto/notificar']]) {
    const x = await remoto(m, r, { semCookie: true });
    assert.equal(x.status, 401, `${m} ${r}`);
  }
});

test('ideias: GET e as quatro ações (nova, editar, feita, apagar) valem no celular; corpo inválido = 400', async () => {
  const lista = await remoto('GET', '/ideias');
  assert.equal(lista.status, 200, lista.texto);
  assert.ok(Array.isArray(lista.json.ideias));
  const nova = await remoto('POST', '/ideias/nova', { corpo: { texto: 'ideia do celular' } });
  assert.equal(nova.status, 200, nova.texto);
  const id = nova.json.id;
  assert.ok(id);
  assert.ok((await remoto('GET', '/ideias')).json.ideias.some((i) => i.id === id && i.texto === 'ideia do celular'));
  assert.equal((await remoto('POST', '/ideias/editar', { corpo: { id, texto: 'editada' } })).status, 200);
  assert.ok((await remoto('GET', '/ideias')).json.ideias.some((i) => i.id === id && i.texto === 'editada'));
  assert.equal((await remoto('POST', '/ideias/feita', { corpo: { id, feita: true } })).status, 200);
  assert.ok((await remoto('GET', '/ideias')).json.ideias.some((i) => i.id === id && i.feita === true));
  // no PC (47821) a mesma lista
  assert.ok((await local('GET', '/ideias')).json.ideias.some((i) => i.id === id));
  for (const [rota, corpo] of [['/ideias/nova', { texto: '' }], ['/ideias/nova', { texto: 5 }], ['/ideias/nova', { texto: 'x', extra: 1 }], ['/ideias/nova', { texto: 'x'.repeat(20001) }],
    ['/ideias/editar', { id: '../x', texto: 'a' }], ['/ideias/editar', { texto: 'a' }], ['/ideias/feita', { id, feita: 'sim' }], ['/ideias/apagar', { id: 3 }]]) {
    const x = await remoto('POST', rota, { corpo });
    assert.equal(x.status, 400, `${rota} ${JSON.stringify(corpo).slice(0, 40)}: ${x.texto}`);
  }
  assert.equal((await remoto('POST', '/ideias/apagar', { corpo: { id } })).status, 200);
  assert.ok(!(await remoto('GET', '/ideias')).json.ideias.some((i) => i.id === id));
  // a rota crua do PC segue fechada
  assert.equal((await remoto('POST', '/ideias', { corpo: { texto: 'x' } })).status, 403);
});

test('POST /uso/atualizar é aceito no celular (a leitura em si pode falhar, mas nunca 403/404)', async () => {
  const r = await remoto('POST', '/uso/atualizar');
  assert.ok([200, 409, 502].includes(r.status), `${r.status} ${r.texto}`);
  assert.equal((await remoto('POST', '/uso')).status, 403, '/uso (gravar) segue fechada');
});

test('P2-11: /uso/atualizar pelo celular no máximo 1 vez a cada 30 s por aparelho (429); a 47821 não limita', async () => {
  await remoto('POST', '/uso/atualizar'); // garante que já houve uma leitura nesta janela
  const r = await remoto('POST', '/uso/atualizar');
  assert.equal(r.status, 429, r.texto);
  assert.equal(r.json.codigo, 'muitos_pedidos');
  assert.ok(typeof r.json.erro === 'string' && r.json.erro.length > 5);
  for (let i = 0; i < 2; i++) assert.notEqual((await local('POST', '/uso/atualizar', {})).status, 429, 'o PC não é limitado');
  assert.notEqual((await remoto('POST', '/uso/atualizar', { semCookie: true })).status, 200, 'sem cookie continua 401');
});

test('nativas x VS Code: histórico só das nativas, sem cwd nem ultimaResposta; resumoDia só das nativas', async () => {
  const ev = (id, extra = {}) => local('POST', '/evento', { session_id: id, hook_event_name: 'UserPromptSubmit', cwd: PROJ, prompt: 'oi', ts: Date.now(), ...extra });
  await ev('vscode-h');
  const cr = await remoto('POST', '/instancias', { corpo: { pasta: PROJ, cwd: PROJ, permissao: 'default', nome: 'nativa h' } });
  assert.equal(cr.status, 202, cr.texto);
  const nid = cr.json.sessao;
  // a nativa tem um turno a mais pelo hook; a do VS Code também (só ela fica de fora do resumo do celular)
  const antes = (await remoto('GET', '/estado')).json.resumoDia;
  await ev(nid, { prompt: 'segundo' });
  await ev('vscode-h', { prompt: 'de novo' });
  const dep = (await remoto('GET', '/estado')).json.resumoDia;
  assert.equal(dep.turnos - antes.turnos, 1, 'só o turno da nativa conta no celular');
  const pc = (await local('GET', '/estado')).json.resumoDia;
  assert.ok(pc.turnos >= dep.turnos + 2, `o PC conta também os do VS Code (pc ${pc.turnos}, celular ${dep.turnos})`);
  assert.deepEqual(Object.keys(dep).sort(), ['data', 'esperas', 'msAguardando', 'msTrabalhando', 'sessoes', 'turnos']);
  assert.equal(dep.sessoes, 1);
  assert.ok(pc.sessoes >= 2);
  // histórico: alertas de "terminou" das duas; o celular vê só o da nativa
  await ev('vscode-h', { hook_event_name: 'Stop', last_assistant_message: 'resposta secreta do vscode' });
  await ev(nid, { hook_event_name: 'Stop', last_assistant_message: 'resposta secreta da nativa' });
  const hpc = await esperarQue(async () => { const h = (await local('GET', '/historico')).json; return h.some((a) => a.sessao.id === nid) && h.some((a) => a.sessao.id === 'vscode-h') && h; }, 6000, 'alertas no histórico');
  assert.ok(hpc.every((a) => typeof a.sessao.cwd === 'string'), 'o PC segue com cwd');
  const h = await remoto('GET', '/remoto/historico');
  assert.equal(h.status, 200, h.texto);
  assert.ok(Array.isArray(h.json) && h.json.length >= 1);
  assert.ok(h.json.every((a) => a.sessao.id === nid), 'só nativas');
  for (const a of h.json) {
    assert.ok(!('cwd' in a.sessao) && !('ultimaResposta' in a.sessao), 'sem cwd nem ultimaResposta');
    assert.equal(a.sessao.projeto, 'proj');
  }
  assert.ok(!h.texto.includes(PROJ.replaceAll('\\', '\\\\')) && !h.texto.includes(DADOS.replaceAll('\\', '\\\\')), 'o caminho do PC não vaza');
  assert.ok(!h.texto.includes('resposta secreta'));
  // /historico cru do PC segue fechado no celular
  assert.equal((await remoto('GET', '/historico')).status, 403);
});

test('notificações: GET, Não perturbe e notificar validam e persistem; /config segue 403', async () => {
  const g = await remoto('GET', '/remoto/notificacoes');
  assert.equal(g.status, 200, g.texto);
  assert.deepEqual(g.json.naoPerturbe, { ativo: false, agendado: false, inicio: '22:00', fim: '07:00' });
  assert.deepEqual(Object.keys(g.json.notificar).sort(), ['precisa', 'terminou']);
  const ruins = [{}, { ativo: true }, { ativo: 'sim', agendado: false, inicio: '22:00', fim: '07:00' }, { ativo: true, agendado: true, inicio: '25:00', fim: '07:00' }, { ativo: true, agendado: true, inicio: '22:00', fim: '7h' }, { ativo: true, agendado: true, inicio: '22:00', fim: '07:00', x: 1 }];
  for (const c of ruins) assert.equal((await remoto('POST', '/remoto/nao-perturbe', { corpo: c })).status, 400, JSON.stringify(c));
  assert.deepEqual((await local('GET', '/config')).json.naoPerturbe, { ativo: false, agendado: false, inicio: '22:00', fim: '07:00' }, 'corpo inválido não grava nada');
  const ok = await remoto('POST', '/remoto/nao-perturbe', { corpo: { ativo: true, agendado: true, inicio: '23:15', fim: '06:45' } });
  assert.equal(ok.status, 200, ok.texto);
  assert.deepEqual(ok.json.naoPerturbe, { ativo: true, agendado: true, inicio: '23:15', fim: '06:45' });
  assert.deepEqual((await local('GET', '/config')).json.naoPerturbe, { ativo: true, agendado: true, inicio: '23:15', fim: '06:45' }, 'persistiu no PC');
  assert.deepEqual((await remoto('GET', '/remoto/notificacoes')).json.naoPerturbe, { ativo: true, agendado: true, inicio: '23:15', fim: '06:45' });
  for (const c of [{}, { precisa: 'sim' }, { terminou: 1 }, { precisa: true, x: 1 }]) assert.equal((await remoto('POST', '/remoto/notificar', { corpo: c })).status, 400, JSON.stringify(c));
  const n = await remoto('POST', '/remoto/notificar', { corpo: { precisa: false, terminou: true } });
  assert.equal(n.status, 200, n.texto);
  assert.deepEqual(n.json.notificar, { precisa: false, terminou: true });
  assert.deepEqual((await remoto('GET', '/remoto/notificacoes')).json.notificar, { precisa: false, terminou: true });
  assert.deepEqual((await local('GET', '/config')).json.remoto.notificar, { precisa: false, terminou: true }, 'persistiu em config.remoto.notificar');
  // só um campo muda só ele
  assert.deepEqual((await remoto('POST', '/remoto/notificar', { corpo: { precisa: true } })).json.notificar, { precisa: true, terminou: true });
  assert.equal((await remoto('GET', '/config')).status, 403);
  assert.equal((await remoto('POST', '/config', { corpo: { naoPerturbe: { ativo: false } } })).status, 403);
  assert.equal((await local('GET', '/config')).json.naoPerturbe.ativo, true, 'o POST /config bloqueado não mexeu');
});

const grafo = (pasta) => remoto('GET', `/remoto/grafo?projeto=${encodeURIComponent(pasta)}`);
const nota = (pasta, id) => remoto('GET', `/remoto/grafo/nota?projeto=${encodeURIComponent(pasta)}&id=${encodeURIComponent(id)}`);
test('grafo: projeto cadastrado ok; pasta livre, ../ e nota fora do brain 403; sem brain 404', async () => {
  const g = await grafo(PROJ);
  assert.equal(g.status, 200, g.texto);
  assert.equal(g.json.pasta, path.basename(BRAIN), 'só o nome da pasta, nunca o caminho');
  assert.ok(!g.texto.includes(DADOS.replaceAll('\\', '\\\\')), 'o caminho do PC não vaza');
  assert.deepEqual(g.json.nos.map((n) => n.id).sort(), ['a.md', 'b.md']);
  assert.ok(g.json.links.length >= 1);
  // pasta fora do cadastro e tentativas de escapar
  for (const p of [FORA, path.join(PROJ, '..', 'fora'), PROJ + '/../fora', '..', '../..', DADOS, os.homedir(), '', BRAIN]) {
    const r = await grafo(p);
    assert.equal(r.status, 403, `grafo ${p}: ${r.texto}`);
  }
  assert.equal((await remoto('GET', '/remoto/grafo')).status, 403, 'sem projeto');
  // notas
  const n = await nota(PROJ, 'a.md');
  assert.equal(n.status, 200, n.texto);
  assert.equal(n.json.id, 'a.md');
  assert.ok(n.json.texto.includes('[[b]]'));
  for (const id of ['../segredo.md', '..\\segredo.md', 'sub/../../segredo.md', path.join(DADOS, 'segredo.md'), '.oculta/x.md', 'a.txt', '', 'a.md\u0000.png']) {
    const r = await nota(PROJ, id);
    assert.equal(r.status, 403, `nota ${JSON.stringify(id)}: ${r.texto}`);
  }
  assert.equal((await nota(PROJ, 'nao-existe.md')).status, 404);
  // revisão 22/10 (P2-5): nota lida por um só handle: pasta .md dá 404; texto com acento e emoji volta inteiro
  fs.mkdirSync(path.join(BRAIN, 'pasta.md'));
  fs.writeFileSync(path.join(BRAIN, 'grande.md'), 'x'.repeat(400001));
  fs.writeFileSync(path.join(BRAIN, 'acento.md'), '# Ação ✓ 日本\n');
  try {
    assert.equal((await nota(PROJ, 'pasta.md')).status, 404, 'pasta .md');
    const gr = await nota(PROJ, 'grande.md');
    assert.equal(gr.status, 413, gr.texto);
    assert.equal(gr.json.erro, 'nota_grande_demais');
    const ac = await nota(PROJ, 'acento.md');
    assert.equal(ac.status, 200, ac.texto);
    assert.equal(ac.json.texto, '# Ação ✓ 日本\n');
  } finally {
    fs.rmSync(path.join(BRAIN, 'pasta.md'), { recursive: true, force: true });
    fs.rmSync(path.join(BRAIN, 'acento.md'), { force: true });
    fs.rmSync(path.join(BRAIN, 'grande.md'), { force: true });
  }
  assert.equal((await nota(FORA, 'a.md')).status, 403, 'nota de pasta não cadastrada');
  // sem brain próprio: 404 sem_brain (o cofre padrão só vale para o projeto do próprio Orbit)
  const sem = await grafo(SEM);
  assert.equal(sem.status, 404, sem.texto);
  assert.equal(sem.json.erro, 'sem_brain');
  assert.equal((await nota(SEM, 'cofre.md')).status, 404);
  // o projeto do próprio Orbit usa o cofre padrão (ORBIT_COFRE de teste)
  const orb = await grafo(DONO_ORBIT);
  assert.equal(orb.status, 200, orb.texto);
  assert.deepEqual(orb.json.nos.map((x) => x.id), ['cofre.md']);
  assert.equal(orb.json.pasta, path.basename(COFRE));
  assert.equal((await nota(DONO_ORBIT, 'cofre.md')).status, 200);
  // POST no grafo não existe no celular
  assert.equal((await remoto('POST', '/remoto/grafo', { corpo: {} })).status, 403);
});

test('arquivos do app: /m e /m/app.css 200; /m/nucleo.js 200 se existir e 404 se não; fora da lista bloqueia; /assets/comum/md.js 200', async () => {
  assert.equal((await remoto('GET', '/m')).status, 200);
  assert.equal((await remoto('GET', '/m/app.css')).status, 200);
  const nucleo = fs.existsSync(path.join(RAIZ, 'mobile', 'nucleo.js'));
  const n = await remoto('GET', '/m/nucleo.js');
  assert.equal(n.status, nucleo ? 200 : 404, `/m/nucleo.js (existe em disco: ${nucleo})`);
  if (nucleo) assert.equal(n.texto, fs.readFileSync(path.join(RAIZ, 'mobile', 'nucleo.js'), 'utf8'));
  for (const r of ['/m/qualquer.js', '/m/../servidor.mjs', '/m/%2e%2e/servidor.mjs', '/m/nucleo.js/x', '/m/grafo.json']) {
    const x = await remoto('GET', r);
    assert.ok([400, 403, 404].includes(x.status), `${r}: ${x.status}`);
    assert.ok(!x.texto.includes('criarRemoto'), r);
  }
  for (const r of ['/assets/comum/md.js', '/assets/comum/icones.js', '/assets/comum/sprites.js', '/assets/comum/cartoes.js', '/assets/comum/componentes.css']) {
    const x = await remoto('GET', r);
    assert.equal(x.status, 200, r);
    assert.equal(x.texto, fs.readFileSync(path.join(RAIZ, r), 'utf8'), r);
  }
  for (const r of ['/assets/comum/outro.js', '/assets/comum/md.json', '/assets/grafo.js', '/assets/office.js']) assert.ok([403, 404].includes((await remoto('GET', r)).status), r);
});
