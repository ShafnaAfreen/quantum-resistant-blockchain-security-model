const { expect } = require("chai");
const { ethers } = require("hardhat");

const SUBKEY_ONLY = 0;
const MASTER_REINFORCED = 1;

describe("TransactionRegistry", function () {
  let registry, admin, relayer, alice, bob, other;
  const oneWeek = 7 * 24 * 60 * 60;

  async function currentTimestamp() {
    const block = await ethers.provider.getBlock("latest");
    return block.timestamp;
  }

  beforeEach(async function () {
    [admin, relayer, alice, bob, other] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("TransactionRegistry");
    registry = await Registry.deploy(admin.address, relayer.address);
    await registry.waitForDeployment();

    const now = await currentTimestamp();
    await registry
      .connect(admin)
      .registerDelegationCert(0, alice.address, now, now + oneWeek, ethers.keccak256(ethers.toUtf8Bytes("master-1")));
  });

  describe("threshold logic", function () {
    it("requires only the epoch subkey below the value threshold", async function () {
      const level = await registry.determineRequiredAuthLevel(alice.address, ethers.parseEther("0.5"));
      expect(level).to.equal(SUBKEY_ONLY);
    });

    it("requires master-key reinforcement above the value threshold", async function () {
      const level = await registry.determineRequiredAuthLevel(alice.address, ethers.parseEther("2"));
      expect(level).to.equal(MASTER_REINFORCED);
    });

    it("requires master-key reinforcement once rolling volume exceeds the window threshold", async function () {
      const txId1 = ethers.keccak256(ethers.toUtf8Bytes("tx1"));
      await registry
        .connect(relayer)
        .submitVerifiedTransaction(txId1, alice.address, bob.address, ethers.parseEther("0.9"), 0, SUBKEY_ONLY, true);

      // A further 0.9 ETH would push cumulative volume past the 5 ETH
      // default only after several repeats — bump the threshold down for
      // a clean, fast assertion instead of looping many transactions.
      await registry.connect(admin).setThresholds(ethers.parseEther("1"), ethers.parseEther("1"), 24 * 60 * 60);

      const level = await registry.determineRequiredAuthLevel(alice.address, ethers.parseEther("0.5"));
      expect(level).to.equal(MASTER_REINFORCED);
    });

    it("uses threat level 2 / ML-DSA-87 policy for a high-value epoch-subkey payment", async function () {
      // 0.9 ETH remains below the 1 ETH master-key boundary, but reaches the
      // backend's strongest ML-DSA epoch-subkey policy level.
      const threatLevel = await registry.determineThreatLevel(alice.address, ethers.parseEther("0.9"));
      expect(threatLevel).to.equal(2);
      expect(await registry.determineRequiredAuthLevel(alice.address, ethers.parseEther("0.9"))).to.equal(SUBKEY_ONLY);
    });
  });

  describe("delegation cert validation", function () {
    it("treats an unregistered epoch as invalid", async function () {
      expect(await registry.isEpochValid(99)).to.equal(false);
    });

    it("treats a registered, unexpired epoch as valid", async function () {
      expect(await registry.isEpochValid(0)).to.equal(true);
    });

    it("treats an expired cert as invalid", async function () {
      const now = await currentTimestamp();
      await registry
        .connect(admin)
        .registerDelegationCert(1, alice.address, now - 100, now - 1, ethers.keccak256(ethers.toUtf8Bytes("master-1")));
      expect(await registry.isEpochValid(1)).to.equal(false);
    });

    it("rejects submitVerifiedTransaction for an epoch with no cert", async function () {
      const txId = ethers.keccak256(ethers.toUtf8Bytes("tx-no-cert"));
      await expect(
        registry
          .connect(relayer)
          .submitVerifiedTransaction(txId, alice.address, bob.address, ethers.parseEther("0.1"), 42, SUBKEY_ONLY, true)
      ).to.be.revertedWithCustomError(registry, "EpochCertMissing");
    });
  });

  describe("revocation registry", function () {
    it("marks a revoked epoch as invalid even with a live cert", async function () {
      await registry.connect(admin).revokeEpoch(0);
      expect(await registry.isEpochValid(0)).to.equal(false);
    });

    it("rejects submitVerifiedTransaction against a revoked epoch", async function () {
      await registry.connect(admin).revokeEpoch(0);
      const txId = ethers.keccak256(ethers.toUtf8Bytes("tx-revoked"));
      await expect(
        registry
          .connect(relayer)
          .submitVerifiedTransaction(txId, alice.address, bob.address, ethers.parseEther("0.1"), 0, SUBKEY_ONLY, true)
      ).to.be.revertedWithCustomError(registry, "EpochRevokedError");
    });
  });

  describe("access control", function () {
    it("only the relayer can submit verified transactions", async function () {
      const txId = ethers.keccak256(ethers.toUtf8Bytes("tx-unauthorized"));
      await expect(
        registry
          .connect(other)
          .submitVerifiedTransaction(txId, alice.address, bob.address, ethers.parseEther("0.1"), 0, SUBKEY_ONLY, true)
      ).to.be.reverted;
    });

    it("only the key manager can register delegation certs", async function () {
      const now = await currentTimestamp();
      await expect(
        registry
          .connect(other)
          .registerDelegationCert(5, alice.address, now, now + oneWeek, ethers.keccak256(ethers.toUtf8Bytes("x")))
      ).to.be.reverted;
    });
  });

  describe("transaction recording", function () {
    it("records a valid transaction and stores the full schema", async function () {
      const txId = ethers.keccak256(ethers.toUtf8Bytes("tx-valid"));
      await registry
        .connect(relayer)
        .submitVerifiedTransaction(txId, alice.address, bob.address, ethers.parseEther("0.3"), 0, SUBKEY_ONLY, true);

      const record = await registry.getTransaction(txId);
      expect(record.sender).to.equal(alice.address);
      expect(record.recipient).to.equal(bob.address);
      expect(record.amount).to.equal(ethers.parseEther("0.3"));
      expect(record.epoch).to.equal(0);
      expect(record.authLevel).to.equal(SUBKEY_ONLY);
      expect(record.verified).to.equal(true);
    });

    it("reverts when the PQC verification result is false", async function () {
      const txId = ethers.keccak256(ethers.toUtf8Bytes("tx-failed-verify"));
      await expect(
        registry
          .connect(relayer)
          .submitVerifiedTransaction(txId, alice.address, bob.address, ethers.parseEther("0.1"), 0, SUBKEY_ONLY, false)
      ).to.be.revertedWithCustomError(registry, "VerificationFailed");
    });

    it("rejects a duplicate txId", async function () {
      const txId = ethers.keccak256(ethers.toUtf8Bytes("tx-dup"));
      await registry
        .connect(relayer)
        .submitVerifiedTransaction(txId, alice.address, bob.address, ethers.parseEther("0.1"), 0, SUBKEY_ONLY, true);

      await expect(
        registry
          .connect(relayer)
          .submitVerifiedTransaction(txId, alice.address, bob.address, ethers.parseEther("0.1"), 0, SUBKEY_ONLY, true)
      ).to.be.revertedWithCustomError(registry, "TransactionAlreadyRecorded");
    });

    it("rejects an under-authorized high-risk transaction", async function () {
      const txId = ethers.keccak256(ethers.toUtf8Bytes("tx-underauth"));
      await expect(
        registry
          .connect(relayer)
          .submitVerifiedTransaction(txId, alice.address, bob.address, ethers.parseEther("2"), 0, SUBKEY_ONLY, true)
      ).to.be.revertedWithCustomError(registry, "InsufficientAuthLevel");
    });
  });

  describe("verified ETH payments", function () {
    it("transfers ETH from the authorized sender after PQC verification", async function () {
      const txId = ethers.keccak256(ethers.toUtf8Bytes("payment-valid"));
      const amount = ethers.parseEther("0.3");
      const recipientBalanceBefore = await ethers.provider.getBalance(bob.address);

      await registry
        .connect(relayer)
        .authorizeVerifiedPayment(txId, alice.address, bob.address, amount, 0, SUBKEY_ONLY, true);
      await registry.connect(alice).executeVerifiedPayment(txId, { value: amount });

      expect(await ethers.provider.getBalance(bob.address)).to.equal(recipientBalanceBefore + amount);
      const record = await registry.getTransaction(txId);
      expect(record.verified).to.equal(true);
      expect(record.amount).to.equal(amount);
    });

    it("does not let another wallet execute an authorized payment", async function () {
      const txId = ethers.keccak256(ethers.toUtf8Bytes("payment-wrong-sender"));
      const amount = ethers.parseEther("0.1");
      await registry
        .connect(relayer)
        .authorizeVerifiedPayment(txId, alice.address, bob.address, amount, 0, SUBKEY_ONLY, true);

      await expect(
        registry.connect(other).executeVerifiedPayment(txId, { value: amount })
      ).to.be.revertedWithCustomError(registry, "PaymentSenderMismatch");
    });
  });
});
