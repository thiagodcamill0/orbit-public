# Robô de concluída: redesenha assets/robot-done.png (1254x1254, arte do usuário, desenho fora da grade,
# bordas suavizadas) numa grade limpa de meias células, com cores chapadas.
# Saída:
#   assets/robot-done-app.png  256x256, recortada justa no desenho (16 px por célula, pés no chão), para o
#                              robô encher o avatar. É a que o index.html usa.
# O original fica intacto: é a arte de onde a versão do app sai.
# Uso: py -3 testes/gerar-robot-done.py
import pathlib
import numpy as np
from PIL import Image

PROJECT = pathlib.Path(__file__).resolve().parents[1]
ORIGEM = PROJECT / 'assets/robot-done.png'
NX, NY = 24, 30          # o robô tem 12x15 células; a grade é de meias células, como no robô dormindo
ESCALA = 8               # px por meia célula = 16 px por célula, igual ao robot-idle.gif

a = np.array(Image.open(ORIGEM).convert('RGBA')).astype(float)
alfa = a[..., 3]
verde = (a[..., 1] > a[..., 0] + 40) & (a[..., 1] > a[..., 2] + 40) & (alfa > 24)

# 1. O check é a caixa dos pixels verdes (acima e à direita da cabeça, sem encostar nela); o corpo é o resto.
mask = alfa > 24
ys, xs = np.nonzero(verde)
k0, k1, l0, l1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
corpo_m = mask.copy(); corpo_m[l0 - 3:l1 + 3, k0 - 3:k1 + 3] = False
ys_c, xs_c = np.nonzero(corpo_m)
X0, X1, Y0, Y1 = xs_c.min(), xs_c.max() + 1, ys_c.min(), ys_c.max() + 1
cw, ch = (X1 - X0) / NX, (Y1 - Y0) / NY

# 2. Paleta do corpo: k-médias nos pixels opacos (a suavização vira ruído e some no voto).
px = a[(alfa > 200) & ~verde][:, :3]
amostra = px[np.random.default_rng(0).choice(len(px), 40000, replace=False)]
C = np.array([[36, 34, 64], [140, 132, 146], [112, 112, 108], [180, 204, 218], [96, 94, 88],
              [150, 176, 192], [52, 60, 56], [120, 120, 118]], float)
for _ in range(30):
    l = ((amostra[:, None] - C[None]) ** 2).sum(2).argmin(1)
    C = np.array([amostra[l == k].mean(0) if (l == k).any() else C[k] for k in range(len(C))])
CONTORNO = int(((C - [36, 34, 64]) ** 2).sum(1).argmin())


def rotulos(reg):
    L = ((reg[..., None, :3] - C) ** 2).sum(-1).argmin(-1)
    L[reg[..., 3] < 128] = -1
    return L


# 3. Corpo na grade 24x30: cada meia célula fica com a cor que domina o miolo dela (50% do centro).
corpo = np.full((NY, NX), -1)
for j in range(NY):
    for i in range(NX):
        reg = a[int(round(Y0 + (j + .25) * ch)):int(round(Y0 + (j + .75) * ch)),
                int(round(X0 + (i + .25) * cw)):int(round(X0 + (i + .75) * cw))]
        v, n = np.unique(rotulos(reg), return_counts=True)
        corpo[j, i] = v[n.argmax()]

# 4. Rosto: no original, os olhos ^^ e a boca não seguem a grade (larguras de 0,8 a 1,2 meia célula),
#    e o voto os entorta. Redesenhados na grade, no lugar e no tamanho do original:
#    olho = arco de 4x2 (barra de 2 em cima, pernas de 1 nos lados); boca = 4x1 e 2x1 embaixo.
for j in range(10, 15):
    for i in range(9, 19):
        if corpo[j, i] == CONTORNO: corpo[j, i] = corpo[15, i]  # apaga o rosto votado: vira a tela logo abaixo
OLHO = [(0, 1), (0, 2), (1, 0), (1, 3)]
def pos(x, y): return round((x - X0) / cw), round((y - Y0) / ch)
oe, oy = pos(540, 578)      # olho esquerdo: canto de cima à esquerda, medido no original
od, _ = pos(733, 578)       # olho direito
for (dj, di) in OLHO:
    corpo[oy + dj, oe + di] = CONTORNO
    corpo[oy + dj, od + di] = CONTORNO
bx, by = pos(634, 658)      # boca
for di in range(4): corpo[by, bx + di] = CONTORNO
for di in range(1, 3): corpo[by + 1, bx + di] = CONTORNO

# 5. Check: tem a própria grade (pixel de ~24 px no original, 3/4 da meia célula). Fica nela, para não
#    perder o contorno verde-escuro e o miolo claro; na saída, cada pixel do check tem 6 px.
KX, KY = 7, 6
kw, kh = (k1 - k0) / KX, (l1 - l0) / KY
check = np.zeros((KY, KX, 4), np.uint8)
for j in range(KY):
    for i in range(KX):
        reg = a[int(l0 + (j + .3) * kh):int(l0 + (j + .7) * kh), int(k0 + (i + .3) * kw):int(k0 + (i + .7) * kw)]
        if np.median(reg[..., 3]) < 128: continue
        check[j, i] = (*np.median(reg[..., :3].reshape(-1, 3), 0).astype(int), 255)
# Duas cores só: verde-escuro (contorno) e verde-claro (miolo).
vivos = check[..., 3] > 0
lum = check[..., 1].astype(int)
claro = vivos & (lum > (lum[vivos].min() + lum[vivos].max()) / 2)
escuro_c = tuple(int(v) for v in np.median(check[vivos & ~claro][:, :3], 0))
claro_c = tuple(int(v) for v in np.median(check[claro][:, :3], 0))
check[vivos & ~claro, :3] = escuro_c
check[claro, :3] = claro_c

# 6. Composição: 40x40 meias células; corpo em (8,10), pés na última linha como o robot-idle.gif.
LADO = 40
im = np.zeros((LADO, LADO, 4), np.uint8)
for j in range(NY):
    for i in range(NX):
        k = corpo[j, i]
        if k >= 0: im[10 + j, 8 + i] = (*np.round(C[k]).astype(int), 255)
saida = Image.fromarray(im, 'RGBA').resize((LADO * ESCALA, LADO * ESCALA), Image.NEAREST)
PK = round(kw / cw * ESCALA)                                  # px por pixel do check na saída
ckx = 8 * ESCALA + round((k0 - X0) / cw * ESCALA)
cky = 10 * ESCALA + round((l0 - Y0) / ch * ESCALA)
saida.alpha_composite(Image.fromarray(check, 'RGBA').resize((KX * PK, KY * PK), Image.NEAREST), (ckx, cky))

# 7. Recorte justo (pedido do usuário, 15/10): no enquadramento do robot-idle o robô ficava pequeno no avatar.
#    Quadrado com 2 meias células de folga em cima, pés no chão e o desenho (corpo + check) centrado na largura.
x0, y0, x1, y1 = saida.getbbox()
lado = (y1 - y0) + 2 * ESCALA
cx = (x0 + x1) // 2
saida = saida.crop((cx - lado // 2, y1 - lado, cx - lado // 2 + lado, y1))
saida.save(PROJECT / 'assets/robot-done-app.png', optimize=True)

print('corpo', (X0, X1, Y0, Y1), 'meia célula', round(cw, 1), round(ch, 1))
print('paleta', np.round(C).astype(int).tolist(), 'contorno', CONTORNO)
print('olhos', (oe, oy), (od, oy), 'boca', (bx, by))
print('check', (k0, k1, l0, l1), 'pixel', round(kw, 1), round(kh, 1), '-> saída', PK, 'px em', (ckx, cky), escuro_c, claro_c)
print('\n'.join(''.join('#' if c[3] and c[1] < 200 else ('+' if c[3] else '.') for c in linha) for linha in check))
