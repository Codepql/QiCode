import { withFileLock } from "../../src/fs/file-access.js";

process.once("message", () => process.exit(0));
await withFileLock(process.argv[2]!, async () => {
  process.send?.("locked");
  await new Promise<void>(() => {});
});
