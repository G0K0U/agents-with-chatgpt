"""Only Quanta's own generic credentials; no enumeration, plaintext file or web bridge."""
import ctypes
import json
import math
import threading
from copy import deepcopy
from ctypes import wintypes

PROVIDERS = ('glm', 'deepseek')
_SAVE_LOCK = threading.Lock()


class Credential(ctypes.Structure):
    _fields_ = [('Flags', wintypes.DWORD), ('Type', wintypes.DWORD),
                ('TargetName', wintypes.LPWSTR), ('Comment', wintypes.LPWSTR),
                ('LastWritten', wintypes.FILETIME), ('CredentialBlobSize', wintypes.DWORD),
                ('CredentialBlob', ctypes.POINTER(ctypes.c_byte)), ('Persist', wintypes.DWORD),
                ('AttributeCount', wintypes.DWORD), ('Attributes', ctypes.c_void_p),
                ('TargetAlias', wintypes.LPWSTR), ('UserName', wintypes.LPWSTR)]


def _target(provider):
    if provider not in PROVIDERS:
        raise ValueError('Unsupported provider')
    import os, hashlib
    from .common import DATA_DIR
    suffix = '/' + hashlib.sha256(str(DATA_DIR).casefold().encode()).hexdigest()[:16] if os.environ.get('AIBAR_DATA_DIR') else ''
    return 'Quanta/provider/' + provider + suffix


def _api():
    api = ctypes.WinDLL('Advapi32', use_last_error=True)
    api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                              ctypes.POINTER(ctypes.POINTER(Credential))]
    api.CredReadW.restype = wintypes.BOOL
    api.CredWriteW.argtypes = [ctypes.POINTER(Credential), wintypes.DWORD]
    api.CredWriteW.restype = wintypes.BOOL
    api.CredFree.argtypes = [ctypes.c_void_p]
    api.CredFree.restype = None
    return api


def read_connection(provider):
    target = _target(provider)
    api = _api()
    ptr = ctypes.POINTER(Credential)()
    if not api.CredReadW(target, 1, 0, ctypes.byref(ptr)):
        if ctypes.get_last_error() == 1168:  # This exact Quanta entry is absent.
            return None
        raise OSError('Windows credential storage unavailable')
    try:
        if not 0 < ptr.contents.CredentialBlobSize <= 2560:
            raise ValueError('Invalid Quanta credential')
        raw = ctypes.string_at(ptr.contents.CredentialBlob, ptr.contents.CredentialBlobSize)
        value = json.loads(raw.decode('utf-8'))
        if not isinstance(value, dict) or not isinstance(value.get('secret'), str) or value.get('platform') not in ('zai', 'bigmodel'):
            raise ValueError('Invalid Quanta credential')
        return value
    finally:
        api.CredFree(ptr)


def save_connection(provider, secret, platform='zai'):
    target = _target(provider)
    raw = json.dumps({'secret': secret, 'platform': platform}).encode('utf-8')
    if len(raw) > 2560:
        raise ValueError('Key exceeds Windows credential size')
    blob = (ctypes.c_byte * len(raw)).from_buffer_copy(raw)
    entry = Credential(Type=1, TargetName=target, CredentialBlobSize=len(raw),
                       CredentialBlob=blob, Persist=2, UserName='Quanta')
    if not _api().CredWriteW(ctypes.byref(entry), 0):
        raise OSError('Windows credential save failed')


def overlay(cfg):
    result = deepcopy(cfg)
    for provider in PROVIDERS:
        try:
            entry = read_connection(provider)
        except (OSError, ValueError):
            result.setdefault('_secure_providers', []).append(provider)
            result.setdefault('_connection_errors', {})[provider] = '安全存储暂不可用'
            # Fail closed: do not silently use a different legacy account.
            result.setdefault(provider, {})['token' if provider == 'glm' else 'api_key'] = ''
            continue
        if entry and entry['secret']:
            result.setdefault('_secure_providers', []).append(provider)
            result.setdefault(provider, {})['token' if provider == 'glm' else 'api_key'] = entry['secret']
            if provider == 'glm':
                result[provider]['platform'] = entry['platform']
    return result


def key_page(provider, platform='zai'):
    return {('glm', 'zai'): 'https://z.ai/manage-apikey/apikey-list',
            ('glm', 'bigmodel'): 'https://bigmodel.cn/usercenter/apikeys',
            ('deepseek', 'zai'): 'https://platform.deepseek.com/api_keys',
            ('deepseek', 'bigmodel'): 'https://platform.deepseek.com/api_keys'}[(provider, platform)]


def valid_response(provider, response):
    if not isinstance(response, dict) or response.get('error'):
        return False
    if provider == 'glm':
        return any(isinstance(w, dict) and isinstance(w.get('percent'), (int, float))
                   and not isinstance(w['percent'], bool) and math.isfinite(w['percent'])
                   and 0 <= w['percent'] <= 100 for w in response.get('windows') or [])
    for balance in response.get('balances') or []:
        try:
            if balance.get('currency') and math.isfinite(float(balance['total_balance'])) and float(balance['total_balance']) >= 0:
                return True
        except (AttributeError, KeyError, ValueError, TypeError):
            pass
    return False


def test_and_save(provider, secret, platform='zai'):
    if provider not in PROVIDERS or platform not in ('zai', 'bigmodel'):
        return False, '请选择受支持的服务。'
    if not isinstance(secret, str) or not secret.strip():
        return False, '请输入密钥。'
    secret = secret.strip()
    if len(secret) > 2000 or any(ord(c) < 33 or ord(c) > 126 for c in secret):
        return False, '密钥格式不正确，请重新粘贴。'
    if not _SAVE_LOCK.acquire(blocking=False):
        return False, '正在验证…'
    try:
        from .providers import glm, deepseek
        response = (glm.collect(platform=platform, token=secret) if provider == 'glm'
                    else deepseek.collect(api_key=secret))
        if not valid_response(provider, response):
            return False, '连接失败或未返回可用数据。请检查密钥、服务区域及账户权限；原连接未更改。'
        save_connection(provider, secret, platform)
        # A non-secret notification lets the tray reload even when the editor
        # was opened from the separate detail-window process.
        from .common import DATA_DIR, write_json, now_utc
        try:
            write_json(DATA_DIR / 'connections-changed.json', {'updated_at': now_utc().isoformat()})
        except OSError:
            pass  # Credential is saved; the regular refresh also reloads it.
        return True, '已连接，密钥已保存到 Windows 凭据管理器。'
    except Exception:
        # Never include a response body, secret, exception message, or traceback.
        return False, '连接或安全保存失败；原连接未更改。'
    finally:
        _SAVE_LOCK.release()
