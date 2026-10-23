"""产物端的 PDF 校验：在第二个一次性容器里用 pypdf 完整解析。

只接收静态、未加密的页面文档。拒绝 JavaScript、自动动作、外部链接、
附件与交互表单，避免把沙箱生成的主动内容直接交给用户。
"""

import math
import sys

from pypdf import PdfReader
from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject, NameObject


FORBIDDEN_KEYS = {
    "/AA",
    "/AcroForm",
    "/EmbeddedFile",
    "/EmbeddedFiles",
    "/EF",
    "/JS",
    "/JavaScript",
    "/Launch",
    "/OpenAction",
    "/RichMedia",
    "/URI",
    "/XFA",
}
FORBIDDEN_NAMES = {
    "/GoToR",
    "/ImportData",
    "/JavaScript",
    "/Launch",
    "/Movie",
    "/RichMedia",
    "/Sound",
    "/SubmitForm",
}
MAX_PAGES = 500
MAX_OBJECTS = 50_000
MAX_DEPTH = 64


def validate_object(value, seen_indirect, seen_containers, counter, depth=0):
    if depth > MAX_DEPTH:
        raise ValueError("PDF object graph is too deep")
    counter[0] += 1
    if counter[0] > MAX_OBJECTS:
        raise ValueError("PDF object graph is too large")

    if isinstance(value, IndirectObject):
        marker = (value.idnum, value.generation)
        if marker in seen_indirect:
            return
        seen_indirect.add(marker)
        validate_object(
            value.get_object(), seen_indirect, seen_containers, counter, depth + 1
        )
        return

    if isinstance(value, NameObject) and str(value) in FORBIDDEN_NAMES:
        raise ValueError(f"active PDF action is not allowed: {value}")

    if isinstance(value, (DictionaryObject, ArrayObject)):
        marker = id(value)
        if marker in seen_containers:
            return
        seen_containers.add(marker)

    if isinstance(value, DictionaryObject):
        for key, child in value.items():
            if str(key) in FORBIDDEN_KEYS:
                raise ValueError(f"active PDF key is not allowed: {key}")
            validate_object(
                child, seen_indirect, seen_containers, counter, depth + 1
            )
    elif isinstance(value, ArrayObject):
        for child in value:
            validate_object(
                child, seen_indirect, seen_containers, counter, depth + 1
            )


def main() -> int:
    if len(sys.argv) != 2:
        print("validator expects a path", file=sys.stderr)
        return 2

    try:
        reader = PdfReader(sys.argv[1], strict=True)
        if reader.is_encrypted:
            raise ValueError("encrypted PDFs are not allowed")
        page_count = len(reader.pages)
        if page_count < 1 or page_count > MAX_PAGES:
            raise ValueError(f"PDF page count is outside 1..{MAX_PAGES}")

        for page in reader.pages:
            width = float(page.mediabox.width)
            height = float(page.mediabox.height)
            if (
                not math.isfinite(width)
                or not math.isfinite(height)
                or width <= 0
                or height <= 0
                or width > 20_000
                or height > 20_000
            ):
                raise ValueError("PDF page dimensions are invalid")

        validate_object(reader.trailer, set(), set(), [0])
    except Exception as error:
        print(f"PDF validation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
