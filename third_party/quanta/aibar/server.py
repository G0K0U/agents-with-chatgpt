"""Authenticated snapshot API; loopback by default, optionally a Tailscale IPv4."""
import hmac
import ipaddress
import json
import socket
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .collect import SNAPSHOT_PATH, collect_local
from .common import read_json
from .config import load_config


def validate_host(host):
    ip = ipaddress.ip_address(host)
    if ip.version != 4 or not (ip.is_loopback or ip in ipaddress.ip_network("100.64.0.0/10")):
        raise ValueError("API host must be a loopback or Tailscale IPv4 address")
    return str(ip)


class _Server(ThreadingHTTPServer):
    """单实例由端口绑定裁决：第二实例 bind 同端口必须失败。

    Windows bind 语义：默认允许第二个 socket 静默绑定同一端口（与 Unix 相反），
    所以 Windows 上要在 bind 前设置 SO_EXCLUSIVEADDRUSE（该常量仅 Windows 存在，
    其他平台用 hasattr 守卫，绝不能无条件引用——否则 macOS/Linux 直接 AttributeError）。
    非 Windows：allow_reuse_address 保持 False，Unix 语义下对活动端口的重复绑定
    本身就会失败，单实例同样成立（代价是快速重启可能短暂撞 TIME_WAIT，已接受）。"""
    allow_reuse_address = False
    request_timeout = 10

    def __init__(self, *args, **kwargs):
        self._slots = threading.BoundedSemaphore(16)
        super().__init__(*args, **kwargs)

    def get_request(self):
        client, address = super().get_request()
        client.settimeout(self.request_timeout)
        return client, address

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()

    def server_bind(self):
        exclusive = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
        if exclusive is not None:  # Windows only
            self.socket.setsockopt(socket.SOL_SOCKET, exclusive, 1)
        super().server_bind()


class Handler(BaseHTTPRequestHandler):
    server_version = "aibar/0.2"

    def do_GET(self):
        url_parts = self.path.split("?", 1)
        if url_parts[0] != "/api/usage":
            self.send_error(404)
            return
        provided = self.headers.get("X-Token", "").encode("utf-8")
        if not hmac.compare_digest(provided, self.server.aibar_token.encode("utf-8")):
            self.send_error(401, "bad token")
            return

        query_str = url_parts[1] if len(url_parts) > 1 else ""
        query_params = urllib.parse.parse_qs(query_str)
        force_refresh = (
            query_params.get("force_refresh", [""])[0].lower() in ("1", "true", "yes")
            or query_params.get("force", [""])[0].lower() in ("1", "true", "yes")
            or self.headers.get("X-Force-Refresh", "").lower() in ("1", "true", "yes")
        )

        if force_refresh:
            cfg = getattr(self.server, "cfg", None)
            try:
                snap = collect_local(cfg)
            except Exception as exc:  # noqa: BLE001 - preserve but never redate cached samples
                old = self.server.snapshot_reader() or {}
                snap = dict(old) if isinstance(old, dict) else {}
                snap["refresh_error"] = type(exc).__name__
                for key in ("codex", "glm", "antigravity"):
                    provider = snap.get(key)
                    if isinstance(provider, dict):
                        snap[key] = {**provider, "error": "RefreshFailed", "refresh_failed": True}
        else:
            # Serving the cache avoids repeated vendor requests and state writes.
            snap = self.server.snapshot_reader()

        if not snap:
            self.send_error(503, "Waiting for the first collector refresh")
            return
        body = json.dumps(snap, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


def create_server(cfg=None, snapshot_reader=None):
    cfg = cfg or load_config()
    token = cfg["server"].get("token", "")
    if not isinstance(token, str) or len(token) < 16:
        raise ValueError("API token must have at least 16 characters")
    host = validate_host(cfg["server"].get("host", "127.0.0.1"))
    httpd = _Server((host, int(cfg["server"]["port"])), Handler)
    httpd.daemon_threads = True
    httpd.aibar_token = token
    httpd.cfg = cfg
    httpd.snapshot_reader = snapshot_reader or (lambda: read_json(SNAPSHOT_PATH))
    return httpd


def serve(cfg=None):
    with create_server(cfg) as httpd:
        httpd.serve_forever()
