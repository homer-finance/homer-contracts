module.exports = {
  networks: {
    hardhat: {
      chainId: 99901,
      forking: { url: process.env.FORK_URL || 'https://rpc.elysium.kinetiq.xyz', ...(process.env.FORK_BLOCK ? { blockNumber: Number(process.env.FORK_BLOCK) } : {}) },
      chains: { 99901: { hardforkHistory: { cancun: 0 } } },
      hardfork: 'cancun',
    },
  },
};
