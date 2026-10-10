"""Model-free PDF adapter. Regions are rendered crops, not decoded original images."""
from ..source_locator import page_region

TABLE_SETTINGS = {"vertical_strategy": "lines", "horizontal_strategy": "lines",
                  "snap_tolerance": 3, "join_tolerance": 3}


def extract_page(page):
    """Return candidates and separate technical failures. Never infer image semantics."""
    candidates, issues = [], []

    def add(kind, text, bounds, method, **extra):
        try:
            location = page_region(page.page_number, bounds, page.bbox,
                                   "image_region" if kind == "image" else "page_region")
            candidates.append({"type": kind, "text": text, "location": location,
                               "method": method, **extra})
        except ValueError:
            issues.append({"stage": kind, "status": "failed", "code": "invalid_region"})

    try:
        # Retain source text lines; do not pretend to have inferred paragraph reading order.
        for line in page.extract_text_lines(return_chars=False):
            add("paragraph", line["text"], (line["x0"], line["top"], line["x1"], line["bottom"]),
                "pdf_native_text_line")
    except Exception:
        issues.append({"stage": "text", "status": "failed", "code": "text_extraction_failed"})

    try:
        for index, obj in enumerate(page.images):
            add("image", "", (obj["x0"], obj["top"], obj["x1"], obj["bottom"]),
                "pdf_image_object_region", object_index=index, image_name=str(obj.get("name", "")),
                original_size=list(obj.get("srcsize", [])), is_mask=bool(obj.get("imagemask")))
    except Exception:
        issues.append({"stage": "image", "status": "failed", "code": "image_detection_failed"})

    try:
        for table in page.find_tables(TABLE_SETTINGS):
            rows = table.extract()
            # Conservative grid candidates only; empty decorative grids are not tables.
            if len(rows) < 2 or max(map(len, rows), default=0) < 2:
                continue
            if sum(bool(cell and cell.strip()) for row in rows for cell in row) < 4:
                continue
            cells = []
            for row_index, row in enumerate(table.rows):
                for col_index, bounds in enumerate(row.cells):
                    if bounds is not None:
                        cells.append({"row": row_index, "column": col_index,
                                      "text": rows[row_index][col_index],
                                      "location": page_region(page.page_number, bounds, page.bbox)})
            warnings = []
            if any(any(cell is None for cell in row) and not any(cell and cell.strip() for cell in row) for row in rows):
                warnings.append("empty_merged_row; header_text_alignment_requires_review")
            if any(not any(cell and cell.strip() for cell in row) for row in rows):
                warnings.append("empty_grid_row; possible_text_alignment_or_omitted_row")
            add("table", "\n".join("\t".join(c or "" for c in row) for row in rows),
                table.bbox, "pdf_vector_grid_candidate", rows=rows, cells=cells, warnings=warnings)
    except Exception:
        issues.append({"stage": "table", "status": "failed", "code": "table_extraction_failed"})
    candidates.sort(key=lambda b: (b["location"]["bbox"]["y"], b["location"]["bbox"]["x"], b["type"]))
    return candidates, issues
