"""Boundary fixtures for Windows PDF acceptance; no model-quality claims."""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from PIL import Image, ImageDraw
from pypdf import PdfReader

out = Path(__file__).resolve().parents[1] / "output/windows-acceptance/papers"
out.mkdir(parents=True, exist_ok=True)

c = canvas.Canvas(str(out / "blank.pdf"))
c.showPage()
c.save()

im = Image.new("RGB", (1200, 300), "white")
d = ImageDraw.Draw(im)
d.text((40, 100), "Scanned page: this sentence exists only as pixels.", fill="black", font_size=32)
c = canvas.Canvas(str(out / "scanned.pdf"))
c.drawImage(ImageReader(im), 40, 580, width=520, height=130)
c.showPage()
c.save()

c = canvas.Canvas(str(out / "ambiguous.pdf"))
for y in (740, 680):
    c.drawString(50, y, "The repeated evidence sentence must be disambiguated.")
for i in range(10):
    c.drawString(50, 620-i*30, f"Evidence entry {i+1:02d} has a unique grounded passage.")
c.showPage()
c.save()

c = canvas.Canvas(str(out / "replacement.pdf"))
c.drawString(50, 740, "This replacement PDF has different content and geometry.")
c.showPage()
c.save()

for name in ("blank", "scanned", "ambiguous", "replacement"):
    reader = PdfReader(out / f"{name}.pdf")
    print(name, "pages", len(reader.pages), "text_chars", sum(len(p.extract_text()) for p in reader.pages))
