import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { connectWallet } from "./wallet";
import { CONTRACT_ADDRESS, CONTRACT_ABI } from "./contract";
import "./App.css";

function App() {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [walletBalance, setWalletBalance] = useState("");
  const [walletError, setWalletError] = useState("");
  const [transactions, setTransactions] = useState([]);
  const [transactionStatus, setTransactionStatus] = useState("");

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

  // Listen for MetaMask account changes
  useEffect(() => {
    if (!window.ethereum) {
      return;
    }

    function handleAccountsChanged(accounts) {
      if (accounts.length === 0) {
        setWalletAddress("");
        setWalletBalance("");
      } else {
        setWalletAddress(accounts[0]);
      }
    }

    window.ethereum.on(
      "accountsChanged",
      handleAccountsChanged
    );

    return () => {
      window.ethereum.removeListener(
        "accountsChanged",
        handleAccountsChanged
      );
    };
  }, []);

  // Load transaction history from blockchain
  useEffect(() => {
    async function loadTransactionHistory() {
      try {
        if (!window.ethereum) {
          return;
        }

        const provider =
          new ethers.BrowserProvider(window.ethereum);

        const contract = new ethers.Contract(
          CONTRACT_ADDRESS,
          CONTRACT_ABI,
          provider
        );

        const events = await contract.queryFilter(
          contract.filters.TransactionSent()
        );

        const history = events.map((event) => ({
          hash: event.transactionHash,
          from: event.args.from,
          to: event.args.to,
          amount: ethers.formatEther(event.args.amount),
        }));

        setTransactions(history.reverse());
      } catch (error) {
        console.error(
          "Failed to load transaction history:",
          error
        );
      }
    }

    loadTransactionHistory();
  }, []);

  async function handleTransaction() {
    try {
      setWalletError("");
      setTransactionStatus("");

      if (!walletAddress) {
        throw new Error(
          "Please connect your wallet first."
        );
      }

      if (!ethers.isAddress(recipient)) {
        throw new Error(
          "Please enter a valid recipient address."
        );
      }

      if (!amount || Number(amount) <= 0) {
        throw new Error(
          "Please enter an amount greater than 0."
        );
      }

      const provider =
        new ethers.BrowserProvider(window.ethereum);

      const signer = await provider.getSigner();

      const contract = new ethers.Contract(
        CONTRACT_ADDRESS,
        CONTRACT_ABI,
        signer
      );

      setTransactionStatus(
        "Waiting for MetaMask approval..."
      );

      const tx = await contract.sendEther(recipient, {
        value: ethers.parseEther(amount),
      });

      setTransactionStatus(
        "Transaction submitted. Waiting for confirmation..."
      );

      await tx.wait();

      setTransactions((previousTransactions) => [
        {
          hash: tx.hash,
          from: walletAddress,
          to: recipient,
          amount: amount,
        },
        ...previousTransactions,
      ]);

      // Refresh wallet balance
      const updatedBalance =
        await provider.getBalance(walletAddress);

      setWalletBalance(
        ethers.formatEther(updatedBalance)
      );

      setTransactionStatus(
        "Transaction successful! 🎉"
      );

      setRecipient("");
      setAmount("");
    } catch (error) {
      console.error(error);

      setTransactionStatus("");

      setWalletError(
        error.reason ||
          error.message ||
          "Transaction failed."
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
                <span>Balance</span>

                <strong>
                  {walletBalance
                    ? `${Number(
                        walletBalance
                      ).toFixed(3)} ETH`
                    : "-- ETH"}
                </strong>
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
                <h2>Send Transaction</h2>
                <p>
                  Send ETH through the secure contract
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
                  onChange={(e) =>
                    setRecipient(e.target.value)
                  }
                />
              </div>

              <div className="form-group amount-group">
                <label>Amount (ETH)</label>

                <div className="amount-input">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) =>
                      setAmount(e.target.value)
                    }
                  />

                  <span>ETH</span>
                </div>
              </div>

            </div>


            <button
              className="primary-button"
              onClick={handleTransaction}
            >
              Review Transaction
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

                <strong>1</strong>

                <em>Demo</em>
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

                <strong className="status-pill pending">
                  ⏳ Pending PQC
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

                <strong className="status-pill neutral">
                  — Not Assessed
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
                  All transactions sent through
                  the secure contract
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
                Transactions made through the
                contract will appear here.
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
                            ✓ Confirmed
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