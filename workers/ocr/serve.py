import argparse
import hmac
import io
import json
import os
import re
import sys
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, HTTPServer


VERSION = "docling-2.151.1-layout-v1"
MAX_BYTES = 2 * 1024 * 1024
MAX_PAGES = 30


def block_outbound_sockets(event, _arguments):
    if event in ("socket.connect", "socket.getaddrinfo", "socket.gethostbyaddr"):
        raise PermissionError("OCR worker does not make outbound connections")


def normalized_text(value):
    return " ".join(value.replace("\x00", " ").split())


def source_box(bbox, number, document):
    if bbox is None or number not in document.pages:
        return None
    size = document.pages[number].size
    bounds = bbox.to_top_left_origin(size.height)
    if size.width <= 0 or size.height <= 0:
        return None

    def coordinate(value, extent):
        return round(max(0, min(value / extent, 1)), 6)

    box = {
        "page": number,
        "left": coordinate(bounds.l, size.width),
        "top": coordinate(bounds.t, size.height),
        "right": coordinate(bounds.r, size.width),
        "bottom": coordinate(bounds.b, size.height),
    }
    return box if box["left"] < box["right"] and box["top"] < box["bottom"] else None


def table_rows(item, table_number, document):
    pages = {source.page_no for source in item.prov}
    if len(pages) != 1:
        return
    number = next(iter(pages))
    rows = defaultdict(list)
    for cell in item.data.table_cells:
        box = source_box(cell.bbox, number, document)
        if box:
            rows[cell.start_row_offset_idx].append(({
                "column": cell.start_col_offset_idx + 1,
                "text": normalized_text(cell.text),
                "box": box,
            }, cell.column_header))
    for row, pairs in sorted(rows.items()):
        ordered = sorted(pairs, key=lambda pair: pair[0]["column"])
        cells = [cell for cell, _ in ordered]
        if not any(cell["text"] for cell in cells):
            continue
        yield number, {
            "text": " | ".join(cell["text"] for cell in cells),
            "boxes": [cell["box"] for cell in cells],
            "table": {
                "id": f"ocr-t{table_number}",
                "row": row + 1,
                "header": any(header for _, header in ordered),
                "cells": cells,
            },
        }


def extract_layout(document):
    from docling_core.types.doc import TableItem, TextItem

    if not 1 <= len(document.pages) <= MAX_PAGES:
        raise ValueError("Unexpected page count")
    pages = [[] for _ in document.pages]
    table_number = 0
    for item, _ in document.iterate_items():
        if isinstance(item, TableItem):
            table_number += 1
            for number, row in table_rows(item, table_number, document):
                pages[number - 1].append(row)
        elif isinstance(item, TextItem):
            for source in item.prov:
                box = source_box(source.bbox, source.page_no, document)
                start, end = source.charspan
                text = normalized_text(item.text[start:end])
                if box and text:
                    pages[source.page_no - 1].append({"text": text, "boxes": [box]})
    return {"version": VERSION, "pages": pages}


def make_converter():
    from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions(
        do_ocr=True,
        do_table_structure=True,
        enable_remote_services=False,
        document_timeout=9,
        accelerator_options=AcceleratorOptions(num_threads=2, device=AcceleratorDevice.CPU),
        ocr_options=RapidOcrOptions(lang=["en"], force_full_page_ocr=True, model_size="tiny"),
    )
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
    converter.initialize_pipeline(InputFormat.PDF)
    return converter


def convert(converter, pdf):
    from docling.datamodel.base_models import ConversionStatus
    from docling_core.types.io import DocumentStream

    result = converter.convert(
        DocumentStream(name="policy.pdf", stream=io.BytesIO(pdf)),
        max_num_pages=MAX_PAGES,
        max_file_size=MAX_BYTES,
    )
    if result.status != ConversionStatus.SUCCESS:
        raise ValueError("Incomplete OCR")
    return result.document


def warm(converter):
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (600, 400), "white")
    ImageDraw.Draw(image).text((40, 40), "Synthetic OCR warmup", fill="black", font_size=36)
    stream = io.BytesIO()
    image.save(stream, format="PDF")
    convert(converter, stream.getvalue())


class LocalOcrServer(HTTPServer):
    request_queue_size = 2

    def server_bind(self):
        # Avoid the base HTTPServer's hostname lookup in offline mode.
        self.socket.bind(self.server_address)
        self.server_address = self.socket.getsockname()
        self.server_name, self.server_port = self.server_address


class OcrHandler(BaseHTTPRequestHandler):
    timeout = 3

    def log_message(self, _format, *_args):
        pass

    def reply(self, status, value):
        output = json.dumps(value, ensure_ascii=False).encode("utf-8")
        if len(output) > MAX_BYTES:
            status, output = 422, b'{"error":"layout_too_large"}'
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(output)))
        self.end_headers()
        try:
            self.wfile.write(output)
        except OSError:
            pass  # The app may have reached its deadline.

    def do_POST(self):
        if self.path != "/parse":
            return self.reply(404, {"error": "not_found"})
        if not hmac.compare_digest(
            self.headers.get("Authorization", "").encode("latin-1"), self.server.authorization
        ):
            return self.reply(401, {"error": "authentication_required"})
        if self.headers.get("Content-Type") != "application/pdf":
            return self.reply(415, {"error": "pdf_required"})
        size = self.headers.get("Content-Length", "")
        if not re.fullmatch(r"[0-9]{1,7}", size) or not 5 <= int(size) <= MAX_BYTES:
            return self.reply(413, {"error": "invalid_pdf_size"})
        try:
            pdf = self.rfile.read(int(size))
            if len(pdf) != int(size) or not pdf.startswith(b"%PDF-"):
                return self.reply(422, {"error": "invalid_pdf"})
            parsed = extract_layout(convert(self.server.converter, pdf))
        except Exception:
            return self.reply(422, {"error": "ocr_failed"})
        self.reply(200, parsed)


def main():
    parser = argparse.ArgumentParser(description="Readily same-host OCR worker")
    parser.add_argument("--prepare-models", action="store_true")
    args = parser.parse_args()
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    if args.prepare_models:
        warm(make_converter())
        print("OCR models prepared", flush=True)
        return

    port = os.getenv("READILY_V1_OCR_PORT", "")
    token = os.getenv("READILY_V1_OCR_TOKEN", "")
    if not re.fullmatch(r"[0-9]{1,5}", port) or not 1 <= int(port) <= 65535:
        parser.error("Set READILY_V1_OCR_PORT to a valid port")
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token):
        parser.error("Set READILY_V1_OCR_TOKEN to a separate random token")
    os.environ["HF_HUB_OFFLINE"] = "1"
    sys.addaudithook(block_outbound_sockets)
    converter = make_converter()
    warm(converter)
    with LocalOcrServer(("127.0.0.1", int(port)), OcrHandler) as server:
        server.converter = converter
        server.authorization = f"Bearer {token}".encode("ascii")
        print("OCR worker ready", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
