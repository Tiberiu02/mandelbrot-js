const config = {
  DEBUG_MODE: true,

  mandelbrot: {
    BASE_ITERS: 256,
    ITERS_PER_LEVEL_INIT: 256,
    MAX_ITERS: 200000,
    DEFAULT_PALETTE: "gold",
  },

  tile: {
    TILE_SIZE: 64,
    INITIAL_TILES_PER_FRAME: 16,
    MAX_TILES_PER_FRAME: 256,
  },

  limits: {
    MIN_SCALE: 80, // Prevent zooming too far out
    MAX_SCALE: 1e14, // Prevent zooming past emulated double limits
    BOUNDS_MIN_X: -10.0, // Leftmost world coordinate
    BOUNDS_MAX_X: 10.0, // Rightmost world coordinate
    BOUNDS_MIN_Y: -10.0, // Topmost world coordinate
    BOUNDS_MAX_Y: 10.0, // Bottommost world coordinate
  },
};

export default config;
