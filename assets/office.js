/* Visão de Office — o escritório dos agentes do gerenciador.
 *
 * Integração (rodada 4):
 *   window.Office.montar(el, api)   monta dentro de `el` (a <section id="office">)
 *   window.Office.pausar()          ao sair da aba (para rAF e relógio)
 *   window.Office.retomar()         ao voltar
 *   window.Office.desmontar()       tira tudo (listeners, DOM, assinaturas)
 *   window.Office._debug()          grade caminhável + posição dos robôs (testes)
 *
 * Sem dependências. Textos vindos do servidor entram só por textContent.
 */
(function () {
  'use strict';

  // ═══════════════════════════════ CONFIGURAÇÃO ═══════════════════════════════
  // Ajuste agentes, áreas, nomes, textos, velocidades e limiares aqui.
  // Coordenadas em células da grade (x = coluna, y = linha, origem no canto superior esquerdo).
  // Áreas: retângulo externo; a borda é parede, `portas` são aberturas na parede.
  // Estações: célula onde o robô fica; a mesa (3×1) fica na linha de cima, salvo `mesa` explícita.
  // Móveis com `bloqueia: false` são só desenho (tapete); os demais bloqueiam o caminho.
  const CONFIG = {
    grade: { colunas: 48, linhas: 28 },
    fundo: '/assets/office/fundo.png',
    robos: { andando: '/assets/robot-run.gif', parado: '/assets/robot-idle.gif', dormindo: '/assets/robot-sleep-sheet.png' }, // dormindo: instância do Orbit sem processo (etapa 4)

    velocidade: 4.6,               // células por segundo (o Mestre cruza o escritório em ~10 s)
    passosPorSegundoReduzido: 7,   // prefers-reduced-motion: anda em passos, ainda pelo caminho
    conversaMs: 3600,              // quanto dura o encontro lado a lado
    respostaMs: 1100,              // na conversa, quem recebe "digita" por esse tempo antes de responder
    descansoMs: [3500, 8000],      // parada em cada ponto da área de descanso
    demoIntervaloMs: [4000, 8000], // sorteio do modo demonstração
    filaMaxMs: 120000,             // interação que não começa nesse prazo é descartada
    caminhadaMaxMs: 45000,         // interação que não se encontra nesse prazo é descartada
    janelaFalhasMs: 120000,        // Tester concluiu e um Front/Back começou até 2 min depois
    maxRobos: 12,
    maxBalao: 60,                  // caracteres do balão (com "…")
    // Escala das barras de uso: a mesma dos gráficos de contexto da página (CTX_ESCALA no index.html).
    // Verde de 0 a 45% · amarelo em 50% · vermelho em 75% · roxo em 100%, misturados em OKLab.
    uso: {
      verdeAte: 50, ambarAte: 80,
      escala: [[0, '#1fd67a'], [0.45, '#1fd67a'], [0.5, '#ffc61a'], [0.75, '#ff4757'], [1, '#a78bfa']],
    },

    funcoes: {
      mestre:      { nome: 'Mestre',      papel: 'Coordena o time e delega tarefas', cor: '#818cf8' },
      frontend:    { nome: 'Frontend',    papel: 'Interface e páginas',              cor: '#38bdf8' },
      backend:     { nome: 'Backend',     papel: 'Servidor, hooks e rotas',          cor: '#c084fc' },
      tester:      { nome: 'Tester',      papel: 'Testes e verificação',             cor: '#f472b6' },
      pesquisador: { nome: 'Pesquisador', papel: 'Pesquisa e referências',           cor: '#2dd4bf' },
      auxiliar:    { nome: 'Auxiliar',    papel: 'Tarefas gerais do time',           cor: '#a3a3a3' },
    },

    // Função pelo texto (descrição, tipo, título). Vence a palavra que aparece primeiro.
    palavras: {
      pesquisador: /pesquis|research|referenc|explor|investig|levantament/,
      tester: /\btest|tester|\bqa\b|fumaca|verifica|valida|\be2e\b|smoke/,
      frontend: /front|interface|\bui\b|pagina|\btela|\bcss\b|layout|visual|\bhtml\b|componente/,
      backend: /back|servidor|server|\bhook|\bapi\b|\brota|endpoint|banco de dados/,
    },

    // Time do modo demonstração (um por função).
    agentesDemo: [
      { id: 'mestre', nome: 'Mestre', funcao: 'mestre' },
      { id: 'frontend', nome: 'Frontend', funcao: 'frontend' },
      { id: 'backend', nome: 'Backend', funcao: 'backend' },
      { id: 'tester', nome: 'Tester', funcao: 'tester' },
      { id: 'pesquisador', nome: 'Pesquisador', funcao: 'pesquisador' },
    ],

    areas: [
      { id: 'frontend', nome: 'Frontend', funcao: 'frontend', x: 0, y: 0, w: 15, h: 12,
        portas: [{ x: 6, y: 11, w: 2, h: 1 }],
        estacoes: [{ x: 3, y: 6 }, { x: 10, y: 6 }, { x: 7, y: 9 }],
        moveis: [{ tipo: 'lousa', x: 6, y: 1, w: 7, h: 2 }, { tipo: 'planta', x: 13, y: 1 }, { tipo: 'planta', x: 1, y: 10 }, { tipo: 'deco', x: 1, y: 1, w: 1, h: 4, arte: 'estante' }, { tipo: 'deco', x: 13, y: 10, w: 1, h: 1, arte: 'planta' }] },
      { id: 'mestre', nome: 'Mestre', funcao: 'mestre', x: 16, y: 0, w: 16, h: 12,
        portas: [{ x: 23, y: 11, w: 2, h: 1 }],
        estacoes: [{ x: 23, y: 6, funcao: 'mestre', destaque: true }, { x: 19, y: 9, funcao: 'auxiliar' }, { x: 28, y: 9, funcao: 'auxiliar' }],
        moveis: [{ tipo: 'lousa', x: 24, y: 1, w: 6, h: 2 }, { tipo: 'planta', x: 30, y: 10 }, { tipo: 'planta', x: 17, y: 10 }, { tipo: 'deco', x: 30, y: 1, w: 1, h: 1, arte: 'planta' }, { tipo: 'deco', x: 30, y: 2, w: 1, h: 2, arte: 'arquivo' }] },
      { id: 'backend', nome: 'Backend', funcao: 'backend', x: 33, y: 0, w: 15, h: 12,
        portas: [{ x: 39, y: 11, w: 2, h: 1 }],
        estacoes: [{ x: 36, y: 6 }, { x: 43, y: 6 }, { x: 39, y: 9 }],
        moveis: [{ tipo: 'rack', x: 45, y: 1, w: 2, h: 3 }, { tipo: 'rack', x: 41, y: 1, w: 2, h: 3 }, { tipo: 'planta', x: 34, y: 10 }, { tipo: 'deco', x: 34, y: 2, w: 1, h: 2, arte: 'arquivo' }, { tipo: 'deco', x: 43, y: 1, w: 2, h: 3, arte: 'rack' }, { tipo: 'deco', x: 46, y: 10, w: 1, h: 1, arte: 'planta' }] },
      { id: 'tester', nome: 'Tester', funcao: 'tester', x: 0, y: 15, w: 14, h: 13,
        portas: [{ x: 6, y: 15, w: 2, h: 1 }],
        estacoes: [{ x: 3, y: 20 }, { x: 9, y: 20 }, { x: 6, y: 24 }],
        // Bancada 6×2: a proporção do desenho (3:1), para preencher o retângulo.
        moveis: [{ tipo: 'bancada', x: 7, y: 25, w: 6, h: 2 }, { tipo: 'planta', x: 1, y: 26 }, { tipo: 'planta', x: 12, y: 16 }, { tipo: 'deco', x: 1, y: 16, w: 1, h: 2, arte: 'arquivo' }] },
      { id: 'descanso', nome: 'Descanso', descanso: true, x: 15, y: 15, w: 18, h: 13,
        portas: [{ x: 22, y: 15, w: 2, h: 1 }, { x: 28, y: 15, w: 2, h: 1 }],
        estacoes: [],
        moveis: [
          { tipo: 'tapete', x: 18, y: 18, w: 6, h: 7, bloqueia: false },
          // Sofás (assets separados/sofá.png): 4×2 cobre o desenho, um de cada lado da mesinha.
          { tipo: 'sofa', x: 19, y: 19, w: 4, h: 2, encosto: 'cima' },
          { tipo: 'mesinha', x: 20, y: 21, w: 2, h: 1 },
          { tipo: 'sofa', x: 19, y: 22, w: 4, h: 2, encosto: 'baixo' },
          { tipo: 'cafe', x: 16, y: 19, w: 1, h: 3 },
          { tipo: 'pingpong', x: 26, y: 22, w: 4, h: 2 },
          { tipo: 'puff', x: 26, y: 18 }, { tipo: 'puff', x: 29, y: 18 },
          { tipo: 'planta', x: 16, y: 26 }, { tipo: 'planta', x: 31, y: 26 }, { tipo: 'planta', x: 31, y: 16 },
        ] },
      { id: 'pesquisador', nome: 'Pesquisador', funcao: 'pesquisador', x: 34, y: 15, w: 14, h: 13,
        portas: [{ x: 40, y: 15, w: 2, h: 1 }],
        estacoes: [{ x: 37, y: 20 }, { x: 43, y: 20 }, { x: 39, y: 24 }],
        moveis: [{ tipo: 'estante', x: 46, y: 17, w: 1, h: 5 }, { tipo: 'estante', x: 41, y: 26, w: 4, h: 1 }, { tipo: 'planta', x: 35, y: 26 }, { tipo: 'deco', x: 45, y: 24, w: 2, h: 3, arte: 'globo' }] },
    ],
    caminhos: [{ x: 0, y: 12, w: 48, h: 3 }], // corredor que liga todas as portas
    entrada: { x: 0, y: 13 },                // por onde chegam e saem os agentes
    // TV de gráficos da sala do Mestre (no bitmap, graficos-sala-mestre.png): clicável, abre o painel
    // com as métricas do time. O retângulo é o da lousa da sala `area`; mude a lousa e a TV acompanha.
    tv: { area: 'mestre', tipo: 'lousa' },

    textos: {
      titulo: 'Visão de Office',
      selo: 'Demonstração',
      seloUso: 'Uso simulado',
      seloDica: {
        tudo: 'Cena e uso do plano simulados: nenhum time ativo e a status line ainda não mandou dados',
        cena: 'Cena simulada: nenhum time ativo no gerenciador',
        uso: 'Uso do plano ilustrativo: a status line ainda não mandou dados',
      },
      subDemo: 'Sem time ativo no gerenciador · estados e tarefas sorteados',
      estados: { trabalhando: 'Trabalhando', aguardando: 'Aguardando você', ocioso: 'Ocioso', erro: 'Erro' },
      precisa: 'Precisa de você',
      erro: 'Erro',
      usoSessao: 'Sessão · 5h',
      usoSemanal: 'Semanal',
      usoSemDados: 'sem dados',
      telaCheia: 'Tela cheia',
      sairTelaCheia: 'Sair',
      entrada: 'Entrada',
      origens: { demo: 'Demonstração', sessao: 'Sessão principal', subagente: 'Subagente', dependente: 'Sessão dependente' },
      trocas: {
        delegar: (d) => [d ? 'Delegando: ' + d : 'Nova tarefa para você', 'Recebido!'],
        entregar: (d) => [d ? 'Entrega: ' + d : 'Tarefa entregue', 'Valeu!'],
        falhas: (d) => ['Falhas para corrigir' + (d ? ': ' + d : ''), 'Vou corrigir'],
        referencias: (d) => [d ? 'Referências: ' + d : 'Trouxe referências', 'Obrigado!'],
      },
      // Selo do balão quando a fala não traz o próprio prefixo ("Entrega: …").
      tiposTroca: { delegar: 'Delegando', entregar: 'Entrega', falhas: 'Falhas', referencias: 'Referências' },
      painel: {
        titulo: 'Painel do time', abrir: 'Painel do time: métricas dos agentes', fechar: 'Fechar',
        vazio: 'Nenhum agente no time ainda.', concluido: 'Concluído', vivo: 'Ao vivo', demo: 'Demonstração',
        resumo: ['Trabalhando', 'Aguardando', 'Com erro', 'Concluídos'], resumoDemo: 'Ociosos',
      },
    },

    tarefasDemo: {
      mestre: ['Coordenando a rodada 4', 'Revisando as entregas do time', 'Conferindo o plano', 'Planejando a próxima tarefa', 'Distribuindo as tarefas'],
      frontend: ['Ajustando o layout do painel', 'Edit · index.html', 'Refinando as pílulas de status', 'Corrigindo a rolagem em 420 px', 'Desenhando o cartão do agente', 'Animando a barra de uso'],
      backend: ['Testando a rota /uso', 'Edit · servidor.mjs', 'Ajustando o SSE /fluxo', 'Validando o hook.mjs', 'Persistindo o config.json', 'Lendo ~/.claude/sessions'],
      tester: ['Rodando a suíte de fumaça', 'Bash · node testes/office.test.mjs', 'Conferindo o console sem erros', 'Capturando telas em 1024×700', 'Verificando o atalho F'],
      pesquisador: ['Lendo o CSS do Orbit', 'Pesquisando pathfinding A*', 'WebSearch · Fullscreen API', 'Comparando paletas de status', 'Levantando referências de mapas'],
      auxiliar: ['Organizando os arquivos', 'Revisando o texto da ajuda'],
    },
    esperasDemo: {
      mestre: ['Aprovar o plano da rodada', 'Responder: qual porta usar nos testes?'],
      frontend: ['Permissão: Edit · index.html'],
      backend: ['Permissão: Bash · node servidor.mjs'],
      tester: ['Permissão: Bash · msedge --headless'],
      pesquisador: ['Permissão: WebFetch · github.com'],
      auxiliar: ['Permissão: Write · notas.md'],
    },
    errosDemo: {
      mestre: ['StopFailure: limite de contexto'],
      frontend: ['TypeError: el is null', 'Falha ao carregar office.css'],
      backend: ['EADDRINUSE: porta 47822 ocupada', 'SSE caiu: ECONNRESET'],
      tester: ['3 testes falharam no Edge', 'Timeout de 30 s na captura'],
      pesquisador: ['WebFetch: 403 Forbidden', 'Limite de buscas atingido'],
      auxiliar: ['Arquivo não encontrado'],
    },
    falhasDemo: ['nome cortado em 1024 px', 'balão sobre o crachá', 'rota /uso devolve 500', 'cor da barra semanal'],
    referenciasDemo: ['mapas isométricos', 'paleta do Orbit', 'A* com diagonais', 'barras de uso do plano'],
  };
  // ═════════════════════════════ fim da configuração ═════════════════════════════

  const C = CONFIG.grade.colunas;
  const R = CONFIG.grade.linhas;
  const T = CONFIG.textos;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const ATIVO = { trabalhando: true, aguardando: true };

  // ─────────────────────────────── utilidades ───────────────────────────────
  function h(tag, cls, pai, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    if (pai) pai.appendChild(e);
    return e;
  }
  function sv(tag, at, pai) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in at) e.setAttribute(k, at[k]);
    if (pai) pai.appendChild(e);
    return e;
  }
  function icone(caminhos, tam) {
    const v = sv('svg', { viewBox: '0 0 24 24', width: tam || 14, height: tam || 14, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    for (const d of [].concat(caminhos)) sv('path', { d }, v);
    return v;
  }
  const cortar = (t, n) => {
    n = n || CONFIG.maxBalao;
    t = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
  };
  const sorteio = (l) => l[Math.floor(Math.random() * l.length)];
  const entre = (a, b) => a + Math.random() * (b - a);
  const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const dois = (n) => String(n).padStart(2, '0');
  const horaCompleta = (d) => dois(d.getHours()) + ':' + dois(d.getMinutes()) + ':' + dois(d.getSeconds());
  function base(p) {
    p = String(p || '').trim();
    if (/^([a-z]:)?[\\/]/i.test(p)) return p.split(/[\\/]/).filter(Boolean).pop() || p;
    return p;
  }
  const ms = (t) => { t = Number(t) || 0; return t && t < 1e12 ? t * 1000 : t; };
  function fmtDur(d) {
    const s = Math.max(0, Math.round(d / 1000));
    if (s < 60) return s + ' s';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + dois(m % 60);
  }
  const fmtHa = (t) => (!t ? '—' : Date.now() - t < 5000 ? 'agora' : 'há ' + fmtDur(Date.now() - t));
  const fmtFerramenta = (f) => (f && f.nome ? f.nome + (f.alvo ? ' · ' + base(f.alvo) : '') : '');
  function chamar(fn, ...args) {
    try { return typeof fn === 'function' ? fn(...args) : undefined; } catch (e) { return undefined; }
  }

  // ─────────────────────────────── grade e A* ───────────────────────────────
  const caminhavel = new Uint8Array(C * R);
  const ehEstacao = new Uint8Array(C * R);
  const id = (x, y) => y * C + x;
  const pode = (x, y) => x >= 0 && y >= 0 && x < C && y < R && caminhavel[id(x, y)] === 1;
  const mesaDe = (e) => e.mesa || { x: e.x - 1, y: e.y - 1, w: 3, h: 1 };

  function montarGrade() {
    caminhavel.fill(0);
    ehEstacao.fill(0);
    const marcar = (r, v) => {
      for (let y = r.y; y < r.y + (r.h || 1); y++) for (let x = r.x; x < r.x + (r.w || 1); x++) {
        if (x >= 0 && y >= 0 && x < C && y < R) caminhavel[id(x, y)] = v;
      }
    };
    for (const a of CONFIG.areas) {
      marcar({ x: a.x + 1, y: a.y + 1, w: a.w - 2, h: a.h - 2 }, 1);
      for (const p of a.portas) marcar(p, 1);
    }
    for (const c of CONFIG.caminhos) marcar(c, 1);
    for (const a of CONFIG.areas) {
      for (const e of a.estacoes) marcar(mesaDe(e), 0);
      for (const m of a.moveis || []) if (m.bloqueia !== false) marcar(m, 0);
    }
    for (const a of CONFIG.areas) for (const e of a.estacoes) {
      ehEstacao[id(e.x, e.y)] = 1;
      if (!pode(e.x, e.y)) console.warn('[office] estação em célula bloqueada', a.id, e.x, e.y);
    }
    if (!pode(CONFIG.entrada.x, CONFIG.entrada.y)) console.warn('[office] entrada bloqueada');
  }

  const gCusto = new Float32Array(C * R);
  const fCusto = new Float32Array(C * R);
  const veio = new Int32Array(C * R);
  const fechado = new Uint8Array(C * R);
  const VIZ = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];

  function maisProximo(c) {
    let melhor = null, md = Infinity;
    for (let y = 0; y < R; y++) for (let x = 0; x < C; x++) {
      if (!caminhavel[id(x, y)]) continue;
      const d = Math.abs(x - c.x) + Math.abs(y - c.y);
      if (d < md) { md = d; melhor = { x, y }; }
    }
    return melhor;
  }

  // Caminho em 8 direções; diagonal só com os dois vizinhos ortogonais livres (não corta quina).
  // Devolve as células depois da inicial até o destino (inclusive), ou null.
  function aEstrela(ini, fim) {
    if (!pode(fim.x, fim.y)) fim = maisProximo(fim);
    if (!fim) return null;
    const i0 = id(ini.x, ini.y), alvo = id(fim.x, fim.y);
    if (i0 === alvo) return [];
    gCusto.fill(Infinity); fechado.fill(0); veio.fill(-1);
    const heu = (x, y) => {
      const dx = Math.abs(x - fim.x), dy = Math.abs(y - fim.y);
      return (dx + dy + (1.4142 - 2) * Math.min(dx, dy)) * 1.001;
    };
    const heap = [];
    const sobe = (k) => { while (k > 0) { const p = (k - 1) >> 1; if (fCusto[heap[p]] <= fCusto[heap[k]]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
    const desce = (k) => {
      for (;;) {
        const l = 2 * k + 1, r = l + 1; let m = k;
        if (l < heap.length && fCusto[heap[l]] < fCusto[heap[m]]) m = l;
        if (r < heap.length && fCusto[heap[r]] < fCusto[heap[m]]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]]; k = m;
      }
    };
    gCusto[i0] = 0; fCusto[i0] = heu(ini.x, ini.y); heap.push(i0);
    while (heap.length) {
      const atual = heap[0];
      const ult = heap.pop();
      if (heap.length) { heap[0] = ult; desce(0); }
      if (fechado[atual]) continue;
      fechado[atual] = 1;
      if (atual === alvo) break;
      const ax = atual % C, ay = (atual / C) | 0;
      for (const [dx, dy, custo] of VIZ) {
        const nx = ax + dx, ny = ay + dy;
        if (!pode(nx, ny)) continue;
        if (dx && dy && (!pode(ax + dx, ay) || !pode(ax, ay + dy))) continue;
        const ni = id(nx, ny);
        if (fechado[ni]) continue;
        // Evita atravessar estações alheias quando há outro jeito.
        const g = gCusto[atual] + custo + (ehEstacao[ni] && ni !== alvo ? 0.6 : 0);
        if (g < gCusto[ni]) {
          gCusto[ni] = g; fCusto[ni] = g + heu(nx, ny); veio[ni] = atual;
          heap.push(ni); sobe(heap.length - 1);
        }
      }
    }
    if (!fechado[alvo]) return null;
    const rota = [];
    for (let k = alvo; k !== i0 && k !== -1; k = veio[k]) rota.push({ x: k % C, y: (k / C) | 0 });
    return rota.reverse();
  }

  // ─────────────────────────────── estado ───────────────────────────────
  let raiz = null, palco = null, camAtores = null, camRot = null, topo = null, rodape = null, cartao = null;
  let ui = {};
  let api = null, desinscrever = [], ro = null, mq = null;
  let pausado = false, oculto = false, raf = 0, ultimoT = 0, relogio = 0, pausadoEm = 0;
  let cel = 20, S = 40, palcoW = 0, palcoH = 0, palcoX = 0, palcoY = 0, alturaFixa = false;
  let atores = [], porChave = new Map(), estacoes = [], interacoes = [], seqAtor = 0, seqInt = 0;
  let modo = null, timeId = null, forcarDemo = false, sujo = false, jaPovoou = false;
  let proximoDemo = 0, ultimoTester = null, selecionado = null, cartaoAssin = '';
  let reduzido = false, atualizadoEm = null, usoDemo = null, conexaoOk = true;
  let candidatosDescanso = [], rotulosDebug = [], placas = [], rodapeAssin = '', cabAssin = '';
  // Topo útil dos rótulos (px do palco; pode usar a folga sob o cabeçalho), borda de cima da tela e dt do quadro.
  let limTopo = 0, limBorda = 0, dtQuadro = 0;
  let tvPop = null, tvAberta = false, tvAnim = null, tvAssin = '', tvLinhas = new Map(), timeDescs = [];
  const FAIXA_PLACAS = 26; // espaço acima do mapa para as placas das salas de cima

  function montarEstacoes() {
    estacoes = [];
    for (const a of CONFIG.areas) for (const e of a.estacoes) {
      estacoes.push({ x: e.x, y: e.y, funcao: e.funcao || a.funcao, area: a, destaque: !!e.destaque, mesa: mesaDe(e), ator: null, tela: null, e: '' });
    }
    const desc = CONFIG.areas.find((a) => a.descanso);
    candidatosDescanso = [];
    if (desc) {
      const portas = desc.portas;
      for (let y = desc.y + 2; y < desc.y + desc.h - 1; y++) for (let x = desc.x + 1; x < desc.x + desc.w - 1; x++) {
        if (!pode(x, y)) continue;
        if (portas.some((p) => x >= p.x - 1 && x <= p.x + p.w && y <= p.y + 2)) continue; // livra a entrada
        candidatosDescanso.push({ x, y });
      }
    }
  }

  function areaDaCelula(x, y) {
    for (const a of CONFIG.areas) if (x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h) return a;
    return null;
  }

  // ─────────────────────────────── planta (SVG) ───────────────────────────────
  function desenharPlanta(comFundo = false) {
    const g = sv('svg', { class: 'of-planta', viewBox: `0 0 ${C} ${R}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    if (comFundo) {
      for (const a of CONFIG.areas) {
        const cor = a.funcao ? CONFIG.funcoes[a.funcao].cor : '#737373';
        sv('line', { x1: a.x + 1.3, y1: a.y + 0.5, x2: a.x + 3.6, y2: a.y + 0.5, stroke: cor, class: 'of-fio-cor' }, g);
      }
      for (const e of estacoes) desenharEstacao(g, e, true);
      return g;
    }
    const defs = sv('defs', {}, g);
    const pat = sv('pattern', { id: 'of-pontos', width: 1, height: 1, patternUnits: 'userSpaceOnUse' }, defs);
    sv('circle', { cx: 0.5, cy: 0.5, r: 0.045, fill: '#2a2a2a' }, pat);

    // Corredor
    // Corredor: faixa entre as paredes das salas, sem contorno, com a trilha pontilhada no meio.
    for (const c of CONFIG.caminhos) {
      sv('rect', { x: c.x + 0.5, y: c.y - 0.5, width: c.w - 1, height: c.h + 1, rx: 0.6, class: 'of-corredor' }, g);
      const meio = c.y + c.h / 2;
      for (let x = c.x + 2; x < c.x + c.w - 1; x += 1) sv('circle', { cx: x, cy: meio, r: 0.05, class: 'of-trilha' }, g);
    }
    const ent = CONFIG.entrada;
    sv('path', { d: `M${ent.x + 0.55} ${ent.y + 0.2} l0.35 0.3 l-0.35 0.3`, class: 'of-seta' }, g);

    for (const a of CONFIG.areas) {
      const cor = a.funcao ? CONFIG.funcoes[a.funcao].cor : '#737373';
      sv('rect', { x: a.x + 0.5, y: a.y + 0.5, width: a.w - 1, height: a.h - 1, rx: 0.6, class: 'of-sala' + (a.descanso ? ' of-sala-desc' : '') }, g);
      sv('rect', { x: a.x + 0.5, y: a.y + 0.5, width: a.w - 1, height: a.h - 1, rx: 0.6, fill: 'url(#of-pontos)', class: 'of-sala-pont' }, g);
      sv('line', { x1: a.x + 1.3, y1: a.y + 0.5, x2: a.x + 3.6, y2: a.y + 0.5, stroke: cor, class: 'of-fio-cor' }, g);
      // Porta: vão na parede (a linha da parede passa no meio da célula de parede).
      for (const p of a.portas) {
        const pw = p.w || 1, ph = p.h || 1;
        if (p.y === a.y || p.y === a.y + a.h - 1) {
          const ly = p.y + 0.5;
          sv('rect', { x: p.x + 0.06, y: ly - 0.14, width: pw - 0.12, height: 0.28, class: 'of-porta' }, g);
          sv('circle', { cx: p.x + 0.06, cy: ly, r: 0.07, class: 'of-batente' }, g);
          sv('circle', { cx: p.x + pw - 0.06, cy: ly, r: 0.07, class: 'of-batente' }, g);
        } else {
          const lx = p.x + 0.5;
          sv('rect', { x: lx - 0.14, y: p.y + 0.06, width: 0.28, height: ph - 0.12, class: 'of-porta' }, g);
          sv('circle', { cx: lx, cy: p.y + 0.06, r: 0.07, class: 'of-batente' }, g);
          sv('circle', { cx: lx, cy: p.y + ph - 0.06, r: 0.07, class: 'of-batente' }, g);
        }
      }
      const moveis = (a.moveis || []).slice().sort((m1, m2) => (m1.bloqueia === false ? -1 : 0) - (m2.bloqueia === false ? -1 : 0));
      for (const m of moveis) desenharMovel(g, m);
    }
    for (const e of estacoes) desenharEstacao(g, e);
    return g;
  }

  function desenharEstacao(g, e, soTela = false) {
    const m = e.mesa;
    const cx = e.x + 0.5;
    if (!soTela) {
    sv('circle', { cx, cy: e.y + 0.42, r: 0.3, class: 'of-cadeira' }, g);
    sv('rect', { x: m.x + 0.08, y: m.y + 0.1, width: m.w - 0.16, height: m.h - 0.2, rx: 0.14, class: 'of-mesa' + (e.destaque ? ' of-mesa-mestre' : '') }, g);
    // O robô fica no meio, virado para a direita: o monitor fica na ponta direita da mesa,
    // fora do corpo dele (a mesa da Mestre tem dois, um em cada ponta).
    sv('rect', { x: cx - 0.36, y: m.y + 0.58, width: 0.72, height: 0.12, rx: 0.03, class: 'of-teclado' }, g);
    }
    const tela = sv('g', { class: 'of-tela', 'data-e': 'apagada' }, g);
    for (const lado of e.destaque ? [-1, 1] : [1]) {
      const mw = 0.74, mx = lado > 0 ? m.x + m.w - 0.84 : m.x + 0.1;
      sv('rect', { x: mx - 0.16, y: m.y - 0.08, width: mw + 0.32, height: 0.86, rx: 0.2, class: 'of-halo' }, tela);
      sv('rect', { x: mx, y: m.y + 0.12, width: mw, height: 0.52, rx: 0.07, class: 'of-vidro' }, tela);
      [[0.22, 0.6], [0.33, 0.85], [0.44, 0.45]].forEach(([dy, f]) => sv('rect', { x: mx + 0.1, y: m.y + dy, width: (mw - 0.2) * f, height: 0.05, rx: 0.02, class: 'of-cod' }, tela));
      sv('path', { d: `M${mx + mw / 2} ${m.y + 0.19} l0.19 0.36 h-0.38 z`, class: 'of-alerta' }, tela);
    }
    e.tela = tela;
  }

  function desenharMovel(g, m) {
    const x = m.x, y = m.y, w = m.w || 1, hh = m.h || 1, p = 0.1;
    switch (m.tipo) {
      case 'deco': return; // Decoração do bitmap: apenas bloqueia a grade.
      case 'planta': {
        const cx = x + 0.5, cy = y + 0.5;
        sv('circle', { cx, cy, r: 0.36, class: 'of-vaso' }, g);
        for (let k = 0; k < 5; k++) {
          const ang = (k / 5) * Math.PI * 2 - Math.PI / 2;
          sv('circle', { cx: cx + Math.cos(ang) * 0.17, cy: cy + Math.sin(ang) * 0.17, r: 0.16, class: 'of-folha' }, g);
        }
        sv('circle', { cx, cy, r: 0.08, class: 'of-folha-c' }, g);
        break;
      }
      case 'lousa': {
        sv('rect', { x: x + p, y: y + 0.18, width: w - 2 * p, height: 0.64, rx: 0.08, class: 'of-lousa' }, g);
        sv('line', { x1: x + 0.4, y1: y + 0.4, x2: x + w * 0.5, y2: y + 0.4, class: 'of-rabisco' }, g);
        sv('line', { x1: x + 0.4, y1: y + 0.58, x2: x + w * 0.35, y2: y + 0.58, class: 'of-rabisco' }, g);
        ['#f59e0b', '#818cf8', '#2dd4bf'].forEach((c, k) => sv('rect', { x: x + w - 0.5 - k * 0.32, y: y + 0.32, width: 0.22, height: 0.22, rx: 0.03, fill: c, opacity: 0.55 }, g));
        break;
      }
      case 'rack': {
        sv('rect', { x: x + p, y: y + p, width: w - 2 * p, height: hh - 2 * p, rx: 0.1, class: 'of-rack' }, g);
        const n = Math.round(hh * 3);
        for (let k = 0; k < n; k++) {
          const ly = y + 0.3 + k * ((hh - 0.45) / Math.max(1, n - 1));
          sv('line', { x1: x + 0.22, y1: ly, x2: x + w - 0.42, y2: ly, class: 'of-slot' }, g);
          sv('circle', { cx: x + w - 0.26, cy: ly, r: 0.05, class: 'of-led' + (k % 3 === 1 ? ' of-led-b' : k % 3 === 2 ? ' of-led-c' : '') }, g);
        }
        break;
      }
      case 'estante': {
        sv('rect', { x: x + p, y: y + p, width: w - 2 * p, height: hh - 2 * p, rx: 0.08, class: 'of-estante' }, g);
        const vertical = hh > w;
        const n = Math.floor((vertical ? hh : w) * 4);
        const cores = ['#3f3f46', '#4c4f6b', '#3d5a52', '#5a4a3d', '#4a3d5a'];
        for (let k = 0; k < n; k++) {
          const f = 0.2 + k * 0.25;
          const c = cores[k % cores.length];
          if (vertical) sv('rect', { x: x + 0.22, y: y + f, width: w - 0.44, height: 0.16, rx: 0.02, fill: c }, g);
          else sv('rect', { x: x + f, y: y + 0.22, width: 0.16, height: hh - 0.44, rx: 0.02, fill: c }, g);
        }
        break;
      }
      case 'bancada': {
        sv('rect', { x: x + p, y: y + 0.15, width: w - 2 * p, height: hh - 0.3, rx: 0.1, class: 'of-mesa' }, g);
        for (let k = 0; k < w; k++) sv('rect', { x: x + k + 0.36, y: y + 0.25, width: 0.28, height: 0.5, rx: 0.06, class: 'of-aparelho' }, g);
        break;
      }
      case 'sofa': {
        sv('rect', { x: x + p, y: y + p, width: w - 2 * p, height: hh - 2 * p, rx: 0.26, class: 'of-sofa' }, g);
        const encY = m.encosto === 'baixo' ? y + hh - 0.36 : y + 0.12;
        sv('rect', { x: x + 0.16, y: encY, width: w - 0.32, height: 0.24, rx: 0.1, class: 'of-encosto' }, g);
        for (let k = 1; k < w; k++) sv('line', { x1: x + k, y1: y + 0.3, x2: x + k, y2: y + hh - 0.3, class: 'of-costura' }, g);
        break;
      }
      case 'mesinha':
        sv('rect', { x: x + 0.15, y: y + 0.18, width: w - 0.3, height: hh - 0.36, rx: 0.18, class: 'of-mesinha' }, g);
        sv('circle', { cx: x + 0.6, cy: y + 0.5, r: 0.1, class: 'of-xicara' }, g);
        sv('circle', { cx: x + w - 0.6, cy: y + 0.5, r: 0.1, class: 'of-xicara' }, g);
        break;
      case 'cafe':
        sv('rect', { x: x + p, y: y + p, width: w - 2 * p, height: hh - 2 * p, rx: 0.1, class: 'of-mesa' }, g);
        sv('rect', { x: x + 0.2, y: y + 0.25, width: w - 0.4, height: 0.7, rx: 0.1, class: 'of-maquina' }, g);
        sv('circle', { cx: x + 0.5, cy: y + 0.45, r: 0.06, class: 'of-led of-led-r' }, g);
        for (let k = 0; k < hh - 1; k++) sv('circle', { cx: x + 0.5, cy: y + 1.5 + k, r: 0.12, class: 'of-xicara' }, g);
        break;
      case 'pingpong':
        sv('rect', { x: x + p, y: y + p, width: w - 2 * p, height: hh - 2 * p, rx: 0.08, class: 'of-ping' }, g);
        sv('line', { x1: x + w / 2, y1: y + p, x2: x + w / 2, y2: y + hh - p, class: 'of-rede' }, g);
        sv('line', { x1: x + p, y1: y + hh / 2, x2: x + w - p, y2: y + hh / 2, class: 'of-ping-l' }, g);
        sv('circle', { cx: x + w * 0.3, cy: y + hh * 0.35, r: 0.07, class: 'of-bola' }, g);
        break;
      case 'puff':
        sv('circle', { cx: x + 0.5, cy: y + 0.5, r: 0.38, class: 'of-puff' }, g);
        break;
      case 'tapete':
        sv('rect', { x: x + 0.1, y: y + 0.1, width: w - 0.2, height: hh - 0.2, rx: 0.5, class: 'of-tapete' }, g);
        break;
      default:
        sv('rect', { x: x + p, y: y + p, width: w - 2 * p, height: hh - 2 * p, rx: 0.1, class: 'of-mesa' }, g);
    }
  }

  // ─────────────────────────────── fundo (bitmap) ───────────────────────────────
  function carregarFundo(src) {
    const alvo = palco;
    const imagem = new Image();
    imagem.onload = () => {
      if (palco !== alvo) return; // Ignore a late response after unmount/remount.
      if (imagem.naturalWidth / imagem.naturalHeight !== C / R) return;
      // Telas de alta densidade usam a versão @2x (mesmo nome com sufixo).
      const fundo2x = src.replace(/(\.\w+)(\?.*)?$/, '@2x$1$2');
      alvo.style.backgroundImage = 'url(' + JSON.stringify(src) + ')';
      alvo.style.backgroundImage = 'image-set(url(' + JSON.stringify(src) + ') 1x, url(' + JSON.stringify(fundo2x) + ') 2x)';
      const planta = alvo.querySelector('.of-planta');
      if (planta) planta.replaceWith(desenharPlanta(true));
      for (const e of estacoes) e.e = ''; // Refresh dynamic screen state.
      desenhar();
    };
    imagem.onerror = () => { /* SVG fallback (or the previous bitmap) stays. */ };
    imagem.src = src;
  }

  // Peças de assets/office/assets separados: testes/aplicar-assets-office.py recompõe o
  // fundo e troca a versão em fundo-versao.json; o palco recarrega o bitmap sem remontar.
  let fundoVersao = null, fundoTimer = 0;
  function vigiarFundo() {
    clearInterval(fundoTimer);
    if (!CONFIG.fundo || !window.fetch) return;
    const url = CONFIG.fundo.replace(/[^/]*$/, 'fundo-versao.json');
    const checar = () => {
      if (pausado || oculto || !palco) return;
      fetch(url, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => {
        if (!j || !j.v || j.v === fundoVersao || !palco) return;
        fundoVersao = j.v;
        carregarFundo(CONFIG.fundo + '?v=' + encodeURIComponent(j.v));
      }).catch(() => {});
    };
    checar();
    fundoTimer = setInterval(checar, 2000);
  }

  // ─────────────────────────────── DOM da aba ───────────────────────────────
  function construir(el) {
    raiz = h('div', 'of-raiz', el);
    raiz.setAttribute('role', 'application');
    raiz.setAttribute('aria-label', T.titulo);

    topo = h('div', 'of-topo', raiz);
    const tit = h('div', 'of-tit', topo);
    const linhaT = h('div', 'of-tit-linha', tit);
    h('h2', '', linhaT, T.titulo);
    ui.selo = h('span', 'of-selo', linhaT, T.selo);
    ui.selo.hidden = true;
    ui.sub = h('p', 'of-sub', tit, '');

    const dir = h('div', 'of-topo-dir', topo);
    ui.uso = h('div', 'of-uso', dir);
    ui.usoItens = [montarUsoItem(ui.uso, T.usoSessao), montarUsoItem(ui.uso, T.usoSemanal)];
    ui.btnCheia = h('button', 'of-btn of-btn-cheia', dir);
    ui.btnCheia.type = 'button';
    ui.btnCheia.appendChild(icone(['M8 3H5a2 2 0 0 0-2 2v3', 'M21 8V5a2 2 0 0 0-2-2h-3', 'M3 16v3a2 2 0 0 0 2 2h3', 'M16 21h3a2 2 0 0 0 2-2v-3']));
    ui.btnCheiaTxt = h('span', '', ui.btnCheia, T.telaCheia);
    ui.btnCheia.setAttribute('aria-label', T.telaCheia);
    ui.btnCheia.addEventListener('click', alternarTelaCheia);

    palco = h('div', 'of-palco', raiz);
    palco.appendChild(desenharPlanta());
    // Keep the complete SVG visible until the bitmap has actually loaded.
    if (CONFIG.fundo) carregarFundo(CONFIG.fundo);
    const rotAreas = h('div', 'of-camada of-areas', palco);
    // Placa da sala: fora da sala, logo acima da parede de cima (posição em px no layout()).
    placas = [];
    for (const a of CONFIG.areas) {
      const r = h('div', 'of-area-rot', rotAreas);
      r.style.setProperty('--cor', a.funcao ? CONFIG.funcoes[a.funcao].cor : '#737373');
      h('i', '', r);
      h('b', '', r, a.nome);
      placas.push({ el: r, a, x: 0, y: 0, w: 0, h: 0, sob: false });
    }
    const ent = h('div', 'of-area-rot of-entrada', rotAreas);
    ent.style.left = ((CONFIG.entrada.x + 1.1) / C) * 100 + '%';
    ent.style.top = ((CONFIG.caminhos[0].y + 0.3) / R) * 100 + '%';
    h('small', '', ent, T.entrada);

    // TV da sala do Mestre: área clicável sobre o desenho, abaixo dos robôs.
    const tv = retanguloTV();
    ui.tv = h('button', 'of-tv', palco);
    ui.tv.type = 'button';
    ui.tv.setAttribute('aria-label', T.painel.abrir);
    ui.tv.setAttribute('aria-haspopup', 'dialog');
    ui.tv.setAttribute('aria-expanded', 'false');
    ui.tv.style.left = (tv.x / C) * 100 + '%';
    ui.tv.style.top = (tv.y / R) * 100 + '%';
    ui.tv.style.width = (tv.w / C) * 100 + '%';
    ui.tv.style.height = (tv.h / R) * 100 + '%';
    ui.tv.addEventListener('click', (ev) => { ev.stopPropagation(); if (tvAberta) fecharTV(); else abrirTV(); });

    camAtores = h('div', 'of-camada of-atores', palco);
    camRot = h('div', 'of-camada of-rotulos', palco);
    palco.addEventListener('click', (ev) => { if (ev.target === palco || ev.target.closest('.of-planta')) selecionar(null); });

    cartao = h('aside', 'of-cartao', raiz);
    cartao.hidden = true;
    cartao.setAttribute('role', 'dialog');
    cartao.setAttribute('aria-label', 'Agente');
    const cc = h('div', 'of-c-cab', cartao);
    const av = h('div', 'of-c-av', cc);
    const avImg = h('img', '', av);
    avImg.src = CONFIG.robos.parado; avImg.alt = '';
    const ct = h('div', 'of-c-tit', cc);
    ui.cNome = h('b', '', ct, '');
    ui.cPapel = h('small', '', ct, '');
    const fechar = h('button', 'of-c-fechar', cc);
    fechar.type = 'button';
    fechar.setAttribute('aria-label', 'Fechar');
    fechar.appendChild(icone(['M18 6 6 18', 'M6 6l12 12']));
    fechar.addEventListener('click', () => selecionar(null));
    const dl = h('dl', 'of-c-dl', cartao);
    const linha = (rot) => { h('dt', '', dl, rot); return h('dd', '', dl, ''); };
    ui.cFuncao = linha('Função');
    ui.cArea = linha('Área');
    ui.cEstadoDd = linha('Estado');
    ui.cEstado = h('span', 'of-pilula', ui.cEstadoDd, '');
    ui.cTarefa = linha('Tarefa');
    ui.cOrigem = linha('Origem');
    ui.cAbrir = h('button', 'of-btn of-btn-p of-c-abrir', cartao, 'Abrir conversa'); // etapa 5: abre a Conversa do Orbit
    ui.cAbrir.type = 'button';
    ui.cAbrir.hidden = true;
    ui.cAbrir.addEventListener('click', () => {
      const a = atorPorId(selecionado);
      if (a && a.sessaoId && api) chamar(typeof api.abrirSessao === 'function' ? api.abrirSessao : api.abrirVSCode, a.sessaoId);
    });

    construirTV();

    rodape = h('div', 'of-rodape', raiz);
    ui.modoPonto = h('i', 'of-r-ponto', rodape);
    ui.modo = h('span', 'of-r-modo', rodape, '');
    ui.contagem = h('span', 'of-r-cont', rodape, '');
    h('span', 'of-espaco', rodape);
    ui.atualizado = h('span', 'of-r-atual', rodape, '');
  }

  function montarUsoItem(pai, rotulo) {
    const it = h('div', 'of-uso-item', pai);
    const cab = h('div', 'of-uso-cab', it);
    h('span', '', cab, rotulo);
    const pct = h('b', 'of-num', cab, '—');
    const barra = h('div', 'of-barra', it);
    barra.setAttribute('role', 'meter');
    barra.setAttribute('aria-label', rotulo);
    barra.setAttribute('aria-valuemin', '0');
    barra.setAttribute('aria-valuemax', '100');
    const enc = h('i', '', barra);
    const ren = h('small', 'of-num', it, '');
    return { it, pct, barra, enc, ren };
  }

  // ─────────────────────────────── layout ───────────────────────────────
  function layout() {
    if (!raiz) return;
    if (!alturaFixa && raiz.clientHeight < 200 && !document.fullscreenElement) {
      const top = raiz.getBoundingClientRect().top;
      raiz.style.height = Math.max(420, window.innerHeight - Math.max(0, top)) + 'px';
    }
    const W = raiz.clientWidth, H = raiz.clientHeight;
    if (!W || !H) return;
    const th = topo.offsetHeight, rh = rodape.offsetHeight;
    const m = W < 700 ? 8 : 18;
    const aw = W - 2 * m, ah = H - th - rh - 16 - FAIXA_PLACAS;
    cel = Math.max(4, Math.min(aw / C, ah / R));
    palcoW = cel * C; palcoH = cel * R;
    palco.style.width = palcoW + 'px';
    palco.style.height = palcoH + 'px';
    palcoX = Math.round((W - palcoW) / 2);
    palco.style.left = palcoX + 'px';
    const palcoTop = Math.round(th + 8 + FAIXA_PLACAS + (ah - palcoH) / 2);
    palcoY = palcoTop;
    palco.style.top = palcoTop + 'px';
    limTopo = Math.min(2, th + 4 - palcoTop);
    limBorda = 2 - palcoTop;
    S = cel >= 23 ? 60 : cel >= 15 ? 40 : Math.max(16, Math.round(cel * 2.4));
    palco.style.setProperty('--of-s', S + 'px');
    cartao.style.top = th + 10 + 'px';
    palco.style.setProperty('--of-cel', cel + 'px');
    palco.classList.toggle('of-compacto', cel < 16);
    // Placas: alinhadas à face de fora da parede esquerda, com a base 0,12 célula acima da sala
    // (nas salas de baixo ficam no corredor, sem encostar nos batentes das portas).
    for (const p of placas) {
      p.w = p.el.offsetWidth; p.h = p.el.offsetHeight;
      p.x = Math.round((p.a.x + 0.3) * cel); p.y = Math.round((p.a.y - 0.12) * cel - p.h);
      p.el.style.left = p.x + 'px'; p.el.style.top = p.y + 'px';
    }
    for (const a of atores) { a.ult = {}; }
    if (tvAberta) posicionarTV();
  }

  // ─────────────────────────────── atores ───────────────────────────────
  const atorPorId = (i) => atores.find((a) => a.id === i) || null;
  const mestreAtor = () => atores.find((a) => a.funcao === 'mestre' && !a.saindo) || null;
  const celulaDe = (a) => ({ x: Math.floor(a.x), y: Math.floor(a.y) });
  const naEstacao = (a) => a.estacao && !a.caminho.length && Math.floor(a.x) === a.estacao.x && Math.floor(a.y) === a.estacao.y;
  const chegou = (a, c) => !a.caminho.length && Math.floor(a.x) === c.x && Math.floor(a.y) === c.y;
  const livre = (a) => !a.visita && !a.hospeda.length && !interacoes.some((it) => it.v === a || it.h === a);

  function alocarEstacao(funcao, a) {
    const pega = (f) => estacoes.find((e) => !e.ator && e.funcao === f);
    const e = pega(funcao) || (funcao !== 'mestre' ? pega('auxiliar') : null);
    if (e) e.ator = a;
    return e || null;
  }

  function nomeNovo(funcao) {
    const n = atores.filter((a) => !a.saindo && a.funcao === funcao).length;
    const base = (CONFIG.funcoes[funcao] || CONFIG.funcoes.auxiliar).nome;
    return n ? base + ' ' + (n + 1) : base;
  }

  function criarAtor(d, onde) {
    const a = {
      id: 'r' + ++seqAtor, chave: d.chave, funcao: d.funcao, nome: d.nome || nomeNovo(d.funcao), origem: d.origem,
      estado: 'ocioso', bruto: '', tarefa: '', espera: '', motivo: '', descricao: '', tipo: '', sessaoId: null,
      x: 0, y: 0, caminho: [], alvo: null, andando: false, virado: false, acc: 0,
      estacao: null, descanso: null, descansoAte: 0, visita: null, hospeda: [], saindo: false, saiu: false,
      dom: null, ult: {}, balao: null, balaoAssin: '', medirBalao: false, wb: 0, hb: 0, wc: 0, hc: 0,
      liftC: 0, liftB: 0, z: -1, lado: 0, offC: 0, offB: 0, encaixarB: true,
      desde: Date.now(), m: null,
    };
    a.estacao = alocarEstacao(d.funcao, a);
    atualizarAtor(a, d);
    const p = onde === 'entrada' ? CONFIG.entrada : destino(a);
    a.x = p.x + 0.5; a.y = p.y + 0.5;
    a.alvo = onde === 'entrada' ? null : { x: p.x, y: p.y };
    criarDomAtor(a, onde === 'entrada');
    atores.push(a);
    porChave.set(a.chave, a);
    return a;
  }

  function atualizarAtor(a, d) {
    const antes = a.estado;
    a.estado = d.estado || 'ocioso';
    a.bruto = d.bruto || a.estado;
    a.tarefa = d.tarefa || '';
    a.espera = d.espera || T.precisa;
    a.motivo = d.motivo || 'Falha sem detalhe';
    a.descricao = d.descricao || '';
    a.tipo = d.tipo || '';
    a.sessaoId = d.sessaoId || null;
    if ('dormindo' in d) a.dormindo = !!d.dormindo;
    if (d.m) a.m = d.m;
    if (antes !== a.estado) {
      a.desde = Date.now();
      if (a.estado !== 'ocioso') a.descanso = null;
      a.descansoAte = 0;
    }
  }

  function definir(a, estado, tarefa, extra) {
    if (a.m && a.origem === 'demo') metricasDemo(a, estado);
    atualizarAtor(a, { estado, bruto: estado, tarefa: tarefa == null ? a.tarefa : tarefa, espera: estado === 'aguardando' ? extra : a.espera, motivo: estado === 'erro' ? extra : a.motivo, descricao: a.descricao, tipo: a.tipo, sessaoId: a.sessaoId });
  }

  function sair(a) {
    if (a.saindo) return;
    a.saindo = true;
    if (a.estacao) { a.estacao.ator = null; a.estacao = null; }
    a.descanso = null;
    porChave.delete(a.chave);
    for (const it of interacoes) if (it.v === a || it.h === a) encerrar(it, false);
    if (selecionado === a.id) selecionar(null);
  }

  function criarDomAtor(a, entrando) {
    const b = h('button', 'of-ator' + (entrando ? ' of-entrando' : ''), camAtores);
    b.type = 'button';
    b.setAttribute('aria-label', a.nome);
    h('i', 'of-sombra', b);
    h('i', 'of-anel', b);
    const run = h('img', 'of-img', b);
    run.src = CONFIG.robos.andando; run.alt = ''; run.draggable = false;
    const idle = h('img', 'of-img', b);
    idle.src = CONFIG.robos.parado; idle.alt = ''; idle.draggable = false;
    run.hidden = true;
    const zz = h('img', 'of-img of-dorme', b); // folha de 4 quadros (zZ), animada pelo CSS
    zz.src = CONFIG.robos.dormindo; zz.alt = ''; zz.draggable = false; zz.hidden = true;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); selecionar(a.id); });

    const cr = h('div', 'of-cracha', camRot);
    cr.dataset.e = a.estado;
    h('i', 'of-ponto', cr);
    h('span', 'of-nome', cr, a.nome);
    cr.addEventListener('click', (ev) => { ev.stopPropagation(); selecionar(a.id); });

    const bal = h('div', 'of-balao', camRot);
    bal.style.setProperty('--fd', (-Math.random() * 3.6).toFixed(2) + 's'); // cada balão flutua no seu tempo
    const cab = h('div', 'of-b-cab', bal);
    const tit = h('b', 'of-b-tit', cab, '');
    const para = h('span', 'of-b-para', cab);
    h('span', '', para, '→');
    const paraNome = h('b', '', para, '');
    const txt = h('span', 'of-b-txt', bal, '');
    h('i', 'of-b-ponta', bal);
    h('i', 'of-haste', bal);
    a.dom = { b, run, idle, zz, cr, bal, cab, tit, para, paraNome, txt };
    a.medirCracha = true;
  }

  function removerDom(a) {
    if (!a.dom) return;
    a.dom.b.remove(); a.dom.cr.remove(); a.dom.bal.remove();
    a.dom = null;
  }

  // ─────────────────────────────── movimento ───────────────────────────────
  function escolherDescanso(a) {
    const outros = atores.filter((o) => o !== a && o.descanso).map((o) => o.descanso);
    for (let k = 0; k < 30; k++) {
      const c = sorteio(candidatosDescanso);
      if (!c) break;
      if (outros.some((o) => Math.max(Math.abs(o.x - c.x), Math.abs(o.y - c.y)) < 3)) continue;
      a.descanso = c;
      return c;
    }
    a.descanso = sorteio(candidatosDescanso) || CONFIG.entrada;
    return a.descanso;
  }

  function destino(a) {
    if (a.saindo) return CONFIG.entrada;
    if (a.visita && a.visita.fase !== 'fila') return a.visita.spot;
    const host = a.hospeda.find((it) => it.fase !== 'fila');
    if (host) return host.ancora;
    if (a.estado !== 'ocioso' && a.estacao) return { x: a.estacao.x, y: a.estacao.y };
    if (!a.descanso) escolherDescanso(a);
    if (a.descansoAte && relogio > a.descansoAte && chegou(a, a.descanso)) {
      escolherDescanso(a);
      a.descansoAte = 0;
    }
    return a.descanso;
  }

  function irPara(a, alvo) {
    if (a.alvo && a.alvo.x === alvo.x && a.alvo.y === alvo.y) return;
    a.alvo = { x: alvo.x, y: alvo.y };
    let ini, prefixo = [];
    if (a.caminho.length) { ini = a.caminho[0]; prefixo = [ini]; } // termina o passo em curso
    else ini = celulaDe(a);
    const rota = aEstrela(ini, alvo);
    a.caminho = prefixo.concat(rota || []);
  }

  function mover(a, dt) {
    if (!a.caminho.length) { a.andando = false; a.acc = 0; return; }
    a.andando = true;
    if (reduzido) {
      a.acc += dt;
      const passo = 1 / CONFIG.passosPorSegundoReduzido;
      while (a.acc >= passo && a.caminho.length) {
        a.acc -= passo;
        const c = a.caminho.shift();
        if (c.x + 0.5 !== a.x) a.virado = c.x + 0.5 < a.x;
        a.x = c.x + 0.5; a.y = c.y + 0.5;
      }
    } else {
      let resto = CONFIG.velocidade * dt;
      while (resto > 0 && a.caminho.length) {
        const c = a.caminho[0];
        const tx = c.x + 0.5, ty = c.y + 0.5;
        const dx = tx - a.x, dy = ty - a.y;
        const d = Math.hypot(dx, dy);
        if (Math.abs(dx) > 0.01) a.virado = dx < 0;
        if (d <= resto) { a.x = tx; a.y = ty; resto -= d; a.caminho.shift(); }
        else { a.x += (dx / d) * resto; a.y += (dy / d) * resto; resto = 0; }
      }
    }
    if (!a.caminho.length) { a.andando = false; a.acc = 0; }
  }

  // ─────────────────────────────── interações ───────────────────────────────
  function enfileirar(tipo, v, hh, desc, aoFim) {
    if (!v || !hh || v === hh || v.saindo || hh.saindo) return;
    const [tv, th] = T.trocas[tipo](desc ? String(desc) : '');
    interacoes.push({ id: ++seqInt, tipo, v, h: hh, tv: cortar(tv), th: cortar(th), fase: 'fila', criada: relogio, spot: null, ancora: null, t0: 0, aoFim });
  }

  function escolherSpot(anc, it) {
    const usados = interacoes.filter((o) => o !== it && o.spot).map((o) => o.spot);
    const offs = [[-2, 0], [2, 0], [-1, 1], [1, 1], [-2, 1], [2, 1], [0, 2], [-1, 0], [1, 0], [0, 1]];
    for (const [dx, dy] of offs) {
      const x = anc.x + dx, y = anc.y + dy;
      if (!pode(x, y) || ehEstacao[id(x, y)]) continue;
      if (usados.some((u) => u.x === x && u.y === y)) continue;
      return { x, y };
    }
    return null;
  }

  let historicoInt = [];
  function encerrar(it, ok) {
    if (it.fase === 'fim') return;
    historicoInt.push({ tipo: it.tipo, v: it.v.nome, h: it.h.nome, ok: !!ok, conversou: it.fase === 'conversa' });
    if (historicoInt.length > 40) historicoInt.shift();
    it.fase = 'fim';
    if (it.v.visita === it) it.v.visita = null;
    it.h.hospeda = it.h.hospeda.filter((o) => o !== it);
    if (ok && it.aoFim) { try { it.aoFim(it); } catch (e) { /* demo */ } }
  }

  function processarInteracoes() {
    for (const it of interacoes) {
      if (it.fase === 'fim') continue;
      if (it.v.saindo || it.h.saindo) { encerrar(it, false); continue; }
      if (it.fase === 'fila') {
        if (relogio - it.criada > CONFIG.filaMaxMs) { encerrar(it, false); continue; }
        // Os dados andam mais rápido que os robôs: delegar a quem já terminou não faz sentido.
        if (it.tipo === 'delegar' && it.h.estado === 'ocioso' && !ATIVO[it.h.bruto]) { encerrar(it, false); continue; }
        if (it.v.visita || it.v.hospeda.length || it.h.visita || it.h.hospeda.length >= 2) continue;
        const ancora = it.h.estacao ? { x: it.h.estacao.x, y: it.h.estacao.y } : celulaDe(it.h);
        const spot = escolherSpot(ancora, it);
        if (!spot) continue;
        it.ancora = ancora; it.spot = spot; it.fase = 'indo'; it.t0 = relogio;
        it.v.visita = it; it.h.hospeda.push(it);
      } else if (it.fase === 'indo') {
        if (chegou(it.v, it.spot) && chegou(it.h, it.ancora)) {
          it.fase = 'conversa'; it.t0 = relogio;
        } else if (relogio - it.t0 > CONFIG.caminhadaMaxMs) encerrar(it, false);
      } else if (it.fase === 'conversa') {
        it.v.virado = it.h.x < it.v.x;
        if (!it.h.andando) it.h.virado = it.v.x < it.h.x;
        if (relogio - it.t0 > CONFIG.conversaMs) encerrar(it, true);
      }
    }
    interacoes = interacoes.filter((it) => it.fase !== 'fim');
  }

  // ─────────────────────────────── dados reais ───────────────────────────────
  function mapearFuncao(texto) {
    const t = norm(texto);
    let melhor = 'auxiliar', pos = Infinity;
    for (const f in CONFIG.palavras) {
      const m = CONFIG.palavras[f].exec(t);
      if (m && m.index < pos) { pos = m.index; melhor = f; }
    }
    return melhor;
  }

  const nomeSessao = (s) => s.apelido || s.nome || s.titulo || (s.projeto ? s.projeto : '') || String(s.id || '').slice(0, 8);

  function doStatusSessao(s) {
    const st = s.status;
    // Etapa 4: instância do Orbit dormindo (processo fechado) fica parada, com zZ; o status dos hooks não importa.
    const dormindo = !!(s.controle && s.controle.modo === 'orbit' && s.controle.processo === 'dormindo');
    const estado = dormindo ? 'ocioso' : st === 'trabalhando' || st === 'aguardando' || st === 'erro' ? st : 'ocioso';
    const bruto = estado !== 'ocioso' ? st : st === 'nova' ? 'nova' : 'concluido';
    return {
      estado, bruto, dormindo,
      tarefa: fmtFerramenta(s.ferramenta) || s.tarefa || s.titulo || '',
      espera: s.detalhe || T.precisa,
      motivo: s.detalhe || 'Falha na sessão',
      // Métricas do painel da TV. Sessão: tempo trabalhando acumulado + o trecho em curso.
      m: {
        ativoMs: (s.contadores && s.contadores.msTrabalhando) || 0, ativoDesde: st === 'trabalhando' ? ms(s.desde) : 0,
        desde: ms(s.desde), ferramentas: (s.contadores && s.contadores.ferramentas) || 0, atividade: ms(s.atividade),
        acoes: null, ctx: s.contexto && typeof s.contexto.pct === 'number' ? s.contexto.pct : null, texto: s.ultimaResposta || '',
      },
    };
  }

  function doStatusAgente(ag) {
    const st = ag.status;
    const estado = st === 'trabalhando' || st === 'aguardando' || st === 'erro' ? st : 'ocioso';
    const f = fmtFerramenta(ag.ferramenta);
    return {
      estado, bruto: st || 'concluido',
      tarefa: f || ag.descricao || ag.tipo || '',
      espera: f ? 'Aprovar ' + f : 'Pede aprovação',
      motivo: 'Falhou: ' + (ag.descricao || ag.tipo || 'subagente'),
      descricao: ag.descricao || '', tipo: ag.tipo || '',
      // Subagente: duração do início ao fim (ou até agora, se ainda roda).
      m: {
        ativoMs: ag.fim && ag.inicio ? Math.max(0, ms(ag.fim) - ms(ag.inicio)) : 0, ativoDesde: ag.fim ? 0 : ms(ag.inicio),
        desde: 0, ferramentas: Number(ag.ferramentas) || 0, atividade: ms(ag.atividade),
        acoes: Array.isArray(ag.acoes) ? ag.acoes : null, ctx: null, texto: ag.texto || '',
      },
    };
  }

  function temTime(s, lista) {
    if (!s || s.status === 'encerrada' || s.vivo === false) return false;
    return (Array.isArray(s.agentes) && s.agentes.length > 0) || lista.some((d) => d.pai === s.id && d.status !== 'encerrada');
  }
  const ativosDe = (s, lista) => (s.agentes || []).filter((a) => ATIVO[a.status]).length + lista.filter((d) => d.pai === s.id && ATIVO[d.status]).length;

  function escolherTime(lista) {
    const sel = api ? chamar(api.selecionada) : null;
    const sSel = sel ? lista.find((s) => s.id === sel) : null;
    if (sSel && temTime(sSel, lista)) return sSel;
    if (sSel && sSel.pai) {
      const mae = lista.find((s) => s.id === sSel.pai);
      if (temTime(mae, lista)) return mae;
    }
    const atual = lista.find((s) => s.id === timeId);
    if (atual && temTime(atual, lista) && ativosDe(atual, lista) > 0) return atual;
    const cand = lista.filter((s) => !s.pai && temTime(s, lista));
    cand.sort((a, b) => ativosDe(b, lista) - ativosDe(a, lista) || (b.atividade || 0) - (a.atividade || 0));
    if (atual && temTime(atual, lista) && (!cand.length || ativosDe(cand[0], lista) === 0)) return atual;
    return cand[0] || null;
  }

  function descreverTime(time, lista) {
    const ds = [{ chave: 'mestre:' + time.id, funcao: 'mestre', nome: CONFIG.funcoes.mestre.nome, origem: 'sessao', sessaoId: time.id, descricao: nomeSessao(time), ...doStatusSessao(time) }];
    for (const ag of time.agentes || []) {
      ds.push({ chave: 'ag:' + ag.id, funcao: mapearFuncao(`${ag.descricao || ''} ${ag.tipo || ''}`), origem: 'subagente', sessaoId: time.id, ...doStatusAgente(ag) });
    }
    for (const dep of lista) {
      if (dep.pai !== time.id) continue;
      const txt = `${dep.apelido || ''} ${dep.nome || ''} ${dep.titulo || ''} ${String(dep.primeira || dep.tarefa || '').slice(0, 240)}`;
      ds.push({ chave: 'dep:' + dep.id, funcao: mapearFuncao(txt), origem: 'dependente', sessaoId: dep.id, descricao: nomeSessao(dep), tipo: dep.nome || '', ...doStatusSessao(dep) });
    }
    return ds;
  }

  function sincronizar(gerar) {
    if (forcarDemo || !api || typeof api.sessoes !== 'function') { if (modo !== 'demo') entrarModo('demo'); return; }
    const lista = chamar(api.sessoes) || [];
    const time = escolherTime(lista);
    if (!time) { if (modo !== 'demo') entrarModo('demo'); return; }
    let inicial = false;
    if (modo !== 'real' || time.id !== timeId) { inicial = entrarModo('real', time); gerar = false; }
    aplicarTime(time, lista, gerar, inicial);
    timeNome = nomeSessao(time);
    marcarAtualizado();
  }
  let timeNome = '';

  function aplicarTime(time, lista, gerar, inicial) {
    const descs = descreverTime(time, lista);
    timeDescs = descs;
    // Ativos primeiro, para o limite de robôs não cortar quem está trabalhando.
    descs.sort((a, b) => (a.funcao === 'mestre' ? -1 : b.funcao === 'mestre' ? 1 : (ATIVO[b.bruto] ? 1 : 0) - (ATIVO[a.bruto] ? 1 : 0)));
    const vistos = new Set();
    for (const d of descs) {
      vistos.add(d.chave);
      let a = porChave.get(d.chave);
      if (!a) {
        if (atores.filter((x) => !x.saindo).length >= CONFIG.maxRobos) continue;
        a = criarAtor(d, inicial ? 'destino' : 'entrada');
        if (gerar && d.funcao !== 'mestre' && ATIVO[d.bruto]) {
          enfileirar('delegar', mestreAtor(), a, d.descricao || d.tarefa);
          if ((a.funcao === 'frontend' || a.funcao === 'backend') && ultimoTester && Date.now() - ultimoTester.t <= CONFIG.janelaFalhasMs) {
            const t = atorPorId(ultimoTester.id);
            if (t && !t.saindo) enfileirar('falhas', t, a, ultimoTester.desc);
          }
        }
      } else {
        const antes = a.bruto;
        atualizarAtor(a, d);
        if (gerar && a.funcao !== 'mestre' && ATIVO[antes] && d.bruto === 'concluido') {
          enfileirar('entregar', a, mestreAtor(), a.descricao || a.tarefa);
          if (a.funcao === 'tester') ultimoTester = { id: a.id, t: Date.now(), desc: a.descricao };
          if (a.funcao === 'pesquisador') {
            let alvos = atores.filter((x) => !x.saindo && (x.funcao === 'frontend' || x.funcao === 'backend') && x.estado !== 'ocioso');
            if (!alvos.length) alvos = atores.filter((x) => !x.saindo && x.funcao === 'frontend');
            for (const x of alvos.slice(0, 2)) enfileirar('referencias', a, x, a.descricao);
          }
        }
      }
    }
    for (const a of atores) if (!a.saindo && !vistos.has(a.chave)) sair(a);
  }

  // Troca de modo: quem estava sai pela entrada, o time novo entra por ela.
  function entrarModo(m, time) {
    const primeira = !jaPovoou;
    jaPovoou = true;
    for (const a of atores.slice()) sair(a);
    interacoes = [];
    modo = m;
    timeId = time ? time.id : null;
    timeNome = time ? nomeSessao(time) : '';
    timeDescs = [];
    ultimoTester = null;
    if (m === 'demo') {
      demoIniciar(primeira);
      proximoDemo = relogio + 2500;
      marcarAtualizado();
    }
    return primeira;
  }

  // ─────────────────────────────── demonstração ───────────────────────────────
  const listaDe = (tab, f) => tab[f] || tab.auxiliar;

  function demoIniciar(primeira) {
    const iniciais = { mestre: 'trabalhando', frontend: 'trabalhando', backend: 'trabalhando', tester: 'ocioso', pesquisador: 'trabalhando' };
    for (const def of CONFIG.agentesDemo) {
      const est = iniciais[def.funcao] || 'ocioso';
      criarAtor({
        chave: 'demo:' + def.id, funcao: def.funcao, nome: def.nome, origem: 'demo', estado: est, bruto: est,
        tarefa: est === 'ocioso' ? '' : sorteio(listaDe(CONFIG.tarefasDemo, def.funcao)),
        m: metricasIniciaisDemo(est),
      }, primeira ? 'destino' : 'entrada');
    }
  }

  // Métricas sorteadas do modo demonstração, no mesmo formato das reais (descrição `m`).
  function metricasIniciaisDemo(est) {
    const agora = Date.now();
    const n = Math.round(entre(4, 8));
    const acoes = [];
    for (let k = 0; k < n; k++) acoes.push({ fim: agora, erro: Math.random() < 0.08 });
    if (est === 'trabalhando') acoes.push({ fim: null });
    const ativoDesde = est === 'trabalhando' ? agora - Math.round(entre(40, 900)) * 1000 : 0;
    return {
      ativoMs: Math.round(entre(3, 28)) * 60e3, ativoDesde, desde: 0,
      ferramentas: Math.round(entre(6, 48)), atividade: agora - Math.round(entre(1, 40)) * 1000,
      acoes: acoes.slice(-8), ctx: null, texto: '',
    };
  }

  function metricasDemo(a, estado) {
    const m = a.m, agora = Date.now();
    const antes = a.estado;
    if (estado === 'trabalhando' && antes !== 'trabalhando') m.ativoDesde = agora;
    if (estado !== 'trabalhando' && m.ativoDesde) { m.ativoMs += agora - m.ativoDesde; m.ativoDesde = 0; }
    const acoes = (m.acoes || []).map((x) => (x.fim ? x : { ...x, fim: agora }));
    if (estado === 'trabalhando') {
      const n = Math.round(entre(1, 4));
      m.ferramentas += n;
      for (let k = 0; k < n - 1; k++) acoes.push({ fim: agora });
      acoes.push({ fim: null });
    } else if (estado === 'erro') { m.ferramentas++; acoes.push({ fim: agora, erro: true }); }
    m.acoes = acoes.slice(-8);
    m.atividade = agora;
  }

  function demoTick() {
    const m = mestreAtor();
    const time = atores.filter((a) => !a.saindo && a.funcao !== 'mestre');
    const ociosos = time.filter((a) => a.estado === 'ocioso' && livre(a));
    const trab = time.filter((a) => a.estado === 'trabalhando' && livre(a));
    const travados = time.filter((a) => a.estado === 'aguardando' || a.estado === 'erro');
    const fb = time.filter((a) => (a.funcao === 'frontend' || a.funcao === 'backend') && livre(a));
    const tester = time.find((a) => a.funcao === 'tester' && livre(a));
    const pesq = time.find((a) => a.funcao === 'pesquisador' && livre(a));
    const op = [];
    if (m && livre(m) && ociosos.length) op.push([3, () => {
      const a = sorteio(ociosos); const t = sorteio(listaDe(CONFIG.tarefasDemo, a.funcao));
      definir(a, 'trabalhando', t);
      enfileirar('delegar', m, a, t);
    }]);
    if (m && trab.length) op.push([2.4, () => {
      const a = sorteio(trab);
      enfileirar('entregar', a, m, a.tarefa, () => definir(a, 'ocioso', ''));
    }]);
    if (tester && fb.length) op.push([1.2, () => {
      const a = sorteio(fb); const f = sorteio(CONFIG.falhasDemo);
      enfileirar('falhas', tester, a, f, () => definir(a, 'trabalhando', 'Corrigindo: ' + f));
    }]);
    if (pesq && fb.length) op.push([1.2, () => enfileirar('referencias', pesq, sorteio(fb), sorteio(CONFIG.referenciasDemo))]);
    if (trab.length) op.push([1, () => { const a = sorteio(trab); definir(a, 'aguardando', a.tarefa, sorteio(listaDe(CONFIG.esperasDemo, a.funcao))); }]);
    if (trab.length) op.push([0.7, () => { const a = sorteio(trab); definir(a, 'erro', a.tarefa, sorteio(listaDe(CONFIG.errosDemo, a.funcao))); }]);
    if (travados.length) op.push([2.2, () => { const a = sorteio(travados); definir(a, 'trabalhando', sorteio(listaDe(CONFIG.tarefasDemo, a.funcao))); }]);
    if (trab.length) op.push([1.2, () => { const a = sorteio(trab); definir(a, 'trabalhando', sorteio(listaDe(CONFIG.tarefasDemo, a.funcao))); }]);
    if (m) op.push([0.8, () => {
      if (m.estado === 'aguardando') definir(m, 'trabalhando', sorteio(CONFIG.tarefasDemo.mestre));
      else definir(m, 'aguardando', m.tarefa, sorteio(CONFIG.esperasDemo.mestre));
    }]);
    if (!op.length) return;
    let soma = op.reduce((s, o) => s + o[0], 0), r = Math.random() * soma;
    for (const [p, fn] of op) { r -= p; if (r <= 0) { fn(); break; } }
    marcarAtualizado();
  }

  // ─────────────────────────────── uso do plano ───────────────────────────────
  function fmtRenova(ms) {
    if (!ms) return '';
    if (ms < 1e12) ms *= 1000;
    if (ms <= Date.now()) return 'renovando…';
    const d = new Date(ms), hoje = new Date();
    const hm = dois(d.getHours()) + ':' + dois(d.getMinutes());
    return d.toDateString() === hoje.toDateString() ? 'renova às ' + hm : 'renova ' + DIAS[d.getDay()] + ' ' + hm;
  }

  function gerarUsoDemo() {
    const agora = Date.now();
    const sem = new Date(agora + Math.round(entre(1, 6)) * 86400e3);
    sem.setMinutes(0, 0, 0);
    return {
      cincoHoras: { pct: Math.round(entre(18, 88)), renova: agora + Math.round(entre(25, 280)) * 60e3 },
      semanal: { pct: Math.round(entre(22, 84)), renova: sem.getTime() },
      atualizado: agora,
    };
  }

  // Cor de um percentual (0–1) na escala de CONFIG.uso: cor pura em cada ponto, mistura em OKLab entre eles.
  function corUso(p) {
    const e = CONFIG.uso.escala;
    if (p <= e[0][0]) return e[0][1];
    for (let k = 1; k < e.length; k++) {
      if (p <= e[k][0]) {
        const t = Math.round(((p - e[k - 1][0]) / (e[k][0] - e[k - 1][0])) * 100);
        return 'color-mix(in oklab, ' + e[k][1] + ' ' + t + '%, ' + e[k - 1][1] + ')';
      }
    }
    return e[e.length - 1][1];
  }
  // Degradê da escala de 0 até `ate`, esticado na largura da barra: começa no verde e termina na cor do seu %.
  function degradeUso(el, ate) {
    const a = Math.max(0.01, Math.min(1, ate));
    const paradas = CONFIG.uso.escala.filter(([p]) => p < a).map(([p, c]) => c + ' ' + Math.round((p / a) * 1000) / 10 + '%');
    paradas.push(corUso(a) + ' 100%');
    el.style.background = 'linear-gradient(to right, ' + paradas.join(', ') + ')';
    el.style.background = 'linear-gradient(to right in oklab, ' + paradas.join(', ') + ')';
  }

  function desenharUso() {
    if (!ui.uso) return;
    let u = api ? chamar(api.uso) : null;
    if (u && typeof u.then === 'function') { u.then((v) => { usoCache = v; desenharUso(); }, () => {}); u = usoCache; }
    if (!u) u = usoCache;
    const demo = !u;
    if (demo && !usoDemo) usoDemo = gerarUsoDemo();
    const dados = demo ? usoDemo : u;
    [dados.cincoHoras, dados.semanal].forEach((j, k) => {
      const it = ui.usoItens[k];
      const tem = j && typeof j.pct === 'number' && isFinite(j.pct);
      const pct = tem ? Math.max(0, Math.min(100, Math.round(j.pct))) : 0;
      it.pct.textContent = tem ? pct + '%' : '—';
      it.pct.style.color = tem ? corUso(pct / 100) : '';
      it.enc.style.width = (pct ? Math.max(2, pct) : 0) + '%';
      if (tem) degradeUso(it.enc, pct / 100);
      it.it.dataset.n = !tem ? 'vazio' : pct <= CONFIG.uso.verdeAte ? 'ok' : pct <= CONFIG.uso.ambarAte ? 'alto' : 'critico';
      it.barra.setAttribute('aria-valuenow', String(pct));
      it.ren.textContent = tem ? fmtRenova(j.renova) || '' : T.usoSemDados;
    });
    usoSimulado = demo;
    desenharSelo();
  }
  let usoCache = null, usoSimulado = false;

  // Um único indicador de demonstração, ao lado do título: a cena simulada tem prioridade;
  // com a cena ao vivo e o uso sorteado, ele diz só "Uso simulado".
  function desenharSelo() {
    if (!ui.selo) return;
    const cena = modo === 'demo';
    ui.selo.hidden = !cena && !usoSimulado;
    ui.selo.textContent = cena ? T.selo : T.seloUso;
    ui.selo.title = cena ? (usoSimulado ? T.seloDica.tudo : T.seloDica.cena) : T.seloDica.uso;
  }

  // ─────────────────────────────── seleção / cartão ───────────────────────────────
  function selecionar(idAtor) {
    selecionado = idAtor;
    cartaoAssin = '';
    for (const a of atores) if (a.dom) {
      a.dom.b.classList.toggle('of-sel', a.id === idAtor);
      a.dom.cr.classList.toggle('of-sel', a.id === idAtor);
    }
    cartao.hidden = !idAtor;
    atualizarCartao();
  }

  function atualizarCartao() {
    if (!selecionado) return;
    const a = atorPorId(selecionado);
    if (!a || a.saindo) { selecionar(null); return; }
    const f = CONFIG.funcoes[a.funcao] || CONFIG.funcoes.auxiliar;
    const c = celulaDe(a);
    const onde = areaDaCelula(c.x, c.y);
    const casa = a.estacao ? a.estacao.area : null;
    const areaTxt = (casa ? casa.nome : '—') + (onde && onde !== casa ? ' · agora em ' + onde.nome : !onde ? ' · no corredor' : '');
    const tarefa = a.estado === 'aguardando' ? a.espera : a.estado === 'erro' ? a.motivo : a.tarefa;
    let origem = T.origens[a.origem] || '';
    if (a.origem === 'subagente' && a.tipo) origem += ' · ' + a.tipo;
    if ((a.origem === 'sessao' || a.origem === 'dependente') && a.descricao) origem += ' · ' + a.descricao;
    const assin = [a.nome, a.funcao, areaTxt, a.estado, tarefa, origem, a.descricao, a.dormindo ? 1 : 0].join('|');
    if (assin === cartaoAssin) return;
    cartaoAssin = assin;
    ui.cNome.textContent = a.nome;
    ui.cPapel.textContent = f.papel;
    ui.cFuncao.textContent = f.nome;
    ui.cArea.textContent = areaTxt;
    ui.cEstado.textContent = a.dormindo ? 'Dormindo' : T.estados[a.estado] || a.estado;
    ui.cEstado.dataset.e = a.estado;
    const desc = a.origem === 'subagente' && a.descricao && a.descricao !== tarefa ? ' — ' + a.descricao : '';
    ui.cTarefa.textContent = cortar((tarefa || (a.estado === 'ocioso' ? 'Descansando' : '—')) + desc, 160);
    ui.cOrigem.textContent = cortar(origem, 80);
    ui.cAbrir.hidden = !(a.sessaoId && api && (typeof api.abrirSessao === 'function' || typeof api.abrirVSCode === 'function'));
  }

  // ─────────────────────────────── painel da TV ───────────────────────────────
  // A TV da sala do Mestre abre um painel com as métricas de cada agente que ele gerencia. O painel
  // nasce da própria TV (transform-origin no centro dela) e fecha com clique fora, no × ou com Esc.
  const por = (el, v) => { if (el.textContent !== v) el.textContent = v; };
  let tvUlt = 0;

  function retanguloTV() {
    const a = CONFIG.areas.find((x) => x.id === CONFIG.tv.area);
    const m = a && (a.moveis || []).find((x) => x.tipo === CONFIG.tv.tipo);
    return m ? { x: m.x, y: m.y, w: m.w || 1, h: m.h || 1 } : { x: 24, y: 1, w: 6, h: 2 };
  }

  function construirTV() {
    const P = T.painel;
    tvPop = h('section', 'of-tv-pop', raiz);
    tvPop.hidden = true;
    tvPop.tabIndex = -1;
    tvPop.setAttribute('role', 'dialog');
    tvPop.setAttribute('aria-label', P.titulo);
    h('i', 'of-tp-seta', tvPop);
    const cab = h('div', 'of-tp-cab', tvPop);
    const tit = h('div', 'of-tp-tit', cab);
    h('b', '', tit, P.titulo);
    ui.tpSub = h('small', '', tit, '');
    ui.tpModo = h('span', 'of-tp-modo', cab, '');
    const fechar = h('button', 'of-c-fechar', cab);
    fechar.type = 'button';
    fechar.setAttribute('aria-label', P.fechar);
    fechar.appendChild(icone(['M18 6 6 18', 'M6 6l12 12']));
    fechar.addEventListener('click', () => fecharTV());
    const res = h('div', 'of-tp-resumo', tvPop);
    ui.tpResumo = ['trabalhando', 'aguardando', 'erro', 'ocioso'].map((e, k) => {
      const it = h('div', 'of-tp-res', res);
      it.dataset.e = e;
      return { it, n: h('b', 'of-num', it, '0'), r: h('span', '', it, P.resumo[k]) };
    });
    ui.tpLista = h('ul', 'of-tp-lista', tvPop);
    ui.tpVazio = h('p', 'of-tp-vazio', tvPop, P.vazio);
    ui.tpVazio.hidden = true;
  }

  // Agentes do time, sem o Mestre. Ao vivo: todas as descrições do time (inclusive as que passaram do
  // limite de robôs); na demonstração: os robôs. Quem pede atenção vem primeiro; a ordem é estável.
  function linhasDoTime() {
    let fonte;
    if (modo === 'real' && timeDescs.length) {
      fonte = timeDescs.filter((d) => d.funcao !== 'mestre').map((d) => {
        const a = porChave.get(d.chave);
        return { ...d, nome: a ? a.nome : (CONFIG.funcoes[d.funcao] || CONFIG.funcoes.auxiliar).nome, desde: (d.m && d.m.desde) || (a && a.desde) || 0 };
      });
    } else fonte = atores.filter((a) => !a.saindo && a.funcao !== 'mestre');
    const ordem = { aguardando: 0, erro: 1, trabalhando: 2 };
    return fonte.map((x, i) => ({
      i, chave: x.chave, nome: x.nome, funcao: x.funcao, estado: x.estado, bruto: x.bruto, origem: x.origem,
      tarefa: x.tarefa, espera: x.espera, motivo: x.motivo, descricao: x.descricao, desde: x.desde, m: x.m || {},
    })).sort((p, q) => (ordem[p.estado] ?? 3) - (ordem[q.estado] ?? 3) || p.i - q.i);
  }

  function textoAgora(x) {
    if (x.estado === 'aguardando') return x.espera || T.precisa;
    if (x.estado === 'erro') return x.motivo || T.erro;
    if (x.estado === 'trabalhando') return x.tarefa || T.estados.trabalhando;
    if (x.origem === 'demo') return 'Descansando';
    return x.m.texto || (x.bruto === 'concluido' ? 'Tarefa entregue' : 'Sem tarefa no momento');
  }

  function criarLinhaTV(i) {
    const li = h('li', 'of-tp-ag of-tp-novo');
    li.style.setProperty('--i', String(Math.min(i, 10)));
    li.addEventListener('animationend', (ev) => { if (ev.target === li) li.classList.remove('of-tp-novo'); });
    const l1 = h('div', 'of-tp-l1', li);
    const r = { li, cor: h('i', 'of-tp-cor', l1), nome: h('b', 'of-tp-nome', l1, ''), desc: h('small', 'of-tp-desc', l1, ''), est: h('span', 'of-pilula', l1, '') };
    r.agora = h('p', 'of-tp-agora', li, '');
    const l3 = h('div', 'of-tp-l3', li);
    const met = (rot) => {
      const s = h('span', 'of-tp-met', l3), b = h('b', 'of-num', s, '');
      s.appendChild(document.createTextNode(' '));
      return { s, b, rot: h('span', '', s, rot) };
    };
    r.tempo = met('ativo'); r.ferr = met('ferramentas'); r.falhas = met('falhas'); r.ctx = met('contexto');
    r.falhas.s.classList.add('of-tp-falha');
    r.ctx.s.classList.add('of-tp-ctx');
    h('span', 'of-espaco', l3);
    r.ha = h('span', 'of-tp-ha of-num', l3, '');
    r.acoes = h('span', 'of-tp-acoes', l3);
    r.acoes.setAttribute('aria-hidden', 'true');
    r.qs = [];
    for (let k = 0; k < 8; k++) r.qs.push(h('i', '', r.acoes));
    // Clique na linha: fecha o painel e mostra o robô no mapa (abre o cartão dele).
    li.addEventListener('click', () => {
      const a = porChave.get(li.dataset.chave);
      if (a && !a.saindo) { fecharTV(); selecionar(a.id); }
    });
    return r;
  }

  function preencherLinhaTV(r, x) {
    const P = T.painel, f = CONFIG.funcoes[x.funcao] || CONFIG.funcoes.auxiliar, m = x.m, agora = Date.now();
    const concl = x.estado === 'ocioso' && x.bruto === 'concluido' && x.origem !== 'demo';
    const e = concl ? 'concluido' : x.estado;
    if (r.li.dataset.e !== e) r.li.dataset.e = e;
    r.li.dataset.chave = x.chave;
    const a = porChave.get(x.chave);
    r.li.classList.toggle('of-tp-link', !!(a && !a.saindo));
    r.cor.style.setProperty('--cor', f.cor);
    por(r.nome, x.nome);
    por(r.desc, cortar(x.descricao && x.descricao !== x.nome ? x.descricao : f.papel, 80));
    por(r.est, concl ? P.concluido : T.estados[x.estado] || x.estado);
    if (r.est.dataset.e !== e) r.est.dataset.e = e;
    por(r.agora, cortar(textoAgora(x), 140));
    const ativo = (m.ativoMs || 0) + (m.ativoDesde ? Math.max(0, agora - m.ativoDesde) : 0);
    por(r.tempo.b, ativo ? fmtDur(ativo) : '—');
    por(r.ferr.b, String(m.ferramentas || 0));
    const acoes = Array.isArray(m.acoes) ? m.acoes.slice(-8) : null;
    const nf = acoes ? acoes.filter((q) => q.erro).length : 0;
    r.falhas.s.hidden = !nf;
    por(r.falhas.b, String(nf));
    por(r.falhas.rot, nf === 1 ? 'falha' : 'falhas');
    r.ctx.s.hidden = m.ctx == null;
    if (m.ctx != null) por(r.ctx.b, Math.round(m.ctx) + '%');
    const parado = (x.estado === 'aguardando' || x.estado === 'erro') && x.desde;
    por(r.ha, parado ? 'parado ' + fmtHa(x.desde) : fmtHa(m.atividade));
    // Últimas 8 ações (subagentes e demonstração): concluída, com falha ou em curso.
    r.acoes.hidden = !acoes;
    if (acoes) r.qs.forEach((q, k) => {
      const it = acoes[k - (8 - acoes.length)];
      const s = !it ? 'vazio' : it.erro ? 'erro' : it.fim ? 'ok' : 'aberta';
      if (q.dataset.s !== s) q.dataset.s = s;
    });
  }

  function atualizarTV(forcar) {
    if (!tvAberta || !tvPop) return;
    const t = performance.now();
    if (!forcar && t - tvUlt < 300) return;
    tvUlt = t;
    const P = T.painel;
    const lista = linhasDoTime();
    const cont = { trabalhando: 0, aguardando: 0, erro: 0, ocioso: 0 };
    for (const x of lista) cont[x.estado in cont ? x.estado : 'ocioso']++;
    ui.tpResumo.forEach((r, k) => {
      const n = cont[r.it.dataset.e];
      por(r.n, String(n));
      r.it.classList.toggle('of-zero', !n);
      if (k === 3) por(r.r, modo === 'demo' ? P.resumoDemo : P.resumo[3]);
    });
    por(ui.tpSub, (modo === 'demo' ? 'Time de exemplo' : 'Time de ' + (timeNome || 'sessão')) + ' · ' + lista.length + (lista.length === 1 ? ' agente' : ' agentes'));
    const mm = modo === 'demo' ? 'demo' : conexaoOk ? 'vivo' : 'caiu';
    por(ui.tpModo, mm === 'demo' ? P.demo : mm === 'vivo' ? P.vivo : 'Reconectando…');
    ui.tpModo.dataset.m = mm;
    ui.tpVazio.hidden = lista.length > 0;
    const vistos = new Set();
    let anterior = null;
    lista.forEach((x, i) => {
      vistos.add(x.chave);
      let r = tvLinhas.get(x.chave);
      if (!r) { r = criarLinhaTV(i); tvLinhas.set(x.chave, r); }
      preencherLinhaTV(r, x);
      const lugar = anterior ? anterior.nextSibling : ui.tpLista.firstChild;
      if (lugar !== r.li) ui.tpLista.insertBefore(r.li, lugar); // só move quem mudou de lugar
      anterior = r.li;
    });
    for (const [k, r] of tvLinhas) if (!vistos.has(k)) { r.li.remove(); tvLinhas.delete(k); }
  }

  // Embaixo da TV, centrado nela (dentro dos limites da aba); sem espaço, sobe e perde a seta.
  function posicionarTV() {
    if (!tvPop || !raiz) return;
    const W = raiz.clientWidth, H = raiz.clientHeight, tv = retanguloTV();
    const cx = palcoX + (tv.x + tv.w / 2) * cel, cy = palcoY + (tv.y + tv.h / 2) * cel, baseTv = palcoY + (tv.y + tv.h) * cel;
    const pw = Math.min(460, W - 24);
    const left = Math.round(Math.max(12, Math.min(W - pw - 12, cx - pw / 2)));
    const chao = H - (rodape ? rodape.offsetHeight : 0) - 12;
    let top = Math.round(baseTv + 10);
    if (chao - top < 280) top = Math.max(12, Math.round(chao - Math.min(560, chao - 12)));
    tvPop.style.width = pw + 'px';
    tvPop.style.left = left + 'px';
    tvPop.style.top = top + 'px';
    tvPop.style.maxHeight = Math.max(160, chao - top) + 'px';
    const ox = Math.round(cx - left), oy = Math.round(cy - top);
    tvPop.style.transformOrigin = ox + 'px ' + oy + 'px';
    tvPop.style.setProperty('--tp-cx', Math.max(18, Math.min(pw - 18, ox)) + 'px');
    tvPop.classList.toggle('of-tp-sem-seta', top < baseTv);
  }

  function animarTV(abrir) {
    if (!tvPop.animate) return null;
    const ida = reduzido ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ opacity: 0, transform: 'scale(.16)' }, { opacity: 1, offset: 0.4 }, { opacity: 1, transform: 'none' }];
    const volta = reduzido ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.16)' }];
    return tvPop.animate(abrir ? ida : volta, abrir
      ? { duration: reduzido ? 120 : 380, easing: 'cubic-bezier(.23, 1, .32, 1)' }
      : { duration: reduzido ? 100 : 190, easing: 'cubic-bezier(.4, 0, 1, 1)' });
  }

  function abrirTV() {
    if (!tvPop || tvAberta) return;
    selecionar(null);
    tvAberta = true;
    if (tvAnim) { tvAnim.cancel(); tvAnim = null; }
    for (const r of tvLinhas.values()) r.li.remove();
    tvLinhas.clear();
    tvPop.hidden = false;
    ui.tv.classList.add('of-tv-on');
    ui.tv.setAttribute('aria-expanded', 'true');
    atualizarTV(true);
    posicionarTV();
    tvAnim = animarTV(true);
    chamar(() => tvPop.focus({ preventScroll: true }));
  }

  function fecharTV(animar = true) {
    if (!tvAberta || !tvPop) return;
    tvAberta = false;
    ui.tv.classList.remove('of-tv-on');
    ui.tv.setAttribute('aria-expanded', 'false');
    const devolver = tvPop.contains(document.activeElement);
    if (tvAnim) tvAnim.cancel();
    const fim = () => { tvAnim = null; if (!tvAberta && tvPop) tvPop.hidden = true; };
    tvAnim = animar ? animarTV(false) : null;
    // O timer garante o fechamento se o onfinish não vier (aba oculta, animações congeladas).
    if (tvAnim) { tvAnim.onfinish = fim; setTimeout(() => { if (!tvAberta) { if (tvAnim) tvAnim.cancel(); fim(); } }, 400); } else fim();
    if (devolver) chamar(() => ui.tv.focus({ preventScroll: true }));
  }

  function aoApontar(ev) {
    if (!tvAberta || !tvPop) return;
    const t = ev.target;
    if (tvPop.contains(t) || (ui.tv && ui.tv.contains(t))) return;
    fecharTV();
  }

  // ─────────────────────────────── tela cheia ───────────────────────────────
  // querCheia guarda a intenção: a API nativa pode demorar ou falhar; sem ela em 450 ms,
  // vale o modo por CSS (fixed inset 0). Uma concessão nativa que chega depois de desligar é desfeita.
  let querCheia = false, pedidoFs = 0, ultimoFs = null;
  function emTelaCheia() { return document.fullscreenElement === raiz || (raiz && raiz.classList.contains('of-cheia')); }
  function alternarTelaCheia() {
    if (!raiz) return;
    const meu = ++pedidoFs;
    if (querCheia || emTelaCheia()) {
      querCheia = false;
      if (document.fullscreenElement) chamar(() => document.exitFullscreen().catch(() => {}));
      raiz.classList.remove('of-cheia');
    } else {
      querCheia = true;
      const cair = () => { if (meu === pedidoFs && querCheia && raiz && document.fullscreenElement !== raiz) { raiz.classList.add('of-cheia'); aposTelaCheia(); } };
      if (raiz.requestFullscreen && document.fullscreenEnabled !== false) {
        try { const p = raiz.requestFullscreen(); if (p && p.catch) p.catch(cair); } catch (e) { cair(); }
        setTimeout(cair, 450);
      } else cair();
    }
    aposTelaCheia();
  }
  function aposTelaCheia() {
    if (!raiz) return;
    const fs = document.fullscreenElement;
    if (fs === raiz && !querCheia) chamar(() => document.exitFullscreen().catch(() => {}));
    if (fs === raiz) raiz.classList.remove('of-cheia');
    // Saiu da nativa pela tecla Esc do navegador: a intenção acompanha.
    if (ultimoFs === raiz && !fs && !raiz.classList.contains('of-cheia')) querCheia = false;
    ultimoFs = fs;
    const on = emTelaCheia();
    ui.btnCheia.setAttribute('aria-pressed', String(on));
    ui.btnCheiaTxt.textContent = on ? T.sairTelaCheia : T.telaCheia;
    ui.btnCheia.setAttribute('aria-label', on ? T.sairTelaCheia + ' da tela cheia' : T.telaCheia);
    requestAnimationFrame(layout);
  }

  function visivel() { return raiz && raiz.isConnected && raiz.getClientRects().length > 0 && !pausado; }

  function aoTeclar(ev) {
    if (!visivel() || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const alvo = ev.target;
    if (alvo && (alvo.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(alvo.tagName))) return;
    if (ev.key === 'f' || ev.key === 'F') {
      if (ev.repeat) return;
      ev.preventDefault(); ev.stopPropagation();
      alternarTelaCheia();
    } else if (ev.key === 'Escape' && tvAberta) {
      ev.preventDefault(); ev.stopPropagation();
      fecharTV();
    } else if (ev.key === 'Escape' && selecionado) {
      ev.preventDefault(); ev.stopPropagation();
      selecionar(null);
    }
  }

  // ─────────────────────────────── desenho por quadro ───────────────────────────────
  function marcarAtualizado() { atualizadoEm = new Date(); rodapeAssin = ''; }

  function balaoDe(a) {
    if (a.saindo) return null;
    const conv = a.visita && a.visita.fase === 'conversa' ? a.visita : a.hospeda.find((it) => it.fase === 'conversa');
    if (conv) {
      // Quem chegou abre a conversa: selo do tipo + "→ destinatário" + texto ("Falhas para corrigir: x"
      // vira selo "Falhas" + "x"). Quem recebe "digita" um instante e responde só com a fala curta.
      const abre = conv.v === a;
      const outro = abre ? conv.h : conv.v;
      const base = { k: 'troca', t: conv.tipo, tit: '', txt: '', para: '', paraCor: '' };
      if (!abre) {
        if (relogio - conv.t0 < CONFIG.respostaMs) return { ...base, digita: true };
        return { ...base, txt: conv.th };
      }
      const m = /^([^:]{3,22}): (.+)$/.exec(conv.tv);
      const f = CONFIG.funcoes[outro.funcao] || CONFIG.funcoes.auxiliar;
      return { ...base, tit: T.tiposTroca[conv.tipo] || (m ? m[1] : ''), txt: m ? m[2] : conv.tv, para: outro.nome, paraCor: f.cor };
    }
    if (!naEstacao(a)) return null;
    if (a.estado === 'trabalhando') return { k: 'trabalho', tit: '', txt: cortar(a.tarefa || T.estados.trabalhando) };
    if (a.estado === 'aguardando') return { k: 'espera', tit: T.precisa, txt: cortar(a.espera) };
    if (a.estado === 'erro') return { k: 'erro', tit: T.erro, txt: cortar(a.motivo) };
    return null;
  }

  // Numa conversa, de que lado está o parceiro (-1 esquerda, 1 direita, 0 alinhado): o balão e o crachá
  // abrem para o lado de fora, como nos quadrinhos, e a ponta fica junto de quem fala.
  function ladoDaConversa(a) {
    if (a.saindo) return 0;
    const conv = a.visita && a.visita.fase === 'conversa' ? a.visita : a.hospeda.find((it) => it.fase === 'conversa');
    if (!conv) return 0;
    const outro = conv.v === a ? conv.h : conv.v;
    return Math.abs(outro.x - a.x) < 0.3 ? 0 : outro.x > a.x ? 1 : -1;
  }

  function preencherBalao(a, b, jaAberto) {
    const d = a.dom;
    d.bal.dataset.k = b.k;
    if (b.t) d.bal.dataset.t = b.t; else delete d.bal.dataset.t;
    d.tit.textContent = b.tit;
    d.tit.hidden = !b.tit;
    d.paraNome.textContent = b.para;
    d.paraNome.style.setProperty('--pc', b.paraCor || '');
    d.para.hidden = !b.para;
    d.cab.hidden = !b.tit && !b.para;
    d.txt.textContent = '';
    if (b.digita) {
      d.txt.className = 'of-b-txt of-b-dig';
      for (let k = 0; k < 3; k++) h('i', '', d.txt);
    } else {
      // Palavra por palavra (só textContent), para o texto entrar em cascata; os espaços continuam quebrando a linha.
      d.txt.className = 'of-b-txt';
      b.txt.split(' ').forEach((p, i) => {
        if (i) d.txt.appendChild(document.createTextNode(' '));
        h('span', 'of-pl', d.txt, p).style.setProperty('--i', String(Math.min(i, 14)));
      });
    }
    if (jaAberto) {
      d.bal.classList.remove('of-muda');
      void d.bal.offsetWidth; // reinicia a animação
      d.bal.classList.add('of-muda');
    }
  }

  function bate(x, y, w, hh, caixas) {
    for (const c of caixas) if (x < c.x + c.w + 3 && x + w + 3 > c.x && y < c.y + c.h + 3 && y + hh + 3 > c.y) return true;
    return false;
  }
  // Subida exibida: o alvo sobe na hora; para baixo, desce aos poucos se a posição intermediária estiver livre.
  // `s` é o sentido do afastamento: -1 sobe (balão), +1 desce (crachá).
  function suavizar(atual, alvo, x, y0, w, hh, caixas, s = -1) {
    if (alvo >= atual - 0.6) return alvo;
    const meio = atual + (alvo - atual) * 0.35;
    return bate(x, y0 + s * meio, w, hh, caixas) ? alvo : meio;
  }
  function evitar(x, y, w, hh, caixas) {
    for (let k = 0; k < 14; k++) {
      let bate = null;
      for (const c of caixas) {
        if (x < c.x + c.w + 3 && x + w + 3 > c.x && y < c.y + c.h + 3 && y + hh + 3 > c.y) { bate = c; break; }
      }
      if (!bate) break;
      y = bate.y - hh - 4;
    }
    return y;
  }
  function evitarAbaixo(x, y, w, hh, caixas) {
    for (let k = 0; k < 14; k++) {
      const c = caixas.find((c) => x < c.x + c.w + 3 && x + w + 3 > c.x && y < c.y + c.h + 3 && y + hh + 3 > c.y);
      if (!c) break;
      y = c.y + c.h + 4;
    }
    return y;
  }
  // Aproxima o deslocamento lateral do alvo sem saltar (o rótulo desliza quando a conversa começa).
  function aproximar(atual, alvo) {
    if (reduzido || !dtQuadro) return alvo;
    const v = atual + (alvo - atual) * (1 - Math.exp(-dtQuadro * 12));
    return Math.abs(alvo - v) < 0.4 ? alvo : v;
  }

  function desenhar() {
    const vivos = atores.filter((a) => a.dom);
    // 1) leituras (medidas só quando o texto muda)
    for (const a of vivos) {
      const b = balaoDe(a);
      a.lado = ladoDaConversa(a);
      const assin = b ? [b.k, b.t, b.tit, b.txt, b.para, b.digita ? 1 : 0].join('|') : '';
      if (assin !== a.balaoAssin) {
        const jaAberto = !!a.balao;
        a.balaoAssin = assin;
        a.balao = b;
        if (b) {
          preencherBalao(a, b, jaAberto);
          a.medirBalao = true;
          a.liftB = 0;
          if (!jaAberto) a.encaixarB = true; // abre já no lugar, sem deslizar
        }
        a.dom.bal.classList.toggle('of-vis', !!b);
      }
    }
    for (const a of vivos) {
      if (a.medirCracha || !a.wc) { a.wc = a.dom.cr.offsetWidth; a.hc = a.dom.cr.offsetHeight; a.medirCracha = !a.wc; }
      if (a.balao && (a.medirBalao || !a.wb)) { a.wb = a.dom.bal.offsetWidth; a.hb = a.dom.bal.offsetHeight; a.medirBalao = !a.wb; }
    }
    // 2) robôs
    for (const a of vivos) {
      const px = a.x * cel, pes = a.y * cel + 0.32 * cel;
      const tx = Math.round(px - S / 2), ty = Math.round(pes - S);
      const u = a.ult;
      if (u.tx !== tx || u.ty !== ty) { a.dom.b.style.transform = `translate3d(${tx}px,${ty}px,0)`; u.tx = tx; u.ty = ty; }
      if (u.vir !== a.virado) { a.dom.run.style.transform = a.dom.idle.style.transform = a.virado ? 'scaleX(-1)' : ''; u.vir = a.virado; }
      const dz = !!a.dormindo && !a.andando; // etapa 4: instância do Orbit dormindo → pose parada com zZ
      if (u.and !== a.andando || u.dz !== dz) { a.dom.run.hidden = !a.andando; a.dom.idle.hidden = a.andando || dz; a.dom.zz.hidden = !dz; u.and = a.andando; u.dz = dz; }
      const z = Math.round(a.y * 10);
      if (a.z !== z) { a.dom.b.style.zIndex = String(z); a.z = z; }
      if (u.e !== a.estado) { a.dom.cr.dataset.e = a.estado; a.dom.b.dataset.e = a.estado; a.dom.b.setAttribute('aria-label', a.nome + ' · ' + (T.estados[a.estado] || a.estado)); u.e = a.estado; }
    }
    // 3) crachás embaixo dos pés, sem sobreposição: de cima para baixo, quem colide desce.
    const ordem = vivos.slice().sort((a, b) => b.y - a.y || (a.id < b.id ? -1 : 1));
    const caixas = [];
    rotulosDebug = [];
    for (const a of ordem.slice().reverse()) {
      if (!a.wc) continue;
      const px = a.x * cel, pes = a.y * cel + 0.32 * cel;
      // Conversa: o crachá abre para fora (fica a 14 px do centro do robô, do lado de fora da dupla).
      a.offC = aproximar(a.offC, a.lado ? -a.lado * (a.wc / 2 - 14) : 0);
      const x = Math.max(2, Math.min(palcoW - a.wc - 2, px - a.wc / 2 + a.offC));
      const y0 = Math.min(palcoH - a.hc - 2, pes + 2);
      const y = Math.min(palcoH - a.hc - 2, evitarAbaixo(x, y0, a.wc, a.hc, caixas));
      a.liftC = suavizar(a.liftC, y - y0, x, y0, a.wc, a.hc, caixas, 1);
      const yf = y0 + a.liftC;
      caixas.push({ x, y: yf, w: a.wc, h: a.hc });
      a.yc = yf;
      const u = a.ult;
      const rx = Math.round(x), ry = Math.round(yf);
      if (u.cx !== rx || u.cy !== ry) { a.dom.cr.style.transform = `translate3d(${rx}px,${ry}px,0)`; u.cx = rx; u.cy = ry; }
      const hs = Math.round(4 + a.liftC);
      if (u.chs !== hs) { a.dom.cr.style.setProperty('--hs', hs + 'px'); a.dom.cr.classList.toggle('of-haste-on', hs > 7); u.chs = hs; }
      rotulosDebug.push({ tipo: 'cracha', id: a.id, x, y: yf, w: a.wc, h: a.hc });
    }
    // Balão: 12 px acima da cabeça (a ponta em degraus ocupa 10). Numa conversa ele abre para fora, com a
    // ponta a 13 px da borda de dentro. Sem espaço em cima (borda do palco), desce para baixo dos pés.
    // A resposta (curta) se acomoda primeiro; se faltar espaço, quem abriu a conversa sobe: a leitura fica de
    // cima para baixo e o fio dele desce pelo lado de fora da dupla, sem cruzar o outro balão.
    const resp = (a) => (a.balao && a.balao.k === 'troca' && !a.balao.para ? 0 : 1);
    for (const a of ordem.slice().sort((p, q) => resp(p) - resp(q))) {
      if (!a.balao || !a.wb || a.yc == null) continue;
      const px = a.x * cel;
      const alvoOff = a.lado ? -a.lado * (a.wb / 2 - 13) : 0;
      a.offB = a.encaixarB ? alvoOff : aproximar(a.offB, alvoOff);
      a.encaixarB = false;
      const x = Math.max(2, Math.min(palcoW - a.wb - 2, px - a.wb / 2 + a.offB));
      const y0 = a.y * cel + 0.32 * cel - S * 0.9 - 12 - a.hb;
      let yf, baixo = false;
      const y = evitar(x, y0, a.wb, a.hb, caixas);
      if (y < limTopo) {
        // Embaixo só vale colado aos pés; se for empurrado para longe, fica em cima (no máximo até a borda da tela).
        const yp = a.yc + a.hc + 12; // abaixo do crachá
        const yb = evitarAbaixo(x, yp, a.wb, a.hb, caixas);
        if (yb - yp < 6 && yb + a.hb <= palcoH - 2) { baixo = true; yf = yb; a.liftB = 0; }
        else { yf = Math.max(y, limBorda); a.liftB = y0 - yf; }
      } else {
        a.liftB = suavizar(a.liftB, y0 - y, x, y0, a.wb, a.hb, caixas);
        yf = y0 - a.liftB;
      }
      caixas.push({ x, y: yf, w: a.wb, h: a.hb });
      const u = a.ult;
      const rx = Math.round(x), ry = Math.round(yf);
      if (u.bx !== rx || u.by !== ry) { a.dom.bal.style.transform = `translate3d(${rx}px,${ry}px,0)`; u.bx = rx; u.by = ry; }
      const cx = Math.round(Math.max(14, Math.min(a.wb - 14, px - x)));
      const hs = Math.round(12 + a.liftB);
      const longe = !baixo && a.liftB > 6;
      const zb = longe ? '1' : '2';
      if (u.bz !== zb) { a.dom.bal.style.zIndex = zb; a.dom.bal.classList.toggle('of-longe', longe); u.bz = zb; }
      if (u.bb !== baixo) { a.dom.bal.classList.toggle('of-baixo', baixo); u.bb = baixo; }
      if (u.bcx !== cx || u.bhs !== hs) { a.dom.bal.style.setProperty('--cx', cx + 'px'); a.dom.bal.style.setProperty('--hs', hs + 'px'); u.bcx = cx; u.bhs = hs; }
      rotulosDebug.push({ tipo: 'balao', id: a.id, x, y: yf, w: a.wb, h: a.hb, texto: a.balao.txt });
    }
    // Placa de sala coberta por crachá ou balão esmaece (o rótulo do robô tem a vez).
    for (const p of placas) {
      const sob = caixas.some((c) => c.x < p.x + p.w && c.x + c.w > p.x && c.y < p.y + p.h && c.y + c.h > p.y);
      if (sob !== p.sob) { p.el.classList.toggle('of-sob', sob); p.sob = sob; }
    }
    // 4) telas das estações
    for (const e of estacoes) {
      const a = e.ator;
      let st = 'apagada';
      if (a && !a.saindo) {
        if (a.estado === 'erro') st = 'erro';
        else if (naEstacao(a)) st = a.estado === 'trabalhando' ? 'ativa' : a.estado === 'aguardando' ? 'espera' : 'apagada';
      }
      if (e.e !== st) { e.e = st; e.tela.setAttribute('data-e', st); }
    }
    // 5) cartão, cabeçalho e rodapé
    if (selecionado) atualizarCartao();
    if (tvAberta) atualizarTV();
    desenharCabecalho();
    desenharRodape();
  }

  function desenharCabecalho() {
    const n = atores.filter((a) => !a.saindo).length;
    const assin = modo + '|' + timeNome + '|' + n;
    if (assin === cabAssin) return;
    cabAssin = assin;
    desenharSelo();
    ui.sub.textContent = modo === 'demo' ? T.subDemo : 'Time de ' + (timeNome || 'sessão') + ' · ' + n + (n === 1 ? ' agente' : ' agentes');
    raiz.classList.toggle('of-modo-demo', modo === 'demo');
  }

  function desenharRodape() {
    const cont = { trabalhando: 0, aguardando: 0, erro: 0, ocioso: 0 };
    for (const a of atores) if (!a.saindo) cont[a.estado] = (cont[a.estado] || 0) + 1;
    const hora = atualizadoEm ? horaCompleta(atualizadoEm) : '—';
    const assin = [modo, conexaoOk, cont.trabalhando, cont.aguardando, cont.erro, cont.ocioso, hora, timeNome].join('|');
    if (assin === rodapeAssin) return;
    rodapeAssin = assin;
    ui.modo.textContent = modo === 'demo' ? 'Demonstração' : conexaoOk ? 'Ao vivo' + (timeNome ? ' · ' + timeNome : '') : 'Reconectando…';
    ui.modoPonto.dataset.m = modo === 'demo' ? 'demo' : conexaoOk ? 'vivo' : 'caiu';
    const partes = [];
    if (cont.trabalhando) partes.push(cont.trabalhando + ' trabalhando');
    if (cont.aguardando) partes.push(cont.aguardando + ' aguardando');
    if (cont.erro) partes.push(cont.erro + (cont.erro === 1 ? ' com erro' : ' com erro'));
    if (cont.ocioso) partes.push(cont.ocioso + (cont.ocioso === 1 ? ' ocioso' : ' ociosos'));
    ui.contagem.textContent = partes.join(' · ');
    ui.atualizado.textContent = 'Atualizado às ' + hora;
  }

  // ─────────────────────────────── laço ───────────────────────────────
  function quadro(t) {
    raf = 0;
    if (pausado || oculto || !raiz) return;
    const dt = Math.min(0.1, Math.max(0, (t - ultimoT) / 1000));
    ultimoT = t;
    relogio += dt * 1000;
    dtQuadro = dt;
    if (sujo) { sujo = false; sincronizar(!pausadoEm || Date.now() - pausadoEm < 60000); pausadoEm = 0; }
    if (modo === 'demo' && relogio >= proximoDemo) {
      demoTick();
      proximoDemo = relogio + entre(CONFIG.demoIntervaloMs[0], CONFIG.demoIntervaloMs[1]);
    }
    processarInteracoes();
    for (const a of atores) {
      const d = destino(a);
      if (d) irPara(a, d);
      mover(a, dt);
      // Na estação, de frente para o monitor (à direita), salvo durante uma conversa.
      if (!a.andando && !a.visita && !a.hospeda.some((it) => it.fase === 'conversa') && naEstacao(a)) a.virado = false;
      if (!a.saindo && a.estado === 'ocioso' && !a.visita && !a.hospeda.length && a.descanso && !a.descansoAte && chegou(a, a.descanso)) {
        a.descansoAte = relogio + entre(CONFIG.descansoMs[0], CONFIG.descansoMs[1]);
      }
      if (a.saindo && !a.saiu && chegou(a, CONFIG.entrada)) { a.saiu = true; removerDom(a); }
    }
    if (atores.some((a) => a.saiu)) atores = atores.filter((a) => !a.saiu);
    if (relogio - (ultimoUso || 0) > 30000) { ultimoUso = relogio; desenharUso(); }
    desenhar();
    if (!pausado && !oculto && raiz) raf = requestAnimationFrame(quadro);
  }
  let ultimoUso = 0;

  // (Re)início do laço: o primeiro quadro não anda (dt ≈ 0), nada salta depois de uma pausa.
  function agendar() { if (!raf && !pausado && !oculto && raiz) { ultimoT = performance.now(); raf = requestAnimationFrame(quadro); } }

  function aoVisibilidade() {
    oculto = document.hidden;
    if (oculto) { if (raf) cancelAnimationFrame(raf); raf = 0; }
    else agendar();
  }

  // ─────────────────────────────── API pública ───────────────────────────────
  function montar(el, apiPagina) {
    if (raiz) desmontar();
    if (!el) throw new Error('Office.montar: contêiner ausente');
    api = apiPagina || null;
    forcarDemo = /(?:^|[?&])office-demo=1(?:&|$)/.test(location.search);
    mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    reduzido = !!(mq && mq.matches);
    if (mq && mq.addEventListener) mq.addEventListener('change', aoMovimento);
    montarGrade();
    montarEstacoes();
    construir(el);
    fundoVersao = null;
    vigiarFundo();
    alturaFixa = false;
    pausado = false; oculto = document.hidden; relogio = 0; pausadoEm = 0;
    atores = []; porChave = new Map(); interacoes = []; historicoInt = []; modo = null; timeId = null; jaPovoou = false; selecionado = null;
    tvAberta = false; tvAnim = null; tvLinhas = new Map(); timeDescs = [];
    usoDemo = null; usoCache = null; usoSimulado = false; cabAssin = ''; rodapeAssin = ''; ultimoUso = 0;

    if (api && typeof api.on === 'function') {
      const ouvir = (tipo, fn) => { const d = chamar(api.on, tipo, fn); if (typeof d === 'function') desinscrever.push(d); };
      ouvir('sessao', () => { sujo = true; });
      ouvir('remover', () => { sujo = true; });
      ouvir('uso', (u) => { if (u && typeof u === 'object') usoCache = u; desenharUso(); marcarAtualizado(); });
      ouvir('conexao', (v) => {
        const caiu = v === false || v === 'caiu' || (v && typeof v === 'object' && (v.ok === false || v.conectado === false || v.estado === 'caiu' || v.estado === 'reconectando'));
        conexaoOk = !caiu; rodapeAssin = '';
      });
    }
    document.addEventListener('keydown', aoTeclar, true);
    document.addEventListener('pointerdown', aoApontar, true);
    document.addEventListener('fullscreenchange', aposTelaCheia);
    document.addEventListener('visibilitychange', aoVisibilidade);
    window.addEventListener('resize', layout);
    if (window.ResizeObserver) { ro = new ResizeObserver(() => layout()); ro.observe(raiz); }

    layout();
    sincronizar(false);
    desenharUso();
    marcarAtualizado();
    desenhar();
    agendar();
  }

  function aoMovimento() { reduzido = !!(mq && mq.matches); }

  function pausar() {
    if (pausado) return;
    fecharTV(false);
    pausado = true;
    pausadoEm = Date.now();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (raiz && raiz.classList.contains('of-cheia')) raiz.classList.remove('of-cheia');
    querCheia = false; pedidoFs++;
  }

  function retomar() {
    if (!raiz) return;
    pausado = false;
    sujo = true;
    layout();
    agendar();
  }

  function desmontar() {
    pausar();
    clearInterval(fundoTimer); fundoTimer = 0;
    for (const d of desinscrever) chamar(d);
    desinscrever = [];
    document.removeEventListener('keydown', aoTeclar, true);
    document.removeEventListener('pointerdown', aoApontar, true);
    document.removeEventListener('fullscreenchange', aposTelaCheia);
    document.removeEventListener('visibilitychange', aoVisibilidade);
    window.removeEventListener('resize', layout);
    if (mq && mq.removeEventListener) mq.removeEventListener('change', aoMovimento);
    if (ro) ro.disconnect();
    ro = null;
    if (document.fullscreenElement === raiz) chamar(() => document.exitFullscreen().catch(() => {}));
    if (raiz) raiz.remove();
    raiz = palco = camAtores = camRot = topo = rodape = cartao = tvPop = null;
    tvAberta = false; tvAnim = null; tvLinhas = new Map();
    ui = {};
    atores = []; porChave = new Map(); interacoes = []; estacoes = [];
    api = null; modo = null;
  }

  function _debug() {
    const grade = [];
    for (let y = 0; y < R; y++) {
      let linha = '';
      for (let x = 0; x < C; x++) linha += caminhavel[id(x, y)] ? '1' : '0';
      grade.push(linha);
    }
    return {
      colunas: C, linhas: R, celula: cel, sprite: S, modo, pausado, reduzido,
      caminhavel: grade,
      robos: atores.filter((a) => !a.saiu).map((a) => ({
        id: a.id, nome: a.nome, funcao: a.funcao, estado: a.estado, x: a.x, y: a.y,
        celula: [Math.floor(a.x), Math.floor(a.y)], andando: a.andando, saindo: a.saindo,
        estacao: a.estacao ? [a.estacao.x, a.estacao.y] : null,
      })),
      interacoes: interacoes.map((it) => ({ tipo: it.tipo, fase: it.fase, v: it.v.nome, h: it.h.nome, tv: it.tv, th: it.th })),
      historico: historicoInt.slice(),
      rotulos: rotulosDebug.map((r) => ({ ...r })),
      telaCheia: !!(raiz && emTelaCheia()),
      painelTV: tvAberta,
    };
  }

  window.Office = { montar, pausar, retomar, desmontar, _debug, CONFIG, __versao: 1 };
})();

