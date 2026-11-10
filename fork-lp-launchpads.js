'use strict';
// Fork probe: can people open liquidity positions from Homer in other launchpads' v4 pools?
// Uses the live HomerV4Manager. Allows the shared Uniswap v4 PositionManager on it (as the owner,
// the way Homer's deploy tool will), then for each pool: open a full-range position with HYPE only (zap, as
// Homer's Add liquidity does), trade through the pool, collect the fees, remove everything.
// Reports, per pool, what the launchpad's hook lets through and what an LP earns.
//   FORK_URL=https://rpc.elysium.kinetiq.xyz npx hardhat --config hardhat.cancun.config.js run scripts/fork-lp-launchpads.js
const fs = require('node:fs');
const path = require('node:path');
const hre = require('hardhat');
const { freshSigners } = require('./lib/wallets.js');
const { ethers } = require('ethers');

const art = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'out', n + '.json'), 'utf8'));
const MGR = '0x63B202b8c36b0Cd35782Af0068D0A60Fd1394b86'; // HomerV4Manager, live
const SWAP = '0x1cae4a793ce7b8ed136d1143ed31e402f9b53873'; // Homer Swap, live (shared manager on)
const SHARED_PM = '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1';
const POSMS = {
  [SHARED_PM]: '0x1d1C51b9d07fD27d36412A2b66CC23D19Eb3E518', // Uniswap's own, on Elysium
  '0x5fb015a49f5b35073f9ce01c2adb287a75f89600': '0x1f9b957071228a3190280e062cc62a3f66b6a13a', // ElysPump's
};
const INIT = ethers.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
const POOLS = [
  ['Montra', '0x35bd0e6a8b82e0e18b0381757d97ba01cde11a02740f006132dd40395ffc8ce2'],
  ['Montra', '0x61a799e016a5433af3e67cee4ca32dae81338c1ae7287192dc9d69b83b282aac'],
  ['Ascend', '0xc0be17156606216257c638d839c1dd6d43955a565e0b3d6c568d79ebe82cf84c'],
  ['Volta', '0x7b182abb748bae25e2c73abd8b4cf3157d8d35a47e4b36d1ee5565ade94c3c27'],
  ['RONS v4', '0x5cd045e58eacdd5aab1d2cbe84d12a27f670f22e11e17e3d4a82d397980d7668'],
  ['Between Quotes', '0x2dfc24f0f80c0a6c37368f4270ead84e5759b5ab22ca3b8ddf2fa85d630e4b95'],
  ['Uniswap v4 (KNTQ 1%)', '0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac'],
];
const WHYPE = ['0x0269031ace34a7821e9d9980d087c35ce7c19eef', '0xba876237b0f021a6c6d852d6c26e107997cc5e81', '0xa27c79491bac6e20e2b18c0b21feb8dedd8caa41', '0xaeb7ede82165bb12ea5c0c80ce8c0a0d05bce6af', '0x9f041fad8323d7c5bf8f928aade05b610df34b64'];
const ZERO = ethers.ZeroAddress;
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function deposit() payable', 'function symbol() view returns (string)'];
const SWAP_ABI = [
  'function quoteBuy((uint8,address,(address,address,uint24,int24,address)),uint256) returns (uint256,uint256)',
  'function buy((uint8,address,(address,address,uint24,int24,address)),uint256,uint256) payable returns (uint256)',
  'function sell((uint8,address,(address,address,uint24,int24,address)),uint256,uint256,uint256) returns (uint256)',
];

async function main() {
  const provider = new ethers.BrowserProvider(hre.network.provider);
  await provider.send('evm_mine', []);
  const archive = new ethers.JsonRpcProvider(process.env.FORK_URL || 'https://rpc.elysium.kinetiq.xyz', undefined, { staticNetwork: true });
  const [lp, trader] = await freshSigners(provider, 2);
  const lpA = await lp.getAddress();
  const M = art('HomerV4Manager');
  const IFACE = new ethers.Interface(M.abi);
  const mgr = new ethers.Contract(MGR, M.abi, provider);
  const ownerA = await mgr.owner();
  await provider.send('hardhat_impersonateAccount', [ownerA]);
  await provider.send('hardhat_setBalance', [ownerA, '0x56bc75e2d63100000']);
  const owner = new ethers.JsonRpcSigner(provider, ownerA);
  for (const posm of Object.values(POSMS)) if (!(await mgr.isAllowed(posm))) await (await mgr.connect(owner).setManager(posm, true)).wait();
  console.log('v4 LP manager', MGR, 'allowed:', JSON.stringify(Object.values(POSMS).map((p) => p.slice(0, 8))));
  const swap = new ethers.Contract(SWAP, SWAP_ABI, trader);
  const deadline = async () => BigInt((await provider.getBlock('latest')).timestamp + 3600);
  const why = (e) => {
    const d = e.data || (e.info && e.info.error && e.info.error.data) || '';
    try { const p = IFACE.parseError(d); if (p) return p.name; } catch { /* not the manager's */ }
    return (typeof d === 'string' && d.length >= 10 ? 'revert ' + d.slice(0, 10) : '') + ' ' + (e.shortMessage || e.message || '').slice(0, 90);
  };

  const rows = [];
  const list = process.env.POOLS ? process.env.POOLS.split(',').map((x) => x.split(':')) : POOLS;
  for (const [venue, id] of list) {
    const row = { venue, id: id.slice(0, 10) };
    rows.push(row);
    try {
      const logs = await archive.send('eth_getLogs', [{ address: Object.keys(POSMS), topics: [INIT, id], fromBlock: '0x0', toBlock: 'latest' }]);
      if (!logs.length) { row.result = 'pool not found on a listed manager'; continue; }
      const l = logs[0];
      const [fee, ts, hooks] = ethers.AbiCoder.defaultAbiCoder().decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data);
      const key = { currency0: ethers.getAddress('0x' + l.topics[2].slice(26)), currency1: ethers.getAddress('0x' + l.topics[3].slice(26)), fee: Number(fee), tickSpacing: Number(ts), hooks: ethers.getAddress(hooks) };
      const posm = POSMS[l.address.toLowerCase()];
      const hypeIs0 = key.currency0 === ZERO || WHYPE.includes(key.currency0.toLowerCase());
      const hypeSide = hypeIs0 ? key.currency0 : key.currency1;
      const tokenA = hypeIs0 ? key.currency1 : key.currency0;
      const token = new ethers.Contract(tokenA, ERC20, provider);
      row.pair = `${await token.symbol().catch(() => '?')}/${hypeSide === ZERO ? 'HYPE' : 'WHYPE'}`;
      row.fee = key.fee >= 0x800000 ? 'dynamic' : key.fee / 1e4 + '%';
      row.hook = key.hooks.slice(0, 8).toLowerCase();
      const tl = -Math.floor(887272 / key.tickSpacing) * key.tickSpacing;
      // 1. Open: HYPE only, half swapped in the pool (Homer's zap).
      const amountIn = ethers.parseEther('0.5');
      let value = 0n;
      if (hypeSide === ZERO) value = amountIn;
      else {
        const w = new ethers.Contract(hypeSide, ERC20, lp);
        await (await w.deposit({ value: amountIn })).wait();
        await (await w.approve(MGR, amountIn)).wait();
      }
      let tokenId;
      let liquidity;
      try {
        const rc = await (await mgr.connect(lp).zap({ posm, key, tickLower: tl, tickUpper: -tl, zeroForOne: hypeIs0, amountIn, swapIn: amountIn / 2n, swapOutMin: 0, liquidityMin: 1, deadline: await deadline() }, { value, gasLimit: 6_000_000 })).wait();
        for (const lg of rc.logs) { try { const e = IFACE.parseLog(lg); if (e && e.args.tokenId !== undefined) { tokenId = e.args.tokenId; if (e.args.liquidity !== undefined) liquidity = e.args.liquidity; } } catch { /* other contracts */ } }
        row.open = 'ok';
      } catch (e) { row.open = 'refused: ' + why(e); row.result = 'cannot add liquidity'; continue; }
      // 2. Trade through the pool: 4 round trips of 0.3 HYPE.
      const route = [4, l.address, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]];
      try {
        for (let i = 0; i < 4; i++) {
          const b0 = await token.balanceOf(await trader.getAddress());
          await (await swap.buy(route, 0n, await deadline(), { value: ethers.parseEther('0.3') })).wait();
          const got = (await token.balanceOf(await trader.getAddress())) - b0;
          await (await token.connect(trader).approve(SWAP, got)).wait();
          await (await swap.sell(route, got, 0n, await deadline())).wait();
        }
        row.trades = 'ok';
      } catch (e) { row.trades = 'failed: ' + why(e); }
      // 3. Fees earned by the position (after Homer's share), then collected.
      try {
        const [f0, f1] = await mgr.connect(lp).collect.staticCall(posm, tokenId);
        const fh = hypeIs0 ? f0 : f1;
        const ft = hypeIs0 ? f1 : f0;
        row.fees = `${ethers.formatEther(fh)} HYPE + ${ft} token`;
        await (await mgr.connect(lp).collect(posm, tokenId)).wait();
      } catch (e) { row.fees = 'collect failed: ' + why(e); }
      // 4. Remove everything.
      try {
        if (liquidity === undefined) liquidity = await new ethers.Contract(posm, ['function getPositionLiquidity(uint256) view returns (uint128)'], provider).getPositionLiquidity(tokenId);
        await (await mgr.connect(lp).decrease({ posm, tokenId, liquidity, amount0Min: 0, amount1Min: 0, deadline: await deadline() }, { gasLimit: 3_000_000 })).wait();
        row.remove = 'ok';
      } catch (e) { row.remove = 'refused: ' + why(e); }
      row.result = row.remove === 'ok' && row.fees && !row.fees.startsWith('collect failed') ? (row.fees.startsWith('0.0 HYPE + 0 ') ? 'works, but LPs earn nothing' : 'works, LPs earn fees') : 'partly';
    } catch (e) {
      row.result = 'error: ' + why(e);
    }
    console.log(JSON.stringify(row));
  }
  console.log('\nsummary');
  for (const r of rows) console.log(`  ${(r.venue + ' ' + (r.pair || '')).padEnd(34)} hook ${r.hook || '-'} fee ${String(r.fee || '').padEnd(8)} open: ${r.open || '-'} | trades: ${r.trades || '-'} | fees: ${r.fees || '-'} | remove: ${r.remove || '-'} => ${r.result}`);
}
main().then(() => process.exit(0), (e) => { console.error('FAIL', e.shortMessage || e.message); process.exit(1); });
