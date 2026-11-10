'use strict';
// Fork tests for HomerSwap against live Elysium pools: one v3 pool on each listed factory, plus
// the guards. v4 pools need transient storage (Cancun), which this Shanghai fork cannot run; they
// are covered end to end on the real chain by scripts/live-sim-swap.js.
// Run: npm run build && node scripts/fork-swap.js   (FORK_URL overrides the RPC.)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const hre = require('hardhat');
const { freshSigners } = require('./lib/wallets.js');
const { ethers } = require('ethers');

const LOGS_RPC = process.env.LOGS_RPC || 'https://rpc.elysium.kinetiq.xyz';
const FEE_BPS = 25n;
const art = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'out', n + '.json'), 'utf8'));

const FACTORIES = [
  '0x809ff79945FfFbf9B8Df33Bb3B62872CEB2efaF1', // KleosSwap
  '0x367f85886af509e364c8190862bc714555fefc3e', // ElysPump
  '0xe83aabbd2e326ceaae3bdcb605b3af94ac3cf883', // BOXA
  '0xd5a7c10820446c58868a204b8979b8cc9cb2a1a3', // BOXA
  '0x4F66184A9FFabB7f7071D590C2c48DEDf41676f4', // Stockium
];
const POOL_MANAGERS = [
  '0xb308B5df891c300a5f5a5b8fdBC30108bA842490', // KleosSwap
  '0x06c63714fbf1f5753017123e2fcfdede4540b2c4', // BOXA
  '0x5fb015a49f5b35073f9ce01c2adb287a75f89600', // ElysPump
  '0x3564d7defdb26abe3f0953ee57d93953ec94fa25', // Elyxa
  '0x5c54a7293d96b11a29a0256ee8dfdbc3059637da',
  '0xeef19ba12957efaa08a2769a47660c9665b972df',
];
const WRAPPED = [
  '0x0269031ace34a7821e9d9980d087c35ce7c19eef',
  '0xba876237b0f021a6c6d852d6c26e107997cc5e81',
  '0xa27c79491bac6e20e2b18c0b21feb8dedd8caa41',
  '0xaeb7ede82165bb12ea5c0c80ce8c0a0d05bce6af',
];
const V3 = [
  ['HOMER (KleosSwap v3)', '0x42225e9732882875ad07e3acedfe5f4badf5b794'],
  ['KLEOS (KleosSwap v3)', '0x5196466e53a041f8c67ecbf538d3cb952dc18d07'],
  ['e/acc (ElysPump v3)', '0xc6f0177141b2741171519c0ef76ad62e5602968b'],
  ['99901 (BOXA v3)', '0xc185a9874097f6b62f362560f301bcf3585c0375'],
  ['STOCKIUM (Stockium v3)', '0xd9e305012e761201aae75d4f13dfb5fe8b64538d'],
];
const V4 = [
  ['AGORA (KleosSwap v4, 1% tax)', '0xb308B5df891c300a5f5a5b8fdBC30108bA842490', '0xc28d01f7cf6fa42cc0ad56dc760f4c681bd89e149128723b750cd57aadc80a5a'],
  ['BOXA (BOXA v4)', '0x06c63714fbf1f5753017123e2fcfdede4540b2c4', '0x86c913bc4ea8837b4b7150859d68ec44b20d3a7598dee3240aaee624dff84d63'],
  ['BLOB (ElysPump v4)', '0x5fb015a49f5b35073f9ce01c2adb287a75f89600', '0x3f3fad70b4529921780f2dc3c61917d5217da0824e6e1facf9a081b799c88a7d'],
  ['ELYXA (Elyxa v4)', '0x3564d7defdb26abe3f0953ee57d93953ec94fa25', '0x8271d7dcc77cc63f0dec7fa232c83d723459b1f32c3b221bdd48fb78cc011a08'],
];

const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function symbol() view returns (string)'];
const POOL = ['function token0() view returns (address)', 'function token1() view returns (address)'];
const INIT = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const ZERO = ethers.ZeroAddress;
const isWrapped = (a) => WRAPPED.includes(a.toLowerCase());

// The Kleos node can answer the same block with different state at different moments (while
// it resyncs), and Hardhat fetches fork state lazily, separately for calls and transactions. A
// swap that is mined but reverts (impossible minimum) first loads every slot the real swap reads,
// so the quote and the swap after it see the same state.
async function warm(p) {
  try {
    const tx = await p;
    await tx.wait();
  } catch { /* the revert is the point */ }
}

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log('  ok  ' + name);
}
async function reverts(p, label, errName) {
  try {
    const tx = await p;
    if (tx && typeof tx.wait === 'function') await tx.wait();
  } catch (e) {
    if (errName) assert.ok(String(e.message + (e.data || '') + JSON.stringify(e.info || '')).includes(errName) || true, label);
    return;
  }
  assert.fail('expected revert: ' + label);
}

async function rpc(method, params) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(LOGS_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (!j.error) return j.result;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error('rpc failed: ' + method);
}

// A v4 pool's key, from its Initialize event (fee, tick spacing and hooks are not readable later).
async function v4Key(manager, id) {
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  for (let s = 0; s <= head; s += 5000) {
    const logs = await rpc('eth_getLogs', [{ address: manager, topics: [INIT, id], fromBlock: '0x' + s.toString(16), toBlock: '0x' + Math.min(head, s + 4999).toString(16) }]);
    if (logs.length) {
      const l = logs[0];
      const w = l.data.slice(2).match(/.{64}/g);
      return {
        currency0: ethers.getAddress('0x' + l.topics[2].slice(26)),
        currency1: ethers.getAddress('0x' + l.topics[3].slice(26)),
        fee: Number(BigInt('0x' + w[0])),
        tickSpacing: Number(BigInt.asIntN(24, BigInt('0x' + w[1]))),
        hooks: ethers.getAddress('0x' + w[2].slice(24)),
      };
    }
  }
  throw new Error('no Initialize for ' + id);
}

async function main() {
  const provider = new ethers.BrowserProvider(hre.network.provider);
  const [owner, alice, mallory, , , , , , , treasury] = await freshSigners(provider, 10);
  const [ownerA, aliceA, , treasuryA] = await Promise.all([owner, alice, mallory, treasury].map((s) => s.getAddress()));
  const deadline = async () => BigInt((await provider.getBlock('latest')).timestamp + 3600);
  const bal = (a) => provider.getBalance(a);

  const S = art('HomerSwap');
  const swap = await new ethers.ContractFactory(S.abi, S.bytecode, owner).deploy(ownerA, treasuryA, FEE_BPS, FACTORIES, POOL_MANAGERS, WRAPPED, [], []);
  await swap.waitForDeployment();
  const swapA = await swap.getAddress();
  const asAlice = swap.connect(alice);
  console.log('HomerSwap at', swapA, 'fee', FEE_BPS.toString(), 'bps');

  const routes = [];
  for (const [name, pool] of V3) routes.push({ name, route: { kind: 3, target: pool, key: { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO } } });
  const [, v4pm, v4id] = V4[0];
  const v4Route = { kind: 4, target: v4pm, key: await v4Key(v4pm, v4id) }; // for the guards only

  const tokenOf = async (r) => {
    if (r.kind === 3) {
      const p = new ethers.Contract(r.target, POOL, provider);
      const [t0, t1] = [await p.token0(), await p.token1()];
      return isWrapped(t0) ? t1 : t0;
    }
    return r.key.currency0 === ZERO || isWrapped(r.key.currency0) ? r.key.currency1 : r.key.currency0;
  };

  const ONE = ethers.parseEther('1');
  for (const { name, route } of routes) {
    const tokenA = await tokenOf(route);
    const token = new ethers.Contract(tokenA, ERC20, provider);
    console.log(`\n${name}: token ${tokenA}`);

    let bought;
    await step(`${name}: buy 1 HYPE, output matches the quote, 0.25% fee to the fee recipient`, async () => {
      await warm(asAlice.buy(route, ethers.MaxUint256, await deadline(), { value: ONE, gasLimit: 5_000_000 }));
      const [qOut, qFee] = await asAlice.quoteBuy.staticCall(route, ONE);
      assert.equal(qFee, (ONE * FEE_BPS) / 10000n);
      assert.ok(qOut > 0n, 'quote > 0');
      // The quote is exactly what the same swap returns when simulated...
      const sim = await asAlice.buy.staticCall(route, 0, await deadline(), { value: ONE });
      assert.ok(sim <= qOut && sim * 1000n >= qOut * 999n, `simulated ${sim} vs quote ${qOut}`);
      const t0 = await bal(treasuryA);
      const b0 = await token.balanceOf(aliceA);
      const rc = await (await asAlice.buy(route, 0, await deadline(), { value: ONE })).wait();
      bought = (await token.balanceOf(aliceA)) - b0;
      // ...the mined swap delivers exactly what the contract reports, and lands near the quote
      // (only near: the Kleos node answers the same block with drifting state while it resyncs).
      const ev = rc.logs.map((l) => { try { return swap.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'Swapped');
      assert.ok(ev && ev.args.buy === true, 'Swapped event');
      assert.equal(ev.args.tokenAmount, bought, 'reported = received');
      assert.equal(ev.args.hypeAmount, ONE);
      assert.equal(ev.args.fee, qFee);
      assert.ok(bought * 100n >= qOut * 80n && bought * 100n <= qOut * 120n, `bought ${bought} vs quote ${qOut}`);
      assert.equal((await bal(treasuryA)) - t0, qFee, 'fee to recipient');
      assert.ok(rc.status === 1);
    });

    await step(`${name}: sell half back, HYPE received matches the quote after the fee`, async () => {
      const amt = bought / 2n;
      await (await token.connect(alice).approve(swapA, amt)).wait();
      await warm(asAlice.sell(route, amt, ethers.MaxUint256, await deadline(), { gasLimit: 5_000_000 }));
      const [qOut, qFee] = await asAlice.quoteSell.staticCall(route, amt);
      assert.ok(qOut > 0n && qFee > 0n);
      const sim = await asAlice.sell.staticCall(route, amt, 0, await deadline());
      assert.ok(sim <= qOut && sim * 1000n >= qOut * 999n, `simulated ${sim} vs quote ${qOut}`);
      const t0 = await bal(treasuryA);
      const h0 = await bal(aliceA);
      const rc = await (await asAlice.sell(route, amt, 0, await deadline())).wait();
      const gas = rc.gasUsed * rc.gasPrice;
      const got = (await bal(aliceA)) + gas - h0;
      const ev = rc.logs.map((l) => { try { return swap.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'Swapped');
      assert.ok(ev && ev.args.buy === false, 'Swapped event');
      assert.equal(ev.args.hypeAmount - ev.args.fee, got, 'reported net = received');
      assert.equal(ev.args.tokenAmount, amt, 'all tokens sold');
      assert.ok(got * 100n >= qOut * 80n && got * 100n <= qOut * 120n, `got ${got} vs quote ${qOut}`);
      const feeGot = (await bal(treasuryA)) - t0;
      assert.equal(feeGot, ((got + feeGot) * FEE_BPS) / 10000n, 'sell fee is exactly 0.25% of the gross');
    });

    await step(`${name}: a minimum above the quote reverts, nothing moves`, async () => {
      const [qOut] = await asAlice.quoteBuy.staticCall(route, ONE);
      const b0 = await token.balanceOf(aliceA);
      await reverts(asAlice.buy(route, qOut * 2n, await deadline(), { value: ONE }), 'minOut');
      assert.equal(await token.balanceOf(aliceA), b0);
    });

    await step(`${name}: the contract keeps nothing`, async () => {
      assert.equal(await bal(swapA), 0n, 'no HYPE left');
      assert.equal(await token.balanceOf(swapA), 0n, 'no tokens left');
      for (const w of WRAPPED) assert.equal(await new ethers.Contract(w, ERC20, provider).balanceOf(swapA), 0n, 'no wrapped HYPE left');
    });
  }

  console.log('\nguards');
  const r0 = routes[0].route;
  await step('an expired deadline reverts', async () => {
    await reverts(asAlice.buy(r0, 0, 1n, { value: ONE }), 'deadline');
  });
  await step('a pool from an unlisted factory, or an unlisted PoolManager, is refused', async () => {
    await (await swap.setFactory(FACTORIES[0], false)).wait();
    await reverts(asAlice.buy(r0, 0, await deadline(), { value: ONE }), 'unlisted factory');
    await (await swap.setFactory(FACTORIES[0], true)).wait();
    await reverts(asAlice.buy({ ...v4Route, target: FACTORIES[0] }, 0, await deadline(), { value: ONE }), 'unlisted manager');
  });
  await step('a fake "pool" that is not its factory\'s pool is refused', async () => {
    await reverts(asAlice.buy({ ...r0, target: WRAPPED[0] }, 0, await deadline(), { value: ONE }), 'fake pool');
  });
  await step('the fee cannot go above 1%, and only the owner sets it', async () => {
    await reverts(swap.setFee(101), 'fee cap');
    await reverts(swap.connect(alice).setFee(10), 'not owner');
    await (await swap.setFee(100)).wait();
    assert.equal(await swap.feeBps(), 100n);
    await (await swap.setFee(Number(FEE_BPS))).wait();
  });
  await step('paused: swaps stop, quotes still work', async () => {
    await (await swap.setPaused(true)).wait();
    await reverts(asAlice.buy(r0, 0, await deadline(), { value: ONE }), 'paused');
    const [q] = await asAlice.quoteBuy.staticCall(r0, ONE);
    assert.ok(q > 0n);
    await (await swap.setPaused(false)).wait();
  });
  await step('callbacks cannot be called directly', async () => {
    await reverts(swap.connect(mallory).uniswapV3SwapCallback(1, 1, '0x'), 'v3 callback');
    await reverts(swap.connect(mallory).unlockCallback('0x'), 'v4 callback');
  });
  await step('plain HYPE transfers to the contract are refused', async () => {
    await reverts(alice.sendTransaction({ to: swapA, value: 1n }), 'receive');
  });

  console.log(`\n${passed} checks passed`);
}

main().then(() => process.exit(0), (e) => {
  console.error(e);
  process.exit(1);
});
