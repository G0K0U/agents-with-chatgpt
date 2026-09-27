import unittest
import sys
from unittest.mock import patch
from copy import deepcopy
if sys.platform == "darwin":
    from aibar import connections_mac as c

@unittest.skipUnless(sys.platform == "darwin", "macOS Keychain integration")
class Connections(unittest.TestCase):
    def test_empty_and_invalid_never_call_provider(self):
        with patch('aibar.providers.glm.collect') as collect, patch.object(c, 'save_connection') as save:
            for key in ('', ' ', 'invalid test key', 'a\nheader', 'a'*4097):
                self.assertFalse(c.test_and_save('glm', key)[0])
            collect.assert_not_called(); save.assert_not_called()

    def test_failure_preserves_credentials_and_redacts(self):
        with patch('aibar.providers.deepseek.collect', return_value={'error':'private-secret'}), patch.object(c, 'save_connection') as save:
            ok, message = c.test_and_save('deepseek', 'test-secret')
            self.assertFalse(ok); self.assertNotIn('private-secret', message);save.assert_not_called()

    def test_success_checks_endpoint_then_saves(self):
        with patch('aibar.providers.glm.collect', return_value={'windows':[{'percent':20}]}) as collect, patch.object(c, 'save_connection') as save:
            self.assertTrue(c.test_and_save('glm','test-secret','bigmodel')[0])
            collect.assert_called_once_with(platform='bigmodel',token='test-secret')
            save.assert_called_once_with('glm','test-secret','bigmodel')

    def test_empty_response_not_connected(self):
        with patch('aibar.providers.deepseek.collect', return_value={'balances':[]}), patch.object(c, 'save_connection') as save:
            self.assertFalse(c.test_and_save('deepseek','test-secret')[0]);save.assert_not_called()

    def test_keychain_failure_not_success(self):
        with patch('aibar.providers.deepseek.collect', return_value={'balances':[{'total_balance':'0'}]}), patch.object(c,'save_connection',side_effect=RuntimeError('secret')):
            ok, msg=c.test_and_save('deepseek','test-secret')
            self.assertFalse(ok);self.assertNotIn('secret',msg)

    def test_overlay_preserves_config_and_hidden_preferences(self):
        cfg={'glm':{'token':'legacy','platform':'zai'},'hidden_sources':['glm'],'peers':[{'token':'peer'}]}
        before=deepcopy(cfg)
        with patch.object(c,'read_connection',side_effect=[{'secret':'new','platform':'bigmodel'},None]):
            result=c.overlay(cfg)
        self.assertEqual(cfg,before);self.assertEqual(result['glm']['token'],'new')
        self.assertEqual(result['hidden_sources'],['glm']);self.assertEqual(result['peers'],cfg['peers'])

    def test_keychain_scope_and_update(self):
        with patch.object(c.S,'SecItemUpdate',return_value=c.S.errSecSuccess) as update, patch.object(c.S,'SecItemAdd') as add:
            c.save_connection('deepseek','test-secret')
            query=update.call_args.args[0]
            self.assertEqual(query[c.S.kSecAttrService],c.SERVICE)
            self.assertEqual(query[c.S.kSecAttrAccount],'deepseek');add.assert_not_called()

    def test_missing_keychain_preserves_legacy(self):
        cfg={'deepseek':{'api_key':'legacy'}}
        with patch.object(c,'read_connection',return_value=None):
            self.assertEqual(c.overlay(cfg)['deepseek'],cfg['deepseek'])

if __name__=='__main__':unittest.main()
