// Orbit — Codex, etapa 4: lista de modelos/esforços (model/list) e uso do plano (account/rateLimits/read).
// Módulo do Codex: só é carregado por codex.mjs (chave ligada). Fala com o app-server por `chamar(method, params)`
// (sobe o processo se preciso). NUNCA guarda nem expõe e-mail ou id de conta: de account/read só sai o tipo de plano.
//   GET  /codex/modelos        → { modelos:[{valor, modelo, nome, descricao, esforcos[], esforcoPadrao, padrao}], atualizado }  (cache ~6 h; erro → 503)
//   GET  /codex/uso            → { cincoHoras:{pct,renova}|null, semanal:{pct,renova}|null, plano, atualizado, fonte:'app-server'|'rollout'|null }
//   POST /codex/uso/atualizar  → account/rateLimits/read agora; responde o mesmo objeto
// SSE `usoCodex` (deps.difundir) com o mesmo objeto sempre que o conteúdo muda.

const TTL_MODELOS_MS = 6 * 3600 * 1000;
const MAX_PAGINAS = 5;
const corta = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function erroHttp(status, erro, codigo) { return Object.assign(new Error(erro), { status, codigo }); }

// model/list (ModelListResponse.data[]) → mesmo formato do GET /modelos do Claude. Esforços como o Codex manda
// (supportedReasoningEfforts[].reasoningEffort). Modelos escondidos (hidden) ficam de fora.
export function normalizarModelosCodex(lista) {
  if (!Array.isArray(lista)) return [];
  const vistos = new Set();
  const out = [];
  for (const m of lista) {
    if (!m || m.hidden === true) continue;
    const modelo = typeof m.model === 'string' && m.model.trim() ? m.model.trim().slice(0, 100) : (typeof m.id === 'string' ? m.id.trim().slice(0, 100) : '');
    if (!modelo || vistos.has(modelo)) continue;
    vistos.add(modelo);
    const esforcos = [];
    for (const e of Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : []) {
      const v = typeof e === 'string' ? e : e?.reasoningEffort;
      if (typeof v === 'string' && /^[\w-]{1,20}$/.test(v) && !esforcos.includes(v)) esforcos.push(v);
    }
    out.push({
      valor: modelo,
      modelo,
      nome: corta(m.displayName || modelo, 80),
      descricao: corta(m.description || '', 300),
      esforcos,
      esforcoPadrao: typeof m.defaultReasoningEffort === 'string' ? m.defaultReasoningEffort : '',
      padrao: m.isDefault === true,
    });
  }
  return out;
}

const paraMs = (x) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : null; };
const fmt = (j) => ({ pct: Math.max(0, Math.min(100, Math.round(j.pct))), renova: j.renova ?? null });

// janelas: [{pct, min, renova}|null] (primary, secondary) → { cincoHoras, semanal } pelo tamanho da janela (300 min / 10080 min).
export function mapearJanelas(janelas) {
  const o = { cincoHoras: null, semanal: null };
  const sobra = [];
  janelas.forEach((j, i) => {
    if (!j || !Number.isFinite(j.pct)) return;
    if (j.min === 300) o.cincoHoras = fmt(j);
    else if (j.min === 10080) o.semanal = fmt(j);
    else sobra.push([i, j]);
  });
  for (const [i, j] of sobra) { // janela de tamanho desconhecido: a 1ª curta vai para 5 h, o resto para a semanal
    if (i === 0 && !o.cincoHoras && (j.min == null || j.min < 10080)) o.cincoHoras = fmt(j);
    else if (!o.semanal) o.semanal = fmt(j);
  }
  return o;
}

// RateLimitSnapshot do app-server (usedPercent/windowDurationMins/resetsAt em segundos).
export function usoDoSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return null;
  const jan = (w) => (w && typeof w === 'object' && Number.isFinite(Number(w.usedPercent)) ? { pct: Number(w.usedPercent), min: Number.isFinite(Number(w.windowDurationMins)) ? Number(w.windowDurationMins) : null, renova: paraMs(w.resetsAt) } : null);
  const o = mapearJanelas([jan(snap.primary), jan(snap.secondary)]);
  if (!o.cincoHoras && !o.semanal) return null;
  return { ...o, plano: typeof snap.planType === 'string' && snap.planType ? snap.planType : null };
}

// Uso lido do rollout (codex-rollouts.mjs): { primario:{pct, janelaMin, renova(ms)}, secundario, plano, ts }.
export function usoDoRollout(u) {
  if (!u || typeof u !== 'object') return null;
  const jan = (w) => (w && Number.isFinite(Number(w.pct)) ? { pct: Number(w.pct), min: Number.isFinite(Number(w.janelaMin)) ? Number(w.janelaMin) : null, renova: paraMs(w.renova) } : null);
  const o = mapearJanelas([jan(u.primario), jan(u.secundario)]);
  if (!o.cincoHoras && !o.semanal) return null;
  return { ...o, plano: typeof u.plano === 'string' && u.plano ? u.plano : null };
}

// deps: { chamar(method, params) → Promise (sobe o app-server), vivo() → boolean, difundir(tipo, dados), responder, log, agora }
export function criarModelosUso(deps) {
  const { chamar, responder } = deps;
  const log = deps.log || (() => {});
  const agora = deps.agora || Date.now;
  let cache = null; // { modelos, atualizado }
  let buscando = null;
  let uso = { cincoHoras: null, semanal: null, plano: null, atualizado: null, fonte: null };
  let planoConta = null; // account/read.planType (só o tipo)
  let leuConta = false;

  // ───────── modelos ─────────
  async function buscarModelos() {
    const todos = [];
    let cursor = null;
    for (let i = 0; i < MAX_PAGINAS; i++) {
      const r = await chamar('model/list', cursor ? { cursor, limit: 100 } : { limit: 100 });
      if (Array.isArray(r?.data)) todos.push(...r.data);
      cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null;
      if (!cursor) break;
    }
    const modelos = normalizarModelosCodex(todos);
    if (!modelos.length) throw new Error('o Codex não devolveu nenhum modelo');
    return { modelos, atualizado: agora() };
  }

  // Lista com cache de ~6 h. Falha com cache vencido: devolve o vencido; sem nada: 503.
  async function modelos({ forcar = false } = {}) {
    if (cache && !forcar && agora() - cache.atualizado < TTL_MODELOS_MS) return cache;
    if (!buscando) {
      buscando = buscarModelos().then((c) => { cache = c; return c; }).finally(() => { buscando = null; });
      buscando.catch(() => {});
    }
    try { return await buscando; } catch (e) {
      log('codex: model/list', e?.message || e);
      if (cache) return cache;
      throw erroHttp(503, `Não consegui ler os modelos do Codex: ${corta(e?.message || e, 200)}`, 'sem_modelos');
    }
  }

  // Valida modelo/esforço contra a lista. `modeloAtual` = o modelo da sessão quando só o esforço é trocado.
  // Devolve { modelo, esforco } normalizados ('' = não informado). 400 para valor fora da lista.
  async function validar(modelo, esforco, modeloAtual = '') {
    const m0 = typeof modelo === 'string' ? modelo.trim() : '';
    const e0 = typeof esforco === 'string' ? esforco.trim() : '';
    if (!m0 && !e0) return { modelo: '', esforco: '' };
    const { modelos: lista } = await modelos();
    let m = null;
    if (m0) {
      m = lista.find((x) => x.valor === m0 || x.modelo === m0);
      if (!m) throw erroHttp(400, `Modelo desconhecido: ${corta(m0, 100)}. Use: ${lista.map((x) => x.valor).join(', ')}.`);
    }
    if (e0) {
      const base = m || lista.find((x) => x.valor === modeloAtual || x.modelo === modeloAtual) || lista.find((x) => x.padrao) || null;
      const aceitos = base ? base.esforcos : [...new Set(lista.flatMap((x) => x.esforcos))];
      if (!aceitos.length) throw erroHttp(400, `${base ? base.nome : 'O modelo'} não tem nível de esforço.`);
      if (!aceitos.includes(e0)) throw erroHttp(400, `${base ? base.nome : 'O Codex'} não aceita o esforço "${corta(e0, 20)}". Use: ${aceitos.join(', ')}.`);
    }
    return { modelo: m ? m.valor : '', esforco: e0 };
  }

  // ───────── uso do plano ─────────
  const igual = (a, b) => JSON.stringify([a.cincoHoras, a.semanal, a.plano, a.fonte]) === JSON.stringify([b.cincoHoras, b.semanal, b.plano, b.fonte]);
  function definirUso(novo, fonte, atualizado) {
    const plano = novo.plano || planoConta || uso.plano || null;
    const prox = { cincoHoras: novo.cincoHoras, semanal: novo.semanal, plano, atualizado, fonte };
    const mudou = !igual(uso, prox);
    uso = prox;
    if (mudou) { try { deps.difundir?.('usoCodex', uso); } catch {} }
  }
  function aplicarSnapshot(r) {
    // rateLimitsByLimitId.codex é o balde do Codex; rateLimits é a visão antiga de um balde só.
    const snap = r?.rateLimitsByLimitId?.codex || r?.rateLimits || r;
    const u = usoDoSnapshot(snap);
    if (u) definirUso(u, 'app-server', agora());
    return !!u;
  }

  // Último rate_limits dos rollouts (monitor): só vale sem app-server vivo e quando é mais novo que o que já temos.
  function aoRolloutUso(u) {
    const n = usoDoRollout(u);
    if (!n) return;
    const ts = Number(u.ts) || agora();
    if (uso.fonte === 'app-server' && (deps.vivo?.() || ts <= (uso.atualizado || 0))) return;
    if (uso.fonte === 'rollout' && ts < (uso.atualizado || 0)) return;
    definirUso(n, 'rollout', ts);
  }

  // account/read: só o tipo de plano (nada de e-mail/conta).
  async function lerPlano() {
    if (leuConta) return;
    leuConta = true;
    try {
      const r = await chamar('account/read', {});
      const a = r?.account;
      planoConta = a && a.type === 'chatgpt' && typeof a.planType === 'string' && a.planType ? a.planType : null;
    } catch (e) { leuConta = false; log('codex: account/read', e?.message || e); }
  }

  async function atualizarUso() {
    let r;
    try { r = await chamar('account/rateLimits/read', { excludeResetCreditDetails: true }); } catch (e) {
      if (e?.status) throw e;
      throw erroHttp(502, `O Codex não informou o uso do plano: ${corta(e?.message || e, 200)}`, 'sem_uso');
    }
    await lerPlano();
    if (!aplicarSnapshot(r)) throw erroHttp(502, 'O Codex não informou os limites do plano.', 'sem_uso');
    return uso;
  }

  // Notificação da conta (sem thread): account/rateLimits/updated traz o snapshot novo.
  function aoConta(method, params) {
    if (method === 'account/rateLimits/updated') aplicarSnapshot(params);
  }

  // ───────── rotas ─────────
  async function rota(req, res, caminho) {
    try {
      if (caminho === '/codex/modelos') {
        if (req.method !== 'GET') { responder(res, 405, { erro: 'método não permitido' }); return true; }
        const { modelos: lista, atualizado } = await modelos();
        responder(res, 200, { modelos: lista, atualizado });
        return true;
      }
      if (caminho === '/codex/uso') {
        if (req.method !== 'GET') { responder(res, 405, { erro: 'método não permitido' }); return true; }
        responder(res, 200, uso);
        return true;
      }
      if (caminho === '/codex/uso/atualizar') {
        if (req.method !== 'POST') { responder(res, 405, { erro: 'método não permitido' }); return true; }
        responder(res, 200, await atualizarUso());
        return true;
      }
      return false;
    } catch (e) {
      if (!e.status) throw e;
      responder(res, e.status, e.codigo ? { erro: e.message, codigo: e.codigo } : { erro: e.message });
      return true;
    }
  }

  return { rota, modelos, validar, uso: () => uso, atualizarUso, aoRolloutUso, aoConta };
}
