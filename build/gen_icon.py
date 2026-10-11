# -*- coding: utf-8 -*-
"""生成 CubeAgent 图标：512x512 深色圆角方形 + 蓝色等距立方体
与界面设计系统一致：底色取 --canvas/--elevated，立方体取 --accent 三档。
"""
from PIL import Image, ImageDraw

SIZE = 512
RADIUS = 112
C1 = (10, 12, 16)      # --canvas   #0a0c10
C2 = (30, 36, 48)      # --elevated #1e2430

F_TOP = (124, 185, 255)   # --accent-hi  #7cb9ff
F_LEFT = (31, 111, 235)   # #1f6feb
F_RIGHT = (88, 166, 255)  # --accent     #58a6ff

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

# 对角线渐变底
grad = Image.new("RGBA", (SIZE, SIZE))
gp = grad.load()
for y in range(SIZE):
    for x in range(0, SIZE, 4):
        t = (x * 0.6 + y) / (1.6 * SIZE)
        c = tuple(int(C1[i] + (C2[i] - C1[i]) * t) for i in range(3)) + (255,)
        for dx in range(4):
            if x + dx < SIZE:
                gp[x + dx, y] = c

# 圆角蒙版
mask = Image.new("L", (SIZE, SIZE), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=RADIUS, fill=255)
img.paste(grad, (0, 0), mask)

# 等距立方体
d = ImageDraw.Draw(img)
cx, cy = SIZE / 2, SIZE / 2 + 8
w, h = 148, 85
v = 176

top_face = [(cx, cy - v / 2 - h), (cx + w, cy - v / 2), (cx, cy - v / 2 + h), (cx - w, cy - v / 2)]
left_face = [(cx - w, cy - v / 2), (cx, cy - v / 2 + h), (cx, cy + v / 2 + h), (cx - w, cy + v / 2)]
right_face = [(cx + w, cy - v / 2), (cx, cy - v / 2 + h), (cx, cy + v / 2 + h), (cx + w, cy + v / 2)]

d.polygon(top_face, fill=F_TOP + (255,))
d.polygon(left_face, fill=F_LEFT + (255,))
d.polygon(right_face, fill=F_RIGHT + (255,))

# 棱线：淡色描边提升小尺寸下的清晰度
edge = (10, 12, 16, 130)
for face in (top_face, left_face, right_face):
    d.line(face + [face[0]], fill=edge, width=5)

img.save("build/icon.png")

# ICO 多尺寸（Windows 打包用）
img.save("build/icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("icon.png / icon.ico generated")
