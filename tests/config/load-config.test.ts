import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  loadConfig,
  resolveConfigPath,
} from "../../src/config/load-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function writeConfig(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "qicode-config-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "config.yaml");
  await writeFile(path, contents, "utf8");
  return path;
}

describe("resolveConfigPath", () => {
  it("uses ~/.qicode/config.yaml when no argument is provided", () => {
    expect(resolveConfigPath([], "C:\\Users\\tester")).toBe(
      join("C:\\Users\\tester", ".qicode", "config.yaml"),
    );
  });

  it("uses the path following --config", () => {
    expect(resolveConfigPath(["--config", "custom.yaml"], "ignored")).toBe(
      "custom.yaml",
    );
  });

  it("rejects a missing --config value", () => {
    expect(() => resolveConfigPath(["--config"], "ignored")).toThrow(
      "Missing value for --config",
    );
  });

  it("rejects unknown command-line arguments", () => {
    expect(() => resolveConfigPath(["--unknown"], "ignored")).toThrow(
      "Unknown argument: --unknown",
    );
  });
});

describe("loadConfig", () => {
  it("loads valid Anthropic and OpenAI providers", async () => {
    const path = await writeConfig(`
providers:
  - name: claude-main
    protocol: anthropic
    model: claude-sonnet
    base_url: https://api.anthropic.com
    api_key: \${ANTHROPIC_API_KEY}
    thinking: true
  - name: openai-main
    protocol: openai
    model: gpt-model
    base_url: https://api.openai.com/v1
    api_key: literal-test-key
`);

    const config = await loadConfig(path, {
      ANTHROPIC_API_KEY: "resolved-secret",
    });

    expect(config.providers).toEqual([
      {
        name: "claude-main",
        protocol: "anthropic",
        model: "claude-sonnet",
        base_url: "https://api.anthropic.com",
        api_key: "resolved-secret",
        thinking: true,
      },
      {
        name: "openai-main",
        protocol: "openai",
        model: "gpt-model",
        base_url: "https://api.openai.com/v1",
        api_key: "literal-test-key",
        thinking: false,
      },
    ]);
  });

  it("rejects a missing configuration file", async () => {
    await expect(loadConfig("missing-config.yaml", {})).rejects.toThrow(
      "Cannot read configuration file",
    );
  });

  it("rejects invalid YAML", async () => {
    const path = await writeConfig("providers: [");
    await expect(loadConfig(path, {})).rejects.toThrow("Invalid YAML");
  });

  it("rejects an empty providers array", async () => {
    const path = await writeConfig("providers: []");
    await expect(loadConfig(path, {})).rejects.toThrow(
      "providers must contain at least one provider",
    );
  });

  it.each(["name", "protocol", "model", "base_url", "api_key"])(
    "rejects a provider missing %s",
    async (field) => {
      const provider: Record<string, unknown> = {
        name: "main",
        protocol: "anthropic",
        model: "claude-sonnet",
        base_url: "https://api.anthropic.com",
        api_key: "secret-value",
      };
      delete provider[field];
      const yaml = ["providers:", "  -"].concat(
        Object.entries(provider).map(([key, value]) => `    ${key}: ${value}`),
      );
      const path = await writeConfig(yaml.join("\n"));

      await expect(loadConfig(path, {})).rejects.toThrow(field);
    },
  );

  it("rejects unsupported protocols", async () => {
    const path = await writeConfig(`
providers:
  - name: main
    protocol: custom
    model: model
    base_url: https://example.com
    api_key: secret-value
`);
    await expect(loadConfig(path, {})).rejects.toThrow(
      "protocol must be anthropic or openai",
    );
  });

  it("rejects invalid base URLs", async () => {
    const path = await writeConfig(`
providers:
  - name: main
    protocol: anthropic
    model: model
    base_url: not-a-url
    api_key: secret-value
`);
    await expect(loadConfig(path, {})).rejects.toThrow(
      "base_url must be a valid HTTP or HTTPS URL",
    );
  });

  it("rejects duplicate provider names", async () => {
    const path = await writeConfig(`
providers:
  - name: duplicate
    protocol: anthropic
    model: model-a
    base_url: https://example.com
    api_key: first-secret
  - name: duplicate
    protocol: openai
    model: model-b
    base_url: https://example.com/v1
    api_key: second-secret
`);
    await expect(loadConfig(path, {})).rejects.toThrow(
      "provider name must be unique: duplicate",
    );
  });

  it("rejects thinking=true for OpenAI", async () => {
    const path = await writeConfig(`
providers:
  - name: openai-main
    protocol: openai
    model: model
    base_url: https://example.com/v1
    api_key: secret-value
    thinking: true
`);
    await expect(loadConfig(path, {})).rejects.toThrow(
      "thinking=true is only supported for anthropic",
    );
  });

  it("rejects non-boolean thinking values", async () => {
    const path = await writeConfig(`
providers:
  - name: main
    protocol: anthropic
    model: model
    base_url: https://example.com
    api_key: secret-value
    thinking: yes
`);
    await expect(loadConfig(path, {})).rejects.toThrow(
      "thinking must be a boolean",
    );
  });

  it("rejects missing environment variables", async () => {
    const path = await writeConfig(`
providers:
  - name: main
    protocol: anthropic
    model: model
    base_url: https://example.com
    api_key: \${MISSING_API_KEY}
`);
    await expect(loadConfig(path, {})).rejects.toThrow(
      "environment variable MISSING_API_KEY is missing or empty",
    );
  });

  it("rejects empty environment variables", async () => {
    const path = await writeConfig(`
providers:
  - name: main
    protocol: anthropic
    model: model
    base_url: https://example.com
    api_key: \${EMPTY_API_KEY}
`);
    await expect(loadConfig(path, { EMPTY_API_KEY: "   " })).rejects.toThrow(
      "environment variable EMPTY_API_KEY is missing or empty",
    );
  });

  it("treats partial environment syntax as a literal key", async () => {
    const path = await writeConfig(`
providers:
  - name: main
    protocol: anthropic
    model: model
    base_url: https://example.com
    api_key: prefix-\${API_KEY}
`);
    const config = await loadConfig(path, { API_KEY: "resolved-secret" });
    expect(config.providers[0]?.api_key).toBe("prefix-${API_KEY}");
  });

  it("does not expose API keys in validation errors", async () => {
    const secret = "highly-sensitive-key";
    const path = await writeConfig(`
providers:
  - name: main
    protocol: invalid
    model: model
    base_url: https://example.com
    api_key: ${secret}
`);

    let error: unknown;
    try {
      await loadConfig(path, {});
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).not.toContain(secret);
  });

  it("rejects fields outside the six-field provider schema", async () => {
    const path = await writeConfig(`
providers:
  - name: main
    protocol: anthropic
    model: model
    base_url: https://example.com
    api_key: secret-value
    extra_field: unexpected
`);
    await expect(loadConfig(path, {})).rejects.toThrow(
      "unsupported field: extra_field",
    );
  });
});
