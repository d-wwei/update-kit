import { defineAdapter } from "../../src/adapter.js";
import { createRuntime } from "../../src/runtime.js";

async function main(): Promise<void> {
  const runtime = await createRuntime({
    cwd: process.cwd(),
    manifestFile: "./update.config.json"
  });

  const adapter = defineAdapter({
    name: "node-ts-example",
    getContext() {
      return {
        cwd: process.cwd(),
        appName: "node-ts-example",
        componentName: "node-ts-example"
      };
    },
    confirm: async (prompt) => {
      console.log(prompt.title);
      console.log(prompt.summary);
      return "update_once";
    }
  });

  const summary = await runtime.check(adapter);
  console.log(summary.message);

  if (summary.hasUpdate && !summary.policy.ignored) {
    const result = await runtime.apply(adapter);
    console.log(result.message);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
