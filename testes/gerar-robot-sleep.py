# Robô dormindo: separa os 4 quadros de assets/robot-sleep-gif.png (1254x1254, desenho fora da grade,
# bordas suavizadas) e redesenha tudo numa grade limpa de meias células, com cores chapadas.
# Saídas:
#   assets/robot-sleep-sheet.png  4 quadros 320x320 lado a lado (1280x320), no enquadramento do
#                                 robot-idle.gif (16 px por célula, robô nas colunas 4-15, pés no chão).
#                                 É a que o index.html anima (object-position + steps).
#   assets/robot-sleep.gif        a mesma animação com a subida dos "Z" inteira, como na sprite sheet,
#                                 fundo transparente, para usar fora do app.
# Uso: py -3 testes/gerar-robot-sleep.py
import pathlib
from collections import deque
import numpy as np
from PIL import Image

PROJECT = pathlib.Path(__file__).resolve().parents[1]
ORIGEM = PROJECT / 'assets/robot-sleep-gif.png'
NX, NY = 24, 30          # o robô tem 12x15 células; a grade é de meias células por causa dos olhos
ESCALA = 8               # px por meia célula = 16 px por célula, igual ao robot-idle.gif
MS_QUADRO = 800          # lento: 3,2 s por volta

a = np.array(Image.open(ORIGEM).convert('RGBA')).astype(float)
alfa = a[..., 3]


def faixas(v):
    r, s = [], None
    for i, x in enumerate(v):
        if x and s is None: s = i
        if not x and s is not None: r.append((s, i)); s = None
    if s is not None: r.append((s, len(v)))
    return r


def componentes(mask):
    H, W = mask.shape
    lab = np.zeros((H, W), int); out = []
    for y, x in zip(*np.nonzero(mask)):
        if lab[y, x]: continue
        n = len(out) + 1; q = deque([(y, x)]); lab[y, x] = n; pts = []
        while q:
            cy, cx = q.popleft(); pts.append((cy, cx))
            for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not lab[ny, nx]:
                    lab[ny, nx] = n; q.append((ny, nx))
        p = np.array(pts)
        out.append(dict(area=len(p), x0=p[:, 1].min(), x1=p[:, 1].max() + 1, y0=p[:, 0].min(), y1=p[:, 0].max() + 1, lab=n))
    return out, lab


# 1. Quadros: as 4 faixas de colunas com conteúdo. Em cada uma, o maior componente é o corpo; o resto são os "Z".
mask = alfa > 24
cols = faixas(mask.any(0))
assert len(cols) == 4, cols
quadros = []
for (c0, c1) in cols:
    cs, lab = componentes(mask[:, c0:c1])
    cs = [c for c in cs if c['area'] > 100]
    cs.sort(key=lambda c: -c['area'])
    for c in cs: c['x0'] += c0; c['x1'] += c0
    for c in cs: c['px'] = (lab == c['lab'])
    for c in cs: c['px'] = np.pad(c['px'], ((0, 0), (c0, a.shape[1] - c1)))
    quadros.append(dict(corpo=cs[0], zs=cs[1:]))

# 2. Paleta: k-médias nos pixels opacos dos corpos (a suavização vira ruído e some no voto).
px = a[alfa > 200][:, :3]
amostra = px[np.random.default_rng(0).choice(len(px), 40000, replace=False)]
C = np.array([[28, 28, 60], [172, 156, 172], [132, 132, 126], [188, 212, 228], [124, 116, 108],
              [172, 196, 214], [52, 60, 60], [140, 132, 132], [180, 190, 205]], float)
for _ in range(30):
    l = ((amostra[:, None] - C[None]) ** 2).sum(2).argmin(1)
    C = np.array([amostra[l == k].mean(0) if (l == k).any() else C[k] for k in range(len(C))])
TELA, AZUL_M, CONTORNO = 3, 5, 0


def rotulos(reg):
    L = ((reg[..., None, :3] - C) ** 2).sum(-1).argmin(-1)
    L[reg[..., 3] < 128] = -1
    return L


# 3. Corpo de cada quadro na grade 24x30, alinhado pela própria caixa (os corpos variam até 9 px entre os quadros).
#    Cada meia célula fica com a cor que domina o miolo dela (50% do centro).
grades = []
for q in quadros:
    b = q['corpo']; cw = (b['x1'] - b['x0']) / NX; ch = (b['y1'] - b['y0']) / NY
    q['cw'], q['ch'] = cw, ch
    g = np.full((NY, NX), -1)
    for j in range(NY):
        for i in range(NX):
            reg = a[int(round(b['y0'] + (j + .25) * ch)):int(round(b['y0'] + (j + .75) * ch)),
                    int(round(b['x0'] + (i + .25) * cw)):int(round(b['x0'] + (i + .75) * cw))]
            v, n = np.unique(rotulos(reg), return_counts=True)
            g[j, i] = v[n.argmax()]
    grades.append(g)
G = np.array(grades)

# 4. Um corpo só para os 4 quadros (o robô não pode tremer): voto por meia célula, com 3 de 4 quadros;
#    sem maioria, vale o quadro 1, que é o mais limpo.
corpo = G[0].copy()
for j in range(NY):
    for i in range(NX):
        v, n = np.unique(G[:, j, i], return_counts=True)
        if n.max() >= 3: corpo[j, i] = v[n.argmax()]
# O halo claro em volta dos olhos às vezes vira azul médio do lado do olho esquerdo; a tela ali é clara,
# como do lado do olho direito.
for j in range(12, 16):
    for i in range(8, 18):
        if corpo[j, i] == AZUL_M: corpo[j, i] = TELA
dif = [(k + 1, int((G[k] != corpo).sum())) for k in range(4)]

# 5. Os "Z": cada um na própria grade de meia célula, com a cor e a opacidade do original
#    (o "z" pequeno é semitransparente; o Z que some no quadro 4 é acinzentado pela cor).
TAM = {}
for q in quadros:
    b = q['corpo']
    for z in q['zs']:
        w = z['x1'] - z['x0']; h = z['y1'] - z['y0']
        nx, ny = max(1, round(w / q['cw'])), max(1, round(h / q['ch']))
        al = np.where(z['px'], alfa, 0)[z['y0']:z['y1'], z['x0']:z['x1']]
        lim = np.median(al[al > 20]) / 2
        cz, rz = w / nx, h / ny
        m = np.zeros((ny, nx), bool)
        for j in range(ny):
            for i in range(nx):
                reg = al[int(j * rz + rz * .2):int(j * rz + rz * .8), int(i * cz + cz * .2):int(i * cz + cz * .8)]
                m[j, i] = (reg > lim).mean() >= .5
        if m.shape == (4, 3):  # a diagonal do "z" pequeno tem 1,5 meia célula e o voto a deixava com cara de "I";
            m = np.array([[1, 1, 1], [0, 1, 1], [1, 1, 0], [1, 1, 1]], bool)  # degrau igual ao dos Z grandes
        miolo = z['px'] & (alfa >= np.percentile(alfa[z['px']], 60))
        z['cor'] = tuple(int(v) for v in np.median(a[..., :3][miolo], 0))
        z['alfa'] = int(np.median(alfa[z['px'] & (alfa > 20)]))
        z['alfa'] = 255 if z['alfa'] > 230 else z['alfa']
        z['m'] = m
        z['gx'] = round((z['x0'] - b['x0']) / q['cw'])   # posição em meias células, relativa ao corpo
        z['gy'] = round((z['y0'] - b['y0']) / q['ch'])

# 6. Composição. App: 40x40 meias células; corpo em (8,10), pés na última linha como o robot-idle.gif.
#    O avatar é quadrado e a subida inteira não cabe acima da cabeça, então os Z descem 4 meias linhas
#    (as distâncias entre eles ficam como no original). O Z do quadro 4 sairia por cima: fica no topo,
#    1 coluna à direita, para não encostar no "z" pequeno.
def desenhar(lado_x, lado_y, ox, oy, zs, opaco):
    im = np.zeros((lado_y, lado_x, 4), np.uint8)
    for j in range(NY):
        for i in range(NX):
            k = corpo[j, i]
            if k >= 0: im[oy + j, ox + i] = (*np.round(C[k]).astype(int), 255)
    for (z, gx, gy) in zs:
        for j, i in zip(*np.nonzero(z['m'])):
            y, x = gy + j, gx + i
            if 0 <= y < lado_y and 0 <= x < lado_x:
                im[y, x] = (*z['cor'], 255 if opaco else z['alfa'])
    return Image.fromarray(im, 'RGBA').resize((lado_x * ESCALA, lado_y * ESCALA), Image.NEAREST)


DESCE = 4
quadros_app = []
for k, q in enumerate(quadros):
    zs = []
    for z in q['zs']:
        gx, gy = 8 + z['gx'], 10 + z['gy'] + DESCE
        if gy < 1: gx, gy = gx + 1, 1
        zs.append((z, gx, gy))
    quadros_app.append(desenhar(40, 40, 8, 10, zs, False))
folha = Image.new('RGBA', (40 * ESCALA * 4, 40 * ESCALA))
for k, f in enumerate(quadros_app): folha.paste(f, (k * 40 * ESCALA, 0))
folha.save(PROJECT / 'assets/robot-sleep-sheet.png', optimize=True)

# GIF: a subida dos Z como na sprite sheet, numa tela que cabe tudo (margem de 2 meias células).
#      GIF não tem opacidade parcial: o "z" esmaecido sai opaco, no tom acinzentado da própria arte.
todos = [(z['gx'], z['gy'], z['m'].shape) for q in quadros for z in q['zs']]
x_max = max(NX, max(gx + s[1] for gx, gy, s in todos))
y_min = min(0, min(gy for gx, gy, s in todos))
M = 2
lx, ly = x_max + 2 * M, NY - y_min + 2 * M
ox, oy = M, M - y_min
quadros_gif = [desenhar(lx, ly, ox, oy, [(z, ox + z['gx'], oy + z['gy']) for z in q['zs']], True) for q in quadros]
# Paleta comum com um índice reservado para a transparência (alfa binário: o desenho já é chapado).
cores = []
for f in quadros_gif:
    for p in np.array(f).reshape(-1, 4):
        if p[3] and tuple(p[:3]) not in cores: cores.append(tuple(p[:3]))
assert len(cores) < 255, len(cores)
pal = [0, 0, 0] + [v for c in cores for v in c]
idx = {c: i + 1 for i, c in enumerate(cores)}
saida = []
for f in quadros_gif:
    arr = np.array(f)
    ind = np.zeros(arr.shape[:2], np.uint8)
    for c, i in idx.items():
        ind[(arr[..., 3] > 0) & (arr[..., 0] == c[0]) & (arr[..., 1] == c[1]) & (arr[..., 2] == c[2])] = i
    p = Image.fromarray(ind, 'P'); p.putpalette(pal + [0] * (768 - len(pal)))
    saida.append(p)
saida[0].save(PROJECT / 'assets/robot-sleep.gif', save_all=True, append_images=saida[1:], duration=MS_QUADRO,
              loop=0, transparency=0, disposal=2, optimize=False)

print('paleta', np.round(C).astype(int).tolist())
print('diferença de cada quadro para o corpo único (meias células):', dif)
for q in quadros:
    print('quadro', [(z['m'].shape[::-1], (z['gx'], z['gy']), z['cor'], z['alfa']) for z in q['zs']])
print('folha', folha.size, '| gif', saida[0].size, len(saida), 'quadros de', MS_QUADRO, 'ms')
