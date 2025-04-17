import { expect } from "chai";
import { EventEmitter } from "events";
import { ethers } from "ethers";
import EthCrypto from "eth-crypto";
import { SignalServerSdk } from "../src/sdk/SignalServerSDK.js";

class FakeContract extends EventEmitter {
  constructor() {
    super();
    // our SDK will call this.contract.filters.SignalSent(sender, recipient)
    this.filters = {
      SignalSent: (sender, recipient) => "SignalSent:" + sender + ":" + recipient
    };
  }

  // when SDK does contract.connect(signer), just remember the signer address
  connect(signer) {
    this._sender = signer.address;
    return this;
  }

  // SDK calls contractWithSigner.sendSignal(to, data)
  sendSignal(to, data) {
    // fire the matching event _next tick_ so any .on() is already hooked
    process.nextTick(() => {
      this.emit(
        this.filters.SignalSent(this._sender, to),
        // pass exactly what ethers-v6 would pass:
        this._sender,       // sender
        to,                 // recipient
        data,               // encryptedData
        {                   // last arg is Event object
          args: { sender: this._sender, recipient: to, encryptedData: data }
        }
      );
    });
    // return a "tx" with a wait() method
    return {
      wait: () => Promise.resolve({ hash: "0xFAKE_TX_HASH" })
    };
  }

  // wire up .on(filter, listener) and .once(...)
  on(filter, listener)   { super.on(filter, listener); }
  once(filter, listener) { super.once(filter, listener); }
  off(filter, listener)  { super.removeListener(filter, listener); }
}

describe("SignalServerSdk", () => {
  let aliceWallet, bobWallet;
  let aliceIdentity, bobIdentity;
  let aliceSdk, bobSdk, fakeContract;

  beforeEach(() => {
    // 1) Fresh wallets & identities
    aliceWallet   = ethers.Wallet.createRandom();
    bobWallet     = ethers.Wallet.createRandom();
    aliceIdentity = EthCrypto.createIdentity();
    bobIdentity   = EthCrypto.createIdentity();

    // 2) Build SDKs pointing at our FakeContract
    fakeContract  = new FakeContract();

    aliceSdk = new SignalServerSdk({
      wallet:              aliceWallet,
      encryptionIdentity:  aliceIdentity,
      peerPublicKeys:      { [bobWallet.address]: bobIdentity.publicKey },
      // we override provider/contract below
    });
    bobSdk   = new SignalServerSdk({
      wallet:              bobWallet,
      encryptionIdentity:  bobIdentity,
      peerPublicKeys:      { [aliceWallet.address]: aliceIdentity.publicKey },
    });

    // 3) Stub out the on-chain contract in both SDKs
    [aliceSdk, bobSdk].forEach((sdk) => {
      sdk.contract            = fakeContract;
      sdk.contractWithSigner  = fakeContract.connect(sdk.wallet);
    });
  });

  it("throws if peerPublicKeys map is empty", () => {
    expect(() => {
      new SignalServerSdk({ peerPublicKeys: {} });
    }).to.throw("peerPublicKeys map is required");
  });

  it("getPeerPubKey() returns the right key or throws", () => {
    // happy path
    expect(aliceSdk._getPeerPubKey(bobWallet.address))
      .to.equal(bobIdentity.publicKey);

    // missing address
    expect(() => aliceSdk._getPeerPubKey(ethers.ZeroAddress))
      .to.throw("no public key for peer");
  });

  it("can encrypt & decrypt a simple object via EthCrypto + ethers", async () => {
    const payload = { foo: "bar", x: 42 };
    const clear    = JSON.stringify(payload);

    // Alice → Bob
    const encrypted = await EthCrypto.encryptWithPublicKey(
      bobIdentity.publicKey, clear
    );
    const str       = EthCrypto.cipher.stringify(encrypted);
    const data      = ethers.toUtf8Bytes(str);

    // Bob side: unwrap
    const fromChain = ethers.toUtf8String(data);
    const parsed    = EthCrypto.cipher.parse(fromChain);
    const decrypted = await EthCrypto.decryptWithPrivateKey(
      bobIdentity.privateKey, parsed
    );
    expect(JSON.parse(decrypted)).to.deep.equal(payload);
  });

  it("fires onHelpRequest() when an offer is signaled on-chain", (done) => {
    // Bob registers a help-request handler
    bobSdk.onHelpRequest((req) => {
      expect(req.sender).to.equal(aliceWallet.address);
      expect(req.offer.type).to.equal("offer");
      expect(req.offer.sdp).to.be.a("string");
      done();
    });

    // Alice pushes an "offer" on-chain
    aliceSdk._sendSignal(bobWallet.address, {
      type: "offer",
      sdp:  "THIS_IS_SDP",
      candidates: []
    }).catch(done);
  });

  it("requestHelp() times out if nobody answers", async () => {
    // We do not call req.accept() in Bob, so Alice should time out
    try {
      await aliceSdk.requestHelp(bobWallet.address);
      throw new Error("should have timed out");
    } catch (err) {
      expect(err.message).to.equal("HelpResponseTimeout");
    }
  });
});
