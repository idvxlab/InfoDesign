"""PDF locations: physical pages (1-based), rotated MediaBox, points, top-left origin."""
import math


def page_region(page_number, bounds, page_bounds, kind="page_region"):
    if page_number < 1 or kind not in ("page_region", "image_region"):
        raise ValueError("invalid_location")
    if len(bounds) != 4 or not all(math.isfinite(float(v)) for v in (*bounds, *page_bounds)):
        raise ValueError("invalid_bounds")
    px0, py0, px1, py1 = map(float, page_bounds)
    x0, y0, x1, y1 = map(float, bounds)
    x0, y0 = max(px0, x0), max(py0, y0)
    x1, y1 = min(px1, x1), min(py1, y1)
    if x1 <= x0 or y1 <= y0:
        raise ValueError("empty_region")
    return {"kind": kind, "page": page_number, "bbox": {
        "x": round(x0 - px0, 6), "y": round(y0 - py0, 6),
        "width": round(x1 - x0, 6), "height": round(y1 - y0, 6)}}


def crop_pixels(bbox, page_size, image_size):
    sx, sy = image_size[0] / page_size[0], image_size[1] / page_size[1]
    return (max(0, math.floor(bbox["x"] * sx)),
            max(0, math.floor(bbox["y"] * sy)),
            min(image_size[0], math.ceil((bbox["x"] + bbox["width"]) * sx)),
            min(image_size[1], math.ceil((bbox["y"] + bbox["height"]) * sy)))
