# Layers 5 & 7 — Smart Contract + Verification/Storage

Part 2 of the Quantum-Resistant Adaptive Transaction DApp: the
Solidity contract that decides normal-vs-high-risk, validates delegation
certs, enforces the revocation registry, and writes the immutable
on-chain transaction record — plus the off-chain relay that bridges it to
Pallavi's PQC backend (Layer 6).

```
pq-blockchain-michelle/
├── contracts/
│   └── TransactionRegistry.sol      # threshold + cert + revocation + storage
├── scripts/
│   ├── deploy.js                    # deploys, seeds epoch 0, writes ABI for Shafna
│   └── relay.js                     # calls /verify, then submits on-chain (demo runner)
├── test/
│   └── TransactionRegistry.test.js  # Mocha/Chai unit tests
├── mock-pqc-service/
│   ├── main.py                      # stand-in for Pallavi's FastAPI service
│   └── requirements.txt
├── deployments/                     # generated: address + ABI after deploy
├── hardhat.config.js
├── package.json
└── .env.example
```

## 0. Prerequisites

- Node.js 18+ and npm
- Python 3.10+ and pip (only needed for the mock PQC service)
- Git

Check versions:

```bash
node -v
npm -v
python3 --version
```

## 1. Install dependencies

```bash
cd pq-blockchain-michelle
npm install
cp .env.example .env
```

The defaults in `.env` work for local development as-is — you only need
to edit `PQC_SERVICE_URL` once Pallavi's real service is running, and
`CONTRACT_ADDRESS` gets filled in by the deploy step below.

## 2. Compile and test the contract

```bash
npx hardhat compile
npx hardhat test
```

All tests in `test/TransactionRegistry.test.js` should pass — they cover
the threshold logic (value + rolling volume), delegation cert validation
(missing / expired / valid), the revocation registry, access control, and
the full transaction-recording path (including the failed-verification
revert).

## 3. Run a local blockchain

In **terminal 1**, start the Hardhat node (this is the *same* network
Shafna's MetaMask/frontend should point at):

```bash
npx hardhat node
```

Leave this running. It prints 20 funded test accounts — account #0 is
used as `admin`, #1 as `relayer` in the deploy script below.

## 4. Run the mock PQC service (Layer 6 stand-in)

In **terminal 2**, until Pallavi's real FastAPI service is ready:

```bash
cd mock-pqc-service
pip install -r requirements.txt
uvicorn main:app --reload --port 8001
```

Check it's alive: `curl http://127.0.0.1:8001/health`

This mock implements the exact `/verify` request/response shape described
below, so nothing else needs to change when you swap it for the real one
— just update `PQC_SERVICE_URL` in `.env`.

## 5. Deploy the contract

In **terminal 3**:

```bash
npx hardhat run scripts/deploy.js --network localhost
```

This will:
- deploy `TransactionRegistry` with account #0 as admin and #1 as relayer
- write `deployments/localhost.json` (address + full ABI) — **this is
  the file Shafna's frontend should import to talk to the contract**
- seed a delegation cert for epoch 0 so the demo works immediately

Copy the printed address into `.env` as `CONTRACT_ADDRESS` (optional —
the relay script reads it from `deployments/localhost.json` directly).

## 6. Run the end-to-end demo

```bash
npm run demo
```

This runs `scripts/relay.js`, which:
1. Submits a normal (below-threshold) transaction → subkey-only auth.
2. Submits a high-risk (above-threshold) transaction → master-key
   reinforcement.
3. Submits a transaction with a deliberately invalid signature and shows
   the on-chain revert when PQC verification fails.

---

## Integration contract: `/verify` request/response (lock this with Pallavi on Day 0)

The relay (`scripts/relay.js`) POSTs to `{PQC_SERVICE_URL}/verify`:

**Request**
```json
{
  "tx_id": "0x...",
  "sender": "0x...",
  "epoch": 0,
  "auth_level": "SUBKEY_ONLY",
  "message": "0x...",
  "signature": "0x...",
  "public_key": "0x..."
}
```

**Response**
```json
{
  "tx_id": "0x...",
  "verified": true,
  "algorithm": "ML-DSA",
  "signing_time_ms": 3.4,
  "verification_time_ms": 1.1,
  "signature_size_bytes": 2420,
  "reason": null
}
```

`auth_level` is always one of `SUBKEY_ONLY` / `MASTER_REINFORCED` — this
is what should drive Pallavi's escalation logic for which algorithm fires
(the mock maps `SUBKEY_ONLY → ML-DSA`, `MASTER_REINFORCED → SLH-DSA`,
matching the diagram; confirm the real mapping, Falcon's role, and the
`signing_time_ms` / `verification_time_ms` / `signature_size_bytes` fields
with her since those numbers feed Layer 8 benchmarking directly).

## Integration points for teammates

**With Shafna (Layers 2–4):**
- Point MetaMask / the frontend's RPC provider at the same
  `http://127.0.0.1:8545` this repo's Hardhat node runs on.
- Import the contract address + ABI from `deployments/localhost.json`
  after every deploy — don't hand-copy the ABI, it'll drift.
- Agree on the `txId` derivation (currently
  `keccak256(abi.encode(sender, recipient, amount, epoch, timestamp))`
  in `relay.js`) so frontend-submitted and contract-recorded IDs match.

**With Pallavi (Layer 6):**
- The `/verify` contract above — request/response shape, and the
  auth-level → algorithm mapping.
- `signing_time_ms`, `verification_time_ms`, and `signature_size_bytes`
  in the response are what Layer 8 (joint benchmarking) will chart
  against this contract's gas costs.

**For Layer 8 (joint benchmarking):**
- Every on-chain write emits a `TransactionRecorded` event and a full
  `TxRecord` retrievable via `getTransaction(txId)` — use
  `receipt.gasUsed` from `relay.js`'s `tx.wait()` as the gas-cost figure
  to plot against Pallavi's signing/verification times and Shafna's
  end-to-end latency.

## Notes on design choices (for your report / viva)

- **Why a relay instead of an on-chain HTTP call:** Solidity contracts
  cannot make network requests. `RELAYER_ROLE` (via OpenZeppelin
  `AccessControl`) restricts who can report verification results, but the
  contract still independently re-checks thresholds, cert validity, and
  revocation status — the relay can't force through a transaction the
  contract itself would reject.
- **Why `submitVerifiedTransaction` reverts on `verificationResult ==
  false`** rather than recording a "failed" row: it keeps the on-chain
  invariant simple ("everything in the registry passed PQC verification")
  and is easier to test/demo. If you'd rather keep an audit trail of
  failed attempts too, that's a one-line change (store the record with
  `verified: false` instead of reverting) — flag it if Pallavi's service
  needs that for her benchmarking.
- **OpenZeppelin `AccessControl` + `Pausable`** were used instead of
  hand-rolled role checks, per the tech stack notes — fewer lines of
  custom security-critical code, easier to justify in review.
