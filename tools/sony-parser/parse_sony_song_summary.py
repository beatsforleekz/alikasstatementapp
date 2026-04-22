#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import re
import sys
import zlib
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path


TEXT_RUN_RE = re.compile(
    r"/(TT\d+)\s+1\s+Tf|"
    r"(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+"
    r"(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Tm|"
    r"(\[(?:.|\n|\r)*?\]\s*TJ)|"
    r"(\((?:\\.|[^\\)])*\)\s*Tj)",
    re.S,
)
PAGE_CONTENT_RE = re.compile(
    r"(\d+) 0 obj\s*<< /Type /Page .*?/Contents (\d+) 0 R", re.S
)
OBJECT_RE = re.compile(rb"(?m)^(\d+) 0 obj\s*")
CMAP_RANGE_RE = re.compile(r"<([0-9A-Fa-f]+)><([0-9A-Fa-f]+)><([0-9A-Fa-f]+)>")
NUMERIC_RE = re.compile(r"^\(?-?[\d.]+,\d{2}\)?$")
TEMPO_RE = re.compile(r"^(?P<title>.+?)\s*\((?P<tempo_id>\d+)\)$")

OUTPUT_COLUMNS = [
    "song_title",
    "tempo_id",
    "synch",
    "digital_perf",
    "other",
    "digital_mech",
    "mech",
    "perf",
    "song_total",
]


@dataclass
class TextItem:
    y: float
    x: float
    text: str


class SonySongSummaryParser:
    def __init__(self, pdf_path: Path) -> None:
        self.pdf_path = pdf_path
        self.pdf_bytes = pdf_path.read_bytes()
        self.pdf_text = self.pdf_bytes.decode("latin1", errors="ignore")
        self.objects = self._parse_objects()
        self.font_maps = {
            "TT2": self._parse_cmap(117),
            "TT4": self._parse_cmap(120),
            "TT6": self._parse_cmap(123),
        }

    def parse(self) -> tuple[list[dict[str, str]], Decimal, Decimal, list[str]]:
        page_content_objects = [
            int(match.group(2))
            for match in PAGE_CONTENT_RE.finditer(self.pdf_text)
        ]

        rows: list[dict[str, Decimal | str]] = []
        warnings: list[str] = []
        pending_title_prefix: list[str] = []
        pending_row: dict[str, Decimal | str] | None = None
        sony_total: Decimal | None = None

        for page_number, content_object in enumerate(page_content_objects, start=1):
            items = self._extract_items(content_object)
            y_values = sorted({item.y for item in items}, reverse=True)

            for y in y_values:
                if not (-590 <= y <= -130):
                    continue

                cells = sorted(
                    (
                        (item.x, self._normalize_space(item.text))
                        for item in items
                        if item.y == y and self._normalize_space(item.text)
                    ),
                    key=lambda cell: cell[0],
                )
                if not cells:
                    continue

                first_cell = cells[0][1]
                if first_cell == "TOTALS":
                    totals = [
                        self._parse_amount(text)
                        for _, text in cells[1:]
                        if NUMERIC_RE.match(text)
                    ]
                    if len(totals) == 7:
                        sony_total = totals[-1]
                    else:
                        warnings.append(
                            f"Page {page_number} line {y}: unable to parse Sony totals row: {cells}"
                        )
                    continue

                if first_cell.startswith("*Totals above reflect"):
                    continue

                numeric_cells = [(x, text) for x, text in cells if NUMERIC_RE.match(text)]
                title_cells = [(x, text) for x, text in cells if not NUMERIC_RE.match(text)]
                title_text = self._normalize_space(" ".join(text for _, text in title_cells))

                if numeric_cells and len(numeric_cells) != 7:
                    warnings.append(
                        f"Page {page_number} line {y}: expected 7 numeric columns, found {len(numeric_cells)}: {cells}"
                    )
                    continue

                if not numeric_cells and title_text:
                    if pending_row is not None:
                        pending_row["title"] = self._normalize_space(
                            f"{pending_row['title']} {title_text}"
                        )
                        tempo_match = TEMPO_RE.match(str(pending_row["title"]))
                        if tempo_match:
                            pending_row["song_title"] = self._normalize_space(
                                tempo_match.group("title")
                            )
                            pending_row["tempo_id"] = tempo_match.group("tempo_id")
                            rows.append(pending_row)
                            pending_row = None
                    else:
                        pending_title_prefix.append(title_text)
                    continue

                if not numeric_cells:
                    continue

                full_title = self._normalize_space(
                    " ".join(pending_title_prefix + ([title_text] if title_text else []))
                )
                pending_title_prefix = []
                amounts = [self._parse_amount(text) for _, text in numeric_cells]

                row: dict[str, Decimal | str] = {
                    "title": full_title,
                    "mech": amounts[0],
                    "digital_mech": amounts[1],
                    "perf": amounts[2],
                    "digital_perf": amounts[3],
                    "synch": amounts[4],
                    "other": amounts[5],
                    "song_total": amounts[6],
                }

                tempo_match = TEMPO_RE.match(full_title)
                if tempo_match:
                    row["song_title"] = self._normalize_space(tempo_match.group("title"))
                    row["tempo_id"] = tempo_match.group("tempo_id")
                    rows.append(row)
                else:
                    pending_row = row

        if pending_title_prefix:
            warnings.append(f"Unconsumed title-only fragments: {pending_title_prefix}")
        if pending_row is not None:
            warnings.append(f"Incomplete row at end of file: {pending_row}")
        if sony_total is None:
            warnings.append("Sony totals row was not found.")
            sony_total = Decimal("0.00")

        export_rows = [
            {
                "song_title": str(row["song_title"]),
                "tempo_id": str(row["tempo_id"]),
                "synch": self._format_amount(row["synch"]),
                "digital_perf": self._format_amount(row["digital_perf"]),
                "other": self._format_amount(row["other"]),
                "digital_mech": self._format_amount(row["digital_mech"]),
                "mech": self._format_amount(row["mech"]),
                "perf": self._format_amount(row["perf"]),
                "song_total": self._format_amount(row["song_total"]),
            }
            for row in rows
        ]

        export_total = sum(
            (Decimal(row["song_total"]) for row in export_rows), Decimal("0.00")
        )
        return export_rows, sony_total, export_total, warnings

    def _parse_objects(self) -> dict[int, bytes]:
        objects: dict[int, bytes] = {}
        for match in OBJECT_RE.finditer(self.pdf_bytes):
            object_number = int(match.group(1))
            start = match.end()
            end = self.pdf_bytes.find(b"endobj", start)
            objects[object_number] = self.pdf_bytes[start:end]
        return objects

    def _get_stream(self, object_number: int) -> str:
        blob = self.objects[object_number]
        stream_match = re.search(rb"<<(.*?)>>\s*stream\r?\n", blob, re.S)
        if not stream_match:
            raise ValueError(f"Object {object_number} does not contain a stream.")
        stream_start = stream_match.end()
        stream_end = blob.find(b"endstream", stream_start)
        data = blob[stream_start:stream_end].rstrip(b"\r\n")
        if b"/FlateDecode" in stream_match.group(1):
            data = zlib.decompress(data)
        return data.decode("latin1")

    def _parse_cmap(self, object_number: int) -> dict[int, str]:
        cmap_text = self._get_stream(object_number)
        cmap: dict[int, str] = {}
        for start_hex, end_hex, unicode_hex in CMAP_RANGE_RE.findall(cmap_text):
            start_code = int(start_hex, 16)
            end_code = int(end_hex, 16)
            unicode_start = int(unicode_hex, 16)
            for offset, code in enumerate(range(start_code, end_code + 1)):
                cmap[code] = chr(unicode_start + offset)
        return cmap

    def _extract_items(self, content_object: int) -> list[TextItem]:
        content = self._get_stream(content_object)
        current_font: str | None = None
        current_tm: tuple[float, float, float, float, float, float] | None = None
        items: list[TextItem] = []

        for match in TEXT_RUN_RE.finditer(content):
            if match.group(1):
                current_font = match.group(1)
                continue

            if match.group(2):
                current_tm = tuple(float(match.group(i)) for i in range(2, 8))
                continue

            if current_font is None or current_tm is None:
                continue

            if match.group(8):
                parts = re.findall(r"\((?:\\.|[^\\)])*\)", match.group(8))
                text = "".join(
                    "".join(
                        self.font_maps[current_font].get(ord(char), "?")
                        for char in self._decode_pdf_literal(part)
                    )
                    for part in parts
                )
                items.append(TextItem(round(current_tm[5], 2), current_tm[4], text))
                continue

            if match.group(9):
                token = match.group(9)[:-3].strip()
                text = "".join(
                    self.font_maps[current_font].get(ord(char), "?")
                    for char in self._decode_pdf_literal(token)
                )
                items.append(TextItem(round(current_tm[5], 2), current_tm[4], text))

        return items

    def _decode_pdf_literal(self, token: str) -> str:
        output: list[str] = []
        index = 1
        while index < len(token) - 1:
            char = token[index]
            if char == "\\":
                index += 1
                if index >= len(token) - 1:
                    break
                escaped = token[index]
                if escaped in "nrtbf()\\":
                    output.append(
                        {
                            "n": "\n",
                            "r": "\r",
                            "t": "\t",
                            "b": "\b",
                            "f": "\f",
                            "(": "(",
                            ")": ")",
                            "\\": "\\",
                        }[escaped]
                    )
                elif escaped in "01234567":
                    octal = escaped
                    while (
                        index + 1 < len(token) - 1
                        and len(octal) < 3
                        and token[index + 1] in "01234567"
                    ):
                        index += 1
                        octal += token[index]
                    output.append(chr(int(octal, 8)))
                elif escaped in "\n\r":
                    pass
                else:
                    output.append(escaped)
            else:
                output.append(char)
            index += 1
        return "".join(output)

    @staticmethod
    def _normalize_space(value: str) -> str:
        return re.sub(r"\s+", " ", value).strip()

    @staticmethod
    def _parse_amount(value: str) -> Decimal:
        normalized = re.sub(r"\s+", "", value)
        is_negative = normalized.startswith("(") and normalized.endswith(")")
        if is_negative:
            normalized = normalized[1:-1]
        amount = Decimal(normalized.replace(".", "").replace(",", "."))
        return -amount if is_negative else amount

    @staticmethod
    def _format_amount(value: Decimal | str) -> str:
        return f"{Decimal(str(value)):.2f}"


def default_output_path(pdf_path: Path) -> Path:
    return pdf_path.with_name(f"{pdf_path.stem}_sales_import.csv")


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Convert a Sony Song Summary PDF into sales import CSV format."
    )
    parser.add_argument("pdf", type=Path, help="Path to the Sony Song Summary PDF")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Output CSV path. Defaults next to the PDF.",
    )
    return parser


def main() -> int:
    args = build_arg_parser().parse_args()
    pdf_path = args.pdf.expanduser().resolve()
    output_path = (args.output or default_output_path(pdf_path)).expanduser().resolve()

    parser = SonySongSummaryParser(pdf_path)
    rows, sony_total, export_total, warnings = parser.parse()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=OUTPUT_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)

    for warning in warnings:
        print(f"WARNING: {warning}", file=sys.stderr)

    difference = export_total - sony_total
    print(f"Output CSV: {output_path}")
    print(f"Exported song_total sum: {export_total:.2f}")
    print(f"Sony statement total: {sony_total:.2f}")
    print(
        f"Validation: {'MATCH' if difference == Decimal('0.00') else 'MISMATCH'}"
    )
    print(f"Difference: {difference:.2f}")

    return 0 if not warnings and difference == Decimal("0.00") else 1


if __name__ == "__main__":
    raise SystemExit(main())
