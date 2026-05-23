import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface ToolCategory {
  signals: { re: RegExp; w: number }[];
  antiSignals?: { re: RegExp; w: number }[];
  allowedTools: string[];
}

// Category definitions: signals boost the score, associated tools are permitted to load.
const CATEGORIES: Record<string, ToolCategory> = {
  write: {
    signals: [
      { re: /\b(fix|change|update|modify|edit|refactor|rename|replace|patch|add|insert|implement|create|write|make|delete|remove|strip|clean\s*up)\b/i, w: 3.0 },
      { re: /\b(bug|error|typo|issue|broken|wrong|incorrect|failing|fail|crash)\b/i, w: 1.5 }
    ],
    antiSignals: [
      { re: /\b(explain|what|why|how\s+does|tell\s+me)\b/i, w: 1.5 }
    ],
    allowedTools: ["read_file", "write_file", "edit_file", "patch_file", "execute_command", "bash", "solo_tool", "todo_update", "todo_complete"]
  },
  read: {
    signals: [
      { re: /\b(read|show|cat|display|print|view|open|look\s+at|check|see|inspect|review|analyze|analyse|examine|audit)\b/i, w: 3.0 },
      { re: /\b(file|\.\w{1,4})\b/i, w: 1.0 }
    ],
    antiSignals: [
      { re: /\b(fix|change|update|modify|add|remove|delete|create|write)\b/i, w: 2.0 }
    ],
    allowedTools: ["read_file", "find_files", "execute_command", "solo_tool", "scratchpad_read"]
  },
  search: {
    signals: [
      { re: /\b(find|search|grep|look\s+for|locate|where\s+is|all\s+uses?\s+of|all\s+references?|who\s+calls?|imports?\s+of)\b/i, w: 3.0 }
    ],
    antiSignals: [
      { re: /\b(fix|change|update|create|write)\b/i, w: 2.0 }
    ],
    allowedTools: ["read_file", "find_files", "execute_command", "solo_tool"]
  },
  respond: {
    signals: [
      { re: /\b(explain|what\s+is|what\s+are|what\s+does|how\s+does|how\s+do|tell\s+me|describe|why\s+is|why\s+does|why\s+do|difference\s+between|compare|vs|versus|help|guide|tutorial|example|opinion|think|recommend|suggest|best\s+practice)\b/i, w: 3.0 },
      { re: /\b(thanks|thank\s+you|ok|sure|yes|no|got\s+it)\b/i, w: 3.0 }
    ],
    antiSignals: [
      { re: /\b(failing|failed|broken|crash|error|bug|wrong|file|code|function|class|module)\b/i, w: 1.5 }
    ],
    allowedTools: [] // Load zero tools! Saves maximum token context footprint.
  }
};

const DEFAULT_CATEGORY = "read";
const SHORT_MSG_THRESHOLD = 10;

export default function (pi: ExtensionAPI) {
  let activeCategory: keyof typeof CATEGORIES = DEFAULT_CATEGORY;
  let isEnabled = true;

  pi.registerCommand("smart_router", {
    description: "Toggle the smart-router extension on or off",
    async handler(args, ctx) {
      isEnabled = !isEnabled;
      const status = isEnabled ? "ENABLED" : "DISABLED";
      
      if (!isEnabled) {
        // If disabled, immediately restore all tools
        pi.setActiveTools(pi.getAllTools().map(t => t.name));
      }
      
      if (ctx.hasUI) {
        ctx.ui.notify(`Smart Router is now ${status}`, isEnabled ? "info" : "warning");
      }
    }
  });

  // Classify user message and route tools accordingly
  pi.on("input", async (event, ctx) => {
    if (!isEnabled) return;

    const text = event.text ? event.text.trim() : "";
    if (!text) return;

    // Fast-path greetings / acknowledgments
    if (text.length <= SHORT_MSG_THRESHOLD && !/\b(run|fix|read|show|find|build|test|git|npm|pip|go|cd|ls|rm|mv|cp)\b/i.test(text)) {
      activeCategory = "respond";
    } else {
      // Weighted Classification
      let bestCategory: keyof typeof CATEGORIES = DEFAULT_CATEGORY;
      let maxScore = -Infinity;

      for (const [name, cat] of Object.entries(CATEGORIES)) {
        let score = 0;
        
        // Calculate positive signal matches
        for (const sig of cat.signals) {
          if (sig.re.test(text)) score += sig.w;
        }
        
        // Subtract anti-signal matches
        for (const anti of cat.antiSignals || []) {
          if (anti.re.test(text)) score -= anti.w;
        }

        if (score > maxScore) {
          maxScore = score;
          bestCategory = name as keyof typeof CATEGORIES;
        }
      }

      if (maxScore > 0) {
        activeCategory = bestCategory;
      }
    }

    // Set active tools dynamically using the API
    const allAvailableTools = pi.getAllTools().map(t => t.name);
    
    // Check if the focus orchestrator is in an active task state (planning, executing, reviewing)
    const focusState = (global as any).piFocusState;
    if (focusState && focusState.activeState !== "idle") {
      // Keep ALL tools active during planning/execution/review tasks!
      pi.setActiveTools(allAvailableTools);
      if (ctx.hasUI) {
        ctx.ui.notify(`Tool Routing: ACTIVE (${focusState.activeState.toUpperCase()}) - All Tools Enabled`, "info");
      }
      return;
    }

    const allowed = CATEGORIES[activeCategory].allowedTools;
    // Globally whitelist 'focus_decision' so it remains active for all categories
    const toEnable = allAvailableTools.filter(t => allowed.includes(t) || t === "focus_decision");
    
    pi.setActiveTools(toEnable);

    if (ctx.hasUI) {
      ctx.ui.notify(`Tool Routing: ${activeCategory.toUpperCase()} (Enabled ${toEnable.length}/${allAvailableTools.length} tools)`, "info");
    }
  });
}
