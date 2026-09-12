const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer, relayer] = await hre.ethers.getSigners();

  console.log("Deploying with admin:", deployer.address);
  console.log("Relayer account:", relayer.address);

  const TransactionRegistry = await hre.ethers.getContractFactory("TransactionRegistry");
  const registry = await TransactionRegistry.deploy(deployer.address, relayer.address);
  await registry.waitForDeployment();

  const address = await registry.getAddress();
  console.log("TransactionRegistry deployed to:", address);

  // --- Write a small deployment manifest for the other two layers ---
  // Shafna's frontend reads the address + ABI from here.
  // Pallavi doesn't need this file, but it's handy for the demo script.
  const artifact = await hre.artifacts.readArtifact("TransactionRegistry");
  const outDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const manifest = {
    network: hre.network.name,
    address,
    admin: deployer.address,
    relayer: relayer.address,
    abi: artifact.abi,
  };
  fs.writeFileSync(path.join(outDir, "localhost.json"), JSON.stringify(manifest, null, 2));
  console.log("Wrote deployments/localhost.json (address + ABI) for frontend integration");

  // --- Seed an initial delegation cert for epoch 0 so the demo works out of the box ---
  const now = Math.floor(Date.now() / 1000);
  const oneWeek = 7 * 24 * 60 * 60;
  const masterKeyId = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("demo-master-key-v1"));

  const tx = await registry.registerDelegationCert(
    0, // epoch
    deployer.address, // subkeyOwner (stand-in for the sender's derived subkey address)
    now,
    now + oneWeek,
    masterKeyId
  );
  await tx.wait();
  console.log("Seeded delegation cert for epoch 0 (expires in 7 days)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
