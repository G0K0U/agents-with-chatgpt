"""A transient, local-only WebKit popover anchored to the macOS status logo."""
import json
import queue
import threading
import objc
import rumps
from Foundation import NSObject, NSDictionary, NSURL
from AppKit import (NSWorkspace, NSApplication, NSPopover, NSPopoverBehaviorTransient,
                    NSViewController, NSMinYEdge, NSViewWidthSizable, NSViewHeightSizable,
                    NSEventMaskLeftMouseUp, NSEventMaskRightMouseUp, NSScreen, NSWindow,
                    NSWindowStyleMaskTitled, NSWindowStyleMaskClosable, NSWindowStyleMaskResizable,
                    NSWindowStyleMaskMiniaturizable, NSBackingStoreBuffered)
from WebKit import (WKWebView, WKWebViewConfiguration, WKWebsiteDataStore,
                    WKContentRuleListStore)
from .brand import ASSETS
from .flyout_model_mac import model_for
from . import autostart_mac
from .i18n import tr, localize_html

ACTIONS = frozenset(('refresh', 'panel', 'redetect', 'autostart', 'quit', 'close', 'legend', 'connections'))


def trusted_message(message, views, protected):
    """Only our protected, local main-frame documents may call native actions."""
    if not protected or not message.frameInfo().isMainFrame():
        return False
    sender = message.webView()
    if sender is None or sender not in views:
        return False
    url = sender.URL()
    return url is not None and str(url.absoluteString()) == 'about:blank'


class MacFlyout(NSObject, protocols=[objc.protocolNamed("WKNavigationDelegate"),
                                   objc.protocolNamed("WKScriptMessageHandler")]):
    def initWithApp_(self, app):
        self = objc.super(MacFlyout, self).init()
        if self is None:
            return None
        from .edit_menu_mac import install_edit_menu
        install_edit_menu()
        from .lifecycle_mac import show_in_dock
        show_in_dock(False)
        self.app = app
        self.ready = False
        self.last_json = None
        self.feedback = ''
        self.connections_window = None
        self.connections_webview = None
        self.connection_pending = queue.SimpleQueue()
        self.connection_busy = False
        self.connection_refresh = False
        self.details_window = None
        self.details_webview = None
        self.content_rules = None
        self.legend_open = False
        self.current_height = None
        try:
            self.startup = autostart_mac.is_enabled()
        except (OSError, ValueError):
            self.startup = False
            self.feedback = '无法读取登录启动设置'
        configuration = WKWebViewConfiguration.alloc().init()
        configuration.setWebsiteDataStore_(WKWebsiteDataStore.nonPersistentDataStore())
        configuration.userContentController().addScriptMessageHandler_name_(self, 'quanta')
        screen = NSScreen.mainScreen()
        height = min(660, screen.visibleFrame().size.height - 50) if screen else 660
        self.webview = WKWebView.alloc().initWithFrame_configuration_(((0, 0), (360, height)), configuration)
        self.webview.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)
        self.webview.setNavigationDelegate_(self)
        controller = NSViewController.alloc().init()
        controller.setView_(self.webview)
        self.popover = NSPopover.alloc().init()
        self.popover.setBehavior_(NSPopoverBehaviorTransient)
        self.popover.setAnimates_(True)
        self.popover.setContentSize_((360, height))
        self.popover.setContentViewController_(controller)
        def rules_ready(rules, error):
            if rules is not None:
                self.content_rules = rules
                configuration.userContentController().addContentRuleList_(rules)
                self.webview.loadHTMLString_baseURL_(localize_html((ASSETS / 'mac-flyout.html').read_text()), None)
            else:
                self.webview.loadHTMLString_baseURL_('<html><body>Unable to initialize local content protection.</body></html>', None)
        self._rules_callback = rules_ready
        WKContentRuleListStore.defaultStore().compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler_(
            'QuantaLocalOnly', '[{"trigger":{"url-filter":".*"},"action":{"type":"block"}}]', rules_ready)

        button = app._nsapp.nsstatusitem.button()
        app._nsapp.nsstatusitem.setMenu_(None)
        button.setTarget_(self)
        button.setAction_('toggle:')
        button.sendActionOn_(NSEventMaskLeftMouseUp | NSEventMaskRightMouseUp)
        return self

    @objc.python_method
    def open_details(self, html_text):
        if self.content_rules is None:
            return  # Fail closed while local content protection is unavailable.
        if self.details_window is None:
            configuration = WKWebViewConfiguration.alloc().init()
            configuration.setWebsiteDataStore_(WKWebsiteDataStore.nonPersistentDataStore())
            configuration.userContentController().addScriptMessageHandler_name_(self, 'quanta')
            if self.content_rules is not None:
                configuration.userContentController().addContentRuleList_(self.content_rules)
            screen = self.app._nsapp.nsstatusitem.button().window().screen() or NSScreen.mainScreen()
            frame = screen.visibleFrame()
            width, height = min(900, frame.size.width - 40), min(730, frame.size.height - 40)
            origin = (frame.origin.x + (frame.size.width - width) / 2,
                      frame.origin.y + (frame.size.height - height) / 2)
            styles = (NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                      NSWindowStyleMaskResizable | NSWindowStyleMaskMiniaturizable)
            self.details_window = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
                (origin, (width, height)), styles, NSBackingStoreBuffered, False)
            self.details_window.setReleasedWhenClosed_(False)
            self.details_window.setDelegate_(self)
            self.details_window.setTitle_(tr('Quanta · AI 用量'))
            self.details_webview = WKWebView.alloc().initWithFrame_configuration_(((0, 0), (width, height)), configuration)
            self.details_webview.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)
            self.details_webview.setNavigationDelegate_(self)
            self.details_window.setContentView_(self.details_webview)
        html_text = html_text.replace('<!--connections-action-->', '<button style="padding:3px 0;border:0;border-radius:3px;background:transparent;color:#8cb9ed;font:500 12px -apple-system,sans-serif;line-height:18px;cursor:pointer" onclick="window.webkit.messageHandlers.quanta.postMessage(\'connections\')">＋ 添加链接</button>')
        self.details_webview.loadHTMLString_baseURL_(localize_html(html_text), None)
        from .lifecycle_mac import show_in_dock
        show_in_dock(True)
        NSApplication.sharedApplication().activateIgnoringOtherApps_(True)
        self.details_window.makeKeyAndOrderFront_(None)

    @objc.python_method
    def open_connections(self):
        if self.content_rules is None:
            return
        if self.connections_window is None:
            configuration = WKWebViewConfiguration.alloc().init()
            configuration.setWebsiteDataStore_(WKWebsiteDataStore.nonPersistentDataStore())
            configuration.userContentController().addScriptMessageHandler_name_(self, 'quanta')
            if self.content_rules is not None:
                configuration.userContentController().addContentRuleList_(self.content_rules)
            screen = NSScreen.mainScreen().visibleFrame()
            width, height = 420, min(630, screen.size.height - 40)
            origin = (screen.origin.x + (screen.size.width-width)/2,
                      screen.origin.y + (screen.size.height-height)/2)
            self.connections_window = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
                (origin, (width, height)), NSWindowStyleMaskTitled | NSWindowStyleMaskClosable,
                NSBackingStoreBuffered, False)
            self.connections_window.setReleasedWhenClosed_(False)
            self.connections_window.setDelegate_(self)
            self.connections_window.setTitle_(tr('Quanta · 添加连接'))
            self.connections_webview = WKWebView.alloc().initWithFrame_configuration_(((0, 0), (width, height)), configuration)
            self.connections_webview.setNavigationDelegate_(self)
            self.connections_window.setContentView_(self.connections_webview)
        if not self.connection_busy:
            self.connections_webview.loadHTMLString_baseURL_(localize_html((ASSETS / 'mac-connections.html').read_text()), None)
        from .lifecycle_mac import show_in_dock
        show_in_dock(True)
        NSApplication.sharedApplication().activateIgnoringOtherApps_(True)
        self.connections_window.makeKeyAndOrderFront_(None)

    def windowWillClose_(self, notification):
        from PyObjCTools import AppHelper
        AppHelper.callAfter(self.sync_dock)

    @objc.python_method
    def sync_dock(self):
        from .lifecycle_mac import show_in_dock
        visible = any(window is not None and window.isVisible()
                      for window in (self.details_window, self.connections_window))
        show_in_dock(visible)

    @objc.python_method
    def connection_states(self):
        states = {}
        for key, field in (('glm', 'token'), ('deepseek', 'api_key')):
            configured = bool(self.app.cfg.get(key, {}).get(field))
            reading = self.app.view.get(key) or {}
            if not configured:
                states[key] = '未连接'
            elif reading.get('error'):
                states[key] = '连接失败 · 已配置凭证'
            elif reading.get('windows') or reading.get('balances'):
                states[key] = '已连接'
            else:
                states[key] = '已配置 · 等待验证'
        return states

    @objc.python_method
    def connect(self, body):
        if self.connection_busy:
            return
        provider, platform, secret = body.get('provider'), body.get('platform'), body.get('secret')
        if provider not in ('glm', 'deepseek') or platform not in ('zai', 'bigmodel') or not isinstance(secret, str):
            return
        self.connection_busy = True
        def work():
            from .connections_mac import test_and_save
            ok, message = test_and_save(provider, secret, platform)
            self.connection_pending.put((provider, platform, secret if ok else None, ok, message))
        threading.Thread(target=work, daemon=True).start()

    @objc.python_method
    def authorize_keychain(self, body):
        provider = body.get('provider')
        if self.connection_busy or provider not in ('glm', 'deepseek'):
            return
        self.connection_busy = True
        def work():
            from .connections_mac import read_connection
            try:
                entry = read_connection(provider, allow_auth=True)
                message = tr('已允许访问钥匙串，正在刷新连接。' if entry else '没有找到已保存的连接。')
                del entry
            except (OSError, ValueError):
                message = tr('未获准访问钥匙串，已有设置保持不变。')
            self.connection_pending.put((provider, 'zai', None, False, message))
            self.connection_refresh = True
        threading.Thread(target=work, daemon=True).start()

    @objc.python_method
    def drain_connections(self):
        while not self.connection_pending.empty():
            provider, platform, secret, ok, message = self.connection_pending.get_nowait()
            self.connection_busy = False
            if ok:
                from .connections_mac import apply_connection
                self.app.cfg = apply_connection(self.app.cfg, provider, secret, platform)
                self.connection_refresh = True
            payload = json.dumps({'provider': provider, 'ok': ok, 'message': message})
            self.connections_webview.evaluateJavaScript_completionHandler_('window.connectionResult(' + payload + ')', None)
        if self.connection_refresh and not self.app.refreshing:
            self.connection_refresh = False
            self.app.refresh(redetect=True)

    def toggle_(self, sender):
        if self.popover.isShown():
            self.popover.performClose_(None)
            return
        self.update(force=True)
        button = self.app._nsapp.nsstatusitem.button()
        NSApplication.sharedApplication().activateIgnoringOtherApps_(True)
        self.popover.showRelativeToRect_ofView_preferredEdge_(button.bounds(), button, NSMinYEdge)
        if self.webview.window():
            self.webview.window().makeKeyWindow()

    @objc.python_method
    def update(self, force=False):
        self.drain_connections()
        if not self.ready or (not force and not self.popover.isShown()):
            return
        model = model_for(self.app, self.startup, self.feedback)
        height = 220 + sum(68 + 32 * len(c['bars']) + (16 if c['detail'] else 0) for c in model['cards'])
        height += ((186 if model['show_muse_legend'] else 166) if self.legend_open else 0) + (42 if model['feedback'] or model['error'] else 0)
        screen = self.app._nsapp.nsstatusitem.button().window().screen() or NSScreen.mainScreen()
        maximum = min(700, screen.visibleFrame().size.height - 50) if screen else 700
        height = max(360, min(height, maximum))
        if height != self.current_height:
            self.popover.setContentSize_((360, height))
            self.current_height = height
        payload = json.dumps(model, ensure_ascii=True, allow_nan=False)
        if force or payload != self.last_json:
            self.webview.evaluateJavaScript_completionHandler_('window.updateData(' + payload + ')', None)
            self.last_json = payload

    def webView_didFinishNavigation_(self, webview, navigation):
        if webview == self.connections_webview:
            payload = json.dumps(self.connection_states())
            webview.evaluateJavaScript_completionHandler_("window.connectionState(" + payload + ")", None)
        if webview == self.webview:
            self.ready = True
            self.update(force=True)

    def webView_didStartProvisionalNavigation_(self, webview, navigation):
        url = webview.URL()
        if url is not None and str(url.absoluteString()) != 'about:blank':
            webview.stopLoading()

    def userContentController_didReceiveScriptMessage_(self, controller, message):
        if not trusted_message(message, (self.webview, self.details_webview, self.connections_webview),
                               self.content_rules is not None):
            return
        action = message.body()
        if message.webView() == self.connections_webview:
            if isinstance(action, (dict, NSDictionary)) and action.get("action") == "connect-save":
                self.connect(action)
            elif isinstance(action, (dict, NSDictionary)) and action.get("action") == "authorize-keychain":
                self.authorize_keychain(action)
            elif isinstance(action, (dict, NSDictionary)) and action.get("action") == "open-key-page":
                from .connections_mac import key_page
                try:
                    url = key_page(action.get('provider'), action.get('platform'))
                    opened = NSWorkspace.sharedWorkspace().openURL_(NSURL.URLWithString_(url))
                    message = '已在默认浏览器打开官网。登录并复制密钥后，回到这里粘贴。' if opened else '未能打开浏览器，请稍后重试。'
                except (ValueError, TypeError):
                    message = '请选择受支持的服务。'
                self.connections_webview.evaluateJavaScript_completionHandler_('window.keyPageResult(' + json.dumps(message) + ')', None)
            return
        if message.webView() not in (self.webview, self.details_webview):
            return
        if message.webView() == self.details_webview and action != "connections":
            return
        if not isinstance(action, str) or action not in ACTIONS:
            return
        self.feedback = ''
        self.last_action = action
        try:
            if action == 'connections':
                self.open_connections()
                self.popover.performClose_(None)
            elif action == 'refresh':
                self.app.refresh()
            elif action == 'redetect':
                self.app.refresh(redetect=True)
            elif action == 'panel':
                self.app.open_panel()
                self.popover.performClose_(None)
            elif action == 'autostart':
                autostart_mac.set_enabled(not self.startup)
                self.startup = autostart_mac.is_enabled()
                self.feedback = '将在下次登录时启动' if self.startup else '已关闭登录时启动'
            elif action == 'legend':
                self.legend_open = not self.legend_open
            elif action == 'quit':
                self.popover.performClose_(None)
                rumps.quit_application()
            elif action == 'close':
                self.popover.performClose_(None)
        except Exception as exc:
            self.feedback = '操作未完成：' + type(exc).__name__
        self.update(force=True)
