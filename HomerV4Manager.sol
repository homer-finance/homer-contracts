// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @dev Uniswap v4 PoolKey as the ABI sees it (Currency = address).
struct V4Key {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @dev Uniswap v4-periphery PositionManager (positions are ERC-721s).
interface IV4PositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
    function permit2() external view returns (address);
    function poolManager() external view returns (address);
    function getPoolAndPositionInfo(uint256 tokenId) external view returns (V4Key memory, uint256);
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
}

interface IV4PoolManagerInit {
    function initialize(V4Key memory key, uint160 sqrtPriceX96) external returns (int24 tick);
}

/// @dev Uniswap v4 SwapParams.
struct V4SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

/// @dev What a rebalance swap needs from the PoolManager (flash accounting).
interface IV4PoolManagerSwap {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(V4Key memory key, V4SwapParams memory params, bytes calldata hookData) external returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @title Homer v4 liquidity manager
/// @notice Holds Uniswap v4 positions for their owners through a v4 PositionManager, the way
///         HomerLiquidityManager does for v3. Only the owner can add to, collect from, remove or
///         withdraw a position; withdrawing hands over the position NFT itself.
///         Each fee collection sends `feeBps` of the fees to the treasury, except in pools that
///         use a fee-free hook (Homer's pool hook already takes Homer's cut on every swap there).
///         Can also create a pool (PoolManager.initialize) in the same transaction as the first
///         position. Native HYPE pools are paid in native HYPE.
///         Version 2 adds `rebalance`: move a position to a new range in one transaction.
contract HomerV4Manager is IERC721Receiver, Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant KIND = "HomerV4Manager";
    /// @notice 2: adds `rebalance`.
    /// @notice 2: one-click rebalance. 3: zap (open a position with one token).
    uint256 public constant VERSION = 3;
    uint16 public constant MAX_FEE_BPS = 2500;
    uint16 private constant BPS = 10_000;

    // Uniswap v4-periphery Actions.
    uint8 private constant INCREASE_LIQUIDITY = 0x00;
    uint8 private constant DECREASE_LIQUIDITY = 0x01;
    uint8 private constant MINT_POSITION = 0x02;
    uint8 private constant BURN_POSITION = 0x03;
    uint8 private constant MINT_POSITION_FROM_DELTAS = 0x05;
    uint8 private constant SETTLE = 0x0b;
    uint8 private constant SETTLE_PAIR = 0x0d;
    uint8 private constant TAKE_PAIR = 0x11;
    uint8 private constant SWEEP = 0x14;

    uint16 public feeBps;
    address public treasury;

    /// @notice v4 PositionManagers positions may live in.
    mapping(address => bool) public isAllowed;
    address[] private _posms;
    /// @notice The PoolManager behind each allowed PositionManager: it pays native HYPE out
    ///         directly when fees or liquidity are taken to this contract.
    mapping(address => bool) public isPoolManager;
    /// @notice Hooks whose pools pay Homer on every swap: no share of LP fees there.
    mapping(address => bool) public feeFreeHook;

    struct Position {
        address posm;
        uint256 tokenId;
    }

    mapping(address => mapping(uint256 => address)) public ownerOf; // posm => tokenId => owner
    mapping(address => Position[]) private _positions;
    mapping(address => mapping(uint256 => uint256)) private _index; // posm => tokenId => index + 1

    /// @dev The NFT this contract is minting right now, the only one it accepts.
    address private _minting;
    /// @dev The PoolManager this contract has unlocked for a rebalance swap: the only caller
    ///      `unlockCallback` accepts, and only during that call.
    address private _unlocking;

    uint160 private constant MIN_SQRT_PRICE = 4295128739;
    uint160 private constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    event HomerDeployed(bytes32 indexed kind, address indexed owner);
    event Minted(address indexed user, address indexed manager, uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    event Increased(address indexed user, address indexed manager, uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    event Decreased(address indexed user, address indexed manager, uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    /// @dev Same signature as HomerLiquidityManager's, so Homer counts both the same way.
    event FeesCollected(
        address indexed user,
        address indexed manager,
        uint256 indexed tokenId,
        address token0,
        address token1,
        uint256 lp0,
        uint256 lp1,
        uint256 fee0,
        uint256 fee1
    );
    event Withdrawn(address indexed user, address indexed manager, uint256 indexed tokenId, address to);
    event PoolCreated(address indexed manager, bytes32 indexed poolId, uint160 sqrtPriceX96);
    event Rebalanced(address indexed user, address indexed manager, uint256 indexed oldTokenId, uint256 newTokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    event FeeSet(uint16 previous, uint16 current);
    event TreasurySet(address indexed previous, address indexed current);
    event ManagerSet(address indexed manager, bool allowed);
    event FeeFreeHookSet(address indexed hook, bool on);

    error ZeroAddress();
    error FeeTooHigh();
    error NotAllowed();
    error NotOwner();
    error Expired();
    error ZeroLiquidity();
    error BadValue();
    error NativeTransferFailed();
    error UnexpectedNft();
    error UnexpectedSender();
    error BadSwap();
    error SlippageExceeded();

    constructor(address owner_, address treasury_, uint16 feeBps_, address[] memory posms_, address[] memory feeFreeHooks_) Ownable(owner_) {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        treasury = treasury_;
        feeBps = feeBps_;
        for (uint256 i; i < posms_.length; ++i) _setManager(posms_[i], true);
        for (uint256 i; i < feeFreeHooks_.length; ++i) feeFreeHook[feeFreeHooks_[i]] = true;
        emit FeeSet(0, feeBps_);
        emit TreasurySet(address(0), treasury_);
        emit HomerDeployed(KIND, owner_);
    }

    modifier onlyPositionOwner(address posm, uint256 tokenId) {
        if (ownerOf[posm][tokenId] != msg.sender) revert NotOwner();
        _;
    }

    modifier before(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    // ------------------------------------------------------------------ positions

    struct MintArgs {
        address posm;
        V4Key key;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint128 amount0Max;
        uint128 amount1Max;
        uint256 deadline;
        uint160 createAtSqrtPriceX96; // non-zero: create the pool at this price first (if it does not exist)
    }

    /// @notice Opens a position in a v4 pool (creating the pool first if asked). Pay native HYPE
    ///         as msg.value (exactly amount0Max when currency0 is native); approve this contract
    ///         for ERC-20 sides. Anything not used comes back.
    function mint(MintArgs calldata a) external payable nonReentrant whenNotPaused before(a.deadline) returns (uint256 tokenId) {
        if (!isAllowed[a.posm]) revert NotAllowed();
        if (a.liquidity == 0) revert ZeroLiquidity();
        if (a.createAtSqrtPriceX96 != 0) _createIfMissing(a.posm, a.key, a.createAtSqrtPriceX96);
        IV4PositionManager pm = IV4PositionManager(a.posm);
        tokenId = pm.nextTokenId();
        bytes memory actions = abi.encodePacked(MINT_POSITION, SETTLE_PAIR, SWEEP);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(a.key, a.tickLower, a.tickUpper, uint256(a.liquidity), a.amount0Max, a.amount1Max, address(this), bytes(""));
        params[1] = abi.encode(a.key.currency0, a.key.currency1);
        params[2] = abi.encode(a.key.currency0, address(this)); // native left over comes back here
        _minting = a.posm;
        (uint256 used0, uint256 used1) = _pay(pm, a.key, a.amount0Max, a.amount1Max, abi.encode(actions, params), a.deadline);
        _minting = address(0);
        if (IERC721(a.posm).ownerOf(tokenId) != address(this)) revert UnexpectedNft();
        _register(msg.sender, a.posm, tokenId);
        emit Minted(msg.sender, a.posm, tokenId, a.liquidity, used0, used1);
    }

    struct IncreaseArgs {
        address posm;
        uint256 tokenId;
        uint128 liquidity;
        uint128 amount0Max;
        uint128 amount1Max;
        uint256 deadline;
    }

    /// @notice Adds to a position. Fees it earned so far are paid out first.
    function increase(IncreaseArgs calldata a)
        external
        payable
        nonReentrant
        whenNotPaused
        before(a.deadline)
        onlyPositionOwner(a.posm, a.tokenId)
    {
        if (a.liquidity == 0) revert ZeroLiquidity();
        IV4PositionManager pm = IV4PositionManager(a.posm);
        (V4Key memory key,) = pm.getPoolAndPositionInfo(a.tokenId);
        _collect(a.posm, a.tokenId, key, msg.sender);
        bytes memory actions = abi.encodePacked(INCREASE_LIQUIDITY, SETTLE_PAIR, SWEEP);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(a.tokenId, uint256(a.liquidity), a.amount0Max, a.amount1Max, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        params[2] = abi.encode(key.currency0, address(this));
        (uint256 used0, uint256 used1) = _pay(pm, key, a.amount0Max, a.amount1Max, abi.encode(actions, params), a.deadline);
        emit Increased(msg.sender, a.posm, a.tokenId, a.liquidity, used0, used1);
    }

    /// @notice Pays out the fees a position earned (Homer's share to the treasury).
    function collect(address posm, uint256 tokenId) external nonReentrant onlyPositionOwner(posm, tokenId) returns (uint256 lp0, uint256 lp1) {
        (V4Key memory key,) = IV4PositionManager(posm).getPoolAndPositionInfo(tokenId);
        return _collect(posm, tokenId, key, msg.sender);
    }

    struct DecreaseArgs {
        address posm;
        uint256 tokenId;
        uint128 liquidity;
        uint128 amount0Min;
        uint128 amount1Min;
        uint256 deadline;
    }

    /// @notice Removes liquidity to your wallet, after paying out the fees earned so far.
    ///         Always available, including while paused.
    function decrease(DecreaseArgs calldata a)
        external
        nonReentrant
        before(a.deadline)
        onlyPositionOwner(a.posm, a.tokenId)
        returns (uint256 amount0, uint256 amount1)
    {
        if (a.liquidity == 0) revert ZeroLiquidity();
        IV4PositionManager pm = IV4PositionManager(a.posm);
        (V4Key memory key,) = pm.getPoolAndPositionInfo(a.tokenId);
        _collect(a.posm, a.tokenId, key, msg.sender);
        uint256 b0 = _balanceOf(key.currency0, msg.sender);
        uint256 b1 = _balanceOf(key.currency1, msg.sender);
        bytes memory actions = abi.encodePacked(DECREASE_LIQUIDITY, TAKE_PAIR);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(a.tokenId, uint256(a.liquidity), a.amount0Min, a.amount1Min, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, msg.sender);
        pm.modifyLiquidities(abi.encode(actions, params), a.deadline);
        amount0 = _balanceOf(key.currency0, msg.sender) - b0;
        amount1 = _balanceOf(key.currency1, msg.sender) - b1;
        emit Decreased(msg.sender, a.posm, a.tokenId, a.liquidity, amount0, amount1);
    }

    /// @notice Takes a position out of Homer: fees are paid out, then the NFT goes to `to`.
    ///         Always available, including while paused.
    function withdraw(address posm, uint256 tokenId, address to) external nonReentrant onlyPositionOwner(posm, tokenId) {
        if (to == address(0) || to == address(this)) revert ZeroAddress();
        (V4Key memory key,) = IV4PositionManager(posm).getPoolAndPositionInfo(tokenId);
        _collect(posm, tokenId, key, msg.sender);
        _unregister(msg.sender, posm, tokenId);
        IERC721(posm).safeTransferFrom(address(this), to, tokenId);
        emit Withdrawn(msg.sender, posm, tokenId, to);
    }

    /// @param remove0Min / remove1Min  Minimums for taking the old liquidity out.
    /// @param zeroForOne  Swap direction in the position's own pool (currency0 -> currency1 if true).
    /// @param swapIn      Exact amount swapped, taken only from the removed principal; 0 = no swap.
    /// @param swapOutMin  Minimum received from the swap.
    /// @param liquidityMin  Least liquidity the new position must get. It gets the most the
    ///                      principal buys at the price when the transaction runs; anything the
    ///                      new range does not use is returned.
    struct RebalanceArgs {
        address posm;
        uint256 tokenId;
        int24 tickLower;
        int24 tickUpper;
        uint128 remove0Min;
        uint128 remove1Min;
        bool zeroForOne;
        uint256 swapIn;
        uint256 swapOutMin;
        uint128 liquidityMin;
        uint256 deadline;
    }

    /// @notice Moves a position to a new range in one transaction: earned fees are paid out
    ///         (Homer's share taken as in `collect`), the old position is closed, `swapIn` of the
    ///         principal is swapped in the same pool, and a new position is opened with it.
    ///         Whatever the new range does not use is returned. Principal is never charged.
    ///         All or nothing.
    function rebalance(RebalanceArgs calldata a)
        external
        nonReentrant
        whenNotPaused
        before(a.deadline)
        onlyPositionOwner(a.posm, a.tokenId)
        returns (uint256 tokenId)
    {
        if (!isAllowed[a.posm]) revert NotAllowed();
        if (a.liquidityMin == 0) revert ZeroLiquidity();
        IV4PositionManager pm = IV4PositionManager(a.posm);
        (V4Key memory key,) = pm.getPoolAndPositionInfo(a.tokenId);
        _collect(a.posm, a.tokenId, key, msg.sender);

        // Close the old position: all its liquidity, to this contract.
        uint256 b0 = _balanceOf(key.currency0, address(this));
        uint256 b1 = _balanceOf(key.currency1, address(this));
        {
            bytes memory actions = abi.encodePacked(BURN_POSITION, TAKE_PAIR);
            bytes[] memory params = new bytes[](2);
            params[0] = abi.encode(a.tokenId, a.remove0Min, a.remove1Min, bytes(""));
            params[1] = abi.encode(key.currency0, key.currency1, address(this));
            pm.modifyLiquidities(abi.encode(actions, params), a.deadline);
        }
        b0 = _balanceOf(key.currency0, address(this)) - b0;
        b1 = _balanceOf(key.currency1, address(this)) - b1;
        _unregister(msg.sender, a.posm, a.tokenId);

        if (a.swapIn > 0) (b0, b1) = _swapInPool(pm.poolManager(), key, a.zeroForOne, a.swapIn, a.swapOutMin, b0, b1);

        uint128 liquidity;
        uint256 used0;
        uint256 used1;
        (tokenId, liquidity, used0, used1) = _mintFrom(pm, a.posm, key, a.tickLower, a.tickUpper, b0, b1, a.liquidityMin, a.deadline);
        emit Rebalanced(msg.sender, a.posm, a.tokenId, tokenId, liquidity, used0, used1);
    }

    /// @param zeroForOne  true: you deposit currency0 (native HYPE: as msg.value) and part of it
    ///                    is swapped to currency1; false: the other way round.
    /// @param amountIn    What you deposit, in that one currency.
    /// @param swapIn      How much of it is swapped in the pool before the position opens.
    /// @param swapOutMin  Minimum received from the swap.
    /// @param liquidityMin  Least liquidity the position must get.
    struct ZapArgs {
        address posm;
        V4Key key;
        int24 tickLower;
        int24 tickUpper;
        bool zeroForOne;
        uint256 amountIn;
        uint256 swapIn;
        uint256 swapOutMin;
        uint128 liquidityMin;
        uint256 deadline;
    }

    /// @notice Opens a position with one token only: `swapIn` of it is swapped in the pool's own
    ///         liquidity, then the position opens with both sides. Whatever the range does not
    ///         use comes back. All or nothing.
    function zap(ZapArgs calldata a) external payable nonReentrant whenNotPaused before(a.deadline) returns (uint256 tokenId) {
        if (!isAllowed[a.posm]) revert NotAllowed();
        if (a.liquidityMin == 0) revert ZeroLiquidity();
        if (a.amountIn == 0 || a.swapIn > a.amountIn) revert BadSwap();
        IV4PositionManager pm = IV4PositionManager(a.posm);
        V4Key memory key = a.key;
        address cin = a.zeroForOne ? key.currency0 : key.currency1;
        // Native HYPE comes as msg.value, exactly; a token is pulled (what arrives, after any tax).
        uint256 got;
        if (cin == address(0)) {
            if (msg.value != a.amountIn) revert BadValue();
            got = a.amountIn;
        } else {
            if (msg.value != 0) revert BadValue();
            got = _pull(cin, a.amountIn);
        }
        uint256 b0 = a.zeroForOne ? got : 0;
        uint256 b1 = a.zeroForOne ? 0 : got;
        if (a.swapIn > 0) (b0, b1) = _swapInPool(pm.poolManager(), key, a.zeroForOne, _min(a.swapIn, got), a.swapOutMin, b0, b1);
        uint128 liquidity;
        uint256 used0;
        uint256 used1;
        (tokenId, liquidity, used0, used1) = _mintFrom(pm, a.posm, key, a.tickLower, a.tickUpper, b0, b1, a.liquidityMin, a.deadline);
        emit Minted(msg.sender, a.posm, tokenId, liquidity, used0, used1);
    }

    /// @dev Opens a range with b0 / b1 held here for the caller: they are paid in, the
    ///      PositionManager mints the most liquidity they buy at the price when this runs, and
    ///      the rest goes back to the caller. The position is the caller's.
    function _mintFrom(
        IV4PositionManager pm,
        address posm,
        V4Key memory key,
        int24 tickLower,
        int24 tickUpper,
        uint256 b0,
        uint256 b1,
        uint128 liquidityMin,
        uint256 deadline
    ) private returns (uint256 tokenId, uint128 liquidity, uint256 used0, uint256 used1) {
        tokenId = pm.nextTokenId();
        bytes memory data;
        {
            bytes memory actions = abi.encodePacked(SETTLE, SETTLE, MINT_POSITION_FROM_DELTAS, TAKE_PAIR);
            bytes[] memory params = new bytes[](4);
            params[0] = abi.encode(key.currency0, b0, true);
            params[1] = abi.encode(key.currency1, b1, true);
            params[2] = abi.encode(key, tickLower, tickUpper, uint128(b0), uint128(b1), address(this), bytes(""));
            params[3] = abi.encode(key.currency0, key.currency1, address(this));
            data = abi.encode(actions, params);
        }
        uint256 before0 = _balanceOf(key.currency0, address(this)) - b0;
        uint256 before1 = _balanceOf(key.currency1, address(this)) - b1;
        _minting = posm;
        (used0, used1) = _spend(pm, key, b0, b1, data, deadline, before0, before1);
        _minting = address(0);
        if (IERC721(posm).ownerOf(tokenId) != address(this)) revert UnexpectedNft();
        liquidity = pm.getPositionLiquidity(tokenId);
        if (liquidity < liquidityMin) revert SlippageExceeded();
        _register(msg.sender, posm, tokenId);
        _send(key.currency0, msg.sender, b0 - used0);
        _send(key.currency1, msg.sender, b1 - used1);
    }

    /// @dev The rebalance swap, inside the PoolManager's unlock. Only that PoolManager, and only
    ///      while this contract has it unlocked, can call this.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != _unlocking || msg.sender == address(0)) revert UnexpectedSender();
        (V4Key memory key, bool zeroForOne, uint256 amountIn) = abi.decode(data, (V4Key, bool, uint256));
        IV4PoolManagerSwap pmgr = IV4PoolManagerSwap(msg.sender);
        int256 delta = pmgr.swap(
            key,
            V4SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1}),
            bytes("")
        );
        // BalanceDelta: amount0 in the upper 128 bits, amount1 in the lower; negative = owed.
        _settleDelta(pmgr, key.currency0, int128(delta >> 128));
        _settleDelta(pmgr, key.currency1, int128(delta));
        return "";
    }

    /// @dev Only the NFT this contract is minting is accepted; anything else is refused.
    function onERC721Received(address operator, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != _minting || operator != msg.sender) revert UnexpectedNft();
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @dev Native HYPE: refunds from a PositionManager, and fees its PoolManager pays out.
    receive() external payable {
        if (!isAllowed[msg.sender] && !isPoolManager[msg.sender]) revert BadValue();
    }

    // ------------------------------------------------------------------ views

    function positionsOf(address user) external view returns (Position[] memory) {
        return _positions[user];
    }

    function positionCount(address user) external view returns (uint256) {
        return _positions[user].length;
    }

    function managers() external view returns (address[] memory) {
        return _posms;
    }

    // ------------------------------------------------------------------ internals

    function _createIfMissing(address posm, V4Key calldata key, uint160 sqrtPriceX96) private {
        IV4PoolManagerInit pmgr = IV4PoolManagerInit(IV4PositionManager(posm).poolManager());
        // initialize reverts if the pool exists; that only means there is nothing to create.
        try pmgr.initialize(key, sqrtPriceX96) {
            emit PoolCreated(address(pmgr), keccak256(abi.encode(key)), sqrtPriceX96);
        } catch {}
    }

    /// @dev Pulls the budget from the caller, runs the PositionManager call, refunds what is
    ///      left, and returns what was actually used.
    function _pay(IV4PositionManager pm, V4Key memory key, uint128 max0, uint128 max1, bytes memory data, uint256 deadline)
        private
        returns (uint256 used0, uint256 used1)
    {
        bool native0 = key.currency0 == address(0);
        if (native0 ? msg.value != max0 : msg.value != 0) revert BadValue();
        // Balances before this call: only what this call brought in is ever refunded, so tokens
        // sent here by mistake can never pay for someone's position.
        uint256 before0 = native0 ? address(this).balance - msg.value : IERC20(key.currency0).balanceOf(address(this));
        uint256 before1 = IERC20(key.currency1).balanceOf(address(this));
        uint256 got0 = native0 ? max0 : _pull(key.currency0, max0);
        uint256 got1 = _pull(key.currency1, max1);
        (used0, used1) = _spend(pm, key, got0, got1, data, deadline, before0, before1);
        // Refund what the PositionManager did not use.
        _send(key.currency0, msg.sender, got0 - used0);
        _send(key.currency1, msg.sender, got1 - used1);
    }

    /// @dev Runs a PositionManager call funded with got0 / got1 held by this contract (native
    ///      HYPE sent as value), and returns what it used. before0 / before1: this contract's
    ///      balances without those funds, so only the funds of this call are ever counted.
    function _spend(
        IV4PositionManager pm,
        V4Key memory key,
        uint256 got0,
        uint256 got1,
        bytes memory data,
        uint256 deadline,
        uint256 before0,
        uint256 before1
    ) private returns (uint256 used0, uint256 used1) {
        bool native0 = key.currency0 == address(0);
        address permit2 = pm.permit2();
        if (!native0) _allow(permit2, key.currency0, address(pm), got0);
        _allow(permit2, key.currency1, address(pm), got1);
        pm.modifyLiquidities{value: native0 ? got0 : 0}(data, deadline);
        uint256 left0 = _balanceOf(key.currency0, address(this)) - before0;
        uint256 left1 = IERC20(key.currency1).balanceOf(address(this)) - before1;
        used0 = got0 - _min(left0, got0);
        used1 = got1 - _min(left1, got1);
        if (!native0) IERC20(key.currency0).forceApprove(permit2, 0);
        IERC20(key.currency1).forceApprove(permit2, 0);
    }

    /// @dev Swaps `a.swapIn` of the principal in the position's own pool; returns the new
    ///      principal on each side, measured from balances.
    function _swapInPool(
        address poolManager,
        V4Key memory key,
        bool zeroForOne,
        uint256 swapIn,
        uint256 swapOutMin,
        uint256 b0,
        uint256 b1
    ) private returns (uint256, uint256) {
        if (swapIn > (zeroForOne ? b0 : b1) || swapIn > uint256(type(int256).max)) revert BadSwap();
        address cin = zeroForOne ? key.currency0 : key.currency1;
        address cout = zeroForOne ? key.currency1 : key.currency0;
        uint256 inBefore = _balanceOf(cin, address(this));
        uint256 outBefore = _balanceOf(cout, address(this));
        _unlocking = poolManager;
        IV4PoolManagerSwap(poolManager).unlock(abi.encode(key, zeroForOne, swapIn));
        _unlocking = address(0);
        uint256 paid = inBefore - _balanceOf(cin, address(this));
        uint256 got = _balanceOf(cout, address(this)) - outBefore;
        if (paid > swapIn) revert BadSwap();
        if (got < swapOutMin) revert SlippageExceeded();
        return zeroForOne ? (b0 - paid, b1 + got) : (b0 + got, b1 - paid);
    }

    /// @dev Pays what this contract owes the PoolManager (negative), takes what it is owed.
    function _settleDelta(IV4PoolManagerSwap pmgr, address currency, int128 d) private {
        if (d < 0) {
            uint256 owed = uint256(uint128(-d));
            if (currency == address(0)) {
                pmgr.settle{value: owed}();
            } else {
                pmgr.sync(currency);
                IERC20(currency).safeTransfer(address(pmgr), owed);
                pmgr.settle();
            }
        } else if (d > 0) {
            pmgr.take(currency, address(this), uint256(uint128(d)));
        }
    }

    /// @dev Fees out of the position into this contract, then Homer's share to the treasury
    ///      (none in fee-free hook pools) and the rest to `user`.
    function _collect(address posm, uint256 tokenId, V4Key memory key, address user) private returns (uint256 lp0, uint256 lp1) {
        uint256 b0 = _balanceOf(key.currency0, address(this));
        uint256 b1 = _balanceOf(key.currency1, address(this));
        bytes memory actions = abi.encodePacked(DECREASE_LIQUIDITY, TAKE_PAIR);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, address(this));
        IV4PositionManager(posm).modifyLiquidities(abi.encode(actions, params), block.timestamp);
        uint256 f0 = _balanceOf(key.currency0, address(this)) - b0;
        uint256 f1 = _balanceOf(key.currency1, address(this)) - b1;
        uint256 share = feeFreeHook[key.hooks] ? 0 : feeBps;
        uint256 h0 = (f0 * share) / BPS;
        uint256 h1 = (f1 * share) / BPS;
        lp0 = f0 - h0;
        lp1 = f1 - h1;
        _send(key.currency0, treasury, h0);
        _send(key.currency1, treasury, h1);
        _send(key.currency0, user, lp0);
        _send(key.currency1, user, lp1);
        if (f0 > 0 || f1 > 0) emit FeesCollected(user, posm, tokenId, key.currency0, key.currency1, lp0, lp1, h0, h1);
    }

    function _pull(address token, uint256 amount) private returns (uint256) {
        if (amount == 0) return 0;
        uint256 b = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        return IERC20(token).balanceOf(address(this)) - b; // what arrived, after any transfer tax
    }

    function _allow(address permit2, address token, address spender, uint256 amount) private {
        if (amount == 0) return;
        IERC20(token).forceApprove(permit2, amount);
        IPermit2(permit2).approve(token, spender, uint160(amount), uint48(block.timestamp));
    }

    function _send(address currency, address to, uint256 amount) private {
        if (amount == 0) return;
        if (currency == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(currency).safeTransfer(to, amount);
        }
    }

    function _balanceOf(address currency, address who) private view returns (uint256) {
        return currency == address(0) ? who.balance : IERC20(currency).balanceOf(who);
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    function _register(address user, address posm, uint256 tokenId) private {
        ownerOf[posm][tokenId] = user;
        _positions[user].push(Position(posm, tokenId));
        _index[posm][tokenId] = _positions[user].length;
    }

    function _unregister(address user, address posm, uint256 tokenId) private {
        uint256 i = _index[posm][tokenId] - 1;
        Position[] storage list = _positions[user];
        Position memory last = list[list.length - 1];
        list[i] = last;
        _index[last.posm][last.tokenId] = i + 1;
        list.pop();
        delete _index[posm][tokenId];
        delete ownerOf[posm][tokenId];
    }

    function _setManager(address posm, bool on) private {
        if (posm == address(0)) revert ZeroAddress();
        if (on && !isAllowed[posm]) _posms.push(posm);
        isAllowed[posm] = on;
        if (on) isPoolManager[IV4PositionManager(posm).poolManager()] = true;
        emit ManagerSet(posm, on);
    }

    // ------------------------------------------------------------------ owner

    function setFee(uint16 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        emit FeeSet(feeBps, feeBps_);
        feeBps = feeBps_;
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        emit TreasurySet(treasury, treasury_);
        treasury = treasury_;
    }

    function setManager(address posm, bool allowed) external onlyOwner {
        _setManager(posm, allowed);
    }

    function setFeeFreeHook(address hook, bool on) external onlyOwner {
        feeFreeHook[hook] = on;
        emit FeeFreeHookSet(hook, on);
    }

    /// @notice Stops new positions and additions; collecting, removing and withdrawing keep working.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
