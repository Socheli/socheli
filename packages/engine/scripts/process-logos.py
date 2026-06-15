#!/usr/bin/env python3
"""Turn a black-on-white (or black-on-transparent) logo into a clean
WHITE-on-transparent PNG. alpha = original_alpha * darkness, RGB = white.
Works for both white-bg and transparent-bg sources. Usage: process-logos.py <src> <dst>
"""
import sys
from PIL import Image

def main() -> int:
    src, dst = sys.argv[1], sys.argv[2]
    im = Image.open(src).convert("RGBA")
    out = []
    for r, g, b, a in im.getdata():
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        alpha = a * (255 - lum) / 255  # dark ink → opaque, white bg → transparent
        if alpha < 70:          # drop faint bg (baked-in checkerboard / light grays)
            alpha = 0
        elif alpha > 180:       # solidify the ink
            alpha = 255
        out.append((255, 255, 255, int(alpha)))
    im.putdata(out)
    im.save(dst)
    print(f"wrote {dst}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
