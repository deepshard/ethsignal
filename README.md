# ethsignal
 Uses Ethereum to signal for WebRTC connections

---

## Contract: `SignalServer.sol`

- **Event**  
  ```solidity
  event SignalSent(
    address indexed sender,
    address indexed recipient,
    bytes encryptedData
  );
  ```

- **Function**  
  ```solidity
  function sendSignal(
    address _recipient,
    bytes calldata _encryptedData
  ) external {
    require(_recipient != address(0), "Recipient cannot be zero");
    require(_encryptedData.length > 0, "Data cannot be empty");
    emit SignalSent(msg.sender, _recipient, _encryptedData);
  }
  ```

All encryption is performed off‑chain. The contract simply emits the encrypted payload.

---

## SDK: `SignalServerSDK.js`

### Key Classes

#### `SignalServerSdk`

Constructor options:
```js
new SignalServerSdk({
  wallet,                   // ethers.Wallet instance (auto‑created if omitted)
  encryptionIdentity,       // { publicKey, privateKey } from EthCrypto.createIdentity()
  peerPublicKeys,           // { [address]: x25519PublicKey } map
  provider,                 // ethers.Provider (defaults to RPC_URL/.env or localhost)
  contractAddress,          // your SignalServer address
  contractAbi,              // defaults to hard‑coded ABI
  iceServers,               // STUN/TURN servers (default: metered list)
  timeoutMs                 // ms before giving up (default: 20000)
});
```

- `onHelpRequest(cb)`  
  Register a callback to receive incoming offers. `cb` gets a `RequestForHelp` object:

  ```js
  {
    sender,      // address of the offerer
    offer,       // { type, sdp, candidates }
    timestamp,   // ms
    publicKey,   // X25519 key of the sender
    accept(),    // returns Promise<DataStream> or rejects with HelpAcceptTimeout
    reject()     // ignore the request
  }
  ```

- `onStreamOpen(cb)`  
  Fires for **any** data‑channel open, passing a `DataStream`:

  ```js
  {
    remoteAddress,           // the peer's Ethereum address
    respond(message, file),  // send JSON { message, file? }
    onMessage(cb),           // callback for incoming text
    onFile(cb)               // callback for incoming binary
  }
  ```

- `requestHelp(address)`  
  Initiates a WebRTC offer to `address`, bundles ICE candidates into one `sendSignal`, waits for the on‑chain answer, and resolves with a `DataStream`. Rejects after `timeoutMs` if no answer.

#### `DataStream`

Wraps a WebRTC `RTCDataChannel` to send/receive `{ message, file? }` JSON payloads.

---

## Running the Example

```bash
cd client
npm run simulate
```

Or directly:

```bash
node src/examples/sdk_simulate.js
```

You should see:

- Alice and Bob addresses  
- Generated X25519 public keys  
- Alice → on-chain offer → Bob auto‑accepts → WebRTC DataChannel opens → messages exchanged

---

## Running Tests

```bash
cd client
npm test
```

The test suite uses a `FakeContract` (an in‑memory `EventEmitter`) to simulate on‑chain events. It covers:

- SDK constructor validation  
- `_getPeerPubKey()` logic  
- Encryption/decryption pipeline  
- `onHelpRequest()` firing on offers  
- `requestHelp()` timeout behavior

---

## License

MIT
