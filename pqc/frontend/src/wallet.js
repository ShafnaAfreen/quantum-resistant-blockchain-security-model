import { ethers } from "ethers";

export async function connectWallet() {
  if (!window.ethereum) {
    throw new Error("MetaMask is not installed.");
  }

  // Make sure MetaMask is using our local Hardhat network
  await window.ethereum.request({
    method: "wallet_switchEthereumChain",
    params: [
      {
        chainId: "0x7A69",
      },
    ],
  });

  const provider = new ethers.BrowserProvider(window.ethereum);

  await provider.send("eth_requestAccounts", []);

  const signer = await provider.getSigner();
  const address = await signer.getAddress();

  return {
    address,
    signer,
    provider,
  };
}