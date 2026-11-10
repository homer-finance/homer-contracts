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

interface IHomerStaking {
    function rewardsToken() external view returns (address);
    function rewardsDuration() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function notifyRewardAmount(uint256 reward) external;
}

/// @title Homer fee router
/// @notice Set as the liquidity manager's treasury. Homer's platform fees in HYPE (any venue's
///         wrapped HYPE, or native) are split on every `distribute()`: `stakerBps` streams to
///         $HOMER stakers through the staking contract, the rest goes to the team wallet.
///         Anyone can call `distribute()`. Until a staking contract is connected (or while
///         nobody is staking) the stakers' share is reserved here, never sent to the team.
///         Fees in other tokens can only be forwarded to the team wallet.
contract HomerFeeRouter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant KIND = "HomerFeeRouter";
    uint16 private constant BPS = 10_000;

    /// @notice Wrapped HYPE paid to stakers; must be the staking contract's rewards token.
    IERC20 public immutable rewardToken;

    address public team;
    IHomerStaking public staking;
    /// @notice Share of HYPE income that goes to stakers, in basis points.
    uint16 public stakerBps;
    /// @notice Reward tokens held for stakers and not streamed yet.
    uint256 public stakerReserve;
    uint256 public totalToStakers;
    uint256 public totalToTeam;

    /// @notice Other venues' wrapped HYPE, unwrapped and rewrapped as `rewardToken`.
    mapping(address => bool) public isWrapped;
    address[] private _wrapped;

    event HomerDeployed(bytes32 indexed kind, address indexed owner);
    event Distributed(uint256 income, uint256 toTeam, uint256 toStakers, uint256 reserve);
    event StakersFundingFailed(uint256 amount);
    event Forwarded(address indexed token, uint256 amount);
    event TeamSet(address indexed team);
    event StakingSet(address indexed staking);
    event StakerShareSet(uint16 stakerBps);
    event WrappedSet(address indexed token, bool on);

    error ZeroAddress();
    error BadShare();
    error WrongRewardToken();
    error ProtectedToken();

    constructor(address owner_, address team_, address rewardToken_, uint16 stakerBps_, address[] memory wrapped_) Ownable(owner_) {
        if (team_ == address(0) || rewardToken_ == address(0)) revert ZeroAddress();
        if (stakerBps_ > BPS) revert BadShare();
        rewardToken = IERC20(rewardToken_);
        team = team_;
        stakerBps = stakerBps_;
        for (uint256 i; i < wrapped_.length; ++i) {
            if (wrapped_[i] != rewardToken_ && wrapped_[i] != address(0) && !isWrapped[wrapped_[i]]) {
                isWrapped[wrapped_[i]] = true;
                _wrapped.push(wrapped_[i]);
            }
        }
        emit TeamSet(team_);
        emit StakerShareSet(stakerBps_);
        emit HomerDeployed(KIND, owner_);
    }

    /// @notice Splits all HYPE income received since the last call. Callable by anyone.
    function distribute() external nonReentrant returns (uint256 toTeam, uint256 toStakers) {
        // Every venue's wrapped HYPE and any native HYPE become the one reward token.
        for (uint256 i; i < _wrapped.length; ++i) {
            address w = _wrapped[i];
            if (!isWrapped[w]) continue;
            uint256 b = IERC20(w).balanceOf(address(this));
            // A wrapper that refuses is skipped, never allowed to block the split.
            if (b > 0) try IWrappedHype(w).withdraw(b) {} catch {}
        }
        if (address(this).balance > 0) IWrappedHype(address(rewardToken)).deposit{value: address(this).balance}();

        uint256 income = rewardToken.balanceOf(address(this)) - stakerReserve;
        uint256 share = (income * stakerBps) / BPS;
        stakerReserve += share;
        toTeam = income - share;
        if (toTeam > 0) {
            totalToTeam += toTeam;
            rewardToken.safeTransfer(team, toTeam);
        }

        IHomerStaking s = staking;
        uint256 reserve = stakerReserve;
        // Stream only when someone is staking (rewards with no stakers would be stranded) and the
        // amount is large enough to give a non-zero rate.
        if (address(s) != address(0) && reserve > 0 && s.totalSupply() > 0 && reserve >= s.rewardsDuration()) {
            stakerReserve = 0;
            rewardToken.forceApprove(address(s), reserve);
            try s.notifyRewardAmount(reserve) {
                toStakers = reserve;
                totalToStakers += reserve;
            } catch {
                stakerReserve = reserve; // stays reserved for stakers
                emit StakersFundingFailed(reserve);
            }
            rewardToken.forceApprove(address(s), 0);
        }
        emit Distributed(income, toTeam, toStakers, stakerReserve);
    }

    /// @notice Sends fees received in any non-HYPE token to the team wallet. Callable by anyone.
    function forward(address token) external nonReentrant {
        if (token == address(rewardToken) || isWrapped[token]) revert ProtectedToken();
        uint256 b = IERC20(token).balanceOf(address(this));
        if (b > 0) IERC20(token).safeTransfer(team, b);
        emit Forwarded(token, b);
    }

    function wrapped() external view returns (address[] memory) {
        return _wrapped;
    }

    // ------------------------------------------------------------------ owner

    function setTeam(address team_) external onlyOwner {
        if (team_ == address(0)) revert ZeroAddress();
        team = team_;
        emit TeamSet(team_);
    }

    function setStakerShare(uint16 stakerBps_) external onlyOwner {
        if (stakerBps_ > BPS) revert BadShare();
        stakerBps = stakerBps_;
        emit StakerShareSet(stakerBps_);
    }

    /// @notice Connects the staking contract that receives the stakers' share (zero disconnects).
    ///         The staking contract must also name this router as its rewards distributor.
    function setStaking(address staking_) external onlyOwner {
        if (staking_ != address(0) && IHomerStaking(staking_).rewardsToken() != address(rewardToken)) revert WrongRewardToken();
        staking = IHomerStaking(staking_);
        emit StakingSet(staking_);
    }

    function setWrapped(address token, bool on) external onlyOwner {
        if (token == address(rewardToken) || token == address(0)) revert ProtectedToken();
        if (on && !isWrapped[token]) {
            bool listed;
            for (uint256 i; i < _wrapped.length; ++i) if (_wrapped[i] == token) listed = true;
            if (!listed) _wrapped.push(token);
        }
        isWrapped[token] = on;
        emit WrappedSet(token, on);
    }

    receive() external payable {}
}
