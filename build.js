'use strict';
// Compiles src/*.sol with solc-js and writes out/<Name>.json { abi, bytecode, deployedBytecode, ... }.
const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');

const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'out');
const NAMES = ['HomerLiquidityManager', 'HomerStaking', 'HomerToken', 'HomerFeeRouter', 'HomerSwap', 'HomerV4Manager', 'HomerPoolHook', 'HomerReferralVault'];

const sources = {};
for (const f of fs.readdirSync(SRC)) if (f.endsWith('.sol')) sources[f] = { content: fs.readFileSync(path.join(SRC, f), 'utf8') };

const settings = {
  evmVersion: 'shanghai',
  viaIR: true,
  optimizer: { enabled: true, runs: 200 },
  metadata: { bytecodeHash: 'none' },
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
};

function findImports(p) {
  try {
    return { contents: fs.readFileSync(require.resolve(p, { paths: [__dirname] }), 'utf8') };
  } catch {
    return { error: 'not found: ' + p };
  }
}

const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings }), { import: findImports }));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
for (const e of out.errors || []) console[e.severity === 'error' ? 'error' : 'warn'](e.formattedMessage);
if (errors.length) process.exit(1);

fs.mkdirSync(OUT, { recursive: true });
for (const name of NAMES) {
  const c = out.contracts[name + '.sol'][name];
  const art = {
    contractName: name,
    compiler: solc.version(),
    settings: { evmVersion: settings.evmVersion, viaIR: true, optimizer: settings.optimizer },
    abi: c.abi,
    bytecode: '0x' + c.evm.bytecode.object,
    deployedBytecode: '0x' + c.evm.deployedBytecode.object,
  };
  fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(art, null, 1) + '\n');
  console.log(name.padEnd(24), (c.evm.deployedBytecode.object.length / 2) + ' bytes runtime');
}
