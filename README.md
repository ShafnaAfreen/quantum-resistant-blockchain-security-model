# Quantum-Resistant Blockchain Security Model

A research prototype for adaptive, post-quantum-secure blockchain payments.
The system combines a React and MetaMask wallet interface, a FastAPI
post-quantum cryptography (PQC) service, an off-chain relay, and a Solidity
smart contract running on a local Ethereum-compatible Hardhat network.

The project demonstrates how a transaction can receive stronger authentication
as its risk increases, while preserving an immutable on-chain record of the
verification and payment.

## Highlights

- Adaptive authentication based on transaction value and rolling account volume.
- Post-quantum signature policy using ML-DSA, Falcon, and SLH-DSA.
- Separate epoch subkeys and master-key reinforcement for defense in depth.
- Delegation certificate registration, expiry validation, and epoch revocation.
- Role-protected relay authorization without exposing the relayer key to the browser.
- MetaMask payment confirmation: the relay authorizes a payment, but only the sender's wallet can transfer the exact ETH amount.
- On-chain transaction records and events for auditable verification history.

> This is a local academic/demo project, not a production payment system. Do
> not use the supplied development keys, local Hardhat network, or in-memory
> key store with real funds or sensitive production data.

## Architecture

```text
React + MetaMask
      |
      | POST /transactions
      v
Local relay (port 3001) ----> PQC backend (port 8000)
      |                              |
      | authorizeVerifiedPayment      | select algorithm, sign, verify
      v                              v
TransactionRegistry <------ PQC verification result
      |
      | MetaMask executes approved exact payment
      v
Hardhat local blockchain (port 8545)
```

The relay is an off-chain bridge because Solidity contracts cannot call HTTP
services directly. It receives the PQC result and requests payment
authorization from the contract. The contract independently enforces its
thresholds, delegation certificate validity, revocation status, roles, and
payment amount.

## Project structure

```text
quantum-resistant-blockchain-security-model/
├── contract-layer/
│   ├── contracts/TransactionRegistry.sol  Solidity registry and payment contract
│   ├── scripts/deploy.js                  Local deployment and frontend ABI update
│   ├── scripts/relay-server.js            Browser-to-PQC-to-contract relay API
│   ├── scripts/relay.js                   Command-line relay demonstration
│   ├── test/                              Hardhat contract test suite
│   └── mock-pqc-service/                  Lightweight PQC API stand-in
├── pqc/
│   ├── backend/                           FastAPI PQC service and Rust benchmark
│   └── frontend/                          React, Vite, ethers, and MetaMask UI
└── docs/                                  Project guide and PDF generation helper
```

## Technology stack

| Area | Technologies |
| --- | --- |
| Smart contract | Solidity `0.8.24`, Hardhat, OpenZeppelin AccessControl and Pausable |
| Frontend | React, Vite, ethers.js, MetaMask |
| PQC backend | Python, FastAPI, liboqs, pyspx |
| Algorithms | ML-DSA, Falcon, SLH-DSA |
| Benchmarking | Rust, PQClean-derived crates |
| Local chain | Hardhat Network, chain ID `31337` |

## Security model

### Adaptive authentication

`TransactionRegistry` selects one of two authentication levels:

| Condition | Required authentication |
| --- | --- |
| Transaction is at or below `1 ETH` and remains within the rolling `5 ETH` daily volume limit | `SUBKEY_ONLY` using the current epoch subkey |
| Transaction is above `1 ETH`, or would exceed the rolling `5 ETH` volume limit | `MASTER_REINFORCED` |

The contract also calculates a threat level (`0`, `1`, or `2`) for the PQC
backend. Higher threat levels choose a stronger parameter set within the
selected cryptographic family.

### Algorithm policy

| Key role | Normal | Elevated | Critical | Reason |
| --- | --- | --- | --- | --- |
| Epoch subkey | ML-DSA-44 | ML-DSA-65 | ML-DSA-87 | Efficient for frequent short-lived signatures |
| Size-sensitive epoch subkey | Falcon-512 | Falcon-512 | Falcon-1024 | Smaller signatures where transaction size matters |
| Master key | SLH-DSA-SHAKE-128s | SLH-DSA-SHAKE-192s | SLH-DSA-SHAKE-256s | Hash-based alternative to the lattice-based subkey family |

Using a hash-based signature family for master-key reinforcement avoids making
the root of trust depend on the same mathematical assumption as frequently
used lattice-based subkeys.

### On-chain safeguards

- Only `RELAYER_ROLE` can authorize a PQC-verified transaction.
- Only `KEY_MANAGER_ROLE` can register or revoke epoch delegation certificates.
- A certificate must exist, be unexpired, and not be revoked.
- Every `txId` can be used only once.
- The sender must execute the authorized payment from their own MetaMask wallet.
- The payment amount must exactly match the relayer-authorized amount.
- The contract can be paused by the admin.

## Prerequisites

Install the following software:

- Node.js 18 or later and npm
- Python 3.10 or later and pip
- MetaMask browser extension
- Git
- Rust and Cargo (optional, required only for PQC benchmark work)

Check your installation:

```bash
node -v
npm -v
python3 --version
git --version
cargo --version
```

## Quick start: full local application

The application uses five running processes. Start them in this order and
leave each terminal open.

### Terminal 1: start the local blockchain

```bash
cd contract-layer
npm install
npx hardhat node
```

Hardhat starts at `http://127.0.0.1:8545` with chain ID `31337`. It displays
funded test accounts and private keys. These are public development keys and
must only be used on this local network.

### Terminal 2: start the PQC backend

```bash
cd pqc/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

The FastAPI documentation is available at `http://127.0.0.1:8000/docs`.

### Terminal 3: deploy the smart contract

```bash
cd contract-layer
cp .env.example .env
npx hardhat compile
npm run deploy:local
```

Deployment creates `contract-layer/deployments/localhost.json` and updates
`pqc/frontend/src/contract.js` with the latest contract address and ABI.
Run this step again after restarting the Hardhat node.

### Terminal 4: start the relay API

```bash
cd contract-layer
npm run relay:server
```

The relay listens at `http://127.0.0.1:3001`. It keeps the relayer account
outside the browser, asks the PQC backend to verify the transaction, then
authorizes the exact payment on-chain.

### Terminal 5: start the frontend

```bash
cd pqc/frontend
npm install
npm run dev
```

Open the Vite URL printed in the terminal, normally `http://localhost:5173`.

## MetaMask local-network setup

1. Open MetaMask and import one of the funded private keys printed by `npx hardhat node`.
2. Connect the wallet from the application.
3. Approve the request to add or switch to **Hardhat Local**.
4. Verify the active network has chain ID `31337` and RPC URL `http://127.0.0.1:8545`.
5. Enter a recipient wallet address and ETH amount, then submit the payment.
6. Confirm the exact authorized payment in MetaMask.

Use a normal wallet address as the recipient. This local demo intentionally
rejects smart contract recipients in the frontend.

## Using the mock PQC service

The real backend relies on local PQC dependencies. When those dependencies are
not available, use the mock service to demonstrate the contract and frontend
flow.

In place of Terminal 2, run:

```bash
cd contract-layer/mock-pqc-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8001
```

Then set this value in `contract-layer/.env` before starting the relay:

```env
PQC_SERVICE_URL=http://127.0.0.1:8001
```

The mock implements the same verification request/response shape as the
contract demo and supports an intentionally invalid signature path for testing.

## Test and demonstration commands

### Smart contract tests

```bash
cd contract-layer
npx hardhat test
```

The suite covers threshold selection, delegation certificate validity,
revocation, access control, rejected PQC verification, duplicate prevention,
and verified ETH payment execution.

### Relay demonstration

After starting Hardhat, the mock PQC service, and deploying the contract:

```bash
cd contract-layer
npm run demo
```

The demo runs three cases:

1. A normal transaction using subkey authentication.
2. A high-value transaction requiring master-key reinforcement.
3. A deliberately invalid signature that is rejected on-chain.

### Backend tests

```bash
cd pqc/backend
source .venv/bin/activate
python3 -m pytest tests/ -v
```

### Frontend production build

```bash
cd pqc/frontend
npm run build
```

## PQC backend API

Once the backend is running, interactive API documentation is available at
`/docs`. Important endpoints include:

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/health` | Checks service health and supported algorithms |
| `GET` | `/algorithms` | Returns measured algorithm properties |
| `GET` | `/escalation/policy` | Returns the full key-role and threat-level policy |
| `POST` | `/escalation/evaluate` | Selects an algorithm without generating a key |
| `POST` | `/keys/generate` | Creates an in-memory key pair |
| `POST` | `/sign` | Signs a Base64-encoded message using a stored key |
| `POST` | `/verify` | Verifies a Base64-encoded signature |
| `DELETE` | `/keys/{key_id}` | Removes an in-memory key |

Example algorithm-policy request:

```bash
curl -X POST http://127.0.0.1:8000/escalation/evaluate \
  -H "Content-Type: application/json" \
  -d '{"key_role":"epoch_subkey","threat_level":1,"size_sensitive":false}'
```

## Environment configuration

Copy the contract-layer example before running the relay or deployment:

```bash
cd contract-layer
cp .env.example .env
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `RPC_URL` | `http://127.0.0.1:8545` | Local Hardhat JSON-RPC endpoint |
| `RELAYER_PRIVATE_KEY` | Hardhat account #0 test key | Local-only relay signer configuration |
| `CONTRACT_ADDRESS` | Set by deployment | Address of the deployed registry |
| `PQC_SERVICE_URL` | `http://127.0.0.1:8000` | Real backend or mock service URL |
| `RELAY_PORT` | `3001` | Local relay API port |

Never commit a real `.env` file, a production private key, or any API secret.

## Troubleshooting

| Problem | Likely cause and solution |
| --- | --- |
| Frontend says the registry is not deployed | Start Hardhat, then run `npm run deploy:local` from `contract-layer`. Refresh the browser afterward. |
| MetaMask is on the wrong network | Switch to Hardhat Local, chain ID `31337`, RPC `http://127.0.0.1:8545`. |
| Frontend cannot reach the relay | Start Terminal 4 with `npm run relay:server`; it must listen on port `3001`. |
| Relay cannot reach PQC service | Start the backend on port `8000`, or use the mock on `8001` and update `PQC_SERVICE_URL`. |
| Payment is rejected after a Hardhat restart | Redeploy the contract because the local blockchain state was cleared. |
| Python PQC packages fail to install | Use the mock service for the end-to-end contract/frontend demo, or refer to `pqc/backend/README.md` for backend-specific setup notes. |
| MetaMask account has no ETH | Import a funded account shown by the running Hardhat node. |

## Documentation

- [Contract layer guide](contract-layer/README.md)
- [PQC backend guide](pqc/backend/README.md)
- [Project guide PDF](docs/Quantum_Resistant_Blockchain_Project_Guide.pdf)

## License

This project is provided for educational and research use. See individual
dependencies and vendored components for their respective licenses.
