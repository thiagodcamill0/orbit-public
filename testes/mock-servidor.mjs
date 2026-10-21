// Servidor falso do Gerenciador de instâncias — implementa a API do servidor com dados
// inventados, para desenvolver e testar o index.html sem o backend real.
//
//   node testes/mock-servidor.mjs                 → http://127.0.0.1:47823
//   MOCK_PORTA=47830 node testes/mock-servidor.mjs
//   ROTEIRO=0   congela os dados (capturas de tela determinísticas)
//   ROTEIRO_MS=5000  intervalo entre os passos do roteiro (padrão 5 s)
//   Rodada 5: /sessao/:id/conversa(/fluxo), /acoes, mensagem, compactar, limpar, assumir,
//   devolver e permissao (ver o bloco "controle das instâncias").
//   Rodada 6, etapa 2: GET /modelos, POST /instancias, POST /sessao/:id/modelo e /esforco,
//   s.modelo/s.esforco, s.origem e controle.modelo/esforco/modoPermissao (bloco "instâncias do Orbit").
//   MOCK_SEM_MODELOS=1  GET /modelos responde 503 (como o servidor antes de ler os modelos)
//   Rodada 6, etapa 3: POST /sessao/:id/parar e /modo, controle.permissao com tipo ferramenta | pergunta |
//   plano (sugestoes, perguntas, plano), controle.pendentes, controle.tarefas e `event: parcial` no SSE da
//   conversa (bloco "conversa completa"). Sessões do Orbit: "Revisar fluxo de login" (ferramenta com sugestões
//   e fila de 2), "Biblioteca de gráficos" (pergunta, uma delas múltipla), "Importar planilhas de pesagem"
//   (plano) e "Painel de pesagens ao vivo" (trabalhando, com tarefas em segundo plano e texto ao vivo).
//   Etapa 4 (ciclo de vida): controle.processo/dormiu/interrompida/memoria/ultimaAtividade, POST /sessao/:id/encerrar
//   e /retomar, GET /instancias + SSE `instancias`, config.instancias.dormirApos. "Relatório de ração por baia"
//   dorme por ociosidade; "Migração do banco de pesagens" foi pausada pelo reinício (interrompida). Mensagem,
//   compactar e limpar acordam (Acao "Retomando a instância…"); modelo/esforço/modo dormindo → pendente.
//   MOCK_DORMIR_MS=20000  sobrepõe o dormirApos (minutos) no roteiro.
//
// Sem dependências. Não grava nada em disco. Nunca use 47821 (produção) nem 47822 (Backend).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const PAGINA = path.join(PASTA, '..', 'index.html');
const PORTA = Number(process.env.MOCK_PORTA || 47823);
const ROTEIRO = process.env.ROTEIRO !== '0';
const PASSO_MS = Number(process.env.ROTEIRO_MS || 5000);
const T = Date.now();
const MIN = 60e3;

const config = {
  notificar: { concluida: true, aguardando: true, erro: true, interrompida: false, lembrete: true },
  som: { ativo: true, volume: 0.6 },
  naoPerturbe: { ativo: false, agendado: false, inicio: '22:00', fim: '07:00' },
  lembreteMin: 5,
  cliqueAbreVSCode: true, // leitura antiga
  cliqueAbre: 'orbit', // etapa 5: 'orbit' | 'vscode' (clique na notificação)
  projetos: { 'api-exemplo': { icone: 'cubo', cor: '#22c55e' }, site: { icone: '', cor: '#3b82f6' } },
  // Rodada 6: a última escolha da Nova instância (o servidor grava a cada criação bem-sucedida).
  novaInstancia: { pasta: 'D:\\Dev\\Projetos\\Exemplo\\app exemplo', modelo: 'opus', esforco: 'xhigh', permissao: 'default' },
  instancias: { dormirApos: 30, modoPadrao: 'auto', autoCompactar: { ativo: true, limite: 140000, foco: 'Preserve o pedido original do usuário e as demandas principais, as decisões tomadas, o que já foi feito, o que falta fazer, os arquivos alterados, os arquivos de progresso em uso e qualquer restrição ou preferência do usuário.' } }, // etapa 4: minutos sem atividade até a instância dormir (0 = nunca); modo das novas; 20/10: compactação automática
};

// Uso do plano (status line do Claude Code), como o servidor real expõe em /estado, inicio e SSE `uso`.
const uso = { cincoHoras: { pct: 42, renova: T + 2 * 3600e3 + 13 * MIN }, semanal: { pct: 18, renova: T + 3 * 86400e3 }, atualizado: T };
const resumoDia = { data: new Date(T).toISOString().slice(0, 10), turnos: 37, msTrabalhando: 3 * 3600e3 + 12 * MIN, msAguardando: 41 * MIN, esperas: 9, sessoes: 11 };

const RESPOSTA_LONGA = [
  '## Resumo',
  '',
  'Pronto. Troquei as cores dos **botões de ação** para o verde do tema e tirei as *sombras decorativas*.',
  '',
  'O que mudou:',
  '- `BotaoContorno` passa a usar `cores.borda` no fio de 1 px e `cores.texto` no rótulo;',
  '- o estado pressionado ganhou `cores.neutro` em vez da opacidade de 0,6;',
  '- `BotaoPrimario` mantém o verde, mas o texto sobe para **peso 600**.',
  '',
  '### Como conferi',
  '',
  '1. Rodei a suíte de `.verificacao/` (42 de 42 passaram).',
  '2. Conferi em 360, 390 e 430 pt: nada transborda e o alvo de toque continua com 44 pt.',
  '3. Revisei o contraste com a [ferramenta do WebAIM](https://webaim.org/resources/contrastchecker/).',
  '',
  'O trecho principal ficou assim:',
  '',
  '```tsx',
  'export function BotaoContorno({ rotulo, onPress }: Props) {',
  '  return <Pressable style={[estilos.base, { borderColor: cores.borda }]} onPress={onPress}>{rotulo}</Pressable>;',
  '}',
  '```',
  '',
  'Não mexi no tema escuro, que ainda usa os tons antigos. Se quiser, faço numa próxima rodada.',
  '',
  'Arquivos: src/components/ui/BotaoContorno.tsx, src/components/ui/BotaoPrimario.tsx, src/theme/cores.ts.',
].join('\n');

function sessao(base) {
  const s = {
    id: base.id,
    status: 'nova',
    desde: T,
    titulo: '',
    apelido: '',
    projeto: 'app exemplo',
    cwd: 'D:\\Dev\\Projetos\\Exemplo\\app exemplo',
    tarefa: '',
    primeira: '',
    detalhe: '',
    ferramenta: null,
    turno: { inicio: T, ferramentas: 0 },
    ultimaResposta: '',
    contexto: null,
    subagentes: 0,
    contadores: { turnos: 0, ferramentas: 0, esperas: 0, msTrabalhando: 0, msAguardando: 0 },
    fixada: false,
    silenciada: false,
    pid: 10000 + Math.floor(Math.random() * 50000),
    vivo: true,
    inicio: T - 2 * 3600e3,
    atividade: T,
    ...base,
  };
  if (!s.primeira) s.primeira = s.tarefa;
  return s;
}

const lista = [
  sessao({
    id: '3f2a9c1e-7b44-4d0a-9e15-2c8d6a0b1f01', status: 'aguardando', desde: T - 7 * MIN, atividade: T - 7 * MIN,
    titulo: 'Revisar fluxo de login', tarefa: 'Rode a suíte de autenticação e me diga o que quebra antes de mexer no NovaSenhaScreen.',
    detalhe: 'Aprovar Bash: npm run test -- --watch=false src/features/auth', fixada: true,
    contexto: { tokens: 182_000, modelo: 'claude-opus-4-1' }, turno: { inicio: T - 9 * MIN, ferramentas: 14 },
    contadores: { turnos: 6, ferramentas: 88, esperas: 3, msTrabalhando: 52 * MIN, msAguardando: 14 * MIN },
  }),
  sessao({
    id: '8b6e1d20-55c3-4a8f-b7d2-91e0c4f3a702', status: 'erro', desde: T - 2 * MIN, atividade: T - 2 * MIN,
    titulo: 'Migrar tabela de lotes', projeto: 'api-exemplo', cwd: 'D:\\Dev\\Projetos\\Exemplo\\api-exemplo',
    tarefa: 'Escreva a migração que separa lote e baia e rode contra o banco local.',
    detalhe: 'API Error: 529 Overloaded — a API está sobrecarregada, tente de novo em instantes.',
    contexto: { tokens: 144_000, modelo: 'claude-sonnet-4-5' },
    contadores: { turnos: 3, ferramentas: 21, esperas: 1, msTrabalhando: 18 * MIN, msAguardando: 2 * MIN },
  }),
  sessao({
    id: 'c41f7a09-2e8b-4b6c-8d3a-5f9e0b2c7d03', status: 'aguardando', desde: T - 40e3, atividade: T - 40e3,
    titulo: 'Paginação da lista de animais', projeto: 'site', cwd: 'D:\\Dev\\Projetos\\Exemplo\\site',
    tarefa: 'A lista de animais está lenta com 4 mil cabeças; proponha um plano.',
    detalhe: 'Pergunta: Prefere manter a paginação no servidor ou carregar tudo e filtrar no cliente?',
    contexto: { tokens: 23_400, modelo: 'claude-opus-4-1' },
    contadores: { turnos: 2, ferramentas: 9, esperas: 1, msTrabalhando: 6 * MIN, msAguardando: 40e3 },
  }),
  sessao({
    id: 'd92b0e4a-6c17-4f35-a1e8-3b7c9d5f2e04', status: 'trabalhando', desde: T - 3 * MIN, atividade: T - 4e3,
    titulo: 'Refatorar BarraInferior', tarefa: 'Separe a geometria da BarraInferior em funções puras e cubra com testes.',
    ferramenta: { nome: 'Edit', alvo: 'src/components/ui/barra-inferior/geometria.ts', desde: T - 4e3 },
    subagentes: 2, contexto: { tokens: 64_120, modelo: 'claude-opus-4-1' }, turno: { inicio: T - 3 * MIN, ferramentas: 23 },
    contadores: { turnos: 9, ferramentas: 140, esperas: 2, msTrabalhando: 71 * MIN, msAguardando: 6 * MIN },
  }),
  sessao({
    id: 'e7a3c5f1-9d28-4e60-b4f9-0a1d2c3e4f05', status: 'trabalhando', desde: T - 12 * MIN, atividade: T - 7 * MIN,
    titulo: 'Relatório de pesagens de setembro', projeto: 'scripts', cwd: 'D:\\Dev\\Projetos\\Exemplo\\scripts',
    tarefa: 'Gere o relatório de pesagens de setembro em CSV, por lote.',
    ferramenta: { nome: 'Bash', alvo: 'node scripts/relatorio.mjs --mes 2026-09 --saida pesagens.csv', desde: T - 7 * MIN },
    contexto: { tokens: 31_000, modelo: 'claude-sonnet-4-5' },
    contadores: { turnos: 1, ferramentas: 12, esperas: 0, msTrabalhando: 12 * MIN, msAguardando: 0 },
  }),
  sessao({
    id: 'f0c8b2d6-4a71-4c9e-8f53-6e2b1a0d9c06', status: 'concluida', desde: T - 90e3, atividade: T - 90e3,
    titulo: 'Ajuste de cores dos botões', tarefa: 'Os botões de ação estão com sombra e cor errada; padronize com o tema.',
    ultimaResposta: RESPOSTA_LONGA, contexto: { tokens: 98_700, modelo: 'claude-opus-4-1' },
    contadores: { turnos: 4, ferramentas: 37, esperas: 1, msTrabalhando: 22 * MIN, msAguardando: 3 * MIN },
  }),
  sessao({
    id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c07', status: 'interrompida', desde: T - 25 * MIN, atividade: T - 25 * MIN,
    titulo: 'Corrigir testes do runner', tarefa: 'Os testes de .verificacao não importam .tsx; descubra por quê.',
    ultimaResposta: 'Estou conferindo o loader do node:test…',
    contexto: { tokens: 12_800, modelo: 'claude-haiku-4-5' },
    contadores: { turnos: 2, ferramentas: 6, esperas: 0, msTrabalhando: 4 * MIN, msAguardando: 0 },
  }),
  sessao({
    id: '2c284886-fa49-43c5-9e17-a971c9ff0308', status: 'concluida', desde: T - 80 * MIN, atividade: T - 80 * MIN,
    titulo: 'Notificador de instâncias Claude Code', apelido: 'Gerenciador v2', silenciada: true,
    tarefa: 'Evolua ao máximo o gerenciador de instâncias do Claude Code.',
    ultimaResposta: 'Contrato escrito em API.md; Backend e Frontend seguem em paralelo.',
    contexto: { tokens: 231_400, modelo: 'claude-opus-4-1' }, subagentes: 0,
    contadores: { turnos: 12, ferramentas: 210, esperas: 5, msTrabalhando: 96 * MIN, msAguardando: 21 * MIN },
  }),
  sessao({
    id: '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b09', status: 'nova', desde: T - 10e3, atividade: T - 10e3,
    titulo: '', tarefa: '', primeira: '', projeto: 'app exemplo', inicio: T - 10e3,
  }),
  sessao({
    id: '0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e10', status: 'encerrada', desde: T - 3 * 3600e3, atividade: T - 3 * 3600e3,
    titulo: 'Busca no brain por referências de site', tarefa: 'busque no brain quais as referências de site que temos lá',
    detalhe: 'other', vivo: false, contexto: { tokens: 8_900, modelo: 'claude-sonnet-4-5' },
    contadores: { turnos: 1, ferramentas: 4, esperas: 0, msTrabalhando: 2 * MIN, msAguardando: 0 },
  }),
  sessao({
    id: '7d6c5b4a-3928-4170-a6f5-e4d3c2b1a011', status: 'encerrada', desde: T - 5 * 3600e3, atividade: T - 5 * 3600e3,
    titulo: 'Botão de voltar padronizado', tarefa: 'Padronize o BotaoVoltar em todas as telas de autenticação.',
    detalhe: 'prompt_input_exit', vivo: false, fixada: false,
    contadores: { turnos: 5, ferramentas: 61, esperas: 2, msTrabalhando: 33 * MIN, msAguardando: 9 * MIN },
  }),
];

// Rodada 2: nome e registro do Claude Code, agentes internos e sessões dependentes.
for (const s of lista) {
  s.nome = s.nome ?? (s.status === 'encerrada' ? '' : 'app-exemplo-' + s.id.slice(0, 2));
  s.pai = s.pai ?? null;
  s.registro = s.status === 'encerrada' ? null : { status: s.status === 'trabalhando' ? 'busy' : 'idle', waitingFor: s.status === 'aguardando' ? 'permission' : null, atualizado: s.atividade };
  s.agentes = s.agentes || [];
}
function agente(id, tipo, descricao, status, inicioAtras, extra = {}) {
  return { id, tipo, descricao, status, inicio: T - inicioAtras, fim: status === 'concluido' || status === 'erro' ? T - Math.floor(inicioAtras / 3) : null, ferramenta: null, ferramentas: 0, atividade: T, ...extra };
}
// Subagente ao vivo: feed curto (acoes) e última mensagem (texto).
const acao = (nome, alvo, atras, durMs) => ({ nome, alvo, ts: T - atras, fim: durMs == null ? null : T - atras + durMs });
lista[3].agentes = [
  agente('ag-explore', 'Explore', 'Onde a geometria da barra é usada', 'concluido', 150e3, { ferramentas: 14,
    acoes: [acao('Grep', 'raioCentro', 120e3, 300), acao('Read', 'src/components/ui/barra-inferior/BarraInferior.tsx', 110e3, 40)],
    texto: 'A geometria é usada em 3 lugares: BarraInferior.tsx, ItemCentro.tsx e o teste visual.', textoTs: T - 50e3 }),
  agente('ag-tester', 'general-purpose', 'Escrever os testes da geometria', 'trabalhando', 95e3, { ferramentas: 6, ferramenta: { nome: 'Write', alvo: '.verificacao/geometria.test.ts', desde: T - 6e3 },
    acoes: [acao('Read', 'src/components/ui/barra-inferior/geometria.ts', 60e3, 30), acao('Bash', 'npm test -- geometria', 40e3, 9e3), acao('Edit', '.verificacao/geometria.test.ts', 20e3, 50), acao('Write', '.verificacao/geometria.test.ts', 6e3)],
    texto: 'Os 4 casos de borda passam; falta cobrir o raio zero.', textoTs: T - 25e3 }),
  agente('ag-revisor', 'code-reviewer', 'Revisar as funções puras extraídas', 'trabalhando', 40e3, { ferramentas: 3, ferramenta: { nome: 'Read', alvo: 'src/components/ui/barra-inferior/geometria.ts', desde: T - 3e3 },
    acoes: [acao('Grep', 'caminhoBarra', 30e3, 200), acao('Read', 'src/components/ui/barra-inferior/geometria.ts', 3e3)] }),
];
lista[3].subagentes = 2;
lista.push(sessao({
  id: '5b4a3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c12', status: 'aguardando', desde: T - 75e3, atividade: T - 75e3, pai: lista[7].id,
  nome: 'gerenciador-tester', titulo: 'Tester do gerenciador', projeto: 'Gerenciador', cwd: 'D:\\Dev\\Projetos\\Gerenciador',
  tarefa: 'Rode a bateria de testes contra o servidor real na porta 47822.', detalhe: 'Aprovar Bash: node --test testes/backend.test.mjs',
  registro: { status: 'idle', waitingFor: 'permission', atualizado: T - 75e3 }, agentes: [],
  contexto: { tokens: 41200, modelo: 'claude-sonnet-4-5' }, inicio: T - 9 * MIN,
  contadores: { turnos: 1, ferramentas: 8, esperas: 1, msTrabalhando: 7 * MIN, msAguardando: 0 },
}));
lista.push(sessao({
  id: '6c5b4a3d-2e1f-4b0a-9d8c-7f6e5d4c3b13', status: 'trabalhando', desde: T - 4 * MIN, atividade: T - 2e3, pai: lista[7].id,
  nome: 'gerenciador-backend', titulo: 'Backend do gerenciador', projeto: 'Gerenciador', cwd: 'D:\\Dev\\Projetos\\Gerenciador',
  tarefa: 'Implemente a rodada 2 do contrato no servidor.mjs.', ferramenta: { nome: 'Edit', alvo: 'servidor.mjs', desde: T - 2e3 },
  registro: { status: 'busy', waitingFor: null, atualizado: T - 2e3 }, agentes: [],
  contexto: { tokens: 120500, modelo: 'claude-opus-4-1' }, inicio: T - 30 * MIN,
  contadores: { turnos: 3, ferramentas: 64, esperas: 0, msTrabalhando: 22 * MIN, msAguardando: 0 },
}));
lista[7].status = 'trabalhando';
lista[7].desde = T - 30 * MIN;
lista[7].ferramenta = { nome: 'Agent', alvo: 'Backend e Tester em paralelo', desde: T - 30 * MIN };
lista[7].registro = { status: 'busy', waitingFor: null, atualizado: T };
lista[7].atividade = T - 20e3;
lista[7].silenciada = false;
lista[7].projeto = 'Gerenciador';
// Sessão dependente cuja mãe não está na lista (grupo "fora da lista").
lista.push(sessao({
  id: '7d6c5b4e-3f20-4c1b-8e9d-0a1b2c3d4e14', status: 'concluida', desde: T - 6 * MIN, atividade: T - 6 * MIN, pai: 'ffff0000-dead-4bee-8f00-000000000000',
  nome: 'site-verificador', titulo: 'Verificar links do site', projeto: 'site', cwd: 'D:\\Dev\\Projetos\\Exemplo\\site',
  tarefa: 'Confira se algum link do rodapé quebrou.', ultimaResposta: 'Nenhum link quebrado.', agentes: [], registro: null,
  contadores: { turnos: 1, ferramentas: 5, esperas: 0, msTrabalhando: 2 * MIN, msAguardando: 0 },
}));
{
  const hAgora = new Date(T).getHours();
  const porHora = { trabalhandoMs: Array(24).fill(0), concluidas: Array(24).fill(0), esperas: Array(24).fill(0), aguardandoMs: Array(24).fill(0) };
  const forma = [0.2, 0.5, 0.9, 0.4, 0.7, 1, 0.8, 0.3, 0.6, 0.95, 0.5, 0.75];
  for (let i = 2; i < 12; i++) {
    const hh = (hAgora - 11 + i + 24) % 24;
    porHora.trabalhandoMs[hh] = Math.round(forma[i] * 48 * MIN);
    porHora.aguardandoMs[hh] = Math.round(forma[(i + 5) % 12] * 9 * MIN);
    porHora.concluidas[hh] = Math.round(forma[(i + 3) % 12] * 6);
    porHora.esperas[hh] = Math.round(forma[(i + 7) % 12] * 4);
  }
  resumoDia.porHora = porHora;
}

const sessoes = new Map(lista.map((s) => [s.id, s]));
const eventos = new Map();
const historico = [];
const clientes = new Set();
let proximoAlerta = 1;

function evento(id, ts, tipo, texto) {
  if (!eventos.has(id)) eventos.set(id, []);
  const l = eventos.get(id);
  l.push({ ts, tipo, texto });
  if (l.length > 200) l.splice(0, l.length - 200);
}

// Linhas do tempo de partida.
for (const s of lista) {
  let t = s.inicio;
  evento(s.id, t, 'inicio', 'Sessão iniciada');
  if (s.primeira) evento(s.id, (t += 20e3), 'prompt', s.primeira);
  const ferramentas = [
    ['Read', 'src/components/ui/BarraInferior.tsx'], ['Grep', 'cores.neutro'], ['Bash', 'git status'],
    ['Edit', 'src/theme/cores.ts'], ['Bash', 'npm run test'], ['Glob', 'src/**/*.tsx'], ['Write', 'src/features/home/Pendencias.tsx'],
  ];
  const n = Math.min(10, s.contadores.ferramentas || 0);
  for (let i = 0; i < n; i++) {
    const [nome, alvo] = ferramentas[i % ferramentas.length];
    t = Math.min(s.desde - 1000, t + 40e3);
    evento(s.id, t, 'ferramenta', `${nome} · ${alvo}`);
    if (i === 4 && s.contadores.esperas) evento(s.id, t + 2000, 'permissao', `Aprovar ${nome}: ${alvo}`);
    if (i === 6 && s.subagentes) evento(s.id, t + 1000, 'subagente', 'Subagente Explore iniciado');
  }
  const fim = { aguardando: s.detalhe.startsWith('Pergunta') ? 'pergunta' : 'permissao', erro: 'erro', concluida: 'concluida', interrompida: 'interrompida', encerrada: 'fim' }[s.status];
  if (fim) evento(s.id, s.desde, fim, s.detalhe || (fim === 'concluida' ? 'Turno concluído' : fim === 'interrompida' ? 'Interrompida pelo usuário' : ''));
}

function difundir(tipo, dados) {
  if (tipo === 'sessao' && dados) atualizarControle(dados);
  const linha = `event: ${tipo}\ndata: ${JSON.stringify(dados)}\n\n`;
  for (const res of clientes) res.write(linha);
  if (tipo === 'sessao') difundirInstancias(); // etapa 4
}

function minutos(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function naoPerturbeAgora() {
  const np = config.naoPerturbe;
  if (np.ativo) return true;
  if (!np.agendado) return false;
  const d = new Date();
  const agora = d.getHours() * 60 + d.getMinutes();
  const ini = minutos(np.inicio);
  const fim = minutos(np.fim);
  return ini <= fim ? agora >= ini && agora < fim : agora >= ini || agora < fim;
}

// Como o servidor real: o alerta leva um resumo da sessão; o resto vem do mapa local.
function resumoSessao(s) {
  const { id, titulo, apelido, nome, pai, projeto, cwd, status, detalhe, tarefa } = s;
  return { id, titulo, apelido, nome, pai, projeto, cwd, status, detalhe, tarefa, ultimaResposta: String(s.ultimaResposta || '').slice(0, 300) };
}

function alertar(tipo, s, quando = Date.now(), notificarForcado, ag = null) {
  // Dependente (sessão com pai ou subagente): só avisa quando precisa do usuário.
  const dependente = !!(s.pai || ag);
  const notificar = notificarForcado ?? (config.notificar[tipo] !== false && !naoPerturbeAgora() && !s.silenciada && (!dependente || tipo === 'aguardando' || tipo === 'lembrete'));
  const a = { id: proximoAlerta++, tipo, quando, sessao: resumoSessao(s), notificar };
  if (ag) a.agente = { id: ag.id, tipo: ag.tipo, descricao: ag.descricao };
  historico.unshift(a);
  if (historico.length > 300) historico.length = 300;
  difundir('alerta', a);
  return a;
}

// Histórico de partida (o mais novo primeiro).
{
  const passados = [
    ['concluida', 5, -95 * MIN], ['aguardando', 0, -60 * MIN], ['concluida', 7, -80 * MIN], ['erro', 1, -2 * MIN],
    ['aguardando', 0, -7 * MIN], ['concluida', 5, -90e3], ['aguardando', 2, -40e3], ['interrompida', 6, -25 * MIN],
    ['lembrete', 0, -2 * MIN], ['concluida', 3, -30 * MIN], ['aguardando', 3, -45 * MIN],
  ].sort((a, b) => a[2] - b[2]);
  for (const [tipo, i, dt] of passados) {
    const s = lista[i];
    historico.unshift({ id: proximoAlerta++, tipo, quando: T + dt, sessao: resumoSessao(s), notificar: tipo !== 'interrompida' && !s.silenciada });
  }
}

function mudar(s, status, extra = {}) {
  const agora = Date.now();
  const anterior = s.status;
  const dt = agora - s.desde;
  if (anterior === 'trabalhando') { s.contadores.msTrabalhando += dt; resumoDia.msTrabalhando += dt; }
  if (anterior === 'aguardando') { s.contadores.msAguardando += dt; resumoDia.msAguardando += dt; }
  Object.assign(s, { status, desde: agora, atividade: agora, detalhe: '' }, extra);
  if (status !== 'trabalhando') s.ferramenta = null;
  if (status === 'aguardando') { s.contadores.esperas++; resumoDia.esperas++; }
  if (status === 'concluida') { s.contadores.turnos++; resumoDia.turnos++; }
  difundir('sessao', s);
  difundir('resumo', resumoDia);
}

const FERRAMENTAS = [
  ['Read', 'src/components/ui/barra-inferior/ItemCentro.tsx'], ['Grep', 'raioCentro'], ['Edit', 'src/components/ui/barra-inferior/geometria.ts'],
  ['Bash', 'node --test .verificacao/barra-inferior.test.ts'], ['Write', '.verificacao/geometria.test.ts'], ['Task', 'Explore: onde a geometria é usada'],
];

let passo = 0;
function rodarPasso() {
  const agora = Date.now();
  const [s1, , , s4, , s6, , , s9] = lista;
  // A sessão 4 sempre troca de ferramenta enquanto trabalha.
  if (s4.status === 'trabalhando') {
    const [nome, alvo] = FERRAMENTAS[passo % FERRAMENTAS.length];
    s4.ferramenta = { nome, alvo, desde: agora };
    s4.atividade = agora;
    s4.contadores.ferramentas++;
    s4.turno.ferramentas++;
    s4.contexto.tokens = Math.min(199_000, s4.contexto.tokens + 2300);
    evento(s4.id, agora, 'ferramenta', `${nome} · ${alvo}`);
    difundir('sessao', s4);
  }
  switch (passo % 10) {
    case 0:
      mudar(s9, 'trabalhando', { titulo: 'Tela de configurações do pátio', tarefa: 'Crie a tela de configurações do pátio, com os cochos e as baias.', primeira: s9.primeira || 'Crie a tela de configurações do pátio, com os cochos e as baias.', ferramenta: { nome: 'Read', alvo: 'src/features/configuracoes/Topo.tsx', desde: agora }, contexto: { tokens: 9_000, modelo: 'claude-opus-4-1' } });
      evento(s9.id, agora, 'prompt', s9.tarefa);
      break;
    case 1:
      mudar(s4, 'concluida', { ultimaResposta: 'Geometria separada em 4 funções puras (raioCentro, arcoRecorte, pontosDaAba, caminhoBarra), com 12 testes novos em .verificacao/geometria.test.ts. Todos passam.', subagentes: 0 });
      evento(s4.id, agora, 'concluida', 'Turno concluído');
      alertar('concluida', s4);
      break;
    case 2:
      mudar(s6, 'trabalhando', { tarefa: 'Agora aplique o mesmo padrão no tema escuro.', ferramenta: { nome: 'Grep', alvo: 'sombra', desde: agora } });
      evento(s6.id, agora, 'prompt', s6.tarefa);
      break;
    case 3:
      mudar(s9, 'aguardando', { detalhe: 'Aprovar Write: src/features/configuracoes/patio/PatioScreen.tsx' });
      evento(s9.id, agora, 'permissao', s9.detalhe);
      alertar('aguardando', s9);
      break;
    case 4:
      mudar(s6, 'concluida', { ultimaResposta: RESPOSTA_LONGA.replace('Pronto.', 'Tema escuro ajustado.') });
      evento(s6.id, agora, 'concluida', 'Turno concluído');
      alertar('concluida', s6);
      mudar(s9, 'trabalhando', { ferramenta: { nome: 'Write', alvo: 'src/features/configuracoes/patio/PatioScreen.tsx', desde: agora } });
      break;
    case 5:
      mudar(s4, 'trabalhando', { tarefa: 'Agora faça o mesmo com o ItemCentro.', subagentes: 1, turno: { inicio: agora, ferramentas: 0 } });
      evento(s4.id, agora, 'prompt', s4.tarefa);
      break;
    case 6:
      mudar(s9, 'erro', { detalhe: 'StopFailure: tool_use sem tool_result correspondente (400).' });
      evento(s9.id, agora, 'erro', s9.detalhe);
      alertar('erro', s9);
      break;
    case 7:
      if (s1.status === 'aguardando') alertar('lembrete', s1);
      break;
    case 8:
      mudar(s9, 'interrompida', { ultimaResposta: 'Comecei a montar o PatioScreen…' });
      evento(s9.id, agora, 'interrompida', 'Interrompida pelo usuário');
      alertar('interrompida', s9);
      break;
    case 9:
      mudar(s9, 'nova', { titulo: '', tarefa: '', ferramenta: null });
      break;
  }
  rodarAgentes(agora);
  rodarEtapa3(agora);
  uso.cincoHoras.pct = Math.min(100, uso.cincoHoras.pct + 1);
  uso.atualizado = agora;
  difundir('uso', uso);
  passo++;
}

// Roteiro dos dependentes: agentes do time de "Refatorar BarraInferior" e sessões do time do Gerenciador.
function rodarAgentes(agora) {
  const s4 = lista[3];
  const tester = s4.agentes.find((a) => a.id === 'ag-tester');
  const revisor = s4.agentes.find((a) => a.id === 'ag-revisor');
  const k = passo % 10;
  if (tester && k === 2 && s4.status === 'trabalhando') {
    tester.status = 'aguardando';
    tester.ferramenta = null;
    s4.status = 'aguardando';
    s4.desde = agora;
    s4.detalhe = 'Aprovar Bash: node --test .verificacao/geometria.test.ts';
    s4.ferramenta = null;
    difundir('sessao', s4);
    alertar('aguardando', s4, agora, undefined, tester);
    evento(s4.id, agora, 'permissao', '[general-purpose] ' + s4.detalhe);
  }
  if (tester && k === 4 && tester.status === 'aguardando') {
    tester.status = 'trabalhando';
    tester.ferramenta = { nome: 'Bash', alvo: 'node --test .verificacao/geometria.test.ts', desde: agora };
    if (s4.status === 'aguardando') { s4.status = 'trabalhando'; s4.desde = agora; s4.detalhe = ''; }
    difundir('sessao', s4);
  }
  if (revisor && k === 6) {
    revisor.status = revisor.status === 'concluido' ? 'trabalhando' : 'concluido';
    revisor.fim = revisor.status === 'concluido' ? agora : null;
    revisor.ferramenta = revisor.status === 'concluido' ? null : { nome: 'Grep', alvo: 'caminhoBarra', desde: agora };
    evento(s4.id, agora, 'subagente', (revisor.status === 'concluido' ? 'Terminou ' : 'Iniciou ') + 'code-reviewer: ' + revisor.descricao);
  }
  for (const a of s4.agentes) if (a.status === 'trabalhando') { a.ferramentas++; a.atividade = agora; }
  s4.subagentes = s4.agentes.filter((a) => a.status === 'trabalhando' || a.status === 'aguardando').length;
  difundir('sessao', s4);
  const testerSessao = lista.find((s) => s.nome === 'gerenciador-tester');
  if (testerSessao) {
    if (k === 1) mudar(testerSessao, 'trabalhando', { ferramenta: { nome: 'Bash', alvo: 'node --test testes/backend.test.mjs', desde: agora } });
    if (k === 7) { mudar(testerSessao, 'aguardando', { detalhe: 'Aprovar Bash: node testes/mock-servidor.mjs' }); alertar('aguardando', testerSessao); }
  }
  const backend = lista.find((s) => s.nome === 'gerenciador-backend');
  if (backend && backend.status === 'trabalhando') {
    const [nome, alvo] = [['Edit', 'servidor.mjs'], ['Bash', 'node --test testes/backend.test.mjs'], ['Read', 'API.md']][passo % 3];
    backend.ferramenta = { nome, alvo, desde: agora };
    backend.atividade = agora;
    backend.contexto.tokens = Math.min(195000, backend.contexto.tokens + 1500);
    difundir('sessao', backend);
  }
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      const t = Buffer.concat(partes).toString('utf8');
      try { resolve(t ? JSON.parse(t) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function responder(res, codigo, corpo, tipo = 'application/json; charset=utf-8') {
  res.writeHead(codigo, { 'content-type': tipo, 'cache-control': 'no-store' });
  res.end(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
}

function mesclar(alvo, parcial) {
  for (const [k, v] of Object.entries(parcial || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && alvo[k] && typeof alvo[k] === 'object') mesclar(alvo[k], v);
    else if (k in alvo) alvo[k] = v;
  }
}

// ===================== Rodada 5: controle das instâncias e conversa =====================
// Modos: lista[0] em `orbit` (com pedido de permissão pendente), lista[2] e lista[3] em `canal`,
// o resto em `nenhum`. As ações evoluem por etapas e mandam SSE `acao` no /fluxo.
// Erros de propósito: a 1ª compactação de cada sessão falha (529); mensagem com "falhar" falha;
// assumir "Migrar tabela de lotes" encerra o processo mas não sobe no Orbit.
const LIMITE_ORBIT = 5;
const conversas = new Map(); // id → itens[]
const acoesPorSessao = new Map(); // id → Acao[]
const clientesConversa = new Map(); // id → Set(res)
const compactadas = new Set();
const iniciandoOrbit = new Set();
let seqItem = 1, seqAcao = 1;

for (const s of lista) s.controle = { modo: 'nenhum', podeAssumir: false };
lista[0].controle = {
  modo: 'orbit', podeAssumir: false, pid: 48211, desde: T - 26 * MIN, ocupada: false,
  permissao: { id: 'perm-1', ferramenta: 'Bash', resumo: 'npm run test -- --watch=false src/features/auth', entrada: { command: 'npm run test -- --watch=false src/features/auth', description: 'Roda a suíte de autenticação uma vez', timeout: 120000 },
    // Etapa 3: tipo, sugestões (rótulo em pt-BR) e a fila (controle.pendentes).
    tipo: 'ferramenta', sugestoes: [{ indice: 0, rotulo: 'Permitir e não perguntar de novo para "npm run test:*" neste projeto' }] },
  pendentes: 2,
  autoCompactar: { ligada: true, limite: 140000, ultima: { quando: T - 18 * MIN, antes: 152_300, depois: 19_800 } }, // 20/10
};
lista[2].controle = { modo: 'canal', podeAssumir: true };
// Etapa 5: sessão do VS Code ao lado das instâncias do Orbit — a Conversa abre em leitura (canal) com o Assumir.
if (lista[2].registro) lista[2].registro.entrypoint = 'claude-vscode';
lista[3].controle = { modo: 'canal', podeAssumir: false };

// ===================== Rodada 6, etapa 2: instâncias do Orbit, modelo e esforço =====================
// Lista como a do `initialize` do claude.exe 2.1.300 (modelos.json da gerenciador-9c): nome e descrição
// vêm em inglês, como o binário manda. Haiku 4.5 não tem esforço; Opus 4.6 e Sonnet 4.6 não têm xhigh.
// Erro de propósito: trocar para "Opus 4.7" é recusado (400), para ver o erro no seletor da Conversa.
const NIVEIS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELOS = [
  ['default', 'claude-fable-5-1', 'Default (recommended)', 'Fable 5.1', NIVEIS],
  ['opus', 'claude-opus-5-5', 'Opus 5.5', 'For complex work and everyday tasks', NIVEIS],
  ['fable', 'claude-fable-5-1', 'Fable 5.1', 'For your toughest challenges', NIVEIS],
  ['sonnet', 'claude-sonnet-5-5', 'Sonnet 5.5', 'Most efficient for simpler tasks', NIVEIS],
  ['haiku', 'claude-haiku-5-5', 'Haiku 5.5', 'Fastest for quick answers', NIVEIS],
  ['claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001', 'Haiku 4.5', 'Fastest for quick answers', []],
  ['claude-sonnet-5', 'claude-sonnet-5', 'Sonnet 5', 'Efficient for routine tasks', NIVEIS],
  ['claude-opus-5', 'claude-opus-5', 'Opus 5', 'Best for everyday, complex tasks', NIVEIS],
  ['claude-fable-5', 'claude-fable-5', 'Fable 5', 'Most capable for your hardest and longest-running tasks', NIVEIS],
  ['claude-opus-4-8', 'claude-opus-4-8', 'Opus 4.8', 'Best for everyday, complex tasks', NIVEIS],
  ['claude-opus-4-7', 'claude-opus-4-7', 'Opus 4.7', 'Best for everyday, complex tasks', NIVEIS],
  ['claude-opus-4-6', 'claude-opus-4-6', 'Opus 4.6', 'Best for everyday, complex tasks', ['low', 'medium', 'high', 'max']],
  ['claude-sonnet-4-6', 'claude-sonnet-4-6', 'Sonnet 4.6', 'Efficient for routine tasks', ['low', 'medium', 'high', 'max']],
].map(([valor, modelo, nome, descricao, esforcos]) => ({ valor, modelo, nome, descricao, esforcos }));
const MODELOS_EM = T - 3 * 3600e3;
const modeloPorValor = (v) => MODELOS.find((m) => m.valor === v) || null;
const PERMISSOES = ['default', 'acceptEdits', 'plan', 'auto'];
// s.modelo / s.esforco: o da última resposta do transcript (vale para todas as sessões). Há ids fora da
// lista de propósito (claude-opus-4-1, claude-sonnet-4-5), para a interface enfeitar o id.
const MODELO_SESSAO = [
  ['claude-opus-5-5', 'xhigh'], ['claude-sonnet-4-5-20250929', 'high'], ['claude-opus-5-5', 'high'], ['claude-opus-4-1', null],
  ['claude-sonnet-5-5', 'medium'], ['claude-fable-5-1', 'max'], ['claude-haiku-4-5-20251001', null], ['claude-opus-5-5', 'xhigh'],
  [null, null], ['claude-sonnet-5-5', 'low'], [null, null],
];
lista.forEach((s, i) => {
  const [m, e] = MODELO_SESSAO[i] || [null, null];
  if (m) s.modelo = m;
  if (e) s.esforco = e;
});
Object.assign(lista[0].controle, { modelo: 'opus', esforco: 'xhigh', modoPermissao: 'default' });

// Etapa 4: o limite conta só os processos vivos (a instância dormindo continua `orbit`).
function orbitAtivos() { let n = 0; for (const s of sessoes.values()) if (s.controle?.modo === 'orbit' && s.controle.processo !== 'dormindo') n++; return n; }
function atualizarControle(s) {
  const c = s.controle || (s.controle = { modo: 'nenhum', podeAssumir: false });
  const trab = s.status === 'trabalhando';
  delete c.motivo;
  if (s.pai) { c.modo = 'nenhum'; c.podeAssumir = false; c.motivo = 'É um subagente: a conversa fica na sessão principal'; return; }
  if (c.modo === 'orbit') {
    c.podeAssumir = false;
    const ini = iniciandoOrbit.has(s.id);
    // Etapa 4: processo iniciando | vivo | dormindo, memória (só viva) e última atividade.
    if (ini) c.processo = 'iniciando';
    else if (!c.processo || (c.processo === 'iniciando' && !acordando.has(s.id))) c.processo = 'vivo';
    const dorme = c.processo === 'dormindo';
    c.ocupada = !dorme && (ini || trab || !!c.permissao);
    c.motivo = ini ? 'Iniciando no Orbit' : dorme ? 'Dormindo' : acordando.has(s.id) ? 'Retomando a instância' : 'Já está no Orbit';
    if (c.processo === 'vivo' && !c.memoria) c.memoria = memoriaNova();
    if (c.processo !== 'vivo') delete c.memoria;
    c.ultimaAtividade = new Date(s.atividade || Date.now()).toISOString();
    return;
  }
  delete c.ocupada; delete c.permissao; delete c.pid; delete c.desde; delete c.pendentes; delete c.tarefas;
  delete c.processo; delete c.dormiu; delete c.interrompida; delete c.memoria; delete c.ultimaAtividade;
  if (trab) { c.podeAssumir = false; c.motivo = 'A sessão está trabalhando'; }
  else if (orbitAtivos() >= LIMITE_ORBIT) { c.podeAssumir = false; c.motivo = 'O Orbit já controla 5 sessões; devolva uma antes'; }
  else c.podeAssumir = true;
  if (c.modo === 'canal' && s.pid) c.pid = s.pid;
}
function atualizarControles() { for (const s of sessoes.values()) atualizarControle(s); }

const item = (tipo, ts, campos = {}) => ({ id: 'it-' + seqItem++, ts, tipo, ...campos });
const PEDIDOS = [
  'Rode a suíte de autenticação e me diga o que quebra antes de mexer no NovaSenhaScreen.',
  'Ok, pode corrigir o teste do token expirado. Não mexa no fluxo de biometria.',
  'Testa isso aqui: <img src=x onerror="alert(1)"> e **não** deve virar HTML.',
  'Agora revise o `useSessao` e veja se o refresh do token dispara duas vezes.',
  'Explica em uma frase por que o teste ficou intermitente.',
];
const RESPOSTAS = [
  'Rodei a suíte: **3 falhas** em `src/features/auth`.\n\n- `NovaSenhaScreen` espera o botão desabilitado com senha curta, mas o componente agora valida só no envio;\n- `token.test.ts` usa um relógio real e quebra perto da virada do minuto;\n- `biometria.test.ts` passa sozinho e falha em conjunto (estado global do mock).\n\nQuer que eu comece pelo relógio do token?',
  'Corrigi o teste do token: troquei o `Date.now()` por `jest.useFakeTimers()` e fixei o relógio em `2026-10-15T12:00:00Z`.\n\n```ts\nbeforeEach(() => {\n  jest.useFakeTimers().setSystemTime(new Date(\'2026-10-15T12:00:00Z\'));\n});\n```\n\nRodei 20 vezes seguidas: **20 de 20** passaram.',
  'O texto chegou como texto puro: `<img src=x onerror="alert(1)">` não vira imagem aqui. Nada a corrigir.',
  'Sim, dispara duas vezes. O `useEffect` do `useSessao` depende de `[token, renovar]`, e `renovar` é recriado a cada render.\n\n1. Envolvi `renovar` em `useCallback`;\n2. Movi o agendamento para um `useRef`;\n3. Cobri com um teste que conta as chamadas.\n\n### Resultado\n\nUma chamada por janela de 14 min, como o servidor espera.',
  'Porque o teste dependia do relógio real e falhava quando a expiração caía na virada do minuto.',
];
const FERR_CONV = [
  ['Bash', 'npm run test -- --watch=false src/features/auth', '> app-exemplo@1.4.0 test\n> jest src/features/auth\n\nPASS src/features/auth/login.test.ts\nFAIL src/features/auth/token.test.ts\n  ● expira o token em 15 min\n    expect(received).toBe(expected)\n    Expected: 900\n    Received: 899\n\nTests: 3 failed, 41 passed, 44 total'],
  ['Read', 'src/features/auth/NovaSenhaScreen.tsx', 'import { useState } from \'react\';\nimport { Botao } from \'@/components/ui\';\n\nexport function NovaSenhaScreen() {\n  const [senha, setSenha] = useState(\'\');\n  // <script>alert("x")</script> continua texto\n  ...'],
  ['Grep', 'useFakeTimers · src/', 'src/features/agenda/agenda.test.ts:12\nsrc/features/pesagem/pesagem.test.ts:8'],
  ['Edit', 'src/features/auth/token.test.ts', 'O arquivo foi atualizado (2 trechos).'],
  ['Glob', 'src/features/auth/**/*.test.ts', 'src/features/auth/login.test.ts\nsrc/features/auth/token.test.ts\nsrc/features/auth/biometria.test.ts'],
  ['Bash', 'npx tsc --noEmit', 'src/features/auth/useSessao.ts(41,7): error TS2345: Argument of type \'string | undefined\' is not assignable to parameter of type \'string\'.', true],
  ['Task', 'Explore: onde o refresh do token é chamado', 'Encontrei 3 chamadas: useSessao.ts:41, interceptador.ts:18 e App.tsx:77.'],
  ['WebFetch', 'https://jestjs.io/docs/timer-mocks', 'Timer Mocks · Jest — useFakeTimers() substitui setTimeout, setInterval e Date.'],
];

function gerarConversa(s, voltas = 46) {
  const itens = [];
  let t = (s.inicio || T - 2 * 3600e3) + 5e3;
  const passo = Math.max(4e3, Math.floor(((s.atividade || T) - t) / (voltas * 9)));
  const prox = () => (t += passo + Math.floor(Math.random() * passo));
  for (let v = 0; v < voltas; v++) {
    if (v === 3) itens.push(item('limpeza', prox()));
    if (v % 20 === 9) itens.push(item('par', prox(), { texto: 'Mensagem do Orbit (sessão "Relatório de pesagens"): terminei o CSV de setembro, pode conferir os totais por lote?' }));
    if (v % 17 === 14) {
      itens.push(item('comando', prox(), { texto: v % 34 === 14 ? '/compact foco nos testes de autenticação' : '/compact' }));
      itens.push(item('compactacao', prox(), v % 34 === 14 ? { pre: 182_000, pos: 24_000, foco: 'testes de autenticação' } : { pre: 156_400, pos: 21_800, auto: true })); // 20/10: a sem foco foi automática
    }
    if (v === 22) itens.push(item('interrupcao', prox()));
    if (v === 27) itens.push(item('erro', prox(), { texto: 'API Error: 529 Overloaded — a API está sobrecarregada, tente de novo em instantes.' }));
    itens.push(item('usuario', prox(), { texto: PEDIDOS[v % PEDIDOS.length] }));
    itens.push(item('pensamento', prox(), { texto: v % 4 === 1 ? '' : 'O usuário quer saber o que quebra antes de mexer. Primeiro rodo a suíte, depois leio os testes que falharam e só então proponho a correção.' }));
    const nf = 1 + (v % 4);
    for (let f = 0; f < nf; f++) {
      const [nome, resumo, saida, erro] = FERR_CONV[(v * 3 + f) % FERR_CONV.length];
      itens.push(item('ferramenta', prox(), { nome, resumo, resultado: { texto: saida, erro: !!erro } }));
    }
    itens.push(item('assistente', prox(), { texto: RESPOSTAS[v % RESPOSTAS.length] }));
  }
  if (s.controle?.modo === 'orbit' && s.controle.permissao) {
    itens.push(item('usuario', prox(), { texto: PEDIDOS[0] }));
    itens.push(item('assistente', prox(), { texto: 'Vou rodar a suíte de autenticação uma vez, sem o modo watch.' }));
  }
  if (s.status === 'trabalhando') itens.push(item('ferramenta', T - 4e3, { nome: s.ferramenta?.nome || 'Read', resumo: s.ferramenta?.alvo || 'src/index.ts' }));
  return itens;
}
function conversaDe(id) {
  if (!conversas.has(id)) {
    const s = sessoes.get(id);
    conversas.set(id, s ? gerarConversa(s, s.status === 'nova' ? 0 : s === lista[0] ? 80 : 8) : []); // ~480 itens na sessão orbit (lista longa)
  }
  return conversas.get(id);
}
function enviarConversa(id, tipo, dados) {
  const linha = `event: ${tipo}\ndata: ${JSON.stringify(dados)}\n\n`;
  for (const res of clientesConversa.get(id) || []) res.write(linha);
}
function acrescentar(id, ...novos) {
  const l = conversaDe(id);
  l.push(...novos);
  enviarConversa(id, 'itens', { itens: novos });
}
function reenviar(id, it) { enviarConversa(id, 'itens', { itens: [it] }); }

function novaAcao(sid, tipo, via, etapa) {
  const a = { id: 'ac-' + seqAcao++, sessao: sid, tipo, estado: 'em_andamento', etapa, via, inicio: Date.now() };
  if (!acoesPorSessao.has(sid)) acoesPorSessao.set(sid, []);
  const l = acoesPorSessao.get(sid);
  l.push(a);
  if (l.length > 20) l.splice(0, l.length - 20);
  difundir('acao', a);
  return a;
}
function evoluir(a, campos) {
  Object.assign(a, campos);
  if (campos.estado && campos.estado !== 'em_andamento') { a.fim = Date.now(); delete a.etapa; }
  difundir('acao', a);
}
const depois = (ms, fn) => setTimeout(fn, ms);

// Volta simulada do agente depois de uma mensagem como o usuário (modo orbit).
function simularVolta(s, texto) {
  if (s.controle) delete s.controle.interrompida; // etapa 4
  mudar(s, 'trabalhando', { tarefa: texto, ferramenta: { nome: 'Read', alvo: 'src/features/auth/useSessao.ts', desde: Date.now() } });
  // Etapa 3: os passos da volta ficam presos à sessão (o Parar cancela) e a resposta chega antes por `parcial`.
  depoisS(s, 700, () => acrescentar(s.id, item('pensamento', Date.now(), { texto: 'Leio o arquivo citado antes de responder.' })));
  const f = item('ferramenta', Date.now() + 1200, { nome: 'Read', resumo: 'src/features/auth/useSessao.ts' });
  depoisS(s, 1200, () => { f.ts = Date.now(); acrescentar(s.id, f); });
  depoisS(s, 2600, () => { f.resultado = { texto: 'export function useSessao() {\n  const [token, setToken] = useState<string | null>(null);\n  …', erro: false }; reenviar(s.id, f); });
  const resp = 'Recebido: “' + texto.slice(0, 80) + (texto.length > 80 ? '…' : '') + '”.\n\nLi o `useSessao.ts` e **não vi** chamada dupla neste trecho. Quer que eu rode os testes de novo?';
  transmitir(s, 2800, resp, (idFinal) => {
    acrescentar(s.id, { id: idFinal, ts: Date.now(), tipo: 'assistente', texto: resp });
    // Etapa 2: a resposta nova grava o modelo e o esforço efetivos no transcript.
    const c = s.controle || {};
    if (c.modo === 'orbit' && c.modelo) {
      const m = modeloPorValor(c.modelo);
      if (m) s.modelo = m.modelo;
      if (c.esforco) s.esforco = c.esforco; else delete s.esforco;
    }
    if (!s.titulo) s.titulo = texto.replace(/\s+/g, ' ').trim().slice(0, 60);
    mudar(s, 'concluida', { ultimaResposta: resp });
  });
}

// POST /instancias: cria uma sessão `origem:'orbit'` que aparece na hora no /fluxo (status 'nova').
// Pasta: precisa ser absoluta; com "inexistente" no caminho, responde 400 (como uma pasta que não existe).
function criarInstancia(res, corpo) {
  const ruim = (erro) => responder(res, 400, { erro });
  const pasta = typeof corpo.pasta === 'string' ? corpo.pasta.trim() : '';
  if (!pasta) return ruim('Escolha a pasta da instância.');
  if (!/^[a-zA-Z]:[\\/]/.test(pasta) && !pasta.startsWith('\\\\')) return ruim('Use o caminho completo da pasta, como D:\\Projetos\\app.');
  if (/inexistente/i.test(pasta)) return ruim('A pasta "' + pasta + '" não existe.');
  const m = corpo.modelo == null || corpo.modelo === '' ? null : modeloPorValor(corpo.modelo);
  if (corpo.modelo && !m) return ruim('Modelo desconhecido: ' + corpo.modelo + '.');
  const esforco = typeof corpo.esforco === 'string' && corpo.esforco ? corpo.esforco : null;
  if (esforco && !(m || modeloPorValor('default')).esforcos.includes(esforco)) return ruim((m ? m.nome : 'O modelo padrão') + ' não aceita o esforço "' + esforco + '".');
  const permissao = corpo.permissao || (PERMISSOES.includes(config.instancias?.modoPadrao) ? config.instancias.modoPadrao : 'auto');
  if (!PERMISSOES.includes(permissao)) return ruim('Modo de permissão inválido: ' + permissao + '.');
  const nome = typeof corpo.nome === 'string' ? corpo.nome.trim() : '';
  if (nome.length > 60) return ruim('O nome pode ter até 60 caracteres.');
  const texto = typeof corpo.texto === 'string' ? corpo.texto : '';
  if (texto.length > 20000) return ruim('A 1ª mensagem pode ter até 20000 caracteres.');
  { const e = abrirVaga(null); if (e) return responder(res, 409, { erro: e, codigo: 'limite' }); } // etapa 4: dorme a elegível mais antiga
  const agora = Date.now();
  const projeto = pasta.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || pasta;
  const s = sessao({
    id: crypto.randomUUID(), status: 'nova', desde: agora, atividade: agora, inicio: agora, turno: null,
    projeto, cwd: pasta, apelido: nome, titulo: '', tarefa: '', primeira: '', origem: 'orbit', pid: 40000 + Math.floor(Math.random() * 9000),
  });
  s.nome = '';
  s.pai = null;
  s.agentes = [];
  s.registro = { status: 'idle', waitingFor: null, atualizado: agora };
  s.controle = { modo: 'orbit', podeAssumir: false, pid: s.pid, desde: agora, ocupada: true, modelo: m ? m.valor : null, esforco, modoPermissao: permissao };
  if (!m) delete s.controle.modelo;
  if (!esforco) delete s.controle.esforco;
  sessoes.set(s.id, s);
  conversas.set(s.id, []);
  iniciandoOrbit.add(s.id);
  atualizarControle(s);
  difundir('sessao', s);
  const a = novaAcao(s.id, 'criar', 'orbit', 'Iniciando');
  responder(res, 202, { acao: a, sessao: s });
  config.novaInstancia = { pasta, modelo: m ? m.valor : null, esforco, permissao };
  difundir('config', config);
  depois(1400, () => {
    iniciandoOrbit.delete(s.id);
    atualizarControle(s);
    difundir('sessao', s);
    evoluir(a, { estado: 'sucesso' });
    if (!texto.trim()) return;
    const am = novaAcao(s.id, 'mensagem', 'orbit', 'Enviando');
    depois(500, () => {
      acrescentar(s.id, item('usuario', Date.now(), { texto }));
      evoluir(am, { estado: 'sucesso' });
      simularVolta(s, texto);
    });
  });
}

// POST /sessao/:id/modelo e /esforco: devolvem o efetivo (o servidor lê por get_settings).
function trocarAjuste(res, s, rota, corpo) {
  const c = s.controle || {};
  if (c.modo !== 'orbit') return responder(res, 409, { erro: 'Assuma no Orbit para trocar o ' + rota + ' desta sessão.', codigo: 'nao_assumida' });
  const atual = modeloPorValor(c.modelo) || MODELOS.find((m) => m.modelo === s.modelo && m.valor !== 'default') || modeloPorValor('default');
  if (rota === 'modelo') {
    const m = modeloPorValor(corpo.modelo);
    if (!m) return responder(res, 400, { erro: 'Modelo desconhecido: ' + String(corpo.modelo || '(vazio)') + '.' });
    if (m.valor === 'claude-opus-4-7') return responder(res, 400, { erro: 'O Claude Code recusou o Opus 4.7 nesta sessão. Escolha outro modelo.' });
    c.modelo = m.valor;
    // O nível que o modelo novo não aceita cai: sem esforço no Haiku 4.5; xhigh vira high no Opus 4.6.
    if (!m.esforcos.length) delete c.esforco;
    else if (c.esforco && !m.esforcos.includes(c.esforco)) c.esforco = 'high';
  } else {
    const e = typeof corpo.esforco === 'string' ? corpo.esforco : '';
    if (!atual.esforcos.length) return responder(res, 400, { erro: atual.nome + ' não tem nível de esforço.' });
    if (!atual.esforcos.includes(e)) return responder(res, 400, { erro: atual.nome + ' não aceita o esforço "' + (e || '(vazio)') + '". Use: ' + atual.esforcos.join(', ') + '.' });
    c.esforco = e;
    if (!c.modelo) c.modelo = atual.valor;
  }
  difundir('sessao', s);
  return responder(res, 200, { modelo: c.modelo || null, esforco: c.esforco || null, ...(c.processo === 'dormindo' ? { pendente: true } : {}) });
}

// ===================== Rodada 6, etapa 3: conversa completa =====================
// Passos de volta presos à sessão (o Parar cancela), texto ao vivo por `event: parcial` (texto acumulado; o item
// `assistente` final chega com o mesmo id), pedidos tipados com fila (controle.pendentes), modo de permissão e
// tarefas em segundo plano. GET /_mock/respostas devolve os últimos corpos de POST /permissao (para os testes).
const timersVolta = new Map(); // id → Set(timeout)
const filaPerm = new Map(); // id → pedidos seguintes
const respostasPerm = [];
let seqPerm = 10;
const novoIdPerm = (pre) => pre + '-' + seqPerm++;
const RE_ACEITAR_EDICOES = /aceit\w*\s+(as\s+)?edi[cç]/i;

function depoisS(s, ms, fn) {
  const id = s.id;
  if (!timersVolta.has(id)) timersVolta.set(id, new Set());
  const set = timersVolta.get(id);
  const t = setTimeout(() => { set.delete(t); fn(); }, ms);
  set.add(t);
  return t;
}
const emVolta = (s) => (timersVolta.get(s.id)?.size || 0) > 0;
function cancelarVolta(s) {
  for (const t of timersVolta.get(s.id) || []) clearTimeout(t);
  timersVolta.delete(s.id);
}
// Manda a resposta aos poucos (3 palavras a cada 110 ms) e depois chama fim(id) para gravar o item final.
function transmitir(s, inicio, texto, fim) {
  const id = 'it-' + seqItem++;
  const pedacos = String(texto).match(/\S+\s*/g) || [String(texto)];
  let acc = '';
  let t = inicio;
  for (let i = 0; i < pedacos.length; i += 3) {
    acc += pedacos.slice(i, i + 3).join('');
    const parcial = acc;
    depoisS(s, t, () => enviarConversa(s.id, 'parcial', { id, texto: parcial }));
    t += 110;
  }
  depoisS(s, t + 350, () => fim(id));
  return id;
}
function detalhePerm(p) {
  if (p.tipo === 'pergunta') return 'Pergunta: ' + (p.perguntas?.[0]?.pergunta || 'o agente quer saber uma coisa');
  if (p.tipo === 'plano') return 'Plano pronto para aprovar: ' + (String(p.plano || '').split('\n')[0].replace(/^#+\s*/, '') || 'plano');
  return 'Aprovar ' + p.ferramenta + ': ' + p.resumo;
}
const tipoEvento = (p) => (p.tipo === 'pergunta' ? 'pergunta' : p.tipo === 'plano' ? 'plano' : 'permissao');
// Pedido novo: status `aguardando` (faixa "Precisa de você") e alerta (notificação), como pelo hook.
function pedirPermissao(s, p, fila = []) {
  const c = s.controle;
  c.permissao = p;
  c.pendentes = 1 + fila.length;
  if (fila.length) filaPerm.set(s.id, fila); else filaPerm.delete(s.id);
  mudar(s, 'aguardando', { detalhe: detalhePerm(p) });
  evento(s.id, Date.now(), tipoEvento(p), s.detalhe);
  alertar('aguardando', s);
}

// ---- pedidos de exemplo (ids novos a cada vez que o roteiro os re-arma) ----
function permsLogin() {
  const bash = {
    id: novoIdPerm('perm'), tipo: 'ferramenta', ferramenta: 'Bash', resumo: 'npm run test -- --watch=false src/features/auth',
    entrada: { command: 'npm run test -- --watch=false src/features/auth', description: 'Roda a suíte de autenticação uma vez', timeout: 120000 },
    sugestoes: [{ indice: 0, rotulo: 'Permitir e não perguntar de novo para "npm run test:*" neste projeto' }],
  };
  return [bash, [permEdit()]];
}
function permEdit() {
  return {
    id: novoIdPerm('perm'), tipo: 'ferramenta', ferramenta: 'Edit', resumo: 'src/features/auth/token.test.ts',
    entrada: { file_path: 'D:\\Dev\\Projetos\\Exemplo\\app exemplo\\src\\features\\auth\\token.test.ts', old_string: 'const agora = Date.now();', new_string: "jest.useFakeTimers().setSystemTime(new Date('2026-10-15T12:00:00Z'));\nconst agora = Date.now();" },
    sugestoes: [{ indice: 0, rotulo: 'Permitir e aceitar edições nesta sessão' }, { indice: 1, rotulo: 'Permitir edições em src/features/auth/ nesta sessão' }],
  };
}
function permGraficos() {
  const perguntas = [
    { pergunta: 'Qual biblioteca de gráficos usar no app?', cabecalho: 'Biblioteca', multipla: false, opcoes: [
      { rotulo: 'Victory Native', descricao: 'Desenha com Skia; aguenta milhares de pontos sem travar a rolagem.' },
      { rotulo: 'react-native-gifted-charts', descricao: 'Mais simples de começar, com menos controle sobre os eixos.' },
      { rotulo: 'Skia direto', descricao: 'Controle total, mas cada gráfico é desenhado à mão.' },
    ] },
    { pergunta: 'Quais telas devem ganhar gráfico nesta rodada?', cabecalho: 'Telas', multipla: true, opcoes: [
      { rotulo: 'Pesagens', descricao: 'Ganho de peso por lote ao longo do tempo.' },
      { rotulo: 'Lotes', descricao: 'Distribuição de peso dentro de cada lote.' },
      { rotulo: 'Financeiro', descricao: 'Custo por arroba e margem do mês.' },
      { rotulo: 'Estoque de ração' },
    ] },
  ];
  return {
    id: novoIdPerm('perg'), tipo: 'pergunta', ferramenta: 'AskUserQuestion', resumo: 'Biblioteca de gráficos e telas',
    entrada: { questions: perguntas.map((q) => ({ question: q.pergunta, header: q.cabecalho, multiSelect: q.multipla, options: q.opcoes.map((o) => ({ label: o.rotulo, description: o.descricao || '' })) })) },
    perguntas,
  };
}
function textoPlano(versao, comentario) {
  return [
    '# Importação de planilhas de pesagem' + (versao > 1 ? ' (versão ' + versao + ')' : ''),
    '',
    'Importar o **.xlsx** que a balança exporta, validar linha a linha e gravar as pesagens por lote, sem duplicar o que já existe.',
    '',
    '## Passos',
    '',
    '1. Criar `src/importacao/lerPlanilha.ts`, que lê a aba "Pesagens" com `exceljs` e devolve linhas tipadas.',
    '2. Validar brinco, data e peso; as linhas ruins vão para um relatório, sem parar a importação.',
    '3. Gravar numa transação por lote, com `ON CONFLICT (brinco, data) DO NOTHING`.',
    '4. Rota `POST /importacoes` com upload até 5 MB e resposta `{ importadas, ignoradas, erros }`.',
    '5. Testes com 3 planilhas reais anonimizadas em `testes/planilhas/`.',
    ...(comentario ? ['', '## Ajustes pedidos', '', '- ' + comentario] : []),
    '',
    '## Riscos',
    '',
    '- A balança antiga exporta a data como texto (`15/10/26`); trato os dois formatos.',
    '- Planilhas acima de 20 mil linhas: leitura em fluxo, não tudo na memória.',
  ].join('\n');
}
function permPlano(versao = 1, comentario = '') {
  const plano = textoPlano(versao, comentario);
  return {
    id: novoIdPerm('plano'), tipo: 'plano', ferramenta: 'ExitPlanMode', resumo: 'Plano: importação de planilhas de pesagem',
    entrada: { plan: plano }, plano,
    sugestoes: [{ indice: 0, rotulo: 'Aprovar e aceitar edições nesta sessão' }],
  };
}

// ---- sessões do Orbit da etapa 3 ----
function sessaoOrbit(base, ctl) {
  const s = sessao({ origem: 'orbit', ...base });
  s.nome = '';
  s.pai = null;
  s.agentes = [];
  s.registro = { status: s.status === 'trabalhando' ? 'busy' : 'idle', waitingFor: s.status === 'aguardando' ? 'permission' : null, atualizado: s.atividade };
  s.controle = { modo: 'orbit', podeAssumir: false, pid: s.pid, desde: s.inicio, ocupada: false, modelo: 'opus', esforco: 'high', modoPermissao: 'default', autoCompactar: { ligada: true, limite: 140000 }, ...ctl };
  lista.push(s);
  sessoes.set(s.id, s);
  evento(s.id, s.inicio, 'inicio', 'Sessão iniciada');
  if (s.primeira) evento(s.id, s.inicio + 20e3, 'prompt', s.primeira);
  return s;
}
const sPerg = sessaoOrbit({
  id: 'a1b2c3d4-0e1f-4a2b-9c3d-4e5f6a7b8c15', status: 'aguardando', desde: T - 3 * MIN, atividade: T - 3 * MIN, inicio: T - 14 * MIN,
  titulo: 'Biblioteca de gráficos do app', tarefa: 'Quero gráficos de pesagem no app. Escolha a biblioteca comigo antes de instalar qualquer coisa.',
  modelo: 'claude-opus-5-5', esforco: 'high', contexto: { tokens: 18_400, modelo: 'claude-opus-5-5' },
  contadores: { turnos: 1, ferramentas: 6, esperas: 1, msTrabalhando: 9 * MIN, msAguardando: 0 },
});
const sPlano = sessaoOrbit({
  id: 'b2c3d4e5-1f20-4b3c-8d4e-5f6a7b8c9d16', status: 'aguardando', desde: T - 5 * MIN, atividade: T - 5 * MIN, inicio: T - 22 * MIN,
  titulo: 'Importar planilhas de pesagem', projeto: 'api-exemplo', cwd: 'D:\\Dev\\Projetos\\Exemplo\\api-exemplo',
  tarefa: 'Planeje a importação das planilhas da balança. Só planeje; não mexa em nada antes de eu aprovar.',
  modelo: 'claude-fable-5-1', esforco: 'xhigh', contexto: { tokens: 52_300, modelo: 'claude-fable-5-1' },
  contadores: { turnos: 1, ferramentas: 14, esperas: 1, msTrabalhando: 16 * MIN, msAguardando: 0 },
}, { modelo: 'fable', esforco: 'xhigh', modoPermissao: 'plan' });
const sTrab = sessaoOrbit({
  id: 'c3d4e5f6-2031-4c4d-9e5f-6a7b8c9d0e17', status: 'trabalhando', desde: T - 6 * MIN, atividade: T - 3e3, inicio: T - 40 * MIN,
  titulo: 'Painel de pesagens ao vivo', tarefa: 'Monte o painel de pesagens com atualização ao vivo e deixe o servidor de dev rodando.',
  ferramenta: { nome: 'Edit', alvo: 'src/features/painel/PainelPesagens.tsx', desde: T - 3e3 },
  modelo: 'claude-sonnet-5-5', esforco: 'medium', contexto: { tokens: 87_900, modelo: 'claude-sonnet-5-5' }, turno: { inicio: T - 6 * MIN, ferramentas: 19 },
  contadores: { turnos: 4, ferramentas: 61, esperas: 2, msTrabalhando: 31 * MIN, msAguardando: 4 * MIN },
}, {
  modelo: 'sonnet', esforco: 'medium', modoPermissao: 'acceptEdits',
  tarefas: [
    { id: 'bg-dev', tipo: 'local_bash', descricao: 'npm run dev (Expo na porta 8081)' },
    { id: 'bg-explore', tipo: 'local_agent', descricao: 'Explore: onde o SSE de pesagens é consumido' },
  ],
});
// ===================== Etapa 4: ciclo de vida (dormir, retomar, limite, memória, reinício) =====================
// A instância dormindo continua `controle.modo:'orbit'`, com processo:'dormindo' e o motivo em `dormiu`.
// Mensagem, compactar, limpar e POST /retomar acordam (uma vez só, mesmo com duas ações seguidas).
const acordando = new Map(); // id → funções que esperam a instância acordar
const memoriaNova = () => Math.round((222 + Math.random() * 40) * 1048576);
var sigInstancias = ''; // var: difundir('sessao') pode rodar antes desta linha
function resumoInstancias() {
  let vivas = 0, dormindo = 0, memoria = 0;
  for (const s of sessoes.values()) {
    const c = s.controle;
    if (c?.modo !== 'orbit') continue;
    if (c.processo === 'dormindo') dormindo++;
    else { vivas++; memoria += Number(c.memoria) || 0; }
  }
  return { max: LIMITE_ORBIT, vivas, dormindo, memoria, dormirApos: Number(config.instancias?.dormirApos ?? 30) };
}
function difundirInstancias() {
  if (typeof sessoes === 'undefined') return;
  const r = resumoInstancias();
  const sig = JSON.stringify(r);
  if (sig === sigInstancias) return;
  sigInstancias = sig;
  difundir('instancias', r);
}
const acaoAndando = (s) => (acoesPorSessao.get(s.id) || []).some((a) => a.estado === 'em_andamento');
function elegivelDormir(s) {
  const c = s.controle;
  if (c?.modo !== 'orbit' || c.processo !== 'vivo') return false;
  atualizarControle(s);
  return !c.ocupada && !c.permissao && !(c.tarefas || []).length && !emVolta(s) && !acaoAndando(s) && !acordando.has(s.id);
}
function dormir(s, motivo, interrompida) {
  const c = s.controle;
  c.processo = 'dormindo';
  c.dormiu = { motivo, em: new Date().toISOString() };
  if (interrompida) c.interrompida = true;
  delete c.memoria;
  delete c.tarefas; // as tarefas em segundo plano morrem com o processo
  difundir('sessao', s);
}
// No limite (5 vivas): dorme a elegível com a atividade mais antiga; sem nenhuma, devolve o erro (pt-BR).
function abrirVaga(alvo) {
  if (orbitAtivos() < LIMITE_ORBIT) return null;
  const vivas = [...sessoes.values()].filter((x) => x !== alvo && x.controle?.modo === 'orbit' && x.controle.processo !== 'dormindo');
  const eleg = vivas.filter(elegivelDormir).sort((a, b) => (a.atividade || 0) - (b.atividade || 0));
  if (!eleg.length) return 'As 5 instâncias vivas estão ocupadas (' + vivas.map((x) => '"' + (x.apelido || x.titulo || x.id.slice(0, 8)) + '"').join(', ') + '). Espere uma terminar ou encerre uma.';
  dormir(eleg[0], 'limite');
  return null;
}
function acordar(s, fn) {
  const c = s.controle;
  if (acordando.has(s.id)) { acordando.get(s.id).push(fn); return; }
  if (c?.processo !== 'dormindo') { fn(); return; }
  acordando.set(s.id, [fn]);
  c.processo = 'iniciando';
  difundir('sessao', s);
  depois(1600, () => { // --resume com o modelo, o esforço e o modo do registro (inclusive os trocados dormindo)
    c.processo = 'vivo';
    delete c.dormiu;
    c.memoria = memoriaNova();
    c.pid = 40000 + Math.floor(Math.random() * 9000);
    const fns = acordando.get(s.id) || [];
    acordando.delete(s.id);
    difundir('sessao', s);
    for (const f of fns) { try { f(); } catch (e) { console.error(e); } }
  });
}
function encerrarInstancia(res, s, corpo) {
  const c = s.controle || {};
  if (c.modo !== 'orbit') return responder(res, 409, { erro: 'O Orbit não controla esta sessão.', codigo: 'nao_assumida' });
  if (c.processo === 'dormindo') return responder(res, 409, { erro: 'A instância já está dormindo.', codigo: 'dormindo' });
  atualizarControle(s);
  const motivos = [];
  if (c.permissao) motivos.push('esperando a sua resposta');
  else if (c.ocupada) motivos.push('no meio de uma resposta');
  if ((c.tarefas || []).length) motivos.push((c.tarefas.length === 1 ? 'com 1 tarefa' : 'com ' + c.tarefas.length + ' tarefas') + ' em segundo plano');
  if (motivos.length && corpo.forcar !== true) return responder(res, 409, { erro: 'A instância está ' + motivos.join(' e ') + '. Confirme para interromper e encerrar.', codigo: 'ocupada' });
  const forcada = motivos.length > 0;
  const a = novaAcao(s.id, 'encerrar', 'orbit', forcada ? 'Interrompendo a resposta' : 'Fechando o processo');
  responder(res, 202, { acao: a });
  if (forcada) {
    cancelarVolta(s);
    delete c.permissao;
    delete c.pendentes;
    filaPerm.delete(s.id);
    if (s.status === 'trabalhando' || s.status === 'aguardando') { acrescentar(s.id, item('interrupcao', Date.now())); mudar(s, 'interrompida'); }
  }
  depois(forcada ? 700 : 300, () => evoluir(a, { etapa: 'Fechando o processo' }));
  depois(forcada ? 1500 : 1100, () => { dormir(s, 'manual'); evoluir(a, { estado: 'sucesso' }); });
}
function retomarInstancia(res, s) {
  const c = s.controle || {};
  if (c.modo !== 'orbit') return responder(res, 409, { erro: 'O Orbit não controla esta sessão.', codigo: 'nao_assumida' });
  if (c.processo !== 'dormindo') return responder(res, 409, { erro: acordando.has(s.id) ? 'A instância já está acordando.' : 'A instância já está viva.', codigo: 'viva' });
  const e = abrirVaga(s);
  if (e) return responder(res, 409, { erro: e, codigo: 'limite' });
  const a = novaAcao(s.id, 'retomar', 'orbit', 'Retomando a instância…');
  responder(res, 202, { acao: a });
  acordar(s, () => evoluir(a, { estado: 'sucesso' }));
}
// Roteiro: memória que varia (como o tasklist a cada 30 s) e o dormir por ociosidade.
function rodarEtapa4(agora) {
  if (passo % 6 === 0) {
    for (const s of sessoes.values()) {
      const c = s.controle;
      if (c?.modo !== 'orbit' || c.processo !== 'vivo' || !c.memoria) continue;
      c.memoria = Math.max(150 * 1048576, c.memoria + Math.round((Math.random() * 16 - 6) * 1048576));
      difundir('sessao', s);
    }
  }
  const ms = process.env.MOCK_DORMIR_MS ? Number(process.env.MOCK_DORMIR_MS) : Number(config.instancias?.dormirApos ?? 30) * 60e3;
  if (!(ms > 0)) return;
  for (const s of sessoes.values()) if (elegivelDormir(s) && agora - (s.atividade || 0) > ms) dormir(s, 'ocioso');
}
const sDorme = sessaoOrbit({
  id: 'd4e5f6a7-3142-4d5e-8f60-7b8c9d0e1f18', status: 'concluida', desde: T - 34 * MIN, atividade: T - 42 * MIN, inicio: T - 70 * MIN,
  titulo: 'Relatório de ração por baia', projeto: 'scripts', cwd: 'D:\\Dev\\Projetos\\Exemplo\\scripts',
  tarefa: 'Gere o consumo de ração por baia da última semana, em CSV.', ultimaResposta: 'CSV gerado em saida/racao-semana.csv: 18 baias, 41,2 t no total.',
  modelo: 'claude-sonnet-5-5', esforco: 'low', contexto: { tokens: 22_100, modelo: 'claude-sonnet-5-5' },
  contadores: { turnos: 2, ferramentas: 9, esperas: 0, msTrabalhando: 6 * MIN, msAguardando: 0 },
}, { modelo: 'sonnet', esforco: 'low', processo: 'dormindo', dormiu: { motivo: 'ocioso', em: new Date(T - 12 * MIN).toISOString() } });
const sPausa = sessaoOrbit({
  id: 'e5f6a7b8-4253-4e6f-9071-8c9d0e1f2a19', status: 'interrompida', desde: T - 25 * MIN, atividade: T - 25 * MIN, inicio: T - 95 * MIN, origem: undefined,
  titulo: 'Migração do banco de pesagens', projeto: 'api-exemplo', cwd: 'D:\\Dev\\Projetos\\Exemplo\\api-exemplo',
  tarefa: 'Migre a tabela de pesagens para o esquema novo, em lotes de 10 mil linhas.', ultimaResposta: 'Migrando o lote 7 de 12…',
  modelo: 'claude-opus-5-5', esforco: 'high', contexto: { tokens: 118_000, modelo: 'claude-opus-5-5' },
  contadores: { turnos: 3, ferramentas: 44, esperas: 1, msTrabalhando: 38 * MIN, msAguardando: 2 * MIN },
}, { modelo: 'opus', esforco: 'high', processo: 'dormindo', dormiu: { motivo: 'reinicio', em: new Date(T - 25 * MIN).toISOString() }, interrompida: true });
delete sPausa.origem; // assumida do VS Code (Devolver continua valendo)
{
  let t = sDorme.inicio + 20e3;
  const n = () => (t += 30e3);
  conversas.set(sDorme.id, [
    item('usuario', n(), { texto: sDorme.tarefa }),
    item('ferramenta', n(), { nome: 'Bash', resumo: 'node scripts/racao.mjs --semana --saida saida/racao-semana.csv', resultado: { texto: '18 baias · 41,2 t', erro: false } }),
    item('assistente', n(), { texto: sDorme.ultimaResposta }),
  ]);
  t = sPausa.inicio + 20e3;
  conversas.set(sPausa.id, [
    item('usuario', n(), { texto: sPausa.tarefa }),
    item('ferramenta', n(), { nome: 'Bash', resumo: 'node migracoes/pesagens.mjs --lote 7', resultado: { texto: 'lote 7: 10000 linhas copiadas', erro: false } }),
    item('assistente', n(), { texto: 'Migrando o lote 7 de 12…' }),
  ]);
}
// Pedidos de partida: a ferramenta da "Revisar fluxo de login" já existe (perm-1); a fila tem o Edit.
filaPerm.set(lista[0].id, [permEdit()]);
for (const [s, p] of [[sPerg, permGraficos()], [sPlano, permPlano(1)]]) {
  s.controle.permissao = p;
  s.controle.pendentes = 1;
  s.detalhe = detalhePerm(p);
  evento(s.id, s.desde, tipoEvento(p), s.detalhe);
  historico.unshift({ id: proximoAlerta++, tipo: 'aguardando', quando: s.desde, sessao: resumoSessao(s), notificar: true });
}
historico.sort((a, b) => b.quando - a.quando);
{
  let t = sPerg.inicio + 20e3;
  const n = () => (t += 25e3);
  conversas.set(sPerg.id, [
    item('usuario', n(), { texto: sPerg.tarefa }),
    item('pensamento', n(), { texto: 'Antes de sugerir, vejo o que o app já usa para desenhar e quais telas mostram números.' }),
    item('ferramenta', n(), { nome: 'Read', resumo: 'package.json', resultado: { texto: '"react-native": "0.79.2",\n"@shopify/react-native-skia": "1.12.0",\n"expo": "~53.0.0"', erro: false } }),
    item('ferramenta', n(), { nome: 'Grep', resumo: 'peso|arroba · src/features', resultado: { texto: 'src/features/pesagem/PesagemScreen.tsx:41\nsrc/features/lotes/LoteScreen.tsx:88\nsrc/features/financeiro/Resumo.tsx:23', erro: false } }),
    item('assistente', n(), { texto: 'O app já tem o **Skia** instalado, então Victory Native sai quase de graça. Antes de instalar, preciso de duas decisões suas: a biblioteca e as telas desta rodada.' }),
  ]);
  t = sPlano.inicio + 20e3;
  conversas.set(sPlano.id, [
    item('usuario', n(), { texto: sPlano.tarefa }),
    item('ferramenta', n(), { nome: 'Glob', resumo: 'src/**/*pesag*', resultado: { texto: 'src/pesagens/rotas.ts\nsrc/pesagens/repositorio.ts\nsrc/pesagens/pesagens.test.ts', erro: false } }),
    item('ferramenta', n(), { nome: 'Read', resumo: 'src/pesagens/repositorio.ts', resultado: { texto: 'export async function gravarPesagem(db, p) {\n  return db.query(`INSERT INTO pesagens (brinco, data, peso) VALUES ($1, $2, $3)`, [p.brinco, p.data, p.peso]);\n}', erro: false } }),
    item('pensamento', n(), { texto: 'Falta índice único em (brinco, data); sem ele a reimportação duplica.' }),
    item('assistente', n(), { texto: 'Montei o plano. Ele está no cartão abaixo para você **aprovar** ou pedir ajustes.' }),
  ]);
  t = sTrab.inicio + 20e3;
  conversas.set(sTrab.id, [
    item('usuario', n(), { texto: sTrab.tarefa }),
    item('ferramenta', n(), { nome: 'Bash', resumo: 'npm run dev (em segundo plano)', resultado: { texto: 'Rodando em segundo plano (bg-dev).', erro: false } }),
    item('ferramenta', n(), { nome: 'Task', resumo: 'Explore: onde o SSE de pesagens é consumido (em segundo plano)', resultado: { texto: 'Iniciado em segundo plano (bg-explore).', erro: false } }),
    item('assistente', n(), { texto: 'O servidor de dev está no ar e um agente mapeia o SSE em segundo plano. Sigo montando o painel.' }),
    item('ferramenta', T - 3e3, { nome: 'Edit', resumo: 'src/features/painel/PainelPesagens.tsx' }),
  ]);
}

// ---- rotas ----
function pararVolta(res, s) {
  const c = s.controle || {};
  if (c.modo !== 'orbit') return responder(res, 409, { erro: 'O Orbit não controla esta sessão; pare a volta pelo VS Code.', codigo: 'nao_assumida' });
  if (iniciandoOrbit.has(s.id) || !c.ocupada) return responder(res, 409, { erro: 'A sessão já está parada: não há volta em andamento.', codigo: 'parada' });
  const a = novaAcao(s.id, 'parar', 'orbit', 'Interrompendo');
  responder(res, 202, { acao: a });
  cancelarVolta(s); // o texto ao vivo para na hora; o `result` chega logo depois
  depois(800, () => {
    delete c.permissao;
    delete c.pendentes;
    filaPerm.delete(s.id);
    acrescentar(s.id, item('interrupcao', Date.now()));
    mudar(s, 'interrompida');
    evento(s.id, Date.now(), 'interrompida', 'Interrompida pelo Orbit');
    evoluir(a, { estado: 'sucesso' });
  });
}
function trocarModo(res, s, corpo) {
  const c = s.controle || {};
  if (c.modo !== 'orbit') return responder(res, 409, { erro: 'Assuma no Orbit para trocar o modo de permissão.', codigo: 'nao_assumida' });
  if (iniciandoOrbit.has(s.id)) return responder(res, 409, { erro: 'O Orbit ainda está iniciando a sessão; tente em instantes.', codigo: 'ocupada' });
  const modo = corpo.modo;
  if (!PERMISSOES.includes(modo)) return responder(res, 400, { erro: 'Modo de permissão inválido: ' + String(modo || '(vazio)') + '. Use default, acceptEdits, plan ou auto.' });
  c.modoPermissao = modo;
  difundir('sessao', s);
  return responder(res, 200, { modo, ...(c.processo === 'dormindo' ? { pendente: true } : {}) });
}
function responderPermissao(res, s, corpo) {
  const c = s.controle || {};
  const p = c.modo === 'orbit' ? c.permissao : null;
  if (!p || p.id !== corpo.id) return responder(res, 404, { erro: 'Esse pedido de permissão já não está pendente.' });
  if (!['permitir', 'negar'].includes(corpo.decisao)) return responder(res, 400, { erro: 'decisao: permitir ou negar' });
  const mensagem = typeof corpo.mensagem === 'string' ? corpo.mensagem.trim() : '';
  if (mensagem.length > 2000) return responder(res, 400, { erro: 'A mensagem pode ter até 2000 caracteres.' });
  const sug = corpo.sugestao == null ? null : (p.sugestoes || []).find((x) => x.indice === corpo.sugestao) || false;
  if (sug === false) return responder(res, 400, { erro: 'Sugestão inexistente: ' + corpo.sugestao + '.' });
  if (p.tipo === 'pergunta' && corpo.decisao === 'permitir') {
    const r = corpo.respostas;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return responder(res, 400, { erro: 'Mande as respostas: { respostas: { pergunta: resposta } }.' });
    const faltam = p.perguntas.filter((q) => typeof r[q.pergunta] !== 'string' || !r[q.pergunta].trim());
    if (faltam.length) return responder(res, 400, { erro: 'Falta responder: ' + faltam.map((q) => q.pergunta).join(' · ') });
  }
  respostasPerm.unshift({ sessao: s.id, tipo: p.tipo || 'ferramenta', ...corpo, quando: Date.now() });
  if (respostasPerm.length > 20) respostasPerm.length = 20;
  responder(res, 200, { ok: true });

  delete c.permissao;
  delete c.pendentes;
  const fila = filaPerm.get(s.id) || [];
  filaPerm.delete(s.id);
  const negou = corpo.decisao === 'negar';
  if (sug && RE_ACEITAR_EDICOES.test(sug.rotulo)) c.modoPermissao = 'acceptEdits';
  else if (p.tipo === 'plano' && !negou) c.modoPermissao = 'default';
  const agora = Date.now();
  const f = item('ferramenta', agora, { nome: p.ferramenta, resumo: p.resumo });
  const fim = (texto, depoisDe) => (idf) => {
    acrescentar(s.id, { id: idf, ts: Date.now(), tipo: 'assistente', texto });
    if (depoisDe) depoisDe(); else mudar(s, 'concluida', { ultimaResposta: texto });
  };

  if (p.tipo === 'pergunta') {
    if (negou) {
      f.resultado = { texto: 'O usuário preferiu não responder.' + (mensagem ? ' ' + mensagem : ''), erro: true };
      acrescentar(s.id, f);
      mudar(s, 'trabalhando', { ferramenta: null });
      const t = 'Sem problema. Quando quiser decidir, é só me dizer qual biblioteca prefere e eu sigo daí.';
      return transmitir(s, 600, t, fim(t));
    }
    const r = corpo.respostas;
    f.resultado = { texto: 'O usuário respondeu:\n' + Object.entries(r).map(([q, a]) => '• ' + q + ' → ' + a).join('\n'), erro: false };
    acrescentar(s.id, f);
    mudar(s, 'trabalhando', { ferramenta: { nome: 'Bash', alvo: 'npx expo install victory-native', desde: agora } });
    const [lib, telas] = p.perguntas.map((q) => r[q.pergunta]);
    const t = 'Combinado: vou usar **' + lib + '** nestas telas: ' + telas + '.\n\n1. Instalo a biblioteca com `npx expo install`;\n2. Crio um componente `GraficoPeso` reaproveitável, com o tema do app;\n3. Começo pela tela de Pesagens e mostro antes de seguir para as outras.\n\nSe preferir outra ordem, me avise.';
    return transmitir(s, 900, t, fim(t));
  }

  if (p.tipo === 'plano') {
    if (negou) {
      f.resultado = { texto: 'O usuário quer continuar planejando.' + (mensagem ? ' Comentário: ' + mensagem : ''), erro: true };
      acrescentar(s.id, f);
      mudar(s, 'trabalhando', { ferramenta: null });
      const t = 'Certo, continuo planejando' + (mensagem ? ' e incluo o que você pediu: “' + mensagem.slice(0, 120) + (mensagem.length > 120 ? '…' : '') + '”' : '') + '. Já mando a versão nova do plano.';
      const versao = (Number((/versão (\d+)/.exec(p.plano || '') || [])[1]) || 1) + 1;
      return transmitir(s, 700, t, fim(t, () => depoisS(s, 1500, () => pedirPermissao(s, permPlano(versao, mensagem)))));
    }
    f.resultado = { texto: 'Plano aprovado' + (sug ? ' (' + sug.rotulo + ')' : '') + '. Modo: ' + c.modoPermissao + '.', erro: false };
    acrescentar(s.id, f);
    // Volta longa: tarefa em segundo plano, ferramentas e uma resposta comprida ao vivo (dá tempo de Parar).
    mudar(s, 'trabalhando', { ferramenta: { nome: 'Write', alvo: 'src/importacao/lerPlanilha.ts', desde: agora } });
    c.tarefas = [{ id: 'bg-api', tipo: 'local_bash', descricao: 'npm run dev -- --port 3001 (API para testar a importação)' }];
    difundir('sessao', s);
    const passos = [
      ['Write', 'src/importacao/lerPlanilha.ts', 'Arquivo criado (84 linhas).'],
      ['Edit', 'src/pesagens/repositorio.ts', 'O arquivo foi atualizado (2 trechos).'],
      ['Bash', 'npm test -- importacao', 'PASS src/importacao/lerPlanilha.test.ts (11 testes)\nTests: 11 passed, 11 total'],
    ];
    passos.forEach(([nome, resumo, saida], i) => {
      const fi = item('ferramenta', 0, { nome, resumo });
      depoisS(s, 1200 + i * 2400, () => { fi.ts = Date.now(); acrescentar(s.id, fi); s.ferramenta = { nome, alvo: resumo, desde: Date.now() }; difundir('sessao', s); });
      depoisS(s, 2600 + i * 2400, () => { fi.resultado = { texto: saida, erro: false }; reenviar(s.id, fi); });
    });
    const t = '## Importação pronta\n\nSegui o plano aprovado. O que ficou feito:\n\n- `lerPlanilha.ts` lê a aba "Pesagens" em fluxo, então planilhas grandes não estouram a memória;\n- cada linha passa por validação de brinco, data (nos dois formatos da balança) e peso; as ruins vão para o relatório;\n- a gravação é por lote, numa transação, com `ON CONFLICT (brinco, data) DO NOTHING`;\n- criei o índice único que faltava em `pesagens (brinco, data)`.\n\n### Testes\n\n11 de 11 passaram, inclusive com as 3 planilhas reais anonimizadas.\n\nA API de teste continua rodando em segundo plano na porta 3001, se quiser experimentar o upload agora.';
    return transmitir(s, 1200 + passos.length * 2400 + 600, t, fim(t, () => { mudar(s, 'concluida', { ultimaResposta: t }); }));
  }

  // Ferramenta
  if (negou) {
    f.resultado = { texto: 'O usuário negou a permissão para usar a ferramenta.' + (mensagem ? ' Motivo: ' + mensagem : ''), erro: true };
    acrescentar(s.id, f);
    mudar(s, 'trabalhando', { ferramenta: null });
    const t = 'Tudo bem, **não rodei** ' + (p.ferramenta === 'Bash' ? 'a suíte' : 'a edição') + '.' + (mensagem ? ' Anotei o motivo: “' + mensagem.slice(0, 160) + '”.' : '') + ' Como prefere seguir?';
    return transmitir(s, 500, t, fim(t));
  }
  mudar(s, 'trabalhando', { ferramenta: { nome: p.ferramenta, alvo: p.resumo, desde: agora } });
  acrescentar(s.id, f);
  depoisS(s, 1500, () => { f.resultado = { texto: p.ferramenta === 'Bash' ? FERR_CONV[0][2] : 'O arquivo foi atualizado (1 trecho).', erro: false }; reenviar(s.id, f); });
  const [prox, ...resto] = fila;
  if (prox) return depoisS(s, 2300, () => pedirPermissao(s, prox, resto));
  const t = p.ferramenta === 'Bash' ? RESPOSTAS[0] : RESPOSTAS[1];
  return transmitir(s, 2300, t, fim(t));
}

// ---- roteiro da etapa 3 ----
// A cada 10 passos: re-arma os pedidos que já foram respondidos (gera de novo a notificação de cada tipo) e
// alterna uma tarefa em segundo plano do painel.
function rodarEtapa3(agora) {
  rodarEtapa4(agora);
  const k = passo % 10;
  if (k === 5) {
    const armar = [[lista[0], () => permsLogin()], [sPerg, () => [permGraficos(), []]], [sPlano, () => [permPlano(1), []]]];
    for (const [s, gerar] of armar) {
      const c = s.controle;
      if (!sessoes.has(s.id) || c?.modo !== 'orbit' || c.processo === 'dormindo' || c.permissao || emVolta(s) || !['concluida', 'interrompida'].includes(s.status) || agora - s.desde < 15e3) continue;
      if (s === sPlano) { c.modoPermissao = 'plan'; delete c.tarefas; }
      const [p, fila] = gerar();
      pedirPermissao(s, p, fila);
    }
  }
  const c = sTrab.controle;
  if (c?.modo === 'orbit' && Array.isArray(c.tarefas)) {
    if (k === 3) c.tarefas = c.tarefas.filter((t) => t.id !== 'bg-explore');
    if (k === 8 && !c.tarefas.some((t) => t.id === 'bg-explore')) c.tarefas.push({ id: 'bg-explore', tipo: 'local_agent', descricao: 'Explore: onde o SSE de pesagens é consumido' });
    if (k === 3 || k === 8) difundir('sessao', sTrab);
  }
}
// O painel trabalha sem parar enquanto alguém olha a conversa: ferramenta, resultado e texto ao vivo. Depois de
// parado (ou concluído), volta a trabalhar sozinho em 40 s.
const PASSOS_PAINEL = [
  ['Edit', 'src/features/painel/PainelPesagens.tsx', 'O arquivo foi atualizado (3 trechos).', 'Liguei o painel ao fluxo de pesagens: cada pesagem nova entra no topo da lista e atualiza a **média do lote** sem recarregar a tela.'],
  ['Bash', 'npm test -- painel', 'PASS src/features/painel/painel.test.tsx (6 testes)', 'Os 6 testes do painel passam. Agora trato a reconexão: se o SSE cair, o painel tenta de novo em 2 s e mostra um aviso discreto no topo.'],
  ['Read', 'src/features/pesagem/usePesagensAoVivo.ts', 'export function usePesagensAoVivo(lote: string) {\n  const [itens, setItens] = useState<Pesagem[]>([]);\n  …', 'O hook `usePesagensAoVivo` já guarda as últimas 200 pesagens. Vou reaproveitar em vez de criar outro estado.'],
];
let passoPainel = 0;
function rodarPainel() {
  const s = sTrab;
  if (!sessoes.has(s.id) || s.controle?.modo !== 'orbit' || s.controle.processo !== 'vivo' || emVolta(s)) return;
  const agora = Date.now();
  if (s.status !== 'trabalhando') {
    if (!s.controle.permissao && agora - s.desde > 40e3) mudar(s, 'trabalhando', { ferramenta: { nome: 'Read', alvo: 'src/features/painel/PainelPesagens.tsx', desde: agora } });
    return;
  }
  if (!clientesConversa.get(s.id)?.size) return;
  for (const it of conversaDe(s.id)) if (it.tipo === 'ferramenta' && !it.resultado) { it.resultado = { texto: 'O arquivo foi atualizado (1 trecho).', erro: false }; reenviar(s.id, it); }
  const [nome, resumo, saida, texto] = PASSOS_PAINEL[passoPainel++ % PASSOS_PAINEL.length];
  const f = item('ferramenta', agora, { nome, resumo });
  s.ferramenta = { nome, alvo: resumo, desde: agora };
  s.atividade = agora;
  acrescentar(s.id, f);
  difundir('sessao', s);
  depoisS(s, 900, () => { f.resultado = { texto: saida, erro: false }; reenviar(s.id, f); });
  transmitir(s, 1400, texto, (idf) => acrescentar(s.id, { id: idf, ts: Date.now(), tipo: 'assistente', texto }));
}

// Amostra do `commands` do initialize (claude 2.1.300) e a saída dos comandos locais.
const COMANDOS_FALSOS = [
  ['clear', 'Start a new session with empty context', '[name]'], ['compact', 'Free up context by summarizing the conversation so far', '<optional custom summarization instructions>'],
  ['context', 'Show current context usage', ''], ['usage', 'Show session cost, plan usage, and what\'s contributing to your limits', ''],
  ['model', 'Set the AI model for Claude Code', '<model>'], ['effort', 'Set effort level for model usage', '<low|medium|high|xhigh|max|auto>'],
  ['rename', 'Rename the current conversation', '[name]'], ['recap', 'Generate a one-line session recap now', ''], ['init', 'Initialize a new CLAUDE.md file with codebase documentation', ''],
  ['status', 'Show status', ''], ['fast', 'Toggle fast mode', '[on|off]'], ['help', 'Show help', ''],
  ['code-review', 'Review the current diff, or a PR number/branch/path target, for correctness bugs. Extra detail here.', '[low|medium|high|xhigh|max|ultra] [--fix]'],
  ['simplify', 'Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes.', '[<target>]'],
  ['productivity:update', '(productivity) Sync tasks and refresh memory from your current activity.', '[--comprehensive]'],
  ['security-review', 'Complete a security review of the pending changes on the current branch', ''],
].map(([nome, descricao, args]) => ({ nome, descricao, args }));
const SAIDA_FALSA = {
  context: '## Context Usage\n\n**Model:** claude-opus-5-5  \n**Tokens:** 48.2k / 1m (5%)\n\n| Category | Tokens | Percentage |\n|----------|--------|------------|\n| System prompt | 3.2k | 0.3% |\n| Messages | 33.1k | 3.3% |\n| Free space | 951.8k | 95.2% |',
  usage: 'You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 5% used · resets Oct 16, 3:10am\nCurrent week (all models): 22% used · resets Oct 22, 8am',
  recap: 'Painel de pesagens: gráfico ao vivo pronto, faltam os testes de reconexão.',
  status: '/status isn\'t available in this environment.',
};

function rotaControle(req, res, url) {
  const m = /^\/sessao\/([^/]+)\/(conversa\/fluxo|conversa|acoes|comandos|mensagem|compactar|limpar|assumir|devolver|permissao|modelo|esforco|parar|modo|encerrar|retomar|autocompactar)$/.exec(url.pathname);
  if (!m) return false;
  const id = decodeURIComponent(m[1]);
  const rota = m[2];
  const s = sessoes.get(id);
  const get = req.method === 'GET';
  if (get !== ['conversa/fluxo', 'conversa', 'acoes', 'comandos'].includes(rota)) return false;
  if (!s) { responder(res, 404, { erro: 'sessão não encontrada' }); return true; }
  if (rota === 'conversa/fluxo') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n: ok\n\n');
    const desde = url.searchParams.get('desde');
    if (desde != null && /^\d+$/.test(desde)) { const resto = conversaDe(id).slice(Number(desde)); if (resto.length) res.write(`event: itens\ndata: ${JSON.stringify({ itens: resto })}\n\n`); }
    if (!clientesConversa.has(id)) clientesConversa.set(id, new Set());
    clientesConversa.get(id).add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
    req.on('close', () => { clearInterval(ping); clientesConversa.get(id)?.delete(res); });
    return true;
  }
  if (rota === 'conversa') {
    const l = conversaDe(id);
    const limite = Math.max(1, Math.min(500, Number(url.searchParams.get('limite')) || 150));
    const antes = url.searchParams.get('antes');
    const fim = antes != null && /^\d+$/.test(antes) ? Math.min(l.length, Number(antes)) : l.length;
    const ini = Math.max(0, fim - limite);
    responder(res, 200, { itens: l.slice(ini, fim), cursorAntigo: ini > 0 ? String(ini) : null, cursorNovo: String(l.length) });
    return true;
  }
  if (rota === 'acoes') { responder(res, 200, (acoesPorSessao.get(id) || []).slice(-20)); return true; }
  if (rota === 'comandos') { responder(res, 200, { comandos: COMANDOS_FALSOS }); return true; } // a lista do initialize
  if (req.headers['x-gerenciador'] !== '1') { responder(res, 403, { erro: 'cabeçalho ausente' }); return true; }
  lerCorpo(req).then((corpo) => acaoControle(res, s, rota, corpo || {}), () => responder(res, 400, { erro: 'JSON inválido' }));
  return true;
}

function acaoControle(res, s, rota, corpo) {
  atualizarControle(s);
  const c = s.controle;
  const recusar = (codigo, erro) => responder(res, 409, { erro, codigo });
  const aceitar = (a) => responder(res, 202, { acao: a });
  if (rota === 'modelo' || rota === 'esforco') return trocarAjuste(res, s, rota, corpo);
  if (rota === 'parar') return pararVolta(res, s);
  if (rota === 'autocompactar') { // 20/10: true/false vale só nesta instância; null segue a config
    if (c.modo !== 'orbit') return recusar('nao_assumida', 'A compactação automática vale só para instâncias do Orbit.');
    if (corpo.ativo !== true && corpo.ativo !== false && corpo.ativo !== null) return responder(res, 400, { erro: 'ativo deve ser true, false ou null' });
    const ac = { ...(c.autoCompactar || {}), limite: config.instancias?.autoCompactar?.limite || 140000 };
    if (corpo.ativo === null) { delete ac.propria; ac.ligada = config.instancias?.autoCompactar?.ativo !== false; } else { ac.propria = corpo.ativo; ac.ligada = corpo.ativo; }
    c.autoCompactar = ac;
    difundir('sessao', s);
    return responder(res, 200, { autoCompactar: ac });
  }
  if (rota === 'encerrar') return encerrarInstancia(res, s, corpo); // etapa 4
  if (rota === 'retomar') return retomarInstancia(res, s);
  if (rota === 'devolver' && s.origem === 'orbit' && c.modo === 'orbit') return encerrarInstancia(res, s, corpo); // origem orbit: devolver = encerrar
  if (rota === 'modo') return trocarModo(res, s, corpo);
  if (rota === 'permissao') return responderPermissao(res, s, corpo);
  if (rota === 'mensagem') {
    const texto = typeof corpo.texto === 'string' ? corpo.texto : '';
    if (!texto.trim() || texto.length > 20000) return responder(res, 400, { erro: 'A mensagem precisa ter de 1 a 20000 caracteres.' });
    if (c.modo === 'nenhum') return recusar('nao_assumida', 'Sem processo vivo: assuma no Orbit para conversar.');
    if (iniciandoOrbit.has(s.id)) return recusar('ocupada', 'O Orbit ainda está iniciando a sessão; tente em instantes.');
    if (c.modo === 'orbit' && c.processo === 'dormindo') { const e = abrirVaga(s); if (e) return recusar('limite', e); }
    const dorme = c.modo === 'orbit' && (c.processo === 'dormindo' || acordando.has(s.id));
    const a = novaAcao(s.id, 'mensagem', c.modo, dorme ? 'Retomando a instância…' : 'Enviando');
    aceitar(a);
    const falhar = /falhar/i.test(texto);
    if (c.modo === 'orbit') {
      acordar(s, () => { // etapa 4: com a instância dormindo, acorda antes (--resume)
      if (dorme) evoluir(a, { etapa: 'Enviando' });
      depois(600, () => {
        if (falhar) return evoluir(a, { estado: 'erro', erro: 'O processo do Orbit não respondeu. Tente de novo; se continuar, devolva e reabra no VS Code.' });
        const cmd = /^\/(\S+)\s*([\s\S]*)$/.exec(texto.trim());
        if (cmd && (SAIDA_FALSA[cmd[1]] || cmd[1] === 'rename')) { // comando local: a linha do comando e a saída, sem volta
          acrescentar(s.id, item('comando', Date.now(), { texto: texto.trim() }));
          acrescentar(s.id, item('saida', Date.now(), { texto: SAIDA_FALSA[cmd[1]] || 'Session renamed to: ' + cmd[2] }));
          return evoluir(a, { estado: 'sucesso' });
        }
        acrescentar(s.id, item('usuario', Date.now(), { texto }));
        evoluir(a, { estado: 'sucesso' });
        simularVolta(s, texto);
      });
      });
    } else {
      depois(500, () => evoluir(a, { etapa: 'Aguardando a sessão confirmar' }));
      depois(falhar ? 3500 : 1800, () => {
        if (falhar) return evoluir(a, { estado: 'erro', erro: 'Não confirmada pela sessão' });
        acrescentar(s.id, item('par', Date.now(), { texto }));
        evoluir(a, { estado: 'sucesso' });
      });
    }
    return;
  }
  if (rota === 'compactar') {
    if (c.modo !== 'orbit') return recusar('nao_assumida', 'Assuma no Orbit para compactar sem abrir o VS Code.');
    if (c.ocupada) return recusar('ocupada', 'A sessão está trabalhando; espere a volta terminar para compactar.');
    const foco = typeof corpo.foco === 'string' ? corpo.foco.trim().slice(0, 500) : '';
    if (c.processo === 'dormindo') { const e = abrirVaga(s); if (e) return recusar('limite', e); }
    const dorme = c.processo === 'dormindo' || acordando.has(s.id);
    const a = novaAcao(s.id, 'compactar', 'orbit', dorme ? 'Retomando a instância…' : 'Enviando /compact');
    aceitar(a);
    acordar(s, () => { if (dorme) evoluir(a, { etapa: 'Enviando /compact' }); // etapa 4
    depois(500, () => { acrescentar(s.id, item('comando', Date.now(), { texto: '/compact' + (foco ? ' ' + foco : '') })); evoluir(a, { etapa: 'Resumindo a conversa' }); });
    depois(3200, () => {
      if (!compactadas.has(s.id)) {
        compactadas.add(s.id);
        acrescentar(s.id, item('erro', Date.now(), { texto: 'Compactação falhou: API Error 529 Overloaded.' }));
        return evoluir(a, { estado: 'erro', erro: 'A compactação falhou: a API respondeu 529 (sobrecarregada). Tente de novo em instantes.' });
      }
      const pre = s.contexto?.tokens || 182_000, pos = Math.round(pre * 0.13);
      acrescentar(s.id, item('compactacao', Date.now(), { pre, pos, ...(foco ? { foco } : {}) }));
      if (s.contexto) s.contexto.tokens = pos;
      difundir('sessao', s);
      evoluir(a, { estado: 'sucesso', resultado: { pre, pos } });
    });
    });
    return;
  }
  if (rota === 'limpar') {
    if (corpo.confirmar !== true) return responder(res, 400, { erro: 'Confirme a limpeza (confirmar: true).' });
    if (c.modo !== 'orbit') return recusar('nao_assumida', 'Assuma no Orbit para limpar sem abrir o VS Code.');
    if (c.ocupada) return recusar('ocupada', 'A sessão está trabalhando; espere a volta terminar para limpar.');
    if (c.processo === 'dormindo') { const e = abrirVaga(s); if (e) return recusar('limite', e); }
    const dorme = c.processo === 'dormindo' || acordando.has(s.id);
    const a = novaAcao(s.id, 'limpar', 'orbit', dorme ? 'Retomando a instância…' : 'Enviando /clear');
    aceitar(a);
    acordar(s, () => { if (dorme) evoluir(a, { etapa: 'Enviando /clear' }); // etapa 4
    depois(1500, () => {
      const novoId = crypto.randomUUID();
      const nova = { ...JSON.parse(JSON.stringify(s)), id: novoId, desde: Date.now(), atividade: Date.now(), inicio: Date.now(), status: 'nova', ultimaResposta: '', tarefa: '', primeira: '', contexto: { tokens: 12_000, modelo: s.contexto?.modelo || 'claude-opus-4-1' } };
      nova.controle = { ...s.controle, desde: Date.now(), ocupada: false };
      delete nova.controle.permissao;
      sessoes.set(novoId, nova);
      conversas.set(novoId, []);
      s.controle = { modo: 'nenhum', podeAssumir: false };
      mudar(s, 'encerrada', { vivo: false });
      atualizarControles();
      difundir('sessao', nova);
      enviarConversa(s.id, 'reinicio', { motivo: 'limpeza', novaSessao: novoId });
      clientesConversa.set(novoId, clientesConversa.get(s.id) || new Set());
      clientesConversa.set(s.id, new Set());
      acrescentar(novoId, item('limpeza', Date.now()));
      evoluir(a, { estado: 'sucesso', resultado: { novaSessao: novoId } });
    });
    });
    return;
  }
  if (rota === 'assumir') {
    if (c.modo === 'orbit') return recusar('ja_assumida', 'O Orbit já controla esta sessão.');
    if (s.status === 'trabalhando') return recusar('trabalhando', 'A sessão está trabalhando; espere terminar para assumir.');
    if (orbitAtivos() >= LIMITE_ORBIT) return recusar('limite', 'O Orbit já controla 5 sessões; devolva uma antes.');
    const a = novaAcao(s.id, 'assumir', 'orbit', c.modo === 'canal' ? 'Encerrando o processo do VS Code' : 'Preparando');
    aceitar(a);
    depois(1200, () => {
      evoluir(a, { etapa: 'Iniciando o Claude no Orbit' });
      if (s.titulo !== 'Migrar tabela de lotes') { iniciandoOrbit.add(s.id); s.controle = { modo: 'orbit', podeAssumir: false, pid: 40000 + Math.floor(Math.random() * 9000), desde: Date.now() }; difundir('sessao', s); }
    });
    depois(2600, () => {
      if (s.titulo === 'Migrar tabela de lotes') {
        s.controle = { modo: 'nenhum', podeAssumir: true };
        difundir('sessao', s);
        return evoluir(a, { estado: 'erro', erro: 'Encerrei o processo do VS Code, mas o Claude não subiu no Orbit (saiu com código 1). Reabra a sessão no VS Code pelo botão Abrir.' });
      }
      iniciandoOrbit.delete(s.id);
      s.controle = { ...s.controle, modo: 'orbit' };
      difundir('sessao', s);
      evoluir(a, { estado: 'sucesso' });
    });
    return;
  }
  if (rota === 'devolver') {
    if (c.modo !== 'orbit') return recusar('nao_assumida', 'O Orbit não controla esta sessão.');
    if (c.ocupada) return recusar('ocupada', 'A sessão está trabalhando; espere a volta terminar para devolver.');
    const a = novaAcao(s.id, 'devolver', 'orbit', 'Fechando o processo do Orbit');
    aceitar(a);
    depois(1500, () => {
      s.controle = { modo: 'nenhum', podeAssumir: true };
      difundir('sessao', s);
      evoluir(a, { estado: 'sucesso' });
    });
    return;
  }
  responder(res, 404, { erro: 'não encontrado' });
}

// Roteiro da conversa: a sessão que trabalha ganha ferramentas e respostas na conversa aberta.
let passoConversa = 0;
function rodarConversa() {
  for (const [id, clientes] of clientesConversa) {
    if (!clientes.size) continue;
    const s = sessoes.get(id);
    if (!s || s.status !== 'trabalhando' || s.controle?.modo === 'orbit') continue;
    const [nome, resumo, saida, erro] = FERR_CONV[passoConversa % FERR_CONV.length];
    const f = item('ferramenta', Date.now(), { nome, resumo });
    acrescentar(id, f);
    depois(1500, () => { f.resultado = { texto: saida, erro: !!erro }; reenviar(id, f); });
    if (passoConversa % 3 === 2) depois(2200, () => acrescentar(id, item('assistente', Date.now(), { texto: RESPOSTAS[passoConversa % RESPOSTAS.length] })));
  }
  passoConversa++;
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (rotaControle(req, res, url)) return;
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return responder(res, 200, fs.readFileSync(PAGINA, 'utf8'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      // Como o servidor real: só imagens e fontes da pasta assets; subpastas (assets/sprites/...) só com segmentos simples.
      const nome = decodeURIComponent(url.pathname.slice(8));
      const tipos = { '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
      const tipo = tipos[path.extname(nome).toLowerCase()];
      if (!tipo || !/^(?:[\w@-][\w.@-]*\/)*[\w@-][\w.@-]*$/.test(nome)) return responder(res, 404, { erro: 'não encontrado' });
      try {
        const dados = fs.readFileSync(path.join(PASTA, '..', 'assets', nome));
        res.writeHead(200, { 'content-type': tipo, 'cache-control': /\.(js|css)$/.test(nome) ? 'no-cache' : 'max-age=3600' });
        return res.end(dados);
      } catch { return responder(res, 404, { erro: 'não encontrado' }); }
    }
    if (req.method === 'GET' && url.pathname === '/estado') atualizarControles();
    if (req.method === 'GET' && url.pathname === '/estado') return responder(res, 200, { sessoes: [...sessoes.values()], resumoDia, uso });
    if (req.method === 'GET' && url.pathname === '/fluxo') {
      atualizarControles();
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`retry: 2000\nevent: inicio\ndata: ${JSON.stringify({ sessoes: [...sessoes.values()], config, resumoDia, historico: historico.slice(0, 50), uso })}\n\n`);
      clientes.add(res);
      req.on('close', () => clientes.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/sessao/')) {
      const id = decodeURIComponent(url.pathname.slice(8));
      const s = sessoes.get(id);
      if (!s) return responder(res, 404, { erro: 'sessão não encontrada' });
      return responder(res, 200, { sessao: s, eventos: (eventos.get(id) || []).slice(-200) });
    }
    if (req.method === 'GET' && url.pathname === '/config') return responder(res, 200, config);
    if (req.method === 'GET' && url.pathname === '/historico') return responder(res, 200, historico.slice(0, 300));
    if (req.method === 'GET' && url.pathname === '/instancias') return responder(res, 200, resumoInstancias()); // etapa 4
    if (req.method === 'GET' && url.pathname === '/_mock/respostas') return responder(res, 200, respostasPerm); // etapa 3: corpos de POST /permissao
    if (url.pathname === '/saude') return responder(res, 200, { ok: true, versao: 'mock', pid: process.pid, desde: T, ultimoHook: Date.now(), sessoes: sessoes.size }); // pid: para o desligarSeMeu
    if (req.method === 'GET' && url.pathname === '/modelos') {
      if (process.env.MOCK_SEM_MODELOS === '1') return responder(res, 503, { erro: 'Os modelos ainda não foram lidos. Tente de novo em alguns segundos.' });
      return responder(res, 200, { modelos: MODELOS, atualizado: MODELOS_EM });
    }

    if (req.method === 'POST' && req.headers['x-gerenciador'] !== '1') return responder(res, 403, { erro: 'cabeçalho ausente' });

    if (req.method === 'POST' && url.pathname.startsWith('/sessao/')) {
      const id = decodeURIComponent(url.pathname.slice(8));
      const s = sessoes.get(id);
      if (!s) return responder(res, 404, { erro: 'sessão não encontrada' });
      const corpo = await lerCorpo(req);
      if (typeof corpo.fixada === 'boolean') s.fixada = corpo.fixada;
      if (typeof corpo.silenciada === 'boolean') s.silenciada = corpo.silenciada;
      if (typeof corpo.apelido === 'string') s.apelido = corpo.apelido.trim().slice(0, 80);
      difundir('sessao', s);
      return responder(res, 200, { ok: true, sessao: s });
    }
    if (req.method === 'POST' && url.pathname === '/instancias') return criarInstancia(res, await lerCorpo(req) || {});
    if (req.method === 'POST' && url.pathname === '/nova-instancia') {
      // Imita o servidor: 202 na hora; a sessão nova chega depois, como pelo SessionStart.
      const { projeto } = await lerCorpo(req);
      const base = [...sessoes.values()].find((s) => s.projeto === projeto && s.cwd);
      if (!base) return responder(res, 404, { erro: 'Não achei a pasta de "' + projeto + '" nas sessões conhecidas.' });
      setTimeout(() => {
        const agora = Date.now();
        const s = sessao({ id: 'nova-' + agora.toString(36), projeto, cwd: base.cwd, desde: agora, atividade: agora, inicio: agora, turno: null });
        sessoes.set(s.id, s);
        difundir('sessao', s);
      }, 1200);
      return responder(res, 202, { ok: true, projeto, pasta: base.cwd });
    }
    if (req.method === 'POST' && url.pathname === '/remover') {
      const { id } = await lerCorpo(req);
      if (sessoes.delete(id)) difundir('remover', { id });
      return responder(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/limpar') {
      const ids = [];
      for (const [id, s] of sessoes) {
        if (!s.fixada && ['concluida', 'interrompida', 'encerrada'].includes(s.status)) {
          sessoes.delete(id);
          ids.push(id);
          difundir('remover', { id });
        }
      }
      return responder(res, 200, { ok: true, removidas: ids.length });
    }
    if (req.method === 'POST' && url.pathname === '/config') {
      const corpo = await lerCorpo(req);
      for (const [nome, v] of Object.entries(corpo?.projetos || {})) {
        if (v === null) delete config.projetos[nome];
        else if (v && typeof v === 'object') config.projetos[nome] = { icone: '', cor: '', ...config.projetos[nome], ...v };
      }
      if (corpo) delete corpo.projetos;
      mesclar(config, corpo);
      difundir('config', config);
      difundirInstancias(); // etapa 4: dormirApos
      return responder(res, 200, config);
    }
    if (req.method === 'POST' && url.pathname === '/desligar') {
      responder(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 100);
      return;
    }
    responder(res, 404, { erro: 'não encontrado' });
  } catch (e) {
    responder(res, 400, { erro: String(e?.message || e) });
  }
});

if ([47821, 47822].includes(PORTA)) {
  console.error('Porta reservada (produção/Backend). Use outra.');
  process.exit(1);
}

servidor.listen(PORTA, '127.0.0.1', () => {
  console.log(`Mock do gerenciador em http://127.0.0.1:${PORTA}  (roteiro ${ROTEIRO ? `a cada ${PASSO_MS} ms` : 'parado'})`);
});

if (ROTEIRO) setInterval(rodarPasso, PASSO_MS);
if (ROTEIRO) setInterval(rodarConversa, 4000);
if (ROTEIRO) setInterval(rodarPainel, 3800); // etapa 3: o painel do Orbit trabalha com texto ao vivo
setInterval(() => { for (const res of clientes) res.write(': ping\n\n'); }, 25e3).unref();
