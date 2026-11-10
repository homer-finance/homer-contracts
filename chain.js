'use strict';
/* Homer chain helpers: calldata for Uniswap-v3 position managers and the
   concentrated-liquidity maths behind it. No dependencies; also loadable in Node for tests. */

(function (root) {
  const MAX_UINT128 = (1n << 128n) - 1n;
  const MIN_TICK = -887272;
  const MAX_TICK = 887272;
  const Q96 = 2 ** 96;

  const SEL = {
    mint: '88316456',
    increaseLiquidity: '219f5d17',
    decreaseLiquidity: '0c49ccbe',
    collect: 'fc6f7865',
    multicall: 'ac9650d8',
    refundETH: '12210e8a',
    unwrapWETH9: '49404b7c',
    sweepToken: 'df2ab5bb',
    approve: '095ea7b3',
    allowance: 'dd62ed3e',
    balanceOf: '70a08231',
    slot0: '3850c7bd',
    stake: 'a694fc3a',
    withdraw: '2e1a7d4d',
    getReward: '3d18b912',
    exit: 'e9fad8ee',
    earned: '008cc262',
    // HomerLiquidityManager
    homerMint: '3762621e',
    homerIncrease: '7da562c9',
    homerCollect: '3f8e2936',
    homerDecrease: 'fadb5af9',
    homerWithdraw: '69328dec',
    homerRebalance: '77345068',
    homerZap: '23b4d59c',
    liquidity: '1a686502',
    // HomerSwap
    swapBuy: 'b9278b9e',
    swapSell: '14e04906',
    swapQuoteBuy: 'ef2c8a97',
    swapQuoteSell: 'd37542d6',
    // HomerSwap version 3: two-step trades through a middle token
    swapBuyVia: '3a7750ad',
    swapSellVia: '04cb8516',
    swapQuoteBuyVia: '95cfdb83',
    swapQuoteSellVia: 'a6cae40a',
    // HomerV4Manager
    v4Mint: 'c51de567',
    v4Increase: 'da0e5e2a',
    v4Decrease: '661c413e',
    v4Collect: '6b8357ac',
    v4Withdraw: '69328dec',
    v4Rebalance: '08325136',
    v4Zap: '87aa675e',
    // Uniswap v4 PoolManager
    v4Initialize: '6276cbbe',
  };

  const ADDR = /^0x[0-9a-fA-F]{40}$/;

  function word(v) {
    let n = BigInt(v);
    if (n < 0n) n = (1n << 256n) + n; // two's complement for int24 / int256
    if (n < 0n || n >= 1n << 256n) throw new Error('value out of range');
    return n.toString(16).padStart(64, '0');
  }
  function addr(a) {
    if (!ADDR.test(a)) throw new Error('bad address');
    return a.slice(2).toLowerCase().padStart(64, '0');
  }
  const strip = (h) => (h.startsWith('0x') ? h.slice(2) : h);

  function mint(p) {
    return '0x' + SEL.mint + addr(p.token0) + addr(p.token1) + word(p.fee) + word(p.tickLower) + word(p.tickUpper) +
      word(p.amount0Desired) + word(p.amount1Desired) + word(p.amount0Min) + word(p.amount1Min) + addr(p.recipient) + word(p.deadline);
  }
  function increaseLiquidity(p) {
    return '0x' + SEL.increaseLiquidity + word(p.tokenId) + word(p.amount0Desired) + word(p.amount1Desired) +
      word(p.amount0Min) + word(p.amount1Min) + word(p.deadline);
  }
  function decreaseLiquidity(p) {
    return '0x' + SEL.decreaseLiquidity + word(p.tokenId) + word(p.liquidity) + word(p.amount0Min) + word(p.amount1Min) + word(p.deadline);
  }
  function collect(p) {
    return '0x' + SEL.collect + word(p.tokenId) + addr(p.recipient) + word(MAX_UINT128) + word(MAX_UINT128);
  }
  const refundETH = () => '0x' + SEL.refundETH;
  const unwrapWETH9 = (min, to) => '0x' + SEL.unwrapWETH9 + word(min) + addr(to);
  const sweepToken = (token, min, to) => '0x' + SEL.sweepToken + addr(token) + word(min) + addr(to);
  const approve = (spender, amount) => '0x' + SEL.approve + addr(spender) + word(amount);
  const allowance = (owner, spender) => '0x' + SEL.allowance + addr(owner) + addr(spender);
  const balanceOf = (owner) => '0x' + SEL.balanceOf + addr(owner);
  // Synthetix StakingRewards
  const stake = (amount) => '0x' + SEL.stake + word(amount);
  const withdraw = (amount) => '0x' + SEL.withdraw + word(amount);
  const getReward = () => '0x' + SEL.getReward;
  const exit = () => '0x' + SEL.exit;
  const earned = (owner) => '0x' + SEL.earned + addr(owner);

  // HomerLiquidityManager: same fields as the position manager plus the venue's manager;
  // the NFT is held by Homer, HYPE is sent as value and leftovers come back as HYPE.
  function homerMint(p) {
    return '0x' + SEL.homerMint + addr(p.manager) + addr(p.token0) + addr(p.token1) + word(p.fee) + word(p.tickLower) + word(p.tickUpper) +
      word(p.amount0Desired) + word(p.amount1Desired) + word(p.amount0Min) + word(p.amount1Min) + word(p.deadline);
  }
  function homerIncrease(p) {
    return '0x' + SEL.homerIncrease + addr(p.manager) + word(p.tokenId) + word(p.amount0Desired) + word(p.amount1Desired) +
      word(p.amount0Min) + word(p.amount1Min) + word(p.deadline);
  }
  const homerCollect = (p) => '0x' + SEL.homerCollect + addr(p.manager) + word(p.tokenId) + word(p.unwrap ? 1 : 0);
  function homerDecrease(p) {
    return '0x' + SEL.homerDecrease + addr(p.manager) + word(p.tokenId) + word(p.liquidity) + word(p.amount0Min) + word(p.amount1Min) +
      word(p.deadline) + word(p.unwrap ? 1 : 0);
  }
  // zap(ZapArgs), HomerLiquidityManager v3: one token in, every field static.
  function homerZap(p) {
    return '0x' + SEL.homerZap + addr(p.manager) + addr(p.token0) + addr(p.token1) + word(p.fee) + word(p.tickLower) + word(p.tickUpper) +
      word(p.zeroForOne ? 1 : 0) + word(p.amountIn) + word(p.swapIn) + word(p.swapOutMin) + word(p.amount0Min) + word(p.amount1Min) +
      word(p.deadline) + word(p.unwrap ? 1 : 0);
  }
  const homerWithdraw = (p) => '0x' + SEL.homerWithdraw + addr(p.manager) + word(p.tokenId) + addr(p.to);
  // rebalance(RebalanceArgs): every field is static, so the tuple is encoded in place.
  function homerRebalance(p) {
    return '0x' + SEL.homerRebalance + addr(p.manager) + word(p.tokenId) + word(p.tickLower) + word(p.tickUpper) +
      word(p.remove0Min) + word(p.remove1Min) + word(p.zeroForOne ? 1 : 0) + word(p.swapIn) + word(p.swapOutMin) +
      word(p.amount0Min) + word(p.amount1Min) + word(p.deadline) + word(p.unwrap ? 1 : 0);
  }

  // multicall(bytes[] data)
  // HomerSwap route: (uint8 kind, address target, (address,address,uint24,int24,address) key).
  // Every field is fixed-size, so the struct is encoded inline as seven words.
  const ZERO_KEY = { currency0: '0x0000000000000000000000000000000000000000', currency1: '0x0000000000000000000000000000000000000000', fee: 0, tickSpacing: 0, hooks: '0x0000000000000000000000000000000000000000' };
  function route(r) {
    const k = r.key || ZERO_KEY;
    return word(r.kind) + addr(r.target) + addr(k.currency0) + addr(k.currency1) + word(k.fee) + word(k.tickSpacing) + addr(k.hooks);
  }
  const swapBuy = (r, minOut, deadline) => '0x' + SEL.swapBuy + route(r) + word(minOut) + word(deadline);
  const swapSell = (r, amountIn, minOut, deadline) => '0x' + SEL.swapSell + route(r) + word(amountIn) + word(minOut) + word(deadline);
  const swapQuoteBuy = (r, hypeIn) => '0x' + SEL.swapQuoteBuy + route(r) + word(hypeIn);
  const swapQuoteSell = (r, amountIn) => '0x' + SEL.swapQuoteSell + route(r) + word(amountIn);
  // Two-step trades (version 3): `first` is the middle token's HYPE pool, `second` the token's
  // pool against the middle token. Buying lists first then second; selling, second then first.
  const swapBuyVia = (first, second, minOut, deadline) => '0x' + SEL.swapBuyVia + route(first) + route(second) + word(minOut) + word(deadline);
  const swapSellVia = (second, first, amountIn, minOut, deadline) => '0x' + SEL.swapSellVia + route(second) + route(first) + word(amountIn) + word(minOut) + word(deadline);
  const swapQuoteBuyVia = (first, second, hypeIn) => '0x' + SEL.swapQuoteBuyVia + route(first) + route(second) + word(hypeIn);
  const swapQuoteSellVia = (second, first, amountIn) => '0x' + SEL.swapQuoteSellVia + route(second) + route(first) + word(amountIn);
  // A quoted route, one step or two (kind 'via'): the call that trades it.
  const swapTrade = (r, side, amount, minOut, deadline) =>
    r.kind === 'via'
      ? side === 'buy' ? swapBuyVia(r.first, r.second, minOut, deadline) : swapSellVia(r.second, r.first, amount, minOut, deadline)
      : side === 'buy' ? swapBuy(r, minOut, deadline) : swapSell(r, amount, minOut, deadline);

  // HomerV4Manager. Every argument struct is fixed-size, so it is encoded inline.
  const v4Key = (k) => addr(k.currency0) + addr(k.currency1) + word(k.fee) + word(k.tickSpacing) + addr(k.hooks);
  const v4Mint = (p) => '0x' + SEL.v4Mint + addr(p.posm) + v4Key(p.key) + word(p.tickLower) + word(p.tickUpper) + word(p.liquidity) + word(p.amount0Max) + word(p.amount1Max) + word(p.deadline) + word(p.createAtSqrtPriceX96 || 0);
  const v4Increase = (p) => '0x' + SEL.v4Increase + addr(p.posm) + word(p.tokenId) + word(p.liquidity) + word(p.amount0Max) + word(p.amount1Max) + word(p.deadline);
  const v4Decrease = (p) => '0x' + SEL.v4Decrease + addr(p.posm) + word(p.tokenId) + word(p.liquidity) + word(p.amount0Min) + word(p.amount1Min) + word(p.deadline);
  const v4Collect = (posm, tokenId) => '0x' + SEL.v4Collect + addr(posm) + word(tokenId);
  const v4Withdraw = (posm, tokenId, to) => '0x' + SEL.v4Withdraw + addr(posm) + word(tokenId) + addr(to);
  // HomerV4Manager v2: rebalance(RebalanceArgs), a static tuple of 11 words.
  // zap(ZapArgs), HomerV4Manager v3: one token in (native HYPE as value), every field static.
  const v4Zap = (p) => '0x' + SEL.v4Zap + addr(p.posm) + v4Key(p.key) + word(p.tickLower) + word(p.tickUpper) + word(p.zeroForOne ? 1 : 0) + word(p.amountIn) + word(p.swapIn) + word(p.swapOutMin) + word(p.liquidityMin) + word(p.deadline);
  const v4Rebalance = (p) => '0x' + SEL.v4Rebalance + addr(p.posm) + word(p.tokenId) + word(p.tickLower) + word(p.tickUpper) + word(p.remove0Min) + word(p.remove1Min) + word(p.zeroForOne ? 1 : 0) + word(p.swapIn) + word(p.swapOutMin) + word(p.liquidityMin) + word(p.deadline);
  const v4Initialize = (key, sqrtPriceX96) => '0x' + SEL.v4Initialize + v4Key(key) + word(sqrtPriceX96);

  // Liquidity a deposit of amount0 / amount1 (raw) buys at sqrt price s, in range [tl, tu].
  function liquidityForAmounts(s, tl, tu, amount0, amount1) {
    const sa = tickToSqrt(tl);
    const sb = tickToSqrt(tu);
    const a0 = Number(amount0);
    const a1 = Number(amount1);
    let L;
    if (s <= sa) L = (a0 * sa * sb) / (sb - sa);
    else if (s >= sb) L = a1 / (sb - sa);
    else L = Math.min(a0 > 0 ? (a0 * s * sb) / (sb - s) : Infinity, a1 > 0 ? a1 / (s - sa) : Infinity);
    return Number.isFinite(L) && L > 0 ? BigInt(Math.floor(L * (1 - 1e-6))) : 0n;
  }
  // sqrtPriceX96 for a price of currency1 per currency0 (raw units).
  const sqrtPriceX96Of = (rawPrice1Per0) => BigInt(Math.floor(Math.sqrt(rawPrice1Per0) * Q96));

  function multicall(calls) {
    const parts = calls.map(strip);
    let head = '';
    let tail = '';
    let offset = 32 * parts.length;
    for (const p of parts) {
      head += word(offset);
      const len = p.length / 2;
      const padded = p.padEnd(Math.ceil(len / 32) * 64, '0');
      tail += word(len) + padded;
      offset += 32 + padded.length / 2;
    }
    return '0x' + SEL.multicall + word(32) + word(parts.length) + head + tail;
  }

  // ------------------------------------------------------------ amounts

  // "1.5" -> 1500000000000000000n for 18 decimals. Rejects anything that is not a plain decimal.
  function parseUnits(text, decimals) {
    const s = String(text).trim();
    if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
    const [i, f = ''] = s.split('.');
    const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
    return BigInt((i || '0') + frac);
  }
  function formatUnits(v, decimals, maxFrac = 6) {
    const neg = v < 0n;
    let n = neg ? -v : v;
    const base = 10n ** BigInt(decimals);
    const i = n / base;
    let f = (n % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
    return (neg ? '-' : '') + i.toString() + (f ? '.' + f : '');
  }
  const toBig = (x) => (Number.isFinite(x) && x > 0 ? BigInt(Math.floor(x)) : 0n);
  const applySlippage = (v, bps) => (v * BigInt(10000 - bps)) / 10000n;

  // ------------------------------------------------------------ ticks and prices

  const sqrtPriceOf = (sqrtPriceX96) => Number(BigInt(sqrtPriceX96)) / Q96; // sqrt(token1 raw / token0 raw)
  const tickToSqrt = (t) => Math.pow(1.0001, t / 2);
  const rawPrice = (tick) => Math.pow(1.0001, tick); // token1 raw per token0 raw

  // Display price is "quote per base" in whole tokens; convert to/from ticks.
  function priceToTick(price, info) {
    let p10 = info.baseIs0 ? price : 1 / price; // token1 per token0, whole tokens
    p10 *= 10 ** (info.dec1 - info.dec0);
    return Math.log(p10) / Math.log(1.0001);
  }
  function tickToPrice(tick, info) {
    const p10 = rawPrice(tick) / 10 ** (info.dec1 - info.dec0);
    return info.baseIs0 ? p10 : 1 / p10;
  }
  function usableTicks(spacing) {
    return [Math.ceil(MIN_TICK / spacing) * spacing, Math.floor(MAX_TICK / spacing) * spacing];
  }
  // Price bounds (quote per base, either order) -> aligned [tickLower, tickUpper].
  function rangeTicks(pMin, pMax, info) {
    const [lo, hi] = usableTicks(info.tickSpacing);
    if (!(pMin > 0) || !Number.isFinite(pMax)) return [lo, hi];
    const a = priceToTick(pMin, info);
    const b = priceToTick(pMax, info);
    const s = info.tickSpacing;
    let tl = Math.floor(Math.min(a, b) / s) * s;
    let tu = Math.ceil(Math.max(a, b) / s) * s;
    tl = Math.max(lo, tl);
    tu = Math.min(hi, tu);
    if (tu <= tl) tu = tl + s;
    return [tl, tu];
  }

  // Given one side (raw units), the other side needed for range [tl, tu] at sqrt price s.
  // Returns { amount0, amount1, liquidity } as floats in raw units, or null if that side is not used.
  function pairAmounts(side, amountRaw, s, tl, tu) {
    const sa = tickToSqrt(tl);
    const sb = tickToSqrt(tu);
    const a = Number(amountRaw);
    if (side === 0) {
      if (s >= sb) return null;
      const L = s <= sa ? (a * sa * sb) / (sb - sa) : (a * s * sb) / (sb - s);
      return { amount0: a, amount1: s <= sa ? 0 : L * (s - sa), liquidity: L };
    }
    if (s <= sa) return null;
    const L = s >= sb ? a / (sb - sa) : a / (s - sa);
    return { amount0: s >= sb ? 0 : (L * (sb - s)) / (s * sb), amount1: a, liquidity: L };
  }
  // Which sides a range needs at the current price.
  function sidesNeeded(s, tl, tu) {
    const sa = tickToSqrt(tl);
    const sb = tickToSqrt(tu);
    return { token0: s < sb, token1: s > sa };
  }
  function amountsForLiquidity(L, s, tl, tu) {
    const sa = tickToSqrt(tl);
    const sb = tickToSqrt(tu);
    const l = Number(L);
    if (s <= sa) return [(l * (sb - sa)) / (sa * sb), 0];
    if (s >= sb) return [0, l * (sb - sa)];
    return [(l * (sb - s)) / (s * sb), l * (s - sa)];
  }

  // Rebalance plan: how much of (have0, have1) to swap in the pool so that what is left fits the
  // range [tl, tu] at the price after the swap. Models the swap inside the active liquidity L at
  // sqrt price s with pool fee `fee` (hundredths of a bip); a swap that crosses ticks gets a
  // slightly different price, which the minimums catch and the contract refunds.
  // Returns { zeroForOne, swapIn, out, s1, use0, use1 } in raw units (floats), or null.
  function planRebalance({ s, L, fee, tl, tu, have0, have1 }) {
    const sa = tickToSqrt(tl);
    const sb = tickToSqrt(tu);
    const keep = 1 - fee / 1e6;
    if (!(L > 0) || !(s > 0)) return null;
    const after = (zeroForOne, amountIn) => {
      const eff = amountIn * keep;
      if (zeroForOne) {
        const s1 = 1 / (1 / s + eff / L);
        return { s1, x: have0 - amountIn, y: have1 + L * (s - s1), out: L * (s - s1) };
      }
      const s1 = s + eff / L;
      return { s1, x: have0 + L * (1 / s - 1 / s1), y: have1 - amountIn, out: L * (1 / s - 1 / s1) };
    };
    // > 0: more token0 than the range wants at that price; < 0: more token1.
    const excess = ({ s1, x, y }) => {
      const c = Math.min(Math.max(s1, sa), sb);
      const r0 = (sb - c) / (c * sb); // token0 per unit of liquidity
      const r1 = c - sa; // token1 per unit of liquidity
      return x * r1 - y * r0;
    };
    const start = excess({ s1: s, x: have0, y: have1 });
    if (start === 0) return { zeroForOne: true, swapIn: 0, out: 0, s1: s, ...use(s, have0, have1) };
    const zeroForOne = start > 0;
    const max = zeroForOne ? have0 : have1;
    let lo = 0;
    let hi = max;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (excess(after(zeroForOne, mid)) > 0 === zeroForOne) lo = mid;
      else hi = mid;
    }
    const r = after(zeroForOne, lo);
    return { zeroForOne, swapIn: lo, out: r.out, s1: r.s1, ...use(r.s1, r.x, r.y) };
    function use(c, x, y) {
      const [u0, u1] = amountsForLiquidity(1, c, tl, tu);
      const l = Math.min(u0 > 0 ? x / u0 : Infinity, u1 > 0 ? y / u1 : Infinity);
      return Number.isFinite(l) ? { use0: l * u0, use1: l * u1 } : { use0: 0, use1: 0 };
    }
  }

  // Slippage as a price band, the way Uniswap's own app does it. A concentrated position's
  // token mix moves fast with the price (in a ±10% range a 1% move shifts it ~20%), so
  // "amount minus 3%" fails on tiny moves. These minimums instead hold for any pool price
  // within ±bps of today's: the least the transaction can use (or return) inside that band.
  const bandEdges = (s, bps) => [s * Math.sqrt(1 - bps / 10000), s, s * Math.sqrt(1 + bps / 10000)];
  const floorBig = (x) => (Number.isFinite(x) && x > 0 ? BigInt(Math.floor(x * (1 - 1e-9))) : 0n);
  // Mint / increase with desired raw amounts (d0, d1): the amounts actually used at sqrt price x.
  function usedAt(d0, d1, x, tl, tu) {
    const sa = tickToSqrt(tl);
    const sb = tickToSqrt(tu);
    let L;
    if (x <= sa) L = (d0 * sa * sb) / (sb - sa);
    else if (x >= sb) L = d1 / (sb - sa);
    else L = Math.min((d0 * x * sb) / (sb - x), d1 / (x - sa));
    return amountsForLiquidity(L, x, tl, tu);
  }
  function mintMins(d0, d1, s, tl, tu, bps) {
    const used = bandEdges(s, bps).map((x) => usedAt(Number(d0), Number(d1), x, tl, tu));
    return [floorBig(Math.min(...used.map((u) => u[0]))), floorBig(Math.min(...used.map((u) => u[1])))];
  }
  // Uniswap v4 mints a fixed liquidity L and takes whatever that costs when it runs: the most
  // of each token L can need while the price stays within ±bps (the amount0Max / amount1Max).
  const ceilBig = (x) => (Number.isFinite(x) && x > 0 ? BigInt(Math.ceil(x * (1 + 1e-9))) + 1n : 0n);
  function v4MaxAmounts(L, s, tl, tu, bps) {
    const need = bandEdges(s, bps).map((x) => amountsForLiquidity(Number(L), x, tl, tu));
    return [ceilBig(Math.max(...need.map((u) => u[0]))), ceilBig(Math.max(...need.map((u) => u[1])))];
  }
  // Removing liquidity L: the least of each token it returns inside the band.
  function burnMins(L, s, tl, tu, bps) {
    const got = bandEdges(s, bps).map((x) => amountsForLiquidity(Number(L), x, tl, tu));
    return [floorBig(Math.min(...got.map((u) => u[0]))), floorBig(Math.min(...got.map((u) => u[1])))];
  }

  const api = {
    MAX_UINT128, MIN_TICK, MAX_TICK,
    mint, increaseLiquidity, decreaseLiquidity, collect, multicall, refundETH, unwrapWETH9, sweepToken, approve, allowance, balanceOf,
    stake, withdraw, getReward, exit, earned,
    swapBuy, swapSell, swapQuoteBuy, swapQuoteSell, swapBuyVia, swapSellVia, swapQuoteBuyVia, swapQuoteSellVia, swapTrade,
    v4Mint, v4Increase, v4Decrease, v4Collect, v4Withdraw, v4Rebalance, v4Zap, v4Initialize, liquidityForAmounts, sqrtPriceX96Of,
    homerMint, homerIncrease, homerCollect, homerDecrease, homerWithdraw, homerRebalance, homerZap, planRebalance,
    slot0: () => '0x' + SEL.slot0,
    poolLiquidity: () => '0x' + SEL.liquidity,
    parseUnits, formatUnits, toBig, applySlippage, mintMins, burnMins, v4MaxAmounts,
    sqrtPriceOf, tickToSqrt, priceToTick, tickToPrice, usableTicks, rangeTicks, pairAmounts, sidesNeeded, amountsForLiquidity,
  };
  // HYPE left in the wallet for gas when Max (or 100%) spends HYPE. One value for the whole site.
  api.GAS_KEEP = 2n * 10n ** 16n; // 0.02 HYPE
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HomerChain = api;
})(typeof window !== 'undefined' ? window : globalThis);
