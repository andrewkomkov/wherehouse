export interface Env {
  CLICKHOUSE_URL: string;
  CLICKHOUSE_SITE_USER: string;
  CLICKHOUSE_SITE_PASSWORD: string;
  TRIGGER_SECRET_KEY: string;
  TRIGGER_TASK_ID: string;
  ALLOWED_ORIGINS: string;
  // biome-ignore lint: Cloudflare binding name
  HYPERDRIVE: Hyperdrive;
}
