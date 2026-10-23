// Teste do orçamento dos escritórios (escritorio-orcamento.mjs, puro). node --test testes/escritorio-orcamento.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { avaliar, chaveCusto, custoCodexUsd, deltaTokens, diaLocal, modeloTemPreco, novoCusto, planoPct, PRECOS_CODEX_PADRAO, precoDoModelo, restante, somarCusto, tabelaPrecosCodex, virarDia } from '../escritorio-orcamento.mjs';

const orc = { porExecucaoUsd: 2, porDiaUsd: 10, avisoPct: 80 };

test('diaLocal usa o dia local, não o UTC', () => {
  assert.equal(diaLocal(new Date(2026, 9, 21, 23, 59, 59)), '2026-10-21');
  assert.equal(diaLocal(new Date(2026, 9, 22, 0, 0, 1)), '2026-10-22');
  assert.equal(diaLocal(new Date(2026, 0, 5, 12)), '2026-01-05');
});

test('somarCusto soma a diferença do acumulado por sessão', () => {
  const t0 = new Date(2026, 9, 21, 10);
  let ctx = { custo: novoCusto({ agora: t0 }), ultimos: {} };
  let r = somarCusto(ctx, 'a', 0.3, { agora: t0 });
  assert.equal(r.delta, 0.3);
  ctx = r;
  r = somarCusto(ctx, 'a', 0.5, { agora: t0 });
  assert.equal(r.delta, 0.2);
  assert.equal(r.custo.execucaoUsd, 0.5);
  ctx = r;
  r = somarCusto(ctx, 'b', 0.25, { agora: t0 });
  assert.equal(r.custo.execucaoUsd, 0.75);
  assert.equal(r.custo.diaUsd, 0.75);
  ctx = r;
  // evento repetido com o mesmo acumulado não soma de novo
  r = somarCusto(ctx, 'a', 0.5, { agora: t0 });
  assert.equal(r.delta, 0);
  // o contador da sessão caiu (recomeçou): vale o novo valor inteiro
  r = somarCusto(ctx, 'a', 0.1, { agora: t0 });
  assert.equal(r.delta, 0.1);
  // não altera o que veio
  assert.equal(ctx.custo.execucaoUsd, 0.75);
  // custo inválido não soma
  assert.equal(somarCusto(ctx, 'a', undefined, { agora: t0 }).delta, 0);
  assert.equal(somarCusto(ctx, 'a', -1, { agora: t0 }).delta, 0);
});

test('virada do dia à meia-noite local zera só o dia', () => {
  const t0 = new Date(2026, 9, 21, 23, 50);
  const t1 = new Date(2026, 9, 22, 0, 5);
  let ctx = { custo: novoCusto({ agora: t0 }), ultimos: {} };
  ctx = somarCusto(ctx, 'a', 1, { agora: t0 });
  assert.equal(ctx.custo.diaUsd, 1);
  const v = virarDia(ctx.custo, t1);
  assert.equal(v.dia, '2026-10-22');
  assert.equal(v.diaUsd, 0);
  assert.equal(v.execucaoUsd, 1);
  const r = somarCusto(ctx, 'a', 1.5, { agora: t1 });
  assert.equal(r.custo.dia, '2026-10-22');
  assert.equal(r.custo.diaUsd, 0.5);
  assert.equal(r.custo.execucaoUsd, 1.5);
  // novoCusto de um dia diferente do gasto guardado zera o dia
  assert.equal(novoCusto({ agora: t1, diaUsd: 4, dia: '2026-10-21' }).diaUsd, 0);
  assert.equal(novoCusto({ agora: t0, diaUsd: 4, dia: '2026-10-21' }).diaUsd, 4);
});

test('plano: diferença do % entre início e agora, nunca negativa', () => {
  const t = new Date(2026, 9, 21, 10);
  let r = { custo: novoCusto({ agora: t, planoPct: 20 }), ultimos: {} };
  assert.equal(planoPct(r.custo), 0);
  r = somarCusto(r, 'a', 0.1, { agora: t, planoPct: 27.5 });
  assert.equal(planoPct(r.custo), 7.5);
  r = somarCusto(r, 'a', 0.2, { agora: t, planoPct: 5 }); // janela de 5 h virou
  assert.equal(planoPct(r.custo), 0);
  assert.equal(planoPct({ planoPctInicio: null, planoPctAgora: null }), 0);
});

test('avaliar: aviso em avisoPct (uma vez), pausa em 100% da execução ou do dia', () => {
  const dia = '2026-10-21';
  const c = (e, d) => ({ execucaoUsd: e, diaUsd: d, dia });
  let a = avaliar(c(1.5, 1.5), orc, {});
  assert.deepEqual(a.avisar, []);
  assert.equal(a.estourou, null);
  a = avaliar(c(1.6, 1.6), orc, {});
  assert.deepEqual(a.avisar, [{ tipo: 'execucao', pct: 80 }]);
  assert.equal(a.avisos.execucao, true);
  const b = avaliar(c(1.8, 1.8), orc, a.avisos);
  assert.deepEqual(b.avisar, []);
  const e = avaliar(c(2, 2), orc, b.avisos);
  assert.equal(e.estourou, 'orcamento-execucao');
  assert.deepEqual(e.avisar, []);
  const d = avaliar(c(0.5, 10), orc, {});
  assert.equal(d.estourou, 'orcamento-dia');
  assert.equal(avaliar(c(2, 10), orc, {}).estourou, 'orcamento-dia'); // o dia tem prioridade
  // aviso do dia: uma vez por dia
  const x = avaliar(c(0.1, 8), orc, {});
  assert.deepEqual(x.avisar, [{ tipo: 'dia', pct: 80 }]);
  assert.equal(avaliar(c(0.1, 8.5), orc, x.avisos).avisar.length, 0);
  assert.equal(avaliar({ execucaoUsd: 0.1, diaUsd: 8.5, dia: '2026-10-22' }, orc, x.avisos).avisar.length, 1);
});

test('restante nunca fica negativo', () => {
  assert.deepEqual(restante({ execucaoUsd: 2.5, diaUsd: 3 }, orc), { execucaoUsd: 0, diaUsd: 7 });
});

// P1-6: o total_cost_usd é por processo; com a geração na chave, o processo novo (acordar/adotar) soma o total inteiro.
test('P1-6: a chave sessao:geracao não subtrai o total de um processo anterior', () => {
  const t0 = new Date(2026, 9, 21, 10);
  assert.equal(chaveCusto('s1'), 's1');
  assert.equal(chaveCusto('s1', 3), 's1:3');
  let ctx = { custo: novoCusto({ agora: t0 }), ultimos: {} };
  ctx = somarCusto(ctx, 's1', 0.5, { agora: t0, geracao: 1 });
  assert.equal(ctx.custo.execucaoUsd, 0.5);
  // mesmo processo: diferença
  ctx = somarCusto(ctx, 's1', 0.6, { agora: t0, geracao: 1 });
  assert.equal(ctx.delta, 0.1);
  // processo novo da mesma sessão chega a 0.7 no 1º result: vale 0.7 inteiro (sem a chave, daria 0.1)
  ctx = somarCusto(ctx, 's1', 0.7, { agora: t0, geracao: 2 });
  assert.equal(ctx.delta, 0.7);
  assert.equal(ctx.custo.execucaoUsd, 1.3);
  assert.deepEqual(Object.keys(ctx.ultimos).sort(), ['s1:1', 's1:2']);
  // result repetido do mesmo processo não soma de novo
  assert.equal(somarCusto(ctx, 's1', 0.7, { agora: t0, geracao: 2 }).delta, 0);
  // sem geração (compatibilidade): continua valendo a regra "valor que cai recomeça"
  const sem = somarCusto(somarCusto({ custo: novoCusto({ agora: t0 }), ultimos: {} }, 'x', 0.5, { agora: t0 }), 'x', 0.2, { agora: t0 });
  assert.equal(sem.delta, 0.2);
});

// ───────────────────────── Codex: custo estimado (tokens × preço) ─────────────────────────

const M = 1_000_000;

test('custoCodexUsd: entrada × saída pelo preço do modelo (US$ por milhão), arredondado', () => {
  // gpt-5.2-codex: 1,75 entrada / 14 saída
  const r = custoCodexUsd({ entrada: M, cacheEntrada: 0, saida: 100_000, raciocinio: 0, total: 1_100_000 }, 'gpt-5.2-codex');
  assert.equal(r.usd, 3.15);
  assert.equal(r.semPreco, false);
  assert.deepEqual(r.preco, { entrada: 1.75, cacheEntrada: 0.175, saida: 14 });
  assert.equal(custoCodexUsd({ entrada: 1, saida: 0, total: 1 }, 'gpt-5.2-codex').usd, 0.000002, '6 casas');
  // nome do modelo sem diferenciar maiúsculas e com espaços
  assert.equal(custoCodexUsd({ entrada: M, total: M }, '  GPT-5.2-Codex ').semPreco, false);
  // números como texto valem; lixo vale 0
  assert.equal(custoCodexUsd({ entrada: String(M), saida: 'abc', total: String(M) }, 'gpt-5.2-codex').usd, 1.75);
});

test('custoCodexUsd: a parte em cache da entrada é cobrada à parte (e nunca passa da entrada)', () => {
  // 1M de entrada, 400 mil em cache: 600 mil × 1,75 + 400 mil × 0,175
  assert.equal(custoCodexUsd({ entrada: M, cacheEntrada: 400_000, saida: 0, total: M }, 'gpt-5.2-codex').usd, 1.12);
  // cache maior que a entrada (dado estranho): limitado à entrada
  assert.equal(custoCodexUsd({ entrada: M, cacheEntrada: 2 * M, saida: 0, total: M }, 'gpt-5.2-codex').usd, 0.175);
  // sem preço de cache na tabela, o cache custa o preço da entrada
  const t = tabelaPrecosCodex({ x: { entrada: 2, saida: 8 } });
  assert.equal(t.x.cacheEntrada, 2);
  assert.equal(custoCodexUsd({ entrada: M, cacheEntrada: M, saida: 0, total: M }, 'x', t).usd, 2);
});

test('custoCodexUsd: raciocínio soma como saída, salvo se o total mostra que a saída já o inclui', () => {
  const base = { entrada: M, cacheEntrada: 0, saida: M, raciocinio: M };
  assert.equal(custoCodexUsd({ ...base, total: 3 * M }, 'gpt-5.2').usd, 29.75, 'total = entrada + saída + raciocínio: raciocínio à parte');
  assert.equal(custoCodexUsd({ ...base, total: 2 * M }, 'gpt-5.2').usd, 15.75, 'total = entrada + saída: o raciocínio já está na saída');
  assert.equal(custoCodexUsd({ ...base }, 'gpt-5.2').usd, 29.75, 'sem total: soma o raciocínio');
});

test('custoCodexUsd: sem tokens utilizáveis devolve null (nada a somar)', () => {
  for (const t of [null, undefined, 'x', 5, {}, { entrada: 0, saida: 0, total: 0 }, { entrada: -5, saida: 'a' }]) assert.equal(custoCodexUsd(t, 'gpt-5.2-codex'), null, JSON.stringify(t));
});

test('custoCodexUsd: modelo sem preço usa o preço MAIS ALTO da tabela (nunca 0) e vem marcado', () => {
  const mais = precoDoModelo('gpt-5.2').preco;
  for (const m of ['gpt-futuro', '', undefined, null]) {
    const r = custoCodexUsd({ entrada: M, saida: 0, total: M }, m);
    assert.equal(r.semPreco, true, String(m));
    assert.deepEqual(r.preco, mais);
    assert.equal(r.usd, 1.75);
    assert.ok(r.usd > 0);
  }
  // o "mais alto" é o de maior saída (desempate pela entrada), entre padrões e sobrescritas
  const t = tabelaPrecosCodex({ caro: { entrada: 1, saida: 99 }, 'caro-2': { entrada: 5, saida: 99 } });
  assert.deepEqual(precoDoModelo('desconhecido', t), { preco: t['caro-2'], semPreco: true });
  assert.equal(custoCodexUsd({ entrada: 0, saida: M, total: M }, 'desconhecido', t).usd, 99);
  // modelo que está na tabela não é "sem preço"
  assert.equal(precoDoModelo('caro', t).semPreco, false);
});

test('tabelaPrecosCodex: padrões + sobrescritas da config; entradas inválidas ignoradas; não altera os padrões', () => {
  const padrao = JSON.stringify(PRECOS_CODEX_PADRAO);
  const t = tabelaPrecosCodex({
    'GPT-5.2-Codex': { entrada: 10, cacheEntrada: 1, saida: 20 },
    'neg': { entrada: -1, saida: 1 }, 'sem-saida': { entrada: 1 }, 'texto': { entrada: 'a', saida: 'b' }, '  ': { entrada: 1, saida: 1 }, 'nulo': null,
  });
  assert.deepEqual(t['gpt-5.2-codex'], { entrada: 10, cacheEntrada: 1, saida: 20 }, 'sobrescreve (chave em minúsculas)');
  assert.deepEqual(t['gpt-5.2'], { ...PRECOS_CODEX_PADRAO['gpt-5.2'] }, 'os outros padrões ficam');
  for (const k of ['neg', 'sem-saida', 'texto', '', 'nulo']) assert.equal(t[k], undefined, k);
  assert.equal(JSON.stringify(PRECOS_CODEX_PADRAO), padrao);
  for (const ruim of [null, undefined, 'x', 3, ['a']]) assert.deepEqual(tabelaPrecosCodex(ruim), tabelaPrecosCodex());
  // com a sobrescrita o custo muda; sem ela, volta ao padrão
  assert.equal(custoCodexUsd({ entrada: M, saida: 0, total: M }, 'gpt-5.2-codex', t).usd, 10);
  assert.equal(custoCodexUsd({ entrada: M, saida: 0, total: M }, 'gpt-5.2-codex').usd, 1.75);
  // uma sobrescrita cara muda o "preço mais alto" dos modelos desconhecidos
  assert.equal(custoCodexUsd({ entrada: M, saida: 0, total: M }, 'qualquer', t).usd, 10);
});

test('deltaTokens (P1-2): cobra só a diferença campo a campo; a base cobrada nunca cai (geração nova, contador recomeçado)', () => {
  const t1 = { entrada: 1000, cacheEntrada: 400, saida: 100, raciocinio: 20, total: 1100 };
  let r = deltaTokens(null, t1);
  assert.deepEqual(r.delta, t1, 'primeira vez: tudo é novo');
  assert.deepEqual(r.cobrado, t1);
  // mesmo total (evento repetido, geração nova que semeia o rollout): nada a cobrar
  r = deltaTokens(r.cobrado, t1);
  assert.deepEqual(r.delta, { entrada: 0, cacheEntrada: 0, saida: 0, raciocinio: 0, total: 0 });
  // cresceu: só a diferença
  r = deltaTokens(r.cobrado, { entrada: 1500, cacheEntrada: 400, saida: 130, raciocinio: 20, total: 1630 });
  assert.deepEqual(r.delta, { entrada: 500, cacheEntrada: 0, saida: 30, raciocinio: 0, total: 530 });
  // total que CAIU (contador recomeçado): sem cobrança e a base não baixa
  const antes = r.cobrado;
  r = deltaTokens(antes, { entrada: 100, cacheEntrada: 0, saida: 10, raciocinio: 0, total: 110 });
  assert.deepEqual(r.delta, { entrada: 0, cacheEntrada: 0, saida: 0, raciocinio: 0, total: 0 });
  assert.deepEqual(r.cobrado, antes);
  // lixo vira 0
  assert.deepEqual(deltaTokens(undefined, { entrada: 'x', saida: -3 }).delta, { entrada: 0, cacheEntrada: 0, saida: 0, raciocinio: 0, total: 0 });
  // trocar preço/modelo não cobra de novo: o mesmo delta de tokens precificado com outro modelo é só o delta
  const d = deltaTokens({ entrada: M, cacheEntrada: 0, saida: 0, raciocinio: 0, total: M }, { entrada: M + 500_000, cacheEntrada: 0, saida: 0, raciocinio: 0, total: M + 500_000 }).delta;
  assert.equal(custoCodexUsd(d, 'gpt-5.1-codex-mini').usd, 0.125);
});

test('modeloTemPreco (P2-5): tabela padrão ou sobrescrita; vazio e desconhecido não têm', () => {
  assert.equal(modeloTemPreco('gpt-5.2-codex'), true);
  assert.equal(modeloTemPreco('  GPT-5.2  '), true);
  assert.equal(modeloTemPreco('gpt-novo'), false);
  assert.equal(modeloTemPreco(''), false);
  assert.equal(modeloTemPreco(undefined), false);
  assert.equal(modeloTemPreco('gpt-novo', tabelaPrecosCodex({ 'gpt-novo': { entrada: 3, saida: 9 } })), true);
});
