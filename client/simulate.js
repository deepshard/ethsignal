// interact.js
import { ethers } from "ethers";
import EthCrypto from "eth-crypto";
import dotenv from "dotenv";
import fs from "fs"; // To read the ABI file

dotenv.config(); // Load .env variables

// --- Configuration ---
const config = {
    rpcUrl: process.env.RPC_URL,
    contractAddress: process.env.CONTRACT_ADDRESS,
    alicePk: process.env.ALICE_PRIVATE_KEY,
    bobPk: process.env.BOB_PRIVATE_KEY,
    // Load ABI from the JSON file
    contractAbi: JSON.parse(fs.readFileSync("./SignalServer.json", "utf8")).abi,
};

if (
    !config.rpcUrl ||
    !config.contractAddress ||
    !config.alicePk ||
    !config.bobPk ||
    !config.contractAbi
) {
    throw new Error("Missing environment variables or ABI file!");
}

// --- Ethers Setup ---
const provider = new ethers.JsonRpcProvider(config.rpcUrl);
const aliceWallet = new ethers.Wallet(config.alicePk, provider);
const bobWallet = new ethers.Wallet(config.bobPk, provider);

const signalContract = new ethers.Contract(
    config.contractAddress,
    config.contractAbi,
    provider // Start with provider, connect wallet later for sending txs
);

console.log(`SignalServer Contract Address: ${config.contractAddress}`);
console.log(`Alice Address: ${aliceWallet.address}`);
console.log(`Bob Address: ${bobWallet.address}\n`);

// --- Encryption Key Pairs (Separate from Wallet Keys) ---
// Let eth-crypto generate random identities for encryption/decryption
console.log("Generating encryption key pairs...");
const aliceEncryptionIdentity = EthCrypto.createIdentity();
const bobEncryptionIdentity = EthCrypto.createIdentity();

console.log("Encryption Keys Generated:");
console.log(`  Alice Enc PubKey: ${aliceEncryptionIdentity.publicKey}`);
console.log(`  Bob Enc PubKey: ${bobEncryptionIdentity.publicKey}`);

// --- Helper Functions ---
async function encryptMessage(recipientPublicKey, message) {
    const encrypted = await EthCrypto.encryptWithPublicKey(
        recipientPublicKey,
        message // eth-crypto handles Buffer conversion
    );
    // Convert the encrypted object to a string format suitable for sending
    return EthCrypto.cipher.stringify(encrypted);
}

async function decryptMessage(recipientPrivateKey, encryptedString) {
    const encryptedObject = EthCrypto.cipher.parse(encryptedString);
    return await EthCrypto.decryptWithPrivateKey(
        recipientPrivateKey,
        encryptedObject
    );
}

// Convert stringified encrypted data (like from event) to bytes format for contract
function encryptedStringToBytes(encryptedString) {
    // eth-crypto string format includes parts like iv, ephemPublicKey, mac, ciphertext
    // For simplicity here, we'll just send the ciphertext part as bytes
    // NOTE: A robust implementation might JSON.stringify the whole object or use a specific encoding.
    // Here we make a simplification assuming the essential part is the ciphertext hex.
    const encryptedObject = EthCrypto.cipher.parse(encryptedString);
    return "0x" + encryptedObject.ciphertext; // Return as 0x-prefixed hex string
}

// Import WebRTC libraries if needed (for Node.js, you might use a library like 'wrtc')
import wrtc from '@roamhq/wrtc'; // Updated to use @roamhq/wrtc // For Node.js WebRTC (if not in browser)

console.log("WebRTC simulation starting...");

// Alice's RTCPeerConnection
const alicePeerConnection = new wrtc.RTCPeerConnection({
    iceServers: [
        { 
            urls: 'turn:localhost:3478',
            username: 'testuser',
            credential: 'testpass'
        }
    ]
});

// Bob's RTCPeerConnection
const bobPeerConnection = new wrtc.RTCPeerConnection({
    iceServers: [
        { 
            urls: 'turn:localhost:3478',
            username: 'testuser',
            credential: 'testpass'
        }
    ]
});

// --- Helper Functions for WebRTC ---
let aliceSendQueue = Promise.resolve();

async function handleAliceICECandidate(event) {
    if (!event.candidate) return;

    // prepare your data exactly as before
    const candidateJson = JSON.stringify(event.candidate);
    const encrypted   = await encryptMessage(bobEncryptionIdentity.publicKey, candidateJson);
    const bytes       = ethers.toUtf8Bytes(encrypted);

    // chain on to the queue
    aliceSendQueue = aliceSendQueue
        .then(() => {
            console.log("[Alice INFO] Sending ICE candidate to Bob…");
            return signalContract
                .connect(aliceWallet)
                .sendSignal(bobWallet.address, bytes);
        })
        .then(tx => tx.wait())
        .then(tx => {
            console.log(`[Alice INFO] ICE candidate sent! Tx: ${tx.hash}`);
        })
        .catch(err => {
            console.error("[Alice ERROR] failed to send ICE candidate:", err);
        });
}

async function handleBobICECandidate(event) {
    if (event.candidate) {
        console.log("[Bob INFO] Sending ICE candidate to Alice...");
        const candidateData = JSON.stringify(event.candidate);
        const encryptedCandidate = await encryptMessage(
            aliceEncryptionIdentity.publicKey,
            candidateData
        );
        const candidateBytes = ethers.toUtf8Bytes(encryptedCandidate);
        const tx = await signalContract
            .connect(bobWallet)
            .sendSignal(aliceWallet.address, candidateBytes);
        await tx.wait();
        console.log(`[Bob INFO] ICE candidate sent! Tx: ${tx.hash}`);
    }
}

// Setup ICE candidate listeners and connection state logging
alicePeerConnection.onicecandidate = handleAliceICECandidate;
bobPeerConnection.onicecandidate = handleBobICECandidate;

// Log connection and ICE gathering state changes for debugging
alicePeerConnection.onconnectionstatechange = () => {
    console.log(`[Alice INFO] Connection state: ${alicePeerConnection.connectionState}`);
};
alicePeerConnection.onicegatheringstatechange = () => {
    console.log(`[Alice INFO] ICE gathering state: ${alicePeerConnection.iceGatheringState}`);
};
alicePeerConnection.onicecandidateerror = (event) => {
    console.error(`[Alice ERROR] ICE candidate error: ${event.errorText} (Code: ${event.errorCode})`);
};
bobPeerConnection.onconnectionstatechange = () => {
    console.log(`[Bob INFO] Connection state: ${bobPeerConnection.connectionState}`);
};
bobPeerConnection.onicegatheringstatechange = () => {
    console.log(`[Bob INFO] ICE gathering state: ${bobPeerConnection.iceGatheringState}`);
};
bobPeerConnection.onicecandidateerror = (event) => {
    console.error(`[Bob ERROR] ICE candidate error: ${event.errorText} (Code: ${event.errorCode})`);
};

// --- Simulation Logic with WebRTC ---
async function runSimulation() {
    console.log("--- Starting WebRTC Simulation ---");

    // --- Setup Listeners ---
    console.log("Setting up listeners...");

    // Bob listens for messages addressed to him
    const bobFilter = signalContract.filters.SignalSent(
        null, // Any sender
        bobWallet.address // Recipient is Bob
    );

    signalContract.on(bobFilter, async (event) => {
        console.log(`\n[Bob INFO] Received event:`);
        // Access event arguments via event.args array
        const sender = event.args[0];
        const recipient = event.args[1];
        const encryptedData = event.args[2];
        console.log(`   From: ${sender}`);
        console.log(`   To: ${recipient}`);
        console.log(`   Raw Encrypted Data: ${encryptedData}`);

        try {
            const receivedString = ethers.toUtf8String(encryptedData);
            const decryptedMessage = await decryptMessage(
                bobEncryptionIdentity.privateKey,
                receivedString
            );
            console.log(`\n[Bob DECRYPTED] Message from ${sender}: "${decryptedMessage}"`);

            // Check if the message is a WebRTC offer or ICE candidate
            try {
                const signalingData = JSON.parse(decryptedMessage);
                if (signalingData.type === 'offer') {
                    console.log("[Bob ACTION] Received offer, setting remote description...");
                    await bobPeerConnection.setRemoteDescription(signalingData);
                    const answer = await bobPeerConnection.createAnswer();
                    await bobPeerConnection.setLocalDescription(answer);
                    console.log("[Bob ACTION] Sending answer to Alice...");
                    const answerData = JSON.stringify(answer);
                    const encryptedAnswer = await encryptMessage(
                        aliceEncryptionIdentity.publicKey,
                        answerData
                    );
                    const answerBytes = ethers.toUtf8Bytes(encryptedAnswer);
                    const tx = await signalContract
                        .connect(bobWallet)
                        .sendSignal(aliceWallet.address, answerBytes);
                    await tx.wait();
                    console.log(`[Bob ACTION] Answer sent! Tx: ${tx.hash}`);
                } else if (signalingData.candidate) {
                    console.log("[Bob ACTION] Adding ICE candidate from Alice...");
                    await bobPeerConnection.addIceCandidate(signalingData);
                }
            } catch (e) {
                // Not a JSON signaling message, handle as regular message
                if (sender === aliceWallet.address) {
                    // Bob Replies to Alice
                    console.log("\n[Bob ACTION] Sending reply to Alice...");
                    const replyMessage = `Hi Alice! Got your message. -Bob`;
                    const encryptedReply = await encryptMessage(
                        aliceEncryptionIdentity.publicKey,
                        replyMessage
                    );
                    // Send stringified object as bytes
                    const replyBytes = ethers.toUtf8Bytes(encryptedReply);

                    const tx = await signalContract
                        .connect(bobWallet)
                        .sendSignal(aliceWallet.address, replyBytes);
                    await tx.wait();
                    console.log(`[Bob ACTION] Reply sent! Tx: ${tx.hash}`);
                }
            }
        } catch (error) {
            console.error(`\n[Bob ERROR] Failed to process received signal:`, error);
        }
    });

    // Alice listens for messages addressed to her
    const aliceFilter = signalContract.filters.SignalSent(
        null, // Any sender
        aliceWallet.address // Recipient is Alice
    );

    signalContract.on(aliceFilter, async (event) => {
        console.log(`\n[Alice INFO] Received event:`);
        // Access event arguments via event.args array
        const sender = event.args[0];
        const recipient = event.args[1];
        const encryptedData = event.args[2];
        console.log(`   From: ${sender}`);
        console.log(`   To: ${recipient}`);
        console.log(`   Raw Encrypted Data: ${encryptedData}`);

        try {
            const receivedString = ethers.toUtf8String(encryptedData);
            const decryptedMessage = await decryptMessage(
                aliceEncryptionIdentity.privateKey,
                receivedString
            );
            console.log(`\n[Alice DECRYPTED] Message from ${sender}: "${decryptedMessage}"`);

            // Check if the message is a WebRTC answer or ICE candidate
            try {
                const signalingData = JSON.parse(decryptedMessage);
                if (signalingData.type === 'answer') {
                    console.log("[Alice ACTION] Received answer, setting remote description...");
                    await alicePeerConnection.setRemoteDescription(signalingData);
                } else if (signalingData.candidate) {
                    console.log("[Alice ACTION] Adding ICE candidate from Bob...");
                    await alicePeerConnection.addIceCandidate(signalingData);
                }
            } catch (e) {
                // Not a JSON signaling message, handle as regular message
                if (sender === bobWallet.address) {
                    console.log("\n[Alice INFO] Communication successful! Shutting down listeners.");
                    provider.removeAllListeners();
                }
            }
        } catch (error) {
            console.error(`\n[Alice ERROR] Failed to process received signal:`, error);
        }
    });

    console.log("Listeners active. Waiting for signals...");

    // --- Alice Initiates WebRTC Connection ---
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log("\n[Alice ACTION] Creating WebRTC offer...");

    const aliceDataChannel = alicePeerConnection.createDataChannel("chat");
    aliceDataChannel.onopen = () => {
        console.log("[Alice INFO] Data channel opened! Sending test message...");
        aliceDataChannel.send("Hello Bob, this is Alice via WebRTC!");
    };
    aliceDataChannel.onmessage = (event) => {
        console.log(`[Alice INFO] Received message: ${event.data}`);
    };

    const offer = await alicePeerConnection.createOffer();
    await alicePeerConnection.setLocalDescription(offer);

    // Bob listens for data channel
    bobPeerConnection.ondatachannel = (event) => {
        const bobDataChannel = event.channel;
        bobDataChannel.onopen = () => {
            console.log("[Bob INFO] Data channel opened!");
        };
        bobDataChannel.onmessage = (event) => {
            console.log(`[Bob INFO] Received message: ${event.data}`);
            bobDataChannel.send("Hi Alice, got your message! -Bob");
        };
    };

    // Keep the script running to allow listeners to catch events
    console.log("\n--- Simulation running. Waiting for replies... (Press Ctrl+C to exit) ---");
    // In a real client, you wouldn't just wait indefinitely like this
    // This is just to keep listeners alive for the demo.
    await new Promise(resolve => setTimeout(resolve, 120000)); // Wait 120 seconds instead of 60
    provider.removeAllListeners();
    console.log("--- Simulation ended ---");
}

runSimulation().catch((error) => {
    console.error("Simulation failed:", error);
    process.exit(1);
});
