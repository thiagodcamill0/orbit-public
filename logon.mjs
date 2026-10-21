// Orbit — o que sobe o Orbit no logon do usuário (decisão D3, 15/10: "Orbit sem VS Code"; Mac em 16/10).
//   node logon.mjs instalar   cria a tarefa/agente (no logon deste usuário + sob demanda) e grava logon.json
//   node logon.mjs remover    apaga a tarefa/agente e o logon.json
//   node logon.mjs estado     mostra se a tarefa/agente existe e o último resultado
//   node logon.mjs subir      roda a tarefa/agente agora (sobe o servidor, se estiver fora)
// Windows: tarefa agendada que roda o lancador.mjs pelo `conhost --headless` (sem janela), como o próprio
// usuário e sem privilégio elevado. Rodar a tarefa de novo, ou pará-la, não derruba o que ela já subiu
// (testado em 15/10).
// Mac: LaunchAgent ~/Library/LaunchAgents/com.orbitpublic.servidor.plist (RunAtLoad), carregado no domínio
// gui/<uid> do usuário; roda node + lancador.mjs com o PATH ampliado (o launchd sobe com PATH mínimo).
// NÃO TESTADO num Mac de verdade (só simulado, com o launchctl trocado por um falso).
// Nada global do Claude Code muda. O hook.mjs, o reinicio.mjs e o iniciar.cmd/.command sobem o servidor
// por ela quando o logon.json existe, para ele nascer fora do job do VS Code.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SO, pathAmpliado, acharNoPath } from './plataforma.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
export const TAREFA = 'Orbit Public - Claude Code';
export const ROTULO = 'com.orbitpublic.servidor';
export const MARCA = path.join(PASTA, 'logon.json');
const ROTULO_OK = /^[\w.-]+$/;

// ───────────────────────── funções puras (testes, hook.mjs) ─────────────────────────

// "Subir pela tarefa" a partir do conteúdo do logon.json (texto ou objeto): { cmd, args } ou null.
// O hook.mjs repete esta lógica inline (não importa este arquivo). Sem `sistema`, é o logon.json do
// Windows de antes de 16/10. Um logon.json de um sistema nunca vale no outro (o arquivo fica na pasta
// do projeto, que é a mesma nas duas máquinas pelo git, mas está no .gitignore; mesmo assim, confere).
export function comandoSubirPelaTarefa(conteudo, o = {}) {
  const so = o.so || SO;
  let m = conteudo;
  if (typeof m === 'string') {
    try { m = JSON.parse(m); } catch { return null; }
  }
  if (!m || typeof m !== 'object') return null;
  if (m.sistema === 'darwin') {
    if (so !== 'darwin' || typeof m.rotulo !== 'string' || !ROTULO_OK.test(m.rotulo)) return null;
    const uid = o.uid ?? process.getuid?.();
    if (!Number.isInteger(uid) || uid < 0) return null;
    return { cmd: '/bin/launchctl', args: ['kickstart', `gui/${uid}/${m.rotulo}`] };
  }
  if (m.sistema && m.sistema !== 'win32') return null;
  if (so !== 'win32' || typeof m.tarefa !== 'string' || !m.tarefa) return null;
  return { cmd: 'schtasks.exe', args: ['/run', '/tn', m.tarefa] };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// O plist do LaunchAgent do Mac. `AbandonProcessGroup`: o lancador sai logo depois de subir o servidor, e
// sem essa chave o launchd mata o que ficou no grupo de processos do job (o servidor nasce em outra
// sessão pelo `detached`, mas a chave garante).
export function plistDoMac({ rotulo = ROTULO, node, lancador, pasta, PATH, logs }) {
  const linhas = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xml(rotulo)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xml(node)}</string>`,
    `    <string>${xml(lancador)}</string>`,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xml(pasta)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    `    <string>${xml(PATH)}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <false/>',
    '  <key>AbandonProcessGroup</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(path.posix.join(logs, 'launchd.log'))}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(path.posix.join(logs, 'launchd.log'))}</string>`,
    '</dict>',
    '</plist>',
    '',
  ];
  return linhas.join('\n');
}

// ───────────────────────── comandos ─────────────────────────

function rodarDeVerdade(cmd, args, timeout = 60000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout });
  return { ok: r.status === 0, saida: `${r.stdout || ''}${r.stderr || ''}`.trim() || (r.error ? r.error.message : '') };
}

// `o` (testes): { so, home, uid, env, pasta, marca, node, rodar(cmd, args) → { ok, saida }, escrever(texto), esperar(ms) }.
export function criarLogon(o = {}) {
  const so = o.so || SO;
  const home = o.home || os.homedir();
  const env = o.env || process.env;
  const pasta = o.pasta || PASTA;
  const marca = o.marca || MARCA;
  const rodar = o.rodar || rodarDeVerdade;
  const escrever = o.escrever || ((t) => console.log(t));
  const esperar = o.esperar || ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const lancador = path.join(pasta, 'lancador.mjs');

  // ── Windows ──
  const ps = (script) => rodar('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const aspas = (s) => `'${String(s).replace(/'/g, "''")}'`; // string literal do PowerShell

  const win = {
    instalar() {
      const conhost = path.win32.join(env.WINDIR || 'C:\\Windows', 'System32', 'conhost.exe');
      const node = o.node || process.execPath;
      const args = `--headless "${node}" "${lancador}"`;
      const r = ps(
        [
          '$ErrorActionPreference = "Stop"',
          '$u = "$env:USERDOMAIN\\$env:USERNAME"',
          `$a = New-ScheduledTaskAction -Execute ${aspas(conhost)} -Argument ${aspas(args)} -WorkingDirectory ${aspas(pasta)}`,
          '$t = New-ScheduledTaskTrigger -AtLogOn -User $u',
          '$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew',
          '$p = New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited',
          `Register-ScheduledTask -TaskName ${aspas(TAREFA)} -Description ${aspas('Sobe o Orbit (painel das instâncias do Claude Code) em ' + pasta)} -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null`,
          '"ok"',
        ].join('; '),
      );
      if (!r.ok) throw new Error(`não consegui criar a tarefa: ${r.saida}`);
      fs.writeFileSync(marca, JSON.stringify({ sistema: 'win32', tarefa: TAREFA, instalado: new Date().toISOString(), node, lancador }, null, 2) + '\n');
      escrever(`Tarefa "${TAREFA}" criada (logon de ${env.USERNAME}). O hook e o iniciar.cmd passam a subir o servidor por ela.`);
    },
    remover() {
      const r = ps(`Unregister-ScheduledTask -TaskName ${aspas(TAREFA)} -Confirm:$false -ErrorAction SilentlyContinue; "ok"`);
      fs.rmSync(marca, { force: true });
      escrever(r.ok ? `Tarefa "${TAREFA}" removida.` : `Não consegui remover a tarefa: ${r.saida}`);
    },
    estado() {
      const r = ps(`$t = Get-ScheduledTask -TaskName ${aspas(TAREFA)} -ErrorAction SilentlyContinue; if ($t) { $i = Get-ScheduledTaskInfo -TaskName ${aspas(TAREFA)}; "existe; estado $($t.State); última execução $($i.LastRunTime); resultado $($i.LastTaskResult)" } else { "não existe" }`);
      escrever(`Tarefa "${TAREFA}": ${r.saida}`);
      escrever(`logon.json: ${fs.existsSync(marca) ? 'existe' : 'não existe'}`);
    },
    subir() {
      const c = comandoSubirPelaTarefa({ sistema: 'win32', tarefa: TAREFA }, { so });
      const r = rodar(c.cmd, c.args, 20000);
      escrever(r.ok ? 'Tarefa iniciada.' : `Falhou: ${r.saida}`);
    },
  };

  // ── Mac ──
  const uid = o.uid ?? process.getuid?.();
  const dominio = `gui/${uid}`;
  const servico = `${dominio}/${ROTULO}`;
  const plist = path.posix.join(home, 'Library', 'LaunchAgents', `${ROTULO}.plist`);
  const launchctl = (...args) => rodar('/bin/launchctl', args, 20000);

  const mac = {
    instalar() {
      if (!Number.isInteger(uid)) throw new Error('não consegui saber o uid deste usuário');
      // O node pelo PATH (o link do Homebrew sobrevive às atualizações; o process.execPath aponta para a versão).
      const node = o.node || acharNoPath('node', { so, env, home }) || process.execPath;
      const logs = path.posix.join(pasta, 'logs');
      fs.mkdirSync(logs, { recursive: true });
      fs.mkdirSync(path.posix.dirname(plist), { recursive: true });
      fs.writeFileSync(plist, plistDoMac({ node, lancador, pasta, PATH: pathAmpliado({ so, env, home }), logs }));
      const fora = launchctl('bootout', servico); // já carregado (reinstalação): descarrega antes; falha aqui é normal
      let r = launchctl('bootstrap', dominio, plist);
      // Logo depois de um bootout que descarregou, o launchd às vezes ainda não terminou e recusa o bootstrap
      // ("5: Input/output error"): tenta de novo algumas vezes antes de desistir.
      for (let i = 0; !r.ok && fora.ok && i < 4; i++) {
        esperar(500);
        r = launchctl('bootstrap', dominio, plist);
      }
      if (!r.ok) throw new Error(`não consegui carregar o agente (launchctl bootstrap): ${r.saida}`);
      fs.writeFileSync(marca, JSON.stringify({ sistema: 'darwin', rotulo: ROTULO, instalado: new Date().toISOString(), node, lancador, plist }, null, 2) + '\n');
      escrever(`Agente "${ROTULO}" instalado (${plist}). O hook e o iniciar.command passam a subir o servidor por ele.`);
    },
    remover() {
      const r = launchctl('bootout', servico);
      fs.rmSync(plist, { force: true });
      fs.rmSync(marca, { force: true });
      escrever(r.ok ? `Agente "${ROTULO}" removido.` : `Agente "${ROTULO}" removido (não estava carregado: ${r.saida}).`);
    },
    estado() {
      const r = launchctl('print', servico);
      let txt = 'não carregado';
      if (r.ok) {
        const estado = (/^\s*state = (.+)$/m.exec(r.saida) || [])[1] || '?';
        const saida = (/^\s*last exit code = (.+)$/m.exec(r.saida) || [])[1] || '?';
        txt = `carregado; estado ${estado}; último código de saída ${saida}`;
      }
      escrever(`Agente "${ROTULO}": ${txt}`);
      escrever(`plist: ${fs.existsSync(plist) ? 'existe' : 'não existe'} (${plist})`);
      escrever(`logon.json: ${fs.existsSync(marca) ? 'existe' : 'não existe'}`);
    },
    subir() {
      const c = comandoSubirPelaTarefa({ sistema: 'darwin', rotulo: ROTULO }, { so, uid });
      if (!c) return escrever('Falhou: não consegui saber o uid deste usuário.');
      const r = rodar(c.cmd, c.args, 20000);
      escrever(r.ok ? 'Agente iniciado.' : `Falhou: ${r.saida}`);
    },
  };

  const sis = so === 'win32' ? win : so === 'darwin' ? mac : null;
  return {
    plist,
    executar(cmd) {
      if (!sis) return escrever('Só no Windows e no macOS.');
      if (!['instalar', 'remover', 'estado', 'subir'].includes(cmd)) return escrever('uso: node logon.mjs instalar | remover | estado | subir');
      return sis[cmd]();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    criarLogon().executar(process.argv[2]);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
