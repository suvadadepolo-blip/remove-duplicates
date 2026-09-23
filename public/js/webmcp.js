import {
  REMOVE_DUPLICATES_TOOL,
  runRemoveDuplicates
} from "./agent-tool.js?v=20260923.1";

// Exposes the duplicate remover to in-browser AI agents through WebMCP. The
// tool runs the same local engine as the page: nothing is sent over the network
// and the visitor's own input and result are left untouched.
export async function registerWebMcpTools(modelContext) {
  const tool = {
    ...REMOVE_DUPLICATES_TOOL,
    async execute(input) {
      return JSON.stringify(runRemoveDuplicates(input ?? {}));
    }
  };
  if (typeof modelContext.registerTool === "function") {
    await modelContext.registerTool(tool);
  } else {
    await modelContext.provideContext({ tools: [tool] });
  }
}
