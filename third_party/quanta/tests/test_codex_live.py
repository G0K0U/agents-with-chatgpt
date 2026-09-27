import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from aibar.common import write_json
from aibar.oneshot import render
from aibar.providers import codex, codex_live


class VerifiedQuota(unittest.TestCase):
    def setUp(self):
        self.account = {"account": {"type": "chatgpt", "email": "current@example.test", "planType": "plus"}}
        self.usage = {"accountId": "current", "rateLimitsByLimitId": {"codex": {
            "limitId": "codex", "primary": {"usedPercent": 58, "windowDurationMins": 300, "resetsAt": 2000000000},
            "secondary": {"usedPercent": 9, "windowDurationMins": 10080, "resetsAt": 2000600000}}}}

    def test_account_id_and_email_bound_to_live_response(self):
        observed = codex_live.validate_observation(self.account, self.usage, self.account, "current")
        self.assertEqual(observed["email"], "current@example.test")
        self.assertEqual(observed["account_id"], "current")
        self.assertEqual(observed["rate_limits"]["primary"]["used_percent"], 58)
        self.assertEqual(observed["rate_limits"]["secondary"]["used_percent"], 9)

    def test_different_or_missing_response_account_is_rejected(self):
        for account_id in (None, "another"):
            usage = {**self.usage, "accountId": account_id}
            with self.assertRaises(codex_live.QuotaReadError):
                codex_live.validate_observation(self.account, usage, self.account, "current")

    def test_signin_change_during_request_is_rejected(self):
        after = {"account": {"type": "chatgpt", "email": "other@example.test", "planType": "plus"}}
        with self.assertRaises(codex_live.QuotaReadError):
            codex_live.validate_observation(self.account, self.usage, after, "current")

    def test_other_model_bucket_is_not_used_as_codex_quota(self):
        usage = {**self.usage, "rateLimitsByLimitId": {"another": self.usage["rateLimitsByLimitId"]["codex"]}}
        with self.assertRaises(codex_live.QuotaReadError):
            codex_live.validate_observation(self.account, usage, self.account, "current")

    def test_verified_state_survives_failure_and_new_observation_replaces_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root/"state.json"
            write_json(root/"auth.json", {"tokens": {"account_id": "current"}})
            observed = codex_live.validate_observation(self.account, self.usage, self.account, "current")
            with patch.object(codex, "STATE_PATH", state), patch.object(codex, "_scan_sessions", return_value=[]):
                with patch.object(codex_live, "read_verified", return_value=observed):
                    first = codex.collect(root)
                self.assertTrue(first["accounts"][0]["attribution_verified"])
                with patch.object(codex_live, "read_verified", side_effect=codex_live.QuotaReadError("offline")):
                    second = codex.collect(root)
                self.assertTrue(second["accounts"][0]["attribution_verified"])
                self.assertEqual(second["accounts"][0]["primary_used_percent"], 58)
                self.assertEqual(second["live_error"], "offline")

    def test_unverified_legacy_percentages_are_not_displayed_under_email(self):
        view = {"codex": {"accounts": [{"label": "other@example.test", "attribution_verified": False,
                    "effective_primary_used_percent": 12, "effective_secondary_used_percent": 33}]}}
        text = render(view)
        # 极简单行式：未核验账号不单独展示，其百分比绝不出现
        self.assertNotIn("other@example.test", text)
        self.assertIn("尚无可核验用量", text)
        self.assertNotIn("88%", text)
        self.assertNotIn("67%", text)

    def _collect_web(self, key, live=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state.json"
            now = datetime.now(timezone.utc)
            write_json(root / "auth.json", {"tokens": {"account_id": "current"}})
            web = {**codex._normalize(now, {"primary": {"used_percent": 0},
                       "secondary": {"used_percent": 50}}),
                   "email": "web@example.test", "attribution_verified": True,
                   "verification_source": codex.WEB_SOURCE}
            write_json(state, {"accounts": {key: web}})
            result = {"return_value": live} if live else {"side_effect": codex_live.QuotaReadError("offline")}
            with patch.object(codex, "STATE_PATH", state), patch.object(codex, "_scan_sessions", return_value=[]), \
                    patch.object(codex_live, "read_verified", **result):
                return codex.collect(root, labels={key: "web@example.test"})

    def test_web_email_observation_survives_refresh_failure(self):
        account = self._collect_web("email:web@example.test")["accounts"][0]
        self.assertTrue(account["attribution_verified"])
        self.assertFalse(account["is_current"])
        self.assertEqual(account["secondary_used_percent"], 50)

    def test_web_observation_does_not_certify_historical_uuid(self):
        account = self._collect_web("unconfirmed-historical-uuid")["accounts"][0]
        self.assertFalse(account["attribution_verified"])

    def test_later_official_login_replaces_email_row_without_duplicate(self):
        account = {"account": {"type": "chatgpt", "email": "web@example.test", "planType": "plus"}}
        live = codex_live.validate_observation(account, self.usage, account, "current")
        accounts = self._collect_web("email:web@example.test", live)["accounts"]
        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0]["account_id"], "current")
        self.assertEqual(accounts[0]["verification_source"], codex_live.SOURCE)

    def test_web_reading_shows_as_history_without_dates(self):
        accounts = self._collect_web("email:web@example.test")["accounts"]
        text = render({"codex": {"accounts": accounts}})
        # 单行式：历史账号不再单独成行；旧核验读数也不得冒充当前用量
        self.assertNotIn("网页核验于", text)
        self.assertNotIn("此读数不会自动刷新", text)


if __name__ == "__main__":
    unittest.main()
