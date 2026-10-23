// Orbit — Codex (OpenAI) como segundo provedor. Só é carregado (await import) quando config.codex.ativo está ligado;
// com a chave desligada nada daqui existe no servidor e /codex/* cai no 404 final.
//   etapa 0: GET /codex/estado (executável detectado).
//   etapa 1: monitor dos rollouts (CODEX_HOME/sessions/AAAA/MM/DD/rollout-*.jsonl, somente leitura) -> sessões com provedor
//            'codex' no servidor (deps.sessaoCodex) + GET /codex/sessao/:id/conversa.
//   etapas 2+: instâncias pelo `codex app-server` via codex-rpc.mjs (criar, enviar, interromper, retomar, permissões).
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acharCodex } from './codex-exe.mjs';
import { criarMonitorRollouts, ehGuardian } from './codex-rollouts.mjs';
import { lerConversaCodex, LIMITE_PADRAO, LIMITE_MAX } from './codex-conversa.mjs';
import { criarInstancias } from './codex-instancias.mjs';
import { criarModelosUso } from './codex-uso.mjs';

const corta = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const RE_CONVERSA = /^\/codex\/sessao\/([^/]+)\/conversa$/;

// Resumo do rollout (codex-rollouts.mjs) → campos que o servidor entende (contrato, etapa 1).
export function camposDoResumo(r) {
  const ctx = r.contexto && (r.contexto.tokens != null || r.contexto.janela) ? r.contexto : null;
  const f = r.status === 'trabalhando' ? r.ultimaFerramenta : null;
  return {
    status: r.status,
    motivo: r.motivo || '',
    cwd: r.cwd || '',
    titulo: corta(r.primeira, 60),
    primeira: r.primeira || '',
    pedido: r.pedido || '',
    ultimaResposta: r.ultimaResposta || '',
    contexto: ctx ? { tokens: ctx.tokens ?? null, modelo: r.modelo || '', janela: ctx.janela ?? null, pct: ctx.pct ?? null } : null,
    modelo: r.modelo || '',
    esforco: r.esforco || '',
    contadores: { turnos: r.contadores?.turnos || 0, ferramentas: r.contadores?.ferramentas || 0 },
    inicio: r.inicio,
    atividade: r.atividade,
    ferramenta: f ? { nome: f.nome, alvo: f.alvo || '', desde: f.ts || r.atividade } : null,
  };
}

const MAX_AGENTES = 20;
const VISIVEL_MS = 30 * 60e3; // como o Claude: concluído há mais de 30 min sai da lista
// Resumo de rollout de subagente → item de `agentes[]` (mesmo formato do Claude: id, tipo, descricao, status, inicio, fim, texto…).
export function agenteDe(r) {
  const sub = r.subagente || {};
  const st = r.status === 'concluida' ? 'concluido' : r.status === 'erro' || r.status === 'interrompida' ? 'erro' : r.status === 'aguardando' ? 'aguardando' : 'trabalhando';
  const fim = st === 'concluido' || st === 'erro';
  const tarefa = corta(r.pedido || r.primeira, 120);
  const descricao = corta([sub.apelido, tarefa].filter(Boolean).join(': '), 140);
  const f = !fim && st !== 'aguardando' ? r.ultimaFerramenta : null;
  const atividade = Number(r.atividade) || Number(r.inicio) || Date.now();
  return {
    id: r.id, tipo: corta(sub.papel || sub.apelido || 'subagente', 40), descricao, status: st,
    inicio: Number(r.inicio) || atividade, fim: fim ? atividade : null,
    ferramenta: f ? { nome: f.nome, alvo: f.alvo || '', desde: f.ts || atividade } : null,
    ferramentas: r.contadores?.ferramentas || 0, atividade, acoes: [], texto: r.ultimaResposta ? String(r.ultimaResposta).slice(0, 4000) : '',
  };
}
// Lista de agentes da mãe: poda os concluídos há muito e o excesso (como o Claude).
function listaAgentes(mapa, agora = Date.now()) {
  let l = [...mapa.values()].filter((a) => !a.fim || agora - a.fim <= VISIVEL_MS);
  while (l.length > MAX_AGENTES) { const i = l.findIndex((a) => a.fim); l.splice(i < 0 ? 0 : i, 1); }
  return l;
}

// deps: { config: () => config.codex, responder(res, codigo, corpo), log, sessaoCodex(id, campos), removerCodex(),
//         sessao(id), difundir(tipo, dados), difundirSessao(id), removerSessao(id), lerJSONCorpo(req, limite) }
export function criarCodex(deps) {
  const { config, responder } = deps;
  const log = deps.log || (() => {});
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  let ultimoUso = null; // último uso do plano visto nos rollouts (bruto; a etapa 4 mapeia em codex-uso.mjs)
  // Etapa 2: instâncias pelo app-server (processo só sobe na 1ª instância). O monitor só complementa o que ela não sabe.
  // Etapa 4: modelos (model/list) e uso do plano; falam com o app-server pelo mesmo processo das instâncias.
  let mu = null;
  // B1a: vínculo thread → escritório em <GERENCIADOR_DADOS || pasta do Orbit>/codex-escritorio.json (mesma regra do servidor).
  const dados = path.resolve(process.env.GERENCIADOR_DADOS || path.dirname(fileURLToPath(import.meta.url)));
  const inst = criarInstancias({ arquivoEscritorio: path.join(dados, 'codex-escritorio.json'), codexHome: home, ...deps }, {
    validar: (m, e, atual) => mu.validar(m, e, atual),
    aoConta: (method, params) => mu.aoConta(method, params),
  });
  mu = criarModelosUso({ chamar: inst.chamar, vivo: inst.vivo, difundir: deps.difundir, responder, log });

  // Etapa 5: subagentes (sub-threads com `subagente.pai`, exceto o guardian/revisor interno) → `agentes[]` da sessão mãe,
  // no formato dos agentes do Claude. `filhos`: pai -> (id do sub-thread -> agente).
  const filhos = new Map();
  function publicarSessao(r) {
    try {
      const c = camposDoResumo(r);
      const ag = filhos.get(r.id);
      if (ag) c.agentes = listaAgentes(ag);
      deps.sessaoCodex?.(r.id, inst.complementar(r.id, c));
    } catch (e) { log('codex: sessão', r.id, e?.message || e); }
  }
  function aoSubagente(r) {
    const pai = r.subagente.pai;
    if (!pai || ehGuardian(r) || pai === r.id) return;
    let ag = filhos.get(pai);
    if (!ag) filhos.set(pai, (ag = new Map()));
    ag.set(r.id, agenteDe(r));
    const mae = monitor.resumos().find((x) => x.id === pai && !x.subagente);
    if (mae) publicarSessao(mae);
  }

  const monitor = criarMonitorRollouts({
    home,
    intervaloMs: Number(process.env.ORBIT_CODEX_INTERVALO_MS) || 2000,
    aoMudar: (r) => {
      if (!r?.id) return;
      if (r.subagente) { aoSubagente(r); return; } // etapa 5: subagentes do próprio Codex viram agentes[] da mãe
      publicarSessao(r);
    },
    aoUso: (u) => { ultimoUso = u; try { mu.aoRolloutUso(u); } catch {} },
  });

  // GET /codex/estado: o executável detectado.
  function estadoExe() {
    const c = config() || {};
    return { ativo: !!c.ativo, exe: acharCodex({ caminhoManual: c.exe }) };
  }

  // Estado de controle da sessão (publico(s) do servidor): só monitorada = sem controle pelo Orbit.
  function estado(s) {
    return (s && inst.estado(s)) || { modo: 'nenhum', provedor: 'codex' };
  }

  // Devolve true se tratou a rota. O servidor só chama com a chave ligada.
  async function rota(req, res, caminho, url) {
    if (await mu.rota(req, res, caminho)) return true; // etapa 4: /codex/modelos, /codex/uso, /codex/uso/atualizar
    if (await inst.rota(req, res, caminho, url)) return true; // etapa 2: /codex/instancias e /codex/sessao/:id/(mensagem|parar|retomar|encerrar|permissao|compactar|modelo|esforco|conversa/fluxo|acoes)
    if (req.method === 'GET' && caminho === '/codex/estado') {
      responder(res, 200, { ...estadoExe(), ativo: true });
      return true;
    }
    const m = req.method === 'GET' ? RE_CONVERSA.exec(caminho) : null;
    if (m) {
      let id; try { id = decodeURIComponent(m[1]); } catch { id = ''; }
      const q = url?.searchParams;
      let limite = LIMITE_PADRAO;
      if (q?.has('limite')) {
        limite = Number(q.get('limite'));
        if (!Number.isInteger(limite) || limite < 1) { responder(res, 400, { erro: 'limite inválido' }); return true; }
        limite = Math.min(limite, LIMITE_MAX);
      }
      let antes = null;
      if (q?.has('antes') && q.get('antes') !== '') {
        antes = Number(q.get('antes'));
        if (!Number.isInteger(antes) || antes < 0) { responder(res, 400, { erro: 'cursor inválido' }); return true; }
      }
      monitor.varrer(); // pega o que acabou de ser escrito
      const arquivo = monitor.resumos().find((r) => r.id === id)?.arquivo;
      if (!arquivo) { responder(res, 200, { itens: [], cursorAntigo: null }); return true; }
      responder(res, 200, await lerConversaCodex(arquivo, antes, limite));
      return true;
    }
    return false;
  }

  // Ao desligar a chave (e no desligar do servidor): para o monitor (e, nas próximas etapas, o app-server).
  function parar() {
    try { monitor.parar(); } catch {}
    const fim = inst.parar(); // encerra o app-server: nenhum processo do Codex sobra
    log('codex: parado');
    return fim;
  }

  // B1a: `ponte` = API JS do motor para o módulo de escritórios (criar/enviar/interromper/encerrar/estado/listarEscritorio/
  // ouvirFim/vincular; ver codex-instancias.mjs e o CONTRATO, "Ponte para escritórios").
  return { rota, estado, parar, uso: () => ultimoUso, ponte: inst.ponte };
}
