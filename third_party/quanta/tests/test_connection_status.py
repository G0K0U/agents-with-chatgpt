import unittest
from aibar.connection_status import status_presentation, STATES


class ConnectionStatus(unittest.TestCase):
    def test_only_verified_success_is_green(self):
        green = status_presentation('glm', 'zai', 'connected')['background']
        for state in STATES:
            if state != 'connected':
                self.assertNotEqual(status_presentation('glm', 'zai', state)['background'], green)

    def test_technical_fields_follow_selected_service_and_region(self):
        self.assertIn('open.bigmodel.cn', status_presentation('glm', 'bigmodel', 'pending')['details'])
        details = status_presentation('deepseek', 'zai', 'disconnected')['details']
        self.assertIn('api.deepseek.com', details)
        self.assertIn('balance.read', details)

    def test_arbitrary_values_are_not_rendered(self):
        for args in [('unknown', 'zai', 'pending'), ('glm', 'unknown', 'pending'),
                     ('glm', 'zai', 'raw-error-with-secret')]:
            with self.assertRaises(KeyError):
                status_presentation(*args)
