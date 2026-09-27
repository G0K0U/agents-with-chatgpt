"""Bounded JSON reads and credential-preserving HTTP policy."""
import json
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def official_opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def read_object(response, limit=2_000_000):
    body = response.read(limit + 1)
    if len(body) > limit:
        raise ValueError("JSON response exceeds size limit")
    value = json.loads(body.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Expected JSON object")
    return value
