import os from "node:os";
import path from "node:path";
import { type Component, type TUI, visibleWidth } from "@mariozechner/pi-tui";
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@mariozechner/pi-coding-agent";

export interface StatusBarState {
    getActiveState: () => string;
    getOptimizerStatus: () => { enabled: boolean; category: string };
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

export function createStatusBarFactory(ctx: ExtensionContext, state: StatusBarState) {
    return (tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
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
                let stateIcon = "⏸";
                let stateColor = "\x1b[90m"; // Gray for idle
                if (activeState === "planning") { stateIcon = "🎯"; stateColor = "\x1b[94m"; } // Light Blue
                if (activeState === "executing") { stateIcon = "⚡"; stateColor = "\x1b[93m"; } // Light Yellow
                if (activeState === "reviewing") { stateIcon = "🔍"; stateColor = "\x1b[95m"; } // Light Magenta
                
                const focusStr = `${stateIcon} ${stateColor}${activeState}\x1b[39m`;

                const optState = state.getOptimizerStatus();
                let optIcon = "⭕";
                let optColor = "\x1b[90m"; // Gray for off
                if (optState.enabled) {
                    const cat = optState.category.toLowerCase();
                    if (cat === "read") { optIcon = "👀"; optColor = "\x1b[96m"; } // Cyan
                    else if (cat === "write") { optIcon = "✏️"; optColor = "\x1b[92m"; } // Green
                    else if (cat === "search") { optIcon = "🔍"; optColor = "\x1b[94m"; } // Blue
                    else if (cat === "respond") { optIcon = "💬"; optColor = "\x1b[95m"; } // Magenta
                    else { optIcon = "⚡"; optColor = "\x1b[93m"; } // Yellow
                }
                const optimizerStr = optState.enabled 
                    ? `${optIcon} opt: ${optColor}${optState.category.toLowerCase()}\x1b[39m` 
                    : `\x1b[90m${optIcon} opt: off\x1b[39m`;
                
                // Add project and git info
                const projectName = path.basename(ctx.cwd);
                const branch = footerData.getGitBranch();
                // Light Blue for project, Light Magenta for git branch
                const coloredProject = `\x1b[94m📁 ${projectName}\x1b[39m`;
                const projectStr = branch 
                    ? `${coloredProject} on \x1b[95m ${branch}\x1b[39m` 
                    : coloredProject;
                
                const leftElements = [projectStr, focusStr, optimizerStr];
                
                // Add any extra extension statuses set via ctx.ui.setStatus
                const statuses = footerData.getExtensionStatuses();
                for (const [key, val] of statuses.entries()) {
                    if (key !== "focus-mode" && key !== "focus-tools-optimizer") { 
                        leftElements.push(`${key}: ${val}`);
                    }
                }

                // Use the original vertical bar separator
                const leftStr = "  " + leftElements.join("   |   ");

                // Determine right side elements
                const rightElements = [];
                
                // Add colored hardware stats (Yellow for CPU, Green for Mem)
                const cpuColored = `\x1b[93mcpu: ${cpuUsage}\x1b[39m`;
                const memColored = `\x1b[92mmem: ${memUsage}\x1b[39m`;
                rightElements.push(`${cpuColored}   ${memColored}`);
                
                if (ctx.model) {
                    const rawName = ctx.model.name || "Unknown Model";
                    // Add cyan color (\x1b[96m) to the model name and a robot icon
                    rightElements.push(`\x1b[96m🤖 ${formatModelName(rawName)}\x1b[39m`);
                } else {
                    rightElements.push(`\x1b[90m🤖 No Model\x1b[39m`);
                }

                const rightStr = rightElements.join("   |   ") + "  ";

                // Styling
                // You can wrap these in Chalk/Theme colors if you import them, 
                // but raw strings work well if styling isn't heavily imported.
                // We'll use ANSI escape codes based on the theme or just minimal styling
                const bg = "\x1b[48;5;236m"; // Dark gray background
                const fg = "\x1b[38;5;253m"; // Light gray foreground
                const reset = "\x1b[0m";
                
                const leftLen = visibleWidth(leftStr);
                const rightLen = visibleWidth(rightStr);
                
                // Construct the padded line
                let line = "";
                if (leftLen + rightLen > width) {
                    // Not enough space, just truncate left side
                    const avail = Math.max(0, width - rightLen - 1);
                    line = leftStr.substring(0, avail) + " " + rightStr;
                } else {
                    const spaces = width - leftLen - rightLen;
                    line = leftStr + " ".repeat(spaces) + rightStr;
                }

                // Wrap the entire line in a dark gray background (ANSI 236)
                // \x1b[49m resets the background color and \x1b[39m resets foreground
                const finalString = `\x1b[48;5;236m\x1b[38;5;253m${line}\x1b[39m\x1b[49m`;

                return [finalString];
            },

            invalidate() {
                // No cached state to clear
            },

            dispose() {
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
