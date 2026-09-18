"""
Unified adapter over two different PQC signature libraries.

liboqs (via oqs-python) supplies the lattice-based families:
  - ML-DSA   (FIPS 204, Dilithium)
  - Falcon   (NIST round-3 alternate, NTRU-lattice based)

pyspx supplies the hash-based family:
  - SLH-DSA  (FIPS 205, SPHINCS+) -- liboqs in this environment was built
    without SPHINCS+/SLH-DSA compiled in (only ML-DSA and Falcon showed up
    in oqs.get_enabled_sig_mechanisms()), so SLH-DSA is served through the
    separate pyspx bindings instead. Kept behind the same Algorithm
    interface so callers (escalation.py, main.py) never know the
    difference.

Gotcha discovered while wiring this up: pyspx.<variant>.verify() takes
(message, signature, publickey) -- NOT (signature, message, publickey)
like you'd guess from oqs's convention. Getting this backwards doesn't
raise an obvious "wrong order" error; it raises a confusing MemoryError
about signature length. Documented here so nobody re-loses the hour.
generate_keypair() also returns (public_key, secret_key), the opposite
order of most other PQC libraries.
"""

from __future__ import annotations

import importlib
import time
from dataclasses import dataclass
from typing import Callable

import oqs

# -- Algorithm identifiers exposed to the rest of the service -----------

ML_DSA_44 = "ML-DSA-44"
ML_DSA_65 = "ML-DSA-65"
ML_DSA_87 = "ML-DSA-87"
FALCON_512 = "Falcon-512"
FALCON_1024 = "Falcon-1024"
SLH_DSA_128S = "SLH-DSA-SHAKE-128s"
SLH_DSA_128F = "SLH-DSA-SHAKE-128f"
SLH_DSA_192S = "SLH-DSA-SHAKE-192s"
SLH_DSA_256S = "SLH-DSA-SHAKE-256s"

_SLH_DSA_TO_PYSPX_MODULE = {
    SLH_DSA_128S: "shake_128s",
    SLH_DSA_128F: "shake_128f",
    SLH_DSA_192S: "shake_192s",
    SLH_DSA_256S: "shake_256s",
}

_OQS_ALGORITHMS = {ML_DSA_44, ML_DSA_65, ML_DSA_87, FALCON_512, FALCON_1024}
_SLH_DSA_ALGORITHMS = set(_SLH_DSA_TO_PYSPX_MODULE)


@dataclass(frozen=True)
class KeyPair:
    algorithm: str
    public_key: bytes
    secret_key: bytes


@dataclass(frozen=True)
class AlgorithmSpec:
    """Measured, not guessed -- filled in from benchmark_all() below."""
    name: str
    family: str            # "ML-DSA" | "Falcon" | "SLH-DSA"
    assumption: str        # underlying hardness assumption
    nist_level: int
    public_key_bytes: int
    signature_bytes: int
    keygen_ms: float
    sign_ms: float
    verify_ms: float


def _pyspx_module(algorithm: str):
    mod_name = _SLH_DSA_TO_PYSPX_MODULE[algorithm]
    return importlib.import_module(f"pyspx.{mod_name}")


def is_supported(algorithm: str) -> bool:
    return algorithm in _OQS_ALGORITHMS or algorithm in _SLH_DSA_ALGORITHMS


def supported_algorithms() -> list[str]:
    return sorted(_OQS_ALGORITHMS | _SLH_DSA_ALGORITHMS)


def generate_keypair(algorithm: str) -> KeyPair:
    if algorithm in _OQS_ALGORITHMS:
        signer = oqs.Signature(algorithm)
        public_key = signer.generate_keypair()
        secret_key = signer.export_secret_key()
        return KeyPair(algorithm, public_key, secret_key)

    if algorithm in _SLH_DSA_ALGORITHMS:
        mod = _pyspx_module(algorithm)
        seed = _secure_seed(mod.crypto_sign_SEEDBYTES)
        public_key, secret_key = mod.generate_keypair(seed)
        return KeyPair(algorithm, public_key, secret_key)

    raise ValueError(f"unsupported algorithm: {algorithm!r}")


def sign(algorithm: str, secret_key: bytes, message: bytes) -> bytes:
    if algorithm in _OQS_ALGORITHMS:
        with oqs.Signature(algorithm, secret_key=secret_key) as signer:
            return signer.sign(message)

    if algorithm in _SLH_DSA_ALGORITHMS:
        mod = _pyspx_module(algorithm)
        return mod.sign(message, secret_key)

    raise ValueError(f"unsupported algorithm: {algorithm!r}")


def verify(algorithm: str, public_key: bytes, message: bytes, signature: bytes) -> bool:
    if algorithm in _OQS_ALGORITHMS:
        with oqs.Signature(algorithm) as verifier:
            try:
                return verifier.verify(message, signature, public_key)
            except Exception:
                return False

    if algorithm in _SLH_DSA_ALGORITHMS:
        mod = _pyspx_module(algorithm)
        try:
            return mod.verify(message, signature, public_key)
        except Exception:
            return False

    raise ValueError(f"unsupported algorithm: {algorithm!r}")


def _secure_seed(n: int) -> bytes:
    import os
    return os.urandom(n)


_ASSUMPTION = {
    "ML-DSA": "module lattices (MLWE/MSIS)",
    "Falcon": "NTRU lattices",
    "SLH-DSA": "hash function security only",
}

_NIST_LEVEL = {
    ML_DSA_44: 2, ML_DSA_65: 3, ML_DSA_87: 5,
    FALCON_512: 1, FALCON_1024: 5,
    SLH_DSA_128S: 1, SLH_DSA_128F: 1, SLH_DSA_192S: 3, SLH_DSA_256S: 5,
}

_FAMILY = {**{a: "ML-DSA" for a in [ML_DSA_44, ML_DSA_65, ML_DSA_87]},
           **{a: "Falcon" for a in [FALCON_512, FALCON_1024]},
           **{a: "SLH-DSA" for a in _SLH_DSA_ALGORITHMS}}


def benchmark(algorithm: str, message: bytes = b"benchmark-message-32-bytes-long") -> AlgorithmSpec:
    """Runs one real keygen/sign/verify cycle and records measured sizes/timings.
    This is what the /algorithms endpoint reports, and what the Rust harness
    cross-checks against -- both should be measuring the same primitive.
    """
    t0 = time.perf_counter()
    kp = generate_keypair(algorithm)
    t1 = time.perf_counter()
    sig = sign(algorithm, kp.secret_key, message)
    t2 = time.perf_counter()
    ok = verify(algorithm, kp.public_key, message, sig)
    t3 = time.perf_counter()
    if not ok:
        raise RuntimeError(f"self-check failed for {algorithm}")

    return AlgorithmSpec(
        name=algorithm,
        family=_FAMILY[algorithm],
        assumption=_ASSUMPTION[_FAMILY[algorithm]],
        nist_level=_NIST_LEVEL[algorithm],
        public_key_bytes=len(kp.public_key),
        signature_bytes=len(sig),
        keygen_ms=round((t1 - t0) * 1000, 3),
        sign_ms=round((t2 - t1) * 1000, 3),
        verify_ms=round((t3 - t2) * 1000, 3),
    )


def benchmark_all() -> list[AlgorithmSpec]:
    return [benchmark(a) for a in supported_algorithms()]
