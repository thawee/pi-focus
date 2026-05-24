import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";


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

  const stateMachine = new StateMachine();
  (global as any).piFocusState = stateMachine;
  let isWritingTaskFile = false;
  let taskWatcher: fs.FSWatcher | null = null;
  let taskFilePath = "";


  // ─── Embedded Agent Prompts (self-contained, no external file dependency) ────

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

  // Helper: Detect if a directory path is home or a hidden dot folder directly under home
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

  // Helper: Re-generate task.md workspace file
  function syncTaskMarkdown() {
    if (!taskFilePath) return;
    isWritingTaskFile = true;
    try {
      let content = `# Task Checklist: active plan progress\n\n`;
      content += `This checklist is managed by your pi-focus State Machine Orchestrator. You can check off items directly in your IDE!\n\n`;
      content += `**Active State:** \`${stateMachine.activeState.toUpperCase()}\`\n\n`;

      if (stateMachine.todos.length === 0) {
        content += `*No active tasks. Type \`/plan\` in the terminal to start a planning session.*\n`;
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
    }
  }

  // Helper: Parse workspace task.md checkboxes and titles fully
  function parseTaskMarkdownFully(markdown: string): TodoItem[] {
    const lines = markdown.split("\n");
    const parsedTodos: TodoItem[] = [];

    for (const line of lines) {
      // Matches: - [ ] Todo #1: Some Title [Files: src/main.ts]
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


  // Helper: Append interactive decision-making guidelines to any prompt
  function injectDecisionGuidelines(prompt: string): string {
    const decisionGuide = `

[INTERACTIVE DECISIONS — PI-FOCUS]
If you need user feedback, requirement clarification, or design trade-offs before proceeding:
DO NOT output conversational questions in your main text. 
Instead, invoke the 'focus_decision' tool, providing:
1. 'question': The query details.
2. 'options': A string array of pathways/options (e.g. ["Option A", "Option B"]).

This will present a clean, high-signal, non-blocking choice card to the user in-line.
`;
    return prompt + decisionGuide;
  }

  // ─── 1. Core Event hooks: Prompt Hot-Swapping ──────────────────────────────
  
  pi.on("before_agent_start", async (event, ctx) => {
    // If in custom planning or worker state, dynamically swap out the turn's system instructions
    if (stateMachine.activeState === "planning") {
      const systemPrompt = loadAgentPrompt("planner");
      return { systemPrompt: injectDecisionGuidelines(systemPrompt) };
    } else if (stateMachine.activeState === "executing" && stateMachine.activeTodoId) {
      const systemPrompt = loadAgentPrompt("worker");
      const todo = stateMachine.getActiveTodo();
      const anchorPrompt = todo ? `

[ACTIVE PLAN ANCHOR — PI-FOCUS]
You are currently executing Todo #${todo.id}: "${todo.title}"
Authorized files to edit: [${todo.allowedFiles.join(", ") || "None specified"}]

Please stick to the designated files. Verify edits against linter/compiler validations.
Do NOT attempt collateral changes to unrelated modules.
` : "";
      return { systemPrompt: injectDecisionGuidelines(systemPrompt + anchorPrompt) };
    } else if (stateMachine.activeState === "reviewing") {
      const systemPrompt = loadAgentPrompt("reviewer");
      return { systemPrompt: injectDecisionGuidelines(systemPrompt) };
    } else {
      // In idle / standard conversation mode, still inject the guidelines into the active system prompt
      return { systemPrompt: injectDecisionGuidelines(event.systemPrompt) };
    }
  });


  // ─── 2. Write Guard / Drift Blocker ────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    const ev = event as any;
    const toolName = ev.toolName;
    const writeTools = ["write_file", "edit_file", "patch_file", "edit", "write", "create_file", "append_file"];

    // ── PLANNING GATE: Hard-block ALL writes until plan is approved ────────────
    if (stateMachine.activeState === "planning") {
      if (writeTools.includes(toolName)) {
        const targetPath = ev.input?.path ? String(ev.input.path) : "(unknown file)";

        // ✅ Always allow writing task.md — that IS the plan file
        const isTaskFile =
          targetPath === "task.md" ||
          targetPath === taskFilePath ||
          path.resolve(targetPath) === path.resolve(taskFilePath || "task.md");

        if (isTaskFile) {
          return; // Allow task.md writes freely during planning
        }

        // Soft status — info level so user knows a file is being written during planning
        if (ctx.hasUI) {
          ctx.ui.notify(`✦ pi-focus › Agent writing ${path.basename(targetPath)} during planning mode`, "info");
        }

        // Allow writes during planning mode to let the agent work as intended
        return;
      }
      return; // Allow reads/non-write tools freely during planning
    }

    // ── EXECUTING GATE: Drift blocker — only allow whitelisted files ──────────
    if (stateMachine.activeState !== "executing") return;

    const todo = stateMachine.getActiveTodo();
    if (!todo || todo.allowedFiles.length === 0) return;

    // Intercept filesystem write tools
    if (writeTools.includes(toolName)) {
      const targetPath = ev.input?.path ? String(ev.input.path) : "";
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
          ctx.ui.notify(`✦ pi-focus › Drift Blocked: ${targetPath}`, "error");

          // Interactive Whitelist Confirmation Dialog
          const approve = await ctx.ui.confirm(
            "⚠️ PI-FOCUS Drift Intercepted",
            `Worker agent is attempting to edit: "${targetPath}".\nThis file is outside the whitelisted path boundaries for this Todo.\n\nDo you want to authorize editing this file?`
          );

          if (approve) {
            todo.allowedFiles.push(targetPath);
            stateMachine.getActiveTodo()!.allowedFiles.push(normalizedTarget);
            syncTaskMarkdown();
            ctx.ui.notify(`✦ pi-focus › Whitelisted file path: ${targetPath}`, "info");
            return; // Returns undefined, allowing tool call to proceed!
          }

          // Interactive Re-planning Confirmation Dialog
          const rePlan = await ctx.ui.confirm(
            "🔄 Launch Re-planning Session?",
            `You blocked the edit to "${targetPath}". Do you want to pause execution and launch a quick re-planning session to adjust your strategy?`
          );

          if (rePlan) {
            stateMachine.activeState = "planning";
            syncTaskMarkdown();
            ctx.ui.notify(`✦ pi-focus › Session pivoted to PLANNING mode`, "info");
            pi.sendUserMessage(`/plan`, { deliverAs: "followUp" });

            return {
              block: true,
              reason: `[PI-FOCUS PIVOT] Worker execution paused. Swapping session back to Planning Mode.`
            };
          }
        }

        // Return block result to abort tool run safely
        return {
          block: true,
          reason: `[DRIFT BLOCKED] You are attempting to edit: "${targetPath}". 
Authorized files to modify for Todo #${todo.id} are strictly: [${todo.allowedFiles.join(", ")}].
Do NOT edit other paths.`
        };
      }
    }
  });


  // ─── 3. Global Slash Commands (Process-less Handoffs) ──────────────────────

  // Command: /focus_plan
  pi.registerCommand("focus_plan", {
    description: "Swaps session to PLANNING mode instantly and analyzes codebase",
    async handler(args, ctx) {
      stateMachine.activeState = "planning";
      stateMachine.todos = [];
      stateMachine.activeTodoId = null;
      syncTaskMarkdown();
      ctx.ui.notify("✦ pi-focus › Pivoted to Planning Mode", "info");
      pi.sendUserMessage("Let's plan the architecture and checklist steps for this task.");
    }
  });

  // Command: /focus_review
  pi.registerCommand("focus_review", {
    description: "Swaps session to REVIEWING mode instantly to inspect modifications",
    async handler(args, ctx) {
      stateMachine.activeState = "reviewing";
      syncTaskMarkdown();
      ctx.ui.notify("✦ pi-focus › Swapped to Code Review Mode", "info");
      pi.sendUserMessage("Please review the changes I've made in the repository.");
    }
  });

  // Command: /focus_resume — user-triggered plan review after startup
  pi.registerCommand("focus_resume", {
    description: "Review and resume an incomplete plan from task.md",
    async handler(args, ctx) {
      if (!taskFilePath || !fs.existsSync(taskFilePath)) {
        ctx.ui.notify("✦ pi-focus › No task.md found in this workspace.", "warning");
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
      stateMachine.activeState = "planning"; // Planning gate active until approved
      syncTaskMarkdown();

      const todoLines = loadedTodos
        .map(t => {
          const check = t.completed ? "[x]" : "[ ]";
          const files = t.allowedFiles.length > 0 ? ` → [${t.allowedFiles.join(", ")}]` : "";
          const next = t.id === incomplete[0].id ? " ← NEXT" : "";
          return `  ${check} Todo #${t.id}: ${t.title}${files}${next}`;
        })
        .join("\n");

      const reviewMessage = `📋 **Resume Plan**

${incomplete.length} step(s) remaining in \`task.md\`:

${todoLines}

Please review the plan above. When ready, call focus_decision with these exact options:
- "Approve and start execution" — begin working on the next incomplete step
- "Modify the plan" — change or remove steps before starting
- "Add more steps" — append additional todos
- "Already done — clear the plan" — everything is complete, reset to idle
- "Scrap and re-plan from scratch" — discard everything and start fresh`;

      pi.sendUserMessage(reviewMessage);
    }
  });

  // Tool: focus_decision (Asynchronous inline conversational questioner)
  pi.registerTool({
    name: "focus_decision",
    label: "Inline Decision Handshake",
    description: "Suspends execution and presents a structured in-line multiple-choice question to the user to choose between discrete options or provide a custom response. Use this tool ONLY when you need the user to choose between a list of concrete options or pathways. DO NOT call this tool for standard conversational questions or normal Q&A where you can just write normal text.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The requirement clarification or design trade-off question to present to the user."
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "A list of discrete option strings representing the different pathways or solutions."
        }
      },
      required: ["question", "options"]
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const question = String(params.question || "");
      const options = (params.options || []) as string[];

      if (options.length === 0) {
        return {
          content: [{ type: "text", text: "Error: options array cannot be empty." }],
          details: {}
        };
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
            if (trimmed) {
              done({ answer: trimmed, wasCustom: true });
            } else {
              editMode = false;
              editor.setText("");
              refresh();
            }
          };

          function refresh() {
            cachedLines = undefined;
            tui.requestRender();
          }

          function handleInput(data: string) {
            if (editMode) {
              if (matchesKey(data, Key.escape)) {
                editMode = false;
                editor.setText("");
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
              return;
            }

            if (matchesKey(data, Key.up)) {
              optionIndex = Math.max(0, optionIndex - 1);
              refresh();
              return;
            }
            if (matchesKey(data, Key.down)) {
              optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
              refresh();
              return;
            }

            if (matchesKey(data, Key.enter)) {
              const selected = allOptions[optionIndex];
              if (selected.isOther) {
                editMode = true;
                refresh();
              } else {
                done({ answer: selected.label, wasCustom: false, index: optionIndex + 1 });
              }
              return;
            }

            if (matchesKey(data, Key.escape)) {
              done(null);
            }
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
            for (const qLine of qLines) {
              add(theme.fg("text", `     ${qLine}`));
            }

            add(theme.fg("accent", "─".repeat(width)));
            add(theme.fg("text", theme.bold("  🔢 Choices:")));

            for (let i = 0; i < allOptions.length; i++) {
              const opt = allOptions[i];
              const selected = i === optionIndex;
              const prefix = selected ? theme.fg("accent", "  > ") : "    ";
              const color = selected ? "accent" : "text";

              if (opt.isOther && editMode) {
                add(prefix + theme.fg("accent", `[${i + 1}] ${opt.label} ✎`));
              } else {
                add(prefix + theme.fg(color, `[${i + 1}] ${opt.label}`));
              }
            }

            if (editMode) {
              lines.push("");
              add("  " + theme.fg("muted", " Your answer:"));
              for (const line of editor.render(width - 4)) {
                add(`    ${line}`);
              }
            }

            lines.push("");
            if (editMode) {
              add("  " + theme.fg("dim", "Enter to submit • Esc to go back"));
            } else {
              add("  " + theme.fg("dim", "↑↓ navigate • Enter to select • Esc to cancel"));
            }
            add(theme.fg("accent", "─".repeat(width)));

            cachedLines = lines;
            return lines;
          }

          return {
            render,
            invalidate: () => {
              cachedLines = undefined;
            },
            handleInput,
          };
        }
      );

      if (!result) {
        return {
          content: [{ type: "text", text: "User cancelled the selection" }],
          details: { question, options, answer: null }
        };
      }

      // Automatically pivot state machine to executing if user approves the plan
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
                stateMachine.activeState = "executing";
                stateMachine.activeTodoId = "1";
              }
            } else {
              stateMachine.activeState = "executing";
              stateMachine.activeTodoId = "1";
            }
          } catch {
            stateMachine.activeState = "executing";
            stateMachine.activeTodoId = "1";
          }
        } else {
          stateMachine.activeState = "executing";
          stateMachine.activeTodoId = "1";
        }
        
        syncTaskMarkdown();
        if (ctx.hasUI) {
          ctx.ui.notify(`✦ pi-focus › Plan Approved! Swapped to EXECUTING (Todo #${stateMachine.activeTodoId} active)`, "info");
        }
      }

      // ── "Already done" — mark all complete, reset to idle, clear task.md ──
      const isAlreadyDone =
        selectedAnswer === "Already done — clear the plan" ||
        selectedAnswer.toLowerCase().includes("already done") ||
        selectedAnswer.toLowerCase().includes("clear the plan") ||
        selectedAnswer.toLowerCase().includes("all done");

      if (isAlreadyDone) {
        // Mark every todo as complete
        stateMachine.todos.forEach(t => { t.completed = true; });
        stateMachine.activeState = "idle";
        stateMachine.activeTodoId = null;

        // Overwrite task.md with a clean completed state
        if (taskFilePath) {
          isWritingTaskFile = true;
          try {
            const doneContent = `# Task Checklist: active plan progress\n\n` +
              `This checklist is managed by your pi-focus State Machine Orchestrator.\n\n` +
              `**Active State:** \`IDLE\`\n\n` +
              `*All tasks completed. Start a new session with \`/focus_plan\` when ready.*\n`;
            fs.writeFileSync(taskFilePath, doneContent, "utf-8");
          } catch {}
          finally { setTimeout(() => { isWritingTaskFile = false; }, 200); }
        }

        if (ctx.hasUI) {
          ctx.ui.notify("✦ pi-focus › Plan cleared — back to IDLE", "info");
        }
      }

      if (result.wasCustom) {
        return {
          content: [{ type: "text", text: `[USER CHOICE] Selected custom write-in: "${result.answer}"` }],
          details: { question, options, answer: result.answer, wasCustom: true }
        };
      }
      return {
        content: [{ type: "text", text: `[USER CHOICE] Selected Option #${result.index}: "${result.answer}"` }],
        details: { question, options, answer: result.answer, wasCustom: false, index: result.index }
      };
    }
  });

  // Tool: focus_mark_done
  pi.registerTool({
    name: "focus_mark_done",
    label: "Mark Todo Complete",
    description: "Use this tool to mark the currently active Todo step as complete. This structurally advances the state machine and updates task.md. DO NOT manually edit task.md to check off boxes — always use this tool.",
    parameters: {
      type: "object",
      properties: {},
      required: []
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (stateMachine.activeState !== "executing" || !stateMachine.activeTodoId) {
        return {
          content: [{ type: "text", text: "Error: No active Todo is currently executing." }],
          details: {}
        };
      }

      const activeId = stateMachine.activeTodoId;
      const todo = stateMachine.getActiveTodo();
      if (!todo) {
        return {
          content: [{ type: "text", text: `Error: Active Todo #${activeId} not found.` }],
          details: {}
        };
      }

      // Mark complete
      todo.completed = true;

      // Find next incomplete
      const nextIncomplete = stateMachine.todos.find(t => !t.completed);
      
      if (nextIncomplete) {
        stateMachine.activeTodoId = nextIncomplete.id;
        syncTaskMarkdown();
        if (ctx.hasUI) {
          ctx.ui.notify(`✦ pi-focus › Todo #${activeId} complete. Moving to Todo #${nextIncomplete.id}`, "info");
        }
        return {
          content: [{ type: "text", text: `Success: Todo #${activeId} marked complete. State machine advanced to Todo #${nextIncomplete.id}: "${nextIncomplete.title}".` }],
          details: { nextTodoId: nextIncomplete.id, nextTitle: nextIncomplete.title }
        };
      } else {
        stateMachine.activeTodoId = null;
        stateMachine.activeState = "idle";
        syncTaskMarkdown();
        if (ctx.hasUI) {
          ctx.ui.notify(`✦ pi-focus › All Todos completed! State reset to IDLE.`, "info");
        }
        return {
          content: [{ type: "text", text: `Success: Todo #${activeId} marked complete. All tasks are now finished. State machine reset to IDLE.` }],
          details: { nextTodoId: null, allComplete: true }
        };
      }
    }
  });

  // ─── 4. Live Workspace File Watcher (task.md) ──────────────────────────────
  
  // Helper: Initialize orchestrator workspace state and parent directory watcher
  function initializeOrchestrator(ctx: any) {
    // Close any prior filesystem watcher to avoid leakage on reloads
    if (taskWatcher) {
      try { taskWatcher.close(); } catch {}
      taskWatcher = null;
    }

    // Check if the directory is home or any hidden dot folder under home (e.g. ~/.config, ~/.npm, ~/.pi)
    if (isInsideHomeDotDir(ctx.cwd)) {
      taskFilePath = ""; // Do not allow path synchronization
      return;
    }

    // Dynamically resolve workspace folder using ctx.cwd at session start
    const focusDir = path.join(ctx.cwd, ".focus");
    if (!fs.existsSync(focusDir)) {
      fs.mkdirSync(focusDir, { recursive: true });
    }
    taskFilePath = path.join(focusDir, "task.md");

    // Load or generate task.md
    if (fs.existsSync(taskFilePath)) {
      try {
        const content = fs.readFileSync(taskFilePath, "utf-8");
        const loadedTodos = parseTaskMarkdownFully(content);
        if (loadedTodos.length > 0) {
          stateMachine.todos = loadedTodos;
          // Find first incomplete todo
          const incomplete = loadedTodos.find(t => !t.completed);
          if (incomplete) {
            // Boot into IDLE — user must explicitly /resume to continue.
            // Never auto-trigger execution on startup.
            stateMachine.activeState = "idle";
            stateMachine.activeTodoId = incomplete.id;

            if (ctx.hasUI) {
              ctx.ui.notify(
                `📋 Incomplete plan found (${loadedTodos.filter(t => !t.completed).length} step(s) remaining) — type /focus_resume to continue`,
                "info"
              );
            }
          } else {
            stateMachine.activeState = "idle";
            stateMachine.activeTodoId = null;
          }
        } else {
          // If task.md exists but has no todos, default to planning
          stateMachine.activeState = "planning";
          stateMachine.todos = [];
          stateMachine.activeTodoId = null;
        }
      } catch (err) {
        console.error("[PI-FOCUS] Failed to parse existing task.md:", err);
      }
    } else {
      // Generate initial task.md if not exists in the active workspace
      stateMachine.activeState = "planning";
      stateMachine.todos = [];
      stateMachine.activeTodoId = null;
      syncTaskMarkdown();
    }

    if (ctx.hasUI) {
      let version = "1.1.0";
      try {
        // Find package.json (works when running from source via setup.sh symlink)
        const pkgPath = path.join(__dirname, "../../package.json");
        if (fs.existsSync(pkgPath)) {
          version = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version || version;
        }
      } catch (e) {}
      
      // If idle, show a basic welcome message. If active, the other toasts (like "incomplete plan found") suffice.
      if (stateMachine.activeState === "idle" || stateMachine.activeState === "planning") {
        ctx.ui.notify(`✦ pi-focus v${version} loaded. Use /focus_plan to build features.`, "info");
      }
    }

    // Safely establish the watcher on the parent directory of task.md
    try {
      const parentDir = path.dirname(taskFilePath);
      const fileName = path.basename(taskFilePath);

      if (fs.existsSync(parentDir)) {
        taskWatcher = fs.watch(parentDir, (eventType, filename) => {
          // Robust check: match the exact filename and handle change events, avoiding ENOENT issues
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
                    newTodos.push({
                      ...match,
                      title: m.title,
                      allowedFiles: m.allowedFiles,
                      completed: m.completed
                    });
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
            } catch (err) {
              console.error("[PI-FOCUS Watcher] Error synchronizing task.md edits:", err);
            }
          }
        });
      }
    } catch (err) {
      console.warn("[PI-FOCUS Watcher] Could not establish task.md watch listener:", err);
    }
  }

  // ─── 4. Live Workspace File Watcher (task.md) ──────────────────────────────
  
  pi.on("session_start", async (_event, ctx) => {
    initializeOrchestrator(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    initializeOrchestrator(ctx);
  });

  // ─── 5. Inline Decision Capture Hook ───────────────────────────────────────
  

}
