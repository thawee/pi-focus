import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { createStatusBarFactory, triggerFooterRender } from "./statusBar.js";

// ─── Tool Call Event Type Definition ─────────────────────────────────────────
interface ToolCallEvent {
  toolName: string;
  input?: {
    path?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ─── OS-Specific File Editor Commands ───────────────────────────────────────
function getOpenFileCommand(filePath: string): string {
  const platform = process.platform;
  const escapedPath = filePath.replace(/&/g, '\\&').replace(/"/g, '\\"');
  
  if (platform === 'win32') {
    // Windows: explorer.exe can open files
    return `explorer.exe "${escapedPath}"`;
  } else if (platform === 'darwin') {
    // macOS: open -e opens in default text editor
    return `open -e "${escapedPath}"`;
  } else {
    // Linux: xdg-open or use default text editor
    return `xdg-open "${escapedPath}"`;
  }
}

// ─── Tools Optimizer Types & Constants ───────────────────────────────────────
interface ToolCategory {
  signals: { re: RegExp; w: number }[];
  antiSignals?: { re: RegExp; w: number }[];
  allowedTools: string[];
}

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
    allowedTools: []
  }
};

const DEFAULT_CATEGORY = "read";
const SHORT_MSG_THRESHOLD = 10;

// ─── Focus Mode Types ─────────────────────────────────────────────────────────

interface TodoItem {
  id: string;
  title: string;
  allowedFiles: string[];
  description: string;
  completed: boolean;
}

type OrchestratorState = "idle" | "planning" | "executing" | "reviewing";

class StateMachine {
  activeState: OrchestratorState = "idle";
  todos: TodoItem[] = [];
  activeTodoId: string | null = null;
  planId: string = "default";
  
  getActiveTodo(): TodoItem | null {
    if (!this.activeTodoId) return null;
    return this.todos.find(t => t.id === this.activeTodoId) || null;
  }
}

export default function (pi: ExtensionAPI) {

  // ─── Global State ───────────────────────────────────────────────────────────
  const stateMachine = new StateMachine();
  // Using global state because ExtensionAPI doesn't provide a built-in state mechanism
  // This is a known limitation of the current Pi Agent API
  (global as any).piFocusState = stateMachine;
  let isWritingTaskFile = false;
  let taskWatcher: fs.FSWatcher | null = null;
  let taskFilePath = "";

  let activeCategory: keyof typeof CATEGORIES = DEFAULT_CATEGORY;
  let isOptimizerEnabled = true;

  // ─── Focus Mode Helper Functions ────────────────────────────────────────────

  function countSkillFiles(ctx: ExtensionContext): number {
    const skillDirs = [
      path.join(ctx.cwd, ".pi/skills"),
      path.join(ctx.cwd, ".agents/skills"),
      path.join(os.homedir(), ".pi/agent/skills"),
      path.join(os.homedir(), ".agents/skills")
    ];

    let count = 0;
    const seen = new Set<string>();

    for (const dir of skillDirs) {
      if (fs.existsSync(dir)) {
        try {
          // Look for SKILL.md files in subdirectories (one level deep is standard)
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const skillPath = path.join(dir, entry.name, "SKILL.md");
              if (fs.existsSync(skillPath) && !seen.has(skillPath)) {
                count++;
                seen.add(skillPath);
              }
            } else if (entry.name.toUpperCase() === "SKILL.MD") {
                const skillPath = path.join(dir, entry.name);
                if (!seen.has(skillPath)) {
                    count++;
                    seen.add(skillPath);
                }
            }
          }
        } catch (e) {}
      }
    }
    return count;
  }

  function loadAgentPrompt(agentName: string): string {
    if (agentName === "planner") {
      return `You are an expert Planning Agent embedded inside Pi Focus — a focused, state-machine-driven coding assistant.

## Your Role
You analyze, plan, and gain explicit user approval BEFORE any code is written.
You are the gatekeeper between "intent" and "execution".

## Workflow

### CASE 1 — You received a "📋 Plan Review Required" message (existing task.md found)
This means an existing checklist was discovered. Your job:
1. Display the plan clearly as a numbered checklist with files and status.
2. Immediately call \`focus_decision\` to present approval options — do NOT write any code.
   - Question: "Plan loaded from task.md. Review the steps above — ready to execute?"
   - Options: ["Approve and start execution", "Modify a step", "Add more steps", "Scrap and re-plan from scratch"]

### CASE 2 — No existing plan (empty task.md or new project)
This means you must DISCOVER and BUILD the plan. Your job:
1. **Analyze the codebase first.** Explore relevant files, read READMEs, check package.json, look at existing structure. Be thorough.
2. **Identify ambiguities.** If the goal/scope is unclear, use \`focus_decision\` to narrow it down BEFORE writing tasks.
   - Keep questions binary or small-choice — never ask open-ended questions in plain text.
3. **Draft the plan.** Write a concrete, step-by-step checklist to \`task.md\` in this exact format:
   \`\`\`
   - [ ] Todo #1: <title> [Files: path/to/file.ts]
   - [ ] Todo #2: <title> [Files: path/to/other.ts, path/to/more.ts]
   \`\`\`
4. **Present the plan for approval** using \`focus_decision\`:
   - Question: "Here's the proposed plan. Ready to execute?"
   - Options: ["Approve and start execution", "Modify a step", "Add more steps", "Scrap and re-plan"]

## Rules
- You may explore and write implementation code if necessary. If you do, you MUST summarize your activity and any files you changed.
- ALWAYS use \`focus_decision\` for choices. Never ask questions in plain conversational text.
- If scope is unclear, ASK before drafting. A wrong plan is worse than a slow plan.
- Each Todo step should be atomic (one concern, one set of files).
- Allowed files per Todo must be explicit and minimal — this powers the drift blocker.
- Be concise. No lengthy preambles. Show → Ask → Done.`;

    } else if (agentName === "worker") {
      return `You are an expert Worker Agent embedded inside Pi Focus.

## Your Role
You implement ONE Todo step at a time, cleanly, and verify it works.
You operate under strict file-boundary rules enforced by the Drift Blocker.

## Rules
- Only edit the files listed in your [ACTIVE PLAN ANCHOR] context.
- If you need to touch an unlisted file, STOP and explain why — do not proceed silently.
- After implementing, run any available linter, type-checker, or test suite to verify correctness.
- Call the \`focus_mark_done\` tool when finished — DO NOT manually edit task.md to check off boxes.
- Be surgical — minimal, focused diffs. No collateral cleanup unless explicitly part of the Todo.
- When a step is done, report what you changed and what was verified.`;

    } else if (agentName === "reviewer") {
      return `You are an expert Reviewer Agent embedded inside Pi Focus.

## Your Role
You perform a thorough code review of all changes made during execution.

## Review Checklist
1. **Correctness** — Does the implementation match the Todo description?
2. **Type safety** — No \`any\` casts without justification. TypeScript compiles cleanly.
3. **Security** — No exposed secrets, no unsafe evals, no unvalidated inputs.
4. **Performance** — No obvious N+1s, no blocking sync calls in async contexts.
5. **Style** — Consistent with the surrounding codebase conventions.
6. **Tests** — Are there tests? Should there be? Are they passing?
7. **Drift** — Were any files modified outside the authorized list? Flag them.

Present findings as a structured report with PASS / WARN / FAIL per category.
Use \`focus_decision\` to ask the user how to handle any FAIL or WARN items.`;
    }

    return "You are a focused coding assistant. Be concise, precise, and verify your work.";
  }

  function isInsideHomeDotDir(cwd: string): boolean {
    const home = os.homedir();
    const normalizedCwd = path.normalize(cwd);
    const normalizedHome = path.normalize(home);
    
    if (normalizedCwd === normalizedHome) return true;
    if (!normalizedCwd.startsWith(normalizedHome)) return false;
    
    const relative = path.relative(normalizedHome, normalizedCwd);
    const firstSegment = relative.split(path.sep)[0];
    return firstSegment.startsWith(".");
  }

  function syncTaskMarkdown() {
    if (!taskFilePath) return;
    isWritingTaskFile = true;
    try {
      let content = `# Task Checklist: active plan progress\n\n`;
      content += `This checklist is managed by your pi-focus State Machine Orchestrator. You can check off items directly in your IDE!\n\n`;
      content += `**Active State:** \`${stateMachine.activeState.toUpperCase()}\`\n\n`;

      if (stateMachine.todos.length === 0) {
        content += `*No active tasks. Type \`/focus_plan\` in the terminal to start a planning session.*\n`;
      } else {
        for (const t of stateMachine.todos) {
          const checkbox = t.completed ? "[x]" : "[ ]";
          const activeArrow = t.id === stateMachine.activeTodoId ? " ← (active)" : "";
          const allowedFilesStr = t.allowedFiles.length > 0 ? ` [Files: ${t.allowedFiles.join(", ")}]` : "";
          content += `- ${checkbox} Todo #${t.id}: ${t.title}${allowedFilesStr}${activeArrow}\n`;
        }
      }

      fs.writeFileSync(taskFilePath, content, "utf-8");
    } catch (err) {
      console.error("[PI-FOCUS Orchestrator] Failed to write task.md:", err);
    } finally {
      setTimeout(() => {
        isWritingTaskFile = false;
      }, 200);
      triggerFooterRender();
    }
  }

  function parseTaskMarkdownFully(markdown: string): TodoItem[] {
    const lines = markdown.split("\n");
    const parsedTodos: TodoItem[] = [];

    for (const line of lines) {
      const match = line.match(/^\s*-\s*\[([ xX/])\]\s*Todo\s+#?(\d+):\s*([^\[\u2190]+)(?:\s*\[Files:\s*([^\]]+)\])?/i);
      if (match) {
        const completed = match[1].toLowerCase() === "x";
        const id = match[2];
        const title = match[3].trim();
        const filesStr = match[4] || "";
        const allowedFiles = filesStr
          ? filesStr.split(",").map(f => f.trim()).filter(Boolean)
          : [];
        parsedTodos.push({
          id,
          title,
          allowedFiles,
          description: `Implement ${title}`,
          completed
        });
      }
    }
    return parsedTodos;
  }

  function injectDecisionGuidelines(prompt: string): string {
    const decisionGuide = `\n\n[INTERACTIVE DECISIONS — PI-FOCUS]\nIf you need user feedback, requirement clarification, or design trade-offs before proceeding:\nDO NOT output conversational questions in your main text. \nInstead, invoke the 'focus_decision' tool, providing:\n1. 'question': The query details.\n2. 'options': A string array of pathways/options (e.g. ["Option A", "Option B"]).\n\nThis will present a clean, high-signal, non-blocking choice card to the user in-line.\n`;
    return prompt + decisionGuide;
  }

  // ─── 1. Tools Optimizer Logic ────────────────────────────────────────────────

  pi.registerCommand("tools_optimizer", {
    description: "Toggle the focus-tools-optimizer logic on or off",
    async handler(args, ctx) {
      isOptimizerEnabled = !isOptimizerEnabled;
      const status = isOptimizerEnabled ? "ENABLED" : "DISABLED";
      
      if (!isOptimizerEnabled) {
        pi.setActiveTools(pi.getAllTools().map(t => t.name));
      }
      
      if (ctx.hasUI) {
        ctx.ui.notify(`✦ pi-focus › Tools Optimizer is now ${status}`, isOptimizerEnabled ? "info" : "warning");
        triggerFooterRender();
      }
    }
  });

  const showHotkeys = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    
    // Define colors
    const cyan = "\x1b[96m";
    const white = "\x1b[37m";
    const dim = "\x1b[90m";
    const reset = "\x1b[39m";
    const bold = "\x1b[1m";
    const boldReset = "\x1b[22m";

    let hotkeysText = `
${cyan}${bold}✦ pi-focus — Quick Reference${boldReset}${reset}

${white}${bold}Focus Mode (Autonomous Workflow):${boldReset}${reset}
  ${cyan}🎯 PLANNING${reset}   ${dim}Agent researches and drafts a task.md checklist.${reset}
  ${cyan}⚡ EXECUTING${reset}  ${dim}Agent implements tasks one-by-one with drift protection.${reset}
  ${cyan}🔍 REVIEWING${reset}  ${dim}Agent performs a structured audit of all changes.${reset}

  ${dim}Manual Overrides:${reset}
  ${cyan}/focus_plan${reset}    ${dim}Restart planning   ${reset} ${cyan}/focus_review${reset}  ${dim}Start review${reset}
  ${cyan}/focus_resume${reset}  ${dim}Resume tasks       ${reset} ${cyan}/focus_help${reset}    ${dim}This screen${reset}

${white}${bold}Essential Shortcuts:${boldReset}${reset}
  ${cyan}Up / Down${reset}        ${dim}Browse history (Up when empty)${reset}
  ${cyan}Option+← / →${reset}     ${dim}Move by word${reset}
  ${cyan}Option+Enter${reset}     ${dim}Queue follow-up message${reset}
  ${cyan}Ctrl+L${reset}           ${dim}Open model selector / model info${reset}
  ${cyan}Escape${reset}           ${dim}Cancel / Abort streaming${reset}

${white}${bold}Prefixes:${boldReset}${reset}
  ${cyan}/${reset}                ${dim}Slash commands${reset}
  ${cyan}!${reset}                ${dim}Run bash command${reset}
  ${cyan}!!${reset}               ${dim}Run bash (exclude from LLM context)${reset}`;

    const focusCommands = ["focus_plan", "focus_resume", "focus_review", "focus_help", "tools_optimizer", "tools_optimizer"];
    const allCommands = pi.getCommands();
    
    // Show high-value commands with descriptions
    const sortedCommands = [...allCommands]
      .filter(cmd => !focusCommands.includes(cmd.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Then other commands (limited to avoid bloat)
    if (sortedCommands.length > 0) {
      hotkeysText += `\n\n${white}${bold}Other Commands:${boldReset}${reset}`;
      const displayLimit = 8;
      const toShow = sortedCommands.slice(0, displayLimit);
      
      for (const cmd of toShow) {
        const desc = cmd.description ? ` - ${cmd.description}` : "";
        const shortDesc = desc.length > 50 ? desc.substring(0, 47) + "..." : desc;
        hotkeysText += `\n  ${cyan}/${cmd.name}${reset}${dim}${shortDesc}${reset}`;
      }
      
      if (sortedCommands.length > displayLimit) {
        hotkeysText += `\n  ${dim}... and ${sortedCommands.length - displayLimit} more (type / to list all)${reset}`;
      }
    }

    // Agent Tools (Condensed)
    const tools = pi.getAllTools();
    const toolCount = tools.length;
    hotkeysText += `\n\n${white}${bold}Agent Capabilities:${boldReset}${reset}
  ${cyan}${toolCount} tools registered${reset} ${dim}(Agent uses these automatically)${reset}`;

    hotkeysText += `\n\n${dim}Type${reset} ${cyan}/hotkeys${reset} ${dim}for full keyboard shortcut documentation.${reset}
`;
    ctx.ui.notify(hotkeysText, "info");
  };

  pi.registerCommand("focus_help", {
    description: "Show pi-focus help and commands",
    async handler(args, ctx) {
      await showHotkeys(ctx);
    }
  });

  pi.registerShortcut("?" as any, {
    description: "Show pi-focus help",
    async handler(ctx) {
      await showHotkeys(ctx);
    }
  });

  pi.on("input", async (event, ctx) => {
    if (!isOptimizerEnabled) return;

    const text = event.text ? event.text.trim() : "";
    if (!text) return;

    if (text.length <= SHORT_MSG_THRESHOLD && !/\b(run|fix|read|show|find|build|test|git|npm|pip|go|cd|ls|rm|mv|cp)\b/i.test(text)) {
      activeCategory = "respond";
    } else {
      let bestCategory: keyof typeof CATEGORIES = DEFAULT_CATEGORY;
      let maxScore = -Infinity;

      for (const [name, cat] of Object.entries(CATEGORIES)) {
        let score = 0;
        for (const sig of cat.signals) {
          if (sig.re.test(text)) score += sig.w;
        }
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

    const allAvailableTools = pi.getAllTools().map(t => t.name);
    
    if (stateMachine.activeState !== "idle") {
      pi.setActiveTools(allAvailableTools);
      if (ctx.hasUI) {
        ctx.ui.notify(`✦ pi-focus › Tools Optimizer Bypassed - State is ${stateMachine.activeState.toUpperCase()}`, "info");
      }
      return;
    }

    const allowed = CATEGORIES[activeCategory].allowedTools;
    const toEnable = allAvailableTools.filter(t => {
      if (t === "focus_decision" || allowed.includes(t)) return true;

      if (activeCategory === "read" || activeCategory === "search") {
        if (/search|read|query|get|fetch|list|view/i.test(t)) return true;
      } else if (activeCategory === "write") {
        if (/write|edit|update|create|delete|remove|patch|make|run/i.test(t)) return true;
      }

      return false;
    });
    
    pi.setActiveTools(toEnable);

    if (ctx.hasUI) {
      const toolNames = toEnable.join(", ");
      ctx.ui.notify(`✦ pi-focus › Tools Optimizer: ${activeCategory.toUpperCase()} (Tools: ${toolNames})`, "info");
      triggerFooterRender();
    }
  });


  // ─── 2. Focus Mode Orchestrator Event Hooks ─────────────────────────────────
  
  // Note: Using any types due to incomplete TypeScript definitions in Pi Agent API
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (stateMachine.activeState === "planning") {
      const systemPrompt = loadAgentPrompt("planner");
      return { systemPrompt: injectDecisionGuidelines(systemPrompt) };
    } else if (stateMachine.activeState === "executing" && stateMachine.activeTodoId) {
      const systemPrompt = loadAgentPrompt("worker");
      const todo = stateMachine.getActiveTodo();
      const anchorPrompt = todo ? `\n\n[ACTIVE PLAN ANCHOR — PI-FOCUS]\nYou are currently executing Todo #${todo.id}: "${todo.title}"\nAuthorized files to edit: [${todo.allowedFiles.join(", ") || "None specified"}]\n\nPlease stick to the designated files. Verify edits against linter/compiler validations.\nDo NOT attempt collateral changes to unrelated modules.\n` : "";
      return { systemPrompt: injectDecisionGuidelines(systemPrompt + anchorPrompt) };
    } else if (stateMachine.activeState === "reviewing") {
      const systemPrompt = loadAgentPrompt("reviewer");
      return { systemPrompt: injectDecisionGuidelines(systemPrompt) };
    } else {
      return { systemPrompt: injectDecisionGuidelines(event.systemPrompt || "") };
    }
  });

  // Note: Using any types due to incomplete TypeScript definitions in Pi Agent API
  pi.on("tool_call", async (event: any, ctx: any) => {
    const toolName = event.toolName;
    const writeTools = ["write_file", "edit_file", "patch_file", "edit", "write", "create_file", "append_file"];

    if (stateMachine.activeState === "planning") {
      if (writeTools.includes(toolName)) {
        const targetPath = event.input?.path ? String(event.input.path) : "(unknown file)";

        const isTaskFile =
          targetPath === "task.md" ||
          targetPath === taskFilePath ||
          path.resolve(targetPath) === path.resolve(taskFilePath || "task.md");

        if (isTaskFile) {
          return;
        }

        if (ctx.hasUI) {
          // Create OS-specific file editor command
      const editorCommand = getOpenFileCommand(targetPath);
      ctx.ui.notify(`✦ pi-focus › Agent writing \`${path.basename(targetPath)}\` during planning mode. Click [file](file://${targetPath}) to open in editor.`, "info");
      // Also show command for users who can't click
      ctx.ui.notify(`✦ pi-focus › Editor command: \`${editorCommand}\``, "info");
        }
        return;
      }
      return;
    }

    if (stateMachine.activeState !== "executing") return;

    const todo = stateMachine.getActiveTodo();
    if (!todo || todo.allowedFiles.length === 0) return;

    if (writeTools.includes(toolName)) {
      const targetPath = event.input?.path ? String(event.input.path) : "";
      if (!targetPath) return;

      const normalizedTarget = path.normalize(targetPath);
      
      const isAllowed = todo.allowedFiles.some(allowed => {
        const normalizedAllowed = path.normalize(allowed);
        return (
          normalizedTarget === normalizedAllowed ||
          normalizedTarget.endsWith(path.sep + normalizedAllowed) ||
          normalizedAllowed.endsWith(path.sep + normalizedTarget)
        );
      });

      if (!isAllowed) {
        if (ctx.hasUI) {
          const editorCommand = getOpenFileCommand(targetPath);
        ctx.ui.notify(`✦ pi-focus › Drift Blocked: \`${targetPath}\`. Click [file](file://${targetPath}) to open in editor.`, "error");
        ctx.ui.notify(`✦ pi-focus › Editor command: \`${editorCommand}\``, "error");

          const approve = await ctx.ui.confirm(
            "⚠️ PI-FOCUS Drift Intercepted",
            `Worker agent is attempting to edit: "${targetPath}".\nThis file is outside the whitelisted path boundaries for this Todo.\n\nDo you want to authorize editing this file?`
          );

          if (approve) {
            todo.allowedFiles.push(targetPath);
            const activeTodo = stateMachine.getActiveTodo();
            if (activeTodo) {
              activeTodo.allowedFiles.push(normalizedTarget);
            }
            syncTaskMarkdown();
            const editorCommand = getOpenFileCommand(targetPath);
            ctx.ui.notify(`✦ pi-focus › Whitelisted file path: \`${targetPath}\`. Click [file](file://${targetPath}) to open in editor.`, "info");
            ctx.ui.notify(`✦ pi-focus › Editor command: \`${editorCommand}\``, "info");
            return;
          }

          const rePlan = await ctx.ui.confirm(
            "🔄 Launch Re-planning Session?",
            `You blocked the edit to "${targetPath}". Do you want to pause execution and launch a quick re-planning session to adjust your strategy?`
          );

          if (rePlan) {
            stateMachine.activeState = "planning";
            syncTaskMarkdown();
            ctx.ui.notify(`✦ pi-focus › Session pivoted to PLANNING mode`, "info");
      const editorCommand = getOpenFileCommand(taskFilePath);
      ctx.ui.notify(`✦ pi-focus › Task file: [task.md](file://${taskFilePath}) - \`${editorCommand}\``, "info");
            pi.sendUserMessage(`/focus_plan`, { deliverAs: "followUp" });

            return {
              block: true,
              reason: `[PI-FOCUS PIVOT] Worker execution paused. Swapping session back to Planning Mode.`
            };
          }
        }

        return {
          block: true,
          reason: `[DRIFT BLOCKED] You are attempting to edit: "${targetPath}". \nAuthorized files to modify for Todo #${todo.id} are strictly: [${todo.allowedFiles.join(", ")}].\nDo NOT edit other paths.`
        };
      }
    }
  });


  // ─── 3. Global Slash Commands ───────────────────────────────────────────────

  pi.registerCommand("focus_plan", {
    description: "Swaps session to PLANNING mode instantly and analyzes codebase",
    async handler(args, ctx) {
      stateMachine.activeState = "planning";
      stateMachine.todos = [];
      stateMachine.activeTodoId = null;
      syncTaskMarkdown();
      ctx.ui.notify("✦ pi-focus › Pivoted to Planning Mode", "info");
      const editorCommand = getOpenFileCommand(taskFilePath);
      ctx.ui.notify(`✦ pi-focus › Task file: [task.md](file://${taskFilePath}) - \`${editorCommand}\``, "info");
      pi.sendUserMessage("Let's plan the architecture and checklist steps for this task.");
    }
  });

  pi.registerCommand("focus_review", {
    description: "Swaps session to REVIEWING mode instantly to inspect modifications",
    async handler(args, ctx) {
      stateMachine.activeState = "reviewing";
      syncTaskMarkdown();
      ctx.ui.notify("✦ pi-focus › Swapped to Code Review Mode", "info");
      const editorCommand = getOpenFileCommand(taskFilePath);
      ctx.ui.notify(`✦ pi-focus › Task file: [task.md](file://${taskFilePath}) - \`${editorCommand}\``, "info");
      pi.sendUserMessage("Please review the changes I've made in the repository.");
    }
  });

  pi.registerCommand("focus_resume", {
    description: "Review and resume an incomplete plan from task.md",
    async handler(args, ctx) {
      if (!taskFilePath || !fs.existsSync(taskFilePath)) {
        ctx.ui.notify("✦ pi-focus › No task.md found in this workspace.", "warning");
        ctx.ui.notify("✦ pi-focus › Create task.md to start planning sessions.", "warning");
        return;
      }

      const content = fs.readFileSync(taskFilePath, "utf-8");
      const loadedTodos = parseTaskMarkdownFully(content);
      const incomplete = loadedTodos.filter(t => !t.completed);

      if (!incomplete || incomplete.length === 0) {
        ctx.ui.notify("✦ pi-focus › All tasks are already complete. Use /focus_plan to start something new.", "info");
        return;
      }

      stateMachine.todos = loadedTodos;
      stateMachine.activeTodoId = incomplete[0].id;
      stateMachine.activeState = "planning";
      syncTaskMarkdown();

      const todoLines = loadedTodos
        .map(t => {
          const check = t.completed ? "[x]" : "[ ]";
          const files = t.allowedFiles.length > 0 ? ` → [${t.allowedFiles.join(", ")}]` : "";
          const next = t.id === incomplete[0].id ? " ← NEXT" : "";
          return `  ${check} Todo #${t.id}: ${t.title}${files}${next}`;
        })
        .join("\n");

      const reviewMessage = `📋 **Resume Plan**\n\n${incomplete.length} step(s) remaining in \`task.md\`:\n\n${todoLines}\n\nPlease review the plan above. When ready, call focus_decision with these exact options:\n- "Approve and start execution" — begin working on the next incomplete step\n- "Modify the plan" — change or remove steps before starting\n- "Add more steps" — append additional todos\n- "Already done — clear the plan" — everything is complete, reset to idle\n- "Scrap and re-plan from scratch" — discard everything and start fresh`;

      pi.sendUserMessage(reviewMessage);
    }
  });

  // ─── 4. Tools & Capabilities ────────────────────────────────────────────────

  pi.registerTool({
    name: "focus_decision",
    label: "Inline Decision Handshake",
    description: "Suspends execution and presents a structured in-line multiple-choice question to the user.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" } }
      },
      required: ["question", "options"]
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const question = String(params.question || "");
      const options = (params.options || []) as string[];

      if (options.length === 0) {
        return { content: [{ type: "text", text: "Error: options array cannot be empty." }], details: {} };
      }

      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: `[FALLBACK CHOICE] Selected Option #1: "${options[0]}"` }],
          details: { question, options, answer: options[0], wasCustom: false, index: 1 }
        };
      }

      const allOptions = [
        ...options.map((o) => ({ label: o, isOther: false })),
        { label: "Type something.", isOther: true }
      ];

      const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean; index?: number } | null>(
        (tui, theme, _kb, done) => {
          let optionIndex = 0;
          let editMode = false;
          let cachedLines: string[] | undefined;

          const editorTheme: EditorTheme = {
            borderColor: (s) => theme.fg("accent", s),
            selectList: {
              selectedPrefix: (t) => theme.fg("accent", t),
              selectedText: (t) => theme.fg("accent", t),
              description: (t) => theme.fg("muted", t),
              scrollInfo: (t) => theme.fg("dim", t),
              noMatch: (t) => theme.fg("warning", t),
            },
          };
          const editor = new Editor(tui, editorTheme);

          editor.onSubmit = (value) => {
            const trimmed = value.trim();
            if (trimmed) { done({ answer: trimmed, wasCustom: true }); } 
            else { editMode = false; editor.setText(""); refresh(); }
          };

          function refresh() { cachedLines = undefined; tui.requestRender(); }

          function handleInput(data: string) {
            if (editMode) {
              if (matchesKey(data, Key.escape)) { editMode = false; editor.setText(""); refresh(); return; }
              editor.handleInput(data); refresh(); return;
            }
            if (matchesKey(data, Key.up)) { optionIndex = Math.max(0, optionIndex - 1); refresh(); return; }
            if (matchesKey(data, Key.down)) { optionIndex = Math.min(allOptions.length - 1, optionIndex + 1); refresh(); return; }
            if (matchesKey(data, Key.enter)) {
              const selected = allOptions[optionIndex];
              if (selected.isOther) { editMode = true; refresh(); } 
              else { done({ answer: selected.label, wasCustom: false, index: optionIndex + 1 }); }
              return;
            }
            if (matchesKey(data, Key.escape)) { done(null); }
          }

          function render(width: number): string[] {
            if (cachedLines) return cachedLines;
            const lines: string[] = [];
            const add = (s: string) => lines.push(truncateToWidth(s, width));

            add(theme.fg("accent", "─".repeat(width)));
            add(theme.fg("accent", theme.bold("  🌌 DECISION HANDSHAKE — PI-FOCUS")));
            add(theme.fg("accent", "─".repeat(width)));
            add(theme.fg("text", theme.bold("  ❓ Question:")));
            
            const qLines = question.split("\n");
            for (const qLine of qLines) { add(theme.fg("text", `     ${qLine}`)); }

            add(theme.fg("accent", "─".repeat(width)));
            add(theme.fg("text", theme.bold("  🔢 Choices:")));

            for (let i = 0; i < allOptions.length; i++) {
              const opt = allOptions[i];
              const selected = i === optionIndex;
              const prefix = selected ? theme.fg("accent", "  > ") : "    ";
              const color = selected ? "accent" : "text";
              if (opt.isOther && editMode) { add(prefix + theme.fg("accent", `[${i + 1}] ${opt.label} ✎`)); } 
              else { add(prefix + theme.fg(color, `[${i + 1}] ${opt.label}`)); }
            }

            if (editMode) {
              lines.push(""); add("  " + theme.fg("muted", " Your answer:"));
              for (const line of editor.render(width - 4)) { add(`    ${line}`); }
            }

            lines.push("");
            if (editMode) { add("  " + theme.fg("dim", "Enter to submit • Esc to go back")); } 
            else { add("  " + theme.fg("dim", "↑↓ navigate • Enter to select • Esc to cancel")); }
            add(theme.fg("accent", "─".repeat(width)));

            cachedLines = lines; return lines;
          }

          return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
        }
      );

      if (!result) {
        return { content: [{ type: "text", text: "User cancelled the selection" }], details: { question, options, answer: null } };
      }

      const selectedAnswer = result.answer;
      const isApproval = selectedAnswer === "Approve and start execution" || 
                         selectedAnswer === "Approve and start working" ||
                         selectedAnswer.toLowerCase().includes("approve and start") ||
                         selectedAnswer.toLowerCase().includes("approve plan");

      if (isApproval) {
        if (fs.existsSync(taskFilePath)) {
          try {
            const content = fs.readFileSync(taskFilePath, "utf-8");
            const loadedTodos = parseTaskMarkdownFully(content);
            if (loadedTodos.length > 0) {
              stateMachine.todos = loadedTodos;
              const incomplete = loadedTodos.find(t => !t.completed);
              if (incomplete) {
                stateMachine.activeState = "executing";
                stateMachine.activeTodoId = incomplete.id;
              } else {
                stateMachine.activeState = "idle";
                stateMachine.activeTodoId = null;
                const editorCommand = getOpenFileCommand(taskFilePath);
        ctx.ui.notify(`✦ pi-focus › All tasks complete. Use /focus_plan to start a new session.`, "info");
        ctx.ui.notify(`✦ pi-focus › Task file: [task.md](file://${taskFilePath}) - \`${editorCommand}\``, "info");
              }
            } else {
              stateMachine.activeState = "idle";
              stateMachine.activeTodoId = null;
              const editorCommand = getOpenFileCommand(taskFilePath);
              ctx.ui.notify(`✦ pi-focus › No tasks found. Use /focus_plan to start a new session.`, "info");
              ctx.ui.notify(`✦ pi-focus › Task file: [task.md](file://${taskFilePath}) - \`${editorCommand}\``, "info");
            }
          } catch {
            stateMachine.activeState = "idle";
            stateMachine.activeTodoId = null;
            console.error("[PI-FOCUS] Failed to approve plan, resetting to idle state");
          }
        } else {
          stateMachine.activeState = "executing";
          stateMachine.activeTodoId = "1";
        }
        
        syncTaskMarkdown();
        if (ctx.hasUI) { 
          ctx.ui.notify(`✦ pi-focus › Plan Approved! Swapped to EXECUTING (Todo #${stateMachine.activeTodoId} active)`, "info"); 
          const editorCommand = getOpenFileCommand(taskFilePath);
          ctx.ui.notify(`✦ pi-focus › Task file: [task.md](file://${taskFilePath}) - \`${editorCommand}\``, "info"); 
        }
      }

      const isAlreadyDone = selectedAnswer === "Already done — clear the plan" || selectedAnswer.toLowerCase().includes("already done") || selectedAnswer.toLowerCase().includes("clear the plan") || selectedAnswer.toLowerCase().includes("all done");

      if (isAlreadyDone) {
        stateMachine.todos.forEach(t => { t.completed = true; });
        stateMachine.activeState = "idle";
        stateMachine.activeTodoId = null;

        if (taskFilePath) {
          isWritingTaskFile = true;
          try {
            const doneContent = `# Task Checklist: active plan progress\n\nThis checklist is managed by your pi-focus State Machine Orchestrator.\n\n**Active State:** \`IDLE\`\n\n*All tasks completed. Start a new session with \`/focus_plan\` when ready.*\n`;
            fs.writeFileSync(taskFilePath, doneContent, "utf-8");
          } catch (err) {
            console.error("[PI-FOCUS] Failed to write completed task.md:", err);
          }
          finally { setTimeout(() => { isWritingTaskFile = false; }, 200); }
        }

        if (ctx.hasUI) { 
          ctx.ui.notify("✦ pi-focus › Plan cleared — back to IDLE", "info"); 
          const editorCommand = getOpenFileCommand(taskFilePath);
          ctx.ui.notify(`✦ pi-focus › Task file: [task.md](file://${taskFilePath}) - \`${editorCommand}\``, "info"); 
        }
      }

      if (result.wasCustom) {
        return { content: [{ type: "text", text: `[USER CHOICE] Selected custom write-in: "${result.answer}"` }], details: { question, options, answer: result.answer, wasCustom: true } };
      }
      return { content: [{ type: "text", text: `[USER CHOICE] Selected Option #${result.index}: "${result.answer}"` }], details: { question, options, answer: result.answer, wasCustom: false, index: result.index } };
    }
  });

  pi.registerTool({
    name: "focus_mark_done",
    label: "Mark Todo Complete",
    description: "Use this tool to mark the currently active Todo step as complete. This structurally advances the state machine and updates task.md. DO NOT manually edit task.md to check off boxes.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (stateMachine.activeState !== "executing" || !stateMachine.activeTodoId) {
        return { content: [{ type: "text", text: "Error: No active Todo is currently executing." }], details: {} };
      }

      const activeId = stateMachine.activeTodoId;
      const todo = stateMachine.getActiveTodo();
      if (!todo) { return { content: [{ type: "text", text: `Error: Active Todo #${activeId} not found.` }], details: {} }; }

      todo.completed = true;

      const nextIncomplete = stateMachine.todos.find(t => !t.completed);
      
      if (nextIncomplete) {
        stateMachine.activeTodoId = nextIncomplete.id;
        syncTaskMarkdown();
        if (ctx.hasUI) { 
          ctx.ui.notify(`✦ pi-focus › Todo #${activeId} complete. Moving to Todo #${nextIncomplete.id}`, "info"); 
          const editorCommand = getOpenFileCommand(taskFilePath);
          ctx.ui.notify(`✦ pi-focus › Task file: [task.md](file://${taskFilePath}) - \`${editorCommand}\``, "info"); 
        }
        return { content: [{ type: "text", text: `Success: Todo #${activeId} marked complete. State machine advanced to Todo #${nextIncomplete.id}: "${nextIncomplete.title}".` }], details: { nextTodoId: nextIncomplete.id, nextTitle: nextIncomplete.title } };
      } else {
        stateMachine.activeTodoId = null;
        stateMachine.activeState = "idle";
        syncTaskMarkdown();
        if (ctx.hasUI) { 
          ctx.ui.notify(`✦ pi-focus › All Todos completed! State reset to IDLE.`, "info"); 
          const editorCommand = getOpenFileCommand(taskFilePath);
          ctx.ui.notify(`✦ pi-focus › Task file: [task.md](file://${taskFilePath}) - \`${editorCommand}\``, "info"); 
        }
        return { content: [{ type: "text", text: `Success: Todo #${activeId} marked complete. All tasks are now finished. State machine reset to IDLE.` }], details: { nextTodoId: null, allComplete: true } };
      }
    }
  });

  // ─── 5. Live Workspace File Watcher (task.md) ─────────────────────────────
  
  function initializeOrchestrator(ctx: ExtensionContext) {
    if (taskWatcher) { try { taskWatcher.close(); } catch (err) { console.error("[PI-FOCUS] Failed to close task watcher:", err); } taskWatcher = null; }

    if (isInsideHomeDotDir(ctx.cwd)) { taskFilePath = ""; return; }

    const focusDir = path.join(ctx.cwd, ".focus");
    if (!fs.existsSync(focusDir)) { fs.mkdirSync(focusDir, { recursive: true }); }
    taskFilePath = path.join(focusDir, "task.md");

    if (fs.existsSync(taskFilePath)) {
      try {
        const content = fs.readFileSync(taskFilePath, "utf-8");
        const loadedTodos = parseTaskMarkdownFully(content);
        if (loadedTodos.length > 0) {
          stateMachine.todos = loadedTodos;
          const incomplete = loadedTodos.find(t => !t.completed);
          if (incomplete) {
            stateMachine.activeState = "idle";
            stateMachine.activeTodoId = incomplete.id;
            if (ctx.hasUI) { 
              ctx.ui.notify(`📋 Incomplete plan found (${loadedTodos.filter(t => !t.completed).length} step(s) remaining) — type /focus_resume to continue`, "info"); 
              const editorCommand = getOpenFileCommand(taskFilePath);
              ctx.ui.notify(`✦ pi-focus › Task file: [task.md](file://${taskFilePath}) - \`${editorCommand}\``, "info"); 
            }
          } else {
            stateMachine.activeState = "idle";
            stateMachine.activeTodoId = null;
          }
        } else {
          stateMachine.activeState = "planning";
          stateMachine.todos = [];
          stateMachine.activeTodoId = null;
        }
      } catch (err) { console.error("[PI-FOCUS] Failed to parse existing task.md:", err); }
    } else {
      stateMachine.activeState = "planning";
      stateMachine.todos = [];
      stateMachine.activeTodoId = null;
      syncTaskMarkdown();
    }

    if (ctx.hasUI) {
      let version = "1.1.0";
      try {
        const pkgPath = path.join(__dirname, "../package.json");
        if (fs.existsSync(pkgPath)) { version = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version || version; }
      } catch (e) {}
      
      if (stateMachine.activeState === "idle" || stateMachine.activeState === "planning") {
        ctx.ui.notify(`✦ pi-focus v${version} loaded. Enforcing autonomous AI workflows. Use /focus_plan to begin.`, "info");
        const editorCommand = getOpenFileCommand(taskFilePath);
        ctx.ui.notify(`✦ pi-focus › Task file: [task.md](file://${taskFilePath}) - \`${editorCommand}\``, "info");
      }
    }

    try {
      const parentDir = path.dirname(taskFilePath);
      const fileName = path.basename(taskFilePath);

      if (fs.existsSync(parentDir)) {
        taskWatcher = fs.watch(parentDir, (eventType, filename) => {
          if (filename === fileName && eventType === "change" && !isWritingTaskFile) {
            try {
              if (fs.existsSync(taskFilePath)) {
                const content = fs.readFileSync(taskFilePath, "utf-8");
                const markdownState = parseTaskMarkdownFully(content);
                
                let stateChanged = false;
                const newTodos: TodoItem[] = [];

                for (const m of markdownState) {
                  const match = stateMachine.todos.find(t => t.id === m.id);
                  if (match) {
                    if (m.completed !== match.completed) {
                      match.completed = m.completed;
                      stateChanged = true;
                      
                      if (m.completed && stateMachine.activeTodoId === m.id) {
                        stateMachine.activeTodoId = null;
                        const nextIncomplete = markdownState.find(t => t.id !== m.id && !t.completed);
                        if (nextIncomplete) {
                          stateMachine.activeTodoId = nextIncomplete.id;
                          stateMachine.activeState = "executing";
                          pi.sendUserMessage(`I completed Todo #${m.id} in task.md. Moving on to Todo #${nextIncomplete.id}: "${nextIncomplete.title}".`, { deliverAs: "followUp" });
                        } else {
                          stateMachine.activeState = "idle";
                          pi.sendUserMessage(`I completed all tasks in task.md.`, { deliverAs: "followUp" });
                        }
                      } else if (!m.completed && stateMachine.activeState === "idle") {
                        stateMachine.activeTodoId = m.id;
                        stateMachine.activeState = "executing";
                        pi.sendUserMessage(`I detected that you unmarked Todo #${m.id}. Resuming execution.`, { deliverAs: "followUp" });
                      }
                    }
                    newTodos.push({ ...match, title: m.title, allowedFiles: m.allowedFiles, completed: m.completed });
                  } else {
                    newTodos.push(m);
                    stateChanged = true;
                  }
                }

                if (stateChanged || newTodos.length !== stateMachine.todos.length) {
                  stateMachine.todos = newTodos;
                  syncTaskMarkdown();
                }
              }
            } catch (err) { console.error("[PI-FOCUS Watcher] Error synchronizing task.md edits:", err); }
          }
        });
      }
    } catch (err) { console.warn("[PI-FOCUS Watcher] Could not establish task.md watch listener:", err); }
  }

  pi.on("session_start", async (_event, ctx) => { 
    initializeOrchestrator(ctx); 
    if (ctx.hasUI) {
      ctx.ui.setFooter(createStatusBarFactory(ctx, {
        getActiveState: () => stateMachine.activeState,
        getOptimizerStatus: () => ({ enabled: isOptimizerEnabled, category: activeCategory }),
        getToolsCount: () => pi.getAllTools().length,
        getActiveToolsCount: () => pi.getActiveTools().length,
        getSkillFilesCount: () => countSkillFiles(ctx)
      }));
    }
  });
  pi.on("agent_start", async (_event, ctx) => { initializeOrchestrator(ctx); });

}
