"""BiBrain for Hermes Agent: recall in front of each turn, a session note after it (bibrain-agent/1).

Fail-open by design: nothing here raises out of a hook, blocks a turn, or logs the key, the prompt, the reply or the returned text.
Standard library only.
"""
import hashlib
import json
import logging
import os
import re
import threading
import urllib.error
import urllib.request
from collections import OrderedDict
from urllib.parse import urlsplit

log = logging.getLogger(__name__)

CLIENT = "hermes"
PROMPT_MAX = 500
MIN_PROMPT = 12
RECALL_TIMEOUT_S = 1.5
NOTE_TIMEOUT_S = 2.5
READ_MAX = 64 * 1024
SESSIONS = 20
HASHES = 300
NOTES_PER_SESSION = 12
NOTE_MAX = 4000
LINE_MAX = 300
DECISIONS = 10
QUESTIONS = 10

# The same three patterns as apps/cli/lib.mjs looksLikeSecret; the server checks again.
_SECRETS = [
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    re.compile(r"\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b"),
    re.compile(r"(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password)\s*[=:]\s*[\"']?[A-Za-z0-9_./+\-=]{16,}", re.I),
]
_MARKER = re.compile(r"^\s*(?:[-*•]\s*)?(?:\*\*)?(?:decided|open question|still unclear|question|unclear|next step)\s*:", re.I | re.M)


def looks_like_secret(text):
    return any(p.search(text) for p in _SECRETS)


def skip_reason(prompt):
    t = prompt.strip()
    if len(t) < MIN_PROMPT:
        return "short"
    if t[:1] in "/!#":
        return "command"
    if looks_like_secret(t):
        return "secret"
    return None


def api_origin(value):
    """Only https, or plaintext loopback with a port; no credentials, path, query or fragment. The same rule as the stdio adapter."""
    u = urlsplit(value or "")
    local = u.scheme == "http" and u.hostname in ("127.0.0.1", "localhost") and u.port
    if (not local and u.scheme != "https") or u.username or u.password or u.path not in ("", "/") or u.query or u.fragment:
        raise ValueError("BRAIN_API_URL must be an HTTPS origin, or loopback HTTP with a port, without credentials or a path.")
    return f"{u.scheme}://{u.netloc}"


def marker_lines(text):
    """Only the marker lines of a reply, cleaned as the server cleans them: the last 10 decisions, the last 10 questions and the last next step,
    each at most 300 code points, joined by newlines and cut to 4,000. None unless a decision or a question is present."""
    decisions, questions, nxt, fenced = [], [], None, False
    fits = lambda s: 0 < len(s) <= LINE_MAX
    for raw in re.split(r"\r?\n", text):
        if re.match(r"^\s*```", raw):
            fenced = not fenced
            continue
        if fenced:
            continue
        line = re.sub(r"^[-*•]\s*", "", raw.strip()).replace("**", "").strip()
        d = re.match(r"^decided\s*:\s*(.+)$", line, re.I)
        if d:
            m = re.match(r"^([^:\r\n]{1,120}):\s+(.+)$", d.group(1).strip())
            if m and fits(m.group(2).strip()):
                decisions.append(line)
            continue
        q = re.match(r"^(?:open question|still unclear|question|unclear)\s*:\s*(.+)$", line, re.I)
        if q:
            if fits(q.group(1).strip()):
                questions.append(line)
            continue
        n = re.match(r"^next step\s*:\s*(.+)$", line, re.I)
        if n and fits(n.group(1).strip()):
            nxt = line
    if not decisions and not questions:
        return None
    return "\n".join(decisions[-DECISIONS:] + questions[-QUESTIONS:] + ([nxt] if nxt else []))[:NOTE_MAX]


def _sha(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _settings():
    """The key and the address, from Hermes's secret scope when it exists (a raise falls back to the environment), else the environment. Never logged."""
    get = None
    try:
        from agent.secret_scope import get_secret as get
    except Exception:
        pass

    def read(name):
        value = None
        if get:
            try:
                value = get(name)
            except Exception:
                value = None
        return (value if isinstance(value, str) else None) or os.environ.get(name) or ""

    key, url = read("BRAIN_AGENT_TOKEN").strip(), read("BRAIN_API_URL").strip()
    if not key or not url:
        return None
    return api_origin(url), key


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def _post(path, body, timeout):
    """One POST under a wall-clock deadline. urllib's timeout is per socket operation and skips DNS, so the request runs in a daemon
    thread joined for `timeout` seconds; if the join expires the caller gets None and the thread is left to die with its socket.
    The body is read to READ_MAX bytes at most. No redirects, no proxy: the key never travels through HTTP_PROXY."""
    origin, key = _settings()
    req = urllib.request.Request(origin + path, data=json.dumps(body).encode("utf-8"), method="POST", headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    opener = urllib.request.build_opener(_NoRedirect(), urllib.request.ProxyHandler({}))
    box = {}

    def work():
        try:
            with opener.open(req, timeout=timeout) as res:
                raw = res.read(READ_MAX + 1)
                box["value"] = None if len(raw) > READ_MAX else json.loads(raw.decode("utf-8"))
        except Exception as e:
            box["error"] = type(e).__name__

    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive() or "value" not in box:
        return None
    return box["value"]


# Per-session memory, in this process only: hashes of ids already shown, whether the digest was carried, hashes of notes sent.
_sessions = OrderedDict()


def _session(session_hash):
    s = _sessions.pop(session_hash, None) or {"hashes": [], "digested": False, "notes": []}
    _sessions[session_hash] = s
    while len(_sessions) > SESSIONS:
        _sessions.popitem(last=False)
    return s


def pre_llm_call(**kwargs):
    try:
        prompt = kwargs.get("user_message")
        if not isinstance(prompt, str) or skip_reason(prompt):
            return None
        if not _settings():
            return None
        session_hash = _sha(str(kwargs.get("session_id") or ""))
        s = _session(session_hash)
        body = {"prompt": prompt[:PROMPT_MAX], "session_id": session_hash, "first_prompt": not s["digested"], "seen": s["hashes"][-HASHES:], "client": CLIENT}
        reply = _post("/api/v1/agent/recall-push", body, RECALL_TIMEOUT_S)
        if not isinstance(reply, dict) or reply.get("level") not in ("full", "pointer", "none") or not isinstance(reply.get("text"), str):
            return None
        ids = [x for x in (reply.get("hit_ids") or []) if isinstance(x, str)]
        s["hashes"] = (s["hashes"] + [_sha(i) for i in ids])[-HASHES:]
        s["digested"] = s["digested"] or reply.get("digest") is True
        log.debug("bibrain recall level=%s hits=%d", reply.get("level"), len(ids))
        return {"context": reply["text"]} if reply["text"] else None
    except Exception as e:  # fail-open: the turn goes on without the brain
        log.debug("bibrain recall skipped: %s", type(e).__name__)
        return None


def post_llm_call(**kwargs):
    try:
        reply = kwargs.get("assistant_response")
        if not isinstance(reply, str) or not _MARKER.search(reply) or looks_like_secret(reply):
            return None
        text = marker_lines(reply)
        if text is None or looks_like_secret(text):
            return None
        if not _settings():
            return None
        session_hash = _sha(str(kwargs.get("session_id") or ""))
        s = _session(session_hash)
        h = _sha(text)
        if h in s["notes"] or len(s["notes"]) >= NOTES_PER_SESSION:
            return None
        result = _post("/api/v1/agent/session-note", {"session_id": session_hash, "client": CLIENT, "text": text}, NOTE_TIMEOUT_S)
        if isinstance(result, dict):
            s["notes"] = (s["notes"] + [h])[-NOTES_PER_SESSION:]
            log.debug("bibrain note saved=%s", result.get("saved"))
    except Exception as e:
        log.debug("bibrain note skipped: %s", type(e).__name__)
    return None


def register(ctx):
    """Called once by Hermes at startup (plugins guide). pre_llm_call carries the user's turn; post_llm_call carries the final reply."""
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("post_llm_call", post_llm_call)
