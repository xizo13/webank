// SPDX-License-Identifier: MIT
pragma solidity 0.8.11;

interface IConfiguredAgentWallet {
    function token() external view returns (address);
    function bank() external view returns (address);
}

/// @notice Demo-only CNY minor-unit ledger. This is not e-CNY or a production token.
contract ECnySim {
    string public constant name = "Simulated e-CNY";
    string public constant symbol = "sCNY";
    uint8 public constant decimals = 2;

    address public immutable bank;
    address public agentWallet;
    bool public openingMinted;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(bytes32 => bool) public funded;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event AgentWalletConfigured(address indexed wallet);
    event Funded(bytes32 indexed fundingId, address indexed main, address indexed wallet, uint256 amount);

    constructor() {
        bank = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == bank, "not bank");
        require(!openingMinted, "opening minted");
        require(to == bank, "main only");
        require(amount > 0, "zero amount");
        openingMinted = true;
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function configureAgentWallet(address wallet) external {
        require(msg.sender == bank, "not bank");
        require(agentWallet == address(0), "wallet configured");
        require(wallet != address(0), "zero wallet");
        require(IConfiguredAgentWallet(wallet).token() == address(this), "wrong token");
        require(IConfiguredAgentWallet(wallet).bank() == bank, "wrong bank");
        agentWallet = wallet;
        emit AgentWalletConfigured(wallet);
    }

    /// @notice A bank-controlled, one-time main-account to agent-wallet transfer.
    function fundAgentWallet(bytes32 fundingId, uint256 amount) external {
        require(msg.sender == bank, "not bank");
        require(fundingId != bytes32(0), "zero funding id");
        require(!funded[fundingId], "already funded");
        require(amount > 0, "zero amount");
        address wallet = agentWallet;
        require(wallet != address(0), "wallet not configured");
        require(balanceOf[bank] >= amount, "insufficient main");
        funded[fundingId] = true;
        balanceOf[bank] -= amount;
        balanceOf[wallet] += amount;
        emit Transfer(bank, wallet, amount);
        emit Funded(fundingId, bank, wallet, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(to != address(0), "zero recipient");
        require(to != agentWallet, "funding only");
        require(amount > 0, "zero amount");
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}
