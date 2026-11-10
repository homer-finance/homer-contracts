// Fork of Elysium for scripts/fork-test.js. Hardhat's EVM cannot fork Elysium headers under
// Cancun, so tests (and the build) target Shanghai, which Elysium supports.
module.exports = {
  networks: {
    hardhat: {
      chainId: 99901,
      forking: {
        url: process.env.FORK_URL || 'https://rpc.elysium.kinetiq.xyz',
        ...(process.env.FORK_BLOCK ? { blockNumber: Number(process.env.FORK_BLOCK) } : {}),
      },
      chains: { 99901: { hardforkHistory: { shanghai: 0 } } },
      hardfork: 'shanghai',
    },
  },
};
