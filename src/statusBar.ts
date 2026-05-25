import os from "node:os";
import path from "node:path";
import { type Component, type TUI, visibleWidth } from "@mariozechner/pi-tui";
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@mariozechner/pi-coding-agent";

export interface StatusBarState {
    getActiveState: () => string;
    getOptimizerStatus: () => { enabled: boolean; category: string };
    getToolsCount: () => number;
    getActiveToolsCount: () => number;
    getSkillFilesCount: () => number;
}

// Keep track of the polling interval to clean up when the footer is disposed
let hardwarePollingInterval: NodeJS.Timeout | null = null;
let cpuUsage = "0%";
let memUsage = "0GB/0GB";

const renderCallbacks: Set<() => void> = new Set();

export function triggerFooterRender() {
    for (const cb of renderCallbacks) {
        cb();
    }
}

function updateHardwareStats() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memStr = (usedMem / 1024 / 1024 / 1024).toFixed(1);
    memUsage = `${memStr}G`;

    // Simple CPU load average (1 minute) scaled by core count
    const cpus = os.cpus().length;
    const load = os.loadavg()[0];
    const cpuPercent = Math.min(100, Math.round((load / cpus) * 100));
    cpuUsage = `${cpuPercent}%`;
}

function formatModelName(rawName: string): string {
    // Strip organization prefix (e.g., Jackrong/)
    let name = rawName.includes('/') ? rawName.split('/').pop() || rawName : rawName;
    
    // Strip common suffixes like -GGUF, :Q4_K_M, -Q4_K_M
    name = name.replace(/-gguf/i, '');
    name = name.replace(/[:\-]?Q[0-9].*/i, '');
    
    return name;
}

function formatPath(cwd: string): string {
    const home = os.homedir();
    if (cwd.startsWith(home)) {
        return "~" + cwd.substring(home.length);
    }
    return cwd;
}

export function createHeaderWidgetFactory(ctx: ExtensionContext, footerData: ReadonlyFooterDataProvider) {
    return (tui: TUI, theme: Theme) => {
        const component: Component = {
            render(width: number): string[] {
                const cwd = formatPath(ctx.cwd);
                const branch = footerData.getGitBranch();
                const gitStr = branch ? ` [\x1b[90m⎇ ${branch}\x1b[39m]` : "";
                const leftStr = ` \x1b[90m${cwd}${gitStr}\x1b[39m`;

                const hwStats = `\x1b[90mcpu: ${cpuUsage} mem: ${memUsage}\x1b[39m`;
                
                const statuses = footerData.getExtensionStatuses();
                const extraStatuses = [];
                for (const [key, val] of statuses.entries()) {
                    if (key !== "focus-mode" && key !== "focus-tools-optimizer") { 
                        extraStatuses.push(`${key}: ${val}`);
                    }
                }
                const extraStr = extraStatuses.length > 0 ? "   " + extraStatuses.join("   ") : "";
                const rightStr = `${hwStats}${extraStr} `;

                const leftLen = visibleWidth(leftStr);
                const rightLen = visibleWidth(rightStr);
                const spaces = Math.max(0, width - leftLen - rightLen);
                
                const line1 = leftStr + " ".repeat(spaces) + rightStr;
                
                // The TUI or editor layout seems to provide the separators automatically
                // when a widget is placed above or below the editor.
                return [line1];
            },
            invalidate() {}
        };
        return component;
    };
}

export function createStatusBarFactory(ctx: ExtensionContext, state: StatusBarState) {
    return (tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
        // Register/Update header widget whenever footer is recreated/rendered
        ctx.ui.setWidget("pi-focus-header", createHeaderWidgetFactory(ctx, footerData), { placement: "aboveEditor" });

        // Stop any old interval if recreating
        if (hardwarePollingInterval) {
            clearInterval(hardwarePollingInterval);
            hardwarePollingInterval = null;
        }

        // Always poll hardware stats
        updateHardwareStats();
        hardwarePollingInterval = setInterval(() => {
            updateHardwareStats();
            tui.requestRender();
        }, 2000);

        // Listen for git branch changes to redraw
        const unsubscribeBranch = footerData.onBranchChange(() => {
            tui.requestRender();
        });

        const renderCallback = () => tui.requestRender();
        renderCallbacks.add(renderCallback);

        // The custom component
        const component: Component & { dispose(): void } = {
            render(width: number): string[] {
                // Determine left side elements
                const activeState = state.getActiveState().toLowerCase();
                let dotColor = "\x1b[90m"; // Gray for idle
                if (activeState === "planning") { dotColor = "\x1b[38;5;206m"; } // Pinkish
                if (activeState === "executing") { dotColor = "\x1b[38;5;214m"; } // Orange/Yellow
                if (activeState === "reviewing") { dotColor = "\x1b[38;5;147m"; } // Light Purple
                
                // Match the sample: colored dot, white text
                const dot = `${dotColor}●\x1b[39m`; 
                const stateStr = `\x1b[37m${activeState}\x1b[39m`;
                const focusStr = ` ${dot} ${stateStr}`;

                const optState = state.getOptimizerStatus();
                let optStr = "";
                if (optState.enabled) {
                    optStr = ` \x1b[90m(opt: ${optState.category.toLowerCase()})\x1b[39m`;
                }
                
                const leftStr = `${focusStr}${optStr}`;

                // Determine right side elements
                const rightElements = [];
                
                // Add tools and skills count
                const activeTools = state.getActiveToolsCount();
                const totalTools = state.getToolsCount();
                const skillFiles = state.getSkillFilesCount();
                
                let countStr = `\x1b[90m${activeTools}/${totalTools} tools\x1b[39m`;
                if (skillFiles > 0) {
                    countStr += ` \x1b[90m· ${skillFiles} skills\x1b[39m`;
                }
                rightElements.push(countStr);

                if (ctx.model) {
                    const rawName = ctx.model.name || "Unknown Model";
                    rightElements.push(`\x1b[96m${formatModelName(rawName)}\x1b[39m`);
                } else {
                    rightElements.push(`\x1b[90mNo Model\x1b[39m`);
                }

                const rightStr = rightElements.join("   ") + " ";
                const helpStr = "\x1b[90m\x1b[96m/\x1b[39m\x1b[90m commands · \x1b[96m?\x1b[39m\x1b[90m help\x1b[39m";

                const leftLen = visibleWidth(leftStr);
                const rightLen = visibleWidth(rightStr);
                const helpLen = visibleWidth(helpStr);
                
                let contentLine = "";
                const totalTextLen = leftLen + rightLen + helpLen;

                if (width >= totalTextLen + 10) {
                    // Enough space to center the help text
                    const availableSpace = width - leftLen - rightLen;
                    const helpPos = Math.floor(width / 2 - helpLen / 2);
                    const spaceBeforeHelp = Math.max(1, helpPos - leftLen);
                    const spaceAfterHelp = Math.max(1, width - leftLen - spaceBeforeHelp - helpLen - rightLen);
                    
                    contentLine = leftStr + " ".repeat(spaceBeforeHelp) + helpStr + " ".repeat(spaceAfterHelp) + rightStr;
                } else {
                    // Not enough space for help text, just show left and right
                    const spaces = Math.max(0, width - leftLen - rightLen);
                    contentLine = leftStr + " ".repeat(spaces) + rightStr;
                }

                // TUI adds the separator above the footer automatically
                return [contentLine];
            },

            invalidate() {
                // No cached state to clear
            },

            dispose() {
                ctx.ui.setWidget("pi-focus-header", undefined);
                unsubscribeBranch();
                renderCallbacks.delete(renderCallback);
                if (hardwarePollingInterval) {
                    clearInterval(hardwarePollingInterval);
                    hardwarePollingInterval = null;
                }
            }
        };

        return component;
    };
}
