#!/usr/bin/env python3
"""Convert ANSI art (printf format with \e escape codes) to PNG."""
import re
from PIL import Image

with open('/home/tetsuo/git/AgenC/img2', 'r') as f:
    raw = f.read()

# Strip printf wrapper
raw = raw.replace('printf "', '', 1)
if raw.rstrip().endswith('";'):
    raw = raw.rstrip()[:-2]

# Convert literal \e to actual ESC, literal \n to newline
raw = raw.replace(r'\e', '\x1b').replace(r'\n', '\n')

lines = raw.split('\n')
# Remove empty trailing lines
while lines and not lines[-1].strip():
    lines.pop()

def parse_line(line):
    """Parse one line of ANSI escape sequences into pixel colors."""
    pixels = []
    bg = (14, 14, 14)
    fg = (255, 255, 255)

    i = 0
    while i < len(line):
        if line[i] == '\x1b' and i + 1 < len(line) and line[i+1] == '[':
            # Find the 'm' terminator
            end = line.find('m', i + 2)
            if end == -1:
                i += 1
                continue
            codes_str = line[i+2:end]
            codes = codes_str.split(';')

            j = 0
            while j < len(codes):
                try:
                    c = int(codes[j])
                except (ValueError, IndexError):
                    j += 1
                    continue

                if c == 38 and j+4 < len(codes) and codes[j+1] == '2':
                    fg = (int(codes[j+2]), int(codes[j+3]), int(codes[j+4]))
                    j += 5
                elif c == 48 and j+4 < len(codes) and codes[j+1] == '2':
                    bg = (int(codes[j+2]), int(codes[j+3]), int(codes[j+4]))
                    j += 5
                elif c == 0:
                    bg = (14, 14, 14)
                    fg = (255, 255, 255)
                    j += 1
                else:
                    j += 1

            i = end + 1
        else:
            ch = line[i]
            if ch == '▄':  # Lower half block: top=bg, bottom=fg
                pixels.append(('half', bg, fg))
            elif ch == '▀':  # Upper half block
                pixels.append(('half', fg, bg))
            elif ch == ' ':
                pixels.append(bg)
            else:
                pixels.append(bg)
            i += 1

    return pixels

parsed = []
max_w = 0
for line in lines:
    px = parse_line(line)
    parsed.append(px)
    max_w = max(max_w, len(px))

print(f"Parsed {len(parsed)} lines, max width {max_w}")

# Each character = 1px wide, 2px tall (half blocks)
w = max_w
h = len(parsed) * 2

img = Image.new('RGB', (w, h), (14, 14, 14))

for y, row in enumerate(parsed):
    for x, px in enumerate(row):
        if isinstance(px, tuple) and len(px) == 3 and isinstance(px[0], int):
            img.putpixel((x, y*2), px)
            img.putpixel((x, y*2+1), px)
        elif isinstance(px, tuple) and px[0] == 'half':
            _, top, bot = px
            img.putpixel((x, y*2), top)
            img.putpixel((x, y*2+1), bot)

# Scale up 8x for visibility
scale = 8
big = img.resize((w * scale, h * scale), Image.NEAREST)
big.save('/home/tetsuo/git/AgenC/ansi_girl.png')
print(f"Saved {w}x{h} -> {w*scale}x{h*scale} ansi_girl.png")
