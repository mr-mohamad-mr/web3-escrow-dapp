// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./FreelanceEscrow.sol";

/// @title EscrowFactory
/// @notice Deploys one `FreelanceEscrow` per freelance job and keeps a
///         registry so clients/freelancers can find their escrows.
/// @dev The factory owner (platform admin) sets the arbiter, the platform
///      fee (capped at 10%) and the fee recipient. Escrow creation itself
///      is permissionless for any client.
contract EscrowFactory is Ownable {
    uint256 public constant MAX_FEE_BPS = 1000; // 10%

    address public arbiter;
    address public feeRecipient;
    uint256 public feeBps; // default 250 = 2.5%

    address[] public allEscrows;
    mapping(address => address[]) private escrowsByClient;
    mapping(address => address[]) private escrowsByFreelancer;

    error ZeroAddress();
    error SelfEscrow();
    error ZeroAmount();
    error DeadlineInPast();
    error FeeTooHigh(uint256 feeBps);

    event EscrowCreated(
        address indexed escrow,
        address indexed client,
        address indexed freelancer,
        uint256 amount,
        uint256 deadline
    );
    event MilestonesDefined(address indexed escrow, uint256[] amounts);
    event ArbiterUpdated(address indexed oldArbiter, address indexed newArbiter);
    event FeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);

    constructor(address _arbiter, address _feeRecipient, uint256 _feeBps) Ownable(msg.sender) {
        if (_arbiter == address(0) || _feeRecipient == address(0)) revert ZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh(_feeBps);

        arbiter = _arbiter;
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
    }

    /// @notice Client creates an escrow for a freelancer. The client is `msg.sender`.
    ///         Single-milestone escrow: the whole amount is one milestone.
    function createEscrow(address _freelancer, uint256 _amount, uint256 _deadline)
        external
        returns (address escrowAddress)
    {
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = _amount;
        return _create(_freelancer, amounts, _deadline);
    }

    /// @notice Client creates a milestone escrow: the job's total is the
    ///         sum of `_milestoneAmounts`, released milestone by milestone.
    ///         Each milestone amount must be > 0 (checked in the escrow).
    function createEscrowWithMilestones(
        address _freelancer,
        uint256[] calldata _milestoneAmounts,
        uint256 _deadline
    ) external returns (address escrowAddress) {
        return _create(_freelancer, _milestoneAmounts, _deadline);
    }

    function _create(address _freelancer, uint256[] memory _milestoneAmounts, uint256 _deadline)
        internal
        returns (address escrowAddress)
    {
        if (_freelancer == address(0)) revert ZeroAddress();
        if (_freelancer == msg.sender) revert SelfEscrow();
        if (_deadline <= block.timestamp) revert DeadlineInPast();

        uint256 total;
        for (uint256 i = 0; i < _milestoneAmounts.length; i++) {
            total += _milestoneAmounts[i];
        }
        if (total == 0) revert ZeroAmount();

        FreelanceEscrow escrow = new FreelanceEscrow(
            msg.sender,
            _freelancer,
            arbiter,
            total,
            _milestoneAmounts,
            _deadline,
            feeBps,
            feeRecipient
        );
        escrowAddress = address(escrow);

        allEscrows.push(escrowAddress);
        escrowsByClient[msg.sender].push(escrowAddress);
        escrowsByFreelancer[_freelancer].push(escrowAddress);

        emit EscrowCreated(escrowAddress, msg.sender, _freelancer, total, _deadline);
        if (_milestoneAmounts.length > 1) {
            emit MilestonesDefined(escrowAddress, _milestoneAmounts);
        }
    }

    // ------------------------------------------------------------------
    // Admin (platform owner only)
    // ------------------------------------------------------------------

    function setArbiter(address _arbiter) external onlyOwner {
        if (_arbiter == address(0)) revert ZeroAddress();
        address oldArbiter = arbiter;
        arbiter = _arbiter;
        emit ArbiterUpdated(oldArbiter, _arbiter);
    }

    function setFeeBps(uint256 _feeBps) external onlyOwner {
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh(_feeBps);
        uint256 oldFeeBps = feeBps;
        feeBps = _feeBps;
        emit FeeUpdated(oldFeeBps, _feeBps);
    }

    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        if (_feeRecipient == address(0)) revert ZeroAddress();
        address oldRecipient = feeRecipient;
        feeRecipient = _feeRecipient;
        emit FeeRecipientUpdated(oldRecipient, _feeRecipient);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getEscrowCount() external view returns (uint256) {
        return allEscrows.length;
    }

    function getEscrowsByClient(address _client) external view returns (address[] memory) {
        return escrowsByClient[_client];
    }

    function getEscrowsByFreelancer(address _freelancer)
        external
        view
        returns (address[] memory)
    {
        return escrowsByFreelancer[_freelancer];
    }
}
