import { useEffect } from "react";

import { applyConfigSyncPayload, downloadConfigSyncFromWebdav, uploadConfigSyncToWebdav, type ConfigSyncPayload } from "@/services/config-sync";
import { useConfigStore } from "@/stores/use-config-store";

const PUSH_DEBOUNCE_MS = 3000;
// 记录"本地最近一次成功同步（推/拉）的时间"。远端只有比它新才允许覆盖本地，避免自动拉取冲掉本地尚未推送的改动。
const SYNC_STATUS_KEY = "infinite-canvas:webdav_config_sync_status";
let skipNextPush = false;
let pushTimer: ReturnType<typeof setTimeout> | undefined;

function autoSyncEnabled() {
    const { webdav } = useConfigStore.getState();
    return Boolean(webdav.autoSync && webdav.url.trim());
}

function readSyncStatus(): number {
    try {
        const raw = localStorage.getItem(SYNC_STATUS_KEY);
        const parsed = raw ? Number(raw) : 0;
        return Number.isFinite(parsed) ? parsed : 0;
    } catch {
        return 0;
    }
}

function writeSyncStatus() {
    try {
        localStorage.setItem(SYNC_STATUS_KEY, String(Date.now()));
    } catch {
        /* 存储不可用时静默 */
    }
}

// 基于时间戳的 last-write-wins：远端比本地最近一次成功同步更新，才允许远端覆盖本地。
function isRemoteNewer(remote: ConfigSyncPayload | null, lastSynced: number): boolean {
    if (!remote) return false;
    const remoteAt = Date.parse(remote.exportedAt);
    return Number.isFinite(remoteAt) && remoteAt > lastSynced;
}

// 把远端 AI 配置拉进本地设置（applyConfigSyncPayload 走 setState，zustand persist 自动写回 localStorage）。
// 仅当远端比"本地最近一次同步时间"更新才覆盖：本地空、远端有渠道时必然拉取成功；本地刚改、远端更旧时不被冲掉。
// 返回 "pulled" | "none" | "skipped"。
export async function pullConfigSyncFromWebdav(): Promise<"pulled" | "none" | "skipped"> {
    const { webdav } = useConfigStore.getState();
    if (!webdav.url.trim()) return "none";
    const lastSynced = readSyncStatus();
    let remote: ConfigSyncPayload | null;
    try {
        remote = (await downloadConfigSyncFromWebdav(webdav)) as ConfigSyncPayload | null;
    } catch (error) {
        console.warn("[infinite-canvas] 拉取 AI 配置失败：", error);
        return "none";
    }
    if (!remote) return "none";
    if (!isRemoteNewer(remote, lastSynced)) return "skipped";
    if (applyConfigSyncPayload(remote)) {
        skipNextPush = true; // 应用远端后，跳过由本次 setState 触发的下一次自动推送，避免把刚拉来的数据立即回推覆盖。
        writeSyncStatus();
        return "pulled";
    }
    return "none";
}

// 本地 → 远端 推送（手动「同步 AI 配置」按钮先推后拉，这是推的那一半）。
export async function pushConfigSyncToWebdav(): Promise<void> {
    const { webdav } = useConfigStore.getState();
    if (!webdav.url.trim()) return;
    await uploadConfigSyncToWebdav(webdav);
    writeSyncStatus();
}

export function scheduleConfigSyncPush() {
    if (skipNextPush) {
        skipNextPush = false;
        return;
    }
    if (!autoSyncEnabled()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
        void (async () => {
            const { webdav } = useConfigStore.getState();
            if (!autoSyncEnabled()) return;
            try {
                await uploadConfigSyncToWebdav(webdav);
                writeSyncStatus();
            } catch (error) {
                console.warn("[infinite-canvas] 配置自动同步推送失败：", error);
            }
        })();
    }, PUSH_DEBOUNCE_MS);
}

export function useAutoConfigSync() {
    useEffect(() => {
        let cancelled = false;

        // 挂载时：只要配置了 WebDAV 地址就拉一次（不依赖 autoSync 开关，便于新浏览器/无痕进来直接带回渠道）。
        (async () => {
            const { webdav } = useConfigStore.getState();
            if (!webdav.url.trim()) return;
            const result = await pullConfigSyncFromWebdav();
            if (cancelled) return;
            void result; // 拉到即已写入 store，界面随 store 自动更新。
        })();

        // 该 store 未使用 subscribeWithSelector，默认 subscribe 只回调新 state，用 ref 自己比对上一帧。
        let prevState = useConfigStore.getState();
        const unsubscribe = useConfigStore.subscribe((state) => {
            if (state.webdav.autoSync !== prevState.webdav.autoSync) {
                // 用户刚打开自动同步开关：立即拉一次远端，把已同步渠道带进设置（挂载时 autoSync 还是 false，没拉到）。
                if (state.webdav.autoSync) void pullConfigSyncFromWebdav();
            }
            if (state.config !== prevState.config || state.webdav !== prevState.webdav) scheduleConfigSyncPush();
            prevState = state;
        });

        return () => {
            cancelled = true;
            unsubscribe();
            clearTimeout(pushTimer);
        };
    }, []);
}
