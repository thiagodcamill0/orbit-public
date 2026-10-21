import json, pathlib, shutil
from PIL import Image, ImageDraw

import os, subprocess, sys
# OFFICE_VAZIO=1: só salas, piso e corredor (sem móveis nem estações) em assets/office/base/,
# a base em que testes/aplicar-assets-office.py cola as peças separadas.
VAZIO=os.environ.get('OFFICE_VAZIO')=='1'
PROJECT=pathlib.Path(__file__).resolve().parents[1]
ROOT=PROJECT
source="const fs=require('fs'),vm=require('vm');const ctx={window:{}};vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),ctx);console.log(JSON.stringify(ctx.window.Office.CONFIG));"
cfg=json.loads(subprocess.check_output(['node','-e',source,str(PROJECT/'assets/office.js')],text=True,encoding='utf8'))
# All scene geometry is authored on a 960 × 560 pixel grid and enlarged by nearest
# neighbour. Monitor glass and desk bounds are the explicitly specified exceptions.
im=Image.new('RGB',(960,560),'#111111'); d=ImageDraw.Draw(im)
def rect(x,y,w,h,c,outline=None):
 d.rectangle((int(x/2),int(y/2),int((x+w)/2)-1,int((y+h)/2)-1),fill=c,outline=outline)
def line(x,y,x2,y2,c): d.line((int(x/2),int(y/2),int(x2/2),int(y2/2)),fill=c)
def ellipse(x,y,w,h,c,outline=None): d.ellipse((int(x/2),int(y/2),int((x+w)/2)-1,int((y+h)/2)-1),fill=c,outline=outline)
def box(x,y,w,h,c='#202020',edge='#343434'):
 rect(x,y+2,w,h,'#0e0e0e');rect(x,y,w,h,c,edge)
 if w>8 and h>8: line(x+4,y+2,x+w-6,y+2,'#2c2c2c')
def plant(x,y):
 ellipse(x+8,y+10,24,26,'#101310');ellipse(x+10,y+10,22,22,'#171717','#343434')
 for dx,dy in [(6,14),(12,4),(22,12),(16,22)]:
  ellipse(x+dx,y+dy,12,12,'#1c3b2a');rect(x+dx+4,y+dy+2,4,6,'#2c6345')
 rect(x+18,y+16,6,8,'#2f6b47')
# Tester: a compact QA lab. All coordinates remain inside CONFIG footprints.
def tester_plant(x,y):
 box(x+10,y+12,22,22,'#202020','#3a3a3a')
 rect(x+14,y+16,14,14,'#151a16')
 for dx,dy in [(6,14),(12,6),(22,10),(22,22),(10,24)]:
  rect(x+dx,y+dy,8,10,'#1c3b2a');rect(x+dx+2,y+dy,4,6,'#2c6345')
 rect(x+18,y+16,6,10,'#2f6b47')

def tester_furniture(m):
 x,y=m['x']*40,m['y']*40;w,h=m.get('w',1)*40,m.get('h',1)*40
 t=m.get('arte',m['tipo'])
 if t=='planta':tester_plant(x,y);return
 if t=='arquivo':
  box(x+4,y+4,w-8,h-8,'#222222','#3a3a3a')
  rect(x+8,y+8,w-16,4,'#513a46')
  for yy in range(y+16,y+h-12,18):
   rect(x+8,yy,w-16,14,'#191919','#343434')
   rect(x+12,yy+4,8,6,'#333333');rect(x+24,yy+6,4,2,'#57504f')
  rect(x+8,y+h-10,w-16,2,'#414141')
 elif t=='checklist':
  # Board, then a shallow closed instrument drawer: no extra display.
  box(x+4,y+4,w-8,72,'#202020','#3a3a3a')
  rect(x+14,y+2,12,6,'#444444')
  for yy in range(y+14,y+66,12):
   rect(x+8,yy,6,6,'#171717','#464646')
   line(x+8,yy+2,x+10,yy+4,'#65615f');line(x+10,yy+4,x+14,yy,'#65615f')
   rect(x+18,yy+2,12,2,'#444444')
  box(x+4,y+84,w-8,32,'#252525','#3a3a3a')
  rect(x+8,y+88,w-16,4,'#513a46');rect(x+14,y+102,12,2,'#4a4a4a')
 elif t=='bancada':
  box(x+4,y+4,w-8,h-8,'#242424','#3a3a3a')
  # Recessed work mats; phone, tablet, and two CLOSED notebooks.
  for k in range(4):rect(x+8+k*36,y+8,32,24,'#191919','#303030')
  box(x+18,y+10,12,20,'#303030','#4a4a4a');rect(x+20,y+12,8,14,'#0c0c0c');rect(x+22,y+28,4,2,'#55504f')
  box(x+50,y+10,22,20,'#303030','#4a4a4a');rect(x+52,y+12,18,14,'#0c0c0c')
  for xx in [x+82,x+118]:
   box(xx,y+12,28,18,'#343434','#4a4a4a');line(xx+2,y+26,xx+24,y+26,'#191919');rect(xx+12,y+18,4,2,'#464040')
  rect(x+8,y+32,w-16,2,'#4b3540')

def tester_station(e):
 mx,my=(e['x']-1)*40,(e['y']-1)*40;cx=e['x']*40+20;cy=e['y']*40+17
 # Compact seat, dark shell and low back, wholly within the station cell.
 ellipse(cx-12,cy-12,24,24,'#191919','#303030')
 rect(cx-8,cy-8,16,14,'#232323');rect(cx-8,cy+6,16,4,'#363033')
 box(mx+4,my+4,112,32,'#1d1d1d','#343434')
 rect(mx+8,my+28,26,2,'#513a46')
 rect(cx-16,my+22,32,8,'#191919','#303030')
 for xx in range(cx-12,cx+12,4):rect(xx,my+24,2,2,'#3a3a3a')
 rect(cx+22,my+24,4,6,'#2d2d2d')
 # Unlit monitor; exact glass is restored after nearest-neighbour enlargement.
 box(mx+84,my+2,34,26,'#202020','#343434')
 rect(mx+86,my+6,30,20,'#0c0c0c')

def furniture(m,a):
 if a['id']=='tester':tester_furniture(m);return
 x,y=m['x']*40,m['y']*40;w,h=m.get('w',1)*40,m.get('h',1)*40
 t=m.get('arte',m['tipo']);accent={'frontend':'#344b56','mestre':'#44465f','backend':'#53415d','tester':'#59404f','pesquisador':'#31534d'}.get(a['id'],'#444444')
 if t=='planta':plant(x,y);return
 if t=='tapete':
  rect(x+4,y+4,w-8,h-8,'#19191d');rect(x+8,y+8,w-16,h-16,'#17171b','#1d1d23');return
 if t=='puff':
  ellipse(x+4,y+6,32,30,'#183530','#28534c');ellipse(x+8,y+8,24,20,'#20423c');line(x+18,y+12,x+20,y+28,'#2b5148');return
 if t=='sofa':
  box(x+4,y+4,w-8,h-8,'#26263f','#38384e')
  rect(x+8,y+(26 if m.get('encosto')=='baixo' else 6),w-16,8,'#30304a')
  for k in range(1,4):line(x+k*40,y+14,x+k*40,y+26,'#39394e')
  rect(x+6,y+10,8,20,'#303047');rect(x+w-14,y+10,8,20,'#303047');return
 if t=='pingpong':
  box(x+4,y+4,w-8,h-8,'#11231a','#2a5a3e');rect(x+8,y+8,w-16,h-16,'#11231a','#2a5a3e')
  line(x+8,y+h/2,x+w-10,y+h/2,'#2a5a3e');rect(x+w/2-2,y+4,4,h-8,'#687078')
  for yy in range(y+8,y+h-8,6):rect(x+w/2,yy,2,2,'#9ca3af')
  return
 box(x+4,y+4,w-8,h-8)
 if t=='lousa':
  rect(x+8,y+8,w-16,h-16,'#181818','#3a3a3a')
  if a['id']=='mestre':
   for xx in range(x+16,x+w-20,40):
    rect(xx,y+12,24,2,'#4a4a4a');rect(xx,y+18,16,4,'#343434');rect(xx,y+26,20,4,'#303030')
  else:
   rect(x+14,y+12,32,16,'#202020','#444444');rect(x+50,y+12,42,4,'#414141');rect(x+50,y+20,22,8,'#303030');rect(x+98,y+12,40,16,'#202020','#3a3a3a')
 elif t in ('estante','arquivo','rack','checklist','globo'):
  if t=='globo':
   ellipse(x+6,y+10,28,28,'#283b37','#42554c');line(x+20,y+12,x+20,y+34,'#4a5b52');line(x+8,y+24,x+30,y+24,'#42554c');rect(x+16,y+40,8,26,'#333333')
  elif t=='estante':
   if h>w:
    for yy in range(y+10,y+h-10,10):rect(x+10,yy,20,6,accent if yy%30 else '#3b3b3b')
   else:
    for xx in range(x+10,x+w-10,10):rect(xx,y+10,6,20,accent if xx%30 else '#3b3b3b')
  elif t=='rack':
   for yy in range(y+10,y+h-8,12):
    rect(x+8,yy,w-16,8,'#161616','#303030');rect(x+w-14,yy+2,4,2,accent)
    for xx in range(x+12,x+w-18,4):rect(xx,yy+2,2,4,'#353535')
  else:
   for yy in range(y+12,y+h-10,20):
    rect(x+8,yy,w-16,14,'#242424','#383838');rect(x+16,yy+6,8,2,'#4a4a4a')
 elif t=='bancada':
  for k in range(4):
   ww=[12,20,28,28][k];box(x+10+k*40,y+10,ww,20,'#171717','#444444');rect(x+14+k*40,y+14,ww-8,10,'#262626')
 elif t=='cafe':
  box(x+8,y+10,24,32,'#303030','#434343');rect(x+12,y+18,16,10,'#151515');rect(x+16,y+32,8,6,'#4a4a4a')
  for yy in [y+60,y+94]:ellipse(x+14,yy,12,12,'#45433f');ellipse(x+18,yy+4,4,4,'#191919')
 elif t=='mesinha':
  for xx in [x+18,x+w-28]:ellipse(xx,y+14,10,10,'#45433f');ellipse(xx+2,y+16,6,6,'#171717')

rect(0,480,1920,120,'#141414');rect(1912,480,8,120,'#292929')
for x in range(80,1890,40):rect(x,538,4,4,'#292929')
for a in cfg['areas']:
 x,y,w,h=[a[k]*40 for k in ('x','y','w','h')]
 # Thin wall bands centered on the first/last grid cells, outer margins empty.
 rect(x+12,y+12,w-24,h-24,'#292929','#343434')
 rect(x+28,y+28,w-56,h-56,'#151515' if a.get('descanso') else '#161616')
 for xx in range(x+40,x+w-30,40):line(xx,y+56,xx,y+h-30,'#1b1b1b')
 for yy in range(y+80,y+h-30,40):line(x+30,yy,x+w-32,yy,'#1b1b1b')
 # Reserved label strip and room wire area stay smooth.
 rect(x+40,y+24,240,32,'#161616')
 for p in a['portas']:
  px,py=p['x']*40,p['y']*40
  rect(px,py,80,40,'#141414');rect(px-4,py+12,4,16,'#414141');rect(px+80,py+12,4,16,'#414141')
 if a['id']=='tester':
  # Flush wall trim and restrained geometric seams, never objects on free floor.
  for yy in range(y+80,y+h-40,80):
   for xx in range(x+80,x+w-60,80):rect(xx+4,yy+4,6,2,'#1c1c1c')
  for xx in [x+350,x+420]:
   rect(xx,y+14,28,6,'#323032');rect(xx+8,y+16,12,2,'#694553')
  for yy in [y+116,y+356]:
   rect(x+16,yy,6,24,'#3a3437');rect(x+18,yy+6,2,8,'#694553')
 if VAZIO:continue
 for m in sorted(a['moveis'],key=lambda m:m['bloqueia'] if 'bloqueia' in m else True):furniture(m,a)
 for e in a['estacoes']:
  if a['id']=='tester':tester_station(e);continue
  mx,my=(e['x']-1)*40,e['y']*40-40;cx=e['x']*40+20;cy=e['y']*40+17
  ellipse(cx-12,cy-12,24,24,'#1a1a1a','#2c2c2c');rect(cx-8,cy+6,16,4,'#242424')
  box(mx+4,my+4,112,32,'#1d1d1d','#414262' if e.get('destaque') else '#343434')
  rect(cx-14,my+24,28,4,'#2a2a2a')
  for side in ([-1,1] if e.get('destaque') else [1]):
   sx=mx+4 if side<0 else mx+86
   box(sx-2,my+2,34,26,'#222222','#343434');rect(sx,my+6,30,20,'#0c0c0c')
for x in [120,440,760,1080,1400,1800]:
 for y in [450,610]:rect(x,y,16,4,'#474644');rect(x+4,y,8,2,'#595854')
# A one-pixel outside border takes precedence over the open entrance's edge.
rect(0,0,1920,2,'#111111');rect(0,1118,1920,2,'#111111');rect(0,0,2,1120,'#111111');rect(1918,0,2,1120,'#111111')
im=im.resize((1920,1120),Image.Resampling.NEAREST)
if VAZIO:
 (PROJECT/'assets/office/base').mkdir(exist_ok=True);im.save(PROJECT/'assets/office/base/fundo-vazio.png');print('Base vazia gravada.');sys.exit(0)
d=ImageDraw.Draw(im)
screens=[]
for a in cfg['areas']:
 for e in a['estacoes']:
  mx,my=(e['x']-1)*40,(e['y']-1)*40
  # Pixel-exact tables in the specification, including odd origins and sizes.
  for side in ([-1,1] if e.get('destaque') else [1]):
   sx=mx+4 if side<0 else mx+86;sy=my+5
   d.rectangle((sx,sy,sx+29,sy+20),fill='#0c0c0c');screens.append((sx,sy))
out=PROJECT/'assets/office';out.mkdir(exist_ok=True)
im.save(out/'fundo.png');im.resize((3840,2240),Image.Resampling.NEAREST).save(out/'fundo@2x.png')
guide=Image.open(out/'guia-layout.png').convert('RGB')
Image.blend(im,guide,.5).save(out/'conferencia-layout.png')

assert all(im.getpixel((x,y))==(12,12,12) for sx,sy in screens for x in range(sx,sx+30) for y in range(sy,sy+21))
assert all(im.getpixel((x,0))==(17,17,17) and im.getpixel((x,1119))==(17,17,17) for x in range(1920))
assert all(im.getpixel((0,y))==(17,17,17) and im.getpixel((1919,y))==(17,17,17) for y in range(1120))
print('PNG 1920x1120 e @2x; 16 telas e bordas verificadas.')

# Standalone opaque crops, with world coordinates for integration/review.
tester_out=out/'tester';tester_out.mkdir(exist_ok=True)
tester_pieces=[('sala',0,600,560,520),('armario-dispositivos',40,680,40,80),('checklist-bancada',480,720,40,120),('bancada-aparelhos',360,1040,160,40),('planta-inferior',40,1040,40,40),('planta-superior',480,640,40,40)]
for i,(x,y) in enumerate([(3,20),(9,20),(6,24)],1):tester_pieces.append((f'estacao-{i}',(x-1)*40,y*40-44,120,80))
tester_manifest={'sala':'tester','origem':[0,600],'dimensoes':[560,520],'atlas':'../fundo.png','pecas':[]}
for name,x,y,w,h in tester_pieces:
 im.crop((x,y,x+w,y+h)).save(tester_out/(name+'.png'))
 tester_manifest['pecas'].append({'arquivo':name+'.png','retanguloGlobal':[x,y,w,h],'tipo':'recorte opaco; não sobrepor ao atlas'})
(tester_out/'manifesto.json').write_text(json.dumps(tester_manifest,ensure_ascii=False,indent=2),encoding='utf8')
