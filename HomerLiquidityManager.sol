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

interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }
    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }
    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external
        payable
        returns (uint128 liquidity, uint256 amount0, uint256 amount1);
    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
    function burn(uint256 tokenId) external payable;
    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );
    function WETH9() external view returns (address);
    function factory() external view returns (address);
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IUniswapV3Pool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @title Homer liquidity manager
/// @notice Holds Uniswap-v3 style LP positions on behalf of their owners across allowlisted
///         position managers. Every time trading fees are collected, `feeBps` of the fees goes to
///         the Homer treasury and the rest to the LP. Principal is never charged and only ever
///         goes back to the position's owner.
/// @dev Fees and principal are kept apart by always collecting fees before liquidity is
///      decreased, and by collecting a decrease in the same call, so a position held here never
///      carries uncollected principal between transactions.
///      Version 2 adds `rebalance`: move a position to a new range in one transaction.
contract HomerLiquidityManager is IERC721Receiver, Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant KIND = "HomerLiquidityManager";
    /// @notice 2: adds `rebalance`.
    /// @notice 2: one-click rebalance. 3: zap (open a position with one token).
    uint8 public constant VERSION = 3;
    uint16 public constant MAX_FEE_BPS = 2500;
    uint16 private constant BPS = 10_000;
    uint128 private constant MAX_U128 = type(uint128).max;
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    struct Position {
        address manager;
        uint256 tokenId;
    }

    struct MintArgs {
        address manager;
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct IncreaseArgs {
        address manager;
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct DecreaseArgs {
        address manager;
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
        bool unwrap;
    }

    /// @notice Moves a position to a new price range. Amounts are raw token units.
    /// @param remove0Min / remove1Min  Minimums for taking the old liquidity out.
    /// @param zeroForOne  Swap direction inside the position's own pool (token0 -> token1 if true).
    /// @param swapIn      Exact amount swapped, taken only from the removed principal; 0 = no swap.
    /// @param swapOutMin  Minimum received from the swap.
    /// @param amount0Min / amount1Min  Minimums for the new position.
    /// @param unwrap      Pay fees and leftovers on the wrapped-native side out as HYPE.
    struct RebalanceArgs {
        address manager;
        uint256 tokenId;
        int24 tickLower;
        int24 tickUpper;
        uint256 remove0Min;
        uint256 remove1Min;
        bool zeroForOne;
        uint256 swapIn;
        uint256 swapOutMin;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
        bool unwrap;
    }

    /// @notice Opens a position with one token. Amounts are raw token units.
    /// @param zeroForOne  true: you deposit token0 and part of it is swapped to token1.
    /// @param amountIn    What you deposit, in that token (HYPE as msg.value for the wrapped side).
    /// @param swapIn      How much of it is swapped in the pool first.
    /// @param swapOutMin  Minimum received from the swap.
    /// @param amount0Min / amount1Min  Minimums for the new position.
    /// @param unwrap      Pay leftovers on the wrapped-native side out as HYPE.
    struct ZapArgs {
        address manager;
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        bool zeroForOne;
        uint256 amountIn;
        uint256 swapIn;
        uint256 swapOutMin;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
        bool unwrap;
    }

    /// @notice Share of collected trading fees sent to the treasury, in basis points.
    uint16 public feeBps;
    address public treasury;

    /// @notice Position managers that accept new positions. Existing positions stay fully
    ///         manageable after a manager is removed.
    mapping(address => bool) public isAllowed;
    /// @notice WETH9 of every position manager ever allowed.
    mapping(address => address) public wethOf;
    mapping(address => bool) private _isWeth;
    address[] private _managers;

    /// @notice Owner of a position held by this contract, per position manager and token id.
    mapping(address => mapping(uint256 => address)) public ownerOf;
    mapping(address => Position[]) private _positions;
    mapping(address => mapping(uint256 => uint256)) private _slot; // index + 1 in owner's list

    /// @dev The only pool allowed to call `uniswapV3SwapCallback`, and how much it may take.
    ///      Set just for the duration of a rebalance swap.
    address private _swapPool;
    uint256 private _swapBudget;

    event HomerDeployed(bytes32 indexed kind, address indexed owner);
    event ManagerSet(address indexed manager, bool allowed, address weth);
    event FeeSet(uint16 previous, uint16 current);
    event TreasurySet(address indexed previous, address indexed current);
    event Deposited(address indexed user, address indexed manager, uint256 indexed tokenId);
    event Minted(address indexed user, address indexed manager, uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    event Increased(address indexed user, address indexed manager, uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    event Decreased(address indexed user, address indexed manager, uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
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
    event Burned(address indexed user, address indexed manager, uint256 indexed tokenId);
    event Rebalanced(
        address indexed user,
        address indexed manager,
        uint256 indexed oldTokenId,
        uint256 newTokenId,
        uint128 liquidity,
        uint256 amount0,
        uint256 amount1
    );

    error NotAllowed();
    error NotPositionOwner();
    error BadValue();
    error FeeTooHigh();
    error ZeroAddress();
    error NativeTransferFailed();
    error UnexpectedSender();
    error Expired();
    error BadSwap();
    error SlippageExceeded();

    constructor(address owner_, address treasury_, uint16 feeBps_, address[] memory managers_) Ownable(owner_) {
        if (treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        treasury = treasury_;
        feeBps = feeBps_;
        emit TreasurySet(address(0), treasury_);
        emit FeeSet(0, feeBps_);
        for (uint256 i; i < managers_.length; ++i) _setManager(managers_[i], true);
        emit HomerDeployed(KIND, owner_);
    }

    modifier onlyPositionOwner(address manager, uint256 tokenId) {
        if (ownerOf[manager][tokenId] != msg.sender) revert NotPositionOwner();
        _;
    }

    // ------------------------------------------------------------------ LP actions

    /// @notice Opens a new position held for the caller. Send HYPE as `msg.value` to fund the
    ///         wrapped-native side; it must equal that side's desired amount.
    function mint(MintArgs calldata a)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 tokenId, uint128 liquidity, uint256 used0, uint256 used1)
    {
        if (!isAllowed[a.manager]) revert NotAllowed();
        INonfungiblePositionManager pm = INonfungiblePositionManager(a.manager);
        (uint256 got0, uint256 got1, bool nativeIn) = _fund(a.manager, a.token0, a.token1, a.amount0Desired, a.amount1Desired);
        _approve(a.token0, a.manager, got0);
        _approve(a.token1, a.manager, got1);
        (tokenId, liquidity, used0, used1) = pm.mint(
            INonfungiblePositionManager.MintParams({
                token0: a.token0,
                token1: a.token1,
                fee: a.fee,
                tickLower: a.tickLower,
                tickUpper: a.tickUpper,
                amount0Desired: got0,
                amount1Desired: got1,
                amount0Min: a.amount0Min,
                amount1Min: a.amount1Min,
                recipient: address(this),
                deadline: a.deadline
            })
        );
        _register(msg.sender, a.manager, tokenId);
        _settleFunding(a.manager, a.token0, a.token1, got0 - used0, got1 - used1, nativeIn);
        emit Minted(msg.sender, a.manager, tokenId, liquidity, used0, used1);
    }

    /// @notice Adds liquidity to a position the caller holds here.
    function increase(IncreaseArgs calldata a)
        external
        payable
        nonReentrant
        whenNotPaused
        onlyPositionOwner(a.manager, a.tokenId)
        returns (uint128 liquidity, uint256 used0, uint256 used1)
    {
        if (!isAllowed[a.manager]) revert NotAllowed();
        (address token0, address token1) = _tokens(a.manager, a.tokenId);
        (uint256 got0, uint256 got1, bool nativeIn) = _fund(a.manager, token0, token1, a.amount0Desired, a.amount1Desired);
        _approve(token0, a.manager, got0);
        _approve(token1, a.manager, got1);
        (liquidity, used0, used1) = INonfungiblePositionManager(a.manager).increaseLiquidity(
            INonfungiblePositionManager.IncreaseLiquidityParams({
                tokenId: a.tokenId,
                amount0Desired: got0,
                amount1Desired: got1,
                amount0Min: a.amount0Min,
                amount1Min: a.amount1Min,
                deadline: a.deadline
            })
        );
        _settleFunding(a.manager, token0, token1, got0 - used0, got1 - used1, nativeIn);
        emit Increased(msg.sender, a.manager, a.tokenId, liquidity, used0, used1);
    }

    /// @notice Collects the trading fees a position has earned. The treasury share is taken here.
    /// @param unwrap Pay the wrapped-native side out as HYPE.
    function collect(address manager, uint256 tokenId, bool unwrap)
        external
        nonReentrant
        onlyPositionOwner(manager, tokenId)
        returns (uint256 lp0, uint256 lp1)
    {
        (lp0, lp1) = _collectFees(manager, tokenId, msg.sender, unwrap);
    }

    /// @notice Removes liquidity. Earned fees are collected first (treasury share taken); the
    ///         removed principal is then paid to the owner in full. A position emptied to zero
    ///         liquidity is burned.
    function decrease(DecreaseArgs calldata a)
        external
        nonReentrant
        onlyPositionOwner(a.manager, a.tokenId)
        returns (uint256 amount0, uint256 amount1)
    {
        _collectFees(a.manager, a.tokenId, msg.sender, a.unwrap);
        INonfungiblePositionManager pm = INonfungiblePositionManager(a.manager);
        if (a.liquidity > 0) {
            pm.decreaseLiquidity(
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: a.tokenId,
                    liquidity: a.liquidity,
                    amount0Min: a.amount0Min,
                    amount1Min: a.amount1Min,
                    deadline: a.deadline
                })
            );
        }
        (address token0, address token1) = _tokens(a.manager, a.tokenId);
        (amount0, amount1) = _collectAll(a.manager, a.tokenId, token0, token1);
        address weth = wethOf[a.manager];
        _send(token0, msg.sender, amount0, a.unwrap && token0 == weth);
        _send(token1, msg.sender, amount1, a.unwrap && token1 == weth);
        emit Decreased(msg.sender, a.manager, a.tokenId, a.liquidity, amount0, amount1);

        (,,,,,,, uint128 left,,,,) = pm.positions(a.tokenId);
        if (left == 0) {
            try pm.burn(a.tokenId) {
                _unregister(msg.sender, a.manager, a.tokenId);
                emit Burned(msg.sender, a.manager, a.tokenId);
            } catch {}
        }
    }

    /// @notice Moves a position to a new range in one transaction: earned fees are collected
    ///         (treasury share taken, the rest paid to the owner), the old liquidity is removed
    ///         and the empty NFT burned, `swapIn` of the principal is swapped in the position's
    ///         own pool, and a new position is opened with what the owner had. Anything the new
    ///         range does not use is returned. Principal is never charged. All or nothing.
    function rebalance(RebalanceArgs calldata a)
        external
        nonReentrant
        whenNotPaused
        onlyPositionOwner(a.manager, a.tokenId)
        returns (uint256 tokenId, uint128 liquidity, uint256 used0, uint256 used1)
    {
        if (!isAllowed[a.manager]) revert NotAllowed();
        if (block.timestamp > a.deadline) revert Expired();
        INonfungiblePositionManager pm = INonfungiblePositionManager(a.manager);
        _collectFees(a.manager, a.tokenId, msg.sender, a.unwrap);

        (,, address token0, address token1, uint24 fee,,, uint128 old,,,,) = pm.positions(a.tokenId);
        if (old > 0) {
            pm.decreaseLiquidity(
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: a.tokenId,
                    liquidity: old,
                    amount0Min: a.remove0Min,
                    amount1Min: a.remove1Min,
                    deadline: a.deadline
                })
            );
        }
        (uint256 b0, uint256 b1) = _collectAll(a.manager, a.tokenId, token0, token1);
        pm.burn(a.tokenId);
        _unregister(msg.sender, a.manager, a.tokenId);
        emit Burned(msg.sender, a.manager, a.tokenId);

        if (a.swapIn > 0) (b0, b1) = _swapInPool(pm, token0, token1, fee, a.zeroForOne, a.swapIn, a.swapOutMin, b0, b1);

        _approve(token0, a.manager, b0);
        _approve(token1, a.manager, b1);
        (tokenId, liquidity, used0, used1) = pm.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: fee,
                tickLower: a.tickLower,
                tickUpper: a.tickUpper,
                amount0Desired: b0,
                amount1Desired: b1,
                amount0Min: a.amount0Min,
                amount1Min: a.amount1Min,
                recipient: address(this),
                deadline: a.deadline
            })
        );
        _register(msg.sender, a.manager, tokenId);
        _settleFunding(a.manager, token0, token1, b0 - used0, b1 - used1, a.unwrap);
        emit Rebalanced(msg.sender, a.manager, a.tokenId, tokenId, liquidity, used0, used1);
    }

    /// @notice Opens a position with one token only, in one transaction: `swapIn` of it is
    ///         swapped in the pool itself, then the position opens with both sides. Whatever the
    ///         range does not use comes back. All or nothing.
    function zap(ZapArgs calldata a)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 tokenId, uint128 liquidity, uint256 used0, uint256 used1)
    {
        if (!isAllowed[a.manager]) revert NotAllowed();
        if (block.timestamp > a.deadline) revert Expired();
        if (a.amountIn == 0 || a.swapIn > a.amountIn) revert BadSwap();
        INonfungiblePositionManager pm = INonfungiblePositionManager(a.manager);
        (uint256 b0, uint256 b1, bool nativeIn) =
            _fund(a.manager, a.token0, a.token1, a.zeroForOne ? a.amountIn : 0, a.zeroForOne ? 0 : a.amountIn);
        if (a.swapIn > 0) {
            uint256 have = a.zeroForOne ? b0 : b1; // after any transfer tax
            (b0, b1) = _swapInPool(pm, a.token0, a.token1, a.fee, a.zeroForOne, a.swapIn < have ? a.swapIn : have, a.swapOutMin, b0, b1);
        }
        _approve(a.token0, a.manager, b0);
        _approve(a.token1, a.manager, b1);
        (tokenId, liquidity, used0, used1) = pm.mint(
            INonfungiblePositionManager.MintParams({
                token0: a.token0,
                token1: a.token1,
                fee: a.fee,
                tickLower: a.tickLower,
                tickUpper: a.tickUpper,
                amount0Desired: b0,
                amount1Desired: b1,
                amount0Min: a.amount0Min,
                amount1Min: a.amount1Min,
                recipient: address(this),
                deadline: a.deadline
            })
        );
        _register(msg.sender, a.manager, tokenId);
        _settleFunding(a.manager, a.token0, a.token1, b0 - used0, b1 - used1, nativeIn || a.unwrap);
        emit Minted(msg.sender, a.manager, tokenId, liquidity, used0, used1);
    }

    /// @dev Pays a rebalance swap. Only the pool being swapped in, and only up to the budget.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        address pool = _swapPool;
        if (pool == address(0) || msg.sender != pool) revert UnexpectedSender();
        (address token0, address token1) = abi.decode(data, (address, address));
        if (amount0Delta > 0) _payPool(token0, uint256(amount0Delta));
        if (amount1Delta > 0) _payPool(token1, uint256(amount1Delta));
    }

    /// @notice Takes a position out of Homer. Earned fees are settled first, then the NFT is
    ///         sent to `to`. Always available, including while paused.
    function withdraw(address manager, uint256 tokenId, address to)
        external
        nonReentrant
        onlyPositionOwner(manager, tokenId)
    {
        if (to == address(0) || to == address(this)) revert ZeroAddress();
        _collectFees(manager, tokenId, msg.sender, false);
        _unregister(msg.sender, manager, tokenId);
        IERC721(manager).safeTransferFrom(address(this), to, tokenId);
        emit Withdrawn(msg.sender, manager, tokenId, to);
    }

    /// @notice Bring an existing position into Homer with `safeTransferFrom(you, this, id)`.
    ///         Fees it earned before arriving are paid to the sender in full.
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata)
        external
        override
        returns (bytes4)
    {
        if (operator == address(this)) {
            // Our own mint; the caller registers the position.
            if (!_reentrancyGuardEntered() || wethOf[msg.sender] == address(0)) revert UnexpectedSender();
        } else {
            _deposit(msg.sender, from, tokenId);
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    // ------------------------------------------------------------------ views

    function positionsOf(address user) external view returns (Position[] memory) {
        return _positions[user];
    }

    function positionCount(address user) external view returns (uint256) {
        return _positions[user].length;
    }

    function managers() external view returns (address[] memory) {
        return _managers;
    }

    // ------------------------------------------------------------------ admin

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

    function setManager(address manager, bool allowed) external onlyOwner {
        _setManager(manager, allowed);
    }

    /// @notice Blocks new positions and deposits. Collecting, removing and withdrawing stay open.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Tokens are never held between transactions; this only returns stray transfers.
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    function rescueNative(address to) external onlyOwner {
        (bool ok,) = to.call{value: address(this).balance}("");
        if (!ok) revert NativeTransferFailed();
    }

    /// @notice Returns a position NFT sent here with a plain `transferFrom` (which skips
    ///         registration). Registered positions can never be moved by the owner.
    function recoverUnregistered(address manager, uint256 tokenId, address to) external onlyOwner {
        if (ownerOf[manager][tokenId] != address(0)) revert NotAllowed();
        IERC721(manager).safeTransferFrom(address(this), to, tokenId);
    }

    receive() external payable {
        if (!_isWeth[msg.sender]) revert UnexpectedSender();
    }

    // ------------------------------------------------------------------ internals

    function _setManager(address manager, bool allowed) internal {
        if (manager == address(0)) revert ZeroAddress();
        address weth = wethOf[manager];
        if (weth == address(0)) {
            weth = INonfungiblePositionManager(manager).WETH9();
            if (weth == address(0)) revert ZeroAddress();
            wethOf[manager] = weth;
            _isWeth[weth] = true;
            _managers.push(manager);
        }
        isAllowed[manager] = allowed;
        emit ManagerSet(manager, allowed, weth);
    }

    function _deposit(address manager, address from, uint256 tokenId) internal nonReentrant whenNotPaused {
        if (!isAllowed[manager]) revert NotAllowed();
        if (from == address(0)) revert ZeroAddress();
        _register(from, manager, tokenId);
        (address token0, address token1) = _tokens(manager, tokenId);
        (uint256 a0, uint256 a1) = _collectAll(manager, tokenId, token0, token1);
        _send(token0, from, a0, false);
        _send(token1, from, a1, false);
        emit Deposited(from, manager, tokenId);
    }

    function _collectFees(address manager, uint256 tokenId, address user, bool unwrap)
        internal
        returns (uint256 lp0, uint256 lp1)
    {
        (address token0, address token1) = _tokens(manager, tokenId);
        (uint256 r0, uint256 r1) = _collectAll(manager, tokenId, token0, token1);
        uint256 f0 = (r0 * feeBps) / BPS;
        uint256 f1 = (r1 * feeBps) / BPS;
        lp0 = r0 - f0;
        lp1 = r1 - f1;
        if (f0 > 0) IERC20(token0).safeTransfer(treasury, f0);
        if (f1 > 0) IERC20(token1).safeTransfer(treasury, f1);
        address weth = wethOf[manager];
        _send(token0, user, lp0, unwrap && token0 == weth);
        _send(token1, user, lp1, unwrap && token1 == weth);
        if (r0 > 0 || r1 > 0) emit FeesCollected(user, manager, tokenId, token0, token1, lp0, lp1, f0, f1);
    }

    /// @dev Collects everything owed to the position into this contract; returns what arrived.
    function _collectAll(address manager, uint256 tokenId, address token0, address token1)
        internal
        returns (uint256 got0, uint256 got1)
    {
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        INonfungiblePositionManager(manager).collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: MAX_U128,
                amount1Max: MAX_U128
            })
        );
        got0 = IERC20(token0).balanceOf(address(this)) - b0;
        got1 = IERC20(token1).balanceOf(address(this)) - b1;
    }

    /// @dev Swaps `a.swapIn` of the principal in the venue's own pool for this pair and fee.
    ///      Amounts are measured from balances; returns the new principal on each side.
    function _swapInPool(
        INonfungiblePositionManager pm,
        address token0,
        address token1,
        uint24 fee,
        bool zeroForOne,
        uint256 swapIn,
        uint256 swapOutMin,
        uint256 b0,
        uint256 b1
    ) internal returns (uint256, uint256) {
        if (swapIn > (zeroForOne ? b0 : b1) || swapIn > uint256(type(int256).max)) revert BadSwap();
        address pool = IUniswapV3Factory(pm.factory()).getPool(token0, token1, fee);
        if (pool == address(0)) revert BadSwap();
        (address tokenIn, address tokenOut) = zeroForOne ? (token0, token1) : (token1, token0);
        uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));
        _swapPool = pool;
        _swapBudget = swapIn;
        IUniswapV3Pool(pool).swap(
            address(this),
            zeroForOne,
            int256(swapIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(token0, token1)
        );
        _swapPool = address(0);
        _swapBudget = 0;
        uint256 paid = inBefore - IERC20(tokenIn).balanceOf(address(this));
        uint256 got = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        if (got < swapOutMin) revert SlippageExceeded();
        return zeroForOne ? (b0 - paid, b1 + got) : (b0 + got, b1 - paid);
    }

    function _payPool(address token, uint256 amount) internal {
        if (amount > _swapBudget) revert BadSwap();
        _swapBudget -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    function _tokens(address manager, uint256 tokenId) internal view returns (address token0, address token1) {
        (,, token0, token1,,,,,,,,) = INonfungiblePositionManager(manager).positions(tokenId);
    }

    /// @dev Pulls the desired amounts from the caller. HYPE sent with the call funds the
    ///      wrapped-native side and must match it exactly.
    function _fund(address manager, address token0, address token1, uint256 d0, uint256 d1)
        internal
        returns (uint256 got0, uint256 got1, bool nativeIn)
    {
        if (msg.value > 0) {
            address weth = wethOf[manager];
            if (token0 == weth) {
                if (msg.value != d0) revert BadValue();
                IWETH9(weth).deposit{value: msg.value}();
                got0 = msg.value;
                got1 = _pullIn(token1, d1);
            } else if (token1 == weth) {
                if (msg.value != d1) revert BadValue();
                IWETH9(weth).deposit{value: msg.value}();
                got1 = msg.value;
                got0 = _pullIn(token0, d0);
            } else {
                revert BadValue();
            }
            nativeIn = true;
        } else {
            got0 = _pullIn(token0, d0);
            got1 = _pullIn(token1, d1);
        }
    }

    function _pullIn(address token, uint256 amount) internal returns (uint256) {
        if (amount == 0) return 0;
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        return IERC20(token).balanceOf(address(this)) - before;
    }

    function _approve(address token, address spender, uint256 amount) internal {
        if (amount > 0) IERC20(token).forceApprove(spender, amount);
    }

    /// @dev Clears allowances left to the position manager and refunds what it did not use.
    function _settleFunding(address manager, address token0, address token1, uint256 left0, uint256 left1, bool nativeIn)
        internal
    {
        if (IERC20(token0).allowance(address(this), manager) > 0) IERC20(token0).forceApprove(manager, 0);
        if (IERC20(token1).allowance(address(this), manager) > 0) IERC20(token1).forceApprove(manager, 0);
        address weth = wethOf[manager];
        _send(token0, msg.sender, left0, nativeIn && token0 == weth);
        _send(token1, msg.sender, left1, nativeIn && token1 == weth);
    }

    function _send(address token, address to, uint256 amount, bool unwrap) internal {
        if (amount == 0) return;
        if (unwrap) {
            IWETH9(token).withdraw(amount);
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function _register(address user, address manager, uint256 tokenId) internal {
        ownerOf[manager][tokenId] = user;
        _positions[user].push(Position(manager, tokenId));
        _slot[manager][tokenId] = _positions[user].length;
    }

    function _unregister(address user, address manager, uint256 tokenId) internal {
        Position[] storage list = _positions[user];
        uint256 i = _slot[manager][tokenId] - 1;
        uint256 last = list.length - 1;
        if (i != last) {
            Position memory moved = list[last];
            list[i] = moved;
            _slot[moved.manager][moved.tokenId] = i + 1;
        }
        list.pop();
        delete _slot[manager][tokenId];
        delete ownerOf[manager][tokenId];
    }
}
