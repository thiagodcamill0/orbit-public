# Gera os ícones do Orbit instalado (PWA) a partir de assets/logo.png, em assets/pwa/.
# Rodar da raiz do projeto:  py testes/gerar-icones-pwa.py
# - icone-<n>.png: o símbolo branco num quadrado arredondado #111111 (a cor da casca), como o
#   favicon da aba. De 16 a 32 px o quadrado ocupa tudo e o símbolo cresce, para ser legível.
# - icone-maskable-<n>.png: fundo cheio e o símbolo dentro da zona segura (círculo de 80%), para
#   sistemas que recortam o ícone em círculo ou gota.
import pathlib
from PIL import Image, ImageDraw

PROJETO = pathlib.Path(__file__).resolve().parents[1]
SAIDA = PROJETO / 'assets' / 'pwa'
SAIDA.mkdir(parents=True, exist_ok=True)

CASCA = (17, 17, 17, 255)      # --casca #111111
FIO = (46, 46, 46, 255)        # --fio-2 #2e2e2e
M = 1024                       # tela de trabalho; cada tamanho sai por redução (LANCZOS)

logo = Image.open(PROJETO / 'assets' / 'logo.png').convert('RGBA')
logo = logo.crop(logo.getchannel('A').getbbox())


def simbolo(lado):
    """O símbolo redimensionado para caber num quadrado de `lado` px, sem distorcer."""
    w, h = logo.size
    k = lado / max(w, h)
    return logo.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)


def colar_no_centro(base, img):
    x = (base.width - img.width) // 2
    y = (base.height - img.height) // 2
    base.alpha_composite(img, (x, y))


def mestre_any(pequeno):
    im = Image.new('RGBA', (M, M), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    margem = 0 if pequeno else round(M * 0.04)
    raio = round(M * (0.2 if pequeno else 0.22))
    caixa = (margem, margem, M - 1 - margem, M - 1 - margem)
    d.rounded_rectangle(caixa, raio, fill=CASCA)
    if not pequeno:
        # Fio sutil: sem ele o quadrado some na barra de tarefas escura do Windows.
        d.rounded_rectangle(caixa, raio, outline=FIO, width=round(M * 0.012))
    colar_no_centro(im, simbolo(round(M * (0.78 if pequeno else 0.6))))
    return im


def mestre_maskable():
    im = Image.new('RGBA', (M, M), CASCA)
    colar_no_centro(im, simbolo(round(M * 0.54)))
    return im


grande, pequeno, mask = mestre_any(False), mestre_any(True), mestre_maskable()
for n in (16, 24, 32, 48, 64, 96, 128, 144, 192, 256, 384, 512):
    (pequeno if n <= 32 else grande).resize((n, n), Image.LANCZOS).save(SAIDA / f'icone-{n}.png', optimize=True)
for n in (192, 512):
    mask.resize((n, n), Image.LANCZOS).convert('RGB').save(SAIDA / f'icone-maskable-{n}.png', optimize=True)
print('ícones em', SAIDA)
