"""Transparent always-on-top desktop floating 哈Gemi pet for antigravity-hagemi-pet."""

from __future__ import annotations

import argparse
import ctypes
import gc
import json
import math
import os
import platform
import random
import re
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional

try:
    from PySide6.QtCore import QObject, QPoint, QPointF, QRect, QRectF, QSize, Qt, QTimer, Signal
    from PySide6.QtGui import (
        QAction,
        QColor,
        QFont,
        QFontMetrics,
        QGuiApplication,
        QIcon,
        QImageReader,
        QPainter,
        QPainterPath,
        QPen,
        QPixmap,
        QTransform,
    )
    from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon, QWidget
except ImportError:
    from PyQt6.QtCore import QObject, QPoint, QPointF, QRect, QRectF, QSize, Qt, QTimer, pyqtSignal as Signal
    from PyQt6.QtGui import (
        QAction,
        QColor,
        QFont,
        QFontMetrics,
        QGuiApplication,
        QIcon,
        QImageReader,
        QPainter,
        QPainterPath,
        QPen,
        QPixmap,
        QTransform,
    )
    from PyQt6.QtWidgets import QApplication, QMenu, QSystemTrayIcon, QWidget


ACTION_DEFS = {
    "idle": {"file": "待机呼吸休闲", "loop": True, "title": "待机呼吸", "category": "idle"},
    "thinking": {"file": "工作状态-思考冒泡", "loop": True, "title": "思考冒泡", "category": "thinking"},
    "coding": {"file": "写代码", "loop": True, "title": "疯狂写码", "category": "working"},
    "happy": {"file": "点击回应-开心跃动", "loop": False, "title": "开心跃动", "category": "celebrate"},
    "shocked": {"file": "被吓一跳", "loop": False, "title": "被吓一跳", "category": "error"},
    "dangling": {"file": "被鼠标拖拽悬空反馈", "loop": True, "title": "悬空挣扎", "category": "dragged"},
}

STATIC_AVATAR_FILES = {
    "idle": "avatar_default.png",
    "thinking": "avatar_bust.png",
    "coding": "avatar_bust.png",
    "happy": "avatar_relieved.png",
    "shocked": "avatar_shocked.png",
    "dangling": "avatar_shocked.png",
    "awaiting_auth": "avatar_bust.png",
}

STATE_COLORS = {
    "idle": "#818CF8",
    "thinking": "#38BDF8",
    "working": "#34D399",
    "celebrate": "#FBBF24",
    "petted": "#F472B6",
    "error": "#F87171",
    "dragged": "#C084FC",
    "awaiting_auth": "#F59E0B",
}

WAITING_STATUSES = frozenset({
    "WAITING",
    "WAITING_FOR_USER",
    "PENDING_APPROVAL",
    "NEEDS_APPROVAL",
    "CORTEX_STEP_STATUS_WAITING",
})

TOOL_FRIENDLY_NAMES = {
    "read_file": "读文件",
    "view_file": "看代码",
    "write_file": "写新文件",
    "edit_file": "改代码",
    "replace_file_content": "改代码",
    "multi_replace_file_content": "批量改代码",
    "run_command": "跑终端",
    "search_web": "查资料",
    "grep_search": "搜代码",
    "find_by_name": "找文件",
    "invoke_subagent": "派分身",
    "run_workflow": "跑工作流",
    "ask_question": "向你确认",
    "generate_image": "画插图",
}

CODING_TOOLS = frozenset({
    "edit_file",
    "write_file",
    "replace_file_content",
    "multi_replace_file_content",
    "run_command",
})

POKE_LINES = [
    "别戳啦，哈Gemi 的猫耳都要歪掉了喵！(≧▽≦)",
    "哼，写代码的时候不要随便捏本小姐！该喂 Token 了吧？",
    "嘿嘿，好痒呀~ 今天的代码也要一次通过哦 ♡",
    "被你发现了！本 Gemini 娘正在桌面偷偷盯着你的 Bug 呢~",
    "在呢在呢！随时帮你盯紧 Antigravity 的一举一动喵！",
]

IDLE_LINES = [
    "写代码的时候记得多喝水喵，颈椎也要照顾好~",
    "本 Gemini 娘正盯着 Antigravity，有报错立刻提醒你！",
    "咕噜…有点想吃高质量 Token 了喵~",
    "可以拎起我甩一甩，也可以右键切换动作和大小哦！",
]

_USER_REQ_RE = re.compile(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", re.DOTALL)
_EXIT_CODE_RE = re.compile(r"Command exited with code\s+(-?\d+)")


def _fmt_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def _is_pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if platform.system() == "Windows":
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong(0)
            if kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return exit_code.value == STILL_ACTIVE
            return True
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class FloatingParticle:
    """Floating particle emitted on click, feed, celebration, or auth prompt."""

    def __init__(self, x: float, y: float, alert: bool = False) -> None:
        self.x = x + random.uniform(-22.0, 22.0)
        self.y = y + random.uniform(-10.0, 10.0)
        self.vx = random.uniform(-42.0, 42.0)
        self.vy = random.uniform(-110.0, -58.0)
        self.alpha = 1.0
        self.size = random.uniform(13.0, 20.0)
        if alert:
            self.char = random.choice(["🔐", "❗", "👆", "✨"])
            self.color = random.choice([
                QColor("#F59E0B"),
                QColor("#FB923C"),
                QColor("#FBBF24"),
                QColor("#FDE047"),
            ])
        else:
            self.char = random.choice(["♥", "✨", "🌸", "⭐", "✦"])
            self.color = random.choice([
                QColor("#EC4899"),
                QColor("#F472B6"),
                QColor("#FBBF24"),
                QColor("#818CF8"),
                QColor("#38BDF8"),
            ])

    def update(self, dt: float) -> bool:
        self.x += self.vx * dt
        self.y += self.vy * dt
        self.alpha -= 1.25 * dt
        return self.alpha > 0.0


class SpriteLibrary:
    """Lazy-loading, low-memory 120-frame WebP sprite-sheet & static avatar store."""

    def __init__(self, assets_dir: Path) -> None:
        self.assets_dir = assets_dir
        self.actions: Dict[str, dict] = {}
        self.avatars: Dict[str, QPixmap] = {}
        self._load_index()

    def _load_index(self) -> None:
        dyn_dir = self.assets_dir / "dynamic_actions"
        for key, info in ACTION_DEFS.items():
            jp = dyn_dir / f"{info['file']}.json"
            wp = dyn_dir / f"{info['file']}.webp"
            if not (jp.is_file() and wp.is_file()):
                continue
            try:
                meta = json.loads(jp.read_text(encoding="utf-8"))
                self.actions[key] = {
                    "meta": meta,
                    "webp_path": wp,
                    "pixmap": None,
                    "is_downscaled": False,
                    "frame_w": int(meta.get("FrameWidth") or 640),
                    "frame_h": int(meta.get("FrameHeight") or 360),
                    "columns": int(meta.get("Columns") or 8),
                    "rows": int(meta.get("Rows") or 15),
                    "count": int(meta.get("FrameCount") or 120),
                    "base_fps": float(meta.get("SampleFps") or 12),
                    "loop": bool(info["loop"]),
                    "title": info["title"],
                    "category": info["category"],
                }
            except Exception:
                continue

        self.ensure_loaded("idle")

    def ensure_loaded(self, key: str) -> bool:
        act = self.actions.get(key)
        if not act:
            return False
        pix = act.get("pixmap")
        if pix is not None and not pix.isNull():
            return True

        wp: Path = act["webp_path"]
        if not wp.is_file():
            return False

        reader = QImageReader(str(wp))
        orig_sz = reader.size()
        if orig_sz.isValid() and orig_sz.width() >= 2000:
            reader.setScaledSize(QSize(orig_sz.width() // 2, orig_sz.height() // 2))
            img = reader.read()
            if not img.isNull():
                act["pixmap"] = QPixmap.fromImage(img)
                act["is_downscaled"] = True
                return True

        direct = QPixmap(str(wp))
        if not direct.isNull():
            act["pixmap"] = direct
            act["is_downscaled"] = False
            return True
        return False

    def get_avatar(self, key: str) -> Optional[QPixmap]:
        fname = STATIC_AVATAR_FILES.get(key, "avatar_default.png")
        if fname in self.avatars:
            return self.avatars[fname]
        p = self.assets_dir / "avatars" / fname
        if not p.is_file():
            return None
        pix = QPixmap(str(p))
        if not pix.isNull():
            self.avatars[fname] = pix
            return pix
        return None

    def evict_unused(self, active_key: str) -> None:
        if active_key != "idle":
            return
        freed = False
        for key, act in self.actions.items():
            if key != "idle" and act.get("pixmap") is not None:
                act["pixmap"] = None
                freed = True
        if freed:
            gc.collect()
            if sys.platform == "win32":
                try:
                    ctypes.windll.psapi.EmptyWorkingSet(ctypes.windll.kernel32.GetCurrentProcess())
                except Exception:
                    pass


def _read_step_status_from_blob(blob: bytes) -> Optional[int]:
    if not blob:
        return None
    pos = 0
    length = len(blob)
    while pos < length:
        tag = 0
        shift = 0
        while pos < length:
            b = blob[pos]
            pos += 1
            tag |= (b & 0x7F) << shift
            if not (b & 0x80):
                break
            shift += 7
            if shift > 35:
                return None
        field = tag >> 3
        wire = tag & 7
        if wire == 0:
            val = 0
            shift = 0
            while pos < length:
                b = blob[pos]
                pos += 1
                val |= (b & 0x7F) << shift
                if not (b & 0x80):
                    break
                shift += 7
                if shift > 35:
                    return None
            if field == 4:
                return val
        elif wire == 2:
            slen = 0
            shift = 0
            while pos < length:
                b = blob[pos]
                pos += 1
                slen |= (b & 0x7F) << shift
                if not (b & 0x80):
                    break
                shift += 7
                if shift > 35:
                    return None
            if slen < 0 or pos + slen > length:
                break
            pos += slen
        elif wire == 1:
            pos += 8
        elif wire == 5:
            pos += 4
        else:
            break
    return None


def _unwrap_arg(val):
    if val is None:
        return ""
    if not isinstance(val, str):
        return val
    s = val.strip()
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("{") and s.endswith("}")):
        try:
            return json.loads(s)
        except Exception:
            return s
    return s


def _needs_feedback_approval(tc: dict) -> Optional[tuple[bool, str, str]]:
    if not isinstance(tc, dict):
        return None
    name = str(tc.get("name") or "")
    args = tc.get("args")
    if not isinstance(args, dict):
        return None
    if name == "ask_question":
        return True, name, "等待你选择确认"
    bypass = _unwrap_arg(args.get("BypassSandbox"))
    if bypass is True or str(bypass).lower() == "true":
        return False, name or "run_command", "沙盒外命令授权"
    art_meta = _unwrap_arg(args.get("ArtifactMetadata"))
    if isinstance(art_meta, dict) and art_meta.get("RequestFeedback") is True:
        return False, name or "write_file", "待你确认计划"
    return None


class SyncWorker(QObject):
    """Syncs with Antigravity Sidecar SSE, with automatic transcript.jsonl + SQLite fallback."""

    state_received = Signal(dict)
    fallback_activity = Signal(dict)
    connection_changed = Signal(bool, str)

    def __init__(self, server_url: str = "", token: str = "") -> None:
        super().__init__()
        self._explicit_server = server_url.rstrip("/") if server_url else ""
        self._explicit_token = token
        self._active_server = self._explicit_server
        self._active_token = self._explicit_token
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

        self._runtime_paths = [
            Path.home() / ".antigravity-hagemi-pet" / "runtime.json",
        ]
        if os.environ.get("PLUGIN_DATA"):
            self._runtime_paths.insert(0, Path(os.environ["PLUGIN_DATA"]) / "runtime.json")

        self._brain_roots = [
            Path.home() / ".gemini" / "antigravity" / "brain",
            Path.home() / ".gemini" / "antigravity-ide" / "brain",
            Path.home() / ".gemini" / "antigravity-cli" / "brain",
        ]
        self._conv_roots = list({r.parent / "conversations" for r in self._brain_roots})
        self._offsets: Dict[Path, int] = {}
        self._buffers: Dict[Path, str] = {}
        self._primary_convs: set[Path] = set()
        self._primary_conv_ids: set[str] = set()
        self._tracked_files: set[Path] = set()
        self._db_stamps: Dict[Path, tuple[float, int, float, int]] = {}
        self._db_schema: Dict[Path, tuple[Optional[str], Optional[str]]] = {}
        self._last_tool_by_conv: Dict[str, tuple[str, str]] = {}
        self._waiting_convs: Dict[str, str] = {}
        self._pending_auth_deadline: Dict[str, tuple[float, str, str]] = {}
        self._seeded = False
        self._last_scan = 0.0
        self._last_db_poll = 0.0

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def post_action(self, payload: dict) -> None:
        server = self._active_server
        if not server:
            return
        token = self._active_token

        def _send() -> None:
            url = f"{server}/api/action"
            if token:
                url += f"?token={token}"
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            if token:
                req.add_header("X-Sidecar-Token", token)
            try:
                with urllib.request.urlopen(req, timeout=2.5) as resp:
                    resp.read()
            except Exception:
                pass

        threading.Thread(target=_send, daemon=True).start()

    def _discover_sidecar(self) -> tuple[str, str]:
        if self._explicit_server:
            if self._check_health(self._explicit_server):
                return self._explicit_server, self._explicit_token
            return "", ""

        for rp in self._runtime_paths:
            if not rp.is_file():
                continue
            try:
                meta = json.loads(rp.read_text(encoding="utf-8"))
                port = int(meta.get("port") or 0)
                pid = int(meta.get("pid") or 0)
                token = str(meta.get("uiToken") or "")
                if port > 0 and (pid <= 0 or _is_pid_alive(pid)):
                    url = f"http://127.0.0.1:{port}"
                    if self._check_health(url):
                        return url, token
            except Exception:
                continue
        return "", ""

    @staticmethod
    def _check_health(base_url: str) -> bool:
        try:
            with urllib.request.urlopen(f"{base_url}/api/health", timeout=1.2) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8", errors="ignore"))
                    return bool(data.get("ok"))
        except Exception:
            return False
        return False

    def _run(self) -> None:
        while not self._stop.is_set():
            server, token = self._discover_sidecar()
            if server:
                self._active_server = server
                self._active_token = token
                self.connection_changed.emit(True, "Sidecar SSE 已联动")
                self._stream_sse(server, token)
                self._active_server = ""
                self.connection_changed.emit(False, "切换至本地日志直连")
            else:
                self._active_server = ""
                self.connection_changed.emit(False, "本地 transcript.jsonl 监听中")
                self._fallback_loop(duration=4.0)

    def _stream_sse(self, server: str, token: str) -> None:
        url = f"{server}/api/events"
        if token:
            url += f"?token={token}"
        req = urllib.request.Request(url, headers={"Accept": "text/event-stream"})
        if token:
            req.add_header("X-Sidecar-Token", token)
        try:
            with urllib.request.urlopen(req, timeout=35) as resp:
                while not self._stop.is_set():
                    raw_line = resp.readline()
                    if not raw_line:
                        break
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if line.startswith("data:"):
                        payload_str = line[5:].strip()
                        try:
                            msg = json.loads(payload_str)
                            if isinstance(msg, dict) and isinstance(msg.get("data"), dict):
                                self.state_received.emit(msg["data"])
                        except Exception:
                            continue
        except Exception:
            if not self._stop.is_set():
                self._stop.wait(1.0)

    def _discover_transcripts(self) -> set[Path]:
        found: set[Path] = set()
        for root in self._brain_roots:
            if not root.is_dir():
                continue
            try:
                for entry in root.iterdir():
                    if not entry.is_dir():
                        continue
                    tfile = entry / ".system_generated" / "logs" / "transcript.jsonl"
                    if tfile.is_file():
                        found.add(tfile)
            except OSError:
                continue
        return found

    def _is_primary(self, path: Path) -> bool:
        if path in self._primary_convs:
            return True
        try:
            with path.open("rb") as f:
                head = f.read(16384).decode("utf-8", errors="ignore")
            if '"USER_EXPLICIT"' in head:
                self._primary_convs.add(path)
                self._primary_conv_ids.add(path.parent.parent.parent.name)
                return True
        except OSError:
            pass
        return False

    def _emit_waiting_auth(self, conv_id: str, tool: str, detail: str, origin: str = "transcript") -> None:
        self._pending_auth_deadline.pop(conv_id, None)
        if conv_id in self._waiting_convs:
            return
        self._waiting_convs[conv_id] = origin
        self.fallback_activity.emit({
            "event": "WaitingAuth",
            "origin": origin,
            "tool": tool,
            "detail": detail or "等待你的授权确认",
            "tokens": 0,
        })

    def _resolve_waiting_auth(self, conv_id: str, origin: str = "transcript") -> None:
        self._pending_auth_deadline.pop(conv_id, None)
        if conv_id not in self._waiting_convs:
            return
        self._waiting_convs.pop(conv_id, None)
        self.fallback_activity.emit({
            "event": "AuthResolved",
            "origin": origin,
            "tokens": 0,
        })

    def _poll_databases(self, now: float) -> None:
        for conv_root in self._conv_roots:
            if not conv_root.is_dir():
                continue
            try:
                db_files = list(conv_root.glob("*.db"))
            except OSError:
                continue
            for db_path in db_files:
                conv_id = db_path.stem
                if self._primary_conv_ids and conv_id not in self._primary_conv_ids:
                    continue
                try:
                    st = db_path.stat()
                except OSError:
                    continue
                wal_path = Path(f"{db_path}-wal")
                wal_mtime, wal_size = 0.0, 0
                try:
                    wst = wal_path.stat()
                    wal_mtime, wal_size = wst.st_mtime, wst.st_size
                except OSError:
                    pass
                newest = max(st.st_mtime, wal_mtime)
                if now - newest > 90.0 and conv_id not in self._waiting_convs:
                    continue
                stamp = (st.st_mtime, st.st_size, wal_mtime, wal_size)
                if self._db_stamps.get(db_path) == stamp:
                    continue
                self._db_stamps[db_path] = stamp
                self._inspect_db_waiting(db_path, conv_id)

    def _inspect_db_waiting(self, db_path: Path, conv_id: str) -> None:
        conn = None
        try:
            uri = f"file:{db_path.as_posix()}?mode=ro"
            conn = sqlite3.connect(uri, uri=True, timeout=0.3)
            schema = self._db_schema.get(db_path)
            if schema is None:
                cols = [str(r[1]) for r in conn.execute("PRAGMA table_info(steps)").fetchall()]
                status_col = next((c for c in cols if c in ("status", "step_status")), None)
                blob_col = next((c for c in cols if c in ("data", "step", "payload")), None)
                schema = (status_col, blob_col)
                self._db_schema[db_path] = schema
            status_col, blob_col = schema
            if not status_col and not blob_col:
                return
            sel = ", ".join(c for c in ("idx", status_col, blob_col) if c)
            rows = conn.execute(f"SELECT {sel} FROM steps ORDER BY idx DESC LIMIT 5").fetchall()
            is_waiting = False
            for row in rows:
                offset = 1
                if status_col:
                    st_val = row[offset]
                    offset += 1
                    if st_val == 9 or str(st_val or "").upper() in WAITING_STATUSES:
                        is_waiting = True
                        break
                if blob_col:
                    blob_val = row[offset]
                    if isinstance(blob_val, (bytes, bytearray, memoryview)):
                        if _read_step_status_from_blob(bytes(blob_val)) == 9:
                            is_waiting = True
                            break
            if is_waiting:
                tool, detail = self._last_tool_by_conv.get(conv_id, ("", "等待你的授权确认"))
                self._emit_waiting_auth(conv_id, tool, detail, origin="db")
            elif self._waiting_convs.get(conv_id) == "db":
                self._resolve_waiting_auth(conv_id, origin="db")
        except Exception:
            pass
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    def _seed_transcripts(self) -> None:
        files = self._discover_transcripts()
        this_files = files
        self._tracked_files = this_files
        for p in this_files:
            try:
                self._offsets[p] = p.stat().st_size
                self._buffers[p] = ""
                self._is_primary(p)
            except OSError:
                continue
        self._seeded = True
        self._last_scan = time.time()

    def _fallback_loop(self, duration: float) -> None:
        if not self._seeded:
            self._seed_transcripts()
        end_at = time.time() + duration
        while not self._stop.is_set() and time.time() < end_at:
            now = time.time()
            if now - self._last_scan >= 1.5:
                self._last_scan = now
                cur = self._discover_transcripts()
                for np in cur - self._tracked_files:
                    self._offsets[np] = 0
                    self._buffers[np] = ""
                self._tracked_files = cur

            for p in list(self._tracked_files):
                try:
                    size = p.stat().st_size
                except OSError:
                    continue
                prev = self._offsets.get(p, 0)
                if size < prev:
                    prev = 0
                    self._buffers[p] = ""
                if size > prev:
                    self._read_new_lines(p, prev, size)

            for cid, (deadline, tool, detail) in list(self._pending_auth_deadline.items()):
                if now >= deadline:
                    self._emit_waiting_auth(cid, tool, detail, origin="transcript")

            if now - self._last_db_poll >= 0.6:
                self._last_db_poll = now
                self._poll_databases(now)

            self._stop.wait(0.35)

    def _read_new_lines(self, path: Path, start: int, end: int) -> None:
        try:
            with path.open("rb") as f:
                f.seek(start)
                chunk = f.read(end - start)
        except OSError:
            return
        self._offsets[path] = start + len(chunk)
        text = self._buffers.get(path, "") + chunk.decode("utf-8", errors="replace")
        lines = text.split("\n")
        self._buffers[path] = lines[-1]
        is_primary = self._is_primary(path)
        conv_id = path.parent.parent.parent.name
        for raw in lines[:-1]:
            s = raw.strip()
            if not s:
                continue
            try:
                obj = json.loads(s)
            except Exception:
                continue
            if not isinstance(obj, dict):
                continue
            if obj.get("source") == "USER_EXPLICIT":
                self._primary_convs.add(path)
                self._primary_conv_ids.add(conv_id)
                is_primary = True
            self._emit_step(obj, is_primary, conv_id)

    def _emit_step(self, obj: dict, is_primary: bool, conv_id: str = "") -> None:
        step_type = str(obj.get("type") or "")
        source = str(obj.get("source") or "")
        status = str(obj.get("status") or "")
        tokens = sum(
            int(obj[k])
            for k in ("input_tokens", "output_tokens", "cache_read_tokens")
            if isinstance(obj.get(k), (int, float)) and obj[k] > 0
        )

        if not is_primary:
            if step_type == "PLANNER_RESPONSE" and (obj.get("tool_calls") or []):
                tc = obj["tool_calls"][-1] or {}
                self.fallback_activity.emit({
                    "event": "ToolStart",
                    "origin": "subagent",
                    "tool": str(tc.get("name") or "subagent"),
                    "tokens": tokens,
                })
            return

        if status.upper() in WAITING_STATUSES:
            tcs = obj.get("tool_calls") or []
            last_tc = tcs[-1] if tcs and isinstance(tcs[-1], dict) else None
            tool = str(last_tc.get("name") or "") if last_tc else self._last_tool_by_conv.get(conv_id, ("", ""))[0]
            self._emit_waiting_auth(conv_id, tool, "等待你的授权确认", origin="transcript")
            return

        if step_type == "USER_INPUT" and source == "USER_EXPLICIT":
            self._resolve_waiting_auth(conv_id, origin="transcript")
            m = _USER_REQ_RE.search(str(obj.get("content") or ""))
            raw = m.group(1) if m else str(obj.get("content") or "")
            prompt = " ".join(raw.strip().split())[:24]
            self.fallback_activity.emit({"event": "Thinking", "prompt": prompt, "tokens": 0})
        elif step_type == "PLANNER_RESPONSE":
            tcs = obj.get("tool_calls") or []
            content = str(obj.get("content") or "").strip()
            if status == "ERROR":
                self._pending_auth_deadline.pop(conv_id, None)
                self.fallback_activity.emit({"event": "Error", "tokens": tokens})
            elif tcs:
                tc = tcs[-1] if isinstance(tcs[-1], dict) else {}
                tool_name = str(tc.get("name") or "tool")
                self._last_tool_by_conv[conv_id] = (tool_name, "")
                self.fallback_activity.emit({
                    "event": "ToolStart",
                    "origin": "transcript",
                    "tool": tool_name,
                    "tokens": tokens,
                })
                for call in tcs:
                    sig = _needs_feedback_approval(call)
                    if sig:
                        immediate, sig_tool, sig_detail = sig
                        if immediate:
                            self._emit_waiting_auth(conv_id, sig_tool, sig_detail, origin="transcript")
                        else:
                            self._pending_auth_deadline[conv_id] = (time.time() + 0.65, sig_tool, sig_detail)
                        break
            elif content and status == "DONE":
                self._resolve_waiting_auth(conv_id, origin="transcript")
                self.fallback_activity.emit({"event": "TurnComplete", "tokens": tokens})
            else:
                self.fallback_activity.emit({"event": "Thinking", "tokens": tokens})
        elif step_type == "GENERIC":
            if self._waiting_convs.get(conv_id) == "transcript":
                self._resolve_waiting_auth(conv_id, origin="transcript")
            else:
                self._pending_auth_deadline.pop(conv_id, None)
            content = str(obj.get("content") or "")
            m = _EXIT_CODE_RE.search(content)
            has_err = (status == "ERROR") or (m is not None and m.group(1) != "0")
            self.fallback_activity.emit({"event": "ToolError" if has_err else "Thinking", "tokens": 0})


class HagemiDesktopPet(QWidget):
    """Frameless transparent always-on-top 哈Gemi desktop companion."""

    def __init__(
        self,
        assets_dir: Path,
        server_url: str = "",
        token: str = "",
        owner_pid: int = 0,
        scale: float = 1.0,
    ) -> None:
        super().__init__()
        self.assets_dir = assets_dir
        self.owner_pid = owner_pid
        self.lib = SpriteLibrary(assets_dir)

        self.pet_scale = max(0.65, min(1.8, scale))
        self.fps = 14
        self.render_mode = "dynamic"
        self.show_bubbles = True
        self.always_on_top = True

        self.state = "idle"
        self.action_key = "idle"
        self.loop = True
        self.frame_idx = 0
        self.frame_accum = 0.0
        self.server_seq = 0
        self.state_until = 0.0

        self.bubble_text = "哈Gemi 登陆桌面啦喵~ 随时盯紧你的 Antigravity！"
        self.bubble_until = time.time() + 6.0
        self.bubble_alpha = 1.0
        self.status_badge = "Antigravity · 待命中"
        self.total_tokens = 0
        self.sidecar_connected = False

        # 60 FPS physics
        self.t = 0.0
        self.scale_x = 1.0
        self.scale_y = 1.0
        self.vel_sx = 0.0
        self.vel_sy = 0.0
        self.tilt_deg = 0.0
        self._next_auth_nudge = 0.0
        self.particles: List[FloatingParticle] = []

        # Drag + Throw physics
        self._dragging = False
        self._drag_moved = False
        self._drag_offset = QPoint()
        self._drag_samples: List[tuple[float, float, float]] = []
        self._last_pointer_x = 0.0
        self._drag_vx = 0.0
        self._thrown = False
        self._phys_x = 0.0
        self._phys_y = 0.0
        self._phys_vx = 0.0
        self._phys_vy = 0.0

        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground, True)
        self.setMouseTracking(True)
        self._apply_window_flags()
        self._resize_for_scale()
        self._place_bottom_right()

        self._setup_tray()

        self.sync = SyncWorker(server_url=server_url, token=token)
        self.sync.state_received.connect(self._on_server_state)
        self.sync.fallback_activity.connect(self._on_fallback_activity)
        self.sync.connection_changed.connect(self._on_connection_changed)
        self.sync.start()

        self._last_tick = time.perf_counter()
        self.timer = QTimer(self)
        self.timer.timeout.connect(self._tick)
        self.timer.start(16)

        self.evict_timer = QTimer(self)
        self.evict_timer.setSingleShot(True)
        self.evict_timer.setInterval(15000)
        self.evict_timer.timeout.connect(lambda: self.lib.evict_unused(self.action_key))
        self.evict_timer.start()

        if self.owner_pid > 0:
            self.owner_timer = QTimer(self)
            self.owner_timer.timeout.connect(self._check_owner_alive)
            self.owner_timer.start(2500)

    def _apply_window_flags(self) -> None:
        flags = Qt.WindowType.FramelessWindowHint | Qt.WindowType.Tool
        if self.always_on_top:
            flags |= Qt.WindowType.WindowStaysOnTopHint
        was_visible = self.isVisible()
        self.setWindowFlags(flags)
        if was_visible:
            self.show()

    def _resize_for_scale(self) -> None:
        self.setFixedSize(int(310 * self.pet_scale), int(330 * self.pet_scale))

    def _place_bottom_right(self) -> None:
        screen = QApplication.primaryScreen()
        if screen:
            geo = screen.availableGeometry()
            x = geo.right() - self.width() - 28
            y = geo.bottom() - self.height() - 14
            self.move(x, y)

    def _setup_tray(self) -> None:
        logo_path = self.assets_dir / "logo.png"
        icon = QIcon(str(logo_path)) if logo_path.is_file() else QIcon()
        self.tray = QSystemTrayIcon(icon, self)
        self.tray.setToolTip("哈Gemi 桌面萌宠 · Antigravity")
        menu = QMenu()
        menu.addAction("🏠 呼唤哈Gemi 归位").triggered.connect(self._summon_home)
        menu.addAction("🍚 投喂 Token").triggered.connect(self._feed_token)
        menu.addSeparator()
        menu.addAction("👋 关闭桌面悬浮窗").triggered.connect(self._quit_app)
        self.tray.setContextMenu(menu)
        self.tray.activated.connect(
            lambda reason: self._summon_home() if reason == QSystemTrayIcon.ActivationReason.DoubleClick else None
        )
        self.tray.show()

    def _check_owner_alive(self) -> None:
        if self.owner_pid > 0 and not _is_pid_alive(self.owner_pid):
            self._quit_app()

    def _summon_home(self) -> None:
        self._thrown = False
        self._place_bottom_right()
        self.show()
        self.raise_()
        self._set_action_local("happy", "心情超好 · 跃动中", "哈Gemi 闪现归位喵~", loop=False, duration=4.0)

    def _feed_token(self) -> None:
        self._spawn_particles(10)
        self._trigger_squish(0.20)
        if self.sidecar_connected:
            self.sync.post_action({"type": "feed"})
        else:
            self._set_action_local(
                "happy",
                "投喂中 · 炫 Token",
                "啊呜啊呜~ 投喂高质量 Token 最幸福啦喵✨",
                loop=False,
                duration=4.5,
            )

    def _quit_app(self) -> None:
        self.sync.stop()
        self.tray.hide()
        QApplication.quit()

    def _trigger_squish(self, strength: float = 0.16) -> None:
        self.vel_sx += strength * 14.0
        self.vel_sy -= strength * 14.0

    def _spawn_particles(self, count: int = 7, alert: bool = False) -> None:
        cx = self.width() * 0.5
        cy = self.height() * 0.42
        for _ in range(count):
            self.particles.append(FloatingParticle(cx, cy, alert=alert))

    def _set_action_local(
        self,
        action_key: str,
        badge: str = "",
        bubble: str = "",
        loop: Optional[bool] = None,
        duration: float = 0.0,
    ) -> None:
        if action_key not in self.lib.actions:
            action_key = "idle"
        self.lib.ensure_loaded(action_key)
        self.action_key = action_key
        defn = ACTION_DEFS.get(action_key, ACTION_DEFS["idle"])
        self.state = defn["category"]
        self.loop = defn["loop"] if loop is None else loop
        self.frame_idx = 0
        self.frame_accum = 0.0
        self.state_until = (time.time() + duration) if duration > 0 else 0.0
        if badge:
            self.status_badge = badge
        if bubble:
            self.bubble_text = bubble
            self.bubble_until = time.time() + max(4.2, duration)
        if action_key == "happy":
            self._spawn_particles(7)
            self._trigger_squish(0.18)
        elif action_key == "shocked":
            self._trigger_squish(0.20)

        if action_key == "idle":
            self.evict_timer.start(15000)
        else:
            self.evict_timer.stop()

    def _on_connection_changed(self, connected: bool, _msg: str) -> None:
        self.sidecar_connected = connected

    def _on_server_state(self, snap: dict) -> None:
        stats = snap.get("stats") or {}
        if isinstance(stats.get("tokens"), int):
            self.total_tokens = stats["tokens"]

        prefs = snap.get("preferences") or {}
        if prefs:
            self.fps = max(8, min(24, int(prefs.get("fps") or self.fps)))
            mode = prefs.get("renderMode")
            if mode in ("dynamic", "static"):
                self.render_mode = mode
            if isinstance(prefs.get("showBubbles"), bool):
                self.show_bubbles = prefs["showBubbles"]

        seq = int(snap.get("seq") or 0)
        if seq != self.server_seq and not self._dragging:
            self.server_seq = seq
            action = str(snap.get("action") or "idle")
            if action not in self.lib.actions:
                action = "idle"
            self.lib.ensure_loaded(action)
            self.state = str(snap.get("state") or "idle")
            self.action_key = action
            self.loop = bool(snap.get("loop", True))
            self.frame_idx = 0
            self.frame_accum = 0.0
            exp_ms = int(snap.get("stateExpiresAt") or 0)
            self.state_until = (exp_ms / 1000.0) if exp_ms > 0 else 0.0
            if self.state == "awaiting_auth":
                self.raise_()
                self._spawn_particles(6, alert=True)
                self._trigger_squish(0.16)
                self._next_auth_nudge = time.perf_counter() + 2.6
            elif action == "happy":
                self._spawn_particles(7)
                self._trigger_squish(0.18)
            elif action == "shocked":
                self._trigger_squish(0.20)
            if action == "idle":
                self.evict_timer.start(15000)
            else:
                self.evict_timer.stop()

        if snap.get("badge"):
            self.status_badge = str(snap["badge"])
        if snap.get("bubble"):
            self.bubble_text = str(snap["bubble"])
            b_until = int(snap.get("bubbleUntil") or 0)
            self.bubble_until = (b_until / 1000.0) if b_until > 0 else (time.time() + 5.0)

    def _on_fallback_activity(self, payload: dict) -> None:
        if self.sidecar_connected:
            return
        tokens = int(payload.get("tokens") or 0)
        if tokens > 0:
            self.total_tokens += tokens

        ev = str(payload.get("event") or "")
        if ev == "WaitingAuth":
            tool = str(payload.get("tool") or "")
            detail = str(payload.get("detail") or "")
            cn = TOOL_FRIENDLY_NAMES.get(tool, tool or "")
            if tool == "ask_question":
                bubble = "主人！哈Gemi 有问题需要你确认喵~ 🔐"
            elif cn:
                bubble = f"主人！需要你授权 {cn} 才能继续喵~ 🔐"
            else:
                bubble = "主人！Antigravity 正在等你点击授权喵~ 🔐"
            badge = f"请授权 · {cn}" if cn else "Antigravity · 等待授权"
            self._set_action_local("happy", badge, bubble, loop=True, duration=600.0)
            self.state = "awaiting_auth"
            self.raise_()
            self._spawn_particles(6, alert=True)
            self._next_auth_nudge = time.perf_counter() + 2.6
        elif ev == "AuthResolved":
            if self.state == "awaiting_auth":
                self._set_action_local("thinking", "Antigravity · 继续执行", "收到授权！哈Gemi 继续干活喵~", loop=True, duration=60.0)
        elif ev == "Thinking":
            prompt = str(payload.get("prompt") or "")
            bubble = f"收到指令！思考冒泡中…\n「{prompt}」" if prompt else "哈Gemi 深度思考冒泡中喵…"
            self._set_action_local("thinking", "Antigravity · 深度思考中", bubble, loop=True, duration=120.0)
        elif ev == "ToolStart":
            tool = str(payload.get("tool") or "")
            cn = TOOL_FRIENDLY_NAMES.get(tool, tool or "工具")
            act = "coding" if tool in CODING_TOOLS else "thinking"
            prefix = "分身" if payload.get("origin") == "subagent" else "正在"
            self._set_action_local(act, f"工作中 · {cn}", f"{prefix}执行 {cn}…", loop=True, duration=90.0)
        elif ev in ("ToolError", "Error"):
            self._set_action_local("shocked", "Antigravity · 报错提醒", "吓了一跳！刚才执行报错啦喵！", loop=False, duration=8.0)
        elif ev == "TurnComplete":
            note = f"（+{_fmt_tokens(tokens)} Tok）" if tokens > 0 else ""
            self._set_action_local("happy", "Antigravity · 回复完成", f"搞定啦！快来看看结果喵~ {note}", loop=False, duration=8.0)

    def _return_to_idle(self) -> None:
        self.state = "idle"
        self.action_key = "idle"
        self.loop = True
        self.state_until = 0.0
        self.frame_idx = 0
        self.status_badge = (
            f"待命中 · 已炫 {_fmt_tokens(self.total_tokens)} Tok"
            if self.total_tokens > 0
            else "Antigravity · 待命中"
        )
        self.evict_timer.start(15000)

    def _tick(self) -> None:
        now = time.perf_counter()
        dt = min(0.05, max(0.001, now - self._last_tick))
        self._last_tick = now
        self.t += dt
        wall_now = time.time()

        act = self.lib.actions.get(self.action_key)
        if self.render_mode == "dynamic" and act:
            frame_dur = 1.0 / max(6, self.fps)
            self.frame_accum += dt
            while self.frame_accum >= frame_dur:
                self.frame_accum -= frame_dur
                self.frame_idx += 1
                if self.frame_idx >= act["count"]:
                    if self.loop or self._dragging:
                        self.frame_idx = 0
                    else:
                        self._return_to_idle()
                        break

        if self.state_until > 0 and wall_now >= self.state_until and not self._dragging:
            self._return_to_idle()

        # Spring squish physics
        stiffness, damping = 185.0, 12.5
        ax = (1.0 - self.scale_x) * stiffness - self.vel_sx * damping
        ay = (1.0 - self.scale_y) * stiffness - self.vel_sy * damping
        self.vel_sx += ax * dt
        self.vel_sy += ay * dt
        self.scale_x = max(0.76, min(1.26, self.scale_x + self.vel_sx * dt))
        self.scale_y = max(0.76, min(1.26, self.scale_y + self.vel_sy * dt))

        # Drag tilt / gentle breathing
        if self._dragging and self._drag_moved:
            target_tilt = max(-22.0, min(22.0, -self._drag_vx * 0.7))
            self._drag_vx *= 0.84
        else:
            target_tilt = math.sin(self.t * 1.6) * 1.1
        self.tilt_deg += (target_tilt - self.tilt_deg) * min(1.0, dt * 12.0)

        # Throw physics with screen-edge bounce
        if self._thrown:
            screen = QApplication.screenAt(self.frameGeometry().center()) or QApplication.primaryScreen()
            if screen:
                geo = screen.availableGeometry()
                self._phys_vy += 1450.0 * dt
                self._phys_x += self._phys_vx * dt
                self._phys_y += self._phys_vy * dt

                bounced = False
                if self._phys_x < geo.left():
                    self._phys_x = float(geo.left())
                    self._phys_vx = abs(self._phys_vx) * 0.65
                    bounced = True
                elif self._phys_x + self.width() > geo.right():
                    self._phys_x = float(geo.right() - self.width())
                    self._phys_vx = -abs(self._phys_vx) * 0.65
                    bounced = True

                if self._phys_y < geo.top():
                    self._phys_y = float(geo.top())
                    self._phys_vy = abs(self._phys_vy) * 0.6
                    bounced = True

                floor_y = float(geo.bottom() - self.height() - 6)
                if self._phys_y >= floor_y:
                    self._phys_y = floor_y
                    if abs(self._phys_vy) > 220.0:
                        self._phys_vy = -abs(self._phys_vy) * 0.45
                        self._phys_vx *= 0.72
                        self._trigger_squish(0.22)
                    else:
                        self._thrown = False
                        self._trigger_squish(0.24)
                        self._set_action_local("idle", bubble="咚！安全着陆啦喵~", duration=2.8)

                if bounced:
                    self._trigger_squish(0.18)
                self.move(int(round(self._phys_x)), int(round(self._phys_y)))

        if self.state == "awaiting_auth" and not self._dragging and now >= self._next_auth_nudge:
            self._next_auth_nudge = now + 2.8
            self._trigger_squish(0.11)
            self._spawn_particles(3, alert=True)

        if self.particles:
            self.particles = [p for p in self.particles if p.update(dt)]

        target_alpha = 1.0 if (self.show_bubbles and wall_now < self.bubble_until) else 0.0
        self.bubble_alpha += (target_alpha - self.bubble_alpha) * min(1.0, dt * 10.0)
        self.update()

    def paintEvent(self, _event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
        painter.setRenderHint(QPainter.RenderHint.TextAntialiasing, True)

        w = float(self.width())
        h = float(self.height())
        cx = w * 0.5
        anchor_y = h - 38.0 * self.pet_scale

        breath = math.sin(self.t * 3.2) * 0.016 if not (self._dragging and self._drag_moved) else 0.04
        bx = 0.96 if (self._dragging and self._drag_moved) else (1.0 - breath * 0.6)
        by = 1.05 if (self._dragging and self._drag_moved) else (1.0 + breath)

        drawn = False
        if self.render_mode == "dynamic":
            act = self.lib.actions.get(self.action_key) or self.lib.actions.get("idle")
            if act and self.lib.ensure_loaded(self.action_key if self.action_key in self.lib.actions else "idle"):
                pix: QPixmap = act["pixmap"]
                if pix and not pix.isNull():
                    idx = self.frame_idx % act["count"]
                    col = idx % act["columns"]
                    row = idx // act["columns"]
                    is_ds = act.get("is_downscaled", False)
                    fw = act["frame_w"] // 2 if is_ds else act["frame_w"]
                    fh = act["frame_h"] // 2 if is_ds else act["frame_h"]
                    crop_x = int(fw * 110 / 640) if fw >= 260 else 0
                    crop_w = int(fw * 420 / 640) if fw >= 260 else fw
                    src_rect = QRect(col * fw + crop_x, row * fh, crop_w, fh)

                    target_h = 212.0 * self.pet_scale
                    target_w = target_h * (crop_w / max(1.0, float(fh)))

                    painter.save()
                    tf = QTransform()
                    tf.translate(cx, anchor_y)
                    tf.rotate(self.tilt_deg)
                    tf.scale(self.scale_x * bx, self.scale_y * by)
                    tf.translate(-cx, -anchor_y)
                    painter.setTransform(tf)
                    dst = QRectF(cx - target_w * 0.5, anchor_y - target_h, target_w, target_h)
                    painter.drawPixmap(dst, pix, QRectF(src_rect))
                    painter.restore()
                    drawn = True

        if not drawn:
            av_key = "awaiting_auth" if (self.state == "awaiting_auth" and not self._dragging) else self.action_key
            av = self.lib.get_avatar(av_key)
            if av and not av.isNull():
                target_h = 205.0 * self.pet_scale
                target_w = target_h * (av.width() / max(1.0, float(av.height())))
                painter.save()
                tf = QTransform()
                tf.translate(cx, anchor_y)
                tf.rotate(self.tilt_deg)
                tf.scale(self.scale_x * bx, self.scale_y * by)
                tf.translate(-cx, -anchor_y)
                painter.setTransform(tf)
                dst = QRectF(cx - target_w * 0.5, anchor_y - target_h, target_w, target_h)
                painter.drawPixmap(dst, av, QRectF(av.rect()))
                painter.restore()

        for p in self.particles:
            c = QColor(p.color)
            c.setAlpha(max(0, min(255, int(p.alpha * 255))))
            painter.setFont(QFont("Segoe UI Emoji", int(p.size)))
            painter.setPen(c)
            painter.drawText(QPointF(p.x, p.y), p.char)

        if self.status_badge:
            self._draw_status_pill(painter, cx, h - 18.0 * self.pet_scale, self.status_badge)

        if self.bubble_text and self.bubble_alpha > 0.02:
            self._draw_speech_bubble(
                painter, w, anchor_y - 214.0 * self.pet_scale, self.bubble_text, self.bubble_alpha
            )

        painter.end()

    def _draw_status_pill(self, painter: QPainter, cx: float, cy: float, text: str) -> None:
        font = QFont("Microsoft YaHei UI", 8)
        font.setBold(True)
        painter.setFont(font)
        fm = QFontMetrics(font)
        tw = fm.horizontalAdvance(text)
        th = fm.height()
        pw = min(self.width() - 16, tw + 26)
        ph = th + 8

        dot_color = QColor(STATE_COLORS.get(self.state, "#818CF8"))
        rect = QRectF(cx - pw * 0.5, cy - ph * 0.5, pw, ph)
        is_auth = self.state == "awaiting_auth"
        border_w = 1.9 if is_auth else 1.3
        painter.setPen(QPen(QColor(dot_color.red(), dot_color.green(), dot_color.blue(), 225 if is_auth else 195), border_w))
        painter.setBrush(QColor(15, 23, 42, 224))
        painter.drawRoundedRect(rect, ph * 0.5, ph * 0.5)

        pulse = 0.65 + 0.35 * math.sin(self.t * 6.0)
        dc = QColor(dot_color)
        dc.setAlpha(int(255 * pulse))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(dc)
        painter.drawEllipse(QPointF(rect.left() + 10.5, cy), 3.5, 3.5)

        painter.setPen(QColor("#F8FAFC"))
        painter.drawText(
            QRectF(rect.left() + 17, rect.top(), pw - 20, ph),
            Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft,
            text,
        )

    def _draw_speech_bubble(
        self, painter: QPainter, width: float, bottom_y: float, text: str, alpha: float
    ) -> None:
        painter.save()
        font = QFont("Microsoft YaHei UI", 9)
        font.setWeight(QFont.Weight.DemiBold)
        painter.setFont(font)

        max_w = int(width - 18)
        fm = QFontMetrics(font)
        bound = fm.boundingRect(0, 0, max_w - 22, 120, Qt.TextFlag.TextWordWrap, text)
        bw = max(76, min(max_w, bound.width() + 24))
        bh = max(30, bound.height() + 14)

        x = (width - bw) * 0.5
        y = max(4.0, bottom_y - bh)

        rect = QRectF(x, y, bw, bh)
        bg = QColor(15, 23, 42, int(236 * alpha))
        is_auth = self.state == "awaiting_auth"
        border = QColor(245, 158, 11, int(245 * alpha)) if is_auth else QColor(129, 140, 248, int(215 * alpha))
        border_w = 2.0 if is_auth else 1.5
        fg = QColor(248, 250, 252, int(255 * alpha))

        painter.setPen(QPen(border, border_w))
        painter.setBrush(bg)
        painter.drawRoundedRect(rect, 12, 12)

        cx = width * 0.5
        tri = QPainterPath()
        tri.moveTo(cx - 6, y + bh - 1)
        tri.lineTo(cx, y + bh + 6)
        tri.lineTo(cx + 6, y + bh - 1)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(bg)
        painter.drawPath(tri)
        painter.setPen(QPen(border, border_w))
        painter.drawLine(QPointF(cx - 6, y + bh), QPointF(cx, y + bh + 6))
        painter.drawLine(QPointF(cx, y + bh + 6), QPointF(cx + 6, y + bh))

        painter.setPen(fg)
        painter.drawText(
            QRectF(x + 11, y + 6, bw - 22, bh - 12),
            Qt.AlignmentFlag.AlignCenter | Qt.TextFlag.TextWordWrap,
            text,
        )
        painter.restore()

    # --- Mouse Interactions ---

    def mousePressEvent(self, event) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            self._dragging = True
            self._thrown = False
            self._drag_moved = False
            gpos = event.globalPosition()
            self._drag_offset = gpos.toPoint() - self.frameGeometry().topLeft()
            self._drag_samples = [(time.perf_counter(), gpos.x(), gpos.y())]
            self._last_pointer_x = gpos.x()
            self._drag_vx = 0.0
            event.accept()
        elif event.button() == Qt.MouseButton.RightButton:
            self._show_context_menu(event.globalPosition().toPoint())
            event.accept()

    def mouseMoveEvent(self, event) -> None:
        if not self._dragging:
            return
        gpos = event.globalPosition()
        new_pos = gpos.toPoint() - self._drag_offset
        now = time.perf_counter()
        self._drag_samples.append((now, gpos.x(), gpos.y()))
        self._drag_samples = [s for s in self._drag_samples if now - s[0] <= 0.12]
        self._drag_vx = gpos.x() - self._last_pointer_x
        self._last_pointer_x = gpos.x()

        if not self._drag_moved and (new_pos - self.pos()).manhattanLength() > 5:
            self._drag_moved = True
            self._set_action_local("dangling", "被拎起来啦！", "呜哇哇！快把哈Gemi 放下来喵~", loop=True)

        self.move(new_pos)
        event.accept()

    def mouseReleaseEvent(self, event) -> None:
        if event.button() == Qt.MouseButton.LeftButton and self._dragging:
            self._dragging = False
            if self._drag_moved:
                vx, vy = 0.0, 0.0
                if len(self._drag_samples) >= 2:
                    t0, x0, y0 = self._drag_samples[0]
                    t1, x1, y1 = self._drag_samples[-1]
                    dt = max(0.015, t1 - t0)
                    vx = max(-1400.0, min(1400.0, (x1 - x0) / dt))
                    vy = max(-1400.0, min(1400.0, (y1 - y0) / dt))

                if math.hypot(vx, vy) > 360.0:
                    self._thrown = True
                    self._phys_x = float(self.x())
                    self._phys_y = float(self.y())
                    self._phys_vx = vx * 0.78
                    self._phys_vy = vy * 0.78
                    self.bubble_text = "呀——哈Gemi 飞出去啦喵！！"
                    self.bubble_until = time.time() + 2.4
                else:
                    self._trigger_squish(0.20)
                    self._set_action_local("idle", bubble="安全着陆啦喵~", duration=2.5)
            else:
                self._trigger_squish(0.18)
                self._spawn_particles(7)
                if self.sidecar_connected:
                    self.sync.post_action({"type": "poke"})
                else:
                    self._set_action_local("happy", "互动 · 开心回应", random.choice(POKE_LINES), loop=False, duration=4.5)
            event.accept()

    def _show_context_menu(self, global_pos: QPoint) -> None:
        menu = QMenu(self)
        menu.setStyleSheet(
            """
            QMenu {
                background-color: #0F172A;
                color: #F8FAFC;
                border: 1px solid #6366F1;
                border-radius: 8px;
                padding: 5px;
                font-family: "Microsoft YaHei UI", "PingFang SC", sans-serif;
            }
            QMenu::item {
                padding: 6px 16px;
                border-radius: 5px;
            }
            QMenu::item:selected {
                background-color: #6366F1;
            }
            """
        )

        menu.addAction("🍚 投喂哈Gemi Token").triggered.connect(self._feed_token)
        menu.addAction("✨ 戳一戳哈Gemi").triggered.connect(
            lambda: self.sync.post_action({"type": "poke"})
            if self.sidecar_connected
            else self._set_action_local("happy", "互动 · 开心回应", random.choice(POKE_LINES), loop=False, duration=4.5)
        )

        sub_act = menu.addMenu("🎭 切换动作预览")
        for key, label in [
            ("idle", "😌 待机呼吸"),
            ("thinking", "💭 思考冒泡"),
            ("coding", "💻 疯狂写码"),
            ("happy", "✨ 开心跃动"),
            ("shocked", "⚡ 被吓一跳"),
            ("dangling", "🎀 悬空挣扎"),
            ("awaiting_auth", "🔐 等待授权"),
        ]:
            sub_act.addAction(label).triggered.connect(
                lambda _c=False, k=key: self._preview_action(k)
            )

        menu.addSeparator()

        act_mode = QAction("🎞️ 静态立绘模式", self, checkable=True)
        act_mode.setChecked(self.render_mode == "static")
        act_mode.triggered.connect(self._toggle_render_mode)
        menu.addAction(act_mode)

        sub_fps = menu.addMenu("⚡ 动画帧率")
        for f in (10, 14, 18, 24):
            a = QAction(f"{f} FPS", self, checkable=True)
            a.setChecked(self.fps == f)
            a.triggered.connect(lambda _c=False, val=f: self._set_fps(val))
            sub_fps.addAction(a)

        sub_scale = menu.addMenu("🔍 体型大小")
        for label, sc in [("迷你 (75%)", 0.75), ("标准 (100%)", 1.0), ("大号 (130%)", 1.3)]:
            a = QAction(label, self, checkable=True)
            a.setChecked(abs(self.pet_scale - sc) < 0.05)
            a.triggered.connect(lambda _c=False, s=sc: self._set_scale(s))
            sub_scale.addAction(a)

        act_top = QAction("📌 始终置顶显示", self, checkable=True)
        act_top.setChecked(self.always_on_top)
        act_top.triggered.connect(self._toggle_top)
        menu.addAction(act_top)

        act_bubble = QAction("💬 显示气泡台词", self, checkable=True)
        act_bubble.setChecked(self.show_bubbles)
        act_bubble.triggered.connect(self._toggle_bubbles)
        menu.addAction(act_bubble)

        menu.addAction("🏠 回到屏幕右下角").triggered.connect(self._summon_home)
        menu.addSeparator()
        menu.addAction("👋 关闭桌面悬浮窗").triggered.connect(self._quit_app)
        menu.exec(global_pos)

    def _preview_action(self, key: str) -> None:
        if self.sidecar_connected:
            self.sync.post_action({"type": "preview", "action": key})
        elif key == "awaiting_auth":
            self._set_action_local(
                "happy",
                "Antigravity · 等待授权",
                "主人！需要你点一下授权才能继续喵~ 🔐\n(示例：沙盒外命令执行确认)",
                loop=True,
                duration=12.0,
            )
            self.state = "awaiting_auth"
            self._spawn_particles(6, alert=True)
            self._next_auth_nudge = time.perf_counter() + 2.6
        else:
            self._set_action_local(key, bubble=f"预览动作：{ACTION_DEFS[key]['title']}~", duration=8.0)

    def _toggle_render_mode(self, static_checked: bool) -> None:
        self.render_mode = "static" if static_checked else "dynamic"
        if self.sidecar_connected:
            self.sync.post_action({"type": "preferences", "renderMode": self.render_mode})

    def _set_fps(self, fps: int) -> None:
        self.fps = fps
        if self.sidecar_connected:
            self.sync.post_action({"type": "preferences", "fps": fps})

    def _toggle_top(self, checked: bool) -> None:
        self.always_on_top = checked
        self._apply_window_flags()

    def _toggle_bubbles(self, checked: bool) -> None:
        self.show_bubbles = checked
        if self.sidecar_connected:
            self.sync.post_action({"type": "preferences", "showBubbles": checked})

    def _set_scale(self, scale: float) -> None:
        center = self.frameGeometry().center()
        self.pet_scale = scale
        self._resize_for_scale()
        self.move(center.x() - self.width() // 2, center.y() - self.height() // 2)
        self._trigger_squish(0.16)


def _acquire_single_instance_mutex() -> Optional[int]:
    if sys.platform != "win32":
        return None
    ERROR_ALREADY_EXISTS = 183
    handle = ctypes.windll.kernel32.CreateMutexW(None, False, "HaGemi_AgyPlugin_DesktopPet_v2")
    if ctypes.windll.kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
        if handle:
            ctypes.windll.kernel32.CloseHandle(handle)
        return 0
    return handle


def main() -> None:
    parser = argparse.ArgumentParser(description="哈Gemi 透明桌面悬浮窗")
    default_assets = Path(__file__).resolve().parents[1] / "assets"
    parser.add_argument("--assets-dir", default=str(default_assets))
    parser.add_argument("--server", default="")
    parser.add_argument("--token", default="")
    parser.add_argument("--owner-pid", type=int, default=0)
    parser.add_argument("--scale", type=float, default=1.0)
    parser.add_argument("--smoke-test", action="store_true")
    args = parser.parse_args()

    assets_dir = Path(args.assets_dir).expanduser().resolve()

    if args.smoke_test:
        QGuiApplication.setHighDpiScaleFactorRoundingPolicy(
            Qt.HighDpiScaleFactorRoundingPolicy.Round
        )
        app = QApplication(sys.argv)
        lib = SpriteLibrary(assets_dir)
        assert "idle" in lib.actions, "Missing idle action"
        assert lib.get_avatar("idle") is not None, "Missing idle avatar"
        print(f"SMOKE_OK actions={len(lib.actions)}")
        return

    mutex = _acquire_single_instance_mutex()
    if mutex == 0:
        sys.exit(0)

    QGuiApplication.setHighDpiScaleFactorRoundingPolicy(
        Qt.HighDpiScaleFactorRoundingPolicy.Round
    )
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)

    pet = HagemiDesktopPet(
        assets_dir=assets_dir,
        server_url=args.server,
        token=args.token,
        owner_pid=args.owner_pid,
        scale=args.scale,
    )
    pet.show()
    pet.raise_()

    code = app.exec()
    if sys.platform == "win32" and mutex:
        ctypes.windll.kernel32.CloseHandle(mutex)
    sys.exit(code)


if __name__ == "__main__":
    main()
