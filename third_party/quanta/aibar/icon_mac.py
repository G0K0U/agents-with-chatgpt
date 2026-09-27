"""Native template logo and a separately coloured, click-through quota dot."""
import objc
from AppKit import NSBezierPath, NSColor, NSImageOnly, NSScreen, NSView
from Foundation import NSUserDefaults

from .icon import GRAY, color_for

STATUS_NAME = "QuantaMenuBar"
STATUS_WIDTH = 30.0
IMAGE_SIZE = 16.0
DOT_DIAMETER = 4.2
# Match the badge clearance in assets/quanta-menubar.svg.
DOT_FRACTION = 675.0 / 780.0


def prepare_status_position():
    """Keep valid right-side placement; reset missing or obscured placement."""
    defaults = NSUserDefaults.standardUserDefaults()
    key = "NSStatusItem Preferred Position " + STATUS_NAME
    screen = NSScreen.mainScreen()
    safe_width = screen.frame().size.width if screen else 645.0
    if screen and screen.respondsToSelector_("auxiliaryTopRightArea"):
        right = screen.auxiliaryTopRightArea()
        if right.size.width > 0:
            safe_width = right.size.width
    try:
        saved = float(defaults.objectForKey_(key))
    except (TypeError, ValueError):
        saved = -1.0
    if not STATUS_WIDTH <= saved <= safe_width - STATUS_WIDTH:
        # macOS autosaves distance from the right edge. Only our own key changes.
        defaults.setDouble_forKey_(min(250.0, safe_width / 2), key)


class UsageDotView(NSView):
    @objc.python_method
    def set_remaining(self, remaining):
        self._rgb = GRAY if remaining is None else color_for(remaining)
        self.setNeedsDisplay_(True)

    def drawRect_(self, rect):
        rgb = getattr(self, "_rgb", GRAY)
        NSColor.colorWithSRGBRed_green_blue_alpha_(
            rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1.0
        ).setFill()
        NSBezierPath.bezierPathWithOvalInRect_(self.bounds()).fill()

    def hitTest_(self, point):
        # A click anywhere on the badge must still open the status item's menu.
        return None


def install_status_icon(status_item):
    status_item.setAutosaveName_(STATUS_NAME)
    status_item.setLength_(STATUS_WIDTH)
    button = status_item.button()
    button.image().setSize_((IMAGE_SIZE, IMAGE_SIZE))
    button.setImagePosition_(NSImageOnly)
    button.setTitle_("")
    button.setAccessibilityLabel_("Quanta")
    bounds = button.bounds()
    center_x = bounds.size.width / 2 + IMAGE_SIZE * (DOT_FRACTION - .5)
    offset_y = IMAGE_SIZE * (DOT_FRACTION - .5)
    center_y = bounds.size.height / 2 + (-offset_y if button.isFlipped() else offset_y)
    badge = UsageDotView.alloc().initWithFrame_(
        ((center_x - DOT_DIAMETER / 2, center_y - DOT_DIAMETER / 2),
         (DOT_DIAMETER, DOT_DIAMETER))
    )
    badge.setAccessibilityElement_(False)
    badge.set_remaining(None)
    button.addSubview_(badge)
    return badge
