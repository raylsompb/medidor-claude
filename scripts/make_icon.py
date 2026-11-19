"""Gera build/icon.ico: quadrado escuro arredondado com medidor colorido."""
from PIL import Image, ImageDraw
import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STOPS = [(0.0, (215, 240, 255)), (0.25, (96, 180, 255)), (0.5, (255, 210, 40)), (0.8, (255, 70, 60)), (1.0, (190, 20, 30))]
def col(v):
    for (a, ca), (b, cb) in zip(STOPS, STOPS[1:]):
        if v <= b:
            t = (v - a) / (b - a)
            return tuple(int(ca[i] + (cb[i] - ca[i]) * t) for i in range(3))
    return STOPS[-1][1]
N = 1024
im = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.rounded_rectangle((32, 32, N - 32, N - 32), radius=220, fill=(30, 31, 36, 255), outline=(255, 255, 255, 50), width=16)
n, x0, x1, top, bot = 7, 300, 724, 190, 834
sh = (bot - top) / n
for i in range(n):
    y = bot - (i + 1) * sh
    v = (i + 1) / n
    fill = col(v) + (255,) if i < 5 else (255, 255, 255, 40)
    d.rounded_rectangle((x0, y + 14, x1, y + sh - 14), radius=40, fill=fill)
out = os.path.join(ROOT, "build", "icon.ico")
im.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
im.resize((256, 256), Image.LANCZOS).save(os.path.join(ROOT, "build", "icon.png"))
print("ok", out)
