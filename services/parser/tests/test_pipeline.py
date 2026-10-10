import json
import math
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from reportlab.lib.pdfencrypt import StandardEncryption
from pdfplumber.page import Page

from src.pipeline import parse_pdf, ParseRejected, fingerprint
from src.source_locator import page_region
from fixtures import sample_pdf, simple_pdf
from reportlab.pdfgen import canvas


class PdfPipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.pdf = self.root / "synthetic.pdf"
        sample_pdf(self.pdf)

    def tearDown(self):
        self.temp.cleanup()

    def parse(self, name="result", **kwargs):
        return parse_pdf(self.pdf, self.root / name, **kwargs)

    def test_real_grid_cells_values_coordinates_and_hash(self):
        d = self.parse()
        table = next(b["table"] for b in d["pages"][0]["blocks"] if b["type"] == "table")
        self.assertEqual(table["rows"], [["Year", "Amount", "Basis"], ["2023", "12.50", "CNY, excl tax"],
                                         ["2024", "125000", "CNY, incl tax"], ["2025", "0", "planned hours"]])
        self.assertEqual(table["location"]["bbox"], {"x": 50.0, "y": 120.0, "width": 470.0, "height": 160.0})
        cell = next(c for c in table["cells"] if c["row"] == 1 and c["column"] == 1)
        self.assertEqual(cell["text"], "12.50")
        self.assertEqual(cell["location"]["bbox"], {"x": 140.0, "y": 160.0, "width": 130.0, "height": 40.0})
        self.assertEqual(table["source_hash"], fingerprint(self.pdf.read_bytes()))
        self.assertEqual(d["pages"][1]["counts"]["table"], 0)

    def test_image_crop_matches_known_color_and_location(self):
        d = self.parse()
        b = next(b for b in d["pages"][1]["blocks"] if b["type"] == "image")
        self.assertEqual(b["location"]["bbox"], {"x": 70.0, "y": 200.0, "width": 300.0, "height": 120.0})
        self.assertEqual(b["text"], "")
        self.assertEqual(b["status"], "extracted_not_understood")
        with Image.open(self.root / "result" / b["asset"]) as image:
            self.assertEqual(image.getpixel((20, 20))[:3], (223, 56, 43))

    def test_scan_and_blank_are_not_claimed_as_text_or_table(self):
        d = self.parse()
        self.assertEqual(d["pages"][2]["counts"]["paragraph"], 0)
        self.assertEqual(d["pages"][2]["counts"]["table"], 0)
        self.assertIn("OCR_not_run", d["pages"][2]["text_status"])
        self.assertEqual(d["pages"][3]["blocks"][0]["status"], "unsupported")
        ir = json.loads((self.root / "result/document-ir.json").read_text())
        self.assertEqual(ir["parseInfo"]["quality"], "partial")
        self.assertTrue(ir["parseInfo"]["unsupported"])

    def test_no_outbound_calls_and_reproducible_ir(self):
        with patch.object(socket, "create_connection", side_effect=AssertionError("network forbidden")):
            self.parse("a")
            self.parse("b")
        self.assertEqual((self.root / "a/document-ir.json").read_bytes(), (self.root / "b/document-ir.json").read_bytes())
        self.assertEqual((self.root / "a/source.pdf").read_bytes(), self.pdf.read_bytes())

    def test_revision_changes_hash_and_version_id(self):
        self.parse("a")
        simple_pdf(self.pdf, "changed contents")
        self.parse("b")
        a = json.loads((self.root / "a/document-ir.json").read_text())
        b = json.loads((self.root / "b/document-ir.json").read_text())
        self.assertNotEqual(a["contentHash"], b["contentHash"])
        self.assertNotEqual(a["documentVersionId"], b["documentVersionId"])

    def test_output_cannot_overwrite_existing_result(self):
        self.parse()
        before = (self.root / "result/document-ir.json").read_bytes()
        with self.assertRaisesRegex(ParseRejected, "output_already_exists"):
            self.parse()
        self.assertEqual((self.root / "result/document-ir.json").read_bytes(), before)

    def test_corrupt_source_rejected_without_preview(self):
        self.pdf.write_bytes(b"%PDF-broken")
        with self.assertRaisesRegex(ParseRejected, "pdf_open_failed"):
            self.parse()
        self.assertFalse((self.root / "result/index.html").exists())

    def test_encrypted_source_is_not_silently_empty(self):
        simple_pdf(self.pdf, encrypt=StandardEncryption("secret"))
        with self.assertRaises(ParseRejected):
            self.parse()

    def test_limits_and_invalid_ids_fail_closed(self):
        with patch("src.pipeline.MAX_PAGES", 1), self.assertRaisesRegex(ParseRejected, "page_limit"):
            self.parse()
        with patch("src.pipeline.MAX_BYTES", 10), self.assertRaises(ParseRejected):
            self.parse()
        with self.assertRaisesRegex(ParseRejected, "invalid_project_id"):
            self.parse(project_id="../../private")
        with patch("src.pipeline.MAX_BLOCKS", 1), self.assertRaisesRegex(ParseRejected, "block_limit"):
            self.parse()
        self.assertFalse((self.root / "result/index.html").exists())
        self.assertFalse(json.loads((self.root / "result/failure.json").read_text())["usable_document_ir"])

    def test_render_failure_preserves_text_but_reports_failure(self):
        with patch.object(Page, "to_image", side_effect=RuntimeError("unsafe original message")):
            d = self.parse()
        self.assertEqual(d["status"], "partial_failure")
        self.assertGreater(d["counts"]["paragraph"], 0)
        self.assertEqual(d["pages"][0]["issues"][0]["code"], "page_render_failed")
        self.assertNotIn("unsafe original message", (self.root / "result/manifest.json").read_text())

    def test_table_failure_cannot_be_reported_as_success(self):
        with patch.object(Page, "find_tables", side_effect=RuntimeError("bad table")):
            d = self.parse()
        self.assertEqual(d["status"], "partial_failure")
        self.assertEqual(d["counts"]["table"], 0)
        self.assertTrue(any(i["code"] == "table_extraction_failed" for i in d["pages"][0]["issues"]))

    def test_html_source_cannot_close_script_or_inject_markup(self):
        simple_pdf(self.pdf, '</script><script>alert("x")</script>')
        self.parse()
        output = (self.root / "result/index.html").read_text()
        self.assertNotIn('</script><script>alert', output)
        self.assertIn("\\u003c/script\\u003e", output)
        self.assertIn("connect-src 'none'", output)

    def test_rotated_and_cropped_page_use_rendered_media_coordinates(self):
        for rotation in (0, 90, 180, 270):
            simple_pdf(self.pdf, rotation=rotation, crop=True)
            d = self.parse(f"r{rotation}")
            p = d["pages"][0]
            self.assertEqual(p["rotation"], rotation)
            self.assertEqual(p["status"], "parsed")
            self.assertAlmostEqual(p["pixel_size"][0] / p["pixel_size"][1], p["width"] / p["height"], places=2)
            for b in p["blocks"]:
                q = b["location"]["bbox"]
                self.assertLessEqual(q["x"] + q["width"], p["width"] + .001)
                self.assertLessEqual(q["y"] + q["height"], p["height"] + .001)
            # Text crop must contain dark text, not an unrelated white region.
            from src.source_locator import crop_pixels
            b = next(b for b in p["blocks"] if b["type"] == "paragraph")
            with Image.open(self.root / f"r{rotation}" / p["render"]) as im:
                crop = im.crop(crop_pixels(b["location"]["bbox"], (p["width"], p["height"]), im.size)).convert("L")
                self.assertLess(crop.getextrema()[0], 100)

    def test_locations_clip_edges_and_reject_nonfinite_or_empty(self):
        loc = page_region(2, (5, 15, 50, 70), (10, 20, 110, 220))
        self.assertEqual(loc["bbox"], {"x": 0.0, "y": 0.0, "width": 40.0, "height": 50.0})
        for box in [(math.nan, 0, 1, 1), (0, 0, 0, 1), (-20, 0, -10, 1)]:
            with self.assertRaises(ValueError):
                page_region(1, box, (0, 0, 100, 100))

    def test_outside_cropbox_is_explicitly_rejected(self):
        c = canvas.Canvas(str(self.pdf), pagesize=(600, 800))
        c.setCropBox((0, 0, 700, 900))
        c.drawString(70, 700, "Invalid geometry")
        c.save()
        with self.assertRaisesRegex(ParseRejected, "cropbox_outside_mediabox"):
            self.parse()

    def test_empty_merged_header_is_flagged_for_review(self):
        c = canvas.Canvas(str(self.pdf), pagesize=(600, 800))
        for y in [500, 550, 600, 650]:
            c.line(50, y, 450, y)
        for x in [50, 450]:
            c.line(x, 500, x, 650)
        c.line(250, 500, 250, 600)
        for x,y,text in [(60,570,'Header A'),(260,570,'Header B'),(60,520,'1'),(260,520,'2')]:
            c.drawString(x,y,text)
        c.save()
        d = self.parse()
        table = next(b['table'] for b in d['pages'][0]['blocks'] if b['type']=='table')
        self.assertIn('empty_merged_row', table['warnings'][0])
        self.assertEqual(table['status'], 'candidate_not_reviewed')
        self.assertTrue(any('empty_grid_row' in warning for warning in table['warnings']))


if __name__ == "__main__":
    unittest.main()
