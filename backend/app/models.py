from __future__ import annotations

from pydantic import BaseModel, Field


class KeyGenRequest(BaseModel):
    key_role: str = Field(..., description="'epoch_subkey' or 'master_key'")
    epoch: int = Field(0, description="Epoch number this key belongs to")
    threat_level: int = Field(0, ge=0, le=2, description="0=normal, 1=elevated, 2=critical")
    size_sensitive: bool = Field(False, description="Prefer smallest-signature algorithm (chain tx-size constrained)")
    algorithm: str | None = Field(None, description="Override escalation logic and force a specific algorithm")


class KeyGenResponse(BaseModel):
    key_id: str
    key_role: str
    epoch: int
    algorithm: str
    rationale: str
    public_key_b64: str
    created_at: float


class SignRequest(BaseModel):
    key_id: str
    message_b64: str


class SignResponse(BaseModel):
    key_id: str
    algorithm: str
    signature_b64: str


class VerifyRequest(BaseModel):
    message_b64: str
    signature_b64: str
    # verify against a stored key_id, OR a raw public key -- one of the two
    key_id: str | None = None
    public_key_b64: str | None = None
    algorithm: str | None = None


class VerifyResponse(BaseModel):
    valid: bool
    algorithm: str


class EscalationEvaluateRequest(BaseModel):
    key_role: str
    threat_level: int = Field(0, ge=0, le=2)
    size_sensitive: bool = False


class EscalationEvaluateResponse(BaseModel):
    algorithm: str
    key_role: str
    threat_level: int
    size_sensitive: bool
    rationale: str
