"""
Mock stand-in for Pallavi's Layer 6 PQC Backend (Python + FastAPI + liboqs).

This does NOT perform real ML-DSA/Falcon/SLH-DSA signing or verification —
it just implements the /verify request/response SHAPE so the contract +
relay (Layers 5 & 7) can be built and tested end-to-end before Layer 6 is
ready. Swap PQC_SERVICE_URL in .env to Pallavi's real service once it's up;
nothing else in Michelle's code should need to change if the shape below
matches what you agree on Day 0.

Run:
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8001
"""

from enum import Enum
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Mock PQC Verification Service (stand-in for Layer 6)")


class AuthLevel(str, Enum):
    SUBKEY_ONLY = "SUBKEY_ONLY"
    MASTER_REINFORCED = "MASTER_REINFORCED"


class VerifyRequest(BaseModel):
    tx_id: str
    sender: str
    epoch: int
    auth_level: AuthLevel
    message: str  # hex-encoded payload that was signed
    signature: str  # hex-encoded signature
    public_key: str  # hex-encoded public key
    # Send "INVALID_SIG" as the signature to exercise the failure path in tests/demos.


class VerifyResponse(BaseModel):
    tx_id: str
    verified: bool
    algorithm: str
    signing_time_ms: float
    verification_time_ms: float
    signature_size_bytes: int
    reason: Optional[str] = None


# Which PQC algorithm fires for which auth level — mirrors the "PQC
# Algorithms (via liboqs)" box in the architecture diagram. Confirm the
# exact mapping with Pallavi; this is a reasonable default.
ALGO_BY_AUTH_LEVEL = {
    AuthLevel.SUBKEY_ONLY: "ML-DSA",
    AuthLevel.MASTER_REINFORCED: "SLH-DSA",
}

SIG_SIZE_BY_ALGO = {
    "ML-DSA": 2420,
    "Falcon": 690,
    "SLH-DSA": 7856,
}


@app.post("/verify", response_model=VerifyResponse)
def verify(req: VerifyRequest) -> VerifyResponse:
    algorithm = ALGO_BY_AUTH_LEVEL[req.auth_level]

    # Simulated failure path for negative testing.
    if req.signature == "INVALID_SIG":
        return VerifyResponse(
            tx_id=req.tx_id,
            verified=False,
            algorithm=algorithm,
            signing_time_ms=0.0,
            verification_time_ms=1.2,
            signature_size_bytes=SIG_SIZE_BY_ALGO[algorithm],
            reason="signature_mismatch",
        )

    return VerifyResponse(
        tx_id=req.tx_id,
        verified=True,
        algorithm=algorithm,
        signing_time_ms=3.4,
        verification_time_ms=1.1,
        signature_size_bytes=SIG_SIZE_BY_ALGO[algorithm],
    )


@app.get("/health")
def health():
    return {"status": "ok", "service": "mock-pqc-backend"}
