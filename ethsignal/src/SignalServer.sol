// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SignalServer
 * @notice A contract to facilitate off-chain encrypted signalling between users.
 * Users encrypt messages using the recipient's public key off-chain and send
 * the encrypted payload through this contract, emitting an event.
 */
contract SignalServer {

    /**
     * @notice Emitted when a user sends a signal to another user.
     * @param sender The address initiating the signal.
     * @param recipient The intended recipient's address.
     * @param encryptedData The encrypted payload.
     */
    event SignalSent(address indexed sender, address indexed recipient, bytes encryptedData);

    /**
     * @notice Sends an encrypted signal to a recipient.
     * @dev The encryption must be performed off-chain by the sender using the
     *      recipient's public key. This function only records the intent
     *      and payload via an event.
     * @param _recipient The address of the user to send the signal to.
     * @param _encryptedData The off-chain encrypted data payload.
     */
    function sendSignal(address _recipient, bytes calldata _encryptedData) external {
        require(_recipient != address(0), "SignalServer: Recipient cannot be zero address");
        require(_encryptedData.length > 0, "SignalServer: Encrypted data cannot be empty");

        emit SignalSent(msg.sender, _recipient, _encryptedData);
    }
}