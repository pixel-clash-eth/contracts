// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Factory} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

interface IPositionManager {
  struct MintParams {
    address token0;
    address token1;
    uint24 fee;
    int24 tickLower;
    int24 tickUpper;
    uint256 amount0Desired;
    uint256 amount1Desired;
    uint256 amount0Min;
    uint256 amount1Min;
    address recipient;
    uint256 deadline;
  }

  function mint(MintParams calldata params) external returns (uint256, uint128, uint256, uint256);
}

/// @notice Testing helper that creates, initialises, and seeds a Uniswap V3 pool on a mainnet
///   fork using the real Uniswap V3 factory and NonfungiblePositionManager.
/// @dev Hardcoded to mainnet contract addresses.
contract PoolCreatorHelper {
  /// sqrt(1) * 2^96 — encodes a 1:1 price between two same-decimal tokens.
  uint160 private constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

  IUniswapV3Factory private immutable _factory;
  IPositionManager private immutable _positionManager;

  constructor(IUniswapV3Factory factory_, IPositionManager positionManager_) {
    _factory = factory_;
    _positionManager = positionManager_;
  }

  /// @notice Creates a Uniswap V3 pool for (tokenA, tokenB) at the given fee tier, initialises
  ///   it at a 1:1 price, and seeds it with `liquidityAmount` of each token drawn from the caller.
  /// @dev The caller must have approved this contract to spend `liquidityAmount` of both tokens.
  ///   Full-range ticks are derived from the pool's tick spacing, so any standard fee tier works.
  /// @param tokenA The address of the first token in the pair.
  /// @param tokenB The address of the second token in the pair.
  /// @param fee The Uniswap V3 fee tier for the pool (e.g. 500 or 3000).
  /// @param liquidityAmount The amount of each token to deposit as initial liquidity.
  /// @return pool The address of the newly created pool.
  function createAndSeed(
    address tokenA,
    address tokenB,
    uint24 fee,
    uint256 liquidityAmount
  ) external returns (address pool) {
    pool = _factory.createPool(tokenA, tokenB, fee);
    IUniswapV3Pool(pool).initialize(SQRT_PRICE_1_1);

    int24 tickSpacing = IUniswapV3Pool(pool).tickSpacing();
    int24 tickLower = -(887272 / tickSpacing) * tickSpacing;
    int24 tickUpper = (887272 / tickSpacing) * tickSpacing;

    (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);

    IERC20(token0).transferFrom(msg.sender, address(this), liquidityAmount);
    IERC20(token1).transferFrom(msg.sender, address(this), liquidityAmount);
    IERC20(token0).approve(address(_positionManager), liquidityAmount);
    IERC20(token1).approve(address(_positionManager), liquidityAmount);

    _positionManager.mint(
      IPositionManager.MintParams({
        token0: token0,
        token1: token1,
        fee: fee,
        tickLower: tickLower,
        tickUpper: tickUpper,
        amount0Desired: liquidityAmount,
        amount1Desired: liquidityAmount,
        amount0Min: 0,
        amount1Min: 0,
        recipient: msg.sender,
        deadline: type(uint256).max
      })
    );
  }
}
