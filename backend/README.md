# PQC Backend -- Layer 6

Owner: Pallavi. Python + FastAPI signature service (liboqs / pyspx bindings)
with the escalation logic that decides which PQC algorithm fires for a
given signing event, plus a Rust benchmarking harness that cross-checks
the Python implementation against an independent (PQClean-derived) one.

```
pqc-backend/
  app/
    algorithms.py    unified adapter over oqs (ML-DSA, Falcon) and pyspx (SLH-DSA)
    escalation.py     epoch_subkey vs master_key algorithm-selection policy
    keystore.py       in-memory keystore (swap for Redis/DB in real deployment)
    models.py         pydantic request/response schemas
    main.py           FastAPI app / HTTP endpoints
  tests/
    test_service.py   16 tests: every algorithm, every escalation path, full HTTP flows
  rust_bench/
    src/main.rs       ML-DSA / Falcon benchmark + tamper-check, via pqcrypto-*
    cross_check.py    diffs the Rust report against the live Python /algorithms endpoint
    vendor/           locally patched pqcrypto-mldsa (see "Toolchain note" below)
  requirements.txt
```

## Run it

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Then, e.g.:

```bash
# ask the escalation logic what it would pick, without generating a key
curl -s localhost:8000/escalation/evaluate \
  -H 'content-type: application/json' \
  -d '{"key_role": "epoch_subkey", "threat_level": 1}'
# -> {"algorithm": "ML-DSA-65", ...}

# generate a key (escalation logic picks the algorithm automatically)
curl -s localhost:8000/keys/generate \
  -H 'content-type: application/json' \
  -d '{"key_role": "master_key", "threat_level": 2}'
# -> {"algorithm": "SLH-DSA-SHAKE-256s", "key_id": "...", ...}
```

Run the test suite: `python3 -m pytest tests/ -v` (16/16 passing).

## What "escalation logic" means here

Two key roles, deliberately built on two different hardness assumptions:

| key role      | family used                | why                                                                 |
|---------------|-----------------------------|----------------------------------------------------------------------|
| epoch_subkey  | ML-DSA (or Falcon)          | lattice-based, fast; rotated every epoch so latency matters          |
| master_key    | SLH-DSA                     | hash-based; security rests on hash functions, not lattice hardness   |

The root of trust (`master_key`) is deliberately kept on a *different*
mathematical foundation than the frequently-rotated `epoch_subkey`s: if a
lattice attack ever weakens ML-DSA/Falcon, the root delegation key doesn't
share that failure mode. `threat_level` (0/1/2) raises the security margin
*within* a family (ML-DSA-44 -> 65 -> 87; SLH-DSA-128s -> 192s -> 256s); it
never changes which family is used. `size_sensitive` swaps ML-DSA for
Falcon on `epoch_subkey` when the target chain can't afford large
signatures -- this exists because the team already rejected Solana as a
target specifically because SLH-DSA's ~7.8KB signature blew its tx-size
ceiling (see the project's decisions log), so anywhere signature size is a
hard on-chain constraint, Falcon (659B/1277B nominal) is the size-sensitive
path.

Full decision table: `GET /escalation/policy`.

## Measured numbers (this environment, real keygen/sign/verify cycles)

From `GET /algorithms` (Python/liboqs+pyspx) and `rust_bench` (Rust/PQClean),
cross-checked against each other -- see "Cross-check" below:

| algorithm            | pk (B) | sig (B)     | sign     | verify   |
|----------------------|-------:|-------------|----------|----------|
| ML-DSA-44            |  1,312 | 2,420       | <1 ms    | <1 ms    |
| ML-DSA-65            |  1,952 | 3,309       | <1 ms    | <1 ms    |
| ML-DSA-87            |  2,592 | 4,627       | <1 ms    | <1 ms    |
| Falcon-512           |    897 | ~655 (var.) | <1 ms    | <1 ms    |
| Falcon-1024          |  1,793 | ~1,270 (var.)| ~0.5 ms | <1 ms    |
| SLH-DSA-SHAKE-128s   |     32 | 7,856       | ~2.5 s   | ~3 ms    |
| SLH-DSA-SHAKE-192s   |     48 | 16,224      | ~4.6 s   | ~3 ms    |
| SLH-DSA-SHAKE-256s   |     64 | 29,792      | ~4.0 s   | ~6 ms    |

Takeaways that shaped the escalation design:
- SLH-DSA signing is seconds, not milliseconds -- fine for a rare
  master-key reinforcement event, unusable for a per-epoch subkey.
- SLH-DSA verification is still fast (single-digit ms) -- the cost is all
  in signing, which the chain layer should account for when scheduling
  reinforcement events (don't put one on a tight deadline).
- Falcon signatures are naturally variable-length (compact encoding), by
  roughly +/-20 bytes run to run in both the Rust and Python bindings.
  If the chain/delegation layer needs a fixed-size field for Falcon
  signatures on-chain, budget for the max (`crypto_sign_BYTES`), not the
  observed average.

## Toolchain note: why SLH-DSA isn't in the Rust harness

`app/algorithms.py` serves SLH-DSA through **pyspx**, not liboqs -- the
liboqs build available in this environment only has ML-DSA and Falcon
compiled in (`oqs.get_enabled_sig_mechanisms()` returns 8 entries, no
SPHINCS+/SLH-DSA). pyspx wraps the reference SPHINCS+ C code directly and
was confirmed working for all six SHAKE parameter sets.

The Rust side hits a different wall: the `slh-dsa` crate pinned in the
project's tooling notes needs `digest 0.11`/`block-buffer 0.12`, which
require Cargo's `edition2024` (rustc 1.85+). This environment only has
apt's rustc 1.75. Rather than vendor-patch a cryptographic primitive to
force it onto an old toolchain, `rust_bench` only benchmarks ML-DSA and
Falcon (whose crates only needed a **build-script** patch, not a crypto
change -- see below), and treats pyspx as the sole source of truth for
SLH-DSA until someone upgrades the Rust toolchain in CI. **If/when a
newer Rust ships, drop `vendor/pqcrypto-mldsa` and add `slh-dsa` back to
`Cargo.toml` -- the harness code has a clear slot for it (add a fourth
`bench!` block per parameter set).**

Two more crate-version gotchas hit while wiring this up, worth knowing
before touching `Cargo.toml` again:
- `pqcrypto-falcon` had to be pinned to `0.3` -- `0.4.x` emits the same
  `cargo::` build-script directive as `pqcrypto-mldsa` and needs the
  newer toolchain too.
- `pqcrypto-mldsa`'s build script (`build.rs`) prints
  `cargo::rustc-check-cfg=...` (new syntax, cargo 1.77+). The vendored
  copy in `rust_bench/vendor/pqcrypto-mldsa` changes exactly that to the
  old `cargo:rustc-check-cfg=...` syntax -- a one-character build-script
  fix, nothing in the actual ML-DSA implementation was touched.

## pyspx gotchas (cost about an hour to find -- don't re-lose it)

- `generate_keypair(seed)` returns **`(public_key, secret_key)`**, the
  reverse of the order you'd guess from most other PQC libraries.
- `verify(message, signature, publickey)` -- message first, signature
  second. Getting this backwards doesn't raise a helpful error; it raises
  a confusing `MemoryError` about signature length, because it's actually
  comparing your signature's length against the *other* argument's
  expected length.
- Multiple SLH-DSA parameter sets (e.g. 128s and 256s) **do** coexist
  safely in one process when imported via `importlib.import_module` and
  used through their own module reference -- this was suspected to be a
  global-state problem during development and turned out not to be one.
  Regression test: `test_multiple_slh_dsa_tiers_coexist_in_one_process`.

## Cross-check

`rust_bench/cross_check.py` runs the Rust binary, hits the live FastAPI
service's `/algorithms` endpoint, and diffs public-key/signature sizes for
every algorithm both sides implement (ML-DSA-44/65/87, Falcon-512/1024):

```bash
uvicorn app.main:app --port 8000 &
cd rust_bench && cargo build --release && python3 cross_check.py
```

Currently passes: liboqs (Python) and PQClean-clean (Rust) agree on every
shared algorithm's public-key size, and on ML-DSA's exact signature size
(fixed-length). Falcon is compared with a small tolerance since its
compact encoding is naturally variable-length in both implementations.

## Integration notes for the chain/delegation layers

- Don't call `oqs` or `pyspx` directly from other layers -- go through this
  service's HTTP API (or import `app.algorithms` / `app.escalation` if
  you're in-process in the same repo). That's the whole point of the
  adapter: liboqs's missing SLH-DSA build and pyspx's odd argument order
  are Layer 6's problem to know about, not Layer 3/4's.
- `POST /escalation/evaluate` lets the delegation layer ask "what would
  fire?" without actually generating a key -- useful for pre-flight
  checks or UI display before committing to a signing event.
- `secret_key` never leaves this service in any response; only
  `public_key_b64` and `signature_b64` are ever returned.
