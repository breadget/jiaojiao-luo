import sys

from PIL import Image


def main() -> int:
    if len(sys.argv) != 3:
        print("validator expects a path and pixel limit", file=sys.stderr)
        return 2

    path = sys.argv[1]
    maximum_pixels = int(sys.argv[2])
    Image.MAX_IMAGE_PIXELS = maximum_pixels

    try:
        with Image.open(path) as image:
            if image.format != "PNG":
                raise ValueError("artifact is not a PNG")
            width, height = image.size
            if width <= 0 or height <= 0 or width * height > maximum_pixels:
                raise ValueError("PNG dimensions exceed the allowed limit")
            image.verify()
        with Image.open(path) as image:
            image.load()
    except Exception as error:
        print(f"PNG validation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
