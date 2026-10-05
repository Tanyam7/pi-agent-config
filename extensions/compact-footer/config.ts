import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as z from "zod";

class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

function getGlobalConfigPath(fileName: string): string {
  return join(getAgentDir(), "extensions", fileName);
}

function loadJSONConfig<Config>(
  path: string,
  schema: z.ZodType<Config>,
  options?: { defaultConfig?: Config },
): Config {
  const defaultConfig = options?.defaultConfig ?? schema.parse({});
  ensureDefaultGlobalConfig(path, defaultConfig);

  try {
    return schema.parse(readConfigFile(path, defaultConfig));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`Invalid configuration in ${path}`, { cause: error });
  }
}

function ensureDefaultGlobalConfig(path: string, defaultConfig: unknown): void {
  if (existsSync(path)) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(defaultConfig, null, 2)}\n`, { flag: "wx" });
  } catch {
    // Continue with the in-memory default when the global config cannot be created.
  }
}

function readConfigFile(path: string, defaultConfig: unknown): unknown {
  if (!existsSync(path)) return defaultConfig;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new ConfigError(`Unable to read configuration from ${path}`, { cause: error });
  }
}

const STATUS_ELEMENT_PREFIX = "status:";

export function getStatusKey(element: string): string | undefined {
  return element.startsWith(STATUS_ELEMENT_PREFIX) ? element.slice(STATUS_ELEMENT_PREFIX.length) : undefined;
}

export const literalElementSchema = z
  .object({
    kind: z.literal("literal"),
    value: z
      .string()
      .min(1)
      .refine((value) => !/[\r\n\t]/.test(value), "Literal value must be single-line text"),
    color: z.string(),
  })
  .strict();

export const footerElementSchema = z.union([z.string(), literalElementSchema]);
export type FooterElement = z.infer<typeof footerElementSchema>;

export const lineConfigSchema = z.object({
  left: z.array(footerElementSchema).optional(),
  right: z.array(footerElementSchema).optional(),
});
export type LineConfig = z.infer<typeof lineConfigSchema>;

export const footerConfigSchema = z.object({
  separator: z.string(),
  lines: z.array(lineConfigSchema),
});
export type FooterConfig = z.infer<typeof footerConfigSchema>;

const DEFAULT_CONFIG: FooterConfig = {
  separator: " ",
  lines: [
    {
      left: ["pwd", "branch", "sessionName"],
      right: ["status:usage", "cacheHitRate", "cost", "context"],
    },
    { left: ["extensionStatuses"] },
  ],
};

export function loadConfig(): FooterConfig {
  const globalPath = getGlobalConfigPath("footer.json");
  return loadJSONConfig(globalPath, footerConfigSchema, { defaultConfig: DEFAULT_CONFIG });
}
