'use strict';
// Fresh funded wallets for fork tests. Hardhat's well-known test accounts carry EIP-7702
// delegations on live Elysium (sweeper bots), so on a fork they refuse plain HYPE transfers:
// tests use new random wallets instead, each given 10,000 HYPE.
const { ethers } = require('ethers');

async function freshSigners(provider, n) {
  const ws = Array.from({ length: n }, () => ethers.Wallet.createRandom().connect(provider));
  for (const w of ws) await provider.send('hardhat_setBalance', [w.address, '0x' + ethers.parseEther('10000').toString(16)]);
  return ws;
}

module.exports = { freshSigners };
