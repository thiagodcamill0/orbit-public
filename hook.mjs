// Orbit (gerenciador de instâncias do Claude Code) — ponte dos hooks.
// Lê o JSON do evento no stdin, acrescenta o título da aba (lido do fim do
// transcript) e manda para o servidor local. Se o servidor não estiver no ar e o
// usuário permitiu (argumento --subir, posto pelo `node instalar.mjs --abrir-sozinho`),
// sobe ele em segundo plano e tenta de novo; sem a permissão, só desiste.
// Nunca escreve no stdout e sempre sai com 0: não pode atrapalhar a sessão.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Hora em que o processo nasceu (antes de carregar os módulos): ordena melhor
// os eventos assíncronos, que chegam ao servidor em ordem arbitrária.
const ts = Math.round(performance.timeOrigin) || Date.now();
const PASTA = path.dirname(fileURLToPath(import.meta.url));
const PORTA = Number(process.env.GERENCIADOR_PORTA || 47821);

function lerStdin() {
  return new Promise((resolve) => {
    const partes = [];
    const fim = () => resolve(Buffer.concat(partes).toString('utf8'));
    process.stdin.on('data', (c) => partes.push(c));
    process.stdin.on('end', fim);
    process.stdin.on('error', fim);
    setTimeout(fim, 3000).unref();
  });
}

// Título da aba: o último "custom-title" (/rename) ou "ai-title" do transcript.
function lerTitulo(arquivo) {
  if (!arquivo || typeof arquivo !== 'string') return '';
  let fd;
  try {
    fd = fs.openSync(arquivo, 'r');
    const tam = fs.fstatSync(fd).size;
    const n = Math.min(tam, 768 * 1024);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, tam - n);
    const texto = buf.toString('utf8');
    let titulo = '';
    let personalizado = '';
    for (const m of texto.matchAll(/"customTitle":"((?:[^"\\]|\\.)*)"/g)) personalizado = m[1];
    if (!personalizado) for (const m of texto.matchAll(/"aiTitle":"((?:[^"\\]|\\.)*)"/g)) titulo = m[1];
    const bruto = personalizado || titulo;
    return bruto ? JSON.parse(`"${bruto}"`) : '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function texto(v, max) {
  return typeof v === 'string' && v ? v.slice(0, max) : undefined;
}

// Só o que o painel mostra da entrada da ferramenta (nunca o conteúdo inteiro).
function resumirEntrada(ferramenta, entrada) {
  if (!entrada || typeof entrada !== 'object') return undefined;
  if (ferramenta === 'AskUserQuestion') {
    const q = entrada.questions?.[0]?.question;
    return q ? { questions: [{ question: String(q).slice(0, 200) }] } : undefined;
  }
  if (ferramenta === 'Agent' || ferramenta === 'Task') {
    // A descrição e o tipo casam o lançamento com o SubagentStart (o prompt fica de fora).
    return { description: texto(entrada.description, 200), subagent_type: texto(entrada.subagent_type, 100) };
  }
  const out = {};
  for (const k of ['command', 'file_path', 'notebook_path', 'path', 'url', 'pattern', 'query', 'skill', 'description', 'prompt']) {
    if (typeof entrada[k] === 'string' && entrada[k]) {
      out[k] = entrada[k].slice(0, 200);
      break;
    }
  }
  return out;
}

function enviar(corpo) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORTA,
        path: '/evento',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(corpo), 'x-gerenciador': '1' },
        timeout: 1500,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode === 200));
        res.on('error', () => resolve(false));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', (e) => resolve(e.code === 'ECONNREFUSED' ? 'fora' : false));
    req.end(corpo);
  });
}

// Com a tarefa de logon instalada (logon.mjs grava o logon.json), o servidor de produção sobe por
// ela: nasce fora do job da sessão que chamou o hook (VS Code) e não morre com ela. Devolve true
// quando pediu à tarefa; `direto` força o caminho antigo (a tarefa não respondeu).
const MARCA_LOGON = path.join(PASTA, 'logon.json');
function subirServidor(direto = false) {
  try {
    if (!direto && PORTA === 47821 && !process.env.GERENCIADOR_DADOS && fs.existsSync(MARCA_LOGON)) {
      const marca = JSON.parse(fs.readFileSync(MARCA_LOGON, 'utf8'));
      // Mac (16/10): LaunchAgent do logon.mjs, subido pelo launchctl. Sem `sistema`, é o logon.json do Windows.
      if (marca.sistema === 'darwin' && process.platform === 'darwin' && typeof marca.rotulo === 'string' && /^[\w.-]+$/.test(marca.rotulo)) {
        const p = spawn('/bin/launchctl', ['kickstart', `gui/${process.getuid()}/${marca.rotulo}`], { detached: true, stdio: 'ignore' });
        p.on('error', () => {});
        p.unref();
        return true;
      }
      const tarefa = marca.tarefa;
      if (process.platform === 'win32' && typeof tarefa === 'string' && tarefa) {
        spawn('schtasks.exe', ['/run', '/tn', tarefa], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return true;
      }
    }
  } catch {}
  try {
    const filho = spawn(process.execPath, [path.join(PASTA, 'servidor.mjs')], {
      cwd: PASTA,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    filho.unref();
  } catch {}
  return false;
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const ev = JSON.parse((await lerStdin()) || '{}');
  if (ev && typeof ev === 'object' && ev.session_id) {
    const nome = ev.hook_event_name;
    // O título só muda entre turnos; nos eventos de ferramenta (os mais
    // frequentes) o servidor v2 já relê o transcript por conta própria.
    const ferramenta = nome === 'PreToolUse' || nome === 'PostToolUse' || nome === 'PostToolUseFailure';
    const corpo = JSON.stringify({
      ts,
      hook_event_name: nome,
      session_id: ev.session_id,
      cwd: process.env.CLAUDE_PROJECT_DIR || ev.cwd,
      pid: process.ppid,
      // Sessão dependente (processo criado por outra sessão): o id da mãe.
      host_session_id: texto(process.env.CLAUDE_CODE_HOST_SESSION_ID, 200),
      transcript_path: texto(ev.transcript_path, 1000),
      agent_id: texto(ev.agent_id, 200),
      agent_type: texto(ev.agent_type, 200),
      source: texto(ev.source, 100),
      reason: texto(ev.reason, 200),
      prompt: texto(ev.prompt, 20000),
      tool_name: texto(ev.tool_name, 200),
      tool_use_id: texto(ev.tool_use_id, 200),
      tool_input: resumirEntrada(ev.tool_name, ev.tool_input),
      message: texto(ev.message, 400),
      notification_type: texto(ev.notification_type, 100),
      error: typeof ev.error === 'string' ? ev.error.slice(0, 400) : ev.error ? JSON.stringify(ev.error).slice(0, 400) : undefined,
      error_details: texto(ev.error_details, 400),
      last_assistant_message: texto(ev.last_assistant_message, 20000),
      titulo: ferramenta ? undefined : lerTitulo(ev.transcript_path),
    });

    let r = await enviar(corpo);
    if (r === 'fora' && process.argv.includes('--subir')) {
      const pelaTarefa = subirServidor();
      for (let i = 0; i < 8 && r !== true; i++) {
        await espera(250);
        r = await enviar(corpo);
        if (pelaTarefa && i === 5 && r === 'fora') subirServidor(true); // a tarefa não subiu: sobe direto
      }
    }
  }
} catch {}
process.exit(0);
