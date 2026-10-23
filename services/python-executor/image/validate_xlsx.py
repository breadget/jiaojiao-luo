"""产物端的 XLSX 校验：在第二个一次性容器里用 openpyxl 完整解析。

沙箱里的代码是不可信的，所以产物不能只靠魔数或扩展名判断；这里要求文件能被
openpyxl 打开、能枚举工作表、且不包含宏部件。
"""

import sys
import zipfile

import openpyxl


def main() -> int:
    if len(sys.argv) != 2:
        print("validator expects a path", file=sys.stderr)
        return 2

    path = sys.argv[1]
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            if "[Content_Types].xml" not in names:
                raise ValueError("artifact is not an OOXML package")
            if any(name.endswith("vbaProject.bin") for name in names):
                raise ValueError("macro-enabled workbooks are not allowed")
            if any(name.startswith("/") or ".." in name.split("/") for name in names):
                raise ValueError("archive contains unsafe entry names")

        workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
        try:
            sheet_count = 0
            for sheet in workbook.worksheets:
                sheet_count += 1
                # 触发行迭代，确保工作表真的能解析，而不是只有元数据。
                for _ in sheet.iter_rows():
                    break
            if sheet_count == 0:
                raise ValueError("workbook has no worksheets")
        finally:
            workbook.close()
    except Exception as error:
        print(f"XLSX validation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
