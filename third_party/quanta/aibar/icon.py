"""Quanta tray branding with the existing quota colour and activity badge."""
from functools import lru_cache
from PIL import Image, ImageDraw
from .brand import ASSETS
from .codex_windows import usable_windows

GREEN, AMBER, RED, GRAY = (46, 160, 67), (210, 153, 34), (218, 54, 51), (110, 118, 129)
BLUE = (45, 126, 210)
PURPLE = (163, 113, 247)  # token 消耗（计数制）专用：与面板趋势单位色一致


def per_source_remaining(view: dict) -> list[tuple[str, float]]:
    """(来源, 剩余%) for every subscription quota we can see.

    DeepSeek is pay-as-you-go money (not a recovering window), so it only
    lives in the menu, not in the light's color.
    """
    from .presentation import trusted_view
    view = trusted_view(view)
    vals: list[tuple[str, float]] = []
    for a in view.get("codex", {}).get("accounts", []):
        if a.get("is_current") and a.get("attribution_verified") and not a.get("stale", True):
            for window in usable_windows(a):
                vals.append((f"Codex {window['label']}", window["remaining"]))
    for key, label in (("glm", "GLM"), ("antigravity", "AGY")):
        provider = view.get(key) or {}
        if provider.get("error") or provider.get("stale", True):
            continue
        for win in provider.get("windows") or []:
            if win.get("percent") is not None:
                vals.append((f"{label} {win.get('label', '?')}", max(0, min(100, 100 - win["percent"]))))
    return vals


def overall_remaining(view: dict) -> float | None:
    """The light shows the most urgent source: the minimum remaining."""
    vals = per_source_remaining(view)
    return min((r for _, r in vals), default=None)


def color_for(remaining: float) -> tuple:
    if remaining > 50:
        return GREEN
    if remaining > 20:
        return AMBER
    return RED


@lru_cache(maxsize=1)
def _brand_icon() -> Image.Image:
    with Image.open(ASSETS / "icon.png") as source:
        return source.convert("RGBA")


def render_icon(remaining: float | None, muse_count: int | None = None, size: int = 64) -> Image.Image:
    img = _brand_icon().resize((size, size), Image.Resampling.LANCZOS)
    draw = ImageDraw.Draw(img)
    color = GRAY if remaining is None else color_for(remaining)
    border = max(1, size // 32)
    if muse_count is not None:
        # Local user messages in the last five hours; this is activity,
        # not an official quota or billing measurement.
        text = str(muse_count)
        try:
            from PIL import ImageFont
            font = ImageFont.truetype("arial.ttf", max(8, int(size * 0.32)))
        except OSError:
            font = ImageFont.load_default()
        bbox = draw.textbbox((0, 0), text, font=font)
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        box_w = min(size, max(int(size * .4), w + int(size * .14)))
        box_h = max(int(size * .42), h + 2 * border)
        left, top = size - box_w, size - box_h
        draw.rounded_rectangle((left, top, size - 1, size - 1),
                               radius=box_h // 2, fill=color + (255,),
                               outline=(10, 23, 51, 255), width=border)
        draw.text((left + (box_w - w) / 2 - bbox[0], top + (box_h - h) / 2 - bbox[1]), text,
                  fill=(255, 255, 255, 255), font=font,
                  stroke_width=0)
    else:
        badge = max(5, int(size * .32))
        draw.ellipse((size - badge, size - badge, size - 1, size - 1),
                     fill=color + (255,), outline=(10, 23, 51, 255), width=border)
    return img
