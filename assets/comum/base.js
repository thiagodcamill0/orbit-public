// Orbit — lógica visual comum ao PC (index.html) e ao celular (mobile/index.html). Script clássico, sem dependências:
// define só window.OrbitBase (nada solto no escopo global). Carregar ANTES do código da página.
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    return e;
  };

  // ===== Status das sessões (e dos subagentes: "concluido") =====
  // Cor do ponto de cada status (= tokens --trab, --agu, --ok, --erro, --int, --enc do base.css).
  const COR_STATUS = {
    trabalhando: '#0090ff', aguardando: '#ffc53d', concluida: '#30a46c', erro: '#e5484d',
    interrompida: '#6e56cf', encerrada: '#696e77', nova: '#a3a3a6', lembrete: '#ffc53d', concluido: '#30a46c', fantasma: '#6e6e73',
  };
  const ROTULO_STATUS = {
    nova: 'Nova', trabalhando: 'Trabalhando', aguardando: 'Aguardando você', concluida: 'Concluída',
    erro: 'Erro', interrompida: 'Interrompida', encerrada: 'Encerrada',
  };
  const ROTULO_AGENTE = { trabalhando: 'Trabalhando', aguardando: 'Aguardando', concluido: 'Concluído', erro: 'Erro' };

  // Ponto do status (SVG 16×16 desenhado em `tam` px): anel girando (trabalhando), ponto com halo (aguardando),
  // check (concluída), x (erro), quadrado (interrompida), anel (encerrada), anel tracejado (nova e o resto).
  function pontoStatus(st, tam = 10) {
    const v = sv('svg', { viewBox: '0 0 16 16', width: tam, height: tam, 'aria-hidden': 'true', focusable: 'false' });
    const c = COR_STATUS[st] || COR_STATUS.nova;
    const traco = { fill: 'none', stroke: '#111112', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    switch (st) {
      case 'trabalhando':
        v.classList.add('girando');
        v.append(sv('circle', { cx: 8, cy: 8, r: 5.5, fill: 'none', stroke: c, 'stroke-opacity': .3, 'stroke-width': 2.6 }),
          sv('path', { d: 'M8 2.5a5.5 5.5 0 0 1 5.5 5.5', fill: 'none', stroke: c, 'stroke-width': 2.6, 'stroke-linecap': 'round' }));
        break;
      case 'aguardando': case 'lembrete':
        v.append(sv('circle', { cx: 8, cy: 8, r: 7.5, fill: c, 'fill-opacity': .3 }), sv('circle', { cx: 8, cy: 8, r: 4.2, fill: c }));
        break;
      case 'concluida': case 'concluido':
        v.append(sv('circle', { cx: 8, cy: 8, r: 7.5, fill: c }), sv('path', { d: 'M4.8 8.3l2.2 2.2 4.2-4.6', ...traco }));
        break;
      case 'erro':
        v.append(sv('circle', { cx: 8, cy: 8, r: 7.5, fill: c }), sv('path', { d: 'M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8', ...traco }));
        break;
      case 'interrompida':
        v.append(sv('rect', { x: 2.5, y: 2.5, width: 11, height: 11, rx: 2.5, fill: c }));
        break;
      case 'encerrada':
        v.append(sv('circle', { cx: 8, cy: 8, r: 5.8, fill: 'none', stroke: c, 'stroke-width': 2.2 }));
        break;
      default:
        v.append(sv('circle', { cx: 8, cy: 8, r: 5.8, fill: 'none', stroke: c, 'stroke-width': 2.2, 'stroke-dasharray': '2.3 2.3' }));
    }
    return v;
  }
  // Selo de status (.pilula do base.css) com o ponto e o rótulo (padrão: ROTULO_STATUS).
  function pilula(st, rotulo, pequena) {
    const el = document.createElement('span');
    el.className = 'pilula' + (pequena ? ' p' : '');
    el.dataset.s = st;
    el.append(pontoStatus(st, pequena ? 9 : 10), rotulo ?? ROTULO_STATUS[st] ?? st);
    return el;
  }

  // ===== Escala de cores das barras (uso e contexto) =====
  // Pontos [fração 0–1, cor]; a cor é um token ('--uso-verde') ou uma cor CSS. Cor pura em cada ponto, mistura em
  // OKLab entre eles (sem degrau). Verde de 0 a 45% · amarelo em 50% · vermelho em 75% · roxo em 100%.
  const ESCALA_USO = [[0, '--uso-verde'], [0.45, '--uso-verde'], [0.50, '--uso-amarelo'], [0.75, '--uso-vermelho'], [1, '--uso-roxo']];
  const cor = (c) => (c.startsWith('--') ? 'var(' + c + ')' : c);
  function corEscala(p, escala = ESCALA_USO) {
    const e = escala;
    if (p <= e[0][0]) return cor(e[0][1]);
    for (let k = 1; k < e.length; k++) {
      if (p <= e[k][0]) {
        const t = Math.round(((p - e[k - 1][0]) / (e[k][0] - e[k - 1][0])) * 100);
        return 'color-mix(in oklab, ' + cor(e[k][1]) + ' ' + t + '%, ' + cor(e[k - 1][1]) + ')';
      }
    }
    return cor(e[e.length - 1][1]);
  }
  // Degradê da escala de 0 até `ate`, esticado na largura de `el`: começa no verde e termina na cor de `ate`
  // (com ate = 1 é a escala inteira, para legenda). Grava em el.style.background.
  function degradeEscala(el, ate = 1, escala = ESCALA_USO) {
    const a = Math.max(0.01, Math.min(1, ate));
    const paradas = escala.filter(([p]) => p < a).map(([p, c]) => cor(c) + ' ' + Math.round((p / a) * 1000) / 10 + '%');
    paradas.push(corEscala(a, escala) + ' 100%');
    el.style.background = 'linear-gradient(to right, ' + paradas.join(', ') + ')';
    el.style.background = 'linear-gradient(to right in oklab, ' + paradas.join(', ') + ')';
  }
  // Faixa da barra de contexto (.ctx-l.medio / .alto): acima de 85% (ou acima do limite) alto, acima de 60% médio.
  const faixaUso = (pct, acima) => (acima || pct > 0.85 ? 'alto' : pct > 0.6 ? 'medio' : '');
  // Barra de uso pronta (.ctx-l do base.css): pct de 0 a 1; texto à direita (padrão: "N%").
  function barraUso(pct, texto, acima) {
    const n = Math.round(pct * 100);
    const faixa = faixaUso(pct, acima);
    const l = document.createElement('div');
    l.className = 'ctx-l' + (faixa ? ' ' + faixa : '');
    const b = document.createElement('span');
    b.className = 'ctx-b';
    const i = document.createElement('i');
    i.style.width = (acima ? 100 : Math.max(3, n)) + '%';
    b.append(i);
    const t = document.createElement('span');
    t.textContent = texto ?? n + '%';
    l.append(b, t);
    return l;
  }

  // ===== Sprites dos agentes (assets/sprites/<nome>.gif|png) por estado =====
  // Só o trabalho tem variantes: a sorteada vale para o ciclo de trabalho inteiro.
  const SPRITE = {
    trabalho: ['sprites/sprite-work', 'sprites/sprite-think', 'sprites/sprite-wizark', 'sprites/sprite-cook'], // 22/10: wizark e cook viraram variantes (antes: degraus de contexto)
    busca: ['sprites/sprite-search'], // web ou procura (Grep, Glob, ToolSearch...)
    espera: ['sprites/sprite-music'], // subagente trabalhando com a principal parada
    precisa: ['sprites/sprite-needu'], // aguardando (decisão sua) e erro
    concluida: ['sprites/sprite-done'],
    revisada: ['sprites/sprite-done-parado'],
    interrompida: ['sprites/sprite-work-parado'],
    dormindo: ['sprites/sprite-sleep'], // nova e encerrada
  };
  const FERR_BUSCA = new Set(['WebSearch', 'WebFetch', 'Grep', 'Glob', 'LS', 'ToolSearch']);
  const ehBusca = (f) => !!(f && f.nome) && (FERR_BUSCA.has(f.nome) || /^mcp__.*(search|fetch|find|query|busca)/i.test(f.nome));
  const ehDelegacao = (f) => !!f && (f.nome === 'Agent' || f.nome === 'Task');
  // Estado do sprite (chave de SPRITE) a partir do status e do que a página sabe da sessão:
  //   info = { agente (é subagente?), ferramenta ({ nome } em curso), subTrabalhando (algum subagente trabalhando),
  //            revisada (concluída já revisada) }
  function estadoSprite(st, info = {}) {
    if (info.agente) {
      if (st === 'trabalhando') return ehBusca(info.ferramenta) ? 'busca' : 'trabalho';
      return st === 'concluido' ? 'concluida' : 'precisa';
    }
    switch (st) {
      case 'trabalhando': {
        if (info.subTrabalhando && ehDelegacao(info.ferramenta)) return 'espera';
        return ehBusca(info.ferramenta) ? 'busca' : 'trabalho';
      }
      case 'concluida': return info.subTrabalhando ? 'espera' : info.revisada ? 'revisada' : 'concluida';
      case 'interrompida': return 'interrompida';
      case 'aguardando': case 'erro': return 'precisa';
      default: return 'dormindo';
    }
  }

  window.OrbitBase = Object.freeze({
    COR_STATUS, ROTULO_STATUS, ROTULO_AGENTE, pontoStatus, pilula,
    ESCALA_USO, corEscala, degradeEscala, faixaUso, barraUso,
    SPRITE, FERR_BUSCA, ehBusca, ehDelegacao, estadoSprite,
  });
})();
