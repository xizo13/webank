// SPDX-License-Identifier: MIT
pragma solidity 0.8.11;

/// @notice Demo-only CNY minor-unit ledger. This is not e-CNY or a production token.
contract ECnySim {
    string public constant name = "Simulated e-CNY";
    string public constant symbol = "sCNY";
    uint8 public constant decimals = 2;

    address public immutable bank;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 amount);

    constructor() {
        bank = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == bank, "not bank");
        require(to != address(0), "zero recipient");
        require(amount > 0, "zero amount");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(to != address(0), "zero recipient");
        require(amount > 0, "zero amount");
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}
