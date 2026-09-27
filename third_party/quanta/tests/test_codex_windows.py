"""Quota labels follow server durations, never plan names or slot order."""
import unittest
from datetime import datetime, timezone, timedelta

from aibar import history, icon, merge, panel
from aibar.oneshot import build_flyout_cards, render_rows
from aibar.providers import codex, codex_live


class CodexWindows(unittest.TestCase):
    def view(self, windows, plan="prolite"):
        now = datetime.now(timezone.utc) - timedelta(seconds=1)
        identity = {"account": {"type": "chatgpt", "email": "fixture@example.test", "planType": plan}}
        bucket = {"limitId": "codex", **windows}
        observed = codex_live.validate_observation(identity,
            {"accountId": "fixture", "rateLimitsByLimitId": {"codex": bucket}}, identity, "fixture")
        account = {**codex._normalize(now, observed["rate_limits"]), "label": "fixture",
                   "account_id": "fixture", "is_current": True, "attribution_verified": True}
        return merge.merge_snapshots({"machine": "fixture", "generated_at": now.isoformat(),
                                     "codex": {"accounts": [account]}}, [])

    @staticmethod
    def window(minutes, used=37, reset=2000000000):
        return {"usedPercent": used, "windowDurationMins": minutes, "resetsAt": reset}

    def test_week_only_in_primary_is_never_five_hours(self):
        for plan in ("plus", "pro", "prolite"):
            with self.subTest(plan=plan):
                view = self.view({"primary": self.window(10080), "secondary": None}, plan)
                card = build_flyout_cards(view)[0]
                self.assertEqual(card["bars"], [("周", 63)])
                row = render_rows(view)[0].text
                self.assertIn("周剩 63%", row)
                self.assertNotIn("5h", row)
                self.assertEqual(icon.per_source_remaining(view), [("Codex 周", 63)])
                self.assertTrue(panel._codex_card(view)["bars"][0][0].endswith(" 周"))
                point = history.extract_point(view)
                self.assertIsNone(point["codex_5h_remaining"])
                self.assertEqual(point["codex_week_remaining"], 63)

    def test_swapped_windows_keep_usage_and_reset_with_duration(self):
        view = self.view({"primary": self.window(10080, 37, 2000600000),
                          "secondary": self.window(300, 12, 2000000000)}, "plus")
        self.assertEqual(build_flyout_cards(view)[0]["bars"], [("5h", 88), ("周", 63)])
        self.assertEqual(view["recommendation"]["remaining_5h"], 88)
        self.assertEqual(view["recommendation"]["remaining_week"], 63)
        windows = view["recommendation"]["windows"]
        self.assertEqual([(w["label"], w["resets_at"]) for w in windows],
                         [("5h", 2000000000), ("周", 2000600000)])

    def test_secondary_only_and_other_duration(self):
        view = self.view({"primary": None, "secondary": self.window(60, 20)})
        self.assertEqual(build_flyout_cards(view)[0]["bars"], [("1h", 80)])
        self.assertIsNone(history.extract_point(view)["codex_week_remaining"])

    def test_unknown_duration_does_not_invent_five_hour_or_week_window(self):
        view = self.view({"primary": self.window(None, 20)})
        card = build_flyout_cards(view)[0]
        self.assertNotIn("5h", str(card["bars"]))
        self.assertIn("时长未知", str(card["bars"]))
        self.assertNotIn("recommendation", view)

    def test_expired_week_is_not_displayed_as_fresh_or_recommended(self):
        view = self.view({"primary": self.window(10080, 37, 1)})
        self.assertEqual(build_flyout_cards(view)[0]["bars"], [])
        self.assertEqual(panel._codex_card(view)["bars"], [])
        self.assertNotIn("recommendation", view)

    def test_stale_and_unverified_accounts_not_shown_as_current_quota(self):
        for change in ({"stale": True}, {"attribution_verified": False}):
            view = self.view({"primary": self.window(10080)})
            view.pop("recommendation", None)
            view["codex"]["accounts"][0].update(change)
            self.assertEqual(build_flyout_cards(view)[0]["bars"], [])
            self.assertEqual(panel._codex_card(view)["bars"], [])

    def test_plan_is_visible(self):
        for plan, label in (("plus", "Plus"), ("pro", "Pro"), ("prolite", "Pro (prolite)")):
            view = self.view({"primary": self.window(10080)}, plan)
            self.assertIn(label, str(build_flyout_cards(view)[0]))
            self.assertIn(label, render_rows(view)[0].text)
            self.assertIn(label, str(panel._codex_card(view)))

    def test_plus_two_windows_and_weekly_exhaustion_history(self):
        view = self.view({"primary": self.window(300, 12), "secondary": self.window(10080, 100)}, "plus")
        self.assertEqual(build_flyout_cards(view)[0]["bars"], [("5h", 88), ("周", 0)])
        self.assertNotIn("recommendation", view)
        point = history.extract_point(view)
        self.assertEqual((point["codex_5h_remaining"], point["codex_week_remaining"]), (88, 0))

    def test_missing_window_is_not_reused_from_previous_plan(self):
        # The same API slots can change schedules when an account upgrades.
        first = self.view({"primary": self.window(300, 12), "secondary": self.window(10080, 30)}, "plus")
        second = self.view({"primary": self.window(10080, 37)}, "prolite")
        self.assertEqual(len(build_flyout_cards(first)[0]["bars"]), 2)
        self.assertEqual(build_flyout_cards(second)[0]["bars"], [("周", 63)])
        self.assertIsNone(history.extract_point(second)["codex_5h_remaining"])

    def test_invalid_duration_is_unknown_and_boolean_usage_rejected(self):
        for duration in (0, -1, True, "10080"):
            view = self.view({"primary": self.window(duration)})
            self.assertIn("时长未知", str(build_flyout_cards(view)[0]["bars"]))
            self.assertNotIn("recommendation", view)
        with self.assertRaises(codex_live.QuotaReadError):
            self.view({"primary": self.window(10080, True)})

    def test_mixed_schedules_do_not_prompt_account_switch(self):
        view = self.view({"primary": self.window(10080, 60)})
        other = self.view({"primary": self.window(300, 0), "secondary": self.window(10080, 0)}, "plus")
        account = other["codex"]["accounts"][0]
        account.update(account_id="other", is_current=False)
        now = datetime.now(timezone.utc) - timedelta(seconds=1)
        merged = merge.merge_snapshots({"generated_at": now.isoformat(), "machine": "test",
            "codex": {"accounts": [view["codex"]["accounts"][0], account]}}, [])
        self.assertTrue(merged["recommendation"]["is_current"])
