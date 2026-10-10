"""Local PDF -> existing DocumentIR + private inspection artifacts; no Agent or service."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
from importlib.metadata import version

import pdfplumber

from .adapters.pdfplumber_adapter import extract_page, TABLE_SETTINGS
from .source_locator import crop_pixels, page_region
from .preview import write_preview

MAX_BYTES = 25 * 1024 * 1024
MAX_PAGES = 40
MAX_BLOCKS = 5000
MAX_PAGE_POINTS = 2400
MAX_CHARS_PER_PAGE = 50000
MAX_OBJECTS_PER_PAGE = 10000
PARSER_VERSION = "pdf-local-0.1.0"


class ParseRejected(ValueError):
    """Stable diagnostic code, without raw exception text or source contents."""


def fingerprint(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def parse_pdf(source, output, project_id="project_local_pdf", document_id=None,
              document_version_id=None, source_version=1):
    """Output must not exist. IDs are trusted caller context, never extracted from the PDF."""
    source, output = Path(source), Path(output)
    if not re.fullmatch(r"project_[a-z0-9][a-z0-9_]{0,120}", project_id):
        raise ParseRejected("invalid_project_id")
    if not source.is_file() or source.stat().st_size > MAX_BYTES:
        raise ParseRejected("source_missing_or_too_large")
    if output.exists():
        raise ParseRejected("output_already_exists")
    raw = source.read_bytes()
    if len(raw) > MAX_BYTES or not raw.startswith(b"%PDF-"):
        raise ParseRejected("invalid_pdf_or_size")
    digest = fingerprint(raw)
    document_id = document_id or "doc_" + digest[7:39]
    document_version_id = document_version_id or "docv_" + digest[7:39]
    if not re.fullmatch(r"doc_[a-z0-9][a-z0-9_]{0,120}", document_id):
        raise ParseRejected("invalid_document_id")
    if not re.fullmatch(r"[a-z][a-z0-9_]{1,127}", document_version_id) or source_version < 1:
        raise ParseRejected("invalid_version")
    try:
        pdf = pdfplumber.open(io.BytesIO(raw))
        if pdf.doc.encryption:
            pdf.close()
            raise ParseRejected("encrypted_pdf_unsupported")
        if not 1 <= len(pdf.pages) <= MAX_PAGES:
            pdf.close()
            raise ParseRejected("page_limit")
        for page in pdf.pages:
            if not (0 < page.width <= MAX_PAGE_POINTS and 0 < page.height <= MAX_PAGE_POINTS):
                pdf.close()
                raise ParseRejected("page_dimension_limit")
            # A conservative first adapter: non-default UserUnit requires explicit conversion.
            if float(page.page_obj.attrs.get("UserUnit", 1)) != 1:
                pdf.close()
                raise ParseRejected("pdf_user_unit_unsupported")
            if page.cropbox and (page.cropbox[0] < page.bbox[0] or page.cropbox[1] < page.bbox[1]
                                 or page.cropbox[2] > page.bbox[2] or page.cropbox[3] > page.bbox[3]):
                pdf.close()
                raise ParseRejected("cropbox_outside_mediabox")
    except ParseRejected:
        raise
    except Exception:
        raise ParseRejected("pdf_open_failed") from None

    old_umask = os.umask(0o077)
    try:
        output.mkdir(parents=True, exist_ok=False)
        (output / "pages").mkdir()
        (output / "assets").mkdir()
        (output / "tables").mkdir()
        (output / "source.pdf").write_bytes(raw)
        blocks, pages, unsupported = [], [], []
        dependencies = {name: version(name) for name in ("pdfplumber", "pdfminer.six", "pypdfium2", "Pillow")}
        manifest = {"format": "local_pdf_inspection_v1", "parser": PARSER_VERSION,
                    "source": {"name": source.name, "sha256": digest, "bytes": len(raw),
                               "file": "source.pdf", "page_count": len(pdf.pages)},
                    "dependencies": dependencies, "network": "no_network_required",
                    "coordinates": "physical_page_1_based; rotated_mediabox; top_left; points_1_72_inch",
                    "table_settings": TABLE_SETTINGS, "pages": pages,
                    "limitations": ["未运行 OCR；扫描图中的文字未识别。", "图片区为页面渲染裁剪，未解码原始图片文件、未作语义理解。",
                                    "仅检测矢量边框表格候选；无边框、栅格表格及图表数据未支持。",
                                    "原生文字按行提取，多栏阅读顺序、标题层级和跨页表格未推断；字体几何可能造成区域偏移与表格漏行。",
                                    "这份预览不是企业页面生成器；内容未进入 Pi、事实采纳或 B4 审查。"]}

        for page in pdf.pages:
            info = {"page": page.page_number, "width": page.width, "height": page.height,
                    "rotation": page.rotation, "mediabox": list(page.mediabox),
                    "cropbox": list(page.cropbox) if page.cropbox else None,
                    "status": "parsed", "issues": [], "blocks": [], "render": None}
            pages.append(info)
            raster = None
            try:
                raster = page.to_image(resolution=96, antialias=True, force_mediabox=True).original
                relative = f"pages/page-{page.page_number:03}.png"
                raster.save(output / relative)
                info["render"] = relative
                info["render_sha256"] = fingerprint((output / relative).read_bytes())
                info["pixel_size"] = list(raster.size)
            except Exception:
                info["issues"].append({"stage": "render", "status": "failed", "code": "page_render_failed"})
            try:
                if len(page.chars) > MAX_CHARS_PER_PAGE or sum(len(v) for v in page.objects.values()) > MAX_OBJECTS_PER_PAGE:
                    candidates = []
                    info["issues"].append({"stage": "page", "status": "failed", "code": "page_object_limit"})
                else:
                    candidates, issues = extract_page(page)
                    info["issues"].extend(issues)
            except Exception:
                candidates = []
                info["issues"].append({"stage": "page", "status": "failed", "code": "page_extraction_failed"})
            if not candidates:
                candidates = [{"type": "other", "text": "", "location": page_region(page.page_number, page.bbox, page.bbox),
                               "method": "page_without_extracted_blocks"}]
            if len(blocks) + len(candidates) > MAX_BLOCKS:
                raise ParseRejected("block_limit")
            for candidate in candidates:
                block_id = f"b{len(blocks):03}"
                block = {"blockId": block_id, "index": len(blocks), "type": candidate["type"],
                         "text": candidate["text"], "location": candidate["location"],
                         "extensions": {"extraction_method": candidate["method"], "parser_version": PARSER_VERSION}}
                item = {**block, "status": "parsed", "asset": None}
                reason = None
                if block["type"] == "image":
                    reason = "image_region_only; OCR and image semantics not run"
                    item["status"] = "extracted_not_understood"
                    item["image_object"] = {k: candidate[k] for k in ("object_index", "image_name", "original_size", "is_mask")}
                if block["type"] == "other":
                    reason = "no_extractable_blocks; blank, vector-only or unsupported page; OCR not run"
                    item["status"] = "unsupported"
                if block["type"] in ("image", "table"):
                    if raster is not None:
                        asset = f"assets/{block_id}.png"
                        raster.crop(crop_pixels(block["location"]["bbox"], (page.width, page.height), raster.size)).save(output / asset)
                        item["asset"] = asset
                        block["extensions"].update({"asset_path": asset, "asset_hash": fingerprint((output / asset).read_bytes()),
                                                   "asset_kind": "rendered_page_region"})
                    else:
                        item["status"] = "failed"
                        reason = "region_render_failed"
                if block["type"] == "table":
                    table = {"block_id": block_id, "source_hash": digest, "location": block["location"],
                             "status": "candidate_not_reviewed", "rows": candidate["rows"], "cells": candidate["cells"],
                             "warnings": candidate["warnings"]}
                    if candidate["warnings"]:
                        reason = "; ".join(candidate["warnings"])
                    relative = f"tables/{block_id}.json"
                    write_json(output / relative, table)
                    block["extensions"].update({"table_data_path": relative, "table_data_hash": fingerprint((output / relative).read_bytes()),
                                               "table_status": "candidate_not_reviewed"})
                    item["table"] = table
                    if item["status"] != "failed":
                        item["status"] = "candidate_not_reviewed"
                if reason:
                    unsupported.append({"blockId": block_id, "reason": reason})
                blocks.append(block)
                info["blocks"].append(item)
            if info["issues"]:
                info["status"] = "partial_failure"
                unsupported.append({"blockId": info["blocks"][0]["blockId"],
                                    "reason": "; ".join(i["code"] for i in info["issues"])})
            info["counts"] = {kind: sum(b["type"] == kind for b in info["blocks"]) for kind in ("paragraph", "image", "table", "other")}
            info["table_status"] = "failed" if any(i["stage"] == "table" for i in info["issues"]) else ("candidates_found" if info["counts"]["table"] else "no_vector_grid_candidate")
            info["text_status"] = "native_text_extracted" if info["counts"]["paragraph"] else "no_native_text; OCR_not_run"
            page.close()

        ir = {"protocolVersion": "1.0", "documentId": document_id, "documentVersionId": document_version_id,
              "projectId": project_id, "version": source_version, "contentHash": digest,
              "mimeType": "application/pdf", "sourceName": source.name, "blocks": blocks,
              "parseInfo": {"parser": PARSER_VERSION, "quality": "partial", "unsupported": unsupported},
              "extensions": {"coordinate_system": manifest["coordinates"], "inspection_manifest": "manifest.json"}}
        manifest["document_ir"] = "document-ir.json"
        manifest["counts"] = {kind: sum(p["counts"][kind] for p in pages) for kind in ("paragraph", "image", "table", "other")}
        manifest["status"] = "partial_failure" if any(p["issues"] for p in pages) else "parsed_with_limitations"
        write_json(output / "document-ir.json", ir)
        write_json(output / "manifest.json", manifest)
        write_preview(output / "index.html", manifest)
        return manifest
    except Exception:
        if output.is_dir():
            write_json(output / "failure.json", {"status": "failed", "code": "parse_incomplete", "usable_document_ir": False})
        raise
    finally:
        pdf.close()
        os.umask(old_umask)


def main():
    parser = argparse.ArgumentParser(description="Offline PDF inspection preview; output folder must be new")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--project-id", default="project_local_pdf")
    parser.add_argument("--document-id")
    parser.add_argument("--document-version-id")
    parser.add_argument("--source-version", type=int, default=1)
    args = parser.parse_args()
    try:
        result = parse_pdf(args.source, args.output, args.project_id, args.document_id, args.document_version_id, args.source_version)
        print(json.dumps({"status": result["status"], "pages": len(result["pages"]), "counts": result["counts"]}))
        return 2 if result["status"] == "partial_failure" else 0
    except ParseRejected as error:
        print(json.dumps({"status": "rejected", "code": str(error)}))
        return 2
    except Exception:
        print(json.dumps({"status": "failed", "code": "parse_incomplete"}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
