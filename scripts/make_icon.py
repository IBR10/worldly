"""Generate the Worldly app icon — a stylised globe — as a multi-size .ico.

Pure Pillow, no external assets. Draws an ocean-blue sphere with green
landmasses and faint lat/long lines on a rounded indigo tile, matching the
app's dark UI palette. Run once:

    python scripts/make_icon.py

Output: assets/worldly.ico  (sizes 16,32,48,64,128,256)
"""
from __future__ import annotations
import math
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "worldly.ico")
# Master render at high resolution, then downscale for crisp small sizes.
SS = 1024  # supersample canvas
PALETTE = {
    "tile_top": (37, 55, 110),     # indigo
    "tile_bot": (15, 21, 37),      # near-black navy (matches app --bg)
    "ocean_top": (79, 140, 255),   # app --primary
    "ocean_bot": (32, 92, 210),
    "land": (54, 211, 153),        # app --good (green)
    "land_dk": (38, 168, 120),
    "grid": (230, 240, 255),
}


def vgrad(size, top, bot):
    """Vertical gradient image."""
    img = Image.new("RGB", (1, size), top)
    for y in range(size):
        t = y / max(1, size - 1)
        img.putpixel((0, y), tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    return img.resize((size, size))


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def circle_mask(size, box):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).ellipse(box, fill=255)
    return m


def build(size=SS):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # --- rounded background tile ---
    tile = vgrad(size, PALETTE["tile_top"], PALETTE["tile_bot"]).convert("RGBA")
    tile.putalpha(rounded_mask(size, int(size * 0.22)))
    img.alpha_composite(tile)

    # --- globe sphere ---
    pad = int(size * 0.14)
    box = [pad, pad, size - pad, size - pad]
    gx0, gy0, gx1, gy1 = box
    gw, gh = gx1 - gx0, gy1 - gy0

    ocean = vgrad(size, PALETTE["ocean_top"], PALETTE["ocean_bot"]).convert("RGBA")
    sphere = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sphere.paste(ocean, (0, 0), circle_mask(size, box))
    img.alpha_composite(sphere)

    # --- stylised landmasses (blobby polygons) clipped to the sphere ---
    land_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ld = ImageDraw.Draw(land_layer)

    def blob(cx, cy, rx, ry, n=12, jitter=0.28, seed=0.0, color=PALETTE["land"]):
        pts = []
        for i in range(n):
            a = 2 * math.pi * i / n
            wob = 1 + jitter * math.sin(3 * a + seed) * math.cos(2 * a - seed)
            pts.append((cx + math.cos(a) * rx * wob, cy + math.sin(a) * ry * wob))
        ld.polygon(pts, fill=color)

    # a few continent-like masses positioned over the sphere
    blob(gx0 + gw * 0.34, gy0 + gh * 0.30, gw * 0.16, gh * 0.13, seed=0.4)
    blob(gx0 + gw * 0.32, gy0 + gh * 0.62, gw * 0.12, gh * 0.17, seed=1.1, color=PALETTE["land_dk"])
    blob(gx0 + gw * 0.66, gy0 + gh * 0.40, gw * 0.18, gh * 0.20, seed=2.2)
    blob(gx0 + gw * 0.70, gy0 + gh * 0.70, gw * 0.10, gh * 0.09, seed=3.0, color=PALETTE["land_dk"])

    land_layer.putalpha(Image.composite(land_layer.getchannel("A"),
                                         Image.new("L", (size, size), 0),
                                         circle_mask(size, box)))
    img.alpha_composite(land_layer)

    # --- latitude / longitude grid lines ---
    grid = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    lw = max(2, size // 220)
    col = PALETTE["grid"] + (70,)
    # outline
    gd.ellipse(box, outline=PALETTE["grid"] + (160,), width=lw)
    # parallels (horizontal ellipses)
    for f in (0.5, 0.72, 0.28):
        h = gh * f
        gd.ellipse([gx0, gy0 + gh / 2 - h / 2, gx1, gy0 + gh / 2 + h / 2], outline=col, width=lw)
    # meridians (vertical ellipses)
    for f in (1.0, 0.62, 0.30):
        w = gw * f
        gd.ellipse([gx0 + gw / 2 - w / 2, gy0, gx0 + gw / 2 + w / 2, gy1], outline=col, width=lw)
    grid.putalpha(Image.composite(grid.getchannel("A"),
                                  Image.new("L", (size, size), 0),
                                  circle_mask(size, box)))
    img.alpha_composite(grid)

    # --- glossy highlight ---
    gloss = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(gloss).ellipse(
        [gx0 + gw * 0.12, gy0 + gh * 0.08, gx0 + gw * 0.62, gy0 + gh * 0.42],
        fill=(255, 255, 255, 46))
    gloss.putalpha(Image.composite(gloss.getchannel("A"),
                                   Image.new("L", (size, size), 0),
                                   circle_mask(size, box)))
    img.alpha_composite(gloss)
    return img


def main():
    master = build(SS)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    sizes = [16, 32, 48, 64, 128, 256]
    imgs = [master.resize((s, s), Image.LANCZOS) for s in sizes]
    imgs[-1].save(OUT, format="ICO", sizes=[(s, s) for s in sizes])
    # Also drop a PNG preview for the README / docs.
    master.resize((256, 256), Image.LANCZOS).save(
        os.path.join(os.path.dirname(OUT), "worldly-icon.png"))
    print("wrote", os.path.normpath(OUT))


if __name__ == "__main__":
    main()
