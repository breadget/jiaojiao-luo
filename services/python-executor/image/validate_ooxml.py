"""产物端的 DOCX / PPTX 校验。

先检查 OOXML ZIP 容器和关系文件，拒绝宏、嵌入对象、ActiveX 与外部链接，
再分别用 python-docx / python-pptx 完整打开文档。
"""

import sys
import zipfile
from xml.etree import ElementTree

from docx import Document
from pptx import Presentation


MAX_ENTRIES = 10_000
MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024


def validate_container(path: str, kind: str) -> None:
    required = "word/document.xml" if kind == "docx" else "ppt/presentation.xml"
    active_prefix = "word/" if kind == "docx" else "ppt/"
    total = 0
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if not entries or len(entries) > MAX_ENTRIES:
            raise ValueError("OOXML entry count is invalid")
        names = {entry.filename for entry in entries}
        if "[Content_Types].xml" not in names or required not in names:
            raise ValueError(f"OOXML package is missing {required}")

        for entry in entries:
            name = entry.filename
            parts = name.split("/")
            if name.startswith("/") or ".." in parts or "\\" in name:
                raise ValueError("OOXML package contains an unsafe entry name")
            total += entry.file_size
            if total > MAX_UNCOMPRESSED_BYTES:
                raise ValueError("OOXML package expands beyond the allowed limit")
            lowered = name.lower()
            if (
                lowered.endswith("vbaproject.bin")
                or lowered.startswith(f"{active_prefix}activex/")
                or lowered.startswith(f"{active_prefix}embeddings/")
            ):
                raise ValueError("active or embedded OOXML content is not allowed")

            if lowered.endswith(".rels"):
                root = ElementTree.fromstring(archive.read(entry))
                for relationship in root:
                    if relationship.attrib.get("TargetMode", "").lower() == "external":
                        raise ValueError("external OOXML relationships are not allowed")


def validate_document(path: str) -> None:
    document = Document(path)
    # 触发段落、表格与内联图形的解析，不只信包元数据。
    for paragraph in document.paragraphs:
        _ = paragraph.text
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                _ = cell.text
    for relationship in document.part.rels.values():
        if relationship.is_external:
            raise ValueError("external DOCX relationships are not allowed")


def validate_presentation(path: str) -> None:
    presentation = Presentation(path)
    if len(presentation.slides) < 1:
        raise ValueError("presentation has no slides")
    for slide in presentation.slides:
        for shape in slide.shapes:
            if hasattr(shape, "text"):
                _ = shape.text
        for relationship in slide.part.rels.values():
            if relationship.is_external:
                raise ValueError("external PPTX relationships are not allowed")


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[2] not in {"docx", "pptx"}:
        print("validator expects a path and docx|pptx", file=sys.stderr)
        return 2

    path, kind = sys.argv[1], sys.argv[2]
    try:
        validate_container(path, kind)
        if kind == "docx":
            validate_document(path)
        else:
            validate_presentation(path)
    except Exception as error:
        print(f"{kind.upper()} validation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
