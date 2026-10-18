import { ReadFileTool } from "../../src/tools/read-file.js";
import { WriteFileTool } from "../../src/tools/write-file.js";

const workDir = process.argv[2]!;
const content = process.argv[3]!;
const context = { workDir, fileVersions: new Map<string, string | null>() };
await new ReadFileTool().execute({ file_path: "shared.txt" }, context);
process.send?.("ready");
process.once("message", () => {
  void new WriteFileTool().execute({ file_path: "shared.txt", content }, context).then((result) => {
    process.send?.(result, () => process.disconnect?.());
  });
});
