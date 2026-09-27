import unittest
from unittest.mock import Mock
from aibar.entry_actions import edit_entry


class EntryActions(unittest.TestCase):
    def entry(self):
        entry = Mock()
        entry.cget.return_value = 'normal'
        entry.selection_present.return_value = True
        entry.index.side_effect = [1, 4]
        entry.get.return_value = 'synthetic'
        return entry

    def test_copy_selected_entered_text_not_password_mask(self):
        entry = self.entry()
        edit_entry(entry, 'copy')
        entry.clipboard_append.assert_called_once_with('ynt')
        entry.delete.assert_not_called()

    def test_cut_removes_only_copied_selection(self):
        entry = self.entry()
        edit_entry(entry, 'cut')
        entry.clipboard_append.assert_called_once_with('ynt')
        entry.delete.assert_called_once_with(1, 4)

    def test_paste_uses_native_event_without_reading_clipboard_in_helper(self):
        entry = self.entry()
        edit_entry(entry, 'paste')
        entry.event_generate.assert_called_once_with('<<Paste>>')
        entry.get.assert_not_called()
        entry.clipboard_get.assert_not_called()

    def test_disabled_control_does_not_edit_or_access_clipboard(self):
        entry = self.entry()
        entry.cget.return_value = 'disabled'
        for action in ('copy', 'cut', 'paste', 'select_all'):
            edit_entry(entry, action)
        entry.clipboard_clear.assert_not_called()
        entry.clipboard_append.assert_not_called()
        entry.event_generate.assert_not_called()
        entry.selection_range.assert_not_called()
