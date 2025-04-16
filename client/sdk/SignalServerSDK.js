import { ethers } from "ethers";
import EthCrypto from "eth-crypto";
import wrtc from "@roamhq/wrtc";

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
  }

  async accept() {
    const pc = new wrtc.RTCPeerConnection({ iceServers: this._sdk.iceServers });

    // ─── 1) Listen for the remote channel that Alice (the offerer) created
    pc.ondatachannel = (evt) => {
      const dc = evt.channel;
      const stream = new DataStream(this.sender, dc);
      dc.onopen = () => {
        this._sdk._notifyStreamOpen(stream);
      };
    };

    // ─── 2) Collect our own ICE candidates to bundle in the answer
    const candidates = [];
    pc.onicecandidate = (evt) => {
      if (evt.candidate) candidates.push(evt.candidate);
    };

    // ─── 3) Set Alice's offer + her ICE candidates
    await pc.setRemoteDescription({ type: this.offer.type, sdp: this.offer.sdp });
    for (const c of this.offer.candidates || []) {
      await pc.addIceCandidate(c);
    }

    // ─── 4) Create and set our bundled answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // ─── 5) Wait for ICE gathering to finish
    await new Promise(res => {
      if (pc.iceGatheringState === "complete") return res();
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === "complete") res();
      };
    });

    // ─── 6) Send exactly one on‑chain answer tx
    await this._sdk._sendSignal(this.sender, {
      type:       answer.type,
      sdp:        pc.localDescription.sdp,
      candidates // bundled ICECandidateInit[]
    });
  }

  reject() { /* no-op */ }
}

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
  constructor({
    provider,
    wallet,
    encryptionIdentity,
    contractAddress,
    contractAbi,
    peerPublicKeys = {},          // ← NEW: map address→X25519 publicKey
    iceServers = [{ urls: "stun:stun.l.google.com:19302" }],
    timeoutMs  = 20000,
  }) {
    this.provider  = provider;
    this.wallet    = wallet.connect(provider);
    this.identity  = encryptionIdentity;
    this.peerPublicKeys = peerPublicKeys;    // ← store the map
    this.contract  = new ethers.Contract(contractAddress, contractAbi, provider);
    this.contractWithSigner = this.contract.connect(this.wallet);

    this.iceServers = iceServers;
    this.timeoutMs  = timeoutMs;

    this._helpCb   = null;
    this._streamCb = null;

    this._startContractListeners();
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

    // wait for on‐chain answer
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
