// A private, disposable PostgreSQL database and the production connector image. Only the
// Gateway receives the connector token/URL. Database source and answer keys never reach /work.
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { requireImageId } from "./image-id.mjs";
import { journalM3Fixture } from "./m3-fixture-journal.js";

export const DATA_TASK = `Use the registered connector named database to query orders_fixture.
Produce the paid-order count and amount_cents sum per customer, sorted by customer_id.
Only status='paid' counts; pending/refunded rows do not.
Return query columns in order customer_id, paid_orders, amount_cents.
Use describe, validate, submit and receipt tools; wait for the authoritative terminal receipt.
Do not use shell database clients,
direct database connections or inferred counts. Write /work/data-report.json with
{receiptId,rows:[{customerId,paidOrders,amountCents}]}, based on the receipt's actual rows.
Mention the receipt id and the resulting two customer aggregates in your reply. Read only:
do not modify the schema or data. Do not report completion if the receipt is not succeeded.`;

// Compatibility export; the independent answer key remains host-only.
export { DATA_ROWS } from "./m4-domain-data-oracle.js";

export async function startDataFixture(): Promise<{
  url: string;
  credential: string;
  snapshot(): unknown;
  close(): Promise<void>;
}> {
  const postgres = requireImageId(process.env.M3_POSTGRES_IMAGE, "M3_POSTGRES_IMAGE");
  const connector = requireImageId(
    process.env.CONNECTOR_POSTGRES_IMAGE,
    "CONNECTOR_POSTGRES_IMAGE",
  );
  const nonce = randomUUID();
  const network = `m3-data-${nonce}`;
  const frontNetwork = `m3-data-front-${nonce}`;
  const credential = randomBytes(32).toString("hex");
  const ids: string[] = [];
  const networks: string[] = [];
  const docker = (args: string[], input?: string) => {
    try {
      return execFileSync("docker", args, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
        ...(input === undefined ? {} : { input }),
      }).trim();
    } catch {
      // Child-process errors include argv: a connector token must not reach a test receipt.
      throw Error(`owned data fixture Docker ${args[0]} failed`);
    }
  };
  const close = async () => {
    const errors: unknown[] = [];
    for (const id of [...ids].reverse()) {
      try {
        docker(["rm", "-f", "-v", id]);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const name of [...networks].reverse()) {
      try {
        docker(["network", "rm", name]);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "owned data fixture cleanup failed");
  };
  try {
    journalM3Fixture("network", network);
    docker(["network", "create", "--internal", "--label", "deskmates.test=m3-data", network]);
    networks.push(network);
    // Docker suppresses published ports on an internal-only network. Only the connector
    // joins this front bridge; PostgreSQL stays on the private backend with no host port.
    journalM3Fixture("network", frontNetwork);
    docker(["network", "create", "--label", "deskmates.test=m3-data", frontNetwork]);
    networks.push(frontNetwork);
    const dbName = `m3-data-db-${nonce}`;
    journalM3Fixture("container", dbName);
    const db = docker([
      "run",
      "-d",
      "--name",
      dbName,
      "--network",
      network,
      "--network-alias",
      "database",
      "--label",
      "deskmates.test=m3-data",
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      postgres,
    ]);
    ids.push(db);
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        // The image's temporary initialization server accepts Unix-socket connections,
        // then shuts down. TCP readiness waits for the final server instead.
        docker(["exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
        break;
      } catch {
        if (Date.now() >= deadline) throw Error("owned PostgreSQL fixture not ready");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    docker(
      ["exec", "-i", db, "psql", "-h", "127.0.0.1", "-U", "postgres", "-v", "ON_ERROR_STOP=1"],
      `
CREATE TABLE orders_fixture (id int PRIMARY KEY, customer_id text, amount_cents int, status text);
INSERT INTO orders_fixture VALUES
(1,'A',100,'paid'),(2,'A',50,'paid'),(3,'B',200,'paid'),
(4,'B',300,'pending'),(5,'A',25,'refunded'),(6,'B',75,'paid');
`,
    );
    const serviceName = `m3-data-connector-${nonce}`;
    journalM3Fixture("container", serviceName);
    const service = docker([
      "run",
      "-d",
      "--name",
      serviceName,
      "--network",
      frontNetwork,
      "--label",
      "deskmates.test=m3-data",
      "-p",
      "127.0.0.1::8790",
      "-e",
      `CONNECTOR_TOKEN=${credential}`,
      "-e",
      "CONNECTOR_DATABASE_URL=postgresql://postgres@database:5432/postgres",
      connector,
    ]);
    ids.push(service);
    docker(["network", "connect", network, service]);
    const port = Number(docker(["port", service, "8790/tcp"]).split(":").at(-1));
    if (!port) throw Error("no owned connector port");
    const url = `http://127.0.0.1:${port}`;
    const readyDeadline = Date.now() + 30_000;
    for (;;) {
      try {
        if ((await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) break;
      } catch {
        /* Readiness only; never submit another task. */
      }
      if (Date.now() >= readyDeadline) throw Error("owned connector fixture not ready");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // Observe the private database independently of the connector and the model report.
    const snapshot = (): unknown =>
      JSON.parse(
        docker(
          [
            "exec",
            "-i",
            db,
            "psql",
            "-XAt",
            "-h",
            "127.0.0.1",
            "-U",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
          ],
          `SELECT json_build_object(
        'rows', (SELECT json_agg(json_build_array(id, customer_id, amount_cents, status) ORDER BY id) FROM orders_fixture),
        'columns', (SELECT json_agg(json_build_array(table_name, column_name, data_type, is_nullable) ORDER BY table_name, ordinal_position)
          FROM information_schema.columns WHERE table_schema = 'public'),
        'constraints', (SELECT json_agg(json_build_array(c.relname, x.conname, pg_get_constraintdef(x.oid)) ORDER BY c.relname, x.conname)
          FROM pg_constraint x JOIN pg_class c ON c.oid = x.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public')
      );`,
        ),
      );
    return { url, credential, snapshot, close };
  } catch (error) {
    await close();
    throw error;
  }
}
