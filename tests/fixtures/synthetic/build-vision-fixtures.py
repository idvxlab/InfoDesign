#!/usr/bin/env python3
"""Build synthetic vision-test fixtures (4 PNG images + manifest.json).

Usage:
    python build-vision-fixtures.py <output_dir>

Creates a NEW directory containing exactly four 512x512 RGB PNG images
(text.png, chart.png, table.png, shapes.png) plus manifest.json.
All content is code-drawn with Pillow; no real documents, fonts from
private paths, or URLs are used.  ImageFont.load_default(size=24)
uses the font bundled with Pillow.

Exits after writing files.  Prints only the generated count and a
synthetic-fixture label.
"""

import hashlib
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

WIDTH = 512
HEIGHT = 512
MAX_BYTES = 128 * 1024  # 128 KiB per PNG

BLACK = (0, 0, 0)
WHITE = (255, 255, 255)
RED = (200, 30, 30)
BLUE = (30, 60, 200)
GREEN = (20, 150, 60)
GREY = (120, 120, 120)

# Expected answers are kept here only for the manifest; they are never
# leaked into the prompts.

# ---------------------------------------------------------------------------
# Font helper
# ---------------------------------------------------------------------------


def _font(size=24):
    """Return Pillow's bundled default font at the given size."""
    return ImageFont.load_default(size=size)


def _text(draw, xy, s, font):
    draw.text(xy, s, fill=BLACK, font=font)


# ---------------------------------------------------------------------------
# Case 1: text.png
# ---------------------------------------------------------------------------


def build_text(path):
    img = Image.new("RGB", (WIDTH, HEIGHT), WHITE)
    draw = ImageDraw.Draw(img)
    f_title = _font(28)
    f_body = _font(24)

    _text(draw, (40, 50), "ORBIT LAB", f_title)
    _text(draw, (40, 120), "Year: 2024", f_body)
    _text(draw, (40, 190), "Mass: 12.5 kg", f_body)
    _text(draw, (40, 260), "Temperature: 22 C", f_body)

    img.save(path, format="PNG")

    prompt = (
        "Read the image and return ONLY a JSON object with exactly these keys "
        "in this order: year, mass, temperature. The year is a number. The "
        "mass is an object with keys value (number) and unit (string). The "
        "temperature is an object with keys value (number) and unit (string). "
        "The temperature unit is the ASCII characters printed in the image; "
        "copy them exactly as shown. Return normal JSON with no Markdown and "
        "no surrounding text."
    )
    expected = {
        "year": 2024,
        "mass": {"value": 12.5, "unit": "kg"},
        "temperature": {"value": 22, "unit": "C"},
    }
    return prompt, expected


# ---------------------------------------------------------------------------
# Case 2: chart.png
# ---------------------------------------------------------------------------


def build_chart(path):
    img = Image.new("RGB", (WIDTH, HEIGHT), WHITE)
    draw = ImageDraw.Draw(img)
    f_title = _font(28)
    f_label = _font(24)
    f_val = _font(22)

    _text(draw, (40, 40), "FICTIONAL UNITS", f_title)

    # Baseline
    base_y = 420
    draw.line((80, base_y, 470, base_y), fill=BLACK, width=2)

    bars = [("A", 10), ("B", 20), ("C", 15)]
    max_val = 20
    bar_width = 70
    gap = 50
    start_x = 110
    top_y = 140
    usable_h = base_y - top_y

    for i, (label, val) in enumerate(bars):
        x0 = start_x + i * (bar_width + gap)
        x1 = x0 + bar_width
        h = int(usable_h * (val / max_val))
        y0 = base_y - h
        draw.rectangle((x0, y0, x1, base_y), outline=BLACK, fill=GREY)
        # category label below baseline
        _text(draw, (x0 + bar_width // 2 - 8, base_y + 12), label, f_label)
        # exact numeric value above bar
        _text(draw, (x0 + bar_width // 2 - 12, y0 - 32), str(val), f_val)

    img.save(path, format="PNG")

    prompt = (
        "Read the chart image and return ONLY a JSON object with exactly these "
        "keys in this order: values, highest. The values key maps to an object "
        "with category keys A, B and C, each mapped to its numeric value taken "
        "exactly from the image. The highest key is a string naming the "
        "category with the greatest value. Return normal JSON with no Markdown "
        "and no surrounding text."
    )
    expected = {"values": {"A": 10, "B": 20, "C": 15}, "highest": "B"}
    return prompt, expected


# ---------------------------------------------------------------------------
# Case 3: table.png
# ---------------------------------------------------------------------------


def build_table(path):
    img = Image.new("RGB", (WIDTH, HEIGHT), WHITE)
    draw = ImageDraw.Draw(img)
    f_head = _font(26)
    f_cell = _font(24)

    # Table geometry
    left = 90
    right = 430
    top = 90
    row_h = 80
    n_rows = 4  # header + 3 data rows
    bottom = top + row_h * n_rows

    # Row lines
    for r in range(n_rows + 1):
        y = top + r * row_h
        draw.line((left, y, right, y), fill=BLACK, width=2)
    # Column lines
    mid = (left + right) // 2
    draw.line((left, top, left, bottom), fill=BLACK, width=2)
    draw.line((mid, top, mid, bottom), fill=BLACK, width=2)
    draw.line((right, top, right, bottom), fill=BLACK, width=2)

    header = ("Year", "Units")
    rows = [("2023", "120"), ("2024", "150"), ("2025", "90")]

    # Header cells (centered-ish)
    _text(draw, (left + 60, top + 24), header[0], f_head)
    _text(draw, (mid + 60, top + 24), header[1], f_head)

    for i, (year, units) in enumerate(rows):
        y = top + (i + 1) * row_h + 24
        _text(draw, (left + 60, y), year, f_cell)
        _text(draw, (mid + 60, y), units, f_cell)

    img.save(path, format="PNG")

    prompt = (
        "Read the table image and return ONLY a JSON object with a single key "
        "rows. The rows key maps to an array of objects, one per data row in "
        "top-to-bottom order as shown. Each row object has exactly two keys in "
        "this order: year (number) and units (number), with the exact numeric "
        "values read from the image. Return normal JSON with no Markdown and "
        "no surrounding text."
    )
    expected = {
        "rows": [
            {"year": 2023, "units": 120},
            {"year": 2024, "units": 150},
            {"year": 2025, "units": 90},
        ]
    }
    return prompt, expected


# ---------------------------------------------------------------------------
# Case 4: shapes.png
# ---------------------------------------------------------------------------


def build_shapes(path):
    img = Image.new("RGB", (WIDTH, HEIGHT), WHITE)
    draw = ImageDraw.Draw(img)

    # Two red circles (well separated, in the top half)
    draw.ellipse((60, 60, 160, 160), fill=RED, outline=BLACK)
    draw.ellipse((300, 60, 400, 160), fill=RED, outline=BLACK)

    # One blue square (bottom-left)
    draw.rectangle((70, 330, 170, 430), fill=BLUE, outline=BLACK)

    # Three green triangles (bottom-right area, separated)
    def triangle(cx, cy, r):
        pts = [
            (cx, cy - r),
            (cx - r, cy + r),
            (cx + r, cy + r),
        ]
        draw.polygon(pts, fill=GREEN, outline=BLACK)

    triangle(300, 380, 45)
    triangle(400, 380, 45)
    triangle(350, 260, 45)

    img.save(path, format="PNG")

    prompt = (
        "Read the shapes image and return ONLY a JSON object with exactly "
        "these keys in this order: red_circles, blue_squares, "
        "green_triangles. Each value is the count (number) of shapes of that "
        "color and form visible in the image. Return normal JSON with no "
        "Markdown and no surrounding text."
    )
    expected = {"red_circles": 2, "blue_squares": 1, "green_triangles": 3}
    return prompt, expected


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

# (id, filename, builder) in required manifest order.
CASES = [
    ("text", "text.png", build_text),
    ("chart", "chart.png", build_chart),
    ("table", "table.png", build_table),
    ("shapes", "shapes.png", build_shapes),
]


def _verify_png(path):
    """Assert PNG dimensions and size budget; return sha256 hexdigest."""
    with Image.open(path) as im:
        assert im.format == "PNG", "not a PNG: %s" % path
        assert im.mode == "RGB", "not RGB: %s" % path
        assert im.size == (WIDTH, HEIGHT), "bad size for %s: %r" % (path, im.size)
    size = os.path.getsize(path)
    assert size <= MAX_BYTES, "%s is %d bytes (> %d)" % (path, size, MAX_BYTES)
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv):
    if len(argv) != 2:
        sys.stderr.write("usage: %s <output_dir>\n" % os.path.basename(argv[0]))
        return 2

    out_dir = argv[1]

    if os.path.exists(out_dir):
        sys.stderr.write("refusing: output path already exists: %s\n" % out_dir)
        return 1

    os.makedirs(out_dir, exist_ok=False)

    cases = []
    for case_id, filename, builder in CASES:
        path = os.path.join(out_dir, filename)
        prompt, expected = builder(path)
        digest = _verify_png(path)
        cases.append(
            {
                "id": case_id,
                "file": filename,
                "sha256": "sha256:" + digest,
                "prompt": prompt,
                "expected": expected,
            }
        )

    manifest = {"version": 1, "cases": cases}
    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=True, indent=2)
        fh.write("\n")

    print("generated %d synthetic fixtures in %s" % (len(cases), out_dir))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))