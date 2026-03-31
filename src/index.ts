import http from "node:http";
import { GoogleAdsAgent } from "./agent.js";
import { loadConfig, createHealthEndpoint, createHeartbeatEndpoint } from "@domien-sev/agent-sdk";
import { initScheduler, stopScheduler, runOptimizationCycleHttp, runDailyAlerts, runDataSync, runPerfSync, runWeeklyAudit } from "./scheduler.js";
import { handleBatchCampaigns } from "./handlers/batch.js";
import { runAudit } from "./handlers/audit.js";

const PORT = parseInt(process.env.PORT ?? process.env.AGENT_PORT ?? "3000", 10);

async function main() {
  const config = loadConfig();
  const agent = new GoogleAdsAgent(config);

  const healthHandler = createHealthEndpoint(agent);
  const heartbeatHandler = createHeartbeatEndpoint(agent, {
    "hourly-optimize": async (_p, a) => {
      const result = await runOptimizationCycleHttp(a as GoogleAdsAgent);
      return `Analyzed ${result.campaigns_analyzed} campaigns, ${result.recommendations?.length ?? 0} recommendations`;
    },
    "daily-alerts": async (_p, a) => {
      await runDailyAlerts(a as GoogleAdsAgent);
      return "Daily alerts posted";
    },
    "data-sync": async (_p, a) => {
      await runDataSync(a as GoogleAdsAgent);
      return "Keywords, search terms, asset groups synced";
    },
    "perf-sync": async (_p, a) => {
      await runPerfSync(a as GoogleAdsAgent);
      return "Performance scores synced";
    },
    "weekly-audit": async (_p, a) => {
      await runWeeklyAudit(a as GoogleAdsAgent);
      return "Weekly audit completed";
    },
  });

  const server = http.createServer(async (req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      return healthHandler(req, res);
    }

    // Paperclip heartbeat endpoint
    if (req.url === "/heartbeat" && req.method === "POST") {
      return heartbeatHandler(req, res);
    }

    if (req.url?.startsWith("/message")) {
      try {
        let message: Record<string, string>;
        if (req.method === "POST") {
          const body = await readBody(req);
          message = JSON.parse(body);
        } else {
          // GET — parse query params (for MCP fetch tool compatibility)
          const url = new URL(req.url, `http://localhost:${PORT}`);
          message = {
            text: url.searchParams.get("text") ?? "",
            channel_id: url.searchParams.get("channel_id") ?? "",
            user_id: url.searchParams.get("user_id") ?? "",
            ts: url.searchParams.get("ts") ?? "",
            thread_ts: url.searchParams.get("thread_ts") ?? "",
          };
        }
        const response = await agent.handleMessage(message as any);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("Error handling message:", errMsg);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errMsg }));
      }
      return;
    }

    // Batch campaign creation endpoint
    if (req.url === "/batch-campaigns" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const request = JSON.parse(body);
        const result = await handleBatchCampaigns(agent, request);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("Batch campaigns error:", errMsg);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: errMsg }));
      }
      return;
    }

    // Optimization cycle endpoint — trigger via HTTP
    if (req.url === "/optimize" && req.method === "POST") {
      try {
        const result = await runOptimizationCycleHttp(agent);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("Optimization cycle error:", errMsg);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: errMsg }));
      }
      return;
    }

    // Audit endpoint — trigger health audit via HTTP
    if (req.url === "/audit" && req.method === "POST") {
      try {
        if (!agent.googleAds) throw new Error("Google Ads client not configured");
        const result = await runAudit(agent.googleAds);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("Audit error:", errMsg);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: errMsg }));
      }
      return;
    }

    // Slack interaction endpoint — button clicks, menu selections
    if (req.url === "/interactions" && req.method === "POST") {
      // Respond immediately (Slack requires <3s)
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

      // Process asynchronously
      try {
        const rawBody = await readBody(req);
        // Slack sends URL-encoded body with a `payload` field
        const params = new URLSearchParams(rawBody);
        const payloadStr = params.get("payload");
        if (!payloadStr) return;

        const payload = JSON.parse(payloadStr) as {
          type: string;
          user: { id: string };
          channel: { id: string };
          message?: { ts: string; thread_ts?: string };
          actions?: Array<{ action_id: string; value: string }>;
        };

        if (payload.type !== "block_actions" || !payload.actions?.length) return;

        const action = payload.actions[0];
        const channelId = payload.channel.id;
        const userId = payload.user.id;
        const threadTs = payload.message?.thread_ts ?? payload.message?.ts ?? "";
        const messageTs = payload.message?.ts ?? "";

        // Map action_id to wizard text commands
        const aid = action.action_id;
        let text = action.value;
        if (aid.startsWith("wizard_type_")) {
          text = action.value; // "search", "shopping", etc.
        } else if (aid === "wizard_events") {
          text = "events";
        } else if (aid.startsWith("wizard_event_")) {
          text = `event_select:${action.value}`;
        } else if (aid === "wizard_confirm") {
          text = "confirm";
        } else if (aid === "wizard_csv") {
          text = "export csv";
        } else if (aid === "wizard_regenerate") {
          text = "regenerate copy";
        } else if (aid.startsWith("wizard_clone_")) {
          text = `clone ${action.value}`;
        } else if (aid === "wizard_cancel") {
          text = "cancel";
        } else if (aid === "wizard_confirm_event") {
          text = "confirm_event";
        } else if (aid === "wizard_change_radius") {
          text = "radius";
        } else if (aid === "wizard_change_end") {
          text = "end date";
        } else if (aid === "wizard_enable") {
          text = "enable";
        } else if (aid === "wizard_done") {
          text = "done";
        } else if (aid === "wizard_update_budget") {
          text = "adjust budget to";
        }

        // Build synthetic message and route to handler
        const syntheticMessage = {
          text,
          channel_id: channelId,
          user_id: userId,
          ts: messageTs,
          thread_ts: threadTs,
        };

        await agent.handleMessage(syntheticMessage as any);
      } catch (err) {
        console.error("Interaction handler error:", err instanceof Error ? err.message : String(err));
      }
      return;
    }

    if (req.url === "/callbacks/task" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const taskResult = JSON.parse(body);
        console.log("Received task callback:", taskResult);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(500);
        res.end();
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  const shutdown = async () => {
    stopScheduler();
    server.close();
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.listen(PORT, () => {
    console.log(`Google Ads agent listening on port ${PORT}`);
  });

  // Register with Directus (retry on failure)
  const MAX_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await agent.start();
      break;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`Directus registration attempt ${attempt}/${MAX_RETRIES} failed: ${errMsg}`);
      if (attempt === MAX_RETRIES) {
        console.error("Could not register with Directus — running without registration");
      } else {
        await new Promise((r) => setTimeout(r, 5000 * attempt));
      }
    }
  }

  // Start optimization scheduler (hourly rules + daily alerts + 6h data sync)
  initScheduler(agent);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
