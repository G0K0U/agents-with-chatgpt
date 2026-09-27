"""Native connection editor. Secrets never enter an HTML page or IPC payload."""
import queue
import threading
import webbrowser
from .i18n import tr
from .brand import ASSETS
from .connections_windows import key_page, test_and_save


def show_connections():
    import customtkinter as ctk
    from .config import load_config
    ctk.set_appearance_mode('dark')
    root = ctk.CTk()
    root.title(tr('Quanta · 添加连接'))
    root.iconbitmap(str(ASSETS / 'icon.ico'))
    root.geometry('400x620')
    root.minsize(400, 620)
    root.configure(fg_color='#0d1117')
    root.grid_columnconfigure(0, weight=1)
    results = queue.Queue()
    busy = False

    def label(text, row, **kw):
        widget = ctk.CTkLabel(root, text=tr(text), anchor='w', justify='left', **kw)
        widget.grid(row=row, column=0, sticky='ew', padx=24, pady=5)
        return widget

    label('添加连接', 0, font=('Segoe UI', 24, 'bold'))
    label('连接你的账户，查看官方额度或 API 余额。', 1, wraplength=352)
    provider = ctk.CTkOptionMenu(root, values=['GLM', 'DeepSeek'])
    provider.grid(row=2, column=0, sticky='ew', padx=24, pady=8)
    region_label = label('服务区域', 3)
    regions = {'Z.ai': 'zai', 'BigModel': 'bigmodel'}
    region = ctk.CTkOptionMenu(root, values=list(regions))
    region.grid(row=4, column=0, sticky='ew', padx=24, pady=5)
    status_box = ctk.CTkFrame(root, corner_radius=8, border_width=1)
    status_box.grid(row=5, column=0, sticky='ew', padx=24, pady=(10, 8))
    status = ctk.CTkLabel(status_box, text='', font=('Consolas', 14, 'bold'), anchor='center')
    status.pack(fill='x', padx=14, pady=10)
    label('API 密钥', 6)
    key = ctk.CTkEntry(root, show='•', placeholder_text=tr('粘贴密钥；已保存的密钥不会显示'))
    key.grid(row=7, column=0, sticky='ew', padx=24, pady=5)
    from .entry_actions import install_edit_shortcuts
    install_edit_shortcuts(key._entry)
    feedback = label('', 10, wraplength=352)
    label('仅查询官方用量或余额。验证成功后保存到 Windows 凭据管理器；失败保留原连接。旧配置中的密钥不会被删除或迁移。', 11,
          wraplength=352, text_color='#8b949e')

    def selection():
        return provider.get().lower(), regions[region.get()]

    def show_status(state):
        from .connection_status import status_presentation
        display = status_presentation(*selection(), state)
        status_box.configure(fg_color=display['background'], border_color=display['border'])
        status.configure(text=tr(display['title']), text_color=display['foreground'])

    def update_status(_=None):
        name, _platform = selection()
        key.delete(0, 'end')
        cfg = load_config()
        configured = bool(cfg.get(name, {}).get('token' if name == 'glm' else 'api_key'))
        state = 'pending' if configured else 'disconnected'
        if name in cfg.get('_connection_errors', {}):
            state = 'storage_error'
        show_status(state)
        region.configure(state='normal' if name == 'glm' else 'disabled')
        region_label.configure(text=tr('服务区域') if name == 'glm' else 'DeepSeek API')
        feedback.configure(text='')

    def open_key_page():
        try:
            opened = webbrowser.open(key_page(*selection()))
            feedback.configure(text=tr('已在默认浏览器打开官网。登录并复制密钥后，回到这里粘贴。' if opened else '未能打开浏览器，请稍后重试。'))
        except Exception:
            feedback.configure(text=tr('未能打开浏览器，请稍后重试。'))

    open_button = ctk.CTkButton(root, text=tr('打开官方密钥页面 ↗'), command=open_key_page)
    open_button.grid(row=8, column=0, sticky='ew', padx=24, pady=8)

    def submit():
        nonlocal busy
        if busy:
            return
        name, platform = selection()
        secret = key.get()
        if not secret.strip():
            feedback.configure(text=tr('请输入密钥。'))
            return
        busy = True
        show_status('checking')
        for control in (provider, region, key, open_button, save_button):
            control.configure(state='disabled')
        feedback.configure(text=tr('正在查询官方接口…'))
        save_button.configure(text=tr('正在测试…'))

        def worker():
            results.put(test_and_save(name, secret, platform))
        threading.Thread(target=worker, daemon=True).start()

    save_button = ctk.CTkButton(root, text=tr('测试并保存'), command=submit)
    save_button.grid(row=9, column=0, sticky='ew', padx=24, pady=8)

    def poll():
        nonlocal busy
        try:
            ok, message = results.get_nowait()
        except queue.Empty:
            pass
        else:
            busy = False
            for control in (provider, key, open_button, save_button):
                control.configure(state='normal')
            region.configure(state='normal' if provider.get() == 'GLM' else 'disabled')
            key.delete(0, 'end')
            save_button.configure(text=tr('测试并保存'))
            feedback.configure(text=tr(message), text_color='#3fb950' if ok else '#f85149')
            show_status('connected' if ok else 'failed')
        root.after(100, poll)

    provider.configure(command=update_status)
    region.configure(command=update_status)
    root.protocol('WM_DELETE_WINDOW', root.destroy)
    update_status()
    poll()
    root.mainloop()


if __name__ == '__main__':
    show_connections()
