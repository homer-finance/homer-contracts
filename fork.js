'use strict';
// Fork tests for the Homer contracts against live Elysium state (KleosSwap position manager and
// the KLEOS/WHYPE pool). Run: npm run build && npm test   (FORK_URL overrides the RPC.)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');
const hre = require('hardhat');
const { freshSigners } = require('./lib/wallets.js');
const { ethers } = require('ethers');

const PM = '0x59c3630B078D2c561AB69c990987C9F13E90eD37'; // KleosSwap NonfungiblePositionManager
const POOL = '0x5196466e53a041f8c67ecbf538d3cb952dc18d07'; // KLEOS / WHYPE
const FEE_BPS = 1400n;
const MAX128 = (1n << 128n) - 1n;

const C = require('./lib/chain.js'); // the site's own rebalance planner
const art = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'out', n + '.json'), 'utf8'));

const SWAPPER_SRC = `
pragma solidity 0.8.28;
interface IPool {
  function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256);
  function token0() external view returns (address);
  function token1() external view returns (address);
}
interface IERC20 { function transferFrom(address, address, uint256) external returns (bool); }
contract Swapper {
  function swap(address pool, bool zeroForOne, int256 amount) external {
    IPool(pool).swap(msg.sender, zeroForOne, amount,
      zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341, abi.encode(msg.sender));
  }
  function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
    address payer = abi.decode(data, (address));
    if (a0 > 0) IERC20(IPool(msg.sender).token0()).transferFrom(payer, msg.sender, uint256(a0));
    if (a1 > 0) IERC20(IPool(msg.sender).token1()).transferFrom(payer, msg.sender, uint256(a1));
  }
}`;

function compileSwapper() {
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'Swapper.sol': { content: SWAPPER_SRC } },
    settings: { evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })));
  const c = out.contracts['Swapper.sol'].Swapper;
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];
const WETH = [...ERC20, 'function deposit() payable', 'function withdraw(uint256)'];
const NPM = [
  'function positions(uint256) view returns (uint96,address,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128 owed0,uint128 owed1)',
  'function ownerOf(uint256) view returns (address)',
  'function safeTransferFrom(address,address,uint256)',
  'function transferFrom(address,address,uint256)',
  'function collect((uint256,address,uint128,uint128)) returns (uint256,uint256)',
  'function mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256)) payable returns (uint256,uint128,uint256,uint256)',
  'function multicall(bytes[]) payable returns (bytes[])',
  'function refundETH() payable',
  'function WETH9() view returns (address)',
];
const POOL_ABI = [
  'function token0() view returns (address)', 'function token1() view returns (address)', 'function fee() view returns (uint24)', 'function tickSpacing() view returns (int24)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function liquidity() view returns (uint128)',
];

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log('  ok  ' + name);
}
async function reverts(p, label) {
  let threw = false;
  try {
    const tx = await p;
    if (tx && typeof tx.wait === 'function') await tx.wait();
  } catch {
    threw = true;
  }
  assert.ok(threw, 'expected revert: ' + label);
}

// Gives `who` `amount` of an ERC20 by finding its balance mapping slot.
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

async function main() {
  const provider = new ethers.BrowserProvider(hre.network.provider);
  const signers = await freshSigners(provider, 5);
  const [owner, alice, bob, carol, treasury] = signers;
  const A = await Promise.all(signers.map((s) => s.getAddress()));
  const [ownerA, aliceA, bobA, carolA, treasuryA] = A;
  const now = async () => (await provider.getBlock('latest')).timestamp;
  const deadline = async () => BigInt((await now()) + 3600);

  const pool = new ethers.Contract(POOL, POOL_ABI, provider);
  const token0 = (await pool.token0()).toLowerCase();
  const token1 = (await pool.token1()).toLowerCase();
  const fee = await pool.fee();
  const spacing = Number(await pool.tickSpacing());
  const npm = new ethers.Contract(PM, NPM, provider);
  const wethA = (await npm.WETH9()).toLowerCase();
  assert.ok(token0 === wethA || token1 === wethA, 'pool pairs WHYPE');
  const kleosA = token0 === wethA ? token1 : token0;
  const kleos = new ethers.Contract(kleosA, ERC20, provider);
  const weth = new ethers.Contract(wethA, WETH, provider);
  const wethIs0 = token0 === wethA;
  const lo = Math.ceil(-887272 / spacing) * spacing;
  const hi = Math.floor(887272 / spacing) * spacing;
  console.log(`pool ${POOL} fee ${fee} spacing ${spacing}; WHYPE is token${wethIs0 ? 0 : 1}`);

  for (const who of [aliceA, bobA, carolA]) await fund(provider, kleosA, who, ethers.parseEther('5000000'));

  // ------------------------------------------------------------------ deploy
  const M = art('HomerLiquidityManager');
  const mgrF = new ethers.ContractFactory(M.abi, M.bytecode, owner);
  const mgr = await mgrF.deploy(ownerA, treasuryA, FEE_BPS, [PM]);
  await mgr.waitForDeployment();
  const mgrA = await mgr.getAddress();

  const sw = compileSwapper();
  const swapper = await new ethers.ContractFactory(sw.abi, sw.bytecode, carol).deploy();
  await swapper.waitForDeployment();
  const swA = await swapper.getAddress();
  await (await kleos.connect(carol).approve(swA, ethers.MaxUint256)).wait();
  await (await weth.connect(carol).deposit({ value: ethers.parseEther('2000') })).wait();
  await (await weth.connect(carol).approve(swA, ethers.MaxUint256)).wait();
  // Round-trip swaps so the pool earns fees on both sides.
  async function churn(times = 6) {
    for (let i = 0; i < times; i++) {
      await (await swapper.connect(carol).swap(POOL, true, ethers.parseEther('50'))).wait();
      await (await swapper.connect(carol).swap(POOL, false, ethers.parseEther('50'))).wait();
    }
  }

  await step('deploy: owner, treasury, fee, allowlist and WETH read from the manager', async () => {
    assert.equal(await mgr.owner(), ownerA);
    assert.equal(await mgr.treasury(), treasuryA);
    assert.equal(await mgr.feeBps(), FEE_BPS);
    assert.equal(await mgr.isAllowed(PM), true);
    assert.equal((await mgr.wethOf(PM)).toLowerCase(), wethA);
    assert.deepEqual([...(await mgr.managers())], [ethers.getAddress(PM)]);
    assert.equal(ethers.decodeBytes32String(await mgr.KIND()), 'HomerLiquidityManager');
  });

  const amtK = ethers.parseEther('200000');
  const amtH = ethers.parseEther('20');
  let id1;

  await step('mint with native HYPE: NFT held by Homer, owner recorded, leftovers refunded', async () => {
    await (await kleos.connect(alice).approve(mgrA, amtK)).wait();
    const kBefore = await kleos.balanceOf(aliceA);
    const hBefore = await provider.getBalance(aliceA);
    const args = {
      manager: PM, token0, token1, fee, tickLower: lo, tickUpper: hi,
      amount0Desired: wethIs0 ? amtH : amtK, amount1Desired: wethIs0 ? amtK : amtH,
      amount0Min: 0, amount1Min: 0, deadline: await deadline(),
    };
    const tx = await mgr.connect(alice).mint(args, { value: amtH });
    const rc = await tx.wait();
    const gas = rc.gasUsed * rc.gasPrice;
    // What the mint really used, from its own event (a simulation a block earlier can round differently).
    const minted = rc.logs.map((l) => { try { return mgr.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'Minted');
    id1 = minted.args.tokenId;
    const res = [id1, minted.args.liquidity, minted.args.amount0, minted.args.amount1];
    assert.equal((await npm.ownerOf(id1)).toLowerCase(), mgrA.toLowerCase());
    assert.equal(await mgr.ownerOf(PM, id1), aliceA);
    const list = await mgr.positionsOf(aliceA);
    assert.equal(list.length, 1);
    assert.equal(list[0].tokenId, id1);
    const usedK = wethIs0 ? res[3] : res[2];
    const usedH = wethIs0 ? res[2] : res[3];
    assert.equal(kBefore - (await kleos.balanceOf(aliceA)), usedK, 'only the used KLEOS left the wallet');
    assert.equal(hBefore - (await provider.getBalance(aliceA)) - gas, usedH, 'unused HYPE came back as HYPE');
    assert.equal(await kleos.balanceOf(mgrA), 0n);
    assert.equal(await weth.balanceOf(mgrA), 0n);
    assert.equal(await provider.getBalance(mgrA), 0n);
    assert.equal(await kleos.allowance(mgrA, PM), 0n);
    assert.equal(await weth.allowance(mgrA, PM), 0n);
  });

  await step('collect: treasury gets exactly 14% of earned fees, LP 86%, HYPE side unwrapped', async () => {
    await churn();
    const [o0, o1] = await npm.connect(provider).collect.staticCall([id1, mgrA, MAX128, MAX128], { from: mgrA });
    assert.ok(o0 > 0n && o1 > 0n, 'fees accrued on both sides');
    const f0 = (o0 * FEE_BPS) / 10000n;
    const f1 = (o1 * FEE_BPS) / 10000n;
    const t0 = new ethers.Contract(token0, ERC20, provider);
    const t1 = new ethers.Contract(token1, ERC20, provider);
    const tb0 = await t0.balanceOf(treasuryA);
    const tb1 = await t1.balanceOf(treasuryA);
    const kB = await kleos.balanceOf(aliceA);
    const hB = await provider.getBalance(aliceA);
    const rc = await (await mgr.connect(alice).collect(PM, id1, true)).wait();
    const gas = rc.gasUsed * rc.gasPrice;
    assert.equal((await t0.balanceOf(treasuryA)) - tb0, f0);
    assert.equal((await t1.balanceOf(treasuryA)) - tb1, f1);
    const lpK = wethIs0 ? o1 - f1 : o0 - f0;
    const lpH = wethIs0 ? o0 - f0 : o1 - f1;
    assert.equal((await kleos.balanceOf(aliceA)) - kB, lpK);
    assert.equal((await provider.getBalance(aliceA)) - hB + gas, lpH);
    const ev = rc.logs.map((l) => { try { return mgr.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'FeesCollected');
    assert.equal(ev.args.fee0, f0);
    assert.equal(ev.args.fee1, f1);
  });

  await step('access control: only the position owner can collect, remove or withdraw', async () => {
    await reverts(mgr.connect(bob).collect(PM, id1, false), 'collect by stranger');
    await reverts(mgr.connect(bob).withdraw(PM, id1, bobA), 'withdraw by stranger');
    await reverts(mgr.connect(bob).decrease({ manager: PM, tokenId: id1, liquidity: 1, amount0Min: 0, amount1Min: 0, deadline: await deadline(), unwrap: false }), 'decrease by stranger');
    await reverts(mgr.connect(bob).setFee(100), 'setFee by stranger');
    await reverts(mgr.connect(owner).setFee(2501), 'fee above cap');
    await reverts(mgr.connect(owner).recoverUnregistered(PM, id1, ownerA), 'owner cannot take a registered position');
    await reverts(mgr.connect(owner).rescueERC20(kleosA, ownerA, 1), 'nothing to rescue');
  });

  await step('increase with ERC20 WHYPE (no native): pulls only what is used', async () => {
    await (await weth.connect(alice).deposit({ value: ethers.parseEther('10') })).wait();
    await (await weth.connect(alice).approve(mgrA, ethers.parseEther('10'))).wait();
    await (await kleos.connect(alice).approve(mgrA, amtK)).wait();
    const [, , liqBefore] = [0, 0, (await npm.positions(id1)).liquidity];
    const wB = await weth.balanceOf(aliceA);
    await (await mgr.connect(alice).increase({
      manager: PM, tokenId: id1,
      amount0Desired: wethIs0 ? ethers.parseEther('10') : amtK, amount1Desired: wethIs0 ? amtK : ethers.parseEther('10'),
      amount0Min: 0, amount1Min: 0, deadline: await deadline(),
    })).wait();
    assert.ok((await npm.positions(id1)).liquidity > liqBefore);
    assert.ok(wB - (await weth.balanceOf(aliceA)) <= ethers.parseEther('10'));
    assert.equal(await weth.balanceOf(mgrA), 0n);
    assert.equal(await kleos.balanceOf(mgrA), 0n);
  });

  await step('increase rejects HYPE that does not match the WHYPE amount', async () => {
    await reverts(mgr.connect(alice).increase({
      manager: PM, tokenId: id1, amount0Desired: amtH, amount1Desired: amtH, amount0Min: 0, amount1Min: 0, deadline: await deadline(),
    }, { value: 1n }), 'msg.value mismatch');
  });

  await step('decrease: fees settled first (14%), principal paid in full with no fee', async () => {
    await churn(3);
    const pos = await npm.positions(id1);
    const half = pos.liquidity / 2n;
    // Expected fees = what a collect would return right now; principal = the rest.
    const [o0, o1] = await npm.connect(provider).collect.staticCall([id1, mgrA, MAX128, MAX128], { from: mgrA });
    const t0 = new ethers.Contract(token0, ERC20, provider);
    const t1 = new ethers.Contract(token1, ERC20, provider);
    const tb0 = await t0.balanceOf(treasuryA);
    const tb1 = await t1.balanceOf(treasuryA);
    const rc = await (await mgr.connect(alice).decrease({
      manager: PM, tokenId: id1, liquidity: half, amount0Min: 0, amount1Min: 0, deadline: await deadline(), unwrap: false,
    })).wait();
    assert.equal((await t0.balanceOf(treasuryA)) - tb0, (o0 * FEE_BPS) / 10000n, 'treasury got fee share only');
    assert.equal((await t1.balanceOf(treasuryA)) - tb1, (o1 * FEE_BPS) / 10000n);
    const dec = rc.logs.map((l) => { try { return mgr.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'Decreased');
    assert.ok(dec.args.amount0 > 0n && dec.args.amount1 > 0n, 'principal returned');
    assert.equal((await npm.positions(id1)).liquidity, pos.liquidity - half);
    assert.equal((await npm.positions(id1)).owed0, 0n, 'nothing left owed');
    assert.equal(await weth.balanceOf(mgrA), 0n);
    assert.equal(await kleos.balanceOf(mgrA), 0n);
  });

  await step('pause blocks new positions only; withdraw still works and settles fees', async () => {
    await (await mgr.connect(owner).pause()).wait();
    await (await kleos.connect(alice).approve(mgrA, amtK)).wait();
    await reverts(mgr.connect(alice).mint({
      manager: PM, token0, token1, fee, tickLower: lo, tickUpper: hi,
      amount0Desired: wethIs0 ? amtH : amtK, amount1Desired: wethIs0 ? amtK : amtH, amount0Min: 0, amount1Min: 0, deadline: await deadline(),
    }, { value: amtH }), 'mint while paused');
    await churn(2);
    const t1 = new ethers.Contract(token1, ERC20, provider);
    const tb1 = await t1.balanceOf(treasuryA);
    await (await mgr.connect(alice).withdraw(PM, id1, aliceA)).wait();
    assert.ok((await t1.balanceOf(treasuryA)) > tb1, 'fees settled on withdraw');
    assert.equal(await npm.ownerOf(id1), aliceA);
    assert.equal(await mgr.ownerOf(PM, id1), ethers.ZeroAddress);
    assert.equal((await mgr.positionsOf(aliceA)).length, 0);
    await (await mgr.connect(owner).unpause()).wait();
  });

  let id2;
  await step('deposit an existing position: earlier fees go to the LP untaxed', async () => {
    await (await kleos.connect(bob).approve(PM, amtK)).wait();
    const mintArgs = [token0, token1, fee, lo, hi, wethIs0 ? amtH : amtK, wethIs0 ? amtK : amtH, 0, 0, bobA, await deadline()];
    const data = [npm.interface.encodeFunctionData('mint', [mintArgs]), npm.interface.encodeFunctionData('refundETH')];
    const r = await npm.connect(bob).multicall.staticCall(data, { value: amtH });
    id2 = npm.interface.decodeFunctionResult('mint', r[0])[0];
    await (await npm.connect(bob).multicall(data, { value: amtH })).wait();
    await churn(3);
    const [o0, o1] = await npm.connect(provider).collect.staticCall([id2, bobA, MAX128, MAX128], { from: bobA });
    assert.ok(o0 > 0n && o1 > 0n);
    const t0 = new ethers.Contract(token0, ERC20, provider);
    const t1 = new ethers.Contract(token1, ERC20, provider);
    const tb0 = await t0.balanceOf(treasuryA);
    const b0 = await t0.balanceOf(bobA);
    const b1 = await t1.balanceOf(bobA);
    await (await npm.connect(bob).safeTransferFrom(bobA, mgrA, id2)).wait();
    assert.equal(await mgr.ownerOf(PM, id2), bobA);
    assert.equal((await t0.balanceOf(bobA)) - b0, o0);
    assert.equal((await t1.balanceOf(bobA)) - b1, o1);
    assert.equal(await t0.balanceOf(treasuryA), tb0, 'no fee on pre-deposit earnings');
  });

  await step('remove 100%: position burned and unregistered, HYPE paid natively', async () => {
    const pos = await npm.positions(id2);
    const hB = await provider.getBalance(bobA);
    const rc = await (await mgr.connect(bob).decrease({
      manager: PM, tokenId: id2, liquidity: pos.liquidity, amount0Min: 0, amount1Min: 0, deadline: await deadline(), unwrap: true,
    })).wait();
    assert.ok((await provider.getBalance(bobA)) + rc.gasUsed * rc.gasPrice > hB);
    assert.equal(await mgr.ownerOf(PM, id2), ethers.ZeroAddress);
    assert.equal((await mgr.positionsOf(bobA)).length, 0);
    await reverts(npm.ownerOf(id2), 'burned');
  });

  await step('a plain transferFrom is not registered; only then can the owner return it', async () => {
    await (await npm.connect(alice).transferFrom(aliceA, mgrA, id1)).wait();
    await (await mgr.connect(owner).recoverUnregistered(PM, id1, aliceA)).wait();
    assert.equal(await npm.ownerOf(id1), aliceA);
  });

  await step('removed venue: no new positions, existing ones still managed', async () => {
    await (await npm.connect(alice).safeTransferFrom(aliceA, mgrA, id1)).wait();
    await (await mgr.connect(owner).setManager(PM, false)).wait();
    await (await mgr.connect(alice).collect(PM, id1, false)).wait();
    await (await mgr.connect(alice).withdraw(PM, id1, aliceA)).wait();
    await reverts(npm.connect(alice)['safeTransferFrom(address,address,uint256)'](aliceA, mgrA, id1), 'deposit into removed venue');
    assert.equal(await npm.ownerOf(id1), aliceA);
    await (await mgr.connect(owner).setManager(PM, true)).wait();
  });

  await step('treasury and fee changes, two-step ownership', async () => {
    await (await mgr.connect(owner).setFee(1000)).wait();
    assert.equal(await mgr.feeBps(), 1000n);
    await reverts(mgr.connect(owner).setTreasury(ethers.ZeroAddress), 'zero treasury');
    await (await mgr.connect(owner).transferOwnership(bobA)).wait();
    assert.equal(await mgr.owner(), ownerA, 'pending until accepted');
    await (await mgr.connect(bob).acceptOwnership()).wait();
    assert.equal(await mgr.owner(), bobA);
    await (await mgr.connect(bob).transferOwnership(ownerA)).wait();
    await (await mgr.connect(owner).acceptOwnership()).wait();
  });

  await step('stray native HYPE is refused', async () => {
    await reverts(alice.sendTransaction({ to: mgrA, value: 1n }), 'receive from non-WETH');
  });

  // ------------------------------------------------------------------ rebalance
  const tickNow = async () => Number((await pool.slot0()).tick);
  const around = (t, n) => [Math.floor(t / spacing) * spacing - n * spacing, Math.floor(t / spacing) * spacing + (n + 1) * spacing];
  const t0c = new ethers.Contract(token0, ERC20, provider);
  const t1c = new ethers.Contract(token1, ERC20, provider);
  let narrow;
  let rbArgs;

  await step('rebalance setup: narrow position earns fees, then price leaves its range', async () => {
    assert.equal(await mgr.VERSION(), 3n);
    const [tl, tu] = around(await tickNow(), 2);
    await (await kleos.connect(alice).approve(mgrA, amtK)).wait();
    const args = { manager: PM, token0, token1, fee, tickLower: tl, tickUpper: tu, amount0Desired: wethIs0 ? amtH : amtK, amount1Desired: wethIs0 ? amtK : amtH, amount0Min: 0, amount1Min: 0, deadline: await deadline() };
    narrow = (await mgr.connect(alice).mint.staticCall(args, { value: amtH }))[0];
    await (await mgr.connect(alice).mint(args, { value: amtH })).wait();
    await churn(2);
    // Push the price well below the range by selling token0 into the pool.
    for (let i = 0; i < 12 && (await tickNow()) >= tl - spacing; i++) await (await swapper.connect(carol).swap(POOL, true, ethers.parseEther('40'))).wait();
    assert.ok((await tickNow()) < tl, 'price left the range');
    const pos = await npm.positions(narrow);
    assert.ok(pos.liquidity > 0n);
  });

  // The position is now all token0; part of it is swapped to token1 for a range around the price.
  const quoteRemove = async (id) => {
    const p = await npm.positions(id);
    const dec = new ethers.Interface(['function decreaseLiquidity((uint256,uint128,uint256,uint256,uint256)) returns (uint256,uint256)']);
    const r = await provider.call({ to: PM, from: mgrA, data: dec.encodeFunctionData('decreaseLiquidity', [[id, p.liquidity, 0, 0, await deadline()]]) });
    return dec.decodeFunctionResult('decreaseLiquidity', r);
  };

  await step('rebalance: guards (owner only, deadline, swap budget, slippage, stray callback)', async () => {
    const [r0] = await quoteRemove(narrow);
    const [tl, tu] = around(await tickNow(), 3);
    rbArgs = async (o = {}) => ({
      manager: PM, tokenId: narrow, tickLower: tl, tickUpper: tu, remove0Min: 0, remove1Min: 0,
      zeroForOne: true, swapIn: r0 / 2n, swapOutMin: 0, amount0Min: 0, amount1Min: 0, deadline: await deadline(), unwrap: false, ...o,
    });
    await reverts(mgr.connect(bob).rebalance(await rbArgs()), 'stranger');
    await reverts(mgr.connect(alice).rebalance(await rbArgs({ deadline: BigInt((await now()) - 1) })), 'expired');
    await reverts(mgr.connect(alice).rebalance(await rbArgs({ swapIn: r0 * 2n })), 'swap more than the position holds');
    await reverts(mgr.connect(alice).rebalance(await rbArgs({ swapOutMin: ethers.MaxUint256 })), 'swap slippage');
    await reverts(mgr.connect(alice).rebalance(await rbArgs({ remove0Min: r0 * 2n })), 'remove slippage');
    await reverts(mgr.connect(alice).rebalance(await rbArgs({ amount1Min: ethers.MaxUint256 })), 'mint slippage');
    await reverts(mgr.connect(carol).uniswapV3SwapCallback(1n, 0n, ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address'], [token0, token1])), 'stray callback');
    await (await mgr.connect(owner).pause()).wait();
    await reverts(mgr.connect(alice).rebalance(await rbArgs()), 'paused');
    await (await mgr.connect(owner).unpause()).wait();
    assert.equal(await mgr.ownerOf(PM, narrow), aliceA, 'still in place after the failed attempts');
  });

  await step('rebalance: fees settled (fee share only), old NFT burned, new range opened, nothing left in Homer', async () => {
    await churn(1);
    const fb = await mgr.feeBps(); // an earlier step changed it
    const [o0, o1] = await npm.connect(provider).collect.staticCall([narrow, mgrA, MAX128, MAX128], { from: mgrA });
    const tb0 = await t0c.balanceOf(treasuryA);
    const tb1 = await t1c.balanceOf(treasuryA);
    const a0 = await t0c.balanceOf(aliceA);
    const a1 = await t1c.balanceOf(aliceA);
    const [r0, r1] = await quoteRemove(narrow);
    // Plan the swap exactly as the website does, with 3% minimums.
    // A new range around the price as it is now (churn moved it).
    const [ntl, ntu] = around(await tickNow(), 3);
    const sl = await pool.slot0();
    const plan = C.planRebalance({ s: C.sqrtPriceOf(sl.sqrtPriceX96), L: Number(await pool.liquidity()), fee: Number(fee), tl: ntl, tu: ntu, have0: Number(r0), have1: Number(r1) });
    assert.ok(plan && plan.zeroForOne && plan.swapIn > 0, 'planner swaps token0 for token1');
    const args = await rbArgs({
      tickLower: ntl, tickUpper: ntu,
      zeroForOne: plan.zeroForOne, swapIn: C.toBig(plan.swapIn), swapOutMin: C.applySlippage(C.toBig(plan.out), 300),
      remove0Min: C.applySlippage(r0, 300), remove1Min: C.applySlippage(r1, 300),
      amount0Min: C.applySlippage(C.toBig(plan.use0), 300), amount1Min: C.applySlippage(C.toBig(plan.use1), 300),
    });
    const rc = await (await mgr.connect(alice).rebalance(args)).wait();
    const rbEv = rc.logs.map((l) => { try { return mgr.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'Rebalanced');
    const res = [rbEv.args.newTokenId, rbEv.args.liquidity, rbEv.args.amount0, rbEv.args.amount1];
    const newId = res[0];
    assert.equal((await t0c.balanceOf(treasuryA)) - tb0, (o0 * fb) / 10000n, 'treasury: fee share only');
    assert.equal((await t1c.balanceOf(treasuryA)) - tb1, (o1 * fb) / 10000n);
    await reverts(npm.ownerOf(narrow), 'old NFT burned');
    assert.equal(await mgr.ownerOf(PM, narrow), ethers.ZeroAddress);
    assert.equal(await mgr.ownerOf(PM, newId), aliceA);
    assert.ok((await mgr.positionsOf(aliceA)).some((p) => p.tokenId === newId));
    assert.ok(!(await mgr.positionsOf(aliceA)).some((p) => p.tokenId === narrow));
    const np = await npm.positions(newId);
    assert.equal(Number(np.tickLower), args.tickLower);
    assert.equal(Number(np.tickUpper), args.tickUpper);
    assert.ok(np.liquidity > 0n);
    const t = await tickNow();
    assert.ok(t >= args.tickLower && t < args.tickUpper, 'new position is in range');
    // Everything is accounted for: the owner's principal is in the new position or back in the wallet.
    for (const tok of [t0c, t1c]) {
      assert.equal(await tok.balanceOf(mgrA), 0n, 'no tokens left in Homer');
      assert.equal(await tok.allowance(mgrA, PM), 0n, 'no allowance left');
    }
    const back0 = (await t0c.balanceOf(aliceA)) - a0;
    const back1 = (await t1c.balanceOf(aliceA)) - a1;
    const lpFee0 = o0 - (o0 * fb) / 10000n;
    const lpFee1 = o1 - (o1 * fb) / 10000n;
    assert.ok(back0 >= lpFee0 && back1 >= lpFee1, 'LP got its fee share');
    const used0 = res[2];
    const used1 = res[3];
    assert.ok(used0 > 0n && used1 > 0n, 'new position holds both tokens');
    assert.equal(r1, 0n, 'out of range below: the old position held only token0');
    assert.ok(used0 + (back0 - lpFee0) <= r0 - args.swapIn, 'token0 principal not overspent');
    // The planner's split fits the range: what comes back unused is a small part of the principal.
    assert.ok((back0 - lpFee0) * 100n <= r0 * 3n, 'little token0 left over');
    const ev = rc.logs.map((l) => { try { return mgr.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'Rebalanced');
    assert.equal(ev.args.oldTokenId, narrow);
    assert.equal(ev.args.newTokenId, newId);
    narrow = newId;
  });

  await step('rebalance without a swap, leftovers paid as native HYPE', async () => {
    const tu = Math.floor((await tickNow()) / spacing) * spacing - spacing;
    const tl = tu - 4 * spacing;
    // A range below the price takes only token1; the token0 side comes back (as HYPE if it is WHYPE).
    const hB = await provider.getBalance(aliceA);
    const w0 = await t0c.balanceOf(aliceA);
    const args = await rbArgs({ tokenId: narrow, tickLower: tl, tickUpper: tu, swapIn: 0, swapOutMin: 0, unwrap: true });
    const rc = await (await mgr.connect(alice).rebalance(args)).wait();
    const rbEv = rc.logs.map((l) => { try { return mgr.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'Rebalanced');
    const res = [rbEv.args.newTokenId, rbEv.args.liquidity, rbEv.args.amount0, rbEv.args.amount1];
    assert.equal(res[2], 0n, 'no token0 used below the price');
    assert.ok(res[3] > 0n, 'token1 went into the new position');
    if (wethIs0) assert.ok((await provider.getBalance(aliceA)) + rc.gasUsed * rc.gasPrice > hB, 'token0 came back as native HYPE');
    else assert.ok((await t0c.balanceOf(aliceA)) > w0, 'token0 came back');
    for (const tok of [t0c, t1c]) assert.equal(await tok.balanceOf(mgrA), 0n);
    assert.equal(await provider.getBalance(mgrA), 0n);
  });

  // ------------------------------------------------------------------ zap (v3)
  // One token in: the site plans the swap with the same planner as rebalance, 3% minimums.
  const zapArgs = async (zeroForOne, amountIn, tl, tu, over = {}) => {
    const sl = await pool.slot0();
    const plan = C.planRebalance({ s: C.sqrtPriceOf(sl.sqrtPriceX96), L: Number(await pool.liquidity()), fee: Number(fee), tl, tu, have0: zeroForOne ? Number(amountIn) : 0, have1: zeroForOne ? 0 : Number(amountIn) });
    assert.ok(plan && plan.zeroForOne === zeroForOne && plan.swapIn > 0, 'the planner swaps from the deposited side');
    return {
      manager: PM, token0, token1, fee, tickLower: tl, tickUpper: tu, zeroForOne, amountIn,
      swapIn: C.toBig(plan.swapIn), swapOutMin: C.applySlippage(C.toBig(plan.out), 300),
      amount0Min: C.applySlippage(C.toBig(plan.use0), 300), amount1Min: C.applySlippage(C.toBig(plan.use1), 300),
      deadline: await deadline(), unwrap: true, ...over,
    };
  };
  const zapEvent = (rc) => rc.logs.map((l) => { try { return mgr.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'Minted');

  await step('zap with HYPE only: part swapped in the pool, a range around the price opens, leftovers back', async () => {
    const [tl, tu] = around(await tickNow(), 5);
    const amountIn = ethers.parseEther('2');
    const args = await zapArgs(wethIs0, amountIn, tl, tu); // HYPE is the WHYPE side
    const hB = await provider.getBalance(aliceA);
    const kB = await kleos.balanceOf(aliceA);
    const rc = await (await mgr.connect(alice).zap(args, { value: amountIn })).wait();
    const ev = zapEvent(rc);
    assert.ok(ev, 'Minted event');
    const id = ev.args.tokenId;
    assert.equal(await npm.ownerOf(id), mgrA, 'Homer holds the NFT');
    assert.equal(await mgr.ownerOf(PM, id), aliceA, 'registered to alice');
    const np = await npm.positions(id);
    assert.ok(np.liquidity > 0n && Number(np.tickLower) === tl && Number(np.tickUpper) === tu);
    const spent = hB - (await provider.getBalance(aliceA)) - rc.gasUsed * rc.gasPrice;
    assert.ok(spent <= amountIn && spent * 100n >= amountIn * 97n, `nearly all the HYPE used (${ethers.formatEther(spent)})`);
    assert.ok((await kleos.balanceOf(aliceA)) >= kB, 'no KLEOS taken; any left over came back');
    for (const tok of [t0c, t1c]) {
      assert.equal(await tok.balanceOf(mgrA), 0n, 'nothing left in Homer');
      assert.equal(await tok.allowance(mgrA, PM), 0n, 'no allowance left');
    }
    assert.equal(await provider.getBalance(mgrA), 0n);
  });

  await step('zap with the token only (KLEOS), leftover WHYPE paid as native HYPE', async () => {
    const [tl, tu] = around(await tickNow(), 8);
    const amountIn = ethers.parseEther('20000');
    await (await kleos.connect(alice).approve(mgrA, amountIn)).wait();
    const args = await zapArgs(!wethIs0, amountIn, tl, tu);
    const kB = await kleos.balanceOf(aliceA);
    const wB = await weth.balanceOf(aliceA);
    const rc = await (await mgr.connect(alice).zap(args)).wait();
    const ev = zapEvent(rc);
    assert.ok(ev && ev.args.liquidity > 0n);
    const spent = kB - (await kleos.balanceOf(aliceA));
    assert.ok(spent <= amountIn && spent * 100n >= amountIn * 97n, 'nearly all the KLEOS used');
    assert.equal(await weth.balanceOf(aliceA), wB, 'leftover HYPE comes as native, not WHYPE');
    for (const tok of [t0c, t1c]) assert.equal(await tok.balanceOf(mgrA), 0n);
    assert.equal(await provider.getBalance(mgrA), 0n);
  });

  await step('zap guards: HYPE amount, swap budget, minimums, deadline, venue, pause', async () => {
    const [tl, tu] = around(await tickNow(), 5);
    const amountIn = ethers.parseEther('0.5');
    const args = await zapArgs(wethIs0, amountIn, tl, tu);
    await reverts(mgr.connect(alice).zap(args, { value: amountIn - 1n }), 'HYPE must equal the deposit');
    await reverts(mgr.connect(alice).zap({ ...args, swapIn: amountIn + 1n }, { value: amountIn }), 'swap larger than the deposit');
    await reverts(mgr.connect(alice).zap({ ...args, swapOutMin: ethers.MaxUint256 }, { value: amountIn }), 'swap minimum');
    await reverts(mgr.connect(alice).zap({ ...args, amount0Min: ethers.MaxUint256 }, { value: amountIn }), 'position minimum');
    await reverts(mgr.connect(alice).zap({ ...args, deadline: BigInt((await now()) - 1) }, { value: amountIn }), 'expired');
    await reverts(mgr.connect(alice).zap({ ...args, zeroForOne: !wethIs0 }, { value: amountIn }), 'HYPE sent with a token deposit');
    await reverts(mgr.connect(alice).zap({ ...args, manager: POOL }, { value: amountIn }), 'unlisted position manager');
    await (await mgr.pause()).wait();
    await reverts(mgr.connect(alice).zap(args, { value: amountIn }), 'paused');
    await (await mgr.unpause()).wait();
    assert.equal(await provider.getBalance(mgrA), 0n);
  });

  // ------------------------------------------------------------------ token + staking
  const T = art('HomerToken');
  const token = await new ethers.ContractFactory(T.abi, T.bytecode, owner).deploy('Homer', 'HOMER', ethers.parseEther('1000000000'), ownerA);
  await token.waitForDeployment();
  const tokenA = await token.getAddress();
  const S = art('HomerStaking');
  const staking = await new ethers.ContractFactory(S.abi, S.bytecode, owner).deploy(ownerA, wethA, tokenA);
  await staking.waitForDeployment();
  const stA = await staking.getAddress();

  await step('token: fixed supply to the recipient', async () => {
    assert.equal(await token.totalSupply(), ethers.parseEther('1000000000'));
    assert.equal(await token.balanceOf(ownerA), ethers.parseEther('1000000000'));
    assert.equal(await token.symbol(), 'HOMER');
  });

  await step('staking: rewards stream pro rata over the period', async () => {
    await (await token.connect(owner).transfer(aliceA, ethers.parseEther('3000'))).wait();
    await (await token.connect(owner).transfer(bobA, ethers.parseEther('1000'))).wait();
    await (await token.connect(alice).approve(stA, ethers.MaxUint256)).wait();
    await (await token.connect(bob).approve(stA, ethers.MaxUint256)).wait();
    await (await staking.connect(alice).stake(ethers.parseEther('3000'))).wait();
    await (await staking.connect(bob).stake(ethers.parseEther('1000'))).wait();
    const reward = ethers.parseEther('70');
    await (await weth.connect(owner).deposit({ value: reward })).wait();
    await (await weth.connect(owner).approve(stA, reward)).wait();
    await reverts(staking.connect(alice).notifyRewardAmount(1n), 'only owner funds');
    await (await staking.connect(owner).notifyRewardAmount(reward)).wait();
    assert.equal(await weth.balanceOf(stA), reward);
    await provider.send('evm_increaseTime', [8 * 24 * 3600]);
    await provider.send('evm_mine', []);
    const ea = await staking.earned(aliceA);
    const eb = await staking.earned(bobA);
    const total = ea + eb;
    assert.ok(total <= reward && reward - total < ethers.parseEther('0.001'), 'whole stream paid out');
    assert.ok(ea > eb * 29n / 10n && ea < eb * 31n / 10n, 'alice earns 3x bob');
    const wB = await weth.balanceOf(aliceA);
    await (await staking.connect(alice).exit()).wait();
    assert.equal((await weth.balanceOf(aliceA)) - wB, ea);
    assert.equal(await token.balanceOf(aliceA), ethers.parseEther('3000'));
  });

  await step('staking: owner cannot take stakes or rewards; pause leaves exits open', async () => {
    await reverts(staking.connect(owner).recoverERC20(tokenA, 1n), 'recover staked token');
    await reverts(staking.connect(owner).recoverERC20(wethA, 1n), 'recover reward token');
    await (await staking.connect(owner).pause()).wait();
    await reverts(staking.connect(alice).stake(1n), 'stake while paused');
    await (await staking.connect(bob).exit()).wait();
    assert.equal(await token.balanceOf(bobA), ethers.parseEther('1000'));
    await (await staking.connect(owner).setRewardsDuration(14 * 24 * 3600)).wait();
    assert.equal(await staking.rewardsDuration(), BigInt(14 * 24 * 3600));
  });

  await step('staking: reward rate must be covered when staking and reward token are the same', async () => {
    const same = await new ethers.ContractFactory(S.abi, S.bytecode, owner).deploy(ownerA, tokenA, tokenA);
    await same.waitForDeployment();
    const sA = await same.getAddress();
    await (await token.connect(alice).approve(sA, ethers.MaxUint256)).wait();
    await (await same.connect(alice).stake(ethers.parseEther('1000'))).wait();
    await (await token.connect(owner).approve(sA, ethers.parseEther('7'))).wait();
    await (await same.connect(owner).notifyRewardAmount(ethers.parseEther('7'))).wait();
    await provider.send('evm_increaseTime', [8 * 24 * 3600]);
    await provider.send('evm_mine', []);
    await (await same.connect(alice).exit()).wait();
    assert.ok((await token.balanceOf(aliceA)) > ethers.parseEther('3006.99'));
  });


  // ------------------------------------------------------------------ fee router
  const ELYSPUMP_WHYPE = '0xba876237b0f021a6c6d852d6c26e107997cc5e81';
  const R = art('HomerFeeRouter');
  const router = await new ethers.ContractFactory(R.abi, R.bytecode, owner).deploy(ownerA, carolA, wethA, 5000, [ELYSPUMP_WHYPE, wethA]);
  await router.waitForDeployment();
  const rA = await router.getAddress();
  const pweth = new ethers.Contract(ELYSPUMP_WHYPE, WETH, provider);
  const wbal = (a) => weth.balanceOf(a);
  const income = async () => (await wbal(rA)) - (await router.stakerReserve());

  await step('router: deploy settings; reward token is not in the unwrap list', async () => {
    assert.equal(await router.team(), carolA);
    assert.equal(await router.stakerBps(), 5000n);
    assert.deepEqual([...(await router.wrapped())].map((a) => a.toLowerCase()), [ELYSPUMP_WHYPE]);
    assert.equal(ethers.decodeBytes32String(await router.KIND()), 'HomerFeeRouter');
  });

  await step('router as treasury: platform fees split 50/50, stakers\' half reserved until staking exists', async () => {
    await (await mgr.connect(owner).setFee(1400)).wait();
    await (await mgr.connect(owner).setTreasury(rA)).wait();
    await (await kleos.connect(alice).approve(mgrA, amtK)).wait();
    const args = { manager: PM, token0, token1, fee, tickLower: lo, tickUpper: hi, amount0Desired: wethIs0 ? amtH : amtK, amount1Desired: wethIs0 ? amtK : amtH, amount0Min: 0, amount1Min: 0, deadline: await deadline() };
    const id = (await mgr.connect(alice).mint.staticCall(args, { value: amtH }))[0];
    await (await mgr.connect(alice).mint(args, { value: amtH })).wait();
    await churn(4);
    await (await mgr.connect(alice).collect(PM, id, false)).wait();
    const got = await wbal(rA);
    assert.ok(got > 0n, 'router received the WHYPE side of the fee');
    assert.ok((await kleos.balanceOf(rA)) > 0n, 'and the KLEOS side');
    const teamBefore = await wbal(carolA);
    await (await router.connect(bob).distribute()).wait(); // anyone can call
    const toTeam = got - (got * 5000n) / 10000n;
    assert.equal((await wbal(carolA)) - teamBefore, toTeam);
    assert.equal(await router.stakerReserve(), (got * 5000n) / 10000n);
    assert.equal(await income(), 0n);
  });

  await step('router: other tokens only ever go to the team; HYPE tokens cannot be forwarded', async () => {
    const k = await kleos.balanceOf(rA);
    const before = await kleos.balanceOf(carolA);
    await (await router.connect(bob).forward(kleosA)).wait();
    assert.equal((await kleos.balanceOf(carolA)) - before, k);
    await reverts(router.connect(bob).forward(wethA), 'reward token');
    await reverts(router.connect(bob).forward(ELYSPUMP_WHYPE), 'wrapped HYPE');
  });

  await step('router: another venue\'s WHYPE and native HYPE are unwrapped, rewrapped and split', async () => {
    await (await pweth.connect(bob).deposit({ value: ethers.parseEther('2') })).wait();
    await (await pweth.connect(bob).transfer(rA, ethers.parseEther('2'))).wait();
    await (await bob.sendTransaction({ to: rA, value: ethers.parseEther('1') })).wait();
    const reserve = await router.stakerReserve();
    const teamBefore = await wbal(carolA);
    await (await router.distribute()).wait();
    assert.equal(await pweth.balanceOf(rA), 0n);
    assert.equal(await provider.getBalance(rA), 0n);
    assert.equal((await wbal(carolA)) - teamBefore, ethers.parseEther('1.5'));
    assert.equal((await router.stakerReserve()) - reserve, ethers.parseEther('1.5'));
  });

  await step('router: owner-only settings with limits', async () => {
    await reverts(router.connect(bob).setStakerShare(100), 'stranger');
    await reverts(router.connect(bob).setTeam(bobA), 'stranger');
    await reverts(router.connect(owner).setStakerShare(10001), 'above 100%');
    await reverts(router.connect(owner).setTeam(ethers.ZeroAddress), 'zero team');
    const homerRewards = await new ethers.ContractFactory(S.abi, S.bytecode, owner).deploy(ownerA, tokenA, tokenA);
    await homerRewards.waitForDeployment();
    await reverts(router.connect(owner).setStaking(await homerRewards.getAddress()), 'staking paying a different token');
  });

  const st2 = await new ethers.ContractFactory(S.abi, S.bytecode, owner).deploy(ownerA, wethA, tokenA);
  await st2.waitForDeployment();
  const st2A = await st2.getAddress();

  await step('router + staking: reserve waits for stakers, then streams; stakers earn it', async () => {
    await (await st2.connect(owner).setRewardsDistributor(rA)).wait();
    await (await router.connect(owner).setStaking(st2A)).wait();
    await reverts(st2.connect(bob).notifyRewardAmount(1n), 'only owner or distributor');
    const reserve = await router.stakerReserve();
    await (await router.distribute()).wait();
    assert.equal(await router.stakerReserve(), reserve, 'nobody staking: kept in reserve');
    await (await token.connect(bob).approve(st2A, ethers.MaxUint256)).wait();
    await (await st2.connect(bob).stake(ethers.parseEther('1000'))).wait();
    await (await router.distribute()).wait();
    assert.equal(await router.stakerReserve(), 0n);
    assert.equal(await wbal(st2A), reserve);
    assert.equal(await router.totalToStakers(), reserve);
    assert.equal(await weth.allowance(rA, st2A), 0n);
    await provider.send('evm_increaseTime', [8 * 24 * 3600]);
    await provider.send('evm_mine', []);
    const e = await st2.earned(bobA);
    assert.ok(e <= reserve && reserve - e < ethers.parseEther('0.0001'), 'bob earns the whole stream');
  });

  await step('router: if staking refuses the funds, the share stays reserved and the team is still paid', async () => {
    await (await st2.connect(owner).setRewardsDistributor(ethers.ZeroAddress)).wait();
    await (await bob.sendTransaction({ to: rA, value: ethers.parseEther('1') })).wait();
    const teamBefore = await wbal(carolA);
    const rc = await (await router.distribute()).wait();
    assert.ok(rc.logs.some((l) => { try { return router.interface.parseLog(l).name === 'StakersFundingFailed'; } catch { return false; } }));
    assert.equal((await wbal(carolA)) - teamBefore, ethers.parseEther('0.5'));
    assert.equal(await router.stakerReserve(), ethers.parseEther('0.5'));
    assert.equal(await weth.allowance(rA, st2A), 0n);
  });

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
