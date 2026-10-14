// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract AuditAnchor {
    event Anchored(bytes32 indexed recordHash, uint8 kind, uint256 at);

    function anchor(bytes32 recordHash, uint8 kind) external {
        emit Anchored(recordHash, kind, block.timestamp);
    }
}
