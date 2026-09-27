"""Mac Dock artwork: center the existing logo with transparent optical margins."""
from functools import lru_cache
from io import BytesIO
from PIL import Image
from .brand import ASSETS

DOCK_ARTWORK_SCALE = 0.80


@lru_cache(maxsize=1)
def png_data():
    # Share one rendering between the app bundle and its runtime Dock icon.
    # Keep the original branding asset unchanged for Windows and panel content.
    with Image.open(ASSETS / 'icon.png') as source:
        canvas = Image.new('RGBA', source.size, (0, 0, 0, 0))
        size = tuple(round(side * DOCK_ARTWORK_SCALE) for side in source.size)
        artwork = source.convert('RGBA').resize(size, Image.Resampling.LANCZOS)
        origin = tuple((outer - inner) // 2 for outer, inner in zip(canvas.size, size))
        canvas.alpha_composite(artwork, origin)
        output = BytesIO()
        canvas.save(output, format='PNG')
        return output.getvalue()


@lru_cache(maxsize=1)
def application_icon():
    from AppKit import NSImage
    from Foundation import NSData
    data = png_data()
    return NSImage.alloc().initWithData_(NSData.dataWithBytes_length_(data, len(data)))
