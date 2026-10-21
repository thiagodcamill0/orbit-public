// Testes do logon.mjs (tarefa de logon do Windows e LaunchAgent do Mac), sem tocar no sistema:
// os comandos (powershell, schtasks, launchctl) vão para um falso que só anota. Nada de tarefa real,
// nada de ~/Library real, nada na 47821. Pastas temporárias, apagadas no fim.
// Mac/Linux: também o lancador.mjs de verdade (cópia numa pasta temporária, com um servidor.mjs falso numa porta
// 47822–47826: o servidor nasce noutra sessão e sobrevive ao "fechar o Terminal") e o iniciar.command/parar.command
// (cópias com node, curl e open falsos no PATH; o ramo do launchctl kickstart não roda aqui).
// Rodar:  node --test testes/logon.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { escolherPorta } from './porta-livre.mjs';
import { comandoSubirPelaTarefa, plistDoMac, criarLogon, TAREFA, ROTULO } from '../logon.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-logon-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function falso(respostas = {}) {
  const chamadas = [];
  const saida = [];
  const rodar = (cmd, args) => {
    chamadas.push([cmd, ...args]);
    const r = respostas[`${cmd} ${args[0]}`];
    return typeof r === 'function' ? r(args) : r || { ok: true, saida: '' };
  };
  return { chamadas, saida, rodar, escrever: (t) => saida.push(t) };
}

function ambiente(nome) {
  const raiz = path.join(TMP, nome);
  const home = path.join(raiz, 'home');
  const pasta = path.join(raiz, 'orbit');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(pasta, { recursive: true });
  return { home, pasta, marca: path.join(pasta, 'logon.json') };
}

test('subir pela tarefa: o comando certo para cada logon.json e sistema', () => {
  const winAntigo = JSON.stringify({ tarefa: TAREFA, instalado: '2026-10-15T10:00:00.000Z' }); // sem `sistema` (antes de 16/10)
  assert.deepEqual(comandoSubirPelaTarefa(winAntigo, { so: 'win32' }), { cmd: 'schtasks.exe', args: ['/run', '/tn', TAREFA] });
  assert.deepEqual(comandoSubirPelaTarefa({ sistema: 'win32', tarefa: TAREFA }, { so: 'win32' }), { cmd: 'schtasks.exe', args: ['/run', '/tn', TAREFA] });
  const mac = JSON.stringify({ sistema: 'darwin', rotulo: ROTULO });
  assert.deepEqual(comandoSubirPelaTarefa(mac, { so: 'darwin', uid: 501 }), { cmd: '/bin/launchctl', args: ['kickstart', `gui/501/${ROTULO}`] });
  // Um sistema nunca usa o logon.json do outro.
  assert.equal(comandoSubirPelaTarefa(mac, { so: 'win32', uid: 501 }), null);
  assert.equal(comandoSubirPelaTarefa(winAntigo, { so: 'darwin', uid: 501 }), null);
  assert.equal(comandoSubirPelaTarefa({ sistema: 'win32', tarefa: TAREFA }, { so: 'linux' }), null);
  // Lixo não vira comando.
  for (const ruim of ['', '{', 'null', '[]', JSON.stringify({ tarefa: '' }), JSON.stringify({ sistema: 'linux', tarefa: 'x' })]) assert.equal(comandoSubirPelaTarefa(ruim, { so: 'win32' }), null, ruim);
  for (const rotulo of ['', 'a b', 'x;rm -rf ~', '../x', 7]) assert.equal(comandoSubirPelaTarefa({ sistema: 'darwin', rotulo }, { so: 'darwin', uid: 501 }), null, String(rotulo));
  assert.equal(comandoSubirPelaTarefa(mac, { so: 'darwin', uid: -1 }), null);
});

test('plist do Mac: RunAtLoad, node + lancador, pasta, PATH ampliado, logs, e escapa o XML', () => {
  const p = plistDoMac({ node: '/opt/homebrew/bin/node', lancador: '/Users/t/Orbit & Cia/lancador.mjs', pasta: '/Users/t/Orbit & Cia', PATH: '/usr/bin:/bin:/opt/homebrew/bin', logs: '/Users/t/Orbit & Cia/logs' });
  assert.match(p, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
  assert.match(p, /<key>Label<\/key>\n\s*<string>com.orbitpublic.servidor<\/string>/);
  assert.match(p, /<key>ProgramArguments<\/key>\n\s*<array>\n\s*<string>\/opt\/homebrew\/bin\/node<\/string>\n\s*<string>\/Users\/t\/Orbit &amp; Cia\/lancador\.mjs<\/string>\n\s*<\/array>/);
  assert.match(p, /<key>WorkingDirectory<\/key>\n\s*<string>\/Users\/t\/Orbit &amp; Cia<\/string>/);
  assert.match(p, /<key>PATH<\/key>\n\s*<string>\/usr\/bin:\/bin:\/opt\/homebrew\/bin<\/string>/);
  assert.match(p, /<key>RunAtLoad<\/key>\n\s*<true\/>/);
  assert.match(p, /<key>KeepAlive<\/key>\n\s*<false\/>/);
  assert.match(p, /<key>AbandonProcessGroup<\/key>\n\s*<true\/>/);
  assert.match(p, /<key>StandardErrorPath<\/key>\n\s*<string>\/Users\/t\/Orbit &amp; Cia\/logs\/launchd\.log<\/string>/);
  assert.ok(!/&(?!amp;|lt;|gt;|quot;)/.test(p), 'sobrou & sem escapar');
  assert.ok(!p.includes('\r'), 'plist com CR');
});

test('Mac simulado: instalar, estado, subir e remover pelo launchctl (falso)', () => {
  const { home, pasta, marca } = ambiente('mac');
  const f = falso({ '/bin/launchctl bootout': { ok: false, saida: 'Boot-out failed: 3: No such process' } });
  const l = criarLogon({ so: 'darwin', home, uid: 501, env: { PATH: '/usr/bin:/bin' }, pasta, marca, node: '/opt/homebrew/bin/node', rodar: f.rodar, escrever: f.escrever });
  const plist = path.posix.join(home, 'Library', 'LaunchAgents', 'com.orbitpublic.servidor.plist');
  assert.equal(l.plist, plist);

  l.executar('instalar');
  assert.deepEqual(f.chamadas, [
    ['/bin/launchctl', 'bootout', `gui/501/${ROTULO}`],
    ['/bin/launchctl', 'bootstrap', 'gui/501', plist],
  ]);
  const xml = fs.readFileSync(plist, 'utf8');
  assert.ok(xml.includes(`<string>${path.join(pasta, 'lancador.mjs')}</string>`));
  assert.ok(xml.includes(`<string>${pasta}</string>`));
  assert.match(xml, /<key>PATH<\/key>\n\s*<string>\/usr\/bin:\/bin:\/opt\/homebrew\/bin:\/opt\/homebrew\/sbin:\/usr\/local\/bin:[^<]*\.local\/bin:[^<]*<\/string>/);
  assert.ok(fs.statSync(path.join(pasta, 'logs')).isDirectory(), 'pasta logs/');
  const j = JSON.parse(fs.readFileSync(marca, 'utf8'));
  assert.equal(j.sistema, 'darwin');
  assert.equal(j.rotulo, ROTULO);
  assert.equal(j.node, '/opt/homebrew/bin/node');
  assert.deepEqual(comandoSubirPelaTarefa(fs.readFileSync(marca, 'utf8'), { so: 'darwin', uid: 501 }).args, ['kickstart', `gui/501/${ROTULO}`]);
  assert.match(f.saida.at(-1), /Agente "com.orbitpublic.servidor" instalado/);

  f.chamadas.length = 0;
  const g = falso({ '/bin/launchctl print': { ok: true, saida: `gui/501/${ROTULO} = {\n\tactive count = 0\n\tstate = not running\n\tlast exit code = 0\n}` } });
  criarLogon({ so: 'darwin', home, uid: 501, pasta, marca, rodar: g.rodar, escrever: g.escrever }).executar('estado');
  assert.deepEqual(g.chamadas, [['/bin/launchctl', 'print', `gui/501/${ROTULO}`]]);
  assert.match(g.saida[0], /carregado; estado not running; último código de saída 0/);
  assert.match(g.saida[1], /plist: existe/);
  assert.match(g.saida[2], /logon\.json: existe/);

  l.executar('subir');
  assert.deepEqual(f.chamadas, [['/bin/launchctl', 'kickstart', `gui/501/${ROTULO}`]]);
  assert.equal(f.saida.at(-1), 'Agente iniciado.');

  f.chamadas.length = 0;
  l.executar('remover');
  assert.deepEqual(f.chamadas, [['/bin/launchctl', 'bootout', `gui/501/${ROTULO}`]]);
  assert.ok(!fs.existsSync(plist) && !fs.existsSync(marca));

  const h = falso({ '/bin/launchctl print': { ok: false, saida: 'Could not find service' } });
  criarLogon({ so: 'darwin', home, uid: 501, pasta, marca, rodar: h.rodar, escrever: h.escrever }).executar('estado');
  assert.match(h.saida[0], /não carregado/);
  assert.match(h.saida[2], /logon\.json: não existe/);
});

test('Mac simulado: bootstrap recusado não grava o logon.json', () => {
  const { home, pasta, marca } = ambiente('mac-falha');
  const f = falso({ '/bin/launchctl bootstrap': { ok: false, saida: 'Bootstrap failed: 5: Input/output error' } });
  const esperas = [];
  const l = criarLogon({ so: 'darwin', home, uid: 501, env: { PATH: '/usr/bin' }, pasta, marca, node: '/usr/local/bin/node', rodar: f.rodar, escrever: f.escrever, esperar: (ms) => esperas.push(ms) });
  assert.throws(() => l.executar('instalar'), /launchctl bootstrap.*Input\/output error/);
  assert.ok(!fs.existsSync(marca));
  // O bootout descarregou (reinstalação): tenta o bootstrap mais 4 vezes, com pausa, antes de desistir.
  assert.equal(f.chamadas.filter((c) => c[1] === 'bootstrap').length, 5);
  assert.deepEqual(esperas, [500, 500, 500, 500]);
});

test('Mac simulado: reinstalação com o launchd ainda descarregando → o bootstrap tenta de novo e instala', () => {
  const { home, pasta, marca } = ambiente('mac-reinstalar');
  let tentativas = 0;
  const f = falso({ '/bin/launchctl bootstrap': () => (++tentativas < 3 ? { ok: false, saida: 'Bootstrap failed: 5: Input/output error' } : { ok: true, saida: '' }) });
  const l = criarLogon({ so: 'darwin', home, uid: 501, env: { PATH: '/usr/bin' }, pasta, marca, node: '/opt/homebrew/bin/node', rodar: f.rodar, escrever: f.escrever, esperar: () => {} });
  l.executar('instalar');
  assert.equal(tentativas, 3);
  assert.equal(JSON.parse(fs.readFileSync(marca, 'utf8')).rotulo, ROTULO);
  // Primeira instalação (o bootout falha: não estava carregado) e o bootstrap recusa: uma tentativa só.
  const m2 = ambiente('mac-primeira');
  const g = falso({ '/bin/launchctl bootout': { ok: false, saida: 'Boot-out failed: 3: No such process' }, '/bin/launchctl bootstrap': { ok: false, saida: 'Bootstrap failed: 5: Input/output error' } });
  assert.throws(() => criarLogon({ so: 'darwin', home: m2.home, uid: 501, env: { PATH: '/usr/bin' }, pasta: m2.pasta, marca: m2.marca, rodar: g.rodar, escrever: g.escrever, esperar: () => {} }).executar('instalar'), /bootstrap/);
  assert.equal(g.chamadas.filter((c) => c[1] === 'bootstrap').length, 1);
});

test('Windows simulado: instalar grava sistema + tarefa; subir roda o schtasks; nada real é tocado', () => {
  const { pasta, marca } = ambiente('win');
  const f = falso();
  const l = criarLogon({ so: 'win32', pasta, marca, env: { WINDIR: 'C:\\Windows', USERNAME: 'teste' }, node: 'C:\\node\\node.exe', rodar: f.rodar, escrever: f.escrever });
  l.executar('instalar');
  assert.equal(f.chamadas.length, 1);
  const [cmd, ...args] = f.chamadas[0];
  assert.equal(cmd, 'powershell.exe');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(args[3], /New-ScheduledTaskAction -Execute 'C:\\Windows\\System32\\conhost\.exe' -Argument '--headless "C:\\node\\node\.exe" "[^"]+lancador\.mjs"'/);
  assert.match(args[3], /Register-ScheduledTask -TaskName 'Orbit Public - Claude Code'/);
  assert.match(args[3], /New-ScheduledTaskTrigger -AtLogOn/);
  const j = JSON.parse(fs.readFileSync(marca, 'utf8'));
  assert.deepEqual([j.sistema, j.tarefa, j.node], ['win32', TAREFA, 'C:\\node\\node.exe']);
  assert.match(f.saida.at(-1), /Tarefa "Orbit Public - Claude Code" criada \(logon de teste\)/);

  f.chamadas.length = 0;
  l.executar('subir');
  assert.deepEqual(f.chamadas, [['schtasks.exe', '/run', '/tn', TAREFA]]);
  assert.equal(f.saida.at(-1), 'Tarefa iniciada.');

  f.chamadas.length = 0;
  l.executar('remover');
  assert.equal(f.chamadas[0][0], 'powershell.exe');
  assert.match(f.chamadas[0][4], /Unregister-ScheduledTask -TaskName 'Orbit Public - Claude Code' -Confirm:\$false/);
  assert.ok(!fs.existsSync(marca));
});

test('comandos: uso e sistema sem suporte', () => {
  const f = falso();
  criarLogon({ so: 'darwin', uid: 501, home: TMP, pasta: TMP, marca: path.join(TMP, 'x.json'), rodar: f.rodar, escrever: f.escrever }).executar('qualquer');
  assert.equal(f.saida[0], 'uso: node logon.mjs instalar | remover | estado | subir');
  criarLogon({ so: 'linux', rodar: f.rodar, escrever: f.escrever }).executar('instalar');
  assert.equal(f.saida[1], 'Só no Windows e no macOS.');
  assert.equal(f.chamadas.length, 0);
});

// ───────── Mac/Linux: o lancador, o iniciar.command e o parar.command de verdade ─────────

const POSIX = process.platform !== 'win32';
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const saude = (porta) => new Promise((resolve) => {
  const q = http.get({ host: '127.0.0.1', port: porta, path: '/saude', timeout: 1000 }, (res) => {
    let t = '';
    res.setEncoding('utf8');
    res.on('data', (d) => (t += d));
    res.on('end', () => { try { resolve(JSON.parse(t)); } catch { resolve(null); } });
  });
  q.on('timeout', () => q.destroy());
  q.on('error', () => resolve(null));
});
const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('Mac/Linux: o lancador sobe o servidor noutra sessão, com o PATH ampliado; ele sobrevive ao fechar do Terminal', { skip: !POSIX && 'só Mac/Linux' }, async () => {
  const porta = await escolherPorta(47825);
  const pasta = path.join(TMP, 'lancador com espaço');
  fs.mkdirSync(pasta, { recursive: true });
  for (const f of ['lancador.mjs', 'plataforma.mjs']) fs.copyFileSync(path.join(RAIZ, f), path.join(pasta, f));
  // O servidor falso: /saude com o pid, o PATH e o grupo de processos; /desligar sai.
  fs.writeFileSync(path.join(pasta, 'servidor.mjs'), `import http from 'node:http';
const s = http.createServer((req, res) => {
  if (req.url === '/desligar') { res.end('{}'); setTimeout(() => process.exit(0), 50); return; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ pid: process.pid, PATH: process.env.PATH, cwd: process.cwd() }));
});
s.listen(Number(process.env.GERENCIADOR_PORTA), '127.0.0.1');
`);
  let pidServidor = 0;
  try {
    // O "Terminal": uma sessão própria (detached), com o PATH mínimo do launchd/Finder.
    const term = spawn(process.execPath, [path.join(pasta, 'lancador.mjs')], { cwd: os.tmpdir(), detached: true, stdio: 'ignore', env: { HOME: os.homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', GERENCIADOR_PORTA: String(porta) } });
    const codigo = await new Promise((ok) => term.once('exit', ok));
    assert.equal(codigo, 0, 'o lancador sai logo depois de subir');
    let s = null;
    for (let i = 0; i < 50 && !s; i++) { s = await saude(porta); if (!s) await dormir(100); }
    assert.ok(s?.pid, 'o servidor (falso) subiu');
    pidServidor = s.pid;
    assert.equal(s.cwd, fs.realpathSync(pasta), 'cwd = a pasta do Orbit (com espaço)');
    const dirs = s.PATH.split(':');
    for (const d of ['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')]) assert.ok(dirs.includes(d), `PATH sem ${d}: ${s.PATH}`);
    // Outra sessão: o servidor é líder do próprio grupo (setsid do detached), fora do grupo do "Terminal".
    const pgid = Number(spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(pidServidor)], { encoding: 'utf8' }).stdout.trim());
    assert.equal(pgid, pidServidor, 'o servidor lidera o próprio grupo de processos');
    assert.notEqual(pgid, term.pid);
    // "Fechar o Terminal": SIGHUP no grupo do Terminal. O servidor continua no ar.
    try { process.kill(-term.pid, 'SIGHUP'); } catch {}
    await dormir(400);
    assert.equal((await saude(porta))?.pid, pidServidor, 'o servidor morreu com o Terminal');
    // Já no ar: o lancador não sobe outro.
    const t2 = spawnSync(process.execPath, [path.join(pasta, 'lancador.mjs')], { env: { HOME: os.homedir(), PATH: '/usr/bin:/bin', GERENCIADOR_PORTA: String(porta) }, timeout: 10000 });
    assert.equal(t2.status, 0);
    await dormir(300);
    assert.equal((await saude(porta))?.pid, pidServidor);
    assert.match(fs.readFileSync(path.join(pasta, 'logs', 'lancador.log'), 'utf8'), /servidor iniciado, pid \d+[\s\S]*servidor já estava no ar/);
  } finally {
    // Só o servidor falso que este teste subiu (o pid veio do /saude da porta de teste e o cwd é a pasta temporária).
    if (pidServidor && (await saude(porta))?.cwd === fs.realpathSync(pasta)) {
      await new Promise((ok) => { const q = http.get({ host: '127.0.0.1', port: porta, path: '/desligar', timeout: 1000 }, (r) => { r.resume(); r.on('end', ok); }); q.on('error', ok); q.on('timeout', () => { q.destroy(); ok(); }); });
      for (let i = 0; i < 20 && vivo(pidServidor); i++) await dormir(100);
      if (vivo(pidServidor)) try { process.kill(pidServidor, 'SIGKILL'); } catch {}
    }
  }
});

// Uma cópia do .command numa pasta com espaço, com node/curl/open falsos que só anotam (PATH só com eles e /bin).
function comandoFalso(nome, { curlOk = true } = {}) {
  const pasta = path.join(TMP, nome, 'Orbit com espaço');
  const bin = path.join(TMP, nome, 'bin');
  fs.mkdirSync(pasta, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const anot = path.join(TMP, nome, 'chamadas.txt');
  const falsoSh = (cmd, fim = 'exit 0') => fs.writeFileSync(path.join(bin, cmd), `#!/bin/sh\nprintf '%s|%s|%s\\n' "${cmd}" "$PWD" "$*" >> "${anot}"\n${fim}\n`, { mode: 0o755 });
  falsoSh('node');
  falsoSh('curl', curlOk ? 'exit 0' : 'exit 7');
  falsoSh('open');
  // O $PWD do bash pode vir pelo link (/var → /private/var no Mac): compara pelo caminho real.
  const real = (d) => { try { return fs.realpathSync(d); } catch { return d; } };
  const chamadas = () => (fs.existsSync(anot) ? fs.readFileSync(anot, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('|')).map(([c, d, a]) => [c, real(d), a]) : []);
  return { pasta, bin, chamadas };
}

test('Mac/Linux: iniciar.command e parar.command (LF, bash, executáveis; node, curl e open falsos)', { skip: !POSIX && 'só Mac/Linux' }, () => {
  for (const f of ['iniciar.command', 'parar.command']) {
    const arq = path.join(RAIZ, f);
    const txt = fs.readFileSync(arq, 'utf8');
    assert.ok(txt.startsWith('#!/bin/bash\n'), `${f}: #!/bin/bash`);
    assert.ok(!txt.includes('\r'), `${f}: finais de linha LF`);
    assert.ok(fs.statSync(arq).mode & 0o111, `${f}: executável`);
    assert.equal(spawnSync('/bin/bash', ['-n', arq]).status, 0, `${f}: sintaxe do bash`);
  }

  // iniciar: sem logon.json, sobe pelo lancador (na pasta do próprio script), espera o /saude e abre a página.
  const a = comandoFalso('iniciar');
  fs.copyFileSync(path.join(RAIZ, 'iniciar.command'), path.join(a.pasta, 'iniciar.command'));
  let r = spawnSync('/bin/bash', [path.join(a.pasta, 'iniciar.command')], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 20000, env: { HOME: path.join(TMP, 'iniciar'), PATH: `${a.bin}:/usr/bin:/bin` } });
  assert.equal(r.status, 0, r.stderr);
  const pastaReal = fs.realpathSync(a.pasta);
  let ch = a.chamadas();
  assert.deepEqual(ch.find((c) => c[0] === 'node'), ['node', pastaReal, 'lancador.mjs']);
  assert.ok(ch.some((c) => c[0] === 'curl' && /http:\/\/127\.0\.0\.1:47821\/saude/.test(c[2])), 'espera pelo /saude');
  assert.deepEqual(ch.at(-1), ['open', pastaReal, 'http://127.0.0.1:47821']);
  // O logon.json do Windows (sem "sistema": "darwin") não vale no Mac: sobe pelo lancador.
  fs.writeFileSync(path.join(a.pasta, 'logon.json'), JSON.stringify({ sistema: 'win32', tarefa: 'Orbit Public - Claude Code' }, null, 2));
  r = spawnSync('/bin/bash', [path.join(a.pasta, 'iniciar.command')], { encoding: 'utf8', timeout: 20000, env: { HOME: path.join(TMP, 'iniciar'), PATH: `${a.bin}:/usr/bin:/bin` } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(a.chamadas().filter((c) => c[0] === 'node').length, 2);
  // Sem node no PATH (nem no Homebrew, no HOME falso): mensagem e código 1, sem abrir nada.
  const semNode = comandoFalso('iniciar-sem-node');
  fs.rmSync(path.join(semNode.bin, 'node'));
  fs.copyFileSync(path.join(RAIZ, 'iniciar.command'), path.join(semNode.pasta, 'iniciar.command'));
  if (!fs.existsSync('/opt/homebrew/bin/node') && !fs.existsSync('/usr/local/bin/node') && !spawnSync('/bin/sh', ['-c', 'command -v node'], { env: { PATH: '/usr/bin:/bin' } }).stdout.length) {
    r = spawnSync('/bin/bash', [path.join(semNode.pasta, 'iniciar.command')], { encoding: 'utf8', timeout: 20000, env: { HOME: path.join(TMP, 'iniciar-sem-node'), PATH: `${semNode.bin}:/usr/bin:/bin` } });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Não achei o node/);
  }

  // parar: POST /desligar com o cabeçalho e o User-Agent; servidor fora do ar → a outra mensagem.
  const b = comandoFalso('parar');
  fs.copyFileSync(path.join(RAIZ, 'parar.command'), path.join(b.pasta, 'parar.command'));
  r = spawnSync('/bin/bash', [path.join(b.pasta, 'parar.command')], { encoding: 'utf8', timeout: 20000, env: { HOME: path.join(TMP, 'parar'), PATH: `${b.bin}:/usr/bin:/bin` } });
  assert.equal(r.stdout.trim(), 'Servidor desligado.');
  ch = b.chamadas();
  assert.equal(ch.length, 1);
  assert.match(ch[0][2], /-X POST/);
  assert.match(ch[0][2], /-H x-gerenciador: 1/);
  assert.match(ch[0][2], /-A parar\.command/);
  assert.match(ch[0][2], /http:\/\/127\.0\.0\.1:47821\/desligar$/);
  const c = comandoFalso('parar-fora', { curlOk: false });
  fs.copyFileSync(path.join(RAIZ, 'parar.command'), path.join(c.pasta, 'parar.command'));
  r = spawnSync('/bin/bash', [path.join(c.pasta, 'parar.command')], { encoding: 'utf8', timeout: 20000, env: { HOME: path.join(TMP, 'parar-fora'), PATH: `${c.bin}:/usr/bin:/bin` } });
  assert.equal(r.stdout.trim(), 'O servidor não estava no ar.');
});
