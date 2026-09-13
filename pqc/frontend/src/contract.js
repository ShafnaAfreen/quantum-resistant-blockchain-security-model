export const CONTRACT_ADDRESS =
  "0x5fbdb2315678afecb367f032d93f642f64180aa3";

export const CONTRACT_ABI = [
  {
    inputs: [
      {
        internalType: "address payable",
        name: "to",
        type: "address",
      },
    ],
    name: "sendEther",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },

  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "from",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "to",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "amount",
        type: "uint256",
      },
    ],
    name: "TransactionSent",
    type: "event",
  },
];