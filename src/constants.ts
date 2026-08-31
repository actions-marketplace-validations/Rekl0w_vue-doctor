export const VERSION = "0.6.0";

export const PLUGIN_NAME = "vue-doctor";

export const CONFIG_FILENAMES = [
  "vue-doctor.config.ts",
  "vue-doctor.config.mts",
  "vue-doctor.config.cts",
  "vue-doctor.config.js",
  "vue-doctor.config.mjs",
  "vue-doctor.config.cjs",
  "vue-doctor.config.json",
  ".vue-doctorrc.json",
];

export const IGNORE_FILENAMES = [
  ".gitignore",
  ".eslintignore",
  ".prettierignore",
  ".vue-doctorignore",
];

export const DEFAULT_IGNORES = [
  ".git/**",
  ".nuxt/**",
  ".output/**",
  ".vitepress/cache/**",
  "coverage/**",
  "dist/**",
  "node_modules/**",
  "storybook-static/**",
];

export const SOURCE_EXTENSIONS = new Set([
  ".vue",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".mts",
  ".cjs",
  ".cts",
]);

export const SCORE_GOOD_THRESHOLD = 75;
export const SCORE_OK_THRESHOLD = 50;

export const DEFAULT_MAX_COMPONENT_LINES = 350;
export const DEFAULT_MAX_PROPS = 14;
export const DEFAULT_FAIL_ON = "error";

export const SOCKET_FREE_PURL_API_BASE = "https://firewall-api.socket.dev/purl";
export const SOCKET_PACKAGE_PAGE_BASE = "https://socket.dev/npm/package";
export const SOCKET_FREE_USER_AGENT = "vue-doctor-supply-chain";
export const SOCKET_SCORE_SCALE = 100;

export const SUPPLY_CHAIN_DEFAULT_MIN_SCORE = 50;
export const SUPPLY_CHAIN_FETCH_CONCURRENCY = 8;
export const SUPPLY_CHAIN_FETCH_TIMEOUT_MS = 10_000;
export const SUPPLY_CHAIN_TOTAL_TIMEOUT_MS = 90_000;
export const SUPPLY_CHAIN_CACHE_TTL_MS = 86_400_000;
export const SUPPLY_CHAIN_CACHE_HASH_LENGTH = 16;
export const SUPPLY_CHAIN_CACHE_SUBDIR = "supply-chain";
export const SUPPLY_CHAIN_MAX_ALERTS_SHOWN = 3;
export const SUPPLY_CHAIN_ALERT_NOTE_MAX_CHARS = 160;

export const DEAD_CODE_WORKER_TIMEOUT_MS = 120_000;
export const DEAD_CODE_TIMEOUT_MS_PER_SOURCE_FILE = 25;
export const DEAD_CODE_TIMEOUT_CEILING_MS = 300_000;
