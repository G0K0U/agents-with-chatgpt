"""Explicit provider connections; secrets stay in the user's macOS Keychain."""
import json
from copy import deepcopy
import Security as S
from Foundation import NSData

SERVICE = 'com.quanta.provider-connections'
PROVIDERS = ('glm', 'deepseek')


def _query(provider):
    if provider not in PROVIDERS:
        raise ValueError('Unsupported provider')
    return {S.kSecClass: S.kSecClassGenericPassword,
            S.kSecAttrService: SERVICE, S.kSecAttrAccount: provider,
            S.kSecAttrSynchronizable: False}


def read_connection(provider, *, allow_auth=False):
    query = _query(provider)
    query.update({S.kSecReturnData: True, S.kSecMatchLimit: S.kSecMatchLimitOne,
                  S.kSecUseAuthenticationUI: (S.kSecUseAuthenticationUIAllow if allow_auth else S.kSecUseAuthenticationUIFail)})
    status, value = S.SecItemCopyMatching(query, None)
    if status == S.errSecItemNotFound:
        return None
    if status != S.errSecSuccess:
        raise OSError("Quanta Keychain unavailable")
    try:
        data = json.loads(bytes(value))
        if not isinstance(data, dict) or not isinstance(data.get('secret'), str):
            raise ValueError("Invalid Quanta credential")
        if data.get('platform') not in ('zai', 'bigmodel'):
            raise ValueError('Invalid Quanta credential')
        return data
    except (ValueError, TypeError):
        raise ValueError("Invalid Quanta credential") from None


def save_connection(provider, secret, platform='zai'):
    query = _query(provider)
    raw = json.dumps({'secret': secret, 'platform': platform}).encode()
    attributes = {S.kSecValueData: NSData.dataWithBytes_length_(raw, len(raw))}
    status = S.SecItemUpdate(query, attributes)
    if status == S.errSecItemNotFound:
        status, _ = S.SecItemAdd({**query, **attributes,
            S.kSecAttrAccessible: S.kSecAttrAccessibleWhenUnlockedThisDeviceOnly}, None)
    if status != S.errSecSuccess:
        raise RuntimeError('钥匙串保存失败；原连接未替换')


def apply_connection(cfg, provider, secret, platform):
    result = deepcopy(cfg)
    protected = result.setdefault('_secure_providers', [])
    if provider not in protected:
        protected.append(provider)
    result.setdefault(provider, {})['token' if provider == 'glm' else 'api_key'] = secret
    if provider == 'glm':
        result[provider]['platform'] = platform
    result['hidden_sources'] = [k for k in result.get('hidden_sources', []) if k != provider]
    return result


def overlay(cfg):
    result = deepcopy(cfg)
    for provider in PROVIDERS:
        try:
            entry = read_connection(provider)
        except (OSError, ValueError):
            result.setdefault('_secure_providers', []).append(provider)
            result.setdefault('_connection_errors', {})[provider] = '安全存储暂不可用'
            result.setdefault(provider, {})['token' if provider == 'glm' else 'api_key'] = ''
            continue
        if entry and entry['secret']:
            result.setdefault('_secure_providers', []).append(provider)
            result = apply_connection(result, provider, entry['secret'], entry['platform'])
    result = deepcopy(result)
    result['hidden_sources'] = list(cfg.get('hidden_sources', []))
    return result


def test_and_save(provider, secret, platform='zai'):
    # Never return credentials or provider response bodies to the web view.
    if provider not in PROVIDERS or platform not in ('zai', 'bigmodel'):
        return False, '请选择受支持的服务。'
    if not isinstance(secret, str) or not secret.strip():
        return False, '请输入密钥。'
    secret = secret.strip()
    if len(secret) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in secret):
        return False, '密钥格式不正确，请重新粘贴。'
    from .providers import glm, deepseek
    try:
        response = (glm.collect(platform=platform, token=secret) if provider == 'glm'
                    else deepseek.collect(api_key=secret))
        valid = bool(response.get('windows') if provider == 'glm' else response.get('balances'))
        if response.get('error') or not valid:
            return False, '连接失败或未返回可用数据。请检查密钥、服务区域及账户权限；原连接未更改。'
        save_connection(provider, secret, platform)
    except Exception:
        return False, '连接或安全保存失败。请检查网络及钥匙串访问；原连接未更改。'
    return True, '已连接，密钥已保存到本机钥匙串。'


def key_page(provider, platform='zai'):
    """Fixed official destinations; never accept a URL from web content."""
    if provider == 'deepseek':
        return 'https://platform.deepseek.com/api_keys'
    if provider == 'glm' and platform == 'zai':
        return 'https://z.ai/manage-apikey/apikey-list'
    if provider == 'glm' and platform == 'bigmodel':
        return 'https://bigmodel.cn/usercenter/apikeys'
    raise ValueError('Unsupported provider')
