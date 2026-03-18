import { joinSession } from "@github/copilot-sdk/extension";

const COCO_BANNER = [
  "                                       ",
  "  ■■■■  ■■■■   ■■■■  ■■■■            ",
  " ■■    ■■  ■■ ■■    ■■  ■■           ",
  " ■■    ■■  ■■ ■■    ■■  ■■           ",
  "  ■■■■  ■■■■   ■■■■  ■■■■            ",
  "                                       ",
  "  Commerce Core  |  webcontrol4        ",
  "                                       ",
].join("\n");

const ENV_STATUS = [
  "  * MCP: github-mcp-server",
  "  * Skill: workiq (M365 Copilot)",
  "  * Agents: explore, task, gp, cr",
].join("\n");

const REQUIRED_CONFIG = {
  mcpServers: ["github-mcp-server"],
  plugins: ["workiq"],
  agents: ["explore", "task", "general-purpose", "code-review"],
};

const session = await joinSession({
  hooks: {
    onSessionStart: async () => {
      await session.log(COCO_BANNER);
      await session.log(ENV_STATUS);
      return {
        additionalContext: [
          "This is the CoCo (Commerce Core) environment for the webcontrol4 project.",
          `Required MCP servers: ${REQUIRED_CONFIG.mcpServers.join(", ")}`,
          `Required plugins: ${REQUIRED_CONFIG.plugins.join(", ")}`,
          `Available agents: ${REQUIRED_CONFIG.agents.join(", ")}`,
        ].join(" "),
      };
    },
  },

  tools: [
    {
      name: "coco_status",
      description:
        "Show the CoCo environment status — loaded MCP servers, plugins, skills, and agents.",
      parameters: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const status = [
          "🐾 CoCo (Commerce Core) Status",
          "═══════════════════════════",
          "",
          "MCP Servers:",
          ...REQUIRED_CONFIG.mcpServers.map((s) => `  ● ${s}`),
          "",
          "Plugins / Skills:",
          ...REQUIRED_CONFIG.plugins.map((p) => `  ● ${p}`),
          "",
          "Sub-Agents:",
          ...REQUIRED_CONFIG.agents.map((a) => `  ● ${a}`),
        ];
        return status.join("\n");
      },
    },
  ],
});

// Log banner immediately after extension connects — onSessionStart may
// not fire if the session is already active before the extension loads.
await session.log(COCO_BANNER);
await session.log(ENV_STATUS);
