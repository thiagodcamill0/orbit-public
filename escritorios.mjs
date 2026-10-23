// Orbit — Escritórios (contrato da etapa 1, §1–§4 e §8).
//
// Um escritório é um time fixo (orquestrador + 0–8 membros do Claude) numa pasta, com orçamento próprio.
// Dado: <DADOS>/escritorios/<id>.json (definição) e <id>.estado.json (gasto do dia). A execução vive na
// memória: cada acionamento cria uma sessão nova do orquestrador; cada membro nasce na 1ª tarefa enviada a ele
// e é reaproveitado até o fim da execução. O controle (criar/enviar/interromper/encerrar sessões) é injetado.
//
// Rotas (handler `tratar(req, res, url) → boolean`; POST exige `x-gerenciador: 1`):
//   GET  /escritorios · /escritorios/convidados?sessao= · /escritorios/:id · /escritorios/:id/membro/:m/estado
//   POST /escritorios · /:id · /:id/duplicar · /:id/excluir · /:id/acionar · /:id/pausar · /:id/liberar ·
//        /:id/membro/:m/enviar

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { CAMPOS_TOKENS, avaliar, custoCodexUsd, deltaTokens, diaLocal, modeloTemPreco, novoCusto, planoPct as planoPctDe, restante, somarCusto, tabelaPrecosCodex } from './escritorio-orcamento.mjs';

const LIMITE_CORPO = 1024 * 1024;
const ID_OK = /^[a-z0-9-]{1,64}$/;
const SLUG_OK = /^[a-z0-9-]{1,30}$/;
const MAX_NOME = 60;
const MAX_NOME_PAPEL = 40;
const MAX_FUNCAO = 500;
const MAX_PROMPT = 8000;
const MAX_MEMBROS = 8;
const MAX_CONVIDADOS = 6;
const MAX_TAREFA = 4000;
const MAX_TAREFA_MEMBRO = 8000;
const MAX_ANEXO = 20000;
const MAX_EXTRAS = 20;
const MAX_REGEX = 200;
const MAX_RESUMO = 300;
const PAPEL_ORQUESTRADOR = 'orquestrador';
const PRAZO_MIN_PADRAO = 120; // prazo máximo de uma execução (minutos)
const RESERVA_CONVIDADO_MS = 30000; // reserva de convidado até o agente aparecer em s.agentes
const TETO_CONTEXTO_MEMBRO = '140 mil tokens';
const TETO_ESCRITORIOS_PADRAO = 6; // o mesmo padrão do controle.mjs
const MSG_CODEX_DESLIGADO = 'O Codex está desligado nas Configurações: ligue-o para usar membros do Codex.';

const agora = () => new Date().toISOString();
const num = (n) => typeof n === 'number' && Number.isFinite(n);
const texto = (v) => typeof v === 'string';
const limparLinha = (s) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const encurtar = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const barras = (p) => String(p).replace(/\\/g, '/');

function responder(res, codigo, corpo) {
  if (res.headersSent) return;
  res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

function erro(status, msg, extra) {
  const e = new Error(msg);
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}

// ───────────────────────── Textos do orquestrador e dos membros ─────────────────────────

function listaMembros(esc) {
  const ms = esc.membros || [];
  if (!ms.length) return '(nenhum membro: trabalhe sozinho e use convidados, se o limite permitir)';
  return ms.map((m) => `- id \`${m.id}\` · papel: ${m.papel} · nome: ${m.nome}`).join('\n');
}

function brl(n) {
  return `US$ ${Number(n).toFixed(2)}`;
}

function limitar(t, n) {
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// `anexoSistema` do orquestrador (vai para --append-system-prompt; ≤ 20000).
export function anexoOrquestrador(esc, { raizOrbit } = {}) {
  const pasta = barras(esc.pasta);
  const membro = `node "${barras(raizOrbit || '.')}/membro.mjs"`;
  const o = esc.orquestrador || {};
  const lim = esc.convidados?.limite ?? 0;
  const orc = esc.orcamento || {};
  const linhas = [
    `# Escritório "${esc.nome}": você é o ${o.nome || 'Orquestrador'}`,
    '',
    `Função do escritório: ${esc.funcao || '(sem descrição)'}`,
    `Pasta de trabalho: ${pasta}`,
    '',
    '## Seu papel',
    o.prompt?.trim() ? o.prompt.trim() : 'Coordene o time, divida o trabalho, confira as entregas e devolva o resultado final ao usuário.',
    '',
    '## Seu time (membros fixos)',
    listaMembros(esc),
    '',
    '## Como usar os membros',
    'Use o Bash (ou PowerShell). O id do membro é o da lista acima.',
    `- Enviar uma tarefa: ${membro} enviar <membro> "<tarefa>" (o membro nasce na 1ª tarefa e é reaproveitado nesta execução).`,
    `- Esperar o fim: ${membro} esperar <membro> [--max segundos] (imprime a resposta do membro).`,
    `- Ver o estado: ${membro} estado [<membro>]`,
    `- Listar o time: ${membro} lista`,
    'Códigos de saída: 0 ok · 1 erro de uso/servidor · 2 o membro deu erro ou foi interrompido · 3 o membro espera aprovação do usuário · 4 tempo esgotado · 5 escritório pausado (pare e entregue o que tem).',
    'Quando um membro concluir, o Orbit também avisa você numa mensagem ("Membro <id> concluiu: ...").',
    '',
    '## Convidados',
    lim > 0
      ? `Para ajuda pontual, use subagentes pela ferramenta Agent, no máximo ${lim} ao mesmo tempo. Acima disso o Orbit nega a chamada. Os membros não criam convidados.`
      : 'O limite de convidados deste escritório é 0: não crie subagentes pela ferramenta Agent.',
    '',
    '## Regras de liderança',
    '- Uma entrega por membro: objetivo claro, arquivos envolvidos e critério de "pronto" verificável. Duas tarefas diferentes nunca vão para o mesmo membro ao mesmo tempo.',
    `- Teto de ${TETO_CONTEXTO_MEMBRO} de contexto por membro: divida antes de delegar o que exige ler muita coisa.`,
    `- Cada membro mantém um arquivo curto de progresso em ${pasta}/_progresso/<membro>.md (objetivo, pronto, feito, falta, decisões), substituído a cada etapa. Peça isso na tarefa e leia esse arquivo em vez de pedir relatos longos.`,
    '- Cada membro devolve a você no máximo 5 linhas; detalhes ficam em arquivo.',
    `- Cada membro guarda a memória do papel em ${pasta}/notas/<membro>.md (lê no início, atualiza no fim).`,
    '- Seu contexto é o mais caro: nunca peça "relate tudo". Responda ao usuário em português.',
    '',
    '## Ação externa exige aprovação',
    'Toda ação externa (publicar, enviar mensagem ou e-mail, fazer deploy, abrir PR, chamar API que altera algo, gastar dinheiro ou créditos) pede a aprovação do usuário. O Orbit mostra o pedido a ele; não tente contornar nem repetir de outra forma se for negado.',
    '',
    '## Orçamento',
    `Limite por execução: ${brl(orc.porExecucaoUsd ?? 2)}; limite por dia: ${brl(orc.porDiaUsd ?? 10)}. Em ${orc.avisoPct ?? 80}% o Orbit avisa você: feche e entregue o que já tem. Em 100% o Orbit pausa tudo (execução e membros).`,
  ];
  return limitar(linhas.join('\n'), MAX_ANEXO);
}

// `anexoSistema` de um membro.
// Membro do Codex (`codex` = { execucao, porta }): o Codex não tem variáveis de ambiente por thread, então o que o Claude
// recebe em ORBIT_* vai aqui como texto.
export function anexoMembro(esc, membro, codex = null) {
  const pasta = barras(esc.pasta);
  const linhas = [
    `# Escritório "${esc.nome}": você é ${membro.nome} (papel: ${membro.papel}, id \`${membro.id}\`)`,
    '',
    `Função do escritório: ${esc.funcao || '(sem descrição)'}`,
    `Pasta de trabalho: ${pasta}`,
    '',
    '## Seu papel',
    membro.prompt?.trim() ? membro.prompt.trim() : `Cumpra a tarefa recebida do ${esc.orquestrador?.nome || 'Orquestrador'} dentro do seu papel.`,
    '',
    '## Memória do papel',
    `- No INÍCIO de cada tarefa, leia ${pasta}/notas/${membro.id}.md, se existir.`,
    `- No FIM, atualize esse arquivo com o que vale lembrar da próxima vez (curto, substituindo o que ficou velho).`,
    '',
    '## Progresso',
    `Mantenha ${pasta}/_progresso/${membro.id}.md com: objetivo, critério de pronto, o que já foi feito, o que falta e decisões. Atualize ao fim de cada etapa, em poucas linhas, substituindo o conteúdo.`,
    `Teto de ${TETO_CONTEXTO_MEMBRO} de contexto: Grep e leitura por trechos; se estiver perto do teto, atualize o progresso e avise.`,
    '',
    '## Retorno',
    `Devolva ao ${esc.orquestrador?.nome || 'Orquestrador'} no máximo 5 linhas: o que fez, se o critério de pronto foi atingido e qualquer pendência. Detalhes ficam em arquivo.`,
    '',
    '## Regras',
    codex
      ? '- Você faz uma entrega por tarefa. Não crie subagentes. MCP, plugins e rede ficam desligados neste escritório.'
      : '- Você faz uma entrega por tarefa. Não crie subagentes (a ferramenta Agent é negada para membros).',
    '- Toda ação externa (publicar, enviar, fazer deploy, gastar) pede a aprovação do usuário: o Orbit mostra o pedido a ele; não tente contornar.',
    '- Responda em português.',
  ];
  if (codex) {
    linhas.push('', '## Ambiente do escritório', 'Dados do Orbit para este escritório (o Codex não usa variáveis de ambiente por thread):',
      ...Object.entries(ambienteDe(esc, codex.execucao, membro.id, codex.porta)).map(([k, v]) => `- ${k}=${v}`));
  }
  return limitar(linhas.join('\n'), MAX_ANEXO);
}

// Caminho no formato de regra de permissão do claude (`//` = absoluto; no Windows `D:\x` vira `//d/x`).
function caminhoDeRegra(abs) {
  return '/' + barras(abs).replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());
}

export const MATCHER_HOOK = 'Bash|PowerShell|Monitor|Write|Edit|MultiEdit|NotebookEdit|Agent|Task|mcp__.*';

// `configuracao` (--settings) de toda instância de escritório (contrato §6 e §11).
// - `disableAllHooks:false`: o --settings vale mais que o settings.local da pasta, então o membro não desliga a trava;
// - comando com o node que roda o Orbit (`process.execPath`), sem depender do PATH (app aberto pelo Finder);
// - `permissions.allow` exato: só o membro.mjs do Orbit e a escrita em notas/** e _progresso/** da pasta do escritório.
export function configuracaoHook(raizOrbit, pastaEscritorio) {
  const raiz = barras(raizOrbit);
  const allow = [`Bash(node "${raiz}/membro.mjs":*)`];
  if (texto(pastaEscritorio) && pastaEscritorio) {
    for (const sub of ['notas', '_progresso']) {
      const alvo = caminhoDeRegra(path.join(pastaEscritorio, sub)) + '/**';
      allow.push(`Write(${alvo})`, `Edit(${alvo})`);
    }
  }
  return {
    disableAllHooks: false,
    hooks: {
      PreToolUse: [
        {
          matcher: MATCHER_HOOK,
          hooks: [{ type: 'command', command: `"${barras(process.execPath)}" "${raiz}/escritorio-hook.mjs"` }],
        },
      ],
    },
    permissions: { allow },
  };
}

// Variáveis ORBIT_* de cada instância (contrato §6).
export function ambienteDe(esc, execucao, papel, porta) {
  return {
    ORBIT_ESCRITORIO: esc.id,
    ORBIT_EXECUCAO: execucao,
    ORBIT_PAPEL: papel,
    ORBIT_PORTA: String(porta),
    ORBIT_EXTERNAS: JSON.stringify(esc.externas?.extras || []),
  };
}

// ───────────────────────── Fábrica ─────────────────────────

export function criarEscritorios(deps) {
  const {
    pasta, raizOrbit, porta = 47821, lerJSONCorpo, log = () => {}, publicar = () => {}, alertar = () => {},
    sessao = () => null, usoPlano = () => null, validarModelo, controle, relogio = () => new Date(),
    atrasoFim = 1500, vigiaMs = 1500, prazoMin = PRAZO_MIN_PADRAO, notificarCelular, home = os.homedir(),
    // Membros do Codex (B1b): codex() → ponte JS do Codex (codex.ponte) ou null se desligado; codexAtivo() → boolean (padrão: há
    // ponte); validarModeloCodex(modelo, esforco) → true | false | texto de erro | { modelo, esforco }; precosCodex = objeto (ou
    // função que o devolve) com as sobrescritas de config.escritorios.precosCodex; esperarCodex() → Promise (a reidratação espera
    // o módulo do Codex subir antes de listar os threads); tetoEscritorios = teto de instâncias vivas (Claude + Codex).
    codex: obterCodex, codexAtivo, validarModeloCodex, precosCodex, esperarCodex, tetoEscritorios, esperaCodexMs = 20000, usoMs = 1000,
    // C3: vigia dos membros do Codex (Acao do envio que falha, turno que sumiu, ponte que liga/desliga): intervalo e tempo sem turno
    // aberto (com o membro "trabalhando") até dá-lo por perdido.
    codexMs = 1000, semTurnoMs = 3000,
  } = deps;
  // tetoEscritorios: inteiro ou função (o servidor passa uma função que lê o config mesclado a cada uso)
  const tetoAtual = () => {
    let t = tetoEscritorios;
    if (typeof t === 'function') { try { t = t(); } catch { t = null; } }
    return Number.isInteger(t) && t >= 0 ? t : TETO_ESCRITORIOS_PADRAO;
  };
  void alertar; // F2: os alertas saem pelo SSE `escritorio` (campo `alerta`) e por `notificarCelular`; `alertar` não é mais usado

  const arquivoDe = (id) => path.join(pasta, id + '.json');
  const arquivoEstado = (id) => path.join(pasta, id + '.estado.json');

  // fila global só para o disco (CRUD); as execuções têm a trava de cada escritório.
  let filaDisco = Promise.resolve();
  function emFila(fn) {
    const p = filaDisco.then(() => fn());
    filaDisco = p.catch(() => {});
    return p;
  }

  const rts = new Map(); // id do escritório → estado de execução na memória
  const sessaoDe = new Map(); // id da sessão → { esc, execucao, papel }
  const dias = new Map(); // id → { dia, diaUsd, estimado? } (espelho do <id>.estado.json)
  const pendentes = new Set();
  const codexIds = new Set(); // sessões que são threads do Codex (membros); o resto é instância do Claude
  const codexModelo = new Map(); // sessão do Codex → modelo pedido (quando o ouvirFim não traz o modelo real)

  // Ponte do Codex (sem HTTP). O `ouvirFim` é assinado na 1ª vez que a ponte aparece (ou quando ela troca).
  let ponteOuvida = null;
  let desligarFimCodex = null;
  let desligarUsoCodex = null;
  const usoPorSessao = new Map(); // sessão do Codex → { ultimo: ms da última checagem, pendente: evento, timer }
  let parado = false;
  const vinculadosCodex = new Set(); // P2-1: threads do Codex que ESTA instância já vinculou (ou encerrou); zera quando a ponte troca/some
  const acoesCodex = new Set(); // P1-4: { sid, a } = Acao 'mensagem' de membro Codex ainda em andamento (falha depois de aceita)
  const semTurno = new Map(); // P1-4: sid → desde quando o membro "trabalhando" não tem turno aberto no Codex
  let vagasReservadas = 0; // P2-4: criações/reaproveitamentos de thread do Codex em curso (contam no teto antes de existirem)
  function ponteCodex() {
    let p = null;
    try { p = typeof obterCodex === 'function' ? obterCodex() || null : null; } catch { p = null; }
    if (parado) return p;
    if (p !== ponteOuvida) {
      try { desligarFimCodex?.(); } catch { /* ok */ }
      try { desligarUsoCodex?.(); } catch { /* ok */ }
      desligarFimCodex = null;
      desligarUsoCodex = null;
      ponteOuvida = p;
      vinculadosCodex.clear();
      semTurno.clear();
      // P1-4 (Codex desligado no meio) e P2-1 (Codex que sobe tarde): depois da reidratação, em segundo plano
      queueMicrotask(() => { if (!parado) rastrear(pronto.then(() => aoMudarPonte(p)).catch((e) => log('escritorios: ponte do Codex mudou:', e?.message || e))); });
      if (p && typeof p.ouvirFim === 'function') {
        try { desligarFimCodex = p.ouvirFim(aoFimCodex); } catch (e) { log('escritorios: ouvirFim do Codex falhou:', e?.message || e); }
      }
      if (p && typeof p.ouvirUso === 'function') {
        try { desligarUsoCodex = p.ouvirUso(aoUsoCodex); } catch (e) { log('escritorios: ouvirUso do Codex falhou:', e?.message || e); }
      }
    }
    return p;
  }
  function codexLigado() {
    if (typeof codexAtivo === 'function') { try { return !!codexAtivo(); } catch { return false; } }
    return !!ponteCodex();
  }
  const tabelaPrecos = () => {
    let extra = precosCodex;
    if (typeof extra === 'function') { try { extra = extra(); } catch { extra = null; } }
    return tabelaPrecosCodex(extra);
  };

  function rtDe(id) {
    let rt = rts.get(id);
    if (!rt) {
      rt = { exec: null, ultimos: {}, cobrados: {}, avisos: { execucao: false, dia: null }, ocupados: new Set(), estados: {}, resumos: {}, encerrados: new Set(), erroOrq: false, timerFim: null, timerPrazo: null, convs: new Map(), gravando: Promise.resolve(), trava: Promise.resolve() };
      rts.set(id, rt);
    }
    return rt;
  }

  // Serializa as operações de um escritório e registra a promessa em `pendentes` (para o teste esperar).
  function naTrava(id, fn) {
    const rt = rtDe(id);
    const p = rt.trava.then(() => fn());
    rt.trava = p.catch(() => {});
    return rastrear(p);
  }

  function rastrear(p) {
    pendentes.add(p);
    const tira = () => pendentes.delete(p);
    p.then(tira, tira);
    return p;
  }

  async function aguardar() {
    while (pendentes.size) await Promise.allSettled([...pendentes]);
  }

  // ── disco ──
  async function gravarArquivo(alvo, dado) {
    await fsp.mkdir(pasta, { recursive: true });
    const tmp = `${alvo}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    const t = JSON.stringify(dado);
    try {
      await fsp.writeFile(tmp, t, 'utf8');
      await fsp.rename(tmp, alvo);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      log('escritorios: gravação atômica falhou, gravando direto:', e.code || e.message);
      await fsp.writeFile(alvo, t, 'utf8');
    }
  }

  function validarId(id) {
    if (typeof id !== 'string' || !ID_OK.test(id)) throw erro(400, 'id inválido');
    return id;
  }

  async function ler(id) {
    validarId(id);
    let bruto;
    try {
      bruto = await fsp.readFile(arquivoDe(id), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') throw erro(404, 'escritório não encontrado');
      throw e;
    }
    try {
      const e = JSON.parse(bruto);
      if (!e || typeof e !== 'object' || !Array.isArray(e.membros)) throw new Error('formato');
      return e;
    } catch {
      throw erro(500, 'escritório ilegível');
    }
  }

  async function todos() {
    let nomes = [];
    try { nomes = await fsp.readdir(pasta); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const lista = [];
    for (const n of nomes) {
      if (!n.endsWith('.json')) continue;
      const id = n.slice(0, -5);
      if (!ID_OK.test(id)) continue; // ignora <id>.estado.json e estranhos
      try { lista.push(await ler(id)); } catch { /* arquivo estranho */ }
    }
    return lista;
  }

  async function diaDe(id) {
    let d = dias.get(id);
    if (!d) {
      d = { dia: diaLocal(relogio()), diaUsd: 0 };
      try {
        const lido = JSON.parse(await fsp.readFile(arquivoEstado(id), 'utf8'));
        if (lido && texto(lido.dia) && num(lido.diaUsd)) d = { dia: lido.dia, diaUsd: lido.diaUsd, ...(lido.estimado ? { estimado: true } : {}) };
      } catch { /* sem estado ainda */ }
      dias.set(id, d);
    }
    const hoje = diaLocal(relogio());
    if (d.dia !== hoje) { d.dia = hoje; d.diaUsd = 0; delete d.estimado; }
    return d;
  }

  // Estado em disco (<id>.estado.json): gasto do dia + a execução (P0-2), para reidratar depois de um reinício.
  function instantaneo(id, rt, d) {
    const snap = { dia: d.dia, diaUsd: d.diaUsd, ...(d.estimado ? { estimado: true } : {}) };
    if (rt?.exec) {
      snap.exec = JSON.parse(JSON.stringify(rt.exec));
      snap.rt = {
        ocupados: [...rt.ocupados], estados: { ...rt.estados }, resumos: { ...rt.resumos }, encerrados: [...rt.encerrados],
        erroOrq: !!rt.erroOrq, avisos: { ...rt.avisos }, ultimos: { ...rt.ultimos }, cobrados: JSON.parse(JSON.stringify(rt.cobrados || {})),
      };
      snap.sessoes = {};
      for (const [sid, m] of sessaoDe) if (m.esc === id) snap.sessoes[sid] = { execucao: m.execucao, papel: m.papel, ...(codexIds.has(sid) ? { provedor: 'codex' } : {}) };
    }
    return snap;
  }

  // Grava o estado do escritório (fila por escritório; o teste espera por `aguardar`). Não recria o arquivo de um excluído.
  function persistir(id) {
    const rt = rts.get(id);
    if (!rt) return Promise.resolve();
    const p = rt.gravando = rt.gravando.then(async () => {
      if (rts.get(id) !== rt) return;
      const d = await diaDe(id);
      if (!rt.exec && !(d.diaUsd > 0)) return; // nada a guardar
      await gravarArquivo(arquivoEstado(id), instantaneo(id, rt, d));
    }).catch((e) => log('escritorios: estado:', e?.message || e));
    return rastrear(p);
  }

  // ── validação (contrato §1) ──
  const real = async (p) => { try { return await fsp.realpath(p); } catch { return path.resolve(p); } };
  const chaveCaminho = (p) => { const r = path.resolve(p).replace(/[\\/]+$/, ''); return process.platform === 'win32' ? r.toLowerCase() : r; };
  const ancestralOuIgual = (a, b) => { // `a` é `b` ou uma pasta acima dele
    const rel = path.relative(chaveCaminho(a), chaveCaminho(b));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };

  // P1-1/P2-4: realpath; recusa a raiz do disco, a home, a raiz do Orbit, o DADOS e os ancestrais deles
  // (a pasta virar o cwd e receber notas/ e _progresso/; num ancestral o membro alcançaria o hook e o dado do Orbit).
  async function pastaValida(p) {
    if (!texto(p) || !p.trim() || !path.isAbsolute(p.trim())) throw erro(400, 'A pasta deve ser um caminho absoluto.');
    const r = p.trim();
    let st;
    try { st = await fsp.stat(r); } catch { throw erro(400, `A pasta "${r}" não existe.`); }
    if (!st.isDirectory()) throw erro(400, `"${r}" não é uma pasta.`);
    const rr = await real(r);
    if (path.parse(rr).root.replace(/[\\/]+$/, '').toLowerCase() === rr.replace(/[\\/]+$/, '').toLowerCase()) throw erro(400, 'Escolha uma pasta de trabalho, não a raiz do disco.');
    const protegidos = [
      [home, 'a sua pasta pessoal'],
      [raizOrbit, 'a pasta do Orbit'],
      [path.dirname(pasta), 'a pasta de dados do Orbit'],
      [pasta, 'a pasta dos escritórios'],
    ];
    for (const [alvo, rotulo] of protegidos) {
      if (!alvo) continue;
      for (const cand of new Set([path.resolve(alvo), await real(alvo)])) {
        if (ancestralOuIgual(rr, cand)) throw erro(400, `A pasta "${r}" é ${rotulo} ou contém ${rotulo}: escolha uma pasta de trabalho dentro do projeto.`);
      }
    }
    return rr;
  }

  function nomeCampo(v, rotulo, max, { vazioOk = false, padrao } = {}) {
    if (v === undefined || v === null || v === '') {
      if (padrao !== undefined) return padrao;
      if (vazioOk) return '';
      throw erro(400, `${rotulo} é obrigatório.`);
    }
    if (!texto(v)) throw erro(400, `${rotulo} deve ser texto.`);
    const t = limparLinha(v);
    if (!t) {
      if (padrao !== undefined) return padrao;
      if (vazioOk) return '';
      throw erro(400, `${rotulo} é obrigatório.`);
    }
    if (t.length > max) throw erro(400, `${rotulo} pode ter até ${max} caracteres.`);
    return t;
  }

  function promptCampo(v, rotulo) {
    if (v === undefined || v === null) return '';
    if (!texto(v)) throw erro(400, `${rotulo} deve ser texto.`);
    if (v.length > MAX_PROMPT) throw erro(400, `${rotulo} pode ter até ${MAX_PROMPT} caracteres.`);
    return v.replace(/\u0000/g, '');
  }

  // `validador` (opcional): o do Codex no lugar do `validarModelo` do Claude. Pode devolver { modelo, esforco } normalizados.
  async function modeloCampo(modelo, esforco, rotulo, validador = validarModelo) {
    for (const [k, v] of [['modelo', modelo], ['esforço', esforco]]) {
      if (v !== undefined && v !== null && !texto(v)) throw erro(400, `O ${k} de ${rotulo} deve ser texto.`);
    }
    let m = (modelo || '').trim();
    let e = (esforco || '').trim();
    if (!m && !e) return { modelo: '', esforco: '' };
    if (m.length > 100 || e.length > 20) throw erro(400, `Modelo/esforço de ${rotulo} inválidos.`);
    if (typeof validador === 'function') {
      let r;
      try { r = await validador(m, e); } catch (x) { throw erro(400, x?.message || `Modelo/esforço de ${rotulo} inválidos.`); }
      if (r === false) throw erro(400, `Modelo/esforço de ${rotulo} inválidos.`);
      if (texto(r) && r) throw erro(400, r);
      if (r && typeof r === 'object' && texto(r.modelo) && texto(r.esforco)) { m = r.modelo; e = r.esforco; }
    }
    return { modelo: m, esforco: e };
  }

  function objeto(v, rotulo) {
    if (v === undefined || v === null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) throw erro(400, `${rotulo} deve ser um objeto.`);
    return v;
  }

  // Monta a definição completa a partir de `base` (valores atuais ou padrões) + `corpo` (o que o cliente enviou).
  async function montar(base, corpo) {
    const out = { id: base.id, versao: 1, criado: base.criado, atualizado: agora() };
    out.nome = nomeCampo(corpo.nome ?? base.nome, 'O nome', MAX_NOME);
    out.funcao = nomeCampo(corpo.funcao ?? base.funcao, 'A função', MAX_FUNCAO, { vazioOk: true });
    out.pasta = await pastaValida(corpo.pasta ?? base.pasta);

    const c = objeto(corpo.canvas, 'canvas');
    const cb = base.canvas || { x: 0, y: 0 };
    const cx = c.x ?? cb.x, cy = c.y ?? cb.y;
    if (!num(cx) || !num(cy)) throw erro(400, 'canvas inválido.');
    out.canvas = { x: cx, y: cy };

    const o = { ...(base.orquestrador || {}), ...objeto(corpo.orquestrador, 'orquestrador') };
    out.orquestrador = {
      nome: nomeCampo(o.nome, 'O nome do orquestrador', MAX_NOME_PAPEL, { padrao: 'Orquestrador' }),
      prompt: promptCampo(o.prompt, 'O prompt do orquestrador'),
      ...(await modeloCampo(o.modelo, o.esforco, 'o orquestrador')),
    };
    if (o.provedor !== undefined && o.provedor !== null && o.provedor !== 'claude') throw erro(400, 'O líder do escritório é sempre do Claude: só os membros podem ser do Codex.');

    const lista = corpo.membros !== undefined ? corpo.membros : base.membros || [];
    if (!Array.isArray(lista)) throw erro(400, 'membros deve ser uma lista.');
    if (lista.length > MAX_MEMBROS) throw erro(400, `Um escritório tem até ${MAX_MEMBROS} membros.`);
    const ids = new Set();
    out.membros = [];
    for (const m of lista) {
      if (!m || typeof m !== 'object' || Array.isArray(m)) throw erro(400, 'membro inválido.');
      if (!texto(m.id) || !SLUG_OK.test(m.id)) throw erro(400, 'O id do membro deve ter 1–30 caracteres entre a-z, 0-9 e hífen.');
      if (m.id === PAPEL_ORQUESTRADOR) throw erro(400, `O id "${PAPEL_ORQUESTRADOR}" é reservado.`);
      if (ids.has(m.id)) throw erro(400, `Id de membro repetido: ${m.id}.`);
      ids.add(m.id);
      const antes = (base.membros || []).find((x) => x && x.id === m.id);
      const provedor = m.provedor === undefined || m.provedor === null ? (antes?.provedor === 'codex' ? 'codex' : 'claude') : m.provedor;
      if (provedor !== 'claude' && provedor !== 'codex') throw erro(400, "O provedor do membro deve ser 'claude' ou 'codex'.");
      const papel = nomeCampo(m.papel, `O papel de ${m.id}`, MAX_NOME_PAPEL);
      const nome = nomeCampo(m.nome, `O nome de ${m.id}`, MAX_NOME_PAPEL, { padrao: papel });
      const prompt = promptCampo(m.prompt, `O prompt de ${m.id}`);
      let mod;
      if (provedor === 'codex') {
        // Membro do Codex novo ou que mudou de modelo/esforço: exige o Codex ligado e o modelo na lista dele (model/list).
        // Membro que continua igual passa direto: renomear/mover no canvas não depende do Codex estar ligado.
        const igual = antes?.provedor === 'codex' && (antes.modelo || '') === (texto(m.modelo) ? m.modelo.trim() : '') && (antes.esforco || '') === (texto(m.esforco) ? m.esforco.trim() : '');
        if (igual) mod = { modelo: antes.modelo || '', esforco: antes.esforco || '' };
        else {
          if (!codexLigado()) throw erro(400, MSG_CODEX_DESLIGADO);
          mod = await modeloCampo(m.modelo, m.esforco, `o membro ${m.id}`, validarModeloCodex);
          // P2-5: modelo fora da tabela de preços não tem como ser orçado → o preço vem de config.escritorios.precosCodex
          if (mod.modelo && !modeloTemPreco(mod.modelo, tabelaPrecos())) {
            throw erro(400, `O modelo ${mod.modelo} não tem preço na tabela do Codex: informe-o em config.escritorios.precosCodex ({ "${mod.modelo}": { entrada, cacheEntrada, saida } }, US$ por milhão de tokens) para poder orçar o escritório.`);
          }
        }
      } else {
        mod = await modeloCampo(m.modelo, m.esforco, `o membro ${m.id}`);
      }
      out.membros.push({ id: m.id, papel, nome, prompt, provedor, ...mod });
    }

    const cv = { ...(base.convidados || {}), ...objeto(corpo.convidados, 'convidados') };
    const lim = cv.limite === undefined || cv.limite === null ? 2 : cv.limite;
    if (!Number.isInteger(lim) || lim < 0 || lim > MAX_CONVIDADOS) throw erro(400, `O limite de convidados vai de 0 a ${MAX_CONVIDADOS}.`);
    out.convidados = { limite: lim };

    const ob = { ...(base.orcamento || {}), ...objeto(corpo.orcamento, 'orcamento') };
    const pos = (v, padrao, rot) => {
      const x = v === undefined || v === null ? padrao : v;
      if (!num(x) || x <= 0 || x > 100000) throw erro(400, `${rot} deve ser maior que zero.`);
      return x;
    };
    const aviso = ob.avisoPct === undefined || ob.avisoPct === null ? 80 : ob.avisoPct;
    if (!num(aviso) || aviso < 50 || aviso > 95) throw erro(400, 'O aviso de orçamento vai de 50% a 95%.');
    out.orcamento = {
      porExecucaoUsd: pos(ob.porExecucaoUsd, 2, 'O orçamento por execução'),
      porDiaUsd: pos(ob.porDiaUsd, 10, 'O orçamento por dia'),
      avisoPct: aviso,
    };

    const ex = { ...(base.externas || {}), ...objeto(corpo.externas, 'externas') };
    const extras = ex.extras === undefined || ex.extras === null ? [] : ex.extras;
    if (!Array.isArray(extras) || extras.length > MAX_EXTRAS) throw erro(400, `externas.extras deve ser uma lista de até ${MAX_EXTRAS} textos.`);
    for (const p of extras) {
      if (!texto(p) || !p || p.length > MAX_REGEX) throw erro(400, `Cada texto de ação externa tem de 1 a ${MAX_REGEX} caracteres.`);
    }
    out.externas = { extras: [...extras] };
    return out;
  }

  const PADRAO = { nome: undefined, funcao: '', canvas: { x: 0, y: 0 }, membros: [] };

  function novoId(usados) {
    let id;
    do id = crypto.randomBytes(6).toString('hex');
    while (usados.has(id));
    return id;
  }

  function nomeLivre(base, existentes) {
    const usados = new Set(existentes.map((q) => q.nome));
    if (!usados.has(base)) return base;
    for (let n = 2; ; n++) {
      const c = `${encurtar(base, MAX_NOME - String(n).length - 1)} ${n}`;
      if (!usados.has(c)) return c;
    }
  }

  // ── resumo, público e eventos ──
  function custoPublico(esc, rt, d) {
    const c = rt.exec?.custo;
    return {
      execucaoUsd: c ? c.execucaoUsd : 0,
      diaUsd: c && c.dia === diaLocal(relogio()) ? Math.max(c.diaUsd, d?.diaUsd ?? 0) : d?.diaUsd ?? 0,
      limiteExecucaoUsd: esc.orcamento.porExecucaoUsd,
      limiteDiaUsd: esc.orcamento.porDiaUsd,
      planoPct: c ? planoPctDe(c) : 0,
      // parcela do Codex: valor estimado por tokens × preço (o front mostra "≈"); semPreco = modelos cobrados pelo preço mais alto
      // P2-11: a execução e o dia se estimam em separado (o dia pode ter Codex de outra execução); `estimado` = OU dos dois
      ...(c?.estimado ? { estimadoExecucao: true } : {}),
      ...(d?.estimado || (c?.estimado && c.dia === diaLocal(relogio())) ? { estimadoDia: true } : {}),
      ...(c?.estimado || d?.estimado ? { estimado: true } : {}),
      ...(c?.semPreco?.length ? { semPreco: [...c.semPreco] } : {}),
    };
  }

  // Estado de um agente para o resumo: trabalhando | aguardando | ocioso | erro | dormindo.
  // Sem execução, sem sessão, membro encerrado ou processo dormindo no controle = dormindo.
  function estadoAgente(rt, papel, sid) {
    if (!rt.exec) return 'dormindo';
    const doOrq = papel === PAPEL_ORQUESTRADOR;
    if (!sid) return !doOrq && rt.estados[papel] === 'erro' ? 'erro' : 'dormindo'; // tarefa que falhou antes de criar o thread
    if (!doOrq && rt.encerrados.has(papel)) return 'dormindo';
    try { if (estadoDe(sid)?.processo === 'dormindo') return 'dormindo'; } catch { /* sem controle */ }
    const rodando = rt.exec.status === 'rodando';
    const ocupado = doOrq ? rodando && rt.ocupados.has(papel) : rt.estados[papel] === 'trabalhando' || rt.estados[papel] === 'aguardando';
    if (ocupado) return aguardandoAprovacao(sid) ? 'aguardando' : 'trabalhando';
    if (doOrq ? rt.erroOrq : rt.estados[papel] === 'erro') return 'erro';
    return 'ocioso';
  }

  // Subagentes (ferramenta Agent) ativos agora no orquestrador da execução em curso.
  function convidadosAtivos(rt) {
    if (rt.exec?.status !== 'rodando' || !rt.exec.orquestrador) return 0;
    try {
      const ags = sessao(rt.exec.orquestrador)?.agentes;
      return Array.isArray(ags) ? ags.filter((a) => a && (a.status === 'trabalhando' || a.status === 'aguardando')).length : 0;
    } catch { return 0; }
  }

  function resumoDe(esc) {
    const rt = rtDe(esc.id);
    const d = dias.get(esc.id);
    return {
      id: esc.id,
      nome: esc.nome,
      funcao: esc.funcao,
      ...(esc.criado ? { criado: esc.criado } : {}), // o canvas ordena por ele os escritórios sem posição
      membros: esc.membros.length,
      status: rt.exec?.status || 'ociosa',
      ativos: rt.exec?.status === 'rodando' ? rt.ocupados.size : 0,
      canvas: { x: esc.canvas?.x ?? 0, y: esc.canvas?.y ?? 0 },
      agentes: [
        { id: PAPEL_ORQUESTRADOR, nome: esc.orquestrador?.nome || 'Orquestrador', papel: 'Orquestrador', provedor: 'claude', estado: estadoAgente(rt, PAPEL_ORQUESTRADOR, rt.exec?.orquestrador) },
        ...esc.membros.map((m) => ({ id: m.id, nome: m.nome || m.papel, papel: m.papel, provedor: m.provedor || 'claude', estado: estadoAgente(rt, m.id, rt.exec?.membros?.[m.id]) })),
      ],
      convidados: convidadosAtivos(rt),
      custo: custoPublico(esc, rt, d && d.dia === diaLocal(relogio()) ? d : null),
      ...(rt.exec?.status === 'pausada' && rt.exec.motivoPausa ? { motivoPausa: rt.exec.motivoPausa } : {}),
    };
  }

  function execucaoPublica(esc) {
    const rt = rtDe(esc.id);
    const d = dias.get(esc.id);
    if (!rt.exec) {
      return {
        status: 'ociosa', membros: {}, estados: {},
        custo: { execucaoUsd: 0, diaUsd: d && d.dia === diaLocal(relogio()) ? d.diaUsd : 0, dia: diaLocal(relogio()), planoPctInicio: null, planoPctAgora: null },
      };
    }
    return { ...rt.exec, membros: { ...rt.exec.membros }, custo: { ...rt.exec.custo }, estados: { ...rt.estados } };
  }

  // `alerta` ({tipo:'aviso'|'pausa', texto}) vai junto no evento: o servidor/painel mostram (F4); o estado vai ao disco.
  function emitir(esc, alerta) {
    try {
      const resumo = resumoDe(esc);
      const rt = rtDe(esc.id);
      rt.escVisto = esc;
      rt.resumoVisto = JSON.stringify(resumo);
      publicar('escritorio', { id: esc.id, resumo, ...(alerta ? { alerta } : {}) });
    } catch (e) { log('escritorios: publicar:', e?.message || e); }
    persistir(esc.id);
  }

  // Estados de agentes e subagentes mudam fora do runtime (sessões, aprovações): enquanto há execução rodando,
  // confere de tempos em tempos e só publica quando o resumo mudou de fato (sem gravar em disco).
  function vigiar() {
    for (const [id, rt] of rts) {
      if (rt.exec?.status !== 'rodando' || !rt.escVisto) continue;
      try {
        const resumo = resumoDe(rt.escVisto);
        const txt = JSON.stringify(resumo);
        if (txt === rt.resumoVisto) continue;
        rt.resumoVisto = txt;
        publicar('escritorio', { id, resumo });
      } catch (e) { log('escritorios: vigia:', e?.message || e); }
    }
  }
  const timerVigia = vigiaMs > 0 ? setInterval(vigiar, vigiaMs) : null;
  timerVigia?.unref?.();

  // ── controle ──
  // As sessões do Codex falam com a ponte (sem HTTP); as do Claude, com o controle. O resto do arquivo não distingue.
  const OPS_CODEX = {
    interromper: (p, id) => p.interromper(id),
    encerrar: (p, id) => p.encerrar(id),
    // P1-4: o envio é dispara-e-esquece na ponte (a falha vem na Acao, depois de aceito): a vigia do Codex confere a Acao
    enviarMensagem: (p, id, texto) => {
      const a = p.enviar(id, texto);
      if (a && typeof a === 'object' && 'estado' in a) acoesCodex.add({ sid: id, a });
      return true;
    },
    adormecer: () => true, // o app-server é um só: não há processo por thread para fechar
  };
  async function chamarControle(nome, ...args) {
    if (codexIds.has(args[0]) && OPS_CODEX[nome]) {
      const p = ponteCodex();
      if (!p) throw erro(503, MSG_CODEX_DESLIGADO);
      return OPS_CODEX[nome](p, ...args);
    }
    const f = controle?.[nome];
    if (typeof f !== 'function') throw erro(500, `controle sem ${nome}`);
    return f.apply(controle, args);
  }
  async function tentar(nome, ...args) {
    try { return await chamarControle(nome, ...args); } catch (e) { log(`escritorios: ${nome} falhou:`, e?.message || e); return undefined; }
  }
  // Estado de controle da sessão (formato do controle.estado), do Claude ou do Codex.
  function estadoDe(id) {
    if (codexIds.has(id)) return ponteCodex()?.estado?.(id) || null;
    return controle?.estado?.(id) || null;
  }
  function ocupadaNoControle(id) {
    try { return !!estadoDe(id)?.ocupada; } catch { return false; }
  }
  function aguardandoAprovacao(id) {
    try {
      if (estadoDe(id)?.permissao) return true;
      return sessao(id)?.status === 'aguardando';
    } catch { return false; }
  }

  function sessoesVivas(rt) {
    const ids = [];
    if (rt.exec?.orquestrador) ids.push(rt.exec.orquestrador);
    for (const [m, s] of Object.entries(rt.exec?.membros || {})) if (!rt.encerrados.has(m)) ids.push(s);
    return ids;
  }

  function planoAgora() {
    try {
      const p = usoPlano()?.cincoHoras?.pct;
      return num(p) ? p : null;
    } catch { return null; }
  }

  // ── custo e orçamento (§8) ──
  // Membro do Codex: o custo vem da DIFERENÇA de tokens em relação ao último total já cobrado DAQUELE thread (rt.cobrados, persistido
  // no estado do escritório), precificada com o modelo/preço de agora. Assim a mudança de geração (reinício do app-server/Orbit,
  // resume que semeia o total do rollout), de preço ou de modelo nunca cobra o acumulado de novo.
  function custoPorTokens(rt, sessaoId, codex) {
    const { delta, cobrado } = deltaTokens(rt.cobrados?.[sessaoId], codex.tokens);
    const mudou = CAMPOS_TOKENS.some((c) => cobrado[c] !== (rt.cobrados?.[sessaoId]?.[c] || 0));
    rt.cobrados = { ...(rt.cobrados || {}), [sessaoId]: cobrado };
    const c = custoCodexUsd(delta, codex.modelo === '(sem modelo)' ? '' : codex.modelo, tabelaPrecos());
    return { usd: c ? c.usd : 0, semPreco: !!c?.semPreco && !!codex.modelo, mudou, tinha: !!c };
  }

  async function contabilizar(esc, rt, m, sessaoId, custoUsd, geracao, codex = null) {
    let porTokens = null;
    if (codex?.tokens) { porTokens = custoPorTokens(rt, sessaoId, codex); custoUsd = porTokens.usd; codex = { ...codex, estimado: true, semPreco: porTokens.semPreco }; }
    const d = await diaDe(esc.id);
    const atual = !!rt.exec && rt.exec.execucao === m.execucao;
    const hoje = relogio();
    const base = atual
      ? { ...rt.exec.custo, diaUsd: d.dia === rt.exec.custo.dia ? Math.max(rt.exec.custo.diaUsd, d.diaUsd) : d.diaUsd }
      : { execucaoUsd: 0, diaUsd: d.diaUsd, dia: d.dia, planoPctInicio: null, planoPctAgora: null };
    // Codex: o delta de tokens já foi calculado acima (somarCusto com `ultimos` vazio soma o valor inteiro, sem chave por geração)
    const r = somarCusto({ custo: base, ultimos: porTokens ? {} : rt.ultimos }, sessaoId, custoUsd, { agora: hoje, planoPct: atual ? planoAgora() : null, geracao: porTokens ? null : geracao });
    if (!porTokens) rt.ultimos = r.ultimos;
    d.dia = r.custo.dia;
    d.diaUsd = r.custo.diaUsd;
    if (codex?.estimado) { // parcela do Codex: o total do dia e da execução passam a ser estimativa (≈)
      d.estimado = true;
      r.custo.estimado = true;
      if (codex.semPreco && codex.modelo) r.custo.semPreco = [...new Set([...(r.custo.semPreco || []), codex.modelo])];
    }
    if (atual) rt.exec.custo = r.custo;
    if (r.delta > 0 || porTokens?.mudou || (codex?.estimado && !porTokens)) await persistir(esc.id);
    return atual;
  }

  async function pausarInterno(esc, rt, motivo, urgente) {
    const exec = rt.exec;
    exec.status = 'pausada';
    exec.motivoPausa = motivo;
    clearTimeout(rt.timerFim);
    clearTimeout(rt.timerPrazo);
    const ids = sessoesVivas(rt);
    rt.ocupados.clear();
    for (const [m, st] of Object.entries(rt.estados)) if (st === 'trabalhando' || st === 'aguardando') rt.estados[m] = 'interrompida';
    for (const id of ids) await tentar('interromper', id);
    if (motivo !== 'manual') {
      // P1-5: nas pausas automáticas os membros são encerrados (renascem no próximo `enviar`): nada fica rodando em segundo plano
      for (const [m, s] of Object.entries(exec.membros)) {
        if (rt.encerrados.has(m)) continue;
        rt.encerrados.add(m);
        await tentar('encerrar', s);
      }
    }
    if (urgente) {
      const c = exec.custo;
      const msg = motivo === 'orcamento-dia'
        ? `Escritório "${esc.nome}" pausado: o orçamento do dia acabou (${brl(c.diaUsd)} de ${brl(esc.orcamento.porDiaUsd)}).`
        : motivo === 'tempo'
          ? `Escritório "${esc.nome}" pausado: passou o prazo máximo de ${prazoMin} min por execução.`
          : `Escritório "${esc.nome}" pausado: o orçamento da execução acabou (${brl(c.execucaoUsd)} de ${brl(esc.orcamento.porExecucaoUsd)}).`;
      emitir(esc, { tipo: 'pausa', texto: msg });
      try { notificarCelular?.(esc.id, esc.nome, msg); } catch (e) { log('escritorios: notificarCelular:', e?.message || e); }
    }
  }

  // P1-7: prazo máximo por execução (minutos, padrão 120) → pausa com motivo `tempo`.
  const prazoVencido = (exec) => prazoMin > 0 && relogio().getTime() - Date.parse(exec.prazoDesde || exec.inicio) >= prazoMin * 60000;

  function armarPrazo(id) {
    const rt = rtDe(id);
    clearTimeout(rt.timerPrazo);
    const exec = rt.exec;
    if (!exec || exec.status !== 'rodando' || !(prazoMin > 0)) return;
    const falta = Math.max(0, Date.parse(exec.prazoDesde || exec.inicio) + prazoMin * 60000 - relogio().getTime());
    rt.timerPrazo = setTimeout(() => { naTrava(id, () => vencerPrazo(id)).catch((e) => log('escritorios: prazo:', e?.message || e)); }, Math.min(Math.max(falta, 50), 2147483000));
    rt.timerPrazo.unref?.();
  }

  async function vencerPrazo(id) {
    const rt = rtDe(id);
    const exec = rt.exec;
    if (!exec || exec.status !== 'rodando') return;
    if (!prazoVencido(exec)) { armarPrazo(id); return; }
    let esc;
    try { esc = await ler(id); } catch { return; }
    await pausarInterno(esc, rt, 'tempo', true);
    emitir(esc);
  }

  async function aplicarOrcamento(esc, rt) {
    const exec = rt.exec;
    if (!exec || exec.status !== 'rodando') return;
    const a = avaliar(exec.custo, esc.orcamento, rt.avisos);
    rt.avisos = a.avisos;
    if (a.estourou) {
      await pausarInterno(esc, rt, a.estourou, true);
      return;
    }
    if (prazoVencido(exec)) {
      await pausarInterno(esc, rt, 'tempo', true);
      return;
    }
    for (const av of a.avisar) {
      const c = exec.custo;
      const msg = av.tipo === 'dia'
        ? `Escritório "${esc.nome}": ${av.pct}% do orçamento do dia (${brl(c.diaUsd)} de ${brl(esc.orcamento.porDiaUsd)}).`
        : `Escritório "${esc.nome}": ${av.pct}% do orçamento da execução (${brl(c.execucaoUsd)} de ${brl(esc.orcamento.porExecucaoUsd)}).`;
      emitir(esc, { tipo: 'aviso', texto: msg, aviso: av.tipo, pct: av.pct });
      const ok = await tentar('avisarLider', exec.orquestrador, `Orçamento em ${av.pct}%: feche e entregue o que já tem.`);
      if (ok) rt.ocupados.add(PAPEL_ORQUESTRADOR);
    }
  }

  // ── fim da execução (§2) ──
  function agendarFim(id) {
    const rt = rtDe(id);
    clearTimeout(rt.timerFim);
    if (!rt.exec || rt.exec.status !== 'rodando') return;
    if (!(atrasoFim > 0)) { naTrava(id, () => verificarFim(id)); return; }
    rt.timerFim = setTimeout(() => { naTrava(id, () => verificarFim(id)).catch((e) => log('escritorios: fim:', e?.message || e)); }, atrasoFim);
    rt.timerFim.unref?.();
  }

  async function verificarFim(id) {
    const rt = rtDe(id);
    const exec = rt.exec;
    if (!exec || exec.status !== 'rodando') return;
    if (rt.ocupados.size) return;
    if (ocupadaNoControle(exec.orquestrador)) return;
    for (const [m, s] of Object.entries(exec.membros)) if (!rt.encerrados.has(m) && ocupadaNoControle(s)) return;
    let esc;
    try { esc = await ler(id); } catch { return; }
    exec.status = rt.erroOrq ? 'erro' : 'concluida';
    exec.fim = agora();
    clearTimeout(rt.timerPrazo);
    for (const [m, s] of Object.entries(exec.membros)) {
      if (rt.encerrados.has(m)) continue;
      rt.encerrados.add(m);
      await tentar('encerrar', s);
    }
    emitir(esc);
  }

  // ── resultado de uma volta (controle.ouvirResultado) ──
  function aoResultado(sessaoId, r) {
    rastrear(pronto.then(() => {
      const m = sessaoDe.get(sessaoId);
      if (!m) return;
      return naTrava(m.esc, () => processarResultado(m, sessaoId, r || {}));
    }).catch((e) => log('escritorios: resultado:', e?.message || e)));
  }

  // Fim de turno de um membro do Codex (ponte.ouvirFim) → o mesmo caminho do result do Claude, com o custo estimado em US$
  // a partir dos tokens ACUMULADOS do thread (somarCusto soma só a diferença).
  function aoFimCodex(ev) {
    try {
      if (!ev || !codexIds.has(ev.sessao)) return;
      const modelo = ev.modelo || codexModelo.get(ev.sessao) || '';
      const tokens = ev.tokens && typeof ev.tokens === 'object' ? ev.tokens : null;
      aoResultado(ev.sessao, {
        custoUsd: null, geracao: ev.geracao, erro: !!ev.erro,
        texto: ev.erro ? `${ev.erro}${ev.texto ? ` — ${ev.texto}` : ''}` : ev.texto || '',
        ...(tokens ? { tokens, modelo: modelo || '(sem modelo)' } : {}),
      });
    } catch (e) { log('escritorios: fim do Codex:', e?.message || e); }
  }

  // Uso do thread (ponte.ouvirUso, a cada thread/tokenUsage/updated): soma o que ainda não foi cobrado e aplica aviso/pausa NA HORA,
  // sem esperar o fim do turno (corte no meio do turno). No máximo uma checagem por USO_MS por thread; o evento retido numa janela
  // roda no fim dela (o último uso nunca se perde). Também cobre o tokenUsage que chega depois do turn/completed.
  const USO_MS = Number.isFinite(usoMs) && usoMs >= 0 ? usoMs : 1000;
  function aoUsoCodex(ev) {
    try {
      if (parado || !ev || !codexIds.has(ev.sessao) || !ev.tokens) return;
      let u = usoPorSessao.get(ev.sessao);
      if (!u) { u = { ultimo: -Infinity, pendente: null, timer: null }; usoPorSessao.set(ev.sessao, u); }
      const agora = Date.now();
      if (u.timer || agora - u.ultimo < USO_MS) {
        u.pendente = ev;
        if (!u.timer) {
          u.timer = setTimeout(() => { u.timer = null; const e = u.pendente; u.pendente = null; if (e) checarUso(e); }, Math.max(1, USO_MS - (agora - u.ultimo)));
          u.timer.unref?.();
        }
        return;
      }
      u.ultimo = agora;
      checarUso(ev);
    } catch (e) { log('escritorios: uso do Codex:', e?.message || e); }
  }
  function checarUso(ev) {
    const u = usoPorSessao.get(ev.sessao);
    if (u) u.ultimo = Date.now();
    rastrear(pronto.then(() => {
      const m = sessaoDe.get(ev.sessao);
      if (!m) return;
      return naTrava(m.esc, () => processarUso(m, ev));
    }).catch((e) => log('escritorios: uso:', e?.message || e)));
  }
  async function processarUso(m, ev) {
    let esc;
    try { esc = await ler(m.esc); } catch { return; }
    const rt = rtDe(m.esc);
    const modelo = ev.modelo || codexModelo.get(ev.sessao) || '';
    const atual = await contabilizar(esc, rt, m, ev.sessao, null, ev.geracao, { tokens: ev.tokens, modelo: modelo || '(sem modelo)' });
    if (!atual) return;
    await aplicarOrcamento(esc, rt);
    emitir(esc);
  }

  // Fecha o processo do membro ao fim da volta (acorda sozinho com --resume na próxima mensagem); defensivo.
  async function adormecer(sessaoId) {
    if (codexIds.has(sessaoId)) return; // Codex: um app-server só, nada a dormir por thread (no-op seguro)
    if (typeof controle?.adormecer !== 'function' || ocupadaNoControle(sessaoId)) return;
    try { await controle.adormecer(sessaoId); } catch (e) { log('escritorios: adormecer falhou:', e?.message || e); }
  }

  async function processarResultado(m, sessaoId, r) {
    let esc;
    try { esc = await ler(m.esc); } catch { return; }
    const rt = rtDe(m.esc);
    const atual = await contabilizar(esc, rt, m, sessaoId, r.custoUsd, r.geracao, r.tokens ? r : null);
    if (atual) {
      const exec = rt.exec;
      const doOrq = m.papel === PAPEL_ORQUESTRADOR;
      rt.ocupados.delete(m.papel);
      // P1-5: o result de uma volta que chegou com a execução pausada (background, volta que já estava a caminho) corta de novo
      if (exec.status === 'pausada') await tentar('interromper', sessaoId);
      if (doOrq) {
        if (r.erro && exec.status !== 'pausada') rt.erroOrq = true;
      } else {
        rt.estados[m.papel] = r.erro ? (exec.status === 'pausada' ? 'interrompida' : 'erro') : 'concluida';
        rt.resumos[m.papel] = encurtar(r.texto, MAX_RESUMO);
      }
      await aplicarOrcamento(esc, rt);
      if (exec.status === 'rodando' && !doOrq) {
        const mem = esc.membros.find((x) => x.id === m.papel);
        const rotulo = mem ? mem.id : m.papel;
        const msg = r.erro ? `Membro ${rotulo} falhou: ${encurtar(r.texto, MAX_RESUMO)}` : `Membro ${rotulo} concluiu: ${encurtar(r.texto, MAX_RESUMO)}`;
        const ok = await tentar('avisarLider', exec.orquestrador, msg);
        if (ok) rt.ocupados.add(PAPEL_ORQUESTRADOR);
      }
      // P1-7: o membro que acabou a volta dorme (libera a vaga no teto); acorda no próximo `enviar`
      if (!doOrq && exec.status !== 'pausada') await adormecer(sessaoId);
      if (exec.status === 'rodando') agendarFim(esc.id);
    }
    emitir(esc);
  }

  // ── teto de instâncias de escritório (Claude vivas + threads do Codex vivos, no mesmo teto) ──
  // P1-6: o thread do Codex só ocupa vaga com turno em andamento (ou fila / pedido de aprovação aberto); ocioso ou pausado não.
  function ocupadoCodex(p, id) {
    try { const st = p?.estado?.(id); return !!(st && (st.ocupada || st.permissao || st.pendentes > 0)); } catch { return false; }
  }
  function vivosCodex() { // síncrona de propósito: é contada junto da reserva da vaga (P2-4)
    try {
      const p = ponteCodex();
      const l = p?.listarEscritorio?.();
      return Array.isArray(l) ? l.filter((x) => x && x.id && ocupadoCodex(p, x.id)).length : 0;
    } catch { return 0; }
  }
  async function vivosClaude() {
    try { return ((await chamarControle('listarEscritorio')) || []).filter((x) => x && !codexIds.has(x.id) && x.processo !== 'dormindo').length; } catch { return 0; }
  }
  // O controle já barra o Claude pelo teto dele; aqui o Codex entra na mesma conta (vivas do Claude + threads vivos do Codex).
  // P2-4: com `reservar`, a vaga é tomada na hora (no mesmo trecho síncrono da conta) e devolvida pela função que volta: dois
  // escritórios criando ao mesmo tempo não passam juntos pelo teto. Quem reservou solta quando o thread já existe (ou deu erro).
  async function checarTeto(reservar = false) {
    const claude = await vivosClaude();
    if (claude + vivosCodex() + vagasReservadas >= tetoAtual()) {
      throw erro(429, `Os escritórios já têm ${tetoAtual()} instâncias vivas (o teto deles, contando os membros do Codex). Espere uma terminar.`, { codigo: 'limite_escritorio' });
    }
    if (!reservar) return null;
    vagasReservadas++;
    let solta = false;
    return () => { if (!solta) { solta = true; vagasReservadas = Math.max(0, vagasReservadas - 1); } };
  }

  // Thread do Codex de um membro (ponte, sem HTTP): instruções do papel = o anexo do membro + o que o Claude recebe em ORBIT_*.
  async function criarSessaoCodex(esc, rt, papel, papelNome, opcoes) {
    const exec = rt.exec;
    const ponte = ponteCodex();
    if (!ponte || !codexLigado()) throw Object.assign(erro(409, MSG_CODEX_DESLIGADO), { codexIndisponivel: true });
    const soltar = await checarTeto(true); // P2-4: a vaga é reservada ANTES do await da ponte
    const execucao = exec.execucao;
    const escId = esc.id;
    let r;
    try {
      r = await ponte.criar({
      pasta: esc.pasta,
      nome: `${esc.nome} · ${papelNome}`.slice(0, MAX_NOME),
      ...(opcoes.modelo ? { modelo: opcoes.modelo } : {}),
      ...(opcoes.esforco ? { esforco: opcoes.esforco } : {}),
      texto: opcoes.texto,
      escritorio: { id: escId, execucao, papel },
      instrucoes: opcoes.anexo,
      travas: travasCodex(esc, escId, execucao),
      });
    } finally { soltar(); } // o thread já aparece na lista da ponte (ou deu erro): a reserva não conta mais
    const id = r?.sessao;
    if (!id) throw erro(500, 'a ponte do Codex não devolveu a sessão');
    codexIds.add(id);
    vinculadosCodex.add(id); // nasceu com as travas

    if (opcoes.modelo) codexModelo.set(id, opcoes.modelo);
    sessaoDe.set(id, { esc: escId, execucao, papel });
    return id;
  }

  // Travas do thread do Codex: extras de ação externa, porta/raiz do Orbit e `pausado` (função, não persiste: o reinício
  // a devolve por ponte.vincular). Pausado = a execução dele não está rodando (pausa, fim ou execução trocada).
  function travasCodex(esc, escId, execucao) {
    return {
      extras: [...(esc.externas?.extras || [])],
      porta,
      raiz: barras(raizOrbit || '.'),
      pausado: () => { const x = rts.get(escId)?.exec; return !x || x.execucao !== execucao || x.status !== 'rodando'; },
    };
  }

  // ── ações ──
  async function criarSessao(esc, rt, papel, papelNome, opcoes) {
    const exec = rt.exec;
    if (opcoes.provedor === 'codex') return criarSessaoCodex(esc, rt, papel, papelNome, opcoes);
    if (await vivosCodex() > 0) await checarTeto();
    // P1-4: o claude corta sozinho quando passa do que resta da execução (o custo só chega no fim da volta)
    const orcamentoUsd = restante(exec.custo, esc.orcamento).execucaoUsd;
    const b = {
      pasta: esc.pasta,
      nome: `${esc.nome} · ${papelNome}`.slice(0, MAX_NOME),
      ...(opcoes.modelo ? { modelo: opcoes.modelo } : {}),
      ...(opcoes.esforco ? { esforco: opcoes.esforco } : {}),
      texto: opcoes.texto,
      ...(opcoes.pai ? { pai: opcoes.pai } : {}),
      anexoSistema: opcoes.anexo,
      configuracao: configuracaoHook(raizOrbit, esc.pasta),
      ...(orcamentoUsd > 0 ? { orcamentoUsd } : {}),
      ambiente: ambienteDe(esc, exec.execucao, papel, porta),
      escritorio: { id: esc.id, execucao: exec.execucao, papel, papelNome },
    };
    const r = await chamarControle('criarInstancia', b);
    const id = r?.sessao ?? r?.id;
    if (!id) throw erro(500, 'o controle não devolveu a sessão');
    sessaoDe.set(id, { esc: esc.id, execucao: exec.execucao, papel });
    return id;
  }

  async function acionar(id, corpo) {
    return naTrava(id, async () => {
      const esc = await ler(id);
      const rt = rtDe(id);
      const tarefa = texto(corpo.tarefa) ? corpo.tarefa.trim() : '';
      if (!tarefa) throw erro(400, 'Informe a tarefa.');
      if (tarefa.length > MAX_TAREFA) throw erro(400, `A tarefa pode ter até ${MAX_TAREFA} caracteres.`);
      const origem = corpo.origem === undefined || corpo.origem === null ? 'manual' : corpo.origem;
      if (origem !== 'manual' && origem !== 'automacao') throw erro(400, 'origem inválida.');
      if (rt.exec?.status === 'rodando') throw erro(409, 'O escritório já está rodando.');
      const d = await diaDe(id);
      const diaEsgotado = d.diaUsd >= esc.orcamento.porDiaUsd;
      if (rt.exec?.status === 'pausada') {
        // pausa de orçamento do dia que já passou (o dia virou ou o limite subiu): a execução velha é descartada
        const velha = rt.exec.motivoPausa === 'orcamento-dia' && !diaEsgotado;
        if (!velha) throw erro(409, rt.exec.motivoPausa === 'orcamento-dia' ? 'Escritório pausado: orçamento do dia esgotado.' : 'Escritório pausado: libere antes de acionar de novo.');
      }
      if (diaEsgotado) throw erro(409, 'Escritório pausado: orçamento do dia esgotado.');

      const velhas = sessoesVivas(rt);
      const exec = {
        execucao: crypto.randomUUID(),
        status: 'rodando',
        inicio: relogio().toISOString(),
        origem,
        tarefa,
        orquestrador: null,
        membros: {},
        custo: novoCusto({ agora: relogio(), diaUsd: d.diaUsd, dia: d.dia, planoPct: planoAgora() }),
      };
      const rtAntes = { exec: rt.exec, ocupados: rt.ocupados, estados: rt.estados, resumos: rt.resumos, encerrados: rt.encerrados, erroOrq: rt.erroOrq, avisos: rt.avisos, ultimos: rt.ultimos, convs: rt.convs };
      rt.exec = exec;
      rt.ocupados = new Set([PAPEL_ORQUESTRADOR]);
      rt.estados = {};
      rt.resumos = {};
      rt.encerrados = new Set();
      rt.erroOrq = false;
      rt.avisos = { execucao: false, dia: null };
      rt.convs = new Map();
      try {
        exec.orquestrador = await criarSessao(esc, rt, PAPEL_ORQUESTRADOR, esc.orquestrador.nome, {
          modelo: esc.orquestrador.modelo, esforco: esc.orquestrador.esforco, texto: tarefa, anexo: anexoOrquestrador(esc, { raizOrbit }),
        });
      } catch (e) {
        Object.assign(rt, rtAntes); // teto cheio (429) ou erro: nada mudou
        throw e;
      }
      // a execução anterior (concluída, com erro ou pausada de dia velho) deixa de ocupar processos
      for (const s of velhas) await tentar('encerrar', s);
      armarPrazo(id);
      emitir(esc);
      return execucaoPublica(esc);
    });
  }

  async function pausar(id) {
    return naTrava(id, async () => {
      const esc = await ler(id);
      const rt = rtDe(id);
      if (rt.exec?.status !== 'rodando') throw erro(409, 'O escritório não está rodando.');
      await pausarInterno(esc, rt, 'manual', false);
      emitir(esc);
      return execucaoPublica(esc);
    });
  }

  async function liberar(id) {
    return naTrava(id, async () => {
      const esc = await ler(id);
      const rt = rtDe(id);
      const exec = rt.exec;
      if (exec?.status !== 'pausada') throw erro(409, 'O escritório não está pausado.');
      const d = await diaDe(id);
      // `d` já virou o dia, se for o caso: o gasto do dia da execução acompanha o do escritório
      exec.custo = { ...exec.custo, dia: d.dia, diaUsd: d.diaUsd };
      if (d.diaUsd >= esc.orcamento.porDiaUsd) throw erro(409, 'O orçamento do dia está esgotado: só libera quando o dia virar ou o limite subir.');
      if (exec.motivoPausa === 'orcamento-execucao') {
        exec.custo.execucaoTotalUsd = Math.round(((exec.custo.execucaoTotalUsd || 0) + exec.custo.execucaoUsd) * 1e6) / 1e6;
        exec.custo.execucaoUsd = 0;
        rt.avisos.execucao = false;
      }
      exec.status = 'rodando';
      delete exec.motivoPausa;
      exec.prazoDesde = relogio().toISOString(); // o prazo máximo recomeça a contar a partir da liberação
      armarPrazo(id);
      const ok = await tentar('avisarLider', exec.orquestrador, 'Escritório liberado: retome de onde parou e entregue o que for essencial.');
      if (ok) rt.ocupados.add(PAPEL_ORQUESTRADOR);
      else agendarFim(id);
      emitir(esc);
      return execucaoPublica(esc);
    });
  }

  async function enviarMembro(id, membroId, corpo, sessaoChamador) {
    return naTrava(id, async () => {
      const esc = await ler(id);
      const rt = rtDe(id);
      const exec = rt.exec;
      if (!exec || !sessaoChamador || sessaoChamador !== exec.orquestrador) throw erro(403, 'Só o orquestrador da execução atual envia tarefas aos membros.');
      const mem = esc.membros.find((x) => x.id === membroId);
      if (!mem) throw erro(404, 'membro não encontrado');
      const tarefa = texto(corpo.tarefa) ? corpo.tarefa.trim() : '';
      if (!tarefa) throw erro(400, 'Informe a tarefa.');
      if (tarefa.length > MAX_TAREFA_MEMBRO) throw erro(400, `A tarefa pode ter até ${MAX_TAREFA_MEMBRO} caracteres.`);
      if (exec.status === 'pausada') throw erro(409, 'Escritório pausado.', { pausado: true, motivoPausa: exec.motivoPausa });
      if (exec.status !== 'rodando') {
        // P2-3: só reabre se o orquestrador de verdade estiver no meio de uma volta (controle.estado(orq).ocupada) e se o
        // chamador não for o próprio membro alvo (um subagente/membro usa o id do pai; um `enviar` forjado não reabre nada)
        if (exec.membros[membroId] && sessaoChamador === exec.membros[membroId]) throw erro(403, 'O membro não reabre a execução.');
        if (!ocupadaNoControle(exec.orquestrador)) throw erro(409, 'A execução já terminou: acione o escritório de novo.');
        const d = await diaDe(id);
        if (d.diaUsd >= esc.orcamento.porDiaUsd) throw erro(409, 'Escritório pausado: orçamento do dia esgotado.', { pausado: true, motivoPausa: 'orcamento-dia' });
        exec.status = 'rodando';
        delete exec.fim;
        rt.erroOrq = false;
        rt.ocupados.add(PAPEL_ORQUESTRADOR);
        exec.prazoDesde = relogio().toISOString();
        armarPrazo(id);
      }
      let sessaoMembro = exec.membros[membroId];
      let reaproveitou = false;
      if (sessaoMembro && !rt.encerrados.has(membroId)) {
        let ok;
        // P2-4: reaproveitar um thread ocioso do Codex também ocupa uma vaga do teto (429 propaga, sem encerrar o thread)
        const soltar = codexIds.has(sessaoMembro) && !ocupadoCodex(ponteCodex(), sessaoMembro) ? await checarTeto(true) : null;
        try { ok = await chamarControle('enviarMensagem', sessaoMembro, tarefa); } catch (e) { ok = false; log('escritorios: enviarMensagem:', e?.message || e); } finally { soltar?.(); }
        reaproveitou = ok !== false;
        if (!reaproveitou) { await tentar('encerrar', sessaoMembro); rt.encerrados.add(membroId); }
      }
      if (!reaproveitou) {
        try {
          const doCodex = mem.provedor === 'codex';
          sessaoMembro = await criarSessao(esc, rt, membroId, mem.nome, {
            modelo: mem.modelo, esforco: mem.esforco, texto: tarefa, pai: exec.orquestrador,
            anexo: anexoMembro(esc, mem, doCodex ? { execucao: exec.execucao, porta } : null),
            ...(doCodex ? { provedor: 'codex' } : {}),
          });
        } catch (e) {
          if (mem.provedor !== 'codex' || e?.status === 429) throw e;
          return falharMembroCodex(esc, rt, mem, e); // só a tarefa deste membro falha; o líder é avisado
        }
        exec.membros[membroId] = sessaoMembro;
        rt.encerrados.delete(membroId);
      }
      rt.estados[membroId] = 'trabalhando';
      rt.resumos[membroId] = '';
      rt.ocupados.add(membroId);
      rt.ocupados.add(PAPEL_ORQUESTRADOR);
      clearTimeout(rt.timerFim);
      emitir(esc);
      return { sessao: sessaoMembro };
    });
  }

  // O Codex não subiu o thread (desligado, modelo recusado, sem executável...): o membro fica em erro, o líder é avisado
  // e a execução segue (o aviso reabre o líder). Responde 200 {sessao:null, falhou:true, erro} ao `enviar`.
  async function falharMembroCodex(esc, rt, mem, e) {
    const exec = rt.exec;
    const msg = encurtar(e?.message || String(e), MAX_RESUMO);
    log('escritorios: membro do Codex não subiu:', msg);
    rt.estados[mem.id] = 'erro';
    rt.resumos[mem.id] = msg;
    rt.ocupados.delete(mem.id);
    const ok = await tentar('avisarLider', exec.orquestrador, `Membro ${mem.id} falhou: ${msg}`);
    if (ok) rt.ocupados.add(PAPEL_ORQUESTRADOR);
    else agendarFim(esc.id);
    emitir(esc);
    return { sessao: null, falhou: true, erro: msg };
  }

  // ── ciclo de vida do membro do Codex (C3) ──
  // Membro Codex "trabalhando" que perdeu o turno (envio recusado depois de aceito, Codex desligado, turno que sumiu, app-server
  // caído): vira 'erro' com o motivo, o turno que sobrou é cortado e o líder é avisado — a execução pode terminar.
  async function perderMembroCodex(sid, motivo) {
    const m = sessaoDe.get(sid);
    if (!m || m.papel === PAPEL_ORQUESTRADOR) return;
    return naTrava(m.esc, async () => {
      const rt = rtDe(m.esc);
      const exec = rt.exec;
      if (!exec || exec.execucao !== m.execucao || exec.status !== 'rodando') return;
      if (exec.membros[m.papel] !== sid || rt.encerrados.has(m.papel)) return;
      if (rt.estados[m.papel] !== 'trabalhando' && rt.estados[m.papel] !== 'aguardando') return;
      let esc;
      try { esc = await ler(m.esc); } catch { return; }
      const msg = encurtar(motivo, MAX_RESUMO);
      log('escritorios: membro do Codex perdeu o turno:', m.papel, msg);
      rt.estados[m.papel] = 'erro';
      rt.resumos[m.papel] = msg;
      rt.ocupados.delete(m.papel);
      semTurno.delete(sid);
      await tentar('interromper', sid);
      const ok = await tentar('avisarLider', exec.orquestrador, `Membro ${m.papel} falhou: ${msg}`);
      if (ok) rt.ocupados.add(PAPEL_ORQUESTRADOR);
      else agendarFim(esc.id);
      emitir(esc);
    });
  }

  // Um thread de escritório que a ponte lista e esta instância ainda não resolveu: se a execução o reivindica, recebe instruções e
  // travas (vincular); senão é interrompido e encerrado. Roda dentro da trava do escritório.
  async function resolverVinculoCodex(p, x) {
    const escId = x.escritorio.id;
    const rt = rts.get(escId);
    const ex = rt?.exec;
    const papel = x.escritorio.papel;
    const reivindicado = !!ex && (ex.status === 'rodando' || ex.status === 'pausada') && ex.execucao === x.escritorio.execucao
      && ex.membros?.[papel] === x.id && !rt.encerrados.has(papel);
    if (reivindicado && typeof p.vincular === 'function') {
      try {
        const escCx = await ler(escId);
        const mem = escCx.membros.find((y) => y.id === papel);
        await p.vincular(x.id, {
          ...(mem ? { instrucoes: anexoMembro(escCx, mem, { execucao: ex.execucao, porta }) } : {}),
          travas: travasCodex(escCx, escId, ex.execucao),
        });
        sessaoDe.set(x.id, { esc: escId, execucao: ex.execucao, papel });
        vinculadosCodex.add(x.id);
        return;
      } catch (e) { log('escritorios: vincular tardio do Codex falhou:', e?.message || e); }
    }
    vinculadosCodex.add(x.id);
    await tentar('interromper', x.id);
    await tentar('encerrar', x.id);
  }

  // P2-1: a ponte apareceu depois da reidratação (subiu tarde, ou foi ligada depois): resolve os vínculos que sobraram. Enquanto isso
  // a ponte trata thread de vínculo sem `vincular` como pausado (falha fechada).
  async function reconciliarCodex() {
    const p = ponteCodex();
    if (!p || parado || typeof p.listarEscritorio !== 'function') return;
    let lista = [];
    try { lista = (await p.listarEscritorio()) || []; } catch (e) { log('escritorios: listarEscritorio do Codex falhou:', e?.message || e); return; }
    if (!Array.isArray(lista)) return;
    const vistos = new Set();
    for (const x of lista) {
      if (!x || !x.id || !x.escritorio || !x.escritorio.id) continue;
      vistos.add(x.id);
      if (vinculadosCodex.has(x.id)) continue;
      codexIds.add(x.id);
      await naTrava(x.escritorio.id, () => (vinculadosCodex.has(x.id) ? undefined : resolverVinculoCodex(p, x)));
    }
    // membros que a execução ainda reivindicava e a ponte não conhece mais: renascem no próximo enviar
    const sumidos = [];
    for (const rt of rts.values()) {
      const exec = rt.exec;
      if (!exec || (exec.status !== 'rodando' && exec.status !== 'pausada')) continue;
      for (const [papel, sid] of Object.entries(exec.membros || {})) if (codexIds.has(sid) && !vistos.has(sid) && !rt.encerrados.has(papel)) sumidos.push([rt, papel, sid]);
    }
    for (const [rt, papel, sid] of sumidos) {
      await perderMembroCodex(sid, 'O thread do Codex não existe mais (o Codex foi reiniciado).');
      rt.encerrados.add(papel);
    }
  }

  async function aoMudarPonte(p) {
    if (parado || p !== ponteOuvida) return;
    if (p) { await reconciliarCodex(); return; }
    // P1-4: o Codex foi desligado (ou o módulo caiu) com membros no meio do turno: nenhum fim será emitido
    const perdas = [];
    for (const rt of rts.values()) {
      const exec = rt.exec;
      if (exec?.status !== 'rodando') continue;
      for (const [papel, sid] of Object.entries(exec.membros || {})) {
        if (codexIds.has(sid) && !rt.encerrados.has(papel) && (rt.estados[papel] === 'trabalhando' || rt.estados[papel] === 'aguardando')) perdas.push(sid);
      }
    }
    for (const sid of perdas) await perderMembroCodex(sid, 'O Codex foi desligado nas Configurações (ou parou) no meio da volta.');
  }

  // Vigia dos membros do Codex (a cada codexMs): ligar/desligar da ponte, Acao do envio que falhou depois de aceito e membro
  // "trabalhando" sem turno aberto no Codex por semTurnoMs (envio da 1ª mensagem recusado, turno que sumiu sem fim).
  function vigiarCodex() {
    if (parado) return;
    const p = ponteCodex();
    for (const item of [...acoesCodex]) {
      if (item.a.estado === 'em_andamento') continue;
      acoesCodex.delete(item);
      if (item.a.estado === 'erro') rastrear(perderMembroCodex(item.sid, `O Codex recusou a mensagem: ${item.a.erro || 'falha ao enviar'}`).catch((e) => log('escritorios: perder membro:', e?.message || e)));
    }
    if (!p) return;
    const agoraMs = Date.now();
    for (const rt of rts.values()) {
      const exec = rt.exec;
      if (exec?.status !== 'rodando') continue;
      for (const [papel, sid] of Object.entries(exec.membros || {})) {
        if (!codexIds.has(sid) || rt.encerrados.has(papel) || (rt.estados[papel] !== 'trabalhando' && rt.estados[papel] !== 'aguardando')) { semTurno.delete(sid); continue; }
        const st = estadoDe(sid);
        if (st && (st.ocupada || st.permissao || st.pendentes > 0)) { semTurno.delete(sid); continue; }
        const desde = semTurno.get(sid) ?? agoraMs;
        semTurno.set(sid, desde);
        if (agoraMs - desde >= semTurnoMs) {
          semTurno.delete(sid);
          rastrear(perderMembroCodex(sid, 'O Codex parou sem concluir a volta (nenhum turno aberto).').catch((e) => log('escritorios: perder membro:', e?.message || e)));
        }
      }
    }
  }
  const timerCodex = codexMs > 0 ? setInterval(vigiarCodex, codexMs) : null;
  timerCodex?.unref?.();

  async function estadoMembro(id, membroId) {
    const esc = await ler(id);
    const rt = rtDe(id);
    const mem = esc.membros.find((x) => x.id === membroId);
    if (!mem) throw erro(404, 'membro não encontrado');
    const s = rt.exec?.membros[membroId] || null;
    let status = rt.estados[membroId] || (s ? 'nova' : 'inexistente');
    if (status === 'trabalhando' && aguardandoAprovacao(s)) status = 'aguardando';
    return { status, sessao: s, resumo: rt.resumos[membroId] || '', escritorio: rt.exec?.status || 'ociosa' };
  }

  function convidados(sessaoId) {
    const m = sessaoDe.get(sessaoId);
    if (!m) throw erro(404, 'sessão fora de um escritório');
    return ler(m.esc).then((esc) => {
      const rt = rtDe(esc.id);
      const doOrq = m.papel === PAPEL_ORQUESTRADOR;
      const ags = (() => { try { return sessao(sessaoId)?.agentes; } catch { return null; } })();
      const ativos = Array.isArray(ags) ? ags.filter((a) => a && (a.status === 'trabalhando' || a.status === 'aguardando')).length : 0;
      const limite = esc.convidados.limite;
      const vale = doOrq && rt.exec?.execucao === m.execucao && rt.exec.status === 'rodando';
      // P2-1: cada consulta permitida reserva +1 por 30 s (os hooks de vários `Agent` na mesma mensagem rodam em paralelo,
      // antes de o subagente aparecer em s.agentes). Quando um agente aparece, uma reserva (a mais antiga) é baixada.
      const agoraMs = relogio().getTime();
      let cv = rt.convs.get(sessaoId);
      if (!cv) { cv = { vistos: 0, reservas: [] }; rt.convs.set(sessaoId, cv); }
      cv.reservas = cv.reservas.filter((ate) => ate > agoraMs);
      if (ativos > cv.vistos) cv.reservas.splice(0, ativos - cv.vistos);
      cv.vistos = ativos;
      const emUso = ativos + cv.reservas.length;
      const permitido = vale && emUso < limite;
      if (permitido) cv.reservas.push(agoraMs + RESERVA_CONVIDADO_MS);
      return { escritorio: esc.id, limite, ativos, permitido };
    });
  }

  // ── rotas ──
  async function tratar(req, res, url) {
    let u = url;
    if (!u) { try { u = new URL(req.url || '/', 'http://127.0.0.1'); } catch { return false; } }
    const caminho = u.pathname;
    if (caminho !== '/escritorios' && !caminho.startsWith('/escritorios/')) return false;
    let partes;
    try { partes = caminho.split('/').filter(Boolean).map(decodeURIComponent); } catch { return false; }
    // partes[0] === 'escritorios'
    const [, a, b, c, d] = partes;
    await pronto; // a reidratação do reinício termina antes de qualquer rota
    try {
      if (req.method === 'GET') {
        if (!a) {
          const lista = await todos();
          for (const e of lista) await diaDe(e.id);
          lista.sort((x, y) => String(y.atualizado).localeCompare(String(x.atualizado)));
          responder(res, 200, { escritorios: lista.map(resumoDe) });
          return true;
        }
        if (a === 'convidados' && !b) {
          const s = u.searchParams?.get('sessao');
          if (!s) throw erro(400, 'Informe a sessão.');
          responder(res, 200, await convidados(s));
          return true;
        }
        if (b === 'status' && !c && partes.length === 3) { // rota leve para o hook: só o status da execução
          validarId(a);
          try { await fsp.access(arquivoDe(a)); } catch { throw erro(404, 'escritório não encontrado'); }
          responder(res, 200, { status: rts.get(a)?.exec?.status || 'ociosa' });
          return true;
        }
        if (!b) {
          const esc = await ler(a);
          await diaDe(esc.id);
          responder(res, 200, { escritorio: esc, execucao: execucaoPublica(esc) });
          return true;
        }
        if (b === 'membro' && c && d === 'estado' && partes.length === 5) {
          responder(res, 200, await estadoMembro(validarId(a), c));
          return true;
        }
        return false;
      }
      if (req.method !== 'POST') return false;
      const acoes = ['duplicar', 'excluir', 'acionar', 'pausar', 'liberar'];
      const rotaOk = !a
        || (!b && a !== 'convidados')
        || (acoes.includes(b) && !c)
        || (b === 'membro' && c && d === 'enviar' && partes.length === 5);
      if (!rotaOk) return false;
      if (req.headers?.['x-gerenciador'] !== '1') {
        responder(res, 403, { erro: 'cabeçalho ausente' });
        return true;
      }
      const corpo = await lerJSONCorpo(req, LIMITE_CORPO);
      if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) throw erro(400, 'corpo inválido');
      const campos = corpo.escritorio && typeof corpo.escritorio === 'object' && !Array.isArray(corpo.escritorio) ? corpo.escritorio : corpo;

      if (!a) { // criar
        const esc = await emFila(async () => {
          const existentes = await todos();
          const base = { id: novoId(new Set(existentes.map((x) => x.id))), criado: agora(), ...PADRAO };
          const novo = await montar(base, campos);
          await gravarArquivo(arquivoDe(novo.id), novo);
          return novo;
        });
        emitir(esc);
        responder(res, 200, { escritorio: esc });
        return true;
      }
      validarId(a);
      if (!b) { // salvar
        const esc = await emFila(async () => {
          const atual = await ler(a);
          const rt = rtDe(a);
          const novo = await montar(atual, campos);
          if (rt.exec?.status === 'rodando' && novo.pasta !== await real(atual.pasta)) throw erro(409, 'Não dá para trocar a pasta com o escritório rodando.');
          await gravarArquivo(arquivoDe(a), novo);
          return novo;
        });
        emitir(esc);
        responder(res, 200, { escritorio: esc });
        return true;
      }
      if (b === 'duplicar') {
        const esc = await emFila(async () => {
          const atual = await ler(a);
          const existentes = await todos();
          const base = { ...atual, id: novoId(new Set(existentes.map((x) => x.id))), criado: agora(), nome: nomeLivre(encurtar(`${atual.nome} (cópia)`, MAX_NOME), existentes) };
          const novo = await montar(base, {});
          await gravarArquivo(arquivoDe(novo.id), novo);
          return novo;
        });
        emitir(esc);
        responder(res, 200, { escritorio: esc });
        return true;
      }
      if (b === 'excluir') {
        const r = await naTrava(a, async () => {
          const esc = await ler(a);
          const rt = rtDe(a);
          if (rt.exec?.status === 'rodando') throw erro(409, 'O escritório está rodando: pause antes de excluir.');
          for (const s of sessoesVivas(rt)) await tentar('encerrar', s);
          clearTimeout(rt.timerFim);
          clearTimeout(rt.timerPrazo);
          for (const [sid, m] of sessaoDe) if (m.esc === a) sessaoDe.delete(sid);
          rts.delete(a);
          dias.delete(a);
          await rt.gravando.catch(() => {}); // uma gravação em andamento não pode recriar o arquivo depois
          await emFila(async () => {
            await fsp.rm(arquivoDe(a), { force: true });
            await fsp.rm(arquivoEstado(a), { force: true });
          });
          try { publicar('escritorio', { id: esc.id, resumo: null }); } catch { /* sem SSE */ }
          return { ok: true };
        });
        responder(res, 200, r);
        return true;
      }
      if (b === 'acionar') {
        const exec = await acionar(a, campos);
        responder(res, 202, { execucao: exec });
        return true;
      }
      if (b === 'pausar') {
        responder(res, 200, { execucao: await pausar(a) });
        return true;
      }
      if (b === 'liberar') {
        responder(res, 200, { execucao: await liberar(a) });
        return true;
      }
      // membro/:m/enviar
      const r = await enviarMembro(a, c, campos, String(req.headers?.['x-orbit-sessao'] || ''));
      responder(res, 200, r);
      return true;
    } catch (e) {
      const status = Number.isInteger(e?.status) ? e.status : 500;
      if (status >= 500) log('escritorios:', e?.message || e);
      responder(res, status, { erro: status >= 500 && !e?.status ? 'erro interno' : e.message, ...(e?.extra || {}) });
      return true;
    }
  }

  // ── reinício do servidor (P0-2) ──
  // O motor mantém os processos vivos e o controle os adota, mas o estado da execução vivia só na memória. Ao subir,
  // lê o <id>.estado.json e casa com controle.listarEscritorio() ([{id, escritorio, processo}]). Execução ativa
  // (rodando/pausada) cujo orquestrador não casa vira `erro` com motivoErro 'reinicio' e as sessões dela são
  // interrompidas e encerradas; sessão de escritório que nenhuma execução conhecida reivindica também.
  async function iniciar() {
    let lista = [];
    try { lista = (await controle?.listarEscritorio?.()) || []; } catch (e) { log('escritorios: listarEscritorio falhou:', e?.message || e); }
    if (!Array.isArray(lista)) lista = [];
    lista = lista.filter((x) => x && x.id && x.escritorio && x.escritorio.id);
    // Codex: espera a ponte aparecer (ou saber que não vem) e junta os threads de escritório dela à lista. Os ids entram em
    // codexIds antes de qualquer interromper/encerrar, para o roteamento ir pela ponte.
    if (typeof esperarCodex === 'function') {
      try {
        let t = null;
        await Promise.race([
          Promise.resolve().then(() => esperarCodex()),
          new Promise((ok) => { t = setTimeout(ok, esperaCodexMs); t.unref?.(); }),
        ]);
        clearTimeout(t);
      } catch (e) { log('escritorios: esperarCodex falhou:', e?.message || e); }
    }
    const ponte = ponteCodex();
    if (ponte && typeof ponte.listarEscritorio === 'function') {
      let doCodex = [];
      try { doCodex = (await ponte.listarEscritorio()) || []; } catch (e) { log('escritorios: listarEscritorio do Codex falhou:', e?.message || e); }
      if (!Array.isArray(doCodex)) doCodex = [];
      for (const x of doCodex) {
        if (!x || !x.id || !x.escritorio || !x.escritorio.id || lista.some((y) => y.id === x.id)) continue;
        codexIds.add(x.id);
        lista.push(x);
      }
    }
    const reivindicadas = new Set();
    let nomes = [];
    try { nomes = await fsp.readdir(pasta); } catch { /* sem pasta ainda */ }
    for (const n of nomes) {
      if (!n.endsWith('.estado.json')) continue;
      const id = n.slice(0, -'.estado.json'.length);
      if (!ID_OK.test(id)) continue;
      try {
        const snap = JSON.parse(await fsp.readFile(path.join(pasta, n), 'utf8'));
        if (!snap?.exec || typeof snap.exec !== 'object' || !snap.exec.execucao) continue;
        await reidratar(id, snap, lista, reivindicadas);
      } catch (e) { log('escritorios: reidratar', id, 'falhou:', e?.message || e); }
    }
    for (const x of lista) {
      if (reivindicadas.has(x.id)) continue;
      if (codexIds.has(x.id)) vinculadosCodex.add(x.id); // resolvido aqui (encerrado): a reconciliação não repete
      await tentar('interromper', x.id);
      await tentar('encerrar', x.id);
    }
  }

  async function reidratar(id, snap, lista, reivindicadas) {
    const rt = rtDe(id);
    const ex = snap.exec;
    const r = snap.rt || {};
    const doExec = lista.filter((x) => x.escritorio.id === id && x.escritorio.execucao === ex.execucao);
    const ativa = ex.status === 'rodando' || ex.status === 'pausada';
    const perdidosCodex = []; // P2-2: membros do Codex que estavam no meio do turno quando o Orbit reiniciou
    const orq = doExec.find((x) => x.escritorio.papel === PAPEL_ORQUESTRADOR);
    const casou = !!orq && orq.id === ex.orquestrador;
    const d = snap.dia && num(snap.diaUsd) ? { dia: snap.dia, diaUsd: snap.diaUsd } : null;
    if (d) dias.set(id, d);
    rt.exec = { ...ex, membros: { ...(ex.membros || {}) }, custo: { ...(ex.custo || {}) } };
    rt.ultimos = { ...(r.ultimos || {}) };
    rt.cobrados = r.cobrados && typeof r.cobrados === 'object' ? JSON.parse(JSON.stringify(r.cobrados)) : {};
    rt.avisos = { execucao: !!r.avisos?.execucao, dia: r.avisos?.dia || null };
    rt.resumos = { ...(r.resumos || {}) };
    rt.estados = { ...(r.estados || {}) };
    rt.erroOrq = !!r.erroOrq;
    rt.encerrados = new Set(r.encerrados || []);
    rt.ocupados = new Set();
    for (const [sid, m] of Object.entries(snap.sessoes || {})) {
      if (m?.provedor === 'codex') codexIds.add(sid);
      sessaoDe.set(sid, { esc: id, execucao: m.execucao, papel: m.papel });
    }
    for (const x of doExec) sessaoDe.set(x.id, { esc: id, execucao: ex.execucao, papel: x.escritorio.papel });

    if (ativa && !casou) {
      // não dá para reassumir: interrompe e encerra tudo o que for desta execução e fecha com erro/reinicio
      const ids = new Set([...doExec.map((x) => x.id), ...Object.keys(snap.sessoes || {}), ex.orquestrador, ...Object.values(ex.membros || {})].filter(Boolean));
      for (const sid of ids) { reivindicadas.add(sid); await tentar('interromper', sid); await tentar('encerrar', sid); }
      for (const m of Object.keys(rt.exec.membros)) { rt.encerrados.add(m); if (rt.estados[m] === 'trabalhando' || rt.estados[m] === 'aguardando') rt.estados[m] = 'interrompida'; }
      rt.exec.status = 'erro';
      rt.exec.motivoErro = 'reinicio';
      delete rt.exec.motivoPausa;
      rt.exec.fim = agora();
      log('escritorios: execução de', id, 'não reassumida depois do reinício');
    } else {
      // P2-1: escritório apagado: o thread do Codex dele não é reivindicado (é encerrado no fim, sem ficar órfão sem trava)
      let escExiste = true;
      try { await ler(id); } catch { escExiste = false; }
      for (const x of doExec) if (escExiste || !codexIds.has(x.id)) reivindicadas.add(x.id);
      // threads do Codex que ficaram: devolve instruções e travas (nada disso persiste na ponte, só os vínculos)
      const pc = ponteCodex();
      for (const x of doExec) {
        if (!codexIds.has(x.id) || !reivindicadas.has(x.id) || typeof pc?.vincular !== 'function') continue;
        try {
          const escCx = await ler(id);
          const mem = escCx.membros.find((y) => y.id === x.escritorio.papel);
          await pc.vincular(x.id, {
            ...(mem ? { instrucoes: anexoMembro(escCx, mem, { execucao: ex.execucao, porta }) } : {}),
            travas: travasCodex(escCx, id, ex.execucao),
          });
          vinculadosCodex.add(x.id);
        } catch (e) {
          // sem vínculo não há trava de pausa: o thread não fica vivo (é interrompido e encerrado no fim da reidratação)
          log('escritorios: vincular do Codex falhou:', e?.message || e);
          reivindicadas.delete(x.id);
          rt.encerrados.add(x.escritorio.papel);
        }
      }
      const vivas =new Set(doExec.map((x) => x.escritorio.papel));
      const semPonte = !pc;
      for (const [m, sid] of Object.entries(rt.exec.membros)) {
        // P2-1: Codex que ainda não subiu: o membro continua reivindicado; a reconciliação vincula ou encerra quando a ponte vier
        if (semPonte && codexIds.has(sid)) continue;
        if (!vivas.has(m) && !doExec.some((x) => x.id === sid)) {
          rt.encerrados.add(m); // a sessão sumiu: renasce no próximo enviar
          if (rt.estados[m] === 'trabalhando' || rt.estados[m] === 'aguardando') rt.estados[m] = 'interrompida';
        }
      }
      if (ex.status === 'rodando') {
        // os result de antes do reinício se perderam: o que está ocupado de verdade no controle é o que manda
        for (const x of doExec) if (ocupadaNoControle(x.id)) rt.ocupados.add(x.escritorio.papel);
        for (const [m, st] of Object.entries(rt.estados)) {
          if ((st !== 'trabalhando' && st !== 'aguardando') || rt.ocupados.has(m)) continue;
          if (codexIds.has(rt.exec.membros?.[m])) { // P2-2: o turno do Codex morreu com o Orbit: não vira "concluida" em silêncio
            rt.estados[m] = 'erro';
            rt.resumos[m] = 'Interrompido pelo reinício do Orbit: o turno do Codex não terminou.';
            perdidosCodex.push(m);
          } else rt.estados[m] = 'concluida';
        }
      } else if (ex.status === 'pausada') {
        for (const [m, st] of Object.entries(rt.estados)) if (st === 'trabalhando' || st === 'aguardando') rt.estados[m] = 'interrompida';
      }
    }
    let esc = null;
    try { esc = await ler(id); } catch { /* escritório apagado: a execução fica só na memória até o fim */ }
    if (esc && rt.exec.status === 'rodando') {
      for (const m of perdidosCodex) {
        const ok = await tentar('avisarLider', rt.exec.orquestrador, `Membro ${m} falhou: ${rt.resumos[m]}`);
        if (ok) rt.ocupados.add(PAPEL_ORQUESTRADOR);
      }
      armarPrazo(id);
      agendarFim(id);
    }
    if (esc) emitir(esc);
    else await tentar('encerrar', rt.exec.orquestrador);
  }

  const pronto = rastrear(iniciar().catch((e) => log('escritorios: iniciar:', e?.message || e)));

  const desligar = typeof controle?.ouvirResultado === 'function' ? controle.ouvirResultado(aoResultado) : null;

  function parar() {
    clearInterval(timerVigia);
    clearInterval(timerCodex);
    acoesCodex.clear();
    semTurno.clear();
    for (const rt of rts.values()) { clearTimeout(rt.timerFim); clearTimeout(rt.timerPrazo); }
    parado = true;
    try { desligarFimCodex?.(); } catch { /* ok */ }
    try { desligarUsoCodex?.(); } catch { /* ok */ }
    desligarFimCodex = null;
    desligarUsoCodex = null;
    for (const u of usoPorSessao.values()) clearTimeout(u.timer);
    usoPorSessao.clear();
    ponteOuvida = null;
    if (typeof desligar === 'function') { try { desligar(); } catch { /* ok */ } }
  }

  return { tratar, pasta, aguardar, parar, pronto, _rts: rts };
}
