// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract CappedWallet {
    address public gateway;
    uint256 public perPaymentCap;
    uint256 public balance;
    bool public frozen;

    event Paid(bytes32 indexed orderId, uint256 amount);

    constructor(uint256 cap) {
        gateway = msg.sender;
        perPaymentCap = cap;
        balance = 1000000;
    }

    function pay(bytes32 orderId, uint256 amount) external {
        require(msg.sender == gateway, "not gateway");
        require(!frozen, "frozen");
        require(amount <= perPaymentCap, "over cap");
        require(amount <= balance, "insufficient");
        balance -= amount;
        emit Paid(orderId, amount);
    }

    function freeze() external {
        require(msg.sender == gateway, "not gateway");
        frozen = true;
    }
}
