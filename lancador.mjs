// Orbit — lançador. É o que a tarefa agendada do Orbit roda (no logon do Windows e quando o hook
// ou o iniciar.cmd pedem, ver logon.mjs): sobe o servidor.mjs em segundo plano, sem janela, se ele
// não estiver no ar, e sai. Pela tarefa, o servidor nasce fora do job do VS Code e não morre quando
// o VS Code fecha (decisão D3, 15/10: "Orbit sem VS Code").
// No Mac é o LaunchAgent (logon.mjs) que roda este arquivo; o launchd sobe com PATH mínimo, então o
// servidor recebe o PATH ampliado (Homebrew, ~/.local/bin do claude).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WIN, pathAmpliado } from './plataforma.mjs';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const PORTA = Number(process.env.GERENCIADOR_PORTA || 47821);
const LOG = path.join(PASTA, 'logs', 'lancador.log');

function log(...a) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    if ((fs.statSync(LOG, { throwIfNoEntry: false })?.size || 0) > 512 * 1024) fs.renameSync(LOG, LOG + '.1');
    fs.appendFileSync(LOG, [new Date().toISOString(), process.pid, ...a].join(' ') + '\n');
  } catch {}
}

function noAr() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORTA, path: '/saude', timeout: 800 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

if (await noAr()) {
  log('servidor já estava no ar');
} else {
  try {
    const filho = spawn(process.execPath, [path.join(PASTA, 'servidor.mjs')], { cwd: PASTA, detached: true, stdio: 'ignore', windowsHide: true, env: WIN ? process.env : { ...process.env, PATH: pathAmpliado() } });
    filho.unref();
    log('servidor iniciado, pid', filho.pid);
  } catch (e) {
    log('falhou ao iniciar o servidor:', e.message);
  }
}
process.exit(0);
