'use strict';
// HomerReferralVault: claims with EIP-712 vouchers (Claim(address account,uint256 total,uint256
// deadline), domain "HomerReferralVault" version "1"), signed the way Homer's website signs them,
// on a fork of Elysium. Run: npm run build && node scripts/test-refvault.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const hre = require('hardhat');
const { ethers } = require('ethers');

const art = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'out', 'HomerReferralVault.json'), 'utf8'));
const E = (n) => ethers.parseEther(String(n));

const KEY = Uint8Array.from(Buffer.from('7b'.repeat(32), 'hex'));
const OTHER = Uint8Array.from(Buffer.from('3c'.repeat(32), 'hex'));
const addrOf = (k) => ethers.computeAddress('0x' + Buffer.from(k).toString('hex')).toLowerCase();
const CLAIM = { Claim: [{ name: 'account', type: 'address' }, { name: 'total', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };
function voucher(vault, account, total, deadline, key = KEY) {
  const domain = { name: 'HomerReferralVault', version: '1', chainId: 99901, verifyingContract: vault };
  const digest = ethers.TypedDataEncoder.hash(domain, CLAIM, { account, total, deadline });
  return new ethers.SigningKey('0x' + Buffer.from(key).toString('hex')).sign(digest).serialized;
}
async function reverts(p, name) {
  try {
    await (await p).wait();
  } catch (e) {
    const msg = String(e.shortMessage || e.message) + JSON.stringify(e.revert || {}) + String(e.data || '');
    if (name && !msg.includes(name)) {
      const iface = new ethers.Interface(art.abi);
      const data = e.data || (e.info && e.info.error && e.info.error.data);
      const parsed = data ? iface.parseError(data) : null;
      assert.equal(parsed && parsed.name, name, 'expected ' + name + ', got ' + msg.slice(0, 200));
    }
    return;
  }
  assert.fail('expected a revert' + (name ? ': ' + name : ''));
}

(async () => {
  const provider = new ethers.BrowserProvider(hre.network.provider);
  // Fresh wallets: Hardhat's well-known test accounts carry EIP-7702 delegations on live
  // Elysium (sweeper bots), so on a fork they refuse plain HYPE transfers.
  const [owner, alice, bob, carol] = Array.from({ length: 4 }, () => ethers.Wallet.createRandom().connect(provider));
  for (const w of [owner, alice, bob, carol]) await provider.send('hardhat_setBalance', [w.address, '0x' + E(100).toString(16)]);
  const now = async () => (await provider.getBlock('latest')).timestamp;
  const F = new ethers.ContractFactory(art.abi, art.bytecode, owner);
  const v = await F.deploy(await owner.getAddress(), addrOf(KEY), E(1), E(2));
  await v.waitForDeployment();
  const V = (await v.getAddress()).toLowerCase();
  await (await owner.sendTransaction({ to: V, value: E(5) })).wait();
  assert.equal(await provider.getBalance(V), E(5));

  const A = (await alice.getAddress()).toLowerCase();
  const B = (await bob.getAddress()).toLowerCase();
  const C = (await carol.getAddress()).toLowerCase();
  const dl = (await now()) + 1800;

  // a claim pays the account what its voucher allows, less what it claimed before
  const before = await provider.getBalance(A);
  const r = await (await v.connect(alice).claim(E(0.5), dl, voucher(V, A, E(0.5), dl))).wait();
  const gas = r.gasUsed * r.gasPrice;
  assert.equal((await provider.getBalance(A)) - before + gas, E(0.5));
  assert.equal(await v.claimed(A), E(0.5));
  console.log('ok  claim pays the account');

  await reverts(v.connect(alice).claim(E(0.5), dl, voucher(V, A, E(0.5), dl)), 'NothingToClaim');
  console.log('ok  the same voucher cannot pay twice');
  await reverts(v.connect(bob).claim(E(0.5), dl, voucher(V, A, E(0.5), dl)), 'BadSignature');
  console.log('ok  someone else cannot use your voucher');
  await reverts(v.connect(alice).claim(E(0.9), dl, voucher(V, A, E(0.9), dl, OTHER)), 'BadSignature');
  console.log('ok  a voucher from another key is refused');
  await reverts(v.connect(alice).claim(E(0.9), dl, voucher(V, A, E(0.6), dl)), 'BadSignature');
  console.log('ok  a voucher cannot be stretched to a bigger total');
  await reverts(v.connect(alice).claim(E(2), dl, voucher(V, A, E(2), dl)), 'OverClaimLimit');
  console.log('ok  at most maxPerClaim per claim');
  const old = (await now()) - 1;
  await reverts(v.connect(alice).claim(E(0.8), old, voucher(V, A, E(0.8), old)), 'Expired');
  console.log('ok  expired vouchers are refused');

  // daily cap across everyone: 0.5 + 1.0 paid; carol's 1.0 would go over 2
  await (await v.connect(alice).claim(E(1.5), dl, voucher(V, A, E(1.5), dl))).wait();
  await reverts(v.connect(carol).claim(E(1), dl, voucher(V, C, E(1), dl)), 'OverDailyLimit');
  assert.equal(await v.dailyLeft(), E(0.5));
  await provider.send('evm_increaseTime', [86400]);
  await provider.send('evm_mine', []);
  const dl2 = (await now()) + 1800;
  await (await v.connect(carol).claim(E(1), dl2, voucher(V, C, E(1), dl2))).wait();
  console.log('ok  daily cap, reset after a day');

  // owner controls
  await reverts(v.connect(bob).pause(), null);
  await reverts(v.connect(bob).setSigner(B), null);
  await reverts(v.connect(bob).withdraw(B, 1n), null);
  await (await v.pause()).wait();
  const dl3 = (await now()) + 1800;
  await reverts(v.connect(bob).claim(E(0.1), dl3, voucher(V, B, E(0.1), dl3)), 'EnforcedPause');
  await (await v.unpause()).wait();
  await (await v.connect(bob).claim(E(0.1), dl3, voucher(V, B, E(0.1), dl3))).wait();
  await (await v.setSigner(addrOf(OTHER))).wait();
  await reverts(v.connect(bob).claim(E(0.2), dl3, voucher(V, B, E(0.2), dl3)), 'BadSignature');
  console.log('ok  pause, new signer: old key stops working');
  const left = await provider.getBalance(V);
  await (await v.withdraw(await owner.getAddress(), left)).wait();
  assert.equal(await provider.getBalance(V), 0n);
  const dl4 = (await now()) + 1800;
  await reverts(v.connect(bob).claim(E(0.2), dl4, voucher(V, B, E(0.2), dl4, OTHER)), 'TransferFailed');
  console.log('ok  owner withdraws; an empty vault pays nothing');
  assert.equal(await v.totalClaimed(), E(2.6));
  console.log('all referral vault tests passed');
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
