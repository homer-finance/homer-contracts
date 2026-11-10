'use strict';
// End-to-end check of HomerSwap on the real chain, without deploying anything: one eth_call with a
// state override puts a harness contract (with HYPE) at a spare address. Inside that call the
// harness deploys HomerSwap, then on each pool quotes, buys 1 HYPE, approves, quotes and sells half
// back, and reports every number. Covers v4 pools, which the Shanghai fork (fork-swap.js) cannot run:
// Uniswap v4 needs transient storage.
// Run: npm run build && node scripts/live-sim-swap.js   (RPC_URL overrides the node.)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');
const { ethers } = require('ethers');

const RPC = process.env.RPC_URL || 'https://rpc.elysium.kinetiq.xyz';
const FEE_BPS = 25n;
const BEEF = '0x000000000000000000000000000000000000bEEF';
const HARNESS = '0x00000000000000000000000000000000000Ce5A1';

const FACTORIES = [
  '0x809ff79945FfFbf9B8Df33Bb3B62872CEB2efaF1',
  '0x367f85886af509e364c8190862bc714555fefc3e',
  '0xe83aabbd2e326ceaae3bdcb605b3af94ac3cf883',
  '0xd5a7c10820446c58868a204b8979b8cc9cb2a1a3',
  '0x4F66184A9FFabB7f7071D590C2c48DEDf41676f4',
];
const POOL_MANAGERS = [
  '0xb308B5df891c300a5f5a5b8fdBC30108bA842490',
  '0x06c63714fbf1f5753017123e2fcfdede4540b2c4',
  '0x5fb015a49f5b35073f9ce01c2adb287a75f89600',
  '0x3564d7defdb26abe3f0953ee57d93953ec94fa25',
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
const INIT = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const ZERO = ethers.ZeroAddress;

const HARNESS_SRC = `
pragma solidity 0.8.28;
import {HomerSwap, PoolKey} from "./HomerSwap.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
interface IV3PoolT { function token0() external view returns (address); function token1() external view returns (address); }
contract Harness {
  address constant BEEF = 0x000000000000000000000000000000000000bEEF;
  struct Result { uint256 quoteBuy; uint256 bought; uint256 feeBuy; uint256 quoteSell; uint256 sold; uint256 got; uint256 feeSell; uint256 leftHype; uint256 leftToken; }
  function run(HomerSwap.Route[] calldata routes, address[] calldata facs, address[] calldata pms, address[] calldata wrapped)
    external returns (Result[] memory res)
  {
    HomerSwap s = new HomerSwap(address(this), BEEF, ${FEE_BPS}, facs, pms, wrapped, new address[](0), new uint16[](0));
    res = new Result[](routes.length);
    for (uint256 i; i < routes.length; ++i) {
      HomerSwap.Route calldata r = routes[i];
      IERC20 token = IERC20(_token(r, s));
      Result memory x;
      (x.quoteBuy,) = s.quoteBuy(r, 1 ether);
      uint256 f0 = BEEF.balance;
      x.bought = s.buy{value: 1 ether}(r, 0, block.timestamp + 600);
      x.feeBuy = BEEF.balance - f0;
      x.sold = x.bought / 2;
      token.approve(address(s), x.sold);
      (x.quoteSell,) = s.quoteSell(r, x.sold);
      f0 = BEEF.balance;
      uint256 h0 = address(this).balance;
      x.got = s.sell(r, x.sold, 0, block.timestamp + 600);
      require(address(this).balance - h0 == x.got, "reported != received");
      x.feeSell = BEEF.balance - f0;
      x.leftHype = address(s).balance;
      x.leftToken = token.balanceOf(address(s));
      res[i] = x;
    }
  }
  function _token(HomerSwap.Route calldata r, HomerSwap s) private view returns (address) {
    if (r.kind == 3) {
      address t0 = IV3PoolT(r.target).token0();
      return s.isWrapped(t0) ? IV3PoolT(r.target).token1() : t0;
    }
    return r.key.currency0 == address(0) || s.isWrapped(r.key.currency0) ? r.key.currency1 : r.key.currency0;
  }
  receive() external payable {}
}`;

function compile() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'HomerSwap.sol'), 'utf8');
  const findImports = (p) => {
    try {
      return { contents: fs.readFileSync(require.resolve(p, { paths: [path.join(__dirname, '..')] }), 'utf8') };
    } catch {
      return { error: 'not found: ' + p };
    }
  };
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'HomerSwap.sol': { content: src }, 'Harness.sol': { content: HARNESS_SRC } },
    // Same settings as build.js, so the harness deploys the same HomerSwap code.
    settings: { evmVersion: 'shanghai', viaIR: true, optimizer: { enabled: true, runs: 200 }, metadata: { bytecodeHash: 'none' }, outputSelection: { '*': { '*': ['abi', 'evm.deployedBytecode.object'] } } },
  }), { import: findImports }));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  const h = out.contracts['Harness.sol'].Harness;
  return { abi: h.abi, code: '0x' + h.evm.deployedBytecode.object };
}

async function rpc(method, params) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (!j.error) return j.result;
      if (method === 'eth_call') throw Object.assign(new Error(j.error.message), { data: j.error.data });
    } catch (e) {
      if (method === 'eth_call') throw e;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error('rpc failed: ' + method);
}

async function v4Key(manager, id) {
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  for (let s = 0; s <= head; s += 5000) {
    const logs = await rpc('eth_getLogs', [{ address: manager, topics: [INIT, id], fromBlock: '0x' + s.toString(16), toBlock: '0x' + Math.min(head, s + 4999).toString(16) }]);
    if (logs.length) {
      const w = logs[0].data.slice(2).match(/.{64}/g);
      return {
        currency0: ethers.getAddress('0x' + logs[0].topics[2].slice(26)),
        currency1: ethers.getAddress('0x' + logs[0].topics[3].slice(26)),
        fee: Number(BigInt('0x' + w[0])),
        tickSpacing: Number(BigInt.asIntN(24, BigInt('0x' + w[1]))),
        hooks: ethers.getAddress('0x' + w[2].slice(24)),
      };
    }
  }
  throw new Error('no Initialize for ' + id);
}

async function main() {
  const H = compile();
  const iface = new ethers.Interface(H.abi);
  const routes = [];
  const names = [];
  const emptyKey = { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO };
  for (const [name, pool] of V3) { names.push(name); routes.push({ kind: 3, target: pool, key: emptyKey }); }
  for (const [name, pm, id] of V4) { names.push(name); routes.push({ kind: 4, target: pm, key: await v4Key(pm, id) }); }

  let passed = 0;
  // One call per pool keeps a failure readable.
  for (let i = 0; i < routes.length; i++) {
    const data = iface.encodeFunctionData('run', [[routes[i]], FACTORIES, POOL_MANAGERS, WRAPPED]);
    let ret;
    try {
      ret = await rpc('eth_call', [
        { from: BEEF, to: HARNESS, data, gas: '0x' + (30_000_000).toString(16) },
        'latest',
        { [HARNESS]: { code: H.code, balance: '0x' + (10n ** 21n).toString(16) } },
      ]);
    } catch (e) {
      console.log(`  FAIL ${names[i]}: ${e.message} ${e.data || ''}`);
      continue;
    }
    const [res] = iface.decodeFunctionResult('run', ret);
    const x = res[0];
    const ONE = 10n ** 18n;
    const pct = (a, b) => (Number((a * 1000000n) / (b || 1n)) / 10000).toFixed(2) + '%';
    try {
      assert.equal(x.feeBuy, (ONE * FEE_BPS) / 10000n, 'buy fee is exactly 0.25% of 1 HYPE');
      assert.ok(x.bought > 0n && x.bought <= x.quoteBuy && x.bought * 1000n >= x.quoteBuy * 990n, `bought ${x.bought} vs quote ${x.quoteBuy}`);
      assert.ok(x.got > 0n && x.got <= x.quoteSell && x.got * 1000n >= x.quoteSell * 990n, `got ${x.got} vs quote ${x.quoteSell}`);
      assert.equal(x.feeSell, ((x.got + x.feeSell) * FEE_BPS) / 10000n, 'sell fee is exactly 0.25% of the gross');
      assert.equal(x.leftHype, 0n, 'no HYPE left in HomerSwap');
      assert.equal(x.leftToken, 0n, 'no tokens left in HomerSwap');
      passed++;
      console.log(`  ok  ${names[i]}: buy ${pct(x.bought, x.quoteBuy)} of quote, sell ${pct(x.got, x.quoteSell)} of quote, round trip ${pct(x.got, ONE)} of 1 HYPE back`);
    } catch (e) {
      console.log(`  FAIL ${names[i]}: ${e.message}`);
    }
  }
  console.log(`\n${passed}/${routes.length} pools passed`);
  process.exit(passed === routes.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
