// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IWrappedHype {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function factory() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

interface IV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

/// @dev A launchpad's v2 pair (Obol): no LP token, swaps from any caller, its fee taken from the
///      HYPE side (from the HYPE paid in when buying, from the HYPE paid out when selling).
interface IV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function factory() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// @dev Uniswap v4 types, as the PoolManager's ABI sees them (Currency = address, BalanceDelta = int256).
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct V4SwapParams {
    bool zeroForOne;
    int256 amountSpecified; // negative: exact input
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, V4SwapParams memory params, bytes calldata hookData) external returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

/// @title Homer Swap
/// @notice Buys and sells tokens against HYPE on Elysium pools, in one transaction:
///         Uniswap-v3 style pools from listed factories, Uniswap-v4 pools on listed
///         PoolManagers (launch pools included: their own buy/sell tax still applies), and
///         (version 2) the v2 pairs of listed launchpads such as Obol, where a token trades
///         once it graduates.
///         Homer's fee is taken in HYPE only: from what you pay when buying, from what you
///         receive when selling. It is `feeBps` (25 = 0.25% at launch), never above 1%, and is
///         sent to `feeRecipient` (Homer's fee router, which shares it with $HOMER stakers).
///         Version 3 adds two-step trades (`buyVia`, `sellVia`) for a token whose pool is against
///         another token rather than HYPE (a token quoted in KNTQ, say): HYPE to that token in one
///         of its HYPE pools, then on to the token. Homer's fee is still taken once, in HYPE.
///         The contract holds nothing between transactions; every swap has a minimum output and
///         a deadline.
contract HomerSwap is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant KIND = "HomerSwap";
    /// @notice 2: adds launchpad v2 pairs (`kind` 2 routes). 3: adds two-step trades (buyVia, sellVia).
    uint256 public constant VERSION = 3;
    uint16 private constant BPS = 10_000;
    /// @notice Homer's fee can never be set above 1%.
    uint16 public constant MAX_FEE_BPS = 100;
    /// @notice A listed launchpad's pair fee is at most 10%.
    uint16 public constant MAX_V2_FEE_BPS = 1000;
    /// @notice Obol's pads: coin record of a token, word 2 = its pair (checked before each v2 swap).
    bytes4 public constant OBOL_PAIR_LOOKUP = 0x7d0f7a88;

    uint160 private constant MIN_SQRT_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    uint16 public feeBps;
    address public feeRecipient;
    bool public paused;

    /// @notice v3 factories whose pools may be used (a pool is checked against its factory).
    mapping(address => bool) public isFactory;
    /// @notice v4 PoolManagers that may be used.
    mapping(address => bool) public isPoolManager;
    /// @notice Wrapped HYPE contracts (1:1 deposit/withdraw) that count as the HYPE side of a pool.
    mapping(address => bool) public isWrapped;
    /// @notice Other names a v3 fork gives its swap callback (same arguments as uniswapV3SwapCallback).
    ///         Stockium's pools call 0x57ec3e25.
    mapping(bytes4 => bool) public isV3Callback;
    /// @notice Launchpads whose v2 pairs may be used: the pair fee they charge on the HYPE side,
    ///         in basis points (0 = not listed), and the call that names a token's pair.
    struct V2Pad {
        uint16 feeBps;
        bytes4 pairLookup;
    }
    mapping(address => V2Pad) public v2Pads;

    /// @dev The single pool or PoolManager allowed to call back, set only during a swap.
    address private _active;
    bool private _quoting;

    /// @notice A v3 pool (`kind` 3, `target` = pool), a v4 pool (`kind` 4, `target` = PoolManager,
    ///         `key`) or a launchpad's v2 pair (`kind` 2, `target` = pair; `key` unused).
    struct Route {
        uint8 kind;
        address target;
        PoolKey key;
    }

    event HomerDeployed(bytes32 indexed kind, address indexed owner);
    event Swapped(
        address indexed user,
        address indexed target,
        address indexed token,
        bool buy,
        uint256 hypeAmount,
        uint256 tokenAmount,
        uint256 fee
    );
    /// @notice A two-step trade's middle step (after its Swapped event): the token it went
    ///         through, the first pool (HYPE side), and how much of the middle token moved.
    event Via(address indexed user, address indexed mid, address indexed firstTarget, uint256 midAmount);
    event FeeSet(uint16 previous, uint16 current);
    event FeeRecipientSet(address indexed recipient);
    event FactorySet(address indexed factory, bool on);
    event PoolManagerSet(address indexed manager, bool on);
    event WrappedSet(address indexed token, bool on);
    event PausedSet(bool paused);
    event V3CallbackSet(bytes4 indexed selector, bool on);
    event V2PadSet(address indexed pad, uint16 feeBps, bytes4 pairLookup);

    error ZeroAddress();
    error FeeTooHigh();
    error Paused();
    error Expired();
    error ZeroAmount();
    error NotAllowed();
    error NoHypeSide();
    error TooLittleReceived(uint256 received, uint256 minimum);
    error UnexpectedCaller();
    error Quote(int256 amount0, int256 amount1);
    error HypeTransferFailed();

    constructor(
        address owner_,
        address feeRecipient_,
        uint16 feeBps_,
        address[] memory factories_,
        address[] memory poolManagers_,
        address[] memory wrapped_,
        address[] memory v2Pads_,
        uint16[] memory v2FeesBps_
    ) Ownable(owner_) {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        for (uint256 i; i < factories_.length; ++i) _set(isFactory, factories_[i], true);
        for (uint256 i; i < poolManagers_.length; ++i) _set(isPoolManager, poolManagers_[i], true);
        for (uint256 i; i < wrapped_.length; ++i) _set(isWrapped, wrapped_[i], true);
        if (v2Pads_.length != v2FeesBps_.length) revert NotAllowed();
        for (uint256 i; i < v2Pads_.length; ++i) _setV2Pad(v2Pads_[i], v2FeesBps_[i], OBOL_PAIR_LOOKUP);
        isV3Callback[0x57ec3e25] = true;
        emit V3CallbackSet(0x57ec3e25, true);
        emit FeeSet(0, feeBps_);
        emit FeeRecipientSet(feeRecipient_);
        emit HomerDeployed(KIND, owner_);
    }

    // ------------------------------------------------------------------ swaps

    /// @notice Pays `msg.value` HYPE (fee included) for the pool's token, sent to you. If the pool
    ///         cannot take all of it (it runs out of liquidity), the unused HYPE comes back to you.
    function buy(Route calldata r, uint256 minOut, uint256 deadline) external payable nonReentrant returns (uint256 out) {
        _checkOpen(deadline);
        if (msg.value == 0) revert ZeroAmount();
        uint256 base = address(this).balance - msg.value;
        uint256 fee = (msg.value * feeBps) / BPS;
        uint256 amountIn = msg.value - fee;
        (address hypeSide, address token, bool hypeIs0) = _sides(r);
        uint256 before = IERC20(token).balanceOf(msg.sender);
        _swap(r, hypeSide, token, hypeIs0, true, amountIn, msg.sender);
        out = IERC20(token).balanceOf(msg.sender) - before; // what actually arrived (taxed tokens included)
        if (out < minOut) revert TooLittleReceived(out, minOut);
        uint256 unused = address(this).balance - base - fee;
        _sendHype(feeRecipient, fee);
        _sendHype(msg.sender, unused);
        emit Swapped(msg.sender, r.target, token, true, msg.value - unused, out, fee);
    }

    /// @notice Sells `amountIn` of the pool's token (approve this contract first) for HYPE.
    function sell(Route calldata r, uint256 amountIn, uint256 minOut, uint256 deadline) external nonReentrant returns (uint256 out) {
        _checkOpen(deadline);
        if (amountIn == 0) revert ZeroAmount();
        (address hypeSide, address token, bool hypeIs0) = _sides(r);
        uint256 held = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 got = IERC20(token).balanceOf(address(this)) - held; // after any transfer tax
        uint256 gross = address(this).balance;
        _swap(r, hypeSide, token, hypeIs0, false, got, address(this));
        gross = address(this).balance - gross;
        uint256 fee = (gross * feeBps) / BPS;
        out = gross - fee;
        if (out < minOut) revert TooLittleReceived(out, minOut);
        // Tokens the pool could not take (it ran out of liquidity) go back to the seller.
        uint256 unused = IERC20(token).balanceOf(address(this)) - held;
        if (unused > 0) IERC20(token).safeTransfer(msg.sender, unused);
        _sendHype(feeRecipient, fee);
        _sendHype(msg.sender, out);
        emit Swapped(msg.sender, r.target, token, false, gross, got - unused, fee);
    }

    // ------------------------------------------------------------------ quotes
    // For eth_call only: they run the swap and revert inside it, so nothing changes on-chain.

    /// @notice Tokens received for `hypeIn` HYPE (fee included), before any token transfer tax.
    function quoteBuy(Route calldata r, uint256 hypeIn) external returns (uint256 out, uint256 fee) {
        fee = (hypeIn * feeBps) / BPS;
        (int256 a0, int256 a1, bool hypeIs0) = _quote(r, true, hypeIn - fee);
        int256 o = hypeIs0 ? a1 : a0;
        out = o > 0 ? uint256(o) : 0;
    }

    /// @notice HYPE received (after Homer's fee) for selling `amountIn` tokens.
    function quoteSell(Route calldata r, uint256 amountIn) external returns (uint256 out, uint256 fee) {
        (int256 a0, int256 a1, bool hypeIs0) = _quote(r, false, amountIn);
        int256 o = hypeIs0 ? a0 : a1;
        uint256 gross = o > 0 ? uint256(o) : 0;
        fee = (gross * feeBps) / BPS;
        out = gross - fee;
    }

    // ------------------------------------------------------------------ two-step trades (version 3)
    // `first`: a HYPE pool of the middle token (any route `buy` takes). `second`: a v3 or v4 pool of
    // the middle token and the token you trade, with no HYPE side. The two are different pools.

    /// @notice Pays `msg.value` HYPE (fee included) for `second`'s other token: HYPE to the middle
    ///         token in `first`, then the middle token to yours in `second`, sent to you. What a pool
    ///         cannot take comes back to you (HYPE as HYPE, the middle token as it is).
    function buyVia(Route calldata first, Route calldata second, uint256 minOut, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 out)
    {
        _checkOpen(deadline);
        if (msg.value == 0) revert ZeroAmount();
        uint256 base = address(this).balance - msg.value;
        uint256 fee = (msg.value * feeBps) / BPS;
        (address hypeSide, address mid, bool hypeIs0) = _sides(first);
        (address token, bool midIs0) = _hop(second, mid);
        uint256 midHeld = IERC20(mid).balanceOf(address(this));
        _swap(first, hypeSide, mid, hypeIs0, true, msg.value - fee, address(this));
        uint256 midGot = IERC20(mid).balanceOf(address(this)) - midHeld;
        uint256 before = IERC20(token).balanceOf(msg.sender);
        _swapHop(second, midIs0, midGot, msg.sender); // middle token in, yours out
        out = IERC20(token).balanceOf(msg.sender) - before;
        if (out < minOut) revert TooLittleReceived(out, minOut);
        uint256 midLeft = IERC20(mid).balanceOf(address(this)) - midHeld;
        if (midLeft > 0) IERC20(mid).safeTransfer(msg.sender, midLeft);
        uint256 unused = address(this).balance - base - fee;
        _sendHype(feeRecipient, fee);
        _sendHype(msg.sender, unused);
        emit Swapped(msg.sender, second.target, token, true, msg.value - unused, out, fee);
        emit Via(msg.sender, mid, first.target, midGot - midLeft);
    }

    /// @notice Sells `amountIn` of `second`'s other token (approve this contract first) for HYPE:
    ///         to the middle token in `second`, then to HYPE in `first`.
    function sellVia(Route calldata second, Route calldata first, uint256 amountIn, uint256 minOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 out)
    {
        _checkOpen(deadline);
        if (amountIn == 0) revert ZeroAmount();
        (address hypeSide, address mid, bool hypeIs0) = _sides(first);
        (address token, bool midIs0) = _hop(second, mid);
        uint256 held = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 got = IERC20(token).balanceOf(address(this)) - held; // after any transfer tax
        uint256 midHeld = IERC20(mid).balanceOf(address(this));
        _swapHop(second, !midIs0, got, address(this)); // yours in, middle token out
        uint256 midGot = IERC20(mid).balanceOf(address(this)) - midHeld;
        uint256 gross = address(this).balance;
        _swap(first, hypeSide, mid, hypeIs0, false, midGot, address(this));
        gross = address(this).balance - gross;
        uint256 fee = (gross * feeBps) / BPS;
        out = gross - fee;
        if (out < minOut) revert TooLittleReceived(out, minOut);
        uint256 unused = IERC20(token).balanceOf(address(this)) - held;
        if (unused > 0) IERC20(token).safeTransfer(msg.sender, unused);
        uint256 midLeft = IERC20(mid).balanceOf(address(this)) - midHeld;
        if (midLeft > 0) IERC20(mid).safeTransfer(msg.sender, midLeft);
        _sendHype(feeRecipient, fee);
        _sendHype(msg.sender, out);
        emit Swapped(msg.sender, second.target, token, false, gross, got - unused, fee);
        emit Via(msg.sender, mid, first.target, midGot - midLeft);
    }

    /// @notice Tokens received for `hypeIn` HYPE (fee included) through `first` then `second`, and
    ///         the middle token's amount, before any transfer tax. For eth_call only.
    function quoteBuyVia(Route calldata first, Route calldata second, uint256 hypeIn)
        external
        returns (uint256 out, uint256 fee, uint256 midAmount)
    {
        fee = (hypeIn * feeBps) / BPS;
        (, address mid,) = _sides(first);
        (, bool midIs0) = _hop(second, mid);
        (int256 a0, int256 a1, bool hypeIs0) = _quote(first, true, hypeIn - fee);
        int256 m = hypeIs0 ? a1 : a0;
        midAmount = m > 0 ? uint256(m) : 0;
        (int256 b0, int256 b1) = _simulate(second, midIs0, midAmount, "");
        int256 o = midIs0 ? b1 : b0;
        out = o > 0 ? uint256(o) : 0;
    }

    /// @notice HYPE received (after Homer's fee) for selling `amountIn` tokens through `second`
    ///         then `first`, and the middle token's amount. For eth_call only.
    function quoteSellVia(Route calldata second, Route calldata first, uint256 amountIn)
        external
        returns (uint256 out, uint256 fee, uint256 midAmount)
    {
        (, address mid,) = _sides(first);
        (, bool midIs0) = _hop(second, mid);
        (int256 b0, int256 b1) = _simulate(second, !midIs0, amountIn, "");
        int256 m = midIs0 ? b0 : b1;
        midAmount = m > 0 ? uint256(m) : 0;
        (int256 a0, int256 a1, bool hypeIs0) = _quote(first, false, midAmount);
        int256 o = hypeIs0 ? a0 : a1;
        uint256 gross = o > 0 ? uint256(o) : 0;
        fee = (gross * feeBps) / BPS;
        out = gross - fee;
    }

    // ------------------------------------------------------------------ callbacks

    /// @dev v3: pays the pool what it asks for, from this contract (wrapped HYPE or the sold token).
    function uniswapV3SwapCallback(int256 amount0, int256 amount1, bytes calldata data) external {
        _v3Callback(amount0, amount1, data);
    }

    /// @dev The same callback under a fork's own name (see isV3Callback), with the same arguments.
    fallback(bytes calldata input) external returns (bytes memory) {
        if (!isV3Callback[msg.sig]) revert UnexpectedCaller();
        (int256 amount0, int256 amount1, bytes memory data) = abi.decode(input[4:], (int256, int256, bytes));
        _v3Callback(amount0, amount1, data);
        return "";
    }

    function _v3Callback(int256 amount0, int256 amount1, bytes memory data) private {
        if (msg.sender != _active || _active == address(0)) revert UnexpectedCaller();
        // The pool reports from its side (positive = owed to it); quotes use the swapper's side.
        if (_quoting) revert Quote(-amount0, -amount1);
        (address token0, address token1) = abi.decode(data, (address, address));
        if (amount0 > 0) IERC20(token0).safeTransfer(msg.sender, uint256(amount0));
        if (amount1 > 0) IERC20(token1).safeTransfer(msg.sender, uint256(amount1));
    }

    /// @dev v4: swaps, then settles what is owed and takes what is due.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != _active || _active == address(0)) revert UnexpectedCaller();
        (PoolKey memory key, bool zeroForOne, uint256 amountIn, address recipient) = abi.decode(data, (PoolKey, bool, uint256, address));
        IPoolManager pm = IPoolManager(msg.sender);
        int256 delta = pm.swap(
            key,
            V4SwapParams(zeroForOne, -int256(amountIn), zeroForOne ? MIN_SQRT_PLUS_ONE : MAX_SQRT_MINUS_ONE),
            ""
        );
        // BalanceDelta: amount0 in the high 128 bits, amount1 in the low; negative = owed by us.
        int256 d0 = int256(int128(delta >> 128));
        int256 d1 = int256(int128(delta));
        if (_quoting) revert Quote(d0, d1);
        if (d0 < 0) _settle(pm, key.currency0, uint256(-d0));
        if (d1 < 0) _settle(pm, key.currency1, uint256(-d1));
        if (d0 > 0) _take(pm, key.currency0, recipient, uint256(d0));
        if (d1 > 0) _take(pm, key.currency1, recipient, uint256(d1));
        return "";
    }

    /// @dev Native HYPE arrives from wrapped-HYPE withdrawals and v4 `take`.
    receive() external payable {
        if (!isWrapped[msg.sender] && !isPoolManager[msg.sender]) revert UnexpectedCaller();
    }

    // ------------------------------------------------------------------ internals

    function _checkOpen(uint256 deadline) private view {
        if (paused) revert Paused();
        if (block.timestamp > deadline) revert Expired();
    }

    /// @dev The route's HYPE side (address(0) = native, else a listed wrapped HYPE), its other token,
    ///      and whether HYPE is currency/token 0. Checks the pool belongs to a listed venue.
    function _sides(Route calldata r) private view returns (address hypeSide, address token, bool hypeIs0) {
        address t0;
        address t1;
        if (r.kind == 2) {
            IV2Pair pair = IV2Pair(r.target);
            t0 = pair.token0();
            t1 = pair.token1();
        } else {
            (t0, t1) = _listedPair(r);
        }
        bool h0 = t0 == address(0) || isWrapped[t0];
        bool h1 = isWrapped[t1];
        if (h0 == h1) revert NoHypeSide(); // exactly one side must be HYPE
        (hypeSide, token, hypeIs0) = h0 ? (t0, t1, true) : (t1, t0, false);
        if (r.kind == 2 && (hypeSide == address(0) || _v2Pad(r.target, token).feeBps == 0)) revert NotAllowed();
    }

    /// @dev A v3 pool from a listed factory (checked against the factory) or a v4 pool on a listed
    ///      PoolManager: its two tokens. Launchpad v2 pairs are checked in `_sides`.
    function _listedPair(Route calldata r) private view returns (address t0, address t1) {
        if (r.kind == 3) {
            IV3Pool pool = IV3Pool(r.target);
            t0 = pool.token0();
            t1 = pool.token1();
            address factory = pool.factory();
            if (!isFactory[factory] || IV3Factory(factory).getPool(t0, t1, pool.fee()) != r.target) revert NotAllowed();
        } else if (r.kind == 4) {
            if (!isPoolManager[r.target]) revert NotAllowed();
            t0 = r.key.currency0;
            t1 = r.key.currency1;
        } else {
            revert NotAllowed();
        }
    }

    /// @dev A two-step trade's second pool: listed, holding `mid` and the token traded, neither of
    ///      them HYPE (a HYPE pool is a one-step trade).
    function _hop(Route calldata r, address mid) private view returns (address token, bool midIs0) {
        (address t0, address t1) = _listedPair(r);
        if (t0 == mid) (token, midIs0) = (t1, true);
        else if (t1 == mid) (token, midIs0) = (t0, false);
        else revert NotAllowed();
        if (token == address(0) || isWrapped[token] || mid == address(0) || isWrapped[mid]) revert NotAllowed();
    }

    /// @dev One exact-input swap in a two-step trade's second pool, paid from this contract.
    function _swapHop(Route calldata r, bool zeroForOne, uint256 amountIn, address recipient) private {
        if (amountIn == 0) revert ZeroAmount();
        _active = r.target;
        if (r.kind == 3) {
            IV3Pool pool = IV3Pool(r.target);
            pool.swap(recipient, zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT_PLUS_ONE : MAX_SQRT_MINUS_ONE, abi.encode(pool.token0(), pool.token1()));
        } else {
            IPoolManager(r.target).unlock(abi.encode(r.key, zeroForOne, amountIn, recipient));
        }
        _active = address(0);
    }

    /// @dev The listed launchpad a v2 pair belongs to, checked both ways: the pair names the pad,
    ///      and the pad names the pair as this token's (a pair cannot claim a pad it is not from).
    function _v2Pad(address pair, address token) private view returns (V2Pad memory pad) {
        address factory = IV2Pair(pair).factory();
        pad = v2Pads[factory];
        if (pad.feeBps == 0) revert NotAllowed();
        (bool ok, bytes memory rec) = factory.staticcall(abi.encodeWithSelector(pad.pairLookup, token));
        if (!ok || rec.length < 96) revert NotAllowed();
        address named;
        assembly ("memory-safe") {
            named := mload(add(rec, 96)) // word 2
        }
        if (named != pair) revert NotAllowed();
    }

    /// @dev A v2 trade's output: the pad's fee comes off the HYPE side (in when buying, out when
    ///      selling), then the constant-product formula. One unit less, so rounding never trips
    ///      the pair's own check.
    function _v2Out(address pair, uint16 feeBps, bool hypeIs0, bool buying, uint256 amountIn)
        private
        view
        returns (uint256 out)
    {
        (uint112 r0, uint112 r1,) = IV2Pair(pair).getReserves();
        // Buying: HYPE in, token out. Selling: token in, HYPE out.
        bool inIs0 = buying ? hypeIs0 : !hypeIs0;
        (uint256 rIn, uint256 rOut) = inIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 x = buying ? (amountIn * (BPS - feeBps)) / BPS : amountIn;
        out = (x * rOut) / (rIn + x);
        if (!buying) out = (out * (BPS - feeBps)) / BPS;
        if (out > 0) out -= 1;
    }

    /// @dev Runs one exact-input swap. Buying: `amountIn` HYPE in, tokens to `recipient`.
    ///      Selling: `amountIn` tokens (held here) in, HYPE out as native to this contract.
    function _swap(Route calldata r, address hypeSide, address token, bool hypeIs0, bool buying, uint256 amountIn, address recipient)
        private
    {
        bool zeroForOne = buying ? hypeIs0 : !hypeIs0;
        bool wrapped = hypeSide != address(0);
        uint256 wrappedBefore = wrapped ? IERC20(hypeSide).balanceOf(address(this)) : 0;
        if (buying && wrapped) IWrappedHype(hypeSide).deposit{value: amountIn}();
        if (r.kind == 2) {
            _swapV2(r.target, buying ? hypeSide : token, token, hypeIs0, buying, amountIn, buying ? recipient : address(this));
        } else {
            _active = r.target;
            _swapV3V4(r, hypeSide, token, hypeIs0, zeroForOne, buying, amountIn, recipient);
            _active = address(0);
        }
        // Wrapped HYPE left here (a sale's proceeds, or a buy the pool could not fully take) is
        // unwrapped, so the callers above only deal in native HYPE.
        if (wrapped) {
            uint256 w = IERC20(hypeSide).balanceOf(address(this)) - wrappedBefore;
            if (w > 0) IWrappedHype(hypeSide).withdraw(w);
        }
    }

    /// @dev A v2 pair takes what was sent to it: the input goes in first, then the pair pays out
    ///      the amount worked out from its reserves. What the pair actually received is used, so
    ///      a token with a transfer tax still sells. No callback: the swap data is empty.
    function _swapV2(address pair, address tokenIn, address token, bool hypeIs0, bool buying, uint256 amountIn, address to) private {
        V2Pad memory pad = _v2Pad(pair, token);
        (uint112 r0, uint112 r1,) = IV2Pair(pair).getReserves();
        bool inIs0 = buying ? hypeIs0 : !hypeIs0;
        IERC20(tokenIn).safeTransfer(pair, amountIn);
        // What the pair holds above its reserve is what it will count as paid in.
        uint256 received = IERC20(tokenIn).balanceOf(pair) - (inIs0 ? uint256(r0) : uint256(r1));
        uint256 out = _v2Out(pair, pad.feeBps, hypeIs0, buying, received);
        if (out == 0) revert ZeroAmount();
        bool outIs0 = !inIs0;
        IV2Pair(pair).swap(outIs0 ? out : 0, outIs0 ? 0 : out, to, "");
    }

    function _swapV3V4(Route calldata r, address hypeSide, address token, bool hypeIs0, bool zeroForOne, bool buying, uint256 amountIn, address recipient)
        private
    {
        if (r.kind == 3) {
            (address t0, address t1) = hypeIs0 ? (hypeSide, token) : (token, hypeSide);
            IV3Pool(r.target).swap(
                buying ? recipient : address(this),
                zeroForOne,
                int256(amountIn),
                zeroForOne ? MIN_SQRT_PLUS_ONE : MAX_SQRT_MINUS_ONE,
                abi.encode(t0, t1)
            );
        } else {
            IPoolManager(r.target).unlock(abi.encode(r.key, zeroForOne, amountIn, recipient));
        }
    }

    function _quote(Route calldata r, bool buying, uint256 amountIn) private returns (int256 a0, int256 a1, bool hypeIs0) {
        if (_active != address(0)) revert UnexpectedCaller(); // never in the middle of a swap
        if (amountIn == 0) revert ZeroAmount();
        address hypeSide;
        address token;
        (hypeSide, token, hypeIs0) = _sides(r);
        if (r.kind == 2) {
            // Worked out from the reserves, as the swap does; swapper's side: + received, - paid.
            int256 o = int256(_v2Out(r.target, _v2Pad(r.target, token).feeBps, hypeIs0, buying, amountIn));
            int256 i = -int256(amountIn);
            (a0, a1) = (buying == hypeIs0) ? (i, o) : (o, i);
            return (a0, a1, hypeIs0);
        }
        (address t0, address t1) = hypeIs0 ? (hypeSide, token) : (token, hypeSide);
        (a0, a1) = _simulate(r, buying ? hypeIs0 : !hypeIs0, amountIn, abi.encode(t0, t1));
    }

    /// @dev Runs one exact-input v3 or v4 swap and reverts inside its callback, before anything is
    ///      paid: the pool's amounts from the swapper's side (positive = received, negative = paid).
    function _simulate(Route calldata r, bool zeroForOne, uint256 amountIn, bytes memory v3Data)
        private
        returns (int256 a0, int256 a1)
    {
        if (_active != address(0)) revert UnexpectedCaller();
        if (amountIn == 0) revert ZeroAmount();
        _active = r.target;
        _quoting = true;
        bytes memory reason;
        if (r.kind == 3) {
            try IV3Pool(r.target).swap(
                address(this), zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT_PLUS_ONE : MAX_SQRT_MINUS_ONE, v3Data
            ) {} catch (bytes memory e) {
                reason = e;
            }
        } else {
            try IPoolManager(r.target).unlock(abi.encode(r.key, zeroForOne, amountIn, address(this))) {} catch (bytes memory e) {
                reason = e;
            }
        }
        _active = address(0);
        _quoting = false;
        // Our own Quote error carries the amounts (positive = received); anything else is a real failure.
        if (reason.length != 68 || bytes4(reason) != Quote.selector) {
            assembly ("memory-safe") {
                revert(add(reason, 32), mload(reason))
            }
        }
        assembly ("memory-safe") {
            a0 := mload(add(reason, 36))
            a1 := mload(add(reason, 68))
        }
    }

    function _settle(IPoolManager pm, address currency, uint256 amount) private {
        if (currency == address(0)) {
            pm.settle{value: amount}();
        } else {
            pm.sync(currency);
            IERC20(currency).safeTransfer(address(pm), amount);
            pm.settle();
        }
    }

    function _take(IPoolManager pm, address currency, address to, uint256 amount) private {
        // HYPE always comes back here (native, or wrapped then unwrapped); tokens go straight to `to`.
        if (currency == address(0) || isWrapped[currency]) pm.take(currency, address(this), amount);
        else pm.take(currency, to, amount);
    }

    function _sendHype(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert HypeTransferFailed();
    }

    function _set(mapping(address => bool) storage m, address a, bool on) private {
        if (a == address(0)) revert ZeroAddress();
        m[a] = on;
    }

    // ------------------------------------------------------------------ owner

    /// @notice Homer's fee in basis points; at most 1%.
    function setFee(uint16 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        emit FeeSet(feeBps, feeBps_);
        feeBps = feeBps_;
    }

    function setFeeRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        feeRecipient = recipient;
        emit FeeRecipientSet(recipient);
    }

    function setFactory(address factory, bool on) external onlyOwner {
        _set(isFactory, factory, on);
        emit FactorySet(factory, on);
    }

    function setPoolManager(address manager, bool on) external onlyOwner {
        _set(isPoolManager, manager, on);
        emit PoolManagerSet(manager, on);
    }

    function setWrapped(address token, bool on) external onlyOwner {
        _set(isWrapped, token, on);
        emit WrappedSet(token, on);
    }

    /// @notice Lists a launchpad's v2 pairs (fee in basis points on the HYPE side, at most 10%;
    ///         0 stops using them) and the call on the pad that names a token's pair.
    function setV2Pad(address pad, uint16 feeBps_, bytes4 pairLookup) external onlyOwner {
        _setV2Pad(pad, feeBps_, pairLookup);
    }

    function _setV2Pad(address pad, uint16 feeBps_, bytes4 pairLookup) private {
        if (pad == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_V2_FEE_BPS) revert FeeTooHigh();
        if (feeBps_ > 0 && pairLookup == bytes4(0)) revert NotAllowed();
        v2Pads[pad] = V2Pad(feeBps_, pairLookup);
        emit V2PadSet(pad, feeBps_, pairLookup);
    }

    /// @notice Accepts (or stops accepting) a v3 fork's renamed swap callback.
    function setV3Callback(bytes4 selector, bool on) external onlyOwner {
        if (selector == bytes4(0)) revert ZeroAddress();
        isV3Callback[selector] = on;
        emit V3CallbackSet(selector, on);
    }

    /// @notice Stops new swaps (nothing is ever held here, so there is nothing to withdraw).
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Returns anything sent here by mistake.
    function sweep(address token, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(0)) _sendHype(to, address(this).balance);
        else IERC20(token).safeTransfer(to, IERC20(token).balanceOf(address(this)));
    }
}
