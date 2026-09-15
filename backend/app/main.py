"""
Layer 6 -- PQC Backend service.

FastAPI microservice fronting liboqs (ML-DSA, Falcon) and pyspx (SLH-DSA).
Owns: key generation, signing, verification, and the escalation logic that
picks an algorithm for a given (key_role, threat_level, size_sensitive)
combination. The delegation/chain layers call this service instead of
touching any PQC library directly.
"""

from __future__ import annotations

import base64

from fastapi import FastAPI, HTTPException

from . import algorithms as alg
from . import escalation
from .keystore import store
from .models import (
    EscalationEvaluateRequest,
    EscalationEvaluateResponse,
    KeyGenRequest,
    KeyGenResponse,
    SignRequest,
    SignResponse,
    VerifyRequest,
    VerifyResponse,
)

app = FastAPI(
    title="PQC Backend (Layer 6)",
    description="Post-quantum signature service: ML-DSA / Falcon / SLH-DSA with adaptive escalation.",
    version="0.1.0",
)


def _b64d(s: str) -> bytes:
    try:
        return base64.b64decode(s)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid base64")


def _b64e(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


@app.get("/health")
def health():
    return {"status": "ok", "supported_algorithms": alg.supported_algorithms()}


@app.get("/algorithms")
def list_algorithms():
    """Live-measured specs for every supported algorithm (real keygen/sign/verify
    cycle, not hardcoded numbers). This is the endpoint the Rust harness diffs
    its own measurements against."""
    return [spec.__dict__ for spec in alg.benchmark_all()]


@app.get("/escalation/policy")
def escalation_policy():
    return escalation.policy_table()


@app.post("/escalation/evaluate", response_model=EscalationEvaluateResponse)
def escalation_evaluate(req: EscalationEvaluateRequest):
    try:
        decision = escalation.decide(req.key_role, req.threat_level, req.size_sensitive)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return EscalationEvaluateResponse(**decision.__dict__)


@app.post("/keys/generate", response_model=KeyGenResponse)
def generate_key(req: KeyGenRequest):
    if req.algorithm:
        if not alg.is_supported(req.algorithm):
            raise HTTPException(status_code=400, detail=f"unsupported algorithm: {req.algorithm}")
        algorithm = req.algorithm
        rationale = f"algorithm explicitly overridden by caller: {algorithm}"
    else:
        try:
            decision = escalation.decide(req.key_role, req.threat_level, req.size_sensitive)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        algorithm = decision.algorithm
        rationale = decision.rationale

    record = store.create(algorithm, req.key_role, req.epoch)
    return KeyGenResponse(
        key_id=record.key_id,
        key_role=record.key_role,
        epoch=record.epoch,
        algorithm=record.algorithm,
        rationale=rationale,
        public_key_b64=_b64e(record.public_key),
        created_at=record.created_at,
    )


@app.post("/sign", response_model=SignResponse)
def sign_message(req: SignRequest):
    record = store.get(req.key_id)
    if record is None:
        raise HTTPException(status_code=404, detail="unknown key_id")
    message = _b64d(req.message_b64)
    signature = alg.sign(record.algorithm, record.secret_key, message)
    return SignResponse(key_id=req.key_id, algorithm=record.algorithm, signature_b64=_b64e(signature))


@app.post("/verify", response_model=VerifyResponse)
def verify_signature(req: VerifyRequest):
    message = _b64d(req.message_b64)
    signature = _b64d(req.signature_b64)

    if req.key_id:
        record = store.get(req.key_id)
        if record is None:
            raise HTTPException(status_code=404, detail="unknown key_id")
        algorithm = record.algorithm
        public_key = record.public_key
    elif req.public_key_b64 and req.algorithm:
        algorithm = req.algorithm
        public_key = _b64d(req.public_key_b64)
    else:
        raise HTTPException(status_code=400, detail="provide either key_id, or both public_key_b64 and algorithm")

    valid = alg.verify(algorithm, public_key, message, signature)
    return VerifyResponse(valid=valid, algorithm=algorithm)


@app.delete("/keys/{key_id}")
def delete_key(key_id: str):
    if not store.delete(key_id):
        raise HTTPException(status_code=404, detail="unknown key_id")
    return {"deleted": key_id}
