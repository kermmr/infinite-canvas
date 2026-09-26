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

// 基于时间戳的 last-write-wins：远端比本地最近一次成功同步更新，才应用远端。
function shouldApplyRemote(remote: ConfigSyncPayload | null, lastSynced: number): boolean {
    if (!remote) return false;
    const remoteAt = Date.parse(remote.exportedAt);
    return Number.isFinite(remoteAt) && remoteAt > lastSynced;
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
        const lastSynced = readSyncStatus();

        (async () => {
            if (!autoSyncEnabled()) return;
            const { webdav } = useConfigStore.getState();
            try {
                const remote = (await downloadConfigSyncFromWebdav(webdav)) as ConfigSyncPayload | null;
                if (cancelled) return;
                if (shouldApplyRemote(remote, lastSynced)) {
                    if (applyConfigSyncPayload(remote)) {
                        skipNextPush = true;
                        writeSyncStatus();
                    }
                }
            } catch (error) {
                if (!cancelled) console.warn("[infinite-canvas] 配置自动同步拉取失败：", error);
            }
        })();

        // 该 store 未使用 subscribeWithSelector，默认 subscribe 只回调新 state，用 ref 自己比对上一帧。
        let prevState = useConfigStore.getState();
        const unsubscribe = useConfigStore.subscribe((state) => {
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
