// SPDX-License-Identifier: MIT
pragma solidity 0.8.11;

/// @notice Commits hashes only. Records and salts stay off-chain with the signed receipt.
contract AuditAnchor {
    address public immutable gateway;
    mapping(bytes32 => bool) public anchored;

    event Anchored(bytes32 indexed recordHash, bytes32 indexed subjectId, uint8 kind, uint256 at);

    constructor(address gateway_) {
        require(gateway_ != address(0), "zero gateway");
        gateway = gateway_;
    }

    function anchor(bytes32 recordHash, bytes32 subjectId, uint8 kind) external {
        require(msg.sender == gateway, "not gateway");
        require(recordHash != bytes32(0), "zero hash");
        require(!anchored[recordHash], "already anchored");
        anchored[recordHash] = true;
        emit Anchored(recordHash, subjectId, kind, block.timestamp);
    }
}
