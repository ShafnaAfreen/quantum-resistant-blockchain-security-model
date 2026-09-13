// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

contract Transaction {

    event TransactionSent(
        address indexed from,
        address indexed to,
        uint256 amount
    );

    function sendEther(address payable to) external payable {
        require(to != address(0), "Invalid recipient");
        require(msg.value > 0, "Amount must be greater than zero");

        (bool success, ) = to.call{value: msg.value}("");
        require(success, "Transfer failed");

        emit TransactionSent(
            msg.sender,
            to,
            msg.value
        );
    }

    receive() external payable {}
}