// SPDX-License-Identifier: MIT
pragma solidity 0.8.11;

import "./ECnySim.sol";
import "./MerchantRegistry.sol";

/// @notice A bank-controlled simulated sub-wallet with contract-enforced spending bounds.
contract AgentWallet {
    ECnySim public immutable token;
    MerchantRegistry public immutable merchantRegistry;
    address public immutable bank;
    /// @notice FISCO's Solidity timestamp uses milliseconds; standard EVM uses seconds.
    bool public immutable timestampIsMilliseconds;
    address public gateway;
    uint256 public perPaymentCap;
    uint256 public dailyCap;
    uint256 public monthlyCap;
    bool public frozen;

    mapping(bytes32 => bool) public paid;
    mapping(uint256 => uint256) public spentByDay;
    mapping(uint256 => uint256) public spentByMonth;

    event Paid(bytes32 indexed paymentId, bytes32 indexed merchantId, address indexed payout, uint256 amount);
    event Frozen(bool frozen);
    event CapsSet(uint256 perPaymentCap, uint256 dailyCap, uint256 monthlyCap);
    event GatewaySet(address indexed gateway);

    constructor(
        address token_,
        address merchantRegistry_,
        address gateway_,
        uint256 perPaymentCap_,
        uint256 dailyCap_,
        uint256 monthlyCap_,
        bool timestampIsMilliseconds_
    ) {
        require(token_ != address(0) && merchantRegistry_ != address(0) && gateway_ != address(0), "zero address");
        require(perPaymentCap_ > 0 && perPaymentCap_ <= dailyCap_ && dailyCap_ <= monthlyCap_, "invalid caps");
        token = ECnySim(token_);
        merchantRegistry = MerchantRegistry(merchantRegistry_);
        bank = msg.sender;
        timestampIsMilliseconds = timestampIsMilliseconds_;
        gateway = gateway_;
        perPaymentCap = perPaymentCap_;
        dailyCap = dailyCap_;
        monthlyCap = monthlyCap_;
    }

    /// @dev Only the bank's authenticated control flow may change these limits.
    function setCaps(uint256 perPaymentCap_, uint256 dailyCap_, uint256 monthlyCap_) external {
        require(msg.sender == bank, "not bank");
        require(perPaymentCap_ > 0 && perPaymentCap_ <= dailyCap_ && dailyCap_ <= monthlyCap_, "invalid caps");
        perPaymentCap = perPaymentCap_;
        dailyCap = dailyCap_;
        monthlyCap = monthlyCap_;
        emit CapsSet(perPaymentCap_, dailyCap_, monthlyCap_);
    }

    function setGateway(address gateway_) external {
        require(msg.sender == bank, "not bank");
        require(gateway_ != address(0), "zero gateway");
        gateway = gateway_;
        emit GatewaySet(gateway_);
    }

    /// @dev The bank can freeze immediately. Unfreeze must follow its app verification rules.
    function setFrozen(bool frozen_) external {
        require(msg.sender == bank, "not bank");
        frozen = frozen_;
        emit Frozen(frozen_);
    }

    function pay(bytes32 paymentId, bytes32 merchantId, uint256 amount) external {
        require(msg.sender == gateway, "not gateway");
        require(!frozen, "frozen");
        require(paymentId != bytes32(0), "zero payment");
        require(!paid[paymentId], "already paid");
        require(amount > 0, "zero amount");
        require(amount <= perPaymentCap, "over payment cap");

        uint256 timestampSeconds = _toSeconds(block.timestamp, timestampIsMilliseconds);
        uint256 day = timestampSeconds / 1 days;
        uint256 month = _monthIndex(timestampSeconds);
        require(spentByDay[day] + amount <= dailyCap, "over daily cap");
        require(spentByMonth[month] + amount <= monthlyCap, "over monthly cap");
        address payout = merchantRegistry.payoutFor(merchantId);

        // Effects precede the external token call; a revert rolls all effects back.
        paid[paymentId] = true;
        spentByDay[day] += amount;
        spentByMonth[month] += amount;
        require(token.transfer(payout, amount), "transfer failed");
        emit Paid(paymentId, merchantId, payout, amount);
    }

    /// @notice UTC day index for a timestamp with an explicit input unit.
    function dayIndexFor(uint256 timestamp, bool milliseconds) external pure returns (uint256) {
        return _toSeconds(timestamp, milliseconds) / 1 days;
    }

    /// @notice Native timestamp observed by Solidity in this deployment.
    function currentTimestamp() external view returns (uint256) {
        return block.timestamp;
    }

    function currentDayIndex() external view returns (uint256) {
        return _toSeconds(block.timestamp, timestampIsMilliseconds) / 1 days;
    }

    function currentMonthIndex() external view returns (uint256) {
        return _monthIndex(_toSeconds(block.timestamp, timestampIsMilliseconds));
    }

    /// @notice UTC calendar month index for a timestamp with an explicit input unit.
    function monthIndexFor(uint256 timestamp, bool milliseconds) external pure returns (uint256) {
        return _monthIndex(_toSeconds(timestamp, milliseconds));
    }

    /// @notice Calendar months in UTC for a seconds timestamp.
    function monthIndex(uint256 timestamp) external pure returns (uint256) {
        return _monthIndex(timestamp);
    }

    function _toSeconds(uint256 timestamp, bool milliseconds) internal pure returns (uint256) {
        return milliseconds ? timestamp / 1000 : timestamp;
    }

    function _monthIndex(uint256 timestamp) internal pure returns (uint256) {
        uint256 z = timestamp / 1 days + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 m = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) y += 1;
        return y * 12 + m - 1;
    }
}
