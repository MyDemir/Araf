// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockERC20 — Araf Testnet Faucet + Test Fixture Token
 * @dev Two mint paths:
 *
 *   1. mint()                — Rate-limited faucet for end-user testnet testing.
 *                              Max 1000 tokens every 1 hour per wallet.
 *
 *   2. mint(address, uint256) — Unrestricted admin mint for Hardhat test fixtures.
 *                               Allows deployAndSetupFixture() to set arbitrary
 *                               initial balances in a single call.
 *                               NOT available in production contracts.
 */
contract MockERC20 is ERC20 {
    uint8 private _dec;

    // Anti-spam: track last faucet mint time per wallet
    mapping(address => uint256) public lastMintTime;

    constructor(string memory name, string memory symbol, uint8 decimals_)
        ERC20(name, symbol)
    {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    /**
     * @notice Testnet faucet — rate-limited to 1000 tokens per hour per wallet.
     */
    function mint() external {
        require(
            block.timestamp >= lastMintTime[msg.sender] + 1 hours,
            "MockERC20: You can only mint 1000 tokens every 1 hour"
        );
        lastMintTime[msg.sender] = block.timestamp;
        _mint(msg.sender, 1000 * 10 ** decimals());
    }

    /**
     * @notice Unrestricted admin mint for Hardhat test fixture setup.
     * @dev Allows setting arbitrary initial balances without rate limits.
     *      This function must NOT exist in production token contracts.
     * @param to     Recipient address
     * @param amount Amount to mint (token decimals)
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
