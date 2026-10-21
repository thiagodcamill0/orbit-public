// Instala (ou remove, com --remover) os hooks globais de monitoramento do Orbit em
// ~/.claude/settings.json. Idempotente: só mexe nas entradas que apontam para
// o hook.mjs desta pasta, preserva o resto e guarda um backup da primeira vez.
// Instala também a statusLine (statusline.mjs) se o usuário não tiver uma própria.
// Opcionais, só com a permissão do usuário (o assistente da primeira vez pergunta):
//   --aviso-subagente / --sem-aviso-subagente: hook SÍNCRONO de PostToolUse (aviso-subagente.mjs) que avisa o
//     subagente acima do limite de contexto e explica ao líder o que fazer, em qualquer projeto. Sem nenhuma
//     das duas, fica como estava.
//   --liderar-time / --sem-liderar-time: a skill pessoal liderar-time (skills/liderar-time/SKILL.md, com a pasta de
//     progresso desta instalação) em ~/.claude/skills/liderar-time/. Nunca sobrescreve uma skill do usuário.
//   --abrir-sozinho / --sem-abrir-sozinho: o hook.mjs abre o servidor do Orbit quando uma sessão do Claude Code
//     manda um evento e ele está fechado (argumento --subir do hook). Sem a permissão, o hook só desiste.
// --remover tira tudo o que é do Orbit (hooks, status line e a skill, se for a nossa).
// GERENCIADOR_SETTINGS, GERENCIADOR_SKILLS e GERENCIADOR_DADOS apontam para outros lugares (testes).
//
// Mac/Linux (16/10): o Claude Code aberto pelo Dock/launchd pode não ter o node no PATH (Homebrew, nvm).
// Lá os hooks gravam o caminho completo do node (o estável, /opt/homebrew/bin/node, quando é o mesmo
// arquivo; senão o que roda este instalador) e a status line vai com aspas simples do sh (caminho com
// espaço, $ ou aspas). Os hooks usam o formato exec ("command" = executável, "args"): sem shell, sem
// aspas. No Windows tudo segue como era ("node" + args; status line `node "<caminho>"`).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acharNoPath } from './plataforma.mjs';

const ARQ_ESTE = fileURLToPath(import.meta.url);
const PASTA = path.dirname(ARQ_ESTE);
const HOOK = path.join(PASTA, 'hook.mjs').replace(/\\/g, '/');
const STATUSLINE = path.join(PASTA, 'statusline.mjs').replace(/\\/g, '/');
const AVISO = path.join(PASTA, 'aviso-subagente.mjs').replace(/\\/g, '/');
const SKILL_MODELO = path.join(PASTA, 'skills', 'liderar-time', 'SKILL.md');
const MARCA_SKILL = 'Instalada pelo Orbit';

// Os do hook.mjs são todos assíncronos: rodam em segundo plano e nunca atrasam a sessão.
// null = sem matcher (todas as ferramentas / todos os casos).
const EVENTOS = {
  SessionStart: null,
  UserPromptSubmit: null,
  PreToolUse: null,
  PermissionRequest: null,
  PostToolUse: null,
  PostToolUseFailure: null,
  Notification: null,
  Stop: null,
  StopFailure: null,
  SubagentStart: null,
  SubagentStop: null,
  SessionEnd: null,
};

function caminhoReal(f) {
  try {
    return fs.realpathSync(f);
  } catch {
    return f;
  }
}

// O node que os hooks e a status line chamam. Windows: "node" (como sempre). Mac/Linux: caminho completo;
// o do PATH ampliado quando é o mesmo arquivo do node atual (sobrevive ao `brew upgrade`, que troca a
// pasta da versão), senão o node atual. `o = { so, execPath, achar, real }` só nos testes.
export function nodeDoHook(o = {}) {
  const so = o.so || process.platform;
  if (so === 'win32') return 'node';
  const exe = o.execPath || process.execPath;
  const real = o.real || caminhoReal;
  const achado = o.achar ? o.achar('node') : acharNoPath('node');
  return achado && real(achado) === real(exe) ? achado : exe;
}

// Aspas simples do sh: o texto vai literal (' vira '\'').
export const aspasSh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Comando da status line (texto de shell: o schema desta versão não aceita args).
export function comandoStatus(o = {}) {
  const so = o.so || process.platform;
  const arq = o.statusline || STATUSLINE;
  if (so === 'win32') return `node "${arq}"`;
  return `${aspasSh(nodeDoHook(o))} ${aspasSh(arq)}`;
}

// Entrada de um evento (formato exec: sem shell, caminho com espaço vale).
export const hookDoOrbit = (o = {}) => ({ type: 'command', command: nodeDoHook(o), args: [o.hook || HOOK, ...(o.subir ? ['--subir'] : [])], timeout: 10, async: true });
// O aviso ao subagente: síncrono (a saída de um hook assíncrono não chega ao subagente), grupo à parte, sem matcher.
export const hookDoAviso = (o = {}) => ({ type: 'command', command: nodeDoHook(o), args: [o.aviso || AVISO], timeout: 5 });

// Texto da skill liderar-time com a pasta de progresso desta instalação.
export function textoDaSkill(dados, modelo = fs.readFileSync(SKILL_MODELO, 'utf8')) {
  return modelo.split('{{PROGRESSO}}').join(path.join(path.resolve(dados), 'progresso').replace(/\\/g, '/'));
}

const mesmoArq = (x, alvo) => String(x).replace(/\\/g, '/').toLowerCase() === alvo.toLowerCase();

// O que está instalado (para o assistente da primeira vez): hooks, aviso, abrir sozinho e a skill.
export function estadoDaInstalacao(o = {}) {
  const settings = path.resolve(o.settings || process.env.GERENCIADOR_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json'));
  const skills = path.resolve(o.skills || process.env.GERENCIADOR_SKILLS || path.join(os.homedir(), '.claude', 'skills'));
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(settings, 'utf8').replace(/^﻿/, '')) || {}; } catch {}
  const todos = Object.values(cfg?.hooks && typeof cfg.hooks === 'object' ? cfg.hooks : {})
    .flatMap((gs) => (Array.isArray(gs) ? gs : []).flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : [])));
  const doHook = todos.filter((h) => (h?.args || []).some((x) => mesmoArq(x, HOOK)));
  let skill = 'nao';
  try {
    const t = fs.readFileSync(path.join(skills, 'liderar-time', 'SKILL.md'), 'utf8');
    skill = t.includes(MARCA_SKILL) ? 'orbit' : 'usuario';
  } catch {}
  return {
    hooks: doHook.length > 0,
    subir: doHook.some((h) => (h.args || []).includes('--subir')),
    aviso: todos.some((h) => (h?.args || []).some((x) => mesmoArq(x, AVISO))),
    liderar: skill,
  };
}

// Instala ou tira a skill pessoal. Devolve a linha para o usuário ('' = nada a dizer).
export function cuidarDaSkill(acao, dados, pastaSkills) {
  const dir = path.join(pastaSkills, 'liderar-time');
  const arq = path.join(dir, 'SKILL.md');
  const atual = fs.existsSync(arq) ? fs.readFileSync(arq, 'utf8') : null;
  const nossa = atual !== null && atual.includes(MARCA_SKILL);
  if (acao === 'tirar') {
    if (!nossa) return '';
    fs.rmSync(dir, { recursive: true, force: true });
    return `Skill liderar-time removida de ${dir}`;
  }
  if (atual !== null && !nossa) return `Aviso: já existe uma skill liderar-time sua em ${dir}; ela foi mantida e a do Orbit não foi instalada.`;
  const novo = textoDaSkill(dados);
  if (atual === novo) return `Skill liderar-time já instalada em ${dir}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(arq, novo);
  return `Skill liderar-time instalada em ${dir} (progresso em ${path.join(path.resolve(dados), 'progresso')})`;
}

function principal() {
  const CONFIG = path.resolve(process.env.GERENCIADOR_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json'));
  const BACKUP = CONFIG + '.bak-gerenciador';
  const remover = process.argv.includes('--remover');
  const tem = (x) => process.argv.includes(x);
  const DADOS_ORBIT = path.resolve(process.env.GERENCIADOR_DADOS || PASTA);
  const SKILLS = path.resolve(process.env.GERENCIADOR_SKILLS || path.join(os.homedir(), '.claude', 'skills'));

  const nossos = [HOOK.toLowerCase(), AVISO.toLowerCase()];
  const mesmoHook = (x) => nossos.includes(String(x).replace(/\\/g, '/').toLowerCase());
  const ehNosso = (h) =>
    h?.type === 'command' &&
    (mesmoHook(h.command) || (h.args || []).some(mesmoHook) || nossos.some((n) => String(h.command || '').replace(/\\/g, '/').toLowerCase().includes(n)));

  let config = {};
  let original = '';
  if (fs.existsSync(CONFIG)) {
    original = fs.readFileSync(CONFIG, 'utf8');
    try {
      config = original.trim() ? JSON.parse(original.replace(/^﻿/, '')) : {};
    } catch (e) {
      console.error(`${CONFIG} não é um JSON válido (${e.message}). Nada foi alterado.`);
      process.exit(1);
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      console.error(`${CONFIG} não contém um objeto JSON. Nada foi alterado.`);
      process.exit(1);
    }
  }
  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) config.hooks = {};
  const ehAviso = (h) => h?.type === 'command' && (h.args || []).some((x) => String(x).replace(/\\/g, '/').toLowerCase() === AVISO.toLowerCase());
  const tinhaAviso = (config.hooks.PostToolUse || []).some((g) => (g?.hooks || []).some(ehAviso));
  const querAviso = !remover && !tem('--sem-aviso-subagente') && (tem('--aviso-subagente') || tinhaAviso);
  const ehHook = (h) => h?.type === 'command' && (h.args || []).some((x) => mesmoArq(x, HOOK));
  const tinhaSubir = Object.values(config.hooks).some((gs) => Array.isArray(gs) && gs.some((g) => (g?.hooks || []).some((h) => ehHook(h) && h.args.includes('--subir'))));
  const querSubir = !tem('--sem-abrir-sozinho') && (tem('--abrir-sozinho') || tinhaSubir);

  // Tira as entradas antigas deste gerenciador (reinstalar não duplica).
  for (const [evento, grupos] of Object.entries(config.hooks)) {
    if (!Array.isArray(grupos)) continue;
    const restantes = grupos
      .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !ehNosso(h)) } : g))
      .filter((g) => !g || !Array.isArray(g.hooks) || g.hooks.length);
    if (restantes.length) config.hooks[evento] = restantes;
    else delete config.hooks[evento];
  }

  if (!remover) {
    for (const [evento, matcher] of Object.entries(EVENTOS)) {
      const grupo = {
        ...(matcher ? { matcher } : {}),
        hooks: [hookDoOrbit({ subir: querSubir })],
      };
      (config.hooks[evento] ||= []).push(grupo);
    }
    if (querAviso) config.hooks.PostToolUse.push({ hooks: [hookDoAviso()] });
  }
  if (!Object.keys(config.hooks).length) delete config.hooks;

  // Status line: o comando é um texto só (o schema desta versão não aceita args).
  // Só instala se não houver uma do usuário; nunca mexe numa que não seja a nossa.
  const linhaStatus = { type: 'command', command: comandoStatus() };
  const statusNossa = (sl) => !!sl && typeof sl === 'object' && String(sl.command || '').replace(/\\/g, '/').toLowerCase().includes(STATUSLINE.toLowerCase());
  let avisoStatus = '';
  if (config.statusLine === undefined || config.statusLine === null) {
    if (!remover) config.statusLine = linhaStatus;
  } else if (statusNossa(config.statusLine)) {
    if (remover) delete config.statusLine;
    else config.statusLine = { ...config.statusLine, ...linhaStatus };
  } else {
    avisoStatus = `Aviso: já existe uma statusLine do usuário (${JSON.stringify(config.statusLine.command ?? config.statusLine)}); ela foi mantida e a do gerenciador não foi ${remover ? 'removida (não é nossa)' : 'instalada'}.`;
  }

  // Skill pessoal: só com --liderar-time; sai com --sem-liderar-time ou --remover (só a nossa).
  let linhaSkill = '';
  try {
    if (remover || tem('--sem-liderar-time')) linhaSkill = cuidarDaSkill('tirar', DADOS_ORBIT, SKILLS);
    else if (tem('--liderar-time')) linhaSkill = cuidarDaSkill('instalar', DADOS_ORBIT, SKILLS);
  } catch (e) {
    linhaSkill = `Skill liderar-time: não consegui (${e.message}).`;
  }
  if (linhaSkill) console.log(linhaSkill);

  const novo = JSON.stringify(config, null, 2) + '\n';
  if (novo === original) {
    console.log(`Nada a mudar em ${CONFIG} (${remover ? 'hooks e status line já removidos' : `${Object.keys(EVENTOS).length} eventos${avisoStatus ? '' : ' e status line'} já instalados`}).`);
    if (avisoStatus) console.log(avisoStatus);
    process.exit(0);
  }

  // Guarda só o primeiro backup: o de antes de qualquer instalação.
  if (original && !fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, original);

  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  const tmp = `${CONFIG}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, novo);
  try {
    fs.renameSync(tmp, CONFIG);
  } catch {
    fs.writeFileSync(CONFIG, novo);
    try { fs.unlinkSync(tmp); } catch {}
  }
  console.log(remover ? `Hooks removidos de ${CONFIG}` : `Hooks instalados em ${CONFIG} (${Object.keys(EVENTOS).length} eventos${querAviso ? ' e o aviso aos subagentes' : ''}${querSubir ? '; abre o Orbit sozinho' : ''})`);
  if (!avisoStatus) console.log(remover ? 'Status line do gerenciador removida.' : `Status line: ${linhaStatus.command}`);
  else console.log(avisoStatus);
  if (fs.existsSync(BACKUP)) console.log(`Backup: ${BACKUP}`);
}

// Só roda como script (node instalar.mjs [--remover]); importado (testes), expõe as funções puras.
const chamado = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (chamado && (process.platform === 'win32' ? chamado.toLowerCase() === ARQ_ESTE.toLowerCase() : caminhoReal(chamado) === caminhoReal(ARQ_ESTE))) principal();
