// Orbit — orçamento dos escritórios (contrato §8). Módulo PURO: sem disco, sem relógio global, sem rede.
//
// O controle devolve, a cada evento `result`, o custo ACUMULADO da sessão (total_cost_usd). Aqui se soma a
// DIFERENÇA em relação ao último valor visto daquela sessão. O dia vira à meia-noite LOCAL.
//
//   custo  = { execucaoUsd, diaUsd, dia: 'AAAA-MM-DD', planoPctInicio, planoPctAgora }
//   ultimos = { <sessaoId>: custoAcumuladoVisto }
//   avisos = { execucao: boolean, dia: 'AAAA-MM-DD' | null }   // o aviso sai uma vez por execução e uma vez por dia

export const AVISO_PADRAO = 80;

const num = (n) => typeof n === 'number' && Number.isFinite(n);
const dois = (n) => String(n).padStart(2, '0');

// Dia local (não UTC) de uma data.
export function diaLocal(data = new Date()) {
  const d = data instanceof Date ? data : new Date(data);
  return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`;
}

// Custo zerado de uma execução que começa agora; o gasto do dia continua de onde estava.
export function novoCusto({ agora = new Date(), diaUsd = 0, dia, planoPct = null } = {}) {
  const hoje = diaLocal(agora);
  const mesmoDia = !dia || dia === hoje;
  return {
    execucaoUsd: 0,
    diaUsd: mesmoDia && num(diaUsd) ? diaUsd : 0,
    dia: hoje,
    planoPctInicio: num(planoPct) ? planoPct : null,
    planoPctAgora: num(planoPct) ? planoPct : null,
  };
}

// Se o dia mudou, zera o gasto do dia (a execução em curso segue com o dela). Devolve um objeto novo.
export function virarDia(custo, agora = new Date()) {
  const hoje = diaLocal(agora);
  if (custo.dia === hoje) return { ...custo };
  return { ...custo, dia: hoje, diaUsd: 0 };
}

// O total_cost_usd é por PROCESSO: a chave é `sessao:geracao` (a geração muda a cada processo novo da mesma sessão:
// spawn, acordar, adotar). Sem geração, vale só o id da sessão.
export function chaveCusto(sessaoId, geracao = null) {
  return geracao === null || geracao === undefined || geracao === '' ? String(sessaoId) : `${sessaoId}:${geracao}`;
}

// Soma a diferença do custo acumulado da sessão. Se o valor caiu (sessão recomeçou o contador), vale o novo
// valor inteiro. Devolve { custo, ultimos, delta } novos; nada é alterado no lugar.
export function somarCusto({ custo, ultimos = {} }, sessaoId, custoUsd, { agora = new Date(), planoPct = null, geracao = null } = {}) {
  const base = virarDia(custo, agora);
  const chave = chaveCusto(sessaoId, geracao);
  const visto = num(ultimos[chave]) ? ultimos[chave] : 0;
  let delta = 0;
  if (num(custoUsd) && custoUsd >= 0) delta = custoUsd >= visto ? custoUsd - visto : custoUsd;
  delta = arredondar(delta);
  const novo = {
    ...base,
    execucaoUsd: arredondar(base.execucaoUsd + delta),
    diaUsd: arredondar(base.diaUsd + delta),
  };
  if (num(planoPct)) {
    if (novo.planoPctInicio === null) novo.planoPctInicio = planoPct;
    novo.planoPctAgora = planoPct;
  }
  const ult = num(custoUsd) && custoUsd >= 0 ? { ...ultimos, [chave]: custoUsd } : { ...ultimos };
  return { custo: novo, ultimos: ult, delta };
}

// Consumo estimado do plano (5 h) nesta execução: diferença entre o % de agora e o do início.
export function planoPct(custo) {
  if (!num(custo?.planoPctInicio) || !num(custo?.planoPctAgora)) return 0;
  return Math.max(0, arredondar(custo.planoPctAgora - custo.planoPctInicio));
}

// Decide o que fazer com o gasto atual.
//   estourou: 'orcamento-dia' | 'orcamento-execucao' | null  (100% ou mais; o dia tem prioridade)
//   avisar: [{ tipo: 'execucao'|'dia', pct }]                 (>= avisoPct e ainda sem aviso)
//   avisos: o novo registro de avisos já emitidos
export function avaliar(custo, orcamento, avisos = {}) {
  const limExec = num(orcamento?.porExecucaoUsd) && orcamento.porExecucaoUsd > 0 ? orcamento.porExecucaoUsd : Infinity;
  const limDia = num(orcamento?.porDiaUsd) && orcamento.porDiaUsd > 0 ? orcamento.porDiaUsd : Infinity;
  const aviso = num(orcamento?.avisoPct) ? orcamento.avisoPct : AVISO_PADRAO;
  const pctExecucao = (custo.execucaoUsd / limExec) * 100;
  const pctDia = (custo.diaUsd / limDia) * 100;
  const novos = { execucao: !!avisos.execucao, dia: avisos.dia || null };
  let estourou = null;
  if (pctDia >= 100) estourou = 'orcamento-dia';
  else if (pctExecucao >= 100) estourou = 'orcamento-execucao';
  const avisar = [];
  if (!estourou) {
    if (pctExecucao >= aviso && !novos.execucao) { avisar.push({ tipo: 'execucao', pct: Math.floor(pctExecucao) }); novos.execucao = true; }
    if (pctDia >= aviso && novos.dia !== custo.dia) { avisar.push({ tipo: 'dia', pct: Math.floor(pctDia) }); novos.dia = custo.dia; }
  }
  return { pctExecucao, pctDia, estourou, avisar, avisos: novos };
}

// Quanto resta de cada limite (nunca negativo).
export function restante(custo, orcamento) {
  return {
    execucaoUsd: Math.max(0, arredondar((orcamento?.porExecucaoUsd ?? 0) - custo.execucaoUsd)),
    diaUsd: Math.max(0, arredondar((orcamento?.porDiaUsd ?? 0) - custo.diaUsd)),
  };
}

// Valores monetários em dólar: 6 casas bastam e evitam lixo de ponto flutuante nas somas.
function arredondar(n) {
  return Math.round(n * 1e6) / 1e6;
}

// ───────────────────────── Codex: custo estimado em US$ (tokens × preço) ─────────────────────────
// O Codex não informa dólar: converte-se o uso ACUMULADO do thread ({entrada, cacheEntrada, saida, raciocinio, total},
// o que o `ouvirFim` da ponte entrega) pela tabela de preço do modelo, em US$ por MILHÃO de tokens. Os padrões abaixo são
// os preços públicos da API e podem estar defasados: o usuário sobrescreve em `config.escritorios.precosCodex`
// ({ "<modelo>": { entrada, cacheEntrada, saida } }). A entrada do Codex INCLUI a parte em cache (cobrada à parte, mais
// barata) e o raciocínio é saída. Modelo sem preço na tabela = o preço MAIS ALTO dela (nunca 0) e o resultado vem marcado.
export const PRECOS_CODEX_PADRAO = {
  'gpt-5': { entrada: 1.25, cacheEntrada: 0.125, saida: 10 },
  'gpt-5-codex': { entrada: 1.25, cacheEntrada: 0.125, saida: 10 },
  'gpt-5.1': { entrada: 1.25, cacheEntrada: 0.125, saida: 10 },
  'gpt-5.1-codex': { entrada: 1.25, cacheEntrada: 0.125, saida: 10 },
  'gpt-5.1-codex-max': { entrada: 1.25, cacheEntrada: 0.125, saida: 10 },
  'gpt-5.1-codex-mini': { entrada: 0.25, cacheEntrada: 0.025, saida: 2 },
  'gpt-5-mini': { entrada: 0.25, cacheEntrada: 0.025, saida: 2 },
  'gpt-5.2': { entrada: 1.75, cacheEntrada: 0.175, saida: 14 },
  'gpt-5.2-codex': { entrada: 1.75, cacheEntrada: 0.175, saida: 14 },
};

const precoValido = (p) => p && typeof p === 'object' && num(p.entrada) && p.entrada >= 0 && num(p.saida) && p.saida >= 0;

// Padrões + sobrescritas da config (entradas inválidas são ignoradas). Chave em minúsculas.
export function tabelaPrecosCodex(extra) {
  const t = {};
  const poe = (k, p) => { t[String(k).trim().toLowerCase()] = { entrada: p.entrada, cacheEntrada: num(p.cacheEntrada) && p.cacheEntrada >= 0 ? p.cacheEntrada : p.entrada, saida: p.saida }; };
  for (const [k, p] of Object.entries(PRECOS_CODEX_PADRAO)) poe(k, p);
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const [k, p] of Object.entries(extra)) if (String(k).trim() && precoValido(p)) poe(k, p);
  }
  return t;
}

// → { preco:{entrada,cacheEntrada,saida}, semPreco:boolean }. semPreco = o modelo não está na tabela (vale o mais alto).
export function precoDoModelo(modelo, tabela = tabelaPrecosCodex()) {
  const achado = tabela[String(modelo ?? '').trim().toLowerCase()];
  if (achado) return { preco: achado, semPreco: false };
  let maior = null;
  for (const p of Object.values(tabela)) if (!maior || p.saida > maior.saida || (p.saida === maior.saida && p.entrada > maior.entrada)) maior = p;
  return { preco: maior || { entrada: 0, cacheEntrada: 0, saida: 0 }, semPreco: true };
}

// Tokens acumulados do thread → US$ acumulados (arredondado). tokens sem números = null (nada a somar).
export function custoCodexUsd(tokens, modelo, tabela = tabelaPrecosCodex()) {
  if (!tokens || typeof tokens !== 'object') return null;
  const n = (x) => (num(Number(x)) && Number(x) > 0 ? Number(x) : 0);
  const entrada = n(tokens.entrada), cache = Math.min(n(tokens.cacheEntrada), entrada), saida = n(tokens.saida), rac = n(tokens.raciocinio), total = n(tokens.total);
  if (!entrada && !saida && !rac && !total) return null;
  // raciocínio conta como saída; se o total mostra que a saída já o inclui (total = entrada + saída), não soma de novo
  const racSeparado = total > 0 && total >= entrada + saida + rac ? rac : total > 0 ? 0 : rac;
  const { preco, semPreco } = precoDoModelo(modelo, tabela);
  const usd = ((entrada - cache) * preco.entrada + cache * preco.cacheEntrada + (saida + racSeparado) * preco.saida) / 1e6;
  return { usd: arredondar(usd), semPreco, preco };
}

// O modelo tem preço na tabela (padrão ou `precosCodex`)? Modelo vazio = o padrão do Codex, que o Orbit não conhece: false.
export function modeloTemPreco(modelo, tabela = tabelaPrecosCodex()) {
  return !!tabela[String(modelo ?? '').trim().toLowerCase()];
}

// Cobrança por DIFERENÇA de tokens (não de US$): `cobrado` = o último total acumulado do thread já somado ao custo (persistido
// por thread, atravessa gerações do app-server, resume e mudança de preço/modelo). Devolve { delta, cobrado } novos: `delta` é o
// que ainda não foi cobrado (campo a campo, nunca negativo) e `cobrado` só cresce. Total que caiu (contador recomeçado)
// não gera cobrança nem baixa a base.
export const CAMPOS_TOKENS = ['entrada', 'cacheEntrada', 'saida', 'raciocinio', 'total'];
export function deltaTokens(cobrado, tokens) {
  const n = (x) => (num(Number(x)) && Number(x) > 0 ? Number(x) : 0);
  const delta = {}, novo = {};
  for (const c of CAMPOS_TOKENS) {
    const t = n(tokens?.[c]), b = n(cobrado?.[c]);
    novo[c] = Math.max(t, b);
    delta[c] = Math.max(0, t - b);
  }
  return { delta, cobrado: novo };
}
