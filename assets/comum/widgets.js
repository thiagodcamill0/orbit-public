// Orbit — cálculo e formatação dos widgets da Visão geral, comuns ao PC (index.html) e ao celular (mobile/widgets.js).
// Script clássico, sem DOM e sem dependências: define só window.OrbitWidgets (congelado). Carregar depois de base.js.
// O PC desenha com os próprios elementos; o celular, com mobile/widgets.js. Aqui só vão as contas.
(function () {
  'use strict';

  // ===== Sessões por estado (rosca) =====
  // Paleta de 17/10, a mesma dos estados nos cards de projeto. "revisadas" é estado local do PC; o celular não usa.
  const GRUPOS_ESTADO = Object.freeze([
    { g: 'precisa', rot: 'Precisa de você', cor: '#ffd600' },
    { g: 'trabalhando', rot: 'Trabalhando', cor: '#001692' },
    { g: 'novas', rot: 'Novas', cor: '#f5f5f5' },
    { g: 'concluidas', rot: 'Concluídas', cor: '#00ff85' },
    { g: 'revisadas', rot: 'Revisadas', cor: '#8e8e93' },
    { g: 'encerradas', rot: 'Encerradas', cor: '#ff453a' },
  ].map(Object.freeze));
  // Status da sessão → grupo, no celular (sem "revisadas").
  const GRUPO_DO_STATUS = Object.freeze({ aguardando: 'precisa', erro: 'precisa', trabalhando: 'trabalhando', nova: 'novas', concluida: 'concluidas', interrompida: 'concluidas', encerrada: 'encerradas' });
  const ROSCA_R = 50;
  const ROSCA_C = 2 * Math.PI * ROSCA_R;
  const ROSCA_TRACO = 13; // = stroke-width do segmento; a ponta redonda avança metade disso de cada lado
  const ROSCA_FENDA = 6; // fenda visível entre fatias

  // Contagem por grupo a partir de uma lista de sessões ({status, encerrada...}).
  function contarGrupos(sessoes) {
    const c = Object.fromEntries(GRUPOS_ESTADO.map((x) => [x.g, 0]));
    for (const s of sessoes || []) { const g = GRUPO_DO_STATUS[s && s.status]; if (g) c[g]++; }
    return c;
  }
  // Fatias da rosca: por grupo { g, n, vis, desloc } (traço visível e deslocamento, para stroke-dasharray/-dashoffset).
  // Fenda entre fatias só com mais de uma; a partir do topo, sentido horário.
  function fatiasRosca(cont) {
    const total = GRUPOS_ESTADO.reduce((a, x) => a + (cont[x.g] || 0), 0);
    const varias = GRUPOS_ESTADO.filter((x) => cont[x.g]).length > 1;
    const corte = varias ? ROSCA_FENDA + ROSCA_TRACO : 0;
    let ini = 0;
    const fatias = GRUPOS_ESTADO.map((x) => {
      const n = cont[x.g] || 0;
      const arco = total ? (n / total) * ROSCA_C : 0;
      const vis = varias ? Math.max(0.01, arco - corte) : arco;
      const desloc = -(ini + (varias ? Math.min(corte, arco) / 2 : 0));
      ini += arco;
      return { g: x.g, n, vis, desloc };
    });
    return { total, varias, fatias };
  }
  // Subagentes ativos somados nas sessões.
  const agentesAtivos = (s) => (Array.isArray(s && s.agentes) ? s.agentes.filter((a) => a && a.id && (a.status === 'trabalhando' || a.status === 'aguardando')).length : 0);

  // ===== Formatação =====
  function fmtK(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',').replace(',0', '') + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
  }
  // 26,3%: uma casa decimal com vírgula; 0 e 100 sem casa.
  function fmtPct(f) {
    const p = Math.round(f * 1000) / 10;
    return (p % 1 ? p.toFixed(1).replace('.', ',') : String(p)) + '%';
  }
  // "2 h 13 min", "45 min", "3 d 5 h", "menos de 1 min".
  function durRen(ms) {
    const m = Math.floor(Math.max(0, ms) / 60e3);
    if (m < 1) return 'menos de 1 min';
    if (m < 60) return m + ' min';
    const hr = Math.floor(m / 60);
    if (hr < 24) return hr + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
    return Math.floor(hr / 24) + ' d' + (hr % 24 ? ' ' + (hr % 24) + ' h' : '');
  }
  const plural = (n, um, varios) => n + ' ' + (n === 1 ? um : varios);
  function haQuanto(iso, agora = Date.now()) {
    const t = typeof iso === 'number' ? iso : Date.parse(iso || '');
    if (!t) return '';
    const min = Math.round((agora - t) / 60e3);
    if (min < 1) return 'agora há pouco';
    if (min < 60) return 'há ' + min + ' min';
    const hs = Math.round(min / 60);
    if (hs < 24) return 'há ' + hs + ' h';
    return 'há ' + plural(Math.round(hs / 24), 'dia', 'dias');
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  const horaPadrao = (ms) => { const d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
  const DIAS_SEM = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  // "às 14:30" hoje; "sex 09:00" até 6 dias; "22/10" além disso.
  function quandoUso(ms, agora, hora = horaPadrao) {
    const d = new Date(ms);
    if (d.toDateString() === new Date(agora).toDateString()) return 'às ' + hora(ms);
    if (Math.abs(ms - agora) < 6 * 86400e3) return DIAS_SEM[d.getDay()] + ' ' + hora(ms);
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1);
  }
  // Instante em ms (aceita segundos).
  const msAbs = (v) => { let r = Number(v) || 0; if (r && r < 1e12) r *= 1000; return r; };

  // ===== Contexto =====
  // Mesma regra do janela.mjs (cópia, como a do index.html; o testes/mobile-widgets.test confere).
  function janelaDoModelo(modelo) {
    const m = String(modelo || '').trim().toLowerCase();
    if (!m) return null;
    if (/\[1m\]$/.test(m)) return 1e6;
    if (!m.startsWith('claude-')) return null;
    if (/^claude-(fable|mythos)\b/.test(m)) return 1e6;
    const v = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:\b|-|$)/.exec(m);
    if (!v) return 2e5;
    const maior = Number(v[2]);
    const menor = v[3] !== undefined ? Number(v[3]) : 0;
    if (maior >= 5) return 1e6;
    if (maior === 4 && menor >= 6 && v[1] !== 'haiku') return 1e6;
    return 2e5;
  }
  const LIMITE_CTX = 200000;
  function contexto(s) {
    const c = s && s.contexto;
    if (!c || !Number(c.tokens)) return null;
    const modelo = String(c.modelo || '');
    const janela = Number(c.janela) || 0;
    const limite = janela || janelaDoModelo(modelo) || LIMITE_CTX;
    const tokens = Number(c.tokens);
    const pct = c.pct != null && isFinite(Number(c.pct)) ? Number(c.pct) / 100 : tokens / limite;
    return { tokens, modelo, limite, pct: Math.min(1, Math.max(0, pct)), acima: !janela && tokens > limite, exato: !!janela };
  }
  const ctxPct = (s) => { const c = contexto(s); return c ? (c.acima ? 1.01 : c.pct) : 0; };
  // Escala do contexto (verde até 45%, amarelo 50, vermelho 75, roxo 100): usa --uso-* via OrbitBase.corEscala.
  const CTX_ESCALA = Object.freeze([[0, '--uso-verde'], [0.45, '--uso-verde'], [0.50, '--uso-amarelo'], [0.75, '--uso-vermelho'], [1, '--uso-roxo']]);

  // ===== Uso do plano =====
  const USO_PERTO = 80; // % a partir do qual a janela está "perto do limite"
  const USO_VELHO = 30 * 60e3;
  const USO_JANELA_5H = 5 * 3600e3;
  const USO_JANELAS = Object.freeze([
    { k: 'cincoHoras', rot: 'Sessão', janela: 'janela de 5 h', uni: 'usado na sessão de 5h', curto: 'Sessão' },
    { k: 'semanal', rot: 'Semana', janela: 'janela de 7 dias', uni: 'usado na semana', curto: 'Semana' },
  ].map(Object.freeze));
  // Previsão da sessão de 5h no ritmo atual. `amostras` = [{ t, p, r }] das leituras da mesma janela.
  // Devolve { cls, partes, dica } (partes: texto ou { b: texto } em negrito) ou null.
  function previsaoUso(j, lido, agora, amostras, hora = horaPadrao) {
    if (!j || typeof j.pct !== 'number' || !isFinite(j.pct)) return null;
    const r = msAbs(j.renova);
    if (!r || r <= agora) return null;
    const pct = Math.max(0, j.pct);
    if (pct >= 100) return { cls: 'limite', partes: ['Limite da sessão atingido. Libera em ', { b: durRen(r - agora) }, '.'], dica: 'A sessão de 5 h chegou a 100%. O uso volta quando a janela renovar, às ' + hora(r) + '.' };
    const base = lido || agora;
    let ritmo = null, como = '';
    const recentes = (amostras || []).filter((x) => Math.abs(x.r - r) < 120e3 && x.t <= base && base - x.t <= 90 * 60e3);
    const primeira = recentes[0];
    if (primeira && base - primeira.t >= 15 * 60e3 && pct >= primeira.p) {
      ritmo = (pct - primeira.p) / (base - primeira.t);
      como = 'ritmo das leituras desde ' + hora(primeira.t);
    } else {
      const decorrido = base - (r - USO_JANELA_5H);
      if (decorrido >= 10 * 60e3) { ritmo = pct / decorrido; como = 'média desde o começo da janela, às ' + hora(r - USO_JANELA_5H); }
    }
    if (ritmo == null) return { cls: 'neutro', partes: ['Pouco uso nesta sessão para prever o ritmo.'], dica: 'A previsão aparece depois de uns minutos de uso na janela de 5 h.' };
    const porHora = Math.round(ritmo * 3600e3);
    const dica = 'Estimativa linear (' + como + ', ~' + porHora + '% por hora), até a renovação às ' + hora(r) + '.';
    const fim = pct + ritmo * (r - base);
    if (ritmo <= 0 || fim < 100) {
      return { cls: '', partes: ['No ritmo atual, a sessão fecha em ', { b: '~' + Math.max(Math.round(pct), Math.round(fim)) + '%' }, ' e não atinge o limite antes de renovar.'], dica };
    }
    const bate = base + (100 - pct) / ritmo;
    return { cls: 'aviso', partes: ['No ritmo atual, atinge o limite em ', { b: '~' + durRen(bate - agora) }, ', ', durRen(r - bate), ' antes de renovar.'], dica };
  }
  // Linhas das janelas de uso: { k, rot, pct (null = sem dado/renovou), r, renovou, tem }.
  function linhasUso(uso, agora) {
    return USO_JANELAS.map((x) => {
      const j = uso && uso[x.k];
      const tem = !!j && typeof j.pct === 'number' && isFinite(j.pct);
      const r = tem ? msAbs(j.renova) : 0;
      const renovou = !!r && r <= agora;
      const pct = tem && !renovou ? Math.max(0, Math.min(100, Math.round(j.pct))) : null;
      return { ...x, pct, r, renovou, tem };
    });
  }

  window.OrbitWidgets = Object.freeze({
    GRUPOS_ESTADO, GRUPO_DO_STATUS, ROSCA_R, ROSCA_C, ROSCA_TRACO, ROSCA_FENDA, contarGrupos, fatiasRosca, agentesAtivos,
    fmtK, fmtPct, durRen, plural, haQuanto, quandoUso, msAbs, horaPadrao,
    janelaDoModelo, contexto, ctxPct, CTX_ESCALA,
    USO_PERTO, USO_VELHO, USO_JANELA_5H, USO_JANELAS, previsaoUso, linhasUso,
  });
})();
