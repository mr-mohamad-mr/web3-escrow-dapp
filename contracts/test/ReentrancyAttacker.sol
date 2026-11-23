// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../FreelanceEscrow.sol";

/// @title ReentrancyAttacker
/// @notice TEST-ONLY contract. Acts as the freelancer of an escrow and
///         tries to drain it by re-entering `withdraw()` from `receive()`.
///         A correct escrow pays it exactly once; the re-entrant call must
///         revert (ReentrancyGuard) or find a zero balance (CEI).
contract ReentrancyAttacker {
    FreelanceEscrow public escrow;

    uint256 public reentryAttempts;
    bool public reentrySucceeded;

    /// @notice Point the attacker at the escrow it is the freelancer of.
    /// @dev Test-only wiring: the escrow address is only known after the
    ///      factory creates it with this contract as freelancer.
    function setEscrow(address _escrow) external {
        escrow = FreelanceEscrow(payable(_escrow));
    }

    /// @notice Submit a delivery as the freelancer.
    function submitDelivery(string calldata deliveryHash) external {
        escrow.submitDelivery(deliveryHash);
    }

    /// @notice Trigger the payout; `receive()` fires during the transfer.
    function attackWithdraw() external {
        escrow.withdraw();
    }

    /// @notice Called when the escrow sends ETH. Tries to withdraw again.
    receive() external payable {
        reentryAttempts += 1;
        // Only try once, to keep the test deterministic.
        if (reentryAttempts == 1) {
            try escrow.withdraw() {
                reentrySucceeded = true;
            } catch {
                reentrySucceeded = false;
            }
        }
    }
}
