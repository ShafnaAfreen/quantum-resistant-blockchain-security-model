"""
Escalation logic: decides which PQC algorithm fires for a given signing
event in the adaptive delegated-authentication scheme.

Two key roles, deliberately handled by different algorithm families:

  epoch_subkey     -- rotated every epoch, signs frequently, short-lived.
                       Needs low sign/verify latency and reasonable
                       signature size (it's going on-chain often).
                       -> lattice-based (ML-DSA, or Falcon when the chain
                          layer flags size sensitivity).

  master_key       -- reinforces / re-delegates the root of trust.
                       Signs rarely, is long-lived, is the thing an
                       attacker would most want to forge.
                       -> hash-based (SLH-DSA). Its security rests only on
                          the hash function, not on a lattice-hardness
                          assumption, so it stays secure even in a
                          scenario where the lattice families above turn
                          out to be broken. That's the whole point of
                          keeping the root on a *different* mathematical
                          foundation than the frequently-used subkeys:
                          algorithmic diversity as defense-in-depth.

`threat_level` (0/1/2) raises the security margin within a family when
the delegation/chain layer signals elevated risk (e.g. anomaly detection
upstream, or a validator flagged as compromised). It does not change
which family is used -- epoch_subkey stays lattice-based, master_key
stays hash-based, at every threat level.

`size_sensitive` lets the chain layer trade signature size for security
margin on epoch subkeys. This exists because the team already rejected
Solana as a target chain specifically because SLH-DSA's ~7.8KB signature
blew the tx-size ceiling -- so anywhere signature size is a hard
constraint, Falcon (smallest lattice-based signatures: 659B / 1277B) is
offered as the size-sensitive path instead of ML-DSA.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import algorithms as alg

KEY_ROLE_EPOCH_SUBKEY = "epoch_subkey"
KEY_ROLE_MASTER = "master_key"
VALID_KEY_ROLES = {KEY_ROLE_EPOCH_SUBKEY, KEY_ROLE_MASTER}

_EPOCH_SUBKEY_TABLE = {
    0: alg.ML_DSA_44,
    1: alg.ML_DSA_65,
    2: alg.ML_DSA_87,
}
_EPOCH_SUBKEY_SIZE_SENSITIVE_TABLE = {
    0: alg.FALCON_512,
    1: alg.FALCON_512,
    2: alg.FALCON_1024,
}
_MASTER_KEY_TABLE = {
    0: alg.SLH_DSA_128S,
    1: alg.SLH_DSA_192S,
    2: alg.SLH_DSA_256S,
}


@dataclass(frozen=True)
class EscalationDecision:
    algorithm: str
    key_role: str
    threat_level: int
    size_sensitive: bool
    rationale: str


def decide(key_role: str, threat_level: int = 0, size_sensitive: bool = False) -> EscalationDecision:
    if key_role not in VALID_KEY_ROLES:
        raise ValueError(f"key_role must be one of {VALID_KEY_ROLES}, got {key_role!r}")
    threat_level = max(0, min(2, int(threat_level)))

    if key_role == KEY_ROLE_EPOCH_SUBKEY:
        if size_sensitive:
            algorithm = _EPOCH_SUBKEY_SIZE_SENSITIVE_TABLE[threat_level]
            rationale = (
                f"epoch subkey, size-constrained chain target -> {algorithm} "
                f"(lattice-based, smallest available signature at this security level)"
            )
        else:
            algorithm = _EPOCH_SUBKEY_TABLE[threat_level]
            rationale = (
                f"epoch subkey, threat_level={threat_level} -> {algorithm} "
                f"(lattice-based, optimized for frequent low-latency signing)"
            )
    else:
        algorithm = _MASTER_KEY_TABLE[threat_level]
        rationale = (
            f"master key reinforcement, threat_level={threat_level} -> {algorithm} "
            f"(hash-based, algorithmically independent of the lattice assumption "
            f"used by epoch subkeys -- root of trust must not share a single "
            f"point of cryptographic failure with the frequently-used keys)"
        )

    return EscalationDecision(
        algorithm=algorithm,
        key_role=key_role,
        threat_level=threat_level,
        size_sensitive=size_sensitive,
        rationale=rationale,
    )


def policy_table() -> list[dict]:
    """Full decision table, for the /escalation/policy endpoint and for docs."""
    rows = []
    for role in (KEY_ROLE_EPOCH_SUBKEY, KEY_ROLE_MASTER):
        for size_sensitive in ((False, True) if role == KEY_ROLE_EPOCH_SUBKEY else (False,)):
            for level in (0, 1, 2):
                d = decide(role, level, size_sensitive)
                rows.append({
                    "key_role": role,
                    "threat_level": level,
                    "size_sensitive": size_sensitive,
                    "algorithm": d.algorithm,
                    "rationale": d.rationale,
                })
    return rows
