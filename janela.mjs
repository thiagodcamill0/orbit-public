// Orbit — janela de contexto de cada modelo (20/10).
// A status line dá a janela real da sessão principal; subagentes e sessões sem status line só têm o id do
// modelo no transcript. Esta tabela cobre esses casos. Fonte: tabela de modelos da Anthropic (06/10/2026):
// 1M em Fable/Mythos, Opus 4.6+, Sonnet 4.6+ e Haiku 5+; 200 mil no resto (Haiku 4.5, Sonnet/Opus 4.5 e
// anteriores). Sufixo "[1m]" = 1M em qualquer modelo. Id desconhecido (sem "claude-") → null: quem chama decide.
// A página tem uma cópia desta regra (janelaDoModelo no index.html); o teste janela.test confere as duas.

export const JANELA_1M = 1000000;
export const JANELA_200K = 200000;

export function janelaDoModelo(modelo) {
  const m = String(modelo || '').trim().toLowerCase();
  if (!m) return null;
  if (/\[1m\]$/.test(m)) return JANELA_1M;
  if (!m.startsWith('claude-')) return null;
  if (/^claude-(fable|mythos)\b/.test(m)) return JANELA_1M;
  const v = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:\b|-|$)/.exec(m);
  if (!v) return JANELA_200K;
  const maior = Number(v[2]);
  const menor = v[3] !== undefined ? Number(v[3]) : 0;
  if (maior >= 5) return JANELA_1M;
  if (maior === 4 && menor >= 6 && v[1] !== 'haiku') return JANELA_1M;
  return JANELA_200K;
}

// Porcentagem inteira da janela (0 a 100), ou null sem janela.
export function pctDaJanela(tokens, janela) {
  return janela > 0 ? Math.min(100, Math.max(0, Math.round((tokens / janela) * 100))) : null;
}

// { tokens, modelo } → { tokens, modelo, janela, pct } quando a janela do modelo é conhecida.
export function comJanela(c) {
  if (!c || !(c.tokens > 0)) return c;
  const janela = janelaDoModelo(c.modelo);
  return janela ? { ...c, janela, pct: pctDaJanela(c.tokens, janela) } : c;
}
