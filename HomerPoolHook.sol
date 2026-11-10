// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @dev Uniswap v4 types as the PoolManager's ABI sees them (Currency = address, BalanceDelta = int256).
struct HookPoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct HookSwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IHookPoolManager {
    function take(address currency, address to, uint256 amount) external;
}

/// @title Homer pool hook
/// @notice Attached to the pools created on Homer. A pool's fee is split between its liquidity
///         providers and Homer: the pool's LP fee is 90% of the fee the creator chose, and this
///         hook takes the other 10% on every swap, whoever provided the liquidity. A 1% pool:
///         0.9% to LPs, 0.1% to Homer, 1% for the trader. The cut is taken from the swap's
///         unspecified side (what the trader receives on an exact-input swap) and sent straight
///         to `recipient` (Homer's fee router).
///         Pools must use a static LP fee of at most 9% (10% in total). The cut cannot be
///         changed; the owner can only change where it is sent.
contract HomerPoolHook is Ownable2Step {
    bytes32 public constant KIND = "HomerPoolHook";
    /// @notice Hook permissions encoded in this contract's address: beforeInitialize,
    ///         afterSwap and afterSwapReturnDelta (bits 13, 6 and 2), nothing else.
    uint160 public constant FLAGS = (1 << 13) | (1 << 6) | (1 << 2);
    uint160 private constant ALL_FLAGS = (1 << 14) - 1;
    /// @notice Highest LP fee a Homer pool may have: 9% (so 10% in total with Homer's cut).
    uint24 public constant MAX_LP_FEE = 90_000;
    uint24 private constant DYNAMIC_FEE_FLAG = 0x800000;

    IHookPoolManager public immutable poolManager;
    address public recipient;

    event HomerDeployed(bytes32 indexed kind, address indexed owner);
    /// @notice Homer's cut of one swap.
    event HomerFee(bytes32 indexed poolId, address indexed currency, uint256 amount);
    event RecipientSet(address indexed recipient);

    error WrongAddress();
    error NotPoolManager();
    error BadFee();
    error ZeroAddress();

    constructor(address poolManager_, address owner_, address recipient_) Ownable(owner_) {
        if (poolManager_ == address(0) || recipient_ == address(0)) revert ZeroAddress();
        if (uint160(address(this)) & ALL_FLAGS != FLAGS) revert WrongAddress(); // deployed at a mined address
        poolManager = IHookPoolManager(poolManager_);
        recipient = recipient_;
        emit RecipientSet(recipient_);
        emit HomerDeployed(KIND, owner_);
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    /// @dev Only static LP fees up to MAX_LP_FEE: the split must be what the pool shows.
    function beforeInitialize(address, HookPoolKey calldata key, uint160) external view onlyPoolManager returns (bytes4) {
        if (key.fee & DYNAMIC_FEE_FLAG != 0 || key.fee == 0 || key.fee > MAX_LP_FEE) revert BadFee();
        return this.beforeInitialize.selector;
    }

    /// @dev Homer's cut: the LP fee rate / 9 of the unspecified amount, taken to `recipient`.
    function afterSwap(address, HookPoolKey calldata key, HookSwapParams calldata params, int256 delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        bool exactIn = params.amountSpecified < 0;
        bool specifiedIs0 = exactIn == params.zeroForOne;
        int128 amount = specifiedIs0 ? int128(delta) : int128(delta >> 128); // the unspecified side
        address currency = specifiedIs0 ? key.currency1 : key.currency0;
        uint256 abs = amount < 0 ? uint256(uint128(-amount)) : uint256(uint128(amount));
        uint256 cut = (abs * key.fee) / (9 * 1_000_000);
        if (cut == 0) return (this.afterSwap.selector, 0);
        poolManager.take(currency, recipient, cut);
        emit HomerFee(_poolId(key), currency, cut);
        return (this.afterSwap.selector, int128(int256(cut)));
    }

    function setRecipient(address recipient_) external onlyOwner {
        if (recipient_ == address(0)) revert ZeroAddress();
        recipient = recipient_;
        emit RecipientSet(recipient_);
    }

    function _poolId(HookPoolKey calldata key) private pure returns (bytes32) {
        return keccak256(abi.encode(key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks));
    }
}
