/**
 * Local HTTP facade for the browser. It keeps the relayer key out of the
 * frontend: the browser supplies transaction details, this process obtains
 * PQC verification, then the relayer authorizes an exact wallet payment.
 *
 * This server is intentionally bound to 127.0.0.1 for the local demo. It is
 * not a production authentication service.
 */
require("dotenv").config();
const http = require("http");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const PORT = Number(process.env.RELAY_PORT || 3001);
const PQC_URL = (process.env.PQC_SERVICE_URL || "http://127.0.0.1:8001").replace(/\/$/, "");
const AUTH_LEVEL_NAME = ["SUBKEY_ONLY", "MASTER_REINFORCED"];
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function getCorsOrigin(request) {
  const origin = request.headers.origin;
  return origin && ALLOWED_ORIGINS.has(origin) ? origin : "http://localhost:5173";
}

function sendJson(response, request, status, body) {
  const corsOrigin = getCorsOrigin(request);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
  });
  response.end(JSON.stringify(body));
}

async function verifyWithPqc({
  txId,
  sender,
  recipient,
  amountWei,
  epoch,
  authLevel,
  threatLevel,
}) {
  const authLevelName = AUTH_LEVEL_NAME[Number(authLevel)];
  const message = `${sender}->${recipient}:${amountWei}`;

  // The mock has the integration shape agreed by the contract layer.
  if (PQC_URL.endsWith(":8001")) {
    const { data } = await axios.post(`${PQC_URL}/verify`, {
      tx_id: txId,
      sender,
      epoch,
      auth_level: authLevelName,
      message: hre.ethers.hexlify(hre.ethers.toUtf8Bytes(message)),
      signature: "0xLOCAL_DEMO_SIGNATURE",
      public_key: "0xLOCAL_DEMO_PUBLIC_KEY",
    });
    return { verified: data.verified, algorithm: data.algorithm };
  }

  // The real Layer 6 service owns its keys and accepts base64 messages.
  const message_b64 = Buffer.from(message).toString("base64");
  const key_role = Number(authLevel) === 0 ? "epoch_subkey" : "master_key";
  const { data: key } = await axios.post(`${PQC_URL}/keys/generate`, {
    key_role,
    epoch,
    threat_level: Number(threatLevel),
  });
  const { data: signature } = await axios.post(`${PQC_URL}/sign`, {
    key_id: key.key_id,
    message_b64,
  });
  const { data: verification } = await axios.post(`${PQC_URL}/verify`, {
    key_id: key.key_id,
    message_b64,
    signature_b64: signature.signature_b64,
  });
  return { verified: verification.valid, algorithm: verification.algorithm };
}

async function submitTransaction({ sender, recipient, amount, epoch = 0 }) {
  if (!hre.ethers.isAddress(sender) || !hre.ethers.isAddress(recipient)) {
    throw new Error("Sender and recipient must be valid Ethereum addresses.");
  }
  if (typeof amount !== "string" || !amount.trim() || Number(amount) <= 0) {
    throw new Error("Amount must be greater than zero.");
  }

  const manifestPath = path.join(__dirname, "..", "deployments", "localhost.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("TransactionRegistry is not deployed. Run npm run deploy:local.");
  }

  const { address } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const [, relayer] = await hre.ethers.getSigners();
  const registry = await hre.ethers.getContractAt("TransactionRegistry", address, relayer);
  const amountWei = hre.ethers.parseEther(amount);
  const authLevel = await registry.determineRequiredAuthLevel(sender, amountWei);
  const threatLevel =
    await registry.determineThreatLevel(sender, amountWei);
  const txId = hre.ethers.keccak256(
    hre.ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint256", "uint256", "uint256"],
      [sender, recipient, amountWei, epoch, Date.now()]
    )
  );
  const verification = await verifyWithPqc({
  txId,
  sender,
  recipient,
  amountWei,
  epoch,
  authLevel,
  threatLevel,
});
  if (!verification.verified) throw new Error("PQC signature verification failed.");

  const tx = await registry.authorizeVerifiedPayment(
    txId, sender, recipient, amountWei, epoch, authLevel, true
  );
  const receipt = await tx.wait();
  return {
    txId,
    from: sender,
    to: recipient,
    amount,
    epoch,
    authLevel: Number(authLevel) === 0 ? "Subkey" : "Master reinforced",
    algorithm: verification.algorithm,
    authorizationBlock: receipt.blockNumber,
  };
}

const server = http.createServer((request, response) => {
  if (request.method === "OPTIONS") return sendJson(response, request, 204, {});
  if (request.method !== "POST" || request.url !== "/transactions") {
    return sendJson(response, request, 404, { error: "Not found" });
  }

  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", async () => {
    try {
      const transaction = await submitTransaction(JSON.parse(body));
      sendJson(response, request, 201, { transaction });
    } catch (error) {
      console.error("Relay request failed:", error.message);
      sendJson(response, request, 400, { error: error.message || "Unable to submit transaction." });
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`PQC relay API listening at http://127.0.0.1:${PORT}`);
  console.log(`Using PQC service: ${PQC_URL}`);
});
