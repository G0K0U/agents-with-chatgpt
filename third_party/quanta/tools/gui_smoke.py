"""Real GUI self-checks using synthetic data, isolated by AIBAR_DATA_DIR."""
import os
from aibar.common import DATA_DIR, now_utc, write_json
from aibar.i18n import tr


def _require_isolation():
    if not os.environ.get("AIBAR_DATA_DIR"):
        raise RuntimeError("GUI checks require an isolated AIBAR_DATA_DIR")
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def flyout_test():
    _require_isolation()
    import customtkinter as ctk
    from aibar.flyout import QuantaFlyout, _ACTIONS
    calls, errors, focus_checks = [], [], []
    cards = [dict(dot=(63, 185, 80), name=name, headline="测试数据",
                  bars=[("5h", 75), ("周", 35)], detail="仅用于界面验收")
             for name in ("Codex", "GLM", "DeepSeek", "Muse", "Antigravity")]
    # Exercise the exact weekly-only shape reported by upgraded accounts.
    from aibar.presentation import compact_cards as build_flyout_cards
    codex_view = {"codex": {"accounts": [{"label": "fixture", "is_current": True,
        "plan_type": "prolite", "attribution_verified": True, "stale": False,
        "primary_window_minutes": 10080, "effective_primary_used_percent": 37}]}}
    cards[0] = build_flyout_cards(codex_view)[0]

    def children(widget):
        for child in widget.winfo_children():
            yield child
            yield from children(child)

    def check():
        try:
            root = probe._root
            root.update_idletasks()
            assert probe.visible and root.winfo_viewable(), "flyout never became visible"
            assert cards[0]["bars"] == [(tr("周"), 63)], "weekly quota mislabeled as five hours"
            assert "Pro (prolite)" in cards[0]["name"], "plan not displayed"
            buttons = [w for w in children(root) if isinstance(w, ctk.CTkButton)]
            assert len(buttons) == len(_ACTIONS), "missing action buttons"
            left, top = root.winfo_rootx(), root.winfo_rooty()
            for button in buttons:
                assert button.winfo_ismapped(), "unmapped action"
                assert button.winfo_rootx() >= left, "action clipped on left"
                assert button.winfo_rootx() + button.winfo_width() <= left + root.winfo_width(), "action clipped on right"
                assert button.winfo_rooty() + button.winfo_height() <= top + root.winfo_height(), "action clipped below window"
            root.event_generate("<Button-1>", x=10, y=10)
            from PIL import ImageGrab
            ImageGrab.grab(window=probe._real_hwnd(root)).save(DATA_DIR / "flyout-smoke.png")
            buttons[5].invoke()
            assert probe._legend_tip is not None, "legend did not open"
            buttons[5].invoke()
            assert probe._legend_tip is None, "legend did not close"
            for index, (_, action) in enumerate(_ACTIONS):
                if action != "legend":
                    buttons[index].invoke()
                    assert action in calls, f"callback missing: {action}"
            assert not errors, "Tk callback errors"
        except Exception as exc:
            errors.append(f"{type(exc).__name__}: {exc}")
        finally:
            if errors:
                probe.request_quit()
            else:
                # Allow the panel action's existing delayed hide to finish.
                probe._root.after(2800, check_focus)

    def check_focus():
        import ctypes
        import time
        root = probe._root
        other = ctk.CTk()
        other.title("Quanta acceptance focus target")
        other.geometry("260x140+40+40")
        other.withdraw()

        def settle():
            deadline = time.monotonic() + 0.65
            while time.monotonic() < deadline:
                root.update()
                time.sleep(0.01)

        try:
            probe._show()
            settle()
            assert probe.visible, "reopening failed"
            probe._legend_btn.focus_force()
            settle()
            assert probe.visible, "child focus dismissed the popup"
            focus_checks.append("child focus retained")
            probe._show_legend_tip()
            probe._legend_tip.focus_force()
            settle()
            assert probe.visible and probe._legend_tip is not None, "legend dismissed popup"
            focus_checks.append("legend focus retained")
            other.deiconify()
            other.lift()
            other.focus_force()
            settle()
            ctypes.windll.user32.GetForegroundWindow.restype = ctypes.c_void_p
            assert ctypes.windll.user32.GetForegroundWindow() == probe._real_hwnd(other), "focus target never activated"
            assert not probe.visible and not root.winfo_viewable(), "popup stayed above another foreground window"
            assert probe._legend_tip is None, "orphan legend after dismissal"
            focus_checks.append("external focus dismissed popup and legend")
            probe._show()
            settle()
            assert probe.visible, "popup could not reopen after dismissal"
            focus_checks.append("reopened after dismissal")
            root.event_generate("<Escape>")
            settle()
            assert not probe.visible, "Escape failed"
            focus_checks.append("Escape dismissed")
        except Exception as exc:
            errors.append(f"{type(exc).__name__}: {exc}")
        finally:
            other.destroy()
            probe.request_quit()

    class Probe(QuantaFlyout):
        def _build_root(self):
            root = super()._build_root()
            root.report_callback_exception = lambda exc, value, tb: errors.append(type(value).__name__)
            root.after(1200, check)
            root.after(12000, self.request_quit)
            return root

    callbacks = {action: lambda action=action: calls.append(action)
                 for _, action in _ACTIONS if action != "legend"}
    callbacks["autostart_enabled"] = lambda: False
    probe = Probe(callbacks, lambda: cards)
    probe.toggle()
    probe.run()
    ok = (not errors and len(focus_checks) == 5
          and set(calls) == {"refresh", "panel", "connections", "redetect", "autostart", "quit"})
    write_json(DATA_DIR / "flyout-smoke.json", {"ok": ok, "callbacks": calls,
               "errors": errors, "focus_checks": focus_checks, "checked_at": now_utc().isoformat()})
    return 0 if ok else 1


def panel_test():
    _require_isolation()
    import webview
    from aibar.panel import build_panel_html, run_panel_from_file
    target = DATA_DIR / "panel.html"
    target.write_text(build_panel_html({"visible": {"glm": True},
        "codex": {"accounts": [{"label": "weekly-fixture", "plan_type": "prolite",
            "is_current": True, "attribution_verified": True, "stale": False,
            "primary_window_minutes": 10080, "effective_primary_used_percent": 37}]},
        "glm": {"windows": [{"label": "5h", "percent": 25}]}}, []), encoding="utf-8")
    original_create = webview.create_window
    result = {"ok": False}
    connection_calls = []

    def create(*args, **kwargs):
        window = original_create(*args, **kwargs)

        def loaded():
            try:
                import time
                deadline = time.monotonic() + 5
                while window.evaluate_js("document.getElementById('add-connection').disabled") and time.monotonic() < deadline:
                    time.sleep(0.1)
                window.evaluate_js("document.getElementById('add-connection').click()")
                while not connection_calls and time.monotonic() < deadline:
                    time.sleep(0.1)
                result['connection_action'] = len(connection_calls) == 1
                result['text_selection'] = window.evaluate_js("getComputedStyle(document.body).userSelect !== 'none'")
                text = window.evaluate_js("document.body.innerText")
                result["ok"] = (result["connection_action"] and result["text_selection"] and "Quanta" in text and "GLM" in text and not target.exists()
                                and ("Pro (prolite) weekly-fixture " + tr("周")) in text
                                and "weekly-fixture 5h" not in text)
            except Exception as exc:
                result["error"] = type(exc).__name__
            finally:
                write_json(DATA_DIR / "panel-smoke.json", result)
                window.destroy()
        window.events.loaded += loaded
        return window

    webview.create_window = create
    try:
        from unittest.mock import patch
        with patch('aibar.panel_actions.open_connections', side_effect=lambda: connection_calls.append(True)):
            run_panel_from_file(str(target))
    finally:
        webview.create_window = original_create
    return 0 if result["ok"] else 1
