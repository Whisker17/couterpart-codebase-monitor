import { validateEnv } from "./config/settings.ts";
import { getDb } from "./storage/db";

validateEnv();
getDb();

console.log("Counterpart Monitor started. Database initialized.");
