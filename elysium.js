'use strict';
// Elysium's DEX contracts as Homer's website lists them (Nov 2026): Uniswap-v3-style factories,
// Uniswap-v4-style PoolManagers, wrapped-HYPE contracts and v2 launchpads. HomerSwap was deployed
// with these lists (see VERIFY.md for its constructor arguments).
module.exports = {
  "venues": [
    "0x809ff79945fffbf9b8df33bb3b62872ceb2efaf1",
    "0x367f85886af509e364c8190862bc714555fefc3e",
    "0xe83aabbd2e326ceaae3bdcb605b3af94ac3cf883",
    "0xd5a7c10820446c58868a204b8979b8cc9cb2a1a3",
    "0x4f66184a9ffabb7f7071d590c2c48dedf41676f4",
    "0x24e21e3f2b0bb0c166ec3eaff1e615ab14cdd85f"
  ],
  "v4Managers": [
    "0xb308b5df891c300a5f5a5b8fdbc30108ba842490",
    "0x06c63714fbf1f5753017123e2fcfdede4540b2c4",
    "0x5fb015a49f5b35073f9ce01c2adb287a75f89600",
    "0x3564d7defdb26abe3f0953ee57d93953ec94fa25",
    "0x5c54a7293d96b11a29a0256ee8dfdbc3059637da",
    "0xeef19ba12957efaa08a2769a47660c9665b972df",
    "0xe2e105d3f7209a9da11f83ccf3e7398a753823f1"
  ],
  "whype": [
    "0x0269031ace34a7821e9d9980d087c35ce7c19eef",
    "0xba876237b0f021a6c6d852d6c26e107997cc5e81",
    "0xa27c79491bac6e20e2b18c0b21feb8dedd8caa41",
    "0xaeb7ede82165bb12ea5c0c80ce8c0a0d05bce6af",
    "0x9f041fad8323d7c5bf8f928aade05b610df34b64"
  ],
  "v2Pads": {
    "0x51d9243d87ad13d7eca55ab57357b2b5fc8241f2": {
      "name": "Obol",
      "feePips": 10000
    },
    "0x84941cb4495ff9c79af81ebcd46124809e65f7ec": {
      "name": "Obol",
      "feePips": 10000
    },
    "0x7d1904bfb2472a0ef97d886139a4236060e064ab": {
      "name": "Obol",
      "feePips": 10000
    }
  }
};
