"""Compõe o fundo da Visão de Office com as peças de assets/office/assets separados.

Uso (na raiz do projeto):
  py -3 testes/aplicar-assets-office.py             compõe e imprime um JSON com o resultado
  py -3 testes/aplicar-assets-office.py --catalogo  grava _NOMES.md e _mapa-dos-nomes.png na pasta

Cada PNG se chama <sala>-<peça>[-N].png (ver _NOMES.md). O nome aponta um elemento do
CONFIG do office.js; a peça é colada no retângulo exato desse elemento. O CONFIG não muda,
então posição, tamanho e colisão continuam os mesmos. Sem peça, o elemento fica com o
desenho original. Saídas: fundo.png, fundo@2x.png e fundo-versao.json (a Visão de Office
recarrega o bitmap quando a versão muda).
"""
import difflib, hashlib, json, os, pathlib, re, subprocess, sys, time, unicodedata
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageStat

PROJ = pathlib.Path(__file__).resolve().parents[1]
OFFICE = PROJ / 'assets/office'
PASTA = OFFICE / 'assets separados'
BASE = OFFICE / 'base'
GERADOR = PROJ / 'testes/gerar-fundo-office.py'
CEL = 40  # px por célula no fundo 1x (1920 × 1120 para a grade 48 × 28)
TOLERANCIA = 0.03  # diferença de proporção aceita antes de encaixar sem distorcer

NOMES_PECA = {
  'sala': 'sala inteira (paredes, piso, portas)', 'corredor': 'corredor que liga as portas',
  'estacao': 'estação (mesa 3×1 + cadeira na célula de baixo)', 'planta': 'planta', 'lousa': 'lousa',
  'estante': 'estante', 'arquivo': 'arquivo', 'rack': 'rack de servidor', 'checklist': 'quadro de checklist',
  'globo': 'globo', 'bancada': 'bancada', 'tapete': 'tapete (não bloqueia)', 'sofa': 'sofá', 'mesinha': 'mesinha',
  'cafe': 'máquina de café', 'piso': 'textura do chão (repetida, escurecida; não bloqueia)', 'pingpong': 'mesa de pingue-pongue', 'puff': 'puff',
  'porta': 'soleira da porta (altura da parede, centralizada no vão; não bloqueia)',
}


def ler_config():
  js = ("const fs=require('fs'),vm=require('vm');const ctx={window:{}};"
        "vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),ctx);"
        "console.log(JSON.stringify(ctx.window.Office.CONFIG));")
  return json.loads(subprocess.check_output(['node', '-e', js, str(PROJ / 'assets/office.js')], text=True, encoding='utf8'))


def catalogo(cfg):
  """Elementos em ordem de desenho: corredor, salas, tapetes, móveis, estações."""
  els = []
  def add(id_, camada, rect, peca, area, bloqueia=True, **extra):
    els.append({'id': id_, 'camada': camada, 'rect': rect, 'peca': peca, 'area': area, 'bloqueia': bloqueia, **extra})
  for i, c in enumerate(cfg['caminhos']):
    add('corredor' if len(cfg['caminhos']) == 1 else f'corredor-{i + 1}', 0, (c['x'], c['y'], c['w'], c['h']), 'corredor', None, False)
  for a in cfg['areas']:
    add(f"{a['id']}-sala", 1, (a['x'], a['y'], a['w'], a['h']), 'sala', a['id'])
    # Piso: textura repetida no chão interno (camada 1.5, entre a sala e os móveis).
    add(f"{a['id']}-piso", 1.5, (a['x'], a['y'], a['w'], a['h']), 'piso', a['id'], False, portas=a['portas'])
    # Soleira: no vão de cada porta, por cima da parede (camada 1.6). Porta na parede de cima: virada.
    pts = sorted(a['portas'], key=lambda p: (p['y'], p['x']))
    for k, p in enumerate(pts, 1):
      add(f"{a['id']}-porta" + (f'-{k}' if len(pts) > 1 else ''), 1.6, (p['x'], p['y'], p.get('w', 1), p.get('h', 1)),
          'porta', a['id'], False, virar=p['y'] == a['y'])
    grupos = {}
    for m in a.get('moveis') or []:
      grupos.setdefault(m.get('arte') or m['tipo'], []).append(m)
    for nome, ms in grupos.items():
      ms.sort(key=lambda m: (m['y'], m['x']))  # numeração de cima para baixo, da esquerda para a direita
      for k, m in enumerate(ms, 1):
        livre = m.get('bloqueia') is False
        add(f"{a['id']}-{nome}" + (f'-{k}' if len(ms) > 1 else ''), 2 if livre else 3,
            (m['x'], m['y'], m.get('w', 1), m.get('h', 1)), nome, a['id'], not livre)
    ests = sorted(a.get('estacoes') or [], key=lambda e: (e['y'], e['x']))
    for k, e in enumerate(ests, 1):
      me = e.get('mesa') or {'x': e['x'] - 1, 'y': e['y'] - 1, 'w': 3, 'h': 1}
      x0, y0 = min(me['x'], e['x']), min(me['y'], e['y'])
      x1, y1 = max(me['x'] + me['w'], e['x'] + 1), max(me['y'] + me['h'], e['y'] + 1)
      add(f"{a['id']}-estacao" + (f'-{k}' if len(ests) > 1 else ''), 4, (x0, y0, x1 - x0, y1 - y0), 'estacao', a['id'])
  return els


def normalizar(nome):
  s = pathlib.Path(nome).stem
  s = re.sub(r'@\d+x$', '', s, flags=re.I)
  s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
  return re.sub(r'-+', '-', re.sub(r'[\s_.]+', '-', s)).strip('-')


def identificar(arquivo, ids, apelidos):
  """(elementos, grupo, posições) do arquivo: pelo nome, ou por _apelidos.json, que aceita um
  elemento, uma lista (a mesma peça em cada um), {"grupo": [...]} (uma peça só sobre a união
  deles; com "topo": true, encostada no alto em vez de centralizada) ou {"posicoes": [{"elemento", "px": [x, y, w, h] a 1x, "espelhar": "vertical"}]}
  (a peça desenhada no pixel exato; a colisão continua a do CONFIG). Numa lista, um item pode
  ser {"elemento": "corredor", "textura": "#RRGGBB"}: a peça vira textura repetida, tingida
  nessa cor média (hoje só o corredor usa)."""
  if arquivo in apelidos:
    alvo, grupo, pos, opcoes = apelidos[arquivo], False, {}, {}
    if isinstance(alvo, dict) and 'posicoes' in alvo:
      pos = {q['elemento']: q for q in alvo['posicoes']}
      alvo = list(pos)
    elif isinstance(alvo, dict):
      grupo, topo = True, bool(alvo.get('topo'))
      alvo = alvo.get('grupo') or []
    alvo = [alvo] if isinstance(alvo, str) else list(alvo)
    opcoes = {q['elemento']: q for q in alvo if isinstance(q, dict)}
    if grupo and topo: opcoes = {a: {'topo': True} for a in alvo}
    alvo = [q['elemento'] if isinstance(q, dict) else q for q in alvo]
    return (alvo, grupo, pos, opcoes) if alvo and all(a in ids for a in alvo) else ([], False, {}, {})
  n = normalizar(arquivo)
  if n in ids: return [n], False, {}, {}
  if n.endswith('-1') and n[:-2] in ids: return [n[:-2]], False, {}, {}  # "-1" numa peça única
  return [], False, {}, {}


def hash_base(cfg):
  h = hashlib.sha256(json.dumps({k: cfg[k] for k in ('grade', 'areas', 'caminhos')}, sort_keys=True).encode())
  h.update(GERADOR.read_bytes())
  return h.hexdigest()


def garantir_base(cfg):
  """Original (com móveis) e vazia (sem), geradas pelo gerador do fundo quando o CONFIG muda."""
  marca = BASE / 'base.json'
  hb = hash_base(cfg)
  ok = marca.exists() and json.loads(marca.read_text(encoding='utf8')).get('hash') == hb
  if ok and (BASE / 'fundo-original.png').exists() and (BASE / 'fundo-vazio.png').exists(): return
  BASE.mkdir(exist_ok=True)
  sai = dict(os.environ, PYTHONIOENCODING='utf8')
  subprocess.run([sys.executable, str(GERADOR)], check=True, cwd=PROJ, env=sai, capture_output=True)
  Image.open(OFFICE / 'fundo.png').save(BASE / 'fundo-original.png')
  subprocess.run([sys.executable, str(GERADOR)], check=True, cwd=PROJ, env=dict(sai, OFFICE_VAZIO='1'), capture_output=True)
  marca.write_text(json.dumps({'hash': hb}), encoding='utf8')


def encaixar(img, w, h, topo=False):
  """Redimensiona para w×h; se a proporção não bate, encaixa centralizado sem distorcer
  (estações: no topo, para o monitor ficar sob o brilho fixo da tela)."""
  iw, ih = img.size
  aviso = None
  if abs(iw / ih - w / h) / (w / h) <= TOLERANCIA:
    tw, th = w, h
  else:
    s = min(w / iw, h / ih)
    tw, th = max(1, round(iw * s)), max(1, round(ih * s))
    aviso = f'proporção {iw}×{ih} diferente de {w}×{h}: encaixada sem distorcer'
  f = tw / iw
  inteiro = abs(f - round(f)) < 1e-6 or abs(1 / f - round(1 / f)) < 1e-6
  if (tw, th) != (iw, ih):
    img = img.resize((tw, th), Image.Resampling.NEAREST if inteiro else Image.Resampling.LANCZOS)
  return img, ((w - tw) // 2, 0 if topo else (h - th) // 2), aviso


PISO_LADRILHO = 4   # células cobertas por uma repetição da textura
PISO_BRILHO = 24    # brilho médio (0–255) da textura depois de escurecida; o piso atual é #161616


def aplicar_piso(saida, img, el, escala, parede=None):
  """Repete a textura no chão interno da sala, escurecida ao tom do Office, sem cobrir
  paredes nem portas (mesmas medidas de testes/gerar-fundo-office.py). O nome da sala fica numa
  placa fora dela (assets/office.js), então o chão é coberto inteiro.
  Com parede nova (peça <sala>-sala), o chão é onde ela é transparente."""
  e = escala
  lado = PISO_LADRILHO * CEL * e
  tex = img.convert('RGB').resize((lado, lado), Image.Resampling.BOX)
  media = sum(ImageStat.Stat(tex).mean) / 3 or 1
  tex = tex.point(lambda v: min(255, round(v * PISO_BRILHO / media)))
  ax, ay, aw, ah = (v * CEL * e for v in el['rect'])
  recuo = 0 if parede else 28 * e
  x0, y0, x1, y1 = ax + recuo, ay + recuo, ax + aw - recuo, ay + ah - recuo
  camada = Image.new('RGB', (x1 - x0, y1 - y0))
  for ty in range(0, y1 - y0, lado):
    for tx in range(0, x1 - x0, lado):
      camada.paste(tex, (tx, ty))
  mascara = parede.point(lambda v: 255 if v < 128 else 0) if parede else Image.new('L', camada.size, 255)
  d = ImageDraw.Draw(mascara)
  for p in ([] if parede else el['portas']):
    px, py = p['x'] * CEL * e - x0, p['y'] * CEL * e - y0
    d.rectangle((px - 4 * e, py, px + p.get('w', 1) * CEL * e + 4 * e - 1, py + p.get('h', 1) * CEL * e - 1), fill=0)
  saida.paste(camada, (x0, y0), mascara)


def tingir(img, lado, cor):
  """Textura de lado×lado px com cor média `cor` (#RRGGBB): mantém o desenho (a luminância) e troca o tom."""
  tex = img.convert('L').resize((lado, lado), Image.Resampling.BOX)
  media = ImageStat.Stat(tex).mean[0] or 1
  alvo = [int(cor.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4)]
  return Image.merge('RGB', [tex.point(lambda v, c=c: min(255, round(v * c / media))) for c in alvo])


def aplicar_corredor(saida, vazio, img, el, escala, cor, portas):
  """Carpete no corredor: a textura tingida, repetida e alinhada ao fundo inteiro, entra onde a
  base vazia tem a cor lisa do corredor, dentro dele e dos vãos das portas (sem invadir o vão
  entre as salas). A trilha pontilhada, de outra cor, fica por cima."""
  e = escala
  lado = PISO_LADRILHO * CEL * e
  tex = tingir(img, lado, cor)
  x, y, w, h = (v * CEL * e for v in el['rect'])
  lisa = max(vazio.crop((x, y, x + w, y + h)).getcolors(1 << 24))[1]  # a cor mais comum do corredor
  regiao = Image.new('L', vazio.size, 0)
  d = ImageDraw.Draw(regiao)
  d.rectangle((x, y, x + w - 1, y + h - 1), fill=255)
  for p in portas:
    px, py = p['x'] * CEL * e, p['y'] * CEL * e
    d.rectangle((px - 4 * e, py - 4 * e, px + p.get('w', 1) * CEL * e + 4 * e - 1, py + p.get('h', 1) * CEL * e + 4 * e - 1), fill=255)
  igual = ImageChops.difference(vazio, Image.new('RGB', vazio.size, lisa)).convert('L').point(lambda v: 255 if v == 0 else 0)
  camada = Image.new('RGB', vazio.size)
  for ty in range(0, vazio.height, lado):
    for tx in range(0, vazio.width, lado):
      camada.paste(tex, (tx, ty))
  saida.paste(camada, (0, 0), ImageChops.multiply(igual, regiao))


def compor(els, pecas, escala):
  orig = Image.open(BASE / 'fundo-original.png').convert('RGB')
  vaz = Image.open(BASE / 'fundo-vazio.png').convert('RGB')
  if escala != 1:
    tam = (orig.width * escala, orig.height * escala)
    orig, vaz = orig.resize(tam, Image.Resampling.NEAREST), vaz.resize(tam, Image.Resampling.NEAREST)
  saida = vaz.convert('RGBA')
  ref = vaz.copy()  # o que havia por baixo de cada elemento no desenho original
  avisos, grupos, chao, paredes, posicionadas = {}, {}, None, {}, []
  corredor = None
  porid = {e['id']: e for e in els}
  for el in sorted(els, key=lambda e: e['camada']):
    x, y, w, h = (v * CEL * escala for v in el['rect'])
    caixa = (x, y, x + w, y + h)
    if el['camada'] >= 1 and corredor is None:
      corredor = saida.copy()  # só o corredor pronto: é o que aparece no vão da porta, sob a soleira
    if el['peca'] == 'piso':
      if el['id'] in pecas: aplicar_piso(saida, pecas[el['id']]['img'], el, escala, paredes.get(el['area']))
      continue
    if el['camada'] >= 2 and chao is None:
      chao = saida.copy()  # corredor, salas e pisos prontos: é o que fica sob cada móvel trocado
    if el['camada'] >= 2:
      # Pixels do elemento no original: o que difere do que havia por baixo dele
      # (salas e corredor já estão na base vazia).
      o = orig.crop(caixa)
      mascara = ImageChops.difference(o, ref.crop(caixa)).convert('L').point(lambda v: 255 if v else 0)
      ref.paste(o, (x, y), mascara)
    p = pecas.get(el['id'])
    if p and p.get('textura'):
      aplicar_corredor(saida, vaz, p['img'], el, escala, p['textura'], [q for e in els if e['peca'] == 'piso' for q in e['portas']])
      continue
    if p and el['peca'] == 'porta':
      # Altura da parede (o vão), largura proporcional: os batentes passam por cima da parede dos lados.
      img = p['img'].transpose(Image.Transpose.FLIP_TOP_BOTTOM) if el.get('virar') else p['img']
      tw = max(1, round(img.width * h / img.height))
      img = img.resize((tw, h), Image.Resampling.LANCZOS)
      x0 = x + (w - tw) // 2
      # A abertura (o transparente entre os batentes, ligado à borda livre) recebe o carpete do
      # corredor vizinho: some a sobra de parede ou de piso que o desenho da sala deixou no vão.
      abertura = img.getchannel('A').point(lambda v: 255 if v < 128 else 0)
      ImageDraw.floodfill(abertura, (tw // 2, h - 1 if el.get('virar') else 0), 128)
      abertura = abertura.point(lambda v: 255 if v == 128 else 0)
      dy = -h if el.get('virar') else h  # o corredor fica do lado do peitoril
      saida.paste(corredor.crop((x0, y + dy, x0 + tw, y + dy + h)), (x0, y), abertura)
      saida.alpha_composite(img, (x0, y))
      continue
    if p and p.get('pos'):
      if el['camada'] >= 2:
        saida.paste(chao.crop(caixa), (x, y))
      posicionadas.append(p['pos'] | {'img': p['img']})
    elif p and p['grupo']:
      if el['camada'] >= 2:
        saida.paste(chao.crop(caixa), (x, y))  # some o desenho de cada membro; a peça vem depois
      grupos[p['grupo']] = p
    elif p:
      img, (ox, oy), aviso = encaixar(p['img'], w, h, topo=el['peca'] == 'estacao')
      if el['camada'] >= 2:
        saida.paste(chao.crop(caixa), (x, y))  # tira o desenho antigo antes de colar a peça
      saida.alpha_composite(img, (x + ox, y + oy))
      if el['peca'] == 'sala':  # o piso da sala vai onde a parede nova é transparente
        a = Image.new('L', (w, h), 0)
        a.paste(img.getchannel('A'), (ox, oy))
        paredes[el['area']] = a
      if aviso: avisos[el['id']] = aviso
    elif el['camada'] >= 2:
      saida.paste(o, (x, y), mascara)
  for grupo, p in grupos.items():  # uma peça sobre a união dos retângulos do grupo
    rs = [porid[g]['rect'] for g in grupo]
    x0, y0 = min(r[0] for r in rs), min(r[1] for r in rs)
    x1, y1 = max(r[0] + r[2] for r in rs), max(r[1] + r[3] for r in rs)
    x, y, w, h = (v * CEL * escala for v in (x0, y0, x1 - x0, y1 - y0))
    img, (ox, oy), aviso = encaixar(p['img'], w, h, topo=p['topo'])
    saida.alpha_composite(img, (x + ox, y + oy))
    if aviso:
      for g in grupo: avisos[g] = aviso
  vistas = set()  # a mesma peça no mesmo pixel para vários elementos (ex.: puffs) entra uma vez só
  for q in posicionadas:  # por cima dos grupos (ex.: sofás sobre o tapete)
    chave = (id(q['img']), tuple(q['px']), q.get('espelhar'))
    if chave in vistas: continue
    vistas.add(chave)
    img = q['img'].transpose(Image.Transpose.FLIP_TOP_BOTTOM) if q.get('espelhar') == 'vertical' else q['img']
    if q.get('espelhar') == 'horizontal': img = img.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    x, y, w, h = (round(v * escala) for v in q['px'])
    img, (ox, oy), _ = encaixar(img, w, h)
    saida.alpha_composite(img, (x + ox, y + oy))
  return saida.convert('RGB'), avisos


def gravar_atomico(img, destino):
  tmp = destino.with_name(destino.stem + '.tmp.png')
  img.save(tmp)
  os.replace(tmp, destino)


def tirar_fundo(img, bordas=True):
  """Peças sem transparência: magenta puro vira transparente (miolo de parede); sem magenta,
  um fundo sólido que encosta nas bordas (o preto que os geradores põem) é removido por
  preenchimento. Paredes (bordas=False) encostam nas bordas: só o magenta conta."""
  if img.getchannel('A').getextrema()[0] < 255: return img, None
  rgb = img.convert('RGB')
  r, g, b = rgb.split()
  magenta = ImageChops.multiply(ImageChops.multiply(r.point(lambda v: 255 if v > 200 else 0), g.point(lambda v: 255 if v < 70 else 0)), b.point(lambda v: 255 if v > 200 else 0))
  feito = []
  if magenta.getbbox():
    feito.append('magenta')
    # Franja do antisserrilhado (roxo entre a parede e o magenta): sai também, se estiver
    # colada no magenta puro (até 3 px), senão vira uma borda rosa no fundo.
    tinta = ImageChops.subtract(ImageChops.darker(r, b), g).point(lambda v: 255 if v > 40 else 0)
    magenta = ImageChops.lighter(magenta, ImageChops.multiply(tinta, magenta.filter(ImageFilter.MaxFilter(7))))
  w, h = rgb.size
  cantos = [rgb.getpixel(p) for p in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]
  if bordas and not feito and all(max(abs(c[i] - cantos[0][i]) for i in range(3)) <= 12 for c in cantos):
    marca = (255, 0, 254) if cantos[0] != (255, 0, 254) else (0, 255, 1)
    cheio = rgb.copy()
    for p in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
      if cheio.getpixel(p) != marca: ImageDraw.floodfill(cheio, p, marca, thresh=12)
    fora = ImageChops.difference(cheio, Image.new('RGB', cheio.size, marca)).convert('L').point(lambda v: 255 if v == 0 else 0)
    magenta = ImageChops.lighter(magenta, fora)
    feito.append('fundo %02x%02x%02x' % cantos[0])
  if not bordas and not feito:
    # Parede com miolo de cor sólida (ex.: preto) em vez de magenta: o miolo ligado ao centro sai.
    centro = rgb.getpixel((w // 2, h // 2))
    marca = (255, 0, 254) if centro != (255, 0, 254) else (0, 255, 1)
    cheio = rgb.copy()
    ImageDraw.floodfill(cheio, (w // 2, h // 2), marca, thresh=8)
    miolo = ImageChops.difference(cheio, Image.new('RGB', cheio.size, marca)).convert('L').point(lambda v: 255 if v == 0 else 0)
    if sum(miolo.histogram()[255:]) > 0.3 * w * h:
      magenta = miolo
      feito.append('miolo %02x%02x%02x' % centro)
  if not feito: return img, None
  img = img.copy()
  img.putalpha(ImageChops.subtract(img.getchannel('A'), magenta))
  return img, ' + '.join(feito) + ' removido'


def ler_pecas(ids):
  apelidos = {}
  arq_ap = PASTA / '_apelidos.json'
  if arq_ap.exists():
    apelidos = json.loads(arq_ap.read_text(encoding='utf8'))
  itens, pecas = [], {}
  arquivos = sorted((f for f in PASTA.glob('*') if f.is_file() and f.suffix.lower() == '.png' and not f.name.startswith(('_', '.'))),
                    key=lambda f: f.stat().st_mtime)
  for f in arquivos:  # do mais antigo ao mais novo: para o mesmo elemento, vence o mais recente
    item = {'arquivo': f.name}
    alvos, grupo, pos, opcoes = identificar(f.name, ids, apelidos)
    el = ('grupo ' if grupo else '') + ', '.join(alvos)
    if not alvos:
      item.update(elemento=None, sugestoes=difflib.get_close_matches(normalizar(f.name), ids, n=3, cutoff=0.5))
      itens.append(item); continue
    try:
      with Image.open(f) as im:
        img = im.convert('RGBA')
      if not any(a.endswith('-piso') or 'textura' in opcoes.get(a, {}) for a in alvos):
        img, fundo = tirar_fundo(img, bordas=not any(a.endswith('-sala') for a in alvos))
        if fundo: item['fundo'] = fundo
      # Margem transparente não conta: o desenho visível é que ocupa o retângulo do elemento.
      caixa = img.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
      if caixa and caixa != (0, 0) + img.size:
        item['recorte'] = list(caixa)
        img = img.crop(caixa)
    except Exception as e:
      item.update(elemento=el, erro=f'não abriu como PNG: {e}')
      itens.append(item); continue
    item.update(elemento=el, alvos=alvos, tamanho=list(img.size))
    for a in alvos:
      pecas[a] = {'img': img, 'arquivo': f.name, 'item': item, 'grupo': tuple(alvos) if grupo else None, 'pos': pos.get(a),
                  'textura': opcoes.get(a, {}).get('textura'), 'topo': opcoes.get(a, {}).get('topo', False)}
    itens.append(item)
  for el, p in pecas.items():
    p['item']['aplicado'] = True
  for it in itens:
    if it.get('alvos') and not it.get('aplicado') and not it.get('erro'):
      it['ignorado'] = 'outro arquivo mais recente ocupa ' + ', '.join(f"{a} ({pecas[a]['arquivo']})" for a in it['alvos'])
  return itens, pecas


def gerar_catalogo(cfg, els):
  linhas = ['# Nomes dos assets do Office', '',
            'Salve cada PNG nesta pasta como `<sala>-<peça>.png`. Quando a mesma peça se repete na sala, ela leva um número:',
            '`-1`, `-2`... contados **de cima para baixo e, na mesma linha, da esquerda para a direita**. Veja `_mapa-dos-nomes.png`.',
            '', 'Maiúsculas, acentos, espaços e `_` são ignorados, e o sufixo `@2x` também (`Frontend_Planta 2@2x.png` vale `frontend-planta-2`).',
            'Peça que junta vários elementos (ex.: sofás + mesinha + tapete): ela ocupa a união dos retângulos deles,',
            'e cada um mantém a própria colisão. Arquivos que começam com `_` são ignorados. A margem transparente em volta do desenho é cortada sozinha.', '',
            'Tamanho: 40 px por célula a 1x. Desenhe de preferência a **2x (80 px por célula)**. A peça é ajustada ao retângulo',
            'do elemento; com proporção diferente, ela entra centralizada, sem distorcer. Use PNG com transparência: por baixo de cada peça fica o piso.',
            'Posição, tamanho e colisão não mudam, porque vêm do CONFIG.', '',
            '**Telas das estações:** o brilho do monitor é desenhado por cima, em posição fixa, no canto superior direito da mesa',
            '(a 2x: x 172–232, y 10–52 dentro da peça de 240×160). A estação da Mestre tem uma segunda tela no canto esquerdo (x 8–68).',
            'Desenhe o monitor nesse lugar.', '',
            '**Salas (`<sala>-sala`):** só as paredes, de borda a borda da imagem, com o miolo em magenta puro (#FF00FF) ou',
            'transparente; o carpete (`<sala>-piso`) entra onde a parede não está. A parede pode ter até 1 célula de espessura (80 px a 2x),',
            'que é a área que já bloqueia os robôs. As portas são vãos abertos (veja as células na tabela da sala e `_mapa-dos-nomes.png`).',
            'Mantenha liso o canto superior esquerdo da parede de cima (a 2x: x 104–288).',
            'Miolo de cor sólida (ex.: preto) também serve: ele é removido a partir do centro. Fundo sólido nas bordas é removido sozinho.', '',
            '**Corredor com textura:** em `_apelidos.json`, o item `{"elemento": "corredor", "textura": "#RRGGBB"}` na lista de um',
            'arquivo repete esse PNG no corredor e nos vãos das portas, tingido nessa cor média (hoje: `carpete-1.png` em cinza `#2e2e2e`).', '']
  areas = [None] + [a['id'] for a in cfg['areas']]
  for ar in areas:
    linhas += [f"## {ar or 'Corredor'}", '', '| Arquivo | O que é | Células (L×A) | px a 2x | Bloqueia |', '|---|---|---|---|---|']
    for el in [e for e in els if e['area'] == ar]:
      _, _, w, h = el['rect']
      linhas.append(f"| `{el['id']}.png` | {NOMES_PECA.get(el['peca'], el['peca'])} | {w}×{h} | {w * 80}×{h * 80} | {'sim' if el['bloqueia'] else 'não'} |")
    linhas.append('')
  (PASTA / '_NOMES.md').write_text('\n'.join(linhas), encoding='utf8')

  im = Image.open(BASE / 'fundo-original.png').convert('RGB').resize((3840, 2240), Image.Resampling.NEAREST)
  d = ImageDraw.Draw(im, 'RGBA')
  try: fonte = ImageFont.load_default(size=18)
  except TypeError: fonte = ImageFont.load_default()
  cores = {0: (163, 163, 163), 1: (129, 140, 248), 1.6: (251, 146, 60), 2: (45, 212, 191), 3: (250, 204, 21), 4: (244, 114, 182)}
  els = [e for e in els if e['peca'] != 'piso']  # o piso cobre a sala inteira: fica só na lista
  for el in sorted(els, key=lambda e: e['camada']):
    x, y, w, h = (v * 80 for v in el['rect'])
    c = cores[el['camada']]
    d.rectangle((x + 2, y + 2, x + w - 3, y + h - 3), outline=c + (255,), width=3)
  usadas = []  # caixas de rótulo já desenhadas: o próximo desce até achar espaço livre
  for el in sorted(els, key=lambda e: (e['camada'], e['rect'][1], e['rect'][0])):
    x, y, w, h = (v * 80 for v in el['rect'])
    rot = el['id']
    tx, ty = (x + 8, y + 8) if el['camada'] >= 2 else (x + 90, y + h - 34)
    lw = d.textlength(rot, font=fonte)
    tx = min(tx, im.width - lw - 10)
    while any(not (tx + lw + 4 < a or tx - 4 > c or ty + 26 < b or ty - 3 > e) for a, b, c, e in usadas):
      ty += 30
    usadas.append((tx, ty, tx + lw, ty + 22))
    caixa = d.textbbox((tx, ty), rot, font=fonte)
    d.rectangle((caixa[0] - 4, caixa[1] - 3, caixa[2] + 4, caixa[3] + 3), fill=(0, 0, 0, 200))
    d.text((tx, ty), rot, fill=cores[el['camada']] + (255,), font=fonte)
  im.save(PASTA / '_mapa-dos-nomes.png')


def main():
  cfg = ler_config()
  if (cfg['grade']['colunas'] * CEL, cfg['grade']['linhas'] * CEL) != (1920, 1120):
    raise SystemExit('grade diferente de 48×28: ajuste CEL')
  PASTA.mkdir(parents=True, exist_ok=True)
  garantir_base(cfg)
  els = catalogo(cfg)
  if '--catalogo' in sys.argv:
    gerar_catalogo(cfg, els)
    print(json.dumps({'ok': True, 'elementos': len(els)}, ensure_ascii=False))
    return
  ids = {e['id'] for e in els}
  porid = {e['id']: e for e in els}
  itens, pecas = ler_pecas(ids)
  img1, avisos = compor(els, pecas, 1)
  img2, _ = compor(els, pecas, 2)
  gravar_atomico(img2, OFFICE / 'fundo@2x.png')
  gravar_atomico(img1, OFFICE / 'fundo.png')
  for el, p in pecas.items():
    x, y, w, h = porid[el]['rect']
    p['item'].setdefault('destinos', []).append(f'{el} {w}×{h} cél.')
    if el in avisos and avisos[el] not in p['item'].setdefault('avisos', []): p['item']['avisos'].append(avisos[el])
  v = int(time.time() * 1000)
  tmp = OFFICE / 'fundo-versao.tmp.json'
  tmp.write_text(json.dumps({'v': v, 'pecas': {el: p['arquivo'] for el, p in pecas.items()}}, ensure_ascii=False), encoding='utf8')
  os.replace(tmp, OFFICE / 'fundo-versao.json')
  print(json.dumps({'ok': True, 'v': v, 'aplicadas': len(pecas), 'itens': itens}, ensure_ascii=False))


if __name__ == '__main__':
  main()
