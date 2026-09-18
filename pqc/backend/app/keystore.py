"""
In-memory keystore for the demo/dev service.

Deliberately dumb: a dict guarded by a lock. This is Layer 6 in isolation;
the real deployment will have the chain/delegation layers own persistence
(or hand this a Redis/DB-backed implementation behind the same three
methods). Swap this module out, not the callers in main.py.
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field

from . import algorithms as alg


@dataclass
class StoredKey:
    key_id: str
    algorithm: str
    key_role: str
    epoch: int
    public_key: bytes
    secret_key: bytes
    created_at: float = field(default_factory=time.time)


class KeyStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._keys: dict[str, StoredKey] = {}

    def create(self, algorithm: str, key_role: str, epoch: int) -> StoredKey:
        kp = alg.generate_keypair(algorithm)
        key_id = str(uuid.uuid4())
        record = StoredKey(
            key_id=key_id,
            algorithm=algorithm,
            key_role=key_role,
            epoch=epoch,
            public_key=kp.public_key,
            secret_key=kp.secret_key,
        )
        with self._lock:
            self._keys[key_id] = record
        return record

    def get(self, key_id: str) -> StoredKey | None:
        with self._lock:
            return self._keys.get(key_id)

    def delete(self, key_id: str) -> bool:
        with self._lock:
            return self._keys.pop(key_id, None) is not None

    def list_ids(self) -> list[str]:
        with self._lock:
            return list(self._keys.keys())


# module-level singleton used by main.py; a real deployment would inject
# this instead, but that's more ceremony than a single-process demo needs
store = KeyStore()
