// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title Homer referral vault
/// @notice Referrers claim their referral rewards here themselves, in native HYPE. The team
///         funds the vault from its share of Homer's fees; stakers' share is never touched.
///
///         A claim needs a voucher signed by Homer's signer key: "account may have received
///         `total` HYPE in all, valid until `deadline`". The vault pays `total` minus what the
///         account already claimed, to the account itself (msg.sender) only. Vouchers are
///         cumulative, so a voucher can never be used twice and an old one pays nothing.
///
///         Limits, so a leaked signer key can only lose so much: at most `maxPerClaim` per
///         claim and `dailyCap` per rolling day across everyone, and only what the vault holds.
///         The owner can pause claims, change the signer and limits, and take HYPE back.
contract HomerReferralVault is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    bytes32 public constant KIND = "HomerReferralVault";
    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(address account,uint256 total,uint256 deadline)");

    address public signer;
    uint256 public maxPerClaim;
    uint256 public dailyCap;
    /// @notice The current day window: when it started and what was paid in it.
    uint256 public windowStart;
    uint256 public windowSpent;

    /// @notice What each account has claimed in all.
    mapping(address => uint256) public claimed;
    uint256 public totalClaimed;

    event HomerDeployed(bytes32 indexed kind, address indexed owner);
    event Claimed(address indexed account, uint256 amount, uint256 total);
    event Funded(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event SignerSet(address indexed signer);
    event LimitsSet(uint256 maxPerClaim, uint256 dailyCap);

    error ZeroAddress();
    error Expired();
    error BadSignature();
    error NothingToClaim();
    error OverClaimLimit();
    error OverDailyLimit();
    error TransferFailed();

    constructor(address owner_, address signer_, uint256 maxPerClaim_, uint256 dailyCap_)
        Ownable(owner_)
        EIP712("HomerReferralVault", "1")
    {
        if (signer_ == address(0)) revert ZeroAddress();
        signer = signer_;
        maxPerClaim = maxPerClaim_;
        dailyCap = dailyCap_;
        emit SignerSet(signer_);
        emit LimitsSet(maxPerClaim_, dailyCap_);
        emit HomerDeployed(KIND, owner_);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /// @notice Claims up to `total` in all for the caller, with the signer's voucher.
    function claim(uint256 total, uint256 deadline, bytes calldata signature) external nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, msg.sender, total, deadline)));
        if (ECDSA.recover(digest, signature) != signer) revert BadSignature();
        uint256 done = claimed[msg.sender];
        if (total <= done) revert NothingToClaim();
        uint256 amount = total - done;
        if (amount > maxPerClaim) revert OverClaimLimit();
        if (block.timestamp >= windowStart + 1 days) {
            windowStart = block.timestamp;
            windowSpent = 0;
        }
        if (windowSpent + amount > dailyCap) revert OverDailyLimit();
        windowSpent += amount;
        claimed[msg.sender] = total;
        totalClaimed += amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Claimed(msg.sender, amount, total);
    }

    /// @notice What can still be paid today across everyone (the rest of the daily cap).
    function dailyLeft() external view returns (uint256) {
        if (block.timestamp >= windowStart + 1 days) return dailyCap;
        return dailyCap > windowSpent ? dailyCap - windowSpent : 0;
    }

    function setSigner(address signer_) external onlyOwner {
        if (signer_ == address(0)) revert ZeroAddress();
        signer = signer_;
        emit SignerSet(signer_);
    }

    function setLimits(uint256 maxPerClaim_, uint256 dailyCap_) external onlyOwner {
        maxPerClaim = maxPerClaim_;
        dailyCap = dailyCap_;
        emit LimitsSet(maxPerClaim_, dailyCap_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(to, amount);
    }
}
