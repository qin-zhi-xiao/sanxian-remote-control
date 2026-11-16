"""生成快传的程序图标 kuaichuan.ico
深色圆角块 + 白色「快」+ 青色一道弧，和网页控制台配色一致。
"""
import os
from PIL import Image, ImageDraw, ImageFont

SIZE = 256
BG = (14, 16, 19, 255)          # #0e1013 深色底
BORDER = (44, 49, 56, 255)      # #2c3138 细边
WHITE = (232, 234, 237, 255)    # #e8eaed
CYAN = (95, 208, 138, 255)      # #5fd08a 强调色

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角底
d.rounded_rectangle([8, 8, SIZE - 8, SIZE - 8], radius=52, fill=BG,
                    outline=BORDER, width=3)

# 一道青色的弧（暗示"传"）
d.arc([40, 188, 216, 272], start=196, end=344, fill=CYAN, width=13)

# 「快」字
font = ImageFont.truetype(r"C:\Windows\Fonts\msyhbd.ttc", 132)
text = "快"
bbox = d.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
tx = (SIZE - tw) / 2 - bbox[0]
ty = (SIZE - th) / 2 - bbox[1] - 26
d.text((tx, ty), text, font=font, fill=WHITE)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kuaichuan.ico")
img.save(out, format="ICO",
         sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

# 顺手导一张 PNG 给网页控制台当 favicon
img.save(os.path.join(os.path.dirname(out), "kuaichuan-256.png"), format="PNG")
print("ok", out, os.path.getsize(out), "bytes")
