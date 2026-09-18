# Quantum-Resistant Blockchain Security Model

A local quantum-resistant transaction demo combining a React/MetaMask frontend,
a FastAPI post-quantum cryptography (PQC) service, and a Solidity smart
contract on a local Hardhat blockchain.

## Project structure

```
quantum-resistant-blockchain-security-model/
├── contract-layer/       Solidity contract, tests, deployment, and relay scripts
├── pqc/backend/          FastAPI PQC signing and verification service
├── pqc/frontend/         React + Vite + MetaMask interface
└── docs/                 Project guide and PDF build script
```

## Prerequisites

- Node.js 18+ and npm
- Python 3.10+ and pip
- MetaMask browser extension
- Git (only for publishing)

Check your tools:

```bash
node -v
npm -v
python3 --version
git --version
```

## Run locally

Use four terminals and keep each running service open.

### 1. Start the local blockchain

```bash
cd contract-layer
npm install
npx hardhat node
```

Hardhat runs at `http://127.0.0.1:8545` with chain ID `31337` and prints
funded development accounts for MetaMask.

### 2. Start the PQC backend

In a new terminal:

```bash
cd pqc/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

The API is available at `http://127.0.0.1:8000`; its interactive docs are at
`http://127.0.0.1:8000/docs`.

If the real PQC dependencies are unavailable, use the mock service instead:

```bash
cd contract-layer/mock-pqc-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8001
```

For the mock service, set `PQC_SERVICE_URL=http://127.0.0.1:8001` in
`contract-layer/.env`.

### 3. Deploy the contract

In a new terminal:

```bash
cd contract-layer
cp .env.example .env
npx hardhat compile
npx hardhat run scripts/deploy.js --network localhost
```

The deploy script updates `pqc/frontend/src/contract.js` with the local
contract address and ABI. Deploy again whenever the Hardhat node is restarted.

### 4. Start the frontend

In a fourth terminal:

```bash
cd pqc/frontend
npm install
npm run dev
```

Open the Vite URL shown in the terminal, normally `http://localhost:5173`.
Import a funded private key printed by `npx hardhat node` into MetaMask. The
app will add or switch MetaMask to the Hardhat Local network automatically.
Only use those development keys on the local test network.

## Test and demo

```bash
cd contract-layer
npx hardhat test
npm run demo
```

Run the demo only after the blockchain, PQC service, and contract deployment
are running.

## Publish to GitHub

This project is already connected to its GitHub repository. To publish your
changes, run the following from this project folder:

```bash
cd /Users/shafnaafreen/capstone/quantum-resistant-blockchain-security-model
git add README.md .gitignore
git status
git commit -m "Add project setup documentation"
git push origin backend
```

The commands push the current `backend` branch. Open a pull request on GitHub
from `backend` to `main` when the changes should be merged into the main
branch. GitHub may ask you to sign in in the browser or use a personal access
token. Check `git status` before every commit. Never commit real private keys,
passwords, API tokens, or local `.env` files.

To publish a new project that is not already a Git repository, create an empty
GitHub repository first, then use `git init`, `git add .`, `git commit`,
`git remote add origin <repository-url>`, and `git push -u origin main`.

## Useful commands

```bash
cd contract-layer && npm run compile
cd contract-layer && npm test
cd contract-layer && npm run node
cd contract-layer && npm run deploy:local
cd pqc/frontend && npm run build
cd pqc/backend && python3 -m pytest tests/ -v
```

## More detail

- `contract-layer/README.md` explains the smart contract and relay.
- `pqc/backend/README.md` explains PQC algorithms, APIs, and benchmarks.
- `docs/Quantum_Resistant_Blockchain_Project_Guide.pdf` is the project guide.
