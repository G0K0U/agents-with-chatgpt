"""Export Quanta's transparent PNG master to Windows PNG/ICO sizes.

The editable artwork is assets/quanta.svg; assets/icon.png is its 1024px
raster export. This script sizes and packages that checked-in master.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
SIZES = (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)


def main():
    with Image.open(ASSETS / "icon.png") as source:
        master = source.convert("RGBA")
    if master.width != master.height or master.getpixel((0, 0))[3] != 0:
        raise ValueError("Quanta master must be square with transparent corners")
    (ASSETS / "png").mkdir(exist_ok=True)
    frames = {}
    for size in SIZES:
        frame = master.resize((size, size), Image.Resampling.LANCZOS)
        for corner in ((0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1)):
            frame.putpixel(corner, (0, 0, 0, 0))
        frame.save(ASSETS / "png" / f"icon-{size}.png")
        frames[size] = frame
    frames[256].save(ASSETS / "icon.ico", format="ICO",
                     append_images=[frames[s] for s in SIZES if s != 256],
                     sizes=[(s, s) for s in SIZES])
    # A new path prevents Explorer reusing the old shortcut icon cache.
    (ASSETS / "quanta.ico").write_bytes((ASSETS / "icon.ico").read_bytes())
    with Image.open(ASSETS / "icon.ico") as ico:
        if ico.ico.sizes() != {(s, s) for s in SIZES}:
            raise ValueError("ICO is missing an exported size")
    print(f"Quanta: {len(SIZES)} PNG sizes and validated multi-resolution ICO")


if __name__ == "__main__":
    main()
