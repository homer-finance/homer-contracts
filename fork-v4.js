'use strict';
// Fork tests for Homer's v4 pools: HomerPoolHook (Homer's 10% cut of every swap in pools created
// on Homer) and HomerV4Manager (v4 positions through the Uniswap v4 PositionManager on ElysPump's
// PoolManager), with HomerSwap trading through the new pool.
// Uniswap v4 needs transient storage, so this runs on a Cancun fork:
//   npm run build && npx hardhat --config hardhat.cancun.config.js run scripts/fork-v4.js
// FORK_URL / FORK_BLOCK choose the node and block.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const hre = require('hardhat');
const { freshSigners } = require('./lib/wallets.js');
const { ethers } = require('ethers');
const C = require('./lib/chain.js'); // the site's own swap planner, as the Add dialog uses it

const PM = '0x5fb015a49f5b35073f9ce01c2adb287a75f89600'; // ElysPump's v4 PoolManager
const POSM = '0x1f9b957071228a3190280e062cc62a3f66b6a13a'; // Uniswap v4 PositionManager on it
const CREATE2 = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const HOMER = '0x365Be4728d0Ee2140e8b75A05C5DCf6b7D76399A';
const WRAPPED = ['0x0269031ace34a7821e9d9980d087c35ce7c19eef', '0xba876237b0f021a6c6d852d6c26e107997cc5e81'];
const ZERO = ethers.ZeroAddress;
const FEE_BPS = 1400n; // the manager's share in pools without Homer's hook
const art = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'out', n + '.json'), 'utf8'));

const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)'];
const ERC721 = ['function ownerOf(uint256) view returns (address)'];
const POSM_ABI = ['function getPositionLiquidity(uint256) view returns (uint128)', 'function nextTokenId() view returns (uint256)'];

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log('  ok  ' + name);
}
async function reverts(p, label) {
  try {
    const tx = await p;
    if (tx && typeof tx.wait === 'function') await tx.wait();
  } catch {
    return;
  }
  assert.fail('expected revert: ' + label);
}

async function fund(provider, token, who, amount) {
  const t = new ethers.Contract(token, ERC20, provider);
  for (let slot = 0; slot < 12; slot++) {
    const key = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [who, slot]));
    const prev = await provider.send('eth_getStorageAt', [token, key, 'latest']);
    await provider.send('hardhat_setStorageAt', [token, key, ethers.toBeHex(amount, 32)]);
    if ((await t.balanceOf(who)) === amount) return;
    await provider.send('hardhat_setStorageAt', [token, key, prev]);
  }
  throw new Error('balance slot not found for ' + token);
}

// The hook's address must carry its permission bits: CREATE2 salts are tried until it does.
function mineHook(initcode) {
  const hash = ethers.keccak256(initcode);
  for (let i = 0; i < 2_000_000; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(CREATE2, salt, hash);
    if ((BigInt(addr) & 0x3fffn) === 0x2044n) return { salt, addr };
  }
  throw new Error('no salt');
}

// Liquidity for amounts at price s (sqrt of currency1 per currency0), range [tl, tu].
function liquidityFor(x, y, s, tl, tu) {
  const sa = Math.pow(1.0001, tl / 2);
  const sb = Math.pow(1.0001, tu / 2);
  const Lx = s < sb ? (Number(x) * s * sb) / (sb - Math.max(s, sa)) : Infinity;
  const Ly = s > sa ? Number(y) / (Math.min(s, sb) - sa) : Infinity;
  return BigInt(Math.floor(Math.min(Lx, Ly) * 0.995));
}

async function main() {
  const provider = new ethers.BrowserProvider(hre.network.provider);
  // The forked block's header has no blob-gas fields, which Cancun execution needs: run on a
  // fresh local block instead.
  await provider.send('evm_mine', []);
  const [owner, alice, bob, mallory, , , , , , treasury] = await freshSigners(provider, 10);
  const [ownerA, aliceA, bobA, , treasuryA] = await Promise.all([owner, alice, bob, mallory, treasury].map((s) => s.getAddress()));
  const deadline = async () => BigInt((await provider.getBlock('latest')).timestamp + 3600);
  const bal = (a) => provider.getBalance(a);
  const homer = new ethers.Contract(HOMER, ERC20, provider);
  const posm = new ethers.Contract(POSM, [...ERC721, ...POSM_ABI], provider);
  for (const who of [aliceA, bobA]) await fund(provider, HOMER, who, ethers.parseEther('50000000'));

  // ------------------------------------------------------------------ deploy
  const Hk = art('HomerPoolHook');
  const initcode = ethers.concat([Hk.bytecode, ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address', 'address'], [PM, ownerA, treasuryA])]);
  const { salt, addr: hookA } = mineHook(initcode);
  await (await owner.sendTransaction({ to: CREATE2, data: ethers.concat([salt, initcode]) })).wait();
  assert.ok((await provider.getCode(hookA)).length > 2, 'hook deployed at the mined address');
  const hook = new ethers.Contract(hookA, Hk.abi, owner);
  console.log('hook', hookA);

  const M = art('HomerV4Manager');
  const mgr = await new ethers.ContractFactory(M.abi, M.bytecode, owner).deploy(ownerA, treasuryA, FEE_BPS, [POSM], [hookA]);
  await mgr.waitForDeployment();
  const mgrA = await mgr.getAddress();
  console.log('manager', mgrA);

  const S = art('HomerSwap');
  const swap = await new ethers.ContractFactory(S.abi, S.bytecode, owner).deploy(ownerA, treasuryA, 25, [], [PM], WRAPPED, [], []);
  await swap.waitForDeployment();
  const swapA = await swap.getAddress();

  // HOMER's market price from its main pool: currency0 = native HYPE, currency1 = HOMER, both 18 dp.
  const homerPerHype = 1 / 2.4e-6;
  const sqrtP = Math.sqrt(homerPerHype);
  const sqrtX96 = BigInt(Math.floor(sqrtP * 2 ** 96));
  const keyHook = { currency0: ZERO, currency1: HOMER, fee: 9000, tickSpacing: 200, hooks: hookA }; // 1%: 0.9% LPs + 0.1% Homer
  const keyPlain = { currency0: ZERO, currency1: HOMER, fee: 3000, tickSpacing: 60, hooks: ZERO }; // a pool without the hook
  const TL = -887200;
  const TU = 887200;

  // ------------------------------------------------------------------ create + mint
  let tokenId;
  const ONE = ethers.parseEther('1');
  const homerMax = ethers.parseEther(String(Math.ceil(homerPerHype * 1.02)));
  await step('create a Homer pool (1%) and open a position in one transaction', async () => {
    await (await homer.connect(alice).approve(mgrA, homerMax)).wait();
    tokenId = await posm.nextTokenId();
    const L = liquidityFor(ONE, homerMax, sqrtP, TL, TU);
    const h0 = await homer.balanceOf(aliceA);
    const rc = await (await mgr.connect(alice).mint({ posm: POSM, key: keyHook, tickLower: TL, tickUpper: TU, liquidity: L, amount0Max: ONE, amount1Max: homerMax, deadline: await deadline(), createAtSqrtPriceX96: sqrtX96 }, { value: ONE })).wait();
    assert.equal(await posm.ownerOf(tokenId), mgrA, 'Homer holds the NFT');
    assert.equal(await mgr.ownerOf(POSM, tokenId), aliceA, 'registered to alice');
    assert.ok((await posm.getPositionLiquidity(tokenId)) === L);
    const minted = rc.logs.map((l) => { try { return mgr.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'Minted');
    assert.ok(minted.args.amount0 > 0n && minted.args.amount0 <= ONE);
    const spentHomer = h0 - (await homer.balanceOf(aliceA));
    assert.equal(spentHomer, minted.args.amount1, 'unused HOMER refunded');
    assert.equal(await bal(mgrA), 0n);
    assert.equal(await homer.balanceOf(mgrA), 0n);
  });

  await step('a second create at the same key just adds a position (the pool exists)', async () => {
    const L = liquidityFor(ONE / 10n, homerMax / 10n, sqrtP, TL, TU);
    await (await homer.connect(alice).approve(mgrA, homerMax / 10n)).wait();
    await (await mgr.connect(alice).mint({ posm: POSM, key: keyHook, tickLower: TL, tickUpper: TU, liquidity: L, amount0Max: ONE / 10n, amount1Max: homerMax / 10n, deadline: await deadline(), createAtSqrtPriceX96: sqrtX96 }, { value: ONE / 10n })).wait();
    assert.equal((await mgr.positionsOf(aliceA)).length, 2);
  });

  // ------------------------------------------------------------------ swaps pay Homer's cut
  const route = { kind: 4, target: PM, key: keyHook };
  // Steps that create pools run first: the remote node prunes old state within minutes.
  await step('a pool without Homer\'s hook: the manager takes its 14% share of fees', async () => {
    const L = liquidityFor(ONE, homerMax, sqrtP, -887220, 887220);
    await (await homer.connect(alice).approve(mgrA, homerMax)).wait();
    const id = await posm.nextTokenId();
    await (await mgr.connect(alice).mint({ posm: POSM, key: keyPlain, tickLower: -887220, tickUpper: 887220, liquidity: L, amount0Max: ONE, amount1Max: homerMax, deadline: await deadline(), createAtSqrtPriceX96: sqrtX96 }, { value: ONE })).wait();
    const plainRoute = { kind: 4, target: PM, key: keyPlain };
    await (await swap.connect(bob).buy(plainRoute, 0, await deadline(), { value: ethers.parseEther('0.3') })).wait();
    const rc = await (await mgr.connect(alice).collect(POSM, id)).wait();
    const ev = rc.logs.map((l) => { try { return mgr.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'FeesCollected');
    const total = ev.args.lp0 + ev.args.fee0;
    assert.ok(total > 0n);
    assert.equal(ev.args.fee0, (total * FEE_BPS) / 10000n, '14% to the treasury');
  });

  await step('the hook refuses a fee above 9% (10% total) and dynamic fees', async () => {
    const pmC = new ethers.Contract(PM, ['function initialize((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,uint160 sqrtPriceX96) returns (int24)'], alice);
    await reverts(pmC.initialize({ ...keyHook, fee: 95000, tickSpacing: 1000 }, sqrtX96), 'fee > 9%');
    await reverts(pmC.initialize({ ...keyHook, fee: 0x800000, tickSpacing: 1000 }, sqrtX96), 'dynamic fee');
    await (await pmC.initialize({ ...keyHook, fee: 90000, tickSpacing: 1800 }, sqrtX96)).wait(); // exactly 9% is fine
  });
  await step('a buy through Homer Swap: Homer\'s hook takes 10% of the pool fee, in HOMER', async () => {
    const t0 = await homer.balanceOf(treasuryA);
    const rc = await (await swap.connect(bob).buy(route, 0, await deadline(), { value: ethers.parseEther('0.2') })).wait();
    const cut = (await homer.balanceOf(treasuryA)) - t0;
    const ev = rc.logs.map((l) => { try { return hook.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'HomerFee');
    assert.ok(ev, 'HomerFee event');
    assert.equal(ev.args.amount, cut, 'cut sent to the recipient');
    const bought = rc.logs.map((l) => { try { return swap.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'Swapped').args.tokenAmount;
    // cut = output x 0.9% / 9 = 0.1% of the output (before the cut)
    const ratio = Number(cut) / Number(bought + cut);
    assert.ok(ratio > 0.00099 && ratio < 0.00101, 'cut is 0.1% of the output: ' + ratio);
  });

  await step('a sell through Homer Swap: the cut comes in HYPE', async () => {
    await (await homer.connect(bob).approve(swapA, ethers.parseEther('100000'))).wait();
    const t0 = await bal(treasuryA);
    const rc = await (await swap.connect(bob).sell(route, ethers.parseEther('100000'), 0, await deadline())).wait();
    const ev = rc.logs.map((l) => { try { return hook.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'HomerFee');
    assert.equal(ev.args.currency, ZERO);
    const sw = rc.logs.map((l) => { try { return swap.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'Swapped');
    // treasury got Homer Swap's 0.25% and the hook's cut
    assert.equal((await bal(treasuryA)) - t0, sw.args.fee + ev.args.amount);
  });

  // ------------------------------------------------------------------ manage
  await step('collect in a Homer-hook pool: LPs keep 100% of their fees (Homer already took its cut)', async () => {
    const t0 = await bal(treasuryA);
    const th0 = await homer.balanceOf(treasuryA);
    const a0 = await bal(aliceA);
    const rc = await (await mgr.connect(alice).collect(POSM, tokenId)).wait();
    const ev = rc.logs.map((l) => { try { return mgr.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'FeesCollected');
    assert.ok(ev && (ev.args.lp0 > 0n || ev.args.lp1 > 0n), 'fees earned');
    assert.equal(ev.args.fee0, 0n);
    assert.equal(ev.args.fee1, 0n);
    assert.equal(await bal(treasuryA), t0);
    assert.equal(await homer.balanceOf(treasuryA), th0);
    const gas = rc.gasUsed * rc.gasPrice;
    assert.equal((await bal(aliceA)) + gas - a0, ev.args.lp0);
  });

  await step('increase, then remove half: tokens back to the wallet', async () => {
    const L0 = await posm.getPositionLiquidity(tokenId);
    // The swaps above moved the price: leave headroom, the position manager takes only what it needs.
    const add = (liquidityFor(ONE / 2n, homerMax, sqrtP, TL, TU) * 8n) / 10n;
    await (await homer.connect(alice).approve(mgrA, homerMax)).wait();
    await (await mgr.connect(alice).increase({ posm: POSM, tokenId, liquidity: add, amount0Max: ONE / 2n, amount1Max: homerMax, deadline: await deadline() }, { value: ONE / 2n })).wait();
    const L1 = await posm.getPositionLiquidity(tokenId);
    assert.equal(L1, L0 + add);
    const h0 = await homer.balanceOf(aliceA);
    await (await mgr.connect(alice).decrease({ posm: POSM, tokenId, liquidity: L1 / 2n, amount0Min: 0, amount1Min: 0, deadline: await deadline() })).wait();
    assert.equal(await posm.getPositionLiquidity(tokenId), L1 - L1 / 2n);
    assert.ok((await homer.balanceOf(aliceA)) > h0, 'HOMER back');
    assert.equal(await bal(mgrA), 0n);
    assert.equal(await homer.balanceOf(mgrA), 0n);
  });

  await step('withdraw hands the v4 NFT to its owner', async () => {
    await (await mgr.connect(alice).withdraw(POSM, tokenId, aliceA)).wait();
    assert.equal(await posm.ownerOf(tokenId), aliceA);
    assert.equal(await mgr.ownerOf(POSM, tokenId), ZERO);
    assert.equal((await mgr.positionsOf(aliceA)).length, 2); // the second Homer-pool position and the plain-pool one
  });

  await step('only the position owner can collect, add, remove or withdraw', async () => {
    const [p] = await mgr.positionsOf(aliceA);
    await reverts(mgr.connect(mallory).collect(p.posm, p.tokenId), 'collect');
    await reverts(mgr.connect(mallory).decrease({ posm: p.posm, tokenId: p.tokenId, liquidity: 1, amount0Min: 0, amount1Min: 0, deadline: await deadline() }), 'decrease');
    await reverts(mgr.connect(mallory).withdraw(p.posm, p.tokenId, await mallory.getAddress()), 'withdraw');
  });
  await step('paused: no new positions; removing still works', async () => {
    await (await mgr.pause()).wait();
    const [p] = await mgr.positionsOf(aliceA);
    await reverts(mgr.connect(alice).mint({ posm: POSM, key: keyHook, tickLower: TL, tickUpper: TU, liquidity: 1000, amount0Max: ONE, amount1Max: 0, deadline: await deadline(), createAtSqrtPriceX96: 0 }, { value: ONE }), 'paused mint');
    await (await mgr.connect(alice).decrease({ posm: p.posm, tokenId: p.tokenId, liquidity: 1000, amount0Min: 0, amount1Min: 0, deadline: await deadline() })).wait();
    await (await mgr.unpause()).wait();
  });
  await step('wrong HYPE amount, unlisted position manager, and stray NFTs are refused', async () => {
    const args = { posm: POSM, key: keyHook, tickLower: TL, tickUpper: TU, liquidity: 1000, amount0Max: ONE, amount1Max: 0, deadline: await deadline(), createAtSqrtPriceX96: 0 };
    await reverts(mgr.connect(alice).mint(args, { value: ONE - 1n }), 'value != amount0Max');
    await reverts(mgr.connect(alice).mint({ ...args, posm: PM }, { value: ONE }), 'unlisted posm');
    const nft = new ethers.Contract(POSM, ['function safeTransferFrom(address,address,uint256)'], alice);
    await reverts(nft.safeTransferFrom(aliceA, mgrA, tokenId), 'stray NFT');
  });
  await step('fee limits and owner-only settings', async () => {
    await reverts(mgr.setFee(2501), 'fee cap');
    await reverts(mgr.connect(alice).setFee(10), 'not owner');
    await reverts(hook.connect(alice).setRecipient(aliceA), 'hook owner only');
  });
  // ------------------------------------------------------------------ rebalance (v2)
  // The pool's current tick and sqrt price, read from PoolManager storage (StateLibrary slot 6).
  const pmRead = new ethers.Contract(PM, ['function extsload(bytes32) view returns (bytes32)'], provider);
  const slot0 = async (key) => {
    const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
    const w = BigInt(await pmRead.extsload(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [id, 6]))));
    const sqrtX96 = w & ((1n << 160n) - 1n);
    let tick = Number((w >> 160n) & 0xffffffn);
    if (tick >= 0x800000) tick -= 0x1000000;
    return { tick, s: Number(sqrtX96) / 2 ** 96 };
  };
  await step('rebalance: an out-of-range position moves to a new range in one transaction', async () => {
    // A narrow position around the current price...
    let { tick, s } = await slot0(keyHook);
    const tl = Math.floor(tick / 200) * 200 - 200;
    const tu = tl + 600;
    const L = liquidityFor(ONE / 10n, homerMax, s, tl, tu);
    await (await homer.connect(alice).approve(mgrA, homerMax)).wait();
    const oldId = await posm.nextTokenId();
    await (await mgr.connect(alice).mint({ posm: POSM, key: keyHook, tickLower: tl, tickUpper: tu, liquidity: L, amount0Max: ONE, amount1Max: homerMax, deadline: await deadline(), createAtSqrtPriceX96: 0 }, { value: ONE })).wait();
    // ...then a big buy pushes the price out of it (HYPE in: the tick goes down).
    await (await swap.connect(bob).buy(route, 0, await deadline(), { value: ethers.parseEther('3') })).wait();
    ({ tick, s } = await slot0(keyHook));
    assert.ok(tick < tl, `out of range: tick ${tick} < ${tl}`);
    // Below the range the position holds only HYPE: swap a third of it, open a range around the price.
    const tl2 = Math.floor(tick / 200) * 200 - 400;
    const tu2 = tl2 + 1000;
    const swapIn = ethers.parseEther('0.02');
    const homerPerHype = s * s;
    const L2 = liquidityFor(ethers.parseEther('0.02'), BigInt(Math.floor(0.015 * homerPerHype * 1e18)), s, tl2, tu2); // a floor: the mint takes the most the principal buys
    const nativeBefore = await bal(aliceA);
    const rc = await (await mgr.connect(alice).rebalance({ posm: POSM, tokenId: oldId, tickLower: tl2, tickUpper: tu2, remove0Min: 0, remove1Min: 0, zeroForOne: true, swapIn, swapOutMin: 1, liquidityMin: L2, deadline: await deadline() })).wait();
    const ev = rc.logs.map((l) => { try { return mgr.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'Rebalanced');
    assert.ok(ev, 'Rebalanced event');
    const newId = ev.args.newTokenId;
    const Lnew = await posm.getPositionLiquidity(newId);
    assert.ok(Lnew >= L2, 'at least the minimum');
    assert.equal(ev.args.liquidity, Lnew);
    assert.equal(await mgr.ownerOf(POSM, newId), aliceA);
    assert.equal(await mgr.ownerOf(POSM, oldId), ZERO, 'old position closed');
    await reverts(posm.ownerOf(oldId), 'old NFT burned');
    const ids = (await mgr.positionsOf(aliceA)).map((p) => p.tokenId);
    assert.ok(ids.includes(newId) && !ids.includes(oldId));
    assert.ok((await bal(aliceA)) > nativeBefore - ethers.parseEther('0.01'), 'leftover HYPE back to the owner (less gas)');
    assert.equal(await bal(mgrA), 0n, 'nothing left in the manager');
    assert.equal(await homer.balanceOf(mgrA), 0n);
  });
  await step('rebalance guards: owner only, swap no larger than the principal, callback only from the PoolManager', async () => {
    const [p] = await mgr.positionsOf(aliceA);
    const args = { posm: p.posm, tokenId: p.tokenId, tickLower: -887200, tickUpper: 887200, remove0Min: 0, remove1Min: 0, zeroForOne: true, swapIn: 0, swapOutMin: 0, liquidityMin: 1000, deadline: await deadline() };
    await reverts(mgr.connect(mallory).rebalance(args), 'not the owner');
    await reverts(mgr.connect(alice).rebalance({ ...args, swapIn: ethers.parseEther('1000') }), 'swap larger than the principal');
    await reverts(mgr.connect(mallory).unlockCallback('0x'), 'unlockCallback from anyone');
    await reverts(mgr.connect(alice).rebalance({ ...args, liquidityMin: 10n ** 30n }), 'less liquidity than the minimum');
    assert.equal(await mgr.VERSION(), 3n);
  });

  // ------------------------------------------------------------------ zap (v3)
  // Active liquidity, StateLibrary: pool state slot + 3.
  const poolLiquidity = async (key) => {
    const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
    const base = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [id, 6])));
    return BigInt(await pmRead.extsload(ethers.toBeHex(base + 3n, 32))) & ((1n << 128n) - 1n);
  };
  // The site's plan for depositing one side only: how much to swap, and a liquidity floor.
  const zapPlan = async (key, zeroForOne, amountIn, tl, tu) => {
    const { s } = await slot0(key);
    const L = Number(await poolLiquidity(key));
    const fee = key.hooks === hookA ? Math.round((key.fee * 10) / 9) : key.fee; // the hook's cut on top
    const plan = C.planRebalance({ s, L, fee, tl, tu, have0: zeroForOne ? Number(amountIn) : 0, have1: zeroForOne ? 0 : Number(amountIn) });
    assert.ok(plan && plan.zeroForOne === zeroForOne, 'the plan swaps from the deposited side');
    const Lmin = BigInt(Math.floor(Math.min(plan.use0 > 0 ? plan.use0 / C.amountsForLiquidity(1, plan.s1, tl, tu)[0] : Infinity, plan.use1 > 0 ? plan.use1 / C.amountsForLiquidity(1, plan.s1, tl, tu)[1] : Infinity) * 0.97));
    return { swapIn: BigInt(Math.floor(plan.swapIn)), swapOutMin: BigInt(Math.floor(plan.out * 0.97)), liquidityMin: Lmin, plan };
  };
  const zapTotals = async (rc) => rc.logs.map((l) => { try { return mgr.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'Minted');

  await step('zap with HYPE only: part is swapped in the pool, a full-range position opens, the rest comes back', async () => {
    const amountIn = ethers.parseEther('0.5');
    const z = await zapPlan(keyHook, true, amountIn, TL, TU);
    assert.ok(z.swapIn > amountIn / 3n && z.swapIn < (amountIn * 2n) / 3n, 'about half is swapped for full range');
    const id = await posm.nextTokenId();
    const nativeBefore = await bal(aliceA);
    const homerBefore = await homer.balanceOf(aliceA);
    const rc = await (await mgr.connect(alice).zap({ posm: POSM, key: keyHook, tickLower: TL, tickUpper: TU, zeroForOne: true, amountIn, swapIn: z.swapIn, swapOutMin: z.swapOutMin, liquidityMin: z.liquidityMin, deadline: await deadline() }, { value: amountIn })).wait();
    const ev = await zapTotals(rc);
    assert.ok(ev && ev.args.tokenId === id, 'Minted event for the new position');
    assert.equal(await posm.ownerOf(id), mgrA, 'Homer holds the NFT');
    assert.equal(await mgr.ownerOf(POSM, id), aliceA, 'registered to alice');
    const L = await posm.getPositionLiquidity(id);
    assert.ok(L >= z.liquidityMin && L === ev.args.liquidity);
    const gas = rc.gasUsed * rc.gasPrice;
    const spent = nativeBefore - (await bal(aliceA)) - gas;
    assert.ok(spent <= amountIn && spent >= (amountIn * 97n) / 100n, `nearly all the HYPE is used (${ethers.formatEther(spent)})`);
    assert.ok((await homer.balanceOf(aliceA)) >= homerBefore, 'HOMER left over (if any) came back, none was taken');
    assert.equal(await bal(mgrA), 0n, 'no HYPE left in the manager');
    assert.equal(await homer.balanceOf(mgrA), 0n, 'no HOMER left in the manager');
  });

  await step('zap with the token only (HOMER) into a ±20% range', async () => {
    const { tick } = await slot0(keyHook);
    const tl = Math.floor((tick - 1823) / 200) * 200; // about -16.7% / +20% in price
    const tu = Math.ceil((tick + 1823) / 200) * 200;
    // A size the test pool can take (it holds about 72K HOMER around the price by now).
    const amountIn = ethers.parseEther('5000');
    await (await homer.connect(alice).approve(mgrA, amountIn)).wait();
    const z = await zapPlan(keyHook, false, amountIn, tl, tu);
    const id = await posm.nextTokenId();
    const homerBefore = await homer.balanceOf(aliceA);
    const rc = await (await mgr.connect(alice).zap({ posm: POSM, key: keyHook, tickLower: tl, tickUpper: tu, zeroForOne: false, amountIn, swapIn: z.swapIn, swapOutMin: z.swapOutMin, liquidityMin: z.liquidityMin, deadline: await deadline() })).wait();
    const ev = await zapTotals(rc);
    assert.ok(ev && ev.args.tokenId === id);
    assert.ok((await posm.getPositionLiquidity(id)) >= z.liquidityMin);
    const spent = homerBefore - (await homer.balanceOf(aliceA));
    assert.ok(spent <= amountIn && spent >= (amountIn * 97n) / 100n, 'nearly all the HOMER is used');
    assert.equal(await bal(mgrA), 0n);
    assert.equal(await homer.balanceOf(mgrA), 0n);
  });

  await step('zap into a pool without Homer\'s hook works the same', async () => {
    const amountIn = ethers.parseEther('0.2');
    const z = await zapPlan(keyPlain, true, amountIn, -887220, 887220);
    const id = await posm.nextTokenId();
    await (await mgr.connect(alice).zap({ posm: POSM, key: keyPlain, tickLower: -887220, tickUpper: 887220, zeroForOne: true, amountIn, swapIn: z.swapIn, swapOutMin: z.swapOutMin, liquidityMin: z.liquidityMin, deadline: await deadline() }, { value: amountIn })).wait();
    assert.equal(await mgr.ownerOf(POSM, id), aliceA);
    assert.equal(await bal(mgrA), 0n);
    assert.equal(await homer.balanceOf(mgrA), 0n);
  });

  await step('zap into a range that needs only the deposited side: no swap, the other side settles 0', async () => {
    // A range above the price takes only currency0 (HYPE): nothing to swap, nothing of HOMER needed.
    const { tick } = await slot0(keyHook);
    const tl = Math.ceil((tick + 400) / 200) * 200;
    const tu = tl + 2000;
    const amountIn = ethers.parseEther('0.2');
    const L = liquidityFor(amountIn, 0n, (await slot0(keyHook)).s, tl, tu);
    const id = await posm.nextTokenId();
    const homerBefore = await homer.balanceOf(aliceA);
    const nativeBefore = await bal(aliceA);
    const rc = await (await mgr.connect(alice).zap({ posm: POSM, key: keyHook, tickLower: tl, tickUpper: tu, zeroForOne: true, amountIn, swapIn: 0, swapOutMin: 0, liquidityMin: (L * 99n) / 100n, deadline: await deadline() }, { value: amountIn })).wait();
    assert.equal(await mgr.ownerOf(POSM, id), aliceA);
    assert.ok((await posm.getPositionLiquidity(id)) >= (L * 99n) / 100n);
    assert.equal(await homer.balanceOf(aliceA), homerBefore, 'no HOMER moved');
    const spent = nativeBefore - (await bal(aliceA)) - rc.gasUsed * rc.gasPrice;
    assert.ok(spent <= amountIn && spent * 100n >= amountIn * 99n, 'the HYPE went into the position');
    assert.equal(await bal(mgrA), 0n);
    assert.equal(await homer.balanceOf(mgrA), 0n);
  });

  await step('zap guards: wrong HYPE amount, swap above the deposit, minimums, unlisted manager, paused', async () => {
    const amountIn = ethers.parseEther('0.1');
    const z = await zapPlan(keyHook, true, amountIn, TL, TU);
    const args = { posm: POSM, key: keyHook, tickLower: TL, tickUpper: TU, zeroForOne: true, amountIn, swapIn: z.swapIn, swapOutMin: z.swapOutMin, liquidityMin: z.liquidityMin, deadline: await deadline() };
    await reverts(mgr.connect(alice).zap(args, { value: amountIn - 1n }), 'msg.value must equal the deposit');
    await reverts(mgr.connect(alice).zap({ ...args, swapIn: amountIn + 1n }, { value: amountIn }), 'swap larger than the deposit');
    await reverts(mgr.connect(alice).zap({ ...args, swapOutMin: 10n ** 30n }, { value: amountIn }), 'swap minimum');
    await reverts(mgr.connect(alice).zap({ ...args, liquidityMin: 10n ** 30n }, { value: amountIn }), 'liquidity minimum');
    await reverts(mgr.connect(alice).zap({ ...args, liquidityMin: 0 }, { value: amountIn }), 'zero liquidity floor');
    await reverts(mgr.connect(alice).zap({ ...args, posm: HOMER }, { value: amountIn }), 'unlisted position manager');
    await reverts(mgr.connect(alice).zap({ ...args, zeroForOne: false }, { value: amountIn }), 'HYPE sent with a token deposit');
    await (await mgr.pause()).wait();
    await reverts(mgr.connect(alice).zap(args, { value: amountIn }), 'paused');
    await (await mgr.unpause()).wait();
    assert.equal(await bal(mgrA), 0n);
  });

  const STRAY = ethers.parseEther('5');
  await step('tokens sent to the manager by mistake never pay for anyone\'s position', async () => {
    await (await homer.connect(alice).transfer(mgrA, STRAY)).wait();
    const L = liquidityFor(ethers.parseEther('0.1'), homerMax, (await slot0(keyHook)).s, TL, TU); // the price moved above
    await (await homer.connect(alice).approve(mgrA, homerMax)).wait();
    const before = await homer.balanceOf(aliceA);
    await (await mgr.connect(alice).mint({ posm: POSM, key: keyHook, tickLower: TL, tickUpper: TU, liquidity: L, amount0Max: ethers.parseEther('0.1'), amount1Max: homerMax, deadline: await deadline(), createAtSqrtPriceX96: 0 }, { value: ethers.parseEther('0.1') })).wait();
    assert.equal(await homer.balanceOf(mgrA), STRAY, 'the stray tokens are still there');
    assert.ok(before - (await homer.balanceOf(aliceA)) > 0n, 'alice paid her own side');
  });
  await step('nothing else is left in the manager', async () => {
    assert.equal(await bal(mgrA), 0n);
    assert.equal(await homer.balanceOf(mgrA), STRAY);
  });

  console.log(`\n${passed} checks passed`);
}

main().then(() => process.exit(0), (e) => {
  console.error(e);
  process.exit(1);
});
