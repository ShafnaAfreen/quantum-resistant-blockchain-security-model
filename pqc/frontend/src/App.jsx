import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { connectWallet } from "./wallet";
import { CONTRACT_ADDRESS, CONTRACT_ABI } from "./contract";
import "./App.css";

function toSecurityStatus(transaction, algorithm = "PQC") {
  if (!transaction) {
    return { epoch: null, authentication: "Awaiting verified payment", risk: "Not assessed" };
  }

  const highRisk = transaction.authLevel === "Master reinforced";
  return {
    epoch: transaction.epoch,
    authentication: `${algorithm} verified`,
    risk: highRisk ? "High — master reinforced" : "Normal — subkey auth",
  };
}

function App() {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [walletBalance, setWalletBalance] = useState("");
  const [walletError, setWalletError] = useState("");
  const [transactions, setTransactions] = useState([]);
  const [transactionStatus, setTransactionStatus] = useState("");
  const [securityStatus, setSecurityStatus] = useState(toSecurityStatus());

  async function handleConnectWallet() {
    try {
      setWalletError("");

      const wallet = await connectWallet();

      setWalletAddress(wallet.address);

      const balance = await wallet.provider.getBalance(wallet.address);

      setWalletBalance(ethers.formatEther(balance));
    } catch (error) {
      console.error(error);
      setWalletError(
        error.message || "Failed to connect wallet."
      );
    }
  }

  // Restore an already-authorized MetaMask account after a page refresh.
  // eth_accounts is permissionless and does not show another MetaMask prompt.
  useEffect(() => {
    if (!window.ethereum) {
      return;
    }

    async function updateWallet(accounts) {
      if (accounts.length === 0) {
        setWalletAddress("");
        setWalletBalance("");
      } else {
        try {
          const provider = new ethers.BrowserProvider(window.ethereum);
          const balance = await provider.getBalance(accounts[0]);
          setWalletAddress(accounts[0]);
          setWalletBalance(ethers.formatEther(balance));
        } catch (error) {
          setWalletError(error.message || "Unable to refresh wallet balance.");
        }
      }
    }

    async function restoreWallet() {
      try {
        const accounts = await window.ethereum.request({ method: "eth_accounts" });
        await updateWallet(accounts);
      } catch (error) {
        setWalletError(error.message || "Unable to restore wallet connection.");
      }
    }

    restoreWallet();
    window.ethereum.on("accountsChanged", updateWallet);
    window.ethereum.on("chainChanged", restoreWallet);

    return () => {
      window.ethereum.removeListener("accountsChanged", updateWallet);
      window.ethereum.removeListener("chainChanged", restoreWallet);
    };
  }, []);

  // Load transaction history from the actual PQC transaction registry.
  useEffect(() => {
    async function loadTransactionHistory() {
      try {
        if (!window.ethereum) {
          return;
        }

        const provider =
          new ethers.BrowserProvider(window.ethereum);

        const network = await provider.getNetwork();
        if (network.chainId !== 31337n) {
          throw new Error(
            "Switch MetaMask to Hardhat Local (chain ID 31337)."
          );
        }

        const contractCode = await provider.getCode(CONTRACT_ADDRESS);
        if (contractCode === "0x") {
          throw new Error(
            "TransactionRegistry is not deployed. Start Hardhat and run npm run deploy:local."
          );
        }

        const contract = new ethers.Contract(
          CONTRACT_ADDRESS,
          CONTRACT_ABI,
          provider
        );

        const events = await contract.queryFilter(
          contract.filters.TransactionRecorded()
        );

        const history = events.map((event) => ({
          hash: event.transactionHash,
          from: event.args.sender,
          to: event.args.recipient,
          amount: ethers.formatEther(event.args.amount),
          epoch: Number(event.args.epoch),
          authLevel:
            Number(event.args.authLevel) === 0
              ? "Subkey"
              : "Master reinforced",
        }));

        setTransactions(history.reverse());
        setSecurityStatus(toSecurityStatus(history.at(-1), "On-chain PQC"));
        setWalletError("");
      } catch (error) {
        setTransactions([]);
        setWalletError(
          error.message ||
            "Cannot reach the Hardhat network at http://127.0.0.1:8545."
        );
      }
    }

    loadTransactionHistory();
  }, []);

  async function handleTransaction() {
    try {
      setWalletError("");
      setTransactionStatus("");
      if (!walletAddress) throw new Error("Please connect your wallet first.");
      if (!ethers.isAddress(recipient)) throw new Error("Please enter a valid recipient address.");
      if (!amount || Number(amount) <= 0) throw new Error("Please enter an amount greater than zero.");

      const provider = new ethers.BrowserProvider(window.ethereum);
      const recipientCode = await provider.getCode(recipient);
      if (recipientCode !== "0x") {
        throw new Error(
          "Use a wallet address as the recipient. This local demo does not send ETH to smart contracts."
        );
      }

      setTransactionStatus("Requesting PQC verification...");
      const response = await fetch("http://127.0.0.1:3001/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: walletAddress, recipient, amount, epoch: 0 }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Relay could not submit the transaction.");

      const signer = await provider.getSigner();
      setTransactionStatus("PQC verified. Confirm the ETH payment in MetaMask...");
      // Send the exact ABI-encoded call rather than relying on a cached
      // contract wrapper in the browser. The registry accepts ETH only via
      // executeVerifiedPayment(bytes32), never as a bare transfer.
      const payment = await signer.sendTransaction({
        to: CONTRACT_ADDRESS,
        data: ethers.concat([
          ethers.id("executeVerifiedPayment(bytes32)").slice(0, 10),
          result.transaction.txId,
        ]),
        value: ethers.parseEther(result.transaction.amount),
      });
      const receipt = await payment.wait();

      if (!receipt || receipt.status === 0) {
        throw new Error("The on-chain payment was rejected or failed. No successful transfer was recorded.");
      }

      setTransactions((current) => [{
        ...result.transaction,
        hash: payment.hash,
        blockNumber: receipt.blockNumber,
      }, ...current]);
      setSecurityStatus(toSecurityStatus(result.transaction, result.transaction.algorithm));
      const refreshedBalance = await provider.getBalance(walletAddress);
      setWalletBalance(ethers.formatEther(refreshedBalance));
      setTransactionStatus(
        `Verified with ${result.transaction.algorithm}, paid to the recipient, and recorded in block ${receipt.blockNumber}.`
      );
      setRecipient("");
      setAmount("");
    } catch (error) {
      setTransactionStatus("");
      setWalletError(
        error.message || "Unable to reach the local PQC relay. Run npm run relay:server."
      );
    }
  }

  return (
    <div className="app">

      {/* HEADER */}
      <header className="header">

        <div className="brand">
          <div className="brand-icon">🛡️</div>

          <div>
            <h1>SecureChain</h1>
            <p>PQC Protected Transactions</p>
          </div>
        </div>

        <div className="header-right">

          <div className="network-badge">
            <span className="online-dot"></span>

            <div>
              <strong>Localhost 5173</strong>
              <span>Hardhat Network</span>
            </div>
          </div>

          <div className="wallet-badge">
            <span>🦊</span>

            <strong>
              {walletAddress
                ? `${walletAddress.slice(
                    0,
                    6
                  )}...${walletAddress.slice(-6)}`
                : "Not Connected"}
            </strong>
          </div>

        </div>
      </header>


      <main className="container">

        {/* TOP GRID */}
        <div className="top-grid">

          {/* WALLET CARD */}
          <section className="card wallet-card">

            <div className="wallet-heading">
              <div className="avatar">
                {walletAddress
                  ? walletAddress.slice(2, 4).toUpperCase()
                  : "SC"}
              </div>

              <div>
                <h2>Connected Wallet</h2>

                <p>
                  {walletAddress
                    ? walletAddress
                    : "Connect your MetaMask wallet"}
                </p>
              </div>
            </div>

            {walletError && (
              <div className="error">
                {walletError}
              </div>
            )}

            <div className="wallet-stats">

              <div className="wallet-stat">
                <span>Wallet Balance</span>

                <strong>
                  {walletBalance
                    ? `${Number(
                        walletBalance
                      ).toFixed(3)} ETH`
                    : "-- ETH"}
                </strong>

                <small>Updates after each confirmed payment</small>
              </div>

              <div className="wallet-stat">
                <span>Network</span>

                <strong>
                  <span className="small-dot"></span>
                  Hardhat Local
                </strong>

                <small>Chain ID: 31337</small>
              </div>

            </div>

            <button
              className="secondary-button"
              onClick={handleConnectWallet}
            >
              {walletAddress
                ? "Wallet Connected ✓"
                : "Connect Wallet"}
            </button>

          </section>


          {/* SEND TRANSACTION */}
          <section className="card send-card">

            <div className="section-heading">

              <div className="section-icon">
                ➤
              </div>

              <div>
                <h2>Record PQC Transaction</h2>
                <p>
                  Verifies, transfers ETH, and records it on-chain
                </p>
              </div>

              <div className="contract-badge">
                <span>📄</span>

                <div>
                  <strong>Contract</strong>
                  <small>
                    {CONTRACT_ADDRESS.slice(
                      0,
                      6
                    )}
                    ...
                    {CONTRACT_ADDRESS.slice(-4)}
                  </small>
                </div>
              </div>

            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Recipient Address</label>
                <input
                  type="text"
                  placeholder="0x..."
                  value={recipient}
                  onChange={(event) => setRecipient(event.target.value)}
                />
              </div>

              <div className="form-group amount-group">
                <label>Transaction Amount (ETH)</label>
                <div className="amount-input">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                  />
                  <span>ETH</span>
                </div>
              </div>
            </div>

            <button
              className="primary-button"
              onClick={handleTransaction}
            >
              Verify and record transaction
              <span>→</span>
            </button>

            {transactionStatus && (
              <p className="transaction-status">
                {transactionStatus}
              </p>
            )}

          </section>

        </div>


        {/* SECURITY STATUS */}
        <section className="security-section">

          <div className="section-title">

            <div className="shield-icon">
              🛡️
            </div>

            <div>
              <h2>Security Status</h2>

              <p>
                Real-time security information from
                the blockchain and PQC system
              </p>
            </div>

          </div>


          <div className="security-grid">

            {/* EPOCH */}
            <div className="security-card epoch">

              <div className="security-icon">
                ◉
              </div>

              <div>
                <span>Current Epoch</span>

                <small>
                  Active key epoch for authentication
                </small>

                <strong>{securityStatus.epoch ?? "—"}</strong>

                <em>{securityStatus.epoch === null ? "Awaiting payment" : "On-chain"}</em>
              </div>

            </div>


            {/* AUTHENTICATION */}
            <div className="security-card authentication">

              <div className="security-icon">
                ◎
              </div>

              <div>
                <span>Authentication</span>

                <small>
                  PQC signature verification status
                </small>

                <strong className={`status-pill ${securityStatus.epoch === null ? "pending" : "verified"}`}>
                  {securityStatus.epoch === null ? "⏳ " : "✓ "}
                  {securityStatus.authentication}
                </strong>
              </div>

            </div>


            {/* RISK */}
            <div className="security-card risk">

              <div className="security-icon">
                ▮▮▮
              </div>

              <div>
                <span>Risk Level</span>

                <small>
                  Transaction risk assessment
                </small>

                <strong className={`status-pill ${securityStatus.risk.startsWith("High") ? "pending" : "neutral"}`}>
                  {securityStatus.risk === "Not assessed" ? "— " : ""}
                  {securityStatus.risk}
                </strong>
              </div>

            </div>

          </div>

        </section>


        {/* TRANSACTION HISTORY */}
        <section className="history-section">

          <div className="history-header">

            <div className="section-title">

              <div className="history-icon">
                ◷
              </div>

              <div>
                <h2>Transaction History</h2>

                <p>
                  All transactions verified by PQC and recorded
                  by the authorized relay
                </p>
              </div>

            </div>

            <div className="transaction-count">
              {transactions.length}{" "}
              Transaction
              {transactions.length !== 1
                ? "s"
                : ""}
            </div>

          </div>


          {transactions.length === 0 ? (

            <div className="empty-history">
              <div>📭</div>
              <h3>No transactions yet</h3>
              <p>
                Run the PQC relay demo after deployment; verified
                transactions will appear here.
              </p>
            </div>

          ) : (

            <div className="table-wrapper">

              <table>

                <thead>
                  <tr>
                    <th>#</th>
                    <th>FROM</th>
                    <th>TO</th>
                    <th>AMOUNT</th>
                    <th>HASH</th>
                    <th>STATUS</th>
                  </tr>
                </thead>

                <tbody>

                  {transactions.map(
                    (tx, index) => (

                      <tr key={tx.hash}>

                        <td className="number-cell">
                          {index + 1}
                        </td>

                        <td>
                          <span className="address">
                            <span className="address-icon">
                              ◉
                            </span>

                            {tx.from.slice(
                              0,
                              6
                            )}
                            ...
                            {tx.from.slice(-4)}
                          </span>
                        </td>

                        <td>
                          <span className="address">
                            <span className="address-icon recipient">
                              ●
                            </span>

                            {tx.to.slice(
                              0,
                              6
                            )}
                            ...
                            {tx.to.slice(-4)}
                          </span>
                        </td>

                        <td>
                          <strong>
                            {tx.amount} ETH
                          </strong>
                        </td>

                        <td>
                          <span className="hash">
                            {tx.hash.slice(
                              0,
                              8
                            )}
                            ...
                            {tx.hash.slice(-6)}
                          </span>
                        </td>

                        <td>
                          <span className="confirmed">
                            ✓ {tx.authLevel}
                          </span>
                        </td>

                      </tr>

                    )
                  )}

                </tbody>

              </table>

            </div>

          )}

        </section>

      </main>

    </div>
  );
}

export default App;
