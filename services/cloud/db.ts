import pg from "pg";
export type Sql = pg.PoolClient;
export class Database {
  pool: pg.Pool;
  /** selfHost: operator-configured private deployment (deploy/selfhost). Still requires cloud_app. */
  constructor(url: string, options: { selfHost?: boolean } = {}) {
    const u = new URL(url);
    if (
      u.username !== "cloud_app" ||
      (!options.selfHost &&
        (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
          !u.pathname.startsWith("/cloud_slice1_")))
    )
      throw new Error(
        "slice one requires throwaway loopback postgres and non-owner cloud_app",
      );
    this.pool = new pg.Pool({
      connectionString: url,
      max: 12,
      connectionTimeoutMillis: 2000,
      query_timeout: 9000,
    });
    this.pool.on("error", () => {});
  }
  async assertRole() {
    const role = (
      await this.pool
        .query(`SELECT current_user,r.rolsuper,r.rolbypassrls,r.rolinherit,
      bool_or(c.relowner=r.oid) AS owns,
      bool_and(c.relrowsecurity AND (c.relname='accounts' OR c.relforcerowsecurity)) AS fenced
      FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE r.rolname=current_user AND n.nspname='cloud' AND c.relkind='r'
      GROUP BY r.rolsuper,r.rolbypassrls,r.rolinherit`)
    ).rows[0];
    if (
      !role ||
      role.current_user !== "cloud_app" ||
      role.rolsuper ||
      role.rolbypassrls ||
      role.rolinherit ||
      role.owns ||
      !role.fenced
    )
      throw new Error(
        "slice one requires non-owner RLS role and enabled forced tenant policies",
      );
  }
  async tx<T>(
    account: string,
    workspace: string,
    fn: (sql: Sql) => Promise<T>,
  ): Promise<T> {
    const sql = await this.pool.connect();
    try {
      await sql.query("BEGIN");
      await sql.query(
        "SET LOCAL statement_timeout='9s'; SET LOCAL lock_timeout='8s'; SET LOCAL idle_in_transaction_session_timeout='10s'",
      );
      await sql.query(
        "SELECT set_config('cloud.account_id',$1,true),set_config('cloud.workspace_id',$2,true)",
        [account, workspace],
      );
      const value = await fn(sql);
      await sql.query("COMMIT");
      return value;
    } catch (e) {
      await sql.query("ROLLBACK");
      throw e;
    } finally {
      sql.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}
