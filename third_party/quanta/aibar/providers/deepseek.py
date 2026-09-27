"""DeepSeek account balance via the official documented API.

GET https://api.deepseek.com/user/balance  (Bearer api_key)
Docs: https://api-docs.deepseek.com/api/get-user-balance
"""
import json
import urllib.parse
import urllib.request

from ..common import now_utc
from ..http_client import official_opener, read_object

_URL = "https://api.deepseek.com/user/balance"
_OPENER = official_opener()


def collect(api_key: str = "") -> dict:
    if not api_key:
        return {"error": "未配置 DeepSeek API key（config.json → deepseek.api_key）"}
    # 仅允许官方主机，防止任何其他目标被请求
    if urllib.parse.urlparse(_URL).hostname != "api.deepseek.com":
        return {"error": "blocked: non-official DeepSeek host"}
    req = urllib.request.Request(
        _URL,
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
    )
    try:
        with _OPENER.open(req, timeout=15) as resp:
            data = read_object(resp)
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__}

    infos = data.get("balance_infos") or []
    if not infos and data.get("balance_information"):  # 旧版返回形状兜底
        infos = [data["balance_information"]]
    balances = [
        {
            "currency": i.get("currency"),
            "total_balance": i.get("total_balance"),
            "granted_balance": i.get("granted_balance"),
            "topped_up_balance": i.get("topped_up_balance"),
        }
        for i in infos
    ]
    return {
        "balances": balances,
        "is_available": data.get("is_available"),
        "updated_at": now_utc().isoformat(),
    }
