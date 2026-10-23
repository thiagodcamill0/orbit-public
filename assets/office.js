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
  // Ajuste agentes, casas, nomes, textos, velocidades e limiares aqui.
  // O mapa é a Vila (ver o módulo Vila, abaixo): uma célula da grade = uma peça de 16 px do mapa.
  // Coordenadas em células (x = coluna, y = linha, origem no canto superior esquerdo do mundo).
  // Caminhável = trilha da vila sem objeto em cima (calculado pelo mapa; o balcão de envio bloqueia as suas).
  // Áreas: cada casa da vila é uma função; o retângulo vai do telhado à soleira (Vila.casa) e serve à placa.
  // Estações: célula da trilha, diante da porta da casa, onde o robô fica enquanto trabalha.
  // O desenho antigo (escritório com salas e o fundo.png) está guardado em _arquivo/office-escritorio/.
  const CONFIG = {
    grade: { colunas: 96, linhas: 60 },
    vila: { base: '/assets/vila/', fps: 8 }, // PNGs do Pixel Crawler Free Pack; fps = quadros do mapa animado (água, fogo)
    robos: { andando: '/assets/robot-run.gif', parado: '/assets/robot-idle.gif', dormindo: '/assets/robot-sleep-sheet.png' }, // dormindo: instância do Orbit sem processo (etapa 4)

    velocidade: 5.2,               // células por segundo (da estrada oeste à guilda em ~9 s)
    passosPorSegundoReduzido: 7,   // prefers-reduced-motion: anda em passos, ainda pelo caminho
    conversaMs: 3600,              // quanto dura o encontro lado a lado
    respostaMs: 1100,              // na conversa, quem recebe "digita" por esse tempo antes de responder
    filaMaxMs: 120000,             // interação que não começa nesse prazo é descartada
    caminhadaMaxMs: 45000,         // interação que não se encontra nesse prazo é descartada
    pesquisaRetemMs: 2500,         // fica no ponto de pesquisa esse tempo depois que a busca termina
    balcaoRetemMs: 1200,           // idem no balcão de envio, depois que a ação externa termina
    passagemMs: 700,               // o convidado para esse tempo ao passar pelo líder (entrando e saindo)
    passagemMaxMs: 20000,          // passagem que não se completa nesse prazo é abandonada
    externaAposMs: 8000,           // depois de uma permissão externa, quanto se espera a ferramenta rodar
    portaMs: 350,                  // quanto o robô leva para sumir na porta ao entrar na casa (e para surgir ao sair)
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

    // Casa → função. `casa` é o nome da construção no mapa (aparece na placa, ao lado da função).
    areas: [
      { id: 'mestre', nome: 'Mestre', casa: 'Guilda', funcao: 'mestre', vila: 'guild', x: 40, y: 22, w: 15, h: 12,
        estacoes: [{ x: 48, y: 33, funcao: 'mestre', destaque: true }, { x: 44, y: 33, funcao: 'auxiliar' }, { x: 52, y: 33, funcao: 'auxiliar' }] },
      { id: 'pesquisador', nome: 'Pesquisador', casa: 'Torre dos Magos', funcao: 'pesquisador', vila: 'tower', x: 20, y: 7, w: 6, h: 13,
        estacoes: [{ x: 23, y: 20 }, { x: 21, y: 21 }, { x: 25, y: 21 }] },
      { id: 'backend', nome: 'Backend', casa: 'Forja', funcao: 'backend', vila: 'forge', x: 69, y: 10, w: 8, h: 10,
        estacoes: [{ x: 73, y: 20 }, { x: 71, y: 21 }, { x: 69, y: 20 }] },
      { id: 'frontend', nome: 'Frontend', casa: 'Taverna', funcao: 'frontend', vila: 'tavern', x: 19, y: 24, w: 8, h: 10,
        estacoes: [{ x: 23, y: 33 }, { x: 21, y: 35 }, { x: 25, y: 35 }] },
      { id: 'tester', nome: 'Tester', casa: 'Cabana do Vigia', funcao: 'tester', vila: 'hut', x: 60, y: 36, w: 6, h: 10,
        estacoes: [{ x: 62, y: 45 }, { x: 60, y: 47 }, { x: 64, y: 47 }] },
      { id: 'serraria', nome: 'Auxiliar', casa: 'Serraria', funcao: 'auxiliar', vila: 'sawmill', x: 68, y: 23, w: 10, h: 11,
        estacoes: [{ x: 72, y: 33 }, { x: 70, y: 35 }, { x: 75, y: 35 }] },
      { id: 'estufa', nome: 'Auxiliar', casa: 'Estufa', funcao: 'auxiliar', vila: 'greenhouse', x: 28, y: 36, w: 6, h: 10,
        estacoes: [{ x: 31, y: 45 }, { x: 29, y: 47 }, { x: 33, y: 47 }] },
      // Descanso: a clareira da fogueira (lugares fixos nas células livres do retângulo).
      { id: 'descanso', nome: 'Fogueira', casa: 'Descanso', descanso: true, x: 45, y: 48, w: 6, h: 3, estacoes: [] },
    ],
    entrada: { x: 0, y: 34 },                // ponta oeste da estrada principal: por onde chegam e saem os agentes
    // Pontos do movimento por eventos reais (todos fixos). Pesquisa: na trilha ao lado da Torre, um por busca em curso.
    // Fila: na estrada, junto ao mural de missões da praça, 3 vagas na ordem de chegada. Balcão de envio: bloqueia
    // as 3 células na praça e o agente fica no `spot`, logo acima.
    pesquisa: [{ x: 27, y: 20 }, { x: 29, y: 21 }, { x: 31, y: 20 }],
    fila: [{ x: 57, y: 34 }, { x: 58, y: 34 }, { x: 59, y: 34 }],
    balcao: { x: 43, y: 37, w: 3, h: 1, spot: { x: 44, y: 36 } },
    // Marcadores do modo escritório. Para cada nome: tenta carregar a imagem (src e, se existir, src2x);
    // se carregar, a imagem substitui o marcador provisório (classe of-prov-<nome>); se não, fica o provisório.
    escritorioAssets: {
      'placa-pausado': { src: 'assets/office/escritorios/placa-pausado.png', src2x: 'assets/office/escritorios/placa-pausado@2x.png' },
      'fila-espera': { src: 'assets/office/escritorios/fila-espera.png', src2x: 'assets/office/escritorios/fila-espera@2x.png' },
      'balcao-envio': { src: 'assets/office/escritorios/balcao-envio.png', src2x: 'assets/office/escritorios/balcao-envio@2x.png' },
      'icone-cadeado': { src: 'assets/office/escritorios/icone-cadeado.png', src2x: 'assets/office/escritorios/icone-cadeado@2x.png' },
      'icone-moeda': { src: 'assets/office/escritorios/icone-moeda.png', src2x: 'assets/office/escritorios/icone-moeda@2x.png' },
    },
    escritorioSondaMs: 4000,       // tempo máximo da sonda de uma imagem de marcador
    // Mural de missões da praça (no mapa): clicável, abre o painel com as métricas do time. Retângulo em células.
    tv: { x: 54.75, y: 32.1, w: 2.5, h: 2.3 },
    // Balão da casa (interior): abre com o mouse parado sobre a casa por `esperaMs`; `largura` = largura máxima da
    // cena em px; `fps` = quadros por segundo do interior, desenhado só com o balão aberto.
    casaBalao: { esperaMs: 200, largura: 340, fps: 8 },
    // Rótulos da vila em pixel art. `escala`: px de tela por px de arte desejado (o fator real é o inteiro de pixels do
    // aparelho mais próximo, para não borrar). Larguras em px de arte. `avisosMax`: pedidos visíveis na fila do canto.
    // `tecla`: mostra/oculta placas, ícones e balões (fica salvo neste navegador).
    rotulos: { escala: 1.25, balaoLargura: 132, avisoLargura: 150, avisosMax: 3, tecla: 'l' },

    textos: {
      titulo: 'Visão de Office',
      selo: 'Demonstração',
      seloUso: 'Uso simulado',
      seloDica: {
        tudo: 'Cena e uso do plano simulados: nenhum time ativo e a status line ainda não mandou dados',
        cena: 'Cena simulada: nenhum time ativo no gerenciador',
        uso: 'Uso do plano ilustrativo: a status line ainda não mandou dados',
      },
      subDemo: 'Sem time ativo no gerenciador · roteiro de exemplo',
      estados: { trabalhando: 'Trabalhando', aguardando: 'Aguardando você', ocioso: 'Ocioso', erro: 'Erro' },
      precisa: 'Precisa de você',
      compactando: 'Organizando memória',
      // Balão do agente (estado na 2ª linha) e fila de pedidos do canto.
      rot: { ok: 'Concluído', ocioso: 'Descansando', dormindo: 'Dormindo', conversa: 'Conversa', dentro: 'dentro', codex: 'Codex',
        pede: 'pede permissão', pergunta: 'fez uma pergunta', plano: 'tem um plano', permitir: 'Permitir', negar: 'Negar', abrir: 'Abrir',
        enviando: 'Enviando…', falhou: 'Não deu. Tente de novo.', mais: 'mais', pedidos: 'Pedidos de permissão', tecla: 'L · rótulos' },
      erro: 'Erro',
      usoSessao: 'Sessão · 5h',
      usoSemanal: 'Semanal',
      usoSemDados: 'sem dados',
      telaCheia: 'Tela cheia',
      sairTelaCheia: 'Sair',
      entrada: 'Entrada',
      origens: { demo: 'Demonstração', sessao: 'Sessão principal', subagente: 'Subagente', dependente: 'Sessão dependente' },
      trocas: {
        delegar: (d) => [d ? 'Tarefa: ' + d : 'Nova tarefa', 'Vai lá!'],
        entregar: (d) => [d ? 'Entrega: ' + d : 'Tarefa entregue', 'Valeu!'],
      },
      // Selo do balão quando a fala não traz o próprio prefixo ("Entrega: …").
      tiposTroca: { delegar: 'Delegação', entregar: 'Entrega' },
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
    // Roteiro fixo do modo demonstração (sem sorteio): cada passo vale quando o relógio do ciclo passa de `t` (ms).
    // `quem` = função do robô. `delegar`/`entregar` disparam a conversa correspondente.
    roteiroDemo: {
      cicloMs: 64000,
      passos: [
        { t: 3000,  quem: 'tester',      estado: 'trabalhando', tarefa: 'Rodando a suíte de fumaça', delegar: true },
        { t: 8000,  quem: 'pesquisador', estado: 'trabalhando', tarefa: 'WebSearch · Fullscreen API', ferramenta: 'WebSearch' },
        { t: 13000, quem: 'pesquisador', estado: 'trabalhando', tarefa: 'Lendo o CSS do Orbit' },
        { t: 15000, quem: 'backend',     estado: 'aguardando',  tarefa: 'Testando a rota /uso', espera: 'Permissão: Bash · node servidor.mjs' },
        { t: 21000, quem: 'frontend',    estado: 'aguardando',  tarefa: 'Ajustando o layout do painel', espera: 'Permissão: Edit · index.html', externa: true },
        { t: 27000, quem: 'backend',     estado: 'trabalhando', tarefa: 'Ajustando o SSE /fluxo' },
        { t: 30000, quem: 'frontend',    estado: 'trabalhando', tarefa: 'Edit · index.html', ferramenta: 'Edit', alvo: 'index.html' },
        { t: 36000, quem: 'tester',      estado: 'ocioso',      tarefa: '', entregar: true },
        { t: 40000, quem: 'mestre',      estado: 'trabalhando', tarefa: 'Organizando memória', compactando: true },
        { t: 46000, quem: 'mestre',      estado: 'trabalhando', tarefa: 'Revisando as entregas do time' },
        { t: 48000, quem: 'backend',     estado: 'erro',        tarefa: 'Ajustando o SSE /fluxo', espera: 'SSE caiu: ECONNRESET' },
        { t: 54000, quem: 'backend',     estado: 'trabalhando', tarefa: 'Testando a rota /uso' },
        { t: 58000, quem: 'frontend',    estado: 'ocioso',      tarefa: '', entregar: true },
        { t: 62000, quem: 'frontend',    estado: 'trabalhando', tarefa: 'Ajustando o layout do painel' },
        { t: 63000, quem: 'mestre',      estado: 'trabalhando', tarefa: 'Coordenando a rodada 4' },
      ],
    },
  };
  // ═════════════════════════════ fim da configuração ═════════════════════════════

  // ═══════════════════════════════ VILA (o mapa) ═══════════════════════════════
  // A "Vila dos Agentes" do protótipo agent-office (Pixel Crawler Free Pack 2.11, Anokolisa; termos em
  // assets/vila/Terms.txt). Daqui só sai o mapa do acampamento: chão, casas, trilhas, fazenda, lago e
  // floresta. O miolo (80×50 peças de 16 px) é o do protótipo, com as mesmas coordenadas; em volta vai
  // uma faixa de floresta de MX/MY peças para o mapa parecer maior. Uma peça = uma célula da grade do
  // Office: só a trilha ('s') é caminhável, menos o que estiver sob uma casa ou um objeto.
  // Tudo o que é desenhado usa coordenadas do protótipo (px da vila); o mundo soma (OX, OY).
  const Vila = (function () {
    const TS = 16, VC = 80, VR = 50, MX = 8, MY = 5;
    const COLS = VC + 2 * MX, ROWS = VR + 2 * MY;
    const OX = MX * TS, OY = MY * TS, VW = VC * TS, VH = VR * TS, WW = COLS * TS, WH = ROWS * TS;
    const ARQS = ['iprops', 'bprops', 'eso', 'dprops', 'tools', 'res', 'meat', 'smoke', 'walls', 'roofs', 'floors', 'water',
      'veg', 'farm', 'rocks', 'furn', 'treeA', 'treeS', 'pine', 'pineS', 'camp', 'spit'];
    const IMG = {};
    let carga = null, pronto = false, falhou = false;
    // Casas com atividade agora (o Office liga conforme o estado real): acende a forja, a torre etc.
    const ativo = { torre: false, forja: false, mural: false, serraria: false };

    function carregar(base) {
      if (carga) return carga;
      // as casas desenhadas são opcionais: se uma faltar, só ela volta ao desenho montado
      const casas = Object.keys(ARTE).map((id) => new Promise((res) => {
        const im = new Image();
        im.onload = () => { IMG['casa:' + id] = im; res(); };
        im.onerror = () => res();
        im.src = base + 'casas/' + id + '.png?v=' + ARTE[id].w + 'x' + ARTE[id].h;  // ?v=: troca de URL quando a arte muda (imagens ficam 1 dia em cache)
      }));
      carga = Promise.all(ARQS.map((k) => new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => { IMG[k] = im; res(); };
        im.onerror = () => rej(new Error('vila: falha ao carregar ' + k));
        im.src = base + k + '.png';
      })).concat(casas)).then(() => { construir(); pronto = true; }, () => { falhou = true; carga = null; });
      return carga;
    }

    // ── atlas: [imagem, sx, sy, w, h] (recortes do protótipo) ──
    const S = {
      // pisos de interior
      floorWood:['iwalls', 16, 328, 48, 48],
      floorHerr:['iwalls', 176, 336, 32, 32],
      floorStone:['iwalls', 112, 336, 32, 32],
      // decoração de parede
      window:   ['iprops', 66, 176, 28, 33],
      chalk:    ['iprops', 194, 260, 28, 23],
      chalkTxt: ['iprops', 226, 260, 28, 23],
      bear:     ['iprops', 584, 7, 16, 17],
      wolf:     ['iprops', 552, 8, 16, 17],
      sword:    ['iprops', 98, 261, 28, 9],
      shield:   ['iprops', 129, 272, 14, 16],
      parch:    ['iprops', 102, 274, 20, 12],
      painting: ['iprops', 80, 320, 16, 16],
      landscape:['iprops', 81, 321, 14, 14],
      bannerR:  ['dprops', 67, 70, 10, 21],
      bannerB:  ['dprops', 83, 70, 10, 21],
      bannerG:  ['dprops', 99, 70, 10, 21],
      candelabra:['dprops', 19, 42, 10, 22],
      // móveis
      tableLong:['iprops', 0, 0, 64, 26],
      tableSm:  ['iprops', 7, 99, 34, 29],
      tableBlue:['iprops', 7, 163, 34, 29],
      tableRound:['iprops', 80, 7, 32, 35],
      chair:    ['iprops', 66, 3, 12, 24],
      chair2:   ['iprops', 67, 34, 11, 24],
      stool:    ['iprops', 81, 62, 14, 18],
      stoolRed: ['iprops', 97, 61, 14, 19],
      barrel:   ['iprops', 224, 121, 16, 24],
      bench:    ['iprops', 80, 301, 45, 18],
      rugGreen: ['iprops', 336, 336, 48, 48],
      rugCross: ['iprops', 432, 304, 80, 80],
      candle:   ['iprops', 546, 192, 12, 16],
      mug:      ['iprops', 564, 277, 9, 8],
      mug2:     ['iprops', 580, 277, 9, 8],
      bottleG:  ['iprops', 565, 307, 7, 10],
      bottleP:  ['iprops', 565, 323, 7, 10],
      bottleO:  ['iprops', 565, 291, 7, 10],
      plantPink:['iprops', 17, 352, 14, 32],
      plantA:   ['iprops', 48, 354, 16, 30],
      plantB:   ['iprops', 64, 354, 16, 30],
      plantC:   ['iprops', 32, 360, 15, 24],
      trunk:    ['iprops', 176, 67, 40, 31],      // baú grande de ferragens
      wardrobe: ['iprops', 0, 32, 32, 58],
      stoveA:   ['iprops', 116, 0, 30, 64],       // fogão de ferro com chaminé
      range:    ['iprops', 176, 0, 48, 64],       // fogão grande com forno
      sink:     ['iprops', 112, 222, 98, 34],     // bancada com pia
      cabinetDr:['bprops', 145, 128, 30, 32],
      cabinetSh:['bprops', 80, 132, 32, 24],
      cabinetDo:['bprops', 112, 132, 32, 24],
      wbMetal:  ['wb', 48, 115, 48, 45],
      wbWood:   ['wb', 48, 72, 48, 40],
      wbBig:    ['wb', 103, 58, 73, 58],          // bancada de ferramentas completa
      counter:  ['furn', 32, 121, 48, 23],        // balcão com gavetas
      counterTop:['furn', 0, 18, 48, 30],
      chestO:   ['furn', 736, 165, 16, 27],
      chestC:   ['furn', 752, 172, 16, 20],
      // pequenos objetos / ícones
      book:     ['eso', 0, 162, 15, 12],
      bookG:    ['eso', 4, 178, 9, 11],
      quill:    ['eso', 21, 145, 9, 14],
      paper:    ['eso', 35, 130, 9, 11],
      paper2:   ['eso', 19, 130, 9, 11],
      scroll:   ['eso', 1, 118, 14, 5],
      tablet:   ['eso', 17, 169, 14, 18],
      rune:     ['eso', 50, 113, 12, 14],
      flask:    ['eso', 3, 17, 11, 15],
      flaskS:   ['eso', 35, 21, 9, 11],
      jar:      ['eso', 2, 91, 11, 21],
      tube:     ['eso', 35, 91, 11, 21],
      tubeS:    ['eso', 19, 96, 9, 16],
      chestS:   ['eso', 82, 52, 13, 12],
      chestS2:  ['eso', 98, 52, 13, 12],
      gear:     ['tools', 113, 17, 14, 14],
      saw:      ['tools', 96, 20, 16, 8],
      crate:    ['res', 0, 154, 31, 24],
      coalPile: ['res', 1, 20, 45, 26],
      ingotA:   ['res', 6, 51, 6, 10],
      ingotB:   ['res', 21, 52, 5, 9],
      ingotC:   ['res', 38, 52, 5, 9],
      ingotD:   ['res', 54, 52, 5, 9],
      plank:    ['res', 32, 68, 32, 7],
      basketT:  ['meat', 64, 32, 16, 16],          // cesto de tomates
      basketG:  ['meat', 82, 32, 14, 16],          // cesto de verduras
      fish:     ['meat', 100, 33, 8, 14],
      fish2:    ['meat', 116, 33, 8, 14],
      bread:    ['meat', 97, 4, 13, 10],
      steak:    ['meat', 18, 82, 13, 13],
      chicken:  ['meat', 34, 96, 13, 15],
      seedBag:  ['farm', 0, 16, 15, 16],
      seedBag2: ['farm', 17, 16, 14, 16],
      // ======== vila ========
      // fachadas: tiras frontais de parede (Walls.png)
      wBeamA:   ['walls', 288, 184, 32, 56],
      wBeamB:   ['walls', 320, 184, 16, 56],
      wBeamC:   ['walls', 336, 184, 32, 56],
      wBeamD:   ['walls', 368, 184, 16, 56],
      wPlasA:   ['walls', 384, 184, 32, 56],
      wPlasB:   ['walls', 416, 184, 16, 56],
      wPlasC:   ['walls', 432, 184, 32, 56],
      wPlasD:   ['walls', 464, 184, 16, 56],
      wBrickA:  ['walls', 480, 184, 32, 56],
      wBrickB:  ['walls', 512, 184, 16, 56],
      wBrickC:  ['walls', 528, 184, 32, 56],
      wBrickD:  ['walls', 560, 184, 16, 56],
      wLogA:    ['walls', 0, 184, 32, 56],
      wLogB:    ['walls', 32, 184, 16, 56],
      wLogC:    ['walls', 48, 184, 32, 56],
      wLogD:    ['walls', 80, 184, 16, 56],
      wVertA:   ['walls', 192, 184, 32, 56],
      wVertB:   ['walls', 224, 184, 16, 56],
      wVertC:   ['walls', 240, 184, 32, 56],
      wVertD:   ['walls', 272, 184, 16, 56],
      wGlass:   ['walls', 0, 620, 96, 52],
      // portas, janelas e peças de construção (Buildings/Props.png)
      vArch:    ['bprops', 64, 20, 32, 44],
      vDoor:    ['bprops', 101, 29, 22, 35],
      vDoorIron:['bprops', 134, 27, 21, 37],
      vDoorGlass:['furn', 230, 285, 20, 35],
      vWinShut: ['bprops', 128, 65, 32, 31],
      vWinArch: ['bprops', 69, 65, 22, 31],
      vWinSmall:['bprops', 48, 80, 16, 16],
      vChimney: ['bprops', 4, 73, 24, 55],
      vFlowerBox:['bprops', 50, 154, 28, 17],
      vBenchStone:['bprops', 17, 132, 30, 12],
      vTrough:  ['bprops', 18, 160, 28, 11],
      vBench:   ['bprops', 83, 176, 58, 16],
      vBenchBack:['bprops', 83, 160, 58, 16],
      // mobiliário externo (Furniture.png)
      vLamp:    ['furn', 147, 448, 29, 46],   // poste (a lanterna é desenhada à parte)
      vLantern: ['furn', 176, 448, 15, 26],
      vPost:    ['furn', 148, 422, 8, 23],
      vPicnicA: ['furn', 83, 432, 59, 32],    // banco + mesa
      vPicnicB: ['furn', 96, 464, 46, 16],    // banco da frente
      vBucket:  ['furn', 769, 13, 14, 19],
      vCrates:  ['furn', 720, 73, 32, 23],
      vBarrel:  ['furn', 752, 73, 16, 23],
      vPot:     ['furn', 769, 80, 14, 16],
      vVase:    ['furn', 787, 76, 10, 20],
      vChest:   ['furn', 736, 165, 32, 27],
      vPier:    ['furn', 8, 548, 64, 72],
      // vegetação
      vBushS:   ['veg', 2, 5, 29, 27],
      vBushSy:  ['veg', 50, 5, 29, 27],
      vBushSo:  ['veg', 98, 5, 29, 27],
      vBushM:   ['veg', 3, 32, 42, 32],
      vBushMy:  ['veg', 51, 32, 42, 32],
      vBushL:   ['veg', 3, 64, 42, 32],
      vBushLo:  ['veg', 99, 64, 42, 32],
      vBushXL:  ['veg', 2, 99, 43, 43],
      vFern:    ['veg', 112, 166, 32, 26],
      vLeafy:   ['veg', 80, 147, 31, 25],
      vReed:    ['veg', 145, 166, 15, 26],
      vCattail: ['veg', 164, 176, 9, 16],
      vFox:     ['veg', 195, 161, 11, 31],
      vFox2:    ['veg', 212, 165, 9, 27],
      vFox3:    ['veg', 229, 176, 8, 16],
      vTuft:    ['veg', 97, 177, 14, 15],
      vSprout:  ['veg', 3, 178, 11, 13],
      vMush:    ['veg', 49, 338, 14, 14],
      vMushS:   ['veg', 36, 340, 8, 9],
      vLeaves:  ['veg', 64, 352, 48, 16],
      // horta
      vScare:   ['farm', 244, 33, 24, 47],
      vCrateCarrot:['farm', 160, 0, 16, 32],
      vCrateBeet:['farm', 160, 32, 16, 32],
      vCrateCab:['farm', 160, 64, 16, 32],
      vSack:    ['farm', 256, 16, 15, 16],
      // pedras e recursos
      vRockL:   ['rocks', 2, 19, 28, 43],
      vRockM:   ['rocks', 35, 19, 26, 27],
      vRockS:   ['rocks', 65, 19, 14, 11],
      vRockMg:  ['rocks', 131, 19, 26, 27],
      vRockSg:  ['rocks', 161, 19, 14, 11],
      vPebble:  ['rocks', 48, 51, 15, 10],
      vLog:     ['res', 32, 68, 32, 7],
      vLog2:    ['res', 16, 85, 32, 6],
      vChips:   ['res', 20, 97, 22, 13],
      vCoal:    ['res', 16, 156, 15, 20],
      // árvores
      tBig:     ['treeA', 3, 2, 73, 126],
      tBigY:    ['treeA', 83, 2, 73, 126],
      tPine:    ['pine', 4, 9, 54, 103],
      tPine2:   ['pine', 68, 9, 54, 103],
      tPine3:   ['pine', 4, 121, 54, 103],
      tPine4:   ['pine', 68, 121, 54, 103],
      tPineS:   ['pineS', 4, 4, 37, 76],
      tPineS2:  ['pineS', 52, 84, 37, 76],
      tSmall:   ['treeS', 32, 2, 32, 62],
      tSmallY:  ['treeS', 96, 2, 32, 62],
    };
    // flores: 4 cores × 8 variações, células de 16 px na Vegetation.png
    for (let c = 0; c < 4; c++)
      for (let v = 0; v < 8; v++) S[`fl${c}${v}`] = ['veg', 48 + v * 16, 368 + c * 16, 16, 16];
    // culturas: 7 tipos × estágios de crescimento (células de 16 px)
    const cropKey = (kind, stage) => `crop${kind}${stage}`;
    for (let k = 0; k < 7; k++)
      for (let s = 0; s < 4; s++) S[cropKey(k, s)] = ['farm', 32 + s * 16, 16 + k * 32, 16, 16];



    // animações: imagem, largura/altura do quadro, colunas, nº de quadros, fps
    const ANIM = {
      smoke:  { img: 'smoke', fw: 32, fh: 48, cols: 4, n: 4, fps: 5 },
      camp:   { img: 'camp', fw: 32, fh: 32, cols: 4, n: 4, fps: 8 },
      spit:   { img: 'spit', fw: 64, fh: 64, cols: 4, n: 4, fps: 6 },
      island: { img: 'water', fw: 96, fh: 80, cols: 4, n: 4, fps: 2.5 },
      // interiores (folhas carregadas só quando o primeiro balão de casa abre)
      alch:    { img: 'alch', fw: 80, fh: 80, cols: 5, n: 22, fps: 9 },
      alch2:   { img: 'alch2', fw: 48, fh: 64, cols: 11, n: 51, fps: 10 },
      anvil:   { img: 'anvil', fw: 64, fh: 80, cols: 8, n: 35, fps: 14 },
      ironf:   { img: 'ironf', fw: 48, fh: 64, cols: 2, n: 4, fps: 6 },
      cooker:  { img: 'cooker', fw: 48, fh: 32, cols: 4, n: 4, fps: 6 },
      pan1:    { img: 'pan1', fw: 32, fh: 32, cols: 4, n: 4, fps: 5 },
      pan3:    { img: 'pan3', fw: 32, fh: 32, cols: 12, n: 12, fps: 8 },
      pan4:    { img: 'pan4', fw: 32, fh: 32, cols: 4, n: 4, fps: 5 },
      pan5:    { img: 'pan5', fw: 32, fh: 32, cols: 8, n: 8, fps: 7 },
      brazier: { img: 'brazier', fw: 32, fh: 32, cols: 4, n: 4, fps: 7 },
      flame:   { img: 'flame', fw: 32, fh: 48, cols: 4, n: 4, fps: 9 },
      saw3:    { img: 'saw3', fw: 112, fh: 80, cols: 8, n: 60, fps: 14 },
    };

    // gerador determinístico da decoração (a mesma semente do protótipo: o miolo sai igual)
    let seed = 7;
    const srand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const spick = (arr) => arr[Math.floor(srand() * arr.length)];
    // outro gerador para a faixa nova de floresta (não mexe na sequência do miolo)
    let seed2 = 4242;
    const srand2 = () => { seed2 = (seed2 * 16807) % 2147483647; return (seed2 - 1) / 2147483646; };

    // ── chão em grade de 16 px: 'g' grama, 'd' terra lavrada, 's' trilha, 'w' água ──
    // GROUND cobre o mundo inteiro; area() e isHole() recebem coordenadas da vila (podem ser negativas na faixa).
    const GROUND = Array.from({ length: ROWS }, () => Array(COLS).fill('g'));
    const noMundo = (r, c) => r + MY >= 0 && c + MX >= 0 && r + MY < ROWS && c + MX < COLS;
    const G = (r, c) => GROUND[r + MY][c + MX];
    function area(t, c0, r0, c1, r1) {
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (noMundo(r, c)) GROUND[r + MY][c + MX] = t;
    }
    function layoutGround() {
      area('s', 0, 29, 79, 30);   // estrada principal (leste–oeste)
      area('s', 13, 15, 66, 16);  // estrada norte
      area('s', 29, 15, 30, 42);  // anel oeste
      area('s', 49, 15, 50, 42);  // anel leste
      area('s', 5, 41, 59, 42);   // estrada sul
      area('s', 39, 31, 40, 42);  // descida da praça para a fogueira
      area('s', 35, 27, 44, 32);  // praça da guilda
      area('s', 34, 28, 45, 31);
      area('s', 14, 28, 15, 28);  // porta da taverna
      area('s', 64, 28, 65, 28);  // porta da serraria
      area('s', 22, 40, 23, 40);  // porta da estufa
      area('s', 54, 40, 55, 40);  // porta da cabana
      area('s', 37, 43, 42, 45);  // clareira da fogueira
      area('s', 38, 46, 41, 46);
      area('d', 70, 19, 76, 28);  // pátio de toras
      area('d', 5, 33, 18, 40);   // campo norte
      area('d', 5, 43, 33, 46);   // campo sul
      // alargamentos curtos que quebram a reta das estradas
      for (const [c, r, w] of [[2, 28, 3], [20, 31, 2], [56, 28, 3], [62, 31, 2], [24, 17, 2], [58, 14, 2]]) area('s', c, r, c + w - 1, r);
      area('w', 60, 35, 76, 46);  // lago
      // Office: a estrada principal segue pela floresta nova até as bordas (por ela chegam e saem os agentes).
      area('s', -MX, 29, -1, 30);
      area('s', VC, 29, VC + MX - 1, 30);
    }
    const POND = { c0: 60, r0: 35, c1: 76, r1: 46 };
    const ISLAND = { x: 1112, y: 640 };

    // Autotile: a grama é a camada de cima, com "buracos" onde há terra/pedra/água.
    // As peças de borda vêm do bloco em cruz da Floors_Tiles.png (grama em x=0).
    const isHole = (r, c) => noMundo(r, c) && G(r, c) !== 'g';
    function edgePiece(off, r, c) {
      const n = off(r - 1, c), s = off(r + 1, c), e = off(r, c + 1), w = off(r, c - 1);
      const ne = off(r - 1, c + 1), nw = off(r - 1, c - 1), se = off(r + 1, c + 1), sw = off(r + 1, c - 1);
      const card = n + s + e + w;
      if (card === 0) {
        const d = ne + nw + se + sw;
        if (d === 0) return 'full';
        if (d > 1) return null;
        return se ? [0, 16] : sw ? [64, 16] : ne ? [0, 48] : [64, 48];
      }
      if ((n && s) || (e && w)) return null;
      if (card === 1) {
        if (s) return (ne || nw) ? null : [32, 0];
        if (n) return (se || sw) ? null : [32, 64];
        if (e) return (nw || sw) ? null : [0, 32];
        return (ne || se) ? null : [64, 32];
      }
      if (card === 2) {
        if (s && e) return nw ? null : [16, 16];
        if (s && w) return ne ? null : [48, 16];
        if (n && e) return sw ? null : [16, 48];
        return se ? null : [48, 48];
      }
      return null;
    }
    const grassTile = (r, c) => edgePiece(isHole, r, c);
    // tipo de "buraco" vizinho (o que aparece sob a borda da grama)
    function holeUnder(r, c) {
      let water = false;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!isHole(r + dr, c + dc)) continue;
        const t = G(r + dr, c + dc);
        if (t === 'w') water = true; else return t;
      }
      return water ? 'w' : null;
    }
    const R0 = -MY, R1 = VR + MY, C0 = -MX, C1 = VC + MX; // limites do mundo em coordenadas da vila

    // Chão definitivo: grama sem peça de borda correspondente vira terra (ou água, junto ao lago).
    function fecharChao() {
      layoutGround();
      for (let guard = 0; guard < 20; guard++) {
        let changed = false;
        for (let r = R0; r < R1; r++) for (let c = C0; c < C1; c++) {
          if (G(r, c) === 'g' && grassTile(r, c) === null) {
            GROUND[r + MY][c + MX] = holeUnder(r, c) === 'w' ? 'w' : (holeUnder(r, c) || 'd');
            changed = true;
          }
        }
        if (!changed) break;
      }
    }

    function buildGround() {
      const { c, g } = makeCanvas(WW, WH);
      g.translate(OX, OY);
      const F = IMG.floors;
      const fullSrc = { d: 176, s: 96, g: 16 };
      const variant = (r, c2) => (((r * 7 + c2 * 13) ^ (r * c2)) % 3 + 3) % 3;
      for (let r = R0; r < R1; r++) for (let c2 = C0; c2 < C1; c2++) {
        const t = G(r, c2), x = c2 * TS, y = r * TS;
        if (t === 'w') continue;                       // água é animada à parte
        if (t === 'd' || t === 's') {
          g.drawImage(F, fullSrc[t] + variant(r, c2) * 16, 158, 16, 16, x, y, 16, 16);
          continue;
        }
        const piece = grassTile(r, c2);
        if (piece !== 'full') {
          const u = holeUnder(r, c2);
          if (u === 'd' || u === 's') g.drawImage(F, fullSrc[u] + variant(r, c2) * 16, 158, 16, 16, x, y, 16, 16);
          g.drawImage(F, piece[0], piece[1], 16, 16, x, y, 16, 16);
        } else {
          g.drawImage(F, 16 + variant(r, c2) * 16, 158, 16, 16, x, y, 16, 16);
        }
      }
      darkPatches(g);
      for (const [k, x, y] of decoChao) draw(g, k, x, y);
      return c;
    }

    // manchas de grama mais escura: o mesmo autotile da grama, aplicado sobre ruído suave e escurecido
    function darkPatches(g) {
      const lat = LAT, lat2 = LAT2;
      const smooth = (k) => k * k * (3 - 2 * k);
      const noise = (r, c) => {
        const dentro = r >= 0 && c >= 0 && r < VR && c < VC;
        const L = dentro ? lat : lat2;
        if (!dentro) { r += MY; c += MX; }
        const y = r / 5, x = c / 5, y0 = Math.floor(y), x0 = Math.floor(x), fy = smooth(y - y0), fx = smooth(x - x0);
        const top = L[y0][x0] + (L[y0][x0 + 1] - L[y0][x0]) * fx;
        const bot = L[y0 + 1][x0] + (L[y0 + 1][x0 + 1] - L[y0 + 1][x0]) * fx;
        return top + (bot - top) * fy;
      };
      const dark = Array.from({ length: ROWS }, (_, rw) => Array.from({ length: COLS }, (_, cw) => {
        const r = rw - MY, c = cw - MX;
        return G(r, c) === 'g' && grassTile(r, c) === 'full' && noise(r, c) > 0.5;
      }));
      const off = (r, c) => !noMundo(r, c) || !dark[r + MY][c + MX];
      for (let guard = 0; guard < 30; guard++) {
        let changed = false;
        for (let r = R0; r < R1; r++) for (let c = C0; c < C1; c++)
          if (dark[r + MY][c + MX] && edgePiece(off, r, c) === null) { dark[r + MY][c + MX] = false; changed = true; }
        if (!changed) break;
      }
      const L = makeCanvas(WW, WH), F = IMG.floors;
      for (let r = R0; r < R1; r++) for (let c = C0; c < C1; c++) {
        if (!dark[r + MY][c + MX]) continue;
        const p = edgePiece(off, r, c), x = (c + MX) * TS, y = (r + MY) * TS;
        if (p === 'full') L.g.drawImage(F, 16 + ((((r * 5 + c * 3) % 3) + 3) % 3) * 16, 158, 16, 16, x, y, 16, 16);
        else L.g.drawImage(F, p[0], p[1], 16, 16, x, y, 16, 16);
      }
      L.g.globalCompositeOperation = 'source-atop';
      L.g.fillStyle = 'rgba(10,40,8,0.5)';
      L.g.fillRect(0, 0, WW, WH);
      g.drawImage(L.c, -OX, -OY);
    }

    // ── utilitários de desenho ──
    function draw(ctx, key, x, y, flip = false) {
      const [im, sx, sy, w, h] = S[key];
      x = Math.round(x); y = Math.round(y);
      if (flip) {
        ctx.save(); ctx.translate(x + w, y); ctx.scale(-1, 1);
        ctx.drawImage(IMG[im], sx, sy, w, h, 0, 0, w, h);
        ctx.restore();
      } else ctx.drawImage(IMG[im], sx, sy, w, h, x, y, w, h);
    }
    function drawFrame(ctx, a, i, x, y) {
      i = ((i % a.n) + a.n) % a.n;
      const sx = (i % a.cols) * a.fw, sy = Math.floor(i / a.cols) * a.fh;
      ctx.drawImage(IMG[a.img], sx, sy, a.fw, a.fh, Math.round(x), Math.round(y), a.fw, a.fh);
    }
    function tile(ctx, key, x0, y0, w, h) {
      const [im, sx, sy, tw, th] = S[key];
      for (let y = y0; y < y0 + h; y += th)
        for (let x = x0; x < x0 + w; x += tw) {
          const cw = Math.min(tw, x0 + w - x), ch = Math.min(th, y0 + h - y);
          ctx.drawImage(IMG[im], sx, sy, cw, ch, x, y, cw, ch);
        }
    }
    // sombra de contato em "pixels" (elipse achatada)
    function shadow(ctx, cx, cy, rw, alpha = 0.28) {
      ctx.fillStyle = `rgba(20,8,4,${alpha})`;
      const rows = [[rw - 3, -1], [rw, 0], [rw - 3, 1]];
      for (const [r, dy] of rows) ctx.fillRect(Math.round(cx - r), Math.round(cy + dy), r * 2, 1);
    }
    function makeCanvas(w, h) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      return { c, g };
    }
    function strip(g, keys, x, y) {
      for (const k of keys) { draw(g, k, x, y); x += S[k][3]; }
    }


    // ---------------------------------------------------------- construções
    // posição de cada casa na vila: canto superior esquerdo do desenho, base (pé da
    // fachada), soleira da porta (onde os agentes aparecem) e nó da rede de trilhas
    const BLD = {
      guild:      { x: 560, y: 272, w: 160, h: 184, base: 450, door: { x: 640, y: 456 }, node: 'plaza', tag: [640, 300] },
      tower:      { x: 192, y: 40,  w: 96,  h: 198, base: 238, door: { x: 240, y: 246 }, node: 'towD',  tag: [240, 64] },
      forge:      { x: 976, y: 90,  w: 128, h: 148, base: 238, door: { x: 1040, y: 246 }, node: 'forD', tag: [1040, 108] },
      tavern:     { x: 176, y: 312, w: 128, h: 148, base: 456, door: { x: 240, y: 462 }, node: 'tavD',  tag: [240, 330] },
      sawmill:    { x: 960, y: 294, w: 160, h: 162, base: 456, door: { x: 1040, y: 462 }, node: 'sawD', tag: [1040, 320] },
      greenhouse: { x: 320, y: 500, w: 96,  h: 148, base: 648, door: { x: 368, y: 654 }, node: 'ghD',  tag: [368, 516] },
      hut:        { x: 832, y: 498, w: 96,  h: 150, base: 648, door: { x: 880, y: 654 }, node: 'hutD', tag: [880, 522] },
    };
    // Casas desenhadas à mão (assets/vila/casas/<id>.png, geradas por testes/gerar-casas-vila.mjs).
    // porta: x do meio da porta no desenho, alinhado à soleira de BLD (trilhas e estações não mudam);
    // fumaca/fogo/janelas: pontos no desenho. Sem a imagem, a casa volta ao desenho montado do pack.
    const ARTE = {
      guild:   { w: 256, h: 183, porta: 128, janelas: [[26, 148], [53, 148], [203, 148], [230, 148]] },
      tower:   { w: 77,  h: 217, porta: 34, janelas: [[34, 104], [14, 139], [54, 139], [15, 184], [54, 184]] },
      forge:   { w: 161, h: 150, porta: 108, fumaca: [124, -42], fogo: [67, 124], janelas: [[137, 116]] },
      tavern:  { w: 151, h: 133, porta: 82, fumaca: [124, -42], janelas: [[43, 99], [124, 99]] },
      sawmill: { w: 148, h: 122, porta: 122 },
      greenhouse: { w: 122, h: 161, porta: 66, fumaca: [97, -34], janelas: [[35, 96], [64, 92], [94, 96], [36, 129], [94, 129], [102, 62]] },
      hut:     { w: 127, h: 159, porta: 64, fumaca: [84, -38], janelas: [[37, 114], [91, 114]] },
    };
    for (const [id, A] of Object.entries(ARTE)) {
      const B = BLD[id];
      B.velho = { x: B.x, y: B.y, w: B.w, h: B.h };  // pegada na trilha e desenho de reserva
      B.x = B.door.x - A.porta; B.y = B.base + 2 - A.h; B.w = A.w; B.h = A.h;
    }

    // telhado de cumeeira horizontal: corpo de tábuas + arremates laterais (Roofs.png)
    function roofRidge(g, x, y, bodies, extra) {
      const R = IMG.roofs;
      for (let i = 0; i < bodies; i++) {
        const bx = x + 16 + i * 64;
        g.drawImage(R, 32, 160, 64, 16, bx, y, 64, 16);
        for (let k = 0; k < extra; k++) g.drawImage(R, 32, 176, 64, 16, bx, y + 16 + k * 16, 64, 16);
        g.drawImage(R, 32, 176, 64, 32, bx, y + 16 + extra * 16, 64, 32);
      }
      const edge = (sx, ex) => {
        g.drawImage(R, sx, 184, 16, 16, ex, y, 16, 16);
        for (let k = 0; k < extra; k++) g.drawImage(R, sx, 200, 16, 16, ex, y + 16 + k * 16, 16, 16);
        g.drawImage(R, sx, 200, 16, 40, ex, y + 16 + extra * 16, 16, 40);
      };
      edge(16, x);
      edge(0, x + 16 + bodies * 64);
    }
    // telhado em "A" (empena virada para a frente) com o oitão preenchido
    function roofGable(g, sx, sy, w, h, x, y, apexDrop, sideDrop, fill) {
      const cx = x + w / 2;
      g.save();
      g.beginPath();
      g.moveTo(x, y + sideDrop + 4); g.lineTo(cx, y + apexDrop - 2); g.lineTo(x + w, y + sideDrop + 4);
      g.lineTo(x + w, y + sideDrop + 12); g.lineTo(x, y + sideDrop + 12); g.closePath();
      g.clip();
      const [fim, fx, fy, fw, fh] = fill;
      for (let yy = y + apexDrop - 4; yy < y + sideDrop + 12; yy += fh)
        for (let xx = x; xx < x + w; xx += fw) g.drawImage(IMG[fim], fx, fy, fw, fh, xx, yy, fw, fh);
      g.fillStyle = 'rgba(30,14,6,0.28)'; g.fillRect(x, y + apexDrop - 4, w, 6);
      g.restore();
      g.save();
      g.beginPath();
      g.moveTo(x, y); g.lineTo(x + w, y); g.lineTo(x + w, y + sideDrop + 1);
      g.lineTo(cx, y + apexDrop + 1); g.lineTo(x, y + sideDrop + 1); g.closePath();
      g.clip();
      g.drawImage(IMG.roofs, sx, sy, w, h, x, y, w, h);
      g.restore();
    }
    const eaveShade = (g, x, y, w) => { for (let i = 0; i < 4; i++) { g.fillStyle = `rgba(20,8,4,${0.3 - i * 0.07})`; g.fillRect(x, y + i, w, 1); } };
    // telhado íngreme de 96 px (chalés): oitão de tábuas atrás, pontas vizinhas apagadas
    function steepRoof(g, sx, y0, chimney) {
      g.save();
      g.beginPath(); g.moveTo(0, y0 + 68); g.lineTo(48, y0 + 46); g.lineTo(96, y0 + 68); g.lineTo(96, y0 + 98); g.lineTo(0, y0 + 98); g.closePath();
      g.clip();
      for (let yy = y0 + 46; yy < y0 + 98; yy += 30) for (let xx = 0; xx < 96; xx += 48) g.drawImage(IMG.walls, 216, 130, 48, 30, xx, yy, 48, 30);
      g.restore();
    }
    function steepRoofTop(g, sx, y0, chimney) {
      roofGable(g, sx, 80, 96, 94, 0, y0, 51, 92, ['walls', 216, 130, 48, 30]);
      g.save();
      g.globalCompositeOperation = 'destination-out';
      g.beginPath(); g.moveTo(0, 0); g.lineTo(44, 0); g.lineTo(0, y0 + 42); g.closePath();
      g.moveTo(96, 0); g.lineTo(52, 0); g.lineTo(96, y0 + 42); g.closePath();
      g.fill();
      if (chimney) { g.globalCompositeOperation = 'destination-over'; draw(g, 'vChimney', chimney, y0 - 2); }
      g.restore();
    }

    // Guilda: salão com telhado de cumeeira, estandartes e vasos de flores
    function buildGuildHall() {
      const { c, g } = makeCanvas(160, 184);
      draw(g, 'vChimney', 118, 4);
      strip(g, ['wBeamA', 'wBeamB', 'wBeamC', 'wBeamD', 'wBeamA', 'wBeamB', 'wBeamD'], 0, 122);
      roofRidge(g, 0, 44, 2, 2);
      eaveShade(g, 16, 124, 128);
      draw(g, 'vArch', 64, 134);
      draw(g, 'vWinShut', 14, 132);
      draw(g, 'vWinShut', 114, 132);
      draw(g, 'bannerB', 50, 130);
      draw(g, 'bannerR', 100, 130);
      draw(g, 'vFlowerBox', 16, 162);
      draw(g, 'vFlowerBox', 116, 162);
      return c;
    }
    // Torre dos Magos: dois andares (reboco sobre tijolo) e telhado verde íngreme
    function buildTower() {
      const { c, g } = makeCanvas(96, 198);
      steepRoof(g, 144, 2);
      strip(g, ['wPlasA', 'wPlasB', 'wPlasC', 'wPlasD'], 0, 94);
      strip(g, ['wBrickA', 'wBrickB', 'wBrickC', 'wBrickD'], 0, 142);
      steepRoofTop(g, 144, 2, 0);
      draw(g, 'vWinSmall', 40, 66);
      eaveShade(g, 0, 98, 96);
      draw(g, 'vWinArch', 10, 104); draw(g, 'vWinArch', 64, 104);
      draw(g, 'bannerB', 43, 104);
      eaveShade(g, 0, 146, 96);
      draw(g, 'vDoorIron', 38, 161);
      draw(g, 'vWinArch', 6, 156); draw(g, 'vWinArch', 68, 156);
      return c;
    }
    // Forja: tábuas verticais escuras, telhado de madeira, chaminé de pedra e boca de fogo
    function buildForge() {
      const { c, g } = makeCanvas(128, 148);
      const vert = (k, x) => { const [, sx] = S[k]; g.drawImage(IMG.walls, sx, 189, S[k][3], 51, x, 93, S[k][3], 51); return S[k][3]; };
      let x = 0;
      for (const k of ['wVertA', 'wVertB', 'wVertC', 'wVertD', 'wVertA']) x += vert(k, x);
      roofGable(g, 0, 6, 128, 89, 0, 2, 58, 90, ['walls', 112, 120, 48, 40]);
      g.save(); g.globalCompositeOperation = 'destination-over'; draw(g, 'vChimney', 92, 0); g.restore();
      draw(g, 'vWinSmall', 56, 72);
      eaveShade(g, 0, 96, 128);
      draw(g, 'vArch', 48, 104);
      // brasa no fundo da porta
      const gr = g.createLinearGradient(0, 120, 0, 148);
      gr.addColorStop(0, 'rgba(255,120,40,0)'); gr.addColorStop(1, 'rgba(255,120,40,0.45)');
      g.fillStyle = gr; g.fillRect(54, 118, 20, 30);
      draw(g, 'vWinSmall', 14, 110); draw(g, 'vWinSmall', 98, 110);
      draw(g, 'shield', 24, 128); draw(g, 'shield', 92, 128);
      return c;
    }
    // Taverna: reboco com madeira, telhado verde, janelas com venezianas e floreiras
    function buildTavern() {
      const { c, g } = makeCanvas(128, 148);
      strip(g, ['wBeamA', 'wBeamB', 'wBeamC', 'wBeamD', 'wBeamA'], 0, 88);
      roofGable(g, 128, 6, 128, 89, 0, 2, 58, 90, ['walls', 112, 120, 48, 40]);
      draw(g, 'vWinSmall', 56, 70);
      eaveShade(g, 0, 92, 128);
      draw(g, 'vDoor', 53, 109);
      draw(g, 'vWinShut', 8, 100);
      draw(g, 'vWinShut', 88, 100);
      draw(g, 'vFlowerBox', 10, 128);
      draw(g, 'vFlowerBox', 90, 128);
      draw(g, 'mug', 44, 104); draw(g, 'mug2', 76, 104);
      return c;
    }
    // Serraria: paredes de toras, telhado de cumeeira baixo e portão largo
    function buildSawmill() {
      const { c, g } = makeCanvas(160, 162);
      strip(g, ['wLogA', 'wLogB', 'wLogC', 'wLogD', 'wLogA', 'wLogB', 'wLogD'], 0, 106);
      roofRidge(g, 0, 44, 2, 1);
      eaveShade(g, 16, 108, 128);
      draw(g, 'vArch', 64, 118);
      draw(g, 'vWinSmall', 22, 126); draw(g, 'vWinSmall', 122, 126);
      draw(g, 'saw', 72, 112);
      return c;
    }
    // Estufa: paredes e telhado de vidro, porta envidraçada
    function buildGreenhouse() {
      const { c, g } = makeCanvas(96, 148);
      // oitão de vidro sob o telhado
      g.save();
      g.beginPath(); g.moveTo(0, 96); g.lineTo(48, 56); g.lineTo(96, 96); g.closePath(); g.clip();
      for (let yy = 50; yy < 100; yy += 26) g.drawImage(IMG.walls, 0, 624, 96, 26, 0, yy, 96, 26);
      g.restore();
      g.drawImage(IMG.roofs, 272, 87, 96, 100, 0, 0, 96, 100);
      draw(g, 'wGlass', 0, 96);
      eaveShade(g, 0, 98, 96);
      draw(g, 'vDoorGlass', 38, 113);
      // plantas vistas através do vidro
      for (const [k, x] of [['plantA', 6], ['plantB', 68]]) { g.globalAlpha = 0.55; draw(g, k, x, 112); g.globalAlpha = 1; }
      return c;
    }
    // Cabana do Vigia: chalé de toras com chaminé, junto ao lago
    function buildHut() {
      const { c, g } = makeCanvas(96, 150);
      steepRoof(g, 16, 2);
      strip(g, ['wLogA', 'wLogB', 'wLogC', 'wLogD'], 0, 94);
      steepRoofTop(g, 16, 2, 66);
      draw(g, 'vWinSmall', 40, 66);
      eaveShade(g, 0, 98, 96);
      draw(g, 'vDoor', 37, 115);
      draw(g, 'vWinArch', 7, 106);
      draw(g, 'vWinArch', 67, 106);
      draw(g, 'fish', 64, 140); draw(g, 'fish2', 74, 141);
      return c;
    }

    const vprops = [];   // objetos da vila, ordenados por profundidade (base)
    const vlights = [];
    const vsmoke = [];   // chaminés e fumaça (camada de cima)
    const pegadas = [];  // retângulos (px da vila) que bloqueiam a trilha: base das casas e dos objetos
    const pisa = (x, y, w, h) => pegadas.push({ x, y, w, h });

    // objeto do pack que ficaria por trás de uma casa desenhada (ela já traz barris, vasos etc.)
    const sobCasa = (x, y, w, h) => Object.keys(ARTE).some((id) => {
      const B = BLD[id];
      return x < B.x + B.w - 2 && x + w > B.x + 2 && y < B.base && y + h > B.y + 2;
    });
    function vp(key, x, y, opt = {}) {
      const [, , , w, h] = S[key];
      if (!opt.chao && sobCasa(x, y, w, h)) return;
      const base = opt.base != null ? opt.base : y + h;
      vprops.push({
        y: base,
        draw: (g) => {
          if (opt.shadow) shadow(g, x + w / 2, y + h - 1, opt.shadow, 0.22);
          draw(g, key, x, y, opt.flip);
        },
      });
      if (!opt.chao) pisa(x + 2, Math.max(y, base - 6), w - 4, Math.min(6, h));
    }
    // árvore posicionada pela base do tronco
    function tree(key, cx, base, flip = false) {
      const [, , , w, h] = S[key];
      const x = Math.round(cx - w / 2), y = base - h;
      vprops.push({ y: base, tree: true, x0: cx - 14, draw: (g) => { shadow(g, cx, base - 2, Math.round(w * 0.32), 0.25); draw(g, key, x, y, flip); } });
      pisa(cx - 5, base - 5, 10, 5);
    }
    // poste de luz: base do poste em (px, base); flip = braço para a esquerda
    function lamp(px, base, flip = false) {
      const y = base - 46;
      const x = flip ? px - 24 : px - 5;
      const lx = flip ? x - 15 : x + 29;
      vprops.push({ y: base, draw: (g) => {
        shadow(g, px, base - 1, 4, 0.22);
        draw(g, 'vLamp', x, y, flip);
        draw(g, 'vLantern', lx, y, flip);
      } });
      vlights.push({ x: lx + 7, y: y + 18, r: 40, color: [255, 200, 110], a: 0.3, flick: 0.6, eve: 1 });
      pisa(px - 3, base - 4, 6, 4);
    }
    // casa: o desenho (canvas) só é montado no 1º quadro, quando as imagens já carregaram
    // a pegada na trilha é sempre a do desenho montado (velho), para a rede de trilhas não mudar
    function canvasProp(fazer, x, y, base, w) {
      let cv = null;
      vprops.push({ y: base, draw: (g) => g.drawImage(cv || (cv = fazer()), x, y) });
      pisa(x, y + 30, w, base - y - 38); // a soleira (8 px acima da base) fica livre
    }
    function casaProp(id, fazer) {
      const B = BLD[id], V = B.velho;
      let cv = null;
      vprops.push({ y: B.base, draw: (g) => {
        const im = IMG['casa:' + id];
        if (im) g.drawImage(im, B.x, B.y);
        else g.drawImage(cv || (cv = fazer()), V.x, V.y);
      } });
      pisa(V.x, V.y + 30, V.w, B.base - V.y - 38);
    }
    function fenceRun(x0, x1, y) {
      vprops.push({ y: y + 16, draw: (g) => {
        const P = IMG.bprops;
        g.drawImage(P, 22, 176, 6, 16, x0, y, 6, 16);
        let x = x0 + 6;
        while (x < x1 - 6) { const w = Math.min(16, x1 - 6 - x); g.drawImage(P, 30, 176, w, 16, x, y, w, 16); x += w; }
        g.drawImage(P, 52, 176, 6, 16, x1 - 6, y, 6, 16);
      } });
      pisa(x0, y + 10, x1 - x0, 6);
    }
    function fenceSide(x, y0, y1) {
      vprops.push({ y: y1, draw: (g) => { for (let y = y0; y < y1 - 6; y += 16) g.drawImage(IMG.bprops, 6, 208, 4, Math.min(16, y1 - 6 - y), x, y, 4, Math.min(16, y1 - 6 - y)); } });
      pisa(x, y0, 4, y1 - y0);
    }
    function cropRow(loc, y, xs, kinds) {
      xs.forEach((x, i) => {
        const c = { x, y, kind: kinds[i % kinds.length], stage: 1 + Math.floor(srand() * 3), g: srand() };
        vprops.push({ y: y + 15, draw: (g) => draw(g, cropKey(c.kind, c.stage), c.x, c.y) });
      });
    }
    const range16 = (a, b) => { const o = []; for (let x = a; x <= b; x += 16) o.push(x); return o; };

    function buildVillage() {
      // ---------------------------------------- construções
      const builders = { guild: buildGuildHall, tower: buildTower, forge: buildForge, tavern: buildTavern,
                         sawmill: buildSawmill, greenhouse: buildGreenhouse, hut: buildHut };
      for (const [id, B] of Object.entries(BLD)) {
        if (ARTE[id]) casaProp(id, builders[id]);
        else canvasProp(builders[id], B.x, B.y, B.base, B.w);
      }
      // pontos de uma casa desenhada (relativos ao desenho) → px da vila
      const em = (id, [dx, dy]) => ({ x: BLD[id].x + dx, y: BLD[id].y + dy });
      if (!ARTE.guild) vsmoke.push({ x: 678, y: 236 });                 // guilda
      if (ARTE.forge && ARTE.forge.fumaca) vsmoke.push({ ...em('forge', ARTE.forge.fumaca), a: 0.6 });
      else if (!ARTE.forge) vsmoke.push({ x: 1068, y: 46, a: 0.6 });   // forja
      if (ARTE.tavern && ARTE.tavern.fumaca) vsmoke.push({ ...em('tavern', ARTE.tavern.fumaca), a: 0.45 });
      for (const id of ['greenhouse', 'hut']) if (ARTE[id] && ARTE[id].fumaca) vsmoke.push({ ...em(id, ARTE[id].fumaca), a: 0.45 });
      if (!ARTE.hut) vsmoke.push({ x: 898, y: 452, a: 0.45 });         // cabana
      const fogo = ARTE.forge && ARTE.forge.fogo ? em('forge', ARTE.forge.fogo) : { x: 1044, y: 228 };
      vlights.push({ ...fogo, r: 34, color: [255, 130, 50], a: 0.22, flick: 1 });
      vlights.push({ x: 640, y: 440, r: 30, color: [255, 190, 100], a: 0.18, flick: 1, eve: 1 });
      // janelas acesas ao entardecer (as das casas desenhadas vêm de ARTE)
      const janelas = [[590, 420], [690, 420], [206, 416], [274, 416], [222, 160], [258, 160], [988, 240], [1088, 240], [982, 432], [1092, 432], [892, 620], [866, 620]]
        .filter(([x, y]) => !Object.keys(ARTE).some((id) => { const V = BLD[id].velho; return x >= V.x && x < V.x + V.w && y >= V.y && y < V.y + V.h; }));
      for (const [id, A] of Object.entries(ARTE)) for (const j of A.janelas || []) { const p = em(id, j); janelas.push([p.x, p.y]); }
      for (const [x, y] of janelas)
        vlights.push({ x, y, r: 22, color: [255, 200, 110], a: 0.22, flick: 0.3, eve: 2 });

      // ---------------------------------------- praça da guilda (hub)
      vp('vBushS', 532, 420, { base: 446 });
      vp('vBushSy', 728, 412, { base: 438 });
      lamp(548, 526); lamp(732, 526, true);
      vp('vBarrel', 734, 380, { base: 406 }); vp('vCrates', 536, 410, { base: 434 });
      vp('vPot', 612, 436, { base: 452 }); vp('vVase', 662, 432, { base: 452 });
      // mural de missões da praça
      vprops.push({ y: 470, draw: (g, t) => {
        draw(g, 'vPost', 752, 447); draw(g, 'vPost', 776, 447);
        draw(g, 'chalkTxt', 752, 438);
        if (ativo.mural) draw(g, 'paper', 758 + (Math.floor(t) % 3) * 6, 443);
      } });
      pisa(752, 464, 34, 6);
      vp('vBenchStone', 566, 500, { base: 514 });
      vp('vBenchStone', 684, 500, { base: 514 });
      vp('vTrough', 600, 500, { base: 512 });

      // ---------------------------------------- distrito arcano (Torre)
      vp('vFox', 180, 214, { base: 244 }); vp('vFox2', 294, 218, { base: 244 });
      vp('vFern', 152, 216, { base: 242 }); vp('vMush', 296, 196, { base: 210 }); vp('vMushS', 178, 196, { base: 205 });
      vp('vPot', 216, 228, { base: 244 }); vp('vPot', 256, 228, { base: 244 });
      lamp(300, 250, true);
      vlights.push({ x: 240, y: 200, r: 36, color: [170, 140, 255], a: 0.12, flick: 0.5, on: () => ativo.torre });

      // ---------------------------------------- distrito do ofício (Forja)
      vp('vCoal', 1110, 214, { base: 236 }); vp('vBarrel', 960, 210, { base: 236 }); vp('vCrates', 1112, 192, { base: 216 });
      vp('vTrough', 950, 228, { base: 240 });
      lamp(970, 252);
      vlights.push({ ...(ARTE.forge && ARTE.forge.fogo ? fogo : { x: 1040, y: 236 }), r: 46, color: [255, 120, 40], a: 0.2, flick: 1, on: () => ativo.forja });

      // ---------------------------------------- distrito social (Taverna)
      vp('vPicnicA', 70, 384, { base: 416 }); vp('vPicnicB', 83, 416, { base: 432 });
      vp('mug', 92, 392, { base: 417 }); vp('bread', 110, 394, { base: 417 });
      vp('vBarrel', 310, 430, { base: 456 }); vp('vBarrel', 150, 432, { base: 458 }); vp('vCrates', 316, 446, { base: 470 });
      lamp(140, 470); lamp(330, 470, true);
      vlights.push({ x: 240, y: 444, r: 30, color: [255, 190, 100], a: 0.16, flick: 1, eve: 1 });

      // ---------------------------------------- dados (Serraria + pátio de toras)
      for (const [x, y, n] of [[1136, 330, 4], [1184, 350, 5], [1150, 396, 3], [1200, 410, 4]]) {
        vprops.push({ y: y + 12, draw: g => {
          for (let i = 0; i < n; i++) draw(g, i % 2 ? 'vLog2' : 'vLog', x + (i % 2) * 3, y - Math.floor(i / 2) * 6 - (i % 2) * 3);
        } });
      }
      vp('vChips', 1122, 434, { base: 446 }); vp('vChips', 1214, 380, { base: 392, flip: true });
      vp('vCrates', 946, 436, { base: 460 }); vp('vBarrel', 1126, 290, { base: 314 });
      vprops.push({ y: 446, draw: g => { if (ativo.serraria) draw(g, 'vLog', 1158, 428); } });
      lamp(1112, 470, true);

      // ---------------------------------------- fazenda (campos) + estufa
      fenceRun(72, 312, 516); fenceSide(72, 528, 652);
      fenceRun(72, 556, 748); fenceSide(72, 692, 762);
      const kindsN = [0, 2, 1, 4], kindsS = [3, 5, 6, 0];
      cropRow('village', 552, range16(112, 272), kindsN, 'n1');
      cropRow('village', 592, range16(112, 272), kindsN.slice(1), 'n2');
      cropRow('village', 696, [...range16(112, 240), ...range16(320, 528)], kindsS, 's1');
      cropRow('village', 724, [...range16(112, 240), ...range16(320, 528)], kindsS.slice(2), 's2');
      vp('vScare', 288, 546, { base: 592 });
      vp('vCrateCarrot', 308, 604, { base: 636 }); vp('vCrateBeet', 290, 612, { base: 640 }); vp('vSack', 82, 624, { base: 640 });
      vp('vBucket', 270, 676, { base: 695 }); vp('vSack', 556, 694, { base: 710 });
      vp('vPot', 420, 630, { base: 646 }); vp('vFlowerBox', 330, 640, { base: 654 });
      lamp(440, 666, true);
      // estufa: canteiros internos
      for (let i = 0; i < 80; i++) srand(); // canteiros da estufa (interior): mantém a sequência do protótipo

      // ---------------------------------------- fogueira (descanso)
      vprops.push({ y: 736, draw: (g, t) => drawFrame(g, ANIM.camp, Math.floor(t * ANIM.camp.fps), 624, 704) });
      pisa(626, 706, 28, 30);
      vlights.push({ x: 640, y: 720, r: 64, color: [255, 140, 50], a: 0.2, flick: 1, eve: 0.5 });
      vsmoke.push({ x: 624, y: 662, a: 0.4 });
      vp('vLog', 588, 734, { base: 742 }); vp('vLog', 660, 734, { base: 742 });
      vp('vLog2', 612, 748, { base: 755 });
      vprops.push({ y: 760, draw: (g, t) => drawFrame(g, ANIM.spit, Math.floor(t * ANIM.spit.fps), 676, 700) });
      pisa(684, 742, 46, 18);

      // ---------------------------------------- jardim de piquenique (civis)
      vp('vPicnicA', 694, 566, { base: 598 }); vp('vPicnicB', 707, 598, { base: 614 });
      vp('vBushL', 760, 530, { base: 562 }); vp('vBushM', 520, 560, { base: 592 });

      // ---------------------------------------- lago, píer e cabana
      vp('vPier', 944, 636, { base: 560, chao: true });   // deque é chão: fica sempre por baixo de quem passa
      for (const [k, x, y] of [['vReed', 1220, 580], ['vCattail', 964, 734], ['vReed', 952, 560], ['vCattail', 1216, 724],
                               ['vCattail', 1196, 572], ['vReed', 1060, 740], ['vRockMg', 1206, 640], ['vRockSg', 958, 712]])
        vp(k, x, y);
      vp('vBench', 980, 534, { base: 551 });
      vp('vBucket', 940, 652, { base: 670 });
      vp('fish', 946, 662, { base: 671 });
      lamp(930, 666, true);
      vp('vBarrel', 816, 620, { base: 646 }); vp('vCrates', 932, 610, { base: 634 });

      // ---------------------------------------- iluminação das trilhas
      lamp(462, 300); lamp(818, 300, true); lamp(462, 640); lamp(818, 640, true);
      lamp(40, 470); lamp(1240, 470, true);

      // ---------------------------------------- floresta ao redor e bosques
      plantForest();
      for (const [k, x, y] of [['vBushL', 330, 220], ['vBushS', 150, 280], ['vBushXL', 520, 370], ['vBushM', 760, 360],
                               ['vBushLo', 868, 368], ['vBushS', 410, 520], ['vBushSo', 540, 618], ['vBushMy', 900, 560],
                               ['vRockM', 120, 470], ['vRockS', 360, 300], ['vRockL', 880, 280], ['vRockS', 1150, 250],
                               ['vPebble', 470, 760], ['vRockSg', 760, 620], ['vMush', 534, 300], ['vMush', 20, 660],
                               ['vLeafy', 760, 740], ['vFern', 720, 264], ['vFern', 360, 600], ['vFox3', 560, 270], ['vFox3', 726, 268]])
        vp(k, x, y);
    }

    // retângulos onde não pode haver árvore nem decoração espalhada
    const KEEP_CLEAR = [
      [176, 30, 128, 230], [960, 80, 160, 170], [544, 250, 192, 220], [160, 300, 160, 176], [944, 280, 192, 190],
      [304, 486, 128, 180], [816, 486, 128, 180], [60, 500, 260, 160], [60, 680, 520, 100], [576, 680, 128, 96],
      [1104, 290, 140, 180], [930, 520, 310, 250], [660, 540, 140, 80], [40, 360, 120, 90], [740, 400, 60, 80],
    ];
    const clearAt = (x, y) => KEEP_CLEAR.some(([ax, ay, aw, ah]) => x > ax && x < ax + aw && y > ay && y < ay + ah);
    function nearHole(x, y, rad = 1) {
      const c = Math.floor(x / TS), r = Math.floor(y / TS);
      for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) if (isHole(r + dr, c + dc)) return true;
      return false;
    }
    function freeForDecor(x, y) { return !nearHole(x, y) && !clearAt(x, y); }

    // floresta: faixa densa nas bordas + bosques entre os distritos (posições determinísticas)
    function plantForest() {
      const big = ['tPine', 'tPine2', 'tPine3', 'tPine4', 'tBig', 'tBigY', 'tPine', 'tPine3'];
      const small = ['tPineS', 'tPineS2', 'tSmall', 'tSmallY'];
      const groves = [[330, 40, 200, 200], [830, 40, 130, 210], [1130, 60, 150, 220], [0, 90, 150, 240], [380, 280, 70, 120],
                      [840, 300, 90, 130], [730, 700, 60, 50]];
      const inGrove = (x, y) => groves.some(([ax, ay, aw, ah]) => x > ax && x < ax + aw && y > ay && y < ay + ah);
      for (let gy = 20; gy < VH + 120; gy += 30) {
        for (let gx = -10; gx < VW + 30; gx += 34) {
          const x = gx + Math.round((srand() - 0.5) * 22), base = gy + Math.round((srand() - 0.5) * 16);
          const edge = base < 112 || base > VH - 24 || x < 40 || x > VW - 40;
          if (!edge && !inGrove(x, base)) continue;
          if (base > 140 && base < VH - 24 && (nearHole(x, base - 6, 1) || clearAt(x, base - 4))) continue;
          if (base <= 140 && clearAt(x, base - 4)) continue;
          if (!edge && srand() < 0.35) continue;
          if (base > VH - 24) { tree(spick(small), x, VH + 14 + Math.round(srand() * 10), srand() < 0.5); continue; }
          const k = edge || srand() < 0.6 ? spick(big) : spick(small);
          tree(k, x, base, srand() < 0.5);
        }
      }
    }


    // flores, tufos e folhas: decidido no plano (mesma sequência do protótipo) e desenhado direto no chão
    const decoChao = [];
    function planScatter() {
      const clusters = [
        [580, 520, 0], [700, 520, 3], [360, 330, 1], [420, 420, 2], [160, 260, 0], [880, 420, 3],
        [760, 440, 2], [520, 700, 1], [800, 760, 0], [300, 470, 3], [1200, 260, 1], [960, 300, 2],
        [80, 560, 1], [1000, 520, 0], [560, 420, 3], [470, 230, 1], [620, 600, 2], [740, 600, 0],
      ];
      for (const [cx, cy, col] of clusters) {
        for (let i = 0; i < 8; i++) {
          const x = cx + Math.round((srand() - 0.5) * 48), y = cy + Math.round((srand() - 0.5) * 26);
          if (!freeForDecor(x + 8, y + 8)) continue;
          decoChao.push([`fl${col}${3 + Math.floor(srand() * 5)}`, x, y]);
        }
      }
      for (let i = 0; i < 190; i++) {
        const x = Math.round(srand() * (VW - 16)), y = Math.round(40 + srand() * (VH - 56));
        if (!freeForDecor(x + 6, y + 8)) continue;
        const k = srand();
        decoChao.push([k < 0.45 ? 'vTuft' : k < 0.7 ? 'vSprout' : k < 0.85 ? `fl${Math.floor(srand() * 4)}${Math.floor(srand() * 3)}` : 'vMushS', x, y]);
      }
      for (const [x, y] of [[360, 250], [800, 120], [14, 360], [1180, 200], [700, 700], [90, 500]]) decoChao.push(['vLeaves', x, y]);
      // faixa nova: alguns tufos e flores entre as árvores
      for (let i = 0; i < 160; i++) {
        const x = Math.round(C0 * TS + srand2() * (WW - 16)), y = Math.round(R0 * TS + srand2() * (WH - 16));
        if (x > -8 && x < VW - 8 && y > -8 && y < VH - 8) continue;
        if (nearHole(x + 6, y + 8)) continue;
        const k = srand2();
        decoChao.push([k < 0.5 ? 'vTuft' : k < 0.75 ? 'vSprout' : k < 0.9 ? `fl${Math.floor(srand2() * 4)}${Math.floor(srand2() * 3)}` : 'vMushS', x, y]);
      }
    }
    let LAT = null, LAT2 = null;

    // ── floresta nova: a faixa de MX/MY peças em volta do miolo, densa, sem tocar a estrada ──
    function trilhaPerto(x, base) {
      const c = Math.floor(x / TS), r = Math.floor(base / TS);
      for (let dr = -7; dr <= 1; dr++) for (let dc = -2; dc <= 2; dc++) if (isHole(r + dr, c + dc)) return true;
      return false;
    }
    function plantMargem() {
      const big = ['tPine', 'tPine2', 'tPine3', 'tPine4', 'tBig', 'tBigY', 'tPine', 'tPine3'];
      const small = ['tPineS', 'tPineS2', 'tSmall', 'tSmallY'];
      const pick2 = (arr) => arr[Math.floor(srand2() * arr.length)];
      for (let gy = R0 * TS + 22; gy < R1 * TS + 40; gy += 27) {
        for (let gx = C0 * TS - 6; gx < C1 * TS + 24; gx += 29) {
          const x = gx + Math.round((srand2() - 0.5) * 20), base = gy + Math.round((srand2() - 0.5) * 14);
          const faixa = x < -4 || x > VW + 4 || base < 24 || base > VH + 34;
          if (!faixa || trilhaPerto(x, base)) continue;
          const k = srand2() < 0.78 ? pick2(big) : pick2(small);
          tree(k, x, base, srand2() < 0.5);
        }
      }
    }

    // ── plano (sem imagens): chão, posições de tudo e a grade caminhável ──
    let planejado = false;
    function planejar() {
      if (planejado) return;
      planejado = true;
      fecharChao();
      // mesma ordem do protótipo: chão (manchas e flores) e depois a vila
      LAT = Array.from({ length: Math.ceil(VR / 5) + 2 }, () => Array.from({ length: Math.ceil(VC / 5) + 2 }, () => srand()));
      LAT2 = Array.from({ length: Math.ceil(ROWS / 5) + 2 }, () => Array.from({ length: Math.ceil(COLS / 5) + 2 }, () => srand2()));
      planScatter();
      buildVillage();
      plantMargem();
      vprops.forEach((p, i) => { p.i = i; });
      vprops.sort((p, q) => p.y - q.y || p.i - q.i);
    }

    const ENTRADA = { x: 0, y: 29 + MY }; // ponta oeste da estrada principal (célula do mundo)
    // 1 = caminhável (trilha livre), 0 = não. Índice: y * COLS + x (células do mundo).
    function grade() {
      planejar();
      const g = new Uint8Array(COLS * ROWS);
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) g[r * COLS + c] = GROUND[r][c] === 's' ? 1 : 0;
      // Bloqueia a célula se a pegada cobre o miolo dela (4 px de folga em cada lado): um objeto que só
      // encosta na beira da trilha não a fecha.
      for (const p of pegadas) {
        if (p.w <= 0 || p.h <= 0) continue;
        const c0 = Math.floor((p.x - 11) / TS), c1 = Math.floor((p.x + p.w - 5) / TS);
        const r0 = Math.floor((p.y - 11) / TS), r1 = Math.floor((p.y + p.h - 5) / TS);
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          const ix = Math.min(p.x + p.w, c * TS + 12) - Math.max(p.x, c * TS + 4);
          const iy = Math.min(p.y + p.h, r * TS + 12) - Math.max(p.y, r * TS + 4);
          if (ix > 0 && iy > 0 && noMundo(r, c)) g[(r + MY) * COLS + c + MX] = 0;
        }
      }
      // Fica só a rede ligada à estrada principal (pedaços soltos não servem a ninguém).
      const ok = new Uint8Array(COLS * ROWS), pilha = [ENTRADA.y * COLS + ENTRADA.x];
      ok[pilha[0]] = 1;
      while (pilha.length) {
        const k = pilha.pop(), x = k % COLS, y = (k / COLS) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy, j = ny * COLS + nx;
          if (nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS && g[j] && !ok[j]) { ok[j] = 1; pilha.push(j); }
        }
      }
      return ok;
    }

    // ── desenho ──
    let chao = null, mundo = null;
    function construir() {
      planejar();
      chao = buildGround();
    }

    function drawWater(g, t) {
      const k = Math.floor(t * ANIM.island.fps) % 4;
      for (let r = POND.r0 - 1; r <= POND.r1 + 1; r++) for (let c = POND.c0 - 1; c <= POND.c1 + 1; c++) {
        g.drawImage(IMG.water, k * 96, 0, 16, 16, c * TS, r * TS, 16, 16);
      }
      drawFrame(g, ANIM.island, k, ISLAND.x, ISLAND.y);
      g.fillStyle = 'rgba(220,240,255,0.55)';
      for (let i = 0; i < 14; i++) {
        const ph = (t * 0.35 + i * 0.37) % 1;
        const x = POND.c0 * TS + 10 + ((i * 53) % ((POND.c1 - POND.c0) * TS - 20));
        const y = POND.r0 * TS + 8 + ((i * 37) % ((POND.r1 - POND.r0) * TS - 12));
        if (x > ISLAND.x - 4 && x < ISLAND.x + 96 && y > ISLAND.y - 4 && y < ISLAND.y + 80) continue;
        g.globalAlpha = Math.sin(ph * Math.PI) * 0.7;
        g.fillRect(x + Math.round(ph * 6), y, 3, 1);
      }
      g.globalAlpha = 1;
    }

    function glow(g, L, t, k) {
      const f = L.flick ? 1 + Math.sin(t * 9 + L.x) * 0.06 * L.flick + Math.sin(t * 23 + L.y) * 0.04 * L.flick : 1;
      const r = L.r * f, a = L.a * f * k;
      if (a <= 0.002) return;
      const gr = g.createRadialGradient(L.x, L.y, 0, L.x, L.y, r);
      const [cr, cg, cb] = L.color;
      gr.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
      gr.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      g.fillStyle = gr;
      g.fillRect(L.x - r, L.y - r, r * 2, r * 2);
    }

    // Quadro do mundo inteiro (WW×WH, px de arte), de dia. `t` em segundos.
    function desenhar(t) {
      if (!mundo) mundo = makeCanvas(WW, WH);
      const g = mundo.g;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.imageSmoothingEnabled = false;
      if (!pronto) { desenharSimples(g); return mundo.c; }
      g.fillStyle = '#2f5a1e'; g.fillRect(0, 0, WW, WH);
      g.setTransform(1, 0, 0, 1, OX, OY);
      drawWater(g, t);
      g.drawImage(chao, -OX, -OY);
      for (const p of vprops) p.draw(g, t);
      for (const s of vsmoke) {
        g.globalAlpha = s.a || 0.55;
        drawFrame(g, ANIM.smoke, Math.floor(t * ANIM.smoke.fps + s.x), s.x, s.y);
      }
      g.globalAlpha = 1;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.save();
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = 'rgb(255,250,240)';
      g.fillRect(0, 0, WW, WH);
      const vg = g.createRadialGradient(WW / 2, WH / 2, Math.min(WW, WH) * 0.47, WW / 2, WH / 2, Math.max(WW, WH) * 0.66);
      vg.addColorStop(0, 'rgba(255,255,255,1)');
      vg.addColorStop(1, 'rgb(214,214,200)');
      g.fillStyle = vg; g.fillRect(0, 0, WW, WH);
      g.restore();
      g.save();
      g.setTransform(1, 0, 0, 1, OX, OY);
      g.globalCompositeOperation = 'lighter';
      for (const L of vlights) {
        if (L.on && !L.on()) continue;
        const lk = L.eve == null ? 1 : L.eve === 2 ? 0 : 1 - L.eve;
        glow(g, L, t, lk);
      }
      g.restore();
      return mundo.c;
    }

    // Sem as imagens (carregando ou falhou): o mesmo mapa em blocos de cor.
    function desenharSimples(g) {
      const cor = { g: '#3d6b2a', s: '#b08a5a', d: '#6b4a2e', w: '#3f7fa8' };
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        g.fillStyle = cor[GROUND[r][c]] || cor.g;
        g.fillRect(c * TS, r * TS, TS, TS);
      }
      g.fillStyle = 'rgba(20,48,16,.55)';
      for (const p of vprops) if (p.tree) g.fillRect(p.x0 + OX, p.y - 40 + OY, 28, 34);
      for (const id in BLD) {
        const B = BLD[id];
        g.fillStyle = '#7a4b2f'; g.fillRect(B.x + OX, B.y + OY + 40, B.w, B.base - B.y - 40);
        g.fillStyle = '#4a2e22'; g.fillRect(B.x + OX, B.y + OY + 10, B.w, 40);
      }
    }

    // ── interiores (balão de cada casa) ──
    // Portados do protótipo: parede do tema, piso, vigas, porta no rodapé e a mobília de cada casa. O desenho
    // só acontece com o balão aberto; as folhas extras são carregadas no primeiro uso. `on` = alguém da casa
    // trabalha agora (a estação anima e a luz acende); `notas` = papéis no quadro da Guilda (a fila do mural).
    const ARQS_INT = ['iwalls', 'wb', 'alch', 'alch2', 'anvil', 'ironf', 'cooker', 'pan1', 'pan3', 'pan4', 'pan5',
      'brazier', 'flame', 'saw3'];
    const WALL_Y = 6, FLOOR_Y = 62;
    let cargaInt = null, prontoInt = false, falhouInt = false;
    const cena = { on: false, notas: 0 };
    function carregarInteriores(base) {
      if (cargaInt) return cargaInt;
      falhouInt = false;
      cargaInt = Promise.all([carregar(base), ...ARQS_INT.map((k) => IMG[k] ? null : new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => { IMG[k] = im; res(); };
        im.onerror = () => rej(new Error('vila: falha ao carregar ' + k));
        im.src = base + k + '.png';
      }))]).then(() => {
        if (!pronto) throw new Error('vila: mapa sem imagens');
        prontoInt = true;
      }).catch(() => { falhouInt = true; cargaInt = null; });
      return cargaInt;
    }

    const WALLS = {   // painéis de parede (iwalls): [larga, estreita, pilar]
      plaster: [[304, 152, 32, 56], [336, 152, 16, 56], [371, 135, 13, 61]],
      log:     [[16, 152, 32, 56], [48, 152, 16, 56], [0, 134, 13, 63]],
      stone:   [[112, 152, 32, 56], [144, 152, 16, 56], [96, 128, 16, 69]],
      plank:   [[208, 152, 32, 56], [240, 152, 16, 56], [371, 135, 13, 61]],
    };
    const ROOMS = {};
    // trab: lugares de trabalho (na ordem das estações da casa) · desc: onde quem está à toa fica
    function room(o) { Object.assign(o, { props: [], lights: [], torches: [], trab: [], desc: [] }); ROOMS[o.id] = o; return o; }

    function buildRoomBg(R) {
      const { c, g } = makeCanvas(R.w, R.h);
      const [pa, pb, pil] = WALLS[R.wall];
      g.fillStyle = '#000'; g.fillRect(0, 0, R.w, R.h);
      tile(g, R.floor, 7, FLOOR_Y, R.w - 14, R.h - FLOOR_Y - 7);
      if (R.floorDeco) R.floorDeco(g, R);
      for (let i = 0; i < 6; i++) { g.fillStyle = `rgba(15,6,2,${0.42 - i * 0.07})`; g.fillRect(7, FLOOR_Y + i, R.w - 14, 1); }
      let x = 7;
      while (x < R.w - 7) {
        const p = (R.w - 7 - x) >= 32 ? pa : pb;
        g.drawImage(IMG.iwalls, p[0], p[1], p[2], p[3], x, WALL_Y, p[2], p[3]);
        x += p[2];
      }
      g.fillStyle = '#000'; g.fillRect(0, 0, R.w, WALL_Y);
      if (R.wallDeco) R.wallDeco(g, R);
      for (const px of R.pillars || []) {
        g.drawImage(IMG.iwalls, pil[0], pil[1], pil[2], pil[3], px, FLOOR_Y + 4 - pil[3], pil[2], pil[3]);
        R.torches.push({ x: px + Math.round(pil[2] / 2), y: 20 });
        R.lights.push({ x: px + 6, y: 22, r: 46, color: [255, 160, 70], a: 0.22, flick: 1 });
      }
      for (let yy = WALL_Y; yy < R.h; yy += 16) {
        g.drawImage(IMG.iwalls, 288, 40, 7, 16, 0, yy, 7, 16);
        g.save(); g.translate(R.w, yy); g.scale(-1, 1); g.drawImage(IMG.iwalls, 288, 40, 7, 16, 0, 0, 7, 16); g.restore();
      }
      for (let xx = 0; xx < R.w; xx += 16) {
        g.save(); g.translate(xx, R.h); g.scale(1, -1); g.drawImage(IMG.iwalls, 320, 0, 16, 10, 0, 0, 16, 10); g.restore();
        g.drawImage(IMG.iwalls, 320, 0, 16, 10, xx, 0, 16, 7);
      }
      const x0 = R.door - 14, dw = 28, y0 = R.h - 12;
      g.save(); g.beginPath(); g.rect(x0, y0, dw, 12); g.clip();
      tile(g, R.floor, 7, FLOOR_Y, R.w - 14, R.h - FLOOR_Y);
      g.restore();
      for (const bx of [x0 - 7, x0 + dw]) g.drawImage(IMG.iwalls, 288, 40, 7, 16, bx, R.h - 16, 7, 16);
      for (let i = 0; i < 10; i++) { g.fillStyle = `rgba(255,236,190,${0.02 + i * 0.012})`; g.fillRect(x0, R.h - 10 + i, dw, 1); }
      R.lights.push({ x: R.door, y: R.h - 2, r: 38, color: [255, 236, 190], a: 0.22, flick: 0 });
      return c;
    }

    function furnish(R) {
      const add = (y, fn) => R.props.push({ y, draw: fn });
      return {
        add,
        prop(key, x, y, opt = {}) { const hh = S[key][4]; add(opt.base != null ? opt.base : y + hh, (g) => draw(g, key, x, y, opt.flip)); },
        // estação animada: anima quando alguém da casa trabalha (ou sempre, com `always`)
        anim(A, x, y, base, opt = {}) {
          add(base, (g, t) => {
            const f = opt.always || cena.on ? Math.floor((t + (opt.phase || 0)) * A.fps * (opt.speed || 1)) : (opt.rest || 0);
            drawFrame(g, A, f, x, y);
          });
        },
        light(o) { R.lights.push(o); },
      };
    }
    const lig = () => cena.on;
    const lugar = (x, y, rot) => ({ x, y, rot });

    room({
      id: 'guild', w: 512, h: 320, wall: 'plaster', floor: 'floorWood', door: 256, pillars: [96, 404],
      ambient: [222, 208, 226], vignette: [150, 118, 160], beams: [40, 460],
      floorDeco(g) { draw(g, 'rugGreen', 232, 120); draw(g, 'rugCross', 216, 226); },
      wallDeco(g) {
        draw(g, 'window', 26, 16); draw(g, 'window', 446, 16);
        draw(g, 'bannerR', 70, 18);
        draw(g, 'chalkTxt', 122, 16); draw(g, 'chalk', 150, 16); draw(g, 'chalkTxt', 178, 16);
        draw(g, 'bannerB', 230, 18); draw(g, 'shield', 249, 22); draw(g, 'bannerG', 272, 18);
        draw(g, 'wolf', 318, 20); draw(g, 'sword', 340, 26); draw(g, 'bear', 374, 20);
        draw(g, 'painting', 482, 24);
      },
      build(R) {
        const P = furnish(R);
        P.add(63, (g) => { const n = Math.min(10, cena.notas); for (let i = 0; i < n; i++) draw(g, 'paper', 127 + (i % 5) * 15 + (i >= 5 ? 6 : 0), 18 + Math.floor(i / 5) * 11); });
        for (const cx of [228, 250, 272]) P.prop('chair', cx, 76, { base: 98 });
        P.add(118, (g, t) => {
          draw(g, 'tableLong', 224, 92);
          draw(g, 'tablet', 230, 94); draw(g, 'scroll', 250, 101); draw(g, 'book', 266, 95);
          draw(g, 'quill', 282, 91); draw(g, 'candle', 238, 84);
          if (cena.on && Math.floor(t * 2) % 2) draw(g, 'paper', 254, 92);
        });
        P.light({ x: 244, y: 90, r: 30, color: [255, 190, 90], a: 0.2, flick: 1 });
        P.prop('trunk', 452, 92); P.prop('chestS', 458, 84, { base: 124 }); P.prop('chestS2', 474, 84, { base: 124 });
        P.prop('chestC', 470, 128); P.prop('chestO', 488, 121); P.prop('chestS', 454, 136, { base: 149 });
        P.prop('cabinetDr', 12, 84); P.prop('barrel', 44, 92); P.prop('crate', 12, 118, { base: 142 }); P.prop('plantPink', 64, 90);
        P.add(239, (g) => { draw(g, 'tableRound', 96, 204); draw(g, 'mug', 104, 212); draw(g, 'mug2', 115, 216); draw(g, 'bookG', 107, 222); });
        P.prop('stoolRed', 78, 222); P.prop('stool', 132, 222);
        P.prop('plantA', 10, 196); P.prop('crate', 14, 274, { base: 298 }); P.prop('barrel', 46, 276);
        P.anim(ANIM.brazier, 378, 228, 262, { always: true });
        P.light({ x: 394, y: 246, r: 64, color: [255, 140, 50], a: 0.32, flick: 1 });
        P.prop('bench', 404, 282, { base: 300 });
        P.prop('mug', 416, 285, { base: 301 }); P.prop('mug2', 428, 287, { base: 301 });
        P.prop('tableSm', 462, 244); P.prop('bottleG', 468, 240, { base: 274 }); P.prop('mug', 480, 245, { base: 274 });
        P.prop('plantB', 330, 270); P.prop('plantC', 206, 160); P.prop('plantPink', 492, 180);
        R.trab = [lugar(302, 118, 'Mesa de missões'), lugar(166, 74, 'Quadro de tarefas'), lugar(436, 142, 'Baús da guilda'), lugar(160, 236, 'Mesa de reunião')];
        R.desc = [lugar(366, 262, 'Recanto do braseiro'), lugar(430, 262, 'Recanto do braseiro'), lugar(452, 300, 'Banco do recanto')];
      },
    });

    room({
      id: 'tower', w: 384, h: 288, wall: 'stone', floor: 'floorStone', door: 192, pillars: [124, 252],
      ambient: [204, 196, 236], vignette: [120, 104, 170], beams: [42, 344],
      floorDeco(g) { draw(g, 'rugCross', 152, 186); },
      wallDeco(g) {
        draw(g, 'window', 28, 16); draw(g, 'bannerB', 68, 18); draw(g, 'tablet', 96, 22);
        draw(g, 'rune', 146, 24); draw(g, 'bannerG', 166, 18); draw(g, 'chalkTxt', 190, 16); draw(g, 'rune', 226, 24);
        draw(g, 'bannerR', 276, 18); draw(g, 'landscape', 296, 22); draw(g, 'window', 330, 16);
      },
      build(R) {
        const P = furnish(R);
        P.anim(ANIM.alch, 14, 46, 124);
        P.prop('flask', 8, 116, { base: 132 });
        P.light({ x: 54, y: 92, r: 44, color: [150, 255, 120], a: 0.18, flick: 0.5, on: lig });
        P.anim(ANIM.alch2, 150, 52, 116);
        P.light({ x: 186, y: 100, r: 36, color: [255, 120, 60], a: 0.18, flick: 1, on: lig });
        P.add(86, (g) => {
          draw(g, 'cabinetSh', 296, 62); draw(g, 'cabinetDo', 328, 62);
          draw(g, 'book', 300, 52); draw(g, 'bookG', 318, 51); draw(g, 'book', 332, 52); draw(g, 'bookG', 350, 51);
        });
        P.add(129, (g) => { draw(g, 'tableSm', 282, 100); draw(g, 'book', 286, 104); draw(g, 'quill', 304, 99); draw(g, 'paper', 298, 112); draw(g, 'candle', 290, 92); });
        P.light({ x: 296, y: 98, r: 30, color: [255, 190, 90], a: 0.2, flick: 1 });
        P.add(225, (g) => { draw(g, 'tableBlue', 60, 196); draw(g, 'rune', 64, 199); draw(g, 'flaskS', 82, 200); draw(g, 'candle', 86, 188); });
        P.light({ x: 78, y: 200, r: 34, color: [170, 140, 255], a: 0.2, flick: 0.6 });
        P.prop('tube', 14, 136); P.prop('tubeS', 28, 141); P.prop('jar', 40, 136);
        P.prop('wardrobe', 340, 176); P.prop('tube', 322, 216); P.prop('jar', 308, 220);
        P.prop('plantPink', 356, 100); P.prop('crate', 12, 252, { base: 276 });
        for (const [x, y] of [[146, 196], [232, 196], [146, 254], [232, 254]]) {
          P.prop('candle', x, y);
          P.light({ x: x + 6, y: y + 4, r: 18, color: [190, 150, 255], a: 0.16, flick: 1 });
        }
        R.trab = [lugar(108, 124, 'Mesa alquímica'), lugar(212, 116, 'Caldeirão'), lugar(268, 128, 'Mesa de leitura'), lugar(108, 224, 'Mesa de runas')];
        R.desc = [lugar(176, 236, 'Círculo de invocação'), lugar(210, 236, 'Círculo de invocação'), lugar(280, 250, 'Torre')];
      },
    });

    room({
      id: 'forge', w: 416, h: 288, wall: 'stone', floor: 'floorStone', door: 208, pillars: [112, 280],
      ambient: [232, 204, 192], vignette: [150, 104, 96], beams: [40],
      wallDeco(g) {
        draw(g, 'window', 26, 16); draw(g, 'bannerR', 134, 18); draw(g, 'chalkTxt', 208, 16); draw(g, 'bannerB', 250, 18);
        draw(g, 'sword', 300, 22); draw(g, 'shield', 334, 22); draw(g, 'sword', 352, 34); draw(g, 'shield', 384, 24);
      },
      build(R) {
        const P = furnish(R);
        P.add(106, (g, t) => drawFrame(g, ANIM.ironf, Math.floor(t * ANIM.ironf.fps * (cena.on ? 1.6 : 1)), 40, 42));
        P.light({ x: 64, y: 96, r: 64, color: [255, 120, 40], a: 0.3, flick: 1 });
        P.light({ x: 64, y: 96, r: 40, color: [255, 150, 60], a: 0.22, flick: 1, on: lig });
        P.prop('coalPile', 2, 98, { base: 122 });
        P.anim(ANIM.anvil, 150, 40, 117);
        P.light({ x: 170, y: 102, r: 36, color: [255, 200, 120], a: 0.2, flick: 1, on: lig });
        P.prop('vTrough', 168, 126);
        P.prop('wbBig', 306, 62);
        P.add(232, (g) => {
          draw(g, 'tableLong', 320, 206); draw(g, 'gear', 326, 208); draw(g, 'saw', 344, 214);
          draw(g, 'ingotA', 364, 210); draw(g, 'ingotB', 371, 211); draw(g, 'ingotC', 377, 210); draw(g, 'ingotD', 368, 216);
        });
        P.prop('crate', 14, 242, { base: 266 }); P.prop('crate', 22, 220, { base: 244 }); P.prop('barrel', 52, 250);
        P.prop('vBucket', 74, 258); P.prop('vCoal', 88, 250); P.prop('barrel', 386, 120); P.prop('vCrates', 372, 250, { base: 273 });
        R.trab = [lugar(226, 118, 'Bigorna'), lugar(102, 112, 'Fornalha de ferro'), lugar(294, 124, 'Bancada'), lugar(306, 232, 'Mesa de ferramentas')];
        R.desc = [lugar(150, 214, 'Forja'), lugar(190, 228, 'Forja'), lugar(240, 214, 'Forja')];
      },
    });

    const SAWLOG = { n: 4, out: 2 };
    room({
      id: 'sawmill', w: 416, h: 288, wall: 'log', floor: 'floorWood', door: 208, pillars: [100, 300],
      ambient: [228, 214, 200], vignette: [140, 112, 96], beams: [40, 376],
      wallDeco(g) {
        draw(g, 'window', 26, 16); draw(g, 'window', 362, 16);
        draw(g, 'saw', 70, 30); draw(g, 'chalkTxt', 160, 16); draw(g, 'chalk', 188, 16); draw(g, 'chalkTxt', 216, 16);
        draw(g, 'gear', 266, 24); draw(g, 'bannerG', 330, 18);
      },
      build(R) {
        const P = furnish(R);
        P.anim(ANIM.saw3, 150, 46, 124);
        P.light({ x: 214, y: 92, r: 40, color: [255, 220, 150], a: 0.16, flick: 0.4, on: lig });
        P.add(134, (g) => { for (let i = 0; i < SAWLOG.n; i++) draw(g, i % 2 ? 'vLog2' : 'vLog', 100 + (i % 2) * 4, 124 - Math.floor(i / 2) * 6 - (i % 2) * 2); });
        P.prop('vChips', 204, 128); P.prop('vChips', 232, 136, { flip: true });
        P.prop('crate', 330, 86, { base: 110 }); P.prop('crate', 362, 96, { base: 120 });
        P.add(146, (g) => { for (let i = 0; i < SAWLOG.out; i++) draw(g, 'plank', 360, 138 - i * 4); });
        P.prop('barrel', 20, 88); P.prop('barrel', 38, 96);
        P.add(262, (g) => { draw(g, 'wbWood', 40, 220); draw(g, 'saw', 52, 226); });
        P.prop('vLog', 20, 268, { base: 276 }); P.prop('vLog2', 26, 262, { base: 277 });
        P.prop('crate', 336, 238, { base: 262 }); P.prop('vCrates', 364, 252, { base: 275 });
        P.prop('vSack', 300, 254); P.prop('vBucket', 136, 258);
        R.trab = [lugar(276, 120, 'Serraria'), lugar(86, 136, 'Pilha de toras'), lugar(318, 130, 'Lotes prontos'), lugar(110, 262, 'Bancada')];
        R.desc = [lugar(180, 220, 'Serraria'), lugar(222, 232, 'Serraria'), lugar(262, 220, 'Serraria')];
      },
    });

    const PANTRY = { n: 2 };
    room({
      id: 'tavern', w: 512, h: 320, wall: 'plaster', floor: 'floorHerr', door: 256, pillars: [174],
      ambient: [232, 208, 204], vignette: [150, 110, 110], beams: [236],
      floorDeco(g) { draw(g, 'rugGreen', 232, 262); },
      wallDeco(g) {
        draw(g, 'bannerR', 150, 18); draw(g, 'window', 222, 16); draw(g, 'chalkTxt', 256, 16);
        draw(g, 'bear', 290, 20); draw(g, 'painting', 316, 24); draw(g, 'bannerG', 340, 18);
      },
      build(R) {
        const P = furnish(R);
        P.add(86, (g) => {
          draw(g, 'cabinetSh', 16, 62); draw(g, 'cabinetDo', 48, 62); draw(g, 'cabinetSh', 80, 62);
          for (const [k, x] of [['bottleG', 20], ['bottleP', 28], ['bottleO', 36], ['bottleG', 54], ['bottleP', 62], ['mug', 86], ['bottleO', 98], ['bottleG', 104]])
            draw(g, k, x, k === 'mug' ? 56 : 53);
        });
        P.prop('barrel', 116, 62); P.prop('barrel', 134, 64);
        P.add(130, (g) => {
          draw(g, 'tableLong', 24, 104); draw(g, 'tableLong', 88, 104);
          draw(g, 'mug', 40, 108); draw(g, 'mug2', 58, 110); draw(g, 'bottleO', 100, 105); draw(g, 'mug', 122, 109);
        });
        P.light({ x: 88, y: 100, r: 40, color: [255, 190, 100], a: 0.18, flick: 1 });
        for (const [k, x] of [['stoolRed', 40], ['stool', 76], ['stoolRed', 112]]) P.prop(k, x, 134);
        P.prop('sink', 290, 62);
        P.anim(ANIM.pan5, 356, 50, 97, { always: true, phase: 0.3 });
        P.prop('stoveA', 404, 24);
        P.anim(ANIM.pan4, 403, 38, 89, { always: true });
        P.prop('range', 452, 24);
        P.anim(ANIM.pan1, 450, 34, 89, { always: true, phase: 1.1 });
        P.anim(ANIM.pan3, 470, 40, 89, { always: true });
        P.anim(ANIM.cooker, 350, 100, 132, { always: true });
        P.anim(ANIM.pan3, 352, 88, 133, { always: true, phase: 0.7 });
        P.light({ x: 362, y: 128, r: 34, color: [255, 120, 50], a: 0.22, flick: 1 });
        P.light({ x: 470, y: 76, r: 40, color: [255, 140, 60], a: 0.18, flick: 1 });
        P.add(126, (g) => { draw(g, 'crate', 474, 102); for (let i = 0; i < PANTRY.n; i++) draw(g, i % 2 ? 'basketG' : 'basketT', 476 + (i % 2) * 14, 92 - Math.floor(i / 2) * 8); });
        const tables = [[80, 206], [190, 238], [330, 206], [420, 238]];
        const food = [['mug', 'bread'], ['steak', 'mug2'], ['chicken', 'mug'], ['bread', 'mug2']];
        tables.forEach(([x, y], i) => {
          P.add(y + 35, (g) => { draw(g, 'tableRound', x, y); draw(g, food[i][0], x + 6, y + 8); draw(g, food[i][1], x + 19, y + 13); });
          P.prop(i % 2 ? 'stool' : 'stoolRed', x + 9, y - 10, { base: y + 6 });
          P.light({ x: x + 16, y: y + 10, r: 26, color: [255, 190, 100], a: 0.12, flick: 1 });
        });
        P.anim(ANIM.brazier, 14, 266, 298, { always: true });
        P.light({ x: 30, y: 284, r: 56, color: [255, 140, 50], a: 0.3, flick: 1 });
        P.prop('plantA', 488, 282); P.prop('barrel', 210, 290); P.prop('barrel', 290, 290); P.prop('plantPink', 150, 66);
        R.trab = [lugar(72, 100, 'Balcão'), lugar(338, 130, 'Cozinha'), lugar(120, 100, 'Balcão'), lugar(462, 138, 'Despensa')];
        R.desc = [lugar(68, 236, 'Mesa do salão'), lugar(234, 268, 'Mesa do salão'), lugar(374, 236, 'Mesa do salão'), lugar(464, 268, 'Mesa do salão')];
      },
    });

    room({
      id: 'greenhouse', w: 352, h: 256, wall: 'plank', floor: 'floorWood', door: 176,
      ambient: [232, 240, 218], vignette: [150, 170, 140], beams: [40, 104, 168, 304],
      floorDeco(g) {
        for (const [y0, hh] of [[78, 40], [186, 40]]) {
          const F = IMG.floors;
          for (let y = y0; y < y0 + hh; y += 16)
            for (let x = 64; x < 240; x += 16) g.drawImage(F, 176 + ((x / 16 + y / 16) % 3) * 16, 158, 16, Math.min(16, y0 + hh - y), x, y, 16, Math.min(16, y0 + hh - y));
          g.fillStyle = '#3b2412'; g.fillRect(62, y0 - 2, 180, 2); g.fillRect(62, y0 + hh, 180, 3); g.fillRect(62, y0, 2, hh); g.fillRect(240, y0, 2, hh);
          g.fillStyle = '#7a4a26'; g.fillRect(62, y0 + hh, 180, 1);
        }
      },
      wallDeco(g) { for (const x of [26, 90, 154, 290]) draw(g, 'window', x, 16); draw(g, 'chalkTxt', 224, 16); draw(g, 'chalk', 252, 16); },
      build(R) {
        const P = furnish(R);
        for (const [k, x] of [['plantA', 262], ['plantB', 280], ['plantPink', 300], ['plantC', 318], ['plantB', 12], ['plantA', 30]])
          P.prop(k, x, 64 + (k === 'plantC' ? 6 : 0));
        P.add(209, (g) => { draw(g, 'tableSm', 276, 180); draw(g, 'seedBag', 280, 178); draw(g, 'seedBag2', 296, 180); draw(g, 'paper', 290, 192); });
        P.prop('vSack', 318, 228); P.prop('vSack', 300, 234); P.prop('vBucket', 322, 120);
        P.prop('vCrateCab', 14, 220, { base: 252 });
        for (const x of [40, 104, 168, 304]) P.light({ x, y: 80, r: 70, color: [210, 240, 255], a: 0.1, flick: 0 });
        R.trab = [lugar(264, 210, 'Sementeira'), lugar(60, 98, 'Canteiro norte'), lugar(60, 206, 'Canteiro sul'), lugar(60, 118, 'Canteiro norte')];
        R.desc = [lugar(140, 160, 'Estufa'), lugar(190, 160, 'Estufa'), lugar(290, 150, 'Estufa')];
      },
    });

    room({
      id: 'hut', w: 320, h: 224, wall: 'log', floor: 'floorWood', door: 160,
      ambient: [214, 214, 230], vignette: [110, 120, 160], beams: [38, 280],
      wallDeco(g) {
        draw(g, 'window', 24, 16);
        draw(g, 'chalkTxt', 118, 16); draw(g, 'chalk', 146, 16); draw(g, 'chalkTxt', 174, 16);
        draw(g, 'fish', 224, 22); draw(g, 'fish2', 236, 24); draw(g, 'fish', 248, 22);
        draw(g, 'window', 266, 16);
      },
      build(R) {
        const P = furnish(R);
        P.add(117, (g) => {
          draw(g, 'tableBlue', 52, 88);
          draw(g, 'paper', 56, 92); draw(g, 'paper2', 64, 94); draw(g, 'scroll', 60, 107); draw(g, 'book', 72, 98); draw(g, 'candle', 78, 80);
        });
        P.prop('chair2', 40, 92, { base: 114 });
        P.light({ x: 84, y: 88, r: 32, color: [255, 190, 90], a: 0.2, flick: 1 });
        P.prop('chestC', 266, 100); P.prop('barrel', 286, 94); P.prop('vBucket', 246, 106);
        P.prop('fish2', 249, 100, { base: 126 }); P.prop('crate', 262, 168, { base: 192 });
        P.prop('bench', 196, 190, { base: 208 });
        P.prop('vLantern', 14, 160, { base: 186 });
        P.light({ x: 22, y: 176, r: 34, color: [255, 200, 110], a: 0.22, flick: 0.6 });
        P.prop('plantC', 288, 186);
        P.add(64, (g) => { draw(g, 'rugGreen', 136, 150); });
        P.prop('vCrates', 24, 196, { base: 219 }); P.prop('vBarrel', 270, 132, { base: 155 });
        P.add(176, (g) => { draw(g, 'tableSm', 214, 146); draw(g, 'vLantern', 224, 128); draw(g, 'fish', 238, 150); draw(g, 'tablet', 220, 152); });
        P.light({ x: 232, y: 140, r: 30, color: [255, 200, 110], a: 0.2, flick: 0.6, on: lig });
        R.trab = [lugar(100, 116, 'Diário de bordo'), lugar(160, 76, 'Painel de alertas'), lugar(200, 168, 'Mesa de iscas e mapas'), lugar(130, 150, 'Cabana')];
        R.desc = [lugar(206, 206, 'Banco'), lugar(232, 206, 'Banco'), lugar(110, 196, 'Cabana')];
      },
    });

    // A mobília só guarda funções de desenho (nada é desenhado aqui): monta já, para os lugares existirem sem as imagens.
    for (const R of Object.values(ROOMS)) { R.build(R); R.props.sort((p, q) => p.y - q.y); }
    function prepararSala(R) { if (!R.bg) R.bg = buildRoomBg(R); }
    // Quadro do interior `id` (px de arte, R.w×R.h). `on`: alguém da casa trabalha; `notas`: papéis no quadro.
    function desenharInterior(id, t, on, notas) {
      const R = ROOMS[id];
      if (!R) return null;
      if (!R.tela) R.tela = makeCanvas(R.w, R.h);
      const g = R.tela.g;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.imageSmoothingEnabled = false;
      if (!prontoInt) { desenharInteriorSimples(g, R); return R.tela.c; }
      prepararSala(R);
      cena.on = !!on; cena.notas = notas || 0;
      g.drawImage(R.bg, 0, 0);
      for (const tc of R.torches) drawFrame(g, ANIM.flame, Math.floor(t * ANIM.flame.fps + tc.x), tc.x - 16, tc.y - 26);
      for (const p of R.props) p.draw(g, t);
      g.save();
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = `rgb(${R.ambient.join(',')})`;
      g.fillRect(0, 0, R.w, R.h);
      const vg = g.createRadialGradient(R.w / 2, R.h / 2, Math.min(R.w, R.h) * 0.38, R.w / 2, R.h / 2, Math.max(R.w, R.h) * 0.66);
      vg.addColorStop(0, 'rgba(255,255,255,1)');
      vg.addColorStop(1, `rgb(${R.vignette.join(',')})`);
      g.fillStyle = vg; g.fillRect(0, 0, R.w, R.h);
      g.restore();
      g.save();
      g.globalCompositeOperation = 'lighter';
      for (const L of R.lights) { if (L.on && !L.on()) continue; glow(g, L, t, 1); }
      for (const wx of R.beams) {
        g.fillStyle = 'rgba(160,200,255,0.05)';
        g.beginPath(); g.moveTo(wx - 12, 48); g.lineTo(wx + 12, 48); g.lineTo(wx + 34, 150); g.lineTo(wx + 4, 150); g.closePath(); g.fill();
      }
      g.restore();
      return R.tela.c;
    }
    // Sem as folhas do interior (carregando ou falhou): parede e piso em blocos de cor (marcador provisório).
    function desenharInteriorSimples(g, R) {
      const parede = { plaster: '#8a6a58', log: '#6b4a2e', stone: '#5a5a66', plank: '#7a5a3a' }[R.wall] || '#6b4a2e';
      g.fillStyle = '#1a100a'; g.fillRect(0, 0, R.w, R.h);
      g.fillStyle = parede; g.fillRect(7, WALL_Y, R.w - 14, FLOOR_Y - WALL_Y);
      g.fillStyle = R.floor === 'floorStone' ? '#4a4a52' : '#8a5a34'; g.fillRect(7, FLOOR_Y, R.w - 14, R.h - FLOOR_Y - 7);
      g.fillStyle = 'rgba(0,0,0,.25)';
      for (const l of [...R.trab, ...R.desc]) g.fillRect(l.x - 10, l.y - 4, 20, 6);
    }
    const sala = (id) => { const R = ROOMS[id]; return R ? { w: R.w, h: R.h, trab: R.trab, desc: R.desc } : null; };

    // Retângulo de uma casa em células do mundo (do telhado à base).
    function casa(id) {
      const B = BLD[id];
      if (!B) return null;
      const x = Math.floor(B.x / TS) + MX, y = Math.floor(B.y / TS) + MY;
      return { x, y, w: Math.round(B.w / TS), h: Math.ceil(B.base / TS) + MY - y };
    }
    // Desenho da casa em células do mundo (fracionário): do telhado à base da fachada, com o x da porta.
    // A camada de rótulos usa para nunca cobrir fachada nem porta.
    function caixa(id) {
      const B = BLD[id];
      if (!B) return null;
      const base = ARTE[id] ? B.y + B.h : B.base;
      return { x: B.x / TS + MX, y: B.y / TS + MY, w: B.w / TS, h: (base - B.y) / TS, porta: B.door.x / TS + MX, base: base / TS + MY };
    }
    // Soleira da porta em células do mundo (fracionária: o meio da porta, na linha em que ela encosta na trilha).
    function porta(id) {
      const B = BLD[id];
      return B ? { x: B.door.x / TS + MX, y: B.door.y / TS + MY } : null;
    }

    return {
      COLS, ROWS, TS, MX, MY, WW, WH, ENTRADA, ativo,
      carregar, grade, desenhar, casa, caixa, porta, carregarInteriores, desenharInterior, sala,
      get pronto() { return pronto; }, get falhou() { return falhou; },
      get prontoInt() { return prontoInt; }, get falhouInt() { return falhouInt; },
    };
  })();

  // ─────────────────────────────── interface em pixel art ───────────────────────────────
  // Placas, ícones, balões e avisos da vila: fonte bitmap 5×7 (com minúsculas, descendentes e acentos compostos)
  // e molduras 9-slice de madeira e pergaminho, tudo desenhado aqui (sem arquivo novo; o pack não traz fonte nem UI).
  // Cada peça é um <canvas> no tamanho da arte (1 px do canvas = 1 px de arte), ampliado pelo CSS por um fator
  // inteiro de pixels do aparelho (image-rendering: pixelated) e posto em pixel inteiro do aparelho: sem borrão.
  const PX = (() => {
    // Glifo: linhas de cima para baixo a partir do topo da maiúscula ('#' = aceso). As 7 primeiras vão até a base;
    // as seguintes são a descendente. A largura é a da primeira linha.
    const GLIFOS = {
      A: '.###.|#...#|#...#|#####|#...#|#...#|#...#', B: '####.|#...#|#...#|####.|#...#|#...#|####.',
      C: '.###.|#...#|#....|#....|#....|#...#|.###.', D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
      E: '#####|#....|#....|####.|#....|#....|#####', F: '#####|#....|#....|####.|#....|#....|#....',
      G: '.###.|#...#|#....|#.###|#...#|#...#|.####', H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
      I: '###|.#.|.#.|.#.|.#.|.#.|###', J: '..###|...#.|...#.|...#.|#..#.|#..#.|.##..',
      K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', L: '#....|#....|#....|#....|#....|#....|#####',
      M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', N: '#...#|##..#|#.#.#|#..##|#...#|#...#|#...#',
      O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.', P: '####.|#...#|#...#|####.|#....|#....|#....',
      Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#', R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
      S: '.####|#....|#....|.###.|....#|....#|####.', T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
      U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.', V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
      W: '#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#', X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
      Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..', Z: '#####|....#|...#.|..#..|.#...|#....|#####',
      a: '.....|.....|.###.|....#|.####|#...#|.####', b: '#....|#....|####.|#...#|#...#|#...#|####.',
      c: '....|....|.###|#...|#...|#...|.###', d: '....#|....#|.####|#...#|#...#|#...#|.####',
      e: '.....|.....|.###.|#...#|#####|#....|.###.', f: '..##|.#..|####|.#..|.#..|.#..|.#..',
      g: '.....|.....|.####|#...#|#...#|#...#|.####|....#|.###.', h: '#....|#....|####.|#...#|#...#|#...#|#...#',
      i: '#|.|#|#|#|#|#', 'ı': '.|.|#|#|#|#|#', j: '..#|...|..#|..#|..#|..#|..#|..#|##.',
      k: '#...|#...|#..#|#.#.|##..|#.#.|#..#', l: '#.|#.|#.|#.|#.|#.|.#',
      m: '.....|.....|##.#.|#.#.#|#.#.#|#.#.#|#.#.#', n: '....|....|###.|#..#|#..#|#..#|#..#',
      o: '.....|.....|.###.|#...#|#...#|#...#|.###.', p: '.....|.....|####.|#...#|#...#|#...#|####.|#....|#....',
      q: '.....|.....|.####|#...#|#...#|#...#|.####|....#|....#', r: '....|....|#.##|##..|#...|#...|#...',
      s: '....|....|.###|#...|.##.|...#|###.', t: '.#..|.#..|####|.#..|.#..|.#..|..##',
      u: '....|....|#..#|#..#|#..#|#..#|.###', v: '.....|.....|#...#|#...#|#...#|.#.#.|..#..',
      w: '.....|.....|#...#|#...#|#.#.#|#.#.#|.#.#.', x: '.....|.....|#...#|.#.#.|..#..|.#.#.|#...#',
      y: '....|....|#..#|#..#|#..#|#..#|.###|...#|###.', z: '....|....|####|...#|..#.|.#..|####',
      0: '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.', 1: '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
      2: '.###.|#...#|....#|...#.|..#..|.#...|#####', 3: '####.|....#|....#|.###.|....#|....#|####.',
      4: '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.', 5: '#####|#....|####.|....#|....#|#...#|.###.',
      6: '.###.|#....|#....|####.|#...#|#...#|.###.', 7: '#####|....#|...#.|..#..|.#...|.#...|.#...',
      8: '.###.|#...#|#...#|.###.|#...#|#...#|.###.', 9: '.###.|#...#|#...#|.####|....#|....#|.###.',
      ' ': '...', '.': '.|.|.|.|.|.|#', ',': '.|.|.|.|.|.|#|#', ':': '.|.|#|.|.|.|#', ';': '.|.|#|.|.|.|#|#',
      '!': '#|#|#|#|#|.|#', '?': '.###.|#...#|....#|...#.|..#..|.....|..#..', '-': '...|...|...|###|...|...|...',
      '_': '....|....|....|....|....|....|....|####', '+': '.....|..#..|..#..|#####|..#..|..#..|.....',
      '=': '....|....|####|....|####|....|....', '/': '....#|...#.|...#.|..#..|.#...|.#...|#....',
      '\\': '#....|.#...|.#...|..#..|...#.|...#.|....#', '(': '.#|#.|#.|#.|#.|#.|.#', ')': '#.|.#|.#|.#|.#|.#|#.',
      '[': '##|#.|#.|#.|#.|#.|##', ']': '##|.#|.#|.#|.#|.#|##', '{': '.##|.#.|.#.|#..|.#.|.#.|.##', '}': '##.|.#.|.#.|..#|.#.|.#.|##.',
      "'": '#|#|.|.|.|.|.', '"': '#.#|#.#|...|...|...|...|...', '`': '#.|.#|..|..|..|..|..',
      '#': '.#.#.|#####|.#.#.|.#.#.|#####|.#.#.|.....', '@': '.###.|#...#|#.###|#.#.#|#.##.|#....|.###.',
      '&': '.##..|#..#.|#.#..|.#...|#.#.#|#..#.|.##.#', '%': '##..#|##.#.|...#.|..#..|.#...|.#.##|#..##',
      '*': '.....|#.#.#|.###.|#####|.###.|#.#.#|.....', '<': '...#|..#.|.#..|#...|.#..|..#.|...#', '>': '#...|.#..|..#.|...#|..#.|.#..|#...',
      '|': '#|#|#|#|#|#|#', '~': '....|....|.#.#|#.#.|....|....|....', '^': '..#..|.#.#.|#...#|.....|.....|.....|.....',
      '$': '..#..|.####|#.#..|.###.|..#.#|####.|..#..', '·': '.|.|.|#|.|.|.', '…': '.....|.....|.....|.....|.....|.....|#.#.#',
      '→': '.....|..#..|...#.|#####|...#.|..#..|.....', '←': '.....|..#..|.#...|#####|.#...|..#..|.....',
      '°': '.#.|#.#|.#.|...|...|...|...', '✓': '.....|.....|....#|...#.|#.#..|.#...|.....', '✕': '.....|#...#|.#.#.|..#..|.#.#.|#...#|.....',
    };
    const TROCA = { 'º': 'o', 'ª': 'a', '–': '-', '—': '-', '“': '"', '”': '"', '„': '"', '‘': "'", '’': "'", '×': 'x', '•': '·', '\t': ' ', '\n': ' ' };
    // Acentos (marcas combinantes do NFD): em cima da letra (maiúscula: linhas 0–1; minúscula: 1–2) ou cedilha embaixo.
    const MARCAS = { '́': ['..#', '.#.'], '̀': ['#..', '.#.'], '̂': ['.#.', '#.#'], '̃': ['.#.#', '#.#.'], '̈': ['#.#'], '̧': ['.#', '#.'] };
    const TOPO = 2, ALT = 11; // a maiúscula começa na linha 2 da caixa; base na 8; descendente até a 10
    const G = {};
    for (const [ch, def] of Object.entries(GLIFOS)) {
      const ls = def.split('|'), px = [];
      ls.forEach((l, y) => { for (let x = 0; x < l.length; x++) if (l[x] === '#') px.push(x, y + TOPO); });
      G[ch] = { w: ls[0].length, px, desce: ls.length > 7 };
    }
    // Texto → glifos com as marcas de cada um (letra sem glifo vira '?').
    function glifos(txt) {
      const out = [];
      for (let ch of String(txt == null ? '' : txt).normalize('NFD')) {
        if (MARCAS[ch]) { if (out.length) out[out.length - 1].m.push(ch); continue; }
        if (/[̀-ͯ]/.test(ch)) continue;
        ch = TROCA[ch] || ch;
        out.push({ c: G[ch] ? ch : '?', m: [] });
      }
      for (const o of out) if (o.c === 'i' && o.m.some((m) => m !== '̧')) o.c = 'ı';
      return out;
    }
    const alta = (c) => /[A-Z0-9]/.test(c);
    // Medida: largura (1 px entre letras) e a faixa de linhas usada (sem acento em cima nem descendente, fica justa).
    function medir(txt) {
      const gs = glifos(txt);
      let w = 0, topo = TOPO, fim = TOPO + 6;
      gs.forEach((o, i) => {
        w += G[o.c].w + (i ? 1 : 0);
        if (G[o.c].desce) fim = TOPO + 8;
        for (const m of o.m) {
          if (m === '̧') fim = TOPO + 8;
          else topo = Math.min(topo, alta(o.c) ? TOPO - MARCAS[m].length : TOPO + 1 - MARCAS[m].length);
        }
      });
      if (!gs.length) fim = topo;
      return { w, topo, fim, alt: fim - topo + 1 };
    }
    // Corta com reticências para caber em `max` px.
    function cortar(txt, max) {
      txt = String(txt == null ? '' : txt).replace(/\s+/g, ' ').trim();
      if (!max || medir(txt).w <= max) return txt;
      let t = txt;
      while (t.length > 1 && medir(t.trimEnd() + '…').w > max) t = t.slice(0, -1);
      return t.trimEnd() + '…';
    }
    // Quebra em até `n` linhas de `max` px; a última leva reticências se sobrar texto.
    function quebrar(txt, max, n) {
      const pal = String(txt == null ? '' : txt).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      const ls = [];
      let cur = '';
      while (pal.length && ls.length < n) {
        const p = pal[0], tent = cur ? cur + ' ' + p : p;
        if (medir(tent).w <= max) { cur = tent; pal.shift(); continue; }
        if (!cur) { cur = cortar(p, max); pal.shift(); }
        ls.push(cur); cur = '';
      }
      if (cur && ls.length < n) ls.push(cur);
      if (pal.length && ls.length) ls[ls.length - 1] = cortar(ls[ls.length - 1] + ' ' + pal.join(' '), max);
      return ls.length ? ls : [''];
    }
    // Escreve com a linha 0 da caixa em `y` (use `y - medir().topo` para alinhar pelo topo usado).
    function escrever(g, txt, x, y, cor, sombra) {
      const gs = glifos(txt);
      const passo = (dx, dy, c) => {
        g.fillStyle = c;
        let cx = x + dx;
        for (const o of gs) {
          const gl = G[o.c];
          for (let i = 0; i < gl.px.length; i += 2) g.fillRect(cx + gl.px[i], y + dy + gl.px[i + 1], 1, 1);
          for (const m of o.m) {
            const r = MARCAS[m], mx = cx + Math.floor((gl.w - r[0].length) / 2);
            const my = m === '̧' ? TOPO + 7 : alta(o.c) ? TOPO - r.length : TOPO + 1 - r.length;
            r.forEach((l, j) => { for (let k = 0; k < l.length; k++) if (l[k] === '#') g.fillRect(mx + k, y + dy + my + j, 1, 1); });
          }
          cx += gl.w + 1;
        }
      };
      if (sombra) passo(0, 1, sombra);
      passo(0, 0, cor);
    }

    // Molduras 9-slice (fonte 9×9, cantos de 3): bordas e miolo repetidos em blocos de 3 px, sem esticar pixel.
    const FORMAS = {
      madeira: ['.kkkkkkk.', 'khhhhhhhk', 'khnlllndk', 'khllllldk', 'khllllldk', 'khllllldk', 'khnlllndk', 'kdddddddk', '.kkkkkkk.'],
      papel: ['.kkkkkkk.', 'kwwwwwwwk', 'kwpppppsk', 'kwpppppsk', 'kwpppppsk', 'kwpppppsk', 'kwpppppsk', 'ksssssssk', '.kkkkkkk.'],
    };
    const PALETAS = {
      madeira: { f: 'madeira', k: '#2a1a0f', h: '#c99057', l: '#a06a3a', d: '#6b4226', n: '#3a2416' },
      papel: { f: 'papel', k: '#1c120b', w: '#fff3d6', p: '#efdcb0', s: '#cdb07a' },
      espera: { f: 'papel', k: '#1c120b', w: '#fff0b0', p: '#f6d27a', s: '#d4a43c' },
      externa: { f: 'papel', k: '#1c120b', w: '#ffe6d0', p: '#f4c19a', s: '#d7905d' },
      erro: { f: 'papel', k: '#1c120b', w: '#ffe3dc', p: '#f2c4b8', s: '#cf8f84' },
      troca: { f: 'papel', k: '#1c120b', w: '#f2fbfd', p: '#d9eef3', s: '#a9d3dd' },
      compacta: { f: 'papel', k: '#1c120b', w: '#eef4fb', p: '#d3e1f0', s: '#a7bfd9' },
      ok: { f: 'papel', k: '#1c120b', w: '#effbe9', p: '#d4efc6', s: '#9fcf8a' },
    };
    const fontes = new Map();
    function fonte(pal) {
      if (fontes.has(pal)) return fontes.get(pal);
      const P = PALETAS[pal] || PALETAS.papel, F = FORMAS[P.f];
      const c = document.createElement('canvas');
      c.width = 9; c.height = 9;
      const g = c.getContext('2d');
      F.forEach((l, y) => { for (let x = 0; x < 9; x++) if (P[l[x]]) { g.fillStyle = P[l[x]]; g.fillRect(x, y, 1, 1); } });
      fontes.set(pal, c);
      return c;
    }
    function moldura(g, pal, x, y, w, h) {
      const S = fonte(pal);
      const bl = (sx, sy, sw, sh, dx, dy) => g.drawImage(S, sx, sy, sw, sh, dx, dy, sw, sh);
      for (let i = x + 3; i < x + w - 3; i += 3) {
        const tw = Math.min(3, x + w - 3 - i);
        bl(3, 0, tw, 3, i, y); bl(3, 6, tw, 3, i, y + h - 3);
        for (let j = y + 3; j < y + h - 3; j += 3) bl(3, 3, tw, Math.min(3, y + h - 3 - j), i, j);
      }
      for (let j = y + 3; j < y + h - 3; j += 3) { const th = Math.min(3, y + h - 3 - j); bl(0, 3, 3, th, x, j); bl(6, 3, 3, th, x + w - 3, j); }
      bl(0, 0, 3, 3, x, y); bl(6, 0, 3, 3, x + w - 3, y); bl(0, 6, 3, 3, x, y + h - 3); bl(6, 6, 3, 3, x + w - 3, y + h - 3);
    }
    // Ponta em degraus (7 px de boca, 3 de fundo) saindo do lado `lado` da moldura, centrada em `pos` ao longo dele.
    const PONTA = ['kfffffk', '.kfffk.', '..kfk..', '...k...'];
    const PONTA_FUNDO = 3;
    function ponta(g, pal, f, lado, pos) {
      const P = PALETAS[pal] || PALETAS.papel;
      const fill = P.f === 'madeira' ? (lado === 'cima' ? P.h : P.d) : lado === 'cima' || lado === 'esq' ? P.w : P.s;
      PONTA.forEach((l, d) => {
        for (let a = 0; a < 7; a++) {
          const ch = l[a];
          if (ch === '.') continue;
          const o = a - 3;
          let x, y;
          if (lado === 'baixo') { x = f.x + pos + o; y = f.y + f.h - 1 + d; }
          else if (lado === 'cima') { x = f.x + pos + o; y = f.y - d; }
          else if (lado === 'esq') { x = f.x - d; y = f.y + pos + o; }
          else { x = f.x + f.w - 1 + d; y = f.y + pos + o; }
          g.fillStyle = ch === 'k' ? P.k : fill;
          g.fillRect(x, y, 1, 1);
        }
      });
    }

    // Caixa com linhas de texto. spec: { pal, linhas: [{ t, cor, sombra, centro, marca }], padX, padY, gap, minW,
    // ponta: { lado, pos } (pos ao longo do lado, em px da moldura) }. Devolve o canvas e o retângulo da moldura.
    function caixa(spec) {
      const padX = spec.padX == null ? 3 : spec.padX, padY = spec.padY == null ? 2 : spec.padY, gap = spec.gap == null ? 2 : spec.gap;
      const ls = spec.linhas.map((l) => { const m = medir(l.t); return { ...l, m, alt: m.alt + (l.sombra ? 1 : 0) }; });
      const lw = (l) => l.m.w + (l.marca ? 5 : 0);
      const cw = Math.max(spec.minW || 0, ...ls.map(lw));
      const ch = ls.reduce((s, l, i) => s + l.alt + (i ? gap : 0), 0) + (spec.extraH || 0); // extraH: faixa livre embaixo (botões)
      const fw = Math.max(9, cw + 2 * (2 + padX)), fh = Math.max(9, ch + 2 * (2 + padY));
      const lado = spec.ponta && spec.ponta.lado;
      const f = { x: lado === 'esq' ? PONTA_FUNDO : 0, y: lado === 'cima' ? PONTA_FUNDO : 0, w: fw, h: fh };
      const c = document.createElement('canvas');
      c.width = fw + (lado === 'esq' || lado === 'dir' ? PONTA_FUNDO : 0);
      c.height = fh + (lado === 'cima' || lado === 'baixo' ? PONTA_FUNDO : 0);
      const g = c.getContext('2d');
      moldura(g, spec.pal, f.x, f.y, fw, fh);
      if (lado) {
        const comp = lado === 'cima' || lado === 'baixo' ? fw : fh;
        ponta(g, spec.pal, f, lado, Math.max(4, Math.min(comp - 5, Math.round(spec.ponta.pos))));
      }
      let y = f.y + 2 + padY;
      for (const l of ls) {
        let x = f.x + 2 + padX + (l.centro ? Math.floor((cw - lw(l)) / 2) : 0);
        if (l.marca) { const my = y + Math.floor(l.m.alt / 2) - 2; g.fillStyle = '#1c120b'; g.fillRect(x, my, 4, 4); g.fillStyle = l.marca; g.fillRect(x + 1, my + 1, 2, 2); x += 5; }
        escrever(g, l.t, x, y - l.m.topo, l.cor, l.sombra);
        y += l.alt + gap;
      }
      return { c, f };
    }
    // Só o texto, sem moldura (cabeçalhos do balão da casa).
    function texto(txt, cor, sombra, max) {
      const t = cortar(txt, max), m = medir(t);
      const c = document.createElement('canvas');
      c.width = Math.max(1, m.w); c.height = Math.max(1, m.alt + (sombra ? 1 : 0));
      escrever(c.getContext('2d'), t, 0, -m.topo, cor, sombra);
      return c;
    }
    // Ícone de estado (11×11): trabalhando "…", concluído ✓, erro ✕, aguardando você "!".
    const ICONES = {
      trab: { pal: 'papel', cor: '#3b2a1a', m: ['.....', '.....', '#.#.#', '.....', '.....'] },
      ok: { pal: 'ok', cor: '#1d7a36', m: ['....#', '...##', '#.##.', '###..', '.#...'] },
      erro: { pal: 'erro', cor: '#a3121c', m: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'] },
      espera: { pal: 'espera', cor: '#3a2306', m: ['..#..', '..#..', '..#..', '.....', '..#..'] },
    };
    function icone(k) {
      const I = ICONES[k] || ICONES.trab;
      const c = document.createElement('canvas');
      c.width = 11; c.height = 11;
      const g = c.getContext('2d');
      moldura(g, I.pal, 0, 0, 11, 11);
      g.fillStyle = I.cor;
      I.m.forEach((l, y) => { for (let x = 0; x < 5; x++) if (l[x] === '#') g.fillRect(3 + x, 3 + y, 1, 1); });
      return c;
    }
    return { medir, cortar, quebrar, escrever, moldura, caixa, texto, icone, PALETAS, PONTA_FUNDO };
  })();

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
  // Busca na web (WebSearch/WebFetch ou MCP de busca/leitura/navegação) leva ao ponto de pesquisa.
  const ehPesquisa = (n) => /^(websearch|webfetch)$/i.test(n) || /^mcp__.*(search|fetch|browse)/i.test(n);
  function infoFerramenta(nome, alvo) {
    if (!nome || typeof nome !== 'string') return { ferramenta: '', ferrSig: '', pesq: false };
    return { ferramenta: nome, ferrSig: nome + '|' + (typeof alvo === 'string' ? alvo : ''), pesq: ehPesquisa(nome) };
  }
  function chamar(fn, ...args) {
    try { return typeof fn === 'function' ? fn(...args) : undefined; } catch (e) { return undefined; }
  }
  // Pixel art: o canvas mede (arte × u) px de CSS; `pxPor` troca o canvas de um elemento; `alinhar` leva uma
  // posição do palco ao pixel inteiro do aparelho mais próximo.
  function pxTam(c) { c.style.width = c.width * px.u + 'px'; c.style.height = c.height * px.u + 'px'; return c; }
  function pxPor(el, c, cls) {
    const velho = el.querySelector(':scope > canvas.of-px' + (cls ? '.' + cls : ''));
    c.className = 'of-px' + (cls ? ' ' + cls : '');
    c.setAttribute('aria-hidden', 'true');
    pxTam(c);
    if (velho) velho.replaceWith(c); else el.appendChild(c);
    return c;
  }
  const alinharX = (v) => Math.round((v + palcoAbsX) * px.dpr) / px.dpr - palcoAbsX;
  const alinharY = (v) => Math.round((v + palcoAbsY) * px.dpr) / px.dpr - palcoAbsY;
  // Texto em pixel art num elemento: o canvas e, escondido, o texto (leitor de tela e textContent).
  function pxTexto(el, txt, cor, sombra, max) {
    txt = String(txt == null ? '' : txt);
    const assin = txt + '|' + cor + '|' + max;
    if (el._px === assin) return;
    el._px = assin;
    el.textContent = '';
    h('span', 'of-sr', el, txt);
    if (txt) pxPor(el, PX.texto(txt, cor, sombra, max));
  }

  // ─────────────────────────────── grade e A* ───────────────────────────────
  const caminhavel = new Uint8Array(C * R);
  const ehEstacao = new Uint8Array(C * R);
  const id = (x, y) => y * C + x;
  const pode = (x, y) => x >= 0 && y >= 0 && x < C && y < R && caminhavel[id(x, y)] === 1;

  function montarGrade() {
    caminhavel.fill(0);
    ehEstacao.fill(0);
    if (Vila.COLS !== C || Vila.ROWS !== R) console.warn('[office] grade diferente do mapa da vila', C, R, Vila.COLS, Vila.ROWS);
    caminhavel.set(Vila.grade().subarray(0, C * R));
    const marcar = (r, v) => {
      for (let y = r.y; y < r.y + (r.h || 1); y++) for (let x = r.x; x < r.x + (r.w || 1); x++) {
        if (x >= 0 && y >= 0 && x < C && y < R) caminhavel[id(x, y)] = v;
      }
    };
    for (const a of CONFIG.areas) for (const e of a.estacoes) {
      ehEstacao[id(e.x, e.y)] = 1;
      if (!pode(e.x, e.y)) console.warn('[office] estação em célula bloqueada', a.id, e.x, e.y);
    }
    marcar(CONFIG.balcao, 0);
    // Vagas da fila, pontos de pesquisa e o spot do balcão: o A* os evita de passagem e o `escolherSpot` não os usa.
    for (const p of [...CONFIG.fila, ...CONFIG.pesquisa, CONFIG.balcao.spot]) {
      ehEstacao[id(p.x, p.y)] = 1;
      if (!pode(p.x, p.y)) console.warn('[office] ponto de evento em célula bloqueada', p.x, p.y);
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
  // Modo escritório: id mostrado (ou null), estado do GET /escritorios/:id ({status, motivoPausa, execucao}) e marcadores.
  let escId = null, escInfo = null, escSeq = 0, camMarc = null, marcadores = {}, sondas = new Map();
  let demoIdx = 0, demoCiclo = 0, selecionado = null, cartaoAssin = '';
  let reduzido = false, atualizadoEm = null, usoDemo = null, conexaoOk = true;
  let filaSlots = [], saidos = new Set(); // vagas da fila (ator ou null) · convidados que já saíram (não recriar)
  let lugaresDescanso = [], lugarPorChave = new Map(), rotulosDebug = [], placas = [], rodapeAssin = '', cabAssin = '';
  // Topo útil dos rótulos (px do palco; pode usar a folga sob o cabeçalho), borda de cima da tela e dt do quadro.
  let limTopo = 0, limBorda = 0, dtQuadro = 0;
  // Rótulos em pixel art: fator inteiro (k px do aparelho por px de arte; u = o mesmo em px de CSS), canto do palco
  // na tela (para cair em pixel inteiro), obstáculos fixos (casas e placas, em px do palco), quem está sob o mouse.
  let px = { dpr: 1, k: 1, u: 1 }, palcoAbsX = 0, palcoAbsY = 0, obstCasas = [], obstPlacas = [], hoverId = null, rotOcultos = false;
  let avisosAssin = '', avisoEstado = new Map(), avisosDebug = [];
  let tvPop = null, tvAberta = false, tvAnim = null, tvAssin = '', tvLinhas = new Map(), timeDescs = [];
  const FAIXA_PLACAS = 26; // folga entre o cabeçalho e o mapa (balões do alto do mapa podem subir nela)

  function montarEstacoes() {
    estacoes = [];
    for (const a of CONFIG.areas) a.porta = a.vila ? Vila.porta(a.vila) : null;
    for (const a of CONFIG.areas) for (const e of a.estacoes) {
      estacoes.push({ x: e.x, y: e.y, funcao: e.funcao || a.funcao, area: a, destaque: !!e.destaque, ator: null, tela: null, e: '' });
    }
    const desc = CONFIG.areas.find((a) => a.descanso);
    // Lugares de descanso FIXOS: varredura linha a linha da clareira, escolha gulosa mantendo distância (Chebyshev) >= 3,
    // depois >= 2 e por fim o que sobrar. Mesmo mapa = mesma lista, sempre.
    const cand = [];
    if (desc) {
      for (let y = desc.y; y < desc.y + desc.h; y++) for (let x = desc.x; x < desc.x + desc.w; x++) {
        if (pode(x, y) && !ehEstacao[id(x, y)]) cand.push({ x, y });
      }
    }
    lugaresDescanso = [];
    const dist = (p, q) => Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y));
    for (const minimo of [3, 2, 0]) {
      for (const c of cand) {
        if (lugaresDescanso.includes(c)) continue;
        if (minimo && lugaresDescanso.some((l) => dist(l, c) < minimo)) continue;
        lugaresDescanso.push(c);
      }
    }
  }

  // Casa da célula: a de cujo retângulo ela faz parte (a fogueira) ou a da estação mais perto (até 3 células).
  function areaDaCelula(x, y) {
    for (const a of CONFIG.areas) if (x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h) return a;
    let melhor = null, md = 4;
    for (const e of estacoes) {
      const d = Math.max(Math.abs(e.x - x), Math.abs(e.y - y));
      if (d < md) { md = d; melhor = e.area; }
    }
    return melhor;
  }

  // ─────────────────────────────── mapa (canvas da vila) ───────────────────────────────
  // O palco tem um <canvas> com o mundo inteiro da vila, redesenhado a CONFIG.vila.fps (água, fogo, fumaça).
  // Enquanto as imagens carregam, ou se falharem, o mesmo mapa sai em blocos de cor (Vila.desenhar cuida disso).
  let tela = null, telaCtx = null, mapaQ = -1;
  function criarMapa() {
    tela = h('canvas', 'of-vila', palco);
    tela.setAttribute('aria-hidden', 'true');
    telaCtx = tela.getContext('2d');
    mapaQ = -1;
    const alvo = palco;
    Vila.carregar(CONFIG.vila.base).then(() => { if (palco === alvo) desenharMapa(true); });
  }

  function dimensionarMapa() {
    if (!tela) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(palcoW * dpr)), hh = Math.max(1, Math.round(palcoH * dpr));
    if (tela.width !== w || tela.height !== hh) { tela.width = w; tela.height = hh; }
  }

  // Casas com atividade agora (estado real): a forja, a torre e a serraria acendem; papel no mural com fila.
  function acenderCasas() {
    const at = (f, casa) => atores.some((a) => !a.saindo && a.estado === 'trabalhando' && naEstacao(a) && (f ? a.funcao === f : a.estacao.area.vila === casa));
    Vila.ativo.forja = at('backend');
    Vila.ativo.torre = at('pesquisador') || atores.some((a) => a.pt && a.pt.tipo === 'pesq' && !a.saindo);
    Vila.ativo.serraria = at(null, 'sawmill');
    Vila.ativo.mural = atores.some((a) => a.fila >= 0 && !a.saindo);
  }

  function desenharMapa(forcar) {
    if (!telaCtx || !tela.width) return;
    // Movimento reduzido: o mapa fica parado (só redesenha quando muda de tamanho ou as imagens chegam).
    const q = reduzido ? 0 : Math.floor((relogio / 1000) * CONFIG.vila.fps);
    if (!forcar && q === mapaQ) return;
    mapaQ = q;
    acenderCasas();
    const mundo = Vila.desenhar(reduzido ? 0 : relogio / 1000);
    const g = telaCtx, k = tela.width / mundo.width;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.imageSmoothingEnabled = k < 1; // reduzindo, suaviza; ampliando, pixel nítido
    if (k < 1) g.imageSmoothingQuality = 'high';
    g.drawImage(mundo, 0, 0, tela.width, tela.height);
    tela.dataset.mapa = Vila.pronto ? 'vila' : Vila.falhou ? 'simples' : 'carregando';
  }

  // Posto de trabalho: um brilho no chão, diante da casa, que mostra o estado de quem está nele (data-e).
  function criarPostos() {
    const cam = h('div', 'of-camada of-postos', palco);
    for (const e of estacoes) {
      e.tela = h('i', 'of-posto' + (e.destaque ? ' of-posto-mestre' : ''), cam);
      e.tela.style.setProperty('--cor', (CONFIG.funcoes[e.funcao] || CONFIG.funcoes.auxiliar).cor);
      e.tela.setAttribute('data-e', 'apagada');
      pos(e.tela, e.x, e.y, 1, 1);
      e.e = '';
    }
  }

  // ─────────────────────────────── balão da casa (interior) ───────────────────────────────
  // Mouse parado sobre uma casa por CONFIG.casaBalao.esperaMs abre um balão preso a ela, com o interior e quem
  // trabalha lá (estado ao vivo); sair da casa fecha. No toque: tocar na casa abre, tocar fora fecha. O balão só
  // mostra: não recebe clique, e o clique na casa segue como antes. O interior só é desenhado com o balão aberto.
  let bc = null, bcPend = null, bcTimer = 0, bcX = 0, bcY = 0, bcDesenhos = 0, bcToqueIni = null;

  function casaEm(px, py) {
    const x = px / cel, y = py / cel;
    for (const a of CONFIG.areas) if (a.vila && x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h) return a;
    return null;
  }
  const noPalco = (ev) => { const r = palco.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  function cancelarEspera() { if (bcTimer) clearTimeout(bcTimer); bcTimer = 0; bcPend = null; }

  function aoMoverCasa(ev) {
    if (ev.pointerType && ev.pointerType !== 'mouse') return;
    if (pausado || !palco) return;
    // Sobre um robô, ícone ou placa, quem responde é o balão do agente (ou a placa): o interior não abre.
    if (ev.target && ev.target.closest && ev.target.closest('.of-ator, .of-icone, .of-placa')) { cancelarEspera(); return; }
    const p = noPalco(ev), a = casaEm(p.x, p.y);
    if (bc && bc.area !== a) fecharCasa();
    if (!a || (bc && bc.area === a)) { if (!a) cancelarEspera(); return; }
    // Espera o mouse parar: mudou de casa ou andou mais de 6 px, o prazo recomeça (passar direto não abre).
    if (bcPend === a && Math.hypot(p.x - bcX, p.y - bcY) <= 6) return;
    cancelarEspera();
    bcPend = a; bcX = p.x; bcY = p.y;
    bcTimer = setTimeout(() => { bcTimer = 0; const alvo = bcPend; bcPend = null; if (alvo && !pausado && palco) abrirCasa(alvo, false); }, CONFIG.casaBalao.esperaMs);
  }
  function aoSairPalco(ev) {
    if (ev.pointerType && ev.pointerType !== 'mouse') return;
    cancelarEspera();
    if (bc && !bc.toque) fecharCasa();
  }
  // Toque: só conta se o dedo quase não andou (arrastar não abre); robô, crachá e botões têm o seu toque.
  function aoTocarIni(ev) {
    bcToqueIni = ev.pointerType && ev.pointerType !== 'mouse' ? { x: ev.clientX, y: ev.clientY } : null;
  }
  function aoTocarFim(ev) {
    const ini = bcToqueIni;
    bcToqueIni = null;
    if (!ini || pausado || !palco) return;
    if (Math.hypot(ev.clientX - ini.x, ev.clientY - ini.y) > 10) return;
    if (ev.target.closest && ev.target.closest('.of-ator, .of-icone, .of-placa, .of-tv, button')) return;
    const p = noPalco(ev), a = casaEm(p.x, p.y);
    if (a && !(bc && bc.area === a)) abrirCasa(a, true);
    else if (!a) fecharCasa();
  }

  function criarBalaoCasa() {
    const el = h('div', 'of-casa', palco);
    el.setAttribute('role', 'tooltip');
    const caixa = h('div', 'of-casa-caixa', el); // moldura (cantos em degrau); o rabicho fica fora dela
    const cab = h('div', 'of-casa-cab', caixa);
    const nome = h('b', '', cab, '');
    const func = h('small', '', cab, '');
    const cena = h('div', 'of-casa-cena', caixa);
    const tl = h('canvas', 'of-casa-tela', cena);
    const gente = h('div', 'of-casa-gente', cena);
    const vazia = h('span', 'of-casa-vazia', cena);
    pxTexto(vazia, 'Ninguém aqui agora', '#e9d6a6', '#120b07', 200);
    h('i', 'of-casa-ponta', el);
    return { el, nome, func, cena, tl, ctx: tl.getContext('2d'), gente, vazia, area: null, toque: false, q: -1, assin: '', k: 1, sala: null };
  }

  function abrirCasa(area, toque) {
    cancelarEspera();
    if (!palco) return;
    if (bc && bc.area !== area) fecharCasa();
    if (!bc) bc = criarBalaoCasa();
    const b = bc;
    b.area = area; b.toque = !!toque; b.q = -1; b.assin = '';
    b.sala = Vila.sala(area.vila);
    pxTexto(b.nome, area.casa || area.nome, '#3b2412', null, 120);
    pxTexto(b.func, area.funcao ? CONFIG.funcoes[area.funcao].nome + ' · ' + CONFIG.funcoes[area.funcao].papel : area.nome, '#6b4a2e', null, 170);
    b.el.style.setProperty('--cor', area.funcao ? CONFIG.funcoes[area.funcao].cor : '#a3a3a3');
    b.el.dataset.casa = area.vila;
    medirCasa();
    b.el.classList.add('of-vis');
    desenharCasa(true);
    // Primeiro balão: carrega as folhas do interior; até lá (ou se falharem), parede e piso em blocos de cor.
    if (!Vila.prontoInt) Vila.carregarInteriores(CONFIG.vila.base).then(() => { if (bc === b && b.area === area) desenharCasa(true); });
  }

  function fecharCasa() {
    cancelarEspera();
    if (!bc) return;
    bc.el.classList.remove('of-vis');
    bc.area = null;
    bc.gente.textContent = '';
    bc.assin = '';
  }

  // Tamanho da cena (cabe no palco com folga) e posição do balão: em cima da casa; sem espaço, ao lado e por fim
  // embaixo. O rabicho aponta para o meio da casa. Nunca passa da borda do palco.
  function medirCasa() {
    const b = bc;
    if (!b || !b.area || !b.sala) return;
    const s = b.sala, a = b.area;
    const k = Math.max(0.2, Math.min(CONFIG.casaBalao.largura / s.w, (palcoW - 28) / s.w, (palcoH * 0.62) / s.h, 1));
    b.k = k;
    const cw = Math.round(s.w * k), chh = Math.round(s.h * k);
    b.cena.style.width = cw + 'px'; b.cena.style.height = chh + 'px';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const tw = Math.max(1, Math.round(cw * dpr)), th = Math.max(1, Math.round(chh * dpr));
    if (b.tl.width !== tw || b.tl.height !== th) { b.tl.width = tw; b.tl.height = th; b.q = -1; }
    b.el.style.setProperty('--rs', Math.max(18, Math.round(44 * k)) + 'px');
    const W = b.el.offsetWidth, H = b.el.offsetHeight, P = 12, M = 2;
    const hx = a.x * cel, hy = a.y * cel, hw = a.w * cel, hh = a.h * cel;
    const cx = hx + hw / 2, cy = hy + hh / 2;
    const prender = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const xs = prender(cx - W / 2, M, palcoW - W - M), ys = prender(cy - H / 2, M, palcoH - H - M);
    const opc = [
      { lado: 'cima', x: xs, y: hy - H - P, ok: hy - H - P >= M },
      { lado: 'dir', x: hx + hw + P, y: ys, ok: hx + hw + P + W <= palcoW - M },
      { lado: 'esq', x: hx - W - P, y: ys, ok: hx - W - P >= M },
      { lado: 'baixo', x: xs, y: hy + hh + P, ok: hy + hh + P + H <= palcoH - M },
    ];
    // Nenhum lado livre (palco pequeno): o lado com mais espaço, empurrado para dentro (cobre parte da casa).
    const livre = { cima: hy, baixo: palcoH - hy - hh, esq: hx, dir: palcoW - hx - hw };
    const o = opc.find((q) => q.ok) || opc.slice().sort((p, q) => livre[q.lado] - livre[p.lado])[0];
    const x = Math.round(prender(o.x, M, palcoW - W - M)), y = Math.round(prender(o.y, M, palcoH - H - M));
    b.el.style.transform = `translate3d(${x}px,${y}px,0)`;
    b.el.dataset.lado = o.lado;
    if (o.lado === 'cima' || o.lado === 'baixo') b.el.style.setProperty('--px', Math.round(prender(cx - x, 16, W - 16)) + 'px');
    else b.el.style.setProperty('--py', Math.round(prender(cy - y, 16, H - 16)) + 'px');
    b.x = x; b.y = y; b.w = W; b.h = H;
  }

  // Quem é da casa: os agentes com estação nela. Estado ao vivo (o mesmo que o robô do mapa mostra).
  function genteDaCasa(area) {
    return atores.filter((a) => !a.saindo && a.estacao && a.estacao.area === area)
      .sort((p, q) => area.estacoes.findIndex((e) => e.x === p.estacao.x && e.y === p.estacao.y) - area.estacoes.findIndex((e) => e.x === q.estacao.x && e.y === q.estacao.y));
  }
  function estadoNaCasa(a) {
    if (a.dormindo) return { e: 'dormindo', t: 'Dormindo' };
    if (a.estado === 'erro') return { e: 'erro', t: T.estados.erro };
    if (a.estado === 'aguardando') return { e: 'aguardando', t: T.estados.aguardando };
    if (a.estado === 'trabalhando') return a.compactando ? { e: 'pensando', t: T.compactando } : a.ferramenta ? { e: 'trabalhando', t: T.estados.trabalhando } : { e: 'pensando', t: 'Pensando' };
    return { e: 'ocioso', t: 'Descansando' };
  }

  function desenharCasa(forcar) {
    const b = bc;
    if (!b || !b.area) return;
    const a = b.area, s = b.sala;
    const gente = genteDaCasa(a);
    // Agentes: os que trabalham ficam no posto da casa (na ordem das estações); os à toa, no canto de descanso.
    const assin = gente.map((x) => { const st = estadoNaCasa(x); return x.id + ':' + st.e + ':' + x.nome; }).join('|') + '|' + b.k;
    if (assin !== b.assin) {
      b.assin = assin;
      b.gente.textContent = '';
      let iT = 0, iD = 0;
      for (const x of gente) {
        const st = estadoNaCasa(x);
        const fora = st.e === 'ocioso' || st.e === 'dormindo';
        const l = fora ? s.desc[iD++ % s.desc.length] : s.trab[iT++ % s.trab.length];
        const el = h('div', 'of-casa-ag', b.gente);
        el.dataset.e = st.e;
        el.dataset.id = x.id;
        el.style.left = Math.round(l.x * b.k) + 'px';
        el.style.top = Math.round(l.y * b.k) + 'px';
        const img = h('img', 'of-casa-robo', el);
        img.src = CONFIG.robos.parado; img.alt = ''; img.draggable = false;
        const et = h('span', 'of-casa-et', el);
        h('i', '', et);
        pxTexto(h('b', '', et), x.nome, '#f4ead2', '#120b07', 70);
        pxTexto(h('small', '', et), st.t, '#d9c7a0', '#120b07', 70);
        el.title = x.nome + ' · ' + st.t + ' · ' + l.rot;
      }
      b.vazia.hidden = gente.length > 0;
    }
    const q = reduzido ? 0 : Math.floor((relogio / 1000) * CONFIG.casaBalao.fps);
    if (!forcar && q === b.q) return;
    b.q = q;
    const on = gente.some((x) => x.estado === 'trabalhando');
    const notas = a.vila === 'guild' ? atores.filter((x) => x.fila >= 0 && !x.saindo).length : 0;
    const quadroInt = Vila.desenharInterior(a.vila, reduzido ? 0 : relogio / 1000, on, notas);
    if (!quadroInt) return;
    bcDesenhos++;
    const g = b.ctx, k = b.tl.width / quadroInt.width;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.imageSmoothingEnabled = k < 1;
    if (k < 1) g.imageSmoothingQuality = 'high';
    g.drawImage(quadroInt, 0, 0, b.tl.width, b.tl.height);
    b.el.dataset.int = Vila.prontoInt ? 'vila' : Vila.falhouInt ? 'simples' : 'carregando';
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
    criarMapa();
    criarPostos();
    criarMarcadores();
    const rotAreas = h('div', 'of-camada of-areas', palco);
    // Placa de madeira junto à porta, só com o nome do lugar ("Forja"); no hover, a função ("Backend") numa 2ª linha.
    // A posição (em px do palco, sem cobrir fachada nem porta) sai no layout().
    placas = [];
    const placa = (a, lugar, func, cor, cls) => {
      const r = h('div', 'of-area-rot of-placa' + (cls ? ' ' + cls : ''), rotAreas);
      if (a) r.dataset.area = a.id;
      h('span', 'of-sr', r, func ? lugar + ' · ' + func : lugar);
      const tinta = { cor: '#fbecc8', sombra: '#4a2a14' };
      const cn = pxPor(r, PX.caixa({ pal: 'madeira', linhas: [{ t: lugar, ...tinta }], padX: 2, padY: 1 }).c, 'of-px-n');
      if (func) pxPor(r, PX.caixa({ pal: 'madeira', linhas: [{ t: lugar, ...tinta }, { t: func, cor: '#f1d9a8', sombra: '#4a2a14', marca: cor }], padX: 2, padY: 1, gap: 2 }).c, 'of-px-h');
      placas.push({ el: r, a, cn, id: a ? a.id : 'entrada', x: 0, y: 0, w: 0, h: 0 });
    };
    for (const a of CONFIG.areas) {
      const cor = a.funcao ? CONFIG.funcoes[a.funcao].cor : '#a3a3a3';
      if (a.vila) placa(a, a.casa || a.nome, a.nome, cor);
      else placa(a, a.nome, a.casa, cor);
    }
    placa(null, T.entrada, '', '', 'of-entrada');

    // Mural de missões (o "painel do time"): área clicável sobre o desenho, abaixo dos robôs.
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
    palco.addEventListener('click', (ev) => { if (ev.target === palco || ev.target.closest('.of-vila')) selecionar(null); });
    palco.addEventListener('pointermove', aoMoverCasa);
    palco.addEventListener('pointerleave', aoSairPalco);
    palco.addEventListener('pointerdown', aoTocarIni);
    palco.addEventListener('pointerup', aoTocarFim);
    bc = null;

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

    // Pedidos de permissão: fila no canto, fora do mapa (o agente só mostra o "!" pulsando).
    ui.avisos = h('div', 'of-avisos', raiz);
    ui.avisos.setAttribute('role', 'region');
    ui.avisos.setAttribute('aria-label', T.rot.pedidos);
    ui.avisos.setAttribute('aria-live', 'polite');

    rodape = h('div', 'of-rodape', raiz);
    ui.modoPonto = h('i', 'of-r-ponto', rodape);
    ui.modo = h('span', 'of-r-modo', rodape, '');
    ui.contagem = h('span', 'of-r-cont', rodape, '');
    h('span', 'of-espaco', rodape);
    ui.dica = h('button', 'of-r-dica', rodape, T.rot.tecla);
    ui.dica.type = 'button';
    ui.dica.addEventListener('click', () => alternarRotulos());
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
    // Robô com ~2,8 peças de altura (as casas têm de 6 a 10 de largura).
    S = Math.max(18, Math.min(64, Math.round(cel * 2.8)));
    palco.style.setProperty('--of-s', S + 'px');
    cartao.style.top = th + 10 + 'px';
    palco.style.setProperty('--of-cel', cel + 'px');
    palco.classList.toggle('of-compacto', cel < 9);
    // Pixel art: k px do aparelho por px de arte (inteiro), u = o mesmo em px de CSS.
    const dpr = window.devicePixelRatio || 1;
    const k = Math.max(1, Math.round(dpr * CONFIG.rotulos.escala));
    if (k !== px.k || dpr !== px.dpr) { px = { dpr, k, u: k / dpr }; for (const c of raiz.querySelectorAll('canvas.of-px')) pxTam(c); avisosAssin = ''; }
    raiz.style.setProperty('--of-u', px.u + 'px');
    const rp = palco.getBoundingClientRect();
    palcoAbsX = rp.left; palcoAbsY = rp.top;
    posicionarPlacas();
    for (const a of atores) { a.ult = {}; a.posI = -1; a.posB = -1; a.balDes = ''; }
    dimensionarMapa();
    desenharMapa(true);
    if (bc && bc.area) { medirCasa(); desenharCasa(true); }
    if (tvAberta) posicionarTV();
    posicionarAvisos();
  }

  // Casas (do telhado à base) e placas em px do palco: obstáculos dos rótulos. A placa fica na trilha, ao lado
  // da porta (à esquerda; sem espaço, à direita), logo abaixo da base: nunca sobre a fachada ou a porta.
  function posicionarPlacas() {
    obstCasas = [];
    for (const a of CONFIG.areas) {
      const c = a.vila ? Vila.caixa(a.vila) : null;
      if (c) obstCasas.push({ id: a.vila, x: c.x * cel, y: c.y * cel, w: c.w * cel, h: c.h * cel, porta: c.porta * cel, base: (c.y + c.h) * cel });
    }
    obstPlacas = [];
    // Onde os robôs param (estações): a placa evita, para nenhum robô nem ícone ficar em cima dela.
    const postos = [];
    for (const a of CONFIG.areas) for (const e of a.estacoes) {
      const pes = (e.y + 0.82) * cel;
      postos.push({ x: (e.x + 0.5) * cel - S * 0.35, y: pes - S * 0.95, w: S * 0.7, h: S * 0.95 + 11 * px.u + 2 * px.u });
    }
    for (const p of placas) {
      const w = p.cn.width * px.u, hh = p.cn.height * px.u;
      let x, y, lado = 'dir';
      const casa = p.a && p.a.vila ? obstCasas.find((o) => o.id === p.a.vila) : null;
      if (casa) {
        // Na trilha, logo abaixo da base, ao lado da porta (a porta e quem está na soleira ficam livres);
        // se uma estação ocupa o lugar, um pouco mais para o lado.
        y = casa.base + px.u;
        const op = [];
        for (const d of [1.15, 1.8, 2.6, 3.4, 4.2, 5]) op.push({ x: casa.porta - d * cel - w, lado: 'esq' }, { x: casa.porta + d * cel, lado: 'dir' });
        const dentro = (o) => o.x >= 2 && o.x + w <= palcoW - 2;
        const bate = (o, ls) => ls.some((q) => sobre({ x: o.x, y, w, h: hh }, q));
        const o = op.find((q) => dentro(q) && !bate(q, obstCasas) && !bate(q, obstPlacas) && !bate(q, postos))
          || op.find((q) => dentro(q) && !bate(q, obstCasas) && !bate(q, obstPlacas)) || op[0];
        x = o.x; lado = o.lado;
      } else if (p.a) { // fogueira: no canto de cima do lugar
        x = (p.a.x + 0.3) * cel; y = p.a.y * cel - hh - 0.12 * cel;
      } else { // entrada: acima da ponta oeste da estrada
        x = (CONFIG.entrada.x + 1.1) * cel; y = (CONFIG.entrada.y - 0.4) * cel - hh;
      }
      x = alinharX(Math.max(2, Math.min(palcoW - w - 2, x))); y = alinharY(Math.max(2, Math.min(palcoH - hh - 2, y)));
      Object.assign(p, { x, y, w, h: hh });
      p.el.dataset.lado = lado;
      p.el.style.transform = `translate3d(${x}px,${y}px,0)`;
      p.el.style.width = w + 'px'; p.el.style.height = hh + 'px';
      obstPlacas.push({ id: p.id, x, y, w, h: hh });
    }
  }

  // Fila de pedidos: no canto de baixo à direita, fora do mapa quando a margem cabe (senão sobre a floresta da borda).
  function posicionarAvisos() {
    if (!ui.avisos || !raiz) return;
    const W = raiz.clientWidth, cw = CONFIG.rotulos.avisoLargura * px.u, hh = ui.avisos.offsetHeight;
    const rr = raiz.getBoundingClientRect();
    const fora = W - (palcoX + palcoW) >= cw + 16;
    const x = fora ? palcoX + palcoW + 8 : W - cw - 10;
    const y = palcoY + palcoH - hh - (fora ? 0 : 6);
    const al = (v, b) => Math.round((v + b) * px.dpr) / px.dpr - b;
    ui.avisos.style.width = cw + 'px';
    ui.avisos.style.transform = `translate3d(${al(x, rr.left)}px,${al(y, rr.top)}px,0)`;
    ui.avisos.dataset.fora = fora ? '1' : '0';
  }

  // Itens da fila: um por agente aguardando. Subagente que pede leva o pedido da sessão (o Mestre não repete).
  function itensAvisos() {
    const vivos = atores.filter((a) => !a.saindo && a.estado === 'aguardando');
    const comSub = new Set(vivos.filter((a) => a.origem === 'subagente').map((a) => a.sessaoId));
    const permDe = (sid) => { const d = atores.find((x) => x.sessaoId === sid && x.perm); return d ? d.perm : null; };
    const out = [], vistos = new Set();
    for (const a of vivos) {
      if (a.origem === 'sessao' && comSub.has(a.sessaoId)) continue;
      const perm = a.perm || (a.origem === 'subagente' ? permDe(a.sessaoId) : null);
      if (perm && vistos.has(perm.id)) continue;
      if (perm) vistos.add(perm.id);
      let acao = '';
      if (modo === 'demo') acao = 'decidir';
      else if (perm && perm.id && perm.tipo === 'ferramenta' && api && typeof api.responderPermissao === 'function') acao = 'decidir';
      else if (a.sessaoId && api && typeof api.abrirSessao === 'function') acao = 'abrir';
      const pede = perm && perm.tipo === 'pergunta' ? T.rot.pergunta : perm && perm.tipo === 'plano' ? T.rot.plano : T.rot.pede;
      out.push({ chave: a.id + '|' + (perm ? perm.id : a.espera), a, perm, acao, pede, det: detalhePedido(a, perm) });
    }
    return out;
  }
  // "Bash · node servidor.mjs": ferramenta e o resumo do pedido (ou o texto da espera, sem o "Permissão:"/"Aprovar").
  function detalhePedido(a, perm) {
    if (perm) {
      const r = String(perm.resumo || '').trim(), f = String(perm.ferramenta || '').trim();
      if (perm.tipo !== 'ferramenta' || !f || r.toLowerCase().startsWith(f.toLowerCase())) return r || f || T.precisa;
      return r ? f + ' · ' + r : f;
    }
    return String(a.espera || T.precisa).replace(/^(Permissão|Aprovar)\s*:?\s*/i, '').replace(/^([\w.-]+):\s+/, '$1 · ');
  }

  function desenharAvisos() {
    if (!ui.avisos) return;
    const itens = itensAvisos(), max = CONFIG.rotulos.avisosMax;
    avisosDebug = itens.map((it) => ({ nome: it.a.nome, detalhe: it.det, acao: it.acao, pede: it.pede }));
    const est = (it) => avisoEstado.get(it.chave) || {};
    const assin = itens.map((it) => [it.chave, it.a.nome, it.det, it.acao, est(it).env ? 1 : 0, est(it).erro ? 1 : 0].join('§')).join('¦') + '|' + px.k;
    if (assin === avisosAssin) return;
    avisosAssin = assin;
    for (const k of [...avisoEstado.keys()]) if (!itens.some((it) => it.chave === k)) avisoEstado.delete(k);
    ui.avisos.textContent = '';
    for (const it of itens.slice(0, max)) criarAviso(it, est(it));
    if (itens.length > max) {
      const r = h('div', 'of-aviso of-aviso-mais', ui.avisos);
      const t = '+' + (itens.length - max) + ' ' + T.rot.mais;
      h('span', 'of-sr', r, t);
      pxPor(r, PX.caixa({ pal: 'madeira', linhas: [{ t, cor: '#fbecc8', sombra: '#4a2a14' }], padX: 2, padY: 1 }).c);
    }
    posicionarAvisos();
  }
  function criarAviso(it, e) {
    const W = CONFIG.rotulos.avisoLargura, f = CONFIG.funcoes[it.a.funcao] || CONFIG.funcoes.auxiliar;
    const el = h('div', 'of-aviso', ui.avisos);
    el.dataset.chave = it.chave;
    if (e.env) el.setAttribute('aria-busy', 'true');
    h('span', 'of-sr', el, it.a.nome + ' ' + it.pede + ': ' + it.det);
    const interno = W - 10; // moldura 2 + folga 3 de cada lado
    const bts = it.acao === 'decidir' ? [['permitir', T.rot.permitir, '#c9f5b4'], ['negar', T.rot.negar, '#ffc4b6']] : it.acao === 'abrir' ? [['abrir', T.rot.abrir, '#fbecc8']] : [];
    const botoes = bts.map(([acao, txt, cor]) => ({ acao, txt, c: PX.caixa({ pal: 'madeira', linhas: [{ t: txt, cor, sombra: '#3a2010' }], padX: 2, padY: 0 }).c }));
    const bh = botoes.length ? Math.max(...botoes.map((b) => b.c.height)) : 0;
    const linhas = [
      { t: PX.cortar(it.a.nome, interno - 5), cor: '#1c120b', marca: f.cor },
      { t: PX.cortar(it.pede, interno), cor: '#6b4300' },
      { t: PX.cortar(e.erro ? T.rot.falhou : e.env ? T.rot.enviando : it.det, interno), cor: e.erro ? '#8a1018' : '#3a2306' },
    ];
    const cx = PX.caixa({ pal: 'espera', linhas, padX: 3, padY: 2, gap: 2, minW: interno, extraH: bh ? bh + 3 : 0 });
    pxPor(el, cx.c);
    el.style.width = cx.c.width * px.u + 'px'; el.style.height = cx.c.height * px.u + 'px';
    let x = cx.f.w - 2 - 3;
    const y = cx.f.h - 2 - 2 - bh;
    for (const b of botoes.slice().reverse()) {
      x -= b.c.width;
      const bt = h('button', 'of-aviso-bt', el);
      bt.type = 'button';
      bt.dataset.acao = b.acao;
      bt.setAttribute('aria-label', b.txt + ' · ' + it.a.nome + ': ' + it.det);
      bt.disabled = !!e.env;
      bt.style.left = x * px.u + 'px'; bt.style.top = y * px.u + 'px';
      pxPor(bt, b.c);
      bt.addEventListener('click', (ev) => { ev.stopPropagation(); responderAviso(it, b.acao); });
      x -= 3;
    }
  }
  async function responderAviso(it, acao) {
    if ((avisoEstado.get(it.chave) || {}).env) return;
    if (acao === 'abrir') { if (it.a.sessaoId && api) chamar(api.abrirSessao, it.a.sessaoId); return; }
    if (modo === 'demo') { definir(it.a, acao === 'permitir' ? 'trabalhando' : 'ocioso', it.a.tarefa); return; }
    if (!it.perm || !api || typeof api.responderPermissao !== 'function') return;
    avisoEstado.set(it.chave, { env: true });
    try {
      await api.responderPermissao(it.a.sessaoId, { id: it.perm.id, decisao: acao === 'permitir' ? 'permitir' : 'negar' });
      avisoEstado.set(it.chave, { env: true, ok: true }); // some quando a sessão deixar de aguardar
    } catch {
      avisoEstado.set(it.chave, { erro: true });
    }
  }

  // Tecla L (ou o botão do rodapé): mostra/oculta placas, ícones e balões. A fila de pedidos fica sempre.
  function alternarRotulos(forcar) {
    rotOcultos = forcar == null ? !rotOcultos : !!forcar;
    if (raiz) raiz.classList.toggle('of-sem-rotulos', rotOcultos);
    if (ui.dica) { ui.dica.setAttribute('aria-pressed', rotOcultos ? 'false' : 'true'); ui.dica.title = rotOcultos ? 'Mostrar rótulos (L)' : 'Ocultar rótulos (L)'; }
    try { localStorage.setItem('orbit-office-rotulos', rotOcultos ? '0' : '1'); } catch {}
    for (const a of atores) { a.posI = -1; a.posB = -1; }
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
    // Sem a da função: a de auxiliar e, por fim, qualquer estação livre (menos a do Mestre).
    const e = pega(funcao) || (funcao !== 'mestre' ? pega('auxiliar') || estacoes.find((x) => !x.ator && x.funcao !== 'mestre') : null);
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
      estacao: null, lugar: -1, visita: null, hospeda: [], saindo: false, saiu: false,
      ferramenta: '', ferrSig: '', pesq: false, externa: false, compactando: false,
      fila: -1, pt: null, extPend: 0, extVisto: false, ordens: [],
      dom: null, ult: {}, balao: null, bal: null, balAssin: '', balDim: null, balDes: '', balVis: false,
      ik: '', ikK: 0, posI: -1, posB: -1, caixaIc: null, z: -1, perm: null,
      porT: 0, por: null, porIni: onde !== 'entrada', vx: 0, vy: 0, alfa: 1, dentro: false, porAnda: false,
      desde: Date.now(), m: null,
    };
    a.estacao = alocarEstacao(d.funcao, a);
    a.lugar = alocarLugar(a);
    atualizarAtor(a, d);
    const p = onde === 'entrada' ? CONFIG.entrada : destino(a);
    a.x = p.x + 0.5; a.y = p.y + 0.5; a.vx = a.x; a.vy = a.y;
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
    a.prov = d.prov || '';
    a.ferramenta = d.ferramenta || ''; a.ferrSig = d.ferrSig || '';
    a.pesq = !!d.pesq; a.externa = !!d.externa; a.compactando = !!d.compactando;
    a.perm = d.perm || null;
    if ('dormindo' in d) a.dormindo = !!d.dormindo;
    if (d.m) a.m = d.m;
    if (antes !== a.estado) {
      a.desde = Date.now();
    }
  }

  // `mais`: ferramenta (nome), alvo, externa, compactando (roteiro do demo); o resto vem do estado.
  function definir(a, estado, tarefa, extra, mais) {
    if (a.m && a.origem === 'demo') metricasDemo(a, estado);
    const f = infoFerramenta(mais && mais.ferramenta, mais && mais.alvo);
    atualizarAtor(a, {
      estado, bruto: estado === 'ocioso' ? (a.estado === 'trabalhando' || a.bruto === 'concluido' ? 'concluido' : 'ocioso') : estado, tarefa: tarefa == null ? a.tarefa : tarefa, espera: estado === 'aguardando' ? extra : a.espera,
      motivo: estado === 'erro' ? extra : a.motivo, descricao: a.descricao, tipo: a.tipo, sessaoId: a.sessaoId, prov: a.prov,
      ...f, pesq: f.pesq && estado === 'trabalhando', externa: !!(mais && mais.externa) && estado === 'aguardando',
      compactando: !!(mais && mais.compactando) && estado === 'trabalhando',
    });
  }

  // Ponto de passagem do líder: duas células abaixo da estação do Mestre (ou a caminhável mais próxima).
  function passagemLider() {
    const e = estacoes.find((x) => x.funcao === 'mestre');
    if (!e) return null;
    const c = { x: e.x, y: e.y + 2 };
    return pode(c.x, c.y) ? c : maisProximo(c);
  }

  function ordemPassagem() {
    const alvo = passagemLider();
    return alvo ? [{ alvo, espera: CONFIG.passagemMs, ate: null, limite: relogio + CONFIG.passagemMaxMs }] : [];
  }

  function liberarPontos(a) {
    if (a.fila >= 0) { if (filaSlots[a.fila] === a) filaSlots[a.fila] = null; a.fila = -1; }
    a.pt = null;
    a.extPend = 0; a.extVisto = false;
  }

  // `passagem`: o convidado passa pelo líder antes de ir à porta.
  function sair(a, passagem) {
    if (a.saindo) return;
    a.saindo = true;
    if (a.estacao) { a.estacao.ator = null; a.estacao = null; }
    a.lugar = -1;
    liberarPontos(a);
    a.ordens = passagem ? ordemPassagem() : [];
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
    // Mouse sobre o robô ou o ícone abre o balão (o clique também: o selecionado fica com o balão aberto).
    const entra = (ev) => { if (!ev.pointerType || ev.pointerType === 'mouse') hoverId = a.id; };
    const sai = () => { if (hoverId === a.id) hoverId = null; };
    b.addEventListener('pointerenter', entra);
    b.addEventListener('pointerleave', sai);

    // Ícone de estado (pixel art) sobre a cabeça; de quem está dentro, abaixo da porta. Abre o cartão.
    const ic = h('button', 'of-icone', camRot);
    ic.type = 'button';
    ic.hidden = true;
    ic.addEventListener('click', (ev) => { ev.stopPropagation(); selecionar(a.id); });
    ic.addEventListener('pointerenter', entra);
    ic.addEventListener('pointerleave', sai);

    // Balão (hover ou clique): pergaminho com o nome, o estado e o texto cortado com reticências.
    const bal = h('div', 'of-balao', camRot);
    bal.setAttribute('role', 'tooltip');
    const sr = h('span', 'of-sr', bal, '');
    a.dom = { b, run, idle, zz, ic, bal, sr };
  }

  function removerDom(a) {
    if (!a.dom) return;
    a.dom.b.remove(); a.dom.ic.remove(); a.dom.bal.remove();
    if (hoverId === a.id) hoverId = null;
    a.dom = null;
  }

  // ─────────────────────────────── movimento ───────────────────────────────
  // Lugar de descanso FIXO: cada agente tem o seu (o da chave, se estiver livre; senão o primeiro livre) até sair.
  function alocarLugar(a) {
    if (!lugaresDescanso.length) return -1;
    const usados = new Set(atores.filter((o) => o !== a && !o.saindo && o.lugar >= 0).map((o) => o.lugar));
    const antes = lugarPorChave.get(a.chave);
    let i = antes != null && !usados.has(antes) ? antes : -1;
    if (i < 0) for (let k = 0; k < lugaresDescanso.length; k++) if (!usados.has(k)) { i = k; break; }
    if (i < 0) i = atores.length % lugaresDescanso.length; // sala cheia: divide o lugar
    lugarPorChave.set(a.chave, i);
    return i;
  }

  // Prioridade: passagem do convidado > saindo > conversa > fila (aguardando) > ponto temporário (pesquisa/balcão)
  // > estação > descanso fixo. Tudo decidido pelo estado real; nada sorteado.
  function destino(a) {
    if (a.ordens.length) return a.ordens[0].alvo;
    if (a.saindo) return CONFIG.entrada;
    if (a.visita && a.visita.fase !== 'fila') return a.visita.spot;
    const host = a.hospeda.find((it) => it.fase !== 'fila');
    if (host) return host.ancora;
    if (pausaEsc()) return a.lugar >= 0 ? lugaresDescanso[a.lugar] : CONFIG.entrada; // execução pausada: todos ao descanso
    if (a.estado === 'aguardando' && a.fila >= 0) return CONFIG.fila[a.fila];
    if (a.estado === 'trabalhando' && a.pt) return a.pt.cel;
    if (a.estado !== 'ocioso' && a.estacao) return { x: a.estacao.x, y: a.estacao.y };
    return a.lugar >= 0 ? lugaresDescanso[a.lugar] : CONFIG.entrada;
  }

  // A cada quadro, antes de decidir o destino: avança a passagem do convidado, toma/solta a vaga da fila e
  // cria/solta o ponto temporário (pesquisa ou balcão de envio), sempre a partir do estado real.
  function gerirAtor(a) {
    const o = a.ordens[0];
    if (o) {
      if (relogio > o.limite) a.ordens.shift();
      else if (chegou(a, o.alvo)) {
        if (o.ate == null) o.ate = relogio + o.espera;
        if (relogio >= o.ate) a.ordens.shift();
      }
    }
    if (a.saindo) return;
    // Fila: uma vaga (FIFO) enquanto aguarda; cheia, fica na estação e tenta de novo a cada quadro.
    if (a.estado === 'aguardando') {
      if (a.fila < 0) {
        const i = filaSlots.findIndex((s) => !s || s.saindo || s.fila < 0);
        if (i >= 0) { filaSlots[i] = a; a.fila = i; }
      }
    } else if (a.fila >= 0) { if (filaSlots[a.fila] === a) filaSlots[a.fila] = null; a.fila = -1; }
    // Aprovação externa: ao deixar de pedir, a ferramenta que roda em seguida vai ao balcão (por externaAposMs).
    if (a.externa && a.estado === 'aguardando') { a.extVisto = true; a.extPend = 0; }
    else if (a.extVisto) { a.extVisto = false; a.extPend = relogio + CONFIG.externaAposMs; }
    if (a.estado === 'ocioso' || a.estado === 'erro' || (a.extPend && relogio > a.extPend)) a.extPend = 0;
    // Ponto temporário: só enquanto trabalha.
    if (a.estado !== 'trabalhando') { a.pt = null; return; }
    const p = a.pt;
    if (p) {
      if (p.chegouEm == null && chegou(a, p.cel)) p.chegouEm = relogio;
      const vivo = p.tipo === 'pesq' ? a.pesq : !!a.ferrSig && a.ferrSig === p.sig;
      if (vivo) p.fim = null; else if (p.fim == null) p.fim = relogio;
      const ret = p.tipo === 'pesq' ? CONFIG.pesquisaRetemMs : CONFIG.balcaoRetemMs;
      if (p.fim != null && ((p.chegouEm != null && relogio - Math.max(p.fim, p.chegouEm) >= ret) || relogio - p.fim > CONFIG.caminhadaMaxMs)) a.pt = null;
      return;
    }
    if (a.compactando) return;
    if (a.extPend && a.ferrSig) {
      const spot = CONFIG.balcao.spot;
      if (!atores.some((x) => x !== a && !x.saindo && x.pt && x.pt.tipo === 'balcao')) {
        a.pt = { tipo: 'balcao', cel: { x: spot.x, y: spot.y }, sig: a.ferrSig, chegouEm: null, fim: null };
        a.extPend = 0;
      }
    } else if (a.pesq) {
      const i = CONFIG.pesquisa.findIndex((c, k) => !atores.some((x) => x !== a && !x.saindo && x.pt && x.pt.tipo === 'pesq' && x.pt.idx === k));
      if (i >= 0) a.pt = { tipo: 'pesq', idx: i, cel: { x: CONFIG.pesquisa[i].x, y: CONFIG.pesquisa[i].y }, chegouEm: null, fim: null };
    }
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

  // Entrar na casa (como na referência): quem trabalha na estação de uma casa anda da estação até a porta e some
  // nela; ao sair, surge na porta e volta à estação antes de seguir. É só visual: a posição lógica continua na
  // estação, e o crachá e o balão ficam na porta. `porT` vai de 0 (fora) até o tempo da caminhada mais o sumiço.
  const querDentro = (a) => !!(a.estacao && a.estacao.area.porta && !a.saindo && !a.ordens.length && a.estado !== 'ocioso'
    && !a.visita && !a.hospeda.some((it) => it.fase !== 'fila') && !pausaEsc() && naEstacao(a));

  // Devolve true enquanto segura o robô (ele está saindo da casa e ainda não pode andar).
  function passoPorta(a, dt) {
    const quer = querDentro(a);
    if (quer && !a.por) {
      const P = a.estacao.area.porta, sx = a.estacao.x + 0.5, sy = a.estacao.y + 0.5;
      const andar = Math.hypot(P.x - sx, P.y - sy) / CONFIG.velocidade;
      a.por = { sx, sy, px: P.x, py: P.y, andar, total: andar + CONFIG.portaMs / 1000 };
    }
    const p = a.por;
    if (p) {
      if (reduzido || (a.porIni && quer)) a.porT = quer ? p.total : 0;
      else a.porT = Math.max(0, Math.min(p.total, a.porT + (quer ? dt : -dt)));
    }
    a.porIni = false;
    if (!p || a.porT <= 0) {
      a.por = null; a.porT = 0; a.vx = a.x; a.vy = a.y; a.alfa = 1; a.dentro = false; a.porAnda = false;
      return false;
    }
    const k = p.andar > 0 ? Math.min(1, a.porT / p.andar) : 1;
    const f = Math.max(0, Math.min(1, (a.porT - p.andar) / (CONFIG.portaMs / 1000)));
    a.vx = p.sx + (p.px - p.sx) * k;
    a.vy = p.sy + (p.py - p.sy) * k - f * 0.45; // some subindo pela soleira
    a.alfa = 1 - f;
    a.dentro = f >= 1;
    a.porAnda = k < 1 && a.porT < p.total && (quer ? a.porT > 0 : true);
    if (a.porAnda && Math.abs(p.px - p.sx) > 0.05) a.virado = quer ? p.px < p.sx : p.sx < p.px;
    return !quer;
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
        if (it.tipo === 'delegar' && it.v.estado === 'ocioso' && !ATIVO[it.v.bruto]) { encerrar(it, false); continue; }
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
    const c = s.controle || {};
    let estado = dormindo ? 'ocioso' : st === 'trabalhando' || st === 'aguardando' || st === 'erro' ? st : 'ocioso';
    let bruto = estado !== 'ocioso' ? st : st === 'nova' ? 'nova' : 'concluido';
    // Aguardando efetivo: status do hook OU pedido de permissão/pergunta/plano OU fila de pendências (erro vence).
    const perm = c.permissao && typeof c.permissao === 'object' ? c.permissao : null;
    if (!dormindo && estado !== 'erro' && (perm || Number(c.pendentes) > 0)) { estado = 'aguardando'; bruto = 'aguardando'; }
    // Compactando (memória): mesmo ocioso conta como trabalhando, com a tarefa "Organizando memória".
    const compactando = !dormindo && estado !== 'aguardando' && estado !== 'erro' && !!(c.autoCompactar && c.autoCompactar.compactando);
    if (compactando) { estado = 'trabalhando'; bruto = 'trabalhando'; }
    const f = s.ferramenta && s.ferramenta.nome ? infoFerramenta(s.ferramenta.nome, s.ferramenta.alvo) : infoFerramenta('');
    return {
      estado, bruto, dormindo, compactando,
      ferramenta: f.ferramenta, ferrSig: f.ferrSig, pesq: f.pesq && estado === 'trabalhando' && !compactando,
      externa: !!(perm && perm.externa === true) && estado === 'aguardando',
      perm: perm && !dormindo ? { id: perm.id, ferramenta: String(perm.ferramenta || ''), resumo: typeof perm.resumo === 'string' ? perm.resumo : '', tipo: perm.tipo || 'ferramenta' } : null,
      tarefa: compactando ? T.compactando : fmtFerramenta(s.ferramenta) || s.tarefa || s.titulo || '',
      espera: s.detalhe || (perm && typeof perm.resumo === 'string' && perm.resumo) || T.precisa,
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
    const fi = ag.ferramenta && ag.ferramenta.nome ? infoFerramenta(ag.ferramenta.nome, ag.ferramenta.alvo) : infoFerramenta('');
    return {
      estado, bruto: st || 'concluido',
      ferramenta: fi.ferramenta, ferrSig: fi.ferrSig, pesq: fi.pesq && estado === 'trabalhando',
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

  // Modo escritório: orquestrador da execução atual do escritório mostrado (papel 'orquestrador').
  const escDe = (s) => (s && s.controle && s.controle.escritorio && typeof s.controle.escritorio === 'object' ? s.controle.escritorio : null);
  function escolherTimeEsc(lista) {
    const orqs = lista.filter((s) => { const e = escDe(s); return e && e.id === escId && e.papel === 'orquestrador' && s.status !== 'encerrada' && s.vivo !== false; });
    if (!orqs.length) return null;
    const exec = escInfo && escInfo.execucao;
    orqs.sort((p, q) => (escDe(q).execucao === exec ? 1 : 0) - (escDe(p).execucao === exec ? 1 : 0)
      || (ATIVO[q.status] ? 1 : 0) - (ATIVO[p.status] ? 1 : 0) || (ms(q.atividade) - ms(p.atividade)));
    return orqs[0];
  }

  function descreverTimeEsc(time, lista) {
    const eo = escDe(time) || {};
    const nomeP = (e, pad) => String((e && e.papelNome) || pad || '').trim();
    const ds = [{ chave: 'mestre:' + time.id, funcao: 'mestre', nome: nomeP(eo, 'Orquestrador'), origem: 'sessao', sessaoId: time.id, descricao: nomeSessao(time), prov: time.provedor === 'codex' ? 'codex' : '', ...doStatusSessao(time) }];
    const vistos = new Set([time.id]);
    for (const ag of time.agentes || []) {
      ds.push({ chave: 'ag:' + ag.id, funcao: mapearFuncao(`${ag.descricao || ''} ${ag.tipo || ''}`), origem: 'subagente', sessaoId: time.id, prov: time.provedor === 'codex' ? 'codex' : '', ...doStatusAgente(ag) });
    }
    const membro = (s, e) => {
      vistos.add(s.id);
      const papelNome = nomeP(e, '');
      ds.push({
        chave: 'dep:' + s.id, funcao: mapearFuncao(`${papelNome} ${(e && e.papel) || ''}`), nome: papelNome || undefined, origem: 'dependente',
        sessaoId: s.id, descricao: papelNome || nomeSessao(s), tipo: s.nome || '', prov: s.provedor === 'codex' ? 'codex' : '', ...doStatusSessao(s),
      });
    };
    for (const s of lista) {
      const e = escDe(s);
      if (e && e.id === escId && e.execucao === eo.execucao && e.papel !== 'orquestrador' && !vistos.has(s.id) && s.status !== 'encerrada') membro(s, e);
    }
    for (const s of lista) {
      if (s.pai === time.id && !vistos.has(s.id) && s.status !== 'encerrada') membro(s, escDe(s));
    }
    return ds;
  }

  function descreverTime(time, lista) {
    if (escId) return descreverTimeEsc(time, lista);
    // prov: marca de provedor (só 'codex'; subagentes herdam da mãe; vazio = Claude, sem atributo no DOM).
    const provDe = (s) => (s && s.provedor === 'codex' ? 'codex' : '');
    const ds = [{ chave: 'mestre:' + time.id, funcao: 'mestre', nome: CONFIG.funcoes.mestre.nome, origem: 'sessao', sessaoId: time.id, descricao: nomeSessao(time), prov: provDe(time), ...doStatusSessao(time) }];
    for (const ag of time.agentes || []) {
      ds.push({ chave: 'ag:' + ag.id, funcao: mapearFuncao(`${ag.descricao || ''} ${ag.tipo || ''}`), origem: 'subagente', sessaoId: time.id, prov: provDe(time), ...doStatusAgente(ag) });
    }
    for (const dep of lista) {
      if (dep.pai !== time.id) continue;
      const txt = `${dep.apelido || ''} ${dep.nome || ''} ${dep.titulo || ''} ${String(dep.primeira || dep.tarefa || '').slice(0, 240)}`;
      ds.push({ chave: 'dep:' + dep.id, funcao: mapearFuncao(txt), origem: 'dependente', sessaoId: dep.id, descricao: nomeSessao(dep), tipo: dep.nome || '', prov: provDe(dep), ...doStatusSessao(dep) });
    }
    return ds;
  }

  function sincronizar(gerar) {
    const semApi = !api || typeof api.sessoes !== 'function';
    if (!escId && (forcarDemo || semApi)) { if (modo !== 'demo') entrarModo('demo'); return; }
    const lista = (semApi ? null : chamar(api.sessoes)) || [];
    if (escId) {
      // Modo escritório: nunca cai no demo; sem execução, o escritório fica vazio (todos já saíram pela porta).
      const t = escolherTimeEsc(lista);
      if (!t) {
        if (modo !== 'real' || timeId !== null) entrarModo('real', null);
        timeNome = escNome || 'escritório'; marcarAtualizado();
        return;
      }
      let ini = false;
      if (modo !== 'real' || t.id !== timeId) { ini = entrarModo('real', t); gerar = false; }
      timeNome = (escNome || nomeSessao(t));
      aplicarTime(t, lista, gerar, ini);
      marcarAtualizado();
      return;
    }
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
      const convidado = d.origem === 'subagente';
      if (!a) {
        // Convidado que já saiu, ou que chega já concluído, nunca é recriado.
        if (convidado && (saidos.has(d.chave) || d.estado === 'ocioso')) continue;
        if (atores.filter((x) => !x.saindo).length >= CONFIG.maxRobos) continue;
        a = criarAtor(d, inicial ? 'destino' : 'entrada');
        if (convidado) { if (!inicial) a.ordens = ordemPassagem(); } // entra pela porta, passa pelo líder, vai à estação
        else if (gerar && d.funcao !== 'mestre' && ATIVO[d.bruto] && !d.compactando) {
          enfileirar('delegar', a, mestreAtor(), d.descricao || d.tarefa); // o membro vai ao líder e volta
        }
      } else {
        const antes = a.bruto, antesCompacta = a.compactando;
        atualizarAtor(a, d);
        if (convidado) {
          if (d.estado === 'ocioso') { saidos.add(d.chave); sair(a, true); } // terminou: passa pelo líder e sai pela porta
        } else if (gerar && a.funcao !== 'mestre') {
          if (ATIVO[antes] && !antesCompacta && d.bruto === 'concluido') enfileirar('entregar', a, mestreAtor(), a.descricao || a.tarefa);
          else if ((antes === 'nova' || antes === 'concluido') && d.bruto === 'trabalhando' && !d.compactando) enfileirar('delegar', a, mestreAtor(), a.descricao || a.tarefa);
        }
      }
    }
    for (const a of atores) {
      if (a.saindo || vistos.has(a.chave)) continue;
      if (a.origem === 'subagente') saidos.add(a.chave);
      sair(a, a.origem === 'subagente');
    }
  }

  // Troca de modo: quem estava sai pela entrada, o time novo entra por ela.
  function entrarModo(m, time) {
    const primeira = !jaPovoou;
    jaPovoou = true;
    for (const a of atores.slice()) sair(a);
    interacoes = [];
    filaSlots = CONFIG.fila.map(() => null); saidos = new Set();
    modo = m;
    timeId = time ? time.id : null;
    timeNome = time ? nomeSessao(time) : '';
    timeDescs = [];
    if (m === 'demo') {
      demoIniciar(primeira);
      demoIdx = 0; demoCiclo = relogio;
      marcarAtualizado();
    }
    return primeira;
  }

  // ─────────────────────────────── modo escritório ───────────────────────────────
  let escNome = '', elsMarc = new Set();
  const pausaEsc = () => !!(escId && escInfo && escInfo.status === 'pausada');

  // Sonda da imagem de um marcador (só no modo escritório): se carregar, o marcador usa a imagem; senão fica o provisório.
  function sondar(nome) {
    if (sondas.has(nome)) return;
    const def = CONFIG.escritorioAssets && CONFIG.escritorioAssets[nome];
    const s = { st: 'pend', src: def && def.src, src2x: '' };
    sondas.set(nome, s);
    if (!s.src || typeof Image !== 'function') { s.st = 'falhou'; return; }
    const im = new Image();
    im.onload = () => {
      s.st = im.naturalWidth > 0 ? 'ok' : 'falhou';
      if (s.st === 'ok' && def.src2x) {
        const im2 = new Image();
        im2.onload = () => { if (im2.naturalWidth > 0) { s.src2x = def.src2x; refrescarMarcadores(); } };
        im2.onerror = () => {};
        im2.src = def.src2x;
      }
      refrescarMarcadores();
    };
    im.onerror = () => { s.st = 'falhou'; refrescarMarcadores(); };
    im.src = s.src;
  }

  // Cria o elemento de um marcador: classe of-prov-<nome> (provisório) até a imagem carregar.
  function novoMarcador(nome, tag, pai, extraProv) {
    const el = h(tag || 'span', 'of-marc of-marc-' + nome + ' of-prov-' + nome + (extraProv ? ' ' + extraProv : ''), pai);
    const m = { nome, el, extra: extraProv || '', img: null };
    elsMarc.add(m);
    refrescarMarcador(m);
    return el;
  }

  function refrescarMarcador(m) {
    const s = sondas.get(m.nome);
    const el = m.el;
    if (s && s.st === 'ok') {
      if (!m.img) { m.img = h('img', 'of-marc-img', el); m.img.alt = ''; m.img.draggable = false; }
      if (m.img.getAttribute('src') !== s.src) m.img.src = s.src;
      const set = s.src2x ? s.src + ' 1x, ' + s.src2x + ' 2x' : '';
      if ((m.img.getAttribute('srcset') || '') !== set) { if (set) m.img.srcset = set; else m.img.removeAttribute('srcset'); }
      el.classList.remove('of-prov-' + m.nome); if (m.extra) el.classList.remove(m.extra);
      el.classList.add('of-img-' + m.nome);
    } else {
      if (m.img) { m.img.remove(); m.img = null; }
      el.classList.remove('of-img-' + m.nome);
      el.classList.add('of-prov-' + m.nome); if (m.extra) el.classList.add(m.extra);
    }
  }

  function refrescarMarcadores() {
    for (const m of elsMarc) {
      if (m.el.isConnected) m.visto = true;
      else if (m.visto) { elsMarc.delete(m); continue; } // já esteve na página e saiu
      refrescarMarcador(m);
    }
  }

  const pos = (el, x, y, w, hh) => {
    el.style.left = (x / C) * 100 + '%'; el.style.top = (y / R) * 100 + '%';
    el.style.width = (w / C) * 100 + '%'; el.style.height = (hh / R) * 100 + '%';
  };

  // Camada do palco com a placa de pausa (na porta), as vagas da fila e o balcão de envio. Só aparecem no modo escritório.
  function criarMarcadores() {
    elsMarc = new Set(); marcadores = {};
    camMarc = h('div', 'of-camada of-marcadores', palco);
    camMarc.hidden = !escId;
    const e = CONFIG.entrada;
    marcadores.placa = novoMarcador('placa-pausado', 'div', camMarc);
    marcadores.placa.setAttribute('role', 'img'); marcadores.placa.setAttribute('aria-label', 'Execução pausada');
    pos(marcadores.placa, e.x + 0.1, e.y - 1.15, 1.7, 1);
    marcadores.fila = CONFIG.fila.map((c) => { const el = novoMarcador('fila-espera', 'div', camMarc); pos(el, c.x + 0.08, c.y + 0.08, 0.84, 0.84); return el; });
    const b = CONFIG.balcao;
    marcadores.balcao = novoMarcador('balcao-envio', 'div', camMarc);
    pos(marcadores.balcao, b.x, b.y, b.w, b.h);
    atualizarMarcadores();
  }

  function atualizarMarcadores() {
    if (!camMarc) return;
    camMarc.hidden = !escId;
    marcadores.placa.hidden = !pausaEsc();
    camMarc.dataset.pausada = pausaEsc() ? '1' : '';
  }

  // Ícone avulso (cadeado ou moeda) para quem quiser pôr ao lado de um texto; segue a regra provisório/imagem.
  function iconeMarcador(qual) {
    const nome = qual === 'moeda' ? 'icone-moeda' : qual === 'cadeado' ? 'icone-cadeado' : '';
    if (!nome) return null;
    if (escId) sondar(nome);
    return novoMarcador(nome, 'i', null, nome === 'icone-cadeado' ? 'of-prov-cadeado' : '');
  }

  function aplicarEscInfo(exec, esc) {
    escInfo = exec && typeof exec === 'object' ? { status: exec.status || '', motivoPausa: exec.motivoPausa || '', execucao: exec.execucao || '' } : null;
    if (esc && typeof esc === 'object' && esc.nome) escNome = String(esc.nome);
    sujo = true;
    atualizarMarcadores();
  }

  // Estado inicial do escritório mostrado; qualquer falha (rede, 404, JSON) é ignorada.
  function buscarEsc() {
    const idAlvo = escId, seq = ++escSeq;
    if (!idAlvo || typeof fetch !== 'function') return;
    try {
      Promise.resolve(fetch('/escritorios/' + encodeURIComponent(idAlvo), { cache: 'no-store' }))
        .then((r) => (r && r.ok ? r.json() : null))
        .then((j) => { if (seq === escSeq && idAlvo === escId && j && typeof j === 'object') aplicarEscInfo(j.execucao, j.escritorio); })
        .catch(() => {});
    } catch (e) { /* sem rede: segue sem estado */ }
  }

  function escritorio(novo) {
    const idNovo = novo == null || novo === '' ? null : String(novo);
    if (idNovo === escId) { if (idNovo) buscarEsc(); return; }
    escId = idNovo; escInfo = null; escNome = ''; escSeq++;
    for (const [k, s] of sondas) if (s.st === 'falhou') sondas.delete(k); // tenta de novo as que faltaram
    if (escId) {
      for (const n in CONFIG.escritorioAssets) sondar(n);
      buscarEsc();
    }
    timeId = '\u0000'; // força a troca de time na próxima sincronização
    atualizarMarcadores();
    refrescarMarcadores();
    if (raiz) sincronizar(false);
  }

  // SSE `escritorio` {id, resumo|null}: só importa o escritório mostrado.
  function aoEscritorio(ev) {
    if (!ev || typeof ev !== 'object' || !escId || String(ev.id) !== escId) return;
    const r = ev.resumo && typeof ev.resumo === 'object' ? ev.resumo : null;
    escSeq++; // descarta um fetch ainda em voo
    if (!r) escInfo = null;
    else {
      const pausada = r.status === 'pausada';
      escInfo = { status: r.status || '', motivoPausa: pausada && escInfo && escInfo.status === 'pausada' ? escInfo.motivoPausa : '', execucao: (escInfo && escInfo.execucao) || '' };
      if (r.nome) escNome = String(r.nome);
    }
    sujo = true;
    atualizarMarcadores();
  }

  // ─────────────────────────────── demonstração ───────────────────────────────
  const listaDe = (tab, f) => tab[f] || tab.auxiliar;

  function demoIniciar(primeira) {
    const iniciais = { mestre: 'trabalhando', frontend: 'trabalhando', backend: 'trabalhando', tester: 'ocioso', pesquisador: 'trabalhando' };
    CONFIG.agentesDemo.forEach((def, i) => {
      const est = iniciais[def.funcao] || 'ocioso';
      criarAtor({
        chave: 'demo:' + def.id, funcao: def.funcao, nome: def.nome, origem: 'demo', estado: est, bruto: est,
        tarefa: est === 'ocioso' ? '' : listaDe(CONFIG.tarefasDemo, def.funcao)[0],
        m: metricasIniciaisDemo(est, i),
      }, primeira ? 'destino' : 'entrada');
    });
  }

  // Métricas fixas do modo demonstração (derivadas da posição do agente), no mesmo formato das reais (descrição `m`).
  function metricasIniciaisDemo(est, i) {
    const agora = Date.now();
    const n = 4 + (i % 5);
    const acoes = [];
    for (let k = 0; k < n; k++) acoes.push({ fim: agora, erro: i === 2 && k === 1 });
    if (est === 'trabalhando') acoes.push({ fim: null });
    const ativoDesde = est === 'trabalhando' ? agora - (60 + i * 120) * 1000 : 0;
    return {
      ativoMs: (4 + i * 5) * 60e3, ativoDesde, desde: 0,
      ferramentas: 8 + i * 9, atividade: agora - (5 + i * 7) * 1000,
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
      const n = 1 + (m.ferramentas % 3);
      m.ferramentas += n;
      for (let k = 0; k < n - 1; k++) acoes.push({ fim: agora });
      acoes.push({ fim: null });
    } else if (estado === 'erro') { m.ferramentas++; acoes.push({ fim: agora, erro: true }); }
    m.acoes = acoes.slice(-8);
    m.atividade = agora;
  }

  // Roteiro fixo: a cada quadro aplica os passos cujo `t` já passou no ciclo; ao fim do ciclo recomeça do primeiro.
  function demoTick() {
    const R = CONFIG.roteiroDemo;
    if (relogio - demoCiclo >= R.cicloMs) { demoCiclo += R.cicloMs; demoIdx = 0; }
    let mudou = false;
    while (demoIdx < R.passos.length && relogio - demoCiclo >= R.passos[demoIdx].t) {
      demoPasso(R.passos[demoIdx++]);
      mudou = true;
    }
    if (mudou) marcarAtualizado();
  }

  function demoPasso(p) {
    const a = atores.find((x) => !x.saindo && x.funcao === p.quem);
    if (!a) return;
    const m = mestreAtor();
    if (p.entregar) enfileirar('entregar', a, m, a.tarefa);
    definir(a, p.estado, p.tarefa, p.espera, p);
    if (p.delegar) enfileirar('delegar', a, m, p.tarefa); // o membro vai ao líder
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
    const sem = new Date(agora + 3 * 86400e3);
    sem.setMinutes(0, 0, 0);
    return {
      cincoHoras: { pct: 42, renova: agora + 95 * 60e3 },
      semanal: { pct: 58, renova: sem.getTime() },
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
  // com a cena ao vivo e o uso de exemplo, ele diz só "Uso simulado".
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
      a.dom.ic.classList.toggle('of-sel', a.id === idAtor);
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
    if (escId && a.origem === 'subagente') origem = 'Convidado';
    if (a.origem === 'subagente' && a.tipo) origem += ' · ' + a.tipo;
    if ((a.origem === 'sessao' || a.origem === 'dependente') && a.descricao) origem += ' · ' + a.descricao;
    if (a.prov === 'codex') origem += ' · Codex';
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
  // O mural de missões da praça (a "TV" do Mestre) abre um painel com as métricas de cada agente que ele gerencia. O painel
  // nasce da própria TV (transform-origin no centro dela) e fecha com clique fora, no × ou com Esc.
  const por = (el, v) => { if (el.textContent !== v) el.textContent = v; };
  let tvUlt = 0;

  function retanguloTV() {
    const t = CONFIG.tv;
    return { x: t.x, y: t.y, w: t.w, h: t.h };
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
        return { ...d, nome: a ? a.nome : d.nome || (CONFIG.funcoes[d.funcao] || CONFIG.funcoes.auxiliar).nome, desde: (d.m && d.m.desde) || (a && a.desde) || 0 };
      });
    } else fonte = atores.filter((a) => !a.saindo && a.funcao !== 'mestre');
    const ordem = { aguardando: 0, erro: 1, trabalhando: 2 };
    return fonte.map((x, i) => ({
      i, chave: x.chave, nome: x.nome, funcao: x.funcao, estado: x.estado, bruto: x.bruto, origem: x.origem,
      tarefa: x.tarefa, espera: x.espera, motivo: x.motivo, descricao: x.descricao, desde: x.desde, m: x.m || {}, prov: x.prov || '',
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
    if (x.prov) { if (r.li.dataset.prov !== x.prov) r.li.dataset.prov = x.prov; } else if (r.li.dataset.prov) delete r.li.dataset.prov;
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
    if (bc && bc.area && bc.toque && palco && !palco.contains(ev.target)) fecharCasa();
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
    } else if ((ev.key || '').toLowerCase() === CONFIG.rotulos.tecla) {
      if (ev.repeat) return;
      ev.preventDefault(); ev.stopPropagation();
      alternarRotulos();
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
    // "Aqui" = na estação, na vaga da fila ou no ponto temporário (pesquisa/balcão).
    const naFila = a.fila >= 0 && chegou(a, CONFIG.fila[a.fila]);
    const noPonto = !!a.pt && chegou(a, a.pt.cel);
    if (!naEstacao(a) && !naFila && !noPonto) return null;
    if (a.estado === 'aguardando') return { k: a.externa ? 'externa' : 'espera', tit: T.estados.aguardando, txt: cortar(a.espera) };
    if (a.estado === 'trabalhando' && a.compactando) return { k: 'compacta', tit: '', txt: T.compactando };
    if (a.estado === 'trabalhando') return { k: 'trabalho', tit: '', txt: cortar(a.tarefa || T.estados.trabalhando) };
    if (a.estado === 'erro') return { k: 'erro', tit: T.erro, txt: cortar(a.motivo) };
    return null;
  }

  // Conteúdo do balão de um agente (aberto no hover ou no clique): nome na 1ª linha, estado na 2ª e o texto em até
  // 2 linhas. Usa a fala de balaoDe (estação, fila, ponto ou conversa) e, fora disso, o estado atual.
  const COR_ESTADO = { espera: '#6b4300', externa: '#7a3000', erro: '#8a1018', ok: '#1d6a30', troca: '#163c47', compacta: '#213a5c', papel: '#5a4632' };
  function conteudoBalao(a) {
    const b = a.balao;
    const f = CONFIG.funcoes[a.funcao] || CONFIG.funcoes.auxiliar;
    const nome = a.nome + (a.prov === 'codex' ? ' · ' + T.rot.codex : '');
    let k, est, txt;
    if (b && b.k === 'troca') { k = 'troca'; est = b.para ? (b.tit || T.rot.conversa) + ' → ' + b.para : T.rot.conversa; txt = b.digita ? '…' : b.txt; }
    else if (a.estado === 'aguardando') { k = a.externa ? 'externa' : 'espera'; est = T.estados.aguardando; txt = a.espera; }
    else if (a.estado === 'erro') { k = 'erro'; est = T.estados.erro; txt = a.motivo; }
    else if (a.estado === 'trabalhando') { k = a.compactando ? 'compacta' : 'papel'; est = T.estados.trabalhando; txt = a.compactando ? T.compactando : a.tarefa; }
    else if (a.dormindo) { k = 'papel'; est = T.rot.dormindo; txt = ''; }
    else if (a.bruto === 'concluido') { k = 'ok'; est = T.rot.ok; txt = a.tarefa; }
    else { k = 'papel'; est = T.rot.ocioso; txt = ''; }
    if (a.dentro && k !== 'troca') est += ' · ' + T.rot.dentro;
    return { k, nome, cor: f.cor, est, txt: String(txt || '') };
  }
  // Ícone de estado sobre a cabeça: trabalhando (…), concluído (✓), erro (✕), aguardando você (! pulsando).
  function iconeDe(a) {
    if (a.saindo) return '';
    if (a.estado === 'aguardando') return 'espera';
    if (a.estado === 'erro') return 'erro';
    if (a.estado === 'trabalhando') return 'trab';
    if ((a.visita && a.visita.fase === 'conversa') || a.hospeda.some((it) => it.fase === 'conversa')) return 'trab';
    if (!a.dormindo && a.bruto === 'concluido') return 'ok';
    return '';
  }
  function desenhoBalao(c, lado, pos) {
    const L = CONFIG.rotulos.balaoLargura;
    const linhas = [{ t: PX.cortar(c.nome, L - 5), cor: '#1c120b', marca: c.cor }, { t: PX.cortar(c.est, L), cor: COR_ESTADO[c.k] || COR_ESTADO.papel }];
    if (c.txt) for (const l of PX.quebrar(c.txt, L, 2)) linhas.push({ t: l, cor: '#2b1d12' });
    return PX.caixa({ pal: c.k, linhas, padX: 3, padY: 2, gap: 2, ponta: lado ? { lado, pos } : null });
  }

  // Sobreposição (área) entre dois retângulos, com 1 px de folga.
  function sobre(p, q) {
    const ix = Math.min(p.x + p.w + 1, q.x + q.w) - Math.max(p.x - 1, q.x), iy = Math.min(p.y + p.h + 1, q.y + q.h) - Math.max(p.y - 1, q.y);
    return ix > 0 && iy > 0 ? ix * iy : 0;
  }
  // Posição de um rótulo: a primeira candidata livre (dentro do palco, sem cobrir casa, placa nem outro rótulo);
  // sem nenhuma livre, a de menor custo (cobrir fachada ou porta pesa muito mais). `pref` é a posição do quadro
  // anterior: se segue livre, fica (o rótulo não pula entre lados à toa).
  function escolher(cands, grupos, pref, yMin) {
    let melhor = 0, custoMin = Infinity;
    const custo = (c) => grupos.reduce((s, [lista, peso]) => { for (const o of lista) if (o !== c.ignora) s += peso * sobre(c, o); return s; }, 0);
    for (const c of cands) {
      c.x = Math.max(2, Math.min(palcoW - c.w - 2, c.x));
      c.y = Math.max(yMin, Math.min(palcoH - c.h - 2, c.y));
    }
    if (pref >= 0 && pref < cands.length && custo(cands[pref]) === 0) return pref;
    for (let i = 0; i < cands.length; i++) {
      const v = custo(cands[i]);
      if (v === 0) return i;
      if (v < custoMin) { custoMin = v; melhor = i; }
    }
    return melhor;
  }
  const casaDe = (a) => (a.estacao && a.estacao.area.vila ? obstCasas.find((o) => o.id === a.estacao.area.vila) : null);

  function desenhar() {
    const vivos = atores.filter((a) => a.dom);
    // 1) robôs
    for (const a of vivos) {
      const px0 = a.vx * cel, pes = a.vy * cel + 0.32 * cel;
      const tx = Math.round(px0 - S / 2), ty = Math.round(pes - S);
      const u = a.ult;
      if (u.tx !== tx || u.ty !== ty) { a.dom.b.style.transform = `translate3d(${tx}px,${ty}px,0)`; u.tx = tx; u.ty = ty; }
      if (u.vir !== a.virado) { a.dom.run.style.transform = a.dom.idle.style.transform = a.virado ? 'scaleX(-1)' : ''; u.vir = a.virado; }
      const anda = a.andando || a.porAnda;
      const dz = !!a.dormindo && !anda; // etapa 4: instância do Orbit dormindo → pose parada com zZ
      if (u.and !== anda || u.dz !== dz) { a.dom.run.hidden = !anda; a.dom.idle.hidden = anda || dz; a.dom.zz.hidden = !dz; u.and = anda; u.dz = dz; }
      // Dentro da casa: o robô some na porta (sem clique); o ícone fica abaixo da porta e continua abrindo o cartão.
      const al = Math.round(a.alfa * 20) / 20;
      if (u.al !== al) { a.dom.b.style.opacity = al < 1 ? String(al) : ''; a.dom.b.classList.toggle('of-na-porta', al < 1); u.al = al; }
      if (u.dt !== a.dentro) { a.dom.b.classList.toggle('of-dentro', a.dentro); a.dom.ic.classList.toggle('of-dentro', a.dentro); u.dt = a.dentro; }
      const z = Math.round(a.vy * 10);
      if (a.z !== z) { a.dom.b.style.zIndex = String(z); a.z = z; }
      if ((u.pv || '') !== (a.prov || '')) { // marca do provedor: atributo só quando 'codex'
        for (const el of [a.dom.b, a.dom.ic, a.dom.bal]) { if (a.prov) el.dataset.prov = a.prov; else delete el.dataset.prov; }
        u.pv = a.prov || '';
      }
      if (u.e !== a.estado) { a.dom.b.dataset.e = a.estado; a.dom.ic.dataset.e = a.estado; u.e = a.estado; }
      // Conteúdo do balão: sempre no texto escondido (leitor de tela); o desenho, só com o balão aberto.
      a.balao = balaoDe(a);
      const c = conteudoBalao(a);
      const assin = [c.k, c.nome, c.est, c.txt].join('|');
      if (assin !== a.balAssin) {
        a.balAssin = assin; a.bal = c; a.balDim = null; a.balDes = '';
        a.dom.sr.textContent = c.nome + '. ' + c.est + (c.txt ? '. ' + c.txt : '');
        const rot = a.nome + ' · ' + c.est;
        a.dom.b.setAttribute('aria-label', rot); a.dom.ic.setAttribute('aria-label', rot);
      }
    }
    // 2) rótulos: ícones primeiro (de cima para baixo), depois os balões abertos. Nada cobre casa nem placa.
    rotulosDebug = [];
    const icones = [], baloes = [];
    if (!rotOcultos) {
      for (const p of obstPlacas) rotulosDebug.push({ tipo: 'placa', id: p.id, x: p.x, y: p.y, w: p.w, h: p.h });
      const naPorta = new Map();
      const ordem = vivos.slice().sort((p, q) => p.vy - q.vy || (p.id < q.id ? -1 : 1));
      for (const a of ordem) {
        const ik = iconeDe(a);
        if (ik !== a.ik || a.ikK !== px.k) {
          a.ik = ik; a.ikK = px.k; a.posI = -1;
          a.dom.ic.hidden = !ik;
          if (ik) { a.dom.ic.dataset.k = ik; pxPor(a.dom.ic, PX.icone(ik)); }
          else delete a.dom.ic.dataset.k;
        }
        a.caixaIc = null;
        if (!ik) continue;
        const iw = 11 * px.u, ih = 11 * px.u;
        const casa = casaDe(a);
        let cands;
        if (casa && (a.dentro || a.alfa < 1)) {
          // Dentro: na trilha, logo abaixo da porta (nunca sobre ela); o 2º e o 3º da casa ao lado.
          const n = naPorta.get(casa.id) || 0;
          naPorta.set(casa.id, n + 1);
          const yb = casa.base + px.u, passo = iw + 2 * px.u, x0 = casa.porta - iw / 2;
          const xs = [x0, x0 + passo, x0 - passo, x0 + 2 * passo, x0 - 2 * passo];
          cands = xs.slice(n).concat(xs.slice(0, n)).map((x) => ({ x, y: yb, w: iw, h: ih }));
        } else {
          const hx = a.vx * cel, pes = a.vy * cel + 0.32 * cel, cab = pes - S * 0.86;
          cands = [
            { x: hx - iw / 2, y: cab - ih - px.u, w: iw, h: ih },       // em cima da cabeça
            { x: hx + S * 0.3, y: cab, w: iw, h: ih },                  // ao lado da cabeça
            { x: hx - S * 0.3 - iw, y: cab, w: iw, h: ih },
            { x: hx - iw / 2, y: pes + px.u, w: iw, h: ih },            // embaixo dos pés
            { x: hx + S * 0.3, y: pes - ih, w: iw, h: ih },
            { x: hx - S * 0.3 - iw, y: pes - ih, w: iw, h: ih },
            { x: hx + S * 0.3, y: pes + px.u, w: iw, h: ih },           // embaixo, de lado
            { x: hx - S * 0.3 - iw, y: pes + px.u, w: iw, h: ih },
            { x: hx - iw / 2, y: cab - 2 * ih - 2 * px.u, w: iw, h: ih },
            { x: hx - iw / 2, y: pes + ih + 3 * px.u, w: iw, h: ih },
          ];
        }
        const i = escolher(cands, [[obstCasas, 1000], [obstPlacas, 20], [icones, 20]], a.posI, 2);
        a.posI = i;
        const c = cands[i], x = alinharX(c.x), y = alinharY(c.y);
        const u = a.ult;
        if (u.ix !== x || u.iy !== y) { a.dom.ic.style.transform = `translate3d(${x}px,${y}px,0)`; u.ix = x; u.iy = y; }
        a.caixaIc = { x, y, w: iw, h: ih };
        icones.push(a.caixaIc);
        rotulosDebug.push({ tipo: 'icone', id: a.id, k: ik, x, y, w: iw, h: ih });
      }
      // Balão: só de quem está sob o mouse ou selecionado. Prefere em cima; senão ao lado, embaixo ou deslocado.
      const abertos = vivos.filter((a) => !a.saindo && a.bal && (a.id === hoverId || a.id === selecionado));
      for (const a of vivos) if (a.balVis && !abertos.includes(a)) { a.balVis = false; a.dom.bal.classList.remove('of-vis'); }
      for (const a of abertos) {
        if (!a.balDim) { const d = desenhoBalao(a.bal, '', 0); a.balDim = { w: d.f.w, h: d.f.h }; }
        const u0 = px.u, T3 = PX.PONTA_FUNDO * u0, fw = a.balDim.w * u0, fh = a.balDim.h * u0;
        let A; // âncora: o ícone de quem está dentro, ou o corpo do robô
        if (a.caixaIc && (a.dentro || a.alfa < 1)) A = a.caixaIc;
        else { const hx = a.vx * cel, pes = a.vy * cel + 0.32 * cel; A = { x: hx - S * 0.3, y: pes - S * 0.9, w: S * 0.6, h: S * 0.9 }; }
        const acx = A.x + A.w / 2, acy = A.y + A.h / 2;
        const cands = [
          { lado: 'baixo', x: acx - fw / 2, y: A.y - fh - T3 - u0 },
          { lado: 'esq', x: A.x + A.w + u0, y: acy - fh / 2 },
          { lado: 'dir', x: A.x - fw - T3 - u0, y: acy - fh / 2 },
          { lado: 'cima', x: acx - fw / 2, y: A.y + A.h + u0 },
          { lado: 'baixo', x: acx - fw * 0.85, y: A.y - fh - T3 - u0 },
          { lado: 'baixo', x: acx - fw * 0.15, y: A.y - fh - T3 - u0 },
          { lado: 'cima', x: acx - fw * 0.85, y: A.y + A.h + u0 },
          { lado: 'cima', x: acx - fw * 0.15, y: A.y + A.h + u0 },
          { lado: 'esq', x: A.x + A.w + u0, y: acy - fh * 0.85 },
          { lado: 'dir', x: A.x - fw - T3 - u0, y: acy - fh * 0.85 },
          { lado: 'esq', x: A.x + A.w + u0, y: acy - fh * 0.15 },
          { lado: 'dir', x: A.x - fw - T3 - u0, y: acy - fh * 0.15 },
        ].map((c) => ({ ...c, w: fw + (c.lado === 'esq' || c.lado === 'dir' ? T3 : 0), h: fh + (c.lado === 'cima' || c.lado === 'baixo' ? T3 : 0), ignora: a.caixaIc }));
        const interior = bc && bc.area ? [{ x: bc.x, y: bc.y, w: bc.w, h: bc.h }] : [];
        const i = escolher(cands, [[obstCasas, 1000], [baloes, 200], [interior, 200], [obstPlacas, 20], [icones, 20]], a.posB, limTopo);
        a.posB = i;
        const c = cands[i], x = alinharX(c.x), y = alinharY(c.y);
        // Ponta: no ponto do lado mais perto do centro da âncora (em px de arte, ao longo do lado da moldura).
        const fx = c.lado === 'esq' ? PX.PONTA_FUNDO : 0, fy = c.lado === 'cima' ? PX.PONTA_FUNDO : 0;
        const pos = c.lado === 'baixo' || c.lado === 'cima' ? Math.round((acx - x) / u0) - fx : Math.round((acy - y) / u0) - fy;
        const des = c.lado + '|' + pos + '|' + a.balAssin + '|' + px.k;
        if (des !== a.balDes) { a.balDes = des; pxPor(a.dom.bal, desenhoBalao(a.bal, c.lado, pos).c); a.dom.bal.dataset.lado = c.lado; a.dom.bal.dataset.k = a.bal.k; }
        const u = a.ult;
        if (u.bx !== x || u.by !== y) { a.dom.bal.style.transform = `translate3d(${x}px,${y}px,0)`; u.bx = x; u.by = y; }
        if (!a.balVis) { a.balVis = true; a.dom.bal.classList.add('of-vis'); }
        baloes.push({ x, y, w: c.w, h: c.h });
        rotulosDebug.push({ tipo: 'balao', id: a.id, x, y, w: c.w, h: c.h, lado: c.lado, texto: a.bal.txt });
      }
    } else {
      for (const a of vivos) if (a.balVis) { a.balVis = false; a.dom.bal.classList.remove('of-vis'); }
    }
    // 3) fila de pedidos do canto (fora do mapa)
    desenharAvisos();
    // 4) telas das estações
    for (const e of estacoes) {
      const a = e.ator;
      let st = 'apagada';
      if (a && !a.saindo) {
        if (a.estado === 'erro') st = 'erro';
        else if (a.estado === 'aguardando') st = 'espera'; // espera também na fila
        else if (naEstacao(a)) st = a.estado === 'trabalhando' ? (a.compactando ? 'espera' : 'ativa') : 'apagada';
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
    if (modo === 'demo') demoTick();
    processarInteracoes();
    for (const a of atores) {
      gerirAtor(a);
      const d = destino(a);
      if (d) irPara(a, d);
      if (passoPorta(a, dt)) { a.andando = false; a.acc = 0; } // saindo da casa: espera surgir na porta
      else { mover(a, dt); if (!a.por) { a.vx = a.x; a.vy = a.y; } }
      // Na estação, de frente para o monitor (à direita), salvo durante uma conversa.
      if (!a.andando && !a.porAnda && !a.visita && !a.hospeda.some((it) => it.fase === 'conversa') && naEstacao(a)) a.virado = false;
      if (a.saindo && !a.saiu && !a.ordens.length && chegou(a, CONFIG.entrada)) { a.saiu = true; removerDom(a); }
    }
    if (atores.some((a) => a.saiu)) atores = atores.filter((a) => !a.saiu);
    if (relogio - (ultimoUso || 0) > 30000) { ultimoUso = relogio; desenharUso(); }
    desenharMapa(false);
    desenhar();
    if (bc && bc.area) desenharCasa(false);
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
    hoverId = null; avisosAssin = ''; avisoEstado = new Map();
    let salvo = false;
    try { salvo = localStorage.getItem('orbit-office-rotulos') === '0'; } catch {}
    alternarRotulos(salvo);
    alturaFixa = false;
    pausado = false; oculto = document.hidden; relogio = 0; pausadoEm = 0;
    atores = []; porChave = new Map(); interacoes = []; historicoInt = []; modo = null; timeId = null; jaPovoou = false; selecionado = null;
    filaSlots = CONFIG.fila.map(() => null); saidos = new Set();
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
    fecharCasa();
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
    raiz = palco = camAtores = camRot = camMarc = topo = rodape = cartao = tvPop = null;
    tela = telaCtx = null;
    bc = null;
    escId = null; escInfo = null; escNome = ''; escSeq++; marcadores = {}; elsMarc = new Set();
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
        chave: a.chave, origem: a.origem, dormindo: !!a.dormindo,
        lugar: a.lugar >= 0 && lugaresDescanso[a.lugar] ? [lugaresDescanso[a.lugar].x, lugaresDescanso[a.lugar].y] : null,
        fila: a.fila, pt: a.pt ? a.pt.tipo : '', externa: a.externa, compacta: a.compactando,
        ordens: a.ordens.length, tela: a.estacao ? a.estacao.e : '', dentro: a.dentro, alfa: a.alfa, visual: [a.vx, a.vy],
        balao: a.balao ? { k: a.balao.k, tit: a.balao.tit, txt: a.balao.txt } : null,
        icone: a.ik || '', balaoAberto: !!a.balVis,
      })),
      config: { pesquisa: CONFIG.pesquisa, fila: CONFIG.fila, balcao: CONFIG.balcao, passagem: passagemLider() },
      escritorio: { id: escId, status: escInfo ? escInfo.status : '', pausada: pausaEsc(), motivoPausa: escInfo ? escInfo.motivoPausa : '', nome: escNome },
      marcadores: camMarc ? {
        camada: !camMarc.hidden, placa: !marcadores.placa.hidden,
        fila: marcadores.fila.filter((e) => !camMarc.hidden && e.isConnected).length, balcao: !camMarc.hidden && !!marcadores.balcao,
        imagens: Object.fromEntries([...sondas].map(([k, s]) => [k, s.st])),
        imagens2x: Object.fromEntries([...sondas].map(([k, s]) => [k, !!s.src2x])),
      } : null,
      interacoes: interacoes.map((it) => ({ tipo: it.tipo, fase: it.fase, v: it.v.nome, h: it.h.nome, tv: it.tv, th: it.th })),
      historico: historicoInt.slice(),
      rotulos: rotulosDebug.map((r) => ({ ...r })),
      rotulosOcultos: rotOcultos, pixel: { ...px },
      casasPx: obstCasas.map((c) => ({ ...c })),
      avisos: avisosDebug.map((x) => ({ ...x })),
      telaCheia: !!(raiz && emTelaCheia()),
      mapa: tela ? tela.dataset.mapa || '' : '',
      painelTV: tvAberta,
      casa: bc && bc.area ? {
        id: bc.area.id, vila: bc.area.vila, nome: bc.nome.textContent, func: bc.func.textContent, lado: bc.el.dataset.lado,
        x: bc.x, y: bc.y, w: bc.el.offsetWidth, h: bc.el.offsetHeight, palcoW, palcoH, toque: bc.toque, interior: bc.el.dataset.int || '',
        agentes: [...bc.gente.children].map((e) => ({ id: e.dataset.id, nome: e.querySelector('b').textContent, estado: e.dataset.e, texto: e.querySelector('small').textContent })),
      } : null,
      casaDesenhos: bcDesenhos,
    };
  }

  // Miniatura parada da vila (t=0, sem robôs, casas apagadas) para o canvas de escritórios. Não monta palco nem mexe no
  // estado do Office. Cache por tamanho (só do mapa 'vila'; o 'simples' não fica guardado, para tentar de novo); devolve sempre cópia.
  const miniCache = new Map();
  function copiaCanvas(src) {
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    c.dataset.mapa = src.dataset.mapa;
    return c;
  }
  async function miniatura(op) {
    const W = Math.max(1, Math.round(Number(op && op.largura) || 192)), H = Math.max(1, Math.round(Number(op && op.altura) || 120));
    const chave = W + 'x' + H;
    if (miniCache.has(chave)) return copiaCanvas(miniCache.get(chave));
    await Vila.carregar(CONFIG.vila.base);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const antes = { ...Vila.ativo };
    for (const k of Object.keys(Vila.ativo)) Vila.ativo[k] = false;
    try {
      const mundo = Vila.desenhar(0); // canvas compartilhado: copiar já, antes de qualquer outra coisa
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(mundo, 0, 0, W, H);
    } finally { Object.assign(Vila.ativo, antes); }
    c.dataset.mapa = Vila.pronto ? 'vila' : 'simples';
    if (c.dataset.mapa === 'vila') miniCache.set(chave, c);
    return copiaCanvas(c);
  }

  window.Office = { montar, pausar, retomar, desmontar, escritorio, aoEscritorio, icone: iconeMarcador, miniatura, _debug, CONFIG, __versao: 1 };
})();

