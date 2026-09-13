import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther } from "viem";

describe("Transaction", async function () {
  const { viem } = await network.connect();

  it("should send ETH to the recipient", async function () {
    const [sender, recipient] = await viem.getWalletClients();

    const publicClient = await viem.getPublicClient();

    const transaction = await viem.deployContract("Transaction");

    const recipientBefore = await publicClient.getBalance({
      address: recipient.account.address,
    });

    await sender.writeContract({
      address: transaction.address,
      abi: transaction.abi,
      functionName: "sendEther",
      args: [recipient.account.address],
      value: parseEther("1"),
    });

    const recipientAfter = await publicClient.getBalance({
      address: recipient.account.address,
    });

    assert.equal(
      recipientAfter - recipientBefore,
      parseEther("1")
    );
  });
});