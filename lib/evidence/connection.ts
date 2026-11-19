import postgres from "postgres";

let client: postgres.Sql | undefined;

export function evidenceDb() {
  const url = process.env.READILY_V1_DATABASE_URL;
  if (!url) throw new Error("Evidence database unavailable");
  if (process.env.NODE_ENV === "production" && new URL(url).searchParams.get("sslmode") !== "verify-full") {
    throw new Error("Evidence database requires verified TLS");
  }
  client ??= postgres(url, {
    max: 5,
    prepare: false,
    idle_timeout: 15,
    connect_timeout: 5,
    connection: { statement_timeout: 15000, lock_timeout: 6000, idle_in_transaction_session_timeout: 20000 },
    onnotice: () => {},
  });
  return client;
}
