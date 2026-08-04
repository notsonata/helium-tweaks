#!/usr/bin/env python3
"""
Generate the extension toolbar icons (16/32/48/128 PNG) using ONLY the Python
standard library (zlib + struct). No PIL/Pillow or any other dependency.

Design: a rounded-rect sidebar panel in the template's palette
(panel #1d2021, border #3c4142) with a simple bookmark ribbon glyph
(text-strong #eceeee) inside. Keeps a single-pixel border that scales with size.

Usage:
    python3 tools/make-icons.py
Writes icons/icon-16.png, icon-32.png, icon-48.png, icon-128.png.
Overwrites existing files. Idempotent.
"""

import os
import struct
import zlib

# ---- palette (copied from the template) -------------------------------------
PANEL = (0x1D, 0x20, 0x21)       # --panel
BORDER = (0x3C, 0x41, 0x42)      # --panel-border
GLYPH = (0xEC, 0xEE, 0xEE)       # --text-strong
TRANSPARENT = (0, 0, 0, 0)


def in_rounded_rect(x, y, w, h, radius):
    """True if (x,y) is inside a w x h rounded rectangle of the given corner radius."""
    if radius <= 0:
        return 0 <= x < w and 0 <= y < h
    # Inside the inner (non-corner) cross: always in.
    if radius <= x <= w - 1 - radius or radius <= y <= h - 1 - radius:
        return 0 <= x < w and 0 <= y < h
    # Otherwise test against the four corner circle centers.
    corners = [
        (radius, radius),
        (w - 1 - radius, radius),
        (radius, h - 1 - radius),
        (w - 1 - radius, h - 1 - radius),
    ]
    for (cx, cy) in corners:
        dx = x - cx
        dy = y - cy
        if dx * dx + dy * dy <= radius * radius:
            return True
    return False


def in_ribbon(x, y, box):
    """
    Bookmark ribbon centered in the panel, sized to the given box.

    box = (gx, gy, gw, gh) — the glyph bounding box in icon pixel space.

    The ribbon is a solid vertical "flag" with a V-shaped notch cut from the
    bottom center, matching the pin/ribbon motif used in the sidebar footer.
    """
    gx, gy, gw, gh = box
    if gw <= 0 or gh <= 0:
        return False
    # Normalized coords within the glyph box (0..1).
    nx = (x - gx) / gw
    ny = (y - gy) / gh
    if not (0.0 <= nx <= 1.0 and 0.0 <= ny <= 1.0):
        return False

    # Margins (in normalized units) — keep the glyph clear of the border.
    left = 0.30
    right = 0.70
    top = 0.26
    bottom = 0.74
    stroke_half = 0.055  # half the side-stroke thickness
    notch = 0.18         # how far the bottom-center V reaches up

    if nx < left or nx > right or ny < top or ny > bottom:
        return False

    # Cut a V notch from the bottom center.
    # The notch is a triangle with apex at (0.5, bottom - notch*height).
    apex_y = bottom - notch * (bottom - top)
    center_x = 0.5
    half_notch_width = (right - left) / 2.0
    # Slope: at ny between apex_y and bottom, excluded x range narrows.
    if ny >= apex_y:
        t = (ny - apex_y) / (bottom - apex_y) if bottom > apex_y else 1.0
        dx = half_notch_width * t
        if center_x - dx <= nx <= center_x + dx:
            return False

    # Within the outer outline; the only filled-ish part is the outline ring,
    # but for a clear glyph at small sizes we make the whole body a solid shape
    # with the notch cut. So everything not in the notch is "in".
    return True


def render_icon(size):
    """Return raw RGBA bytes for a size x size icon."""
    width = height = size
    # Panel slightly inset so the border ring sits at the very edge.
    panel_inset = 1 if size <= 32 else 1
    panel_w = width - 2 * panel_inset
    panel_h = height - 2 * panel_inset
    corner = max(1, size // 6)  # rounded corners scale with size

    # Glyph bounding box (centered), sized to leave a margin inside the panel.
    margin = max(2, size // 6)
    gx = panel_inset + margin
    gy = panel_inset + margin
    gw = width - 2 * (panel_inset + margin)
    gh = height - 2 * (panel_inset + margin)

    rgba = bytearray(width * height * 4)
    for y in range(height):
        for x in range(width):
            px = x - panel_inset
            py = y - panel_inset
            inside = in_rounded_rect(px, py, panel_w, panel_h, corner)
            if not inside:
                # Outside the panel: transparent.
                continue
            # Border ring: 1px at small sizes, 2px at large.
            bw = 1 if size <= 32 else 2
            on_border = (
                px < bw
                or py < bw
                or px >= panel_w - bw
                or py >= panel_h - bw
            )
            if on_border:
                color = BORDER + (255,)
            else:
                # Glyph pixels override the panel fill.
                if in_ribbon(x, y, (gx, gy, gw, gh)):
                    color = GLYPH + (255,)
                else:
                    color = PANEL + (255,)
            i = (y * width + x) * 4
            rgba[i : i + 4] = bytes(color)
    return bytes(rgba), width, height


def write_png(path, rgba, width, height):
    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    # Each scanline prefixed with filter byte 0.
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        raw.extend(rgba[y * stride : (y + 1) * stride])
    idat = zlib.compress(bytes(raw), 9)

    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    icons_dir = os.path.join(here, "..", "icons")
    os.makedirs(icons_dir, exist_ok=True)
    for size in (16, 32, 48, 128):
        rgba, w, h = render_icon(size)
        out = os.path.join(icons_dir, f"icon-{size}.png")
        write_png(out, rgba, w, h)
        print(f"wrote {os.path.relpath(out, here)} ({w}x{h})")


if __name__ == "__main__":
    main()
