/**
 * Off-chain relay: this is the piece that bridges Layer 5/7 (this repo)
 * and Layer 6 (Pallavi's FastAPI PQC service), because Solidity itself
 * can't make HTTP calls.
 *
 * Flow:
 *   1. Take a pending transaction (sender, recipient, amount, epoch).
 *   2. Ask the contract what auth level it requires.
 *   3. Call PQC_SERVICE_URL/verify with that auth level.
 *   4. Submit the verification result on-chain via
 *      submitVerifiedTransaction — the contract re-checks everything
 *      itself, so the relay is not a trusted source of truth, just a
 *      messenger with signing rights (RELAYER_ROLE).
 *
 * This file doubles as a runnable demo: `npm run demo` after deploying.
 */

require("dotenv").config();
const axios = require("axios");
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const AUTH_LEVEL_NAME = ["SUBKEY_ONLY", "MASTER_REINFORCED"];

async function callVerifyService(payload) {
  const url = `${process.env.PQC_SERVICE_URL || "http://127.0.0.1:8001"}/verify`;
  const { data } = await axios.post(url, payload);
  return data;
}

async function submitPendingTransaction(registry, { sender, recipient, amount, epoch, signatureOverride }) {
  const amountWei = hre.ethers.parseEther(amount.toString());

  // 1. Ask the contract what auth level this transaction needs.
  const requiredLevel = await registry.determineRequiredAuthLevel(sender.address, amountWei);
  const requiredLevelName = AUTH_LEVEL_NAME[Number(requiredLevel)];
  console.log(`Required auth level for ${amount} ETH from ${sender.address}: ${requiredLevelName}`);

  // 2. Build a deterministic tx id (agree this derivation with Shafna so
  //    frontend, relay, and contract all compute the same id).
  const txId = hre.ethers.keccak256(
    hre.ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint256", "uint256", "uint256"],
      [sender.address, recipient.address, amountWei, epoch, Date.now()]
    )
  );

  // 3. Call Pallavi's PQC service (or the mock) for signature verification.
  const verifyResult = await callVerifyService({
    tx_id: txId,
    sender: sender.address,
    epoch,
    auth_level: requiredLevelName,
    message: hre.ethers.hexlify(hre.ethers.toUtf8Bytes(`${sender.address}->${recipient.address}:${amountWei}`)),
    signature: signatureOverride || "0xDEMOSIGNATURE",
    public_key: "0xDEMOPUBKEY",
  });
  console.log("PQC service response:", verifyResult);

  // 4. Submit the result on-chain. Contract re-validates independently.
  const tx = await registry.submitVerifiedTransaction(
    txId,
    sender.address,
    recipient.address,
    amountWei,
    epoch,
    requiredLevel,
    verifyResult.verified
  );
  const receipt = await tx.wait();
  console.log(`Recorded on-chain in block ${receipt.blockNumber}, txId ${txId}`);
  return txId;
}

async function main() {
  const manifestPath = path.join(__dirname, "..", "deployments", "localhost.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("No deployments/localhost.json found — run `npm run deploy:local` first.");
  }
  const { address } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const [admin, relayer, alice, bob] = await hre.ethers.getSigners();
  const registry = await hre.ethers.getContractAt("TransactionRegistry", address, relayer);

  console.log("--- Demo 1: normal transaction (below threshold) ---");
  await submitPendingTransaction(registry, { sender: alice, recipient: bob, amount: "0.1", epoch: 0 });

  console.log("\n--- Demo 2: high-risk transaction (above threshold) ---");
  await submitPendingTransaction(registry, { sender: alice, recipient: bob, amount: "2", epoch: 0 });

  console.log("\n--- Demo 3: failed PQC verification ---");
  await submitPendingTransaction(registry, {
    sender: alice,
    recipient: bob,
    amount: "0.2",
    epoch: 0,
    signatureOverride: "INVALID_SIG",
  }).catch((err) => console.log("Reverted as expected:", err.reason || err.message));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
