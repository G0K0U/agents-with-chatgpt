import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

@unittest.skipUnless(sys.platform == 'darwin', 'macOS connection handling')
class NewConnectionSafety(unittest.TestCase):
    def test_new_connection_is_protected_before_refresh(self):
        from aibar import config, connections_mac
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'config.json'
            path.write_text('{}')
            runtime = connections_mac.apply_connection({}, 'glm', 'synthetic-private-value', 'zai')
            with patch.object(config, 'CONFIG_PATH', path):
                config.save_config(runtime)
            self.assertNotIn('synthetic-private-value', path.read_text())
            self.assertEqual(json.loads(path.read_text())['glm']['token'], '')
