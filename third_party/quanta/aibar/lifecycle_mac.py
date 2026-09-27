"""Quanta owns its windows; closing them does not quit the menu-bar app."""
import objc
import rumps.rumps as runtime
from AppKit import (NSApplication, NSApplicationActivationPolicyAccessory,
                    NSApplicationActivationPolicyRegular)
from .dock_icon_mac import application_icon


class QuantaDelegate(runtime.NSApp, protocols=[objc.protocolNamed('NSApplicationDelegate')]):
    def applicationShouldTerminateAfterLastWindowClosed_(self, sender):
        return False

    def applicationShouldHandleReopen_hasVisibleWindows_(self, sender, visible):
        if visible:
            return True
        flyout = self._app.get('_flyout')
        if flyout is not None:
            flyout.app.open_panel()
        return False


def install_delegate():
    runtime.NSApp = QuantaDelegate


def show_in_dock(visible):
    app = NSApplication.sharedApplication()
    app.setApplicationIconImage_(application_icon())
    app.setActivationPolicy_(NSApplicationActivationPolicyRegular if visible
                             else NSApplicationActivationPolicyAccessory)
