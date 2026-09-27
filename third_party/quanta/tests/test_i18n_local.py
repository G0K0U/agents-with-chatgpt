import unittest
from unittest.mock import patch
from aibar.i18n import choose_language, tr, localize_html

class LocalizationTests(unittest.TestCase):
    def test_primary_language_only(self):
        cases=[(['zh-Hans-CN'],'zh'),(['zh-Hant-TW'],'zh'),(['zh_HK'],'zh'),
               (['en-AU'],'en'),(['fr-FR','zh-CN'],'en'),(['ja-JP'],'en'),([], 'en')]
        for preferred,want in cases:self.assertEqual(choose_language(preferred),want)

    def test_dynamic_values_and_counts(self):
        with patch('aibar.i18n.language',return_value='en'):
            self.assertEqual(tr('129时10分后重置'),'Resets in 129h 10m')
            self.assertEqual(tr('3 分钟前'),'3 min ago')
            self.assertEqual(tr('汇总：最紧缺来源剩 40%，注意用量'),'Summary: Lowest remaining quota: 40% — watch your usage')
            self.assertEqual(tr('周窗口 剩 40%'),'Weekly 40% remaining')
            self.assertEqual(tr('82.70 CNY · 0.00 USD'),'82.70 CNY · 0.00 USD')

    def test_chinese_retained(self):
        with patch('aibar.i18n.language',return_value='zh'):
            self.assertEqual(tr('正在验证…'),'正在验证…')
            self.assertNotIn('MutationObserver',localize_html('<html lang="zh-CN"><body>已连接</body></html>'))

    def test_english_localizes_display_not_payload(self):
        html='<html lang="zh-CN"><body><input type="password" value="中文密钥"><script>const state="已连接";</script></body></html>'
        with patch('aibar.i18n.language',return_value='en'):
            result=localize_html(html)
        self.assertIn('lang="en"',result)
        self.assertIn('value="中文密钥"',result)
        self.assertIn('const state="已连接"',result)
        self.assertIn('MutationObserver',result)
