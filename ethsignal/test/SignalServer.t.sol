// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test, console } from "forge-std/Test.sol";
import { SignalServer } from "../src/SignalServer.sol";

contract SignalServerTest is Test {
    SignalServer public signalServer;

    // Sample addresses for testing
    address public user1 = vm.addr(1);
    address public user2 = vm.addr(2);

    // Sample encrypted data
    bytes public sampleEncryptedData = hex"aabbccddeeff";

    // Deploy the contract before each test
    function setUp() public {
        signalServer = new SignalServer();
    }

    // Test that sending a signal emits the correct event with correct parameters
    function test_SendSignal_EmitsEvent() public {
        // Expect an event SignalSent(address indexed sender, address indexed recipient, bytes encryptedData)
        // We specify the indexed parameters (sender, recipient) first, then non-indexed (encryptedData)
        vm.expectEmit(true, true, false, true); // Indexing: sender, recipient, none, data
        emit SignalServer.SignalSent(user1, user2, sampleEncryptedData);

        // User1 sends a signal to User2
        vm.prank(user1); // Set the next call's msg.sender to user1
        signalServer.sendSignal(user2, sampleEncryptedData);
    }

    // Test sending a signal with a zero address recipient should revert
    function test_RevertIf_SendSignalToZeroAddress() public {
        // Expect a revert with the specified error message
        vm.expectRevert(bytes("SignalServer: Recipient cannot be zero address"));

        // Attempt to send signal from user1 to address(0)
        vm.prank(user1);
        signalServer.sendSignal(address(0), sampleEncryptedData);
    }

    // Test sending a signal with empty data should revert
    function test_RevertIf_SendSignalWithEmptyData() public {
        // Expect a revert with the specified error message
        vm.expectRevert(bytes("SignalServer: Encrypted data cannot be empty"));

        // Attempt to send signal from user1 to user2 with empty data
        vm.prank(user1);
        signalServer.sendSignal(user2, ""); // Empty bytes string
    }
}