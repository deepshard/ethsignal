import { ethers } from "ethers";
import EthCrypto from "eth-crypto";
import wrtc from "@roamhq/wrtc";
import dotenv from "dotenv";
dotenv.config();

/**
 * DataStream wraps a WebRTC data‑channel, enforcing
 * { message: string, file?: Uint8Array } shape
 */
class DataStream {
  constructor(remoteAddress, dataChannel) {
    this.remoteAddress = remoteAddress;
    this._dc = dataChannel;
    this._messageHandlers = [];
    this._fileHandlers = [];

    this._dc.onmessage = (ev) => {
      try {
        const { message, file } = JSON.parse(ev.data);
        if (message != null) this._messageHandlers.forEach(cb => cb(message));
        if (file) {
          const buf = Buffer.from(file, "base64");
          this._fileHandlers.forEach(cb => cb(buf));
        }
      } catch (err) {
        console.warn("[DataStream] invalid payload", err);
      }
    };
  }

  // send a JSON‐string payload over the channel
  respond(message, file) {
    const p = { message };
    if (file) p.file = Buffer.from(file).toString("base64");
    this._dc.send(JSON.stringify(p));
  }

  onMessage(cb) { this._messageHandlers.push(cb); }
  onFile(cb)    { this._fileHandlers.push(cb);   }
}

/**
 * Represents an incoming help‑request (i.e. an on‑chain offer).
 * You must call .accept() (which sends an answer & opens the link)
 * or .reject() to ignore it.
 */
class RequestForHelp {
  constructor(sdk, sender, offer) {
    this._sdk      = sdk;
    this.sender    = sender;
    this.offer     = offer;      // { type, sdp, candidates }
    this.timestamp = Date.now();

    // so you know which key to use when encrypting your answer
    this.publicKey = sdk._getPeerPubKey(sender);
  }

  async accept() {
    // create a peer‑connection for the answer
    const pc = new wrtc.RTCPeerConnection({ iceServers: this._sdk.iceServers });

    // we'll return this once the data‑channel is open
    let resolveStream, rejectStream;
    const p2pPromise = new Promise((res, rej) => {
      resolveStream = res;
      rejectStream  = rej;
    });

    // 1) listen for the DataChannel that Alice created
    pc.ondatachannel = (evt) => {
      const dc = evt.channel;
      const stream = new DataStream(this.sender, dc);
      dc.onopen = () => {
        clearTimeout(timeout);
        this._sdk._notifyStreamOpen(stream);
        resolveStream(stream);
      };
    };

    // 2) gather our ICE candidates
    const candidates = [];
    pc.onicecandidate = (evt) => {
      if (evt.candidate) candidates.push(evt.candidate);
    };

    // 3) set Alice's offer
    await pc.setRemoteDescription({ type: this.offer.type, sdp: this.offer.sdp });
    for (const c of this.offer.candidates || []) {
      await pc.addIceCandidate(c);
    }

    // 4) create & set our answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // 5) wait for ICE gathering to finish
    await new Promise(res => {
      if (pc.iceGatheringState === "complete") return res();
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === "complete") res();
      };
    });

    // 6) send exactly one on‑chain answer
    await this._sdk._sendSignal(this.sender, {
      type:       answer.type,
      sdp:        pc.localDescription.sdp,
      candidates
    });

    // 7) enforce a timeout for the data‑channel open
    const timeout = setTimeout(() => {
      pc.close();
      rejectStream(new Error("HelpAcceptTimeout"));
    }, this._sdk.timeoutMs);

    return p2pPromise;
  }

  reject() { /* no‑op */ }
}

// ─── DEFAULTS ────────────────────────────────────────────────────────
// Hard‑coded ABI for SignalServer
const DEFAULT_CONTRACT_ABI = [
  {
    type: "function",
    name: "sendSignal",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_recipient", type: "address" },
      { name: "_encryptedData", type: "bytes" },
    ],
  },
  {
    type: "event",
    name: "SignalSent",
    anonymous: false,
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "encryptedData", type: "bytes", indexed: false },
    ],
  },
];

// Default JSON‑RPC (take from .env or fall back to localhost)
const DEFAULT_PROVIDER = new ethers.JsonRpcProvider(
  process.env.RPC_URL || "http://localhost:8545"
);

// SignalServer address comes from .env
const DEFAULT_CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
if (!DEFAULT_CONTRACT_ADDRESS) {
  throw new Error(
    "SignalServerSdk: missing CONTRACT_ADDRESS in .env"
  );
}

// Metered STUN/TURN list
const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.relay.metered.ca:80" },
  { urls: "turn:global.relay.metered.ca:80", username: "2bfc0400157f3c5d6af0de73", credential: "XvWgF3CnBaSgbcvH" },
  { urls: "turn:global.relay.metered.ca:80?transport=tcp", username: "2bfc0400157f3c5d6af0de73", credential: "XvWgF3CnBaSgbcvH" },
  { urls: "turn:global.relay.metered.ca:443", username: "2bfc0400157f3c5d6af0de73", credential: "XvWgF3CnBaSgbcvH" },
  { urls: "turns:global.relay.metered.ca:443?transport=tcp", username: "2bfc0400157f3c5d6af0de73", credential: "XvWgF3CnBaSgbcvH" },
];
// ────────────────────────────────────────────────────────────────────

/**
 * The main SDK class.
 *
 * Usage:
 *   const sdk = new SignalServerSdk({
 *     provider,
 *     wallet,                   // ethers.Wallet instance
 *     encryptionIdentity,       // { publicKey, privateKey } from EthCrypto.createIdentity()
 *     contractAddress,
 *     contractAbi: SignalAbi,
 *     iceServers?: [...],       // optional, defaults to Google STUN
 *     timeoutMs?: 20000         // optional, in ms
 *   });
 *
 *   // 1) hook for incoming help‐requests
 *   sdk.onHelpRequest(req => {
 *     console.log("got help request from", req.sender, "at", req.timestamp);
 *     // either:
 *     req.accept();   // spins up answer + DATA‐channel
 *     // or
 *     // req.reject();
 *   });
 *
 *   // 2) hook for when *any* data‐channel opens
 *   sdk.onStreamOpen(stream => {
 *     console.log("P2P link open with", stream.remoteAddress);
 *     stream.onMessage(msg => console.log("got msg", msg));
 *     stream.onFile(fileBuf => {});
 *     stream.respond("hello back!");
 *   });
 *
 *   // 3) request help from someone
 *   sdk.requestHelp(theirAddress)
 *      .then(stream => {
 *        console.log("help accepted, P2P link open!");
 *        stream.respond("Thanks!");
 *      })
 *      .catch(err => console.error("no response / timed out", err));
 */
export class SignalServerSdk {
  // allow injecting a contract instance (e.g. FakeContract) and auto‑attach listeners
  get contract() {
    return this._contract;
  }
  set contract(c) {
    this._contract = c;
    this._startContractListeners();
  }

  /**
   * @param {object} opts
   * @param {ethers.Wallet} [opts.wallet]            – if omitted, one is created
   * @param {object}        opts.peerPublicKeys      – { address: x25519PubKey }
   * @param {object} [opts.encryptionIdentity]        – if omitted, one is generated
   * @param {ethers.Provider} [opts.provider]         – defaults to local
   * @param {string}          [opts.contractAddress] – your SignalServer
   * @param {array}           [opts.contractAbi]     – hard‑coded ABI
   * @param {array}           [opts.iceServers]      – defaults to Metered list
   * @param {number}          [opts.timeoutMs]       – defaults to 20000 ms
   */
  constructor({
    wallet,
    peerPublicKeys,
    encryptionIdentity,
    provider         = DEFAULT_PROVIDER,
    contractAddress  = DEFAULT_CONTRACT_ADDRESS,
    contractAbi      = DEFAULT_CONTRACT_ABI,
    iceServers       = DEFAULT_ICE_SERVERS,
    timeoutMs        = 20000,    // shortened for test timeouts
  }) {
    if (!peerPublicKeys || Object.keys(peerPublicKeys).length === 0) {
      throw new Error("SignalServerSdk: peerPublicKeys map is required");
    }

    // 1) Wallet & signer
    this.wallet = wallet || ethers.Wallet.createRandom();
    this.signer = this.wallet.connect(provider);

    // 2) Provider + contract (setter will auto‑attach listeners)
    this.contract           = new ethers.Contract(contractAddress, contractAbi, provider);
    this.contractWithSigner = this.contract.connect(this.signer);

    // 3) Encryption identity + peer keys
    this.identity        = encryptionIdentity || EthCrypto.createIdentity();
    this.peerPublicKeys  = peerPublicKeys;

    // 4) Defaults
    this.iceServers = iceServers;
    this.timeoutMs  = timeoutMs;

    // 5) Callbacks
    this._helpCb   = null;
    this._streamCb = null;
  }

  // PUBLIC API --------------------------------------------------------

  onHelpRequest(cb) { this._helpCb = cb; }
  onStreamOpen(cb) { this._streamCb = cb; }

  /**
   * Initiate a help‐request to `toAddr`.  Returns a promise
   * that resolves with a DataStream once the P2P link opens,
   * or rejects after timeoutMs if nobody answers.
   */
  async requestHelp(toAddr) {
    const pc = new wrtc.RTCPeerConnection({ iceServers: this.iceServers });
    const dc = pc.createDataChannel("chat");

    // collect local candidates
    const candidates = [];
    pc.onicecandidate = (evt) => {
      if (evt.candidate) candidates.push(evt.candidate);
    };

    // resolve when DC opens
    let resolveStream, rejectStream;
    const p2pPromise = new Promise((res, rej) => { resolveStream = res; rejectStream = rej; });
    dc.onopen = () => {
      const stream = new DataStream(toAddr, dc);
      this._notifyStreamOpen(stream);
      resolveStream(stream);
    };

    // create offer & set local
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // wait ICE gathering complete
    await new Promise((res) => {
      if (pc.iceGatheringState === "complete") return res();
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === "complete") res();
      };
    });

    // bundle and send one tx
    await this._sendSignal(toAddr, {
      type:       offer.type,
      sdp:        pc.localDescription.sdp,
      candidates // array of ICECandidateInit
    });

    // wait for on‑chain answer
    const filter = this.contract.filters.SignalSent(toAddr, this.wallet.address);
    const onAnswer = async (...args) => {
      const ev         = args[args.length - 1];
      const enc        = ev.args.encryptedData;
      if (!enc) return;
      const ct2        = ethers.toUtf8String(enc);
      const dec2       = await EthCrypto.decryptWithPrivateKey(
        this.identity.privateKey,
        EthCrypto.cipher.parse(ct2)
      );
      const msgAnswer  = JSON.parse(dec2);
      if (msgAnswer.type === "answer") {
        await pc.setRemoteDescription({ type: msgAnswer.type, sdp: msgAnswer.sdp });
        for (const c of msgAnswer.candidates || []) {
          await pc.addIceCandidate(c);
        }
      }
    };
    this.contract.once(filter, onAnswer);

    // timeout
    setTimeout(() => {
      this.contract.off(filter, onAnswer);
      rejectStream(new Error("HelpResponseTimeout"));
    }, this.timeoutMs);

    return p2pPromise;
  }

  // INTERNALS ---------------------------------------------------------

  _startContractListeners() {
    const filter = this.contract.filters.SignalSent(null, this.wallet.address);
    this.contract.on(filter, async (...args) => {
      const event = args[args.length - 1];
      const { sender, encryptedData } = event.args;
      if (!encryptedData) return;

      // decrypt & JSON.parse …
      const ct        = ethers.toUtf8String(encryptedData);
      const decrypted = await EthCrypto.decryptWithPrivateKey(
        this.identity.privateKey,
        EthCrypto.cipher.parse(ct)
      );
      const msg = JSON.parse(decrypted);

      if (msg.type === "offer" && this._helpCb) {
        // msg has { type, sdp, candidates }
        const req = new RequestForHelp(this, sender, msg);
        this._helpCb(req);
      }
      // ignore other types here
    });
  }

  /** low‑level send of an offer/answer object */
  async _sendSignal(to, descObj) {
    // descObj must have a `.type` field (offer|answer)
    const json = JSON.stringify(descObj);
    const encrypted = await EthCrypto.encryptWithPublicKey(this._getPeerPubKey(to), json);
    const str = EthCrypto.cipher.stringify(encrypted);
    const data = ethers.toUtf8Bytes(str);
    const tx = await this.contractWithSigner.sendSignal(to, data);
    await tx.wait();
  }

  /** low‑level send of a single ICE candidate object */
  async _sendCandidate(to, candidateObj) {
    const json = JSON.stringify(candidateObj);
    const encrypted = await EthCrypto.encryptWithPublicKey(this._getPeerPubKey(to), json);
    const str = EthCrypto.cipher.stringify(encrypted);
    const data = ethers.toUtf8Bytes(str);
    const tx = await this.contractWithSigner.sendSignal(to, data);
    await tx.wait();
  }

  /** lookup the X25519 public key for a given address */
  _getPeerPubKey(addr) {
    const pk = this.peerPublicKeys[addr];
    if (!pk) {
      throw new Error(`SignalServerSdk: no public key for peer ${addr}`);
    }
    return pk;
  }

  _notifyStreamOpen(stream) {
    if (this._streamCb) this._streamCb(stream);
  }
}
