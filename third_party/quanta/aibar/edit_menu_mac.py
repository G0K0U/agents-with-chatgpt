"""Standard AppKit editing commands routed to the current first responder."""
from .i18n import tr
from AppKit import (NSApplication, NSMenu, NSMenuItem,
                    NSEventModifierFlagCommand, NSEventModifierFlagShift)


def install_edit_menu():
    app = NSApplication.sharedApplication()
    main = app.mainMenu()
    if main is None:
        main = NSMenu.alloc().initWithTitle_('Quanta')
        app.setMainMenu_(main)
    if main.itemWithTitle_(tr('编辑')) is not None:
        return
    edit = NSMenu.alloc().initWithTitle_(tr('编辑'))
    for title, action, key, shift in (
        ('撤销', 'undo:', 'z', False),
        ('重做', 'redo:', 'z', True),
        ('剪切', 'cut:', 'x', False),
        ('复制', 'copy:', 'c', False),
        ('粘贴', 'paste:', 'v', False),
        ('全选', 'selectAll:', 'a', False),
    ):
        item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(tr(title), action, key)
        item.setKeyEquivalentModifierMask_(NSEventModifierFlagCommand | (NSEventModifierFlagShift if shift else 0))
        item.setTarget_(None)
        edit.addItem_(item)
    parent = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(tr('编辑'), None, '')
    parent.setSubmenu_(edit)
    main.addItem_(parent)
    window_menu = NSMenu.alloc().initWithTitle_(tr('窗口'))
    close = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(tr('关闭面板'), 'performClose:', 'w')
    close.setTarget_(None)
    close.setKeyEquivalentModifierMask_(NSEventModifierFlagCommand)
    window_menu.addItem_(close)
    window_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(tr('窗口'), None, '')
    window_item.setSubmenu_(window_menu)
    main.addItem_(window_item)
