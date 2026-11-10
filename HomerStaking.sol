// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Homer staking
/// @notice Stake $HOMER, earn a share of a reward stream that runs at a constant rate over each
///         reward period (Synthetix StakingRewards model). Rewards are funded with
///         `notifyRewardAmount` by the owner or the rewards distributor (Homer's fee router);
///         staked tokens can never be touched by the owner, and pausing only blocks new stakes.
contract HomerStaking is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant KIND = "HomerStaking";

    IERC20 public immutable rewardsToken;
    IERC20 public immutable stakingToken;

    uint256 public periodFinish;
    uint256 public rewardRate;
    uint256 public rewardsDuration = 7 days;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;
    /// @notice Besides the owner, the only address that may fund rewards (the fee router).
    address public rewardsDistributor;

    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;

    event HomerDeployed(bytes32 indexed kind, address indexed owner);
    event RewardAdded(uint256 reward);
    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardsDurationUpdated(uint256 newDuration);
    event Recovered(address token, uint256 amount);
    event RewardsDistributorSet(address indexed distributor);

    error ZeroAmount();
    error ZeroAddress();
    error RewardTooHigh();
    error PeriodActive();
    error ProtectedToken();
    error NotDistributor();

    constructor(address owner_, address rewardsToken_, address stakingToken_) Ownable(owner_) {
        if (rewardsToken_ == address(0) || stakingToken_ == address(0)) revert ZeroAddress();
        rewardsToken = IERC20(rewardsToken_);
        stakingToken = IERC20(stakingToken_);
        emit HomerDeployed(KIND, owner_);
    }

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    // ------------------------------------------------------------------ views

    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (_totalSupply == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * 1e18) / _totalSupply;
    }

    function earned(address account) public view returns (uint256) {
        return (_balances[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / 1e18 + rewards[account];
    }

    function getRewardForDuration() external view returns (uint256) {
        return rewardRate * rewardsDuration;
    }

    // ------------------------------------------------------------------ user actions

    function stake(uint256 amount) external nonReentrant whenNotPaused updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        uint256 before = stakingToken.balanceOf(address(this));
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = stakingToken.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
        _totalSupply += received;
        _balances[msg.sender] += received;
        emit Staked(msg.sender, received);
    }

    function withdraw(uint256 amount) public nonReentrant updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        _totalSupply -= amount;
        _balances[msg.sender] -= amount;
        stakingToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function getReward() public nonReentrant updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            rewardsToken.safeTransfer(msg.sender, reward);
            emit RewardPaid(msg.sender, reward);
        }
    }

    function exit() external {
        uint256 bal = _balances[msg.sender];
        if (bal > 0) withdraw(bal);
        getReward();
    }

    // ------------------------------------------------------------------ owner

    /// @notice Pulls `reward` from the caller (owner or rewards distributor) and streams it over
    ///         `rewardsDuration`, adding to whatever is left of the current period.
    function notifyRewardAmount(uint256 reward) external updateReward(address(0)) {
        if (msg.sender != owner() && msg.sender != rewardsDistributor) revert NotDistributor();
        uint256 before = rewardsToken.balanceOf(address(this));
        rewardsToken.safeTransferFrom(msg.sender, address(this), reward);
        reward = rewardsToken.balanceOf(address(this)) - before;
        if (reward == 0) revert ZeroAmount();

        if (block.timestamp >= periodFinish) {
            rewardRate = reward / rewardsDuration;
        } else {
            uint256 leftover = (periodFinish - block.timestamp) * rewardRate;
            rewardRate = (reward + leftover) / rewardsDuration;
        }
        if (rewardRate == 0) revert ZeroAmount();

        // The rate must be covered by reward tokens actually held (excluding stakes when the
        // reward and staking token are the same), so payouts can never exceed the balance.
        uint256 balance = rewardsToken.balanceOf(address(this));
        if (address(rewardsToken) == address(stakingToken)) balance -= _totalSupply;
        if (rewardRate > balance / rewardsDuration) revert RewardTooHigh();

        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + rewardsDuration;
        emit RewardAdded(reward);
    }

    function setRewardsDistributor(address distributor) external onlyOwner {
        rewardsDistributor = distributor;
        emit RewardsDistributorSet(distributor);
    }

    function setRewardsDuration(uint256 duration) external onlyOwner {
        if (block.timestamp <= periodFinish) revert PeriodActive();
        if (duration == 0) revert ZeroAmount();
        rewardsDuration = duration;
        emit RewardsDurationUpdated(duration);
    }

    /// @notice Returns tokens sent here by mistake. Stakes and rewards cannot be recovered.
    function recoverERC20(address token, uint256 amount) external onlyOwner {
        if (token == address(stakingToken) || token == address(rewardsToken)) revert ProtectedToken();
        IERC20(token).safeTransfer(owner(), amount);
        emit Recovered(token, amount);
    }

    /// @notice Blocks new stakes. Withdrawing and claiming are always open.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
