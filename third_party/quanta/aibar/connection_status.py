"""Safe, fixed-vocabulary connection status for the native editor."""

STATES = {
    'disconnected': ('未连接', '#3b2025', '#944653', '#ffb5be'),
    'pending': ('已配置 · 等待验证', '#1c2430', '#455166', '#c4cfdf'),
    'checking': ('正在验证…', '#1c2430', '#455166', '#c4cfdf'),
    'connected': ('已连接', '#153a29', '#2d8053', '#a6edbd'),
    'failed': ('连接失败；原连接保留', '#3b2025', '#944653', '#ffb5be'),
    'storage_error': ('安全存储暂不可用', '#3b2025', '#944653', '#ffb5be'),
}


def status_presentation(provider, platform, state):
    host = {('glm', 'zai'): 'api.z.ai', ('glm', 'bigmodel'): 'open.bigmodel.cn',
            ('deepseek', 'zai'): 'api.deepseek.com',
            ('deepseek', 'bigmodel'): 'api.deepseek.com'}[(provider, platform)]
    title, background, border, foreground = STATES[state]
    mode = 'quota.read' if provider == 'glm' else 'balance.read'
    return {'title': title, 'background': background, 'border': border,
            'foreground': foreground,
            'details': f'SERVICE  {provider.upper()}\nHOST     {host}\nMODE     {mode}   |   STATE {state.upper()}'}
