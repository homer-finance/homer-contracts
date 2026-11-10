'use strict';
// Fork test for Homer Swap version 3: two-step trades (buyVia, sellVia) for tokens whose pool is
// against another token instead of HYPE, here KNTQ: HYPE -> KNTQ in a KNTQ/HYPE pool, then
// KNTQ -> the token. Deployed fresh with the lists Homer deploys it with. Checks: the quote is what arrives,
// Homer's fee is taken once in HYPE, nothing stays in the contract, one-step trades still work,
// and the guards (a HYPE pool as the second step, a middle token that does not match, an unlisted
// manager, minimum output).
// Uniswap v4 needs transient storage, so this runs on a Cancun fork:
//   npm run build && FORK_URL=https://rpc.elysium.kinetiq.xyz npx hardhat --config hardhat.cancun.config.js run scripts/fork-via.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const hre = require('hardhat');
const { freshSigners } = require('./lib/wallets.js');
const { ethers } = require('ethers');
const config = require('./lib/elysium.js');

const art = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'out', n + '.json'), 'utf8'));
const S = art('HomerSwap');
const IFACE = new ethers.Interface(S.abi);
const INIT = ethers.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
const ZERO = ethers.ZeroAddress;
const NO_KEY = { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO };
const HOMER_V3 = '0x42225e9732882875ad07e3acedfe5f4badf5b794'; // HOMER/WHYPE, KleosSwap v3
const EACC_ASCEND = '0xc0be17156606216257c638d839c1dd6d43955a565e0b3d6c568d79ebe82cf84c'; // e/acc/WHYPE, Ascend v4
// KNTQ's HYPE pools (first step) and pools against KNTQ (second step), from Homer's index.
const KNTQ_HYPE = [
  ['v4', '0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac'],
  ['v3', '0xbb4aacba1752b9efa37d5a25ed7e9d3001fefbae'],
];
const VIA = [
  ['BLOB/KNTQ', '0x8b6f703336e0ced2c577afa636337aa5d451810bd428bed83f2e7e176597ca2b'],
  ['AI/KNTQ (Ascend)', '0xf9e622cec726bd6e141b903dc770bb3be378ca29f19225d2bdddf1dae0c8710c'],
  ['KMEOW/KNTQ (Volta)', '0x8427b64de7dd22f65ef072ca5db327a1932ac71f5fca868c9ced4f6f4f681c09'],
];
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function symbol() view returns (string)'];
const POOL = ['function token0() view returns (address)', 'function token1() view returns (address)'];

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log('  ok  ' + name);
}
const errName = (e) => {
  const d = e.data || (e.info && e.info.error && e.info.error.data) || (e.error && e.error.data) || '';
  try { return IFACE.parseError(typeof d === 'string' ? d : d.data).name; } catch { return (e.shortMessage || e.message || '').slice(0, 100); }
};
async function reverts(p, want) {
  try { const tx = await p; if (tx && tx.wait) await tx.wait(); } catch (e) { if (want) assert.equal(errName(e), want); return; }
  assert.fail('expected revert ' + (want || ''));
}

async function main() {
  const provider = new ethers.BrowserProvider(hre.network.provider);
  await provider.send('evm_mine', []); // Cancun execution on a fresh local block (see fork-v4.js)
  const archive = new ethers.JsonRpcProvider(process.env.FORK_URL || 'https://rpc.elysium.kinetiq.xyz', undefined, { staticNetwork: true });
  const [owner, alice, , , , , , , , treasury] = await freshSigners(provider, 10);
  const [ownerA, aliceA, treasuryA] = await Promise.all([owner, alice, treasury].map((s) => s.getAddress()));
  const deadline = async () => BigInt((await provider.getBlock('latest')).timestamp + 3600);
  const bal = (a) => provider.getBalance(a);
  const paid = (rc) => rc.gasUsed * rc.gasPrice;

  // Deployed with the lists Homer deploys it with.
  const managers = Object.keys(config.v4Managers);
  const swap = await new ethers.ContractFactory(S.abi, S.bytecode, owner).deploy(
    ownerA, treasuryA, 25n, [...new Set(Object.keys(config.venues))], managers, config.whype,
    Object.keys(config.v2Pads), Object.values(config.v2Pads).map((p) => Math.round(p.feePips / 100)),
  );
  await swap.waitForDeployment();
  const swapA = await swap.getAddress();
  const asAlice = swap.connect(alice);
  assert.equal(await swap.VERSION(), 3n);

  // A route from Homer's pool id: v3 pools by address, v4 pools by their Initialize event.
  const routeOf = async (id) => {
    if (id.length === 42) {
      const p = new ethers.Contract(id, POOL, provider);
      return { route: { kind: 3, target: id, key: NO_KEY }, tokens: [(await p.token0()).toLowerCase(), (await p.token1()).toLowerCase()] };
    }
    const logs = await archive.send('eth_getLogs', [{ address: managers, topics: [INIT, id], fromBlock: '0x0', toBlock: 'latest' }]);
    if (!logs.length) throw new Error('no Initialize for ' + id);
    const l = logs[0];
    const [fee, tickSpacing, hooks] = ethers.AbiCoder.defaultAbiCoder().decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data);
    const key = { currency0: ethers.getAddress('0x' + l.topics[2].slice(26)), currency1: ethers.getAddress('0x' + l.topics[3].slice(26)), fee: Number(fee), tickSpacing: Number(tickSpacing), hooks: ethers.getAddress(hooks) };
    return { route: { kind: 4, target: l.address.toLowerCase(), key }, tokens: [key.currency0.toLowerCase(), key.currency1.toLowerCase()] };
  };
  const isHype = (a) => a === ZERO || config.whype.includes(a);
  const nothingLeft = async (tokens) => {
    assert.equal(await bal(swapA), 0n, 'no HYPE left in Homer Swap');
    for (const t of tokens) assert.equal(await new ethers.Contract(t, ERC20, provider).balanceOf(swapA), 0n, 'no ' + t + ' left');
  };

  // One-step trades still work.
  for (const [name, id] of [['HOMER (KleosSwap v3)', HOMER_V3], ['e/acc (Ascend v4)', EACC_ASCEND]]) {
    const { route, tokens } = await routeOf(id);
    const tokenA = tokens.find((t) => !isHype(t));
    const token = new ethers.Contract(tokenA, ERC20, alice);
    await step(`one step, ${name}: buy and sell, exactly the quote, nothing left`, async () => {
      const [q] = await asAlice.quoteBuy.staticCall(route, ethers.parseEther('0.05'));
      const b0 = await token.balanceOf(aliceA);
      await (await asAlice.buy(route, q, await deadline(), { value: ethers.parseEther('0.05') })).wait();
      const got = (await token.balanceOf(aliceA)) - b0;
      assert.equal(got, q);
      await (await token.approve(swapA, got)).wait();
      const [qs] = await asAlice.quoteSell.staticCall(route, got);
      const h0 = await bal(aliceA);
      const rc = await (await asAlice.sell(route, got, qs, await deadline())).wait();
      assert.equal((await bal(aliceA)) - h0 + paid(rc), qs);
      await nothingLeft(tokens);
    });
  }

  // Two steps through KNTQ: pick, for each pool against KNTQ, a KNTQ/HYPE pool holding the same KNTQ.
  const firsts = [];
  for (const [, id] of KNTQ_HYPE) firsts.push(await routeOf(id));
  const results = [];
  for (const [name, id] of VIA) {
    const second = await routeOf(id);
    const first = firsts.find((f) => f.tokens.some((t) => !isHype(t) && second.tokens.includes(t)));
    if (!first) { console.log(`  --  ${name}: no KNTQ/HYPE pool for its KNTQ, skipped`); continue; }
    const mid = first.tokens.find((t) => !isHype(t));
    const tokenA = second.tokens.find((t) => t !== mid);
    const token = new ethers.Contract(tokenA, ERC20, alice);
    const midT = new ethers.Contract(mid, ERC20, provider);
    const hypeIn = ethers.parseEther(process.env.HYPE_IN || '0.05');
    let q;
    try { [q] = await asAlice.quoteBuyVia.staticCall(first.route, second.route, hypeIn); } catch (e) { console.log(`  !!  ${name}: quote failed: ${errName(e)}`); results.push([name, 'quote failed: ' + errName(e)]); continue; }
    let got = 0n;
    await step(`two steps, ${name}: buyVia ${ethers.formatEther(hypeIn)} HYPE, exactly the quote, fee once, nothing left`, async () => {
      const [quote, fee, midAmount] = await asAlice.quoteBuyVia.staticCall(first.route, second.route, hypeIn);
      assert.equal(quote, q);
      assert.ok(midAmount > 0n);
      const b0 = await token.balanceOf(aliceA);
      const f0 = await bal(treasuryA);
      const rc = await (await asAlice.buyVia(first.route, second.route, quote, await deadline(), { value: hypeIn })).wait();
      got = (await token.balanceOf(aliceA)) - b0;
      assert.equal(got, quote, 'received the quote');
      assert.equal((await bal(treasuryA)) - f0, fee, 'fee to the recipient');
      assert.equal(fee, (hypeIn * 25n) / 10000n, '0.25% once');
      assert.equal(await midT.balanceOf(aliceA), 0n, 'no KNTQ left over to alice (it all went into the second pool)');
      const ev = rc.logs.map((l) => { try { return IFACE.parseLog(l); } catch { return null; } }).filter(Boolean);
      assert.ok(ev.some((e) => e.name === 'Swapped' && e.args.buy === true && e.args.tokenAmount === got));
      assert.ok(ev.some((e) => e.name === 'Via' && e.args.mid.toLowerCase() === mid && e.args.midAmount === midAmount));
      await nothingLeft([mid, tokenA]);
    });
    await step(`two steps, ${name}: sellVia half back, exactly the quote, nothing left`, async () => {
      const amt = got / 2n;
      await (await token.approve(swapA, amt)).wait();
      const [quote, fee] = await asAlice.quoteSellVia.staticCall(second.route, first.route, amt);
      const h0 = await bal(aliceA);
      const f0 = await bal(treasuryA);
      const rc = await (await asAlice.sellVia(second.route, first.route, amt, quote, await deadline())).wait();
      assert.equal((await bal(aliceA)) - h0 + paid(rc), quote, 'received the quote');
      assert.equal((await bal(treasuryA)) - f0, fee);
      await nothingLeft([mid, tokenA]);
      results.push([name, `${ethers.formatEther(hypeIn)} HYPE bought ${got}; half sold back for ${Number(ethers.formatEther(quote)).toFixed(6)} HYPE`]);
    });
    if (!firsts.guarded) {
      firsts.guarded = true;
      await step('guards: a HYPE pool as the second step, a middle token that does not match, minimum output, an unlisted manager', async () => {
        await reverts(asAlice.buyVia(first.route, first.route, 0n, await deadline(), { value: hypeIn }), 'NotAllowed');
        const homer = await routeOf(HOMER_V3);
        await reverts(asAlice.buyVia(homer.route, second.route, 0n, await deadline(), { value: hypeIn }), 'NotAllowed');
        await reverts(asAlice.buyVia(first.route, second.route, ethers.MaxUint256, await deadline(), { value: hypeIn }), 'TooLittleReceived');
        const fake = { ...second.route, target: '0x000000000000000000000000000000000000beef' };
        await reverts(asAlice.buyVia(first.route, fake, 0n, await deadline(), { value: hypeIn }), 'NotAllowed');
        await reverts(asAlice.buyVia(first.route, second.route, 0n, BigInt((await provider.getBlock('latest')).timestamp - 1), { value: hypeIn }), 'Expired');
        await nothingLeft([mid, tokenA]);
      });
    }
  }
  await step('paused: two-step trades stop too', async () => {
    await (await swap.setPaused(true)).wait();
    const second = await routeOf(VIA[0][1]);
    const first = firsts.find((f) => f.tokens.some((t) => !isHype(t) && second.tokens.includes(t))) || firsts[0];
    await reverts(asAlice.buyVia(first.route, second.route, 0n, await deadline(), { value: 1000n }), 'Paused');
    await (await swap.setPaused(false)).wait();
  });

  console.log('\nsummary');
  for (const [l, r] of results) console.log('  ' + l.padEnd(22) + r);
  console.log(`\n${passed} passed`);
}
main().then(() => process.exit(0), (e) => { console.error('FAIL', e.shortMessage || e.message, e.stack); process.exit(1); });
