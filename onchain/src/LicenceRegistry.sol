// SPDX-License-Identifier: MIT
pragma solidity 0.8.11;

/// @notice The Gateway applies licence caps; this registry provides a shared audit view.
contract LicenceRegistry {
    enum Level { Unset, L, P, Full, Suspended }

    struct Licence {
        bytes32 keyHash;
        Level level;
        uint64 updatedAt;
    }

    address public immutable bank;
    mapping(bytes32 => Licence) private licences;

    event LicenceSet(bytes32 indexed agentId, bytes32 indexed keyHash, Level level, uint64 at);

    constructor() {
        bank = msg.sender;
    }

    function setLicence(bytes32 agentId, bytes32 keyHash, Level level) external {
        require(msg.sender == bank, "not bank");
        require(agentId != bytes32(0), "zero agent");
        require(keyHash != bytes32(0), "zero key hash");
        require(level != Level.Unset, "unset level");
        licences[agentId] = Licence(keyHash, level, uint64(block.timestamp));
        emit LicenceSet(agentId, keyHash, level, uint64(block.timestamp));
    }

    function getLicence(bytes32 agentId) external view returns (Licence memory) {
        return licences[agentId];
    }
}
