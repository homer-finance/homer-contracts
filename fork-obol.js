const { freshSigners } = require('./lib/wallets.js');
'use strict';
// Fork tests for HomerSwap v2's launchpad (Obol) v2 pairs, on live Elysium state: buy and sell
// through two pads' pairs, quotes against what really arrives, Homer's fee, nothing left in the
// contract, the guards, and the v3 and v4 routes still working.
// Run: npm run build && FORK_RPC=http://127.0.0.1:8545 node scripts/fork-obol.js
//   (FORK_RPC: a running Cancun fork, e.g. `npx hardhat --config hardhat.cancun.config.js node`
//    with FORK_URL set; without it the in-process Hardhat network is used.)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

const FEE_BPS = 25n;
const art = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'out', n + '.json'), 'utf8'));
const IFACE = new ethers.Interface(art('HomerSwap').abi);
const ZERO = ethers.ZeroAddress;
const NO_KEY = { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO };

const FACTORIES = ['0x809ff79945FfFbf9B8Df33Bb3B62872CEB2efaF1', '0x367f85886af509e364c8190862bc714555fefc3e'];
const POOL_MANAGERS = ['0x06c63714fbf1f5753017123e2fcfdede4540b2c4'];
const WRAPPED = [
  '0x0269031ace34a7821e9d9980d087c35ce7c19eef',
  '0xba876237b0f021a6c6d852d6c26e107997cc5e81',
  '0x9f041fad8323d7c5bf8f928aade05b610df34b64', // Obol's WHYPE
];
const PADS = ['0x51d9243D87aD13D7EcA55AB57357B2b5fC8241F2', '0x84941cb4495fF9c79Af81eBCD46124809E65f7Ec', '0x7D1904Bfb2472A0Ef97d886139A4236060e064aB'];
const PAIRS = [
  ['HELIOS (Obol pad 0x7d19)', '0x97f4e88348788b148378b094bdd184c50d09b1ea'],
  ['OBOL (Obol pad 0x51d9)', '0xa484afb98c6913c23bd6985e08b9409b5610b8a5'],
];
const V3_POOL = '0x42225e9732882875ad07e3acedfe5f4badf5b794'; // HOMER (KleosSwap v3)
// BOXA's v4 launch pool (BOXA v4 PoolManager): its key, as Homer's index has it.
const V4 = {
  kind: 4,
  target: '0x06c63714fbf1f5753017123e2fcfdede4540b2c4',
  key: { currency0: ZERO, currency1: '0xa3c1d6a8648df3978a38ce1478fbc284c75d95d7', fee: 0, tickSpacing: 200, hooks: '0xbcc1f22d137c1d98dfa5548e4d4261d7aee06acc' },
};

const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function symbol() view returns (string)'];
const PAIR = ['function token0() view returns (address)', 'function token1() view returns (address)'];

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log('  ok  ' + name);
}
async function reverts(p, label, want) {
  try {
    const tx = await p;
    if (tx && typeof tx.wait === 'function') await tx.wait();
  } catch (e) {
    if (want) {
      // The revert data, decoded with HomerSwap's ABI (custom errors carry their own selector).
      const data = e.data || (e.info && e.info.error && e.info.error.data) || (e.error && e.error.data) || '';
      let name = null;
      try {
        name = IFACE.parseError(typeof data === 'string' ? data : data.data).name;
      } catch { /* not one of ours */ }
      const text = String(e.shortMessage || '') + String(e.message || '');
      assert.ok(name === want || text.includes(want), `${label}: expected ${want}, got ${name || text.slice(0, 160)}`);
    }
    return;
  }
  assert.fail('expected revert: ' + label);
}

async function main() {
  let provider;
  if (process.env.FORK_RPC) provider = new ethers.JsonRpcProvider(process.env.FORK_RPC, undefined, { staticNetwork: true, cacheTimeout: -1 });
  else provider = new ethers.BrowserProvider(require('hardhat').network.provider);
  const [owner, alice, , , , , , , , treasury] = await freshSigners(provider, 10);
  const [ownerA, aliceA, treasuryA] = await Promise.all([owner, alice, treasury].map((s) => s.getAddress()));
  const deadline = async () => BigInt((await provider.getBlock('latest')).timestamp + 3600);
  const bal = (a) => provider.getBalance(a);

  const S = art('HomerSwap');
  const swap = await new ethers.ContractFactory(S.abi, S.bytecode, owner).deploy(ownerA, treasuryA, FEE_BPS, FACTORIES, POOL_MANAGERS, WRAPPED, PADS, PADS.map(() => 100));
  await swap.waitForDeployment();
  const swapA = await swap.getAddress();
  const asAlice = swap.connect(alice);
  console.log('HomerSwap v' + (await swap.VERSION()) + ' at', swapA);

  // Nothing may stay in the contract after a swap: no HYPE, no wrapped HYPE, no token.
  const empty = async (token) => {
    assert.equal(await bal(swapA), 0n, 'HYPE left in the contract');
    for (const w of WRAPPED) assert.equal(await new ethers.Contract(w, ERC20, provider).balanceOf(swapA), 0n, 'wrapped HYPE left');
    if (token) assert.equal(await new ethers.Contract(token, ERC20, provider).balanceOf(swapA), 0n, 'token left');
  };

  await step('version 2 and the three Obol pads listed at 1%', async () => {
    assert.equal(await swap.VERSION(), 2n);
    for (const p of PADS) {
      const v = await swap.v2Pads(p);
      assert.equal(v.feeBps, 100n);
      assert.equal(v.pairLookup, '0x7d0f7a88');
    }
  });

  for (const [name, pairA] of PAIRS) {
    const route = { kind: 2, target: pairA, key: NO_KEY };
    const pair = new ethers.Contract(pairA, PAIR, provider);
    const [t0, t1] = [(await pair.token0()).toLowerCase(), (await pair.token1()).toLowerCase()];
    const tokenA = WRAPPED.includes(t0) ? t1 : t0;
    const token = new ethers.Contract(tokenA, ERC20, alice);

    let bought = 0n;
    await step(`${name}: buy 0.5 HYPE, quote = tokens received, 0.25% to Homer`, async () => {
      const hypeIn = ethers.parseEther('0.5');
      const [q, qFee] = await asAlice.quoteBuy.staticCall(route, hypeIn);
      assert.ok(q > 0n);
      assert.equal(qFee, (hypeIn * FEE_BPS) / 10000n);
      const t0b = await token.balanceOf(aliceA);
      const fee0 = await bal(treasuryA);
      await (await asAlice.buy(route, q, await deadline(), { value: hypeIn })).wait();
      bought = (await token.balanceOf(aliceA)) - t0b;
      assert.equal(bought, q, 'received exactly the quote');
      assert.equal((await bal(treasuryA)) - fee0, qFee, 'Homer fee');
      await empty(tokenA);
    });

    await step(`${name}: sell half back, quote = HYPE received, 0.25% to Homer`, async () => {
      const amt = bought / 2n;
      await (await token.approve(swapA, amt)).wait();
      const [q, qFee] = await asAlice.quoteSell.staticCall(route, amt);
      const b0 = await bal(aliceA);
      const fee0 = await bal(treasuryA);
      const rc = await (await asAlice.sell(route, amt, q, await deadline())).wait();
      const gas = rc.gasUsed * rc.gasPrice;
      assert.equal((await bal(aliceA)) - b0 + gas, q, 'received exactly the quote');
      assert.equal((await bal(treasuryA)) - fee0, qFee, 'Homer fee');
      assert.equal(qFee, ((q + qFee) * FEE_BPS) / 10000n);
      await empty(tokenA);
    });

    await step(`${name}: a minimum above the quote is refused`, async () => {
      const hypeIn = ethers.parseEther('0.1');
      const [q] = await asAlice.quoteBuy.staticCall(route, hypeIn);
      await reverts(asAlice.buy(route, q + 1n, await deadline(), { value: hypeIn }), 'minOut', 'TooLittleReceived');
    });
  }

  const helios = { kind: 2, target: PAIRS[0][1], key: NO_KEY };
  await step('a pair from a pad that is not listed is refused', async () => {
    await (await swap.setV2Pad(PADS[2], 0, '0x00000000')).wait();
    await reverts(asAlice.buy(helios, 0n, await deadline(), { value: ethers.parseEther('0.1') }), 'unlisted pad', 'NotAllowed');
    await reverts(asAlice.quoteBuy.staticCall(helios, ethers.parseEther('0.1')), 'unlisted pad quote', 'NotAllowed');
    await (await swap.setV2Pad(PADS[2], 100, '0x7d0f7a88')).wait();
  });

  await step('a v3 pool passed as a v2 pair is refused', async () => {
    await reverts(asAlice.buy({ kind: 2, target: V3_POOL, key: NO_KEY }, 0n, await deadline(), { value: ethers.parseEther('0.1') }), 'v3 as v2', 'NotAllowed');
  });

  await step('a pad must name the pair as the token\'s own (wrong lookup is refused)', async () => {
    await (await swap.setV2Pad(PADS[2], 100, '0x8da5cb5b')).wait(); // owner(): not a coin record
    await reverts(asAlice.buy(helios, 0n, await deadline(), { value: ethers.parseEther('0.1') }), 'bad lookup', 'NotAllowed');
    await (await swap.setV2Pad(PADS[2], 100, '0x7d0f7a88')).wait();
  });

  await step('only the owner lists pads; the pad fee is capped at 10%', async () => {
    await reverts(asAlice.setV2Pad(PADS[0], 100, '0x7d0f7a88'), 'not owner');
    await reverts(swap.setV2Pad(PADS[0], 1001, '0x7d0f7a88'), 'fee cap', 'FeeTooHigh');
  });

  await step('paused: v2 swaps stop', async () => {
    await (await swap.setPaused(true)).wait();
    await reverts(asAlice.buy(helios, 0n, await deadline(), { value: ethers.parseEther('0.1') }), 'paused', 'Paused');
    await (await swap.setPaused(false)).wait();
  });

  await step('v3 still works: buy HOMER on KleosSwap v3', async () => {
    const route = { kind: 3, target: V3_POOL, key: NO_KEY };
    const [q] = await asAlice.quoteBuy.staticCall(route, ethers.parseEther('0.2'));
    assert.ok(q > 0n);
    await (await asAlice.buy(route, (q * 99n) / 100n, await deadline(), { value: ethers.parseEther('0.2') })).wait();
    await empty();
  });

  await step('v4 still works: buy BOXA on its v4 launch pool', async () => {
    const [q] = await asAlice.quoteBuy.staticCall(V4, ethers.parseEther('0.2'));
    assert.ok(q > 0n);
    await (await asAlice.buy(V4, (q * 90n) / 100n, await deadline(), { value: ethers.parseEther('0.2') })).wait();
    await empty();
  });

  console.log(`\n${passed} passed`);
}

main().then(() => process.exit(0), (e) => {
  console.error('FAIL', e.shortMessage || e.message);
  process.exit(1);
});
