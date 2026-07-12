// Ecosystem presets — convenience templates for environmentPrepare and verification.
// Presets are operator-confirmed suggestions that must be explicitly applied.
// They are never auto-detected or auto-executed based on repository contents.

export interface EcosystemPreset {
  name: string;
  description: string;
  environmentPrepare: {
    command: string;
    cacheKeyFiles: string[];
  };
  /** Suggested verification entries. Keys are short labels; values are commands. */
  verificationSuggestions: Record<string, string>;
}

export const ECOSYSTEM_PRESETS: EcosystemPreset[] = [
  {
    name: "javascript-npm",
    description: "Node.js project managed with npm",
    environmentPrepare: {
      command: "npm ci --ignore-scripts",
      cacheKeyFiles: ["package-lock.json"],
    },
    verificationSuggestions: {
      test: "npm test",
    },
  },
  {
    name: "javascript-pnpm",
    description: "Node.js project managed with pnpm",
    environmentPrepare: {
      command: "pnpm install --frozen-lockfile --ignore-scripts",
      cacheKeyFiles: ["pnpm-lock.yaml"],
    },
    verificationSuggestions: {},
  },
  {
    name: "php-composer",
    description: "PHP project managed with Composer",
    environmentPrepare: {
      command: "composer install --no-interaction --no-scripts",
      cacheKeyFiles: ["composer.lock"],
    },
    verificationSuggestions: {
      test: "vendor/bin/phpunit",
    },
  },
  {
    name: "rust-cargo",
    description: "Rust project managed with Cargo",
    environmentPrepare: {
      command: "cargo fetch",
      cacheKeyFiles: ["Cargo.lock"],
    },
    verificationSuggestions: {
      test: "cargo test",
    },
  },
  {
    name: "go-mod",
    description: "Go project using Go modules",
    environmentPrepare: {
      command: "go mod download",
      cacheKeyFiles: ["go.sum"],
    },
    verificationSuggestions: {
      test: "go test ./...",
    },
  },
  {
    name: "python-uv",
    description: "Python project managed with uv",
    environmentPrepare: {
      command: "uv sync --frozen",
      cacheKeyFiles: ["uv.lock"],
    },
    verificationSuggestions: {},
  },
];

export const PRESET_NAMES: string[] = ECOSYSTEM_PRESETS.map((p) => p.name);

export function findPreset(name: string): EcosystemPreset | undefined {
  return ECOSYSTEM_PRESETS.find((p) => p.name === name);
}
