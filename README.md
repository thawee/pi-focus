# ⚡ pi-focus

Dynamic Tool Routing and Zero-Spawn Hot-Context State-Machine Orchestrator for [Pi Agent](https://pi.dev).

`pi-focus` is a lightweight, high-performance TypeScript extension package designed to keep your AI workflows blazing fast, strictly focused, and securely bounded. By consolidating dynamic tool routing, path-level whitelisting, live `task.md` synchronization, and event-driven system prompt hot-swapping into **one single continuous terminal process**, it eliminates context bloat and ensures your agent never loses the plot.

### 💰 The P.A.I.D. Workflow
If you want to ship features fast without your AI going rogue, you have to get **P.A.I.D.**
*   **P - Plan:** Type `/focus_plan` (or let the AI trigger it automatically for complex goals) to analyze the codebase and draft a step-by-step `task.md`.
*   **A - Approve:** The state machine pauses and asks for your explicit approval via an interactive TUI.
*   **I - Implement:** The agent **automatically** executes the code step-by-step (only use `/focus_resume` if you closed your terminal and need to pick up where you left off).
*   **D - Done:** The agent structurally marks the task complete and safely auto-advances the state machine.

---

## 🚀 Key Benefits

1.  **⚡ Zero-Spawn Role Swapping:** Planning, scouting, executing, and reviewing happen **in-memory within the same process**. Transitions take **0 milliseconds**. Prompt caching remains 100% hot, reducing TTFT response times down to under **200ms**.
2.  **📋 Bi-Directional `task.md` Sync:** Automatically synchronizes planning steps into a live `task.md` file in your workspace root. Manually checking off boxes (`- [x]`) in your editor is watched in real-time, programmatically updating agent states in-memory.
3.  **🛡️ Gated Drift Blocking:** Hooks into tool executions. The **Planning Gate** structurally blocks the LLM from writing files before a plan is approved. The **Execution Gate** blocks the worker if it attempts to edit an unauthorized path, prompting you: *"Approve file whitelisting? (y/n)"*. If blocked, it offers a quick re-planning pivot.
4.  **📊 Smart Router (Token Pruning):** Prunes active tool schemas inside prompt context based on task intent, loading **zero tools** for pure explanations to save up to 80% context window tokens.
5.  **⏸️ Safe Suspend & Resume:** On startup, if an incomplete `task.md` is found, the system boots safely into an `idle` state with a subtle notification. It never auto-resumes or steals focus. You explicitly type `/focus_resume` to review the remaining plan and approve execution.

---

## 🧠 Core Philosophy

`pi-focus` shifts the burden of orchestration away from the LLM's brain, and puts it into rock-solid TypeScript code. It was built to solve the four biggest problems with autonomous agents:

*   **The "Single Brain" Approach (Zero Context Loss):** Traditional orchestrators spawn entirely new sub-agents for different tasks (e.g., Planner passes to Coder). The Coder loses all the context of *why* the plan was made. `pi-focus` keeps everything in **one single thread**. It hot-swaps the system instructions dynamically. Because the LLM retains 100% of the conversational memory, it never loses the plot.
*   **Structural Enforcement > Prompt Begging:** Most agents rely on begging the LLM in the system prompt: *"Please don't edit files until the plan is approved"*. LLMs ignore this. `pi-focus` uses hardcoded security gates. It physically removes the LLM's ability to edit files until the State Machine unlocks the `EXECUTING` state.
*   **The Token Economy:** Injecting 30 complex tool schemas into every chat message costs thousands of tokens per turn and causes tool hallucination. The `smart-router` acts as a token firewall, dropping irrelevant tools based on your intent, drastically reducing context bloat.
*   **The Human-in-the-Loop Handshake:** Agents often go rogue, executing 20 steps in the wrong direction. By forcing a structural pause (the `focus_decision` TUI) between the Planning and Executing states, `pi-focus` ensures the agent never takes an action without your explicit blessing.

---

## 📦 Getting Started

### 1. Project Structure

```
pi-focus/
├── README.md           # Documentation
├── package.json        # Dependencies & package metadata
├── setup.sh            # Setup, compilation, and symlink manager
└── extensions/
    ├── smart-router/   # Intent classifier & tool schema pruner
    └── focus-mode/     # Zero-spawn Stateful Orchestrator
```

### 2. Installation & Configuration

You can install `pi-focus` directly from GitHub using the Pi Agent CLI:

```bash
pi install git:github.com/thawee/pi-focus
```

This will automatically download the repository and register both the `smart-router` and `focus-mode` extensions to your global `~/.pi/agent/settings.json`.

💡 **Important Conflict Notice:** Any active workflow or orchestration extensions may conflict with the `focus-mode` state-machine. It is highly recommended to open your `settings.json` and remove any other global orchestrators (for example, remove `"git:github.com/HazAT/pi-solo"`) from your active packages list.

Restart your `pi` CLI to load the optimized in-process State Machine!

---

## 📖 User Guide

### 🎛️ Available Commands

Run these slash commands directly inside your terminal session to drive the state machine:

*   **`/focus_plan`:** Instantly swaps system instructions to Planning Mode. The embedded planner analyzes the codebase, clarifies scope via `focus_decision`, drafts `task.md`, and presents the plan for approval before any code is written.
*   **`/focus_resume`:** Evaluates an existing `task.md` file on startup. If incomplete steps remain, it presents the plan via `focus_decision` allowing you to resume execution, modify steps, or clear the plan entirely.
*   **`/focus_review`:** Swaps system instructions to Reviewer Mode. The embedded reviewer produces a structured PASS/WARN/FAIL report and uses `focus_decision` to resolve any failures.
*   **`/smart_router`:** Toggles the dynamic smart-router pruning feature ON or OFF. Useful if you temporarily want all tools available in idle mode.

### 🔄 The Standard Workflow

When you ask the planner to build a feature, the orchestrator structurally enforces a safe, step-by-step loop:

1. **Scouting:** You type `/focus_plan`. The LLM reads files (e.g. `ls`, `read_file`) to understand the codebase.
2. **Drafting:** The LLM writes the plan to a local `task.md` file.
3. **The Planning Gate Handshake:** The LLM stops and presents you with a choice in the terminal. You select "Approve and start execution".
4. **Execution:** The state flips to `EXECUTING`. The worker writes implementation code for Todo #1 (it is only allowed to edit whitelisted files).
5. **Auto-Progression:** The worker marks the step complete. The Orchestrator structurally writes `[x]` to `task.md` and auto-advances to Todo #2.
6. **Resume:** If you quit your terminal midway, the system boots into `IDLE`. You type `/focus_resume` to approve continuing the remaining steps.

---

## ⚙️ Technical Architecture (Under the Hood)

### \ud83e\udd16 Agent Roles (Self-Contained)

All agent personas are **embedded directly inside `focus-mode/index.ts`** — no external files, no external dependencies. The orchestrator hot-swaps the system instructions dynamically based on the current state.

| Agent | Behavior |
|---|---|
| **planner** | **Analyst first.** Reads the codebase before drafting. Never guesses; uses `focus_decision` for unclear requirements. Cannot write implementation code (gatekeeper). |
| **worker** | Implements one Todo step surgically. Marks `[x]` when done using a specialized tool. |
| **reviewer** | Audits the code and provides a PASS / WARN / FAIL report per category. |

### 🛠️ Orchestrator Tools

The state machine exposes special tools to the LLM to structurally enforce workflow constraints:

*   **`focus_decision` (Interactive Handshake):** Used by all agent roles to stop execution, present choices to the user via a beautiful TUI, and wait for structural approval before proceeding. Prevents the LLM from hallucinating conversational questions.
*   **`focus_mark_done`:** Workers are strictly forbidden from manually editing `task.md` with file-write tools. Instead, they must call this tool when a step is finished. It structurally updates the in-memory state machine, auto-advances to the next step, and physically rewrites `task.md` in one safe, guaranteed transaction.

### 🪓 Dynamic Smart Router (Token Pruning)

The `smart-router` acts as an intent classifier and token-saving firewall. It intercepts chat messages and aggressively hides tools the AI doesn't need for that specific request, drastically shrinking the context window footprint.

**Intent Buckets:** When a message is received in `IDLE` mode, it is scored against regex signals:
*   📝 **`write`:** Triggered by words like *"fix, change, bug"*. Loads modifying tools (`edit_file`, `bash`).
*   👀 **`read`:** Triggered by words like *"read, show, inspect"*. Removes modifying tools, allows `read_file`.
*   🔍 **`search`:** Triggered by words like *"find, grep"*. Allows read/search tools.
*   💬 **`respond`:** Triggered by short messages or words like *"explain, compare"*. Loads **ZERO tools**, saving thousands of tokens.

**Focus-Mode Integration:** If `focus-mode` is actively working on a task (state is `planning`, `executing`, or `reviewing`), the `smart-router` automatically backs off and enables **ALL** tools. It only actively prunes tools when the system is sitting in the `IDLE` state.
