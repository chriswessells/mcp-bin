// Helper: runs createProcessRunner().exec() with given args, exits with the returned code.
// Usage: node run-helper.js <binaryPath> [args...]
import { createProcessRunner } from "../../src/process-runner.js";

const [binaryPath, ...args] = process.argv.slice(2);
const runner = createProcessRunner();
const code = await runner.exec(binaryPath, args);
process.exit(code);
