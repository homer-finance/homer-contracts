'use strict';
// Fork probe: can a Homer pool be created for a launchpad's token whose own pools refuse outside
// liquidity (Ascend, RONS) or pay it nothing (Volta)? With Homer's live hook, v4 manager and Homer
// Swap: create a 1% Homer pool for the token and open a full-range position in one transaction,
// trade through it both ways with Homer Swap, collect the LP's fees, then remove everything.
//   TOKENS=sym:address:priceInHype,... FORK_URL=https://rpc.elysium.kinetiq.xyz \
//   npx hardhat --config hardhat.cancun.config.js run scripts/fork-homer-pools.js
const fs = require('node:fs');
const path = require('node:path');
const hre = require('hardhat');
const { freshSigners } = require('./lib/wallets.js');
const { ethers } = require('ethers');

const art = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'out', n + '.json'), 'utf8'));
const MGR = '0x63B202b8c36b0Cd35782Af0068D0A60Fd1394b86'; // HomerV4Manager, live
const HOOK = '0x1295bd9d641185f361016a898a61a801c0d3e044'; // HomerPoolHook, live
const PM = '0x5fb015a49f5b35073f9ce01c2adb287a75f89600'; // the v4 PoolManager Homer pools live on
const POSM = '0x1f9b957071228a3190280e062cc62a3f66b6a13a';
const SWAP = '0xa9967eaba36531526a1458aed9b16453adcfb7e9'; // Homer Swap v3, live
const ZERO = ethers.ZeroAddress;
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)'];
const SWAP_ABI = [
  'function buy((uint8,address,(address,address,uint24,int24,address)),uint256,uint256) payable returns (uint256)',
  'function sell((uint8,address,(address,address,uint24,int24,address)),uint256,uint256,uint256) returns (uint256)',
];
const POSM_ABI = ['function nextTokenId() view returns (uint256)', 'function getPositionLiquidity(uint256) view returns (uint128)'];

// Give `who` a token balance by writing its balance slot (tried over the usual slots).
async function fund(provider, token, who, amount) {
  const t = new ethers.Contract(token, ERC20, provider);
  for (let slot = 0; slot < 60; slot++) {
    const key = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [who, slot]));
    const prev = await provider.send('eth_getStorageAt', [token, key, 'latest']);
    await provider.send('hardhat_setStorageAt', [token, key, ethers.toBeHex(amount, 32)]);
    if ((await t.balanceOf(who)) === amount) return true;
    await provider.send('hardhat_setStorageAt', [token, key, prev]);
  }
  return false;
}

function liquidityFor(x, y, s, tl, tu) {
  const sa = Math.pow(1.0001, tl / 2);
  const sb = Math.pow(1.0001, tu / 2);
  const Lx = s < sb ? (Number(x) * s * sb) / (sb - Math.max(s, sa)) : Infinity;
  const Ly = s > sa ? Number(y) / (Math.min(s, sb) - sa) : Infinity;
  return BigInt(Math.floor(Math.min(Lx, Ly) * 0.99));
}

async function main() {
  const provider = new ethers.BrowserProvider(hre.network.provider);
  await provider.send('evm_mine', []);
  const [lp, trader] = await freshSigners(provider, 2);
  const lpA = await lp.getAddress();
  const traderA = await trader.getAddress();
  const M = art('HomerV4Manager');
  const IFACE = new ethers.Interface(M.abi);
  const mgr = new ethers.Contract(MGR, M.abi, lp);
  const posm = new ethers.Contract(POSM, POSM_ABI, provider);
  const swap = new ethers.Contract(SWAP, SWAP_ABI, trader);
  const deadline = async () => BigInt((await provider.getBlock('latest')).timestamp + 3600);
  const why = (e) => {
    const d = e.data || (e.info && e.info.error && e.info.error.data) || '';
    try { const p = IFACE.parseError(d); if (p) return p.name; } catch { /* not the manager's */ }
    return (typeof d === 'string' && d.length >= 10 ? 'revert ' + d.slice(0, 10) : '') + ' ' + (e.shortMessage || e.message || '').slice(0, 90);
  };
  const rows = [];
  for (const [venue, sym, addr, pxStr] of (process.env.TOKENS || '').split(',').filter(Boolean).map((x) => x.split(':'))) {
    const row = { venue, token: sym };
    rows.push(row);
    try {
      const token = new ethers.Contract(addr, ERC20, provider);
      const dec = Number(await token.decimals());
      const priceHype = Number(pxStr); // HYPE per token
      // 2 HYPE of liquidity: 1 HYPE and its worth of the token, full range, a 1% Homer pool.
      const tokens = BigInt(Math.floor((1 / priceHype) * 1.05 * 10 ** Math.min(dec, 6))) * 10n ** BigInt(Math.max(0, dec - 6));
      if (!(await fund(provider, addr, lpA, tokens * 2n))) { row.result = 'could not give the test wallet tokens'; continue; }
      const key = { currency0: ZERO, currency1: ethers.getAddress(addr), fee: 9000, tickSpacing: 200, hooks: HOOK };
      const rawPerHype = (1 / priceHype) * 10 ** (dec - 18); // token raw units per HYPE wei
      const sqrtP = Math.sqrt(rawPerHype);
      const sqrtX96 = BigInt(Math.floor(sqrtP * 2 ** 96));
      const TL = -887200;
      const TU = 887200;
      const ONE = ethers.parseEther('1');
      await (await token.connect(lp).approve(MGR, tokens * 2n)).wait();
      const tokenId = await posm.nextTokenId();
      const L = liquidityFor(ONE, tokens, sqrtP, TL, TU);
      try {
        await (await mgr.mint({ posm: POSM, key, tickLower: TL, tickUpper: TU, liquidity: L, amount0Max: ONE, amount1Max: tokens, deadline: await deadline(), createAtSqrtPriceX96: sqrtX96 }, { value: ONE, gasLimit: 6_000_000 })).wait();
        row.create = 'ok';
      } catch (e) { row.create = 'refused: ' + why(e); row.result = 'cannot create a Homer pool'; continue; }
      const route = [4, PM, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]];
      try {
        for (let i = 0; i < 3; i++) {
          const b0 = await token.balanceOf(traderA);
          await (await swap.buy(route, 0n, await deadline(), { value: ethers.parseEther('0.1') })).wait();
          const got = (await token.balanceOf(traderA)) - b0;
          if (got === 0n) throw new Error('bought nothing');
          await (await token.connect(trader).approve(SWAP, got)).wait();
          await (await swap.sell(route, got, 0n, await deadline())).wait();
        }
        row.trades = 'ok';
      } catch (e) { row.trades = 'failed: ' + why(e); }
      try {
        const [f0, f1] = await mgr.collect.staticCall(POSM, tokenId);
        row.fees = `${ethers.formatEther(f0)} HYPE + ${ethers.formatUnits(f1, dec)} ${sym}`;
        await (await mgr.collect(POSM, tokenId)).wait();
      } catch (e) { row.fees = 'collect failed: ' + why(e); }
      try {
        const liq = await posm.getPositionLiquidity(tokenId);
        await (await mgr.decrease({ posm: POSM, tokenId, liquidity: liq, amount0Min: 0, amount1Min: 0, deadline: await deadline() }, { gasLimit: 3_000_000 })).wait();
        row.remove = 'ok';
      } catch (e) { row.remove = 'refused: ' + why(e); }
      row.result = row.create === 'ok' && row.trades === 'ok' && row.remove === 'ok' && row.fees && !row.fees.startsWith('0.0 HYPE + 0.0') && !row.fees.startsWith('collect') ? 'works: a Homer pool, LPs earn fees' : 'partly';
    } catch (e) {
      row.result = 'error: ' + why(e);
    }
    console.log(JSON.stringify(row));
  }
  console.log('\nsummary');
  for (const r of rows) console.log(`  ${(r.venue + ' ' + r.token).padEnd(22)} create: ${r.create || '-'} | trades: ${r.trades || '-'} | fees: ${r.fees || '-'} | remove: ${r.remove || '-'} => ${r.result}`);
}
main().then(() => process.exit(0), (e) => { console.error('FAIL', e.shortMessage || e.message); process.exit(1); });
