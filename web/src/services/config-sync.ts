import { usePromptSourceStore, type PromptSourceSchedule } from "@/stores/use-prompt-source-store";
import type { PromptSource } from "@/services/api/prompt-source-presets";
import { useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { downloadWebdavFile, uploadWebdavFile } from "@/services/webdav-sync";

export const CONFIG_SYNC_FILE_NAME = "config.json";

export type ConfigSyncPayload = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig;
    webdav: WebdavSyncConfig;
    promptSources: {
        sources: PromptSource[];
        schedule: PromptSourceSchedule;
    };
};

export function buildConfigSyncPayload(): ConfigSyncPayload {
    const { config, webdav } = useConfigStore.getState();
    const { sources, schedule } = usePromptSourceStore.getState();
    return {
        app: "infinite-canvas",
        version: 1,
        exportedAt: new Date().toISOString(),
        config,
        webdav,
        promptSources: { sources, schedule },
    };
}

export function applyConfigSyncPayload(payload: unknown): boolean {
    if (!payload || typeof payload !== "object") return false;
    const data = payload as Partial<ConfigSyncPayload>;
    if (data.app !== "infinite-canvas" || data.version !== 1 || !data.config || !data.webdav || !data.promptSources) return false;
    useConfigStore.setState({ config: data.config, webdav: data.webdav });
    usePromptSourceStore.setState(data.promptSources);
    return true;
}

function parseConfigSyncPayload(blob: Blob) {
    return blob.text().then((text) => JSON.parse(text) as unknown);
}

export type ConfigSyncProgress = (stage: string) => void;

export async function downloadConfigSyncFromWebdav(config: WebdavSyncConfig, onProgress?: ConfigSyncProgress): Promise<unknown | null> {
    onProgress?.("读取远端配置");
    const blob = await downloadWebdavFile(config, CONFIG_SYNC_FILE_NAME);
    if (!blob) return null;
    return parseConfigSyncPayload(blob);
}

export async function uploadConfigSyncToWebdav(config: WebdavSyncConfig, onProgress?: ConfigSyncProgress): Promise<void> {
    onProgress?.("写入本地配置");
    const blob = new Blob([JSON.stringify(buildConfigSyncPayload())], { type: "application/json" });
    onProgress?.(`上传配置 ${formatBlobBytes(blob.size)}`);
    await uploadWebdavFile(config, CONFIG_SYNC_FILE_NAME, blob, "application/json");
}

function formatBlobBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}
