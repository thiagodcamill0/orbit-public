// Orbit — gerenciador de instâncias do Claude Code — servidor local (v2).
// Recebe os eventos dos hooks (POST /evento), guarda o estado das sessões e
// empurra cada mudança para a página por Server-Sent Events (GET /fluxo).
// Além dos hooks, acompanha por conta própria: o processo do Claude Code
// (vivo ou não), o transcript (atividade, interrupção com Esc, título,
// contexto), o registro de sessões do próprio Claude Code (~/.claude/sessions),
// os subagentes de cada sessão e os lembretes de quem está esperando há muito tempo.
// Só escuta em 127.0.0.1. Sem dependências.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { criarControle, AUTO_COMPACTAR_PADRAO, LIMITE_AUTO_MIN, LIMITE_AUTO_MAX } from './controle.mjs'; // rodada 5: conversa, canal e processos do Orbit
import { criarPerfil, criarCofreTexto } from './perfil.mjs'; // perfil no pé da lateral e conta do GitHub (token cifrado fora do projeto)
import { lerUsoAgora } from './uso-leitura.mjs'; // botão "atualizar" do card Uso do plano (chamada mínima sob demanda)
import { lerContaClaude, criarContaClaude } from './conta-claude.mjs'; // plano e conta do Claude no cabeçalho do card Uso do plano (17/10)
import * as plataforma from './plataforma.mjs'; // o que muda entre Windows e Mac (16/10)
import { comJanela } from './janela.mjs'; // janela de contexto de cada modelo (20/10): subagentes e sessões sem status line
import { contextoDaCauda, PASTA_AVISOS, PASTA_PROGRESSO } from './aviso-subagente.mjs'; // subagente acima do limite (20/10): medida, marca do aviso direto e pasta de progresso

const VERSAO = '2';
const PASTA = path.dirname(fileURLToPath(import.meta.url));
// Mac: o launchd e o Finder sobem o Orbit com PATH mínimo (sem Homebrew nem ~/.local/bin); os filhos herdam este.
if (!plataforma.WIN) process.env.PATH = plataforma.pathAmpliado();
const PORTA = Number(process.env.GERENCIADOR_PORTA || 47821);
const DADOS = path.resolve(process.env.GERENCIADOR_DADOS || PASTA);
const ARQ_ESTADO = path.join(DADOS, 'estado.json');
const ARQ_CONFIG = path.join(DADOS, 'config.json');
const ARQ_HISTORICO = path.join(DADOS, 'historico.json');
const CABECALHO = 'x-gerenciador'; // força preflight em pedidos de outra origem, que nunca autorizamos

// Intervalos (os testes encurtam pelo ambiente).
const MS_TICK = Number(process.env.GERENCIADOR_TICK_MS) || 5000; // transcript, lembrete, virada do dia
const MS_PID = Number(process.env.GERENCIADOR_PID_MS) || 15000; // processo vivo?
const MS_LIMPEZA = 10 * 60e3;
const MS_PING = 25e3;

const DOZE_HORAS = 12 * 3600e3;
const DOIS_DIAS = 48 * 3600e3;
const MAX_EVENTOS = 200;
const MAX_HISTORICO = 300;
const MAX_CORPO = 256 * 1024;
const CAUDA_TRANSCRIPT = 256 * 1024;
const MAX_PEDIDO = 20000; // caracteres do último prompt guardados em "pedido"
const MAX_RESPOSTA = 20000; // caracteres da última resposta guardados em "ultimaResposta" (o card mostra inteira)
const SUBAGENTE_ESQUECIDO = 30 * 60e3; // subagente ativo sem sinal há 30 min sai da lista
const AGENTE_VISIVEL = 30 * 60e3; // subagente concluído fica visível 30 min (ou até o próximo prompt)
const MAX_AGENTES = 20;
const MAX_ACOES = 8; // feed curto das últimas ações de cada subagente
const CAUDA_AGENTE = 64 * 1024; // fim do transcript do subagente lido para a última mensagem de texto
const MAX_TEXTO_AGENTE = 280;
const AGENTE_RELER = 60e3; // depois do fim, o transcript do subagente ainda é olhado por 1 min (mensagem final)
const MAX_PEDIDO_AGENTE = 4000; // prompt do Agent guardado como reserva do detalhe (sem transcript)
const MAX_ARQ_AGENTE = 16 * 1024 * 1024; // transcript do subagente lido inteiro até aqui; acima, começo + fim
const MAX_EVENTOS_AGENTE = 300;
// Registro de sessões do Claude Code: um <pid>.json por processo vivo.
const SESSOES_DIR = path.resolve(process.env.GERENCIADOR_SESSOES_DIR || path.join(os.homedir(), '.claude', 'sessions'));
const MS_OCIOSO = Number(process.env.GERENCIADOR_OCIOSO_MS) || 10e3; // idle no registro sem Stop → interrompida

const ATIVOS = new Set(['trabalhando', 'aguardando']);
const TIPOS_ALERTA = ['concluida', 'aguardando', 'erro', 'lembrete', 'interrompida'];

const CONFIG_PADRAO = {
  notificar: { concluida: true, aguardando: true, erro: true, interrompida: false, lembrete: true },
  som: { ativo: true, volume: 0.6 },
  naoPerturbe: { ativo: false, agendado: false, inicio: '22:00', fim: '07:00' },
  lembreteMin: 5,
  cliqueAbreVSCode: true,
  cliqueAbre: 'orbit', // rodada 6, etapa 5: o clique (notificação, Enter, o) abre a Conversa do Orbit ou o VS Code
  projetos: {}, // { [nome]: { icone, cor, rotulo, brain? } }: ícone, tag de cor e nome de exibição de cada projeto (20/10: rotulo não mexe na pasta); 21/10: brain = pasta de notas do widget Grafo ('' = sem; sem o campo, o projeto do Orbit usa o cofre)
  instancias: { dormirApos: 30, modoPadrao: 'auto', autoCompactar: { ...AUTO_COMPACTAR_PADRAO } }, // rodada 6, etapa 4: minutos sem atividade até a instância do Orbit dormir (0 = nunca); 16/10: modo de permissão das novas; 20/10: compactação automática
  // Celular (20/10, remoto.mjs): 2ª porta só em 127.0.0.1, aberta só com ativo; host (ts.net) e dono (login do Tailscale).
  remoto: { ativo: false, porta: 47820, host: '', dono: '', criarInstancias: false, notificar: { precisa: true, terminou: true } },
};
const MODOS_PERMISSAO = ['default', 'acceptEdits', 'plan', 'auto'];

const iniciouEm = Date.now();
let ultimoHook = 0;

/** @type {Map<string, any>} sessões (campos com "_" são internos e não saem na API) */
const sessoes = new Map();
/** @type {Map<string, Array<{ts:number,tipo:string,texto:string}>>} */
const eventos = new Map();
let historico = [];
let config = structuredClone(CONFIG_PADRAO);
let resumo = resumoVazio();
let seqAlerta = 0;
/** Uso do plano, vindo da status line: { cincoHoras: {pct, renova}|null, semanal: {pct, renova}|null, atualizado } */
let uso = null;
let usoDifundidoEm = 0;
const sondasUso = new Set(); // sessionId das chamadas do botão "atualizar" (uso-leitura.mjs): nunca entram na lista
let lendoUso = null; // a leitura sob demanda em curso (uma por vez)
/** ids que o usuário (ou a limpeza) tirou: o registro não os traz de volta; um evento de hook traz. */
const removidas = new Map();
const clientes = new Set();

// ───────────────────────── utilidades ─────────────────────────

// Também em arquivo (logs/servidor.log, 2 MB + 1 antigo): o servidor sobe sem console (hook, tarefa
// de logon) e, sem isso, a causa de uma queda se perde.
const LOG = path.join(DADOS, 'logs', 'servidor.log');
function log(...a) {
  const linha = [new Date().toISOString(), process.pid, ...a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.stack : String(x)))].join(' ');
  try { console.log(linha); } catch {}
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    if ((fs.statSync(LOG, { throwIfNoEntry: false })?.size || 0) > 2 * 1024 * 1024) fs.renameSync(LOG, LOG + '.1');
    fs.appendFileSync(LOG, linha + '\n');
  } catch {}
}

function encurtar(texto, max) {
  const t = String(texto ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// Como encurtar, mas mantém as quebras de linha (o texto do pedido no detalhe).
function encurtarBloco(texto, max) {
  const t = String(texto ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function descreverFerramenta(nome, entrada) {
  nome = encurtar(nome, 60) || 'ferramenta';
  if (!entrada || typeof entrada !== 'object') return nome;
  const alvo = alvoDe(entrada);
  return alvo ? `${nome}: ${alvo}` : nome;
}

function alvoDe(entrada) {
  if (!entrada || typeof entrada !== 'object') return '';
  for (const k of ['command', 'file_path', 'notebook_path', 'path', 'url', 'pattern', 'query', 'skill', 'description', 'prompt']) {
    if (typeof entrada[k] === 'string' && entrada[k]) return encurtar(entrada[k], 90);
  }
  const q = entrada.questions?.[0]?.question;
  return typeof q === 'string' ? encurtar(q, 90) : '';
}

function hoje(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function meiaNoite(t = Date.now()) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function vinteQuatro() {
  return new Array(24).fill(0);
}

function porHoraVazio() {
  return { trabalhandoMs: vinteQuatro(), concluidas: vinteQuatro(), esperas: vinteQuatro(), aguardandoMs: vinteQuatro() };
}

// Parte do resumo do dia que vale só para as instâncias nativas (é o que o celular recebe).
function natVazio() {
  return { turnos: 0, msTrabalhando: 0, msAguardando: 0, esperas: 0 };
}

function resumoVazio() {
  return { data: hoje(), turnos: 0, msTrabalhando: 0, msAguardando: 0, esperas: 0, sessoes: 0, porHora: porHoraVazio(), _ids: [], _nat: natVazio() };
}

function horaDe(t) {
  return new Date(t).getHours();
}

// Reparte o trecho [ini, fim) pelas horas locais.
function somarHoras(arr, ini, fim) {
  let a = ini;
  for (let guarda = 0; a < fim && guarda < 30; guarda++) {
    const d = new Date(a);
    const h = d.getHours();
    d.setMinutes(60, 0, 0); // início da hora seguinte
    const b = Math.min(fim, d.getTime());
    arr[h] += b - a;
    a = b;
  }
}

function porHoraValido(p) {
  const ok = (v) => Array.isArray(v) && v.length === 24 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
  return p && typeof p === 'object' && ok(p.trabalhandoMs) && ok(p.concluidas) && ok(p.esperas) && ok(p.aguardandoMs);
}

const publicoResumo = () => {
  const { _ids, _nat, ...r } = resumo;
  return r;
};

// Sem os campos internos ("_..."), inclusive os dos subagentes e das ações deles.
function semInternos(x) {
  const o = {};
  for (const k in x) if (k[0] !== '_') o[k] = k === 'acoes' && Array.isArray(x[k]) ? x[k].map(semInternos) : x[k];
  return o;
}

function publico(s) {
  const o = {};
  for (const k in s) if (k[0] !== '_') o[k] = s[k];
  if (Array.isArray(s.agentes)) o.agentes = s.agentes.map(semInternos);
  o.controle = s.provedor === 'codex' && codex ? codex.estado(s) : controle.estado(s);
  return o;
}

// Retrato curto da sessão para alertas e histórico.
function retrato(s) {
  return {
    id: s.id,
    titulo: s.titulo,
    apelido: s.apelido,
    nome: s.nome,
    pai: s.pai,
    projeto: s.projeto,
    cwd: s.cwd,
    status: s.status,
    detalhe: s.detalhe,
    tarefa: s.tarefa,
    ultimaResposta: encurtar(s.ultimaResposta, 300),
  };
}

// ───────────────────────── persistência ─────────────────────────

function lerJSON(arquivo, padrao) {
  let bruto;
  try {
    bruto = fs.readFileSync(arquivo, 'utf8');
  } catch {
    return padrao; // não existe
  }
  try {
    return JSON.parse(bruto.replace(/^﻿/, ''));
  } catch (e) {
    // Arquivo corrompido: guarda uma cópia para inspeção e começa do zero.
    try { fs.renameSync(arquivo, `${arquivo}.corrompido-${Date.now()}`); } catch {}
    log(`JSON inválido em ${arquivo}: ${e.message}`);
    return padrao;
  }
}

function gravarAtomico(arquivo, conteudo) {
  const tmp = `${arquivo}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, conteudo);
    try {
      fs.renameSync(tmp, arquivo);
    } catch {
      // No Windows o rename falha se outro processo (antivírus, indexador) segura o destino.
      fs.writeFileSync(arquivo, conteudo);
      try { fs.unlinkSync(tmp); } catch {}
    }
  } catch (e) {
    log(`falha ao gravar ${arquivo}: ${e.message}`);
  }
}

const gravadores = {
  estado: () =>
    JSON.stringify({
      versao: 2,
      sessoes: [...sessoes.values()],
      eventos: Object.fromEntries(eventos),
      resumo,
      seqAlerta,
      removidas: [...removidas],
      uso,
    }),
  config: () => JSON.stringify(config, null, 2),
  historico: () => JSON.stringify(historico),
};
const arquivos = { estado: ARQ_ESTADO, config: ARQ_CONFIG, historico: ARQ_HISTORICO };
const pendentes = new Map();

function salvar(qual = 'estado') {
  if (pendentes.has(qual)) return;
  pendentes.set(
    qual,
    setTimeout(() => {
      pendentes.delete(qual);
      gravarAtomico(arquivos[qual], gravadores[qual]());
    }, qual === 'estado' ? 500 : 150),
  );
}

function salvarTudoAgora() {
  for (const [qual, t] of pendentes) {
    clearTimeout(t);
    gravarAtomico(arquivos[qual], gravadores[qual]());
  }
  pendentes.clear();
}

// Mensagens que o próprio Claude Code injeta como prompt (retorno de subagente,
// notificação de tarefa, mensagem de outra sessão): acordam a sessão, mas não são
// o pedido do usuário.
const PROMPT_AUTOMATICO = /^\s*(\[Subagent hand-back\]|<task-notification|<cross-session-message|<agent-message|<system-reminder|\[SYSTEM NOTIFICATION)/i;
const semAutomatico = (x) => (PROMPT_AUTOMATICO.test(String(x || '')) ? '' : String(x || ''));

function normalizarSessao(s) {
  const t = Number(s.atividade) || Number(s.inicio) || Date.now();
  const n = {
    id: String(s.id),
    status: typeof s.status === 'string' ? s.status : 'nova',
    desde: Number(s.desde) || Number(s.ts) || t,
    titulo: String(s.titulo || ''),
    apelido: String(s.apelido || ''),
    projeto: String(s.projeto || ''),
    cwd: String(s.cwd || ''),
    tarefa: semAutomatico(s.tarefa),
    primeira: semAutomatico(s.primeira),
    pedido: semAutomatico(s.pedido),
    detalhe: String(s.detalhe || ''),
    ferramenta: s.ferramenta && typeof s.ferramenta === 'object' ? s.ferramenta : null,
    turno: s.turno && typeof s.turno === 'object' ? s.turno : null,
    ultimaResposta: String(s.ultimaResposta || ''),
    contexto: s.contexto && typeof s.contexto === 'object' ? s.contexto : null,
    subagentes: 0,
    agentes: normalizarAgentes(s),
    nome: String(s.nome || ''),
    pai: typeof s.pai === 'string' && s.pai ? s.pai : null,
    registro: s.registro && typeof s.registro === 'object' ? s.registro : null,
    contadores: { turnos: 0, ferramentas: 0, esperas: 0, msTrabalhando: 0, msAguardando: 0, ...(s.contadores || {}) },
    fixada: !!s.fixada,
    silenciada: !!s.silenciada,
    pid: Number(s.pid) || null,
    vivo: typeof s.vivo === 'boolean' ? s.vivo : null,
    inicio: Number(s.inicio) || t,
    atividade: t,
    _tsStatus: Number(s._tsStatus) || Number(s.ts) || 0,
    _transcript: typeof s._transcript === 'string' ? s._transcript : '',
    _mtime: Number(s._mtime) || 0,
    _custom: !!s._custom,
    _lembrete: !!s._lembrete,
    _interrupcao: String(s._interrupcao || ''),
    _emCurso: Array.isArray(s._emCurso) ? s._emCurso : [],
    _fechadas: Array.isArray(s._fechadas) ? s._fechadas : [],
    _esperaAgente: typeof s._esperaAgente === 'string' ? s._esperaAgente : '',
    _agenteTool: s._agenteTool && typeof s._agenteTool === 'object' ? s._agenteTool : {},
    _agentePend: Array.isArray(s._agentePend) ? s._agentePend : [],
    _statusAntes: typeof s._statusAntes === 'string' ? s._statusAntes : '',
    _detalheAntes: typeof s._detalheAntes === 'string' ? s._detalheAntes : '',
    _hook: s._hook === undefined ? true : !!s._hook,
    _noRegistro: !!s._noRegistro,
  };
  // Rodada 6, etapa 2: origem só quando o Orbit criou; modelo/esforço da última resposta do transcript.
  if (s.origem === 'orbit') n.origem = 'orbit';
  if (Number(s.revisadaEm) > 0 && Number(s.revisadaEm) >= n.desde) n.revisadaEm = Number(s.revisadaEm); // 21/10: "revisada" só vale enquanto >= desde
  if (s.provedor === 'codex') n.provedor = 'codex'; // Codex (codex.mjs): só gravado quando for Codex
  if (typeof s.modelo === 'string' && s.modelo) n.modelo = s.modelo.slice(0, 100);
  if (typeof s.esforco === 'string' && s.esforco) n.esforco = s.esforco.slice(0, 20);
  contarSubagentes(n);
  return n;
}

function normalizarAgentes(s) {
  if (Array.isArray(s.agentes)) {
    return s.agentes
      .filter((a) => a && typeof a.id === 'string')
      .map((a) => ({
        id: a.id,
        tipo: String(a.tipo || 'subagente'),
        descricao: String(a.descricao || ''),
        status: ['trabalhando', 'aguardando', 'concluido', 'erro'].includes(a.status) ? a.status : 'trabalhando',
        inicio: Number(a.inicio) || 0,
        fim: Number(a.fim) || null,
        ferramenta: a.ferramenta && typeof a.ferramenta === 'object' ? a.ferramenta : null,
        ferramentas: Number(a.ferramentas) || 0,
        atividade: Number(a.atividade) || Number(a.inicio) || 0,
        acoes: normalizarAcoes(a.acoes),
        texto: String(a.texto || ''),
        textoTs: Number(a.textoTs) || 0,
        _arq: typeof a._arq === 'string' ? a._arq : '',
        _mtime: Number(a._mtime) || 0,
        _fechadas: Array.isArray(a._fechadas) ? a._fechadas.filter((x) => typeof x === 'string').slice(-20) : [],
        _pedido: typeof a._pedido === 'string' ? a._pedido.slice(0, MAX_PEDIDO_AGENTE) : '',
      }));
  }
  // v2 da rodada 1: _subs = { agentId: {tipo, desde, visto} }
  if (s._subs && typeof s._subs === 'object') {
    return Object.entries(s._subs).map(([id, i]) => ({
      ...agenteVazio(id, String(i?.tipo || 'subagente'), Number(i?.desde) || 0),
      atividade: Number(i?.visto) || 0,
    }));
  }
  return [];
}

function normalizarAcoes(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .filter((x) => x && typeof x.nome === 'string')
    .slice(-MAX_ACOES)
    .map((x) => ({
      nome: x.nome,
      alvo: String(x.alvo || ''),
      ts: Number(x.ts) || 0,
      fim: Number(x.fim) || null,
      ...(x.erro ? { erro: true } : {}),
      _uid: typeof x._uid === 'string' ? x._uid : '',
    }));
}

function carregar() {
  fs.mkdirSync(DADOS, { recursive: true });
  const dados = lerJSON(ARQ_ESTADO, {});
  for (const s of Array.isArray(dados.sessoes) ? dados.sessoes : []) {
    try {
      if (s && s.id && !emPastaTemporaria(s.cwd)) sessoes.set(String(s.id), normalizarSessao(s)); // rodada 8: sem as de teste
    } catch {}
  }
  if (dados.eventos && typeof dados.eventos === 'object') {
    for (const [id, lista] of Object.entries(dados.eventos)) {
      if (sessoes.has(id) && Array.isArray(lista)) eventos.set(id, lista.slice(-MAX_EVENTOS));
    }
  }
  if (dados.resumo && dados.resumo.data === hoje()) resumo = { ...resumoVazio(), ...dados.resumo };
  if (!Array.isArray(resumo._ids)) resumo._ids = [];
  resumo._nat = { ...natVazio(), ...(resumo._nat && typeof resumo._nat === 'object' ? resumo._nat : {}) };
  if (!porHoraValido(resumo.porHora)) resumo.porHora = porHoraVazio();
  seqAlerta = Number(dados.seqAlerta) || 0;
  uso = normalizarUso(dados.uso);
  if (Array.isArray(dados.removidas)) {
    for (const par of dados.removidas) if (Array.isArray(par) && typeof par[0] === 'string') removidas.set(par[0], Number(par[1]) || 0);
  }

  config = mesclarConfig(structuredClone(CONFIG_PADRAO), lerJSON(ARQ_CONFIG, {}));
  const h = lerJSON(ARQ_HISTORICO, []);
  historico = Array.isArray(h) ? h.filter((a) => !emPastaTemporaria(a?.sessao?.cwd)).slice(-MAX_HISTORICO) : []; // rodada 8: sem as de teste
  for (const a of historico) seqAlerta = Math.max(seqAlerta, Number(a?.id) || 0);
}

// ───────────────────────── config ─────────────────────────

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const COR_HEX = /^#[0-9a-f]{6}$/i;
// '' (letra inicial), nome de um ícone da página, 'txt:' + emoji/letras curtas ou 'img:' + data URL da foto
// (a página já manda recortada e reduzida a 128 px; teto de 60 mil caracteres)
const ICONE_PROJ = /^(?:|[a-z][a-z-]{0,23}|txt:[^\u0000-\u001f<>]{1,16}|img:data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]{4,60000}={0,2})$/u;

// Aplica só os campos conhecidos e válidos; o resto é ignorado.
function mesclarConfig(base, p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return base;
  if (p.notificar && typeof p.notificar === 'object') {
    for (const t of TIPOS_ALERTA) if (typeof p.notificar[t] === 'boolean') base.notificar[t] = p.notificar[t];
  }
  if (p.som && typeof p.som === 'object') {
    if (typeof p.som.ativo === 'boolean') base.som.ativo = p.som.ativo;
    if (typeof p.som.volume === 'number' && p.som.volume >= 0 && p.som.volume <= 1) base.som.volume = p.som.volume;
  }
  if (p.naoPerturbe && typeof p.naoPerturbe === 'object') {
    const np = p.naoPerturbe;
    if (typeof np.ativo === 'boolean') base.naoPerturbe.ativo = np.ativo;
    if (typeof np.agendado === 'boolean') base.naoPerturbe.agendado = np.agendado;
    if (typeof np.inicio === 'string' && HORA.test(np.inicio)) base.naoPerturbe.inicio = np.inicio;
    if (typeof np.fim === 'string' && HORA.test(np.fim)) base.naoPerturbe.fim = np.fim;
  }
  // Celular (remoto.mjs): config.remoto. A porta nunca é a desta instância; host = nome DNS (o ts.net), minúsculo.
  if (p.remoto && typeof p.remoto === 'object' && !Array.isArray(p.remoto)) {
    const r = p.remoto;
    const b = { ...CONFIG_PADRAO.remoto, ...(base.remoto || {}) };
    b.notificar = { ...CONFIG_PADRAO.remoto.notificar, ...(base.remoto?.notificar || {}) };
    if (typeof r.ativo === 'boolean') b.ativo = r.ativo;
    if (Number.isInteger(r.porta) && r.porta >= 1024 && r.porta <= 65535 && r.porta !== PORTA) b.porta = r.porta;
    if (typeof r.host === 'string' && (r.host === '' || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/i.test(r.host.trim()))) b.host = r.host.trim().toLowerCase();
    if (typeof r.dono === 'string' && r.dono.length <= 200 && !/[\u0000-\u001f]/.test(r.dono)) b.dono = r.dono.trim();
    if (typeof r.criarInstancias === 'boolean') b.criarInstancias = r.criarInstancias;
    if (r.notificar && typeof r.notificar === 'object') {
      for (const t of ['precisa', 'terminou']) if (typeof r.notificar[t] === 'boolean') b.notificar[t] = r.notificar[t];
    }
    base.remoto = b;
  }
  // Assistente da primeira vez (assistente.mjs): o nome do usuário (vazio = o da conta do sistema) e se já foi feito.
  if (typeof p.nome === 'string') base.nome = encurtar(p.nome.replace(/[\u0000-\u001f]/g, ' '), 60);
  if (p.assistente && typeof p.assistente === 'object' && typeof p.assistente.feito === 'boolean') base.assistente = { feito: p.assistente.feito };
  // Codex (codex.mjs, 21/10): config.codex = { ativo, exe }. Fora do CONFIG_PADRAO: ausente = desligado e o campo nem aparece.
  // exe: '' (automático) ou caminho absoluto (≤500, sem controle; .exe no Windows). Inválido é descartado.
  if (p.codex && typeof p.codex === 'object' && !Array.isArray(p.codex)) {
    const c = p.codex;
    const b = { ativo: false, exe: '', ...(base.codex || {}) };
    let mudou = false;
    if (typeof c.ativo === 'boolean') { b.ativo = c.ativo; mudou = true; }
    if (typeof c.exe === 'string' && c.exe.length <= 500 && !/[\u0000-\u001f]/.test(c.exe)) {
      const e = c.exe.trim();
      if (!e || (path.isAbsolute(e) && (process.platform !== 'win32' || /\.exe$/i.test(e)))) { b.exe = e; mudou = true; }
    }
    if (mudou) base.codex = b;
  }
  // Escritórios (C2): config.escritorios = { precosCodex: { <modelo>: { entrada, cacheEntrada, saida } (US$/milhão, números ≥ 0) }, tetoInstancias: 1..20 }.
  // Fora do CONFIG_PADRAO; gravar outra parte da config preserva o que já existe. Preço inválido é descartado (os válidos entram), `precosCodex: {}` limpa.
  if (p.escritorios && typeof p.escritorios === 'object' && !Array.isArray(p.escritorios)) {
    const e = p.escritorios;
    const b = { ...(base.escritorios || {}) };
    const nn = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
    if (e.precosCodex && typeof e.precosCodex === 'object' && !Array.isArray(e.precosCodex)) {
      const t = {};
      for (const [k, v] of Object.entries(e.precosCodex)) {
        const nome = String(k).trim();
        if (!nome || nome.length > 100 || nome === '__proto__' || nome === 'constructor' || nome === 'prototype') continue;
        if (v && typeof v === 'object' && !Array.isArray(v) && nn(v.entrada) && nn(v.saida) && (v.cacheEntrada === undefined || nn(v.cacheEntrada))) {
          t[nome] = { entrada: v.entrada, cacheEntrada: v.cacheEntrada === undefined ? v.entrada : v.cacheEntrada, saida: v.saida };
        }
      }
      b.precosCodex = t;
    }
    if (Number.isInteger(e.tetoInstancias) && e.tetoInstancias >= 1 && e.tetoInstancias <= 20) b.tetoInstancias = e.tetoInstancias;
    if (Object.keys(b).length) base.escritorios = b;
  }
  if (typeof p.lembreteMin === 'number' && p.lembreteMin >= 0 && p.lembreteMin <= 1440) base.lembreteMin = p.lembreteMin;
  if (typeof p.cliqueAbreVSCode === 'boolean') base.cliqueAbreVSCode = p.cliqueAbreVSCode;
  if (p.cliqueAbre === 'orbit' || p.cliqueAbre === 'vscode') base.cliqueAbre = p.cliqueAbre;
  // Rodada 6, etapa 4: config.instancias.dormirApos (minutos, 0 = nunca).
  const di = p.instancias?.dormirApos;
  if (Number.isInteger(di) && di >= 0 && di <= 1440) base.instancias = { ...(base.instancias || {}), dormirApos: di };
  // 16/10: config.instancias.modoPadrao, o modo de permissão com que as novas instâncias do Orbit nascem.
  const mp = p.instancias?.modoPadrao;
  if (MODOS_PERMISSAO.includes(mp)) base.instancias = { ...(base.instancias || {}), modoPadrao: mp };
  // 20/10: config.instancias.autoCompactar {ativo, limite (tokens), foco}. Foco vazio volta ao padrão.
  const ac = p.instancias?.autoCompactar;
  if (ac && typeof ac === 'object' && !Array.isArray(ac)) {
    const atual = { ...AUTO_COMPACTAR_PADRAO, ...(base.instancias?.autoCompactar || {}) };
    if (typeof ac.ativo === 'boolean') atual.ativo = ac.ativo;
    if (Number.isInteger(ac.limite) && ac.limite >= LIMITE_AUTO_MIN && ac.limite <= LIMITE_AUTO_MAX) atual.limite = ac.limite;
    if (typeof ac.foco === 'string' && ac.foco.length <= 500) atual.foco = ac.foco.replace(/\s+/g, ' ').trim() || AUTO_COMPACTAR_PADRAO.foco;
    base.instancias = { ...(base.instancias || {}), autoCompactar: atual };
  }
  // Rodada 6, etapa 2: a última escolha do "Nova instância" (gravada pelo controle a cada criação).
  const ni = p.novaInstancia;
  if (ni && typeof ni === 'object' && !Array.isArray(ni) && typeof ni.pasta === 'string' && ni.pasta) {
    const txt = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
    base.novaInstancia = { pasta: ni.pasta.slice(0, 500), modelo: txt(ni.modelo, 100), esforco: txt(ni.esforco, 20), permissao: MODOS_PERMISSAO.includes(ni.permissao) ? ni.permissao : 'default' };
  }
  if (p.projetos && typeof p.projetos === 'object' && !Array.isArray(p.projetos)) {
    for (const [nome, v] of Object.entries(p.projetos)) {
      if (!nome || nome.length > 200 || nome === '__proto__' || nome === 'constructor' || nome === 'prototype') continue;
      // null tira a personalização do projeto
      if (v === null) { delete base.projetos[nome]; continue; }
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const atual = Object.hasOwn(base.projetos, nome) ? { ...base.projetos[nome] } : { icone: '', cor: '', rotulo: '' };
      if (typeof v.icone === 'string' && ICONE_PROJ.test(v.icone)) atual.icone = v.icone;
      if (typeof v.cor === 'string' && (v.cor === '' || COR_HEX.test(v.cor))) atual.cor = v.cor.toLowerCase();
      // 20/10: nome de exibição; a chave (nome da pasta) e a pasta não mudam. Igual ao nome da pasta = sem rótulo.
      if (typeof v.rotulo === 'string') { const r = encurtar(v.rotulo.replace(/[\u0000-\u001f]/g, ' '), 60); atual.rotulo = r === nome ? '' : r; }
      // 21/10: brain (pasta absoluta das notas do widget Grafo). '' fica gravado: desvincula até o padrão do Orbit.
      if (typeof v.brain === 'string' && v.brain.length <= 500 && !/[\u0000-\u001f]/.test(v.brain)) { const b = v.brain.trim(); if (!b || path.isAbsolute(b)) atual.brain = b; }
      const rotulo = typeof atual.rotulo === 'string' ? atual.rotulo : '';
      const brain = typeof atual.brain === 'string' ? atual.brain : null;
      if (!atual.icone && !atual.cor && !rotulo && brain === null) delete base.projetos[nome];
      else if (Object.hasOwn(base.projetos, nome) || Object.keys(base.projetos).length < 300) base.projetos[nome] = { icone: atual.icone, cor: atual.cor, ...(rotulo ? { rotulo } : {}), ...(brain !== null ? { brain } : {}) };
    }
  }
  return base;
}

function minutos(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function naoPerturbeAgora(t = Date.now()) {
  const np = config.naoPerturbe;
  if (np.ativo) return true;
  if (!np.agendado) return false;
  const d = new Date(t);
  const agora = d.getHours() * 60 + d.getMinutes();
  const ini = minutos(np.inicio);
  const fim = minutos(np.fim);
  if (ini === fim) return false;
  return ini < fim ? agora >= ini && agora < fim : agora >= ini || agora < fim; // janela que cruza a meia-noite
}

// ───────────────────────── difusão ─────────────────────────

// `meta` (opcional) só ajuda o filtro do celular (ex.: remover já não acha a sessão).
function difundir(tipo, dados, meta) {
  const linha = `event: ${tipo}\ndata: ${JSON.stringify(dados)}\n\n`;
  let linhaRemota; // calculada uma vez, só se houver cliente remoto
  for (const res of clientes) {
    let l = linha;
    if (res._remoto) {
      if (linhaRemota === undefined) {
        // alerta: a mesma projeção do /remoto/historico, sem cwd nem ultimaResposta (revisão de segurança P2-8, 21/10)
        linhaRemota = !eventoRemoto(tipo, dados, meta) ? null
          : tipo === 'alerta' ? `event: alerta\ndata: ${JSON.stringify(avisoRemoto(dados))}\n\n` : linha;
      }
      if (!linhaRemota) continue;
      l = linhaRemota;
    }
    try { res.write(l); } catch { clientes.delete(res); }
  }
}

// Celular: o cliente remoto do /fluxo só recebe eventos das instâncias nativas e de uso. O resto (config, remoto,
// arquivos, terminal, repos, ideias, resumo, módulos futuros...) nunca sai para ele: o padrão é negar.
function eventoRemoto(tipo, dados, meta) {
  if (tipo === 'uso') return true;
  if (tipo === 'sessao') return nativa(dados?.id);
  if (tipo === 'acao') return nativa(dados?.sessao);
  if (tipo === 'alerta') return nativa(dados?.sessao?.id);
  if (tipo === 'remover') return meta?.nativa === true;
  return false;
}

// Aviso (histórico e SSE alerta) como o celular o vê: sem cwd (só o nome do projeto) e sem ultimaResposta.
function avisoRemoto(a) {
  const s = a.sessao;
  const o = {
    id: a.id, tipo: a.tipo, quando: a.quando, notificar: a.notificar,
    sessao: {
      id: s.id, titulo: s.titulo, apelido: s.apelido, nome: s.nome, pai: s.pai,
      projeto: config.projetos[s.projeto]?.rotulo || s.projeto || (s.cwd ? path.basename(String(s.cwd)) : ''),
      status: s.status, detalhe: s.detalhe, tarefa: s.tarefa,
    },
  };
  if (a.agente) o.agente = a.agente;
  return o;
}

// Instância nativa = criada pelo Orbit (POST /instancias). Só o controle decide ('orbit' no processo vivo ou no
// instancias.json, que acompanha a troca de id do /clear). A marca s.origem da sessão NÃO vale sozinha: uma nativa
// devolvida ou reaberta fora do Orbit (VS Code/terminal) deixa de ser nativa para o celular (revisão P1-1).
// Assumidas/devolvidas e as do VS Code nunca são nativas.
function nativa(id) {
  if (typeof id !== 'string' || !id) return false;
  if (controle.origem?.(id) !== 'orbit') return false;
  const s = sessoes.get(id);
  if (s && s.origem !== 'orbit') { s.origem = 'orbit'; salvar(); } // o id novo do /clear herda a marca
  return true;
}

const difundirSessao = (s) => difundir('sessao', publico(s));
// Rodada 5: controle das instâncias (controle.mjs). Só lê o estado; as rotas são delegadas.
let mcp = null; // Conexões MCP (mcp.mjs, mais abaixo); o controle pede a proteção de cada lançamento
const controle = criarControle({
  sessao: (id) => sessoes.get(id),
  // Sem o módulo MCP, a proteção falha e a instância sobe sem nenhum servidor MCP (controle.blindarMcp).
  mcpProtecao: (cwd) => (mcp ? mcp.protecao(cwd) : Promise.reject(new Error('o módulo das Conexões MCP não carregou'))),
  sessoes: () => sessoes.values(),
  difundir: (tipo, dados) => difundir(tipo, dados),
  difundirSessao: (s) => difundirSessao(s),
  lerJSONCorpo: (req, limite) => lerJSONCorpo(req, limite), // limite: a mensagem com imagens passa dos 256 KB
  log: (...a) => log(...a),
  aplicarUso: (b, agora) => aplicarUso(b, agora), // rodada 6: uso do plano do rate_limit_event (stream)
  // Rodada 6, etapa 2: a sonda do GET /modelos usa o mesmo filtro da sonda do uso (nunca vira sessão).
  ignorarSessao: (id, ms) => {
    sondasUso.add(id);
    setTimeout(() => sondasUso.delete(id), ms).unref();
  },
  criarSessao: (o) => criarSessaoDoOrbit(o), // POST /instancias: a sessão aparece na hora no /fluxo
  // Celular (20/10): a instância do Orbit roda em modo headless, onde PermissionRequest e Notification não disparam.
  // Quando o stream pede permissão/pergunta/plano, a sessão entra em `aguardando` (1 alerta por transição; o PreToolUse
  // de AskUserQuestion/ExitPlanMode que chegar depois não repete, ver o `anterior === s.status` do aplicar). Ao responder
  // o último pedido, volta a `trabalhando` (os hooks de PostToolUse fazem o mesmo, o que chegar primeiro vale).
  aoPrecisar: (id, p) => {
    const s = sessoes.get(id);
    if (!s || s.status === 'aguardando' || s.status === 'encerrada') return;
    const t = Date.now();
    const det = p.tipo === 'pergunta' ? 'Fez uma pergunta' : p.tipo === 'plano' ? 'Plano pronto para aprovar' : `Aprovar ${encurtar(p.resumo, 120)}`;
    trocarStatus(s, 'aguardando', det, t);
    registrar(s, p.tipo === 'pergunta' ? 'pergunta' : p.tipo === 'plano' ? 'plano' : 'permissao', det, t);
    s.atividade = Math.max(s.atividade || 0, t);
    salvar();
    difundirSessao(s);
    alertar('aguardando', s, t);
    difundirResumoSeMudou();
  },
  aoLiberar: (id) => {
    const s = sessoes.get(id);
    if (!s || s.status !== 'aguardando' || s._esperaAgente) return;
    trocarStatus(s, 'trabalhando', '', Date.now());
    salvar();
    difundirSessao(s);
    difundirResumoSeMudou();
  },
  lerConfig: () => config, // etapa 4: config.instancias.dormirApos
  // Escritórios: teto próprio de instâncias (padrão 6). O controle lê config.escritorios.tetoInstancias do config mesclado a cada uso (lerConfig).
  tetoEscritorios: () => config.escritorios?.tetoInstancias,
  gravarNovaInstancia: (o) => {
    config = mesclarConfig(structuredClone(config), { novaInstancia: o });
    salvar('config');
    difundir('config', config);
  },
});
const perfil = criarPerfil({
  nome: () => config.nome || '',
  difundir: (tipo, dados) => difundir(tipo, dados),
  lerJSONCorpo: (req) => lerJSONCorpo(req),
  log: (...a) => log(...a),
});
// Conta do Claude no menu de perfil (19/10): status, sair e entrar pelo `claude auth` oficial (conta-claude.mjs).
let contaClaude = null;
try {
  const { binarioClaude: bin, envLimpo } = await import('./controle.mjs');
  contaClaude = criarContaClaude({
    comando: () => bin(),
    env: () => envLimpo(),
    controle,
    sessoes: () => sessoes.values(),
    difundir: (tipo, dados) => difundir(tipo, dados),
    log: (...a) => log(...a),
  });
} catch (e) {
  log('conta: o módulo não carregou:', e?.message || e);
}
// Rodada 7: repositórios do GitHub por projeto (repos.mjs). Import protegido: sem o arquivo, ou com
// erro nele, o servidor sobe igual e as rotas /repos/* respondem 404.
let repos = null;
try {
  const { criarRepos } = await import('./repos.mjs');
  repos = criarRepos({
    sessoes: () => sessoes.values(),
    // Os projetos da lateral (arquivos.mjs, carregado mais abaixo): a pasta entra mesmo sem sessão aberta nela.
    lateral: () => (explorador && typeof explorador.projetos === 'function' ? explorador.projetos() : []),
    difundir: (tipo, dados) => difundir(tipo, dados),
    lerJSONCorpo: (req) => lerJSONCorpo(req),
    log: (...a) => log(...a),
    dados: DADOS,
    pastaOrbit: PASTA,
    github: { token: () => perfil.token(), conta: () => perfil.conta(), verificar: () => perfil.verificar(), publico: () => perfil.publico() },
  });
} catch (e) {
  log('repos: o módulo não carregou:', e?.message || e);
}
// Assistente da primeira vez (assistente.mjs): nome, pasta de projetos, hooks com permissão, skill e celular.
let assistente = null;
try {
  const { criarAssistente } = await import('./assistente.mjs');
  assistente = criarAssistente({
    pasta: PASTA,
    dados: DADOS,
    repos,
    config: () => config,
    gravarConfig: async (p) => {
      config = mesclarConfig(structuredClone(config), p);
      salvar('config');
      difundir('config', config);
      if (p.nome !== undefined) difundir('perfil', perfil.publico());
      if (p.remoto) await aplicarRemoto();
    },
    log: (...a) => log(...a),
  });
} catch (e) {
  log('assistente: o módulo não carregou:', e?.message || e);
}
// Ideias (bloco de notas da lateral, ideias.mjs): uma nota Markdown na pasta de dados (GERENCIADOR_IDEIAS
// troca o arquivo). Import protegido como o repos.
let ideias = null;
try {
  const { criarIdeias } = await import('./ideias.mjs');
  const arquivo = process.env.GERENCIADOR_IDEIAS
    || path.join(DADOS, 'notas', 'Ideias.md');
  ideias = criarIdeias({ arquivo, difundir: (tipo, dados) => difundir(tipo, dados), lerJSONCorpo: (req) => lerJSONCorpo(req), log: (...a) => log(...a) });
} catch (e) {
  log('ideias: o módulo não carregou:', e?.message || e);
}
// Whiteboard (whiteboard.mjs): quadros globais em <DADOS>/whiteboard/<id>.json. Import protegido como o ideias.
let whiteboard = null;
try {
  const { criarWhiteboard } = await import('./whiteboard.mjs');
  whiteboard = criarWhiteboard({ pasta: path.join(DADOS, 'whiteboard'), lerJSONCorpo: (req, limite) => lerJSONCorpo(req, limite), log: (...a) => log(...a) });
} catch (e) {
  log('whiteboard: o módulo não carregou:', e?.message || e);
}
// Escritórios (escritorios.mjs): times de instâncias em <DADOS>/escritorios. Só no PC (o celular não ganha estas rotas).
// O alerta de orçamento não passa mais pelo `alertar` (sem sessão de mentira no histórico): o aviso/pausa vai no evento
// SSE `escritorio` (`alerta:{tipo,texto}`, o painel mostra) e a pausa chega ao celular como push "precisa de você",
// pelo mesmo `remoto.notificar` das sessões (só id/projeto, sem texto), respeitando o Não perturbe.
let escritorios = null;
try {
  const { criarEscritorios } = await import('./escritorios.mjs');
  const notificarCelularEscritorio = (id, nome) => {
    if (!remoto || naoPerturbeAgora()) return;
    try { remoto.notificar({ id: `escritorio:${id}`, projeto: nome || id }, 'precisa'); } catch (e) { log('remoto: push escritório', e?.message || e); }
  };
  // Mesma validação do POST /instancias (controle.mjs), sobre o modelos.json que o controle mantém. Sem lista
  // salva ainda, aceita: o criarInstancia valida de novo ao subir a instância.
  const validarModeloEscritorio = (valor, esforco) => {
    const l = lerJSON(path.join(DADOS, 'modelos.json'), null)?.modelos;
    if (!Array.isArray(l) || !l.length) return true;
    const acha = (v) => l.find((m) => m.valor === v) || l.find((m) => m.modelo === v && m.valor !== 'default') || l.find((m) => m.modelo === v) || null;
    const m = valor ? acha(valor) : null;
    if (valor && !m) return `Modelo desconhecido: ${encurtar(valor, 100)}.`;
    const alvo = m || acha('default');
    if (esforco && alvo) {
      const niveis = Array.isArray(alvo.esforcos) ? alvo.esforcos : [];
      if (!niveis.length) return `${alvo.nome} não tem nível de esforço.`;
      if (!niveis.includes(esforco)) return `${alvo.nome} não aceita o esforço "${encurtar(esforco, 20)}". Use: ${niveis.join(', ')}.`;
    }
    return true;
  };
  // Membros do Codex (B1b). Tudo protegido: `codex` é um `let` mais abaixo no arquivo (TDZ até lá) e só existe com a chave
  // config.codex.ativo ligada; sem ele os escritórios seguem só com Claude.
  const codexAgora = () => { try { return (codex && config.codex?.ativo ? codex : null); } catch { return null; } };
  const pontesCodex = () => codexAgora()?.ponte || null;
  // Mesma regra do codex-uso.mjs validar(), sobre GET /codex/modelos (a lista do model/list), sem HTTP.
  const validarModeloCodex = async (modelo, esforco) => {
    const c = codexAgora();
    if (!c) throw new Error('O Codex não está ligado no Orbit.');
    let status = 0, corpo = '';
    const resFalso = { headersSent: false, writeHead(codigo) { status = codigo; }, end(t) { corpo = String(t ?? ''); this.headersSent = true; } };
    const tratou = await c.rota({ method: 'GET', headers: {}, url: '/codex/modelos' }, resFalso, '/codex/modelos', new URL('http://127.0.0.1/codex/modelos'));
    let dados = null;
    try { dados = JSON.parse(corpo); } catch { /* corpo ilegível */ }
    if (!tratou || status !== 200 || !Array.isArray(dados?.modelos)) throw new Error(dados?.erro || 'Não consegui ler os modelos do Codex.');
    const lista = dados.modelos;
    const m0 = String(modelo || '').trim();
    const e0 = String(esforco || '').trim();
    let m = null;
    if (m0) {
      m = lista.find((x) => x.valor === m0 || x.modelo === m0);
      if (!m) throw new Error(`Modelo desconhecido: ${encurtar(m0, 100)}. Use: ${lista.map((x) => x.valor).join(', ')}.`);
    }
    if (e0) {
      const base = m || lista.find((x) => x.padrao) || null;
      const aceitos = base ? (base.esforcos || []) : [...new Set(lista.flatMap((x) => x.esforcos || []))];
      if (!aceitos.length) throw new Error(`${base ? base.nome : 'O modelo'} não tem nível de esforço.`);
      if (!aceitos.includes(e0)) throw new Error(`${base ? base.nome : 'O Codex'} não aceita o esforço "${encurtar(e0, 20)}". Use: ${aceitos.join(', ')}.`);
    }
    return { modelo: m ? m.valor : '', esforco: e0 };
  };
  // A reidratação espera o módulo do Codex subir (aplicarCodex roda depois) para listar os threads dele. Chave desligada: não espera.
  const esperarCodex = async () => {
    for (let i = 0; i < 400; i++) {
      try { if (!config.codex?.ativo || pontesCodex()) return; } catch { /* TDZ: o módulo ainda está subindo */ }
      await new Promise((ok) => setTimeout(ok, 100));
    }
  };
  escritorios = criarEscritorios({
    codex: pontesCodex,
    codexAtivo: () => { try { return !!config.codex?.ativo; } catch { return false; } },
    validarModeloCodex,
    precosCodex: () => config.escritorios?.precosCodex, // mesclarConfig guarda config.escritorios (validado)
    esperarCodex,
    tetoEscritorios: () => config.escritorios?.tetoInstancias,
    pasta: path.join(DADOS, 'escritorios'),
    raizOrbit: PASTA,
    porta: PORTA,
    lerJSONCorpo: (req, limite) => lerJSONCorpo(req, limite),
    log: (...a) => log(...a),
    publicar: (tipo, dados) => difundir(tipo, dados),
    notificarCelular: notificarCelularEscritorio,
    sessao: (id) => sessoes.get(id),
    usoPlano: () => uso,
    validarModelo: validarModeloEscritorio,
    controle,
  });
} catch (e) {
  log('escritorios: o módulo não carregou:', e?.message || e);
}
// Grafo (grafo.mjs): GET /grafo/dados?pasta= (notas .md e [[links]]). Sem brain de fábrica: cada projeto vincula a própria
// pasta de notas (config.projetos[p].brain); ORBIT_COFRE define uma pasta padrão, se quiser.
let grafo = null;
let montarGrafoBrain = null;
try {
  const { criarGrafo, montarGrafo } = await import('./grafo.mjs');
  montarGrafoBrain = montarGrafo;
  grafo = criarGrafo({ cofre: process.env.ORBIT_COFRE ? path.resolve(process.env.ORBIT_COFRE) : '', projetoPadrao: process.env.ORBIT_COFRE ? path.basename(PASTA) : '' }); // GET /grafo/padrao: sem brain de fábrica
} catch (e) {
  log('grafo: o módulo não carregou:', e?.message || e);
}
// Espaço em disco (card da Home, disco.mjs): mede o C: e a pasta temporária do Claude a cada 10 min, num
// histórico de tamanho fixo (disco.json). Import protegido como o repos; sem ele, GET /disco responde 404.
let disco = null;
try {
  const { criarDisco } = await import('./disco.mjs');
  const ms = Number(process.env.GERENCIADOR_DISCO_MS) || undefined;
  disco = criarDisco({
    arquivo: path.join(DADOS, 'disco.json'),
    ...(process.env.GERENCIADOR_DISCO_PASTA ? { pastaClaude: process.env.GERENCIADOR_DISCO_PASTA } : {}),
    ...(ms ? { intervaloMs: Math.max(5e3, ms) } : {}),
    difundir: (tipo, dados) => difundir(tipo, dados),
    log: (...a) => log(...a),
  });
  disco.iniciar();
} catch (e) {
  log('disco: o módulo não carregou:', e?.message || e);
}
// Regras de permissão dos projetos (Configurações, regras.mjs): só os .claude/ das pastas das sessões, nunca o
// global. Import protegido como o repos; sem ele, /regras responde 404.
let regras = null;
try {
  const { criarRegras } = await import('./regras.mjs');
  regras = criarRegras({
    sessoes: () => sessoes.values(),
    pastaOrbit: PASTA,
    difundir: (tipo, dados) => difundir(tipo, dados),
    lerJSONCorpo: (req) => lerJSONCorpo(req),
    log: (...a) => log(...a),
    ...(process.env.GERENCIADOR_CASA ? { casa: process.env.GERENCIADOR_CASA } : {}),
  });
} catch (e) {
  log('regras: o módulo não carregou:', e?.message || e);
}
// Skills (aba Skills, skills.mjs): as do projeto (padrão) e as pessoais (só com confirmação na página), o
// ativo/inativo no .claude/settings.json do projeto e as usadas por sessão. Import protegido como o repos.
let skills = null;
try {
  const { criarSkills } = await import('./skills.mjs');
  skills = criarSkills({
    sessoes: () => sessoes.values(),
    sessao: (id) => sessoes.get(id),
    pastaOrbit: PASTA,
    dados: DADOS,
    difundir: (tipo, dados) => difundir(tipo, dados),
    lerJSONCorpo: (req, limite) => lerJSONCorpo(req, limite),
    log: (...a) => log(...a),
    sondar: (pasta) => controle.sondarSkills(pasta),
    lixeira: (abs) => (explorador ? explorador.lixeira(abs) : Promise.reject(new Error('a Lixeira não carregou'))),
    permitidas: (id) => controle.estado({ id })?.skills ?? null,
    ...(process.env.GERENCIADOR_CASA ? { casa: process.env.GERENCIADOR_CASA } : {}),
  });
} catch (e) {
  log('skills: o módulo não carregou:', e?.message || e);
}
// Conexões MCP (Configurações, mcp.mjs): servidores do .mcp.json do projeto (padrão) e os pessoais do ~/.claude.json
// (só com confirmação na página), a aprovação dos novos ou alterados e as chaves num cofre cifrado fora do projeto
// (DPAPI no Windows, Chaveiro no Mac). Servidor de teste: o cofre e as aprovações ficam na pasta de dados. Import
// protegido como o repos; sem ele, /mcp responde 404 e as instâncias sobem sem MCP.
try {
  const { criarMcp } = await import('./mcp.mjs');
  const { pastaLocal } = plataforma;
  const cofreMcp = criarCofreTexto({
    arquivo: process.env.ORBIT_MCP_COFRE || (DADOS === PASTA ? path.join(pastaLocal(), 'mcp-chaves.dat') : path.join(DADOS, 'mcp-chaves.dat')),
    entropia: 'Orbit.mcp.v1',
    servico: 'Orbit MCP',
  });
  mcp = criarMcp({
    sessoes: () => sessoes.values(),
    pastaOrbit: PASTA,
    dados: DADOS,
    difundir: (tipo, dados) => difundir(tipo, dados),
    lerJSONCorpo: (req, limite) => lerJSONCorpo(req, limite),
    log: (...a) => log(...a),
    sondar: (pasta, prot) => controle.sondarMcp(pasta, prot),
    cofre: cofreMcp,
    ...(process.env.GERENCIADOR_CASA ? { casa: process.env.GERENCIADOR_CASA } : {}),
  });
} catch (e) {
  log('mcp: o módulo não carregou:', e?.message || e);
}
// Reinício pelas Configurações (reinicio.mjs): desliga identificado como "usuário" e um ajudante destacado
// sobe o servidor de novo; as instâncias do motor seguem vivas. Cada reinício vira uma linha no cofre
// (servidor de teste: na pasta de dados). Import protegido como o repos; sem ele, /reiniciar responde 404.
let reinicio = null;
try {
  const { criarReinicio } = await import('./reinicio.mjs');
  reinicio = criarReinicio({
    dados: DADOS,
    pasta: PASTA,
    cofre: process.env.GERENCIADOR_REINICIOS
      || path.join(DADOS, 'notas', 'Reinícios do servidor.md'),
    lerJSONCorpo: (req) => lerJSONCorpo(req),
    log: (...a) => log(...a),
    bloqueios: () => controle.bloqueiosReinicio(),
    desligar: (motivo) => desligar(motivo),
  });
} catch (e) {
  log('reinício: o módulo não carregou:', e?.message || e);
}
// Temas do VS Code na prévia de arquivos (temas.mjs): cores do texto pelo Shiki e ícones do tema de
// ícones ativo, lidos direto das extensões instaladas. Import protegido: sem ele (ou sem o Shiki), visual do Orbit.
let temas = null;
try {
  const { criarTemas } = await import('./temas.mjs');
  temas = criarTemas({ difundir: (tipo, dados) => difundir(tipo, dados), log: (...a) => log(...a) });
} catch (e) {
  log('temas: o módulo não carregou:', e?.message || e);
}
// Música tocando (midia.mjs, widget no pé da lateral): lê os controles de mídia do sistema (Windows) ou o app do
// Spotify (Mac) e manda play/pause, próxima e anterior. Só roda com alguma página aberta. Import protegido: sem ele, 404.
let midia = null;
try {
  const { criarMidia } = await import('./midia.mjs');
  midia = criarMidia({
    difundir: (tipo, dados) => difundir(tipo, dados),
    lerJSONCorpo: (req) => lerJSONCorpo(req),
    log: (...a) => log(...a),
    dados: DADOS,
    ouvintes: () => clientes.size,
  });
} catch (e) {
  log('midia: o módulo não carregou:', e?.message || e);
}
// Terminal integrado (terminal.mjs, 16/10): PTYs vivos no servidor, falados por um WebSocket só da página do Orbit
// (Host, Origin e bilhete de uso único conferidos no upgrade). Import protegido: sem ele (ou sem o node-pty), 404.
let terminal = null;
try {
  const { criarTerminal } = await import('./terminal.mjs');
  terminal = criarTerminal({
    porta: PORTA,
    projetos: () => { // a mesma lista da lateral (projetos.json do arquivos.mjs), lida na hora de abrir
      try { const j = JSON.parse(fs.readFileSync(path.join(DADOS, 'projetos.json'), 'utf8')); return Array.isArray(j.lista) ? j.lista : []; } catch { return []; }
    },
    lerJSONCorpo: (req) => lerJSONCorpo(req),
    log: (...a) => log(...a),
  });
} catch (e) {
  log('terminal: o módulo não carregou:', e?.message || e);
}
// Rodada 8: projetos e arquivos na lateral (arquivos.mjs): lista de projetos, árvore, operações confinadas às
// pastas dos projetos, Lixeira do Windows, vigia e busca. Import protegido como o repos; sem ele, 404.
let explorador = null;
try {
  const { criarArquivos } = await import('./arquivos.mjs');
  explorador = criarArquivos({
    dados: DADOS,
    sessoes: () => sessoes.values(),
    difundir: (tipo, dados) => difundir(tipo, dados),
    lerJSONCorpo: (req) => lerJSONCorpo(req),
    log: (...a) => log(...a),
    teste: DADOS !== PASTA,
    realce: temas,
  });
} catch (e) {
  log('arquivos: o módulo não carregou:', e?.message || e);
}
// Navegador interno (navegador.mjs, 16/10): confere se a página aceita ser embutida, abre no navegador padrão,
// guarda a prévia de cada projeto e sugere as portas locais em uso. Import protegido; sem ele, 404 e a aba abre direto.
let navegador = null;
try {
  const { criarNavegador } = await import('./navegador.mjs');
  navegador = criarNavegador({
    dados: DADOS,
    porta: PORTA,
    difundir: (tipo, dados) => difundir(tipo, dados),
    lerJSONCorpo: (req) => lerJSONCorpo(req),
    log: (...a) => log(...a),
    teste: DADOS !== PASTA,
    // O Orbit nunca abre dentro de si mesmo (auditoria P2-4): a porta remota do celular e o host do Tailscale.
    enderecosOrbit: () => { const r = (config && config.remoto) || {}; return { portas: [r.porta || 47820], hosts: [r.host || ''] }; },
  });
} catch (e) {
  log('navegador: o módulo não carregou:', e?.message || e);
}
// Orbit no celular (remoto.mjs, 20/10): aparelhos pareados, porta remota (abaixo, "acesso remoto") e push. Import
// protegido: sem ele, a porta remota nunca abre e /remoto/* responde 404. Servidor de teste nunca chama o Tailscale
// de verdade: ORBIT_TAILSCALE_FALSO aponta um JSON { status, serve } (comandos anotados em <arquivo>.log).
let remoto = null;
try {
  const { criarRemoto } = await import('./remoto.mjs');
  const { pastaLocal } = plataforma;
  // P2-7: o knob de teste só vale com DADOS fora da pasta do Orbit (nunca no servidor de verdade).
  const falso = path.resolve(DADOS) !== path.resolve(PASTA) ? process.env.ORBIT_TAILSCALE_FALSO : undefined;
  const executarTailscale = falso
    ? async (exe, args) => {
      try { fs.appendFileSync(falso + '.log', JSON.stringify(args) + '\n'); } catch {}
      let f = {};
      try { f = JSON.parse(fs.readFileSync(falso, 'utf8')); } catch {}
      if (f.ausente) return { codigo: null, saida: '', erro: '', ausente: true }; // Tailscale não instalado
      const saida = args[0] === 'status' ? f.status : args[0] === 'serve' && args[1] === 'status' ? f.serve : {};
      if (args[0] === 'serve' && args[1] !== 'status') {
        // ligar/desligar: `erroServe` no JSON simula o 1º serve (pede ativação no painel); senão o estado do serve muda.
        if (f.erroServe) return { codigo: 1, saida: '', erro: String(f.erroServe), ausente: false };
        const proxy = args.find((a) => /^http:\/\/127\.0\.0\.1:\d+$/.test(a));
        f.serve = proxy ? { TCP: { 443: { HTTPS: true } }, Web: { [`${f.status?.Self?.DNSName || 'pc.ts.net.'}:443`.replace('.:', ':')]: { Handlers: { '/': { Proxy: proxy } } } } } : {};
        try { fs.writeFileSync(falso, JSON.stringify(f)); } catch {}
      }
      return { codigo: 0, saida: JSON.stringify(saida ?? {}), erro: '', ausente: false };
    }
    : DADOS !== PASTA ? async () => ({ codigo: null, saida: '', erro: '', ausente: true }) : undefined;
  remoto = criarRemoto({
    dados: DADOS,
    pasta: PASTA,
    config: () => config.remoto,
    mudarConfig: (patch) => {
      config = mesclarConfig(structuredClone(config), { remoto: patch });
      salvar('config');
      difundir('config', config);
      return aplicarRemoto();
    },
    difundirLocal: (tipo, dados) => difundir(tipo, dados),
    nativa: (id) => nativa(id),
    pastaDaSessao: (id) => sessoes.get(id)?.cwd || '', // as skills da barra valem só no projeto da sessão
    projetos: () => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DADOS, 'projetos.json'), 'utf8'));
        return (Array.isArray(j.lista) ? j.lista : [])
          .filter((p) => p && typeof p.pasta === 'string' && typeof p.nome === 'string')
          .map((p) => ({ pasta: p.pasta, nome: config.projetos[p.nome]?.rotulo || p.nome }));
      } catch { return []; }
    },
    lerCorpo: (req, limite) => lerCorpo(req, limite),
    lerJSONCorpo: (req) => lerJSONCorpo(req),
    cofre: criarCofreTexto({
      arquivo: process.env.ORBIT_REMOTO_COFRE || (DADOS === PASTA ? path.join(pastaLocal(), 'remoto-vapid.dat') : path.join(DADOS, 'remoto-vapid.dat')),
      entropia: 'Orbit.remoto.v1',
      servico: 'Orbit Remoto',
    }),
    executarTailscale,
    permitirHttp: DADOS !== PASTA && process.env.ORBIT_PUSH_HTTP_TESTE === '1', // push para um servidor falso local: só em servidor de teste
    naoPerturbe: () => config.naoPerturbe,
    mudarNaoPerturbe: (patch) => {
      config = mesclarConfig(structuredClone(config), { naoPerturbe: patch });
      salvar('config');
      difundir('config', config);
    },
    // Brain do projeto cadastrado (mesma regra do brainDe do PC): config.projetos[nome].brain; sem ele, o cofre padrão
    // só vale para o projeto do próprio Orbit; os demais ficam sem brain ('').
    brainDoProjeto: (pasta) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DADOS, 'projetos.json'), 'utf8'));
        const norm = (p) => { const x = path.resolve(String(p)).replace(/[\\/]+$/, ''); return process.platform === 'linux' ? x : x.toLowerCase(); };
        const alvo = norm(pasta);
        const p = (Array.isArray(j.lista) ? j.lista : []).find((q) => q && typeof q.pasta === 'string' && typeof q.nome === 'string' && norm(q.pasta) === alvo);
        if (!p) return '';
        const b = config.projetos[p.nome]?.brain;
        if (typeof b === 'string') return b.trim();
        return p.nome === path.basename(PASTA) && process.env.ORBIT_COFRE ? path.resolve(process.env.ORBIT_COFRE) : ''; // sem brain de fábrica: só ORBIT_COFRE (opcional) para o projeto do próprio Orbit
      } catch { return ''; }
    },
    montarGrafo: (raiz) => montarGrafoBrain(raiz),
    log: (...a) => log(...a),
  });
} catch (e) {
  log('remoto: o módulo não carregou:', e?.message || e);
}
function sessaoVista(s) {
  if (explorador && s && s.cwd) try { explorador.sessaoVista(s); } catch (e) { log('arquivos: sessaoVista', e?.message || e); }
}

// Rodada 8: com os dados da produção, sessão com cwd numa pasta temporária (teste com o claude real e os
// hooks globais) não vira sessão nem projeto na lista real. Servidor de teste (GERENCIADOR_DADOS) aceita.
const RAIZES_TEMP = [...new Set([os.tmpdir(), process.env.TEMP, process.env.TMP].filter(Boolean).map((p) => {
  let r = path.resolve(p);
  try { r = fs.realpathSync.native(r); } catch {}
  return r.replace(/[\\/]+$/, '').toLowerCase();
}))];
// Mac (16/10): a pasta temporária (/var/folders/…/T) é um symlink para /private/var/…, e o cwd chega de um jeito
// ou do outro; /tmp (→ /private/tmp) é a outra pasta temporária usual. Entram as duas formas.
if (!plataforma.WIN) {
  for (const p of [os.tmpdir(), '/tmp', '/private/tmp']) {
    const r = path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
    if (!RAIZES_TEMP.includes(r)) RAIZES_TEMP.push(r);
    try { const real = fs.realpathSync(p).replace(/[\\/]+$/, '').toLowerCase(); if (!RAIZES_TEMP.includes(real)) RAIZES_TEMP.push(real); } catch {}
  }
}
const ignoradasTemp = new Set(); // sessões descartadas por estarem numa pasta temporária
function emPastaTemporaria(cwd) {
  if (DADOS !== PASTA || typeof cwd !== 'string' || !cwd) return false;
  const c = path.resolve(cwd).replace(/[\\/]+$/, '').toLowerCase();
  return RAIZES_TEMP.some((r) => c === r || c.startsWith(r + path.sep));
}

let resumoDifundido = '';
function difundirResumoSeMudou() {
  const r = publicoResumo();
  const j = JSON.stringify(r);
  if (j !== resumoDifundido) {
    resumoDifundido = j;
    difundir('resumo', r);
  }
}

function virarDia(t = Date.now()) {
  if (resumo.data !== hoje(t)) {
    resumo = resumoVazio();
    salvar();
  }
}

function contarSessaoHoje(id) {
  if (!resumo._ids.includes(id)) {
    resumo._ids.push(id);
    resumo.sessoes = resumo._ids.length;
  }
}

// `agente`: o subagente que causou o alerta (dependente interno). Sessão com `pai` é
// dependente externa. Dependente só notifica quando precisa do usuário (aguardando/lembrete).
function alertar(tipo, s, quando = Date.now(), agente = null) {
  let notificar = config.notificar[tipo] !== false && !s.silenciada && !naoPerturbeAgora();
  if ((agente || s.pai) && tipo !== 'aguardando' && tipo !== 'lembrete') notificar = false;
  const a = { id: ++seqAlerta, tipo, quando, sessao: retrato(s), notificar };
  if (agente) a.agente = { id: agente.id, tipo: agente.tipo, descricao: agente.descricao };
  historico.push(a);
  if (historico.length > MAX_HISTORICO) historico.splice(0, historico.length - MAX_HISTORICO);
  salvar('historico');
  difundir('alerta', a);
  // Celular: push só das nativas (precisa de você; terminou só da volta principal). Respeita o Não perturbe.
  const tipoPush = tipo === 'aguardando' ? 'precisa' : tipo === 'concluida' && !agente && !s.pai ? 'terminou' : '';
  if (remoto && tipoPush && !s.silenciada && !naoPerturbeAgora(quando) && nativa(s.id)) {
    try { remoto.notificar({ id: s.id, projeto: config.projetos[s.projeto]?.rotulo || s.projeto || path.basename(String(s.cwd || '')) }, tipoPush); } catch (e) { log('remoto: push', e?.message || e); }
  }
  return a;
}

// Medição dos pedidos de permissão (15/10, orientações "sem cd" e "sem texto solto como separador"): comando
// de terminal e pedido de permissão vão também para logs/pedidos.jsonl (fora do git: /logs/ no .gitignore),
// que sobrevive ao reinício. Fica só o necessário: 7 dias e até 5 MB. A poda roda ao subir e a cada hora
// (reescreve com tmp + rename); falha de escrita é ignorada.
const LOG_PEDIDOS = path.join(DADOS, 'logs', 'pedidos.jsonl');
const PEDIDOS_DIAS = 7;
const PEDIDOS_MAX = 5 * 1024 * 1024;
let filaPedidos = Promise.resolve();
let podaPedidos = 0;
function emFilaPedidos(fn) {
  filaPedidos = filaPedidos.then(fn).catch(() => {});
  return filaPedidos;
}
async function podarPedidos(agora = Date.now()) {
  podaPedidos = agora;
  let bruto;
  try { bruto = await fsp.readFile(LOG_PEDIDOS, 'utf8'); } catch { return; }
  const corte = agora - PEDIDOS_DIAS * 864e5;
  let linhas = bruto.split('\n').filter((l) => {
    try { return JSON.parse(l).ts >= corte; } catch { return false; }
  });
  // Acima do teto, ficam as mais novas (até 80% do teto, para não podar a cada linha).
  let tam = linhas.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  while (tam > PEDIDOS_MAX * 0.8 && linhas.length) tam -= Buffer.byteLength(linhas.shift()) + 1;
  const novo = linhas.length ? linhas.join('\n') + '\n' : '';
  if (novo === bruto) return;
  const tmp = LOG_PEDIDOS + '.tmp';
  await fsp.writeFile(tmp, novo, 'utf8');
  await fsp.rename(tmp, LOG_PEDIDOS);
}
function medirPedido(s, tipo, texto, ts) {
  if (tipo !== 'permissao' && !(tipo === 'ferramenta' && /^(Bash|PowerShell): /.test(texto))) return;
  let orbit = false;
  try { orbit = controle.estado(s)?.modo === 'orbit'; } catch {}
  const linha = JSON.stringify({ ts, id: s.id, cwd: s.cwd || '', orbit, tipo, texto: encurtar(texto, 300) }) + '\n';
  emFilaPedidos(async () => {
    await fsp.mkdir(path.dirname(LOG_PEDIDOS), { recursive: true });
    await fsp.appendFile(LOG_PEDIDOS, linha);
    const n = (await fsp.stat(LOG_PEDIDOS)).size;
    if (n > PEDIDOS_MAX || Date.now() - podaPedidos > 36e5) await podarPedidos();
  });
}
emFilaPedidos(() => podarPedidos()); // ao subir

function registrar(s, tipo, texto, ts) {
  medirPedido(s, tipo, texto, ts);
  let lista = eventos.get(s.id);
  if (!lista) eventos.set(s.id, (lista = []));
  const e = { ts, tipo, texto: encurtar(texto, 200) };
  // Fora de ordem: insere no lugar certo (quase sempre no fim).
  let i = lista.length;
  while (i > 0 && lista[i - 1].ts > ts) i--;
  lista.splice(i, 0, e);
  if (lista.length > MAX_EVENTOS) lista.splice(0, lista.length - MAX_EVENTOS);
}

// ───────────────────────── modelo ─────────────────────────

function novaSessao(id, t) {
  return normalizarSessao({ id, status: 'nova', desde: t, inicio: t, atividade: t });
}

// Rodada 6, etapa 2: instância criada pelo Orbit (controle.mjs). Até o 1º hook, o registro espelha
// busy/idle (_hook false), como numa sessão sem hooks.
function criarSessaoDoOrbit({ id, cwd, apelido, transcript }) {
  const t = Date.now();
  const s = novaSessao(id, t);
  s._hook = false;
  s._tsStatus = 0;
  s.origem = 'orbit';
  s.cwd = String(cwd).slice(0, 500);
  s.projeto = path.basename(s.cwd.replace(/[\\/]+$/, ''));
  if (apelido) s.apelido = encurtar(apelido, 60);
  if (transcript) s._transcript = transcript;
  sessoes.set(id, s);
  sessaoVista(s); // rodada 8
  registrar(s, 'inicio', 'Criada no Orbit', t);
  salvar();
  difundirSessao(s);
  return s;
}

// Troca de status com a contabilidade de tempo. `t` é a hora da transição;
// `fimTrecho` (opcional) limita o tempo contado no status que sai — usado quando
// a transição é descoberta tarde (processo morto, interrupção lida do transcript).
function trocarStatus(s, status, detalhe, t, fimTrecho = t) {
  const fim = Math.max(s.desde, Math.min(t, fimTrecho));
  const dur = fim - s.desde;
  if (dur > 0 && (s.status === 'trabalhando' || s.status === 'aguardando')) {
    const chave = s.status === 'trabalhando' ? 'msTrabalhando' : 'msAguardando';
    s.contadores[chave] += dur;
    virarDia(t);
    const iniDia = Math.max(s.desde, meiaNoite(t));
    if (fim > iniDia) {
      resumo[chave] += fim - iniDia;
      if (nativa(s.id)) resumo._nat[chave] += fim - iniDia;
      somarHoras(resumo.porHora[chave === 'msTrabalhando' ? 'trabalhandoMs' : 'aguardandoMs'], iniDia, fim);
    }
  }
  if (status === 'aguardando' && s.status !== 'aguardando') {
    s.contadores.esperas++;
    virarDia(t);
    resumo.esperas++;
    if (nativa(s.id)) resumo._nat.esperas++;
    resumo.porHora.esperas[horaDe(t)]++;
  }
  if (status !== s.status) s._lembrete = false;
  if (status !== 'aguardando') {
    s._esperaAgente = '';
    s._statusAntes = '';
    s._detalheAntes = '';
  }
  s.status = status;
  s.detalhe = detalhe || '';
  s.desde = t;
  s._tsStatus = Math.max(s._tsStatus, t);
  if (s.revisadaEm && t > s.revisadaEm) delete s.revisadaEm; // terminou (ou mudou) de novo depois da revisão: volta para Concluídas
}

function atualizarFerramenta(s) {
  const f = s._emCurso[s._emCurso.length - 1];
  s.ferramenta = f ? { nome: f.nome, alvo: f.alvo, desde: f.desde } : null;
}

function limparEmCurso(s) {
  s._emCurso = [];
  s.ferramenta = null;
}

// Traduz o evento do hook. Devolve o tipo do alerta emitido, se houver.
function aplicar(ev) {
  const id = encurtar(ev.session_id, 100);
  if (!id) throw new Error('session_id ausente');
  const nome = String(ev.hook_event_name || '');
  const agora = Date.now();
  let t = Number(ev.ts);
  if (!Number.isFinite(t) || t <= 0 || t > agora + 60e3) t = agora; // ts ausente ou absurdo

  removidas.delete(id); // atividade nova traz de volta uma sessão tirada da lista
  let s = sessoes.get(id);
  if (!s) {
    s = novaSessao(id, t);
    sessoes.set(id, s);
  }
  s._hook = true;
  if (typeof ev.cwd === 'string' && ev.cwd) {
    const novo = s.cwd !== ev.cwd.slice(0, 500);
    s.cwd = ev.cwd.slice(0, 500);
    s.projeto = path.basename(s.cwd.replace(/[\\/]+$/, ''));
    if (novo) sessaoVista(s); // rodada 8: descoberta de projeto (arquivos.mjs)
  }
  if (typeof ev.titulo === 'string' && ev.titulo) s.titulo = encurtar(ev.titulo, 80);
  if (typeof ev.transcript_path === 'string' && ev.transcript_path && ev.transcript_path !== s._transcript) {
    s._transcript = ev.transcript_path;
    s._mtime = 0;
  }
  // Sessão dependente: criada por outra sessão (CLAUDE_CODE_HOST_SESSION_ID no ambiente do hook).
  if (typeof ev.host_session_id === 'string' && ev.host_session_id && ev.host_session_id !== id && sessoes.get(ev.host_session_id)?.provedor !== 'codex') s.pai = encurtar(ev.host_session_id, 100);
  const pid = Number(ev.pid);
  if (Number.isInteger(pid) && pid > 0) {
    s.pid = pid;
    s.vivo = true; // acabou de mandar um evento
  }
  s.atividade = Math.max(s.atividade || 0, t);
  s._sujo = true; // relê o transcript logo (contexto e título acompanham o evento)
  tiqueLogo();
  virarDia(t);
  contarSessaoHoje(id);

  // Eventos assíncronos chegam fora de ordem: só o mais novo muda o status.
  const atrasado = t < s._tsStatus;
  const anterior = s.status;
  let alerta = null;
  let forcar = false; // alerta mesmo sem troca de status (outro subagente pedindo)
  let agenteDoAlerta = null;
  const parado = s.status === 'interrompida';
  const mudar = (status, detalhe = '') => {
    if (atrasado) return false;
    if (parado && status === 'trabalhando' && nome !== 'UserPromptSubmit') return false;
    trocarStatus(s, status, detalhe, t);
    return true;
  };

  const agenteId = typeof ev.agent_id === 'string' && ev.agent_id ? ev.agent_id.slice(0, 100) : '';
  if (agenteId && nome !== 'SessionStart' && nome !== 'SessionEnd' && nome !== 'UserPromptSubmit') {
    // Evento de subagente interno: mexe no agente; a sessão só muda quando ele prende o usuário.
    const a = garantirAgente(s, agenteId, encurtar(ev.agent_type, 40), t);
    const r = eventoDeAgente(s, a, ev, nome, t, mudar);
    if (r) {
      alerta = r.alerta;
      forcar = r.forcar;
      agenteDoAlerta = a;
    }
  } else {
    switch (nome) {
      case 'SessionStart':
        if (s.status === 'encerrada' || s.status === 'nova') mudar('nova', ev.source === 'resume' ? 'retomada' : '');
        registrar(s, 'inicio', ev.source === 'resume' ? 'Sessão retomada' : ev.source === 'clear' ? 'Sessão nova (/clear)' : ev.source === 'compact' ? 'Contexto compactado' : 'Sessão iniciada', t);
        break;

      case 'UserPromptSubmit': {
        const p = encurtar(ev.prompt, 140);
        // Mensagem automática não vira tarefa nem título.
        const automatico = PROMPT_AUTOMATICO.test(String(ev.prompt || ''));
        if (p && !automatico) {
          if (!atrasado) { s.tarefa = p; s.pedido = encurtarBloco(ev.prompt, MAX_PEDIDO); }
          if (!s.primeira) s.primeira = p;
        }
        if (!atrasado) {
          s.turno = { inicio: t, ferramentas: 0 };
          // Subagentes já concluídos saem no próximo prompt da mãe. Só no prompt do usuário: a entrega
          // automática de um subagente (<agent-message>, <task-notification>) chega como prompt e apagava
          // na hora o que acabou de terminar e os outros concluídos (17/10).
          if (!automatico) s.agentes = s.agentes.filter((a) => !terminado(a));
        }
        s.contadores.turnos++;
        resumo.turnos++;
        if (nativa(s.id)) resumo._nat.turnos++;
        limparEmCurso(s);
        mudar('trabalhando');
        registrar(s, 'prompt', automatico ? 'Mensagem automática recebida' : p || '(prompt)', t);
        break;
      }

      case 'PreToolUse': {
        const ferr = encurtar(ev.tool_name, 60) || 'ferramenta';
        const alvo = alvoDe(ev.tool_input);
        const uid = typeof ev.tool_use_id === 'string' ? ev.tool_use_id : '';
        s.contadores.ferramentas++;
        if (s.turno) s.turno.ferramentas++;
        if (!(uid && s._fechadas.includes(uid))) {
          s._emCurso.push({ id: uid, nome: ferr, alvo, desde: t });
          if (s._emCurso.length > 20) s._emCurso.shift();
          atualizarFerramenta(s);
        }
        if (ev.tool_name === 'Agent' || ev.tool_name === 'Task') lancamentoDeAgente(s, ev, uid, t);
        if (ev.tool_name === 'AskUserQuestion') {
          const q = ev.tool_input?.questions?.[0]?.question;
          const det = q ? `Pergunta: ${encurtar(q, 120)}` : 'Fez uma pergunta';
          if (mudar('aguardando', det)) alerta = 'aguardando';
          registrar(s, 'pergunta', det, t);
        } else if (ev.tool_name === 'ExitPlanMode') {
          if (mudar('aguardando', 'Plano pronto para aprovar')) alerta = 'aguardando';
          registrar(s, 'plano', 'Plano pronto para aprovar', t);
        } else {
          if (s.status !== 'trabalhando') mudar('trabalhando');
          registrar(s, 'ferramenta', descreverFerramenta(ferr, ev.tool_input), t);
        }
        break;
      }

      case 'PermissionRequest': {
        if (ev.tool_name === 'AskUserQuestion' || ev.tool_name === 'ExitPlanMode') break; // já tratado no PreToolUse
        const det = `Aprovar ${descreverFerramenta(ev.tool_name, ev.tool_input)}`;
        if (mudar('aguardando', det)) alerta = 'aguardando';
        registrar(s, 'permissao', det, t);
        break;
      }

      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const uid = typeof ev.tool_use_id === 'string' ? ev.tool_use_id : '';
        let i = uid ? s._emCurso.findIndex((f) => f.id === uid) : -1;
        if (i < 0) i = s._emCurso.findIndex((f) => f.nome === ev.tool_name);
        if (i >= 0) s._emCurso.splice(i, 1);
        else if (uid) {
          // Post antes do Pre (fora de ordem): lembra para o Pre atrasado não abrir a ferramenta.
          s._fechadas.push(uid);
          if (s._fechadas.length > 20) s._fechadas.shift();
        }
        atualizarFerramenta(s);
        if (nome === 'PostToolUseFailure' && (ev.tool_name === 'Agent' || ev.tool_name === 'Task') && uid) falhaDeAgente(s, uid, t);
        if (s.status !== 'trabalhando') mudar('trabalhando');
        break;
      }

      case 'Notification': {
        const tipo = String(ev.notification_type || '');
        const msg = String(ev.message || '');
        const ocioso = tipo === 'idle_prompt' || /waiting for your input/i.test(msg);
        const permissao = tipo === 'permission_prompt' || (!tipo && /permission/i.test(msg));
        if (ocioso) break; // depois do Stop a sessão já aparece como concluída
        if (permissao) {
          // O PermissionRequest costuma chegar antes e com mais detalhe; não duplicar o aviso.
          if (s.status !== 'aguardando') {
            const det = encurtar(msg, 140) || 'Precisa da sua aprovação';
            if (mudar('aguardando', det)) alerta = 'aguardando';
            registrar(s, 'permissao', det, t);
          }
        } else if (tipo === 'elicitation_dialog') {
          const det = encurtar(msg, 140) || 'Aguardando sua resposta';
          if (mudar('aguardando', det)) alerta = 'aguardando';
          registrar(s, 'pergunta', det, t);
        }
        break;
      }

      case 'Stop': {
        const r = typeof ev.last_assistant_message === 'string' ? encurtarBloco(ev.last_assistant_message, MAX_RESPOSTA) : '';
        if (!atrasado) {
          if (r) s.ultimaResposta = r;
          limparEmCurso(s);
        }
        if (mudar('concluida')) {
          alerta = 'concluida';
          resumo.porHora.concluidas[horaDe(t)]++;
        }
        registrar(s, 'concluida', r ? encurtar(r, 140) : 'Concluiu', t);
        break;
      }

      case 'StopFailure': {
        const det = encurtar(ev.error_details || ev.error || ev.message || 'Parou com erro', 140);
        if (!atrasado) limparEmCurso(s);
        if (mudar('erro', det)) alerta = 'erro';
        registrar(s, 'erro', det, t);
        break;
      }

      case 'SessionEnd':
        if (controle.dormindo?.(s.id)) break; // etapa 4: a instância do Orbit só dormiu
        if (mudar('encerrada', ev.reason ? encurtar(ev.reason, 80) : '')) {
          limparEmCurso(s);
          encerrarAgentes(s, t);
          s.vivo = false;
        }
        registrar(s, 'fim', ev.reason ? `Encerrada (${encurtar(ev.reason, 60)})` : 'Encerrada', t);
        break;
    }
  }

  contarSubagentes(s);
  if (alerta && !forcar && anterior === s.status && alerta !== 'concluida') alerta = null;
  salvar();
  difundirSessao(s);
  if (alerta) alertar(alerta, s, t, agenteDoAlerta);
  difundirResumoSeMudou();
  return alerta;
}

function remover(id) {
  const eraNativa = nativa(id); // celular: depois daqui a sessão e o registro somem
  controle.esquecer?.(id); // etapa 4: apaga o registro da instância (instancias.json)
  if (!sessoes.delete(id)) return false;
  removidas.set(id, Date.now());
  if (removidas.size > 500) removidas.delete(removidas.keys().next().value);
  eventos.delete(id);
  difundir('remover', { id }, { nativa: eraNativa });
  return true;
}

function limpar() {
  const agora = Date.now();
  let mudou = false;
  for (const [id, s] of sessoes) {
    if (s.fixada) continue;
    if (controle.dormindo?.(id)) continue; // etapa 4: instância do Orbit dormindo só sai pelo Remover
    const parado = agora - Math.max(s.atividade || 0, s.desde || 0);
    if ((s.status === 'encerrada' && parado > DOZE_HORAS) || parado > DOIS_DIAS) mudou = remover(id) || mudou;
  }
  if (mudou) salvar();
}

// ───────────────────────── subagentes (dependentes internos) ─────────────────────────

const terminado = (a) => a.status === 'concluido' || a.status === 'erro';

function contarSubagentes(s) {
  s.subagentes = s.agentes.filter((a) => !terminado(a)).length;
}

function agenteVazio(id, tipo, t) {
  return {
    id, tipo: tipo || 'subagente', descricao: '', status: 'trabalhando', inicio: t, fim: null, ferramenta: null, ferramentas: 0, atividade: t,
    acoes: [], texto: '', textoTs: 0, _arq: '', _mtime: 0, _fechadas: [],
  };
}

// ── Ações do subagente (feed ao vivo) ──
// acoes: [{nome, alvo, ts, fim|null, erro?}] da mais antiga para a mais nova (máx. 8).
// `ferramenta` é sempre a ação aberta mais nova (o subagente pode rodar ferramentas em paralelo).

function inserirAcao(a, acao) {
  let i = a.acoes.length;
  while (i > 0 && a.acoes[i - 1].ts > acao.ts) i--; // fora de ordem: no lugar certo
  a.acoes.splice(i, 0, acao);
  if (a.acoes.length > MAX_ACOES) a.acoes.splice(0, a.acoes.length - MAX_ACOES);
}

function fecharAcoes(a, t) {
  for (const x of a.acoes) if (x.fim == null) x.fim = Math.max(t, x.ts);
}

function ferramentaDoAgente(a) {
  if (terminado(a) || a.status === 'aguardando') {
    a.ferramenta = null;
    return;
  }
  let aberta = null;
  for (const x of a.acoes) if (x.fim == null) aberta = x;
  a.ferramenta = aberta ? { nome: aberta.nome, alvo: aberta.alvo, desde: aberta.ts } : null;
}

function garantirAgente(s, id, tipo, t) {
  let a = s.agentes.find((x) => x.id === id);
  if (!a) {
    a = agenteVazio(id, tipo, t);
    s.agentes.push(a);
    podarAgentes(s, Date.now(), a);
  } else if (tipo && (a.tipo === 'subagente' || !a.tipo)) a.tipo = tipo;
  return a;
}

// PreToolUse de Agent/Task do agente principal: guarda a descrição para casar com o SubagentStart.
function lancamentoDeAgente(s, ev, uid, t) {
  const tipo = encurtar(ev.tool_input?.subagent_type, 40) || 'general-purpose';
  const descricao = encurtar(ev.tool_input?.description, 120);
  // O prompt inteiro só vai para o detalhe do subagente (reserva para quando não há transcript).
  const pedido = encurtarBloco(ev.tool_input?.prompt, MAX_PEDIDO_AGENTE);
  // O SubagentStart pode ter chegado antes (eventos assíncronos).
  const a = s.agentes.find((x) => !x.descricao && !s._agenteTool[x.id] && x.tipo === tipo && !terminado(x) && x.inicio >= t - 5000);
  if (a) {
    a.descricao = descricao;
    a._pedido = pedido;
    s._agenteTool[a.id] = uid;
    return;
  }
  s._agentePend.push({ uid, tipo, descricao, pedido, ts: t });
  if (s._agentePend.length > 20) s._agentePend.shift();
}

// SubagentStart: casa com o lançamento pendente mais antigo do mesmo tipo.
function casarDescricao(s, a) {
  if (a.descricao || s._agenteTool[a.id]) return;
  const i = s._agentePend.findIndex((p) => p.tipo === a.tipo);
  if (i < 0) return;
  const [p] = s._agentePend.splice(i, 1);
  a.descricao = p.descricao;
  a._pedido = p.pedido || '';
  s._agenteTool[a.id] = p.uid;
}

// PostToolUseFailure da ferramenta Agent: o subagente lançado por ela falhou.
function falhaDeAgente(s, uid, t) {
  s._agentePend = s._agentePend.filter((p) => p.uid !== uid);
  for (const [aid, u] of Object.entries(s._agenteTool)) {
    if (u !== uid) continue;
    const a = s.agentes.find((x) => x.id === aid);
    if (a && !terminado(a)) {
      a.status = 'erro';
      a.fim = t;
      a.ferramenta = null;
      fecharAcoes(a, t);
    }
  }
}

function encerrarAgentes(s, t) {
  for (const a of s.agentes) {
    if (terminado(a)) continue;
    a.status = 'erro'; // morreu junto com a sessão
    a.fim = t;
    a.ferramenta = null;
    fecharAcoes(a, t);
  }
  s._agentePend = [];
  contarSubagentes(s);
}

// Tira concluídos há mais de 30 min, ativos sem sinal há 30 min e o excesso (máx. 20).
function podarAgentes(s, agora, manter = null) {
  if (s.provedor === 'codex') return false; // Codex: a poda dos agentes é do codex.mjs
  const antes = s.agentes.length;
  s.agentes = s.agentes.filter((a) =>
    a === manter || (terminado(a) ? agora - (a.fim || a.atividade || 0) <= AGENTE_VISIVEL : agora - (a.atividade || a.inicio || 0) <= SUBAGENTE_ESQUECIDO),
  );
  while (s.agentes.length > MAX_AGENTES) {
    let i = s.agentes.findIndex((a) => terminado(a) && a !== manter);
    if (i < 0) i = s.agentes.findIndex((a) => a !== manter);
    s.agentes.splice(i, 1);
  }
  s._agentePend = s._agentePend.filter((p) => agora - p.ts <= 10 * 60e3);
  for (const aid of Object.keys(s._agenteTool)) if (!s.agentes.some((a) => a.id === aid)) delete s._agenteTool[aid];
  const mudou = s.agentes.length !== antes;
  if (mudou) contarSubagentes(s);
  return mudou;
}

// Evento com agent_id. Devolve {alerta, forcar} quando o subagente prende o usuário.
function eventoDeAgente(s, a, ev, nome, t, mudar) {
  a.atividade = Math.max(a.atividade || 0, t);
  // Caminho do transcript do subagente, se o evento trouxer (senão é derivado do da sessão).
  if (typeof ev.agent_transcript_path === 'string' && /\.jsonl$/i.test(ev.agent_transcript_path)) a._arq = ev.agent_transcript_path.slice(0, 1000);
  const rot = `[${a.tipo}]`;
  // A espera que prendia a sessão era deste agente: ele andou, a sessão volta ao que era
  // (trabalhando, ou concluída se era um subagente em segundo plano depois do Stop da mãe).
  const liberar = () => {
    if (s.status === 'aguardando' && s._esperaAgente === a.id) mudar(s._statusAntes || 'trabalhando', s._statusAntes ? s._detalheAntes : '');
  };
  const pedir = (det, tipoEvento) => {
    registrar(s, tipoEvento, `${rot} ${det}`, t);
    if (!terminado(a)) {
      a.status = 'aguardando';
      a.ferramenta = null;
    }
    const antes = s.status;
    const detalheAntes = s.detalhe;
    const outro = antes === 'aguardando' && s._esperaAgente !== a.id;
    if (!mudar('aguardando', det)) return null;
    s._esperaAgente = a.id;
    if (antes !== 'aguardando' && antes !== 'trabalhando') {
      s._statusAntes = antes;
      s._detalheAntes = detalheAntes;
    }
    return { alerta: 'aguardando', forcar: outro };
  };
  switch (nome) {
    case 'SubagentStart':
      a.inicio = Math.min(a.inicio || t, t);
      casarDescricao(s, a);
      registrar(s, 'subagente', `Iniciou ${a.tipo}${a.descricao ? `: ${a.descricao}` : ''}`, t);
      return null;

    case 'PreToolUse': {
      const ferr = encurtar(ev.tool_name, 60) || 'ferramenta';
      const uid = typeof ev.tool_use_id === 'string' ? ev.tool_use_id.slice(0, 100) : '';
      s.contadores.ferramentas++;
      if (s.turno) s.turno.ferramentas++;
      a.ferramentas++;
      // Post antes do Pre (hooks assíncronos): a ação entra já fechada, sem prender a ferramenta.
      const fechada = !!uid && a._fechadas.includes(uid);
      inserirAcao(a, { nome: ferr, alvo: alvoDe(ev.tool_input), ts: t, fim: fechada || terminado(a) ? t : null, _uid: uid });
      if (!terminado(a)) a.status = 'trabalhando';
      ferramentaDoAgente(a);
      registrar(s, 'ferramenta', `${rot} ${descreverFerramenta(ferr, ev.tool_input)}`, t);
      liberar();
      return null;
    }

    case 'PermissionRequest':
      return pedir(`Aprovar ${descreverFerramenta(ev.tool_name, ev.tool_input)}`, 'permissao');

    case 'Notification': {
      const tipo = String(ev.notification_type || '');
      const msg = String(ev.message || '');
      if (tipo === 'permission_prompt' && s.status !== 'aguardando') return pedir(encurtar(msg, 140) || 'Precisa da sua aprovação', 'permissao');
      if (tipo === 'elicitation_dialog') return pedir(encurtar(msg, 140) || 'Aguardando sua resposta', 'pergunta');
      return null;
    }

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const uid = typeof ev.tool_use_id === 'string' ? ev.tool_use_id.slice(0, 100) : '';
      let acao = null;
      for (const x of a.acoes) if (x.fim == null && (uid ? x._uid === uid : x.nome === ev.tool_name)) acao = x;
      // Sem tool_use_id no Pre (evento antigo): casa pelo nome.
      if (!acao && uid) for (const x of a.acoes) if (x.fim == null && !x._uid && x.nome === ev.tool_name) acao = x;
      if (acao) {
        acao.fim = Math.max(t, acao.ts);
        if (nome === 'PostToolUseFailure') acao.erro = true;
      } else if (uid) {
        a._fechadas.push(uid);
        if (a._fechadas.length > 20) a._fechadas.shift();
      }
      if (!terminado(a)) a.status = 'trabalhando';
      if (a._acima && !a._acima.fim) a._acima.depois++; // 20/10: ferramentas concluídas depois de passar do limite
      ferramentaDoAgente(a);
      liberar();
      return null;
    }

    case 'SubagentStop':
    case 'Stop': {
      a.status = 'concluido';
      a.fim = Math.max(t, a.inicio || 0);
      a.ferramenta = null;
      fecharAcoes(a, a.fim);
      const r = typeof ev.last_assistant_message === 'string' ? encurtar(ev.last_assistant_message, MAX_TEXTO_AGENTE) : '';
      if (r) {
        a.texto = r;
        a.textoTs = t;
      }
      registrar(s, 'subagente', `Terminou ${a.tipo}${a.descricao ? `: ${a.descricao}` : ''}`, t);
      liberar();
      return null;
    }

    case 'StopFailure': {
      const det = encurtar(ev.error_details || ev.error || 'Parou com erro', 140);
      a.status = 'erro';
      a.fim = t;
      a.ferramenta = null;
      fecharAcoes(a, t);
      registrar(s, 'erro', `${rot} ${det}`, t);
      liberar();
      return null;
    }
  }
  return null;
}

// ───────────────────────── registro de sessões do Claude Code ─────────────────────────
// ~/.claude/sessions/<pid>.json: { pid, sessionId, cwd, startedAt, name, status: busy|idle,
// waitingFor?, hostSessionId?, updatedAt, statusUpdatedAt }. Só leitura.

function aplicarRegistro(r, agora) {
  const id = encurtar(r.sessionId, 100);
  const pid = Number(r.pid);
  const pidOk = Number.isInteger(pid) && pid > 0;
  const estaVivo = pidOk && vivo(pid);
  const tStatus = Math.min(Number(r.statusUpdatedAt) || Number(r.updatedAt) || 0, agora);
  const ocupado = r.status === 'busy';
  let s = sessoes.get(id);
  if (s?.provedor === 'codex') return; // Codex: não tem registro nem pid do Claude (codex.mjs)
  let mudou = false;
  if (!s) {
    // Arquivo velho de processo morto, ou sessão que o usuário tirou da lista: não cria.
    if (!estaVivo || removidas.has(id) || sondasUso.has(id)) return;
    if (ignoradasTemp.has(id) || emPastaTemporaria(r.cwd)) { ignoradasTemp.add(id); return; } // rodada 8
    const ini = Math.min(Number(r.startedAt) || agora, agora);
    s = novaSessao(id, ini);
    s._tsStatus = 0; // qualquer evento de hook manda mais que o registro
    s._hook = false;
    if (ocupado) {
      s.status = 'trabalhando';
      s.desde = Math.max(ini, tStatus || ini);
    }
    if (typeof r.cwd === 'string' && r.cwd) {
      s.cwd = r.cwd.slice(0, 500);
      s.projeto = path.basename(s.cwd.replace(/[\\/]+$/, ''));
      sessaoVista(s); // rodada 8
    }
    sessoes.set(id, s);
    registrar(s, 'inicio', 'Vista no registro do Claude Code', ini);
    mudou = true;
  }
  const antes = JSON.stringify([s.nome, s.pai, s.pid, s.vivo, s.registro]);
  if (typeof r.name === 'string' && r.name) s.nome = encurtar(r.name, 60);
  if (typeof r.hostSessionId === 'string' && r.hostSessionId && r.hostSessionId !== id && sessoes.get(r.hostSessionId)?.provedor !== 'codex') s.pai = encurtar(r.hostSessionId, 100);
  if (pidOk) s.pid = pid;
  if (s.status !== 'encerrada') s.vivo = estaVivo;
  const espera = r.waitingFor == null || r.waitingFor === '' ? null : encurtar(typeof r.waitingFor === 'string' ? r.waitingFor : JSON.stringify(r.waitingFor), 120);
  s.registro = { status: typeof r.status === 'string' ? r.status : null, waitingFor: espera, atualizado: tStatus || null };
  s._noRegistro = true;
  if (JSON.stringify([s.nome, s.pai, s.pid, s.vivo, s.registro]) !== antes) mudou = true;

  // Confirmação pelo registro — nunca contra um evento de hook mais novo que statusUpdatedAt.
  if (estaVivo && tStatus && tStatus >= s._tsStatus) {
    const quando = Math.max(tStatus, s.desde);
    if (s.status === 'trabalhando' && r.status === 'idle' && agora - tStatus > MS_OCIOSO) {
      if (s._hook) {
        // Ficou ocioso sem Stop: o turno foi interrompido.
        trocarStatus(s, 'interrompida', 'Parou sem concluir (ociosa no registro)', quando, quando);
        limparEmCurso(s);
        registrar(s, 'interrompida', 'Parou sem concluir (ociosa no registro)', quando);
        salvar();
        difundirSessao(s);
        alertar('interrompida', s, quando);
        return;
      }
      // Sessão sem hooks (só o registro): espelha busy/idle, sem alerta.
      trocarStatus(s, 'concluida', '', quando, quando);
      mudou = true;
    } else if (!s._hook && ocupado && s.status !== 'trabalhando' && s.status !== 'aguardando' && s.status !== 'encerrada') {
      trocarStatus(s, 'trabalhando', '', quando);
      mudou = true;
    }
  }
  if (mudou) {
    salvar();
    difundirSessao(s);
  }
}

async function lerRegistro(agora) {
  let nomes;
  try {
    nomes = await fsp.readdir(SESSOES_DIR);
  } catch {
    return; // pasta não existe (Claude Code antigo) — nada a fazer
  }
  let falhou = false;
  const lidos = await Promise.all(
    nomes
      .filter((n) => /^\d+\.json$/.test(n))
      .map(async (n) => {
        try {
          return JSON.parse(await fsp.readFile(path.join(SESSOES_DIR, n), 'utf8'));
        } catch {
          falhou = true; // arquivo sendo regravado: não conclui que alguém sumiu nesta rodada
          return null;
        }
      }),
  );
  const vistos = new Set();
  for (const r of lidos) {
    if (!r || typeof r !== 'object' || typeof r.sessionId !== 'string' || !r.sessionId) continue;
    vistos.add(encurtar(r.sessionId, 100));
    try {
      aplicarRegistro(r, agora);
    } catch (e) {
      log('registro', r.sessionId, e.message);
    }
  }
  if (falhou) return;
  for (const s of sessoes.values()) {
    if (!s._noRegistro || vistos.has(s.id)) continue;
    // Sumiu do registro: se o processo também morreu, encerrou.
    s._noRegistro = false;
    s.registro = null;
    if (s.pid && s.status !== 'encerrada' && !vivo(s.pid)) encerrarPorProcesso(s, agora);
    else {
      salvar();
      difundirSessao(s);
    }
  }
  for (const id of removidas.keys()) if (!vistos.has(id)) removidas.delete(id);
}


// ───────────────────────── uso do plano (status line) ─────────────────────────
// O statusline.mjs repassa o JSON da status line do Claude Code:
// rate_limits.{five_hour,seven_day}.{used_percentage, resets_at (s epoch)},
// context_window.{total_input_tokens, context_window_size, used_percentage}, session_id, model.

function pctDe(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n * 10) / 10)) : null;
}

// Mesma conta do Claude Code: arredondado e limitado a 0–100.
function pctDaJanela(tokens, janela) {
  return janela > 0 ? Math.min(100, Math.max(0, Math.round((tokens / janela) * 100))) : null;
}

function janelaDoPlano(j) {
  if (!j || typeof j !== 'object') return null;
  const pct = pctDe(j.used_percentage);
  if (pct === null) return null;
  let r = Number(j.resets_at);
  if (!Number.isFinite(r) || r <= 0) r = null;
  else if (r < 1e12) r *= 1000; // segundos → ms
  return { pct, renova: r === null ? null : Math.round(r) };
}

function normalizarUso(u) {
  if (!u || typeof u !== 'object') return null;
  const j = (x) => (x && typeof x === 'object' && typeof x.pct === 'number' ? { pct: x.pct, renova: Number(x.renova) || null } : null);
  return { cincoHoras: j(u.cincoHoras), semanal: j(u.semanal), atualizado: Number(u.atualizado) || 0 };
}

function aplicarUso(b, agora) {
  const tb = Number(b.ts);
  const t = Number.isFinite(tb) && tb > 0 && tb <= agora + 60e3 ? tb : agora;
  const r = { uso: false, sessao: false };

  const rl = b.rate_limits;
  const novo = rl && typeof rl === 'object' && !Array.isArray(rl) ? { cincoHoras: janelaDoPlano(rl.five_hour), semanal: janelaDoPlano(rl.seven_day), atualizado: t } : null;
  // Várias sessões mandam o mesmo uso da conta: vale o mais novo. Leitura sem nenhuma das janelas não apaga a
  // última boa (a página só mostra "Demonstração" quando nunca houve leitura).
  if (novo && (novo.cincoHoras || novo.semanal) && (!uso || t >= uso.atualizado)) {
    const mudou = !uso || JSON.stringify([uso.cincoHoras, uso.semanal]) !== JSON.stringify([novo.cincoHoras, novo.semanal]);
    uso = novo;
    salvar();
    // Sem mudança, difunde no máximo uma vez por minuto (só para o "atualizado").
    if (mudou || agora - usoDifundidoEm > 60e3) {
      usoDifundidoEm = agora;
      difundir('uso', uso);
    }
    r.uso = true;
  }

  const id = typeof b.session_id === 'string' ? b.session_id.slice(0, 100) : '';
  const s = id ? sessoes.get(id) : null; // a status line não cria sessão
  const cw = b.context_window;
  if (s && cw && typeof cw === 'object') {
    const janela = Number(cw.context_window_size);
    if (Number.isFinite(janela) && janela > 0) {
      const antes = JSON.stringify(s.contexto);
      const c = { tokens: 0, modelo: '', ...(s.contexto || {}) };
      c.janela = Math.round(janela);
      const tokens = Number(cw.total_input_tokens);
      if (Number.isFinite(tokens) && tokens > 0) c.tokens = Math.round(tokens);
      const pct = pctDe(cw.used_percentage);
      c.pct = pct !== null ? Math.round(pct) : pctDaJanela(c.tokens, c.janela);
      if (!c.modelo && typeof b.model?.id === 'string') c.modelo = b.model.id.slice(0, 80);
      s.contexto = c;
      if (JSON.stringify(c) !== antes) {
        salvar();
        difundirSessao(s);
      }
      r.sessao = true;
    }
  }
  return r;
}

// Botão "atualizar" do card (pedido do usuário, 15/10): uma chamada mínima com Haiku, só no clique e só quando
// não há instância rodando (status "trabalhando" com atividade nos últimos 5 min, a mesma conta do "parada" da
// página): aí a leitura viria junto da própria instância. Com a janela de 5h ativa, lê sem mexer no horário dela
// (liberado pelo usuário em 19/10); sem janela, o clique abre uma nova. Nunca é periódica.
const PARADA_MS = 5 * 60e3;
function bloqueioLeituraUso(agora) {
  for (const s of sessoes.values()) {
    if (s.provedor !== 'codex' && s.status === 'trabalhando' && agora - (Number(s.atividade) || Number(s.desde) || 0) <= PARADA_MS) {
      return { motivo: 'rodando', erro: 'Há uma instância trabalhando agora; a leitura sob demanda fica para quando tudo parar.' };
    }
  }
  return null;
}

async function atualizarUsoAgora() {
  const id = crypto.randomUUID();
  sondasUso.add(id);
  try {
    const l = await lerUsoAgora({ sessionId: id });
    aplicarUso({ ts: l.ts, rate_limits: l.rate_limits }, Date.now());
    log('uso', `leitura sob demanda: ${JSON.stringify(l.rate_limits)}${l.custo != null ? ` (US$ ${l.custo})` : ''}`);
    return { ok: true, uso, custo: l.custo };
  } finally {
    setTimeout(() => sondasUso.delete(id), 2 * 60e3).unref(); // o registro dela some com o processo
  }
}

// ───────────────────────── vigias ─────────────────────────

function vivo(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // existe, só não é nosso
  }
}

function encerrarPorProcesso(s, agora) {
  s.vivo = false;
  if (controle.dormindo?.(s.id)) return; // etapa 4: instância do Orbit dormindo não vira "encerrada"
  // O tempo no status que sai só vai até o último sinal de vida.
  trocarStatus(s, 'encerrada', 'processo terminou', agora, s.atividade);
  limparEmCurso(s);
  encerrarAgentes(s, agora);
  registrar(s, 'fim', 'Processo terminou', agora);
  salvar();
  difundirSessao(s);
}

function checarProcessos() {
  const agora = Date.now();
  for (const s of sessoes.values()) {
    if (!s.pid || s.status === 'encerrada' || s.provedor === 'codex') continue;
    try {
      const v = vivo(s.pid);
      if (v) {
        if (s.vivo !== true) {
          s.vivo = true;
          difundirSessao(s);
        }
        continue;
      }
      encerrarPorProcesso(s, agora);
    } catch (e) {
      log('checarProcessos', e.message);
    }
  }
  difundirResumoSeMudou();
}

// Lê o fim do transcript sem travar o event loop.
async function lerCauda(arquivo, tam, max = CAUDA_TRANSCRIPT) {
  const n = Math.min(tam, max);
  const fh = await fsp.open(arquivo, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, tam - n);
    let texto = buf.subarray(0, bytesRead).toString('utf8');
    if (n < tam) texto = texto.slice(texto.indexOf('\n') + 1); // primeira linha veio cortada
    return texto;
  } finally {
    await fh.close();
  }
}

function textoDoUsuario(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) for (const p of c) if (p && p.type === 'text' && typeof p.text === 'string') return p.text;
  return '';
}

// Texto de um prompt do usuário numa entrada do transcript ('' se a entrada não for um).
function promptDaEntrada(e, lateral = false) {
  if (e.type !== 'user' || e.isMeta || (e.isSidechain && !lateral) || !e.message) return '';
  const c = e.message.content;
  const p = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text' && typeof x.text === 'string' && !PROMPT_AUTOMATICO.test(x.text)).map((x) => x.text).join('\n\n') : '';
  return p.trim() && !PROMPT_AUTOMATICO.test(p) && !p.startsWith('[Request interrupted by user') ? p : '';
}

// Último prompt do transcript inteiro: só para recuperar o "pedido", uma vez por sessão.
async function ultimoPromptDoArquivo(arquivo) {
  let ult = '';
  const rl = readline.createInterface({ input: fs.createReadStream(arquivo, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const linha of rl) {
    if (!linha.includes('"type":"user"')) continue;
    let e;
    try { e = JSON.parse(linha); } catch { continue; }
    const p = e && typeof e === 'object' ? promptDaEntrada(e) : '';
    if (p) ult = p;
  }
  return ult;
}
const MAX_ARQ_RECUPERAR = 64 * 1024 * 1024;

// Extrai do fim do transcript: título, contexto e uma interrupção (Esc) pendente.
function analisarTranscript(texto) {
  const r = { custom: '', ai: '', contexto: null, interrupcao: null, pedido: '' };
  let ultimaMsg = null; // última entrada user/assistant da conversa principal
  for (const linha of texto.split('\n')) {
    if (linha.length < 10) continue;
    const titulo = linha.includes('"customTitle"') || linha.includes('"aiTitle"');
    const msg = linha.includes('"type":"assistant"') || linha.includes('"type":"user"');
    if (!titulo && !msg) continue;
    let e;
    try { e = JSON.parse(linha); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    if (typeof e.customTitle === 'string' && e.customTitle) r.custom = e.customTitle;
    if (typeof e.aiTitle === 'string' && e.aiTitle) r.ai = e.aiTitle;
    if ((e.type !== 'assistant' && e.type !== 'user') || !e.message || e.isSidechain) continue;
    ultimaMsg = e;
    const p = promptDaEntrada(e);
    if (p) r.pedido = p;
    if (e.type === 'assistant') {
      const u = e.message.usage;
      const modelo = e.message.model;
      if (u && modelo && modelo !== '<synthetic>') {
        const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (tokens > 0) r.contexto = comJanela({ tokens, modelo }); // 20/10: janela real do modelo (janela.mjs)
      }
      // Rodada 6, etapa 2: Sessao.modelo/esforco da última resposta de verdade (effort some sem esforço).
      if (typeof modelo === 'string' && modelo && modelo !== '<synthetic>') r.modelo = { modelo, esforco: typeof e.effort === 'string' ? e.effort : '' };
    }
  }
  if (ultimaMsg && ultimaMsg.type === 'user') {
    const txt = textoDoUsuario(ultimaMsg.message);
    if (txt.startsWith('[Request interrupted by user')) {
      r.interrupcao = { uuid: String(ultimaMsg.uuid || ultimaMsg.timestamp || ''), ts: Date.parse(ultimaMsg.timestamp) || 0 };
    }
  }
  return r;
}

async function vigiarTranscript(s, agora) {
  const arquivo = s._transcript;
  if (!arquivo || s.provedor === 'codex') return; // Codex: rollout próprio (codex.mjs)
  let st;
  try {
    st = await fsp.stat(arquivo);
  } catch {
    return;
  }
  const mtime = Math.floor(st.mtimeMs);
  s._sujo = false;
  // Sessão de antes do campo "pedido": lê o transcript uma vez para recuperá-lo.
  // 16/10: sem tarefa, nenhum UserPromptSubmit chegou (hooks ausentes, como no Mac antes do instalar.mjs):
  // o pedido vem do transcript e acompanha os prompts novos dele.
  const doArq = !s.tarefa;
  const recuperar = !s.pedido && (doArq ? !s._pedidoVarrido : !s._pedidoTentado);
  if (mtime === s._mtime && !recuperar) return; // nada novo no arquivo
  s._pedidoTentado = true;
  if (doArq && !s.pedido) s._pedidoVarrido = true;
  s._mtime = mtime;
  let mudou = false;
  if (ATIVOS.has(s.status) && mtime > s.atividade && mtime <= agora + 5000) {
    s.atividade = mtime;
    mudou = true;
  }
  const texto = await lerCauda(arquivo, st.size);
  if (!sessoes.has(s.id)) return; // removida enquanto lia
  const r = analisarTranscript(texto);

  let titulo = '';
  if (r.custom) {
    titulo = r.custom;
    s._custom = true;
  } else if (r.ai && !s._custom) titulo = r.ai;
  titulo = encurtar(titulo, 80);
  if (titulo && titulo !== s.titulo) {
    s.titulo = titulo;
    mudou = true;
  }
  if (recuperar || doArq) {
    // O prompt pode estar antes da cauda lida: aí varre o arquivo inteiro.
    let p = r.pedido;
    if (!p && recuperar && st.size > texto.length && st.size <= MAX_ARQ_RECUPERAR) p = await ultimoPromptDoArquivo(arquivo).catch(() => '');
    // Só se for o mesmo prompt que virou a tarefa (o hook pode estar à frente do arquivo).
    const plano = (x) => String(x).replace(/\s+/g, ' ').trim();
    if (doArq) {
      const b = p && sessoes.has(s.id) && !s.tarefa ? encurtarBloco(p, MAX_PEDIDO) : '';
      if (b && b !== s.pedido) {
        s.pedido = b;
        mudou = true;
      }
    } else if (p && !s.pedido && sessoes.has(s.id) && plano(p).includes(plano(s.tarefa).replace(/…$/, ''))) {
      s.pedido = encurtarBloco(p, MAX_PEDIDO);
      mudou = true;
    }
  }
  if (r.contexto && (r.contexto.tokens !== s.contexto?.tokens || r.contexto.modelo !== s.contexto?.modelo)) {
    // A janela da status line (a real) vale enquanto o modelo for o mesmo; trocou de modelo, vale a da tabela (20/10).
    const janela = s.contexto?.modelo === r.contexto.modelo ? s.contexto?.janela : null;
    s.contexto = janela ? { ...r.contexto, janela, pct: pctDaJanela(r.contexto.tokens, janela) } : r.contexto;
    mudou = true;
  }
  // Rodada 6, etapa 2: sem resposta na cauda lida, fica o último visto.
  if (r.modelo && (r.modelo.modelo !== s.modelo || r.modelo.esforco !== (s.esforco || ''))) {
    s.modelo = r.modelo.modelo.slice(0, 100);
    if (r.modelo.esforco) s.esforco = r.modelo.esforco.slice(0, 20);
    else delete s.esforco;
    mudou = true;
  }
  const i = r.interrupcao;
  // A interrupção tem de ser do turno atual: um prompt novo ainda não gravado no transcript não a revive.
  const ref = s.turno?.inicio || s.desde;
  if (i && ATIVOS.has(s.status) && i.uuid !== s._interrupcao && i.ts >= ref - 1000) {
    s._interrupcao = i.uuid;
    const quando = Math.max(i.ts, s.desde);
    trocarStatus(s, 'interrompida', 'Interrompida pelo usuário (Esc)', quando, quando);
    limparEmCurso(s);
    registrar(s, 'interrompida', 'Interrompida pelo usuário', quando);
    salvar();
    difundirSessao(s);
    alertar('interrompida', s, quando);
    return;
  }
  if (mudou) {
    salvar();
    difundirSessao(s);
  }
}

// ── Transcript do subagente: <transcript da sessão sem .jsonl>/subagents/agent-<id>.jsonl ──
// Só a última mensagem de texto interessa (o "pensamento" vem cifrado no arquivo).

function arquivoDoAgente(s, a) {
  if (a._arq) return a._arq;
  if (!s._transcript || !/\.jsonl$/i.test(s._transcript) || !/^[\w-]{1,100}$/.test(a.id)) return '';
  return path.join(s._transcript.replace(/\.jsonl$/i, ''), 'subagents', `agent-${a.id}.jsonl`);
}

function ultimoTextoDoAgente(texto) {
  const linhas = texto.split('\n');
  for (let i = linhas.length - 1; i >= 0; i--) {
    const linha = linhas[i];
    if (!linha.includes('"type":"assistant"') || !linha.includes('"text"')) continue;
    let e;
    try { e = JSON.parse(linha); } catch { continue; }
    const c = e?.message?.content;
    if (e?.type !== 'assistant' || !Array.isArray(c)) continue;
    for (let j = c.length - 1; j >= 0; j--) {
      const p = c[j];
      if (p && p.type === 'text' && typeof p.text === 'string' && p.text.trim()) return { texto: p.text, ts: Date.parse(e.timestamp) || 0 };
    }
  }
  return null;
}

const agenteParaLer = (a, agora) => !terminado(a) || agora - (a.fim || 0) < AGENTE_RELER;

// Devolve true se algo visível mudou (texto novo).
async function vigiarAgente(s, a, agora) {
  const arq = arquivoDoAgente(s, a);
  if (!arq) return false;
  let st;
  try {
    st = await fsp.stat(arq);
  } catch {
    return false;
  }
  const mtime = Math.floor(st.mtimeMs);
  if (mtime === a._mtime) return false;
  a._mtime = mtime;
  // O arquivo cresce enquanto ele pensa: conta como sinal de vida (não é podado por silêncio).
  if (!terminado(a) && mtime > (a.atividade || 0) && mtime <= agora + 5000) a.atividade = mtime;
  const cauda = await lerCauda(arq, st.size, CAUDA_AGENTE);
  medirAgente(s, a, cauda, agora);
  const r = ultimoTextoDoAgente(cauda);
  if (!r) return false;
  const t = encurtar(r.texto, MAX_TEXTO_AGENTE);
  if (!t || t === a.texto) return false;
  a.texto = t;
  a.textoTs = Math.min(r.ts || mtime, agora);
  return true;
}

// ── Subagente acima do limite de contexto (20/10) ──
// Limite = config.instancias.autoCompactar.limite (o mesmo da compactação automática). Camada 2: o hook
// síncrono aviso-subagente.mjs avisa o próprio subagente e grava <dados>/avisos-subagentes/<id>. Camada 3
// (reserva): o subagente passou do limite e concluiu ferramentas depois disso sem a marca aparecer (o hook
// não está instalado ou falhou) → uma linha ao líder, se ele for uma instância do Orbit. Um aviso por subagente.
// Valem para qualquer projeto. Os arquivos de progresso (<dados>/progresso/<projeto>/) são apagados por quem
// terminou a tarefa; os esquecidos saem aqui depois de 7 dias sem mudança.
const AVISO_DEPOIS = 2; // ferramentas concluídas depois de passar do limite, sem a marca, para dar a camada 2 por perdida
const MS_AVISO_FOLGA = Number(process.env.ORBIT_MS_AVISO_FOLGA) || 10e3; // e pelo menos este tempo (o hook síncrono grava a marca antes de o evento chegar aqui)
const MS_AVISOS_VIDA = 7 * 86400e3; // marcas antigas são apagadas
let limpezaAvisos = 0;

function limiteSubagente() {
  const l = config.instancias?.autoCompactar?.limite;
  return Number.isInteger(l) && l >= LIMITE_AUTO_MIN && l <= LIMITE_AUTO_MAX ? l : AUTO_COMPACTAR_PADRAO.limite;
}

function medirAgente(s, a, cauda, agora) {
  if (terminado(a) || a._acima) return;
  const tokens = contextoDaCauda(cauda);
  if (tokens > limiteSubagente()) a._acima = { desde: agora, tokens, depois: 0, fim: null };
}

function textoAvisoLider(a, limite) {
  const nome = encurtar(String(a.descricao || a.tipo || 'sem descrição').replace(/\s+/g, ' '), 80);
  return `[Orbit] O subagente "${nome}" (${a.id}) está com ${Math.round(a._acima.tokens / 1000)} mil tokens de contexto, acima do limite de ${Math.round(limite / 1000)} mil, e o aviso direto não chegou a ele: peça que atualize o arquivo de progresso e pare, depois encerre-o e crie outro a partir desse arquivo.`;
}

function avisarLideres(agora) {
  for (const s of sessoes.values()) {
    for (const a of s.agentes) {
      const x = a._acima;
      if (!x || x.fim) continue;
      if (fs.existsSync(path.join(PASTA_AVISOS, a.id))) x.fim = 'direto';
      else if (terminado(a)) x.fim = 'terminou';
      else if (x.depois >= AVISO_DEPOIS && agora - x.desde >= MS_AVISO_FOLGA) {
        const ok = controle.avisarLider(s.id, textoAvisoLider(a, limiteSubagente()));
        x.fim = ok ? 'lider' : 'sem-lider';
        log('agentes', `${a.id} de ${s.id} com ${x.tokens} tokens; aviso direto não chegou → ${ok ? 'avisei o líder' : 'líder fora do Orbit, sem aviso'}`);
      }
    }
  }
  if (agora - limpezaAvisos < 3600e3) return;
  limpezaAvisos = agora;
  fsp.readdir(PASTA_AVISOS).then((nomes) => Promise.all(nomes.map(async (n) => {
    const f = path.join(PASTA_AVISOS, n);
    const st = await fsp.stat(f).catch(() => null);
    if (st && agora - st.mtimeMs > MS_AVISOS_VIDA) await fsp.unlink(f).catch(() => {});
  }))).catch(() => {});
  limparProgresso(agora).catch((e) => log('agentes', `progresso: ${e.message}`));
}

// Arquivos de progresso esquecidos (7 dias sem mudança) e as pastas de projeto que ficaram vazias.
async function limparProgresso(agora) {
  const projetos = await fsp.readdir(PASTA_PROGRESSO, { withFileTypes: true }).catch(() => []);
  for (const p of projetos) {
    if (!p.isDirectory()) continue;
    const dir = path.join(PASTA_PROGRESSO, p.name);
    const andar = async (d, nivel) => {
      for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const c = path.join(d, e.name);
        if (e.isDirectory() && nivel < 3) { await andar(c, nivel + 1); await fsp.rmdir(c).catch(() => {}); }
        else if (e.isFile()) {
          const st = await fsp.stat(c).catch(() => null);
          if (st && agora - st.mtimeMs > MS_AVISOS_VIDA) await fsp.unlink(c).catch(() => {});
        }
      }
    };
    await andar(dir, 1);
    await fsp.rmdir(dir).catch(() => {}); // só sai se ficou vazia
  }
}

async function vigiarAgentes(agora) {
  const mudadas = new Set();
  const tarefas = [];
  for (const s of sessoes.values()) {
    if (!s._transcript && !s.agentes.some((a) => a._arq)) continue;
    for (const a of s.agentes) {
      if (!agenteParaLer(a, agora)) continue;
      tarefas.push(vigiarAgente(s, a, agora).then((m) => m && mudadas.add(s)).catch((e) => log('agente', a.id, e.message)));
    }
  }
  await Promise.all(tarefas);
  for (const s of mudadas) {
    if (!sessoes.has(s.id)) continue;
    salvar();
    difundirSessao(s);
  }
}

// ── Detalhe do subagente (GET /sessao/:id/agente/:aid) ──
// Pedido, última resposta inteira, linha do tempo e métricas, lidos do transcript dele.
// Cache por arquivo: só é relido quando o mtime ou o tamanho mudam.

const cacheDetalheAgente = new Map(); // arquivo → { mtime, size, r }

function analisarTranscriptAgente(texto) {
  const r = { pedido: '', pedidoTs: 0, primeira: '', resposta: '', respostaTs: 0, eventos: [], chamadas: 0, ferramentas: 0, erros: 0, contexto: null };
  const porUid = new Map();
  const msgs = new Set();
  for (const linha of texto.split('\n')) {
    if (linha.length < 10 || (!linha.includes('"type":"assistant"') && !linha.includes('"type":"user"'))) continue;
    let e;
    try { e = JSON.parse(linha); } catch { continue; }
    if (!e || typeof e !== 'object' || !e.message) continue;
    const ts = Date.parse(e.timestamp) || 0;
    const c = e.message.content;
    if (e.type === 'user') {
      const p = promptDaEntrada(e, true);
      if (p) {
        if (!r.primeira) r.primeira = encurtar(p, 300);
        r.pedido = p;
        r.pedidoTs = ts;
        r.eventos.push({ ts, tipo: 'prompt', texto: encurtar(p, 200) });
        continue;
      }
      if (!Array.isArray(c)) continue;
      for (const x of c) {
        if (!x || x.type !== 'tool_result' || !x.is_error) continue;
        r.erros++;
        const ev = porUid.get(x.tool_use_id);
        r.eventos.push({ ts, tipo: 'erro', texto: `Falhou ${ev ? ev.nome : 'uma ferramenta'}` });
      }
      continue;
    }
    if (e.type !== 'assistant') continue;
    // Uma resposta do modelo chega em várias linhas (um bloco por linha) com o mesmo id.
    const mid = e.message.id || e.requestId || e.uuid;
    if (mid && !msgs.has(mid)) {
      msgs.add(mid);
      r.chamadas++;
    }
    const u = e.message.usage;
    const modelo = e.message.model;
    if (u && modelo && modelo !== '<synthetic>') {
      const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (tokens > 0) r.contexto = comJanela({ tokens, modelo }); // 20/10: janela real do modelo (janela.mjs)
    }
    if (!Array.isArray(c)) continue;
    for (const x of c) {
      if (!x) continue;
      if (x.type === 'text' && typeof x.text === 'string' && x.text.trim()) {
        r.resposta = x.text;
        r.respostaTs = ts;
        r.eventos.push({ ts, tipo: 'fala', texto: encurtar(x.text, 200) });
      } else if (x.type === 'tool_use') {
        r.ferramentas++;
        const nome = encurtar(x.name, 60) || 'ferramenta';
        r.eventos.push({ ts, tipo: 'ferramenta', texto: encurtar(descreverFerramenta(nome, x.input), 200) });
        if (typeof x.id === 'string') porUid.set(x.id, { nome });
      }
    }
  }
  return r;
}

// Começo do arquivo, sem a última linha (cortada).
async function lerInicio(arquivo, n) {
  const fh = await fsp.open(arquivo, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    const texto = buf.subarray(0, bytesRead).toString('utf8');
    return texto.slice(0, texto.lastIndexOf('\n') + 1);
  } finally {
    await fh.close();
  }
}

async function transcriptDoAgente(arq) {
  let st;
  try {
    st = await fsp.stat(arq);
  } catch {
    return null;
  }
  const mtime = Math.floor(st.mtimeMs);
  const c = cacheDetalheAgente.get(arq);
  if (c && c.mtime === mtime && c.size === st.size) return c.r;
  // Grande demais: o começo (pedido) e o fim (o que ele faz agora); o meio fica de fora.
  const parcial = st.size > MAX_ARQ_AGENTE;
  const texto = parcial
    ? (await lerInicio(arq, CAUDA_TRANSCRIPT)) + (await lerCauda(arq, st.size, MAX_ARQ_AGENTE - CAUDA_TRANSCRIPT))
    : await fsp.readFile(arq, 'utf8');
  const r = { ...analisarTranscriptAgente(texto), parcial };
  cacheDetalheAgente.delete(arq);
  cacheDetalheAgente.set(arq, { mtime, size: st.size, r });
  while (cacheDetalheAgente.size > 40) cacheDetalheAgente.delete(cacheDetalheAgente.keys().next().value);
  return r;
}

async function detalheDoAgente(s, aid) {
  if (!/^[\w-]{1,100}$/.test(aid)) return null;
  const a = s.agentes.find((x) => x.id === aid) || null;
  const arq = arquivoDoAgente(s, a || { id: aid });
  const t = arq ? await transcriptDoAgente(arq) : null;
  if (!a && !t) return null;
  // Sem transcript: o que os hooks deram (prompt do Agent, feed curto, última fala encurtada).
  const eventos = t
    ? t.eventos.slice()
    : (a.acoes || []).map((x) => ({ ts: x.ts, tipo: x.erro ? 'erro' : 'ferramenta', texto: x.erro ? `Falhou ${x.nome}` : x.alvo ? `${x.nome}: ${x.alvo}` : x.nome }));
  if (!t && a._pedido) eventos.unshift({ ts: a.inicio || 0, tipo: 'prompt', texto: encurtar(a._pedido, 200) });
  if (a && terminado(a) && a.fim) eventos.push({ ts: a.fim, tipo: a.status === 'erro' ? 'erro' : 'concluida', texto: a.status === 'erro' ? 'Parou com erro' : 'Terminou' });
  return {
    sessao: { id: s.id },
    agente: a ? semInternos(a) : null,
    transcript: !!t,
    parcial: !!(t && t.parcial),
    pedido: t && t.pedido ? encurtarBloco(t.pedido, MAX_PEDIDO) : a?._pedido || '',
    pedidoTs: (t && t.pedidoTs) || a?.inicio || 0,
    primeira: t ? t.primeira : '',
    resposta: t && t.resposta ? encurtarBloco(t.resposta, MAX_PEDIDO) : a?.texto || '',
    respostaTs: (t && t.respostaTs) || a?.textoTs || 0,
    eventos: eventos.slice(-MAX_EVENTOS_AGENTE),
    metricas: {
      ferramentas: t ? t.ferramentas : a?.ferramentas || 0,
      chamadas: t ? t.chamadas : 0,
      erros: t ? t.erros : (a?.acoes || []).filter((x) => x.erro).length,
    },
    contexto: t ? t.contexto : null,
  };
}

function lembretes(agora) {
  const min = config.lembreteMin;
  if (!(min > 0)) return;
  for (const s of sessoes.values()) {
    if (s.status === 'aguardando' && !s._lembrete && agora - s.desde >= min * 60e3) {
      s._lembrete = true;
      salvar();
      alertar('lembrete', s, agora, s._esperaAgente ? s.agentes.find((a) => a.id === s._esperaAgente) || null : null);
    }
  }
}

// Um tique extra pouco depois de uma rajada de eventos (um só por rajada).
let tiqueMarcado = null;
function tiqueLogo() {
  if (tiqueMarcado) return;
  tiqueMarcado = setTimeout(() => {
    tiqueMarcado = null;
    tique();
  }, 400);
  tiqueMarcado.unref();
}

let ocupado = false;
let repetir = false;
async function tique() {
  if (ocupado) {
    repetir = true;
    return;
  }
  ocupado = true;
  const agora = Date.now();
  try {
    if (resumo.data !== hoje(agora)) {
      virarDia(agora);
      difundirResumoSeMudou();
    }
    lembretes(agora);
    // Subagentes concluídos há muito, ou que sumiram sem SubagentStop (Esc, processo morto).
    for (const s of sessoes.values()) if (podarAgentes(s, agora)) difundirSessao(s);
    await lerRegistro(agora).catch((e) => log('registro', e.message));
    // stat é barato: olha todas as sessões não encerradas; o fim do arquivo só é lido quando o mtime muda.
    const alvos = [...sessoes.values()].filter((s) => s._transcript && (s.status !== 'encerrada' || s._sujo));
    await Promise.all(
      alvos.map((s) => vigiarTranscript(s, agora).catch((e) => log('transcript', s.id, e.message))),
    );
    // Última mensagem de texto dos subagentes ativos (stat barato; o fim só é lido quando o mtime muda).
    await vigiarAgentes(agora).catch((e) => log('agentes', e.message));
    try { avisarLideres(agora); } catch (e) { log('agentes', e.message); } // 20/10: subagente acima do limite
    difundirResumoSeMudou();
  } catch (e) {
    log('tique', e.message);
  } finally {
    ocupado = false;
    if (repetir) {
      repetir = false;
      tiqueLogo();
    }
  }
}

// ───────────────────────── HTTP ─────────────────────────

function lerCorpo(req, limite = MAX_CORPO) {
  // Porta remota: o remoto.mjs já leu o corpo para conferir (modo, pasta); o roteamento relê dele.
  if (typeof req._corpoBruto === 'string') {
    if (Buffer.byteLength(req._corpoBruto) <= limite) return Promise.resolve(req._corpoBruto);
    const e = new Error('corpo grande demais');
    e.status = 413;
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    const declarado = Number(req.headers['content-length']);
    if (declarado > limite) {
      const e = new Error('corpo grande demais');
      e.status = 413;
      return reject(e);
    }
    let tam = 0;
    let estourou = false;
    const partes = [];
    req.on('data', (c) => {
      if (estourou) return;
      tam += c.length;
      if (tam > limite) {
        estourou = true;
        const e = new Error('corpo grande demais');
        e.status = 413;
        reject(e);
      } else partes.push(c);
    });
    req.on('end', () => {
      if (!estourou) resolve(Buffer.concat(partes).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function lerJSONCorpo(req, limite = MAX_CORPO) {
  const bruto = await lerCorpo(req, limite);
  try {
    return bruto.trim() ? JSON.parse(bruto) : {};
  } catch {
    const e = new Error('JSON inválido');
    e.status = 400;
    throw e;
  }
}

function responder(res, codigo, corpo, tipo = 'application/json; charset=utf-8', extra = {}) {
  if (res.headersSent) return;
  res.writeHead(codigo, { 'content-type': tipo, 'cache-control': 'no-store', ...extra });
  res.end(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
}

// Bloqueia DNS rebinding: só aceita o host local.
function hostLocal(req) {
  const h = String(req.headers.host || '').toLowerCase();
  return h === `127.0.0.1:${PORTA}` || h === `localhost:${PORTA}` || h === '127.0.0.1' || h === 'localhost';
}

// Bloqueia pedidos vindos de outra origem (CSRF): um site aberto no navegador consegue mandar um POST
// "simples" (text/plain) para 127.0.0.1. Devolve a mensagem de recusa, ou '' se o pedido pode seguir.
//  - Fora de GET/HEAD/OPTIONS: com Origin, só http://127.0.0.1:<porta> ou http://localhost:<porta>; sem Origin,
//    só se Sec-Fetch-Site faltar (clientes Node: hook, statusline, curl, PowerShell) ou for same-origin/none.
//  - GET/HEAD: recusa Sec-Fetch-Site cross-site/same-site. Exceção única: navegação de topo (clicar num link
//    ou abrir o endereço vindo de outro site) só para a própria página (/, /index.html, /offline.html), que é
//    HTML estático sem dado sensível. Iframe, fetch, EventSource, imagem e ws de outro site seguem barrados.
//    A prévia do navegador interno carrega páginas de outras portas, mas nunca pede nada ao Orbit; o PWA
//    (manifesto, ícones, sw.js) e o SSE são same-origin. O upgrade do terminal não passa por aqui (evento
//    'upgrade'; o terminal.mjs confere o Origin dele).
//  - Quadro (Sec-Fetch-Dest iframe/frame/embed/object), de qualquer origem, inclusive a própria: recusado. O Orbit
//    nunca se embute, e o iframe do navegador interno (allow-scripts + allow-same-origin) com o Orbit dentro teria
//    a API inteira (auditoria P2-4). A página ainda sai com frame-ancestors 'none'.
const DESTINO_QUADRO = new Set(['iframe', 'frame', 'embed', 'object', 'fencedframe']);
function origemRecusada(req, rota) {
  const m = req.method;
  const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (m === 'OPTIONS') return '';
  if (DESTINO_QUADRO.has(String(req.headers['sec-fetch-dest'] || '').toLowerCase())) return 'o Orbit não abre dentro de um quadro';
  if (m === 'GET' || m === 'HEAD') {
    if (sfs !== 'cross-site' && sfs !== 'same-site') return '';
    const navega = String(req.headers['sec-fetch-mode'] || '').toLowerCase() === 'navigate' && String(req.headers['sec-fetch-dest'] || '').toLowerCase() === 'document';
    if (navega && (rota === '/' || rota === '/index.html' || rota === '/offline.html')) return '';
    return 'origem não permitida';
  }
  const origem = req.headers.origin;
  if (origem !== undefined) {
    return origem === `http://127.0.0.1:${PORTA}` || origem === `http://localhost:${PORTA}` ? '' : 'origem não permitida';
  }
  return !sfs || sfs === 'same-origin' || sfs === 'none' ? '' : 'origem não permitida';
}

function idDaRota(rota) {
  try {
    return decodeURIComponent(rota.slice(8));
  } catch {
    return '';
  }
}

const estadoPublico = () => [...sessoes.values()].map(publico);
const estadoNativo = () => [...sessoes.values()].filter((s) => nativa(s.id)).map(publico); // celular
// Celular: resumo do dia só com as contagens das nativas (sem porHora nem ids).
const resumoNativo = () => ({
  data: resumo.data,
  turnos: resumo._nat?.turnos || 0,
  msTrabalhando: resumo._nat?.msTrabalhando || 0,
  msAguardando: resumo._nat?.msAguardando || 0,
  esperas: resumo._nat?.esperas || 0,
  sessoes: (resumo._ids || []).filter((i) => nativa(i)).length,
});
// Celular: histórico de alertas só das nativas, sem cwd (o nome do projeto no lugar) e sem ultimaResposta.
const historicoNativo = () => historico.filter((a) => nativa(a?.sessao?.id)).map(avisoRemoto);

// Rotas do PWA → arquivo em pwa/ e tipo.
const ARQ_PWA = {
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/offline.html': ['offline.html', 'text/html; charset=utf-8'],
};

// O roteamento é um só para as duas portas. `rem` = { aparelho } quando o pedido veio da porta remota e já passou
// pelo remoto.mjs (Host, Origin, cookie e lista permitida); aí hostLocal/origemRecusada não valem (são da 47821).
async function atenderPedido(req, res, rem = null) {
  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch {
    return responder(res, 400, { erro: 'url inválida' });
  }
  const rota = url.pathname;
  try {
    if (!rem) {
      if (!hostLocal(req)) return responder(res, 403, { erro: 'host não permitido' });
      const recusa = origemRecusada(req, rota);
      if (recusa) return responder(res, 403, { erro: recusa });
    }

    if (req.method === 'GET') {
      if (rem && (rota === '/' || rota === '/index.html')) return responder(res, 403, { erro: 'bloqueado_no_celular' }); // nunca a página do PC
      if (rota === '/' || rota === '/index.html') {
        const html = await fsp.readFile(path.join(PASTA, 'index.html'), 'utf8');
        return responder(res, 200, html, 'text/html; charset=utf-8', { 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' });
      }
      // Orbit instalável (PWA): manifesto, service worker na raiz (para valer no site todo) e a
      // tela "Orbit offline", todos de pwa/. Os ícones moram em assets/pwa/.
      if (ARQ_PWA[rota]) {
        const [arq, tipo] = ARQ_PWA[rota];
        let txt;
        try { txt = await fsp.readFile(path.join(PASTA, 'pwa', arq), 'utf8'); } catch { return responder(res, 404, { erro: 'não encontrado' }); }
        if (rota === '/offline.html') {
          const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          txt = txt.replaceAll('__PASTA__', esc(PASTA)).replaceAll('__PORTA__', String(PORTA));
        }
        return responder(res, 200, txt, tipo);
      }
      // Arquivos estáticos da página (imagens/GIFs/fontes), só de dentro de assets/.
      if (rota.startsWith('/assets/')) {
        // Aceita subpastas (assets/office/fundo.png), mas só segmentos simples: nada de "..".
        const nome = rota.slice(8);
        const tipos = { '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
        const tipo = tipos[path.extname(nome).toLowerCase()];
        if (!tipo || !/^(?:[\w@-][\w.@-]*\/)*[\w@-][\w.@-]*$/.test(nome)) return responder(res, 404, { erro: 'não encontrado' });
        try {
          const dados = await fsp.readFile(path.join(PASTA, 'assets', nome));
          // Código (js/css) e fundo-versao.json mudam a qualquer hora; imagens podem ficar em cache
          // (o fundo do Office troca de URL com ?v= a cada versão).
          const cache = /\.(js|css|json)$/i.test(nome) ? 'no-cache' : 'max-age=86400';
          res.writeHead(200, { 'content-type': tipo, 'cache-control': cache });
          return res.end(dados);
        } catch {
          return responder(res, 404, { erro: 'não encontrado' });
        }
      }
      if (rem && rota === '/estado') return responder(res, 200, { sessoes: estadoNativo(), resumoDia: resumoNativo(), uso }); // celular: só nativas; resumoDia só com as contagens delas, sem contaClaude
      if (rem && rota === '/remoto/historico') return responder(res, 200, historicoNativo()); // celular: só nativas, sem cwd nem ultimaResposta
      if (rem && rota === '/instancias') { // celular: só a contagem das nativas (sem memória nem as assumidas)
        const st = [...sessoes.values()].filter((s) => nativa(s.id)).map((s) => controle.estado(s)?.processo);
        return responder(res, 200, { vivas: st.filter((p) => p === 'vivo' || p === 'iniciando').length, dormindo: st.filter((p) => p === 'dormindo').length });
      }
      if (rota === '/estado') return responder(res, 200, { sessoes: estadoPublico(), resumoDia: publicoResumo(), uso, contaClaude: lerContaClaude() });
      if (rota === '/uso') return responder(res, 200, uso);
      if (rota === '/uso/conta') return responder(res, 200, lerContaClaude());
      if (rota === '/config') return responder(res, 200, config);
      if (rota === '/historico') return responder(res, 200, historico);
      if (rota === '/saude') {
        return responder(res, 200, { ok: true, gerenciador: true, versao: VERSAO, desde: iniciouEm, ultimoHook, sessoes: sessoes.size, pid: process.pid });
      }
      if (!rem && remoto && (await remoto.rotaLocal(req, res, rota))) return; // GET /remoto/estado (gestão do celular, só PC)
      if (await perfil.rota(req, res, rota)) return; // /perfil, /perfil/avatar (perfil.mjs)
      if (contaClaude && (await contaClaude.rota(req, res, rota, lerJSONCorpo))) return; // /conta/claude (conta-claude.mjs)
      if (!rem && assistente && (await assistente.rota(req, res, rota, lerJSONCorpo))) return; // GET /assistente (assistente.mjs)
      if (midia && (await midia.rota(req, res, rota, url))) return; // /midia, /midia/capa (midia.mjs)
      if (explorador && (await explorador.rota(req, res, rota, url))) return; // /projetos, /arquivos/* (arquivos.mjs, rodada 8)
      if (temas && (await temas.rota(req, res, rota))) return; // /temas, /temas/icones, /temas/icone/<n> (temas.mjs)
      if (navegador && (await navegador.rota(req, res, rota, url))) return; // /navegador/previas, /navegador/portas (navegador.mjs)
      if (terminal && (await terminal.rota(req, res, rota, url))) return; // terminal integrado: /terminal/shells, /lista, /vendor/*
      if (repos && (await repos.rota(req, res, rota, url))) return; // /repos/* (repos.mjs, rodada 7)
      if (ideias && (await ideias.rota(req, res, rota))) return; // /ideias (ideias.mjs)
      if (whiteboard && (await whiteboard.rota(req, res, rota, url))) return; // /whiteboard/lista, /quadro (whiteboard.mjs)
      if (!rem && escritorios && (await escritorios.tratar(req, res, url))) return; // /escritorios, /escritorios/:id (escritorios.mjs; só no PC)
      if (grafo && (await grafo.rota(req, res, rota, url))) return; // /grafo/dados (grafo.mjs)
      if (disco && (await disco.rota(req, res, rota))) return; // /disco (disco.mjs, card da Home)
      if (regras && (await regras.rota(req, res, rota))) return; // /regras (regras.mjs, Configurações)
      if (skills && (await skills.rota(req, res, rota, url))) return; // /skills, /skills/ler, /arquivo, /sessao (skills.mjs)
      if (mcp && (await mcp.rota(req, res, rota, url))) return; // /mcp (mcp.mjs, Configurações → Conexões MCP)
      if (reinicio && (await reinicio.rota(req, res, rota))) return; // /reinicio (reinicio.mjs)
      // Rodada 5: conversa, fluxo da conversa e ações (controle.mjs); antes do /sessao/:id genérico.
      if (await controle.rota(req, res, rota, url)) return;
      if (codex && config.codex?.ativo && (await codex.rota(req, res, rota, url))) return; // /codex/* (codex.mjs, só com a chave ligada)
      const rotaAg = /^\/sessao\/([^/]+)\/agente\/([^/]+)$/.exec(rota);
      if (rotaAg) {
        let id, aid;
        try {
          id = decodeURIComponent(rotaAg[1]);
          aid = decodeURIComponent(rotaAg[2]);
        } catch {
          return responder(res, 400, { erro: 'id inválido' });
        }
        const s = sessoes.get(id);
        if (!s) return responder(res, 404, { erro: 'sessão não encontrada' });
        const d = await detalheDoAgente(s, aid);
        if (!d) return responder(res, 404, { erro: 'subagente não encontrado' });
        return responder(res, 200, d);
      }
      if (rota.startsWith('/sessao/')) {
        const id = idDaRota(rota);
        const s = sessoes.get(id);
        if (!s) return responder(res, 404, { erro: 'sessão não encontrada' });
        return responder(res, 200, { sessao: publico(s), eventos: eventos.get(id) || [] });
      }
      if (rota === '/fluxo') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
        const inicio = rem ? { sessoes: estadoNativo(), resumoDia: resumoNativo(), uso } : { sessoes: estadoPublico(), config, resumoDia: publicoResumo(), historico: historico.slice(-50), uso, contaClaude: lerContaClaude() };
        res.write(`retry: 2000\nevent: inicio\ndata: ${JSON.stringify(inicio)}\n\n`);
        clientes.add(res);
        const sair = () => clientes.delete(res);
        req.on('close', sair);
        res.on('error', sair);
        return;
      }
      return responder(res, 404, { erro: 'não encontrado' });
    }

    if (req.method !== 'POST') return responder(res, 405, { erro: 'método não permitido' });
    // POST só com o cabeçalho próprio (hook e a própria página): bloqueia outra origem. No celular, quem barra é o
    // remoto.mjs (Origin https://<host> + application/json, que já força o preflight).
    if (!rem && req.headers[CABECALHO] !== '1') return responder(res, 403, { erro: 'cabeçalho ausente' });
    if (!rem && remoto && (await remoto.rotaLocal(req, res, rota))) return; // /remoto/config, revogar, recusar, tailscale/serve
    if (await perfil.rota(req, res, rota)) return; // conectar, verificar e desconectar o GitHub (perfil.mjs)
    if (contaClaude && (await contaClaude.rota(req, res, rota, lerJSONCorpo))) return; // sair e entrar no Claude (conta-claude.mjs)
    if (!rem && assistente && (await assistente.rota(req, res, rota, lerJSONCorpo))) return; // concluir, pular e refazer (assistente.mjs)
    if (midia && (await midia.rota(req, res, rota, url))) return; // play/pause, próxima, anterior e ligar/desligar (midia.mjs)
    if (explorador && (await explorador.rota(req, res, rota, url))) return; // projetos e arquivos (arquivos.mjs, rodada 8)
    if (navegador && (await navegador.rota(req, res, rota, url))) return; // checar, abrir fora, prévia do projeto (navegador.mjs)
    if (terminal && (await terminal.rota(req, res, rota, url))) return; // terminal integrado: /terminal/bilhete
    if (repos && (await repos.rota(req, res, rota, url))) return; // clonar, vincular, commit, push, pull, branch (repos.mjs)
    if (ideias && (await ideias.rota(req, res, rota))) return; // nova, editar, feita, apagar (ideias.mjs)
    if (whiteboard && (await whiteboard.rota(req, res, rota, url))) return; // novo, salvar, renomear, duplicar, excluir (whiteboard.mjs)
    if (!rem && escritorios && (await escritorios.tratar(req, res, url))) return; // criar, salvar, excluir, acionar, membro/enviar (escritorios.mjs; só no PC)
    if (regras && (await regras.rota(req, res, rota))) return; // remover regra, pacote de leitura (regras.mjs)
    if (skills && (await skills.rota(req, res, rota, url))) return; // salvar, duplicar, excluir, estado, arquivos (skills.mjs)
    if (mcp && (await mcp.rota(req, res, rota, url))) return; // verificar, adicionar, remover, ativo, aprovar, proteger (mcp.mjs)
    if (reinicio && (await reinicio.rota(req, res, rota))) return; // /reiniciar pelas Configurações (reinicio.mjs)
    // 21/10: "revisada" no servidor (47821 e celular): {revisada: boolean} grava s.revisadaEm = agora ou apaga.
    const rotaRev = /^\/sessao\/([^/]+)\/revisada$/.exec(rota);
    if (rotaRev) {
      let id = '';
      try { id = decodeURIComponent(rotaRev[1]); } catch { return responder(res, 400, { erro: 'id inválido' }); }
      const p = await lerJSONCorpo(req);
      const s = sessoes.get(id);
      if (!s) return responder(res, 404, { erro: 'sessão não encontrada' });
      if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.revisada !== 'boolean') return responder(res, 400, { erro: 'revisada deve ser booleano' });
      if (p.revisada) s.revisadaEm = Math.max(Date.now(), s.desde);
      else delete s.revisadaEm;
      salvar();
      difundirSessao(s);
      return responder(res, 200, { ok: true, sessao: publico(s) });
    }
    // Rodada 5: mensagem, compactar, limpar, assumir, devolver, permissão (controle.mjs).
    if (await controle.rota(req, res, rota, url)) return;
    if (codex && config.codex?.ativo && (await codex.rota(req, res, rota, url))) return; // /codex/* (codex.mjs, só com a chave ligada)

    if (rota === '/uso/atualizar') {
      if (lendoUso) return responder(res, 409, { erro: 'Já estou lendo o uso do plano.', motivo: 'lendo' });
      const bloqueio = bloqueioLeituraUso(Date.now());
      if (bloqueio) return responder(res, 409, bloqueio);
      lendoUso = atualizarUsoAgora();
      try {
        return responder(res, 200, await lendoUso);
      } catch (e) {
        log('uso', 'leitura sob demanda falhou:', e.message);
        return responder(res, 502, { erro: 'Não deu para ler o uso: ' + e.message });
      } finally {
        lendoUso = null;
      }
    }
    if (rota === '/uso') {
      const b = await lerJSONCorpo(req);
      if (!b || typeof b !== 'object' || Array.isArray(b)) return responder(res, 400, { erro: 'corpo inválido' });
      return responder(res, 200, { ok: true, ...aplicarUso(b, Date.now()) });
    }
    if (rota === '/evento') {
      const ev = await lerJSONCorpo(req);
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return responder(res, 400, { erro: 'evento inválido' });
      if (!ev.session_id || (typeof ev.session_id !== 'string' && typeof ev.session_id !== 'number')) {
        return responder(res, 400, { erro: 'session_id ausente' });
      }
      ultimoHook = Date.now();
      const sid = String(ev.session_id);
      if (ignoradasTemp.has(sid) || emPastaTemporaria(ev.cwd)) { // rodada 8: teste em pasta temporária
        ignoradasTemp.add(sid);
        return responder(res, 200, { ok: true, alerta: null, ignorada: 'pasta temporária' });
      }
      const alerta = aplicar(ev);
      return responder(res, 200, { ok: true, alerta });
    }
    if (rota.startsWith('/sessao/')) {
      const id = idDaRota(rota);
      const s = sessoes.get(id);
      const p = await lerJSONCorpo(req);
      if (!s) return responder(res, 404, { erro: 'sessão não encontrada' });
      if (!p || typeof p !== 'object' || Array.isArray(p)) return responder(res, 400, { erro: 'corpo inválido' });
      if ('fixada' in p && typeof p.fixada !== 'boolean') return responder(res, 400, { erro: 'fixada deve ser booleano' });
      if ('silenciada' in p && typeof p.silenciada !== 'boolean') return responder(res, 400, { erro: 'silenciada deve ser booleano' });
      if ('apelido' in p && typeof p.apelido !== 'string') return responder(res, 400, { erro: 'apelido deve ser texto' });
      if ('fixada' in p) s.fixada = p.fixada;
      if ('silenciada' in p) s.silenciada = p.silenciada;
      if ('apelido' in p) s.apelido = encurtar(p.apelido, 60);
      salvar();
      difundirSessao(s);
      return responder(res, 200, { ok: true, sessao: publico(s) });
    }
    if (rota === '/nova-instancia') {
      const p = await lerJSONCorpo(req);
      const projeto = typeof p?.projeto === 'string' ? p.projeto.trim() : '';
      if (!projeto) return responder(res, 400, { erro: 'projeto ausente' });
      const pasta = pastaDoProjeto(projeto);
      if (!pasta) return responder(res, 404, { erro: 'Não achei a pasta de "' + projeto + '" nas sessões conhecidas.' });
      const exe = acharCodeExe();
      if (!exe) return responder(res, 503, { erro: 'Não achei o VS Code nesta máquina.' });
      abrirNovaInstancia(exe, pasta);
      return responder(res, 202, { ok: true, projeto, pasta });
    }
    if (rota === '/remover') {
      const p = await lerJSONCorpo(req);
      const id = typeof p?.id === 'string' ? p.id : '';
      if (!id) return responder(res, 400, { erro: 'id ausente' });
      const ok = remover(id);
      if (ok) salvar();
      return responder(res, 200, { ok: true, removida: ok });
    }
    if (rota === '/limpar') {
      let n = 0;
      for (const [id, s] of sessoes) {
        if (!s.fixada && (s.status === 'concluida' || s.status === 'interrompida' || s.status === 'encerrada')) {
          remover(id);
          n++;
        }
      }
      if (n) salvar();
      return responder(res, 200, { ok: true, removidas: n });
    }
    if (rota === '/config') {
      const p = await lerJSONCorpo(req);
      if (!p || typeof p !== 'object' || Array.isArray(p)) return responder(res, 400, { erro: 'config inválida' });
      config = mesclarConfig(structuredClone(config), p);
      salvar('config');
      difundir('config', config);
      if (p.remoto) await aplicarRemoto(); // celular: liga/desliga a porta remota também por aqui
      if (p.codex) await aplicarCodex(); // Codex: carrega o módulo ao ligar, para ao desligar
      return responder(res, 200, config);
    }
    if (rota === '/desligar') {
      responder(res, 200, { ok: true });
      setTimeout(() => desligar(`POST /desligar (${req.headers['user-agent'] || 'sem user-agent'})`), 100);
      return;
    }
    responder(res, 404, { erro: 'não encontrado' });
  } catch (e) {
    const status = e?.status || 500;
    if (status === 500) log('erro', req.method, rota, e?.stack || e);
    responder(res, status, { erro: String(e?.message || e) }, undefined, status === 413 ? { connection: 'close' } : {});
  }
}
const servidor = http.createServer((req, res) => atenderPedido(req, res));

// ───────────────────────── Codex (codex.mjs) ─────────────────────────
// Sem import estático: o módulo só carrega (await import) na 1ª vez que config.codex.ativo está ligado. Desligou: parar().
let codex = null;

// Etapa 1 do Codex: o monitor de rollouts (codex.mjs) entrega os campos da sessão; aqui entram em `sessoes` pelo
// mesmo caminho do Claude (trocarStatus, contadores, alertas, histórico, SSE, salvar). `c`: { status, motivo, cwd,
// titulo, primeira, pedido, ultimaResposta, contexto, modelo, esforco, contadores{turnos,ferramentas}, inicio,
// atividade, ferramenta }. Sem a chave ligada não faz nada.
const STATUS_CODEX = ['nova', 'trabalhando', 'aguardando', 'concluida', 'interrompida', 'erro'];
function sessaoCodex(id, c) {
  id = encurtar(id, 100);
  if (!id || !c || typeof c !== 'object' || !config.codex?.ativo) return null;
  const agora = Date.now();
  const ativ = Math.min(Number(c.atividade) || agora, agora);
  let s = sessoes.get(id);
  if (s && s.provedor !== 'codex') return null; // id que já é de outro provedor
  const nova = !s;
  if (nova) {
    if ((removidas.get(id) || 0) >= ativ) return null; // o usuário tirou da lista e nada mudou desde então
    const ini = Math.min(Number(c.inicio) || ativ, agora);
    s = novaSessao(id, ini);
    s.provedor = 'codex';
    s._hook = false;
    s._tsStatus = 0;
    sessoes.set(id, s);
    registrar(s, 'inicio', c.origem === 'orbit' ? 'Criada no Orbit' : 'Sessão do Codex detectada', ini);
  }
  removidas.delete(id);
  if (c.origem === 'orbit') s.origem = 'orbit';
  if (typeof c.apelido === 'string' && c.apelido) s.apelido = encurtar(c.apelido, 60);
  // Etapa 5: membro de time (pai = sessão do Claude que lidera; Codex nunca é líder) e subagentes do próprio Codex.
  if (typeof c.pai === 'string' && c.pai && c.pai !== id && sessoes.get(c.pai) && sessoes.get(c.pai).provedor !== 'codex') s.pai = encurtar(c.pai, 100);
  if (Array.isArray(c.agentes)) { s.agentes = normalizarAgentes({ agentes: c.agentes }); contarSubagentes(s); }
  virarDia(agora);
  if (typeof c.cwd === 'string' && c.cwd) {
    s.cwd = c.cwd.slice(0, 500);
    s.projeto = path.basename(s.cwd.replace(/[\\/]+$/, ''));
  }
  const primeira = encurtar(semAutomatico(c.primeira), 140);
  if (primeira && !s.primeira) s.primeira = primeira;
  const pedido = semAutomatico(c.pedido);
  if (pedido) { s.pedido = encurtarBloco(pedido, MAX_PEDIDO); s.tarefa = encurtar(pedido, 140); }
  if (typeof c.titulo === 'string' && c.titulo) s.titulo = encurtar(c.titulo, 80);
  if (typeof c.ultimaResposta === 'string' && c.ultimaResposta) s.ultimaResposta = encurtarBloco(c.ultimaResposta, MAX_RESPOSTA);
  if (c.contexto && typeof c.contexto === 'object') {
    s.contexto = { tokens: Number(c.contexto.tokens) || 0, modelo: String(c.contexto.modelo || c.modelo || s.modelo || ''), janela: Number(c.contexto.janela) || null, pct: Number.isFinite(Number(c.contexto.pct)) ? Number(c.contexto.pct) : null };
  }
  if (typeof c.modelo === 'string' && c.modelo) s.modelo = c.modelo.slice(0, 100);
  if (typeof c.esforco === 'string' && c.esforco) s.esforco = c.esforco.slice(0, 20);
  s.atividade = Math.max(s.atividade || 0, ativ);

  // Contadores: o rollout traz o total; o dia só soma o que é novo (e só o que é de agora).
  const recente = agora - ativ < 120e3;
  const dTurnos = Math.max(0, (Number(c.contadores?.turnos) || 0) - s.contadores.turnos);
  const dFerr = Math.max(0, (Number(c.contadores?.ferramentas) || 0) - s.contadores.ferramentas);
  s.contadores.turnos += dTurnos;
  s.contadores.ferramentas += dFerr;
  if (!nova || recente) { resumo.turnos += dTurnos; if (nativa(s.id)) resumo._nat.turnos += dTurnos; }
  if (dTurnos > 0) {
    s.turno = { inicio: ativ, ferramentas: 0 };
    if (pedido) registrar(s, 'prompt', encurtar(pedido, 140), ativ);
  }
  if (dFerr > 0 && s.turno) s.turno.ferramentas += dFerr;

  // Troca de status (mesma contabilidade e mesmos alertas do Claude).
  const novo = STATUS_CODEX.includes(c.status) ? c.status : s.status;
  const motivo = encurtar(c.motivo || '', 140);
  let alerta = null;
  if (novo !== s.status) {
    const inatividade = novo === 'interrompida' && s.status === 'trabalhando' && /^sem atividade/i.test(String(c.motivo || ''));
    const t = inatividade ? agora : Math.max(s.desde, ativ);
    trocarStatus(s, novo, novo === 'erro' || novo === 'interrompida' || novo === 'aguardando' ? motivo : '', t, inatividade ? ativ : t);
    const tipo = { concluida: 'concluida', erro: 'erro', interrompida: 'interrompida', aguardando: 'aguardando' }[novo];
    if (tipo && (recente || (!nova && inatividade))) alerta = tipo;
    if (novo === 'concluida') registrar(s, 'concluida', encurtar(s.ultimaResposta, 140) || 'Concluiu', t);
    else if (novo === 'erro') registrar(s, 'erro', motivo || 'Parou com erro', t);
    else if (novo === 'interrompida') registrar(s, 'interrompida', motivo || 'Interrompida', t);
    else if (novo === 'aguardando') registrar(s, 'permissao', motivo || 'Aguardando', t);
    if (alerta === 'concluida') resumo.porHora.concluidas[horaDe(t)]++;
  }
  s.ferramenta = s.status === 'trabalhando' && c.ferramenta && typeof c.ferramenta === 'object'
    ? { nome: encurtar(c.ferramenta.nome, 60), alvo: encurtar(c.ferramenta.alvo, 200), desde: Number(c.ferramenta.desde) || ativ }
    : null;
  if (hoje(ativ) === hoje(agora)) contarSessaoHoje(id);
  salvar();
  difundirSessao(s);
  if (alerta) alertar(alerta, s, Math.max(ativ, s.desde));
  difundirResumoSeMudou();
  return s;
}

// Ao desligar a chave: tira do Orbit tudo o que é do Codex (sessões com SSE `remover`, eventos, histórico e a contagem
// do dia), para voltar a ficar idêntico. Não entra em `removidas` (religar traz de volta).
function removerCodex() {
  const ids = new Set();
  for (const [id, s] of [...sessoes]) {
    if (s.provedor !== 'codex') continue;
    sessoes.delete(id);
    eventos.delete(id);
    ids.add(id);
    difundir('remover', { id });
  }
  if (!ids.size) return 0;
  const antes = historico.length;
  historico = historico.filter((a) => !ids.has(a?.sessao?.id));
  if (historico.length !== antes) salvar('historico');
  if (Array.isArray(resumo._ids)) {
    resumo._ids = resumo._ids.filter((i) => !ids.has(i));
    resumo.sessoes = resumo._ids.length;
  }
  salvar();
  difundirResumoSeMudou();
  return ids.size;
}

async function aplicarCodex() {
  if (!config.codex?.ativo) {
    if (codex) { try { codex.parar(); } catch (e) { log('codex: parar', e?.message || e); } codex = null; }
    removerCodex();
    return;
  }
  if (codex) return;
  try {
    const { criarCodex } = await import('./codex.mjs');
    if (!config.codex?.ativo || codex) return; // mudou durante o import
    codex = criarCodex({
      config: () => config.codex,
      responder: (res, c, corpo) => responder(res, c, corpo),
      log: (...a) => log(...a),
      sessaoCodex,
      removerCodex,
      sessao: (id) => sessoes.get(id),
      difundir: (tipo, dados) => difundir(tipo, dados),
      difundirSessao: (id) => { const s = sessoes.get(id); if (s) difundirSessao(s); },
      removerSessao: (id) => remover(id),
      lerJSONCorpo: (req, limite) => lerJSONCorpo(req, limite),
      avisarLider: (id, texto) => controle.avisarLider(id, texto), // etapa 5: aviso ao líder (instância do Orbit) quando o membro Codex acaba um turno
    });
  } catch (e) {
    log('codex: o módulo não carregou:', e?.message || e);
  }
}

// ───────────────────────── acesso remoto (celular) ─────────────────────────
// 2º servidor só em 127.0.0.1:<config.remoto.porta>, aberto só com config.remoto.ativo (o `tailscale serve` da
// tailnet aponta para ele). Abre e fecha sem reiniciar. Tudo passa pelo remoto.mjs e depois pelo MESMO roteamento.
let servidorRemoto = null;
let portaRemota = 0;
function aplicarRemoto() {
  if (!remoto) return Promise.resolve();
  const c = config.remoto;
  if (servidorRemoto && (!c.ativo || portaRemota !== c.porta)) fecharRemoto();
  if (!c.ativo || servidorRemoto) return Promise.resolve();
  const srv = http.createServer(async (req, res) => {
    try {
      const rem = await remoto.atender(req, res, new URL(req.url, 'http://127.0.0.1').pathname);
      if (rem) await atenderPedido(req, res, rem);
    } catch (e) {
      const status = e?.status || 500;
      if (status === 500) log('remoto: erro', req.method, e?.stack || e);
      responder(res, status, { erro: status === 500 ? 'erro interno' : String(e?.message || e) }, undefined, status === 413 ? { connection: 'close' } : {});
    }
  });
  srv.on('upgrade', (req, socket) => socket.destroy()); // terminal e qualquer WebSocket: nunca no celular
  srv.on('clientError', (e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });
  servidorRemoto = srv;
  portaRemota = c.porta;
  return new Promise((resolve) => {
    srv.once('listening', () => { log(`remoto: porta remota em 127.0.0.1:${portaRemota}`); resolve(); });
    srv.on('error', (e) => {
      log('remoto: a porta remota não abriu', portaRemota, e?.message || e);
      if (servidorRemoto === srv) { servidorRemoto = null; portaRemota = 0; }
      resolve();
    });
    srv.listen(c.porta, '127.0.0.1');
  });
}
function fecharRemoto() {
  const srv = servidorRemoto;
  servidorRemoto = null;
  portaRemota = 0;
  if (!srv) return;
  for (const res of clientes) if (res._remoto) { clientes.delete(res); try { res.end(); } catch {} }
  try { srv.close(); } catch {}
  try { srv.closeAllConnections(); } catch {}
  log('remoto: porta remota fechada');
  remoto?.desligado();
}

// ───────────────────────── nova instância ─────────────────────────
// Abre uma conversa nova do Claude na janela do VS Code do projeto: `Code.exe <pasta>` foca
// (ou abre) a janela da pasta, e o URI da extensão sem `session` abre uma conversa nova. O
// VS Code entrega o URI à janela ativa, que é a que acabou de ser focada ou aberta.
// A sessão entra na lista sozinha, pelo SessionStart do hook.
const URI_NOVA = 'vscode://anthropic.claude-code/open';
const ESPERA_NOVA_MS = Number(process.env.GERENCIADOR_NOVA_MS) || 2000;

function pastaDoProjeto(projeto) {
  let melhor = null;
  for (const s of sessoes.values()) {
    if (!s.cwd || (s.projeto || 'Sem projeto') !== projeto) continue;
    if (melhor && (Number(s.atividade) || 0) <= (Number(melhor.atividade) || 0)) continue;
    try { if (fs.statSync(s.cwd).isDirectory()) melhor = s; } catch {}
  }
  return melhor ? melhor.cwd : null;
}

// GERENCIADOR_CODE_EXE troca o executável (os testes usam um falso).
function acharCodeExe() {
  const env = process.env.GERENCIADOR_CODE_EXE;
  if (env) return fs.existsSync(env) ? env : null;
  if (process.platform === 'win32') {
    // O mesmo executável que o Windows chama para os links vscode://.
    try {
      const r = spawnSync('reg', ['query', 'HKCU\\Software\\Classes\\vscode\\shell\\open\\command', '/ve'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      const m = /"([^"]+\.exe)"/i.exec(r.stdout || '');
      if (m && fs.existsSync(m[1])) return m[1];
    } catch {}
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const d = dir.replace(/^"|"$/g, '');
    if (process.platform === 'win32') {
      const exe = path.resolve(d, '..', 'Code.exe');
      if (fs.existsSync(path.join(d, 'code.cmd')) && fs.existsSync(exe)) return exe;
    } else if (fs.existsSync(path.join(d, 'code'))) return path.join(d, 'code');
  }
  // Mac/Linux: o launchd sobe o Orbit sem o `code` no PATH; o app do VS Code traz o próprio (plataforma.mjs).
  return plataforma.codeCli() || plataforma.acharNoPath('code');
}

function abrirNovaInstancia(exe, pasta) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // herdado de um terminal do VS Code, faria o Code.exe rodar como Node
  delete env.VSCODE_IPC_HOOK_CLI;
  const rodar = (args) => {
    try {
      const p = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true, env });
      p.on('error', (e) => log('nova instância:', e?.message || e));
      p.unref();
    } catch (e) { log('nova instância:', e?.message || e); }
  };
  rodar([pasta]);
  // No Mac, o link vscode:// vai pelo `open`, como o sistema entrega os links ao app (o `code` também aceita
  // --open-url, mas pelo `open` a janela já aberta recebe o link sem abrir outra).
  const uri = () => (plataforma.MAC && !process.env.GERENCIADOR_CODE_EXE ? plataforma.abrirExterno(URI_NOVA).catch((e) => log('nova instância:', e?.message || e)) : rodar(['--open-url', '--', URI_NOVA]));
  setTimeout(uri, ESPERA_NOVA_MS).unref?.();
}

function desligar(motivo) {
  log('desligando', typeof motivo === 'string' ? motivo : '');
  salvarTudoAgora();
  try { controle.encerrarTudo(); } catch {} // fecha o stdin dos processos do Orbit e os fluxos da conversa
  try { contaClaude?.fechar(); } catch {} // um `claude auth login` aberto não fica para trás
  try { if (explorador) explorador.parar(); } catch {} // rodada 8: fecha os vigias de arquivos
  try { if (temas) temas.parar(); } catch {} // temas do VS Code: vigias do VS Code e worker do realce
  try { fecharRemoto(); remoto?.fechar(); } catch {} // celular: a porta remota fecha junto
  try { codex?.parar(); } catch {} // Codex (se estava ligado)
  try { escritorios?.parar(); } catch {} // escritórios: timers de fim de execução
  for (const res of clientes) try { res.end(); } catch {}
  // Terminal integrado: mata os shells com a árvore (taskkill /T) e fecha os WebSockets. Espera o taskkill (até 3 s),
  // senão ele morreria junto com este processo e deixaria o "npm run dev" órfão.
  let esperaTerm = null;
  try { if (terminal && terminal.estado().total) esperaTerm = terminal.parar(); else if (terminal) terminal.parar(); } catch {}
  if (!esperaTerm) process.exit(0);
  try { servidor.close(); } catch {} // a porta fica livre já: o próximo servidor pode subir enquanto esperamos
  const esperas = [esperaTerm && Promise.race([esperaTerm, new Promise((r) => setTimeout(r, 3000))])].filter(Boolean);
  Promise.race([Promise.all(esperas), new Promise((r) => setTimeout(r, 16000))]).catch(() => {}).finally(() => process.exit(0));
}

servidor.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`Já existe um servidor na porta ${PORTA}. Abra http://127.0.0.1:${PORTA}`);
    process.exit(0);
  }
  log('servidor', e.message);
});
// Terminal integrado: o único WebSocket do servidor. O resto dos upgrades é recusado.
servidor.on('upgrade', (req, socket, head) => {
  try { if (terminal && terminal.upgrade(req, socket, head)) return; } catch (e) { log('terminal: upgrade', e?.message || e); }
  socket.destroy();
});
servidor.on('clientError', (e, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
});

process.on('uncaughtException', (e) => log('uncaughtException', e?.stack || e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e?.stack || e));
process.on('SIGINT', desligar);
process.on('SIGTERM', desligar);

carregar();
limpar();
resumoDifundido = JSON.stringify(publicoResumo());
setInterval(limpar, MS_LIMPEZA).unref();
setInterval(tique, MS_TICK).unref();
setInterval(checarProcessos, MS_PID).unref();
// Mantém as conexões SSE vivas através de proxies e do modo de economia do navegador.
setInterval(() => {
  for (const res of clientes) try { res.write(': ping\n\n'); } catch {}
}, MS_PING).unref();

servidor.listen(PORTA, '127.0.0.1', () => {
  log(`Orbit (gerenciador de instâncias) v${VERSAO} em http://127.0.0.1:${PORTA} (dados em ${DADOS})`);
  setTimeout(checarProcessos, 1000).unref();
  setTimeout(tique, 300).unref();
  reinicio?.aoSubir().catch((e) => log('reinício', e?.message || e)); // fecha o reinício que trouxe este servidor
  // Celular: com remoto.ativo, a porta remota volta a abrir e o Tailscale é conferido (preenche host/dono vazios).
  aplicarRemoto().then(() => (config.remoto.ativo ? remoto?.detectar() : null)).catch((e) => log('remoto', e?.message || e));
  aplicarCodex().catch((e) => log('codex', e?.message || e)); // chave ligada no config.json: carrega o módulo
});
