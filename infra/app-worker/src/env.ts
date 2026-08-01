export interface Env {
  CLICKHOUSE_URL: string;
  CLICKHOUSE_SITE_USER: string;
  CLICKHOUSE_SITE_PASSWORD: string;
  // Narrow writer for `app.saved_sites` — INSERT/SELECT on that one table (ADR-005). Separate
  // from the `site` user above, which is readonly=1 and cannot write.
  CLICKHOUSE_APP_WRITER_USER: string;
  CLICKHOUSE_APP_WRITER_PASSWORD: string;
  TRIGGER_SECRET_KEY: string;
  TRIGGER_TASK_ID: string;
  ALLOWED_ORIGINS: string;
}
