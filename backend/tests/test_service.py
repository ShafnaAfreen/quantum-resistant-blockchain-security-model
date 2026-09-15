import base64
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app import algorithms as alg
from app import escalation
from app.main import app

client = TestClient(app)


def b64(s: bytes) -> str:
    return base64.b64encode(s).decode()


# ---- algorithm adapter: every supported algorithm actually signs/verifies ----

def test_every_algorithm_round_trips():
    for algorithm in alg.supported_algorithms():
        kp = alg.generate_keypair(algorithm)
        msg = b"integration test message"
        sig = alg.sign(algorithm, kp.secret_key, msg)
        assert alg.verify(algorithm, kp.public_key, msg, sig), algorithm


def test_tampered_message_fails_verification():
    kp = alg.generate_keypair(alg.ML_DSA_44)
    sig = alg.sign(alg.ML_DSA_44, kp.secret_key, b"original")
    assert not alg.verify(alg.ML_DSA_44, kp.public_key, b"tampered", sig)


def test_wrong_public_key_fails_verification():
    kp_a = alg.generate_keypair(alg.SLH_DSA_128S)
    kp_b = alg.generate_keypair(alg.SLH_DSA_128S)
    sig = alg.sign(alg.SLH_DSA_128S, kp_a.secret_key, b"msg")
    assert not alg.verify(alg.SLH_DSA_128S, kp_b.public_key, b"msg", sig)


def test_multiple_slh_dsa_tiers_coexist_in_one_process():
    # regression test for the pyspx global-state concern investigated during
    # development -- confirms two different SLH-DSA parameter sets can be
    # generated/signed/verified interleaved without cross-contamination.
    kp_s = alg.generate_keypair(alg.SLH_DSA_128S)
    kp_l = alg.generate_keypair(alg.SLH_DSA_256S)
    sig_s = alg.sign(alg.SLH_DSA_128S, kp_s.secret_key, b"a")
    sig_l = alg.sign(alg.SLH_DSA_256S, kp_l.secret_key, b"b")
    assert alg.verify(alg.SLH_DSA_128S, kp_s.public_key, b"a", sig_s)
    assert alg.verify(alg.SLH_DSA_256S, kp_l.public_key, b"b", sig_l)


# ---- escalation policy ----

def test_epoch_subkey_stays_lattice_based_at_every_threat_level():
    for level in (0, 1, 2):
        d = escalation.decide(escalation.KEY_ROLE_EPOCH_SUBKEY, level)
        assert d.algorithm in {alg.ML_DSA_44, alg.ML_DSA_65, alg.ML_DSA_87}


def test_master_key_stays_hash_based_at_every_threat_level():
    for level in (0, 1, 2):
        d = escalation.decide(escalation.KEY_ROLE_MASTER, level)
        assert d.algorithm.startswith("SLH-DSA")


def test_size_sensitive_epoch_subkey_uses_falcon():
    d = escalation.decide(escalation.KEY_ROLE_EPOCH_SUBKEY, 0, size_sensitive=True)
    assert d.algorithm.startswith("Falcon")


def test_invalid_key_role_rejected():
    try:
        escalation.decide("not_a_real_role")
        assert False, "should have raised"
    except ValueError:
        pass


# ---- FastAPI endpoints, end to end ----

def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert "ML-DSA-44" in r.json()["supported_algorithms"]


def test_full_keygen_sign_verify_flow_epoch_subkey():
    r = client.post("/keys/generate", json={"key_role": "epoch_subkey", "epoch": 5})
    assert r.status_code == 200
    key = r.json()
    assert key["algorithm"] == "ML-DSA-44"  # threat_level defaults to 0

    msg = b"epoch 5 checkpoint"
    r = client.post("/sign", json={"key_id": key["key_id"], "message_b64": b64(msg)})
    assert r.status_code == 200
    sig = r.json()["signature_b64"]

    r = client.post("/verify", json={"key_id": key["key_id"], "message_b64": b64(msg), "signature_b64": sig})
    assert r.status_code == 200
    assert r.json()["valid"] is True


def test_full_keygen_sign_verify_flow_master_key_reinforcement():
    r = client.post("/keys/generate", json={"key_role": "master_key", "threat_level": 2})
    assert r.status_code == 200
    key = r.json()
    assert key["algorithm"] == "SLH-DSA-SHAKE-256s"

    msg = b"master key reinforcement event"
    r = client.post("/sign", json={"key_id": key["key_id"], "message_b64": b64(msg)})
    sig = r.json()["signature_b64"]

    r = client.post("/verify", json={"key_id": key["key_id"], "message_b64": b64(msg), "signature_b64": sig})
    assert r.json()["valid"] is True


def test_verify_rejects_tampered_signature_over_http():
    r = client.post("/keys/generate", json={"key_role": "epoch_subkey"})
    key = r.json()
    r = client.post("/sign", json={"key_id": key["key_id"], "message_b64": b64(b"real message")})
    sig = bytearray(base64.b64decode(r.json()["signature_b64"]))
    sig[0] ^= 0xFF  # flip a bit
    r = client.post("/verify", json={
        "key_id": key["key_id"],
        "message_b64": b64(b"real message"),
        "signature_b64": base64.b64encode(bytes(sig)).decode(),
    })
    assert r.json()["valid"] is False


def test_escalation_evaluate_endpoint():
    r = client.post("/escalation/evaluate", json={"key_role": "epoch_subkey", "threat_level": 1})
    assert r.status_code == 200
    assert r.json()["algorithm"] == "ML-DSA-65"


def test_algorithm_override_bypasses_escalation():
    r = client.post("/keys/generate", json={"key_role": "epoch_subkey", "algorithm": "Falcon-1024"})
    assert r.json()["algorithm"] == "Falcon-1024"


def test_unknown_key_id_returns_404():
    r = client.post("/sign", json={"key_id": "does-not-exist", "message_b64": b64(b"x")})
    assert r.status_code == 404


def test_algorithms_endpoint_reports_measured_specs():
    r = client.get("/algorithms")
    specs = {s["name"]: s for s in r.json()}
    assert specs["SLH-DSA-SHAKE-128s"]["signature_bytes"] == 7856  # matches project's Solana-rejection note
    assert specs["Falcon-512"]["signature_bytes"] < specs["ML-DSA-44"]["signature_bytes"]
