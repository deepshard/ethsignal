// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20; // Match contract pragma

import { Script, console } from "forge-std/Script.sol";
// Import the SignalServer contract
import { SignalServer } from "../src/SignalServer.sol";

// Rename the script contract
contract SignalServerScript is Script {
    // Change the variable to hold SignalServer
    SignalServer public signalServer;

    function setUp() public {
        // No setup needed for basic deployment
    }

    function run() public returns (SignalServer) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        // Deploy the SignalServer contract
        signalServer = new SignalServer();

        console.log("SignalServer deployed at:", address(signalServer));

        vm.stopBroadcast();
        return signalServer; // Return the deployed instance
    }
}