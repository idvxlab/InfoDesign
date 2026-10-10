"""Generated synthetic PDFs only. No company data or nonstandard embedded fonts."""
import io
from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader


def image_bytes(text="SCAN TEXT 987"):
    im = Image.new("RGB", (300, 120), "#df382b")
    ImageDraw.Draw(im).text((15, 45), text, fill="white")
    out = io.BytesIO()
    im.save(out, "PNG")
    return out.getvalue()


def simple_pdf(path, text="Synthetic document", rotation=0, crop=False, encrypt=None):
    c = canvas.Canvas(str(path), pagesize=(600, 800), invariant=1, encrypt=encrypt)
    c.setPageRotation(rotation)
    if crop:
        c.setCropBox((40, 40, 760, 560) if rotation in (90, 270) else (40, 40, 560, 760))
    c.drawString(70, 500 if rotation in (90, 270) else 700, text)
    c.save()


def sample_pdf(path):
    c = canvas.Canvas(str(path), pagesize=(600, 800), invariant=1)
    c.setFont("Helvetica", 18)
    c.drawString(50, 745, "Synthetic table and source coordinates")
    c.setFont("Helvetica", 11)
    rows = [["Year", "Amount", "Basis"], ["2023", "12.50", "CNY, excl tax"],
            ["2024", "125000", "CNY, incl tax"], ["2025", "0", "planned hours"]]
    xs = [50, 140, 270, 520]
    ys = [680, 640, 600, 560, 520]
    for x in xs:
        c.line(x, ys[-1], x, ys[0])
    for y in ys:
        c.line(xs[0], y, xs[-1], y)
    for i, row in enumerate(rows):
        for j, cell in enumerate(row):
            c.drawString(xs[j] + 10, ys[i] - 25, cell)
    c.drawString(50, 460, "No normalization or fact acceptance is performed.")
    c.showPage()
    c.drawString(50, 745, "Native text with an embedded image; no table")
    c.drawImage(ImageReader(io.BytesIO(image_bytes())), 70, 480, width=300, height=120)
    c.showPage()
    c.drawImage(ImageReader(io.BytesIO(image_bytes("IMAGE ONLY PAGE"))), 70, 480, width=300, height=120)
    c.showPage()
    c.showPage()  # Intentional blank page, never reported as understood.
    c.save()


if __name__ == "__main__":
    import sys
    sample_pdf(sys.argv[1])
