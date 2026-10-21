// Recorta o robot-work-original.gif (480x270, fundo pontilhado) num quadrado com fundo transparente.
// Uso: ffmpeg -i assets/robot-work-original.gif -f rawvideo -pix_fmt rgb24 rw.rgb && node recortar-robot-work.mjs 24
//      ffmpeg -f rawvideo -pix_fmt rgba -s 204x204 -r 16 -i rw2.rgba -vf "scale=128:128:flags=area,split[a][b];[a]palettegen=reserve_transparent=1:stats_mode=full[p];[b][p]paletteuse=dither=none:alpha_threshold=128" -loop 0 assets/robot-work.gif
import fs from 'fs';
const W=480,H=270,b=fs.readFileSync('rw.rgb');const N=b.length/(W*H*3);
const L=204,X0=149,Y0=29,T=+process.argv[2]||22;
const out=Buffer.alloc(N*L*L*4);let dmax=0;
for(let f=0;f<N;f++){
  const base=f*H*W;
  // média 4x4 (período do pontilhado) via imagem integral
  const I=new Float64Array((W+1)*(H+1)*3);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++)for(let c=0;c<3;c++){const v=b[((base)+y*W+x)*3+c];I[((y+1)*(W+1)+x+1)*3+c]=v+I[(y*(W+1)+x+1)*3+c]+I[((y+1)*(W+1)+x)*3+c]-I[(y*(W+1)+x)*3+c]}
  const box=(x,y,c)=>{const xa=Math.max(0,x-2),ya=Math.max(0,y-2),xb=Math.min(W,x+2),yb=Math.min(H,y+2);return (I[(yb*(W+1)+xb)*3+c]-I[(ya*(W+1)+xb)*3+c]-I[(yb*(W+1)+xa)*3+c]+I[(ya*(W+1)+xa)*3+c])/((xb-xa)*(yb-ya))};
  const m=new Uint8Array(L*L),col=new Float32Array(L*L*3);
  for(let y=0;y<L;y++)for(let x=0;x<L;x++){const X=x+X0,Y=y+Y0;const r=box(X,Y,0),g=box(X,Y,1),bb=box(X,Y,2);col.set([r,g,bb],(y*L+x)*3);const d=Math.hypot(r-25,g-25,bb-25);if(x<20||y<5)dmax=Math.max(dmax,d);m[y*L+x]=d>T?1:0}
  const m2=new Uint8Array(L*L);for(let y=1;y<L-1;y++)for(let x=1;x<L-1;x++){let s=0;for(let j=-1;j<=1;j++)for(let k=-1;k<=1;k++)s+=m[(y+j)*L+x+k];m2[y*L+x]=s>=5?1:0}
  for(let y=0;y<L;y++)for(let x=0;x<L;x++)if(m2[y*L+x]){const o=((f*L+y)*L+x)*4,k=(y*L+x)*3;out[o]=col[k];out[o+1]=col[k+1];out[o+2]=col[k+2];out[o+3]=255}
}
fs.writeFileSync('rw2.rgba',out);console.log('ok; maior distância no fundo',dmax.toFixed(1));
