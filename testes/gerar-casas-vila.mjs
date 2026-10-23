// Gera as casas desenhadas do Office (assets/vila/casas/<id>.png) a partir das artes grandes originais.
// Uso: node testes/gerar-casas-vila.mjs [pasta]   (padrão: D:\Downloads\RPG Assets\Houses\Casas_Prontas)
// Para cada casa com "<nome>-new.png" (ou "_new"): recorta a margem transparente, reduz na escala do mapa
// (ESCALA px da arte = 1 px da vila, ou a escala própria da casa, média por área) e corta o alfa em 0/255 para a borda ficar nítida.
// No fim imprime a linha de cada casa para o CONFIG.casas do assets/office.js (tamanho e porta).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGEM = process.argv[2] || 'D:\\Downloads\\RPG Assets\\Houses\\Casas_Prontas';
const DESTINO = path.join(RAIZ, 'assets', 'vila', 'casas');
const ESCALA = 7.5;
// nome do arquivo → id da casa no mapa; porta = centro da porta na largura do desenho recortado (0 a 1)
const CASAS = {
  guilda: { id: 'guild', porta: 0.5, escala: 4.7 }, // maior: é o salão principal (ocupa a praça entre as trilhas oeste e leste)
  torre_dos_magos: { id: 'tower', porta: 0.44 },
  forja: { id: 'forge', porta: 0.673 },
  taverna: { id: 'tavern', porta: 0.546 },
  serraria: { id: 'sawmill', porta: 0.823 },
  estufa: { id: 'greenhouse', porta: 0.537 },
  cabana: { id: 'hut', porta: 0.5 },
};

function ler(p) {
  const b = fs.readFileSync(p);
  let o = 8, w, h, ct, bd;
  const id = [];
  while (o < b.length) {
    const n = b.readUInt32BE(o), t = b.toString('ascii', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + n);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; if (d[12]) throw new Error(p + ': PNG entrelaçado'); }
    else if (t === 'IDAT') id.push(d);
    o += 12 + n;
  }
  if (bd !== 8 || ct !== 6) throw new Error(p + ': só RGBA de 8 bits');
  const raw = zlib.inflateSync(Buffer.concat(id)), st = w * 4, px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (st + 1)], s = y * (st + 1) + 1;
    for (let x = 0; x < st; x++) {
      const a = x >= 4 ? px[y * st + x - 4] : 0, u = y ? px[(y - 1) * st + x] : 0, c = x >= 4 && y ? px[(y - 1) * st + x - 4] : 0;
      let v = raw[s + x];
      if (f === 1) v += a;
      else if (f === 2) v += u;
      else if (f === 3) v += (a + u) >> 1;
      else if (f === 4) { const q = a + u - c, pa = Math.abs(q - a), pb = Math.abs(q - u), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? u : c; }
      px[y * st + x] = v & 255;
    }
  }
  return { w, h, px };
}

const TAB = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const x of b) c = TAB[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function gravar(p, { w, h, px }) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const bloco = (t, d) => {
    const td = Buffer.concat([Buffer.from(t), d]), l = Buffer.alloc(4), c = Buffer.alloc(4);
    l.writeUInt32BE(d.length); c.writeUInt32BE(crc(td));
    return Buffer.concat([l, td, c]);
  };
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  fs.writeFileSync(p, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), bloco('IHDR', ih), bloco('IDAT', zlib.deflateSync(raw, { level: 9 })), bloco('IEND', Buffer.alloc(0))]));
}

function recortar({ w, h, px }) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 64) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, cw: x1 - x0 + 1, ch: y1 - y0 + 1 };
}

// média por área (cor pesada pelo alfa); alfa final 0 ou 255
function reduzir(I, { x0, y0, cw, ch }, escala = ESCALA) {
  const w = Math.round(cw / escala), h = Math.round(ch / escala), px = Buffer.alloc(w * h * 4);
  const kx = cw / w, ky = ch / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let yy = Math.floor(y0 + y * ky); yy < Math.floor(y0 + (y + 1) * ky); yy++)
      for (let xx = Math.floor(x0 + x * kx); xx < Math.floor(x0 + (x + 1) * kx); xx++) {
        const i = (yy * I.w + xx) * 4, al = I.px[i + 3];
        r += I.px[i] * al; g += I.px[i + 1] * al; b += I.px[i + 2] * al; a += al; n++;
      }
    const o = (y * w + x) * 4;
    if (a / n >= 128) { px[o] = r / a; px[o + 1] = g / a; px[o + 2] = b / a; px[o + 3] = 255; }
  }
  return { w, h, px };
}

fs.mkdirSync(DESTINO, { recursive: true });
const linhas = [];
for (const arq of fs.readdirSync(ORIGEM)) {
  const m = /^(.+?)[-_]new\.png$/i.exec(arq);
  if (!m) continue;
  const casa = CASAS[m[1].toLowerCase()];
  if (!casa) { console.log('ignorado (casa desconhecida):', arq); continue; }
  const I = ler(path.join(ORIGEM, arq));
  const S = reduzir(I, recortar(I), casa.escala);
  gravar(path.join(DESTINO, casa.id + '.png'), S);
  linhas.push(`      ${casa.id}: { w: ${S.w}, h: ${S.h}, porta: ${Math.round(S.w * casa.porta)} },`);
  console.log(arq, '→', `assets/vila/casas/${casa.id}.png`, `${S.w}x${S.h}`);
}
console.log('\nCONFIG.casas:\n' + linhas.join('\n'));
