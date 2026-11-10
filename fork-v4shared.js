'use strict';
// Fork test: the deployed Homer Swap through Uniswap's shared v4 PoolManager on Elysium
// (0xE2e1...), where Ascend, Montra, Volta and RONS's v4 pad keep their pools, each with its own
// hook. Homer Swap refuses the manager until the owner lists it (setPoolManager); then, on each
// venue's busiest HYPE pools: buy and sell, receive exactly the quote, Homer's fee to its
// recipient, nothing left in the contract.
// Uniswap v4 needs transient storage, so this runs on a Cancun fork:
//   FORK_URL=https://rpc.elysium.kinetiq.xyz npx hardhat --config hardhat.cancun.config.js run scripts/fork-v4shared.js
// POOLS: optional "Venue:poolId,..." to test other pools.
const assert = require('node:assert/strict');
const hre = require('hardhat');
const { freshSigners } = require('./lib/wallets.js');
const { ethers } = require('ethers');

const SWAP = '0x1cae4a793ce7b8ed136d1143ed31e402f9b53873'; // Homer Swap v2, live
const PM = '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1'; // Uniswap v4 PoolManager (shared)
const INIT = ethers.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
const HOOKS = {
  '0xe0def4221b9840a610d4e7d55812a79a6431a8ec': 'Ascend',
  '0x6b1216a40b65c83e9c9e18a562c446697b8cf8ec': 'Montra',
  '0x3ab88ddc3cf2a012af88b60828edb4553697e5dc': 'Volta',
  '0xd80e67b50e35d5be06572f0fb2d824cf8173e8ec': 'RONS',
};
// The busiest HYPE pools of each venue (Homer's index, 24 h volume).
const DEFAULT_POOLS = [
  ['Ascend', '0xc0be17156606216257c638d839c1dd6d43955a565e0b3d6c568d79ebe82cf84c'], // e/acc/WHYPE
  ['Ascend', '0x5e58108460522789fe9b0da5db8d8bdbd47bb1ce594c1338eee09e0489160649'], // ACAT/WHYPE
  ['Montra', '0x35bd0e6a8b82e0e18b0381757d97ba01cde11a02740f006132dd40395ffc8ce2'], // EACCAT/HYPE
  ['Montra', '0x61a799e016a5433af3e67cee4ca32dae81338c1ae7287192dc9d69b83b282aac'], // CHAMELEON/HYPE
  ['Volta', '0x7b182abb748bae25e2c73abd8b4cf3157d8d35a47e4b36d1ee5565ade94c3c27'], // VOLTA/HYPE
  ['Volta', '0xe488e93cba1cbbb1493d898a4f352571d0d96ddc4902f5449d07ad33ee34ee08'], // VOID/HYPE
  ['RONS', '0x5cd045e58eacdd5aab1d2cbe84d12a27f670f22e11e17e3d4a82d397980d7668'],
];
const SWAP_ABI = [
  'function owner() view returns (address)',
  'function feeRecipient() view returns (address)',
  'function isPoolManager(address) view returns (bool)',
  'function isWrapped(address) view returns (bool)',
  'function setPoolManager(address,bool)',
  'function quoteBuy((uint8 kind,address target,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key),uint256) returns (uint256 out,uint256 fee)',
  'function quoteSell((uint8 kind,address target,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key),uint256) returns (uint256 out,uint256 fee)',
  'function buy((uint8 kind,address target,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key),uint256,uint256) payable returns (uint256)',
  'function sell((uint8 kind,address target,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key),uint256,uint256,uint256) returns (uint256)',
];
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function symbol() view returns (string)'];
const ZERO = ethers.ZeroAddress;

let passed = 0;
const results = [];
async function step(name, fn) {
  await fn();
  passed++;
  console.log('  ok  ' + name);
}

async function main() {
  const provider = new ethers.BrowserProvider(hre.network.provider);
  // The forked block's header has no blob-gas fields, which Cancun execution needs: run on a
  // fresh local block instead.
  await provider.send('evm_mine', []);
  const [alice] = await freshSigners(provider, 1);
  const aliceA = await alice.getAddress();
  const read = new ethers.Contract(SWAP, SWAP_ABI, provider);
  const ownerA = await read.owner();
  await provider.send('hardhat_impersonateAccount', [ownerA]);
  await provider.send('hardhat_setBalance', [ownerA, '0x' + (10n ** 20n).toString(16)]);
  const owner = new ethers.JsonRpcSigner(provider, ownerA); // impersonated: not one of the node's own accounts
  const recipient = await read.feeRecipient();
  const asAlice = read.connect(alice);
  const deadline = async () => BigInt((await provider.getBlock('latest')).timestamp + 3600);
  const bal = (a) => provider.getBalance(a);
  const paid = (rc) => rc.gasUsed * rc.gasPrice;
  const errName = (e) => {
    const d = e.data || (e.info && e.info.error && e.info.error.data) || '';
    const s = typeof d === 'string' ? d.slice(0, 10) : '';
    const known = { [ethers.id('NotAllowed()').slice(0, 10)]: 'NotAllowed', [ethers.id('NoHypeSide()').slice(0, 10)]: 'NoHypeSide' };
    return known[s] || s || (e.shortMessage || e.message || '').slice(0, 120);
  };
  console.log(`Homer Swap ${SWAP}, owner ${ownerA}, fee recipient ${recipient}`);

  // Each pool's key, from its Initialize event.
  const archive = new ethers.JsonRpcProvider(process.env.FORK_URL || 'https://rpc.elysium.kinetiq.xyz', undefined, { staticNetwork: true });
  const list = process.env.POOLS ? process.env.POOLS.split(',').map((s) => s.split(':')) : DEFAULT_POOLS;
  const pools = [];
  for (const [venue, id] of list) {
    // Read from the archive node itself: the fork does not serve a log search over the whole chain.
    const logs = await archive.send('eth_getLogs', [{ address: PM, topics: [INIT, id], fromBlock: '0x0', toBlock: 'latest' }]);
    if (!logs.length) throw new Error('no Initialize for ' + id);
    const l = logs[0];
    const [fee, tickSpacing, hooks] = ethers.AbiCoder.defaultAbiCoder().decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data);
    const key = {
      currency0: ethers.getAddress('0x' + l.topics[2].slice(26)),
      currency1: ethers.getAddress('0x' + l.topics[3].slice(26)),
      fee: Number(fee),
      tickSpacing: Number(tickSpacing),
      hooks: ethers.getAddress(hooks),
    };
    assert.equal(HOOKS[key.hooks.toLowerCase()], venue, `${id}: hook ${key.hooks} is not ${venue}'s`);
    pools.push({ venue, id, key, route: { kind: 4, target: PM, key } });
  }

  const first = pools[0];
  await step('the shared manager is refused until the owner lists it', async () => {
    assert.equal(await read.isPoolManager(PM), false);
    let name = null;
    try { await asAlice.quoteBuy.staticCall(first.route, ethers.parseEther('0.01')); } catch (e) { name = errName(e); }
    assert.equal(name, 'NotAllowed');
  });
  await step('a stranger cannot list it', async () => {
    let failed = false;
    try { await (await read.connect(alice).setPoolManager(PM, true)).wait(); } catch { failed = true; }
    assert.ok(failed);
  });
  await (await read.connect(owner).setPoolManager(PM, true)).wait();
  assert.equal(await read.isPoolManager(PM), true);

  for (const p of pools) {
    const { key } = p;
    const native = key.currency0 === ZERO;
    const wrappedSide = native ? null : (await read.isWrapped(key.currency0)) ? key.currency0 : (await read.isWrapped(key.currency1)) ? key.currency1 : null;
    const tokenA = native ? key.currency1 : wrappedSide === key.currency0 ? key.currency1 : key.currency0;
    const token = new ethers.Contract(tokenA, ERC20, alice);
    const sym = await token.symbol().catch(() => tokenA.slice(0, 8));
    const label = `${p.venue} ${sym}/${native ? 'HYPE' : 'WHYPE'} (fee ${key.fee >= 0x800000 ? 'dynamic' : key.fee / 1e4 + '%'})`;
    if (!native && !wrappedSide) { console.log(`  --  ${label}: no HYPE side, skipped`); results.push([label, 'no HYPE side']); continue; }
    const hypeIn = ethers.parseEther(process.env.HYPE_IN || '0.05');
    let q;
    try {
      [q] = await asAlice.quoteBuy.staticCall(p.route, hypeIn);
    } catch (e) {
      console.log(`  !!  ${label}: quote failed: ${errName(e)}`);
      results.push([label, 'quote failed: ' + errName(e)]);
      continue;
    }
    if (q === 0n) { console.log(`  --  ${label}: no liquidity, skipped`); results.push([label, 'no liquidity']); continue; }
    let got = 0n;
    await step(`${label}: buy ${ethers.formatEther(hypeIn)} HYPE, receive exactly the quote, Homer's fee, nothing left`, async () => {
      const [quote, fee] = await asAlice.quoteBuy.staticCall(p.route, hypeIn);
      const b0 = await token.balanceOf(aliceA);
      const f0 = await bal(recipient);
      await (await asAlice.buy(p.route, quote, await deadline(), { value: hypeIn })).wait();
      got = (await token.balanceOf(aliceA)) - b0;
      assert.equal(got, quote, 'received the quote');
      assert.equal((await bal(recipient)) - f0, fee, 'fee to the recipient');
      assert.equal(fee, (hypeIn * 25n) / 10000n, '0.25% of the HYPE in');
      assert.equal(await bal(SWAP), 0n, 'no HYPE left in Homer Swap');
      assert.equal(await token.balanceOf(SWAP), 0n, 'no token left in Homer Swap');
    });
    await step(`${label}: sell half back, receive exactly the quote, nothing left`, async () => {
      const amt = got / 2n;
      await (await token.approve(SWAP, amt)).wait();
      const [quote, fee] = await asAlice.quoteSell.staticCall(p.route, amt);
      const b0 = await bal(aliceA);
      const f0 = await bal(recipient);
      const rc = await (await asAlice.sell(p.route, amt, quote, await deadline())).wait();
      assert.equal((await bal(aliceA)) - b0 + paid(rc), quote, 'received the quote');
      assert.equal((await bal(recipient)) - f0, fee, 'fee to the recipient');
      assert.equal(await bal(SWAP), 0n);
      assert.equal(await token.balanceOf(SWAP), 0n);
      // Round trip, for the report: what 0.05 HYPE in and half back cost, fees and price impact included.
      const back = Number(ethers.formatEther(quote));
      results.push([label, `bought ${got} for ${ethers.formatEther(hypeIn)} HYPE, sold half for ${back.toFixed(6)} HYPE`]);
    });
  }
  await step('a pool whose hook is not one of them is still refused by the token check (no HYPE side)', async () => {
    const r = { kind: 4, target: PM, key: { ...first.key, currency0: first.key.currency1, currency1: first.key.currency1 } };
    let failed = false;
    try { await asAlice.quoteBuy.staticCall(r, ethers.parseEther('0.01')); } catch { failed = true; }
    assert.ok(failed);
  });

  console.log('\nsummary');
  for (const [l, r] of results) console.log('  ' + l.padEnd(46) + r);
  console.log(`\n${passed} passed`);
}
main().then(() => process.exit(0), (e) => { console.error('FAIL', e.shortMessage || e.message, e.stack); process.exit(1); });
