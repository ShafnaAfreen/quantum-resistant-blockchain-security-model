#!/usr/bin/env python3
"""
Cross-check driver: runs the Rust benchmark binary, hits the live Python
FastAPI service's /algorithms endpoint, and diffs the two on every
algorithm they share (ML-DSA-44/65/87, Falcon-512/1024).

This is the actual "Rust harness as the cross-check" piece: it doesn't
just benchmark Rust in isolation, it verifies the Rust (PQClean-derived)
and Python (liboqs-derived) implementations agree on public-key size for
every shared algorithm, and that signature sizes fall within the expected
range (exact match for ML-DSA, which is fixed-length; tolerance for
Falcon, whose compact encoding is naturally variable-length -- see
README.md "Falcon signature length" note).

Usage:
    # 1. start the service:   uvicorn app.main:app --port 8000
    # 2. run this:            python3 cross_check.py [--url http://127.0.0.1:8000]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import httpx

RUST_BIN = Path(__file__).parent / "target" / "release" / "pqc_rust_bench"

# Falcon signatures use a compact variable-length encoding; PQClean's
# "clean" backend and liboqs both produce lengths within a small band of
# the nominal maximum, so an exact match is the wrong test. This margin
# was chosen from the observed range across five runs each.
FALCON_SIGNATURE_TOLERANCE_BYTES = 20


def run_rust_bench() -> list[dict]:
    if not RUST_BIN.exists():
        print("Rust binary not built yet -- run `cargo build --release` in rust_bench/ first.", file=sys.stderr)
        sys.exit(1)
    proc = subprocess.run([str(RUST_BIN)], capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        print("Rust harness reported a failure:", file=sys.stderr)
        print(proc.stderr, file=sys.stderr)
        sys.exit(1)
    return json.loads(proc.stdout)


def fetch_python_specs(base_url: str) -> list[dict]:
    r = httpx.get(f"{base_url}/algorithms", timeout=30)
    r.raise_for_status()
    return r.json()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    args = parser.parse_args()

    rust_specs = {s["name"]: s for s in run_rust_bench()}
    python_specs = {s["name"]: s for s in fetch_python_specs(args.url)}

    shared = sorted(set(rust_specs) & set(python_specs))
    if not shared:
        print("No overlapping algorithm names between Rust and Python reports -- check naming.", file=sys.stderr)
        return 1

    all_ok = True
    print(f"{'algorithm':<14} {'pk match':>10} {'sig(rust)':>10} {'sig(py)':>10} {'sig match':>10}")
    for name in shared:
        r, p = rust_specs[name], python_specs[name]
        pk_match = r["public_key_bytes"] == p["public_key_bytes"]

        if name.startswith("Falcon"):
            sig_match = abs(r["signature_bytes"] - p["signature_bytes"]) <= FALCON_SIGNATURE_TOLERANCE_BYTES
        else:
            sig_match = r["signature_bytes"] == p["signature_bytes"]

        all_ok &= pk_match and sig_match
        print(f"{name:<14} {'ok' if pk_match else 'MISMATCH':>10} "
              f"{r['signature_bytes']:>10} {p['signature_bytes']:>10} "
              f"{'ok' if sig_match else 'MISMATCH':>10}")

    print()
    if all_ok:
        print("Cross-check PASSED: Rust (PQClean) and Python (liboqs) agree on every shared algorithm.")
        return 0
    else:
        print("Cross-check FAILED: see MISMATCH rows above.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
