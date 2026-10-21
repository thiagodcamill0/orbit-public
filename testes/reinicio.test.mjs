// Testes do reinício pelas Configurações (reinicio.mjs).
// Rodar:  node --test testes/reinicio.test.mjs
// 1) O módulo sozinho, com req/res falsos: bloqueios (instância fora do motor, iniciando, ação em curso),
//    erro de sintaxe e a linha do cofre na volta.
// 2) Um servidor de verdade numa porta de teste (47822–47826, nunca a 47821), com o motor e o claude-falso
//    numa pasta de dados temporária: a instância do motor segue viva no reinício, o servidor volta sozinho
//    com outro pid, o log diz "usuário" e o cofre (na pasta de dados) ganha a linha. Depois, uma falha de
//    subida (a porta tomada) vira "falhou" com o motivo, e a volta seguinte é registrada.
// No fim: desliga só os servidores que o próprio teste trouxe, mata o motor do teste e apaga a pasta.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { escolherPorta } from './porta-livre.mjs';
import { matarArvore } from '../plataforma.mjs';
import { criarReinicio, arquivosDoServidor, comandoDaTarefa } from '../reinicio.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = await escolherPorta(Number(process.env.GERENCIADOR_PORTA) || 47823);
const DADOS = path.join(os.tmpdir(), 'gerenciador-testes', `reinicio-${Date.now()}`);
const SESSOES = path.join(DADOS, 'sessoes');
const PROJETOS = path.join(DADOS, 'projetos');
for (const d of [SESSOES, PROJETOS]) fs.mkdirSync(d, { recursive: true });
const COFRE = path.join(DADOS, 'notas', 'Reinícios do servidor.md');

const ENV = {
  ...process.env,
  GERENCIADOR_PORTA: String(PORTA),
  GERENCIADOR_DADOS: DADOS,
  GERENCIADOR_SESSOES_DIR: SESSOES,
  ORBIT_PROJETOS_DIR: PROJETOS,
  ORBIT_CLAUDE_BIN: path.join(RAIZ, 'testes', 'claude-falso.mjs'),
  ORBIT_MS_REGISTRO: '200',
  ORBIT_MS_INICIO: '2500',
  ORBIT_MS_DEVOLVER: '1500',
  ORBIT_REINICIO_SUBIR_MS: '8000',
  ORBIT_REINICIO_PAUSA_MS: '1500', // dá tempo de o teste da falha tomar a porta antes do ajudante
  FALSO_LOG: path.join(DADOS, 'falso.log'),
  FALSO_DEMORA_MS: '300',
};
delete ENV.CLAUDE_CODE_HOST_SESSION_ID;
delete ENV.GERENCIADOR_REINICIOS;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const vivo = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function esperarQue(cond, ms = 5000, rotulo = 'condição') {
  const fim = Date.now() + ms;
  let ultimo;
  while (Date.now() < fim) {
    ultimo = await cond();
    if (ultimo) return ultimo;
    await espera(80);
  }
  throw new Error(`${rotulo} não aconteceu em ${ms} ms (último: ${JSON.stringify(ultimo)})`);
}

function pedir(metodo, rota, corpo, { cabecalho = true, ua = 'teste-reinicio' } = {}) {
  return new Promise((resolve) => {
    const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
    const headers = { 'user-agent': ua };
    if (cabecalho) headers['x-gerenciador'] = '1';
    if (dados !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados) });
    const req = http.request({ host: '127.0.0.1', port: PORTA, path: rota, method: metodo, headers, timeout: 5000 }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (t += d));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(t); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0 }));
    if (dados !== undefined) req.write(dados);
    req.end();
  });
}
const get = (r) => pedir('GET', r);
const post = (r, c = {}, o) => pedir('POST', r, c, o);
const pidNaPorta = async () => (await get('/saude')).json?.pid || 0;

// ───────── 1) o módulo sozinho ─────────

function resFalso() {
  const r = { headersSent: false, statusCode: 0, corpo: null };
  r.writeHead = (c) => ((r.statusCode = c), (r.headersSent = true));
  r.end = (t) => (r.corpo = JSON.parse(t));
  return r;
}
function modulo(extra = {}) {
  const dados = fs.mkdtempSync(path.join(DADOS, 'mod-'));
  const desligados = [];
  const m = criarReinicio({ dados, pasta: RAIZ, cofre: path.join(dados, 'cofre.md'), lerJSONCorpo: async () => ({}), bloqueios: () => ({ motor: 0 }), desligar: (x) => desligados.push(x), ...extra });
  const pedirRein = async () => {
    const res = resFalso();
    await m.rota({ method: 'POST', headers: { 'user-agent': 'x' } }, res, '/reiniciar');
    return res;
  };
  return { m, dados, desligados, pedirRein };
}

test('módulo: bloqueia com motivo claro (fora do motor, iniciando, ação em curso, sintaxe) e não desliga', async () => {
  const casos = [
    [{ direto: 1, motor: 0 }, /1 instância do Orbit roda fora do motor e seria encerrada/],
    [{ direto: 0, motor: 2, iniciando: 1 }, /1 instância do motor ainda está iniciando/],
    [{ motor: 1, acoes: ['assumir'] }, /O Orbit está assumindo uma sessão\. Espere terminar/],
  ];
  for (const [b, re] of casos) {
    const { pedirRein, desligados, dados } = modulo({ bloqueios: () => b });
    const res = await pedirRein();
    assert.equal(res.statusCode, 409);
    assert.match(res.corpo.erro, re);
    assert.equal(desligados.length, 0);
    assert.equal(fs.existsSync(path.join(dados, 'reinicio.json')), false);
  }
  // Mensagem em curso não bloqueia (já foi entregue ao processo); só se confere a sintaxe dos arquivos.
  const quebrada = fs.mkdtempSync(path.join(DADOS, 'quebrada-'));
  fs.writeFileSync(path.join(quebrada, 'servidor.mjs'), 'const ok = 1;\nconst x = ;\n');
  const { pedirRein, desligados } = modulo({ pasta: quebrada, bloqueios: () => ({ motor: 1, acoes: [] }) });
  const res = await pedirRein();
  assert.equal(res.statusCode, 409);
  assert.equal(res.corpo.motivo, 'sintaxe');
  assert.match(res.corpo.erro, /O servidor novo não subiria: servidor\.mjs, linha 2: SyntaxError/);
  assert.equal(desligados.length, 0);
  // Um módulo que o servidor carrega (import protegido) também conta; arquivo solto na pasta, não.
  const modQuebrado = fs.mkdtempSync(path.join(DADOS, 'mod-quebrado-'));
  fs.writeFileSync(path.join(modQuebrado, 'servidor.mjs'), "import { a } from './a.mjs';\ntry { await import('./b.mjs'); } catch {}\n");
  fs.writeFileSync(path.join(modQuebrado, 'a.mjs'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(modQuebrado, 'b.mjs'), 'export function b() {\n  return (;\n}\n');
  fs.writeFileSync(path.join(modQuebrado, 'solto.mjs'), 'isto não é js');
  const r2 = await modulo({ pasta: modQuebrado }).pedirRein();
  assert.equal(r2.statusCode, 409);
  assert.match(r2.corpo.erro, /b\.mjs, linha 2: SyntaxError/);
  assert.deepEqual(arquivosDoServidor(modQuebrado).sort(), ['a.mjs', 'b.mjs', 'servidor.mjs']);
  // A pasta do Orbit: o servidor e os módulos que ele carrega hoje.
  const reais = arquivosDoServidor(RAIZ);
  for (const n of ['servidor.mjs', 'controle.mjs', 'motor.mjs', 'reinicio.mjs', 'ideias.mjs']) assert.ok(reais.includes(n), n);
  assert.ok(!reais.includes('hook.mjs'));
});

test('módulo: na volta, registra no cofre com o horário e confere as instâncias do motor', async () => {
  const { m, dados } = modulo({ bloqueios: () => ({ motor: 2 }) });
  const cofre = path.join(dados, 'cofre.md');
  fs.writeFileSync(cofre, '---\ntipo: registro\natualizado: 2026-01-01\n---\n\n# Reinícios do servidor\n\n- linha antiga\n');
  const pedido = Date.now() - 2100;
  fs.writeFileSync(path.join(dados, 'reinicio.json'), JSON.stringify({ pedido, por: 'usuário', origem: 'Configurações', pidAntigo: 1, motor: 2, cofre }));
  await m.aoSubir();
  const u = m.ultimo();
  assert.equal(u.conferido, true);
  assert.deepEqual([u.motor, u.voltaram, u.pedido], [2, 2, pedido]);
  assert.equal(fs.existsSync(path.join(dados, 'reinicio.json')), false);
  const txt = fs.readFileSync(cofre, 'utf8');
  const hoje = new Date();
  const dia = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
  assert.match(txt, new RegExp(`^atualizado: ${dia}$`, 'm'));
  assert.match(txt, /- linha antiga\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · pelo usuário \(Configurações\) · online de novo às \d{2}:\d{2}:\d{2} \(2,\d s\) · 2 instâncias do motor seguiram rodando\n$/);
  // Sem marca (subida comum): nada muda.
  await m.aoSubir();
  assert.equal(fs.readFileSync(cofre, 'utf8'), txt);
});

test('módulo: sobe pela tarefa conforme o logon.json (Windows schtasks, Mac launchctl simulado)', () => {
  const sem = fs.mkdtempSync(path.join(DADOS, 'logon-sem-'));
  assert.equal(comandoDaTarefa(sem, { so: 'win32' }), null);
  const win = fs.mkdtempSync(path.join(DADOS, 'logon-win-'));
  fs.writeFileSync(path.join(win, 'logon.json'), JSON.stringify({ tarefa: 'Orbit Public - Claude Code' })); // o de antes de 16/10
  assert.deepEqual(comandoDaTarefa(win, { so: 'win32' }), { cmd: 'schtasks.exe', args: ['/run', '/tn', 'Orbit Public - Claude Code'] });
  assert.equal(comandoDaTarefa(win, { so: 'darwin', uid: 501 }), null);
  const mac = fs.mkdtempSync(path.join(DADOS, 'logon-mac-'));
  fs.writeFileSync(path.join(mac, 'logon.json'), JSON.stringify({ sistema: 'darwin', rotulo: 'com.orbitpublic.servidor' }));
  assert.deepEqual(comandoDaTarefa(mac, { so: 'darwin', uid: 501 }), { cmd: '/bin/launchctl', args: ['kickstart', 'gui/501/com.orbitpublic.servidor'] });
  assert.equal(comandoDaTarefa(mac, { so: 'win32' }), null);
  // O logon.json real desta máquina (só leitura), se existir: no Windows continua no schtasks.
  if (process.platform === 'win32' && fs.existsSync(path.join(RAIZ, 'logon.json'))) assert.equal(comandoDaTarefa(RAIZ)?.cmd, 'schtasks.exe');
});

// ───────── 2) servidor de verdade ─────────

let proc = null;
const meus = new Set(); // pids de servidores que este teste trouxe (o 1º e os que o reinício subiu)
async function subir() {
  if ((await get('/saude')).status) throw new Error(`porta ${PORTA} ocupada por outro servidor`);
  proc = spawn(process.execPath, [path.join(RAIZ, 'servidor.mjs')], { env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => process.stderr.write('[servidor] ' + d));
  meus.add(proc.pid);
  await esperarQue(async () => (await pidNaPorta()) === proc.pid, 8000, 'servidor do teste no ar');
  return proc.pid;
}
const LOG = () => {
  try { return fs.readFileSync(path.join(DADOS, 'logs', 'servidor.log'), 'utf8'); } catch { return ''; }
};
const motorDoTeste = () => {
  try { return JSON.parse(fs.readFileSync(path.join(DADOS, 'motor.json'), 'utf8')); } catch { return null; }
};
after(async () => {
  const pid = await pidNaPorta();
  if (pid && meus.has(pid)) await post('/desligar');
  await espera(400);
  try { proc?.kill(); } catch {}
  const m = motorDoTeste();
  if (m?.pid && vivo(m.pid)) {
    if (process.platform === 'win32') try { execFileSync('taskkill', ['/PID', String(m.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
    else await matarArvore(m.pid); // Mac: o motor do teste e os filhos (o pid vem do motor.json da pasta temporária)
  }
  await espera(300);
  try { fs.rmSync(DADOS, { recursive: true, force: true }); } catch {}
});

test('servidor: reinicia pelo /reiniciar sem interromper a instância do motor e volta sozinho', async () => {
  const pidA = await subir();
  assert.equal((await post('/reiniciar', {}, { cabecalho: false })).status, 403);

  // Uma instância de verdade no motor (claude-falso).
  const pasta = path.join(DADOS, 'cwd', 'proj');
  fs.mkdirSync(pasta, { recursive: true });
  const cria = await post('/instancias', { pasta });
  assert.equal(cria.status, 202, JSON.stringify(cria.json));
  const id = cria.json.sessao;
  const c0 = await esperarQue(async () => {
    const c = (await get(`/sessao/${encodeURIComponent(id)}`)).json?.sessao?.controle;
    return c?.processo === 'vivo' && c.pid ? c : null;
  }, 10000, 'instância viva');
  const motorPid = motorDoTeste()?.pid;
  assert.ok(motorPid && vivo(motorPid));

  const r = await post('/reiniciar');
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.deepEqual([r.json.pid, r.json.motor], [pidA, 1]);
  assert.equal((await post('/reiniciar')).status, 409); // o segundo pedido no meio: já está reiniciando

  await esperarQue(async () => proc.exitCode != null, 5000, 'servidor antigo saiu');
  const pidB = await esperarQue(async () => {
    const p = await pidNaPorta();
    return p && p !== pidA ? p : 0;
  }, 15000, 'servidor de volta');
  meus.add(pidB);

  // A instância e o motor seguiram: o mesmo processo, adotado pelo servidor novo.
  assert.ok(vivo(c0.pid), 'o processo da instância morreu');
  assert.equal(motorDoTeste()?.pid, motorPid);
  const u = await esperarQue(async () => {
    const q = (await get('/reinicio')).json;
    return q?.ultimo?.conferido ? q.ultimo : null;
  }, 12000, 'reinício conferido');
  assert.deepEqual([u.motor, u.voltaram, u.por, u.origem], [1, 1, 'usuário', 'Configurações']);
  const c1 = (await get(`/sessao/${encodeURIComponent(id)}`)).json?.sessao?.controle;
  assert.deepEqual([c1?.modo, c1?.pid], ['orbit', c0.pid]);

  // Identificado como usuário no log; registrado no cofre (o do teste fica na pasta de dados); marca apagada.
  assert.match(LOG(), new RegExp(`\\s${pidA} desligando POST /reiniciar \\(usuário · Configurações · teste-reinicio\\)`));
  assert.match(fs.readFileSync(COFRE, 'utf8'), /- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · pelo usuário \(Configurações\) · online de novo às \d{2}:\d{2}:\d{2} \(\d+,\d s\) · 1 instância do motor seguiu rodando\n$/);
  assert.equal(fs.existsSync(path.join(DADOS, 'reinicio.json')), false);

  // Depois do reinício, a instância responde ao servidor novo.
  const msg = await post(`/sessao/${encodeURIComponent(id)}/mensagem`, { texto: 'depois do reinício' });
  assert.ok(msg.json?.acao?.id, JSON.stringify(msg));
  await esperarQue(async () => {
    const l = (await get(`/sessao/${encodeURIComponent(id)}/acoes`)).json;
    const a = (Array.isArray(l) ? l : l?.acoes || []).find((x) => x.id === msg.json.acao.id);
    return a && a.estado !== 'em_andamento' ? a : null;
  }, 8000, 'mensagem entregue').then((a) => assert.equal(a.estado, 'sucesso'));
  // Fecha a instância: o próximo teste não tem nada do motor para conferir.
  await post(`/sessao/${encodeURIComponent(id)}/devolver`);
  await esperarQue(async () => !vivo(c0.pid), 8000, 'instância fechada');});

test('servidor: falha na subida vira "falhou" com o motivo; a volta seguinte é registrada', async () => {
  const pidB = await pidNaPorta();
  assert.ok(meus.has(pidB));
  const r = await post('/reiniciar');
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(r.json.motor, 0);
  // Assim que o servidor sai, outra coisa toma a porta: o servidor novo do ajudante não consegue escutar.
  await esperarQue(async () => !vivo(pidB), 5000, 'servidor saiu');
  const intruso = net.createServer((s) => s.destroy());
  await new Promise((ok, ko) => intruso.once('error', ko).listen(PORTA, '127.0.0.1', ok));
  try {
    const m = await esperarQue(async () => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DADOS, 'reinicio.json'), 'utf8'));
        return j.falha ? j : null;
      } catch { return null; }
    }, 15000, 'falha marcada');
    assert.match(m.falha.motivo, /o servidor novo caiu na subida \(código 0\)/);
    assert.match(fs.readFileSync(COFRE, 'utf8'), /· pelo usuário \(Configurações\) · falhou: o servidor novo caiu na subida \(código 0\)/);
    assert.match(fs.readFileSync(path.join(DADOS, 'logs', 'reinicio.log'), 'utf8'), /falhou: o servidor novo caiu na subida/);
  } finally {
    await new Promise((ok) => intruso.close(ok));
  }
  // O próximo servidor (aqui, o do teste; na produção, o do próximo hook) fecha o registro.
  await subir();
  await esperarQue(async () => (await get('/reinicio')).json?.ultimo?.conferido, 5000, 'volta conferida');
  const u = (await get('/reinicio')).json.ultimo;
  assert.match(u.falha.motivo, /caiu na subida/);
  assert.match(fs.readFileSync(COFRE, 'utf8'), /· pelo usuário \(Configurações\) · voltou às \d{2}:\d{2}:\d{2}, pelo próximo evento, depois da falha\n$/);
  assert.equal(fs.existsSync(path.join(DADOS, 'reinicio.json')), false);
});
