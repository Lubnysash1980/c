# gitcybrahash_double_backend.py
# © 2026 <Твоє Ім'я>
# Hardened Version with:
# - Safe event-loop handling (no asyncio.run crash)
# - Audio input validation
# - Additional self-tests
# - Improved JSON serialization safety

import os
import json
import time
import asyncio
import hashlib
import subprocess
from pathlib import Path
from collections import OrderedDict
from typing import Any, Dict, Tuple

HASH_FOLDER = "hash_storage"
HASH_GROUP_SIZE = 100
OWNER_ID = "OWNER_ONLY"
BATCH_SIZE = 10
MAX_HASH_MEMORY = 202

# ============================================================
# Utilities
# ============================================================

def _safe_json_dumps(obj: Any) -> bytes:
    """Deterministic JSON encoding."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def _double_sha256(data: bytes) -> str:
    first = hashlib.sha256(data).digest()
    return hashlib.sha256(first).hexdigest()


# ============================================================
# Double SHA-256 Workers
# ============================================================

async def double_hash_worker_async(info_dict: dict) -> Tuple[str, dict]:
    if not isinstance(info_dict, dict):
        raise TypeError("info_dict must be a dictionary")

    raw = _safe_json_dumps(info_dict)
    h = _double_sha256(raw)
    print("[DEBUG] double_hash_worker_async computed hash:", h)
    return h, info_dict


async def double_audio_hash_worker_async(audio_bytes: bytes, sample_rate: int = 44100) -> Tuple[str, dict]:
    # -------- FIX: input validation --------
    if audio_bytes is None:
        raise ValueError("audio_bytes cannot be None")

    if not isinstance(audio_bytes, (bytes, bytearray)):
        raise TypeError("audio_bytes must be bytes-like")

    if len(audio_bytes) == 0:
        raise ValueError("audio_bytes cannot be empty")

    if not isinstance(sample_rate, int) or not (8000 <= sample_rate <= 384000):
        raise ValueError("sample_rate must be an integer between 8000 and 384000")
    # ---------------------------------------

    h = _double_sha256(audio_bytes)

    meta = {
        "type": "audio",
        "sample_rate": sample_rate,
        "length_bytes": len(audio_bytes),
    }

    print("[DEBUG] double_audio_hash_worker_async computed audio hash:", h)
    return h, meta


# ============================================================
# RootHash
# ============================================================

class RootHash:
    def __init__(self):
        self.menu_index: "OrderedDict[str, Dict]" = OrderedDict()

    def add_entry(self, level: int, h: str, meta: dict):
        if len(self.menu_index) >= MAX_HASH_MEMORY:
            oldest_key = next(iter(self.menu_index))
            del self.menu_index[oldest_key]
            print("[DEBUG] Removed oldest hash to maintain memory limit:", oldest_key)

        self.menu_index[h] = {
            "level": level,
            "timestamp": time.time(),
            "meta": meta,
        }

    def build_root_hash(self) -> str:
        obj = _safe_json_dumps(self.menu_index)
        root = _double_sha256(obj)
        print("[DEBUG] Root hash computed:", root)
        return root

    def export(self) -> dict:
        return {
            "menu": dict(self.menu_index),
            "root_hash": self.build_root_hash(),
        }


# ============================================================
# Rule Engine
# ============================================================

class RuleEngine:
    def __init__(self, owner_id: str):
        self.owner_id = owner_id

    def authorize(self, requester_id: str) -> bool:
        return requester_id == self.owner_id

    def biometric_protection(self, meta: dict) -> bool:
        forbidden = {"fingerprint", "face", "iris"}
        return not any(k in meta for k in forbidden)

    def evolution_rule(self, stats: dict) -> dict:
        return {"version": stats.get("version", 1) + 1}


# ============================================================
# IT Department
# ============================================================

class ITDepartment:
    def __init__(self):
        self.logs = []
        self.system_health = {
            "hash_levels": 0,
            "total_hashes": 0,
            "last_check": None,
        }

    def log_event(self, message: str):
        entry = {"time": time.time(), "message": message}
        self.logs.append(entry)
        print("[DEBUG] IT log event:", message)

    def audit(self, levels: dict):
        total = sum(len(v) for v in levels.values())
        self.system_health.update({
            "hash_levels": len(levels),
            "total_hashes": total,
            "last_check": time.time(),
        })
        self.log_event("System audit completed")

    def report(self) -> dict:
        return {
            "health": self.system_health,
            "logs": self.logs[-10:],
        }


# ============================================================
# AutoMemoryCollector
# ============================================================

class AutoMemoryCollector:
    def __init__(self, owner_id: str = OWNER_ID):
        self.levels = {0: {}}
        self.root = RootHash()
        self.rules = RuleEngine(owner_id)
        self.it_department = ITDepartment()
        Path(HASH_FOLDER).mkdir(parents=True, exist_ok=True)

    def _collapse_level(self, level: int):
        stack = [level]
        while stack:
            lvl = stack.pop()
            items = list(self.levels[lvl].items())
            if not items:
                continue

            raw = _safe_json_dumps(items)
            collapsed_hash = _double_sha256(raw)

            self.levels[lvl] = {}
            next_level = lvl + 1
            self.levels.setdefault(next_level, {})

            meta = {"count": len(items)}
            self.levels[next_level][collapsed_hash] = meta
            self.root.add_entry(next_level, collapsed_hash, meta)

            print(f"[DEBUG] Collapsed level {lvl} into hash {collapsed_hash}")

            if len(self.levels[next_level]) >= HASH_GROUP_SIZE:
                stack.append(next_level)

    async def collect_batch(self, info_list, requester_id=OWNER_ID):
        if not self.rules.authorize(requester_id):
            return None

        results = []
        for i in range(0, len(info_list), BATCH_SIZE):
            batch = info_list[i:i+BATCH_SIZE]
            print("[DEBUG] Starting batch", i // BATCH_SIZE + 1)
            batch_results = await asyncio.gather(
                *[double_hash_worker_async(info) for info in batch]
            )
            results.extend(batch_results)

        for h, info in results:
            self.levels[0][h] = info
            self.root.add_entry(0, h, {"type": "data"})
            if len(self.levels[0]) >= HASH_GROUP_SIZE:
                self._collapse_level(0)

        self.it_department.audit(self.levels)
        return self.root.build_root_hash()

    async def collect_audio(self, audio_bytes, sample_rate=44100, requester_id=OWNER_ID):
        if not self.rules.authorize(requester_id):
            return None

        h, meta = await double_audio_hash_worker_async(audio_bytes, sample_rate)

        if not self.rules.biometric_protection(meta):
            return None

        self.levels[0][h] = {"audio": True}
        self.root.add_entry(0, h, meta)

        if len(self.levels[0]) >= HASH_GROUP_SIZE:
            self._collapse_level(0)

        self.it_department.audit(self.levels)
        return h

    async def export_root(self):
        data = self.root.export()
        file_path = Path(HASH_FOLDER) / "root_hash.json"

        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

        try:
            subprocess.run(["git", "add", str(file_path)], check=False)
            subprocess.run(["git", "commit", "-m", "Update root_hash"], check=False)
            subprocess.run(["git", "push"], check=False)
        except Exception as e:
            print("GitHub integration error:", e)

        print("[DEBUG] Root hash exported")
        return data

    def it_report(self):
        return self.it_department.report()


# ============================================================
# Menu
# ============================================================

class MenuBarFromRoot:
    def __init__(self, root_data):
        self.menu = root_data["menu"]

    def show(self):
        print("\n=== ROOT HASH MENU ===")
        for i, (h, v) in enumerate(self.menu.items(), start=1):
            t = v.get("meta", {}).get("type", "data")
            print(f"{i}. HASH {h[:12]} | level={v['level']} | type={t}")
        print("[DEBUG] Menu displayed with", len(self.menu), "entries")


# ============================================================
# Safe Async Runner (FIX for asyncio.run error)
# ============================================================

def run_async_safely(coro):
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    else:
        return loop.create_task(coro)


# ============================================================
# Self Tests
# ============================================================

async def _self_test():
    collector = AutoMemoryCollector()

    # Test 1: Batch hashing
    batch = [{"frame": i} for i in range(5)]
    root_hash = await collector.collect_batch(batch)
    assert isinstance(root_hash, str)

    # Test 2: Valid audio
    audio_hash = await collector.collect_audio(b"TEST_AUDIO", 44100)
    assert isinstance(audio_hash, str)

    # Test 3: Invalid audio (should raise)
    try:
        await collector.collect_audio(b"", 44100)
    except ValueError:
        pass
    else:
        raise AssertionError("Empty audio should raise ValueError")

    print("[DEBUG] Self-tests passed")


# ============================================================
# Main Execution
# ============================================================

if __name__ == "__main__":
    run_async_safely(_self_test())
''
