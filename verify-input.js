'use strict';
// Writes out/verify/standard-input.json: the solc Standard JSON input Homer's contracts were
// built from (every src/*.sol plus each imported file, with build.js's exact settings). Upload it
// on a Blockscout explorer ("Verify & publish" -> "Solidity (Standard JSON input)", compiler
// v0.8.28+commit.7893614a) to verify any deployed Homer contract. The script re-compiles the
// file on its own and checks the result matches out/*.json before writing it.
//   node scripts/verify-input.js
const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const sources = {};
for (const f of fs.readdirSync(SRC)) if (f.endsWith('.sol')) sources[f] = { content: fs.readFileSync(path.join(SRC, f), 'utf8') };

const settings = {
  evmVersion: 'shanghai',
  viaIR: true,
  optimizer: { enabled: true, runs: 200 },
  metadata: { bytecodeHash: 'none' },
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
};

// First pass: collect every imported file the compiler asks for.
const imported = {};
function findImports(p) {
  try {
    const contents = fs.readFileSync(require.resolve(p, { paths: [ROOT] }), 'utf8');
    imported[p] = { content: contents };
    return { contents };
  } catch {
    return { error: 'not found: ' + p };
  }
}
solc.compile(JSON.stringify({ language: 'Solidity', sources, settings }), { import: findImports });

const input = { language: 'Solidity', sources: { ...sources, ...imported }, settings };

// Second pass: the file alone (no import callback) must rebuild the same bytecode.
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
if (errors.length) { for (const e of errors) console.error(e.formattedMessage); process.exit(1); }
for (const f of fs.readdirSync(path.join(ROOT, 'out')).filter((x) => x.endsWith('.json'))) {
  const art = JSON.parse(fs.readFileSync(path.join(ROOT, 'out', f), 'utf8'));
  const c = out.contracts[art.contractName + '.sol'] && out.contracts[art.contractName + '.sol'][art.contractName];
  if (!c || '0x' + c.evm.deployedBytecode.object !== art.deployedBytecode) { console.error('MISMATCH', art.contractName); process.exit(1); }
}

fs.mkdirSync(path.join(ROOT, 'out', 'verify'), { recursive: true });
const file = path.join(ROOT, 'out', 'verify', 'standard-input.json');
fs.writeFileSync(file, JSON.stringify(input));
console.log('wrote', path.relative(process.cwd(), file), `(${Object.keys(input.sources).length} sources, solc ${solc.version()})`);
