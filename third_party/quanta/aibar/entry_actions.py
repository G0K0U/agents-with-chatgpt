"""User-triggered local editing for native entry controls."""
import tkinter as tk
from .i18n import tr


def edit_entry(entry, action):
    if str(entry.cget('state')) == 'disabled':
        return 'break'
    if action == 'select_all':
        entry.selection_range(0, 'end')
        entry.icursor('end')
    elif action == 'paste':
        entry.event_generate('<<Paste>>')
    elif action in ('copy', 'cut') and entry.selection_present():
        first, last = entry.index('sel.first'), entry.index('sel.last')
        # Copy only the user's selected, currently entered text. Never load a
        # saved credential. Clipboard access happens only on this user action.
        entry.clipboard_clear()
        entry.clipboard_append(entry.get()[first:last])
        if action == 'cut':
            entry.delete(first, last)
    return 'break'


def install_edit_shortcuts(entry):
    entry.configure(exportselection=False)
    actions = {65: 'select_all', 67: 'copy', 86: 'paste', 88: 'cut'}

    def control(event):
        # Windows virtual-key codes remain stable with an active IME and Caps Lock.
        action = actions.get(event.keycode)
        if action:
            return edit_entry(entry, action)

    entry.bind('<Control-KeyPress>', control)
    for sequence, action in (('<Shift-Insert>', 'paste'), ('<Control-Insert>', 'copy'),
                             ('<Shift-Delete>', 'cut')):
        entry.bind(sequence, lambda event, a=action: edit_entry(entry, a))
    menu = tk.Menu(entry, tearoff=False)
    for label, action in (('剪切', 'cut'), ('复制', 'copy'), ('粘贴', 'paste'), ('全选', 'select_all')):
        menu.add_command(label=tr(label), command=lambda a=action: edit_entry(entry, a))

    def show_menu(event):
        entry.focus_set()
        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()
        return 'break'

    entry.bind('<Button-3>', show_menu)
    return menu
