// SPDX-License-Identifier: MIT
pragma solidity 0.8.11;

/// @notice Bank-curated demo registry. Store only mock merchant identities and public keys.
contract MerchantRegistry {
    struct Merchant {
        address payout;
        bytes signingKey;
        string legalName;
        string uscc;
        string category;
        bool active;
    }

    address public immutable bank;
    mapping(bytes32 => Merchant) private merchants;

    event MerchantSet(bytes32 indexed merchantId, address indexed payout, bytes32 signingKeyHash, bool active);

    constructor() {
        bank = msg.sender;
    }

    function setMerchant(
        bytes32 merchantId,
        address payout,
        bytes calldata signingKey,
        string calldata legalName,
        string calldata uscc,
        string calldata category,
        bool active
    ) external {
        require(msg.sender == bank, "not bank");
        require(merchantId != bytes32(0), "zero merchant");
        require(payout != address(0), "zero payout");
        require(signingKey.length == 32, "invalid Ed25519 key");
        require(bytes(legalName).length > 0, "empty name");
        merchants[merchantId] = Merchant(payout, signingKey, legalName, uscc, category, active);
        emit MerchantSet(merchantId, payout, keccak256(signingKey), active);
    }

    function getMerchant(bytes32 merchantId) external view returns (Merchant memory) {
        return merchants[merchantId];
    }

    function payoutFor(bytes32 merchantId) external view returns (address) {
        Merchant storage merchant = merchants[merchantId];
        require(merchant.active, "merchant inactive");
        require(merchant.payout != address(0), "merchant missing");
        return merchant.payout;
    }
}
