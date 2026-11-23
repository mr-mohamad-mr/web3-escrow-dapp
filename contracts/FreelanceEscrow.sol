// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title FreelanceEscrow
/// @notice Single-job escrow between a client and a freelancer, with a
///         neutral arbiter for disputes. Funds are locked by the client,
///         released to the freelancer on delivery acceptance, or split by
///         the arbiter when a dispute is raised.
///
///         Milestones: the job's total amount is split into one
///         or more milestones at creation time. Each milestone is
///         delivered, reviewed and released independently, so the
///         freelancer gets paid per completed chunk instead of waiting
///         for the whole job. A single-milestone escrow behaves exactly
///         like a classic one-shot escrow (the no-argument `submitDelivery` /
///         `release` / `requestRevision` wrappers still work).
/// @dev Security model:
///      - Checks-Effects-Interactions everywhere; all payouts use the
///        pull-over-push pattern (`pendingWithdrawals` + `withdraw`)
///        so a failing recipient can never block a settlement.
///      - `ReentrancyGuard` on every state-changing external entry point
///        that moves value.
///      - Custom errors instead of revert strings (gas + clarity).
///      - Solidity 0.8.24: built-in overflow/underflow checks.
///      - No delegatecall, no external calls except plain ETH transfers
///        in `withdraw`, and no upgradeability surface.
///      - Dispute settlement and deadline refunds split only the
///        *remaining* locked balance (`amount - releasedTotal`), so
///        already-released milestones are never re-split.
contract FreelanceEscrow is ReentrancyGuard {
    // ------------------------------------------------------------------
    // Types & state
    // ------------------------------------------------------------------

    enum Status {
        Created, // deployed, awaiting funding
        Funded, // client locked the funds, work in progress
        Delivered, // at least one milestone delivered, awaiting review
        Disputed, // dispute open, awaiting the arbiter
        Released, // all milestones released (final)
        Refunded, // remaining funds returned to the client (final)
        Cancelled, // cancelled before funding (final)
        Resolved // dispute resolved by arbiter split (final)
    }

    enum MilestoneStatus {
        Pending, // not yet delivered
        Delivered, // submitted, awaiting client review
        Released // accepted, funds credited for withdrawal
    }

    struct Milestone {
        uint256 amount;
        MilestoneStatus status;
        string deliveryHash;
        uint256 deliveredAt;
    }

    address public immutable client;
    address public immutable freelancer;
    address public immutable arbiter;
    address public immutable feeRecipient;
    uint256 public immutable amount;
    uint256 public immutable deadline;
    uint256 public immutable feeBps; // basis points, 100 = 1%

    Status public status;
    string public deliveryHash; // latest submitted delivery (any milestone)
    string public disputeReason;
    uint256 public revisionCount;
    uint256 public fundedAt;
    uint256 public deliveredAt;

    /// @notice Milestones of this job, in creation order. Their amounts
    ///         always sum to `amount`.
    Milestone[] public milestones;

    /// @notice Sum of milestone amounts already released to the freelancer.
    uint256 public releasedTotal;

    /// @notice ETH credited to an address, withdrawable via `withdraw()`.
    mapping(address => uint256) public pendingWithdrawals;

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error OnlyClient();
    error OnlyFreelancer();
    error OnlyArbiter();
    error InvalidStatus(Status current, Status expected);
    error IncorrectFunding(uint256 sent, uint256 expected);
    error DeadlineInPast();
    error DeadlineNotReached();
    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh(uint256 feeBps);
    error InvalidShare(uint256 freelancerShareBps);
    error NothingToWithdraw();
    error TransferFailed();
    error InvalidMilestones();
    error MilestoneSumMismatch(uint256 milestoneSum, uint256 amount);
    error InvalidMilestoneIndex(uint256 index);
    error InvalidMilestoneStatus(uint256 index, MilestoneStatus current, MilestoneStatus expected);
    error SingleMilestoneOnly();

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event EscrowFunded(address indexed client, uint256 amount, uint256 fundedAt);
    event DeliverySubmitted(address indexed freelancer, string deliveryHash, uint256 deliveredAt);
    event RevisionRequested(address indexed client, string reason, uint256 revisionCount);
    event Released(address indexed freelancer, uint256 freelancerAmount, uint256 feeAmount);
    event DisputeRaised(address indexed raisedBy, string reason);
    event DisputeResolved(
        address indexed arbiter,
        uint256 freelancerShareBps,
        uint256 freelancerAmount,
        uint256 clientAmount,
        uint256 feeAmount
    );
    event Cancelled(address indexed client);
    event Refunded(address indexed client, uint256 amount);
    event Withdrawn(address indexed recipient, uint256 amount);

    event MilestoneDelivered(
        uint256 indexed index,
        address indexed freelancer,
        string deliveryHash,
        uint256 deliveredAt
    );
    event MilestoneReleased(
        uint256 indexed index,
        address indexed freelancer,
        uint256 freelancerAmount,
        uint256 feeAmount
    );
    event MilestoneRevisionRequested(
        uint256 indexed index,
        address indexed client,
        string reason,
        uint256 revisionCount
    );

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    constructor(
        address _client,
        address _freelancer,
        address _arbiter,
        uint256 _amount,
        uint256[] memory _milestoneAmounts,
        uint256 _deadline,
        uint256 _feeBps,
        address _feeRecipient
    ) {
        if (_client == address(0) || _freelancer == address(0) || _arbiter == address(0)) {
            revert ZeroAddress();
        }
        if (_feeRecipient == address(0)) revert ZeroAddress();
        if (_amount == 0) revert ZeroAmount();
        if (_deadline <= block.timestamp) revert DeadlineInPast();
        if (_feeBps > 1000) revert FeeTooHigh(_feeBps); // platform fee capped at 10%
        if (_milestoneAmounts.length == 0) revert InvalidMilestones();

        uint256 milestoneSum;
        for (uint256 i = 0; i < _milestoneAmounts.length; i++) {
            if (_milestoneAmounts[i] == 0) revert InvalidMilestones();
            milestoneSum += _milestoneAmounts[i];
            milestones.push(
                Milestone({
                    amount: _milestoneAmounts[i],
                    status: MilestoneStatus.Pending,
                    deliveryHash: "",
                    deliveredAt: 0
                })
            );
        }
        if (milestoneSum != _amount) revert MilestoneSumMismatch(milestoneSum, _amount);

        client = _client;
        freelancer = _freelancer;
        arbiter = _arbiter;
        amount = _amount;
        deadline = _deadline;
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
        status = Status.Created;
    }

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------

    modifier onlyClient() {
        if (msg.sender != client) revert OnlyClient();
        _;
    }

    modifier onlyFreelancer() {
        if (msg.sender != freelancer) revert OnlyFreelancer();
        _;
    }

    modifier onlyArbiter() {
        if (msg.sender != arbiter) revert OnlyArbiter();
        _;
    }

    modifier inStatus(Status expected) {
        if (status != expected) revert InvalidStatus(status, expected);
        _;
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    /// @notice Recompute the escrow-level status from the milestones.
    ///         Only meaningful while work is in progress (Funded /
    ///         Delivered); terminal states are never touched.
    function _syncStatus() internal {
        if (status != Status.Funded && status != Status.Delivered) return;

        bool anyDelivered;
        bool allReleased = true;
        for (uint256 i = 0; i < milestones.length; i++) {
            if (milestones[i].status == MilestoneStatus.Delivered) anyDelivered = true;
            if (milestones[i].status != MilestoneStatus.Released) allReleased = false;
        }
        if (allReleased) {
            status = Status.Released;
        } else if (anyDelivered) {
            status = Status.Delivered;
        } else {
            status = Status.Funded;
        }
    }

    function _requireMilestone(uint256 _index) internal view returns (Milestone storage m) {
        if (_index >= milestones.length) revert InvalidMilestoneIndex(_index);
        return milestones[_index];
    }

    function _submitMilestoneDelivery(uint256 _index, string calldata _hash) internal {
        Milestone storage m = _requireMilestone(_index);
        if (m.status != MilestoneStatus.Pending) {
            revert InvalidMilestoneStatus(_index, m.status, MilestoneStatus.Pending);
        }

        m.status = MilestoneStatus.Delivered;
        m.deliveryHash = _hash;
        m.deliveredAt = block.timestamp;
        deliveryHash = _hash;
        deliveredAt = block.timestamp;

        emit MilestoneDelivered(_index, msg.sender, _hash, block.timestamp);
        _syncStatus();
    }

    function _requestMilestoneRevision(uint256 _index, string calldata _reason) internal {
        Milestone storage m = _requireMilestone(_index);
        if (m.status != MilestoneStatus.Delivered) {
            revert InvalidMilestoneStatus(_index, m.status, MilestoneStatus.Delivered);
        }

        revisionCount += 1;
        m.status = MilestoneStatus.Pending;

        emit MilestoneRevisionRequested(_index, msg.sender, _reason, revisionCount);
        _syncStatus();
    }

    function _releaseMilestone(uint256 _index) internal {
        Milestone storage m = _requireMilestone(_index);
        if (m.status != MilestoneStatus.Delivered) {
            revert InvalidMilestoneStatus(_index, m.status, MilestoneStatus.Delivered);
        }

        uint256 fee = (m.amount * feeBps) / 10_000;
        uint256 freelancerAmount = m.amount - fee;

        m.status = MilestoneStatus.Released;
        releasedTotal += m.amount;
        pendingWithdrawals[freelancer] += freelancerAmount;
        if (fee > 0) {
            pendingWithdrawals[feeRecipient] += fee;
        }

        emit MilestoneReleased(_index, freelancer, freelancerAmount, fee);
        _syncStatus();
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /// @notice Client locks the agreed amount. Exact value required.
    function fund() external payable onlyClient inStatus(Status.Created) nonReentrant {
        if (msg.value != amount) revert IncorrectFunding(msg.value, amount);
        if (block.timestamp > deadline) revert DeadlineInPast();

        status = Status.Funded;
        fundedAt = block.timestamp;

        emit EscrowFunded(msg.sender, msg.value, block.timestamp);
    }

    /// @notice Freelancer submits the deliverable for one milestone
    ///         (IPFS CID or content hash).
    function submitMilestoneDelivery(uint256 _index, string calldata _deliveryHash)
        external
        onlyFreelancer
    {
        if (status != Status.Funded && status != Status.Delivered) {
            revert InvalidStatus(status, Status.Funded);
        }
        _submitMilestoneDelivery(_index, _deliveryHash);
    }

    /// @notice Single-milestone convenience wrapper (legacy single-milestone API).
    function submitDelivery(string calldata _deliveryHash) external onlyFreelancer {
        if (status != Status.Funded && status != Status.Delivered) {
            revert InvalidStatus(status, Status.Funded);
        }
        if (milestones.length != 1) revert SingleMilestoneOnly();
        _submitMilestoneDelivery(0, _deliveryHash);

        emit DeliverySubmitted(msg.sender, _deliveryHash, block.timestamp);
    }

    /// @notice Client asks for changes on one milestone; it goes back to
    ///         In-Progress.
    function requestMilestoneRevision(uint256 _index, string calldata _reason)
        external
        onlyClient
    {
        if (status != Status.Funded && status != Status.Delivered) {
            revert InvalidStatus(status, Status.Funded);
        }
        _requestMilestoneRevision(_index, _reason);
    }

    /// @notice Single-milestone convenience wrapper (legacy single-milestone API).
    function requestRevision(string calldata _reason) external onlyClient {
        if (status != Status.Funded && status != Status.Delivered) {
            revert InvalidStatus(status, Status.Funded);
        }
        if (milestones.length != 1) revert SingleMilestoneOnly();
        _requestMilestoneRevision(0, _reason);

        emit RevisionRequested(msg.sender, _reason, revisionCount);
    }

    /// @notice Client accepts one milestone; its funds (minus the
    ///         platform fee) are credited for withdrawal.
    /// @dev Pull pattern: no ETH leaves the contract in this call.
    function releaseMilestone(uint256 _index) external onlyClient nonReentrant {
        if (status != Status.Funded && status != Status.Delivered) {
            revert InvalidStatus(status, Status.Funded);
        }
        _releaseMilestone(_index);
    }

    /// @notice Single-milestone convenience wrapper (legacy single-milestone API).
    function release() external onlyClient nonReentrant {
        if (status != Status.Funded && status != Status.Delivered) {
            revert InvalidStatus(status, Status.Funded);
        }
        if (milestones.length != 1) revert SingleMilestoneOnly();
        uint256 milestoneAmount = milestones[0].amount;
        uint256 fee = (milestoneAmount * feeBps) / 10_000;
        _releaseMilestone(0);

        emit Released(freelancer, milestoneAmount - fee, fee);
    }

    /// @notice Either working party can open a dispute while funds are locked
    ///         (work in progress or delivered and under review).
    function raiseDispute(string calldata _reason) external {
        if (status != Status.Funded && status != Status.Delivered) {
            revert InvalidStatus(status, Status.Funded);
        }
        if (msg.sender != client && msg.sender != freelancer) revert OnlyClient();
        disputeReason = _reason;
        status = Status.Disputed;

        emit DisputeRaised(msg.sender, _reason);
    }

    /// @notice Arbiter splits the locked funds between freelancer and client.
    /// @param _freelancerShareBps Freelancer's share in basis points (0-10000).
    /// @dev Only the *remaining* locked balance is split — milestones
    ///      already released stay paid. The platform fee applies only to
    ///      the freelancer's share.
    function resolveDispute(uint256 _freelancerShareBps)
        external
        onlyArbiter
        inStatus(Status.Disputed)
        nonReentrant
    {
        if (_freelancerShareBps > 10_000) revert InvalidShare(_freelancerShareBps);

        uint256 remaining = amount - releasedTotal;
        uint256 freelancerGross = (remaining * _freelancerShareBps) / 10_000;
        uint256 fee = (freelancerGross * feeBps) / 10_000;
        uint256 freelancerAmount = freelancerGross - fee;
        uint256 clientAmount = remaining - freelancerGross;

        status = Status.Resolved;
        if (freelancerAmount > 0) {
            pendingWithdrawals[freelancer] += freelancerAmount;
        }
        if (fee > 0) {
            pendingWithdrawals[feeRecipient] += fee;
        }
        if (clientAmount > 0) {
            pendingWithdrawals[client] += clientAmount;
        }

        emit DisputeResolved(msg.sender, _freelancerShareBps, freelancerAmount, clientAmount, fee);
    }

    /// @notice Client cancels before any funds are locked.
    function cancel() external onlyClient inStatus(Status.Created) {
        status = Status.Cancelled;

        emit Cancelled(msg.sender);
    }

    /// @notice Client reclaims the remaining locked amount if the deadline
    ///         passed with no milestone under review. Milestones already
    ///         released stay paid.
    function refundAfterDeadline() external onlyClient inStatus(Status.Funded) nonReentrant {
        if (block.timestamp <= deadline) revert DeadlineNotReached();

        uint256 remaining = amount - releasedTotal;

        status = Status.Refunded;
        pendingWithdrawals[client] += remaining;

        emit Refunded(msg.sender, remaining);
    }

    /// @notice Pull credited funds. Re-entrancy guarded (CEI pattern).
    function withdraw() external nonReentrant {
        uint256 payout = pendingWithdrawals[msg.sender];
        if (payout == 0) revert NothingToWithdraw();

        pendingWithdrawals[msg.sender] = 0;

        (bool success, ) = payable(msg.sender).call{value: payout}("");
        if (!success) {
            // Restore on failure so funds are never lost.
            pendingWithdrawals[msg.sender] = payout;
            revert TransferFailed();
        }

        emit Withdrawn(msg.sender, payout);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice Funds still locked in the escrow (not yet released).
    function remainingBalance() external view returns (uint256) {
        return amount - releasedTotal;
    }

    function milestoneCount() external view returns (uint256) {
        return milestones.length;
    }

    function getMilestone(uint256 _index) external view returns (Milestone memory) {
        if (_index >= milestones.length) revert InvalidMilestoneIndex(_index);
        return milestones[_index];
    }

    function getMilestones() external view returns (Milestone[] memory) {
        return milestones;
    }

    /// @notice Full escrow snapshot for frontends / indexers.
    function getDetails()
        external
        view
        returns (
            address _client,
            address _freelancer,
            address _arbiter,
            uint256 _amount,
            uint256 _deadline,
            uint256 _feeBps,
            Status _status,
            string memory _deliveryHash,
            uint256 _revisionCount
        )
    {
        return (
            client,
            freelancer,
            arbiter,
            amount,
            deadline,
            feeBps,
            status,
            deliveryHash,
            revisionCount
        );
    }

    /// @notice Reject accidental plain ETH transfers; funding goes via `fund()`.
    receive() external payable {
        revert IncorrectFunding(msg.value, amount);
    }
}
