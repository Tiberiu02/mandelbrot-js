const config = {
  DEBUG_MODE: false,

  mandelbrot: {
    BASE_ITERS: 256,
    ITERS_PER_LEVEL_INIT: 256,
    MAX_ITERS: 200000,
    DEFAULT_PALETTE: "gold",
  },

  preview: {
    ENABLED: false,
    START_DELAY_MS: 1000,
    DURATION_MS: 600_000,
    TARGET: {
      x: -0.10066630920541,
      y: -0.95651249869989,
      z: 1.9e13,
    },
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
