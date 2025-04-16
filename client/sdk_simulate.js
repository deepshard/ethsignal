import dotenv from "dotenv";
import fs from "fs";
import { ethers } from "ethers";
import EthCrypto from "eth-crypto";
import { SignalServerSdk } from "./sdk/SignalServerSDK.js";

dotenv.config();

// --- Configuration (from your .env) ---
const RPC_URL          = process.env.RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const ALICE_PK         = process.env.ALICE_PRIVATE_KEY;
const BOB_PK           = process.env.BOB_PRIVATE_KEY;
const ABI_PATH         = "./SignalServer.json";

// Validate
if (!RPC_URL || !CONTRACT_ADDRESS || !ALICE_PK || !BOB_PK) {
  throw new Error("Missing one of RPC_URL, CONTRACT_ADDRESS, ALICE_PRIVATE_KEY, BOB_PRIVATE_KEY");
}

// Load ABI
const contractJson = JSON.parse(fs.readFileSync(ABI_PATH, "utf8"));
const CONTRACT_ABI  = contractJson.abi;

// --- Ethers + Wallets ---
const provider    = new ethers.JsonRpcProvider(RPC_URL);
const aliceWallet = new ethers.Wallet(ALICE_PK, provider);
const bobWallet   = new ethers.Wallet(BOB_PK,   provider);

console.log("On‑chain setup:");
console.log("  RPC:",      RPC_URL);
console.log("  Contract:", CONTRACT_ADDRESS);
console.log("  Alice →",   aliceWallet.address);
console.log("  Bob   →",   bobWallet.address);

// --- Encryption identities (X25519) ---
const aliceIdentity = EthCrypto.createIdentity();
const bobIdentity   = EthCrypto.createIdentity();

console.log("\nEncryption identities:");
console.log("  Alice pubKey:", aliceIdentity.publicKey);
console.log("  Bob   pubKey:", bobIdentity.publicKey);

// --- TURN only (no STUN) ---
const ICE_SERVERS = [
  {
    urls:       "turn:localhost:3478",
    username:   "testuser",
    credential: "testpass"
  }
];

async function main() {
  // build a true address→publicKey map
  const aliceToBobMap = { [bobWallet.address]: bobIdentity.publicKey };
  const bobToAliceMap = { [aliceWallet.address]: aliceIdentity.publicKey };

  // --- Instantiate two SDKs ---
  const sdkAlice = new SignalServerSdk({
    provider,
    wallet: aliceWallet,
    encryptionIdentity: aliceIdentity,
    peerPublicKeys: aliceToBobMap,
    contractAddress: CONTRACT_ADDRESS,
    contractAbi: CONTRACT_ABI,
    iceServers: ICE_SERVERS,
    timeoutMs: 20000,  // 20s
  });

  const sdkBob = new SignalServerSdk({
    provider,
    wallet: bobWallet,
    encryptionIdentity: bobIdentity,
    peerPublicKeys: bobToAliceMap,
    contractAddress: CONTRACT_ADDRESS,
    contractAbi: CONTRACT_ABI,
    iceServers: ICE_SERVERS,
    timeoutMs: 20000,
  });

  // ─────────────────────────────────────────────────────────────────  
  // 1) Inject a very simple queue into each SDK so _sendSignal
  //    and _sendCandidate are never called in parallel with the same wallet
  function addSendQueue(sdk) {
    const origSignal    = sdk._sendSignal.bind(sdk);
    const origCandidate = sdk._sendCandidate.bind(sdk);
    let queue = Promise.resolve();
    sdk._sendSignal = (to, desc) => {
      queue = queue.then(() => origSignal(to, desc));
      return queue;
    };
    sdk._sendCandidate = (to, cand) => {
      queue = queue.then(() => origCandidate(to, cand));
      return queue;
    };
  }
  addSendQueue(sdkAlice);
  addSendQueue(sdkBob);
  // ─────────────────────────────────────────────────────────────────  

  // --- Bob auto‑accepts any help request ---
  sdkBob.onHelpRequest(async (req) => {
    console.log(`\n[Bob SDK] Help requested by ${req.sender}`);
    console.log(`  • timestamp:   ${new Date(req.timestamp).toISOString()}`);
    console.log(`  • offer SDP:   ${req.offer.sdp}`);
    console.log(`  • publicKey:   ${req.publicKey}`);
    await req.accept();
    console.log("[Bob SDK] Sent answer, waiting for stream…");
  });

  // --- Both sides listen for stream open and wire up message/file handlers ---
  sdkAlice.onStreamOpen((stream) => {
    console.log(`\n[Alice SDK] Data‑channel open with ${stream.remoteAddress}`);
    stream.onMessage(msg => console.log(`[Alice SDK] got message:`, msg));
    stream.onFile(buf => console.log(`[Alice SDK] got file (${buf.length} bytes)`));
  });
  sdkBob.onStreamOpen((stream) => {
    console.log(`\n[Bob SDK] Data‑channel open with ${stream.remoteAddress}`);
    stream.onMessage(async (msg) => {
      console.log(`[Bob SDK] got message:`, msg);
      // reply once Bob sees Alice's first hello
      await stream.respond("Hi Alice, got your message! -Bob");
    });
    stream.onFile(buf => console.log(`[Bob SDK] got file (${buf.length} bytes)`));
  });

  // ─────────────────────────────────────────────────────────────────  
  // 2) Now "await" the help request instead of fire‐and‐forget .then(…)
  console.log(`\n[Alice SDK] Requesting help…`);
  try {
    const stream = await sdkAlice.requestHelp(bobWallet.address);
    console.log("[Alice SDK] Help accepted, sending greeting…");
    await stream.respond("Hello Bob, this is Alice via WebRTC!");
  } catch (err) {
    console.error("[Alice SDK] Help request timed out:", err);
  }
  // ─────────────────────────────────────────────────────────────────  

  // Keep the process alive to allow async callbacks to flow
  console.log("\n--- Simulation running; press Ctrl+C to exit after a minute ---\n");
  await new Promise(r => setTimeout(r, 60_000));
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal error in simulation:", err);
  process.exit(1);
});
