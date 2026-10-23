// Orbit — ícones SVG comuns ao PC e ao celular: 16×16, traço 1,5, currentColor. Script clássico, sem dependências:
// define só window.OrbitIcones = { icone(nome, tam = 16), nomes }. SVG montado com createElementNS (nada de innerHTML).
// O conjunto vem do index.html (ICONES); no fim ficam os que só o celular usava, redesenhados no mesmo traço.
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    return e;
  };
function caminhoEngrenagem() {
  const n = 32, pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2 - Math.PI / 32;
    const r = i % 4 < 2 ? 6.6 : 5.1;
    pts.push((8 + r * Math.cos(a)).toFixed(2) + ' ' + (8 + r * Math.sin(a)).toFixed(2));
  }
  return 'M' + pts.join('L') + 'Z';
}
const ICONES = {
  voltar: [['path', { d: 'M13 8H3.5' }], ['path', { d: 'M7.5 4 3.5 8l4 4' }]],
  busca: [['circle', { cx: 7, cy: 7, r: 4.5 }], ['path', { d: 'M10.5 10.5 13.5 13.5' }]],
  lua: [['path', { d: 'M13.2 9.9A5.6 5.6 0 0 1 6.1 2.8a5.6 5.6 0 1 0 7.1 7.1z' }]],
  grafo: [['circle', { cx: 4, cy: 4.5, r: 1.8 }], ['circle', { cx: 12, cy: 5.5, r: 1.8 }], ['circle', { cx: 7.5, cy: 12, r: 1.8 }], ['path', { d: 'M5.7 5l4.6.6M5 6.1l1.6 4.2M10.9 7.1 8.6 10.4' }]],
  quadro: [['rect', { x: 2, y: 2.8, width: 12, height: 8.4, rx: 1.5 }], ['path', { d: 'M5.6 14l1.1-2.8M10.4 14l-1.1-2.8M4.8 8.4l2-2 1.6 1.4 2.8-2.6' }]],
  pasta: [['path', { d: 'M2.5 4.5a1 1 0 0 1 1-1h2.8l1.4 1.5h4.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z' }]],
  historico: [['path', { d: 'M2.6 8a5.4 5.4 0 1 0 1.6-3.8' }], ['path', { d: 'M2.5 2.8v2.6h2.6' }], ['path', { d: 'M8 5.3v2.9l1.9 1.2' }]],
  sino: [['path', { d: 'M4.2 10.8V7.3a3.8 3.8 0 0 1 7.6 0v3.5l1.2 1.4H3z' }], ['path', { d: 'M6.6 13.6a1.5 1.5 0 0 0 2.8 0' }]],
  'sino-mudo': [['path', { d: 'M4.2 7.3a3.8 3.8 0 0 1 6.4-2.8M11.8 7.4v3.4l1.2 1.4H5' }], ['path', { d: 'M6.6 13.6a1.5 1.5 0 0 0 2.8 0' }], ['path', { d: 'M2.5 13.5l11-11' }]],
  engrenagem: [['path', { d: caminhoEngrenagem(), 'stroke-width': 1.3 }], ['circle', { cx: 8, cy: 8, r: 2.1 }]],
  ajuda: [['circle', { cx: 8, cy: 8, r: 6 }], ['path', { d: 'M6.4 6.3a1.7 1.7 0 1 1 2.4 1.6c-.5.2-.8.6-.8 1.1v.3' }], ['circle', { cx: 8, cy: 11.3, r: .55, fill: 'currentColor', stroke: 'none' }]],
  x: [['path', { d: 'M4.5 4.5l7 7M11.5 4.5l-7 7' }]],
  externo: [['path', { d: 'M9.5 2.5h4v4M13.5 2.5 7.8 8.2' }], ['path', { d: 'M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3' }]],
  terminal: [['rect', { x: 2, y: 3, width: 12, height: 10, rx: 1.5 }], ['path', { d: 'M5 6.5 7 8.2 5 9.9M8.5 10h2.5' }]],
  alfinete: [['path', { d: 'M6 2.5h4M7 2.5v3.8L4.8 8.8h6.4L9 6.3V2.5M8 8.8v4.7' }]],
  relogio: [['circle', { cx: 8, cy: 8, r: 5.8 }], ['path', { d: 'M8 5v3.2l2 1.3' }]],
  vassoura: [['path', { d: 'M13.5 2.5 9.2 6.8' }], ['path', { d: 'M7.3 6.1l2.6 2.6-.8 1.1c-1 1.3-2.7 2.3-5.1 2.7.4-2.4 1.4-4.1 2.7-5.1z' }], ['path', { d: 'M5.8 10.4 7 9.2M6.9 11.4l.9-.9' }], ['path', { d: 'M11.6 11.3h.01M13.2 12.4h.01M12.3 13.8h.01' }]],
  lixeira: [['path', { d: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.2' }]],
  chevron: [['path', { d: 'M6 3.8 10.2 8 6 12.2' }]],
  check: [['path', { d: 'M3.5 8.5l3 3 6-7' }]],
  'check-duplo': [['path', { d: 'M1.6 8.6l2.8 2.8 5.6-6.6' }], ['path', { d: 'M7.9 11.1l.3.3 5.6-6.6' }]],
  copiar: [['rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }], ['path', { d: 'M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5' }]],
  sub: [['circle', { cx: 4, cy: 4.5, r: 1.6 }], ['circle', { cx: 12, cy: 4.5, r: 1.6 }], ['circle', { cx: 8, cy: 12, r: 1.6 }], ['path', { d: 'M5.2 5.7 7 10.5M10.8 5.7 9 10.5' }]],
  grade: [['rect', { x: 2.5, y: 2.5, width: 4.5, height: 4.5, rx: 1 }], ['rect', { x: 9, y: 2.5, width: 4.5, height: 4.5, rx: 1 }], ['rect', { x: 2.5, y: 9, width: 4.5, height: 4.5, rx: 1 }], ['rect', { x: 9, y: 9, width: 4.5, height: 4.5, rx: 1 }]],
  painel: [['rect', { x: 2, y: 2.5, width: 12, height: 11, rx: 1.5 }], ['path', { d: 'M9.5 2.5v11' }]],
  alerta: [['path', { d: 'M8 2.5 14 13H2z' }], ['path', { d: 'M8 6.5v3' }], ['circle', { cx: 8, cy: 11.3, r: .5, fill: 'currentColor', stroke: 'none' }]],
  atividade: [['path', { d: 'M1.5 8.5h3l1.8-4.5 3.4 8.5 1.8-4h3' }]],
  arquivo: [['rect', { x: 2, y: 3, width: 12, height: 3, rx: .8 }], ['path', { d: 'M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.5 8.8h3' }]],
  balao: [['path', { d: 'M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5z' }]],
  doc: [['path', { d: 'M4 2.5h5l3 3v8H4z' }], ['path', { d: 'M8.8 2.5v3.2H12M6 9h4M6 11.3h3' }]],
  chave: [['path', { d: 'M10.2 2.6a3.2 3.2 0 0 0-3.7 4.3L2.6 10.8l2.6 2.6 3.9-3.9a3.2 3.2 0 0 0 4.3-3.7l-2 2-1.9-.5-.5-1.9z' }]],
  info: [['circle', { cx: 8, cy: 8, r: 6 }], ['path', { d: 'M8 7.3v3.7' }], ['circle', { cx: 8, cy: 5, r: .55, fill: 'currentColor', stroke: 'none' }]],
  cadeado: [['rect', { x: 3.5, y: 7, width: 9, height: 6.5, rx: 1.2 }], ['path', { d: 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2' }]],
  lista: [['path', { d: 'M6 4.5h7M6 8h7M6 11.5h7' }], ['circle', { cx: 3.2, cy: 4.5, r: .6, fill: 'currentColor' }], ['circle', { cx: 3.2, cy: 8, r: .6, fill: 'currentColor' }], ['circle', { cx: 3.2, cy: 11.5, r: .6, fill: 'currentColor' }]],
  play: [['path', { d: 'M5.5 3.8v8.4L12 8z' }]],
  parar: [['rect', { x: 4.5, y: 4.5, width: 7, height: 7, rx: 1.2 }]],
  teclado: [['rect', { x: 1.8, y: 4, width: 12.4, height: 8, rx: 1.5 }], ['path', { d: 'M4.5 6.6h.01M7 6.6h.01M9.5 6.6h.01M12 6.6h.01M5 9.5h6' }]],
  ampulheta: [['path', { d: 'M4 2.5h8M4 13.5h8M5 2.5c0 3 6 3 6 5.5S5 10.5 5 13.5M11 2.5c0 3-6 3-6 5.5s6 2.5 6 5.5' }]],
  raio: [['path', { d: 'M9 1.8 3.5 9h4L7 14.2 12.5 7h-4z' }]],
  comprimir: [['path', { d: 'M6 2.5v3.5H2.5M10 2.5v3.5h3.5M6 13.5V10H2.5M10 13.5V10h3.5' }]],
  borracha: [['path', { d: 'M9.2 2.8l4 4-6.4 6.4H4.3L2.8 11.7a1 1 0 0 1 0-1.4z' }], ['path', { d: 'M6.2 5.8l4 4M8 13.2h5.5' }]],
  branch: [['circle', { cx: 4.5, cy: 3.8, r: 1.5 }], ['circle', { cx: 4.5, cy: 12.2, r: 1.5 }], ['circle', { cx: 11.5, cy: 5.2, r: 1.5 }], ['path', { d: 'M4.5 5.3v5.4M11.5 6.7c0 2.8-7 2.2-7 4' }]],
  predio: [['rect', { x: 3, y: 2.5, width: 10, height: 11, rx: 1 }], ['path', { d: 'M5.8 5.3h1M9.2 5.3h1M5.8 8h1M9.2 8h1M7 13.5v-2.6h2v2.6' }]],
  lapis: [['path', { d: 'M10.6 2.9a1.5 1.5 0 0 1 2.1 0l.4.4a1.5 1.5 0 0 1 0 2.1L6 12.5l-3.2.7.7-3.2z' }], ['path', { d: 'M9.3 4.2l2.5 2.5' }]],
  lampada: [['path', { d: 'M6 11.3c0-1.3-2-2.4-2-4.8a4 4 0 0 1 8 0c0 2.4-2 3.5-2 4.8z' }], ['path', { d: 'M6.4 13.6h3.2' }]],
  varinha: [['path', { d: 'M2.8 13.2 9.6 6.4' }], ['path', { d: 'M8.6 5.4l2 2' }], ['path', { d: 'M11.8 1.8v2.4M10.6 3h2.4M13.6 6.8v1.6M12.8 7.6h1.6M5.6 2.2v1.6M4.8 3h1.6' }]], // aba Skills
  mais: [['path', { d: 'M8 3v10M3 8h10' }]],
  menos: [['path', { d: 'M3 8h10' }]],
  instalar: [['path', { d: 'M8 2.5v7M5 6.7l3 3 3-3' }], ['path', { d: 'M2.5 10.5v1.8a1.2 1.2 0 0 0 1.2 1.2h8.6a1.2 1.2 0 0 0 1.2-1.2v-1.8' }]],
  pontos: [['circle', { cx: 3.5, cy: 8, r: .9, fill: 'currentColor', stroke: 'none' }], ['circle', { cx: 8, cy: 8, r: .9, fill: 'currentColor', stroke: 'none' }], ['circle', { cx: 12.5, cy: 8, r: .9, fill: 'currentColor', stroke: 'none' }]],
  // Ícones de projeto (escolhidos em "Personalizar projeto")
  codigo: [['path', { d: 'M5.3 4.6 1.9 8l3.4 3.4M10.7 4.6 14.1 8l-3.4 3.4M9.1 3 6.9 13' }]],
  foguete: [['path', { d: 'M8 1.9c2.4 1.5 3.5 4.1 3 7.1l-1.3 1.7H6.3L5 9c-.5-3 .6-5.6 3-7.1z' }], ['circle', { cx: 8, cy: 6.2, r: 1.2 }], ['path', { d: 'M5.1 9.4 3.2 11.3l2.5.4M10.9 9.4l1.9 1.9-2.5.4M7.1 12.8 8 14.3l.9-1.5' }]],
  robo: [['rect', { x: 3, y: 5.2, width: 10, height: 7.8, rx: 2 }], ['path', { d: 'M8 5.2V3.3M6.3 10.8h3.4M1.8 8.3v2M14.2 8.3v2' }], ['circle', { cx: 8, cy: 2.6, r: .7 }], ['circle', { cx: 6, cy: 8.4, r: .6, fill: 'currentColor' }], ['circle', { cx: 10, cy: 8.4, r: .6, fill: 'currentColor' }]],
  cubo: [['path', { d: 'M8 1.9 13.4 5v6L8 14.1 2.6 11V5z' }], ['path', { d: 'M2.6 5 8 8.1 13.4 5M8 8.1v6' }]],
  globo: [['circle', { cx: 8, cy: 8, r: 6 }], ['path', { d: 'M2 8h12M8 2c1.7 1.7 2.5 3.7 2.5 6S9.7 12.3 8 14M8 2C6.3 3.7 5.5 5.7 5.5 8s.8 4.3 2.5 6' }]],
  casa: [['path', { d: 'M2.5 7.3 8 2.6l5.5 4.7v5.7a.6.6 0 0 1-.6.6H9.6V10H6.4v3.6H3.1a.6.6 0 0 1-.6-.6z' }]],
  carrinho: [['path', { d: 'M1.8 2.8h1.9l1.6 7.3h6.9l1.5-5.1H4.3' }], ['circle', { cx: 6.2, cy: 12.8, r: .9 }], ['circle', { cx: 11.4, cy: 12.8, r: .9 }]],
  grafico: [['path', { d: 'M2.5 13.5h11M4.6 11V8.2M8 11V4.5M11.4 11V6.6' }]],
  livro: [['path', { d: 'M8 4.3C6.8 3.3 5 2.9 2.5 3v9.4c2.5-.1 4.3.3 5.5 1.3 1.2-1 3-1.4 5.5-1.3V3C11 2.9 9.2 3.3 8 4.3zM8 4.3v9.4' }]],
  paleta: [['path', { d: 'M8 2a6 6 0 0 0 0 12c.9 0 1.4-.6 1.4-1.3 0-.9-.8-1.2-.8-2s.6-1.3 1.4-1.3H12a2 2 0 0 0 2-2C14 4.4 11.3 2 8 2z' }], ['circle', { cx: 5, cy: 7.2, r: .7, fill: 'currentColor' }], ['circle', { cx: 7.3, cy: 4.7, r: .7, fill: 'currentColor' }], ['circle', { cx: 10.5, cy: 5.2, r: .7, fill: 'currentColor' }]],
  camera: [['rect', { x: 2, y: 4.6, width: 12, height: 8.6, rx: 1.6 }], ['path', { d: 'M5.6 4.6l1-1.8h2.8l1 1.8' }], ['circle', { cx: 8, cy: 8.9, r: 2.3 }]],
  musica: [['path', { d: 'M6 12.2V3.6l7-1.4v8.4' }], ['circle', { cx: 4.4, cy: 12.2, r: 1.6 }], ['circle', { cx: 11.4, cy: 10.6, r: 1.6 }]],
  jogo: [['path', { d: 'M4.6 5h6.8a3 3 0 0 1 2.9 3.8l-.7 2.5a1.5 1.5 0 0 1-2.6.6L9.6 10.5H6.4L5 11.9a1.5 1.5 0 0 1-2.6-.6l-.7-2.5A3 3 0 0 1 4.6 5z' }], ['path', { d: 'M5 6.9v2.2M3.9 8h2.2' }], ['circle', { cx: 10.6, cy: 7.4, r: .6, fill: 'currentColor' }], ['circle', { cx: 11.8, cy: 8.8, r: .6, fill: 'currentColor' }]],
  coracao: [['path', { d: 'M8 13.4S2.4 10.2 2.4 6.2A2.9 2.9 0 0 1 8 5a2.9 2.9 0 0 1 5.6 1.2c0 4-5.6 7.2-5.6 7.2z' }]],
  estrela: [['path', { d: 'M8 2.1l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.3l-3.6 1.9.7-4-2.9-2.8 4-.6z' }]],
  folha: [['path', { d: 'M3 13c0-6 3.6-9.9 10.5-10.4C13 9.5 9 13 3 13zM3 13l5.6-5.6' }]],
  // Do celular (antes com traço 1,7 e um só path): enviar, foto, uso, aparelho, visão geral e setas de dobra.
  enviar: [['path', { d: 'M8 13V3.5' }], ['path', { d: 'M4 7.5 8 3.5l4 4' }]],
  foto: [['rect', { x: 2, y: 3, width: 12, height: 10, rx: 1.5 }], ['circle', { cx: 5.6, cy: 6.6, r: 1.1 }], ['path', { d: 'M2.5 12l3.6-3.6 2.4 2.4 1.8-1.8 3.2 3.2' }]],
  uso: [['path', { d: 'M3.5 13V8.5M8 13V3M12.5 13V6' }]],
  aparelho: [['rect', { x: 4.5, y: 1.8, width: 7, height: 12.4, rx: 1.5 }], ['path', { d: 'M7 12h2' }]],
  visao: [['rect', { x: 2.5, y: 2.5, width: 4.5, height: 5.5, rx: 1 }], ['rect', { x: 9, y: 2.5, width: 4.5, height: 3, rx: 1 }], ['rect', { x: 9, y: 7.5, width: 4.5, height: 6, rx: 1 }], ['rect', { x: 2.5, y: 10, width: 4.5, height: 3.5, rx: 1 }]],
  'chevron-baixo': [['path', { d: 'M3.8 6 8 10.2 12.2 6' }]],
  'chevron-cima': [['path', { d: 'M3.8 10 8 5.8l4.2 4.2' }]],
  'chevron-esq': [['path', { d: 'M10 3.8 5.8 8l4.2 4.2' }]],
  atualizar: [['path', { d: 'M13 8a5 5 0 1 1-1.6-3.7' }], ['path', { d: 'M13 2.8v2.6h-2.6' }]],
};
  function icone(nome, tam = 16) {
    const v = sv('svg', { viewBox: '0 0 16 16', width: tam, height: tam, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' });
    for (const [t, a] of ICONES[nome] || []) v.append(sv(t, a));
    v.dataset.i = nome;
    return v;
  }
  window.OrbitIcones = { icone, nomes: Object.keys(ICONES) };
})();
