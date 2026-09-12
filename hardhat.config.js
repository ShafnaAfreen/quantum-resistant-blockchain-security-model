require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    // This MUST match the network Shafna's frontend + MetaMask point at.
    // Default Hardhat node RPC — confirm port with her if she changes it.
    localhost: {
      url: process.env.RPC_URL || "http://127.0.0.1:8545",
      chainId: 31337,
    },
  },
  paths: {
    artifacts: "./artifacts",
    cache: "./cache",
  },
};
