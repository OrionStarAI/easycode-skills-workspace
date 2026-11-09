"""Offline regression tests for the vendored WeChat skill and local adaptations."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SKILL = Path(__file__).resolve().parents[1] / "skills/wechat-official-account/scripts/wechat.py"
spec = importlib.util.spec_from_file_location("wechat_official_account", SKILL)
wechat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wechat)

APP_ID = "wx" + "a" * 16
SECRET = "x" * 32
TOKEN = "synthetic-token"
ARTICLE = {
    "ref_date": "2025-11-01", "msgid": "12003_1", "title": "示例",
    "content_url": "https://mp.weixin.qq.com/s/example", "publish_type": 0,
    "detail_list": [
        {"stat_date": "2025-11-01", "read_user": 8, "share_user": 0},
        {"stat_date": "2025-11-02", "read_user": 12, "share_user": 2, "collection_user": 1},
    ],
}


class FakeResponse:
    def __init__(self, data):
        self.data = data

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def read(self):
        return json.dumps(self.data).encode("utf-8")


class WechatSkillTest(unittest.TestCase):
    def test_stats_use_stable_token_and_preserve_cumulative_snapshots(self):
        calls = []

        def urlopen(request, timeout):
            calls.append(request)
            self.assertEqual(timeout, 30)
            if request.full_url.startswith("https://api.weixin.qq.com/cgi-bin/stable_token"):
                self.assertEqual(request.get_method(), "POST")
                self.assertNotIn(SECRET, request.full_url)
                self.assertEqual(json.loads(request.data), {
                    "grant_type": "client_credential", "appid": APP_ID,
                    "secret": SECRET, "force_refresh": False,
                })
                return FakeResponse({"access_token": TOKEN, "expires_in": 7200})
            self.assertEqual(request.get_method(), "POST")
            self.assertEqual(json.loads(request.data), {"begin_date": "2025-11-01", "end_date": "2025-11-01"})
            return FakeResponse({"is_delay": True, "list": [ARTICLE]})

        with patch.dict(os.environ, {"WECHAT_APP_ID": APP_ID, "WECHAT_APP_SECRET": SECRET}), \
             patch.object(wechat.urllib.request, "urlopen", side_effect=urlopen):
            result = wechat.execute("get-article-stats", {"date": "2025-11-01"})
        self.assertTrue(result["success"])
        self.assertTrue(result["isDelayed"])
        self.assertEqual([s["readUsers"] for s in result["items"][0]["snapshots"]], [8, 12])
        self.assertIsNone(result["items"][0]["snapshots"][0]["favoriteUsers"])
        self.assertEqual(result["items"][0]["snapshots"][0]["shareUsers"], 0)
        self.assertEqual(len(calls), 2)
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertNotIn(TOKEN, json.dumps(result))

    def test_statistics_filter_and_empty_result(self):
        with patch.dict(os.environ, {"WECHAT_APP_ID": APP_ID, "WECHAT_APP_SECRET": SECRET}), \
             patch.object(wechat.WeChatAPI, "post", return_value={"is_delay": False, "list": [ARTICLE]}):
            result = wechat.execute("get-article-stats", {"date": "2025-11-01", "msgId": "12003_2"})
        self.assertTrue(result["success"])
        self.assertEqual(result["items"], [])
        self.assertFalse(result["isDelayed"])

    def test_cli_accepts_json_and_outputs_one_json_result(self):
        output = io.StringIO()
        with patch.dict(os.environ, {"WECHAT_APP_ID": APP_ID, "WECHAT_APP_SECRET": SECRET}), \
             patch.object(wechat.WeChatAPI, "post", return_value={"list": [ARTICLE], "is_delay": False}), \
             patch("sys.stdin", io.StringIO('{"date":"2025-11-01"}')), \
             patch("sys.stdout", output):
            status = wechat.main(["get-article-stats"])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output.getvalue())["items"][0]["title"], "示例")
        self.assertNotIn(SECRET, output.getvalue())

    def test_invalid_dates_fail_before_network(self):
        with patch.object(wechat.urllib.request, "urlopen") as request:
            for value in ("2025-10-31", "2025-11-31", "2099-01-01", "not-a-date"):
                self.assertEqual(wechat.execute("get-article-stats", {"date": value})["error"], "INVALID_ARGUMENT")
            request.assert_not_called()

    def test_reuses_existing_project_config_without_echoing_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            (project / ".secrets").mkdir()
            (project / ".secrets/wechat-config.json").write_text(json.dumps({"appid": APP_ID, "secret": SECRET}))
            with patch.dict(os.environ, {"WECHAT_APP_ID": "", "WECHAT_APP_SECRET": ""}), \
                 patch.object(wechat.Path, "cwd", return_value=project):
                api = wechat.WeChatAPI()
                self.assertEqual((api.app_id, api.app_secret), (APP_ID, SECRET))

    def test_partial_environment_does_not_mix_accounts(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            (project / ".secrets").mkdir()
            (project / ".secrets/wechat-config.json").write_text(json.dumps({"appid": APP_ID, "secret": SECRET}))
            with patch.dict(os.environ, {"WECHAT_APP_ID": APP_ID, "WECHAT_APP_SECRET": ""}), \
                 patch.object(wechat.Path, "cwd", return_value=project):
                with self.assertRaises(wechat.WeChatError):
                    wechat.WeChatAPI()

    def test_network_and_bad_config_errors_do_not_leak_secrets(self):
        with patch.dict(os.environ, {"WECHAT_APP_ID": APP_ID, "WECHAT_APP_SECRET": SECRET}), \
             patch.object(wechat.urllib.request, "urlopen", side_effect=RuntimeError(SECRET + TOKEN)):
            result = wechat.execute("get-article-stats", {"date": "2025-11-01"})
        self.assertFalse(result["success"])
        self.assertNotIn(SECRET, str(result))
        self.assertNotIn(TOKEN, str(result))
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            (project / ".secrets").mkdir()
            (project / ".secrets/wechat-config.json").write_text(SECRET)
            with patch.dict(os.environ, {"WECHAT_APP_ID": "", "WECHAT_APP_SECRET": ""}), \
                 patch.object(wechat.Path, "cwd", return_value=project):
                result = wechat.execute("get-article-stats", {"date": "2025-11-01"})
        self.assertFalse(result["success"])
        self.assertNotIn(SECRET, str(result))

    def test_wechat_error_is_not_converted_to_empty_data(self):
        with patch.dict(os.environ, {"WECHAT_APP_ID": APP_ID, "WECHAT_APP_SECRET": SECRET}), \
             patch.object(wechat.urllib.request, "urlopen", return_value=FakeResponse({"errcode": 48001, "errmsg": SECRET})):
            result = wechat.execute("get-article-stats", {"date": "2025-11-01"})
        self.assertFalse(result["success"])
        self.assertIn("48001", result["message"])
        self.assertNotIn(SECRET, str(result))


if __name__ == "__main__":
    unittest.main()
