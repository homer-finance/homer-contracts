# Homer contracts

Smart contracts of [Homer](https://homer.finance), the liquidity layer of Elysium (chain 99901).
Homer gathers every pool on Elysium in one place, swaps at the best rate across all of its DEXes,
and manages liquidity positions on Uniswap v3 and v4-style pools: add with one token, rebalance in
one click, collect fees whenever you like.

All seven deployed contracts are verified on Kinetiq's explorer, [elysium.kinetiq.xyz](https://elysium.kinetiq.xyz).
This repository is their source, with the tests that run them against real Elysium pools.

## Deployed contracts

| Contract | Address | What it does |
|---|---|---|
| [HomerSwap](src/HomerSwap.sol) | [`0xa9967eaba36531526a1458aed9b16453adcfb7e9`](https://elysium.kinetiq.xyz/address/0xa9967eaba36531526a1458aed9b16453adcfb7e9) | Buys and sells any token against HYPE through the pool Homer picks (Uniswap v3-style, v4 and launchpad v2 pairs), in one transaction. |
| [HomerLiquidityManager](src/HomerLiquidityManager.sol) | [`0xdb61b2fba50ced1f6271963d9e357ed9d2136420`](https://elysium.kinetiq.xyz/address/0xdb61b2fba50ced1f6271963d9e357ed9d2136420) | Holds Uniswap v3-style LP positions for their owners: add, zap in with one token, collect, remove, rebalance, withdraw the NFT. |
| [HomerV4Manager](src/HomerV4Manager.sol) | [`0x63b202b8c36b0cd35782af0068d0a60fd1394b86`](https://elysium.kinetiq.xyz/address/0x63b202b8c36b0cd35782af0068d0a60fd1394b86) | The same for Uniswap v4 positions, and creates new pools (with Homer's hook) in the same transaction as their first position. |
| [HomerPoolHook](src/HomerPoolHook.sol) | [`0x1295bd9d641185f361016a898a61a801c0d3e044`](https://elysium.kinetiq.xyz/address/0x1295bd9d641185f361016a898a61a801c0d3e044) | The Uniswap v4 hook on pools created on Homer: takes Homer's 10% of the pool fee on every swap. |
| [HomerFeeRouter](src/HomerFeeRouter.sol) | [`0x4163dba007351b9d23691e1eaaa687db0d3e92ed`](https://elysium.kinetiq.xyz/address/0x4163dba007351b9d23691e1eaaa687db0d3e92ed) | Receives all of Homer's fees and splits them: `stakerBps` to $HOMER stakers, the rest to the team. Anyone can call `distribute()`. |
| [HomerStaking](src/HomerStaking.sol) | [`0x5bdc2d45b54f909bae587ff3a051299e802fd6e8`](https://elysium.kinetiq.xyz/address/0x5bdc2d45b54f909bae587ff3a051299e802fd6e8) | Stake $HOMER, earn HYPE (paid as WHYPE) streamed over each 7-day period (Synthetix StakingRewards model). |
| [HomerReferralVault](src/HomerReferralVault.sol) | [`0xec4eb0112ede937094d164659569b9c9949ec5dd`](https://elysium.kinetiq.xyz/address/0xec4eb0112ede937094d164659569b9c9949ec5dd) | Referrers claim their rewards here in HYPE, with a voucher signed by Homer (EIP-712). Funded by the team from its share. |

The $HOMER token ([`0x365be4728d0ee2140e8b75a05c5dcf6b7d76399a`](https://elysium.kinetiq.xyz/address/0x365be4728d0ee2140e8b75a05c5dcf6b7d76399a)) was launched on a launchpad: fixed 1B supply, no owner, no minting. [src/HomerToken.sol](src/HomerToken.sol) is not that token; it is the plain fixed-supply token the tests stake with.

Earlier versions of the managers and of HomerSwap stay live for positions and trades opened through them: liquidity managers `0xff60e4f370c0243a820e0864ca92e1eb6ab7937e`, `0xfcbd0977c9e610a1d53f56746d7b6cc5fb5fb9b9`, `0x9ba039830404b8f658f8a79e774338cad510621a`, `0xa70551dc12b4c2cd52b4a91127a204e8eb233d10`; v4 managers `0x2168787fa608338be994ba7e0e3852589ae0715f`, `0xcf76489a3f2bda1a15825a600ef25d28315cf83c`; Homer Swap `0xcdef14ba5177ec3700067a70ca1f21c9d3415489`, `0x1cae4a793ce7b8ed136d1143ed31e402f9b53873`.

## How fees flow

```
LP fees you collect ──► 86% to you, 14% Homer share (feeBps 1400, capped at 25% in code) ─┐
Homer Swap trades   ──► 0.25% of the HYPE side (feeBps 25, capped at 1% in code) ─────────┤
Pools created on Homer ► Homer's hook: 10% of the pool fee (fixed in code) ────────────────┤
                                                                                           ▼
                                                    HomerFeeRouter ── 60% ──► HomerStaking (stakers, in HYPE)
                                                                   └─ 40% ──► team
```

- Principal is never charged. Only collected trading fees are shared, and only at collection.
- Pools created on Homer pay Homer through the hook, so the managers take no extra share there.
- Referral rewards (20% of what Homer earns from a referred wallet) come out of the team's part; stakers' share is never touched.

## What the owner can and cannot do

All seven contracts are owned by one wallet, `0x206e52b4b2ef813a1b34793091c9b87761e775f4` (`Ownable2Step`).

| Contract | The owner can | The owner cannot |
|---|---|---|
| HomerLiquidityManager, HomerV4Manager | Set the fee share (at most 25%), the treasury, which position managers are allowed; pause **new** deposits, zaps and rebalances. | Touch a position or its principal. Collecting, removing and withdrawing your position are never paused, and only the position's owner can do them. |
| HomerSwap | Set the fee (at most 1%), its recipient, and the listed factories, PoolManagers and launchpads; pause swaps. | Take anything from a trade beyond the fee: every swap has the trader's minimum output and deadline. The contract holds nothing between transactions. |
| HomerPoolHook | Change where Homer's cut is sent. | Change the cut (10% of the pool fee, fixed) or pool fees (at most 9% LP fee). |
| HomerFeeRouter | Set the stakers' share, the team wallet, the staking contract. | Send the stakers' reserved share to the team. |
| HomerStaking | Set the reward period length between periods; pause **new** stakes. | Touch staked $HOMER. Unstaking and claiming are never paused. |
| HomerReferralVault | Pause claims, change the signer and limits (now 25 HYPE per claim, 100 HYPE per day), take back unclaimed HYPE. | Pay out more than the limits allow per claim and per day, or pay a voucher to anyone but its own account. |

## Build

```bash
npm install
npm run build          # solc 0.8.28, viaIR, 200 runs, EVM shanghai -> out/<Name>.json
npm run verify-input   # out/verify/standard-input.json, the exact input the explorer verified
```

The build reproduces the deployed code: for every contract the runtime bytecode has the same size as on chain and differs only in the deploy-time values (immutables). See [VERIFY.md](VERIFY.md) for compiler settings and constructor arguments.

## Tests

The tests fork Elysium and run the contracts against live pools (KleosSwap, ElysPump, BOXA, Uniswap v4, launchpad pools, Obol pairs). `FORK_URL` (or `FORK_RPC` / `RPC_URL` where a script says so) picks the node; the default is Kinetiq's official RPC.

```bash
npm run build
npm test                 # liquidity manager, staking, fee router, rebalance (scripts/fork.js)
npm run test:swap        # Homer Swap on real pools
npm run test:v4          # pools created on Homer: the hook's cut, v4 positions, Homer Swap through them
npm run test:refvault    # referral vault: vouchers, limits, pause
```

Other scripts in `scripts/` cover launchpad pools (`fork-lp-launchpads.js`), two-step routes (`fork-via.js`), Uniswap's shared v4 PoolManager (`fork-v4shared.js`), RONS and Obol pairs, and pools created on Homer. A fork test needs a node that serves historical state; on a rate-limited public node, run them one at a time.

Hardhat's well-known test accounts carry EIP-7702 delegations on live Elysium, so the tests use fresh random wallets ([scripts/lib/wallets.js](scripts/lib/wallets.js)).

## License

MIT, see [LICENSE](LICENSE).
