// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {ISwapRouter} from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

uint256 constant UNISWAP_FEE_DENOMINATOR = 1e6;

/// @notice Simplifies swapping an input token for an output token and burning the latter.
/// @dev It uses the Uniswap V3 protocol and allows setting a maximum slippage tolerance to guard
///   against sandwich attacks.
contract SwapGateway is Ownable {
  using SafeERC20 for IERC20;

  /// @notice The input token of the swap.
  IERC20 public immutable inputToken;

  /// @notice The output token of the swap.
  ERC20Burnable public immutable targetToken;

  /// @notice Uniswap V3 swap router used to swap inputToken for targetToken.
  ISwapRouter public immutable swapRouter;

  /// @notice Uniswap V3 pool for the inputToken / targetToken pair, used for TWAP queries.
  IUniswapV3Pool public immutable swapPool;

  /// @notice Thrown when an invalid argument is provided for a required contract parameter.
  error InvalidArgument();

  /// @notice Thrown when a swap fails, eg. in case of excessive slippage.
  error SwapFailure();

  constructor(
    IERC20 inputToken_,
    ERC20Burnable targetToken_,
    ISwapRouter swapRouter_,
    IUniswapV3Pool swapPool_
  ) Ownable(msg.sender) {
    if (
      address(inputToken_) == address(0) ||
      address(targetToken_) == address(0) ||
      address(swapRouter_) == address(0) ||
      address(swapPool_) == address(0)
    ) {
      revert InvalidArgument();
    }
    inputToken = inputToken_;
    targetToken = targetToken_;
    swapRouter = swapRouter_;
    swapPool = swapPool_;
  }

  /// @notice Swaps `amount` of the `inputToken` for the equivalent in `targetToken` and burns the
  ///   received target tokens.
  /// @dev Uses a 30-minute TWAP from the V3 pool to derive the minimum acceptable output amount,
  ///   allowing up to the specified slippage from the TWAP price.
  /// @dev The caller must have approved a transfer of at least `revenue` `inputToken`s. Approval
  ///   must be given to the `SwapGateway` contract, which will in turn take care of transferring
  ///   them to the Uniswap router for the swap.
  /// @dev The swap may fail eg. in case of excessive slippage, in which case all `revenue` tokens
  ///   are transferred right back to the caller.
  /// @param amount The amount of `inputToken` to swap and burn.
  /// @param maxSlippageNumerator The numerator part of the maximum slippage tolerance, eg. 1.
  /// @param maxSlippageDenominator The denominator part of the maximum slippage tolerance, eg. 100.
  function swapAndBurn(
    uint256 amount,
    uint256 maxSlippageNumerator,
    uint256 maxSlippageDenominator
  ) external onlyOwner {
    if (maxSlippageDenominator == 0) {
      revert InvalidArgument();
    }

    inputToken.safeTransferFrom(msg.sender, address(this), amount);
    inputToken.forceApprove(address(swapRouter), amount);

    uint256 outputAmount;
    try
      swapRouter.exactInputSingle(
        ISwapRouter.ExactInputSingleParams({
          tokenIn: address(inputToken),
          tokenOut: address(targetToken),
          fee: swapPool.fee(),
          recipient: address(this),
          deadline: block.timestamp,
          amountIn: amount,
          amountOutMinimum: _computeTwapMinAmount(
            amount,
            maxSlippageNumerator,
            maxSlippageDenominator
          ),
          sqrtPriceLimitX96: 0
        })
      )
    returns (uint256 swappedAmount) {
      outputAmount = swappedAmount;
    } catch {
      inputToken.safeTransfer(msg.sender, amount);
      revert SwapFailure();
    }
    targetToken.burn(outputAmount);
  }

  /// @notice Computes the minimum acceptable output for `amountIn` of inputToken, based on a
  ///   30-minute TWAP from the V3 pool with the specified max slippage applied.
  /// @param amountIn The `inputToken` amount to swap.
  /// @return The minimum acceptable amount of output tokens.
  function _computeTwapMinAmount(
    uint256 amountIn,
    uint256 maxSlippageNumerator,
    uint256 maxSlippageDenominator
  ) private view returns (uint256) {
    uint32 twapInterval = 30 minutes;

    uint32[] memory secondsAgos = new uint32[](2);
    secondsAgos[0] = twapInterval;
    secondsAgos[1] = 0;

    (int56[] memory tickCumulatives, ) = swapPool.observe(secondsAgos);
    int56 delta = tickCumulatives[1] - tickCumulatives[0];
    int24 twapTick = int24(delta / int56(uint56(twapInterval)));
    // Round toward negative infinity when there is a remainder.
    if (delta < 0 && delta % int56(uint56(twapInterval)) != 0) {
      twapTick--;
    }

    uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(twapTick);

    // Compute expected output using the TWAP price.
    // sqrtPriceX96 = sqrt(token1 / token0) * 2^96
    uint256 twapAmount;
    if (swapPool.token0() == address(inputToken)) {
      // twapAmount = amountIn * sqrtPriceX96^2 / 2^192
      twapAmount = FullMath.mulDiv(
        FullMath.mulDiv(amountIn, uint256(sqrtPriceX96), 2 ** 96),
        uint256(sqrtPriceX96),
        2 ** 96
      );
    } else {
      // twapAmount = amountIn * 2^192 / sqrtPriceX96^2
      twapAmount = FullMath.mulDiv(
        FullMath.mulDiv(amountIn, 2 ** 96, uint256(sqrtPriceX96)),
        2 ** 96,
        uint256(sqrtPriceX96)
      );
    }

    return
      (twapAmount *
        (UNISWAP_FEE_DENOMINATOR - swapPool.fee()) *
        (maxSlippageDenominator - maxSlippageNumerator)) /
      (UNISWAP_FEE_DENOMINATOR * maxSlippageDenominator);
  }
}
