// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @title TransactionRegistry
/// @notice Layers 5 & 7 of the Quantum-Resistant Adaptive Transaction DApp.
///         Decides whether a transaction needs epoch-subkey PQC auth or
///         master-key PQC reinforcement, validates the delegation cert for
///         the epoch in question, checks a revocation registry, and stores
///         the immutable on-chain transaction record once Pallavi's PQC
///         backend (Layer 6) has confirmed signature verification off-chain.
/// @dev    Solidity cannot make HTTP calls, so the actual call to the
///         FastAPI /verify endpoint happens in an off-chain relay (see
///         scripts/relay.js). That relay is the only account allowed to
///         call submitVerifiedTransaction, via RELAYER_ROLE.
contract TransactionRegistry is AccessControl, Pausable {
    // ---------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 public constant KEY_MANAGER_ROLE = keccak256("KEY_MANAGER_ROLE");

    // ---------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------

    /// @dev Mirrors the "Normal Transaction / High-Risk Transaction" split
    ///      in the architecture diagram.
    enum AuthLevel {
        SUBKEY_ONLY, // below threshold -> epoch subkey PQC authentication
        MASTER_REINFORCED // above threshold -> master key PQC reinforcement
    }

    /// @dev Delegation certificate for an epoch subkey. Issued off-chain by
    ///      Pallavi's PQC backend when it derives a new epoch subkey from
    ///      the master key, then registered on-chain here so this contract
    ///      can validate it without ever seeing the underlying key material.
    struct DelegationCert {
        uint256 epoch;
        address subkeyOwner;
        uint256 issuedAt;
        uint256 expiresAt;
        bytes32 masterKeyId; // hash/id of the issuing master key, not the key itself
        bool exists;
    }

    /// @dev On-chain transaction record — matches the "Transaction Record"
    ///      schema in the architecture diagram (Layer 7).
    struct TxRecord {
        bytes32 txId;
        address sender;
        address recipient;
        uint256 amount;
        uint256 epoch;
        AuthLevel authLevel;
        bool verified;
        uint256 timestamp;
    }

    /// @dev Per-sender rolling volume window, used for the "rolling account
    ///      volume" leg of the threshold check.
    struct VolumeWindow {
        uint256 windowStart;
        uint256 volumeInWindow;
    }

    // ---------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------

    uint256 public valueThreshold = 1 ether;
    uint256 public volumeThreshold = 5 ether;
    uint256 public volumeWindowLength = 1 days;

    mapping(bytes32 => TxRecord) private _transactions;
    mapping(bytes32 => bool) public txIdUsed;

    mapping(uint256 => DelegationCert) public delegationCerts; // epoch => cert
    mapping(uint256 => bool) public revokedEpochs; // epoch => revoked

    mapping(address => VolumeWindow) private _volume;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    event ThresholdsUpdated(uint256 valueThreshold, uint256 volumeThreshold, uint256 windowLength);
    event DelegationCertRegistered(uint256 indexed epoch, address indexed subkeyOwner, uint256 expiresAt);
    event EpochRevoked(uint256 indexed epoch, address indexed revokedBy);
    event TransactionRecorded(
        bytes32 indexed txId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint256 epoch,
        AuthLevel authLevel
    );

    // ---------------------------------------------------------------
    // Errors (cheaper than require strings)
    // ---------------------------------------------------------------

    error TransactionAlreadyRecorded(bytes32 txId);
    error EpochCertMissing(uint256 epoch);
    error EpochCertExpired(uint256 epoch, uint256 expiredAt);
    error EpochRevokedError(uint256 epoch);
    error InsufficientAuthLevel(AuthLevel required, AuthLevel provided);
    error VerificationFailed(bytes32 txId);
    error ZeroAddress();

    // ---------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------

    /// @param admin Address that gets DEFAULT_ADMIN_ROLE + KEY_MANAGER_ROLE.
    ///              In the demo this is the Hardhat deployer account.
    /// @param relayer Address of the off-chain relay (scripts/relay.js)
    ///                that is allowed to submit verified transactions.
    constructor(address admin, address relayer) {
        if (admin == address(0) || relayer == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KEY_MANAGER_ROLE, admin);
        _grantRole(RELAYER_ROLE, relayer);
    }

    // ---------------------------------------------------------------
    // Admin: thresholds & pause
    // ---------------------------------------------------------------

    function setThresholds(
        uint256 newValueThreshold,
        uint256 newVolumeThreshold,
        uint256 newWindowLength
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        valueThreshold = newValueThreshold;
        volumeThreshold = newVolumeThreshold;
        volumeWindowLength = newWindowLength;
        emit ThresholdsUpdated(newValueThreshold, newVolumeThreshold, newWindowLength);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------
    // Key manager: delegation certs & revocation registry
    // ---------------------------------------------------------------

    /// @notice Register a delegation cert for an epoch subkey. Called by
    ///         the key manager (in the demo: same as admin) once Pallavi's
    ///         PQC backend has derived and issued that epoch's subkey.
    function registerDelegationCert(
        uint256 epoch,
        address subkeyOwner,
        uint256 issuedAt,
        uint256 expiresAt,
        bytes32 masterKeyId
    ) external onlyRole(KEY_MANAGER_ROLE) {
        if (subkeyOwner == address(0)) revert ZeroAddress();
        delegationCerts[epoch] = DelegationCert({
            epoch: epoch,
            subkeyOwner: subkeyOwner,
            issuedAt: issuedAt,
            expiresAt: expiresAt,
            masterKeyId: masterKeyId,
            exists: true
        });
        emit DelegationCertRegistered(epoch, subkeyOwner, expiresAt);
    }

    /// @notice Revoke an epoch subkey (e.g. suspected compromise). Once
    ///         revoked, no transaction can be recorded against that epoch,
    ///         regardless of what the delegation cert says.
    function revokeEpoch(uint256 epoch) external onlyRole(KEY_MANAGER_ROLE) {
        revokedEpochs[epoch] = true;
        emit EpochRevoked(epoch, msg.sender);
    }

    /// @notice True if the epoch has a registered, non-expired,
    ///         non-revoked delegation cert.
    function isEpochValid(uint256 epoch) public view returns (bool) {
        DelegationCert storage cert = delegationCerts[epoch];
        if (!cert.exists) return false;
        if (revokedEpochs[epoch]) return false;
        if (block.timestamp > cert.expiresAt) return false;
        return true;
    }

    // ---------------------------------------------------------------
    // Threshold logic (Normal vs High-Risk transaction)
    // ---------------------------------------------------------------

    /// @notice Determines whether a transaction requires only the epoch
    ///         subkey, or master-key PQC reinforcement — either because the
    ///         single transaction exceeds valueThreshold, or because the
    ///         sender's rolling volume in the current window would exceed
    ///         volumeThreshold.
    function determineRequiredAuthLevel(address sender, uint256 amount) public view returns (AuthLevel) {
        if (amount > valueThreshold) {
            return AuthLevel.MASTER_REINFORCED;
        }

        VolumeWindow storage vw = _volume[sender];
        uint256 projectedVolume = amount;
        if (block.timestamp < vw.windowStart + volumeWindowLength) {
            projectedVolume += vw.volumeInWindow;
        }
        if (projectedVolume > volumeThreshold) {
            return AuthLevel.MASTER_REINFORCED;
        }

        return AuthLevel.SUBKEY_ONLY;
    }

    function _recordVolume(address sender, uint256 amount) internal {
        VolumeWindow storage vw = _volume[sender];
        if (block.timestamp >= vw.windowStart + volumeWindowLength) {
            vw.windowStart = block.timestamp;
            vw.volumeInWindow = amount;
        } else {
            vw.volumeInWindow += amount;
        }
    }

    // ---------------------------------------------------------------
    // Verification & Storage (Layer 7)
    // ---------------------------------------------------------------

    /// @notice Called by the off-chain relay AFTER it has already hit
    ///         Pallavi's FastAPI /verify endpoint. Re-checks the threshold
    ///         and cert validity on-chain (so the relay can't lie about
    ///         them), then — only if verificationResult is true — writes
    ///         the immutable transaction record.
    /// @param txId Unique id for this transaction (e.g. keccak256 of the
    ///             signed payload — agree the exact derivation with Shafna
    ///             so frontend and contract compute the same id).
    /// @param authLevelUsed The auth level the PQC backend actually used
    ///                      (SUBKEY_ONLY or MASTER_REINFORCED) — must meet
    ///                      or exceed what determineRequiredAuthLevel demands.
    /// @param verificationResult The pass/fail result of the PQC signature
    ///                           verification, as returned by /verify.
    function submitVerifiedTransaction(
        bytes32 txId,
        address sender,
        address recipient,
        uint256 amount,
        uint256 epoch,
        AuthLevel authLevelUsed,
        bool verificationResult
    ) external onlyRole(RELAYER_ROLE) whenNotPaused {
        if (txIdUsed[txId]) revert TransactionAlreadyRecorded(txId);
        if (sender == address(0) || recipient == address(0)) revert ZeroAddress();

        if (!delegationCerts[epoch].exists) revert EpochCertMissing(epoch);
        if (revokedEpochs[epoch]) revert EpochRevokedError(epoch);
        if (block.timestamp > delegationCerts[epoch].expiresAt) {
            revert EpochCertExpired(epoch, delegationCerts[epoch].expiresAt);
        }

        AuthLevel required = determineRequiredAuthLevel(sender, amount);
        if (uint8(authLevelUsed) < uint8(required)) {
            revert InsufficientAuthLevel(required, authLevelUsed);
        }

        if (!verificationResult) revert VerificationFailed(txId);

        txIdUsed[txId] = true;
        _transactions[txId] = TxRecord({
            txId: txId,
            sender: sender,
            recipient: recipient,
            amount: amount,
            epoch: epoch,
            authLevel: authLevelUsed,
            verified: true,
            timestamp: block.timestamp
        });

        _recordVolume(sender, amount);

        emit TransactionRecorded(txId, sender, recipient, amount, epoch, authLevelUsed);
    }

    function getTransaction(bytes32 txId) external view returns (TxRecord memory) {
        return _transactions[txId];
    }
}
