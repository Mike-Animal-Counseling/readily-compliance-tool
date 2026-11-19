import { createClient } from "../examples/readily-v1/client";
import { verifyEvidenceCanary } from "./verify-evidence-canary";

const { READILY_API_ORIGIN: origin, READILY_V1_CANARY_PRIMARY_KEY: primary, READILY_V1_CANARY_ISOLATION_KEY: isolation } = process.env;
if (!origin || !primary || !isolation) throw new Error("Configure the Readily origin and both disposable tenant keys");
if (primary === isolation) throw new Error("Use two separate test tenant keys");

await verifyEvidenceCanary(createClient(origin, primary), createClient(origin, isolation));
