'use strict';
// Fork test: HomerSwap through RONS launchpad's v3 factory (0x24e2...), the one Elysium v3
// factory with real trading that Homer Swap did not list. Buy and sell RONS and RCAT, quotes
// against what arrives, Homer's fee, nothing left in the contract.
// Run: npm run build && FORK_URL=https://rpc.elysium.kinetiq.xyz node scripts/fork-rons.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const hre = require('hardhat');
const { freshSigners } = require('./lib/wallets.js');
const { ethers } = require('ethers');

const FEE_BPS = 25n;
const art = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'out', n + '.json'), 'utf8'));
const RONS_FACTORY = '0x24e21e3f2b0bb0c166ec3eaff1e615ab14cdd85f';
const WRAPPED = ['0x0269031ace34a7821e9d9980d087c35ce7c19eef', '0xba876237b0f021a6c6d852d6c26e107997cc5e81', '0xa27c79491bac6e20e2b18c0b21feb8dedd8caa41', '0xaeb7ede82165bb12ea5c0c80ce8c0a0d05bce6af', '0x9f041fad8323d7c5bf8f928aade05b610df34b64'];
const POOLS = [['RONS', '0xa61b8d703a54bd119bcb7904aa68c9a40363cb7f'], ['RCAT', '0x9415a4e274da09a78f139f0b8df1bc33d35eb739']];
const ZERO = ethers.ZeroAddress;
const NO_KEY = { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO };
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'];
const POOL = ['function token0() view returns (address)', 'function token1() view returns (address)', 'function factory() view returns (address)'];

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log('  ok  ' + name);
}

async function main() {
  const provider = new ethers.BrowserProvider(hre.network.provider);
  const [owner, alice, , , , , , , , treasury] = await freshSigners(provider, 10);
  const [ownerA, aliceA, treasuryA] = await Promise.all([owner, alice, treasury].map((s) => s.getAddress()));
  const deadline = async () => BigInt((await provider.getBlock('latest')).timestamp + 3600);
  const bal = (a) => provider.getBalance(a);
  const S = art('HomerSwap');
  // Deployed without the RONS factory, then listed the way Homer's deploy tool will: setFactory.
  const swap = await new ethers.ContractFactory(S.abi, S.bytecode, owner).deploy(ownerA, treasuryA, FEE_BPS, [], [], WRAPPED, [], []);
  await swap.waitForDeployment();
  const swapA = await swap.getAddress();
  const asAlice = swap.connect(alice);

  const [, rons] = POOLS[0];
  await step('a RONS pool is refused until its factory is listed', async () => {
    let failed = false;
    try { await (await asAlice.buy({ kind: 3, target: rons, key: NO_KEY }, 0n, await deadline(), { value: ethers.parseEther('0.01') })).wait(); } catch { failed = true; }
    assert.ok(failed);
  });
  await (await swap.setFactory(RONS_FACTORY, true)).wait();
  assert.equal(await swap.isFactory(RONS_FACTORY), true);

  for (const [name, poolA] of POOLS) {
    const pool = new ethers.Contract(poolA, POOL, provider);
    assert.equal((await pool.factory()).toLowerCase(), RONS_FACTORY);
    const [t0, t1] = [(await pool.token0()).toLowerCase(), (await pool.token1()).toLowerCase()];
    const tokenA = WRAPPED.includes(t0) ? t1 : t0;
    const token = new ethers.Contract(tokenA, ERC20, alice);
    const route = { kind: 3, target: poolA, key: NO_KEY };
    let got = 0n;
    await step(`${name}: buy 0.05 HYPE, receive exactly the quote, 0.25% to Homer, nothing left`, async () => {
      const hypeIn = ethers.parseEther('0.05');
      const [q, fee] = await asAlice.quoteBuy.staticCall(route, hypeIn);
      assert.ok(q > 0n);
      const b0 = await token.balanceOf(aliceA);
      const f0 = await bal(treasuryA);
      await (await asAlice.buy(route, q, await deadline(), { value: hypeIn })).wait();
      got = (await token.balanceOf(aliceA)) - b0;
      assert.equal(got, q);
      assert.equal((await bal(treasuryA)) - f0, fee);
      assert.equal(await bal(swapA), 0n);
      assert.equal(await token.balanceOf(swapA), 0n);
    });
    await step(`${name}: sell half back, receive exactly the quote`, async () => {
      const amt = got / 2n;
      await (await token.approve(swapA, amt)).wait();
      const [q] = await asAlice.quoteSell.staticCall(route, amt);
      const b0 = await bal(aliceA);
      const rc = await (await asAlice.sell(route, amt, q, await deadline())).wait();
      assert.equal((await bal(aliceA)) - b0 + rc.gasUsed * rc.gasPrice, q);
      assert.equal(await bal(swapA), 0n);
    });
  }
  console.log(`\n${passed} passed`);
}
main().then(() => process.exit(0), (e) => { console.error('FAIL', e.shortMessage || e.message); process.exit(1); });
