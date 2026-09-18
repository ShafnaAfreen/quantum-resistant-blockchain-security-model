//! PQC Rust benchmarking / cross-check harness (Layer 6 companion).
//!
//! Purpose: independently measure signature sizes and sign/verify timing
//! for ML-DSA and Falcon using PQClean-derived Rust bindings (pqcrypto-*),
//! and print a JSON report shaped so it can be diffed line-for-line against
//! the Python FastAPI service's `GET /algorithms` response. If the two
//! implementations ever disagree on a public key or signature size for the
//! same named parameter set, that's a real bug worth catching before it
//! reaches the chain layer -- hence "cross-check", not just "benchmark".
//!
//! SLH-DSA is intentionally NOT included here. The `slh-dsa` crate pinned in
//! the project's tooling notes requires a Rust toolchain newer than what's
//! available in this environment (apt's rustc 1.75 -- its dependency tree
//! needs `digest 0.11`/`block-buffer 0.12`, which require edition2024 /
//! rustc 1.85+). Rather than vendor-patch a cryptographic primitive crate
//! (reasonable for a build-script cfg warning, not reasonable for crypto
//! code), SLH-DSA cross-checking is left to the Python service's pyspx
//! bindings, which are the sole source of truth for that family until the
//! toolchain is upgraded. See README.md for the upgrade path.
//!
//! Also note: pqcrypto-mldsa's published crate versions all emit a
//! `cargo::rustc-check-cfg=...` build-script directive that requires
//! cargo 1.77+. This harness vendors pqcrypto-mldsa locally
//! (vendor/pqcrypto-mldsa) with that single line changed from the new
//! `cargo::` syntax to the old `cargo:` syntax -- a build-script-only
//! patch, not a change to any cryptographic code.

use pqcrypto_falcon::falcon1024;
use pqcrypto_falcon::falcon512;
use pqcrypto_mldsa::{mldsa44, mldsa65, mldsa87};
use pqcrypto_traits::sign::{DetachedSignature, PublicKey, SecretKey};
use serde::Serialize;
use std::time::Instant;

#[derive(Serialize)]
struct AlgorithmReport {
    name: String,
    family: String,
    public_key_bytes: usize,
    signature_bytes: usize,
    keygen_ms: f64,
    sign_ms: f64,
    verify_ms: f64,
    verified_ok: bool,
    tamper_check_rejected: bool,
}

const MESSAGE: &[u8] = b"benchmark-message-32-bytes-long";

macro_rules! bench {
    ($name:expr, $family:expr, $mod:ident) => {{
        let t0 = Instant::now();
        let (pk, sk) = $mod::keypair();
        let keygen_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let t1 = Instant::now();
        let sig = $mod::detached_sign(MESSAGE, &sk);
        let sign_ms = t1.elapsed().as_secs_f64() * 1000.0;

        let t2 = Instant::now();
        let verified_ok = $mod::verify_detached_signature(&sig, MESSAGE, &pk).is_ok();
        let verify_ms = t2.elapsed().as_secs_f64() * 1000.0;

        // cross-check: a corrupted signature must be rejected, not merely
        // "verify ran without panicking" -- a no-op verifier would also do that
        let mut corrupted = sig.as_bytes().to_vec();
        corrupted[0] ^= 0xFF;
        let tamper_rejected = match $mod::DetachedSignature::from_bytes(&corrupted) {
            Ok(bad_sig) => $mod::verify_detached_signature(&bad_sig, MESSAGE, &pk).is_err(),
            Err(_) => true, // malformed bytes rejected outright is also a pass
        };

        AlgorithmReport {
            name: $name.to_string(),
            family: $family.to_string(),
            public_key_bytes: pk.as_bytes().len(),
            signature_bytes: sig.as_bytes().len(),
            keygen_ms,
            sign_ms,
            verify_ms,
            verified_ok,
            tamper_check_rejected: tamper_rejected,
        }
    }};
}

fn main() {
    let reports = vec![
        bench!("ML-DSA-44", "ML-DSA", mldsa44),
        bench!("ML-DSA-65", "ML-DSA", mldsa65),
        bench!("ML-DSA-87", "ML-DSA", mldsa87),
        bench!("Falcon-512", "Falcon", falcon512),
        bench!("Falcon-1024", "Falcon", falcon1024),
    ];

    let mut all_ok = true;
    eprintln!("{:<14} {:>9} {:>9} {:>10} {:>9} {:>10} {:>7} {:>8}",
        "algorithm", "pk(B)", "sig(B)", "keygen(ms)", "sign(ms)", "verify(ms)", "verify", "tamper");
    for r in &reports {
        all_ok &= r.verified_ok && r.tamper_check_rejected;
        eprintln!(
            "{:<14} {:>9} {:>9} {:>10.3} {:>9.3} {:>10.3} {:>7} {:>8}",
            r.name, r.public_key_bytes, r.signature_bytes, r.keygen_ms, r.sign_ms, r.verify_ms,
            if r.verified_ok { "ok" } else { "FAIL" },
            if r.tamper_check_rejected { "ok" } else { "FAIL" },
        );
    }

    println!("{}", serde_json::to_string_pretty(&reports).unwrap());

    if !all_ok {
        eprintln!("\nFAILED: one or more algorithms did not round-trip correctly.");
        std::process::exit(1);
    }
}
