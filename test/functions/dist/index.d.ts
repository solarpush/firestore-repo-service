export declare const server: import("firebase-functions/https").HttpsFunction;
export declare const admin: import("firebase-functions/https").HttpsFunction | (((req: any, res: any) => Promise<void>) & {
    httpsOptions?: import("firebase-functions/https").HttpsOptions;
});
export declare const crud: import("firebase-functions/https").HttpsFunction | (((req: any, res: any) => Promise<void>) & {
    spec: () => import("@lpdjs/firestore-repo-service/servers/crud").OpenAPIDocument;
    httpsOptions?: import("firebase-functions/https").HttpsOptions;
});
export declare const sync: {
    functions: Record<string, any>;
    adminHandler: ((req: any, res: any) => Promise<void>) | null;
    handleMessage: (event: import("@lpdjs/firestore-repo-service/sync/types").SyncEvent) => Promise<void>;
    queues: Map<string, import("@lpdjs/firestore-repo-service/sync/queue").SyncQueue>;
    shutdown: () => Promise<void>;
};
