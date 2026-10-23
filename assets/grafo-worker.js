// Worker da física do Grafo: roda GrafoFisica a 60 Hz (setTimeout) enquanto a simulação estiver quente
// e devolve {tipo:'pos', pos (Float32Array transferida), alpha}.
// Mensagens aceitas:
//   {tipo:'dados', nos, links}         → troca os dados; alpha sobe para 0,3
//   {tipo:'forcas', forcas}            → valores SALVOS dos sliders; alpha sobe para 0,3
//   {tipo:'fixar', i, x, y}            → arraste: fixa o nó; alpha e alvo 0,3
//   {tipo:'soltar', i}                 → solta o nó; alvo 0
//   {tipo:'aquecer', alpha, alvo}      → reaquecimento manual
/* global importScripts, GrafoFisica */
'use strict';
importScripts('grafo-fisica.js');

const INTERVALO = 1000 / 60;
const sim = GrafoFisica.criar();
let relogio = null;

function enviar() {
  const pos = sim.pos.slice(); // cópia: o buffer original continua com a simulação
  self.postMessage({ tipo: 'pos', pos, alpha: sim.alpha }, [pos.buffer]);
}

function passo() {
  relogio = null;
  if (!sim.ativa()) return;
  sim.tick();
  enviar();
  agendar();
}

let parada = false; // {tipo:'pausar'} / {tipo:'retomar'}: o widget da Home fora da tela (21/10)
function agendar() {
  if (relogio === null && !parada && sim.ativa()) relogio = setTimeout(passo, INTERVALO);
}

self.onmessage = (ev) => {
  const msg = ev.data || {};
  switch (msg.tipo) {
    case 'dados':
      sim.definirDados({ nos: msg.nos || [], links: msg.links || [] });
      sim.aquecer(0.3);
      enviar(); // posições iniciais dos nós novos, antes do primeiro tick
      break;
    case 'forcas':
      sim.definirForcas(msg.forcas || {});
      sim.aquecer(0.3);
      break;
    case 'fixar':
      sim.fixar(msg.i, msg.x, msg.y);
      sim.aquecer(0.3, 0.3);
      break;
    case 'soltar':
      sim.soltar(msg.i);
      sim.aquecer(undefined, 0);
      break;
    case 'aquecer':
      sim.aquecer(msg.alpha, msg.alvo);
      break;
    case 'pausar':
      parada = true;
      clearTimeout(relogio);
      relogio = null;
      return;
    case 'retomar':
      parada = false;
      break;
    default:
      return;
  }
  agendar();
};
