"""Create a dependency-free, text-first PDF version of the project guide."""
from __future__ import annotations

import html
import re
from pathlib import Path

ROOT = Path(__file__).parent
SOURCE = ROOT / "Quantum_Resistant_Blockchain_Project_Guide.html"
TARGET = ROOT / "Quantum_Resistant_Blockchain_Project_Guide.pdf"


def text_lines(source: str) -> list[tuple[str, str]]:
    source = re.sub(r"<style.*?</style>", "", source, flags=re.S | re.I)
    source = re.sub(r"<script.*?</script>", "", source, flags=re.S | re.I)
    source = re.sub(r"<h1[^>]*>(.*?)</h1>", r"\n# \1\n", source, flags=re.S | re.I)
    source = re.sub(r"<h2[^>]*>(.*?)</h2>", r"\n## \1\n", source, flags=re.S | re.I)
    source = re.sub(r"<h3[^>]*>(.*?)</h3>", r"\n### \1\n", source, flags=re.S | re.I)
    source = re.sub(r"<li[^>]*>(.*?)</li>", r"\n- \1", source, flags=re.S | re.I)
    source = re.sub(r"<tr[^>]*>(.*?)</tr>", r"\n\1", source, flags=re.S | re.I)
    source = re.sub(r"</?(p|div|section|table|ul|ol|pre)[^>]*>", "\n", source, flags=re.I)
    source = re.sub(r"</?(td|th)[^>]*>", " | ", source, flags=re.I)
    source = re.sub(r"<[^>]+>", "", source)
    source = html.unescape(source).replace("—", "-").replace("→", "->").replace("…", "...")
    source = source.encode("latin-1", "replace").decode("latin-1")
    output: list[tuple[str, str]] = []
    for raw in source.splitlines():
        line = " ".join(raw.split())
        if not line:
            continue
        style = "body"
        if line.startswith("### "):
            style, line = "h3", line[4:]
        elif line.startswith("## "):
            style, line = "h2", line[3:]
        elif line.startswith("# "):
            style, line = "h1", line[2:]
        width = 78 if style == "body" else 72
        words, current = line.split(), ""
        for word in words:
            candidate = f"{current} {word}".strip()
            if current and len(candidate) > width:
                output.append((style, current))
                current = word
            else:
                current = candidate
        if current:
            output.append((style, current))
    return output


def esc(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def build_pdf(lines: list[tuple[str, str]]) -> bytes:
    page_height, margin_top, margin_bottom = 842, 58, 52
    line_height = 14
    max_lines = (page_height - margin_top - margin_bottom) // line_height
    pages = [lines[i:i + max_lines] for i in range(0, len(lines), max_lines)]
    objects: list[bytes] = []
    # 1 catalog; 2 pages; 3 regular font; 4 bold font
    objects.extend([b"<< /Type /Catalog /Pages 2 0 R >>", b"", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"])
    page_refs = []
    for page_no, page in enumerate(pages, 1):
        commands = ["BT", "/F1 9 Tf", "45 812 Td", "(Quantum-Resistant Blockchain Security Model - Project Guide) Tj", "ET"]
        y = 784
        for style, line in page:
            font, size = ("F1", 9)
            if style == "h1": font, size = "F2", 18
            elif style == "h2": font, size = "F2", 13
            elif style == "h3": font, size = "F2", 10
            commands += ["BT", f"/{font} {size} Tf", f"45 {y} Td", f"({esc(line)}) Tj", "ET"]
            y -= line_height
        commands += ["BT", "/F1 8 Tf", f"500 28 Td", f"(Page {page_no} of {len(pages)}) Tj", "ET"]
        data = "\n".join(commands).encode("latin-1")
        content_id = len(objects) + 2
        page_id = len(objects) + 1
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {content_id} 0 R >>".encode())
        objects.append(b"<< /Length " + str(len(data)).encode() + b" >>\nstream\n" + data + b"\nendstream")
        page_refs.append(f"{page_id} 0 R")
    objects[1] = ("<< /Type /Pages /Kids [" + " ".join(page_refs) + f"] /Count {len(pages)} >>").encode()
    result = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(result))
        result += f"{index} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(result)
    result += f"xref\n0 {len(objects)+1}\n0000000000 65535 f \n".encode()
    result += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:])
    result += f"trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(result)


if __name__ == "__main__":
    TARGET.write_bytes(build_pdf(text_lines(SOURCE.read_text(encoding="utf-8"))))
    print(f"Wrote {TARGET}")
